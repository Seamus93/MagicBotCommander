import "dotenv/config";
import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "./session/SessionManager.js";
import type { GameMessage } from "./session/GameSession.js";
import type { CardName, DeckCardMetadata } from "@game-state/types";
import { getDeckById } from "@db/db";

const PORT = Number(process.env.GAME_SERVER_PORT ?? 5300);
const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });
const manager = new SessionManager();

// Map from sessionId → Set of connected WebSocket clients
const sessionClients = new Map<string, Set<WebSocket>>();

async function safeGetDeckById(id: number) {
  try {
    return await getDeckById(id);
  } catch {
    return null;
  }
}

function broadcast(sessionId: string, msg: GameMessage): void {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function makeDefaultAiDecks(): Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }> {
  const defaultDeck: CardName[] = [
    ...Array(18).fill("Basic Land"),
    ...Array(8).fill("Burn Spell"),
    ...Array(8).fill("Wild Beast"),
    ...Array(6).fill("Titanic Ogre"),
  ];
  return [
    { deck: defaultDeck, meta: [], commander: "Commander" },
    { deck: defaultDeck, meta: [], commander: "Commander" },
    { deck: defaultDeck, meta: [], commander: "Commander" },
  ];
}

// GET /game/sessions — list active sessions (for SpellTable viewer)
app.get("/game/sessions", (_req, res) => {
  res.json({ sessions: manager.getActiveSessions() });
});

// GET /game/decks — list available decks from database
app.get("/game/decks", async (_req, res) => {
  try {
    const { getPrisma } = await import("@db/db");
    const records = await getPrisma().deck.findMany({
      select: {
        id: true,
        name: true,
        commander: true,
        createdAt: true,
        cards: true,
        cardMetadata: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const decks = records.map((deck) => ({
      id: deck.id,
      name: deck.name,
      commander: deck.commander,
      createdAt: deck.createdAt,
      cardCount: Array.isArray(deck.cards) ? deck.cards.length : null,
      metadataCount: Array.isArray(deck.cardMetadata) ? deck.cardMetadata.length : null,
    }));
    res.json({ decks });
  } catch (err) {
    res.json({ decks: [], error: "Could not load decks from database" });
  }
});

// DELETE /game/decks/:id — remove a deck from database
app.delete("/game/decks/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid deck id" });
  }

  try {
    const { getPrisma } = await import("@db/db");
    const prisma = getPrisma();
    const existing = await prisma.deck.findUnique({
      where: { id },
      select: { id: true, name: true, commander: true, cards: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "Deck not found" });
    }

    await prisma.deck.delete({ where: { id } });
    res.json({
      deleted: true,
      deck: {
        id: existing.id,
        name: existing.name,
        commander: existing.commander,
        cardCount: Array.isArray(existing.cards) ? existing.cards.length : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not delete deck";
    res.status(500).json({ error: message });
  }
});

// POST /game/create-ai-only — all 4 players are AI (for SpellTable viewer)
app.post("/game/create-ai-only", async (req, res) => {
  const body = req.body as { deckIds?: number[] };
  const sessionId = `ai_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  let allDecks: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }>;

  // If deckIds provided, load from database
  if (body.deckIds && body.deckIds.length > 0) {
    const loaded: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }> = [];
    for (const id of body.deckIds) {
      const dbDeck = await safeGetDeckById(id);
      if (dbDeck) {
        loaded.push({
          deck: dbDeck.cards as CardName[],
          meta: (dbDeck.cardMetadata as unknown as DeckCardMetadata[]) ?? [],
          commander: (dbDeck.commander as CardName | null) ?? ((dbDeck.cards as CardName[])[0] ?? null),
        });
      }
    }
    if (loaded.length === 0) {
      // All IDs were invalid, fall back to default
      allDecks = [...makeDefaultAiDecks(), makeDefaultAiDecks()[0]];
    } else {
      // Pad to 4 players by cycling through loaded decks
      allDecks = [];
      for (let i = 0; i < 4; i++) {
        allDecks.push(loaded[i % loaded.length]);
      }
    }
  } else {
    allDecks = [...makeDefaultAiDecks(), makeDefaultAiDecks()[0]];
  }

  sessionClients.set(sessionId, new Set());

  manager.createAllAi(sessionId, allDecks, (msg) => {
    broadcast(sessionId, msg);
  });

  res.json({ sessionId });
});

// POST /game/create
app.post("/game/create", async (req, res) => {
  const body = req.body as {
    humanDeckId?: number;
    humanDeck?: CardName[];
    humanDeckMeta?: DeckCardMetadata[];
    aiDeckIds?: number[];
    aiDecks?: CardName[][];
  };
  const sessionId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // Load human deck — by ID from DB or by full card list, else default
  let humanDeck: CardName[];
  let humanDeckMeta: DeckCardMetadata[] = body.humanDeckMeta ?? [];
  let humanCommander: CardName | null = body.humanDeck?.[0] ?? null;
  if (body.humanDeckId) {
    const dbDeck = await safeGetDeckById(body.humanDeckId);
    humanDeck = dbDeck ? (dbDeck.cards as CardName[]) : body.humanDeck ?? [];
    if (dbDeck && !humanDeckMeta.length) humanDeckMeta = (dbDeck.cardMetadata as unknown as DeckCardMetadata[]) ?? [];
    if (dbDeck) humanCommander = (dbDeck.commander as CardName | null) ?? ((dbDeck.cards as CardName[])[0] ?? null);
  } else {
    humanDeck = body.humanDeck ?? [];
  }
  if (!humanDeck.length) {
    humanDeck = [
      ...Array(18).fill("Basic Land"),
      ...Array(8).fill("Burn Spell"),
      ...Array(8).fill("Wild Beast"),
      ...Array(6).fill("Titanic Ogre"),
    ];
    humanCommander = "Commander";
  }

  // Load AI decks by ID, fall back to the human deck for mirror games.
  let aiDecks = makeDefaultAiDecks();
  const loaded: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }> = [];
  if (body.aiDeckIds && body.aiDeckIds.length > 0) {
    for (const id of body.aiDeckIds) {
      const dbDeck = await safeGetDeckById(id);
      if (dbDeck) {
        loaded.push({
          deck: dbDeck.cards as CardName[],
          meta: (dbDeck.cardMetadata as unknown as DeckCardMetadata[]) ?? [],
          commander: (dbDeck.commander as CardName | null) ?? ((dbDeck.cards as CardName[])[0] ?? null),
        });
      }
    }
  }
  if (body.aiDecks && body.aiDecks.length > 0) {
    for (const deck of body.aiDecks) {
      if (Array.isArray(deck) && deck.length > 0) {
        loaded.push({ deck: deck as CardName[], meta: [], commander: (deck as CardName[])[0] ?? null });
      }
    }
  }
  if (loaded.length > 0) {
    aiDecks = [0, 1, 2].map((i) => loaded[i % loaded.length]);
  } else if (humanDeck.length > 0) {
    aiDecks = [0, 1, 2].map(() => ({
      deck: [...humanDeck],
      meta: [...humanDeckMeta],
      commander: humanCommander,
    }));
  }

  sessionClients.set(sessionId, new Set());

  manager.create(sessionId, humanDeck, humanDeckMeta, humanCommander, aiDecks, (msg) => {
    broadcast(sessionId, msg);
  });

  res.json({ sessionId });
});

// GET /game/:id/state
app.get("/game/:id/state", (req, res) => {
  const session = manager.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const state = session.getFilteredState();
  res.json({ state, status: session.status, winner: session.winner });
});

// POST /game/:id/action
app.post("/game/:id/action", (req, res) => {
  const session = manager.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const { decisionType, decision, stateVersion } = req.body as {
    decisionType: string;
    decision: unknown;
    stateVersion?: unknown;
  };
  if (!decisionType || decision === undefined) {
    res.status(400).json({ error: "decisionType and decision required" });
    return;
  }
  session.submitDecision(decision, numberOrUndefined(stateVersion));
  res.json({ ok: true });
});

// POST /game/:id/concede
app.post("/game/:id/concede", (req, res) => {
  const session = manager.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  session.concede();
  res.json({ ok: true });
});

// WebSocket: ws://host/game/:id
wss.on("connection", (ws, req) => {
  const match = req.url?.match(/^\/game\/([^/?]+)/);
  if (!match) {
    ws.close(1008, "invalid path");
    return;
  }
  const sessionId = match[1];
  const session = manager.get(sessionId);
  if (!session) {
    ws.close(1008, "session not found");
    return;
  }

  const clients = sessionClients.get(sessionId);
  if (clients) clients.add(ws);

  // For AllAiGameSession the simulation only starts when the first client
  // connects, so the viewer always sees the game from turn 1.
  session.startSimulation();
  session.startDisconnectTimer();

  // Send current state on connect
  const currentState = session.getFilteredState();
  if (currentState) {
    ws.send(JSON.stringify({ type: "state_update", state: currentState }));
  }

  // Re-send pending decision if the engine is waiting for human input
  const pendingWait = session.getLastWaitingMessage();
  if (pendingWait) {
    ws.send(JSON.stringify(pendingWait));
  }

  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.type) {
      case "submit_action":
        session.submitDecision(msg.action, numberOrUndefined(msg.stateVersion));
        break;
      case "submit_attack_plan":
        session.submitDecision(msg.plan, numberOrUndefined(msg.stateVersion));
        break;
      case "submit_block_plan":
        session.submitDecision(msg.plan, numberOrUndefined(msg.stateVersion));
        break;
      case "submit_mulligan":
        session.submitDecision({ keep: msg.keep, bottomCards: msg.bottomCards }, numberOrUndefined(msg.stateVersion));
        break;
      case "submit_target":
        session.submitDecision(msg.targetIndex, numberOrUndefined(msg.stateVersion));
        break;
      case "submit_response":
        session.submitDecision(msg.action ?? null, numberOrUndefined(msg.stateVersion));
        break;
      case "concede":
        session.concede();
        break;
    }
  });

  ws.on("close", () => {
    const c = sessionClients.get(sessionId);
    if (c) c.delete(ws);
  });
});

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

server.listen(PORT, () => {
  console.log(`[game-server] listening on port ${PORT}`);
});
