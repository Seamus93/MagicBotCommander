import { useEffect, useRef } from "react";

interface GameLogProps {
  messages: string[];
}

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

export default function GameLog({ messages }: GameLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="h-full overflow-y-auto bg-gray-900 rounded p-2 text-xs font-mono">
      {messages.map((msg, i) => (
        <div key={i} className={colorClass(msg)}>
          {msg}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
