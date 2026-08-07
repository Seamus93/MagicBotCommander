import { useEffect, useRef, useState, useCallback } from "react";

const GAME_SERVER_URL = import.meta.env.VITE_GAME_SERVER_URL ?? "http://localhost:5300";
const GAME_WS_URL = GAME_SERVER_URL.replace(/^http/, "ws");

export type PlayerPosition = "SOUTH" | "NORTH" | "EAST" | "WEST";

export interface CreaturePermanent {
  id: string;
  name: string;
  power: number;
  toughness: number;
  tapped: boolean;
  summoningSickness: boolean;
}

export interface FilteredPlayerState {
  index: number;
  position: PlayerPosition;
  life: number;
  commander: string;
  battlefield: string[];
  battlefieldPermanents?: Array<{ name: string; tapped: boolean }>;
  creatures: CreaturePermanent[];
  graveyard: string[];
  exile: string[];
  libraryCount: number;
  handCount: number;
  hand?: string[];
  isHuman: boolean;
}

export interface FilteredGameState {
  sessionId?: string;
  stateVersion?: number;
  turn: number;
  phase: string;
  phaseStep: string;
  playerIndex: number;
  startingPlayerIndex: number;
  players: FilteredPlayerState[];
}

export interface WaitingContext {
  type: string;
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
  pendingDecision: PendingDecision | null;
  gameLog: string[];
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

export function useGameSession(sessionId: string | null): UseGameSessionReturn {
  const [gameState, setGameState] = useState<FilteredGameState | null>(null);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const [gameLog, setGameLog] = useState<string[]>([]);
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
    setPendingDecision(null);
    setGameLog([]);
    setIsConnected(false);
    setGameOver(null);
    setStateOutOfSyncMessage(null);

    if (!sessionId) return;

    const ws = new WebSocket(`${GAME_WS_URL}/game/${sessionId}`);
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
        case "state_update":
          setGameState(msg.state as FilteredGameState);
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
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId]);

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

  const synchronizedPendingDecision = isPendingDecisionForState(pendingDecision, gameState)
    ? pendingDecision
    : null;

  return {
    gameState,
    pendingDecision: synchronizedPendingDecision,
    gameLog,
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
