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
  private onWaiting: (type: WaitingType, ctx: WaitingContext) => void;

  constructor(onWaiting: (type: WaitingType, ctx: WaitingContext) => void) {
    this.onWaiting = onWaiting;
  }

  private waitFor<T>(type: WaitingType, ctx: WaitingContext): Promise<T> {
    return new Promise<T>((resolve) => {
      this.pendingResolve = resolve as (value: unknown) => void;
      this.onWaiting(type, ctx);
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
    _state: SimGameState,
    availableActions: SimAction[]
  ): Promise<AgentDecision> {
    const action = await this.waitFor<SimAction>("action", {
      type: "action",
      availableActions,
    });
    return { action };
  }

  async decideTarget(
    _state: SimGameState,
    opponentIndices: number[]
  ): Promise<number> {
    return this.waitFor<number>("target", {
      type: "target",
      opponentIndices,
    });
  }

  async decideAttackPlan(
    _state: SimGameState,
    plans: AttackPlan[]
  ): Promise<AttackPlan> {
    return this.waitFor<AttackPlan>("attack_plan", {
      type: "attack_plan",
      plans,
    });
  }

  async decideBlockPlan(
    _state: SimGameState,
    plans: BlockPlan[]
  ): Promise<BlockPlan> {
    return this.waitFor<BlockPlan>("block_plan", {
      type: "block_plan",
      plans,
    });
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
    _state: SimGameState,
    triggeringEntry: StackEntry,
    availableInstants: SimAction[]
  ): Promise<SimAction | null> {
    return this.waitFor<SimAction | null>("response", {
      type: "response",
      triggeringEntry,
      availableActions: availableInstants,
      availableInstants,
    });
  }

  decideBlockers(
    _state: SimGameState,
    _attackers: import("@rules/combat/types").CreaturePermanent[],
    _availableBlockers: import("@rules/combat/types").CreaturePermanent[]
  ): Promise<BlockDecision> {
    return this.waitFor<BlockDecision>("block_plan", { type: "block_plan" });
  }
}
