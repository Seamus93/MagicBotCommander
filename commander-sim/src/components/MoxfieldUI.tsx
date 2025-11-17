// Moxfield UI layout with full drag-and-drop support between all zones and zone menus

import React, { useState, useEffect,useRef} from "react";
import { v4 as uuidv4 } from "uuid";
import { parseDeckList } from "../utils/DeckParser";
// useCardPreview gestisce il dettaglio della carta sotto il cursore (hover)
import { useCardPreview } from "../hooks/UseCardPreview";
import Hand from "./zones/Hand";
import Graveyard from "./zones/Graveyard";
import Library from "./zones/Library";
import Exile from "./zones/Exile";
import CommanderZone from "./zones/CommanderZone";
import Battlefield from "./zones/Battlefield";
import CardModal from "./CardModal";
import ZoneViewer from "./ZoneViewer";
import { generateFilteredComboFile } from "../utils/ComboEngine";
import { getDecision } from "../hooks/useDecisionAI";

type ZoneKey = "library" | "graveyard" | "exile" | "hand" | "commander";
type DragSourceZone = ZoneKey | "battlefield";

const CARD_WIDTH = 128;
const CARD_HEIGHT = 180;

const clampCoordinate = (
  value: number,
  size: number,
  containerSize: number
) => Math.max(0, Math.min(value, Math.max(0, containerSize - size)));

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
  const [isLoadingDeck, setIsLoadingDeck] = useState(false);
  const [zoneViewer, setZoneViewer] = useState<{
    key: ZoneKey;
    title: string;
  } | null>(null);

  // Mappa base con le zone di gioco principali (senza battlefield)
// Ogni zona ha uno stato (array di carte) e un setter

  const zoneMap: Record<
    ZoneKey,
    {
      zone: string[];
      setZone: React.Dispatch<React.SetStateAction<string[]>>;
      label: string;
    }
  > = {
    library: { zone: library, setZone: setLibrary, label: "Library" },
    graveyard: { zone: graveyard, setZone: setGraveyard, label: "Graveyard" },
    exile: { zone: exile, setZone: setExile, label: "Exile" },
    hand: { zone: hand, setZone: setHand, label: "Hand" },
    commander: { zone: commandZone, setZone: setCommandZone, label: "Command" },
  };

  const setDragPayload = (
    e: React.DragEvent<HTMLDivElement>,
    name: string,
    options?: {
      offset?: { x: number; y: number };
      sourceZone?: { zoneKey: DragSourceZone; index?: number };
    }
  ) => {
    e.dataTransfer.setData("text/plain", name);
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const defaultOffset = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    const offset = options?.offset ?? defaultOffset;
    e.dataTransfer.setData("application/card-offset", JSON.stringify(offset));

    if (options?.sourceZone) {
      e.dataTransfer.setData(
        "application/source-zone",
        JSON.stringify(options.sourceZone)
      );
    } else {
      e.dataTransfer.setData("application/source-zone", "");
    }
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
    let sourceInfo: { zoneKey: DragSourceZone; index?: number } | undefined;
    const sourceMeta = e.dataTransfer.getData("application/source-zone");
    if (sourceMeta) {
      try {
        const parsed = JSON.parse(sourceMeta);
        if (parsed?.zoneKey) {
          sourceInfo = {
            zoneKey: parsed.zoneKey as DragSourceZone,
            index:
              typeof parsed.index === "number" ? parsed.index : undefined,
          };
        }
      } catch {
        sourceInfo = undefined;
      }
    }

    const dropContainer =
      (e.currentTarget as HTMLElement).closest(
        `[data-drop-zone="${targetZone}"]`
      ) ?? (e.currentTarget as HTMLElement);
    const rect = dropContainer.getBoundingClientRect();
    const relativeX = e.clientX - rect.left;
    const relativeY = e.clientY - rect.top;

    switch (targetZone) {
      case "hand":
        moveCard(card, setHand, false, sourceInfo);
        break;
      case "graveyard":
        moveCard(card, setGraveyard, false, sourceInfo);
        break;
      case "exile":
        moveCard(card, setExile, false, sourceInfo);
        break;
      case "library":
        removeCardFromAllZones(card, sourceInfo);
        setLibrary((prev) => [card, ...prev]);
        break;
      case "commander":
        if (card === fullDeck[0]) moveCard(card, setCommandZone, true, sourceInfo);
        break;
      case "battlefield": {
        let offset = { x: 0, y: 0 };
        try {
          const stored = e.dataTransfer.getData("application/card-offset");
          if (stored) offset = JSON.parse(stored);
        } catch {
          offset = { x: CARD_WIDTH / 2, y: CARD_HEIGHT / 2 };
        }
        const x = clampCoordinate(relativeX - offset.x, CARD_WIDTH, rect.width);
        const y = clampCoordinate(
          relativeY - offset.y,
          CARD_HEIGHT,
          rect.height
        );
        removeCardFromAllZones(card, sourceInfo);
        setBattlefield((prev) => [...prev, { id: uuidv4(), card, x, y }]);
        break;
      }
    }
  };

  // moveCard rimuove la carta da tutte le zone e la aggiunge nella destinazione
// removeCardFromAllZones è una utility che pulisce tutte le zone da una specifica carta

  const moveCard = (
    card: string,
    setZone: React.Dispatch<React.SetStateAction<string[]>> | ((prev: string[]) => string[]),
    overwrite: boolean = false,
    sourceInfo?: { zoneKey: DragSourceZone; index?: number }
  ) => {
    removeCardFromAllZones(card, sourceInfo);
    if (typeof setZone === "function") {
      setZone((prev: string[]) => (overwrite ? [card] : [...prev, card]));
    }
  };

  const removeCardFromAllZones = (
    card: string,
    source?: { zoneKey: DragSourceZone; index?: number }
  ) => {
    const removeFromList = (
      prev: string[],
      zoneKey: DragSourceZone
    ): string[] => {
      const copy = [...prev];
      const idx =
        source?.zoneKey === zoneKey && source.index !== undefined
          ? source.index
          : copy.indexOf(card);
      if (idx < 0 || idx >= copy.length) {
        return prev;
      }
      copy.splice(idx, 1);
      return copy;
    };

    setHand((prev) => removeFromList(prev, "hand"));
    setGraveyard((prev) => removeFromList(prev, "graveyard"));
    setExile((prev) => removeFromList(prev, "exile"));
    setLibrary((prev) => removeFromList(prev, "library"));
    setCommandZone((prev) => removeFromList(prev, "commander"));
    setBattlefield((prev) => {
      const copy = [...prev];
      let idx = copy.findIndex((obj) => obj.card === card);
      if (source?.zoneKey === "battlefield" && source.index !== undefined) {
        idx = source.index;
      }
      if (idx < 0 || idx >= copy.length) {
        return prev;
      }
      copy.splice(idx, 1);
      return copy;
    });
  };

  // Permette l'uso di menu interattivi per spostare tutte le carte da una zona all'altra
// Esempio: "sposta tutto dalla mano al cimitero"
// Usa la stringa `action` nel formato "move-[destinazione]"

  const handleZoneAction = (action: string, fromZone: string) => {
    const zoneKey = fromZone as ZoneKey;
    const from = zoneMap[zoneKey];
    if (!from) return;
    if (action === "view") {
      setZoneViewer({ key: zoneKey, title: from.label });
      return;
    }

    const toZoneKey = action.split("-")[1] as ZoneKey;
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
    const trimmed = input.trim();
    if (!trimmed) {
      alert("Inserisci un deck o un link Moxfield.");
      return;
    }

    setIsLoadingDeck(true);
    try {
      let cards: string[] = [];
      const isMoxfieldLink = /^https?:\/\/(?:www\.)?moxfield\.com\/decks\//i.test(trimmed);

      if (isMoxfieldLink) {
        try {
          const resp = await fetch("http://localhost:3001/fetch-moxfield-deck", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: trimmed }),
          });
          if (!resp.ok) {
            const message = await resp.text();
            throw new Error(message);
          }
          const data = await resp.json();
          cards = data.cards ?? [];
        } catch (error) {
          console.error("Errore caricamento Moxfield:", error);
          const message =
            error instanceof Error && error.message
              ? error.message
              : "Impossibile recuperare il deck da Moxfield.";
          alert(message);
          return;
        }
      } else {
        cards = parseDeckList(trimmed);
      }

      if (!cards || cards.length === 0) {
        alert("Errore: il mazzo è vuoto o malformato.");
        return;
      }
      localStorage.setItem("savedDeck", JSON.stringify(cards));

      fetch("http://localhost:3001/save-deck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cards),
      });

      await generateFilteredComboFile();

      setFullDeck(cards);
      initializeGameState(cards);
    } finally {
      setIsLoadingDeck(false);
    }
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

        <Battlefield
          cards={battlefield}
          onDrop={handleDrop}
          onDragStart={(e, name) =>
            setDragPayload(e, name, {
              sourceZone: { zoneKey: "battlefield" },
            })
          }
          onHover={handleHover}
          onLeave={handleLeave}
          onLoadDeckClick={handleLoadDeck}
          showMenu={showMenu}
          toggleMenu={() => setShowMenu((prev) => !prev)}
        />

        <div className="flex justify-between gap-4 p-3 bg-zinc-900 items-start">
          <Hand
            cards={hand}
            onDrop={handleDrop}
            onDragStart={(e, name) =>
              setDragPayload(e, name, { sourceZone: { zoneKey: "hand" } })
            }
            onHover={handleHover}
            onLeave={handleLeave}
            onZoneAction={handleZoneAction}
          />

          <div className="flex gap-2 items-start">
            <Graveyard
              cards={graveyard}
              onDrop={handleDrop}
              onDragStart={(e, name) =>
                setDragPayload(e, name, { sourceZone: { zoneKey: "graveyard" } })
              }
              onHover={handleHover}
              onLeave={handleLeave}
              onZoneAction={handleZoneAction}
            />
            <Exile
              cards={exile}
              onDrop={handleDrop}
              onDragStart={(e, name) =>
                setDragPayload(e, name, { sourceZone: { zoneKey: "exile" } })
              }
              onHover={handleHover}
              onLeave={handleLeave}
              onZoneAction={handleZoneAction}
            />
            <Library
              cards={library}
              image="src/assets/sleeve.png"
              onDrop={handleDrop}
              onDragStart={(e, name) =>
                setDragPayload(e, name, { sourceZone: { zoneKey: "library" } })
              }
              onHover={handleHover}
              onLeave={handleLeave}
              onClick={handleDraw}
              onZoneAction={handleZoneAction}
            />
            <CommanderZone
              cards={commandZone}
              commanderTax={commanderTax}
              onIncreaseTax={() => setCommanderTax((prev) => prev + 2)}
              onDrop={handleDrop}
              onDragStart={(e, name) =>
                setDragPayload(e, name, { sourceZone: { zoneKey: "commander" } })
              }
              onHover={handleHover}
              onLeave={handleLeave}
            />
          </div>
        </div>
      </div>

      {hoverCardDetail && (
        <div className="fixed top-24 right-[7vw] z-50 w-[28vw] max-w-sm">
          <CardModal
            ref={modalRef}
            data={hoverCardDetail.data}
            zoneState={{
              H: hand,
              B: battlefield.map((c) => c.card),
              G: graveyard,
              E: exile,
              C: commandZone,
            }}
          />
        </div>
      )}
      {zoneViewer && (
        <ZoneViewer
          title={zoneViewer.title}
          cards={zoneMap[zoneViewer.key]?.zone ?? []}
          onClose={() => setZoneViewer(null)}
          onDragStart={(e, name, index) =>
            setDragPayload(e, name, {
              offset: { x: CARD_WIDTH / 2, y: CARD_HEIGHT / 2 },
              sourceZone: { zoneKey: zoneViewer.key, index },
            })
          }
        />
      )}
      {isLoadingDeck && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="flex items-center gap-3 px-6 py-4 bg-zinc-900 rounded-2xl text-white shadow-2xl border border-zinc-700">
            <span className="h-5 w-5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            <span className="text-sm font-semibold">Caricamento mazzo...</span>
          </div>
        </div>
      )}
    </div>
  );
}
