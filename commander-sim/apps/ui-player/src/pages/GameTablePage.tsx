import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useGameSession } from "../hooks/useGameSession";
import { useViewerState } from "../hooks/useViewerState";
import TableLayout from "../components/game/TableLayout";
import PlayerSeat from "../components/game/PlayerSeat";
import ActionPanel from "../components/game/ActionPanel";
import CombatPanel from "../components/game/CombatPanel";
import MulliganPanel from "../components/game/MulliganPanel";
import PhaseTracker from "../components/game/PhaseTracker";
import GameLog from "../components/game/GameLog";
import { publishSharedGameSession } from "../hooks/useSharedGameSession";
import type { ConnectionRole, SeatId } from "../../../../packages/game-state/src/session";

const GAME_SERVER_URL = (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ?? "http://localhost:5300";
const TABLE_CLIENT_URL = (import.meta.env.VITE_TABLE_CLIENT_URL as string | undefined) ?? "http://localhost:5174";
const PLAYER_GAME_KEY = "player_game_connection";
const SEAT_IDS: SeatId[] = ["northWest", "northEast", "southEast", "southWest"];
const SEAT_LABELS = ["NORTH", "EAST", "SOUTH", "WEST"] as const;

type LobbyController = "human" | "ai" | null;

interface LobbySeat {
  controller: LobbyController;
  deckId: number | null;
}

interface StartOptions {
  humanDeckId: number | null;
  aiDeckIds: number[];
  seats: LobbySeat[];
  debugMode: boolean;
  spectateAllAi: boolean;
}

interface ViewerConnection {
  role: ConnectionRole;
  seatId?: SeatId;
  playerId?: string;
  playerToken?: string;
}

function getStoredPlayerConnection(sessionId: string | null): ViewerConnection | null {
  try {
    const raw = localStorage.getItem(PLAYER_GAME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ViewerConnection> & { sessionId?: string };
    if (parsed.sessionId !== sessionId) return null;
    if (parsed.role !== "player" || !parsed.seatId || !parsed.playerId || !parsed.playerToken) return null;
    return {
      role: "player",
      seatId: parsed.seatId,
      playerId: parsed.playerId,
      playerToken: parsed.playerToken,
    };
  } catch {
    return null;
  }
}

function tableReturnUrl(sessionId: string | null, action?: "new-match") {
  const url = new URL(TABLE_CLIENT_URL);
  if (sessionId) url.searchParams.set("session", sessionId);
  if (action) url.searchParams.set("action", action);
  return url.toString();
}

function navigateToTable(sessionId: string | null, action?: "new-match") {
  const url = tableReturnUrl(sessionId, action);
  try {
    window.opener?.postMessage({ type: "COMMANDER_RETURN_TO_TABLE", sessionId, action }, TABLE_CLIENT_URL);
    window.opener?.focus();
  } catch {
    // Browser focus/window control is best effort only.
  }
  window.location.assign(url);
}

interface PlayerCredentialResponse {
  seatId: SeatId;
  playerId: string;
  playerToken: string;
}

interface DbDeck {
  id: number;
  name: string | null;
  commander: string | null;
  cardCount?: number | null;
  metadataCount?: number | null;
}

function GameLobby({ onStart }: { onStart: (options: StartOptions) => void }) {
  const [dbDecks, setDbDecks] = useState<DbDeck[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [seats, setSeats] = useState<LobbySeat[]>([
    { controller: "human", deckId: null },
    { controller: null, deckId: null },
    { controller: null, deckId: null },
    { controller: null, deckId: null },
  ]);
  const [debugMode, setDebugMode] = useState(false);
  const [spectateAllAi, setSpectateAllAi] = useState(false);
  const viewerState = useViewerState(1500);

  const savedDeckIdRaw = localStorage.getItem("savedDeckId");
  const myDeckId = (() => {
    const n = Number(savedDeckIdRaw);
    return savedDeckIdRaw && Number.isFinite(n) && n > 0 ? n : null;
  })();
  const myCommander = viewerState?.commander ?? viewerState?.commandZone?.[0] ?? null;

  const fetchDecks = useCallback(() => {
    setLoading(true);
    fetch(`${GAME_SERVER_URL}/game/decks`)
      .then((r) => r.json())
      .then((d: { decks: DbDeck[] }) => { setDbDecks(d.decks); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchDecks();
    window.addEventListener("focus", fetchDecks);
    return () => window.removeEventListener("focus", fetchDecks);
  }, [fetchDecks]);

  const deleteDeck = async (deck: DbDeck) => {
    const label = deck.name ?? deck.commander ?? `Deck #${deck.id}`;
    if (!window.confirm(`Eliminare "${label}" dal database?`)) return;
    setDeletingId(deck.id);
    setDeleteError(null);
    try {
      const response = await fetch(`${GAME_SERVER_URL}/game/decks/${deck.id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? "Impossibile eliminare il deck.");
      }
      setDbDecks((prev) => prev.filter((item) => item.id !== deck.id));
      setSeats((prev) => prev.map((seat) => ({
        ...seat,
        deckId: seat.deckId === deck.id ? null : seat.deckId,
      })));
      if (deck.id === myDeckId) {
        localStorage.removeItem("savedDeckId");
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Errore cancellazione deck");
    } finally {
      setDeletingId(null);
    }
  };

  const displayedSeats = spectateAllAi
    ? seats.map((seat) => ({ ...seat, controller: "ai" as const }))
    : seats;
  const humanCount = displayedSeats.filter((seat) => seat.controller === "human").length;
  const aiCount = displayedSeats.filter((seat) => seat.controller === "ai").length;
  const validSeatCount = humanCount + aiCount;
  const canStart = validSeatCount === 4;

  const updateSeat = (index: number, patch: Partial<LobbySeat>) => {
    setSeats((prev) => prev.map((seat, seatIndex) =>
      seatIndex === index ? { ...seat, ...patch } : seat
    ));
  };

  const deckOptionLabel = (deck: DbDeck) => {
    const isMyDeck = deck.id === myDeckId;
    const displayCommander = deck.commander ?? (isMyDeck ? myCommander : null);
    const displayName = deck.name ?? (isMyDeck && myCommander ? myCommander : `Deck #${deck.id}`);
    return `${isMyDeck ? "★ " : ""}${displayName}${displayCommander && displayCommander !== displayName ? ` - ${displayCommander}` : ""}${typeof deck.cardCount === "number" ? ` · ${deck.cardCount} carte` : ""}${isMyDeck ? " (Il tuo mazzo)" : ""}`;
  };

  const start = () => {
    if (!canStart) return;
    const nextSeats = spectateAllAi
      ? seats.map((seat) => ({ ...seat, controller: "ai" as const }))
      : seats;
    onStart({
      humanDeckId: myDeckId,
      aiDeckIds: nextSeats
        .filter((seat) => seat.controller === "ai" && seat.deckId !== null)
        .map((seat) => seat.deckId as number),
      seats: nextSeats,
      debugMode,
      spectateAllAi,
    });
  };

  return (
    <div className="flex h-screen items-center justify-center bg-[#111318] px-4 text-white">
      <div className="w-[min(980px,96vw)] border border-gray-700 bg-[#1a1d24] p-6 shadow-2xl">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-wide">NEW COMMANDER MATCH</h1>
            <div className="mt-1 text-xs uppercase tracking-[0.18em] text-gray-500">
              Lobby 7K2M <span className="mx-2 text-gray-700">|</span>
              <span className="text-emerald-300">●</span> {humanCount}/4 players
            </div>
          </div>
          <button onClick={fetchDecks} className="border border-gray-600 px-3 py-2 text-xs text-gray-300 hover:border-gray-500 hover:text-white">
            Ricarica mazzi
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          {displayedSeats.map((seat, index) => {
            const isHost = index === 0;
            const isHuman = seat.controller === "human";
            const isAi = seat.controller === "ai";
            const canEdit = !spectateAllAi && !isHost;
            return (
              <div key={SEAT_IDS[index]} className="min-h-[220px] border border-gray-700 bg-[#11151d] p-4">
                <div className="mb-4 flex items-center justify-between text-xs font-semibold tracking-[0.16em] text-gray-400">
                  <span>{isHost && !spectateAllAi ? "HOST" : SEAT_LABELS[index]}</span>
                  <span className={isHuman ? "text-emerald-300" : isAi ? "text-cyan-300" : "text-gray-600"}>
                    {isHuman ? "HUMAN ●" : isAi ? "AI" : "EMPTY"}
                  </span>
                </div>
                <div className="flex h-16 items-center justify-center text-center">
                  {isHuman && (
                    <div>
                      <div className="text-sm font-semibold text-white">
                        {isHost ? "YOU" : `Player ${index + 1}`}
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {isHost && myDeckId ? myCommander ?? `Deck #${myDeckId}` : "Commander Deck"}
                      </div>
                    </div>
                  )}
                  {isAi && (
                    <div>
                      <div className="text-2xl font-bold text-cyan-200">AI</div>
                      <div className="mt-1 text-xs text-gray-500">Commander Deck</div>
                    </div>
                  )}
                  {!seat.controller && (
                    <div>
                      <div className="text-4xl font-light text-gray-500">+</div>
                      <div className="mt-1 text-xs font-semibold text-gray-400">ADD AI</div>
                      <div className="mt-1 text-xs text-gray-600">Empty Seat</div>
                    </div>
                  )}
                </div>

                {canEdit && (
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => updateSeat(index, { controller: "ai" })}
                      className={`border px-2 py-2 text-xs font-semibold ${isAi ? "border-cyan-500 bg-cyan-950/50 text-cyan-100" : "border-gray-700 text-gray-300 hover:border-gray-500"}`}
                    >
                      + AI Player
                    </button>
                    <button
                      type="button"
                      onClick={() => updateSeat(index, { controller: null, deckId: null })}
                      className={`border px-2 py-2 text-xs font-semibold ${!seat.controller ? "border-gray-500 bg-gray-800 text-white" : "border-gray-700 text-gray-300 hover:border-gray-500"}`}
                    >
                      Empty
                    </button>
                  </div>
                )}

                {isAi && (
                  <div className="mt-4">
                    <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-gray-500">
                      Deck
                    </label>
                    {loading ? (
                      <div className="border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-500">Caricamento...</div>
                    ) : (
                      <select
                        className="w-full border border-gray-700 bg-gray-950 px-3 py-2 text-xs text-white"
                        value={seat.deckId ?? ""}
                        onChange={(e) => updateSeat(index, { deckId: e.target.value ? Number(e.target.value) : null })}
                      >
                        <option value="">Default deck</option>
                        {dbDecks.map((deck) => (
                          <option key={deck.id} value={deck.id}>{deckOptionLabel(deck)}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-5 border border-gray-700 bg-[#11151d] p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Match Options</div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex cursor-pointer gap-3 border border-gray-800 bg-black/20 p-3">
              <input
                type="checkbox"
                checked={debugMode}
                onChange={(e) => setDebugMode(e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-semibold text-white">Debug Mode</span>
                <span className="text-xs text-gray-500">Reveal hands · Engine controls · Logs · AI state</span>
              </span>
            </label>
            <label className="flex cursor-pointer gap-3 border border-gray-800 bg-black/20 p-3">
              <input
                type="checkbox"
                checked={spectateAllAi}
                onChange={(e) => setSpectateAllAi(e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-semibold text-white">Spectate All-AI Match</span>
                <span className="text-xs text-gray-500">Replace players with four AI. You join as spectator.</span>
              </span>
            </label>
          </div>
        </div>

        {myDeckId === null && !spectateAllAi && (
          <div className="mt-3 border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            Nessun mazzo umano caricato: il server usera il deck default.
          </div>
        )}
        {!canStart && (
          <div className="mt-3 border border-gray-700 bg-black/20 px-3 py-2 text-xs text-gray-400">
            Completa i 4 seat aggiungendo AI o attendendo altri player.
          </div>
        )}

        {!loading && dbDecks.length > 0 && (
          <div className="mt-4 max-h-28 overflow-auto border border-gray-700 bg-gray-950/70 p-2">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Gestione DB</div>
            {deleteError && <div className="mb-2 text-xs text-red-300">{deleteError}</div>}
            <div className="space-y-1">
              {dbDecks.map((deck) => {
                const label = deck.name ?? deck.commander ?? `Deck #${deck.id}`;
                return (
                  <div key={deck.id} className="flex items-center justify-between gap-2 bg-gray-900/80 px-2 py-1 text-xs">
                    <span className="min-w-0 truncate">
                      #{deck.id} {label}
                      {typeof deck.cardCount === "number" ? ` · ${deck.cardCount} carte` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => deleteDeck(deck)}
                      disabled={deletingId === deck.id}
                      className="shrink-0 border border-red-800/70 px-2 py-0.5 text-red-300 hover:bg-red-950 disabled:opacity-50"
                    >
                      {deletingId === deck.id ? "..." : "Elimina"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs uppercase tracking-[0.16em] text-gray-400">
            {humanCount} Human <span className="mx-2 text-gray-700">|</span>
            {aiCount} AI <span className="mx-2 text-gray-700">|</span>
            Commander
          </div>
          <button
            onClick={start}
            disabled={!canStart}
            className="bg-blue-600 px-6 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500"
          >
            START MATCH
          </button>
        </div>
      </div>
    </div>
  );
}

export default function GameTablePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string | null>(searchParams.get("session"));
  const [lobbyDone, setLobbyDone] = useState(!!searchParams.get("session"));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConcedeConfirm, setShowConcedeConfirm] = useState(false);
  const [concessionRequested, setConcessionRequested] = useState(false);
  const [viewerConnection, setViewerConnection] = useState<ViewerConnection>(() =>
    getStoredPlayerConnection(searchParams.get("session")) ?? { role: "debug" }
  );

  const {
    gameState,
    pendingDecision,
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
  } = useGameSession(sessionId, viewerConnection);

  useEffect(() => {
    void publishSharedGameSession(sessionId, "game-table").catch(() => {
      // Shared session bridge is optional.
    });
  }, [sessionId]);

  const startGame = (options: StartOptions) => {
    if (creating) return;
    setCreating(true);
    setLobbyDone(true);
    const hostSeatId = SEAT_IDS[0];
    const body: Record<string, unknown> = {};
    if (options.humanDeckId) body.humanDeckId = options.humanDeckId;
    if (options.aiDeckIds.length) body.aiDeckIds = options.aiDeckIds;
    body.mode = options.debugMode ? "debug" : "game";
    if (!options.spectateAllAi) {
      body.seats = options.seats.map((seat) => ({
        controller: seat.controller ?? "ai",
        deckId: seat.deckId ?? undefined,
      }));
    }
    fetch(`${GAME_SERVER_URL}${options.spectateAllAi ? "/game/create-ai-only" : "/game/create"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((data: { sessionId: string; playerCredentials?: PlayerCredentialResponse[] }) => {
        const hostCredential = data.playerCredentials?.find((credential) => credential.seatId === hostSeatId);
        setViewerConnection(
          options.debugMode
            ? { role: "debug" }
            : options.spectateAllAi
              ? { role: "table" }
              : hostCredential
                ? {
                    role: "player",
                    seatId: hostCredential.seatId,
                    playerId: hostCredential.playerId,
                    playerToken: hostCredential.playerToken,
                  }
                : { role: "table" }
        );
        setSessionId(data.sessionId);
        navigate(`/game?session=${data.sessionId}`, { replace: true });
      })
      .catch((e: unknown) => { setError(String(e)); setLobbyDone(false); })
      .finally(() => setCreating(false));
  };

  if (!lobbyDone) {
    return <GameLobby onStart={startGame} />;
  }

  if (creating || (!sessionId && !error)) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        Creazione sessione in corso...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-white gap-4">
        <div className="text-red-400">Error: {error}</div>
        <div className="text-gray-400 text-sm">Make sure game-server is running on port 5300</div>
        <button
          onClick={() => navigate("/")}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded"
        >
          Back
        </button>
      </div>
    );
  }

  const players = gameState?.players ?? [];
  const ownPlayer = viewerConnection.role === "player"
    ? players.find((p) =>
        (viewerConnection.seatId && p.seatId === viewerConnection.seatId) ||
        (viewerConnection.playerId && p.playerId === viewerConnection.playerId)
      )
    : players.find((p) => p.isHuman);
  const humanPlayer = ownPlayer ?? players.find((p) => p.isHuman);
  const northPlayer = players.find((p) => p.index === 1);
  const eastPlayer = players.find((p) => p.index === 2);
  const westPlayer = players.find((p) => p.index === 3);
  const ownConceded = Boolean(ownPlayer && (ownPlayer.isConceded || ownPlayer.life <= 0));
  const actionsLocked = Boolean(gameOver || ownConceded || concessionRequested);
  const confirmConcede = () => {
    setConcessionRequested(true);
    setShowConcedeConfirm(false);
    concede();
  };

  // Combat-related decision types
  const isCombatDecision =
    pendingDecision?.decisionType === "target" ||
    pendingDecision?.decisionType === "attack_plan" ||
    pendingDecision?.decisionType === "block_plan";

  const isMulliganDecision = pendingDecision?.decisionType === "mulligan";

  return (
    <div className="h-screen flex flex-col bg-gray-900 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="text-gray-400 hover:text-white text-sm"
          >
            ← Back
          </button>
          <span className="text-gray-500 text-xs">Session: {sessionId?.slice(0, 12)}…</span>
          {typeof gameState?.stateVersion === "number" && (
            <span className="text-gray-500 text-xs">rev {gameState.stateVersion}</span>
          )}
          <span className={`text-xs px-1.5 py-0.5 rounded ${isConnected ? "bg-green-800 text-green-300" : "bg-red-900 text-red-400"}`}>
            {isConnected ? "Connected" : "Disconnected"}
          </span>
        </div>
        {gameState && (
          <PhaseTracker
            turn={gameState.turn}
            phase={gameState.phase}
            phaseStep={gameState.phaseStep}
            activePlayer={gameState.playerIndex}
          />
        )}
        <button
          onClick={() => setShowConcedeConfirm(true)}
          disabled={actionsLocked || viewerConnection.role !== "player"}
          className="text-xs px-3 py-1 bg-red-800 hover:bg-red-700 text-red-200 rounded disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500"
        >
          {concessionRequested && !ownConceded ? "Conceding..." : "Concede"}
        </button>
      </div>

      {showConcedeConfirm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="w-[min(420px,92vw)] bg-gray-800 border border-red-500/50 rounded-xl p-7 text-center shadow-2xl">
            <div className="text-2xl font-bold text-white mb-3">CONCEDE MATCH?</div>
            <div className="text-sm text-gray-300 mb-6">
              You will leave this game. The other players may continue playing.
            </div>
            <div className="flex justify-center gap-3">
              <button
                onClick={() => setShowConcedeConfirm(false)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
              >
                Cancel
              </button>
              <button
                onClick={confirmConcede}
                className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded"
              >
                Concede
              </button>
            </div>
          </div>
        </div>
      )}

      {ownConceded && !gameOver && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="w-[min(430px,92vw)] bg-gray-800 border border-red-500/40 rounded-xl p-8 text-center shadow-2xl">
            <div className="text-2xl font-bold text-white mb-2">CONCESSION CONFIRMED</div>
            <div className="text-gray-400 mb-5 text-sm">Your player has left the game. The table may still be running.</div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => navigateToTable(sessionId)}
                className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded"
              >
                Return to Table
              </button>
              <button
                onClick={() => navigateToTable(sessionId, "new-match")}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
              >
                New Match
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Game over overlay */}
      {gameOver && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-yellow-600 rounded-xl p-8 text-center">
            <div className="text-3xl font-bold text-white mb-2">
              Match Complete
            </div>
            <div className="text-gray-400 mb-4 text-sm">
              {gameOver.winner === ownPlayer?.index ? "You win." : gameOver.winner === null ? "No winner determined." : `Player ${gameOver.winner} wins.`}
            </div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => navigateToTable(sessionId)}
                className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded"
              >
                Return to Table
              </button>
              <button
                onClick={() => navigateToTable(sessionId, "new-match")}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
              >
                New Match
              </button>
            </div>
          </div>
        </div>
      )}

      {stateOutOfSyncMessage && (
        <div className="fixed left-1/2 top-12 z-50 -translate-x-1/2 rounded border border-red-500/40 bg-red-950/90 px-3 py-2 text-xs font-semibold text-red-100 shadow-xl">
          {stateOutOfSyncMessage}
        </div>
      )}

      {/* Mulligan modal */}
      {isMulliganDecision && !actionsLocked && (
        <MulliganPanel pendingDecision={pendingDecision} onMulligan={submitMulligan} />
      )}

      {/* Combat overlays */}
      {isCombatDecision && !actionsLocked && (
        <CombatPanel
          pendingDecision={pendingDecision}
          onAttackPlan={submitAttackPlan}
          onBlockPlan={submitBlockPlan}
          onTarget={submitTarget}
        />
      )}

      {/* Main table */}
      <div className="flex-1 overflow-hidden">
        <TableLayout
          north={
            northPlayer ? (
              <PlayerSeat player={northPlayer} />
            ) : (
              <div className="h-24 bg-gray-800 flex items-center justify-center text-gray-600 text-sm">
                Waiting for Player 1...
              </div>
            )
          }
          west={
            westPlayer ? (
              <PlayerSeat player={westPlayer} compact />
            ) : (
              <div className="h-full bg-gray-800 flex items-center justify-center text-gray-600 text-xs">
                P3
              </div>
            )
          }
          center={
            <div className="h-full flex flex-col p-2 gap-2">
              {/* Action panel for non-combat actions */}
              {pendingDecision && !actionsLocked && !isCombatDecision && !isMulliganDecision && (
                <ActionPanel
                  pendingDecision={pendingDecision}
                  onAction={submitAction}
                  onAttackPlan={submitAttackPlan}
                  onBlockPlan={submitBlockPlan}
                  onMulligan={submitMulligan}
                  onTarget={submitTarget}
                  onResponse={submitResponse}
                />
              )}
              {/* Game log */}
              <div className="flex-1 min-h-0">
                <GameLog messages={gameLog} />
              </div>
            </div>
          }
          east={
            eastPlayer ? (
              <PlayerSeat player={eastPlayer} compact />
            ) : (
              <div className="h-full bg-gray-800 flex items-center justify-center text-gray-600 text-xs">
                P2
              </div>
            )
          }
          south={
            humanPlayer ? (
              <PlayerSeat player={humanPlayer} />
            ) : (
              <div className="h-24 bg-gray-800 flex items-center justify-center text-gray-600 text-sm">
                Connecting...
              </div>
            )
          }
        />
      </div>
    </div>
  );
}
