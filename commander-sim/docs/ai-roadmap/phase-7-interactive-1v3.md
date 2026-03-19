# Phase 7 — Interactive 1 Human vs 3 AI Game Mode

## Context

L'engine attuale (`simulateGame`) gira a completamento senza pausa. La UI (`MoxfieldUI`) è goldfish single-player. Serve un game server persistente che gestisca una partita interattiva 4 giocatori con layout a tavolo (Sud=umano, Nord/Est/Ovest=AI).

**Approccio scelto: HumanAgent** — l'engine è già full async, ogni `agent.decideAction()` supporta Promise. Un `HumanAgent` che ritorna una Promise in attesa del player input blocca naturalmente il loop senza toccare il game loop esistente.

---

## Fase 1: HumanAgent + Engine Hooks (backend foundation)

### 1.1 — `HumanAgent.ts` (nuovo file)
**Path:** `apps/game-server/agents/HumanAgent.ts`

Implementa `SimAgent` interface. Ogni metodo (`decideAction`, `decideAttackPlan`, `decideBlockPlan`, `decideMulligan`, `decideTarget`, `decideResponse`) crea una Promise con resolver salvato. Chiama `onWaiting(type, context)` callback per notificare la sessione. `submitDecision(decision)` risolve la Promise e sblocca l'engine.

### 1.2 — `onStateChange` callback in engine
**File da modificare:** `packages/game-state/src/types.ts`
- Aggiungere a `SimulationOptions`:
  ```typescript
  onStateChange?: (state: SimGameState, event: GameEvent) => void;
  ```
- Nuovo tipo `GameEvent`:
  ```typescript
  type GameEvent =
    | { type: "action_applied"; player: number; action: SimAction }
    | { type: "combat_resolved"; attacker: number; defender: number }
    | { type: "draw"; player: number }
    | { type: "turn_start"; turn: number; player: number }
    | { type: "phase_change"; phase: string; step: string }
    | { type: "mulligan_done"; player: number; mulliganCount: number }
    | { type: "game_over"; winner: number | null }
  ```

**File da modificare:** `packages/sim/src/engine.ts`
- ~10 inserzioni di `options.onStateChange?.(cloneState(state), event)` dopo: `applyAction`, `resolveCombat`, `drawCard`, inizio turno, cambio fase, fine partita
- Esportare `createInitialState`

### 1.3 — Deck loading per AI
Riusare `buildDeckMetadata` da `packages/sim/src/cardMetadata.ts` e i deck da DB via `packages/db/src/db.ts` → `getDeckById()`.

---

## Fase 2: Game Session Server

### 2.1 — Struttura file
```
apps/game-server/
  game-server.ts              -- Express + ws server, porta 5300
  session/
    GameSession.ts            -- 1 partita: engine coroutine, HumanAgent, stato
    SessionManager.ts         -- Map<sessionId, GameSession>, lifecycle, timeout 10min
  agents/
    HumanAgent.ts
  state/
    stateSerializer.ts        -- Filtra stato per viewer (nasconde mani avversari)
  package.json
```

### 2.2 — `GameSession.ts`
- `create(humanDeck, aiDecks)` → costruisce `[HumanAgent, DecisionTreeAgent, DecisionTreeAgent, DecisionTreeAgent]`
- Lancia `simulateGame(agents, { onStateChange, playerDecks, ... })` come coroutine async fire-and-forget
- Ascolta `HumanAgent.onWaiting` → invia `waiting_for_human` via WebSocket
- Ascolta `onStateChange` → invia `state_update` via WebSocket
- Timeout/concede se umano disconnesso >10min

### 2.3 — API Endpoints

| Method | Path | Body / Risposta |
|--------|------|-----------------|
| `POST` | `/game/create` | `{ humanDeckId }` → `{ sessionId }` |
| `GET` | `/game/:id/state` | → `FilteredGameState` (polling fallback) |
| `POST` | `/game/:id/action` | `{ decisionType, decision }` → `{ ok }` |
| `POST` | `/game/:id/concede` | → `{ ok }` |

### 2.4 — WebSocket (`ws://host/game/:id`)

**Server → Client:**
- `state_update` — stato filtrato dopo ogni mutazione
- `waiting_for_human` — tipo decisione + contesto (azioni disponibili, piani attacco/blocco, mano per mulligan)
- `game_over` — vincitore + motivo
- `game_log` — messaggi log engine

**Client → Server:**
- `submit_action` — `{ action: SimAction }`
- `submit_attack_plan` — `{ plan: AttackPlan }`
- `submit_block_plan` — `{ plan: BlockPlan }`
- `submit_mulligan` — `{ keep, bottomCards? }`
- `submit_target` — `{ targetIndex }`
- `submit_response` — `{ action: SimAction | null }`
- `concede`

### 2.5 — State Serializer
**Path:** `apps/game-server/state/stateSerializer.ts`

`serializeForViewer(state, viewerIndex=0)` → `FilteredGameState`:
- Player 0 (umano): mano visibile, tutte le zone
- Player 1-3 (AI): `handCount` invece di `hand`, `libraryCount` invece di `library`, battlefield/graveyard/exile/commander visibili

```typescript
interface FilteredPlayerState {
  index: number;
  position: "SOUTH" | "NORTH" | "EAST" | "WEST";  // 0=S, 1=N, 2=E, 3=W
  life: number;
  commander: string;
  battlefield: string[];
  creatures: CreaturePermanent[];
  graveyard: string[];
  exile: string[];
  libraryCount: number;
  handCount: number;
  hand?: string[];       // solo per viewerIndex
  isHuman: boolean;
}
```

---

## Fase 3: UI — Layout Tavolo 4 Giocatori

### 3.1 — Routing
Aggiungere React Router a `apps/ui-player`:
- `/` → `MoxfieldUI` (goldfish attuale, invariato)
- `/game` → `GameTablePage` (nuova modalità 1v3)

### 3.2 — Nuovi componenti
```
apps/ui-player/src/
  pages/
    GameTablePage.tsx         -- Entry point, gestisce WS + session
  components/game/
    TableLayout.tsx           -- CSS Grid 4 posizioni
    PlayerSeat.tsx            -- Wrapper per un giocatore
    OpponentBoard.tsx         -- Vista compatta AI (battlefield, stats)
    HumanBoard.tsx            -- Vista completa umano (riusa zone esistenti)
    ActionPanel.tsx           -- Bottoni azioni disponibili
    CombatPanel.tsx           -- Selezione attaccanti/bloccanti
    MulliganPanel.tsx         -- Decisione mulligan
    PhaseTracker.tsx          -- Indicatore turno/fase
    GameLog.tsx               -- Log scrollabile
  hooks/
    useGameSession.ts         -- WebSocket connection + state management
```

### 3.3 — Layout CSS
```
+------------------------------------------+
|              NORTH (AI 1)                |
|    [commander] [battlefield] [stats]      |
+--------+-----------------+---------------+
| WEST   |                 |  EAST         |
| (AI 3) |   TABLE CENTER  |  (AI 2)      |
| [mini] |   (stack/log)   |  [mini]      |
+--------+-----------------+---------------+
|              SOUTH (Human)               |
|  [battlefield drag-drop]                 |
|  [hand] [graveyard] [exile] [library]    |
+------------------------------------------+
```

### 3.4 — `useGameSession(sessionId)` hook
- Apre WebSocket a `ws://localhost:5300/game/:id`
- State: `gameState`, `pendingDecision`, `gameLog`, `isConnected`, `gameOver`
- Methods: `submitAction()`, `submitAttackPlan()`, `submitBlockPlan()`, `submitMulligan()`, `submitTarget()`, `concede()`

### 3.5 — Componenti riusati da MoxfieldUI
- `zones/Battlefield.tsx`, `zones/Hand.tsx`, `zones/Graveyard.tsx`, `zones/Exile.tsx`, `zones/CommanderZone.tsx`, `zones/Library.tsx`
- `Card.tsx`, `CardModal.tsx`
- `EngineManaTracker.tsx`
- `hooks/UseCardPreview.tsx`

---

## Fase 4: Interazione Umana Completa

1. `ActionPanel` — quando arriva `waiting_for_human` tipo `action`, mostra bottoni per ogni `availableAction` (Play Land X, Cast Spell Y, Pass Turn)
2. `MulliganPanel` — mostra la mano di 7, bottoni Keep/Mulligan, selezione carte da mettere sotto
3. `CombatPanel` — selezione target attacco (click su avversario Nord/Est/Ovest), checkbox creature attaccanti, poi UI per bloccanti se attaccato
4. Drag-and-drop dalla mano al battlefield integrato con `submit_action`

---

## Fase 5: Polish

- `GameLog.tsx` — scrollabile, messaggi colorati per fase
- `PhaseTracker.tsx` — barra visuale turno/fase corrente
- `StackViewer.tsx` — mostra stack quando `ENABLE_STACK=true`
- Animazioni movimento carte
- Game over overlay con statistiche
- Lobby/deck selection screen prima di `/game`

---

## File critici da modificare

| File | Modifica |
|------|----------|
| `packages/game-state/src/types.ts` | `+onStateChange`, `+GameEvent` |
| `packages/sim/src/engine.ts` | `+export createInitialState`, `+10 callback onStateChange` |
| `apps/ui-player/package.json` | `+react-router-dom` |
| `apps/ui-player/src/App.tsx` | `+Router con /game route` |
| `package.json` (root) | `+game:server script` |

## File nuovi da creare

| File | Scopo |
|------|-------|
| `apps/game-server/game-server.ts` | Server Express+WS porta 5300 |
| `apps/game-server/session/GameSession.ts` | Gestione partita singola |
| `apps/game-server/session/SessionManager.ts` | Lifecycle sessioni |
| `apps/game-server/agents/HumanAgent.ts` | Agent umano con Promise |
| `apps/game-server/state/stateSerializer.ts` | Filtro visibilità stato |
| `apps/ui-player/src/pages/GameTablePage.tsx` | Pagina partita 1v3 |
| `apps/ui-player/src/components/game/TableLayout.tsx` | Grid 4 posizioni |
| `apps/ui-player/src/components/game/PlayerSeat.tsx` | Wrapper giocatore |
| `apps/ui-player/src/components/game/OpponentBoard.tsx` | Vista AI compatta |
| `apps/ui-player/src/components/game/HumanBoard.tsx` | Vista umano completa |
| `apps/ui-player/src/components/game/ActionPanel.tsx` | Bottoni azioni |
| `apps/ui-player/src/components/game/CombatPanel.tsx` | UI combattimento |
| `apps/ui-player/src/components/game/MulliganPanel.tsx` | UI mulligan |
| `apps/ui-player/src/components/game/PhaseTracker.tsx` | Tracker fase |
| `apps/ui-player/src/components/game/GameLog.tsx` | Log partita |
| `apps/ui-player/src/hooks/useGameSession.ts` | Hook WebSocket |

## Verifica

1. **Backend**: `curl -X POST localhost:5300/game/create` → sessionId. Logs mostrano engine che parte, AI gioca, si ferma su turno umano.
2. **WebSocket**: Connessione a `ws://localhost:5300/game/:id` → riceve `state_update` per turni AI, poi `waiting_for_human` quando tocca al player 0.
3. **UI**: Aprire `/game`, vedere 4 board, carte AI visibili sul battlefield, mano propria visibile, bottoni azione quando è il proprio turno.
4. **Full loop**: Giocare un turno completo: mulligan → main phase → play land → cast spell → combat → pass → AI giocano → torna al turno umano.

## Stato implementazione

- [x] 1.2 — `GameEvent` type + `onStateChange` aggiunto a `types.ts`
- [x] 1.2 — Hook `onStateChange` in `engine.ts`: `combat_resolved`, `draw`, `game_over` emessi; `onStateChange` passato a `processActionWindow` e `executeCombatPhase`
- [x] 1.2 — Export `createInitialState` da `engine.ts`
- [x] 1.1 — `HumanAgent.ts` (`apps/game-server/agents/HumanAgent.ts`)
- [x] 1.2 — `SimAgent.decideMulligan` e `decideResponse` aggiornati per supportare return Promise
- [x] 2.1 — `apps/game-server/game-server.ts` — Express + WebSocket server su porta 5300
- [x] 2.2 — `apps/game-server/session/GameSession.ts` — Gestione partita singola
- [x] 2.x — `apps/game-server/session/SessionManager.ts` — Lifecycle sessioni con cleanup automatico
- [x] 2.5 — `apps/game-server/state/stateSerializer.ts` — Filtro visibilità stato
- [x] 2.x — `apps/game-server/tsconfig.json`
- [x] 2.x — `package.json` root: aggiunto script `game:server`, dipendenze `ws`, `react-router-dom`, `@types/ws`, `@types/express`, `@types/cors`
- [x] 3.1 — `apps/ui-player/src/App.tsx` aggiornato con BrowserRouter e route `/game`
- [x] 3.2 — `apps/ui-player/src/pages/GameTablePage.tsx` — Entry point, gestisce WS + session
- [x] 3.2 — `apps/ui-player/src/components/game/TableLayout.tsx` — CSS Grid 4 posizioni
- [x] 3.2 — `apps/ui-player/src/components/game/PlayerSeat.tsx` — Wrapper giocatore
- [x] 3.2 — `apps/ui-player/src/components/game/OpponentBoard.tsx` — Vista AI compatta e normale
- [x] 3.2 — `apps/ui-player/src/components/game/HumanBoard.tsx` — Vista umano completa
- [x] 3.2 — `apps/ui-player/src/components/game/PhaseTracker.tsx` — Tracker turno/fase
- [x] 3.4 — `apps/ui-player/src/hooks/useGameSession.ts` — Hook WebSocket
- [x] 4.x — `apps/ui-player/src/components/game/ActionPanel.tsx` — Bottoni azioni (action, attack_plan, target, response, mulligan)
- [x] 4.3 — `apps/ui-player/src/components/game/CombatPanel.tsx` — UI selezione attaccanti/bloccanti/target
- [x] 4.2 — `apps/ui-player/src/components/game/MulliganPanel.tsx` — UI mulligan con selezione carte bottom
- [x] 5.x — `apps/ui-player/src/components/game/GameLog.tsx` — Log scrollabile con messaggi colorati
- [x] 5.x — Game over overlay con bottoni Nuova Partita / Home
