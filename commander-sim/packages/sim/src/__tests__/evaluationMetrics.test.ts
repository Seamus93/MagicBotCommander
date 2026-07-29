import { describe, expect, it } from "vitest";
import type { SimGameState, SimulationResult } from "@game-state/types";
import {
  addSimulationToAggregate,
  createEvaluationAggregate,
  finalizeEvaluation,
  formatEvaluationReport,
} from "../evaluationMetrics.js";

function makeState(overrides: Partial<SimGameState> = {}): SimGameState {
  const players = 2;
  return {
    turn: 2,
    playerIndex: 0,
    lifeTotals: [40, 40],
    libraries: Array.from({ length: players }, () => []),
    hands: [["Forest"], []],
    battlefields: [["Forest"], []],
    graveyards: Array.from({ length: players }, () => []),
    commanders: Array(players).fill("Commander"),
    creatures: Array.from({ length: players }, () => []),
    artifacts: Array.from({ length: players }, () => []),
    artifactMana: Array(players).fill(0),
    manaSpent: Array(players).fill(0),
    cardMetadata: [
      {
        forest: {
          name: "Forest",
          typeLine: "Basic Land - Forest",
          isLand: true,
          isPermanent: true,
          manaValue: 0,
        },
      },
      {},
    ],
    triggers: [],
    triggerCounter: 1,
    phase: "Seconda Fase Principale",
    phaseStep: "Seconda Fase Principale",
    costReducers: { 0: [], 1: [] },
    handSizeModifiers: { 0: [], 1: [] },
    drawHistory: { 0: 0, 1: 0 },
    stack: [],
    ...overrides,
  };
}

describe("evaluation metrics", () => {
  it("raccoglie source, land drop rate e anomalie concrete", () => {
    const state = makeState();
    const nextState = makeState({
      lifeTotals: [40, 38],
      hands: [["Forest"], []],
    });
    const result: SimulationResult = {
      winnerIndex: 0,
      turns: 2,
      finalState: nextState,
      metrics: { missedLandDropOpportunity: 1 },
      history: [
        {
          playerIndex: 0,
          agentId: "agent",
          action: { type: "PASS_TURN" },
          state,
          availableActions: [{ type: "PASS_TURN" }, { type: "PLAY_LAND", card: "Forest" }],
          metadata: {
            source: "exact",
            expectedReward: 0.4,
            confidence: 0.95,
            visits: 3,
          },
          shapedReward: -0.2,
        },
      ],
    };
    const aggregate = createEvaluationAggregate("test", 2);

    addSimulationToAggregate(aggregate, result, 0);
    const finalized = finalizeEvaluation(aggregate);

    expect(finalized.missedLandDropOpportunity).toBe(1);
    expect(finalized.exactPolicyHitRate).toBe(1);
    expect(finalized.passTurnMain2Rate).toBe(1);
    expect(finalized.landDropRateByTurn[2]).toBe(0);
    expect(finalized.topAnomalies.map((entry) => entry.type)).toContain("main2_pass_with_legal_land");
    expect(finalized.topAnomalies.map((entry) => entry.type)).toContain("high_confidence_low_visits");
    expect(finalized.warnings.some((warning) => warning.includes("missedLandDropOpportunity"))).toBe(true);
  });

  it("formatta un report A/B leggibile", () => {
    const aggregate = createEvaluationAggregate("same", 2);
    const finalized = finalizeEvaluation(aggregate);
    const report = formatEvaluationReport(finalized, finalized);

    expect(report).toContain("# MagicBotCommander A/B Evaluation");
    expect(report).toContain("## Top 3 Recommended ROI Changes");
  });
});
