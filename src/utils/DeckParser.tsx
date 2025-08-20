// src/utils/DeckParser.ts

export function parseDeckList(text: string): string[] {
  return text
    .split("\n")                                // 1. Dividi per riga
    .map((line) => line.trim())                 // 2. Rimuovi spazi iniziali/finali
    .filter((line) => line && !line.startsWith("#")) // 3. Salta righe vuote o commenti

    // 4. Estrai solo il nome della carta (prima del set info)
    .map((line) => {
      // Esempio linea: "1 Nicol Bolas, the Ravager // Nicol Bolas, the Arisen (M19) 218"
      const match = line.match(/^\d+\s+(.+?)\s+(\(|\/\/)/);
      if (match) return match[1].trim();
      
      // Fallback: prendi tutto dopo il numero
      const fallback = line.replace(/^\d+\s+/, "").split("(")[0];
      return fallback.trim();
    });
}
