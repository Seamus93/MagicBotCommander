import { describe, expect, it } from "vitest";
import { permanentCategoryForTypeLine } from "./permanentCategory";

describe("permanentCategoryForTypeLine", () => {
  it.each([
    ["Legendary Creature — Human", "creatures"],
    ["Enchantment", "enchantments"],
    ["Artifact", "artifacts"],
    ["Legendary Planeswalker — Jace", "planeswalkers"],
    ["Artifact Creature — Golem", "creatures"],
    ["Enchantment Creature — Spirit", "creatures"],
    ["Artifact Enchantment", "artifacts"],
    ["Battle", "other"],
  ] as const)("classifies %s as %s", (typeLine, category) => {
    expect(permanentCategoryForTypeLine(typeLine)).toBe(category);
  });
});