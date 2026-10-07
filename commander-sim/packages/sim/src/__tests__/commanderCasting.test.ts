import { describe, expect, it } from "vitest";
import type { AiDecisionTrace, CardName, DeckCardMetadata, SimAgent, SimGameState } from "@game-state/types";
import {
  applyAction,
  castSpellToStack,
  createInitialState,
  generateActions,
  simulateGame,
} from "../engine.js";

const marchesa = "Marchesa, the Black Rose";
const marchesaMetadata: DeckCardMetadata = {
  name: marchesa,
  typeLine: "Legendary Creature — Human Wizard",
  manaCost: "{1}{U}{B}{R}",
  manaValue: 4,
  power: 3,
  toughness: 3,
  isCreature: true,
  isPermanent: true,
};
const islandMetadata: DeckCardMetadata = {
  name: "Island",
  typeLine: "Basic Land — Island",
  isLand: true,
  isPermanent: true,
};
const mainContext = {
  landDropsUsedThisTurn: 0,
  maxLandDrops: 1,
  allowInstant: true,
  allowSorcery: true,
  allowLand: false,
};

function commanderState(): SimGameState {
  const deck: CardName[] = [marchesa, ...Array.from({ length: 99 }, () => "Island")];
  const state = createInitialState(1, [deck], [[marchesaMetadata, islandMetadata]], [marchesa]);
  state.playerIndex = 0;
  state.phase = "Prima Fase Principale";
  state.phaseStep = "Prima Fase Principale";
  return state;
}

function setManaSources(state: SimGameState, count: number) {
  const sources = Array.from({ length: count }, (_, index) =>
    index === 0 ? "Island" : index === 1 ? "Swamp" : "Mountain"
  );
  state.battlefields[0] = [...sources];
  state.permanents![0] = sources.map((name, index) => {
    const metadata = name === "Island"
      ? islandMetadata
      : { name, typeLine: `Basic Land — ${name}`, isLand: true, isPermanent: true };
    state.cardMetadata[0][name.toLowerCase()] = metadata;
    return {
      id: `mana-source-${index}`,
      cardName: name,
      owner: 0,
      controller: 0,
      face: name,
      tapped: false,
    };
  });
}

function commandCastAction(state: SimGameState) {
  return generateActions(state, 0, mainContext).find((action) =>
    action.type === "CAST_SPELL" && action.card === marchesa && action.sourceZone === "COMMAND"
  );
}

function returnMarchesaToCommandZone(state: SimGameState) {
  state.creatures[0] = state.creatures[0].filter((creature) => creature.name !== marchesa);
  state.permanents![0] = state.permanents![0].filter((permanent) => permanent.cardName !== marchesa);
  state.battlefields[0] = state.battlefields[0].filter((card) => card !== marchesa);
  state.commandZone![0].push(marchesa);
}

class PassAgent implements SimAgent {
  constructor(public readonly id: string) {}
  decideAction() {
    return { action: { type: "PASS_TURN" as const }, metadata: { source: "fallback" as const } };
  }
}

describe("commander casts from the Command Zone", () => {
  it("offers a considered but unpayable Command cast in the production decision trace", async () => {
    const traces: AiDecisionTrace[] = [];
    const deck = [marchesa, ...Array.from({ length: 99 }, () => "Island")];
    await simulateGame(
      Array.from({ length: 4 }, (_, player) => new PassAgent(`pass-${player}`)),
      {
        maxTurns: 1,
        maxMulligans: 0,
        startingPlayerIndex: 0,
        playerDecks: Array.from({ length: 4 }, () => [...deck]),
        playerDeckMetadata: Array.from({ length: 4 }, () => [marchesaMetadata, islandMetadata]),
        playerCommanders: Array(4).fill(marchesa),
        phaseDelayMs: 0,
        actionDelayMs: 0,
        log: () => {},
        onAiDecisionTrace: (trace) => traces.push(trace),
      }
    );

    const considered = traces
      .find((trace) => trace.playerId === 0)
      ?.consideredActions.find((action) => action.cardId === marchesa && action.sourceZone === "COMMAND");
    expect(considered).toMatchObject({
      sourceZone: "COMMAND",
      commanderCastCount: 0,
      commanderTax: 0,
      baseCost: { generic: 1, blue: 1, black: 1, red: 1 },
      effectiveCost: { generic: 1, blue: 1, black: 1, red: 1 },
      manaPayable: false,
      legal: false,
    });
  });

  it("generates and pays the first Command cast at printed cost, then applies escalating tax", () => {
    const state = commanderState();
    expect(state.commandZone?.[0]).toEqual([marchesa]);
    expect(state.libraries[0]).not.toContain(marchesa);
    expect(state.hands[0]).not.toContain(marchesa);

    setManaSources(state, 3);
    expect(commandCastAction(state)).toBeUndefined();

    setManaSources(state, 4);
    const firstCast = commandCastAction(state);
    expect(firstCast).toMatchObject({ type: "CAST_SPELL", card: marchesa, sourceZone: "COMMAND" });
    applyAction(state, firstCast!, 0, () => {});
    expect(state.commandZone?.[0]).toEqual([]);
    expect(state.commanderCastCounts?.[0]?.[marchesa.toLowerCase()]).toBe(1);

    returnMarchesaToCommandZone(state);
    setManaSources(state, 5);
    expect(commandCastAction(state)).toBeUndefined();
    setManaSources(state, 6);
    expect(commandCastAction(state)).toBeDefined();
    applyAction(state, commandCastAction(state)!, 0, () => {});
    expect(state.commanderCastCounts?.[0]?.[marchesa.toLowerCase()]).toBe(2);

    returnMarchesaToCommandZone(state);
    setManaSources(state, 7);
    expect(commandCastAction(state)).toBeUndefined();
    setManaSources(state, 8);
    expect(commandCastAction(state)).toBeDefined();
    applyAction(state, commandCastAction(state)!, 0, () => {});
    expect(state.commanderCastCounts?.[0]?.[marchesa.toLowerCase()]).toBe(3);
  });

  it("consumes and counts a Command Zone cast through the stack-enabled path", () => {
    const state = commanderState();
    setManaSources(state, 4);
    const action = commandCastAction(state);
    expect(action).toBeDefined();

    castSpellToStack(state, 0, action as Extract<typeof action, { type: "CAST_SPELL" }>, () => {});

    expect(state.commandZone?.[0]).toEqual([]);
    expect(state.commanderCastCounts?.[0]?.[marchesa.toLowerCase()]).toBe(1);
    expect(state.hands[0]).not.toContain(marchesa);
    expect(state.permanents?.[0].every((permanent) => permanent.tapped)).toBe(true);
  });

  it("does not apply Command tax when the same commander is cast from hand", () => {
    const state = commanderState();
    state.commanderCastCounts![0][marchesa.toLowerCase()] = 2;
    state.commandZone![0] = [];
    state.hands[0].push(marchesa);
    setManaSources(state, 4);

    const handCast = generateActions(state, 0, mainContext).find((action) =>
      action.type === "CAST_SPELL" && action.card === marchesa
    );
    expect(handCast).toMatchObject({ type: "CAST_SPELL", card: marchesa });
    expect(handCast && handCast.type === "CAST_SPELL" ? handCast.sourceZone : undefined).toBeUndefined();
    applyAction(state, handCast!, 0, () => {});
    expect(state.commanderCastCounts?.[0]?.[marchesa.toLowerCase()]).toBe(2);
  });
});
