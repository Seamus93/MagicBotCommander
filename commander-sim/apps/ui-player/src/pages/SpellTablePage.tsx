import { useEffect, useMemo, useRef, useState } from "react";
import QuadrantLayout from "../components/spelltable/QuadrantLayout";
import PlayerQuadrant from "../components/spelltable/PlayerQuadrant";
import type { QuadrantPlayerData } from "../components/spelltable/PlayerQuadrant";
import GameLog from "../components/game/GameLog";
import { useViewerState } from "../hooks/useViewerState";
import { useViewerControl } from "../hooks/useViewerControl";
import { useGameSession, type FilteredPlayerState, type PendingDecision } from "../hooks/useGameSession";
import { publishSharedGameSession } from "../hooks/useSharedGameSession";
import { sessionModeForEngineSession, type SessionMode } from "../sessionMode";

const GAME_SERVER_URL =
  (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ??
  "http://localhost:5300";
const VIEWER_STATE_URL =
  (import.meta.env.VITE_VIEWER_STATE_URL as string | undefined) ??
  "http://localhost:3001";

const SESSION_STORAGE_ID_KEY = "spelltable_game_session";
const SESSION_STORAGE_SETUP_KEY = "spelltable_game_setup";
const LOG_DRAWER_WIDTH = 320;
const SIDE_PANEL_WIDTH = 224;

function cardImageUrl(name: string) {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal`;
}

function broadcastViewerRestart() {
  return fetch(`${VIEWER_STATE_URL}/viewer-control/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restartToken: Date.now() }),
  }).catch(() => {
    // The main UI may be offline; do not block New Game.
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

function aiToQuadrant(p: FilteredPlayerState): QuadrantPlayerData {
  return {
    label: `AI ${p.position}`,
    life: p.life,
    commander: p.commander,
    battlefield: p.battlefield,
    battlefieldPermanents: p.battlefieldPermanents,
    creatures: p.creatures,
    graveyard: p.graveyard,
    exile: p.exile,
    libraryCount: p.libraryCount,
    handCount: p.handCount,
    hand: p.hand ?? [],
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
    entries.push([player.index, aiToQuadrant(player)]);
  }
  return new Map<number, QuadrantPlayerData>(entries);
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
}

function DeckLobby({ onStart, myDeckId, myCommander, myFullDeck }: DeckLobbyProps) {
  const [dbDecks, setDbDecks] = useState<DbDeck[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selections, setSelections] = useState<[string, string, string]>(["", "", ""]);

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

  const labels = ["AI North", "AI East", "AI West"];
  const colors = [ACCENT.north, ACCENT.east, ACCENT.west];
  const viewerDeckOptionValue = myDeckId ? `db:${myDeckId}` : "__viewer__";
  const canUseViewerDeck = Boolean(myFullDeck?.length && myCommander);

  return (
    <div className="flex h-screen items-center justify-center bg-[#0d1117] text-white">
      <div className="w-[min(600px,92%)] rounded-2xl border border-white/10 bg-[#161b22] p-6 shadow-2xl">
        <h1 className="mb-1 text-lg font-bold">New SpellTable Match</h1>
        <p className="mb-5 text-sm text-gray-500">
          Your board still comes from MoxfieldUI. Choose decks for the 3 AI opponents here.
        </p>

        <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-900/20 p-3 text-sm">
          <span className="font-semibold text-blue-400">You: </span>
          <span className="text-white">
            {myDeckId ? myCommander ?? `Deck #${myDeckId}` : "Default deck"}
          </span>
        </div>

        {loading ? (
          <div className="py-4 text-sm text-gray-500">Loading decks from database...</div>
        ) : (
          <div className="mb-6 space-y-3">
            {labels.map((label, i) => (
              <div key={label} className="flex items-center gap-3">
                <span className={`w-20 text-xs font-semibold ${colors[i].text}`}>{label}</span>
                <select
                  className="flex-1 rounded border border-white/10 bg-[#0d1117] px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
                  value={selections[i] ?? ""}
                  onChange={(e) => setSlot(i as 0 | 1 | 2, e.target.value)}
                >
                  <option value="">
                    {canUseViewerDeck || myDeckId ? "Default (your deck)" : "Default (Basic Deck)"}
                  </option>
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
                </select>
              </div>
            ))}
          </div>
        )}

        {!loading && dbDecks.length > 0 && (
          <div className="mb-5 max-h-40 overflow-auto rounded-lg border border-white/10 bg-[#0d1117]/80 p-2">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Deck database</div>
            {deleteError && <div className="mb-2 text-xs text-red-300">{deleteError}</div>}
            <div className="space-y-1">
              {dbDecks.map((deck) => {
                const label = deck.name ?? deck.commander ?? `Deck #${deck.id}`;
                return (
                  <div key={deck.id} className="flex items-center justify-between gap-2 rounded bg-white/5 px-2 py-1 text-xs">
                    <span className="min-w-0 truncate">
                      #{deck.id} {label}
                      {typeof deck.cardCount === "number" ? ` · ${deck.cardCount} cards` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => deleteDeck(deck)}
                      disabled={deletingId === deck.id}
                      className="shrink-0 rounded border border-red-800/70 px-2 py-0.5 text-red-300 hover:bg-red-950 disabled:opacity-50"
                    >
                      {deletingId === deck.id ? "..." : "Delete"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={() => {
              const aiDeckIds: number[] = [];
              const aiDecks: string[][] = [];

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
                humanDeckId: myDeckId ?? null,
                humanDeck: myFullDeck?.length ? [...myFullDeck] : null,
                aiDeckIds,
                aiDecks,
              });
            }}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
          >
            Start Match
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SpellTablePage() {
  const storedSetup = getStoredSetup();
  const [gameStarted, setGameStarted] = useState(
    () => sessionStorage.getItem(SESSION_STORAGE_ID_KEY) !== null
  );
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem(SESSION_STORAGE_ID_KEY)
  );
  const [humanDeckId, setHumanDeckId] = useState<number | null>(storedSetup.humanDeckId);
  const [humanDeck, setHumanDeck] = useState<string[] | null>(storedSetup.humanDeck ?? null);
  const [selectedDeckIds, setSelectedDeckIds] = useState<number[]>(storedSetup.aiDeckIds);
  const [selectedAiDecks, setSelectedAiDecks] = useState<string[][]>(storedSetup.aiDecks ?? []);
  const [showLog, setShowLog] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [selectedCardName, setSelectedCardName] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== "undefined" && document.fullscreenElement !== null
  );
  const [playerCounters, setPlayerCounters] = useState<Record<number, PlayerCounters>>(
    createDefaultCounters
  );
  const [creatingSession, setCreatingSession] = useState(false);
  const [aiResetKey, setAiResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const lastRestartTokenRef = useRef<number | string | null>(null);

  const viewerState = useViewerState(1500);
  const viewerControl = useViewerControl(900);
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
  } = useGameSession(sessionId);

  const savedDeckIdRaw = localStorage.getItem("savedDeckId");
  const savedDeckId = savedDeckIdRaw ? Number(savedDeckIdRaw) : null;
  const lobbyDeckId = (viewerState?.deckId ?? savedDeckId) || null;
  const lobbyCommander = viewerState?.commander ?? viewerState?.commandZone?.[0] ?? null;
  const lobbyFullDeck = viewerState?.fullDeck ?? null;

  const players = gameState?.players ?? [];
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
  const startingPlayerIndex = gameState?.startingPlayerIndex ?? 0;
  const displayTurn = gameState?.turn ?? viewerState?.turn ?? 1;
  const currentStep = toDisplayStep(gameState?.phase ?? "", gameState?.phaseStep ?? "");
  const currentPhaseGroup = toDisplayPhaseGroup(currentStep);
  const phaseIndex = TURN_STEP_SEQUENCE.indexOf(currentStep);
  const nextLabel = nextStepLabel(currentStep);
  const seatOrder = useMemo(
    () => [0, 1, 2, 3].map((offset) => (startingPlayerIndex + offset) % 4),
    [startingPlayerIndex]
  );
  const activeSeatIndex = useMemo(
    () => seatOrder.indexOf(activePlayerIndex),
    [seatOrder, activePlayerIndex]
  );
  const activeSeatLabel = activeSeatIndex >= 0 ? `P${activeSeatIndex}` : `P${activePlayerIndex}`;
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

  const handleStart = ({ humanDeckId: nextHumanDeckId, humanDeck: nextHumanDeck, aiDeckIds, aiDecks }: DeckStartConfig) => {
    sessionStorage.removeItem(SESSION_STORAGE_ID_KEY);
    sessionStorage.setItem(
      SESSION_STORAGE_SETUP_KEY,
      JSON.stringify({
        humanDeckId: nextHumanDeckId,
        humanDeck: nextHumanDeck,
        aiDeckIds,
        aiDecks,
      })
    );
    setHumanDeckId(nextHumanDeckId);
    setHumanDeck(nextHumanDeck);
    setSelectedDeckIds(aiDeckIds);
    setSelectedAiDecks(aiDecks);
    setSessionId(null);
    setError(null);
    setPlayerCounters(createDefaultCounters());
    setAiResetKey((prev) => prev + 1);
    setGameStarted(true);
  };

  useEffect(() => {
    if (!gameStarted) return;
    if (sessionId || creatingSession) return;

    let active = true;
    setCreatingSession(true);
    setError(null);

    const body: Record<string, unknown> = {};
    if (humanDeckId) body.humanDeckId = humanDeckId;
    if (!humanDeckId && humanDeck?.length) body.humanDeck = humanDeck;
    if (selectedDeckIds.length > 0) body.aiDeckIds = selectedDeckIds;
    if (selectedAiDecks.length > 0) body.aiDecks = selectedAiDecks;

    fetch(`${GAME_SERVER_URL}/game/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((data: { sessionId?: string; error?: string }) => {
        if (!active) return;
        if (!data.sessionId) {
          throw new Error(data.error ?? "Could not create SpellTable session.");
        }
        sessionStorage.setItem(SESSION_STORAGE_ID_KEY, data.sessionId);
        setSessionId(data.sessionId);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setGameStarted(false);
      })
      .finally(() => {
        if (active) setCreatingSession(false);
      });

    return () => {
      active = false;
    };
  }, [gameStarted, humanDeck, humanDeckId, selectedDeckIds, selectedAiDecks, sessionId, aiResetKey]);

  useEffect(() => {
    if (!gameStarted) return;
    if (!viewerControl?.restartToken) return;

    if (lastRestartTokenRef.current === null) {
      lastRestartTokenRef.current = viewerControl.restartToken;
      return;
    }
    if (lastRestartTokenRef.current === viewerControl.restartToken) return;

    lastRestartTokenRef.current = viewerControl.restartToken;
    if (sessionId) {
      void fetch(`${GAME_SERVER_URL}/game/${sessionId}/concede`, { method: "POST" }).catch(() => {});
    }
    sessionStorage.removeItem(SESSION_STORAGE_ID_KEY);
    setSessionId(null);
    setError(null);
    setPlayerCounters(createDefaultCounters());
    setAiResetKey((prev) => prev + 1);
  }, [gameStarted, sessionId, viewerControl?.restartToken]);

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

  const handleCardDoubleClick = (cardName: string) => {
    setSelectedCardName(cardName);
    setShowSidebar(true);
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

  useEffect(() => {
    void publishSharedGameSession(sessionId, "spelltable").catch(() => {
      // Cross-UI bridge is optional during local dev.
    });
  }, [sessionId]);

  const renderSeat = (playerIndex: number) => {
    const player = playersByIndex.get(playerIndex);
    const accent =
      playerIndex === 0
        ? ACCENT.human
        : playerIndex === 1
          ? ACCENT.north
          : playerIndex === 2
            ? ACCENT.east
            : ACCENT.west;

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

  if (!gameStarted) {
    return (
      <DeckLobby
        onStart={handleStart}
        myDeckId={lobbyDeckId}
        myCommander={lobbyCommander}
        myFullDeck={lobbyFullDeck}
      />
    );
  }

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-[#0d1117]">
      <div
        className="flex shrink-0 items-center justify-between border-b border-white/10 bg-[#161b22] px-3 py-1.5"
      >
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            SpellTable Viewer
          </span>
          {sessionId && (
            <span className="text-[11px] text-gray-600">
              Session: {sessionId.slice(0, 10)}...
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              hasHumanData ? "bg-blue-900/50 text-blue-400" : "bg-gray-800 text-gray-600"
            }`}
          >
            {mode === "engine-linked"
              ? hasHumanData ? "Engine Hand" : "Waiting for engine"
              : hasHumanData ? "MoxfieldUI Live" : "No human data"}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              mode === "engine-linked" ? "bg-cyan-900/50 text-cyan-300" : "bg-gray-800 text-gray-500"
            }`}
          >
            {mode}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              isConnected ? "bg-green-900/50 text-green-400" : "bg-gray-800 text-gray-600"
            }`}
          >
            {statusLabel}
          </span>
        </div>

        {gameState && (
          <div className="text-[11px] text-gray-400">
            Turn {displayTurn} | {currentPhaseGroup} - {currentStep} | {activeSeatLabel}
            {typeof gameState.stateVersion === "number" ? ` | rev ${gameState.stateVersion}` : ""}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              void broadcastViewerRestart();
              if (sessionId) {
                void fetch(`${GAME_SERVER_URL}/game/${sessionId}/concede`, { method: "POST" }).catch(() => {});
              }
              sessionStorage.removeItem(SESSION_STORAGE_ID_KEY);
              sessionStorage.removeItem(SESSION_STORAGE_SETUP_KEY);
              setSessionId(null);
              setHumanDeckId(null);
              setSelectedDeckIds([]);
              setError(null);
              setPlayerCounters(createDefaultCounters());
              setGameStarted(false);
            }}
            className="rounded bg-gray-800 px-2 py-1 text-[11px] text-gray-400 hover:text-white"
          >
            New Game
          </button>
          <button
            onClick={() => setShowLog((value) => !value)}
            className={`rounded px-2 py-1 text-[11px] ${
              showLog ? "bg-blue-700 text-white" : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            Log
          </button>
          <button
            onClick={() => setShowSidebar((value) => !value)}
            aria-label="Open side panel"
            className={`flex h-7 w-8 items-center justify-center rounded border transition ${
              showSidebar
                ? "border-blue-500/40 bg-blue-700/30 text-white"
                : "border-white/10 bg-gray-800 text-gray-400 hover:text-white"
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
                sessionStorage.removeItem(SESSION_STORAGE_ID_KEY);
                sessionStorage.removeItem(SESSION_STORAGE_SETUP_KEY);
                setSessionId(null);
                setHumanDeckId(null);
                setSelectedDeckIds([]);
                setError(null);
                setPlayerCounters(createDefaultCounters());
                setGameStarted(false);
              }}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
            >
              New Game
            </button>
          </div>
        </div>
      )}

      {stateOutOfSyncMessage && (
        <div className="fixed left-1/2 top-12 z-50 -translate-x-1/2 rounded border border-red-500/40 bg-red-950/90 px-3 py-2 text-xs font-semibold text-red-100 shadow-xl">
          {stateOutOfSyncMessage}
        </div>
      )}

      {showLog && (
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
            <GameLog messages={gameLog} />
          </div>
        </div>
      )}

      {showSidebar && (
        <div className="fixed top-10 right-0 bottom-0 z-20 w-56 border-l border-white/10 bg-[linear-gradient(180deg,rgba(20,24,36,0.98)_0%,rgba(10,13,22,0.98)_100%)] shadow-2xl">
          <div className="flex h-full flex-col px-3 py-3">
            {selectedCardName ? (
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="mx-auto w-full max-w-[210px]">
                  <img
                    src={cardImageUrl(selectedCardName)}
                    alt={selectedCardName}
                    className="w-full rounded-[10px] shadow-2xl"
                    loading="lazy"
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-gray-500">
                  Double click any visible card on the table to open it here.
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
          phaseIndex={phaseIndex}
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

interface PhaseTrackerOverlayProps {
  currentStep: TurnStepLabel;
  currentPhaseGroup: string;
  phaseIndex: number;
  nextStepLabel: string;
  rightOffset: number;
  onAdvance: () => void;
  disabled: boolean;
  buttonLabel: string;
}

function PhaseTrackerOverlay({
  currentStep,
  currentPhaseGroup,
  phaseIndex,
  nextStepLabel,
  rightOffset,
  onAdvance,
  disabled,
  buttonLabel,
}: PhaseTrackerOverlayProps) {
  return (
    <div
      className="fixed bottom-4 z-40 w-[min(360px,calc(100vw-24px))]"
      style={{ right: `${16 + rightOffset}px` }}
    >
      <div className="flex flex-col items-center">
        <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
          {TURN_STEP_SEQUENCE.map((phase, index) => {
            const isCurrent = index === phaseIndex;
            const isCombat =
              phase === "Beginning of Combat" ||
              phase === "Declare Attackers" ||
              phase === "Declare Blockers" ||
              phase === "Combat Damage" ||
              phase === "End of Combat";
            const isMain = phase === "Precombat Main" || phase === "Postcombat Main";
            const isEdge = phase === "Untap" || phase === "Cleanup";
            const isPassive = phase === "Upkeep" || phase === "Draw" || phase === "End Step";

            return (
              <div
                key={phase}
                title={phase}
                className={`relative flex h-5 min-w-[18px] items-center justify-center ${
                  isCurrent ? "scale-110 opacity-100" : "opacity-65"
                }`}
              >
                {isEdge && (
                  <div
                    className={`h-2 w-2 rotate-45 rounded-[2px] border ${
                      isCurrent
                        ? "border-cyan-200 bg-cyan-300 shadow-[0_0_16px_rgba(96,165,250,0.8)]"
                        : "border-blue-300/35 bg-slate-950"
                    }`}
                  />
                )}
                {isPassive && (
                  <div
                    className={`h-2 w-2 rounded-full border ${
                      isCurrent
                        ? "border-cyan-200 bg-cyan-200 shadow-[0_0_16px_rgba(96,165,250,0.8)]"
                        : "border-blue-300/35 bg-slate-950"
                    }`}
                  />
                )}
                {isMain && (
                  <div
                    className={`h-4 w-3 rounded-[3px] border ${
                      isCurrent
                        ? "border-cyan-100 bg-white shadow-[0_0_22px_rgba(96,165,250,0.85)]"
                        : "border-blue-300/35 bg-slate-950"
                    }`}
                  />
                )}
                {isCombat && (
                  <div className={`text-sm leading-none ${isCurrent ? "text-cyan-100 drop-shadow-[0_0_10px_rgba(96,165,250,0.9)]" : "text-slate-900"}`}>
                    ⚔
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onAdvance}
          disabled={disabled}
          className={`mx-auto w-[min(132px,100%)] rounded-[999px] border px-3 py-1.5 text-center transition ${
            disabled
              ? "border-white/10 bg-transparent text-gray-500 shadow-none"
              : "border-blue-200/40 bg-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_18px_rgba(72,115,255,0.28)] hover:scale-[1.01] hover:border-cyan-100/55 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.24),0_0_24px_rgba(72,115,255,0.38)]"
          }`}
        >
          <div className="text-xs font-semibold uppercase tracking-wider text-white [text-shadow:0_0_12px_rgba(255,255,255,0.18),0_0_20px_rgba(96,165,250,0.2)]">
            {buttonLabel}
          </div>
        </button>

        <div className="mt-2 text-center">
          <div className="text-[10px] uppercase tracking-[0.18em] text-blue-200/55">
            {currentPhaseGroup}
          </div>
          <div className="mt-1 text-sm font-semibold text-white">
            {currentStep}
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            To {nextStepLabel}
          </div>
        </div>
      </div>
    </div>
  );
}
