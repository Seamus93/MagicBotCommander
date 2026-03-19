/**
 * SpellTable quadrant — shows a player's PUBLIC zones only:
 * battlefield, graveyard, exile, commander zone, life.
 * Cards are rendered as Scryfall images.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface QuadrantPlayerData {
  label: string;
  life: number;
  commander: string | null;
  battlefield: string[];
  creatures?: Array<{
    id: string;
    name: string;
    power: number;
    toughness: number;
    tapped: boolean;
    summoningSickness: boolean;
  }>;
  graveyard: string[];
  exile: string[];
  commandZone?: string[];
  libraryCount: number;
  handCount: number;
  hand?: string[];
}

interface PlayerQuadrantProps {
  playerId: number;
  player: QuadrantPlayerData;
  rotated?: boolean;
  isActive?: boolean;
  accentColor: string;
  accentBg: string;
  accentText: string;
  onCardDoubleClick?: (cardName: string) => void;
  allCounters: Record<number, Record<PlayerCounterKey, number>>;
  commanderCounterLabels: Record<PlayerCounterKey, string>;
  onCounterChange: (playerId: number, counter: PlayerCounterKey, delta: number) => void;
}

type NonCreatureGroup = "land" | "artifact" | "support";
type PlayerCounterKey =
  | "poison"
  | "energy"
  | "experience"
  | "rad"
  | "commander1"
  | "commander2"
  | "commander3"
  | "commander4";

const BASE_PLAYER_COUNTERS: Array<{ key: PlayerCounterKey; label: string; icon: string }> = [
  { key: "poison", label: "Poison", icon: "ϕ" },
  { key: "energy", label: "Energy", icon: "⚡" },
  { key: "experience", label: "Experience", icon: "◔" },
  { key: "rad", label: "Rad", icon: "☢" },
  { key: "commander1", label: "Commander 1", icon: "⚑" },
  { key: "commander2", label: "Commander 2", icon: "⚑" },
  { key: "commander3", label: "Commander 3", icon: "⚑" },
  { key: "commander4", label: "Commander 4", icon: "⚑" },
];

const cardTypeCache = new Map<string, string>();

function cardImageUrl(name: string) {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=small`;
}

function cardAvatarUrl(name: string) {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=art_crop`;
}

function HandIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="11" y="4" width="9" height="13" rx="2.2" />
      <rect x="8" y="5.5" width="9" height="13" rx="2.2" transform="rotate(-10 8 5.5)" />
      <rect x="5.3" y="7.2" width="9" height="13" rx="2.2" transform="rotate(-20 5.3 7.2)" />
      <rect x="3.1" y="9.6" width="9" height="13" rx="2.2" transform="rotate(-31 3.1 9.6)" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="5" width="16" height="10" rx="2.4" />
      <path d="M5.5 17.2c1 .7 1.9 1 3 1h8c1.1 0 2-.3 3-1" />
      <path d="M5 19.5c1 .7 2 .9 3.2.9h7.6c1.2 0 2.2-.2 3.2-.9" />
      <path d="M4.6 21.8c1 .6 2 .8 3.2.8h8.4c1.2 0 2.2-.2 3.2-.8" />
    </svg>
  );
}

function GraveyardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7.5 21h9a2 2 0 0 0 2-2v-8.4A6.5 6.5 0 0 0 12 4a6.5 6.5 0 0 0-6.5 6.6V19a2 2 0 0 0 2 2Z" />
      <path d="M9 21v-1.5c0-.8.7-1.5 1.5-1.5h3c.8 0 1.5.7 1.5 1.5V21" />
      <path d="M12 7.2v5.8" />
      <path d="M9.3 10h5.4" />
      <path d="M6 21h12" />
    </svg>
  );
}

function PlayerAvatar({
  commander,
  accentText,
  fallbackLabel,
}: {
  commander: string | null;
  accentText: string;
  fallbackLabel: string;
}) {
  const fallbackInitial = fallbackLabel.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="relative h-9 w-9 flex-shrink-0 rounded-full border-2 border-black/55 shadow-[0_0_0_2px_rgba(255,255,255,0.08),0_8px_18px_rgba(0,0,0,0.35)] overflow-hidden bg-[#10151d]">
      {commander ? (
        <img
          src={cardAvatarUrl(commander)}
          alt={commander}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className={`flex h-full w-full items-center justify-center text-sm font-bold ${accentText}`}>
          {fallbackInitial}
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/12" />
    </div>
  );
}

function CardImage({
  name,
  tapped,
  className,
  overlay,
  onDoubleClick,
}: {
  name: string;
  tapped?: boolean;
  className?: string;
  overlay?: string;
  onDoubleClick?: (cardName: string) => void;
}) {
  return (
    <div
      className={`relative flex-shrink-0 ${className ?? ""}`}
      style={tapped ? { transform: "rotate(90deg)", margin: "8px 4px" } : undefined}
      title={name}
      onDoubleClick={() => onDoubleClick?.(name)}
    >
      <img
        src={cardImageUrl(name)}
        alt={name}
        className="w-full rounded-[3px] border border-black/40 shadow-md"
        loading="lazy"
      />
      {overlay && (
        <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-[9px] text-white text-center py-0.5 rounded-b-[3px]">
          {overlay}
        </div>
      )}
    </div>
  );
}

function useCardTypeMap(cardNames: string[]) {
  const [typeMap, setTypeMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      cardNames
        .map((name) => [name, cardTypeCache.get(name) ?? ""])
        .filter(([, typeLine]) => Boolean(typeLine))
    )
  );

  useEffect(() => {
    const uniqueNames = [...new Set(cardNames)].filter((name) => !cardTypeCache.has(name));
    if (uniqueNames.length === 0) return;

    let active = true;

    void Promise.all(
      uniqueNames.map(async (name) => {
        try {
          const response = await fetch(
            `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`
          );
          if (!response.ok) return [name, ""] as const;
          const data = (await response.json()) as { type_line?: string };
          return [name, data.type_line ?? ""] as const;
        } catch {
          return [name, ""] as const;
        }
      })
    ).then((entries) => {
      if (!active) return;

      const nextEntries = entries.filter(([, typeLine]) => Boolean(typeLine));
      if (nextEntries.length === 0) return;

      nextEntries.forEach(([name, typeLine]) => {
        cardTypeCache.set(name, typeLine);
      });

      setTypeMap((prev) => ({
        ...prev,
        ...Object.fromEntries(nextEntries),
      }));
    });

    return () => {
      active = false;
    };
  }, [cardNames]);

  return typeMap;
}

function groupNonCreatureCard(typeLine?: string): NonCreatureGroup {
  const normalized = typeLine?.toLowerCase() ?? "";

  if (normalized.includes("land")) return "land";
  if (normalized.includes("artifact")) return "artifact";
  return "support";
}

function Section({
  title,
  cards,
  className,
}: {
  title: string;
  cards: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1 text-[9px] uppercase tracking-wider text-gray-500">
        {title}
      </div>
      {cards}
    </div>
  );
}

export default function PlayerQuadrant({
  playerId,
  player,
  rotated = false,
  isActive = false,
  accentColor,
  accentBg,
  accentText,
  onCardDoubleClick,
  allCounters,
  commanderCounterLabels,
  onCounterChange,
}: PlayerQuadrantProps) {
  const [openZone, setOpenZone] = useState<"graveyard" | "exile" | null>(null);
  const [showCommanderPreview, setShowCommanderPreview] = useState(false);
  const [showCounters, setShowCounters] = useState(false);
  const countersRef = useRef<HTMLDivElement | null>(null);
  const countersPanelRef = useRef<HTMLDivElement | null>(null);
  const creatures = player.creatures ?? [];
  const handCards = player.hand ?? [];
  const creatureNames = new Set(creatures.map((c) => c.name));
  const nonCreatureBf = player.battlefield.filter((c) => !creatureNames.has(c));
  const typeMap = useCardTypeMap(nonCreatureBf);

  const groupedBattlefield = useMemo(() => {
    const lands: string[] = [];
    const artifacts: string[] = [];
    const support: string[] = [];

    nonCreatureBf.forEach((card) => {
      const group = groupNonCreatureCard(typeMap[card]);
      if (group === "land") lands.push(card);
      else if (group === "artifact") artifacts.push(card);
      else support.push(card);
    });

    return { lands, artifacts, support };
  }, [nonCreatureBf, typeMap]);

  const hasBattlefieldContent =
    creatures.length > 0 ||
    groupedBattlefield.lands.length > 0 ||
    groupedBattlefield.artifacts.length > 0 ||
    groupedBattlefield.support.length > 0;
  const sharedCounterGroups = useMemo(
    () =>
      BASE_PLAYER_COUNTERS
        .filter(
          (counter) =>
            counter.key === "poison" ||
            counter.key === "energy" ||
            counter.key === "experience" ||
            counter.key === "rad"
        )
        .map((counter) => ({
          key: counter.key as "poison" | "energy" | "experience" | "rad",
          icon: counter.icon,
          rows: [0, 1, 2, 3].map((seatIndex) => ({
            playerId: seatIndex,
            label: `P${seatIndex + 1}`,
            value: allCounters[seatIndex]?.[counter.key] ?? 0,
          })),
        })),
    [allCounters]
  );
  const commanderDamageGroups = useMemo(
    () => [
      {
        columns: [
          { key: "commander1" as const, label: commanderCounterLabels.commander1 },
          { key: "commander2" as const, label: commanderCounterLabels.commander2 },
        ],
        rows: [0, 1, 2, 3].map((seatIndex) => ({
          playerId: seatIndex,
          label: `P${seatIndex + 1}`,
          values: [
            allCounters[seatIndex]?.commander1 ?? 0,
            allCounters[seatIndex]?.commander2 ?? 0,
          ] as const,
        })),
      },
      {
        columns: [
          { key: "commander3" as const, label: commanderCounterLabels.commander3 },
          { key: "commander4" as const, label: commanderCounterLabels.commander4 },
        ],
        rows: [0, 1, 2, 3].map((seatIndex) => ({
          playerId: seatIndex,
          label: `P${seatIndex + 1}`,
          values: [
            allCounters[seatIndex]?.commander3 ?? 0,
            allCounters[seatIndex]?.commander4 ?? 0,
          ] as const,
        })),
      },
    ],
    [allCounters, commanderCounterLabels]
  );

  useEffect(() => {
    if (!showCounters) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideAvatar = countersRef.current?.contains(target);
      const insidePanel = countersPanelRef.current?.contains(target);
      if (!insideAvatar && !insidePanel) {
        setShowCounters(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [showCounters]);

  return (
    <div
      className={`relative h-full flex flex-col ${accentBg} transition-all duration-300 ${
        isActive
          ? `ring-2 ring-inset ${accentColor} shadow-[inset_0_0_36px_rgba(255,255,255,0.06),0_0_0_1px_rgba(255,255,255,0.05),0_0_24px_rgba(96,165,250,0.18)]`
          : ""
      }`}
      style={rotated ? { transform: "rotate(180deg)" } : undefined}
      onMouseLeave={() => setShowCommanderPreview(false)}
    >
      {/* Header overlay */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between px-3 py-2 bg-[linear-gradient(180deg,rgba(8,12,22,0.72)_0%,rgba(8,12,22,0.26)_62%,transparent_100%)]">
        <div className="flex items-start gap-3">
          <span className="text-red-400 text-lg font-bold">{player.life}</span>
          <div className="flex items-start gap-2">
            <div
              className="relative"
              ref={countersRef}
            >
              <button
                type="button"
                className="block rounded-full"
                onClick={() => setShowCounters((prev) => !prev)}
                aria-label={`Open counters for ${player.label} (P${playerId + 1})`}
              >
                <PlayerAvatar
                  commander={player.commander}
                  accentText={accentText}
                  fallbackLabel={player.label}
                />
              </button>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold uppercase tracking-wider ${accentText}`}>
                  {player.label}
                </span>
                {player.commander && (
                  <div className="relative">
                    <button
                      type="button"
                      className="text-[11px] font-medium text-purple-300/90 hover:text-purple-200 transition-colors"
                      onMouseEnter={() => setShowCommanderPreview(true)}
                      onFocus={() => setShowCommanderPreview(true)}
                      onBlur={() => setShowCommanderPreview(false)}
                    >
                      ({player.commander})
                    </button>
                    {showCommanderPreview && (
                      <div className="pointer-events-none absolute left-0 top-full z-20 mt-2 rounded-xl border border-white/10 bg-black/70 p-2 shadow-2xl backdrop-blur-sm">
                        <CardImage name={player.commander} className="w-28" />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-gray-400">
          <span className="flex items-center gap-1" title={`Hand ${player.handCount}`}>
            <HandIcon />
            <span>{player.handCount}</span>
          </span>
          <span className="text-white/20">|</span>
          <span className="flex items-center gap-1" title={`Library ${player.libraryCount}`}>
            <LibraryIcon />
            <span>{player.libraryCount}</span>
          </span>
          <span className="text-white/20">|</span>
          <button
            type="button"
            className="flex items-center gap-1 hover:text-white transition-colors"
            onClick={() => setOpenZone("graveyard")}
            title={`Graveyard ${player.graveyard.length}`}
          >
            <GraveyardIcon />
            <span>{player.graveyard.length}</span>
          </button>
          <span className="text-white/20">|</span>
          <button
            type="button"
            className="hover:text-white transition-colors"
            onClick={() => setOpenZone("exile")}
          >
            Ex {player.exile.length}
          </button>
        </div>
      </div>

      {showCounters && (
        <div
          ref={countersPanelRef}
          className="absolute inset-x-3 top-12 bottom-3 z-30 overflow-hidden rounded-xl border border-white/10 bg-[#111317]/95 shadow-2xl backdrop-blur-md"
        >
          <div className="grid h-full grid-cols-3 gap-1 p-1.5">
            {sharedCounterGroups.map((group) => (
              <div
                key={group.key}
                className="rounded-lg border border-white/8 bg-black/12 px-1 py-1"
              >
                <div className="mb-1 text-center text-[11px] text-zinc-300">
                  {group.icon}
                </div>
                {group.rows.map((counter) => (
                  <div
                    key={`${group.key}-${counter.playerId}`}
                    className="flex items-center gap-0.5 py-[2px]"
                  >
                    <span className="w-4 text-[10px] text-zinc-400">{counter.label}</span>
                    <span className="w-4 text-right text-[12px] font-semibold text-white">
                      {counter.value}
                    </span>
                    <button
                      type="button"
                      className="ml-auto flex h-[20px] w-[20px] items-center justify-center rounded-md bg-[#6f6776] text-[9px] font-semibold text-white hover:bg-[#817889]"
                      onClick={() => onCounterChange(counter.playerId, group.key, -1)}
                    >
                      -
                    </button>
                    <button
                      type="button"
                      className="flex h-[20px] w-[20px] items-center justify-center rounded-md bg-[#6f6776] text-[9px] font-semibold text-white hover:bg-[#817889]"
                      onClick={() => onCounterChange(counter.playerId, group.key, 1)}
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {commanderDamageGroups.map((group, groupIndex) => (
              <div
                key={`cmd-group-${groupIndex}`}
                className="rounded-lg border border-white/8 bg-black/12 px-1 py-1"
              >
                <div className="mb-1 grid grid-cols-[18px_1fr_1fr] items-center gap-1">
                  <span />
                  {group.columns.map((column) => (
                    <span
                      key={column.key}
                      className="truncate text-center text-[10px] text-zinc-300"
                      title={column.label}
                    >
                      {column.label}
                    </span>
                  ))}
                </div>
                {group.rows.map((row) => (
                  <div
                    key={`cmd-${groupIndex}-${row.playerId}`}
                    className="grid grid-cols-[18px_1fr_1fr] items-center gap-1 py-[2px]"
                  >
                    <span className="text-[10px] text-zinc-400">{row.label}</span>
                    {group.columns.map((column, columnIndex) => (
                      <div
                        key={`${column.key}-${row.playerId}`}
                        className="flex items-center justify-end gap-px"
                      >
                        <span className="w-4 text-right text-[12px] font-semibold text-white">
                          {row.values[columnIndex]}
                        </span>
                        <button
                          type="button"
                          className="flex h-[20px] w-[20px] items-center justify-center rounded-md bg-[#6f6776] text-[9px] font-semibold text-white hover:bg-[#817889]"
                          onClick={() => onCounterChange(row.playerId, column.key, -1)}
                        >
                          -
                        </button>
                        <button
                          type="button"
                          className="flex h-[20px] w-[20px] items-center justify-center rounded-md bg-[#6f6776] text-[9px] font-semibold text-white hover:bg-[#817889]"
                          onClick={() => onCounterChange(row.playerId, column.key, 1)}
                        >
                          +
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full gap-3 overflow-auto px-3 pb-3 pt-11">
          <div className="flex min-w-0 flex-1 flex-col">
            {player.hand && (
              <Section
                title={`Hand (${handCards.length})`}
                className="mb-2"
                cards={
                  <div className="rounded-lg border border-white/8 bg-black/18 px-2 py-1.5 text-[10px] leading-4 text-gray-300">
                    {handCards.length > 0 ? (
                      handCards.map((card, index) => (
                        <div key={`hand-${card}-${index}`} className="truncate" title={card}>
                          {card}
                        </div>
                      ))
                    ) : (
                      <div className="italic text-gray-500">Empty</div>
                    )}
                  </div>
                }
              />
            )}

            {creatures.length > 0 && (
              <Section
                title={`Creatures (${creatures.length})`}
                className="min-h-[4rem]"
                cards={
                  <div className="flex flex-wrap gap-1">
                    {creatures.map((c) => (
                      <CardImage
                        key={c.id}
                        name={c.name}
                        tapped={c.tapped}
                        className="w-14"
                        overlay={`${c.power}/${c.toughness}`}
                        onDoubleClick={onCardDoubleClick}
                      />
                    ))}
                  </div>
                }
              />
            )}

            {groupedBattlefield.lands.length > 0 && (
              <Section
                title={`Lands (${groupedBattlefield.lands.length})`}
                className="mt-auto"
                cards={
                  <div className="flex flex-wrap gap-1">
                    {groupedBattlefield.lands.map((card, index) => (
                      <CardImage
                        key={`land-${card}-${index}`}
                        name={card}
                        className="w-14"
                        onDoubleClick={onCardDoubleClick}
                      />
                    ))}
                  </div>
                }
              />
            )}
          </div>

          <div className="flex w-32 flex-shrink-0 flex-col">
            {groupedBattlefield.support.length > 0 && (
              <Section
                title={`Support (${groupedBattlefield.support.length})`}
                className="min-h-[4rem]"
                cards={
                  <div className="flex flex-wrap gap-1">
                    {groupedBattlefield.support.map((card, index) => (
                      <CardImage
                        key={`support-${card}-${index}`}
                        name={card}
                        className="w-14"
                        onDoubleClick={onCardDoubleClick}
                      />
                    ))}
                  </div>
                }
              />
            )}

            {groupedBattlefield.artifacts.length > 0 && (
              <Section
                title={`Rocks (${groupedBattlefield.artifacts.length})`}
                className="mt-auto"
                cards={
                  <div className="flex flex-wrap gap-1">
                    {groupedBattlefield.artifacts.map((card, index) => (
                      <CardImage
                        key={`artifact-${card}-${index}`}
                        name={card}
                        className="w-14"
                        onDoubleClick={onCardDoubleClick}
                      />
                    ))}
                  </div>
                }
              />
            )}
          </div>

          {!hasBattlefieldContent && (
            <div className="flex h-full flex-1 items-center justify-center text-xs text-gray-600">
              No permanents
            </div>
          )}
        </div>
      </div>

      {openZone && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="flex max-h-[82%] w-[min(680px,92%)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#10151d] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="text-sm font-semibold text-white">
                {openZone === "graveyard" ? `Graveyard (${player.graveyard.length})` : `Exile (${player.exile.length})`}
              </div>
              <button
                type="button"
                className="rounded-full border border-white/10 px-3 py-1 text-xs text-gray-300 hover:text-white"
                onClick={() => setOpenZone(null)}
              >
                Close
              </button>
            </div>
            <div className="overflow-auto p-4">
              <div className="flex flex-wrap gap-2">
                {(openZone === "graveyard" ? player.graveyard : player.exile).map((card, index) => (
                  <CardImage
                    key={`${openZone}-${card}-${index}`}
                    name={card}
                    className="w-20"
                    onDoubleClick={onCardDoubleClick}
                  />
                ))}
                {(openZone === "graveyard" ? player.graveyard : player.exile).length === 0 && (
                  <div className="text-sm text-gray-500">Empty</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
