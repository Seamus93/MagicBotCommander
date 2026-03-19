import type { SimGameState } from "@game-state/types";
import type { CreaturePermanent } from "@rules/combat/types";

export type PlayerPosition = "SOUTH" | "NORTH" | "EAST" | "WEST";
const POSITIONS_CLOCKWISE: PlayerPosition[] = ["NORTH", "EAST", "SOUTH", "WEST"];

export interface FilteredPlayerState {
  index: number;
  position: PlayerPosition;
  life: number;
  commander: string;
  battlefield: string[];
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

export function serializeForViewer(
  state: SimGameState,
  viewerIndex = 0,
  startingPlayerIndex = 0
): FilteredGameState {
  const players: FilteredPlayerState[] = state.lifeTotals.map((life, i) => {
    const isViewer = i === viewerIndex;
    const exileZone = (state as SimGameState & { exiles?: string[][] }).exiles?.[i] ?? [];
    const seatOffset =
      ((i - startingPlayerIndex) % POSITIONS_CLOCKWISE.length + POSITIONS_CLOCKWISE.length) %
      POSITIONS_CLOCKWISE.length;
    return {
      index: i,
      position: POSITIONS_CLOCKWISE[seatOffset],
      life,
      commander: state.commanders[i] ?? "",
      battlefield: state.battlefields[i] ?? [],
      creatures: state.creatures[i] ?? [],
      graveyard: state.graveyards[i] ?? [],
      exile: exileZone,
      libraryCount: state.libraries[i]?.length ?? 0,
      handCount: state.hands[i]?.length ?? 0,
      hand: state.hands[i] ?? [],
      isHuman: isViewer,
    };
  });

  return {
    turn: state.turn,
    phase: state.phase,
    phaseStep: state.phaseStep,
    playerIndex: state.playerIndex,
    startingPlayerIndex,
    players,
  };
}
