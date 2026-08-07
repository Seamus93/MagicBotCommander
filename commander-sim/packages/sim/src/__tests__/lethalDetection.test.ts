import { describe, expect, it } from "vitest";
import type { DeckCardMetadata, SimAction, SimGameState } from "@game-state/types";
import type { AttackPlan } from "../combatEvaluator.js";
import {
  findImmediateLethalActions,
  findImmediateLethalAttackPlans,
  LearningAgent,
} from "../learningAgent.js";
import { PatternStore } from "../patterns.js";
import { createInitialState } from "../engine.js";

const land = (name: string): DeckCardMetadata => ({
  name,
  typeLine: `Basic Land - ${name}`,
  isLand: true,
  isPermanent: true,
  producesMana: true,
  manaProduction: 1,
});

function makeState(metadata: DeckCardMetadata[] = []): SimGameState {
  const state = createInitialState(
    4,
    [["Forest"], ["Island"], ["Island"], ["Island"]],
    [[land("Forest"), ...metadata], [land("Island")], [land("Island")], [land("Island")]],
    ["Commander", "Commander", "Commander", "Commander"],
    0
  );
  state.playerIndex = 0;
  state.phase = "Prima Fase Principale";
  state.phaseStep = "Prima Fase Principale";
  for (const card of metadata) {
    state.cardMetadata[0][card.name.toLowerCase()] = card;
  }
  return state;
}

const bolt: DeckCardMetadata = {
  name: "Test Bolt",
  typeLine: "Instant",
  oracleText: "Test Bolt deals 3 damage to target opponent.",
  manaValue: 1,
  isInstant: true,
};

const sparkMage: DeckCardMetadata = {
  name: "Spark Mage",
  typeLine: "Creature - Wizard",
  oracleText: "{T}: Spark Mage deals 3 damage to target opponent.",
  manaValue: 2,
  isCreature: true,
  isPermanent: true,
};

const flare: DeckCardMetadata = {
  name: "Test Flare",
  typeLine: "Sorcery",
  oracleText: "Test Flare deals 3 damage to each opponent.",
  manaValue: 3,
  isSorcery: true,
};

describe("immediate lethal detection", () => {
  it("chooses combat lethal before normal attack-plan scoring", () => {
    const state = makeState();
    state.lifeTotals = [40, 5, 0, 0];
    state.creatures[0] = [
      { id: "creature_a", name: "Attacker", power: 5, toughness: 5, tapped: false, summoningSickness: false },
    ];
    const lethal: AttackPlan = { attackers: ["creature_a"], targetPlayer: 1, expectedDamage: 5, expectedLosses: 0, score: -1 };
    const pass: AttackPlan = { attackers: [], targetPlayer: 1, expectedDamage: 0, expectedLosses: 0, score: 20 };
    const agent = new LearningAgent({ id: "test", store: new PatternStore(), epsilon: 0 });

    expect(agent.decideAttackPlan(state, [pass, lethal])).toBe(lethal);
  });

  it("does not mark non-lethal attacks as lethal", () => {
    const state = makeState();
    state.lifeTotals = [40, 6, 0, 0];
    const plan: AttackPlan = { attackers: ["creature_a"], targetPlayer: 1, expectedDamage: 5, expectedLosses: 0, score: 10 };

    expect(findImmediateLethalAttackPlans(state, 0, [plan])).toEqual([]);
  });

  it("detects burn lethal on the correct target", () => {
    const state = makeState([bolt]);
    state.lifeTotals = [40, 3, 8, 8];
    const action: SimAction = {
      type: "CAST_SPELL",
      card: "Test Bolt",
      targetPlayer: 1,
      targets: [{ type: "player", id: 1 }],
    };

    const lethal = findImmediateLethalActions(state, 0, [action]);

    expect(lethal).toHaveLength(1);
    expect(lethal[0].targetPlayer).toBe(1);
    expect(lethal[0].kind).toBe("spell");
  });

  it("does not choose insufficient burn as lethal", () => {
    const state = makeState([bolt]);
    state.lifeTotals = [40, 4, 8, 8];
    const action: SimAction = {
      type: "CAST_SPELL",
      card: "Test Bolt",
      targetPlayer: 1,
      targets: [{ type: "player", id: 1 }],
    };

    expect(findImmediateLethalActions(state, 0, [action])).toEqual([]);
  });

  it("detects activated ability lethal", () => {
    const state = makeState([sparkMage]);
    state.lifeTotals = [40, 3, 8, 8];
    state.permanents![0].push({
      id: "perm_spark_1",
      cardName: "Spark Mage",
      owner: 0,
      controller: 0,
      tapped: false,
    });
    const action: SimAction = {
      type: "ACTIVATE_ABILITY",
      sourcePermanentId: "perm_spark_1",
      abilityId: "perm_spark_1:TAP_ACTIVATED_EFFECT:0",
      targets: [{ type: "player", id: 1 }],
    };

    const lethal = findImmediateLethalActions(state, 0, [action]);

    expect(lethal).toHaveLength(1);
    expect(lethal[0].kind).toBe("ability");
  });

  it("prefers game-winning lethal over another elimination", () => {
    const state = makeState([bolt, flare]);
    state.lifeTotals = [40, 3, 3, 0];
    const eliminate: SimAction = {
      type: "CAST_SPELL",
      card: "Test Bolt",
      targetPlayer: 1,
      targets: [{ type: "player", id: 1 }],
    };
    const win: SimAction = {
      type: "CAST_SPELL",
      card: "Test Flare",
    };

    const ordered = findImmediateLethalActions(state, 0, [eliminate, win]);

    expect(ordered[0].action).toBe(win);
    expect(ordered[0].gameWinning).toBe(true);
  });

  it("ignores illegal player targets", () => {
    const state = makeState([bolt]);
    state.lifeTotals = [40, 3, 8, 8];
    const action: SimAction = {
      type: "CAST_SPELL",
      card: "Test Bolt",
      targetPlayer: 9,
      targets: [{ type: "player", id: 9 }],
    };

    expect(findImmediateLethalActions(state, 0, [action])).toEqual([]);
  });
});
