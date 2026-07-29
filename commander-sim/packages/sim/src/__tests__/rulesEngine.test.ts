import { describe, expect, it } from "vitest";
import type {
  AgentDecision,
  DeckCardMetadata,
  SimAction,
  SimAgent,
  SimGameState,
  StackEntry,
} from "@game-state/types";
import { getAvailableMana } from "../../../game-state/src/cardUtils.js";
import {
  applyAction,
  createInitialState,
  generateActions,
  resolveStackWithPriority,
} from "../engine.js";

const land = (name: string): DeckCardMetadata => ({
  name,
  typeLine: `Basic Land - ${name}`,
  isLand: true,
  isPermanent: true,
  manaProduction: 1,
  producesMana: true,
});

const meta = (entry: DeckCardMetadata) => entry;

function metadataMap(cards: DeckCardMetadata[]) {
  return Object.fromEntries(cards.map((card) => [card.name.toLowerCase(), card]));
}

function makeState(cards: DeckCardMetadata[], hand: string[] = []): SimGameState {
  const state = createInitialState(
    4,
    [["Forest"], ["Island"], ["Island"], ["Island"]],
    [[land("Forest"), ...cards], [land("Island")], [land("Island")], [land("Island")]],
    ["Commander", "Commander", "Commander", "Commander"],
    0
  );
  state.hands[0] = hand;
  state.libraries[0] = ["Spare", "Spare", "Spare"];
  state.battlefields[0] = ["Forest", "Forest", "Forest", "Forest", "Forest"];
  state.permanents![0] = state.battlefields[0].map((cardName) => ({
    id: `perm_${cardName}_${Math.random()}`,
    cardName,
    owner: 0,
    controller: 0,
    face: cardName,
    tapped: false,
    counters: {},
    damageMarked: 0,
  }));
  state.cardMetadata[0] = { ...state.cardMetadata[0], ...metadataMap(cards) };
  return state;
}

class PassAgent implements SimAgent {
  constructor(public id: string) {}
  decideAction(): AgentDecision {
    return { action: { type: "PASS_TURN" } };
  }
  decideResponse(_state: SimGameState, _entry: StackEntry, _actions: SimAction[]): SimAction | null {
    return null;
  }
}

class CounterAgent extends PassAgent {
  decideResponse(_state: SimGameState, _entry: StackEntry, actions: SimAction[]): SimAction | null {
    return actions.find((action) => action.type === "CAST_SPELL" && action.card === "Counterspell") ?? null;
  }
}

describe("rules engine legal actions and stack", () => {
  it("does not expose sorcery actions during upkeep", () => {
    const state = makeState([
      meta({ name: "Divination", typeLine: "Sorcery", manaValue: 3, oracleText: "Draw two cards." }),
    ], ["Divination"]);
    state.phase = "Fase Iniziale";
    state.phaseStep = "Sottofase di Mantenimento";

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: false,
      allowLand: false,
    });

    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Divination")).toBe(false);
  });

  it("does not expose sorcery actions on an opponent turn", () => {
    const state = makeState([
      meta({ name: "Divination", typeLine: "Sorcery", manaValue: 3, oracleText: "Draw two cards." }),
    ], ["Divination"]);
    state.playerIndex = 1;
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });

    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Divination")).toBe(false);
  });

  it("exposes instants and flash creatures when the player has priority", () => {
    const state = makeState([
      meta({ name: "Opt", typeLine: "Instant", manaValue: 1, oracleText: "Draw a card." }),
      meta({
        name: "Flash Bear",
        typeLine: "Creature - Bear",
        manaValue: 2,
        power: 2,
        toughness: 2,
        isCreature: true,
        isPermanent: true,
        oracleText: "Flash",
      }),
    ], ["Opt", "Flash Bear"]);
    state.phase = "Fase Iniziale";
    state.phaseStep = "Sottofase di Mantenimento";

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: false,
      allowLand: false,
    });

    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Opt")).toBe(true);
    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Flash Bear")).toBe(true);
  });

  it("puts a supported ETB trigger on the stack and resolves it", async () => {
    const state = makeState([
      meta({
        name: "Elvish Visionary",
        typeLine: "Creature - Elf",
        manaValue: 2,
        power: 1,
        toughness: 1,
        isCreature: true,
        isPermanent: true,
        oracleText: "When Elvish Visionary enters, draw a card.",
      }),
    ]);
    state.stack.push({
      id: "spell_visionary",
      action: { type: "CAST_SPELL", card: "Elvish Visionary" },
      casterIndex: 0,
      resolved: false,
      responses: [],
    });
    const before = state.hands[0].length;

    await resolveStackWithPriority(state, 0, [0, 1, 2, 3].map((i) => new PassAgent(`p${i}`)), () => {});

    expect(state.creatures[0].some((creature) => creature.name === "Elvish Visionary")).toBe(true);
    expect(state.hands[0].length).toBe(before + 1);
    expect(state.rulesEvents?.some((event) => event.type === "PERMANENT_ENTERED")).toBe(true);
    expect(state.rulesEvents?.some((event) => event.type === "CARD_DRAWN")).toBe(true);
  });

  it("resolves a counter war LIFO", async () => {
    const counterspell = meta({
      name: "Counterspell",
      typeLine: "Instant",
      manaValue: 2,
      oracleText: "Counter target spell.",
    });
    const state = makeState([
      meta({ name: "Mystery Spell", typeLine: "Sorcery", manaValue: 1, oracleText: "Do something strange." }),
    ]);
    state.cardMetadata[1] = { counterspell, island: land("Island") };
    state.cardMetadata[2] = { counterspell, island: land("Island") };
    state.hands[1] = ["Counterspell"];
    state.hands[2] = ["Counterspell"];
    state.battlefields[1] = ["Island", "Island"];
    state.battlefields[2] = ["Island", "Island"];
    state.stack.push({
      id: "spell_a",
      action: { type: "CAST_SPELL", card: "Mystery Spell" },
      casterIndex: 0,
      resolved: false,
      responses: [],
    });

    await resolveStackWithPriority(
      state,
      0,
      [new PassAgent("p0"), new CounterAgent("p1"), new CounterAgent("p2"), new PassAgent("p3")],
      () => {}
    );

    expect(state.graveyards[1]).toContain("Counterspell");
    expect(state.graveyards[2]).toContain("Counterspell");
    expect(state.graveyards[0]).toContain("Mystery Spell");
  });

  it("fizzles targeted removal if the target is gone before resolution", async () => {
    const state = makeState([
      meta({ name: "Murder", typeLine: "Instant", manaValue: 3, oracleText: "Destroy target creature." }),
    ]);
    state.creatures[1] = [{ id: "target_1", name: "Bear", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.stack.push({
      id: "murder",
      action: { type: "CAST_SPELL", card: "Murder", targetId: "target_1" },
      casterIndex: 0,
      resolved: false,
      responses: [],
    });
    state.creatures[1] = [];

    await resolveStackWithPriority(state, 0, [0, 1, 2, 3].map((i) => new PassAgent(`p${i}`)), () => {});

    expect(state.rulesMetrics?.fizzledObjects).toBe(1);
    expect(state.graveyards[0]).toContain("Murder");
  });

  it("unsupported spell has no fake damage and increments metrics", () => {
    const state = makeState([
      meta({ name: "Mystery Spell", typeLine: "Sorcery", manaValue: 1, oracleText: "Do something strange." }),
    ], ["Mystery Spell"]);
    const lifeBefore = [...state.lifeTotals];

    applyAction(state, { type: "CAST_SPELL", card: "Mystery Spell" }, 0, () => {});

    expect(state.lifeTotals).toEqual(lifeBefore);
    expect(state.rulesMetrics?.unsupportedEffects).toBe(1);
    expect(state.graveyards[0]).toContain("Mystery Spell");
  });

  it("generates DIES and LTB events when removal destroys a creature", async () => {
    const state = makeState([
      meta({ name: "Murder", typeLine: "Instant", manaValue: 3, oracleText: "Destroy target creature." }),
    ]);
    state.creatures[1] = [{ id: "target_2", name: "Bear", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.permanents![1] = [{
      id: "perm_bear",
      cardName: "Bear",
      owner: 1,
      controller: 1,
      face: "Bear",
      tapped: false,
      counters: {},
      damageMarked: 0,
      summoningSickness: false,
    }];
    state.stack.push({
      id: "murder_2",
      action: { type: "CAST_SPELL", card: "Murder", targetId: "target_2" },
      casterIndex: 0,
      resolved: false,
      responses: [],
    });

    await resolveStackWithPriority(state, 0, [0, 1, 2, 3].map((i) => new PassAgent(`p${i}`)), () => {});

    expect(state.creatures[1]).toHaveLength(0);
    expect(state.rulesEvents?.some((event) => event.type === "CREATURE_DIED")).toBe(true);
    expect(state.rulesEvents?.some((event) => event.type === "PERMANENT_LEFT")).toBe(true);
  });

  it("continuous cost reducer only works while source is on battlefield", () => {
    const reducer: DeckCardMetadata = {
      name: "Ruby Medallion",
      typeLine: "Artifact",
      manaValue: 2,
      isArtifact: true,
      isPermanent: true,
      oracleText: "Red spells you cast cost {1} less to cast.",
      colors: [],
      colorIdentity: [],
    };
    const bigRed: DeckCardMetadata = {
      name: "Big Red Spell",
      typeLine: "Instant",
      manaValue: 4,
      oracleText: "Big Red Spell deals 3 damage to any target.",
      colors: ["R"],
      colorIdentity: ["R"],
    };
    const state = makeState([reducer, bigRed], ["Big Red Spell"]);
    applyAction(state, { type: "CAST_SPELL", card: "Ruby Medallion" }, 0, () => {});
    const withReducer = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(withReducer.some((action) => action.type === "CAST_SPELL" && action.card === "Big Red Spell")).toBe(true);

    state.battlefields[0] = state.battlefields[0].filter((card) => card !== "Ruby Medallion");
    state.permanents![0] = state.permanents![0].filter((permanent) => permanent.cardName !== "Ruby Medallion");
    const withoutReducer = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(withoutReducer.some((action) => action.type === "CAST_SPELL" && action.card === "Big Red Spell")).toBe(false);
  });

  it("tapped mana sources are ignored", () => {
    const state = makeState([], []);
    state.permanents![0][0].tapped = true;
    expect(getAvailableMana(state, 0)).toBe(4);
  });
});
