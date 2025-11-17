import type { ComboData } from "../types/cards";

interface ComboFile {
  combos: ComboData[];
}

export async function generateFilteredComboFile() {
  try {
    const deckRes = await fetch("/CurrentDeck.json");
    const comboRes = await fetch("/commander-combos.json");
    if (!deckRes.ok || !comboRes.ok) {
      throw new Error("Impossibile leggere i file JSON");
    }

    const deck: string[] = await deckRes.json();
    const comboData: ComboFile = await comboRes.json();

    const deckSet = new Set(deck.map((c) => c.toLowerCase()));

    const filteredCombos = comboData.combos.filter((combo) =>
      combo.uses.every((use) => deckSet.has(use.card.name.toLowerCase()))
    );

    const payload = { combos: filteredCombos };

    const response = await fetch("http://localhost:3001/save-combos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error("Salvataggio fallito");

    console.log("✅ Combo Filtrate e Salvate");
  } catch (err) {
    console.error("❌ Errore:", err);
  }
}
