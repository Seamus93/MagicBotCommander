import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("training isolation", () => {
  it("uses the ALL_AI batch runner instead of the interactive GameSession", () => {
    const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const runBatch = readFileSync(resolve(root, "packages/sim/src/run-batch.ts"), "utf8");

    expect(packageJson.scripts.train).toContain("packages/sim/src/run-batch.ts");
    expect(runBatch).not.toContain("HumanAgent");
    expect(runBatch).not.toContain("GameSession");
  });
});
