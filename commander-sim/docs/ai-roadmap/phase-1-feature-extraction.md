# Fase 1: Feature Extraction Avanzata + Fuzzy Pattern Matching

**Stato**: Non iniziata
**Dipendenze**: Nessuna
**Rischio**: Basso
**Stima**: 1-2 settimane

---

## Obiettivo

Risolvere il problema fondamentale di generalizzazione: stati quasi identici (35 vita vs 36 vita) producono pattern diversi e non condividono apprendimento. Arricchire la percezione dell'agente da 8 feature raw a ~18 feature bucketizzate.

---

## Checklist

### 1. Feature Buckets (`packages/sim/src/featureBuckets.ts`)
- [ ] Creare il file `featureBuckets.ts`
- [ ] `bucketCardsInHand(count)` → `"0" | "1-2" | "3-4" | "5+"`
- [ ] `bucketLandsInPlay(count)` → bucket per 2 (0-1, 2-3, 4-5, 6-7, 8+)
- [ ] `bucketTurn(turn)` → `"early"` (1-3) | `"mid"` (4-7) | `"late"` (8+)
- [ ] `bucketLifeDelta(delta)` → `"vbehind"` (<-15) | `"behind"` (<-5) | `"even"` | `"ahead"` (>5) | `"vahead"` (>15)
- [ ] `bucketPower(totalPower)` → bucket per 3 (0, 1-3, 4-6, 7-9, 10+)
- [ ] `bucketManaAvailable(lands, artifacts)` → bucket per 2
- [ ] `bucketSpellsPlayable(count)` → `"0" | "1" | "2" | "3+"`
- [ ] `bucketLandsInHand(count)` → `"0" | "1" | "2+"`
- [ ] `bucketOpponentsAlive(count)` → `"1" | "2" | "3"`
- [ ] Esportare tutte le funzioni + tipi

### 2. Extract Features Avanzato (`packages/sim/src/learningAgent.ts`)
- [ ] Importare funzioni da `featureBuckets.ts`
- [ ] Sostituire `extractFeatures()` con nuova versione:
  - [ ] `creatureAdvantage`: proprie creature - media creature avversari (bucket)
  - [ ] `totalBoardPower`: somma power creature proprie (bucket)
  - [ ] `totalBoardToughness`: somma toughness creature proprie (bucket)
  - [ ] `manaAvailable`: terre untapped + artifact mana (bucket)
  - [ ] `cardsInHand`: carte in mano (bucket)
  - [ ] `landsInPlay`: terre in gioco (bucket)
  - [ ] `turnBucket`: fase del gioco (early/mid/late)
  - [ ] `lifeDelta`: propria vita - vita miglior avversario (bucket)
  - [ ] `opponentMaxPower`: power totale del board avversario piu forte (bucket)
  - [ ] `opponentsAlive`: quanti avversari ancora in vita
  - [ ] `spellsPlayable`: spell in mano giocabili con mana attuale (bucket)
  - [ ] `landsInHand`: terre in mano (bucket)
  - [ ] `gamePhase`: main1/combat/main2 come categorico
- [ ] Mantenere backward compatibility: vecchio `extractFeatures` rinominato `extractFeaturesLegacy`

### 3. Fuzzy Pattern Matching (`packages/sim/src/patterns.ts`)
- [ ] Aggiungere metodo `parsePattern(pattern: string): Map<string, string>`
- [ ] Aggiungere metodo `patternDistance(a: string, b: string): number`
  - Conta quanti bucket differiscono tra due pattern
- [ ] Aggiungere metodo `fuzzyGet(pattern: string, actionKey: string, maxDistance: number): { record: PatternRecord, distance: number }[]`
  - Cerca tutti i pattern entro `maxDistance` bucket di differenza
  - Restituisce i record trovati con la distanza
- [ ] Aggiungere metodo `fuzzyBestAction(pattern: string, maxDistance: number): { actionKey: string, weightedScore: number } | null`
  - Aggrega i match fuzzy pesandoli per distanza inversa: `weight = 1 / (1 + distance)`
  - Restituisce l'azione con weighted score piu alto
- [ ] Mantenere inalterati `get()`, `observe()`, `bestAction()` per backward compatibility

### 4. Integrazione nell'Agent (`packages/sim/src/learningAgent.ts`)
- [ ] Modificare `scoreActions()` per usare `fuzzyBestAction` quando exact match ha visite insufficienti
- [ ] Ordine di lookup: exact match (visite >= threshold) → fuzzy match → esplorazione
- [ ] Parametro `FUZZY_MATCH_DISTANCE` (env, default 2)
- [ ] Loggare la source della decisione: `"exact"`, `"fuzzy"`, `"explore"`

### 5. Aggiornamento DecisionTreeAgent (`packages/sim/src/decisionTreeAgent.ts`)
- [ ] Adattare `pickDeterministic()` per usare le nuove feature
- [ ] Fallback a fuzzy match quando confidence sotto threshold

### 6. Aggiornamento AiDecisionAgent (`packages/sim/src/aiDecisionAgent.ts`)
- [ ] Passare le nuove feature nel payload verso l'endpoint esterno
- [ ] Aggiornare il context con i bucket leggibili

### 7. Script di Migrazione (opzionale)
- [ ] Script `scripts/migrate-policy.ts` che ri-bucketizza i vecchi pattern di `policy.json`
- [ ] Modalita dry-run per preview
- [ ] Backup automatico del vecchio policy.json

### 8. Test
- [ ] Unit test `featureBuckets.ts`: ogni funzione con edge cases
- [ ] Unit test `fuzzyGet`: pattern identico (distance 0), simile (distance 1-2), lontano (distance > max)
- [ ] Unit test `fuzzyBestAction`: verifica pesatura corretta
- [ ] Integration test: eseguire 50 episodi di training, verificare che pattern store cresca ~80-90% meno del vecchio sistema
- [ ] Regression test: caricare vecchio policy.json, verificare che exact match funzioni ancora
- [ ] Benchmark: confronto win-rate convergenza vecchio vs nuovo su 200 episodi

---

## File Coinvolti

| File | Azione |
|------|--------|
| `packages/sim/src/featureBuckets.ts` | **NUOVO** |
| `packages/sim/src/learningAgent.ts` | Modifica `extractFeatures`, `scoreActions` |
| `packages/sim/src/patterns.ts` | Aggiunta `fuzzyGet`, `fuzzyBestAction`, `parsePattern`, `patternDistance` |
| `packages/sim/src/decisionTreeAgent.ts` | Adattamento a nuove feature |
| `packages/sim/src/aiDecisionAgent.ts` | Aggiornamento payload |
| `scripts/migrate-policy.ts` | **NUOVO** (opzionale) |

---

## Criteri di Completamento

- [ ] Tutti i test unitari passano
- [ ] Training di 50 episodi completa senza errori
- [ ] Pattern store usa ~80-90% meno chiavi uniche rispetto al sistema precedente
- [ ] Vecchio policy.json caricabile senza errori
- [ ] Decision source loggata correttamente (exact/fuzzy/explore)
