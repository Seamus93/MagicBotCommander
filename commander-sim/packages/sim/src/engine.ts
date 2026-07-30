import type {
  AttackDecision,
  BlockAssignment,
  BlockDecision,
  CardName,
  CostDescriptor,
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
  getLandPermanentName,
  getSpellPermanentName,
  landEntersTapped,
  activeFaceMetadata,
  hasFlash,
  isInstantLike,
  isSorceryLike,
  getAvailableInstants,
  isCounterspell,
  manaCostFromMetadata,
  reduceGenericManaCost,
  findManaPaymentPlan as findManaPaymentPlanRaw,
  applyManaPaymentPlan,
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
  fingerprintCounts: Map<string, number>;
}

let activeDiagnostics: DiagnosticContext | null = null;

const envNumber = (name: string, fallback: number) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function createDiagnosticContext(): DiagnosticContext {
  return {
    enabled: true,
    debugEpisode: process.env.DEBUG_EPISODE === "true",
    startedAt: Date.now(),
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
      windowsOver50Actions: 0,
      windowsOver100Actions: 0,
      stackPushes: 0,
      stackResolutions: 0,
      priorityPasses: 0,
      responsesGenerated: 0,
      maxStackDepth: 0,
      maxPriorityIterationsPerWindow: 0,
      repeatedStateAborts: 0,
      priorityIterationAborts: 0,
      stackResolutionAborts: 0,
      actionLimitAborts: 0,
      timeLimitAborts: 0,
      topActionWindows: [],
      recentActions: [],
      timingsMs: {},
    },
    actionWindowTotal: 0,
    actionWindowCount: 0,
    fingerprintCounts: new Map(),
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
    const diagnostics = activeDiagnostics;
    if (diagnostics) {
      diagnostics.data.timingsMs[name] = (diagnostics.data.timingsMs[name] ?? 0) + performance.now() - start;
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
  if (action.type === "CAST_SPELL") {
    const targets = action.targets?.map((target) => `${target.type}:${target.id}`).join(",") ??
      action.targetId ?? action.targetPlayer ?? action.targetGraveyardCard ?? action.targetStackId ?? "";
    return `CAST ${action.card}${action.modes?.length ? ` mode=${action.modes.join("+")}` : ""}${targets ? ` target=${targets}` : ""}`;
  }
  if (action.type === "ACTIVATE_ABILITY") {
    const targets = action.targets?.map((target) => `${target.type}:${target.id}`).join(",") ?? "";
    return `ACTIVATE ${action.sourcePermanentId} ability=${action.abilityId}${targets ? ` target=${targets}` : ""}`;
  }
  if ("card" in action) return `${action.type} ${action.card}`;
  return action.type;
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

function recordRecentAction(state: SimGameState, action: SimAction, prefix = "") {
  const diagnostics = activeDiagnostics;
  if (!diagnostics) return;
  const line = `${prefix}T${state.turn} ${state.phaseStep || state.phase} P${state.playerIndex} ${actionSummary(action)} stack=${state.stack.length}`;
  diagnostics.data.recentActions.push(line);
  if (diagnostics.data.recentActions.length > 30) diagnostics.data.recentActions.shift();
}

function diagnosticDump(state: SimGameState, reason: string) {
  const diagnostics = activeDiagnostics;
  const data = diagnostics?.data;
  const topTimings = Object.entries(data?.timingsMs ?? {})
    .sort(([, left], [, right]) => right - left)
    .slice(0, 8)
    .map(([key, value]) => `${key}=${value.toFixed(1)}ms`)
    .join(" ");
  return [
    `[watchdog] ${reason}`,
    `state ${compactFingerprint(state)}`,
    `actions=${data?.actionsApplied ?? 0} stackPushes=${data?.stackPushes ?? 0} stackResolutions=${data?.stackResolutions ?? 0} priorityPasses=${data?.priorityPasses ?? 0}`,
    `maxActions=${data?.maxAvailableActions ?? 0} maxStack=${data?.maxStackDepth ?? 0} maxPriorityIterations=${data?.maxPriorityIterationsPerWindow ?? 0}`,
    `timings ${topTimings || "none"}`,
    `recent:\n${(data?.recentActions ?? []).slice(-30).join("\n")}`,
  ].join("\n");
}

function abortEpisode(state: SimGameState, reason: string): never {
  const diagnostics = activeDiagnostics;
  if (diagnostics) {
    diagnostics.data.aborted = true;
    diagnostics.data.abortReason = reason;
    diagnostics.data.abortDump = diagnosticDump(state, reason);
    if (reason === "MAX_EPISODE_MS") diagnostics.data.timeLimitAborts++;
    if (reason === "MAX_ACTIONS_PER_EPISODE") diagnostics.data.actionLimitAborts++;
    if (reason === "MAX_STACK_RESOLUTIONS") diagnostics.data.stackResolutionAborts++;
    if (reason === "LOOP_DETECTED") diagnostics.data.repeatedStateAborts++;
    if (reason === "MAX_PRIORITY_ITERATIONS") diagnostics.data.priorityIterationAborts++;
  }
  throw new EpisodeAbort(reason, diagnostics?.data);
}

function checkEpisodeWatchdog(state: SimGameState, action?: SimAction | null, priorityPlayer?: number) {
  const diagnostics = activeDiagnostics;
  if (!diagnostics) return;
  if (Date.now() - diagnostics.startedAt > diagnostics.limits.maxEpisodeMs) {
    abortEpisode(state, "MAX_EPISODE_MS");
  }
  if (diagnostics.data.actionsApplied > diagnostics.limits.maxActionsPerEpisode) {
    abortEpisode(state, "MAX_ACTIONS_PER_EPISODE");
  }
  const fingerprint = compactFingerprint(state, { priorityPlayer, action });
  const count = (diagnostics.fingerprintCounts.get(fingerprint) ?? 0) + 1;
  diagnostics.fingerprintCounts.set(fingerprint, count);
  if (count > diagnostics.limits.maxIdenticalStateRepeats) {
    abortEpisode(state, "LOOP_DETECTED");
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
  diagnostics.data.maxAvailableActions = Math.max(diagnostics.data.maxAvailableActions, actions.length);
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
}

let permanentCounter = 0;
const nextPermanentId = () => `perm_${++permanentCounter}`;

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

function dispatchRulesEvent(
  state: SimGameState,
  event: RulesEvent,
  log: (msg: string) => void,
  metadata?: DeckCardMetadata
) {
  const enrichedEvent = metadata
    ? {
        ...event,
        data: {
          ...(event.data ?? {}),
          sourceTypeLine: metadata.typeLine ?? "",
          sourceIsCreature: metadata.isCreature ?? (metadata.typeLine ?? "").toLowerCase().includes("creature"),
        },
      }
    : event;
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
  for (let controller = 0; controller < state.permanents!.length; controller++) {
    for (const permanent of state.permanents![controller] ?? []) {
      const metadata = getCardMetadata(state, controller, permanent.cardName) ??
        getCardMetadata(state, controller, permanent.face ?? permanent.cardName);
      if (!metadata) continue;
      queueOracleTriggersForEvent(
        state,
        {
          ...event,
          controller,
        },
        log,
        metadata,
        permanent.face ?? permanent.cardName
      );
    }
  }
}

function queueOracleTriggersForEvent(
  state: SimGameState,
  event: RulesEvent,
  log: (msg: string) => void,
  metadata?: DeckCardMetadata,
  sourceNameOverride?: CardName
) {
  if (!metadata || event.controller == null) return;
  const sourceName = sourceNameOverride ?? event.face ?? event.card ?? metadata.name;
  const parsed = parseCardRules(metadata);
  for (const ability of parsed.abilities) {
    if (ability.kind !== "TRIGGERED") continue;
    if (ability.trigger?.eventType !== event.type) continue;
    if (!conditionsSatisfied(state, ability, event, sourceName)) continue;
    const entry: StackEntry = {
      id: `trigger_${Date.now()}_${state.stack.length}`,
      action: { type: "CAST_SPELL", card: sourceName },
      casterIndex: event.controller,
      resolved: false,
      responses: [],
      kind: "triggeredAbility",
      sourceCard: sourceName,
      effects: ability.effects,
    };
    state.stack.push(entry);
    log(`[Trigger] ${sourceName} ${ability.patternId ?? "ability"} put on stack`);
  }
}

function conditionsSatisfied(
  state: SimGameState,
  ability: ParsedAbility,
  event: RulesEvent,
  sourceName: string
): boolean {
  return (ability.conditions ?? []).every((condition) => {
    switch (condition.type) {
      case "SOURCE_IS_THIS":
        if (event.type === "COMBAT_DAMAGE_DEALT") {
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
      case "HAS_SUBTYPE":
        return String(event.data?.sourceTypeLine ?? "").toLowerCase().includes(condition.subtype.toLowerCase());
      case "IS_CREATURE":
        return Boolean(event.data?.sourceIsCreature) ||
          String(event.data?.sourceTypeLine ?? "").toLowerCase().includes("creature");
      case "AND":
        return condition.conditions.every((inner) => conditionsSatisfied(state, { ...ability, conditions: [inner] }, event, sourceName));
      case "OR":
        return condition.conditions.some((inner) => conditionsSatisfied(state, { ...ability, conditions: [inner] }, event, sourceName));
      case "NOT":
        return !conditionsSatisfied(state, { ...ability, conditions: [condition.condition] }, event, sourceName);
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
  activeDiagnostics = diagnostics;
  const history: SimulationResult["history"] = [];
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
  const yieldToIO = () => waitMs(turnDelayMs);
  const pauseForPhase = () => waitMs(phaseDelayMs);
  const pauseForAction = () => waitMs(actionDelayMs);

  // Emit game_start synchronously (before any await) so getFilteredState() returns
  // non-null immediately when the first WebSocket client connects.
  options.onStateChange?.(cloneState(state), { type: "game_start" });

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
          const decision = await Promise.resolve(agent.decideMulligan(hand, mulliganCount));
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
    checkEpisodeWatchdog(state);
    for (let seatOffset = 0; seatOffset < agents.length && winnerIndex === null; seatOffset++) {
      const p = (startingPlayerIndex + seatOffset) % agents.length;
      if (state.lifeTotals[p] <= 0) continue;
      state.playerIndex = p;
      await yieldToIO();
      emitRulesEvent(state, { type: "TURN_STARTED", player: p, controller: p });
      options.onStateChange?.(cloneState(state), { type: "turn_start", turn, player: p });
      const turnContext: TurnContext = {
        landDropsUsedThisTurn: 0,
        maxLandDrops: normalizeMaxLandDrops(options.maxLandDrops),
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
          enableStack,
          pauseForAction
        );
        if (windowWinner !== null) {
          winnerIndex = windowWinner;
          break;
        }
      }

      cleanupTemporaryEffects(state, p, log);
      applyStateBasedActions(state, log);

      if (
        winnerIndex === null &&
        hasLandDropCapacity(turnContext) &&
        hasPlayableLandInHand(state, p)
      ) {
        missedLandDropOpportunity++;
        log(
          `[Metrics] Player ${p} ended turn ${turn} with an unused legal land drop`
        );
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
    const response = await timeAsync("AI decideResponse", () =>
      Promise.resolve(agent.decideResponse!(responseState, currentTop, instants))
    );
    if (response === null) {
      consecutivePasses++;
      if (activeDiagnostics) activeDiagnostics.data.priorityPasses++;
      priorityPlayer = (priorityPlayer + 1) % numPlayers;
      continue;
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
    if (activeDiagnostics) {
      activeDiagnostics.data.stackResolutions++;
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
      resolveEffectDescriptors(state, entry, log);
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
  const index = library.findIndex((card) => {
    const metadata = getCardMetadata(state, player, card);
    if (effect.subtype && !(metadata?.typeLine ?? card).toLowerCase().includes(effect.subtype.toLowerCase())) {
      return false;
    }
    return effect.subtype ? true : isLandCard(state, player, card);
  });
  if (index < 0) return;
  const [card] = library.splice(index, 1);
  const toZone = effect.toZone ?? "hand";
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
  const idx = state.hands[player].indexOf(card);
  if (idx >= 0) {
    state.hands[player].splice(idx, 1);
  }
  const metadata = getCardMetadata(state, player, card);
  const paymentPlan = requireManaPaymentPlan(state, player, card, metadata, log);
  applyManaPaymentPlan(state, player, paymentPlan);
  payAdditionalCosts(state, player, metadata, log);
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
      effects: selectedAbilityEffects([ability?.ability].filter(Boolean) as ParsedAbility[], action),
      targets: action.targets,
      ability: ability?.ability,
    };
  }
  const metadata = getCardMetadata(state, player, action.card);
  const abilities = parseCardRules(metadata ?? { name: action.card }).abilities.filter((ability) => ability.kind === "SPELL_EFFECT");
  return {
    id: `stack_${Date.now()}_${player}_${state.stack.length}`,
    action,
    casterIndex: player,
    resolved: false,
    responses: [],
    kind: "spell",
    sourceCard: action.card,
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
        sacrificeBattlefieldPermanent(state, player, source.face ?? source.cardName, log);
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
  enableStack = false,
  pauseForAction: () => Promise<void> = () => Promise.resolve()
): Promise<number | null> {
  if (!rules.allowInstant && !rules.allowSorcery && !rules.allowLand) return null;

  for (let count = 0; count < MAX_ACTIONS_PER_WINDOW; count++) {
    checkEpisodeWatchdog(state);
    const available = timeBlock("generateActions", () =>
      generateActions(state, player, {
        landDropsUsedThisTurn: context.landDropsUsedThisTurn,
        maxLandDrops: context.maxLandDrops,
        allowInstant: rules.allowInstant,
        allowSorcery: rules.allowSorcery,
        allowLand: rules.allowLand,
      })
    );
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
    const decision = forcedLandDrop
      ? {
          action: forcedLandDrop,
          metadata: {
            source: "heuristic" as const,
            reasoning: "strategic_land_drop_invariant",
          },
        }
      : await timeAsync("AI chooseAction", () =>
          Promise.resolve(agents[player].decideAction(snapshot, availableSnapshot))
        );
    const action = decision.action;
    activeDiagnostics!.data.actionsApplied++;
    recordRecentAction(state, action);
    checkEpisodeWatchdog(state, action);
    if (activeDiagnostics?.debugEpisode) {
      console.log(`[debug] choose=${actionSummary(action)}`);
    }
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
    if (enableStack && (action.type === "CAST_SPELL" || action.type === "ACTIVATE_ABILITY")) {
      let stackEntry: StackEntry | null = null;
      if (action.type === "CAST_SPELL") {
        castSpellToStack(state, player, action, log);
        stackEntry = createStackEntryForAction(state, player, action);
      } else {
        stackEntry = activateAbilityToStack(state, player, action, log);
        if (!stackEntry) {
          onStateChange?.(cloneState(state), { type: "action_applied", player, action });
          await pauseForAction();
          continue;
        }
      }
      onStateChange?.(cloneState(state), { type: "action_applied", player, action });
      await pauseForAction();

      state.stack.push(stackEntry);
      activeDiagnostics!.data.stackPushes++;
      activeDiagnostics!.data.maxStackDepth = Math.max(activeDiagnostics!.data.maxStackDepth, state.stack.length);
      await timeAsync("resolveStack", () =>
        resolveStackWithPriority(state, player, agents, log, onStateChange, pauseForAction)
      );
      onStateChange?.(cloneState(state), { type: "action_applied", player, action });
      await pauseForAction();
    } else {
      applyAction(state, action, player, log);
      onStateChange?.(cloneState(state), { type: "action_applied", player, action });
      await pauseForAction();
    }

    const nextSnap = captureSnapshot(state);
    snapshotEntries.push({ playerIndex: player, prevSnapshot: prevSnap, nextSnapshot: nextSnap, action });

    const winner = checkForWinner(state);
    if (winner !== null) return winner;
    if (action.type === "PASS_TURN") break;
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
  const libraries = Array(players)
    .fill(null)
    .map((_, idx) => {
      const deckList = playerDecks?.[idx];
      const source =
        deckList && deckList.length > 0 ? deckList : DEFAULT_DECK;
      return shuffle([...source]);
    });
  const hands = libraries.map((library) => library.splice(0, 7));
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
        if (entry.landFace?.name) {
          map[entry.landFace.name.toLowerCase()] = entry;
        }
        if (entry.spellFace?.name) {
          map[entry.spellFace.name.toLowerCase()] = entry;
        }
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
    libraries,
    hands,
    creatures,
    artifacts,
    artifactMana,
    manaSpent,
    tappedPermanents: Object.fromEntries(
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

function parsedCosts(metadata?: DeckCardMetadata): CostDescriptor[] {
  if (!metadata) return [];
  return parseCardRules(metadata).abilities.flatMap((ability) => ability.costs ?? []);
}

function canPayAdditionalCosts(
  state: SimGameState,
  player: number,
  metadata?: DeckCardMetadata
) {
  for (const cost of parsedCosts(metadata)) {
    if (cost.type !== "SACRIFICE") continue;
    const available = getControlledPermanentsByType(state, player, cost.cardType ?? "permanent");
    if (available.length < (cost.amount ?? 1)) return false;
  }
  return true;
}

function payAdditionalCosts(
  state: SimGameState,
  player: number,
  metadata: DeckCardMetadata | undefined,
  log: (msg: string) => void
) {
  for (const cost of parsedCosts(metadata)) {
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
    return typeof target.id === "string" && state.stack.some((entry) => entry.id === target.id && !entry.resolved);
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
  context: ActionGenerationContext
) {
  if (!context.allowInstant && !context.allowSorcery) return false;
  const metadata = getCardMetadata(state, player, card);
  if (!isCastableSpellCard(state, player, card)) return false;

  const face = metadata?.spellFace?.name;
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
  const graveyardTarget = findDefaultGraveyardTargetForCard(state, player, metadata);
  const requiresMissingGraveyardTarget = parseCardRules(metadata ?? { name: card }).abilities.some((ability) =>
    ability.targets?.some((target) => target.zone === "graveyard" && target.required !== false) &&
    !graveyardTarget
  );
  if (requiresMissingGraveyardTarget) return false;
  if (!hasRequiredTargets(state, player, metadata)) return false;

  const plan = findManaPaymentPlan(state, player, getSpellManaCost(card, state, player));
  if (!plan.legal) {
    recordManaPaymentFailure(state);
    return false;
  }
  return true;
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
        actions.push({ type: "PLAY_LAND", card, face: metadata?.landFace?.name });
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

  actions.push(...buildActivatedAbilityActions(state, player, context));

  return actions;
}

function buildCastSpellActions(
  state: SimGameState,
  player: number,
  card: CardName,
  metadata?: DeckCardMetadata
): Extract<SimAction, { type: "CAST_SPELL" }>[] {
  const parsed = metadata ? parseCardRules(metadata) : undefined;
  const spellAbilities = parsed?.abilities.filter((ability) => ability.kind === "SPELL_EFFECT") ?? [];
  const base = {
    type: "CAST_SPELL" as const,
    card,
    face: metadata?.spellFace?.name,
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
      if (cost.source) continue;
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
  const requirements = parseCardRules(metadata).abilities.flatMap((ability) => ability.targets ?? []);
  for (const requirement of requirements) {
    if (requirement.required === false || requirement.optional) continue;
    if (getLegalTargets(state, player, requirement).length === 0) {
      return false;
    }
  }
  return true;
}

export function applyAction(
  state: SimGameState,
  action: SimAction,
  player: number,
  log: (message: string) => void
) {
  switch (action.type) {
    case "PLAY_LAND": {
      const idx = state.hands[player].indexOf(action.card);
      if (idx >= 0) state.hands[player].splice(idx, 1);
      const metadata = getCardMetadata(state, player, action.card);
      const landName = action.face ?? getLandPermanentName(action.card, metadata);
      state.battlefields[player].push(landName);
      addPermanentState(state, {
        cardName: action.card,
        owner: player,
        controller: player,
        face: landName,
        tapped: landEntersTapped(metadata),
      });
      if (landEntersTapped(metadata)) {
        state.tappedPermanents ??= {};
        state.tappedPermanents[player] ??= {};
        state.tappedPermanents[player][landName.toLowerCase()] =
          (state.tappedPermanents[player][landName.toLowerCase()] ?? 0) + 1;
      }
      log(
        `Player ${player} plays land ${landName}` +
          (landEntersTapped(metadata) ? " tapped" : "")
      );
      emitRulesEvent(state, {
        type: "LAND_PLAYED",
        player,
        controller: player,
        card: action.card,
        face: landName,
      });
      dispatchRulesEvent(state, {
        type: "PERMANENT_ENTERED",
        player,
        controller: player,
        card: action.card,
        face: landName,
      }, log, metadata);
      handleLandEntered(state, player, landName, log, "play");
      handlePermanentEntersBattlefield(state, player, landName, metadata, log);
      break;
    }
    case "CAST_SPELL": {
      const metadata = getCardMetadata(state, player, action.card);
      const paymentPlan = requireManaPaymentPlan(state, player, action.card, metadata, log);
      const idx = state.hands[player].indexOf(action.card);
      if (idx >= 0) state.hands[player].splice(idx, 1);
      applyManaPaymentPlan(state, player, paymentPlan);
      payAdditionalCosts(state, player, metadata, log);
      resolveSpell(state, player, action.card, log, action.face, action.targetId, action.targetGraveyardCard, action);
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
  const spellName = face ?? getSpellPermanentName(card, metadata);
  emitRulesEvent(state, {
    type: "SPELL_RESOLVED",
    player,
    controller: player,
    card,
    face: spellName,
  });
  if (isCreatureCard(card, metadata)) {
    summonCreature(state, player, spellName, log, metadata?.spellFace ? {
      ...metadata,
      name: spellName,
      typeLine: metadata.spellFace.typeLine ?? metadata.typeLine,
      oracleText: metadata.spellFace.oracleText ?? metadata.oracleText,
      manaValue: metadata.spellFace.manaValue ?? metadata.manaValue,
      power: metadata.spellFace.power ?? metadata.power,
      toughness: metadata.spellFace.toughness ?? metadata.toughness,
      isLand: false,
      isCreature: metadata.spellFace.isCreature ?? metadata.isCreature,
    } : metadata);
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
    }, log, metadata);
    return;
  }

  if (isPermanentCard(card, metadata)) {
    placePermanent(state, player, spellName, metadata, log);
    return;
  }

  if (resolveSpellEffectsFromRegistry(state, player, card, metadata, log, targetId, targetGraveyardCard, action)) {
    return;
  }

  if (handleTokenCreationSpell(state, player, card, metadata, log)) {
    return;
  }

  if (handleRemovalSpell(state, player, card, metadata, log, targetId)) {
    return;
  }

  if (handleDirectDamageSpell(state, player, card, metadata, log)) {
    return;
  }

  markUnsupportedEffect(state, card, metadata?.oracleText, log);
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

function getSpellManaCost(card: string, state: SimGameState, player: number): ManaCost {
  const metadata = getCardMetadata(state, player, card);
  const fallbackCost = getSpellCost(card, state, player);
  const parsed = manaCostFromMetadata(metadata, fallbackCost);
  return reduceGenericManaCost(parsed, totalGenericCostReduction(state, player, card, metadata));
}

function requireManaPaymentPlan(
  state: SimGameState,
  player: number,
  card: string,
  metadata: DeckCardMetadata | undefined,
  log: (msg: string) => void
): ManaPaymentPlan {
  const cost = getSpellManaCost(card, state, player);
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
