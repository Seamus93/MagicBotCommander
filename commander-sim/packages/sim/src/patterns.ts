import fs from "node:fs";
import path from "node:path";
import type { SimAction, TargetRef } from "@game-state/types";
import {
  profileDecisionBlock,
  recordDecisionCount,
  recordDecisionExternalPause,
  recordDecisionSample,
  recordDecisionTiming,
  timeDecisionBlock,
} from "./decisionProfiler.js";

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

export interface ActionKeyDescriptor {
  type: string;
  cardOrSource: string;
  abilityId?: string;
  mode?: string;
  targetFamily?: string;
  semanticIndexKeys: string[];
  fuzzyFamilyKey: string;
  combatIndexKey?: string;
  exact: string;
  normalized: string;
  family: string;
  typeFamily: string;
}

const MAX_FUZZY_CANDIDATES = Math.max(
  1,
  Number(process.env.MAX_FUZZY_CANDIDATES ?? 128)
);
const MAX_FUZZY_LOOKUP_MS = Math.max(
  0,
  Number(process.env.MAX_FUZZY_LOOKUP_MS ?? 250)
);
const FUZZY_TIMEOUT_CHECK_INTERVAL = Math.max(
  1,
  Number(process.env.FUZZY_TIMEOUT_CHECK_INTERVAL ?? 16)
);
const MIN_FUZZY_BUCKET_CANDIDATES = Math.max(
  1,
  Number(process.env.MIN_FUZZY_BUCKET_CANDIDATES ?? 1)
);
const MAX_FUZZY_RETRIEVAL_CANDIDATES = Math.max(
  MAX_FUZZY_CANDIDATES,
  Number(process.env.MAX_FUZZY_RETRIEVAL_CANDIDATES ?? MAX_FUZZY_CANDIDATES * 4)
);
const MAX_FUZZY_COMPARISONS_PER_LOOKUP = Math.max(
  1,
  Number(process.env.MAX_FUZZY_COMPARISONS_PER_LOOKUP ?? MAX_FUZZY_CANDIDATES)
);
const FUZZY_MONOTONIC_GAP_MS = Math.max(
  1,
  Number(process.env.FUZZY_MONOTONIC_GAP_MS ?? Math.max(250, MAX_FUZZY_LOOKUP_MS * 2))
);
const LOG_FUZZY_LOOKUPS = process.env.LOG_FUZZY_LOOKUPS === "true";
const actionKeyDescriptorCache = new Map<string, ActionKeyDescriptor>();
const patternStoreLifecycle = {
  policyFileReads: 0,
  policyJsonParseCount: 0,
  patternStoreBuildCount: 0,
  patternIndexBuildCount: 0,
};

export function resetPatternStoreLifecycleMetrics() {
  patternStoreLifecycle.policyFileReads = 0;
  patternStoreLifecycle.policyJsonParseCount = 0;
  patternStoreLifecycle.patternStoreBuildCount = 0;
  patternStoreLifecycle.patternIndexBuildCount = 0;
}

export function patternStoreLifecycleSnapshot() {
  return { ...patternStoreLifecycle };
}

export function recordPolicySnapshotFileRead() {
  patternStoreLifecycle.policyFileReads++;
}

export function recordPolicySnapshotJsonParse() {
  patternStoreLifecycle.policyJsonParseCount++;
}

type FuzzyTimeoutReason = "TIME" | "COMPARISON_BUDGET" | "MONOTONIC_GAP";

interface FuzzyDeadline {
  startMs: number;
  deadlineMs: number;
  lastCheckMs: number;
  externalPauseMs: number;
  timedOut: boolean;
  reason?: FuzzyTimeoutReason;
}

interface FuzzyCandidateResult {
  records: PatternRecord[];
  retrieved: number;
  timedOut: boolean;
  reason?: FuzzyTimeoutReason;
}

interface FuzzyCapResult {
  records: PatternRecord[];
  timedOut: boolean;
  reason?: FuzzyTimeoutReason;
}

export class PatternStore {
  private readonly records = new Map<string, PatternRecord>();
  private readonly dirtyKeys = new Set<string>();
  private readonly recordsByActionKey = new Map<string, Set<PatternRecord>>();
  private readonly recordsByNormalizedAction = new Map<string, Set<PatternRecord>>();
  private readonly recordsByActionFamily = new Map<string, Set<PatternRecord>>();
  private readonly recordsByActionType = new Map<string, Set<PatternRecord>>();
  private readonly recordsByFuzzyFamily = new Map<string, Set<PatternRecord>>();
  private readonly recordsByCombatIndex = new Map<string, Set<PatternRecord>>();
  private readonly recordsBySemanticIndex = new Map<string, Set<PatternRecord>>();
  private readonly parsedPatternCache = new Map<string, Map<string, number>>();
  private readonly cappedCandidateCache = new Map<string, { version: number; records: PatternRecord[] }>();
  private readonly newRecordsByFamily = new Map<string, number>();
  private indexVersion = 0;

  constructor(initial?: PatternRecord[]) {
    patternStoreLifecycle.patternStoreBuildCount++;
    if (initial?.length) patternStoreLifecycle.patternIndexBuildCount++;
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
    const lookupStart = monotonicNowMs();
    const deadline: FuzzyDeadline = {
      startMs: lookupStart,
      deadlineMs: MAX_FUZZY_LOOKUP_MS > 0 ? lookupStart + MAX_FUZZY_LOOKUP_MS : Number.POSITIVE_INFINITY,
      lastCheckMs: lookupStart,
      externalPauseMs: 0,
      timedOut: false,
    };
    recordDecisionCount("fuzzyLookupCount");
    const queryFeatures = this.parsePattern(pattern);
    let weightedSum = 0;
    let totalWeight = 0;
    let weightedVisits = 0;
    let comparisons = 0;
    let cpuSimilarityMs = 0;
    const descriptor = describeActionKey(actionKey);
    if (checkFuzzyDeadline(deadline)) {
      recordFuzzyTimeoutTelemetry(actionKey, descriptor, 0, 0, deadline, cpuSimilarityMs, false, false);
      return undefined;
    }
    const candidates = timeDecisionBlock("AI fuzzy candidate retrieval", () =>
      this.candidatesForActionKey(actionKey, deadline)
    );
    const candidateCount = candidates.retrieved;
    recordDecisionCount("fuzzyCandidatesTotal", candidateCount);
    recordDecisionSample("fuzzyCandidates", candidateCount);
    if (!candidates.records.length || candidates.timedOut) {
      const hasBest = totalWeight > 0;
      recordDecisionTiming("AI fuzzy lookup wall", monotonicNowMs() - lookupStart);
      recordDecisionTiming("AI fuzzy similarity cpu", cpuSimilarityMs);
      recordDecisionTiming("AI fuzzy external pause", deadline.externalPauseMs);
      if (candidates.timedOut) {
        deadline.timedOut = true;
        deadline.reason = candidates.reason;
        recordFuzzyTimeoutTelemetry(actionKey, descriptor, candidateCount, comparisons, deadline, cpuSimilarityMs, hasBest, true);
      }
      return undefined;
    }
    const cappedCandidates = timeDecisionBlock("AI fuzzy candidate cap", () =>
      this.capCandidatesForLookup(candidates.records, actionKey, deadline)
    );
    recordDecisionSample("fuzzyCappedCandidates", cappedCandidates.records.length);
    if (cappedCandidates.timedOut) {
      deadline.timedOut = true;
      deadline.reason = cappedCandidates.reason;
    }
    timeDecisionBlock("AI fuzzy similarity scoring", () => {
      if (deadline.timedOut) return;
      for (const record of cappedCandidates.records) {
        if (checkFuzzyDeadline(deadline)) break;
        if (record.visits === 0) continue;
        comparisons++;
        if (comparisons > MAX_FUZZY_COMPARISONS_PER_LOOKUP) {
          deadline.timedOut = true;
          deadline.reason = "COMPARISON_BUDGET";
          break;
        }
        if (comparisons % FUZZY_TIMEOUT_CHECK_INTERVAL === 0 && checkFuzzyDeadline(deadline)) break;
        const cpuStart = monotonicNowMs();
        const dist = this.hammingDistance(queryFeatures, this.parsePattern(record.pattern));
        cpuSimilarityMs += boundedCpuDelta(deadline, cpuStart, monotonicNowMs());
        if (checkFuzzyDeadline(deadline)) break;
        if (dist > maxDistance) continue;
        const confidence = confidenceFromRecord(record);
        const weight = (1 / (1 + dist)) * Math.max(0.05, confidence);
        weightedSum += (record.score / record.visits) * weight;
        totalWeight += weight;
        weightedVisits += record.visits * weight;
      }
    });
    const lookupMs = monotonicNowMs() - lookupStart;
    recordDecisionCount("similarityComparisons", comparisons);
    recordDecisionSample("similarityComparisonsPerDecision", comparisons);
    recordDecisionTiming("AI fuzzy lookup wall", lookupMs);
    recordDecisionTiming("AI fuzzy similarity cpu", cpuSimilarityMs);
    recordDecisionTiming("AI fuzzy external pause", deadline.externalPauseMs);
    if (deadline.timedOut) {
      recordFuzzyTimeoutTelemetry(actionKey, descriptor, candidateCount, comparisons, deadline, cpuSimilarityMs, totalWeight > 0, totalWeight <= 0);
    }
    if (LOG_FUZZY_LOOKUPS || deadline.timedOut) {
      console.warn(
        `[fuzzy] ${deadline.timedOut ? "timeout " : ""}key=${actionKey} family=${descriptor.family} ` +
        `fuzzyFamily=${descriptor.fuzzyFamilyKey} candidates=${candidateCount} compared=${comparisons} ` +
        `reason=${deadline.reason ?? "OK"} wallMs=${lookupMs.toFixed(1)} cpuSimilarityMs=${cpuSimilarityMs.toFixed(1)} ` +
        `externalPauseMs=${deadline.externalPauseMs.toFixed(1)} bestSoFar=${totalWeight > 0}`
      );
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

  public fuzzyRecordLegacyForTest(
    pattern: string,
    actionKey: string,
    maxDistance = 3
  ): (PatternScoreRecord & { scorePerVisit: number }) | undefined {
    return this.scoreCandidates(pattern, actionKey, [...(this.recordsByActionKey.get(actionKey) ?? [])], maxDistance);
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
      this.recordNewPolicyFamily(actionKey);
    } else {
      current.score += deltaScore;
      current.visits += 1;
      current.rewardSquaredSum =
        (current.rewardSquaredSum ?? estimateSquaredRewardSum(current)) +
        deltaScore * deltaScore;
      if (deltaScore > 0) current.winCount = (current.winCount ?? 0) + 1;
      if (deltaScore < 0) current.lossCount = (current.lossCount ?? 0) + 1;
      current.lastUpdated = now;
      this.indexVersion++;
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
        this.indexVersion++;
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

  public consumeNewRecordMetrics(): { total: number; byFamily: Record<string, number> } {
    const byFamily = Object.fromEntries(this.newRecordsByFamily.entries());
    const total = Object.values(byFamily).reduce((sum, value) => sum + value, 0);
    this.newRecordsByFamily.clear();
    return { total, byFamily };
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
    this.indexVersion++;
    addToIndex(this.recordsByActionKey, record.actionKey, record);
    const descriptor = describeActionKey(record.actionKey);
    addToIndex(this.recordsByNormalizedAction, descriptor.normalized, record);
    addToIndex(this.recordsByActionFamily, descriptor.family, record);
    addToIndex(this.recordsByActionType, descriptor.typeFamily, record);
    addToIndex(this.recordsByFuzzyFamily, descriptor.fuzzyFamilyKey, record);
    for (const semanticIndexKey of descriptor.semanticIndexKeys) {
      addToIndex(this.recordsBySemanticIndex, semanticIndexKey, record);
    }
    if (descriptor.combatIndexKey) {
      addToIndex(this.recordsByCombatIndex, descriptor.combatIndexKey, record);
    }
  }

  private candidatesForActionKey(actionKey: string, deadline: FuzzyDeadline): FuzzyCandidateResult {
    const descriptor = describeActionKey(actionKey);
    const buckets = [
      this.recordsByActionKey.get(actionKey),
      descriptor.combatIndexKey ? this.recordsByCombatIndex.get(descriptor.combatIndexKey) : undefined,
      ...descriptor.semanticIndexKeys.map((key) => this.recordsBySemanticIndex.get(key)),
      this.recordsByFuzzyFamily.get(descriptor.fuzzyFamilyKey),
      this.recordsByNormalizedAction.get(descriptor.normalized),
      this.recordsByActionFamily.get(descriptor.family),
      this.recordsByActionType.get(descriptor.typeFamily),
    ];
    const seen = new Set<PatternRecord>();
    const candidates: PatternRecord[] = [];
    let reason: FuzzyTimeoutReason | undefined;
    for (const bucket of buckets) {
      if (checkFuzzyDeadline(deadline)) {
        reason = deadline.reason;
        break;
      }
      if (!bucket) continue;
      for (const record of bucket) {
        if (seen.has(record)) continue;
        seen.add(record);
        candidates.push(record);
        if (candidates.length >= MAX_FUZZY_RETRIEVAL_CANDIDATES) break;
        if (candidates.length % FUZZY_TIMEOUT_CHECK_INTERVAL === 0 && checkFuzzyDeadline(deadline)) {
          reason = deadline.reason;
          break;
        }
      }
      if (reason || candidates.length >= MAX_FUZZY_RETRIEVAL_CANDIDATES) break;
      if (checkFuzzyDeadline(deadline)) {
        reason = deadline.reason;
        break;
      }
      if (candidates.length >= MIN_FUZZY_BUCKET_CANDIDATES) break;
    }
    if (reason) recordDecisionCount("fuzzyCandidateRetrievalTimeouts");
    if (candidates.length >= MAX_FUZZY_RETRIEVAL_CANDIDATES) {
      recordDecisionCount("fuzzyCandidateRetrievalCaps");
    }
    return { records: candidates, retrieved: candidates.length, timedOut: Boolean(reason), reason };
  }

  private capCandidatesForLookup(candidates: PatternRecord[], actionKey: string, deadline: FuzzyDeadline): FuzzyCapResult {
    if (checkFuzzyDeadline(deadline)) return { records: candidates, timedOut: true, reason: deadline.reason };
    if (candidates.length <= MAX_FUZZY_CANDIDATES) return { records: candidates, timedOut: false };
    const cacheKey = `${actionKey}|${MAX_FUZZY_CANDIDATES}|${candidates.length}`;
    const cached = this.cappedCandidateCache.get(cacheKey);
    if (cached?.version === this.indexVersion) return { records: cached.records, timedOut: false };
    const records = capCandidates(candidates, actionKey, MAX_FUZZY_CANDIDATES, deadline);
    if (deadline.timedOut) return { records, timedOut: true, reason: deadline.reason };
    this.cappedCandidateCache.set(cacheKey, { version: this.indexVersion, records });
    return { records, timedOut: false };
  }

  private recordNewPolicyFamily(actionKey: string): void {
    const family = actionPolicyFamily(actionKey);
    this.newRecordsByFamily.set(family, (this.newRecordsByFamily.get(family) ?? 0) + 1);
  }

  private scoreCandidates(
    pattern: string,
    actionKey: string,
    candidates: PatternRecord[],
    maxDistance: number
  ): (PatternScoreRecord & { scorePerVisit: number }) | undefined {
    const queryFeatures = this.parsePattern(pattern);
    let weightedSum = 0;
    let totalWeight = 0;
    let weightedVisits = 0;
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
    return { pattern, actionKey, score: scorePerVisit * visits, visits, source: "fuzzy", scorePerVisit };
  }

  static load(filePath: string): PatternStore {
    try {
      recordPolicySnapshotFileRead();
      const text = fs.readFileSync(filePath, "utf8");
      recordPolicySnapshotJsonParse();
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
  profileDecisionBlock(
    "pattern.state serialization",
    { inputSize: Object.keys(features).length, resultSize: (value) => value.length },
    () =>
      Object.entries(features)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v.toFixed(2)}`)
        .join("|")
  );

function addToIndex(
  index: Map<string, Set<PatternRecord>>,
  key: string,
  record: PatternRecord
) {
  let bucket = index.get(key);
  if (!bucket) {
    bucket = new Set<PatternRecord>();
    index.set(key, bucket);
  }
  bucket.add(record);
}

export function describeActionKey(actionKey: string): ActionKeyDescriptor {
  const cached = actionKeyDescriptorCache.get(actionKey);
  if (cached) return cached;
  const parts = actionKey.split(":");
  const type = parts[0] || "UNKNOWN";
  let cardOrSource = parts[1] || "NONE";
  let abilityId: string | undefined;
  const modes: string[] = [];
  const targetFamilies: string[] = [];
  const optionals: string[] = [];
  const fuzzyParts: string[] = [];
  const fuzzyValues = new Map<string, string[]>();
  const combatParts: string[] = [];
  const exactIdentityPrefixes = [
    "ids=",
    "assignments=",
    "sourcePermanentId=",
    "targetId=",
  ];

  for (const part of parts.slice(2)) {
    if (part.startsWith("ability=")) {
      abilityId = part.slice("ability=".length);
      addFuzzyValue(fuzzyValues, "ability", abilityId);
    }
    else if (part.startsWith("mode=")) {
      const modeValue = part.slice("mode=".length);
      modes.push(modeValue);
      addFuzzyValue(fuzzyValues, "mode", modeValue);
    }
    else if (part.startsWith("target=")) {
      const targetFamilyValue = isCombatDescriptorType(type) ? "player" : normalizeTargetFamily(part.slice("target=".length));
      targetFamilies.push(targetFamilyValue);
      addFuzzyValue(fuzzyValues, "target", targetFamilyValue);
    }
    else if (part.startsWith("optional=")) optionals.push(part);
    else if (!exactIdentityPrefixes.some((prefix) => part.startsWith(prefix))) {
      fuzzyParts.push(part);
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) addFuzzyValue(fuzzyValues, part.slice(0, eqIdx), part.slice(eqIdx + 1));
      if (isCombatDescriptorType(type) && isCombatIndexPart(part)) combatParts.push(part);
    }
  }

  if (type === "ACTIVATE") {
    cardOrSource = "SOURCE";
  }
  if (isCombatDescriptorType(type)) {
    cardOrSource = type;
  }

  const abilityFamilyId = type === "ACTIVATE" ? normalizeActivatedAbilityId(abilityId) : abilityId;
  const mode = modes.sort().join("+") || undefined;
  const targetFamily = targetFamilies.sort().join("+") || undefined;
  const typeFamily = `type=${type}`;
  const familyParts = [typeFamily, `card=${cardOrSource}`];
  if (abilityFamilyId) familyParts.push(`ability=${abilityFamilyId}`);
  if (mode) familyParts.push(`mode=${mode}`);
  if (targetFamily) familyParts.push(`target=${targetFamily}`);
  const family = familyParts.join("|");
  const fuzzyFamilyKey = [
    family,
    ...fuzzyParts.sort(),
  ].join("|");
  const combatIndexKey = isCombatDescriptorType(type)
    ? [
        typeFamily,
        ...combatParts.sort(),
      ].join("|")
    : undefined;
  const semanticIndexKeys = semanticIndexKeysForDescriptor(
    type,
    cardOrSource,
    abilityFamilyId,
    mode,
    targetFamily,
    fuzzyValues
  );
  const normalized = [
    fuzzyFamilyKey,
    ...optionals.sort(),
  ].join("|");

  const descriptor = {
    type,
    cardOrSource,
    abilityId: abilityFamilyId,
    mode,
    targetFamily,
    semanticIndexKeys,
    fuzzyFamilyKey,
    combatIndexKey,
    exact: actionKey,
    normalized,
    family,
    typeFamily,
  };
  actionKeyDescriptorCache.set(actionKey, descriptor);
  return descriptor;
}

function addFuzzyValue(index: Map<string, string[]>, key: string, value: string | undefined): void {
  if (!value) return;
  const bucket = index.get(key) ?? [];
  bucket.push(value);
  index.set(key, bucket);
}

function firstValue(index: Map<string, string[]>, key: string, fallback = "any"): string {
  return normalizeIndexValue(index.get(key)?.[0] ?? fallback);
}

function allValues(index: Map<string, string[]>, key: string, fallback = "any"): string {
  const values = index.get(key);
  if (!values?.length) return normalizeIndexValue(fallback);
  return values.map(normalizeIndexValue).sort().join("+");
}

function normalizeIndexValue(value: string): string {
  return value.replace(/[|:]/g, "_");
}

function normalizeActivatedAbilityId(abilityId?: string): string | undefined {
  if (!abilityId) return undefined;
  const parts = abilityId.split(/[:~]/);
  if (parts.length >= 3) return parts.slice(1).join(":");
  return abilityId;
}

function semanticIndexKeysForDescriptor(
  type: string,
  cardOrSource: string,
  abilityId: string | undefined,
  mode: string | undefined,
  targetFamily: string | undefined,
  fuzzyValues: Map<string, string[]>
): string[] {
  const typePart = `type=${type}`;
  if (type === "CAST_SPELL") {
    const card = normalizeIndexValue(cardOrSource);
    const spellType = firstValue(fuzzyValues, "spellType");
    const mana = firstValue(fuzzyValues, "mana");
    const timing = firstValue(fuzzyValues, "timing");
    const target = normalizeIndexValue(targetFamily ?? "none");
    const targetSemantic = allValues(fuzzyValues, "targetSemantic", "none");
    const modePart = normalizeIndexValue(mode ?? "default");
    return [
      [
        "semantic=narrow",
        typePart,
        `card=${card}`,
        `spellType=${spellType}`,
        `mode=${modePart}`,
        `target=${target}`,
        `targetSemantic=${targetSemantic}`,
        `mana=${mana}`,
        `timing=${timing}`,
      ].join("|"),
      [
        "semantic=medium",
        typePart,
        `card=${card}`,
        `spellType=${spellType}`,
        `target=${target}`,
        `targetSemantic=${targetSemantic}`,
        `mana=${mana}`,
      ].join("|"),
      [
        "semantic=legacy",
        typePart,
        `card=${card}`,
        `spellType=${spellType}`,
        `target=${target}`,
      ].join("|"),
    ];
  }
  if (type === "ACTIVATE") {
    const sourceCard = firstValue(fuzzyValues, "sourceCard", cardOrSource);
    const effect = firstValue(fuzzyValues, "effect");
    const cost = firstValue(fuzzyValues, "cost");
    const target = normalizeIndexValue(targetFamily ?? "none");
    const targetSemantic = allValues(fuzzyValues, "targetSemantic", "none");
    const ability = normalizeIndexValue(normalizeActivatedAbilityId(abilityId) ?? "unknown");
    return [
      [
        "semantic=narrow",
        typePart,
        `source=${sourceCard}`,
        `ability=${ability}`,
        `effect=${effect}`,
        `target=${target}`,
        `targetSemantic=${targetSemantic}`,
        `cost=${cost}`,
      ].join("|"),
      [
        "semantic=medium",
        typePart,
        `source=${sourceCard}`,
        `effect=${effect}`,
        `target=${target}`,
        `targetSemantic=${targetSemantic}`,
        `cost=${cost}`,
      ].join("|"),
      [
        "semantic=legacy",
        typePart,
        `source=${sourceCard}`,
        `effect=${effect}`,
        `cost=${cost}`,
      ].join("|"),
    ];
  }
  return [];
}

export function fuzzyFamilyKeyForAction(actionKey: string): string {
  return describeActionKey(actionKey).fuzzyFamilyKey;
}

export function actionPolicyFamily(actionKey: string): string {
  const type = describeActionKey(actionKey).type;
  if (type === "PLAY_LAND") return "PLAY_LAND";
  if (type === "CAST_SPELL") return "CAST_SPELL";
  if (type === "ACTIVATE") return "ACTIVATE_ABILITY";
  if (type === "ATTACK_PLAN") return "ATTACK_PLAN";
  if (type === "BLOCK_PLAN") return "BLOCK_PLAN";
  if (type === "target") return "TARGET";
  return type || "UNKNOWN";
}

export function legacyActionKeyForSemanticKey(actionKey: string): string {
  const semanticPrefixes = [
    "sourceCard=",
    "spellType=",
    "mana=",
    "timing=",
    "effect=",
    "cost=",
  ];
  return actionKey
    .split(":")
    .filter((part) => !semanticPrefixes.some((prefix) => part.startsWith(prefix)))
    .join(":");
}

function isCombatDescriptorType(type: string): boolean {
  return type === "ATTACK_PLAN" || type === "BLOCK_PLAN";
}

function isCombatIndexPart(part: string): boolean {
  return (
    part.startsWith("count=") ||
    part.startsWith("attackerCount=") ||
    part.startsWith("blockerCount=") ||
    part.startsWith("targetThreat=") ||
    part.startsWith("lethal=") ||
    part.startsWith("board=") ||
    part.startsWith("value=") ||
    part.startsWith("incoming=")
  );
}

function normalizeTargetFamily(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.startsWith("creature_")) return "creature";
  if (lower.startsWith("permanent_") || lower.startsWith("perm_")) return "permanent";
  if (lower.startsWith("player_")) return "player";
  if (lower.startsWith("graveyard_") || lower.startsWith("card_")) return "graveyard";
  if (lower.startsWith("stack_")) return "stack";
  const idx = lower.indexOf("_");
  return idx > 0 ? lower.slice(0, idx) : lower;
}

function capCandidates(
  candidates: PatternRecord[],
  actionKey: string,
  maxCandidates: number,
  deadline: FuzzyDeadline
): PatternRecord[] {
  if (candidates.length <= maxCandidates) return candidates;
  const descriptor = describeActionKey(actionKey);
  const heap: RankedCandidate[] = [];
  let processed = 0;
  for (const record of candidates) {
    processed++;
    if (processed % FUZZY_TIMEOUT_CHECK_INTERVAL === 0 && checkFuzzyDeadline(deadline)) break;
    const ranked = rankCandidate(record, descriptor);
    if (heap.length < maxCandidates) {
      heapPush(heap, ranked);
      continue;
    }
    if (compareRankedCandidates(ranked, heap[0]) > 0) {
      heap[0] = ranked;
      heapifyDown(heap, 0);
    }
  }
  if (checkFuzzyDeadline(deadline)) return heap.map((candidate) => candidate.record);
  return heap
    .sort((left, right) => compareRankedCandidates(right, left))
    .map((candidate) => candidate.record);
}

interface RankedCandidate {
  record: PatternRecord;
  rank: number;
  updatedAtMs: number;
}

function rankCandidate(record: PatternRecord, query: ActionKeyDescriptor): RankedCandidate {
  return {
    record,
    rank: candidateRank(record, query),
    updatedAtMs: parseTimestamp(record.lastUpdated),
  };
}

function candidateRank(record: PatternRecord, query: ActionKeyDescriptor): number {
  const candidate = describeActionKey(record.actionKey);
  let rank = 0;
  if (candidate.type === query.type) rank += 1000;
  if (candidate.cardOrSource === query.cardOrSource) rank += 500;
  if (candidate.abilityId && candidate.abilityId === query.abilityId) rank += 250;
  if (candidate.mode && candidate.mode === query.mode) rank += 125;
  if (candidate.targetFamily && candidate.targetFamily === query.targetFamily) rank += 60;
  rank += Math.min(50, Math.log2(Math.max(1, record.visits)) * 5);
  return rank;
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return (
    left.rank - right.rank ||
    left.updatedAtMs - right.updatedAtMs ||
    left.record.visits - right.record.visits ||
    right.record.actionKey.localeCompare(left.record.actionKey) ||
    right.record.pattern.localeCompare(left.record.pattern)
  );
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function checkFuzzyDeadline(deadline: FuzzyDeadline): boolean {
  if (deadline.timedOut) return true;
  const now = monotonicNowMs();
  const gap = now - deadline.lastCheckMs;
  deadline.lastCheckMs = now;
  if (gap > FUZZY_MONOTONIC_GAP_MS) {
    deadline.externalPauseMs += gap;
    recordDecisionExternalPause(gap);
    deadline.timedOut = true;
    deadline.reason = "MONOTONIC_GAP";
    return true;
  }
  if (now >= deadline.deadlineMs) {
    deadline.timedOut = true;
    deadline.reason = "TIME";
    return true;
  }
  return false;
}

function boundedCpuDelta(deadline: FuzzyDeadline, startMs: number, endMs: number): number {
  const elapsed = Math.max(0, endMs - startMs);
  if (elapsed > FUZZY_MONOTONIC_GAP_MS) {
    deadline.externalPauseMs += elapsed;
    return 0;
  }
  return elapsed;
}

function recordFuzzyTimeoutTelemetry(
  actionKey: string,
  descriptor: ActionKeyDescriptor,
  candidates: number,
  comparisons: number,
  deadline: FuzzyDeadline,
  cpuSimilarityMs: number,
  bestSoFar: boolean,
  fallbackUsed: boolean
): void {
  recordDecisionCount("fuzzyLookupTimeouts");
  if (deadline.reason) recordDecisionCount(`fuzzyTimeoutReason.${deadline.reason}`);
  if (deadline.reason === "MONOTONIC_GAP") recordDecisionCount("monotonicGapDetected");
  recordDecisionSample("fuzzyTimeoutCandidates", candidates);
  recordDecisionSample("fuzzyTimeoutComparisons", comparisons);
  recordDecisionTiming("AI fuzzy timeout cpu similarity", cpuSimilarityMs);
  recordDecisionTiming("AI fuzzy timeout external pause", deadline.externalPauseMs);
  console.warn(
    `[fuzzy-timeout] family=${descriptor.family} fuzzyFamily=${descriptor.fuzzyFamilyKey} key=${actionKey} ` +
    `candidates=${candidates} comparisons=${comparisons} reason=${deadline.reason ?? "TIME"} ` +
    `wallMs=${(monotonicNowMs() - deadline.startMs).toFixed(1)} cpuSimilarityMs=${cpuSimilarityMs.toFixed(1)} ` +
    `externalPauseMs=${deadline.externalPauseMs.toFixed(1)} bestSoFar=${bestSoFar} fallbackUsed=${fallbackUsed}`
  );
}

function heapPush(heap: RankedCandidate[], candidate: RankedCandidate) {
  heap.push(candidate);
  let idx = heap.length - 1;
  while (idx > 0) {
    const parent = Math.floor((idx - 1) / 2);
    if (compareRankedCandidates(heap[parent], candidate) <= 0) break;
    heap[idx] = heap[parent];
    idx = parent;
  }
  heap[idx] = candidate;
}

function heapifyDown(heap: RankedCandidate[], idx: number) {
  const candidate = heap[idx];
  while (true) {
    const left = idx * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    let child = left;
    if (right < heap.length && compareRankedCandidates(heap[right], heap[left]) < 0) child = right;
    if (compareRankedCandidates(heap[child], candidate) >= 0) break;
    heap[idx] = heap[child];
    idx = child;
  }
  heap[idx] = candidate;
}

function parseTimestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

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
    targetSemantic?: string;
    targetSemantics?: string[];
    spellType?: string;
    manaBucket?: string;
    timing?: string;
    sourceCard?: string;
    effectFamily?: string;
    costFamily?: string;
    choiceType?: string;
    permanentId?: string;
  }
) => {
  return profileDecisionBlock(
    "pattern.actionToKey",
    { inputSize: action ? Object.keys(action).length : 0, resultSize: (value) => value.length },
    () => {
      const parts = [`${actionType}:${card ?? "NONE"}`];
      if (action?.type === "ACTIVATE_ABILITY") {
        parts[0] = `ACTIVATE:${action.sourcePermanentId}`;
        parts.push(`ability=${encodeActionKeyValue(action.abilityId ?? "ability")}`);
      }
      if (action?.type === "RESOLVE_CHOICE") {
        parts[0] = `RESOLVE_CHOICE:${action.card ?? card ?? "NONE"}`;
        parts.push(`choice=${encodeActionKeyValue(action.choiceType ?? "choice")}`);
        parts.push(`permanent=${encodeActionKeyValue(action.permanentId ?? "unknown")}`);
      }
      if ("sourceCard" in (action ?? {}) && action?.sourceCard) {
        parts.push(`sourceCard=${action.sourceCard}`);
      }
      if ("spellType" in (action ?? {}) && action?.spellType) {
        parts.push(`spellType=${action.spellType}`);
      }
      if ("manaBucket" in (action ?? {}) && action?.manaBucket) {
        parts.push(`mana=${action.manaBucket}`);
      }
      if ("timing" in (action ?? {}) && action?.timing) {
        parts.push(`timing=${action.timing}`);
      }
      if ("effectFamily" in (action ?? {}) && action?.effectFamily) {
        parts.push(`effect=${action.effectFamily}`);
      }
      if ("costFamily" in (action ?? {}) && action?.costFamily) {
        parts.push(`cost=${action.costFamily}`);
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
      if ("targetSemantic" in (action ?? {}) && action?.targetSemantic) {
        parts.push(`targetSemantic=${action.targetSemantic}`);
      }
      if ("targetSemantics" in (action ?? {}) && action?.targetSemantics?.length) {
        parts.push(...action.targetSemantics.map((target) => `targetSemantic=${target}`).sort());
      }
      return parts.join(":");
    }
  );
};

function encodeActionKeyValue(value: string): string {
  return value.replace(/[:|]/g, "~");
}

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
