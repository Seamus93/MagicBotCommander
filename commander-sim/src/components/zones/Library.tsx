// components/zones/Library.tsx
import React from "react";
import ZoneWrapper from "./ZoneWrapper";
import type { CardHoverHandler } from "../../types/cards";

interface Props {
  cards: string[];
  image: string;
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: CardHoverHandler;
  onLeave: () => void;
  onClick?: () => void;
  onZoneAction: (action: string, fromZone: string) => void;
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
    />
  );
}
