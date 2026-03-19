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

  private parsePattern(pattern: string): Map<string, number> {
    const map = new Map<string, number>();
    for (const part of pattern.split("|")) {
      const colonIdx = part.indexOf(":");
      if (colonIdx < 0) continue;
      const v = parseFloat(part.slice(colonIdx + 1));
      if (!Number.isNaN(v)) map.set(part.slice(0, colonIdx), v);
    }
    return map;
  }

  private hammingDistance(a: Map<string, number>, b: Map<string, number>): number {
    let dist = 0;
    for (const [k, av] of a) {
      const bv = b.get(k);
      if (bv === undefined || Math.abs(av - bv) >= 0.5) dist++;
    }
    for (const k of b.keys()) {
      if (!a.has(k)) dist++;
    }
    return dist;
  }

  /**
   * Weighted average score for an action key across patterns near the query.
   * Patterns within maxDistance (Hamming) contribute with weight 1/(1+dist).
   */
  public fuzzyScore(pattern: string, actionKey: string, maxDistance = 3): number {
    const queryFeatures = this.parsePattern(pattern);
    let weightedSum = 0;
    let totalWeight = 0;
    for (const record of this.records.values()) {
      if (record.actionKey !== actionKey || record.visits === 0) continue;
      const dist = this.hammingDistance(queryFeatures, this.parsePattern(record.pattern));
      if (dist > maxDistance) continue;
      const weight = 1 / (1 + dist);
      weightedSum += (record.score / record.visits) * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? weightedSum / totalWeight : 0;
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

  /** Merge external records without duplicating visit counts (raw insert). */
  public merge(records: PatternRecord[]): void {
    for (const record of records) {
      const key = this.makeKey(record.pattern, record.actionKey);
      const existing = this.records.get(key);
      if (!existing) {
        this.records.set(key, { ...record });
      } else {
        existing.score += record.score;
        existing.visits += record.visits;
      }
    }
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
