import { buildStateDigest } from "@game-state/stateDigest";
import { getPrisma } from "@db/db";
import type {
  EpisodeActionContext,
  SimAction,
  SimGameState,
  StateDigest,
} from "@game-state/types";

const SAMPLE_LIMIT = 3;
const STEP_FETCH_LIMIT = 400;

export async function fetchEpisodeContexts(
  digest: StateDigest,
  options: { limit?: number } = {}
): Promise<EpisodeActionContext[]> {
  const prisma = getPrisma();
  const steps = await prisma.episodeStep.findMany({
    where: {
      playerIndex: digest.playerIndex,
    },
    orderBy: { id: "desc" },
    take: STEP_FETCH_LIMIT,
    select: {
      actionType: true,
      card: true,
      reward: true,
      state: true,
      actionPayload: true,
    },
  });

  const stats = new Map<string, EpisodeActionContext>();

  for (const step of steps) {
    const action = normalizeStepAction(step);
    if (!action) continue;
    const key = action.type + ":" + (action as any).card;
    let entry = stats.get(key);
    if (!entry) {
      entry = {
        action,
        wins: 0,
        total: 0,
        winRate: 0,
        sampleStates: [],
      };
      stats.set(key, entry);
    }
    entry.total += 1;
    if ((step.reward ?? 0) > 0) {
      entry.wins += 1;
    }
    if (
      entry.sampleStates.length < SAMPLE_LIMIT &&
      step.state &&
      typeof step.state === "object"
    ) {
      const snapshot = step.state as unknown;
      const stateDigest = isStateDigest(snapshot)
        ? snapshot
        : buildStateDigest(snapshot as SimGameState);
      entry.sampleStates.push(stateDigest);
    }
  }

  const contexts = [...stats.values()]
    .map((entry) => ({
      ...entry,
      winRate: entry.total > 0 ? entry.wins / entry.total : 0,
    }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);

  const limit = options.limit ?? 5;
  return contexts.slice(0, limit);
}

function isStateDigest(value: unknown): value is StateDigest {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.playerIndex === "number" &&
    Array.isArray(obj.players) &&
    Array.isArray(obj.battlefieldSummary)
  );
}

function normalizeStepAction(step: {
  actionType: string;
  card: string | null;
  actionPayload: unknown;
}): SimAction | null {
  const payload = step.actionPayload as SimAction | null;
  if (payload?.type) return payload;
  const type = step.actionType?.toUpperCase();
  if (!type) return null;
  switch (type) {
    case "PLAY_LAND":
      return step.card ? { type, card: step.card } : null;
    case "CAST_SPELL":
      return step.card ? { type, card: step.card } : null;
    case "PASS_TURN":
      return { type: "PASS_TURN" };
    default:
      return null;
  }
}
