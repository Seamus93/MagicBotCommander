export interface PhaseStep {
  name: string;
  description?: string;
  steps?: PhaseStep[];
}

export interface PhaseDefinition extends PhaseStep {}

export const PHASES: PhaseDefinition[] = [
  {
    name: "Fase Iniziale",
    steps: [
      {
        name: "Sottofase di STAP",
        description:
          "Il giocatore attivo STAPpa tutte le permanenti che controlla, salvo effetti che lo impediscono.",
      },
      {
        name: "Sottofase di Mantenimento",
        description:
          "Si risolvono le abilità che si innescano all’inizio del mantenimento e i giocatori possono lanciare istantanei o attivare abilità.",
      },
      {
        name: "Sottofase di Acquisizione",
        description:
          "Il giocatore attivo pesca una carta, a meno che un effetto lo impedisca. È il momento in cui si innescano le abilità di draw step.",
      },
    ],
  },
  {
    name: "Prima Fase Principale",
    description:
      "Il giocatore attivo può lanciare magie di qualsiasi tipo (rispettando il timing), giocare una terra e attivare abilità.",
  },
  {
    name: "Fase di Combattimento",
    steps: [
      {
        name: "Sottofase di Inizio Combattimento",
        description:
          "Ultima finestra per lanciare istantanei o attivare abilità prima che gli attaccanti vengano dichiarati. Si innescano abilità \"all’inizio del combattimento\".",
      },
      {
        name: "Sottofase di Dichiarazione delle Creature Attaccanti",
        description:
          "Il giocatore attivo sceglie quali creature attaccano e chi/che cosa attaccano. Le creature scelte vengono TAPpate (salvo eccezioni).",
      },
      {
        name: "Sottofase di Dichiarazione delle Creature Bloccanti",
        description:
          "I difensori scelgono i bloccanti legali e si applicano restrizioni/obblighi di blocco. È il momento in cui si innescano abilità \"quando questa creatura blocca\".",
      },
      {
        name: "Sottofase di Assegnazione del Danno da Combattimento",
        description:
          "Gli attaccanti e i bloccanti assegnano e infliggono danno simultaneamente (doppio passaggio se c’è first strike/double strike).",
      },
      {
        name: "Sottofase di Fine Combattimento",
        description:
          "Si risolvono le abilità \"alla fine del combattimento\" e le creature vengono rimosse dal combattimento.",
      },
    ],
  },
  {
    name: "Seconda Fase Principale",
    description:
      "Come la prima fase principale: il giocatore può lanciare magie sorcery-speed, giocare una terra (se non l’ha già fatto) e attivare abilità.",
  },
  {
    name: "Fase Finale",
    steps: [
      {
        name: "Sottofase Finale",
        description:
          "Si innescano gli effetti \"all’inizio della fase finale\". È l’ultima finestra per istantanei prima della cancellazione.",
      },
      {
        name: "Sottofase di Cancellazione",
        description:
          "Si scarta fino al limite di mano, vengono rimossi i danni dalle creature e terminano gli effetti \"fino alla fine del turno\".",
      },
    ],
  },
];
