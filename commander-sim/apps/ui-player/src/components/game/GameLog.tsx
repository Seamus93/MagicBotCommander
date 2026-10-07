import { useEffect, useMemo, useRef, useState } from "react";
import type { AiDecisionTrace, SimAction } from "../../../../../packages/game-state/src/types";
import { groupNormalLogMessages } from "./normalLogGroups";

interface GameLogProps {
  messages: string[];
  aiDecisionTraces?: AiDecisionTrace[];
}

type LogMode = "normal" | "debug";

const PHASE_COLOR: Record<string, string> = {
  "[Combat": "text-red-400",
  "[Mulligan": "text-yellow-400",
  "[Stack": "text-purple-400",
  "[RewardShaping": "text-gray-500",
  "[ERROR": "text-red-600 font-bold",
};

function colorClass(msg: string): string {
  for (const [prefix, cls] of Object.entries(PHASE_COLOR)) {
    if (msg.includes(prefix)) return cls;
  }
  return "text-gray-300";
}

function actionLabel(action?: SimAction | null): string {
  if (!action) return "none";
  if (action.type === "PLAY_LAND" || action.type === "CAST_SPELL") return `${action.type} ${action.card}`;
  if (action.type === "ACTIVATE_ABILITY") return `ACTIVATE ${action.abilityId}`;
  if (action.type === "ATTACK_CHOICE" || action.type === "BLOCK_CHOICE") return `${action.type} ${action.card}`;
  return action.type;
}

function phaseLabel(trace: AiDecisionTrace) {
  if (/Prima Fase Principale|MAIN1/i.test(trace.step)) return "MAIN1";
  if (/Seconda Fase Principale|MAIN2/i.test(trace.step)) return "MAIN2";
  return trace.step || trace.phase;
}

function playerLabel(player: number) {
  return ["SOUTH", "EAST", "NORTH", "WEST"][player] ?? `P${player}`;
}

function TraceObject({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{title}</div>
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-white/8 bg-black/20 p-2 text-[10px] leading-relaxed text-slate-200">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function GameLog({ messages, aiDecisionTraces = [] }: GameLogProps) {
  const logScrollRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<LogMode>("normal");
  const [player, setPlayer] = useState("");
  const [turn, setTurn] = useState("");
  const [phase, setPhase] = useState("");
  const [actionType, setActionType] = useState("");
  const [questionableOnly, setQuestionableOnly] = useState(false);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [unsupportedOnly, setUnsupportedOnly] = useState(false);

  useEffect(() => {
    const logScroll = logScrollRef.current;
    if (logScroll) logScroll.scrollTo({ top: logScroll.scrollHeight, behavior: "smooth" });
  }, [messages, aiDecisionTraces, mode]);

  const filteredTraces = useMemo(() => {
    return aiDecisionTraces.filter((trace) => {
      if (player && String(trace.playerId) !== player) return false;
      if (turn && String(trace.turn) !== turn.trim()) return false;
      if (phase && !`${trace.phase} ${trace.step}`.toLowerCase().includes(phase.toLowerCase())) return false;
      if (actionType && trace.decision.chosenAction.type !== actionType) return false;
      if (questionableOnly && !trace.questionable) return false;
      if (failuresOnly && trace.execution.success) return false;
      if (unsupportedOnly && trace.unsupportedCards.length === 0) return false;
      return true;
    });
  }, [actionType, aiDecisionTraces, failuresOnly, phase, player, questionableOnly, turn, unsupportedOnly]);
  const normalLogGroups = useMemo(() => groupNormalLogMessages(messages), [messages]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded bg-gray-900 text-xs font-mono">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 p-1">
        <button
          type="button"
          onClick={() => setMode("normal")}
          className={`rounded px-2 py-1 ${mode === "normal" ? "bg-blue-600 text-white" : "text-slate-400 hover:bg-white/8"}`}
        >
          Normal Log
        </button>
        <button
          type="button"
          onClick={() => setMode("debug")}
          className={`rounded px-2 py-1 ${mode === "debug" ? "bg-blue-600 text-white" : "text-slate-400 hover:bg-white/8"}`}
        >
          AI Debug Log
        </button>
        {mode === "debug" && (
          <span className="ml-auto text-[10px] text-slate-500">{filteredTraces.length}/{aiDecisionTraces.length}</span>
        )}
      </div>

      <div className="shrink-0 border-b border-white/10 p-2">
        <div className="mb-1 grid grid-cols-2 gap-1 text-[10px]">
          <input value={player} onChange={(event) => setPlayer(event.target.value)} placeholder="player" className="min-w-0 rounded bg-black/30 px-2 py-1 text-slate-200 outline-none" />
          <input value={turn} onChange={(event) => setTurn(event.target.value)} placeholder="turn" className="min-w-0 rounded bg-black/30 px-2 py-1 text-slate-200 outline-none" />
          <input value={phase} onChange={(event) => setPhase(event.target.value)} placeholder="phase" className="min-w-0 rounded bg-black/30 px-2 py-1 text-slate-200 outline-none" />
          <select value={actionType} onChange={(event) => setActionType(event.target.value)} className="min-w-0 rounded bg-black/30 px-2 py-1 text-slate-200 outline-none">
            <option value="">action type</option>
            <option value="PASS_TURN">PASS_TURN</option>
            <option value="PLAY_LAND">PLAY_LAND</option>
            <option value="CAST_SPELL">CAST_SPELL</option>
            <option value="ACTIVATE_ABILITY">ACTIVATE_ABILITY</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] text-slate-300">
          <label className="flex items-center gap-1"><input type="checkbox" checked={questionableOnly} onChange={(event) => setQuestionableOnly(event.target.checked)} /> questionable</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={failuresOnly} onChange={(event) => setFailuresOnly(event.target.checked)} /> failures</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={unsupportedOnly} onChange={(event) => setUnsupportedOnly(event.target.checked)} /> unsupported</label>
        </div>
      </div>

      {mode === "normal" ? (
        <div ref={logScrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {normalLogGroups.policy.length > 0 && (
            <section className="mb-2 rounded border border-white/8 bg-black/15">
              <h3 className="border-b border-white/8 px-2 py-1 font-bold uppercase tracking-wider text-slate-400">Policy</h3>
              <div className="space-y-0.5 p-2">
                {normalLogGroups.policy.map((message, index) => <div key={index} className={colorClass(message)}>{message}</div>)}
              </div>
            </section>
          )}
          {normalLogGroups.mulligans.length > 0 && (
            <section className="mb-2 rounded border border-white/8 bg-black/15">
              <h3 className="border-b border-white/8 px-2 py-1 font-bold uppercase tracking-wider text-yellow-400">Mulligans</h3>
              <div className="space-y-0.5 p-2">
                {normalLogGroups.mulligans.map((message, index) => <div key={index} className={colorClass(message)}>{message}</div>)}
              </div>
            </section>
          )}
          {normalLogGroups.setup.length > 0 && (
            <section className="mb-2 rounded border border-white/8 bg-black/15">
              <h3 className="border-b border-white/8 px-2 py-1 font-bold uppercase tracking-wider text-slate-400">Game setup</h3>
              <div className="space-y-0.5 p-2">
                {normalLogGroups.setup.map((message, index) => <div key={index} className={colorClass(message)}>{message}</div>)}
              </div>
            </section>
          )}
          {normalLogGroups.unassignedActions.length > 0 && (
            <section className="mb-2 rounded border border-white/8 bg-black/15 p-1">
              <h3 className="px-1 py-1 font-bold uppercase tracking-wider text-slate-400">Actions without turn</h3>
              {normalLogGroups.unassignedActions.map((action) => (
                <details key={action.id} className="rounded border border-white/8 bg-black/20">
                  <summary className="cursor-pointer px-2 py-1 text-slate-200">{action.label}</summary>
                  <div className="space-y-0.5 border-t border-white/8 p-2">
                    {action.messages.map((message, index) => <div key={index} className={colorClass(message)}>{message}</div>)}
                  </div>
                </details>
              ))}
            </section>
          )}
          {normalLogGroups.turns.map((turnGroup, turnIndex) => (
            <details key={turnGroup.id} open={turnIndex === normalLogGroups.turns.length - 1} className="mb-2 rounded border border-white/10 bg-black/15">
              <summary className="cursor-pointer px-2 py-1.5 font-bold text-slate-100">{turnGroup.title}</summary>
              <div className="space-y-1 border-t border-white/8 p-1">
                {turnGroup.actions.map((action) => (
                  <details key={action.id} open={action.label === "Turn events"} className="rounded border border-white/8 bg-black/20">
                    <summary className="cursor-pointer px-2 py-1 text-slate-200">
                      {action.label}{action.messages.length ? ` · ${action.messages.length}` : ""}
                    </summary>
                    {action.messages.length > 0 && (
                      <div className="space-y-0.5 border-t border-white/8 p-2">
                        {action.messages.map((message, index) => <div key={index} className={colorClass(message)}>{message}</div>)}
                      </div>
                    )}
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div ref={logScrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="space-y-1">
            {filteredTraces.map((trace) => {
              const alternatives = trace.legalActions.filter((action) => action.type !== trace.decision.chosenAction.type).length;
              return (
                <details key={trace.decisionId} className="rounded border border-white/8 bg-black/20">
                  <summary className="cursor-pointer px-2 py-1 text-slate-200">
                    T{trace.turn} {phaseLabel(trace)} | {playerLabel(trace.playerId)} | {actionLabel(trace.decision.chosenAction)} | {alternatives} alternatives
                    {trace.questionable ? " | QUESTIONABLE" : ""}
                    {!trace.execution.success ? " | FAILED" : ""}
                  </summary>
                  <div className="space-y-2 border-t border-white/8 p-2">
                    <TraceObject title="STATE" value={trace.state} />
                    <TraceObject title="CONSIDERED" value={trace.consideredActions} />
                    <TraceObject title="LEGAL" value={trace.legalActions} />
                    <TraceObject title="SCORES" value={trace.evaluation} />
                    <TraceObject title="DECISION" value={trace.decision} />
                    <TraceObject title="EXECUTION" value={trace.execution} />
                    <TraceObject title="RESULT" value={trace.result} />
                    <TraceObject title="PERFORMANCE" value={trace.performance} />
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
