// src/ai/useDecisionAI.ts

export type GameState = {
  turn: number;
  life: number;
  commander: string;
  hand: string[];
  battlefield: string[];
  graveyard: string[];
  exile: string[];
  combos: { name: string; description: string }[];
};

export async function getDecision(gameState: GameState): Promise<string> {
  const prompt = generatePromptFromState(gameState);
  console.log("🟡 Sto per lanciare la fetch...");
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutMs = 15 * 60 * 1000; // ⏱️ 15 minuti
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

    console.log(`🟢 Risposta ricevuta in ${duration} secondi.`);
    const data = await response.json();
    console.log("📦 Risposta AI:", data.response);

    return `${data.response?.trim() || "⚠️ Nessuna risposta dall'AI."}\n⏱️ Tempo impiegato: ${duration} secondi.`;

  } catch (err) {
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.error(`❌ Errore nella chiamata a Ollama (dopo ${duration} s):`, err);
    return `Errore durante la richiesta all'AI. (⏱️ ${duration} s)`;
  }
}


function generatePromptFromState(state: GameState): string {
  return `
Sei un esperto giocatore di Commander competitivo.
"Cosa posso fare in questo turno se ho solo Forest e Llanowar Elves in campo?"`;
}
