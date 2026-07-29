const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");
const { PrismaClient } = require("@prisma/client");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetchFn }) => fetchFn(...args));

const app = express();
const PORT = 3001;
const prisma = new PrismaClient();
let latestViewerState = null;
let latestViewerControl = {
  restartToken: null,
  updatedAt: null,
};
let latestViewerSession = {
  sessionId: null,
  source: null,
  updatedAt: null,
};

app.use(cors());
app.use(bodyParser.json());

// --- Helpers ----------------------------------------------------------------

const metadataCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PERMANENT_TYPES = ["land", "creature", "artifact", "enchantment", "planeswalker", "battle"];
const SCRYFALL_COLLECTION_BATCH_SIZE = 75;
const SCRYFALL_RETRY_DELAY_MS = 1200;

const parseStat = (value) => {
  if (value == null || value === "*") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const extractOracleText = (card = {}) => {
  if (typeof card.oracle_text === "string" && card.oracle_text.trim()) {
    return card.oracle_text;
  }
  if (Array.isArray(card.card_faces)) {
    const joined = card.card_faces
      .map((face) => face?.oracle_text)
      .filter((text) => typeof text === "string" && text.trim())
      .join("\n");
    return joined || undefined;
  }
  return undefined;
};

const detectManaProduction = (text) => {
  if (!text) return undefined;
  let maxValue = 0;
  const addRegex = /Add\s+((?:\{[^}]+\})+)/gi;
  let match;
  while ((match = addRegex.exec(text))) {
    const tokens = match[1].match(/\{[^}]+\}/g) ?? [];
    const manaSymbols = tokens.filter((symbol) => symbol.toUpperCase() !== "{T}").length;
    maxValue = Math.max(maxValue, manaSymbols);
  }
  if (/Add three mana/iu.test(text)) maxValue = Math.max(maxValue, 3);
  if (/Add two mana/iu.test(text) || /Add any combination of/iu.test(text)) maxValue = Math.max(maxValue, 2);
  if (/Add one mana/iu.test(text)) maxValue = Math.max(maxValue, 1);
  return maxValue > 0 ? maxValue : undefined;
};

const detectUnconditionalEntersTapped = (text) => {
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
};

const metadataFromFace = (face = {}) => {
  const typeLine = face.type_line ?? undefined;
  const typeLower = (typeLine ?? "").toLowerCase();
  const oracleText = typeof face.oracle_text === "string" ? face.oracle_text : undefined;
  const manaProduction = detectManaProduction(oracleText);
  return {
    name: face.name,
    typeLine,
    oracleText,
    manaValue: typeof face.mana_value === "number" ? face.mana_value : undefined,
    power: parseStat(face.power),
    toughness: parseStat(face.toughness),
    colors: Array.isArray(face.colors) ? face.colors : undefined,
    colorIdentity: Array.isArray(face.color_identity) ? face.color_identity : undefined,
    isLand: typeLower.includes("land") || undefined,
    isCreature: typeLower.includes("creature") || undefined,
    isPermanent: PERMANENT_TYPES.some((type) => typeLower.includes(type)) || undefined,
    entersTapped: detectUnconditionalEntersTapped(oracleText),
    producesMana: manaProduction !== undefined || undefined,
    manaProduction,
  };
};

const metadataFromScryfallCard = (card, originalName) => {
  const typeLine = card.type_line ?? card.card_faces?.[0]?.type_line ?? undefined;
  const typeLower = (typeLine ?? "").toLowerCase();
  const oracleText = extractOracleText(card);
  const faces = Array.isArray(card.card_faces)
    ? card.card_faces.map(metadataFromFace).filter((face) => face.name)
    : [];
  const landFace = faces.find((face) => face.isLand);
  const spellFace = faces.find((face) => !face.isLand);
  const manaProduction = landFace?.manaProduction ?? detectManaProduction(oracleText);
  const meta = {
    name: card.name ?? originalName,
    typeLine,
    oracleText,
    manaValue: typeof card.mana_value === "number" ? card.mana_value : card.cmc,
    power: parseStat(card.power ?? card.card_faces?.[0]?.power),
    toughness: parseStat(card.toughness ?? card.card_faces?.[0]?.toughness),
    isLand: (typeLower.includes("land") || Boolean(landFace)) || undefined,
    isCreature: (typeLower.includes("creature") || Boolean(spellFace?.isCreature)) || undefined,
    isArtifact: typeLower.includes("artifact") || undefined,
    isPermanent: PERMANENT_TYPES.some((type) => typeLower.includes(type)) || undefined,
    manaProduction,
    producesMana: manaProduction !== undefined || undefined,
    entersTapped: landFace?.entersTapped ?? detectUnconditionalEntersTapped(oracleText),
    landFace,
    spellFace,
    colors: Array.isArray(card.colors) ? card.colors : undefined,
    colorIdentity: Array.isArray(card.color_identity) ? card.color_identity : undefined,
    aliases: [
      ...(card.name && card.name !== originalName ? [originalName] : []),
      ...faces.map((face) => face.name).filter((name) => name && name !== card.name),
    ],
  };
  return meta;
};

const fetchCardMetadata = async (name) => {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  if (metadataCache.has(normalized)) return metadataCache.get(normalized);

  try {
    const response = await fetch(
      `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`,
      {
        headers: {
          "User-Agent": "MagicBotCommander/0.1",
          Accept: "application/json",
        },
      }
    );
    if (!response.ok) {
      console.warn(`[api] Scryfall metadata miss ${name}: ${response.status}`);
      return null;
    }
    const card = await response.json();
    const meta = metadataFromScryfallCard(card, name);
    metadataCache.set(normalized, meta);
    if (meta.name) metadataCache.set(meta.name.toLowerCase(), meta);
    await sleep(120);
    return meta;
  } catch (error) {
    console.warn(`[api] Scryfall metadata fetch failed for ${name}:`, error);
    return null;
  }
};

const buildDeckMetadata = async (cards = []) => {
  const unique = [...new Set(cards.map((card) => card.trim()).filter(Boolean))];
  const batchMetadata = await fetchDeckMetadataBatch(unique);
  if (batchMetadata.length >= Math.max(1, Math.floor(unique.length * 0.8))) {
    return batchMetadata;
  }

  const metadata = [];
  const seen = new Set(batchMetadata.map((entry) => entry.name?.toLowerCase()).filter(Boolean));
  metadata.push(...batchMetadata);
  for (const card of unique) {
    if (seen.has(card.toLowerCase())) continue;
    const meta = await fetchCardMetadata(card);
    if (meta) {
      metadata.push(meta);
      if (meta.name) seen.add(meta.name.toLowerCase());
    }
  }
  return metadata;
};

const fetchDeckMetadataBatch = async (cards = []) => {
  const metadata = [];
  for (let i = 0; i < cards.length; i += SCRYFALL_COLLECTION_BATCH_SIZE) {
    const batch = cards.slice(i, i + SCRYFALL_COLLECTION_BATCH_SIZE);
    try {
      const response = await fetchScryfallCollection(batch);
      if (!response.ok) {
        console.warn(`[api] Scryfall collection metadata failed: ${response.status}`);
        continue;
      }
      const payload = await response.json();
      for (const card of payload.data ?? []) {
        metadata.push(metadataFromScryfallCard(card, card.name));
      }
      await sleep(150);
    } catch (error) {
      console.warn("[api] Scryfall collection metadata fetch failed:", error);
    }
  }
  return metadata;
};

const fetchScryfallCollection = async (batch) => {
  const request = () =>
    fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: {
        "User-Agent": "MagicBotCommander/0.1",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        identifiers: batch.map((name) => ({ name })),
      }),
    });

  const first = await request();
  if (first.status !== 429) return first;

  const retryAfter = Number(first.headers.get("retry-after"));
  const delay = Number.isFinite(retryAfter)
    ? Math.max(1000, retryAfter * 1000)
    : SCRYFALL_RETRY_DELAY_MS;
  console.warn(`[api] Scryfall rate limited collection request; retrying in ${delay}ms`);
  await sleep(delay);
  return request();
};

const extractCards = (section = {}) => {
  const cards = [];
  Object.values(section).forEach((entry) => {
    if (!entry || !entry.quantity) return;
    const name = entry.card?.name;
    if (!name) return;
    for (let i = 0; i < entry.quantity; i += 1) {
      cards.push(name);
    }
  });
  return cards;
};

// Extract card metadata (type_line, manaValue, isLand, etc.) from a Moxfield section.
// Returns a map keyed by card name so duplicates are collapsed.
const extractSectionMetadata = (section = {}) => {
  const map = {};
  Object.values(section).forEach((entry) => {
    const card = entry?.card;
    if (!card?.name) return;
    if (map[card.name]) return; // already seen
    const typeLine = card.type_line ?? card.card_faces?.[0]?.type_line ?? undefined;
    const typeLower = (typeLine ?? "").toLowerCase();
    const oracleText = extractOracleText(card);
    const faces = Array.isArray(card.card_faces)
      ? card.card_faces.map(metadataFromFace).filter((face) => face.name)
      : [];
    const landFace = faces.find((face) => face.isLand);
    const spellFace = faces.find((face) => !face.isLand);
    const manaProduction = landFace?.manaProduction ?? detectManaProduction(oracleText);
    map[card.name] = {
      name: card.name,
      typeLine,
      oracleText,
      manaValue: typeof card.cmc === "number" ? card.cmc : undefined,
      power: card.power != null && card.power !== "*" ? Number(card.power) : undefined,
      toughness: card.toughness != null && card.toughness !== "*" ? Number(card.toughness) : undefined,
      isLand: (typeLower.includes("land") || Boolean(landFace)) || undefined,
      isCreature: (typeLower.includes("creature") || Boolean(spellFace?.isCreature)) || undefined,
      isArtifact: typeLower.includes("artifact") || undefined,
      isPermanent: PERMANENT_TYPES.some((t) => typeLower.includes(t)) || undefined,
      manaProduction,
      producesMana: manaProduction !== undefined || undefined,
      entersTapped: landFace?.entersTapped ?? detectUnconditionalEntersTapped(oracleText),
      landFace,
      spellFace,
      colors: Array.isArray(card.colors) ? card.colors : undefined,
      colorIdentity: Array.isArray(card.color_identity) ? card.color_identity : undefined,
      aliases: faces.map((face) => face.name).filter((name) => name && name !== card.name),
    };
  });
  return map;
};

const isMoxfieldLink = (value = "") =>
  /^https?:\/\/(?:www\.)?moxfield\.com\/decks\//i.test(value.trim());

const parseDeckText = (text = "") => {
  let inSideboard = false;
  const cards = [];
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith("#")) return false;
      if (/^sideboard[:]?$/i.test(line)) {
        inSideboard = true;
        return false;
      }
      return !inSideboard;
    })
    .forEach((line) => {
      const quantityMatch = line.match(/^(\d+)\s+(.+)$/);
      const quantity = quantityMatch ? Math.max(1, Number(quantityMatch[1])) : 1;
      const rawName = quantityMatch ? quantityMatch[2] : line;
      const name = rawName
        .replace(/\s+#.*$/i, "")
        .replace(/\s+\[[^\]]+\]\s*$/i, "")
        .split("(")[0]
        .trim();
      if (!name) return;
      for (let i = 0; i < quantity; i += 1) {
        cards.push(name);
      }
    });
  return cards;
};

const createDeckHash = (cards = []) => {
  const normalized = [...cards]
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const chr = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `deck_${Math.abs(hash)}`;
};

const upsertDeckRecord = async ({ cards, sourceUrl, name, commander, cardMetadata }) => {
  const cardHash = createDeckHash(cards);
  const existing = await prisma.deck.findUnique({ where: { cardHash } });
  if (existing) {
    // Aggiorna nome/commander/cardMetadata se ora li abbiamo e prima mancavano
    const existingMetadataCount = Array.isArray(existing.cardMetadata)
      ? existing.cardMetadata.length
      : 0;
    const needsUpdate =
      (name && !existing.name) ||
      (commander && !existing.commander) ||
      (cardMetadata?.length && existingMetadataCount === 0);
    if (needsUpdate) {
      return prisma.deck.update({
        where: { cardHash },
        data: {
          name: name ?? existing.name,
          commander: commander ?? existing.commander,
          cardMetadata: cardMetadata?.length ? cardMetadata : existing.cardMetadata,
        },
      });
    }
    return existing;
  }
  return prisma.deck.create({
    data: {
      cards,
      sourceUrl: sourceUrl ?? null,
      name: name ?? null,
      commander: commander ?? null,
      cardMetadata: cardMetadata ?? null,
      cardHash,
    },
  });
};

// Estrae il commander da un testo deck esportato (supporta "Commander\n1 Kaalia..." o "1 Kaalia #commander")
const extractCommanderFromText = (text = "") => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Sezione esplicita "Commander" o "Comandante"
    if (/^commander[s]?[:]?$/i.test(line) || /^comandante[i]?[:]?$/i.test(line)) {
      const next = lines[i + 1];
      if (next) return next.replace(/^\d+\s+/, "").split("(")[0].trim();
    }
    // Inline tag: "1 Kaalia of the Vast #commander"
    if (/#commander\b/i.test(line)) {
      return line.replace(/^\d+\s+/, "").replace(/#commander\b.*/i, "").trim();
    }
  }
  return null;
};

const fetchMoxfieldDeck = async (url) => {
  let slug;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    slug = parts[parts.length - 1];
  } catch (err) {
    slug = null;
  }
  if (!slug) {
    throw new Error("URL Moxfield non valido");
  }
  const apiUrl = `https://api2.moxfield.com/v2/decks/all/${slug}`;
  const browserHeaders = {
    Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Referer: "https://www.moxfield.com/",
    Origin: "https://www.moxfield.com",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
  };
  const response = await fetch(apiUrl, { headers: browserHeaders });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("application/json")) {
    // Fallback: try the public text export endpoint
    const txtUrl = `https://www.moxfield.com/decks/${slug}/export/txt`;
    const txtRes = await fetch(txtUrl, {
      headers: { ...browserHeaders, Accept: "text/plain,*/*;q=0.8", "sec-fetch-dest": "document" },
    });
    if (txtRes.ok) {
      const txtContent = txtRes.headers.get("content-type") ?? "";
      if (txtContent.includes("text")) {
        const text = await txtRes.text();
        const cards = parseDeckText(text);
        if (cards.length > 0) {
          return {
            cards,
            cardMetadata: await buildDeckMetadata(cards),
            commander: cards[0] ?? null,
            name: null,
          };
        }
      }
    }
    throw new Error(
      "CLOUDFLARE_BLOCK"
    );
  }
  const data = await response.json();
  const cards = [
    ...extractCards(data.commanders || data.commander),
    ...extractCards(data.mainboard),
  ];
  if (cards.length === 0) {
    throw new Error("Nessuna carta trovata nell'export Moxfield");
  }
  const metaMap = {
    ...extractSectionMetadata(data.commanders || data.commander),
    ...extractSectionMetadata(data.mainboard),
  };
  return {
    cards,
    cardMetadata: Object.values(metaMap),
    commander: data.commanders?.[0]?.card?.name ?? null,
    name: data.name ?? null,
  };
};

// --- Existing endpoints -----------------------------------------------------

app.get("/viewer-state", (_req, res) => {
  res.json({
    ok: true,
    state: latestViewerState,
  });
});

app.post("/viewer-state", (req, res) => {
  latestViewerState = {
    ...req.body,
    updatedAt: new Date().toISOString(),
  };
  res.json({ ok: true });
});

app.get("/viewer-control", (_req, res) => {
  res.json({
    ok: true,
    control: latestViewerControl,
  });
});

app.post("/viewer-control/restart", (req, res) => {
  latestViewerControl = {
    restartToken: req.body?.restartToken ?? Date.now(),
    updatedAt: new Date().toISOString(),
  };
  res.json({ ok: true, control: latestViewerControl });
});

app.get("/viewer-session", (_req, res) => {
  res.json({
    ok: true,
    session: latestViewerSession,
  });
});

app.post("/viewer-session", (req, res) => {
  latestViewerSession = {
    sessionId:
      typeof req.body?.sessionId === "string" && req.body.sessionId.trim()
        ? req.body.sessionId.trim()
        : null,
    source:
      typeof req.body?.source === "string" && req.body.source.trim()
        ? req.body.source.trim()
        : null,
    updatedAt: new Date().toISOString(),
  };
  res.json({ ok: true, session: latestViewerSession });
});

app.post("/save-deck", (req, res) => {
  const deck = req.body;
  if (!Array.isArray(deck)) {
    return res.status(400).json({ error: "Formato mazzo non valido." });
  }

  const outputPath = path.join(__dirname, "../ui-player/public", "CurrentDeck.json");
  fs.writeFileSync(outputPath, JSON.stringify(deck, null, 2));
  console.log("ƒo. Deck salvato in public/CurrentDeck.json");
  res.json({ success: true });
});

app.post("/save-combos", (req, res) => {
  const filteredCombos = req.body;

  if (!filteredCombos || !filteredCombos.combos) {
    return res.status(400).json({ error: "Formato non valido" });
  }

  const filePath = path.join(__dirname, "../ui-player/public", "FilteredCombos.json");

  fs.writeFile(filePath, JSON.stringify(filteredCombos, null, 2), (err) => {
    if (err) {
      console.error("Errore nel salvataggio:", err);
      return res.status(500).json({ error: "Errore nel salvataggio" });
    }

    console.log("ƒo. FilteredCombos salvato!");
    res.json({ success: true });
  });
});

app.post("/fetch-moxfield-deck", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL mancante" });
    }
    const data = await fetchMoxfieldDeck(url);
    return res.json(data);
  } catch (error) {
    console.error("Errore fetch Moxfield:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/import-deck", async (req, res) => {
  try {
    const { input, name, commander } = req.body || {};
    if (!input || typeof input !== "string") {
      return res.status(400).json({ error: "Input mancante" });
    }
    const trimmed = input.trim();
    let cards = [];
    let deckName = name ?? null;
    let deckCommander = commander ?? null;
    let sourceUrl = null;

    let cardMetadata = null;
    if (isMoxfieldLink(trimmed)) {
      const deckData = await fetchMoxfieldDeck(trimmed);
      cards = deckData.cards;
      cardMetadata = deckData.cardMetadata ?? null;
      deckName = deckName ?? deckData.name ?? null;
      deckCommander = deckCommander ?? deckData.commander ?? null;
      sourceUrl = trimmed;
    } else {
      cards = parseDeckText(trimmed);
      deckCommander = deckCommander ?? extractCommanderFromText(trimmed);
      cardMetadata = await buildDeckMetadata(cards);
    }

    if (!cards.length) {
      return res.status(400).json({ error: "Il mazzo è vuoto o malformato." });
    }

    const deck = await upsertDeckRecord({
      cards,
      sourceUrl,
      name: deckName,
      commander: deckCommander,
      cardMetadata,
    });
    return res.json({ deck });
  } catch (error) {
    console.error("Errore import deck:", error);
    const isCloudflareBlock = error.message === "CLOUDFLARE_BLOCK";
    return res.status(500).json({
      error: isCloudflareBlock
        ? "Moxfield ha bloccato la richiesta (Cloudflare). Esporta il mazzo manualmente: apri il tuo deck su Moxfield → Export → Text → copia e incolla qui."
        : (error.message ?? "Errore durante l'import del deck"),
      cloudflareBlock: isCloudflareBlock,
    });
  }
});

app.delete("/decks/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Deck id non valido" });
  }

  try {
    const existing = await prisma.deck.findUnique({
      where: { id },
      select: { id: true, name: true, commander: true, cards: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "Deck non trovato" });
    }

    await prisma.deck.delete({ where: { id } });
    return res.json({
      deleted: true,
      deck: {
        id: existing.id,
        name: existing.name,
        commander: existing.commander,
        cardCount: Array.isArray(existing.cards) ? existing.cards.length : null,
      },
    });
  } catch (error) {
    console.error("Errore cancellazione deck:", error);
    return res.status(500).json({ error: error.message ?? "Errore cancellazione deck" });
  }
});

app.listen(PORT, () => {
  console.log(`ÐYs? Server backend avviato su http://localhost:${PORT}`);
});
