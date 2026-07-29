// components/CardModal.tsx
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { CardDetail, ComboData } from "../types/cards";

interface CardModalProps {
  data: CardDetail | null;
  zoneState: Record<string, string[]>;
}

const CardModal = forwardRef<HTMLDivElement, CardModalProps>(
  ({ data, zoneState }, ref) => {
    const modalRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => modalRef.current!);
    if (!data) return null;

    const { name, mana_cost, type_line, oracle_text, combos = [] } = data;

    return (
      <div
        ref={modalRef}
        className="card-preview-scrollable absolute right-[90px] top-4 z-50 p-4 bg-zinc-800/90 text-white rounded-xl shadow-xl modal-scroll border border-zinc-600 max-h-[50vh] overflow-y-auto w-[25vw]"
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-md font-bold">{name}</h2>
          <p className="text-sm text-blue-300">{mana_cost}</p>
          <p className="text-sm text-gray-300 italic">{type_line}</p>
          <p className="text-sm mt-1 whitespace-pre-line">{oracle_text}</p>
        </div>

        {combos.length === 0 && (
          <h3 className="text-sm font-semibold mt-4">
            Nessuna Combo Disponibile
          </h3>
        )}

        {combos.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold mb-2">
              Combo disponibili: {combos.length}
            </h3>
            <ul className="space-y-3 text-sm">
              {combos.slice(0, 5).map((combo: ComboData, i: number) => (
                <li key={`${combo.description ?? "combo"}-${i}`}>
                  {combo.uses.map((use, idx) => {
                    const cardName = use.card?.name ?? "Carta sconosciuta";
                    const zones = use.zoneLocations ?? [];

                    const isPresent = Object.values(zoneState).some((zone) =>
                      zone.includes(cardName)
                    );
                    const isCorrect = zones.some((z) =>
                      (zoneState[z] ?? []).includes(cardName)
                    );

                    let colorClass = "text-zinc-300";
                    if (isCorrect) colorClass = "text-green-400 font-semibold";
                    else if (isPresent) colorClass = "text-yellow-400";
                    else colorClass = "text-zinc-500 italic";

                    return (
                      <span key={`${cardName}-${idx}`} className={colorClass}>
                        {cardName}
                        {idx < combo.uses.length - 1 && ", "}
                      </span>
                    );
                  })}

                  {" - "}
                  <span className="text-zinc-400">
                    {combo.description || "Nessuna descrizione"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
);

export default CardModal;
