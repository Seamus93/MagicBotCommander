// components/zones/CommanderZone.tsx
import React from "react";
import ZoneWrapper from "./ZoneWrapper";
import type { CardHoverHandler } from "../../types/cards";

interface Props {
  cards: string[];
  commanderTax: number;
  onIncreaseTax: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: CardHoverHandler;
  onLeave: () => void;
}

export default function CommanderZone({
  cards,
  commanderTax,
  onIncreaseTax,
  onDrop,
  onDragStart,
  onHover,
  onLeave,
}: Props) {
  return (
    <ZoneWrapper
      label={`Commander : (${commanderTax})`}
      zoneKey="commander"
      cards={cards}
      onDrop={onDrop}
      onDragStart={onDragStart}
      onHover={onHover}
      onLeave={onLeave}
      onLabelClick={onIncreaseTax}
      availableTargets={[]}
      showZoneMenu={false}
    />
  );
}
