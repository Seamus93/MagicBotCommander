import type {
  AttackDecision,
  AgentDecision,
  AiActionEvaluationTrace,
  AiConsideredActionTrace,
  AiDecisionRejectionReason,
  AiDecisionTrace,
  BlockAssignment,
  BlockDecision,
  CardName,
  CostDescriptor,
  DeckInitAudit,
  DeckCardMetadata,
  DecisionMetadata,
  GameEvent,
  PermanentState,
  ParsedAbility,
  RulesEvent,
  SimAction,
  SimAgent,
  SimGameState,
  SimulationOptions,
  SimulationResult,
  StackEntry,
  TemporaryEffect,
  ManaCost,
  ManaPaymentPlan,
  SimulationDiagnostics,
  TargetRef,
  TargetRequirementTrace,
} from "@game-state/types";
import { shouldMulligan, chooseBottomCards } from "./mulliganEvaluator.js";
import type { CreaturePermanent } from "@rules/combat/types";
import { isLearningAgent } from "./learningAgent.js";
import {
  captureSnapshot,
  shapeReward,
  discountRewards,
  terminalRewardForPlayer,
  REWARD_SHAPING_ENABLED,
  REWARD_GAMMA,
  type StateSnapshot,
} from "./rewardShaper.js";
import {
  availableAttackers,
  availableBlockers,
  readyCreaturesForTurn,
  resolveCombat,
  summonCreature,
  createTokenPermanent,
  destroyCreature,
} from "../../rules/src/combat/combat.js";
import {
  getCreatureBlueprint,
  isCreatureCard,
} from "../../rules/src/combat/library.js";
import {
  getCardMetadata,
  isLandCard,
  isArtifactCard,
  isPermanentCard,
  isCastableSpellCard,
  getLandFaceMetadata,
  getSpellFaceMetadata,
  getLandPermanentName,
  getSpellPermanentName,
  evaluateLandEntryTapped,
  landEntryChoices,
  activeFaceMetadata,
  metadataForSelectedFace,
  resolveSelectedFace,
  selectedFaceIdForAction,
  normalizeCardName,
  hasFlash,
  isInstantLike,
  isSorceryLike,
  getAvailableInstants,
  isCounterspell,
  manaCostFromMetadata,
  reduceGenericManaCost,
  findManaPaymentPlan as findManaPaymentPlanRaw,
  applyManaPaymentPlan,
  traceManaSourcesForPlayer,
} from "../../game-state/src/cardUtils.js";
import {
  handleLandEntered,
  handlePermanentEntersBattlefield,
} from "../../rules/src/effects/abilityManager.js";
import {
  generateAttackPlans,
  generateBlockPlans,
  type AttackPlan,
  type BlockPlan,
} from "./combatEvaluator.js";
import { parseCardRules as parseCardRulesRaw } from "./oraclePatternRegistry.js";
import {
  currentDecisionOperation,
  decisionExternalPauseMs,
  decisionTelemetrySnapshot,
  resetDecisionTimings,
} from "./decisionProfiler.js";

const DEFAULT_DECK = [
  ...Array(18).fill("Basic Land"),
  ...Array(8).fill("Burn Spell"),
  ...Array(8).fill("Wild Beast"),
  ...Array(6).fill("Titanic Ogre"),
];

const DEFAULT_ENABLE_STACK = process.env.ENABLE_STACK === "true";
const MAX_TARGET_ACTIONS_PER_ABILITY = Math.max(
  1,
  Number(process.env.MAX_TARGET_ACTIONS_PER_ABILITY ?? 20)
);

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

interface TurnStepConfig {
  phase: string;
  step: string;
  allowInstant?: boolean;
  allowSorcery?: boolean;
  allowLand?: boolean;
  auto?: (state: SimGameState, player: number, log: (msg: string) => void) => void;
  type?: "combat";
}

const TURN_STRUCTURE: TurnStepConfig[] = [
  {
    phase: "Fase Iniziale",
    step: "Sottofase di STAP",
    auto: (state, player) => {
      readyCreaturesForTurn(state, player);
      state.manaSpent[player] = 0;
      untapPermanentsForTurn(state, player);
    },
  },
  {
    phase: "Fase Iniziale",
    step: "Sottofase di Mantenimento",
    allowInstant: true,
  },
  {
    phase: "Fase Iniziale",
    step: "Sottofase di Acquisizione",
    auto: (state, player) => drawCard(state, player),
    allowInstant: true,
  },
  {
    phase: "Prima Fase Principale",
    step: "Prima Fase Principale",
    allowInstant: true,
    allowSorcery: true,
    allowLand: true,
  },
  {
    phase: "Fase di Combattimento",
    step: "Sottofase di Inizio Combattimento",
    allowInstant: true,
  },
  {
    phase: "Fase di Combattimento",
    step: "Sottofase di Dichiarazione delle Creature Attaccanti",
    type: "combat",
  },
  {
    phase: "Fase di Combattimento",
    step: "Sottofase di Fine Combattimento",
    allowInstant: true,
  },
  {
    phase: "Seconda Fase Principale",
    step: "Seconda Fase Principale",
    allowInstant: true,
    allowSorcery: true,
    allowLand: true,
  },
  {
    phase: "Fase Finale",
    step: "Sottofase Finale",
    allowInstant: true,
  },
  {
    phase: "Fase Finale",
    step: "Sottofase di Cancellazione",
    auto: (state, player, log) => enforceHandSizeLimit(state, player, log),
  },
];

const MAX_ACTIONS_PER_WINDOW = 4;

class EpisodeAbort extends Error {
  constructor(
    public readonly reason: string,
    public readonly diagnostics?: SimulationDiagnostics
  ) {
    super(reason);
    this.name = "EpisodeAbort";
  }
}

interface DiagnosticContext {
  enabled: boolean;
  debugEpisode: boolean;
  startedAt: number;
  lastWatchdogCheckMs: number;
  externalPauseMs: number;
  limits: {
    maxEpisodeMs: number;
    maxActionsPerEpisode: number;
    maxPriorityIterations: number;
    maxStackResolutions: number;
    maxIdenticalStateRepeats: number;
  };
  data: SimulationDiagnostics;
  actionWindowTotal: number;
  actionWindowCount: number;
  activateActionWindowTotal: number;
  activateActionWindowCount: number;
  currentTurn: number;
  currentTurnActions: number;
  fingerprintCounts: Map<string, number>;
  stackTrace: string[];
  stackStormRecorded: boolean;
}

let activeDiagnostics: DiagnosticContext | null = null;

const envNumber = (name: string, fallback: number) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function createDiagnosticContext(): DiagnosticContext {
  const startedAt = performance.now();
  return {
    enabled: true,
    debugEpisode: process.env.DEBUG_EPISODE === "true",
    startedAt,
    lastWatchdogCheckMs: startedAt,
    externalPauseMs: 0,
    limits: {
      maxEpisodeMs: envNumber("MAX_EPISODE_MS", 120_000),
      maxActionsPerEpisode: envNumber("MAX_ACTIONS_PER_EPISODE", 2_000),
      maxPriorityIterations: envNumber("MAX_PRIORITY_ITERATIONS", 2_000),
      maxStackResolutions: envNumber("MAX_STACK_RESOLUTIONS", 500),
      maxIdenticalStateRepeats: envNumber("MAX_IDENTICAL_STATE_REPEATS", 20),
    },
    data: {
      actionsApplied: 0,
      maxAvailableActions: 0,
      avgAvailableActions: 0,
      actionWindows: 0,
      windowsOver50Actions: 0,
      windowsOver100Actions: 0,
      stackPushes: 0,
      stackResolutions: 0,
      priorityPasses: 0,
      responsesGenerated: 0,
      maxStackDepth: 0,
      maxPriorityIterationsPerWindow: 0,
      maxActionsPerTurn: 0,
      avgActivateActions: 0,
      activateActionWindows: 0,
      maxActivateActions: 0,
      repeatedStateAborts: 0,
      priorityIterationAborts: 0,
      stackResolutionAborts: 0,
      actionLimitAborts: 0,
      timeLimitAborts: 0,
      topActionWindows: [],
      recentActions: [],
      timingsMs: {},
      decisionCounters: {},
      decisionSamples: {},
      recentStateTransitions: [],
      aiDecisionLogs: [],
      aiDecisionTraces: [],
      stackStorms: [],
      stackEntryMissingIdentity: 0,
    },
    actionWindowTotal: 0,
    actionWindowCount: 0,
    activateActionWindowTotal: 0,
    activateActionWindowCount: 0,
    currentTurn: 0,
    currentTurnActions: 0,
    fingerprintCounts: new Map(),
    stackTrace: [],
    stackStormRecorded: false,
  };
}

function timeBlock<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const diagnostics = activeDiagnostics;
    if (diagnostics) {
      diagnostics.data.timingsMs[name] = (diagnostics.data.timingsMs[name] ?? 0) + performance.now() - start;
    }
  }
}

async function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const elapsed = performance.now() - start;
    const diagnostics = activeDiagnostics;
    if (diagnostics) {
      diagnostics.data.timingsMs[name] = (diagnostics.data.timingsMs[name] ?? 0) + elapsed;
      if (name === "AI chooseAction") {
        const samples = diagnostics.data.decisionSamples ?? {};
        const bucket = samples.chooseActionMs ?? [];
        bucket.push(elapsed);
        samples.chooseActionMs = bucket;
        diagnostics.data.decisionSamples = samples;
      }
    }
  }
}

function parseCardRules(metadata: DeckCardMetadata) {
  return timeBlock("parseCardRules", () => parseCardRulesRaw(metadata));
}

function findManaPaymentPlan(state: SimGameState, player: number, cost: ManaCost) {
  return timeBlock("findManaPaymentPlan", () => findManaPaymentPlanRaw(state, player, cost));
}

type TokenCountDescriptor =
  | { type: "fixed"; value: number }
  | { type: "selfCreatures" }
  | { type: "opponentCreatures" }
  | { type: "opponentsTotalCreatures" }
  | { type: "lifeTotal" };

interface TokenEffectDescriptor {
  count: TokenCountDescriptor;
  power: number;
  toughness: number;
  name?: string;
}

const cloneState = (state: SimGameState): SimGameState =>
  JSON.parse(JSON.stringify(state));

function actionSummary(action?: SimAction | null) {
  if (!action) return "none";
  if (action.type === "PLAY_LAND") {
    const face = selectedFaceIdForAction(action);
    const choice = action.entryChoice
      ? action.entryChoice.type === "PAY_LIFE"
        ? ` payLife=${action.entryChoice.amount}`
        : " declineEntryCost"
      : "";
    return `PLAY_LAND ${action.card}${face ? ` face=${face}` : ""}${choice}`;
  }
  if (action.type === "CAST_SPELL") {
    const targets = action.targets?.map((target) => `${target.type}:${target.id}`).join(",") ??
      action.targetId ?? action.targetPlayer ?? action.targetGraveyardCard ?? action.targetStackId ?? "";
    return `CAST ${action.card}${action.modes?.length ? ` mode=${action.modes.join("+")}` : ""}${targets ? ` target=${targets}` : ""}`;
  }
  if (action.type === "ACTIVATE_ABILITY") {
    const targets = action.targets?.map((target) => `${target.type}:${target.id}`).join(",") ?? "";
    return `ACTIVATE ${action.sourcePermanentId} ability=${action.abilityId}${targets ? ` target=${targets}` : ""}`;
  }
  if (action.type === "RESOLVE_CHOICE") {
    return `${action.type} ${action.choiceType} ${action.card}`;
  }
  if ("card" in action) return `${action.type} ${action.card}`;
  return action.type;
}

function faceTraceFields(
  state: SimGameState,
  player: number,
  card: CardName,
  selectedFaceId?: string
) {
  const metadata = getCardMetadata(state, player, card);
  const selectedFace = resolveSelectedFace(metadata, selectedFaceId);
  return {
    physicalCard: metadata?.name ?? card,
    selectedFaceId,
    selectedFaceName: selectedFace?.name ?? selectedFaceId,
    selectedFaceTypeLine: selectedFace?.typeLine,
  };
}

function legalActionSummary(actions: SimAction[], limit = 12) {
  const summary = actions.slice(0, limit).map(actionSummary);
  if (actions.length > limit) summary.push(`...+${actions.length - limit} more`);
  return summary;
}

function compactFingerprint(
  state: SimGameState,
  options: { priorityPlayer?: number; action?: SimAction | null } = {}
) {
  const permanentCounts = (state.permanents ?? []).map((items) => items?.length ?? 0).join(",");
  return [
    `t=${state.turn}`,
    `ph=${state.phaseStep || state.phase}`,
    `ap=${state.playerIndex}`,
    `pp=${options.priorityPlayer ?? "-"}`,
    `sd=${state.stack.length}`,
    `h=${state.hands.map((hand) => hand.length).join(",")}`,
    `p=${permanentCounts}`,
    `l=${state.lifeTotals.join(",")}`,
    `a=${actionSummary(options.action)}`,
  ].join("|");
}

function canonicalStateFingerprint(state: SimGameState, priorityPlayer?: number) {
  return compactFingerprint(state, { priorityPlayer });
}

function recordRecentAction(state: SimGameState, action: SimAction, prefix = "") {
  const diagnostics = activeDiagnostics;
  if (!diagnostics) return;
  const line = `${prefix}T${state.turn} ${state.phaseStep || state.phase} P${state.playerIndex} ${actionSummary(action)} stack=${state.stack.length}`;
  diagnostics.data.recentActions.push(line);
  if (diagnostics.data.recentActions.length > 30) diagnostics.data.recentActions.shift();
}

function recordStateTransition(before: string, after: string, action: SimAction) {
  const diagnostics = activeDiagnostics;
  if (!diagnostics) return;
  diagnostics.data.recentStateTransitions ??= [];
  diagnostics.data.recentStateTransitions.push(`${actionSummary(action)} :: ${before} -> ${after}`);
  if (diagnostics.data.recentStateTransitions.length > 10) {
    diagnostics.data.recentStateTransitions.shift();
  }
}

function telemetryDelta(
  before: ReturnType<typeof decisionTelemetrySnapshot>,
  after: ReturnType<typeof decisionTelemetrySnapshot>
) {
  const timingDelta = (predicate: (key: string) => boolean) =>
    Object.entries(after.timingsMs)
      .filter(([key]) => predicate(key))
      .reduce((sum, [key, value]) => sum + value - (before.timingsMs[key] ?? 0), 0);
  const sampleDelta = (name: string) =>
    Math.max(0, (after.samples[name]?.length ?? 0) - (before.samples[name]?.length ?? 0));
  const sampleValueDelta = (name: string) => {
    const previousLength = before.samples[name]?.length ?? 0;
    return (after.samples[name] ?? [])
      .slice(previousLength)
      .reduce((sum, value) => sum + value, 0);
  };
  return {
    dbLookupMs: Math.max(0, timingDelta((key) => key.includes("lookup"))),
    candidatesScanned: sampleValueDelta("fuzzyCandidates"),
    candidatesReturned: sampleValueDelta("fuzzyCappedCandidates"),
    fuzzyLookups: sampleDelta("fuzzyCandidates"),
  };
}

function recordDecisionLog(options: {
  state: SimGameState;
  player: number;
  availableActions: number;
  action: SimAction;
  beforeDecisionTelemetry: ReturnType<typeof decisionTelemetrySnapshot>;
  decisionElapsedMs: number;
  rulesEngineMs: number;
  beforeCanonicalState: string;
}) {
  const diagnostics = activeDiagnostics;
  if (!diagnostics) return;
  const afterDecisionTelemetry = decisionTelemetrySnapshot();
  const delta = telemetryDelta(options.beforeDecisionTelemetry, afterDecisionTelemetry);
  const afterCanonicalState = canonicalStateFingerprint(options.state);
  const stateChanged = options.beforeCanonicalState !== afterCanonicalState;
  recordStateTransition(options.beforeCanonicalState, afterCanonicalState, options.action);
  diagnostics.data.aiDecisionLogs ??= [];
  diagnostics.data.aiDecisionLogs.push({
    player: options.player,
    turn: options.state.turn,
    phase: options.state.phaseStep || options.state.phase,
    legalActions: options.availableActions,
    dbRetrievalMs: delta.dbLookupMs,
    policyInferenceMs: Math.max(0, options.decisionElapsedMs - delta.dbLookupMs),
    rulesEngineMs: options.rulesEngineMs,
    totalDecisionMs: options.decisionElapsedMs + options.rulesEngineMs,
    dbCandidatesScanned: delta.candidatesScanned,
    dbCandidatesReturned: delta.candidatesReturned,
    stateChanged,
    action: actionSummary(options.action),
  });
  if (diagnostics.data.aiDecisionLogs.length > 500) {
    diagnostics.data.aiDecisionLogs.shift();
  }
  const threshold = envNumber("AI_PERF_LOG_THRESHOLD_MS", 50);
  if (diagnostics.debugEpisode || options.decisionElapsedMs + options.rulesEngineMs >= threshold) {
    const latest = diagnostics.data.aiDecisionLogs[diagnostics.data.aiDecisionLogs.length - 1];
    console.log(
      `[AI DECISION] player=P${latest.player} turn=${latest.turn} phase=${latest.phase} legal_actions=${latest.legalActions} ` +
      `db_retrieval_ms=${latest.dbRetrievalMs.toFixed(1)} policy_inference_ms=${latest.policyInferenceMs.toFixed(1)} ` +
      `rules_engine_ms=${latest.rulesEngineMs.toFixed(1)} total_ms=${latest.totalDecisionMs.toFixed(1)} ` +
      `db_candidates_scanned=${latest.dbCandidatesScanned} db_candidates_returned=${latest.dbCandidatesReturned} ` +
      `state_changed=${latest.stateChanged} action=${latest.action}`
    );
  }
}

function diagnosticDump(state: SimGameState, reason: string) {
  const diagnostics = activeDiagnostics;
  const data = diagnostics?.data;
  const topTimings = Object.entries(data?.timingsMs ?? {})
    .sort(([, left], [, right]) => right - left)
    .slice(0, 8)
    .map(([key, value]) => `${key}=${value.toFixed(1)}ms`)
    .join(" ");
  const currentOperation = currentDecisionOperation();
  const lastWindow = data?.lastActionWindow;
  const episodePerf = data?.episodePerf;
  const decisions = data?.aiDecisionLogs ?? [];
  const totalDecisionMs = decisions.reduce((sum, decision) => sum + decision.totalDecisionMs, 0);
  const totalRulesMs = decisions.reduce((sum, decision) => sum + decision.rulesEngineMs, 0);
  const totalDbMs = decisions.reduce((sum, decision) => sum + decision.dbRetrievalMs, 0);
  return [
    reason === "STALL_LOOP" ? `[STALL] ${reason}` : `[watchdog] ${reason}`,
    `state ${compactFingerprint(state)}`,
    `turn=${state.turn} phase=${state.phaseStep || state.phase} active=P${state.playerIndex} sameStateRepeats=${data?.sameStateRepetitionCount ?? data?.lastFingerprintRepeats ?? 0}`,
    lastWindow
      ? `lastLegalActions player=P${lastWindow.player} total=${lastWindow.total} stack=${lastWindow.stackDepth} actions=${JSON.stringify(lastWindow.legalActions)}`
      : "lastLegalActions none",
    `currentOperation=${currentOperation?.name ?? "none"} elapsedOperationMs=${currentOperation?.elapsedMs.toFixed(1) ?? "0.0"}`,
    `actions=${data?.actionsApplied ?? 0} stackPushes=${data?.stackPushes ?? 0} stackResolutions=${data?.stackResolutions ?? 0} priorityPasses=${data?.priorityPasses ?? 0}`,
    `maxActions=${data?.maxAvailableActions ?? 0} maxActionsPerTurn=${data?.maxActionsPerTurn ?? 0} maxStack=${data?.maxStackDepth ?? 0} maxPriorityIterations=${data?.maxPriorityIterationsPerWindow ?? 0}`,
    episodePerf
      ? `[EPISODE PERF] game_ms=${episodePerf.gameMs.toFixed(1)} ai_ms=${episodePerf.aiMs.toFixed(1)} db_ms=${episodePerf.dbMs.toFixed(1)} engine_ms=${episodePerf.engineMs.toFixed(1)} actions=${episodePerf.actions} turns=${episodePerf.turns}`
      : "[EPISODE PERF] unavailable",
    `[EPISODE TOTALS] total_ai_decision_ms=${totalDecisionMs.toFixed(1)} total_db_retrieval_ms=${totalDbMs.toFixed(1)} total_engine_ms=${totalRulesMs.toFixed(1)} decisions=${decisions.length} actions=${data?.actionsApplied ?? 0} priority_passes=${data?.priorityPasses ?? 0} same_state_repetitions=${data?.sameStateRepetitionCount ?? 0}`,
    `timings ${topTimings || "none"}`,
    `lastDecisions:\n${decisions.slice(-10).map((decision) =>
      `T${decision.turn} ${decision.phase} P${decision.player} legal=${decision.legalActions} db=${decision.dbRetrievalMs.toFixed(1)}ms policy=${decision.policyInferenceMs.toFixed(1)}ms rules=${decision.rulesEngineMs.toFixed(1)}ms total=${decision.totalDecisionMs.toFixed(1)}ms scanned=${decision.dbCandidatesScanned} returned=${decision.dbCandidatesReturned} changed=${decision.stateChanged} action=${decision.action}`
    ).join("\n")}`,
    `lastStateTransitions:\n${(data?.recentStateTransitions ?? []).slice(-10).join("\n")}`,
    `recent:\n${(data?.recentActions ?? []).slice(-30).join("\n")}`,
  ].join("\n");
}

function updateEpisodePerf(state: SimGameState) {
  const diagnostics = activeDiagnostics;
  if (!diagnostics) return;
  const timings = diagnostics.data.timingsMs;
  const decisionTelemetry = decisionTelemetrySnapshot();
  const decisionTimings = decisionTelemetry.timingsMs;
  const aiMs =
    (timings["AI chooseAction"] ?? 0) +
    (timings["AI chooseAttackers"] ?? 0) +
    (timings["AI chooseBlockers"] ?? 0);
  const dbMs = Object.entries(decisionTimings)
    .filter(([key]) => key.includes("lookup"))
    .reduce((sum, [, value]) => sum + value, 0);
  const gameMs = performance.now() - diagnostics.startedAt - Math.max(diagnostics.externalPauseMs, decisionTelemetry.externalPauseMs);
  diagnostics.data.episodePerf = {
    gameMs,
    aiMs,
    dbMs,
    engineMs: Math.max(0, gameMs - aiMs),
    actions: diagnostics.data.actionsApplied,
    turns: state.turn,
  };
}

function attachDecisionTelemetry(diagnostics: SimulationDiagnostics) {
  const decisionTelemetry = decisionTelemetrySnapshot();
  for (const [key, value] of Object.entries(decisionTelemetry.timingsMs)) {
    diagnostics.timingsMs[key] = (diagnostics.timingsMs[key] ?? 0) + value;
  }
  diagnostics.decisionCounters = {
    ...(diagnostics.decisionCounters ?? {}),
    ...decisionTelemetry.counters,
  };
  diagnostics.decisionSamples = {
    ...(diagnostics.decisionSamples ?? {}),
    ...decisionTelemetry.samples,
  };
  diagnostics.decisionOperationBreakdowns = decisionTelemetry.operationBreakdowns;
}

function abortEpisode(state: SimGameState, reason: string): never {
  const diagnostics = activeDiagnostics;
  if (diagnostics) {
    updateEpisodePerf(state);
    diagnostics.data.aborted = true;
    diagnostics.data.abortReason = reason;
    diagnostics.data.abortDump = diagnosticDump(state, reason);
    if (reason === "MAX_EPISODE_MS") diagnostics.data.timeLimitAborts++;
    if (reason === "MAX_ACTIONS_PER_EPISODE") diagnostics.data.actionLimitAborts++;
    if (reason === "MAX_STACK_RESOLUTIONS") diagnostics.data.stackResolutionAborts++;
    if (reason === "STALL_LOOP") diagnostics.data.repeatedStateAborts++;
    if (reason === "MAX_PRIORITY_ITERATIONS") diagnostics.data.priorityIterationAborts++;
    attachDecisionTelemetry(diagnostics.data);
  }
  throw new EpisodeAbort(reason, diagnostics?.data);
}

function checkEpisodeWatchdog(state: SimGameState, _action?: SimAction | null, priorityPlayer?: number) {
  const diagnostics = activeDiagnostics;
  if (!diagnostics) return;
  const now = performance.now();
  const watchdogGapMs = envNumber("EPISODE_MONOTONIC_GAP_MS", 5_000);
  const gap = now - diagnostics.lastWatchdogCheckMs;
  diagnostics.lastWatchdogCheckMs = now;
  if (gap > watchdogGapMs) {
    diagnostics.externalPauseMs += gap;
    diagnostics.data.decisionCounters ??= {};
    diagnostics.data.decisionCounters.monotonicGapDetected =
      (diagnostics.data.decisionCounters.monotonicGapDetected ?? 0) + 1;
    diagnostics.data.timingsMs["AI external pause"] =
      (diagnostics.data.timingsMs["AI external pause"] ?? 0) + gap;
  }
  const elapsedEpisodeMs = now - diagnostics.startedAt - Math.max(diagnostics.externalPauseMs, decisionExternalPauseMs());
  if (elapsedEpisodeMs > diagnostics.limits.maxEpisodeMs) {
    abortEpisode(state, "MAX_EPISODE_MS");
  }
  if (diagnostics.data.actionsApplied > diagnostics.limits.maxActionsPerEpisode) {
    abortEpisode(state, "MAX_ACTIONS_PER_EPISODE");
  }
  const fingerprint = canonicalStateFingerprint(state, priorityPlayer);
  const count = (diagnostics.fingerprintCounts.get(fingerprint) ?? 0) + 1;
  diagnostics.fingerprintCounts.set(fingerprint, count);
  diagnostics.data.lastFingerprintRepeats = count;
  diagnostics.data.sameStateRepetitionCount = count;
  if (count > diagnostics.limits.maxIdenticalStateRepeats) {
    abortEpisode(state, "STALL_LOOP");
  }
}

function recordActionWindow(state: SimGameState, player: number, actions: SimAction[]) {
  const diagnostics = activeDiagnostics;
  if (!diagnostics) return;
  const cast = actions.filter((action) => action.type === "CAST_SPELL").length;
  const activate = actions.filter((action) => action.type === "ACTIVATE_ABILITY").length;
  const pass = actions.filter((action) => action.type === "PASS_TURN").length;
  const targetCombos = actions.filter((action) => "targets" in action && Boolean(action.targets?.length)).length;
  const modeCombos = actions.filter((action) => "modes" in action && Boolean(action.modes?.length)).length;
  diagnostics.actionWindowTotal += actions.length;
  diagnostics.actionWindowCount += 1;
  diagnostics.data.avgAvailableActions = diagnostics.actionWindowTotal / Math.max(1, diagnostics.actionWindowCount);
  diagnostics.data.actionWindows = diagnostics.actionWindowCount;
  diagnostics.data.maxAvailableActions = Math.max(diagnostics.data.maxAvailableActions, actions.length);
  diagnostics.data.lastActionWindow = {
    turn: state.turn,
    phase: state.phaseStep || state.phase,
    player,
    legalActions: legalActionSummary(actions),
    total: actions.length,
    stackDepth: state.stack.length,
  };
  diagnostics.activateActionWindowTotal += activate;
  diagnostics.activateActionWindowCount += 1;
  diagnostics.data.avgActivateActions = diagnostics.activateActionWindowTotal / Math.max(1, diagnostics.activateActionWindowCount);
  diagnostics.data.activateActionWindows = diagnostics.activateActionWindowCount;
  diagnostics.data.maxActivateActions = Math.max(diagnostics.data.maxActivateActions, activate);
  if (actions.length > 50) diagnostics.data.windowsOver50Actions++;
  if (actions.length > 100) diagnostics.data.windowsOver100Actions++;
  const byCard = new Map<string, number>();
  for (const action of actions) {
    const key = action.type === "CAST_SPELL"
      ? `CAST:${action.card}`
      : action.type === "ACTIVATE_ABILITY"
        ? `ACTIVATE:${action.sourcePermanentId}:${action.abilityId}`
        : action.type;
    byCard.set(key, (byCard.get(key) ?? 0) + 1);
  }
  const record = {
    turn: state.turn,
    phase: state.phaseStep || state.phase,
    player,
    total: actions.length,
    cast,
    activate,
    pass,
    targetCombos,
    modeCombos,
    topCards: [...byCard.entries()]
      .sort(([, left], [, right]) => right - left)
      .slice(0, 5)
      .map(([key, count]) => ({ key, count })),
  };
  diagnostics.data.topActionWindows.push(record);
  diagnostics.data.topActionWindows.sort((left, right) => right.total - left.total);
  diagnostics.data.topActionWindows = diagnostics.data.topActionWindows.slice(0, 10);
  if (diagnostics.debugEpisode) {
    console.log(`[debug] T${state.turn} ${record.phase} P${player} actions=${record.total} cast=${cast} activate=${activate} stack=${state.stack.length}`);
  }
}

// Phase 2 — parallel snapshot array, kept in sync with history[]
interface StepSnapshotEntry {
  playerIndex: number;
  prevSnapshot: StateSnapshot;
  nextSnapshot: StateSnapshot;
  action: SimAction;
}

interface TurnContext {
  landDropsUsedThisTurn: number;
  maxLandDrops: number;
  secondMainLandDropAvailable: boolean;
  lastSecondMainActionCount: number;
}

function recordStackTrace(state: SimGameState, event: "push" | "resolve", entry: StackEntry) {
  const diagnostics = activeDiagnostics;
  if (!diagnostics) return;
  const sourceCard = entry.sourceCard ?? (entry.action.type === "CAST_SPELL" ? entry.action.card : entry.action.type);
  const patternId = entry.ability?.patternId ?? entry.ability?.abilityId ?? "";
  const abilityLabel = (entry.abilityId ?? entry.patternId ?? patternId) || "-";
  const missingIdentity = !entry.sourceCard || !(entry.abilityId ?? entry.patternId ?? entry.ability?.patternId);
  if (missingIdentity) diagnostics.data.stackEntryMissingIdentity = (diagnostics.data.stackEntryMissingIdentity ?? 0) + 1;
  diagnostics.stackTrace.push(
    `${event} id=${entry.id} depth=${state.stack.length} kind=${entry.kind ?? "spell"} source=${sourceCard ?? "unknown"} sourceId=${entry.sourcePermanentId ?? "-"} ability=${abilityLabel} triggerEvent=${entry.triggeringEventId ?? "-"} event=${entry.eventType ?? "-"} turn=${entry.turn ?? state.turn} phase=${entry.phase ?? state.phaseStep ?? state.phase} action=${actionSummary(entry.action)}`
  );
  if (diagnostics.stackTrace.length > 30) diagnostics.stackTrace.shift();
}

function maybeRecordStackStorm(state: SimGameState, entry: StackEntry) {
  const diagnostics = activeDiagnostics;
  if (!diagnostics || diagnostics.stackStormRecorded || diagnostics.data.stackResolutions <= 100) return;
  diagnostics.stackStormRecorded = true;
  diagnostics.data.stackStorms ??= [];
  diagnostics.data.stackStorms.push({
    sourceCard: entry.sourceCard ?? (entry.action.type === "CAST_SPELL" ? entry.action.card : undefined),
    sourcePermanentId: entry.sourcePermanentId,
    triggerPatternId: entry.patternId ?? entry.ability?.patternId ?? entry.ability?.abilityId,
    triggeringEventId: entry.triggeringEventId,
    eventType: entry.kind,
    stackDepth: state.stack.length,
    trace: diagnostics.stackTrace.slice(-30),
  });
}

let permanentCounter = 0;
let rulesEventCounter = 0;
const nextPermanentId = () => `perm_${++permanentCounter}`;
const nextRulesEventId = () => `event_${++rulesEventCounter}`;

function ensurePermanentZones(state: SimGameState) {
  state.permanents ??= Array.from({ length: state.lifeTotals.length }, () => []);
  for (let i = 0; i < state.lifeTotals.length; i++) {
    state.permanents[i] ??= [];
  }
}

function addPermanentState(
  state: SimGameState,
  options: {
    cardName: CardName;
    owner: number;
    controller: number;
    face?: string;
    tapped?: boolean;
    token?: boolean;
    summoningSickness?: boolean;
  }
): PermanentState {
  ensurePermanentZones(state);
  const permanent: PermanentState = {
    id: nextPermanentId(),
    cardName: options.cardName,
    owner: options.owner,
    controller: options.controller,
    face: options.face,
    tapped: options.tapped ?? false,
    token: options.token,
    counters: {},
    damageMarked: 0,
    summoningSickness: options.summoningSickness,
  };
  state.permanents![options.controller].push(permanent);
  return permanent;
}

function removePermanentState(
  state: SimGameState,
  controller: number,
  cardOrFace: CardName
) {
  const normalized = cardOrFace.toLowerCase();
  const list = state.permanents?.[controller];
  if (!list) return;
  const index = list.findIndex(
    (permanent) =>
      permanent.cardName.toLowerCase() === normalized ||
      permanent.face?.toLowerCase() === normalized
  );
  if (index >= 0) list.splice(index, 1);
}

function removePermanentStateById(
  state: SimGameState,
  controller: number,
  permanentId: string
): PermanentState | null {
  const list = state.permanents?.[controller];
  if (!list) return null;
  const index = list.findIndex((permanent) => permanent.id === permanentId);
  if (index < 0) return null;
  return list.splice(index, 1)[0] ?? null;
}

export function tapPermanent(state: SimGameState, player: number, card: CardName) {
  const key = card.trim().toLowerCase();
  if (!key) return;
  const permanent = state.permanents?.[player]?.find(
    (candidate) =>
      !candidate.tapped &&
      (candidate.face?.toLowerCase() === key ||
        candidate.cardName.toLowerCase() === key)
  );
  if (permanent) {
    permanent.tapped = true;
    return;
  }
  state.tappedPermanents ??= {};
  state.tappedPermanents[player] ??= {};
  state.tappedPermanents[player][key] =
    (state.tappedPermanents[player][key] ?? 0) + 1;
}

export function untapPermanentsForTurn(state: SimGameState, player: number) {
  state.tappedPermanents ??= {};
  state.tappedPermanents[player] = {};
  for (const permanent of state.permanents?.[player] ?? []) {
    if (permanent.skipUntapUntilTurn !== undefined && permanent.skipUntapUntilTurn <= state.turn) {
      delete permanent.skipUntapUntilTurn;
      permanent.damageMarked = 0;
      if (permanent.summoningSickness) permanent.summoningSickness = false;
      continue;
    }
    permanent.tapped = false;
    permanent.damageMarked = 0;
    if (permanent.summoningSickness) permanent.summoningSickness = false;
  }
}

function emitRulesEvent(state: SimGameState, event: RulesEvent) {
  state.rulesEvents ??= [];
  state.rulesEvents.push(event);
}

function ensureRulesEventIdentity(event: RulesEvent): RulesEvent {
  return event.eventId ? event : { ...event, eventId: nextRulesEventId() };
}

export function dispatchRulesEvent(
  state: SimGameState,
  event: RulesEvent,
  log: (msg: string) => void,
  metadata?: DeckCardMetadata
) {
  const identifiedEvent = ensureRulesEventIdentity(event);
  const enrichedEvent = metadata
    ? {
        ...identifiedEvent,
        data: {
          ...(identifiedEvent.data ?? {}),
          sourceTypeLine: metadata.typeLine ?? "",
          sourceIsCreature: metadata.isCreature ?? (metadata.typeLine ?? "").toLowerCase().includes("creature"),
        },
      }
    : identifiedEvent;
  emitRulesEvent(state, enrichedEvent);
  if (enrichedEvent.type === "CREATURE_DIED") {
    if (metadata) queueOracleTriggersForEvent(state, enrichedEvent, log, metadata);
    queueAllPermanentTriggersForEvent(state, enrichedEvent, log);
    return;
  }
  if (enrichedEvent.type === "COMBAT_DAMAGE_DEALT" || enrichedEvent.type === "PERMANENT_ENTERED") {
    queueAllPermanentTriggersForEvent(state, enrichedEvent, log);
    return;
  }
  queueOracleTriggersForEvent(state, enrichedEvent, log, metadata);
}

function queueAllPermanentTriggersForEvent(
  state: SimGameState,
  event: RulesEvent,
  log: (msg: string) => void
) {
  ensurePermanentZones(state);
  const queuedForEvent = new Set<string>();
  for (let controller = 0; controller < state.permanents!.length; controller++) {
    for (const permanent of state.permanents![controller] ?? []) {
      const metadata = getCardMetadata(state, controller, permanent.cardName) ??
        getCardMetadata(state, controller, permanent.face ?? permanent.cardName);
      const permanentMetadata = metadataForSelectedFace(metadata, permanent.face);
      if (!permanentMetadata) continue;
      queueOracleTriggersForEvent(
        state,
        {
          ...event,
          controller,
        },
        log,
        permanentMetadata,
        permanent.face ?? permanent.cardName,
        permanent,
        queuedForEvent
      );
    }
  }
}

function queueOracleTriggersForEvent(
  state: SimGameState,
  event: RulesEvent,
  log: (msg: string) => void,
  metadata?: DeckCardMetadata,
  sourceNameOverride?: CardName,
  sourcePermanent?: PermanentState,
  queuedForEvent?: Set<string>
) {
  if (!metadata || event.controller == null) return;
  const sourceName = sourceNameOverride ?? event.face ?? event.card ?? metadata.name;
  const sourcePermanentId = sourcePermanent?.id ?? event.permanentId;
  const parsed = parseCardRules(metadata);
  for (const ability of parsed.abilities) {
    if (ability.kind !== "TRIGGERED") continue;
    if (ability.trigger?.eventType !== event.type) continue;
    if (!conditionsSatisfied(state, ability, event, sourceName, sourcePermanentId)) continue;
    const abilityId = ability.abilityId ?? ability.patternId ?? "triggered";
    const triggerInstanceKey = `${event.eventId ?? "event"}:${sourcePermanentId ?? sourceName}:${abilityId}:${ability.sourceFragment ?? ""}`;
    state.queuedTriggerInstanceKeys ??= {};
    if (state.queuedTriggerInstanceKeys[triggerInstanceKey]) continue;
    if (queuedForEvent?.has(triggerInstanceKey)) continue;
    queuedForEvent?.add(triggerInstanceKey);
    state.queuedTriggerInstanceKeys[triggerInstanceKey] = true;
    const entry: StackEntry = {
      id: `trigger_${Date.now()}_${state.stack.length}_${abilityId}`,
      action: { type: "CAST_SPELL", card: sourceName },
      casterIndex: event.controller,
      resolved: false,
      responses: [],
      kind: "triggeredAbility",
      sourceCard: sourceName,
      sourcePermanentId,
      abilityId,
      patternId: ability.patternId,
      triggeringEventId: event.eventId,
      eventType: event.type,
      turn: state.turn,
      phase: state.phaseStep || state.phase,
      effects: ability.effects,
      ability,
    };
    state.stack.push(entry);
    if (activeDiagnostics) {
      activeDiagnostics.data.stackPushes++;
      activeDiagnostics.data.maxStackDepth = Math.max(activeDiagnostics.data.maxStackDepth, state.stack.length);
      recordStackTrace(state, "push", entry);
    }
    const effectText = ability.sourceFragment?.replace(/^when .+ enters(?: the battlefield)?,?\s*/i, "") ?? "ability";
    if (ability.patternId === "ETB_RETURN_CONTROLLED_PERMANENT_TO_HAND") {
      log(`${sourceName} ETB trigger added to stack:`);
      log(effectText);
    } else {
      log(`[Trigger] ${sourceName} ${ability.patternId ?? "ability"} put on stack`);
    }
  }
}

function conditionsSatisfied(
  state: SimGameState,
  ability: ParsedAbility,
  event: RulesEvent,
  sourceName: string,
  sourcePermanentId?: string
): boolean {
  return (ability.conditions ?? []).every((condition) => {
    switch (condition.type) {
      case "SOURCE_IS_THIS":
        if (event.permanentId && sourcePermanentId) {
          return event.permanentId === sourcePermanentId;
        }
        if (event.type === "COMBAT_DAMAGE_DEALT") {
          const damagePermanentId = String(event.data?.sourcePermanentId ?? "");
          if (damagePermanentId && sourcePermanentId) return damagePermanentId === sourcePermanentId;
          const damageSource = String(event.data?.sourceCard ?? event.data?.sourceFace ?? "").toLowerCase();
          return damageSource === sourceName.toLowerCase();
        }
        return (event.face ?? event.card ?? "").toLowerCase() === sourceName.toLowerCase();
      case "CONTROLLER_IS_YOU":
        if (event.type === "COMBAT_DAMAGE_DEALT") {
          return event.data?.sourceController === event.controller;
        }
        return event.player === event.controller;
      case "OPPONENT_HAS_MORE_LIFE":
        return state.lifeTotals.some((life, idx) => idx !== event.controller && life >= state.lifeTotals[event.controller ?? 0]);
      case "OPPONENT_CONTROLS_MORE_LANDS":
        return state.battlefields.some((battlefield, idx) => idx !== event.controller && battlefield.length > (state.battlefields[event.controller ?? 0]?.length ?? 0));
      case "CONTROLS_AT_LEAST_OTHER_PERMANENTS": {
        if (condition.permanentType !== "land") return false;
        const controller = event.controller ?? event.player ?? 0;
        const permanents = state.permanents?.[controller] ?? [];
        const count = permanents.length
          ? permanents.filter((permanent) =>
              isLandCard(state, controller, permanent.face ?? permanent.cardName)
            ).length
          : (state.battlefields[controller] ?? []).filter((card) =>
              isLandCard(state, controller, card)
            ).length;
        return count >= condition.amount;
      }
      case "HAS_SUBTYPE":
        return String(event.data?.sourceTypeLine ?? "").toLowerCase().includes(condition.subtype.toLowerCase());
      case "IS_CREATURE":
        return Boolean(event.data?.sourceIsCreature) ||
          String(event.data?.sourceTypeLine ?? "").toLowerCase().includes("creature");
      case "AND":
        return condition.conditions.every((inner) => conditionsSatisfied(state, { ...ability, conditions: [inner] }, event, sourceName, sourcePermanentId));
      case "OR":
        return condition.conditions.some((inner) => conditionsSatisfied(state, { ...ability, conditions: [inner] }, event, sourceName, sourcePermanentId));
      case "NOT":
        return !conditionsSatisfied(state, { ...ability, conditions: [condition.condition] }, event, sourceName, sourcePermanentId);
      default:
        return true;
    }
  });
}

function ensureRulesMetrics(state: SimGameState) {
  state.rulesMetrics ??= {
    unsupportedEffects: 0,
    stateBasedActions: 0,
    fizzledObjects: 0,
  };
  return state.rulesMetrics;
}

function recordIllegalCastPrevented(state: SimGameState) {
  const metrics = ensureRulesMetrics(state);
  metrics.illegalCastPrevented = (metrics.illegalCastPrevented ?? 0) + 1;
}

function recordManaPaymentFailure(state: SimGameState) {
  const metrics = ensureRulesMetrics(state);
  metrics.manaPaymentFailures = (metrics.manaPaymentFailures ?? 0) + 1;
  metrics.illegalCastPrevented = (metrics.illegalCastPrevented ?? 0) + 1;
}

export async function simulateGame(
  agents: SimAgent[],
  options: SimulationOptions = {}
): Promise<SimulationResult> {
  const maxTurns = options.maxTurns ?? 40;
  const log = options.log ?? (() => {});
  const enableStack = options.enableStack ?? DEFAULT_ENABLE_STACK;

  const state = createInitialState(
    agents.length,
    options.playerDecks,
    options.playerDeckMetadata,
    options.playerCommanders,
    options.startingPlayerIndex ?? 0
  );
  const diagnostics = createDiagnosticContext();
  diagnostics.data.deckInitAudits = state.deckInitAudits ?? [];
  activeDiagnostics = diagnostics;
  const history: SimulationResult["history"] = [];
  resetDecisionTimings();
  // Phase 2 — parallel snapshot array (one entry per history entry)
  const snapshotEntries: StepSnapshotEntry[] = [];

  let winnerIndex: number | null = null;
  let missedLandDropOpportunity = 0;

  // Phase 6A — London Mulligan phase
  const ENABLE_MULLIGAN = process.env.ENABLE_MULLIGAN !== "false";
  const maxMulligans = options.maxMulligans ?? 3;
  const turnDelayMs = options.turnDelayMs ?? 0;
  const phaseDelayMs = options.phaseDelayMs ?? 0;
  const actionDelayMs = options.actionDelayMs ?? 0;
  const waitMs = (ms: number) =>
    ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  const trackedWaitMs = async (name: string, ms: number) => {
    if (ms <= 0) return;
    const startedAt = performance.now();
    await waitMs(ms);
    const elapsed = performance.now() - startedAt;
    diagnostics.externalPauseMs += elapsed;
    diagnostics.data.timingsMs[name] = (diagnostics.data.timingsMs[name] ?? 0) + elapsed;
  };
  const yieldToIO = () => trackedWaitMs("viewer turn delay", turnDelayMs);
  const pauseForPhase = () => trackedWaitMs("viewer phase delay", phaseDelayMs);
  const pauseForAction = () => trackedWaitMs("viewer action delay", actionDelayMs);
  const applyPendingConcessions = () => {
    const concededPlayers = options.concededPlayers;
    if (!concededPlayers?.size) return null;
    let changed = false;
    for (const player of concededPlayers) {
      if (state.lifeTotals[player] === undefined || state.lifeTotals[player] <= 0) continue;
      state.lifeTotals[player] = 0;
      changed = true;
      log(`[Concede] Player ${player} concedes`);
      options.onStateChange?.(cloneState(state), { type: "player_conceded", player });
    }
    return changed ? checkForWinner(state) : null;
  };

  // Emit game_start synchronously (before any await) so getFilteredState() returns
  // non-null immediately when the first WebSocket client connects.
  options.onStateChange?.(cloneState(state), { type: "game_start" });

  if (process.env.DECK_INIT_AUDIT === "true" || process.env.DEBUG_EPISODE === "true") {
    for (const audit of diagnostics.data.deckInitAudits ?? []) {
      log(`[DECK_INIT_AUDIT] ${JSON.stringify(audit)}`);
    }
  }

  if (ENABLE_MULLIGAN) {
    for (let p = 0; p < agents.length; p++) {
      await yieldToIO();
      let mulliganCount = 0;
      while (mulliganCount < maxMulligans) {
        const hand = state.hands[p];
        const agent = agents[p];
        let keep = true;
        let bottomCards: CardName[] | undefined;

        if (typeof agent.decideMulligan === "function") {
          const mulliganState = cloneState(state);
          mulliganState.playerIndex = p;
          mulliganState.phase = "Mulligan";
          mulliganState.phaseStep = "Mulligan";
          const decision = await Promise.resolve(agent.decideMulligan(hand, mulliganCount, mulliganState));
          keep = decision.keep;
          bottomCards = decision.bottomCards;
        } else {
          // Default heuristic using shouldMulligan evaluator
          const meta = state.cardMetadata[p] ?? {};
          keep = !shouldMulligan(hand, mulliganCount, options.playerArchetypes?.[p], { metadata: meta });
        }

        if (keep) {
          if (mulliganCount > 0) {
            // London Mulligan: put (mulliganCount) cards on bottom
            const meta = state.cardMetadata[p] ?? {};
            const toBottom = bottomCards ?? chooseBottomCards(
              hand,
              mulliganCount,
              options.playerArchetypes?.[p],
              { metadata: meta }
            );
            for (const card of toBottom) {
              const idx = state.hands[p].indexOf(card);
              if (idx !== -1) state.hands[p].splice(idx, 1);
            }
            state.libraries[p].push(...shuffle(toBottom)); // push to bottom (end of array = bottom)
          }
          log(`[Mulligan] Player ${p} keeps (mulliganCount=${mulliganCount})`);
          options.onStateChange?.(cloneState(state), { type: "mulligan_done", player: p, mulliganCount });
          break;
        }

        // Return hand to library, shuffle, draw new hand of 7
        state.libraries[p] = shuffle([...state.hands[p], ...state.libraries[p]]);
        state.hands[p] = state.libraries[p].splice(0, 7);
        mulliganCount++;
      }

      if (mulliganCount >= maxMulligans) {
        log(`[Mulligan] Player ${p} forced keep after ${maxMulligans} mulligans`);
        // Still bottom down to (7 - maxMulligans) cards
        const cardsToKeep = Math.max(0, 7 - maxMulligans);
        const toBottom = state.hands[p].splice(cardsToKeep);
        state.libraries[p].push(...toBottom);
        options.onStateChange?.(cloneState(state), { type: "mulligan_done", player: p, mulliganCount: maxMulligans });
      }
    }
  }

  const startingPlayerIndex = options.startingPlayerIndex ?? 0;

  for (let turn = 1; turn <= maxTurns && winnerIndex === null; turn++) {
    state.turn = turn;
    diagnostics.currentTurn = turn;
    diagnostics.currentTurnActions = 0;
    checkEpisodeWatchdog(state);
    for (let seatOffset = 0; seatOffset < agents.length && winnerIndex === null; seatOffset++) {
      const p = (startingPlayerIndex + seatOffset) % agents.length;
      if (state.lifeTotals[p] <= 0) continue;
      state.playerIndex = p;
      await yieldToIO();
      winnerIndex = applyPendingConcessions();
      if (winnerIndex !== null) break;
      if (state.lifeTotals[p] <= 0) continue;
      log(`[Turn] T${turn} P${p}`);
      emitRulesEvent(state, { type: "TURN_STARTED", player: p, controller: p });
      options.onStateChange?.(cloneState(state), { type: "turn_start", turn, player: p });
      const turnContext: TurnContext = {
        landDropsUsedThisTurn: 0,
        maxLandDrops: normalizeMaxLandDrops(options.maxLandDrops),
        secondMainLandDropAvailable: false,
        lastSecondMainActionCount: 0,
      };

      for (const step of TURN_STRUCTURE) {
        state.phase = step.phase;
        state.phaseStep = step.step;
        checkEpisodeWatchdog(state);
        if (step.step === "Sottofase di Mantenimento") {
          emitRulesEvent(state, { type: "UPKEEP_STARTED", player: p, controller: p });
        }
        options.onStateChange?.(cloneState(state), { type: "phase_change", phase: step.phase, step: step.step });
        await pauseForPhase();
        winnerIndex = applyPendingConcessions();
        if (winnerIndex !== null || state.lifeTotals[p] <= 0) break;

        const skipDrawStep =
          turn === 1 &&
          p === startingPlayerIndex &&
          step.step === "Sottofase di Acquisizione";

        if (step.auto && !skipDrawStep) {
          step.auto(state, p, log);
          if (step.step === "Sottofase di Acquisizione") {
            options.onStateChange?.(cloneState(state), { type: "draw", player: p });
            await pauseForAction();
          }
        }

        if (step.type === "combat") {
          const combatTarget = await resolveCombatTarget(
            state,
            agents[p],
            p
          );
          if (combatTarget !== null) {
            await executeCombatPhase(
              state,
              agents,
              p,
              combatTarget,
              history,
              log,
              snapshotEntries,
              options.onStateChange,
              enableStack,
              pauseForPhase,
              pauseForAction
            );
            winnerIndex = checkForWinner(state);
            if (winnerIndex !== null) break;
          }
          continue;
        }

        const rules = {
          allowInstant: step.allowInstant ?? false,
          allowSorcery: step.allowSorcery ?? false,
          allowLand: step.allowLand ?? false,
        };
        const windowWinner = await processActionWindow(
          state,
          agents,
          p,
          history,
          log,
          turnContext,
          rules,
          snapshotEntries,
          options.onStateChange,
          options.onAiDecisionTrace,
          enableStack,
          pauseForAction
        );
        if (windowWinner !== null) {
          winnerIndex = windowWinner;
          break;
        }
        winnerIndex = applyPendingConcessions();
        if (winnerIndex !== null || state.lifeTotals[p] <= 0) break;
      }

      cleanupTemporaryEffects(state, p, log);
      applyStateBasedActions(state, log);

      if (
        winnerIndex === null &&
        hasLandDropCapacity(turnContext) &&
        turnContext.secondMainLandDropAvailable &&
        hasPlayableLandInHand(state, p)
      ) {
        missedLandDropOpportunity++;
        log(missedLandDropDiagnostic(state, p, turn, turnContext));
      }
    }
  }

  if (winnerIndex === null) {
    winnerIndex = determineWinnerByLife(state);
  }

  options.onStateChange?.(cloneState(state), { type: "game_over", winner: winnerIndex });

  // Phase 2 — compute shaped rewards and finalize agents
  agents.forEach((agent, agentIdx) => {
    if (!isLearningAgent(agent)) return;

    const terminalReward = terminalRewardForPlayer(
      winnerIndex,
      agentIdx,
      state.lifeTotals
    );

    if (REWARD_SHAPING_ENABLED && snapshotEntries.length > 0) {
      const agentEntries = snapshotEntries.filter((e) => e.playerIndex === agentIdx);
      const stepRewards = agentEntries.map((e) =>
        shapeReward(e.prevSnapshot, e.action, e.nextSnapshot, agentIdx)
      );
      const discounted = discountRewards(stepRewards, terminalReward, REWARD_GAMMA);
      log(
        `[RewardShaping] Agent-${agentIdx} terminal=${terminalReward.toFixed(2)} ` +
        `shaped_total=${discounted.reduce((s, v) => s + v, 0).toFixed(3)} ` +
        `steps=${agentEntries.length}`
      );
      agent.finalizeEpisodeWithRewards(discounted);
    } else {
      agent.finalizeEpisode(terminalReward);
    }
  });

  // Attach shaped rewards to history entries for dataset export (Phase 2)
  if (REWARD_SHAPING_ENABLED) {
    for (let i = 0; i < Math.min(history.length, snapshotEntries.length); i++) {
      history[i].shapedReward = shapeReward(
        snapshotEntries[i].prevSnapshot,
        snapshotEntries[i].action,
        snapshotEntries[i].nextSnapshot,
        history[i].playerIndex
      );
    }
  }

  attachDecisionTelemetry(diagnostics.data);
  updateEpisodePerf(state);

  return {
    winnerIndex,
    history,
    turns: state.turn,
    finalState: cloneState(state),
    diagnostics: diagnostics.data,
    metrics: { missedLandDropOpportunity },
  };
}

async function executeCombatPhase(
  state: SimGameState,
  agents: SimAgent[],
  attackerIndex: number,
  defenderIndex: number,
  history: SimulationResult["history"],
  log: (message: string) => void,
  snapshotEntries: StepSnapshotEntry[],
  onStateChange?: (state: SimGameState, event: GameEvent) => void,
  enableStack = false,
  pauseForPhase: () => Promise<void> = () => Promise.resolve(),
  pauseForAction: () => Promise<void> = () => Promise.resolve()
) {
  const attackerPool = availableAttackers(state, attackerIndex);
  if (!attackerPool.length) return;

  // Phase 2: snapshot prima di qualsiasi risoluzione combat
  const combatPrevSnap = captureSnapshot(state);
  const combatSnapStartIdx = snapshotEntries.length;

  const attackSnapshot = cloneState(state);
  attackSnapshot.playerIndex = attackerIndex;
  const attackPlans = generateAttackPlans(
    attackSnapshot,
    attackerIndex,
    defenderIndex
  );
  const attackChoice = await resolveAttackPlanChoice(
    agents[attackerIndex],
    attackSnapshot,
    attackPlans,
    attackerPool,
    defenderIndex
  );
  const attackerIds = attackChoice.plan.attackers;
  const selectedAttackers = attackerPool.filter((creature) =>
    attackerIds.includes(creature.id)
  );
  const attackerView = selectedAttackers.map((creature) => ({ ...creature }));
  let combatAssignments: BlockAssignment[] = [];

  const declareAttackersAction: SimAction = {
    type: "DECLARE_ATTACKERS",
    player: attackerIndex,
    attackers: attackerIds,
  };
  log(`[Action] DECLARE_ATTACKERS ${attackerIds.length ? attackerIds.join(", ") : "none"}`);
  history.push({
    playerIndex: attackerIndex,
    agentId: agents[attackerIndex].id,
    action: declareAttackersAction,
    state: attackSnapshot,
    availableActions: [],
    metadata: attackChoice.metadata,
  });
  // Phase 2: placeholder — nextSnapshot verrà patchato dopo resolveCombat
  snapshotEntries.push({
    playerIndex: attackerIndex,
    prevSnapshot: combatPrevSnap,
    nextSnapshot: combatPrevSnap,
    action: declareAttackersAction,
  });

  // Phase 6: stack window after declare attackers
  if (enableStack && attackerIds.length > 0) {
    const stackEntry: StackEntry = {
      id: `stack_${Date.now()}_${attackerIndex}`,
      action: declareAttackersAction,
      casterIndex: attackerIndex,
      resolved: false,
      responses: [],
      kind: "spell",
      sourceCard: "DECLARE_ATTACKERS",
      abilityId: "DECLARE_ATTACKERS",
      patternId: "DECLARE_ATTACKERS",
      eventType: "DECLARE_ATTACKERS",
      turn: state.turn,
      phase: state.phaseStep || state.phase,
    };
    state.stack.push(stackEntry);
    await resolveStackWithPriority(state, attackerIndex, agents, log, onStateChange, pauseForAction);
    onStateChange?.(cloneState(state), { type: "action_applied", player: attackerIndex, action: declareAttackersAction });
    await pauseForAction();
  }

  if (!attackerIds.length) {
    // nessun attaccante, nessuna risoluzione: nextSnapshot = stato attuale (invariato)
    snapshotEntries[combatSnapStartIdx].nextSnapshot = captureSnapshot(state);
    return;
  }

  state.phase = "Fase di Combattimento";
  state.phaseStep = "Sottofase di Dichiarazione delle Creature Bloccanti";
  onStateChange?.(cloneState(state), {
    type: "phase_change",
    phase: state.phase,
    step: state.phaseStep,
  });
  await pauseForPhase();

  const blockerOptions = availableBlockers(state, defenderIndex);
  let blockChoice: { plan: BlockPlan; metadata: DecisionMetadata } | null = null;
  if (blockerOptions.length) {
    const blockSnapshot = cloneState(state);
    blockSnapshot.playerIndex = defenderIndex;
    const blockPlans = generateBlockPlans(blockSnapshot, defenderIndex, attackerIds);
    blockChoice = await resolveBlockPlanChoice(
      agents[defenderIndex],
      blockSnapshot,
      blockPlans,
      attackerView,
      blockerOptions,
      attackerIds
    );
    const normalizedAssignments = normalizeBlockPlanAssignments(
      blockChoice.plan,
      blockerOptions,
      attackerIds
    );
    combatAssignments = normalizedAssignments;

    const declareBlockersAction: SimAction = {
      type: "DECLARE_BLOCKERS",
      player: defenderIndex,
      assignments: normalizedAssignments,
    };
    log(`[Action] DECLARE_BLOCKERS ${normalizedAssignments.length ? `${normalizedAssignments.length} assignment(s)` : "none"}`);
    history.push({
      playerIndex: defenderIndex,
      agentId: agents[defenderIndex].id,
      action: declareBlockersAction,
      state: blockSnapshot,
      availableActions: [],
      metadata: blockChoice.metadata,
    });
    // Phase 2: placeholder per il difensore
    snapshotEntries.push({
      playerIndex: defenderIndex,
      prevSnapshot: combatPrevSnap,
      nextSnapshot: combatPrevSnap,
      action: declareBlockersAction,
    });

    state.phaseStep = "Sottofase di Danno da Combattimento";
    onStateChange?.(cloneState(state), {
      type: "phase_change",
      phase: state.phase,
      step: state.phaseStep,
    });
    await pauseForPhase();

    resolveCombat(state, attackerIndex, defenderIndex, attackerIds, normalizedAssignments, log);
  } else {
    state.phaseStep = "Sottofase di Danno da Combattimento";
    onStateChange?.(cloneState(state), {
      type: "phase_change",
      phase: state.phase,
      step: state.phaseStep,
    });
    await pauseForPhase();

    resolveCombat(state, attackerIndex, defenderIndex, attackerIds, [], log);
  }

  emitCombatDamageTriggers(state, attackerIndex, defenderIndex, attackerView, combatAssignments, log);
  if (state.stack.length > 0) {
    await resolveStackWithPriority(state, attackerIndex, agents, log, onStateChange, pauseForAction);
  }

  onStateChange?.(cloneState(state), { type: "combat_resolved", attacker: attackerIndex, defender: defenderIndex });
  await pauseForAction();

  // Phase 2: patcha tutti gli entry combat con il nextSnapshot post-risoluzione
  const combatNextSnap = captureSnapshot(state);
  for (let i = combatSnapStartIdx; i < snapshotEntries.length; i++) {
    snapshotEntries[i].nextSnapshot = combatNextSnap;
  }
}

async function passPriority(
  state: SimGameState,
  castingPlayer: number,
  stackEntry: StackEntry,
  agents: SimAgent[],
  log: (msg: string) => void,
  onStateChange?: (state: SimGameState, event: GameEvent) => void,
  pauseForAction: () => Promise<void> = () => Promise.resolve()
): Promise<void> {
  const numPlayers = state.lifeTotals.length;
  const livingPlayers = () =>
    state.lifeTotals
      .map((life, idx) => ({ life, idx }))
      .filter(({ life }) => life > 0)
      .map(({ idx }) => idx);

  let priorityPlayer = (castingPlayer + 1) % numPlayers;
  let consecutivePasses = 0;
  let iterations = 0;
  const requiredPasses = () => livingPlayers().length;

  while (state.stack.length > 0 && consecutivePasses < requiredPasses()) {
    iterations++;
    const diagnostics = activeDiagnostics;
    if (diagnostics) {
      diagnostics.data.maxPriorityIterationsPerWindow = Math.max(
        diagnostics.data.maxPriorityIterationsPerWindow,
        iterations
      );
      if (iterations > diagnostics.limits.maxPriorityIterations) {
        abortEpisode(state, "MAX_PRIORITY_ITERATIONS");
      }
    }
    checkEpisodeWatchdog(state, null, priorityPlayer);
    if (state.lifeTotals[priorityPlayer] <= 0) {
      priorityPlayer = (priorityPlayer + 1) % numPlayers;
      continue;
    }
    const currentTop = state.stack[state.stack.length - 1] ?? stackEntry;
    const opponentIndex = priorityPlayer;
    const agent = agents[opponentIndex];
    if (typeof agent.decideResponse !== "function") {
      consecutivePasses++;
      if (activeDiagnostics) activeDiagnostics.data.priorityPasses++;
      priorityPlayer = (priorityPlayer + 1) % numPlayers;
      continue;
    }

    const instants = timeBlock("priority generateResponses", () =>
      getAvailableInstants(state, opponentIndex, currentTop)
        .filter((action) =>
          action.type === "CAST_SPELL" &&
          canCastSpell(state, opponentIndex, action.card, {
            landDropsUsedThisTurn: 0,
            maxLandDrops: 1,
            allowInstant: true,
            allowSorcery: false,
            allowLand: false,
          })
        )
    );
    if (activeDiagnostics) {
      activeDiagnostics.data.responsesGenerated += instants.length;
      activeDiagnostics.data.lastActionWindow = {
        turn: state.turn,
        phase: state.phaseStep || state.phase,
        player: opponentIndex,
        legalActions: instants.length ? legalActionSummary(instants) : ["PASS_PRIORITY"],
        total: instants.length || 1,
        stackDepth: state.stack.length,
      };
    }
    if (instants.length === 0) {
      consecutivePasses++;
      if (activeDiagnostics) activeDiagnostics.data.priorityPasses++;
      priorityPlayer = (priorityPlayer + 1) % numPlayers;
      continue;
    }

    const responseState = {
      ...state,
      playerIndex: opponentIndex,
    };
    const beforeResponseTelemetry = decisionTelemetrySnapshot();
    const responseStartedAt = performance.now();
    const response = await timeAsync("AI decideResponse", () =>
      Promise.resolve(agent.decideResponse!(responseState, currentTop, instants))
    );
    const responseElapsedMs = performance.now() - responseStartedAt;
    const afterResponseTelemetry = decisionTelemetrySnapshot();
    const dbLookupMs = Object.entries(afterResponseTelemetry.timingsMs)
      .filter(([key]) => key.includes("lookup"))
      .reduce((sum, [key, value]) => sum + value - (beforeResponseTelemetry.timingsMs[key] ?? 0), 0);
    const threshold = envNumber("AI_PERF_LOG_THRESHOLD_MS", 50);
    if (activeDiagnostics?.debugEpisode || responseElapsedMs >= threshold) {
      log(
        `[AI PERF] player=P${opponentIndex} phase=${state.phaseStep || state.phase} legal_actions=${instants.length} ` +
        `db_lookup_ms=${Math.max(0, dbLookupMs).toFixed(1)} inference_ms=${Math.max(0, responseElapsedMs - dbLookupMs).toFixed(1)} ` +
        `rules_ms=0.0 total_ms=${responseElapsedMs.toFixed(1)} action=${response ? actionSummary(response) : "PASS_PRIORITY"}`
      );
    }
    if (response === null) {
      consecutivePasses++;
      if (activeDiagnostics) activeDiagnostics.data.priorityPasses++;
      priorityPlayer = (priorityPlayer + 1) % numPlayers;
      continue;
    }
    if (activeDiagnostics) {
      activeDiagnostics.data.actionsApplied++;
      activeDiagnostics.currentTurnActions++;
      activeDiagnostics.data.maxActionsPerTurn = Math.max(
        activeDiagnostics.data.maxActionsPerTurn ?? 0,
        activeDiagnostics.currentTurnActions
      );
    }
    recordRecentAction(state, response, "response ");
    checkEpisodeWatchdog(state, response, opponentIndex);

    let responseEntry: StackEntry | null = null;
    if (response.type === "CAST_SPELL") {
      castSpellToStack(state, opponentIndex, response, log);
      responseEntry = createStackEntryForAction(state, opponentIndex, response);
      onStateChange?.(cloneState(state), { type: "action_applied", player: opponentIndex, action: response });
      await pauseForAction();
    } else if (response.type === "ACTIVATE_ABILITY") {
      responseEntry = activateAbilityToStack(state, opponentIndex, response, log);
      onStateChange?.(cloneState(state), { type: "action_applied", player: opponentIndex, action: response });
      await pauseForAction();
      if (!responseEntry) {
        consecutivePasses = 0;
        priorityPlayer = (opponentIndex + 1) % numPlayers;
        continue;
      }
    }

    if (!responseEntry) {
      consecutivePasses++;
      if (activeDiagnostics) activeDiagnostics.data.priorityPasses++;
      priorityPlayer = (priorityPlayer + 1) % numPlayers;
      continue;
    }
    currentTop.responses.push(responseEntry);
    state.stack.push(responseEntry);
    if (activeDiagnostics) {
      activeDiagnostics.data.stackPushes++;
      activeDiagnostics.data.maxStackDepth = Math.max(activeDiagnostics.data.maxStackDepth, state.stack.length);
      recordStackTrace(state, "push", responseEntry);
    }
    log(`[Stack] Player ${opponentIndex} responds with ${response.type}`);
    consecutivePasses = 0;
    priorityPlayer = (opponentIndex + 1) % numPlayers;
  }
}

export async function resolveStackWithPriority(
  state: SimGameState,
  activePlayer: number,
  agents: SimAgent[],
  log: (msg: string) => void,
  onStateChange?: (state: SimGameState, event: GameEvent) => void,
  pauseForAction: () => Promise<void> = () => Promise.resolve()
): Promise<void> {
  while (state.stack.length > 0) {
    checkEpisodeWatchdog(state);
    const top = state.stack[state.stack.length - 1];
    await passPriority(state, activePlayer, top, agents, log, onStateChange, pauseForAction);
    const entry = state.stack.pop()!;
    if (entry.resolved) continue;
    entry.resolved = true;
    recordStackTrace(state, "resolve", entry);
    if (activeDiagnostics) {
      activeDiagnostics.data.stackResolutions++;
      maybeRecordStackStorm(state, entry);
      if (activeDiagnostics.data.stackResolutions > activeDiagnostics.limits.maxStackResolutions) {
        abortEpisode(state, "MAX_STACK_RESOLUTIONS");
      }
    }
    log(`[Stack] Resolving ${entry.action.type} from player ${entry.casterIndex}`);
    if (entry.kind === "triggeredAbility" || entry.kind === "activatedAbility") {
      if (
        entry.action.type === "ACTIVATE_ABILITY" &&
        entry.ability &&
        !allRequiredTargetsStillLegal(state, entry.casterIndex, entry.action, [entry.ability])
      ) {
        fizzleObject(state, entry.sourceCard ?? "ability", log, "all targets are illegal");
        activePlayer = state.playerIndex;
        continue;
      }
      await resolveEffectDescriptorsWithChoices(state, entry, agents, log);
      applyStateBasedActions(state, log);
      activePlayer = state.playerIndex;
      continue;
    }
    if (entry.action.type === "CAST_SPELL") {
      if (resolveCounterspell(state, entry, log)) {
        continue;
      }
      resolveSpell(
        state,
        entry.casterIndex,
        entry.action.card,
        log,
        entry.action.face,
        entry.action.targetId,
        entry.action.targetGraveyardCard,
        entry.action
      );
    }
    applyStateBasedActions(state, log);
    activePlayer = state.playerIndex;
  }
}

async function resolveEffectDescriptorsWithChoices(
  state: SimGameState,
  entry: StackEntry,
  agents: SimAgent[],
  log: (msg: string) => void
) {
  for (const effect of entry.effects ?? []) {
    if (
      effect.type === "RETURN_TO_HAND" &&
      effect.selection?.zone === "battlefield" &&
      effect.selection.targeted === false
    ) {
      await resolveSelectedReturnToHandEffect(state, entry, effect, agents, log);
      continue;
    }
    resolveEffectDescriptors(state, { ...entry, effects: [effect] }, log);
  }
}

function resolveEffectDescriptors(
  state: SimGameState,
  entry: StackEntry,
  log: (msg: string) => void
) {
  for (const effect of entry.effects ?? []) {
    const player = entry.casterIndex;
    switch (effect.type) {
      case "DRAW_CARDS":
        drawCards(state, player, effect.amount ?? 1, log, entry.sourceCard);
        break;
      case "DISCARD": {
        const hand = state.hands[player] ?? [];
        const discarded = hand.splice(Math.max(0, hand.length - (effect.amount ?? 1)));
        state.graveyards[player].push(...discarded);
        break;
      }
      case "GAIN_LIFE":
        gainLife(state, player, effect.amount ?? 1, log, entry.sourceCard ?? "ability");
        break;
      case "LOSE_LIFE": {
        if (effect.target === "eachOpponent") {
          for (let idx = 0; idx < state.lifeTotals.length; idx++) {
            if (idx !== player && state.lifeTotals[idx] > 0) loseLife(state, idx, effect.amount ?? 1, log, entry.sourceCard ?? "ability");
          }
          break;
        }
        if (effect.target === "eachPlayer") {
          for (let idx = 0; idx < state.lifeTotals.length; idx++) {
            if (state.lifeTotals[idx] > 0) loseLife(state, idx, effect.amount ?? 1, log, entry.sourceCard ?? "ability");
          }
          break;
        }
        const target = effect.target === "self" ? player : findNextOpponent(state, player);
        if (target !== null) loseLife(state, target, effect.amount ?? 1, log, entry.sourceCard ?? "ability");
        break;
      }
      case "DEAL_DAMAGE":
        resolveDamageEffect(state, player, effect, entry, log);
        break;
      case "DESTROY":
        resolveDestroyEffect(state, player, effect, entry, log);
        break;
      case "EXILE":
        resolveExileEffect(state, player, effect, entry, log);
        break;
      case "RETURN_TO_HAND":
        resolveReturnToHandEffect(state, player, effect, log);
        break;
      case "RETURN_FROM_GRAVEYARD_TO_HAND":
        returnFromGraveyard(state, player, effect, entry, log, "hand");
        break;
      case "RETURN_FROM_GRAVEYARD_TO_BATTLEFIELD":
        returnFromGraveyard(state, player, effect, entry, log, "battlefield");
        break;
      case "MILL":
        millCards(state, player, effect.amount ?? 1, log, entry.sourceCard);
        break;
      case "CREATE_TOKEN":
        createEffectToken(state, player, effect, log, entry.sourceCard);
        break;
      case "ADD_COUNTER":
        resolveCounterEffect(state, player, effect, entry, log, 1);
        break;
      case "REMOVE_COUNTER":
        resolveCounterEffect(state, player, effect, entry, log, -1);
        break;
      case "TAP":
        resolveTapEffect(state, player, effect, entry, true);
        break;
      case "UNTAP":
        resolveTapEffect(state, player, effect, entry, false);
        break;
      case "ADD_MANA":
        state.artifactMana[player] = (state.artifactMana[player] ?? 0) + (effect.amount ?? 1);
        break;
      case "SEARCH_LIBRARY":
        searchLibraryToZone(state, player, effect, log, entry.sourceCard);
        break;
      case "SACRIFICE":
        sacrificePermanent(state, player, effect, log);
        break;
      case "GAIN_CONTROL":
        gainControlEffect(state, player, effect, entry, log);
        break;
      case "MODIFY_POWER_TOUGHNESS":
        modifyPowerToughnessEffect(state, player, effect, entry, log);
        break;
      case "GRANT_KEYWORD":
        grantKeywordEffect(state, player, effect, entry, log);
        break;
      default:
        markUnsupportedEffect(state, entry.sourceCard ?? "Triggered ability", effect.type, log);
        break;
    }
  }
}

function firstActionTarget(
  action: SimAction,
  type: TargetRef["type"]
): TargetRef | undefined {
  return "targets" in action ? action.targets?.find((target) => target.type === type) : undefined;
}

type PermanentLookup = { controller: number; permanent?: PermanentState; creature?: CreaturePermanent };

function selectedPermanentTarget(state: SimGameState, entry: StackEntry): PermanentLookup | null {
  const target = firstActionTarget(entry.action, "permanent") ??
    firstActionTarget(entry.action, "creature");
  const legacyTargetId = entry.action.type === "CAST_SPELL" ? entry.action.targetId : undefined;
  const targetId = target?.id ?? legacyTargetId;
  return typeof targetId === "string" ? findPermanentTargetById(state, targetId) : null;
}

function hasExplicitPermanentTarget(action: SimAction) {
  return Boolean(
    firstActionTarget(action, "permanent") ||
    firstActionTarget(action, "creature") ||
    (action.type === "CAST_SPELL" && action.targetId)
  );
}

function selectedCreatureTarget(state: SimGameState, entry: StackEntry): (PermanentLookup & { creature: CreaturePermanent }) | null {
  const target = selectedPermanentTarget(state, entry);
  return target?.creature ? { ...target, creature: target.creature } : null;
}

function selectedPlayerTarget(entry: StackEntry): number | null {
  const target = firstActionTarget(entry.action, "player");
  if (typeof target?.id === "number") return target.id;
  if (typeof target?.id === "string" && /^\d+$/.test(target.id)) return Number(target.id);
  if (entry.action.type === "CAST_SPELL" && entry.action.targetPlayer !== undefined) {
    return entry.action.targetPlayer;
  }
  return null;
}

function selectedStackTarget(state: SimGameState, entry: StackEntry): StackEntry | null {
  const target = firstActionTarget(entry.action, "stack");
  const targetId = target?.id ?? (entry.action.type === "CAST_SPELL" ? entry.action.targetStackId : undefined);
  if (typeof targetId !== "string") return null;
  return state.stack.find((candidate) => candidate.id === targetId && !candidate.resolved) ?? null;
}

function selectedGraveyardTarget(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry
) {
  const target = firstActionTarget(entry.action, "card");
  if (typeof target?.id === "string") {
    const parsed = parseGraveyardTargetId(target.id);
    if (parsed) {
      const card = state.graveyards[parsed.owner]?.[parsed.index];
      if (card === parsed.card && graveyardCardMatches(state, parsed.owner, card, effect)) {
        return { owner: parsed.owner, card, index: parsed.index };
      }
      return null;
    }
  }
  if (entry.action.type === "CAST_SPELL" && entry.action.targetGraveyardCard) {
    const targetGraveyardCard = entry.action.targetGraveyardCard;
    const owner = effect.controller === "opponent"
      ? findNextOpponent(state, player) ?? player
      : player;
    const index = state.graveyards[owner]?.findIndex((card) => card === targetGraveyardCard) ?? -1;
    if (index >= 0 && graveyardCardMatches(state, owner, targetGraveyardCard, effect)) {
      return { owner, card: targetGraveyardCard, index };
    }
  }
  return null;
}

function hasExplicitGraveyardTarget(action: SimAction) {
  return Boolean(firstActionTarget(action, "card") || (action.type === "CAST_SPELL" && action.targetGraveyardCard));
}

function resolveDamageEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry,
  log: (msg: string) => void
) {
  const amount = effect.amount ?? 1;
  if (effect.target === "eachOpponent") {
    for (let idx = 0; idx < state.lifeTotals.length; idx++) {
      if (idx !== player && state.lifeTotals[idx] > 0) dealDamageToPlayer(state, idx, amount, log, entry.sourceCard ?? "effect");
    }
    return;
  }
  if (effect.target === "eachPlayer") {
    for (let idx = 0; idx < state.lifeTotals.length; idx++) {
      if (state.lifeTotals[idx] > 0) dealDamageToPlayer(state, idx, amount, log, entry.sourceCard ?? "effect");
    }
    return;
  }
  if (effect.target === "targetCreature") {
    const target = selectedCreatureTarget(state, entry) ??
      (hasExplicitPermanentTarget(entry.action) ? null : selectCreatureTarget(state, player));
    if (!target) return fizzleObject(state, entry.sourceCard ?? "effect", log, "target creature is no longer legal");
    applyDamageToCreature(state, target.controller, target.creature, amount, log, entry.sourceCard ?? "effect");
    return;
  }
  const target = selectedPlayerTarget(entry) ?? findNextOpponent(state, player);
  if (target !== null) dealDamageToPlayer(state, target, amount, log, entry.sourceCard ?? "effect");
}

function resolveDestroyEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry,
  log: (msg: string) => void
) {
  if (effect.target === "targetCreature") {
    const target = selectedCreatureTarget(state, entry) ??
      (hasExplicitPermanentTarget(entry.action) ? null : selectCreatureTarget(state, player));
    if (!target?.creature) return fizzleObject(state, entry.sourceCard ?? "effect", log, "target creature is no longer legal");
    destroyCreatureWithEvents(state, target.controller, target.creature.id, log);
  }
}

function resolveExileEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry,
  log: (msg: string) => void
) {
  if (effect.target === "targetCreature" || effect.target === "targetPermanent") {
    const selected = selectedPermanentTarget(state, entry);
    const fallback = hasExplicitPermanentTarget(entry.action) ? null : selectCreatureTarget(state, player);
    const target: PermanentLookup | null = selected ?? (fallback
      ? {
          controller: fallback.controller,
          creature: fallback.creature,
          permanent: state.permanents?.[fallback.controller]?.find((candidate) =>
            candidate.id === fallback.creature.id ||
            candidate.cardName === fallback.creature.name ||
            candidate.face === fallback.creature.name
          ),
        }
      : null);
    if (!target) return fizzleObject(state, entry.sourceCard ?? "effect", log, "target is no longer legal");
    if (target.creature) {
      exileCreature(state, target.controller, target.creature.id, log);
    } else if (target.permanent) {
      removePermanentFromBattlefieldOnly(state, target.controller, target.permanent.face ?? target.permanent.cardName);
      ensureExileZones(state)[target.permanent.owner].push(target.permanent.cardName);
    }
  }
}

function resolveReturnToHandEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  log: (msg: string) => void
) {
  const target = selectEffectPermanentTarget(state, player, effect);
  if (!target) return;
  removePermanentFromBattlefieldOnly(state, target.controller, target.card);
  state.hands[target.controller].push(target.card);
  log(`Player ${target.controller}'s ${target.card} returns to hand`);
}

async function resolveSelectedReturnToHandEffect(
  state: SimGameState,
  entry: StackEntry,
  effect: NonNullable<StackEntry["effects"]>[number],
  agents: SimAgent[],
  log: (msg: string) => void
) {
  const choices = selectablePermanentsForEffect(state, entry.casterIndex, effect);
  if (!choices.length) {
    log(`${entry.sourceCard ?? "Triggered ability"} resolves with no legal permanents to return`);
    return;
  }

  const choiceActions: Extract<SimAction, { type: "RESOLVE_CHOICE" }>[] = choices.map((choice) => ({
    type: "RESOLVE_CHOICE",
    choiceType: "RETURN_TO_HAND",
    sourceStackId: entry.id,
    permanentId: choice.permanent.id,
    card: choice.permanent.face ?? choice.permanent.cardName,
  }));
  const agent = agents[entry.casterIndex];
  const decision = await Promise.resolve(
    agent.decideAction(cloneState(state), choiceActions)
  );
  const chosenPermanentId = decision.action.type === "RESOLVE_CHOICE"
    ? decision.action.permanentId
    : null;
  const selectedAction = choiceActions.find((action) =>
    action.permanentId === chosenPermanentId
  ) ?? choiceActions[0];
  const selected = choices.find((choice) => choice.permanent.id === selectedAction.permanentId);
  if (!selected) {
    log(`${entry.sourceCard ?? "Triggered ability"} resolves with no legal permanents to return`);
    return;
  }

  const removed = removePermanentFromBattlefieldById(state, selected.controller, selected.permanent.id);
  if (!removed) {
    log(`${entry.sourceCard ?? "Triggered ability"} resolves with no legal permanents to return`);
    return;
  }

  state.hands[removed.owner].push(removed.cardName);
  emitRulesEvent(state, {
    type: "PERMANENT_LEFT",
    player: entry.casterIndex,
    controller: selected.controller,
    sourceCard: entry.sourceCard,
    permanentId: removed.id,
    card: removed.cardName,
    face: removed.face,
    data: {
      sourceCard: entry.sourceCard,
      sourcePermanentId: entry.sourcePermanentId,
      abilityId: entry.abilityId,
      selectedPermanentId: removed.id,
      returnedCard: removed.cardName,
      destinationZone: "hand",
    },
  });
  log(`Player ${entry.casterIndex} returns ${removed.face ?? removed.cardName} to its owner's hand`);
}

function returnFromGraveyard(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry,
  log: (msg: string) => void,
  destination: "hand" | "battlefield"
) {
  const target = findGraveyardTarget(state, player, effect, entry);
  if (!target) {
    if (effect.optional) return;
    return fizzleObject(state, entry.sourceCard ?? "effect", log, "graveyard target is no longer legal");
  }
  state.graveyards[target.owner].splice(target.index, 1);
  if (destination === "hand") {
    state.hands[target.owner].push(target.card);
    log(`${entry.sourceCard ?? "Effect"} returns ${target.card} from graveyard to Player ${target.owner}'s hand`);
    return;
  }
  putCardOntoBattlefieldFromZone(state, target.owner, target.card, log);
  log(`${entry.sourceCard ?? "Effect"} returns ${target.card} from graveyard to the battlefield`);
}

function millCards(
  state: SimGameState,
  player: number,
  amount: number,
  log: (msg: string) => void,
  source?: CardName
) {
  const target = findEffectPlayerTarget(state, player, "opponent") ?? player;
  const moved = state.libraries[target].splice(0, Math.max(0, amount));
  state.graveyards[target].push(...moved);
  if (moved.length) log(`${source ?? "Effect"} mills ${moved.length} card(s) from Player ${target}`);
}

function createEffectToken(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  log: (msg: string) => void,
  source?: CardName
) {
  const token = effect.token ?? { name: "Token", power: 1, toughness: 1 };
  const count = Math.max(1, typeof token.count === "number" ? token.count : effect.amount ?? 1);
  for (let i = 0; i < count; i++) {
    state.battlefields[player].push(token.name);
    const isCreatureToken = token.types?.some((type) => type.toLowerCase() === "creature") ||
      token.power !== undefined ||
      token.toughness !== undefined;
    let permanentId: string | undefined;
    if (isCreatureToken) {
      const creature = createTokenPermanent(state, player, {
        name: token.name,
        power: token.power ?? 1,
        toughness: token.toughness ?? 1,
        tapped: token.tapped || token.attacking,
      });
      permanentId = creature.id;
    }
    if (token.types?.some((type) => type.toLowerCase() === "artifact")) {
      state.artifacts[player] ??= [];
      state.artifacts[player].push(token.name);
    }
    addPermanentState(state, {
      cardName: token.name,
      owner: player,
      controller: player,
      face: token.name,
      tapped: token.tapped || token.attacking || false,
      token: true,
      summoningSickness: isCreatureToken,
    });
    dispatchRulesEvent(state, {
      type: "PERMANENT_ENTERED",
      player,
      controller: player,
      card: token.name,
      face: token.name,
      permanentId,
      sourceCard: source,
    }, log, { name: token.name, typeLine: "Token Creature", isCreature: true, isPermanent: true });
  }
  log(`${source ?? "Effect"} creates ${count} ${token.name} token(s)`);
}

function resolveCounterEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry,
  log: (msg: string) => void,
  direction: 1 | -1
) {
  const amount = Math.max(1, effect.amount ?? 1) * direction;
  const counterType = effect.counterType ?? "+1/+1";
  const target = findCounterTarget(state, player, effect, entry);
  if (!target) return fizzleObject(state, entry.sourceCard ?? "effect", log, "counter target is no longer legal");

  const permanent = target.permanent;
  if (permanent) {
    permanent.counters ??= {};
    permanent.counters[counterType] = Math.max(0, (permanent.counters[counterType] ?? 0) + amount);
  }
  if ((counterType === "+1/+1" || counterType === "-1/-1") && target.creature) {
    const statDelta = counterType === "+1/+1" ? amount : -amount;
    target.creature.power = Math.max(0, target.creature.power + statDelta);
    target.creature.toughness = Math.max(0, target.creature.toughness + statDelta);
  }
  log(`${entry.sourceCard ?? "Effect"} ${direction > 0 ? "adds" : "removes"} ${Math.abs(amount)} ${counterType} counter(s)`);
}

function resolveTapEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry,
  tapped: boolean
) {
  const byId = selectedPermanentTarget(state, entry);
  const target = byId?.permanent
    ? { controller: byId.controller, card: byId.permanent.face ?? byId.permanent.cardName }
    : effect.target === "self"
    ? findSourcePermanent(state, player, entry.sourceCard)
    : hasExplicitPermanentTarget(entry.action)
    ? null
    : selectEffectPermanentTarget(state, player, effect);
  if (!target) return;
  const permanent = state.permanents?.[target.controller]?.find(
    (candidate) => candidate.cardName === target.card || candidate.face === target.card
  );
  if (permanent) {
    permanent.tapped = tapped;
    if (tapped && effect.duration === "UNTIL_YOUR_NEXT_TURN") {
      permanent.skipUntapUntilTurn = state.turn + 1;
    }
  }
  const creature = state.creatures[target.controller]?.find((item) => item.name === target.card);
  if (creature) creature.tapped = tapped;
}

function gainControlEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry,
  log: (msg: string) => void
) {
  if (effect.target === "eachCreature") {
    for (let controller = 0; controller < state.creatures.length; controller++) {
      if (controller === player) continue;
      for (const creature of [...state.creatures[controller]]) {
        const permanent = state.permanents?.[controller]?.find(
          (candidate) => candidate.id === creature.id || candidate.cardName === creature.name || candidate.face === creature.name
        );
        if (!permanent) continue;
        const previousController = controller;
        movePermanentController(state, previousController, player, permanent);
        if (effect.duration && effect.duration !== "PERMANENT") {
          rememberTemporaryEffect(state, {
            sourceCard: entry.sourceCard,
            controller: player,
            previousController,
            targetPermanentId: permanent.id,
            targetCard: permanent.face ?? permanent.cardName,
            effect,
            expires: effect.duration,
          });
        }
      }
    }
    log(`${entry.sourceCard ?? "Effect"} gives Player ${player} control of all creatures`);
    return;
  }
  const target = selectedPermanentTarget(state, entry) ??
    (hasExplicitPermanentTarget(entry.action) ? null : effect.target === "targetCreature"
      ? findCounterTarget(state, player, { ...effect, target: "targetCreature" }, entry)
      : selectPermanentStateTarget(state, player));
  if (!target?.permanent) return fizzleObject(state, entry.sourceCard ?? "effect", log, "control target is no longer legal");
  const previousController = target.controller;
  if (previousController === player) return;
  movePermanentController(state, previousController, player, target.permanent);
  if (effect.duration && effect.duration !== "PERMANENT") {
    rememberTemporaryEffect(state, {
      sourceCard: entry.sourceCard,
      controller: player,
      previousController,
      targetPermanentId: target.permanent.id,
      targetCard: target.permanent.face ?? target.permanent.cardName,
      effect,
      expires: effect.duration,
    });
  }
  log(`${entry.sourceCard ?? "Effect"} gives Player ${player} control of ${target.permanent.face ?? target.permanent.cardName}`);
}

function modifyPowerToughnessEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry,
  log: (msg: string) => void
) {
  const target = selectedPermanentTarget(state, entry) ??
    (hasExplicitPermanentTarget(entry.action) ? null : findCounterTarget(state, player, { ...effect, target: "targetCreature" }, entry));
  if (!target?.creature) return fizzleObject(state, entry.sourceCard ?? "effect", log, "creature target is no longer legal");
  target.creature.power += effect.powerDelta ?? 0;
  target.creature.toughness += effect.toughnessDelta ?? 0;
  if (effect.duration && effect.duration !== "PERMANENT") {
    rememberTemporaryEffect(state, {
      sourceCard: entry.sourceCard,
      controller: player,
      targetPermanentId: target.permanent?.id ?? target.creature.id,
      targetCard: target.creature.name,
      effect,
      expires: effect.duration,
    });
  }
  log(`${entry.sourceCard ?? "Effect"} modifies ${target.creature.name} by ${effect.powerDelta ?? 0}/${effect.toughnessDelta ?? 0}`);
}

function grantKeywordEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry,
  log: (msg: string) => void
) {
  if (!effect.keyword) return;
  const target = selectedPermanentTarget(state, entry) ??
    (hasExplicitPermanentTarget(entry.action) ? null : findCounterTarget(state, player, { ...effect, target: "targetCreature" }, entry));
  if (!target?.creature) return;
  target.creature.keywords = addKeyword(target.creature.keywords, effect.keyword);
  if (target.permanent) target.permanent.keywords = addKeyword(target.permanent.keywords, effect.keyword);
  if (effect.keyword.toLowerCase() === "haste") {
    target.creature.summoningSickness = false;
    if (target.permanent) target.permanent.summoningSickness = false;
  }
  if (effect.duration && effect.duration !== "PERMANENT") {
    rememberTemporaryEffect(state, {
      sourceCard: entry.sourceCard,
      controller: player,
      targetPermanentId: target.permanent?.id ?? target.creature.id,
      targetCard: target.creature.name,
      effect,
      expires: effect.duration,
    });
  }
  log(`${entry.sourceCard ?? "Effect"} grants ${effect.keyword} to ${target.creature.name}`);
}

function searchLibraryToZone(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  log: (msg: string) => void,
  source?: CardName
) {
  const library = state.libraries[player] ?? [];
  const alternatives = effect.subtypeAlternatives?.length
    ? effect.subtypeAlternatives
    : effect.subtype
      ? [effect.subtype]
      : [];
  const index = library.findIndex((card) => {
    const metadata = getCardMetadata(state, player, card);
    if (alternatives.length) {
      const typeLine = (metadata?.typeLine ?? card).toLowerCase();
      return alternatives.some((alternative) => typeLine.includes(alternative.toLowerCase()));
    }
    return isLandCard(state, player, card);
  });
  const toZone = effect.toZone ?? "hand";
  if (index >= 0) {
    const [card] = library.splice(index, 1);
    if (toZone === "battlefield") {
      state.battlefields[player].push(card);
      addPermanentState(state, {
        cardName: card,
        owner: player,
        controller: player,
        face: card,
        tapped: effect.tapped ?? false,
      });
    } else if (toZone === "graveyard") {
      state.graveyards[player].push(card);
    } else if (toZone === "exile") {
      const exileZones = ensureExileZones(state);
      exileZones[player].push(card);
    } else {
      state.hands[player].push(card);
    }
    log(`${source ?? "Effect"} searches ${card} to ${toZone}`);
  } else {
    log(`${source ?? "Effect"} finds no matching card in the library`);
  }
  if (effect.shuffleAfterSearch) {
    state.libraries[player] = shuffle(library);
    log(`Player ${player} shuffles their library`);
  }
}

function findGraveyardTarget(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry
): { owner: number; card: CardName; index: number } | null {
  const explicit = selectedGraveyardTarget(state, player, effect, entry);
  if (explicit) return explicit;
  if (hasExplicitGraveyardTarget(entry.action)) return null;
  const owner = effect.controller === "opponent"
    ? findNextOpponent(state, player) ?? player
    : player;
  const graveyard = state.graveyards[owner] ?? [];
  const namedTarget = entry.action.type === "CAST_SPELL" ? entry.action.targetGraveyardCard : undefined;
  if (namedTarget) {
    const index = graveyard.findIndex((card) => card === namedTarget);
    if (index >= 0 && graveyardCardMatches(state, owner, graveyard[index], effect)) {
      return { owner, card: graveyard[index], index };
    }
    return null;
  }
  const index = graveyard.findIndex((card) => graveyardCardMatches(state, owner, card, effect));
  return index >= 0 ? { owner, card: graveyard[index], index } : null;
}

function parseGraveyardTargetId(id: string): { owner: number; index: number; card: CardName } | null {
  const [ownerRaw, zone, indexRaw, ...cardParts] = id.split(":");
  if (zone !== "graveyard") return null;
  const owner = Number(ownerRaw);
  const index = Number(indexRaw);
  const card = cardParts.join(":");
  if (!Number.isInteger(owner) || !Number.isInteger(index) || !card) return null;
  return { owner, index, card };
}

function graveyardCardMatches(
  state: SimGameState,
  owner: number,
  card: CardName,
  effect: Pick<NonNullable<StackEntry["effects"]>[number], "cardType" | "subtype">
) {
  const metadata = getCardMetadata(state, owner, card);
  const text = `${metadata?.typeLine ?? ""} ${card}`.toLowerCase();
  if (effect.cardType && effect.cardType !== "card") {
    if (effect.cardType === "permanent") {
      if (!isPermanentCard(card, metadata)) return false;
    } else if (!text.includes(effect.cardType)) {
      return false;
    }
  }
  if (effect.subtype && !text.includes(effect.subtype.toLowerCase())) return false;
  return true;
}

function putCardOntoBattlefieldFromZone(
  state: SimGameState,
  player: number,
  card: CardName,
  log: (msg: string) => void
) {
  const metadata = getCardMetadata(state, player, card);
  if (isCreatureCard(card, metadata)) {
    summonCreature(state, player, getSpellPermanentName(card, metadata), log, metadata);
    addPermanentState(state, {
      cardName: card,
      owner: player,
      controller: player,
      face: getSpellPermanentName(card, metadata),
      tapped: false,
      summoningSickness: true,
    });
    dispatchRulesEvent(state, {
      type: "PERMANENT_ENTERED",
      player,
      controller: player,
      card,
      face: getSpellPermanentName(card, metadata),
    }, log, metadata);
    return;
  }
  placePermanent(state, player, card, metadata, log);
}

function findCounterTarget(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  entry: StackEntry
): { controller: number; permanent?: PermanentState; creature?: CreaturePermanent } | null {
  const explicit = selectedPermanentTarget(state, entry);
  if (explicit) return explicit;
  if (effect.target === "targetPermanent") {
    const permanent = selectPermanentStateTarget(state, player);
    return permanent;
  }
  const creature = selectCreatureTarget(state, player, { friendlyOnly: false });
  if (!creature) return null;
  return {
    controller: creature.controller,
    creature: creature.creature,
    permanent: state.permanents?.[creature.controller]?.find(
      (candidate) => candidate.cardName === creature.creature.name || candidate.face === creature.creature.name
    ),
  };
}

function findPermanentTargetById(
  state: SimGameState,
  targetId: string
): { controller: number; permanent?: PermanentState; creature?: CreaturePermanent } | null {
  ensurePermanentZones(state);
  const creature = findCreatureTargetById(state, targetId);
  if (creature) {
    return {
      controller: creature.controller,
      creature: creature.creature,
      permanent: state.permanents?.[creature.controller]?.find(
        (candidate) => candidate.id === targetId || candidate.cardName === creature.creature.name || candidate.face === creature.creature.name
      ),
    };
  }
  for (let controller = 0; controller < state.permanents!.length; controller++) {
    const permanent = state.permanents?.[controller]?.find((candidate) => candidate.id === targetId);
    if (permanent) {
      const card = permanent.face ?? permanent.cardName;
      const creaturePermanent = state.creatures[controller]?.find(
        (candidate) => candidate.id === permanent.id || candidate.name === card || candidate.name === permanent.cardName
      );
      return { controller, permanent, creature: creaturePermanent };
    }
  }
  return null;
}

function selectPermanentStateTarget(
  state: SimGameState,
  player: number
): { controller: number; permanent?: PermanentState } | null {
  for (let controller = 0; controller < state.permanents!.length; controller++) {
    if (controller === player) continue;
    const permanent = state.permanents?.[controller]?.[0];
    if (permanent) return { controller, permanent };
  }
  return null;
}

function sacrificePermanent(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number],
  log: (msg: string) => void
) {
  const target = selectSacrificeTarget(state, player, effect);
  if (!target) return;
  sacrificeBattlefieldPermanent(state, target.controller, target.card, log);
}

function selectSacrificeTarget(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number]
): { controller: number; card: string } | null {
  const controller = effect.controller === "opponent"
    ? findNextOpponent(state, player) ?? player
    : player;
  return selectControlledPermanentByType(state, controller, effect.cardType ?? "permanent");
}

function selectControlledPermanentByType(
  state: SimGameState,
  controller: number,
  cardType: NonNullable<NonNullable<StackEntry["effects"]>[number]["cardType"]> | NonNullable<CostDescriptor["cardType"]>
): { controller: number; card: string } | null {
  return getControlledPermanentsByType(state, controller, cardType)[0] ?? null;
}

function getControlledPermanentsByType(
  state: SimGameState,
  controller: number,
  cardType: NonNullable<NonNullable<StackEntry["effects"]>[number]["cardType"]> | NonNullable<CostDescriptor["cardType"]>
): Array<{ controller: number; card: string }> {
  const battlefield = state.battlefields[controller] ?? [];
  const results: Array<{ controller: number; card: string }> = [];
  for (const card of battlefield) {
    const metadata = getCardMetadata(state, controller, card);
    if (
      cardType === "creature" &&
      !isCreatureCard(card, metadata) &&
      !state.creatures[controller]?.some((creature) => creature.name === card)
    ) continue;
    if (cardType === "artifact" && !isArtifactCard(card, metadata)) continue;
    if (cardType === "enchantment" && !(metadata?.typeLine ?? "").toLowerCase().includes("enchantment")) continue;
    if (cardType === "permanent" && !isPermanentCard(card, metadata)) continue;
    results.push({ controller, card });
  }
  return results;
}

function sacrificeBattlefieldPermanent(
  state: SimGameState,
  controller: number,
  card: string,
  log: (msg: string) => void
) {
  const creature = state.creatures[controller]?.find((candidate) => candidate.name === card);
  if (creature) {
    destroyCreatureWithEvents(state, controller, creature.id, log);
    log(`Player ${controller} sacrifices ${card}`);
    return;
  }
  removePermanentFromBattlefieldOnly(state, controller, card);
  state.graveyards[controller].push(card);
  dispatchRulesEvent(state, {
    type: "PERMANENT_LEFT",
    controller,
    card,
    sourceCard: card,
  }, log, getCardMetadata(state, controller, card));
  log(`Player ${controller} sacrifices ${card}`);
}

function sacrificePermanentById(
  state: SimGameState,
  controller: number,
  permanentId: string,
  log: (msg: string) => void
) {
  const permanent = state.permanents?.[controller]?.find((candidate) => candidate.id === permanentId);
  if (!permanent) return false;
  const card = permanent.face ?? permanent.cardName;
  const creature = state.creatures[controller]?.find((candidate) => candidate.id === permanentId);
  if (creature) {
    destroyCreatureWithEvents(state, controller, creature.id, log);
    log(`Player ${controller} sacrifices ${card}`);
    return true;
  }
  removeStringFromZone(state.battlefields[controller], card);
  removeStringFromZone(state.artifacts[controller] ?? [], card);
  removePermanentStateById(state, controller, permanentId);
  state.graveyards[controller].push(permanent.cardName);
  dispatchRulesEvent(state, {
    type: "PERMANENT_LEFT",
    controller,
    card: permanent.cardName,
    face: permanent.face,
    permanentId,
    sourceCard: permanent.cardName,
  }, log, getCardMetadata(state, controller, permanent.cardName));
  log(`Player ${controller} sacrifices ${card}`);
  return true;
}

function movePermanentController(
  state: SimGameState,
  fromController: number,
  toController: number,
  permanent: PermanentState
) {
  ensurePermanentZones(state);
  const card = permanent.face ?? permanent.cardName;
  removeStringFromZone(state.battlefields[fromController], card);
  state.battlefields[toController].push(card);
  removeStringFromZone(state.artifacts[fromController] ?? [], card);
  const metadata = getCardMetadata(state, fromController, card) ?? getCardMetadata(state, fromController, permanent.cardName);
  if (isArtifactCard(card, metadata)) {
    state.artifacts[toController] ??= [];
    state.artifacts[toController].push(card);
  }
  const fromList = state.permanents?.[fromController] ?? [];
  const index = fromList.findIndex((candidate) => candidate.id === permanent.id);
  if (index >= 0) fromList.splice(index, 1);
  permanent.controller = toController;
  state.permanents![toController].push(permanent);

  const creatureIndex = state.creatures[fromController]?.findIndex((creature) =>
    creature.id === permanent.id || creature.name === card || creature.name === permanent.cardName
  ) ?? -1;
  if (creatureIndex >= 0) {
    const [creature] = state.creatures[fromController].splice(creatureIndex, 1);
    state.creatures[toController].push(creature);
  }
}

function removeStringFromZone(zone: string[], card: string) {
  const index = zone.indexOf(card);
  if (index >= 0) zone.splice(index, 1);
}

function rememberTemporaryEffect(
  state: SimGameState,
  options: Omit<TemporaryEffect, "id" | "createdTurn">
) {
  state.temporaryEffects ??= [];
  state.temporaryEffects.push({
    id: `temp_${Date.now()}_${state.temporaryEffects.length}`,
    createdTurn: state.turn,
    ...options,
  });
}

export function cleanupTemporaryEffects(
  state: SimGameState,
  activePlayer: number,
  log: (msg: string) => void
) {
  const effects = state.temporaryEffects ?? [];
  const remaining: TemporaryEffect[] = [];
  for (const temp of effects) {
    const expiresNow = temp.expires === "UNTIL_END_OF_TURN" && temp.controller === activePlayer;
    if (!expiresNow) {
      remaining.push(temp);
      continue;
    }
    revertTemporaryEffect(state, temp, log);
  }
  state.temporaryEffects = remaining;
}

function revertTemporaryEffect(
  state: SimGameState,
  temp: TemporaryEffect,
  log: (msg: string) => void
) {
  const current = temp.targetPermanentId ? findPermanentTargetById(state, temp.targetPermanentId) : null;
  if (temp.effect.type === "GAIN_CONTROL" && current?.permanent && temp.previousController !== undefined) {
    movePermanentController(state, current.controller, temp.previousController, current.permanent);
    log(`${temp.sourceCard ?? "Effect"} control effect ends for ${temp.targetCard ?? current.permanent.cardName}`);
    return;
  }
  if (temp.effect.type === "MODIFY_POWER_TOUGHNESS" && current?.creature) {
    current.creature.power -= temp.effect.powerDelta ?? 0;
    current.creature.toughness -= temp.effect.toughnessDelta ?? 0;
    log(`${temp.sourceCard ?? "Effect"} power/toughness effect ends for ${temp.targetCard ?? current.creature.name}`);
    return;
  }
  if (temp.effect.type === "GRANT_KEYWORD" && temp.effect.keyword && current?.creature) {
    current.creature.keywords = removeKeyword(current.creature.keywords, temp.effect.keyword);
    if (current.permanent) current.permanent.keywords = removeKeyword(current.permanent.keywords, temp.effect.keyword);
  }
}

function addKeyword(existing: string[] | undefined, keyword: string) {
  const next = new Set(existing ?? []);
  next.add(keyword.toLowerCase());
  return [...next];
}

function removeKeyword(existing: string[] | undefined, keyword: string) {
  return (existing ?? []).filter((candidate) => candidate.toLowerCase() !== keyword.toLowerCase());
}

function findEffectPlayerTarget(
  state: SimGameState,
  player: number,
  target?: NonNullable<StackEntry["effects"]>[number]["target"]
) {
  if (target === "self") return player;
  if (target === "opponent") return findNextOpponent(state, player);
  return player;
}

function findSourcePermanent(
  state: SimGameState,
  player: number,
  source?: CardName
): { controller: number; card: string } | null {
  if (!source) return null;
  const normalized = source.toLowerCase();
  const permanent = state.permanents?.[player]?.find(
    (candidate) =>
      candidate.cardName.toLowerCase() === normalized ||
      candidate.face?.toLowerCase() === normalized
  );
  if (permanent) return { controller: player, card: permanent.face ?? permanent.cardName };
  const card = state.battlefields[player]?.find((item) => item.toLowerCase() === normalized);
  return card ? { controller: player, card } : null;
}

function selectEffectPermanentTarget(
  state: SimGameState,
  player: number,
  effect: Pick<NonNullable<StackEntry["effects"]>[number], "target">
): { controller: number; card: string } | null {
  if (effect.target === "self") {
    const own = state.battlefields[player]?.[0];
    return own ? { controller: player, card: own } : null;
  }
  return selectBattlefieldPermanent(state, player, () => true);
}

function selectablePermanentsForEffect(
  state: SimGameState,
  player: number,
  effect: NonNullable<StackEntry["effects"]>[number]
): Array<{ controller: number; permanent: PermanentState }> {
  const selection = effect.selection;
  if (!selection || selection.zone !== "battlefield" || selection.controllerRelation !== "YOU") return [];
  ensurePermanentZones(state);
  return (state.permanents?.[player] ?? [])
    .filter((permanent) => permanentMatchesSelection(state, player, permanent, selection.cardType))
    .map((permanent) => ({ controller: player, permanent }));
}

function permanentMatchesSelection(
  state: SimGameState,
  controller: number,
  permanent: PermanentState,
  cardType: NonNullable<NonNullable<StackEntry["effects"]>[number]["selection"]>["cardType"]
) {
  const card = permanent.face ?? permanent.cardName;
  const metadata = getCardMetadata(state, controller, permanent.cardName) ??
    getCardMetadata(state, controller, card);
  if (cardType === "land") return isLandCard(state, controller, card);
  if (cardType === "creature") return isCreatureCard(card, metadata);
  if (cardType === "artifact") return isArtifactCard(card, metadata);
  if (cardType === "permanent") return isPermanentCard(card, metadata);
  const typeLine = metadata?.typeLine?.toLowerCase() ?? "";
  return typeLine.includes(cardType);
}

function removePermanentFromBattlefieldOnly(
  state: SimGameState,
  controller: number,
  card: string
) {
  const battlefield = state.battlefields[controller];
  const index = battlefield.indexOf(card);
  if (index >= 0) battlefield.splice(index, 1);
  removePermanentState(state, controller, card);
  const creatureIndex = state.creatures[controller]?.findIndex((creature) => creature.name === card) ?? -1;
  if (creatureIndex >= 0) state.creatures[controller].splice(creatureIndex, 1);
}

function removePermanentFromBattlefieldById(
  state: SimGameState,
  controller: number,
  permanentId: string
): PermanentState | null {
  const permanent = removePermanentStateById(state, controller, permanentId);
  if (!permanent) return null;
  const face = permanent.face ?? permanent.cardName;
  const battlefield = state.battlefields[controller] ?? [];
  const battlefieldIndex = battlefield.indexOf(face);
  if (battlefieldIndex >= 0) battlefield.splice(battlefieldIndex, 1);
  const creatureIndex = state.creatures[controller]?.findIndex((creature) =>
    creature.id === permanent.id ||
    creature.name === face ||
    creature.name === permanent.cardName
  ) ?? -1;
  if (creatureIndex >= 0) state.creatures[controller].splice(creatureIndex, 1);
  if (permanent.tapped) {
    const key = face.toLowerCase();
    const tapped = state.tappedPermanents?.[controller];
    if (tapped?.[key]) {
      tapped[key] -= 1;
      if (tapped[key] <= 0) delete tapped[key];
    }
  }
  return permanent;
}

function ensureExileZones(state: SimGameState): CardName[][] {
  const withExiles = state as SimGameState & { exiles?: CardName[][] };
  withExiles.exiles ??= Array.from({ length: state.lifeTotals.length }, () => []);
  for (let i = 0; i < state.lifeTotals.length; i++) {
    withExiles.exiles[i] ??= [];
  }
  return withExiles.exiles;
}

export function castSpellToStack(
  state: SimGameState,
  player: number,
  action: Extract<SimAction, { type: "CAST_SPELL" }>,
  log: (msg: string) => void
) {
  const card = action.card;
  const metadata = getCardMetadata(state, player, card);
  const selectedFaceId = selectedFaceIdForAction(action) ?? getSpellFaceMetadata(metadata)?.name;
  const selectedFace = resolveSelectedFace(metadata, selectedFaceId);
  const spellMetadata = metadataForSelectedFace(metadata, selectedFaceId);
  logMdfcDiagnostic(log, {
    card: metadata?.name ?? card,
    selectedFace: selectedFace?.name,
    action: "CAST_SPELL",
    typeLine: selectedFace?.typeLine,
    oracleText: selectedFace?.oracleText,
    result: "CAST",
  });
  const sourceZone = action.sourceZone ?? "HAND";
  const paymentPlan = requireManaPaymentPlan(state, player, card, spellMetadata, log, sourceZone);
  applyManaPaymentPlan(state, player, paymentPlan);
  payAdditionalCosts(state, player, spellMetadata, log);
  if (sourceZone === "COMMAND") {
    removeCardFromZone(state.commandZone?.[player], card);
    recordCommanderCastFromCommand(state, player, card);
  } else {
    removeCardFromZone(state.hands[player], card);
  }
  emitRulesEvent(state, {
    type: "SPELL_CAST",
    player,
    controller: player,
    card,
  });
  log(`Player ${player} casts ${card}`);
}

function createStackEntryForAction(
  state: SimGameState,
  player: number,
  action: Extract<SimAction, { type: "CAST_SPELL" | "ACTIVATE_ABILITY" }>
): StackEntry {
  if (action.type === "ACTIVATE_ABILITY") {
    const ability = findActivatedAbilityForAction(state, player, action);
    return {
      id: `stack_${Date.now()}_${player}_${state.stack.length}`,
      action,
      casterIndex: player,
      resolved: false,
      responses: [],
      kind: "activatedAbility",
      sourceCard: ability?.sourcePermanent?.face ?? ability?.sourcePermanent?.cardName,
      sourcePermanentId: action.sourcePermanentId,
      abilityId: action.abilityId,
      patternId: ability?.ability.patternId,
      eventType: "ACTIVATED",
      turn: state.turn,
      phase: state.phaseStep || state.phase,
      effects: selectedAbilityEffects([ability?.ability].filter(Boolean) as ParsedAbility[], action),
      targets: action.targets,
      ability: ability?.ability,
    };
  }
  const metadata = getCardMetadata(state, player, action.card);
  const spellMetadata = metadataForSelectedFace(metadata, selectedFaceIdForAction(action) ?? getSpellFaceMetadata(metadata)?.name);
  const abilities = parseCardRules(spellMetadata ?? { name: action.card }).abilities.filter((ability) => ability.kind === "SPELL_EFFECT");
  return {
    id: `stack_${Date.now()}_${player}_${state.stack.length}`,
    action,
    casterIndex: player,
    resolved: false,
    responses: [],
    kind: "spell",
    sourceCard: action.card,
    abilityId: "SPELL",
    patternId: "SPELL",
    eventType: "SPELL_CAST",
    turn: state.turn,
    phase: state.phaseStep || state.phase,
    effects: selectedAbilityEffects(abilities, action),
    targets: action.targets,
  };
}

function selectedAbilityEffects(
  abilities: ParsedAbility[],
  action: Extract<SimAction, { type: "CAST_SPELL" | "ACTIVATE_ABILITY" }>
) {
  const selectedModes = new Set(action.modes ?? []);
  return abilities
    .filter((ability) => selectedModes.size === 0 ? !ability.modeId : (ability.modeId && selectedModes.has(ability.modeId)))
    .filter((ability) => {
      const optionalId = ability.patternId ?? ability.abilityId ?? ability.modeId;
      if (!optionalId || !ability.effects.some((effect) => effect.optional)) return true;
      return action.optionalChoices?.[optionalId] !== false;
    })
    .flatMap((ability) => ability.effects);
}

function selectedActionAbilities(
  abilities: ParsedAbility[],
  action: Extract<SimAction, { type: "CAST_SPELL" | "ACTIVATE_ABILITY" }>
) {
  const selectedModes = new Set(action.modes ?? []);
  return abilities.filter((ability) =>
    selectedModes.size === 0 ? !ability.modeId : Boolean(ability.modeId && selectedModes.has(ability.modeId))
  );
}

function allRequiredTargetsStillLegal(
  state: SimGameState,
  player: number,
  action: Extract<SimAction, { type: "CAST_SPELL" | "ACTIVATE_ABILITY" }>,
  abilities: ParsedAbility[]
) {
  for (const ability of selectedActionAbilities(abilities, action)) {
    for (const requirement of ability.targets ?? []) {
      const target = targetForRequirement(state, player, action, requirement);
      if (!target) {
        if (requirement.optional || requirement.required === false) continue;
        return false;
      }
      if (!isLegalTarget(state, player, requirement, target)) return false;
    }
  }
  return true;
}

function targetForRequirement(
  state: SimGameState,
  player: number,
  action: Extract<SimAction, { type: "CAST_SPELL" | "ACTIVATE_ABILITY" }>,
  requirement: NonNullable<ParsedAbility["targets"]>[number]
): { id?: string | number; controller: number; card: CardName; type?: TargetRef["type"] } | null {
  if (requirement.type === "PLAYER" || requirement.zone === "player") {
    const targetRef = action.targets?.find((target) => target.type === "player");
    const targetId = targetRef?.id ?? (action.type === "CAST_SPELL" ? action.targetPlayer : undefined);
    const controller = typeof targetId === "number"
      ? targetId
      : typeof targetId === "string" && /^\d+$/.test(targetId)
        ? Number(targetId)
        : undefined;
    return controller === undefined
      ? null
      : { id: controller, controller, card: `Player ${controller}`, type: "player" };
  }

  if (requirement.type === "SPELL" || requirement.zone === "stack") {
    const targetRef = action.targets?.find((target) => target.type === "stack");
    const targetId = targetRef?.id ?? (action.type === "CAST_SPELL" ? action.targetStackId : undefined);
    if (typeof targetId !== "string") return null;
    const entry = state.stack.find((candidate) => candidate.id === targetId && !candidate.resolved);
    if (!entry) return null;
    return {
      id: entry.id,
      controller: entry.casterIndex,
      card: entry.action.type === "CAST_SPELL" ? entry.action.card : entry.sourceCard ?? entry.action.type,
      type: "stack",
    };
  }

  if (requirement.zone === "graveyard" || requirement.type === "CARD_IN_GRAVEYARD") {
    const targetRef = action.targets?.find((target) => target.type === "card");
    if (typeof targetRef?.id === "string") {
      const parsed = parseGraveyardTargetId(targetRef.id);
      const card = parsed ? state.graveyards[parsed.owner]?.[parsed.index] : undefined;
      return parsed && card === parsed.card
        ? { id: targetRef.id, controller: parsed.owner, card, type: "card" }
        : null;
    }
    const legacyCard = action.type === "CAST_SPELL" ? action.targetGraveyardCard : undefined;
    if (!legacyCard) return null;
    const owners = playerIndicesByRelation(state, player, requirement.owner ?? requirement.controller ?? "self");
    for (const owner of owners) {
      if ((state.graveyards[owner] ?? []).includes(legacyCard)) {
        return { id: `${owner}:graveyard:${state.graveyards[owner].indexOf(legacyCard)}:${legacyCard}`, controller: owner, card: legacyCard, type: "card" };
      }
    }
    return null;
  }

  const targetRef = action.targets?.find((target) =>
    target.type === "permanent" || target.type === "creature"
  );
  const targetId = targetRef?.id ?? (action.type === "CAST_SPELL" ? action.targetId : undefined);
  if (typeof targetId !== "string") return null;
  const lookup = findPermanentTargetById(state, targetId);
  if (!lookup) return null;
  if ((requirement.type === "CREATURE" || requirement.cardType === "creature") && !lookup.creature) return null;
  const card = lookup.permanent?.face ?? lookup.permanent?.cardName ?? lookup.creature?.name;
  return card
    ? { id: targetId, controller: lookup.controller, card, type: lookup.creature ? "creature" : "permanent" }
    : null;
}

function findActivatedAbilityForAction(
  state: SimGameState,
  player: number,
  action: Extract<SimAction, { type: "ACTIVATE_ABILITY" }>
): { sourcePermanent: PermanentState; ability: ParsedAbility } | null {
  const sourcePermanent = state.permanents?.[player]?.find((permanent) => permanent.id === action.sourcePermanentId);
  if (!sourcePermanent) return null;
  const metadata = getCardMetadata(state, player, sourcePermanent.cardName) ??
    getCardMetadata(state, player, sourcePermanent.face ?? sourcePermanent.cardName);
  const ability = activatedAbilitiesForPermanent(metadata, sourcePermanent)
    .find((candidate) => candidate.abilityId === action.abilityId);
  return ability ? { sourcePermanent, ability } : null;
}

export function activateAbilityToStack(
  state: SimGameState,
  player: number,
  action: Extract<SimAction, { type: "ACTIVATE_ABILITY" }>,
  log: (msg: string) => void
): StackEntry | null {
  const found = findActivatedAbilityForAction(state, player, action);
  if (
    !found ||
    !canPayAbilityCosts(state, player, found.sourcePermanent, found.ability.costs ?? []) ||
    !allRequiredTargetsStillLegal(state, player, action, [found.ability])
  ) {
    throw new Error(`Illegal activation: ${action.abilityId}`);
  }
  const sourceName = found.sourcePermanent.face ?? found.sourcePermanent.cardName;
  const stackEntry: StackEntry = {
    id: `stack_${Date.now()}_${player}_${state.stack.length}`,
    action,
    casterIndex: player,
    resolved: false,
    responses: [],
    kind: "activatedAbility",
    sourceCard: sourceName,
    sourcePermanentId: found.sourcePermanent.id,
    abilityId: action.abilityId,
    patternId: found.ability.patternId,
    eventType: "ACTIVATED",
    turn: state.turn,
    phase: state.phaseStep || state.phase,
    effects: selectedAbilityEffects([found.ability], action),
    targets: action.targets,
    ability: found.ability,
  };
  payAbilityCosts(state, player, found.sourcePermanent, found.ability.costs ?? [], log);
  if (found.ability.effects.every((effect) => effect.type === "ADD_MANA")) {
    resolveEffectDescriptors(state, {
      ...stackEntry,
      id: `mana_${Date.now()}_${player}`,
      action,
      resolved: true,
    }, log);
    log(`Player ${player} activates mana ability of ${sourceName}`);
    return null;
  }
  log(`Player ${player} activates ${sourceName}`);
  return stackEntry;
}

function payAbilityCosts(
  state: SimGameState,
  player: number,
  source: PermanentState,
  costs: CostDescriptor[],
  log: (msg: string) => void
) {
  for (const cost of costs) {
    if (cost.type === "TAP") {
      source.tapped = true;
      const creature = state.creatures[player]?.find((candidate) => candidate.id === source.id);
      if (creature) creature.tapped = true;
      continue;
    }
    if (cost.type === "MANA") {
      const plan = findManaPaymentPlan(state, player, cost.mana!);
      if (!plan.legal) throw new Error("Cannot pay activated ability mana cost");
      applyManaPaymentPlan(state, player, plan);
      continue;
    }
    if (cost.type === "PAY_LIFE") {
      state.lifeTotals[player] -= cost.life ?? cost.amount ?? 0;
      continue;
    }
    if (cost.type === "SACRIFICE") {
      if (cost.source) {
        if (!sacrificePermanentById(state, player, source.id, log)) {
          throw new Error("Cannot pay source sacrifice cost");
        }
        continue;
      }
      for (let i = 0; i < (cost.amount ?? 1); i++) {
        const target = selectControlledPermanentByType(state, player, cost.cardType ?? "permanent");
        if (!target) throw new Error("Cannot pay activated ability sacrifice cost");
        sacrificeBattlefieldPermanent(state, target.controller, target.card, log);
      }
    }
  }
}

interface ActionWindowRules {
  allowInstant: boolean;
  allowSorcery: boolean;
  allowLand: boolean;
}

async function processActionWindow(
  state: SimGameState,
  agents: SimAgent[],
  player: number,
  history: SimulationResult["history"],
  log: (message: string) => void,
  context: TurnContext,
  rules: ActionWindowRules,
  snapshotEntries: StepSnapshotEntry[],
  onStateChange?: (state: SimGameState, event: GameEvent) => void,
  onAiDecisionTrace?: (trace: AiDecisionTrace) => void,
  enableStack = false,
  pauseForAction: () => Promise<void> = () => Promise.resolve()
): Promise<number | null> {
  if (!rules.allowInstant && !rules.allowSorcery && !rules.allowLand) return null;

  for (let count = 0; count < MAX_ACTIONS_PER_WINDOW; count++) {
    checkEpisodeWatchdog(state);
    const generationContext = {
      landDropsUsedThisTurn: context.landDropsUsedThisTurn,
      maxLandDrops: context.maxLandDrops,
      allowInstant: rules.allowInstant,
      allowSorcery: rules.allowSorcery,
      allowLand: rules.allowLand,
    };
    const available = timeBlock("generateActions", () =>
      generateActions(state, player, generationContext)
    );
    if (isSecondMainPhase(state)) {
      turnContextRecordSecondMainLandDrop(context, available);
    }
    recordActionWindow(state, player, available);
    const availableSnapshot = cloneActions(available);
    const requiresManualPass = agents[player]?.id === "human";
    if (availableSnapshot.length === 1 && !requiresManualPass) break;

    const snapshot = cloneState(state);
    const forcedLandDrop = selectForcedSecondMainLandDrop(
      state,
      context,
      availableSnapshot
    );
    const beforeDecisionTelemetry = decisionTelemetrySnapshot();
    const decisionStartedAt = performance.now();
    const beforeCanonicalState = canonicalStateFingerprint(state);
    let decision = forcedLandDrop
      ? {
          action: forcedLandDrop,
          metadata: {
            source: "heuristic" as const,
            reasoning: "strategic_land_drop_invariant",
            selection: {
              selectedBy: "engine_land_drop_invariant",
              selectionReason: "selected first legal land because second-main land drop is invariant-enforced",
              selectionValueName: "land_drop_rule",
              selectionCandidates: availableSnapshot.filter((candidate) => candidate.type === "PLAY_LAND"),
            },
          },
        }
      : await timeAsync("AI chooseAction", () =>
          Promise.resolve(agents[player].decideAction(snapshot, availableSnapshot))
        );
    const landDropOverPass = forcedLandDrop
      ? null
      : selectLandDropOverPass(state, context, availableSnapshot, decision.action);
    if (landDropOverPass) {
      decision = {
        action: landDropOverPass,
        metadata: {
          source: "heuristic" as const,
          reasoning: isSecondMainPhase(state)
            ? "strategic_land_drop_invariant"
            : "strategic_main1_land_drop_over_pass",
          selection: {
            selectedBy: "engine_land_drop_invariant",
            selectionReason: "replaced PASS_TURN with the first legal land while land-drop capacity remained",
            selectionValueName: "land_drop_rule",
            selectionCandidates: availableSnapshot.filter((candidate) =>
              candidate.type === "PLAY_LAND" || candidate.type === "PASS_TURN"
            ),
          },
        },
      };
    }
    decision = {
      ...decision,
      action: hydrateChosenAction(decision.action, availableSnapshot),
    };
    const decisionElapsedMs = performance.now() - decisionStartedAt;
    if (!forcedLandDrop) {
      const afterDecisionTelemetry = decisionTelemetrySnapshot();
      const decisionDelta = telemetryDelta(beforeDecisionTelemetry, afterDecisionTelemetry);
      const dbLookupMs = decisionDelta.dbLookupMs;
      const threshold = envNumber("AI_PERF_LOG_THRESHOLD_MS", 50);
      if (activeDiagnostics?.debugEpisode || decisionElapsedMs >= threshold) {
        log(
          `[AI PERF] player=P${player} phase=${state.phaseStep || state.phase} legal_actions=${availableSnapshot.length} ` +
          `db_lookup_ms=${Math.max(0, dbLookupMs).toFixed(1)} inference_ms=${Math.max(0, decisionElapsedMs - dbLookupMs).toFixed(1)} ` +
          `rules_ms=pending total_ms=${decisionElapsedMs.toFixed(1)} candidates_scanned=${decisionDelta.candidatesScanned} ` +
          `candidates_returned=${decisionDelta.candidatesReturned} fuzzy_lookups=${decisionDelta.fuzzyLookups} action=${actionSummary(decision.action)}`
        );
      }
    }
    const action = decision.action;
    log(`[Action] ${actionSummary(action)}`);
    activeDiagnostics!.data.actionsApplied++;
    activeDiagnostics!.currentTurnActions++;
    activeDiagnostics!.data.maxActionsPerTurn = Math.max(
      activeDiagnostics!.data.maxActionsPerTurn ?? 0,
      activeDiagnostics!.currentTurnActions
    );
    recordRecentAction(state, action);
    checkEpisodeWatchdog(state, action);
    if (activeDiagnostics?.debugEpisode) {
      console.log(`[debug] choose=${actionSummary(action)}`);
    }
    const evaluation = agents[player].traceActionScores?.(snapshot, availableSnapshot) ?? [];
    const trace = buildAiDecisionTrace({
      state: snapshot,
      player,
      context: generationContext,
      legalActions: availableSnapshot,
      evaluation,
      decision,
      decisionStartedAt,
      beforeDecisionTelemetry,
    });
    history.push({
      playerIndex: player,
      agentId: agents[player].id,
      action,
      state: snapshot,
      availableActions: availableSnapshot,
      metadata: decision.metadata,
    });

    if (action.type === "PLAY_LAND") {
      context.landDropsUsedThisTurn++;
    }

    // Phase 2: cattura prev/next snapshot attorno ad applyAction
    const prevSnap = captureSnapshot(state);
    const beforeExecutionState = cloneState(state);
    let rulesEngineMs = 0;
    const measureRules = <T>(fn: () => T): T => {
      const startedAt = performance.now();
      try {
        return fn();
      } finally {
        rulesEngineMs += performance.now() - startedAt;
      }
    };
    let executionSuccess = true;
    let executionFailureReason: string | undefined;
    let fallbackAction: SimAction | undefined;
    try {
      if (enableStack && (action.type === "CAST_SPELL" || action.type === "ACTIVATE_ABILITY")) {
        let stackEntry: StackEntry | null = null;
        if (action.type === "CAST_SPELL") {
          measureRules(() => {
            castSpellToStack(state, player, action, log);
            stackEntry = createStackEntryForAction(state, player, action);
          });
        } else {
          stackEntry = measureRules(() => activateAbilityToStack(state, player, action, log));
          if (!stackEntry) {
            updateTraceAfterExecution(trace, beforeExecutionState, state, {
              attemptedAction: action,
              success: true,
              rulesMs: rulesEngineMs,
            });
            recordAiDecisionTrace(trace, onAiDecisionTrace);
            recordDecisionLog({
              state,
              player,
              availableActions: availableSnapshot.length,
              action,
              beforeDecisionTelemetry,
              decisionElapsedMs,
              rulesEngineMs,
              beforeCanonicalState,
            });
            onStateChange?.(cloneState(state), { type: "action_applied", player, action });
            await pauseForAction();
            continue;
          }
        }
        onStateChange?.(cloneState(state), { type: "action_applied", player, action });
        await pauseForAction();

        measureRules(() => {
          state.stack.push(stackEntry!);
          activeDiagnostics!.data.stackPushes++;
          activeDiagnostics!.data.maxStackDepth = Math.max(activeDiagnostics!.data.maxStackDepth, state.stack.length);
          recordStackTrace(state, "push", stackEntry!);
        });
        await timeAsync("resolveStack", () =>
          resolveStackWithPriority(state, player, agents, log, onStateChange, pauseForAction)
        );
        onStateChange?.(cloneState(state), { type: "action_applied", player, action });
        await pauseForAction();
      } else {
        measureRules(() => timeBlock("applyAction", () => applyAction(state, action, player, log)));
        onStateChange?.(cloneState(state), { type: "action_applied", player, action });
        await pauseForAction();
      }
    } catch (err) {
      executionSuccess = false;
      executionFailureReason = err instanceof Error ? err.message : String(err);
      fallbackAction = { type: "PASS_TURN" };
      if (action.type === "PLAY_LAND") {
        context.landDropsUsedThisTurn = Math.max(0, context.landDropsUsedThisTurn - 1);
      }
      log(`[AI Execution] ${actionSummary(action)} failed: ${executionFailureReason}; fallback=PASS_TURN`);
    }
    updateTraceAfterExecution(trace, beforeExecutionState, state, {
      attemptedAction: action,
      success: executionSuccess,
      failureReason: executionFailureReason,
      fallbackAction,
      rulesMs: rulesEngineMs,
    });
    recordAiDecisionTrace(trace, onAiDecisionTrace);
    recordDecisionLog({
      state,
      player,
      availableActions: availableSnapshot.length,
      action,
      beforeDecisionTelemetry,
      decisionElapsedMs,
      rulesEngineMs,
      beforeCanonicalState,
    });

    const nextSnap = captureSnapshot(state);
    snapshotEntries.push({ playerIndex: player, prevSnapshot: prevSnap, nextSnapshot: nextSnap, action });

    const winner = checkForWinner(state);
    if (winner !== null) return winner;
    if (fallbackAction?.type === "PASS_TURN") break;
    if (action.type === "PASS_TURN") break;
  }

  while (rules.allowLand) {
    const landActions = generateActions(state, player, {
      landDropsUsedThisTurn: context.landDropsUsedThisTurn,
      maxLandDrops: context.maxLandDrops,
      allowInstant: false,
      allowSorcery: false,
      allowLand: true,
    });
    if (isSecondMainPhase(state)) {
      turnContextRecordSecondMainLandDrop(context, landActions);
    }
    const landAction = selectForcedSecondMainLandDrop(
      state,
      context,
      landActions
    );
    if (!landAction) break;

    const snapshot = cloneState(state);
    const prevSnap = captureSnapshot(state);
    const decision = {
      action: landAction,
      metadata: {
        source: "heuristic" as const,
        reasoning: "strategic_land_drop_invariant_post_window",
      },
    };
    activeDiagnostics!.data.actionsApplied++;
    recordRecentAction(state, landAction, "forced ");
    history.push({
      playerIndex: player,
      agentId: agents[player].id,
      action: landAction,
      state: snapshot,
      availableActions: [landAction],
      metadata: decision.metadata,
    });
    context.landDropsUsedThisTurn++;
    applyAction(state, landAction, player, log);
    onStateChange?.(cloneState(state), { type: "action_applied", player, action: landAction });
    await pauseForAction();
    const nextSnap = captureSnapshot(state);
    snapshotEntries.push({ playerIndex: player, prevSnapshot: prevSnap, nextSnapshot: nextSnap, action: landAction });
    const winner = checkForWinner(state);
    if (winner !== null) return winner;
  }

  return null;
}

async function resolveCombatTarget(
  state: SimGameState,
  agent: SimAgent,
  player: number
): Promise<number | null> {
  const opponents = getOpponentIndices(state, player);
  if (!opponents.length) return null;
  if (typeof agent.decideTarget === "function") {
    const decision = await Promise.resolve(agent.decideTarget(state, opponents));
    return normalizeTargetSelection(decision, opponents);
  }
  return findNextOpponent(state, player);
}

async function resolveAttackPlanChoice(
  agent: SimAgent,
  state: SimGameState,
  plans: AttackPlan[],
  options: CreaturePermanent[],
  defenderIndex: number
): Promise<{ plan: AttackPlan; metadata: DecisionMetadata }> {
  if (plans.length === 0) {
    return {
      plan: {
        attackers: [],
        targetPlayer: defenderIndex,
        expectedDamage: 0,
        expectedLosses: 0,
        score: 0,
      },
      metadata: { source: "fallback" },
    };
  }

  if (typeof agent.decideAttackPlan === "function") {
    const choice = await Promise.resolve(agent.decideAttackPlan(state, plans));
    return {
      plan: normalizeAttackPlanSelection(choice, plans),
      metadata: { source: "policy" },
    };
  }

  if (typeof agent.decideAttackers === "function") {
    const decision = await Promise.resolve(
      agent.decideAttackers(state, options)
    );
    return {
      plan: attackPlanFromDecision(decision, plans, defenderIndex, options),
      metadata: { source: decision.metadata?.source ?? "fallback" },
    };
  }

  return {
    plan: normalizeAttackPlanSelection(plans[0], plans),
    metadata: { source: "fallback" },
  };
}

async function resolveBlockPlanChoice(
  agent: SimAgent,
  state: SimGameState,
  plans: BlockPlan[],
  attackers: CreaturePermanent[],
  blockers: CreaturePermanent[],
  attackerIds: string[]
): Promise<{ plan: BlockPlan; metadata: DecisionMetadata }> {
  if (typeof agent.decideBlockPlan === "function") {
    const choice = await Promise.resolve(agent.decideBlockPlan(state, plans));
    return {
      plan: normalizeBlockPlanSelection(choice, plans),
      metadata: { source: "policy" },
    };
  }

  if (typeof agent.decideBlockers === "function") {
    const decision = await Promise.resolve(
      agent.decideBlockers(state, attackers, blockers)
    );
    return {
      plan: blockPlanFromDecision(decision, plans, blockers, attackerIds),
      metadata: { source: decision.metadata?.source ?? "fallback" },
    };
  }

  return {
    plan: normalizeBlockPlanSelection(plans[0] ?? emptyBlockPlan(), plans),
    metadata: { source: "fallback" },
  };
}

function normalizeTargetSelection(
  decision: number,
  opponentIndices: number[]
): number {
  const allowed = new Set(opponentIndices);
  if (!allowed.has(decision)) {
    return opponentIndices[0];
  }
  return decision;
}

function normalizeAttackPlanSelection(
  choice: AttackPlan,
  plans: AttackPlan[]
) {
  const normalizedIds = serializeIds(choice.attackers);
  return (
    plans.find(
      (plan) =>
        plan.targetPlayer === choice.targetPlayer &&
        serializeIds(plan.attackers) === normalizedIds
    ) ?? plans[0]
  );
}

function normalizeBlockPlanSelection(
  choice: BlockPlan,
  plans: BlockPlan[]
) {
  if (plans.length === 0) return emptyBlockPlan();
  const choiceKey = serializePlanAssignments(choice.assignments);
  return plans.find((plan) => serializePlanAssignments(plan.assignments) === choiceKey) ?? plans[0];
}

function normalizeBlockPlanAssignments(
  plan: BlockPlan,
  blockers: CreaturePermanent[],
  attackerIds: string[]
): BlockAssignment[] {
  const allowedBlockers = new Set(blockers.map((creature) => creature.id));
  const allowedAttackers = new Set(attackerIds);
  const usedBlockers = new Set<string>();

  const result: BlockAssignment[] = [];
  for (const [attackerId, blockerIds] of plan.assignments.entries()) {
    if (!allowedAttackers.has(attackerId)) continue;
    for (const blockerId of blockerIds) {
      if (!allowedBlockers.has(blockerId)) continue;
      if (usedBlockers.has(blockerId)) continue;
      result.push({ blockerId, attackerId });
      usedBlockers.add(blockerId);
    }
  }
  return result;
}

export function emitCombatDamageTriggers(
  state: SimGameState,
  attackerIndex: number,
  defenderIndex: number,
  attackers: CreaturePermanent[],
  assignments: BlockAssignment[],
  log: (message: string) => void
) {
  const blocked = new Set(assignments.map((assignment) => assignment.attackerId));
  for (const attacker of attackers) {
    if (blocked.has(attacker.id) || attacker.power <= 0) continue;
    const permanent = state.permanents?.[attackerIndex]?.find(
      (candidate) =>
        candidate.id === attacker.id ||
        candidate.cardName === attacker.name ||
        candidate.face === attacker.name
    );
    const metadata = getCardMetadata(state, attackerIndex, permanent?.cardName ?? attacker.name);
    dispatchRulesEvent(state, {
      type: "COMBAT_DAMAGE_DEALT",
      player: attackerIndex,
      controller: attackerIndex,
      card: attacker.name,
      face: permanent?.face,
      permanentId: permanent?.id ?? attacker.id,
      targetPlayer: defenderIndex,
      amount: attacker.power,
      sourceCard: attacker.name,
      data: {
        sourceController: attackerIndex,
        sourceCard: attacker.name,
        sourceFace: permanent?.face,
        sourcePermanentId: permanent?.id ?? attacker.id,
        sourceTypeLine: metadata?.typeLine ?? "",
      },
    }, log);
  }
}

function attackPlanFromDecision(
  decision: AttackDecision,
  plans: AttackPlan[],
  defenderIndex: number,
  options: CreaturePermanent[]
) {
  const allowed = new Set(options.map((creature) => creature.id));
  const selectedIds = [...new Set(decision.attackers)].filter((id) => allowed.has(id));
  return (
    plans.find(
      (plan) =>
        plan.targetPlayer === defenderIndex &&
        serializeIds(plan.attackers) === serializeIds(selectedIds)
    ) ??
    plans[0] ?? {
      attackers: selectedIds,
      targetPlayer: defenderIndex,
      expectedDamage: 0,
      expectedLosses: 0,
      score: 0,
    }
  );
}

function blockPlanFromDecision(
  decision: BlockDecision,
  plans: BlockPlan[],
  blockers: CreaturePermanent[],
  attackerIds: string[]
) {
  const normalizedAssignments = normalizeLegacyBlockAssignments(
    decision.assignments,
    blockers,
    attackerIds
  );
  const key = serializePlanAssignments(assignmentsToPlanMap(normalizedAssignments));
  return plans.find((plan) => serializePlanAssignments(plan.assignments) === key) ?? plans[0] ?? emptyBlockPlan();
}

function normalizeLegacyBlockAssignments(
  assignments: BlockAssignment[] = [],
  blockers: CreaturePermanent[],
  attackerIds: string[]
): BlockAssignment[] {
  if (!assignments.length) return [];
  const allowedBlockers = new Set(blockers.map((creature) => creature.id));
  const allowedAttackers = new Set(attackerIds);
  const usedBlockers = new Set<string>();

  const result: BlockAssignment[] = [];
  for (const assignment of assignments) {
    if (!allowedBlockers.has(assignment.blockerId)) continue;
    if (usedBlockers.has(assignment.blockerId)) continue;
    if (!assignment.attackerId || !allowedAttackers.has(assignment.attackerId)) continue;
    result.push({ blockerId: assignment.blockerId, attackerId: assignment.attackerId });
    usedBlockers.add(assignment.blockerId);
  }
  return result;
}

function assignmentsToPlanMap(assignments: BlockAssignment[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const assignment of assignments) {
    if (!assignment.attackerId) continue;
    const blockers = map.get(assignment.attackerId) ?? [];
    blockers.push(assignment.blockerId);
    map.set(assignment.attackerId, blockers);
  }
  return map;
}

function serializeIds(ids: string[]) {
  return [...ids].sort().join(",");
}

function serializePlanAssignments(assignments: Map<string, string[]>) {
  return [...assignments.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([attackerId, blockerIds]) => `${attackerId}:${[...blockerIds].sort().join(",")}`)
    .join("|");
}

function emptyBlockPlan(): BlockPlan {
  return {
    assignments: new Map(),
    creaturesKilled: 0,
    damagePrevented: 0,
    totalIncomingDamage: 0,
    blockersLost: 0,
    score: 0,
  };
}

function getOpponentIndices(state: SimGameState, player: number) {
  return state.lifeTotals
    .map((life, idx) => ({ life, idx }))
    .filter(({ idx, life }) => idx !== player && life > 0)
    .map(({ idx }) => idx);
}

export function createInitialState(
  players: number,
  playerDecks?: CardName[][],
  playerDeckMetadata?: DeckCardMetadata[][],
  playerCommanders?: Array<CardName | null | undefined>,
  startingPlayerIndex = 0
): SimGameState {
  const lifeTotals = Array(players).fill(40);
  const battlefields = Array(players)
    .fill(null)
    .map(() => []);
  const permanents: PermanentState[][] = Array(players)
    .fill(null)
    .map(() => []);
  const graveyards = Array(players)
    .fill(null)
    .map(() => []);
  const commanders = Array(players)
    .fill(null)
    .map((_, idx) => playerCommanders?.[idx] ?? playerDecks?.[idx]?.[0] ?? "Commander");
  const creatures: SimGameState["creatures"] = Array(players)
    .fill(null)
    .map(() => []);
  const artifacts = Array(players)
    .fill(null)
    .map(() => []);
  const artifactMana = Array(players).fill(0);
  const manaSpent = Array(players).fill(0);
  const commandZone: CardName[][] = [];
  const deckInitAudits: DeckInitAudit[] = [];
  const libraries: CardName[][] = [];
  const hands: CardName[][] = [];
  for (let player = 0; player < players; player++) {
    const inputDeck = playerDecks?.[player] ?? [];
    const source = inputDeck.length ? [...inputDeck] : [...DEFAULT_DECK];
    const configuredCommander = playerCommanders?.[player];
    const commander = commanders[player] ?? "Commander";
    const shouldInitializeCommandZone = configuredCommander != null || source.length >= 99;
    const deckInstances = source.map((cardName, index) => ({
      instanceId: `card_${player}_${index}`,
      cardName,
    }));
    let commanderInstance: { instanceId: string; cardName: CardName } | undefined;
    if (shouldInitializeCommandZone) {
      const commanderIndex = deckInstances.findIndex((instance) =>
        normalizeCardName(instance.cardName) === normalizeCardName(commander)
      );
      commanderInstance = commanderIndex >= 0
        ? deckInstances.splice(commanderIndex, 1)[0]
        : { instanceId: `commander_${player}_0`, cardName: commander };
      commandZone[player] = [commanderInstance.cardName];
    } else {
      commandZone[player] = [];
    }

    const shuffledInstances = shuffle(deckInstances);
    const libraryCountBeforeOpeningHand = shuffledInstances.length;
    const openingHandInstances = shuffledInstances.splice(0, 7);
    const zones = {
      commandZone: commanderInstance ? [commanderInstance] : [],
      library: shuffledInstances,
      hand: openingHandInstances,
      battlefield: [] as Array<{ instanceId: string; cardName: CardName }>,
      graveyard: [] as Array<{ instanceId: string; cardName: CardName }>,
      exile: [] as Array<{ instanceId: string; cardName: CardName }>,
    };
    const allInstances = Object.values(zones).flat();
    const instanceCounts = new Map<string, number>();
    const cardNameCounts = new Map<string, number>();
    for (const instance of allInstances) {
      instanceCounts.set(instance.instanceId, (instanceCounts.get(instance.instanceId) ?? 0) + 1);
      cardNameCounts.set(instance.cardName, (cardNameCounts.get(instance.cardName) ?? 0) + 1);
    }
    const duplicateInstanceIds = [...instanceCounts]
      .filter(([, count]) => count > 1)
      .map(([instanceId]) => instanceId);
    const duplicateCardNames = [...cardNameCounts]
      .filter(([, count]) => count > 1)
      .map(([cardName]) => cardName);
    const zoneCards = Object.values(zones).flat();
    const audit: DeckInitAudit = {
      playerId: player,
      inputDecklistCount: inputDeck.length,
      expectedDeckSize: 100,
      commander: {
        cardId: normalizeCardName(commander),
        cardName: commander,
        instanceId: commanderInstance?.instanceId ?? `commander_${player}_not_initialized`,
      },
      commandZoneCount: zones.commandZone.length,
      libraryCountBeforeOpeningHand,
      handCountAfterOpeningDraw: zones.hand.length,
      libraryCountAfterOpeningDraw: zones.library.length,
      totalCardsAcrossZones: zoneCards.length,
      totalUniqueInstanceIds: instanceCounts.size,
      commanderOccurrencesAcrossZones: zoneCards.filter((instance) =>
        normalizeCardName(instance.cardName) === normalizeCardName(commander)
      ).length,
      duplicateInstanceIds,
      duplicateCardNames,
      instanceIdsByZone: Object.fromEntries(
        Object.entries(zones).map(([zone, instances]) => [zone, instances.map((instance) => instance.instanceId)])
      ) as DeckInitAudit["instanceIdsByZone"],
      invariantViolations: [],
    };
    if (audit.commandZoneCount !== 1) audit.invariantViolations.push("commandZoneCount must be 1");
    if (audit.libraryCountBeforeOpeningHand !== 99) audit.invariantViolations.push("libraryCountBeforeOpeningHand must be 99");
    if (audit.handCountAfterOpeningDraw !== 7) audit.invariantViolations.push("handCountAfterOpeningDraw must be 7");
    if (audit.libraryCountAfterOpeningDraw !== 92) audit.invariantViolations.push("libraryCountAfterOpeningDraw must be 92");
    if (audit.totalCardsAcrossZones !== 100) audit.invariantViolations.push("totalCardsAcrossZones must be 100");
    if (audit.totalUniqueInstanceIds !== 100) audit.invariantViolations.push("totalUniqueInstanceIds must be 100");
    if (audit.commanderOccurrencesAcrossZones !== 1) audit.invariantViolations.push("commanderOccurrencesAcrossZones must be 1");
    if (audit.duplicateInstanceIds.length) audit.invariantViolations.push("duplicateInstanceIds must be empty");
    deckInitAudits.push(audit);
    libraries.push(shuffledInstances.map((instance) => instance.cardName));
    hands.push(openingHandInstances.map((instance) => instance.cardName));
  }
  const metadataMaps = Array(players)
    .fill(null)
    .map((_, idx) => {
      const entries = playerDeckMetadata?.[idx] ?? [];
      const map: Record<string, DeckCardMetadata> = {};
      entries.forEach((entry) => {
        if (entry?.name) {
          map[entry.name.toLowerCase()] = entry;
        }
        entry.aliases?.forEach((alias) => {
          map[alias.toLowerCase()] = entry;
        });
        const landFace = getLandFaceMetadata(entry);
        const spellFace = getSpellFaceMetadata(entry);
        if (landFace?.name) map[landFace.name.toLowerCase()] = entry;
        if (spellFace?.name) map[spellFace.name.toLowerCase()] = entry;
      });
      return map;
    });

  const costReducers: SimGameState["costReducers"] = {};
  const handSizeModifiers: SimGameState["handSizeModifiers"] = {};
  const drawHistory: SimGameState["drawHistory"] = {};
  for (let i = 0; i < players; i++) {
    costReducers[i] = [];
    handSizeModifiers[i] = [];
    drawHistory[i] = 0;
  }

  return {
    turn: 1,
    playerIndex: startingPlayerIndex,
    lifeTotals,
    battlefields,
    permanents,
    graveyards,
    commanders,
    commandZone,
    deckInitAudits,
    libraries,
    hands,
    creatures,
    artifacts,
    artifactMana,
    manaSpent,
    tappedPermanents: Object.fromEntries(
      Array.from({ length: players }, (_, idx) => [idx, {}])
    ),
    commanderCastCounts: Object.fromEntries(
      Array.from({ length: players }, (_, idx) => [idx, {}])
    ),
    cardMetadata: metadataMaps,
    triggers: [],
    triggerCounter: 1,
    phase: TURN_STRUCTURE[0]?.phase ?? "",
    phaseStep: TURN_STRUCTURE[0]?.step ?? "",
    costReducers,
    handSizeModifiers,
    drawHistory,
    rulesEvents: [],
    rulesMetrics: {
      unsupportedEffects: 0,
      stateBasedActions: 0,
      fizzledObjects: 0,
    },
    stack: [],
  };
}

function cloneActions(actions: SimAction[]): SimAction[] {
  return actions.map((action) => ({ ...action }));
}

function hydrateChosenAction(action: SimAction, legalActions: SimAction[]): SimAction {
  const exact = legalActions.find((candidate) => actionTraceLabel(candidate) === actionTraceLabel(action));
  if (exact) return { ...exact };
  if (action.type !== "PLAY_LAND" && action.type !== "CAST_SPELL") return action;
  const matches = legalActions.filter((candidate) => {
    if (candidate.type !== action.type) return false;
    if (!("card" in candidate) || candidate.card !== action.card) return false;
    if (action.selectedFaceId && selectedFaceIdForAction(candidate) !== action.selectedFaceId) return false;
    if (action.type === "PLAY_LAND") {
      if (candidate.type !== "PLAY_LAND") return false;
      if (action.entryChoice) {
        return JSON.stringify(candidate.entryChoice ?? null) === JSON.stringify(action.entryChoice);
      }
      return true;
    }
    if (action.type === "CAST_SPELL") {
      if (candidate.type !== "CAST_SPELL") return false;
      if (action.targetId && candidate.targetId !== action.targetId) return false;
      if (action.targetPlayer !== undefined && candidate.targetPlayer !== action.targetPlayer) return false;
      if (action.targetGraveyardCard && candidate.targetGraveyardCard !== action.targetGraveyardCard) return false;
      if (action.targetStackId && candidate.targetStackId !== action.targetStackId) return false;
    }
    return true;
  });
  const uniqueMatches = new Map(matches.map((candidate) => [actionTraceLabel(candidate), candidate]));
  return uniqueMatches.size === 1 ? { ...[...uniqueMatches.values()][0] } : action;
}

function drawCard(state: SimGameState, player: number) {
  const library = state.libraries[player];
  if (library.length === 0) return;
  const card = library.shift();
  if (card) {
    state.hands[player].push(card);
    state.drawHistory[player] = (state.drawHistory[player] ?? 0) + 1;
    emitRulesEvent(state, {
      type: "CARD_DRAWN",
      player,
      controller: player,
      card,
    });
  }
}

function drawCards(
  state: SimGameState,
  player: number,
  count: number,
  log: (msg: string) => void,
  source?: string
) {
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const library = state.libraries[player];
    if (!library?.length) break;
    const card = library.shift();
    if (!card) break;
    state.hands[player].push(card);
    state.drawHistory[player] = (state.drawHistory[player] ?? 0) + 1;
    emitRulesEvent(state, {
      type: "CARD_DRAWN",
      player,
      controller: player,
      card,
      sourceCard: source,
    });
    drawn++;
  }
  if (drawn > 0) {
    log(`Player ${player} draws ${drawn} card${drawn === 1 ? "" : "s"}${source ? ` via ${source}` : ""}`);
  }
}

export interface ActionGenerationContext {
  landDropsUsedThisTurn: number;
  maxLandDrops: number;
  allowInstant: boolean;
  allowSorcery: boolean;
  allowLand: boolean;
  hasPriority?: boolean;
}

function normalizeMaxLandDrops(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.floor(value));
}

function hasLandDropCapacity(context: TurnContext): boolean {
  return context.landDropsUsedThisTurn < context.maxLandDrops;
}

function hasPlayableLandInHand(state: SimGameState, player: number): boolean {
  return (state.hands[player] ?? []).some((card) => isLandCard(state, player, card));
}

function isSecondMainPhase(state: SimGameState): boolean {
  return (
    state.phase === "Seconda Fase Principale" ||
    state.phaseStep === "Seconda Fase Principale"
  );
}

function isMainPhase(state: SimGameState): boolean {
  return (
    state.phase === "Prima Fase Principale" ||
    state.phaseStep === "Prima Fase Principale" ||
    isSecondMainPhase(state)
  );
}

function selectForcedSecondMainLandDrop(
  state: SimGameState,
  context: TurnContext,
  availableActions: SimAction[]
): SimAction | null {
  if (!isSecondMainPhase(state) || !hasLandDropCapacity(context)) return null;
  return (
    availableActions.find((action) => action.type === "PLAY_LAND") ?? null
  );
}

function selectLandDropOverPass(
  state: SimGameState,
  context: TurnContext,
  availableActions: SimAction[],
  chosenAction: SimAction
): SimAction | null {
  if (chosenAction.type !== "PASS_TURN") return null;
  if (!isMainPhase(state) || !hasLandDropCapacity(context)) return null;
  return availableActions.find((action) => action.type === "PLAY_LAND") ?? null;
}

function turnContextRecordSecondMainLandDrop(
  context: TurnContext,
  availableActions: SimAction[]
) {
  if (availableActions.some((action) => action.type === "PLAY_LAND")) {
    context.secondMainLandDropAvailable = true;
  }
  context.lastSecondMainActionCount = availableActions.length;
}

function missedLandDropDiagnostic(
  state: SimGameState,
  player: number,
  turn: number,
  context: TurnContext
) {
  const legalLands = (state.hands[player] ?? []).filter((card) =>
    canPlayLand(state, player, card, {
      landDropsUsedThisTurn: context.landDropsUsedThisTurn,
      maxLandDrops: context.maxLandDrops,
      allowInstant: false,
      allowSorcery: false,
      allowLand: true,
    })
  );
  const secondMainActions = generateActions(state, player, {
    landDropsUsedThisTurn: context.landDropsUsedThisTurn,
    maxLandDrops: context.maxLandDrops,
    allowInstant: false,
    allowSorcery: false,
    allowLand: true,
  });
  const recent = activeDiagnostics?.data.recentActions.slice(-10).join(" | ") ?? "";
  const reason = legalLands.length
    ? "Second Main ended without applying a legal PLAY_LAND"
    : "Playable land by metadata remained in hand but no legal PLAY_LAND was generated";
  return [
    `[Metrics] missedLandDropOpportunity turn=${turn} phase=${state.phaseStep || state.phase} player=${player}`,
    `hand=${(state.hands[player] ?? []).join(",")}`,
    `legalLands=${legalLands.join(",") || "none"}`,
    `landDrops=${context.landDropsUsedThisTurn}/${context.maxLandDrops}`,
    `secondMainActionCount=${context.lastSecondMainActionCount || secondMainActions.length}`,
    `reason=${reason}`,
    `recent=${recent}`,
  ].join(" ");
}

function isOwnMainPhaseWithEmptyStack(state: SimGameState, player: number) {
  if (state.playerIndex !== player) return false;
  if (state.stack.length > 0) return false;
  return (
    state.phase === "Prima Fase Principale" ||
    state.phase === "Seconda Fase Principale" ||
    state.phaseStep === "Prima Fase Principale" ||
    state.phaseStep === "Seconda Fase Principale"
  );
}

function spellAdditionalCosts(metadata?: DeckCardMetadata): CostDescriptor[] {
  if (!metadata) return [];
  return parseCardRules(metadata).abilities
    .filter((ability) => ability.kind === "SPELL_EFFECT")
    .flatMap((ability) => ability.costs ?? []);
}

function unpayableAdditionalCostReason(
  state: SimGameState,
  player: number,
  metadata?: DeckCardMetadata
) : string | undefined {
  for (const cost of spellAdditionalCosts(metadata)) {
    if (cost.type !== "SACRIFICE") continue;
    const available = getControlledPermanentsByType(state, player, cost.cardType ?? "permanent");
    const required = cost.amount ?? 1;
    if (available.length < required) {
      return `requires sacrificing ${required} ${cost.cardType ?? "permanent"}(s); ${available.length} available`;
    }
  }
  return undefined;
}

function canPayAdditionalCosts(
  state: SimGameState,
  player: number,
  metadata?: DeckCardMetadata
) {
  return unpayableAdditionalCostReason(state, player, metadata) === undefined;
}

function payAdditionalCosts(
  state: SimGameState,
  player: number,
  metadata: DeckCardMetadata | undefined,
  log: (msg: string) => void
) {
  for (const cost of spellAdditionalCosts(metadata)) {
    if (cost.type !== "SACRIFICE") continue;
    for (let i = 0; i < (cost.amount ?? 1); i++) {
      const target = selectControlledPermanentByType(state, player, cost.cardType ?? "permanent");
      if (!target) throw new Error(`Cannot pay sacrifice cost for ${metadata?.name ?? "spell"}`);
      sacrificeBattlefieldPermanent(state, target.controller, target.card, log);
    }
  }
}

function findDefaultGraveyardTargetForCard(
  state: SimGameState,
  player: number,
  metadata?: DeckCardMetadata
) {
  if (!metadata) return undefined;
  const ability = parseCardRules(metadata).abilities.find((candidate) =>
    candidate.targets?.some((target) => target.zone === "graveyard")
  );
  const effect = ability?.effects.find((candidate) => candidate.fromZone === "graveyard");
  if (!effect) return undefined;
  return findGraveyardTarget(
    state,
    player,
    effect,
    {
      id: "target_probe",
      action: { type: "CAST_SPELL", card: metadata.name },
      casterIndex: player,
      resolved: false,
      responses: [],
    }
  )?.card;
}

type LegalTarget = { id: string | number; controller: number; card: CardName; type: TargetRef["type"] };

export function getLegalTargets(
  state: SimGameState,
  player: number,
  requirement: NonNullable<ParsedAbility["targets"]>[number]
): LegalTarget[] {
  return timeBlock("getLegalTargets", () => getLegalTargetsInner(state, player, requirement));
}

function getLegalTargetsInner(
  state: SimGameState,
  player: number,
  requirement: NonNullable<ParsedAbility["targets"]>[number]
): LegalTarget[] {
  if (requirement.type === "PLAYER" || requirement.zone === "player") {
    return state.lifeTotals
      .map((life, index) => ({ life, index }))
      .filter(({ life }) => life > 0)
      .map(({ index }) => ({ id: index, controller: index, card: `Player ${index}`, type: "player" as const }))
      .filter((target) => isLegalTarget(state, player, requirement, target));
  }
  if (requirement.type === "SPELL" || requirement.zone === "stack") {
    return state.stack
      .filter((entry) => !entry.resolved)
      .map((entry) => ({
        id: entry.id,
        controller: entry.casterIndex,
        card: entry.action.type === "CAST_SPELL" ? entry.action.card : entry.sourceCard ?? entry.action.type,
        type: "stack" as const,
      }))
      .filter((target) => isLegalTarget(state, player, requirement, target));
  }
  if (requirement.zone === "graveyard") {
    const owners = playerIndicesByRelation(state, player, requirement.owner ?? requirement.controller ?? "self");
    return owners.flatMap((owner) =>
      (state.graveyards[owner] ?? [])
        .map((card, index) => ({ id: `${owner}:graveyard:${index}:${card}`, controller: owner, card, type: "card" as const }))
        .filter((target) => isLegalTarget(state, player, requirement, target))
    );
  }
  if (requirement.zone !== "battlefield") return [];
  const targets: LegalTarget[] = [];
  ensurePermanentZones(state);
  for (let controller = 0; controller < state.permanents!.length; controller++) {
    for (const permanent of state.permanents![controller] ?? []) {
      const card = permanent.face ?? permanent.cardName;
      const target = { id: permanent.id, controller, card, type: requirement.cardType === "creature" ? "creature" as const : "permanent" as const };
      if (isLegalTarget(state, player, requirement, target)) targets.push(target);
    }
  }
  return targets;
}

export function isLegalTarget(
  state: SimGameState,
  player: number,
  requirement: NonNullable<ParsedAbility["targets"]>[number],
  target: { id?: string | number; controller: number; card: CardName; type?: TargetRef["type"] }
) {
  if (requirement.type === "PLAYER" || requirement.zone === "player") {
    if (requirement.controller === "self" && target.controller !== player) return false;
    if (requirement.controller === "opponent" && target.controller === player) return false;
    return state.lifeTotals[target.controller] > 0;
  }
  if (requirement.type === "SPELL" || requirement.zone === "stack") {
    if (requirement.controller === "self" && target.controller !== player) return false;
    if (requirement.controller === "opponent" && target.controller === player) return false;
    if (typeof target.id !== "string") return false;
    const entry = state.stack.find((candidate) => candidate.id === target.id && !candidate.resolved);
    if (!entry) return false;
    if (requirement.type === "SPELL" && entry.action.type !== "CAST_SPELL") return false;
    if (requirement.spellTypes?.length) {
      if (entry.action.type !== "CAST_SPELL") return false;
      const metadata = getCardMetadata(state, entry.casterIndex, entry.action.card);
      const face = selectedFaceIdForAction(entry.action);
      const instant = isInstantLike(metadata, face);
      const sorcery = isSorceryLike(metadata, face);
      if (!((requirement.spellTypes.includes("instant") && instant) || (requirement.spellTypes.includes("sorcery") && sorcery))) {
        return false;
      }
    }
    return true;
  }
  if (requirement.controller === "self" && target.controller !== player) return false;
  if (requirement.controller === "opponent" && target.controller === player) return false;
  const metadata = getCardMetadata(state, target.controller, target.card);
  if (requirement.cardType === "creature" && !state.creatures[target.controller]?.some((creature) => creature.name === target.card) && !isCreatureCard(target.card, metadata)) return false;
  if (requirement.cardType === "artifact" && !isArtifactCard(target.card, metadata) && !state.artifacts[target.controller]?.includes(target.card)) return false;
  if (requirement.cardType === "enchantment" && !(metadata?.typeLine ?? "").toLowerCase().includes("enchantment")) return false;
  if (
    requirement.cardType === "permanent" &&
    target.type !== "permanent" &&
    target.type !== "creature" &&
    !isPermanentCard(target.card, metadata)
  ) return false;
  if (requirement.subtype && !(metadata?.typeLine ?? target.card).toLowerCase().includes(requirement.subtype.toLowerCase())) return false;
  return true;
}

function playerIndicesByRelation(
  state: SimGameState,
  player: number,
  relation: "self" | "opponent" | "any"
) {
  if (relation === "self") return [player];
  return state.lifeTotals
    .map((life, index) => ({ life, index }))
    .filter(({ life, index }) => life > 0 && (relation === "any" || index !== player))
    .map(({ index }) => index);
}

export function canPlayLand(
  state: SimGameState,
  player: number,
  card: CardName,
  context: ActionGenerationContext
) {
  if (!context.allowLand) return false;
  if (!isOwnMainPhaseWithEmptyStack(state, player)) return false;
  if (context.landDropsUsedThisTurn >= context.maxLandDrops) return false;
  return isLandCard(state, player, card);
}

export function canCastSpell(
  state: SimGameState,
  player: number,
  card: CardName,
  context: ActionGenerationContext,
  sourceZone: "HAND" | "COMMAND" = "HAND"
) {
  if (!context.allowInstant && !context.allowSorcery) return false;
  if (sourceZone === "COMMAND") {
    const commanderName = state.commanders[player];
    if (!commanderName || normalizeCardName(commanderName) !== normalizeCardName(card)) return false;
    if (!(state.commandZone?.[player] ?? []).some((commandCard) => normalizeCardName(commandCard) === normalizeCardName(card))) return false;
  }
  const metadata = getCardMetadata(state, player, card);
  if (!isCastableSpellCard(state, player, card)) return false;

  const face = getSpellFaceMetadata(metadata)?.name;
  const instantTiming =
    isInstantLike(metadata, face) || hasFlash(metadata, face);
  const sorceryTiming =
    isSorceryLike(metadata, face) ||
    activeFaceMetadata(metadata, face)?.isCreature ||
    activeFaceMetadata(metadata, face)?.isPermanent ||
    isPermanentCard(card, metadata);

  const timingLegal = instantTiming && context.allowInstant
    ? true
    : sorceryTiming && context.allowSorcery && isOwnMainPhaseWithEmptyStack(state, player);
  if (!timingLegal) return false;
  if (!canPayAdditionalCosts(state, player, metadata)) {
    recordIllegalCastPrevented(state);
    return false;
  }
  const spellMetadata = metadataForSelectedFace(metadata, face);
  const graveyardTarget = findDefaultGraveyardTargetForCard(state, player, spellMetadata);
  const requiresMissingGraveyardTarget = parseCardRules(spellMetadata ?? { name: card }).abilities.some((ability) =>
    ability.kind === "SPELL_EFFECT" &&
    ability.targets?.some((target) => target.zone === "graveyard" && target.required !== false) &&
    !graveyardTarget
  );
  if (requiresMissingGraveyardTarget) return false;
  if (!hasRequiredTargets(state, player, spellMetadata)) return false;

  const plan = findManaPaymentPlan(state, player, getSpellManaCost(card, state, player, spellMetadata, sourceZone));
  if (!plan.legal) {
    recordManaPaymentFailure(state);
    return false;
  }
  return true;
}

function actionTraceLabel(action: SimAction) {
  if (action.type === "PLAY_LAND") {
    return `${action.type}:${action.card}:${selectedFaceIdForAction(action) ?? ""}:${JSON.stringify(action.entryChoice ?? null)}`;
  }
  if (action.type === "CAST_SPELL") {
    return `${action.type}:${action.card}:${action.sourceZone ?? "HAND"}:${selectedFaceIdForAction(action) ?? ""}:${JSON.stringify(action.targets ?? [])}`;
  }
  if (action.type === "ACTIVATE_ABILITY") {
    return `${action.type}:${action.sourcePermanentId}:${action.abilityId}:${JSON.stringify(action.targets ?? [])}`;
  }
  if (action.type === "ATTACK_CHOICE" || action.type === "BLOCK_CHOICE") {
    return `${action.type}:${action.card}:${"mode" in action ? action.mode : ""}:${"targetId" in action ? action.targetId ?? "" : ""}`;
  }
  return JSON.stringify(action);
}

function missingManaReason(plan: ManaPaymentPlan): AiDecisionRejectionReason {
  const missing = plan.missing ?? {};
  if ((missing.W ?? 0) > 0 || (missing.U ?? 0) > 0 || (missing.B ?? 0) > 0 || (missing.R ?? 0) > 0 || (missing.G ?? 0) > 0) {
    return "MISSING_COLORED_MANA";
  }
  return "INSUFFICIENT_TOTAL_MANA";
}

function unsupportedCard(metadata?: DeckCardMetadata) {
  return metadata?.unsupportedEffect === true || metadata?.rulesCoverage === "UNSUPPORTED";
}

function explainCastSpellLegality(
  state: SimGameState,
  player: number,
  card: CardName,
  context: ActionGenerationContext,
  legalActions: SimAction[],
  sourceZone: "HAND" | "COMMAND" = "HAND"
): AiConsideredActionTrace {
  const metadata = getCardMetadata(state, player, card);
  const face = getSpellFaceMetadata(metadata)?.name;
  const spellMetadata = metadataForSelectedFace(metadata, face);
  const selectedFace = resolveSelectedFace(metadata, face);
  const parsedAbilities = spellMetadata ? parseCardRules(spellMetadata).abilities : [];
  const spellCosts = parsedAbilities
    .filter((ability) => ability.kind === "SPELL_EFFECT")
    .flatMap((ability) => ability.costs ?? []);
  const activatedCosts = parsedAbilities
    .filter((ability) => ability.kind === "ACTIVATED")
    .flatMap((ability) => ability.costs ?? []);
  const targetRequirements = describeTargetRequirements(state, player, spellMetadata);
  const spellTargetRequirements = targetRequirements.filter((requirement) =>
    requirement.source === "SPELL_EFFECT" && requirement.requiredDuringCast
  );
  const validTargets = spellTargetRequirements.flatMap((requirement) => requirement.validTargets ?? []);
  const validStackTargets = spellTargetRequirements
    .flatMap((requirement) => requirement.validTargets ?? [])
    .filter((target) => target.type === "stack")
    .flatMap((target) => {
      const entry = state.stack.find((candidate) => candidate.id === target.id && !candidate.resolved);
      if (!entry) return [];
      return [{
        id: entry.id,
        cardName: entry.action.type === "CAST_SPELL" ? entry.action.card : entry.sourceCard ?? entry.action.type,
        casterIndex: entry.casterIndex,
      }];
    });
  const additionalCostFailure = unpayableAdditionalCostReason(state, player, spellMetadata);
  const commanderCastCount = commanderCastCountFor(state, player, card);
  const commanderTax = sourceZone === "COMMAND" ? commanderTaxFor(state, player, card) : 0;
  const baseCost = getSpellManaCost(card, state, player, spellMetadata);
  const effectiveCost = getSpellManaCost(card, state, player, spellMetadata, sourceZone);
  const base = {
    type: "CAST_SPELL" as const,
    cardId: card,
    cardName: face ?? card,
    ...faceTraceFields(state, player, card, face),
    sourceZone,
    commanderCastCount,
    commanderTax,
    baseCost,
    effectiveCost,
    recognized: face ? Boolean(selectedFace && spellMetadata) : Boolean(metadata),
    timingLegal: true,
    manaPayable: true,
    targetsValid: true,
    additionalCostsPayable: additionalCostFailure === undefined,
    spellAdditionalCosts: spellCosts,
    activatedAbilityCosts: activatedCosts,
    additionalCostsRequiredDuringCast: spellCosts.length > 0,
    unpayableAdditionalCostReason: additionalCostFailure,
    spellRequiresTargetsDuringCast: spellTargetRequirements.length > 0,
    targetRequirements,
    validTargets,
    stackSize: state.stack.filter((entry) => !entry.resolved).length,
    stackObjects: state.stack.filter((entry) => !entry.resolved).map((entry) => ({
      id: entry.id,
      cardName: entry.action.type === "CAST_SPELL" ? entry.action.card : entry.sourceCard ?? entry.action.type,
      casterIndex: entry.casterIndex,
      kind: entry.kind,
    })),
    validStackTargets,
    legal: false,
  };
  if (!context.allowInstant && !context.allowSorcery) {
    return { ...base, timingLegal: false, rejectionReason: "WRONG_TIMING" };
  }
  if (!isCastableSpellCard(state, player, card)) {
    return { ...base, rejectionReason: "CARD_NOT_CASTABLE" };
  }

  const instantTiming = isInstantLike(metadata, face) || hasFlash(metadata, face);
  const sorceryTiming =
    isSorceryLike(metadata, face) ||
    activeFaceMetadata(metadata, face)?.isCreature ||
    activeFaceMetadata(metadata, face)?.isPermanent ||
    isPermanentCard(card, spellMetadata);
  const timingLegal = instantTiming && context.allowInstant
    ? true
    : sorceryTiming && context.allowSorcery && isOwnMainPhaseWithEmptyStack(state, player);
  if (!timingLegal) {
    return { ...base, timingLegal: false, rejectionReason: "WRONG_TIMING" };
  }
  if (additionalCostFailure) {
    return { ...base, additionalCostsPayable: false, rejectionReason: "ADDITIONAL_COST_UNPAYABLE" };
  }
  const graveyardTarget = findDefaultGraveyardTargetForCard(state, player, spellMetadata);
  const requiresMissingGraveyardTarget = parseCardRules(spellMetadata ?? { name: card }).abilities.some((ability) =>
    ability.kind === "SPELL_EFFECT" &&
    ability.targets?.some((target) => target.zone === "graveyard" && target.required !== false) &&
    !graveyardTarget
  );
  if (requiresMissingGraveyardTarget || !hasRequiredTargets(state, player, spellMetadata)) {
    return { ...base, targetRequirements, targetsValid: false, rejectionReason: "NO_VALID_TARGET" };
  }
  if (unsupportedCard(spellMetadata)) {
    return { ...base, rejectionReason: "UNSUPPORTED_CARD_RULE" };
  }
  const paymentPlan = findManaPaymentPlan(state, player, effectiveCost);
  if (!paymentPlan.legal) {
    return {
      ...base,
      manaPayable: false,
      paymentPlan,
      rejectionReason: missingManaReason(paymentPlan),
    };
  }
  const generated = legalActions.some((action) =>
    action.type === "CAST_SPELL" &&
    action.card === card &&
    (action.sourceZone ?? "HAND") === sourceZone &&
    (!face || selectedFaceIdForAction(action) === face)
  );
  return {
    ...base,
    paymentPlan,
    targetRequirements,
    legal: generated,
    rejectionReason: generated ? undefined : "ACTION_GENERATION_FAILED",
  };
}

function explainPlayLandLegality(
  state: SimGameState,
  player: number,
  card: CardName,
  context: ActionGenerationContext,
  legalActions: SimAction[]
): AiConsideredActionTrace | null {
  if (!isLandCard(state, player, card)) return null;
  const metadata = getCardMetadata(state, player, card);
  const selectedFaceId = getLandFaceMetadata(metadata)?.name;
  const landMetadata = metadataForSelectedFace(metadata, selectedFaceId);
  const selectedFace = resolveSelectedFace(metadata, selectedFaceId);
  const base = {
    type: "PLAY_LAND" as const,
    cardId: card,
    cardName: selectedFaceId ?? card,
    ...faceTraceFields(state, player, card, selectedFaceId),
    recognized: selectedFaceId ? Boolean(selectedFace && landMetadata) : Boolean(metadata),
    timingLegal: true,
    manaPayable: true,
    targetsValid: true,
    additionalCostsPayable: true,
    legal: false,
  };
  if (!context.allowLand || !isOwnMainPhaseWithEmptyStack(state, player) || context.landDropsUsedThisTurn >= context.maxLandDrops) {
    return { ...base, timingLegal: false, rejectionReason: "WRONG_TIMING" };
  }
  const generated = legalActions.some((action) =>
    action.type === "PLAY_LAND" &&
    action.card === card &&
    (!selectedFaceId || selectedFaceIdForAction(action) === selectedFaceId)
  );
  return {
    ...base,
    legal: generated,
    rejectionReason: generated ? undefined : "ACTION_GENERATION_FAILED",
  };
}

function consideredActionKey(action: Pick<SimAction, "type"> & { card?: CardName; selectedFaceId?: string; face?: string; sourceZone?: "HAND" | "COMMAND" }) {
  return "card" in action && action.card
    ? `${action.type}:${action.card}:${action.type === "CAST_SPELL" ? action.sourceZone ?? "HAND" : ""}:${selectedFaceIdForAction(action) ?? ""}`
    : JSON.stringify(action);
}

function buildConsideredActions(
  state: SimGameState,
  player: number,
  context: ActionGenerationContext,
  legalActions: SimAction[]
): AiConsideredActionTrace[] {
  const considered: AiConsideredActionTrace[] = [];
  const seen = new Set<string>();
  for (const card of state.hands[player] ?? []) {
    const land = explainPlayLandLegality(state, player, card, context, legalActions);
    if (land) {
      considered.push(land);
      seen.add(consideredActionKey({ type: "PLAY_LAND", card, selectedFaceId: land.selectedFaceId }));
    }
    const cast = explainCastSpellLegality(state, player, card, context, legalActions, "HAND");
    considered.push(cast);
    seen.add(consideredActionKey({ type: "CAST_SPELL", card, selectedFaceId: cast.selectedFaceId, sourceZone: "HAND" }));
  }
  for (const card of state.commandZone?.[player] ?? []) {
    const cast = explainCastSpellLegality(state, player, card, context, legalActions, "COMMAND");
    considered.push(cast);
    seen.add(consideredActionKey({ type: "CAST_SPELL", card, selectedFaceId: cast.selectedFaceId, sourceZone: "COMMAND" }));
  }
  for (const action of legalActions) {
    const card = "card" in action ? action.card : undefined;
    const key = consideredActionKey(action);
    if (seen.has(key)) continue;
    const faceFields = card && (action.type === "PLAY_LAND" || action.type === "CAST_SPELL")
      ? faceTraceFields(state, player, card, selectedFaceIdForAction(action))
      : {};
    considered.push({
      type: action.type,
      cardId: card,
      cardName: action.type === "PLAY_LAND" || action.type === "CAST_SPELL"
        ? selectedFaceIdForAction(action) ?? card
        : card,
      ...faceFields,
      recognized: true,
      timingLegal: true,
      manaPayable: true,
      targetsValid: true,
      additionalCostsPayable: true,
      legal: true,
    });
  }
  return considered;
}

function buildAiDecisionTrace(params: {
  state: SimGameState;
  player: number;
  context: ActionGenerationContext;
  legalActions: SimAction[];
  evaluation: AiActionEvaluationTrace[];
  decision: AgentDecision;
  decisionStartedAt: number;
  beforeDecisionTelemetry: ReturnType<typeof decisionTelemetrySnapshot>;
}): AiDecisionTrace {
  const player = params.player;
  const chosenAction = params.decision.action;
  const rankedEvaluation = [...params.evaluation]
    .sort((a, b) => b.finalScore - a.finalScore)
    .map((entry, index) => ({ ...entry, scoreRank: index + 1 }));
  const chosenEvaluation = rankedEvaluation.find((entry) => actionTraceLabel(entry.action) === actionTraceLabel(chosenAction));
  const argmaxEvaluation = rankedEvaluation[0];
  const isFinalScoreArgmax = Boolean(
    argmaxEvaluation && actionTraceLabel(argmaxEvaluation.action) === actionTraceLabel(chosenAction)
  );
  const selection = params.decision.metadata?.selection;
  const decisionSource = params.decision.metadata?.source ?? "fallback";
  const consideredActions = buildConsideredActions(params.state, player, params.context, params.legalActions);
  const unsupportedCards = consideredActions
    .filter((entry) => entry.rejectionReason === "UNSUPPORTED_CARD_RULE" && entry.cardName)
    .map((entry) => entry.cardName!);
  const legalNonPass = params.legalActions.filter((action) => action.type !== "PASS_TURN");
  const decisionDelta = telemetryDelta(params.beforeDecisionTelemetry, decisionTelemetrySnapshot());
  const decisionElapsedMs = performance.now() - params.decisionStartedAt;
  const manaSources = traceManaSourcesForPlayer(params.state, player);
  return {
    decisionId: `decision_${params.state.turn}_${player}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    playerId: player,
    turn: params.state.turn,
    phase: params.state.phase,
    step: params.state.phaseStep || params.state.phase,
    state: {
      life: params.state.lifeTotals[player] ?? 0,
      handSize: params.state.hands[player]?.length ?? 0,
      battlefieldSummary: params.state.battlefields.map((cards, index) => `P${index}:${cards.length}`),
      availableMana: manaSources
        .filter((source) => source.usable)
        .reduce((sum, source) => sum + source.produces.length, 0),
      untappedManaSources: manaSources
        .filter((source) => source.usable)
        .map((source) => source.activeFace ?? source.physicalCard),
      manaSources,
    },
    consideredActions,
    legalActions: cloneActions(params.legalActions),
    evaluation: rankedEvaluation,
    decision: {
      chosenAction,
      source: decisionSource,
      score: chosenEvaluation?.finalScore ?? params.decision.metadata?.expectedReward,
      confidence: params.decision.metadata?.confidence,
      argmaxAction: argmaxEvaluation?.action,
      argmaxFinalScore: argmaxEvaluation?.finalScore,
      chosenActionFinalScore: chosenEvaluation?.finalScore,
      isFinalScoreArgmax,
      decisionScoreMismatch: Boolean(argmaxEvaluation && !isFinalScoreArgmax),
      selectedBy: selection?.selectedBy ?? "agent_decision",
      selectionReason: selection?.selectionReason ?? params.decision.metadata?.reasoning ?? "selection mechanism not reported by agent",
      selectionValueName: selection?.selectionValueName ?? "not_reported",
      selectionValue: selection?.selectionValue,
      selectionCandidates: selection?.selectionCandidates ?? cloneActions(params.legalActions),
      confidenceMeaning: selection?.confidenceMeaning,
    },
    execution: {
      attemptedAction: chosenAction,
      success: false,
    },
    result: {
      stateChanged: false,
      lifeDelta: 0,
      handDelta: 0,
      battlefieldDelta: 0,
      graveyardDelta: 0,
      nextPhase: params.state.phaseStep || params.state.phase,
    },
    performance: {
      rulesMs: 0,
      dbMs: decisionDelta.dbLookupMs,
      inferenceMs: Math.max(0, decisionElapsedMs - decisionDelta.dbLookupMs),
      totalMs: decisionElapsedMs,
    },
    questionable: chosenAction.type === "PASS_TURN" && legalNonPass.length > 0,
    unsupportedCards,
  };
}

function updateTraceAfterExecution(
  trace: AiDecisionTrace,
  beforeState: SimGameState,
  afterState: SimGameState,
  options: {
    attemptedAction: SimAction;
    success: boolean;
    failureReason?: string;
    fallbackAction?: SimAction;
    rulesMs: number;
  }
) {
  const player = trace.playerId;
  trace.execution = {
    attemptedAction: options.attemptedAction,
    success: options.success,
    failureReason: options.failureReason,
    fallbackAction: options.fallbackAction,
  };
  trace.result = {
    stateChanged: canonicalStateFingerprint(beforeState) !== canonicalStateFingerprint(afterState),
    lifeDelta: (afterState.lifeTotals[player] ?? 0) - (beforeState.lifeTotals[player] ?? 0),
    handDelta: (afterState.hands[player]?.length ?? 0) - (beforeState.hands[player]?.length ?? 0),
    battlefieldDelta: (afterState.battlefields[player]?.length ?? 0) - (beforeState.battlefields[player]?.length ?? 0),
    graveyardDelta: (afterState.graveyards[player]?.length ?? 0) - (beforeState.graveyards[player]?.length ?? 0),
    nextPhase: afterState.phaseStep || afterState.phase,
  };
  trace.performance.rulesMs = options.rulesMs;
  trace.performance.totalMs = trace.performance.inferenceMs + trace.performance.dbMs + options.rulesMs;
}

function recordAiDecisionTrace(trace: AiDecisionTrace, emit?: (trace: AiDecisionTrace) => void) {
  const diagnostics = activeDiagnostics;
  if (diagnostics) {
    diagnostics.data.aiDecisionTraces ??= [];
    diagnostics.data.aiDecisionTraces.push(trace);
    if (diagnostics.data.aiDecisionTraces.length > 500) {
      diagnostics.data.aiDecisionTraces.shift();
    }
  }
  emit?.(trace);
}

export function generateActions(
  state: SimGameState,
  player: number,
  context: ActionGenerationContext
): SimAction[] {
  const actions: SimAction[] = [{ type: "PASS_TURN" }];
  const hand = state.hands[player];

  if (context.allowLand) {
    hand
      .filter((card) => canPlayLand(state, player, card, context))
      .forEach((card) => {
        const metadata = getCardMetadata(state, player, card);
        const selectedFaceId = getLandFaceMetadata(metadata)?.name;
        const faceTrace = faceTraceFields(state, player, card, selectedFaceId);
        const entryChoices = landEntryChoices(metadata, state.lifeTotals[player] ?? 0, selectedFaceId);
        if (entryChoices.length) {
          for (const entryChoice of entryChoices) {
            actions.push({ type: "PLAY_LAND", card, face: selectedFaceId, ...faceTrace, entryChoice });
          }
        } else {
          actions.push({ type: "PLAY_LAND", card, face: selectedFaceId, ...faceTrace });
        }
      });
  }

  if (!context.allowInstant && !context.allowSorcery) {
    return actions;
  }

  hand
    .filter((card) => canCastSpell(state, player, card, context))
    .forEach((card) => {
      const metadata = getCardMetadata(state, player, card);
      if (isCounterspell(card, metadata)) return;
      actions.push(...buildCastSpellActions(state, player, card, metadata));
    });

  (state.commandZone?.[player] ?? [])
    .filter((card) => canCastSpell(state, player, card, context, "COMMAND"))
    .forEach((card) => {
      const metadata = getCardMetadata(state, player, card);
      if (isCounterspell(card, metadata)) return;
      actions.push(...buildCastSpellActions(state, player, card, metadata, "COMMAND"));
    });

  actions.push(...buildActivatedAbilityActions(state, player, context));

  return actions;
}

function buildCastSpellActions(
  state: SimGameState,
  player: number,
  card: CardName,
  metadata?: DeckCardMetadata,
  sourceZone: "HAND" | "COMMAND" = "HAND"
): Extract<SimAction, { type: "CAST_SPELL" }>[] {
  const selectedFaceId = getSpellFaceMetadata(metadata)?.name;
  const spellMetadata = metadataForSelectedFace(metadata, selectedFaceId);
  const parsed = spellMetadata ? parseCardRules(spellMetadata) : undefined;
  const spellAbilities = parsed?.abilities.filter((ability) => ability.kind === "SPELL_EFFECT") ?? [];
  const base = {
    type: "CAST_SPELL" as const,
    card,
    face: getSpellFaceMetadata(metadata)?.name,
    ...faceTraceFields(state, player, card, getSpellFaceMetadata(metadata)?.name),
    ...(sourceZone === "COMMAND" ? { sourceZone } : {}),
  };
  if (!spellAbilities.length) return [base];
  return expandActionsForAbilities(state, player, base, spellAbilities);
}

function expandActionsForAbilities<T extends Extract<SimAction, { type: "CAST_SPELL" | "ACTIVATE_ABILITY" }>>(
  state: SimGameState,
  player: number,
  base: T,
  abilities: ParsedAbility[]
): T[] {
  const actions: T[] = [];
  const relevant = abilities.filter((ability) =>
    base.type === "ACTIVATE_ABILITY" ? ability.abilityId === base.abilityId : true
  );
  const actionAbilities = relevant.length ? relevant : abilities;

  for (const ability of actionAbilities) {
    const withMode = applyModeToAction(base, ability);
    const requirements = ability.targets ?? [];
    if (!requirements.length) {
      actions.push(...expandOptionalAction(withMode, ability));
      continue;
    }

    const requiredUnsupported = requirements.some((requirement) =>
      requirement.required !== false &&
      !["battlefield", "graveyard", "stack", "player"].includes(requirement.zone ?? "")
    );
    if (requiredUnsupported) continue;

    let partials: T[] = [withMode];
    let failedRequiredTarget = false;
    for (const requirement of requirements) {
      const legalTargets = rankLegalTargets(
        state,
        player,
        requirement,
        getLegalTargets(state, player, requirement)
      ).slice(0, MAX_TARGET_ACTIONS_PER_ABILITY);

      if (!legalTargets.length) {
        if (requirement.optional || requirement.required === false) continue;
        failedRequiredTarget = true;
        break;
      }

      const targetActions = partials.flatMap((partial) =>
        legalTargets.map((target) => attachTargetToAction(partial, target))
      );
      partials = requirement.optional || requirement.required === false
        ? [...partials, ...targetActions]
        : targetActions;
    }
    if (!failedRequiredTarget) {
      actions.push(...partials.flatMap((partial) => expandOptionalAction(partial, ability)));
    }
  }

  return dedupeActions(actions);
}

function applyModeToAction<T extends Extract<SimAction, { type: "CAST_SPELL" | "ACTIVATE_ABILITY" }>>(
  action: T,
  ability: ParsedAbility
): T {
  if (!ability.modeId) return action;
  return { ...action, modes: [ability.modeId] } as T;
}

function expandOptionalAction<T extends Extract<SimAction, { type: "CAST_SPELL" | "ACTIVATE_ABILITY" }>>(
  action: T,
  ability: ParsedAbility
): T[] {
  const optionalId = ability.patternId ?? ability.abilityId ?? ability.modeId;
  if (!optionalId || !ability.effects.some((effect) => effect.optional)) return [action];
  return [
    { ...action, optionalChoices: { ...(action.optionalChoices ?? {}), [optionalId]: true } } as T,
    { ...action, optionalChoices: { ...(action.optionalChoices ?? {}), [optionalId]: false } } as T,
  ];
}

function attachTargetToAction<T extends Extract<SimAction, { type: "CAST_SPELL" | "ACTIVATE_ABILITY" }>>(
  action: T,
  target: LegalTarget
): T {
  const targetRef: TargetRef = { type: target.type, id: target.id };
  const next = {
    ...action,
    targets: [...(action.targets ?? []), targetRef],
  } as T;
  if (next.type === "CAST_SPELL") {
    if (targetRef.type === "creature" || targetRef.type === "permanent") next.targetId = String(targetRef.id);
    if (targetRef.type === "player") next.targetPlayer = Number(targetRef.id);
    if (targetRef.type === "card") next.targetGraveyardCard = target.card;
    if (targetRef.type === "stack") next.targetStackId = String(targetRef.id);
  }
  return next;
}

function dedupeActions<T extends SimAction>(actions: T[]): T[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankLegalTargets(
  state: SimGameState,
  player: number,
  requirement: NonNullable<ParsedAbility["targets"]>[number],
  targets: LegalTarget[]
) {
  return [...targets].sort((a, b) =>
    targetPriority(state, player, requirement, b) - targetPriority(state, player, requirement, a)
  );
}

function targetPriority(
  state: SimGameState,
  player: number,
  requirement: NonNullable<ParsedAbility["targets"]>[number],
  target: LegalTarget
) {
  if (target.type === "player") return target.controller === player ? 0 : state.lifeTotals[target.controller] > 0 ? 10 : -100;
  if (target.type === "stack") return target.controller === player ? 0 : 8;
  if (target.type === "card") return requirement.cardType === "creature" ? 6 : 4;
  const permanent = typeof target.id === "string" ? findPermanentTargetById(state, target.id) : null;
  const creatureValue = permanent?.creature ? permanent.creature.power + permanent.creature.toughness : 0;
  return (target.controller === player ? 0 : 5) + creatureValue;
}

function buildActivatedAbilityActions(
  state: SimGameState,
  player: number,
  context: ActionGenerationContext
): Extract<SimAction, { type: "ACTIVATE_ABILITY" }>[] {
  ensurePermanentZones(state);
  const actions: Extract<SimAction, { type: "ACTIVATE_ABILITY" }>[] = [];
  for (const permanent of state.permanents?.[player] ?? []) {
    const metadata = getCardMetadata(state, player, permanent.cardName) ?? getCardMetadata(state, player, permanent.face ?? permanent.cardName);
    const abilities = activatedAbilitiesForPermanent(metadata, permanent);
    for (const ability of abilities) {
      if (isPureManaAbility(ability)) continue;
      if (!canActivateAbility(state, player, permanent, ability, context)) continue;
      const base: Extract<SimAction, { type: "ACTIVATE_ABILITY" }> = {
        type: "ACTIVATE_ABILITY",
        sourcePermanentId: permanent.id,
        abilityId: ability.abilityId ?? ability.patternId ?? "ability",
      };
      actions.push(...expandActionsForAbilities(state, player, base, [ability]));
    }
  }
  return actions;
}

function activatedAbilitiesForPermanent(
  metadata: DeckCardMetadata | undefined,
  permanent: PermanentState
): ParsedAbility[] {
  if (!metadata) return [];
  return parseCardRules(metadata).abilities
    .filter((ability) => ability.kind === "ACTIVATED")
    .map((ability, index) => ({
      ...ability,
      abilityId: ability.abilityId ?? `${permanent.id}:${ability.patternId ?? "activated"}:${index}`,
    }));
}

export function isPureManaAbility(ability: ParsedAbility) {
  if (ability.kind !== "ACTIVATED") return false;
  if (ability.targets?.length) return false;
  if (ability.effects.length === 0 || !ability.effects.every((effect) => effect.type === "ADD_MANA")) return false;
  return (ability.costs ?? []).every((cost) => cost.type === "TAP" || cost.type === "MANA");
}

function canActivateAbility(
  state: SimGameState,
  player: number,
  permanent: PermanentState,
  ability: ParsedAbility,
  context: ActionGenerationContext
) {
  if (permanent.controller !== player) return false;
  if (!canPayAbilityCosts(state, player, permanent, ability.costs ?? [])) return false;
  if (!ability.effects.every((effect) => effect.type === "ADD_MANA") && !context.allowInstant && !context.allowSorcery) return false;
  for (const requirement of ability.targets ?? []) {
    if (requirement.required === false || requirement.optional) continue;
    if (getLegalTargets(state, player, requirement).length === 0) return false;
  }
  return true;
}

function canPayAbilityCosts(
  state: SimGameState,
  player: number,
  permanent: PermanentState,
  costs: CostDescriptor[]
) {
  for (const cost of costs) {
    if (cost.type === "TAP") {
      if (permanent.tapped) return false;
      const creature = state.creatures[player]?.find((candidate) => candidate.id === permanent.id);
      if (creature?.summoningSickness && !(creature.keywords ?? []).includes("haste")) return false;
      continue;
    }
    if (cost.type === "MANA") {
      if (!cost.mana || !findManaPaymentPlan(state, player, cost.mana).legal) return false;
      continue;
    }
    if (cost.type === "PAY_LIFE") {
      if (state.lifeTotals[player] <= (cost.life ?? cost.amount ?? 0)) return false;
      continue;
    }
    if (cost.type === "SACRIFICE") {
      if (cost.source) {
        if (!state.permanents?.[player]?.some((candidate) => candidate.id === permanent.id)) return false;
        continue;
      }
      const available = getControlledPermanentsByType(state, player, cost.cardType ?? "permanent");
      if (available.length < (cost.amount ?? 1)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function hasRequiredTargets(
  state: SimGameState,
  player: number,
  metadata?: DeckCardMetadata
) {
  if (!metadata) return true;
  for (const ability of parseCardRules(metadata).abilities) {
    if (ability.kind !== "SPELL_EFFECT") continue;
    for (const requirement of ability.targets ?? []) {
      if (requirement.required === false || requirement.optional) continue;
      if (getLegalTargets(state, player, requirement).length === 0) {
        return false;
      }
    }
  }
  return true;
}

function targetRequirementSource(ability: ParsedAbility): TargetRequirementTrace["source"] | null {
  if (ability.kind === "SPELL_EFFECT") return "SPELL_EFFECT";
  if (ability.kind === "ACTIVATED") return "ACTIVATED_ABILITY";
  if (ability.kind === "TRIGGERED") {
    return ability.trigger?.eventType === "PERMANENT_ENTERED"
      ? "ETB_TRIGGER"
      : "TRIGGERED_ABILITY";
  }
  return null;
}

function describeTargetRequirements(
  state: SimGameState,
  player: number,
  metadata?: DeckCardMetadata
): TargetRequirementTrace[] {
  if (!metadata) return [];
  const result: TargetRequirementTrace[] = [];
  for (const ability of parseCardRules(metadata).abilities) {
    const source = targetRequirementSource(ability);
    if (!source) continue;
    const text = ability.sourceFragment ?? ability.modeLabel ?? metadata.oracleText ?? metadata.name;
    for (const requirement of ability.targets ?? []) {
      const requiredDuringCast =
        source === "SPELL_EFFECT" &&
        requirement.required !== false &&
        requirement.optional !== true;
      const validTargets = getLegalTargets(state, player, requirement).map((target) => ({
        type: target.type,
        id: target.id,
      }));
      result.push({
        source,
        text,
        requiredDuringCast,
        validTargetCount: validTargets.length,
        validTargets,
      });
    }
  }
  return result;
}

function describeLandEntryEffect(entry: ReturnType<typeof evaluateLandEntryTapped>) {
  if (entry.optionalCost) {
    return entry.optionalCost.paid
      ? `PAY_${entry.optionalCost.amount}_LIFE`
      : `DECLINE_PAY_${entry.optionalCost.amount}_LIFE`;
  }
  if (entry.enteredTapped && entry.entryReason === "enters tapped") {
    return "ENTERS_TAPPED";
  }
  if (entry.conditionRecognized) {
    return entry.enteredTapped ? "CONDITIONAL_ENTERS_TAPPED" : "CONDITIONAL_ENTERS_UNTAPPED";
  }
  return "NONE";
}

function logMdfcDiagnostic(
  log: (message: string) => void,
  options: {
    card: string;
    selectedFace?: string;
    action: "PLAY_LAND" | "CAST_SPELL";
    typeLine?: string;
    oracleText?: string;
    entryEffect?: string;
    result: string;
  }
) {
  if (!options.selectedFace || normalizeCardName(options.card) === normalizeCardName(options.selectedFace)) {
    return;
  }
  log(
    [
      "[MDFC]",
      `card=${options.card}`,
      `selected_face=${options.selectedFace}`,
      `action=${options.action}`,
      `type_line=${options.typeLine ?? ""}`,
      `oracle=${options.oracleText ?? ""}`,
      options.entryEffect ? `entry_effect=${options.entryEffect}` : undefined,
      `result=${options.result}`,
    ].filter(Boolean).join("\n")
  );
}

export function applyAction(
  state: SimGameState,
  action: SimAction,
  player: number,
  log: (message: string) => void
) {
  switch (action.type) {
    case "CONCEDE": {
      if (state.lifeTotals[player] > 0) {
        state.lifeTotals[player] = 0;
        log(`[Concede] Player ${player} concedes`);
      }
      break;
    }
    case "PLAY_LAND": {
      const idx = state.hands[player].indexOf(action.card);
      if (idx >= 0) state.hands[player].splice(idx, 1);
      const metadata = getCardMetadata(state, player, action.card);
      const selectedFaceId = selectedFaceIdForAction(action) ?? getLandFaceMetadata(metadata)?.name;
      const selectedFace = resolveSelectedFace(metadata, selectedFaceId);
      const landMetadata = metadataForSelectedFace(metadata, selectedFaceId);
      const landName = selectedFace?.name ?? getLandPermanentName(action.card, metadata);
      const entry = evaluateLandEntryTapped(state, player, action.card, metadata, action.entryChoice, selectedFaceId);
      if (entry.unsupported) {
        ensureRulesMetrics(state).unsupportedEffects++;
      }
      if (entry.optionalCost?.paid) {
        state.lifeTotals[player] -= entry.optionalCost.amount;
        log(`Player ${player} pays ${entry.optionalCost.amount} life for ${landName}`);
      }
      state.battlefields[player].push(landName);
      const permanent = addPermanentState(state, {
        cardName: action.card,
        owner: player,
        controller: player,
        face: landName,
        tapped: entry.enteredTapped,
      });
      if (entry.enteredTapped) {
        state.tappedPermanents ??= {};
        state.tappedPermanents[player] ??= {};
        state.tappedPermanents[player][landName.toLowerCase()] =
          (state.tappedPermanents[player][landName.toLowerCase()] ?? 0) + 1;
      }
      logMdfcDiagnostic(log, {
        card: metadata?.name ?? action.card,
        selectedFace: selectedFace?.name,
        action: "PLAY_LAND",
        typeLine: selectedFace?.typeLine,
        oracleText: selectedFace?.oracleText,
        entryEffect: describeLandEntryEffect(entry),
        result: entry.enteredTapped ? "TAPPED" : "UNTAPPED",
      });
      log(`Player ${player} plays ${landName} ${entry.enteredTapped ? "tapped" : "untapped"}`);
      log(`Reason: ${entry.entryReason}`);
      emitRulesEvent(state, {
        type: "LAND_PLAYED",
        player,
        controller: player,
        card: action.card,
        face: landName,
        permanentId: permanent.id,
        data: {
          card: action.card,
          player,
          sourceCard: action.card,
          sourcePermanentId: permanent.id,
          enteredTapped: entry.enteredTapped,
          entryReason: entry.entryReason,
          otherLandCount: entry.otherLandCount,
          optionalCost: entry.optionalCost,
        },
      });
      dispatchRulesEvent(state, {
        type: "PERMANENT_ENTERED",
        player,
        controller: player,
        card: action.card,
        face: landName,
        permanentId: permanent.id,
        data: {
          card: action.card,
          player,
          sourceCard: action.card,
          sourcePermanentId: permanent.id,
          enteredTapped: entry.enteredTapped,
          entryReason: entry.entryReason,
          otherLandCount: entry.otherLandCount,
          optionalCost: entry.optionalCost,
        },
      }, log, landMetadata);
      handleLandEntered(state, player, landName, log, "play");
      handlePermanentEntersBattlefield(state, player, landName, landMetadata, log);
      break;
    }
    case "CAST_SPELL": {
      const metadata = getCardMetadata(state, player, action.card);
      const selectedFaceId = selectedFaceIdForAction(action) ?? getSpellFaceMetadata(metadata)?.name;
      const selectedFace = resolveSelectedFace(metadata, selectedFaceId);
      const spellMetadata = metadataForSelectedFace(metadata, selectedFaceId);
      logMdfcDiagnostic(log, {
        card: metadata?.name ?? action.card,
        selectedFace: selectedFace?.name,
        action: "CAST_SPELL",
        typeLine: selectedFace?.typeLine,
        oracleText: selectedFace?.oracleText,
        result: "CAST",
      });
      const sourceZone = action.sourceZone ?? "HAND";
      const paymentPlan = requireManaPaymentPlan(state, player, action.card, spellMetadata, log, sourceZone);
      applyManaPaymentPlan(state, player, paymentPlan);
      payAdditionalCosts(state, player, spellMetadata, log);
      if (sourceZone === "COMMAND") {
        removeCardFromZone(state.commandZone?.[player], action.card);
        recordCommanderCastFromCommand(state, player, action.card);
      } else {
        removeCardFromZone(state.hands[player], action.card);
      }
      resolveSpell(state, player, action.card, log, selectedFaceId, action.targetId, action.targetGraveyardCard, action);
      break;
    }
    case "ACTIVATE_ABILITY": {
      const entry = activateAbilityToStack(state, player, action, log);
      if (entry) {
        resolveEffectDescriptors(state, entry, log);
        applyStateBasedActions(state, log);
      }
      break;
    }
    case "DECLARE_ATTACKERS":
    case "DECLARE_BLOCKERS":
      // handled outside of main action loop
      break;
    default:
      break;
  }
}

function resolveSpell(
  state: SimGameState,
  player: number,
  card: string,
  log: (msg: string) => void,
  face?: string,
  targetId?: string,
  targetGraveyardCard?: CardName,
  action?: Extract<SimAction, { type: "CAST_SPELL" }>
) {
  const metadata = getCardMetadata(state, player, card);
  const selectedFaceId = face ?? action?.selectedFaceId ?? getSpellFaceMetadata(metadata)?.name;
  const spellFaceMetadata = metadataForSelectedFace(metadata, selectedFaceId);
  const spellName = selectedFaceId ?? getSpellPermanentName(card, metadata);
  emitRulesEvent(state, {
    type: "SPELL_RESOLVED",
    player,
    controller: player,
    card,
    face: spellName,
  });
  if (isCreatureCard(card, spellFaceMetadata)) {
    summonCreature(state, player, spellName, log, spellFaceMetadata);
    addPermanentState(state, {
      cardName: card,
      owner: player,
      controller: player,
      face: spellName,
      tapped: false,
      summoningSickness: true,
    });
    dispatchRulesEvent(state, {
      type: "PERMANENT_ENTERED",
      player,
      controller: player,
      card,
      face: spellName,
    }, log, spellFaceMetadata);
    return;
  }

  if (isPermanentCard(card, spellFaceMetadata)) {
    placePermanent(state, player, spellName, spellFaceMetadata, log);
    return;
  }

  if (resolveSpellEffectsFromRegistry(state, player, card, spellFaceMetadata, log, targetId, targetGraveyardCard, action)) {
    return;
  }

  if (handleTokenCreationSpell(state, player, card, spellFaceMetadata, log)) {
    return;
  }

  if (handleRemovalSpell(state, player, card, spellFaceMetadata, log, targetId)) {
    return;
  }

  if (handleDirectDamageSpell(state, player, card, spellFaceMetadata, log)) {
    return;
  }

  markUnsupportedEffect(state, card, spellFaceMetadata?.oracleText, log);
  state.graveyards[player].push(card);
}

function resolveSpellEffectsFromRegistry(
  state: SimGameState,
  player: number,
  card: CardName,
  metadata: DeckCardMetadata | undefined,
  log: (msg: string) => void,
  targetId?: string,
  targetGraveyardCard?: CardName,
  action?: Extract<SimAction, { type: "CAST_SPELL" }>
) {
  if (!metadata) return false;
  const parsed = parseCardRules(metadata);
  const spellAbilities = parsed.abilities.filter((ability) => ability.kind === "SPELL_EFFECT");
  if (!spellAbilities.length) return false;
  const spellAction = action ?? { type: "CAST_SPELL" as const, card, targetId, targetGraveyardCard };
  if (!allRequiredTargetsStillLegal(state, player, spellAction, spellAbilities)) {
    fizzleObject(state, card, log, "all targets are illegal");
    state.graveyards[player].push(card);
    return true;
  }

  for (const ability of spellAbilities) {
    resolveEffectDescriptors(
      state,
      {
        id: `effect_${Date.now()}`,
        action: spellAction,
        casterIndex: player,
        resolved: true,
        responses: [],
        kind: "spell",
        sourceCard: card,
        effects: selectedAbilityEffects([ability], spellAction),
        targets: spellAction.targets,
      },
      log
    );
  }
  applyStateBasedActions(state, log);
  state.graveyards[player].push(card);
  return true;
}

function resolveCounterspell(
  state: SimGameState,
  entry: StackEntry,
  log: (msg: string) => void
) {
  if (entry.action.type !== "CAST_SPELL") return false;
  const metadata = getCardMetadata(state, entry.casterIndex, entry.action.card);
  if (!isCounterspell(entry.action.card, metadata)) return false;

  const explicitTarget = selectedStackTarget(state, entry);
  const targetStackId = explicitTarget?.id ?? entry.action.targetStackId;
  const targetIndex = targetStackId
    ? state.stack.findIndex((candidate) => candidate.id === targetStackId)
    : -1;
  const targetEntry = targetIndex >= 0 ? state.stack[targetIndex] : null;
  state.graveyards[entry.casterIndex].push(entry.action.card);

  if (!targetEntry || targetEntry.resolved || targetEntry.action.type !== "CAST_SPELL") {
    log(`Player ${entry.casterIndex}'s ${entry.action.card} resolves with no legal spell target`);
    return true;
  }

  state.stack.splice(targetIndex, 1);
  targetEntry.resolved = true;
  state.graveyards[targetEntry.casterIndex].push(targetEntry.action.card);
  log(
    `Player ${entry.casterIndex} counters ${targetEntry.action.card} cast by Player ${targetEntry.casterIndex} with ${entry.action.card}`
  );
  return true;
}

function placePermanent(
  state: SimGameState,
  player: number,
  card: string,
  metadata: DeckCardMetadata | undefined,
  log: (msg: string) => void
) {
  if (!state.battlefields[player]) {
    state.battlefields[player] = [];
  }
  state.battlefields[player].push(card);
  addPermanentState(state, {
    cardName: card,
    owner: player,
    controller: player,
    face: card,
    tapped: false,
  });
  if (isArtifactCard(card, metadata)) {
    if (!state.artifacts[player]) {
      state.artifacts[player] = [];
    }
    state.artifacts[player].push(card);
  }
  log(`Player ${player} resolves permanent ${card}`);
  dispatchRulesEvent(state, {
    type: "PERMANENT_ENTERED",
    player,
    controller: player,
    card,
    face: card,
  }, log, metadata);
  handlePermanentEntersBattlefield(state, player, card, metadata, log);
}

function handleTokenCreationSpell(
  state: SimGameState,
  player: number,
  card: string,
  metadata: DeckCardMetadata | undefined,
  log: (msg: string) => void
) {
  const effects = parseTokenEffects(metadata?.oracleText);
  if (!effects.length) return false;

  let created = 0;
  for (const effect of effects) {
    const tokenCount = evaluateTokenCount(effect.count, state, player);
    if (!Number.isFinite(tokenCount) || tokenCount <= 0) continue;
    for (let i = 0; i < tokenCount; i++) {
      const name =
        effect.name?.trim() ??
        `${effect.power}/${effect.toughness} Token`;
      createTokenPermanent(state, player, {
        name,
        power: effect.power,
        toughness: effect.toughness,
      });
      created++;
    }
  }

  state.graveyards[player].push(card);
  if (created > 0) {
    log(
      `Player ${player} creates ${created} token${created === 1 ? "" : "s"} via ${card}`
    );
  } else {
    log(`Player ${player} resolves ${card} but creates no tokens`);
  }
  return true;
}

function handleRemovalSpell(
  state: SimGameState,
  player: number,
  card: string,
  metadata: DeckCardMetadata | undefined,
  log: (msg: string) => void,
  targetId?: string
) {
  const text = metadata?.oracleText?.toLowerCase();
  if (!text) return false;

  if (/destroy all creatures/.test(text)) {
    destroyAllCreatures(state, log);
    log(`Player ${player} casts ${card} destroying all creatures`);
    state.graveyards[player].push(card);
    return true;
  }

  if (/destroy target creature/.test(text)) {
    const target = targetId
      ? findCreatureTargetById(state, targetId)
      : selectCreatureTarget(state, player);
    if (targetId && !target) {
      fizzleObject(state, card, log, "target creature is no longer legal");
      state.graveyards[player].push(card);
      return true;
    }
    if (target) {
      destroyCreatureWithEvents(state, target.controller, target.creature.id, log);
      log(
        `Player ${player} destroys ${target.creature.name} controlled by Player ${target.controller}`
      );
    } else {
      log(`Player ${player} casts ${card} but finds no valid creature target`);
    }
    state.graveyards[player].push(card);
    return true;
  }

  if (/exile target creature/.test(text)) {
    const target = targetId
      ? findCreatureTargetById(state, targetId)
      : selectCreatureTarget(state, player);
    if (targetId && !target) {
      fizzleObject(state, card, log, "target creature is no longer legal");
      state.graveyards[player].push(card);
      return true;
    }
    if (target) {
      exileCreature(state, target.controller, target.creature.id, log);
      log(
        `Player ${player} exiles ${target.creature.name} controlled by Player ${target.controller}`
      );
    } else {
      log(`Player ${player} casts ${card} but finds no valid creature target`);
    }
    state.graveyards[player].push(card);
    return true;
  }

  if (/destroy target artifact or enchantment/.test(text)) {
    const target = selectBattlefieldPermanent(state, player, (metadata) => {
      const type = metadata?.typeLine?.toLowerCase() ?? "";
      return type.includes("artifact") || type.includes("enchantment");
    });
    if (target) {
      removeBattlefieldCard(state, target.controller, target.card, log);
      log(
        `Player ${player} destroys ${target.card} controlled by Player ${target.controller}`
      );
    } else {
      log(
        `Player ${player} casts ${card} but finds no artifact/enchantment target`
      );
    }
    state.graveyards[player].push(card);
    return true;
  }

  return false;
}

function handleDirectDamageSpell(
  state: SimGameState,
  player: number,
  card: string,
  metadata: DeckCardMetadata | undefined,
  log: (msg: string) => void
) {
  const text = metadata?.oracleText?.toLowerCase();
  if (!text) return false;

  const targetDamageMatch = text.match(
    /deals?\s+(\d+|x)\s+damage\s+to\s+(?:any target|target player(?: or planeswalker)?|target opponent(?: or planeswalker)?)/i
  );
  if (targetDamageMatch) {
    const amount = computeEffectAmount(targetDamageMatch[1], metadata);
    const target = findNextOpponent(state, player);
    if (target !== null && amount > 0) {
      dealDamageToPlayer(state, target, amount, log, card);
    } else {
      log(`Player ${player} casts ${card} but finds no target for damage`);
    }
    state.graveyards[player].push(card);
    return true;
  }

  const eachOpponentDamageMatch = text.match(
    /deals?\s+(\d+|x)\s+damage\s+to\s+each opponent/i
  );
  if (eachOpponentDamageMatch) {
    const amount = computeEffectAmount(eachOpponentDamageMatch[1], metadata);
    if (amount > 0) {
      for (let idx = 0; idx < state.lifeTotals.length; idx++) {
        if (idx === player || state.lifeTotals[idx] <= 0) continue;
        dealDamageToPlayer(state, idx, amount, log, card);
      }
    }
    state.graveyards[player].push(card);
    return true;
  }

  const eachPlayerDamageMatch = text.match(
    /deals?\s+(\d+|x)\s+damage\s+to\s+each player/i
  );
  if (eachPlayerDamageMatch) {
    const amount = computeEffectAmount(eachPlayerDamageMatch[1], metadata);
    if (amount > 0) {
      for (let idx = 0; idx < state.lifeTotals.length; idx++) {
        if (state.lifeTotals[idx] <= 0) continue;
        dealDamageToPlayer(state, idx, amount, log, card);
      }
    }
    state.graveyards[player].push(card);
    return true;
  }

  const eachOpponentLoseLife = text.match(
    /each opponent loses (\d+|x) life/
  );
  if (eachOpponentLoseLife) {
    const amount = computeEffectAmount(eachOpponentLoseLife[1], metadata);
    if (amount > 0) {
      for (let idx = 0; idx < state.lifeTotals.length; idx++) {
        if (idx === player || state.lifeTotals[idx] <= 0) continue;
        loseLife(state, idx, amount, log, card);
      }
    }
    state.graveyards[player].push(card);
    return true;
  }

  const targetLoseLife = text.match(/target opponent loses (\d+|x) life/);
  if (targetLoseLife) {
    const amount = computeEffectAmount(targetLoseLife[1], metadata);
    const target = findNextOpponent(state, player);
    if (target !== null && amount > 0) {
      loseLife(state, target, amount, log, card);
    } else {
      log(`Player ${player} casts ${card} but finds no opponent to lose life`);
    }
    state.graveyards[player].push(card);
    return true;
  }

  const targetCreatureDamage = text.match(
    /deals?\s+(\d+|x)\s+damage\s+to\s+target creature/i
  );
  if (targetCreatureDamage) {
    const amount = computeEffectAmount(targetCreatureDamage[1], metadata);
    const target = selectCreatureTarget(state, player);
    if (target && amount > 0) {
      applyDamageToCreature(state, target.controller, target.creature, amount, log, card);
    } else {
      log(`Player ${player} casts ${card} but finds no creature target`);
    }
    state.graveyards[player].push(card);
    return true;
  }

  const eachCreatureDamage = text.match(
    /deals?\s+(\d+|x)\s+damage\s+to\s+each creature(?: you don't control)?/i
  );
  if (eachCreatureDamage) {
    const amount = computeEffectAmount(eachCreatureDamage[1], metadata);
    if (amount > 0) {
      const onlyOpponents = /you don't control/.test(text);
      for (let controller = 0; controller < state.creatures.length; controller++) {
        if (onlyOpponents && controller === player) continue;
        const pool = [...state.creatures[controller]];
        for (const creature of pool) {
          applyDamageToCreature(state, controller, creature, amount, log, card);
        }
      }
    }
    state.graveyards[player].push(card);
    return true;
  }

  const gainLifeMatch = text.match(/you gain (\d+|x) life/);
  if (gainLifeMatch) {
    const amount = computeEffectAmount(gainLifeMatch[1], metadata);
    if (amount > 0) {
      gainLife(state, player, amount, log, card);
    }
    state.graveyards[player].push(card);
    return true;
  }

  const targetGainLife = text.match(/target player gains (\d+|x) life/);
  if (targetGainLife) {
    const amount = computeEffectAmount(targetGainLife[1], metadata);
    const target = findNextOpponent(state, player);
    if (target !== null && amount > 0) {
      gainLife(state, target, amount, log, card);
    }
    state.graveyards[player].push(card);
    return true;
  }

  return false;
}

function markUnsupportedEffect(
  state: SimGameState,
  card: CardName,
  fragment: string | undefined,
  log: (msg: string) => void
) {
  ensureRulesMetrics(state).unsupportedEffects++;
  const summary = fragment?.split(/\n|\./).find((part) => part.trim())?.trim() ?? "no supported oracle text";
  log(`[Rules] Unsupported effect: ${card} — ${summary}`);
}

function findNextOpponent(state: SimGameState, player: number) {
  for (let i = 1; i < state.lifeTotals.length; i++) {
    const idx = (player + i) % state.lifeTotals.length;
    if (state.lifeTotals[idx] > 0) return idx;
  }
  return null;
}

function checkForWinner(state: SimGameState): number | null {
  const alive = state.lifeTotals
    .map((life, idx) => ({ life, idx }))
    .filter(({ life }) => life > 0);
  if (alive.length === 1) return alive[0].idx;
  return null;
}

function applyStateBasedActions(state: SimGameState, log: (msg: string) => void) {
  const metrics = ensureRulesMetrics(state);
  for (let controller = 0; controller < state.creatures.length; controller++) {
    const pool = state.creatures[controller] ?? [];
    for (const creature of [...pool]) {
      const permanent = state.permanents?.[controller]?.find(
        (candidate) =>
          candidate.face === creature.name ||
          candidate.cardName === creature.name
      );
      const lethalDamage = permanent?.damageMarked ?? 0;
      if (creature.toughness <= 0 || lethalDamage >= creature.toughness) {
        destroyCreatureWithEvents(state, controller, creature.id, log);
        emitRulesEvent(state, {
          type: "CREATURE_DIED",
          player: controller,
          controller,
          card: creature.name,
          sourceCard: creature.name,
        });
        metrics.stateBasedActions++;
      }
    }
  }
}

function determineWinnerByLife(state: SimGameState): number | null {
  let bestIndex: number | null = null;
  let bestLife = -Infinity;
  state.lifeTotals.forEach((life, idx) => {
    if (life > bestLife) {
      bestLife = life;
      bestIndex = idx;
    }
  });
  return bestIndex;
}

function getHandSizeLimit(state: SimGameState, player: number): number {
  const modifiers = state.handSizeModifiers[player] ?? [];
  let bonus = 0;
  let noMax = false;
  for (const modifier of modifiers) {
    if (modifier.noMax) {
      noMax = true;
      break;
    }
    if (typeof modifier.bonus === "number") {
      bonus += modifier.bonus;
    }
  }
  if (noMax) return Infinity;
  return Math.max(0, 7 + bonus);
}

function enforceHandSizeLimit(
  state: SimGameState,
  player: number,
  log: (msg: string) => void
) {
  const limit = getHandSizeLimit(state, player);
  if (!Number.isFinite(limit)) return;
  const hand = state.hands[player] ?? [];
  while (hand.length > limit) {
    const card = hand.pop();
    if (!card) break;
    state.graveyards[player].push(card);
    log(`Player ${player} discards ${card} due to hand size limit`);
  }
}

function getSpellCost(card: string, state: SimGameState, player: number) {
  const metadata = getCardMetadata(state, player, card);
  const spellManaValue = metadata?.spellFace?.manaValue ?? metadata?.manaValue;
  if (typeof spellManaValue === "number") {
    return applyCostReductions(state, player, card, metadata, spellManaValue);
  }
  if (isBurnSpell(card)) return 2;
  if (metadata?.isCreature || isCreatureCard(card, metadata)) {
    if (typeof spellManaValue === "number") {
      return applyCostReductions(
        state,
        player,
        card,
        metadata,
        spellManaValue || 3
      );
    }
    return applyCostReductions(
      state,
      player,
      card,
      metadata,
      getCreatureBlueprint(card).manaCost
    );
  }
  if (card.toLowerCase().includes("grow")) return 1;
  return applyCostReductions(state, player, card, metadata, 3);
}

function commanderCastCountFor(state: SimGameState, player: number, card: CardName) {
  const commanderName = state.commanders[player];
  if (!commanderName || normalizeCardName(commanderName) !== normalizeCardName(card)) return 0;
  const key = normalizeCardName(commanderName);
  return state.commanderCastCounts?.[player]?.[key] ?? 0;
}

function commanderTaxFor(state: SimGameState, player: number, card: CardName) {
  return commanderCastCountFor(state, player, card) * 2;
}

function recordCommanderCastFromCommand(state: SimGameState, player: number, card: CardName) {
  const commanderName = state.commanders[player];
  if (!commanderName || normalizeCardName(commanderName) !== normalizeCardName(card)) return;
  const key = normalizeCardName(commanderName);
  state.commanderCastCounts ??= {};
  state.commanderCastCounts[player] ??= {};
  state.commanderCastCounts[player][key] = (state.commanderCastCounts[player][key] ?? 0) + 1;
}

function removeCardFromZone(zone: CardName[] | undefined, card: CardName) {
  if (!zone) return false;
  const index = zone.findIndex((candidate) => normalizeCardName(candidate) === normalizeCardName(card));
  if (index < 0) return false;
  zone.splice(index, 1);
  return true;
}

function getSpellManaCost(
  card: string,
  state: SimGameState,
  player: number,
  metadata = getCardMetadata(state, player, card),
  sourceZone: "HAND" | "COMMAND" = "HAND"
): ManaCost {
  const fallbackCost = getSpellCost(card, state, player);
  const parsed = manaCostFromMetadata(metadata, fallbackCost);
  const reduced = reduceGenericManaCost(parsed, totalGenericCostReduction(state, player, card, metadata));
  const commanderTax = sourceZone === "COMMAND" ? commanderTaxFor(state, player, card) : 0;
  return { ...reduced, generic: reduced.generic + commanderTax };
}

function requireManaPaymentPlan(
  state: SimGameState,
  player: number,
  card: string,
  metadata: DeckCardMetadata | undefined,
  log: (msg: string) => void,
  sourceZone: "HAND" | "COMMAND" = "HAND"
): ManaPaymentPlan {
  const cost = getSpellManaCost(card, state, player, metadata, sourceZone);
  log(`[Mana] Player ${player} casting ${card} cost=${formatManaCost(cost)}`);
  const plan = findManaPaymentPlan(state, player, cost);
  if (!plan.legal) {
    recordManaPaymentFailure(state);
    log(`[Mana] payment failed missing=${JSON.stringify(plan.missing ?? {})}`);
    throw new Error(`Illegal cast: cannot pay mana cost for ${metadata?.name ?? card}`);
  }
  log(`[Mana] payment ${card}: ${plan.sources.map((source) => `${source.card} -> ${formatManaPool(source.usedMana)}`).join(", ")}`);
  return plan;
}

function formatManaCost(cost: ManaCost) {
  return `${cost.generic ? `{${cost.generic}}` : ""}${"{W}".repeat(cost.white)}${"{U}".repeat(cost.blue)}${"{B}".repeat(cost.black)}${"{R}".repeat(cost.red)}${"{G}".repeat(cost.green)}${"{C}".repeat(cost.colorless)}` || "{0}";
}

function formatManaPool(pool: ManaPaymentPlan["sources"][number]["usedMana"]) {
  return `${"{W}".repeat(pool.W)}${"{U}".repeat(pool.U)}${"{B}".repeat(pool.B)}${"{R}".repeat(pool.R)}${"{G}".repeat(pool.G)}${"{C}".repeat(pool.C)}` || "{0}";
}

function isBurnSpell(card: string) {
  return card.toLowerCase().includes("burn");
}

function parseTokenEffects(text?: string): TokenEffectDescriptor[] {
  if (!text) return [];
  const segments = text
    .split(/[\.\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const effects: TokenEffectDescriptor[] = [];
  for (const segment of segments) {
    if (!/create/i.test(segment) || !/token/i.test(segment)) continue;
    const statsMatch = segment.match(/(\d+)\s*\/\s*(\d+)/);
    if (!statsMatch) continue;
    const countDescriptor = parseTokenCountDescriptor(segment);
    if (!countDescriptor) continue;
    const [_, powerRaw, toughnessRaw] = statsMatch;
    const name = extractTokenName(segment, statsMatch.index! + statsMatch[0].length);
    effects.push({
      count: countDescriptor,
      power: Number(powerRaw),
      toughness: Number(toughnessRaw),
      name,
    });
  }
  return effects;
}

function parseTokenCountDescriptor(segment: string): TokenCountDescriptor | null {
  const lower = segment.toLowerCase();
  const numericMatch = segment.match(/Create\s+(?:up to\s+)?(\d+)/i);
  if (numericMatch) {
    return { type: "fixed", value: Number(numericMatch[1]) };
  }
  const wordMatch = segment.match(
    /Create\s+(?:up to\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/i
  );
  if (wordMatch) {
    const word = wordMatch[1].toLowerCase();
    if (NUMBER_WORDS[word] !== undefined) {
      return { type: "fixed", value: NUMBER_WORDS[word] };
    }
  }
  if (/Create\s+(?:a|an)\s+/i.test(segment)) {
    return { type: "fixed", value: 1 };
  }
  if (/Create\s+X/i.test(segment)) {
    if (
      lower.includes("those opponents control") ||
      lower.includes("target opponents control") ||
      lower.includes("each opponent controls")
    ) {
      return { type: "opponentsTotalCreatures" };
    }
    if (
      lower.includes("target opponent controls") ||
      lower.includes("an opponent controls")
    ) {
      return { type: "opponentCreatures" };
    }
    if (lower.includes("life total") || lower.includes("your life total")) {
      return { type: "lifeTotal" };
    }
    if (lower.includes("creatures you control")) {
      return { type: "selfCreatures" };
    }
  }
  if (lower.includes("for each creature you control")) {
    return { type: "selfCreatures" };
  }
  if (
    lower.includes("for each creature target opponent controls") ||
    lower.includes("for each creature an opponent controls")
  ) {
    return { type: "opponentCreatures" };
  }
  if (lower.includes("equal to your life total")) {
    return { type: "lifeTotal" };
  }
  return null;
}

function extractTokenName(segment: string, statsEndIndex: number): string | undefined {
  const tokenIndex = segment.toLowerCase().indexOf("token", statsEndIndex);
  if (tokenIndex === -1) return undefined;
  let slice = segment.slice(statsEndIndex, tokenIndex);
  const withSplit = slice.split(/with\s+/i)[0];
  slice = withSplit.replace(/creatures?/gi, "").replace(/tokens?/gi, "");
  slice = slice.replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
  return slice.length ? slice : undefined;
}

function evaluateTokenCount(
  descriptor: TokenCountDescriptor,
  state: SimGameState,
  player: number
) {
  switch (descriptor.type) {
    case "fixed":
      return descriptor.value;
    case "selfCreatures":
      return state.creatures[player]?.length ?? 0;
    case "opponentCreatures": {
      const opponent = findNextOpponent(state, player);
      return opponent === null ? 0 : state.creatures[opponent]?.length ?? 0;
    }
    case "opponentsTotalCreatures": {
      let total = 0;
      for (let i = 0; i < state.creatures.length; i++) {
        if (i === player) continue;
        total += state.creatures[i]?.length ?? 0;
      }
      return total;
    }
    case "lifeTotal":
      return state.lifeTotals[player] ?? 0;
    default:
      return 0;
  }
}

function applyCostReductions(
  state: SimGameState,
  player: number,
  card: string,
  metadata: DeckCardMetadata | undefined,
  baseCost: number
) {
  const totalReduction = totalGenericCostReduction(state, player, card, metadata);
  const finalCost = Math.max(0, baseCost - totalReduction);
  return finalCost;
}

function totalGenericCostReduction(
  state: SimGameState,
  player: number,
  card: string,
  metadata: DeckCardMetadata | undefined
) {
  const reducers = state.costReducers[player] ?? [];
  let totalReduction = 0;
  for (const reducer of reducers) {
    try {
      if (!sourcePermanentStillPresent(state, player, reducer.sourceCard)) {
        continue;
      }
      if (reducer.appliesTo({ state, player, card, metadata })) {
        totalReduction += reducer.amount;
      }
    } catch {
      continue;
    }
  }
  return totalReduction;
}

function sourcePermanentStillPresent(
  state: SimGameState,
  player: number,
  sourceCard: CardName
) {
  const normalized = sourceCard.toLowerCase();
  if (
    state.permanents?.[player]?.some(
      (permanent) =>
        permanent.cardName.toLowerCase() === normalized ||
        permanent.face?.toLowerCase() === normalized
    )
  ) {
    return true;
  }
  return (state.battlefields[player] ?? []).some((card) => card.toLowerCase() === normalized);
}

function destroyAllCreatures(
  state: SimGameState,
  log: (msg: string) => void
) {
  for (let controller = 0; controller < state.creatures.length; controller++) {
    const pool = [...state.creatures[controller]];
    for (const creature of pool) {
      destroyCreatureWithEvents(state, controller, creature.id, log);
    }
  }
}

function destroyCreatureWithEvents(
  state: SimGameState,
  controller: number,
  creatureId: string,
  log: (msg: string) => void
) {
  const creature = state.creatures[controller]?.find((item) => item.id === creatureId);
  if (!creature) return;
  const metadata = getCardMetadata(state, controller, creature.name);
  destroyCreature(state, controller, creatureId, log);
  removePermanentState(state, controller, creature.name);
  dispatchRulesEvent(state, {
    type: "CREATURE_DIED",
    player: controller,
    controller,
    card: creature.name,
    sourceCard: creature.name,
  }, log, metadata);
  dispatchRulesEvent(state, {
    type: "PERMANENT_LEFT",
    controller,
    card: creature.name,
    sourceCard: creature.name,
  }, log, metadata);
}

function selectCreatureTarget(
  state: SimGameState,
  player: number,
  options?: { opponentOnly?: boolean; friendlyOnly?: boolean }
): { controller: number; creature: CreaturePermanent } | null {
  let best: { controller: number; creature: CreaturePermanent } | null = null;
  for (let controller = 0; controller < state.creatures.length; controller++) {
    if (options?.opponentOnly && controller === player) continue;
    if (options?.friendlyOnly && controller !== player) continue;
    if (!options?.friendlyOnly && !options?.opponentOnly && controller === player) continue;
    const pool = state.creatures[controller];
    if (!pool || !pool.length) continue;
    const candidate = pool.reduce((max, creature) =>
      !max || creature.power > max.power ? creature : max
    );
    if (!candidate) continue;
    if (
      !best ||
      candidate.power > best.creature.power ||
      candidate.toughness > best.creature.toughness
    ) {
      best = { controller, creature: candidate };
    }
  }
  return best;
}

function findCreatureTargetById(
  state: SimGameState,
  targetId: string
): { controller: number; creature: CreaturePermanent } | null {
  for (let controller = 0; controller < state.creatures.length; controller++) {
    const creature = state.creatures[controller]?.find((item) => item.id === targetId);
    if (creature) return { controller, creature };
  }
  return null;
}

function fizzleObject(
  state: SimGameState,
  source: CardName,
  log: (msg: string) => void,
  reason: string
) {
  ensureRulesMetrics(state).fizzledObjects++;
  log(`[Rules] ${source} fizzles: ${reason}`);
}

function exileCreature(
  state: SimGameState,
  controller: number,
  creatureId: string,
  log: (msg: string) => void
) {
  const pool = state.creatures[controller];
  if (!pool) return;
  const index = pool.findIndex((creature) => creature.id === creatureId);
  if (index === -1) return;
  const [creature] = pool.splice(index, 1);
  removePermanentState(state, controller, creature.name);
  log(`Player ${controller}'s ${creature.name} is exiled`);
}

function selectBattlefieldPermanent(
  state: SimGameState,
  player: number,
  predicate: (metadata?: DeckCardMetadata) => boolean
): { controller: number; card: string } | null {
  for (let controller = 0; controller < state.battlefields.length; controller++) {
    if (controller === player) continue;
    const battlefield = state.battlefields[controller];
    for (const card of battlefield) {
      const metadata = getCardMetadata(state, controller, card);
      if (predicate(metadata)) {
        return { controller, card };
      }
    }
  }
  return null;
}

function removeBattlefieldCard(
  state: SimGameState,
  controller: number,
  card: string,
  log: (msg: string) => void
) {
  const battlefield = state.battlefields[controller];
  const index = battlefield.indexOf(card);
  if (index === -1) return;
  battlefield.splice(index, 1);
  removePermanentState(state, controller, card);
  state.graveyards[controller].push(card);
  emitRulesEvent(state, {
    type: "PERMANENT_LEFT",
    controller,
    card,
    sourceCard: card,
  });
  log(`Player ${controller}'s ${card} is destroyed`);
}

function dealDamageToPlayer(
  state: SimGameState,
  player: number,
  amount: number,
  log: (msg: string) => void,
  source: string
) {
  state.lifeTotals[player] -= amount;
  emitRulesEvent(state, {
    type: "DAMAGE_DEALT",
    targetPlayer: player,
    amount,
    sourceCard: source,
  });
  log(`Player ${player} takes ${amount} damage from ${source}`);
}

function loseLife(
  state: SimGameState,
  player: number,
  amount: number,
  log: (msg: string) => void,
  source: string
) {
  state.lifeTotals[player] -= amount;
  log(`Player ${player} loses ${amount} life from ${source}`);
}

function applyDamageToCreature(
  state: SimGameState,
  controller: number,
  creature: CreaturePermanent,
  amount: number,
  log: (msg: string) => void,
  source: string
) {
  if (amount >= creature.toughness) {
        destroyCreatureWithEvents(state, controller, creature.id, log);
    log(
      `Player ${controller}'s ${creature.name} takes ${amount} damage from ${source} and dies`
    );
  } else {
    log(
      `Player ${controller}'s ${creature.name} takes ${amount} damage from ${source} but survives`
    );
  }
}

function gainLife(
  state: SimGameState,
  player: number,
  amount: number,
  log: (msg: string) => void,
  source: string
) {
  state.lifeTotals[player] += amount;
  emitRulesEvent(state, {
    type: "LIFE_GAINED",
    player,
    targetPlayer: player,
    amount,
    sourceCard: source,
  });
  log(`Player ${player} gains ${amount} life from ${source}`);
}

function computeEffectAmount(
  token: string,
  metadata?: DeckCardMetadata
): number {
  if (!token) return 0;
  if (token.toLowerCase() === "x") {
    return Math.max(1, Math.round(metadata?.manaValue ?? 3));
  }
  const value = Number(token);
  return Number.isFinite(value) ? value : 0;
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
