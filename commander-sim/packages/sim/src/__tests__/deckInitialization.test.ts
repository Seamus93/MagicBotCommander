import { describe, expect, it } from "vitest";
import { createInitialState } from "../engine.js";
import type { CardName, DeckCardMetadata } from "@game-state/types";

const commander = "Marchesa, the Black Rose";

function commanderDeck(): CardName[] {
  return [commander, ...Array.from({ length: 99 }, (_, index) => `Card ${index + 1}`)];
}

function expectCommanderDeckAudit(
  state: ReturnType<typeof createInitialState>,
  player: number,
  inputDecklistCount = 100
) {
  const audit = state.deckInitAudits?.[player];
  expect(audit).toMatchObject({
    playerId: player,
    inputDecklistCount,
    expectedDeckSize: 100,
    commander: { cardName: commander },
    commandZoneCount: 1,
    libraryCountBeforeOpeningHand: 99,
    handCountAfterOpeningDraw: 7,
    libraryCountAfterOpeningDraw: 92,
    totalCardsAcrossZones: 100,
    totalUniqueInstanceIds: 100,
    commanderOccurrencesAcrossZones: 1,
    duplicateInstanceIds: [],
    invariantViolations: [],
  });
  expect(audit?.instanceIdsByZone.commandZone).toContain(audit?.commander.instanceId);
  expect(audit?.instanceIdsByZone.library).not.toContain(audit?.commander.instanceId);
  expect(audit?.instanceIdsByZone.hand).not.toContain(audit?.commander.instanceId);
  expect(new Set(Object.values(audit?.instanceIdsByZone ?? {}).flat()).size).toBe(100);
}

describe("Commander deck initialization", () => {
  it("extracts the configured commander before shuffle and opening draw", () => {
    const state = createInitialState(1, [commanderDeck()], undefined, [commander]);

    expect(state.commandZone).toEqual([[commander]]);
    expect(state.libraries[0]).toHaveLength(92);
    expect(state.hands[0]).toHaveLength(7);
    expect(state.libraries[0]).not.toContain(commander);
    expect(state.hands[0]).not.toContain(commander);
    expectCommanderDeckAudit(state, 0);
  });

  it("audits a decklist that has 100 noncommander cards plus a separate commander as 101 cards", () => {
    const state = createInitialState(1, [Array.from({ length: 100 }, (_, index) => `Card ${index + 1}`)], undefined, [commander]);
    const audit = state.deckInitAudits![0];

    expect(audit.commandZoneCount).toBe(1);
    expect(audit.libraryCountBeforeOpeningHand).toBe(100);
    expect(audit.totalCardsAcrossZones).toBe(101);
    expect(audit.totalUniqueInstanceIds).toBe(101);
    expect(audit.invariantViolations).toContain("libraryCountBeforeOpeningHand must be 99");
    expect(audit.invariantViolations).toContain("totalCardsAcrossZones must be 100");
  });

  it("accepts a 99-card list when the configured commander is already separate", () => {
    const state = createInitialState(1, [Array.from({ length: 99 }, (_, index) => `Card ${index + 1}`)], undefined, [commander]);

    expectCommanderDeckAudit(state, 0, 99);
  });

  it("never naturally draws the commander during repeated initial shuffles", () => {
    for (let iteration = 0; iteration < 200; iteration++) {
      const state = createInitialState(1, [commanderDeck()], undefined, [commander]);
      expect(state.hands[0]).not.toContain(commander);
      expect(state.libraries[0]).not.toContain(commander);
      expect(state.commandZone?.[0]).toEqual([commander]);
      expect(state.deckInitAudits?.[0].duplicateInstanceIds).toEqual([]);
    }
  });

  it("initializes four configured Commander decks independently", () => {
    const decks = Array.from({ length: 4 }, () => commanderDeck());
    const state = createInitialState(4, decks, undefined, Array(4).fill(commander));

    expect(state.commandZone).toEqual(Array.from({ length: 4 }, () => [commander]));
    expect(state.hands.map((hand) => hand.length)).toEqual([7, 7, 7, 7]);
    expect(state.libraries.map((library) => library.length)).toEqual([92, 92, 92, 92]);
    for (let player = 0; player < 4; player++) expectCommanderDeckAudit(state, player);
    const allIds = state.deckInitAudits!.flatMap((audit) => Object.values(audit.instanceIdsByZone).flat());
    expect(new Set(allIds).size).toBe(400);
  });

  it("preserves MDFC instances while extracting a single-faced commander", () => {
    const mdfcName = "Pinnacle Monk / Mystic Peak";
    const deck = [commander, mdfcName, ...Array.from({ length: 98 }, (_, index) => `Card ${index + 1}`)];
    const metadata: DeckCardMetadata[] = [{
      name: mdfcName,
      typeLine: "Creature - Human Monk // Land",
      manaCost: "{4}{R}",
      manaValue: 5,
      isLand: true,
      spellFace: { name: "Pinnacle Monk", typeLine: "Creature - Human Monk", isCreature: true },
      landFace: { name: "Mystic Peak", typeLine: "Land", isLand: true },
    }];
    const state = createInitialState(1, [deck], [metadata], [commander]);

    expect(state.commandZone?.[0]).toEqual([commander]);
    expect(state.deckInitAudits?.[0]).toMatchObject({
      inputDecklistCount: 100,
      libraryCountBeforeOpeningHand: 99,
      totalUniqueInstanceIds: 100,
      duplicateInstanceIds: [],
    });
    expect(state.hands[0].includes(mdfcName) || state.libraries[0].includes(mdfcName)).toBe(true);
    expect(state.cardMetadata[0][mdfcName.toLowerCase()]).toBeDefined();
  });
});