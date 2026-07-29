#!/usr/bin/env ts-node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CardName, DeckCardMetadata, SimAgent } from "@game-state/types";
import { simulateGame } from "./engine.js";
import { LearningAgent } from "./learningAgent.js";
import { DecisionTreeAgent } from "./decisionTreeAgent.js";
import { PatternStore } from "./patterns.js";
import { loadTrainedPolicyStore } from "./policyLoader.js";
import {
  addSimulationToAggregate,
  createEvaluationAggregate,
  finalizeEvaluation,
  formatEvaluationReport,
} from "./evaluationMetrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, "../../../data/evaluation");
const PLAYER_COUNT = 4;

interface EvalConfig {
  episodes: number;
  maxTurns: number;
  seed: number;
  epsilon: number;
  outputDir: string;
  deckPaths: string[];
}

class EvaluationLearningAgent extends LearningAgent {
  override finalizeEpisode(_reward: number): void {
    this.history.length = 0;
  }

  override finalizeEpisodeWithRewards(_rewards: number[]): void {
    this.history.length = 0;
  }
}

class EvaluationDecisionTreeAgent extends DecisionTreeAgent {
  override finalizeEpisode(_reward: number): void {
    this.history.length = 0;
  }

  override finalizeEpisodeWithRewards(_rewards: number[]): void {
    this.history.length = 0;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  fs.mkdirSync(config.outputDir, { recursive: true });

  const livePolicy = await loadTrainedPolicyStore({
    allowEmptyFallback: true,
    log: (message) => console.log(message),
  });
  const decks = loadEvaluationDecks(config.deckPaths);

  console.log(
    `[eval] episodes=${config.episodes} maxTurns=${config.maxTurns} seed=${config.seed} ` +
    `epsilon=${config.epsilon} policy=${livePolicy.source}:${livePolicy.records}`
  );

  const baseline = await runVariant({
    label: "A-baseline-heuristic",
    config,
    decks,
    makeAgents: () => {
      const store = new PatternStore();
      return Array.from({ length: PLAYER_COUNT }, (_, idx) =>
        new EvaluationLearningAgent({
          id: `A-${idx}`,
          store,
          epsilon: config.epsilon,
        })
      );
    },
  });

  const current = await runVariant({
    label: "B-current-policy",
    config,
    decks,
    makeAgents: () => {
      const store = new PatternStore(livePolicy.store.entries());
      return Array.from({ length: PLAYER_COUNT }, (_, idx) =>
        new EvaluationDecisionTreeAgent({
          id: `B-${idx}`,
          store,
          epsilon: config.epsilon,
        })
      );
    },
  });

  const baselineFinal = finalizeEvaluation(baseline);
  const currentFinal = finalizeEvaluation(current);
  const report = formatEvaluationReport(baselineFinal, currentFinal);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(config.outputDir, `ab-report-${stamp}.md`);
  const jsonPath = path.join(config.outputDir, `ab-report-${stamp}.json`);

  fs.writeFileSync(reportPath, report, "utf8");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        config,
        policySource: livePolicy.source,
        policyRecords: livePolicy.records,
        baseline: baselineFinal,
        current: currentFinal,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(report);
  console.log(`[eval] wrote ${reportPath}`);
  console.log(`[eval] wrote ${jsonPath}`);
}

async function runVariant(options: {
  label: string;
  config: EvalConfig;
  decks: EvaluationDeck[];
  makeAgents: () => SimAgent[];
}) {
  const aggregate = createEvaluationAggregate(options.label, PLAYER_COUNT);
  for (let episode = 0; episode < options.config.episodes; episode++) {
    const assignment = assignDecks(options.decks, episode);
    const result = await withSeed(options.config.seed + episode, () =>
      simulateGame(options.makeAgents(), {
        log: () => {},
        maxTurns: options.config.maxTurns,
        maxMulligans: 2,
        startingPlayerIndex: episode % PLAYER_COUNT,
        playerDecks: assignment.map((deck) => deck.cards),
        playerDeckMetadata: assignment.map((deck) => deck.metadata),
        playerCommanders: assignment.map((deck) => deck.commander),
      })
    );
    addSimulationToAggregate(aggregate, result, episode);
    if ((episode + 1) % 50 === 0 || episode + 1 === options.config.episodes) {
      console.log(`[eval] ${options.label} ${episode + 1}/${options.config.episodes}`);
    }
  }
  return aggregate;
}

interface EvaluationDeck {
  name: string;
  cards: CardName[];
  metadata: DeckCardMetadata[];
  commander?: CardName;
}

function loadEvaluationDecks(deckPaths: string[]): EvaluationDeck[] {
  if (deckPaths.length > 0) {
    return deckPaths.map((deckPath) => ({
      name: path.basename(deckPath),
      cards: loadDeckFromFile(deckPath),
      metadata: [],
      commander: undefined,
    }));
  }

  return [
    makeDefaultDeck("Balanced-A"),
    makeDefaultDeck("Balanced-B"),
    makeDefaultDeck("Balanced-C"),
    makeDefaultDeck("Balanced-D"),
  ];
}

function makeDefaultDeck(name: string): EvaluationDeck {
  const cards = [
    ...Array(18).fill("Basic Land"),
    ...Array(8).fill("Burn Spell"),
    ...Array(8).fill("Wild Beast"),
    ...Array(6).fill("Titanic Ogre"),
  ] as CardName[];
  return {
    name,
    cards,
    commander: "Commander",
    metadata: [
      {
        name: "Basic Land",
        typeLine: "Basic Land",
        isLand: true,
        isPermanent: true,
        manaValue: 0,
      },
      {
        name: "Burn Spell",
        typeLine: "Sorcery",
        oracleText: "Burn Spell deals 3 damage to any target.",
        manaValue: 2,
      },
      {
        name: "Wild Beast",
        typeLine: "Creature",
        isCreature: true,
        isPermanent: true,
        manaValue: 3,
        power: 3,
        toughness: 3,
      },
      {
        name: "Titanic Ogre",
        typeLine: "Creature",
        isCreature: true,
        isPermanent: true,
        manaValue: 6,
        power: 6,
        toughness: 6,
      },
    ],
  };
}

function assignDecks(decks: EvaluationDeck[], episode: number): EvaluationDeck[] {
  if (decks.length >= PLAYER_COUNT) {
    return Array.from({ length: PLAYER_COUNT }, (_, player) =>
      decks[(episode + player) % decks.length]
    );
  }
  return Array.from({ length: PLAYER_COUNT }, (_, player) =>
    decks[(episode + player) % Math.max(1, decks.length)] ?? makeDefaultDeck(`Fallback-${player}`)
  );
}

function loadDeckFromFile(filePath: string): CardName[] {
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return [line];
      return Array(Number(match[1])).fill(match[2]);
    });
}

function readConfig(): EvalConfig {
  const episodes = Number(process.argv[2] ?? process.env.EVAL_EPISODES ?? 500);
  const maxTurns = Number(process.env.EVAL_MAX_TURNS ?? 40);
  const seed = Number(process.env.EVAL_SEED ?? 1337);
  const epsilon = Number(process.env.EVAL_EPSILON ?? 0);
  const outputDir = path.resolve(process.env.EVAL_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR);
  const deckPaths = (process.env.DECK_PATHS ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  return {
    episodes: Number.isFinite(episodes) && episodes > 0 ? Math.floor(episodes) : 500,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : 40,
    seed: Number.isFinite(seed) ? Math.floor(seed) : 1337,
    epsilon: Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0,
    outputDir,
    deckPaths,
  };
}

async function withSeed<T>(seed: number, fn: () => Promise<T>): Promise<T> {
  const originalRandom = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  try {
    return await fn();
  } finally {
    Math.random = originalRandom;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === __filename
  : false;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
