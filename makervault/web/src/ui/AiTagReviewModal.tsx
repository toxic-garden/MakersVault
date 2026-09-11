import React from "react";
import { Sparkles, X } from "lucide-react";
import { Asset } from "../lib/api";
import TagBadge from "./TagBadge";

export type AiTagReviewItem = {
  asset: Asset;
  tags: string[];
};

type Props = {
  items: AiTagReviewItem[];
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onApply: (items: AiTagReviewItem[]) => void;
};

/**
 * Review dialog for AI-generated tags (PrintVentory-style):
 * shows suggested tags per asset; the user can remove single tags before
 * everything is merged into the existing tags of each asset.
 */
export default function AiTagReviewModal({ items, open, busy, onClose, onApply }: Props) {
  const [drafts, setDrafts] = React.useState<Record<string, string[]>>({});

  React.useEffect(() => {
    if (!open) return;
    const next: Record<string, string[]> = {};
    for (const it of items) next[it.asset.id] = [...it.tags];
    setDrafts(next);
  }, [open, items]);

  if (!open) return null;

  const toggle = (assetId: string, tag: string) => {
    setDrafts(prev => {
      const current = prev[assetId] || [];
      const next = current.includes(tag)
        ? current.filter(t => t !== tag)
        : [...current, tag];
      return { ...prev, [assetId]: next };
    });
  };

  const hasEmptySelection = items.some(
    it => !(drafts[it.asset.id] || it.tags).length
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        className="rounded-lg border border-panel-strong bg-panel-strong shadow-lg p-5 max-w-lg w-full mx-4 max-h-[80vh] flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5">
          <Sparkles className="w-5 h-5 text-accent shrink-0" />
          <h2 className="text-base font-semibold">
            AI-generated tags — {items.length} {items.length === 1 ? "item" : "items"}
          </h2>
          <div className="flex-1" />
          <button
            className="p-1 rounded-md hover:bg-panel disabled:opacity-60"
            onClick={onClose}
            disabled={busy}
            title="Discard"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-3 min-h-0">
          {items.map(it => {
            const draft = drafts[it.asset.id] || it.tags;
            const removed = it.tags.filter(t => !draft.includes(t));
            return (
              <div
                key={it.asset.id}
                className="rounded-md border border-panel bg-panel-soft p-3 flex flex-col gap-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate" title={it.asset.title || it.asset.filename}>
                    {it.asset.title || it.asset.filename}
                  </span>
                  {removed.length > 0 && (
                    <span className="ml-auto text-xs text-muted shrink-0">
                      {draft.length} kept · {removed.length} removed
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {it.tags.length ? (
                    it.tags.map(tag => {
                      const on = draft.includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => toggle(it.asset.id, tag)}
                          title={on ? "Remove tag" : "Keep tag"}
                          className={`px-2.5 py-1 rounded-full text-xs border transition-smooth ${
                            on
                              ? "bg-accent-soft border-accent-soft text-accent"
                              : "border-panel-strong text-muted line-through opacity-60 hover:opacity-100"
                          }`}
                        >
                          {tag}
                        </button>
                      );
                    })
                  ) : (
                    <span className="text-xs text-subtle italic">
                      The model returned no usable tags.
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-muted">
          Click tags to deselect. Selected tags are merged with the existing ones.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <button
            className="h-8 px-3 rounded-md border border-panel-strong text-sm transition-smooth hover:bg-panel disabled:opacity-60"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-accent text-sm font-medium transition-smooth hover:bg-accent-strong disabled:opacity-60"
            onClick={() =>
              onApply(
                items.map(it => ({ asset: it.asset, tags: drafts[it.asset.id] || [] }))
              )
            }
            disabled={busy || hasEmptySelection}
          >
            {busy ? "Applying…" : "Apply tags"}
          </button>
        </div>
      </div>
    </div>
  );
}