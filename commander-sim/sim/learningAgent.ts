import { SimAgent, SimAction, SimGameState } from "./types.js";
import { PatternStore, patternFromFeatures, actionToKey } from "./patterns.js";

export interface LearningAgentOptions {
  id: string;
  store: PatternStore;
  epsilon?: number;
}

type DecisionTrace = {
  pattern: string;
  actionKey: string;
};

export class LearningAgent implements SimAgent {
  public readonly id: string;
  private readonly store: PatternStore;
  private readonly epsilon: number;
  private readonly history: DecisionTrace[] = [];

  constructor({ id, store, epsilon = 0.1 }: LearningAgentOptions) {
    this.id = id;
    this.store = store;
    this.epsilon = epsilon;
  }

  decideAction(
    state: SimGameState,
    availableActions: SimAction[]
  ): SimAction {
    if (availableActions.length === 0) {
      return { type: "PASS_TURN" };
    }
    const patternBase = this.extractFeatures(state);

    const scored = availableActions.map((action) => {
      const pattern = patternFromFeatures({
        ...patternBase,
        actionHash: this.hashAction(action),
      });
      const key = actionToKey(action.type, "card" in action ? action.card : "");
      const record = this.store.get(pattern, key);
      const score =
        record && record.visits > 0 ? record.score / record.visits : 0;
      return { action, pattern, key, score };
    });

    let chosen = scored[0];
    if (Math.random() < this.epsilon) {
      chosen = scored[Math.floor(Math.random() * scored.length)];
    } else {
      chosen = scored.reduce((best, current) =>
        current.score > best.score ? current : best
      );
    }

    this.history.push({ pattern: chosen.pattern, actionKey: chosen.key });
    return chosen.action;
  }

  finalizeEpisode(reward: number) {
    for (const trace of this.history) {
      this.store.observe(trace.pattern, trace.actionKey, reward);
    }
    this.history.length = 0;
  }

  private extractFeatures(state: SimGameState) {
    const { playerIndex } = state;
    const opponentLifeAvg =
      state.lifeTotals
        .filter((_, idx) => idx !== playerIndex)
        .reduce((sum, val) => sum + val, 0) / (state.lifeTotals.length - 1);

    return {
      turn: state.turn,
      handSize: state.hands[playerIndex].length,
      lands: state.battlefields[playerIndex].filter((card) =>
        card.toLowerCase().includes("land")
      ).length,
      spellsInHand: state.hands[playerIndex].filter(
        (card) => !card.toLowerCase().includes("land")
      ).length,
      life: state.lifeTotals[playerIndex],
      opponentLifeAvg,
    };
  }

  private hashAction(action: SimAction) {
    switch (action.type) {
      case "PLAY_LAND":
        return 1;
      case "CAST_SPELL":
        return 2;
      default:
        return 0;
    }
  }
}

export const isLearningAgent = (
  agent: SimAgent
): agent is LearningAgent => agent instanceof LearningAgent;
