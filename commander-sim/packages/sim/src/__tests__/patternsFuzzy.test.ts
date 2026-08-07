import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PatternStore,
  actionToKey,
  describeActionKey,
  fuzzyFamilyKeyForAction,
  patternFromFeatures,
} from "../patterns.js";
import {
  decisionTelemetrySnapshot,
  resetDecisionTimings,
} from "../decisionProfiler.js";
import type { PatternRecord } from "../patterns.js";

const basePattern = patternFromFeatures({ turn: 1, hand: 3, life: 4 });

describe("PatternStore fuzzy lookup", () => {
  beforeEach(() => {
    resetDecisionTimings();
  });

  it("narrow lookup returns the same best aggregate as legacy lookup on controlled exact-key data", () => {
    const key = actionToKey("CAST_SPELL", "Murder", {
      type: "CAST_SPELL",
      card: "Murder",
      targets: [{ type: "permanent", id: "perm_1" }],
    });
    const records: PatternRecord[] = [
      { pattern: basePattern, actionKey: key, score: 20, visits: 10 },
      { pattern: patternFromFeatures({ turn: 1, hand: 4, life: 4 }), actionKey: key, score: 5, visits: 5 },
      { pattern: basePattern, actionKey: actionToKey("CAST_SPELL", "Sol Ring"), score: 100, visits: 100 },
    ];
    const store = new PatternStore(records);

    const indexed = store.fuzzyRecord(basePattern, key);
    const legacy = store.fuzzyRecordLegacyForTest(basePattern, key);

    expect(indexed?.scorePerVisit).toBeCloseTo(legacy?.scorePerVisit ?? 0, 8);
    expect(indexed?.visits).toBe(legacy?.visits);
  });

  it("falls back to a wider target-family bucket when the exact target key is absent", () => {
    const learnedKey = actionToKey("CAST_SPELL", "Murder", {
      type: "CAST_SPELL",
      card: "Murder",
      targets: [{ type: "permanent", id: "perm_1" }],
    });
    const queryKey = actionToKey("CAST_SPELL", "Murder", {
      type: "CAST_SPELL",
      card: "Murder",
      targets: [{ type: "permanent", id: "perm_2" }],
    });
    const store = new PatternStore([
      { pattern: basePattern, actionKey: learnedKey, score: 12, visits: 6 },
    ]);

    const fuzzy = store.fuzzyRecord(basePattern, queryKey);

    expect(fuzzy?.scorePerVisit).toBeCloseTo(2);
    expect(describeActionKey(learnedKey).targetFamily).toBe("permanent");
    expect(describeActionKey(queryKey).normalized).toBe(describeActionKey(learnedKey).normalized);
  });

  it("candidate cap is deterministic and prefers cheap high-signal records before scoring", async () => {
    vi.resetModules();
    vi.stubEnv("MAX_FUZZY_CANDIDATES", "2");
    const { PatternStore: Store, patternFromFeatures: features } = await import("../patterns.js");
    const { decisionTelemetrySnapshot: snapshot, resetDecisionTimings: reset } = await import("../decisionProfiler.js");
    reset();
    const key = "PASS_TURN:NONE";
    const records = Array.from({ length: 8 }, (_, idx) => ({
      pattern: features({ turn: idx, hand: idx, life: idx }),
      actionKey: key,
      score: idx + 1,
      visits: idx + 1,
      lastUpdated: `2026-01-0${Math.min(9, idx + 1)}T00:00:00.000Z`,
    }));

    const first = new Store(records).fuzzyRecord(basePattern, key, 99);
    reset();
    const second = new Store([...records].reverse()).fuzzyRecord(basePattern, key, 99);
    const telemetry = snapshot();

    expect(first?.scorePerVisit).toBeCloseTo(second?.scorePerVisit ?? 0, 8);
    expect(telemetry.samples.fuzzyCappedCandidates?.[0]).toBe(2);
    vi.unstubAllEnvs();
  });

  it("fuzzy timeout returns quickly without marking policy dirty", async () => {
    vi.resetModules();
    vi.stubEnv("MAX_FUZZY_LOOKUP_MS", "0.0001");
    vi.stubEnv("FUZZY_TIMEOUT_CHECK_INTERVAL", "1");
    vi.stubEnv("MAX_FUZZY_CANDIDATES", "10000");
    const { PatternStore: Store, patternFromFeatures: features } = await import("../patterns.js");
    const { decisionTelemetrySnapshot: snapshot, resetDecisionTimings: reset } = await import("../decisionProfiler.js");
    reset();
    const key = "PASS_TURN:NONE";
    const records = Array.from({ length: 2000 }, (_, idx) => ({
      pattern: features({ turn: idx % 40, hand: idx % 8, life: idx % 40, board: idx % 20 }),
      actionKey: key,
      score: 1,
      visits: 1,
    }));
    const store = new Store(records);

    store.fuzzyRecord(basePattern, key, 99);
    const telemetry = snapshot();

    expect(telemetry.counters.fuzzyLookupTimeouts).toBeGreaterThanOrEqual(1);
    expect(store.dirtyCount).toBe(0);
    vi.unstubAllEnvs();
  });

  it("Date.now jump does not influence fuzzy timeout", async () => {
    vi.resetModules();
    vi.stubEnv("MAX_FUZZY_LOOKUP_MS", "250");
    vi.stubEnv("MAX_FUZZY_COMPARISONS_PER_LOOKUP", "100");
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(9_999_999_999_999);
    const { PatternStore: Store, patternFromFeatures: features } = await import("../patterns.js");
    const { decisionTelemetrySnapshot: snapshot, resetDecisionTimings: reset } = await import("../decisionProfiler.js");
    reset();
    const key = "PLAY_LAND:High Market";
    const pattern = features({ turn: 1, hand: 2 });
    const store = new Store([{ pattern, actionKey: key, score: 3, visits: 3 }]);

    const fuzzy = store.fuzzyRecord(pattern, key, 99);
    const telemetry = snapshot();

    expect(fuzzy?.scorePerVisit).toBe(1);
    expect(telemetry.counters.fuzzyLookupTimeouts ?? 0).toBe(0);
    dateSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("comparison budget interrupts deterministically and returns best-so-far", async () => {
    vi.resetModules();
    vi.stubEnv("MAX_FUZZY_LOOKUP_MS", "250");
    vi.stubEnv("MAX_FUZZY_COMPARISONS_PER_LOOKUP", "1");
    vi.stubEnv("FUZZY_TIMEOUT_CHECK_INTERVAL", "16");
    const { PatternStore: Store, patternFromFeatures: features } = await import("../patterns.js");
    const { decisionTelemetrySnapshot: snapshot, resetDecisionTimings: reset } = await import("../decisionProfiler.js");
    reset();
    const key = "PLAY_LAND:High Market";
    const pattern = features({ turn: 1, hand: 2 });
    const store = new Store([
      { pattern, actionKey: key, score: 10, visits: 5 },
      { pattern: features({ turn: 2, hand: 2 }), actionKey: key, score: -10, visits: 5 },
    ]);

    const fuzzy = store.fuzzyRecord(pattern, key, 99);
    const telemetry = snapshot();

    expect(fuzzy?.scorePerVisit).toBeCloseTo(2);
    expect(telemetry.counters.fuzzyLookupTimeouts).toBe(1);
    expect(telemetry.counters["fuzzyTimeoutReason.COMPARISON_BUDGET"]).toBe(1);
    expect(telemetry.counters.similarityComparisons).toBe(2);
    vi.unstubAllEnvs();
  });

  it("monotonic gap interrupts lookup and separates external pause from CPU", async () => {
    vi.resetModules();
    vi.stubEnv("MAX_FUZZY_LOOKUP_MS", "250");
    vi.stubEnv("FUZZY_MONOTONIC_GAP_MS", "5");
    vi.stubEnv("FUZZY_TIMEOUT_CHECK_INTERVAL", "1");
    let now = 0n;
    const hrSpy = vi.spyOn(process.hrtime, "bigint").mockImplementation(() => {
      now += now === 0n ? 1_000_000n : 10_000_000n;
      return now;
    });
    const { PatternStore: Store, patternFromFeatures: features } = await import("../patterns.js");
    const { decisionTelemetrySnapshot: snapshot, resetDecisionTimings: reset } = await import("../decisionProfiler.js");
    reset();
    const key = "PLAY_LAND:High Market";
    const pattern = features({ turn: 1, hand: 2 });
    const store = new Store(Array.from({ length: 4 }, (_, idx) => ({
      pattern: features({ turn: idx, hand: 2 }),
      actionKey: key,
      score: 1,
      visits: 1,
    })));

    store.fuzzyRecord(pattern, key, 99);
    const telemetry = snapshot();

    expect(telemetry.counters.monotonicGapDetected).toBe(1);
    expect(telemetry.counters["fuzzyTimeoutReason.MONOTONIC_GAP"]).toBe(1);
    expect(telemetry.timingsMs["AI external pause"]).toBeGreaterThan(0);
    expect(telemetry.timingsMs["AI fuzzy similarity cpu"] ?? 0).toBeLessThan(telemetry.timingsMs["AI external pause"]);
    hrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("records fuzzy telemetry counters and samples", () => {
    const key = "PLAY_LAND:Forest";
    const store = new PatternStore([
      { pattern: basePattern, actionKey: key, score: 3, visits: 3 },
      { pattern: patternFromFeatures({ turn: 2, hand: 3, life: 4 }), actionKey: key, score: 2, visits: 2 },
    ]);

    store.fuzzyRecord(basePattern, key);
    const telemetry = decisionTelemetrySnapshot();

    expect(telemetry.counters.fuzzyLookupCount).toBe(1);
    expect(telemetry.counters.fuzzyCandidatesTotal).toBe(2);
    expect(telemetry.counters.similarityComparisons).toBe(2);
    expect(telemetry.samples.fuzzyCandidates).toEqual([2]);
    expect(telemetry.samples.similarityComparisonsPerDecision).toEqual([2]);
  });

  it("attack plans with different permanent IDs keep exact identity but share fuzzy family", () => {
    const left = [
      "ATTACK_PLAN",
      "target=3",
      "ids=creature_15797,creature_15806",
      "count=2",
      "power=2",
      "toughness=2",
      "evasion=1",
      "value=2",
      "commander=0",
      "lethal=no",
      "damage=2",
      "loss=1",
      "targetThreat=high",
      "board=2",
    ].join(":");
    const right = left.replace("creature_15797,creature_15806", "creature_1,creature_2");

    expect(left).not.toBe(right);
    expect(fuzzyFamilyKeyForAction(left)).toBe(fuzzyFamilyKeyForAction(right));
  });

  it("commander and token spell targets remain semantically distinct", () => {
    const commander = actionToKey("CAST_SPELL", "Murder", {
      type: "CAST_SPELL",
      card: "Murder",
      targetId: "creature_1",
      targetSemantic: "type=creature,value=4,commander=yes,token=no,pt=3,engine=2",
    });
    const token = actionToKey("CAST_SPELL", "Murder", {
      type: "CAST_SPELL",
      card: "Murder",
      targetId: "token_1",
      targetSemantic: "type=creature,value=1,commander=no,token=yes,pt=1,engine=0",
    });

    expect(commander).not.toBe(token);
    expect(describeActionKey(commander).normalized).not.toBe(describeActionKey(token).normalized);
  });

  it("combat fuzzy index separates different attacker counts before scoring", () => {
    const countOne = "ATTACK_PLAN:target=3:ids=a:count=1:power=1:toughness=1:evasion=0:value=1:commander=0:lethal=no:damage=1:loss=0:targetThreat=medium:board=1";
    const countTwo = "ATTACK_PLAN:target=3:ids=b,c:count=2:power=2:toughness=2:evasion=0:value=2:commander=0:lethal=no:damage=2:loss=0:targetThreat=medium:board=1";
    const query = countTwo.replace("ids=b,c", "ids=x,y");
    const store = new PatternStore([
      { pattern: basePattern, actionKey: countOne, score: 10, visits: 5 },
      { pattern: basePattern, actionKey: countTwo, score: 20, visits: 5 },
    ]);

    const fuzzy = store.fuzzyRecord(basePattern, query);
    const telemetry = decisionTelemetrySnapshot();

    expect(fuzzy?.scorePerVisit).toBeCloseTo(4);
    expect(telemetry.samples.fuzzyCandidates).toEqual([1]);
  });

  it("semantic spell index returns the same best candidate on controlled data", () => {
    const learnedKey = actionToKey("CAST_SPELL", "Test Bolt", {
      type: "CAST_SPELL",
      card: "Test Bolt",
      targetPlayer: 1,
      spellType: "instant",
      manaBucket: "1",
      timing: "main_pre",
      targetSemantic: "type=player,value=0,threat=low,life=0",
    });
    const queryKey = actionToKey("CAST_SPELL", "Test Bolt", {
      type: "CAST_SPELL",
      card: "Test Bolt",
      targetPlayer: 2,
      spellType: "instant",
      manaBucket: "1",
      timing: "main_pre",
      targetSemantic: "type=player,value=0,threat=low,life=0",
    });
    const distractor = actionToKey("CAST_SPELL", "Test Bolt", {
      type: "CAST_SPELL",
      card: "Test Bolt",
      targetPlayer: 3,
      spellType: "instant",
      manaBucket: "1",
      timing: "main_pre",
      targetSemantic: "type=player,value=3,threat=critical,life=3",
    });
    const store = new PatternStore([
      { pattern: basePattern, actionKey: learnedKey, score: 15, visits: 5 },
      { pattern: basePattern, actionKey: distractor, score: 100, visits: 10 },
    ]);

    const fuzzy = store.fuzzyRecord(basePattern, queryKey);
    const telemetry = decisionTelemetrySnapshot();

    expect(fuzzy?.scorePerVisit).toBeCloseTo(3);
    expect(telemetry.samples.fuzzyCandidates).toEqual([1]);
  });

  it("semantic spell index progressively falls back from narrow to medium bucket", () => {
    const learnedKey = actionToKey("CAST_SPELL", "Test Bolt", {
      type: "CAST_SPELL",
      card: "Test Bolt",
      targetPlayer: 1,
      spellType: "instant",
      manaBucket: "1",
      targetSemantic: "type=player,value=0,threat=low,life=0",
    });
    const queryKey = actionToKey("CAST_SPELL", "Test Bolt", {
      type: "CAST_SPELL",
      card: "Test Bolt",
      targetPlayer: 2,
      spellType: "instant",
      manaBucket: "1",
      timing: "combat",
      targetSemantic: "type=player,value=0,threat=low,life=0",
    });
    const store = new PatternStore([
      { pattern: basePattern, actionKey: learnedKey, score: 8, visits: 4 },
    ]);

    const fuzzy = store.fuzzyRecord(basePattern, queryKey);

    expect(fuzzy?.scorePerVisit).toBeCloseTo(2);
  });

  it("activated ability semantic index is not fragmented by permanent IDs", () => {
    const left = actionToKey("ACTIVATE_ABILITY", "", {
      type: "ACTIVATE_ABILITY",
      sourcePermanentId: "perm_runtime_1",
      abilityId: "perm_runtime_1:TAP_ACTIVATED_EFFECT:0",
      sourceCard: "Spark Mage",
      effectFamily: "damage",
      costFamily: "tap",
      targets: [{ type: "player", id: 1 }],
      targetSemantic: "type=player,value=0,threat=low,life=0",
    });
    const right = actionToKey("ACTIVATE_ABILITY", "", {
      type: "ACTIVATE_ABILITY",
      sourcePermanentId: "perm_runtime_2",
      abilityId: "perm_runtime_2:TAP_ACTIVATED_EFFECT:0",
      sourceCard: "Spark Mage",
      effectFamily: "damage",
      costFamily: "tap",
      targets: [{ type: "player", id: 2 }],
      targetSemantic: "type=player,value=0,threat=low,life=0",
    });
    const store = new PatternStore([
      { pattern: basePattern, actionKey: left, score: 12, visits: 6 },
    ]);

    const fuzzy = store.fuzzyRecord(basePattern, right);

    expect(left).not.toBe(right);
    expect(fuzzyFamilyKeyForAction(left)).toBe(fuzzyFamilyKeyForAction(right));
    expect(fuzzy?.scorePerVisit).toBeCloseTo(2);
  });
});
