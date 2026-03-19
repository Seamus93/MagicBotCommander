import fetch from "node-fetch";
import type {
  EpisodeActionContext,
  SimAction,
  SimGameState,
  StateDigest,
} from "@game-state/types";
import { buildStateDigest } from "@game-state/stateDigest";

export interface AiDecisionResult {
  action: SimAction;
  reasoning?: string;
}

interface AiDecisionResponse {
  actionType?: string;
  card?: string;
  action?: { type: string; card?: string };
  reasoning?: string;
  details?: string;
}

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export interface AiDecisionRequest {
  state: SimGameState;
  availableActions: SimAction[];
  digest?: StateDigest;
  contextActions?: EpisodeActionContext[];
}

export async function requestAiDecision(
  params: AiDecisionRequest
): Promise<AiDecisionResult> {
  const endpoint = process.env.AI_DECISION_ENDPOINT;
  if (!endpoint) {
    throw new Error("AI_DECISION_ENDPOINT non configurato.");
  }

  const digest = params.digest ?? buildStateDigest(params.state);
  const payload = {
    state: digest,
    availableActions: params.availableActions.map(serializeAction),
    contextActions: params.contextActions ?? [],
    model: process.env.AI_DECISION_MODEL ?? undefined,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = process.env.AI_DECISION_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `AI endpoint ${response.status} ${response.statusText}: ${text}`
    );
  }

  const data = (await response.json()) as AiDecisionResponse;
  const action = normalizeAction(data);
  if (!action) {
    throw new Error(
      "Risposta AI non valida: atteso { actionType, card? } oppure { action: { type, card? } }."
    );
  }

  return { action, reasoning: data.reasoning ?? data.details };
}

function serializeAction(action: SimAction) {
  return {
    type: action.type,
    card: "card" in action ? action.card ?? null : null,
  };
}

function normalizeAction(data: AiDecisionResponse): SimAction | null {
  let type = data.actionType;
  let card = data.card;

  if (data.action) {
    type = data.action.type ?? type;
    if (isString(data.action.card)) {
      card = data.action.card;
    }
  }

  if (!isString(type)) {
    return null;
  }

  const normalized = type.toUpperCase();
  switch (normalized) {
    case "PASS_TURN":
      return { type: "PASS_TURN" };
    case "PLAY_LAND":
      if (!isString(card)) return null;
      return { type: "PLAY_LAND", card };
    case "CAST_SPELL":
      if (!isString(card)) return null;
      return { type: "CAST_SPELL", card };
    default:
      return null;
  }
}
