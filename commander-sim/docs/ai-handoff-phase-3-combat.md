# AI Handoff: Fase 3 Combat Strategy

## Scopo del documento

Questo file e un riassunto tecnico dettagliato pensato per future AI che dovranno leggere, mantenere o estendere la Fase 3 del simulatore: combattimento strategico, target selection multiplayer e decisioni combat pattern-based.

Il focus non e solo "cosa e stato fatto", ma soprattutto:

- quali file contano davvero
- come scorre il dato tra evaluator, engine e agent
- quali assunzioni sono implicite
- dove intervenire senza rompere backward compatibility
- quali limiti esistono oggi

---

## Executive summary

La Fase 3 ha introdotto un layer esplicito di pianificazione del combattimento.

Prima:

- il target combat veniva scelto da `findNextOpponent()`
- l'attacco era sostanzialmente "all-in" o per-creatura
- il blocco era assente o gestito con fallback semplici

Dopo:

- il motore genera piani di attacco e piani di blocco
- gli agent possono scegliere un target, un attack plan e un block plan
- `LearningAgent` usa pattern store dedicato anche per il combat
- `DecisionTreeAgent` applica soglia di confidenza anche alle scelte combat
- esiste un evaluator centralizzato per:
  - generare piani
  - stimarli
  - rilevare alpha strike / lethal on board
  - scegliere target in multiplayer

La compatibilita all'indietro e mantenuta:

- se un agent non implementa `decideTarget()`, il motore usa `findNextOpponent()`
- se un agent non implementa `decideAttackPlan()`, il motore prova `decideAttackers()`
- se un agent non implementa `decideBlockPlan()`, il motore prova `decideBlockers()`
- se nessun metodo combat e disponibile, il motore usa fallback deterministici

---

## File principali

### `packages/sim/src/combatEvaluator.ts`

E il cuore logico della Fase 3.

Responsabilita:

- definizione dei tipi `AttackPlan` e `BlockPlan`
- generazione dei piani di attacco
- generazione dei piani di blocco
- scoring dei piani
- detection di alpha strike e lethal on board
- target selection e political targeting

Funzioni principali:

- `generateAttackPlans(state, playerIndex, targetIndex)`
- `scoreAttackPlan(plan, defenderState)`
- `generateBlockPlans(state, playerIndex, attackers)`
- `scoreBlockPlan(plan, attackers, life)`
- `canAlphaStrike(state, playerIndex, targetIndex)`
- `isLethalOnBoard(state, playerIndex, targetIndex)`
- `selectTarget(state, playerIndex, opponentIndices)`
- `threatAssessment(state, opponentIndex)`
- `politicalTarget(state, playerIndex, opponentIndices)`

### `packages/sim/src/featureBuckets.ts`

Contiene i bucket dedicati alle feature di combattimento usate dagli agent:

- `bucketReadyPower`
- `bucketIncomingDamage`
- `bucketBlockerCount`
- `bucketCanLethal`
- `bucketThreatLevel`

### `packages/game-state/src/types.ts`

Ha esteso `SimAgent` con metodi opzionali:

- `decideTarget?`
- `decideAttackPlan?`
- `decideBlockPlan?`

Nota importante:

- `AttackPlan` e `BlockPlan` sono presenti anche qui come shape condivise per evitare dipendenze circolari tra package
- in `combatEvaluator.ts` esistono le stesse shape esportate dal modulo di simulazione
- TypeScript qui si appoggia alla compatibilita strutturale dei tipi

### `packages/sim/src/engine.ts`

E il punto in cui la logica combat viene realmente eseguita.

Responsabilita nuove:

- risolvere il target combat tramite agent o fallback
- generare attack plans
- chiedere all'agent quale piano scegliere
- normalizzare la scelta per evitare input invalidi
- generare block plans
- chiedere al difensore quale piano usare
- convertire `BlockPlan.assignments` nel formato legacy `BlockAssignment[]`

### `packages/sim/src/learningAgent.ts`

Ha introdotto il combat decision layer pattern-based:

- `decideTarget()`
- `decideAttackPlan()`
- `decideBlockPlan()`

Punti chiave:

- usa pattern con prefissi separati:
  - `combat_target:`
  - `combat_attack:`
  - `combat_block:`
- usa epsilon-greedy anche sulle decisioni combat
- combina score "learned" del pattern store con bias euristico del piano

### `packages/sim/src/decisionTreeAgent.ts`

Non reinventa la logica combat, ma la eredita da `LearningAgent` e la rende deterministica quando:

- ci sono abbastanza visite
- la confidence supera la soglia

Questo vale ora sia per:

- azioni generiche
- target selection
- attack plan
- block plan

### `packages/sim/src/__tests__/combatEvaluator.test.ts`

Suite dedicata alla Fase 3.

Copre:

- unit test sui piani di attacco
- unit test sui piani di blocco
- target selection
- alpha strike / lethal on board
- integration test su 100 episodi

---

## Data model introdotto

### `AttackPlan`

Shape:

```ts
interface AttackPlan {
  attackers: string[];
  targetPlayer: number;
  expectedDamage: number;
  expectedLosses: number;
  score: number;
}
```

Significato dei campi:

- `attackers`: lista di `CreaturePermanent.id`
- `targetPlayer`: indice del difensore previsto
- `expectedDamage`: danno stimato al giocatore dopo blocchi ottimali stimati
- `expectedLosses`: numero atteso di attaccanti persi
- `score`: valutazione sintetica del piano

### `BlockPlan`

Shape:

```ts
interface BlockPlan {
  assignments: Map<string, string[]>;
  creaturesKilled: number;
  damagePrevented: number;
  blockersLost: number;
  score: number;
}
```

Interpretazione critica:

- la chiave della `Map` e `attackerId`
- il valore e l'array dei `blockerId` assegnati a quell'attaccante

Questa scelta e importante perche:

- modella in modo naturale il double block
- consente una conversione pulita verso il formato legacy `BlockAssignment[]`

---

## Flusso end-to-end del combattimento

### 1. Inizio combat nel motore

Nel turno del giocatore attivo, `engine.ts` entra nella fase combat.

Passi:

1. calcola gli avversari vivi
2. prova `agent.decideTarget(state, opponentIndices)`
3. se assente o invalido, fallback a `findNextOpponent()`

### 2. Generazione piani di attacco

`executeCombatPhase()` chiama:

```ts
generateAttackPlans(state, attackerIndex, defenderIndex)
```

I piani generati oggi includono:

- all-in
- conservative
- alpha-strike
- selective
- hold

Ogni piano viene:

- simulato contro il miglior piano di blocco disponibile del difensore
- valutato
- ordinato per score

### 3. Scelta del piano di attacco

Il motore prova in ordine:

1. `agent.decideAttackPlan(state, plans)`
2. `agent.decideAttackers(state, attackers)` come fallback legacy
3. piano migliore generato come fallback finale

La scelta viene normalizzata:

- target valido
- attacker ids validi
- niente creature non disponibili

### 4. Generazione piani di blocco

Se il difensore ha blocker disponibili:

```ts
generateBlockPlans(state, defenderIndex, attackerIds)
```

I piani generati oggi includono:

- trade up
- chump block
- double block
- no block
- selective

### 5. Scelta del piano di blocco

Il motore prova in ordine:

1. `agent.decideBlockPlan(state, plans)`
2. `agent.decideBlockers(state, attackers, blockers)` come fallback legacy
3. miglior piano disponibile / piano vuoto

Poi converte il `BlockPlan` in `BlockAssignment[]` e chiama il resolver combat legacy.

---

## Euristiche attuali del combat evaluator

### Attack plans

La generazione dei piani non cerca tutte le combinazioni possibili; usa un set ristretto e intenzionale di piani ad alto valore.

Questo e un compromesso voluto:

- evita esplosione combinatoria
- mantiene il motore deterministico e testabile
- lascia agli agent un insieme piccolo ma significativo di alternative

### Scoring attacco

Formula attuale:

- `expectedDamage`
- meno `expectedLosses * 2`
- piu bonus lethal
- meno penalita se si attacca con tutti i blocker-ready e si resta scoperti

Interpretazione:

- danno immediato conta
- perdere board conta molto
- lethal ha priorita alta
- all-in senza retroguardia e penalizzato

### Block plans

Lo scoring blocco e:

- `creaturesKilled * 3 + damagePrevented - blockersLost * 2`
- con bonus extra se il piano previene una situazione lethal

Interpretazione:

- uccidere attaccanti vale molto
- prevenire danno resta importante
- perdere blocker in modo inefficiente viene punito

### Alpha strike / lethal

`canAlphaStrike`:

- usa potenza totale delle creature pronte
- richiede board power superiore alla vita target
- ritorna true subito se il difensore non ha blocker
- altrimenti controlla una detection testuale di keyword evasive nei metadata

`isLethalOnBoard`:

- considera i blocchi ottimali del difensore
- usa il miglior `BlockPlan` disponibile come proxy di difesa ottimale

---

## Target selection multiplayer

La selezione target oggi e una miscela di:

- kill pressure
- board weakness
- politica Commander
- tie-break deterministico

Ordine logico:

1. se un avversario e "finishable", quel criterio domina
2. se tutti hanno la stessa vita, prevale la logica politica (`politicalTarget`)
3. altrimenti si confrontano board debolezza, leadership e indice

`threatAssessment()` usa:

- board power
- numero creature
- size mano
- life total

Nota:

- il comportamento "a vite uguali attacca il leader" e esplicitamente coperto dai test
- questo significa che la politica Commander qui ha precedenza in quel caso specifico

---

## LearningAgent: come decide il combat

### Obiettivo

Non usare solo euristiche statiche, ma fare retrieval nel `PatternStore` anche per:

- target
- attack plans
- block plans

### Pattern prefixes

Separazione attuale:

- `combat_target:`
- `combat_attack:`
- `combat_block:`

Questo evita collisioni concettuali con i pattern delle azioni generiche.

### Feature usate per il target

Per `decideTarget()` vengono costruite feature target-specifiche come:

- `myReadyPower`
- `targetLife`
- `targetBlockers`
- `targetThreat`
- `canLethal`

### Feature usate per l'attacco

Per `decideAttackPlan()`:

- `myReadyPower`
- `targetLife`
- `targetBlockers`
- `canLethal`

### Feature usate per il blocco

Per `decideBlockPlan()`:

- `incomingDamage`
- `myLife`
- `myBlockerCount`
- `bestTradeAvailable`

### Come viene calcolato lo score

Per le decisioni combat:

1. si cerca un record esatto nel `PatternStore`
2. se non e abbastanza affidabile, si usa fuzzy matching
3. si somma un bias euristico derivato dallo score del piano o del target

Questo e importante:

- il sistema non parte "cieco" da zero
- ma continua comunque a poter apprendere e sovrascrivere l'euristica nel tempo

### Epsilon-greedy

`LearningAgent` usa epsilon-greedy anche sulle decisioni combat:

- con probabilita `epsilon` esplora
- altrimenti sceglie lo score migliore

---

## DecisionTreeAgent: comportamento deterministico

`DecisionTreeAgent` ora applica lo stesso schema gia usato per le azioni generiche anche al combat.

Condizioni per usare la scelta deterministica:

- esiste `record`
- `record.visits >= minVisits`
- `avgScore >= confidenceThreshold`

Se queste condizioni non sono soddisfatte:

- fallback a `LearningAgent`

Effetto pratico:

- quando il pattern store ha abbastanza dati, il combat smette di essere esplorativo
- quando i dati non bastano, continua a usare logica pattern-based + euristica

---

## Backward compatibility

Questa e una delle invarianti piu importanti della Fase 3.

### Cosa non va rotto

Agenti legacy che implementano solo:

- `decideAction()`
- opzionalmente `decideAttackers()`
- opzionalmente `decideBlockers()`

devono continuare a funzionare.

### Come viene garantita

In `engine.ts`:

- target:
  - nuovo metodo `decideTarget()`
  - fallback a `findNextOpponent()`

- attacco:
  - nuovo metodo `decideAttackPlan()`
  - fallback a `decideAttackers()`
  - fallback finale al miglior piano disponibile

- blocco:
  - nuovo metodo `decideBlockPlan()`
  - fallback a `decideBlockers()`
  - fallback finale al miglior piano / piano vuoto

### Hardening gia presente

Le scelte dell'agent vengono normalizzate prima di essere applicate:

- target non valido -> fallback deterministico
- attacker ids non validi -> filtrati
- blocker ids duplicati -> scartati
- assignment verso attacker non dichiarati -> scartato

Questo e il principale strato di hardening della Fase 3.

---

## Test coverage

La suite `packages/sim/src/__tests__/combatEvaluator.test.ts` copre:

### Unit test

- piano conservativo con 3/3 + 2/2 vs 4/4
- alpha strike con 10 power vs 8 life
- board vuoto -> solo hold
- trade up 3/3 vs 2/2
- chump block 1/1 vs 5/5
- double block due 2/3 vs 4/4
- selectTarget con finish-off
- selectTarget con leader politico
- `canAlphaStrike`
- `isLethalOnBoard`

### Integration test

100 episodi con confronto tra:

- baseline combat agent
- strategic combat agent

Metriche verificate:

- aumento del danno medio per combat turn
- riduzione delle creature perse in blocchi sfavorevoli
- riduzione della game length media

Comando usato:

```bash
npx vitest run packages/sim/src/__tests__/combatEvaluator.test.ts
```

Nota utile per future AI:

- in un run piu ampio erano presenti failure preesistenti in `rewardShaper.test.ts`
- non fanno parte della Fase 3
- non sono state corrette in questa implementazione

---

## Limiti attuali

Questa sezione e importante: il sistema combat e migliorato, ma non e un rules engine completo.

### 1. Search space limitato

`generateAttackPlans()` e `generateBlockPlans()` non enumerano tutte le combinazioni possibili.

Conseguenza:

- il sistema e rapido e stabile
- ma puo perdere piani non ovvi

### 2. Combat rules semplificate

Il resolver combat corrente non gestisce in modo completo meccaniche avanzate come:

- first strike
- double strike
- trample
- menace come restrizione di blocco reale
- deathtouch
- lifelink
- damage assignment avanzata

Per ora la Fase 3 lavora sulle regole semplificate gia esistenti nel progetto.

### 3. Evasion detection testuale

`canAlphaStrike()` controlla alcune keyword evasive via testo metadata.

Questo approccio e:

- sufficiente per heuristic detection
- non sufficiente per una modellazione completa di tutte le keyword MTG

### 4. `isLethalOnBoard()` usa "miglior block plan disponibile"

Non fa minimax completo su tutte le configurazioni possibili.

Conseguenza:

- buona proxy pratica
- non prova matematica assoluta di lethal in tutti i casi complessi

### 5. Score euristico + learned

Le decisioni combat del `LearningAgent` sommano:

- score da pattern store
- bias euristico

Questo e utile in bootstrap, ma significa che:

- il modello non e puramente learned
- cambiamenti ai pesi euristici possono alterare molto il comportamento iniziale

---

## Invarianti da rispettare in estensioni future

Se una future AI modifica questa area, dovrebbe preservare queste proprieta:

1. `SimAgent` deve restare backward compatible.
2. Il motore deve continuare a normalizzare input invalidi provenienti dagli agent.
3. `AttackPlan` e `BlockPlan` devono restare serializzabili e facili da confrontare.
4. I pattern combat devono restare separati da quelli generici.
5. I test di integrazione devono restare deterministicamente ripetibili.
6. Qualsiasi aumento di complessita nel search space va introdotto con cautela.

---

## Dove intervenire per estendere il sistema

### Se vuoi aggiungere nuovi tipi di piano

Tocca:

- `packages/sim/src/combatEvaluator.ts`

In particolare:

- `generateAttackPlans()`
- `generateBlockPlans()`
- scoring relativo
- eventuali helper di simulazione

### Se vuoi cambiare il modo in cui gli agent apprendono il combat

Tocca:

- `packages/sim/src/learningAgent.ts`
- `packages/sim/src/featureBuckets.ts`

In particolare:

- feature bucket
- prefissi pattern
- pesi euristici
- soglie o logica epsilon-greedy

### Se vuoi rendere il combat piu deterministico su store consolidato

Tocca:

- `packages/sim/src/decisionTreeAgent.ts`

### Se vuoi cambiare la fallback compatibility

Tocca:

- `packages/sim/src/engine.ts`

Qui serve cautela:

- e il punto piu facile da rompere
- e anche il punto dove la compatibilita legacy e concretamente garantita

### Se vuoi supportare meccaniche MTG piu fedeli

Tocca prima:

- `packages/rules/src/combat/combat.ts`

e solo dopo:

- `packages/sim/src/combatEvaluator.ts`

Ordine corretto:

1. aggiornare il resolver reale
2. aggiornare la simulazione euristica
3. aggiornare i test

---

## Safe next steps per future AI

Le estensioni piu sicure e ad alto valore sono:

### 1. Arricchire i piani senza esplosione combinatoria

Esempi:

- split attack su subset piu intelligenti
- double block mirati su piu target
- attack plans dipendenti dal numero di blocker lasciati indietro

### 2. Rendere il targeting piu contestuale

Esempi:

- includere threat storico
- includere recent damage dealt
- includere probabilita di lethal al turno successivo

### 3. Espandere i metadata combat

Esempi:

- keyword reali nel `CreaturePermanent`
- non solo parsing testuale da metadata

### 4. Collegare meglio reward shaping e combat

Esempi:

- reward specifici per good attacks
- reward per efficient blocks
- penalty per alpha strike mancati

### 5. Migliorare la spiegabilita per debugging

Esempi:

- label esplicita del piano scelto
- reason codes per target selection
- logging opzionale dei top-3 piani

---

## TL;DR operativo

Se una future AI ha poco tempo, deve ricordare solo questo:

- il combat non e piu deciso direttamente nel motore, ma via piani
- `combatEvaluator.ts` e il file principale
- `engine.ts` orchestra e protegge con fallback + normalizzazione
- `LearningAgent` usa pattern store anche per target/attack/block
- `DecisionTreeAgent` rende il combat deterministicamente guidato dai dati
- i test della Fase 3 vivono in `combatEvaluator.test.ts`
- se estendi le regole reali del combattimento, aggiorna prima `packages/rules/src/combat/combat.ts`
