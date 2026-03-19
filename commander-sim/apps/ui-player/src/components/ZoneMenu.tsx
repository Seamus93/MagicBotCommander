// components/ZoneMenu.tsx
import React, { useRef, useEffect, useState } from "react";

type ZoneMenuTone = "default" | "light";

export interface ZoneMenuAction {
  key: string;
  label: string;
  shortcut?: string;
  dividerBefore?: boolean;
}

type ZoneMenuAlign = "right" | "left";

interface ZoneMenuProps {
  zoneKey: string;
  onAction?: (action: string, fromZone: string) => void;
  availableTargets: string[];
  tone?: ZoneMenuTone;
  customActions?: ZoneMenuAction[];
  align?: ZoneMenuAlign;
}

export default function ZoneMenu({
  zoneKey,
  onAction,
  availableTargets,
  tone = "default",
  customActions,
  align = "right",
}: ZoneMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleAction = (action: string) => {
    if (typeof onAction === "function") {
      onAction(action, zoneKey);
    }
    setOpen(false);
  };

  const buttonColor =
    tone === "light"
      ? "text-zinc-200 hover:text-white"
      : "text-zinc-400 hover:text-white";

  const actions = customActions ?? [
    ...(zoneKey !== "hand"
      ? [{ key: "view", label: "Visualizza carte" }]
      : []),
    ...availableTargets
      .filter((target) => target !== zoneKey)
      .map((target) => ({
        key: `move-${target}`,
        label: `Sposta tutto in ${target}`,
      })),
  ];

  return (
    <div className="relative inline-block" ref={menuRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={`ml-1 text-xs leading-none transition-colors ${buttonColor}`}
      >
        ▼
      </button>

      {open && (
        <div
          className={`absolute bottom-full mb-1 w-56 bg-zinc-800/90 text-sm border border-zinc-600 rounded-lg shadow-lg z-20 grid grid-cols-1 gap-1 p-2 ${
            align === "left" ? "right-2" : "left-2"
          }`}
        >
          {actions.map((action) => (
            <React.Fragment key={action.key}>
              {action.dividerBefore && (
                <div className="my-1 border-t border-zinc-700/80" />
              )}
              <button
                className="flex items-center justify-between gap-3 hover:bg-zinc-700 rounded px-2 py-1 text-left"
                onClick={() => handleAction(action.key)}
              >
                <span>{action.label}</span>
                {action.shortcut && (
                  <span className="text-xs text-zinc-400">{action.shortcut}</span>
                )}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
