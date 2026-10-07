import type { CardName, SimGameState } from "@game-state/types";
import { activeFaceMetadata, getCardFaceImageSide, getCardMetadata } from "../../../packages/game-state/src/cardUtils";
import type { CreaturePermanent } from "@rules/combat/types";
import {
  deriveCapabilities,
  type ControllerType,
  type ConnectionRole,
  type GameSessionSnapshot,
  type Seat,
  type SeatId,
  type SessionMode,
  type SessionRecipient,
  type ViewType,
} from "../../../packages/game-state/src/session";

export type PlayerPosition = "SOUTH" | "NORTH" | "EAST" | "WEST";
export type GameMode = "HUMAN_VS_AI" | "ALL_AI";
export type AgentType = "HUMAN" | "AI";
const POSITIONS_CLOCKWISE: PlayerPosition[] = ["NORTH", "EAST", "SOUTH", "WEST"];
const SEAT_IDS_CLOCKWISE: SeatId[] = ["northWest", "northEast", "southEast", "southWest"];

export interface PlayerDescriptor {
  playerIndex: number;
  seat: PlayerPosition;
  agentType: AgentType;
  displayName: string;
}

export interface FilteredPlayerState {
  playerId: string;
  seatId: SeatId;
  index: number;
  playerIndex: number;
  position: PlayerPosition;
  seat: PlayerPosition;
  controller: ControllerType;
  agentType: AgentType;
  displayName: string;
  life: number;
  commander: string;
  commandZone: CardName[];
  battlefield: string[];
  battlefieldPermanents?: Array<{
    name: string;
    tapped: boolean;
    isLand?: boolean;
    typeLine?: string;
    imageName?: CardName;
    imageFace?: "front" | "back";
  }>;
  creatures: CreaturePermanent[];
  graveyard: string[];
  exile: string[];
  libraryCount: number;
  handCount: number;
  hand?: string[];
  isHuman: boolean;
  isConceded?: boolean;
}

export interface FilteredGameState {
  sessionId?: string;
  stateVersion?: number;
  revision?: number;
  mode?: SessionMode;
  view?: ViewType;
  role?: ConnectionRole;
  capabilities?: ReturnType<typeof deriveCapabilities>;
  seats?: Seat[];
  gameMode: GameMode;
  turn: number;
  phase: string;
  phaseStep: string;
  playerIndex: number;
  startingPlayerIndex: number;
  players: FilteredPlayerState[];
  playerDescriptors: PlayerDescriptor[];
}

export function buildPlayerDescriptors(gameMode: GameMode, viewerIndex = 0, playerCount = 4): PlayerDescriptor[] {
  return Array.from({ length: playerCount }, (_, playerIndex) => {
    const seat = POSITIONS_CLOCKWISE[playerIndex % POSITIONS_CLOCKWISE.length];
    const agentType: AgentType = gameMode === "HUMAN_VS_AI" && playerIndex === viewerIndex ? "HUMAN" : "AI";
    return {
      playerIndex,
      seat,
      agentType,
      displayName: agentType === "HUMAN" ? "YOU" : `AI ${seat}`,
    };
  });
}

export function buildSeatsFromControllers(
  controllers: ControllerType[],
  playerCount = 4
): Seat[] {
  return Array.from({ length: playerCount }, (_, playerIndex) => {
    const controller = controllers[playerIndex] ?? "ai";
    const position = POSITIONS_CLOCKWISE[playerIndex % POSITIONS_CLOCKWISE.length];
    return {
      id: SEAT_IDS_CLOCKWISE[playerIndex % SEAT_IDS_CLOCKWISE.length],
      position,
      playerIndex,
      playerId: `p${playerIndex}`,
      controller,
      aiAgentId: controller === "ai" ? `ai-${playerIndex}` : undefined,
    };
  });
}

export function turnOrderFromStartingPlayer(startingPlayerIndex: number, playerCount = 4): number[] {
  return Array.from({ length: playerCount }, (_, offset) => (startingPlayerIndex + offset) % playerCount);
}

export function assignSeatsByTurnOrder(
  seats: Seat[],
  startingPlayerIndex: number
): Seat[] {
  const assigned = seats.map((seat) => ({ ...seat }));
  const turnOrder = turnOrderFromStartingPlayer(startingPlayerIndex, seats.length);

  turnOrder.forEach((playerIndex, turnOrderIndex) => {
    const seatIndex = assigned.findIndex((seat) => seat.playerIndex === playerIndex);
    if (seatIndex < 0) return;
    assigned[seatIndex] = {
      ...assigned[seatIndex],
      id: SEAT_IDS_CLOCKWISE[turnOrderIndex % SEAT_IDS_CLOCKWISE.length],
      position: POSITIONS_CLOCKWISE[turnOrderIndex % POSITIONS_CLOCKWISE.length],
    };
  });

  return assigned;
}

export function buildPlayerDescriptorsFromSeats(seats: Seat[]): PlayerDescriptor[] {
  return seats.map((seat) => ({
    playerIndex: seat.playerIndex,
    seat: seat.position,
    agentType: seat.controller === "human" ? "HUMAN" : "AI",
    displayName: seat.controller === "human" && seat.playerIndex === 0
      ? "YOU"
      : seat.controller === "human"
        ? `HUMAN ${seat.position}`
        : `AI ${seat.position}`,
  }));
}

export function serializeForViewer(
  state: SimGameState,
  viewerIndex = 0,
  startingPlayerIndex = 0,
  session?: {
    sessionId?: string;
    stateVersion?: number;
    gameMode?: GameMode;
    mode?: SessionMode;
    view?: ViewType;
    role?: ConnectionRole;
    seats?: Seat[];
    revealHands?: boolean;
    privatePlayerIndex?: number;
  }
): FilteredGameState {
  const gameMode = session?.gameMode ?? "HUMAN_VS_AI";
  const seats =
    session?.seats ??
    buildSeatsFromControllers(
      Array.from({ length: state.lifeTotals.length }, (_, i) =>
        gameMode === "HUMAN_VS_AI" && i === viewerIndex ? "human" : "ai"
      ),
      state.lifeTotals.length
    );
  const descriptors = session?.seats
    ? buildPlayerDescriptorsFromSeats(seats)
    : buildPlayerDescriptors(gameMode, viewerIndex, state.lifeTotals.length);
  const revealHands = session?.revealHands ?? true;
  const privatePlayerIndex = session?.privatePlayerIndex;
  const players: FilteredPlayerState[] = state.lifeTotals.map((life, i) => {
    const exileZone = (state as SimGameState & { exiles?: string[][] }).exiles?.[i] ?? [];
    const descriptor = descriptors[i];
    const seat = seats[i];
    const player: FilteredPlayerState = {
      playerId: seat?.playerId ?? `p${i}`,
      seatId: seat?.id ?? SEAT_IDS_CLOCKWISE[i % SEAT_IDS_CLOCKWISE.length],
      index: i,
      playerIndex: i,
      position: descriptor.seat,
      seat: descriptor.seat,
      controller: seat?.controller ?? (descriptor.agentType === "HUMAN" ? "human" : "ai"),
      agentType: descriptor.agentType,
      displayName: descriptor.displayName,
      life,
      commander: state.commanders[i] ?? "",
      commandZone: state.commandZone?.[i] ?? [],
      battlefield: state.battlefields[i] ?? [],
      battlefieldPermanents: serializeBattlefieldPermanents(state, i),
      creatures: (state.creatures[i] ?? []).map((creature) => {
        const permanent = state.permanents?.[i]?.find((candidate) => candidate.id === creature.id);
        if (!permanent) return creature;
        const metadata = getCardMetadata(state, i, permanent.cardName);
        const imageFace = getCardFaceImageSide(metadata, permanent.face ?? permanent.cardName);
        if (permanent.cardName === creature.name && !imageFace) return creature;
        return {
          ...creature,
          imageName: permanent.cardName,
          imageFace,
        };
      }),
      graveyard: state.graveyards[i] ?? [],
      exile: exileZone,
      libraryCount: state.libraries[i]?.length ?? 0,
      handCount: state.hands[i]?.length ?? 0,
      isHuman: descriptor.agentType === "HUMAN",
      isConceded: life <= 0,
    };
    if (revealHands || privatePlayerIndex === i) {
      player.hand = state.hands[i] ?? [];
    }
    return player;
  });

  return {
    sessionId: session?.sessionId,
    stateVersion: session?.stateVersion,
    revision: session?.stateVersion,
    mode: session?.mode,
    view: session?.view,
    role: session?.role,
    capabilities: session?.mode ? deriveCapabilities(session.mode) : undefined,
    seats,
    gameMode,
    turn: state.turn,
    phase: state.phase,
    phaseStep: state.phaseStep,
    playerIndex: state.playerIndex,
    startingPlayerIndex,
    players,
    playerDescriptors: descriptors,
  };
}

export function serializeForRecipient(
  state: SimGameState,
  startingPlayerIndex: number,
  params: {
    sessionId: string;
    stateVersion: number;
    mode: SessionMode;
    recipient: SessionRecipient;
    seats: Seat[];
    gameMode?: GameMode;
  }
): GameSessionSnapshot {
  const capabilities = deriveCapabilities(params.mode);
  const recipientSeat = params.recipient.seatId
    ? params.seats.find((seat) => seat.id === params.recipient.seatId)
    : params.recipient.playerId
      ? params.seats.find((seat) => seat.playerId === params.recipient.playerId)
      : undefined;
  const canRevealAllHands =
    capabilities.revealOpponentHands || params.recipient.role === "debug";
  const privatePlayerIndex =
    params.recipient.role === "player" ? recipientSeat?.playerIndex : undefined;
  const view: ViewType = params.recipient.role === "player" ? "player" : "table";
  const filtered = serializeForViewer(state, 0, startingPlayerIndex, {
    sessionId: params.sessionId,
    stateVersion: params.stateVersion,
    gameMode: params.gameMode ?? "HUMAN_VS_AI",
    mode: params.mode,
    view,
    role: params.recipient.role,
    seats: params.seats,
    revealHands: canRevealAllHands,
    privatePlayerIndex,
  });

  const activeSeat =
    params.seats.find((seat) => seat.playerIndex === state.playerIndex) ??
    params.seats[0];
  const privatePlayer =
    privatePlayerIndex === undefined
      ? undefined
      : {
          playerId: params.seats[privatePlayerIndex]?.playerId ?? `p${privatePlayerIndex}`,
          hand: state.hands[privatePlayerIndex] ?? [],
        };

  return {
    ...filtered,
    mode: params.mode,
    view,
    role: params.recipient.role,
    revision: params.stateVersion,
    stateVersion: params.stateVersion,
    capabilities,
    seats: params.seats,
    game: {
      turn: state.turn,
      phase: state.phase,
      phaseStep: state.phaseStep,
      activePlayerId: activeSeat?.playerId ?? `p${state.playerIndex}`,
      priorityPlayerId: activeSeat?.playerId ?? `p${state.playerIndex}`,
      activePlayerIndex: state.playerIndex,
      startingPlayerIndex,
    },
    privatePlayer,
  };
}

export function sessionMappingLog(gameMode: GameMode, descriptors: PlayerDescriptor[]): string {
  const lines = [`[Session]`, `mode=${gameMode}`];
  for (const descriptor of descriptors) {
    lines.push(
      `P${descriptor.playerIndex} seat=${descriptor.seat} agent=${descriptor.agentType} name=${descriptor.displayName}`
    );
  }
  return lines.join("\n");
}

function serializeBattlefieldPermanents(
  state: SimGameState,
  player: number
): Array<{
  name: string;
  tapped: boolean;
  isLand?: boolean;
  typeLine?: string;
  imageName?: CardName;
  imageFace?: "front" | "back";
}> {
  const tapped = { ...(state.tappedPermanents?.[player] ?? {}) };
  const permanents = [...(state.permanents?.[player] ?? [])];
  return (state.battlefields[player] ?? []).map((name) => {
    const permanentIndex = permanents.findIndex((permanent) =>
      (permanent.face ?? permanent.cardName) === name
    );
    if (permanentIndex >= 0) {
      const [permanent] = permanents.splice(permanentIndex, 1);
      const cardMetadata = getCardMetadata(state, player, permanent.cardName);
      const metadata = activeFaceMetadata(cardMetadata, name);
      const imageFace = getCardFaceImageSide(cardMetadata, name);
      return {
        name,
        tapped: permanent.tapped,
        isLand: landClassification(metadata),
        typeLine: metadata?.typeLine,
        ...(permanent.cardName !== name || imageFace ? { imageName: permanent.cardName, imageFace } : {}),
      };
    }
    const key = name.trim().toLowerCase();
    const tappedCount = tapped[key] ?? 0;
    const cardMetadata = getCardMetadata(state, player, name);
    const metadata = activeFaceMetadata(cardMetadata, name);
    const imageFace = getCardFaceImageSide(cardMetadata, name);
    const cardType = {
      isLand: landClassification(metadata),
      typeLine: metadata?.typeLine,
      ...(cardMetadata && (cardMetadata.name !== name || imageFace)
        ? { imageName: cardMetadata.name, imageFace }
        : {}),
    };
    if (tappedCount > 0) {
      tapped[key] = tappedCount - 1;
      return { name, tapped: true, ...cardType };
    }
    return { name, tapped: false, ...cardType };
  });
}

function landClassification(metadata: ReturnType<typeof getCardMetadata>) {
  if (!metadata) return undefined;
  if (metadata.typeLine?.toLowerCase().includes("land")) return true;
  if (metadata.landFace || metadata.faces?.some((face) => face.isLand)) return true;
  return metadata.isLand;
}
