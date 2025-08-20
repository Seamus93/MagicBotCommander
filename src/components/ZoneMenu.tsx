// components/ZoneMenu.tsx
import React, { useRef, useEffect, useState } from "react";

interface ZoneMenuProps {
  zoneKey: string;
  onAction?: (action: string, fromZone: string) => void;
  availableTargets: string[];
  cards: CardData[];
}

export default function ZoneMenu({
  zoneKey,
  onAction,
  availableTargets,
  cards,
}: ZoneMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleAction = (action: string) => {
    if (typeof onAction === "function") {
      onAction(action, zoneKey);
    }
    setOpen(false);
  };

  return (
    <div className="relative inline-block" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="text-zinc-400 hover:text-white text-md"
      >⋮</button>

      {open && (
        <div className="absolute top-full left-2 mt-1 w-56 bg-zinc-800/90 text-sm border border-zinc-600 rounded-lg shadow-lg z-20 grid grid-cols-1 gap-1 p-2">
          {zoneKey !== "hand" && (
            <button
              className="hover:bg-zinc-700 rounded px-2 py-1 text-left"
              onClick={() => handleAction("view")}
            >
              Visualizza carte
            </button>
          )}
          {availableTargets
            .filter((target) => target !== zoneKey)
            .map((target) => (
              <button
                key={target}
                className="hover:bg-zinc-700 rounded px-2 py-1 text-left"
                onClick={() => handleAction(`move-${target}`)}
              >
                Sposta tutto in {target}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
