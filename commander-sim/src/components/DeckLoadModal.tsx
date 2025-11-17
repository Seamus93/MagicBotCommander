import React from "react";

interface DeckLoadModalProps {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DeckLoadModal({
  value,
  onChange,
  onConfirm,
  onCancel,
}: DeckLoadModalProps) {
  return (
    <div className="absolute left-6 top-8 bg-zinc-900 p-3 rounded-lg z-20 shadow-md w-[400px] border border-zinc-700">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Incolla qui il deck esportato o il link Moxfield"
        className="w-full h-40 p-2 text-sm bg-zinc-800 text-white rounded resize-none mb-2 border border-zinc-600"
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1 text-sm rounded bg-red-600 hover:bg-red-700"
        >
          Annulla
        </button>
        <button
          onClick={onConfirm}
          className="px-3 py-1 text-sm rounded bg-green-600 hover:bg-green-700"
        >
          Carica Mazzo
        </button>
      </div>
    </div>
  );
}
