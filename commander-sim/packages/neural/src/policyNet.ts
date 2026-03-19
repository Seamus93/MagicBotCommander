/**
 * PolicyNet — lightweight feedforward neural network for MTG Commander action selection.
 * Architecture: Input(20) → Dense(128, ReLU) → Dense(64, ReLU) → Dense(32, ReLU) → Output(11, softmax)
 * Training: REINFORCE policy gradient with gradient clipping (max norm 1.0).
 * No external dependencies — pure TypeScript math.
 */

export interface TrainingExample {
  features: number[];
  actionIndex: number;
  reward: number;
}

// Layer sizes (excluding input)
const LAYER_SIZES = [128, 64, 32, 11] as const;
const INPUT_SIZE = 20;
const OUTPUT_SIZE = 11;

/** Box-Muller transform: returns a standard normal sample. */
function randn(): number {
  // Use two uniform samples to produce one normal sample
  const u1 = Math.random() + Number.EPSILON;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** He initialization: scale = sqrt(2 / inSize). */
function heInit(inSize: number, outSize: number): Float32Array {
  const scale = Math.sqrt(2 / inSize);
  const w = new Float32Array(inSize * outSize);
  for (let i = 0; i < w.length; i++) {
    w[i] = randn() * scale;
  }
  return w;
}

function relu(x: number): number {
  return x > 0 ? x : 0;
}

function reluDerivative(x: number): number {
  return x > 0 ? 1 : 0;
}

function softmax(logits: number[]): number[] {
  const maxLogit = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - maxLogit));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / (sum + Number.EPSILON));
}

/** Clip gradients so their L2 norm doesn't exceed maxNorm. */
function clipGrads(grads: Float32Array, maxNorm: number): void {
  let norm = 0;
  for (let i = 0; i < grads.length; i++) {
    norm += grads[i] * grads[i];
  }
  norm = Math.sqrt(norm);
  if (norm > maxNorm) {
    const scale = maxNorm / (norm + Number.EPSILON);
    for (let i = 0; i < grads.length; i++) {
      grads[i] *= scale;
    }
  }
}

interface LayerWeights {
  W: Float32Array; // [inSize * outSize], row-major
  b: Float32Array; // [outSize]
  inSize: number;
  outSize: number;
}

export class PolicyNet {
  private layers: LayerWeights[];

  constructor() {
    this.layers = [];
    const sizes = [INPUT_SIZE, ...LAYER_SIZES];
    for (let i = 0; i < sizes.length - 1; i++) {
      const inSize = sizes[i];
      const outSize = sizes[i + 1];
      this.layers.push({
        W: heInit(inSize, outSize),
        b: new Float32Array(outSize), // zeros
        inSize,
        outSize,
      });
    }
  }

  /** Forward pass: returns softmax probabilities over ACTION_COUNT actions. */
  forward(features: number[]): number[] {
    let activation: number[] = features.slice(0, INPUT_SIZE);
    // Pad if needed
    while (activation.length < INPUT_SIZE) activation.push(0);

    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];
      const out: number[] = new Array(layer.outSize);
      for (let j = 0; j < layer.outSize; j++) {
        let sum = layer.b[j];
        for (let k = 0; k < layer.inSize; k++) {
          sum += activation[k] * layer.W[k * layer.outSize + j];
        }
        // Apply ReLU for all hidden layers; last layer uses softmax below
        out[j] = li < this.layers.length - 1 ? relu(sum) : sum;
      }
      activation = out;
    }

    return softmax(activation);
  }

  /**
   * Train one batch using REINFORCE (Monte Carlo policy gradient).
   * Returns the mean loss for this batch.
   */
  train(batch: TrainingExample[], learningRate: number): number {
    if (batch.length === 0) return 0;

    // Accumulate gradients
    const wGrads: Float32Array[] = this.layers.map(
      (l) => new Float32Array(l.W.length)
    );
    const bGrads: Float32Array[] = this.layers.map(
      (l) => new Float32Array(l.b.length)
    );

    let totalLoss = 0;
    const MAX_CLIP = 1.0;

    for (const example of batch) {
      const { features, actionIndex, reward } = example;

      // ── Forward pass (cache pre-activation and activation per layer) ──
      const preActivations: number[][] = [];
      const activations: number[][] = [];
      let act: number[] = features.slice(0, INPUT_SIZE);
      while (act.length < INPUT_SIZE) act.push(0);
      activations.push(act);

      for (let li = 0; li < this.layers.length; li++) {
        const layer = this.layers[li];
        const pre: number[] = new Array(layer.outSize);
        const post: number[] = new Array(layer.outSize);
        for (let j = 0; j < layer.outSize; j++) {
          let sum = layer.b[j];
          for (let k = 0; k < layer.inSize; k++) {
            sum += activations[li][k] * layer.W[k * layer.outSize + j];
          }
          pre[j] = sum;
          post[j] = li < this.layers.length - 1 ? relu(sum) : sum;
        }
        preActivations.push(pre);
        activations.push(post);
      }

      // Softmax on last layer
      const probs = softmax(activations[this.layers.length]);
      const logProb = Math.log(
        (probs[actionIndex] ?? Number.EPSILON) + Number.EPSILON
      );
      totalLoss -= logProb * reward;

      // ── Backward pass (REINFORCE gradient: -reward * d(log π) / d θ) ──
      // Gradient of softmax cross-entropy: probs[i] - 1(i == actionIndex)
      const outputDelta: number[] = probs.map((p, i) =>
        (p - (i === actionIndex ? 1 : 0)) * (-reward)
      );

      let delta = outputDelta;

      for (let li = this.layers.length - 1; li >= 0; li--) {
        const layer = this.layers[li];
        const inputAct = activations[li];

        // Accumulate weight gradients
        for (let j = 0; j < layer.outSize; j++) {
          for (let k = 0; k < layer.inSize; k++) {
            wGrads[li][k * layer.outSize + j] += delta[j] * inputAct[k];
          }
          bGrads[li][j] += delta[j];
        }

        if (li > 0) {
          // Backprop through ReLU
          const prevDelta: number[] = new Array(layer.inSize).fill(0);
          for (let k = 0; k < layer.inSize; k++) {
            let sum = 0;
            for (let j = 0; j < layer.outSize; j++) {
              sum += delta[j] * layer.W[k * layer.outSize + j];
            }
            prevDelta[k] = sum * reluDerivative(preActivations[li - 1][k]);
          }
          delta = prevDelta;
        }
      }
    }

    // Average gradients and apply updates
    const batchSize = batch.length;
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];
      for (let i = 0; i < wGrads[li].length; i++) {
        wGrads[li][i] /= batchSize;
      }
      for (let i = 0; i < bGrads[li].length; i++) {
        bGrads[li][i] /= batchSize;
      }

      // Clip gradients
      clipGrads(wGrads[li], MAX_CLIP);
      clipGrads(bGrads[li], MAX_CLIP);

      // Update weights
      for (let i = 0; i < layer.W.length; i++) {
        layer.W[i] -= learningRate * wGrads[li][i];
      }
      for (let i = 0; i < layer.b.length; i++) {
        layer.b[i] -= learningRate * bGrads[li][i];
      }
    }

    return totalLoss / batchSize;
  }

  /**
   * Returns weights as interleaved [W0, b0, W1, b1, ...] Float32Array list.
   * Each array is a copy.
   */
  getWeights(): Float32Array[] {
    const result: Float32Array[] = [];
    for (const layer of this.layers) {
      result.push(new Float32Array(layer.W));
      result.push(new Float32Array(layer.b));
    }
    return result;
  }

  /**
   * Sets weights from interleaved [W0, b0, W1, b1, ...] list.
   * Validates dimensions.
   */
  setWeights(weights: Float32Array[]): void {
    if (weights.length !== this.layers.length * 2) {
      throw new Error(
        `setWeights: expected ${this.layers.length * 2} arrays, got ${weights.length}`
      );
    }
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];
      const W = weights[li * 2];
      const b = weights[li * 2 + 1];
      if (W.length !== layer.W.length) {
        throw new Error(
          `setWeights: layer ${li} W size mismatch: expected ${layer.W.length}, got ${W.length}`
        );
      }
      if (b.length !== layer.b.length) {
        throw new Error(
          `setWeights: layer ${li} b size mismatch: expected ${layer.b.length}, got ${b.length}`
        );
      }
      layer.W.set(W);
      layer.b.set(b);
    }
  }

  get inputSize(): number {
    return INPUT_SIZE;
  }

  get outputSize(): number {
    return OUTPUT_SIZE;
  }

  get layerSizes(): number[] {
    return [...LAYER_SIZES];
  }
}
