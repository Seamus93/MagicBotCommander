import type {
  AgentDecision,
  AttackPlan,
  BlockPlan,
  BlockDecision,
  CardName,
  SimAction,
  SimAgent,
  SimGameState,
  StackEntry,
} from "@game-state/types";

export type WaitingType =
  | "action"
  | "attack_plan"
  | "block_plan"
  | "target"
  | "mulligan"
  | "response";

export interface WaitingContext {
  type: WaitingType;
  availableActions?: SimAction[];
  plans?: AttackPlan[] | BlockPlan[];
  opponentIndices?: number[];
  hand?: CardName[];
  mulliganCount?: number;
  triggeringEntry?: StackEntry;
  availableInstants?: SimAction[];
}

export class HumanAgent implements SimAgent {
  id = "human";

  private pendingResolve: ((value: unknown) => void) | null = null;
  private onWaiting: (type: WaitingType, ctx: WaitingContext, state?: SimGameState) => void;
  private sessionId: string;

  constructor(sessionId: string, onWaiting: (type: WaitingType, ctx: WaitingContext, state?: SimGameState) => void) {
    this.sessionId = sessionId;
    this.onWaiting = onWaiting;
  }

  private waitFor<T>(type: WaitingType, ctx: WaitingContext, state?: SimGameState): Promise<T> {
    return new Promise<T>((resolve) => {
      this.pendingResolve = resolve as (value: unknown) => void;
      this.onWaiting(type, ctx, state);
    });
  }

  submitDecision(decision: unknown): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(decision);
    }
  }

  get hasPendingDecision(): boolean {
    return this.pendingResolve !== null;
  }

  async decideAction(
    state: SimGameState,
    availableActions: SimAction[]
  ): Promise<AgentDecision> {
    assertPlayLandActionsInHand({
      stage: "HumanAgent.decideAction",
      sessionId: this.sessionId,
      state,
      player: state.playerIndex,
      availableActions,
    });
    const action = await this.waitFor<SimAction>("action", {
      type: "action",
      availableActions,
    }, state);
    return { action };
  }

  async decideTarget(
    state: SimGameState,
    opponentIndices: number[]
  ): Promise<number> {
    return this.waitFor<number>("target", {
      type: "target",
      opponentIndices,
    }, state);
  }

  async decideAttackPlan(
    state: SimGameState,
    plans: AttackPlan[]
  ): Promise<AttackPlan> {
    return this.waitFor<AttackPlan>("attack_plan", {
      type: "attack_plan",
      plans,
    }, state);
  }

  async decideBlockPlan(
    state: SimGameState,
    plans: BlockPlan[]
  ): Promise<BlockPlan> {
    return this.waitFor<BlockPlan>("block_plan", {
      type: "block_plan",
      plans,
    }, state);
  }

  async decideMulligan(
    hand: CardName[],
    mulliganCount: number
  ): Promise<{ keep: boolean; bottomCards?: CardName[] }> {
    return this.waitFor<{ keep: boolean; bottomCards?: CardName[] }>(
      "mulligan",
      { type: "mulligan", hand, mulliganCount }
    );
  }

  async decideResponse(
    state: SimGameState,
    triggeringEntry: StackEntry,
    availableInstants: SimAction[]
  ): Promise<SimAction | null> {
    return this.waitFor<SimAction | null>("response", {
      type: "response",
      triggeringEntry,
      availableActions: availableInstants,
      availableInstants,
    }, state);
  }

  decideBlockers(
    _state: SimGameState,
    _attackers: import("@rules/combat/types").CreaturePermanent[],
    _availableBlockers: import("@rules/combat/types").CreaturePermanent[]
  ): Promise<BlockDecision> {
    return this.waitFor<BlockDecision>("block_plan", { type: "block_plan" });
  }
}

function isDebugAvailableActionInvariantEnabled() {
  return (
    process.env.DEBUG_AVAILABLE_ACTIONS === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

function assertPlayLandActionsInHand(params: {
  stage: string;
  sessionId: string;
  state: SimGameState;
  player: number;
  availableActions: SimAction[];
}) {
  const invalid = params.availableActions.filter(
    (action) =>
      action.type === "PLAY_LAND" &&
      !((params.state.hands[params.player] ?? []) as string[]).includes(action.card)
  );
  if (!invalid.length) return;

  const payload = {
    invariant: "PLAY_LAND_CARD_MUST_BE_IN_CURRENT_HAND",
    stage: params.stage,
    sessionId: params.sessionId,
    gameState: {
      turn: params.state.turn,
      phase: params.state.phase,
      phaseStep: params.state.phaseStep,
      playerIndex: params.state.playerIndex,
      checkedPlayer: params.player,
    },
    hand: params.state.hands[params.player] ?? [],
    availableActions: params.availableActions,
    invalidPlayLandActions: invalid,
  };
  console.error("[available-actions-invariant]", JSON.stringify(payload, null, 2));

  if (isDebugAvailableActionInvariantEnabled()) {
    throw new Error(
      `[available-actions-invariant] PLAY_LAND outside hand at ${params.stage} session=${params.sessionId}`
    );
  }
}
