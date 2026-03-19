import "dotenv/config";
import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { CurriculumScheduler } from "@sim/curriculum.js";

type TrainRequestBody = {
  episodes?: number;
  deckIds?: number[];
  storeToDb?: boolean;
};

type JobStatus = "running" | "completed" | "failed" | "killed";

type TrainJob = {
  id: string;
  startedAt: number;
  status: JobStatus;
  exitCode: number | null;
  lastLines: string[];
  proc: ReturnType<typeof spawn> | null;
};

const PORT = Number(process.env.SIM_SERVER_PORT ?? 5100);
const MAX_LOG_LINES = 400;

const prisma = process.env.DATABASE_URL ? new PrismaClient() : null;
const curriculumScheduler = process.env.DATABASE_URL ? new CurriculumScheduler() : null;

const jobs = new Map<string, TrainJob>();

function makeId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function pushLine(job: TrainJob, line: string) {
  job.lastLines.push(line);
  if (job.lastLines.length > MAX_LOG_LINES) {
    job.lastLines.splice(0, job.lastLines.length - MAX_LOG_LINES);
  }
}

function spawnNpxTsx(args: string[], env: NodeJS.ProcessEnv) {
  const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
  return spawn(cmd, ["tsx", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/train", (req, res) => {
  const body = (req.body ?? {}) as TrainRequestBody;
  const episodes = Number(body.episodes ?? 50);
  const deckIds = Array.isArray(body.deckIds) ? body.deckIds : [];
  const storeToDb = body.storeToDb !== false;

  if (!Number.isFinite(episodes) || episodes <= 0) {
    return res.status(400).json({ error: "episodes non valido" });
  }

  const id = makeId();
  const job: TrainJob = {
    id,
    startedAt: Date.now(),
    status: "running",
    exitCode: null,
    lastLines: [],
    proc: null,
  };
  jobs.set(id, job);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (deckIds.length) {
    env.DECK_IDS = deckIds.join(",");
  }
  if (!storeToDb) {
    env.STORE_TO_DB = "false";
  }

  const proc = spawnNpxTsx(
    ["--tsconfig", "tsconfig.base.json", "packages/sim/src/run-batch.ts", String(episodes)],
    env
  );
  job.proc = proc;

  proc.stdout?.on("data", (buf) => {
    String(buf)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => pushLine(job, line));
  });
  proc.stderr?.on("data", (buf) => {
    String(buf)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => pushLine(job, line));
  });

  proc.on("close", (code) => {
    job.exitCode = typeof code === "number" ? code : null;
    if (job.status === "killed") return;
    job.status = code === 0 ? "completed" : "failed";
    job.proc = null;
  });

  return res.json({ jobId: id, statusUrl: `/train/${id}` });
});

app.get("/train/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job non trovato" });
  return res.json({
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    exitCode: job.exitCode,
    lastLines: job.lastLines,
  });
});

app.post("/train/:id/kill", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job non trovato" });
  if (!job.proc) return res.status(409).json({ error: "job non in esecuzione" });
  job.status = "killed";
  job.proc.kill();
  job.proc = null;
  return res.json({ ok: true });
});

// Phase 4 — Matchup win-rate matrix
app.get("/matchups", async (_req, res) => {
  if (!prisma) {
    return res.status(503).json({ error: "Database non configurato (DATABASE_URL mancante)." });
  }
  try {
    const rows = await prisma.matchupStats.findMany({
      orderBy: [{ archetype1: "asc" }, { archetype2: "asc" }],
    });
    const matchups = rows.map((r) => ({
      arch1: r.archetype1,
      arch2: r.archetype2,
      winRate1: r.total > 0 ? r.wins1 / r.total : null,
      winRate2: r.total > 0 ? r.wins2 / r.total : null,
      wins1: r.wins1,
      wins2: r.wins2,
      total: r.total,
    }));
    return res.json({ matchups });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Errore";
    return res.status(500).json({ error: message });
  }
});

// Phase 6 — Curriculum status
app.get("/curriculum/status", async (_req, res) => {
  if (!curriculumScheduler) {
    return res.status(503).json({ error: "Database non configurato (DATABASE_URL mancante)." });
  }
  try {
    const status = await curriculumScheduler.getStatus();
    return res.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Errore";
    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`[sim-server] listening on http://localhost:${PORT}`);
});
