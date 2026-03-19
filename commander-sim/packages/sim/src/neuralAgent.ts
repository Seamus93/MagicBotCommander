/**
 * NeuralAgent — extends LearningAgent with a neural policy network.
 * Ensemble mode: neuralScore * alpha + tabularScore * (1 - alpha).
 * Falls back to parent LearningAgent when no model is available or confidence is low.
 */

import type { SimAction, SimGameState } from "@game-state/types.js";
import {
  PolicyNet,
} from "@neural/policyNet.js";
import {
  featuresToVector,
  extractFeaturesFromStateWithArchetype,
} from "@neural/featureVector.js";
import { encodeActionFromState } from "@neural/actionEncoder.js";
import { loadModel, latestModel } from "@neural/modelManager.js";
import { LearningAgent } from "./learningAgent.js";
import type { LearningAgentOptions, ScoredAction } from "./learningAgent.js";

export interface NeuralAgentOptions extends LearningAgentOptions {
  /** Path to a model weights JSON file. If omitted, will try to auto-detect. */
  modelPath?: string;
  /** Blend weight for neural score in ensemble mode (default 0.7). */
  neuralAlpha?: number;
  /**
   * If max_prob - second_prob < confidenceThreshold, fall back to tabular scoring.
   * Default 0.05.
   */
  confidenceThreshold?: number;
}

const DEFAULT_NEURAL_ALPHA =
  typeof process.env.NEURAL_ALPHA === "string"
    ? Number(process.env.NEURAL_ALPHA)
    : 0.7;

export class NeuralAgent extends LearningAgent {
  private net: PolicyNet | null = null;
  private readonly neuralAlpha: number;
  private readonly confidenceThreshold: number;

  // Cache: turn+playerIndex → probability vector
  private cachedTurn = -1;
  private cachedPlayerIndex = -1;
  private cachedProbs: number[] | null = null;

  constructor(options: NeuralAgentOptions) {
    super(options);
    this.neuralAlpha = options.neuralAlpha ?? DEFAULT_NEURAL_ALPHA;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.05;

    if (options.modelPath) {
      try {
        this.net = loadModel(options.modelPath);
      } catch {
        // Model load failed — graceful degradation to tabular
        this.net = null;
      }
    }
  }

  /** Replace the current neural model (e.g. after a training pass). */
  setModel(net: PolicyNet): void {
    this.net = net;
    // Invalidate cache
    this.cachedTurn = -1;
    this.cachedPlayerIndex = -1;
    this.cachedProbs = null;
  }

  /** Get the current PolicyNet instance, or null if not loaded. */
  getNet(): PolicyNet | null {
    return this.net;
  }

  protected override scoreActions(
    state: SimGameState,
    availableActions: SimAction[]
  ): ScoredAction[] {
    // Get tabular scores from parent
    const tabularScored = super.scoreActions(state, availableActions);

    if (!this.net || availableActions.length === 0) {
      return tabularScored;
    }

    // Get neural probabilities (use cache if same state)
    const probs = this.getProbs(state);

    // Check confidence: max_prob - second_max
    const sorted = [...probs].sort((a, b) => b - a);
    const delta = (sorted[0] ?? 0) - (sorted[1] ?? 0);
    if (delta < this.confidenceThreshold) {
      // Low confidence — use pure tabular
      return tabularScored;
    }

    // Ensemble: blend neural + tabular scores
    return tabularScored.map((scored) => {
      const actionIdx = encodeActionFromState(
        scored.action,
        state,
        state.playerIndex
      );
      const neuralScore = probs[actionIdx] ?? 0;

      // Normalize tabular score to [0,1] range for blending (sigmoid-like)
      const tabScore = scored.score;
      const normalizedTab = 1 / (1 + Math.exp(-tabScore));
      const blended =
        this.neuralAlpha * neuralScore +
        (1 - this.neuralAlpha) * normalizedTab;

      return { ...scored, score: blended };
    });
  }

  private getProbs(state: SimGameState): number[] {
    // Cache hit
    if (
      this.net &&
      state.turn === this.cachedTurn &&
      state.playerIndex === this.cachedPlayerIndex &&
      this.cachedProbs
    ) {
      return this.cachedProbs;
    }

    if (!this.net) return [];

    const featureRecord = extractFeaturesFromStateWithArchetype(
      state,
      this.archetype,
      this.opponentArchetypes
    );
    const vector = featuresToVector(featureRecord);
    const probs = this.net.forward(vector);

    this.cachedTurn = state.turn;
    this.cachedPlayerIndex = state.playerIndex;
    this.cachedProbs = probs;

    return probs;
  }
}

/**
 * Create a NeuralAgent with auto-detected latest model from the given directory.
 * If no model exists, creates agent without neural component (tabular only).
 */
export function createNeuralAgent(
  options: LearningAgentOptions & {
    modelDir: string;
    neuralAlpha?: number;
    confidenceThreshold?: number;
  }
): NeuralAgent {
  const { modelDir, ...rest } = options;
  const latest = latestModel(modelDir);
  return new NeuralAgent({
    ...rest,
    modelPath: latest?.path,
  });
}
