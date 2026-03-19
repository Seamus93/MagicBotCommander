import type { SimGameState, GameEvent, CardName, DeckCardMetadata } from "@game-state/types";
import { simulateGame } from "@sim/engine.js";
import { DecisionTreeAgent } from "@sim/decisionTreeAgent.js";
import { PatternStore } from "@sim/patterns.js";
import { HumanAgent, type WaitingType, type WaitingContext } from "../agents/HumanAgent.js";
import { serializeForViewer, type FilteredGameState } from "../state/stateSerializer.js";

export type SessionStatus = "pending" | "running" | "game_over";

export interface WaitingMessage {
  type: "waiting_for_human";
  decisionType: WaitingType;
  context: WaitingContext;
}

export interface StateUpdateMessage {
  type: "state_update";
  state: FilteredGameState;
}

export interface GameOverMessage {
  type: "game_over";
  winner: number | null;
}

export interface GameLogMessage {
  type: "game_log";
  message: string;
}

export type GameMessage =
  | WaitingMessage
  | StateUpdateMessage
  | GameOverMessage
  | GameLogMessage;

export class GameSession {
  readonly id: string;
  status: SessionStatus = "pending";
  winner: number | null = null;
  private readonly startingPlayerIndex: number;

  private humanAgent: HumanAgent;
  private onMessage: (msg: GameMessage) => void;
  private lastState: SimGameState | null = null;
  private lastWaitingMessage: WaitingMessage | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DISCONNECT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

  constructor(
    id: string,
    humanDeck: CardName[],
    humanDeckMeta: DeckCardMetadata[],
    humanCommander: CardName | null,
    aiDecks: Array<{ deck: CardName[]; meta: DeckCardMetadata[]; commander?: CardName | null }>,
    onMessage: (msg: GameMessage) => void
  ) {
    this.id = id;
    this.onMessage = onMessage;
    this.startingPlayerIndex = Math.floor(Math.random() * 4);

    this.humanAgent = new HumanAgent((type, ctx) => {
      const msg: WaitingMessage = { type: "waiting_for_human", decisionType: type, context: ctx };
      this.lastWaitingMessage = msg;
      this.onMessage(msg);
    });

    const aiAgents = aiDecks.map((_d, i) =>
      new DecisionTreeAgent({ id: `ai-${i + 1}`, store: new PatternStore() })
    );

    const agents = [this.humanAgent, ...aiAgents];
    const playerDecks = [humanDeck, ...aiDecks.map((d) => d.deck)];
    const playerDeckMetadata = [humanDeckMeta, ...aiDecks.map((d) => d.meta)];
    const playerCommanders = [
      humanCommander,
      ...aiDecks.map((d) => d.commander ?? d.deck[0] ?? null),
    ];

    const logs: string[] = [];

    this.status = "running";

    simulateGame(agents, {
      maxTurns: 60,
      startingPlayerIndex: this.startingPlayerIndex,
      playerDecks,
      playerDeckMetadata,
      playerCommanders,
      enableStack: true,
      maxMulligans: 2,
      phaseDelayMs: 1200,
      actionDelayMs: 1200,
      log: (msg) => {
        logs.push(msg);
        this.onMessage({ type: "game_log", message: msg });
      },
      onStateChange: (state: SimGameState, event: GameEvent) => {
        this.lastState = state;
        this.onMessage({
          type: "state_update",
          state: serializeForViewer(state, 0, this.startingPlayerIndex),
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

  submitDecision(decision: unknown): void {
    this.lastWaitingMessage = null;
    this.humanAgent.submitDecision(decision);
    this.resetDisconnectTimer();
  }

  getLastWaitingMessage(): WaitingMessage | null {
    return this.lastWaitingMessage;
  }

  concede(): void {
    // Resolve any pending decision with a PASS_TURN to unblock the engine
    if (this.humanAgent.hasPendingDecision) {
      this.humanAgent.submitDecision({ type: "PASS_TURN" });
    }
    this.status = "game_over";
    this.winner = null;
    this.onMessage({ type: "game_over", winner: null });
  }

  getFilteredState(): FilteredGameState | null {
    if (!this.lastState) return null;
    return serializeForViewer(this.lastState, 0, this.startingPlayerIndex);
  }

  startSimulation(): void { /* already started in constructor */ }

  startDisconnectTimer(): void {
    this.resetDisconnectTimer();
  }

  private resetDisconnectTimer(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = setTimeout(() => {
      if (this.status === "running") {
        this.concede();
      }
    }, this.DISCONNECT_TIMEOUT_MS);
  }

  destroy(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
  }
}
