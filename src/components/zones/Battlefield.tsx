// components/zones/Battlefield.tsx
import React, { useState } from "react";
import Card from "../Card";

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
  onHover: (name: string, x: number, y: number) => void;
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

  const handleSubmit = () => {
    if (!deckInput.trim()) return;
    onLoadDeckClick(deckInput);
    setDeckInput("");
    toggleMenu();
  };

  return (
    <div
      className="flex-1 relative p-4 bg-zinc-800 border-b border-zinc-700 overflow-hidden"
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
        <div className="absolute left-6 top-8 bg-zinc-900 p-3 rounded-lg z-20 shadow-md w-[400px]">
          <textarea
            value={deckInput}
            onChange={(e) => setDeckInput(e.target.value)}
            placeholder="Incolla qui il deck esportato da Moxfield"
            className="w-full h-40 p-2 text-sm bg-zinc-800 text-white rounded resize-none mb-2 border border-zinc-600"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={toggleMenu}
              className="px-3 py-1 text-sm rounded bg-red-600 hover:bg-red-700"
            >
              Annulla
            </button>
            <button
              onClick={handleSubmit}
              className="px-3 py-1 text-sm rounded bg-green-600 hover:bg-green-700"
            >
              Carica Mazzo
            </button>
          </div>
        </div>
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
          />
        ))
      ) : (
        <div className="text-zinc-500 text-sm italic">Drag a card here</div>
      )}
    </div>
  );
}
