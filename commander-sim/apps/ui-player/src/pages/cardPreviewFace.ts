export interface CardPreviewFace {
  imageName?: string;
  imageFace?: "front" | "back";
}

export function cardPreviewFace(
  cardName: string | null,
  imageName?: string,
  imageFace?: "front" | "back"
): CardPreviewFace {
  if (imageName && imageFace) return { imageName, imageFace };
  if (!cardName) return {};

  const faces = cardName.split(/\s*\/\/\s*|\s+\/\s+/).filter(Boolean);
  if (faces.length !== 2) return { imageName, imageFace };

  return {
    imageName: imageName ?? cardName,
    imageFace: imageFace ?? "front",
  };
}