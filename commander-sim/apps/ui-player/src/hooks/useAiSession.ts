import { useEffect, useRef, useState } from "react";
import type { FilteredGameState, FilteredPlayerState } from "./useGameSession";

const GAME_SERVER_URL =
  (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ??
  "http://localhost:5300";
const GAME_WS_URL = GAME_SERVER_URL.replace(/^http/, "ws");

export interface AiSessionState {
  sessionId: string | null;
  aiPlayers: FilteredPlayerState[]; // index 1,2,3
  gameLog: string[];
  isConnected: boolean;
  gameOver: { winner: number | null } | null;
  turn: number;
  phase: string;
  phaseStep: string;
  activePlayer: number;
}

/**
 * Read-only hook that discovers an active game session and connects
 * via WebSocket to receive AI player state updates.
 */
export function useAiSession(deckIds?: number[], resetKey = 0): AiSessionState {
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem("spelltable_ai_session") ?? null
  );
  const [aiPlayers, setAiPlayers] = useState<FilteredPlayerState[]>([]);
  const [gameLog, setGameLog] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [gameOver, setGameOver] = useState<{ winner: number | null } | null>(null);
  const [turn, setTurn] = useState(0);
  const [phase, setPhase] = useState("");
  const [phaseStep, setPhaseStep] = useState("");
  const [activePlayer, setActivePlayer] = useState(-1);
  const wsRef = useRef<WebSocket | null>(null);
  const prevResetKeyRef = useRef(resetKey);

  // Find existing AI session or create a new one
  // When deckIds is undefined, the hook is disabled (game not started yet)
  const enabled = deckIds !== undefined;

  // Reset display state when game is disabled (New Game clicked), so the
  // next session starts with a clean slate (no stale game-over overlay, etc.)
  const prevEnabledRef = useRef(enabled);
  useEffect(() => {
    if (prevEnabledRef.current && !enabled) {
      setSessionId(null);
      setAiPlayers([]);
      setGameLog([]);
      setGameOver(null);
      setTurn(0);
      setPhase("");
      setPhaseStep("");
      setActivePlayer(-1);
    }
    prevEnabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (prevResetKeyRef.current === resetKey) return;

    prevResetKeyRef.current = resetKey;

    sessionStorage.removeItem("spelltable_ai_session");
    wsRef.current?.close();
    wsRef.current = null;
    setSessionId(null);
    setAiPlayers([]);
    setGameLog([]);
    setGameOver(null);
    setTurn(0);
    setPhase("");
    setPhaseStep("");
    setActivePlayer(-1);
    setIsConnected(false);
  }, [enabled, resetKey]);

  useEffect(() => {
    if (!enabled) return;
    if (sessionId) return;

    let active = true;

    const createNew = async () => {
      try {
        const createRes = await fetch(`${GAME_SERVER_URL}/game/create-ai-only`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(deckIds?.length ? { deckIds } : {}),
        });
        const createData = (await createRes.json()) as { sessionId: string };
        if (active) {
          sessionStorage.setItem("spelltable_ai_session", createData.sessionId);
          setSessionId(createData.sessionId);
        }
      } catch {
        // game server not reachable, retry
        if (active) setTimeout(createNew, 3000);
      }
    };

    void createNew();
    return () => { active = false; };
  }, [sessionId, enabled, deckIds, resetKey]);

  // WebSocket connection
  useEffect(() => {
    if (!sessionId) return;

    let intentionalClose = false;
    const ws = new WebSocket(`${GAME_WS_URL}/game/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => {
      setIsConnected(false);
      // If WE closed it (unmount/refresh), keep sessionStorage intact so the
      // session can be resumed on reload. Only clean up on unexpected server-side close.
      if (intentionalClose) return;
      sessionStorage.removeItem("spelltable_ai_session");
      setTimeout(() => {
        setSessionId(null);
        setAiPlayers([]);
        setGameOver(null);
        setGameLog([]);
      }, 3000);
    };

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (msg.type) {
        case "state_update": {
          const state = msg.state as FilteredGameState;
          // Extract only AI players (index 1, 2, 3)
          setAiPlayers(state.players.filter((p) => !p.isHuman));
          setTurn(state.turn);
          setPhase(state.phase);
          setPhaseStep(state.phaseStep);
          setActivePlayer(state.playerIndex);
          break;
        }
        case "game_over":
          setGameOver({ winner: msg.winner as number | null });
          break;
        case "game_log":
          setGameLog((prev) => [...prev.slice(-199), msg.message as string]);
          break;
        // Ignore waiting_for_human — viewer only
      }
    };

    return () => {
      intentionalClose = true;
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  return {
    sessionId,
    aiPlayers,
    gameLog,
    isConnected,
    gameOver,
    turn,
    phase,
    phaseStep,
    activePlayer,
  };
}
