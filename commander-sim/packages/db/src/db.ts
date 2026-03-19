import { PrismaClient } from "@prisma/client";
import { PatternStore } from "@sim/patterns";
import type { DeckCardMetadata, SimulationResult } from "@game-state/types";
import { buildStateDigest } from "@game-state/stateDigest";

const prisma = new PrismaClient();

export const getPrisma = () => prisma;

type EpisodeStepStorageMode = "off" | "digest" | "full";

function getEpisodeStepStorageMode(): EpisodeStepStorageMode {
  const raw = (process.env.EPISODE_STEP_STORAGE ?? "digest").toLowerCase();
  if (raw === "off" || raw === "none" || raw === "false") return "off";
  if (raw === "full") return "full";
  return "digest";
}

export async function createSimulationRun(params: {
  episodes: number;
  players: number;
  maxTurns?: number;
  policyPath?: string;
  archetypes?: string[];
  deckIds?: number[];
}) {
  return prisma.simulationRun.create({
    data: {
      episodes: params.episodes,
      players: params.players,
      maxTurns: params.maxTurns ?? null,
      policyPath: params.policyPath ?? null,
      archetypes: params.archetypes ?? null,
      deckIds: params.deckIds ?? null,
    },
  });
}

export async function persistEpisode(
  runId: number,
  episodeIndex: number,
  result: SimulationResult
) {
  const mode = getEpisodeStepStorageMode();
  const shouldStoreSteps = mode !== "off";
  const storeFullSteps = mode === "full";

  const steps = shouldStoreSteps
    ? result.history.map((entry, step) => {
        const reward =
          result.winnerIndex === null
            ? 0
            : entry.playerIndex === result.winnerIndex
              ? 1
              : -1;
        return {
          step,
          playerIndex: entry.playerIndex,
          agentId: entry.agentId ?? null,
          actionType: entry.action.type,
          card: "card" in entry.action ? entry.action.card ?? null : null,
          state: storeFullSteps ? entry.state : buildStateDigest(entry.state),
          availableActions: storeFullSteps ? entry.availableActions : null,
          decisionMeta: storeFullSteps ? (entry.metadata ?? null) : null,
          actionPayload: storeFullSteps ? entry.action : null,
          reward,
          shapedReward: entry.shapedReward ?? null, // Phase 2
          winnerIndex: result.winnerIndex,
        };
      })
    : [];

  await prisma.episode.create({
    data: {
      runId,
      index: episodeIndex,
      winnerIndex: result.winnerIndex,
      turnCount: result.turns,
      finalState: result.finalState,
      ...(shouldStoreSteps ? { steps: { createMany: { data: steps } } } : {}),
    },
  });
}

export async function upsertPolicyRecords(
  runId: number | null,
  store: PatternStore
) {
  const records = store.entries();
  if (!records.length) return;

  await prisma.$transaction(
    records.map((record) =>
      prisma.policyRecord.upsert({
        where: {
          pattern_actionKey: {
            pattern: record.pattern,
            actionKey: record.actionKey,
          },
        },
        update: {
          score: record.score,
          visits: record.visits,
          runId,
          updatedAt: new Date(),
        },
        create: {
          pattern: record.pattern,
          actionKey: record.actionKey,
          score: record.score,
          visits: record.visits,
          runId,
        },
      })
    )
  );
}

export async function loadPolicyStore(): Promise<PatternStore> {
  const records = await prisma.policyRecord.findMany({
    select: {
      pattern: true,
      actionKey: true,
      score: true,
      visits: true,
    },
  });

  return new PatternStore(records);
}

export async function getPolicyStoreVersion(): Promise<{
  count: number;
  updatedAt: Date | null;
}> {
  const [count, latest] = await Promise.all([
    prisma.policyRecord.count(),
    prisma.policyRecord.aggregate({
      _max: { updatedAt: true },
    }),
  ]);

  return {
    count,
    updatedAt: latest._max.updatedAt ?? null,
  };
}

export async function closeDb() {
  await prisma.$disconnect();
}

/**
 * Phase 4 — Aggiorna le statistiche win/loss per una coppia di archetipi.
 * La coppia viene normalizzata in ordine alfabetico per garantire l'unicità.
 */
export async function upsertMatchupStats(
  arch1: string,
  arch2: string,
  winnerArch: string
): Promise<void> {
  if (!arch1 || !arch2 || arch1 === arch2) return;

  // Ordine canonico: alphabetico
  const [a, b] = [arch1, arch2].sort();
  const isWinnerA = winnerArch === a;
  const isWinnerB = winnerArch === b;

  await prisma.matchupStats.upsert({
    where: { archetype1_archetype2: { archetype1: a, archetype2: b } },
    update: {
      wins1: isWinnerA ? { increment: 1 } : undefined,
      wins2: isWinnerB ? { increment: 1 } : undefined,
      total: { increment: 1 },
    },
    create: {
      archetype1: a,
      archetype2: b,
      wins1: isWinnerA ? 1 : 0,
      wins2: isWinnerB ? 1 : 0,
      total: 1,
    },
  });
}

export async function upsertDeck(params: {
  cards: string[];
  cardMetadata?: DeckCardMetadata[];
  sourceUrl?: string;
  name?: string;
  commander?: string;
}) {
  const hash = createDeckHash(params.cards);
  const existing = await prisma.deck.findUnique({ where: { cardHash: hash } });
  if (existing) return existing;

  return prisma.deck.create({
    data: {
      sourceUrl: params.sourceUrl ?? null,
      name: params.name ?? null,
      commander: params.commander ?? null,
      cards: params.cards,
      cardMetadata: params.cardMetadata ?? null,
      cardHash: hash,
    },
  });
}

export async function getDeckById(id: number) {
  if (!id) return null;
  return prisma.deck.findUnique({ where: { id } });
}

export async function updateDeckMetadata(
  id: number,
  metadata: DeckCardMetadata[]
) {
  if (!id) return;
  await prisma.deck.update({
    where: { id },
    data: { cardMetadata: metadata },
  });
}

function createDeckHash(cards: string[]): string {
  const normalized = [...cards]
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const chr = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `deck_${Math.abs(hash)}`;
}
