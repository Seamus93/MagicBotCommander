// scripts/downloadCombos.js
const fs = require("fs");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function fetchAll(url) {
  let results = [];
  let next = url;

  while (next) {
    const res = await fetch(next);
    const json = await res.json();
    results = results.concat(json.results);
    next = json.next;
    console.log(`Fetched ${results.length} so far...`);
  }

  return results;
}

(async () => {
  try {
    console.log("Downloading cards...");
    const allCards = await fetchAll("https://backend.commanderspellbook.com/cards");

    console.log("Downloading variants...");
    const allCombos = await fetchAll("https://backend.commanderspellbook.com/variants");

    const data = {
      cards: allCards,
      combos: allCombos,
      lastUpdated: new Date().toISOString(),
    };

    fs.writeFileSync("public/commander-combos.json", JSON.stringify(data, null, 2));
    console.log("✅ Combo salvate in public/commander-combos.json");
  } catch (err) {
    console.error("❌ Errore nel salvataggio:", err);
  }
})();
