import type { PendingDecision } from "../../hooks/useGameSession";

interface ActionPanelProps {
  pendingDecision: PendingDecision | null;
  onAction: (action: unknown) => void;
  onAttackPlan: (plan: unknown) => void;
  onBlockPlan?: (plan: unknown) => void;
  onMulligan: (keep: boolean, bottomCards?: string[]) => void;
  onTarget: (idx: number) => void;
  onResponse: (action: unknown) => void;
}

export default function ActionPanel({
  pendingDecision,
  onAction,
  onAttackPlan,
  onMulligan,
  onTarget,
  onResponse,
}: ActionPanelProps) {
  if (!pendingDecision) return null;

  const { decisionType, context } = pendingDecision;

  if (decisionType === "action") {
    const actions = context.availableActions ?? [];
    return (
      <div className="bg-gray-800 border border-gray-600 rounded p-3">
        <div className="text-white text-sm font-bold mb-2">Choose an action:</div>
        <div className="flex flex-wrap gap-2">
          {actions.map((a, i) => {
            const label =
              a.type === "PLAY_LAND"
                ? `Play Land: ${a.card}`
                : a.type === "CAST_SPELL"
                ? `Cast: ${a.card}`
                : a.type === "RESOLVE_CHOICE"
                ? `Return: ${a.card}`
                : a.type === "PASS_TURN"
                ? "Pass Turn"
                : a.type;
            return (
              <button
                key={i}
                onClick={() => onAction(a)}
                className="bg-blue-700 hover:bg-blue-600 text-white text-xs px-3 py-1.5 rounded"
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (decisionType === "mulligan") {
    const hand = context.hand ?? [];
    const count = context.mulliganCount ?? 0;
    return (
      <div className="bg-gray-800 border border-yellow-600 rounded p-3">
        <div className="text-white text-sm font-bold mb-1">
          Mulligan? (count: {count})
        </div>
        <div className="text-gray-300 text-xs mb-2">Hand: {hand.join(", ")}</div>
        <div className="flex gap-2">
          <button
            onClick={() => onMulligan(true)}
            className="bg-green-700 hover:bg-green-600 text-white text-xs px-3 py-1.5 rounded"
          >
            Keep
          </button>
          <button
            onClick={() => onMulligan(false)}
            className="bg-red-700 hover:bg-red-600 text-white text-xs px-3 py-1.5 rounded"
          >
            Mulligan
          </button>
        </div>
      </div>
    );
  }

  if (decisionType === "target") {
    const opponents = context.opponentIndices ?? [];
    return (
      <div className="bg-gray-800 border border-red-600 rounded p-3">
        <div className="text-white text-sm font-bold mb-2">Choose attack target:</div>
        <div className="flex gap-2">
          {opponents.map((idx) => (
            <button
              key={idx}
              onClick={() => onTarget(idx)}
              className="bg-red-700 hover:bg-red-600 text-white text-xs px-3 py-1.5 rounded"
            >
              Player {idx}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (decisionType === "attack_plan") {
    const plans = (context.plans ?? []) as Array<{
      attackers: string[];
      targetPlayer: number;
      expectedDamage: number;
      score: number;
    }>;
    return (
      <div className="bg-gray-800 border border-orange-600 rounded p-3">
        <div className="text-white text-sm font-bold mb-2">Choose attack plan:</div>
        <div className="flex flex-wrap gap-2">
          {plans.length === 0 ? (
            <button
              onClick={() => onAttackPlan({ attackers: [], targetPlayer: 0, expectedDamage: 0, expectedLosses: 0, score: 0 })}
              className="bg-gray-600 hover:bg-gray-500 text-white text-xs px-3 py-1.5 rounded"
            >
              Don't attack
            </button>
          ) : (
            plans.map((p, i) => (
              <button
                key={i}
                onClick={() => onAttackPlan(p)}
                className="bg-orange-700 hover:bg-orange-600 text-white text-xs px-3 py-1.5 rounded"
              >
                Attack P{p.targetPlayer} ({p.attackers.length} creatures, ~{p.expectedDamage} dmg)
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  if (decisionType === "response") {
    const instants = context.availableActions ?? [];
    const triggeringCard =
      context.triggeringEntry?.action && "card" in context.triggeringEntry.action
        ? context.triggeringEntry.action.card
        : null;
    return (
      <div className="bg-gray-800 border border-purple-600 rounded p-3">
        <div className="text-white text-sm font-bold mb-1">Respond? (instants)</div>
        {triggeringCard && (
          <div className="mb-2 text-xs text-gray-300">
            Stack item: {triggeringCard}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onResponse(null)}
            className="bg-gray-600 hover:bg-gray-500 text-white text-xs px-3 py-1.5 rounded"
          >
            Pass
          </button>
          {instants.map((a, i) => (
            <button
              key={i}
              onClick={() => onResponse(a)}
              className="bg-purple-700 hover:bg-purple-600 text-white text-xs px-3 py-1.5 rounded"
            >
              Cast {a.card}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 border border-gray-600 rounded p-3 text-gray-400 text-xs">
      Waiting for decision: {decisionType}
    </div>
  );
}
