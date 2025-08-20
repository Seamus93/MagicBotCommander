// components/Snackbar.tsx
import React from "react";

interface SnackbarProps {
  message: string;
  onClose: () => void;
  type?: "success" | "error";
}

export default function Snackbar({ message, onClose, type = "success" }: SnackbarProps) {
  return (
    <div className="fixed bottom-5 right-5 z-50">
      <div className={`px-4 py-3 rounded-md shadow-lg text-sm border
        ${type === "error" ? "bg-red-800 border-red-500 text-red-100" : "bg-green-800 border-green-500 text-green-100"}
      `}>
        <div className="flex items-center justify-between gap-4">
          <span>{message}</span>
          <button
            onClick={onClose}
            className="text-xs hover:text-white text-zinc-300"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
