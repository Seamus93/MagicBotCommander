import { describe, expect, it } from "vitest";
import type { AgentDecision, SimAction, SimAgent, SimGameState, StackEntry } from "@game-state/types";
import { simulateGame } from "../engine.js";
import { LearningAgent } from "../learningAgent.js";
import { PatternStore } from "../patterns.js";

class SimpleCasterAgent implements SimAgent {
  id = "caster";

  decideAction(_state: SimGameState, availableActions: SimAction[]): AgentDecision {
    return {
      action:
        availableActions.find((action) => action.type === "PLAY_LAND") ??
        availableActions.find((action) => action.type === "CAST_SPELL") ??
        { type: "PASS_TURN" },
    };
  }
}

class SimpleCounterAgent implements SimAgent {
  id = "counter";

  decideAction(_state: SimGameState, availableActions: SimAction[]): AgentDecision {
    return {
      action:
        availableActions.find((action) => action.type === "PLAY_LAND") ??
        { type: "PASS_TURN" },
    };
  }

  decideResponse(_state: SimGameState, _triggeringEntry: StackEntry, availableInstants: SimAction[]) {
    return availableInstants[0] ?? null;
  }
}

describe("counterspell behavior", () => {
  it("counters a spell on the stack instead of letting it resolve", async () => {
    const result = await simulateGame(
      [new SimpleCasterAgent(), new SimpleCounterAgent()],
      {
        maxTurns: 1,
        enableStack: true,
        startingPlayerIndex: 0,
        playerDecks: [
          [...Array(40).fill("Forest"), ...Array(40).fill("Shock")],
          [...Array(40).fill("Island"), ...Array(40).fill("Force Counter")],
        ],
        playerDeckMetadata: [
          [
            { name: "Forest", typeLine: "Basic Land - Forest", isLand: true, manaValue: 0 },
            { name: "Shock", typeLine: "Sorcery", manaValue: 1, oracleText: "Target opponent loses 2 life." },
          ],
          [
            { name: "Island", typeLine: "Basic Land - Island", isLand: true, manaValue: 0 },
            { name: "Force Counter", typeLine: "Instant", manaValue: 0, oracleText: "Counter target spell." },
          ],
        ],
      }
    );

    expect(result.finalState.lifeTotals[1]).toBe(40);
    expect(result.finalState.graveyards[0]).toContain("Shock");
    expect(result.finalState.graveyards[1]).toContain("Force Counter");
    expect(result.finalState.stack).toHaveLength(0);
  });

  it("passes in main phase to represent a counter instead of tapping out", async () => {
    const agent = new LearningAgent({
      id: "control",
      store: new PatternStore(),
      epsilon: 0,
      archetype: "CONTROL",
    });
    const state: SimGameState = {
      turn: 4,
      playerIndex: 0,
      lifeTotals: [40, 40],
      libraries: [["Counterspell"], []],
      hands: [["Divination"], []],
      battlefields: [["Island", "Island", "Island", "Island"], []],
      graveyards: [[], []],
      commanders: ["Commander", "Commander"],
      creatures: [[], []],
      artifacts: [[], []],
      artifactMana: [0, 0],
      manaSpent: [0, 0],
      cardMetadata: [
        {
          divination: { name: "Divination", typeLine: "Sorcery", manaValue: 3, oracleText: "Draw two cards." },
          counterspell: { name: "Counterspell", typeLine: "Instant", manaValue: 2, oracleText: "Counter target spell." },
          island: { name: "Island", typeLine: "Basic Land - Island", isLand: true, manaValue: 0 },
        },
        {},
      ],
      triggers: [],
      triggerCounter: 1,
      phase: "Prima Fase Principale",
      phaseStep: "Prima Fase Principale",
      costReducers: { 0: [], 1: [] },
      handSizeModifiers: { 0: [], 1: [] },
      drawHistory: { 0: 0, 1: 0 },
      stack: [],
    };

    const decision = await Promise.resolve(agent.decideAction(state, [
      { type: "CAST_SPELL", card: "Divination" },
      { type: "PASS_TURN" },
    ]));

    expect(decision.action.type).toBe("PASS_TURN");
  });

  it("still prefers playing a land before passing to hold up interaction", async () => {
    const agent = new LearningAgent({
      id: "control",
      store: new PatternStore(),
      epsilon: 0,
      archetype: "CONTROL",
    });
    const state: SimGameState = {
      turn: 3,
      playerIndex: 0,
      lifeTotals: [40, 40],
      libraries: [["Counterspell"], []],
      hands: [["Island"], []],
      battlefields: [["Island"], []],
      graveyards: [[], []],
      commanders: ["Commander", "Commander"],
      creatures: [[], []],
      artifacts: [[], []],
      artifactMana: [0, 0],
      manaSpent: [0, 0],
      cardMetadata: [
        {
          counterspell: { name: "Counterspell", typeLine: "Instant", manaValue: 2, oracleText: "Counter target spell." },
          island: { name: "Island", typeLine: "Basic Land - Island", isLand: true, manaValue: 0 },
        },
        {},
      ],
      triggers: [],
      triggerCounter: 1,
      phase: "Prima Fase Principale",
      phaseStep: "Prima Fase Principale",
      costReducers: { 0: [], 1: [] },
      handSizeModifiers: { 0: [], 1: [] },
      drawHistory: { 0: 0, 1: 0 },
      stack: [],
    };

    const decision = await Promise.resolve(agent.decideAction(state, [
      { type: "PLAY_LAND", card: "Island" },
      { type: "PASS_TURN" },
    ]));

    expect(decision.action.type).toBe("PLAY_LAND");
  });
});
