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
    const PERMANENT_TYPES = ["land", "creature", "artifact", "enchantment", "planeswalker", "battle"];
    map[card.name] = {
      name: card.name,
      typeLine,
      manaValue: typeof card.cmc === "number" ? card.cmc : undefined,
      power: card.power != null && card.power !== "*" ? Number(card.power) : undefined,
      toughness: card.toughness != null && card.toughness !== "*" ? Number(card.toughness) : undefined,
      isLand: typeLower.includes("land") || undefined,
      isCreature: typeLower.includes("creature") || undefined,
      isArtifact: typeLower.includes("artifact") || undefined,
      isPermanent: PERMANENT_TYPES.some((t) => typeLower.includes(t)) || undefined,
      colors: Array.isArray(card.colors) ? card.colors : undefined,
      colorIdentity: Array.isArray(card.color_identity) ? card.color_identity : undefined,
    };
  });
  return map;
};

const isMoxfieldLink = (value = "") =>
  /^https?:\/\/(?:www\.)?moxfield\.com\/decks\//i.test(value.trim());

const parseDeckText = (text = "") => {
  let inSideboard = false;
  return text
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
    .map((line) => {
      const match = line.match(/^\d+\s+(.+?)\s+(\(|\/\/)/);
      if (match) return match[1].trim();
      return line.replace(/^\d+\s+/, "").split("(")[0].trim();
    })
    .filter(Boolean);
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
    const needsUpdate =
      (name && !existing.name) ||
      (commander && !existing.commander) ||
      (cardMetadata?.length && !existing.cardMetadata);
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
          return { cards, commander: cards[0] ?? null, name: null };
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

app.listen(PORT, () => {
  console.log(`ÐYs? Server backend avviato su http://localhost:${PORT}`);
});
