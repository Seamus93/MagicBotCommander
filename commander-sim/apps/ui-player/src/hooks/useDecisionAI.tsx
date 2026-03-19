// src/ai/useDecisionAI.ts
import type { ComboData } from "../types/cards";

export type GameState = {
  deckId?: number | null;
  turn: number;
  life: number;
  commander: string;
  hand: string[];
  battlefield: string[];
  graveyard: string[];
  exile: string[];
  combos: ComboData[];
  landPlayedThisTurn?: boolean;
  landsPlayedThisTurn?: number;
  maxLandDrops?: number;
};

export async function getDecision(gameState: GameState): Promise<string> {
  try {
    const endpoint =
      import.meta.env.VITE_AI_DECISION_URL ?? "http://localhost:5200";
    const start = Date.now();

    const res = await fetch(`${endpoint}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deckId: typeof gameState.deckId === "number" ? gameState.deckId : null,
        state: {
          turn: gameState.turn,
          life: gameState.life,
          commander: gameState.commander,
          hand: gameState.hand,
          battlefield: gameState.battlefield,
          graveyard: gameState.graveyard,
          exile: gameState.exile,
          landPlayedThisTurn: gameState.landPlayedThisTurn ?? false,
        },
        landsPlayedThisTurn: gameState.landsPlayedThisTurn ?? 0,
        maxLandDrops: gameState.maxLandDrops ?? 1,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }

    const data = (await res.json()) as any;
    const action = data?.action;
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    if (!action?.type) {
      return `Nessuna decisione valida dal servizio AI. (${duration} s)`;
    }
    const card = action.card ? ` (${action.card})` : "";
    const meta = data?.metadata?.confidence
      ? `conf: ${Number(data.metadata.confidence).toFixed(2)}`
      : data?.metadata?.source
        ? `source: ${data.metadata.source}`
        : null;
    return `Azione suggerita: ${action.type}${card}${
      meta ? `\n${meta}` : ""
    }\nTempo impiegato: ${duration} secondi.`;
  } catch (err) {
    const friendly =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Errore sconosciuto";
    return `Errore durante la richiesta al servizio AI: ${friendly}.`;
  }
}
