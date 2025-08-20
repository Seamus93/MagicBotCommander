const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");

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

app.listen(PORT, () => {
  console.log(`🚀 Server backend avviato su http://localhost:${PORT}`);
});
