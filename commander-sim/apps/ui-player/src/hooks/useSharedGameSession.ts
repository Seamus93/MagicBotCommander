import { useEffect, useState } from "react";

const VIEWER_STATE_URL =
  (import.meta.env.VITE_VIEWER_STATE_URL as string | undefined) ??
  "http://localhost:3001";

export interface SharedGameSessionState {
  sessionId: string | null;
  source?: string | null;
  updatedAt?: string | null;
}

export function useSharedGameSession(pollMs = 1200) {
  const [state, setState] = useState<SharedGameSessionState | null>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch(`${VIEWER_STATE_URL}/viewer-session`);
        const data = (await res.json()) as { session?: SharedGameSessionState | null };
        if (active) {
          setState(data.session ?? null);
        }
      } catch {
        // API server not reachable, keep polling.
      }
    };

    void poll();
    const interval = window.setInterval(poll, pollMs);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pollMs]);

  return state;
}

export async function publishSharedGameSession(sessionId: string | null, source: string) {
  await fetch(`${VIEWER_STATE_URL}/viewer-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, source }),
  });
}
