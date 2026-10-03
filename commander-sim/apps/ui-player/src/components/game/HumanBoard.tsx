import type { CreaturePermanent, FilteredPlayerState } from "../../hooks/useGameSession";
import GameCardThumbnail from "./GameCardThumbnail";

interface HumanBoardProps {
  player: FilteredPlayerState;
}

function buildBattlefieldCards(player: FilteredPlayerState) {
  const remainingCreatures = new Map<string, CreaturePermanent[]>();
  for (const creature of player.creatures) {
    const key = creature.name.toLowerCase();
    const bucket = remainingCreatures.get(key) ?? [];
    bucket.push(creature);
    remainingCreatures.set(key, bucket);
  }

  return player.battlefield.map((cardName, index) => {
    const bucket = remainingCreatures.get(cardName.toLowerCase());
    const creature = bucket?.shift() ?? null;
    return {
      key: `${cardName}-${index}`,
      cardName,
      creature,
    };
  });
}

export default function HumanBoard({ player }: HumanBoardProps) {
  const hand = player.hand ?? [];
  const battlefieldCards = buildBattlefieldCards(player);
  const isConceded = player.isConceded || player.life <= 0;

  return (
    <div className={`relative border-t border-gray-600 bg-gray-850 p-3 text-white ${isConceded ? "opacity-70" : ""}`}>
      {isConceded && (
        <div className="absolute right-3 top-3 rounded border border-red-400/40 bg-red-950/70 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-red-100">
          Conceded
        </div>
      )}
      <div className="mb-3 flex items-center gap-4 text-sm">
        <span className="font-bold text-red-400">Life: {player.life}</span>
        <span className="text-gray-400">Library: {player.libraryCount}</span>
        <span className="text-gray-400">GY: {player.graveyard.length}</span>
        <span className="text-gray-400">Exile: {player.exile.length}</span>
      </div>

      {player.commander && (
        <div className="mb-4">
          <div className="mb-1 text-xs text-purple-400">Commander</div>
          <GameCardThumbnail
            cardName={player.commander}
            size="md"
            titleSuffix="Command zone"
          />
        </div>
      )}

      {battlefieldCards.length > 0 && (
        <div className="mb-4">
          <div className="mb-1 text-xs text-gray-500">
            Battlefield ({battlefieldCards.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {battlefieldCards.map(({ key, cardName, creature }) => (
              <GameCardThumbnail
                key={key}
                cardName={cardName}
                size="md"
                creature={creature}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 text-xs text-gray-500">Hand ({hand.length})</div>
        <div className="flex flex-wrap gap-2">
          {hand.map((card, index) => (
            <GameCardThumbnail key={`${card}-${index}`} cardName={card} size="sm" />
          ))}
        </div>
      </div>
    </div>
  );
}
