interface PhaseTrackerProps {
  turn: number;
  phase: string;
  phaseStep: string;
  activePlayer: number;
}

export default function PhaseTracker({ turn, phase, phaseStep, activePlayer }: PhaseTrackerProps) {
  return (
    <div className="flex items-center gap-3 bg-gray-800 text-white px-3 py-1 rounded text-sm">
      <span className="font-bold text-yellow-400">Turn {turn}</span>
      <span className="text-gray-400">|</span>
      <span className="text-blue-300">{phase}</span>
      <span className="text-gray-400">›</span>
      <span className="text-gray-200">{phaseStep}</span>
      <span className="text-gray-400">|</span>
      <span className="text-green-400">Player {activePlayer}</span>
    </div>
  );
}
