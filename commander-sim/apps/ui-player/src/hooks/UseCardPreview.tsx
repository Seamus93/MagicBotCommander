import { useState, useRef } from "react";
import type { CardDetail, HoverCardDetail } from "../types/cards";

export function useCardPreview() {
  const [hoverCardDetail, setHoverCardDetail] = useState<HoverCardDetail | null>(
    null
  );
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHover = (
    _cardName: string,
    x: number,
    y: number,
    data: CardDetail
  ) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    timeoutRef.current = setTimeout(() => {
      setHoverCardDetail({ x: x + 20, y: y - 100, data });
    }, 500);
  };

  const handleLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setHoverCardDetail(null);
  };

  return {
    hoverCardDetail,
    handleHover,
    handleLeave,
  };
}
