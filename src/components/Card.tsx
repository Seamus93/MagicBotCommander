import React, { useEffect, useState } from "react";

interface CardProps {
  name: string;
  x?: number;
  y?: number;
  absolute?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover?: (name: string, x: number, y: number, data?: any) => void;
  onLeave?: () => void;
}

const cardCache: { [key: string]: any } = {};
const Card: React.FC<CardProps> = ({
  name,
  x = 0,
  y = 0,
  absolute = false,
  onDragStart,
  onHover,
  onLeave,
}) => {
  const [cardData, setCardData] = useState<any | null>(null);

  useEffect(() => {
    const fetchCardData = async () => {
      if (cardCache[name]) {
        setCardData(cardCache[name]);
        return;
      }

      try {
        // 1. Fetch Scryfall data
        const scryfallRes = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
        const scryfallData = await scryfallRes.json();

        // 2. Fetch local combo file once
        if (!cardCache.__combos) {
          console.log("Caricamento combo filtrate...");
          const comboRes = await fetch("/FilteredCombos.json");
          const comboJson = await comboRes.json();
          console.log("Combo caricate:", comboJson.combos.length);
          cardCache.__combos = comboJson.combos;
        }

        const combos = cardCache.__combos.filter((combo: any) =>
          combo.uses?.some((u: any) =>
            u.card?.name?.toLowerCase() === name.toLowerCase()
          )
        );

        console.log("Carta:", name);
        console.log("Combo trovate:", combos.length);
        const combinedData = { ...scryfallData, combos };
        cardCache[name] = combinedData;
        setCardData(combinedData);
      } catch (err) {
        console.error("Errore nel caricamento dati carta:", err);
      }
    };

    fetchCardData();
  }, [name]);

  const imageUrl =
    cardData?.image_uris?.normal ??
    `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image`;

    const handleMouseEnter = (e: React.MouseEvent) => {
      if (onHover && cardData) {
        onHover(name, e.clientX, e.clientY, cardData);
      }
    };

  const wrapperClass = `w-32 h-auto rounded overflow-hidden bg-zinc-700 cursor-pointer relative hover:z-50 hover:ring-4 hover:ring-blue-800/60 ${
    absolute ? "absolute" : ""
  }`;

  const style = absolute ? { left: x, top: y } : undefined;
    const handleWheel = (e: React.WheelEvent) => {
    const modal = document.querySelector(".card-preview-scrollable");
    if (modal) {
      modal.scrollTop += e.deltaY;
    }
  };
  return (
    <div
      className={wrapperClass}
      style={style}
      draggable
      onDragStart={(e) => onDragStart?.(e, name)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onLeave}
      onWheel={handleWheel}
    >
      <img
        src={imageUrl}
        alt={name}
        className={`w-full h-full object-contain transition-transform duration-150 ${
          !absolute ? "hover:scale-110" : ""
        }`}
      />
    </div>
  );
};

export default Card;
