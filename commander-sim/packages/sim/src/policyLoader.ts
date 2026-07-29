import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PatternStore } from "./patterns.js";

export type PolicySource = "db" | "file" | "empty-fallback";

export interface LoadedPolicyStore {
  store: PatternStore;
  source: PolicySource;
  records: number;
}

export interface LoadPolicyOptions {
  policyPath?: string;
  preferDb?: boolean;
  allowEmptyFallback?: boolean;
  log?: (message: string) => void;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_POLICY_PATH = path.resolve(__dirname, "../../../data/policy.json");

export async function loadTrainedPolicyStore(
  options: LoadPolicyOptions = {}
): Promise<LoadedPolicyStore> {
  const log = options.log ?? console.log;
  const preferDb = options.preferDb ?? Boolean(process.env.DATABASE_URL);
  const allowEmptyFallback =
    options.allowEmptyFallback ?? process.env.ALLOW_EMPTY_POLICY_FALLBACK === "true";
  const policyPath = options.policyPath ?? process.env.POLICY_PATH ?? DEFAULT_POLICY_PATH;

  if (preferDb && process.env.DATABASE_URL) {
    try {
      const dbSpecifier = "@db/db";
      const db = await import(dbSpecifier) as {
        loadPolicyStore: () => Promise<PatternStore>;
      };
      const store = await db.loadPolicyStore();
      const records = store.entries().length;
      if (records > 0) {
        log(`[policy] source=db records=${records}`);
        return { store, source: "db", records };
      }
      log("[policy] source=db records=0; trying policy file");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[policy] source=db unavailable; trying policy file (${message})`);
    }
  }

  if (fs.existsSync(policyPath)) {
    const store = PatternStore.load(policyPath);
    const records = store.entries().length;
    if (records > 0 || allowEmptyFallback) {
      log(`[policy] source=file path=${policyPath} records=${records}`);
      return { store, source: "file", records };
    }
    log(`[policy] source=file path=${policyPath} records=0; empty fallback not enabled`);
  }

  if (!allowEmptyFallback) {
    throw new Error(
      "No trained policy found. Set DATABASE_URL, provide data/policy.json, or set ALLOW_EMPTY_POLICY_FALLBACK=true."
    );
  }

  log("[policy] source=empty-fallback records=0");
  return { store: new PatternStore(), source: "empty-fallback", records: 0 };
}
