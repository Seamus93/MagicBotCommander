export function visibleStackLayers(cardCount: number) {
  return Math.min(2, Math.max(0, cardCount - 1));
}