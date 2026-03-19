import { useEffect, useState } from "react";

const VIEWER_STATE_URL =
  (import.meta.env.VITE_VIEWER_STATE_URL as string | undefined) ??
  "http://localhost:3001";

export interface ViewerState {
  deckId?: number | null;
  turn: number;
  life: number;
  commander?: string | null;
  fullDeck?: string[];
  commanderTax?: number;
  battlefield?: string[];
  battlefieldCards?: Array<{ id: string; card: string; x: number; y: number; z?: number }>;
  graveyard?: string[];
  exile?: string[];
  libraryCount?: number;
  commandZone?: string[];
  handCount?: number;
  updatedAt?: string;
}

export function useViewerState(pollMs = 1500) {
  const [state, setState] = useState<ViewerState | null>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch(`${VIEWER_STATE_URL}/viewer-state`);
        const data = (await res.json()) as { state?: ViewerState | null };
        if (active) setState(data.state ?? null);
      } catch {
        // API server not reachable, keep polling
      }
    };

    void poll();
    const interval = setInterval(poll, pollMs);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pollMs]);

  return state;
}
