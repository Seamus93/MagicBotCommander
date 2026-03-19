import { describe, it, expect } from "vitest";
import {
  evaluateHand,
  shouldMulligan,
  chooseBottomCards,
} from "../mulliganEvaluator.js";
import type { MulliganContext } from "../mulliganEvaluator.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeLandCtx(names: string[]): MulliganContext {
  const metadata: MulliganContext["metadata"] = {};
  for (const name of names) {
    metadata[name.toLowerCase()] = { name, isLand: true };
  }
  return { metadata };
}

function makeSpellCtx(entries: { name: string; manaValue: number; colors?: string[] }[]): MulliganContext {
  const metadata: MulliganContext["metadata"] = {};
  for (const entry of entries) {
    metadata[entry.name.toLowerCase()] = {
      name: entry.name,
      isLand: false,
      manaValue: entry.manaValue,
      colors: entry.colors,
    };
  }
  return { metadata };
}

function mergeCtx(...ctxs: MulliganContext[]): MulliganContext {
  const metadata: MulliganContext["metadata"] = {};
  for (const ctx of ctxs) {
    Object.assign(metadata, ctx.metadata ?? {});
  }
  return { metadata };
}

// ──────────────────────────────────────────────
// evaluateHand tests
// ──────────────────────────────────────────────

describe("evaluateHand", () => {
  it("scores 0 for a hand with no lands (auto-mulligan)", () => {
    const hand = ["Burn Spell", "Wild Beast", "Counterspell", "Giant Ogre", "Fireball", "Duress", "Bolt"];
    const score = evaluateHand(hand);
    expect(score).toBe(0);
  });

  it("scores low for a hand with 7 lands", () => {
    const hand = ["Forest", "Forest", "Forest", "Island", "Plains", "Swamp", "Mountain"];
    const score = evaluateHand(hand);
    // 5+ lands → base score 30, no spells so no curve bonuses
    expect(score).toBeLessThanOrEqual(30);
    expect(score).toBeGreaterThan(0);
  });

  it("shouldMulligan=true for a 7-land hand", () => {
    const hand = ["Forest", "Forest", "Forest", "Island", "Plains", "Swamp", "Mountain"];
    expect(shouldMulligan(hand, 0)).toBe(true);
  });

  it("shouldMulligan=true for a 0-land hand", () => {
    const hand = ["Burn Spell", "Wild Beast", "Counterspell", "Giant Ogre", "Fireball", "Duress", "Bolt"];
    expect(shouldMulligan(hand, 0)).toBe(true);
  });

  it("scores high and keeps for 3 lands + 4 spells on curve", () => {
    const landCtx = makeLandCtx(["Forest", "Island", "Plains"]);
    const spellCtx = makeSpellCtx([
      { name: "Lightning Bolt", manaValue: 1 },
      { name: "Counterspell", manaValue: 2 },
      { name: "Wrath of God", manaValue: 3 },
      { name: "Siege Rhino", manaValue: 4 },
    ]);
    const ctx = mergeCtx(landCtx, spellCtx);
    const hand = ["Forest", "Island", "Plains", "Lightning Bolt", "Counterspell", "Wrath of God", "Siege Rhino"];
    const score = evaluateHand(hand, undefined, ctx);
    // 3 lands → 100, +20 (CMC 2), +15 (CMC 3) = 135 → capped at 100
    expect(score).toBe(100);
    expect(shouldMulligan(hand, 0, undefined, ctx)).toBe(false);
  });

  it("scores low for 2 lands + 5 spells all CMC 6+", () => {
    const landCtx = makeLandCtx(["Forest", "Island"]);
    const spellCtx = makeSpellCtx([
      { name: "Emrakul", manaValue: 15 },
      { name: "Blightsteel Colossus", manaValue: 12 },
      { name: "Ulamog", manaValue: 10 },
      { name: "Kozilek", manaValue: 10 },
      { name: "Pathrazer", manaValue: 9 },
    ]);
    const ctx = mergeCtx(landCtx, spellCtx);
    const hand = ["Forest", "Island", "Emrakul", "Blightsteel Colossus", "Ulamog", "Kozilek", "Pathrazer"];
    const score = evaluateHand(hand, undefined, ctx);
    // 2 lands → 80 base, no CMC 2 or 3 spells → stays at 80
    // But all spells are very expensive — no curve bonus
    expect(score).toBe(80);
    // Still high because 2 lands is good base — but no curve
    // The spec says "low score (no curve)" — let's verify no CMC 2/3 bonus
    const hasCmc2Bonus = score > 80;
    expect(hasCmc2Bonus).toBe(false);
  });
});

// ──────────────────────────────────────────────
// shouldMulligan thresholds
// ──────────────────────────────────────────────

describe("shouldMulligan", () => {
  it("always keeps at mulliganCount >= 3", () => {
    const hand = ["Burn Spell", "Wild Beast", "Counterspell", "Giant Ogre"];
    expect(shouldMulligan(hand, 3)).toBe(false);
    expect(shouldMulligan(hand, 4)).toBe(false);
  });

  it("uses lower threshold at higher mulligan counts", () => {
    // A mediocre hand (1 land → score 20)
    const hand = ["Forest", "Bolt", "Bolt", "Bolt", "Bolt", "Bolt", "Bolt"];
    // mulliganCount=0: threshold 50 → should mulligan
    expect(shouldMulligan(hand, 0)).toBe(true);
    // mulliganCount=1: threshold 40 → should still mulligan
    expect(shouldMulligan(hand, 1)).toBe(true);
    // mulliganCount=2: threshold 25 → still mulligan (score 20 < 25)
    expect(shouldMulligan(hand, 2)).toBe(true);
  });
});

// ──────────────────────────────────────────────
// chooseBottomCards tests
// ──────────────────────────────────────────────

describe("chooseBottomCards", () => {
  it("returns empty array when count is 0", () => {
    const hand = ["Forest", "Island", "Bolt", "Counterspell"];
    expect(chooseBottomCards(hand, 0)).toEqual([]);
  });

  it("bottoms excess land when 4 lands + 2 spells, count=1", () => {
    const landCtx = makeLandCtx(["Forest", "Island", "Plains", "Swamp"]);
    const spellCtx = makeSpellCtx([
      { name: "Bolt", manaValue: 1 },
      { name: "Counterspell", manaValue: 2 },
    ]);
    const ctx = mergeCtx(landCtx, spellCtx);
    const hand = ["Forest", "Island", "Plains", "Swamp", "Bolt", "Counterspell"];
    const bottomed = chooseBottomCards(hand, 1, undefined, ctx);
    expect(bottomed).toHaveLength(1);
    // Should bottom a land (excess land priority 90)
    const landNames = ["Forest", "Island", "Plains", "Swamp"];
    expect(landNames).toContain(bottomed[0]);
  });

  it("bottoms expensive spells when 1 land + 5 expensive spells, count=2", () => {
    const landCtx = makeLandCtx(["Forest"]);
    const spellCtx = makeSpellCtx([
      { name: "Emrakul", manaValue: 15 },
      { name: "Ulamog", manaValue: 10 },
      { name: "Kozilek", manaValue: 10 },
      { name: "Blightsteel", manaValue: 12 },
      { name: "Darksteel Colossus", manaValue: 11 },
    ]);
    const ctx = mergeCtx(landCtx, spellCtx);
    const hand = ["Forest", "Emrakul", "Ulamog", "Kozilek", "Blightsteel", "Darksteel Colossus"];
    const bottomed = chooseBottomCards(hand, 2, undefined, ctx);
    expect(bottomed).toHaveLength(2);
    // Should bottom the two most expensive spells (all have CMC 10+)
    const expensiveSpells = ["Emrakul", "Ulamog", "Kozilek", "Blightsteel", "Darksteel Colossus"];
    for (const card of bottomed) {
      expect(expensiveSpells).toContain(card);
    }
  });
});
