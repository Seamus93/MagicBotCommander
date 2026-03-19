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
  damagePrevented: number;
  totalIncomingDamage: number;
  blockersLost: number;
  score: number;
}

interface CombatOutcome {
  damageToPlayer: number;
  attackersKilled: number;
  blockersKilled: number;
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
        creature.power >= Math.max(1, maxBlockerToughness - 1)
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
  const lethalBonus = plan.expectedDamage >= defenderLife && defenderLife > 0 ? 100 : 0;
  const noBlockerPenalty =
    plan.attackers.length > 0 && plan.attackers.length === readyCount ? 2 : 0;
  return plan.expectedDamage - plan.expectedLosses * 2 + lethalBonus - noBlockerPenalty;
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

  const noBlockThreshold = Math.max(5, Math.floor((state.lifeTotals[playerIndex] ?? 0) / 4));
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
  const lethalPreventionBonus =
    incomingDamage >= life && plan.damagePrevented >= life ? 5 : 0;
  return plan.creaturesKilled * 3 + plan.damagePrevented - plan.blockersLost * 2 + lethalPreventionBonus;
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

    const leftLife = state.lifeTotals[left] ?? 0;
    const rightLife = state.lifeTotals[right] ?? 0;
    if (leftLife !== rightLife) {
      return rightLife - leftLife;
    }

    return left - right;
  })[0];
}

export function threatAssessment(state: SimGameState, opponentIndex: number): number {
  const creatures = state.creatures[opponentIndex] ?? [];
  const boardPower = creatures.reduce((sum, creature) => sum + creature.power, 0);
  const creatureCount = creatures.length;
  const cardsInHand = state.hands[opponentIndex]?.length ?? 0;
  const lifeTotal = state.lifeTotals[opponentIndex] ?? 0;
  return boardPower * 2 + creatureCount * 2 + cardsInHand + Math.floor(lifeTotal / 10);
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
    const leftLife = state.lifeTotals[left] ?? 0;
    const rightLife = state.lifeTotals[right] ?? 0;
    if (leftLife !== rightLife) {
      return rightLife - leftLife;
    }

    const leftThreat = threatAssessment(state, left);
    const rightThreat = threatAssessment(state, right);
    if (leftThreat !== rightThreat) {
      return rightThreat - leftThreat;
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
    resolveBlockersForPlan(bestDefense, state, targetIndex)
  );

  const plan: AttackPlan = {
    attackers: attackers.map((creature) => creature.id),
    targetPlayer: targetIndex,
    expectedDamage: outcome.damageToPlayer,
    expectedLosses: outcome.attackersKilled,
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
    damagePrevented: totalIncoming - outcome.damageToPlayer,
    totalIncomingDamage: totalIncoming,
    blockersLost: outcome.blockersKilled,
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
  blockersByAttacker: Map<string, CreaturePermanent[]>
): CombatOutcome {
  let damageToPlayer = 0;
  let attackersKilled = 0;
  let blockersKilled = 0;

  for (const attacker of attackers) {
    const blockers = blockersByAttacker.get(attacker.id) ?? [];
    if (!blockers.length) {
      damageToPlayer += attacker.power;
      continue;
    }

    const totalBlockerPower = blockers.reduce((sum, blocker) => sum + blocker.power, 0);
    if (totalBlockerPower >= attacker.toughness) {
      attackersKilled += 1;
    }

    let remainingDamage = attacker.power;
    for (const blocker of blockers) {
      if (remainingDamage <= 0) break;
      if (remainingDamage >= blocker.toughness) {
        blockersKilled += 1;
      }
      remainingDamage -= blocker.toughness;
    }
  }

  return {
    damageToPlayer,
    attackersKilled,
    blockersKilled,
  };
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
