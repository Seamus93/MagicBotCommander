import { describe, it, expect } from "vitest";
import {
  featuresToVector,
  vectorSize,
  extractFeaturesFromState,
  FEATURE_SIZE,
  FEATURE_SPEC,
} from "../featureVector.js";
import type { SimGameState } from "@game-state/types.js";

function makeState(overrides: Partial<SimGameState> = {}): SimGameState {
  const players = 4;
  const empty = () =>
    Array(players)
      .fill(null)
      .map(() => []);
  return {
    turn: 5,
    playerIndex: 0,
    lifeTotals: [40, 35, 30, 20],
    libraries: [Array(35).fill("Card"), [], [], []],
    hands: [["Forest", "Lightning Bolt", "Grizzly Bears"], [], [], []],
    battlefields: [["Forest", "Forest", "Mountain"], [], [], []],
    graveyards: [["Dead Creature"], [], [], []],
    commanders: Array(players).fill("Commander"),
    creatures: [
      [
        {
          id: "c1",
          name: "Grizzly Bears",
          power: 2,
          toughness: 2,
          tapped: false,
          summoningSickness: false,
        },
      ],
      [],
      [],
      [],
    ],
    artifacts: empty(),
    artifactMana: Array(players).fill(0),
    manaSpent: Array(players).fill(0),
    cardMetadata: [
      {
        Forest: { name: "Forest", isLand: true },
        Mountain: { name: "Mountain", isLand: true },
      },
      {},
      {},
      {},
    ],
    triggers: [],
    triggerCounter: 1,
    phase: "Prima Fase Principale",
    phaseStep: "Prima Fase Principale",
    costReducers: Object.fromEntries(
      Array.from({ length: players }, (_, i) => [i, []])
    ) as SimGameState["costReducers"],
    handSizeModifiers: Object.fromEntries(
      Array.from({ length: players }, (_, i) => [i, []])
    ) as SimGameState["handSizeModifiers"],
    drawHistory: Object.fromEntries(
      Array.from({ length: players }, (_, i) => [i, 0])
    ),
    stack: [],
    ...overrides,
  };
}

describe("FEATURE_SIZE", () => {
  it("equals 20", () => {
    expect(FEATURE_SIZE).toBe(20);
  });

  it("matches FEATURE_SPEC length", () => {
    expect(FEATURE_SPEC).toHaveLength(FEATURE_SIZE);
  });
});

describe("vectorSize", () => {
  it("returns 20", () => {
    expect(vectorSize()).toBe(20);
  });
});

describe("featuresToVector", () => {
  it("returns array of length FEATURE_SIZE", () => {
    const features = Object.fromEntries(FEATURE_SPEC.map(([name]) => [name, 1]));
    const vec = featuresToVector(features);
    expect(vec).toHaveLength(FEATURE_SIZE);
  });

  it("normalizes values to [0, 1]", () => {
    const features = Object.fromEntries(
      FEATURE_SPEC.map(([name, maxVal]) => [name, maxVal])
    );
    const vec = featuresToVector(features);
    vec.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
    // max values should normalize to 1.0
    vec.forEach((v) => expect(v).toBeCloseTo(1.0, 5));
  });

  it("clamps values above max to 1.0", () => {
    const features = Object.fromEntries(
      FEATURE_SPEC.map(([name, maxVal]) => [name, maxVal * 10])
    );
    const vec = featuresToVector(features);
    vec.forEach((v) => expect(v).toBeLessThanOrEqual(1.0));
    vec.forEach((v) => expect(v).toBeCloseTo(1.0, 5));
  });

  it("missing keys default to 0", () => {
    const vec = featuresToVector({});
    vec.forEach((v) => expect(v).toBe(0));
  });
});

describe("extractFeaturesFromState", () => {
  it("returns a record with all FEATURE_SPEC keys", () => {
    const state = makeState();
    const features = extractFeaturesFromState(state);
    expect(features).not.toBeNull();
    for (const [name] of FEATURE_SPEC) {
      expect(name in features!).toBe(true);
    }
  });

  it("returns null for non-object input", () => {
    expect(extractFeaturesFromState(null)).toBeNull();
    expect(extractFeaturesFromState("string")).toBeNull();
    expect(extractFeaturesFromState(42)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(extractFeaturesFromState({})).toBeNull();
    expect(
      extractFeaturesFromState({ turn: 1, playerIndex: 0 })
    ).toBeNull();
  });

  it("extracts turnBucket correctly for turn 5 → bucket 1 (between 4 and 8)", () => {
    const state = makeState({ turn: 5 });
    const features = extractFeaturesFromState(state);
    expect(features?.turnBucket).toBe(1);
  });

  it("extracts turnBucket 0 for turn 1", () => {
    const state = makeState({ turn: 1 });
    const features = extractFeaturesFromState(state);
    expect(features?.turnBucket).toBe(0);
  });

  it("extracts phaseEnc=0 for main phase", () => {
    const state = makeState({ phase: "Prima Fase Principale" });
    const features = extractFeaturesFromState(state);
    expect(features?.phaseEnc).toBe(0);
  });

  it("extracts phaseEnc=1 for combat phase", () => {
    const state = makeState({ phase: "COMBAT_BEGIN" });
    const features = extractFeaturesFromState(state);
    expect(features?.phaseEnc).toBe(1);
  });

  it("all feature values are non-negative integers", () => {
    const state = makeState();
    const features = extractFeaturesFromState(state);
    expect(features).not.toBeNull();
    for (const val of Object.values(features!)) {
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(0);
    }
  });

  it("featuresToVector after extractFeaturesFromState gives length-20 vector in [0,1]", () => {
    const state = makeState();
    const features = extractFeaturesFromState(state)!;
    const vec = featuresToVector(features);
    expect(vec).toHaveLength(FEATURE_SIZE);
    vec.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });
});
