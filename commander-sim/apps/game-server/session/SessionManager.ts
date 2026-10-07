import { GameSession, type GameMessage, type WaitingMessage, type SessionStatus } from "./GameSession.js";
import { AllAiGameSession } from "./AllAiGameSession.js";
import type { CardName, DeckCardMetadata } from "@game-state/types";
import type { FilteredGameState } from "../state/stateSerializer.js";
import type { GameSessionSnapshot, Seat, SeatId, SessionMode, SessionRecipient } from "../../../packages/game-state/src/session";
import type { SeatCredential } from "./seatOwnership.js";

export interface RecipientAuthResult {
  ok: boolean;
  recipient?: SessionRecipient;
  code?: string;
  message?: string;
}

/** Common interface for both human+AI and all-AI sessions */
export interface IGameSession {
  readonly id: string;
  readonly mode: SessionMode;
  readonly seats: Seat[];
  status: SessionStatus;
  winner: number | null;
  getFilteredState(): FilteredGameState | null;
  getSnapshotForRecipient(recipient: SessionRecipient): GameSessionSnapshot | null;
  getLastWaitingMessage(): WaitingMessage | null;
  authenticateRecipient(recipient: SessionRecipient, connectionId: string): RecipientAuthResult;
  releaseConnection(connectionId: string): void;
  submitDecision(decision: unknown, expectedStateVersion?: number): void;
  submitDecisionForRecipient?(recipient: SessionRecipient, decision: unknown, expectedStateVersion?: number): boolean;
  concede(playerIndex?: number): void;
  concedeForRecipient?(recipient: SessionRecipient): boolean;
  concedeForPlayerCredentials?(seatId: SeatId, playerId: string, playerToken: string): boolean;
  startDisconnectTimer(): void;
  startSimulation(): void;
  destroy(): void;
}

const SESSION_CLEANUP_MS = 15 * 60 * 1000; // 15 min after game_over

export type LobbySeat =
  | { type: "empty"; seatId: SeatId }
  | { type: "human"; seatId: SeatId; playerId: string; playerToken: string; connectionId?: string; deckId?: string; ready: boolean; connectionStatus: "connected" | "disconnected"; deck?: LobbyDeckPublic }
  | { type: "ai"; seatId: SeatId; aiAgentId?: string; deckId?: string; deck?: LobbyDeckPublic };

export interface LobbyDeckPublic {
  id: string;
  name: string;
  commanderName: string;
  commanderImage?: string;
  colorIdentity?: string[];
  cardCount: number;
}

export interface LobbySnapshot {
  id: string;
  code: string;
  status: "lobby" | "running";
  hostPlayerId: string;
  revision: number;
  mode: SessionMode;
  allAi: boolean;
  runningSessionId?: string;
  seats: LobbySeat[];
}

export class LobbySession {
  readonly id: string;
  readonly code: string;
  readonly hostToken: string;
  readonly hostPlayerId: string;
  status: "lobby" | "running" = "lobby";
  revision = 0;
  mode: SessionMode = "game";
  allAi = false;
  runningSessionId?: string;
  seats: LobbySeat[];

  constructor(id: string, code: string, hostPlayerId: string, hostToken: string, _hostPlayerToken: string) {
    void _hostPlayerToken;
    this.id = id;
    this.code = code;
    this.hostPlayerId = hostPlayerId;
    this.hostToken = hostToken;
    this.seats = [
      { type: "empty", seatId: "northWest" },
      { type: "empty", seatId: "northEast" },
      { type: "empty", seatId: "southEast" },
      { type: "empty", seatId: "southWest" },
    ];
  }

  snapshot(): LobbySnapshot {
    return {
      id: this.id,
      code: this.code,
      status: this.status,
      hostPlayerId: this.hostPlayerId,
      revision: this.revision,
      mode: this.mode,
      allAi: this.allAi,
      runningSessionId: this.runningSessionId,
      seats: this.seats.map((seat) => ({ ...seat })),
    };
  }

  isHost(token: string | undefined): boolean {
    return token === this.hostToken;
  }

  touch(): void {
    this.revision++;
  }

  setDebugMode(enabled: boolean): void {
    this.mode = enabled ? "debug" : "game";
    this.touch();
  }

  setAllAiMode(enabled: boolean): void {
    this.allAi = enabled;
    this.seats = enabled
      ? this.seats.map((seat, index) => ({ type: "ai", seatId: seat.seatId, aiAgentId: `ai-${index}`, deckId: seat.type !== "empty" ? seat.deckId : undefined, deck: seat.type !== "empty" ? seat.deck : undefined }))
      : [
          ...this.seats.map((seat) => seat.type === "ai" ? { type: "empty" as const, seatId: seat.seatId } : seat),
        ];
    this.touch();
  }

  addAi(seatId: SeatId, deckId?: string, deck?: LobbyDeckPublic): boolean {
    if (this.status !== "lobby" || this.allAi) return false;
    const index = this.seats.findIndex((seat) => seat.seatId === seatId);
    if (index < 0 || this.seats[index].type !== "empty") return false;
    this.seats[index] = { type: "ai", seatId, aiAgentId: `ai-${index}`, deckId, deck };
    this.touch();
    return true;
  }

  updateAiDeck(seatId: SeatId, deckId: string, deck: LobbyDeckPublic): boolean {
    if (this.status !== "lobby") return false;
    const seat = this.seats.find((candidate) => candidate.seatId === seatId);
    if (!seat || seat.type !== "ai") return false;
    seat.deckId = deckId;
    seat.deck = deck;
    this.touch();
    return true;
  }

  removeAi(seatId: SeatId): boolean {
    if (this.status !== "lobby" || this.allAi) return false;
    const index = this.seats.findIndex((seat) => seat.seatId === seatId);
    if (index < 0 || this.seats[index].type !== "ai") return false;
    this.seats[index] = { type: "empty", seatId };
    this.touch();
    return true;
  }

  joinHuman(playerId: string, playerToken: string, deckId?: string, deck?: LobbyDeckPublic): LobbySeat | null {
    if (this.status !== "lobby" || this.allAi) return null;
    const index = this.seats.findIndex((seat) => seat.type === "empty");
    if (index < 0) return null;
    const seatId = this.seats[index].seatId;
    const seat: LobbySeat = { type: "human", seatId, playerId, playerToken, deckId, deck, ready: false, connectionStatus: "connected" };
    this.seats[index] = seat;
    this.touch();
    return seat;
  }

  reconnectHuman(playerId: string, playerToken: string): LobbySeat | null {
    const seat = this.seats.find((candidate) =>
      candidate.type === "human" && candidate.playerId === playerId && candidate.playerToken === playerToken
    );
    if (!seat || seat.type !== "human") return null;
    seat.connectionStatus = "connected";
    this.touch();
    return seat;
  }

  markDisconnected(playerId: string | undefined, playerToken: string | undefined): boolean {
    const seat = this.seats.find((candidate) =>
      candidate.type === "human" && candidate.playerId === playerId && candidate.playerToken === playerToken
    );
    if (!seat || seat.type !== "human") return false;
    seat.connectionStatus = "disconnected";
    this.touch();
    return true;
  }

  leaveHuman(playerId: string, playerToken: string): boolean {
    const index = this.seats.findIndex((seat) =>
      seat.type === "human" && seat.playerId === playerId && seat.playerToken === playerToken
    );
    if (index < 0) return false;
    this.seats[index] = { type: "empty", seatId: this.seats[index].seatId };
    this.touch();
    return true;
  }

  updateHumanDeck(playerId: string, playerToken: string, deckId: string, deck: LobbyDeckPublic): boolean {
    const seat = this.seats.find((candidate) =>
      candidate.type === "human" && candidate.playerId === playerId && candidate.playerToken === playerToken
    );
    if (!seat || seat.type !== "human") return false;
    seat.deckId = deckId;
    seat.deck = deck;
    seat.ready = false;
    this.touch();
    return true;
  }

  setHumanReady(playerId: string, playerToken: string, ready: boolean): boolean {
    const seat = this.seats.find((candidate) =>
      candidate.type === "human" && candidate.playerId === playerId && candidate.playerToken === playerToken
    );
    if (!seat || seat.type !== "human") return false;
    seat.ready = ready;
    this.touch();
    return true;
  }

  validateStart(): { ok: true } | { ok: false; error: string } {
    if (this.status !== "lobby") return { ok: false, error: "Lobby is not startable." };
    if (this.seats.some((seat) => seat.type === "empty")) return { ok: false, error: "All four seats must be occupied." };
    for (const seat of this.seats) {
      if (seat.type === "human" && !seat.deckId) return { ok: false, error: `Human seat ${seat.seatId} needs a deck.` };
      if (seat.type === "human" && !seat.ready) return { ok: false, error: `Human seat ${seat.seatId} is not ready.` };
      if (seat.type === "ai" && !seat.deckId) return { ok: false, error: `AI seat ${seat.seatId} needs a deck.` };
    }
    return { ok: true };
  }
}

export class SessionManager {
  private sessions = new Map<string, IGameSession>();
  private lobbies = new Map<string, LobbySession>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private lobbyCodes = new Map<string, string>();

  createLobby(id: string, code: string, hostPlayerId: string, hostToken: string, hostPlayerToken: string): LobbySession {
    const lobby = new LobbySession(id, code, hostPlayerId, hostToken, hostPlayerToken);
    this.lobbies.set(id, lobby);
    this.lobbyCodes.set(code.toUpperCase(), id);
    return lobby;
  }

  getLobby(id: string): LobbySession | undefined {
    return this.lobbies.get(id) ?? this.lobbies.get(this.lobbyCodes.get(id.toUpperCase()) ?? "");
  }

  createAllAi(
    id: string,
    decks: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }>,
    onMessage: (msg: GameMessage) => void,
    options?: {
      mode?: SessionMode;
      seats?: Seat[];
      seatCredentials?: SeatCredential[];
      playerDecks?: CardName[][];
      playerDeckMetadata?: DeckCardMetadata[][];
      playerCommanders?: Array<CardName | null>;
      startingPlayerIndex?: number;
    }
  ): AllAiGameSession {
    const session = new AllAiGameSession(id, decks, (msg) => {
      onMessage(msg);
      if (msg.type === "game_over") {
        this.scheduleCleanup(id);
      }
    }, options);
    this.sessions.set(id, session);
    return session;
  }

  create(
    id: string,
    humanDeck: CardName[],
    humanDeckMeta: DeckCardMetadata[],
    humanCommander: CardName | null,
    aiDecks: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }>,
    onMessage: (msg: GameMessage) => void,
    options?: {
      mode?: SessionMode;
      seats?: Seat[];
      seatCredentials?: SeatCredential[];
      playerDecks?: CardName[][];
      playerDeckMetadata?: DeckCardMetadata[][];
      playerCommanders?: Array<CardName | null>;
      startingPlayerIndex?: number;
    }
  ): GameSession {
    const session = new GameSession(id, humanDeck, humanDeckMeta, humanCommander, aiDecks, (msg) => {
      onMessage(msg);
      if (msg.type === "game_over") {
        this.scheduleCleanup(id);
      }
    }, options);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): IGameSession | undefined {
    return this.sessions.get(id);
  }

  /** Return all active (running) session IDs */
  getActiveSessions(): Array<{ id: string; status: string }> {
    const result: Array<{ id: string; status: string }> = [];
    for (const [id, session] of this.sessions) {
      result.push({ id, status: session.status });
    }
    return result;
  }

  delete(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.destroy();
      this.sessions.delete(id);
    }
    const timer = this.cleanupTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(id);
    }
  }

  private scheduleCleanup(id: string): void {
    const timer = setTimeout(() => {
      this.delete(id);
    }, SESSION_CLEANUP_MS);
    this.cleanupTimers.set(id, timer);
  }
}
