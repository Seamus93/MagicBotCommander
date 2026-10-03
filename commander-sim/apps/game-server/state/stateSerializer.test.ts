import { describe, expect, it } from "vitest";
import type { SimGameState } from "@game-state/types";
import {
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
