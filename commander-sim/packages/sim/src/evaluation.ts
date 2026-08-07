import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type {
  AgentDecision,
  AttackDecision,
  BlockDecision,
  CardName,
  DeckCardMetadata,
  SimAction,
  SimAgent,
  SimGameState,
  SimulationResult,
} from "@game-state/types";
import {
  PatternStore,
  patternStoreLifecycleSnapshot,
  recordPolicySnapshotFileRead,
  recordPolicySnapshotJsonParse,
  resetPatternStoreLifecycleMetrics,
  type PatternRecord,
} from "./patterns.js";
import { LearningAgent } from "./learningAgent.js";
import { DecisionTreeAgent } from "./decisionTreeAgent.js";
import { simulateGame } from "./engine.js";
import { setDecisionTraceContextProvider } from "./decisionProfiler.js";

export type EvaluationAgentKind = "heuristic" | "learned" | "random" | "decision-tree";

export interface EvaluationCliConfig {
  games: number;
  seed: number;
  agentA: EvaluationAgentKind;
  agentB: EvaluationAgentKind;
  policyA?: string;
  policyB?: string;
  policy?: string;
  deckIds: number[];
  maxTurns: number;
  outputDir: string;
  eloFile: string;
  csvFile: string;
  regressionWinRateDrop?: number;
  regressionLethalMissedIncrease?: number;
}

export interface EvaluationAgentSpec {
  slot: "A" | "B";
  id: string;
  kind: EvaluationAgentKind;
  policySnapshot?: string;
}

export interface EvaluationMetricSummary {
  games: number;
  winRate: number;
  averagePlacement: number;
  averageTurnSurvived: number;
  averageGameLength: number;
  commanderDamageDealt: number;
  combatDamageDealt: number;
  spellDamageDealt: number;
  creaturesKilled: number;
  creaturesLost: number;
  cardsDrawn: number;
  cardsCast: number;
  landsPlayed: number;
  manaSpent: number;
  manaWasted: number;
  unusedManaRate: number;
  removalUsed: number;
  removalOnHighValueTargetRate: number;
  counterspellEfficiency: number;
  attackFrequency: number;
  blockFrequency: number;
  lethalOpportunities: number;
  lethalChosen: number;
  lethalMissed: number;
  averageBoardValue: number;
  averageHandSize: number;
  averageChooseActionMs: number;
  exactRate: number;
  fuzzyRate: number;
  heuristicRate: number;
}

export interface EloRecord {
  rating: number;
  gamesPlayed: number;
  confidence: number;
}

export interface EvaluationReport {
  config: EvaluationCliConfig;
  seed: number;
  agents: [EvaluationAgentSpec, EvaluationAgentSpec];
  metrics: Record<string, EvaluationMetricSummary>;
  delta: Record<string, number>;
  elo: Record<string, EloRecord>;
  regression: { passed: boolean; failures: string[] };
  durationMs: number;
  commit: string;
  policySnapshots: Record<string, string | undefined>;
  lifecycle?: EvaluationLifecycleMetrics;
  failure?: EvaluationFailureReport;
  patternGenerationBreakdown?: Record<string, {
    count: number;
    totalMs: number;
    avgMs: number;
    p95Ms: number;
    maxMs: number;
    maxInputSize: number;
  }>;
  diagnostics?: {
    watchdogAborts: number;
    fuzzyTimeouts: number;
    fuzzyTimeoutReasons: Record<string, number>;
    monotonicGapDetected: number;
  };
  generatedAt: string;
}

export interface EvaluationLifecycleMetrics {
  policyFileReads: number;
  policyJsonParseCount: number;
  patternStoreBuildCount: number;
  patternIndexBuildCount: number;
  evaluationAgentCreateCount: number;
}

export interface EvaluationFailureReport {
  gameIndex: number;
  seed: number;
  derivedSeed: number;
  reason: string;
  abortDump?: string;
  currentOperation?: string;
  elapsedOperationMs?: number;
  recentActions: string[];
}

interface Accumulator {
  games: number;
  wins: number;
  placement: number;
  turnsSurvived: number;
  gameLength: number;
  commanderDamageDealt: number;
  combatDamageDealt: number;
  spellDamageDealt: number;
  creaturesKilled: number;
  creaturesLost: number;
  cardsDrawn: number;
  cardsCast: number;
  landsPlayed: number;
  manaSpent: number;
  manaWasted: number;
  removalUsed: number;
  removalHighValue: number;
  counterspellUsed: number;
  counterspellEffective: number;
  attacks: number;
  blocks: number;
  decisions: number;
  lethalOpportunities: number;
  lethalChosen: number;
  lethalMissed: number;
  boardValue: number;
  handSize: number;
  chooseActionMs: number;
  exact: number;
  fuzzy: number;
  heuristic: number;
}

const snapshotCache = new Map<string, PatternStore>();
let evaluationAgentCreateCount = 0;
let evaluationTraceContext: { gameIndex?: number; seed?: number } = {};

export class RandomAgent implements SimAgent {
  constructor(public readonly id: string) {}

  decideAction(_state: SimGameState, availableActions: SimAction[]): AgentDecision {
    return {
      action: availableActions[Math.floor(Math.random() * availableActions.length)] ?? { type: "PASS_TURN" },
      metadata: { source: "explore" },
    };
  }

  decideAttackers(): AttackDecision {
    return { attackers: [], metadata: { source: "explore" } };
  }

  decideBlockers(): BlockDecision {
    return { assignments: [], metadata: { source: "explore" } };
  }

  decideTarget(_state: SimGameState, opponentIndices: number[]): number {
    return opponentIndices[Math.floor(Math.random() * opponentIndices.length)] ?? 0;
  }

  decideMulligan(): { keep: boolean } {
    return { keep: true };
  }
}

export async function createEvaluationAgent(
  spec: EvaluationAgentSpec,
  store: PatternStore = new PatternStore()
): Promise<SimAgent> {
  evaluationAgentCreateCount++;
  if (spec.kind === "random") return new RandomAgent(spec.id);
  if (spec.kind === "decision-tree") {
    return readOnlyAgent(new DecisionTreeAgent({ id: spec.id, store, epsilon: 0 }));
  }
  return readOnlyAgent(new LearningAgent({
    id: spec.id,
    store,
    epsilon: spec.kind === "heuristic" ? 0 : 0,
  }));
}

function readOnlyAgent<T extends SimAgent>(agent: T): T {
  const mutable = agent as T & {
    finalizeEpisode?: (reward: number) => void;
    finalizeEpisodeWithRewards?: (rewards: number[]) => void;
  };
  mutable.finalizeEpisode = () => {};
  mutable.finalizeEpisodeWithRewards = () => {};
  return agent;
}

export async function loadPolicySnapshot(snapshot?: string): Promise<PatternStore> {
  if (!snapshot || snapshot === "none" || snapshot === "empty") return new PatternStore();
  const cached = snapshotCache.get(snapshot);
  if (cached) return cached;
  if (snapshot === "db" || snapshot === "current-db") {
    const { loadPolicyStore } = await import("../../db/src/db.js");
    const store = await loadPolicyStore();
    snapshotCache.set(snapshot, store);
    return store;
  }
  const resolved = path.resolve(snapshot);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Policy snapshot not found: ${snapshot}`);
  }
  recordPolicySnapshotFileRead();
  const text = fs.readFileSync(resolved, "utf8");
  recordPolicySnapshotJsonParse();
  const raw = JSON.parse(text) as PatternRecord[];
  const store = new PatternStore(raw);
  snapshotCache.set(snapshot, store);
  return store;
}

export function resetEvaluationDiagnosticsForTest(): void {
  snapshotCache.clear();
  evaluationAgentCreateCount = 0;
  resetPatternStoreLifecycleMetrics();
}

export async function runEvaluation(config: EvaluationCliConfig): Promise<EvaluationReport> {
  const started = performance.now();
  resetPatternStoreLifecycleMetrics();
  snapshotCache.clear();
  evaluationAgentCreateCount = 0;
  const previousEvaluation = process.env.EVALUATION;
  process.env.EVALUATION = "true";
  const previousDebugEpisode = process.env.DEBUG_EPISODE;
  if (process.env.DEBUG_EVALUATION === "true") process.env.DEBUG_EPISODE = "true";
  const [agentASpec, agentBSpec] = buildEvaluationAgentSpecs(config);
  setDecisionTraceContextProvider(() => evaluationTraceContext);
  const stores = {
    A: await loadPolicySnapshot(agentASpec.policySnapshot),
    B: await loadPolicySnapshot(agentBSpec.policySnapshot),
  };
  const beforeStoreSizes = { A: stores.A.entries().length, B: stores.B.entries().length };
  const beforeDirty = { A: stores.A.dirtyCount, B: stores.B.dirtyCount };
  const deck = await loadEvaluationDeck(config.deckIds[0]);
  const accumulators = new Map<string, Accumulator>([
    [agentASpec.id, emptyAccumulator()],
    [agentBSpec.id, emptyAccumulator()],
  ]);
  const random = mulberry32(config.seed);
  let failure: EvaluationFailureReport | undefined;
  const diagnosticsSummary = {
    watchdogAborts: 0,
    fuzzyTimeouts: 0,
    fuzzyTimeoutReasons: {} as Record<string, number>,
    monotonicGapDetected: 0,
  };
  const patternBreakdowns = new Map<string, {
    count: number;
    totalMs: number;
    samples: number[];
    maxMs: number;
    maxInputSize: number;
  }>();

  try {
    for (let game = 0; game < config.games; game++) {
      evaluationTraceContext = { gameIndex: game, seed: config.seed };
      const derivedSeed = Math.floor(random() * 0xffffffff);
      const gameRandom = mulberry32(derivedSeed);
      const agents = [
        await createEvaluationAgent(agentASpec, stores.A),
        await createEvaluationAgent(agentBSpec, stores.B),
        await createEvaluationAgent({ slot: "A", id: `${agentASpec.id}-seat2`, kind: agentASpec.kind }, stores.A),
        await createEvaluationAgent({ slot: "B", id: `${agentBSpec.id}-seat3`, kind: agentBSpec.kind }, stores.B),
      ];
      const seatToAgent = [agentASpec.id, agentBSpec.id, agentASpec.id, agentBSpec.id];
      let result: SimulationResult;
      try {
        result = await withSeededRandom(gameRandom, () =>
          simulateGame(agents, {
            maxTurns: config.maxTurns,
            playerDecks: [deck.cards, deck.cards, deck.cards, deck.cards],
            playerDeckMetadata: [deck.metadata, deck.metadata, deck.metadata, deck.metadata],
            playerCommanders: [deck.commander, deck.commander, deck.commander, deck.commander],
            startingPlayerIndex: Math.floor(gameRandom() * 4),
            enableStack: process.env.ENABLE_STACK === "true",
            log: process.env.DEBUG_EVALUATION === "true" ? (message) => console.log(message) : () => {},
          })
        );
      } catch (error) {
        const abort = error as Error & { reason?: string; diagnostics?: SimulationResult["diagnostics"] };
        failure = {
          gameIndex: game,
          seed: config.seed,
          derivedSeed,
          reason: abort.reason ?? abort.message,
          abortDump: abort.diagnostics?.abortDump,
          currentOperation: parseAbortDumpField(abort.diagnostics?.abortDump, "currentOperation"),
          elapsedOperationMs: optionalNumber(parseAbortDumpField(abort.diagnostics?.abortDump, "elapsedOperationMs")),
          recentActions: abort.diagnostics?.recentActions?.slice(-20) ?? [],
        };
        writeEvaluationFailure(config, failure);
        throw error;
      }
      collectGameMetrics(result, seatToAgent, accumulators);
      mergePatternBreakdowns(patternBreakdowns, result.diagnostics?.decisionOperationBreakdowns);
      mergeEvaluationDiagnostics(diagnosticsSummary, result);
    }
  } finally {
    if (previousEvaluation === undefined) delete process.env.EVALUATION;
    else process.env.EVALUATION = previousEvaluation;
    if (previousDebugEpisode === undefined) delete process.env.DEBUG_EPISODE;
    else process.env.DEBUG_EPISODE = previousDebugEpisode;
    setDecisionTraceContextProvider(undefined);
  }

  assertReadOnlyStore(stores.A, beforeStoreSizes.A, beforeDirty.A);
  assertReadOnlyStore(stores.B, beforeStoreSizes.B, beforeDirty.B);

  const metrics = Object.fromEntries(
    [...accumulators.entries()].map(([id, accumulator]) => [id, summarizeAccumulator(accumulator)])
  );
  const delta = calculateDelta(metrics[agentASpec.id], metrics[agentBSpec.id]);
  const elo = updateEloRatings(config.eloFile, agentASpec.id, agentBSpec.id, metrics[agentASpec.id].winRate, config.games);
  const regression = evaluateRegression(delta, config);
  const report: EvaluationReport = {
    config,
    seed: config.seed,
    agents: [agentASpec, agentBSpec],
    metrics,
    delta,
    elo,
    regression,
    durationMs: performance.now() - started,
    commit: currentCommit(),
    policySnapshots: { [agentASpec.id]: agentASpec.policySnapshot, [agentBSpec.id]: agentBSpec.policySnapshot },
    lifecycle: evaluationLifecycleSnapshot(),
    failure,
    patternGenerationBreakdown: summarizePatternBreakdowns(patternBreakdowns),
    diagnostics: diagnosticsSummary,
    generatedAt: new Date().toISOString(),
  };
  writeEvaluationOutputs(report, config);
  const { closeDb } = await import("../../db/src/db.js");
  await closeDb().catch(() => {});
  return report;
}

export function buildEvaluationAgentSpecs(config: EvaluationCliConfig): [EvaluationAgentSpec, EvaluationAgentSpec] {
  const agentASpec: EvaluationAgentSpec = {
    slot: "A",
    id: labelForAgent(config.agentA, policyForAgent(config.agentA, config.policyA, config.policy)),
    kind: config.agentA,
    policySnapshot: policyForAgent(config.agentA, config.policyA, config.policy),
  };
  const agentBSpec: EvaluationAgentSpec = {
    slot: "B",
    id: labelForAgent(config.agentB, policyForAgent(config.agentB, config.policyB, config.policy)),
    kind: config.agentB,
    policySnapshot: policyForAgent(config.agentB, config.policyB, config.policy),
  };
  return [agentASpec, agentBSpec];
}

export function calculateDelta(a: EvaluationMetricSummary, b: EvaluationMetricSummary): Record<string, number> {
  return Object.fromEntries(
    Object.keys(a).map((key) => {
      const metric = key as keyof EvaluationMetricSummary;
      return [key, Number((a[metric] - b[metric]).toFixed(6))];
    })
  );
}

export function updateEloRatings(
  eloFile: string,
  agentA: string,
  agentB: string,
  agentAWinRate: number,
  games: number
): Record<string, EloRecord> {
  const ratings = readEloFile(eloFile);
  ratings[agentA] ??= { rating: 1000, gamesPlayed: 0, confidence: 0 };
  ratings[agentB] ??= { rating: 1000, gamesPlayed: 0, confidence: 0 };
  const expectedA = 1 / (1 + Math.pow(10, (ratings[agentB].rating - ratings[agentA].rating) / 400));
  const k = 32 * Math.sqrt(Math.max(1, games) / 100);
  const delta = k * (agentAWinRate - expectedA);
  ratings[agentA].rating = Math.round(ratings[agentA].rating + delta);
  ratings[agentB].rating = Math.round(ratings[agentB].rating - delta);
  ratings[agentA].gamesPlayed += games;
  ratings[agentB].gamesPlayed += games;
  ratings[agentA].confidence = confidenceFromGames(ratings[agentA].gamesPlayed);
  ratings[agentB].confidence = confidenceFromGames(ratings[agentB].gamesPlayed);
  fs.mkdirSync(path.dirname(path.resolve(eloFile)), { recursive: true });
  fs.writeFileSync(eloFile, JSON.stringify(ratings, null, 2), "utf8");
  return ratings;
}

export function writeEvaluationOutputs(report: EvaluationReport, config: EvaluationCliConfig): { jsonPath: string; csvPath: string } {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const date = report.generatedAt.slice(0, 10);
  const jsonPath = path.join(config.outputDir, `evaluation-${date}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  const csvPath = config.csvFile;
  fs.mkdirSync(path.dirname(path.resolve(csvPath)), { recursive: true });
  const row = csvRow(report);
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, `${csvHeader()}\n${row}\n`, "utf8");
  } else {
    fs.appendFileSync(csvPath, `${row}\n`, "utf8");
  }
  return { jsonPath, csvPath };
}

export function writeEvaluationFailure(config: EvaluationCliConfig, failure: EvaluationFailureReport): string {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const filePath = path.join(
    config.outputDir,
    `evaluation-failure-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(filePath, JSON.stringify({
    config,
    failure,
    lifecycle: evaluationLifecycleSnapshot(),
    generatedAt: new Date().toISOString(),
    commit: currentCommit(),
  }, null, 2), "utf8");
  return filePath;
}

export function parseEvaluationArgs(argv: string[]): EvaluationCliConfig {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    args.set(token.slice(2), argv[i + 1]?.startsWith("--") ? "true" : argv[++i] ?? "true");
  }
  const outputDir = args.get("outputDir") ?? "data/evaluations";
  return {
    games: Number(args.get("games") ?? 100),
    seed: Number(args.get("seed") ?? 42),
    agentA: parseAgentKind(args.get("agentA") ?? "heuristic"),
    agentB: parseAgentKind(args.get("agentB") ?? "learned"),
    policyA: args.get("policyA"),
    policyB: args.get("policyB"),
    policy: args.get("policy"),
    deckIds: (args.get("deckIds") ?? process.env.DECK_IDS ?? "3").split(",").map((id) => Number(id.trim())).filter(Boolean),
    maxTurns: Number(args.get("maxTurns") ?? 40),
    outputDir,
    eloFile: args.get("eloFile") ?? path.join(outputDir, "elo.json"),
    csvFile: args.get("csvFile") ?? path.join(outputDir, "evaluations.csv"),
    regressionWinRateDrop: optionalNumber(args.get("regressionWinRateDrop")),
    regressionLethalMissedIncrease: optionalNumber(args.get("regressionLethalMissedIncrease")),
  };
}

function collectGameMetrics(
  result: SimulationResult,
  seatToAgent: string[],
  accumulators: Map<string, Accumulator>
): void {
  const placements = placementsForResult(result);
  for (let player = 0; player < seatToAgent.length; player++) {
    const acc = accumulators.get(seatToAgent[player]);
    if (!acc) continue;
    acc.games += 1;
    acc.wins += result.winnerIndex === player ? 1 : 0;
    acc.placement += placements[player] ?? 4;
    acc.turnsSurvived += result.turns;
    acc.gameLength += result.turns;
    acc.boardValue += boardValue(result.finalState, player);
    acc.handSize += result.finalState.hands[player]?.length ?? 0;
  }

  for (let i = 0; i < result.history.length; i++) {
    const entry = result.history[i];
    const agentId = seatToAgent[entry.playerIndex];
    const acc = accumulators.get(agentId);
    if (!acc) continue;
    acc.decisions += 1;
    const action = entry.action;
    if (entry.metadata?.source === "exact") acc.exact += 1;
    if (entry.metadata?.source === "fuzzy") acc.fuzzy += 1;
    if (entry.metadata?.source === "heuristic" || entry.metadata?.source === "fallback") acc.heuristic += 1;
    if (action.type === "CAST_SPELL") {
      acc.cardsCast += 1;
      acc.manaSpent += entry.state.cardMetadata[entry.playerIndex]?.[action.card.toLowerCase()]?.manaValue ?? 0;
      if (isRemoval(action, entry.state)) {
        acc.removalUsed += 1;
        if (targetsHighValue(action, entry.state)) acc.removalHighValue += 1;
      }
      if (isCounterspellAction(action, entry.state)) acc.counterspellUsed += 1;
    }
    if (action.type === "PLAY_LAND") acc.landsPlayed += 1;
    if (action.type === "DECLARE_ATTACKERS") {
      acc.attacks += 1;
      acc.combatDamageDealt += damageDeltaForPlayer(result.history[i + 1]?.state, entry.state, entry.playerIndex);
    }
    if (action.type === "DECLARE_BLOCKERS") acc.blocks += 1;
    const spellDamage = action.type === "CAST_SPELL" || action.type === "ACTIVATE_ABILITY"
      ? damageDeltaForPlayer(result.history[i + 1]?.state, entry.state, entry.playerIndex)
      : 0;
    if (action.type === "CAST_SPELL") acc.spellDamageDealt += spellDamage;
    acc.cardsDrawn += Math.max(0, (result.history[i + 1]?.state.hands[entry.playerIndex]?.length ?? 0) - (entry.state.hands[entry.playerIndex]?.length ?? 0));
    acc.creaturesKilled += Math.max(0, opponentCreatureCount(entry.state, entry.playerIndex) - opponentCreatureCount(result.history[i + 1]?.state, entry.playerIndex));
    acc.creaturesLost += Math.max(0, (entry.state.creatures[entry.playerIndex]?.length ?? 0) - (result.history[i + 1]?.state.creatures[entry.playerIndex]?.length ?? 0));
    acc.manaWasted += Math.max(0, availableManaApprox(entry.state, entry.playerIndex) - manaSpentByAction(action, entry.state));
  }

  const counters = result.diagnostics?.decisionCounters ?? {};
  for (const acc of accumulators.values()) {
    acc.chooseActionMs += ((result.diagnostics?.timingsMs?.["AI chooseAction"] ?? 0) / Math.max(1, seatToAgent.length));
    acc.lethalOpportunities += (counters.lethalOpportunities ?? 0) / Math.max(1, accumulators.size);
    acc.lethalChosen += (counters.lethalActionsChosen ?? 0) / Math.max(1, accumulators.size);
    acc.lethalMissed += (counters.lethalMissed ?? 0) / Math.max(1, accumulators.size);
  }
}

function summarizeAccumulator(acc: Accumulator): EvaluationMetricSummary {
  const games = Math.max(1, acc.games);
  const decisions = Math.max(1, acc.decisions);
  return {
    games: acc.games,
    winRate: acc.wins / games,
    averagePlacement: acc.placement / games,
    averageTurnSurvived: acc.turnsSurvived / games,
    averageGameLength: acc.gameLength / games,
    commanderDamageDealt: acc.commanderDamageDealt / games,
    combatDamageDealt: acc.combatDamageDealt / games,
    spellDamageDealt: acc.spellDamageDealt / games,
    creaturesKilled: acc.creaturesKilled / games,
    creaturesLost: acc.creaturesLost / games,
    cardsDrawn: acc.cardsDrawn / games,
    cardsCast: acc.cardsCast / games,
    landsPlayed: acc.landsPlayed / games,
    manaSpent: acc.manaSpent / games,
    manaWasted: acc.manaWasted / games,
    unusedManaRate: acc.manaWasted / Math.max(1, acc.manaWasted + acc.manaSpent),
    removalUsed: acc.removalUsed / games,
    removalOnHighValueTargetRate: acc.removalHighValue / Math.max(1, acc.removalUsed),
    counterspellEfficiency: acc.counterspellEffective / Math.max(1, acc.counterspellUsed),
    attackFrequency: acc.attacks / decisions,
    blockFrequency: acc.blocks / decisions,
    lethalOpportunities: acc.lethalOpportunities / games,
    lethalChosen: acc.lethalChosen / games,
    lethalMissed: acc.lethalMissed / games,
    averageBoardValue: acc.boardValue / games,
    averageHandSize: acc.handSize / games,
    averageChooseActionMs: acc.chooseActionMs / games,
    exactRate: acc.exact / decisions,
    fuzzyRate: acc.fuzzy / decisions,
    heuristicRate: acc.heuristic / decisions,
  };
}

function emptyAccumulator(): Accumulator {
  return {
    games: 0, wins: 0, placement: 0, turnsSurvived: 0, gameLength: 0,
    commanderDamageDealt: 0, combatDamageDealt: 0, spellDamageDealt: 0,
    creaturesKilled: 0, creaturesLost: 0, cardsDrawn: 0, cardsCast: 0,
    landsPlayed: 0, manaSpent: 0, manaWasted: 0, removalUsed: 0,
    removalHighValue: 0, counterspellUsed: 0, counterspellEffective: 0,
    attacks: 0, blocks: 0, decisions: 0, lethalOpportunities: 0,
    lethalChosen: 0, lethalMissed: 0, boardValue: 0, handSize: 0,
    chooseActionMs: 0, exact: 0, fuzzy: 0, heuristic: 0,
  };
}

async function loadEvaluationDeck(deckId: number): Promise<{ cards: CardName[]; metadata: DeckCardMetadata[]; commander?: CardName }> {
  const { getDeckById } = await import("../../db/src/db.js");
  const record = await getDeckById(deckId);
  if (!record) throw new Error(`Deck ${deckId} not found`);
  return {
    cards: Array.isArray(record.cards) ? record.cards as CardName[] : [],
    metadata: Array.isArray(record.cardMetadata) ? record.cardMetadata as unknown as DeckCardMetadata[] : [],
    commander: record.commander ?? undefined,
  };
}

function placementsForResult(result: SimulationResult): number[] {
  return result.finalState.lifeTotals
    .map((life, player) => ({ life, player, placement: result.winnerIndex === player ? 1 : 2 }))
    .sort((left, right) => left.placement - right.placement || right.life - left.life)
    .reduce((placements, entry, index) => {
      placements[entry.player] = index + 1;
      return placements;
    }, [] as number[]);
}

function boardValue(state: SimGameState, player: number): number {
  return (state.creatures[player] ?? []).reduce((sum, creature) => sum + creature.power + creature.toughness, 0) +
    (state.battlefields[player]?.length ?? 0);
}

function damageDeltaForPlayer(next: SimGameState | undefined, current: SimGameState, player: number): number {
  if (!next) return 0;
  let damage = 0;
  for (let i = 0; i < current.lifeTotals.length; i++) {
    if (i === player) continue;
    damage += Math.max(0, (current.lifeTotals[i] ?? 0) - (next.lifeTotals[i] ?? current.lifeTotals[i] ?? 0));
  }
  return damage;
}

function opponentCreatureCount(state: SimGameState | undefined, player: number): number {
  if (!state) return 0;
  return state.creatures.reduce((sum, creatures, index) => index === player ? sum : sum + creatures.length, 0);
}

function availableManaApprox(state: SimGameState, player: number): number {
  return (state.battlefields[player]?.length ?? 0) + (state.artifactMana[player] ?? 0);
}

function manaSpentByAction(action: SimAction, state: SimGameState): number {
  if (action.type !== "CAST_SPELL") return 0;
  return state.cardMetadata[state.playerIndex]?.[action.card.toLowerCase()]?.manaValue ?? 0;
}

function isRemoval(action: Extract<SimAction, { type: "CAST_SPELL" }>, state: SimGameState): boolean {
  const text = state.cardMetadata[state.playerIndex]?.[action.card.toLowerCase()]?.oracleText?.toLowerCase() ?? "";
  return /destroy|exile|return target|damage to target creature/.test(text);
}

function isCounterspellAction(action: Extract<SimAction, { type: "CAST_SPELL" }>, state: SimGameState): boolean {
  const text = state.cardMetadata[state.playerIndex]?.[action.card.toLowerCase()]?.oracleText?.toLowerCase() ?? "";
  return /counter target/.test(text);
}

function targetsHighValue(action: Extract<SimAction, { type: "CAST_SPELL" }>, state: SimGameState): boolean {
  const targetId = action.targets?.find((target) => target.type === "creature" || target.type === "permanent")?.id ?? action.targetId;
  if (typeof targetId !== "string") return false;
  for (const creatures of state.creatures) {
    const creature = creatures.find((candidate) => candidate.id === targetId);
    if (creature && creature.power + creature.toughness >= 6) return true;
  }
  return false;
}

function assertReadOnlyStore(store: PatternStore, size: number, dirty: number): void {
  if (store.entries().length !== size || store.dirtyCount !== dirty) {
    throw new Error("Evaluation mutated PatternStore");
  }
}

function evaluateRegression(delta: Record<string, number>, config: EvaluationCliConfig): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (config.regressionWinRateDrop !== undefined && delta.winRate < -Math.abs(config.regressionWinRateDrop)) {
    failures.push(`WinRate dropped by ${delta.winRate}`);
  }
  if (config.regressionLethalMissedIncrease !== undefined && delta.lethalMissed > Math.abs(config.regressionLethalMissedIncrease)) {
    failures.push(`LethalMissed increased by ${delta.lethalMissed}`);
  }
  return { passed: failures.length === 0, failures };
}

function mergePatternBreakdowns(
  target: Map<string, { count: number; totalMs: number; samples: number[]; maxMs: number; maxInputSize: number }>,
  source: Record<string, { count: number; totalMs: number; avgMs: number; maxMs: number; maxInputSize: number }> | undefined
): void {
  if (!source) return;
  for (const [name, data] of Object.entries(source)) {
    const current = target.get(name) ?? { count: 0, totalMs: 0, samples: [], maxMs: 0, maxInputSize: 0 };
    current.count += data.count;
    current.totalMs += data.totalMs;
    current.samples.push(data.avgMs);
    current.maxMs = Math.max(current.maxMs, data.maxMs);
    current.maxInputSize = Math.max(current.maxInputSize, data.maxInputSize);
    target.set(name, current);
  }
}

function mergeEvaluationDiagnostics(
  target: { watchdogAborts: number; fuzzyTimeouts: number; fuzzyTimeoutReasons: Record<string, number>; monotonicGapDetected: number },
  result: SimulationResult
): void {
  const diagnostics = result.diagnostics;
  if (!diagnostics) return;
  target.watchdogAborts += diagnostics.timeLimitAborts ?? 0;
  const counters = diagnostics.decisionCounters ?? {};
  target.fuzzyTimeouts += counters.fuzzyLookupTimeouts ?? 0;
  target.monotonicGapDetected += counters.monotonicGapDetected ?? 0;
  for (const [key, value] of Object.entries(counters)) {
    if (!key.startsWith("fuzzyTimeoutReason.")) continue;
    const reason = key.slice("fuzzyTimeoutReason.".length);
    target.fuzzyTimeoutReasons[reason] = (target.fuzzyTimeoutReasons[reason] ?? 0) + value;
  }
}

function summarizePatternBreakdowns(
  source: Map<string, { count: number; totalMs: number; samples: number[]; maxMs: number; maxInputSize: number }>
): EvaluationReport["patternGenerationBreakdown"] {
  return Object.fromEntries([...source.entries()].map(([name, data]) => {
    const sorted = [...data.samples].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    return [name, {
      count: data.count,
      totalMs: data.totalMs,
      avgMs: data.totalMs / Math.max(1, data.count),
      p95Ms: p95,
      maxMs: data.maxMs,
      maxInputSize: data.maxInputSize,
    }];
  }));
}

function readEloFile(filePath: string): Record<string, EloRecord> {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, EloRecord>;
}

function confidenceFromGames(games: number): number {
  return Math.min(1, games / (games + 100));
}

function csvHeader(): string {
  return [
    "generatedAt", "commit", "seed", "games", "agentA", "agentB",
    "winRateA", "winRateB", "deltaWinRate", "placementA", "placementB",
    "lethalMissedA", "lethalMissedB", "deltaLethalMissed",
    "eloA", "eloB", "passed",
  ].join(",");
}

function csvRow(report: EvaluationReport): string {
  const [a, b] = report.agents;
  const ma = report.metrics[a.id];
  const mb = report.metrics[b.id];
  return [
    report.generatedAt, report.commit, report.seed, report.config.games, a.id, b.id,
    ma.winRate, mb.winRate, report.delta.winRate, ma.averagePlacement, mb.averagePlacement,
    ma.lethalMissed, mb.lethalMissed, report.delta.lethalMissed,
    report.elo[a.id]?.rating ?? "", report.elo[b.id]?.rating ?? "", report.regression.passed,
  ].map(csvEscape).join(",");
}

function csvEscape(value: unknown): string {
  const raw = String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function currentCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function labelForAgent(kind: EvaluationAgentKind, policy?: string): string {
  if ((kind === "learned" || kind === "decision-tree") && policy) {
    return `${kind}:${path.basename(policy)}`;
  }
  return kind;
}

function policyForAgent(kind: EvaluationAgentKind, explicitPolicy?: string, sharedPolicy?: string): string | undefined {
  if (explicitPolicy !== undefined) return explicitPolicy;
  return kind === "learned" || kind === "decision-tree" ? sharedPolicy : undefined;
}

function evaluationLifecycleSnapshot(): EvaluationLifecycleMetrics {
  return {
    ...patternStoreLifecycleSnapshot(),
    evaluationAgentCreateCount,
  };
}

function parseAbortDumpField(dump: string | undefined, field: string): string | undefined {
  if (!dump) return undefined;
  const match = dump.match(new RegExp(`${field}=([^\\s]+)`));
  return match?.[1];
}

function parseAgentKind(raw: string): EvaluationAgentKind {
  const normalized = raw.toLowerCase();
  if (normalized === "heuristic" || normalized === "learned" || normalized === "random" || normalized === "decision-tree") {
    return normalized;
  }
  throw new Error(`Unsupported evaluation agent: ${raw}`);
}

function optionalNumber(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

async function withSeededRandom<T>(random: () => number, callback: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = random;
  try {
    return await callback();
  } finally {
    Math.random = original;
  }
}
