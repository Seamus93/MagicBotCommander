import React, { useEffect, useState } from "react";
import type {
  CardDetail,
  ComboData,
  CardHoverHandler,
} from "../types/cards";

export interface CardProps {
  name: string;
  x?: number;
  y?: number;
  absolute?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>, name: string) => void;
  onHover?: CardHoverHandler;
  onLeave?: () => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
}

interface ScryfallCardResponse {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  image_uris?: CardDetail["image_uris"];
}

const cardCache: Record<string, CardDetail> = {};
let comboCache: ComboData[] | null = null;

const loadComboData = async (): Promise<ComboData[]> => {
  if (comboCache) return comboCache;

  const comboRes = await fetch("/FilteredCombos.json");
  if (!comboRes.ok) {
    throw new Error("Unable to load combo metadata");
  }
  const comboJson: { combos?: ComboData[] } = await comboRes.json();
  comboCache = comboJson.combos ?? [];
  return comboCache;
};

const resolveCombosForCard = async (cardName: string): Promise<ComboData[]> => {
  const combos = await loadComboData();
  return combos.filter((combo) =>
    combo.uses.some(
      (use) => use.card?.name?.toLowerCase() === cardName.toLowerCase()
    )
  );
};

const Card: React.FC<CardProps> = ({
  name,
  x = 0,
  y = 0,
  absolute = false,
  onDragStart,
  onHover,
  onLeave,
  onDrop,
  onDragOver,
}) => {
  const [cardData, setCardData] = useState<CardDetail | null>(
    cardCache[name] ?? null
  );
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    const fetchCardData = async () => {
      if (cardCache[name]) {
        setCardData(cardCache[name]);
        return;
      }

      try {
        const scryfallRes = await fetch(
          `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(
            name
          )}`
        );
        if (!scryfallRes.ok) {
          throw new Error(`Impossibile caricare i dati della carta ${name}`);
        }
        const scryfallData: ScryfallCardResponse = await scryfallRes.json();

        const combos = await resolveCombosForCard(name);
        const combinedData: CardDetail = {
          name: scryfallData.name,
          mana_cost: scryfallData.mana_cost,
          type_line: scryfallData.type_line,
          oracle_text: scryfallData.oracle_text,
          image_uris: scryfallData.image_uris,
          combos,
        };

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
    `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(
      name
    )}&format=image`;

  const handleMouseEnter = (e: React.MouseEvent) => {
    setIsHovered(true);
    if (onHover && cardData) {
      onHover(name, e.clientX, e.clientY, cardData);
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    onLeave?.();
  };

  const handleWheel = (e: React.WheelEvent) => {
    const modal = document.querySelector(".card-preview-scrollable");
    if (modal) {
      modal.scrollTop += e.deltaY;
    }
  };

  const wrapperClass = `w-32 h-auto rounded overflow-hidden bg-zinc-700 cursor-pointer relative flex-shrink-0 transition-transform duration-150 hover:scale-125 hover:z-50 hover:ring-4 hover:ring-blue-800/60 ${
    absolute ? "absolute" : ""
  }`;

  const style = absolute
    ? { left: x, top: y, zIndex: isHovered ? 1000 : undefined }
    : undefined;

  return (
    <div
      className={wrapperClass}
      style={style}
      draggable
      onDragStart={(e) => onDragStart?.(e, name)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onWheel={handleWheel}
      onDrop={onDrop}
      onDragOver={(e) => {
        onDragOver?.(e);
      }}
    >
      <img src={imageUrl} alt={name} className="w-full h-full object-contain" />
    </div>
  );
};

export default Card;
