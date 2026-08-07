import { describe, expect, it } from "vitest";
import type { DeckCardMetadata, SimGameState } from "@game-state/types";
import { getAvailableMana } from "../../../game-state/src/cardUtils.js";
import { applyAction, createInitialState, untapPermanentsForTurn } from "../engine.js";

const pinnacleMetadata: DeckCardMetadata = {
  name: "Pinnacle Monk // Mystic Peak",
  typeLine: "Creature - Human Monk // Land",
  oracleText:
    "Prowess\nMystic Peak enters tapped.\n{T}: Add {R}.",
  manaValue: 5,
  power: 4,
  toughness: 4,
  isLand: true,
  isCreature: true,
  isPermanent: true,
  entersTapped: true,
  producesMana: true,
  manaProduction: 1,
  spellFace: {
    name: "Pinnacle Monk",
    typeLine: "Creature - Human Monk",
    oracleText: "Prowess",
    manaValue: 5,
    power: 4,
    toughness: 4,
    isCreature: true,
    isPermanent: true,
  },
  landFace: {
    name: "Mystic Peak",
    typeLine: "Land",
    oracleText: "Mystic Peak enters tapped.\n{T}: Add {R}.",
    manaValue: 0,
    isLand: true,
    isPermanent: true,
    entersTapped: true,
    producesMana: true,
    manaProduction: 1,
  },
  aliases: ["Pinnacle Monk", "Mystic Peak"],
};

const basicLand = (name: string): DeckCardMetadata => ({
  name,
  typeLine: `Basic Land - ${name}`,
  oracleText: "{T}: Add one mana of any color.",
  isLand: true,
  isPermanent: true,
  producesMana: true,
  manaProduction: 1,
});

const stormcarvedCoast: DeckCardMetadata = {
  name: "Stormcarved Coast",
  typeLine: "Land",
  oracleText:
    "Stormcarved Coast enters the battlefield tapped unless you control two or more other lands.\n{T}: Add {U} or {R}.",
  isLand: true,
  isPermanent: true,
  producesMana: true,
  manaProduction: 1,
};

function makeState(metadata: DeckCardMetadata[]): SimGameState {
  const state = createInitialState(
    2,
    [["Filler"], ["Filler"]],
    [metadata, []],
    ["Commander", "Commander"],
    0
  );
  state.hands[0] = [];
  state.libraries[0] = [];
  state.battlefields[0] = [];
  state.manaSpent[0] = 0;
  return state;
}

function lastLandPlayedEvent(state: SimGameState) {
  return [...(state.rulesEvents ?? [])].reverse().find((event) => event.type === "LAND_PLAYED");
}

describe("tapped land handling", () => {
  it("Pinnacle Monk // Mystic Peak enters as tapped Mystic Peak when played as land", () => {
    const state = makeState([pinnacleMetadata]);
    state.hands[0] = ["Pinnacle Monk // Mystic Peak"];

    applyAction(state, { type: "PLAY_LAND", card: "Pinnacle Monk // Mystic Peak" }, 0, () => {});

    expect(state.hands[0]).not.toContain("Pinnacle Monk // Mystic Peak");
    expect(state.battlefields[0]).toContain("Mystic Peak");
    expect(state.tappedPermanents?.[0]?.["mystic peak"]).toBe(1);
    expect(getAvailableMana(state, 0)).toBe(0);

    untapPermanentsForTurn(state, 0);
    expect(state.tappedPermanents?.[0]?.["mystic peak"]).toBeUndefined();
    expect(getAvailableMana(state, 0)).toBe(1);
  });

  it("Pinnacle Monk // Mystic Peak is treated as Pinnacle Monk when cast as a spell", () => {
    const state = makeState([pinnacleMetadata, basicLand("Forest")]);
    state.hands[0] = ["Pinnacle Monk // Mystic Peak"];
    state.battlefields[0] = ["Forest", "Forest", "Forest", "Forest", "Forest"];

    applyAction(state, { type: "CAST_SPELL", card: "Pinnacle Monk // Mystic Peak" }, 0, () => {});

    expect(state.creatures[0]).toHaveLength(1);
    expect(state.creatures[0][0]).toMatchObject({
      name: "Pinnacle Monk",
      tapped: false,
      power: 4,
      toughness: 4,
    });
    expect(state.battlefields[0]).not.toContain("Mystic Peak");
    expect(state.tappedPermanents?.[0]?.["mystic peak"]).toBeUndefined();
  });

  it("basic lands enter untapped", () => {
    const state = makeState([basicLand("Forest")]);
    state.hands[0] = ["Forest"];

    applyAction(state, { type: "PLAY_LAND", card: "Forest" }, 0, () => {});

    expect(state.battlefields[0]).toContain("Forest");
    expect(state.tappedPermanents?.[0]?.forest).toBeUndefined();
    expect(getAvailableMana(state, 0)).toBe(1);
  });

  it("lands with unconditional Oracle text 'enters tapped' enter tapped", () => {
    const gainLand: DeckCardMetadata = {
      name: "Gain Land",
      typeLine: "Land",
      oracleText: "Gain Land enters tapped.\n{T}: Add {W}.",
      isLand: true,
      isPermanent: true,
    };
    const state = makeState([gainLand]);
    state.hands[0] = ["Gain Land"];

    applyAction(state, { type: "PLAY_LAND", card: "Gain Land" }, 0, () => {});

    expect(state.tappedPermanents?.[0]?.["gain land"]).toBe(1);
    expect(getAvailableMana(state, 0)).toBe(0);
  });

  it("conditional lands enter tapped when played as the first land", () => {
    const state = makeState([stormcarvedCoast]);
    const log: string[] = [];
    state.hands[0] = ["Stormcarved Coast"];

    applyAction(state, { type: "PLAY_LAND", card: "Stormcarved Coast" }, 0, (msg) => log.push(msg));

    expect(state.permanents?.[0]?.[0]).toMatchObject({
      cardName: "Stormcarved Coast",
      tapped: true,
    });
    expect(state.tappedPermanents?.[0]?.["stormcarved coast"]).toBe(1);
    expect(getAvailableMana(state, 0)).toBe(0);
    expect(state.rulesEvents?.find((event) => event.type === "LAND_PLAYED")?.data).toMatchObject({
      card: "Stormcarved Coast",
      player: 0,
      enteredTapped: true,
      entryReason: "controls fewer than two other lands",
      otherLandCount: 0,
    });
    expect(log).toContain("Player 0 plays Stormcarved Coast tapped");
    expect(log).toContain("Reason: controls fewer than two other lands");
  });

  it("conditional lands enter tapped with only one other land", () => {
    const state = makeState([stormcarvedCoast, basicLand("Island")]);
    state.hands[0] = ["Stormcarved Coast"];
    applyAction(state, { type: "PLAY_LAND", card: "Island" }, 0, () => {});
    state.hands[0] = ["Stormcarved Coast"];

    applyAction(state, { type: "PLAY_LAND", card: "Stormcarved Coast" }, 0, () => {});

    expect(state.permanents?.[0]?.find((permanent) => permanent.cardName === "Stormcarved Coast")?.tapped).toBe(true);
    expect(lastLandPlayedEvent(state)?.data).toMatchObject({
      enteredTapped: true,
      entryReason: "controls fewer than two other lands",
      otherLandCount: 1,
    });
  });

  it("conditional lands enter untapped with two other lands", () => {
    const state = makeState([stormcarvedCoast, basicLand("Island"), basicLand("Mountain")]);
    const log: string[] = [];
    state.hands[0] = ["Island"];
    applyAction(state, { type: "PLAY_LAND", card: "Island" }, 0, () => {});
    state.hands[0] = ["Mountain"];
    applyAction(state, { type: "PLAY_LAND", card: "Mountain" }, 0, () => {});
    state.hands[0] = ["Stormcarved Coast"];

    applyAction(state, { type: "PLAY_LAND", card: "Stormcarved Coast" }, 0, (msg) => log.push(msg));

    expect(state.permanents?.[0]?.find((permanent) => permanent.cardName === "Stormcarved Coast")?.tapped).toBe(false);
    expect(state.tappedPermanents?.[0]?.["stormcarved coast"]).toBeUndefined();
    expect(lastLandPlayedEvent(state)?.data).toMatchObject({
      enteredTapped: false,
      entryReason: "controls two or more other lands",
      otherLandCount: 2,
    });
    expect(log).toContain("Player 0 plays Stormcarved Coast untapped");
    expect(log).toContain("Reason: controls two or more other lands");
  });

  it("does not count the entering conditional land as another land", () => {
    const state = makeState([stormcarvedCoast, basicLand("Island")]);
    state.hands[0] = ["Island"];
    applyAction(state, { type: "PLAY_LAND", card: "Island" }, 0, () => {});
    state.hands[0] = ["Stormcarved Coast"];

    applyAction(state, { type: "PLAY_LAND", card: "Stormcarved Coast" }, 0, () => {});

    expect(state.battlefields[0]).toHaveLength(2);
    expect(lastLandPlayedEvent(state)?.data?.otherLandCount).toBe(1);
    expect(state.permanents?.[0]?.find((permanent) => permanent.cardName === "Stormcarved Coast")?.tapped).toBe(true);
  });

  it("conditional tapped lands untap normally on the next turn", () => {
    const state = makeState([stormcarvedCoast]);
    state.hands[0] = ["Stormcarved Coast"];
    applyAction(state, { type: "PLAY_LAND", card: "Stormcarved Coast" }, 0, () => {});

    expect(getAvailableMana(state, 0)).toBe(0);
    state.turn += 1;
    untapPermanentsForTurn(state, 0);

    expect(state.permanents?.[0]?.[0]?.tapped).toBe(false);
    expect(state.tappedPermanents?.[0]?.["stormcarved coast"]).toBeUndefined();
    expect(getAvailableMana(state, 0)).toBe(1);
  });

  it("conditional tapped lands are not hardcoded as always tapped", () => {
    const checkLand: DeckCardMetadata = {
      name: "Check Land",
      typeLine: "Land",
      oracleText:
        "Check Land enters tapped unless you control an Island or a Swamp.\n{T}: Add {U}.",
      isLand: true,
      isPermanent: true,
    };
    const state = makeState([checkLand]);
    state.hands[0] = ["Check Land"];

    applyAction(state, { type: "PLAY_LAND", card: "Check Land" }, 0, () => {});

    expect(state.tappedPermanents?.[0]?.["check land"]).toBeUndefined();
    expect(getAvailableMana(state, 0)).toBe(1);
  });

  it("tapped lands are not counted as available mana", () => {
    const state = makeState([basicLand("Forest"), basicLand("Island")]);
    state.battlefields[0] = ["Forest", "Island"];
    state.tappedPermanents = { 0: { forest: 1 } };

    expect(getAvailableMana(state, 0)).toBe(1);
  });
});
