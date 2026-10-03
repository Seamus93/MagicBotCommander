import { useEffect, useMemo, useRef, useState } from "react";
import bgBlue from "../../assets/spelltable/bg-blue.png";
import bgGold from "../../assets/spelltable/bg-gold.png";
import bgGreen from "../../assets/spelltable/bg-green.png";
import bgRed from "../../assets/spelltable/bg-red.png";
import avatarBlue from "../../assets/new-game/avatar-frames/frame-blue.png";
import avatarGold from "../../assets/new-game/avatar-frames/frame-gold.png";
import avatarGreen from "../../assets/new-game/avatar-frames/frame-green.png";
import avatarRed from "../../assets/new-game/avatar-frames/frame-red.png";
import iconCommand from "../../assets/spelltable/icon-command.png";
import iconExile from "../../assets/spelltable/icon-exile.png";
import iconGraveyard from "../../assets/spelltable/icon-graveyard.png";
import iconHand from "../../assets/spelltable/icon-hand.png";
import iconLibrary from "../../assets/spelltable/icon-library.png";
import sleeve from "../../assets/sleeve.png";

export interface QuadrantPlayerData {
  label: string;
  life: number;
  commander: string | null;
  battlefield: string[];
  battlefieldPermanents?: Array<{ name: string; tapped: boolean }>;
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
  isConceded?: boolean;
}

type PlayerCounterKey =
  | "poison"
  | "energy"
  | "experience"
  | "rad"
  | "commander1"
  | "commander2"
  | "commander3"
  | "commander4";

interface PlayerQuadrantProps {
  playerId: number;
  player: QuadrantPlayerData;
  rotated?: boolean;
  isActive?: boolean;
  accentColor: string;
  accentBg: string;
  accentText: string;
  onCardDoubleClick?: (cardName: string) => void;
  onCardInspect?: (cardName: string | null) => void;
  allCounters: Record<number, Record<PlayerCounterKey, number>>;
  commanderCounterLabels: Record<PlayerCounterKey, string>;
  onCounterChange: (playerId: number, counter: PlayerCounterKey, delta: number) => void;
}

type BattlefieldCard = {
  name: string;
  tapped?: boolean;
  overlay?: string;
  keyHint?: string;
};

type Theme = {
  name: string;
  accent: string;
  accentSoft: string;
  accentDim: string;
  text: string;
  glow: string;
  background: string;
  avatarFrame: string;
  landscape: string;
  vignette: string;
};

const THEMES: Theme[] = [
  {
    name: "crimson",
    accent: "#f87171",
    accentSoft: "rgba(248,113,113,.26)",
    accentDim: "rgba(127,29,29,.42)",
    text: "text-red-100",
    glow: "rgba(248,113,113,.34)",
    background: bgRed,
    avatarFrame: avatarRed,
    landscape:
      "radial-gradient(circle at 12% 18%, rgba(248,113,113,.26), transparent 28%), radial-gradient(circle at 72% 52%, rgba(245,158,11,.14), transparent 31%)",
    vignette: "linear-gradient(120deg, rgba(25,4,9,.82), rgba(10,13,22,.76) 44%, rgba(12,6,7,.88))",
  },
  {
    name: "emerald",
    accent: "#34d399",
    accentSoft: "rgba(52,211,153,.24)",
    accentDim: "rgba(6,78,59,.42)",
    text: "text-emerald-100",
    glow: "rgba(52,211,153,.28)",
    background: bgGreen,
    avatarFrame: avatarGreen,
    landscape:
      "radial-gradient(circle at 18% 18%, rgba(52,211,153,.22), transparent 30%), radial-gradient(circle at 82% 42%, rgba(14,165,233,.12), transparent 34%)",
    vignette: "linear-gradient(120deg, rgba(3,35,29,.84), rgba(8,17,22,.75) 48%, rgba(4,22,18,.9))",
  },
  {
    name: "amber",
    accent: "#fbbf24",
    accentSoft: "rgba(251,191,36,.27)",
    accentDim: "rgba(146,64,14,.38)",
    text: "text-amber-100",
    glow: "rgba(251,146,60,.34)",
    background: bgGold,
    avatarFrame: avatarGold,
    landscape:
      "radial-gradient(circle at 20% 28%, rgba(251,191,36,.24), transparent 31%), radial-gradient(circle at 74% 50%, rgba(248,113,22,.17), transparent 34%)",
    vignette: "linear-gradient(120deg, rgba(49,29,7,.82), rgba(16,14,12,.72) 44%, rgba(58,32,10,.9))",
  },
  {
    name: "violet",
    accent: "#a78bfa",
    accentSoft: "rgba(167,139,250,.25)",
    accentDim: "rgba(49,46,129,.42)",
    text: "text-violet-100",
    glow: "rgba(96,165,250,.32)",
    background: bgBlue,
    avatarFrame: avatarBlue,
    landscape:
      "radial-gradient(circle at 18% 16%, rgba(96,165,250,.22), transparent 31%), radial-gradient(circle at 78% 46%, rgba(167,139,250,.16), transparent 35%)",
    vignette: "linear-gradient(120deg, rgba(8,22,48,.84), rgba(9,13,24,.76) 46%, rgba(27,20,55,.9))",
  },
];

const BASE_PLAYER_COUNTERS: Array<{ key: PlayerCounterKey; label: string; icon: string }> = [
  { key: "poison", label: "Poison", icon: "P" },
  { key: "energy", label: "Energy", icon: "E" },
  { key: "experience", label: "Experience", icon: "XP" },
  { key: "rad", label: "Rad", icon: "R" },
  { key: "commander1", label: "Commander 1", icon: "C1" },
  { key: "commander2", label: "Commander 2", icon: "C2" },
  { key: "commander3", label: "Commander 3", icon: "C3" },
  { key: "commander4", label: "Commander 4", icon: "C4" },
];

const cardTypeCache = new Map<string, string>();
const KNOWN_LAND_NAMES = new Set(
  [
    "Plains",
    "Island",
    "Swamp",
    "Mountain",
    "Forest",
    "Command Tower",
    "Exotic Orchard",
    "Reflecting Pool",
    "Watery Grave",
    "Blood Crypt",
    "Steam Vents",
    "Luxury Suite",
    "Training Center",
    "Xander's Lounge",
    "Graven Cairns",
    "Sunken Ruins",
    "Command Beacon",
    "Reliquary Tower",
    "Ancient Tomb",
    "Mana Confluence",
    "City of Brass",
  ].map((name) => name.toLowerCase())
);

function cardImageUrl(name: string, version: "small" | "normal" | "art_crop" = "small") {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=${version}`;
}

function themeForPlayer(playerId: number) {
  if (playerId === 0) return THEMES[0];
  if (playerId === 1) return THEMES[1];
  if (playerId === 2) return THEMES[2];
  return THEMES[3];
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
      nextEntries.forEach(([name, typeLine]) => cardTypeCache.set(name, typeLine));
      if (nextEntries.length) {
        setTypeMap((prev) => ({ ...prev, ...Object.fromEntries(nextEntries) }));
      }
    });

    return () => {
      active = false;
    };
  }, [cardNames]);

  return typeMap;
}

function isLandCard(name: string, typeLine?: string) {
  const normalizedName = name.toLowerCase();
  return (
    (typeLine ?? "").toLowerCase().includes("land") ||
    normalizedName.includes("land") ||
    KNOWN_LAND_NAMES.has(normalizedName)
  );
}

function compactName(name: string) {
  return name.length > 26 ? `${name.slice(0, 24)}...` : name;
}

function PlayerAvatar({
  commander,
  label,
  life,
  theme,
  onClick,
  onInspect,
}: {
  commander: string | null;
  label: string;
  life: number;
  theme: Theme;
  onClick: () => void;
  onInspect?: (cardName: string | null) => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const fallbackInitial = label.trim().charAt(0).toUpperCase() || "?";
  const commanderArtName = commander && commander !== "Commander" && !imageFailed ? commander : null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open counters for ${label}`}
      className="group relative h-[clamp(76px,6.4vw,104px)] w-[clamp(76px,6.4vw,104px)] shrink-0 rounded-full transition duration-200 hover:scale-[1.03]"
      onMouseEnter={() => commander && onInspect?.(commander)}
      onFocus={() => commander && onInspect?.(commander)}
    >
      <img
        src={theme.avatarFrame}
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-contain drop-shadow-[0_10px_18px_rgba(0,0,0,.45)]"
        loading="lazy"
      />
      <div className="absolute left-[18%] right-[18%] top-[13%] bottom-[35%] overflow-hidden rounded-full bg-[#111827]">
        {commanderArtName ? (
          <img
            src={cardImageUrl(commanderArtName, "art_crop")}
            alt={commanderArtName}
            className="h-full w-full object-cover"
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_50%_28%,rgba(255,255,255,.12),rgba(15,23,42,.95)_68%)] text-2xl font-bold text-white">
            {fallbackInitial}
          </div>
        )}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,transparent_42%,rgba(0,0,0,.44)_100%)]" />
      </div>
      <div
        className="absolute bottom-[10%] left-1/2 flex h-[clamp(30px,2.55vw,42px)] min-w-[clamp(38px,3vw,50px)] -translate-x-1/2 items-center justify-center rounded-full px-2 text-[clamp(1.05rem,1.55vw,1.6rem)] font-black leading-none text-white shadow-[0_8px_18px_rgba(0,0,0,.55)]"
        style={{ textShadow: "0 2px 4px rgba(0,0,0,.75)" }}
      >
        {life}
      </div>
    </button>
  );
}

function ZoneCounters({
  player,
  commandTax,
  onOpenZone,
  theme,
}: {
  player: QuadrantPlayerData;
  commandTax: number;
  onOpenZone: (zone: "graveyard" | "exile") => void;
  theme: Theme;
}) {
  const items = [
    { label: "Library", value: player.libraryCount, title: "Library", icon: iconLibrary },
    { label: "Grave", value: player.graveyard.length, title: "Graveyard", icon: iconGraveyard, action: () => onOpenZone("graveyard") },
    { label: "Exile", value: player.exile.length, title: "Exile", icon: iconExile, action: () => onOpenZone("exile") },
    { label: "Command", value: commandTax > 0 ? `+${commandTax}` : "+0", title: "Commander tax", icon: iconCommand },
  ];

  return (
    <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-white/10 bg-black/34 text-center shadow-[0_8px_18px_rgba(0,0,0,.28)] backdrop-blur-md">
      {items.map((item) => {
        const content = (
          <>
            <img src={item.icon} alt="" className="mx-auto mb-0.5 h-3.5 w-4 object-contain opacity-80" loading="lazy" />
            <div className="text-[clamp(.78rem,.86vw,1rem)] font-black leading-none text-white drop-shadow">
              {item.value}
            </div>
            <div className="mt-0.5 truncate text-[8px] uppercase tracking-[.06em] text-slate-300/68">
              {item.label}
            </div>
          </>
        );

        return item.action ? (
          <button
            key={item.label}
            type="button"
            title={item.title}
            onClick={item.action}
            className="min-w-0 border-r border-white/8 px-1.5 py-1.5 transition hover:bg-white/8"
          >
            {content}
          </button>
        ) : (
          <div
            key={item.label}
            title={item.title}
            className="min-w-0 border-r border-white/8 px-1.5 py-1.5 last:border-r-0"
            style={item.label === "Command" ? { color: theme.accent } : undefined}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}

function GameCard({
  card,
  theme,
  onDoubleClick,
  onInspect,
}: {
  card: BattlefieldCard;
  theme: Theme;
  onDoubleClick?: (cardName: string) => void;
  onInspect?: (cardName: string | null) => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <div
      className="group relative shrink-0"
      title={card.name}
      onDoubleClick={() => onDoubleClick?.(card.name)}
      onMouseEnter={() => onInspect?.(card.name)}
      onFocus={() => onInspect?.(card.name)}
    >
      <div
        tabIndex={0}
        className={`relative aspect-[63/88] w-[clamp(68px,4.8vw,102px)] rounded-[8px] border border-black/75 bg-[#111827] shadow-[0_14px_24px_rgba(0,0,0,.58),0_2px_0_rgba(255,255,255,.05)] transition duration-200 group-hover:z-30 group-hover:-translate-y-1.5 group-hover:scale-[1.08] group-hover:shadow-[0_22px_36px_rgba(0,0,0,.72),0_0_22px_rgba(255,255,255,.16)] focus:outline-none focus:ring-2 focus:ring-cyan-200/80 ${
          card.tapped ? "rotate-90" : ""
        }`}
        style={{ transformOrigin: "50% 50%" }}
      >
        {imageFailed ? (
          <div className="flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-[7px] bg-[#121826] p-2 text-center">
            <img src={sleeve} alt="" className="absolute inset-0 h-full w-full object-cover opacity-20" loading="lazy" />
            <div className="relative text-[clamp(10px,.7vw,13px)] font-bold leading-tight text-slate-100">
              {card.name}
            </div>
          </div>
        ) : (
          <img
            src={cardImageUrl(card.name)}
            alt={card.name}
            className="h-full w-full rounded-[7px] object-cover"
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        )}
        <div className="pointer-events-none absolute inset-0 rounded-[8px] ring-1 ring-white/12 group-hover:ring-2" style={{ boxShadow: `inset 0 0 0 1px rgba(255,255,255,.08), 0 0 18px ${theme.glow}` }} />
        {card.overlay && (
          <div className="absolute bottom-1 right-1 rounded-md border border-black/70 bg-slate-100 px-1.5 py-0.5 text-[10px] font-black leading-none text-slate-950 shadow">
            {card.overlay}
          </div>
        )}
      </div>
    </div>
  );
}

function CardStack({
  cards,
  theme,
  maxVisible = 18,
  onCardDoubleClick,
  onInspect,
}: {
  cards: BattlefieldCard[];
  theme: Theme;
  maxVisible?: number;
  onCardDoubleClick?: (cardName: string) => void;
  onInspect?: (cardName: string | null) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, BattlefieldCard[]>();
    cards.forEach((card) => {
      const key = `${card.name}|${card.tapped ? "t" : "u"}|${card.overlay ?? ""}`;
      map.set(key, [...(map.get(key) ?? []), card]);
    });
    return Array.from(map.values());
  }, [cards]);

  if (!cards.length) {
    return <div className="h-[clamp(58px,7vh,96px)]" />;
  }

  const overlapClass =
    groups.length > 12
      ? "-mr-[54px] last:mr-0"
      : groups.length > 8
        ? "-mr-[38px] last:mr-0"
        : groups.length > 5
          ? "-mr-[22px] last:mr-0"
          : "";

  return (
    <div className="flex min-w-0 flex-wrap items-start gap-y-3 overflow-visible pr-3">
      {groups.slice(0, maxVisible).map((group, index) => {
        const card = group[0];
        const count = group.length;
        return (
          <div key={`${card.name}-${index}`} className={`relative transition-[margin] duration-200 ${overlapClass}`}>
            {count > 1 && (
              <>
                <div className="absolute left-1.5 top-1.5 aspect-[63/88] w-[clamp(68px,4.8vw,102px)] rounded-[8px] border border-black/55 bg-black/50" />
                <div className="absolute left-3 top-3 aspect-[63/88] w-[clamp(68px,4.8vw,102px)] rounded-[8px] border border-black/55 bg-black/40" />
              </>
            )}
            <GameCard
              card={card}
              theme={theme}
              onDoubleClick={onCardDoubleClick}
              onInspect={onInspect}
            />
            {count > 1 && (
              <div
                className="absolute -right-2 -top-2 z-20 rounded-full border border-black/60 px-1.5 py-0.5 text-[10px] font-black text-white shadow"
                style={{ backgroundColor: theme.accent }}
              >
                x{count}
              </div>
            )}
          </div>
        );
      })}
      {groups.length > maxVisible && (
        <div className="flex aspect-[63/88] w-[clamp(68px,4.8vw,102px)] items-center justify-center rounded-[8px] border border-white/10 bg-black/40 text-xs font-bold text-slate-300">
          +{groups.length - maxVisible}
        </div>
      )}
    </div>
  );
}

function BattlefieldLane({
  title,
  count,
  cards,
  theme,
  onCardDoubleClick,
  onInspect,
}: {
  title: string;
  count: number;
  cards: BattlefieldCard[];
  theme: Theme;
  onCardDoubleClick?: (cardName: string) => void;
  onInspect?: (cardName: string | null) => void;
}) {
  return (
    <section className="min-h-0">
      <div className="mb-1 flex items-center gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[.16em] text-slate-200/86">
          {title}
        </div>
        <div className="rounded-full border border-white/10 bg-black/28 px-1.5 py-px text-[10px] font-semibold text-slate-300">
          {count}
        </div>
      </div>
      <CardStack
        cards={cards}
        theme={theme}
        onCardDoubleClick={onCardDoubleClick}
        onInspect={onInspect}
      />
    </section>
  );
}

function HandPanel({
  cards,
  count,
  onInspect,
}: {
  cards: string[];
  count: number;
  onInspect?: (cardName: string | null) => void;
}) {
  const visibleCards = cards.slice(0, 8);
  return (
    <aside className="w-[clamp(118px,14%,150px)] shrink-0 self-stretch rounded-xl border border-white/10 bg-black/38 p-2 shadow-[0_10px_22px_rgba(0,0,0,.32)] backdrop-blur-md">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[.16em] text-slate-200/88">
        <span className="inline-flex items-center gap-1.5">
          <img src={iconHand} alt="" className="h-4 w-5 object-contain opacity-80" loading="lazy" />
          Hand ({count})
        </span>
      </div>
      <div className="space-y-1">
        {visibleCards.length > 0 ? (
          visibleCards.map((card, index) => (
            <div
              key={`${card}-${index}`}
              title={card}
              className="flex items-center gap-1.5 rounded-md border border-white/6 bg-white/[.04] px-1.5 py-0.5 text-[clamp(9px,.62vw,11px)] text-slate-100 shadow-inner"
              onMouseEnter={() => onInspect?.(card)}
              onFocus={() => onInspect?.(card)}
              tabIndex={0}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded bg-slate-200/80 text-[9px] font-black text-slate-900">
                *
              </span>
              <span className="truncate">{card}</span>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-white/6 bg-white/[.035] px-2 py-3 text-center text-[11px] text-slate-400">
            {count > 0 ? (
              <div className="flex flex-col items-center gap-2">
                <div className="relative h-12 w-16">
                  {Array.from({ length: Math.min(count, 4) }, (_, index) => (
                    <img
                      key={index}
                      src={sleeve}
                      alt=""
                      className="absolute top-0 h-12 w-8 rounded-[3px] object-cover shadow"
                      style={{ left: `${index * 10}px`, zIndex: index }}
                      loading="lazy"
                    />
                  ))}
                </div>
                <span className="font-semibold uppercase tracking-[.08em]">Hand {count}</span>
              </div>
            ) : (
              <span className="italic">Hidden</span>
            )}
          </div>
        )}
        {cards.length > visibleCards.length && (
          <div className="pt-1 text-center text-[10px] text-slate-400">
            +{cards.length - visibleCards.length} more
          </div>
        )}
      </div>
    </aside>
  );
}

function CounterPanel({
  playerId,
  allCounters,
  commanderCounterLabels,
  onCounterChange,
}: {
  playerId: number;
  allCounters: Record<number, Record<PlayerCounterKey, number>>;
  commanderCounterLabels: Record<PlayerCounterKey, string>;
  onCounterChange: (playerId: number, counter: PlayerCounterKey, delta: number) => void;
}) {
  const counters = BASE_PLAYER_COUNTERS.map((counter) => ({
    ...counter,
    label: counter.key.startsWith("commander")
      ? commanderCounterLabels[counter.key]
      : counter.label,
    value: allCounters[playerId]?.[counter.key] ?? 0,
  }));

  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      {counters.map((counter) => (
        <div key={counter.key} className="rounded-xl border border-white/10 bg-white/[.045] p-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-[10px] uppercase tracking-[.12em] text-slate-300" title={counter.label}>
              {counter.label}
            </span>
            <span className="text-sm font-black text-white">{counter.value}</span>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <button type="button" className="rounded-lg bg-white/10 py-1 text-xs text-white hover:bg-white/16" onClick={() => onCounterChange(playerId, counter.key, -1)}>
              -
            </button>
            <button type="button" className="rounded-lg bg-white/10 py-1 text-xs text-white hover:bg-white/16" onClick={() => onCounterChange(playerId, counter.key, 1)}>
              +
            </button>
          </div>
        </div>
      ))}
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
  onCardInspect,
  allCounters,
  commanderCounterLabels,
  onCounterChange,
}: PlayerQuadrantProps) {
  const [openZone, setOpenZone] = useState<"graveyard" | "exile" | null>(null);
  const [showCounters, setShowCounters] = useState(false);
  const countersRef = useRef<HTMLDivElement | null>(null);
  const theme = themeForPlayer(playerId);
  void accentColor;
  void accentBg;
  void accentText;

  const creatures = player.creatures ?? [];
  const creatureNames = new Set(creatures.map((creature) => creature.name));
  const battlefieldPermanents =
    player.battlefieldPermanents ??
    player.battlefield.map((name) => ({ name, tapped: false }));
  const nonCreaturePermanents = battlefieldPermanents.filter((card) => !creatureNames.has(card.name));
  const typeMap = useCardTypeMap(nonCreaturePermanents.map((card) => card.name));
  const commandTax = Math.max(0, ((player.commandZone?.length ?? 0) - 1) * 2);

  const battlefield = useMemo(() => {
    const lands: BattlefieldCard[] = [];
    const permanents: BattlefieldCard[] = creatures.map((creature) => ({
      name: creature.name,
      tapped: creature.tapped,
      overlay: `${creature.power}/${creature.toughness}`,
      keyHint: creature.id,
    }));

    nonCreaturePermanents.forEach((card) => {
      if (isLandCard(card.name, typeMap[card.name])) lands.push(card);
      else permanents.push(card);
    });

    return { lands, permanents };
  }, [creatures, nonCreaturePermanents, typeMap]);

  useEffect(() => {
    if (!showCounters) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!countersRef.current?.contains(target)) {
        setShowCounters(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [showCounters]);

  const backgroundImage = [
    theme.vignette,
    theme.landscape,
    `url("${theme.background}")`,
  ].join(", ");
  const isConceded = player.isConceded || player.life <= 0;

  return (
    <div
      className={`group/quadrant relative h-full overflow-hidden text-white ${isActive ? "is-active" : ""} ${isConceded ? "opacity-75" : ""}`}
      style={rotated ? { transform: "rotate(180deg)" } : undefined}
    >
      <div
        className="absolute inset-0 bg-cover bg-center opacity-95"
        style={{ backgroundImage }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_63%_54%,rgba(255,255,255,.16),transparent_36%),radial-gradient(ellipse_at_56%_78%,rgba(255,255,255,.10),transparent_38%),linear-gradient(180deg,rgba(0,0,0,.2)_0%,rgba(0,0,0,.06)_35%,rgba(0,0,0,.48)_100%)]" />
      <div
        className="absolute inset-0 border transition duration-300"
        style={{
          borderColor: isActive ? theme.accent : "rgba(255,255,255,.10)",
          boxShadow: isActive
            ? `inset 0 0 0 1px ${theme.accentSoft}, inset 0 0 54px ${theme.accentDim}, 0 0 28px ${theme.glow}`
            : "inset 0 1px 0 rgba(255,255,255,.08)",
        }}
      />

      <div className="relative z-10 flex h-full min-h-0 flex-col p-[clamp(8px,.9vw,14px)]">
        <header className="flex shrink-0 items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <div ref={countersRef} className="relative">
              <PlayerAvatar
                commander={player.commander}
                label={player.label}
                life={player.life}
                theme={theme}
                onClick={() => setShowCounters((value) => !value)}
                onInspect={onCardInspect}
              />
              {showCounters && (
                <div className="absolute left-0 top-full z-50 mt-4 w-72 overflow-hidden rounded-2xl border border-white/12 bg-[#0b1018]/95 shadow-2xl backdrop-blur-xl">
                  <CounterPanel
                    playerId={playerId}
                    allCounters={allCounters}
                    commanderCounterLabels={commanderCounterLabels}
                    onCounterChange={onCounterChange}
                  />
                </div>
              )}
            </div>
            <div className="min-w-0 pt-0.5">
              <div
                className="truncate text-[clamp(1rem,1.25vw,1.45rem)] font-black uppercase leading-tight tracking-wide"
                style={{ color: theme.accent, textShadow: `0 0 16px ${theme.glow}` }}
              >
                {player.label}
              </div>
              <div className="mt-0.5 max-w-[min(20vw,320px)] truncate text-[clamp(.72rem,.78vw,.95rem)] font-medium text-white/92">
                <span
                  onMouseEnter={() => player.commander && onCardInspect?.(player.commander)}
                  onFocus={() => player.commander && onCardInspect?.(player.commander)}
                  tabIndex={player.commander ? 0 : -1}
                >
                  {player.commander ?? "Commander"}
                </span>
              </div>
              <div className="mt-1.5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/28 px-2 py-0.5 text-[9px] uppercase tracking-[.16em] text-slate-300 backdrop-blur">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: theme.accent }} />
                {isConceded ? "Conceded" : isActive ? "Active turn" : theme.name}
              </div>
            </div>
          </div>

          <div className="flex min-w-[clamp(185px,19vw,310px)] max-w-[38%] items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <ZoneCounters
                player={player}
                commandTax={commandTax}
                onOpenZone={setOpenZone}
                theme={theme}
              />
            </div>
            <button
              type="button"
              className="flex h-7 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/38 text-base leading-none text-white/80 shadow-lg backdrop-blur transition hover:bg-white/10"
              title="Player menu"
            >
              ...
            </button>
          </div>
        </header>

        <main className="mt-[clamp(7px,1vh,12px)] flex min-h-0 flex-1 gap-[clamp(8px,.75vw,14px)]">
          {player.hand && <HandPanel cards={player.hand} count={player.handCount} onInspect={onCardInspect} />}
          {!player.hand && <HandPanel cards={[]} count={player.handCount} onInspect={onCardInspect} />}

          <div className="grid min-w-0 flex-1 grid-rows-2 gap-[clamp(10px,1.4vh,16px)]">
            <BattlefieldLane
              title="Lands"
              count={battlefield.lands.length}
              cards={battlefield.lands}
              theme={theme}
              onCardDoubleClick={onCardDoubleClick}
              onInspect={onCardInspect}
            />
            <BattlefieldLane
              title="Permanents"
              count={battlefield.permanents.length}
              cards={battlefield.permanents}
              theme={theme}
              onCardDoubleClick={onCardDoubleClick}
              onInspect={onCardInspect}
            />
          </div>
        </main>

        {!battlefield.lands.length && !battlefield.permanents.length && (
          <div className="pointer-events-none absolute bottom-5 right-6 z-10 rounded-full border border-white/8 bg-black/22 px-3 py-1 text-[10px] uppercase tracking-[.18em] text-white/34 backdrop-blur-sm">
            Battlefield ready
          </div>
        )}
      </div>

      {isConceded && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/46 backdrop-grayscale">
          <div className="border border-red-300/40 bg-black/70 px-6 py-3 text-center text-sm font-black uppercase tracking-[0.28em] text-red-100 shadow-2xl">
            Conceded
          </div>
        </div>
      )}

      {openZone && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/72 p-5 backdrop-blur-md">
          <div className="flex max-h-full w-[min(760px,94%)] flex-col overflow-hidden rounded-2xl border border-white/12 bg-[#0b1018]/96 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <div className="text-[10px] uppercase tracking-[.18em] text-slate-400">{player.label}</div>
                <div className="text-sm font-bold text-white">
                  {openZone === "graveyard" ? `Graveyard (${player.graveyard.length})` : `Exile (${player.exile.length})`}
                </div>
              </div>
              <button
                type="button"
                className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/10"
                onClick={() => setOpenZone(null)}
              >
                Close
              </button>
            </div>
            <div className="overflow-auto p-4">
              <div className="flex flex-wrap gap-3">
                {(openZone === "graveyard" ? player.graveyard : player.exile).map((card, index) => (
                  <div key={`${openZone}-${card}-${index}`} className="w-20">
                    <GameCard
                      card={{ name: card }}
                      theme={theme}
                      onDoubleClick={onCardDoubleClick}
                      onInspect={onCardInspect}
                    />
                    <div className="mt-1 truncate text-center text-[10px] text-slate-300" title={card}>
                      {compactName(card)}
                    </div>
                  </div>
                ))}
                {(openZone === "graveyard" ? player.graveyard : player.exile).length === 0 && (
                  <div className="w-full rounded-xl border border-white/8 bg-white/[.035] py-10 text-center text-sm text-slate-400">
                    Empty
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
