import { describe, expect, it } from "vitest";
import { getAvailableInstants, canRespondWith } from "../../../game-state/src/cardUtils.js";
import type { DeckCardMetadata, SimGameState, StackEntry } from "@game-state/types";

function makeState(overrides: Partial<SimGameState> = {}): SimGameState {
  return {
    turn: 1,
    playerIndex: 0,
    lifeTotals: [40, 40, 40, 40],
    libraries: [[], [], [], []],
    hands: [["Counterspell", "Lightning Bolt"], [], [], []],
    battlefields: [["Forest", "Forest", "Forest"], [], [], []],
    graveyards: [[], [], [], []],
    commanders: ["Commander", "Commander", "Commander", "Commander"],
    creatures: [[], [], [], []],
    artifacts: [[], [], [], []],
    artifactMana: [0, 0, 0, 0],
    manaSpent: [0, 0, 0, 0],
    cardMetadata: [
      {
        counterspell: {
          name: "Counterspell",
          typeLine: "Instant",
          manaValue: 2,
          isLand: false,
          oracleText: "Counter target spell.",
        },
        "lightning bolt": {
          name: "Lightning Bolt",
          typeLine: "Instant",
          manaValue: 1,
          isLand: false,
        },
        fog: {
          name: "Fog",
          typeLine: "Instant",
          manaValue: 1,
          isLand: false,
          oracleText: "Prevent all combat damage that would be dealt this turn.",
        },
        forest: { name: "Forest", typeLine: "Basic Land - Forest", isLand: true },
      },
      {},
      {},
      {},
    ],
    triggers: [],
    triggerCounter: 1,
    phase: "Prima Fase Principale",
    phaseStep: "Prima Fase Principale",
    costReducers: { 0: [], 1: [], 2: [], 3: [] },
    handSizeModifiers: { 0: [], 1: [], 2: [], 3: [] },
    drawHistory: { 0: 0, 1: 0, 2: 0, 3: 0 },
    stack: [],
    ...overrides,
  };
}

function makeStackEntry(action: StackEntry["action"]): StackEntry {
  return {
    id: "stack_1",
    action,
    casterIndex: 1,
    resolved: false,
    responses: [],
  };
}

describe("getAvailableInstants", () => {
  it("returns instants affordable with current mana", () => {
    const state = makeState();
    const instants = getAvailableInstants(state, 0);
    expect(instants.length).toBe(2);
    expect(instants.some((a) => a.type === "CAST_SPELL" && a.card === "Counterspell")).toBe(true);
    expect(instants.some((a) => a.type === "CAST_SPELL" && a.card === "Lightning Bolt")).toBe(true);
  });

  it("returns empty if no instants in hand", () => {
    const state = makeState({
      hands: [["Giant Growth Sorcery", "Dark Ritual Sorcery"], [], [], []],
      cardMetadata: [
        {
          "giant growth sorcery": {
            name: "Giant Growth Sorcery",
            typeLine: "Sorcery",
            manaValue: 1,
            isLand: false,
          },
          "dark ritual sorcery": {
            name: "Dark Ritual Sorcery",
            typeLine: "Sorcery",
            manaValue: 1,
            isLand: false,
          },
        },
        {},
        {},
        {},
      ],
    });
    const instants = getAvailableInstants(state, 0);
    expect(instants.length).toBe(0);
  });

  it("returns empty if can't afford the instant", () => {
    const state = makeState({
      hands: [["Counterspell"], [], [], []],
      battlefields: [[], [], [], []],
    });
    const instants = getAvailableInstants(state, 0);
    expect(instants.length).toBe(0);
  });

  it("filters response options to legal counter targets", () => {
    const state = makeState({
      hands: [["Counterspell", "Fog"], [], [], []],
    });
    const instants = getAvailableInstants(
      state,
      0,
      makeStackEntry({ type: "DECLARE_ATTACKERS", player: 1, attackers: [] })
    );
    expect(instants.some((a) => a.type === "CAST_SPELL" && a.card === "Counterspell")).toBe(false);
    expect(instants.some((a) => a.type === "CAST_SPELL" && a.card === "Fog")).toBe(true);
  });
});

describe("canRespondWith", () => {
  it("counterspell can respond to cast spell", () => {
    const state = makeState({
      cardMetadata: [
        makeState().cardMetadata[0],
        { fireball: { name: "Fireball", typeLine: "Sorcery", manaValue: 1, isLand: false } },
        {},
        {},
      ],
    });
    const meta: DeckCardMetadata = {
      name: "Counterspell",
      typeLine: "Instant",
      manaValue: 2,
      oracleText: "Counter target spell.",
    };
    expect(
      canRespondWith(
        state,
        0,
        "Counterspell",
        makeStackEntry({ type: "CAST_SPELL", card: "Fireball" }),
        meta
      )
    ).toBe(true);
  });

  it("fog can respond to declare attackers", () => {
    const meta: DeckCardMetadata = {
      name: "Fog",
      typeLine: "Instant",
      manaValue: 1,
    };
    expect(
      canRespondWith(
        makeState(),
        0,
        "Fog",
        makeStackEntry({ type: "DECLARE_ATTACKERS", player: 1, attackers: [] }),
        meta
      )
    ).toBe(true);
  });

  it("sorcery cannot respond", () => {
    const meta: DeckCardMetadata = {
      name: "Cultivate",
      typeLine: "Sorcery",
      manaValue: 3,
    };
    expect(
      canRespondWith(
        makeState(),
        0,
        "Cultivate",
        makeStackEntry({ type: "CAST_SPELL", card: "Fireball" }),
        meta
      )
    ).toBe(false);
  });

  it("counterspell cannot respond to declare attackers", () => {
    const meta: DeckCardMetadata = {
      name: "Counterspell",
      typeLine: "Instant",
      manaValue: 2,
      oracleText: "Counter target spell.",
    };
    expect(
      canRespondWith(
        makeState(),
        0,
        "Counterspell",
        makeStackEntry({ type: "DECLARE_ATTACKERS", player: 1, attackers: [] }),
        meta
      )
    ).toBe(false);
  });
});
