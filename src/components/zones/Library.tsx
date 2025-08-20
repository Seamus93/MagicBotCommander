// components/zones/Library.tsx
import React from "react";
import ZoneWrapper from "./ZoneWrapper";

interface Props {
  cards: string[];
  image: "src/assets/sleeve.png";
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: (name: string, x: number, y: number) => void;
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
