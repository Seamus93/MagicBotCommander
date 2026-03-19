import React, { useLayoutEffect, useRef, useState } from "react";
import Card, { CARD_WIDTH } from "../Card";
import ZoneMenu, { type ZoneMenuAction } from "../ZoneMenu";
import ManaTracker from "../ManaTracker";
import type { CardHoverHandler } from "../../types/cards";

interface Props {
  cards: string[];
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover: CardHoverHandler;
  onLeave: () => void;
  onZoneAction: (action: string, fromZone: string) => void;
}

const MIN_VISIBLE_WIDTH = 32;

const HAND_MENU_ACTIONS: ZoneMenuAction[] = [
  { key: "hand-move-library-top", label: "Move All to Library" },
  { key: "hand-move-library-bottom", label: "Move All to Bottom of Library" },
  { key: "hand-move-graveyard", label: "Move All to Graveyard" },
  { key: "hand-move-exile", label: "Move All to Exile" },
  { key: "hand-discard-random", label: "Discard a Card Randomly", dividerBefore: true },
];

export default function Hand({
  cards,
  onDrop,
  onDragStart,
  onHover,
  onLeave,
  onZoneAction,
}: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [overlap, setOverlap] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useLayoutEffect(() => {
    const updateOverlap = () => {
      if (!rowRef.current || cards.length <= 1) {
        setOverlap(0);
        return;
      }
      const availableWidth = rowRef.current.clientWidth;
      const totalWidth = cards.length * CARD_WIDTH;
      const overflow = totalWidth - availableWidth;
      if (overflow <= 0) {
        setOverlap(0);
        return;
      }
      const rawOverlap = overflow / (cards.length - 1);
      const maxOverlap = CARD_WIDTH - MIN_VISIBLE_WIDTH;
      setOverlap(Math.min(maxOverlap, Math.max(0, rawOverlap)));
    };

    updateOverlap();
    window.addEventListener("resize", updateOverlap);
    return () => window.removeEventListener("resize", updateOverlap);
  }, [cards.length]);

  return (
    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
      <div className="flex min-h-[22px] items-center gap-3 pl-1 text-sm font-semibold">
        <div className="flex items-center gap-1">
          <span className="text-white">Hand</span>
          <span className="text-sky-400">({cards.length})</span>
          <ZoneMenu
            zoneKey="hand"
            availableTargets={["library", "graveyard", "exile"]}
            onAction={onZoneAction}
            tone="light"
            customActions={HAND_MENU_ACTIONS}
          />
        </div>
        <ManaTracker />
      </div>

      <div
        className="min-h-[136px] w-full min-w-0 flex items-start rounded overflow-visible pr-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDrop(e, "hand")}
        ref={rowRef}
      >
        {cards.map((card, i) => (
          <div
            key={`${card}-${i}`}
            style={{
              marginLeft: i === 0 ? 0 : -overlap,
              zIndex: hoveredIndex === i ? 1000 : cards.length - i,
              flexShrink: 0,
            }}
            className="transition-transform duration-200"
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <Card
              name={card}
              onDragStart={onDragStart}
              onHover={onHover}
              onLeave={onLeave}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
