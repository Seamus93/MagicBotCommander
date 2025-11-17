const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetchFn }) => fetchFn(...args));

const app = express();
const PORT = 3001;

app.use(cors());
app.use(bodyParser.json());

// ✅ Salva il deck ricevuto dal client
app.post("/save-deck", (req, res) => {
  const deck = req.body;
  if (!Array.isArray(deck)) {
    return res.status(400).json({ error: "Formato mazzo non valido." });
  }

  const outputPath = path.join(__dirname, "public", "CurrentDeck.json");
  fs.writeFileSync(outputPath, JSON.stringify(deck, null, 2));
  console.log("✅ Deck salvato in public/CurrentDeck.json");
  res.json({ success: true });
});

// Endpoint per salvare il file combo filtrato
app.post("/save-combos", (req, res) => {
  const filteredCombos = req.body;

  if (!filteredCombos || !filteredCombos.combos) {
    return res.status(400).json({ error: "Formato non valido" });
  }

  const filePath = path.join(__dirname, "public", "FilteredCombos.json");

  fs.writeFile(filePath, JSON.stringify(filteredCombos, null, 2), (err) => {
    if (err) {
      console.error("Errore nel salvataggio:", err);
      return res.status(500).json({ error: "Errore nel salvataggio" });
    }

    console.log("✅ FilteredCombos salvato!");
    res.json({ success: true });
  });
});

const extractCards = (section = {}) => {
  const cards = [];
  Object.values(section).forEach((entry) => {
    if (!entry || !entry.quantity) return;
    const name = entry.card?.name;
    if (!name) return;
    for (let i = 0; i < entry.quantity; i += 1) {
      cards.push(name);
    }
  });
  return cards;
};

app.post("/fetch-moxfield-deck", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL mancante" });
    }
    let slug;
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      slug = parts[parts.length - 1];
    } catch (err) {
      slug = null;
    }
    if (!slug) {
      return res.status(400).json({ error: "URL Moxfield non valido" });
    }
    const apiUrl = `https://api2.moxfield.com/v2/decks/all/${slug}`;
    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "MagicBotCommander/1.0",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error:
          text ||
          `Impossibile recuperare il deck da Moxfield (status ${response.status})`,
      });
    }
    const data = await response.json();
    const cards = [
      ...extractCards(data.commanders || data.commander),
      ...extractCards(data.mainboard),
    ];
    if (cards.length === 0) {
      return res
        .status(400)
        .json({ error: "Nessuna carta trovata nell'export Moxfield" });
    }
    return res.json({ cards });
  } catch (error) {
    console.error("Errore fetch Moxfield:", error);
    return res.status(500).json({ error: "Errore interno durante il fetch" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server backend avviato su http://localhost:${PORT}`);
});
