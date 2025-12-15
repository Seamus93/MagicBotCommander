export type CardName = string;

export interface SimGameState {
  turn: number;
  playerIndex: number; // indice del giocatore che sta giocando (0..3)
  lifeTotals: number[]; // es: [40, 40, 40, 40]
  libraries: CardName[][];
  hands: CardName[][];
  battlefields: CardName[][];
  graveyards: CardName[][];
  commanders: CardName[];
}

export type SimAction =
  | { type: "PLAY_LAND"; card: CardName }
  | { type: "CAST_SPELL"; card: CardName }
  | { type: "PASS_TURN" };

export interface SimAgent {
  id: string;
  decideAction(
    state: SimGameState,
    availableActions: SimAction[]
  ): Promise<SimAction> | SimAction;
}

export interface SimulationOptions {
  maxTurns?: number;
  log?: (message: string) => void;
}

export interface SimulationResult {
  winnerIndex: number | null;
  history: { playerIndex: number; action: SimAction }[];
}
