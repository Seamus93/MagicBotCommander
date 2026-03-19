/**
 * ExperienceReplayBuffer — samples training examples from DB (priority) or JSONL file.
 *
 * DB path: uses Prisma EpisodeStep, weighted sampling by |shapedReward|.
 * JSONL path: random-seek byte-offset sampling, parses lines into TrainingExamples.
 */

import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import type { TrainingExample } from "./policyNet.js";
import { featuresToVector, extractFeaturesFromState } from "./featureVector.js";

const DEFAULT_BATCH_SIZE = Number(process.env.REPLAY_BATCH_SIZE ?? 256);
const DEFAULT_PRIORITY_ALPHA = Number(process.env.REPLAY_PRIORITY_ALPHA ?? 0.6);
const DEFAULT_RECENT_RUNS = Number(process.env.REPLAY_RECENT_RUNS ?? 10);
const PRIORITY_EPSILON = 0.01;

export interface ExperienceReplayOptions {
  dbUrl?: string;
  batchSize?: number;
  priorityAlpha?: number;
  recentRuns?: number;
}

export class ExperienceReplayBuffer {
  private batchSize: number;
  private priorityAlpha: number;
  private recentRuns: number;
  private prisma: PrismaClient | null;

  constructor(options: ExperienceReplayOptions = {}) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.priorityAlpha = options.priorityAlpha ?? DEFAULT_PRIORITY_ALPHA;
    this.recentRuns = options.recentRuns ?? DEFAULT_RECENT_RUNS;
    const dbUrl = options.dbUrl ?? process.env.DATABASE_URL;
    this.prisma = dbUrl ? new PrismaClient() : null;
  }

  /**
   * Sample a batch from the database using priority weighting.
   * Priority = (|shapedReward| + epsilon)^alpha.
   * Queries a large pool (batchSize * 10) and subsamples.
   */
  async sampleBatch(): Promise<TrainingExample[]> {
    if (!this.prisma) return [];

    try {
      // Get recent runs for scoping
      const recentRunIds = await this.getRecentRunIds();

      const poolSize = this.batchSize * 10;
      type EpisodeStepRow = {
        state: unknown;
        shapedReward: number | null;
        reward: number | null;
      };

      // Fetch a larger pool, then subsample by priority
      const pool: EpisodeStepRow[] = await (this.prisma as PrismaClient & {
        episodeStep: {
          findMany: (args: {
            where: { episode: { runId?: { in: number[] } }; state: { not: null } };
            select: { state: boolean; shapedReward: boolean; reward: boolean };
            take: number;
            orderBy: { id: string };
          }) => Promise<EpisodeStepRow[]>;
        };
      }).episodeStep.findMany({
        where: {
          episode: recentRunIds.length ? { runId: { in: recentRunIds } } : {},
          state: { not: null },
        },
        select: {
          state: true,
          shapedReward: true,
          reward: true,
        },
        take: poolSize,
        orderBy: { id: "desc" },
      });

      if (pool.length === 0) return [];

      // Compute priorities
      const priorities = pool.map((row) => {
        const r = row.shapedReward ?? row.reward ?? 0;
        return Math.pow(Math.abs(r) + PRIORITY_EPSILON, this.priorityAlpha);
      });
      const totalPriority = priorities.reduce((a, b) => a + b, 0);

      // Weighted subsample
      const result: TrainingExample[] = [];
      const target = Math.min(this.batchSize, pool.length);

      for (let i = 0; i < target * 3 && result.length < target; i++) {
        const rand = Math.random() * totalPriority;
        let cumSum = 0;
        let selected = 0;
        for (let j = 0; j < priorities.length; j++) {
          cumSum += priorities[j];
          if (rand <= cumSum) {
            selected = j;
            break;
          }
        }

        const row = pool[selected];
        const featureRecord = extractFeaturesFromState(row.state);
        if (!featureRecord) continue;

        const features = featuresToVector(featureRecord);
        const reward = row.shapedReward ?? row.reward ?? 0;
        // Derive action index from state if possible; default to 0
        result.push({ features, actionIndex: 0, reward });
      }

      return result;
    } catch {
      return [];
    } finally {
      await this.prisma.$disconnect().catch(() => {});
    }
  }

  /**
   * Sample training examples from a JSONL dataset file.
   * Uses random byte-offset sampling for large files.
   */
  sampleFromDataset(filepath: string): TrainingExample[] {
    if (!fs.existsSync(filepath)) return [];

    try {
      const stat = fs.statSync(filepath);
      const fileSize = stat.size;
      if (fileSize === 0) return [];

      const fd = fs.openSync(filepath, "r");
      const results: TrainingExample[] = [];
      const target = this.batchSize;
      const maxAttempts = target * 5;

      // Buffer for reading chunks
      const chunkSize = 2048;
      const buf = Buffer.alloc(chunkSize);

      for (let attempt = 0; attempt < maxAttempts && results.length < target; attempt++) {
        // Pick a random byte offset
        const offset = Math.floor(Math.random() * Math.max(1, fileSize - 1));
        const bytesRead = fs.readSync(fd, buf, 0, chunkSize, offset);
        if (bytesRead === 0) continue;

        const chunk = buf.subarray(0, bytesRead).toString("utf8");

        // Find the start of a complete line (after first newline or at offset 0)
        let lineStart = chunk.indexOf("\n");
        if (lineStart === -1) continue;
        lineStart += 1;

        // Find the end of this line
        const lineEnd = chunk.indexOf("\n", lineStart);
        const rawLine =
          lineEnd === -1
            ? chunk.slice(lineStart).trim()
            : chunk.slice(lineStart, lineEnd).trim();

        if (!rawLine) continue;

        const example = parseJsonlLine(rawLine);
        if (example) results.push(example);
      }

      fs.closeSync(fd);
      return results;
    } catch {
      return [];
    }
  }

  private async getRecentRunIds(): Promise<number[]> {
    if (!this.prisma) return [];
    try {
      type RunRow = { id: number };
      const runs: RunRow[] = await (this.prisma as PrismaClient & {
        simulationRun: {
          findMany: (args: {
            orderBy: { id: string };
            take: number;
            select: { id: boolean };
          }) => Promise<RunRow[]>;
        };
      }).simulationRun.findMany({
        orderBy: { id: "desc" },
        take: this.recentRuns,
        select: { id: true },
      });
      return runs.map((r) => r.id);
    } catch {
      return [];
    }
  }
}

/** Parse a single JSONL line into a TrainingExample, or return null on failure. */
function parseJsonlLine(line: string): TrainingExample | null {
  if (!line.startsWith("{")) return null;

  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const state = obj.state;
    const reward =
      typeof obj.shapedReward === "number"
        ? obj.shapedReward
        : typeof obj.reward === "number"
          ? obj.reward
          : 0;

    const featureRecord = extractFeaturesFromState(state);
    if (!featureRecord) return null;

    const features = featuresToVector(featureRecord);

    // Encode action index from action field
    const action = obj.action as Record<string, unknown> | undefined;
    const actionType = typeof action?.type === "string" ? action.type : "PASS_TURN";
    const actionIndex = encodeActionTypeString(actionType, action);

    return { features, actionIndex, reward };
  } catch {
    return null;
  }
}

function encodeActionTypeString(
  type: string,
  action?: Record<string, unknown>
): number {
  switch (type) {
    case "PASS_TURN": return 0;
    case "PLAY_LAND": return 1;
    case "CAST_SPELL": return 7; // default to "other" without typeLine
    case "ATTACK_CHOICE":
      return action?.mode === "ATTACK" ? 8 : 10;
    case "BLOCK_CHOICE":
      return action?.targetId ? 9 : 10;
    default: return 0;
  }
}
