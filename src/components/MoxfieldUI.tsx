// Moxfield UI layout with full drag-and-drop support between all zones and zone menus

import React, { useState, useEffect,useRef} from "react";
import { v4 as uuidv4 } from "uuid";
import { parseDeckList } from "../utils/DeckParser";
// useCardPreview gestisce il dettaglio della carta sotto il cursore (hover)
import { useCardPreview } from "../hooks/UseCardPreview";
import CardPreview from "../utils/CardPreview";
import Hand from "./zones/Hand";
import Graveyard from "./zones/Graveyard";
import Library from "./zones/Library";
import Exile from "./zones/Exile";
import CommanderZone from "./zones/CommanderZone";
import Battlefield from "./zones/Battlefield";
import CardModal from "./CardModal";
import { generateFilteredComboFile } from "../utils/ComboEngine";
import { getDecision } from "../hooks/useDecisionAI";

// Tutti gli useState definiscono lo stato principale del gioco, tra cui:
// - Zone del campo (mano, mazzo, cimitero, esilio, ecc.)
// - Turno e punti vita
// - Modalità interazione e notifiche UI

export default function MoxfieldUI() {
  const [notification, setNotification] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [life, setLife] = useState(40);
  const [turn, setTurn] = useState(1);
  const [showMenu, setShowMenu] = useState(false);
  const [fullDeck, setFullDeck] = useState<string[]>([]);
  const [hand, setHand] = useState<string[]>([]);
  const [library, setLibrary] = useState<string[]>([]);
  const [graveyard, setGraveyard] = useState<string[]>([]);
  const [exile, setExile] = useState<string[]>([]);
  const [commanderTax, setCommanderTax] = useState(0);
  const [commandZone, setCommandZone] = useState<string[]>([]);
  const [battlefield, setBattlefield] = useState<{ id: string; card: string; x: number; y: number }[]>([]);
  const { hoverCardDetail, handleHover, handleLeave } = useCardPreview();
  const modalRef = useRef<HTMLDivElement | null>(null);

  // Mappa base con le zone di gioco principali (senza battlefield)
// Ogni zona ha uno stato (array di carte) e un setter

  const zoneMap = {
    library: { zone: library, setZone: setLibrary },
    graveyard: { zone: graveyard, setZone: setGraveyard },
    exile: { zone: exile, setZone: setExile },
    hand: { zone: hand, setZone: setHand },
    commander: { zone: commandZone, setZone: setCommandZone },
  };

  // Resetta tutto e distribuisce le prime 7 carte in mano
// Assume che la prima carta del mazzo sia il comandante

  const initializeGameState = (deck: string[]) => {
    const [commanderCard, ...deckCards] = deck;
    const shuffled = [...deckCards].sort(() => Math.random() - 0.5);
    setCommandZone([commanderCard]);
    setHand(shuffled.slice(0, 7));
    setLibrary(shuffled.slice(7));
    setGraveyard([]);
    setExile([]);
    setBattlefield([]);
    setCommanderTax(0);
    setTurn(1);
    setLife(40);
  };

// Gestisce lo spostamento delle carte tra zone
// Calcola coordinate X/Y per posizionamento nel campo (battlefield)
// Usa `moveCard()` per spostamenti semplici e `removeCardFromAllZones()` per rimozione globale

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, targetZone: string) => {
    const card = e.dataTransfer.getData("text/plain").trim();
    if (!card) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    switch (targetZone) {
      case "hand":
        moveCard(card, setHand);
        break;
      case "graveyard":
        moveCard(card, setGraveyard);
        break;
      case "exile":
        moveCard(card, setExile);
        break;
      case "library":
        removeCardFromAllZones(card);
        setLibrary((prev) => [card, ...prev]);
        break;
      case "commander":
        if (card === fullDeck[0]) moveCard(card, setCommandZone, true);
        break;
      case "battlefield":
        removeCardFromAllZones(card);
        setBattlefield((prev) => [...prev, { id: uuidv4(), card, x, y }]);
        break;
    }
  };

  // moveCard rimuove la carta da tutte le zone e la aggiunge nella destinazione
// removeCardFromAllZones è una utility che pulisce tutte le zone da una specifica carta

  const moveCard = (
    card: string,
    setZone: React.Dispatch<React.SetStateAction<string[]>> | ((prev: string[]) => string[]),
    overwrite: boolean = false
  ) => {
    removeCardFromAllZones(card);
    if (typeof setZone === "function") {
      setZone((prev: string[]) => (overwrite ? [card] : [...prev, card]));
    }
  };

  const removeCardFromAllZones = (card: string) => {
    setHand((prev) => prev.filter((c) => c !== card));
    setGraveyard((prev) => prev.filter((c) => c !== card));
    setExile((prev) => prev.filter((c) => c !== card));
    setLibrary((prev) => prev.filter((c) => c !== card));
    setCommandZone((prev) => prev.filter((c) => c !== card));
    setBattlefield((prev) => prev.filter((obj) => obj.card !== card));
  };

  // Permette l'uso di menu interattivi per spostare tutte le carte da una zona all'altra
// Esempio: "sposta tutto dalla mano al cimitero"
// Usa la stringa `action` nel formato "move-[destinazione]"

  const handleZoneAction = (action: string, fromZone: string) => {
    const from = zoneMap[fromZone];
    if (!from) return;
    if (action === "view") {
      alert(`Carte in ${fromZone}: ${from.zone.join(", ") || "(vuoto)"}`);
      return;
    }

    const toZoneKey = action.split("-")[1];
    const to = zoneMap[toZoneKey];
    if (!to) return;

    const cardsToMove = [...from.zone];
    from.setZone([]);
    to.setZone((prev) => [...cardsToMove, ...prev]);
  };

// handleRestart: resetta la partita
// handleDraw: pesca la prima carta del mazzo
// handleTurn: avanza il turno e pesca

  const handleRestart = () => {
    if (window.confirm("Are you sure you want to restart the game?")) {
      initializeGameState(fullDeck);
    }
  };

  const handleDraw = () => {
    if (library.length === 0) return;
    const [topCard, ...rest] = library;
    setLibrary(rest);
    setHand([...hand, topCard]);
  };

  // Riceve una lista di carte testuale (input), la salva, la invia a un endpoint e
// genera le combo valide per il mazzo con `generateFilteredComboFile`

  const handleLoadDeck = async (input: string) => {
    const cards = parseDeckList(input);
    if (!cards || cards.length === 0) {
      alert("Errore: il mazzo è vuoto o malformato.");
      return;
    }
    localStorage.setItem("savedDeck", JSON.stringify(cards));

    // Salva il mazzo su public/CurrentDeck.json
    fetch("http://localhost:3001/save-deck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cards),
    });

    // Filtra e salva le combo compatibili nel mazzo
    await generateFilteredComboFile();

    // Inizializza lo stato di gioco
    setFullDeck(cards);
    initializeGameState(cards);
  };

    useEffect(() => {
    const saved = localStorage.getItem("savedDeck");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setFullDeck(parsed);
        initializeGameState(parsed);
        return;
      }
    }
      setNotification({ message: "Nessun mazzo trovato, caricalo dal menu Battlefield.", type: "error" });
  }, []);


// Il return definisce la struttura della UI
// Suddivisa in:
// - Header (vita e pulsanti azione)
// - Campo da gioco (Battlefield)
// - Sezione inferiore con le altre zone (mano, cimitero, esilio, ecc.)

  const handleShuffle = () => {
    setLibrary((prev) => [...prev].sort(() => Math.random() - 0.5));
  };

  const handleTurn = () => {
    setTurn((prev) => prev + 1);
    handleDraw();
  };

  const buildGameState = async (): Promise<GameState> => {
    const res = await fetch("/FilteredCombos.json");
    const comboJson = await res.json();  // <-- qui
    const combos = comboJson.combos; 

    return {
      turn,
      life,
      commander: fullDeck[0],
      hand,
      battlefield: battlefield.map(c => c.card),
      graveyard,
      exile,
      combos,
    };
  };

  //AI Autoplay decision making
const autoplayAI = async () => {
  try {
    const gameState = await buildGameState();
    console.log(gameState);
    const aiDecision = await getDecision(gameState);
    console.log("aiDecision:\n" + aiDecision);
    setNotification({ message: "Decisione AI:\n" + aiDecision, type: "success" });

  } catch (error) {
    setNotification({ message: "Errore nella decisione AI" + error, type: "error" });
  }
};


  
  // Mostra messaggi temporanei come errori di caricamento mazzo
// Usa `setNotification` con timeout automatico per la chiusura

  useEffect(() => {
  if (notification) {
      const timer = setTimeout(() => setNotification(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  return (
    <div className="relative flex h-screen w-full bg-zinc-900 text-white">
      <div className="absolute top-24 right-4 flex flex-col gap-2 p-5 z-10">
        {["Restart", "Shuffle", "Draw", "Next Turn","AI Decision"].map((label) => (
          <button
            key={label}
            onClick={() => {
              if (label === "Restart") handleRestart();
              if (label === "Next Turn") handleTurn();
              if (label === "Draw") handleDraw();
              if (label === "Shuffle") handleShuffle();
              if (label== "AI Decision") autoplayAI();
            }}
            className={`px-2 py-1 text-sm rounded-full text-white ${label === "Next Turn" ? "bg-blue-600/80 hover:bg-blue-700" : "bg-orange-600/80 hover:bg-orange-500"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-col flex-1">
        <div className="flex justify-between items-center p-3 bg-zinc-900 border-b border-zinc-700">
          <div className="text-xl font-bold">MOXFIELD</div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <button className="px-2 py-1 bg-red-600 rounded" onClick={() => setLife((l) => l - 1)}>-</button>
              <span>{life}</span>
              <button className="px-2 py-1 bg-green-600 rounded" onClick={() => setLife((l) => l + 1)}>+</button>
            </div>
            <button onClick={handleTurn} className="px-2 py-1">Turn {turn}</button>
          </div>
        </div>

        <Battlefield cards={battlefield} onDrop={handleDrop} onDragStart={(e, name) => e.dataTransfer.setData("text/plain", name)} onHover={handleHover} onLeave={handleLeave} onLoadDeckClick={handleLoadDeck} showMenu={showMenu} toggleMenu={() => setShowMenu(prev => !prev)}/>

        <div className="flex justify-between gap-4 p-3 bg-zinc-900 items-start">
          <Hand cards={hand} onDrop={handleDrop} onDragStart={(e, name) => e.dataTransfer.setData("text/plain", name)} onHover={handleHover} onLeave={handleLeave} onZoneAction={handleZoneAction} />

          <div className="flex gap-2 items-start">
            <Graveyard cards={graveyard} onDrop={handleDrop} onDragStart={(e, name) => e.dataTransfer.setData("text/plain", name)} onHover={handleHover} onLeave={handleLeave} onZoneAction={handleZoneAction}/>
            <Exile cards={exile} onDrop={handleDrop} onDragStart={(e, name) => e.dataTransfer.setData("text/plain", name)} onHover={handleHover} onLeave={handleLeave} onZoneAction={handleZoneAction}/>
            <Library cards={library} image="src/assets/sleeve.png" onDrop={handleDrop} onDragStart={(e, name) => e.dataTransfer.setData("text/plain", name)} onHover={handleHover} onLeave={handleLeave} onClick={handleDraw} onZoneAction={handleZoneAction}/>
            <CommanderZone cards={commandZone} commanderTax={commanderTax} onIncreaseTax={() => setCommanderTax((prev) => prev + 2)} onDrop={handleDrop} onDragStart={(e, name) => e.dataTransfer.setData("text/plain", name)} onHover={handleHover} onLeave={handleLeave} />
          </div>
        </div>
      </div>

      {hoverCardDetail && (<div className="fixed top-24 right-[7vw] z-50 w-[28vw] max-w-sm"> <CardModal
  ref={modalRef}
  data={hoverCardDetail.data}
  x={hoverCardDetail.x}
  y={hoverCardDetail.y}
    zoneState={{
    H: hand,
    B: battlefield.map(c => c.card),
    G: graveyard,
    E: exile,
    C: commandZone,
  }}
/>
</div>)}
    </div>
  );
}
