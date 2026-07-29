#!/usr/bin/env ts-node
import "dotenv/config";
import fs from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PatternStore } from "./patterns.js";
import { LearningAgent } from "./learningAgent.js";
import { DecisionTreeAgent } from "./decisionTreeAgent.js";
import { AiDecisionAgent } from "./aiDecisionAgent.js";
import { NeuralAgent, createNeuralAgent } from "./neuralAgent.js";
import { simulateGame } from "./engine.js";
import { terminalRewardForPlayer } from "./rewardShaper.js";
import type { DeckCardMetadata, SimulationResult } from "@game-state/types";
import {
  closeDb,
  createSimulationRun,
  loadPolicyStore,
  persistEpisode,
  shouldPersistEpisodeReplay,
  upsertPolicyRecords,
  updateSimulationRunSummary,
  upsertDeck,
  getDeckById,
  updateDeckMetadata,
  upsertMatchupStats,
} from "@db/db";
import { matchArchetype } from "@rules/archetypeMatcher.js";
import type { DeckInfo } from "@rules/archetypeMatcher.js";
import { buildDeckMetadata } from "./cardMetadata.js";
import { ExperienceReplayBuffer } from "@neural/experienceReplay.js";
import { saveModel } from "@neural/modelManager.js";
import { CurriculumScheduler } from "./curriculum.js";
import type { TrainingScenario } from "./curriculum.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const episodes = Number(process.argv[2] ?? 50);

// Phase 5 — Neural agent configuration
const useNeuralAgent = process.env.USE_NEURAL_AGENT === "true";
const neuralTrainInterval = Number(process.env.NEURAL_TRAIN_INTERVAL ?? 50);
const neuralModelDir = path.resolve(__dirname, "../../../data");
const policyPath = path.resolve(__dirname, "../../../data/policy.json");
const datasetPath = path.resolve(__dirname, "../../../data/dataset.jsonl");
const shouldStoreDb =
  process.env.STORE_TO_DB !== "false" && !!process.env.DATABASE_URL;
const shouldStorePolicyFile =
  process.env.STORE_POLICY_FILE === undefined
    ? !shouldStoreDb
    : process.env.STORE_POLICY_FILE === "true";
const shouldStoreDatasetFile =
  process.env.STORE_DATASET_FILE === undefined
    ? false
    : process.env.STORE_DATASET_FILE === "true";
const policyFlushEveryEpisodes = Math.max(
  1,
  Number(process.env.POLICY_FLUSH_EVERY_EPISODES ?? 50)
);
const decksEnv = process.env.DECK_PATHS;
const deckIdsEnv = process.env.DECK_IDS
  ? process.env.DECK_IDS.split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => !Number.isNaN(id) && id > 0)
  : [];
const archetypesEnv =
  process.env.PLAYER_ARCHETYPES?.split(",").map((s) => s.trim()) ?? [];

// Phase 6 — Curriculum scheduler
const useCurriculum = process.env.USE_CURRICULUM === "true";

// Phase 4 — MATCHUP_MODE: mirror | round-robin | random
type MatchupMode = "mirror" | "round-robin" | "random";
let matchupMode: MatchupMode = (() => {
  const raw = (process.env.MATCHUP_MODE ?? "mirror").toLowerCase().trim();
  if (raw === "round-robin") return "round-robin";
  if (raw === "random") return "random";
  return "mirror";
})();

const parseOptionalNumber = (value?: string | null) => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const decisionTreeEnv =
  process.env.USE_DECISION_TREE_AGENT ?? process.env.DECISION_TREE_AGENT;
const useDecisionTree =
  decisionTreeEnv === undefined ? true : decisionTreeEnv !== "false";
const aiEndpointConfigured =
  typeof process.env.AI_DECISION_ENDPOINT === "string" &&
  process.env.AI_DECISION_ENDPOINT.length > 0;
const aiDecisionFlag = process.env.USE_AI_DECISION_AGENT;
const useAiDecisionAgent =
  aiDecisionFlag === "true"
    ? true
    : aiDecisionFlag === "false"
      ? false
      : aiEndpointConfigured;
const logAiReasoning = process.env.AI_DECISION_LOG_REASONING === "true";
const decisionTreeConfidence = parseOptionalNumber(
  process.env.DECISION_TREE_CONFIDENCE
);
const decisionTreeMinVisits = parseOptionalNumber(
  process.env.DECISION_TREE_MIN_VISITS
);
const decisionTreeConfidenceK = parseOptionalNumber(
  process.env.DECISION_TREE_CONFIDENCE_K
);

type TrainingMetrics = {
  exactHits: number;
  fuzzyHits: number;
  heuristicFallbacks: number;
  explorations: number;
  decisions: number;
  expectedRewardSum: number;
  confidenceSum: number;
  visitsSum: number;
  actionTypes: Record<string, number>;
  archetypeWins: Record<string, { wins: number; games: number }>;
  missedLandDropOpportunity: number;
  lethalMissed: number;
  anomalousEpisodes: number;
  replayEpisodesStored: number;
  episodeStepRowsStored: number;
  policyDbWrites: number;
  policyFlushes: number;
  approximatePolicyBytes: number;
  approximateReplayBytes: number;
};

// Phase 4 — assegna i deck ai player per l'episodio corrente
function assignDecksForEpisode(
  sourceDeckList: DeckInfo[],
  deckArchetypes: string[],
  mode: MatchupMode,
  episodeIndex: number,
  playerCount: number
): Array<{ deck: DeckInfo; archetype: string }> {
  const n = sourceDeckList.length;
  if (n === 0) return [];

  if (mode === "mirror") {
    const base = sourceDeckList[0];
    const arch = deckArchetypes[0] ?? "Unknown";
    return Array.from({ length: playerCount }, () => ({ deck: base, archetype: arch }));
  }

  if (mode === "random") {
    return Array.from({ length: playerCount }, () => {
      const idx = Math.floor(Math.random() * n);
      return { deck: sourceDeckList[idx], archetype: deckArchetypes[idx] ?? "Unknown" };
    });
  }

  // round-robin: player p usa deck[(episodeIndex + p) % n]
  return Array.from({ length: playerCount }, (_, p) => {
    const idx = (episodeIndex + p) % n;
    return { deck: sourceDeckList[idx], archetype: deckArchetypes[idx] ?? "Unknown" };
  });
}

async function main() {
  const store = shouldStoreDb
    ? await loadPolicyStore().catch((err) => {
        console.warn("[batch] Unable to load policy from DB, fallback to file:", err);
        return PatternStore.load(policyPath);
      })
    : PatternStore.load(policyPath);
  const PLAYER_COUNT = 4;

  // ── Caricamento deck ──
  let decks: DeckInfo[] = [];

  if (deckIdsEnv.length) {
    const loaded = await Promise.all(
      deckIdsEnv.map(async (id) => {
        const record = await getDeckById(id);
        if (!record) {
          throw new Error(`Deck con ID ${id} non trovato nel database.`);
        }
        const cards = Array.isArray(record.cards)
          ? (record.cards as string[])
          : [];
        return {
          id: record.id,
          name: record.name ?? `Deck-${record.id}`,
          commander: record.commander ?? undefined,
          cards,
          cardMetadata: Array.isArray(record.cardMetadata)
            ? (record.cardMetadata as unknown as DeckCardMetadata[])
            : undefined,
        };
      })
    );
    decks = loaded;
  } else if (decksEnv) {
    decks = decksEnv.split(";").map((p, idx) => ({
      name: `Deck-${idx + 1}`,
      cards: loadDeckFromFile(path.resolve(p)),
    }));
  }

  // Mirror mode con un solo deck: mantieni 1 deck (assignDecksForEpisode lo replica)
  if (decks.length === 0) {
    decks = [{ name: "DefaultDeck", cards: [] }];
  }
  if (!process.env.MATCHUP_MODE && decks.length > 1) {
    matchupMode = "round-robin";
  }

  // Arricchisci metadata mancanti
  for (const deck of decks) {
    if (!deck.cardMetadata || deck.cardMetadata.length === 0) {
      const metadata = await buildDeckMetadata(deck.cards);
      deck.cardMetadata = metadata;
      if (deck.id && metadata.length) {
        await updateDeckMetadata(deck.id, metadata);
      }
    }
  }

  // ── Calcola archetipi per ogni deck ──
  const deckArchetypes = await Promise.all(
    decks.map(async (deck, idx) => {
      if (archetypesEnv[idx]) return archetypesEnv[idx];
      const match = await matchArchetype(deck);
      return match.archetype?.name ?? "Unknown";
    })
  );

  // ── Persist deck IDs ──
  const deckIds: number[] = [];
  for (const deck of decks.slice(0, PLAYER_COUNT)) {
    if (deckIdsEnv.length && deck.id) {
      deckIds.push(deck.id);
    } else {
      const saved = await upsertDeck({
        cards: deck.cards,
        name: deck.name,
        commander: deck.commander,
        cardMetadata: deck.cardMetadata,
      });
      deckIds.push(saved.id);
      deck.id = saved.id;
    }
  }

  // ── Log inizio batch ──
  console.log(`[batch] MATCHUP_MODE=${matchupMode} | episodes=${episodes}`);
  console.log(
    `[batch] policy_source=${shouldStoreDb ? "db" : "file"} | dataset_file=${shouldStoreDatasetFile ? "on" : "off"}`
  );
  console.log(
    `[batch] storage EPISODE_STEP_STORAGE=${process.env.EPISODE_STEP_STORAGE ?? "off"} ` +
    `EPISODE_SAMPLE_RATE=${process.env.EPISODE_SAMPLE_RATE ?? "0.01"} ` +
    `SAVE_ANOMALOUS_EPISODES=${process.env.SAVE_ANOMALOUS_EPISODES ?? "true"} ` +
    `POLICY_FLUSH_EVERY_EPISODES=${policyFlushEveryEpisodes}`
  );
  console.log(`[batch] Decks disponibili:`);
  decks.forEach((d, i) =>
    console.log(`  Deck[${i}] "${d.name ?? "?"}" → archetype=${deckArchetypes[i]}`)
  );
  // Mostra l'assegnamento del primo episodio come esempio
  const previewAssignment = assignDecksForEpisode(decks, deckArchetypes, matchupMode, 0, PLAYER_COUNT);
  console.log(`[batch] Esempio ep.0: ${previewAssignment.map((a, p) => `P${p}=${a.archetype}`).join(", ")}`);

  // ── Crea agenti (con archetype del primo episodio, verrà aggiornato se necessario) ──
  const initialAssignment = previewAssignment;
  const agents = Array.from({ length: PLAYER_COUNT }, (_, idx) => {
    const arch = initialAssignment[idx]?.archetype ?? "Unknown";
    const opponentArchs = initialAssignment
      .filter((_, i) => i !== idx)
      .map((a) => a.archetype);

    const baseOptions = {
      id: `Agent-${idx}`,
      store,
      epsilon: 0.15,
      confidenceK: decisionTreeConfidenceK,
      archetype: arch,
      opponentArchetypes: opponentArchs,
    };

    if (useAiDecisionAgent) {
      if (!aiEndpointConfigured) {
        console.warn(
          "[sim] USE_AI_DECISION_AGENT abilitato ma AI_DECISION_ENDPOINT non è configurato. Fallback al DecisionTreeAgent."
        );
      } else {
        return new AiDecisionAgent({
          ...baseOptions,
          confidenceThreshold: decisionTreeConfidence,
          minVisits: decisionTreeMinVisits,
          logReasoning: logAiReasoning,
        });
      }
    }

    if (useDecisionTree) {
      return new DecisionTreeAgent({
        ...baseOptions,
        confidenceThreshold: decisionTreeConfidence,
        minVisits: decisionTreeMinVisits,
      });
    }

    if (useNeuralAgent) {
      return createNeuralAgent({ ...baseOptions, modelDir: neuralModelDir });
    }

    return new LearningAgent(baseOptions);
  });

  const wins = Array(PLAYER_COUNT).fill(0);
  const metrics: TrainingMetrics = {
    exactHits: 0,
    fuzzyHits: 0,
    heuristicFallbacks: 0,
    explorations: 0,
    decisions: 0,
    expectedRewardSum: 0,
    confidenceSum: 0,
    visitsSum: 0,
    actionTypes: {},
    archetypeWins: {},
    missedLandDropOpportunity: 0,
    lethalMissed: 0,
    anomalousEpisodes: 0,
    replayEpisodesStored: 0,
    episodeStepRowsStored: 0,
    policyDbWrites: 0,
    policyFlushes: 0,
    approximatePolicyBytes: 0,
    approximateReplayBytes: 0,
  };
  const runRow = shouldStoreDb
    ? await createSimulationRun({
        episodes,
        players: PLAYER_COUNT,
        maxTurns: 40,
        policyPath: shouldStorePolicyFile ? policyPath : undefined,
        archetypes: initialAssignment.map((a) => a.archetype),
        deckIds: deckIds.length ? deckIds : undefined,
      })
    : null;

  // Phase 6 — Curriculum scheduler initialization
  const curriculumScheduler = useCurriculum && shouldStoreDb
    ? new CurriculumScheduler()
    : null;
  let currentScenario: TrainingScenario | null = null;

  for (let i = 0; i < episodes; i++) {
    // Phase 6 — Curriculum: analyze weaknesses and build scenario before each batch
    if (curriculumScheduler && i % 10 === 0) {
      try {
        const report = await curriculumScheduler.analyzeWeaknesses();
        curriculumScheduler.updatePhaseEpsilons(report.weaknesses);
        const topWeakness = report.weaknesses[0];
        if (topWeakness) {
          currentScenario = curriculumScheduler.buildTrainingScenario(topWeakness);
          console.log(
            `[curriculum] ep.${i} weakness="${topWeakness.area}" wr=${topWeakness.winRate.toFixed(2)} ` +
            `focus=${currentScenario.focusPhase ?? "general"}`
          );
        }
      } catch (err) {
        console.warn("[curriculum] analyzeWeaknesses failed:", err);
      }
    }

    // Phase 4 — aggiorna assegnamento deck/archetype per questo episodio
    const assignment = assignDecksForEpisode(decks, deckArchetypes, matchupMode, i, PLAYER_COUNT);

    // Phase 6 — apply curriculum archetype overrides if scenario specifies them
    if (currentScenario?.deckMatchup?.archetypes?.length) {
      const scenarioArchs = currentScenario.deckMatchup.archetypes;
      for (let p = 0; p < PLAYER_COUNT; p++) {
        const scenarioArch = scenarioArchs[p % scenarioArchs.length];
        if (scenarioArch && assignment[p]) {
          assignment[p].archetype = scenarioArch;
        }
      }
    }

    // Aggiorna archetipi sugli agenti se la modalità lo richiede
    if (matchupMode !== "mirror") {
      for (let p = 0; p < PLAYER_COUNT; p++) {
        const newArch = assignment[p]?.archetype ?? "Unknown";
        const opponentArchs = assignment
          .filter((_, j) => j !== p)
          .map((a) => a.archetype);
        agents[p].setArchetype(newArch, opponentArchs);
      }
    }

    const playerDeckLists = assignment.map((a) => a.deck.cards ?? []);
    const playerDeckMetadata = assignment.map((a) => a.deck.cardMetadata ?? []);

    const result = await simulateGame(agents, {
      log: () => {},
      maxTurns: 40,
      playerDecks: playerDeckLists,
      playerDeckMetadata,
    });

    if (shouldStoreDatasetFile) {
      appendDataset(datasetPath, result, i);
    }
    if (shouldStoreDb && runRow) {
      const replayDecision = shouldPersistEpisodeReplay(result, i);
      if (replayDecision.storeEpisode) {
        await persistEpisode(runRow.id, i, result, replayDecision);
        metrics.replayEpisodesStored += 1;
        metrics.episodeStepRowsStored += replayDecision.storeSteps ? result.history.length : 0;
        metrics.approximateReplayBytes += approximateReplayBytes(result, replayDecision.storageMode);
        if (replayDecision.reason === "anomaly") metrics.anomalousEpisodes += 1;
      }
    }
    if (result.winnerIndex !== null) {
      wins[result.winnerIndex] += 1;
    }
    updateTrainingMetrics(metrics, result, assignment.map((a) => a.archetype));

    if (shouldStoreDb && (i + 1) % policyFlushEveryEpisodes === 0) {
      await flushPolicy(runRow?.id ?? null, store, metrics);
    }

    // Phase 4 — aggiorna MatchupStats per ogni coppia di archetipi
    if (shouldStoreDb && result.winnerIndex !== null) {
      const winnerArch = assignment[result.winnerIndex]?.archetype ?? "Unknown";
      for (let p = 0; p < PLAYER_COUNT; p++) {
        if (p === result.winnerIndex) continue;
        const loserArch = assignment[p]?.archetype ?? "Unknown";
        await upsertMatchupStats(winnerArch, loserArch, winnerArch).catch(() => {});
      }
    }

    // Phase 6 — Curriculum: update episode count and log improvements
    if (curriculumScheduler) {
      curriculumScheduler.incrementEpisodeCount();
    }

    if ((i + 1) % 10 === 0) {
      console.log(`Completed ${i + 1}/${episodes} episodes`);
      console.log(formatTrainingMetrics(metrics));
      // Phase 6 — Curriculum: log current weakness areas
      if (curriculumScheduler && (i + 1) % 50 === 0) {
        try {
          const report = await curriculumScheduler.analyzeWeaknesses();
          if (report.weaknesses.length > 0) {
            const top = report.weaknesses.slice(0, 3);
            console.log(
              `[curriculum] Top weaknesses: ${top.map((w) => `${w.area}(${(w.winRate * 100).toFixed(0)}%)`).join(", ")}`
            );
          }
        } catch {
          // ignore
        }
      }
    }

    // Phase 5 — Neural training pass every neuralTrainInterval episodes
    if (useNeuralAgent && (i + 1) % neuralTrainInterval === 0) {
      try {
        const neuralAgents = agents.filter(
          (a): a is NeuralAgent => a instanceof NeuralAgent
        );
        if (neuralAgents.length === 0) continue;

        const replay = new ExperienceReplayBuffer({ batchSize: 256 });
        const examples = shouldStoreDb
          ? await replay.sampleBatch()
          : replay.sampleFromDataset(datasetPath);

        if (examples.length > 10) {
          // Use the first agent's net (or create a new one) for training
          let trainingNet = neuralAgents[0].getNet();
          if (!trainingNet) {
            const { PolicyNet } = await import("@neural/policyNet.js");
            trainingNet = new PolicyNet();
          }

          let totalLoss = 0;
          const TRAIN_BATCHES = 10;
          const BATCH_SIZE = 256;
          for (let b = 0; b < TRAIN_BATCHES; b++) {
            const batchStart = (b * BATCH_SIZE) % examples.length;
            const batch = examples.slice(batchStart, batchStart + BATCH_SIZE);
            totalLoss += trainingNet.train(batch, 0.001);
          }
          const avgLoss = totalLoss / TRAIN_BATCHES;

          const saved = saveModel(trainingNet, neuralModelDir);
          console.log(
            `[neural] ep.${i + 1} — trained ${examples.length} examples, avg_loss=${avgLoss.toFixed(4)}, saved ${saved.path}`
          );

          // Update all neural agents with new model
          for (const agent of neuralAgents) {
            agent.setModel(trainingNet);
          }
        }
      } catch (err) {
        console.warn("[neural] Training pass failed:", err);
      }
    }
  }

  if (shouldStoreDb) {
    await flushPolicy(runRow?.id ?? null, store, metrics);
    if (runRow) {
      await updateSimulationRunSummary(runRow.id, summarizeTrainingMetrics(metrics, episodes), summarizeStorage(metrics, store));
    }
  }
  if (shouldStorePolicyFile) {
    store.save(policyPath);
  }
  if (curriculumScheduler) {
    await curriculumScheduler.disconnect().catch(() => {});
  }
  await closeDb();
  console.log("Training complete. Win distribution:", wins);
  console.log(formatTrainingMetrics(metrics));
  console.log(formatStorageMetrics(metrics, store, episodes));
}

function appendDataset(
  targetPath: string,
  result: SimulationResult,
  episodeIndex: number
) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const lines = result.history.map((entry, step) => {
    const reward = terminalRewardForPlayer(
      result.winnerIndex,
      entry.playerIndex,
      result.finalState.lifeTotals
    );
    return JSON.stringify({
      episode: episodeIndex,
      step,
      playerIndex: entry.playerIndex,
      agentId: entry.agentId,
      action: entry.action,
      state: entry.state,
      availableActions: entry.availableActions,
      metadata: entry.metadata,
      winnerIndex: result.winnerIndex,
      reward,
      shapedReward: entry.shapedReward ?? null, // Phase 2: reward intermedio shaped
    });
  });
  if (lines.length) {
    fs.appendFileSync(targetPath, lines.join("\n") + "\n", "utf8");
  }
}

function updateTrainingMetrics(
  metrics: TrainingMetrics,
  result: SimulationResult,
  archetypes: string[]
) {
  for (const archetype of archetypes) {
    metrics.archetypeWins[archetype] ??= { wins: 0, games: 0 };
    metrics.archetypeWins[archetype].games += 1;
  }
  if (result.winnerIndex !== null) {
    const winnerArch = archetypes[result.winnerIndex] ?? "Unknown";
    metrics.archetypeWins[winnerArch] ??= { wins: 0, games: 0 };
    metrics.archetypeWins[winnerArch].wins += 1;
  }
  metrics.missedLandDropOpportunity += result.metrics?.missedLandDropOpportunity ?? 0;

  for (const entry of result.history) {
    metrics.decisions += 1;
    metrics.actionTypes[entry.action.type] = (metrics.actionTypes[entry.action.type] ?? 0) + 1;
    const meta = entry.metadata;
    if (!meta) continue;
    if (meta.source === "exact") metrics.exactHits += 1;
    if (meta.source === "fuzzy") metrics.fuzzyHits += 1;
    if (meta.source === "heuristic" || meta.source === "fallback") metrics.heuristicFallbacks += 1;
    if (meta.source === "explore") metrics.explorations += 1;
    metrics.expectedRewardSum += meta.expectedReward ?? 0;
    metrics.confidenceSum += meta.confidence ?? 0;
    metrics.visitsSum = (metrics.visitsSum ?? 0) + (meta.visits ?? 0);
    if (entry.action.type === "DECLARE_ATTACKERS" && isMissedLethal(entry)) {
      metrics.lethalMissed += 1;
    }
  }
}

function formatTrainingMetrics(metrics: TrainingMetrics): string {
  const decisions = Math.max(1, metrics.decisions);
  const rate = (value: number) => `${((value / decisions) * 100).toFixed(1)}%`;
  const archetypes = Object.entries(metrics.archetypeWins)
    .map(([arch, stats]) => `${arch}:${((stats.wins / Math.max(1, stats.games)) * 100).toFixed(1)}%`)
    .join(", ");
  const actionTypes = Object.entries(metrics.actionTypes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}:${count}`)
    .join(", ");
  return (
    `[metrics] exact=${rate(metrics.exactHits)} fuzzy=${rate(metrics.fuzzyHits)} ` +
    `heuristic=${rate(metrics.heuristicFallbacks)} explore=${rate(metrics.explorations)} ` +
    `avgExpected=${(metrics.expectedRewardSum / decisions).toFixed(3)} ` +
    `avgConfidence=${(metrics.confidenceSum / decisions).toFixed(3)} ` +
    `avgVisits=${(metrics.visitsSum / decisions).toFixed(1)} ` +
    `missedLandDrops=${metrics.missedLandDropOpportunity} lethalMissed=${metrics.lethalMissed} ` +
    `archetypeWR=[${archetypes}] actions=[${actionTypes}]`
  );
}

async function flushPolicy(
  runId: number | null,
  store: PatternStore,
  metrics: TrainingMetrics
) {
  if (store.dirtyCount === 0) return;
  const stats = await upsertPolicyRecords(runId, store, { dirtyOnly: true });
  metrics.policyDbWrites += stats.recordsUpdated;
  metrics.policyFlushes += stats.recordsUpdated > 0 ? 1 : 0;
  metrics.approximatePolicyBytes += stats.approximatePolicyBytes;
}

function summarizeTrainingMetrics(metrics: TrainingMetrics, episodes: number) {
  const decisions = Math.max(1, metrics.decisions);
  return {
    episodes,
    decisions: metrics.decisions,
    exactHitRate: metrics.exactHits / decisions,
    fuzzyHitRate: metrics.fuzzyHits / decisions,
    heuristicFallbackRate: metrics.heuristicFallbacks / decisions,
    explorationRate: metrics.explorations / decisions,
    avgExpectedReward: metrics.expectedRewardSum / decisions,
    avgConfidence: metrics.confidenceSum / decisions,
    avgVisits: metrics.visitsSum / decisions,
    missedLandDropOpportunity: metrics.missedLandDropOpportunity,
    lethalMissed: metrics.lethalMissed,
    actionCounts: metrics.actionTypes,
    archetypeWins: metrics.archetypeWins,
    anomalousEpisodes: metrics.anomalousEpisodes,
  };
}

function summarizeStorage(
  metrics: TrainingMetrics,
  store: PatternStore
) {
  const policyRecordCount = store.entries().length;
  return {
    policyRecordCount,
    episodeStepCount: metrics.episodeStepRowsStored,
    storedReplayCount: metrics.replayEpisodesStored,
    approximatePolicyBytes: approximateJsonBytes(store.entries()),
    approximateReplayBytes: metrics.approximateReplayBytes,
    policyDbWrites: metrics.policyDbWrites,
    policyFlushes: metrics.policyFlushes,
    recordsUpdatedPerFlush:
      metrics.policyDbWrites / Math.max(1, metrics.policyFlushes),
  };
}

function formatStorageMetrics(
  metrics: TrainingMetrics,
  store: PatternStore,
  episodes: number
): string {
  const summary = summarizeStorage(metrics, store);
  return (
    `[storage] episodes=${episodes} decisions=${metrics.decisions} ` +
    `policyRecords=${summary.policyRecordCount} replayEpisodes=${summary.storedReplayCount} ` +
    `episodeStepRows=${summary.episodeStepCount} policyDbWrites=${summary.policyDbWrites} ` +
    `dbWritesPerEpisode=${(summary.policyDbWrites / Math.max(1, episodes)).toFixed(2)} ` +
    `recordsPerFlush=${summary.recordsUpdatedPerFlush.toFixed(1)} ` +
    `approxPolicyBytes=${summary.approximatePolicyBytes} approxReplayBytes=${summary.approximateReplayBytes} ` +
    `mode=${process.env.EPISODE_STEP_STORAGE ?? "off"} sample=${process.env.EPISODE_SAMPLE_RATE ?? "0.01"} ` +
    `anomaly=${process.env.SAVE_ANOMALOUS_EPISODES ?? "true"}`
  );
}

function approximateReplayBytes(
  result: SimulationResult,
  mode: "off" | "digest" | "full"
): number {
  if (mode === "off") {
    return approximateJsonBytes({
      winnerIndex: result.winnerIndex,
      turns: result.turns,
      finalStateDigest: result.finalState,
    });
  }
  if (mode === "digest") {
    return approximateJsonBytes({
      winnerIndex: result.winnerIndex,
      turns: result.turns,
      steps: result.history.map((entry) => ({
        playerIndex: entry.playerIndex,
        action: entry.action,
        metadata: entry.metadata,
      })),
    });
  }
  return approximateJsonBytes(result);
}

function approximateJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isMissedLethal(entry: SimulationResult["history"][number]): boolean {
  if (entry.action.type !== "DECLARE_ATTACKERS") return false;
  const readyAttackers = entry.state.creatures[entry.playerIndex]?.filter(
    (creature) => !creature.tapped && !creature.summoningSickness
  ) ?? [];
  const readyPower = readyAttackers.reduce((sum, creature) => sum + creature.power, 0);
  const lowestOpponentLife = entry.state.lifeTotals
    .filter((_life, idx) => idx !== entry.playerIndex)
    .reduce((lowest, life) => Math.min(lowest, life), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(lowestOpponentLife) || readyPower < lowestOpponentLife) return false;
  const chosenPower = readyAttackers
    .filter((creature) => entry.action.type === "DECLARE_ATTACKERS" && entry.action.attackers.includes(creature.id))
    .reduce((sum, creature) => sum + creature.power, 0);
  return chosenPower < lowestOpponentLife;
}

function loadDeckFromFile(filePath: string): string[] {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^\d+x?\s*$/i.test(line));
  } catch (err) {
    console.warn(`[Deck] Unable to load ${filePath}:`, err);
    return [];
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
