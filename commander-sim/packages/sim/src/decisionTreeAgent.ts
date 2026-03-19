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
  ): AgentDecision {
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
          source: "decision_tree",
          pattern: deterministic.pattern,
          actionKey: deterministic.key,
          confidence: deterministic.score,
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
        record: entry.record,
      }))
    )?.choice ?? null;
  }

  protected pickDeterministicChoice<T>(
    scored: ScoredChoice<T>[]
  ): ScoredChoice<T> | null {
    let best: ScoredChoice<T> | null = null;
    for (const candidate of scored) {
      const record = candidate.record;
      if (!record) continue;
      if (record.visits < this.minVisits) continue;
      const avg = record.score / record.visits;
      if (avg < this.confidenceThreshold) continue;

      if (!best) {
        best = candidate;
        continue;
      }

      const bestRecord = best.record!;
      const bestAvg = bestRecord.score / bestRecord.visits;
      if (avg > bestAvg) {
        best = candidate;
      } else if (avg === bestAvg && record.visits > bestRecord.visits) {
        best = candidate;
      }
    }
    return best;
  }
}
