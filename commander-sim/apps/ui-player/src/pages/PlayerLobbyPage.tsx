import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SeatId } from "../../../../packages/game-state/src/session";

const GAME_SERVER_URL = (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ?? "http://localhost:5300";
const GAME_WS_URL = GAME_SERVER_URL.replace(/^http/, "ws");
const PLAYER_LOBBY_KEY = "player_lobby_credentials";
const PLAYER_GAME_KEY = "player_game_connection";

interface DbDeck {
  id: number;
  name: string | null;
  commander: string | null;
  cardCount?: number | null;
}

interface LobbyDeckPublic {
  id: string;
  name: string;
  commanderName: string;
  commanderImage?: string;
  colorIdentity?: string[];
  cardCount: number;
}

type LobbySeat =
  | { type: "empty"; seatId: SeatId }
  | { type: "human"; seatId: SeatId; playerId: string; deckId?: string; ready: boolean; connectionStatus: "connected" | "disconnected"; deck?: LobbyDeckPublic }
  | { type: "ai"; seatId: SeatId; aiAgentId?: string; deckId?: string; deck?: LobbyDeckPublic };

interface LobbySnapshot {
  id: string;
  code: string;
  status: "lobby" | "running";
  revision: number;
  runningSessionId?: string;
  seats: LobbySeat[];
}

interface PlayerCredentials {
  lobbyId: string;
  playerId: string;
  seatId: SeatId;
  playerToken: string;
}

function readStoredCredentials(): PlayerCredentials | null {
  try {
    const raw = localStorage.getItem(PLAYER_LOBBY_KEY);
    return raw ? (JSON.parse(raw) as PlayerCredentials) : null;
  } catch {
    return null;
  }
}

function seatLabel(seatId: SeatId): string {
  return {
    northWest: "NORTH",
    northEast: "EAST",
    southEast: "SOUTH",
    southWest: "WEST",
  }[seatId];
}

export default function PlayerLobbyPage() {
  const navigate = useNavigate();
  const [lobbyCode, setLobbyCode] = useState("");
  const [credentials, setCredentials] = useState<PlayerCredentials | null>(readStoredCredentials);
  const [lobby, setLobby] = useState<LobbySnapshot | null>(null);
  const [decks, setDecks] = useState<DbDeck[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mySeat = useMemo(() => {
    if (!lobby || !credentials) return null;
    return lobby.seats.find((seat) => seat.type === "human" && seat.playerId === credentials.playerId) ?? null;
  }, [credentials, lobby]);

  const enterStartedMatch = useCallback((sessionId: string, activeCredentials: PlayerCredentials) => {
    localStorage.setItem(PLAYER_GAME_KEY, JSON.stringify({
      sessionId,
      lobbyId: activeCredentials.lobbyId,
      playerId: activeCredentials.playerId,
      seatId: activeCredentials.seatId,
      playerToken: activeCredentials.playerToken,
      role: "player",
    }));
    navigate(`/game?session=${sessionId}`, { replace: true });
  }, [navigate]);

  useEffect(() => {
    fetch(`${GAME_SERVER_URL}/game/decks`)
      .then((r) => r.json())
      .then((data: { decks?: DbDeck[] }) => setDecks(data.decks ?? []))
      .catch(() => setDecks([]));
  }, []);

  useEffect(() => {
    if (!credentials) return;
    const params = new URLSearchParams({
      playerId: credentials.playerId,
      playerToken: credentials.playerToken,
    });
    const ws = new WebSocket(`${GAME_WS_URL}/lobby/${credentials.lobbyId}?${params.toString()}`);
    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "LOBBY_SNAPSHOT" || msg.type === "LOBBY_UPDATED" || msg.type === "MATCH_STARTED") {
        const nextLobby = msg.lobby as LobbySnapshot | undefined;
        if (nextLobby) {
          setLobby(nextLobby);
          if (nextLobby.status === "running" && nextLobby.runningSessionId) {
            enterStartedMatch(nextLobby.runningSessionId, credentials);
          }
        }
      }
      if (msg.type === "MATCH_STARTED" && typeof msg.sessionId === "string") {
        enterStartedMatch(msg.sessionId, credentials);
      }
    };
    ws.onerror = () => setError("Lobby connection failed.");
    return () => ws.close();
  }, [credentials, enterStartedMatch]);

  const join = useCallback(async () => {
    const code = lobbyCode.trim().toUpperCase();
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${GAME_SERVER_URL}/lobby/${encodeURIComponent(code)}/join-human`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials?.lobbyId === code ? credentials : {}),
      });
      const data = (await response.json()) as PlayerCredentials & { lobby?: LobbySnapshot; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not join lobby.");
      const nextCredentials = {
        lobbyId: data.lobbyId,
        playerId: data.playerId,
        seatId: data.seatId,
        playerToken: data.playerToken,
      };
      localStorage.setItem(PLAYER_LOBBY_KEY, JSON.stringify(nextCredentials));
      setCredentials(nextCredentials);
      setLobby(data.lobby ?? null);
      setLobbyCode(data.lobby?.code ?? code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [credentials, lobbyCode]);

  const updateDeck = useCallback(async (deckId: string) => {
    if (!credentials) return;
    setSelectedDeckId(deckId);
    if (!deckId) return;
    setError(null);
    const response = await fetch(`${GAME_SERVER_URL}/lobby/${credentials.lobbyId}/update-player-deck`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credentials, deckId }),
    });
    const data = (await response.json().catch(() => null)) as { lobby?: LobbySnapshot; error?: string } | null;
    if (!response.ok) {
      setError(data?.error ?? "Could not update deck.");
      return;
    }
    if (data?.lobby) setLobby(data.lobby);
  }, [credentials]);

  const setReady = useCallback(async (ready: boolean) => {
    if (!credentials) return;
    setError(null);
    const response = await fetch(`${GAME_SERVER_URL}/lobby/${credentials.lobbyId}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credentials, ready }),
    });
    const data = (await response.json().catch(() => null)) as { lobby?: LobbySnapshot; error?: string } | null;
    if (!response.ok) {
      setError(data?.error ?? "Could not update ready state.");
      return;
    }
    if (data?.lobby) setLobby(data.lobby);
  }, [credentials]);

  const leave = useCallback(async () => {
    if (!credentials) return;
    await fetch(`${GAME_SERVER_URL}/lobby/${credentials.lobbyId}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    }).catch(() => {});
    localStorage.removeItem(PLAYER_LOBBY_KEY);
    localStorage.removeItem(PLAYER_GAME_KEY);
    setCredentials(null);
    setLobby(null);
    setSelectedDeckId("");
  }, [credentials]);

  const selectedDeck = decks.find((deck) => String(deck.id) === selectedDeckId);
  const displayDeck = mySeat?.type === "human" ? mySeat.deck : null;
  const ready = mySeat?.type === "human" ? mySeat.ready : false;
  const joinedCode = lobby?.code ?? lobby?.id ?? credentials?.lobbyId;

  return (
    <div className="min-h-screen bg-[#0f1218] px-4 py-8 text-white">
      <div className="mx-auto w-[min(760px,100%)] border border-slate-700 bg-[#171b24] p-6 shadow-2xl">
        <div className="mb-6">
          <div className="text-xs font-bold uppercase tracking-[0.22em] text-cyan-300">Commander</div>
          <h1 className="mt-2 text-3xl font-bold">Join a Table</h1>
        </div>

        {!credentials && (
          <div className="grid gap-3">
            <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Lobby Code</label>
            <input
              value={lobbyCode}
              onChange={(event) => setLobbyCode(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void join(); }}
              placeholder="7K2M-F9"
              className="border border-slate-600 bg-slate-950 px-4 py-3 text-lg uppercase tracking-[0.16em] outline-none focus:border-cyan-400"
            />
            <button
              type="button"
              onClick={() => void join()}
              disabled={busy}
              className="w-fit bg-cyan-600 px-7 py-3 text-sm font-bold uppercase tracking-[0.14em] hover:bg-cyan-500 disabled:opacity-50"
            >
              Join
            </button>
          </div>
        )}

        {credentials && (
          <div className="space-y-5">
            <div className="border border-emerald-500/30 bg-emerald-950/20 p-4">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">Connected to Table {joinedCode}</div>
              <div className="mt-2 text-sm text-slate-300">Seat: {seatLabel(credentials.seatId)}</div>
              <div className="text-sm text-slate-300">Player: {credentials.playerId}</div>
            </div>

            <div className="border border-slate-700 bg-slate-950/50 p-4">
              <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Your Deck</div>
              <select
                value={selectedDeckId || (mySeat?.type === "human" ? mySeat.deckId ?? "" : "")}
                onChange={(event) => void updateDeck(event.target.value)}
                disabled={ready}
                className="w-full border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
              >
                <option value="">Select a deck</option>
                {decks.map((deck) => (
                  <option key={deck.id} value={deck.id}>
                    {deck.name ?? deck.commander ?? `Deck #${deck.id}`}
                    {deck.commander ? ` - ${deck.commander}` : ""}
                    {typeof deck.cardCount === "number" ? ` - ${deck.cardCount} cards` : ""}
                  </option>
                ))}
              </select>
              <div className="mt-4 grid gap-1 text-sm text-slate-300">
                <div>Commander: {displayDeck?.commanderName ?? selectedDeck?.commander ?? "None selected"}</div>
                <div>{displayDeck?.cardCount ?? selectedDeck?.cardCount ?? 0} cards</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void setReady(!ready)}
                disabled={!mySeat || mySeat.type !== "human" || !mySeat.deckId}
                className="bg-blue-600 px-7 py-3 text-sm font-bold uppercase tracking-[0.14em] hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {ready ? "Not Ready" : "Ready"}
              </button>
              <button
                type="button"
                onClick={() => void leave()}
                className="border border-slate-600 px-4 py-3 text-sm font-semibold text-slate-300 hover:border-slate-400 hover:text-white"
              >
                Leave
              </button>
              <span className="text-sm text-slate-400">
                {ready ? "Ready. Waiting for host to start match..." : "Choose a deck, then ready up."}
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-5 border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-100">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
