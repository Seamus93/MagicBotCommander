import { PrismaClient } from "@prisma/client";
import type { Archetype } from "@prisma/client";
import type { DeckCardMetadata } from "@game-state/types";

const prisma = new PrismaClient();

export type DeckInfo = {
  id?: number;
  name?: string;
  commander?: string;
  cards: string[];
  cardMetadata?: DeckCardMetadata[];
};

export type MatchedArchetype = {
  archetype: Archetype | null;
  reasons: string[];
  confidence: number; // 0.0 – 1.0
};

// Simple keyword buckets for card-name heuristics
const buckets: Record<string, RegExp[]> = {
  AGGRO: [/goblin/i, /soldier/i, /weenie/i, /haste/i, /burn/i, /lightning/i],
  CONTROL: [/counterspell/i, /wrath/i, /supreme verdict/i, /force of will/i],
  COMBO: [/thassa's oracle/i, /consultation/i, /storm/i, /dockside/i, /isochron scepter/i],
  MIDRANGE: [/thoughtseize/i, /liliana/i, /grist/i, /rhino/i],
  TEMPO: [/delver/i, /sprite/i, /tempo/i, /remand/i],
  RAMP: [/cultivate/i, /kodama's reach/i, /rampant growth/i, /sol ring/i, /mana crypt/i],
  "PRISON/STAX": [/winter orb/i, /stasis/i, /rule of law/i, /trinisphere/i, /sphere of resistance/i],
  COMMANDER: [/anointed procession/i, /blood artist/i, /skullclamp/i, /aura/i, /equipment/i],
};

const commanderHints: Record<string, string> = {
  "thrasios, triton hero": "RAMP",
  "tymna the weaver": "TEMPO",
  "najeela, the blade-blossom": "AGGRO",
  "urza, lord high artificer": "CONTROL",
  "yuriko, the tiger's shadow": "TEMPO",
  "edgar markov": "AGGRO",
  "atraxa, grand unifier": "MIDRANGE",
  "atraxa, praetors' voice": "CONTROL",
  "korvold, fey-curse king": "MIDRANGE",
  "breya, etherium shaper": "COMBO",
  "niv-mizzet, parun": "CONTROL",
  "kinnan, bonder prodigy": "RAMP",
};

// Oracle text keywords for each archetype category
const oracleKeywords: Record<string, RegExp[]> = {
  CONTROL: [/counter target/i, /destroy all/i, /exile all/i, /draw.*cards/i, /search.*library/i],
  COMBO: [/tutor/i, /untap/i, /infinite/i, /storm count/i, /copy/i],
  RAMP: [/add.*mana/i, /search.*land/i, /put.*land.*battlefield/i],
  AGGRO: [/haste/i, /first strike/i, /double strike/i, /menace/i, /trample/i],
  MIDRANGE: [/deathtouch/i, /lifelink/i, /vigilance/i],
  TEMPO: [/flash/i, /return.*hand/i, /flying/i],
};

// ──────────────────────────────────────────────
// Pure scoring — testabile senza DB
// ──────────────────────────────────────────────
export interface ArchetypeScore {
  category: string;
  score: number;
  confidence: number; // 0.0 – 1.0
  reasons: string[];
}

export function scoreArchetypeCategory(deck: DeckInfo): ArchetypeScore {
  const scores: Record<string, number> = {};
  const reasons: string[] = [];
  const cardsLower = deck.cards.map((c) => c.toLowerCase());
  const meta = deck.cardMetadata ?? [];
  const totalCards = deck.cards.length || 1;

  // ── 1. Commander hint (peso massimo) ──
  const commander = deck.commander?.toLowerCase() ?? "";
  if (commander && commanderHints[commander]) {
    const hint = commanderHints[commander];
    scores[hint] = (scores[hint] ?? 0) + 10;
    reasons.push(`Commander hint: ${commander} → ${hint}`);
  }

  // ── 2. Deck name keywords ──
  const name = deck.name?.toLowerCase() ?? "";
  for (const [cat, regexes] of Object.entries(buckets)) {
    if (regexes.some((r) => r.test(name))) {
      scores[cat] = (scores[cat] ?? 0) + 5;
      reasons.push(`Deck name matches ${cat}`);
    }
  }

  // ── 3. Card name keywords ──
  for (const [cat, regexes] of Object.entries(buckets)) {
    let hits = 0;
    for (const regex of regexes) {
      if (cardsLower.some((c) => regex.test(c))) hits++;
    }
    if (hits > 0) {
      scores[cat] = (scores[cat] ?? 0) + hits;
      reasons.push(`Card keywords suggest ${cat} (${hits} hits)`);
    }
  }

  // ── 4. Oracle text keyword detection ──
  for (const metaEntry of meta) {
    const oracle = metaEntry.oracleText?.toLowerCase() ?? "";
    if (!oracle) continue;
    for (const [cat, regexes] of Object.entries(oracleKeywords)) {
      for (const regex of regexes) {
        if (regex.test(oracle)) {
          scores[cat] = (scores[cat] ?? 0) + 0.5;
        }
      }
    }
  }

  // ── 5. Creature-to-noncreature ratio ──
  const creatures = meta.filter((m) => m.isCreature).length;
  const creatureRatio = creatures / totalCards;

  if (creatureRatio > 0.6) {
    scores["AGGRO"] = (scores["AGGRO"] ?? 0) + 3;
    reasons.push(`High creature ratio (${(creatureRatio * 100).toFixed(0)}%) → AGGRO`);
  } else if (creatureRatio < 0.3) {
    scores["CONTROL"] = (scores["CONTROL"] ?? 0) + 3;
    reasons.push(`Low creature ratio (${(creatureRatio * 100).toFixed(0)}%) → CONTROL`);
  } else if (creatureRatio >= 0.4 && creatureRatio <= 0.6) {
    scores["MIDRANGE"] = (scores["MIDRANGE"] ?? 0) + 2;
    reasons.push(`Mid creature ratio (${(creatureRatio * 100).toFixed(0)}%) → MIDRANGE`);
  }

  // ── 6. Mana curve shape ──
  const cmvBuckets: Record<string, number> = { low: 0, mid: 0, high: 0 };
  let metaWithCmv = 0;
  for (const m of meta) {
    if (typeof m.manaValue !== "number" || m.isLand) continue;
    metaWithCmv++;
    if (m.manaValue <= 2) cmvBuckets.low++;
    else if (m.manaValue <= 5) cmvBuckets.mid++;
    else cmvBuckets.high++;
  }
  if (metaWithCmv > 0) {
    const lowRatio = cmvBuckets.low / metaWithCmv;
    const highRatio = cmvBuckets.high / metaWithCmv;
    const midRatio = cmvBuckets.mid / metaWithCmv;

    // Aggro: concentrato CMC 1-3
    if (lowRatio > 0.55) {
      scores["AGGRO"] = (scores["AGGRO"] ?? 0) + 3;
      reasons.push(`Mana curve concentrated low CMC (${(lowRatio * 100).toFixed(0)}%) → AGGRO`);
    }
    // Ramp: molti CMC 1-2 (ramp) + CMC 6+ (payoffs)
    if (lowRatio > 0.3 && highRatio > 0.2) {
      scores["RAMP"] = (scores["RAMP"] ?? 0) + 3;
      reasons.push(`Mana curve bimodal (low ${(lowRatio * 100).toFixed(0)}% + high ${(highRatio * 100).toFixed(0)}%) → RAMP`);
    }
    // Control: distribuito CMC 3-7
    if (midRatio > 0.5 && lowRatio < 0.3) {
      scores["CONTROL"] = (scores["CONTROL"] ?? 0) + 2;
      reasons.push(`Mana curve mid-high (${(midRatio * 100).toFixed(0)}% CMC 3-5) → CONTROL`);
    }
  }

  // ── Compute winner ──
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestCat, bestScore] = entries[0] ?? ["UNKNOWN", 0];
  const secondScore = entries[1]?.[1] ?? 0;
  const totalScore = entries.reduce((s, [, v]) => s + v, 0) || 1;

  // Confidence: how much the winner dominates over second place
  const margin = bestScore - secondScore;
  const confidence = Math.min(1.0, (bestScore / totalScore) * (1 + margin / (totalScore + 1)));

  return { category: bestCat, score: bestScore, confidence, reasons };
}

// ──────────────────────────────────────────────
// matchArchetype — async (requires DB for Archetype model)
// ──────────────────────────────────────────────
export async function matchArchetype(deck: DeckInfo): Promise<MatchedArchetype> {
  const scored = scoreArchetypeCategory(deck);

  const arche = await prisma.archetype.findFirst({
    where: { category: scored.category },
  });

  return {
    archetype: arche,
    reasons: scored.reasons,
    confidence: scored.confidence,
  };
}
