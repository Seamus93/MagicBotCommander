// src/utils/DeckParser.ts

export function parseDeckList(text: string): string[] {
  let inSideboard = false;

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith("#")) return false;
      if (/^sideboard[:]?$/i.test(line)) {
        inSideboard = true;
        return false;
      }
      return !inSideboard;
    })
    .map((line) => {
      const match = line.match(/^\d+\s+(.+?)\s+(\(|\/\/)/);
      if (match) return match[1].trim();

      const fallback = line.replace(/^\d+\s+/, "").split("(")[0];
      return fallback.trim();
    })
    .filter((name) => !!name);
}
