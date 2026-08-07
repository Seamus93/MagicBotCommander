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

const GAME_SERVER_URL = (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ?? "http://localhost:5300";

interface DbDeck {
  id: number;
  name: string | null;
  commander: string | null;
  cardCount?: number | null;
  metadataCount?: number | null;
}

function GameLobby({ onStart }: { onStart: (humanDeckId: number | null, aiDeckIds: number[]) => void }) {
  const [dbDecks, setDbDecks] = useState<DbDeck[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [aiSelections, setAiSelections] = useState<[number | null, number | null, number | null]>([null, null, null]);
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

  const setSlot = (i: 0 | 1 | 2, id: number | null) =>
    setAiSelections((prev) => { const n = [...prev] as typeof prev; n[i] = id; return n; });

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
      setAiSelections((prev) => prev.map((id) => (id === deck.id ? null : id)) as typeof prev);
      if (deck.id === myDeckId) {
        localStorage.removeItem("savedDeckId");
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Errore cancellazione deck");
    } finally {
      setDeletingId(null);
    }
  };

  const aiLabels = ["AI Nord", "AI Est", "AI Ovest"];
  const aiColors = ["text-red-400", "text-emerald-400", "text-violet-400"];

  return (
    <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
      <div className="w-[min(560px,92%)] bg-gray-800 border border-gray-700 rounded-2xl p-6 shadow-2xl">
        <h1 className="text-lg font-bold mb-1">Nuova Partita — 1 vs 3 AI</h1>
        <p className="text-gray-500 text-sm mb-4">Il tuo mazzo viene caricato da MoxfieldUI. Scegli i mazzi per le 3 AI.</p>

        {/* Human deck info */}
        <div className="mb-4 p-3 rounded-lg bg-blue-900/30 border border-blue-500/30 text-sm">
          <span className="text-blue-400 font-semibold">Tu: </span>
          {myDeckId
            ? <span className="text-white">{myCommander ?? `Deck #${myDeckId}`}</span>
            : <span className="text-gray-500 italic">Nessun mazzo caricato (verrà usato il Default)</span>}
        </div>

        {/* AI deck selectors */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-500">Mazzi AI</span>
          <button onClick={fetchDecks} className="text-xs text-blue-400 hover:text-blue-300">
            ↺ Ricarica mazzi
          </button>
        </div>
        {loading ? (
          <div className="text-gray-500 text-sm py-3">Caricamento mazzi...</div>
        ) : (
          <div className="space-y-3 mb-5">
            {aiLabels.map((label, i) => (
              <div key={label} className="flex items-center gap-3">
                <span className={`text-xs font-semibold w-20 ${aiColors[i]}`}>{label}</span>
                <select
                  className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white"
                  value={aiSelections[i] ?? ""}
                  onChange={(e) => setSlot(i as 0 | 1 | 2, e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Default (Mazzo Base)</option>
                  {dbDecks.map((d) => {
                    const isMyDeck = d.id === myDeckId;
                    const displayCommander = d.commander ?? (isMyDeck ? myCommander : null);
                    const displayName = d.name ?? (isMyDeck && myCommander ? myCommander : `Deck #${d.id}`);
                    return (
                      <option key={d.id} value={d.id}>
                        {isMyDeck ? "★ " : ""}{displayName}
                        {displayCommander && displayCommander !== displayName ? ` — ${displayCommander}` : ""}
                        {typeof d.cardCount === "number" ? ` · ${d.cardCount} carte` : ""}
                        {isMyDeck ? " (Il tuo mazzo)" : ""}
                      </option>
                    );
                  })}
                </select>
              </div>
            ))}
          </div>
        )}

        {!loading && dbDecks.length > 0 && (
          <div className="mb-5 max-h-36 overflow-auto rounded-lg border border-gray-700 bg-gray-900/70 p-2">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Gestione DB</div>
            {deleteError && <div className="mb-2 text-xs text-red-300">{deleteError}</div>}
            <div className="space-y-1">
              {dbDecks.map((deck) => {
                const label = deck.name ?? deck.commander ?? `Deck #${deck.id}`;
                return (
                  <div key={deck.id} className="flex items-center justify-between gap-2 rounded bg-gray-800/70 px-2 py-1 text-xs">
                    <span className="min-w-0 truncate">
                      #{deck.id} {label}
                      {typeof deck.cardCount === "number" ? ` · ${deck.cardCount} carte` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => deleteDeck(deck)}
                      disabled={deletingId === deck.id}
                      className="shrink-0 rounded border border-red-800/70 px-2 py-0.5 text-red-300 hover:bg-red-950 disabled:opacity-50"
                    >
                      {deletingId === deck.id ? "..." : "Elimina"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={() => onStart(myDeckId, aiSelections.filter((id): id is number => id !== null))}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg"
          >
            Inizia Partita
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
  } = useGameSession(sessionId);

  const startGame = (humanDeckId: number | null, aiDeckIds: number[]) => {
    if (creating) return;
    setCreating(true);
    setLobbyDone(true);
    const body: Record<string, unknown> = {};
    if (humanDeckId) body.humanDeckId = humanDeckId;
    if (aiDeckIds.length) body.aiDeckIds = aiDeckIds;
    fetch(`${GAME_SERVER_URL}/game/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((data: { sessionId: string }) => {
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
  const humanPlayer = players.find((p) => p.isHuman);
  const northPlayer = players.find((p) => p.index === 1);
  const eastPlayer = players.find((p) => p.index === 2);
  const westPlayer = players.find((p) => p.index === 3);

  // Combat-related decision types
  const isCombatDecision =
    pendingDecision?.decisionType === "target" ||
    pendingDecision?.decisionType === "attack_plan" ||
    pendingDecision?.decisionType === "block_plan";

  const isMulliganDecision = pendingDecision?.decisionType === "mulligan";

  useEffect(() => {
    void publishSharedGameSession(sessionId, "game-table").catch(() => {
      // Shared session bridge is optional.
    });
  }, [sessionId]);

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
          onClick={concede}
          className="text-xs px-3 py-1 bg-red-800 hover:bg-red-700 text-red-200 rounded"
        >
          Concede
        </button>
      </div>

      {/* Game over overlay */}
      {gameOver && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-yellow-600 rounded-xl p-8 text-center">
            <div className="text-3xl font-bold text-white mb-2">
              {gameOver.winner === 0 ? "🏆 You Win!" : gameOver.winner === null ? "Draw" : `Player ${gameOver.winner} Wins`}
            </div>
            <div className="text-gray-400 mb-4 text-sm">
              {gameOver.winner === 0 ? "Congratulations!" : gameOver.winner === null ? "No winner determined." : "Better luck next time!"}
            </div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => { setSessionId(null); setLobbyDone(false); navigate("/game", { replace: true }); }}
                className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded"
              >
                New Game
              </button>
              <button
                onClick={() => navigate("/")}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
              >
                Home
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
      {isMulliganDecision && (
        <MulliganPanel pendingDecision={pendingDecision} onMulligan={submitMulligan} />
      )}

      {/* Combat overlays */}
      {isCombatDecision && (
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
              {pendingDecision && !isCombatDecision && !isMulliganDecision && (
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
