import { describe, expect, it } from "vitest";
import { cardPreviewFace } from "./cardPreviewFace";

describe("cardPreviewFace", () => {
  it("infers an MDFC front face when inspected outside the battlefield", () => {
    expect(cardPreviewFace("Pinnacle Monk / Mystic Peak")).toEqual({
      imageName: "Pinnacle Monk / Mystic Peak",
      imageFace: "front",
    });
    expect(cardPreviewFace("Glasspool Mimic // Glasspool Shore")).toEqual({
      imageName: "Glasspool Mimic // Glasspool Shore",
      imageFace: "front",
    });
  });

  it("preserves the selected MDFC face supplied by the battlefield", () => {
    expect(cardPreviewFace("Glasspool Shore", "Glasspool Mimic // Glasspool Shore", "back")).toEqual({
      imageName: "Glasspool Mimic // Glasspool Shore",
      imageFace: "back",
    });
  });

  it("does not add a flip face to ordinary cards", () => {
    expect(cardPreviewFace("Drowned Catacomb")).toEqual({});
  });
});