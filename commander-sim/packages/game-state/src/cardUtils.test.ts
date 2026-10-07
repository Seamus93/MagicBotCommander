import { describe, expect, it } from "vitest";
import {
  activeFaceMetadata,
  getLandFaceMetadata,
  getLandPermanentName,
  getCardFaceImageSide,
  isLandCard,
  getSpellFaceMetadata,
  getSpellPermanentName,
  metadataForSelectedFace,
  resolveSelectedFace,
} from "./cardUtils.js";
import type { DeckCardMetadata, SimGameState } from "./types.js";

describe("MDFC face metadata fallback", () => {
  const glasspool: DeckCardMetadata = {
    name: "Glasspool Mimic / Glasspool Shore",
    typeLine: "Creature — Shapeshifter Rogue // Land",
    manaCost: "{2}{U}",
    manaValue: 3,
    isLand: true,
  };

  it("resolves the land and spell faces from composite names and type lines", () => {
    expect(getLandFaceMetadata(glasspool)).toMatchObject({ name: "Glasspool Shore", isLand: true });
    expect(getSpellFaceMetadata(glasspool)).toMatchObject({ name: "Glasspool Mimic", isCreature: true });
    expect(getLandPermanentName(glasspool.name, glasspool)).toBe("Glasspool Shore");
    expect(getSpellPermanentName(glasspool.name, glasspool)).toBe("Glasspool Mimic");
  });

  it("resolves selected faces through the same normalized metadata path", () => {
    expect(resolveSelectedFace(glasspool, "Glasspool Shore")?.typeLine).toBe("Land");
    expect(activeFaceMetadata(glasspool, "Glasspool Mimic")?.typeLine).toBe("Creature — Shapeshifter Rogue");
    expect(metadataForSelectedFace(glasspool, "Glasspool Shore")?.name).toBe("Glasspool Shore");
    expect(getCardFaceImageSide(glasspool, "Glasspool Mimic")).toBe("front");
    expect(getCardFaceImageSide(glasspool, "Glasspool Shore")).toBe("back");
  });

  it("parses Scryfall double-slash face names without retaining a slash in the land face", () => {
    const pinnacle: DeckCardMetadata = {
      name: "Pinnacle Monk // Mystic Peak",
      typeLine: "Creature — Human Monk // Land",
      manaCost: "{4}{R}",
      manaValue: 5,
    };

    expect(getLandFaceMetadata(pinnacle)).toMatchObject({ name: "Mystic Peak", isLand: true });
    expect(getLandPermanentName(pinnacle.name, pinnacle)).toBe("Mystic Peak");
    expect(resolveSelectedFace(pinnacle, "Mystic Peak")?.name).toBe("Mystic Peak");
    expect(getCardFaceImageSide(pinnacle, "Mystic Peak")).toBe("back");
  });

  it("classifies an MDFC by its active face, not by the existence of any land face", () => {
    const pinnacle: DeckCardMetadata = {
      name: "Pinnacle Monk // Mystic Peak",
      typeLine: "Creature — Human Monk // Land",
      manaCost: "{4}{R}",
      manaValue: 5,
    };
    const state = {
      cardMetadata: [{
        [pinnacle.name.toLowerCase()]: pinnacle,
        "pinnacle monk": pinnacle,
        "mystic peak": pinnacle,
      }],
    } as unknown as SimGameState;

    expect(isLandCard(state, 0, "Pinnacle Monk")).toBe(false);
    expect(isLandCard(state, 0, "Mystic Peak")).toBe(true);
    expect(isLandCard(state, 0, pinnacle.name)).toBe(true);
  });
});