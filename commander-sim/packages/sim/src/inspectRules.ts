import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fetchCardMetadata } from "./cardMetadata.js";
import { parseCardRules } from "./oraclePatternRegistry.js";
import { classifyCardRulesCoverage } from "./rulesCoverage.js";
import type { DeckCardMetadata } from "@game-state/types";

config();

const cardName = process.argv.slice(2).join(" ").trim();

if (!cardName) {
  console.error('Usage: npm run rules:inspect -- "Card Name"');
  process.exit(1);
}

const prisma = new PrismaClient();

function describeEffects(metadata: DeckCardMetadata) {
  const parsed = parseCardRules(metadata);
  const coverage = classifyCardRulesCoverage(metadata);
  console.log(`Card: ${metadata.name}`);
  console.log(`Coverage: ${coverage.coverage}`);

  console.log("\nRecognized:");
  if (!parsed.recognizedFragments.length) {
    console.log("- none");
  }
  for (const recognized of parsed.recognizedFragments) {
    const abilities = parsed.abilities.filter((ability) => ability.patternId === recognized.patternId);
    console.log(`- ${recognized.patternId} (${recognized.supportLevel})`);
    for (const ability of abilities) {
      console.log(`  Kind: ${ability.kind}`);
      if (ability.trigger) console.log(`  Trigger: ${ability.trigger.eventType}`);
      if (ability.conditions?.length) console.log(`  Conditions: ${ability.conditions.map((condition) => condition.type).join(", ")}`);
      if (ability.targets?.length) console.log(`  Targets: ${ability.targets.map((target) => target.type).join(", ")}`);
      console.log(`  Effects: ${ability.effects.map((effect) => `${effect.type}${effect.amount ? ` ${effect.amount}` : ""}`).join(", ") || "none"}`);
    }
  }

  console.log("\nUnsupported:");
  if (!parsed.unsupportedFragments.length) {
    console.log("- none");
  } else {
    for (const fragment of parsed.unsupportedFragments) console.log(`- "${fragment}"`);
  }
}

async function findMetadata(name: string): Promise<DeckCardMetadata | null> {
  try {
    const decks = await prisma.deck.findMany({
      select: { cardMetadata: true },
      take: 10,
    });
    for (const deck of decks) {
      const metadata = Array.isArray(deck.cardMetadata)
        ? deck.cardMetadata as unknown as DeckCardMetadata[]
        : [];
      const found = metadata.find((entry) =>
        entry.name.toLowerCase() === name.toLowerCase() ||
        entry.aliases?.some((alias) => alias.toLowerCase() === name.toLowerCase())
      );
      if (found) return found;
    }
  } catch (error) {
    console.warn(`[RulesInspect] DB lookup skipped: ${(error as Error).message}`);
  }
  return fetchCardMetadata(name);
}

try {
  const metadata = await findMetadata(cardName);
  if (!metadata) {
    console.error(`[RulesInspect] Card not found: ${cardName}`);
    process.exitCode = 1;
  } else {
    describeEffects(metadata);
  }
} finally {
  await prisma.$disconnect();
}
