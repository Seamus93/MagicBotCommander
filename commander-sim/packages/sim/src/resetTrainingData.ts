#!/usr/bin/env tsx
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../..");
const dataDir = path.join(rootDir, "data");
const datasetPath = path.join(dataDir, "dataset.jsonl");
const policyPath = path.join(dataDir, "policy.json");
const backupRoot = path.join(dataDir, "backups");
const modelPattern = /^model\.weights\.v\d+\.json$/;

type ResetOptions = {
  backup: boolean;
  dryRun: boolean;
  keepDb: boolean;
  keepFiles: boolean;
  keepModels: boolean;
};

function parseArgs(argv: string[]): ResetOptions {
  const flags = new Set(argv.map((arg) => arg.trim().toLowerCase()));
  return {
    backup: flags.has("--backup"),
    dryRun: flags.has("--dry-run"),
    keepDb: flags.has("--keep-db"),
    keepFiles: flags.has("--keep-files"),
    keepModels: flags.has("--keep-models"),
  };
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureFreshPolicyFile(dryRun: boolean) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, "[]\n", "utf8");
}

function moveOrDeleteFile(
  filePath: string,
  backupDir: string | null,
  dryRun: boolean
): string | null {
  if (!fs.existsSync(filePath)) return null;
  if (backupDir) {
    const target = path.join(backupDir, path.basename(filePath));
    if (!dryRun) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(filePath, target);
    }
    return `backup:${target}`;
  }
  if (!dryRun) {
    fs.rmSync(filePath, { force: true });
  }
  return "deleted";
}

function resetLocalArtifacts(options: ResetOptions) {
  const actions: string[] = [];
  if (options.keepFiles && options.keepModels) {
    return actions;
  }

  const backupDir = options.backup
    ? path.join(backupRoot, `training-reset-${timestampLabel()}`)
    : null;

  if (!options.keepFiles) {
    const datasetResult = moveOrDeleteFile(datasetPath, backupDir, options.dryRun);
    if (datasetResult) {
      actions.push(`dataset ${datasetResult}`);
    }

    const policyResult = moveOrDeleteFile(policyPath, backupDir, options.dryRun);
    if (policyResult) {
      actions.push(`policy ${policyResult}`);
    }

    ensureFreshPolicyFile(options.dryRun);
    actions.push(options.dryRun ? "policy recreated skipped (dry-run)" : "policy recreated as empty array");
  }

  if (!options.keepModels && fs.existsSync(dataDir)) {
    const modelFiles = fs
      .readdirSync(dataDir)
      .filter((entry) => modelPattern.test(entry))
      .map((entry) => path.join(dataDir, entry));
    for (const modelFile of modelFiles) {
      const modelResult = moveOrDeleteFile(modelFile, backupDir, options.dryRun);
      if (modelResult) {
        actions.push(`${path.basename(modelFile)} ${modelResult}`);
      }
    }
  }

  return actions;
}

async function resetDatabase(options: ResetOptions) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return ["database skipped (DATABASE_URL not set)"];
  }

  const prisma = new PrismaClient();
  try {
    const targetTables = [
      "SimulationRun",
      "Episode",
      "EpisodeStep",
      "PolicyRecord",
      "MatchupStats",
    ];
    const existingRows = (await prisma.$queryRawUnsafe(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1)
      `,
      targetTables
    )) as Array<{ table_name: string }>;
    const existingTables = existingRows.map((row) => row.table_name);

    if (existingTables.length === 0) {
      return ["database skipped (target tables not found)"];
    }

    if (options.dryRun) {
      const counts = await Promise.all(
        existingTables.map(async (tableName) => {
          const rows = (await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS count FROM "${tableName}"`
          )) as Array<{ count: number }>;
          return `${tableName}=${rows[0]?.count ?? 0}`;
        })
      );
      return [
        `database dry-run: ${counts.join(", ")}`,
      ];
    }

    const truncateList = existingTables.map((tableName) => `"${tableName}"`).join(", ");
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${truncateList} RESTART IDENTITY CASCADE`
    );
    return [
      `database cleared: ${existingTables.join(", ")}`,
    ];
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary: string[] = [];

  if (!options.keepFiles || !options.keepModels) {
    summary.push(...resetLocalArtifacts(options));
  }

  if (!options.keepDb) {
    summary.push(...(await resetDatabase(options)));
  }

  console.log("[train:reset] completed");
  for (const line of summary) {
    console.log(`- ${line}`);
  }
  console.log("- decks preserved");
  console.log("- archetypes preserved");
}

main().catch((error) => {
  console.error("[train:reset] failed");
  console.error(error);
  process.exit(1);
});
