import { useEffect, useState } from "react";

const VIEWER_STATE_URL =
  (import.meta.env.VITE_VIEWER_STATE_URL as string | undefined) ??
  "http://localhost:3001";

export interface ViewerControlState {
  restartToken: number | string | null;
  updatedAt?: string | null;
}

export function useViewerControl(pollMs = 1000) {
  const [control, setControl] = useState<ViewerControlState | null>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch(`${VIEWER_STATE_URL}/viewer-control`);
        const data = (await res.json()) as { control?: ViewerControlState | null };
        if (active) setControl(data.control ?? null);
      } catch {
        // Optional bridge; ignore errors.
      }
    };

    void poll();
    const interval = setInterval(poll, pollMs);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pollMs]);

  return control;
}
