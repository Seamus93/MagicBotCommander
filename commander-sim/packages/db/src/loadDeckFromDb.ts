import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const deckId = Number(process.argv[2]);
  if (!deckId) {
    console.error("Usage: tsx packages/db/src/loadDeckFromDb.ts <deckId>");
    process.exit(1);
  }
  const deck = await prisma.deck.findUnique({ where: { id: deckId } });
  console.log(deck);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
