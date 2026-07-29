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
  submitAction: (action: unknown) => void;
  submitAttackPlan: (plan: unknown) => void;
  submitBlockPlan: (plan: unknown) => void;
  submitMulligan: (keep: boolean, bottomCards?: string[]) => void;
  submitTarget: (targetIndex: number) => void;
  submitResponse: (action: unknown) => void;
  concede: () => void;
}

export function useGameSession(sessionId: string | null): UseGameSessionReturn {
  const [gameState, setGameState] = useState<FilteredGameState | null>(null);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const [gameLog, setGameLog] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [gameOver, setGameOver] = useState<GameOverInfo | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setGameState(null);
    setPendingDecision(null);
    setGameLog([]);
    setIsConnected(false);
    setGameOver(null);

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
          break;
        case "waiting_for_human":
          setPendingDecision({
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

  const send = useCallback((data: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      setPendingDecision(null);
    }
  }, []);

  const submitAction = useCallback((action: unknown) => {
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

  return {
    gameState,
    pendingDecision,
    gameLog,
    isConnected,
    gameOver,
    submitAction,
    submitAttackPlan,
    submitBlockPlan,
    submitMulligan,
    submitTarget,
    submitResponse,
    concede,
  };
}
