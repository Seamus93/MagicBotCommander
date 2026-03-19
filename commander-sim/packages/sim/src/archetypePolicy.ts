import { PatternStore } from "./patterns.js";
import type { PatternRecord } from "./patterns.js";

const SEP = "::";
const MIN_ARCHETYPE_VISITS = 3;
const MIN_GLOBAL_VISITS = 3;

// ──────────────────────────────────────────────
// ArchetypePolicy — wrappa PatternStore con chiavi archetype-aware
//
// Struttura chiave interna: "ARCHETYPE::pattern::actionKey"
// La partizione globale usa le stesse chiavi senza prefisso.
// ──────────────────────────────────────────────
export class ArchetypePolicy {
  private readonly store: PatternStore;

  constructor(store?: PatternStore) {
    this.store = store ?? new PatternStore();
  }

  get underlying(): PatternStore {
    return this.store;
  }

  private archetypePattern(archetype: string, pattern: string): string {
    return `${archetype}${SEP}${pattern}`;
  }

  /**
   * Scrive il reward nella partizione archetype-specific E in quella globale.
   */
  observe(archetype: string, pattern: string, actionKey: string, reward: number): void {
    this.store.observe(this.archetypePattern(archetype, pattern), actionKey, reward);
    this.store.observe(pattern, actionKey, reward);
  }

  /** Scrive solo nella partizione globale (compatibilità con path no-archetype). */
  observeGlobal(pattern: string, actionKey: string, reward: number): void {
    this.store.observe(pattern, actionKey, reward);
  }

  /**
   * Ottieni lo score per (archetype, pattern, actionKey) con fallback a cascata:
   * 1. Partizione archetype-specific (se visite sufficienti)
   * 2. Partizione globale (se visite sufficienti)
   * 3. Fuzzy match sulla partizione globale
   */
  scoreFor(archetype: string, pattern: string, actionKey: string): number {
    const archRec = this.store.get(this.archetypePattern(archetype, pattern), actionKey);
    if (archRec && archRec.visits >= MIN_ARCHETYPE_VISITS) {
      return archRec.score / archRec.visits;
    }

    const globalRec = this.store.get(pattern, actionKey);
    if (globalRec && globalRec.visits >= MIN_GLOBAL_VISITS) {
      return globalRec.score / globalRec.visits;
    }

    return this.store.fuzzyScore(pattern, actionKey);
  }

  /**
   * Miglior azione per (archetype, pattern):
   * 1. Partizione archetype-specific (con visite sufficienti)
   * 2. Partizione globale
   */
  bestAction(archetype: string, pattern: string): PatternRecord | undefined {
    const archResult = this.store.bestAction(this.archetypePattern(archetype, pattern));
    if (archResult && archResult.visits >= MIN_ARCHETYPE_VISITS) return archResult;
    return this.store.bestAction(pattern);
  }

  /**
   * Fuzzy match filtrato alla partizione archetype-specific.
   * Usa distanza Hamming sui feature bucket, escludendo il prefisso archetype.
   */
  fuzzyBestAction(archetype: string, pattern: string, actionKey: string, maxDistance = 3): number {
    const prefix = archetype + SEP;
    const queryFeatures = this.parsePattern(pattern);
    let weightedSum = 0;
    let totalWeight = 0;

    for (const record of this.store.entries()) {
      if (!record.pattern.startsWith(prefix)) continue;
      if (record.actionKey !== actionKey || record.visits === 0) continue;
      const cleanPattern = record.pattern.slice(prefix.length);
      const dist = this.hammingDistance(queryFeatures, this.parsePattern(cleanPattern));
      if (dist > maxDistance) continue;
      const weight = 1 / (1 + dist);
      weightedSum += (record.score / record.visits) * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /** Serializza tutte le partizioni (archetype + globale). */
  exportPolicy(): PatternRecord[] {
    return this.store.toJSON();
  }

  /**
   * Carica da array di PatternRecord.
   * Backward compatible: record senza prefisso archetype:: → partizione globale (invariata).
   * Record con prefisso archetype:: → caricati nelle rispettive partizioni.
   */
  importPolicy(data: PatternRecord[]): void {
    this.store.merge(data);
  }

  save(filePath: string): void {
    this.store.save(filePath);
  }

  static load(filePath: string): ArchetypePolicy {
    const store = PatternStore.load(filePath);
    return new ArchetypePolicy(store);
  }

  // ── pattern parsing helpers (duplicati da PatternStore per autonomia) ──

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
}
