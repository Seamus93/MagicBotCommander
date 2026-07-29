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
          card({ name: "Grave Card", oracleText: "Return target creature card from your graveyard to the battlefield." }),
          card({ name: "Known Card", oracleText: "Draw a card." }),
        ],
      },
      {
        name: "Deck B",
        cardMetadata: [
          card({ name: "Grave Card 2", oracleText: "Return target creature card from your graveyard to the battlefield." }),
        ],
      },
    ]);

    expect(report.decksAnalyzed).toBe(2);
    expect(report.supportedPatternFrequency.DRAW_CARDS).toBe(1);
    expect(report.topMissingCapabilities[0]).toMatchObject({
      capability: "GRAVEYARD_RETURN",
      affectedCards: 2,
      affectedDecks: 2,
    });
    expect(calculateDeckRulesCoverage([{ name: "Known Card", oracleText: "Draw a card." }]).fullCount).toBe(1);
  });
});
