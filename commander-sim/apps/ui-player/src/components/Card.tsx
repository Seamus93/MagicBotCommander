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
  cardId?: string;
  zIndex?: number;
  onDragStart?: (
    e: React.DragEvent<HTMLDivElement>,
    name: string,
    cardId?: string
  ) => void;
  onHover?: CardHoverHandler;
  onLeave?: () => void;
}

export const CARD_WIDTH = 96;
export const CARD_HEIGHT = 134;

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

const CardComponent: React.FC<CardProps> = ({
  name,
  x = 0,
  y = 0,
  absolute = false,
  cardId,
  zIndex,
  onDragStart,
  onHover,
  onLeave,
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
  const wrapperClass = `h-auto rounded overflow-hidden bg-zinc-700 cursor-pointer relative flex-shrink-0 transform-gpu transition-transform duration-150 ease-out hover:scale-125 hover:z-50 hover:ring-4 hover:ring-blue-800/60 ${
    absolute ? "absolute" : ""
  }`;

  const style = absolute
    ? {
        position: "absolute" as const,
        transform: `translate3d(${x}px, ${y}px, 0)`,
        left: 0,
        top: 0,
        zIndex: isHovered ? 1000 : zIndex,
        willChange: "transform",
      }
    : undefined;

  return (
    <div
      className={wrapperClass}
      style={{ ...style, width: `${CARD_WIDTH}px` }}
      draggable
      onDragStart={(e) => onDragStart?.(e, name, cardId)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onWheel={handleWheel}
    >
      <img
        src={imageUrl}
        alt={name}
        loading="lazy"
        className="w-full h-full object-contain will-change-transform"
      />
    </div>
  );
};

const Card = React.memo(CardComponent, (prev, next) => {
  return (
    prev.name === next.name &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.absolute === next.absolute &&
    prev.onDragStart === next.onDragStart &&
    prev.onHover === next.onHover &&
    prev.onLeave === next.onLeave
  );
});

export default Card;
