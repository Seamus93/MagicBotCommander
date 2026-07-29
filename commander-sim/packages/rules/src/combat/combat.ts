import type { BlockAssignment, DeckCardMetadata } from "@game-state/types";
import type { SimGameState } from "@game-state/types";
import type { CreaturePermanent } from "./types.js";
import { getCreatureBlueprint } from "./library.js";
import {
  handlePermanentEntersBattlefield,
  removeTriggersForPermanent,
} from "../effects/abilityManager.js";

let creatureCounter = 0;
const nextCreatureId = () => `creature_${++creatureCounter}`;

export function readyCreaturesForTurn(state: SimGameState, player: number) {
  state.creatures[player].forEach((creature) => {
    creature.tapped = false;
    if (creature.summoningSickness) {
      creature.summoningSickness = false;
    }
  });
}

export function summonCreature(
  state: SimGameState,
  player: number,
  card: string,
  log: (msg: string) => void,
  metadata?: DeckCardMetadata
) {
  const blueprint = getCreatureBlueprint(card, metadata);
  const creature: CreaturePermanent = {
    id: nextCreatureId(),
    name: blueprint.name,
    power: blueprint.power,
    toughness: blueprint.toughness,
    tapped: false,
    summoningSickness: !hasKeyword(metadata, "haste"),
    keywords: runtimeKeywords(metadata),
  };
  state.creatures[player].push(creature);
  log(
    `Player ${player} summons ${creature.name} (${creature.power}/${creature.toughness})`
  );
  handlePermanentEntersBattlefield(state, player, card, metadata, log);
}

export function createTokenPermanent(
  state: SimGameState,
  player: number,
  token: { name: string; power: number; toughness: number; tapped?: boolean; keywords?: string[] }
) {
  const creature: CreaturePermanent = {
    id: nextCreatureId(),
    name: token.name,
    power: token.power,
    toughness: token.toughness,
    tapped: token.tapped ?? false,
    summoningSickness: !(token.keywords ?? []).some((keyword) => keyword.toLowerCase() === "haste"),
    keywords: token.keywords,
  };
  state.creatures[player].push(creature);
  return creature;
}

export function availableAttackers(
  state: SimGameState,
  player: number
): CreaturePermanent[] {
  return state.creatures[player].filter(
    (creature) =>
      creature.power > 0 &&
      !creature.tapped &&
      (!creature.summoningSickness || creatureHasKeyword(creature, "haste"))
  );
}

export function availableBlockers(
  state: SimGameState,
  player: number
): CreaturePermanent[] {
  return state.creatures[player].filter((creature) => !creature.tapped);
}

export function resolveCombat(
  state: SimGameState,
  attackingPlayer: number,
  defendingPlayer: number,
  attackerIds: string[],
  assignments: BlockAssignment[],
  log: (msg: string) => void
) {
  if (!attackerIds.length) return;

  const attackers = attackerIds
    .map((id) =>
      state.creatures[attackingPlayer].find((creature) => creature.id === id)
    )
    .filter((creature): creature is CreaturePermanent => Boolean(creature));

  const blockMap = new Map<
    string,
    { blocker: CreaturePermanent; controller: number }[]
  >();
  const usedBlockers = new Set<string>();

  for (const assignment of assignments) {
    if (!assignment.attackerId || usedBlockers.has(assignment.blockerId)) continue;
    const blocker = state.creatures[defendingPlayer].find(
      (creature) => creature.id === assignment.blockerId
    );
    if (!blocker) continue;
    const attacker = attackers.find((candidate) => candidate.id === assignment.attackerId);
    if (!attacker || !canBlockCreature(blocker, attacker)) continue;
    usedBlockers.add(assignment.blockerId);
    const list =
      blockMap.get(assignment.attackerId) ??
      [];
    list.push({ blocker, controller: defendingPlayer });
    blockMap.set(assignment.attackerId, list);
  }

  const deadAttackers: string[] = [];
  const deadBlockers: { id: string; controller: number }[] = [];

  for (const attacker of attackers) {
    if (!creatureHasKeyword(attacker, "vigilance")) attacker.tapped = true;
    const blockers = blockMap.get(attacker.id) ?? [];
    if (!blockers.length) {
      state.lifeTotals[defendingPlayer] -= attacker.power;
      log(
        `Player ${attackingPlayer}'s ${attacker.name} deals ${attacker.power} combat damage to Player ${defendingPlayer}`
      );
      continue;
    }

    const totalBlockerPower = blockers.reduce(
      (sum, entry) => sum + entry.blocker.power,
      0
    );
    if (totalBlockerPower >= attacker.toughness) {
      deadAttackers.push(attacker.id);
    }

    let remainingDamage = attacker.power;
    for (const entry of blockers) {
      if (remainingDamage <= 0) break;
      if (remainingDamage >= entry.blocker.toughness) {
        deadBlockers.push({
          id: entry.blocker.id,
          controller: entry.controller,
        });
      }
      remainingDamage -= entry.blocker.toughness;
    }
  }

  deadAttackers.forEach((id) => {
    destroyCreature(state, attackingPlayer, id, log);
  });
  deadBlockers.forEach(({ id, controller }) => {
    destroyCreature(state, controller, id, log);
  });
}

function runtimeKeywords(metadata?: DeckCardMetadata) {
  const text = `${metadata?.oracleText ?? ""}\n${metadata?.keywords?.join("\n") ?? ""}`;
  return ["haste", "vigilance", "flying", "reach"].filter((keyword) =>
    hasKeyword(metadata, keyword) || new RegExp(`\\b${keyword}\\b`, "i").test(text)
  );
}

function hasKeyword(metadata: DeckCardMetadata | undefined, keyword: string) {
  return metadata?.keywords?.some((candidate) => candidate.toLowerCase() === keyword) ?? false;
}

function creatureHasKeyword(creature: CreaturePermanent, keyword: string) {
  return creature.keywords?.some((candidate) => candidate.toLowerCase() === keyword) ?? false;
}

function canBlockCreature(blocker: CreaturePermanent, attacker: CreaturePermanent) {
  if (!creatureHasKeyword(attacker, "flying")) return true;
  return creatureHasKeyword(blocker, "flying") || creatureHasKeyword(blocker, "reach");
}

export function destroyCreature(
  state: SimGameState,
  controller: number,
  creatureId: string,
  log: (msg: string) => void
) {
  const pool = state.creatures[controller];
  const index = pool.findIndex((creature) => creature.id === creatureId);
  if (index === -1) return;
  const [creature] = pool.splice(index, 1);
  const owner = state.permanents?.[controller]?.find(
    (permanent) =>
      permanent.id === creature.id ||
      permanent.cardName === creature.name ||
      permanent.face === creature.name
  )?.owner ?? controller;
  state.graveyards[owner].push(creature.name);
  log(`Player ${controller}'s ${creature.name} dies in combat`);
  removeTriggersForPermanent(state, controller, creature.name);
}
