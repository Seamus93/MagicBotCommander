# Fase 3: Combattimento Strategico + Opponent Modeling

**Stato**: ✅ COMPLETATA (2026-03-12)
**Dipendenze**: Fasi 1-2
**Rischio**: Medio
**Stima**: 2-3 settimane

---

## Obiettivo

Trasformare il combattimento da "attacca con tutto, blocca a caso" a decisioni strategiche: valutazione piani di attacco completi, detection alpha-strike, blocking ottimale, e scelta ragionata dell'avversario da attaccare nel multiplayer.

**Implementazione completata il 2026-03-12**: evaluator di combattimento, selection del target multiplayer, integrazione engine/agent, feature bucket dedicate, decisioni pattern-based di `LearningAgent` e `DecisionTreeAgent`, test unitari e test di integrazione su 100 episodi.

---

## Checklist

### 1. Combat Evaluator (`packages/sim/src/combatEvaluator.ts`)
- [x] Creare il file `combatEvaluator.ts`
- [x] Definire tipi:
  ```ts
  AttackPlan { attackers: string[], targetPlayer: number, expectedDamage: number, expectedLosses: number, score: number }
  BlockPlan { assignments: Map<string, string[]>, creaturesKilled: number, damagePrevented: number, blockersLost: number, score: number }
  ```

#### Attack Plan Generation
- [x] `generateAttackPlans(state, playerIndex, targetIndex): AttackPlan[]`
  - [x] Piano "all-in": tutte le creature pronte attaccano
  - [x] Piano "conservativo": attacca solo con creature che sopravvivono ai blocchi probabili
  - [x] Piano "alpha-strike": attacca solo se danno totale >= vita avversario
  - [x] Piano "selective": attacca con creature che hanno power > toughness massima dei blocker avversari
  - [x] Piano "hold": non attaccare (0 creature)
- [x] `scoreAttackPlan(plan, defenderState): number`
  - [x] Danno atteso - (valore creature perse * 2) + bonus lethal
  - [x] Penalita per rimanere senza blocker dopo l'attacco

#### Block Plan Generation
- [x] `generateBlockPlans(state, playerIndex, attackers): BlockPlan[]`
  - [x] Piano "trade up": blocca creature con power >= toughness del blocker
  - [x] Piano "chump block": blocca la creatura piu grossa per prevenire danno
  - [x] Piano "double block": due creature piccole bloccano una grossa (se somma power >= toughness)
  - [x] Piano "no block": lascia passare tutto (valido se danno < soglia vita)
  - [x] Piano "selective": blocca solo creature che il blocker puo uccidere
- [x] `scoreBlockPlan(plan, attackers, life): number`
  - [x] Creature avversarie uccise * 3 + danno prevenuto - blocker persi * 2

#### Alpha-Strike Detection
- [x] `canAlphaStrike(state, playerIndex, targetIndex): boolean`
  - [x] True se: somma power creature pronte > vita target E (target non ha blocker OPPURE evasion keywords)
- [x] `isLethalOnBoard(state, playerIndex, targetIndex): boolean`
  - [x] True se alpha-strike possibile anche considerando blocchi ottimali dell'avversario

### 2. Target Selection (`packages/sim/src/combatEvaluator.ts`)
- [x] `selectTarget(state, playerIndex, opponentIndices): number`
  - [x] Priorita 1: avversario con vita <= danno totale nostro (finish off)
  - [x] Priorita 2: avversario con board piu debole (meno blocker)
  - [x] Priorita 3: avversario con vita piu alta (attacca il leader - politica Commander)
  - [x] Tie-breaker: indice piu basso (deterministico)
- [x] `threatAssessment(state, opponentIndex): number`
  - [x] Score basato su: board power, creature count, cards in hand, life total
- [x] `politicalTarget(state, playerIndex, opponentIndices): number`
  - [x] In Commander e strategico attaccare il leader per non farlo scappare

### 3. Integrazione nel SimAgent Interface (`packages/game-state/src/types.ts`)
- [x] Aggiungere a `SimAgent`:
  ```ts
  decideTarget?(state: SimGameState, opponentIndices: number[]): number
  decideAttackPlan?(state: SimGameState, plans: AttackPlan[]): AttackPlan
  decideBlockPlan?(state: SimGameState, plans: BlockPlan[]): BlockPlan
  ```
- [x] Tutti i metodi opzionali per backward compatibility

### 4. Integrazione nel Engine (`packages/sim/src/engine.ts`)
- [x] Sostituire `findNextOpponent()` con `agent.decideTarget()` (fallback a findNextOpponent se non implementato)
- [x] In `executeCombatPhase`:
  - [x] Generare piani attacco via `combatEvaluator`
  - [x] Passare i piani all'agent per scelta
  - [x] Applicare il piano scelto
- [x] In fase di blocco:
  - [x] Generare piani blocco via `combatEvaluator`
  - [x] Passare i piani all'agent difensore
  - [x] Applicare il piano scelto

### 5. Agent Combat Decision (`packages/sim/src/learningAgent.ts`)
- [x] Implementare `decideTarget()`: usa pattern store con feature target-specific
- [x] Implementare `decideAttackPlan()`:
  - [x] Crea pattern con feature di combattimento: `myReadyPower`, `targetLife`, `targetBlockers`, `canLethal`
  - [x] Cerca nel pattern store il piano piu vicino a quelli gia visti
  - [x] Epsilon-greedy: esplora piani alternativi con probabilita epsilon
- [x] Implementare `decideBlockPlan()`:
  - [x] Feature: `incomingDamage`, `myLife`, `myBlockerCount`, `bestTradeAvailable`
  - [x] Stessa logica pattern-based
- [x] I pattern di combattimento hanno prefisso `combat_attack:` e `combat_block:` per non confondersi con quelli generici

### 6. Feature di Combattimento (`packages/sim/src/featureBuckets.ts`)
- [x] `bucketReadyPower(power)` -> bucket per 3
- [x] `bucketIncomingDamage(damage)` -> bucket per 5
- [x] `bucketBlockerCount(count)` -> `"0" | "1-2" | "3-4" | "5+"`
- [x] `bucketCanLethal(boolean)` -> `"yes" | "no"`
- [x] `bucketThreatLevel(score)` -> `"low" | "medium" | "high" | "critical"`

### 7. Aggiornamento DecisionTreeAgent (`packages/sim/src/decisionTreeAgent.ts`)
- [x] Ereditare le implementazioni combat da LearningAgent
- [x] Applicare confidence threshold anche ai piani di combattimento

### 8. Test
- [x] Unit test `generateAttackPlans`:
  - [x] Board 3/3 + 2/2 vs avversario con 4/4 blocker: piano conservativo non attacca con 2/2
  - [x] Board totale 10 power vs avversario 8 vita senza blocker: alpha-strike detected
  - [x] Board vuoto: solo piano "hold" generato
- [x] Unit test `generateBlockPlans`:
  - [x] 3/3 blocker vs 2/2 attaccante: "trade up" blocca e uccide
  - [x] 1/1 blocker vs 5/5 attaccante: "chump block" per prevenire 5 danno
  - [x] Due 2/3 vs 4/4: "double block" per uccidere il 4/4
- [x] Unit test `selectTarget`:
  - [x] Avversario con 3 vita e noi 5 power: target prioritario
  - [x] Tutti a 40 vita: attacca il leader (vita piu alta o board piu forte)
- [x] Unit test `canAlphaStrike` e `isLethalOnBoard`
- [x] Integration test: 100 episodi, verificare:
  - [x] Danno medio per turno di combattimento aumentato vs baseline
  - [x] Meno creature perse in blocchi sfavorevoli
  - [x] Avversari eliminati prima (game length ridotto)

---

## File Coinvolti

| File | Azione |
|------|--------|
| `packages/sim/src/combatEvaluator.ts` | **NUOVO** |
| `packages/sim/src/featureBuckets.ts` | Aggiunta bucket combattimento |
| `packages/game-state/src/types.ts` | Aggiunta metodi opzionali a SimAgent |
| `packages/sim/src/engine.ts` | Refactor executeCombatPhase, target selection |
| `packages/sim/src/learningAgent.ts` | Implementazione decideTarget, decideAttackPlan, decideBlockPlan |
| `packages/sim/src/decisionTreeAgent.ts` | Ereditare combat decision |

---

## Criteri di Completamento

- [x] Tutti i test unitari passano
- [x] Alpha-strike correttamente rilevato e sfruttato
- [x] Target selection sceglie avversari deboli/leader appropriatamente
- [x] Danno medio per turno di combattimento >= +20% vs Fase 2
- [x] Nessuna regressione su decisioni non-combat
- [x] Backward compatible: agent senza metodi combat usano fallback
