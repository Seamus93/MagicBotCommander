import { beforeAll, describe, expect, it } from "vitest";
import type { DeckCardMetadata, SimGameState } from "@game-state/types";
import { getAvailableMana, traceManaSourcesForPlayer } from "../../../game-state/src/cardUtils.js";
import { applyAction, createInitialState, generateActions, untapPermanentsForTurn } from "../engine.js";
import { fetchCardMetadata } from "../cardMetadata.js";

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

const drownedCatacomb: DeckCardMetadata = {
  name: "Drowned Catacomb",
  typeLine: "Land",
  oracleText:
    "Drowned Catacomb enters tapped unless you control an Island or a Swamp.\n{T}: Add {U} or {B}.",
  isLand: true,
  isPermanent: true,
  producesMana: true,
  manaProduction: 1,
};

const wateryGrave: DeckCardMetadata = {
  name: "Watery Grave",
  typeLine: "Land - Island Swamp",
  oracleText:
    "As Watery Grave enters, you may pay 2 life. If you don't, it enters tapped.",
  isLand: true,
  isPermanent: true,
  producesMana: true,
  manaProduction: 1,
};

const boggartTrawler: DeckCardMetadata = {
  name: "Boggart Trawler // Boggart Bog",
  typeLine: "Creature - Goblin // Land",
  oracleText:
    "Boggart Trawler\nBoggart Bog enters the battlefield tapped unless you pay 3 life.",
  isLand: true,
  isCreature: true,
  isPermanent: true,
  spellFace: {
    name: "Boggart Trawler",
    typeLine: "Creature - Goblin",
    oracleText: "When this creature enters, mill four cards.",
    manaValue: 3,
    power: 3,
    toughness: 1,
    isCreature: true,
    isPermanent: true,
  },
  landFace: {
    name: "Boggart Bog",
    typeLine: "Land",
    oracleText:
      "As Boggart Bog enters the battlefield, you may pay 3 life. If you don't, it enters the battlefield tapped.\n{T}: Add {B}.",
    manaValue: 0,
    isLand: true,
    isPermanent: true,
    producesMana: true,
    manaProduction: 1,
  },
  aliases: ["Boggart Trawler", "Boggart Bog"],
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

function playLand(state: SimGameState, card: string) {
  state.hands[0] = [card];
  applyAction(state, { type: "PLAY_LAND", card }, 0, () => {});
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

  it.each([
    { existingLand: undefined, expectedTapped: true },
    { existingLand: "Mountain", expectedTapped: true },
    { existingLand: "Forest", expectedTapped: true },
    { existingLand: "Island", expectedTapped: false },
    { existingLand: "Swamp", expectedTapped: false },
    { existingLand: "Watery Grave", expectedTapped: false },
  ])(
    "Drowned Catacomb tapped state is based on controlled Island or Swamp subtype: $existingLand",
    ({ existingLand, expectedTapped }) => {
      const metadata = [
        drownedCatacomb,
        basicLand("Mountain"),
        basicLand("Forest"),
        basicLand("Island"),
        basicLand("Swamp"),
        wateryGrave,
      ];
      const state = makeState(metadata);

      if (existingLand) {
        playLand(state, existingLand);
      }
      playLand(state, "Drowned Catacomb");

      expect(
        state.permanents?.[0]?.find((permanent) => permanent.cardName === "Drowned Catacomb")?.tapped
      ).toBe(expectedTapped);
      expect(state.tappedPermanents?.[0]?.["drowned catacomb"]).toBe(
        expectedTapped ? 1 : undefined
      );
      expect(lastLandPlayedEvent(state)?.data).toMatchObject({
        card: "Drowned Catacomb",
        enteredTapped: expectedTapped,
      });
    }
  );

  it("Drowned Catacomb does not treat Mountain's mana or landness as Island or Swamp", () => {
    const state = makeState([drownedCatacomb, basicLand("Mountain")]);

    playLand(state, "Mountain");
    playLand(state, "Drowned Catacomb");

    expect(lastLandPlayedEvent(state)?.data).toMatchObject({
      enteredTapped: true,
      entryReason: "controls no Island or Swamp",
    });
    expect(getAvailableMana(state, 0)).toBe(1);
  });

  it("generates entry choices for optional life-cost lands", () => {
    const state = makeState([boggartTrawler]);
    state.hands[0] = ["Boggart Trawler // Boggart Bog"];
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";
    state.playerIndex = 0;

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: false,
      allowSorcery: false,
      allowLand: true,
    }).filter((action) => action.type === "PLAY_LAND");

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          card: "Boggart Trawler // Boggart Bog",
          face: "Boggart Bog",
          entryChoice: { type: "PAY_LIFE", amount: 3 },
        }),
        expect.objectContaining({
          card: "Boggart Trawler // Boggart Bog",
          face: "Boggart Bog",
          entryChoice: { type: "DECLINE" },
        }),
      ])
    );
  });

  it("Boggart Bog PAY entry choice costs 3 life and enters untapped", () => {
    const state = makeState([boggartTrawler]);
    const log: string[] = [];
    state.hands[0] = ["Boggart Trawler // Boggart Bog"];

    applyAction(
      state,
      {
        type: "PLAY_LAND",
        card: "Boggart Trawler // Boggart Bog",
        face: "Boggart Bog",
        entryChoice: { type: "PAY_LIFE", amount: 3 },
      },
      0,
      (msg) => log.push(msg)
    );

    expect(state.lifeTotals[0]).toBe(37);
    expect(state.battlefields[0]).toContain("Boggart Bog");
    expect(state.permanents?.[0]?.find((permanent) => permanent.face === "Boggart Bog")?.tapped).toBe(false);
    expect(state.tappedPermanents?.[0]?.["boggart bog"]).toBeUndefined();
    expect(lastLandPlayedEvent(state)?.data).toMatchObject({
      card: "Boggart Trawler // Boggart Bog",
      enteredTapped: false,
      entryReason: "paid 3 life",
      optionalCost: { type: "PAY_LIFE", amount: 3, paid: true },
    });
    expect(log).toContain("Player 0 pays 3 life for Boggart Bog");
    expect(log).toContain("Player 0 plays Boggart Bog untapped");
  });

  it("Boggart Bog DECLINE entry choice keeps life total and enters tapped", () => {
    const state = makeState([boggartTrawler]);
    state.hands[0] = ["Boggart Trawler // Boggart Bog"];

    applyAction(
      state,
      {
        type: "PLAY_LAND",
        card: "Boggart Trawler // Boggart Bog",
        face: "Boggart Bog",
        entryChoice: { type: "DECLINE" },
      },
      0,
      () => {}
    );

    expect(state.lifeTotals[0]).toBe(40);
    expect(state.permanents?.[0]?.find((permanent) => permanent.face === "Boggart Bog")?.tapped).toBe(true);
    expect(state.tappedPermanents?.[0]?.["boggart bog"]).toBe(1);
    expect(lastLandPlayedEvent(state)?.data).toMatchObject({
      enteredTapped: true,
      entryReason: "declined to pay 3 life",
      optionalCost: { type: "PAY_LIFE", amount: 3, paid: false },
    });
  });

  it("tapped lands are not counted as available mana", () => {
    const state = makeState([basicLand("Forest"), basicLand("Island")]);
    state.battlefields[0] = ["Forest", "Island"];
    state.tappedPermanents = { 0: { forest: 1 } };

    expect(getAvailableMana(state, 0)).toBe(1);
  });
});

describe("MDFC selected-face handling from production card metadata", () => {
  const realMetadata = new Map<string, DeckCardMetadata>();

  beforeAll(async () => {
    for (const name of [
      "Malakir Rebirth // Malakir Mire",
      "Boggart Trawler // Boggart Bog",
      "Pinnacle Monk // Mystic Peak",
      "Forest",
      "Swamp",
      "Sol Ring",
    ]) {
      const metadata = await fetchCardMetadata(name);
      expect(metadata).not.toBeNull();
      realMetadata.set(name, metadata!);
    }
  }, 30_000);

  function realState(...names: string[]) {
    const state = makeState(names.map((name) => realMetadata.get(name)!));
    state.playerIndex = 0;
    state.phase = "Prima Fase Principale";
    state.phaseStep = "Prima Fase Principale";
    return state;
  }

  it("Malakir Mire selected as land face enters tapped", () => {
    const state = realState("Malakir Rebirth // Malakir Mire");
    const log: string[] = [];
    state.hands[0] = ["Malakir Rebirth // Malakir Mire"];

    applyAction(
      state,
      {
        type: "PLAY_LAND",
        card: "Malakir Rebirth // Malakir Mire",
        selectedFaceId: "Malakir Mire",
      },
      0,
      (message) => log.push(message)
    );

    expect(state.battlefields[0]).toContain("Malakir Mire");
    expect(state.permanents?.[0]?.find((permanent) => permanent.face === "Malakir Mire")?.tapped).toBe(true);
    expect(lastLandPlayedEvent(state)?.data).toMatchObject({
      enteredTapped: true,
      entryReason: "enters tapped",
    });
    expect(log.join("\n")).toContain("[MDFC]\ncard=Malakir Rebirth // Malakir Mire\nselected_face=Malakir Mire");
    expect(log.join("\n")).toContain("entry_effect=ENTERS_TAPPED");
    expect(log).toContain("Player 0 plays Malakir Mire tapped");
  });

  it("production PLAY_LAND for Pinnacle Monk selects Mystic Peak and leaves a usable red source", () => {
    const state = realState("Pinnacle Monk // Mystic Peak");
    state.hands[0] = ["Pinnacle Monk // Mystic Peak"];

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    const action = actions.find((candidate) =>
      candidate.type === "PLAY_LAND" &&
      candidate.card === "Pinnacle Monk // Mystic Peak" &&
      candidate.selectedFaceId === "Mystic Peak" &&
      candidate.entryChoice?.type === "PAY_LIFE"
    );

    expect(action).toMatchObject({
      type: "PLAY_LAND",
      card: "Pinnacle Monk // Mystic Peak",
      selectedFaceId: "Mystic Peak",
      selectedFaceName: "Mystic Peak",
      selectedFaceTypeLine: "Land",
    });

    applyAction(state, action!, 0, () => {});

    expect(state.battlefields[0]).toContain("Mystic Peak");
    expect(state.permanents?.[0]?.find((permanent) => permanent.cardName === "Pinnacle Monk // Mystic Peak")).toMatchObject({
      face: "Mystic Peak",
      tapped: false,
    });
    expect(traceManaSourcesForPlayer(state, 0)).toContainEqual(expect.objectContaining({
      physicalCard: "Pinnacle Monk // Mystic Peak",
      activeFace: "Mystic Peak",
      manaAbilityRecognized: true,
      produces: ["R"],
      usable: true,
    }));
  });

  it("production PLAY_LAND for Malakir Rebirth selects Malakir Mire and enters tapped", () => {
    const state = realState("Malakir Rebirth // Malakir Mire");
    state.hands[0] = ["Malakir Rebirth // Malakir Mire"];

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    const action = actions.find((candidate) =>
      candidate.type === "PLAY_LAND" &&
      candidate.card === "Malakir Rebirth // Malakir Mire"
    );

    expect(action).toMatchObject({
      type: "PLAY_LAND",
      selectedFaceId: "Malakir Mire",
      selectedFaceName: "Malakir Mire",
      selectedFaceTypeLine: "Land",
    });

    applyAction(state, action!, 0, () => {});

    expect(state.battlefields[0]).toContain("Malakir Mire");
    expect(state.permanents?.[0]?.find((permanent) => permanent.cardName === "Malakir Rebirth // Malakir Mire")).toMatchObject({
      face: "Malakir Mire",
      tapped: true,
    });
  });

  it("production CAST_SPELL for Malakir Rebirth selects the spell face, not Malakir Mire", () => {
    const state = realState("Malakir Rebirth // Malakir Mire", "Swamp");
    state.hands[0] = ["Malakir Rebirth // Malakir Mire"];
    state.battlefields[0] = ["Swamp"];
    state.permanents![0] = [{
      id: "swamp-1",
      cardName: "Swamp",
      owner: 0,
      controller: 0,
      face: "Swamp",
      tapped: false,
    }, {
      id: "target-creature",
      cardName: "Target Creature",
      owner: 0,
      controller: 0,
      face: "Target Creature",
      tapped: false,
    }];
    state.creatures[0] = [{
      id: "target-creature",
      name: "Target Creature",
      power: 1,
      toughness: 1,
      tapped: false,
      summoningSickness: false,
    }];

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    const action = actions.find((candidate) =>
      candidate.type === "CAST_SPELL" &&
      candidate.card === "Malakir Rebirth // Malakir Mire"
    );

    expect(action).toMatchObject({
      type: "CAST_SPELL",
      selectedFaceId: "Malakir Rebirth",
      selectedFaceName: "Malakir Rebirth",
    });
    expect(action?.type === "CAST_SPELL" ? action.selectedFaceTypeLine?.toLowerCase() : undefined).toContain("instant");

    applyAction(state, action!, 0, () => {});

    expect(state.battlefields[0]).not.toContain("Malakir Mire");
    expect(state.permanents?.[0]?.some((permanent) => permanent.face === "Malakir Mire")).toBe(false);
  });

  it("production PLAY_LAND for a normal single-faced land is unchanged", () => {
    const state = realState("Forest");
    state.hands[0] = ["Forest"];

    const actions = generateActions(state, 0, {
      landDropsUsedThisTurn: 0,
      maxLandDrops: 1,
      allowInstant: true,
      allowSorcery: true,
      allowLand: true,
    });
    const action = actions.find((candidate) => candidate.type === "PLAY_LAND" && candidate.card === "Forest");

    expect(action).toMatchObject({
      type: "PLAY_LAND",
      card: "Forest",
    });
    expect(action?.type === "PLAY_LAND" ? action.selectedFaceId : undefined).toBeUndefined();

    applyAction(state, action!, 0, () => {});
    expect(state.battlefields[0]).toContain("Forest");
  });

  it("Boggart Bog selected as land face can pay 3 life and enter untapped", () => {
    const state = realState("Boggart Trawler // Boggart Bog");
    state.hands[0] = ["Boggart Trawler // Boggart Bog"];

    applyAction(
      state,
      {
        type: "PLAY_LAND",
        card: "Boggart Trawler // Boggart Bog",
        selectedFaceId: "Boggart Bog",
        entryChoice: { type: "PAY_LIFE", amount: 3 },
      },
      0,
      () => {}
    );

    expect(state.lifeTotals[0]).toBe(37);
    expect(state.permanents?.[0]?.find((permanent) => permanent.face === "Boggart Bog")?.tapped).toBe(false);
    expect(lastLandPlayedEvent(state)?.data).toMatchObject({
      enteredTapped: false,
      optionalCost: { type: "PAY_LIFE", amount: 3, paid: true },
    });
  });

  it("Boggart Bog selected as land face enters tapped when life payment is declined", () => {
    const state = realState("Boggart Trawler // Boggart Bog");
    state.hands[0] = ["Boggart Trawler // Boggart Bog"];

    applyAction(
      state,
      {
        type: "PLAY_LAND",
        card: "Boggart Trawler // Boggart Bog",
        selectedFaceId: "Boggart Bog",
        entryChoice: { type: "DECLINE" },
      },
      0,
      () => {}
    );

    expect(state.lifeTotals[0]).toBe(40);
    expect(state.permanents?.[0]?.find((permanent) => permanent.face === "Boggart Bog")?.tapped).toBe(true);
    expect(lastLandPlayedEvent(state)?.data).toMatchObject({
      enteredTapped: true,
      optionalCost: { type: "PAY_LIFE", amount: 3, paid: false },
    });
  });

  it("Mystic Peak behavior is read from the selected face definition", () => {
    const state = realState("Pinnacle Monk // Mystic Peak");
    const log: string[] = [];
    state.hands[0] = ["Pinnacle Monk // Mystic Peak"];

    applyAction(
      state,
      {
        type: "PLAY_LAND",
        card: "Pinnacle Monk // Mystic Peak",
        selectedFaceId: "Mystic Peak",
        entryChoice: { type: "PAY_LIFE", amount: 3 },
      },
      0,
      (message) => log.push(message)
    );

    expect(state.battlefields[0]).toContain("Mystic Peak");
    expect(state.lifeTotals[0]).toBe(37);
    expect(state.permanents?.[0]?.find((permanent) => permanent.face === "Mystic Peak")?.tapped).toBe(false);
    expect(lastLandPlayedEvent(state)?.data).toMatchObject({
      enteredTapped: false,
      entryReason: "paid 3 life",
    });
    const diagnostic = log.find((message) => message.startsWith("[MDFC]")) ?? "";
    expect(diagnostic).toContain("selected_face=Mystic Peak");
    expect(diagnostic).toContain("oracle=As this land enters, you may pay 3 life.");
    expect(diagnostic).not.toContain("Prowess");
  });

  it("normal basic land behavior is unchanged through real metadata", () => {
    const state = realState("Forest");
    state.hands[0] = ["Forest"];

    applyAction(state, { type: "PLAY_LAND", card: "Forest" }, 0, () => {});

    expect(state.battlefields[0]).toContain("Forest");
    expect(state.permanents?.[0]?.find((permanent) => permanent.face === "Forest")?.tapped).toBe(false);
    expect(getAvailableMana(state, 0)).toBe(1);
  });

  it("normal non-MDFC spell behavior is unchanged through real metadata", () => {
    const state = realState("Sol Ring", "Forest");
    state.hands[0] = ["Sol Ring"];
    state.battlefields[0] = ["Forest"];
    state.permanents![0] = [{
      id: "forest-1",
      cardName: "Forest",
      owner: 0,
      controller: 0,
      face: "Forest",
      tapped: false,
    }];

    applyAction(state, { type: "CAST_SPELL", card: "Sol Ring" }, 0, () => {});

    expect(state.battlefields[0]).toContain("Sol Ring");
    expect(state.permanents?.[0]?.find((permanent) => permanent.face === "Sol Ring")).toBeTruthy();
    expect(state.graveyards[0]).not.toContain("Sol Ring");
  });
});
