// components/zones/Exile.tsx
import React from "react";
import ZoneWrapper from "./ZoneWrapper";
import type { ZoneMenuAction } from "../ZoneMenu";
import type { CardHoverHandler } from "../../types/cards";

const EXILE_MENU_ACTIONS: ZoneMenuAction[] = [
  { key: "view", label: "View All" },
  { key: "exile-move-library-top", label: "Move All to Library" },
  { key: "exile-move-graveyard", label: "Move All to Graveyard" },
  { key: "exile-move-hand", label: "Move All to Hand", dividerBefore: true },
  { key: "exile-move-creatures-hand", label: "Move All Creatures to Hand" },
  { key: "exile-move-lands-hand", label: "Move All Lands to Hand" },
  { key: "exile-move-enchantments-hand", label: "Move All Enchantments to Hand" },
  { key: "exile-move-artifacts-hand", label: "Move All Artifacts to Hand" },
  { key: "exile-move-planeswalkers-hand", label: "Move All Planeswalkers to Hand" },
];

interface Props {
  cards: string[];
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: CardHoverHandler;
  onLeave: () => void;
  onZoneAction: (action: string, fromZone: string) => void;
}

export default function Exile({
  cards,
  onDrop,
  onDragStart,
  onHover,
  onLeave,
  onZoneAction,
}: Props) {
  return (
    <ZoneWrapper
      label={`Exile (${cards.length})`}
      zoneKey="exile"
      cards={cards}
      onDrop={onDrop}
      onDragStart={onDragStart}
      onHover={onHover}
      onLeave={onLeave}
      availableTargets={["hand", "graveyard", "library"]}
      onZoneAction={onZoneAction}
      customMenuActions={EXILE_MENU_ACTIONS}
    />
  );
}
