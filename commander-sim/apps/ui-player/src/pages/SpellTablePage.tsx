/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QuadrantLayout from "../components/spelltable/QuadrantLayout";
import PlayerQuadrant from "../components/spelltable/PlayerQuadrant";
import type { QuadrantPlayerData } from "../components/spelltable/PlayerQuadrant";
import GameLog from "../components/game/GameLog";
import { useViewerState } from "../hooks/useViewerState";
import { useViewerControl } from "../hooks/useViewerControl";
import { useGameSession, type FilteredPlayerState, type PendingDecision } from "../hooks/useGameSession";
import { publishSharedGameSession } from "../hooks/useSharedGameSession";
import { sessionModeForEngineSession, type SessionMode } from "../sessionMode";
import { cardPreviewFace } from "./cardPreviewFace";
import type { SeatId } from "../../../../packages/game-state/src/session";
import sleeve from "../assets/sleeve.png";
import lobbyBgNeutral from "../assets/new-game/backgrounds/bg-neutral.png";
import lobbyBgRed from "../assets/new-game/backgrounds/bg-red.png";
import lobbyBgGreen from "../assets/new-game/backgrounds/bg-green.png";
import lobbyBgBlue from "../assets/new-game/backgrounds/bg-blue.png";
import lobbyBgGold from "../assets/new-game/backgrounds/bg-gold.png";
import lobbyPanelRed from "../assets/new-game/panels/panel-red.png";
import lobbyPanelGreen from "../assets/new-game/panels/panel-green.png";
import lobbyPanelBlue from "../assets/new-game/panels/panel-blue.png";
import lobbyPanelGold from "../assets/new-game/panels/panel-gold.png";
import lobbyCardBack from "../assets/new-game/cards/card-front.png";
import lobbyDeckBack from "../assets/new-game/cards/deck-back.png";
import manaWhite from "../assets/mana/mana-w.svg";
import manaBlue from "../assets/mana/mana-u.svg";
import manaBlack from "../assets/mana/mana-b.svg";
import manaRed from "../assets/mana/mana-r.svg";
import manaGreen from "../assets/mana/mana-g.svg";

const GAME_SERVER_URL =
  (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ??
  "http://localhost:5300";
const VIEWER_STATE_URL =
  (import.meta.env.VITE_VIEWER_STATE_URL as string | undefined) ??
  "http://localhost:3001";

const SESSION_STORAGE_ID_KEY = "spelltable_game_session";
const SESSION_STORAGE_LOBBY_ID_KEY = "spelltable_lobby_session";
const SESSION_STORAGE_HOST_TOKEN_KEY = "spelltable_lobby_host_token";
const SESSION_STORAGE_PLAYER_KEY = "spelltable_player_credentials";
const SESSION_STORAGE_SETUP_KEY = "spelltable_game_setup";
const LOG_DRAWER_WIDTH = 320;
const SIDE_PANEL_WIDTH = 260;
const MANA_ICONS = {
  W: manaWhite,
  U: manaBlue,
  B: manaBlack,
  R: manaRed,
  G: manaGreen,
} as const;
type ManaIconKey = keyof typeof MANA_ICONS;

function cardImageUrl(name: string, version: "small" | "normal" | "art_crop" = "normal", face?: "front" | "back") {
  const params = new URLSearchParams({ exact: name, format: "image", version });
  if (face) params.set("face", face);
  return `https://api.scryfall.com/cards/named?${params.toString()}`;
}

function broadcastViewerRestart() {
  return fetch(`${VIEWER_STATE_URL}/viewer-control/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restartToken: Date.now() }),
  }).catch(() => {
    // The main UI may be offline; do not block New Match.
  });
}

const TURN_STEP_SEQUENCE = [
  "Untap",
  "Upkeep",
  "Draw",
  "Precombat Main",
  "Beginning of Combat",
  "Declare Attackers",
  "Declare Blockers",
  "Combat Damage",
  "End of Combat",
  "Postcombat Main",
  "End Step",
  "Cleanup",
] as const;

type TurnStepLabel = (typeof TURN_STEP_SEQUENCE)[number];
type PlayerCounterKey =
  | "poison"
  | "energy"
  | "experience"
  | "rad"
  | "commander1"
  | "commander2"
  | "commander3"
  | "commander4";
type PlayerCounters = Record<PlayerCounterKey, number>;

const DEFAULT_PLAYER_COUNTERS: PlayerCounters = {
  poison: 0,
  energy: 0,
  experience: 0,
  rad: 0,
  commander1: 0,
  commander2: 0,
  commander3: 0,
  commander4: 0,
};

function createDefaultCounters() {
  return {
    0: { ...DEFAULT_PLAYER_COUNTERS },
    1: { ...DEFAULT_PLAYER_COUNTERS },
    2: { ...DEFAULT_PLAYER_COUNTERS },
    3: { ...DEFAULT_PLAYER_COUNTERS },
  };
}

const PLAYER_FALLBACK_LABELS: Record<number, string> = {
  0: "You",
  1: "AI 1",
  2: "AI 2",
  3: "AI 3",
};

const ACCENT = {
  human: { color: "border-blue-500", bg: "bg-blue-500/10", text: "text-blue-400" },
  north: { color: "border-red-500", bg: "bg-red-500/10", text: "text-red-400" },
  east: { color: "border-emerald-500", bg: "bg-emerald-500/10", text: "text-emerald-400" },
  south: { color: "border-amber-500", bg: "bg-amber-500/10", text: "text-amber-400" },
  west: { color: "border-violet-500", bg: "bg-violet-500/10", text: "text-violet-400" },
};

interface DbDeck {
  id: number;
  name: string | null;
  commander: string | null;
  createdAt: string;
  cardCount?: number | null;
  metadataCount?: number | null;
}

interface StoredGameSetup {
  humanDeckId: number | null;
  humanDeck?: string[] | null;
  aiDeckIds: number[];
  aiDecks?: string[][];
}

function getStoredSetup(): StoredGameSetup {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_SETUP_KEY);
    if (!raw) return { humanDeckId: null, humanDeck: null, aiDeckIds: [], aiDecks: [] };
    const parsed = JSON.parse(raw) as Partial<StoredGameSetup>;
    return {
      humanDeckId: typeof parsed.humanDeckId === "number" ? parsed.humanDeckId : null,
      humanDeck:
        Array.isArray(parsed.humanDeck)
          ? parsed.humanDeck.filter((card): card is string => typeof card === "string")
          : null,
      aiDeckIds: Array.isArray(parsed.aiDeckIds)
        ? parsed.aiDeckIds.filter((id): id is number => typeof id === "number")
        : [],
      aiDecks: Array.isArray(parsed.aiDecks)
        ? parsed.aiDecks
            .filter((deck): deck is string[] => Array.isArray(deck))
            .map((deck) => deck.filter((card): card is string => typeof card === "string"))
        : [],
    };
  } catch {
    return { humanDeckId: null, humanDeck: null, aiDeckIds: [], aiDecks: [] };
  }
}

function viewerToQuadrant(v: NonNullable<ReturnType<typeof useViewerState>>): QuadrantPlayerData {
  return {
    label: "You",
    life: v.life,
    commander: v.commander ?? v.commandZone?.[0] ?? null,
    battlefield: v.battlefield ?? [],
    graveyard: v.graveyard ?? [],
    exile: v.exile ?? [],
    commandZone: v.commandZone,
    libraryCount: v.libraryCount ?? 0,
    handCount: v.handCount ?? 0,
    hand: v.hand ?? [],
  };
}

function enginePlayerToQuadrant(p: FilteredPlayerState): QuadrantPlayerData {
  return {
    label: p.displayName ?? (p.isHuman ? "YOU" : `AI ${p.seat ?? p.position}`),
    life: p.life,
    commander: p.commander,
    commandZone: p.commandZone,
    battlefield: p.battlefield,
    battlefieldPermanents: p.battlefieldPermanents,
    creatures: p.creatures,
    graveyard: p.graveyard,
    exile: p.exile,
    libraryCount: p.libraryCount,
    handCount: p.handCount,
    hand: p.hand ?? [],
    isConceded: p.isConceded || p.life <= 0,
  };
}

export function buildSpellTablePlayers(params: {
  mode: SessionMode;
  viewerState: NonNullable<ReturnType<typeof useViewerState>> | null;
  enginePlayers: FilteredPlayerState[];
}) {
  const entries: Array<[number, QuadrantPlayerData]> = [];
  if (params.mode === "standalone") {
    if (params.viewerState) entries.push([0, viewerToQuadrant(params.viewerState)]);
    return new Map<number, QuadrantPlayerData>(entries);
  }

  for (const player of params.enginePlayers) {
    entries.push([player.index, enginePlayerToQuadrant(player)]);
  }
  return new Map<number, QuadrantPlayerData>(entries);
}

type ServerLobbySeat =
  | { type: "empty"; seatId: SeatId }
  | { type: "human"; seatId: SeatId; playerId: string; playerToken?: string; connectionId?: string; deckId?: string; ready: boolean; connectionStatus: "connected" | "disconnected"; deck?: LobbyDeckPublic }
  | { type: "ai"; seatId: SeatId; aiAgentId?: string; deckId?: string; deck?: LobbyDeckPublic };

interface LobbyDeckPublic {
  id: string;
  name: string;
  commanderName: string;
  commanderImage?: string;
  colorIdentity?: string[];
  cardCount: number;
}

interface ServerLobbySnapshot {
  id: string;
  code: string;
  status: "lobby" | "running";
  hostPlayerId: string;
  revision: number;
  mode: "game" | "debug";
  allAi: boolean;
  runningSessionId?: string;
  seats: ServerLobbySeat[];
}

interface TablePlayerCredentials {
  lobbyId: string;
  playerId: string;
  seatId: SeatId;
  playerToken: string;
}

const LOBBY_SEAT_SKINS = [
  { title: "YOU", bg: lobbyBgRed, panel: lobbyPanelRed, accent: "#ff4a3d" },
  { title: "EAST", bg: lobbyBgGreen, panel: lobbyPanelGreen, accent: "#18c486" },
  { title: "SOUTH", bg: lobbyBgGold, panel: lobbyPanelGold, accent: "#f5a623" },
  { title: "WEST", bg: lobbyBgBlue, panel: lobbyPanelBlue, accent: "#5da4ff" },
] as const;

interface ServerLobbyProps {
  lobby: ServerLobbySnapshot | null;
  hostToken: string | null;
  playerCredentials: TablePlayerCredentials | null;
  startError?: string | null;
  loading?: boolean;
  onAddAi: (seatId: SeatId, deckId: string) => void;
  onRemoveAi: (seatId: SeatId) => void;
  onSetAiDeck: (seatId: SeatId, deckId: string) => void;
  onSetHumanDeck: (deckId: string) => void;
  onSetReady: (ready: boolean) => void;
  onSetDebug: (enabled: boolean) => void;
  onSetAllAi: (enabled: boolean) => void;
  onStart: () => void;
}

interface CommanderArenaHomeProps {
  loading?: boolean;
  error?: string | null;
  onCreate: () => void;
  onJoin: (code: string) => void;
}

function CommanderArenaHome({ loading, error, onCreate, onJoin }: CommanderArenaHomeProps) {
  const [joinCode, setJoinCode] = useState("");
  const normalizedCode = joinCode.trim().toUpperCase();

  return (
    <div
      className="relative flex h-screen items-center justify-center overflow-hidden bg-[#05080b] px-4 text-white"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.24), rgba(0,0,0,.82)), url("${lobbyBgNeutral}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(255,214,143,.18),transparent_32%)]" />
      <div className="relative z-10 w-[min(520px,94vw)] rounded-[8px] border border-amber-200/28 bg-black/62 p-8 text-center shadow-[0_28px_70px_rgba(0,0,0,.62)] backdrop-blur-md">
        <div className="text-xs font-black uppercase tracking-[0.28em] text-amber-200/72">
          Magic Commander
        </div>
        <h1 className="mt-3 font-serif text-5xl font-bold text-[#ead8b8] drop-shadow-[0_3px_10px_rgba(0,0,0,.7)]">
          Play Commander
        </h1>

        {error && (
          <div className="mt-6 rounded border border-red-400/40 bg-red-950/72 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={onCreate}
          disabled={loading}
          className="mt-8 h-14 w-full rounded-[8px] border border-orange-200/70 bg-[linear-gradient(180deg,#ffb13b,#b94711)] font-serif text-xl font-bold uppercase tracking-[0.12em] text-white shadow-[0_0_24px_rgba(251,146,60,.52),0_18px_34px_rgba(0,0,0,.52)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Create Table
        </button>

        <div className="my-7 flex items-center gap-4 text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
          <div className="h-px flex-1 bg-white/12" />
          Or
          <div className="h-px flex-1 bg-white/12" />
        </div>

        <label className="mb-2 block text-left text-xs font-bold uppercase tracking-[0.18em] text-slate-300">
          Lobby Code
        </label>
        <input
          value={joinCode}
          onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && normalizedCode) onJoin(normalizedCode);
          }}
          placeholder="GZY-KB3"
          className="h-13 w-full rounded-[8px] border border-amber-200/28 bg-black/55 px-4 py-3 text-center text-xl font-black uppercase tracking-[0.2em] text-amber-100 outline-none transition focus:border-amber-200/70"
        />
        <button
          type="button"
          onClick={() => onJoin(normalizedCode)}
          disabled={loading || !normalizedCode}
          className="mt-4 h-12 w-full rounded-[8px] border border-white/14 bg-white/10 text-sm font-black uppercase tracking-[0.14em] text-white transition hover:bg-white/16 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Join Table
        </button>
      </div>
    </div>
  );
}

function humanSeatNumber(seats: ServerLobbySeat[], playerId: string) {
  const humanSeats = seats.filter((seat): seat is Extract<ServerLobbySeat, { type: "human" }> => seat.type === "human");
  const index = humanSeats.findIndex((seat) => seat.playerId === playerId);
  return index >= 0 ? index + 1 : "?";
}

function ServerLobby({
  lobby,
  hostToken,
  playerCredentials,
  startError,
  loading,
  onAddAi,
  onRemoveAi,
  onSetAiDeck,
  onSetHumanDeck,
  onSetReady,
  onSetDebug,
  onSetAllAi,
  onStart,
}: ServerLobbyProps) {
  const seats = lobby?.seats ?? [
    { type: "empty", seatId: "northWest" } as ServerLobbySeat,
    { type: "empty", seatId: "northEast" } as ServerLobbySeat,
    { type: "empty", seatId: "southEast" } as ServerLobbySeat,
    { type: "empty", seatId: "southWest" } as ServerLobbySeat,
  ];
  const humanCount = seats.filter((seat) => seat.type === "human").length;
  const aiCount = seats.filter((seat) => seat.type === "ai").length;
  const emptyCount = seats.filter((seat) => seat.type === "empty").length;
  const canStart = Boolean(hostToken && lobby?.status === "lobby" && emptyCount === 0);
  const ownSeat = playerCredentials
    ? seats.find((seat) => seat.type === "human" && seat.playerId === playerCredentials.playerId)
    : null;
  const [dbDecks, setDbDecks] = useState<DbDeck[]>([]);

  useEffect(() => {
    fetch(`${GAME_SERVER_URL}/game/decks`)
      .then((r) => r.json())
      .then((data: { decks?: DbDeck[] }) => setDbDecks(data.decks ?? []))
      .catch(() => setDbDecks([]));
  }, []);

  const firstDeckId = dbDecks[0] ? String(dbDecks[0].id) : "";

  return (
    <div
      className="relative h-screen overflow-hidden bg-[#05080b] text-white"
      style={{
        backgroundImage: `linear-gradient(90deg, rgba(2,6,12,.42), rgba(6,7,10,.1) 48%, rgba(12,5,2,.44)), url("${lobbyBgNeutral}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(255,214,143,.16),transparent_30%),linear-gradient(180deg,rgba(0,0,0,.12),rgba(0,0,0,.76))]" />
      <div className="relative z-10 mx-auto flex h-screen w-[min(1440px,94vw)] flex-col justify-center px-4 py-4">
        <div className="mb-4 ml-[2vw]">
          <h1 className="font-serif text-[clamp(1.85rem,3vw,3.4rem)] leading-none text-[#ead8b8] drop-shadow-[0_3px_10px_rgba(0,0,0,.7)]">
            New Commander Match
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-200/88">
            Configure your Commander table. Invite players or fill empty seats with AI.
          </p>
          <div className="mt-2 text-xs font-bold uppercase tracking-[.16em] text-[#ead8b8]/86">
            {humanCount} HUMAN • {aiCount} AI • {emptyCount} EMPTY
          </div>
          <div className="mt-2 inline-flex rounded-[6px] border border-amber-200/35 bg-black/35 px-3 py-1.5 text-sm font-black uppercase tracking-[0.2em] text-amber-100">
            Lobby {lobby?.code ?? lobby?.id.slice(0, 10) ?? "creating"}
          </div>
        </div>

        {startError && (
          <div className="mx-auto mb-5 w-[min(960px,100%)] rounded-lg border border-red-400/40 bg-red-950/72 p-3 text-sm text-red-100 shadow-2xl backdrop-blur">
            {startError}
          </div>
        )}

        <div className="grid min-h-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {seats.map((seat, index) => {
            const skin = LOBBY_SEAT_SKINS[index] ?? LOBBY_SEAT_SKINS[0];
            const commander = seat.type === "empty" ? null : seat.deck?.commanderName ?? "Commander";
            const readyLabel = seat.type === "human"
              ? seat.ready ? "READY" : "NOT READY"
              : seat.type === "ai"
                ? seat.deckId ? "READY" : "NEEDS DECK"
                : "";
            return (
              <div
                key={seat.seatId}
                className="relative h-[min(54vh,360px)] min-h-[285px] overflow-hidden rounded-[8px] border bg-black/62 p-4 shadow-[0_22px_42px_rgba(0,0,0,.58)] backdrop-blur-sm"
                style={{
                  borderColor: `${skin.accent}88`,
                  boxShadow: `inset 0 0 0 1px ${skin.accent}3d, 0 0 26px ${skin.accent}2e, 0 22px 42px rgba(0,0,0,.58)`,
                }}
              >
                <div
                  className="absolute inset-0 opacity-38"
                  style={{
                    backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.22), rgba(0,0,0,.72)), url("${skin.bg}")`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }}
                />
                <img src={skin.panel} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-52 mix-blend-screen" />
                <div className="relative z-10 flex h-full flex-col items-center text-center">
                  <div className="mb-2 font-serif text-xl font-bold uppercase tracking-wide" style={{ color: skin.accent }}>
                    {index === 0 ? "YOU" : skin.title}
                  </div>
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-[.18em] text-slate-200/80">
                    {seat.type === "human" ? `HUMAN ${seat.connectionStatus === "connected" ? "●" : "○"}` : seat.type === "ai" ? "AI" : "EMPTY SEAT"}
                  </div>
                  {seat.type === "empty" ? (
                    <div className="flex flex-1 flex-col items-center justify-center">
                      <div className="mb-3 text-5xl font-light text-white/60">+</div>
                      <div className="mb-1 text-lg font-bold text-[#ead8b8]">EMPTY SEAT</div>
                      <div className="mb-5 text-sm text-slate-300/72">Waiting for player</div>
                      <button
                        type="button"
                        onClick={() => onAddAi(seat.seatId, firstDeckId)}
                        disabled={!hostToken || lobby?.allAi || !firstDeckId}
                        className="rounded-[6px] border border-orange-200/60 bg-orange-600/80 px-6 py-2 text-xs font-bold uppercase tracking-[.12em] text-white shadow-lg transition hover:brightness-110 disabled:opacity-45"
                      >
                        Add AI
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="relative mb-3 aspect-[1.55] w-[min(82%,210px)] overflow-hidden rounded-[6px] border bg-black/50 shadow-[0_16px_28px_rgba(0,0,0,.42)]" style={{ borderColor: `${skin.accent}aa` }}>
                        <img
                          src={cardImageUrl(commander ?? "Commander", "art_crop")}
                          alt={commander ?? ""}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/88 to-transparent px-3 pb-2 pt-8 text-center text-xs font-semibold text-[#f6e5cb]">
                          {commander}
                        </div>
                      </div>
                      <div className="mb-2 text-xs text-slate-200/82">
                        {seat.type === "human"
                          ? seat.playerId === playerCredentials?.playerId
                            ? "You"
                            : `Player ${humanSeatNumber(seats, seat.playerId)}`
                          : seat.deck?.name ?? "AI player"}
                      </div>
                      <div className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-emerald-200">
                        {readyLabel}
                      </div>
                      <div className="min-h-8 text-xs text-slate-300/80">
                        {seat.deck?.name ?? "No deck selected"}
                        {typeof seat.deck?.cardCount === "number" ? ` • ${seat.deck.cardCount} cards` : ""}
                      </div>
                      <div className="relative mt-2 h-16 w-full">
                        {[0, 1, 2, 3, 4, 5, 6].map((cardIndex) => (
                          <img
                            key={cardIndex}
                            src={cardIndex === 6 ? lobbyDeckBack : lobbyCardBack}
                            alt=""
                            className="absolute bottom-0 left-1/2 h-[58px] w-[39px] rounded-[4px] object-cover shadow-[0_8px_14px_rgba(0,0,0,.55)]"
                            style={{
                              transform: `translateX(${(cardIndex - 3) * 16 - 20}px) rotate(${(cardIndex - 3) * 5}deg)`,
                              zIndex: cardIndex,
                            }}
                            loading="lazy"
                          />
                        ))}
                      </div>
                      {seat.type === "human" && seat.playerId === playerCredentials?.playerId && (
                        <div className="mt-auto grid w-full gap-2">
                          <select
                            value={seat.deckId ?? ""}
                            onChange={(event) => onSetHumanDeck(event.target.value)}
                            disabled={seat.ready}
                            className="w-full rounded-[6px] border border-white/18 bg-black/55 px-2 py-2 text-xs text-white"
                          >
                            <option value="">Select your deck</option>
                            {dbDecks.map((deck) => (
                              <option key={deck.id} value={deck.id}>
                                {deck.name ?? deck.commander ?? `Deck #${deck.id}`}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => onSetReady(!seat.ready)}
                            disabled={!seat.deckId}
                            className="rounded-[6px] border border-emerald-200/40 bg-emerald-700/70 px-5 py-2 text-xs font-bold uppercase tracking-[.12em] text-white transition hover:brightness-110 disabled:opacity-45"
                          >
                            {seat.ready ? "Not Ready" : "Ready"}
                          </button>
                        </div>
                      )}
                      {seat.type === "human" && seat.playerId !== playerCredentials?.playerId && (
                        <div className="mt-auto text-xs uppercase tracking-[0.16em] text-slate-400">
                          Waiting for player
                        </div>
                      )}
                      {seat.type === "ai" && (
                        <div className="mt-auto grid w-full gap-2">
                          <select
                            value={seat.deckId ?? ""}
                            onChange={(event) => onSetAiDeck(seat.seatId, event.target.value)}
                            disabled={!hostToken}
                            className="w-full rounded-[6px] border border-white/18 bg-black/55 px-2 py-2 text-xs text-white"
                          >
                            <option value="">Select AI deck</option>
                            {dbDecks.map((deck) => (
                              <option key={deck.id} value={deck.id}>
                                {deck.name ?? deck.commander ?? `Deck #${deck.id}`}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => onRemoveAi(seat.seatId)}
                            disabled={!hostToken || lobby?.allAi}
                            className="rounded-[6px] border border-white/18 bg-black/28 px-5 py-2 text-xs font-bold uppercase tracking-[.12em] text-slate-100 transition hover:bg-white/10 disabled:opacity-45"
                          >
                            Remove AI
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 grid gap-4 rounded-[8px] border border-white/14 bg-[#071018]/78 p-3 shadow-[0_18px_36px_rgba(0,0,0,.42)] backdrop-blur-md md:grid-cols-[1fr_auto]">
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-3 text-sm font-bold uppercase tracking-[.12em] text-slate-200">
              <input type="checkbox" checked={lobby?.mode === "debug"} onChange={(e) => onSetDebug(e.target.checked)} disabled={!hostToken} />
              Debug Mode
            </label>
            <label className="flex items-center gap-3 text-sm font-bold uppercase tracking-[.12em] text-slate-200">
              <input type="checkbox" checked={Boolean(lobby?.allAi)} onChange={(e) => onSetAllAi(e.target.checked)} disabled={!hostToken} />
              Spectate All-AI Match
            </label>
          </div>
          <button
            type="button"
            onClick={onStart}
            disabled={!canStart || loading || Boolean(ownSeat && ownSeat.type === "human" && !ownSeat.ready)}
            className="group relative h-12 min-w-[220px] overflow-hidden rounded-[8px] border border-orange-200/70 bg-[linear-gradient(180deg,#ffb13b,#b94711)] px-8 font-serif text-xl font-bold text-white shadow-[0_0_24px_rgba(251,146,60,.68),0_18px_34px_rgba(0,0,0,.52)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Start Match
          </button>
        </div>
      </div>
    </div>
  );
}

function toDisplayStep(phase: string, phaseStep: string): TurnStepLabel {
  const raw = `${phase} ${phaseStep}`.toLowerCase();

  if (raw.includes("untap") || raw.includes("stap")) return "Untap";
  if (raw.includes("upkeep") || raw.includes("mantenimento")) return "Upkeep";
  if (raw.includes("draw") || raw.includes("acquisizione")) return "Draw";
  if (raw.includes("inizio combatt") || raw.includes("beginning of combat")) return "Beginning of Combat";
  if (raw.includes("dichiarazione") && raw.includes("attacc")) return "Declare Attackers";
  if (raw.includes("dichiarazione") && raw.includes("blocc")) return "Declare Blockers";
  if (raw.includes("danno da combatt") || raw.includes("combat damage")) return "Combat Damage";
  if (raw.includes("fine combatt") || raw.includes("end of combat")) return "End of Combat";
  if ((raw.includes("main") || raw.includes("princip")) && (raw.includes("2") || raw.includes("second"))) {
    return "Postcombat Main";
  }
  if (raw.includes("cancellazione") || raw.includes("cleanup")) return "Cleanup";
  if (raw.includes("end step") || raw.includes("sottofase finale") || raw.includes(" fase finale")) return "End Step";
  return "Precombat Main";
}

function nextStepLabel(current: TurnStepLabel): string {
  const index = TURN_STEP_SEQUENCE.indexOf(current);
  if (index === -1 || index === TURN_STEP_SEQUENCE.length - 1) return "Next Turn";
  return TURN_STEP_SEQUENCE[index + 1];
}

function toDisplayPhaseGroup(step: TurnStepLabel): string {
  switch (step) {
    case "Untap":
    case "Upkeep":
    case "Draw":
      return "Beginning";
    case "Precombat Main":
      return "Precombat Main";
    case "Beginning of Combat":
    case "Declare Attackers":
    case "Declare Blockers":
    case "Combat Damage":
    case "End of Combat":
      return "Combat";
    case "Postcombat Main":
      return "Postcombat Main";
    case "End Step":
    case "Cleanup":
      return "Ending";
    default:
      return "Turn";
  }
}

function resolvePendingDecision(pendingDecision: PendingDecision | null, controls: {
  submitAction: (action: unknown) => void;
  submitAttackPlan: (plan: unknown) => void;
  submitBlockPlan: (plan: unknown) => void;
  submitMulligan: (keep: boolean, bottomCards?: string[]) => void;
  submitTarget: (targetIndex: number) => void;
  submitResponse: (action: unknown) => void;
}): void {
  if (!pendingDecision) return;

  const { decisionType, context } = pendingDecision;

  switch (decisionType) {
    case "action": {
      const passAction =
        context.availableActions?.find((action) => action.type === "PASS_TURN") ??
        { type: "PASS_TURN" };
      controls.submitAction(passAction);
      break;
    }
    case "response":
      controls.submitResponse(null);
      break;
    case "mulligan":
      controls.submitMulligan(true);
      break;
    case "target":
      controls.submitTarget(context.opponentIndices?.[0] ?? 0);
      break;
    case "attack_plan":
      controls.submitAttackPlan(context.plans?.[0] ?? null);
      break;
    case "block_plan":
      controls.submitBlockPlan(context.plans?.[0] ?? null);
      break;
  }
}

interface DeckStartConfig {
  humanDeckId: number | null;
  humanDeck: string[] | null;
  aiDeckIds: number[];
  aiDecks: string[][];
}

interface DeckLobbyProps {
  onStart: (config: DeckStartConfig) => void;
  myDeckId?: number | null;
  myCommander?: string | null;
  myFullDeck?: string[] | null;
  startError?: string | null;
}

function DeckLobby({ onStart, myDeckId, myCommander, myFullDeck, startError }: DeckLobbyProps) {
  const [dbDecks, setDbDecks] = useState<DbDeck[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [humanSelection, setHumanSelection] = useState("");
  const [selections, setSelections] = useState<[string, string, string]>(["", "", ""]);
  const [databaseSelection, setDatabaseSelection] = useState("");

  useEffect(() => {
    let active = true;

    const loadDecks = async (isInitial = false) => {
      if (isInitial && active) setLoading(true);
      try {
        const response = await fetch(`${GAME_SERVER_URL}/game/decks`);
        const data = (await response.json()) as { decks?: DbDeck[] };
        if (!active) return;
        setDbDecks(Array.isArray(data.decks) ? data.decks : []);
      } catch {
        if (!active) return;
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadDecks(true);
    const interval = window.setInterval(() => {
      void loadDecks(false);
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [myDeckId, myCommander]);

  const setSlot = (index: 0 | 1 | 2, deckId: string) => {
    setSelections((prev) => {
      const next = [...prev] as [string, string, string];
      next[index] = deckId;
      return next;
    });
  };

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
      setSelections((prev) =>
        prev.map((selection) => (selection === String(deck.id) || selection === `db:${deck.id}` ? "" : selection)) as [
          string,
          string,
          string,
        ]
      );
      if (deck.id === myDeckId) {
        localStorage.removeItem("savedDeckId");
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Errore cancellazione deck");
    } finally {
      setDeletingId(null);
    }
  };

  const viewerDeckOptionValue = myDeckId ? `db:${myDeckId}` : "__viewer__";
  const canUseViewerDeck = Boolean(myFullDeck?.length && myCommander);
  const defaultOptionLabel = canUseViewerDeck || myDeckId ? "Default (your deck)" : "Default (Basic Deck)";
  const deckSelectClass =
    "h-11 w-full appearance-none rounded-[6px] border border-white/18 px-3 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,.08)] outline-none transition focus:border-white/40";
  const deckSelectStyle = { backgroundColor: "#071018", color: "#ffffff", colorScheme: "dark" } as const;

  const parseDeckSelectionId = (selection: string) => {
    if (!selection || selection === "__viewer__") return null;
    const parsed = Number(selection.startsWith("db:") ? selection.slice(3) : selection);
    return Number.isNaN(parsed) ? null : parsed;
  };

  const deckForSelection = (selection: string) => {
    const parsed = parseDeckSelectionId(selection);
    return parsed === null ? null : dbDecks.find((item) => item.id === parsed) ?? null;
  };

  const startMatch = () => {
    const aiDeckIds: number[] = [];
    const aiDecks: string[][] = [];
    let selectedHumanDeckId = myDeckId ?? null;
    let selectedHumanDeck = myFullDeck?.length ? [...myFullDeck] : null;

    if (humanSelection === "__viewer__") {
      selectedHumanDeckId = null;
      selectedHumanDeck = myFullDeck?.length ? [...myFullDeck] : null;
    } else if (humanSelection) {
      const parsedHumanDeckId = parseDeckSelectionId(humanSelection);
      if (parsedHumanDeckId !== null) {
        selectedHumanDeckId = parsedHumanDeckId;
        selectedHumanDeck = null;
      }
    }

    for (const selection of selections) {
      if (!selection) continue;
      if (selection === "__viewer__") {
        if (myFullDeck?.length) aiDecks.push([...myFullDeck]);
        continue;
      }
      if (selection.startsWith("db:")) {
        const parsed = Number(selection.slice(3));
        if (!Number.isNaN(parsed)) aiDeckIds.push(parsed);
        continue;
      }
      const parsed = Number(selection);
      if (!Number.isNaN(parsed)) aiDeckIds.push(parsed);
    }

    if (aiDeckIds.length === 0 && aiDecks.length === 0) {
      if (myDeckId) {
        aiDeckIds.push(myDeckId, myDeckId, myDeckId);
      } else if (myFullDeck?.length) {
        aiDecks.push([...myFullDeck], [...myFullDeck], [...myFullDeck]);
      }
    }

    onStart({
      humanDeckId: selectedHumanDeckId,
      humanDeck: selectedHumanDeck,
      aiDeckIds,
      aiDecks,
    });
  };

  const deckLabelForSelection = (selection: string) => {
    if (!selection) return defaultOptionLabel;
    if (selection === "__viewer__") return myCommander ? `Current deck - ${myCommander}` : "Current deck";
    const deck = deckForSelection(selection);
    if (!deck) return defaultOptionLabel;
    return deck.name ?? deck.commander ?? `Deck #${deck.id}`;
  };
  const commanderForSelection = (selection: string) =>
    deckForSelection(selection)?.commander ?? (selection === "__viewer__" ? myCommander : null);
  const cardCountForSelection = (selection: string) =>
    deckForSelection(selection)?.cardCount ?? (selection === "__viewer__" ? myFullDeck?.length : null);
  const selectedDatabaseDeck =
    dbDecks.find((deck) => String(deck.id) === databaseSelection) ?? dbDecks[0] ?? null;

  const lobbySeats = [
    {
      title: "YOU",
      role: "YOUR DECK",
      commander: commanderForSelection(humanSelection) ?? myCommander ?? "Marchesa, the Black Rose",
      selectionIndex: null,
      deckLabel: deckLabelForSelection(humanSelection),
      cardCount: cardCountForSelection(humanSelection) ?? myFullDeck?.length ?? 100,
      bg: lobbyBgRed,
      panel: lobbyPanelRed,
      accent: "#ff4a3d",
      pips: ["W", "U", "B", "R"] satisfies ManaIconKey[],
    },
    {
      title: "AI EAST",
      role: "AI DECK",
      commander: "Ezuri, Renegade Leader",
      selectionIndex: 0 as const,
      deckLabel: deckLabelForSelection(selections[0] ?? ""),
      cardCount: 100,
      bg: lobbyBgGreen,
      panel: lobbyPanelGreen,
      accent: "#18c486",
      pips: ["G", "U", "B"] satisfies ManaIconKey[],
    },
    {
      title: "AI WEST",
      role: "AI DECK",
      commander: "Edgar Markov",
      selectionIndex: 2 as const,
      deckLabel: deckLabelForSelection(selections[2] ?? ""),
      cardCount: 100,
      bg: lobbyBgBlue,
      panel: lobbyPanelBlue,
      accent: "#5da4ff",
      pips: ["U", "B", "R"] satisfies ManaIconKey[],
    },
    {
      title: "AI SOUTH",
      role: "AI DECK",
      commander: "Ajani, Caller of the Pride",
      selectionIndex: 1 as const,
      deckLabel: deckLabelForSelection(selections[1] ?? ""),
      cardCount: 100,
      bg: lobbyBgGold,
      panel: lobbyPanelGold,
      accent: "#f5a623",
      pips: ["R", "W", "G"] satisfies ManaIconKey[],
    },
  ];

  const renderDeckOptions = () => (
    <>
      <option value="">{defaultOptionLabel}</option>
      {canUseViewerDeck && (
        <option value={viewerDeckOptionValue}>
          Current deck - {myCommander}
        </option>
      )}
      {dbDecks.map((d) => {
        const displayCommander = d.commander ?? null;
        const displayName = d.name ?? displayCommander ?? `Deck #${d.id}`;

        return (
          <option key={d.id} value={d.id}>
            {displayName}
            {displayCommander && displayCommander !== displayName ? ` - ${displayCommander}` : ""}
            {typeof d.cardCount === "number" ? ` · ${d.cardCount} cards` : ""}
          </option>
        );
      })}
    </>
  );

  return (
    <div
      className="relative h-screen overflow-auto bg-[#05080b] text-white"
      style={{
        backgroundImage: `linear-gradient(90deg, rgba(2,6,12,.42), rgba(6,7,10,.1) 48%, rgba(12,5,2,.44)), url("${lobbyBgNeutral}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(255,214,143,.16),transparent_30%),linear-gradient(180deg,rgba(0,0,0,.12),rgba(0,0,0,.76))]" />
      <div className="relative z-10 mx-auto flex min-h-screen w-[min(1440px,94vw)] flex-col justify-center px-4 py-8">
        <div className="mb-8 ml-[2vw]">
          <h1 className="font-serif text-[clamp(2.35rem,4vw,4.6rem)] leading-none text-[#ead8b8] drop-shadow-[0_3px_10px_rgba(0,0,0,.7)]">
            New SpellTable Match
          </h1>
          <p className="mt-4 max-w-3xl text-[clamp(.95rem,1.25vw,1.2rem)] text-slate-200/88">
            Your board still comes from MoxfieldUI. Choose decks for the 3 AI opponents here.
          </p>
        </div>

        {startError && (
          <div className="mx-auto mb-5 w-[min(960px,100%)] rounded-lg border border-red-400/40 bg-red-950/72 p-3 text-sm text-red-100 shadow-2xl backdrop-blur">
            {startError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          {lobbySeats.map((seat) => (
            <div
              key={seat.title}
              className="relative min-h-[430px] overflow-hidden rounded-[8px] border bg-black/62 p-5 shadow-[0_22px_42px_rgba(0,0,0,.58)] backdrop-blur-sm"
              style={{
                borderColor: `${seat.accent}88`,
                boxShadow: `inset 0 0 0 1px ${seat.accent}3d, 0 0 26px ${seat.accent}2e, 0 22px 42px rgba(0,0,0,.58)`,
              }}
            >
              <div
                className="absolute inset-0 opacity-38"
                style={{
                  backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.22), rgba(0,0,0,.72)), url("${seat.bg}")`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              />
              <img src={seat.panel} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-52 mix-blend-screen" />
              <div className="relative z-10 flex h-full flex-col items-center">
                <div
                  className="mb-3 text-center font-serif text-2xl font-bold uppercase tracking-wide"
                  style={{ color: seat.accent, textShadow: `0 0 18px ${seat.accent}` }}
                >
                  {seat.title}
                </div>
                <div className="relative mb-4 aspect-[1.42] w-[min(88%,250px)] overflow-hidden rounded-[6px] border bg-black/50 shadow-[0_16px_28px_rgba(0,0,0,.42)]" style={{ borderColor: `${seat.accent}aa` }}>
                  <img
                    src={cardImageUrl(seat.commander, "art_crop")}
                    alt={seat.commander}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 ring-1 ring-inset ring-white/18" />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/88 to-transparent px-3 pb-2 pt-8 text-center text-xs font-semibold text-[#f6e5cb]">
                    {seat.commander}
                  </div>
                </div>
                <div className="mb-4 flex justify-center gap-2">
                  {seat.pips.map((pip) => (
                    <img
                      key={`${seat.title}-${pip}`}
                      src={MANA_ICONS[pip]}
                      alt={`${pip} mana`}
                      className="h-8 w-8 rounded-full border border-black/70 bg-slate-200 object-cover shadow-[0_4px_10px_rgba(0,0,0,.45)]"
                      style={{ boxShadow: `0 0 14px ${seat.accent}55, inset 0 1px 0 rgba(255,255,255,.5)` }}
                      loading="lazy"
                    />
                  ))}
                </div>
                <div className="w-full border-t border-white/8 pt-4">
                  <div className="mb-2 text-xs font-bold uppercase tracking-[.14em] text-slate-300/72">
                    {seat.role}
                  </div>
                  <select
                    className={deckSelectClass}
                    style={deckSelectStyle}
                    value={seat.selectionIndex === null ? humanSelection : selections[seat.selectionIndex] ?? ""}
                    onChange={(e) => {
                      if (seat.selectionIndex === null) {
                        setHumanSelection(e.target.value);
                      } else {
                        setSlot(seat.selectionIndex, e.target.value);
                      }
                    }}
                    aria-label={`${seat.title} deck`}
                  >
                    {renderDeckOptions()}
                  </select>
                </div>
                <div className="relative mt-5 h-24 w-full">
                  {[0, 1, 2, 3, 4, 5, 6].map((cardIndex) => (
                    <img
                      key={cardIndex}
                      src={cardIndex === 6 ? lobbyDeckBack : lobbyCardBack}
                      alt=""
                      className="absolute bottom-0 left-1/2 h-[86px] w-[58px] rounded-[4px] object-cover shadow-[0_8px_14px_rgba(0,0,0,.55)]"
                      style={{
                        transform: `translateX(${(cardIndex - 3) * 22 - 29}px) rotate(${(cardIndex - 3) * 5}deg)`,
                        zIndex: cardIndex,
                      }}
                      loading="lazy"
                    />
                  ))}
                </div>
                <div className="mt-auto pt-2 text-sm" style={{ color: seat.accent }}>
                  {seat.cardCount} cards
                </div>
              </div>
            </div>
          ))}
        </div>

        {loading && (
          <div className="mt-5 text-center text-sm font-semibold text-[#ead8b8]/80">
            Loading decks from database...
          </div>
        )}

        {!loading && dbDecks.length > 0 && (
          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,760px)_340px]">
            <div className="flex items-center gap-4 rounded-[8px] border border-white/14 bg-[#071018]/78 p-4 shadow-[0_18px_36px_rgba(0,0,0,.42)] backdrop-blur-md">
              <img src={lobbyDeckBack} alt="" className="h-16 w-12 rounded-[4px] object-cover shadow-lg" />
              <div className="min-w-0 flex-1">
                <div className="mb-2 text-xs font-bold uppercase tracking-[.15em] text-slate-300/72">
                  Deck database
                </div>
                <select
                  className={deckSelectClass}
                  style={deckSelectStyle}
                  value={selectedDatabaseDeck ? String(selectedDatabaseDeck.id) : ""}
                  onChange={(event) => setDatabaseSelection(event.target.value)}
                >
                  {dbDecks.map((deck) => {
                    const label = deck.name ?? deck.commander ?? `Deck #${deck.id}`;
                    return (
                      <option key={deck.id} value={deck.id}>
                        #{deck.id} {label}
                        {typeof deck.cardCount === "number" ? ` - ${deck.cardCount} cards` : ""}
                      </option>
                    );
                  })}
                </select>
              </div>
              <button
                type="button"
                onClick={() => selectedDatabaseDeck && deleteDeck(selectedDatabaseDeck)}
                disabled={deletingId !== null || selectedDatabaseDeck === null}
                className="h-11 shrink-0 rounded-[6px] border border-red-500/54 bg-red-950/20 px-7 text-sm font-bold text-red-300 transition hover:bg-red-900/36 disabled:opacity-50"
              >
                {deletingId !== null ? "..." : "Delete"}
              </button>
            </div>
            {deleteError && (
              <div className="self-center rounded-lg border border-red-500/40 bg-red-950/72 px-4 py-3 text-sm text-red-100">
                {deleteError}
              </div>
            )}
          </div>
        )}

        {!loading && (
          <div className="mt-8 flex justify-end">
            <button
              onClick={startMatch}
              className="group relative h-20 min-w-[320px] overflow-hidden rounded-[8px] border border-orange-200/70 bg-[linear-gradient(180deg,#ffb13b,#b94711)] px-10 font-serif text-3xl font-bold text-white shadow-[0_0_24px_rgba(251,146,60,.68),0_18px_34px_rgba(0,0,0,.52)] transition hover:brightness-110"
            >
              <span className="absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(255,255,255,.55),transparent_24%),linear-gradient(90deg,rgba(255,255,255,.18),transparent_30%,rgba(255,255,255,.12))]" />
              <span className="relative flex items-center justify-center gap-5">
                <span className="text-3xl">⚔</span>
                Start Match
                <span className="text-4xl leading-none transition group-hover:translate-x-1">›</span>
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SpellTablePage() {
  void DeckLobby;
  void getStoredSetup;
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSessionId = searchParams.get("session");
  const urlAction = searchParams.get("action");
  const [gameStarted, setGameStarted] = useState(
    () => (urlAction === "new-match" ? false : Boolean(urlSessionId))
  );
  const [sessionId, setSessionId] = useState<string | null>(
    () => (urlAction === "new-match" ? null : urlSessionId)
  );
  const [lobbyId, setLobbyId] = useState<string | null>(null);
  const [hostToken, setHostToken] = useState<string | null>(null);
  const [playerCredentials, setPlayerCredentials] = useState<TablePlayerCredentials | null>(null);
  const [lobby, setLobby] = useState<ServerLobbySnapshot | null>(null);
  const [lobbyLoading, setLobbyLoading] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [selectedCardName, setSelectedCardName] = useState<string | null>(null);
  const [selectedCardImageName, setSelectedCardImageName] = useState<string | null>(null);
  const [selectedCardImageFace, setSelectedCardImageFace] = useState<"front" | "back" | null>(null);
  const [showOtherCardFace, setShowOtherCardFace] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== "undefined" && document.fullscreenElement !== null
  );
  const [playerCounters, setPlayerCounters] = useState<Record<number, PlayerCounters>>(
    createDefaultCounters
  );
  const [creatingSession, setCreatingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRestartTokenRef = useRef<number | string | null>(null);

  const enterNewMatchFlow = useCallback(() => {
    sessionStorage.removeItem(SESSION_STORAGE_ID_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_LOBBY_ID_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_HOST_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_PLAYER_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_SETUP_KEY);
    setSessionId(null);
    setLobbyId(null);
    setLobby(null);
    setHostToken(null);
    setPlayerCredentials(null);
    setError(null);
    setPlayerCounters(createDefaultCounters());
    setGameStarted(false);
  }, []);

  useEffect(() => {
    if (urlAction === "new-match") {
      enterNewMatchFlow();
      setSearchParams({}, { replace: true });
      return;
    }
    if (!urlSessionId) return;
    sessionStorage.setItem(SESSION_STORAGE_ID_KEY, urlSessionId);
    setSessionId(urlSessionId);
    setGameStarted(true);
    setSearchParams({}, { replace: true });
  }, [enterNewMatchFlow, setSearchParams, urlAction, urlSessionId]);

  const viewerState = useViewerState(1500);
  const viewerControl = useViewerControl(900);
  const {
    gameState,
    capabilities,
    pendingDecision,
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
  } = useGameSession(sessionId, { role: lobby?.mode === "debug" ? "debug" : "table" });

  const players = useMemo(() => gameState?.players ?? [], [gameState?.players]);
  const engineHuman = players.find((player) => player.index === 0);
  const mode: SessionMode = gameStarted
    ? sessionModeForEngineSession(sessionId ?? "__creating__")
    : "standalone";

  useEffect(() => {
    if (!pendingDecision || pendingDecision.decisionType !== "action") return;
    const availableActions = pendingDecision.context.availableActions ?? [];
    const playLandActions = availableActions.filter((action) => action.type === "PLAY_LAND");
    if (!playLandActions.length) return;

    const engineHand = engineHuman?.hand ?? [];
    const viewerHand = mode === "standalone" ? viewerState?.hand ?? [] : engineHand;
    const missingFromViewer = playLandActions.filter(
      (action) => action.card && !viewerHand.includes(action.card)
    );
    const missingFromEngine = playLandActions.filter(
      (action) => action.card && !engineHand.includes(action.card)
    );
    if (!missingFromViewer.length && !missingFromEngine.length) return;

    const payload = {
      invariant: "PLAY_LAND_CARD_MUST_BE_IN_CURRENT_HAND",
      stage: "SpellTable.bridge",
      sessionId,
      gameState: gameState
        ? {
            turn: gameState.turn,
            phase: gameState.phase,
            phaseStep: gameState.phaseStep,
            playerIndex: gameState.playerIndex,
          }
        : null,
      viewerHand,
      engineHand,
      availableActions,
      missingFromViewer,
      missingFromEngine,
    };
    console.error("[available-actions-invariant]", payload);
    console.assert(
      missingFromEngine.length === 0,
      "[available-actions-invariant] PLAY_LAND outside engine hand",
      payload
    );
  }, [engineHuman?.hand, gameState, mode, pendingDecision, sessionId, viewerState?.hand]);

  const playersByIndex = useMemo(() => {
    return buildSpellTablePlayers({ mode, viewerState, enginePlayers: players });
  }, [mode, viewerState, players]);

  const activePlayerIndex = gameState?.playerIndex ?? 0;
  const displayTurn = gameState?.turn ?? viewerState?.turn ?? 1;
  const currentStep = toDisplayStep(gameState?.phase ?? "", gameState?.phaseStep ?? "");
  const currentPhaseGroup = toDisplayPhaseGroup(currentStep);
  const phaseIndex = TURN_STEP_SEQUENCE.indexOf(currentStep);
  const nextLabel = nextStepLabel(currentStep);
  const seatOrder = useMemo(() => {
    const positions = ["NORTH", "EAST", "SOUTH", "WEST"] as const;
    return positions.map((position, fallbackIndex) => {
      const player = gameState?.players.find((candidate) =>
        (candidate.seat ?? candidate.position) === position
      );
      return player?.index ?? fallbackIndex;
    });
  }, [gameState?.players]);
  const activeSeatLabel =
    gameState?.players.find((player) => player.index === activePlayerIndex)?.displayName ??
    `P${activePlayerIndex}`;
  const commanderCounterLabels = useMemo(() => {
    const labels: Record<PlayerCounterKey, string> = {
      poison: "Poison",
      energy: "Energy",
      experience: "Experience",
      rad: "Rad",
      commander1: "Commander 1",
      commander2: "Commander 2",
      commander3: "Commander 3",
      commander4: "Commander 4",
    };

    const counterKeys: PlayerCounterKey[] = [
      "commander1",
      "commander2",
      "commander3",
      "commander4",
    ];

    [0, 1, 2, 3].forEach((playerIndex, index) => {
      const commanderName = playersByIndex.get(playerIndex)?.commander?.trim();
      if (commanderName) {
        labels[counterKeys[index]] = commanderName;
      }
    });

    return labels;
  }, [playersByIndex]);
  const sharedCounters = useMemo(
    () => [
      {
        key: "poison" as const,
        icon: "ϕ",
        rows: [0, 1, 2, 3].map((playerIndex) => ({
          playerId: playerIndex,
          label: "Poison",
          value: playerCounters[playerIndex]?.poison ?? 0,
        })),
      },
      {
        key: "energy" as const,
        icon: "⚡",
        rows: [0, 1, 2, 3].map((playerIndex) => ({
          playerId: playerIndex,
          label: "Energy",
          value: playerCounters[playerIndex]?.energy ?? 0,
        })),
      },
      {
        key: "experience" as const,
        icon: "◔",
        rows: [0, 1, 2, 3].map((playerIndex) => ({
          playerId: playerIndex,
          label: "Experience",
          value: playerCounters[playerIndex]?.experience ?? 0,
        })),
      },
      {
        key: "rad" as const,
        icon: "☢",
        rows: [0, 1, 2, 3].map((playerIndex) => ({
          playerId: playerIndex,
          label: "Rad",
          value: playerCounters[playerIndex]?.rad ?? 0,
        })),
      },
    ],
    [playerCounters]
  );
  void sharedCounters;

  const applyLobbySnapshot = useCallback((nextLobby: ServerLobbySnapshot) => {
    setLobby(nextLobby);
    if (nextLobby.status === "running" && nextLobby.runningSessionId) {
      sessionStorage.setItem(SESSION_STORAGE_ID_KEY, nextLobby.runningSessionId);
      setSessionId(nextLobby.runningSessionId);
      setGameStarted(true);
    }
  }, []);

  const storePlayerCredentials = useCallback((credentials: TablePlayerCredentials | null) => {
    setPlayerCredentials(credentials);
    if (credentials) {
      sessionStorage.setItem(SESSION_STORAGE_PLAYER_KEY, JSON.stringify(credentials));
    } else {
      sessionStorage.removeItem(SESSION_STORAGE_PLAYER_KEY);
    }
  }, []);

  const joinLobbyAsHuman = useCallback(async (targetLobbyId: string, credentials?: TablePlayerCredentials | null) => {
    const response = await fetch(`${GAME_SERVER_URL}/lobby/${encodeURIComponent(targetLobbyId)}/join-human`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials ?? {}),
    });
    const data = (await response.json().catch(() => null)) as
      | (TablePlayerCredentials & { lobby?: ServerLobbySnapshot; error?: string })
      | null;
    if (!response.ok || !data) throw new Error(data?.error ?? "Could not join table.");
    const nextCredentials: TablePlayerCredentials = {
      lobbyId: data.lobbyId,
      playerId: data.playerId,
      seatId: data.seatId,
      playerToken: data.playerToken,
    };
    sessionStorage.setItem(SESSION_STORAGE_LOBBY_ID_KEY, nextCredentials.lobbyId);
    setLobbyId(nextCredentials.lobbyId);
    storePlayerCredentials(nextCredentials);
    if (data.lobby) applyLobbySnapshot(data.lobby);
    return nextCredentials;
  }, [applyLobbySnapshot, storePlayerCredentials]);

  const handleCreateTable = useCallback(async () => {
    setLobbyLoading(true);
    setError(null);
    try {
      const response = await fetch(`${GAME_SERVER_URL}/lobby/create`, { method: "POST" });
      const data = (await response.json()) as { lobby: ServerLobbySnapshot; hostToken: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not create lobby.");
      sessionStorage.setItem(SESSION_STORAGE_LOBBY_ID_KEY, data.lobby.id);
      sessionStorage.setItem(SESSION_STORAGE_HOST_TOKEN_KEY, data.hostToken);
      setLobbyId(data.lobby.id);
      setHostToken(data.hostToken);
      applyLobbySnapshot(data.lobby);
      await joinLobbyAsHuman(data.lobby.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLobbyLoading(false);
    }
  }, [applyLobbySnapshot, joinLobbyAsHuman]);

  const handleJoinTable = useCallback(async (code: string) => {
    if (!code.trim()) return;
    setLobbyLoading(true);
    setError(null);
    setHostToken(null);
    sessionStorage.removeItem(SESSION_STORAGE_HOST_TOKEN_KEY);
    try {
      await joinLobbyAsHuman(code.trim().toUpperCase(), playerCredentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLobbyLoading(false);
    }
  }, [joinLobbyAsHuman, playerCredentials]);

  useEffect(() => {
    if (!lobbyId || sessionId) return;
    const params = new URLSearchParams();
    if (playerCredentials?.lobbyId === lobbyId) {
      params.set("playerId", playerCredentials.playerId);
      params.set("playerToken", playerCredentials.playerToken);
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const wsUrl = `${GAME_SERVER_URL.replace(/^http/, "ws")}/lobby/${lobbyId}${suffix}`;
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "LOBBY_SNAPSHOT" || msg.type === "LOBBY_UPDATED" || msg.type === "MATCH_STARTED") {
        const nextLobby = msg.lobby as ServerLobbySnapshot | undefined;
        if (nextLobby) applyLobbySnapshot(nextLobby);
      }
      if (msg.type === "MATCH_STARTED" && typeof msg.sessionId === "string") {
        sessionStorage.setItem(SESSION_STORAGE_ID_KEY, msg.sessionId);
        setSessionId(msg.sessionId);
        setGameStarted(true);
      }
    };
    return () => ws.close();
  }, [applyLobbySnapshot, lobbyId, playerCredentials, sessionId]);

  const postLobby = useCallback(async (path: string, body: Record<string, unknown>) => {
    if (!lobbyId) return;
    const response = await fetch(`${GAME_SERVER_URL}/lobby/${lobbyId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, hostToken }),
    });
    const data = (await response.json().catch(() => null)) as { lobby?: ServerLobbySnapshot; error?: string } | null;
    if (!response.ok) throw new Error(data?.error ?? "Lobby command failed.");
    if (data?.lobby) applyLobbySnapshot(data.lobby);
  }, [applyLobbySnapshot, hostToken, lobbyId]);

  const postPlayerLobby = useCallback(async (path: string, body: Record<string, unknown>) => {
    if (!lobbyId || !playerCredentials) return;
    const response = await fetch(`${GAME_SERVER_URL}/lobby/${lobbyId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ...playerCredentials }),
    });
    const data = (await response.json().catch(() => null)) as { lobby?: ServerLobbySnapshot; error?: string } | null;
    if (!response.ok) throw new Error(data?.error ?? "Lobby command failed.");
    if (data?.lobby) applyLobbySnapshot(data.lobby);
  }, [applyLobbySnapshot, lobbyId, playerCredentials]);

  const handleAddAi = useCallback((seatId: SeatId, deckId: string) => {
    void postLobby("add-ai", { seatId, deckId }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [postLobby]);

  const handleRemoveAi = useCallback((seatId: SeatId) => {
    void postLobby("remove-ai", { seatId }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [postLobby]);

  const handleSetAiDeck = useCallback((seatId: SeatId, deckId: string) => {
    void postLobby("ai-deck", { seatId, deckId }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [postLobby]);

  const handleSetHumanDeck = useCallback((deckId: string) => {
    void postPlayerLobby("update-player-deck", { deckId }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [postPlayerLobby]);

  const handleSetReady = useCallback((ready: boolean) => {
    void postPlayerLobby("ready", { ready }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [postPlayerLobby]);

  const handleSetDebug = useCallback((enabled: boolean) => {
    void postLobby("options", { debugMode: enabled }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [postLobby]);

  const handleSetAllAi = useCallback((enabled: boolean) => {
    if (!lobbyId) return;
    void (async () => {
      await postLobby("options", { allAi: enabled });
      if (!enabled) {
        await joinLobbyAsHuman(lobbyId, playerCredentials);
      }
    })().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [joinLobbyAsHuman, lobbyId, playerCredentials, postLobby]);

  const handleStartLobby = useCallback(() => {
    setCreatingSession(true);
    void postLobby("start", {})
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreatingSession(false));
  }, [postLobby]);

  useEffect(() => {
    if (!gameStarted) return;
    if (!viewerControl?.restartToken) return;

    if (lastRestartTokenRef.current === null) {
      lastRestartTokenRef.current = viewerControl.restartToken;
      return;
    }
    if (lastRestartTokenRef.current === viewerControl.restartToken) return;

    lastRestartTokenRef.current = viewerControl.restartToken;
    enterNewMatchFlow();
  }, [enterNewMatchFlow, gameStarted, viewerControl?.restartToken]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement !== null);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const passDisabled = !pendingDecision || creatingSession || !sessionId;
  const passLabel = pendingDecision ? "Pass" : "Waiting";

  const handlePass = () => {
    if (!pendingDecision) return;
    resolvePendingDecision(pendingDecision, {
      submitAction,
      submitAttackPlan,
      submitBlockPlan,
      submitMulligan,
      submitTarget,
      submitResponse,
    });
  };

  const handleCardDoubleClick = (cardName: string, imageName?: string, imageFace?: "front" | "back") => {
    const previewFace = cardPreviewFace(cardName, imageName, imageFace);
    setSelectedCardName(cardName);
    setSelectedCardImageName(previewFace.imageName ?? null);
    setSelectedCardImageFace(previewFace.imageFace ?? null);
    setShowOtherCardFace(false);
    setShowSidebar(true);
  };

  const handleCardInspect = (cardName: string | null, imageName?: string, imageFace?: "front" | "back") => {
    const previewFace = cardPreviewFace(cardName, imageName, imageFace);
    setSelectedCardName(cardName);
    setSelectedCardImageName(previewFace.imageName ?? null);
    setSelectedCardImageFace(previewFace.imageFace ?? null);
    setShowOtherCardFace(false);
    if (cardName) setShowSidebar(true);
  };

  const handleCounterChange = (playerId: number, counter: PlayerCounterKey, delta: number) => {
    setPlayerCounters((prev) => ({
      ...prev,
      [playerId]: {
        ...(prev[playerId] ?? { ...DEFAULT_PLAYER_COUNTERS }),
        [counter]: Math.max(0, (prev[playerId]?.[counter] ?? 0) + delta),
      },
    }));
  };

  const handleFullscreenToggle = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Ignore browser-level fullscreen failures.
    }
  };

  const hasHumanData = mode === "engine-linked" ? Boolean(engineHuman) : viewerState !== null;
  const rightPanelOffset =
    (showLog ? LOG_DRAWER_WIDTH : 0) + (showSidebar ? SIDE_PANEL_WIDTH : 0);

  const statusLabel = useMemo(() => {
    if (creatingSession) return "Creating match";
    if (error) return "Session error";
    if (!sessionId) return "No session";
    return isConnected ? "AI Live" : "AI Offline";
  }, [creatingSession, error, isConnected, sessionId]);
  const showDebugChrome = capabilities?.showEngineState ?? true;
  const showDebugLogs = capabilities?.showDebugLogs ?? true;

  useEffect(() => {
    void publishSharedGameSession(sessionId, "spelltable").catch(() => {
      // Cross-UI bridge is optional during local dev.
    });
  }, [sessionId]);

  const renderSeat = (playerIndex: number) => {
    const player = playersByIndex.get(playerIndex);
    const descriptor = gameState?.players.find((candidate) => candidate.index === playerIndex);
    const seat = descriptor?.seat ?? descriptor?.position;
    const accent =
      descriptor?.agentType === "HUMAN" || descriptor?.isHuman === true
        ? ACCENT.human
        : seat === "EAST"
          ? ACCENT.east
          : seat === "SOUTH"
            ? ACCENT.south
            : seat === "WEST"
              ? ACCENT.west
              : ACCENT.north;

    if (player) {
      return (
        <PlayerQuadrant
          playerId={playerIndex}
          player={player}
          isActive={activePlayerIndex === playerIndex}
          accentColor={accent.color}
          accentBg={accent.bg}
          accentText={accent.text}
          onCardDoubleClick={handleCardDoubleClick}
          onCardInspect={handleCardInspect}
          allCounters={playerCounters}
          commanderCounterLabels={commanderCounterLabels}
          onCounterChange={handleCounterChange}
        />
      );
    }

    return (
      <PlaceholderSeat
        label={PLAYER_FALLBACK_LABELS[playerIndex] ?? `Player ${playerIndex}`}
        subtitle={playerIndex === 0 ? "Open MoxfieldUI to stream" : creatingSession ? "Creating match..." : "Waiting..."}
      />
    );
  };

  if (!sessionId) {
    if (!lobbyId && !lobby) {
      return (
        <CommanderArenaHome
          loading={lobbyLoading}
          error={error}
          onCreate={handleCreateTable}
          onJoin={handleJoinTable}
        />
      );
    }

    return (
      <ServerLobby
        lobby={lobby}
        hostToken={hostToken}
        playerCredentials={playerCredentials}
        loading={lobbyLoading || creatingSession}
        onAddAi={handleAddAi}
        onRemoveAi={handleRemoveAi}
        onSetAiDeck={handleSetAiDeck}
        onSetHumanDeck={handleSetHumanDeck}
        onSetReady={handleSetReady}
        onSetDebug={handleSetDebug}
        onSetAllAi={handleSetAllAi}
        onStart={handleStartLobby}
        startError={error}
      />
    );
  }

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-[#05070b] text-white">
      <div
        className="flex shrink-0 items-center justify-between border-b border-amber-500/15 bg-[linear-gradient(180deg,rgba(20,18,15,.92),rgba(7,10,16,.88))] px-3 py-1.5 shadow-[0_10px_28px_rgba(0,0,0,.34)]"
      >
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/70">
            Commander Table
          </span>
          {sessionId && (
            <span className="hidden text-[11px] text-slate-500 md:inline">
              Session: {sessionId.slice(0, 10)}...
            </span>
          )}
          {showDebugChrome && (
            <>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] ${
                  hasHumanData ? "border-cyan-300/20 bg-cyan-950/35 text-cyan-200" : "border-white/8 bg-white/5 text-slate-500"
                }`}
              >
                {mode === "engine-linked"
                  ? hasHumanData ? "Engine Hand" : "Waiting for engine"
                  : hasHumanData ? "MoxfieldUI Live" : "No human data"}
              </span>
              <span
                className={`hidden rounded-full border px-2 py-0.5 text-[10px] md:inline ${
                  mode === "engine-linked" ? "border-cyan-300/20 bg-cyan-950/35 text-cyan-200" : "border-white/8 bg-white/5 text-slate-500"
                }`}
              >
                {mode}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] ${
                  isConnected ? "border-emerald-300/20 bg-emerald-950/35 text-emerald-200" : "border-white/8 bg-white/5 text-slate-500"
                }`}
              >
                {statusLabel}
              </span>
            </>
          )}
        </div>

        {gameState && (
          <TopPhaseBar
            turn={displayTurn}
            currentStep={currentStep}
            currentPhaseGroup={currentPhaseGroup}
            phaseIndex={phaseIndex}
            activeSeatLabel={activeSeatLabel}
            revision={showDebugChrome ? gameState.stateVersion : undefined}
          />
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (gameState && !gameOver && !window.confirm("Start a new match lobby? The current table may still be running.")) {
                return;
              }
              void broadcastViewerRestart();
              enterNewMatchFlow();
            }}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-slate-300 shadow-inner transition hover:bg-white/10 hover:text-white"
          >
            New Match
          </button>
          {showDebugLogs && (
            <button
              onClick={() => setShowLog((value) => !value)}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition ${
                showLog ? "border-cyan-300/30 bg-cyan-700/45 text-white" : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              Log
            </button>
          )}
          <button
            onClick={() => setShowSidebar((value) => !value)}
            aria-label="Open side panel"
            className={`flex h-7 w-8 items-center justify-center rounded-full border transition ${
              showSidebar
                ? "border-cyan-300/40 bg-cyan-700/30 text-white"
                : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            <span className="flex flex-col gap-1">
              <span className="block h-px w-3.5 bg-current" />
              <span className="block h-px w-3.5 bg-current" />
              <span className="block h-px w-3.5 bg-current" />
            </span>
          </button>
        </div>
      </div>

      {gameOver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="rounded-2xl border border-yellow-600/50 bg-[#161b22] p-8 text-center shadow-2xl">
            <div className="mb-2 text-3xl font-bold text-white">
              {gameOver.winner === 0
                ? "You Win!"
                : gameOver.winner === null
                  ? "Draw"
                  : `Player ${gameOver.winner} Wins`}
            </div>
            <div className="mb-4 text-sm text-gray-400">Game over</div>
            <button
              onClick={() => {
                void broadcastViewerRestart();
                enterNewMatchFlow();
              }}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
            >
              New Match
            </button>
          </div>
        </div>
      )}

      {stateOutOfSyncMessage && (
        <div className="fixed left-1/2 top-12 z-50 -translate-x-1/2 rounded border border-red-500/40 bg-red-950/90 px-3 py-2 text-xs font-semibold text-red-100 shadow-xl">
          {stateOutOfSyncMessage}
        </div>
      )}

      {showLog && showDebugLogs && (
        <div
          className="fixed top-10 bottom-0 z-30 flex w-80 flex-col border-l border-white/10 bg-[#161b22] shadow-2xl"
          style={{ right: showSidebar ? `${SIDE_PANEL_WIDTH}px` : 0 }}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-white">
              Game Log
            </span>
            <button
              onClick={() => setShowLog(false)}
              className="text-xs text-gray-500 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <GameLog messages={gameLog} aiDecisionTraces={aiDecisionTraces} />
          </div>
        </div>
      )}

      {showSidebar && (
        <div
          className="fixed top-10 right-0 bottom-0 z-20 border-l border-white/10 bg-[linear-gradient(180deg,rgba(13,16,23,0.96)_0%,rgba(6,8,13,0.98)_100%)] shadow-2xl"
          style={{ width: `${SIDE_PANEL_WIDTH}px` }}
        >
          <div className="flex h-full flex-col px-3 py-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
                Card Preview
              </span>
              <button
                type="button"
                className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-400 hover:bg-white/8 hover:text-white"
                onClick={() => setShowSidebar(false)}
              >
                Close
              </button>
            </div>
            {selectedCardName ? (
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="relative mx-auto w-full max-w-[236px]">
                  <img
                    src={cardImageUrl(
                      selectedCardImageName ?? selectedCardName,
                      "normal",
                      selectedCardImageFace
                        ? showOtherCardFace
                          ? selectedCardImageFace === "front" ? "back" : "front"
                          : selectedCardImageFace
                        : undefined
                    )}
                    alt={selectedCardName}
                    className="w-full rounded-[10px] shadow-2xl"
                    loading="lazy"
                  />
                  {selectedCardImageName && selectedCardImageFace && (
                    <button
                      type="button"
                      aria-label={showOtherCardFace ? "Show played card face" : "Show other card face"}
                      title={showOtherCardFace ? "Show played face" : "Show other face"}
                      onClick={() => setShowOtherCardFace((current) => !current)}
                      className="absolute right-2 top-2 grid size-9 place-items-center rounded-full border border-white/25 bg-black/70 text-white shadow-lg transition hover:bg-black/90 focus:outline-none focus:ring-2 focus:ring-cyan-300"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 7v5h-5M4 17v-5h5" />
                        <path d="M5.7 9A7 7 0 0 1 18 6.5L20 12M4 12l2 5.5A7 7 0 0 0 18.3 15" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
                <img src={sleeve} alt="" className="mb-4 w-28 rounded-xl opacity-25 shadow-2xl" />
                <div className="text-xs text-slate-500">
                  Hover a card to inspect it here.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div
        className="relative min-h-0 flex-1 transition-[margin] duration-300"
        style={{ marginRight: `${rightPanelOffset}px` }}
      >
        <button
          type="button"
          onClick={handleFullscreenToggle}
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          className="absolute top-3 right-3 z-20 flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-[#101724]/68 text-gray-300 shadow-[0_10px_28px_rgba(0,0,0,0.34)] backdrop-blur-md transition hover:border-blue-300/40 hover:bg-[#152238]/84 hover:text-white"
        >
          {isFullscreen ? (
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 4H5v4" />
              <path d="M15 4h4v4" />
              <path d="M9 20H5v-4" />
              <path d="M15 20h4v-4" />
              <path d="M8 8 5 5" />
              <path d="m16 8 3-3" />
              <path d="m8 16-3 3" />
              <path d="m16 16 3 3" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H3v5" />
              <path d="M16 3h5v5" />
              <path d="M8 21H3v-5" />
              <path d="M16 21h5v-5" />
              <path d="m9 9-6-6" />
              <path d="m15 9 6-6" />
              <path d="m9 15-6 6" />
              <path d="m15 15 6 6" />
            </svg>
          )}
        </button>
        <QuadrantLayout
          topLeft={renderSeat(seatOrder[0])}
          topRight={renderSeat(seatOrder[1])}
          bottomRight={renderSeat(seatOrder[2])}
          bottomLeft={renderSeat(seatOrder[3])}
        />
      </div>

      {gameState && (
        <PhaseTrackerOverlay
          currentStep={currentStep}
          currentPhaseGroup={currentPhaseGroup}
          nextStepLabel={nextLabel}
          rightOffset={rightPanelOffset}
          onAdvance={handlePass}
          disabled={passDisabled}
          buttonLabel={passLabel}
        />
      )}
    </div>
  );
}

function PlaceholderSeat({ label, subtitle }: { label: string; subtitle?: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-[#161b22] text-gray-600">
      <div className="text-center">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-1 text-xs text-gray-700">{subtitle ?? "Waiting..."}</div>
      </div>
    </div>
  );
}

interface TopPhaseBarProps {
  turn: number;
  currentStep: TurnStepLabel;
  currentPhaseGroup: string;
  phaseIndex: number;
  activeSeatLabel: string;
  revision?: number;
}

function TopPhaseBar({
  turn,
  currentStep,
  currentPhaseGroup,
  phaseIndex,
  activeSeatLabel,
  revision,
}: TopPhaseBarProps) {
  const compactPhases = [
    { label: "Untap", match: ["Untap"] },
    { label: "Upkeep", match: ["Upkeep"] },
    { label: "Draw", match: ["Draw"] },
    { label: "Main 1", match: ["Precombat Main"] },
    { label: "Combat", match: ["Beginning of Combat", "Declare Attackers", "Declare Blockers", "Combat Damage", "End of Combat"] },
    { label: "Main 2", match: ["Postcombat Main"] },
    { label: "End", match: ["End Step", "Cleanup"] },
  ];

  return (
    <div className="hidden min-w-0 flex-1 items-center justify-center gap-3 px-4 lg:flex">
      <div className="shrink-0 text-right text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        <span className="text-amber-100">Turn {turn}</span>
        <span className="mx-2 text-slate-600">|</span>
        <span>{activeSeatLabel}</span>
        {typeof revision === "number" && <span className="ml-2 text-slate-600">rev {revision}</span>}
      </div>
      <div className="h-7 w-[min(620px,44vw)] overflow-hidden rounded-full border border-white/16 bg-[#050810]/82 shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_6px_18px_rgba(0,0,0,.36)]">
        <div className="grid h-full grid-cols-7">
          {compactPhases.map((phase) => {
            const firstIndex = TURN_STEP_SEQUENCE.findIndex((step) => phase.match.includes(step));
            const isCurrent = phase.match.includes(currentStep);
            const isPast = firstIndex >= 0 && firstIndex < phaseIndex;
            return (
              <div
                key={phase.label}
                title={`${currentPhaseGroup}: ${currentStep}`}
                className={`relative flex items-center justify-center border-r border-white/10 px-2 text-[9px] font-black uppercase tracking-[0.16em] last:border-r-0 ${
                  isCurrent
                    ? "bg-amber-400/24 text-amber-50 shadow-[inset_0_0_18px_rgba(245,158,11,.35)]"
                    : isPast
                      ? "text-slate-500"
                      : "text-slate-600"
                }`}
              >
                {phase.label}
                {isCurrent && <div className="absolute inset-x-5 bottom-0 h-px bg-amber-100" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface PhaseTrackerOverlayProps {
  currentStep: TurnStepLabel;
  currentPhaseGroup: string;
  nextStepLabel: string;
  rightOffset: number;
  onAdvance: () => void;
  disabled: boolean;
  buttonLabel: string;
}

function PhaseTrackerOverlay({
  currentStep,
  currentPhaseGroup,
  nextStepLabel,
  rightOffset,
  onAdvance,
  disabled,
  buttonLabel,
}: PhaseTrackerOverlayProps) {
  return (
    <div
      className="fixed bottom-4 z-40 w-[min(470px,calc(100vw-28px))]"
      style={{ right: `${16 + rightOffset}px` }}
    >
      <div
        className={`rounded-[24px] border p-3 backdrop-blur-md transition duration-200 ${
          disabled
            ? "border-white/12 bg-[linear-gradient(180deg,rgba(12,14,18,.72),rgba(5,7,11,.84))] shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_12px_30px_rgba(0,0,0,.42)]"
            : "border-amber-300/34 bg-[linear-gradient(180deg,rgba(20,15,10,.88),rgba(8,10,14,.94))] shadow-[inset_0_1px_0_rgba(255,255,255,.13),0_0_30px_rgba(245,158,11,.18),0_18px_42px_rgba(0,0,0,.52)]"
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-amber-300/24 bg-amber-500/14 text-[9px] font-black uppercase tracking-[0.12em] text-amber-200 shadow-inner">
            Step
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-[.18em] text-amber-200/65">
              {currentPhaseGroup}
            </div>
            <div className="truncate text-sm font-black text-white">
              {currentStep}
            </div>
            <div className="truncate text-xs text-slate-300">
              Next: {nextStepLabel}
            </div>
          </div>
          <button
            type="button"
            onClick={onAdvance}
            disabled={disabled}
            className={`shrink-0 rounded-[18px] border px-5 py-3 text-sm font-black transition active:scale-[.98] ${
              disabled
                ? "border-white/10 bg-white/5 text-slate-500 shadow-none"
                : "border-orange-200/60 bg-[linear-gradient(180deg,#ff9f43,#ea580c)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_0_22px_rgba(249,115,22,.42)] hover:brightness-110"
            }`}
          >
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
