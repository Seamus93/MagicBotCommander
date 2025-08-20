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

        // 2. Fetch card combo metadata (IDs)
        const spellbookRes = await fetch(`https://backend.commanderspellbook.com/cards?name=${encodeURIComponent(name)}`);
        const spellbookData = await spellbookRes.json();
        const cardEntry = spellbookData.results?.find(
          (entry: any) => entry.name.toLowerCase() === name.toLowerCase()
        );

        const comboIds = cardEntry?.combo_ids || [];

        // 3. If combo IDs exist, fetch matching variants
        let combos = [];
        if (comboIds.length > 0) {
          const comboRes = await fetch(`https://backend.commanderspellbook.com/variants`);
          const variantData = await comboRes.json();
          combos = variantData.filter((v: any) => comboIds.includes(v.uuid));
        }

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
    if (onHover) {
      onHover(name, e.clientX, e.clientY, cardData ?? undefined);
    }
  };

  const wrapperClass = `w-32 h-auto rounded overflow-hidden bg-zinc-700 cursor-pointer relative hover:z-50 hover:ring-4 hover:ring-blue-800/60 ${
    absolute ? "absolute" : ""
  }`;

  const style = absolute ? { left: x, top: y } : undefined;

  return (
    <div
      className={wrapperClass}
      style={style}
      draggable
      onDragStart={(e) => onDragStart?.(e, name)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onLeave}
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
