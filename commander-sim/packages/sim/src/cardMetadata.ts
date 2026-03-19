import fetch from "node-fetch";
import type { DeckCardMetadata } from "@game-state/types";

const cache = new Map<string, DeckCardMetadata>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (name: string) => name.trim().toLowerCase();
const PERMANENT_TYPES = [
  "land",
  "creature",
  "artifact",
  "enchantment",
  "planeswalker",
  "battle",
];

function parseStat(value?: string | null) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }
  return undefined;
}

function extractOracleText(data: any): string | undefined {
  if (typeof data?.oracle_text === "string" && data.oracle_text.trim().length) {
    return data.oracle_text;
  }
  if (Array.isArray(data?.card_faces)) {
    const joined = data.card_faces
      .map((face: any) => face?.oracle_text)
      .filter((text: unknown): text is string => typeof text === "string" && text.trim().length > 0)
      .join("\n");
    return joined.length ? joined : undefined;
  }
  return undefined;
}

function detectManaProduction(text?: string): number | undefined {
  if (!text) return undefined;
  let maxValue = 0;
  const addRegex = /Add\s+((?:\{[^}]+\})+)/gi;
  let match: RegExpExecArray | null;
  while ((match = addRegex.exec(text))) {
    const chunk = match[1];
    const tokens = chunk.match(/\{[^}]+\}/g) ?? [];
    const manaSymbols = tokens.filter((symbol) => symbol.toUpperCase() !== "{T}").length;
    if (manaSymbols > maxValue) {
      maxValue = manaSymbols;
    }
  }

  const textualPatterns: Record<number, RegExp> = {
    3: /Add three mana/iu,
    2: /Add two mana/iu,
    1: /Add one mana/iu,
  };
  for (const [value, regex] of Object.entries(textualPatterns)) {
    if (regex.test(text)) {
      maxValue = Math.max(maxValue, Number(value));
      break;
    }
  }
  if (/Add any combination of/i.test(text)) {
    maxValue = Math.max(maxValue, 2);
  }

  return maxValue > 0 ? maxValue : undefined;
}

function attachAlias(meta: DeckCardMetadata, originalName: string) {
  const alias = originalName?.trim();
  if (!alias) return;
  const aliasLower = alias.toLowerCase();
  const canonicalLower = meta.name?.toLowerCase();
  if (canonicalLower && canonicalLower === aliasLower) return;
  const next = new Set(meta.aliases ?? []);
  next.add(alias);
  meta.aliases = Array.from(next);
}

export async function fetchCardMetadata(name: string): Promise<DeckCardMetadata | null> {
  const key = normalize(name);
  if (cache.has(key)) {
    const cached = cache.get(key)!;
    attachAlias(cached, name);
    return cached;
  }

  try {
    const response = await fetch(
      `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`
    );
    if (!response.ok) {
      console.warn(`[CardMetadata] ${name} -> ${response.status} ${response.statusText}`);
      return null;
    }
    const data: any = await response.json();
    const typeLine =
      typeof data.type_line === "string"
        ? data.type_line
        : data.card_faces?.[0]?.type_line ?? undefined;
    const typeLower = typeof typeLine === "string" ? typeLine.toLowerCase() : undefined;
    const manaValue =
      typeof data.mana_value === "number"
        ? data.mana_value
        : typeof data.cmc === "number"
          ? data.cmc
          : undefined;
    const oracleText = extractOracleText(data);
    const power =
      parseStat(data.power) ?? parseStat(data.card_faces?.[0]?.power ?? undefined);
    const toughness =
      parseStat(data.toughness) ??
      parseStat(data.card_faces?.[0]?.toughness ?? undefined);

    const meta: DeckCardMetadata = {
      name: data.name ?? name,
      typeLine,
      oracleText,
      manaValue,
      power,
      toughness,
      isLand: typeLower?.includes("land"),
      isCreature: typeLower?.includes("creature"),
      isArtifact: typeLower?.includes("artifact"),
      isPermanent: typeLower
        ? PERMANENT_TYPES.some((token) => typeLower.includes(token))
        : undefined,
      manaProduction: detectManaProduction(oracleText),
      colors: Array.isArray(data.colors) ? data.colors : undefined,
      colorIdentity: Array.isArray(data.color_identity) ? data.color_identity : undefined,
    };
    attachAlias(meta, name);

    const canonicalKey = meta.name ? normalize(meta.name) : key;
    cache.set(key, meta);
    cache.set(canonicalKey, meta);
    await sleep(50);
    return meta;
  } catch (err) {
    console.warn(`[CardMetadata] Failed to fetch ${name}:`, err);
    return null;
  }
}

export async function buildDeckMetadata(cards: string[]): Promise<DeckCardMetadata[]> {
  const unique = [...new Set(cards.map((card) => card.trim()).filter(Boolean))];
  const results: DeckCardMetadata[] = [];
  for (const card of unique) {
    const meta = await fetchCardMetadata(card);
    if (meta) {
      attachAlias(meta, card);
      results.push(meta);
    } else {
      results.push({
        name: card,
        isLand: card.toLowerCase().includes("land"),
        isCreature: card.toLowerCase().includes("creature"),
        isPermanent: card.toLowerCase().includes("land") || card.toLowerCase().includes("creature"),
        aliases: [card],
      });
    }
  }
  return results;
}
