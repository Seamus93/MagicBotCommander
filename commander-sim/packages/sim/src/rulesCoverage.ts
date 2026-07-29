import type { DeckCardMetadata, RulesCoverageLevel } from "@game-state/types";
import { parseCardRules } from "./oraclePatternRegistry.js";

export interface DeckRulesCoverage {
  fullCount: number;
  partialCount: number;
  unsupportedCount: number;
  fullPercentage: number;
  effectiveCoverage: number;
  cardSpecificRuleCount: number;
  cards: Array<{
    name: string;
    coverage: RulesCoverageLevel;
    reason: string;
    recognizedPatterns: string[];
    unsupportedFragments: string[];
  }>;
}

export interface GlobalRulesCoverage {
  decksAnalyzed: number;
  uniqueCards: number;
  fullCount: number;
  partialCount: number;
  unsupportedCount: number;
  effectiveCoverage: number;
  supportedPatternFrequency: Record<string, number>;
  unsupportedFragmentFrequency: Record<string, number>;
  unsupportedMechanicFrequency: Record<string, number>;
  topMissingCapabilities: Array<{
    capability: string;
    affectedCards: number;
    affectedDecks: number;
    examples: string[];
  }>;
  cardSpecificRuleCount: number;
}

const CARD_SPECIFIC_RULE_COUNT = 5;

export function classifyCardRulesCoverage(metadata: DeckCardMetadata): {
  coverage: RulesCoverageLevel;
  reason: string;
  recognizedPatterns: string[];
  unsupportedFragments: string[];
} {
  const parsed = parseCardRules(metadata);
  const recognizedPatterns = [...new Set(parsed.recognizedFragments.map((fragment) => fragment.patternId))];
  const reason = parsed.unsupportedFragments.length
    ? `unsupported fragments: ${parsed.unsupportedFragments.slice(0, 2).join(" | ")}`
    : recognizedPatterns.length
      ? `recognized patterns: ${recognizedPatterns.join(", ")}`
      : parsed.supportLevel === "FULL"
        ? "type-only rule support"
        : "no executable oracle pattern";
  return {
    coverage: parsed.supportLevel,
    reason,
    recognizedPatterns,
    unsupportedFragments: parsed.unsupportedFragments,
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
    cardSpecificRuleCount: CARD_SPECIFIC_RULE_COUNT,
    cards,
  };
}

export function analyzeRepositoryRulesCoverage(
  decks: Array<{ name?: string | null; cardMetadata?: DeckCardMetadata[] }>
): GlobalRulesCoverage {
  const unique = new Map<string, ReturnType<typeof classifyCardRulesCoverage> & { name: string; decks: Set<string> }>();
  const supportedPatternFrequency: Record<string, number> = {};
  const unsupportedFragmentFrequency: Record<string, number> = {};
  const unsupportedMechanicFrequency: Record<string, number> = {};

  for (const deck of decks) {
    const deckName = deck.name ?? "unknown";
    for (const metadata of deck.cardMetadata ?? []) {
      const key = metadata.name.toLowerCase();
      const classified = classifyCardRulesCoverage(metadata);
      const current = unique.get(key) ?? { name: metadata.name, ...classified, decks: new Set<string>() };
      current.decks.add(deckName);
      unique.set(key, current);
      for (const pattern of classified.recognizedPatterns) {
        supportedPatternFrequency[pattern] = (supportedPatternFrequency[pattern] ?? 0) + 1;
      }
      for (const fragment of classified.unsupportedFragments) {
        const bucket = bucketUnsupportedFragment(fragment);
        unsupportedFragmentFrequency[bucket] = (unsupportedFragmentFrequency[bucket] ?? 0) + 1;
        const mechanic = detectUnsupportedMechanic(fragment);
        if (mechanic) unsupportedMechanicFrequency[mechanic] = (unsupportedMechanicFrequency[mechanic] ?? 0) + 1;
      }
    }
  }

  const cards = [...unique.values()];
  const fullCount = cards.filter((card) => card.coverage === "FULL").length;
  const partialCount = cards.filter((card) => card.coverage === "PARTIAL").length;
  const unsupportedCount = cards.filter((card) => card.coverage === "UNSUPPORTED").length;
  const total = Math.max(1, cards.length);
  const topMissingCapabilities = Object.entries(unsupportedFragmentFrequency)
    .map(([capability]) => {
      const affected = cards.filter((card) =>
        card.unsupportedFragments.some((fragment) => bucketUnsupportedFragment(fragment) === capability)
      );
      return {
        capability,
        affectedCards: affected.length,
        affectedDecks: new Set(affected.flatMap((card) => [...card.decks])).size,
        examples: affected.slice(0, 5).map((card) => card.name),
      };
    })
    .sort((a, b) => b.affectedCards - a.affectedCards)
    .slice(0, 10);

  return {
    decksAnalyzed: decks.length,
    uniqueCards: cards.length,
    fullCount,
    partialCount,
    unsupportedCount,
    effectiveCoverage: (fullCount + partialCount * 0.5) / total,
    supportedPatternFrequency,
    unsupportedFragmentFrequency,
    unsupportedMechanicFrequency,
    topMissingCapabilities,
    cardSpecificRuleCount: CARD_SPECIFIC_RULE_COUNT,
  };
}

function bucketUnsupportedFragment(fragment: string) {
  const text = fragment.toLowerCase();
  if (text.includes("combat damage")) return "COMBAT_DAMAGE_TRIGGER";
  if (/^(flying|first strike|double strike|deathtouch|haste|hexproof|indestructible|lifelink|menace|reach|trample|vigilance|ward)/.test(text)) return "KEYWORD_STATIC";
  if (text.includes("changeling")) return "MECHANIC_CHANGELING";
  if (text.includes("transmute")) return "MECHANIC_TRANSMUTE";
  if (text.includes("exhaust")) return "MECHANIC_EXHAUST";
  if (text.includes("base power and toughness")) return "SET_BASE_POWER_TOUGHNESS";
  if (text.includes("destroy all creatures") || text.includes("destroy each creature")) return "SWEEPER_DESTROY";
  if (text.startsWith("untap") || text.includes(" untap ")) return "UNTAP_EFFECT";
  if (text.includes("equal to the life lost")) return "LIFE_LOST_SCALING";
  if (text.includes("from among them") || text.includes("bottom of your library")) return "LIBRARY_SELECTION";
  if (text.includes("attacks") || text.includes("attacking")) return "ATTACK_TRIGGER";
  if (text.includes("blocks") || text.includes("blocking")) return "BLOCK_TRIGGER";
  if (text.includes("graveyard") || /\breturn\b/.test(text)) return "GRAVEYARD_RETURN";
  if (text.includes("sacrifice")) return "SACRIFICE";
  if (text.includes("counter")) return "ADD_COUNTER";
  if (text.includes("create") && text.includes("token")) return "CREATE_TOKEN_COMPLEX";
  if (text.includes("land") && text.includes("enters")) return "LAND_ENTERED_TRIGGER";
  if (text.includes("draw")) return "DRAW_TRIGGER";
  if (text.includes("mill")) return "MILL";
  if (text.includes("search")) return "SEARCH";
  if (text.includes("reveal")) return "REVEAL";
  if (text.includes("copy")) return "COPY";
  if (text.includes("exile") && text.includes("return")) return "EXILE_THEN_RETURN";
  if (text.includes("control")) return "CONTROL";
  if (text.includes("cast")) return "CAST_TRIGGER";
  if (text.includes("target")) return "TARGET_EFFECT";
  if (text.includes("choose")) return "CHOOSE";
  if (text.includes("may")) return "MAY_OPTIONAL";
  if (text.includes("for each")) return "FOR_EACH";
  if (text.includes("until end of turn")) return "UNTIL_END_OF_TURN";
  if (text.includes("unless")) return "UNLESS_CONDITION";
  if (/\bif\b/.test(text)) return "IF_CONDITION";
  if (text.startsWith("whenever")) return "WHENEVER_TRIGGER";
  if (text.startsWith("when")) return "WHEN_TRIGGER";
  if (text.startsWith("at the beginning")) return "AT_BEGINNING_TRIGGER";
  return "UNCLASSIFIED_ORACLE_TEXT";
}

function detectUnsupportedMechanic(fragment: string) {
  const text = fragment.toLowerCase();
  for (const mechanic of ["dethrone", "landfall", "morbid", "raid", "revolt", "undying", "persist"]) {
    if (text.includes(mechanic)) return mechanic.toUpperCase();
  }
  return null;
}

export function formatDeckRulesCoverage(coverage: DeckRulesCoverage) {
  return `[RulesCoverage] FULL ${(coverage.fullPercentage * 100).toFixed(1)}%, PARTIAL ${((coverage.partialCount / Math.max(1, coverage.cards.length)) * 100).toFixed(1)}%, UNSUPPORTED ${((coverage.unsupportedCount / Math.max(1, coverage.cards.length)) * 100).toFixed(1)}%, effective ${(coverage.effectiveCoverage * 100).toFixed(1)}%, cardSpecificRules=${coverage.cardSpecificRuleCount}`;
}
