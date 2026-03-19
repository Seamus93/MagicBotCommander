import { useEffect, useState } from "react";

interface NumericPromptModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  max?: number;
  onConfirm: (value: number) => void;
  onCancel: () => void;
}

export default function NumericPromptModal({
  title,
  message,
  confirmLabel = "Conferma",
  cancelLabel = "Annulla",
  max,
  onConfirm,
  onCancel,
}: NumericPromptModalProps) {
  const [value, setValue] = useState("1");

  useEffect(() => {
    setValue("1");
  }, [title, message]);

  const submit = () => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const normalized = Math.max(1, Math.floor(parsed));
    onConfirm(max ? Math.min(normalized, max) : normalized);
  };

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-[#1b1b1f] p-5 text-white shadow-2xl">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
            Library Action
          </p>
          <h2 className="mt-1 text-xl font-semibold">{title}</h2>
        </div>
        <p className="mb-4 text-sm text-zinc-300">{message}</p>
        <input
          type="number"
          min={1}
          max={max}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
          className="w-full rounded-xl border border-zinc-600 bg-zinc-900 px-3 py-2 text-white outline-none transition focus:border-sky-500"
          autoFocus
        />
        {typeof max === "number" && (
          <p className="mt-2 text-xs text-zinc-500">Max: {max}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
