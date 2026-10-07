export type PermanentCategoryKey = "creatures" | "planeswalkers" | "artifacts" | "enchantments" | "other";

export const PERMANENT_CATEGORIES: Array<{ key: PermanentCategoryKey; label: string }> = [
  { key: "creatures", label: "Creatures" },
  { key: "enchantments", label: "Enchantments" },
  { key: "artifacts", label: "Artifacts" },
  { key: "planeswalkers", label: "Planeswalkers" },
  { key: "other", label: "Other" },
];

export function permanentCategoryForTypeLine(typeLine = ""): PermanentCategoryKey {
  const type = typeLine.toLowerCase();
  if (type.includes("creature")) return "creatures";
  if (type.includes("planeswalker")) return "planeswalkers";
  if (type.includes("artifact")) return "artifacts";
  if (type.includes("enchantment")) return "enchantments";
  return "other";
}