import type { SimGameState, SimAction } from "@game-state/types";

// ──────────────────────────────────────────────
// Env flags (readable by engine and learningAgent)
// ──────────────────────────────────────────────
export const REWARD_GAMMA = (() => {
  const parsed = Number(process.env.REWARD_GAMMA ?? "0.95");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.95;
})();

export const REWARD_SHAPING_ENABLED = process.env.REWARD_SHAPING !== "false";

// ──────────────────────────────────────────────
// StateSnapshot — lightweight, no deep clone
// ──────────────────────────────────────────────
export interface StateSnapshot {
  lifeTotals: number[];
  creatureCounts: number[];
  creaturePower: number[];
  permanentCounts: number[];
  landCounts: number[];
  handSizes: number[];
  graveyardSizes: number[];
}

export function captureSnapshot(state: SimGameState): StateSnapshot {
  return {
    lifeTotals: [...state.lifeTotals],
    creatureCounts: state.creatures.map((arr) => arr.length),
    creaturePower: state.creatures.map((arr) =>
      arr.reduce((sum, creature) => sum + creature.power + creature.toughness * 0.35, 0)
    ),
    permanentCounts: state.battlefields.map((battlefield, index) =>
      battlefield.length + (state.creatures[index]?.length ?? 0)
    ),
    landCounts: state.battlefields.map((bf, i) =>
      bf.filter((card) => {
        const meta = state.cardMetadata[i]?.[card.toLowerCase()];
        const normalized = card.toLowerCase();
        return meta?.isLand ?? /land|plains|island|swamp|mountain|forest|wastes/.test(normalized);
      }).length
    ),
    handSizes: state.hands.map((h) => h.length),
    graveyardSizes: state.graveyards.map((g) => g.length),
  };
}

// ──────────────────────────────────────────────
// shapeReward — per-step intermediate reward
// ──────────────────────────────────────────────
export function shapeReward(
  prev: StateSnapshot,
  action: SimAction,
  next: StateSnapshot,
  playerIndex: number
): number {
  if (!REWARD_SHAPING_ENABLED) return 0;

  let reward = 0;
  const prevMyLife = prev.lifeTotals[playerIndex] ?? 0;
  const nextMyLife = next.lifeTotals[playerIndex] ?? 0;
  const opponentIndices = prev.lifeTotals
    .map((_, index) => index)
    .filter((index) => index !== playerIndex);

  for (const i of opponentIndices) {
    if (prev.lifeTotals[i] > 0 && next.lifeTotals[i] <= 0) {
      reward += 0.35;
    }
  }

  if (prevMyLife > 0 && nextMyLife <= 0) {
    reward -= 0.45;
  }

  const damageDealt = opponentIndices.reduce(
    (sum, index) => sum + Math.max(0, (prev.lifeTotals[index] ?? 0) - (next.lifeTotals[index] ?? 0)),
    0
  );
  const damageReceived = Math.max(0, prevMyLife - nextMyLife);
  reward += Math.min(0.08, damageDealt * 0.008);
  reward -= Math.min(0.08, damageReceived * 0.01);

  if (
    action.type === "DECLARE_BLOCKERS" &&
    prevMyLife > 0 &&
    prevMyLife <= 5 &&
    nextMyLife > 0
  ) {
    reward += 0.12;
  }

  // +0.05: land drop on-curve (il giocatore aveva altre carte in mano oltre alla terra)
  if (action.type === "PLAY_LAND") {
    if (prev.handSizes[playerIndex] > 1) {
      reward += 0.05;
    }
  }

  if (action.type === "CAST_SPELL") {
    // +0.03: cast creature quando siamo dietro sul board
    const myBefore = prev.creatureCounts[playerIndex];
    const myAfter = next.creatureCounts[playerIndex];
    if (myAfter > myBefore) {
      const opponentCount = prev.creatureCounts.length - 1;
      const avgOpponents =
        prev.creatureCounts
          .filter((_, i) => i !== playerIndex)
          .reduce((s, v) => s + v, 0) / opponentCount;
      if (myBefore < avgOpponents) {
        reward += 0.03;
      }
    }

    // +0.02: spell che riduce il board avversario (removal)
    const opponentBefore = prev.creatureCounts
      .filter((_, i) => i !== playerIndex)
      .reduce((s, v) => s + v, 0);
    const opponentAfter = next.creatureCounts
      .filter((_, i) => i !== playerIndex)
      .reduce((s, v) => s + v, 0);
    if (opponentAfter < opponentBefore) {
      reward += Math.min(0.08, (opponentBefore - opponentAfter) * 0.035);
    }
  }

  const prevBoardAdvantage = boardAdvantage(prev, playerIndex);
  const nextBoardAdvantage = boardAdvantage(next, playerIndex);
  reward += clamp((nextBoardAdvantage - prevBoardAdvantage) * 0.025, -0.1, 0.1);
  const creatureCountDelta =
    (next.creatureCounts[playerIndex] ?? 0) - (prev.creatureCounts[playerIndex] ?? 0);
  if (creatureCountDelta < 0) {
    const opponentCountDelta = opponentIndices.reduce(
      (sum, index) => sum + ((prev.creatureCounts[index] ?? 0) - (next.creatureCounts[index] ?? 0)),
      0
    );
    if (opponentCountDelta <= 0) reward -= Math.min(0.08, Math.abs(creatureCountDelta) * 0.03);
  }

  const handDelta =
    (next.handSizes[playerIndex] - prev.handSizes[playerIndex]) -
    average(
      opponentIndices.map(
        (index) => (next.handSizes[index] ?? 0) - (prev.handSizes[index] ?? 0)
      )
    );
  reward += clamp(handDelta * 0.015, -0.04, 0.05);

  const myPermanentLoss = Math.max(
    0,
    (prev.permanentCounts[playerIndex] ?? 0) - (next.permanentCounts[playerIndex] ?? 0)
  );
  if (myPermanentLoss > 0) {
    reward -= Math.min(0.12, myPermanentLoss * 0.04);
  }

  if (action.type !== "CAST_SPELL") {
    const myCreatureValueLoss = Math.max(
      0,
      (prev.creaturePower[playerIndex] ?? 0) - (next.creaturePower[playerIndex] ?? 0)
    );
    const opponentCreatureValueLoss = Math.max(
      0,
      opponentIndices.reduce((sum, index) => sum + (prev.creaturePower[index] ?? 0), 0) -
        opponentIndices.reduce((sum, index) => sum + (next.creaturePower[index] ?? 0), 0)
    );
    if (myCreatureValueLoss > 0 && opponentCreatureValueLoss <= 0) {
      reward -= Math.min(0.1, myCreatureValueLoss * 0.015);
    }
  }

  // -0.01: PASS_TURN con spell in mano e mana disponibile (mana waste)
  if (action.type === "PASS_TURN") {
    if (prev.handSizes[playerIndex] > 0 && prev.landCounts[playerIndex] > 0) {
      reward += -0.01;
    }
  }

  return reward;
}

export function terminalRewardForPlayer(
  winnerIndex: number | null,
  playerIndex: number,
  finalLifeTotals?: number[]
): number {
  if (winnerIndex === null) return 0;
  if (winnerIndex === playerIndex) return 1;

  const life = finalLifeTotals?.[playerIndex] ?? 0;
  if (life <= 0) return -0.55;

  const livingOpponents = finalLifeTotals
    ?.map((value, index) => ({ value, index }))
    .filter(({ value, index }) => index !== winnerIndex && value > 0)
    .sort((left, right) => right.value - left.value) ?? [];
  const rank = livingOpponents.findIndex(({ index }) => index === playerIndex);
  if (rank === 0) return -0.12;
  if (rank === 1) return -0.18;
  return -0.25;
}

// ──────────────────────────────────────────────
// discountRewards — temporal credit assignment
// reward[i] = stepReward[i] + terminalReward * gamma^(N-1-i)
// L'ultimo step riceve gamma^0 = 1.0 di credito (massimo),
// il primo riceve gamma^(N-1) (minimo).
// ──────────────────────────────────────────────
export function discountRewards(
  stepRewards: number[],
  terminalReward: number,
  gamma: number = REWARD_GAMMA
): number[] {
  const n = stepRewards.length;
  return stepRewards.map((stepReward, i) => {
    return stepReward + terminalReward * Math.pow(gamma, n - 1 - i);
  });
}

function boardAdvantage(snapshot: StateSnapshot, playerIndex: number): number {
  const mine =
    (snapshot.creaturePower[playerIndex] ?? 0) +
    (snapshot.permanentCounts[playerIndex] ?? 0) * 0.4 +
    (snapshot.handSizes[playerIndex] ?? 0) * 0.15;
  const opponents = snapshot.lifeTotals
    .map((_, index) => index)
    .filter((index) => index !== playerIndex);
  const opponentAvg = average(
    opponents.map(
      (index) =>
        (snapshot.creaturePower[index] ?? 0) +
        (snapshot.permanentCounts[index] ?? 0) * 0.4 +
        (snapshot.handSizes[index] ?? 0) * 0.15
    )
  );
  return mine - opponentAvg;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
