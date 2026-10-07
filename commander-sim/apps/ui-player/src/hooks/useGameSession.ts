import { useEffect, useRef, useState, useCallback } from "react";
import type { ConnectionRole, Seat, SeatId, SessionCapabilities, SessionMode, ViewType } from "../../../../packages/game-state/src/session";
import type { AiDecisionTrace } from "../../../../packages/game-state/src/types";

const GAME_SERVER_URL = import.meta.env.VITE_GAME_SERVER_URL ?? "http://localhost:5300";
const GAME_WS_URL = GAME_SERVER_URL.replace(/^http/, "ws");

export type PlayerPosition = "SOUTH" | "NORTH" | "EAST" | "WEST";
export type GameMode = "HUMAN_VS_AI" | "ALL_AI";
export type AgentType = "HUMAN" | "AI";

export interface PlayerDescriptor {
  playerIndex: number;
  seat: PlayerPosition;
  agentType: AgentType;
  displayName: string;
}

export interface CreaturePermanent {
  id: string;
  name: string;
  power: number;
  toughness: number;
  tapped: boolean;
  summoningSickness: boolean;
}

export interface FilteredPlayerState {
  playerId?: string;
  seatId?: SeatId;
  index: number;
  playerIndex?: number;
  position: PlayerPosition;
  seat?: PlayerPosition;
  controller?: "human" | "ai";
  agentType?: AgentType;
  displayName?: string;
  life: number;
  commander: string;
  commandZone?: string[];
  battlefield: string[];
  battlefieldPermanents?: Array<{
    name: string;
    tapped: boolean;
    isLand?: boolean;
    typeLine?: string;
    imageName?: string;
    imageFace?: "front" | "back";
  }>;
  creatures: CreaturePermanent[];
  graveyard: string[];
  exile: string[];
  libraryCount: number;
  handCount: number;
  hand?: string[];
  isHuman: boolean;
  isConceded?: boolean;
}

export interface FilteredGameState {
  sessionId?: string;
  stateVersion?: number;
  revision?: number;
  mode?: SessionMode;
  view?: ViewType;
  role?: ConnectionRole;
  capabilities?: SessionCapabilities;
  seats?: Seat[];
  privatePlayer?: {
    playerId: string;
    hand: string[];
  };
  gameMode?: GameMode;
  turn: number;
  phase: string;
  phaseStep: string;
  playerIndex: number;
  startingPlayerIndex: number;
  players: FilteredPlayerState[];
  playerDescriptors?: PlayerDescriptor[];
}

export interface WaitingContext {
  type: string;
  playerIndex?: number;
  availableActions?: Array<{ type: string; card?: string; player?: number }>;
  plans?: unknown[];
  opponentIndices?: number[];
  hand?: string[];
  mulliganCount?: number;
  triggeringEntry?: {
    action?: { type: string; card?: string };
    casterIndex?: number;
  };
}

export interface PendingDecision {
  sessionId?: string;
  stateVersion?: number;
  turn?: number;
  phase?: string;
  activePlayer?: number;
  decisionType: string;
  context: WaitingContext;
}

export interface GameOverInfo {
  winner: number | null;
}

export interface UseGameSessionReturn {
  gameState: FilteredGameState | null;
  capabilities: SessionCapabilities | null;
  pendingDecision: PendingDecision | null;
  gameLog: string[];
  aiDecisionTraces: AiDecisionTrace[];
  isConnected: boolean;
  gameOver: GameOverInfo | null;
  stateOutOfSyncMessage: string | null;
  submitAction: (action: unknown) => void;
  submitAttackPlan: (plan: unknown) => void;
  submitBlockPlan: (plan: unknown) => void;
  submitMulligan: (keep: boolean, bottomCards?: string[]) => void;
  submitTarget: (targetIndex: number) => void;
  submitResponse: (action: unknown) => void;
  concede: () => void;
}

type CardAction = { type?: unknown; card?: unknown; cardName?: unknown; player?: unknown };

function actionCard(action: unknown): string | null {
  if (!action || typeof action !== "object") return null;
  const candidate = action as CardAction;
  if (typeof candidate.card === "string") return candidate.card;
  if (typeof candidate.cardName === "string") return candidate.cardName;
  return null;
}

export function isPendingDecisionForState(
  pendingDecision: PendingDecision | null,
  gameState: FilteredGameState | null
) {
  if (!pendingDecision || !gameState) return false;
  return (
    pendingDecision.sessionId === gameState.sessionId &&
    pendingDecision.stateVersion === gameState.stateVersion
  );
}

export interface UseGameSessionOptions {
  role?: ConnectionRole;
  seatId?: SeatId;
  playerId?: string;
  playerToken?: string;
}

export function isPendingDecisionOwnedByHuman(
  pendingDecision: PendingDecision | null,
  gameState: FilteredGameState | null
) {
  if (!pendingDecision || !gameState) return false;
  if (gameState.gameMode === "ALL_AI") return false;
  const activePlayer = pendingDecision.activePlayer ?? 0;
  const player = gameState.players.find((candidate) => candidate.index === activePlayer);
  return player?.agentType === "HUMAN" || player?.isHuman === true;
}

export function validateActionAgainstDisplayedHand(params: {
  action: unknown;
  gameState: FilteredGameState | null;
  pendingDecision: PendingDecision | null;
}) {
  const action = params.action as CardAction | null;
  if (!action || typeof action !== "object") return { ok: true as const };
  if (action.type !== "PLAY_LAND" && action.type !== "CAST_SPELL") return { ok: true as const };
  const card = actionCard(action);
  if (!card) return { ok: true as const };

  const player = typeof action.player === "number" ? action.player : 0;
  const displayedHand = params.gameState?.players.find((candidate) => candidate.index === player)?.hand ?? [];
  const ok =
    isPendingDecisionForState(params.pendingDecision, params.gameState) &&
    displayedHand.includes(card);
  return ok
    ? { ok: true as const }
    : {
        ok: false as const,
        reason: "state out of sync",
        card,
        player,
        displayedHand,
        stateVersion: params.gameState?.stateVersion,
        pendingStateVersion: params.pendingDecision?.stateVersion,
      };
}

export function useGameSession(
  sessionId: string | null,
  options: UseGameSessionOptions = {}
): UseGameSessionReturn {
  const [gameState, setGameState] = useState<FilteredGameState | null>(null);
  const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const [gameLog, setGameLog] = useState<string[]>([]);
  const [aiDecisionTraces, setAiDecisionTraces] = useState<AiDecisionTrace[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [gameOver, setGameOver] = useState<GameOverInfo | null>(null);
  const [stateOutOfSyncMessage, setStateOutOfSyncMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<PendingDecision | null>(null);
  const gameStateRef = useRef<FilteredGameState | null>(null);

  useEffect(() => {
    pendingRef.current = pendingDecision;
  }, [pendingDecision]);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    setGameState(null);
    setCapabilities(null);
    setPendingDecision(null);
    setGameLog([]);
    setAiDecisionTraces([]);
    setIsConnected(false);
    setGameOver(null);
    setStateOutOfSyncMessage(null);

    if (!sessionId) return;

    const params = new URLSearchParams();
    params.set("role", options.role ?? "debug");
    if (options.seatId) params.set("seatId", options.seatId);
    if (options.playerId) params.set("playerId", options.playerId);
    if (options.playerToken) params.set("playerToken", options.playerToken);
    const ws = new WebSocket(`${GAME_WS_URL}/game/${sessionId}?${params.toString()}`);
    wsRef.current = ws;

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (msg.type) {
        case "SESSION_JOINED":
          setCapabilities(msg.capabilities as SessionCapabilities);
          break;
        case "GAME_SNAPSHOT": {
          const incoming = msg.state as FilteredGameState;
          const currentRevision = gameStateRef.current?.revision ?? gameStateRef.current?.stateVersion ?? 0;
          const incomingRevision = incoming.revision ?? incoming.stateVersion ?? currentRevision;
          if (incomingRevision < currentRevision) return;
          if (incomingRevision > currentRevision + 1 && currentRevision > 0) {
            ws.send(JSON.stringify({ type: "REQUEST_SNAPSHOT", knownRevision: currentRevision }));
          }
          setCapabilities(incoming.capabilities ?? null);
          setGameState(incoming);
          setStateOutOfSyncMessage(null);
          break;
        }
        case "PRIVATE_PLAYER_STATE":
          setGameState((prev) => {
            if (!prev) return prev;
            const privatePlayer = msg.player as { playerId: string; hand: string[] };
            return {
              ...prev,
              privatePlayer,
              players: prev.players.map((player) =>
                player.playerId === privatePlayer.playerId
                  ? { ...player, hand: privatePlayer.hand, handCount: privatePlayer.hand.length }
                  : player
              ),
            };
          });
          break;
        case "state_update":
          setGameState((prev) => {
            const incoming = msg.state as FilteredGameState;
            const currentRevision = prev?.revision ?? prev?.stateVersion ?? 0;
            const incomingRevision = incoming.revision ?? incoming.stateVersion ?? currentRevision;
            if (incomingRevision < currentRevision) return prev;
            return incoming;
          });
          setCapabilities(((msg.state as FilteredGameState).capabilities) ?? null);
          setStateOutOfSyncMessage(null);
          break;
        case "waiting_for_human":
          setPendingDecision({
            sessionId: msg.sessionId as string | undefined,
            stateVersion: msg.stateVersion as number | undefined,
            turn: msg.turn as number | undefined,
            phase: msg.phase as string | undefined,
            activePlayer: msg.activePlayer as number | undefined,
            decisionType: msg.decisionType as string,
            context: msg.context as WaitingContext,
          });
          break;
        case "game_over":
          setGameOver({ winner: msg.winner as number | null });
          setPendingDecision(null);
          break;
        case "game_log":
          setGameLog((prev) => [...prev.slice(-199), msg.message as string]);
          break;
        case "ai_decision_trace":
          setAiDecisionTraces((prev) => [...prev.slice(-199), msg.trace as AiDecisionTrace]);
          break;
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, options.role, options.seatId, options.playerId, options.playerToken]);

  const send = useCallback((data: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const pending = pendingRef.current;
      ws.send(JSON.stringify({
        ...data,
        stateVersion: pending?.stateVersion,
      }));
      setPendingDecision(null);
    }
  }, []);

  const submitAction = useCallback((action: unknown) => {
    const validation = validateActionAgainstDisplayedHand({
      action,
      gameState: gameStateRef.current,
      pendingDecision: pendingRef.current,
    });
    if (!validation.ok) {
      console.error("[ui-state-invariant]", {
        invariant: "ACTION_CARD_MUST_BE_IN_DISPLAYED_HAND",
        ...validation,
        action,
        engineHand: gameStateRef.current?.players.find((candidate) => candidate.index === validation.player)?.hand ?? [],
      });
      setStateOutOfSyncMessage("state out of sync");
      setGameLog((prev) => [...prev.slice(-199), "state out of sync"]);
      return;
    }
    send({ type: "submit_action", action });
  }, [send]);

  const submitAttackPlan = useCallback((plan: unknown) => {
    send({ type: "submit_attack_plan", plan });
  }, [send]);

  const submitBlockPlan = useCallback((plan: unknown) => {
    send({ type: "submit_block_plan", plan });
  }, [send]);

  const submitMulligan = useCallback((keep: boolean, bottomCards?: string[]) => {
    send({ type: "submit_mulligan", keep, bottomCards });
  }, [send]);

  const submitTarget = useCallback((targetIndex: number) => {
    send({ type: "submit_target", targetIndex });
  }, [send]);

  const submitResponse = useCallback((action: unknown) => {
    send({ type: "submit_response", action });
  }, [send]);

  const concede = useCallback(() => {
    send({ type: "concede" });
  }, [send]);

  const synchronizedPendingDecision = isPendingDecisionForState(pendingDecision, gameState) &&
    isPendingDecisionOwnedByHuman(pendingDecision, gameState)
    ? pendingDecision
    : null;

  useEffect(() => {
    if (!pendingDecision || !gameState) return;
    if (!isPendingDecisionForState(pendingDecision, gameState)) return;
    if (isPendingDecisionOwnedByHuman(pendingDecision, gameState)) return;
    const activePlayer = pendingDecision.activePlayer ?? 0;
    const player = gameState.players.find((candidate) => candidate.index === activePlayer);
    console.error("[player-mapping-invariant]", {
      invariant: "PENDING_DECISION_PLAYER_MUST_BE_HUMAN",
      gameMode: gameState.gameMode,
      sessionId: gameState.sessionId,
      stateVersion: gameState.stateVersion,
      pendingDecision,
      playerDescriptor: player
        ? {
            playerIndex: player.index,
            seat: player.seat ?? player.position,
            agentType: player.agentType,
            displayName: player.displayName,
            isHuman: player.isHuman,
          }
        : null,
    });
    setStateOutOfSyncMessage("state out of sync");
  }, [pendingDecision, gameState]);

  return {
    gameState,
    capabilities,
    pendingDecision: synchronizedPendingDecision,
    gameLog,
    aiDecisionTraces,
    isConnected,
    gameOver,
    stateOutOfSyncMessage,
    submitAction,
    submitAttackPlan,
    submitBlockPlan,
    submitMulligan,
    submitTarget,
    submitResponse,
    concede,
  };
}
