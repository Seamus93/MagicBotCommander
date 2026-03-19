import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type ArchetypeSeed = {
  name: string;
  category: string;
  goal?: string;
  flow?: string;
  keywords?: string;
  wincons?: string;
  weakness?: string;
  tags?: string;
};

const archetypes: ArchetypeSeed[] = [
  {
    name: "Aggro",
    category: "AGGRO",
    goal: "Chiudere la partita prima che l’avversario stabilizzi",
    flow: "T1 creature → T2 pressione → T3 snowball → lethal",
    keywords: "Curve bassa, rapidità, pressione, burn, creature efficienti",
    wincons: "Overwhelm board, burn letale, attacchi continui",
    weakness: "Rimozioni massicce e stalli",
  },
  {
    name: "White Weenie",
    category: "AGGRO",
    goal: "Sfruttare piccole creature potenziate da anthem",
    flow: "Swarm → Anthem → Alpha strike",
    keywords: "Token, anthem, curve 1–2",
    wincons: "Go-wide + buff",
    weakness: "Debole ai wrath",
    tags: "sub:aggro",
  },
  {
    name: "Burn",
    category: "AGGRO",
    goal: "Lethal diretto con spell",
    flow: "Attacco + spell danno diretto",
    keywords: "Lightning, velocità",
    wincons: "20 danni più veloci possibile",
    weakness: "Lifegain",
  },
  {
    name: "Stompy",
    category: "AGGRO",
    goal: "Creature sovradimensionate precoce",
    keywords: "3/3 a 2 mana, pump",
    wincons: "Overpower",
    weakness: "Counterspell",
  },
  {
    name: "Control",
    category: "CONTROL",
    goal: "Gestire tutto → stabilizzare → vincere tardi",
    flow: "Rimozioni + counter → card advantage → finisher",
    keywords: "Counterspell, mass removal, draw",
    wincons: "Planeswalker, big finisher, value engine",
    weakness: "Pressione iniziale",
  },
  {
    name: "Draw-Go",
    category: "CONTROL",
    goal: "Giocare solo nel turno avversario",
    keywords: "Instant, counter, flash",
    weakness: "Non regge a board sviluppati",
  },
  {
    name: "Tapout",
    category: "CONTROL",
    goal: "Piazzare minacce costose quando è sicuro",
    keywords: "Planeswalker, wraths",
    weakness: "Combo veloci",
  },
  {
    name: "Combo",
    category: "COMBO",
    goal: "Trovare i pezzi → proteggerli → lethal immediato",
    flow: "Tutor → Setup → Trigger → Win",
    keywords: "Tutor, infinite, deterministic",
    wincons: "Infinite/loop",
    weakness: "Disruption, stax",
  },
  {
    name: "Storm",
    category: "COMBO",
    goal: "Spell chain → lethal con payoff storm",
    keywords: "Ritual, draw, cost reduction",
    weakness: "Tax effects",
  },
  {
    name: "Reanimator",
    category: "COMBO",
    goal: "Portare un gigante in gioco nei primi turni",
    flow: "Dump → Reanimate",
    weakness: "Grave hate",
  },
  {
    name: "Thassa's Oracle Combo",
    category: "COMBO",
    goal: "Deck a zero → Oracle",
    keywords: "Demonic Consultation",
    weakness: "Stifle effects",
  },
  {
    name: "Midrange",
    category: "MIDRANGE",
    goal: "Rispondere all’aggro e soffocare il control",
    flow: "Rimozioni → Value creatures → Chiudere",
    keywords: "2-for-1, threats sticky",
    wincons: "Vantaggio incrementale",
    weakness: "Combo più veloce",
  },
  {
    name: "Jund / Rakdos Midrange",
    category: "MIDRANGE",
    keywords: "Thoughtseize, removal premium",
    wincons: "1 carta buona per turno",
  },
  {
    name: "Tempo",
    category: "TEMPO",
    goal: "Guadagnare tempo → vincere mentre l’avversario è rallentato",
    flow: "Drop economico → bounce/counter → clock",
    keywords: "Cheap threat, disruption leggera",
    wincons: "Evasione + pressione",
    weakness: "Value a lungo termine",
  },
  {
    name: "Izzet / Spirits",
    category: "TEMPO",
    keywords: "Flash, pump, tempo spell",
  },
  {
    name: "Ramp",
    category: "RAMP",
    goal: "Generare molto mana → bombe presto",
    flow: "Ramp → Ramp → Haymaker",
    keywords: "Mana-dorks, rocks, land tutors",
    wincons: "Creature enormi o spell devastanti",
    weakness: "Aggro veloce, land hate",
  },
  {
    name: "Tron",
    category: "RAMP",
    goal: "7 mana al T3",
    keywords: "Urza lands",
    weakness: "Land disruption",
  },
  {
    name: "Prison",
    category: "PRISON/STAX",
    goal: "Limitare l’avversario finché non può più giocare",
    flow: "Lock piece → Lock piece → inevitabile wincon",
    keywords: "Lock, tax, denial",
    weakness: "Mani senza lock iniziale",
  },
  {
    name: "Stax",
    category: "PRISON/STAX",
    goal: "Rallentare tutti tranne te",
    keywords: "Winter Orb, Rule of Law",
    weakness: "Hate specifico, focus del tavolo",
  },
  {
    name: "Tokens",
    category: "COMMANDER",
    goal: "Moltiplicare board → anthem → attacco massivo",
    weakness: "Board wipe",
  },
  {
    name: "Aristocrats",
    category: "COMMANDER",
    goal: "Sacrifici → drain → value engine infinito",
    keywords: "Death trigger, recursion",
    weakness: "Grave hate",
  },
  {
    name: "Voltron",
    category: "COMMANDER",
    goal: "Un singolo comandante enorme",
    keywords: "Aura, equipment",
    weakness: "Rimozione mirata",
  },
  {
    name: "Spellslinger",
    category: "COMMANDER",
    goal: "Sinergia con istantanei/stregonerie",
    weakness: "Aggro veloce",
  },
  {
    name: "Group Hug",
    category: "COMMANDER",
    goal: "Dare risorse a tutti per manipolare la partita",
    weakness: "Mancanza di chiusura",
  },
  {
    name: "Toolbox",
    category: "COMMANDER",
    goal: "Risolvere ogni situazione con silver bullets",
    keywords: "Tutor, silver bullets",
    weakness: "Deckbuilding complesso",
  },
];

async function seedArchetypes() {
  for (const entry of archetypes) {
    await prisma.archetype.upsert({
      where: { name: entry.name },
      create: entry,
      update: entry,
    });
  }
  console.log(`Seeded ${archetypes.length} archetypes`);
}

seedArchetypes()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
