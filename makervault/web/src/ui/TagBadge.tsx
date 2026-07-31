import React from "react";

type TagBadgeProps = {
  tag: string;
  className?: string;
  onRemove?: () => void;
};

export default function TagBadge({ tag, className = "", onRemove }: TagBadgeProps) {
  // Theme-aware styling: uses the current accent colour family so the pill
  // is readable in light, dark, neon, purple, and blue themes.  The low-opacity
  // background keeps it subtle while the accent text colour guarantees contrast.
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-accent-soft border-accent-soft text-accent ${className}`}
    >
      {tag}
      {onRemove && (
        <button
          type="button"
          className="text-[10px] leading-none opacity-70 hover:opacity-100"
          onClick={onRemove}
          aria-label={`Remove ${tag}`}
        >
          ×
        </button>
      )}
    </span>
  );
}
