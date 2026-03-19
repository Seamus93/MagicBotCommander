# Fase 2: Reward Shaping e Credit Assignment Temporale

**Stato**: ✅ COMPLETATA (2026-03-12)
**Dipendenze**: Fase 1
**Rischio**: Basso

---

## Obiettivo

Sostituire il reward uniforme (+1/-1 applicato identicamente a tutte le ~80 decisioni di una partita) con segnali di apprendimento precisi: reward intermedi per azioni strategiche e sconto temporale per dare piu peso alle decisioni tardive.

---

## Checklist

### 1. Reward Shaper (`packages/sim/src/rewardShaper.ts`)
- [x] Creare il file `rewardShaper.ts`
- [x] Definire interfaccia `StateSnapshot`:
  ```ts
  { lifeTotals: number[], creatureCounts: number[], landCounts: number[], handSizes: number[] }
  ```
- [x] `captureSnapshot(state: SimGameState): StateSnapshot`
  - Estrae i dati minimi necessari per il diff
- [x] `shapeReward(prev: StateSnapshot, action: SimAction, next: StateSnapshot, playerIndex: number): number`
  - [x] +0.05: land drop quando si hanno spell in mano (handSize > 1 → on curve proxy)
  - [x] +0.03: cast creature quando si e dietro sul board (creature proprie < media avversari)
  - [x] +0.15: eliminazione di un avversario (vita avversario passa da >0 a <=0)
  - [x] -0.03: perdita di creatura in combattimento senza uccidere l'attaccante (bad trade)
  - [x] +0.02: cast spell che riduce vantaggio board avversario (removal)
  - [x] -0.01: PASS_TURN con mana non speso e spell giocabili in mano (mana waste)
- [x] `discountRewards(stepRewards: number[], terminalReward: number, gamma: number): number[]`
  - Formula: `reward[i] = stepReward[i] + terminalReward * gamma^(N-1-i)`
  - Le decisioni tardive ricevono piu credito dal risultato finale
- [x] Parametri configurabili via env:
  - [x] `REWARD_GAMMA` (default 0.95)
  - [x] `REWARD_SHAPING` (default true, false per disabilitare)

### 2. Cattura State Diff nel Engine (`packages/sim/src/engine.ts`)
- [x] Prima di `applyAction`: chiamare `captureSnapshot(state)` → `prevSnapshot`
- [x] Dopo `applyAction`: chiamare `captureSnapshot(state)` → `nextSnapshot`
- [x] Salvare `{ prevSnapshot, nextSnapshot, action }` nella array parallela `snapshotEntries`
- [x] Snapshot leggero (no deep clone dello stato completo)

### 3. Finalize con Reward Shaping (`packages/sim/src/learningAgent.ts`)
- [x] Nuovo metodo `finalizeEpisodeWithRewards(rewards: number[]): void`
  - Applica il reward specifico per ogni step alle osservazioni nel pattern store
- [x] `finalizeEpisode(reward: number)` invariato per path non-shaping

### 4. Integrazione nel Game Loop (`packages/sim/src/engine.ts`)
- [x] In `simulateGame()`: raccogliere gli snapshot per ogni azione eseguita (`snapshotEntries`)
- [x] A fine partita, per ogni agente:
  - [x] Calcolare `stepRewards[]` via `shapeReward` (filtrati per player)
  - [x] Applicare `discountRewards(stepRewards, terminalReward, gamma)`
  - [x] Passare al `finalizeEpisodeWithRewards` (se `REWARD_SHAPING=true`)
  - [x] Fallback a `finalizeEpisode` (se `REWARD_SHAPING=false`)
- [x] Loggare reward totale shaped vs reward terminale per debug
- [x] Attach `shapedReward` a ogni `history` entry per export dataset

### 5. Aggiornamento Dataset (`packages/sim/src/run-batch.ts`)
- [x] Includere `shapedReward` nel dataset.jsonl per ogni step

### 6. Aggiornamento Prisma Schema
- [x] Aggiungere campo `shapedReward Float?` al modello `EpisodeStep`
- [ ] Generare e applicare migration (richiede DATABASE_URL configurato)

### 7. Test
- [x] File: `packages/sim/src/__tests__/rewardShaper.test.ts` (vitest)
- [x] Unit test `captureSnapshot`: estrazione corretta da stato complesso
- [x] Unit test `shapeReward`:
  - [x] Eliminazione avversario → +0.15
  - [x] Land on curve → +0.05
  - [x] Bad trade (creatura persa senza kill) → -0.03
  - [x] Mana waste (pass con mano e terre) → -0.01
  - [x] Removal che riduce board avversario → ≥ +0.02
  - [x] Nessun cambiamento rilevante → ~0
- [x] Unit test `discountRewards`:
  - [x] Ultimo step riceve quasi tutto il terminal reward
  - [x] Primo step riceve quasi niente
  - [x] Con gamma=1.0 tutti gli step ricevono lo stesso terminal reward
  - [x] Con gamma=0.0 solo l'ultimo step riceve terminal reward
  - [x] Step rewards inclusi nel totale
- [x] Script di test aggiunto: `npm test` → vitest run

---

## File Coinvolti

| File | Azione |
|------|--------|
| `packages/sim/src/rewardShaper.ts` | ✅ NUOVO |
| `packages/sim/src/learningAgent.ts` | ✅ `finalizeEpisodeWithRewards` aggiunto |
| `packages/sim/src/engine.ts` | ✅ Snapshot collection + shaped finalize |
| `packages/game-state/src/types.ts` | ✅ `shapedReward?` in `SimulationHistoryEntry` |
| `packages/sim/src/run-batch.ts` | ✅ `shapedReward` in dataset.jsonl |
| `packages/db/src/db.ts` | ✅ `shapedReward` in `persistEpisode` |
| `prisma/schema.prisma` | ✅ Campo `shapedReward Float?` su EpisodeStep |
| `packages/sim/src/__tests__/rewardShaper.test.ts` | ✅ NUOVO — unit tests |
| `package.json` | ✅ `vitest` aggiunto, script `test` e `test:watch` |

---

## Note Implementative

- Formula discount: `reward[i] = stepReward[i] + terminalReward * gamma^(N-1-i)` (ultimo step = gamma^0 = 1.0)
- `snapshotEntries[]` è parallelo a `history[]` — stesso indice → stessa azione
- Per il combat, prevSnapshot è catturato prima di `resolveCombat`, nextSnapshot dopo; entrambe le entries (DECLARE_ATTACKERS e DECLARE_BLOCKERS) usano la stessa coppia snapshot, poi patchata
- Migration Prisma da eseguire manualmente con `DATABASE_URL` configurato: `npx prisma migrate dev --name add-shaped-reward`
