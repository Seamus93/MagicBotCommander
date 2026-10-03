import type { CardName, SimAction } from "./types";
import type { CreaturePermanent } from "@rules/combat/types";

export type SessionMode = "game" | "debug";
export type ControllerType = "human" | "ai";
export type ViewType = "player" | "table";
export type ConnectionRole = ViewType | "debug";

export type SeatId = "northWest" | "northEast" | "southWest" | "southEast";
export type LegacySeatPosition = "NORTH" | "EAST" | "SOUTH" | "WEST";

export interface Seat {
  id: SeatId;
  position: LegacySeatPosition;
  playerIndex: number;
  playerId: string;
  controller: ControllerType;
  deckId?: string;
  connectionId?: string;
  aiAgentId?: string;
}

export interface SessionCapabilities {
  revealOpponentHands: boolean;
  showEngineState: boolean;
  showAiControls: boolean;
  showDebugLogs: boolean;
  allowForceActions: boolean;
}

export interface PlayerPublicState {
  playerId: string;
  seatId: SeatId;
  index: number;
  playerIndex: number;
  position: LegacySeatPosition;
  seat: LegacySeatPosition;
  controller: ControllerType;
  agentType: "HUMAN" | "AI";
  displayName: string;
  life: number;
  commander: CardName;
  battlefield: CardName[];
  battlefieldPermanents?: Array<{ name: CardName; tapped: boolean }>;
  creatures: CreaturePermanent[];
  graveyard: CardName[];
  exile: CardName[];
  libraryCount: number;
  handCount: number;
  isHuman: boolean;
  isConceded?: boolean;
}

export interface PlayerPrivateState {
  playerId: string;
  hand: CardName[];
}

export interface SessionGameSummary {
  turn: number;
  phase: string;
  phaseStep: string;
  activePlayerId: string;
  priorityPlayerId?: string;
  activePlayerIndex: number;
  startingPlayerIndex: number;
}

export interface GameSessionSnapshot {
  sessionId?: string;
  mode: SessionMode;
  view: ViewType;
  role: ConnectionRole;
  revision?: number;
  stateVersion?: number;
  capabilities: SessionCapabilities;
  seats: Seat[];
  game: SessionGameSummary;
  players: Array<PlayerPublicState & { hand?: CardName[] }>;
  privatePlayer?: PlayerPrivateState;
  playerDescriptors: Array<{
    playerIndex: number;
    seat: LegacySeatPosition;
    agentType: "HUMAN" | "AI";
    displayName: string;
  }>;
  turn: number;
  phase: string;
  phaseStep: string;
  playerIndex: number;
  startingPlayerIndex: number;
  gameMode?: "HUMAN_VS_AI" | "ALL_AI";
}

export interface SessionRecipient {
  role: ConnectionRole;
  seatId?: SeatId;
  playerId?: string;
  playerToken?: string;
}

export type ClientGameMessage =
  | { type: "JOIN_SESSION"; sessionId: string; role: ConnectionRole; seatId?: SeatId; playerId?: string }
  | { type: "REQUEST_SNAPSHOT"; knownRevision?: number }
  | { type: "PLAYER_ACTION"; action: unknown; stateVersion?: number; revision?: number }
  | { type: "PASS_PRIORITY"; stateVersion?: number; revision?: number }
  | { type: "SUBMIT_ATTACK_PLAN"; plan: unknown; stateVersion?: number; revision?: number }
  | { type: "SUBMIT_BLOCK_PLAN"; plan: unknown; stateVersion?: number; revision?: number }
  | { type: "SUBMIT_MULLIGAN"; keep: boolean; bottomCards?: CardName[]; stateVersion?: number; revision?: number }
  | { type: "SUBMIT_TARGET"; targetIndex: number; stateVersion?: number; revision?: number }
  | { type: "SUBMIT_RESPONSE"; action: unknown; stateVersion?: number; revision?: number }
  | { type: "CONCEDE"; stateVersion?: number; revision?: number }
  | { type: "submit_action"; action: unknown; stateVersion?: number }
  | { type: "submit_attack_plan"; plan: unknown; stateVersion?: number }
  | { type: "submit_block_plan"; plan: unknown; stateVersion?: number }
  | { type: "submit_mulligan"; keep: boolean; bottomCards?: CardName[]; stateVersion?: number }
  | { type: "submit_target"; targetIndex: number; stateVersion?: number }
  | { type: "submit_response"; action: unknown; stateVersion?: number }
  | { type: "concede"; stateVersion?: number };

export type ServerGameMessage =
  | { type: "SESSION_JOINED"; sessionId: string; role: ConnectionRole; seatId?: SeatId; playerId?: string; capabilities: SessionCapabilities }
  | { type: "GAME_SNAPSHOT"; sessionId?: string; revision?: number; state: GameSessionSnapshot }
  | { type: "PRIVATE_PLAYER_STATE"; sessionId?: string; revision?: number; player: PlayerPrivateState }
  | { type: "LEGAL_ACTIONS"; sessionId?: string; revision?: number; playerId: string; actions: SimAction[] }
  | { type: "GAME_EVENT"; sessionId?: string; revision?: number; message: string }
  | { type: "ERROR"; code: string; message: string };

export function deriveCapabilities(mode: SessionMode): SessionCapabilities {
  return mode === "debug"
    ? {
        revealOpponentHands: true,
        showEngineState: true,
        showAiControls: true,
        showDebugLogs: true,
        allowForceActions: true,
      }
    : {
        revealOpponentHands: false,
        showEngineState: false,
        showAiControls: false,
        showDebugLogs: false,
        allowForceActions: false,
      };
}
