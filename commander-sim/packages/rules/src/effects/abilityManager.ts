import type {
  CardName,
  DeckCardMetadata,
  CostReducer,
  HandSizeModifier,
  RegisteredTrigger,
  SimGameState,
} from "@game-state/types";
import {
  cardNameMatches,
  countLands,
  getCardMetadata,
  isBasicPlainsCard,
  isLandCard,
  normalizeCardName,
} from "../../../game-state/src/cardUtils.js";
export type LandEntryCause = "play" | "ability";

type LandEvent = { player: number; card: CardName; cause: LandEntryCause };

interface AbilityContext {
  state: SimGameState;
  player: number;
  cardName: CardName;
  metadata?: DeckCardMetadata;
  log: (message: string) => void;
}

type AbilityMatcher = (ctx: AbilityContext) => boolean;

interface PermanentAbilityDefinition {
  id: string;
  matches: AbilityMatcher;
  onEnter?: (ctx: AbilityContext) => void;
  setupTriggers?: (ctx: AbilityContext) => void;
}

const permanentAbilities: PermanentAbilityDefinition[] = [
  {
    id: "rumor_gatherer",
    matches: (ctx) =>
      cardNameMatches(ctx.metadata, ctx.cardName, "Rumor Gatherer"),
    onEnter: (ctx) => {
      drawCards(ctx.state, ctx.player, 1, ctx.log, ctx.cardName);
    },
  },
  {
    id: "deep_gnome_terramancer",
    matches: (ctx) =>
      cardNameMatches(ctx.metadata, ctx.cardName, "Deep Gnome Terramancer"),
    setupTriggers: (ctx) => {
      registerTrigger(ctx.state, {
        controller: ctx.player,
        sourceCard: ctx.cardName,
        type: "OPPONENT_NONPLAY_LAND",
        data: { lastTurn: 0 },
      });
    },
  },
  {
    id: "archaeomancers_map",
    matches: (ctx) =>
      cardNameMatches(ctx.metadata, ctx.cardName, "Archaeomancer's Map"),
    onEnter: (ctx) => {
      const fetched = movePlainsToHand(ctx.state, ctx.player, 2);
      if (fetched.length) {
        ctx.log(
          `Player ${ctx.player} searches ${fetched.length} Plains with ${ctx.cardName}`
        );
      }
    },
    setupTriggers: (ctx) => {
  registerTrigger(ctx.state, {
    controller: ctx.player,
    sourceCard: ctx.cardName,
    type: "OPPONENT_LAND_ADVANTAGE",
  });
},
  },
  {
    id: "knight_of_the_white_orchid",
    matches: (ctx) =>
      cardNameMatches(ctx.metadata, ctx.cardName, "Knight of the White Orchid"),
    onEnter: (ctx) => {
      if (!opponentHasMoreLands(ctx.state, ctx.player)) return;
      const plains = takePlainsFromLibrary(ctx.state, ctx.player, 1);
      if (!plains.length) return;
      const eventPayload = placeLandFromEffect(
        ctx.state,
        ctx.player,
        plains[0],
        ctx.log,
        {
          cause: "ability",
          description: `Player ${ctx.player} uses ${ctx.cardName} to put ${plains[0]} onto the battlefield`,
        }
      );
      handleLandEntered(
        ctx.state,
        eventPayload.player,
        eventPayload.card,
        ctx.log,
        eventPayload.cause
      );
    },
  },
  {
    id: "loyal_warhound",
    matches: (ctx) =>
      cardNameMatches(ctx.metadata, ctx.cardName, "Loyal Warhound"),
    onEnter: (ctx) => {
      if (!opponentHasMoreLands(ctx.state, ctx.player)) return;
      const plains = takePlainsFromLibrary(ctx.state, ctx.player, 1);
      if (!plains.length) return;
      const eventPayload = placeLandFromEffect(
        ctx.state,
        ctx.player,
        plains[0],
        ctx.log,
        {
          cause: "ability",
          tapped: true,
          description: `Player ${ctx.player} uses ${ctx.cardName} to fetch ${plains[0]} tapped`,
        }
      );
      handleLandEntered(
        ctx.state,
        eventPayload.player,
        eventPayload.card,
        ctx.log,
        eventPayload.cause
      );
    },
  },
];

export function handlePermanentEntersBattlefield(
  state: SimGameState,
  player: number,
  cardName: CardName,
  metadata: DeckCardMetadata | undefined,
  log: (message: string) => void
) {
  const ctx: AbilityContext = { state, player, cardName, metadata, log };
  for (const ability of permanentAbilities) {
    if (!ability.matches(ctx)) continue;
    ability.onEnter?.(ctx);
    ability.setupTriggers?.(ctx);
  }
  applyInferredAbilities(ctx);
}

export function handleLandEntered(
  state: SimGameState,
  player: number,
  card: CardName,
  log: (message: string) => void,
  cause: LandEntryCause = "ability"
) {
  const queue: LandEvent[] = [{ player, card, cause }];
  while (queue.length) {
    const event = queue.shift()!;
    for (const trigger of state.triggers) {
      switch (trigger.type) {
        case "OPPONENT_LAND_ADVANTAGE": {
          const extra = resolveArchaeomancerTrigger(
            state,
            trigger,
            event,
            log
          );
          if (extra) queue.push(extra);
          break;
        }
        case "OPPONENT_NONPLAY_LAND": {
          const extra = resolveTerramancerTrigger(
            state,
            trigger,
            event,
            log
          );
          if (extra) queue.push(extra);
          break;
        }
        default:
          break;
      }
    }
  }
}

export function removeTriggersForPermanent(
  state: SimGameState,
  controller: number,
  cardName: CardName
) {
  const normalized = normalizeCardName(cardName);
  state.triggers = state.triggers.filter(
    (trigger) =>
      !(
        trigger.controller === controller &&
        normalizeCardName(trigger.sourceCard) === normalized
      )
  );
  removeCostReducer(state, controller, cardName);
  removeHandSizeModifier(state, controller, cardName);
}

function resolveArchaeomancerTrigger(
  state: SimGameState,
  trigger: RegisteredTrigger,
  event: LandEvent,
  log: (message: string) => void
): LandEvent | null {
  const controller = trigger.controller;
  if (controller === event.player) return null;

  const controllerLands = countLands(state, controller);
  const opponentLands = countLands(state, event.player);
  if (opponentLands <= controllerLands) return null;

  const land = takeLandFromHand(state, controller);
  if (!land) return null;

  state.battlefields[controller].push(land);
  log(
    `Player ${controller} uses ${trigger.sourceCard} to put ${land} onto the battlefield`
  );

  return { player: controller, card: land, cause: "ability" };
}

function resolveTerramancerTrigger(
  state: SimGameState,
  trigger: RegisteredTrigger,
  event: LandEvent,
  log: (message: string) => void
): LandEvent | null {
  const controller = trigger.controller;
  if (controller === event.player) return null;
  if (event.cause === "play") return null;

  const lastTurn =
    (typeof trigger.data?.lastTurn === "number"
      ? (trigger.data.lastTurn as number)
      : null) ?? null;
  if (lastTurn === state.turn) return null;

  const plains = takePlainsFromLibrary(state, controller, 1);
  if (!plains.length) return null;
  const land = plains[0];
  const eventPayload = placeLandFromEffect(state, controller, land, log, {
    cause: "ability",
    tapped: true,
    description: `Player ${controller} uses ${trigger.sourceCard} to put ${land} onto the battlefield tapped`,
  });
  if (!trigger.data) trigger.data = {};
  trigger.data.lastTurn = state.turn;
  return eventPayload;
}

function movePlainsToHand(state: SimGameState, player: number, limit: number) {
  const cards = takePlainsFromLibrary(state, player, limit);
  if (cards.length) {
    state.hands[player].push(...cards);
  }
  return cards;
}

function takeLandFromHand(state: SimGameState, player: number) {
  const hand = state.hands[player] ?? [];
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (isLandCard(state, player, card)) {
      hand.splice(i, 1);
      return card;
    }
  }
  return null;
}

function registerTrigger(
  state: SimGameState,
  payload: Omit<RegisteredTrigger, "id">
) {
  const id = `trigger_${state.triggerCounter++}`;
  const record: RegisteredTrigger = { id, ...payload };
  state.triggers.push(record);
  return record;
}

function createEffectId(ctx: AbilityContext) {
  return `${ctx.cardName}-${ctx.player}-${Date.now()}`;
}

function registerCostReducer(
  state: SimGameState,
  player: number,
  reducer: CostReducer
) {
  if (!state.costReducers[player]) state.costReducers[player] = [];
  state.costReducers[player].push(reducer);
}

function removeCostReducer(
  state: SimGameState,
  player: number,
  cardName: CardName
) {
  const normalized = normalizeCardName(cardName);
  const reducers = state.costReducers[player];
  if (!reducers) return;
  state.costReducers[player] = reducers.filter(
    (reducer) => normalizeCardName(reducer.sourceCard) !== normalized
  );
}

function registerHandSizeModifier(
  state: SimGameState,
  player: number,
  modifier: HandSizeModifier
) {
  if (!state.handSizeModifiers[player]) state.handSizeModifiers[player] = [];
  state.handSizeModifiers[player].push(modifier);
}

function removeHandSizeModifier(
  state: SimGameState,
  player: number,
  cardName: CardName
) {
  const normalized = normalizeCardName(cardName);
  const list = state.handSizeModifiers[player];
  if (!list) return;
  state.handSizeModifiers[player] = list.filter(
    (modifier) => normalizeCardName(modifier.sourceCard) !== normalized
  );
}

const COLOR_MAP: Record<string, string> = {
  white: "W",
  blue: "U",
  black: "B",
  red: "R",
  green: "G",
};

function applyInferredAbilities(ctx: AbilityContext) {
  const text = ctx.metadata?.oracleText?.toLowerCase();
  if (!text) return;

  if (text.includes("you have no maximum hand size")) {
    registerHandSizeModifier(ctx.state, ctx.player, {
      id: createEffectId(ctx),
      sourceCard: ctx.cardName,
      noMax: true,
    });
  }

  const costRegex =
    /([a-z ]+?) spells you cast cost\s+\{(\d+)\}\s+less to cast/g;
  let match: RegExpExecArray | null;
  while ((match = costRegex.exec(text))) {
    const qualifier = match[1].trim();
    const amount = Number(match[2]) || 0;
    if (amount <= 0) continue;
    const predicate = createReducerPredicate(qualifier);
    if (!predicate) continue;
    registerCostReducer(ctx.state, ctx.player, {
      id: createEffectId(ctx),
      sourceCard: ctx.cardName,
      amount,
      appliesTo: (options) => predicate(options.metadata, options.card),
    });
  }
}

function createReducerPredicate(
  qualifier: string
): ((metadata?: DeckCardMetadata, card?: CardName) => boolean) | null {
  const normalized = qualifier.toLowerCase();
  if (!normalized.length || normalized === "spells you cast") {
    return () => true;
  }
  if (COLOR_MAP[normalized]) {
    const color = COLOR_MAP[normalized];
    return (metadata) =>
      Boolean(metadata?.colors?.includes(color) || metadata?.colorIdentity?.includes(color));
  }

  if (normalized.includes("artifact")) {
    return (metadata) =>
      Boolean(metadata?.typeLine?.toLowerCase().includes("artifact"));
  }
  if (normalized.includes("creature")) {
    return (metadata) =>
      Boolean(metadata?.typeLine?.toLowerCase().includes("creature"));
  }
  if (normalized.includes("instant")) {
    return (metadata) =>
      Boolean(metadata?.typeLine?.toLowerCase().includes("instant"));
  }
  if (normalized.includes("sorcery")) {
    return (metadata) =>
      Boolean(metadata?.typeLine?.toLowerCase().includes("sorcery"));
  }
  return null;
}

function takePlainsFromLibrary(
  state: SimGameState,
  player: number,
  limit: number
) {
  const results: CardName[] = [];
  const library = state.libraries[player] ?? [];
  for (let i = 0; i < library.length && results.length < limit; ) {
    const card = library[i];
    const metadata = getCardMetadata(state, player, card);
    if (isBasicPlainsCard(metadata, card)) {
      results.push(card);
      library.splice(i, 1);
    } else {
      i += 1;
    }
  }
  return results;
}

function placeLandFromEffect(
  state: SimGameState,
  player: number,
  card: CardName,
  log: (message: string) => void,
  options?: { cause?: LandEntryCause; tapped?: boolean; description?: string }
): LandEvent {
  state.battlefields[player].push(card);
  if (options?.tapped) {
    const key = card.trim().toLowerCase();
    state.tappedPermanents ??= {};
    state.tappedPermanents[player] ??= {};
    state.tappedPermanents[player][key] =
      (state.tappedPermanents[player][key] ?? 0) + 1;
  }
  if (options?.description) {
    log(options.description);
  } else {
    const tappedText = options?.tapped ? " tapped" : "";
    log(
      `Player ${player} puts ${card}${tappedText} onto the battlefield via effect`
    );
  }
  return { player, card, cause: options?.cause ?? "ability" };
}

function opponentHasMoreLands(state: SimGameState, player: number) {
  const playerCount = countLands(state, player);
  for (let i = 0; i < state.lifeTotals.length; i++) {
    if (i === player) continue;
    if (state.lifeTotals[i] <= 0) continue;
    const otherCount = countLands(state, i);
    if (otherCount > playerCount) return true;
  }
  return false;
}

function drawCards(
  state: SimGameState,
  player: number,
  count: number,
  log: (message: string) => void,
  source?: string
) {
  const library = state.libraries[player] ?? [];
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    if (!library.length) break;
    const card = library.shift();
    if (!card) break;
    state.hands[player].push(card);
    state.drawHistory[player] = (state.drawHistory[player] ?? 0) + 1;
    drawn += 1;
  }
  if (drawn > 0) {
    log(
      `Player ${player} draws ${drawn} card${drawn === 1 ? "" : "s"}${
        source ? ` via ${source}` : ""
      }`
    );
  }
}
