import type {
  AgentDecision,
  SimAction,
  SimGameState,
} from "@game-state/types";
import { LearningAgent } from "./learningAgent.js";
import type {
  LearningAgentOptions,
  ScoredAction,
  ScoredChoice,
} from "./learningAgent.js";
import type { AttackPlan, BlockPlan } from "./combatEvaluator.js";

export interface DecisionTreeAgentOptions extends LearningAgentOptions {
  confidenceThreshold?: number;
  minVisits?: number;
  confidenceK?: number;
}

/**
 * Usa il PatternStore in modo deterministico quando la confidenza e sufficiente,
 * ricadendo sul comportamento learning quando i dati non bastano.
 */
export class DecisionTreeAgent extends LearningAgent {
  private readonly confidenceThreshold: number;
  private readonly minVisits: number;

  constructor(options: DecisionTreeAgentOptions) {
    super(options);
    this.confidenceThreshold = options.confidenceThreshold ?? 0.8;
    this.minVisits = options.minVisits ?? 5;
  }

  decideAction(
    state: SimGameState,
    availableActions: SimAction[]
  ): AgentDecision | Promise<AgentDecision> {
    if (availableActions.length === 0) {
      return {
        action: { type: "PASS_TURN" },
        metadata: { source: "fallback" },
      };
    }

    const scored = this.scoreActions(state, availableActions);
    const deterministic = this.pickDeterministic(scored);

    if (deterministic) {
      this.history.push({
        pattern: deterministic.pattern,
        actionKey: deterministic.key,
      });
      return {
        action: deterministic.action,
        metadata: {
          source: deterministic.source,
          pattern: deterministic.pattern,
          actionKey: deterministic.key,
          expectedReward: deterministic.expectedReward,
          confidence: deterministic.confidence,
          visits: deterministic.visits,
        },
      };
    }

    return super.decideAction(state, availableActions);
  }

  decideTarget(state: SimGameState, opponentIndices: number[]): number {
    const scored = this.scoreTargetOptions(state, opponentIndices);
    const deterministic = this.pickDeterministicChoice(scored);
    if (deterministic) {
      this.history.push({
        pattern: deterministic.pattern,
        actionKey: deterministic.key,
      });
      return deterministic.choice;
    }
    return super.decideTarget(state, opponentIndices);
  }

  decideAttackPlan(state: SimGameState, plans: AttackPlan[]): AttackPlan {
    const scored = this.scoreAttackPlanOptions(state, plans);
    const deterministic = this.pickDeterministicChoice(scored);
    if (deterministic) {
      this.history.push({
        pattern: deterministic.pattern,
        actionKey: deterministic.key,
      });
      return deterministic.choice;
    }
    return super.decideAttackPlan(state, plans);
  }

  decideBlockPlan(state: SimGameState, plans: BlockPlan[]): BlockPlan {
    const scored = this.scoreBlockPlanOptions(state, plans);
    const deterministic = this.pickDeterministicChoice(scored);
    if (deterministic) {
      this.history.push({
        pattern: deterministic.pattern,
        actionKey: deterministic.key,
      });
      return deterministic.choice;
    }
    return super.decideBlockPlan(state, plans);
  }

  protected pickDeterministic(scored: ScoredAction[]): ScoredAction | null {
    return this.pickDeterministicChoice(
      scored.map((entry) => ({
        choice: entry,
        pattern: entry.pattern,
        key: entry.key,
        score: entry.score,
        expectedReward: entry.expectedReward,
        confidence: entry.confidence,
        visits: entry.visits,
        source: entry.source,
        record: entry.record,
      }))
    )?.choice ?? null;
  }

  protected pickDeterministicChoice<T>(
    scored: ScoredChoice<T>[]
  ): ScoredChoice<T> | null {
    let best: ScoredChoice<T> | null = null;
    for (const candidate of scored) {
      if (candidate.source !== "exact" && candidate.source !== "fuzzy") continue;
      if (candidate.visits < this.minVisits) continue;
      if (candidate.confidence < this.confidenceThreshold) continue;

      if (!best) {
        best = candidate;
        continue;
      }

      if (candidate.expectedReward > best.expectedReward) {
        best = candidate;
      } else if (
        candidate.expectedReward === best.expectedReward &&
        candidate.visits > best.visits
      ) {
        best = candidate;
      }
    }
    return best;
  }
}
