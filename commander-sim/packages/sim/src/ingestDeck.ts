import "dotenv/config";
import { upsertDeck } from "@db/db";

async function main() {
  const cardsEnv = process.env.DECK_CARDS;
  if (!cardsEnv) {
    console.error("Set DECK_CARDS as comma-separated list of card names.");
    process.exit(1);
  }
  const cards = cardsEnv.split(",").map((c) => c.trim()).filter(Boolean);
  const deck = await upsertDeck({
    cards,
    sourceUrl: process.env.DECK_URL ?? undefined,
    name: process.env.DECK_NAME ?? undefined,
    commander: process.env.DECK_COMMANDER ?? undefined,
  });
  console.log("Deck saved:", deck);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
