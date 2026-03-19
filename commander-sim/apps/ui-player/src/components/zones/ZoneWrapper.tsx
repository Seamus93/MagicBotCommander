// components/zones/ZoneWrapper.tsx
import React from "react";
import Card from "../Card";
import ZoneMenu, { type ZoneMenuAction } from "../ZoneMenu";
import type { CardHoverHandler } from "../../types/cards";
type ZoneMenuAlign = "right" | "left";

export interface ZoneWrapperProps {
  label: string;
  zoneKey: string;
  cards?: string[]; // <-- può essere undefined
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: CardHoverHandler;
  onLeave: () => void;
  image?: string;
  availableTargets: string[];
  showZoneMenu?: boolean;
  emptyText?: string;
  onLabelClick?: () => void;
  onZoneAction?: (action: string, fromZone: string) => void;
  customMenuActions?: ZoneMenuAction[];
  revealTopCard?: boolean;
  menuAlign?: ZoneMenuAlign;
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
  customMenuActions,
  revealTopCard = false,
  menuAlign = "right",
}: ZoneWrapperProps) {
  const topCard = cards[cards.length - 1];
  const libraryTopCard = cards[0];
  
  const labelMatch = label.match(/^(.*?)(\s*\(.*\))$/);
  const primaryLabel = labelMatch ? labelMatch[1].trim() : label;
  const suffixLabel = labelMatch ? labelMatch[2] : "";

  return (
    <div className="flex flex-col items-center relative py-1">
      {/* Titolo zona + menu */}
      <div className="mb-0.5 flex min-h-[22px] items-center gap-1 text-sm font-semibold">
        <button
          type="button"
          className={`${
            zoneKey === "commander"
              ? "text-yellow-400"
              : "text-white hover:text-sky-200"
          } transition-colors`}
          onClick={onLabelClick}
        >
          {primaryLabel}
        </button>
        {suffixLabel && (
          <span className="text-sky-400 text-sm">{suffixLabel}</span>
        )}

        {showZoneMenu && (
          <ZoneMenu
            zoneKey={zoneKey}
            availableTargets={availableTargets}
            onAction={onZoneAction}
            tone="light"
            customActions={customMenuActions}
            align={menuAlign}
          />
        )}
      </div>

      {/* Contenitore carta */}
      <div
        className="h-[8.5rem] w-24 rounded overflow-visible flex items-center justify-center bg-zinc-800"
        data-drop-zone={zoneKey}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDrop(e, zoneKey)}
        onClick={onLabelClick}
      >
        <div className="relative w-full h-full">
          {zoneKey === "library" && image && (
            <img
              src={image}
              alt="Library Sleeve"
              className={`absolute inset-0 w-full h-full object-contain ${revealTopCard ? "opacity-0" : "opacity-100"}`}
            />
          )}

          {zoneKey === "library" && revealTopCard && libraryTopCard && (
            <Card
              name={libraryTopCard}
              onDragStart={onDragStart}
              onHover={onHover}
              onLeave={onLeave}
            />
          )}

          {zoneKey === "library" && cards.length > 0 && (
            <div
              className="absolute inset-0"
              draggable
              onDragStart={(e) => {
                if (onDragStart) {
                  onDragStart(e, cards[0]);
                }
              }}
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
