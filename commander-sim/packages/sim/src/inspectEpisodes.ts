import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type FinalState = {
  turn?: number;
  lifeTotals?: number[];
  hands?: string[][];
  battlefields?: string[][];
  graveyards?: string[][];
};

const runIdArg = process.argv[2] ? Number(process.argv[2]) : null;
const limit = process.argv[3] ? Number(process.argv[3]) : 10;

async function main() {
  const run =
    runIdArg && !Number.isNaN(runIdArg)
      ? await prisma.simulationRun.findUnique({ where: { id: runIdArg } })
      : await prisma.simulationRun.findFirst({
          orderBy: { id: "desc" },
        });

  if (!run) {
    console.log("Nessun run trovato.");
    return;
  }

  const episodes = await prisma.episode.findMany({
    where: { runId: run.id },
    orderBy: { index: "asc" },
    take: Number.isNaN(limit) ? undefined : limit,
  });

  console.log(
    `Run #${run.id} (episodi: ${run.episodes}, deckIds: ${JSON.stringify(
      run.deckIds ?? []
    )})`
  );

  for (const ep of episodes) {
    const state = (ep.finalState as FinalState) ?? {};
    const lifeTotals =
      state.lifeTotals?.map((life, idx) => `P${idx}:${life}`).join(", ") ??
      "n/d";
    const handSizes =
      state.hands?.map((hand, idx) => `P${idx}:${hand.length}`).join(", ") ??
      "n/d";
    const battlefieldSizes =
      state.battlefields
        ?.map((field, idx) => `P${idx}:${field.length}`)
        .join(", ") ?? "n/d";

    console.log(
      [
        `- Ep ${ep.index}`,
        `winner: ${
          typeof ep.winnerIndex === "number" ? `P${ep.winnerIndex}` : "pareggio"
        }`,
        `turns: ${ep.turnCount ?? "?"}`,
        `life: ${lifeTotals}`,
        `hands: ${handSizes}`,
        `battlefield: ${battlefieldSizes}`,
      ].join(" | ")
    );
  }
}

main()
  .catch((err) => {
    console.error("Errore inspect episodes:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
