// components/zones/Graveyard.tsx
import React from "react";
import ZoneWrapper from "./ZoneWrapper";

interface Props {
  cards: string[];
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: (name: string, x: number, y: number) => void;
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
    />
  );
}
