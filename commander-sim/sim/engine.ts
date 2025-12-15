import {
  SimAction,
  SimAgent,
  SimGameState,
  SimulationOptions,
  SimulationResult,
} from "./types.js";
import { isLearningAgent } from "./learningAgent.js";

const DEFAULT_DECK = [
  ...Array(20).fill("Basic Land"),
  ...Array(10).fill("Burn Spell"),
  ...Array(10).fill("Grow Spell"),
];

const cloneState = (state: SimGameState): SimGameState =>
  JSON.parse(JSON.stringify(state));

export async function simulateGame(
  agents: SimAgent[],
  options: SimulationOptions = {}
): Promise<SimulationResult> {
  const maxTurns = options.maxTurns ?? 40;
  const log = options.log ?? (() => {});

  const state = createInitialState(agents.length);
  const history: SimulationResult["history"] = [];

  let landPlayedThisTurn = false;
  let winnerIndex: number | null = null;

  for (let turn = 1; turn <= maxTurns && winnerIndex === null; turn++) {
    state.turn = turn;
    for (let p = 0; p < agents.length && winnerIndex === null; p++) {
      if (state.lifeTotals[p] <= 0) continue;
      state.playerIndex = p;
      landPlayedThisTurn = false;

      drawCard(state, p);

      for (let actionCount = 0; actionCount < 3 && winnerIndex === null; actionCount++) {
        const available = generateActions(state, p, landPlayedThisTurn);
        const snapshot = cloneState(state);
        const action = await Promise.resolve(
          agents[p].decideAction(snapshot, available)
        );
        history.push({ playerIndex: p, action });
        landPlayedThisTurn = landPlayedThisTurn || action.type === "PLAY_LAND";
        applyAction(state, action, p, log);
        winnerIndex = checkForWinner(state);
        if (action.type === "PASS_TURN" || available.length === 1) break;
      }
    }
  }

  if (winnerIndex === null) {
    winnerIndex = determineWinnerByLife(state);
  }

  const reward = winnerIndex === null ? 0 : 1;
  agents.forEach((agent, index) => {
    if (isLearningAgent(agent)) {
      const delta = winnerIndex === null ? 0 : winnerIndex === index ? reward : -reward;
      agent.finalizeEpisode(delta);
    }
  });

  return { winnerIndex, history };
}

function createInitialState(players: number): SimGameState {
  const lifeTotals = Array(players).fill(40);
  const battlefields = Array(players).fill(null).map(() => []);
  const graveyards = Array(players).fill(null).map(() => []);
  const commanders = Array(players).fill("Commander");
  const libraries = Array(players)
    .fill(null)
    .map(() => shuffle([...DEFAULT_DECK]));
  const hands = libraries.map((library) => library.splice(0, 7));

  return {
    turn: 1,
    playerIndex: 0,
    lifeTotals,
    battlefields,
    graveyards,
    commanders,
    libraries,
    hands,
  };
}

function drawCard(state: SimGameState, player: number) {
  const library = state.libraries[player];
  if (library.length === 0) return;
  const card = library.shift();
  if (card) state.hands[player].push(card);
}

function generateActions(
  state: SimGameState,
  player: number,
  landPlayedThisTurn: boolean
): SimAction[] {
  const actions: SimAction[] = [{ type: "PASS_TURN" }];
  const hand = state.hands[player];

  if (!landPlayedThisTurn) {
    hand
      .filter((card) => isLand(card))
      .forEach((card) => {
        actions.push({ type: "PLAY_LAND", card });
      });
  }

  const availableMana = state.battlefields[player].filter(isLand).length;
  hand
    .filter((card) => !isLand(card))
    .forEach((card) => {
      const cost = getSpellCost(card);
      if (cost <= availableMana) {
        actions.push({ type: "CAST_SPELL", card });
      }
    });

  return actions;
}

function applyAction(
  state: SimGameState,
  action: SimAction,
  player: number,
  log: (message: string) => void
) {
  switch (action.type) {
    case "PLAY_LAND": {
      const idx = state.hands[player].indexOf(action.card);
      if (idx >= 0) state.hands[player].splice(idx, 1);
      state.battlefields[player].push(action.card);
      log(`Player ${player} plays land ${action.card}`);
      break;
    }
    case "CAST_SPELL": {
      const idx = state.hands[player].indexOf(action.card);
      if (idx >= 0) state.hands[player].splice(idx, 1);
      state.graveyards[player].push(action.card);
      resolveSpell(state, player, action.card, log);
      break;
    }
    default:
      break;
  }
}

function resolveSpell(
  state: SimGameState,
  player: number,
  card: string,
  log: (msg: string) => void
) {
  const target = findNextOpponent(state, player);
  if (target === null) return;
  const damage = card.toLowerCase().includes("burn") ? 5 : 3;
  state.lifeTotals[target] -= damage;
  log(`Player ${player} casts ${card} dealing ${damage} to player ${target}`);
}

function findNextOpponent(state: SimGameState, player: number) {
  for (let i = 1; i < state.lifeTotals.length; i++) {
    const idx = (player + i) % state.lifeTotals.length;
    if (state.lifeTotals[idx] > 0) return idx;
  }
  return null;
}

function checkForWinner(state: SimGameState): number | null {
  const alive = state.lifeTotals
    .map((life, idx) => ({ life, idx }))
    .filter(({ life }) => life > 0);
  if (alive.length === 1) return alive[0].idx;
  return null;
}

function determineWinnerByLife(state: SimGameState): number | null {
  let bestIndex: number | null = null;
  let bestLife = -Infinity;
  state.lifeTotals.forEach((life, idx) => {
    if (life > bestLife) {
      bestLife = life;
      bestIndex = idx;
    }
  });
  return bestIndex;
}

function isLand(card: string) {
  return card.toLowerCase().includes("land");
}

function getSpellCost(card: string) {
  if (card.toLowerCase().includes("burn")) return 2;
  if (card.toLowerCase().includes("grow")) return 1;
  return 3;
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
