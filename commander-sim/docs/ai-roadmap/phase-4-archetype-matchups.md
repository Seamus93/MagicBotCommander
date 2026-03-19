# Fase 4: Matchup Eterogenei + Policy per Archetipo

**Stato**: ✅ COMPLETATA
**Dipendenze**: Fasi 1-3
**Rischio**: Medio
**Stima**: 2 settimane

---

## Obiettivo

Superare il training mirror-match (stesso mazzo x4) e insegnare all'AI strategie specifiche per archetipo. Un mazzo aggro deve giocare diversamente da un mazzo control, e l'AI deve adattarsi all'archetipo avversario.

---

## Checklist

### 1. Matchup Mode nel Training (`packages/sim/src/run-batch.ts`)
- [x] Nuovo env var `MATCHUP_MODE`:
  - [x] `mirror` (default, comportamento attuale): stesso deck x 4
  - [x] `round-robin`: ruota assegnamenti deck tra episodi per coprire tutte le permutazioni
  - [x] `random`: assegna casualmente dai deck disponibili ogni episodio
- [x] Supporto `DECK_IDS=1,2,3,4` per assegnare deck specifici a ogni player
- [x] Quando meno di 4 deck disponibili: riempire con rotazione
- [x] Log ad inizio batch: quali deck/archetipi sono in gioco per ogni episodio

### 2. Archetype Policy Store (`packages/sim/src/archetypePolicy.ts`)
- [x] Creare il file `archetypePolicy.ts`
- [x] Classe `ArchetypePolicy` che wrappa `PatternStore`
- [x] Struttura chiave: `archetype::pattern::actionKey`
  - Es: `AGGRO::turn:early|lands:0-1|life:even::CAST_SPELL:Goblin Guide`
- [x] Metodo `observe(archetype, pattern, actionKey, reward)`: scrive nella partizione specifica
- [x] Metodo `bestAction(archetype, pattern)`:
  - [x] Step 1: cerca nella partizione archetype-specific
  - [x] Step 2: se visite insufficienti, cerca nella partizione globale (senza prefisso)
  - [x] Step 3: se ancora insufficiente, fuzzy match (Fase 1)
- [x] Metodo `fuzzyBestAction(archetype, pattern, maxDistance)`: come fuzzy ma filtrato per archetype
- [x] Metodo `exportPolicy()`: serializza includendo partizioni
- [x] Metodo `importPolicy(data)`: carica, compatibile con vecchio formato (tutto va in "global")

### 3. Archetype nel LearningAgent (`packages/sim/src/learningAgent.ts`)
- [x] Aggiungere `archetype?: string` a `LearningAgentOptions`
- [x] Se archetype è impostato:
  - [x] `scoreActions` usa `ArchetypePolicy.bestAction(archetype, pattern)`
  - [x] `observe` scrive in `ArchetypePolicy.observe(archetype, ...)`
- [x] Se archetype non impostato: comportamento attuale (partizione globale)
- [x] Nuova feature in `extractFeatures`:
  - [x] `myArchetype`: archetipo del proprio mazzo
  - [x] `opponentArchetypeMix`: distribuzione archetipi avversari (es: `"2aggro_1control"`)

### 4. Archetype Assignment nel Training (`packages/sim/src/run-batch.ts`)
- [x] Per ogni deck caricato, eseguire `matchArchetype(deck)` da `packages/rules/src/archetypeMatcher.ts`
- [x] Passare l'archetype risultante al costruttore dell'agent:
  ```ts
  new DecisionTreeAgent({ ...opts, archetype: matchedArchetype })
  ```
- [x] Log l'archetype assegnato per ogni player

### 5. Miglioramento Archetype Matcher (`packages/rules/src/archetypeMatcher.ts`)
- [x] Aggiungere scoring basato su mana curve shape:
  - [x] Aggro: concentrato su CMC 1-3
  - [x] Control: distribuito su CMC 3-7 con instant/sorcery alto
  - [x] Ramp: concentrato su CMC 1-2 (ramp spells) + CMC 6+ (payoffs)
  - [x] Combo: alto numero di tutor, draw, specifiche combo pieces
- [x] Scoring basato su creature-to-noncreature ratio:
  - [x] Aggro: >60% creature
  - [x] Control: <30% creature
  - [x] Midrange: 40-60% creature
- [x] Usare `oracleText` per keyword detection più accurata (counter, destroy, draw, ramp)
- [x] Restituire confidence score oltre al match

### 6. Matchup Statistics (Prisma)
- [x] Aggiungere modello `MatchupStats` in `prisma/schema.prisma`
- [x] Creare e applicare migration
- [x] In `run-batch.ts` a fine episodio: aggiornare `MatchupStats` per ogni coppia di archetipi
- [x] Funzione `upsertMatchupStats(arch1, arch2, winnerArch)` in `packages/db/src/db.ts`

### 7. Matchup Stats API (`apps/sim-service/sim-server.ts`)
- [x] Nuovo endpoint `GET /matchups`: restituisce matrice win-rate per coppia di archetipi
- [x] Formato risposta:
  ```json
  { "matchups": [{ "arch1": "AGGRO", "arch2": "CONTROL", "winRate1": 0.45, "total": 200 }] }
  ```

### 8. Aggiornamento AI Service (`apps/ai-service/ai-server.ts`)
- [x] Accettare `archetype` nel payload di `/decision`
- [x] Passare archetype al `DecisionTreeAgent` per lookup archetype-aware
- [x] Se archetype non fornito, auto-detect dal deckId (se disponibile)

### 9. Test
- [x] Unit test `ArchetypePolicy`:
  - [x] observe + bestAction nella stessa partizione
  - [x] fallback a partizione globale quando specifica ha poche visite
  - [x] importPolicy con vecchio formato → tutto in global
- [x] Unit test `matchArchetype` migliorato:
  - [x] Deck con 70% creature CMC 1-3 → AGGRO
  - [x] Deck con 25% creature e molti counter → CONTROL
  - [x] Deck con molta ramp CMC 1-2 e payoff CMC 6+ → RAMP
- [x] Unit test `MATCHUP_MODE`:
  - [x] `round-robin` con 2 deck: verifica alternanza
  - [x] `random` con 4 deck: distribuzione ragionevole su 100 episodi

---

## File Coinvolti

| File | Azione |
|------|--------|
| `packages/sim/src/archetypePolicy.ts` | **NUOVO** ✅ |
| `packages/sim/src/run-batch.ts` | MATCHUP_MODE, archetype assignment, matchup stats ✅ |
| `packages/sim/src/learningAgent.ts` | Opzione archetype, feature opponentArchetypeMix ✅ |
| `packages/rules/src/archetypeMatcher.ts` | Scoring avanzato (mana curve, ratio, oracleText) ✅ |
| `prisma/schema.prisma` | Modello MatchupStats ✅ |
| `packages/db/src/db.ts` | `upsertMatchupStats()` ✅ |
| `apps/sim-service/sim-server.ts` | Endpoint `/matchups` ✅ |
| `apps/ai-service/ai-server.ts` | Parametro archetype in `/decision` ✅ |
| `packages/sim/src/__tests__/archetypePolicy.test.ts` | **NUOVO** ✅ |
| `packages/rules/src/__tests__/archetypeMatcher.test.ts` | **NUOVO** ✅ |

---

## Criteri di Completamento

- [x] Training multi-deck funzionante in tutti e 3 i mode (mirror/round-robin/random)
- [x] Partizioni archetype-specific nel policy store con dati significativi
- [x] MatchupStats popolati dopo training cross-archetype
- [x] Endpoint `/matchups` restituisce dati corretti
- [x] Vecchio policy.json importabile (backward compatible)
- [x] Archetipi classificati con confidence ragionevole su deck di test
