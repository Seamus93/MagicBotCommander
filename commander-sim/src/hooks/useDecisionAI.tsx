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
  console.log("[AI] Sto per lanciare Puter.js...");
  const start = Date.now();
  try {
    if (!window.puter?.ai?.chat) {
      throw new Error(
        "Puter.js non inizializzato. Assicurati che lo script sia caricato."
      );
    }

    const response = await window.puter.ai.chat(prompt, {
      model: "gpt-5.1",
      temperature: 0.4,
      max_tokens: 600,
    });

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[AI] Risposta ricevuta in ${duration} secondi.`);

    if (
      typeof response === "object" &&
      response !== null &&
      "success" in response &&
      // @ts-expect-error dinamico
      response.success === false
    ) {
      const errorMessage =
        // @ts-expect-error dinamico
        response.error || "Errore sconosciuto di Puter.";
      throw new Error(errorMessage);
    }

    const extractMessage = (): string | undefined => {
      if (typeof response === "string") return response;
      if (!response) return undefined;
      // @ts-expect-error dinamico
      if (typeof response.message === "string") return response.message;
      // @ts-expect-error dinamico
      if (response.message?.content) {
        // @ts-expect-error dinamico
        return typeof response.message.content === "string"
          ? // @ts-expect-error dinamico
            response.message.content
          : JSON.stringify(response.message.content);
      }
      // @ts-expect-error dinamico
      if (typeof response.text === "string") return response.text;
      return undefined;
    };

    const message = extractMessage();

    return `${
      message?.trim() || "Nessuna risposta dall'AI."
    }\nTempo impiegato: ${duration} secondi.`;
  } catch (err) {
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.error(
      `[AI] Errore nella chiamata a Puter (dopo ${duration} s):`,
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
