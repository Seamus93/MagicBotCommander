import type {
  AgentDecision,
  SimAction,
  SimGameState,
  StateDigest,
} from "@game-state/types";
import { DecisionTreeAgent } from "./decisionTreeAgent.js";
import type { DecisionTreeAgentOptions } from "./decisionTreeAgent.js";
import { requestAiDecision } from "@ai/aiClient.js";
import type { ScoredAction } from "./learningAgent.js";
import { buildStateDigest } from "@game-state/stateDigest";
import { fetchEpisodeContexts } from "./episodeMemory.js";

export interface AiDecisionAgentOptions extends DecisionTreeAgentOptions {
  logReasoning?: boolean;
}

/**
 * Usa il decision tree locale quando c'è sufficiente confidenza.
 * In caso contrario chiede ad un endpoint esterno (es. Puter) quale azione compiere.
 * La decisione AI viene registrata nel pattern store per raffinare il modello.
 */
export class AiDecisionAgent extends DecisionTreeAgent {
  private readonly logReasoning: boolean;

  constructor(options: AiDecisionAgentOptions) {
    super(options);
    this.logReasoning = options.logReasoning ?? false;
  }

  async decideAction(
    state: SimGameState,
    availableActions: SimAction[]
  ): Promise<AgentDecision> {
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

    const aiChosen = await this.queryAi(state, availableActions, scored);
    if (aiChosen) {
      const { entry, reasoning } = aiChosen;
      this.history.push({ pattern: entry.pattern, actionKey: entry.key });
      if (this.logReasoning && reasoning) {
        console.log(`[AI Agent] Reasoning: ${reasoning}`);
      }
      return {
        action: entry.action,
        metadata: {
          source: "ai",
          pattern: entry.pattern,
          actionKey: entry.key,
          confidence: entry.score,
          reasoning,
        },
      };
    }

    return super.decideAction(state, availableActions);
  }

  private async queryAi(
    state: SimGameState,
    availableActions: SimAction[],
    scored: ScoredAction[]
  ): Promise<{ entry: ScoredAction; reasoning?: string } | null> {
    try {
      const digest = buildStateDigest(state);
      let contextActions = [];
      try {
        contextActions = await fetchEpisodeContexts(digest);
      } catch (err) {
        console.warn("[AI Agent] impossibile caricare episodi:", err);
      }
      const { action, reasoning } = await requestAiDecision({
        state,
        availableActions,
        digest,
        contextActions,
      });
      const entry = matchAction(scored, action);
      if (!entry) {
        console.warn(
          "[AI Agent] L'AI ha suggerito un'azione non disponibile:",
          action
        );
        return null;
      }
      return { entry, reasoning };
    } catch (err) {
      console.warn("[AI Agent] Errore nella richiesta AI:", err);
      return null;
    }
  }
}

function matchAction(scored: ScoredAction[], target: SimAction) {
  return scored.find((entry) => actionsEqual(entry.action, target)) ?? null;
}

function actionsEqual(a: SimAction, b: SimAction) {
  if (a.type !== b.type) return false;
  if ("card" in a || "card" in b) {
    const cardA = "card" in a ? a.card ?? "" : "";
    const cardB = "card" in b ? b.card ?? "" : "";
    return normalize(cardA) === normalize(cardB);
  }
  return true;
}

const normalize = (value: string) => value.trim().toLowerCase();
