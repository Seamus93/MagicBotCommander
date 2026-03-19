import type { DeckCardMetadata } from "@game-state/types";
import type { CreatureBlueprint } from "./types.js";

type BlueprintMap = Record<string, CreatureBlueprint>;

const CREATURE_LIBRARY: BlueprintMap = {
  "Savage Cub": { name: "Savage Cub", power: 2, toughness: 2, manaCost: 2 },
  "Wild Beast": { name: "Wild Beast", power: 3, toughness: 3, manaCost: 3 },
  "Titanic Ogre": { name: "Titanic Ogre", power: 5, toughness: 5, manaCost: 5 },
};

export function isCreatureCard(card: string, metadata?: DeckCardMetadata) {
  if (metadata?.isCreature !== undefined) return metadata.isCreature;
  if (metadata?.typeLine?.toLowerCase().includes("creature")) return true;
  if (CREATURE_LIBRARY[card]) return true;
  return card.toLowerCase().includes("creature");
}

export function getCreatureBlueprint(
  card: string,
  metadata?: DeckCardMetadata
): CreatureBlueprint {
  if (metadata) {
    return {
      name: metadata.name ?? card,
      power: metadata.power ?? 3,
      toughness: metadata.toughness ?? 3,
      manaCost: metadata.manaValue ?? 3,
    };
  }
  if (CREATURE_LIBRARY[card]) return CREATURE_LIBRARY[card];
  return {
    name: card,
    power: 3,
    toughness: 3,
    manaCost: 3,
  };
}
