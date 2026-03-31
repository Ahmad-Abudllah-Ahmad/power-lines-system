import React, { type ReactNode } from "react";

export type MediaUploadAccent = "cyan" | "emerald" | "purple";

const accentRing = {
  cyan: {
    active: "border-premium-accent bg-premium-accent/10",
    filled: "border-premium-success/50 bg-premium-success/5",
    idle: "border-neutral-700 bg-premium-card/30 hover:border-premium-accent/50",
  },
  emerald: {
    active: "border-emerald-400 bg-emerald-400/10",
    filled: "border-emerald-500/40 bg-emerald-500/5",
    idle: "border-neutral-700 bg-premium-card/30 hover:border-emerald-400/40",
  },
  purple: {
    active: "border-purple-400 bg-purple-400/10",
    filled: "border-purple-500/40 bg-purple-500/5",
    idle: "border-neutral-700 bg-premium-card/30 hover:border-purple-400/50",
  },
} as const;

type MediaUploadBoxProps = {
  accent: MediaUploadAccent;
  dragActive: boolean;
  disabled?: boolean;
  hasFiles: boolean;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  inputId: string;
  accept: string;
  multiple: boolean;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  emptyIcon: ReactNode;
  emptyDescription: string;
  primaryButtonLabel: string;
  addMoreInputId?: string;
  onAddMoreChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  addMoreButtonLabel?: string;
  hint?: string;
  footerNote?: string;
  children?: ReactNode;
};

export default function MediaUploadBox({
  accent,
  dragActive,
  disabled = false,
  hasFiles,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  inputId,
  accept,
  multiple,
  onInputChange,
  emptyIcon,
  emptyDescription,
  primaryButtonLabel,
  addMoreInputId,
  onAddMoreChange,
  addMoreButtonLabel = "+ Add More",
  hint,
  footerNote,
  children,
}: MediaUploadBoxProps) {
  const ring = accentRing[accent];
  const borderClass = dragActive ? ring.active : hasFiles ? ring.filled : ring.idle;

  const primaryBtnClass =
    accent === "emerald"
      ? "rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white px-5 py-2.5 text-sm font-semibold cursor-pointer hover:shadow-lg transition-all"
      : "rounded-xl bg-premium-card border border-neutral-700 text-white px-4 py-2 text-sm font-semibold hover:bg-premium-card-hover cursor-pointer transition-colors";

  const addMoreClass =
    "inline-block rounded-lg bg-premium-card border border-neutral-700 text-white px-3 py-1.5 text-xs font-semibold hover:bg-premium-card-hover cursor-pointer transition-colors";

  return (
    <div>
      <div
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed transition-all p-4 ${borderClass} ${disabled ? "opacity-60 pointer-events-none" : ""}`}
      >
        {hasFiles ? (
          <div className="space-y-2">
            {children}
            {addMoreInputId && onAddMoreChange ? (
              <>
                <input
                  type="file"
                  accept={accept}
                  multiple={multiple}
                  onChange={onAddMoreChange}
                  className="hidden"
                  id={addMoreInputId}
                  disabled={disabled}
                />
                <label htmlFor={addMoreInputId} className={addMoreClass}>
                  {addMoreButtonLabel}
                </label>
              </>
            ) : null}
          </div>
        ) : (
          <div className="text-center py-4">
            <div className="flex justify-center mb-2">{emptyIcon}</div>
            <div className="text-sm text-neutral-300 mb-2">{emptyDescription}</div>
            <input
              type="file"
              accept={accept}
              multiple={multiple}
              onChange={onInputChange}
              className="hidden"
              id={inputId}
              disabled={disabled}
            />
            <label htmlFor={inputId} className={`inline-block ${primaryBtnClass}`}>
              {primaryButtonLabel}
            </label>
            {hint ? <div className="text-xs text-neutral-500 mt-2">{hint}</div> : null}
          </div>
        )}
      </div>
      {footerNote ? <div className="mt-2 text-xs text-neutral-400">{footerNote}</div> : null}
    </div>
  );
}
