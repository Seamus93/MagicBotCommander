import type { SimGameState } from "@game-state/types";
import type { CreaturePermanent } from "@rules/combat/types";
import {
  availableAttackers,
  availableBlockers,
} from "../../rules/src/combat/combat.js";

export interface AttackPlan {
  attackers: string[];
  targetPlayer: number;
  expectedDamage: number;
  expectedLosses: number;
  score: number;
}

export interface BlockPlan {
  assignments: Map<string, string[]>;
  creaturesKilled: number;
  creaturesKilledValue?: number;
  damagePrevented: number;
  totalIncomingDamage: number;
  blockersLost: number;
  blockersLostValue?: number;
  score: number;
}

interface CombatOutcome {
  damageToPlayer: number;
  attackersKilled: number;
  blockersKilled: number;
  attackersKilledValue: number;
  blockersKilledValue: number;
}

export function generateAttackPlans(
  state: SimGameState,
  playerIndex: number,
  targetIndex: number
): AttackPlan[] {
  const attackers = availableAttackers(state, playerIndex);
  if (!attackers.length) {
    return [
      {
        attackers: [],
        targetPlayer: targetIndex,
        expectedDamage: 0,
        expectedLosses: 0,
        score: scoreAttackPlan(
          {
            attackers: [],
            targetPlayer: targetIndex,
            expectedDamage: 0,
            expectedLosses: 0,
            score: 0,
          },
          withPlayerContext(state, playerIndex)
        ),
      },
    ];
  }

  const blockers = availableBlockers(state, targetIndex);
  const maxBlockerToughness = Math.max(
    0,
    ...blockers.map((creature) => creature.toughness)
  );
  const maxBlockerPower = Math.max(0, ...blockers.map((creature) => creature.power));
  const allInIds = attackers.map((creature) => creature.id);
  const conservativeIds = attackers
    .filter(
      (creature) =>
        blockers.length === 0 ||
        creature.toughness > maxBlockerPower ||
        creature.power >= Math.max(1, maxBlockerToughness - 1) ||
        creatureValue(state, playerIndex, creature) <= 1.2
    )
    .map((creature) => creature.id);
  const selectiveIds = attackers
    .filter((creature) => creature.power > maxBlockerToughness)
    .map((creature) => creature.id);
  const totalReadyPower = attackers.reduce((sum, creature) => sum + creature.power, 0);
  const alphaStrikeIds =
    totalReadyPower >= (state.lifeTotals[targetIndex] ?? 0) ? allInIds : [];

  const candidates = [
    allInIds,
    conservativeIds,
    alphaStrikeIds,
    selectiveIds,
    [],
  ];

  const seen = new Set<string>();
  const plans: AttackPlan[] = [];
  for (const candidate of candidates) {
    const key = serializeIds(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    plans.push(buildAttackPlan(state, playerIndex, targetIndex, candidate));
  }

  return plans.sort((left, right) => right.score - left.score);
}

export function scoreAttackPlan(plan: AttackPlan, defenderState: SimGameState): number {
  const defenderLife = defenderState.lifeTotals[plan.targetPlayer] ?? 0;
  const readyCount = availableAttackers(defenderState, defenderState.playerIndex).length;
  const lethalBonus = plan.expectedDamage >= defenderLife && defenderLife > 0 ? 18 : 0;
  const alphaRiskPenalty =
    plan.attackers.length > 0 && plan.attackers.length === readyCount && lethalBonus === 0 ? 1.5 : 0;
  if (plan.attackers.length === 0 && readyCount > 0) return -0.25;
  return plan.expectedDamage * 1.7 - plan.expectedLosses * 0.2 + lethalBonus - alphaRiskPenalty;
}

export function generateBlockPlans(
  state: SimGameState,
  playerIndex: number,
  attackers: string[]
): BlockPlan[] {
  const incomingAttackers = resolveIncomingAttackers(state, playerIndex, attackers);
  const blockers = availableBlockers(state, playerIndex);
  const totalIncomingDamage = incomingAttackers.reduce(
    (sum, attacker) => sum + attacker.power,
    0
  );

  if (!incomingAttackers.length || !blockers.length) {
    return [
      buildBlockPlan(
        new Map(),
        incomingAttackers,
        blockers,
        state.lifeTotals[playerIndex] ?? 0
      ),
    ];
  }

  const plans: Map<string, BlockPlan> = new Map();
  const addPlan = (assignments: Map<string, string[]>) => {
    const plan = buildBlockPlan(
      assignments,
      incomingAttackers,
      blockers,
      state.lifeTotals[playerIndex] ?? 0
    );
    plans.set(serializeAssignments(plan.assignments), plan);
  };

  addPlan(buildTradeUpAssignments(incomingAttackers, blockers));
  addPlan(buildChumpAssignments(incomingAttackers, blockers));

  const doubleBlock = buildDoubleBlockAssignments(incomingAttackers, blockers);
  if (doubleBlock.size > 0) {
    addPlan(doubleBlock);
  }

  const noBlockThreshold = Math.max(8, Math.floor((state.lifeTotals[playerIndex] ?? 0) / 2));
  if (totalIncomingDamage < noBlockThreshold) {
    addPlan(new Map());
  }

  addPlan(buildSelectiveAssignments(incomingAttackers, blockers));

  if (!plans.size) {
    addPlan(new Map());
  }

  return [...plans.values()].sort((left, right) => right.score - left.score);
}

export function scoreBlockPlan(
  plan: BlockPlan,
  attackers: CreaturePermanent[],
  life: number
): number {
  const incomingDamage = attackers.reduce((sum, attacker) => sum + attacker.power, 0);
  const preventsLethal = incomingDamage >= life && plan.damagePrevented >= life;
  const lethalPreventionBonus = preventsLethal ? 8 : 0;
  const damagePreventedWeight = preventsLethal ? 0.9 : 0;
  return (
    (plan.creaturesKilledValue ?? plan.creaturesKilled) * 1.15 +
    plan.damagePrevented * damagePreventedWeight -
    (plan.blockersLostValue ?? plan.blockersLost) * 1.1 +
    lethalPreventionBonus
  );
}

export function canAlphaStrike(
  state: SimGameState,
  playerIndex: number,
  targetIndex: number
): boolean {
  const attackers = availableAttackers(state, playerIndex);
  if (!attackers.length) return false;
  const totalPower = attackers.reduce((sum, creature) => sum + creature.power, 0);
  if (totalPower <= (state.lifeTotals[targetIndex] ?? 0)) return false;

  const blockers = availableBlockers(state, targetIndex);
  if (!blockers.length) return true;

  return attackers.some((creature) => hasEvasionKeyword(state, playerIndex, creature));
}

export function isLethalOnBoard(
  state: SimGameState,
  playerIndex: number,
  targetIndex: number
): boolean {
  const attackers = availableAttackers(state, playerIndex);
  if (!attackers.length) return false;
  const attackIds = attackers.map((creature) => creature.id);
  const blockPlans = generateBlockPlans(state, targetIndex, attackIds);
  const bestDefense = pickBestBlockPlan(blockPlans);
  const outcome = simulateCombatOutcome(attackers, resolveBlockersForPlan(bestDefense, state, targetIndex));
  return outcome.damageToPlayer >= (state.lifeTotals[targetIndex] ?? 0);
}

export function selectTarget(
  state: SimGameState,
  playerIndex: number,
  opponentIndices: number[]
): number {
  const opponents = opponentIndices.filter(
    (index) => index !== playerIndex && (state.lifeTotals[index] ?? 0) > 0
  );
  if (!opponents.length) {
    return playerIndex;
  }

  const totalReadyPower = availableAttackers(state, playerIndex).reduce(
    (sum, creature) => sum + creature.power,
    0
  );
  const leader = politicalTarget(state, playerIndex, opponents);
  const sameLifeTotals =
    new Set(opponents.map((opponent) => state.lifeTotals[opponent] ?? 0)).size === 1;

  if (sameLifeTotals) {
    return leader;
  }

  return [...opponents].sort((left, right) => {
    const leftKillable = (state.lifeTotals[left] ?? 0) <= totalReadyPower ? 1 : 0;
    const rightKillable = (state.lifeTotals[right] ?? 0) <= totalReadyPower ? 1 : 0;
    if (leftKillable !== rightKillable) {
      return rightKillable - leftKillable;
    }

    const leftThreat = threatAssessment(state, left);
    const rightThreat = threatAssessment(state, right);
    const leftLife = state.lifeTotals[left] ?? 0;
    const rightLife = state.lifeTotals[right] ?? 0;
    if (
      Math.abs(leftThreat - rightThreat) < 20 &&
      Math.min(leftLife, rightLife) < 25 &&
      Math.abs(leftLife - rightLife) >= 5
    ) {
      return leftLife - rightLife;
    }
    if (Math.abs(leftThreat - rightThreat) < 8 && Math.abs(leftLife - rightLife) >= 5) {
      return leftLife - rightLife;
    }
    if (leftThreat !== rightThreat) {
      return rightThreat - leftThreat;
    }

    const leftBlockers = availableBlockers(state, left).length;
    const rightBlockers = availableBlockers(state, right).length;
    if (leftBlockers !== rightBlockers) {
      return leftBlockers - rightBlockers;
    }

    const leftLeader = left === leader ? 1 : 0;
    const rightLeader = right === leader ? 1 : 0;
    if (leftLeader !== rightLeader) {
      return rightLeader - leftLeader;
    }

    if (leftLife !== rightLife) {
      return rightLife - leftLife;
    }

    return left - right;
  })[0];
}

export function threatAssessment(state: SimGameState, opponentIndex: number): number {
  const creatures = state.creatures[opponentIndex] ?? [];
  const boardPower = creatures.reduce((sum, creature) => sum + creature.power, 0);
  const creatureQuality = creatures.reduce(
    (sum, creature) => sum + creatureValue(state, opponentIndex, creature),
    0
  );
  const creatureCount = creatures.length;
  const cardsInHand = state.hands[opponentIndex]?.length ?? 0;
  const battlefield = state.battlefields[opponentIndex] ?? [];
  const permanentCount = battlefield.length + creatureCount;
  const artifactMana = state.artifactMana[opponentIndex] ?? 0;
  const lands = battlefield.filter((card) => {
    const meta = state.cardMetadata[opponentIndex]?.[card.toLowerCase()];
    return meta?.isLand ?? card.toLowerCase().includes("land");
  }).length;
  const commander = state.commanders[opponentIndex]?.toLowerCase();
  const commanderPresent = creatures.some((creature) => creature.name.toLowerCase() === commander) ||
    battlefield.some((card) => card.toLowerCase() === commander);
  const valuePieces = battlefield.filter((card) => {
    const meta = state.cardMetadata[opponentIndex]?.[card.toLowerCase()];
    const text = `${meta?.oracleText ?? ""} ${meta?.typeLine ?? ""}`.toLowerCase();
    return /whenever|at the beginning|draw|treasure|token|copy|combo|storm|cascade/.test(text);
  }).length;
  const graveyardRelevant = (state.graveyards[opponentIndex]?.length ?? 0) >= 8 ? 1 : 0;
  const lifeTotal = state.lifeTotals[opponentIndex] ?? 0;
  const canLethalSomeone = state.lifeTotals.some(
    (life, index) => index !== opponentIndex && life > 0 && boardPower >= life
  );
  return (
    boardPower * 1.5 +
    creatureQuality * 1.4 +
    creatureCount * 1.2 +
    permanentCount * 0.55 +
    cardsInHand * 1.15 +
    (lands + artifactMana) * 0.85 +
    (commanderPresent ? 4 : 0) +
    valuePieces * 2.3 +
    graveyardRelevant * 2 +
    (canLethalSomeone ? 7 : 0) +
    Math.floor(lifeTotal / 15)
  );
}

export function politicalTarget(
  state: SimGameState,
  playerIndex: number,
  opponentIndices: number[]
): number {
  const opponents = opponentIndices.filter(
    (index) => index !== playerIndex && (state.lifeTotals[index] ?? 0) > 0
  );
  if (!opponents.length) {
    return playerIndex;
  }

  return [...opponents].sort((left, right) => {
    const leftThreat = threatAssessment(state, left);
    const rightThreat = threatAssessment(state, right);
    if (leftThreat !== rightThreat) {
      return rightThreat - leftThreat;
    }

    const leftLife = state.lifeTotals[left] ?? 0;
    const rightLife = state.lifeTotals[right] ?? 0;
    if (leftLife !== rightLife) {
      return leftLife - rightLife;
    }

    return left - right;
  })[0];
}

function buildAttackPlan(
  state: SimGameState,
  playerIndex: number,
  targetIndex: number,
  attackerIds: string[]
): AttackPlan {
  const attackers = availableAttackers(state, playerIndex).filter((creature) =>
    attackerIds.includes(creature.id)
  );
  const blockPlans = generateBlockPlans(state, targetIndex, attackerIds);
  const bestDefense = pickBestBlockPlan(blockPlans);
  const outcome = simulateCombatOutcome(
    attackers,
    resolveBlockersForPlan(bestDefense, state, targetIndex),
    (creature) => creatureValue(state, playerIndex, creature),
    (creature) => creatureValue(state, targetIndex, creature)
  );

  const plan: AttackPlan = {
    attackers: attackers.map((creature) => creature.id),
    targetPlayer: targetIndex,
    expectedDamage: outcome.damageToPlayer,
    expectedLosses: outcome.attackersKilledValue,
    score: 0,
  };
  plan.score = scoreAttackPlan(plan, withPlayerContext(state, playerIndex));
  return plan;
}

function buildBlockPlan(
  assignments: Map<string, string[]>,
  attackers: CreaturePermanent[],
  blockers: CreaturePermanent[],
  life: number
): BlockPlan {
  const blockerLookup = new Map(
    blockers.map((blocker) => [blocker.id, blocker] as const)
  );
  const blockersByAttacker = new Map<string, CreaturePermanent[]>();
  for (const [attackerId, blockerIds] of assignments.entries()) {
    const assignedBlockers = blockerIds
      .map((blockerId) => blockerLookup.get(blockerId))
      .filter((blocker): blocker is CreaturePermanent => Boolean(blocker));
    if (assignedBlockers.length) {
      blockersByAttacker.set(attackerId, assignedBlockers);
    }
  }

  const outcome = simulateCombatOutcome(attackers, blockersByAttacker);
  const totalIncoming = attackers.reduce((sum, attacker) => sum + attacker.power, 0);
  const plan: BlockPlan = {
    assignments: cloneAssignments(assignments),
    creaturesKilled: outcome.attackersKilled,
    creaturesKilledValue: outcome.attackersKilledValue,
    damagePrevented: totalIncoming - outcome.damageToPlayer,
    totalIncomingDamage: totalIncoming,
    blockersLost: outcome.blockersKilled,
    blockersLostValue: outcome.blockersKilledValue,
    score: 0,
  };
  plan.score = scoreBlockPlan(plan, attackers, life);
  return plan;
}

function buildTradeUpAssignments(
  attackers: CreaturePermanent[],
  blockers: CreaturePermanent[]
): Map<string, string[]> {
  const assignments = new Map<string, string[]>();
  const usedAttackers = new Set<string>();

  for (const blocker of [...blockers].sort(byStrengthAsc)) {
    const candidate = [...attackers]
      .filter((attacker) => !usedAttackers.has(attacker.id))
      .sort(byStrengthDesc)
      .find(
        (attacker) =>
          blocker.power >= attacker.toughness || attacker.power >= blocker.toughness
      );
    if (!candidate) continue;
    assignments.set(candidate.id, [blocker.id]);
    usedAttackers.add(candidate.id);
  }

  return assignments;
}

function buildChumpAssignments(
  attackers: CreaturePermanent[],
  blockers: CreaturePermanent[]
): Map<string, string[]> {
  if (!attackers.length || !blockers.length) return new Map();
  const biggestAttacker = [...attackers].sort(byStrengthDesc)[0];
  const smallestBlocker = [...blockers].sort(byStrengthAsc)[0];
  return new Map([[biggestAttacker.id, [smallestBlocker.id]]]);
}

function buildDoubleBlockAssignments(
  attackers: CreaturePermanent[],
  blockers: CreaturePermanent[]
): Map<string, string[]> {
  if (blockers.length < 2 || !attackers.length) return new Map();
  const biggestAttacker = [...attackers].sort(byStrengthDesc)[0];
  const pair = [...blockers]
    .sort(byStrengthAsc)
    .slice(0, 2);
  const combinedPower = pair.reduce((sum, blocker) => sum + blocker.power, 0);
  if (combinedPower < biggestAttacker.toughness) {
    return new Map();
  }
  return new Map([[biggestAttacker.id, pair.map((blocker) => blocker.id)]]);
}

function buildSelectiveAssignments(
  attackers: CreaturePermanent[],
  blockers: CreaturePermanent[]
): Map<string, string[]> {
  const assignments = new Map<string, string[]>();
  const usedAttackers = new Set<string>();

  for (const blocker of [...blockers].sort(byStrengthDesc)) {
    const candidate = [...attackers]
      .filter((attacker) => !usedAttackers.has(attacker.id))
      .sort(byStrengthDesc)
      .find((attacker) => blocker.power >= attacker.toughness);
    if (!candidate) continue;
    assignments.set(candidate.id, [blocker.id]);
    usedAttackers.add(candidate.id);
  }

  return assignments;
}

function pickBestBlockPlan(plans: BlockPlan[]): BlockPlan {
  return plans.reduce((best, current) => (current.score > best.score ? current : best));
}

function resolveIncomingAttackers(
  state: SimGameState,
  defenderIndex: number,
  attackerIds: string[]
): CreaturePermanent[] {
  const controller = findAttackingPlayer(state, defenderIndex, attackerIds);
  if (controller === null) return [];
  return state.creatures[controller].filter((creature) => attackerIds.includes(creature.id));
}

function resolveBlockersForPlan(
  plan: BlockPlan,
  state: SimGameState,
  defenderIndex: number
): Map<string, CreaturePermanent[]> {
  const blockers = new Map(
    (state.creatures[defenderIndex] ?? []).map((creature) => [creature.id, creature] as const)
  );
  const assignments = new Map<string, CreaturePermanent[]>();
  for (const [attackerId, blockerIds] of plan.assignments.entries()) {
    const creatures = blockerIds
      .map((blockerId) => blockers.get(blockerId))
      .filter((creature): creature is CreaturePermanent => Boolean(creature));
    if (creatures.length) {
      assignments.set(attackerId, creatures);
    }
  }
  return assignments;
}

function simulateCombatOutcome(
  attackers: CreaturePermanent[],
  blockersByAttacker: Map<string, CreaturePermanent[]>,
  attackerValue: (creature: CreaturePermanent) => number = standaloneCreatureValue,
  blockerValue: (creature: CreaturePermanent) => number = standaloneCreatureValue
): CombatOutcome {
  let damageToPlayer = 0;
  let attackersKilled = 0;
  let blockersKilled = 0;
  let attackersKilledValue = 0;
  let blockersKilledValue = 0;

  for (const attacker of attackers) {
    const blockers = blockersByAttacker.get(attacker.id) ?? [];
    if (!blockers.length) {
      damageToPlayer += attacker.power;
      continue;
    }

    const totalBlockerPower = blockers.reduce((sum, blocker) => sum + blocker.power, 0);
    if (totalBlockerPower >= attacker.toughness) {
      attackersKilled += 1;
      attackersKilledValue += attackerValue(attacker);
    }

    let remainingDamage = attacker.power;
    for (const blocker of blockers) {
      if (remainingDamage <= 0) break;
      if (remainingDamage >= blocker.toughness) {
        blockersKilled += 1;
        blockersKilledValue += blockerValue(blocker);
      }
      remainingDamage -= blocker.toughness;
    }
  }

  return {
    damageToPlayer,
    attackersKilled,
    blockersKilled,
    attackersKilledValue,
    blockersKilledValue,
  };
}

export function permanentValue(
  state: SimGameState,
  playerIndex: number,
  permanentName: string
): number {
  const metadata = state.cardMetadata[playerIndex]?.[permanentName.toLowerCase()];
  const text = `${metadata?.oracleText ?? ""} ${metadata?.typeLine ?? ""}`.toLowerCase();
  let value = 1;
  if (metadata?.manaValue) value += metadata.manaValue * 0.25;
  if (/commander/.test(text) || state.commanders[playerIndex]?.toLowerCase() === permanentName.toLowerCase()) {
    value += 3;
  }
  if (/whenever|at the beginning|draw|token|treasure|add .*mana|copy|combo/.test(text)) value += 2;
  if (/artifact|enchantment|planeswalker/.test(text)) value += 0.6;
  return value;
}

export function creatureValue(
  state: SimGameState,
  playerIndex: number,
  creature: CreaturePermanent
): number {
  const metadata = state.cardMetadata[playerIndex]?.[creature.name.toLowerCase()];
  let value = standaloneCreatureValue(creature);
  const text = `${metadata?.oracleText ?? ""} ${metadata?.typeLine ?? ""}`.toLowerCase();
  if (state.commanders[playerIndex]?.toLowerCase() === creature.name.toLowerCase()) value += 3.5;
  if (metadata?.manaValue) value += metadata.manaValue * 0.3;
  if (/token/.test(text) || /^token/i.test(creature.id) || / token$/i.test(creature.name)) value *= 0.65;
  if (/flying|trample|haste|vigilance|lifelink|deathtouch|menace|ward|hexproof|indestructible/.test(text)) {
    value += 1.2;
  }
  if (/whenever|at the beginning|draw|token|treasure|add .*mana|sacrifice.*draw|copy/.test(text)) {
    value += 2.2;
  }
  return value;
}

function standaloneCreatureValue(creature: CreaturePermanent): number {
  const stats = creature.power * 0.45 + creature.toughness * 0.3;
  const highStats = creature.power + creature.toughness >= 8 ? 1 : 0;
  return Math.max(0.4, stats + highStats);
}

function hasEvasionKeyword(
  state: SimGameState,
  playerIndex: number,
  creature: CreaturePermanent
): boolean {
  const metadata = state.cardMetadata[playerIndex]?.[creature.name.toLowerCase()];
  const text = `${metadata?.oracleText ?? ""} ${metadata?.typeLine ?? ""}`.toLowerCase();
  return /flying|menace|can't be blocked|unblockable|shadow|fear|intimidate/.test(text);
}

function findAttackingPlayer(
  state: SimGameState,
  defenderIndex: number,
  attackerIds: string[]
): number | null {
  if (!attackerIds.length) return null;
  let bestMatch = { index: -1, count: 0 };
  for (let playerIndex = 0; playerIndex < state.creatures.length; playerIndex++) {
    if (playerIndex === defenderIndex) continue;
    const matches = state.creatures[playerIndex].filter((creature) =>
      attackerIds.includes(creature.id)
    ).length;
    if (matches > bestMatch.count) {
      bestMatch = { index: playerIndex, count: matches };
    }
  }
  return bestMatch.count > 0 ? bestMatch.index : null;
}

function serializeIds(ids: string[]): string {
  return [...ids].sort().join(",");
}

function serializeAssignments(assignments: Map<string, string[]>): string {
  return [...assignments.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([attackerId, blockerIds]) => `${attackerId}:${[...blockerIds].sort().join(",")}`)
    .join("|");
}

function cloneAssignments(assignments: Map<string, string[]>): Map<string, string[]> {
  return new Map(
    [...assignments.entries()].map(([attackerId, blockerIds]) => [
      attackerId,
      [...blockerIds],
    ])
  );
}

function withPlayerContext(state: SimGameState, playerIndex: number): SimGameState {
  return { ...state, playerIndex };
}

function byStrengthDesc(left: CreaturePermanent, right: CreaturePermanent): number {
  return right.power + right.toughness - (left.power + left.toughness);
}

function byStrengthAsc(left: CreaturePermanent, right: CreaturePermanent): number {
  return left.power + left.toughness - (right.power + right.toughness);
}
