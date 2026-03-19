// components/zones/Library.tsx
import React from "react";
import ZoneWrapper from "./ZoneWrapper";
import type { CardHoverHandler } from "../../types/cards";
import type { ZoneMenuAction } from "../ZoneMenu";

const LIBRARY_MENU_ACTIONS: ZoneMenuAction[] = [
  { key: "library-draw", label: "Draw", shortcut: "D" },
  { key: "library-draw-x", label: "Draw X..." },
  { key: "library-shuffle", label: "Shuffle", shortcut: "S" },
  { key: "library-view-top-card", label: "View Top Card" },
  { key: "library-view-bottom-card", label: "View Bottom Card" },
  { key: "library-view-top-x", label: "View Top X..." },
  { key: "library-view-all", label: "View All", shortcut: "V" },
  { key: "library-mill-top-x", label: "Mill Top X...", dividerBefore: true },
  { key: "library-move-graveyard", label: "Move All to Graveyard" },
  { key: "library-move-exile", label: "Move All to Exile" },
  { key: "library-toggle-top-revealed", label: "Play with Top Revealed", dividerBefore: true },
];

interface Props {
  cards: string[];
  image: string;
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: CardHoverHandler;
  onLeave: () => void;
  onClick?: () => void;
  onZoneAction: (action: string, fromZone: string) => void;
  revealTopCard?: boolean;
}

export default function Library({
  cards,
  image,
  onDrop,
  onDragStart,
  onHover,
  onLeave,
  onClick,
  onZoneAction,
  revealTopCard = false,
}: Props) {
  return (
    <ZoneWrapper
      label={`Library (${cards.length})`}
      zoneKey="library"
      cards={cards}
      image={image}
      onDrop={onDrop}
      onDragStart={onDragStart}
      onHover={onHover}
      onLeave={onLeave}
      onLabelClick={onClick}
      availableTargets={["hand", "graveyard", "exile"]}
      onZoneAction={onZoneAction}
      customMenuActions={LIBRARY_MENU_ACTIONS.map((action) =>
        action.key === "library-toggle-top-revealed"
          ? {
              ...action,
              label: revealTopCard ? "Hide Top Card" : "Play with Top Revealed",
            }
          : action
      )}
      revealTopCard={revealTopCard}
    />
  );
}
