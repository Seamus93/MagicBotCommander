// components/zones/Battlefield.tsx
import React, { useState } from "react";
import Card from "../Card";
import type { CardHoverHandler } from "../../types/cards";
import DeckLoadModal from "../DeckLoadModal";

interface BattlefieldCard {
  id: string;
  card: string;
  x: number;
  y: number;
}

interface Props {
  cards?: BattlefieldCard[];
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: CardHoverHandler;
  onLeave: () => void;
  onLoadDeckClick: (deckText: string) => void;
  showMenu: boolean;
  toggleMenu: () => void;
}

export default function Battlefield({
  cards = [],
  onDrop,
  onDragStart,
  onHover,
  onLeave,
  onLoadDeckClick,
  showMenu,
  toggleMenu,
}: Props) {
  const [deckInput, setDeckInput] = useState("");

  return (
    <div
      className="flex-1 relative p-4 bg-zinc-800 border-b border-zinc-700 overflow-hidden"
      data-drop-zone="battlefield"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => onDrop(e, "battlefield")}
    >
      <div
        className="text-zinc-400 mb-1 cursor-pointer"
        onClick={toggleMenu}
      >
        Battlefield ▼
      </div>

      {showMenu && (
        <DeckLoadModal
          value={deckInput}
          onChange={setDeckInput}
          onConfirm={() => {
            if (!deckInput.trim()) return;
            onLoadDeckClick(deckInput);
            setDeckInput("");
            toggleMenu();
          }}
          onCancel={toggleMenu}
        />
      )}

      {cards.length > 0 ? (
        cards.map(({ id, card, x, y }) => (
          <Card
            key={id}
            name={card}
            x={x}
            y={y}
            absolute
            onDragStart={onDragStart}
            onHover={onHover}
            onLeave={onLeave}
            onDrop={(event) => onDrop(event, "battlefield")}
            onDragOver={(event) => event.preventDefault()}
          />
        ))
      ) : (
        <div className="text-zinc-500 text-sm italic">Drag a card here</div>
      )}
    </div>
  );
}
