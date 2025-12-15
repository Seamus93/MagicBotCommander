#!/usr/bin/env ts-node
import path from "node:path";
import { PatternStore } from "./patterns.js";
import { LearningAgent } from "./learningAgent.js";
import { simulateGame } from "./engine.js";

const episodes = Number(process.argv[2] ?? 50);
const policyPath = path.resolve(__dirname, "../data/policy.json");

async function main() {
  const store = PatternStore.load(policyPath);
  const agents = Array.from({ length: 4 }, (_, idx) =>
    new LearningAgent({
      id: `Agent-${idx}`,
      store,
      epsilon: 0.15,
    })
  );

  const wins = Array(agents.length).fill(0);
  for (let i = 0; i < episodes; i++) {
    const result = await simulateGame(agents, {
      log: () => {},
      maxTurns: 40,
    });
    if (result.winnerIndex !== null) {
      wins[result.winnerIndex] += 1;
    }
    if ((i + 1) % 10 === 0) {
      console.log(`Completed ${i + 1}/${episodes} episodes`);
    }
  }

  store.save(policyPath);
  console.log("Training complete. Win distribution:", wins);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
