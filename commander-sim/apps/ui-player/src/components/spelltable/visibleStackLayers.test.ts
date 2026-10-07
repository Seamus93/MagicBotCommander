import { describe, expect, it } from "vitest";
import { visibleStackLayers } from "./visibleStackLayers";

describe("visibleStackLayers", () => {
  it.each([
    [1, 0],
    [2, 1],
    [3, 2],
    [8, 2],
  ])("shows %i card(s) with %i backing layer(s)", (cardCount, expectedLayers) => {
    expect(visibleStackLayers(cardCount)).toBe(expectedLayers);
  });
});