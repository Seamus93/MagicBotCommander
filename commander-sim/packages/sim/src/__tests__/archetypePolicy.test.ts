import { describe, it, expect, beforeEach } from "vitest";
import { PatternStore } from "../patterns.js";
import { ArchetypePolicy } from "../archetypePolicy.js";
import type { PatternRecord } from "../patterns.js";

describe("ArchetypePolicy", () => {
  let store: PatternStore;
  let policy: ArchetypePolicy;

  beforeEach(() => {
    store = new PatternStore();
    policy = new ArchetypePolicy(store);
  });

  // ── observe + bestAction ──────────────────────────────────────────────────

  it("observe + bestAction returns archetype-specific record after sufficient visits", () => {
    const pattern = "turn:0|hand:1|life:1";
    const actionKey = "CAST_SPELL";

    // Observe 5 times with positive reward in AGGRO partition
    for (let i = 0; i < 5; i++) {
      policy.observe("AGGRO", pattern, actionKey, 1);
    }

    const best = policy.bestAction("AGGRO", pattern);
    expect(best).toBeDefined();
    expect(best!.visits).toBeGreaterThanOrEqual(3);
    expect(best!.score).toBeGreaterThan(0);
  });

  it("observe writes to both archetype-specific and global partitions", () => {
    const pattern = "turn:0|hand:1|life:1";
    const actionKey = "PLAY_LAND";

    policy.observe("CONTROL", pattern, actionKey, 1);

    // archetype-specific record
    const archRec = store.get("CONTROL::" + pattern, actionKey);
    expect(archRec).toBeDefined();
    expect(archRec!.visits).toBe(1);

    // global record
    const globalRec = store.get(pattern, actionKey);
    expect(globalRec).toBeDefined();
    expect(globalRec!.visits).toBe(1);
  });

  // ── global fallback ───────────────────────────────────────────────────────

  it("scoreFor falls back to global partition when archetype-specific has too few visits", () => {
    const pattern = "turn:1|hand:2|life:1";
    const actionKey = "CAST_SPELL";

    // Only 1 visit in AGGRO partition (< MIN_ARCHETYPE_VISITS = 3)
    policy.observe("AGGRO", pattern, actionKey, 1);

    // Add 5 visits in global partition directly via observeGlobal
    for (let i = 0; i < 5; i++) {
      policy.observeGlobal(pattern, actionKey, 0.8);
    }

    const score = policy.scoreFor("AGGRO", pattern, actionKey);
    // Should use global score (~0.8), not the archetype score (1.0 from 1 visit)
    expect(score).toBeCloseTo(0.8, 1);
  });

  it("bestAction falls back to global when archetype partition has insufficient visits", () => {
    const pattern = "turn:0|hand:3|life:2";
    const actionKey = "PASS_TURN";

    // Only 1 visit in RAMP partition
    policy.observe("RAMP", pattern, actionKey, 0.5);

    // 5 visits in global partition
    for (let i = 0; i < 5; i++) {
      policy.observeGlobal(pattern, actionKey, 0.9);
    }

    const best = policy.bestAction("RAMP", pattern);
    expect(best).toBeDefined();
    // Should come from global partition with 5 visits (score = 5 * 0.9 = 4.5)
    expect(best!.visits).toBe(6); // 5 global + 1 from observe()
  });

  // ── importPolicy backward compatibility ───────────────────────────────────

  it("importPolicy with old format (no archetype prefix) loads into global partition", () => {
    const oldRecords: PatternRecord[] = [
      { pattern: "turn:0|hand:2|life:1", actionKey: "CAST_SPELL", score: 3, visits: 4 },
      { pattern: "turn:1|hand:1|life:0", actionKey: "PLAY_LAND", score: 2, visits: 3 },
    ];

    policy.importPolicy(oldRecords);

    // Should be accessible as global partition
    const rec1 = store.get("turn:0|hand:2|life:1", "CAST_SPELL");
    expect(rec1).toBeDefined();
    expect(rec1!.visits).toBe(4);

    const rec2 = store.get("turn:1|hand:1|life:0", "PLAY_LAND");
    expect(rec2).toBeDefined();
    expect(rec2!.visits).toBe(3);
  });

  it("importPolicy with archetype-prefixed records loads correctly", () => {
    const records: PatternRecord[] = [
      { pattern: "AGGRO::turn:0|hand:2|life:1", actionKey: "CAST_SPELL", score: 5, visits: 5 },
    ];

    policy.importPolicy(records);

    const rec = store.get("AGGRO::turn:0|hand:2|life:1", "CAST_SPELL");
    expect(rec).toBeDefined();
    expect(rec!.visits).toBe(5);
  });

  it("importPolicy merges with existing records (score and visits accumulate)", () => {
    policy.observe("AGGRO", "turn:0|hand:1|life:1", "CAST_SPELL", 1);

    const moreRecords: PatternRecord[] = [
      { pattern: "AGGRO::turn:0|hand:1|life:1", actionKey: "CAST_SPELL", score: 3, visits: 3 },
    ];

    policy.importPolicy(moreRecords);

    // Should accumulate: original had (score=1,visits=1), imported adds (score=3,visits=3)
    const rec = store.get("AGGRO::turn:0|hand:1|life:1", "CAST_SPELL");
    expect(rec).toBeDefined();
    expect(rec!.visits).toBe(4);
    expect(rec!.score).toBe(4);
  });

  // ── exportPolicy ─────────────────────────────────────────────────────────

  it("exportPolicy returns all records including archetype-specific partitions", () => {
    policy.observe("AGGRO", "turn:0|hand:1|life:1", "CAST_SPELL", 1);
    policy.observe("CONTROL", "turn:2|hand:3|life:2", "PASS_TURN", -1);

    const exported = policy.exportPolicy();
    // 4 records: 2 archetype-specific + 2 global
    expect(exported.length).toBe(4);
    const patterns = exported.map((r) => r.pattern);
    expect(patterns.some((p) => p.startsWith("AGGRO::"))).toBe(true);
    expect(patterns.some((p) => p.startsWith("CONTROL::"))).toBe(true);
  });
});
