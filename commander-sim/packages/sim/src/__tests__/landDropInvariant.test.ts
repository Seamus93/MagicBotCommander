import { describe, expect, it } from "vitest";
import type {
  AgentDecision,
  CardName,
  DeckCardMetadata,
  SimAction,
  SimAgent,
  SimGameState,
} from "@game-state/types";
import { simulateGame } from "../engine.js";
import { DecisionTreeAgent } from "../decisionTreeAgent.js";
import { PatternStore, actionToKey, patternFromFeatures } from "../patterns.js";

class LandFirstAgent implements SimAgent {
  constructor(public readonly id: string) {}

  decideAction(_state: SimGameState, availableActions: SimAction[]): AgentDecision {
    return {
      action:
        availableActions.find((action) => action.type === "PLAY_LAND") ??
        { type: "PASS_TURN" },
    };
  }

  decideMulligan(): { keep: boolean } {
    return { keep: true };
  }
}

class AlwaysPassAgent implements SimAgent {
  constructor(public readonly id: string) {}

  decideAction(_state: SimGameState, _availableActions: SimAction[]): AgentDecision {
    return { action: { type: "PASS_TURN" } };
  }

  decideMulligan(): { keep: boolean } {
    return { keep: true };
  }
}

class ActivateBeforeLandAgent implements SimAgent {
  constructor(public readonly id: string) {}

  decideAction(state: SimGameState, availableActions: SimAction[]): AgentDecision {
    if (state.phaseStep === "Seconda Fase Principale") {
      return {
        action:
          availableActions.find((action) => action.type === "ACTIVATE_ABILITY") ??
          availableActions.find((action) => action.type === "PLAY_LAND") ??
          { type: "PASS_TURN" },
      };
    }
    return { action: { type: "PASS_TURN" } };
  }

  decideMulligan(): { keep: boolean } {
    return { keep: true };
  }
}

class InspectableDecisionTreeAgent extends DecisionTreeAgent {
  patternFor(state: SimGameState, action: SimAction) {
    return patternFromFeatures({
      ...this.extractFeatures(state),
      actionHash: this.hashAction(action),
    });
  }

  override decideMulligan(): { keep: boolean } {
    return { keep: true };
  }
}

const landMeta = (name: string): DeckCardMetadata => ({
  name,
  typeLine: `Basic Land - ${name}`,
  isLand: true,
  isPermanent: true,
  manaValue: 0,
});

const spellMeta = (name: string, manaValue = 3): DeckCardMetadata => ({
  name,
  typeLine: "Sorcery",
  manaValue,
  oracleText: "Draw a card.",
});

const utilityLandMeta = (name: string): DeckCardMetadata => ({
  name,
  typeLine: "Land",
  isLand: true,
  isPermanent: true,
  oracleText: "{T}: Draw a card.",
});

const deck = (card: CardName): CardName[] => Array(40).fill(card);

const playableLandDecks = [deck("Plains"), deck("Island")];
const playableLandMetadata = [[landMeta("Plains")], [landMeta("Island")]];

function playerHistory(result: Awaited<ReturnType<typeof simulateGame>>, player = 0) {
  return result.history.filter((entry) => entry.playerIndex === player);
}

function landPlays(result: Awaited<ReturnType<typeof simulateGame>>, player = 0) {
  return playerHistory(result, player).filter((entry) => entry.action.type === "PLAY_LAND");
}

function makePolicyState(phase: "Prima Fase Principale" | "Seconda Fase Principale"): SimGameState {
  const players = 2;
  return {
    turn: 1,
    playerIndex: 0,
    lifeTotals: Array(players).fill(40),
    libraries: [Array(33).fill("Plains"), Array(33).fill("Island")],
    hands: [Array(7).fill("Plains"), Array(7).fill("Island")],
    battlefields: Array.from({ length: players }, () => []),
    graveyards: Array.from({ length: players }, () => []),
    commanders: Array(players).fill("Commander"),
    creatures: Array.from({ length: players }, () => []),
    artifacts: Array.from({ length: players }, () => []),
    artifactMana: Array(players).fill(0),
    manaSpent: Array(players).fill(0),
    cardMetadata: playableLandMetadata.map((items) =>
      Object.fromEntries(items.map((item) => [item.name.toLowerCase(), item]))
    ),
    triggers: [],
    triggerCounter: 1,
    phase,
    phaseStep: phase,
    costReducers: Object.fromEntries(Array.from({ length: players }, (_, idx) => [idx, []])),
    handSizeModifiers: Object.fromEntries(Array.from({ length: players }, (_, idx) => [idx, []])),
    drawHistory: Object.fromEntries(Array.from({ length: players }, (_, idx) => [idx, 0])),
    stack: [],
  };
}

describe("land drop strategic invariant", () => {
  it("A: permette il land drop normale in Main 1", async () => {
    const result = await simulateGame(
      [new LandFirstAgent("p0"), new LandFirstAgent("p1")],
      {
        maxTurns: 1,
        maxMulligans: 0,
        startingPlayerIndex: 0,
        playerDecks: playableLandDecks,
        playerDeckMetadata: playableLandMetadata,
      }
    );

    const p0LandPlays = landPlays(result);
    expect(p0LandPlays).toHaveLength(1);
    expect(p0LandPlays[0].state.phaseStep).toBe("Prima Fase Principale");
    expect(result.metrics?.missedLandDropOpportunity).toBe(0);
  });

  it("B: forza il land drop in Main 2 se Main 1 e stata saltata", async () => {
    const result = await simulateGame(
      [new AlwaysPassAgent("p0"), new AlwaysPassAgent("p1")],
      {
        maxTurns: 1,
        maxMulligans: 0,
        startingPlayerIndex: 0,
        playerDecks: playableLandDecks,
        playerDeckMetadata: playableLandMetadata,
      }
    );

    const p0LandPlays = landPlays(result);
    expect(p0LandPlays).toHaveLength(1);
    expect(p0LandPlays[0].state.phaseStep).toBe("Seconda Fase Principale");
    expect(p0LandPlays[0].metadata?.reasoning).toBe("strategic_land_drop_invariant");
    expect(result.metrics?.missedLandDropOpportunity).toBe(0);
  });

  it("C: fa land drop anche senza spell giocabili o bisogno immediato di mana", async () => {
    const result = await simulateGame(
      [new AlwaysPassAgent("p0"), new AlwaysPassAgent("p1")],
      {
        maxTurns: 1,
        maxMulligans: 0,
        startingPlayerIndex: 0,
        playerDecks: playableLandDecks,
        playerDeckMetadata: playableLandMetadata,
      }
    );

    expect(landPlays(result)).toHaveLength(1);
    expect(result.metrics?.missedLandDropOpportunity).toBe(0);
  });

  it("D: la policy che preferisce PASS_TURN non puo chiudere Main 2 con terra legale", async () => {
    const store = new PatternStore();
    const policyAgent = new InspectableDecisionTreeAgent({
      id: "policy-pass",
      store,
      epsilon: 0,
      confidenceThreshold: 0.8,
      minVisits: 5,
      confidenceK: 50,
    });
    const pass: SimAction = { type: "PASS_TURN" };
    const main1Pattern = policyAgent.patternFor(makePolicyState("Prima Fase Principale"), pass);
    const main2Pattern = policyAgent.patternFor(makePolicyState("Seconda Fase Principale"), pass);
    store.merge([
      { pattern: main1Pattern, actionKey: actionToKey("PASS_TURN", ""), score: 900, visits: 900 },
      { pattern: main2Pattern, actionKey: actionToKey("PASS_TURN", ""), score: 900, visits: 900 },
    ]);

    const result = await simulateGame(
      [policyAgent, new AlwaysPassAgent("p1")],
      {
        maxTurns: 1,
        maxMulligans: 0,
        startingPlayerIndex: 0,
        playerDecks: playableLandDecks,
        playerDeckMetadata: playableLandMetadata,
      }
    );

    const p0LandPlays = landPlays(result);
    expect(p0LandPlays).toHaveLength(1);
    expect(p0LandPlays[0].state.phaseStep).toBe("Seconda Fase Principale");
    expect(p0LandPlays[0].metadata?.reasoning).toBe("strategic_land_drop_invariant");
    expect(result.metrics?.missedLandDropOpportunity).toBe(0);
  });

  it("E: lascia consentito PASS_TURN quando non esiste una PLAY_LAND legale", async () => {
    const spellDecks = [deck("Divination"), deck("Divination")];
    const metadata = [[spellMeta("Divination", 3)], [spellMeta("Divination", 3)]];

    const result = await simulateGame(
      [new AlwaysPassAgent("human"), new AlwaysPassAgent("p1")],
      {
        maxTurns: 1,
        maxMulligans: 0,
        startingPlayerIndex: 0,
        playerDecks: spellDecks,
        playerDeckMetadata: metadata,
      }
    );

    expect(landPlays(result)).toHaveLength(0);
    expect(playerHistory(result).some((entry) => entry.action.type === "PASS_TURN")).toBe(true);
    expect(result.metrics?.missedLandDropOpportunity).toBe(0);
  });

  it("F: non forza una seconda terra dopo il land drop di turno", async () => {
    const result = await simulateGame(
      [new LandFirstAgent("p0"), new LandFirstAgent("p1")],
      {
        maxTurns: 1,
        maxMulligans: 0,
        startingPlayerIndex: 0,
        playerDecks: playableLandDecks,
        playerDeckMetadata: playableLandMetadata,
      }
    );

    expect(landPlays(result)).toHaveLength(1);
    expect(result.metrics?.missedLandDropOpportunity).toBe(0);
  });

  it("G: supporta piu land drop fino a maxLandDrops quando sono legalmente disponibili", async () => {
    const result = await simulateGame(
      [new AlwaysPassAgent("p0"), new AlwaysPassAgent("p1")],
      {
        maxTurns: 1,
        maxMulligans: 0,
        maxLandDrops: 2,
        startingPlayerIndex: 0,
        playerDecks: playableLandDecks,
        playerDeckMetadata: playableLandMetadata,
      }
    );

    const p0LandPlays = landPlays(result);
    expect(p0LandPlays).toHaveLength(2);
    expect(p0LandPlays.every((entry) => entry.state.phaseStep === "Seconda Fase Principale")).toBe(true);
    expect(result.metrics?.missedLandDropOpportunity).toBe(0);
  });

  it("H: forza il land drop anche dopo molte activated abilities in Main 2", async () => {
    const utilityDeck = deck("Utility Draw Land");
    const metadata = [[utilityLandMeta("Utility Draw Land")], [landMeta("Island")]];

    const result = await simulateGame(
      [new ActivateBeforeLandAgent("activator"), new AlwaysPassAgent("p1")],
      {
        maxTurns: 6,
        maxMulligans: 0,
        startingPlayerIndex: 0,
        playerDecks: [utilityDeck, playableLandDecks[1]],
        playerDeckMetadata: metadata,
      }
    );

    expect(result.metrics?.missedLandDropOpportunity).toBe(0);
    expect(playerHistory(result).some((entry) => entry.action.type === "ACTIVATE_ABILITY")).toBe(true);
    expect(playerHistory(result).some((entry) => entry.action.type === "PLAY_LAND")).toBe(true);
  });
});
