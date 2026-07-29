import type { CreaturePermanent } from "@rules/combat/types";

export type CardName = string;

export interface CardFaceMetadata {
  name: string;
  typeLine?: string;
  oracleText?: string;
  manaValue?: number;
  power?: number;
  toughness?: number;
  colors?: string[];
  colorIdentity?: string[];
  isLand?: boolean;
  isCreature?: boolean;
  isPermanent?: boolean;
  entersTapped?: boolean;
  producesMana?: boolean;
  manaProduction?: number;
}

export interface DeckCardMetadata {
  name: string;
  typeLine?: string;
  oracleText?: string;
  manaValue?: number;
  power?: number;
  toughness?: number;
  isLand?: boolean;
  isCreature?: boolean;
  isArtifact?: boolean;
  isPermanent?: boolean;
  manaProduction?: number;
  producesMana?: boolean;
  entersTapped?: boolean;
  landFace?: CardFaceMetadata;
  spellFace?: CardFaceMetadata;
  aliases?: string[];
  colors?: string[];
  colorIdentity?: string[];
}

export type TriggerType = "OPPONENT_LAND_ADVANTAGE" | "OPPONENT_NONPLAY_LAND";

export interface RegisteredTrigger {
  id: string;
  controller: number;
  sourceCard: CardName;
  type: TriggerType;
  data?: Record<string, unknown>;
}

export interface StackEntry {
  id: string;
  action: SimAction;
  casterIndex: number;
  resolved: boolean;
  responses: StackEntry[];
}

export interface SimGameState {
  turn: number;
  playerIndex: number; // indice del giocatore che sta giocando (0..3)
  lifeTotals: number[]; // es: [40, 40, 40, 40]
  libraries: CardName[][];
  hands: CardName[][];
  battlefields: CardName[][];
  graveyards: CardName[][];
  commanders: CardName[];
  creatures: CreaturePermanent[][];
  artifacts: CardName[][];
  artifactMana: number[];
  manaSpent: number[];
  tappedPermanents?: Record<number, Record<string, number>>;
  cardMetadata: Record<string, DeckCardMetadata>[];
  triggers: RegisteredTrigger[];
  triggerCounter: number;
  phase: string;
  phaseStep: string;
  costReducers: Record<number, CostReducer[]>;
  handSizeModifiers: Record<number, HandSizeModifier[]>;
  drawHistory: Record<number, number>;
  stack: StackEntry[];
}

export interface CostReducer {
  id: string;
  sourceCard: CardName;
  amount: number;
  appliesTo: (options: {
    state: SimGameState;
    player: number;
    card: CardName;
    metadata?: DeckCardMetadata;
  }) => boolean;
}

export interface HandSizeModifier {
  id: string;
  sourceCard: CardName;
  noMax?: boolean;
  bonus?: number;
}

export type SimAction =
  | { type: "PLAY_LAND"; card: CardName }
  | { type: "CAST_SPELL"; card: CardName; targetStackId?: string }
  | { type: "PASS_TURN" }
  | { type: "ATTACK_CHOICE"; card: CardName; mode: "ATTACK" | "HOLD" }
  | { type: "BLOCK_CHOICE"; card: CardName; targetId: string | null }
  | { type: "DECLARE_ATTACKERS"; player: number; attackers: string[] }
  | {
      type: "DECLARE_BLOCKERS";
      player: number;
      assignments: BlockAssignment[];
    };

export type DecisionSource =
  | "policy"
  | "explore"
  | "decision_tree"
  | "ai"
  | "fallback"
  | "exact"
  | "fuzzy"
  | "heuristic";

export interface DecisionMetadata {
  source: DecisionSource;
  pattern?: string;
  actionKey?: string;
  reasoning?: string;
  confidence?: number;
  expectedReward?: number;
  visits?: number;
}

export interface AgentDecision {
  action: SimAction;
  metadata?: DecisionMetadata;
}

export interface AttackDecision {
  attackers: string[];
  metadata?: DecisionMetadata;
}

export interface BlockAssignment {
  blockerId: string;
  attackerId: string | null;
}

export interface BlockDecision {
  assignments: BlockAssignment[];
  metadata?: DecisionMetadata;
}

export interface AttackPlan {
  attackers: string[];
  targetPlayer: number;
  expectedDamage: number;
  expectedLosses: number;
  score: number;
}

export interface BlockPlan {
  assignments: Map<string, string[]>;
  creaturesKilled: number;
  creaturesKilledValue?: number;
  damagePrevented: number;
  totalIncomingDamage: number;
  blockersLost: number;
  blockersLostValue?: number;
  score: number;
}

export interface SimAgent {
  id: string;
  decideAction(
    state: SimGameState,
    availableActions: SimAction[]
  ): Promise<AgentDecision> | AgentDecision;
  decideTarget?(
    state: SimGameState,
    opponentIndices: number[]
  ): Promise<number> | number;
  decideAttackPlan?(
    state: SimGameState,
    plans: AttackPlan[]
  ): Promise<AttackPlan> | AttackPlan;
  decideBlockPlan?(
    state: SimGameState,
    plans: BlockPlan[]
  ): Promise<BlockPlan> | BlockPlan;
  decideAttackers?(
    state: SimGameState,
    availableAttackers: CreaturePermanent[]
  ): Promise<AttackDecision> | AttackDecision;
  decideBlockers?(
    state: SimGameState,
    attackers: CreaturePermanent[],
    availableBlockers: CreaturePermanent[]
  ): Promise<BlockDecision> | BlockDecision;
  decideMulligan?(
    hand: CardName[],
    mulliganCount: number
  ): Promise<{ keep: boolean; bottomCards?: CardName[] }> | { keep: boolean; bottomCards?: CardName[] };
  decideResponse?(
    state: SimGameState,
    triggeringEntry: StackEntry,
    availableInstants: SimAction[]
  ): Promise<SimAction | null> | SimAction | null;
}

export type GameEvent =
  | { type: "game_start" }
  | { type: "action_applied"; player: number; action: SimAction }
  | { type: "combat_resolved"; attacker: number; defender: number }
  | { type: "draw"; player: number }
  | { type: "turn_start"; turn: number; player: number }
  | { type: "phase_change"; phase: string; step: string }
  | { type: "mulligan_done"; player: number; mulliganCount: number }
  | { type: "game_over"; winner: number | null };

export interface SimulationOptions {
  maxTurns?: number;
  log?: (message: string) => void;
  playerArchetypes?: string[];
  playerDecks?: CardName[][];
  playerDeckMetadata?: DeckCardMetadata[][];
  playerCommanders?: Array<CardName | null | undefined>;
  startingPlayerIndex?: number;
  onStateChange?: (state: SimGameState, event: GameEvent) => void;
  enableStack?: boolean;
  phaseDelayMs?: number;
  actionDelayMs?: number;
  maxMulligans?: number;
  /** Maximum number of lands each player may play during one turn. Defaults to 1. */
  maxLandDrops?: number;
  /** Ms to wait between each player's turn for real-time viewing.
   *  0 (default) = no delay, runs at full speed (use for batch training).
   *  e.g. 1200 = 1.2 s per player turn, fully watchable in SpellTable. */
  turnDelayMs?: number;
}

export interface SimulationHistoryEntry {
  playerIndex: number;
  agentId: string;
  action: SimAction;
  state: SimGameState;
  availableActions: SimAction[];
  metadata?: DecisionMetadata;
  shapedReward?: number; // Phase 2: reward intermedio calcolato dal reward shaper
}

export interface SimulationResult {
  winnerIndex: number | null;
  history: SimulationHistoryEntry[];
  turns: number;
  finalState: SimGameState;
  metrics?: {
    missedLandDropOpportunity: number;
  };
}

export interface StateDigest {
  turn: number;
  phase: string;
  phaseStep: string;
  playerIndex: number;
  landPlayedThisTurn?: boolean;
  players: PlayerDigest[];
  battlefieldSummary: BattlefieldDigest[];
}

export interface PlayerDigest {
  index: number;
  life: number;
  handSize: number;
  libraryCount: number;
  graveyardCount: number;
  landsInPlay: number;
  artifactsInPlay: number;
  artifactMana: number;
  creatures: CreatureDigest[];
  commander?: CardName;
}

export interface CreatureDigest {
  name: string;
  power: number;
  toughness: number;
  tapped: boolean;
  summoningSickness: boolean;
}

export interface BattlefieldDigest {
  playerIndex: number;
  cards: CardName[];
}

export interface EpisodeActionContext {
  action: SimAction;
  wins: number;
  total: number;
  winRate: number;
  sampleStates: StateDigest[];
}
