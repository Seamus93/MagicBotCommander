import { describe, expect, it } from "vitest";
import {
  isPendingDecisionForState,
  validateActionAgainstDisplayedHand,
  type FilteredGameState,
  type PendingDecision,
} from "../hooks/useGameSession";
import { buildSpellTablePlayers } from "../pages/SpellTablePage";
import {
  sessionModeForEngineSession,
  shouldPublishViewerRulesState,
  shouldUseLocalShuffle,
} from "../sessionMode";

const engineState: FilteredGameState = {
  sessionId: "session-1",
  stateVersion: 7,
  turn: 3,
  phase: "Prima Fase Principale",
  phaseStep: "Prima Fase Principale",
  playerIndex: 0,
  startingPlayerIndex: 0,
  players: [
    {
      index: 0,
      position: "NORTH",
      life: 37,
      commander: "Captain",
      battlefield: ["Island"],
      creatures: [],
      graveyard: ["Opt"],
      exile: [],
      libraryCount: 91,
      handCount: 2,
      hand: ["Graven Cairns", "Dimir Aqueduct"],
      isHuman: true,
    },
    {
      index: 1,
      position: "EAST",
      life: 40,
      commander: "AI",
      battlefield: [],
      creatures: [],
      graveyard: [],
      exile: [],
      libraryCount: 93,
      handCount: 7,
      hand: [],
      isHuman: false,
    },
  ],
};

const matchingPending: PendingDecision = {
  sessionId: "session-1",
  stateVersion: 7,
  turn: 3,
  phase: "Prima Fase Principale",
  activePlayer: 0,
  decisionType: "action",
  context: {
    type: "action",
    availableActions: [
      { type: "PASS_TURN" },
      { type: "PLAY_LAND", card: "Graven Cairns" },
      { type: "CAST_SPELL", card: "Dimir Aqueduct" },
    ],
  },
};

const viewerState = {
  deckId: 12,
  turn: 99,
  life: 1,
  commander: "Viewer Commander",
  battlefield: ["Viewer Battlefield"],
  graveyard: ["Viewer Graveyard"],
  exile: ["Viewer Exile"],
  libraryCount: 1,
  commandZone: ["Viewer Commander"],
  handCount: 3,
  hand: ["Sunken Ruins", "Swamp", "Glasspool Mimic"],
  fullDeck: ["Viewer Commander", "Sunken Ruins"],
};

describe("engine-linked session sync", () => {
  it("uses the SimGameState hand as the displayed hand in engine-linked mode", () => {
    const players = buildSpellTablePlayers({
      mode: "engine-linked",
      viewerState,
      enginePlayers: engineState.players,
    });

    expect(players.get(0)?.hand).toEqual(["Graven Cairns", "Dimir Aqueduct"]);
    expect(players.get(0)?.battlefield).toEqual(["Island"]);
    expect(players.get(0)?.life).toBe(37);
  });

  it("does not let viewerState overwrite engine zones", () => {
    const players = buildSpellTablePlayers({
      mode: "engine-linked",
      viewerState,
      enginePlayers: engineState.players,
    });

    expect(players.get(0)?.hand).not.toContain("Sunken Ruins");
    expect(players.get(0)?.graveyard).toEqual(["Opt"]);
    expect(players.get(0)?.libraryCount).toBe(91);
  });

  it("keeps standalone mode on the local viewer state", () => {
    const players = buildSpellTablePlayers({
      mode: "standalone",
      viewerState,
      enginePlayers: engineState.players,
    });

    expect(players.get(0)?.hand).toEqual(["Sunken Ruins", "Swamp", "Glasspool Mimic"]);
    expect(players.get(0)?.life).toBe(1);
    expect(shouldUseLocalShuffle("standalone")).toBe(true);
    expect(shouldPublishViewerRulesState("standalone")).toBe(true);
  });

  it("requires pending decisions to match the displayed state version", () => {
    expect(isPendingDecisionForState(matchingPending, engineState)).toBe(true);
    expect(isPendingDecisionForState({ ...matchingPending, stateVersion: 6 }, engineState)).toBe(false);
  });

  it("requires available action cards to exist in the displayed hand", () => {
    expect(validateActionAgainstDisplayedHand({
      action: { type: "PLAY_LAND", card: "Graven Cairns" },
      gameState: engineState,
      pendingDecision: matchingPending,
    }).ok).toBe(true);

    expect(validateActionAgainstDisplayedHand({
      action: { type: "PLAY_LAND", card: "Sunken Ruins" },
      gameState: engineState,
      pendingDecision: matchingPending,
    })).toMatchObject({
      ok: false,
      reason: "state out of sync",
      stateVersion: 7,
      pendingStateVersion: 7,
    });
  });

  it("hides actions and rejects submit when a reconnect has a stale pending revision", () => {
    const refreshedState = { ...engineState, stateVersion: 8 };
    expect(isPendingDecisionForState(matchingPending, refreshedState)).toBe(false);
    expect(validateActionAgainstDisplayedHand({
      action: { type: "CAST_SPELL", card: "Dimir Aqueduct" },
      gameState: refreshedState,
      pendingDecision: matchingPending,
    }).ok).toBe(false);
  });

  it("derives mode explicitly from engine session presence", () => {
    expect(sessionModeForEngineSession(null)).toBe("standalone");
    expect(sessionModeForEngineSession("session-1")).toBe("engine-linked");
    expect(shouldUseLocalShuffle("engine-linked")).toBe(false);
    expect(shouldPublishViewerRulesState("engine-linked")).toBe(false);
  });
});
