/**
 * ActionEncoder — maps SimAction to an integer index (0–10) for the neural policy output.
 *
 * Categories:
 *  0: PASS_TURN
 *  1: PLAY_LAND
 *  2: CAST_SPELL:creature
 *  3: CAST_SPELL:instant
 *  4: CAST_SPELL:sorcery
 *  5: CAST_SPELL:artifact
 *  6: CAST_SPELL:enchantment
 *  7: CAST_SPELL:other
 *  8: ATTACK  (ATTACK_CHOICE mode=ATTACK)
 *  9: BLOCK   (BLOCK_CHOICE with targetId)
 * 10: HOLD    (ATTACK_CHOICE mode=HOLD or BLOCK_CHOICE targetId=null)
 */

import type { SimAction, SimGameState } from "@game-state/types.js";

export const ACTION_COUNT = 11;

/** Encode an action + optional card type hint to an action index 0–10. */
export function encodeAction(
  action: SimAction,
  meta?: { cardType?: string }
): number {
  switch (action.type) {
    case "PASS_TURN":
      return 0;

    case "PLAY_LAND":
      return 1;

    case "CAST_SPELL": {
      const typeLine = (meta?.cardType ?? "").toLowerCase();
      if (typeLine.includes("creature")) return 2;
      if (typeLine.includes("instant")) return 3;
      if (typeLine.includes("sorcery")) return 4;
      if (typeLine.includes("artifact")) return 5;
      if (typeLine.includes("enchantment")) return 6;
      return 7;
    }

    case "ATTACK_CHOICE":
      return action.mode === "ATTACK" ? 8 : 10;

    case "BLOCK_CHOICE":
      return action.targetId ? 9 : 10;

    case "DECLARE_ATTACKERS":
    case "DECLARE_BLOCKERS":
      return 0; // fallback

    default:
      return 0;
  }
}

/** Decode an index back to a human-readable label. */
export function decodeAction(index: number): string {
  const labels: Record<number, string> = {
    0: "PASS_TURN",
    1: "PLAY_LAND",
    2: "CAST_SPELL:creature",
    3: "CAST_SPELL:instant",
    4: "CAST_SPELL:sorcery",
    5: "CAST_SPELL:artifact",
    6: "CAST_SPELL:enchantment",
    7: "CAST_SPELL:other",
    8: "ATTACK",
    9: "BLOCK",
    10: "HOLD",
  };
  return labels[index] ?? "PASS_TURN";
}

/**
 * Encode an action using card metadata from the game state.
 * Looks up the card's typeLine from state.cardMetadata[playerIndex].
 */
export function encodeActionFromState(
  action: SimAction,
  state: SimGameState,
  playerIndex: number
): number {
  if (action.type === "CAST_SPELL") {
    const meta = state.cardMetadata[playerIndex];
    const cardMeta = meta?.[action.card];
    const typeLine = cardMeta?.typeLine ?? "";
    return encodeAction(action, { cardType: typeLine });
  }
  return encodeAction(action);
}
