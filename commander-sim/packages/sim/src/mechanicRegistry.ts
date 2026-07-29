import type { ParsedAbility } from "@game-state/types";
import type { OracleFragment } from "./oraclePatternRegistry.js";

export interface MechanicDefinition {
  id: string;
  aliases: string[];
  supportLevel: "FULL" | "PARTIAL";
  parse: (fragment: OracleFragment) => ParsedAbility[];
}

const mechanics: MechanicDefinition[] = [];

export function registerMechanic(definition: MechanicDefinition) {
  mechanics.push(definition);
}

export function mechanicRegistry() {
  return [...mechanics];
}

export function parseMechanics(fragment: OracleFragment): ParsedAbility[] {
  const lower = fragment.text.toLowerCase();
  return mechanics.flatMap((mechanic) => {
    if (!mechanic.aliases.some((alias) => lower.includes(alias.toLowerCase()))) return [];
    return mechanic.parse(fragment);
  });
}

registerMechanic({
  id: "DETHRONE",
  aliases: ["dethrone"],
  supportLevel: "PARTIAL",
  parse: (fragment) => [{
    kind: "TRIGGERED",
    trigger: { eventType: "ATTACKER_DECLARED", source: "self" },
    conditions: [{ type: "OPPONENT_HAS_MORE_LIFE" }],
    effects: [{ type: "ADD_COUNTER", amount: 1, counterType: "+1/+1", target: "self" }],
    sourceFragment: fragment.text,
    patternId: "MECHANIC_DETHRONE",
    supportLevel: "PARTIAL",
  }],
});

registerMechanic({
  id: "RAID",
  aliases: ["raid"],
  supportLevel: "PARTIAL",
  parse: (fragment) => [{
    kind: "STATIC",
    conditions: [{ type: "ATTACKING_PLAYER", playerRelation: "controller_attacked_this_turn" }],
    effects: [],
    sourceFragment: fragment.text,
    patternId: "MECHANIC_RAID",
    supportLevel: "PARTIAL",
  }],
});

registerMechanic({
  id: "REVOLT",
  aliases: ["revolt"],
  supportLevel: "PARTIAL",
  parse: (fragment) => [{
    kind: "STATIC",
    conditions: [{ type: "PERMANENT_ENTERED_THIS_TURN" }, { type: "NOT", condition: { type: "SOURCE_IS_THIS" } }],
    effects: [],
    sourceFragment: fragment.text,
    patternId: "MECHANIC_REVOLT",
    supportLevel: "PARTIAL",
  }],
});
