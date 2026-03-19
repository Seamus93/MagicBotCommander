/**
 * FeatureVector — converts the LearningAgent rich feature Record<string,number>
 * to a normalized number[] suitable for PolicyNet input.
 *
 * 20 features, each normalized to [0,1] by dividing by its max bucket value.
 */

import type { SimGameState } from "@game-state/types.js";

// Phase 4 archetype ID mapping (same as learningAgent)
const ARCHETYPE_IDS: Readonly<Record<string, number>> = {
  AGGRO: 1, CONTROL: 2, COMBO: 3, MIDRANGE: 4,
  TEMPO: 5, RAMP: 6, "PRISON/STAX": 7, COMMANDER: 8,
};

/**
 * Feature spec: [featureName, maxBucketValue] pairs.
 * Normalization: value / maxBucketValue → clamped to [0, 1].
 */
export const FEATURE_SPEC: Array<[string, number]> = [
  ["turnBucket", 3],
  ["phaseEnc", 2],
  ["handBucket", 3],
  ["spellsBucket", 3],
  ["libraryBucket", 3],
  ["landBucket", 3],
  ["artifactsBucket", 3],
  ["manaProductionBucket", 3],
  ["creaturesBucket", 3],
  ["readyPowerBucket", 3],
  ["graveyardBucket", 3],
  ["costReducers", 3],
  ["lifeBucket", 3],
  ["opponentMinLifeBucket", 3],
  ["opponentAvgLifeBucket", 3],
  ["opponentCreaturesBucket", 3],
  ["opponentReadyPowerBucket", 3],
  ["boardAdvantageBucket", 2],
  ["myArchetypeEnc", 8],
  ["opponentArchetypeMix", 4],
];

export const FEATURE_SIZE = 20;

/** Convert a feature record to a normalized float vector of length FEATURE_SIZE. */
export function featuresToVector(features: Record<string, number>): number[] {
  return FEATURE_SPEC.map(([name, maxVal]) => {
    const raw = features[name] ?? 0;
    return Math.min(Math.max(raw / maxVal, 0), 1);
  });
}

/** Returns the fixed feature vector length. */
export function vectorSize(): number {
  return FEATURE_SIZE;
}

/** Bucket helper: returns index of first threshold exceeded. */
function bucket(value: number, thresholds: readonly number[]): number {
  for (let i = 0; i < thresholds.length; i++) {
    if (value < thresholds[i]) return i;
  }
  return thresholds.length;
}

/**
 * Extract the rich feature record from a SimGameState, for a given player.
 * Returns null if state is missing required fields.
 * Mirrors extractRichFeatures in LearningAgent (Phase 1 + Phase 4 archetype features).
 * When archetype/opponentArchetypes are unknown, those features default to 0.
 */
export function extractFeaturesFromState(
  rawState: unknown
): Record<string, number> | null {
  if (!rawState || typeof rawState !== "object") return null;
  const state = rawState as Partial<SimGameState>;

  if (
    typeof state.turn !== "number" ||
    typeof state.playerIndex !== "number" ||
    !Array.isArray(state.lifeTotals) ||
    !Array.isArray(state.hands) ||
    !Array.isArray(state.battlefields)
  ) {
    return null;
  }

  const playerIndex = state.playerIndex;
  const hand = state.hands[playerIndex] ?? [];
  const battlefield = state.battlefields[playerIndex] ?? [];
  const graveyard = (state.graveyards ?? [])[playerIndex] ?? [];
  const library = (state.libraries ?? [])[playerIndex] ?? [];
  const creatures = (state.creatures ?? [])[playerIndex] ?? [];
  const meta = (state.cardMetadata ?? [])[playerIndex] ?? {};

  const isLand = (card: string): boolean =>
    (meta as Record<string, { isLand?: boolean }>)[card]?.isLand ??
    card.toLowerCase().includes("land");

  const myLands = battlefield.filter(isLand).length;
  const myArtifacts = ((state.artifacts ?? [])[playerIndex] ?? []).length;
  const mySpellsInHand = hand.filter((card) => !isLand(card)).length;
  const myLife = state.lifeTotals[playerIndex] ?? 40;
  const myReadyPower = (creatures as Array<{ summoningSickness?: boolean; tapped?: boolean; power?: number }>)
    .filter((c) => !c.summoningSickness && !c.tapped)
    .reduce((sum, c) => sum + (c.power ?? 0), 0);

  const opponentLifeTotals = state.lifeTotals.filter((_, idx) => idx !== playerIndex);
  const opponentAvgLife =
    opponentLifeTotals.length > 0
      ? opponentLifeTotals.reduce((s, v) => s + v, 0) / opponentLifeTotals.length
      : 40;
  const opponentMinLife =
    opponentLifeTotals.length > 0 ? Math.min(...opponentLifeTotals) : 40;

  const allCreatures = (state.creatures ?? []) as Array<Array<{ summoningSickness?: boolean; tapped?: boolean; power?: number }>>;
  const opponentCreatureArrays = allCreatures.filter((_, idx) => idx !== playerIndex);
  const avgOpponentCreatures =
    opponentCreatureArrays.length > 0
      ? opponentCreatureArrays.reduce((sum, arr) => sum + arr.length, 0) / opponentCreatureArrays.length
      : 0;
  const totalOpponentReadyPower = opponentCreatureArrays
    .flat()
    .filter((c) => !c.summoningSickness && !c.tapped)
    .reduce((sum, c) => sum + (c.power ?? 0), 0);

  const artifactMana = (state.artifactMana ?? [])[playerIndex] ?? 0;
  const totalManaProduction = myLands + artifactMana;
  const boardAdvantageBucket = Math.sign(creatures.length - avgOpponentCreatures) + 1;
  const numCostReducers = Math.min(
    ((state.costReducers as Record<number, unknown[]> | undefined)?.[playerIndex] ?? []).length,
    3
  );
  const phaseEnc = (state.phase ?? "").includes("COMBAT")
    ? 1
    : (state.phase ?? "").includes("MAIN_POST")
      ? 2
      : 0;

  const opponentMixSum = 0; // no archetype info from raw state
  const opponentArchMix = bucket(opponentMixSum, [5, 10, 15, 20]);

  return {
    turnBucket: bucket(state.turn, [4, 8, 12]),
    phaseEnc,
    handBucket: bucket(hand.length, [2, 4, 6]),
    spellsBucket: bucket(mySpellsInHand, [1, 3, 5]),
    libraryBucket: bucket(library.length, [20, 30, 40]),
    landBucket: bucket(myLands, [3, 5, 7]),
    artifactsBucket: bucket(myArtifacts, [1, 2, 4]),
    manaProductionBucket: bucket(totalManaProduction, [2, 4, 6]),
    creaturesBucket: bucket(creatures.length, [1, 3, 5]),
    readyPowerBucket: bucket(myReadyPower, [2, 5, 10]),
    graveyardBucket: bucket(graveyard.length, [2, 5, 10]),
    costReducers: numCostReducers,
    lifeBucket: bucket(myLife, [10, 20, 30]),
    opponentMinLifeBucket: bucket(opponentMinLife, [10, 20, 30]),
    opponentAvgLifeBucket: bucket(opponentAvgLife, [15, 25, 35]),
    opponentCreaturesBucket: bucket(avgOpponentCreatures, [1, 3, 5]),
    opponentReadyPowerBucket: bucket(totalOpponentReadyPower, [3, 8, 15]),
    boardAdvantageBucket,
    myArchetypeEnc: 0,
    opponentArchetypeMix: opponentArchMix,
  };
}

/**
 * Build feature vector from SimGameState using archetype context.
 * Used by NeuralAgent to get the full 20-feature vector.
 */
export function extractFeaturesFromStateWithArchetype(
  state: SimGameState,
  archetype?: string,
  opponentArchetypes?: string[]
): Record<string, number> {
  const base = extractFeaturesFromState(state);
  if (!base) {
    return Object.fromEntries(FEATURE_SPEC.map(([name]) => [name, 0]));
  }

  const myArchEnc = archetype
    ? (ARCHETYPE_IDS[archetype.toUpperCase()] ?? 0)
    : 0;

  const opponentMixSum = (opponentArchetypes ?? [])
    .map((a) => ARCHETYPE_IDS[a?.toUpperCase()] ?? 0)
    .reduce((s, v) => s + v, 0);
  const opponentArchMix = bucket(opponentMixSum, [5, 10, 15, 20]);

  return {
    ...base,
    myArchetypeEnc: myArchEnc,
    opponentArchetypeMix: opponentArchMix,
  };
}
