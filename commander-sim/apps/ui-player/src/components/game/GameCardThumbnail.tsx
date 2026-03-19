import type { CreaturePermanent } from "../../hooks/useGameSession";

interface GameCardThumbnailProps {
  cardName: string;
  size?: "sm" | "md";
  creature?: CreaturePermanent | null;
  titleSuffix?: string;
}

const sizeClasses = {
  sm: "w-14",
  md: "w-20",
};

function cardImageUrl(cardName: string) {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(
    cardName
  )}&format=image&version=small`;
}

export default function GameCardThumbnail({
  cardName,
  size = "md",
  creature = null,
  titleSuffix,
}: GameCardThumbnailProps) {
  const title = titleSuffix ? `${cardName} • ${titleSuffix}` : cardName;

  return (
    <div className={`relative overflow-hidden rounded-lg border border-white/10 bg-gray-900 ${sizeClasses[size]}`} title={title}>
      <img
        src={cardImageUrl(cardName)}
        alt={cardName}
        className={`w-full object-cover ${creature?.tapped ? "rotate-90 scale-[0.88]" : ""}`}
      />
      {creature && (
        <div className="absolute inset-x-1 bottom-1 rounded-md bg-black/70 px-1 py-0.5 text-center text-[10px] font-semibold text-white">
          {creature.power}/{creature.toughness}
          {creature.summoningSickness ? " SS" : ""}
        </div>
      )}
    </div>
  );
}
