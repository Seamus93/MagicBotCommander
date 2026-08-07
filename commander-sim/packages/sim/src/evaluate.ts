#!/usr/bin/env ts-node
import { parseEvaluationArgs, runEvaluation } from "./evaluation.js";

async function main() {
  const config = parseEvaluationArgs(process.argv.slice(2));
  const report = await runEvaluation(config);
  const [agentA, agentB] = report.agents;
  console.log(`Evaluation complete: ${agentA.id} vs ${agentB.id}`);
  console.log(`games=${config.games} seed=${config.seed} passed=${report.regression.passed}`);
  console.log(
    `winRate ${agentA.id}=${(report.metrics[agentA.id].winRate * 100).toFixed(1)}% ` +
    `${agentB.id}=${(report.metrics[agentB.id].winRate * 100).toFixed(1)}% ` +
    `delta=${(report.delta.winRate * 100).toFixed(1)}%`
  );
  if (process.env.DEBUG_EVALUATION === "true") {
    console.log(`lifecycle=${JSON.stringify(report.lifecycle ?? {})}`);
    console.log(`policySnapshots=${JSON.stringify(report.policySnapshots)}`);
    console.log(`patternGenerationBreakdown=${JSON.stringify(report.patternGenerationBreakdown ?? {})}`);
  }
  if (!report.regression.passed) {
    console.error(`Regression failed: ${report.regression.failures.join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
