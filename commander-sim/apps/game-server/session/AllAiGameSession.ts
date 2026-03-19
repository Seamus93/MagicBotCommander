import type { SimGameState, GameEvent, CardName, DeckCardMetadata } from "@game-state/types";
import { simulateGame } from "@sim/engine.js";
import { DecisionTreeAgent } from "@sim/decisionTreeAgent.js";
import { PatternStore } from "@sim/patterns.js";
import { serializeForViewer, type FilteredGameState } from "../state/stateSerializer.js";
import type { GameMessage, SessionStatus } from "./GameSession.js";

/**
 * Game session where ALL 4 players are AI.
 * Used by SpellTable viewer — no human interaction needed.
 *
 * The simulation does NOT start in the constructor. Call startSimulation()
 * once the first WebSocket client connects so the viewer sees the game
 * from turn 1 instead of joining mid-game.
 */
export class AllAiGameSession {
  readonly id: string;
  status: SessionStatus = "pending";
  winner: number | null = null;

  private onMessage: (msg: GameMessage) => void;
  private lastState: SimGameState | null = null;
  private simulationStarted = false;

  private agents: DecisionTreeAgent[];
  private playerDecks: CardName[][];
  private playerDeckMetadata: DeckCardMetadata[][];
  private playerCommanders: Array<CardName | null>;

  constructor(
    id: string,
    decks: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }>,
    onMessage: (msg: GameMessage) => void
  ) {
    this.id = id;
    this.onMessage = onMessage;

    this.agents = decks.map((_d, i) =>
      new DecisionTreeAgent({ id: `ai-${i}`, store: new PatternStore() })
    );
    this.playerDecks = decks.map((d) => d.deck);
    this.playerDeckMetadata = decks.map((d) => d.meta);
    this.playerCommanders = decks.map((d) => d.commander ?? d.deck[0] ?? null);
  }

  /** Called by the WebSocket handler when the first client connects. */
  startSimulation(): void {
    if (this.simulationStarted) return;
    this.simulationStarted = true;
    this.status = "running";

    simulateGame(this.agents, {
      maxTurns: 60,
      enableStack: true,
      maxMulligans: 2,
      phaseDelayMs: 1200,
      actionDelayMs: 1200,
      playerDecks: this.playerDecks,
      playerDeckMetadata: this.playerDeckMetadata,
      playerCommanders: this.playerCommanders,
      log: (msg) => {
        this.onMessage({ type: "game_log", message: msg });
      },
      onStateChange: (state: SimGameState, event: GameEvent) => {
        this.lastState = state;
        this.onMessage({
          type: "state_update",
          state: serializeForViewer(state, 0),
        });
        if (event.type === "game_over") {
          this.winner = event.winner;
          this.status = "game_over";
          this.onMessage({ type: "game_over", winner: event.winner });
        }
      },
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.onMessage({ type: "game_log", message: `[ERROR] ${msg}` });
      this.status = "game_over";
    });
  }

  getFilteredState(): FilteredGameState | null {
    if (!this.lastState) return null;
    return serializeForViewer(this.lastState, 0);
  }

  // Stub methods for compatibility with SessionManager
  getLastWaitingMessage() { return null; }
  submitDecision(_decision: unknown) { /* no-op */ }
  concede() {
    this.status = "game_over";
    this.winner = null;
    this.onMessage({ type: "game_over", winner: null });
  }
  startDisconnectTimer() { /* no-op */ }
  destroy() { /* no-op */ }
}
