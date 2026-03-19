import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PatternStore } from "@sim/patterns";
import { DecisionTreeAgent } from "@sim/decisionTreeAgent";
import { NeuralAgent } from "@sim/neuralAgent";
import type { CardName, DeckCardMetadata, SimAction, SimGameState } from "@game-state/types";
import { getCardMetadata, normalizeCardName, isLandCard } from "@game-state/cardUtils";
import { scoreArchetypeCategory } from "@rules/archetypeMatcher";
import { loadModel, latestModel } from "@neural/modelManager";
import type { PolicyNet } from "@neural/policyNet";
import { getPolicyStoreVersion, getPrisma, loadPolicyStore } from "@db/db";

type UiState = {
  turn: number;
  life: number;
  commander?: string;
  hand: string[];
  battlefield: string[];
  graveyard?: string[];
  exile?: string[];
  landPlayedThisTurn?: boolean;
};

type DecisionRequestBody = {
  deckId?: number | null;
  archetype?: string | null;
  state: SimGameState | UiState;
  availableActions?: Array<{ type: string; card?: string | null }>;
  mode?: "tabular" | "neural" | "ensemble";
  landsPlayedThisTurn?: number;
  maxLandDrops?: number;
  options?: {
    confidenceThreshold?: number;
    minVisits?: number;
    topK?: number;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.AI_DECISION_PORT ?? 5200);
const POLICY_PATH =
  process.env.POLICY_PATH ??
  path.resolve(__dirname, "../../data/policy.json");
const NEURAL_MODEL_DIR =
  process.env.NEURAL_MODEL_PATH ??
  path.resolve(__dirname, "../../data");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

const prisma = process.env.DATABASE_URL ? getPrisma() : null;
let hasLoggedDbWarning = false;

function warnDbUnavailable(error: unknown) {
  if (hasLoggedDbWarning) return;
  hasLoggedDbWarning = true;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  console.warn(`[ai-server] database unavailable, continuing without deck metadata: ${message}`);
}

let cachedStore: PatternStore | null = null;
let cachedMtimeMs: number | null = null;
let cachedPolicyVersion: string | null = null;

async function loadPolicyStoreForServer(): Promise<PatternStore> {
  if (prisma) {
    try {
      const version = await getPolicyStoreVersion();
      const versionKey = `${version.count}:${version.updatedAt?.toISOString() ?? "none"}`;
      if (cachedStore && cachedPolicyVersion === versionKey) {
        return cachedStore;
      }
      cachedStore = await loadPolicyStore();
      cachedPolicyVersion = versionKey;
      cachedMtimeMs = null;
      return cachedStore;
    } catch (error) {
      warnDbUnavailable(error);
    }
  }

  try {
    const stat = fs.statSync(POLICY_PATH);
    if (cachedStore && cachedMtimeMs === stat.mtimeMs) {
      return cachedStore;
    }
    cachedStore = PatternStore.load(POLICY_PATH);
    cachedMtimeMs = stat.mtimeMs;
    return cachedStore;
  } catch {
    cachedStore = new PatternStore();
    cachedMtimeMs = null;
    cachedPolicyVersion = null;
    return cachedStore;
  }
}

let cachedNeuralNet: PolicyNet | null = null;
let cachedNeuralMtimeMs: number | null = null;

function loadNeuralModel(): PolicyNet | null {
  try {
    const latest = latestModel(NEURAL_MODEL_DIR);
    if (!latest) return null;
    const stat = fs.statSync(latest.path);
    if (cachedNeuralNet && cachedNeuralMtimeMs === stat.mtimeMs) {
      return cachedNeuralNet;
    }
    cachedNeuralNet = loadModel(latest.path);
    cachedNeuralMtimeMs = stat.mtimeMs;
    return cachedNeuralNet;
  } catch {
    return null;
  }
}

function isProbablyLandName(card: string) {
  const name = normalizeCardName(card);
  if (!name) return false;
  if (name.includes("land")) return true;
  if (name === "plains") return true;
  if (name === "island") return true;
  if (name === "swamp") return true;
  if (name === "mountain") return true;
  if (name === "forest") return true;
  if (name === "wastes") return true;
  if (/^snow-covered (plains|island|swamp|mountain|forest)$/i.test(name)) {
    return true;
  }
  return false;
}

async function detectArchetypeFromDeck(deckId: number): Promise<string | null> {
  if (!prisma) return null;
  try {
    const deck = await prisma.deck.findUnique({
      where: { id: deckId },
      select: { name: true, commander: true, cards: true, cardMetadata: true },
    });
    if (!deck) return null;
    const cards = Array.isArray(deck.cards) ? (deck.cards as string[]) : [];
    const cardMetadata = Array.isArray(deck.cardMetadata)
      ? (deck.cardMetadata as DeckCardMetadata[])
      : undefined;
    const scored = scoreArchetypeCategory({
      name: deck.name ?? undefined,
      commander: deck.commander ?? undefined,
      cards,
      cardMetadata,
    });
    return scored.category !== "UNKNOWN" ? scored.category : null;
  } catch {
    return null;
  }
}

async function loadDeckMetadataMap(
  deckId: number
): Promise<Record<string, DeckCardMetadata>> {
  if (!prisma) return {};
  try {
    const deck = await prisma.deck.findUnique({
      where: { id: deckId },
      select: { cardMetadata: true },
    });
    const entries = Array.isArray(deck?.cardMetadata)
      ? (deck!.cardMetadata as DeckCardMetadata[])
      : [];
    const map: Record<string, DeckCardMetadata> = {};
    for (const entry of entries) {
      if (!entry?.name) continue;
      map[entry.name.toLowerCase()] = entry;
      entry.aliases?.forEach((alias) => {
        if (alias) map[alias.toLowerCase()] = entry;
      });
    }
    return map;
  } catch (error) {
    warnDbUnavailable(error);
    return {};
  }
}

function isSimGameState(value: unknown): value is SimGameState {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.turn === "number" &&
    typeof obj.playerIndex === "number" &&
    Array.isArray(obj.lifeTotals) &&
    Array.isArray(obj.hands) &&
    Array.isArray(obj.battlefields)
  );
}

function toSimAction(input: { type: string; card?: string | null }): SimAction | null {
  const type = String(input.type ?? "").toUpperCase().trim();
  const card =
    typeof input.card === "string" && input.card.trim().length > 0
      ? input.card.trim()
      : null;

  switch (type) {
    case "PASS_TURN":
      return { type: "PASS_TURN" };
    case "PLAY_LAND":
      return card ? { type: "PLAY_LAND", card } : null;
    case "CAST_SPELL":
      return card ? { type: "CAST_SPELL", card } : null;
    default:
      return null;
  }
}

function inferAvailableActionsFromUi(
  state: UiState,
  landsPlayedThisTurn = 0,
  maxLandDrops = 1
): SimAction[] {
  const actions: SimAction[] = [{ type: "PASS_TURN" }];
  // canPlayLand rispetta il limite esatto: confronta il contatore con il max
  const canPlayLand =
    state.landPlayedThisTurn !== true &&
    landsPlayedThisTurn < maxLandDrops;
  const landsInPlay = (state.battlefield ?? []).filter((c) =>
    isProbablyLandName(c)
  ).length;

  if (canPlayLand) {
    for (const card of state.hand ?? []) {
      if (isProbablyLandName(card)) {
        actions.push({ type: "PLAY_LAND", card });
      }
    }
  }

  // Without metadata we can't reliably compute mana costs; only allow casts
  // once we have some mana on board.
  if (landsInPlay > 0) {
    for (const card of state.hand ?? []) {
      if (!isProbablyLandName(card)) {
        actions.push({ type: "CAST_SPELL", card });
      }
    }
  }

  return actions;
}

function buildSimStateFromUi(
  ui: UiState,
  metadataMap: Record<string, DeckCardMetadata>
): SimGameState {
  const players = 4;
  const playerIndex = 0;
  const empty = (): CardName[][] => Array(players).fill(null).map(() => []);
  const lifeTotals = Array(players).fill(40);
  lifeTotals[playerIndex] = Number(ui.life ?? 40);

  const hands = empty();
  hands[playerIndex] = Array.isArray(ui.hand) ? [...ui.hand] : [];

  const battlefields = empty();
  battlefields[playerIndex] = Array.isArray(ui.battlefield)
    ? [...ui.battlefield]
    : [];

  const graveyards = empty();
  graveyards[playerIndex] = Array.isArray(ui.graveyard) ? [...ui.graveyard] : [];

  const libraries = empty();
  const commanders = Array(players).fill(ui.commander ?? "Commander");
  const creatures = Array(players).fill(null).map(() => []);
  const artifacts = empty();
  const artifactMana = Array(players).fill(0);
  const manaSpent = Array(players).fill(0);
  const metadataMaps = Array(players).fill(null).map(() => ({}));
  metadataMaps[playerIndex] = metadataMap;

  const costReducers: Record<number, unknown[]> = {};
  const handSizeModifiers: Record<number, unknown[]> = {};
  const drawHistory: Record<number, number> = {};
  for (let i = 0; i < players; i++) {
    costReducers[i] = [];
    handSizeModifiers[i] = [];
    drawHistory[i] = 0;
  }

  return {
    turn: Number(ui.turn ?? 1),
    playerIndex,
    lifeTotals,
    libraries,
    hands,
    battlefields,
    graveyards,
    commanders,
    creatures,
    artifacts,
    artifactMana,
    manaSpent,
    cardMetadata: metadataMaps as any,
    triggers: [],
    triggerCounter: 1,
    phase: "Prima Fase Principale",
    phaseStep: "Prima Fase Principale",
    costReducers: costReducers as any,
    handSizeModifiers: handSizeModifiers as any,
    drawHistory,
    stack: [],
  };
}

function estimateAvailableMana(state: SimGameState, player = 0) {
  const battlefield = state.battlefields?.[player] ?? [];
  let total = 0;
  for (const card of battlefield) {
    const meta = getCardMetadata(state, player, card);
    if (typeof meta?.manaProduction === "number" && meta.manaProduction > 0) {
      total += meta.manaProduction;
      continue;
    }
    if (isLandCard(state, player, card)) {
      total += 1;
    }
  }
  return Math.max(0, total - (state.manaSpent?.[player] ?? 0));
}

function filterLegalActions(
  state: SimGameState,
  actions: SimAction[],
  options: { landPlayedThisTurn?: boolean; landsPlayedThisTurn?: number; maxLandDrops?: number } = {}
): SimAction[] {
  const player = 0;
  const hand = new Set((state.hands?.[player] ?? []).map((c) => String(c)));
  const availableMana = estimateAvailableMana(state, player);
  const landsPlayed = options.landsPlayedThisTurn ?? (options.landPlayedThisTurn ? 1 : 0);
  const maxDrops = options.maxLandDrops ?? 1;
  const canPlayLand = landsPlayed < maxDrops;

  const out: SimAction[] = [];
  for (const action of actions) {
    if (action.type === "PASS_TURN") {
      out.push(action);
      continue;
    }

    if ("card" in action) {
      if (!hand.has(action.card)) continue;
    }

    if (action.type === "PLAY_LAND") {
      if (!canPlayLand) continue;
      if (!isLandCard(state, player, action.card)) continue;
      out.push(action);
      continue;
    }

    if (action.type === "CAST_SPELL") {
      if (isLandCard(state, player, action.card)) continue;
      const meta = getCardMetadata(state, player, action.card);
      if (typeof meta?.manaValue !== "number") continue;
      if (meta.manaValue <= availableMana) {
        out.push(action);
      }
      continue;
    }
  }

  // Always keep at least PASS_TURN
  if (!out.some((a) => a.type === "PASS_TURN")) {
    out.unshift({ type: "PASS_TURN" });
  }
  return out;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    policyPath: POLICY_PATH,
    policySource: prisma ? "db" : "file",
  });
});

app.post("/decision", async (req, res) => {
  try {
    const body = req.body as DecisionRequestBody;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Body mancante." });
    }
    if (!body.state) {
      return res.status(400).json({ error: "state mancante." });
    }

    const deckId = typeof body.deckId === "number" ? body.deckId : null;
    const metadataMap =
      deckId && Number.isFinite(deckId) ? await loadDeckMetadataMap(deckId) : {};

    // Phase 4 — archetype: explicit > auto-detect from deckId
    let archetype: string | null =
      typeof body.archetype === "string" && body.archetype.trim().length > 0
        ? body.archetype.trim().toUpperCase()
        : null;
    if (!archetype && deckId && Number.isFinite(deckId)) {
      archetype = await detectArchetypeFromDeck(deckId);
    }

    const state = isSimGameState(body.state)
      ? body.state
      : buildSimStateFromUi(body.state as UiState, metadataMap);

    const landsPlayedThisTurn = typeof body.landsPlayedThisTurn === "number"
      ? body.landsPlayedThisTurn
      : undefined;
    const maxLandDrops = typeof body.maxLandDrops === "number" && body.maxLandDrops >= 1
      ? body.maxLandDrops
      : 1;

    const inferredActions =
      Array.isArray(body.availableActions) && body.availableActions.length
        ? body.availableActions
            .map((a) => toSimAction(a))
            .filter((a): a is SimAction => !!a)
        : isSimGameState(body.state)
          ? [{ type: "PASS_TURN" } as SimAction]
          : inferAvailableActionsFromUi(
              body.state as UiState,
              landsPlayedThisTurn ?? ((body.state as UiState).landPlayedThisTurn ? 1 : 0),
              maxLandDrops
            );

    const actions = filterLegalActions(state, inferredActions, {
      landsPlayedThisTurn: landsPlayedThisTurn ?? (
        isSimGameState(body.state)
          ? 0
          : ((body.state as UiState).landPlayedThisTurn ? 1 : 0)
      ),
      maxLandDrops,
    });

    const store = await loadPolicyStoreForServer();
    const requestMode = body.mode ?? "tabular";
    let agent: DecisionTreeAgent | NeuralAgent;

    if (requestMode === "neural" || requestMode === "ensemble") {
      const neuralNet = loadNeuralModel();
      if (neuralNet) {
        const neuralAgent = new NeuralAgent({
          id: "policy",
          store,
          epsilon: 0,
          archetype: archetype ?? undefined,
          neuralAlpha: requestMode === "ensemble" ? 0.7 : 1.0,
          confidenceThreshold:
            body.options?.confidenceThreshold ??
            Number(process.env.DECISION_TREE_CONFIDENCE ?? 0.05),
        });
        neuralAgent.setModel(neuralNet);
        agent = neuralAgent;
      } else {
        // Fallback to tabular if no model found
        agent = new DecisionTreeAgent({
          id: "policy",
          store,
          epsilon: 0,
          confidenceThreshold:
            body.options?.confidenceThreshold ??
            Number(process.env.DECISION_TREE_CONFIDENCE ?? 0.8),
          minVisits:
            body.options?.minVisits ??
            Number(process.env.DECISION_TREE_MIN_VISITS ?? 5),
          archetype: archetype ?? undefined,
        });
      }
    } else {
      agent = new DecisionTreeAgent({
        id: "policy",
        store,
        epsilon: 0,
        confidenceThreshold:
          body.options?.confidenceThreshold ??
          Number(process.env.DECISION_TREE_CONFIDENCE ?? 0.8),
        minVisits:
          body.options?.minVisits ??
          Number(process.env.DECISION_TREE_MIN_VISITS ?? 5),
        archetype: archetype ?? undefined,
      });
    }

    const decision = agent.decideAction(state, actions);
    return res.json({
      action: decision.action,
      metadata: decision.metadata ?? null,
      usedActions: actions,
      deckId,
      archetype,
      availableMana: estimateAvailableMana(state, 0),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : "Errore";
    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`[ai-server] listening on http://localhost:${PORT}`);
});
