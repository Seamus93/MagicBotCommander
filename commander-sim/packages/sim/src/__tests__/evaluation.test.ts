import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEvaluationAgentSpecs,
  calculateDelta,
  createEvaluationAgent,
  loadPolicySnapshot,
  parseEvaluationArgs,
  resetEvaluationDiagnosticsForTest,
  updateEloRatings,
  writeEvaluationFailure,
  writeEvaluationOutputs,
  type EvaluationMetricSummary,
  type EvaluationReport,
} from "../evaluation.js";
import {
  PatternStore,
  patternFromFeatures,
  patternStoreLifecycleSnapshot,
} from "../patterns.js";
import { decisionTelemetrySnapshot, profileDecisionBlock, resetDecisionTimings } from "../decisionProfiler.js";

const metric = (overrides: Partial<EvaluationMetricSummary> = {}): EvaluationMetricSummary => ({
  games: 10,
  winRate: 0.6,
  averagePlacement: 1.9,
  averageTurnSurvived: 12,
  averageGameLength: 14,
  commanderDamageDealt: 0,
  combatDamageDealt: 5,
  spellDamageDealt: 2,
  creaturesKilled: 3,
  creaturesLost: 2,
  cardsDrawn: 4,
  cardsCast: 5,
  landsPlayed: 6,
  manaSpent: 12,
  manaWasted: 3,
  unusedManaRate: 0.2,
  removalUsed: 1,
  removalOnHighValueTargetRate: 0.5,
  counterspellEfficiency: 0,
  attackFrequency: 0.1,
  blockFrequency: 0.05,
  lethalOpportunities: 2,
  lethalChosen: 1.5,
  lethalMissed: 0.5,
  averageBoardValue: 18,
  averageHandSize: 4,
  averageChooseActionMs: 3,
  exactRate: 0.3,
  fuzzyRate: 0.2,
  heuristicRate: 0.1,
  ...overrides,
});

describe("evaluation framework", () => {
  it("computes deltas as agent A minus agent B", () => {
    const delta = calculateDelta(metric({ winRate: 0.65, lethalMissed: 0.2 }), metric({ winRate: 0.5, lethalMissed: 0.5 }));

    expect(delta.winRate).toBeCloseTo(0.15);
    expect(delta.lethalMissed).toBeCloseTo(-0.3);
  });

  it("updates Elo and confidence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-elo-"));
    const eloPath = path.join(dir, "elo.json");

    const ratings = updateEloRatings(eloPath, "policy1000", "policy5000", 0.75, 100);

    expect(ratings.policy1000.rating).toBeGreaterThan(1000);
    expect(ratings.policy5000.rating).toBeLessThan(1000);
    expect(ratings.policy1000.gamesPlayed).toBe(100);
    expect(fs.existsSync(eloPath)).toBe(true);
  });

  it("loads a policy snapshot from file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-policy-"));
    const policyPath = path.join(dir, "policy-1000.json");
    const pattern = patternFromFeatures({ turn: 1 });
    fs.writeFileSync(policyPath, JSON.stringify([{ pattern, actionKey: "PASS_TURN:NONE", score: 3, visits: 2 }]), "utf8");

    const store = await loadPolicySnapshot(policyPath);

    expect(store.entries()).toHaveLength(1);
    expect(store.get(pattern, "PASS_TURN:NONE")?.visits).toBe(2);
  });

  it("loads and indexes the same snapshot only once", async () => {
    resetEvaluationDiagnosticsForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-policy-cache-"));
    const policyPath = path.join(dir, "policy-1000.json");
    fs.writeFileSync(policyPath, JSON.stringify([
      { pattern: "p", actionKey: "PASS_TURN:NONE", score: 1, visits: 1 },
    ]), "utf8");

    const left = await loadPolicySnapshot(policyPath);
    const right = await loadPolicySnapshot(policyPath);
    const lifecycle = patternStoreLifecycleSnapshot();

    expect(left).toBe(right);
    expect(lifecycle.policyFileReads).toBe(1);
    expect(lifecycle.policyJsonParseCount).toBe(1);
    expect(lifecycle.patternStoreBuildCount).toBe(1);
    expect(lifecycle.patternIndexBuildCount).toBe(1);
  });

  it("assigns shared policy to learned agent, not heuristic baseline", () => {
    const [heuristic, learned] = buildEvaluationAgentSpecs({
      games: 1,
      seed: 42,
      agentA: "heuristic",
      agentB: "learned",
      policy: "policy-1000.json",
      deckIds: [3],
      maxTurns: 40,
      outputDir: "tmp",
      eloFile: "tmp/elo.json",
      csvFile: "tmp/evaluations.csv",
    });

    expect(heuristic.policySnapshot).toBeUndefined();
    expect(learned.policySnapshot).toBe("policy-1000.json");
  });

  it("keeps CLI --policy shared instead of copying it to policyA", () => {
    const config = parseEvaluationArgs([
      "--games", "1",
      "--seed", "42",
      "--agentA", "heuristic",
      "--agentB", "learned",
      "--policy", "policy-1000.json",
    ]);
    const [heuristic, learned] = buildEvaluationAgentSpecs(config);

    expect(config.policyA).toBeUndefined();
    expect(config.policy).toBe("policy-1000.json");
    expect(heuristic.policySnapshot).toBeUndefined();
    expect(learned.policySnapshot).toBe("policy-1000.json");
  });

  it("writes JSON and appends CSV", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-output-"));
    const report = sampleReport(dir);

    const output = writeEvaluationOutputs(report, report.config);
    writeEvaluationOutputs(report, report.config);

    expect(fs.existsSync(output.jsonPath)).toBe(true);
    const csv = fs.readFileSync(output.csvPath, "utf8").trim().split("\n");
    expect(csv).toHaveLength(3);
    expect(csv[0]).toContain("generatedAt,commit,seed,games");
  });

  it("does not mutate PatternStore when used read-only", () => {
    const store = new PatternStore([{ pattern: "p", actionKey: "a", score: 1, visits: 1 }]);
    const beforeEntries = store.entries().length;
    const beforeDirty = store.dirtyCount;

    store.fuzzyRecord("p", "a");

    expect(store.entries()).toHaveLength(beforeEntries);
    expect(store.dirtyCount).toBe(beforeDirty);
  });

  it("evaluation agents do not write policy during finalize", async () => {
    const store = new PatternStore();
    const agent = await createEvaluationAgent({ slot: "B", id: "learned", kind: "learned" }, store);
    const learningHooks = agent as typeof agent & {
      finalizeEpisode?: (reward: number) => void;
      finalizeEpisodeWithRewards?: (rewards: number[]) => void;
    };

    learningHooks.finalizeEpisode?.(1);
    learningHooks.finalizeEpisodeWithRewards?.([1, 0.5]);

    expect(store.dirtyCount).toBe(0);
    expect(store.entries()).toHaveLength(0);
  });

  it("profiles a single operation with count and max input size", () => {
    resetDecisionTimings();

    const value = profileDecisionBlock("pattern.test", { inputSize: 7 }, () => "ok");
    const telemetry = decisionTelemetrySnapshot();

    expect(value).toBe("ok");
    expect(telemetry.operationBreakdowns["pattern.test"].count).toBe(1);
    expect(telemetry.operationBreakdowns["pattern.test"].maxInputSize).toBe(7);
  });

  it("writes deterministic failure report with seed and operation context", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-failure-"));
    const filePath = writeEvaluationFailure({
      games: 1,
      seed: 42,
      agentA: "heuristic",
      agentB: "learned",
      policy: "policy-1000.json",
      deckIds: [3],
      maxTurns: 40,
      outputDir: dir,
      eloFile: path.join(dir, "elo.json"),
      csvFile: path.join(dir, "evaluations.csv"),
    }, {
      gameIndex: 0,
      seed: 42,
      derivedSeed: 123,
      reason: "MAX_EPISODE_MS",
      currentOperation: "AI pattern generation",
      elapsedOperationMs: 101,
      recentActions: ["T1 main P0 PASS_TURN stack=0"],
    });

    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(payload.failure.seed).toBe(42);
    expect(payload.failure.gameIndex).toBe(0);
    expect(payload.failure.currentOperation).toBe("AI pattern generation");
  });

  it("same report input writes deterministic CSV row", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-deterministic-"));
    const left = sampleReport(dir);
    const right = sampleReport(dir);

    writeEvaluationOutputs(left, left.config);
    writeEvaluationOutputs(right, right.config);
    const lines = fs.readFileSync(left.config.csvFile, "utf8").trim().split("\n");

    expect(lines[1]).toBe(lines[2]);
  });
});

function sampleReport(dir: string): EvaluationReport {
  const config = {
    games: 10,
    seed: 42,
    agentA: "heuristic" as const,
    agentB: "learned" as const,
    deckIds: [3],
    maxTurns: 40,
    outputDir: dir,
    eloFile: path.join(dir, "elo.json"),
    csvFile: path.join(dir, "evaluations.csv"),
  };
  return {
    config,
    seed: 42,
    agents: [
      { slot: "A", id: "heuristic", kind: "heuristic" },
      { slot: "B", id: "learned", kind: "learned", policySnapshot: "policy-1000" },
    ],
    metrics: {
      heuristic: metric({ winRate: 0.6 }),
      learned: metric({ winRate: 0.4 }),
    },
    delta: calculateDelta(metric({ winRate: 0.6 }), metric({ winRate: 0.4 })),
    elo: {
      heuristic: { rating: 1010, confidence: 0.5, gamesPlayed: 10 },
      learned: { rating: 990, confidence: 0.5, gamesPlayed: 10 },
    },
    regression: { passed: true, failures: [] },
    durationMs: 123,
    commit: "abc123",
    policySnapshots: { learned: "policy-1000" },
    generatedAt: "2026-08-04T00:00:00.000Z",
  };
}
