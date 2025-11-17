// src/ai/useDecisionAI.ts
import type { ComboData } from "../types/cards";

export type GameState = {
  turn: number;
  life: number;
  commander: string;
  hand: string[];
  battlefield: string[];
  graveyard: string[];
  exile: string[];
  combos: ComboData[];
};

export async function getDecision(gameState: GameState): Promise<string> {
  const prompt = generatePromptFromState(gameState);
  console.log("[AI] Sto per lanciare la fetch...");
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutMs = 15 * 60 * 1000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    

    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "mistral:7b-instruct",
        prompt,
        stream: false,
      }),
    });

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Risposta HTTP non valida: ${response.status}`);
    }

    console.log(`[AI] Risposta ricevuta in ${duration} secondi.`);
    const data = await response.json();
    console.log("[AI] Risposta AI:", data.response);

    return `${
      data.response?.trim() || "Nessuna risposta dall'AI."
    }\nTempo impiegato: ${duration} secondi.`;

  } catch (err) {
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.error(
      `[AI] Errore nella chiamata a Ollama (dopo ${duration} s):`,
      err
    );
    return `Errore durante la richiesta all'AI. (${duration} s)`;
  }
}


function generatePromptFromState(state: GameState): string {
  const sections = [
    `Turno: ${state.turn}`,
    `Punti vita: ${state.life}`,
    `Comandante: ${state.commander}`,
    `Carte in mano (${state.hand.length}): ${
      state.hand.length ? state.hand.join(", ") : "vuoto"
    }`,
    `Campo di battaglia (${state.battlefield.length}): ${
      state.battlefield.length ? state.battlefield.join(", ") : "vuoto"
    }`,
    `Cimitero (${state.graveyard.length}): ${
      state.graveyard.length ? state.graveyard.join(", ") : "vuoto"
    }`,
    `Esilio (${state.exile.length}): ${
      state.exile.length ? state.exile.join(", ") : "vuoto"
    }`,
  ];

  const comboText = state.combos.slice(0, 5).map((combo, idx) => {
    const pieces = combo.uses.map((use) => use.card?.name ?? "???");
    return `${idx + 1}. ${pieces.join(" + ")} - ${
      combo.description ?? "Nessuna descrizione"
    }`;
  });

  return `Agisci come un esperto giocatore di Commander competitivo.
Analizza lo stato della partita e suggerisci la migliore linea di gioco per il turno corrente.

${sections.join("\n")}

Combo disponibili:
${comboText.join("\n") || "Nessuna combo rilevante."}

Descrivi le tue azioni passo per passo.`;
}
