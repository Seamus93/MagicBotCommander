import type { CreaturePermanent } from "@rules/combat/types";
import type {
  AgentDecision,
  AttackDecision,
  BlockAssignment,
  BlockDecision,
  CardName,
  SimAgent,
  SimAction,
  SimGameState,
  StackEntry,
} from "@game-state/types";
import { evaluateHand, chooseBottomCards } from "./mulliganEvaluator.js";
import {
  availableAttackers,
  availableBlockers,
} from "../../rules/src/combat/combat.js";
import {
  bucketBlockerCount,
  bucketCanLethal,
  bucketIncomingDamage,
  bucketReadyPower,
  bucketThreatLevel,
} from "./featureBuckets.js";
import {
  PatternStore,
  patternFromFeatures,
  actionToKey,
} from "./patterns.js";
import type { PatternRecord } from "./patterns.js";
import {
  selectTarget,
  threatAssessment,
  type AttackPlan,
  type BlockPlan,
} from "./combatEvaluator.js";
import { ArchetypePolicy } from "./archetypePolicy.js";
import {
  getAvailableMana,
  getCardMetadata,
  isCounterspell,
  isPermanentCard,
} from "../../game-state/src/cardUtils.js";

// Phase 1 feature flags - disable with env vars if needed
const ENABLE_RICH_FEATURES = process.env.ENABLE_RICH_FEATURES !== "false";
const ENABLE_FUZZY_MATCHING = process.env.ENABLE_FUZZY_MATCHING !== "false";
// Minimum exact visits before trusting exact score over fuzzy score
const MIN_EXACT_VISITS = 3;
const DEFAULT_CONFIDENCE_K = 50;

// Phase 4 — archetype ID encoding for feature extraction
const ARCHETYPE_IDS: Readonly<Record<string, number>> = {
  AGGRO: 1, CONTROL: 2, COMBO: 3, MIDRANGE: 4,
  TEMPO: 5, RAMP: 6, "PRISON/STAX": 7, COMMANDER: 8,
};

const BLOCKER_COUNT_ENCODING = {
  "0": 0,
  "1-2": 1,
  "3-4": 2,
  "5+": 3,
} as const;

const BINARY_ENCODING = {
  no: 0,
  yes: 1,
} as const;

const THREAT_LEVEL_ENCODING = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
} as const;

/** Returns the bucket index: 0 if value < thresholds[0], ..., thresholds.length if value >= last */
function bucket(value: number, thresholds: readonly number[]): number {
  for (let i = 0; i < thresholds.length; i++) {
    if (value < thresholds[i]) return i;
  }
  return thresholds.length;
}

export interface LearningAgentOptions {
  id: string;
  store: PatternStore;
  epsilon?: number;
  confidenceK?: number;
  /** Phase 4 — archetipo del mazzo di questo agente (es. "AGGRO") */
  archetype?: string;
  /** Phase 4 — archetipi degli avversari, usati come feature */
  opponentArchetypes?: string[];
}

type DecisionTrace = {
  pattern: string;
  actionKey: string;
};

export type ScoredChoice<T> = {
  choice: T;
  pattern: string;
  key: string;
  score: number;
  expectedReward: number;
  confidence: number;
  visits: number;
  source: "exact" | "fuzzy" | "heuristic" | "explore";
  record?: PatternRecord;
};

export type ScoredAction = {
  action: SimAction;
  pattern: string;
  key: string;
  score: number;
  expectedReward: number;
  confidence: number;
  visits: number;
  source: "exact" | "fuzzy" | "heuristic" | "explore";
  record?: PatternRecord;
};

export class LearningAgent implements SimAgent {
  public readonly id: string;
  protected readonly store: PatternStore;
  protected readonly epsilon: number;
  protected readonly history: DecisionTrace[] = [];
  protected readonly confidenceK: number;
  // Phase 4 — archetype-aware policy
  protected archetype: string | undefined;
  protected opponentArchetypes: string[];
  protected readonly archetypePolicy: ArchetypePolicy | undefined;

  constructor({ id, store, epsilon = 0.1, confidenceK, archetype, opponentArchetypes }: LearningAgentOptions) {
    this.id = id;
    this.store = store;
    this.epsilon = epsilon;
    this.confidenceK = confidenceK ?? DEFAULT_CONFIDENCE_K;
    this.archetype = archetype;
    this.opponentArchetypes = opponentArchetypes ?? [];
    this.archetypePolicy = archetype ? new ArchetypePolicy(store) : undefined;
  }

  /** Phase 4 — aggiorna l'archetipo corrente (es. in round-robin tra episodi). */
  setArchetype(archetype: string, opponentArchetypes: string[] = []): void {
    (this as unknown as { archetype: string | undefined }).archetype = archetype;
    this.opponentArchetypes = opponentArchetypes;
    if (!this.archetypePolicy) {
      (this as unknown as { archetypePolicy: ArchetypePolicy }).archetypePolicy = new ArchetypePolicy(this.store);
    }
  }

  decideAction(
    state: SimGameState,
    availableActions: SimAction[]
  ): AgentDecision | Promise<AgentDecision> {
    if (availableActions.length === 0) {
      return {
        action: { type: "PASS_TURN" },
        metadata: { source: "fallback" },
      };
    }

    const scored = this.scoreActions(state, availableActions);
    const { choice, explored } = this.pickChoice(scored);
    this.history.push({ pattern: choice.pattern, actionKey: choice.key });
    return {
      action: choice.action,
      metadata: {
        source: explored ? "explore" : choice.source,
        pattern: choice.pattern,
        actionKey: choice.key,
        expectedReward: choice.expectedReward,
        confidence: explored ? 0 : choice.confidence,
        visits: choice.visits,
      },
    };
  }

  finalizeEpisode(reward: number) {
    if (this.archetypePolicy && this.archetype) {
      for (const trace of this.history) {
        this.archetypePolicy.observe(this.archetype, trace.pattern, trace.actionKey, reward);
      }
    } else {
      for (const trace of this.history) {
        this.store.observe(trace.pattern, trace.actionKey, reward);
      }
    }
    this.history.length = 0;
  }

  /**
   * Phase 2 — finalize con reward per-step già scontati temporalmente.
   * Phase 4 — se archetype è impostato, scrive nelle partizioni archetype-specific.
   */
  finalizeEpisodeWithRewards(rewards: number[]) {
    const len = Math.min(this.history.length, rewards.length);
    if (this.archetypePolicy && this.archetype) {
      for (let i = 0; i < len; i++) {
        this.archetypePolicy.observe(
          this.archetype,
          this.history[i].pattern,
          this.history[i].actionKey,
          rewards[i]
        );
      }
    } else {
      for (let i = 0; i < len; i++) {
        this.store.observe(this.history[i].pattern, this.history[i].actionKey, rewards[i]);
      }
    }
    this.history.length = 0;
  }

  decideTarget(state: SimGameState, opponentIndices: number[]): number {
    const scored = this.scoreTargetOptions(state, opponentIndices);
    const { choice } = this.pickChoice(scored);
    this.history.push({ pattern: choice.pattern, actionKey: choice.key });
    return choice.choice;
  }

  decideAttackPlan(state: SimGameState, plans: AttackPlan[]): AttackPlan {
    const scored = this.scoreAttackPlanOptions(state, plans);
    const { choice } = this.pickChoice(scored);
    this.history.push({ pattern: choice.pattern, actionKey: choice.key });
    return choice.choice;
  }

  decideBlockPlan(state: SimGameState, plans: BlockPlan[]): BlockPlan {
    const scored = this.scoreBlockPlanOptions(state, plans);
    const { choice } = this.pickChoice(scored);
    this.history.push({ pattern: choice.pattern, actionKey: choice.key });
    return choice.choice;
  }

  decideAttackers(
    state: SimGameState,
    availableAttackersPool: CreaturePermanent[]
  ): AttackDecision {
    const attackers: string[] = [];
    for (const creature of availableAttackersPool) {
      const options: SimAction[] = [
        { type: "ATTACK_CHOICE", card: creature.id, mode: "ATTACK" },
        { type: "ATTACK_CHOICE", card: creature.id, mode: "HOLD" },
      ];
      const scored = this.scoreActions(state, options);
      const { choice } = this.pickChoice(scored);
      this.history.push({ pattern: choice.pattern, actionKey: choice.key });
      if (
        choice.action.type === "ATTACK_CHOICE" &&
        choice.action.mode === "ATTACK"
      ) {
        attackers.push(creature.id);
      }
    }

    return {
      attackers,
      metadata: { source: "policy" },
    };
  }

  decideBlockers(
    state: SimGameState,
    attackers: CreaturePermanent[],
    availableBlockersPool: CreaturePermanent[]
  ): BlockDecision {
    if (!availableBlockersPool.length || !attackers.length) {
      return { assignments: [], metadata: { source: "fallback" } };
    }

    const assignments: BlockAssignment[] = [];
    const targets = attackers.map((attacker) => attacker.id);

    for (const blocker of availableBlockersPool) {
      const options: SimAction[] = [
        { type: "BLOCK_CHOICE", card: blocker.id, targetId: null },
        ...targets.map((targetId) => ({
          type: "BLOCK_CHOICE" as const,
          card: blocker.id,
          targetId,
        })),
      ];
      const scored = this.scoreActions(state, options);
      const { choice } = this.pickChoice(scored);
      this.history.push({ pattern: choice.pattern, actionKey: choice.key });
      if (choice.action.type !== "BLOCK_CHOICE" || !choice.action.targetId) continue;
      assignments.push({
        blockerId: blocker.id,
        attackerId: choice.action.targetId,
      });
    }

    return {
      assignments,
      metadata: { source: "policy" },
    };
  }

  decideMulligan(hand: CardName[], mulliganCount: number): { keep: boolean; bottomCards?: CardName[] } {
    const score = evaluateHand(hand, this.archetype);
    const thresholds = [50, 40, 25];
    const threshold = thresholds[mulliganCount] ?? 25;

    // Epsilon-greedy: occasionally keep below threshold
    if (Math.random() < this.epsilon && score >= threshold * 0.6) {
      return { keep: true };
    }

    const keep = mulliganCount >= 3 || score >= threshold;
    if (!keep) return { keep: false };

    if (mulliganCount > 0) {
      const bottomCards = chooseBottomCards(hand, mulliganCount, this.archetype);
      return { keep: true, bottomCards };
    }
    return { keep: true };
  }

  decideResponse(
    state: SimGameState,
    triggeringEntry: StackEntry,
    availableInstants: SimAction[]
  ): SimAction | null {
    if (availableInstants.length === 0) return null;

    // Build features for the response decision
    const stackDepth = state.stack?.length ?? 0;
    const triggeringAction = triggeringEntry.action;
    const triggeringCmc = "card" in triggeringAction
      ? (state.cardMetadata[triggeringEntry.casterIndex]?.[
          (triggeringAction.card ?? "").toLowerCase()
        ]?.manaValue ?? 0)
      : 0;
    const myLife = state.lifeTotals[state.playerIndex] ?? 40;
    const myInstantsCount = availableInstants.length;
    const threatLevel = triggeringCmc >= 5 ? 2 : triggeringCmc >= 3 ? 1 : 0;

    const features = {
      stackDepth: Math.min(stackDepth, 3),
      triggeringCmc: Math.min(triggeringCmc, 5),
      myInstantsCount: Math.min(myInstantsCount, 3),
      myLife: Math.floor(myLife / 10),
      threatLevel,
    };

    const pattern = `response:${patternFromFeatures(features)}`;

    // Score: respond vs pass (null)
    const respondKey = "response:yes";
    const passKey = "response:no";
    const respondScore = this.resolvePatternScore(pattern, respondKey);
    const passScore = this.resolvePatternScore(pattern, passKey);

    // Epsilon-greedy
    if (Math.random() < this.epsilon) {
      // Explore: randomly decide
      return Math.random() < 0.5
        ? this.pickBestResponse(state, triggeringEntry, availableInstants)
        : null;
    }

    if (respondScore.score > passScore.score && availableInstants.length > 0) {
      this.history.push({ pattern, actionKey: respondKey });
      return this.pickBestResponse(state, triggeringEntry, availableInstants);
    }

    this.history.push({ pattern, actionKey: passKey });
    return null;
  }

  protected scoreActions(
    state: SimGameState,
    availableActions: SimAction[]
  ): ScoredAction[] {
    const patternBase = this.extractFeatures(state);
    const playerIndex = state.playerIndex;
    const availableMana = getAvailableMana(state, playerIndex);
    const hasLandDrop = availableActions.some((candidate) => candidate.type === "PLAY_LAND");
    const reserveInteractionCost = this.getCheapestInteractionCost(state, state.hands[playerIndex] ?? []);
    const representedInteractionCost =
      reserveInteractionCost ?? this.getRepresentedInteractionCost(state, playerIndex);
    const phase = `${state.phase ?? ""} ${state.phaseStep ?? ""}`.toLowerCase();
    const isPreCombatMain = phase.includes("prima fase principale");
    const isPostCombatMain = phase.includes("seconda fase principale");

    return availableActions.map((action) => {
      const pattern = patternFromFeatures({
        ...patternBase,
        actionHash: this.hashAction(action),
      });
      const key = actionToKey(action.type, "card" in action ? action.card : "");
      const policy = this.resolvePatternScore(pattern, key);
      let heuristic = 0;
      if (action.type === "PLAY_LAND") {
        heuristic += 0.22;
        if (representedInteractionCost !== null) heuristic += reserveInteractionCost !== null ? 0.08 : 0.04;
      } else if (action.type === "CAST_SPELL") {
        const metadata = getCardMetadata(state, playerIndex, action.card);
        const manaValue = metadata?.manaValue ?? 3;
        const remainingMana = Math.max(0, availableMana - manaValue);
        const efficiency = availableMana > 0 ? Math.min(1, manaValue / availableMana) : 0;
        heuristic += (efficiency - 0.5) * 0.18;
        heuristic -= Math.min(0.18, remainingMana * 0.025);
        if (isPermanentCard(action.card, metadata)) {
          heuristic += this.boardDevelopmentBias(state, playerIndex, action.card);
        }
        heuristic += this.interactionBias(action.card, metadata);
        heuristic += this.cardAdvantageBias(metadata?.oracleText);
        if (isPreCombatMain && this.isCombatTrickOrRemoval(action.card, metadata)) {
          heuristic -= 0.04;
        }
        if (isPostCombatMain && isPermanentCard(action.card, metadata)) {
          heuristic += 0.04;
        }
        heuristic -= this.overcommitRisk(state, playerIndex, action.card);
        if (representedInteractionCost !== null) {
          const remainingMana = Math.max(0, availableMana - manaValue);
          if (remainingMana < representedInteractionCost) {
            heuristic -= reserveInteractionCost !== null ? 0.22 : 0.14;
          } else {
            heuristic += 0.05;
          }
        }
      } else if (action.type === "PASS_TURN") {
        const otherPlayableActions = availableActions.filter(
          (candidate) => candidate.type !== "PASS_TURN"
        ).length;
        if (otherPlayableActions > 0) heuristic -= 0.12;
        if (representedInteractionCost !== null && availableMana >= representedInteractionCost) {
          if (hasLandDrop) {
            heuristic += reserveInteractionCost !== null ? 0.06 : 0.03;
          } else {
            heuristic += reserveInteractionCost !== null ? 0.24 : 0.16;
          }
        }
      }

      const score = this.blendPolicyAndHeuristic(policy, heuristic);
      return {
        action,
        pattern,
        key,
        score,
        expectedReward: policy.expectedReward,
        confidence: policy.confidence,
        visits: policy.visits,
        source: policy.source,
        record: policy.record,
      };
    });
  }

  private pickBestResponse(
    state: SimGameState,
    triggeringEntry: StackEntry,
    availableInstants: SimAction[]
  ): SimAction {
    const bestCounter = availableInstants.find((action) => {
      if (action.type !== "CAST_SPELL") return false;
      const metadata = getCardMetadata(state, state.playerIndex, action.card);
      return isCounterspell(action.card, metadata) && triggeringEntry.action.type === "CAST_SPELL";
    });
    return bestCounter ?? availableInstants[0];
  }

  private getCheapestInteractionCost(
    state: SimGameState,
    cards: CardName[]
  ): number | null {
    let best: number | null = null;
    for (const card of cards) {
      const metadata = getCardMetadata(state, state.playerIndex, card);
      if (!this.isInteractionSpell(card, metadata)) continue;
      const cost = metadata?.manaValue ?? 0;
      best = best === null ? cost : Math.min(best, cost);
    }
    return best;
  }

  private getRepresentedInteractionCost(
    state: SimGameState,
    playerIndex: number
  ): number | null {
    const candidates = [
      ...(state.hands[playerIndex] ?? []),
      ...(state.libraries[playerIndex] ?? []),
    ];
    let best: number | null = null;
    for (const card of candidates) {
      const metadata = getCardMetadata(state, playerIndex, card);
      if (!this.isInteractionSpell(card, metadata)) continue;
      const cost = metadata?.manaValue ?? 2;
      best = best === null ? cost : Math.min(best, cost);
    }
    return best;
  }

  protected scoreTargetOptions(
    state: SimGameState,
    opponentIndices: number[]
  ): ScoredChoice<number>[] {
    const heuristicTarget = selectTarget(state, state.playerIndex, opponentIndices);
    const myReadyPower = availableAttackers(state, state.playerIndex).reduce(
      (sum, creature) => sum + creature.power,
      0
    );

    return opponentIndices.map((opponentIndex) => {
      const targetLife = state.lifeTotals[opponentIndex] ?? 0;
      const blockers = availableBlockers(state, opponentIndex).length;
      const threat = threatAssessment(state, opponentIndex);
      const features = {
        myReadyPower: bucketReadyPower(myReadyPower),
        targetLife: bucket(targetLife, [10, 20, 30, 40]),
        targetBlockers: BLOCKER_COUNT_ENCODING[bucketBlockerCount(blockers)],
        targetThreat: THREAT_LEVEL_ENCODING[bucketThreatLevel(threat)],
        canLethal: BINARY_ENCODING[bucketCanLethal(myReadyPower >= targetLife)],
      };
      const pattern = this.buildCombatPattern("combat_target:", features);
      const key = `target:${opponentIndex}`;
      const heuristic =
        (opponentIndex === heuristicTarget ? 0.18 : 0) +
        (myReadyPower >= targetLife ? 0.45 : 0) +
        clamp(threat / 80, 0, 0.25) -
        blockers * 0.04;
      const policy = this.resolvePatternScore(pattern, key, heuristic);
      return {
        choice: opponentIndex,
        pattern,
        key,
        score: policy.score,
        expectedReward: policy.expectedReward,
        confidence: policy.confidence,
        visits: policy.visits,
        source: policy.source,
        record: policy.record,
      };
    });
  }

  protected scoreAttackPlanOptions(
    state: SimGameState,
    plans: AttackPlan[]
  ): ScoredChoice<AttackPlan>[] {
    const myReadyPower = availableAttackers(state, state.playerIndex).reduce(
      (sum, creature) => sum + creature.power,
      0
    );

    return plans.map((plan) => {
      const targetLife = state.lifeTotals[plan.targetPlayer] ?? 0;
      const targetBlockers = availableBlockers(state, plan.targetPlayer).length;
      const features = {
        myReadyPower: bucketReadyPower(myReadyPower),
        targetLife: bucket(targetLife, [10, 20, 30, 40]),
        targetBlockers: BLOCKER_COUNT_ENCODING[bucketBlockerCount(targetBlockers)],
        canLethal: BINARY_ENCODING[bucketCanLethal(plan.expectedDamage >= targetLife)],
      };
      const pattern = this.buildCombatPattern("combat_attack:", features);
      const key = `target:${plan.targetPlayer}|attackers:${serializeIds(plan.attackers)}`;
      const policy = this.resolvePatternScore(pattern, key, normalizePlanScore(plan.score));
      return {
        choice: plan,
        pattern,
        key,
        score: policy.score,
        expectedReward: policy.expectedReward,
        confidence: policy.confidence,
        visits: policy.visits,
        source: policy.source,
        record: policy.record,
      };
    });
  }

  protected scoreBlockPlanOptions(
    state: SimGameState,
    plans: BlockPlan[]
  ): ScoredChoice<BlockPlan>[] {
    const incomingDamage = plans[0]?.totalIncomingDamage ?? 0;
    const bestTradeAvailable = plans.some(
      (plan) => plan.creaturesKilled > 0 && plan.creaturesKilled >= plan.blockersLost
    );
    const blockerCount = availableBlockers(state, state.playerIndex).length;
    const myLife = state.lifeTotals[state.playerIndex] ?? 0;

    return plans.map((plan) => {
      const features = {
        incomingDamage: bucketIncomingDamage(incomingDamage),
        myLife: bucket(myLife, [10, 20, 30, 40]),
        myBlockerCount: BLOCKER_COUNT_ENCODING[bucketBlockerCount(blockerCount)],
        bestTradeAvailable: BINARY_ENCODING[bucketCanLethal(bestTradeAvailable)],
      };
      const pattern = this.buildCombatPattern("combat_block:", features);
      const key = `assignments:${serializePlanAssignments(plan.assignments)}`;
      const policy = this.resolvePatternScore(pattern, key, normalizePlanScore(plan.score));
      return {
        choice: plan,
        pattern,
        key,
        score: policy.score,
        expectedReward: policy.expectedReward,
        confidence: policy.confidence,
        visits: policy.visits,
        source: policy.source,
        record: policy.record,
      };
    });
  }

  protected extractFeatures(state: SimGameState): Record<string, number> {
    return ENABLE_RICH_FEATURES
      ? this.extractRichFeatures(state)
      : this.extractBasicFeatures(state);
  }

  protected hashAction(action: SimAction) {
    switch (action.type) {
      case "PLAY_LAND":
        return 1;
      case "CAST_SPELL":
        return 2;
      case "ATTACK_CHOICE":
        return action.mode === "ATTACK" ? 3 : 4;
      case "BLOCK_CHOICE":
        return action.targetId ? 5 : 6;
      default:
        return 0;
    }
  }

  protected pickChoice<T extends { score: number; source?: "exact" | "fuzzy" | "heuristic" | "explore" }>(
    scored: T[]
  ): { choice: T; explored: boolean } {
    if (!scored.length) {
      throw new Error("No actions to choose from.");
    }
    const explore = Math.random() < this.epsilon;
    if (explore) {
      return {
        choice: { ...scored[Math.floor(Math.random() * scored.length)], source: "explore" },
        explored: true,
      };
    }
    const best = scored.reduce((bestChoice, current) =>
      current.score > bestChoice.score ? current : bestChoice
    );
    return { choice: best, explored: false };
  }

  protected resolvePatternScore(
    pattern: string,
    key: string,
    heuristic = 0
  ): {
    score: number;
    expectedReward: number;
    confidence: number;
    visits: number;
    source: "exact" | "fuzzy" | "heuristic";
    record?: PatternRecord;
  } {
    const exactPattern = this.archetypePolicy && this.archetype
      ? `${this.archetype}::${pattern}`
      : pattern;
    let record = this.store.get(exactPattern, key);
    if (!record && exactPattern !== pattern) {
      record = this.store.get(pattern, key);
    }

    if (record && record.visits >= MIN_EXACT_VISITS) {
      const expectedReward = record.score / record.visits;
      const confidence = this.confidenceFromRecord(record);
      return {
        score: this.blendPolicyAndHeuristic(
          { expectedReward, confidence, visits: record.visits, source: "exact", record },
          heuristic
        ),
        expectedReward,
        confidence,
        visits: record.visits,
        source: "exact",
        record,
      };
    }

    if (ENABLE_FUZZY_MATCHING) {
      const fuzzy = this.store.fuzzyRecord(pattern, key);
      if (fuzzy) {
        const expectedReward = fuzzy.scorePerVisit;
        const confidence = this.confidenceFromVisits(fuzzy.visits) * 0.85;
        return {
          score: this.blendPolicyAndHeuristic(
            { expectedReward, confidence, visits: fuzzy.visits, source: "fuzzy", record: fuzzy },
            heuristic
          ),
          expectedReward,
          confidence,
          visits: fuzzy.visits,
          source: "fuzzy",
          record: fuzzy,
        };
      }
    } else if (record && record.visits > 0) {
      const expectedReward = record.score / record.visits;
      const confidence = this.confidenceFromRecord(record);
      return {
        score: this.blendPolicyAndHeuristic(
          { expectedReward, confidence, visits: record.visits, source: "exact", record },
          heuristic
        ),
        expectedReward,
        confidence,
        visits: record.visits,
        source: "exact",
        record,
      };
    }

    return {
      score: heuristic,
      expectedReward: 0,
      confidence: 0,
      visits: 0,
      source: "heuristic",
    };
  }

  protected confidenceFromVisits(visits: number): number {
    return visits / (visits + this.confidenceK);
  }

  protected confidenceFromRecord(record: PatternRecord): number {
    const base = this.confidenceFromVisits(record.visits);
    if (
      record.rewardSquaredSum === undefined ||
      record.visits <= 1
    ) {
      return base;
    }
    const mean = record.score / record.visits;
    const variance = Math.max(
      0,
      record.rewardSquaredSum / record.visits - mean * mean
    );
    const standardError = Math.sqrt(variance / record.visits);
    return clamp(base * (1 - Math.min(0.5, standardError)), 0, 1);
  }

  private blendPolicyAndHeuristic(
    policy: { expectedReward: number; confidence: number; visits: number; source: "exact" | "fuzzy" | "heuristic"; record?: PatternRecord },
    heuristic: number
  ): number {
    if (policy.source === "heuristic" || policy.visits <= 0) return clamp(heuristic, -1, 1);
    const policyWeight = policy.visits >= MIN_EXACT_VISITS
      ? clamp(0.35 + policy.confidence * 0.6, 0.35, 0.95)
      : clamp(policy.confidence, 0.05, 0.25);
    return policy.expectedReward * policyWeight + clamp(heuristic, -1, 1) * (1 - policyWeight);
  }

  private boardDevelopmentBias(state: SimGameState, playerIndex: number, card: string): number {
    const metadata = getCardMetadata(state, playerIndex, card);
    const myCreatures = state.creatures[playerIndex]?.length ?? 0;
    const avgOppCreatures = average(
      state.creatures
        .filter((_, index) => index !== playerIndex)
        .map((creatures) => creatures.length)
    );
    if (metadata?.isCreature) {
      return myCreatures < avgOppCreatures ? 0.14 : 0.06;
    }
    const text = `${metadata?.oracleText ?? ""} ${metadata?.typeLine ?? ""}`.toLowerCase();
    if (/draw|token|treasure|add .*mana|whenever|at the beginning/.test(text)) return 0.08;
    return 0.03;
  }

  private cardAdvantageBias(text?: string): number {
    const lower = text?.toLowerCase() ?? "";
    if (/draw (?:two|three|four|\d+)/.test(lower)) return 0.12;
    if (/draw a card|return .* from your graveyard|create .* token/.test(lower)) return 0.06;
    return 0;
  }

  private interactionBias(card: string, metadata?: ReturnType<typeof getCardMetadata>): number {
    if (this.isInteractionSpell(card, metadata)) return 0.1;
    return 0;
  }

  private overcommitRisk(state: SimGameState, playerIndex: number, card: string): number {
    const metadata = getCardMetadata(state, playerIndex, card);
    if (!isPermanentCard(card, metadata)) return 0;
    const myPermanents = (state.battlefields[playerIndex]?.length ?? 0) + (state.creatures[playerIndex]?.length ?? 0);
    const handSize = state.hands[playerIndex]?.length ?? 0;
    return myPermanents >= 10 && handSize <= 2 ? 0.1 : 0;
  }

  private isCombatTrickOrRemoval(card: string, metadata?: ReturnType<typeof getCardMetadata>): boolean {
    const text = `${metadata?.oracleText ?? ""} ${card}`.toLowerCase();
    return /destroy|exile|damage to target creature|counter target|target creature gets|prevent/.test(text);
  }

  private isInteractionSpell(card: string, metadata?: ReturnType<typeof getCardMetadata>): boolean {
    if (isCounterspell(card, metadata)) return true;
    const text = `${metadata?.oracleText ?? ""} ${card}`.toLowerCase();
    const instant = metadata?.typeLine?.toLowerCase().includes("instant") ?? false;
    return instant && /counter target|destroy target|exile target|damage to target|prevent|return target/.test(text);
  }

  private buildCombatPattern(prefix: string, features: Record<string, number>) {
    return `${prefix}${patternFromFeatures(features)}`;
  }

  /** Original 8-feature extraction (kept for comparison / fallback). */
  private extractBasicFeatures(state: SimGameState): Record<string, number> {
    const { playerIndex } = state;
    const opponentLifeAvg =
      state.lifeTotals
        .filter((_, idx) => idx !== playerIndex)
        .reduce((sum, val) => sum + val, 0) / (state.lifeTotals.length - 1);
    const creatures = state.creatures[playerIndex] ?? [];
    const readyPower = creatures
      .filter((c) => !c.summoningSickness)
      .reduce((sum, c) => sum + c.power, 0);
    const meta = state.cardMetadata[playerIndex] ?? {};

    return {
      turn: state.turn,
      handSize: state.hands[playerIndex].length,
      lands: state.battlefields[playerIndex].filter((card) =>
        meta[card]?.isLand ?? card.toLowerCase().includes("land")
      ).length,
      spellsInHand: state.hands[playerIndex].filter(
        (card) => !(meta[card]?.isLand ?? card.toLowerCase().includes("land"))
      ).length,
      life: state.lifeTotals[playerIndex],
      opponentLifeAvg,
      creatures: creatures.length,
      readyPower,
    };
  }

  /**
   * Phase 1 - 18 bucketed features.
   * All values are small integers so the pattern space stays compact.
   */
  private extractRichFeatures(state: SimGameState): Record<string, number> {
    const { playerIndex } = state;
    const hand = state.hands[playerIndex] ?? [];
    const battlefield = state.battlefields[playerIndex] ?? [];
    const graveyard = state.graveyards[playerIndex] ?? [];
    const library = state.libraries[playerIndex] ?? [];
    const creatures = state.creatures[playerIndex] ?? [];
    const meta = state.cardMetadata[playerIndex] ?? {};

    const isLand = (card: string) =>
      meta[card]?.isLand ?? card.toLowerCase().includes("land");

    const myLands = battlefield.filter(isLand).length;
    const myArtifacts = (state.artifacts[playerIndex] ?? []).length;
    const mySpellsInHand = hand.filter((card) => !isLand(card)).length;
    const myLife = state.lifeTotals[playerIndex];
    const myReadyPower = creatures
      .filter((creature) => !creature.summoningSickness && !creature.tapped)
      .reduce((sum, creature) => sum + creature.power, 0);

    const opponentLifeTotals = state.lifeTotals.filter((_, idx) => idx !== playerIndex);
    const opponentAvgLife =
      opponentLifeTotals.reduce((sum, value) => sum + value, 0) / opponentLifeTotals.length;
    const opponentMinLife = Math.min(...opponentLifeTotals);

    const opponentCreatureArrays = state.creatures.filter((_, idx) => idx !== playerIndex);
    const avgOpponentCreatures =
      opponentCreatureArrays.reduce((sum, creaturesPool) => sum + creaturesPool.length, 0) /
      opponentCreatureArrays.length;
    const totalOpponentReadyPower = opponentCreatureArrays
      .flat()
      .filter((creature) => !creature.summoningSickness && !creature.tapped)
      .reduce((sum, creature) => sum + creature.power, 0);

    const artifactMana = state.artifactMana[playerIndex] ?? 0;
    const totalManaProduction = myLands + artifactMana;
    const boardAdvantageBucket = Math.sign(creatures.length - avgOpponentCreatures) + 1;
    const numCostReducers = Math.min(
      (state.costReducers[playerIndex] ?? []).length,
      3
    );
    const phaseEnc = state.phase?.includes("COMBAT")
      ? 1
      : state.phase?.includes("MAIN_POST")
        ? 2
        : 0;

    // Phase 4 — archetype features
    const myArchEnc = this.archetype
      ? (ARCHETYPE_IDS[this.archetype.toUpperCase()] ?? 0)
      : 0;
    const opponentMixSum = this.opponentArchetypes
      .map((a) => ARCHETYPE_IDS[a?.toUpperCase()] ?? 0)
      .reduce((s, v) => s + v, 0);
    const opponentArchMix = bucket(opponentMixSum, [5, 10, 15, 20]);

    return {
      turnBucket: bucket(state.turn, [4, 8, 12]),
      phaseEnc,
      handBucket: bucket(hand.length, [2, 4, 6]),
      spellsBucket: bucket(mySpellsInHand, [1, 3, 5]),
      libraryBucket: bucket(library.length, [20, 30, 40]),
      landBucket: bucket(myLands, [3, 5, 7]),
      artifactsBucket: bucket(myArtifacts, [1, 2, 4]),
      manaProductionBucket: bucket(totalManaProduction, [2, 4, 6]),
      creaturesBucket: bucket(creatures.length, [1, 3, 5]),
      readyPowerBucket: bucket(myReadyPower, [2, 5, 10]),
      graveyardBucket: bucket(graveyard.length, [2, 5, 10]),
      costReducers: numCostReducers,
      lifeBucket: bucket(myLife, [10, 20, 30]),
      opponentMinLifeBucket: bucket(opponentMinLife, [10, 20, 30]),
      opponentAvgLifeBucket: bucket(opponentAvgLife, [15, 25, 35]),
      opponentCreaturesBucket: bucket(avgOpponentCreatures, [1, 3, 5]),
      opponentReadyPowerBucket: bucket(totalOpponentReadyPower, [3, 8, 15]),
      boardAdvantageBucket,
      // Phase 4 — archetype context
      myArchetypeEnc: myArchEnc,
      opponentArchetypeMix: opponentArchMix,
    };
  }
}

export const isLearningAgent = (
  agent: SimAgent
): agent is LearningAgent => agent instanceof LearningAgent;

function serializeIds(ids: string[]) {
  return [...ids].sort().join(",");
}

function serializePlanAssignments(assignments: Map<string, string[]>) {
  return [...assignments.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([attackerId, blockerIds]) => `${attackerId}:${[...blockerIds].sort().join(",")}`)
    .join("|");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizePlanScore(score: number): number {
  return clamp(score / 20, -1, 1);
}
