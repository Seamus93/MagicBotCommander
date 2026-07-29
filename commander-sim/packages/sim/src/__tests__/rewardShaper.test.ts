import { describe, it, expect, beforeEach } from "vitest";
import {
  captureSnapshot,
  shapeReward,
  discountRewards,
  type StateSnapshot,
} from "../rewardShaper.js";
import type { SimGameState } from "@game-state/types";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeState(overrides: Partial<{
  lifeTotals: number[];
  creatures: { id: string; name: string; power: number; toughness: number; tapped: boolean; summoningSickness: boolean; }[][];
  battlefields: string[][];
  hands: string[][];
}>): SimGameState {
  const players = 4;
  return {
    turn: 1,
    playerIndex: 0,
    lifeTotals: overrides.lifeTotals ?? Array(players).fill(40),
    libraries: Array(players).fill([]),
    hands: overrides.hands ?? Array(players).fill([]),
    battlefields: overrides.battlefields ?? Array(players).fill([]),
    graveyards: Array(players).fill([]),
    commanders: Array(players).fill("Commander"),
    creatures: overrides.creatures ?? Array(players).fill([]),
    artifacts: Array(players).fill([]),
    artifactMana: Array(players).fill(0),
    manaSpent: Array(players).fill(0),
    cardMetadata: Array(players).fill({}),
    triggers: [],
    triggerCounter: 1,
    phase: "Prima Fase Principale",
    phaseStep: "Prima Fase Principale",
    costReducers: Object.fromEntries(Array.from({ length: players }, (_, i) => [i, []])),
    handSizeModifiers: Object.fromEntries(Array.from({ length: players }, (_, i) => [i, []])),
    drawHistory: Object.fromEntries(Array.from({ length: players }, (_, i) => [i, 0])),
    stack: [],
  } as unknown as SimGameState;
}

function makeSnap(overrides: Partial<StateSnapshot>): StateSnapshot {
  return {
    lifeTotals: [40, 40, 40, 40],
    creatureCounts: [0, 0, 0, 0],
    creaturePower: [0, 0, 0, 0],
    permanentCounts: [0, 0, 0, 0],
    landCounts: [0, 0, 0, 0],
    handSizes: [7, 7, 7, 7],
    graveyardSizes: [0, 0, 0, 0],
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// captureSnapshot
// ──────────────────────────────────────────────
describe("captureSnapshot", () => {
  it("estrae i valori corretti dallo stato", () => {
    const state = makeState({
      lifeTotals: [40, 30, 20, 10],
      hands: [["Forest", "Burn Spell"], [], [], []],
      battlefields: [["Forest", "Forest"], [], [], []],
    });
    const snap = captureSnapshot(state);
    expect(snap.lifeTotals).toEqual([40, 30, 20, 10]);
    expect(snap.handSizes).toEqual([2, 0, 0, 0]);
    expect(snap.landCounts[0]).toBe(2); // due Forest riconosciuti come land
  });

  it("conta correttamente le creature", () => {
    const creatures = [
      [{ id: "c1", name: "Bear", power: 2, toughness: 2, tapped: false, summoningSickness: false }],
      [],
      [
        { id: "c2", name: "Dragon", power: 5, toughness: 5, tapped: false, summoningSickness: false },
        { id: "c3", name: "Soldier", power: 1, toughness: 1, tapped: false, summoningSickness: false },
      ],
      [],
    ];
    const state = makeState({ creatures });
    const snap = captureSnapshot(state);
    expect(snap.creatureCounts).toEqual([1, 0, 2, 0]);
  });
});

// ──────────────────────────────────────────────
// shapeReward
// ──────────────────────────────────────────────
describe("shapeReward", () => {
  beforeEach(() => {
    // assicura che REWARD_SHAPING sia abilitato (default true)
    process.env.REWARD_SHAPING = "true";
  });

  it("+0.15 quando un avversario viene eliminato", () => {
    const prev = makeSnap({ lifeTotals: [40, 40, 40, 40] });
    const next = makeSnap({ lifeTotals: [40, 0, 40, 40] });
    const r = shapeReward(prev, { type: "CAST_SPELL", card: "Burn Spell" }, next, 0);
    expect(r).toBeGreaterThan(0.4);
  });

  it("premia eliminazione e danno, senza richiedere creature kill", () => {
    const prev = makeSnap({ lifeTotals: [40, 40, 40, 40], creatureCounts: [0, 0, 0, 0] });
    const next = makeSnap({ lifeTotals: [40, 0, 40, 40], creatureCounts: [0, 0, 0, 0] });
    const r = shapeReward(prev, { type: "CAST_SPELL", card: "Burn" }, next, 0);
    expect(r).toBeCloseTo(0.43);
  });

  it("+0.05 per land drop on-curve (aveva spell in mano)", () => {
    const prev = makeSnap({ handSizes: [3, 7, 7, 7] }); // 3 carte: una terra + 2 spell
    const next = makeSnap({ handSizes: [2, 7, 7, 7] });
    const r = shapeReward(prev, { type: "PLAY_LAND", card: "Forest" }, next, 0);
    expect(r).toBeGreaterThan(0.03);
  });

  it("no bonus land drop se aveva solo la terra in mano", () => {
    const prev = makeSnap({ handSizes: [1, 7, 7, 7] });
    const next = makeSnap({ handSizes: [0, 7, 7, 7] });
    const r = shapeReward(prev, { type: "PLAY_LAND", card: "Forest" }, next, 0);
    expect(r).toBeLessThanOrEqual(0);
  });

  it("+0.02 per removal che riduce board avversario", () => {
    const prev = makeSnap({ creatureCounts: [2, 3, 2, 1] });
    const next = makeSnap({ creatureCounts: [2, 2, 2, 1] }); // opponent 1 perde 1 creatura
    const r = shapeReward(prev, { type: "CAST_SPELL", card: "Destroy Spell" }, next, 0);
    expect(r).toBeGreaterThanOrEqual(0.03);
  });

  it("-0.03 per bad trade (perdi creature senza kill avversario)", () => {
    const prev = makeSnap({ creatureCounts: [2, 2, 1, 1] });
    const next = makeSnap({ creatureCounts: [1, 2, 1, 1] }); // perdiamo 1, avversari invariati
    const r = shapeReward(prev, { type: "DECLARE_ATTACKERS", player: 0, attackers: ["c1"] } as any, next, 0);
    expect(r).toBeLessThan(-0.02);
  });

  it("-0.01 per mana waste (PASS_TURN con carte in mano e terre)", () => {
    const prev = makeSnap({ handSizes: [4, 7, 7, 7], landCounts: [3, 5, 3, 2] });
    const next = makeSnap({ handSizes: [4, 7, 7, 7], landCounts: [3, 5, 3, 2] });
    const r = shapeReward(prev, { type: "PASS_TURN" }, next, 0);
    expect(r).toBeCloseTo(-0.01);
  });

  it("penalizza l'eliminazione del proprio player", () => {
    const prev = makeSnap({ lifeTotals: [3, 20, 20, 20] });
    const next = makeSnap({ lifeTotals: [0, 20, 20, 20] });
    const r = shapeReward(prev, { type: "PASS_TURN" }, next, 0);
    expect(r).toBeLessThan(-0.45);
  });

  it("premia miglioramento relativo del board advantage", () => {
    const prev = makeSnap({ creaturePower: [2, 4, 4, 4], permanentCounts: [2, 4, 4, 4] });
    const next = makeSnap({ creaturePower: [6, 4, 4, 4], permanentCounts: [3, 4, 4, 4] });
    const r = shapeReward(prev, { type: "CAST_SPELL", card: "Board Spell" }, next, 0);
    expect(r).toBeGreaterThan(0.05);
  });

  it("non sovra-premia danno casuale piccolo rispetto a elimination", () => {
    const prev = makeSnap({ lifeTotals: [40, 40, 40, 40] });
    const ping = makeSnap({ lifeTotals: [40, 39, 40, 40] });
    const eliminated = makeSnap({ lifeTotals: [40, 0, 40, 40] });
    const pingReward = shapeReward(prev, { type: "CAST_SPELL", card: "Ping" }, ping, 0);
    const eliminationReward = shapeReward(prev, { type: "CAST_SPELL", card: "Burn" }, eliminated, 0);
    expect(pingReward).toBeLessThan(0.02);
    expect(eliminationReward).toBeGreaterThan(pingReward * 10);
  });

  it("nessun reward per azioni senza effetti rilevanti", () => {
    const prev = makeSnap({ lifeTotals: [40, 40, 40, 40], handSizes: [0, 7, 7, 7] });
    const next = makeSnap({ lifeTotals: [40, 40, 40, 40], handSizes: [0, 7, 7, 7] });
    const r = shapeReward(prev, { type: "PASS_TURN" }, next, 0);
    expect(r).toBeCloseTo(0); // no mana (hand empty), no creatures killed
  });
});

// ──────────────────────────────────────────────
// discountRewards
// ──────────────────────────────────────────────
describe("discountRewards", () => {
  it("l'ultimo step riceve quasi tutto il terminal reward (gamma=0.95, n=20)", () => {
    const steps = Array(20).fill(0);
    const result = discountRewards(steps, 1.0, 0.95);
    // Ultimo step: 0.95^0 = 1.0
    expect(result[19]).toBeCloseTo(1.0);
    // Primo step: 0.95^19 ≈ 0.377... "quasi niente" rispetto all'ultimo
    expect(result[0]).toBeLessThan(result[19]);
  });

  it("il primo step riceve molto meno del terminal reward", () => {
    const steps = Array(20).fill(0);
    const result = discountRewards(steps, 1.0, 0.95);
    expect(result[0]).toBeLessThan(0.5);
  });

  it("con gamma=1.0 tutti gli step ricevono lo stesso terminal reward", () => {
    const steps = Array(10).fill(0);
    const result = discountRewards(steps, 1.0, 1.0);
    // 1.0^k = 1.0 per qualsiasi k
    result.forEach((r) => expect(r).toBeCloseTo(1.0));
  });

  it("con gamma=0.0 solo l'ultimo step riceve il terminal reward", () => {
    const steps = Array(10).fill(0);
    const result = discountRewards(steps, 1.0, 0.0);
    // gamma=0: 0^0 = 1 (ultimo), 0^k = 0 per k>0 (tutti gli altri)
    expect(result[9]).toBeCloseTo(1.0);
    for (let i = 0; i < 9; i++) {
      expect(result[i]).toBeCloseTo(0.0);
    }
  });

  it("include i step rewards nel totale", () => {
    const steps = [0.1, 0.2, 0.05];
    const result = discountRewards(steps, 0.0, 0.95);
    // terminalReward=0, quindi risultato = stepRewards originali
    expect(result[0]).toBeCloseTo(0.1);
    expect(result[1]).toBeCloseTo(0.2);
    expect(result[2]).toBeCloseTo(0.05);
  });
});
