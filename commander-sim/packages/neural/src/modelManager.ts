/**
 * ModelManager — versioned JSON save/load for PolicyNet weights.
 *
 * Files are stored as data/model.weights.v{N}.json with metadata.
 * Weights are serialized as Array<Array<number>> (from Float32Array).
 */

import fs from "node:fs";
import path from "node:path";
import { PolicyNet } from "./policyNet.js";

interface ModelMetadata {
  version: number;
  trainedAt: string;
  inputSize: number;
  outputSize: number;
  layerSizes: number[];
  weights: Array<Array<number>>;
}

const FILE_PATTERN = /^model\.weights\.v(\d+)\.json$/;

/**
 * Save a PolicyNet to versioned JSON file.
 * Returns the path and version number.
 */
export function saveModel(
  net: PolicyNet,
  dir: string
): { path: string; version: number } {
  fs.mkdirSync(dir, { recursive: true });

  const existing = latestModel(dir);
  const version = existing ? existing.version + 1 : 1;

  const weights = net.getWeights().map((arr) => Array.from(arr));
  const metadata: ModelMetadata = {
    version,
    trainedAt: new Date().toISOString(),
    inputSize: net.inputSize,
    outputSize: net.outputSize,
    layerSizes: net.layerSizes,
    weights,
  };

  const filePath = path.join(dir, `model.weights.v${version}.json`);
  fs.writeFileSync(filePath, JSON.stringify(metadata), "utf8");

  return { path: filePath, version };
}

/**
 * Load a PolicyNet from a versioned JSON file.
 * Validates layer dimensions before loading.
 */
export function loadModel(filePath: string): PolicyNet {
  const raw = fs.readFileSync(filePath, "utf8");
  const meta = JSON.parse(raw) as ModelMetadata;

  const net = new PolicyNet();

  if (meta.weights.length !== net.getWeights().length) {
    throw new Error(
      `loadModel: weight array count mismatch: expected ${net.getWeights().length}, got ${meta.weights.length}`
    );
  }

  const float32Weights = meta.weights.map((arr) => new Float32Array(arr));
  net.setWeights(float32Weights);

  return net;
}

/**
 * Find the highest-version model file in a directory.
 * Returns null if no model files exist.
 */
export function latestModel(
  dir: string
): { path: string; version: number } | null {
  if (!fs.existsSync(dir)) return null;

  let maxVersion = -1;
  let maxFile = "";

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const match = FILE_PATTERN.exec(file);
      if (!match) continue;
      const version = Number(match[1]);
      if (version > maxVersion) {
        maxVersion = version;
        maxFile = file;
      }
    }
  } catch {
    return null;
  }

  if (maxVersion < 0) return null;
  return { path: path.join(dir, maxFile), version: maxVersion };
}
