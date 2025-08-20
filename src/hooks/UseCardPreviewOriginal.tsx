// hooks/useCardPreview.ts
import { useState, useRef } from "react";

export function useCardPreviewOriginal() {
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [showPreview, setShowPreview] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleHover = (card: string, e: React.MouseEvent) => {
    const x = e.clientX + 20;
    const y = e.clientY - 100;

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    timeoutRef.current = setTimeout(() => {
      setHoveredCard(card);
      setHoverPosition({ x, y });
      setShowPreview(true);
    }, 500); // 0.5s delay
  };

  const handleLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setShowPreview(false);
    setHoveredCard(null);
  };

  return {
    hoveredCard,
    hoverPosition,
    showPreview,
    handleHover,
    handleLeave,
  };
}
