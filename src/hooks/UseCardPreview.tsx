import { useState, useRef } from "react";

export function useCardPreview() {
  const [hoverCardDetail, setHoverCardDetail] = useState<{
    x: number;
    y: number;
    data: any;
  } | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleHover = (name: string, x: number, y: number, data?: any) => {
    if (!data) return;

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
