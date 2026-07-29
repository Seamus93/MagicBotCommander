import type { DeckCardMetadata, RulesCoverageLevel } from "@game-state/types";

export interface DeckRulesCoverage {
  fullCount: number;
  partialCount: number;
  unsupportedCount: number;
  fullPercentage: number;
  effectiveCoverage: number;
  cards: Array<{ name: string; coverage: RulesCoverageLevel; reason: string }>;
}

const SUPPORTED_PATTERNS = [
  /\benters(?: the battlefield)? tapped\b/i,
  /\bwhen .* enters(?: the battlefield)?, draw (?:a|one|two|three|\d+) cards?\b/i,
  /\bwhen .* dies\b/i,
  /\bwhen .* leaves the battlefield\b/i,
  /\bat the beginning of your upkeep\b/i,
  /\bdraw (?:a|one|two|three|\d+) cards?\b/i,
  /\bdestroy target creature\b/i,
  /\bexile target\b/i,
  /\bcreate (?:a|one|two|three|\d+) .*\btoken\b/i,
  /\bdeals? (?:\d+|x) damage to\b/i,
  /\bgain (?:\d+|x) life\b/i,
  /\badd (?:\{[^}]+\}|one|two|three)/i,
];

export function classifyCardRulesCoverage(metadata: DeckCardMetadata): {
  coverage: RulesCoverageLevel;
  reason: string;
} {
  const typeLine = metadata.typeLine?.toLowerCase() ?? "";
  const text = metadata.oracleText ?? "";

  if (metadata.unsupportedEffect) {
    return { coverage: "UNSUPPORTED", reason: "metadata marks unsupported effect" };
  }

  if (!text.trim()) {
    if (metadata.isLand || typeLine.includes("land")) return { coverage: "FULL", reason: "land/type only" };
    if (metadata.isCreature || typeLine.includes("creature")) return { coverage: "PARTIAL", reason: "creature stats only" };
    return { coverage: "UNSUPPORTED", reason: "no oracle text" };
  }

  const sentences = text
    .split(/[\.\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const unsupported = sentences.filter(
    (sentence) => !SUPPORTED_PATTERNS.some((pattern) => pattern.test(sentence))
  );

  if (unsupported.length === 0) return { coverage: "FULL", reason: "all oracle fragments matched" };
  if (unsupported.length < sentences.length) {
    return {
      coverage: "PARTIAL",
      reason: `unsupported fragments: ${unsupported.slice(0, 2).join(" | ")}`,
    };
  }
  return {
    coverage: "UNSUPPORTED",
    reason: `unsupported fragments: ${unsupported.slice(0, 2).join(" | ")}`,
  };
}

export function calculateDeckRulesCoverage(metadata: DeckCardMetadata[]): DeckRulesCoverage {
  const cards = metadata.map((card) => ({
    name: card.name,
    ...classifyCardRulesCoverage(card),
  }));
  const fullCount = cards.filter((card) => card.coverage === "FULL").length;
  const partialCount = cards.filter((card) => card.coverage === "PARTIAL").length;
  const unsupportedCount = cards.filter((card) => card.coverage === "UNSUPPORTED").length;
  const total = Math.max(1, cards.length);
  return {
    fullCount,
    partialCount,
    unsupportedCount,
    fullPercentage: fullCount / total,
    effectiveCoverage: (fullCount + partialCount * 0.5) / total,
    cards,
  };
}

export function formatDeckRulesCoverage(coverage: DeckRulesCoverage) {
  return `[RulesCoverage] FULL ${(coverage.fullPercentage * 100).toFixed(1)}%, PARTIAL ${((coverage.partialCount / Math.max(1, coverage.cards.length)) * 100).toFixed(1)}%, UNSUPPORTED ${((coverage.unsupportedCount / Math.max(1, coverage.cards.length)) * 100).toFixed(1)}%, effective ${(coverage.effectiveCoverage * 100).toFixed(1)}%`;
}
