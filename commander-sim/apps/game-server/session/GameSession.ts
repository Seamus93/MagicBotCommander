import type { SimGameState, GameEvent, CardName, DeckCardMetadata, AiDecisionTrace } from "@game-state/types";
import { simulateGame } from "@sim/engine.js";
import { DecisionTreeAgent } from "@sim/decisionTreeAgent.js";
import { loadTrainedPolicyStore } from "@sim/policyLoader.js";
import { HumanAgent, type WaitingType, type WaitingContext } from "../agents/HumanAgent.js";
import {
  assignSeatsByTurnOrder,
  buildPlayerDescriptorsFromSeats,
  buildSeatsFromControllers,
  serializeForRecipient,
  serializeForViewer,
  sessionMappingLog,
  type FilteredGameState,
} from "../state/stateSerializer.js";
import type { Seat, SessionMode, SessionRecipient } from "../../../packages/game-state/src/session";
import type { RecipientAuthResult } from "./SessionManager.js";
import {
  authenticateSeatRecipient,
  buildSeatCredentialState,
  releaseSeatConnection,
  type SeatCredential,
} from "./seatOwnership.js";

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

export interface AiDecisionTraceMessage {
  type: "ai_decision_trace";
  trace: AiDecisionTrace;
}

export type GameMessage =
  | WaitingMessage
  | StateUpdateMessage
  | GameOverMessage
  | GameLogMessage
  | AiDecisionTraceMessage;

export class GameSession {
  readonly id: string;
  readonly mode: SessionMode;
  readonly seats: Seat[];
  status: SessionStatus = "pending";
  winner: number | null = null;
  private readonly startingPlayerIndex: number;
  private stateVersion = 0;

  private humanAgent: HumanAgent;
  private humanAgents = new Map<number, HumanAgent>();
  private pendingHumanAgent: HumanAgent | null = null;
  private onMessage: (msg: GameMessage) => void;
  private lastState: SimGameState | null = null;
  private lastWaitingMessage: WaitingMessage | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DISCONNECT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
  private readonly seatCredentials;
  private readonly concededPlayers = new Set<number>();

  constructor(
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
  ) {
    this.id = id;
    this.onMessage = onMessage;
    this.mode = options?.mode ?? "game";
    this.startingPlayerIndex = options?.startingPlayerIndex ?? Math.floor(Math.random() * 4);
    this.seats = assignSeatsByTurnOrder(
      options?.seats ?? buildSeatsFromControllers(["human", "ai", "ai", "ai"]),
      this.startingPlayerIndex
    );
    this.seatCredentials = buildSeatCredentialState(this.remapSeatCredentials(options?.seatCredentials));

    const makeHumanAgent = (playerIndex: number) => new HumanAgent(id, (type, ctx, decisionState) => {
      if (decisionState) {
        this.emitStateUpdate(decisionState);
      }
      const sourceState = decisionState ?? this.lastState;
      const decisionPlayerIndex = typeof ctx.playerIndex === "number"
        ? ctx.playerIndex
        : sourceState?.playerIndex ?? playerIndex;
      this.assertHumanDecisionOwner(decisionPlayerIndex, sourceState);
      this.pendingHumanAgent = this.humanAgents.get(decisionPlayerIndex) ?? null;
      const msg: WaitingMessage = {
        type: "waiting_for_human",
        sessionId: this.id,
        stateVersion: this.stateVersion,
        turn: sourceState?.turn ?? 0,
        phase: sourceState?.phaseStep || sourceState?.phase || "",
        activePlayer: decisionPlayerIndex,
        decisionType: type,
        context: ctx,
      };
      this.lastWaitingMessage = msg;
      this.onMessage(msg);
    });
    this.humanAgent = makeHumanAgent(0);
    for (const seat of this.seats) {
      if (seat.controller === "human") {
        const agent = seat.playerIndex === 0 ? this.humanAgent : makeHumanAgent(seat.playerIndex);
        this.humanAgents.set(seat.playerIndex, agent);
      }
    }
    if (!this.humanAgents.has(0)) {
      this.humanAgents.set(0, this.humanAgent);
    }

    const playerDecks = options?.playerDecks ?? [humanDeck, ...aiDecks.map((d) => d.deck)];
    const playerDeckMetadata = options?.playerDeckMetadata ?? [humanDeckMeta, ...aiDecks.map((d) => d.meta)];
    const playerCommanders = options?.playerCommanders ?? [
      humanCommander,
      ...aiDecks.map((d) => d.commander ?? d.deck[0] ?? null),
    ];

    const logs: string[] = [];

    void this.startWithPolicy(playerDecks, playerDeckMetadata, playerCommanders, logs);
  }

  private async startWithPolicy(
    playerDecks: CardName[][],
    playerDeckMetadata: DeckCardMetadata[][],
    playerCommanders: Array<CardName | null>,
    logs: string[]
  ): Promise<void> {
    try {
      const loadedPolicy = await loadTrainedPolicyStore({
        log: (message) => this.onMessage({ type: "game_log", message }),
      });
      const agents = this.seats.map((seat) => {
        if (seat.controller === "human") {
          return this.humanAgents.get(seat.playerIndex) ?? this.humanAgent;
        }
        return new DecisionTreeAgent({ id: seat.aiAgentId ?? `ai-${seat.playerIndex}`, store: loadedPolicy.store });
      });
      this.status = "running";
      this.logSessionMapping();
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
      concededPlayers: this.concededPlayers,
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
      onAiDecisionTrace: (trace) => {
        this.onMessage({ type: "ai_decision_trace", trace });
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
    const agent = this.pendingHumanAgent ?? this.humanAgents.get(this.lastState?.playerIndex ?? 0) ?? this.humanAgent;
    this.pendingHumanAgent = null;
    agent.submitDecision(decision);
    this.resetDisconnectTimer();
  }

  getLastWaitingMessage(): WaitingMessage | null {
    return this.lastWaitingMessage;
  }

  concede(playerIndex = 0): void {
    this.concedePlayer(playerIndex);
  }

  concedeForRecipient(recipient: SessionRecipient): boolean {
    if (recipient.role === "debug") {
      this.concede(this.lastWaitingMessage?.activePlayer ?? this.lastState?.playerIndex ?? 0);
      return true;
    }
    const ownedSeat = this.seatForRecipient(recipient);
    if (!ownedSeat || ownedSeat.controller !== "human") return false;
    this.concedePlayer(ownedSeat.playerIndex);
    return true;
  }

  concedeForPlayerCredentials(seatId: Seat["id"], playerId: string, playerToken: string): boolean {
    const ownedSeat = this.seats.find((seat) => seat.id === seatId && seat.playerId === playerId);
    const credential = this.seatCredentials.get(seatId);
    if (!ownedSeat || ownedSeat.controller !== "human") return false;
    if (credential && (credential.playerId !== playerId || credential.token !== playerToken)) return false;
    if (!credential && playerToken) return false;
    this.concedePlayer(ownedSeat.playerIndex);
    return true;
  }

  getFilteredState(): FilteredGameState | null {
    if (!this.lastState) return null;
    return serializeForViewer(this.lastState, 0, this.startingPlayerIndex, {
      sessionId: this.id,
      stateVersion: this.stateVersion,
      gameMode: "HUMAN_VS_AI",
      mode: this.mode,
      seats: this.seats,
    });
  }

  getSnapshotForRecipient(recipient: SessionRecipient) {
    if (!this.lastState) return null;
    return serializeForRecipient(this.lastState, this.startingPlayerIndex, {
      sessionId: this.id,
      stateVersion: this.stateVersion,
      mode: this.mode,
      recipient,
      seats: this.seats,
      gameMode: "HUMAN_VS_AI",
    });
  }

  startSimulation(): void { /* already started in constructor */ }

  authenticateRecipient(recipient: SessionRecipient, connectionId: string): RecipientAuthResult {
    return authenticateSeatRecipient({
      recipient,
      connectionId,
      seats: this.seats,
      credentials: this.seatCredentials,
    });
  }

  releaseConnection(connectionId: string): void {
    releaseSeatConnection(this.seatCredentials, connectionId);
  }

  startDisconnectTimer(): void {
    this.resetDisconnectTimer();
  }

  private resetDisconnectTimer(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = setTimeout(() => {
      // A closed player window is a disconnect, not an implicit concession.
      // Keep the session alive so the player can reconnect with their seat token.
    }, this.DISCONNECT_TIMEOUT_MS);
  }

  destroy(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
  }

  private emitStateUpdate(state: SimGameState): void {
    const stateForView = this.stateWithConcessions(state);
    this.lastState = stateForView;
    this.stateVersion++;
    this.onMessage({
      type: "state_update",
      state: serializeForViewer(stateForView, 0, this.startingPlayerIndex, {
        sessionId: this.id,
        stateVersion: this.stateVersion,
        gameMode: "HUMAN_VS_AI",
        mode: this.mode,
        seats: this.seats,
      }),
    });
  }

  private stateWithConcessions(state: SimGameState): SimGameState {
    if (!this.concededPlayers.size) return state;
    let changed = false;
    const lifeTotals = state.lifeTotals.map((life, player) => {
      if (!this.concededPlayers.has(player) || life <= 0) return life;
      changed = true;
      return 0;
    });
    return changed ? { ...state, lifeTotals } : state;
  }

  private logSessionMapping(): void {
    this.onMessage({
      type: "game_log",
      message: sessionMappingLog("HUMAN_VS_AI", buildPlayerDescriptorsFromSeats(this.seats)),
    });
  }

  private remapSeatCredentials(credentials: SeatCredential[] = []): SeatCredential[] {
    return credentials.map((credential) => {
      const seat =
        this.seats.find((candidate) => candidate.playerId === credential.playerId) ??
        this.seats.find((candidate) => candidate.id === credential.seatId);
      return {
        ...credential,
        seatId: seat?.id ?? credential.seatId,
      };
    });
  }

  private assertHumanDecisionOwner(playerIndex: number, state: SimGameState | null): void {
    const seat = this.seats.find((candidate) => candidate.playerIndex === playerIndex);
    if (seat?.controller === "human") return;

    const payload = {
      invariant: "PENDING_HUMAN_DECISION_MUST_BELONG_TO_HUMAN_PLAYER",
      stage: "GameSession.waiting_for_human",
      sessionId: this.id,
      gameMode: "HUMAN_VS_AI",
      mode: this.mode,
      playerIndex,
      expectedHumanSeats: this.seats.filter((candidate) => candidate.controller === "human"),
      turn: state?.turn,
      phase: state?.phase,
      phaseStep: state?.phaseStep,
    };
    console.error("[player-mapping-invariant]", JSON.stringify(payload, null, 2));
    this.onMessage({
      type: "game_log",
      message: `[player-mapping] invalid human decision owner session=${this.id} player=${playerIndex}`,
    });

    if (process.env.DEBUG_PLAYER_MAPPING === "true" || process.env.NODE_ENV !== "production") {
      throw new Error(`[player-mapping-invariant] pending human decision belongs to P${playerIndex}`);
    }
  }

  submitDecisionForRecipient(
    recipient: SessionRecipient,
    decision: unknown,
    expectedStateVersion?: number
  ): boolean {
    if (recipient.role === "debug") {
      this.submitDecision(decision, expectedStateVersion);
      return true;
    }
    const waiting = this.lastWaitingMessage;
    if (!waiting) {
      this.onMessage({
        type: "game_log",
        message: `[ownership] rejected decision without pending human input session=${this.id}`,
      });
      return false;
    }
    const ownedSeat = this.seatForRecipient(recipient);
    if (ownedSeat && this.concededPlayers.has(ownedSeat.playerIndex)) {
      this.onMessage({
        type: "game_log",
        message: `[ownership] rejected action from conceded player session=${this.id} player=P${ownedSeat.playerIndex}`,
      });
      return false;
    }
    if (!ownedSeat || ownedSeat.controller !== "human" || ownedSeat.playerIndex !== waiting.activePlayer) {
      this.onMessage({
        type: "game_log",
        message: `[ownership] rejected action session=${this.id} role=${recipient.role} seat=${recipient.seatId ?? "none"} active=P${waiting.activePlayer}`,
      });
      return false;
    }
    this.submitDecision(decision, expectedStateVersion);
    return true;
  }

  private seatForRecipient(recipient: SessionRecipient): Seat | undefined {
    return this.seats.find((seat) =>
      recipient.seatId ? seat.id === recipient.seatId : seat.playerId === recipient.playerId
    );
  }

  private concedePlayer(playerIndex: number): void {
    if (this.status !== "running" && this.status !== "pending") return;
    if (this.concededPlayers.has(playerIndex)) return;
    this.concededPlayers.add(playerIndex);
    this.onMessage({ type: "game_log", message: `[Concede] Player ${playerIndex} concedes` });

    if (this.lastState && this.lastState.lifeTotals[playerIndex] !== undefined) {
      this.lastState = {
        ...this.lastState,
        lifeTotals: this.lastState.lifeTotals.map((life, index) => index === playerIndex ? 0 : life),
      };
      this.emitStateUpdate(this.lastState);
      const activePlayers = this.lastState.lifeTotals
        .map((life, index) => ({ life, index }))
        .filter(({ life }) => life > 0);
      if (activePlayers.length === 1) {
        this.winner = activePlayers[0].index;
        this.status = "game_over";
        this.onMessage({ type: "game_over", winner: this.winner });
      }
    }

    const pendingAgent = this.pendingHumanAgent;
    if (this.lastWaitingMessage?.activePlayer === playerIndex && pendingAgent?.hasPendingDecision) {
      const waiting = this.lastWaitingMessage;
      this.lastWaitingMessage = null;
      this.pendingHumanAgent = null;
      pendingAgent.submitDecision(this.concessionFallbackDecision(waiting));
    }
  }

  private concessionFallbackDecision(waiting: WaitingMessage): unknown {
    switch (waiting.decisionType) {
      case "action":
        return { type: "CONCEDE" };
      case "response":
        return null;
      case "mulligan":
        return { keep: true };
      case "target":
        return waiting.context.opponentIndices?.[0] ?? 0;
      case "attack_plan":
      case "block_plan":
        return waiting.context.plans?.[0] ?? {};
      default:
        return { type: "PASS_TURN" };
    }
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
