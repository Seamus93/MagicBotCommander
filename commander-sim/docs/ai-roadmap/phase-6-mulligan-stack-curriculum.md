# Fase 6: Mulligan, Stack Interaction, Curriculum di Training

**Stato**: ✅ COMPLETATA (2026-03-12)
**Dipendenze**: Tutte le fasi precedenti
**Rischio**: Alto
**Stima**: 3-4 settimane

---

## Obiettivo

Completare le meccaniche di gioco mancanti (mulligan e instant-speed response sullo stack) e ottimizzare il processo di apprendimento con un curriculum scheduler che focalizza il training sulle aree piu deboli.

**Implementazione completata il 2026-03-12**: London Mulligan (evaluateHand, shouldMulligan, chooseBottomCards, engine integration, LearningAgent.decideMulligan), Stack Interaction (StackEntry, ENABLE_STACK flag, passPriority/resolveStack, getAvailableInstants/canRespondWith, LearningAgent.decideResponse), Curriculum Scheduler (CurriculumScheduler con analyzeWeaknesses, buildTrainingScenario, computeEpsilon, selectNextMatchup), integrazione run-batch USE_CURRICULUM, endpoint GET /curriculum/status.

---

## Checklist

### PARTE A: London Mulligan

#### A1. Mulligan Evaluator (`packages/sim/src/mulliganEvaluator.ts`)
- [x] Creare il file `mulliganEvaluator.ts`
- [x] `evaluateHand(hand: CardName[], archetype?: string, ctx?: MulliganContext): number`
  - Score 0-100 basato su:
  - [x] Land count: ideale 2-4 per mano di 7 (scalare per mulligan count)
    - 0 terre → score 0 (auto-mulligan)
    - 1 terra → score 20
    - 2-3 terre → score 80-100
    - 4 terre → score 60
    - 5+ terre → score 30
  - [x] Mana curve coverage: ha giocate su turno 2 e 3?
    - +20 se ha spell CMC 2
    - +15 se ha spell CMC 3
  - [x] Color coverage: le terre producono i colori necessari per le spell in mano?
    - -20 per ogni spell non castabile con le terre presenti
  - [x] Archetype bonus (se archetype disponibile):
    - AGGRO: +15 se ha creature CMC 1-2
    - CONTROL: +15 se ha removal o counter
    - RAMP: +15 se ha ramp spell
    - COMBO: +10 per ogni combo piece presente
- [x] `shouldMulligan(hand: CardName[], mulliganCount: number, archetype?: string): boolean`
  - Threshold dinamico basato su mulligan count:
    - Mulligan 0 (7 carte): keep se score >= 50
    - Mulligan 1 (6 carte): keep se score >= 40
    - Mulligan 2 (5 carte): keep se score >= 25
    - Mulligan 3 (4 carte): always keep
- [x] `chooseBottomCards(hand: CardName[], count: number, archetype?: string): CardName[]`
  - Seleziona le carte da mettere in fondo alla libreria dopo il mulligan
  - Priorita bottom: terre in eccesso (>3), spell troppo costose, duplicati

#### A2. SimAgent Interface (`packages/game-state/src/types.ts`)
- [x] Aggiungere a `SimAgent`:
  ```ts
  decideMulligan?(hand: CardName[], mulliganCount: number): { keep: boolean, bottomCards?: CardName[] }
  ```

#### A3. Engine Integration (`packages/sim/src/engine.ts`)
- [x] Aggiungere fase mulligan prima del game loop (prima del turno 1)
- [x] Flag `ENABLE_MULLIGAN` (default true, disabilitabile con `ENABLE_MULLIGAN=false`)
- [x] Loggare decisioni mulligan nella history

#### A4. Agent Mulligan Decision (`packages/sim/src/learningAgent.ts`)
- [x] Implementare `decideMulligan()`:
  - [x] Usa `mulliganEvaluator.evaluateHand()` per score
  - [x] Epsilon-greedy: occasionalmente tiene mani sotto threshold per esplorare

#### A5. Test Mulligan
- [x] Unit test `evaluateHand`:
  - [x] 7 terre → score basso, shouldMulligan = true
  - [x] 0 terre → score 0, shouldMulligan = true
  - [x] 3 terre + 4 spell on curve → score alto, keep
  - [x] 2 terre + 5 spell CMC 6+ → score basso (no early plays)
- [x] Unit test `chooseBottomCards`:
  - [x] Con 4 terre e 2 spell: mette in fondo 1 terra
  - [x] Con 1 terra e 5 spell costose: mette in fondo le spell piu costose

---

### PARTE B: Stack Interaction (Instant-Speed Response)

#### B1. Stack Types (`packages/game-state/src/types.ts`)
- [x] Definire `StackEntry`:
  ```ts
  {
    id: string,
    action: SimAction,
    casterIndex: number,
    resolved: boolean,
    responses: StackEntry[]
  }
  ```
- [x] Aggiungere `stack: StackEntry[]` a `SimGameState`
- [x] Aggiungere a `SimAgent`:
  ```ts
  decideResponse?(state: SimGameState, triggeringEntry: StackEntry, availableInstants: SimAction[]): SimAction | null
  ```

#### B2. Priority System (`packages/sim/src/engine.ts`)
- [x] Implementare `passPriority(state, castingPlayer, stackEntry, agents, log)`
- [x] Dopo che tutti passano priorita: risolvere lo stack in ordine LIFO
- [x] `resolveStack(state, log)`: pop e applica ogni entry dal top

#### B3. Instant Detection (`packages/game-state/src/cardUtils.ts`)
- [x] `getAvailableInstants(state, playerIndex): SimAction[]`
- [x] `canRespondWith(card, triggeringAction, metadata?): boolean`

#### B4. Response Windows nel Engine (`packages/sim/src/engine.ts`)
- [x] In `processActionWindow`: dopo ogni CAST_SPELL, aprire finestra di risposta
- [x] In `executeCombatPhase`: finestra di risposta dopo dichiarazione attaccanti
- [x] Flag `ENABLE_STACK=true|false` (default false)

#### B5. Agent Response Decision (`packages/sim/src/learningAgent.ts`)
- [x] Implementare `decideResponse()`:
  - [x] Feature specifiche: `stackDepth`, `triggeringCmc`, `myInstantsCount`, `myLife`, `threatLevel`
  - [x] Pattern prefix: `response:`
  - [x] Epsilon-greedy su risposte

#### B6. Test Stack
- [x] Unit test `getAvailableInstants`
- [x] Unit test `canRespondWith`

---

### PARTE C: Curriculum di Training

#### C1. Curriculum Scheduler (`packages/sim/src/curriculum.ts`)
- [x] Creare il file `curriculum.ts`
- [x] Classe `CurriculumScheduler`:
  ```ts
  constructor(dbUrl?: string)
  ```

#### C2. Weakness Analysis
- [x] `analyzeWeaknesses(): Promise<WeaknessReport>`
  - [x] Query episodi recenti dal DB
  - [x] Calcola win-rate per fase di gioco (early/mid/late)
  - [x] Calcola win-rate per tipo di matchup archetype

#### C3. Scenario Construction
- [x] `buildTrainingScenario(weakness: Weakness): TrainingScenario`
  - [x] Se debolezza early game: deck AGGRO, focus early
  - [x] Se debolezza mid game: deck MIDRANGE, focus mid
  - [x] Se debolezza late game: deck CONTROL, focus late
  - [x] Se debolezza vs archetipo specifico: forza quel matchup

#### C4. Dynamic Epsilon
- [x] `computeEpsilon(playerIndex: number, phase: string): number`
  - [x] Epsilon piu alto nelle fasi deboli
  - [x] Epsilon piu basso nelle fasi forti
  - [x] Range: 0.05 (minimo) - 0.30 (massimo)
  - [x] Decay globale

#### C5. Deck Pool Rotation
- [x] `selectNextMatchup(availableArchetypes: string[]): Promise<string[]>`
  - [x] Prioritizza matchup meno allenati (meno episodi nel DB)
  - [x] Bilancia: 70% matchup deboli + 30% casuali
  - [x] Evita di ripetere lo stesso matchup piu di N volte consecutive

#### C6. Integration in Training (`packages/sim/src/run-batch.ts`)
- [x] Flag `USE_CURRICULUM=true|false` (default false)
- [x] Se true, ogni 10 episodi:
  - [x] `scheduler.analyzeWeaknesses()`
  - [x] `scheduler.buildTrainingScenario(topWeakness)`
  - [x] Applicare scenario: archetype overrides, epsilon
- [x] Ogni 50 episodi: log aree deboli

#### C7. Curriculum Status API (`apps/sim-service/sim-server.ts`)
- [x] Nuovo endpoint `GET /curriculum/status`

#### C8. Test Curriculum
- [x] Unit test `analyzeWeaknesses`
- [x] Unit test `buildTrainingScenario`
- [x] Unit test `computeEpsilon`
- [x] Unit test `selectNextMatchup`

---

## File Coinvolti

| File | Azione | Stato |
|------|--------|-------|
| `packages/sim/src/mulliganEvaluator.ts` | **NUOVO** — Evaluator mulligan | ✅ |
| `packages/sim/src/curriculum.ts` | **NUOVO** — Curriculum scheduler | ✅ |
| `packages/game-state/src/types.ts` | StackEntry, stack field, decideMulligan, decideResponse | ✅ |
| `packages/game-state/src/cardUtils.ts` | getAvailableInstants, canRespondWith | ✅ |
| `packages/sim/src/engine.ts` | Mulligan phase, ENABLE_STACK, passPriority, resolveStack | ✅ |
| `packages/sim/src/learningAgent.ts` | decideMulligan, decideResponse | ✅ |
| `packages/sim/src/run-batch.ts` | USE_CURRICULUM integration | ✅ |
| `apps/sim-service/sim-server.ts` | Endpoint `/curriculum/status` | ✅ |
| `packages/sim/src/__tests__/mulliganEvaluator.test.ts` | **NUOVO** — 12 tests | ✅ |
| `packages/sim/src/__tests__/stackInteraction.test.ts` | **NUOVO** — 6 tests | ✅ |
| `packages/sim/src/__tests__/curriculum.test.ts` | **NUOVO** — 13 tests | ✅ |

---

## Criteri di Completamento

### Mulligan
- [x] London Mulligan funzionante con fino a 3 mulligan
- [x] Agent prende decisioni mulligan ragionevoli (tiene mani con 2-4 terre)
- [x] chooseBottomCards seleziona carte sensate da mettere in fondo

### Stack
- [x] Priority system LIFO funzionante con `ENABLE_STACK=true`
- [x] Agent puo rispondere con instant a spell avversarie
- [x] `ENABLE_STACK=false` mantiene comportamento originale (default)

### Curriculum
- [x] Weakness analysis identifica aree deboli dal DB
- [x] Scenario construction genera scenari mirati
- [x] Epsilon dinamico adattato per fase
- [x] Matchup rotation copre tutti gli accoppiamenti
- [x] Endpoint `/curriculum/status` restituisce dati corretti

### Test
- [x] 31 nuovi test per Phase 6 passano
- [x] Nessuna regressione (132 test totali passano, 2 pre-esistenti Fase 2 confermati)
