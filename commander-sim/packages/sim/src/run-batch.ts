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
import type { DeckCardMetadata, SimulationResult } from "@game-state/types";
import {
  closeDb,
  createSimulationRun,
  loadPolicyStore,
  persistEpisode,
  upsertPolicyRecords,
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
    ? !shouldStoreDb
    : process.env.STORE_DATASET_FILE === "true";
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
const matchupMode: MatchupMode = (() => {
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
            ? (record.cardMetadata as DeckCardMetadata[])
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
      await persistEpisode(runRow.id, i, result);
    }
    if (result.winnerIndex !== null) {
      wins[result.winnerIndex] += 1;
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
    await upsertPolicyRecords(runRow?.id ?? null, store);
  }
  if (shouldStorePolicyFile) {
    store.save(policyPath);
  }
  if (curriculumScheduler) {
    await curriculumScheduler.disconnect().catch(() => {});
  }
  await closeDb();
  console.log("Training complete. Win distribution:", wins);
}

function appendDataset(
  targetPath: string,
  result: SimulationResult,
  episodeIndex: number
) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const lines = result.history.map((entry, step) => {
    const reward =
      result.winnerIndex === null
        ? 0
        : entry.playerIndex === result.winnerIndex
          ? 1
          : -1;
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
