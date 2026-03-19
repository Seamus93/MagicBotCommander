import type { CardName, DeckCardMetadata } from "@game-state/types";

// Maps card metadata for quick lookup. metadata is indexed by lowercase card name.
export interface MulliganContext {
  metadata?: Record<string, DeckCardMetadata>;
}

/**
 * Scores a starting hand from 0 to 100.
 * - Land count: 0 lands→0, 1 land→20, 2-3 lands→80-100 (2→80, 3→100), 4 lands→60, 5+→30
 * - +20 if hand has a spell with CMC 2
 * - +15 if hand has a spell with CMC 3
 * - -20 per spell not castable with lands in hand (color mismatch)
 * - Archetype bonus (AGGRO +15 if creature CMC 1-2, CONTROL +15 if removal/counter,
 *   RAMP +15 if ramp spell, COMBO +10 per combo piece)
 */
export function evaluateHand(
  hand: CardName[],
  archetype?: string,
  ctx?: MulliganContext
): number {
  const meta = ctx?.metadata ?? {};

  const getInfo = (card: CardName): DeckCardMetadata | undefined =>
    meta[card.toLowerCase()] ?? meta[card.trim().toLowerCase()];

  const isLand = (card: CardName) => {
    const info = getInfo(card);
    if (info?.isLand !== undefined) return info.isLand;
    if (info?.typeLine?.toLowerCase().includes("land")) return true;
    const lower = card.toLowerCase();
    return (
      lower.includes("land") ||
      ["plains", "island", "swamp", "mountain", "forest", "wastes"].includes(lower)
    );
  };

  const landCards = hand.filter(isLand);
  const spellCards = hand.filter((c) => !isLand(c));
  const landCount = landCards.length;

  // Base score from land count
  let score = 0;
  if (landCount === 0) score = 0;
  else if (landCount === 1) score = 20;
  else if (landCount === 2) score = 80;
  else if (landCount === 3) score = 100;
  else if (landCount === 4) score = 60;
  else score = 30; // 5+ lands

  if (score === 0 && landCount === 0) return 0; // auto-mulligan

  // Mana curve coverage
  const hasCmc2 = spellCards.some((c) => {
    const info = getInfo(c);
    return (info?.manaValue ?? 999) === 2;
  });
  const hasCmc3 = spellCards.some((c) => {
    const info = getInfo(c);
    return (info?.manaValue ?? 999) === 3;
  });
  if (hasCmc2) score += 20;
  if (hasCmc3) score += 15;

  // Color coverage penalty
  const landColors = new Set<string>();
  for (const land of landCards) {
    const info = getInfo(land);
    const colors = info?.colors ?? info?.colorIdentity ?? [];
    if (colors.length === 0) {
      // Basic land heuristic: guess from name
      const lower = land.toLowerCase();
      if (lower.includes("plains")) landColors.add("W");
      else if (lower.includes("island")) landColors.add("U");
      else if (lower.includes("swamp")) landColors.add("B");
      else if (lower.includes("mountain")) landColors.add("R");
      else if (lower.includes("forest")) landColors.add("G");
      else {
        // Colorless or unknown — don't add any specific color
      }
    } else {
      for (const c of colors) landColors.add(c.toUpperCase());
    }
  }

  let colorPenalty = 0;
  for (const spell of spellCards) {
    const info = getInfo(spell);
    const needed = info?.colors ?? info?.colorIdentity ?? [];
    if (needed.length === 0) continue; // colorless/unknown: no penalty
    const castable = needed.some((c) => landColors.has(c.toUpperCase()));
    if (!castable && needed.length > 0) colorPenalty += 20;
  }
  score -= colorPenalty;

  // Archetype bonuses
  if (archetype) {
    const arch = archetype.toUpperCase();
    if (arch === "AGGRO") {
      const hasEarlyCreature = spellCards.some((c) => {
        const info = getInfo(c);
        const cmc = info?.manaValue ?? 999;
        return info?.isCreature && cmc <= 2;
      });
      if (hasEarlyCreature) score += 15;
    }
    if (arch === "CONTROL") {
      const hasInteraction = spellCards.some((c) => {
        const info = getInfo(c);
        const text = (info?.oracleText ?? "").toLowerCase();
        return text.includes("counter") || text.includes("destroy") || text.includes("exile") || text.includes("return");
      });
      if (hasInteraction) score += 15;
    }
    if (arch === "RAMP") {
      const hasRamp = spellCards.some((c) => {
        const info = getInfo(c);
        const text = (info?.oracleText ?? "").toLowerCase();
        return text.includes("search your library") || (info?.manaProduction ?? 0) > 0;
      });
      if (hasRamp) score += 15;
    }
    if (arch === "COMBO") {
      const comboPieces = spellCards.filter((c) => {
        const info = getInfo(c);
        return (info?.manaValue ?? 999) >= 3 && !info?.isLand;
      }).length;
      score += comboPieces * 10;
    }
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Returns true if the agent should mulligan.
 * Thresholds:
 *   mulliganCount=0 (7 cards): keep if score >= 50
 *   mulliganCount=1 (6 cards): keep if score >= 40
 *   mulliganCount=2 (5 cards): keep if score >= 25
 *   mulliganCount>=3 (4 cards): always keep
 */
export function shouldMulligan(
  hand: CardName[],
  mulliganCount: number,
  archetype?: string,
  ctx?: MulliganContext
): boolean {
  if (mulliganCount >= 3) return false;
  const score = evaluateHand(hand, archetype, ctx);
  const thresholds = [50, 40, 25];
  return score < (thresholds[mulliganCount] ?? 25);
}

/**
 * Selects `count` cards to bottom (London Mulligan rule).
 * Priority for bottoming: excess lands, expensive spells, duplicates.
 */
export function chooseBottomCards(
  hand: CardName[],
  count: number,
  _archetype?: string,
  ctx?: MulliganContext
): CardName[] {
  if (count <= 0) return [];
  const meta = ctx?.metadata ?? {};
  const getInfo = (card: CardName): DeckCardMetadata | undefined =>
    meta[card.toLowerCase()] ?? meta[card.trim().toLowerCase()];

  const isLand = (card: CardName) => {
    const info = getInfo(card);
    if (info?.isLand !== undefined) return info.isLand;
    if (info?.typeLine?.toLowerCase().includes("land")) return true;
    const lower = card.toLowerCase();
    return (
      lower.includes("land") ||
      ["plains", "island", "swamp", "mountain", "forest", "wastes"].includes(lower)
    );
  };

  const landCards = hand.filter(isLand);
  const spellCards = hand.filter((c) => !isLand(c));
  const landCount = landCards.length;

  // Build candidates to bottom (sorted by priority — higher priority = bottom first)
  const candidates: { card: CardName; priority: number }[] = [];

  // Excess lands: if we have more than 3 lands, excess ones are good to bottom
  const excessLands = landCount - 3;
  for (let i = 0; i < excessLands; i++) {
    candidates.push({ card: landCards[i], priority: 90 });
  }

  // Expensive spells (CMC 6+)
  for (const card of spellCards) {
    const info = getInfo(card);
    const cmc = info?.manaValue ?? 0;
    if (cmc >= 6) candidates.push({ card, priority: 80 });
    else if (cmc >= 5) candidates.push({ card, priority: 60 });
    else if (cmc >= 4) candidates.push({ card, priority: 40 });
  }

  // Fill remaining from spellCards not already queued (sorted by CMC descending)
  const alreadyQueued = new Set(candidates.map((c) => c.card));
  for (const card of [...spellCards].sort((a, b) => {
    const cmcA = getInfo(a)?.manaValue ?? 0;
    const cmcB = getInfo(b)?.manaValue ?? 0;
    return cmcB - cmcA; // descending: most expensive first
  })) {
    if (!alreadyQueued.has(card)) {
      candidates.push({ card, priority: getInfo(card)?.manaValue ?? 0 });
      alreadyQueued.add(card);
    }
  }

  // Finally add non-excess lands at lowest priority
  const excessLandSet = new Set(landCards.slice(0, Math.max(0, excessLands)));
  for (const land of landCards) {
    if (!excessLandSet.has(land) && !alreadyQueued.has(land)) {
      candidates.push({ card: land, priority: 1 });
      alreadyQueued.add(land);
    }
  }

  // Sort descending by priority (highest priority = bottom first)
  candidates.sort((a, b) => b.priority - a.priority);

  return candidates.slice(0, count).map((c) => c.card);
}
