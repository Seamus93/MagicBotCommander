import { useState } from "react";

const COLORS = [
  { key: "white", label: "W", icon: "https://svgs.scryfall.io/card-symbols/W.svg" },
  { key: "blue", label: "U", icon: "https://svgs.scryfall.io/card-symbols/U.svg" },
  { key: "black", label: "B", icon: "https://svgs.scryfall.io/card-symbols/B.svg" },
  { key: "red", label: "R", icon: "https://svgs.scryfall.io/card-symbols/R.svg" },
  { key: "green", label: "G", icon: "https://svgs.scryfall.io/card-symbols/G.svg" },
  { key: "colorless", label: "C", icon: "https://svgs.scryfall.io/card-symbols/C.svg" },
];

type ManaTrackerProps = {
  className?: string;
};

export default function ManaTracker({ className = "" }: ManaTrackerProps) {
  const [values, setValues] = useState<Record<string, number>>(
    COLORS.reduce<Record<string, number>>((acc, c) => {
      acc[c.key] = 0;
      return acc;
    }, {})
  );

  const updateValue = (key: string, delta: number) => {
    setValues((prev) => ({ ...prev, [key]: Math.max(0, prev[key] + delta) }));
  };

  const resetValues = () => {
    setValues(
      COLORS.reduce<Record<string, number>>((acc, c) => {
        acc[c.key] = 0;
        return acc;
      }, {})
    );
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {COLORS.map((color) => (
        <div key={color.key} className="flex flex-col items-center text-xs">
          <button
            className="text-white hover:text-sky-300 text-xs opacity-40"
            onClick={() => updateValue(color.key, -1)}
          >
            {values[color.key]}
          </button>
          <button
            className="mt-1 focus:outline-none"
            onClick={() => updateValue(color.key, 1)}
          >
            <img
              src={color.icon}
              alt={color.label}
              className="w-4 h-4 select-none pointer-events-none"
            />
          </button>
        </div>
      ))}
      <div className="relative">
        <button
          className="text-white text-xs px-2 leading-none"
          onClick={() => resetValues()}
        >
          .
        </button>
      </div>
    </div>
  );
}
