import React, { useEffect, useMemo, useRef, useState } from "react";

const SYMBOLS = [
  { key: "W", icon: "https://svgs.scryfall.io/card-symbols/W.svg" },
  { key: "U", icon: "https://svgs.scryfall.io/card-symbols/U.svg" },
  { key: "B", icon: "https://svgs.scryfall.io/card-symbols/B.svg" },
  { key: "R", icon: "https://svgs.scryfall.io/card-symbols/R.svg" },
  { key: "G", icon: "https://svgs.scryfall.io/card-symbols/G.svg" },
  { key: "C", icon: "https://svgs.scryfall.io/card-symbols/C.svg" },
];

type EngineManaTrackerProps = {
  cards: string[];
  className?: string;
};

type CardProduction = {
  produced: string[];
};

const buildEmptyTotals = () =>
  SYMBOLS.reduce<Record<string, number>>((acc, sym) => {
    acc[sym.key] = 0;
    return acc;
  }, {});

const parseProducedFromText = (oracleText?: string) => {
  if (!oracleText) return [];
  const lines = oracleText.split(/\r?\n/);
  const manaTokens: string[][] = [];
  lines.forEach((line) => {
    if (!/add/i.test(line)) return;
    const segments = line.split(/or/i);
    const group: string[] = [];
    segments.forEach((segment) => {
      const matches = segment.match(/\{([WUBRGC])\}/gi);
      if (!matches) return;
      matches.forEach((match) => {
        const symbol = match.replace(/[{}]/g, "").toUpperCase();
        group.push(symbol);
      });
    });
    if (group.length > 0) {
      manaTokens.push(group);
    }
  });
  return manaTokens;
};

export default function EngineManaTracker({
  cards,
  className = "",
}: EngineManaTrackerProps) {
  const cacheRef = useRef<Record<string, CardProduction>>({});
  const [totals, setTotals] = useState<Record<string, number>>(buildEmptyTotals);

  useEffect(() => {
    let mounted = true;

    const fetchCard = async (name: string) => {
      const cache = cacheRef.current;
      if (cache[name]) return cache[name];
      try {
        const response = await fetch(
          `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(
            name
          )}`
        );
        if (!response.ok) throw new Error("fetch failed");
        const data = await response.json();
        const derived = parseProducedFromText(data.oracle_text);
        const produced = derived.length > 0 ? derived : data.produced_mana ?? [];
        cache[name] = {
          produced:
            produced.length === 0 && data.type_line?.includes("Land")
              ? ["C"]
              : produced,
        };
        return cache[name];
      } catch {
        cache[name] = { produced: [] };
        return cache[name];
      }
    };

    const updateTotals = async () => {
      if (cards.length === 0) {
        if (mounted) setTotals(buildEmptyTotals());
        return;
      }
      const unique = Array.from(new Set(cards));
      await Promise.all(unique.map((name) => fetchCard(name)));

      if (!mounted) return;
      const next = buildEmptyTotals();
      cards.forEach((name) => {
        const producedGroups = cacheRef.current[name]?.produced ?? [];
        producedGroups.forEach((value) => {
          const options = Array.isArray(value) ? value : [value];
          if (options.length === 1) {
            const symbol = options[0];
            if (next[symbol] !== undefined) next[symbol] += 1;
          } else {
            options.forEach((symbol) => {
              if (next[symbol] !== undefined) next[symbol] += 1 / options.length;
            });
          }
        });
      });
      setTotals(next);
    };

    updateTotals();

    return () => {
      mounted = false;
    };
  }, [cards]);

  const displayData = useMemo(
    () =>
      SYMBOLS.map((symbol) => ({
        ...symbol,
        value: totals[symbol.key] ?? 0,
      })),
    [totals]
  );

  return (
    <div className={`flex items-center gap-2 text-white ${className}`}>
      {displayData.map((symbol) => (
        <div key={symbol.key} className="flex flex-col items-center text-xs">
          <span className="text-sm">{symbol.value}</span>
          <img
            src={symbol.icon}
            alt={symbol.key}
            className="w-6 h-6 mt-1 select-none pointer-events-none"
          />
        </div>
      ))}
    </div>
  );
}
