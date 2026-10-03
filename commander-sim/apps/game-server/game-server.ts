import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager, type LobbyDeckPublic, type LobbySnapshot } from "./session/SessionManager.js";
import type { GameMessage } from "./session/GameSession.js";
import type { SeatCredential } from "./session/seatOwnership.js";
import type { CardName, DeckCardMetadata } from "@game-state/types";
import { deriveCapabilities, type ClientGameMessage, type ConnectionRole, type SeatId, type SessionRecipient } from "../../packages/game-state/src/session";
import { buildSeatsFromControllers } from "./state/stateSerializer.js";
import { getDeckById } from "@db/db";

const PORT = Number(process.env.GAME_SERVER_PORT ?? 5300);
const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });
const manager = new SessionManager();

interface ClientConnection {
  ws: WebSocket;
  connectionId: string;
  recipient: SessionRecipient;
}

// Map from sessionId → connected WebSocket clients with role/seat context.
const sessionClients = new Map<string, Set<ClientConnection>>();
const lobbyClients = new Map<string, Set<WebSocket>>();

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
  const session = manager.get(sessionId);
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (msg.type === "state_update") {
      sendSnapshot(sessionId, client);
      continue;
    }
    if (msg.type === "waiting_for_human") {
      if (canReceivePendingDecision(session, client.recipient, msg.activePlayer)) {
        client.ws.send(JSON.stringify(msg));
      }
      continue;
    }
    if (msg.type === "game_log" && client.recipient.role !== "debug") {
      continue;
    }
    client.ws.send(JSON.stringify(msg));
  }
}

function sendSnapshot(sessionId: string, client: ClientConnection): void {
  const session = manager.get(sessionId);
  if (!session) return;
  const snapshot = session.getSnapshotForRecipient(client.recipient);
  if (!snapshot || client.ws.readyState !== WebSocket.OPEN) return;
  client.ws.send(JSON.stringify({
    type: "GAME_SNAPSHOT",
    sessionId,
    revision: snapshot.revision,
    state: snapshot,
  }));
  client.ws.send(JSON.stringify({ type: "state_update", state: snapshot }));
  if (snapshot.privatePlayer) {
    client.ws.send(JSON.stringify({
      type: "PRIVATE_PLAYER_STATE",
      sessionId,
      revision: snapshot.revision,
      player: snapshot.privatePlayer,
    }));
  }
}

function canReceivePendingDecision(
  session: ReturnType<SessionManager["get"]>,
  recipient: SessionRecipient,
  activePlayer: number
): boolean {
  if (recipient.role === "debug") return true;
  if (recipient.role !== "player") return false;
  const seat = session?.seats.find((candidate) =>
    recipient.seatId ? candidate.id === recipient.seatId : candidate.playerId === recipient.playerId
  );
  return seat?.controller === "human" && seat.playerIndex === activePlayer;
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

function makeDefaultDeck(): { deck: CardName[]; meta: DeckCardMetadata[]; commander: CardName } {
  return {
    deck: [
      ...Array(18).fill("Basic Land"),
      ...Array(8).fill("Burn Spell"),
      ...Array(8).fill("Wild Beast"),
      ...Array(6).fill("Titanic Ogre"),
    ],
    meta: [],
    commander: "Commander",
  };
}

function makeLobbyCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const chars = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)] ?? "2");
  return `${chars.slice(0, 3).join("")}-${chars.slice(3).join("")}`;
}

function playerCredentialFrom(req: express.Request): { playerId?: string; playerToken?: string } {
  const body = req.body as { playerId?: unknown; playerToken?: unknown };
  return {
    playerId: typeof body.playerId === "string" ? body.playerId : req.header("x-player-id") ?? undefined,
    playerToken: typeof body.playerToken === "string" ? body.playerToken : req.header("x-player-token") ?? undefined,
  };
}

function commanderImageUrl(commanderName: string): string {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(commanderName)}&format=image&version=art_crop`;
}

async function getLobbyDeckPublic(deckId: string | number | undefined): Promise<LobbyDeckPublic | null> {
  const id = Number(deckId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const dbDeck = await safeGetDeckById(id);
  if (!dbDeck) return null;
  const cards = Array.isArray(dbDeck.cards) ? dbDeck.cards as string[] : [];
  const commanderName = dbDeck.commander ?? cards[0] ?? dbDeck.name ?? `Deck #${id}`;
  return {
    id: String(dbDeck.id),
    name: dbDeck.name ?? commanderName,
    commanderName,
    commanderImage: commanderImageUrl(commanderName),
    colorIdentity: [],
    cardCount: cards.length,
  };
}

async function loadDeckForEngine(deckId: string | number | undefined) {
  const id = Number(deckId);
  const dbDeck = Number.isInteger(id) && id > 0 ? await safeGetDeckById(id) : null;
  if (!dbDeck) {
    const fallback = makeDefaultDeck();
    return { deck: fallback.deck, meta: fallback.meta, commander: fallback.commander };
  }
  const cards = dbDeck.cards as CardName[];
  return {
    deck: cards,
    meta: (dbDeck.cardMetadata as unknown as DeckCardMetadata[]) ?? [],
    commander: (dbDeck.commander as CardName | null) ?? cards[0] ?? null,
  };
}

function broadcastLobby(lobbyId: string, extra?: Record<string, unknown>): void {
  const lobby = manager.getLobby(lobbyId);
  if (!lobby) return;
  const payload = JSON.stringify({
    type: extra?.type ?? "LOBBY_UPDATED",
    lobby: lobby.snapshot(),
    ...extra,
  });
  const clients = lobbyClients.get(lobbyId);
  if (!clients) return;
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function hostTokenFrom(req: express.Request): string | undefined {
  const body = req.body as { hostToken?: unknown };
  const header = req.header("x-host-token");
  return typeof body.hostToken === "string" ? body.hostToken : header ?? undefined;
}

function publicLobbyResponse(lobby: { snapshot(): LobbySnapshot; hostToken?: string }, includeHostToken = false) {
  return includeHostToken
    ? { lobby: lobby.snapshot(), hostToken: lobby.hostToken }
    : { lobby: lobby.snapshot() };
}

// GET /game/sessions — list active sessions (for SpellTable viewer)
app.get("/game/sessions", (_req, res) => {
  res.json({ sessions: manager.getActiveSessions() });
});

app.post("/lobby/create", (_req, res) => {
  const hostPlayerId = `host_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const hostToken = randomBytes(18).toString("base64url");
  const hostPlayerToken = randomBytes(18).toString("base64url");
  const lobbyId = `lobby_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const lobby = manager.createLobby(lobbyId, makeLobbyCode(), hostPlayerId, hostToken, hostPlayerToken);
  lobbyClients.set(lobbyId, new Set());
  res.json({
    ...publicLobbyResponse(lobby, true),
  });
});

app.get("/lobby/:id", (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  res.json(publicLobbyResponse(lobby));
});

app.post("/lobby/:id/join-human", async (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  const body = req.body as { deckId?: string | number; playerId?: string; playerToken?: string };
  if (typeof body.playerId === "string" && typeof body.playerToken === "string") {
    const reconnected = lobby.reconnectHuman(body.playerId, body.playerToken);
    if (reconnected?.type === "human") {
      broadcastLobby(lobby.id);
      return res.json({
        lobbyId: lobby.id,
        playerId: reconnected.playerId,
        seatId: reconnected.seatId,
        playerToken: reconnected.playerToken,
        lobby: lobby.snapshot(),
      });
    }
  }
  const deck = await getLobbyDeckPublic(body.deckId);
  const playerId = `player_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const playerToken = randomBytes(18).toString("base64url");
  const seat = lobby.joinHuman(playerId, playerToken, deck ? deck.id : undefined, deck ?? undefined);
  if (!seat || seat.type !== "human") return res.status(409).json({ error: "No empty seat available" });
  broadcastLobby(lobby.id);
  res.json({ lobbyId: lobby.id, playerId, seatId: seat.seatId, playerToken, lobby: lobby.snapshot() });
});

app.post("/lobby/:id/update-player-deck", async (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  const { playerId, playerToken } = playerCredentialFrom(req);
  if (!playerId || !playerToken) return res.status(403).json({ error: "Player credentials required" });
  const body = req.body as { deckId?: string | number };
  const deck = await getLobbyDeckPublic(body.deckId);
  if (!deck) return res.status(400).json({ error: "Valid deckId required" });
  if (!lobby.updateHumanDeck(playerId, playerToken, deck.id, deck)) return res.status(403).json({ error: "Player does not own this seat" });
  broadcastLobby(lobby.id);
  res.json({ lobby: lobby.snapshot() });
});

app.post("/lobby/:id/ready", (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  const { playerId, playerToken } = playerCredentialFrom(req);
  const body = req.body as { ready?: boolean };
  if (!playerId || !playerToken) return res.status(403).json({ error: "Player credentials required" });
  if (!lobby.setHumanReady(playerId, playerToken, body.ready === true)) return res.status(403).json({ error: "Player does not own this seat" });
  broadcastLobby(lobby.id);
  res.json({ lobby: lobby.snapshot() });
});

app.post("/lobby/:id/leave", (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  const { playerId, playerToken } = playerCredentialFrom(req);
  if (!playerId || !playerToken) return res.status(403).json({ error: "Player credentials required" });
  if (!lobby.leaveHuman(playerId, playerToken)) return res.status(403).json({ error: "Player does not own this seat" });
  broadcastLobby(lobby.id);
  res.json({ lobby: lobby.snapshot() });
});

app.post("/lobby/:id/add-ai", async (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  if (!lobby.isHost(hostTokenFrom(req))) return res.status(403).json({ error: "Host only" });
  const body = req.body as { seatId?: SeatId; deckId?: string | number };
  const seatId = isSeatId(body.seatId ?? null) ? body.seatId : undefined;
  if (!seatId) return res.status(400).json({ error: "Invalid seat" });
  const deck = await getLobbyDeckPublic(body.deckId);
  if (!deck) return res.status(400).json({ error: "Valid AI deckId required" });
  if (!lobby.addAi(seatId, deck.id, deck)) {
    return res.status(409).json({ error: "Seat cannot be filled with AI" });
  }
  broadcastLobby(lobby.id);
  res.json({ lobby: lobby.snapshot() });
});

app.post("/lobby/:id/ai-deck", async (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  if (!lobby.isHost(hostTokenFrom(req))) return res.status(403).json({ error: "Host only" });
  const body = req.body as { seatId?: SeatId; deckId?: string | number };
  const seatId = isSeatId(body.seatId ?? null) ? body.seatId : undefined;
  if (!seatId) return res.status(400).json({ error: "Invalid seat" });
  const deck = await getLobbyDeckPublic(body.deckId);
  if (!deck) return res.status(400).json({ error: "Valid AI deckId required" });
  if (!lobby.updateAiDeck(seatId, deck.id, deck)) return res.status(409).json({ error: "Seat is not AI" });
  broadcastLobby(lobby.id);
  res.json({ lobby: lobby.snapshot() });
});

app.post("/lobby/:id/remove-ai", (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  if (!lobby.isHost(hostTokenFrom(req))) return res.status(403).json({ error: "Host only" });
  const body = req.body as { seatId?: SeatId };
  const seatId = isSeatId(body.seatId ?? null) ? body.seatId : undefined;
  if (!seatId) return res.status(400).json({ error: "Invalid seat" });
  if (!lobby.removeAi(seatId)) return res.status(409).json({ error: "Seat is not AI" });
  broadcastLobby(lobby.id);
  res.json({ lobby: lobby.snapshot() });
});

app.post("/lobby/:id/options", (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  if (!lobby.isHost(hostTokenFrom(req))) return res.status(403).json({ error: "Host only" });
  const body = req.body as { debugMode?: boolean; allAi?: boolean };
  if (typeof body.debugMode === "boolean") lobby.setDebugMode(body.debugMode);
  if (typeof body.allAi === "boolean") lobby.setAllAiMode(body.allAi);
  broadcastLobby(lobby.id);
  res.json({ lobby: lobby.snapshot() });
});

app.post("/lobby/:id/start", async (req, res) => {
  const lobby = manager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  if (!lobby.isHost(hostTokenFrom(req))) return res.status(403).json({ error: "Host only" });
  const validation = lobby.validateStart();
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  const sessionId = lobby.allAi
    ? `ai_${Date.now()}_${Math.random().toString(16).slice(2)}`
    : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  sessionClients.set(sessionId, new Set());

  if (lobby.allAi) {
    const allDecks = await Promise.all(lobby.seats.map((seat) => loadDeckForEngine(seat.type !== "empty" ? seat.deckId : undefined)));
    manager.createAllAi(sessionId, allDecks, (msg) => broadcast(sessionId, msg), {
      mode: lobby.mode,
      seats: buildSeatsFromControllers(["ai", "ai", "ai", "ai"]),
    });
  } else {
    const controllers = lobby.seats.map((seat) => seat.type === "ai" ? "ai" : "human");
    const seats = buildSeatsFromControllers(controllers).map((seat, index) => {
      const lobbySeat = lobby.seats[index];
      return {
        ...seat,
        playerId: lobbySeat.type === "human" ? lobbySeat.playerId : seat.playerId,
        deckId: lobbySeat.type !== "empty" ? lobbySeat.deckId : undefined,
      };
    });
    const credentials: SeatCredential[] = lobby.seats
      .filter((seat): seat is Extract<typeof seat, { type: "human" }> => seat.type === "human")
      .map((seat) => ({ seatId: seat.seatId, playerId: seat.playerId, token: seat.playerToken }));
    const seatDecks = await Promise.all(lobby.seats.map((seat) => loadDeckForEngine(seat.type !== "empty" ? seat.deckId : undefined)));

    manager.create(
      sessionId,
      seatDecks[0].deck,
      seatDecks[0].meta,
      seatDecks[0].commander,
      seatDecks.slice(1),
      (msg) => broadcast(sessionId, msg),
      {
        mode: lobby.mode,
        seats,
        seatCredentials: credentials,
        playerDecks: seatDecks.map((entry) => entry.deck),
        playerDeckMetadata: seatDecks.map((entry) => entry.meta),
        playerCommanders: seatDecks.map((entry) => entry.commander),
      }
    );
  }

  lobby.status = "running";
  lobby.runningSessionId = sessionId;
  lobby.touch();
  broadcastLobby(lobby.id, { type: "MATCH_STARTED", sessionId, revision: lobby.revision });
  res.json({ sessionId, lobby: lobby.snapshot() });
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
  } catch {
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
  const body = req.body as { deckIds?: number[]; mode?: "game" | "debug" };
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

  manager.createAllAi(
    sessionId,
    allDecks,
    (msg) => {
      broadcast(sessionId, msg);
    },
    { mode: body.mode ?? "debug", seats: buildSeatsFromControllers(["ai", "ai", "ai", "ai"]) }
  );

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
    mode?: "game" | "debug";
    seats?: Array<{ controller?: "human" | "ai"; deckId?: string | number; playerId?: string }>;
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
  const controllers = [0, 1, 2, 3].map((index) =>
    body.seats?.[index]?.controller === "ai" ? "ai" : body.seats?.[index]?.controller === "human" ? "human" : index === 0 ? "human" : "ai"
  );
  const seats = buildSeatsFromControllers(controllers).map((seat, index) => ({
    ...seat,
    playerId: body.seats?.[index]?.playerId || seat.playerId,
    deckId: body.seats?.[index]?.deckId === undefined ? undefined : String(body.seats[index].deckId),
  }));
  const seatCredentials: SeatCredential[] = seats
    .filter((seat) => seat.controller === "human")
    .map((seat) => ({
      seatId: seat.id,
      playerId: seat.playerId,
      token: randomBytes(18).toString("base64url"),
    }));

  manager.create(
    sessionId,
    humanDeck,
    humanDeckMeta,
    humanCommander,
    aiDecks,
    (msg) => {
      broadcast(sessionId, msg);
    },
    { mode: body.mode ?? "game", seats, seatCredentials }
  );

  res.json({
    sessionId,
    playerCredentials: seatCredentials.map((credential) => ({
      seatId: credential.seatId,
      playerId: credential.playerId,
      playerToken: credential.token,
    })),
  });
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
  const body = req.body as { seatId?: unknown; playerId?: unknown; playerToken?: unknown } | undefined;
  const rawSeatId = typeof body?.seatId === "string" ? body.seatId : null;
  const seatId = isSeatId(rawSeatId) ? rawSeatId : undefined;
  const playerId = typeof body?.playerId === "string" ? body.playerId : undefined;
  const playerToken = typeof body?.playerToken === "string" ? body.playerToken : undefined;
  const accepted = Boolean(
    seatId &&
    playerId &&
    playerToken &&
    session.concedeForPlayerCredentials?.(seatId, playerId, playerToken)
  );
  if (!accepted) {
    res.status(403).json({ error: "player credentials required" });
    return;
  }
  res.json({ ok: true });
});

// WebSocket: ws://host/game/:id
// Optional query:
//   role=debug keeps legacy privileged behavior.
//   role=table subscribes to public table state.
//   role=player&seatId=northWest subscribes to public state + that player's private state.
wss.on("connection", (ws, req) => {
  const lobbyMatch = req.url?.match(/^\/lobby\/([^/?]+)/);
  if (lobbyMatch) {
    const lobbyId = lobbyMatch[1];
    const lobby = manager.getLobby(lobbyId);
    if (!lobby) {
      ws.close(1008, "lobby not found");
      return;
    }
    const lobbyUrl = new URL(req.url ?? "/lobby/unknown", "ws://localhost");
    const lobbyPlayerId = lobbyUrl.searchParams.get("playerId") ?? undefined;
    const lobbyPlayerToken = lobbyUrl.searchParams.get("playerToken") ?? undefined;
    if (lobbyPlayerId && lobbyPlayerToken && lobby.reconnectHuman(lobbyPlayerId, lobbyPlayerToken)) {
      broadcastLobby(lobby.id);
    }
    let clients = lobbyClients.get(lobbyId);
    if (!clients) {
      clients = new Set();
      lobbyClients.set(lobbyId, clients);
    }
    clients.add(ws);
    ws.send(JSON.stringify({ type: "LOBBY_SNAPSHOT", lobby: lobby.snapshot() }));

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const hostToken = typeof msg.hostToken === "string" ? msg.hostToken : undefined;
      if (msg.type === "JOIN_LOBBY") {
        ws.send(JSON.stringify({ type: "LOBBY_SNAPSHOT", lobby: lobby.snapshot() }));
        return;
      }
      if (!lobby.isHost(hostToken)) {
        ws.send(JSON.stringify({ type: "ERROR", code: "HOST_ONLY", message: "Host controls are required." }));
        return;
      }
      const rawSeatId = typeof msg.seatId === "string" ? msg.seatId : null;
      const messageSeatId = isSeatId(rawSeatId) ? rawSeatId : undefined;
      if (msg.type === "ADD_AI" && messageSeatId) {
        lobby.addAi(messageSeatId, typeof msg.deckId === "string" ? msg.deckId : undefined);
        broadcastLobby(lobby.id);
      }
      if (msg.type === "REMOVE_AI" && messageSeatId) {
        lobby.removeAi(messageSeatId);
        broadcastLobby(lobby.id);
      }
      if (msg.type === "SET_DEBUG_MODE" && typeof msg.enabled === "boolean") {
        lobby.setDebugMode(msg.enabled);
        broadcastLobby(lobby.id);
      }
      if (msg.type === "SET_ALL_AI_MODE" && typeof msg.enabled === "boolean") {
        lobby.setAllAiMode(msg.enabled);
        broadcastLobby(lobby.id);
      }
    });

    ws.on("close", () => {
      const c = lobbyClients.get(lobbyId);
      if (c) c.delete(ws);
      if (lobby.markDisconnected(lobbyPlayerId, lobbyPlayerToken)) {
        broadcastLobby(lobby.id);
      }
    });
    return;
  }

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

  const connectionId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const auth = session.authenticateRecipient(parseRecipient(req.url), connectionId);
  if (!auth.ok || !auth.recipient) {
    ws.send(JSON.stringify({
      type: "ERROR",
      code: auth.code ?? "SESSION_AUTH_FAILED",
      message: auth.message ?? "Could not join this session.",
    }));
    ws.close(1008, auth.code ?? "SESSION_AUTH_FAILED");
    return;
  }
  const recipient = auth.recipient;
  const connection: ClientConnection = { ws, connectionId, recipient };
  const clients = sessionClients.get(sessionId);
  if (clients) clients.add(connection);

  // For AllAiGameSession the simulation only starts when the first client
  // connects, so the viewer always sees the game from turn 1.
  session.startSimulation();
  session.startDisconnectTimer();

  ws.send(JSON.stringify({
    type: "SESSION_JOINED",
    sessionId,
    role: recipient.role,
    seatId: recipient.seatId,
    playerId: recipient.playerId,
    capabilities: deriveCapabilities(session.mode),
  }));

  // Send current state on connect, filtered for this connection role.
  sendSnapshot(sessionId, connection);

  // Re-send pending decision if the engine is waiting for human input
  const pendingWait = session.getLastWaitingMessage();
  if (pendingWait && canReceivePendingDecision(session, recipient, pendingWait.activePlayer)) {
    ws.send(JSON.stringify(pendingWait));
  }

  ws.on("message", (raw) => {
    let msg: ClientGameMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientGameMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "JOIN_SESSION":
      case "REQUEST_SNAPSHOT":
        sendSnapshot(sessionId, connection);
        break;
      case "PLAYER_ACTION":
        submitDecisionFromConnection(session, recipient, msg.action, numberOrUndefined(msg.stateVersion ?? msg.revision), ws);
        break;
      case "PASS_PRIORITY":
        submitDecisionFromConnection(session, recipient, { type: "PASS_TURN" }, numberOrUndefined(msg.stateVersion ?? msg.revision), ws);
        break;
      case "SUBMIT_ATTACK_PLAN":
        submitDecisionFromConnection(session, recipient, msg.plan, numberOrUndefined(msg.stateVersion ?? msg.revision), ws);
        break;
      case "SUBMIT_BLOCK_PLAN":
        submitDecisionFromConnection(session, recipient, msg.plan, numberOrUndefined(msg.stateVersion ?? msg.revision), ws);
        break;
      case "SUBMIT_MULLIGAN":
        submitDecisionFromConnection(session, recipient, { keep: msg.keep, bottomCards: msg.bottomCards }, numberOrUndefined(msg.stateVersion ?? msg.revision), ws);
        break;
      case "SUBMIT_TARGET":
        submitDecisionFromConnection(session, recipient, msg.targetIndex, numberOrUndefined(msg.stateVersion ?? msg.revision), ws);
        break;
      case "SUBMIT_RESPONSE":
        submitDecisionFromConnection(session, recipient, msg.action ?? null, numberOrUndefined(msg.stateVersion ?? msg.revision), ws);
        break;
      case "CONCEDE":
        if (recipient.role === "debug" || recipient.role === "player") {
          const accepted = session.concedeForRecipient
            ? session.concedeForRecipient(recipient)
            : recipient.role === "debug";
          if (!accepted) {
            ws.send(JSON.stringify({
              type: "ERROR",
              code: "CONCEDE_REJECTED",
              message: "This connection is not allowed to concede that player.",
            }));
          }
        }
        break;
      case "submit_action":
        submitDecisionFromConnection(session, recipient, msg.action, numberOrUndefined(msg.stateVersion), ws);
        break;
      case "submit_attack_plan":
        submitDecisionFromConnection(session, recipient, msg.plan, numberOrUndefined(msg.stateVersion), ws);
        break;
      case "submit_block_plan":
        submitDecisionFromConnection(session, recipient, msg.plan, numberOrUndefined(msg.stateVersion), ws);
        break;
      case "submit_mulligan":
        submitDecisionFromConnection(session, recipient, { keep: msg.keep, bottomCards: msg.bottomCards }, numberOrUndefined(msg.stateVersion), ws);
        break;
      case "submit_target":
        submitDecisionFromConnection(session, recipient, msg.targetIndex, numberOrUndefined(msg.stateVersion), ws);
        break;
      case "submit_response":
        submitDecisionFromConnection(session, recipient, msg.action ?? null, numberOrUndefined(msg.stateVersion), ws);
        break;
      case "concede":
        if (recipient.role === "debug" || recipient.role === "player") {
          const accepted = session.concedeForRecipient
            ? session.concedeForRecipient(recipient)
            : recipient.role === "debug";
          if (!accepted) {
            ws.send(JSON.stringify({
              type: "ERROR",
              code: "CONCEDE_REJECTED",
              message: "This connection is not allowed to concede that player.",
            }));
          }
        }
        break;
    }
  });

  ws.on("close", () => {
    session.releaseConnection(connectionId);
    const c = sessionClients.get(sessionId);
    if (c) c.delete(connection);
  });
});

function parseRecipient(url: string | undefined): SessionRecipient {
  const parsed = new URL(url ?? "/game/unknown", "ws://localhost");
  const roleParam = parsed.searchParams.get("role");
  const role: ConnectionRole =
    roleParam === "player" || roleParam === "table" || roleParam === "debug"
      ? roleParam
      : "debug";
  const seatIdParam = parsed.searchParams.get("seatId");
  const seatId = isSeatId(seatIdParam) ? seatIdParam : undefined;
  const playerId = parsed.searchParams.get("playerId") ?? undefined;
  const playerToken = parsed.searchParams.get("playerToken") ?? undefined;
  return { role, seatId, playerId, playerToken };
}

function isSeatId(value: string | null): value is SeatId {
  return (
    value === "northWest" ||
    value === "northEast" ||
    value === "southWest" ||
    value === "southEast"
  );
}

function submitDecisionFromConnection(
  session: NonNullable<ReturnType<SessionManager["get"]>>,
  recipient: SessionRecipient,
  decision: unknown,
  expectedStateVersion: number | undefined,
  ws: WebSocket
): void {
  const accepted = session.submitDecisionForRecipient
    ? session.submitDecisionForRecipient(recipient, decision, expectedStateVersion)
    : recipient.role === "debug";
  if (!accepted) {
    ws.send(JSON.stringify({
      type: "ERROR",
      code: "SEAT_OWNERSHIP_REQUIRED",
      message: "This connection is not allowed to act for the pending player.",
    }));
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

server.listen(PORT, () => {
  console.log(`[game-server] listening on port ${PORT}`);
});
