// components/zones/ZoneWrapper.tsx
import React from "react";
import Card from "../Card";
import ZoneMenu from "../ZoneMenu";

export interface ZoneWrapperProps {
  label: string;
  zoneKey: string;
  cards?: string[]; // <-- può essere undefined
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: (name: string, x: number, y: number) => void;
  onLeave: () => void;
  image?: string;
  availableTargets: string[];
  showZoneMenu?: boolean;
  emptyText?: string;
  onLabelClick?: () => void;
  onZoneAction?: (action: string, fromZone: string) => void;
}

export default function ZoneWrapper({
  label,
  zoneKey,
  cards = [], // <-- fallback qui
  onDrop,
  onDragStart,
  onHover,
  onLeave,
  image,
  availableTargets,
  showZoneMenu = true,
  emptyText = "",
  onLabelClick,
  onZoneAction,
}: ZoneWrapperProps) {
  const topCard = cards[cards.length - 1];
  
  return (
    <div className="flex flex-col items-center relative py-2">
      {/* Titolo zona + menu */}
      <div className="flex items-center gap-1 mb-1">
        <div
          className={`text-xs ${
            zoneKey === "commander" ? "text-yellow-400 cursor-pointer" : "text-zinc-400"
          }`}
          onClick={onLabelClick}
        >
          {label}
        </div>

        {showZoneMenu && (
          <ZoneMenu
            zoneKey={zoneKey}
            cards={cards}
            availableTargets={availableTargets}
            onAction={onZoneAction}
          />
        )}
      </div>

      {/* Contenitore carta */}
      <div
        className="w-32 h-48 rounded overflow-hidden flex items-center justify-center bg-zinc-800"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDrop(e, zoneKey)}
        onClick={onLabelClick}
      >
        <div className="relative w-full h-full">
          {zoneKey === "library" && image && (
            <img
              src={image}
              alt="Library Sleeve"
              className="absolute inset-0 w-full h-full object-contain"
            />
          )}

          {zoneKey === "library" && cards.length > 0 && (
            <div
              className="absolute inset-0"
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/plain", cards[0])}
            />
          )}

          {zoneKey !== "library" && topCard && (
            <Card
              name={topCard}
              onDragStart={onDragStart}
              onHover={onHover}
              onLeave={onLeave}
            />
          )}

          {cards.length === 0 && (
            <span className="text-sm text-zinc-400">{emptyText}</span>
          )}
        </div>
      </div>
    </div>
  );
}
