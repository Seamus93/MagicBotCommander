import fs from "node:fs";
import path from "node:path";
import type { SimAction, TargetRef } from "@game-state/types";

export interface PatternRecord {
  pattern: string;
  actionKey: string;
  score: number;
  visits: number;
  rewardSquaredSum?: number;
  winCount?: number;
  lossCount?: number;
  lastUpdated?: string;
}

export interface PatternScoreRecord extends PatternRecord {
  source: "exact" | "fuzzy";
}

export class PatternStore {
  private readonly records = new Map<string, PatternRecord>();
  private readonly dirtyKeys = new Set<string>();
  private readonly recordsByActionKey = new Map<string, Set<PatternRecord>>();
  private readonly parsedPatternCache = new Map<string, Map<string, number>>();

  constructor(initial?: PatternRecord[]) {
    initial?.forEach((record) => {
      const key = this.makeKey(record.pattern, record.actionKey);
      this.setRecord(key, this.normalizeRecord(record));
    });
  }

  private makeKey(pattern: string, actionKey: string) {
    return `${pattern}::${actionKey}`;
  }

  private parsePattern(pattern: string): Map<string, number> {
    const cached = this.parsedPatternCache.get(pattern);
    if (cached) return cached;
    const map = new Map<string, number>();
    for (const part of pattern.split("|")) {
      const colonIdx = part.indexOf(":");
      if (colonIdx < 0) continue;
      const v = parseFloat(part.slice(colonIdx + 1));
      if (!Number.isNaN(v)) map.set(part.slice(0, colonIdx), v);
    }
    this.parsedPatternCache.set(pattern, map);
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
    return this.fuzzyRecord(pattern, actionKey, maxDistance)?.scorePerVisit ?? 0;
  }

  public fuzzyRecord(
    pattern: string,
    actionKey: string,
    maxDistance = 3
  ): (PatternScoreRecord & { scorePerVisit: number }) | undefined {
    const queryFeatures = this.parsePattern(pattern);
    let weightedSum = 0;
    let totalWeight = 0;
    let weightedVisits = 0;
    const candidates = this.recordsByActionKey.get(actionKey);
    if (!candidates) return undefined;
    for (const record of candidates) {
      if (record.visits === 0) continue;
      const dist = this.hammingDistance(queryFeatures, this.parsePattern(record.pattern));
      if (dist > maxDistance) continue;
      const confidence = confidenceFromRecord(record);
      const weight = (1 / (1 + dist)) * Math.max(0.05, confidence);
      weightedSum += (record.score / record.visits) * weight;
      totalWeight += weight;
      weightedVisits += record.visits * weight;
    }
    if (totalWeight <= 0) return undefined;
    const scorePerVisit = weightedSum / totalWeight;
    const visits = Math.max(1, Math.round(weightedVisits / totalWeight));
    return {
      pattern,
      actionKey,
      score: scorePerVisit * visits,
      visits,
      source: "fuzzy",
      scorePerVisit,
    };
  }

  public get(pattern: string, actionKey: string): PatternRecord | undefined {
    return this.records.get(this.makeKey(pattern, actionKey));
  }

  public observe(pattern: string, actionKey: string, deltaScore: number) {
    const key = this.makeKey(pattern, actionKey);
    const current = this.records.get(key);
    const now = new Date().toISOString();
    if (!current) {
      this.setRecord(key, {
        pattern,
        actionKey,
        score: deltaScore,
        visits: 1,
        rewardSquaredSum: deltaScore * deltaScore,
        winCount: deltaScore > 0 ? 1 : 0,
        lossCount: deltaScore < 0 ? 1 : 0,
        lastUpdated: now,
      });
    } else {
      current.score += deltaScore;
      current.visits += 1;
      current.rewardSquaredSum =
        (current.rewardSquaredSum ?? estimateSquaredRewardSum(current)) +
        deltaScore * deltaScore;
      if (deltaScore > 0) current.winCount = (current.winCount ?? 0) + 1;
      if (deltaScore < 0) current.lossCount = (current.lossCount ?? 0) + 1;
      current.lastUpdated = now;
    }
    this.dirtyKeys.add(key);
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
        this.setRecord(key, this.normalizeRecord(record));
      } else {
        existing.score += record.score;
        existing.visits += record.visits;
        existing.rewardSquaredSum =
          (existing.rewardSquaredSum ?? estimateSquaredRewardSum(existing)) +
          (record.rewardSquaredSum ?? estimateSquaredRewardSum(record));
        existing.winCount = (existing.winCount ?? 0) + (record.winCount ?? 0);
        existing.lossCount = (existing.lossCount ?? 0) + (record.lossCount ?? 0);
        existing.lastUpdated = record.lastUpdated ?? new Date().toISOString();
      }
      this.dirtyKeys.add(key);
    }
  }

  public entries(): PatternRecord[] {
    return [...this.records.values()];
  }

  public dirtyEntries(): PatternRecord[] {
    return [...this.dirtyKeys]
      .map((key) => this.records.get(key))
      .filter((record): record is PatternRecord => Boolean(record));
  }

  public markClean(records?: PatternRecord[]): void {
    if (!records) {
      this.dirtyKeys.clear();
      return;
    }
    for (const record of records) {
      this.dirtyKeys.delete(this.makeKey(record.pattern, record.actionKey));
    }
  }

  public get dirtyCount(): number {
    return this.dirtyKeys.size;
  }

  public toJSON(): PatternRecord[] {
    return this.entries();
  }

  private normalizeRecord(record: PatternRecord): PatternRecord {
    return {
      ...record,
      rewardSquaredSum: record.rewardSquaredSum ?? estimateSquaredRewardSum(record),
      winCount: record.winCount ?? 0,
      lossCount: record.lossCount ?? 0,
      lastUpdated: record.lastUpdated,
    };
  }

  private setRecord(key: string, record: PatternRecord): void {
    this.records.set(key, record);
    let bucket = this.recordsByActionKey.get(record.actionKey);
    if (!bucket) {
      bucket = new Set<PatternRecord>();
      this.recordsByActionKey.set(record.actionKey, bucket);
    }
    bucket.add(record);
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

export const actionToKey = (
  actionType: string,
  card: string,
  action?: Partial<SimAction> & {
    targets?: TargetRef[];
    modes?: string[];
    optionalChoices?: Record<string, boolean>;
    targetId?: string | null;
    targetPlayer?: number;
    targetGraveyardCard?: string;
    targetStackId?: string;
    sourcePermanentId?: string;
    abilityId?: string;
  }
) => {
  const parts = [`${actionType}:${card ?? "NONE"}`];
  if (action?.type === "ACTIVATE_ABILITY") {
    parts[0] = `ACTIVATE:${action.sourcePermanentId}`;
    parts.push(`ability=${action.abilityId}`);
  }
  if ("modes" in (action ?? {}) && action?.modes?.length) {
    parts.push(`mode=${action.modes.join("+")}`);
  }
  if ("targets" in (action ?? {}) && action?.targets?.length) {
    parts.push(
      ...action.targets.map((target) => `target=${target.type}_${target.id}`)
    );
  } else if ("targetId" in (action ?? {}) && action?.targetId) {
    parts.push(`target=perm_${action.targetId}`);
  } else if ("targetPlayer" in (action ?? {}) && action?.targetPlayer !== undefined) {
    parts.push(`target=player_${action.targetPlayer}`);
  } else if ("targetGraveyardCard" in (action ?? {}) && action?.targetGraveyardCard) {
    parts.push(`target=graveyard_${action.targetGraveyardCard}`);
  } else if ("targetStackId" in (action ?? {}) && action?.targetStackId) {
    parts.push(`target=stack_${action.targetStackId}`);
  }
  if ("optionalChoices" in (action ?? {}) && action?.optionalChoices) {
    for (const [key, value] of Object.entries(action.optionalChoices).sort()) {
      parts.push(`optional=${key}:${value ? "yes" : "no"}`);
    }
  }
  return parts.join(":");
};

function estimateSquaredRewardSum(record: PatternRecord): number {
  if (record.visits <= 0) return 0;
  const mean = record.score / record.visits;
  return mean * mean * record.visits;
}

function confidenceFromRecord(record: PatternRecord): number {
  const base = record.visits / (record.visits + 50);
  if (record.rewardSquaredSum === undefined || record.visits <= 1) return base;
  const mean = record.score / record.visits;
  const variance = Math.max(0, record.rewardSquaredSum / record.visits - mean * mean);
  const standardError = Math.sqrt(variance / record.visits);
  return Math.max(0, Math.min(1, base * (1 - Math.min(0.5, standardError))));
}
