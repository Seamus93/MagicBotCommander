import { describe, expect, it } from "vitest";
import type { AgentDecision, DeckCardMetadata, SimAction, SimAgent, SimGameState } from "@game-state/types";
import { applyAction, createInitialState, resolveStackWithPriority } from "../engine.js";
import { parseCardRules } from "../oraclePatternRegistry.js";

const bounceLand = (name: string): DeckCardMetadata => ({
  name,
  typeLine: "Land",
  oracleText:
    `${name} enters tapped.\nWhen ${name} enters, return a land you control to its owner's hand.\n{T}: Add {U}.`,
  isLand: true,
  isPermanent: true,
  producesMana: true,
  manaProduction: 1,
});

const basicLand = (name: string): DeckCardMetadata => ({
  name,
  typeLine: `Basic Land - ${name}`,
  oracleText: "{T}: Add one mana.",
  isLand: true,
  isPermanent: true,
  producesMana: true,
  manaProduction: 1,
});

class ChoiceAgent implements SimAgent {
  constructor(
    public readonly id: string,
    private readonly chooseCard?: string
  ) {}

  decideAction(_state: SimGameState, availableActions: SimAction[]): AgentDecision {
    const choice = this.chooseCard
      ? availableActions.find((action) => action.type === "RESOLVE_CHOICE" && action.card === this.chooseCard)
      : availableActions[0];
    return { action: choice ?? availableActions[0] ?? { type: "PASS_TURN" } };
  }
}

function stateWith(metadata: DeckCardMetadata[]) {
  const state = createInitialState(
    2,
    [["Filler"], ["Filler"]],
    [metadata, []],
    ["Commander", "Commander"],
    0
  );
  state.hands[0] = [];
  state.libraries[0] = [];
  state.battlefields[0] = [];
  state.permanents![0] = [];
  return state;
}

function agents(choice?: string): SimAgent[] {
  return [new ChoiceAgent("p0", choice), new ChoiceAgent("p1")];
}

async function resolve(state: SimGameState, log: string[], choice?: string) {
  await resolveStackWithPriority(state, 0, agents(choice), (msg) => log.push(msg));
}

function playLand(state: SimGameState, card: string, log: string[]) {
  state.hands[0] = [card];
  applyAction(state, { type: "PLAY_LAND", card }, 0, (msg) => log.push(msg));
}

describe("bounce lands", () => {
  it("parses enters tapped plus a non-targeted ETB return choice", () => {
    const parsed = parseCardRules(bounceLand("Dimir Aqueduct"));

    expect(parsed.supportLevel).toBe("FULL");
    expect(parsed.recognizedFragments.map((fragment) => fragment.patternId)).toContain("ENTERS_TAPPED");
    const ability = parsed.abilities.find(
      (candidate) => candidate.patternId === "ETB_RETURN_CONTROLLED_PERMANENT_TO_HAND"
    );
    expect(ability).toMatchObject({
      kind: "TRIGGERED",
      trigger: { eventType: "PERMANENT_ENTERED" },
      conditions: [{ type: "SOURCE_IS_THIS" }],
      effects: [{
        type: "RETURN_TO_HAND",
        selection: {
          zone: "battlefield",
          controllerRelation: "YOU",
          cardType: "land",
          min: 1,
          max: 1,
          targeted: false,
        },
      }],
    });
    expect(ability?.targets).toBeUndefined();
  });

  it("can return itself when played as the first land", async () => {
    const state = stateWith([bounceLand("Dimir Aqueduct")]);
    const log: string[] = [];

    playLand(state, "Dimir Aqueduct", log);

    expect(state.permanents![0][0]).toMatchObject({ cardName: "Dimir Aqueduct", tapped: true });
    expect(state.stack).toHaveLength(1);
    await resolve(state, log, "Dimir Aqueduct");

    expect(state.battlefields[0]).toEqual([]);
    expect(state.permanents![0]).toEqual([]);
    expect(state.hands[0]).toEqual(["Dimir Aqueduct"]);
  });

  it("offers both Dimir Aqueduct and Swamp as legal choices", async () => {
    const state = stateWith([bounceLand("Dimir Aqueduct"), basicLand("Swamp")]);
    const seenChoices: SimAction[][] = [];
    const agent = new (class extends ChoiceAgent {
      decideAction(stateArg: SimGameState, availableActions: SimAction[]): AgentDecision {
        seenChoices.push(availableActions);
        return super.decideAction(stateArg, availableActions);
      }
    })("p0", "Swamp");
    const log: string[] = [];

    playLand(state, "Swamp", log);
    playLand(state, "Dimir Aqueduct", log);
    await resolveStackWithPriority(state, 0, [agent, new ChoiceAgent("p1")], (msg) => log.push(msg));

    const choices = seenChoices.flat().filter((action) => action.type === "RESOLVE_CHOICE");
    expect(choices.map((action) => action.card).sort()).toEqual(["Dimir Aqueduct", "Swamp"]);
  });

  it("returns Swamp and leaves Dimir Aqueduct tapped", async () => {
    const state = stateWith([bounceLand("Dimir Aqueduct"), basicLand("Swamp")]);
    const log: string[] = [];

    playLand(state, "Swamp", log);
    playLand(state, "Dimir Aqueduct", log);
    await resolve(state, log, "Swamp");

    expect(state.hands[0]).toEqual(["Swamp"]);
    expect(state.battlefields[0]).toEqual(["Dimir Aqueduct"]);
    expect(state.permanents![0][0]).toMatchObject({ cardName: "Dimir Aqueduct", tapped: true });
  });

  it("returns Dimir Aqueduct when that choice is selected", async () => {
    const state = stateWith([bounceLand("Dimir Aqueduct"), basicLand("Swamp")]);
    const log: string[] = [];

    playLand(state, "Swamp", log);
    playLand(state, "Dimir Aqueduct", log);
    await resolve(state, log, "Dimir Aqueduct");

    expect(state.hands[0]).toEqual(["Dimir Aqueduct"]);
    expect(state.battlefields[0]).toEqual(["Swamp"]);
  });

  it("chooses from lands still controlled at resolution time", async () => {
    const state = stateWith([bounceLand("Dimir Aqueduct"), basicLand("Swamp"), basicLand("Mountain")]);
    const seenChoices: string[][] = [];
    const agent = new (class extends ChoiceAgent {
      decideAction(stateArg: SimGameState, availableActions: SimAction[]): AgentDecision {
        seenChoices.push(availableActions.filter((action) => action.type === "RESOLVE_CHOICE").map((action) => action.card));
        return super.decideAction(stateArg, availableActions);
      }
    })("p0", "Mountain");
    const log: string[] = [];

    playLand(state, "Swamp", log);
    playLand(state, "Mountain", log);
    playLand(state, "Dimir Aqueduct", log);
    const swamp = state.permanents![0].find((permanent) => permanent.cardName === "Swamp")!;
    state.permanents![0] = state.permanents![0].filter((permanent) => permanent.id !== swamp.id);
    state.battlefields[0] = state.battlefields[0].filter((card) => card !== "Swamp");

    await resolveStackWithPriority(state, 0, [agent, new ChoiceAgent("p1")], (msg) => log.push(msg));

    expect(seenChoices.at(-1)?.sort()).toEqual(["Dimir Aqueduct", "Mountain"]);
    expect(state.hands[0]).toEqual(["Mountain"]);
  });

  it("resolves without effect when zero lands remain and does not fizzle as targeted", async () => {
    const state = stateWith([bounceLand("Dimir Aqueduct")]);
    const log: string[] = [];

    playLand(state, "Dimir Aqueduct", log);
    state.permanents![0] = [];
    state.battlefields[0] = [];
    await resolve(state, log, "Dimir Aqueduct");

    expect(state.hands[0]).toEqual([]);
    expect(log.some((line) => line.includes("fizzles"))).toBe(false);
    expect(log).toContain("Dimir Aqueduct resolves with no legal permanents to return");
  });

  it("logs entry, stack trigger, and returned permanent with structured event data", async () => {
    const state = stateWith([bounceLand("Dimir Aqueduct"), basicLand("Swamp")]);
    const log: string[] = [];

    playLand(state, "Swamp", log);
    playLand(state, "Dimir Aqueduct", log);
    await resolve(state, log, "Swamp");

    expect(log).toContain("Player 0 plays Dimir Aqueduct tapped");
    expect(log).toContain("Dimir Aqueduct ETB trigger added to stack:");
    expect(log).toContain("return a land you control to its owner's hand");
    expect(log).toContain("Player 0 returns Swamp to its owner's hand");
    expect(state.rulesEvents?.find((event) => event.type === "PERMANENT_LEFT")?.data).toMatchObject({
      sourceCard: "Dimir Aqueduct",
      abilityId: "ETB_RETURN_CONTROLLED_PERMANENT_TO_HAND",
      returnedCard: "Swamp",
      destinationZone: "hand",
    });
  });

  it("supports another equivalent bounce land generically", async () => {
    const state = stateWith([bounceLand("Rakdos Carnarium"), basicLand("Mountain")]);
    const log: string[] = [];

    playLand(state, "Mountain", log);
    playLand(state, "Rakdos Carnarium", log);
    await resolve(state, log, "Mountain");

    expect(state.hands[0]).toEqual(["Mountain"]);
    expect(state.battlefields[0]).toEqual(["Rakdos Carnarium"]);
    expect(log).toContain("Rakdos Carnarium ETB trigger added to stack:");
  });
});
