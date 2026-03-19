import { describe, expect, it } from "vitest";
import type {
  AttackPlan,
  BlockAssignment,
  BlockPlan,
  DeckCardMetadata,
  SimAction,
  SimAgent,
  SimGameState,
} from "@game-state/types";
import type { CreaturePermanent } from "@rules/combat/types";
import {
  canAlphaStrike,
  generateAttackPlans,
  generateBlockPlans,
  isLethalOnBoard,
  selectTarget,
} from "../combatEvaluator.js";
import { simulateGame } from "../engine.js";

function makeCreature(
  id: string,
  power: number,
  toughness: number,
  overrides: Partial<CreaturePermanent> = {}
): CreaturePermanent {
  return {
    id,
    name: id,
    power,
    toughness,
    tapped: false,
    summoningSickness: false,
    ...overrides,
  };
}

function makeState(
  overrides: Partial<SimGameState> = {},
  players = 4
): SimGameState {
  const costReducers = Object.fromEntries(
    Array.from({ length: players }, (_, index) => [index, []])
  );
  const handSizeModifiers = Object.fromEntries(
    Array.from({ length: players }, (_, index) => [index, []])
  );
  const drawHistory = Object.fromEntries(
    Array.from({ length: players }, (_, index) => [index, 0])
  );

  return {
    turn: 1,
    playerIndex: 0,
    lifeTotals: Array(players).fill(40),
    libraries: Array.from({ length: players }, () => []),
    hands: Array.from({ length: players }, () => []),
    battlefields: Array.from({ length: players }, () => []),
    graveyards: Array.from({ length: players }, () => []),
    commanders: Array(players).fill("Commander"),
    creatures: Array.from({ length: players }, () => []),
    artifacts: Array.from({ length: players }, () => []),
    artifactMana: Array(players).fill(0),
    manaSpent: Array(players).fill(0),
    cardMetadata: Array.from({ length: players }, () => ({})),
    triggers: [],
    triggerCounter: 1,
    phase: "Fase di Combattimento",
    phaseStep: "Sottofase di Dichiarazione delle Creature Attaccanti",
    costReducers,
    handSizeModifiers,
    drawHistory,
    stack: [],
    ...overrides,
  };
}

describe("generateAttackPlans", () => {
  it("genera un piano che non attacca con il 2/2 contro un blocker 4/4", () => {
    const state = makeState({
      playerIndex: 0,
      creatures: [
        [makeCreature("a-3-3", 3, 3), makeCreature("a-2-2", 2, 2)],
        [makeCreature("b-4-4", 4, 4)],
        [],
        [],
      ],
    });

    const plans = generateAttackPlans(state, 0, 1);

    expect(
      plans.some(
        (plan) =>
          plan.attackers.includes("a-3-3") &&
          !plan.attackers.includes("a-2-2")
      )
    ).toBe(true);
  });

  it("rileva alpha-strike quando il board ha 10 power contro 8 vite senza blocker", () => {
    const state = makeState({
      playerIndex: 0,
      lifeTotals: [40, 8, 40, 40],
      creatures: [
        [makeCreature("a-5-5", 5, 5), makeCreature("a-5-5-b", 5, 5)],
        [],
        [],
        [],
      ],
    });

    expect(canAlphaStrike(state, 0, 1)).toBe(true);
    expect(isLethalOnBoard(state, 0, 1)).toBe(true);
  });

  it("con board vuoto genera solo il piano hold", () => {
    const state = makeState({
      playerIndex: 0,
      creatures: [[], [], [], []],
    });

    const plans = generateAttackPlans(state, 0, 1);

    expect(plans).toHaveLength(1);
    expect(plans[0].attackers).toEqual([]);
  });
});

describe("generateBlockPlans", () => {
  it("3/3 contro 2/2 genera un blocco profittevole che uccide l'attaccante", () => {
    const state = makeState({
      playerIndex: 1,
      creatures: [
        [makeCreature("atk-2-2", 2, 2)],
        [makeCreature("blk-3-3", 3, 3)],
        [],
        [],
      ],
    });

    const plans = generateBlockPlans(state, 1, ["atk-2-2"]);

    expect(
      plans.some(
        (plan) =>
          plan.creaturesKilled === 1 &&
          plan.damagePrevented === 2 &&
          plan.blockersLost === 0
      )
    ).toBe(true);
  });

  it("1/1 contro 5/5 genera un chump block che previene 5 danni", () => {
    const state = makeState({
      playerIndex: 1,
      creatures: [
        [makeCreature("atk-5-5", 5, 5)],
        [makeCreature("blk-1-1", 1, 1)],
        [],
        [],
      ],
    });

    const plans = generateBlockPlans(state, 1, ["atk-5-5"]);

    expect(
      plans.some(
        (plan) =>
          plan.damagePrevented === 5 &&
          plan.blockersLost === 1 &&
          plan.creaturesKilled === 0
      )
    ).toBe(true);
  });

  it("due 2/3 contro 4/4 generano un double block che uccide il 4/4", () => {
    const state = makeState({
      playerIndex: 1,
      creatures: [
        [makeCreature("atk-4-4", 4, 4)],
        [makeCreature("blk-2-3-a", 2, 3), makeCreature("blk-2-3-b", 2, 3)],
        [],
        [],
      ],
    });

    const plans = generateBlockPlans(state, 1, ["atk-4-4"]);

    expect(
      plans.some(
        (plan) =>
          plan.creaturesKilled === 1 &&
          plan.blockersLost === 1 &&
          [...plan.assignments.values()].some((blockers) => blockers.length === 2)
      )
    ).toBe(true);
  });
});

describe("target and lethal evaluation", () => {
  it("prioritizza l'avversario con 3 vite quando abbiamo 5 power pronti", () => {
    const state = makeState({
      playerIndex: 0,
      lifeTotals: [40, 3, 20, 20],
      creatures: [
        [makeCreature("a-3-3", 3, 3), makeCreature("a-2-2", 2, 2)],
        [makeCreature("b-2-2", 2, 2)],
        [makeCreature("c-4-4", 4, 4), makeCreature("c-4-4-b", 4, 4)],
        [],
      ],
    });

    expect(selectTarget(state, 0, [1, 2, 3])).toBe(1);
  });

  it("a vite uguali attacca il leader politico con board piu forte", () => {
    const state = makeState({
      playerIndex: 0,
      lifeTotals: [40, 40, 40, 40],
      creatures: [
        [makeCreature("a-3-3", 3, 3)],
        [makeCreature("b-1-1", 1, 1)],
        [makeCreature("c-4-4", 4, 4), makeCreature("c-4-4-b", 4, 4)],
        [],
      ],
      hands: [[], ["x"], ["x", "y", "z"], []],
    });

    expect(selectTarget(state, 0, [1, 2, 3])).toBe(2);
  });

  it("isLethalOnBoard considera i blocchi ottimali dell'avversario", () => {
    const state = makeState({
      playerIndex: 0,
      lifeTotals: [40, 8, 40, 40],
      creatures: [
        [
          makeCreature("a-3-3", 3, 3),
          makeCreature("a-3-3-b", 3, 3),
          makeCreature("a-3-3-c", 3, 3),
          makeCreature("a-3-3-d", 3, 3),
        ],
        [makeCreature("b-2-2", 2, 2)],
        [],
        [],
      ],
    });

    expect(canAlphaStrike(state, 0, 1)).toBe(false);
    expect(isLethalOnBoard(state, 0, 1)).toBe(true);
  });
});

class CurveAgent implements SimAgent {
  constructor(public readonly id: string) {}

  decideAction(state: SimGameState, availableActions: SimAction[]) {
    const land = availableActions.find((action) => action.type === "PLAY_LAND");
    if (land) {
      return { action: land, metadata: { source: "fallback" as const } };
    }

    const spells = availableActions.filter(
      (action): action is Extract<SimAction, { type: "CAST_SPELL" }> =>
        action.type === "CAST_SPELL"
    );
    if (spells.length) {
      const bestSpell = [...spells].sort(
        (left, right) => getManaValue(state, right.card) - getManaValue(state, left.card)
      )[0];
      return { action: bestSpell, metadata: { source: "fallback" as const } };
    }

    return {
      action: availableActions.find((action) => action.type === "PASS_TURN") ?? { type: "PASS_TURN" },
      metadata: { source: "fallback" as const },
    };
  }
}

class BaselineCombatAgent extends CurveAgent {
  decideAttackers(
    _state: SimGameState,
    availableAttackersPool: CreaturePermanent[]
  ) {
    return {
      attackers: availableAttackersPool.map((creature) => creature.id),
      metadata: { source: "fallback" as const },
    };
  }

  decideBlockers(
    _state: SimGameState,
    attackers: CreaturePermanent[],
    availableBlockersPool: CreaturePermanent[]
  ) {
    const orderedAttackers = [...attackers].sort((left, right) => right.power - left.power);
    const assignments = availableBlockersPool
      .map((blocker, index) => {
        const attacker = orderedAttackers[index % orderedAttackers.length];
        if (!attacker) return null;
        return {
          blockerId: blocker.id,
          attackerId: attacker.id,
        };
      })
      .filter((assignment): assignment is { blockerId: string; attackerId: string } => Boolean(assignment));
    return {
      assignments,
      metadata: { source: "fallback" as const },
    };
  }
}

class StrategicCombatAgent extends CurveAgent {
  decideTarget(state: SimGameState, opponentIndices: number[]) {
    return selectTarget(state, state.playerIndex, opponentIndices);
  }

  decideAttackPlan(_state: SimGameState, plans: AttackPlan[]) {
    return [...plans].sort((left, right) => right.score - left.score)[0];
  }

  decideBlockPlan(_state: SimGameState, plans: BlockPlan[]) {
    return [...plans].sort((left, right) => right.score - left.score)[0];
  }
}

const CREATURE_METADATA: DeckCardMetadata[] = [
  {
    name: "Basic Land",
    typeLine: "Basic Land",
    isLand: true,
    isPermanent: true,
    manaValue: 0,
  },
  {
    name: "Recruit",
    typeLine: "Creature",
    isCreature: true,
    isPermanent: true,
    manaValue: 1,
    power: 1,
    toughness: 1,
  },
  {
    name: "Bruiser",
    typeLine: "Creature",
    isCreature: true,
    isPermanent: true,
    manaValue: 2,
    power: 3,
    toughness: 2,
  },
  {
    name: "Siege Ogre",
    typeLine: "Creature",
    isCreature: true,
    isPermanent: true,
    manaValue: 4,
    power: 5,
    toughness: 5,
  },
];

const COMBAT_DECK = [
  ...Array(16).fill("Basic Land"),
  ...Array(10).fill("Recruit"),
  ...Array(10).fill("Bruiser"),
  ...Array(8).fill("Siege Ogre"),
];

describe("combat integration", () => {
  it("migliora danno medio, blocchi sfavorevoli e game length su 100 episodi", async () => {
    const baseline = await aggregateMetrics(BaselineCombatAgent, 100);
    const strategic = await aggregateMetrics(StrategicCombatAgent, 100);

    expect(strategic.damagePerCombatTurn).toBeGreaterThan(
      baseline.damagePerCombatTurn * 1.2
    );
    expect(strategic.badBlockLosses).toBeLessThan(baseline.badBlockLosses);
    expect(strategic.averageTurns).toBeLessThan(baseline.averageTurns);
  });
});

async function aggregateMetrics(
  AgentCtor: new (id: string) => SimAgent,
  episodes: number
) {
  let totalDamage = 0;
  let totalCombatTurns = 0;
  let totalBadBlockLosses = 0;
  let totalTurns = 0;

  for (let episode = 0; episode < episodes; episode++) {
    const seed = 1000 + episode;
    const metrics = await withSeededRandom(seed, async () => {
      const logs: string[] = [];
      const result = await simulateGame(
        [
          new AgentCtor("p0"),
          new AgentCtor("p1"),
          new AgentCtor("p2"),
          new AgentCtor("p3"),
        ],
        {
          maxTurns: 20,
          log: (message) => logs.push(message),
          playerDecks: [COMBAT_DECK, COMBAT_DECK, COMBAT_DECK, COMBAT_DECK],
          playerDeckMetadata: [
            CREATURE_METADATA,
            CREATURE_METADATA,
            CREATURE_METADATA,
            CREATURE_METADATA,
          ],
        }
      );

      return {
        damage: collectCombatDamage(logs),
        combatTurns: result.history.filter(
          (entry) =>
            entry.action.type === "DECLARE_ATTACKERS" &&
            entry.action.attackers.length > 0
        ).length,
        badBlockLosses: collectBadBlockLosses(result.history),
        turns: result.turns,
      };
    });

    totalDamage += metrics.damage;
    totalCombatTurns += metrics.combatTurns;
    totalBadBlockLosses += metrics.badBlockLosses;
    totalTurns += metrics.turns;
  }

  return {
    damagePerCombatTurn: totalDamage / Math.max(1, totalCombatTurns),
    badBlockLosses: totalBadBlockLosses / episodes,
    averageTurns: totalTurns / episodes,
  };
}

function collectCombatDamage(logs: string[]) {
  return logs.reduce((sum, line) => {
    const match = line.match(/deals (\d+) combat damage to Player/i);
    return sum + (match ? Number(match[1]) : 0);
  }, 0);
}

function collectBadBlockLosses(
  history: Array<{ action: SimAction; state: SimGameState }>
) {
  let badBlockLosses = 0;
  for (let index = 1; index < history.length; index++) {
    const current = history[index];
    const previous = history[index - 1];
    if (current.action.type !== "DECLARE_BLOCKERS") continue;
    if (previous.action.type !== "DECLARE_ATTACKERS") continue;

    const outcome = evaluateBlockOutcome(
      current.state,
      previous.action.player,
      current.action.player,
      previous.action.attackers,
      current.action.assignments
    );
    if (outcome.blockersLost > outcome.creaturesKilled) {
      badBlockLosses += outcome.blockersLost;
    }
  }
  return badBlockLosses;
}

function evaluateBlockOutcome(
  state: SimGameState,
  attackerIndex: number,
  defenderIndex: number,
  attackerIds: string[],
  assignments: BlockAssignment[]
) {
  const attackers = (state.creatures[attackerIndex] ?? []).filter((creature) =>
    attackerIds.includes(creature.id)
  );
  const blockerLookup = new Map(
    (state.creatures[defenderIndex] ?? []).map((creature) => [creature.id, creature] as const)
  );
  const blockersByAttacker = new Map<string, CreaturePermanent[]>();

  for (const assignment of assignments) {
    if (!assignment.attackerId) continue;
    const blocker = blockerLookup.get(assignment.blockerId);
    if (!blocker) continue;
    const list = blockersByAttacker.get(assignment.attackerId) ?? [];
    list.push(blocker);
    blockersByAttacker.set(assignment.attackerId, list);
  }

  let creaturesKilled = 0;
  let blockersLost = 0;

  for (const attacker of attackers) {
    const blockers = blockersByAttacker.get(attacker.id) ?? [];
    if (!blockers.length) continue;

    const totalBlockerPower = blockers.reduce((sum, blocker) => sum + blocker.power, 0);
    if (totalBlockerPower >= attacker.toughness) {
      creaturesKilled += 1;
    }

    let remainingDamage = attacker.power;
    for (const blocker of blockers) {
      if (remainingDamage <= 0) break;
      if (remainingDamage >= blocker.toughness) {
        blockersLost += 1;
      }
      remainingDamage -= blocker.toughness;
    }
  }

  return { creaturesKilled, blockersLost };
}

function getManaValue(state: SimGameState, card: string) {
  return state.cardMetadata[state.playerIndex]?.[card.toLowerCase()]?.manaValue ?? 0;
}

function createSeededRandom(seed: number) {
  let current = seed >>> 0;
  return () => {
    current = (current * 1664525 + 1013904223) >>> 0;
    return current / 0x100000000;
  };
}

async function withSeededRandom<T>(seed: number, fn: () => Promise<T>) {
  const original = Math.random;
  Math.random = createSeededRandom(seed);
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}
