import { describe, it, expect } from "vitest";
import { scoreArchetypeCategory } from "../archetypeMatcher.js";
import type { DeckInfo } from "../archetypeMatcher.js";

// Helper: build N cards with given metadata
function makeCards(
  count: number,
  overrides: Partial<{ isCreature: boolean; manaValue: number; isLand: boolean; oracleText: string }> = {}
) {
  return Array.from({ length: count }, (_, i) => ({
    name: `Card-${i}`,
    isCreature: overrides.isCreature ?? false,
    manaValue: overrides.manaValue ?? 3,
    isLand: overrides.isLand ?? false,
    oracleText: overrides.oracleText ?? "",
  }));
}

describe("scoreArchetypeCategory", () => {
  // ── AGGRO ─────────────────────────────────────────────────────────────────

  it("deck with 70% creatures and CMC 1-3 → AGGRO", () => {
    const creatures = makeCards(49, { isCreature: true, manaValue: 2 });
    const lands = makeCards(37, { isLand: true });
    const other = makeCards(14, { isCreature: false, manaValue: 3 });
    const deck: DeckInfo = {
      name: "Weenie Rush",
      cards: ["Goblin Guide", "Lightning Bolt", ...Array(98).fill("Card")],
      cardMetadata: [...creatures, ...lands, ...other],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.category).toBe("AGGRO");
    expect(result.score).toBeGreaterThan(0);
  });

  it("deck with goblin/haste card names → AGGRO", () => {
    const deck: DeckInfo = {
      name: "Goblin Horde",
      cards: ["Goblin Guide", "Goblin Warchief", "Haste enabler"],
      cardMetadata: [],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.category).toBe("AGGRO");
  });

  // ── CONTROL ───────────────────────────────────────────────────────────────

  it("deck with <30% creatures and counterspells → CONTROL", () => {
    const creatures = makeCards(15, { isCreature: true, manaValue: 4 });
    const lands = makeCards(37, { isLand: true });
    const spells = makeCards(48, {
      isCreature: false,
      manaValue: 3,
      oracleText: "counter target spell",
    });
    const deck: DeckInfo = {
      name: "Control Tower",
      cards: ["Counterspell", "Wrath of God", "Force of Will", ...Array(97).fill("Spell")],
      cardMetadata: [...creatures, ...lands, ...spells],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.category).toBe("CONTROL");
  });

  it("low creature ratio with wrath/counterspell card names → CONTROL", () => {
    const deck: DeckInfo = {
      name: "Permission Control",
      cards: ["Counterspell", "Supreme Verdict", "Force of Will", "Wrath"],
      cardMetadata: [],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.category).toBe("CONTROL");
  });

  // ── RAMP ──────────────────────────────────────────────────────────────────

  it("deck with bimodal mana curve (low CMC ramp + high CMC payoffs) → RAMP", () => {
    const rampSpells = makeCards(20, { isCreature: false, manaValue: 2 }); // CMC 1-2 ramp
    const payoffs = makeCards(15, { isCreature: true, manaValue: 7 });    // CMC 6+
    const lands = makeCards(37, { isLand: true });
    const mid = makeCards(28, { isCreature: false, manaValue: 4 });

    const deck: DeckInfo = {
      name: "Ramp Stompy",
      cards: ["Sol Ring", "Cultivate", "Mana Crypt", "Rampant Growth", ...Array(96).fill("Card")],
      cardMetadata: [...rampSpells, ...payoffs, ...lands, ...mid],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.category).toBe("RAMP");
  });

  it("Sol Ring and Cultivate card names → RAMP", () => {
    const deck: DeckInfo = {
      name: "Green Ramp",
      cards: ["Sol Ring", "Cultivate", "Kodama's Reach", "Mana Crypt"],
      cardMetadata: [],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.category).toBe("RAMP");
  });

  // ── Commander hints ───────────────────────────────────────────────────────

  it("Kinnan, Bonder Prodigy commander → RAMP", () => {
    const deck: DeckInfo = {
      name: "Kinnan Combo",
      commander: "kinnan, bonder prodigy",
      cards: Array(99).fill("Forest"),
      cardMetadata: [],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.category).toBe("RAMP");
  });

  it("Najeela commander → AGGRO", () => {
    const deck: DeckInfo = {
      name: "Najeela Warriors",
      commander: "najeela, the blade-blossom",
      cards: Array(99).fill("Warrior"),
      cardMetadata: [],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.category).toBe("AGGRO");
  });

  // ── Confidence ───────────────────────────────────────────────────────────

  it("returns confidence between 0 and 1", () => {
    const deck: DeckInfo = {
      name: "Test",
      cards: ["Sol Ring", "Cultivate", "Forest"],
      cardMetadata: [],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("returns reasons array with at least one entry when signals are found", () => {
    const deck: DeckInfo = {
      name: "Goblin Aggro",
      cards: ["Goblin Guide", "Lightning Bolt"],
      cardMetadata: [],
    };
    const result = scoreArchetypeCategory(deck);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  // ── MATCHUP_MODE helpers (assignDecksForEpisode-level) ───────────────────

  it("round-robin: 2 decks alternate across episodes", () => {
    // Simulate assignDecksForEpisode logic inline
    const decks = ["DeckA", "DeckB"];
    const n = decks.length;
    const playerCount = 4;

    const assignments = Array.from({ length: 6 }, (_, ep) =>
      Array.from({ length: playerCount }, (__, p) => decks[(ep + p) % n])
    );

    // Episode 0: [A, B, A, B]
    expect(assignments[0]).toEqual(["DeckA", "DeckB", "DeckA", "DeckB"]);
    // Episode 1: [B, A, B, A]
    expect(assignments[1]).toEqual(["DeckB", "DeckA", "DeckB", "DeckA"]);
    // Episode 2: same as ep 0 (cycle)
    expect(assignments[2]).toEqual(["DeckA", "DeckB", "DeckA", "DeckB"]);
  });

  it("random: 4 decks — distribution not completely skewed over 100 episodes", () => {
    const decks = ["A", "B", "C", "D"];
    const n = decks.length;
    const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };

    for (let ep = 0; ep < 100; ep++) {
      const idx = Math.floor(Math.random() * n);
      counts[decks[idx]]++;
    }

    // Each deck should appear at least 5 times out of 100 (very loose)
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThanOrEqual(5);
    }
  });
});
