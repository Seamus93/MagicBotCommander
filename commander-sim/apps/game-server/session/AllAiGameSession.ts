import type { SimGameState, GameEvent, CardName, DeckCardMetadata } from "@game-state/types";
import { simulateGame } from "@sim/engine.js";
import { DecisionTreeAgent } from "@sim/decisionTreeAgent.js";
import { loadTrainedPolicyStore } from "@sim/policyLoader.js";
import {
  buildPlayerDescriptorsFromSeats,
  buildSeatsFromControllers,
  serializeForRecipient,
  serializeForViewer,
  sessionMappingLog,
  type FilteredGameState,
} from "../state/stateSerializer.js";
import type { GameMessage, SessionStatus } from "./GameSession.js";
import type { RecipientAuthResult } from "./SessionManager.js";
import type { Seat, SessionMode, SessionRecipient } from "../../../packages/game-state/src/session";

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
  readonly mode: SessionMode;
  readonly seats: Seat[];
  status: SessionStatus = "pending";
  winner: number | null = null;

  private onMessage: (msg: GameMessage) => void;
  private lastState: SimGameState | null = null;
  private stateVersion = 0;
  private simulationStarted = false;

  private playerDecks: CardName[][];
  private playerDeckMetadata: DeckCardMetadata[][];
  private playerCommanders: Array<CardName | null>;

  constructor(
    id: string,
    decks: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }>,
    onMessage: (msg: GameMessage) => void,
    options?: { mode?: SessionMode; seats?: Seat[] }
  ) {
    this.id = id;
    this.onMessage = onMessage;
    this.mode = options?.mode ?? "debug";
    this.seats = options?.seats ?? buildSeatsFromControllers(["ai", "ai", "ai", "ai"]);

    this.playerDecks = decks.map((d) => d.deck);
    this.playerDeckMetadata = decks.map((d) => d.meta);
    this.playerCommanders = decks.map((d) => d.commander ?? d.deck[0] ?? null);
  }

  /** Called by the WebSocket handler when the first client connects. */
  startSimulation(): void {
    if (this.simulationStarted) return;
    this.simulationStarted = true;
    void this.runSimulation();
  }

  private async runSimulation(): Promise<void> {
    try {
      const loadedPolicy = await loadTrainedPolicyStore({
        log: (message) => this.onMessage({ type: "game_log", message }),
      });
      const agents = this.playerDecks.map((_d, i) =>
        new DecisionTreeAgent({ id: `ai-${i}`, store: loadedPolicy.store })
      );
      this.status = "running";
      this.logSessionMapping();
      this.onMessage({
        type: "game_log",
        message: `[policy] live_source=${loadedPolicy.source} records=${loadedPolicy.records}`,
      });

      await simulateGame(agents, {
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
        this.stateVersion++;
        this.onMessage({
          type: "state_update",
          state: serializeForViewer(state, 0, 0, {
            sessionId: this.id,
            stateVersion: this.stateVersion,
            gameMode: "ALL_AI",
            mode: this.mode,
            seats: this.seats,
          }),
        });
        if (event.type === "game_over") {
          this.winner = event.winner;
          this.status = "game_over";
          this.onMessage({ type: "game_over", winner: event.winner });
        }
      },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onMessage({ type: "game_log", message: `[ERROR] ${msg}` });
      this.status = "game_over";
    }
  }

  getFilteredState(): FilteredGameState | null {
    if (!this.lastState) return null;
    return serializeForViewer(this.lastState, 0, 0, {
      sessionId: this.id,
      stateVersion: this.stateVersion,
      gameMode: "ALL_AI",
      mode: this.mode,
      seats: this.seats,
    });
  }

  getSnapshotForRecipient(recipient: SessionRecipient) {
    if (!this.lastState) return null;
    return serializeForRecipient(this.lastState, 0, {
      sessionId: this.id,
      stateVersion: this.stateVersion,
      mode: this.mode,
      recipient,
      seats: this.seats,
      gameMode: "ALL_AI",
    });
  }

  // Stub methods for compatibility with SessionManager
  authenticateRecipient(recipient: SessionRecipient): RecipientAuthResult {
    if (recipient.role === "debug" || recipient.role === "table") {
      return { ok: true, recipient: { role: recipient.role } };
    }
    return {
      ok: false,
      code: "ALL_AI_HAS_NO_PLAYER_SEATS",
      message: "All-AI sessions can only be joined as table or debug spectators.",
    };
  }
  releaseConnection() { /* no-op */ }
  getLastWaitingMessage() { return null; }
  submitDecision() { /* no-op */ }
  concede() {
    this.status = "game_over";
    this.winner = null;
    this.onMessage({ type: "game_over", winner: null });
  }
  startDisconnectTimer() { /* no-op */ }
  destroy() { /* no-op */ }

  private logSessionMapping(): void {
    this.onMessage({
      type: "game_log",
      message: sessionMappingLog("ALL_AI", buildPlayerDescriptorsFromSeats(this.seats)),
    });
  }
}
