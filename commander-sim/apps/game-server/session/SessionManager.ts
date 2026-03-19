import { GameSession, type GameMessage, type WaitingMessage, type SessionStatus } from "./GameSession.js";
import { AllAiGameSession } from "./AllAiGameSession.js";
import type { CardName, DeckCardMetadata } from "@game-state/types";
import type { FilteredGameState } from "../state/stateSerializer.js";

/** Common interface for both human+AI and all-AI sessions */
export interface IGameSession {
  readonly id: string;
  status: SessionStatus;
  winner: number | null;
  getFilteredState(): FilteredGameState | null;
  getLastWaitingMessage(): WaitingMessage | null;
  submitDecision(decision: unknown): void;
  concede(): void;
  startDisconnectTimer(): void;
  startSimulation(): void;
  destroy(): void;
}

const SESSION_CLEANUP_MS = 15 * 60 * 1000; // 15 min after game_over

export class SessionManager {
  private sessions = new Map<string, IGameSession>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  createAllAi(
    id: string,
    decks: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }>,
    onMessage: (msg: GameMessage) => void
  ): AllAiGameSession {
    const session = new AllAiGameSession(id, decks, (msg) => {
      onMessage(msg);
      if (msg.type === "game_over") {
        this.scheduleCleanup(id);
      }
    });
    this.sessions.set(id, session);
    return session;
  }

  create(
    id: string,
    humanDeck: CardName[],
    humanDeckMeta: DeckCardMetadata[],
    humanCommander: CardName | null,
    aiDecks: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }>,
    onMessage: (msg: GameMessage) => void
  ): GameSession {
    const session = new GameSession(id, humanDeck, humanDeckMeta, humanCommander, aiDecks, (msg) => {
      onMessage(msg);
      if (msg.type === "game_over") {
        this.scheduleCleanup(id);
      }
    });
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
