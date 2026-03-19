// Moxfield UI layout with full drag-and-drop support between all zones and zone menus

import React, { useState, useEffect, useRef, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { parseDeckList } from "../utils/DeckParser";
// useCardPreview gestisce il dettaglio della carta sotto il cursore (hover)
import { useCardPreview } from "../hooks/UseCardPreview";
import { useViewerControl } from "../hooks/useViewerControl";
import Hand from "./zones/Hand";
import Graveyard from "./zones/Graveyard";
import Library from "./zones/Library";
import Exile from "./zones/Exile";
import CommanderZone from "./zones/CommanderZone";
import Battlefield from "./zones/Battlefield";
import { CARD_HEIGHT, CARD_WIDTH } from "./Card";
import CardModal from "./CardModal";
import DeckLoadModal from "./DeckLoadModal";
import ZoneViewer from "./ZoneViewer";
import EngineManaTracker from "./EngineManaTracker";
import DialogModal from "./DialogModal";
import NumericPromptModal from "./NumericPromptModal";
import { generateFilteredComboFile } from "../utils/ComboEngine";
import { getDecision, type GameState } from "../hooks/useDecisionAI";
import { useGameSession } from "../hooks/useGameSession";
import { useSharedGameSession } from "../hooks/useSharedGameSession";
import ActionPanel from "./game/ActionPanel";
import moxOrb from "../assets/mox-o.svg";
import importIcon from "../assets/import-icon.svg";

type ZoneKey = "library" | "graveyard" | "exile" | "hand" | "commander";
type DragSourceZone = ZoneKey | "battlefield";

const VIEWER_STATE_URL =
  (import.meta.env.VITE_VIEWER_STATE_URL as string | undefined) ??
  "http://localhost:3001";

// Carte che concedono drop di terra aggiuntivi per turno (nome esatto Scryfall → bonus drops)
const EXTRA_LAND_DROP_CARDS: Record<string, number> = {
  "Exploration": 1,
  "Azusa, Lost but Seeking": 2,
  "Oracle of Mul Daya": 1,
  "Wayward Swordtooth": 1,
  "Dryad of the Ilysian Grove": 1,
  "Fastbond": 98, // illimitato praticamente
  "Rites of Flourishing": 1,
  "Mox Lotus": 0,
  "Sword of Hearth and Home": 0, // fetch, non land play
};

const BASIC_LAND_NAMES = new Set([
  "plains", "island", "swamp", "mountain", "forest", "wastes",
  "snow-covered plains", "snow-covered island", "snow-covered swamp",
  "snow-covered mountain", "snow-covered forest",
]);

function isLikelyLand(name: string): boolean {
  const lower = name.toLowerCase();
  if (BASIC_LAND_NAMES.has(lower)) return true;
  // heuristic: nome contiene "land" ma non è una spell tipo "Cultivate"
  return /\bland\b/.test(lower);
}

function computeMaxLandDrops(battlefieldCards: string[]): number {
  let extra = 0;
  for (const card of battlefieldCards) {
    const bonus = EXTRA_LAND_DROP_CARDS[card];
    if (bonus !== undefined) extra += bonus;
  }
  return 1 + extra;
}

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
  const viewerControl = useViewerControl();
  const sharedSession = useSharedGameSession(1000);
  const [notification, setNotification] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [aiDecisionText, setAiDecisionText] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    title: string;
    message: string;
    tone?: "default" | "danger";
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
  } | null>(null);
  const [currentDeckId, setCurrentDeckId] = useState<number | null>(null);
  const [life, setLife] = useState(40);
  const [lifeInput, setLifeInput] = useState("40");
  const [turn, setTurn] = useState(1);
  const [showMenu, setShowMenu] = useState(false);
  const [deckInput, setDeckInput] = useState("");
  const [deckImportError, setDeckImportError] = useState<{ message: string; cloudflareBlock: boolean } | null>(null);
  const [landsPlayedThisTurn, setLandsPlayedThisTurn] = useState(0);
  const [fullDeck, setFullDeck] = useState<string[]>([]);
  const [hand, setHand] = useState<string[]>([]);
  const [library, setLibrary] = useState<string[]>([]);
  const [graveyard, setGraveyard] = useState<string[]>([]);
  const [exile, setExile] = useState<string[]>([]);
  const [commanderTax, setCommanderTax] = useState(0);
  const [commandZone, setCommandZone] = useState<string[]>([]);
  const [battlefield, setBattlefield] = useState<{ id: string; card: string; x: number; y: number; z: number }[]>([]);
  const [libraryTopRevealed, setLibraryTopRevealed] = useState(false);
  const { hoverCardDetail, handleHover, handleLeave } = useCardPreview();
  const modalRef = useRef<HTMLDivElement | null>(null);
  const lastRestartTokenRef = useRef<number | string | null>(null);
  const cardTypeCacheRef = useRef<Record<string, string>>({});
  const [isLoadingDeck, setIsLoadingDeck] = useState(false);
  const [zoneViewer, setZoneViewer] = useState<{
    title: string;
    cards: string[];
    sourceKey: ZoneKey;
    reverseDisplay?: boolean;
    indexMap?: number[];
  } | null>(null);
  const [countPrompt, setCountPrompt] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    max: number;
    onConfirm: (value: number) => void;
  } | null>(null);
  const {
    gameState,
    pendingDecision,
    isConnected: isGameSessionConnected,
    submitAction,
    submitAttackPlan,
    submitBlockPlan,
    submitMulligan,
    submitTarget,
    submitResponse,
  } = useGameSession(sharedSession?.sessionId ?? null);
  const aiPlayers = gameState?.players.filter((player) => !player.isHuman) ?? [];

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
      cardId?: string;
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

    if (options?.cardId) {
      e.dataTransfer.setData("application/card-id", options.cardId);
    } else {
      e.dataTransfer.setData("application/card-id", "");
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
    setLibraryTopRevealed(false);
    setCommanderTax(0);
    setTurn(1);
    setLife(40);
    setLifeInput("40");
    setLandsPlayedThisTurn(0);
  };

// Gestisce lo spostamento delle carte tra zone
// Calcola coordinate X/Y per posizionamento nel campo (battlefield)
// Usa `moveCard()` per spostamenti semplici e `removeCardFromAllZones()` per rimozione globale

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>, targetZone: string) => {
    const card = e.dataTransfer.getData("text/plain").trim();
    if (!card) return;
    let sourceInfo: { zoneKey: DragSourceZone; index?: number } | undefined;
    const sourceMeta = e.dataTransfer.getData("application/source-zone");
    const cardId = e.dataTransfer.getData("application/card-id") || undefined;
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

    const targetEl =
      (e.currentTarget as HTMLElement).getAttribute("data-drop-zone") === targetZone
        ? (e.currentTarget as HTMLElement)
        : ((e.target as HTMLElement)?.closest(
            `[data-drop-zone="${targetZone}"]`
          ) as HTMLElement | null);

    const dropContainer = targetEl ?? (e.currentTarget as HTMLElement);
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
        const offsetStr = e.dataTransfer.getData("application/card-offset");
        let grabOffset = { x: CARD_WIDTH / 2, y: CARD_HEIGHT / 2 };
        if (offsetStr) {
          try {
            const parsed = JSON.parse(offsetStr) as { x: number; y: number };
            if (typeof parsed.x === "number" && typeof parsed.y === "number") {
              grabOffset = parsed;
            }
          } catch { /* ignora */ }
        }
        const x = clampCoordinate(relativeX - grabOffset.x, CARD_WIDTH, rect.width);
        const y = clampCoordinate(relativeY - grabOffset.y, CARD_HEIGHT, rect.height);
        const isMovingInsideBattlefield =
          sourceInfo?.zoneKey === "battlefield" && cardId;

        if (!isMovingInsideBattlefield) {
          removeCardFromAllZones(card, sourceInfo);
          // Traccia land drop: solo se viene dalla mano ed è una terra
          if (sourceInfo?.zoneKey === "hand" && isLikelyLand(card)) {
            setLandsPlayedThisTurn((n) => n + 1);
          }
        }

        setBattlefield((prev) => {
          const maxZ =
            prev.length === 0 ? 0 : Math.max(...prev.map((c) => c.z ?? 0));

          if (isMovingInsideBattlefield) {
            return prev.map((c) =>
              c.id === cardId ? { ...c, x, y, z: maxZ + 1 } : c
            );
          }

          return [
            ...prev,
            { id: uuidv4(), card, x, y, z: maxZ + 1 },
          ];
        });
        break;
      }
    }
  }, [fullDeck]);

  const handleBattlefieldMove = useCallback((cardId: string, x: number, y: number) => {
    setBattlefield((prev) => {
      const maxZ = prev.length === 0 ? 0 : Math.max(...prev.map((c) => c.z ?? 0));
      return prev.map((c) => c.id === cardId ? { ...c, x, y, z: maxZ + 1 } : c);
    });
  }, []);
  const handleHandDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, name: string) =>
      setDragPayload(e, name, { sourceZone: { zoneKey: "hand" } }),
    []
  );
  const handleGraveyardDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, name: string) =>
      setDragPayload(e, name, { sourceZone: { zoneKey: "graveyard" } }),
    []
  );
  const handleExileDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, name: string) =>
      setDragPayload(e, name, { sourceZone: { zoneKey: "exile" } }),
    []
  );
  const handleLibraryDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, name: string) =>
      setDragPayload(e, name, { sourceZone: { zoneKey: "library" } }),
    []
  );
  const handleCommanderDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, name: string) =>
      setDragPayload(e, name, { sourceZone: { zoneKey: "commander" } }),
    []
  );
  const handleBattlefieldDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, name: string, cardId?: string) =>
      setDragPayload(e, name, { sourceZone: { zoneKey: "battlefield" }, cardId }),
    []
  );

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
      if (source?.zoneKey !== "battlefield") return prev;
      const copy = [...prev];
      const idx =
        source.index !== undefined
          ? source.index
          : copy.findIndex((obj) => obj.card === card);
      if (idx < 0 || idx >= copy.length) return prev;
      copy.splice(idx, 1);
      return copy;
    });
  };

  // Permette l'uso di menu interattivi per spostare tutte le carte da una zona all'altra
// Esempio: "sposta tutto dalla mano al cimitero"
// Usa la stringa `action` nel formato "move-[destinazione]"

  const handleDrawCount = (count: number, notify = true) => {
    if (library.length === 0) return;
    const drawCount = Math.max(0, Math.min(count, library.length));
    if (drawCount === 0) return;
    const drawn = library.slice(0, drawCount);
    const rest = library.slice(drawCount);
    setLibrary(rest);
    setHand((prev) => [...prev, ...drawn]);
    if (notify) {
      const nextHandCount = hand.length + drawCount;
      setNotification({
        message: `Draw ${drawCount} Card${drawCount === 1 ? "" : "s"}, Now you have ${nextHandCount} ${nextHandCount === 1 ? "card" : "cards"}`,
        type: "success",
      });
    }
  };

  const openZoneViewer = (options: {
    title: string;
    cards: string[];
    sourceKey: ZoneKey;
    reverseDisplay?: boolean;
    indexMap?: number[];
  }) => {
    setZoneViewer(options);
  };

  const promptForCount = (options: {
    title: string;
    message: string;
    confirmLabel: string;
    max: number;
    onConfirm: (value: number) => void;
  }) => {
    setCountPrompt(options);
  };

  const getCardTypeLine = async (cardName: string) => {
    if (cardTypeCacheRef.current[cardName]) {
      return cardTypeCacheRef.current[cardName];
    }

    try {
      const response = await fetch(
        `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cardName)}`
      );
      if (!response.ok) {
        return "";
      }
      const payload = (await response.json()) as { type_line?: string };
      const typeLine = payload.type_line ?? "";
      cardTypeCacheRef.current[cardName] = typeLine;
      return typeLine;
    } catch {
      return "";
    }
  };

  const filterCardsByType = async (
    cards: string[],
    type: "Creature" | "Land" | "Enchantment" | "Artifact" | "Planeswalker"
  ) => {
    const typeLines = await Promise.all(cards.map((card) => getCardTypeLine(card)));
    return cards.filter((_, index) => typeLines[index].includes(type));
  };

  const handleZoneAction = async (action: string, fromZone: string) => {
    const zoneKey = fromZone as ZoneKey;
    const from = zoneMap[zoneKey];
    if (!from) return;
    if (action === "view") {
      openZoneViewer({
        title: from.label,
        cards: [...from.zone],
        sourceKey: zoneKey,
        reverseDisplay: zoneKey === "graveyard" || zoneKey === "exile",
      });
      return;
    }

    if (zoneKey === "library") {
      switch (action) {
        case "library-draw":
          handleDraw();
          return;
        case "library-draw-x":
          promptForCount({
            title: "Draw X Cards",
            message: "How many cards do you want to draw from the top of the library?",
            confirmLabel: "Draw",
            max: library.length,
            onConfirm: (value) => handleDrawCount(value),
          });
          return;
        case "library-shuffle":
          handleShuffle();
          return;
        case "library-view-top-card":
          if (library[0]) {
            openZoneViewer({
              title: "Top Card",
              cards: [library[0]],
              sourceKey: "library",
              indexMap: [0],
            });
          }
          return;
        case "library-view-bottom-card":
          if (library.length > 0) {
            openZoneViewer({
              title: "Bottom Card",
              cards: [library[library.length - 1]],
              sourceKey: "library",
              indexMap: [library.length - 1],
            });
          }
          return;
        case "library-view-top-x":
          promptForCount({
            title: "View Top X Cards",
            message: "How many cards from the top of the library do you want to view?",
            confirmLabel: "View",
            max: library.length,
            onConfirm: (value) =>
              openZoneViewer({
                title: `Top ${value} Cards`,
                cards: library.slice(0, value),
                sourceKey: "library",
                indexMap: Array.from({ length: value }, (_, index) => index),
              }),
          });
          return;
        case "library-view-all":
          openZoneViewer({
            title: "Library",
            cards: [...library],
            sourceKey: "library",
            indexMap: Array.from({ length: library.length }, (_, index) => index),
          });
          return;
        case "library-mill-top-x":
          promptForCount({
            title: "Mill Top X Cards",
            message: "How many cards do you want to mill from the top of the library?",
            confirmLabel: "Mill",
            max: library.length,
            onConfirm: (value) => {
              const millCount = Math.max(0, Math.min(value, library.length));
              if (millCount === 0) return;
              const milled = library.slice(0, millCount);
              const rest = library.slice(millCount);
              setLibrary(rest);
              setGraveyard((prev) => [...prev, ...milled]);
            },
          });
          return;
        case "library-move-graveyard": {
          const cardsToMove = [...library];
          setLibrary([]);
          setGraveyard((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "library-move-exile": {
          const cardsToMove = [...library];
          setLibrary([]);
          setExile((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "library-toggle-top-revealed":
          setLibraryTopRevealed((prev) => !prev);
          return;
      }
    }

    if (zoneKey === "graveyard") {
      switch (action) {
        case "graveyard-move-library-top": {
          const cardsToMove = [...graveyard];
          setGraveyard([]);
          setLibrary((prev) => [...cardsToMove, ...prev]);
          return;
        }
        case "graveyard-move-library-bottom": {
          const cardsToMove = [...graveyard];
          setGraveyard([]);
          setLibrary((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "graveyard-move-exile": {
          const cardsToMove = [...graveyard];
          setGraveyard([]);
          setExile((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "graveyard-move-hand": {
          const cardsToMove = [...graveyard];
          setGraveyard([]);
          setHand((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "graveyard-move-creatures-hand":
        case "graveyard-move-lands-hand":
        case "graveyard-move-enchantments-hand":
        case "graveyard-move-artifacts-hand":
        case "graveyard-move-planeswalkers-hand": {
          const type =
            action === "graveyard-move-creatures-hand"
              ? "Creature"
              : action === "graveyard-move-lands-hand"
                ? "Land"
                : action === "graveyard-move-enchantments-hand"
                  ? "Enchantment"
                  : action === "graveyard-move-artifacts-hand"
                    ? "Artifact"
                    : "Planeswalker";
          const matchingCards = await filterCardsByType(graveyard, type);
          if (matchingCards.length === 0) return;

          const remaining = [...graveyard];
          for (const card of matchingCards) {
            const index = remaining.indexOf(card);
            if (index >= 0) {
              remaining.splice(index, 1);
            }
          }

          setGraveyard(remaining);
          setHand((prev) => [...prev, ...matchingCards]);
          return;
        }
      }
    }

    if (zoneKey === "exile") {
      switch (action) {
        case "exile-move-library-top": {
          const cardsToMove = [...exile];
          setExile([]);
          setLibrary((prev) => [...cardsToMove, ...prev]);
          return;
        }
        case "exile-move-graveyard": {
          const cardsToMove = [...exile];
          setExile([]);
          setGraveyard((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "exile-move-hand": {
          const cardsToMove = [...exile];
          setExile([]);
          setHand((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "exile-move-creatures-hand":
        case "exile-move-lands-hand":
        case "exile-move-enchantments-hand":
        case "exile-move-artifacts-hand":
        case "exile-move-planeswalkers-hand": {
          const type =
            action === "exile-move-creatures-hand"
              ? "Creature"
              : action === "exile-move-lands-hand"
                ? "Land"
                : action === "exile-move-enchantments-hand"
                  ? "Enchantment"
                  : action === "exile-move-artifacts-hand"
                    ? "Artifact"
                    : "Planeswalker";
          const matchingCards = await filterCardsByType(exile, type);
          if (matchingCards.length === 0) return;

          const remaining = [...exile];
          for (const card of matchingCards) {
            const index = remaining.indexOf(card);
            if (index >= 0) {
              remaining.splice(index, 1);
            }
          }

          setExile(remaining);
          setHand((prev) => [...prev, ...matchingCards]);
          return;
        }
      }
    }

    if (zoneKey === "hand") {
      switch (action) {
        case "hand-move-library-top": {
          const cardsToMove = [...hand];
          setHand([]);
          setLibrary((prev) => [...cardsToMove, ...prev]);
          return;
        }
        case "hand-move-library-bottom": {
          const cardsToMove = [...hand];
          setHand([]);
          setLibrary((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "hand-move-graveyard": {
          const cardsToMove = [...hand];
          setHand([]);
          setGraveyard((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "hand-move-exile": {
          const cardsToMove = [...hand];
          setHand([]);
          setExile((prev) => [...prev, ...cardsToMove]);
          return;
        }
        case "hand-discard-random": {
          if (hand.length === 0) return;
          const randomIndex = Math.floor(Math.random() * hand.length);
          const cardToDiscard = hand[randomIndex];
          setHand((prev) => prev.filter((_, index) => index !== randomIndex));
          setGraveyard((prev) => [...prev, cardToDiscard]);
          return;
        }
      }
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
    setDialog({
      title: "Restart",
      message: "Sicuro di Restartare il gioco!?",
      tone: "danger",
      confirmLabel: "Restart",
      cancelLabel: "Cancel",
      onConfirm: () => {
        initializeGameState(fullDeck);
        void fetch(`${VIEWER_STATE_URL}/viewer-control/restart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restartToken: Date.now() }),
        }).catch(() => {
          // Spectator sync is optional; ignore failures in the main UI.
        });
        setDialog(null);
      },
    });
  };

  const handleDraw = (notify: boolean = true) => {
    handleDrawCount(1, notify);
  };

  // Riceve una lista di carte testuale (input), la salva, la invia a un endpoint e
// genera le combo valide per il mazzo con `generateFilteredComboFile`

  const handleLoadDeck = async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      setDialog({
        title: "Deck mancante",
        message: "Inserisci una decklist o un link Moxfield prima di importare.",
        confirmLabel: "Ho capito",
        cancelLabel: "Chiudi",
        onConfirm: () => setDialog(null),
      });
      return;
    }

    setIsLoadingDeck(true);
    try {
      const response = await fetch("http://localhost:3001/import-deck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });

      let payload: any = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const isCloudflareBlock = payload?.cloudflareBlock === true;
        const message =
          (payload && payload.error) ||
          (typeof payload === "string" ? payload : response.statusText);
        if (isCloudflareBlock) {
          setDeckImportError({ message: message || "Cloudflare block", cloudflareBlock: true });
          return;
        }
        throw new Error(message || "Impossibile importare il deck.");
      }

      const importedDeck = payload?.deck;
      const cards = Array.isArray(importedDeck?.cards)
        ? importedDeck.cards
        : parseDeckList(trimmed);

      if (!cards || cards.length === 0) {
        setDialog({
          title: "Deck non valido",
          message: "Il mazzo importato e vuoto oppure il formato non e stato riconosciuto.",
          tone: "danger",
          confirmLabel: "Chiudi",
          cancelLabel: "Annulla",
          onConfirm: () => setDialog(null),
        });
        return;
      }

      localStorage.setItem("savedDeck", JSON.stringify(cards));
      if (importedDeck?.id) {
        setCurrentDeckId(importedDeck.id);
        localStorage.setItem("savedDeckId", String(importedDeck.id));
      } else {
        setCurrentDeckId(null);
        localStorage.removeItem("savedDeckId");
      }

      fetch("http://localhost:3001/save-deck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cards),
      });

      await generateFilteredComboFile();

      setFullDeck(cards);
      initializeGameState(cards);
      setDeckInput("");
      setDeckImportError(null);
      setShowMenu(false);
    } catch (error) {
      console.error("Errore import deck:", error);
      setDialog({
        title: "Import fallito",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Errore durante il caricamento del deck.",
        tone: "danger",
        confirmLabel: "Chiudi",
        cancelLabel: "Annulla",
        onConfirm: () => setDialog(null),
      });
    } finally {
      setIsLoadingDeck(false);
    }
  };

    useEffect(() => {
    const saved = localStorage.getItem("savedDeck");
    const savedDeckId = localStorage.getItem("savedDeckId");
    if (savedDeckId) {
      const parsedId = Number(savedDeckId);
      if (!Number.isNaN(parsedId)) {
        setCurrentDeckId(parsedId);
      }
    }
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setFullDeck(parsed);
        initializeGameState(parsed);
        return;
      }
    }
      setNotification({ message: "Nessun mazzo trovato, caricalo dal pulsante Import nel corner del battlefield.", type: "error" });
  }, []);


// Il return definisce la struttura della UI
// Suddivisa in:
// - Header (vita e pulsanti azione)
// - Campo da gioco (Battlefield)
// - Sezione inferiore con le altre zone (mano, cimitero, esilio, ecc.)

  const handleShuffle = () => {
    setLibrary((prev) => [...prev].sort(() => Math.random() - 0.5));
    setNotification({ message: "Il deck è stato mischiato", type: "success" });
  };

  const handleTurn = () => {
    const nextTurn = turn + 1;
    setTurn(nextTurn);
    setLandsPlayedThisTurn(0);
    handleDraw(false);
    setNotification({ message: `Turn ${nextTurn}`, type: "success" });
  };

  const updateLife = (nextLife: number) => {
    const normalized = Math.max(-999, Math.min(999, nextLife));
    setLife(normalized);
    setLifeInput(String(normalized));
  };

  const commitLifeInput = () => {
    const parsed = Number(lifeInput);
    if (!Number.isFinite(parsed)) {
      setLifeInput(String(life));
      return;
    }
    updateLife(parsed);
  };

  const buildGameState = async (): Promise<GameState> => {
    const res = await fetch("/FilteredCombos.json");
    const comboJson = await res.json();
    const combos = comboJson.combos;

    const battlefieldNames = battlefield.map((c) => c.card);
    const maxLandDrops = computeMaxLandDrops(battlefieldNames);

    return {
      deckId: currentDeckId,
      turn,
      life,
      commander: fullDeck[0],
      hand,
      battlefield: battlefieldNames,
      graveyard,
      exile,
      combos,
      landsPlayedThisTurn,
      maxLandDrops,
      landPlayedThisTurn: landsPlayedThisTurn >= maxLandDrops,
    };
  };

  //AI Autoplay decision making
const autoplayAI = async () => {
  try {
    const gameState = await buildGameState();
    console.log(gameState);
    const aiDecision = await getDecision(gameState);
    console.log("aiDecision:\n" + aiDecision);
    setAiDecisionText(aiDecision);
    setNotification({ message: "Decisione AI ricevuta", type: "success" });

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

  useEffect(() => {
    if (!viewerControl?.restartToken || fullDeck.length === 0) return;

    if (lastRestartTokenRef.current === null) {
      lastRestartTokenRef.current = viewerControl.restartToken;
      return;
    }

    if (lastRestartTokenRef.current === viewerControl.restartToken) return;

    lastRestartTokenRef.current = viewerControl.restartToken;
    initializeGameState(fullDeck);
    setNotification({
      message: "La partita e stata riavviata dalla SpellTable",
      type: "success",
    });
  }, [fullDeck, viewerControl?.restartToken]);

  useEffect(() => {
    const payload = {
      deckId: currentDeckId,
      turn,
      life,
      commander: fullDeck[0] ?? commandZone[0] ?? null,
      fullDeck: [...fullDeck],
      commanderTax,
      battlefieldCards: battlefield.map(({ id, card, x, y, z }) => ({
        id,
        card,
        x,
        y,
        z,
      })),
      battlefield: battlefield.map((card) => card.card),
      graveyard: [...graveyard],
      exile: [...exile],
      libraryCount: library.length,
      commandZone: [...commandZone],
      handCount: hand.length,
      hand: [...hand],
      updatedFrom: "moxfield-ui",
    };

    void fetch(`${VIEWER_STATE_URL}/viewer-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Spectator sync is optional; ignore failures in the main UI.
    });
  }, [
    battlefield,
    commandZone,
    commanderTax,
    currentDeckId,
    exile,
    fullDeck,
    graveyard,
    hand.length,
    library.length,
    life,
    turn,
  ]);

  const handleZoneViewerDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, name: string, index: number) =>
      setDragPayload(e, name, {
        offset: { x: CARD_WIDTH / 2, y: CARD_HEIGHT / 2 },
        sourceZone: { zoneKey: zoneViewer?.sourceKey ?? "hand", index },
      }),
    [zoneViewer?.sourceKey]
  );

  return (
    <div className="min-h-screen w-full bg-zinc-900 text-white flex flex-col overflow-hidden">
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="top-bar">
          <div className="top-bar__brand relative">
            <div className="mox-brand" aria-label="MOxfield">
              <span>M</span>
              <img src={moxOrb} alt="" className="mox-brand__orb" />
              <span>XFIELD</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-300">
              <span>
                {currentDeckId ? `Deck ID: ${currentDeckId}` : "Deck locale"}
              </span>
              <button
                type="button"
                onClick={() => setShowMenu((prev) => !prev)}
                className={`import-trigger ${showMenu ? "import-trigger--active" : ""}`}
                aria-label="Importa deck"
                title="Importa deck"
              >
                <img src={importIcon} alt="" className="import-trigger__icon" />
                <span
                  className={`transition-transform duration-150 ${
                    showMenu ? "rotate-180" : ""
                  }`}
                >
                  ▾
                </span>
              </button>
            </div>

            {showMenu && (
              <DeckLoadModal
                value={deckInput}
                onChange={(v) => { setDeckInput(v); setDeckImportError(null); }}
                onConfirm={() => handleLoadDeck(deckInput)}
                onCancel={() => { setShowMenu(false); setDeckImportError(null); }}
                error={deckImportError?.message}
                cloudflareBlock={deckImportError?.cloudflareBlock}
              />
            )}
          </div>
          <div className="header-side">
            <div className="header-side__top">
              <div className="life-hud">
                <label className="life-hud__display" aria-label="Punti vita">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={lifeInput}
                    onChange={(e) => setLifeInput(e.target.value.replace(/[^\d-]/g, ""))}
                    onBlur={commitLifeInput}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        commitLifeInput();
                        (e.target as HTMLInputElement).blur();
                      }
                      if (e.key === "Escape") {
                        setLifeInput(String(life));
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="life-hud__input"
                  />
                </label>
                <button
                  type="button"
                  className="life-hud__button life-hud__button--minus"
                  onClick={() => updateLife(life - 1)}
                  aria-label="Diminuisci punti vita"
                >
                  -
                </button>
                <button
                  type="button"
                  className="life-hud__button life-hud__button--plus"
                  onClick={() => updateLife(life + 1)}
                  aria-label="Aumenta punti vita"
                >
                  +
                </button>
              </div>
              <button onClick={handleTurn} className="turn-chip">Turn {turn}</button>
              <EngineManaTracker cards={battlefield.map((c) => c.card)} />
            </div>
          </div>
        </div>

        <div className="battlefield-shell">
          <div
            className={`battlefield-import ${showMenu ? "battlefield-import--active" : ""}`}
          >
            <button
              type="button"
              onClick={() => setShowMenu((prev) => !prev)}
              className={`import-trigger ${showMenu ? "import-trigger--active" : ""}`}
              aria-label="Importa deck"
              title="Importa deck"
            >
              <img src={importIcon} alt="" className="import-trigger__icon" />
            </button>
            {showMenu && (
              <DeckLoadModal
                value={deckInput}
                onChange={(v) => { setDeckInput(v); setDeckImportError(null); }}
                onConfirm={() => handleLoadDeck(deckInput)}
                onCancel={() => { setShowMenu(false); setDeckImportError(null); }}
                className="battlefield-import__modal"
                error={deckImportError?.message}
                cloudflareBlock={deckImportError?.cloudflareBlock}
              />
            )}
          </div>
          <div className="control-rail control-rail--overlay">
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
                className={`command-button ${label === "Next Turn" ? "command-button--primary" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="battlefield-shell__board">
            <Battlefield
              cards={battlefield}
              onDrop={handleDrop}
              onMove={handleBattlefieldMove}
              onDragStart={handleBattlefieldDragStart}
              onHover={handleHover}
              onLeave={handleLeave}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 px-3 py-1.5 bg-zinc-900 items-end border-t border-zinc-800 overflow-visible">
          <Hand
            cards={hand}
            onDrop={handleDrop}
            onDragStart={handleHandDragStart}
            onHover={handleHover}
            onLeave={handleLeave}
            onZoneAction={handleZoneAction}
          />

          <div className="flex gap-1.5 items-end flex-wrap">
            <Graveyard
              cards={graveyard}
              onDrop={handleDrop}
              onDragStart={handleGraveyardDragStart}
              onHover={handleHover}
              onLeave={handleLeave}
              onZoneAction={handleZoneAction}
            />
            <Exile
              cards={exile}
              onDrop={handleDrop}
              onDragStart={handleExileDragStart}
              onHover={handleHover}
              onLeave={handleLeave}
              onZoneAction={handleZoneAction}
            />
            <Library
              cards={library}
              image="src/assets/sleeve.png"
              onDrop={handleDrop}
              onDragStart={handleLibraryDragStart}
              onHover={handleHover}
              onLeave={handleLeave}
              onClick={handleDraw}
              onZoneAction={handleZoneAction}
              revealTopCard={libraryTopRevealed}
            />
            <CommanderZone
              cards={commandZone}
              commanderTax={commanderTax}
              onIncreaseTax={() => setCommanderTax((prev) => prev + 2)}
              onDrop={handleDrop}
              onDragStart={handleCommanderDragStart}
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
          cards={zoneViewer.cards}
          reverseDisplay={zoneViewer.reverseDisplay}
          indexMap={zoneViewer.indexMap}
          onClose={() => setZoneViewer(null)}
          onDragStart={handleZoneViewerDragStart}
        />
      )}
      {countPrompt && (
        <NumericPromptModal
          title={countPrompt.title}
          message={countPrompt.message}
          confirmLabel={countPrompt.confirmLabel}
          max={countPrompt.max}
          onCancel={() => setCountPrompt(null)}
          onConfirm={(value) => {
            countPrompt.onConfirm(value);
            setCountPrompt(null);
          }}
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
      {notification && (
        <div
          className={`notification-toast ${
            notification.type === "error"
              ? "notification-toast--error"
              : "notification-toast--success"
          }`}
        >
          {notification.message}
        </div>
      )}
      {aiDecisionText && (
        <div className="ai-decision-panel">
          <div className="ai-decision-panel__header">
            <div className="ai-decision-panel__title">AI Decision</div>
            <button
              type="button"
              className="ai-decision-panel__close"
              onClick={() => setAiDecisionText(null)}
            >
              Close
            </button>
          </div>
          <pre className="ai-decision-panel__body">{aiDecisionText}</pre>
        </div>
      )}
      {sharedSession?.sessionId && (
        <div className="fixed bottom-4 right-4 z-[55] w-[min(420px,calc(100vw-2rem))] rounded-2xl border border-white/12 bg-[#0f131bcc] p-3 text-white shadow-2xl backdrop-blur-md">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Linked SpellTable Session</div>
              <div className="text-[11px] text-gray-400">
                {sharedSession.sessionId.slice(0, 10)}... {isGameSessionConnected ? "connected" : "connecting"}
              </div>
              {gameState && (
                <div className="mt-1 text-[11px] text-gray-300">
                  Turn {gameState.turn} | {gameState.phase} - {gameState.phaseStep} | Active P{gameState.playerIndex}
                </div>
              )}
            </div>
            <div className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-cyan-200">
              Bridge
            </div>
          </div>

          {pendingDecision && (
            <div className="mb-3">
              <ActionPanel
                pendingDecision={pendingDecision}
                onAction={submitAction}
                onAttackPlan={submitAttackPlan}
                onBlockPlan={submitBlockPlan}
                onMulligan={submitMulligan}
                onTarget={submitTarget}
                onResponse={submitResponse}
              />
            </div>
          )}

          <div className="space-y-2">
            {aiPlayers.map((player) => (
              <div
                key={player.index}
                className="rounded-xl border border-white/8 bg-black/20 px-3 py-2"
              >
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-semibold text-gray-200">
                    AI {player.position} | Life {player.life}
                  </span>
                  <span className="text-gray-400">
                    Hand {player.handCount} | Lib {player.libraryCount}
                  </span>
                </div>
                <div className="text-[11px] leading-4 text-gray-300">
                  {player.hand?.length ? player.hand.join(", ") : "Hand unavailable"}
                </div>
              </div>
            ))}
            {aiPlayers.length === 0 && (
              <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-[11px] text-gray-400">
                Waiting for AI state...
              </div>
            )}
          </div>
        </div>
      )}
      {dialog && (
        <DialogModal
          title={dialog.title}
          message={dialog.message}
          tone={dialog.tone}
          confirmLabel={dialog.confirmLabel}
          cancelLabel={dialog.cancelLabel}
          onConfirm={dialog.onConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
