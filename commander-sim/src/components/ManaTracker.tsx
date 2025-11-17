import React, { useState } from "react";

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

  const handleInputChange = (key: string, value: string) => {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) return;
    setValues((prev) => ({ ...prev, [key]: Math.max(0, parsed) }));
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
    <div className={`flex items-center gap-1 ${className}`}>
      {COLORS.map((color) => (
        <div key={color.key} className="flex flex-col items-center text-xs relative">
          <button
            className="text-sky-300 hover:text-white text-[10px]"
            onClick={() => updateValue(color.key, 1)}
          >
            ▲
          </button>
          <div className="relative flex items-center justify-center h-4 w-8">
            <img
              src={color.icon}
              alt={color.label}
              className="absolute inset-0 w-8 h-4 opacity-100"
            />
            <input
              value={values[color.key]}
              onChange={(e) => handleInputChange(color.key, e.target.value)}
              className="relative text-center bg-transparent border-0 text-white text-sm font-semibold focus:outline-none"
            />
          </div>
          <button
            className="text-sky-300 hover:text-white text-[10px]"
            onClick={() => updateValue(color.key, -1)}
          >
            ▼
          </button>
          <div className="mt-1" />
        </div>
      ))}
      <div className="relative">
        <button
          className="text-white text-xl px-2"
          onClick={() => resetValues()}
        >
          Reset
        </button>

      </div>
    </div>
  );
}
