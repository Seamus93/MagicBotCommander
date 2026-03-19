import { describe, it, expect } from "vitest";
import {
  encodeAction,
  decodeAction,
  encodeActionFromState,
  ACTION_COUNT,
} from "../actionEncoder.js";
import type { SimAction, SimGameState } from "@game-state/types.js";

function makeState(cardTypeLine: string): SimGameState {
  const players = 4;
  const empty = () =>
    Array(players)
      .fill(null)
      .map(() => []);
  return {
    turn: 1,
    playerIndex: 0,
    lifeTotals: Array(players).fill(40),
    libraries: empty(),
    hands: [["Lightning Bolt"], [], [], []],
    battlefields: empty(),
    graveyards: empty(),
    commanders: Array(players).fill("Commander"),
    creatures: Array(players).fill([]),
    artifacts: empty(),
    artifactMana: Array(players).fill(0),
    manaSpent: Array(players).fill(0),
    cardMetadata: [
      { "Lightning Bolt": { name: "Lightning Bolt", typeLine: cardTypeLine } },
      {},
      {},
      {},
    ],
    triggers: [],
    triggerCounter: 1,
    phase: "Prima Fase Principale",
    phaseStep: "Prima Fase Principale",
    costReducers: Object.fromEntries(
      Array.from({ length: players }, (_, i) => [i, []])
    ) as SimGameState["costReducers"],
    handSizeModifiers: Object.fromEntries(
      Array.from({ length: players }, (_, i) => [i, []])
    ) as SimGameState["handSizeModifiers"],
    drawHistory: Object.fromEntries(
      Array.from({ length: players }, (_, i) => [i, 0])
    ),
    stack: [],
  };
}

describe("encodeAction", () => {
  it("PASS_TURN → 0", () => {
    const action: SimAction = { type: "PASS_TURN" };
    expect(encodeAction(action)).toBe(0);
  });

  it("PLAY_LAND → 1", () => {
    const action: SimAction = { type: "PLAY_LAND", card: "Forest" };
    expect(encodeAction(action)).toBe(1);
  });

  it("CAST_SPELL:creature → 2", () => {
    const action: SimAction = { type: "CAST_SPELL", card: "Grizzly Bears" };
    expect(encodeAction(action, { cardType: "Creature — Bear" })).toBe(2);
  });

  it("CAST_SPELL:instant → 3", () => {
    const action: SimAction = { type: "CAST_SPELL", card: "Lightning Bolt" };
    expect(encodeAction(action, { cardType: "Instant" })).toBe(3);
  });

  it("CAST_SPELL:sorcery → 4", () => {
    const action: SimAction = { type: "CAST_SPELL", card: "Divination" };
    expect(encodeAction(action, { cardType: "Sorcery" })).toBe(4);
  });

  it("CAST_SPELL:artifact → 5", () => {
    const action: SimAction = { type: "CAST_SPELL", card: "Sol Ring" };
    expect(encodeAction(action, { cardType: "Artifact" })).toBe(5);
  });

  it("CAST_SPELL:enchantment → 6", () => {
    const action: SimAction = { type: "CAST_SPELL", card: "Ghostly Prison" };
    expect(encodeAction(action, { cardType: "Enchantment" })).toBe(6);
  });

  it("CAST_SPELL:other (no type) → 7", () => {
    const action: SimAction = { type: "CAST_SPELL", card: "Mystery Card" };
    expect(encodeAction(action)).toBe(7);
  });

  it("ATTACK_CHOICE mode=ATTACK → 8", () => {
    const action: SimAction = {
      type: "ATTACK_CHOICE",
      card: "c1",
      mode: "ATTACK",
    };
    expect(encodeAction(action)).toBe(8);
  });

  it("BLOCK_CHOICE with targetId → 9", () => {
    const action: SimAction = {
      type: "BLOCK_CHOICE",
      card: "c2",
      targetId: "c1",
    };
    expect(encodeAction(action)).toBe(9);
  });

  it("ATTACK_CHOICE mode=HOLD → 10", () => {
    const action: SimAction = {
      type: "ATTACK_CHOICE",
      card: "c1",
      mode: "HOLD",
    };
    expect(encodeAction(action)).toBe(10);
  });

  it("BLOCK_CHOICE targetId=null → 10", () => {
    const action: SimAction = {
      type: "BLOCK_CHOICE",
      card: "c2",
      targetId: null,
    };
    expect(encodeAction(action)).toBe(10);
  });

  it("DECLARE_ATTACKERS fallback → 0", () => {
    const action: SimAction = {
      type: "DECLARE_ATTACKERS",
      player: 0,
      attackers: [],
    };
    expect(encodeAction(action)).toBe(0);
  });

  it("DECLARE_BLOCKERS fallback → 0", () => {
    const action: SimAction = {
      type: "DECLARE_BLOCKERS",
      player: 0,
      assignments: [],
    };
    expect(encodeAction(action)).toBe(0);
  });
});

describe("decodeAction", () => {
  it("decodes all valid indices", () => {
    for (let i = 0; i < ACTION_COUNT; i++) {
      expect(typeof decodeAction(i)).toBe("string");
      expect(decodeAction(i).length).toBeGreaterThan(0);
    }
  });

  it("decodes index 0 as PASS_TURN", () => {
    expect(decodeAction(0)).toBe("PASS_TURN");
  });

  it("decodes index 8 as ATTACK", () => {
    expect(decodeAction(8)).toBe("ATTACK");
  });

  it("unknown index returns PASS_TURN", () => {
    expect(decodeAction(99)).toBe("PASS_TURN");
  });
});

describe("encodeActionFromState", () => {
  it("looks up card type from state for CAST_SPELL instant", () => {
    const state = makeState("Instant");
    const action: SimAction = { type: "CAST_SPELL", card: "Lightning Bolt" };
    expect(encodeActionFromState(action, state, 0)).toBe(3);
  });

  it("looks up card type from state for CAST_SPELL creature", () => {
    const state = makeState("Creature — Goblin");
    const action: SimAction = { type: "CAST_SPELL", card: "Lightning Bolt" };
    expect(encodeActionFromState(action, state, 0)).toBe(2);
  });

  it("defaults to other for unknown typeLine", () => {
    const state = makeState("");
    const action: SimAction = { type: "CAST_SPELL", card: "Lightning Bolt" };
    expect(encodeActionFromState(action, state, 0)).toBe(7);
  });

  it("non-CAST_SPELL actions use plain encode", () => {
    const state = makeState("Instant");
    const action: SimAction = { type: "PASS_TURN" };
    expect(encodeActionFromState(action, state, 0)).toBe(0);
  });
});

describe("ACTION_COUNT", () => {
  it("equals 11", () => {
    expect(ACTION_COUNT).toBe(11);
  });
});
