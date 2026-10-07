import { describe, expect, it } from "vitest";
import type { AgentDecision, AiActionEvaluationTrace, AiDecisionTrace, SimAction, SimAgent, SimGameState } from "@game-state/types";
import { simulateGame } from "../engine.js";

class FixedActionAgent implements SimAgent {
  constructor(public readonly id: string, private readonly action: SimAction) {}

  decideAction(): AgentDecision {
    return { action: this.action, metadata: { source: "fallback" } };
  }
}

class FixedScoredActionAgent extends FixedActionAgent {
  traceActionScores(_state: SimGameState, availableActions: SimAction[]): AiActionEvaluationTrace[] {
    return availableActions.map((action) => ({
      action,
      finalScore: action.type === "CAST_SPELL" ? 0.25 : -0.1,
    }));
  }
}

const freeArtifact = {
  name: "Free Artifact",
  typeLine: "Artifact",
  manaCost: "{0}",
  oracleText: "",
  manaValue: 0,
  isArtifact: true,
  isPermanent: true,
};

const fillerDeck = Array(20).fill("Free Artifact");
const metadata = [freeArtifact];

const pinnacleMdfc = {
  name: "Pinnacle Monk // Mystic Peak",
  typeLine: "Creature - Human Monk // Land",
  manaCost: "{4}{R}",
  oracleText: "Prowess\nMystic Peak enters tapped.\n{T}: Add {R}.",
  manaValue: 5,
  isCreature: true,
  isLand: true,
  isPermanent: true,
  spellFace: {
    name: "Pinnacle Monk",
    typeLine: "Creature - Human Monk",
    manaCost: "{4}{R}",
    oracleText: "Prowess",
    manaValue: 5,
    isCreature: true,
    isPermanent: true,
  },
  landFace: {
    name: "Mystic Peak",
    typeLine: "Land",
    oracleText: "{T}: Add {R}.",
    manaValue: 0,
    isLand: true,
    isPermanent: true,
    producesMana: true,
    manaProduction: 1,
  },
  aliases: ["Pinnacle Monk", "Mystic Peak"],
};

describe("AI decision traces", () => {
  it("marks PASS as questionable when a non-pass legal action exists", async () => {
    const traces: AiDecisionTrace[] = [];
    const logMessages: string[] = [];

    await simulateGame(
      [
        new FixedActionAgent("passer-0", { type: "PASS_TURN" }),
        new FixedActionAgent("passer-1", { type: "PASS_TURN" }),
      ],
      {
        maxTurns: 1,
        playerDecks: [fillerDeck, fillerDeck],
        playerDeckMetadata: [metadata, metadata],
        phaseDelayMs: 0,
        actionDelayMs: 0,
        log: (message) => logMessages.push(message),
        onAiDecisionTrace: (trace) => traces.push(trace),
      }
    );

    const questionable = traces.find((trace) => trace.questionable);
    expect(questionable).toBeTruthy();
    expect(questionable?.decision.chosenAction).toMatchObject({ type: "PASS_TURN" });
    expect(questionable?.legalActions.some((action) => action.type === "CAST_SPELL")).toBe(true);
    expect(questionable?.execution).toMatchObject({ success: true });
    expect(logMessages).toContain("[Turn] T1 P0");
    expect(logMessages).toContain("[Action] PASS_TURN");
  });

  it("keeps decision separate from failed execution fallback", async () => {
    const traces: AiDecisionTrace[] = [];

    await simulateGame(
      [
        new FixedActionAgent("illegal-0", { type: "CAST_SPELL", card: "Missing Spell" }),
        new FixedActionAgent("passer-1", { type: "PASS_TURN" }),
      ],
      {
        maxTurns: 1,
        playerDecks: [fillerDeck, fillerDeck],
        playerDeckMetadata: [metadata, metadata],
        phaseDelayMs: 0,
        actionDelayMs: 0,
        log: () => {},
        onAiDecisionTrace: (trace) => traces.push(trace),
      }
    );

    const failed = traces.find((trace) => !trace.execution.success);
    expect(failed).toBeTruthy();
    expect(failed?.decision.chosenAction).toMatchObject({
      type: "CAST_SPELL",
      card: "Missing Spell",
    });
    expect(failed?.execution).toMatchObject({
      success: false,
      fallbackAction: { type: "PASS_TURN" },
    });
  });

  it("reports when the chosen action differs from the final-score argmax", async () => {
    const traces: AiDecisionTrace[] = [];

    await simulateGame(
      [
        new FixedScoredActionAgent("scored-pass-0", { type: "PASS_TURN" }),
        new FixedActionAgent("passer-1", { type: "PASS_TURN" }),
      ],
      {
        maxTurns: 1,
        playerDecks: [fillerDeck, fillerDeck],
        playerDeckMetadata: [metadata, metadata],
        phaseDelayMs: 0,
        actionDelayMs: 0,
        log: () => {},
        onAiDecisionTrace: (trace) => traces.push(trace),
      }
    );

    const mismatch = traces.find((trace) => trace.decision.decisionScoreMismatch);
    expect(mismatch).toBeTruthy();
    expect(mismatch?.decision).toMatchObject({
      chosenAction: { type: "PASS_TURN" },
      argmaxAction: { type: "CAST_SPELL", card: "Free Artifact" },
      argmaxFinalScore: 0.25,
      chosenActionFinalScore: -0.1,
      isFinalScoreArgmax: false,
      decisionScoreMismatch: true,
    });
    expect(mismatch?.evaluation.find((entry) => entry.finalScore === 0.25)?.scoreRank).toBe(1);
    expect(mismatch?.decision.selectionCandidates.length).toBeGreaterThan(1);
  });

  it("traces activated costs separately from genuine casting costs", async () => {
    const knave = {
      name: "Ruthless Knave",
      typeLine: "Creature - Human Pirate",
      manaCost: "{0}",
      manaValue: 0,
      isCreature: true,
      isPermanent: true,
      oracleText: "{1}, Sacrifice a creature: Draw a card.",
    };
    const knaveTraces: AiDecisionTrace[] = [];
    await simulateGame(
      [
        new FixedActionAgent("passer-0", { type: "PASS_TURN" }),
        new FixedActionAgent("passer-1", { type: "PASS_TURN" }),
      ],
      {
        maxTurns: 1,
        startingPlayerIndex: 0,
        playerDecks: [Array(20).fill("Ruthless Knave"), fillerDeck],
        playerDeckMetadata: [[knave], metadata],
        phaseDelayMs: 0,
        actionDelayMs: 0,
        log: () => {},
        onAiDecisionTrace: (trace) => knaveTraces.push(trace),
      }
    );
    const knaveCast = knaveTraces
      .flatMap((trace) => trace.consideredActions)
      .find((action) => action.type === "CAST_SPELL" && action.cardName === "Ruthless Knave");
    expect(knaveCast).toMatchObject({
      legal: true,
      additionalCostsRequiredDuringCast: false,
      additionalCostsPayable: true,
      spellAdditionalCosts: [],
      spellRequiresTargetsDuringCast: false,
      targetRequirements: [],
      validTargets: [],
      stackSize: 0,
      stackObjects: [],
      validStackTargets: [],
    });
    expect(knaveCast?.activatedAbilityCosts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "SACRIFICE" }),
    ]));

    const bargain = {
      name: "Reckoner's Bargain",
      typeLine: "Instant",
      manaCost: "{0}",
      manaValue: 0,
      isInstant: true,
      oracleText: "As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.",
    };
    const bargainTraces: AiDecisionTrace[] = [];
    await simulateGame(
      [
        new FixedActionAgent("human", { type: "PASS_TURN" }),
        new FixedActionAgent("passer-1", { type: "PASS_TURN" }),
      ],
      {
        maxTurns: 1,
        startingPlayerIndex: 0,
        playerDecks: [Array(20).fill("Reckoner's Bargain"), fillerDeck],
        playerDeckMetadata: [[bargain], metadata],
        phaseDelayMs: 0,
        actionDelayMs: 0,
        log: () => {},
        onAiDecisionTrace: (trace) => bargainTraces.push(trace),
      }
    );
    const bargainCast = bargainTraces
      .flatMap((trace) => trace.consideredActions)
      .find((action) => action.type === "CAST_SPELL" && action.cardName === "Reckoner's Bargain");
    expect(bargainCast).toMatchObject({
      legal: false,
      additionalCostsRequiredDuringCast: true,
      additionalCostsPayable: false,
      spellAdditionalCosts: [{ type: "SACRIFICE" }],
      activatedAbilityCosts: [],
      rejectionReason: "ADDITIONAL_COST_UNPAYABLE",
    });
    expect(bargainCast?.unpayableAdditionalCostReason).toContain("sacrificing 1 creature");
  });

  it("hydrates stripped MDFC decisions with selected face trace data", async () => {
    const traces: AiDecisionTrace[] = [];
    const deck = Array(20).fill("Pinnacle Monk // Mystic Peak");

    await simulateGame(
      [
        new FixedActionAgent("mdfc-0", { type: "PLAY_LAND", card: "Pinnacle Monk // Mystic Peak" }),
        new FixedActionAgent("passer-1", { type: "PASS_TURN" }),
      ],
      {
        maxTurns: 1,
        maxMulligans: 0,
        playerDecks: [deck, fillerDeck],
        playerDeckMetadata: [[pinnacleMdfc], metadata],
        phaseDelayMs: 0,
        actionDelayMs: 0,
        log: () => {},
        onAiDecisionTrace: (trace) => traces.push(trace),
      }
    );

    const landTrace = traces.find((trace) => trace.decision.chosenAction.type === "PLAY_LAND");
    expect(landTrace?.consideredActions).toContainEqual(expect.objectContaining({
      type: "PLAY_LAND",
      physicalCard: "Pinnacle Monk // Mystic Peak",
      selectedFaceId: "Mystic Peak",
      selectedFaceName: "Mystic Peak",
      selectedFaceTypeLine: "Land",
      recognized: true,
      legal: true,
    }));
    expect(landTrace?.legalActions).toContainEqual(expect.objectContaining({
      type: "PLAY_LAND",
      card: "Pinnacle Monk // Mystic Peak",
      selectedFaceId: "Mystic Peak",
      selectedFaceName: "Mystic Peak",
      selectedFaceTypeLine: "Land",
    }));
    expect(landTrace?.decision.chosenAction).toMatchObject({
      type: "PLAY_LAND",
      card: "Pinnacle Monk // Mystic Peak",
      selectedFaceId: "Mystic Peak",
      selectedFaceName: "Mystic Peak",
      selectedFaceTypeLine: "Land",
    });
    expect(landTrace?.execution.attemptedAction).toMatchObject({
      type: "PLAY_LAND",
      card: "Pinnacle Monk // Mystic Peak",
      selectedFaceId: "Mystic Peak",
      selectedFaceName: "Mystic Peak",
      selectedFaceTypeLine: "Land",
    });
  });
});
