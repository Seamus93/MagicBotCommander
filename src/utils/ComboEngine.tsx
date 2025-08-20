export async function generateFilteredComboFile() {
  try {
    const deckRes = await fetch("/CurrentDeck.json");
    const comboRes = await fetch("/commander-combos.json");

    const deck = await deckRes.json();
    const comboData = await comboRes.json();

    const deckSet = new Set(deck.map((c: string) => c.toLowerCase()));

    const filteredCombos = comboData.combos.filter((combo: any) =>
      combo.uses.every((u: any) =>
        deckSet.has(u.card.name.toLowerCase())
      )
    );

    const payload = { combos: filteredCombos };

    const response = await fetch("http://localhost:3001/save-combos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error("Salvataggio fallito");

    console.log("✅ Combo Filtrate e Salvate");
  } catch (err) {
    console.error("❌ Errore:", err);
  }
}
