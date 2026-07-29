import type {
  CardFaceMetadata,
  ConditionDescriptor,
  CostDescriptor,
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
const RUNTIME_EFFECTS = new Set<EffectDescriptor["type"]>([
  "DRAW_CARDS",
  "DISCARD",
  "GAIN_LIFE",
  "LOSE_LIFE",
  "DEAL_DAMAGE",
  "DESTROY",
  "EXILE",
  "RETURN_TO_HAND",
  "RETURN_FROM_GRAVEYARD_TO_HAND",
  "RETURN_FROM_GRAVEYARD_TO_BATTLEFIELD",
  "MILL",
  "CREATE_TOKEN",
  "ADD_COUNTER",
  "REMOVE_COUNTER",
  "TAP",
  "UNTAP",
  "ADD_MANA",
  "SEARCH_LIBRARY",
  "SACRIFICE",
  "GAIN_CONTROL",
  "MODIFY_POWER_TOUGHNESS",
  "GRANT_KEYWORD",
]);

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
    id: "KEYWORD_ABILITIES",
    matcher: /^(?:flying|first strike|double strike|deathtouch|haste|hexproof|indestructible|lifelink|menace|reach|trample|vigilance|ward(?: \{[^}]+\})?|flash)(?:,\s*(?:flying|first strike|double strike|deathtouch|haste|hexproof|indestructible|lifelink|menace|reach|trample|vigilance|ward(?: \{[^}]+\})?|flash))*$/i,
    abilityKind: "STATIC",
    supportLevel: "PARTIAL",
    parse: (fragment) => {
      const keywords = fragment.text.split(",").map((item) => item.trim().toLowerCase());
      const runtimeSupported = keywords.every((keyword) =>
        ["haste", "vigilance", "flying", "reach"].includes(keyword)
      );
      return [{
        kind: "STATIC",
        effects: keywords.map((keyword) => ({ type: "GRANT_KEYWORD" as const, keyword, target: "self" as const, duration: "PERMANENT" as const })),
        sourceFragment: fragment.text,
        patternId: "KEYWORD_ABILITIES",
        supportLevel: runtimeSupported ? "FULL" : "PARTIAL",
      }];
    },
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
    id: "ETB_TRIGGER",
    matcher: (fragment) => {
      if (/\bwhen .+ enters(?: the battlefield)?, (?:draw|you gain)\b/i.test(fragment.text)) return null;
      return fragment.text.match(/\bwhen .+ enters(?: the battlefield)?,? (.+)$/i);
    },
    abilityKind: "TRIGGERED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => parseEffectText((match as RegExpMatchArray)?.[1] ?? "").map((effect) => ({
      kind: "TRIGGERED",
      trigger: trigger("PERMANENT_ENTERED"),
      conditions: [{ type: "SOURCE_IS_THIS" }],
      effects: [effect],
      sourceFragment: fragment.text,
      patternId: "ETB_TRIGGER",
      supportLevel: "PARTIAL",
    })),
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
    id: "DIES_TRIGGER",
    matcher: (fragment) => {
      if (/\bwhen .+ dies, draw (a|an|one|two|three|\d+) cards?\b/i.test(fragment.text)) return null;
      return fragment.text.match(/\bwh?en(?:ever)? (.+?) dies,? (.+)$/i);
    },
    abilityKind: "TRIGGERED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => parseEffectText((match as RegExpMatchArray)?.[2] ?? "").map((effect) => ({
      kind: "TRIGGERED",
      trigger: trigger("CREATURE_DIED"),
      conditions: diesConditions((match as RegExpMatchArray)?.[1] ?? ""),
      effects: [effect],
      sourceFragment: fragment.text,
      patternId: "DIES_TRIGGER",
      supportLevel: "PARTIAL",
    })),
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
    id: "BEGINNING_COMBAT_TRIGGER",
    matcher: /\bat the beginning of combat on your turn,? (.+)$/i,
    abilityKind: "TRIGGERED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => parseEffectText((match as RegExpMatchArray)?.[1] ?? "").map((effect) => ({
      kind: "TRIGGERED",
      trigger: trigger("ATTACKER_DECLARED"),
      conditions: [{ type: "CONTROLLER_IS_YOU" }],
      effects: [effect],
      sourceFragment: fragment.text,
      patternId: "BEGINNING_COMBAT_TRIGGER",
      supportLevel: "PARTIAL",
    })),
  },
  {
    id: "BEGINNING_END_STEP_TRIGGER",
    matcher: /\bat the beginning of your end step,? (.+)$/i,
    abilityKind: "TRIGGERED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => parseEffectText((match as RegExpMatchArray)?.[1] ?? "").map((effect) => ({
      kind: "TRIGGERED",
      trigger: trigger("TURN_STARTED"),
      conditions: [{ type: "CONTROLLER_IS_YOU" }],
      effects: [effect],
      sourceFragment: fragment.text,
      patternId: "BEGINNING_END_STEP_TRIGGER",
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
    id: "COMBAT_DAMAGE_TRIGGER",
    matcher: /\bwhenever (.+?) deals? combat damage to a player,? (.+)$/i,
    abilityKind: "TRIGGERED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => parseEffectText((match as RegExpMatchArray)?.[2] ?? "").map((effect) => ({
      kind: "TRIGGERED",
      trigger: trigger("COMBAT_DAMAGE_DEALT"),
      conditions: combatDamageConditions((match as RegExpMatchArray)?.[1] ?? ""),
      effects: [effect],
      sourceFragment: fragment.text,
      patternId: "COMBAT_DAMAGE_TRIGGER",
      supportLevel: "PARTIAL",
    })),
  },
  {
    id: "PERMANENT_TYPE_ENTERED_TRIGGER",
    matcher: /\bwhenever (?:this creature or )?(?:another |an? )?([a-z -]+?) you control enters,? (.+)$/i,
    abilityKind: "TRIGGERED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => {
      const subject = ((match as RegExpMatchArray)?.[1] ?? "").trim();
      const effects = parseEffectText((match as RegExpMatchArray)?.[2] ?? "");
      return effects.map((effect) => ({
        kind: "TRIGGERED",
        trigger: trigger("PERMANENT_ENTERED"),
        conditions: enteredPermanentConditions(subject),
        effects: [effect],
        sourceFragment: fragment.text,
        patternId: "PERMANENT_TYPE_ENTERED_TRIGGER",
        supportLevel: "PARTIAL",
      }));
    },
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
    id: "GRAVEYARD_RETURN_TO_HAND",
    matcher: standaloneMatcher(/\breturn (?:up to one )?(?:target )?(.+?) card from your graveyard to your hand\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => {
      const raw = ((match as RegExpMatchArray)?.[1] ?? "card").trim();
      const cardType = cardTypeFromText(raw);
      const optional = /\bup to one\b/i.test(fragment.text);
      return [{
        kind: "SPELL_EFFECT",
        effects: [{
          type: "RETURN_FROM_GRAVEYARD_TO_HAND",
          fromZone: "graveyard",
          toZone: "hand",
          cardType,
          subtype: subtypeFromText(raw),
          controller: "self",
          optional,
        }],
        targets: [graveyardTarget(cardType, optional, subtypeFromText(raw))],
        sourceFragment: fragment.text,
        patternId: "GRAVEYARD_RETURN_TO_HAND",
        supportLevel: "FULL",
      }];
    },
  },
  {
    id: "GRAVEYARD_RETURN_TO_BATTLEFIELD",
    matcher: standaloneMatcher(/\breturn (?:up to one )?(?:target )?(.+?) card from your graveyard to the battlefield\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => {
      const raw = ((match as RegExpMatchArray)?.[1] ?? "permanent").trim();
      const cardType = cardTypeFromText(raw);
      const optional = /\bup to one\b/i.test(fragment.text);
      return [{
        kind: "SPELL_EFFECT",
        effects: [{
          type: "RETURN_FROM_GRAVEYARD_TO_BATTLEFIELD",
          fromZone: "graveyard",
          toZone: "battlefield",
          cardType,
          subtype: subtypeFromText(raw),
          controller: "self",
          optional,
        }],
        targets: [graveyardTarget(cardType, optional, subtypeFromText(raw))],
        sourceFragment: fragment.text,
        patternId: "GRAVEYARD_RETURN_TO_BATTLEFIELD",
        supportLevel: "FULL",
      }];
    },
  },
  {
    id: "GRAVEYARD_RETURN_NAMED",
    matcher: (fragment) => /\btarget\b/i.test(fragment.text)
      ? null
      : standaloneMatcher(/\breturn ([^,]+?) from your graveyard to (your hand|the battlefield)\b/i)(fragment),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => {
      const destination = ((match as RegExpMatchArray)?.[2] ?? "your hand").toLowerCase();
      const type = destination.includes("battlefield")
        ? "RETURN_FROM_GRAVEYARD_TO_BATTLEFIELD"
        : "RETURN_FROM_GRAVEYARD_TO_HAND";
      return [{
        kind: "SPELL_EFFECT",
        effects: [{ type, fromZone: "graveyard", toZone: destination.includes("battlefield") ? "battlefield" : "hand", cardType: "card", controller: "self" }],
        targets: [graveyardTarget("card", false)],
        sourceFragment: fragment.text,
        patternId: "GRAVEYARD_RETURN_NAMED",
        supportLevel: "PARTIAL",
      }];
    },
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
    id: "GAIN_CONTROL",
    matcher: standaloneMatcher(/\bgain control of (target creature|target permanent|target nonland permanent|all creatures)(?: until end of turn)?\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => {
      const targetText = ((match as RegExpMatchArray)?.[1] ?? "target permanent").toLowerCase();
      const creature = targetText.includes("creature");
      return [{
        kind: "SPELL_EFFECT",
        effects: [{
          type: "GAIN_CONTROL",
          target: targetText.includes("all creatures") ? "eachCreature" : creature ? "targetCreature" : "targetPermanent",
          duration: /\buntil end of turn\b/i.test(fragment.text) ? "UNTIL_END_OF_TURN" : "PERMANENT",
        }],
        targets: targetText.includes("all creatures") ? undefined : [battlefieldTarget(creature ? "creature" : "permanent", "opponent")],
        sourceFragment: fragment.text,
        patternId: "GAIN_CONTROL",
        supportLevel: "FULL",
      }];
    },
  },
  {
    id: "AURA_CONTROL",
    matcher: /\byou control enchanted creature\b/i,
    abilityKind: "STATIC",
    supportLevel: "PARTIAL",
    parse: (fragment) => [{
      kind: "STATIC",
      effects: [{ type: "GAIN_CONTROL", target: "targetCreature", duration: "WHILE_SOURCE_ON_BATTLEFIELD" }],
      targets: [battlefieldTarget("creature", "opponent")],
      sourceFragment: fragment.text,
      patternId: "AURA_CONTROL",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "MODIFY_POWER_TOUGHNESS",
    matcher: standaloneMatcher(/\b(?:target )?creature(?: you control| an opponent controls)? gets ([+-]\d+)\/([+-]\d+)(?: until end of turn)?\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => {
      const controller = /you control/i.test(fragment.text)
        ? "self"
        : /opponent controls/i.test(fragment.text)
          ? "opponent"
          : "any";
      return [{
        kind: "SPELL_EFFECT",
        effects: [{
          type: "MODIFY_POWER_TOUGHNESS",
          target: "targetCreature",
          powerDelta: Number((match as RegExpMatchArray)?.[1] ?? 0),
          toughnessDelta: Number((match as RegExpMatchArray)?.[2] ?? 0),
          duration: /\buntil end of turn\b/i.test(fragment.text) ? "UNTIL_END_OF_TURN" : "PERMANENT",
          controller,
        }],
        targets: [battlefieldTarget("creature", controller)],
        sourceFragment: fragment.text,
        patternId: "MODIFY_POWER_TOUGHNESS",
        supportLevel: "FULL",
      }];
    },
  },
  {
    id: "STATIC_POWER_TOUGHNESS",
    matcher: standaloneMatcher(/\b(?:other )?([a-z -]+?)s? you control(?: but don't own)? get ([+-]\d+)\/([+-]\d+)\b/i),
    abilityKind: "STATIC",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "STATIC",
      conditions: enteredPermanentConditions(((match as RegExpMatchArray)?.[1] ?? "").trim()),
      effects: [{
        type: "MODIFY_POWER_TOUGHNESS",
        target: "eachCreature",
        powerDelta: Number((match as RegExpMatchArray)?.[2] ?? 0),
        toughnessDelta: Number((match as RegExpMatchArray)?.[3] ?? 0),
        duration: "WHILE_SOURCE_ON_BATTLEFIELD",
        controller: "self",
      }],
      sourceFragment: fragment.text,
      patternId: "STATIC_POWER_TOUGHNESS",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "STATIC_KEYWORD_GRANT",
    matcher: standaloneMatcher(/\bcreatures you control have (flying|haste|vigilance|reach|menace|deathtouch|lifelink|trample)\b/i),
    abilityKind: "STATIC",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "STATIC",
      effects: [{
        type: "GRANT_KEYWORD",
        target: "eachCreature",
        keyword: ((match as RegExpMatchArray)?.[1] ?? "").toLowerCase(),
        duration: "WHILE_SOURCE_ON_BATTLEFIELD",
        controller: "self",
      }],
      sourceFragment: fragment.text,
      patternId: "STATIC_KEYWORD_GRANT",
      supportLevel: ["haste", "vigilance", "flying", "reach"].includes(((match as RegExpMatchArray)?.[1] ?? "").toLowerCase())
        ? "PARTIAL"
        : "PARTIAL",
    }],
  },
  {
    id: "GRANT_KEYWORD_UNTIL_EOT",
    matcher: standaloneMatcher(/\b(?:(?:target )?creature(?: you control| an opponent controls)?|it) gains (haste|vigilance|flying|reach)(?: until end of turn)?\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => {
      const controller = /you control/i.test(fragment.text)
        ? "self"
        : /opponent controls/i.test(fragment.text)
          ? "opponent"
          : "any";
      return [{
        kind: "SPELL_EFFECT",
        effects: [{
          type: "GRANT_KEYWORD",
          target: "targetCreature",
          keyword: ((match as RegExpMatchArray)?.[1] ?? "").toLowerCase(),
          duration: /\buntil end of turn\b/i.test(fragment.text) ? "UNTIL_END_OF_TURN" : "PERMANENT",
          controller,
        }],
        targets: [battlefieldTarget("creature", controller)],
        sourceFragment: fragment.text,
        patternId: "GRANT_KEYWORD_UNTIL_EOT",
        supportLevel: "FULL",
      }];
    },
  },
  {
    id: "TAP_TARGET",
    matcher: standaloneMatcher(/\btap (?:up to (one|two|three|\d+) )?target (creatures?|permanents?)\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      effects: [{
        type: "TAP",
        amount: amount((match as RegExpMatchArray)?.[1]),
        target: ((match as RegExpMatchArray)?.[2] ?? "").toLowerCase().includes("permanent") ? "targetPermanent" : "targetCreature",
        optional: /\bup to\b/i.test(fragment.text),
      }],
      targets: [battlefieldTarget(((match as RegExpMatchArray)?.[2] ?? "").toLowerCase().includes("permanent") ? "permanent" : "creature", "any")],
      sourceFragment: fragment.text,
      patternId: "TAP_TARGET",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "SKIP_NEXT_UNTAP",
    matcher: standaloneMatcher(/\bdoesn't untap during its controller's next untap step\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment) => [{
      kind: "SPELL_EFFECT",
      effects: [{ type: "TAP", target: "targetPermanent", duration: "UNTIL_YOUR_NEXT_TURN" }],
      targets: [battlefieldTarget("permanent", "any")],
      sourceFragment: fragment.text,
      patternId: "SKIP_NEXT_UNTAP",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "UNTAP_TARGET",
    matcher: standaloneMatcher(/\buntap (?:up to (one|two|three|\d+) )?target (creatures?|permanents?)\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      effects: [{
        type: "UNTAP",
        amount: amount((match as RegExpMatchArray)?.[1]),
        target: ((match as RegExpMatchArray)?.[2] ?? "").toLowerCase().includes("permanent") ? "targetPermanent" : "targetCreature",
        optional: /\bup to\b/i.test(fragment.text),
      }],
      targets: [battlefieldTarget(((match as RegExpMatchArray)?.[2] ?? "").toLowerCase().includes("permanent") ? "permanent" : "creature", "any")],
      sourceFragment: fragment.text,
      patternId: "UNTAP_TARGET",
      supportLevel: "PARTIAL",
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
    id: "LOSE_LIFE",
    matcher: standaloneMatcher(/\b(each opponent|target opponent|target player|you) loses? (one|two|three|\d+) life\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => {
      const targetText = ((match as RegExpMatchArray)?.[1] ?? "target opponent").toLowerCase();
      const target = targetText.includes("each opponent")
        ? "eachOpponent"
        : targetText.includes("you")
          ? "self"
          : "opponent";
      return [{
        kind: "SPELL_EFFECT",
        effects: [{ type: "LOSE_LIFE", amount: amount((match as RegExpMatchArray)?.[2]), target }],
        sourceFragment: fragment.text,
        patternId: "LOSE_LIFE",
        supportLevel: "FULL",
      }];
    },
  },
  {
    id: "CREATE_TOKEN",
    matcher: standaloneMatcher(/\bcreate (.+? tokens?(?: .+)?)$/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => {
      const token = parseTokenDescriptor((match as RegExpMatchArray)?.[1] ?? fragment.text);
      return [{
        kind: "SPELL_EFFECT",
        effects: [{ type: "CREATE_TOKEN", token }],
        sourceFragment: fragment.text,
        patternId: "CREATE_TOKEN",
        supportLevel: token.countMode === "forEach" || token.count === "X" ? "PARTIAL" : "FULL",
      }];
    },
  },
  {
    id: "MILL",
    matcher: standaloneMatcher(/\bmill (one|two|three|four|five|six|seven|eight|nine|ten|\d+) cards?\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      effects: [{ type: "MILL", amount: amount((match as RegExpMatchArray)?.[1]), target: "self" }],
      sourceFragment: fragment.text,
      patternId: "MILL",
      supportLevel: "FULL",
    }],
  },
  {
    id: "ADD_COUNTER",
    matcher: standaloneMatcher(/\bput (a|an|one|two|three|\d+)?\s*([+-]1\/[+-]1|[a-z ]+?) counters? on (target creature|target permanent|.+?)\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      effects: [{
        type: "ADD_COUNTER",
        amount: amount((match as RegExpMatchArray)?.[1]),
        counterType: normalizeCounterType((match as RegExpMatchArray)?.[2]),
        target: ((match as RegExpMatchArray)?.[3] ?? "").toLowerCase().includes("permanent") ? "targetPermanent" : "targetCreature",
      }],
      targets: [counterTarget(((match as RegExpMatchArray)?.[3] ?? ""))],
      sourceFragment: fragment.text,
      patternId: "ADD_COUNTER",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "REMOVE_COUNTER",
    matcher: standaloneMatcher(/\bremove (a|an|one|two|three|\d+)?\s*(?:([+-]1\/[+-]1|[a-z ]+?) )?counters? from (target creature|target permanent|.+?)\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      effects: [{
        type: "REMOVE_COUNTER",
        amount: amount((match as RegExpMatchArray)?.[1]),
        counterType: normalizeCounterType((match as RegExpMatchArray)?.[2] ?? "counter"),
        target: ((match as RegExpMatchArray)?.[3] ?? "").toLowerCase().includes("permanent") ? "targetPermanent" : "targetCreature",
      }],
      targets: [counterTarget(((match as RegExpMatchArray)?.[3] ?? ""))],
      sourceFragment: fragment.text,
      patternId: "REMOVE_COUNTER",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "TARGET_PLAYER_SACRIFICES",
    matcher: standaloneMatcher(/\btarget player sacrifices (a|an|one|two|three|\d+)?\s*(creature|artifact|enchantment|permanent)\b/i),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [sacrificeEffectAbility(fragment, match, "opponent")],
  },
  {
    id: "SACRIFICE_EFFECT",
    matcher: (fragment) => /\bas an additional cost\b/i.test(fragment.text)
      ? null
      : standaloneMatcher(/\bsacrifice (?:another )?(a|an|one|two|three|\d+)?\s*(creature|artifact|enchantment|permanent)\b/i)(fragment),
    abilityKind: "SPELL_EFFECT",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [sacrificeEffectAbility(fragment, match, "self")],
  },
  {
    id: "SACRIFICE_ADDITIONAL_COST",
    matcher: /\bas an additional cost to cast this spell, sacrifice (a|an|one|two|three|\d+)?\s*(creature|artifact|enchantment|permanent)\b/i,
    abilityKind: "SPELL_EFFECT",
    supportLevel: "FULL",
    parse: (fragment, match) => [{
      kind: "SPELL_EFFECT",
      costs: [sacrificeCost(match)],
      effects: [],
      sourceFragment: fragment.text,
      patternId: "SACRIFICE_ADDITIONAL_COST",
      supportLevel: "FULL",
    }],
  },
  {
    id: "SACRIFICE_ACTIVATED_COST",
    matcher: /\bsacrifice (a|an|one|two|three|\d+)?\s*(creature|artifact|enchantment|permanent):\s*(.+)$/i,
    abilityKind: "ACTIVATED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "ACTIVATED",
      costs: [sacrificeCost(match)],
      effects: parseEffectText((match as RegExpMatchArray)?.[3] ?? ""),
      sourceFragment: fragment.text,
      patternId: "SACRIFICE_ACTIVATED_COST",
      supportLevel: "PARTIAL",
    }],
  },
  {
    id: "FETCH_LAND_ACTIVATED",
    matcher: /\{T\},\s*Sacrifice this land:\s*Search your library for (?:an?|one)?\s*([A-Za-z ]+?) card, put it onto the battlefield( tapped)?/i,
    abilityKind: "ACTIVATED",
    supportLevel: "PARTIAL",
    parse: (fragment, match) => [{
      kind: "ACTIVATED",
      costs: [{ type: "SACRIFICE", amount: 1, cardType: "permanent", controller: "self" }],
      effects: [{
        type: "SEARCH_LIBRARY",
        fromZone: "library",
        toZone: "battlefield",
        subtype: ((match as RegExpMatchArray)?.[1] ?? "").trim(),
        tapped: Boolean((match as RegExpMatchArray)?.[2]),
      }],
      sourceFragment: fragment.text,
      patternId: "FETCH_LAND_ACTIVATED",
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

function cardTypeFromText(raw: string): NonNullable<EffectDescriptor["cardType"]> {
  const text = raw.toLowerCase();
  if (text.includes("creature")) return "creature";
  if (text.includes("artifact")) return "artifact";
  if (text.includes("enchantment")) return "enchantment";
  if (text.includes("permanent")) return "permanent";
  return "card";
}

function subtypeFromText(raw: string) {
  const stripped = raw
    .replace(/\b(target|card|creature|artifact|enchantment|permanent|up to one)\b/gi, "")
    .trim();
  return stripped.length ? stripped : undefined;
}

function graveyardTarget(
  cardType: NonNullable<EffectDescriptor["cardType"]>,
  optional: boolean,
  subtype?: string
): TargetRequirement {
  return {
    type: "CARD_IN_GRAVEYARD",
    zone: "graveyard",
    controller: "self",
    owner: "self",
    cardType,
    subtype,
    required: !optional,
    optional,
  };
}

function normalizeCounterType(raw?: string) {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "counter") return "counter";
  if (value === "+1/+1" || value === "-1/-1") return value;
  return value.replace(/\s+counter$/, "").trim();
}

function counterTarget(raw: string): TargetRequirement {
  const permanent = raw.toLowerCase().includes("permanent");
  return {
    type: permanent ? "PERMANENT" : "CREATURE",
    zone: "battlefield",
    controller: "any",
    cardType: permanent ? "permanent" : "creature",
    required: true,
  };
}

function battlefieldTarget(
  cardType: NonNullable<TargetRequirement["cardType"]>,
  controller: NonNullable<TargetRequirement["controller"]>
): TargetRequirement {
  return {
    type: cardType === "creature" ? "CREATURE" : "PERMANENT",
    zone: "battlefield",
    controller,
    cardType,
    required: true,
  };
}

function combatDamageConditions(raw: string) {
  const text = raw.toLowerCase();
  if (text.includes("pirate")) {
    return [{ type: "CONTROLLER_IS_YOU" as const }, { type: "HAS_SUBTYPE" as const, subtype: "Pirate" }];
  }
  if (text.includes("one or more creatures you control")) return [{ type: "CONTROLLER_IS_YOU" as const }];
  if (text.includes("you control")) return [{ type: "CONTROLLER_IS_YOU" as const }];
  return [{ type: "SOURCE_IS_THIS" as const }];
}

function enteredPermanentConditions(raw: string): ConditionDescriptor[] {
  const text = raw.toLowerCase();
  const conditions: ConditionDescriptor[] = [{ type: "CONTROLLER_IS_YOU" }];
  if (text.includes("artifact")) return conditions.concat([{ type: "HAS_SUBTYPE" as const, subtype: "Artifact" }]);
  if (text.includes("creature") && !text.includes("pirate")) return conditions.concat([{ type: "IS_CREATURE" as const }]);
  if (text.includes("pirate")) return conditions.concat([{ type: "HAS_SUBTYPE" as const, subtype: "Pirate" }]);
  if (text.includes("skeleton")) return conditions.concat([{ type: "HAS_SUBTYPE" as const, subtype: "Skeleton" }]);
  return conditions;
}

function diesConditions(raw: string): ConditionDescriptor[] {
  const text = raw.toLowerCase();
  if (text.includes("another creature you control") || text.includes("a creature you control")) {
    return [{ type: "CONTROLLER_IS_YOU" }, { type: "IS_CREATURE" }];
  }
  if (text.includes("pirate")) {
    return [{ type: "CONTROLLER_IS_YOU" }, { type: "HAS_SUBTYPE", subtype: "Pirate" }];
  }
  return [{ type: "SOURCE_IS_THIS" }];
}

function sacrificeCost(match: RegExpMatchArray | boolean | null): CostDescriptor {
  const array = match as RegExpMatchArray;
  return {
    type: "SACRIFICE",
    amount: amount(array?.[1]),
    cardType: cardTypeFromText(array?.[2] ?? "permanent") as NonNullable<CostDescriptor["cardType"]>,
    controller: "self",
  };
}

function sacrificeEffectAbility(
  fragment: OracleFragment,
  match: RegExpMatchArray | boolean | null,
  controller: "self" | "opponent"
): ParsedAbility {
  const array = match as RegExpMatchArray;
  const cardType = cardTypeFromText(array?.[2] ?? "permanent");
  return {
    kind: "SPELL_EFFECT",
    effects: [{
      type: "SACRIFICE",
      amount: amount(array?.[1]),
      cardType,
      controller,
      target: controller === "self" ? "self" : "opponent",
    }],
    sourceFragment: fragment.text,
    patternId: controller === "self" ? "SACRIFICE_EFFECT" : "TARGET_PLAYER_SACRIFICES",
    supportLevel: "PARTIAL",
  };
}

function parseTokenDescriptor(raw: string): NonNullable<EffectDescriptor["token"]> {
  const text = raw.toLowerCase();
  if (/\btreasure\b/.test(text)) {
    return { name: "Treasure", count: tokenCount(raw), countMode: tokenCountMode(raw), types: ["Artifact"], subtypes: ["Treasure"], tapped: /\btapped\b/i.test(raw), abilities: ["{T}, Sacrifice this artifact: Add one mana of any color."] };
  }
  if (/\bclue\b/.test(text)) {
    return { name: "Clue", count: tokenCount(raw), countMode: tokenCountMode(raw), types: ["Artifact"], subtypes: ["Clue"], tapped: /\btapped\b/i.test(raw), abilities: ["{2}, Sacrifice this artifact: Draw a card."] };
  }
  if (/\bfood\b/.test(text)) {
    return { name: "Food", count: tokenCount(raw), countMode: tokenCountMode(raw), types: ["Artifact"], subtypes: ["Food"], tapped: /\btapped\b/i.test(raw), abilities: ["{2}, {T}, Sacrifice this artifact: You gain 3 life."] };
  }

  const stats = raw.match(/(\d+)\/(\d+)/);
  const afterStats = stats ? raw.slice((stats.index ?? 0) + stats[0].length) : raw;
  const subtypeMatch = afterStats.match(/(?:white|blue|black|red|green|colorless|tapped|attacking|artifact|creature|\s)+([A-Za-z][A-Za-z -]*?) creature/i);
  const subtypes = subtypeMatch?.[1]?.trim() ? subtypeMatch[1].trim().split(/\s+/) : undefined;
  return {
    name: subtypes?.length ? subtypes.join(" ") : "Token",
    count: tokenCount(raw),
    countMode: tokenCountMode(raw),
    colors: tokenColors(raw),
    types: [/\bartifact\b/i.test(raw) ? "Artifact" : "", /\bcreature\b/i.test(raw) ? "Creature" : ""].filter(Boolean),
    subtypes,
    power: stats ? Number(stats[1]) : undefined,
    toughness: stats ? Number(stats[2]) : undefined,
    tapped: /\btapped\b/i.test(raw),
    attacking: /\battacking\b/i.test(raw),
  };
}

function tokenCount(raw: string): number | "X" {
  if (/^x\b/i.test(raw.trim())) return "X";
  if (/\bfor each\b/i.test(raw)) return 1;
  const first = raw.trim().match(/^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)/i)?.[1];
  return amount(first);
}

function tokenCountMode(raw: string): "fixed" | "x" | "forEach" {
  if (/^x\b/i.test(raw.trim())) return "x";
  if (/\bfor each\b/i.test(raw)) return "forEach";
  return "fixed";
}

function tokenColors(raw: string) {
  const colors: string[] = [];
  for (const [word, code] of Object.entries({ white: "W", blue: "U", black: "B", red: "R", green: "G" })) {
    if (new RegExp(`\\b${word}\\b`, "i").test(raw)) colors.push(code);
  }
  return colors.length ? colors : undefined;
}

function abilityRuntimeSupported(ability: ParsedAbility) {
  return (ability.effects ?? []).every((effect) => RUNTIME_EFFECTS.has(effect.type));
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
    .filter((fragment) => !/^[)"'`]+$/.test(fragment))
    .filter((fragment) => !/^\(.+\)?$/.test(fragment))
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
      const supportedAbilities = match.abilities.map((ability) => ({
        ...ability,
        supportLevel: abilityRuntimeSupported(ability) ? ability.supportLevel : "PARTIAL" as const,
      }));
      abilities.push(...supportedAbilities);
      recognizedFragments.push({
        fragment: fragment.text,
        patternId: match.definition.id,
        supportLevel: supportedAbilities.some((ability) => ability.supportLevel === "PARTIAL")
          ? "PARTIAL"
          : "FULL",
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
