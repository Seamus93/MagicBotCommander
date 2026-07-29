import type {
  DecisionSource,
  SimAction,
  SimGameState,
  SimulationHistoryEntry,
  SimulationResult,
} from "@game-state/types";
import { getAvailableMana, isLandCard } from "../../game-state/src/cardUtils.js";

export interface LandTurnMetric {
  opportunities: number;
  plays: number;
}

export interface PlayerEvaluationStats {
  games: number;
  wins: number;
  placementSum: number;
  decisions: number;
  actionTypes: Record<string, number>;
  passMain1: number;
  passMain2: number;
  main1Decisions: number;
  main2Decisions: number;
  manaAvailableAtPassSum: number;
  manaUnusedAtPassSum: number;
  passSamples: number;
  firstFiveLandDrops: number;
  damageDealt: number;
  creaturesLostInCombat: number;
  attackDeclarations: number;
  attackOpportunities: number;
  targetDistribution: Record<string, number>;
}

export interface EvaluationAggregate {
  label: string;
  games: number;
  turnsSum: number;
  missedLandDropOpportunity: number;
  players: PlayerEvaluationStats[];
  decisions: number;
  sourceCounts: Partial<Record<DecisionSource, number>>;
  expectedRewardSum: number;
  confidenceSum: number;
  visitsSum: number;
  metadataSamples: number;
  landDropByTurn: Record<number, LandTurnMetric>;
  anomalies: EvaluationAnomaly[];
}

export interface EvaluationAnomaly {
  type: string;
  severity: number;
  gameIndex: number;
  playerIndex: number;
  turn: number;
  state: {
    phase: string;
    phaseStep: string;
    lifeTotals: number[];
    hand: string[];
    battlefield: string[];
    creatures: number;
    manaAvailable: number;
    manaUnused: number;
  };
  availableActions: string[];
  chosenAction: string;
  source?: DecisionSource;
  expectedReward?: number;
  confidence?: number;
  visits?: number;
  nextReward: number;
}

export interface FinalizedEvaluation {
  label: string;
  games: number;
  winRateByPlayer: number[];
  averagePlacementByPlayer: number[];
  averageTurns: number;
  missedLandDropOpportunity: number;
  landDropRateByTurn: Record<number, number>;
  averageLandDropsFirstFiveTurns: number;
  manaAvailableAtPass: number;
  manaUnusedAtPass: number;
  passTurnRate: number;
  passTurnMain1Rate: number;
  passTurnMain2Rate: number;
  castSpellRate: number;
  playLandRate: number;
  exactPolicyHitRate: number;
  fuzzyPolicyHitRate: number;
  heuristicFallbackRate: number;
  explorationRate: number;
  averageExpectedReward: number;
  averageConfidence: number;
  averageVisits: number;
  combatAttackFrequency: number;
  averageDamageDealt: number;
  averageCreaturesLostInCombat: number;
  lethalMissed: number;
  targetDistribution: Record<string, number>;
  warnings: string[];
  topAnomalies: EvaluationAnomaly[];
}

export function createEvaluationAggregate(label: string, playerCount: number): EvaluationAggregate {
  return {
    label,
    games: 0,
    turnsSum: 0,
    missedLandDropOpportunity: 0,
    players: Array.from({ length: playerCount }, () => createPlayerStats()),
    decisions: 0,
    sourceCounts: {},
    expectedRewardSum: 0,
    confidenceSum: 0,
    visitsSum: 0,
    metadataSamples: 0,
    landDropByTurn: {},
    anomalies: [],
  };
}

export function addSimulationToAggregate(
  aggregate: EvaluationAggregate,
  result: SimulationResult,
  gameIndex: number
): void {
  const playerCount = result.finalState.lifeTotals.length;
  ensurePlayerStats(aggregate, playerCount);
  aggregate.games++;
  aggregate.turnsSum += result.turns;
  aggregate.missedLandDropOpportunity +=
    result.metrics?.missedLandDropOpportunity ?? 0;

  const placements = estimatePlacements(result);
  for (let player = 0; player < playerCount; player++) {
    const stats = aggregate.players[player];
    stats.games++;
    if (result.winnerIndex === player) stats.wins++;
    stats.placementSum += placements[player] ?? playerCount;
  }

  const lethalMissedByPlayer = Array(playerCount).fill(0) as number[];
  const previousCreatureCounts = result.history.map((entry) =>
    entry.state.creatures.map((creatures) => creatures.length)
  );

  for (let index = 0; index < result.history.length; index++) {
    const entry = result.history[index];
    const nextState = result.history[index + 1]?.state ?? result.finalState;
    addDecisionMetrics(aggregate, entry, nextState);
    collectLandTurnMetrics(aggregate, entry);
    collectCombatMetrics(aggregate, entry, nextState, previousCreatureCounts[index] ?? []);

    if (isMissedLethal(entry)) {
      lethalMissedByPlayer[entry.playerIndex]++;
      pushAnomaly(aggregate, makeAnomaly("lethal_missed", 0.9, gameIndex, entry, nextState));
    }
    if (isSecondMainPassWithLand(entry)) {
      pushAnomaly(aggregate, makeAnomaly("main2_pass_with_legal_land", 1, gameIndex, entry, nextState));
    }
    if (isHighConfidenceLowVisits(entry)) {
      pushAnomaly(aggregate, makeAnomaly("high_confidence_low_visits", 0.8, gameIndex, entry, nextState));
    }
    if (isEarlyLandOpportunitySkipped(entry)) {
      pushAnomaly(aggregate, makeAnomaly("early_land_opportunity_skipped", 0.7, gameIndex, entry, nextState));
    }
  }

  for (let player = 0; player < playerCount; player++) {
    aggregate.players[player].actionTypes.LETHAL_MISSED =
      (aggregate.players[player].actionTypes.LETHAL_MISSED ?? 0) +
      lethalMissedByPlayer[player];
  }
}

export function finalizeEvaluation(aggregate: EvaluationAggregate): FinalizedEvaluation {
  const decisions = Math.max(1, aggregate.decisions);
  const metadataSamples = Math.max(1, aggregate.metadataSamples);
  const playerGameCount = Math.max(1, aggregate.games * Math.max(1, aggregate.players.length));
  const passSamples = aggregate.players.reduce((sum, stats) => sum + stats.passSamples, 0);
  const totalAttackDeclarations = aggregate.players.reduce((sum, stats) => sum + stats.attackDeclarations, 0);
  const totalAttackOpportunities = aggregate.players.reduce((sum, stats) => sum + stats.attackOpportunities, 0);
  const totalDamage = aggregate.players.reduce((sum, stats) => sum + stats.damageDealt, 0);
  const totalCombatLosses = aggregate.players.reduce((sum, stats) => sum + stats.creaturesLostInCombat, 0);
  const totalFirstFiveLandDrops = aggregate.players.reduce((sum, stats) => sum + stats.firstFiveLandDrops, 0);
  const targetDistribution = mergeTargetDistributions(aggregate.players);
  const warnings = buildWarnings(aggregate);

  return {
    label: aggregate.label,
    games: aggregate.games,
    winRateByPlayer: aggregate.players.map((stats) => stats.wins / Math.max(1, stats.games)),
    averagePlacementByPlayer: aggregate.players.map((stats) => stats.placementSum / Math.max(1, stats.games)),
    averageTurns: aggregate.turnsSum / Math.max(1, aggregate.games),
    missedLandDropOpportunity: aggregate.missedLandDropOpportunity,
    landDropRateByTurn: Object.fromEntries(
      Object.entries(aggregate.landDropByTurn).map(([turn, metric]) => [
        turn,
        metric.plays / Math.max(1, metric.opportunities),
      ])
    ),
    averageLandDropsFirstFiveTurns: totalFirstFiveLandDrops / playerGameCount,
    manaAvailableAtPass: passSamples > 0
      ? aggregate.players.reduce((sum, stats) => sum + stats.manaAvailableAtPassSum, 0) / passSamples
      : 0,
    manaUnusedAtPass: passSamples > 0
      ? aggregate.players.reduce((sum, stats) => sum + stats.manaUnusedAtPassSum, 0) / passSamples
      : 0,
    passTurnRate: actionRate(aggregate, "PASS_TURN", decisions),
    passTurnMain1Rate: phasePassRate(aggregate, "main1"),
    passTurnMain2Rate: phasePassRate(aggregate, "main2"),
    castSpellRate: actionRate(aggregate, "CAST_SPELL", decisions),
    playLandRate: actionRate(aggregate, "PLAY_LAND", decisions),
    exactPolicyHitRate: (aggregate.sourceCounts.exact ?? 0) / decisions,
    fuzzyPolicyHitRate: (aggregate.sourceCounts.fuzzy ?? 0) / decisions,
    heuristicFallbackRate:
      ((aggregate.sourceCounts.heuristic ?? 0) + (aggregate.sourceCounts.fallback ?? 0)) / decisions,
    explorationRate: (aggregate.sourceCounts.explore ?? 0) / decisions,
    averageExpectedReward: aggregate.expectedRewardSum / metadataSamples,
    averageConfidence: aggregate.confidenceSum / metadataSamples,
    averageVisits: aggregate.visitsSum / metadataSamples,
    combatAttackFrequency: totalAttackDeclarations / Math.max(1, totalAttackOpportunities),
    averageDamageDealt: totalDamage / playerGameCount,
    averageCreaturesLostInCombat: totalCombatLosses / playerGameCount,
    lethalMissed: aggregate.players.reduce((sum, stats) => sum + (stats.actionTypes.LETHAL_MISSED ?? 0), 0),
    targetDistribution,
    warnings,
    topAnomalies: [...aggregate.anomalies]
      .sort((left, right) => right.severity - left.severity)
      .slice(0, 10),
  };
}

export function formatEvaluationReport(
  baseline: FinalizedEvaluation,
  current: FinalizedEvaluation
): string {
  const rows = [
    metricRow("Win rate P0", baseline.winRateByPlayer[0], current.winRateByPlayer[0], true),
    metricRow("Average placement P0", baseline.averagePlacementByPlayer[0], current.averagePlacementByPlayer[0], false),
    metricRow("Average turns", baseline.averageTurns, current.averageTurns, false),
    metricRow("Missed land drops", baseline.missedLandDropOpportunity, current.missedLandDropOpportunity, false),
    metricRow("Land drops T1-T5/player", baseline.averageLandDropsFirstFiveTurns, current.averageLandDropsFirstFiveTurns, true),
    metricRow("Unused mana at pass", baseline.manaUnusedAtPass, current.manaUnusedAtPass, false),
    metricRow("PASS_TURN rate", baseline.passTurnRate, current.passTurnRate, false),
    metricRow("PASS Main 1 rate", baseline.passTurnMain1Rate, current.passTurnMain1Rate, false),
    metricRow("PASS Main 2 rate", baseline.passTurnMain2Rate, current.passTurnMain2Rate, false),
    metricRow("CAST_SPELL rate", baseline.castSpellRate, current.castSpellRate, true),
    metricRow("PLAY_LAND rate", baseline.playLandRate, current.playLandRate, true),
    metricRow("Exact policy hit", baseline.exactPolicyHitRate, current.exactPolicyHitRate, true),
    metricRow("Fuzzy policy hit", baseline.fuzzyPolicyHitRate, current.fuzzyPolicyHitRate, true),
    metricRow("Heuristic fallback", baseline.heuristicFallbackRate, current.heuristicFallbackRate, false),
    metricRow("Exploration", baseline.explorationRate, current.explorationRate, false),
    metricRow("Avg expectedReward", baseline.averageExpectedReward, current.averageExpectedReward, true),
    metricRow("Avg confidence", baseline.averageConfidence, current.averageConfidence, true),
    metricRow("Avg visits", baseline.averageVisits, current.averageVisits, true),
    metricRow("Attack frequency", baseline.combatAttackFrequency, current.combatAttackFrequency, true),
    metricRow("Avg damage dealt", baseline.averageDamageDealt, current.averageDamageDealt, true),
    metricRow("Avg combat losses", baseline.averageCreaturesLostInCombat, current.averageCreaturesLostInCombat, false),
    metricRow("Lethal missed", baseline.lethalMissed, current.lethalMissed, false),
  ];

  const warnings = [...baseline.warnings.map((w) => `A: ${w}`), ...current.warnings.map((w) => `B: ${w}`)];
  return [
    "# MagicBotCommander A/B Evaluation",
    "",
    `Games: A=${baseline.games}, B=${current.games}`,
    "",
    "## Aggregate Metrics",
    "",
    "| Metric | A baseline | B current | Delta | Direction |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    "## Player Metrics",
    "",
    "| Player | A win rate | B win rate | A avg placement | B avg placement |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...current.winRateByPlayer.map((_, player) =>
      `| P${player} | ${pct(baseline.winRateByPlayer[player] ?? 0)} | ` +
      `${pct(current.winRateByPlayer[player] ?? 0)} | ` +
      `${fmt(baseline.averagePlacementByPlayer[player] ?? 0)} | ` +
      `${fmt(current.averagePlacementByPlayer[player] ?? 0)} |`
    ),
    "",
    "## Land Drop Rate T1-T10",
    "",
    "| Turn | A | B |",
    "| --- | ---: | ---: |",
    ...Array.from({ length: 10 }, (_, idx) => {
      const turn = idx + 1;
      return `| T${turn} | ${pct(baseline.landDropRateByTurn[turn] ?? 0)} | ${pct(current.landDropRateByTurn[turn] ?? 0)} |`;
    }),
    "",
    "## Target Distribution",
    "",
    `A: ${formatDistribution(baseline.targetDistribution)}`,
    "",
    `B: ${formatDistribution(current.targetDistribution)}`,
    "",
    "## Automatic Checks",
    "",
    warnings.length ? warnings.map((w) => `- ${w}`).join("\n") : "- No automatic check warnings.",
    "",
    "## Top 10 Anomalies",
    "",
    formatAnomalies(current.topAnomalies),
    "",
    "## Top 5 Remaining Weak Behaviors",
    "",
    formatWeakBehaviors(current),
    "",
    "## Top 3 Recommended ROI Changes",
    "",
    formatRecommendations(current),
    "",
  ].join("\n");
}

function createPlayerStats(): PlayerEvaluationStats {
  return {
    games: 0,
    wins: 0,
    placementSum: 0,
    decisions: 0,
    actionTypes: {},
    passMain1: 0,
    passMain2: 0,
    main1Decisions: 0,
    main2Decisions: 0,
    manaAvailableAtPassSum: 0,
    manaUnusedAtPassSum: 0,
    passSamples: 0,
    firstFiveLandDrops: 0,
    damageDealt: 0,
    creaturesLostInCombat: 0,
    attackDeclarations: 0,
    attackOpportunities: 0,
    targetDistribution: {},
  };
}

function ensurePlayerStats(aggregate: EvaluationAggregate, playerCount: number): void {
  while (aggregate.players.length < playerCount) {
    aggregate.players.push(createPlayerStats());
  }
}

function addDecisionMetrics(
  aggregate: EvaluationAggregate,
  entry: SimulationHistoryEntry,
  nextState: SimGameState
): void {
  const stats = aggregate.players[entry.playerIndex];
  stats.decisions++;
  aggregate.decisions++;
  stats.actionTypes[entry.action.type] = (stats.actionTypes[entry.action.type] ?? 0) + 1;

  if (isMain1(entry.state)) {
    stats.main1Decisions++;
    if (entry.action.type === "PASS_TURN") stats.passMain1++;
  }
  if (isMain2(entry.state)) {
    stats.main2Decisions++;
    if (entry.action.type === "PASS_TURN") stats.passMain2++;
  }

  if (entry.action.type === "PASS_TURN") {
    stats.passSamples++;
    stats.manaAvailableAtPassSum += totalMana(entry.state, entry.playerIndex);
    stats.manaUnusedAtPassSum += getAvailableMana(entry.state, entry.playerIndex);
  }
  if (entry.action.type === "PLAY_LAND" && entry.state.turn <= 5) {
    stats.firstFiveLandDrops++;
  }

  const meta = entry.metadata;
  if (meta) {
    aggregate.sourceCounts[meta.source] = (aggregate.sourceCounts[meta.source] ?? 0) + 1;
    aggregate.expectedRewardSum += meta.expectedReward ?? 0;
    aggregate.confidenceSum += meta.confidence ?? 0;
    aggregate.visitsSum += meta.visits ?? 0;
    aggregate.metadataSamples++;
  }

  stats.damageDealt += damageDealtBetween(entry.state, nextState, entry.playerIndex);
}

function collectLandTurnMetrics(aggregate: EvaluationAggregate, entry: SimulationHistoryEntry): void {
  const turn = entry.state.turn;
  if (turn < 1 || turn > 10) return;
  const hasLegalLand = entry.availableActions.some((action) => action.type === "PLAY_LAND");
  const isLandPlay = entry.action.type === "PLAY_LAND";
  if (!hasLegalLand && !isLandPlay) return;
  aggregate.landDropByTurn[turn] ??= { opportunities: 0, plays: 0 };
  if (hasLegalLand) aggregate.landDropByTurn[turn].opportunities++;
  if (isLandPlay) aggregate.landDropByTurn[turn].plays++;
}

function collectCombatMetrics(
  aggregate: EvaluationAggregate,
  entry: SimulationHistoryEntry,
  nextState: SimGameState,
  previousCreatureCounts: number[]
): void {
  const stats = aggregate.players[entry.playerIndex];
  if (entry.action.type === "DECLARE_ATTACKERS") {
    stats.attackOpportunities++;
    if (entry.action.attackers.length > 0) stats.attackDeclarations++;
    const defender = inferDefenderFromNextState(entry, nextState);
    if (defender !== null) {
      const key = `${entry.playerIndex}->${defender}`;
      stats.targetDistribution[key] = (stats.targetDistribution[key] ?? 0) + 1;
    }
  }
  if (isCombat(entry.state)) {
    const before = previousCreatureCounts[entry.playerIndex] ?? 0;
    const after = nextState.creatures[entry.playerIndex]?.length ?? before;
    if (after < before) stats.creaturesLostInCombat += before - after;
  }
}

function estimatePlacements(result: SimulationResult): number[] {
  const ranked = result.finalState.lifeTotals
    .map((life, player) => ({ player, life }))
    .sort((left, right) => {
      if (result.winnerIndex === left.player) return -1;
      if (result.winnerIndex === right.player) return 1;
      return right.life - left.life;
    });
  const placements = Array(result.finalState.lifeTotals.length).fill(ranked.length) as number[];
  ranked.forEach((entry, idx) => {
    placements[entry.player] = idx + 1;
  });
  return placements;
}

function isSecondMainPassWithLand(entry: SimulationHistoryEntry): boolean {
  return (
    entry.action.type === "PASS_TURN" &&
    isMain2(entry.state) &&
    entry.availableActions.some((action) => action.type === "PLAY_LAND")
  );
}

function isEarlyLandOpportunitySkipped(entry: SimulationHistoryEntry): boolean {
  return (
    entry.state.turn <= 5 &&
    isMain2(entry.state) &&
    entry.action.type !== "PLAY_LAND" &&
    entry.availableActions.some((action) => action.type === "PLAY_LAND")
  );
}

function isHighConfidenceLowVisits(entry: SimulationHistoryEntry): boolean {
  return (
    (entry.metadata?.confidence ?? 0) >= 0.8 &&
    (entry.metadata?.visits ?? Number.POSITIVE_INFINITY) < 5
  );
}

function isMissedLethal(entry: SimulationHistoryEntry): boolean {
  if (entry.action.type !== "DECLARE_ATTACKERS") return false;
  const attackers = entry.state.creatures[entry.playerIndex] ?? [];
  const readyPower = attackers
    .filter((creature) => !creature.tapped && !creature.summoningSickness)
    .reduce((sum, creature) => sum + creature.power, 0);
  const lowestOpponentLife = entry.state.lifeTotals
    .filter((_life, idx) => idx !== entry.playerIndex)
    .reduce((lowest, life) => Math.min(lowest, life), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(lowestOpponentLife) || readyPower < lowestOpponentLife) return false;
  const selectedPower = attackers
    .filter((creature) => entry.action.type === "DECLARE_ATTACKERS" && entry.action.attackers.includes(creature.id))
    .reduce((sum, creature) => sum + creature.power, 0);
  return selectedPower < lowestOpponentLife;
}

function makeAnomaly(
  type: string,
  severity: number,
  gameIndex: number,
  entry: SimulationHistoryEntry,
  nextState: SimGameState
): EvaluationAnomaly {
  return {
    type,
    severity,
    gameIndex,
    playerIndex: entry.playerIndex,
    turn: entry.state.turn,
    state: {
      phase: entry.state.phase,
      phaseStep: entry.state.phaseStep,
      lifeTotals: [...entry.state.lifeTotals],
      hand: [...(entry.state.hands[entry.playerIndex] ?? [])],
      battlefield: [...(entry.state.battlefields[entry.playerIndex] ?? [])],
      creatures: entry.state.creatures[entry.playerIndex]?.length ?? 0,
      manaAvailable: totalMana(entry.state, entry.playerIndex),
      manaUnused: getAvailableMana(entry.state, entry.playerIndex),
    },
    availableActions: entry.availableActions.map(formatAction),
    chosenAction: formatAction(entry.action),
    source: entry.metadata?.source,
    expectedReward: entry.metadata?.expectedReward,
    confidence: entry.metadata?.confidence,
    visits: entry.metadata?.visits,
    nextReward: entry.shapedReward ?? damageDealtBetween(entry.state, nextState, entry.playerIndex),
  };
}

function pushAnomaly(aggregate: EvaluationAggregate, anomaly: EvaluationAnomaly): void {
  aggregate.anomalies.push(anomaly);
  if (aggregate.anomalies.length > 200) {
    aggregate.anomalies.sort((left, right) => right.severity - left.severity);
    aggregate.anomalies.length = 200;
  }
}

function buildWarnings(aggregate: EvaluationAggregate): string[] {
  const finalizedLite = {
    exact: (aggregate.sourceCounts.exact ?? 0) / Math.max(1, aggregate.decisions),
    heuristic:
      ((aggregate.sourceCounts.heuristic ?? 0) + (aggregate.sourceCounts.fallback ?? 0)) /
      Math.max(1, aggregate.decisions),
  };
  const warnings: string[] = [];
  if (aggregate.missedLandDropOpportunity > 0) {
    warnings.push(`missedLandDropOpportunity=${aggregate.missedLandDropOpportunity}, expected 0 in normal games`);
  }
  const early = [1, 2, 3, 4, 5]
    .map((turn) => aggregate.landDropByTurn[turn])
    .filter((metric): metric is LandTurnMetric => Boolean(metric));
  const earlyOpportunities = early.reduce((sum, metric) => sum + metric.opportunities, 0);
  const earlyPlays = early.reduce((sum, metric) => sum + metric.plays, 0);
  if (earlyOpportunities >= 20 && earlyPlays / earlyOpportunities < 0.9) {
    warnings.push(`early land drop rate ${(earlyPlays / earlyOpportunities * 100).toFixed(1)}% below 90%`);
  }
  if (finalizedLite.heuristic > 0.5) {
    warnings.push(`heuristic/fallback dominates decisions (${pct(finalizedLite.heuristic)})`);
  }
  if (aggregate.games >= 50 && finalizedLite.exact < 0.1) {
    warnings.push(`exact policy hit rate is low (${pct(finalizedLite.exact)})`);
  }
  const highConfidenceLowVisits = aggregate.anomalies.filter(
    (anomaly) => anomaly.type === "high_confidence_low_visits"
  ).length;
  if (highConfidenceLowVisits > 0) {
    warnings.push(`${highConfidenceLowVisits} decisions had high confidence with very low visits`);
  }
  return warnings;
}

function actionRate(aggregate: EvaluationAggregate, actionType: string, decisions: number): number {
  const count = aggregate.players.reduce(
    (sum, stats) => sum + (stats.actionTypes[actionType] ?? 0),
    0
  );
  return count / decisions;
}

function phasePassRate(aggregate: EvaluationAggregate, phase: "main1" | "main2"): number {
  const pass = aggregate.players.reduce(
    (sum, stats) => sum + (phase === "main1" ? stats.passMain1 : stats.passMain2),
    0
  );
  const decisions = aggregate.players.reduce(
    (sum, stats) => sum + (phase === "main1" ? stats.main1Decisions : stats.main2Decisions),
    0
  );
  return pass / Math.max(1, decisions);
}

function mergeTargetDistributions(players: PlayerEvaluationStats[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const player of players) {
    for (const [target, count] of Object.entries(player.targetDistribution)) {
      merged[target] = (merged[target] ?? 0) + count;
    }
  }
  return merged;
}

function inferDefenderFromNextState(entry: SimulationHistoryEntry, nextState: SimGameState): number | null {
  if (entry.action.type !== "DECLARE_ATTACKERS") return null;
  const damageByOpponent = entry.state.lifeTotals
    .map((life, idx) => ({ idx, damage: Math.max(0, life - (nextState.lifeTotals[idx] ?? life)) }))
    .filter(({ idx, damage }) => idx !== entry.playerIndex && damage > 0)
    .sort((left, right) => right.damage - left.damage);
  return damageByOpponent[0]?.idx ?? null;
}

function damageDealtBetween(prev: SimGameState, next: SimGameState, player: number): number {
  return prev.lifeTotals.reduce((sum, life, idx) => {
    if (idx === player) return sum;
    return sum + Math.max(0, life - (next.lifeTotals[idx] ?? life));
  }, 0);
}

function totalMana(state: SimGameState, player: number): number {
  const lands = (state.battlefields[player] ?? []).filter((card) =>
    isLandCard(state, player, card)
  ).length;
  return lands + (state.artifactMana[player] ?? 0);
}

function formatAction(action: SimAction): string {
  if ("card" in action) return `${action.type}:${action.card}`;
  if (action.type === "DECLARE_ATTACKERS") return `${action.type}:${action.attackers.length}`;
  if (action.type === "DECLARE_BLOCKERS") return `${action.type}:${action.assignments.length}`;
  return action.type;
}

function isMain1(state: SimGameState): boolean {
  return state.phase === "Prima Fase Principale" || state.phaseStep === "Prima Fase Principale";
}

function isMain2(state: SimGameState): boolean {
  return state.phase === "Seconda Fase Principale" || state.phaseStep === "Seconda Fase Principale";
}

function isCombat(state: SimGameState): boolean {
  return state.phase === "Fase di Combattimento";
}

function metricRow(label: string, a: number, b: number, higherIsBetter: boolean): string {
  const delta = b - a;
  const direction =
    Math.abs(delta) < 0.0001
      ? "flat"
      : delta > 0 === higherIsBetter
        ? "better"
        : "worse";
  return `| ${label} | ${fmt(a)} | ${fmt(b)} | ${fmt(delta)} | ${direction} |`;
}

function formatDistribution(distribution: Record<string, number>): string {
  const total = Object.values(distribution).reduce((sum, value) => sum + value, 0);
  if (total === 0) return "no detectable target data";
  return Object.entries(distribution)
    .sort((left, right) => right[1] - left[1])
    .map(([target, count]) => `${target}=${count} (${pct(count / total)})`)
    .join(", ");
}

function formatAnomalies(anomalies: EvaluationAnomaly[]): string {
  if (!anomalies.length) return "No anomalies captured.";
  return anomalies
    .map((anomaly, idx) =>
      `${idx + 1}. ${anomaly.type} game=${anomaly.gameIndex} player=${anomaly.playerIndex} ` +
      `turn=${anomaly.turn} phase="${anomaly.state.phaseStep}" action=${anomaly.chosenAction} ` +
      `source=${anomaly.source ?? "n/a"} confidence=${fmt(anomaly.confidence ?? 0)} ` +
      `visits=${anomaly.visits ?? 0} reward=${fmt(anomaly.nextReward)}`
    )
    .join("\n");
}

function formatWeakBehaviors(current: FinalizedEvaluation): string {
  const candidates = [
    { label: `Heuristic fallback remains high: ${pct(current.heuristicFallbackRate)}`, score: current.heuristicFallbackRate },
    { label: `Exact policy coverage is low: ${pct(current.exactPolicyHitRate)}`, score: 1 - current.exactPolicyHitRate },
    { label: `PASS_TURN rate is high: ${pct(current.passTurnRate)}`, score: current.passTurnRate },
    { label: `Unused mana at pass: ${fmt(current.manaUnusedAtPass)}`, score: current.manaUnusedAtPass / 10 },
    { label: `Lethal missed count: ${current.lethalMissed}`, score: current.lethalMissed / Math.max(1, current.games) },
    { label: `Combat losses per player-game: ${fmt(current.averageCreaturesLostInCombat)}`, score: current.averageCreaturesLostInCombat / 5 },
  ];
  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((entry, idx) => `${idx + 1}. ${entry.label}`)
    .join("\n");
}

function formatRecommendations(current: FinalizedEvaluation): string {
  const recommendations = [
    current.exactPolicyHitRate < 0.1
      ? "Increase policy coverage by exporting/loading the trained DB/file policy used by live games."
      : "Audit low-confidence fuzzy matches and promote stable exact records for common early-game states.",
    current.heuristicFallbackRate > 0.5
      ? "Prioritize data collection for high-frequency heuristic fallback states before changing weights."
      : "Use anomaly samples to tune only the narrow fallback states still dominating mistakes.",
    current.manaUnusedAtPass > 2
      ? "Add a mana-use audit around Main 2 pass decisions with interaction-aware exceptions."
      : "Focus next on combat/target selection examples where lethal or profitable attacks are missed.",
  ];
  return recommendations.map((entry, idx) => `${idx + 1}. ${entry}`).join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "0.000";
}
