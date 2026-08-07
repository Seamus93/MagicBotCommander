export type SessionMode = "standalone" | "engine-linked";

export function sessionModeForEngineSession(sessionId: string | null | undefined): SessionMode {
  return sessionId ? "engine-linked" : "standalone";
}

export function shouldUseLocalShuffle(mode: SessionMode) {
  return mode === "standalone";
}

export function shouldPublishViewerRulesState(mode: SessionMode) {
  return mode === "standalone";
}
