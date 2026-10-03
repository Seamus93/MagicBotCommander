import { describe, expect, it } from "vitest";
import type { SimGameState } from "@game-state/types";
import { HumanAgent } from "./HumanAgent";

function makeState(playerIndex: number): SimGameState {
  return {
    turn: 0,
    playerIndex,
    lifeTotals: [40, 40, 40, 40],
    libraries: [[], [], [], []],
    hands: [["Island"], [], [], []],
    battlefields: [[], [], [], []],
    graveyards: [[], [], [], []],
    commanders: ["Commander", "Commander", "Commander", "Commander"],
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

describe("HumanAgent mulligan ownership", () => {
  it("emits the human player index with the mulligan waiting context", async () => {
    let observed: { playerIndex?: number; statePlayerIndex?: number } | null = null;
    const agent = new HumanAgent("session-1", (_type, ctx, state) => {
      observed = { playerIndex: ctx.playerIndex, statePlayerIndex: state?.playerIndex };
      agent.submitDecision({ keep: true });
    });

    await expect(agent.decideMulligan(["Island"], 0, makeState(0))).resolves.toEqual({ keep: true });
    expect(observed).toEqual({ playerIndex: 0, statePlayerIndex: 0 });
  });
});
