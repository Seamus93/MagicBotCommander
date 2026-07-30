#!/usr/bin/env tsx
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

type ResetOptions = {
  dryRun: boolean;
  yes: boolean;
  keepPolicyFile: boolean;
  keepEvaluationFiles: boolean;
};

type DbCounts = {
  policyRecord: number;
  simulationRun: number;
  episode: number;
  episodeStep: number;
  matchupStats: number;
  deck: number;
  archetype: number;
  cardMetadataCards: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../..");
const dataDir = path.join(rootDir, "data");
const defaultPolicyPath = path.join(dataDir, "policy.json");
const evaluationDir = path.join(dataDir, "evaluation");

function parseArgs(argv: string[]): ResetOptions {
  const flags = new Set(argv.map((arg) => arg.trim().toLowerCase()));
  return {
    dryRun: flags.has("--dry-run"),
    yes: flags.has("--yes") || flags.has("-y"),
    keepPolicyFile: flags.has("--keep-policy-file"),
    keepEvaluationFiles: flags.has("--keep-evaluation-files"),
  };
}

function resolvePolicyPath() {
  const raw = process.env.POLICY_PATH?.trim();
  if (!raw) return defaultPolicyPath;
  return path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
}

function assertInsideProject(filePath: string) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to delete path outside project: ${resolved}`);
  }
  return resolved;
}

async function collectCounts(prisma: PrismaClient): Promise<DbCounts> {
  const [
    policyRecord,
    simulationRun,
    episode,
    episodeStep,
    matchupStats,
    deck,
    archetype,
    decks,
  ] = await Promise.all([
    prisma.policyRecord.count(),
    prisma.simulationRun.count(),
    prisma.episode.count(),
    prisma.episodeStep.count(),
    prisma.matchupStats.count(),
    prisma.deck.count(),
    prisma.archetype.count(),
    prisma.deck.findMany({ select: { cardMetadata: true } }),
  ]);

  const uniqueCards = new Set<string>();
  for (const deckRecord of decks) {
    if (!Array.isArray(deckRecord.cardMetadata)) continue;
    for (const item of deckRecord.cardMetadata) {
      const name = typeof item === "object" && item && "name" in item
        ? String((item as { name?: unknown }).name ?? "")
        : "";
      if (name) uniqueCards.add(name.toLowerCase());
    }
  }

  return {
    policyRecord,
    simulationRun,
    episode,
    episodeStep,
    matchupStats,
    deck,
    archetype,
    cardMetadataCards: uniqueCards.size,
  };
}

function listEvaluationFiles() {
  if (!fs.existsSync(evaluationDir)) return [];
  return fs
    .readdirSync(evaluationDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(evaluationDir, entry.name));
}

function localFilePlan(options: ResetOptions) {
  const files: string[] = [];
  if (!options.keepPolicyFile) {
    const policyPath = assertInsideProject(resolvePolicyPath());
    if (fs.existsSync(policyPath)) files.push(policyPath);
  }
  if (!options.keepEvaluationFiles) {
    for (const file of listEvaluationFiles()) {
      files.push(assertInsideProject(file));
    }
  }
  return [...new Set(files)];
}

function printCounts(title: string, counts: DbCounts) {
  console.log(title);
  console.log(`PolicyRecord: ${counts.policyRecord}`);
  console.log(`SimulationRun: ${counts.simulationRun}`);
  console.log(`Episode: ${counts.episode}`);
  console.log(`EpisodeStep: ${counts.episodeStep}`);
  console.log(`MatchupStats: ${counts.matchupStats}`);
  console.log("");
  console.log("Preserved:");
  console.log(`Deck: ${counts.deck}`);
  console.log(`Archetype: ${counts.archetype}`);
  console.log(`Card metadata unique cards: ${counts.cardMetadataCards}`);
}

async function confirmReset(options: ResetOptions) {
  if (options.dryRun || options.yes) return true;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('Type "RESET TRAINING" to delete training/fuzzing data: ');
    return answer.trim() === "RESET TRAINING";
  } finally {
    rl.close();
  }
}

async function clearDatabase(prisma: PrismaClient) {
  await prisma.$transaction([
    prisma.episodeStep.deleteMany(),
    prisma.episode.deleteMany(),
    prisma.policyRecord.deleteMany(),
    prisma.matchupStats.deleteMany(),
    prisma.simulationRun.deleteMany(),
  ]);
}

function deleteLocalFiles(files: string[], dryRun: boolean) {
  const deleted: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    if (!dryRun) fs.rmSync(file, { force: true });
    deleted.push(path.relative(rootDir, file));
  }
  return deleted;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const before = await collectCounts(prisma);
    const files = localFilePlan(options);

    printCounts(options.dryRun ? "Training reset dry-run" : "Training reset", before);
    console.log("");
    console.log("Local files scheduled:");
    if (files.length) {
      for (const file of files) console.log(`- ${path.relative(rootDir, file)}`);
    } else {
      console.log("- none");
    }
    console.log("");
    console.log("Preserved local files:");
    console.log("- apps/ui-player/public/CurrentDeck.json");
    console.log("- deck/card metadata stored in Deck.cardMetadata");

    const confirmed = await confirmReset(options);
    if (!confirmed) {
      console.log("Training reset aborted: confirmation did not match.");
      return;
    }

    if (!options.dryRun) {
      await clearDatabase(prisma);
    }
    const deletedFiles = deleteLocalFiles(files, options.dryRun);
    const after = options.dryRun ? before : await collectCounts(prisma);

    console.log("");
    printCounts(options.dryRun ? "After dry-run (unchanged)" : "After reset", after);
    console.log("");
    console.log(options.dryRun ? "Files that would be deleted:" : "Files deleted:");
    if (deletedFiles.length) {
      for (const file of deletedFiles) console.log(`- ${file}`);
    } else {
      console.log("- none");
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[training:reset] failed");
  console.error(error);
  process.exit(1);
});
