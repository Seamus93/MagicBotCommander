import { describe, expect, it } from "vitest";
import type { AgentDecision, CardName, SimAction, SimAgent, SimGameState } from "@game-state/types";
import { simulateGame } from "../engine";

class MulliganProbeAgent implements SimAgent {
  id = "mulligan-probe";
  readonly seenPlayerIndices: number[] = [];

  decideAction(_state: SimGameState, availableActions: SimAction[]): AgentDecision {
    return { action: availableActions[0] ?? { type: "PASS_TURN" } };
  }

  decideMulligan(_hand: CardName[], _mulliganCount: number, state?: SimGameState): { keep: boolean } {
    this.seenPlayerIndices.push(state?.playerIndex ?? -1);
    return { keep: true };
  }
}

describe("mulligan decision ownership", () => {
  it("passes a decision-owner snapshot to each agent during mulligan", async () => {
    const agents = [
      new MulliganProbeAgent(),
      new MulliganProbeAgent(),
      new MulliganProbeAgent(),
      new MulliganProbeAgent(),
    ];

    await simulateGame(agents, {
      maxTurns: 0,
      maxMulligans: 1,
      playerDecks: agents.map(() => [
        "Command Tower",
        "Island",
        "Swamp",
        "Mountain",
        "Forest",
        "Sol Ring",
        "Arcane Signet",
        "Lightning Bolt",
      ]),
      playerDeckMetadata: agents.map(() => []),
      playerCommanders: agents.map(() => "Commander"),
    });

    expect(agents.map((agent) => agent.seenPlayerIndices)).toEqual([[0], [1], [2], [3]]);
  });
});
