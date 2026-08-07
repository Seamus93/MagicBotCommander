import { Prisma, PrismaClient } from "@prisma/client";
import { PatternStore } from "../../sim/src/patterns.js";
import type { DeckCardMetadata, SimulationResult } from "@game-state/types";
import { buildStateDigest } from "@game-state/stateDigest";

const prisma = new PrismaClient();

export const getPrisma = () => prisma;

const toJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const toNullableJson = (
  value: unknown | null | undefined
): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === null || value === undefined ? Prisma.JsonNull : toJson(value);

type EpisodeStepStorageMode = "off" | "digest" | "full";

export interface EpisodeReplayDecision {
  storeEpisode: boolean;
  storeSteps: boolean;
  storageMode: EpisodeStepStorageMode;
  reason: "sample" | "anomaly" | "disabled";
}

export interface PolicyFlushStats {
  recordsUpdated: number;
  approximatePolicyBytes: number;
  retryCount: number;
  failedAttempts: number;
}

export class PolicyFlushError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
    public readonly attempts: number,
    public readonly dirtyRecordCount: number
  ) {
    super(message);
    this.name = "PolicyFlushError";
  }
}

export function getEpisodeStepStorageMode(): EpisodeStepStorageMode {
  const raw = (process.env.EPISODE_STEP_STORAGE ?? "off").toLowerCase();
  if (raw === "off" || raw === "none" || raw === "false") return "off";
  if (raw === "full") return "full";
  return "digest";
}

export function getEpisodeSampleRate(): number {
  const parsed = Number(process.env.EPISODE_SAMPLE_RATE ?? 0.01);
  if (!Number.isFinite(parsed)) return 0.01;
  return Math.max(0, Math.min(1, parsed));
}

export function shouldSaveAnomalousEpisodes(): boolean {
  return process.env.SAVE_ANOMALOUS_EPISODES !== "false";
}

export function isAnomalousEpisode(result: SimulationResult): boolean {
  if ((result.metrics?.missedLandDropOpportunity ?? 0) > 0) return true;
  if (result.turns >= Number(process.env.MAX_TURNS_ANOMALY_THRESHOLD ?? 40)) return true;
  const passCount = result.history.filter((entry) => entry.action.type === "PASS_TURN").length;
  if (passCount >= Number(process.env.PASS_LOOP_ANOMALY_THRESHOLD ?? 30)) return true;
  return result.history.some((entry) => {
    if ((entry.metadata?.confidence ?? 0) >= 0.8 && (entry.shapedReward ?? 0) < -0.25) return true;
    if ((entry.metadata?.expectedReward ?? 0) >= 0.5 && (entry.shapedReward ?? 0) < -0.25) return true;
    if (entry.metadata?.source === "heuristic" && (entry.metadata.visits ?? 0) >= 100) return true;
    if ((entry.metadata?.confidence ?? 1) < 0.05 && entry.metadata?.source !== "heuristic") return true;
    if (
      entry.state.phaseStep === "Seconda Fase Principale" &&
      entry.action.type === "PASS_TURN" &&
      entry.availableActions.some((action) => action.type === "PLAY_LAND")
    ) {
      return true;
    }
    return false;
  });
}

export function shouldPersistEpisodeReplay(
  result: SimulationResult,
  _episodeIndex: number,
  random = Math.random
): EpisodeReplayDecision {
  const storageMode = getEpisodeStepStorageMode();
  const anomalous = shouldSaveAnomalousEpisodes() && isAnomalousEpisode(result);
  if (anomalous) {
    return {
      storeEpisode: true,
      storeSteps: storageMode !== "off",
      storageMode,
      reason: "anomaly",
    };
  }

  const sampleRate = getEpisodeSampleRate();
  const sampled = sampleRate >= 1 || (sampleRate > 0 && random() < sampleRate);
  if (sampled) {
    return {
      storeEpisode: true,
      storeSteps: storageMode !== "off",
      storageMode,
      reason: "sample",
    };
  }

  return {
    storeEpisode: false,
    storeSteps: false,
    storageMode,
    reason: "disabled",
  };
}

export async function createSimulationRun(params: {
  episodes: number;
  players: number;
  maxTurns?: number;
  policyPath?: string;
  archetypes?: string[];
  deckIds?: number[];
}) {
  return prisma.simulationRun.create({
    data: {
      episodes: params.episodes,
      players: params.players,
      maxTurns: params.maxTurns ?? null,
      policyPath: params.policyPath ?? null,
      archetypes: toNullableJson(params.archetypes),
      deckIds: toNullableJson(params.deckIds),
    },
  });
}

export async function persistEpisode(
  runId: number,
  episodeIndex: number,
  result: SimulationResult,
  decision: EpisodeReplayDecision = shouldPersistEpisodeReplay(result, episodeIndex)
) {
  if (!decision.storeEpisode) return null;
  const mode = decision.storageMode;
  const shouldStoreSteps = decision.storeSteps;
  const storeFullSteps = mode === "full";

  const steps = shouldStoreSteps
    ? result.history.map((entry, step) => {
        const reward =
          result.winnerIndex === null
            ? 0
            : entry.playerIndex === result.winnerIndex
              ? 1
              : -1;
        return {
          step,
          playerIndex: entry.playerIndex,
          agentId: entry.agentId ?? null,
          actionType: entry.action.type,
          card: "card" in entry.action ? entry.action.card ?? null : null,
          state: toJson(storeFullSteps ? entry.state : buildStateDigest(entry.state)),
          availableActions: storeFullSteps ? toJson(entry.availableActions) : Prisma.JsonNull,
          decisionMeta: storeFullSteps ? toNullableJson(entry.metadata) : Prisma.JsonNull,
          actionPayload: storeFullSteps ? toJson(entry.action) : Prisma.JsonNull,
          reward,
          shapedReward: entry.shapedReward ?? null, // Phase 2
          winnerIndex: result.winnerIndex,
        };
      })
    : [];

  await prisma.episode.create({
    data: {
      runId,
      index: episodeIndex,
      winnerIndex: result.winnerIndex,
      turnCount: result.turns,
      finalState: storeFullSteps ? toJson(result.finalState) : toJson(buildStateDigest(result.finalState)),
      ...(shouldStoreSteps ? { steps: { createMany: { data: steps } } } : {}),
    },
  });
}

export async function upsertPolicyRecords(
  runId: number | null,
  store: PatternStore,
  options: { dirtyOnly?: boolean } = {}
): Promise<PolicyFlushStats> {
  const records = options.dirtyOnly ? store.dirtyEntries() : store.entries();
  if (!records.length) {
    return { recordsUpdated: 0, approximatePolicyBytes: 0, retryCount: 0, failedAttempts: 0 };
  }

  const maxRetries = Math.max(0, Number(process.env.POLICY_FLUSH_RETRIES ?? 5));
  const baseDelayMs = Math.max(1, Number(process.env.POLICY_FLUSH_RETRY_BASE_MS ?? 500));
  let failedAttempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await prisma.$transaction(
        records.map((record) =>
          prisma.policyRecord.upsert({
            where: {
              pattern_actionKey: {
                pattern: record.pattern,
                actionKey: record.actionKey,
              },
            },
            update: {
              score: record.score,
              visits: record.visits,
              rewardSquaredSum: record.rewardSquaredSum ?? null,
              winCount: record.winCount ?? 0,
              lossCount: record.lossCount ?? 0,
              runId,
              updatedAt: new Date(),
            },
            create: {
              pattern: record.pattern,
              actionKey: record.actionKey,
              score: record.score,
              visits: record.visits,
              rewardSquaredSum: record.rewardSquaredSum ?? null,
              winCount: record.winCount ?? 0,
              lossCount: record.lossCount ?? 0,
              runId,
            },
          })
        )
      );
      store.markClean(records);
      return {
        recordsUpdated: records.length,
        approximatePolicyBytes: approximateJsonBytes(records),
        retryCount: attempt,
        failedAttempts,
      };
    } catch (err) {
      failedAttempts++;
      if (!isTransientPolicyFlushError(err) || attempt >= maxRetries) {
        throw new PolicyFlushError(
          `Policy flush failed after ${failedAttempts} attempt(s); dirty records retained.`,
          err,
          failedAttempts,
          records.length
        );
      }
      const delayMs = baseDelayMs * 2 ** attempt;
      console.warn(
        `[policy] transient flush error, retry ${attempt + 1}/${maxRetries} in ${delayMs}ms: ${formatErrorCode(err)}`
      );
      await sleep(delayMs);
    }
  }

  throw new PolicyFlushError(
    "Policy flush failed unexpectedly; dirty records retained.",
    null,
    failedAttempts,
    records.length
  );
}

export async function loadPolicyStore(): Promise<PatternStore> {
  const records = await prisma.policyRecord.findMany({
    select: {
      pattern: true,
      actionKey: true,
      score: true,
      visits: true,
      rewardSquaredSum: true,
      winCount: true,
      lossCount: true,
      updatedAt: true,
    },
  });

  return new PatternStore(records.map((record) => ({
    pattern: record.pattern,
    actionKey: record.actionKey,
    score: record.score,
    visits: record.visits,
    rewardSquaredSum: record.rewardSquaredSum ?? undefined,
    winCount: record.winCount,
    lossCount: record.lossCount,
    lastUpdated: record.updatedAt.toISOString(),
  })));
}

export async function updateSimulationRunSummary(
  runId: number,
  aggregateMetrics: unknown,
  storageStats: unknown
) {
  return prisma.simulationRun.update({
    where: { id: runId },
    data: {
      aggregateMetrics: toNullableJson(aggregateMetrics),
      storageStats: toNullableJson(storageStats),
    },
  });
}

export async function prunePolicyRecords(params: {
  minVisits: number;
  maxAgeDays: number;
  minRecentAgeDays?: number;
}): Promise<number> {
  const minRecentAgeDays = params.minRecentAgeDays ?? 7;
  const cutoff = new Date(Date.now() - params.maxAgeDays * 24 * 60 * 60 * 1000);
  const recentCutoff = new Date(Date.now() - minRecentAgeDays * 24 * 60 * 60 * 1000);
  const result = await prisma.policyRecord.deleteMany({
    where: {
      visits: { lt: params.minVisits },
      updatedAt: { lt: cutoff, not: { gt: recentCutoff } },
      score: { gte: -0.02, lte: 0.02 },
    },
  });
  return result.count;
}

export async function getPolicyStoreVersion(): Promise<{
  count: number;
  updatedAt: Date | null;
}> {
  const [count, latest] = await Promise.all([
    prisma.policyRecord.count(),
    prisma.policyRecord.aggregate({
      _max: { updatedAt: true },
    }),
  ]);

  return {
    count,
    updatedAt: latest._max.updatedAt ?? null,
  };
}

export async function closeDb() {
  await prisma.$disconnect();
}

/**
 * Phase 4 — Aggiorna le statistiche win/loss per una coppia di archetipi.
 * La coppia viene normalizzata in ordine alfabetico per garantire l'unicità.
 */
export async function upsertMatchupStats(
  arch1: string,
  arch2: string,
  winnerArch: string
): Promise<void> {
  if (!arch1 || !arch2 || arch1 === arch2) return;

  // Ordine canonico: alphabetico
  const [a, b] = [arch1, arch2].sort();
  const isWinnerA = winnerArch === a;
  const isWinnerB = winnerArch === b;

  await prisma.matchupStats.upsert({
    where: { archetype1_archetype2: { archetype1: a, archetype2: b } },
    update: {
      wins1: isWinnerA ? { increment: 1 } : undefined,
      wins2: isWinnerB ? { increment: 1 } : undefined,
      total: { increment: 1 },
    },
    create: {
      archetype1: a,
      archetype2: b,
      wins1: isWinnerA ? 1 : 0,
      wins2: isWinnerB ? 1 : 0,
      total: 1,
    },
  });
}

export async function upsertDeck(params: {
  cards: string[];
  cardMetadata?: DeckCardMetadata[];
  sourceUrl?: string;
  name?: string;
  commander?: string;
}) {
  const hash = createDeckHash(params.cards);
  const existing = await prisma.deck.findUnique({ where: { cardHash: hash } });
  if (existing) return existing;

  return prisma.deck.create({
    data: {
      sourceUrl: params.sourceUrl ?? null,
      name: params.name ?? null,
      commander: params.commander ?? null,
      cards: toJson(params.cards),
      cardMetadata: toNullableJson(params.cardMetadata),
      cardHash: hash,
    },
  });
}

export async function getDeckById(id: number) {
  if (!id) return null;
  return prisma.deck.findUnique({ where: { id } });
}

export async function updateDeckMetadata(
  id: number,
  metadata: DeckCardMetadata[]
) {
  if (!id) return;
  await prisma.deck.update({
    where: { id },
    data: { cardMetadata: toJson(metadata) },
  });
}

function createDeckHash(cards: string[]): string {
  const normalized = [...cards]
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const chr = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `deck_${Math.abs(hash)}`;
}

function approximateJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isTransientPolicyFlushError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "P1001") return true;
  const message = String((err as { message?: string } | null)?.message ?? err).toLowerCase();
  return (
    message.includes("connection reset") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("temporary unavailable") ||
    message.includes("temporarily unavailable") ||
    message.includes("can't reach database server")
  );
}

function formatErrorCode(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  const message = String((err as { message?: string } | null)?.message ?? err);
  return code ? `${code} ${message}` : message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
