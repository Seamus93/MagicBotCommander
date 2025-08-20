import React from "react";
import Card from "../Card";
import ZoneMenu from "../ZoneMenu";

interface Props {
  cards: string[];
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: (name: string, x: number, y: number) => void;
  onLeave: () => void;
  onZoneAction: (action: string, fromZone: string) => void;
}

export default function Hand({
  cards,
  onDrop,
  onDragStart,
  onHover,
  onLeave,
  onZoneAction,
}: Props) {
  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex items-center gap-1 pl-1 text-xs text-zinc-400">
        Hand ({cards.length})
        <ZoneMenu
          zoneKey="hand"
          cards={cards}
          availableTargets={["library", "graveyard", "exile"]}
          onAction={onZoneAction}
        />
      </div>

      <div
        className="h-52 w-full flex items-start rounded"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDrop(e, "hand")}
      >
        {cards.map((card, i) => (
          <Card
            key={i}
            name={card}
            onDragStart={onDragStart}
            onHover={onHover}
            onLeave={onLeave}
          />
        ))}
      </div>
    </div>
  );
}
