import type {
  CreatureDigest,
  PlayerDigest,
  SimGameState,
  StateDigest,
} from "./types.js";
import { isLandCard } from "./cardUtils.js";

export function buildStateDigest(state: SimGameState): StateDigest {
  const players: PlayerDigest[] = state.lifeTotals.map((life, index) => {
    const creatures = state.creatures[index] ?? [];
    const creatureSummary: CreatureDigest[] = creatures.map((creature) => ({
      name: creature.name,
      power: creature.power,
      toughness: creature.toughness,
      tapped: creature.tapped,
      summoningSickness: creature.summoningSickness,
    }));

    const landsInPlay = (state.battlefields[index] ?? []).filter((card) =>
      isLandCard(state, index, card)
    ).length;

    return {
      index,
      life,
      handSize: state.hands[index]?.length ?? 0,
      libraryCount: state.libraries[index]?.length ?? 0,
      graveyardCount: state.graveyards[index]?.length ?? 0,
      landsInPlay,
      artifactsInPlay: state.artifacts[index]?.length ?? 0,
      artifactMana: state.artifactMana[index] ?? 0,
      creatures: creatureSummary,
      commander: state.commanders[index],
    };
  });

  const battlefieldSummary = state.battlefields.map((cards, playerIndex) => ({
    playerIndex,
    cards: cards ?? [],
  }));

  return {
    turn: state.turn,
    phase: state.phase,
    phaseStep: state.phaseStep,
    playerIndex: state.playerIndex,
    players,
    battlefieldSummary,
  };
}
