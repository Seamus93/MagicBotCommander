import fs from "node:fs";
import path from "node:path";

export interface PatternRecord {
  pattern: string;
  actionKey: string;
  score: number;
  visits: number;
}

export class PatternStore {
  private readonly records = new Map<string, PatternRecord>();

  constructor(initial?: PatternRecord[]) {
    initial?.forEach((record) => {
      const key = this.makeKey(record.pattern, record.actionKey);
      this.records.set(key, { ...record });
    });
  }

  private makeKey(pattern: string, actionKey: string) {
    return `${pattern}::${actionKey}`;
  }

  public get(pattern: string, actionKey: string): PatternRecord | undefined {
    return this.records.get(this.makeKey(pattern, actionKey));
  }

  public observe(pattern: string, actionKey: string, deltaScore: number) {
    const key = this.makeKey(pattern, actionKey);
    const current = this.records.get(key);
    if (!current) {
      this.records.set(key, {
        pattern,
        actionKey,
        score: deltaScore,
        visits: 1,
      });
    } else {
      current.score += deltaScore;
      current.visits += 1;
    }
  }

  public bestAction(pattern: string): PatternRecord | undefined {
    let best: PatternRecord | undefined;
    for (const record of this.records.values()) {
      if (record.pattern !== pattern) continue;
      if (!best || record.score / record.visits > best.score / best.visits) {
        best = record;
      }
    }
    return best;
  }

  public entries(): PatternRecord[] {
    return [...this.records.values()];
  }

  public toJSON(): PatternRecord[] {
    return this.entries();
  }

  static load(filePath: string): PatternStore {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      const data = JSON.parse(text) as PatternRecord[];
      return new PatternStore(data);
    } catch (err) {
      console.warn(`[PatternStore] Unable to load ${filePath}:`, err);
      return new PatternStore();
    }
  }

  save(filePath: string) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.toJSON(), null, 2), "utf8");
  }
}

export const patternFromFeatures = (features: Record<string, number>) =>
  Object.entries(features)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v.toFixed(2)}`)
    .join("|");

export const actionToKey = (actionType: string, card: string) =>
  `${actionType}:${card ?? "NONE"}`;
