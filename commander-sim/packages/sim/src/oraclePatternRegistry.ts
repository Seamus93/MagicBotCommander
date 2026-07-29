import type {
  CardFaceMetadata,
  DeckCardMetadata,
  EffectDescriptor,
  ParsedAbility,
  RulesCoverageLevel,
  RulesEventType,
  TargetRequirement,
} from "@game-state/types";
import { parseMechanics } from "./mechanicRegistry.js";

export type AbilityKind =
  | "TRIGGERED"
  | "ACTIVATED"
  | "STATIC"
  | "REPLACEMENT"
  | "SPELL_EFFECT";

export interface OracleFragment {
  cardName: string;
  faceName?: string;
  text: string;
  metadata: DeckCardMetadata;
}

export interface OraclePatternDefinition {
  id: string;
  matcher: RegExp | ((fragment: OracleFragment) => RegExpMatchArray | boolean | null);
  abilityKind: AbilityKind;
  supportLevel: "FULL" | "PARTIAL";
  parse: (fragment: OracleFragment, match: RegExpMatchArray | boolean | null) => ParsedAbility[];
}

export interface ParsedCardRules {
  card: string;
  supportLevel: RulesCoverageLevel;
  abilities: ParsedAbility[];
  recognizedFragments: Array<{ fragment: string; patternId: string; supportLevel: "FULL" | "PARTIAL" }>;
  unsupportedFragments: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function amount(raw?: string) {
  if (!raw) return 1;
  const normalized = raw.toLowerCase();
  const parsed = NUMBER_WORDS[normalized] ?? Number(normalized);
  return Number.isFinite(parsed) ? parsed : 1;
}

const trigger = (eventType: RulesEventType) => ({ eventType, source: "self" as const });
const targetCreature: TargetRequirement = { type: "CREATURE", controller: "opponent", required: true };
const triggerLike = (text: string) => /^(when|whenever|at the beginning)\b/i.test(text.trim());

function standaloneMatcher(regex: RegExp) {
  return (fragment: OracleFragment) => triggerLike(fragment.text) ? null : fragment.text.match(regex);
}

export const ORACLE_PATTERN_REGISTRY: OraclePatternDefinition[] = [
  {
    id: "ENTERS_TAPPED",
    matcher: /\benters(?: the battlefield)? tapped\b/i,
    abilityKind: "REPLACEMENT",
    supportLevel: "FULL",
    parse: (fragment) => [{
      kind: "REPLACEMENT",
      effects: [{ type: "TAP", target: "self" }],
      sourceFragment: fragment.text,
      patternId: "ENTERS_TAPPED",
      supportLevel: "FULL",
    }],
  },
  {
    id: "ETB_DRAW",
    matcher: /\bwhen .+ enters(?: the battlefield)?, draw (a|an|one|two|three|\d+) cards?\b/i,
    abilityKind: "TRIGGERED",
    supportLevel: "FULL",
    parse: (fragment, match) => [{
      kind: "TRIGGERED",
      trigger: trigger("PERMANENT_ENTERED"),
      conditions: [{ type: "SOURCE_IS_THIS" }],
      effects: [{ type: "DRAW_CARDS", amount: amount((match as RegExpMatchArray)?.[1]), target: "self" }],
      sourceFragment: fragment.text,
      patternId: "ETB_DRAW",
      supportLevel: "FULL",
    }],
  },
  {
    id: "ETB_GAIN_LIFE",
    matcher: /\bwhen .+ enters(?: the battlefield)?, you gain (one|two|three|\d+) life\b/i,
    abilityKind: "TRIGGERED",
    supportLevel: "FULL",
    parse: (fragment, match) => [{
      kind: "TRIGGERED",
      trigger: trigger("PERMANENT_ENTERED"),
      conditions: [{ type: "SOURCE_IS_THIS" }],
      effects: [{ type: "GAIN_LIFE", amount: amount((match as RegExpMatchArray)?.[1]), target: "self" }],
      sourceFragment: fragment.text,
      patternId: "ETB_GAIN_LIFE",
      supportLevel: "FULL",
    }],
  },
  {
    id: "DIES_DRAW",
    matcher: /\bwhen .+ dies, draw (a|an|one|two|three|\d+) cards?\b/i,
    abilityKind: "TRIGGERED",
    supportLevel: "FULL",
    parse: (fragment, match) => [{
      kind: "TRIGGERED",
      trigger: trigger("CREATURE_DIED"),
      conditions: [{ type: "SOURCE_IS_THIS" }],
      effects: [{ type: "DRAW_CARDS", amount: amount((match as RegExpMatchArray)?.[1]), target: "self" }],
      sourceFragment: fragment.text,
      patternId: "DIES_DRAW",
      supportLevel: "FULL",
    }],
  },
  {
    id: "UPKEEP_TRIGGER",
    matcher: /\bat the beginning of your upkeep,? (.+)$/i,
    abilityKind: "TRIGGERED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => parseEffectText((match as RegExpMatchArray)?.[1] ?? fragment.text).map((effect) => ({
      kind: "TRIGGERED",
      trigger: trigger("UPKEEP_STARTED"),
      conditions: [{ type: "CONTROLLER_IS_YOU" }],
      effects: [effect],
      sourceFragment: fragment.text,
      patternId: "UPKEEP_TRIGGER",
      supportLevel: "PARTIAL",
    })),
  },
  {
    id: "ATTACK_TRIGGER",
    matcher: /\bwhenever .+ attacks,? (.+)$/i,
    abilityKind: "TRIGGERED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => parseEffectText((match as RegExpMatchArray)?.[1] ?? "").map((effect) => ({
      kind: "TRIGGERED",
      trigger: trigger("ATTACKER_DECLARED"),
      conditions: [{ type: "SOURCE_IS_THIS" }],
      effects: [effect],
      sourceFragment: fragment.text,
      patternId: "ATTACK_TRIGGER",
      supportLevel: "PARTIAL",
    })),
  },
  {
    id: "DRAW_CARDS",
    matcher: standaloneMatcher(/\bdraw (a|an|one|two|three|\d+) cards?\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      effects: [{ type: "DRAW_CARDS", amount: amount((match as RegExpMatchArray)?.[1]), target: "self" }],
      sourceFragment: fragment.text,
      patternId: "DRAW_CARDS",
      supportLevel: "FULL",
    }],
  },
  {
    id: "DESTROY_TARGET_CREATURE",
    matcher: standaloneMatcher(/\bdestroy target creature\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment) => [{
      kind: "SPELL_EFFECT",
      effects: [{ type: "DESTROY", target: "targetCreature" }],
      targets: [targetCreature],
      sourceFragment: fragment.text,
      patternId: "DESTROY_TARGET_CREATURE",
      supportLevel: "FULL",
    }],
  },
  {
    id: "EXILE_TARGET",
    matcher: standaloneMatcher(/\bexile target (creature|permanent|artifact|enchantment)\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment) => [{
      kind: "SPELL_EFFECT",
      effects: [{ type: "EXILE", target: "targetPermanent" }],
      targets: [{ type: "PERMANENT", controller: "opponent", required: true }],
      sourceFragment: fragment.text,
      patternId: "EXILE_TARGET",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "DEAL_DAMAGE",
    matcher: standaloneMatcher(/\bdeals? (\d+|x) damage to (any target|target player|target opponent|each opponent|each player|target creature)\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => {
      const destination = ((match as RegExpMatchArray)?.[2] ?? "").toLowerCase();
      const target = destination.includes("each opponent")
        ? "eachOpponent"
        : destination.includes("each player")
          ? "eachPlayer"
          : destination.includes("creature")
            ? "targetCreature"
            : "opponent";
      return [{
        kind: "SPELL_EFFECT",
        effects: [{ type: "DEAL_DAMAGE", amount: amount((match as RegExpMatchArray)?.[1]), target }],
        targets: target === "targetCreature" ? [targetCreature] : undefined,
        sourceFragment: fragment.text,
        patternId: "DEAL_DAMAGE",
        supportLevel: "FULL",
      }];
    },
  },
  {
    id: "GAIN_LIFE",
    matcher: standaloneMatcher(/\b(?:you gain|target player gains) (one|two|three|\d+) life\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      effects: [{ type: "GAIN_LIFE", amount: amount((match as RegExpMatchArray)?.[1]), target: "self" }],
      sourceFragment: fragment.text,
      patternId: "GAIN_LIFE",
      supportLevel: "FULL",
    }],
  },
  {
    id: "CREATE_TOKEN",
    matcher: standaloneMatcher(/\bcreate (a|an|one|two|three|\d+)?\s*(?:.*?)(\d+)\/(\d+).* tokens?\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      effects: [{
        type: "CREATE_TOKEN",
        token: {
          name: "Token",
          power: Number((match as RegExpMatchArray)?.[2] ?? 1),
          toughness: Number((match as RegExpMatchArray)?.[3] ?? 1),
          count: amount((match as RegExpMatchArray)?.[1]),
        },
      }],
      sourceFragment: fragment.text,
      patternId: "CREATE_TOKEN",
      supportLevel: "FULL",
    }],
  },
  {
    id: "ADD_COUNTER",
    matcher: standaloneMatcher(/\bput (a|an|one|two|three|\d+) \+1\/\+1 counters? on target creature\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      effects: [{ type: "ADD_COUNTER", amount: amount((match as RegExpMatchArray)?.[1]), counterType: "+1/+1", target: "targetCreature" }],
      targets: [targetCreature],
      sourceFragment: fragment.text,
      patternId: "ADD_COUNTER",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "ADD_MANA",
    matcher: /\badd ((?:\{[^}]+\})+|one mana|two mana|three mana)/i,
    abilityKind: "ACTIVATED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "ACTIVATED",
      effects: [{ type: "ADD_MANA", amount: manaAmount((match as RegExpMatchArray)?.[1]), target: "self" }],
      sourceFragment: fragment.text,
      patternId: "ADD_MANA",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "COST_REDUCTION",
    matcher: /\b(.+?) spells you cast cost \{(\d+)\} less to cast\b/i,
    abilityKind: "STATIC",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "STATIC",
      conditions: [{ type: "HAS_SUBTYPE", subtype: ((match as RegExpMatchArray)?.[1] ?? "").trim() }],
      effects: [{ type: "ADD_MANA", amount: Number((match as RegExpMatchArray)?.[2] ?? 1) }],
      sourceFragment: fragment.text,
      patternId: "COST_REDUCTION",
      supportLevel: "PARTIAL",
    }],
  },
];

function manaAmount(raw?: string) {
  if (!raw) return 1;
  const symbols = raw.match(/\{[^}]+\}/g);
  if (symbols?.length) return symbols.filter((symbol) => symbol.toUpperCase() !== "{T}").length;
  if (/three/i.test(raw)) return 3;
  if (/two/i.test(raw)) return 2;
  return 1;
}

export function matchOraclePatterns(fragment: OracleFragment) {
  return ORACLE_PATTERN_REGISTRY.flatMap((definition) => {
    const match = typeof definition.matcher === "function"
      ? definition.matcher(fragment)
      : fragment.text.match(definition.matcher);
    if (!match) return [];
    const abilities = definition.parse(fragment, match);
    return [{ definition, abilities }];
  });
}

function parseEffectText(text: string): EffectDescriptor[] {
  const fragment: OracleFragment = {
    cardName: "effect",
    text,
    metadata: { name: "effect", oracleText: text },
  };
  return matchOraclePatterns(fragment)
    .flatMap((match) => match.abilities)
    .flatMap((ability) => ability.effects);
}

export function oracleFragmentsForCard(metadata: DeckCardMetadata): OracleFragment[] {
  const faces = metadata.faces?.length
    ? metadata.faces
    : [metadata.landFace, metadata.spellFace].filter(Boolean) as CardFaceMetadata[];
  if (faces.length) {
    return faces
      .filter((face) => face.oracleText?.trim())
      .flatMap((face) => splitOracleText(face.oracleText!).map((text) => ({
        cardName: metadata.name,
        faceName: face.name,
        text,
        metadata,
      })));
  }
  return splitOracleText(metadata.oracleText ?? "").map((text) => ({
    cardName: metadata.name,
    text,
    metadata,
  }));
}

export function splitOracleText(text: string) {
  return text
    .split(/[\n\.]/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
}

export function parseCardRules(metadata: DeckCardMetadata): ParsedCardRules {
  const fragments = oracleFragmentsForCard(metadata);
  const abilities: ParsedAbility[] = [];
  const recognizedFragments: ParsedCardRules["recognizedFragments"] = [];
  const unsupportedFragments: string[] = [];

  for (const fragment of fragments) {
    const matches = matchOraclePatterns(fragment);
    const mechanicAbilities = parseMechanics(fragment);
    if (!matches.length && !mechanicAbilities.length) {
      unsupportedFragments.push(fragment.text);
      continue;
    }
    for (const match of matches) {
      abilities.push(...match.abilities);
      recognizedFragments.push({
        fragment: fragment.text,
        patternId: match.definition.id,
        supportLevel: match.definition.supportLevel,
      });
    }
    for (const ability of mechanicAbilities) {
      abilities.push(ability);
      recognizedFragments.push({
        fragment: fragment.text,
        patternId: ability.patternId ?? "MECHANIC",
        supportLevel: ability.supportLevel ?? "PARTIAL",
      });
    }
  }

  let supportLevel: RulesCoverageLevel = "FULL";
  if (unsupportedFragments.length > 0 && recognizedFragments.length > 0) supportLevel = "PARTIAL";
  if (unsupportedFragments.length > 0 && recognizedFragments.length === 0) supportLevel = "UNSUPPORTED";
  if (recognizedFragments.some((fragment) => fragment.supportLevel === "PARTIAL") && supportLevel === "FULL") {
    supportLevel = "PARTIAL";
  }
  if (!fragments.length) {
    const type = metadata.typeLine?.toLowerCase() ?? "";
    supportLevel = metadata.isLand || type.includes("land") ? "FULL" : metadata.isCreature || type.includes("creature") ? "PARTIAL" : "UNSUPPORTED";
  }

  return {
    card: metadata.name,
    supportLevel,
    abilities,
    recognizedFragments,
    unsupportedFragments,
  };
}
