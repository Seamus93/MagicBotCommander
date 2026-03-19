import React from "react";

interface DeckLoadModalProps {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
  error?: string | null;
  cloudflareBlock?: boolean;
}

export default function DeckLoadModal({
  value,
  onChange,
  onConfirm,
  onCancel,
  className,
  error,
  cloudflareBlock,
}: DeckLoadModalProps) {
  return (
    <div
      className={`absolute left-0 top-full mt-2 bg-zinc-900 p-3 rounded-lg z-20 shadow-md w-[420px] border border-zinc-700 ${className ?? ""}`}
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"Incolla qui il link Moxfield oppure la lista testuale:\n1 Sol Ring\n1 Command Tower\n..."}
        className="w-full h-40 p-2 text-sm bg-zinc-800 text-white rounded resize-none mb-2 border border-zinc-600"
      />
      {error && (
        <div className="mb-2 p-2 rounded bg-red-900/60 border border-red-600 text-xs text-red-200">
          {cloudflareBlock ? (
            <>
              <p className="font-semibold mb-1">Moxfield ha bloccato la richiesta diretta.</p>
              <p>Esporta manualmente:</p>
              <ol className="list-decimal list-inside mt-1 space-y-0.5">
                <li>Apri il deck su <span className="font-mono">moxfield.com</span></li>
                <li>Clicca <strong>Export</strong> → <strong>Text</strong></li>
                <li>Copia la lista e incollala qui sopra</li>
              </ol>
            </>
          ) : (
            <p>{error}</p>
          )}
        </div>
      )}
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
