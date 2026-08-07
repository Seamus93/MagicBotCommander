import type { SimGameState, GameEvent, CardName, DeckCardMetadata } from "@game-state/types";
import { simulateGame } from "@sim/engine.js";
import { DecisionTreeAgent } from "@sim/decisionTreeAgent.js";
import { loadTrainedPolicyStore } from "@sim/policyLoader.js";
import { HumanAgent, type WaitingType, type WaitingContext } from "../agents/HumanAgent.js";
import { serializeForViewer, type FilteredGameState } from "../state/stateSerializer.js";

export type SessionStatus = "pending" | "running" | "game_over";

export interface WaitingMessage {
  type: "waiting_for_human";
  sessionId: string;
  stateVersion: number;
  turn: number;
  phase: string;
  activePlayer: number;
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
  private stateVersion = 0;

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

    this.humanAgent = new HumanAgent(id, (type, ctx, decisionState) => {
      if (decisionState) {
        this.emitStateUpdate(decisionState);
      }
      const sourceState = decisionState ?? this.lastState;
      const msg: WaitingMessage = {
        type: "waiting_for_human",
        sessionId: this.id,
        stateVersion: this.stateVersion,
        turn: sourceState?.turn ?? 0,
        phase: sourceState?.phaseStep || sourceState?.phase || "",
        activePlayer: sourceState?.playerIndex ?? 0,
        decisionType: type,
        context: ctx,
      };
      this.lastWaitingMessage = msg;
      this.onMessage(msg);
    });

    const playerDecks = [humanDeck, ...aiDecks.map((d) => d.deck)];
    const playerDeckMetadata = [humanDeckMeta, ...aiDecks.map((d) => d.meta)];
    const playerCommanders = [
      humanCommander,
      ...aiDecks.map((d) => d.commander ?? d.deck[0] ?? null),
    ];

    const logs: string[] = [];

    void this.startWithPolicy(aiDecks.length, playerDecks, playerDeckMetadata, playerCommanders, logs);
  }

  private async startWithPolicy(
    aiCount: number,
    playerDecks: CardName[][],
    playerDeckMetadata: DeckCardMetadata[][],
    playerCommanders: Array<CardName | null>,
    logs: string[]
  ): Promise<void> {
    try {
      const loadedPolicy = await loadTrainedPolicyStore({
        log: (message) => this.onMessage({ type: "game_log", message }),
      });
      const aiAgents = Array.from({ length: aiCount }, (_, i) =>
        new DecisionTreeAgent({ id: `ai-${i + 1}`, store: loadedPolicy.store })
      );
      const agents = [this.humanAgent, ...aiAgents];
      this.status = "running";
      this.onMessage({
        type: "game_log",
        message: `[policy] live_source=${loadedPolicy.source} records=${loadedPolicy.records}`,
      });

      await simulateGame(agents, {
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
        this.emitStateUpdate(state);
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

  submitDecision(decision: unknown, expectedStateVersion?: number): void {
    if (!this.assertSubmittedVersionCurrent(decision, expectedStateVersion)) return;
    this.assertSubmittedPlayLandInCurrentHand(decision);
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
    return serializeForViewer(this.lastState, 0, this.startingPlayerIndex, {
      sessionId: this.id,
      stateVersion: this.stateVersion,
    });
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

  private emitStateUpdate(state: SimGameState): void {
    this.lastState = state;
    this.stateVersion++;
    this.onMessage({
      type: "state_update",
      state: serializeForViewer(state, 0, this.startingPlayerIndex, {
        sessionId: this.id,
        stateVersion: this.stateVersion,
      }),
    });
  }

  private assertSubmittedVersionCurrent(decision: unknown, expectedStateVersion?: number): boolean {
    if (!this.lastWaitingMessage) return true;
    if (
      expectedStateVersion === this.stateVersion &&
      expectedStateVersion === this.lastWaitingMessage.stateVersion
    ) {
      return true;
    }
    const payload = {
      invariant: "SUBMITTED_DECISION_STATE_VERSION_MUST_MATCH_CURRENT_STATE",
      stage: "GameSession.submitDecision",
      sessionId: this.id,
      expectedStateVersion,
      currentStateVersion: this.stateVersion,
      submittedDecision: decision,
      pendingStateVersion: this.lastWaitingMessage?.stateVersion,
    };
    console.error("[state-version-invariant]", JSON.stringify(payload, null, 2));
    this.onMessage({
      type: "game_log",
      message: `[state-version] rejected stale decision session=${this.id} expected=${expectedStateVersion} current=${this.stateVersion}`,
    });
    return false;
  }

  private assertSubmittedPlayLandInCurrentHand(decision: unknown): void {
    if (!decision || typeof decision !== "object") return;
    const action = decision as { type?: unknown; card?: unknown; cardName?: unknown };
    if (action.type !== "PLAY_LAND") return;
    const card = typeof action.card === "string"
      ? action.card
      : typeof action.cardName === "string"
        ? action.cardName
        : null;
    if (!card || !this.lastState) return;

    const player = this.lastState.playerIndex;
    const hand = this.lastState.hands[player] ?? [];
    if (hand.includes(card)) return;

    const payload = {
      invariant: "SUBMITTED_PLAY_LAND_CARD_MUST_BE_IN_CURRENT_HAND",
      stage: "GameSession.submitDecision",
      sessionId: this.id,
      gameState: {
        turn: this.lastState.turn,
        phase: this.lastState.phase,
        phaseStep: this.lastState.phaseStep,
        playerIndex: this.lastState.playerIndex,
      },
      hand,
      submittedAction: decision,
      pendingAvailableActions: this.lastWaitingMessage?.context.availableActions ?? [],
    };
    console.error("[available-actions-invariant]", JSON.stringify(payload, null, 2));

    if (process.env.DEBUG_AVAILABLE_ACTIONS === "true" || process.env.NODE_ENV !== "production") {
      throw new Error(
        `[available-actions-invariant] submitted PLAY_LAND outside hand session=${this.id}`
      );
    }
  }
}
