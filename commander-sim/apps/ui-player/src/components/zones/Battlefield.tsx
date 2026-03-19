import React, { useRef, useCallback } from "react";
import Card, { CARD_HEIGHT as CARD_H, CARD_WIDTH as CARD_W } from "../Card";
import type { CardHoverHandler } from "../../types/cards";

interface BattlefieldCard {
  id: string;
  card: string;
  x: number;
  y: number;
  z?: number;
}

interface DragState {
  cardId: string;
  offsetX: number;
  offsetY: number;
  el: HTMLElement;
}

interface Props {
  cards: BattlefieldCard[];
  onDrop: (e: React.DragEvent<HTMLDivElement>, zoneKey: string) => void;
  onMove: (cardId: string, x: number, y: number) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, name: string, cardId?: string) => void;
  onHover: CardHoverHandler;
  onLeave: () => void;
}

export default function Battlefield({ cards, onDrop, onMove, onDragStart, onHover, onLeave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, item: BattlefieldCard) => {
      if (e.button !== 0) return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      // offset = dove nel card hai cliccato (relativo al container)
      const offsetX = e.clientX - rect.left - item.x;
      const offsetY = e.clientY - rect.top - item.y;

      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      el.style.zIndex = "9999";

      drag.current = { cardId: item.id, offsetX, offsetY, el };

      // If an HTML5 drag starts (card dragged to another zone), release pointer
      // capture so the two mechanisms don't conflict.
      const releaseOnDrag = () => {
        drag.current = null;
        el.releasePointerCapture(e.pointerId);
      };
      el.addEventListener("dragstart", releaseOnDrag, { once: true });
    },
    []
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = Math.max(0, Math.min(e.clientX - rect.left - state.offsetX, rect.width - CARD_W));
    const y = Math.max(0, Math.min(e.clientY - rect.top - state.offsetY, rect.height - CARD_H));

    // DOM diretto — zero React re-render durante il drag
    state.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);

  const commitDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state) return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = Math.max(0, Math.min(e.clientX - rect.left - state.offsetX, rect.width - CARD_W));
      const y = Math.max(0, Math.min(e.clientY - rect.top - state.offsetY, rect.height - CARD_H));

      drag.current = null;
      onMove(state.cardId, x, y); // unico aggiornamento React
    },
    [onMove]
  );

  return (
    <div
      ref={containerRef}
      className="battlefield-panel relative w-full min-h-[520px]"
      data-drop-zone="battlefield"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => onDrop(e, "battlefield")}
    >
      <div className="absolute inset-0" onDragOver={(e) => e.preventDefault()}>
        {cards.map((item, index) => (
          <div
            key={item.id}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transform: `translate3d(${item.x}px, ${item.y}px, 0)`,
              zIndex: item.z ?? index,
              willChange: "transform",
              cursor: "grab",
            }}
            onPointerDown={(e) => onPointerDown(e, item)}
            onPointerMove={onPointerMove}
            onPointerUp={commitDrag}
            onPointerCancel={commitDrag}
          >
            <Card
              name={item.card}
              cardId={item.id}
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
