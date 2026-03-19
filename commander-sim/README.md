# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      ...tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      ...tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      ...tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Simulatore Commander

## Struttura monorepo

- `apps/ui-player`: UI React (Vite) stile Moxfield.
- `apps/api`: backend Express per importare/salvare deck/combos.
- `apps/ai-service`: servizio decisionale AI (policy) su `:5200`.
- `apps/sim-service`: orchestratore training su `:5100` (lancia run-batch).
- `packages/game-state`: tipi, util di stato, state digest.
- `packages/rules`: regole/combattimento/ability manager/archetypes.
- `packages/sim`: engine, agenti, pattern store, CLI di training.
- `packages/ai`: client AI esterno.
- `packages/db`: helper Prisma (create run, persist episodes, deck ops).

## Servizi separati (UI / Simulator / AI)

- UI (Vite): `http://localhost:5173`
- Backend esistente (deck import ecc.): `http://localhost:3001`
- Simulator service (trigger training): `http://localhost:5100`
- AI decision service (policy/dataset): `http://localhost:5200`

Script consigliato:
- `npm run all`

Variabili:
- Metti `VITE_AI_DECISION_URL=http://localhost:5200` nel `.env` per far usare alla UI il servizio AI locale (derivato da `data/policy.json`).

- Esegui `npm run train -- [episodes]` (usa `packages/sim/src/run-batch.ts`) per lanciare le simulazioni con gli agenti di training.
- Per evitare che il DB cresca troppo (es. su Neon free tier) puoi controllare quanta storia viene salvata con `EPISODE_STEP_STORAGE=off|digest|full` (default: `digest`).
- Con `DATABASE_URL` configurato, il training usa il DB come source of truth per `PolicyRecord` e replay neurale; `data/policy.json` e `data/dataset.jsonl` restano fallback/export opzionali. Per forzare il salvataggio locale imposta `STORE_POLICY_FILE=true` e/o `STORE_DATASET_FILE=true`.
- Per impostazione predefinita gli agenti usano il Decision Tree e richiamano l'AI solo quando non trovano un path affidabile; se vuoi tornare al vecchio comportamento, imposta `USE_DECISION_TREE_AGENT=false` (o `DECISION_TREE_AGENT=false`).
- Parametri opzionali: `DECISION_TREE_CONFIDENCE` (default 0.8) per la soglia minima di winrate e `DECISION_TREE_MIN_VISITS` (default 5) per il numero minimo di osservazioni richieste prima di considerare il path affidabile.
- Per abilitare l'agente ibrido che interroga un'AI esterna (es. un proxy verso Puter) imposta `AI_DECISION_ENDPOINT` su un endpoint HTTP che accetta `{ state, availableActions }` e restituisce `{ actionType, card?, reasoning? }`. Se la variabile è presente l'agente AI viene usato automaticamente (override con `USE_AI_DECISION_AGENT=false`). Header opzionali: `AI_DECISION_API_KEY` (Bearer) e `AI_DECISION_MODEL`. Usa `AI_DECISION_LOG_REASONING=true` per loggare i commenti dell'AI.
- Il motore ora esegue un ciclo di combattimento esplicito: dopo le azioni principali ogni agente dichiara gli attaccanti disponibili, il difensore decide i bloccanti e il simulatore risolve il danno aggiornando board, cimiteri e log (`DECLARE_ATTACKERS`/`DECLARE_BLOCKERS` compaiono nel dataset e nel DB).
- I deck importati dal DB vengono arricchiti automaticamente con i metadati delle carte (tipo, mana value, power/toughness, flag terra/creatura) e salvati nella nuova colonna `cardMetadata`. Il simulatore usa queste informazioni per distinguere terre e creature reali: dopo aver aggiornato il codice esegui `npx prisma migrate dev` e riesegui il training con `DECK_IDS=...` affinché i dati vengano popolati (il primo run effettuerà le chiamate a Scryfall per completare il profilo del mazzo).
