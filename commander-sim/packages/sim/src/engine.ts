import type {
  AttackDecision,
  BlockAssignment,
  BlockDecision,
  CardName,
  DeckCardMetadata,
  DecisionMetadata,
  GameEvent,
  SimAction,
  SimAgent,
  SimGameState,
  SimulationOptions,
  SimulationResult,
  StackEntry,
} from "@game-state/types";
import { shouldMulligan, chooseBottomCards } from "./mulliganEvaluator.js";
import type { CreaturePermanent } from "@rules/combat/types";
import { isLearningAgent } from "./learningAgent.js";
import {
  captureSnapshot,
  shapeReward,
  discountRewards,
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
  isInstantCard,
  getAvailableInstants,
  getAvailableMana,
  isCounterspell,
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

const DEFAULT_DECK = [
  ...Array(18).fill("Basic Land"),
  ...Array(8).fill("Burn Spell"),
  ...Array(8).fill("Wild Beast"),
  ...Array(6).fill("Titanic Ogre"),
];

const DEFAULT_ENABLE_STACK = process.env.ENABLE_STACK === "true";

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

// Phase 2 — parallel snapshot array, kept in sync with history[]
interface StepSnapshotEntry {
  playerIndex: number;
  prevSnapshot: StateSnapshot;
  nextSnapshot: StateSnapshot;
  action: SimAction;
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
  const history: SimulationResult["history"] = [];
  // Phase 2 — parallel snapshot array (one entry per history entry)
  const snapshotEntries: StepSnapshotEntry[] = [];

  let winnerIndex: number | null = null;

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
        const toBottom = state.hands[p].splice(maxMulligans);
        state.libraries[p].push(...toBottom);
        options.onStateChange?.(cloneState(state), { type: "mulligan_done", player: p, mulliganCount: maxMulligans });
      }
    }
  }

  const startingPlayerIndex = options.startingPlayerIndex ?? 0;

  for (let turn = 1; turn <= maxTurns && winnerIndex === null; turn++) {
    state.turn = turn;
    for (let seatOffset = 0; seatOffset < agents.length && winnerIndex === null; seatOffset++) {
      const p = (startingPlayerIndex + seatOffset) % agents.length;
      if (state.lifeTotals[p] <= 0) continue;
      state.playerIndex = p;
      await yieldToIO();
      options.onStateChange?.(cloneState(state), { type: "turn_start", turn, player: p });
      const turnContext = { landPlayedThisTurn: false };

      for (const step of TURN_STRUCTURE) {
        state.phase = step.phase;
        state.phaseStep = step.step;
        options.onStateChange?.(cloneState(state), { type: "phase_change", phase: step.phase, step: step.step });
        await pauseForPhase();

        if (step.auto) {
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
    }
  }

  if (winnerIndex === null) {
    winnerIndex = determineWinnerByLife(state);
  }

  options.onStateChange?.(cloneState(state), { type: "game_over", winner: winnerIndex });

  // Phase 2 — compute shaped rewards and finalize agents
  agents.forEach((agent, agentIdx) => {
    if (!isLearningAgent(agent)) return;

    const terminalReward = winnerIndex === null ? 0 : winnerIndex === agentIdx ? 1 : -1;

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

  return { winnerIndex, history, turns: state.turn, finalState: cloneState(state) };
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
    await passPriority(state, attackerIndex, stackEntry, agents, log, onStateChange, pauseForAction);
    resolveStack(state, log);
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
  for (let offset = 1; offset < numPlayers; offset++) {
    const opponentIndex = (castingPlayer + offset) % numPlayers;
    if (state.lifeTotals[opponentIndex] <= 0) continue;
    const agent = agents[opponentIndex];
    if (typeof agent.decideResponse !== "function") continue;

    const instants = getAvailableInstants(state, opponentIndex, stackEntry);
    if (instants.length === 0) continue;

    const responseState = {
      ...state,
      playerIndex: opponentIndex,
    };
    const response = await Promise.resolve(
      agent.decideResponse(responseState, stackEntry, instants)
    );
    if (response === null) continue;

    if (response.type === "CAST_SPELL") {
      castSpellToStack(state, opponentIndex, response.card, log);
      onStateChange?.(cloneState(state), { type: "action_applied", player: opponentIndex, action: response });
      await pauseForAction();
    }

    const responseEntry: StackEntry = {
      id: `stack_${Date.now()}_${opponentIndex}`,
      action: response,
      casterIndex: opponentIndex,
      resolved: false,
      responses: [],
    };
    stackEntry.responses.push(responseEntry);
    state.stack.push(responseEntry);
    log(`[Stack] Player ${opponentIndex} responds with ${response.type}`);

    // Recursive: give priority to opponents of the responder
    await passPriority(state, opponentIndex, responseEntry, agents, log, onStateChange, pauseForAction);
  }
}

function resolveStack(state: SimGameState, log: (msg: string) => void): void {
  // LIFO: resolve from top (end of array) to bottom
  while (state.stack.length > 0) {
    const entry = state.stack.pop()!;
    if (entry.resolved) continue;
    entry.resolved = true;
    log(`[Stack] Resolving ${entry.action.type} from player ${entry.casterIndex}`);
    if (entry.action.type === "CAST_SPELL") {
      if (resolveCounterspell(state, entry, log)) {
        continue;
      }
      resolveSpell(state, entry.casterIndex, entry.action.card, log);
    }
  }
}

function castSpellToStack(
  state: SimGameState,
  player: number,
  card: string,
  log: (msg: string) => void
) {
  const idx = state.hands[player].indexOf(card);
  if (idx >= 0) {
    state.hands[player].splice(idx, 1);
  }
  spendManaForSpell(state, player, card);
  log(`Player ${player} casts ${card}`);
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
  context: { landPlayedThisTurn: boolean },
  rules: ActionWindowRules,
  snapshotEntries: StepSnapshotEntry[],
  onStateChange?: (state: SimGameState, event: GameEvent) => void,
  enableStack = false,
  pauseForAction: () => Promise<void> = () => Promise.resolve()
): Promise<number | null> {
  if (!rules.allowInstant && !rules.allowSorcery && !rules.allowLand) return null;

  for (let count = 0; count < MAX_ACTIONS_PER_WINDOW; count++) {
    const available = generateActions(state, player, {
      landPlayedThisTurn: context.landPlayedThisTurn,
      allowInstant: rules.allowInstant,
      allowSorcery: rules.allowSorcery,
      allowLand: rules.allowLand,
    });
    const availableSnapshot = cloneActions(available);
    const requiresManualPass = agents[player]?.id === "human";
    if (availableSnapshot.length === 1 && !requiresManualPass) break;

    const snapshot = cloneState(state);
    const decision = await Promise.resolve(
      agents[player].decideAction(snapshot, availableSnapshot)
    );
    const action = decision.action;
    history.push({
      playerIndex: player,
      agentId: agents[player].id,
      action,
      state: snapshot,
      availableActions: availableSnapshot,
      metadata: decision.metadata,
    });

    context.landPlayedThisTurn =
      context.landPlayedThisTurn || action.type === "PLAY_LAND";

    // Phase 2: cattura prev/next snapshot attorno ad applyAction
    const prevSnap = captureSnapshot(state);
    if (enableStack && action.type === "CAST_SPELL") {
      castSpellToStack(state, player, action.card, log);
      onStateChange?.(cloneState(state), { type: "action_applied", player, action });
      await pauseForAction();

      const stackEntry: StackEntry = {
        id: `stack_${Date.now()}_${player}`,
        action,
        casterIndex: player,
        resolved: false,
        responses: [],
      };
      state.stack.push(stackEntry);
      await passPriority(state, player, stackEntry, agents, log, onStateChange, pauseForAction);
      resolveStack(state, log);
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
    graveyards,
    commanders,
    libraries,
    hands,
    creatures,
    artifacts,
    artifactMana,
    manaSpent,
    cardMetadata: metadataMaps,
    triggers: [],
    triggerCounter: 1,
    phase: TURN_STRUCTURE[0]?.phase ?? "",
    phaseStep: TURN_STRUCTURE[0]?.step ?? "",
    costReducers,
    handSizeModifiers,
    drawHistory,
    stack: [],
  };
}

function cloneActions(actions: SimAction[]): SimAction[] {
  return actions.map((action) =>
    ("card" in action ? { type: action.type, card: action.card } : { type: action.type }) as SimAction
  );
}

function drawCard(state: SimGameState, player: number) {
  const library = state.libraries[player];
  if (library.length === 0) return;
  const card = library.shift();
  if (card) {
    state.hands[player].push(card);
    state.drawHistory[player] = (state.drawHistory[player] ?? 0) + 1;
  }
}

interface ActionGenerationContext {
  landPlayedThisTurn: boolean;
  allowInstant: boolean;
  allowSorcery: boolean;
  allowLand: boolean;
}

function generateActions(
  state: SimGameState,
  player: number,
  context: ActionGenerationContext
): SimAction[] {
  const actions: SimAction[] = [{ type: "PASS_TURN" }];
  const hand = state.hands[player];

  if (context.allowLand && !context.landPlayedThisTurn) {
    hand
      .filter((card) => isLandCard(state, player, card))
      .forEach((card) => {
        actions.push({ type: "PLAY_LAND", card });
      });
  }

  if (!context.allowInstant && !context.allowSorcery) {
    return actions;
  }

  const landMana = state.battlefields[player].filter((card) =>
    isLandCard(state, player, card)
  ).length;
  const artifactMana = state.artifactMana?.[player] ?? 0;
  const availableMana = Math.max(
    0,
    landMana + artifactMana - (state.manaSpent?.[player] ?? 0)
  );

  hand
    .filter((card) => !isLandCard(state, player, card))
    .forEach((card) => {
      const metadata = getCardMetadata(state, player, card);
      if (isCounterspell(card, metadata)) return;
      const isInstant = isInstantCard(state, player, card, metadata);
      const canCast =
        isInstant && context.allowInstant
          ? true
          : !isInstant && context.allowSorcery;
      if (!canCast) return;
      const cost = getSpellCost(card, state, player);
      if (cost <= availableMana) {
        actions.push({ type: "CAST_SPELL", card });
      }
    });

  return actions;
}

function applyAction(
  state: SimGameState,
  action: SimAction,
  player: number,
  log: (message: string) => void
) {
  switch (action.type) {
    case "PLAY_LAND": {
      const idx = state.hands[player].indexOf(action.card);
      if (idx >= 0) state.hands[player].splice(idx, 1);
      state.battlefields[player].push(action.card);
      log(`Player ${player} plays land ${action.card}`);
      const metadata = getCardMetadata(state, player, action.card);
      handleLandEntered(state, player, action.card, log, "play");
      handlePermanentEntersBattlefield(state, player, action.card, metadata, log);
      break;
    }
    case "CAST_SPELL": {
      const idx = state.hands[player].indexOf(action.card);
      if (idx >= 0) state.hands[player].splice(idx, 1);
      spendManaForSpell(state, player, action.card);
      resolveSpell(state, player, action.card, log);
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
  log: (msg: string) => void
) {
  const metadata = getCardMetadata(state, player, card);
  if (isCreatureCard(card, metadata)) {
    summonCreature(state, player, card, log, metadata);
    return;
  }

  if (isPermanentCard(card, metadata)) {
    placePermanent(state, player, card, metadata, log);
    return;
  }

  if (handleTokenCreationSpell(state, player, card, metadata, log)) {
    return;
  }

  if (handleRemovalSpell(state, player, card, metadata, log)) {
    return;
  }

  if (handleDirectDamageSpell(state, player, card, metadata, log)) {
    return;
  }

  const target = findNextOpponent(state, player);
  const damage = isBurnSpell(card) ? 5 : 3;
  if (target !== null) {
    state.lifeTotals[target] -= damage;
    log(`Player ${player} casts ${card} dealing ${damage} to player ${target}`);
  } else {
    log(`Player ${player} casts ${card} with no valid target`);
  }
  state.graveyards[player].push(card);
}

function resolveCounterspell(
  state: SimGameState,
  entry: StackEntry,
  log: (msg: string) => void
) {
  if (entry.action.type !== "CAST_SPELL") return false;
  const metadata = getCardMetadata(state, entry.casterIndex, entry.action.card);
  if (!isCounterspell(entry.action.card, metadata)) return false;

  const targetStackId = entry.action.targetStackId;
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
  if (isArtifactCard(card, metadata)) {
    if (!state.artifacts[player]) {
      state.artifacts[player] = [];
    }
    state.artifacts[player].push(card);
    const manaBonus = metadata?.manaProduction ?? 0;
    if (manaBonus > 0) {
      state.artifactMana[player] =
        (state.artifactMana[player] ?? 0) + manaBonus;
    }
  }
  log(`Player ${player} resolves permanent ${card}`);
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
  log: (msg: string) => void
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
    const target = selectCreatureTarget(state, player);
    if (target) {
      destroyCreature(state, target.controller, target.creature.id, log);
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
    const target = selectCreatureTarget(state, player);
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
  if (typeof metadata?.manaValue === "number" && metadata.manaValue > 0) {
    return applyCostReductions(state, player, card, metadata, metadata.manaValue);
  }
  if (isBurnSpell(card)) return 2;
  if (metadata?.isCreature || isCreatureCard(card, metadata)) {
    if (typeof metadata?.manaValue === "number") {
      return applyCostReductions(
        state,
        player,
        card,
        metadata,
        metadata.manaValue || 3
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

function spendManaForSpell(
  state: SimGameState,
  player: number,
  card: string
) {
  const cost = getSpellCost(card, state, player);
  const available = getAvailableMana(state, player);
  const spend = Math.min(cost, available);
  state.manaSpent[player] = (state.manaSpent[player] ?? 0) + spend;
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
  const reducers = state.costReducers[player] ?? [];
  let totalReduction = 0;
  for (const reducer of reducers) {
    try {
      if (reducer.appliesTo({ state, player, card, metadata })) {
        totalReduction += reducer.amount;
      }
    } catch {
      continue;
    }
  }
  const finalCost = Math.max(0, baseCost - totalReduction);
  return finalCost;
}

function destroyAllCreatures(
  state: SimGameState,
  log: (msg: string) => void
) {
  for (let controller = 0; controller < state.creatures.length; controller++) {
    const pool = [...state.creatures[controller]];
    for (const creature of pool) {
      destroyCreature(state, controller, creature.id, log);
    }
  }
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
  state.graveyards[controller].push(card);
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
    destroyCreature(state, controller, creature.id, log);
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
