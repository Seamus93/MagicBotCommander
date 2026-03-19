import React, { useMemo, useState, useEffect } from "react";

interface ZoneViewerProps {
  title: string;
  cards: string[];
  onClose: () => void;
  reverseDisplay?: boolean;
  indexMap?: number[];
  onDragStart?: (
    e: React.DragEvent<HTMLDivElement>,
    name: string,
    index: number
  ) => void;
}

type ZoneEntry = {
  id: string;
  name: string;
  originalIndex: number;
};

export default function ZoneViewer({
  title,
  cards,
  onClose,
  reverseDisplay = false,
  indexMap,
  onDragStart,
}: ZoneViewerProps) {
  const entries = useMemo<ZoneEntry[]>(
    () => {
      const baseEntries = cards.map((name, index) => ({
        id: `${name}-${index}`,
        name,
        originalIndex: indexMap?.[index] ?? index,
      }));
      return reverseDisplay ? [...baseEntries].reverse() : baseEntries;
    },
    [cards, indexMap, reverseDisplay]
  );
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setSelectedEntryId(entries[0]?.id ?? null);
  }, [entries]);

  const selectedEntry =
    entries.find((entry) => entry.id === selectedEntryId) ?? entries[0] ?? null;
  const selectedName = selectedEntry?.name;
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
              {filteredEntries.map(({ id, name, originalIndex }, displayIndex) => {
                const isSelected = id === selectedEntry?.id;
                return (
                  <div
                    key={id}
                    className={`w-full px-4 py-2 border-b border-zinc-800 text-sm hover:bg-zinc-800 cursor-pointer select-none ${
                      isSelected ? "bg-zinc-800 text-sky-300" : "text-zinc-100"
                    }`}
                    draggable
                    onDragStart={(e) => onDragStart?.(e, name, originalIndex)}
                    onMouseEnter={() => setSelectedEntryId(id)}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-zinc-500 shrink-0">
                        {displayIndex + 1}
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
