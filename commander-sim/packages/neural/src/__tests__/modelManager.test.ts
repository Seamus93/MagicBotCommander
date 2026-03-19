import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveModel, loadModel, latestModel } from "../modelManager.js";
import { PolicyNet } from "../policyNet.js";
import type { TrainingExample } from "../policyNet.js";
import { FEATURE_SIZE } from "../featureVector.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "neural-test-"));
}

function makeFeatures(): number[] {
  return Array(FEATURE_SIZE)
    .fill(0)
    .map((_, i) => i / FEATURE_SIZE);
}

describe("saveModel / loadModel / latestModel", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("latestModel returns null for empty directory", () => {
    expect(latestModel(dir)).toBeNull();
  });

  it("latestModel returns null for non-existent directory", () => {
    const nonExistent = path.join(dir, "does-not-exist");
    expect(latestModel(nonExistent)).toBeNull();
  });

  it("saveModel creates a versioned file starting at v1", () => {
    const net = new PolicyNet();
    const result = saveModel(net, dir);
    expect(result.version).toBe(1);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path).toContain("v1.json");
  });

  it("saveModel increments version on second save", () => {
    const net = new PolicyNet();
    const r1 = saveModel(net, dir);
    const r2 = saveModel(net, dir);
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
  });

  it("latestModel finds the highest version", () => {
    const net = new PolicyNet();
    saveModel(net, dir);
    saveModel(net, dir);
    const latest = latestModel(dir);
    expect(latest).not.toBeNull();
    expect(latest?.version).toBe(2);
  });

  it("loadModel restores weights accurately", () => {
    const net = new PolicyNet();
    // Train briefly to change weights from initialization
    const batch: TrainingExample[] = Array.from({ length: 8 }, () => ({
      features: makeFeatures(),
      actionIndex: 2,
      reward: 1.0,
    }));
    net.train(batch, 0.01);

    const { path: filePath } = saveModel(net, dir);
    const loaded = loadModel(filePath);

    const features = makeFeatures();
    const probsBefore = net.forward(features);
    const probsAfter = loaded.forward(features);

    probsBefore.forEach((p, i) => {
      expect(p).toBeCloseTo(probsAfter[i], 4);
    });
  });

  it("loadModel throws on non-existent file", () => {
    expect(() => loadModel(path.join(dir, "missing.json"))).toThrow();
  });

  it("saved file contains valid JSON with metadata", () => {
    const net = new PolicyNet();
    const { path: filePath } = saveModel(net, dir);
    const raw = fs.readFileSync(filePath, "utf8");
    const meta = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof meta.version).toBe("number");
    expect(typeof meta.trainedAt).toBe("string");
    expect(typeof meta.inputSize).toBe("number");
    expect(typeof meta.outputSize).toBe("number");
    expect(Array.isArray(meta.layerSizes)).toBe(true);
    expect(Array.isArray(meta.weights)).toBe(true);
  });

  it("loadModel → setWeights dimension mismatch throws", () => {
    const net = new PolicyNet();
    const { path: filePath } = saveModel(net, dir);
    // Corrupt weights in the file
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    raw.weights = [[1, 2, 3]]; // wrong size
    fs.writeFileSync(filePath, JSON.stringify(raw));
    expect(() => loadModel(filePath)).toThrow();
  });
});
