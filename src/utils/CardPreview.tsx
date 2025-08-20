// components/CardPreview.tsx
import React from "react";

interface CardPreviewProps {
  cardName: string;
}

const CardPreview: React.FC<CardPreviewProps> = ({ cardName }) => {
  const encodedName = encodeURIComponent(cardName);
  const imageUrl = `https://api.scryfall.com/cards/named?exact=${encodedName}&format=image`;

  return (
    <div
      className="fixed top-28 right-40 w-[320px] h-[445px] z-50 pointer-events-none rounded-lg bg-transparent"
    >
      <img
        src={imageUrl}
        alt={cardName}
        className="w-full h-full object-contain rounded-xl shadow-lg"
      />
    </div>
  );
};

export default CardPreview;
