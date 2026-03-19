import { describe, expect, it } from "vitest";
import type { AgentDecision, CardName, GameEvent, SimAction, SimAgent, SimGameState } from "@game-state/types";
import { simulateGame } from "../engine.js";

class AlwaysPassAgent implements SimAgent {
  constructor(public readonly id: string) {}

  decideAction(_state: SimGameState, availableActions: SimAction[]): AgentDecision {
    return {
      action:
        availableActions.find((action) => action.type === "PLAY_LAND") ??
        { type: "PASS_TURN" },
    };
  }

  decideMulligan(): { keep: boolean } {
    return { keep: true };
  }
}

class AlwaysMulliganAgent extends AlwaysPassAgent {
  override decideMulligan(): { keep: boolean } {
    return { keep: false };
  }
}

describe("engine turn rules", () => {
  it("keeps 5 cards after a forced keep with maxMulligans=2", async () => {
    const handSizes = new Map<number, number>();
    const deck: CardName[] = Array(40).fill("Shock");
    const metadata = [
      { name: "Shock", typeLine: "Sorcery", manaValue: 1, oracleText: "Deal 2 damage to any target." },
    ];

    await simulateGame(
      [new AlwaysMulliganAgent("p0"), new AlwaysMulliganAgent("p1")],
      {
        maxTurns: 0,
        maxMulligans: 2,
        playerDecks: [deck, deck],
        playerDeckMetadata: [metadata, metadata],
        onStateChange: (state: SimGameState, event: GameEvent) => {
          if (event.type === "mulligan_done") {
            handSizes.set(event.player, state.hands[event.player]?.length ?? -1);
          }
        },
      }
    );

    expect(handSizes.get(0)).toBe(5);
    expect(handSizes.get(1)).toBe(5);
  });

  it("does not let the starting player draw on turn 1", async () => {
    const drawEvents: number[] = [];
    const plainsDeck: CardName[] = Array(40).fill("Plains");
    const islandDeck: CardName[] = Array(40).fill("Island");
    const plainsMeta = [{ name: "Plains", typeLine: "Basic Land - Plains", isLand: true, manaValue: 0 }];
    const islandMeta = [{ name: "Island", typeLine: "Basic Land - Island", isLand: true, manaValue: 0 }];

    await simulateGame(
      [new AlwaysPassAgent("p0"), new AlwaysPassAgent("p1")],
      {
        maxTurns: 1,
        maxMulligans: 0,
        startingPlayerIndex: 0,
        playerDecks: [plainsDeck, islandDeck],
        playerDeckMetadata: [plainsMeta, islandMeta],
        onStateChange: (_state: SimGameState, event: GameEvent) => {
          if (event.type === "draw") {
            drawEvents.push(event.player);
          }
        },
      }
    );

    expect(drawEvents).toEqual([1]);
  });
});
