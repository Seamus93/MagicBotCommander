import { describe, expect, it } from "vitest";
import type { DeckCardMetadata } from "@game-state/types";
import { mechanicRegistry } from "../mechanicRegistry.js";
import { parseCardRules } from "../oraclePatternRegistry.js";
import {
  analyzeRepositoryRulesCoverage,
  calculateDeckRulesCoverage,
  classifyCardRulesCoverage,
} from "../rulesCoverage.js";

const card = (metadata: DeckCardMetadata) => metadata;

describe("OraclePatternRegistry", () => {
  it("parses supported spell and trigger patterns into generic abilities", () => {
    const parsed = parseCardRules(card({
      name: "Test Charm",
      typeLine: "Instant",
      oracleText: "Destroy target creature.\nYou gain 3 life.",
    }));

    expect(parsed.recognizedFragments.map((fragment) => fragment.patternId)).toEqual([
      "DESTROY_TARGET_CREATURE",
      "GAIN_LIFE",
    ]);
    expect(parsed.abilities.map((ability) => ability.effects[0]?.type)).toEqual([
      "DESTROY",
      "GAIN_LIFE",
    ]);
  });

  it("keeps coverage and parser coherent from the same registry", () => {
    const metadata = card({
      name: "Visionary A",
      typeLine: "Creature - Elf",
      oracleText: "When Visionary A enters, draw a card.",
      isCreature: true,
      isPermanent: true,
    });

    const parsed = parseCardRules(metadata);
    const coverage = classifyCardRulesCoverage(metadata);

    expect(parsed.supportLevel).toBe("FULL");
    expect(coverage.coverage).toBe(parsed.supportLevel);
    expect(coverage.recognizedPatterns).toContain("ETB_DRAW");
  });

  it("identifies unsupported fragments instead of inventing behavior", () => {
    const parsed = parseCardRules(card({
      name: "Crime Witness",
      typeLine: "Creature - Rogue",
      oracleText: "Whenever you commit a crime, surveil 1.",
      isCreature: true,
      isPermanent: true,
    }));

    expect(parsed.supportLevel).toBe("UNSUPPORTED");
    expect(parsed.unsupportedFragments[0]).toContain("commit a crime");
  });

  it("parses MDFC faces separately", () => {
    const parsed = parseCardRules(card({
      name: "Pinnacle Monk // Mystic Peak",
      typeLine: "Creature - Human Monk // Land",
      faces: [
        {
          name: "Pinnacle Monk",
          typeLine: "Creature - Human Monk",
          oracleText: "Prowess",
          isCreature: true,
          isPermanent: true,
        },
        {
          name: "Mystic Peak",
          typeLine: "Land",
          oracleText: "Mystic Peak enters tapped.\n{T}: Add {R}.",
          isLand: true,
          isPermanent: true,
        },
      ],
    }));

    expect(parsed.recognizedFragments.map((fragment) => fragment.patternId)).toContain("ENTERS_TAPPED");
    expect(parsed.recognizedFragments.map((fragment) => fragment.patternId)).toContain("ADD_MANA");
    expect(parsed.unsupportedFragments).toEqual(["Prowess"]);
  });

  it("parses dies, upkeep, token, counter, and damage patterns", () => {
    const parsed = parseCardRules(card({
      name: "Rules Sampler",
      typeLine: "Creature - Wizard",
      oracleText:
        "When Rules Sampler dies, draw a card.\n" +
        "At the beginning of your upkeep, you gain 1 life.\n" +
        "Create two 1/1 white Soldier creature tokens.\n" +
        "Put two +1/+1 counters on target creature.\n" +
        "Rules Sampler deals 2 damage to each opponent.",
      isCreature: true,
      isPermanent: true,
    }));

    expect(parsed.recognizedFragments.map((fragment) => fragment.patternId)).toEqual([
      "DIES_DRAW",
      "UPKEEP_TRIGGER",
      "CREATE_TOKEN",
      "ADD_COUNTER",
      "DEAL_DAMAGE",
    ]);
    expect(parsed.abilities.flatMap((ability) => ability.effects.map((effect) => effect.type))).toEqual([
      "DRAW_CARDS",
      "GAIN_LIFE",
      "CREATE_TOKEN",
      "ADD_COUNTER",
      "DEAL_DAMAGE",
    ]);
  });

  it("uses the mechanic registry for named mechanics", () => {
    const parsed = parseCardRules(card({
      name: "Marchesa Scout",
      typeLine: "Creature - Human",
      oracleText: "Dethrone",
      isCreature: true,
      isPermanent: true,
    }));

    expect(mechanicRegistry().map((mechanic) => mechanic.id)).toEqual(
      expect.arrayContaining(["DETHRONE", "RAID", "REVOLT"])
    );
    expect(parsed.recognizedFragments.map((fragment) => fragment.patternId)).toContain("MECHANIC_DETHRONE");
    expect(parsed.abilities[0]?.trigger?.eventType).toBe("ATTACKER_DECLARED");
  });

  it("produces cross-card equivalent parsed abilities for equivalent text", () => {
    const a = parseCardRules(card({
      name: "Elvish Visionary",
      typeLine: "Creature - Elf",
      oracleText: "When Elvish Visionary enters, draw a card.",
      isCreature: true,
      isPermanent: true,
    }));
    const b = parseCardRules(card({
      name: "Helpful Familiar",
      typeLine: "Creature - Bird",
      oracleText: "When Helpful Familiar enters, draw a card.",
      isCreature: true,
      isPermanent: true,
    }));

    expect(a.abilities[0]?.patternId).toBe("ETB_DRAW");
    expect(b.abilities[0]?.patternId).toBe("ETB_DRAW");
    expect(a.abilities[0]?.effects).toEqual(b.abilities[0]?.effects);
  });

  it("reports repository-level missing capabilities globally", () => {
    const report = analyzeRepositoryRulesCoverage([
      {
        name: "Deck A",
        cardMetadata: [
          card({ name: "Copy Card", oracleText: "Copy target spell." }),
          card({ name: "Known Card", oracleText: "Draw a card." }),
        ],
      },
      {
        name: "Deck B",
        cardMetadata: [
          card({ name: "Copy Card 2", oracleText: "Copy target spell." }),
        ],
      },
    ]);

    expect(report.decksAnalyzed).toBe(2);
    expect(report.supportedPatternFrequency.DRAW_CARDS).toBe(1);
    expect(report.topMissingCapabilities[0]).toMatchObject({
      capability: "COPY",
      affectedCards: 2,
      affectedDecks: 2,
    });
    expect(calculateDeckRulesCoverage([{ name: "Known Card", oracleText: "Draw a card." }]).fullCount).toBe(1);
  });

  it("parses graveyard return patterns cross-card", () => {
    const toHand = parseCardRules(card({
      name: "Raise Dead Variant",
      typeLine: "Sorcery",
      oracleText: "Return target creature card from your graveyard to your hand.",
    }));
    const toBattlefield = parseCardRules(card({
      name: "Reanimate Variant",
      typeLine: "Sorcery",
      oracleText: "Return target creature card from your graveyard to the battlefield.",
    }));

    expect(toHand.abilities[0]?.effects[0]).toMatchObject({
      type: "RETURN_FROM_GRAVEYARD_TO_HAND",
      fromZone: "graveyard",
      toZone: "hand",
      cardType: "creature",
    });
    expect(toBattlefield.abilities[0]?.effects[0]).toMatchObject({
      type: "RETURN_FROM_GRAVEYARD_TO_BATTLEFIELD",
      fromZone: "graveyard",
      toZone: "battlefield",
      cardType: "creature",
    });
  });

  it("parses sacrifice costs separately from sacrifice effects", () => {
    const cost = parseCardRules(card({
      name: "Costly Bargain",
      typeLine: "Sorcery",
      oracleText: "As an additional cost to cast this spell, sacrifice a creature.",
    }));
    const effect = parseCardRules(card({
      name: "Cruel Edict",
      typeLine: "Sorcery",
      oracleText: "Target player sacrifices a creature.",
    }));

    expect(cost.abilities[0]?.costs?.[0]).toMatchObject({ type: "SACRIFICE", cardType: "creature" });
    expect(cost.abilities[0]?.effects).toEqual([]);
    expect(effect.abilities[0]?.effects[0]).toMatchObject({ type: "SACRIFICE", cardType: "creature", controller: "opponent" });
  });

  it("parses generic counters and complex token descriptors", () => {
    const counters = parseCardRules(card({
      name: "Counter Study",
      typeLine: "Sorcery",
      oracleText: "Put two charge counters on target permanent.\nRemove a lore counter from target permanent.",
    }));
    const tokens = parseCardRules(card({
      name: "Token Study",
      typeLine: "Sorcery",
      oracleText: "Create three tapped 2/2 black Zombie creature tokens.\nCreate one Treasure token.\nCreate a 1/1 red Pirate creature token that's tapped and attacking.",
    }));

    expect(counters.abilities.map((ability) => ability.effects[0])).toEqual([
      expect.objectContaining({ type: "ADD_COUNTER", counterType: "charge", target: "targetPermanent" }),
      expect.objectContaining({ type: "REMOVE_COUNTER", counterType: "lore", target: "targetPermanent" }),
    ]);
    expect(tokens.abilities[0]?.effects[0].token).toMatchObject({
      count: 3,
      colors: ["B"],
      power: 2,
      toughness: 2,
      tapped: true,
    });
    expect(tokens.abilities[1]?.effects[0].token).toMatchObject({
      name: "Treasure",
      types: ["Artifact"],
      subtypes: ["Treasure"],
    });
    expect(tokens.abilities[2]?.effects[0].token).toMatchObject({
      attacking: true,
      tapped: true,
    });
  });

  it("marks may and up to one graveyard targets as optional", () => {
    const parsed = parseCardRules(card({
      name: "Optional Return",
      typeLine: "Sorcery",
      oracleText: "You may return up to one target permanent card from your graveyard to your hand.",
    }));

    expect(parsed.abilities[0]?.effects[0]).toMatchObject({ optional: true, cardType: "permanent" });
    expect(parsed.abilities[0]?.targets?.[0]).toMatchObject({ zone: "graveyard", required: false, optional: true });
  });

  it("keeps coverage partial when recognized token quantity needs runtime approximation", () => {
    const coverage = classifyCardRulesCoverage(card({
      name: "Many Bodies",
      typeLine: "Sorcery",
      oracleText: "Create a 1/1 white Soldier creature token for each creature you control.",
    }));

    expect(coverage.recognizedPatterns).toContain("CREATE_TOKEN");
    expect(coverage.coverage).toBe("PARTIAL");
  });
});
