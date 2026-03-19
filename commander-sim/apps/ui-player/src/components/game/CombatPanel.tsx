import type { PendingDecision } from "../../hooks/useGameSession";

interface CombatPanelProps {
  pendingDecision: PendingDecision | null;
  onAttackPlan: (plan: unknown) => void;
  onBlockPlan: (plan: unknown) => void;
  onTarget: (idx: number) => void;
}

export default function CombatPanel({
  pendingDecision,
  onAttackPlan,
  onBlockPlan,
  onTarget,
}: CombatPanelProps) {
  if (!pendingDecision) return null;

  if (pendingDecision.decisionType === "target") {
    const opponents = pendingDecision.context.opponentIndices ?? [];
    return (
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-800 border border-red-600 rounded-lg p-4 z-40 shadow-xl">
        <div className="text-white font-bold mb-2 text-sm">Choose attack target:</div>
        <div className="flex gap-3">
          {opponents.map((idx) => (
            <button
              key={idx}
              onClick={() => onTarget(idx)}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded font-bold text-sm"
            >
              Attack Player {idx}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (pendingDecision.decisionType === "attack_plan") {
    const plans = (pendingDecision.context.plans ?? []) as Array<{
      attackers: string[];
      targetPlayer: number;
      expectedDamage: number;
      expectedLosses: number;
      score: number;
    }>;
    return (
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-800 border border-orange-600 rounded-lg p-4 z-40 shadow-xl min-w-72">
        <div className="text-white font-bold mb-2 text-sm">Attack plan:</div>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onAttackPlan({ attackers: [], targetPlayer: 0, expectedDamage: 0, expectedLosses: 0, score: 0 })}
            className="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded text-sm"
          >
            Don't attack
          </button>
          {plans.map((p, i) => (
            <button
              key={i}
              onClick={() => onAttackPlan(p)}
              className="px-3 py-1.5 bg-orange-700 hover:bg-orange-600 text-white rounded text-sm text-left"
            >
              Attack P{p.targetPlayer} with {p.attackers.length} creature{p.attackers.length !== 1 ? "s" : ""}
              {" "}(~{p.expectedDamage} dmg, score {p.score.toFixed(1)})
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (pendingDecision.decisionType === "block_plan") {
    const plans = (pendingDecision.context.plans ?? []) as Array<{
      damagePrevented: number;
      totalIncomingDamage: number;
      blockersLost: number;
      score: number;
    }>;
    return (
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-800 border border-purple-600 rounded-lg p-4 z-40 shadow-xl min-w-72">
        <div className="text-white font-bold mb-2 text-sm">Block plan:</div>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onBlockPlan({ assignments: {}, creaturesKilled: 0, damagePrevented: 0, totalIncomingDamage: 0, blockersLost: 0, score: 0 })}
            className="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded text-sm"
          >
            Don't block
          </button>
          {plans.map((p, i) => (
            <button
              key={i}
              onClick={() => onBlockPlan(p)}
              className="px-3 py-1.5 bg-purple-700 hover:bg-purple-600 text-white rounded text-sm text-left"
            >
              Block (prevent {p.damagePrevented}/{p.totalIncomingDamage} dmg, lose {p.blockersLost})
            </button>
          ))}
        </div>
      </div>
    );
  }

  return null;
}
