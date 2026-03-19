// components/zones/Graveyard.tsx
import React from "react";
import ZoneWrapper from "./ZoneWrapper";
import type { ZoneMenuAction } from "../ZoneMenu";
import type { CardHoverHandler } from "../../types/cards";

const GRAVEYARD_MENU_ACTIONS: ZoneMenuAction[] = [
  { key: "view", label: "View All" },
  { key: "graveyard-move-library-top", label: "Move All to Library" },
  { key: "graveyard-move-library-bottom", label: "Move All to Bottom of Library" },
  { key: "graveyard-move-exile", label: "Move All to Exile" },
  { key: "graveyard-move-hand", label: "Move All to Hand", dividerBefore: true },
  { key: "graveyard-move-creatures-hand", label: "Move All Creatures to Hand" },
  { key: "graveyard-move-lands-hand", label: "Move All Lands to Hand" },
  { key: "graveyard-move-enchantments-hand", label: "Move All Enchantments to Hand" },
  { key: "graveyard-move-artifacts-hand", label: "Move All Artifacts to Hand" },
  { key: "graveyard-move-planeswalkers-hand", label: "Move All Planeswalkers to Hand" },
];

interface Props {
  cards: string[];
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: CardHoverHandler;
  onLeave: () => void;
  onZoneAction: (action: string, fromZone: string) => void;
}

export default function Graveyard({
  cards,
  onDrop,
  onDragStart,
  onHover,
  onLeave,
  onZoneAction,
}: Props) {
  return (
    <ZoneWrapper
      label={`Graveyard (${cards.length})`}
      zoneKey="graveyard"
      cards={cards}
      onDrop={onDrop}
      onDragStart={onDragStart}
      onHover={onHover}
      onLeave={onLeave}
      availableTargets={["hand", "exile", "library"]}
      onZoneAction={onZoneAction}
      customMenuActions={GRAVEYARD_MENU_ACTIONS}
    />
  );
}
