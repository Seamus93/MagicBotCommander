interface DialogModalProps {
  title: string;
  message: string;
  tone?: "default" | "danger";
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DialogModal({
  title,
  message,
  tone = "default",
  confirmLabel = "Conferma",
  cancelLabel = "Annulla",
  onConfirm,
  onCancel,
}: DialogModalProps) {
  return (
    <div className="dialog-overlay fixed inset-0 z-[70] flex items-center justify-center px-6">
      <div className="dialog-panel w-full max-w-xl">
        <div className="dialog-panel__header">
          <div>
            <p className="dialog-panel__eyebrow">Game Message</p>
            <h2 className="dialog-panel__title">{title}</h2>
          </div>
        </div>
        <p className="dialog-panel__message whitespace-pre-line">{message}</p>
        <div className="dialog-panel__actions">
          <button
            type="button"
            onClick={onCancel}
            className="dialog-button dialog-button--ghost"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`dialog-button ${
              tone === "danger" ? "dialog-button--danger" : "dialog-button--primary"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
