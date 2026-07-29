import type { CreaturePermanent } from "@rules/combat/types";

export type CardName = string;

export interface CardFaceMetadata {
  name: string;
  typeLine?: string;
  manaCost?: string;
  oracleText?: string;
  manaValue?: number;
  power?: number;
  toughness?: number;
  colors?: string[];
  colorIdentity?: string[];
  isLand?: boolean;
  isCreature?: boolean;
  isInstant?: boolean;
  isSorcery?: boolean;
  isArtifact?: boolean;
  isEnchantment?: boolean;
  isPlaneswalker?: boolean;
  isPermanent?: boolean;
  entersTapped?: boolean;
  producesMana?: boolean;
  manaProduction?: number;
  keywords?: string[];
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
  isInstant?: boolean;
  isSorcery?: boolean;
  keywords?: string[];
  isPermanent?: boolean;
  manaProduction?: number;
  producesMana?: boolean;
  entersTapped?: boolean;
  faces?: CardFaceMetadata[];
  landFace?: CardFaceMetadata;
  spellFace?: CardFaceMetadata;
  unsupportedEffect?: boolean;
  rulesCoverage?: RulesCoverageLevel;
  aliases?: string[];
  colors?: string[];
  colorIdentity?: string[];
}

export type RulesCoverageLevel = "FULL" | "PARTIAL" | "UNSUPPORTED";

export interface PermanentState {
  id: string;
  cardName: CardName;
  owner: number;
  controller: number;
  face?: string;
  tapped: boolean;
  token?: boolean;
  counters?: Record<string, number>;
  keywords?: string[];
  damageMarked?: number;
  summoningSickness?: boolean;
  skipUntapUntilTurn?: number;
}

export type RulesEventType =
  | "PERMANENT_ENTERED"
  | "PERMANENT_LEFT"
  | "CREATURE_DIED"
  | "LAND_PLAYED"
  | "SPELL_CAST"
  | "SPELL_RESOLVED"
  | "CARD_DRAWN"
  | "DAMAGE_DEALT"
  | "COMBAT_DAMAGE_DEALT"
  | "LIFE_GAINED"
  | "TURN_STARTED"
  | "UPKEEP_STARTED"
  | "ATTACKER_DECLARED"
  | "BLOCKER_DECLARED";

export interface RulesEvent {
  type: RulesEventType;
  player?: number;
  controller?: number;
  sourceCard?: CardName;
  card?: CardName;
  face?: string;
  permanentId?: string;
  amount?: number;
  targetPlayer?: number;
  targetPermanentId?: string;
  data?: Record<string, unknown>;
}

export type EffectPrimitiveType =
  | "DRAW_CARDS"
  | "DISCARD"
  | "GAIN_LIFE"
  | "LOSE_LIFE"
  | "DEAL_DAMAGE"
  | "DESTROY"
  | "EXILE"
  | "RETURN_TO_HAND"
  | "RETURN_FROM_GRAVEYARD_TO_HAND"
  | "RETURN_FROM_GRAVEYARD_TO_BATTLEFIELD"
  | "MILL"
  | "CREATE_TOKEN"
  | "ADD_COUNTER"
  | "REMOVE_COUNTER"
  | "TAP"
  | "UNTAP"
  | "ADD_MANA"
  | "SEARCH_LIBRARY"
  | "SACRIFICE"
  | "GAIN_CONTROL"
  | "MODIFY_POWER_TOUGHNESS"
  | "GRANT_KEYWORD";

export interface EffectDescriptor {
  type: EffectPrimitiveType;
  amount?: number;
  target?: "self" | "opponent" | "targetCreature" | "targetPermanent" | "eachOpponent" | "eachPlayer" | "eachCreature";
  optional?: boolean;
  token?: {
    name: string;
    power?: number;
    toughness?: number;
    count?: number | "X";
    countMode?: "fixed" | "x" | "forEach";
    countSubject?: string;
    types?: string[];
    subtypes?: string[];
    colors?: string[];
    tapped?: boolean;
    attacking?: boolean;
    abilities?: string[];
  };
  counterType?: string;
  fromZone?: "library" | "graveyard" | "battlefield" | "hand";
  toZone?: "hand" | "battlefield" | "graveyard" | "exile" | "library";
  subtype?: string;
  cardType?: "creature" | "artifact" | "enchantment" | "permanent" | "card";
  controller?: "self" | "opponent" | "any";
  duration?: "PERMANENT" | "UNTIL_END_OF_TURN" | "UNTIL_YOUR_NEXT_TURN" | "WHILE_SOURCE_ON_BATTLEFIELD";
  powerDelta?: number;
  toughnessDelta?: number;
  keyword?: string;
  tapped?: boolean;
}

export interface TemporaryEffect {
  id: string;
  sourceCard?: CardName;
  controller: number;
  previousController?: number;
  targetPermanentId?: string;
  targetCard?: CardName;
  effect: EffectDescriptor;
  expires: "UNTIL_END_OF_TURN" | "UNTIL_YOUR_NEXT_TURN" | "WHILE_SOURCE_ON_BATTLEFIELD";
  createdTurn: number;
}

export interface CostDescriptor {
  type: "SACRIFICE";
  amount?: number;
  cardType?: "creature" | "artifact" | "enchantment" | "permanent";
  subtype?: string;
  controller?: "self";
}

export type ConditionDescriptor =
  | { type: "SOURCE_IS_THIS" }
  | { type: "CONTROLLER_IS_YOU" }
  | { type: "IS_CREATURE" }
  | { type: "HAS_SUBTYPE"; subtype: string }
  | { type: "HAS_COUNTER"; counterType: string }
  | { type: "OPPONENT_HAS_MORE_LIFE" }
  | { type: "OPPONENT_CONTROLS_MORE_LANDS" }
  | { type: "CREATURE_DIED_THIS_TURN" }
  | { type: "PERMANENT_ENTERED_THIS_TURN" }
  | { type: "ATTACKING_PLAYER"; playerRelation: string }
  | { type: "AND"; conditions: ConditionDescriptor[] }
  | { type: "OR"; conditions: ConditionDescriptor[] }
  | { type: "NOT"; condition: ConditionDescriptor };

export interface TargetRequirement {
  type: "PLAYER" | "CREATURE" | "PERMANENT" | "CARD_IN_GRAVEYARD" | "SPELL";
  zone?: "battlefield" | "graveyard" | "stack" | "hand" | "player";
  controller?: "self" | "opponent" | "any";
  owner?: "self" | "opponent" | "any";
  cardType?: "creature" | "artifact" | "enchantment" | "permanent" | "card";
  subtype?: string;
  required?: boolean;
  optional?: boolean;
}

export interface TriggerDescriptor {
  eventType: RulesEventType;
  source?: "self" | "any";
}

export interface ParsedAbility {
  kind: "TRIGGERED" | "ACTIVATED" | "STATIC" | "REPLACEMENT" | "SPELL_EFFECT";
  trigger?: TriggerDescriptor;
  conditions?: ConditionDescriptor[];
  costs?: CostDescriptor[];
  effects: EffectDescriptor[];
  targets?: TargetRequirement[];
  sourceFragment?: string;
  patternId?: string;
  supportLevel?: "FULL" | "PARTIAL";
}

export type TriggerType =
  | "OPPONENT_LAND_ADVANTAGE"
  | "OPPONENT_NONPLAY_LAND"
  | "ETB"
  | "LTB"
  | "DIES"
  | "CAST"
  | "DRAW"
  | "UPKEEP"
  | "ATTACK"
  | "DAMAGE";

export interface RegisteredTrigger {
  id: string;
  controller: number;
  sourceCard: CardName;
  type: TriggerType;
  eventType?: RulesEventType;
  condition?: string;
  conditions?: ConditionDescriptor[];
  effects?: EffectDescriptor[];
  targetRequirements?: string[];
  data?: Record<string, unknown>;
}

export interface StackEntry {
  id: string;
  action: SimAction;
  casterIndex: number;
  resolved: boolean;
  responses: StackEntry[];
  kind?: "spell" | "triggeredAbility" | "activatedAbility";
  sourceCard?: CardName;
  effects?: EffectDescriptor[];
  targets?: Array<{ type: "player" | "creature" | "permanent" | "stack"; id: string | number }>;
}

export interface SimGameState {
  turn: number;
  playerIndex: number; // indice del giocatore che sta giocando (0..3)
  lifeTotals: number[]; // es: [40, 40, 40, 40]
  libraries: CardName[][];
  hands: CardName[][];
  battlefields: CardName[][];
  permanents?: PermanentState[][];
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
  rulesEvents?: RulesEvent[];
  temporaryEffects?: TemporaryEffect[];
  rulesMetrics?: {
    unsupportedEffects: number;
    stateBasedActions: number;
    fizzledObjects: number;
  };
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
  | { type: "PLAY_LAND"; card: CardName; face?: string }
  | { type: "CAST_SPELL"; card: CardName; face?: string; targetStackId?: string; targetId?: string; targetPlayer?: number; targetGraveyardCard?: CardName }
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
