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
  castSpellToStack,
  cleanupTemporaryEffects,
  createInitialState,
  emitCombatDamageTriggers,
  generateActions,
  resolveStackWithPriority,
} from "../engine.js";
import { availableAttackers, availableBlockers, resolveCombat } from "../../../rules/src/combat/combat.js";

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

function setManaBoard(state: SimGameState, player: number, permanents: DeckCardMetadata[]) {
  state.battlefields[player] = [];
  state.permanents![player] = [];
  state.artifacts[player] = [];
  for (const metadata of permanents) {
    const face = metadata.landFace?.name ?? metadata.name;
    state.cardMetadata[player][metadata.name.toLowerCase()] = metadata;
    state.cardMetadata[player][face.toLowerCase()] = metadata;
    state.battlefields[player].push(face);
    state.permanents![player].push({
      id: `perm_${face.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      cardName: metadata.name,
      owner: player,
      controller: player,
      face,
      tapped: false,
      counters: {},
      damageMarked: 0,
    });
    if (metadata.isArtifact) state.artifacts[player].push(face);
  }
}

const basicLand = (name: "Island" | "Mountain" | "Swamp" | "Plains" | "Forest"): DeckCardMetadata => ({
  name,
  typeLine: `Basic Land - ${name}`,
  isLand: true,
  isPermanent: true,
  producesMana: true,
});

const solRing: DeckCardMetadata = {
  name: "Sol Ring",
  typeLine: "Artifact",
  manaCost: "{1}",
  manaValue: 1,
  isArtifact: true,
  isPermanent: true,
  producesMana: true,
  oracleText: "{T}: Add {C}{C}.",
};

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

  it("queues and resolves a generic DIES draw trigger", async () => {
    const doomed: DeckCardMetadata = {
      name: "Doomed Witness",
      typeLine: "Creature - Human",
      manaValue: 2,
      power: 1,
      toughness: 1,
      isCreature: true,
      isPermanent: true,
      oracleText: "When Doomed Witness dies, draw a card.",
    };
    const state = makeState([
      meta({ name: "Murder", typeLine: "Instant", manaValue: 3, oracleText: "Destroy target creature." }),
      doomed,
    ]);
    state.cardMetadata[1] = { ...state.cardMetadata[1], "doomed witness": doomed };
    state.creatures[1] = [{ id: "doomed_1", name: "Doomed Witness", power: 1, toughness: 1, tapped: false, summoningSickness: false }];
    state.permanents![1] = [{
      id: "perm_doomed",
      cardName: "Doomed Witness",
      owner: 1,
      controller: 1,
      face: "Doomed Witness",
      tapped: false,
      counters: {},
      damageMarked: 0,
      summoningSickness: false,
    }];
    state.libraries[1] = ["Reward Card"];
    const handBefore = state.hands[1].length;
    state.stack.push({
      id: "murder_doomed",
      action: { type: "CAST_SPELL", card: "Murder", targetId: "doomed_1" },
      casterIndex: 0,
      resolved: false,
      responses: [],
    });

    await resolveStackWithPriority(state, 0, [0, 1, 2, 3].map((i) => new PassAgent(`p${i}`)), () => {});

    expect(state.creatures[1]).toHaveLength(0);
    expect(state.hands[1].length).toBe(handBefore + 1);
    expect(state.hands[1]).toContain("Reward Card");
  });

  it("resolves generic spell primitives for life gain, token creation, and counters", () => {
    const state = makeState([
      meta({ name: "Healing Salve", typeLine: "Sorcery", manaValue: 1, oracleText: "You gain 3 life." }),
      meta({ name: "Raise Alarm", typeLine: "Sorcery", manaValue: 2, oracleText: "Create two 1/1 white Soldier creature tokens." }),
      meta({ name: "Strength Spell", typeLine: "Sorcery", manaValue: 1, oracleText: "Put two +1/+1 counters on target creature." }),
    ]);
    state.creatures[1] = [{ id: "bear_1", name: "Bear", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.permanents![1] = [{
      id: "perm_bear_1",
      cardName: "Bear",
      owner: 1,
      controller: 1,
      face: "Bear",
      tapped: false,
      counters: {},
      damageMarked: 0,
      summoningSickness: false,
    }];

    applyAction(state, { type: "CAST_SPELL", card: "Healing Salve" }, 0, () => {});
    applyAction(state, { type: "CAST_SPELL", card: "Raise Alarm" }, 0, () => {});
    applyAction(state, { type: "CAST_SPELL", card: "Strength Spell", targetId: "bear_1" }, 0, () => {});

    expect(state.lifeTotals[0]).toBe(43);
    expect(state.creatures[0].filter((creature) => creature.name === "Soldier")).toHaveLength(2);
    expect(state.creatures[1][0]).toMatchObject({ power: 4, toughness: 4 });
    expect(state.permanents?.[1]?.[0].counters?.["+1/+1"]).toBe(2);
  });

  it("returns target creature cards from graveyard to hand and battlefield", () => {
    const deadBear: DeckCardMetadata = {
      name: "Dead Bear",
      typeLine: "Creature - Bear",
      manaValue: 2,
      power: 2,
      toughness: 2,
      isCreature: true,
      isPermanent: true,
    };
    const state = makeState([
      deadBear,
      meta({ name: "Raise Dead Variant", typeLine: "Sorcery", manaValue: 1, oracleText: "Return target creature card from your graveyard to your hand." }),
      meta({ name: "Reanimate Variant", typeLine: "Sorcery", manaValue: 1, oracleText: "Return target creature card from your graveyard to the battlefield." }),
    ]);
    state.cardMetadata[0]["dead bear"] = deadBear;
    state.graveyards[0] = ["Dead Bear"];

    applyAction(state, { type: "CAST_SPELL", card: "Raise Dead Variant", targetGraveyardCard: "Dead Bear" }, 0, () => {});
    expect(state.hands[0]).toContain("Dead Bear");
    expect(state.graveyards[0]).not.toContain("Dead Bear");

    state.hands[0] = state.hands[0].filter((cardName) => cardName !== "Dead Bear");
    state.graveyards[0] = ["Dead Bear"];
    applyAction(state, { type: "CAST_SPELL", card: "Reanimate Variant", targetGraveyardCard: "Dead Bear" }, 0, () => {});
    expect(state.creatures[0].some((creature) => creature.name === "Dead Bear")).toBe(true);
    expect(state.graveyards[0]).not.toContain("Dead Bear");
  });

  it("requires sacrifice additional costs before a spell is legal", () => {
    const costly = meta({
      name: "Costly Bargain",
      typeLine: "Sorcery",
      isSorcery: true,
      manaValue: 1,
      oracleText: "As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.",
    });
    const state = makeState([costly], ["Costly Bargain"]);
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";

    const withoutCreature = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(withoutCreature.some((action) => action.type === "CAST_SPELL" && action.card === "Costly Bargain")).toBe(false);

    state.creatures[0] = [{ id: "fodder_1", name: "Fodder", power: 1, toughness: 1, tapped: false, summoningSickness: false }];
    state.battlefields[0].push("Fodder");
    state.permanents![0].push({
      id: "perm_fodder",
      cardName: "Fodder",
      owner: 0,
      controller: 0,
      face: "Fodder",
      tapped: false,
      counters: {},
      damageMarked: 0,
      summoningSickness: false,
    });
    const withCreature = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(withCreature.some((action) => action.type === "CAST_SPELL" && action.card === "Costly Bargain")).toBe(true);

    applyAction(state, { type: "CAST_SPELL", card: "Costly Bargain" }, 0, () => {});
    expect(state.creatures[0]).toHaveLength(0);
    expect(state.graveyards[0]).toContain("Fodder");
  });

  it("uses colored mana requirements and taps Sol Ring only as a real source", () => {
    const blueRed = meta({ name: "Izzet Charm Test", typeLine: "Instant", isInstant: true, manaCost: "{U}{R}", manaValue: 2, oracleText: "Draw a card." });
    const bigRed = meta({ name: "Big Red Test", typeLine: "Sorcery", isSorcery: true, manaCost: "{2}{R}", manaValue: 3, oracleText: "Draw a card." });
    const state = makeState([blueRed, bigRed, solRing, basicLand("Mountain")], ["Izzet Charm Test", "Big Red Test"]);
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";
    setManaBoard(state, 0, [basicLand("Mountain"), solRing]);

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });

    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Izzet Charm Test")).toBe(false);
    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Big Red Test")).toBe(true);

    applyAction(state, { type: "CAST_SPELL", card: "Big Red Test" }, 0, () => {});

    expect(state.permanents![0].find((permanent) => permanent.face === "Mountain")?.tapped).toBe(true);
    expect(state.permanents![0].find((permanent) => permanent.face === "Sol Ring")?.tapped).toBe(true);
    expect(state.artifactMana[0]).toBe(0);
  });

  it("allows matching colored costs and rejects colorless costs paid by colored mana", () => {
    const blueRed = meta({ name: "Izzet Charm Test", typeLine: "Instant", isInstant: true, manaCost: "{U}{R}", manaValue: 2, oracleText: "Draw a card." });
    const colorless = meta({ name: "Spatial Test", typeLine: "Instant", isInstant: true, manaCost: "{C}{C}", manaValue: 2, oracleText: "Draw a card." });
    const state = makeState([blueRed, colorless, basicLand("Island"), basicLand("Mountain")], ["Izzet Charm Test", "Spatial Test"]);
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";
    setManaBoard(state, 0, [basicLand("Island"), basicLand("Mountain")]);

    let actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Izzet Charm Test")).toBe(true);
    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Spatial Test")).toBe(false);

    applyAction(state, { type: "CAST_SPELL", card: "Izzet Charm Test" }, 0, () => {});
    expect(state.permanents![0].find((permanent) => permanent.face === "Island")?.tapped).toBe(true);
    expect(state.permanents![0].find((permanent) => permanent.face === "Mountain")?.tapped).toBe(true);

    state.hands[0] = ["Izzet Charm Test"];
    actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Izzet Charm Test")).toBe(false);
  });

  it("uses Sol Ring for true colorless costs and cannot reuse tapped sources", () => {
    const colorless = meta({ name: "Spatial Test", typeLine: "Instant", isInstant: true, manaCost: "{C}{C}", manaValue: 2, oracleText: "Draw a card." });
    const second = meta({ name: "Second Spatial Test", typeLine: "Instant", isInstant: true, manaCost: "{C}", manaValue: 1, oracleText: "Draw a card." });
    const state = makeState([colorless, second, solRing], ["Spatial Test", "Second Spatial Test"]);
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";
    setManaBoard(state, 0, [solRing]);

    let actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Spatial Test")).toBe(true);

    applyAction(state, { type: "CAST_SPELL", card: "Spatial Test" }, 0, () => {});
    expect(state.permanents![0].find((permanent) => permanent.face === "Sol Ring")?.tapped).toBe(true);

    actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Second Spatial Test")).toBe(false);
  });

  it("requires Village Rites sacrifice cost and draws only if the spell resolves", async () => {
    const villageRites = meta({
      name: "Village Rites",
      typeLine: "Instant",
      isInstant: true,
      manaCost: "{B}",
      manaValue: 1,
      oracleText: "As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.",
    });
    const counterspell = meta({ name: "Counterspell", typeLine: "Instant", isInstant: true, manaCost: "{U}{U}", manaValue: 2, oracleText: "Counter target spell." });
    const state = makeState([villageRites, counterspell, basicLand("Swamp"), basicLand("Island")], ["Village Rites"]);
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";
    setManaBoard(state, 0, [basicLand("Swamp")]);

    let actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Village Rites")).toBe(false);

    state.creatures[0] = [{ id: "fodder_vr", name: "Fodder", power: 1, toughness: 1, tapped: false, summoningSickness: false }];
    state.battlefields[0].push("Fodder");
    state.permanents![0].push({ id: "perm_fodder_vr", cardName: "Fodder", owner: 0, controller: 0, face: "Fodder", tapped: false, counters: {}, damageMarked: 0 });
    actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Village Rites")).toBe(true);

    state.libraries[0] = ["Draw A", "Draw B"];
    castSpellToStack(state, 0, { type: "CAST_SPELL", card: "Village Rites" }, () => {});
    expect(state.creatures[0]).toHaveLength(0);
    expect(state.graveyards[0]).toContain("Fodder");
    expect(state.rulesEvents?.some((event) => event.type === "CREATURE_DIED")).toBe(true);
    state.stack.push({
      id: "vr_stack",
      action: { type: "CAST_SPELL", card: "Village Rites" },
      casterIndex: 0,
      resolved: false,
      responses: [],
      kind: "spell",
    });
    await resolveStackWithPriority(state, 0, [0, 1, 2, 3].map((i) => new PassAgent(`p${i}`)), () => {});
    expect(state.hands[0]).toContain("Draw A");
    expect(state.hands[0]).toContain("Draw B");

    const countered = makeState([villageRites, counterspell, basicLand("Swamp"), basicLand("Island")], ["Village Rites"]);
    setManaBoard(countered, 0, [basicLand("Swamp")]);
    countered.creatures[0] = [{ id: "fodder_countered", name: "Fodder", power: 1, toughness: 1, tapped: false, summoningSickness: false }];
    countered.battlefields[0].push("Fodder");
    countered.permanents![0].push({ id: "perm_fodder_countered", cardName: "Fodder", owner: 0, controller: 0, face: "Fodder", tapped: false, counters: {}, damageMarked: 0 });
    castSpellToStack(countered, 0, { type: "CAST_SPELL", card: "Village Rites" }, () => {});
    countered.stack.push({
      id: "vr_countered",
      action: { type: "CAST_SPELL", card: "Village Rites" },
      casterIndex: 0,
      resolved: false,
      responses: [],
      kind: "spell",
    });
    countered.stack.splice(0, 1);
    countered.graveyards[0].push("Village Rites");
    expect(countered.graveyards[0]).toContain("Fodder");
    expect(countered.creatures[0]).toHaveLength(0);
    expect(countered.hands[0]).not.toContain("Draw A");
  });

  it("resolves sacrifice effects for the appropriate controller", () => {
    const state = makeState([
      meta({ name: "Cruel Edict", typeLine: "Sorcery", manaValue: 2, oracleText: "Target player sacrifices a creature." }),
    ]);
    state.creatures[1] = [{ id: "victim_1", name: "Victim", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.battlefields[1] = ["Victim"];
    state.permanents![1] = [{
      id: "perm_victim",
      cardName: "Victim",
      owner: 1,
      controller: 1,
      face: "Victim",
      tapped: false,
      counters: {},
      damageMarked: 0,
      summoningSickness: false,
    }];

    applyAction(state, { type: "CAST_SPELL", card: "Cruel Edict" }, 0, () => {});

    expect(state.creatures[1]).toHaveLength(0);
    expect(state.graveyards[1]).toContain("Victim");
  });

  it("stores generic named counters on PermanentState", () => {
    const state = makeState([
      meta({ name: "Charge Up", typeLine: "Sorcery", manaValue: 1, oracleText: "Put two charge counters on target permanent." }),
    ]);
    state.battlefields[1] = ["Mana Rock"];
    state.permanents![1] = [{
      id: "perm_rock",
      cardName: "Mana Rock",
      owner: 1,
      controller: 1,
      face: "Mana Rock",
      tapped: false,
      counters: {},
      damageMarked: 0,
    }];

    applyAction(state, { type: "CAST_SPELL", card: "Charge Up", targetId: "perm_rock" }, 0, () => {});

    expect(state.permanents?.[1]?.[0].counters?.charge).toBe(2);
  });

  it("creates tapped, attacking, and multiple tokens", () => {
    const state = makeState([
      meta({ name: "Zombie Mob", typeLine: "Sorcery", manaValue: 3, oracleText: "Create three tapped 2/2 black Zombie creature tokens." }),
      meta({ name: "Ambush Crew", typeLine: "Sorcery", manaValue: 2, oracleText: "Create a 1/1 red Pirate creature token that's tapped and attacking." }),
    ]);

    applyAction(state, { type: "CAST_SPELL", card: "Zombie Mob" }, 0, () => {});
    applyAction(state, { type: "CAST_SPELL", card: "Ambush Crew" }, 0, () => {});

    const tokens = state.creatures[0].filter((creature) => creature.name === "Zombie" || creature.name === "Pirate");
    expect(tokens.filter((creature) => creature.name === "Zombie")).toHaveLength(3);
    expect(tokens.every((creature) => creature.tapped)).toBe(true);
    expect(tokens.find((creature) => creature.name === "Pirate")).toMatchObject({ power: 1, toughness: 1, tapped: true });
  });

  it("does not require a graveyard target for optional up to one effects", () => {
    const state = makeState([
      meta({
        name: "Optional Return",
        typeLine: "Sorcery",
        isSorcery: true,
        manaValue: 1,
        oracleText: "You may return up to one target permanent card from your graveyard to your hand.",
      }),
    ], ["Optional Return"]);
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";
    state.graveyards[0] = [];

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });

    expect(actions.some((action) => action.type === "CAST_SPELL" && action.card === "Optional Return")).toBe(true);
    applyAction(state, { type: "CAST_SPELL", card: "Optional Return" }, 0, () => {});
    expect(state.graveyards[0]).toContain("Optional Return");
  });

  it("changes controller without changing owner and returns temporary control at cleanup", () => {
    const state = makeState([
      meta({ name: "Act of Treason", typeLine: "Sorcery", isSorcery: true, manaValue: 3, oracleText: "Gain control of target creature until end of turn." }),
    ], ["Act of Treason"]);
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";
    state.creatures[1] = [{ id: "stolen_creature", name: "Stolen Bear", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.battlefields[1] = ["Stolen Bear"];
    state.permanents![1] = [{
      id: "perm_stolen",
      cardName: "Stolen Bear",
      owner: 1,
      controller: 1,
      face: "Stolen Bear",
      tapped: false,
      counters: {},
      damageMarked: 0,
    }];

    applyAction(state, { type: "CAST_SPELL", card: "Act of Treason", targetId: "perm_stolen" }, 0, () => {});

    expect(state.permanents?.[0]?.find((permanent) => permanent.id === "perm_stolen")).toMatchObject({
      owner: 1,
      controller: 0,
    });
    expect(state.creatures[0].some((creature) => creature.name === "Stolen Bear")).toBe(true);

    cleanupTemporaryEffects(state, 0, () => {});

    expect(state.permanents?.[1]?.find((permanent) => permanent.id === "perm_stolen")).toMatchObject({
      owner: 1,
      controller: 1,
    });
    expect(state.creatures[1].some((creature) => creature.name === "Stolen Bear")).toBe(true);
  });

  it("puts a stolen permanent into the owner's graveyard when it dies", () => {
    const state = makeState([
      meta({ name: "Mind Control Test", typeLine: "Sorcery", isSorcery: true, manaValue: 3, oracleText: "Gain control of target creature." }),
      meta({ name: "Murder", typeLine: "Instant", manaValue: 3, oracleText: "Destroy target creature." }),
    ]);
    state.creatures[1] = [{ id: "owned_creature", name: "Owned Bear", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.battlefields[1] = ["Owned Bear"];
    state.permanents![1] = [{
      id: "perm_owned",
      cardName: "Owned Bear",
      owner: 1,
      controller: 1,
      face: "Owned Bear",
      tapped: false,
      counters: {},
      damageMarked: 0,
    }];
    state.battlefields[0].push("Forest");
    state.permanents![0].push({
      id: "perm_extra_forest",
      cardName: "Forest",
      owner: 0,
      controller: 0,
      face: "Forest",
      tapped: false,
      counters: {},
      damageMarked: 0,
    });

    applyAction(state, { type: "CAST_SPELL", card: "Mind Control Test", targetId: "perm_owned" }, 0, () => {});
    applyAction(state, { type: "CAST_SPELL", card: "Murder", targetId: "owned_creature" }, 0, () => {});

    expect(state.creatures[0]).toHaveLength(0);
    expect(state.graveyards[1]).toContain("Owned Bear");
    expect(state.graveyards[0]).not.toContain("Owned Bear");
  });

  it("applies temporary power/toughness changes and removes them at cleanup", () => {
    const state = makeState([
      meta({ name: "Sure Strike", typeLine: "Instant", isInstant: true, manaValue: 2, oracleText: "Target creature you control gets +2/+0 until end of turn." }),
    ]);
    state.creatures[0] = [{ id: "attacker_1", name: "Attacker", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.battlefields[0].push("Attacker");
    state.permanents![0].push({
      id: "perm_attacker",
      cardName: "Attacker",
      owner: 0,
      controller: 0,
      face: "Attacker",
      tapped: false,
      counters: {},
      damageMarked: 0,
    });

    applyAction(state, { type: "CAST_SPELL", card: "Sure Strike", targetId: "perm_attacker" }, 0, () => {});
    expect(state.creatures[0][0]).toMatchObject({ power: 4, toughness: 2 });

    cleanupTemporaryEffects(state, 0, () => {});
    expect(state.creatures[0][0]).toMatchObject({ power: 2, toughness: 2 });
  });

  it("kills a creature when temporary toughness reduction reaches zero", () => {
    const state = makeState([
      meta({ name: "Shrink", typeLine: "Instant", isInstant: true, manaValue: 1, oracleText: "Target creature an opponent controls gets -2/-2 until end of turn." }),
    ]);
    state.creatures[1] = [{ id: "small_1", name: "Small Bear", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.battlefields[1] = ["Small Bear"];
    state.permanents![1] = [{
      id: "perm_small",
      cardName: "Small Bear",
      owner: 1,
      controller: 1,
      face: "Small Bear",
      tapped: false,
      counters: {},
      damageMarked: 0,
    }];

    applyAction(state, { type: "CAST_SPELL", card: "Shrink", targetId: "perm_small" }, 0, () => {});

    expect(state.creatures[1]).toHaveLength(0);
    expect(state.graveyards[1]).toContain("Small Bear");
  });

  it("taps and untaps targeted creatures", () => {
    const state = makeState([
      meta({ name: "Tap Spell", typeLine: "Instant", isInstant: true, manaValue: 1, oracleText: "Tap target creature." }),
      meta({ name: "Untap Spell", typeLine: "Instant", isInstant: true, manaValue: 1, oracleText: "Untap target creature." }),
    ]);
    state.creatures[1] = [{ id: "tap_1", name: "Tap Bear", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.battlefields[1] = ["Tap Bear"];
    state.permanents![1] = [{
      id: "perm_tap",
      cardName: "Tap Bear",
      owner: 1,
      controller: 1,
      face: "Tap Bear",
      tapped: false,
      counters: {},
      damageMarked: 0,
    }];

    applyAction(state, { type: "CAST_SPELL", card: "Tap Spell", targetId: "perm_tap" }, 0, () => {});
    expect(state.creatures[1][0].tapped).toBe(true);
    expect(state.permanents![1][0].tapped).toBe(true);

    applyAction(state, { type: "CAST_SPELL", card: "Untap Spell", targetId: "perm_tap" }, 0, () => {});
    expect(state.creatures[1][0].tapped).toBe(false);
    expect(state.permanents![1][0].tapped).toBe(false);
  });

  it("supports haste, vigilance, and flying/reach combat legality", () => {
    const state = makeState([], []);
    state.creatures[0] = [
      { id: "haste_1", name: "Haste Cat", power: 2, toughness: 2, tapped: false, summoningSickness: true, keywords: ["haste"] },
      { id: "vigilance_1", name: "Alert Cat", power: 2, toughness: 2, tapped: false, summoningSickness: false, keywords: ["vigilance", "flying"] },
    ];
    state.creatures[1] = [
      { id: "ground_1", name: "Ground Bear", power: 2, toughness: 2, tapped: false, summoningSickness: false },
      { id: "reach_1", name: "Reach Spider", power: 1, toughness: 3, tapped: false, summoningSickness: false, keywords: ["reach"] },
    ];

    expect(availableAttackers(state, 0).map((creature) => creature.id)).toContain("haste_1");
    expect(availableBlockers(state, 1).map((creature) => creature.id)).toContain("reach_1");

    resolveCombat(state, 0, 1, ["vigilance_1"], [{ attackerId: "vigilance_1", blockerId: "ground_1" }], () => {});
    expect(state.lifeTotals[1]).toBe(38);
    expect(state.creatures[0].find((creature) => creature.id === "vigilance_1")?.tapped).toBe(false);

    state.lifeTotals[1] = 40;
    resolveCombat(state, 0, 1, ["vigilance_1"], [{ attackerId: "vigilance_1", blockerId: "reach_1" }], () => {});
    expect(state.lifeTotals[1]).toBe(40);
  });

  it("queues combat damage triggers through the stack", async () => {
    const raider: DeckCardMetadata = {
      name: "Curious Raider",
      typeLine: "Creature - Pirate",
      manaValue: 2,
      power: 2,
      toughness: 2,
      isCreature: true,
      isPermanent: true,
      oracleText: "Whenever Curious Raider deals combat damage to a player, draw a card.",
    };
    const state = makeState([raider], []);
    state.creatures[0] = [{ id: "raider_1", name: "Curious Raider", power: 2, toughness: 2, tapped: false, summoningSickness: false }];
    state.battlefields[0].push("Curious Raider");
    state.permanents![0].push({
      id: "perm_raider",
      cardName: "Curious Raider",
      owner: 0,
      controller: 0,
      face: "Curious Raider",
      tapped: false,
      counters: {},
      damageMarked: 0,
    });
    state.libraries[0] = ["Drawn Card"];
    const before = state.hands[0].length;

    emitCombatDamageTriggers(state, 0, 1, [state.creatures[0][0]], [], () => {});
    await resolveStackWithPriority(state, 0, [0, 1, 2, 3].map((i) => new PassAgent(`p${i}`)), () => {});

    expect(state.rulesEvents?.some((event) => event.type === "COMBAT_DAMAGE_DEALT")).toBe(true);
    expect(state.hands[0].length).toBe(before + 1);
    expect(state.hands[0]).toContain("Drawn Card");
  });

  it("queues generic permanent-type entered triggers from other permanents", async () => {
    const watcher = meta({
      name: "Treasure Lookout",
      typeLine: "Creature - Pirate",
      isCreature: true,
      isPermanent: true,
      oracleText: "Whenever this creature or another Pirate you control enters, create a tapped Treasure token.",
    });
    const recruit = meta({
      name: "Deckhand",
      typeLine: "Creature - Pirate",
      isCreature: true,
      isPermanent: true,
      power: 1,
      toughness: 1,
      oracleText: "",
    });
    const state = makeState([watcher, recruit], ["Deckhand"]);
    state.battlefields[0].push("Treasure Lookout");
    state.creatures[0].push({ id: "lookout_1", name: "Treasure Lookout", power: 2, toughness: 2, tapped: false, summoningSickness: false });
    state.permanents![0].push({
      id: "perm_lookout",
      cardName: "Treasure Lookout",
      owner: 0,
      controller: 0,
      face: "Treasure Lookout",
      tapped: false,
      counters: {},
      damageMarked: 0,
    });

    applyAction(state, { type: "CAST_SPELL", card: "Deckhand" }, 0, () => {});
    await resolveStackWithPriority(state, 0, [0, 1, 2, 3].map((i) => new PassAgent(`p${i}`)), () => {});

    expect(state.stack).toHaveLength(0);
    expect(state.battlefields[0]).toContain("Treasure");
    expect(state.permanents![0].find((permanent) => permanent.cardName === "Treasure")?.tapped).toBe(true);
  });

  it("queues generic dies triggers from other permanents", async () => {
    const payoff = meta({
      name: "Death Payoff",
      typeLine: "Creature - Human",
      isCreature: true,
      isPermanent: true,
      oracleText: "Whenever another creature you control dies, create a Treasure token.",
    });
    const victim = meta({
      name: "Victim",
      typeLine: "Creature - Human",
      isCreature: true,
      isPermanent: true,
      power: 1,
      toughness: 1,
      oracleText: "",
    });
    const murder = meta({ name: "Murder", typeLine: "Instant", manaValue: 3, oracleText: "Destroy target creature." });
    const state = makeState([payoff, victim, murder], ["Murder"]);
    state.battlefields[0].push("Death Payoff", "Victim");
    state.creatures[0].push(
      { id: "payoff_1", name: "Death Payoff", power: 2, toughness: 2, tapped: false, summoningSickness: false },
      { id: "victim_1", name: "Victim", power: 1, toughness: 1, tapped: false, summoningSickness: false }
    );
    state.permanents![0].push(
      { id: "perm_payoff", cardName: "Death Payoff", owner: 0, controller: 0, face: "Death Payoff", tapped: false, counters: {}, damageMarked: 0 },
      { id: "perm_victim", cardName: "Victim", owner: 0, controller: 0, face: "Victim", tapped: false, counters: {}, damageMarked: 0 }
    );

    applyAction(state, { type: "CAST_SPELL", card: "Murder", targetId: "perm_victim" }, 0, () => {});
    await resolveStackWithPriority(state, 0, [0, 1, 2, 3].map((i) => new PassAgent(`p${i}`)), () => {});

    expect(state.graveyards[0]).toContain("Victim");
    expect(state.battlefields[0]).toContain("Treasure");
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
