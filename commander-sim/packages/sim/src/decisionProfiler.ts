const timings = new Map<string, number>();
const counters = new Map<string, number>();
const samples = new Map<string, number[]>();
const currentOperations: Array<{ name: string; startedAt: number }> = [];
const operationBreakdowns = new Map<string, { count: number; totalMs: number; maxMs: number; samples: number[]; maxInputSize: number }>();
let externalPauseMs = 0;

export interface DecisionTraceContext {
  gameIndex?: number;
  seed?: number;
  turn?: number;
  phase?: string;
  playerIndex?: number;
  actionType?: string;
  actionLabel?: string;
  availableActionsCount?: number;
  handCount?: number;
  permanentCount?: number;
  creatureCount?: number;
  stackDepth?: number;
}

let traceContextProvider: (() => DecisionTraceContext | undefined) | undefined;
let staticTraceContext: DecisionTraceContext | undefined;

export function setDecisionTraceContextProvider(provider?: () => DecisionTraceContext | undefined) {
  traceContextProvider = provider;
}

export function setDecisionTraceContext(context?: DecisionTraceContext) {
  staticTraceContext = context;
}

export function withDecisionTraceContext<T>(context: DecisionTraceContext, fn: () => T): T {
  const previous = staticTraceContext;
  staticTraceContext = { ...previous, ...context };
  try {
    return fn();
  } finally {
    staticTraceContext = previous;
  }
}

export function recordDecisionTiming(name: string, ms: number) {
  timings.set(name, (timings.get(name) ?? 0) + ms);
}

export function recordDecisionCount(name: string, value = 1) {
  counters.set(name, (counters.get(name) ?? 0) + value);
}

export function recordDecisionSample(name: string, value: number) {
  const bucket = samples.get(name) ?? [];
  bucket.push(value);
  samples.set(name, bucket);
}

export function recordDecisionExternalPause(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  externalPauseMs += ms;
  recordDecisionTiming("AI external pause", ms);
}

export function timeDecisionBlock<T>(name: string, fn: () => T): T {
  const start = performance.now();
  currentOperations.push({ name, startedAt: start });
  try {
    return fn();
  } finally {
    const elapsed = performance.now() - start;
    currentOperations.pop();
    recordDecisionTiming(name, elapsed);
  }
}

export function profileDecisionBlock<T>(
  name: string,
  options: { inputSize?: number; slowThresholdMs?: number; resultSize?: (value: T) => number } | undefined,
  fn: () => T
): T {
  const start = performance.now();
  currentOperations.push({ name, startedAt: start });
  let result!: T;
  try {
    result = fn();
    return result;
  } finally {
    const elapsed = performance.now() - start;
    currentOperations.pop();
    recordDecisionTiming(name, elapsed);
    const breakdown = operationBreakdowns.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, samples: [], maxInputSize: 0 };
    breakdown.count++;
    breakdown.totalMs += elapsed;
    breakdown.maxMs = Math.max(breakdown.maxMs, elapsed);
    breakdown.samples.push(elapsed);
    if (options?.inputSize !== undefined) breakdown.maxInputSize = Math.max(breakdown.maxInputSize, options.inputSize);
    operationBreakdowns.set(name, breakdown);
    const threshold = options?.slowThresholdMs ?? Number(process.env.PATTERN_TRACE_THRESHOLD_MS ?? 100);
    if (elapsed > threshold) {
      const context = { ...traceContextProvider?.(), ...staticTraceContext };
      const outputSize = options?.resultSize ? options.resultSize(result) : undefined;
      console.warn(
        `[pattern-slow] op=${name} elapsedMs=${elapsed.toFixed(1)} ` +
        `game=${context?.gameIndex ?? "-"} seed=${context?.seed ?? "-"} turn=${context?.turn ?? "-"} ` +
        `phase=${context?.phase ?? "-"} player=${context?.playerIndex ?? "-"} action=${context?.actionType ?? "-"} ` +
        `label=${context?.actionLabel ?? "-"} actions=${context?.availableActionsCount ?? "-"} ` +
        `hand=${context?.handCount ?? "-"} permanents=${context?.permanentCount ?? "-"} ` +
        `creatures=${context?.creatureCount ?? "-"} stack=${context?.stackDepth ?? "-"} ` +
        `inputSize=${options?.inputSize ?? "-"} outputSize=${outputSize ?? "-"}`
      );
    }
  }
}

export function resetDecisionTimings() {
  timings.clear();
  counters.clear();
  samples.clear();
  currentOperations.length = 0;
  operationBreakdowns.clear();
  staticTraceContext = undefined;
  externalPauseMs = 0;
}

export function decisionTimingSnapshot() {
  return Object.fromEntries(timings.entries());
}

export function decisionTelemetrySnapshot() {
  return {
    timingsMs: Object.fromEntries(timings.entries()),
    counters: Object.fromEntries(counters.entries()),
    samples: Object.fromEntries(samples.entries()),
    externalPauseMs,
    operationBreakdowns: Object.fromEntries(
      [...operationBreakdowns.entries()].map(([name, data]) => {
        const sorted = [...data.samples].sort((a, b) => a - b);
        const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
        return [name, {
          count: data.count,
          totalMs: data.totalMs,
          avgMs: data.totalMs / Math.max(1, data.count),
          p95Ms: p95,
          maxMs: data.maxMs,
          maxInputSize: data.maxInputSize,
        }];
      })
    ),
  };
}

export function decisionExternalPauseMs() {
  return externalPauseMs;
}

export function currentDecisionOperation() {
  const current = currentOperations[currentOperations.length - 1];
  if (!current) return undefined;
  return {
    name: current.name,
    elapsedMs: performance.now() - current.startedAt,
  };
}
