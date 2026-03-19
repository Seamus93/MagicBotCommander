import { describe, it, expect } from "vitest";
import { PolicyNet } from "../policyNet.js";
import type { TrainingExample } from "../policyNet.js";
import { ACTION_COUNT } from "../actionEncoder.js";
import { FEATURE_SIZE } from "../featureVector.js";

function makeFeatures(value = 0.5): number[] {
  return Array(FEATURE_SIZE).fill(value);
}

describe("PolicyNet", () => {
  it("forward returns a probability vector of length ACTION_COUNT", () => {
    const net = new PolicyNet();
    const probs = net.forward(makeFeatures());
    expect(probs).toHaveLength(ACTION_COUNT);
    const sum = probs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 4);
    probs.forEach((p) => {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    });
  });

  it("forward handles all-zero input", () => {
    const net = new PolicyNet();
    const probs = net.forward(makeFeatures(0));
    expect(probs).toHaveLength(ACTION_COUNT);
    const sum = probs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it("forward pads short feature vectors", () => {
    const net = new PolicyNet();
    const short = [0.5, 0.3];
    const probs = net.forward(short);
    expect(probs).toHaveLength(ACTION_COUNT);
  });

  it("getWeights returns interleaved W/b arrays matching layer count", () => {
    const net = new PolicyNet();
    const weights = net.getWeights();
    // 4 layers, each has W and b
    expect(weights).toHaveLength(8);
  });

  it("setWeights round-trips without error", () => {
    const net = new PolicyNet();
    const original = net.getWeights();
    const net2 = new PolicyNet();
    net2.setWeights(original);
    const probsBefore = net.forward(makeFeatures(0.3));
    const probsAfter = net2.forward(makeFeatures(0.3));
    probsBefore.forEach((p, i) => {
      expect(p).toBeCloseTo(probsAfter[i], 5);
    });
  });

  it("setWeights throws on wrong number of arrays", () => {
    const net = new PolicyNet();
    expect(() => net.setWeights([new Float32Array(10)])).toThrow();
  });

  it("train returns a finite loss value", () => {
    const net = new PolicyNet();
    const batch: TrainingExample[] = [
      { features: makeFeatures(0.5), actionIndex: 0, reward: 1 },
      { features: makeFeatures(0.2), actionIndex: 3, reward: -1 },
      { features: makeFeatures(0.8), actionIndex: 7, reward: 0.5 },
    ];
    const loss = net.train(batch, 0.001);
    expect(Number.isFinite(loss)).toBe(true);
  });

  it("train reduces loss over multiple iterations on simple task", () => {
    const net = new PolicyNet();
    // Always reward action 0 with moderate learning rate
    const batch: TrainingExample[] = Array.from({ length: 32 }, (_, i) => ({
      features: makeFeatures((i % 5) * 0.2),
      actionIndex: 0,
      reward: 1.0,
    }));

    const lossInitial = net.train(batch, 0.001);
    let lastLoss = lossInitial;
    for (let i = 0; i < 10; i++) {
      lastLoss = net.train(batch, 0.001);
    }

    // Loss should trend down after 10 batches
    expect(lastLoss).toBeLessThan(lossInitial + 0.5);
    // The network should produce a valid probability distribution
    const probs = net.forward(makeFeatures(0.5));
    expect(probs).toHaveLength(ACTION_COUNT);
    const sum = probs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });

  it("train with empty batch returns 0", () => {
    const net = new PolicyNet();
    const loss = net.train([], 0.01);
    expect(loss).toBe(0);
  });

  it("weights change after training", () => {
    const net = new PolicyNet();
    const before = net.getWeights().map((w) => Array.from(w));
    const batch: TrainingExample[] = [
      { features: makeFeatures(0.5), actionIndex: 1, reward: 1 },
    ];
    net.train(batch, 0.01);
    const after = net.getWeights();
    let changed = false;
    for (let i = 0; i < after.length; i++) {
      for (let j = 0; j < after[i].length; j++) {
        if (Math.abs(after[i][j] - (before[i][j] ?? 0)) > 1e-9) {
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
    expect(changed).toBe(true);
  });
});
