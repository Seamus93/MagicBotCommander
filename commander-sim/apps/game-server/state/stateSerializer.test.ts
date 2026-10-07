import { describe, expect, it } from "vitest";
import type { SimGameState } from "@game-state/types";
import { applyManaPaymentPlan } from "../../../packages/game-state/src/cardUtils";
import {
  assignSeatsByTurnOrder,
  buildPlayerDescriptors,
  buildSeatsFromControllers,
  serializeForRecipient,
  serializeForViewer,
  sessionMappingLog,
} from "./stateSerializer";
import type { SeatId } from "../../../packages/game-state/src/session";

function makeState(): SimGameState {
  return {
    turn: 1,
    playerIndex: 0,
    lifeTotals: [40, 40, 40, 40],
    libraries: [[], [], [], []],
    hands: [["Malakir Rebirth"], ["Island"], ["Mountain"], ["Forest"]],
    battlefields: [[], [], [], []],
    graveyards: [[], [], [], []],
    commanders: ["Marchesa, the Black Rose", "A", "B", "C"],
    creatures: [[], [], [], []],
    artifacts: [[], [], [], []],
    artifactMana: [0, 0, 0, 0],
    manaSpent: [0, 0, 0, 0],
    cardMetadata: [{}, {}, {}, {}],
    triggers: [],
    triggerCounter: 0,
    phase: "Mulligan",
    phaseStep: "Mulligan",
    costReducers: {},
    handSizeModifiers: {},
    drawHistory: {},
    stack: [],
  };
}

describe("player descriptors", () => {
  it("serializes lands tapped by spell payment from canonical permanent state", () => {
    const state = makeState();
    state.battlefields[0] = ["Island", "Island"];
    state.permanents = [
      [
        {
          id: "island-1",
          cardName: "Island",
          owner: 0,
          controller: 0,
          tapped: false,
        },
        {
          id: "island-2",
          cardName: "Island",
          owner: 0,
          controller: 0,
          tapped: false,
        },
      ],
      [],
      [],
      [],
    ];
    applyManaPaymentPlan(state, 0, {
      legal: true,
      sources: [{
        permanentId: "island-1",
        card: "Island",
        producedMana: { W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 },
        usedMana: { W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 },
      }],
    });

    const snapshot = serializeForViewer(state, 0, 0, {
      sessionId: "cast-payment-tap",
      stateVersion: 1,
      gameMode: "HUMAN_VS_AI",
    });

    expect(snapshot.players[0].battlefieldPermanents).toEqual([
      { name: "Island", tapped: true },
      { name: "Island", tapped: false },
    ]);
  });

  it("serializes command and other zone counts from actual zone contents", () => {
    const state = makeState();
    state.commanders[0] = "Marchesa, the Black Rose";
    state.commandZone = [["Marchesa, the Black Rose"], [], [], []];
    state.hands[0] = Array.from({ length: 7 }, (_, index) => `Hand Card ${index}`);
    state.libraries[0] = Array.from({ length: 92 }, (_, index) => `Library Card ${index}`);
    state.graveyards[0] = ["Dead Card"];
    (state as SimGameState & { exiles: string[][] }).exiles = [["Exiled Card"], [], [], []];

    const snapshot = serializeForViewer(state, 0, 0, {
      sessionId: "actual-zone-counts",
      stateVersion: 1,
      gameMode: "HUMAN_VS_AI",
    });

    expect(snapshot.players[0]).toMatchObject({
      commandZone: ["Marchesa, the Black Rose"],
      libraryCount: 92,
      handCount: 7,
      graveyard: ["Dead Card"],
      exile: ["Exiled Card"],
    });
  });

  it("includes server-known land type for deterministic battlefield grouping", () => {
    const state = makeState();
    state.battlefields[1] = ["Dimir Aqueduct"];
    state.cardMetadata[1]["dimir aqueduct"] = {
      name: "Dimir Aqueduct",
      typeLine: "Land - Gate",
      isLand: true,
      isPermanent: true,
    };
    state.permanents = [[], [{
      id: "dimir-aqueduct",
      cardName: "Dimir Aqueduct",
      owner: 1,
      controller: 1,
      tapped: true,
    }], [], []];

    const snapshot = serializeForViewer(state, 0, 0, {
      sessionId: "land-category",
      stateVersion: 1,
      gameMode: "HUMAN_VS_AI",
    });

    expect(snapshot.players[1].battlefieldPermanents).toEqual([
      { name: "Dimir Aqueduct", tapped: true, isLand: true, typeLine: "Land - Gate" },
    ]);
  });

  it("treats a land type line as authoritative over a stale false land flag", () => {
    const state = makeState();
    state.battlefields[1] = ["Susur Secundi, Void Altar"];
    state.cardMetadata[1]["susur secundi, void altar"] = {
      name: "Susur Secundi, Void Altar",
      typeLine: "Land — Planet",
      isLand: false,
      isPermanent: true,
    };
    state.permanents = [[], [{
      id: "susur-secundi",
      cardName: "Susur Secundi, Void Altar",
      owner: 1,
      controller: 1,
      tapped: true,
    }], [], []];

    const snapshot = serializeForViewer(state, 0, 0, {
      sessionId: "susur-land-category",
      stateVersion: 1,
      gameMode: "HUMAN_VS_AI",
    });

    expect(snapshot.players[1].battlefieldPermanents).toEqual([
      { name: "Susur Secundi, Void Altar", tapped: true, isLand: true, typeLine: "Land — Planet" },
    ]);
  });

  it("serializes the selected MDFC face for land and creature image rendering", () => {
    const state = makeState();
    const metadata = {
      name: "Glasspool Mimic / Glasspool Shore",
      typeLine: "Creature — Shapeshifter Rogue // Land",
      manaCost: "{2}{U}",
      manaValue: 3,
      isLand: true,
    };
    state.cardMetadata[0][metadata.name.toLowerCase()] = metadata;
    state.battlefields[0] = ["Glasspool Shore"];
    state.permanents = [[
      {
        id: "glasspool-land",
        cardName: metadata.name,
        owner: 0,
        controller: 0,
        face: "Glasspool Shore",
        tapped: true,
      },
      {
        id: "glasspool-spell",
        cardName: metadata.name,
        owner: 0,
        controller: 0,
        face: "Glasspool Mimic",
        tapped: false,
      },
    ], [], [], []];
    state.creatures[0] = [{
      id: "glasspool-spell",
      name: "Glasspool Mimic",
      power: 0,
      toughness: 0,
      tapped: false,
      summoningSickness: true,
    }];

    const snapshot = serializeForViewer(state, 0, 0, {
      sessionId: "glasspool-selected-face",
      stateVersion: 1,
      gameMode: "HUMAN_VS_AI",
    });

    expect(snapshot.players[0].battlefieldPermanents).toEqual([
      {
        name: "Glasspool Shore",
        tapped: true,
        isLand: true,
        typeLine: "Land",
        imageName: "Glasspool Mimic / Glasspool Shore",
        imageFace: "back",
      },
    ]);
    expect(snapshot.players[0].creatures[0]).toMatchObject({
      name: "Glasspool Mimic",
      imageName: "Glasspool Mimic / Glasspool Shore",
      imageFace: "front",
    });
  });

  it("serializes Pinnacle Monk's selected Mystic Peak face as the back image", () => {
    const state = makeState();
    const physicalName = "Pinnacle Monk // Mystic Peak";
    state.cardMetadata[0][physicalName.toLowerCase()] = {
      name: physicalName,
      typeLine: "Creature — Human Monk // Land",
      manaCost: "{4}{R}",
      manaValue: 5,
    };
    state.battlefields[0] = ["Mystic Peak"];
    state.permanents = [[{
      id: "pinnacle-land",
      cardName: physicalName,
      owner: 0,
      controller: 0,
      face: "Mystic Peak",
      tapped: true,
    }], [], [], []];

    const snapshot = serializeForViewer(state, 0, 0, {
      sessionId: "pinnacle-mystic-peak",
      stateVersion: 1,
      gameMode: "HUMAN_VS_AI",
    });

    expect(snapshot.players[0].battlefieldPermanents).toEqual([{
      name: "Mystic Peak",
      tapped: true,
      isLand: true,
      typeLine: "Land",
      imageName: physicalName,
      imageFace: "back",
    }]);
  });

  it("maps HUMAN_VS_AI with P0 as the HumanAgent descriptor", () => {
    expect(buildPlayerDescriptors("HUMAN_VS_AI")).toEqual([
      { playerIndex: 0, seat: "NORTH", agentType: "HUMAN", displayName: "YOU" },
      { playerIndex: 1, seat: "EAST", agentType: "AI", displayName: "AI EAST" },
      { playerIndex: 2, seat: "SOUTH", agentType: "AI", displayName: "AI SOUTH" },
      { playerIndex: 3, seat: "WEST", agentType: "AI", displayName: "AI WEST" },
    ]);
  });

  it("maps ALL_AI with all four players as AI", () => {
    expect(buildPlayerDescriptors("ALL_AI")).toEqual([
      { playerIndex: 0, seat: "NORTH", agentType: "AI", displayName: "AI NORTH" },
      { playerIndex: 1, seat: "EAST", agentType: "AI", displayName: "AI EAST" },
      { playerIndex: 2, seat: "SOUTH", agentType: "AI", displayName: "AI SOUTH" },
      { playerIndex: 3, seat: "WEST", agentType: "AI", displayName: "AI WEST" },
    ]);
  });

  it("does not infer AI from seat NORTH in human mode", () => {
    const state = serializeForViewer(makeState(), 0, 3, {
      sessionId: "s1",
      stateVersion: 1,
      gameMode: "HUMAN_VS_AI",
    });

    expect(state.gameMode).toBe("HUMAN_VS_AI");
    expect(state.startingPlayerIndex).toBe(3);
    expect(state.players[0]).toMatchObject({
      index: 0,
      playerIndex: 0,
      seat: "NORTH",
      position: "NORTH",
      agentType: "HUMAN",
      displayName: "YOU",
      isHuman: true,
      hand: ["Malakir Rebirth"],
    });
  });

  it("serializes ALL_AI without any human player", () => {
    const state = serializeForViewer(makeState(), 0, 0, {
      sessionId: "ai1",
      stateVersion: 1,
      gameMode: "ALL_AI",
    });

    expect(state.players.every((player) => player.agentType === "AI" && !player.isHuman)).toBe(true);
    expect(state.players[0].displayName).toBe("AI NORTH");
  });

  it("logs the session mapping in a structured stable format", () => {
    expect(sessionMappingLog("HUMAN_VS_AI", buildPlayerDescriptors("HUMAN_VS_AI"))).toContain(
      "P0 seat=NORTH agent=HUMAN name=YOU"
    );
  });

  it.each([0, 1, 2, 3])("assigns seats deterministically from turn order when P%s starts", (startingPlayerIndex) => {
    const seats = assignSeatsByTurnOrder(
      buildSeatsFromControllers(["human", "human", "ai", "ai"]),
      startingPlayerIndex
    );
    const turnOrder = [0, 1, 2, 3].map((offset) => (startingPlayerIndex + offset) % 4);

    expect(seats.find((seat) => seat.playerIndex === turnOrder[0])).toMatchObject({ id: "northWest", position: "NORTH" });
    expect(seats.find((seat) => seat.playerIndex === turnOrder[1])).toMatchObject({ id: "northEast", position: "EAST" });
    expect(seats.find((seat) => seat.playerIndex === turnOrder[2])).toMatchObject({ id: "southEast", position: "SOUTH" });
    expect(seats.find((seat) => seat.playerIndex === turnOrder[3])).toMatchObject({ id: "southWest", position: "WEST" });
  });

  it("serializes player seats from the assigned turn order mapping", () => {
    const seats = assignSeatsByTurnOrder(
      buildSeatsFromControllers(["human", "ai", "ai", "ai"]),
      2
    );
    const state = serializeForViewer(makeState(), 0, 2, {
      sessionId: "s-turn-order",
      stateVersion: 1,
      gameMode: "HUMAN_VS_AI",
      seats,
    });

    expect(state.players.map((player) => [player.index, player.seat])).toEqual([
      [0, "SOUTH"],
      [1, "WEST"],
      [2, "NORTH"],
      [3, "EAST"],
    ]);
    expect(state.players.find((player) => player.seat === "NORTH")?.index).toBe(2);
  });

  it("does not send private hands to a normal game table recipient", () => {
    const seats = buildSeatsFromControllers(["human", "ai", "ai", "ai"]);
    const snapshot = serializeForRecipient(makeState(), 0, {
      sessionId: "s1",
      stateVersion: 7,
      mode: "game",
      recipient: { role: "table" },
      seats,
      gameMode: "HUMAN_VS_AI",
    });

    expect(snapshot.players.map((player) => player.hand)).toEqual([undefined, undefined, undefined, undefined]);
    expect(snapshot.players.map((player) => player.handCount)).toEqual([1, 1, 1, 1]);
    expect(snapshot.privatePlayer).toBeUndefined();
  });

  it("sends only the owning player's private hand to a game player recipient", () => {
    const seats = buildSeatsFromControllers(["human", "human", "ai", "ai"]);
    const snapshot = serializeForRecipient(makeState(), 0, {
      sessionId: "s1",
      stateVersion: 8,
      mode: "game",
      recipient: { role: "player", seatId: "northEast" },
      seats,
      gameMode: "HUMAN_VS_AI",
    });

    expect(snapshot.players[0].hand).toBeUndefined();
    expect(snapshot.players[1].hand).toEqual(["Island"]);
    expect(snapshot.players[2].hand).toBeUndefined();
    expect(snapshot.privatePlayer).toEqual({ playerId: "p1", hand: ["Island"] });
  });

  it.each([
    ["Human + AI + AI + AI", ["human", "ai", "ai", "ai"] as const, ["northWest"]],
    ["Human + Human + AI + AI", ["human", "human", "ai", "ai"] as const, ["northWest", "northEast"]],
    ["Human + Human + Human + AI", ["human", "human", "human", "ai"] as const, ["northWest", "northEast", "southEast"]],
    ["Human + Human + Human + Human", ["human", "human", "human", "human"] as const, ["northWest", "northEast", "southEast", "southWest"]],
  ])("enforces per-player private hand visibility for %s", (_label, controllers, humanSeatIds) => {
    const seats = buildSeatsFromControllers([...controllers]);
    const expectedHands = [["Malakir Rebirth"], ["Island"], ["Mountain"], ["Forest"]];

    for (const seatId of humanSeatIds as SeatId[]) {
      const seatIndex = seats.findIndex((seat) => seat.id === seatId);
      const snapshot = serializeForRecipient(makeState(), 0, {
        sessionId: "s1",
        stateVersion: 10,
        mode: "game",
        recipient: { role: "player", seatId },
        seats,
        gameMode: "HUMAN_VS_AI",
      });

      expect(snapshot.privatePlayer).toEqual({
        playerId: seats[seatIndex].playerId,
        hand: expectedHands[seatIndex],
      });
      expect(snapshot.players.map((player) => player.hand)).toEqual(
        expectedHands.map((hand, index) => index === seatIndex ? hand : undefined)
      );
    }
  });

  it("keeps table role public-only even in all-AI game mode with debug off", () => {
    const seats = buildSeatsFromControllers(["ai", "ai", "ai", "ai"]);
    const snapshot = serializeForRecipient(makeState(), 0, {
      sessionId: "ai-public",
      stateVersion: 11,
      mode: "game",
      recipient: { role: "table" },
      seats,
      gameMode: "ALL_AI",
    });

    expect(snapshot.capabilities.revealOpponentHands).toBe(false);
    expect(snapshot.players.every((player) => player.controller === "ai" && !player.isHuman)).toBe(true);
    expect(snapshot.players.map((player) => player.hand)).toEqual([undefined, undefined, undefined, undefined]);
    expect(snapshot.privatePlayer).toBeUndefined();
  });

  it("keeps debug recipients privileged for existing inspection workflows", () => {
    const seats = buildSeatsFromControllers(["ai", "ai", "ai", "ai"]);
    const snapshot = serializeForRecipient(makeState(), 0, {
      sessionId: "debug1",
      stateVersion: 9,
      mode: "debug",
      recipient: { role: "debug" },
      seats,
      gameMode: "ALL_AI",
    });

    expect(snapshot.capabilities.revealOpponentHands).toBe(true);
    expect(snapshot.players.map((player) => player.hand)).toEqual([
      ["Malakir Rebirth"],
      ["Island"],
      ["Mountain"],
      ["Forest"],
    ]);
  });
});
