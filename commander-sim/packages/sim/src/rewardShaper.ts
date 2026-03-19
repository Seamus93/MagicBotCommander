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
  landCounts: number[];
  handSizes: number[];
}

export function captureSnapshot(state: SimGameState): StateSnapshot {
  return {
    lifeTotals: [...state.lifeTotals],
    creatureCounts: state.creatures.map((arr) => arr.length),
    landCounts: state.battlefields.map((bf, i) =>
      bf.filter((card) => {
        const meta = state.cardMetadata[i]?.[card.toLowerCase()];
        return meta?.isLand ?? card.toLowerCase().includes("land");
      }).length
    ),
    handSizes: state.hands.map((h) => h.length),
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

  // +0.15: eliminazione di un avversario (vita passa da >0 a <=0)
  for (let i = 0; i < prev.lifeTotals.length; i++) {
    if (i === playerIndex) continue;
    if (prev.lifeTotals[i] > 0 && next.lifeTotals[i] <= 0) {
      reward += 0.15;
    }
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
      reward += 0.02;
    }
  }

  // -0.03: perdita di creatura senza uccidere creature avversarie (bad trade, solo combat)
  if (action.type !== "CAST_SPELL") {
    const myDelta = next.creatureCounts[playerIndex] - prev.creatureCounts[playerIndex];
    if (myDelta < 0) {
      const opponentBefore = prev.creatureCounts
        .filter((_, i) => i !== playerIndex)
        .reduce((s, v) => s + v, 0);
      const opponentAfter = next.creatureCounts
        .filter((_, i) => i !== playerIndex)
        .reduce((s, v) => s + v, 0);
      if (opponentAfter >= opponentBefore) {
        reward += -0.03;
      }
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
