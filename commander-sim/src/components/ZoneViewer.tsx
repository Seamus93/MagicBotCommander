import React, { useMemo, useState, useEffect } from "react";

interface ZoneViewerProps {
  title: string;
  cards: string[];
  onClose: () => void;
  onDragStart?: (
    e: React.DragEvent<HTMLDivElement>,
    name: string,
    index: number
  ) => void;
}

type ZoneEntry = {
  id: string;
  name: string;
};

export default function ZoneViewer({
  title,
  cards,
  onClose,
  onDragStart,
}: ZoneViewerProps) {
  const entries = useMemo<ZoneEntry[]>(
    () => cards.map((name, index) => ({ id: `${name}-${index}`, name })),
    [cards]
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setSelectedIndex(0);
  }, [entries]);

  const selectedName = entries[selectedIndex]?.name;
  const selectedImage = selectedName
    ? `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(
        selectedName
      )}&format=image`
    : null;

  const filteredEntries = entries.filter((entry) =>
    entry.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-[70] pointer-events-none">
      <div className="absolute inset-y-0 right-0 w-[260px] max-w-[80vw] h-full bg-[#1b1b1f] border-l border-zinc-800 shadow-2xl text-white flex flex-col pointer-events-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <div className="text-lg font-semibold">{`Viewing ${title}`}</div>
          <button
            type="button"
            className="px-2 py-1 rounded-md bg-zinc-700 hover:bg-zinc-600 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {cards.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
            Nessuna carta in questa zona.
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-zinc-700">
              {selectedImage ? (
                <img
                  src={selectedImage}
                  alt={selectedName}
                  className="w-full rounded-lg border border-zinc-700"
                />
              ) : (
                <div className="text-zinc-400 text-sm">
                  Nessuna carta selezionata.
                </div>
              )}
            </div>

            <div className="px-4 py-2 border-b border-zinc-700">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter"
                className="w-full rounded-md bg-zinc-800 border border-zinc-600 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            <div className="flex-1 overflow-y-auto">
              {filteredEntries.map(({ id, name }) => {
                const index = entries.findIndex((entry) => entry.id === id);
                const isSelected = index === selectedIndex;
                return (
                  <div
                    key={id}
                    className={`w-full px-4 py-2 border-b border-zinc-800 text-sm hover:bg-zinc-800 cursor-pointer select-none ${
                      isSelected ? "bg-zinc-800 text-sky-300" : "text-zinc-100"
                    }`}
                    draggable
                    onDragStart={(e) => onDragStart?.(e, name, index)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-zinc-500 shrink-0">
                        {index + 1}
                      </span>
                      <span className="flex-1 truncate">{name}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
