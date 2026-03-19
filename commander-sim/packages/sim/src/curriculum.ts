/**
 * Phase 6 — Curriculum Scheduler
 *
 * Analyzes agent weaknesses from DB data and builds targeted training scenarios
 * to improve performance in the areas where the agent struggles most.
 */
import { PrismaClient } from "@prisma/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrisma = any;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WeaknessReport {
  weaknesses: Weakness[];
  totalEpisodes: number;
}

export interface Weakness {
  area: string;
  winRate: number;
  episodes: number;
}

export interface TrainingScenario {
  deckMatchup: { archetypes: string[] };
  startingConditions?: {
    fixedHands?: string[][];
    startTurn?: number;
  };
  focusPhase?: "early" | "mid" | "late" | "combat";
  epsilonOverrides?: number[];
}

export interface CurriculumStatus {
  weaknesses: Weakness[];
  nextScenario: TrainingScenario | null;
  epsilonRanges: { min: number; max: number; current: number };
  totalEpisodes: number;
  matchupCoverage: { trained: number; total: number };
}

interface EpsilonState {
  totalEpisodes: number;
  phaseEpsilons: Record<string, number>;
}

const EPSILON_MIN = 0.05;
const EPSILON_MAX = 0.30;
const EPSILON_DECAY = 0.0001; // per episode
const WEAK_WINRATE_THRESHOLD = 0.45;

// ── CurriculumScheduler ────────────────────────────────────────────────────────

export class CurriculumScheduler {
  private readonly prisma: AnyPrisma;
  private epsilonState: EpsilonState = {
    totalEpisodes: 0,
    phaseEpsilons: {},
  };
  private recentMatchups: string[] = [];
  private readonly maxConsecutiveRepeats = 3;

  constructor(dbUrl?: string) {
    if (dbUrl) {
      this.prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } }) as AnyPrisma;
    } else {
      this.prisma = new PrismaClient() as AnyPrisma;
    }
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  // ── C2: Weakness Analysis ──────────────────────────────────────────────────

  /**
   * Queries recent episodes from DB and computes win-rates per game phase and archetype matchup.
   * Returns the N weakest areas.
   */
  async analyzeWeaknesses(): Promise<WeaknessReport> {
    const weaknesses: Weakness[] = [];

    try {
      // Get recent episodes
      const recentEpisodes = await this.prisma.episode.findMany({
        orderBy: { createdAt: "desc" },
        take: 500,
        include: {
          steps: {
            select: {
              playerIndex: true,
              step: true,
              winnerIndex: true,
            },
          },
          run: {
            select: {
              archetypes: true,
            },
          },
        },
      });

      if (recentEpisodes.length === 0) {
        return { weaknesses: [], totalEpisodes: 0 };
      }

      const totalEpisodes = recentEpisodes.length;

      // Analyze by game phase (early = turns 1-4, mid = 5-8, late = 9+)
      const phaseStats: Record<string, { wins: number; total: number }> = {
        early: { wins: 0, total: 0 },
        mid: { wins: 0, total: 0 },
        late: { wins: 0, total: 0 },
      };

      for (const episode of recentEpisodes) {
        if (episode.winnerIndex === null) continue;
        const steps = episode.steps;
        if (!steps.length) continue;

        // Determine approximate turn count from step count
        const totalSteps = steps.length;
        const approxTurns = Math.ceil(totalSteps / 8); // rough estimate: ~8 actions per turn

        const phase =
          approxTurns <= 4 ? "early" : approxTurns <= 8 ? "mid" : "late";
        phaseStats[phase].total += 1;

        // Assume agent is player 0
        if (episode.winnerIndex === 0) {
          phaseStats[phase].wins += 1;
        }
      }

      for (const [phase, stats] of Object.entries(phaseStats)) {
        if (stats.total < 5) continue;
        const winRate = stats.wins / stats.total;
        weaknesses.push({ area: `${phase}_game`, winRate, episodes: stats.total });
      }

      // Analyze by archetype matchup
      const matchupStats = await this.prisma.matchupStats.findMany({
        orderBy: { total: "desc" },
        take: 50,
      });

      for (const row of matchupStats) {
        if (row.total < 5) continue;
        const winRate1 = row.total > 0 ? row.wins1 / row.total : 0.5;
        if (winRate1 < WEAK_WINRATE_THRESHOLD) {
          weaknesses.push({
            area: `matchup_${row.archetype1}_vs_${row.archetype2}`,
            winRate: winRate1,
            episodes: row.total,
          });
        }
      }

      // Sort by win rate ascending (worst first)
      weaknesses.sort((a, b) => a.winRate - b.winRate);

      return { weaknesses, totalEpisodes };
    } catch {
      // DB unavailable — return empty
      return { weaknesses: [], totalEpisodes: 0 };
    }
  }

  // ── C3: Scenario Construction ──────────────────────────────────────────────

  /**
   * Builds a targeted TrainingScenario from a weakness area.
   */
  buildTrainingScenario(weakness: Weakness): TrainingScenario {
    const area = weakness.area;

    // Phase-based weaknesses
    if (area.startsWith("early_game")) {
      return {
        deckMatchup: { archetypes: ["AGGRO", "AGGRO"] },
        startingConditions: { startTurn: 1 },
        focusPhase: "early",
        epsilonOverrides: [0.25, 0.25, 0.25, 0.25],
      };
    }

    if (area.startsWith("mid_game")) {
      return {
        deckMatchup: { archetypes: ["MIDRANGE", "MIDRANGE"] },
        startingConditions: { startTurn: 5 },
        focusPhase: "mid",
        epsilonOverrides: [0.20, 0.20, 0.20, 0.20],
      };
    }

    if (area.startsWith("late_game")) {
      return {
        deckMatchup: { archetypes: ["CONTROL", "CONTROL"] },
        startingConditions: { startTurn: 9 },
        focusPhase: "late",
        epsilonOverrides: [0.15, 0.15, 0.15, 0.15],
      };
    }

    // Archetype matchup weaknesses: area = "matchup_X_vs_Y"
    const matchupMatch = area.match(/^matchup_(.+)_vs_(.+)$/);
    if (matchupMatch) {
      const [, arch1, arch2] = matchupMatch;
      return {
        deckMatchup: {
          archetypes: [arch1, arch2, arch1, arch2],
        },
        focusPhase: undefined,
        epsilonOverrides: [0.20, 0.20, 0.20, 0.20],
      };
    }

    // Default scenario
    return {
      deckMatchup: { archetypes: [] },
      focusPhase: undefined,
    };
  }

  // ── C4: Dynamic Epsilon ────────────────────────────────────────────────────

  /**
   * Computes epsilon for a given player and phase.
   * Higher epsilon in weak phases, lower in strong ones.
   * Global decay as training progresses.
   */
  computeEpsilon(_playerIndex: number, phase: string): number {
    const globalDecay = Math.max(
      0,
      1 - this.epsilonState.totalEpisodes * EPSILON_DECAY
    );
    const base = EPSILON_MIN + (EPSILON_MAX - EPSILON_MIN) * globalDecay;

    // Boost epsilon for known weak phases
    const phaseEps = this.epsilonState.phaseEpsilons[phase];
    if (phaseEps !== undefined) {
      return Math.min(EPSILON_MAX, phaseEps);
    }

    return Math.max(EPSILON_MIN, Math.min(EPSILON_MAX, base));
  }

  /**
   * Updates per-phase epsilon after analyzing weaknesses.
   */
  updatePhaseEpsilons(weaknesses: Weakness[]): void {
    this.epsilonState.phaseEpsilons = {};
    for (const w of weaknesses) {
      // Weak phase → higher epsilon (more exploration)
      const epsilon = EPSILON_MIN + (EPSILON_MAX - EPSILON_MIN) * (1 - w.winRate);
      this.epsilonState.phaseEpsilons[w.area] = Math.min(EPSILON_MAX, epsilon);
    }
  }

  incrementEpisodeCount(count = 1): void {
    this.epsilonState.totalEpisodes += count;
  }

  // ── C5: Matchup Rotation ───────────────────────────────────────────────────

  /**
   * Selects the next matchup to train.
   * Priority: 70% weakest matchup + 30% random.
   * Avoids repeating the same matchup more than maxConsecutiveRepeats times.
   */
  async selectNextMatchup(availableArchetypes: string[]): Promise<string[]> {
    if (availableArchetypes.length < 2) {
      return availableArchetypes;
    }

    try {
      const matchupRows = await this.prisma.matchupStats.findMany();
      const trainedSet = new Map<string, number>();
      for (const row of matchupRows) {
        const key = `${row.archetype1}|${row.archetype2}`;
        trainedSet.set(key, row.total);
      }

      // Build all possible pairs
      const pairs: Array<{ archetypes: string[]; episodes: number }> = [];
      for (let i = 0; i < availableArchetypes.length; i++) {
        for (let j = 0; j < availableArchetypes.length; j++) {
          if (i === j) continue;
          const key = `${availableArchetypes[i]}|${availableArchetypes[j]}`;
          const episodes = trainedSet.get(key) ?? 0;
          pairs.push({ archetypes: [availableArchetypes[i], availableArchetypes[j]], episodes });
        }
      }

      // Sort by episodes ascending (least trained first)
      pairs.sort((a, b) => a.episodes - b.episodes);

      // Filter out recent repeats
      const filteredPairs = pairs.filter(
        (p) => !this.isRepeatedMatchup(p.archetypes)
      );
      const candidates = filteredPairs.length > 0 ? filteredPairs : pairs;

      // 70% weakest, 30% random
      const useWeak = Math.random() < 0.7;
      let selected: string[];

      if (useWeak) {
        selected = candidates[0]?.archetypes ?? availableArchetypes.slice(0, 2);
      } else {
        const idx = Math.floor(Math.random() * candidates.length);
        selected = candidates[idx]?.archetypes ?? availableArchetypes.slice(0, 2);
      }

      this.recordMatchup(selected);
      return selected;
    } catch {
      // DB unavailable
      const idx = Math.floor(Math.random() * availableArchetypes.length);
      return [availableArchetypes[idx], availableArchetypes[(idx + 1) % availableArchetypes.length]];
    }
  }

  private isRepeatedMatchup(archetypes: string[]): boolean {
    const key = archetypes.join("|");
    let consecutiveCount = 0;
    for (let i = this.recentMatchups.length - 1; i >= 0; i--) {
      if (this.recentMatchups[i] === key) {
        consecutiveCount++;
        if (consecutiveCount >= this.maxConsecutiveRepeats) return true;
      } else {
        break;
      }
    }
    return false;
  }

  private recordMatchup(archetypes: string[]): void {
    this.recentMatchups.push(archetypes.join("|"));
    if (this.recentMatchups.length > 20) {
      this.recentMatchups.shift();
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getStatus(): Promise<CurriculumStatus> {
    const report = await this.analyzeWeaknesses();
    const topWeakness = report.weaknesses[0];
    const nextScenario = topWeakness ? this.buildTrainingScenario(topWeakness) : null;

    const globalDecay = Math.max(
      0,
      1 - this.epsilonState.totalEpisodes * EPSILON_DECAY
    );
    const currentEpsilon = EPSILON_MIN + (EPSILON_MAX - EPSILON_MIN) * globalDecay;

    let trainedMatchups = 0;
    let totalMatchups = 0;
    try {
      const matchupRows = await this.prisma.matchupStats.findMany();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trainedMatchups = matchupRows.filter((r: any) => r.total > 0).length;
      totalMatchups = matchupRows.length;
    } catch {
      // ignore
    }

    return {
      weaknesses: report.weaknesses.slice(0, 10),
      nextScenario,
      epsilonRanges: {
        min: EPSILON_MIN,
        max: EPSILON_MAX,
        current: parseFloat(currentEpsilon.toFixed(4)),
      },
      totalEpisodes: report.totalEpisodes,
      matchupCoverage: { trained: trainedMatchups, total: totalMatchups },
    };
  }
}
