import type { FilteredPlayerState } from "../../hooks/useGameSession";
import OpponentBoard from "./OpponentBoard";
import HumanBoard from "./HumanBoard";

interface PlayerSeatProps {
  player: FilteredPlayerState;
  compact?: boolean;
}

export default function PlayerSeat({ player, compact = false }: PlayerSeatProps) {
  if (player.isHuman) {
    return <HumanBoard player={player} />;
  }
  return <OpponentBoard player={player} compact={compact} />;
}
