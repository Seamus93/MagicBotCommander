import { useState } from "react";
import type { PendingDecision } from "../../hooks/useGameSession";

interface MulliganPanelProps {
  pendingDecision: PendingDecision | null;
  onMulligan: (keep: boolean, bottomCards?: string[]) => void;
}

export default function MulliganPanel({ pendingDecision, onMulligan }: MulliganPanelProps) {
  const [selectedBottom, setSelectedBottom] = useState<string[]>([]);

  if (!pendingDecision || pendingDecision.decisionType !== "mulligan") return null;

  const { context } = pendingDecision;
  const hand = context.hand ?? [];
  const mulliganCount = context.mulliganCount ?? 0;
  const bottomCount = mulliganCount; // London mulligan: put N cards on bottom

  const toggleCard = (card: string) => {
    setSelectedBottom((prev) =>
      prev.includes(card)
        ? prev.filter((c) => c !== card)
        : prev.length < bottomCount
        ? [...prev, card]
        : prev
    );
  };

  const canKeep = bottomCount === 0 || selectedBottom.length === bottomCount;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-800 border border-yellow-600 rounded-lg p-6 max-w-lg w-full">
        <h2 className="text-white text-lg font-bold mb-1">Mulligan Decision</h2>
        <p className="text-gray-400 text-sm mb-3">
          Mulligan #{mulliganCount} — Keep this hand or draw again?
          {mulliganCount > 0 && (
            <span className="text-yellow-400"> (Select {bottomCount} cards to put on bottom if keeping)</span>
          )}
        </p>

        <div className="flex flex-wrap gap-2 mb-4">
          {hand.map((card, i) => {
            const isSelected = selectedBottom.includes(card);
            return (
              <button
                key={i}
                onClick={() => bottomCount > 0 && toggleCard(card)}
                className={`px-3 py-1.5 rounded border text-sm transition-colors ${
                  isSelected
                    ? "border-red-500 bg-red-900 text-red-200"
                    : "border-gray-600 bg-gray-700 text-white hover:border-gray-400"
                } ${bottomCount === 0 ? "cursor-default" : "cursor-pointer"}`}
              >
                {card}
              </button>
            );
          })}
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => {
              if (canKeep) {
                onMulligan(true, selectedBottom.length > 0 ? selectedBottom : undefined);
                setSelectedBottom([]);
              }
            }}
            disabled={!canKeep}
            className={`flex-1 py-2 rounded font-bold text-sm transition-colors ${
              canKeep
                ? "bg-green-700 hover:bg-green-600 text-white"
                : "bg-gray-700 text-gray-500 cursor-not-allowed"
            }`}
          >
            Keep {mulliganCount > 0 && selectedBottom.length > 0 ? `(bottom ${selectedBottom.length})` : ""}
          </button>
          <button
            onClick={() => {
              onMulligan(false);
              setSelectedBottom([]);
            }}
            className="flex-1 py-2 rounded font-bold text-sm bg-red-700 hover:bg-red-600 text-white"
          >
            Mulligan
          </button>
        </div>
      </div>
    </div>
  );
}
