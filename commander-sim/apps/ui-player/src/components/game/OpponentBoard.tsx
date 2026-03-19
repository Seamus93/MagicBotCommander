import type { CreaturePermanent, FilteredPlayerState } from "../../hooks/useGameSession";
import GameCardThumbnail from "./GameCardThumbnail";

interface OpponentBoardProps {
  player: FilteredPlayerState;
  compact?: boolean;
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

export default function OpponentBoard({ player, compact = false }: OpponentBoardProps) {
  const battlefieldCards = buildBattlefieldCards(player);
  const hand = player.hand ?? [];

  if (compact) {
    return (
      <div className="rounded border border-gray-600 bg-gray-800 p-2 text-xs text-white">
        <div className="mb-2 flex items-center justify-between">
          <div className="font-bold text-yellow-400">
            P{player.index} {player.position}
          </div>
          <div className="text-red-400">{player.life}</div>
        </div>
        {player.commander && (
          <div className="mb-2">
            <GameCardThumbnail cardName={player.commander} size="sm" titleSuffix="Commander" />
          </div>
        )}
        {battlefieldCards.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {battlefieldCards.slice(0, 4).map(({ key, cardName, creature }) => (
              <GameCardThumbnail
                key={key}
                cardName={cardName}
                size="sm"
                creature={creature}
              />
            ))}
          </div>
        )}
        <div className="text-gray-400">Hand: {player.handCount} | Lib: {player.libraryCount}</div>
        <div className="mt-2 rounded bg-black/20 px-2 py-1 text-[10px] leading-4 text-gray-300">
          {hand.length > 0 ? hand.join(", ") : "Hand unavailable"}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full rounded border border-gray-600 bg-gray-800 p-2 text-xs text-white">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-bold text-yellow-400">Player {player.index}</span>
        <span className="text-red-400">Life: {player.life}</span>
      </div>
      <div className="mb-2 flex gap-2 text-gray-400">
        <span>Hand: {player.handCount}</span>
        <span>Library: {player.libraryCount}</span>
        <span>GY: {player.graveyard.length}</span>
        <span>Ex: {player.exile.length}</span>
      </div>
      <div className="mb-3 rounded bg-black/20 px-2 py-1 text-[11px] leading-4 text-gray-300">
        {hand.length > 0 ? hand.join(", ") : "Hand unavailable"}
      </div>
      {player.commander && (
        <div className="mb-3">
          <div className="mb-1 text-xs text-purple-400">Commander</div>
          <GameCardThumbnail cardName={player.commander} size="md" />
        </div>
      )}
      {battlefieldCards.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-gray-500">
            Battlefield ({battlefieldCards.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {battlefieldCards.map(({ key, cardName, creature }) => (
              <GameCardThumbnail
                key={key}
                cardName={cardName}
                size="sm"
                creature={creature}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
