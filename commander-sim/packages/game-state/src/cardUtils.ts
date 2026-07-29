import type {
  CardName,
  DeckCardMetadata,
  PermanentState,
  SimAction,
  SimGameState,
  StackEntry,
} from "./types.js";

const PERMANENT_CARD_TYPES = [
  "land",
  "creature",
  "artifact",
  "enchantment",
  "planeswalker",
  "battle",
];

const KNOWN_NONBASIC_LANDS = new Set([
  "arena of glory",
  "bad river",
  "boggart trawler / boggart bog",
  "cascade bluffs",
  "command beacon",
  "command tower",
  "crosis's catacombs",
  "dimir aqueduct",
  "drowned catacomb",
  "exotic orchard",
  "fabled passage",
  "glasspool mimic / glasspool shore",
  "graven cairns",
  "haunted ridge",
  "high market",
  "malakir rebirth / malakir mire",
  "opal palace",
  "phyrexian tower",
  "pinnacle monk / mystic peak",
  "reflecting pool",
  "rocky tar pit",
  "shipwreck marsh",
  "steam vents",
  "stormcarved coast",
  "sunken ruins",
]);

export function normalizeCardName(card: string) {
  if (typeof card !== "string") return "";
  return card.trim().toLowerCase();
}

export function getCardMetadata(
  state: SimGameState,
  player: number,
  card: CardName
) {
  const map = state.cardMetadata?.[player];
  if (!map) return undefined;
  const normalized = normalizeCardName(card);
  if (map[normalized]) return map[normalized];
  if (normalized.includes(" / ")) {
    const variant = normalized.replace(/\s*\/\s*/g, " // ");
    if (map[variant]) return map[variant];
  }
  if (normalized.includes("//")) {
    const variant = normalized.replace(/\s*\/\/\s*/g, " / ");
    if (map[variant]) return map[variant];
  }
  return undefined;
}

export function getLandFaceMetadata(metadata?: DeckCardMetadata) {
  return metadata?.landFace;
}

export function getSpellFaceMetadata(metadata?: DeckCardMetadata) {
  return metadata?.spellFace;
}

export function getLandPermanentName(card: CardName, metadata?: DeckCardMetadata) {
  return metadata?.landFace?.name ?? metadata?.name ?? card;
}

export function getSpellPermanentName(card: CardName, metadata?: DeckCardMetadata) {
  return metadata?.spellFace?.name ?? metadata?.name ?? card;
}

export function activeFaceMetadata(
  metadata: DeckCardMetadata | undefined,
  face?: string
) {
  if (!metadata || !face) return metadata;
  const normalized = normalizeCardName(face);
  return metadata.faces?.find((candidate) => normalizeCardName(candidate.name) === normalized) ??
    (metadata.landFace && normalizeCardName(metadata.landFace.name) === normalized
      ? metadata.landFace
      : metadata.spellFace && normalizeCardName(metadata.spellFace.name) === normalized
        ? metadata.spellFace
        : metadata);
}

export function isLandCard(
  state: SimGameState,
  player: number,
  card: CardName
) {
  const metadata = getCardMetadata(state, player, card);
  if (metadata?.landFace) return true;
  if (metadata?.isLand !== undefined) return metadata.isLand;
  if (metadata?.typeLine?.toLowerCase().includes("land")) return true;
  const normalized = normalizeCardName(card);
  if (!normalized) return false;
  if (normalized.includes("land")) return true;
  if (normalized === "plains") return true;
  if (normalized === "island") return true;
  if (normalized === "swamp") return true;
  if (normalized === "mountain") return true;
  if (normalized === "forest") return true;
  if (normalized === "wastes") return true;
  if (KNOWN_NONBASIC_LANDS.has(normalized)) return true;
  if (/^snow-covered (plains|island|swamp|mountain|forest)$/i.test(normalized)) {
    return true;
  }
  return false;
}

export function isCastableSpellCard(
  state: SimGameState,
  player: number,
  card: CardName
) {
  const metadata = getCardMetadata(state, player, card);
  if (metadata?.spellFace) return true;
  return !isLandCard(state, player, card);
}

export function isInstantLike(metadata?: DeckCardMetadata, face?: string) {
  const active = activeFaceMetadata(metadata, face);
  const typeLine = active?.typeLine?.toLowerCase() ?? metadata?.typeLine?.toLowerCase() ?? "";
  return active?.isInstant === true || typeLine.includes("instant");
}

export function isSorceryLike(metadata?: DeckCardMetadata, face?: string) {
  const active = activeFaceMetadata(metadata, face);
  const typeLine = active?.typeLine?.toLowerCase() ?? metadata?.typeLine?.toLowerCase() ?? "";
  return active?.isSorcery === true || typeLine.includes("sorcery");
}

export function hasFlash(metadata?: DeckCardMetadata, face?: string) {
  const active = activeFaceMetadata(metadata, face);
  const text = `${active?.oracleText ?? ""}\n${metadata?.oracleText ?? ""}`;
  const keywords = new Set([...(active?.keywords ?? []), ...(metadata?.faces?.flatMap((item) => item.keywords ?? []) ?? [])]);
  return keywords.has("Flash") || /\bflash\b/i.test(text);
}

function detectUnconditionalEntersTapped(text?: string) {
  if (!text) return undefined;
  const sentence = text
    .split(/[\.\n]/)
    .map((part) => part.trim())
    .find((part) => /\benters(?: the battlefield)? tapped\b/i.test(part));
  if (!sentence) return undefined;
  if (/\b(if|unless|you may|as .* enters|choose)\b/i.test(sentence)) {
    return false;
  }
  return true;
}

export function landEntersTapped(metadata?: DeckCardMetadata) {
  return (
    metadata?.landFace?.entersTapped ??
    metadata?.entersTapped ??
    detectUnconditionalEntersTapped(metadata?.landFace?.oracleText) ??
    detectUnconditionalEntersTapped(metadata?.oracleText) ??
    false
  );
}

export function getPermanentCardNames(state: SimGameState, player: number) {
  const permanents = state.permanents?.[player];
  if (permanents?.length) return permanents.map((permanent) => permanent.face ?? permanent.cardName);
  return state.battlefields[player] ?? [];
}

export function getPermanentStateForCard(
  state: SimGameState,
  player: number,
  card: CardName
): PermanentState | undefined {
  const normalized = normalizeCardName(card);
  return state.permanents?.[player]?.find(
    (permanent) =>
      normalizeCardName(permanent.face ?? permanent.cardName) === normalized ||
      normalizeCardName(permanent.cardName) === normalized
  );
}

export function isPermanentCard(card: CardName, metadata?: DeckCardMetadata) {
  if (metadata?.isPermanent !== undefined) return metadata.isPermanent;
  if (metadata?.typeLine) {
    const typeLower = metadata.typeLine.toLowerCase();
    if (typeLower.includes("instant") || typeLower.includes("sorcery")) {
      return false;
    }
    return PERMANENT_CARD_TYPES.some((keyword) => typeLower.includes(keyword));
  }
  const lowered = card.toLowerCase();
  if (lowered.includes("instant") || lowered.includes("sorcery")) return false;
  return PERMANENT_CARD_TYPES.some((keyword) => lowered.includes(keyword));
}

export function isArtifactCard(card: CardName, metadata?: DeckCardMetadata) {
  if (metadata?.isArtifact !== undefined) return metadata.isArtifact;
  if (metadata?.typeLine) return metadata.typeLine.toLowerCase().includes("artifact");
  return card.toLowerCase().includes("artifact");
}

export function cardNameMatches(
  metadata: DeckCardMetadata | undefined,
  cardName: CardName,
  target: string
) {
  const targetLower = target.toLowerCase();
  if (metadata?.name && metadata.name.toLowerCase() === targetLower) return true;
  if (metadata?.aliases?.some((alias) => alias.toLowerCase() === targetLower)) {
    return true;
  }
  return cardName.toLowerCase() === targetLower;
}

export function cardHasSubtype(
  metadata: DeckCardMetadata | undefined,
  subtype: string
) {
  const lower = subtype.toLowerCase();
  if (!metadata?.typeLine) return false;
  return metadata.typeLine.toLowerCase().includes(lower);
}

export function isBasicPlainsCard(
  metadata: DeckCardMetadata | undefined,
  cardName: CardName
) {
  const isNamedPlains = cardName.trim().toLowerCase() === "plains";
  const typeLower = metadata?.typeLine?.toLowerCase() ?? "";
  if (isNamedPlains) return true;
  return typeLower.includes("basic") && typeLower.includes("plains");
}

export function countLands(state: SimGameState, player: number) {
  const battlefield = state.battlefields[player] ?? [];
  return battlefield.filter((card) => isLandCard(state, player, card)).length;
}

export function isInstantCard(
  state: SimGameState,
  player: number,
  card: CardName,
  metadata?: DeckCardMetadata
) {
  const info = metadata ?? getCardMetadata(state, player, card);
  if (info?.typeLine?.toLowerCase().includes("instant")) return true;
  if (card.toLowerCase().includes("instant")) return true;
  return false;
}

export function isSorceryCard(
  state: SimGameState,
  player: number,
  card: CardName,
  metadata?: DeckCardMetadata
) {
  const info = metadata ?? getCardMetadata(state, player, card);
  if (info?.typeLine?.toLowerCase().includes("sorcery")) return true;
  if (card.toLowerCase().includes("sorcery")) return true;
  return false;
}

export function isCounterspell(card: CardName, metadata?: DeckCardMetadata) {
  const text = metadata?.oracleText?.toLowerCase() ?? "";
  const name = card.toLowerCase();
  return /counter\s+(?:up to\s+one\s+)?target/.test(text) || name.includes("counterspell");
}

export function getAvailableMana(
  state: SimGameState,
  playerIndex: number
) {
  const permanentLands = state.permanents?.[playerIndex]?.filter((permanent) => {
    if (permanent.tapped) return false;
    return isLandCard(state, playerIndex, permanent.face ?? permanent.cardName);
  });
  if (permanentLands?.length || state.permanents?.[playerIndex]?.length) {
    const artifactMana = state.artifactMana[playerIndex] ?? 0;
    const spent = state.manaSpent?.[playerIndex] ?? 0;
    return Math.max(0, (permanentLands?.length ?? 0) + artifactMana - spent);
  }

  const tapped = { ...(state.tappedPermanents?.[playerIndex] ?? {}) };
  const lands = (state.battlefields[playerIndex] ?? []).filter((card) => {
    if (!isLandCard(state, playerIndex, card)) return false;
    const key = normalizeCardName(card);
    const tappedCount = tapped[key] ?? 0;
    if (tappedCount > 0) {
      tapped[key] = tappedCount - 1;
      return false;
    }
    return true;
  }).length;
  const artifactMana = state.artifactMana[playerIndex] ?? 0;
  const spent = state.manaSpent?.[playerIndex] ?? 0;
  return Math.max(0, lands + artifactMana - spent);
}

function getStackSpellMetadata(
  state: SimGameState,
  entry: StackEntry
) {
  if (entry.action.type !== "CAST_SPELL") return undefined;
  return getCardMetadata(state, entry.casterIndex, entry.action.card);
}

function canCounterTarget(
  state: SimGameState,
  triggeringEntry: StackEntry,
  metadata?: DeckCardMetadata
) {
  if (triggeringEntry.action.type !== "CAST_SPELL") return false;
  const text = metadata?.oracleText?.toLowerCase() ?? "";
  if (!/counter\s+(?:up to\s+one\s+)?target/.test(text)) return false;

  const targetMetadata = getStackSpellMetadata(state, triggeringEntry);
  if (!targetMetadata) return true;

  if (/target creature spell/.test(text)) {
    const typeLine = targetMetadata.typeLine?.toLowerCase() ?? "";
    return typeLine.includes("creature") || targetMetadata.isCreature === true;
  }
  if (/target noncreature spell/.test(text)) {
    const typeLine = targetMetadata.typeLine?.toLowerCase() ?? "";
    return !typeLine.includes("creature") && targetMetadata.isCreature !== true;
  }
  if (/target instant spell/.test(text)) {
    return isInstantCard(
      state,
      triggeringEntry.casterIndex,
      triggeringEntry.action.card,
      targetMetadata
    );
  }
  if (/target sorcery spell/.test(text)) {
    const typeLine = targetMetadata.typeLine?.toLowerCase() ?? "";
    return typeLine.includes("sorcery");
  }
  if (/target artifact spell/.test(text)) {
    return isArtifactCard(triggeringEntry.action.card, targetMetadata);
  }
  if (/target enchantment spell/.test(text)) {
    const typeLine = targetMetadata.typeLine?.toLowerCase() ?? "";
    return typeLine.includes("enchantment");
  }

  return true;
}

export function getAvailableInstants(
  state: SimGameState,
  playerIndex: number,
  triggeringEntry?: StackEntry
): SimAction[] {
  const hand = state.hands[playerIndex] ?? [];
  const totalMana = getAvailableMana(state, playerIndex);

  return hand
    .filter((card) => {
      const metadata = getCardMetadata(state, playerIndex, card);
      if (!isInstantCard(state, playerIndex, card, metadata) && !hasFlash(metadata)) return false;
      const cmc = metadata?.spellFace?.manaValue ?? metadata?.manaValue ?? 0;
      if (cmc > totalMana) return false;
      if (!triggeringEntry) return true;
      return canRespondWith(state, playerIndex, card, triggeringEntry, metadata);
    })
    .map((card) => {
      const metadata = getCardMetadata(state, playerIndex, card);
      return {
        type: "CAST_SPELL" as const,
        card,
        targetStackId:
          triggeringEntry && isCounterspell(card, metadata)
            ? triggeringEntry.id
            : undefined,
      };
    });
}

export function canRespondWith(
  state: SimGameState,
  player: number,
  card: CardName,
  triggeringEntry: StackEntry,
  metadata?: DeckCardMetadata
): boolean {
  const typeLine = (metadata?.typeLine ?? "").toLowerCase();
  const isInstant = typeLine.includes("instant") || card.toLowerCase().includes("instant");
  if (!isInstant) return false;
  if (triggeringEntry.casterIndex === player) return false;
  if (isCounterspell(card, metadata)) {
    return canCounterTarget(state, triggeringEntry, metadata);
  }
  return (
    triggeringEntry.action.type === "CAST_SPELL" ||
    triggeringEntry.action.type === "DECLARE_ATTACKERS"
  );
}
