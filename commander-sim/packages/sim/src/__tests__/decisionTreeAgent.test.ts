import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SimAction, SimGameState } from "@game-state/types";
import { DecisionTreeAgent } from "../decisionTreeAgent.js";
import { PatternStore, actionToKey, patternFromFeatures } from "../patterns.js";
import { loadTrainedPolicyStore } from "../policyLoader.js";

class InspectableDecisionTreeAgent extends DecisionTreeAgent {
  scorePublic(state: SimGameState, actions: SimAction[]) {
    return this.scoreActions(state, actions);
  }

  pickPublic(scored: ReturnType<InspectableDecisionTreeAgent["scorePublic"]>) {
    return this.pickDeterministic(scored);
  }

  patternFor(state: SimGameState, action: SimAction) {
    return patternFromFeatures({
      ...this.extractFeatures(state),
      actionHash: this.hashAction(action),
    });
  }
}

function makeState(): SimGameState {
  const players = 4;
  const hand = ["Reliable Spell", "Flashy Spell", "Better Spell"];
  return {
    turn: 4,
    playerIndex: 0,
    lifeTotals: [40, 35, 33, 31],
    libraries: Array.from({ length: players }, () => []),
    hands: [hand, [], [], []],
    battlefields: [["Island", "Island", "Island"], [], [], []],
    graveyards: Array.from({ length: players }, () => []),
    commanders: Array(players).fill("Commander"),
    creatures: Array.from({ length: players }, () => []),
    artifacts: Array.from({ length: players }, () => []),
    artifactMana: Array(players).fill(0),
    manaSpent: Array(players).fill(0),
    cardMetadata: [
      {
        island: { name: "Island", typeLine: "Basic Land", isLand: true, isPermanent: true, manaValue: 0 },
        "reliable spell": { name: "Reliable Spell", typeLine: "Sorcery", manaValue: 2 },
        "flashy spell": { name: "Flashy Spell", typeLine: "Sorcery", manaValue: 2 },
        "better spell": { name: "Better Spell", typeLine: "Sorcery", manaValue: 2 },
      },
      {},
      {},
      {},
    ],
    triggers: [],
    triggerCounter: 1,
    phase: "Prima Fase Principale",
    phaseStep: "Prima Fase Principale",
    costReducers: Object.fromEntries(Array.from({ length: players }, (_, i) => [i, []])),
    handSizeModifiers: Object.fromEntries(Array.from({ length: players }, (_, i) => [i, []])),
    drawHistory: Object.fromEntries(Array.from({ length: players }, (_, i) => [i, 0])),
    stack: [],
  };
}

describe("DecisionTreeAgent confidence", () => {
  it("considera affidabile avgReward 0.15 con 500 visite", () => {
    const state = makeState();
    const action: SimAction = { type: "CAST_SPELL", card: "Reliable Spell" };
    const store = new PatternStore();
    const agent = new InspectableDecisionTreeAgent({
      id: "policy",
      store,
      epsilon: 0,
      confidenceThreshold: 0.8,
      minVisits: 5,
      confidenceK: 50,
    });
    const pattern = agent.patternFor(state, action);
    store.merge([{ pattern, actionKey: actionToKey("CAST_SPELL", "Reliable Spell"), score: 75, visits: 500 }]);

    const scored = agent.scorePublic(state, [action, { type: "PASS_TURN" }]);
    const picked = agent.pickPublic(scored);

    expect(picked?.action).toEqual(action);
    expect(picked?.expectedReward).toBeCloseTo(0.15);
    expect(picked?.confidence).toBeGreaterThan(0.8);
    expect(picked?.source).toBe("exact");
  });

  it("non considera affidabile avgReward 0.9 con 3 visite", () => {
    const state = makeState();
    const action: SimAction = { type: "CAST_SPELL", card: "Flashy Spell" };
    const store = new PatternStore();
    const agent = new InspectableDecisionTreeAgent({
      id: "policy",
      store,
      epsilon: 0,
      confidenceThreshold: 0.8,
      minVisits: 5,
      confidenceK: 50,
    });
    const pattern = agent.patternFor(state, action);
    store.merge([{ pattern, actionKey: actionToKey("CAST_SPELL", "Flashy Spell"), score: 2.7, visits: 3 }]);

    const scored = agent.scorePublic(state, [action, { type: "PASS_TURN" }]);

    expect(scored[0].expectedReward).toBeCloseTo(0.9);
    expect(scored[0].confidence).toBeLessThan(0.1);
    expect(agent.pickPublic(scored)).toBeNull();
  });

  it("sceglie tra due record affidabili per expectedReward, non per visite", () => {
    const state = makeState();
    const better: SimAction = { type: "CAST_SPELL", card: "Better Spell" };
    const reliable: SimAction = { type: "CAST_SPELL", card: "Reliable Spell" };
    const store = new PatternStore();
    const agent = new InspectableDecisionTreeAgent({
      id: "policy",
      store,
      epsilon: 0,
      confidenceThreshold: 0.8,
      minVisits: 5,
      confidenceK: 50,
    });
    store.merge([
      {
        pattern: agent.patternFor(state, better),
        actionKey: actionToKey("CAST_SPELL", "Better Spell"),
        score: 200,
        visits: 1000,
      },
      {
        pattern: agent.patternFor(state, reliable),
        actionKey: actionToKey("CAST_SPELL", "Reliable Spell"),
        score: 300,
        visits: 2000,
      },
    ]);

    const picked = agent.pickPublic(agent.scorePublic(state, [reliable, better]));

    expect(picked?.action).toEqual(better);
    expect(picked?.expectedReward).toBeCloseTo(0.2);
  });

  it("include target, mode e ability nella actionKey prodotta dall'agente", () => {
    const state = makeState();
    const targeted: SimAction = {
      type: "CAST_SPELL",
      card: "Reliable Spell",
      modes: ["destroy"],
      targets: [{ type: "permanent", id: "perm_12" }],
    };
    const ability: SimAction = {
      type: "ACTIVATE_ABILITY",
      sourcePermanentId: "perm_8",
      abilityId: "draw",
    };
    const agent = new InspectableDecisionTreeAgent({
      id: "policy",
      store: new PatternStore(),
      epsilon: 0,
      confidenceThreshold: 0.8,
      minVisits: 5,
      confidenceK: 50,
    });

    const scored = agent.scorePublic(state, [targeted, ability]);

    expect(scored[0].key).toBe("CAST_SPELL:Reliable Spell:mode=destroy:target=permanent_perm_12");
    expect(scored[1].key).toBe("ACTIVATE:perm_8:ability=draw");
  });
});

describe("live policy loading", () => {
  it("carica data/policy.json e il DecisionTreeAgent usa il record live", async () => {
    const state = makeState();
    const action: SimAction = { type: "CAST_SPELL", card: "Reliable Spell" };
    const bootstrapAgent = new InspectableDecisionTreeAgent({
      id: "bootstrap",
      store: new PatternStore(),
      epsilon: 0,
      confidenceK: 50,
    });
    const pattern = bootstrapAgent.patternFor(state, action);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mbc-policy-"));
    const policyPath = path.join(tmpDir, "policy.json");
    fs.writeFileSync(
      policyPath,
      JSON.stringify([
        { pattern, actionKey: actionToKey("CAST_SPELL", "Reliable Spell"), score: 90, visits: 600 },
      ]),
      "utf8"
    );

    const loaded = await loadTrainedPolicyStore({
      policyPath,
      preferDb: false,
      log: () => {},
    });
    const liveAgent = new InspectableDecisionTreeAgent({
      id: "live",
      store: loaded.store,
      epsilon: 0,
      confidenceThreshold: 0.8,
      minVisits: 5,
      confidenceK: 50,
    });

    const decision = await Promise.resolve(liveAgent.decideAction(state, [action, { type: "PASS_TURN" }]));

    expect(loaded.source).toBe("file");
    expect(decision.action).toEqual(action);
    expect(decision.metadata?.source).toBe("exact");
    expect(decision.metadata?.expectedReward).toBeCloseTo(0.15);
  });
});
