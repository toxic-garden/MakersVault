import React, { useEffect, useMemo, useState } from "react";
import { UploadProgressInfo } from "../lib/uploadTree";

type Props = {
  items: UploadProgressInfo[];
  open: boolean;
  onClose: () => void;
};

function formatBytes(n: number) {
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log10(n) / 3), units.length - 1);
  const value = n / Math.pow(1000, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function UploadProgressPanel({ items, open, onClose }: Props) {
  const [expanded, setExpanded] = useState(false);

  const total = useMemo(
    () => items.reduce((sum, it) => sum + it.fileSize, 0),
    [items]
  );
  const loaded = useMemo(
    () => items.reduce((sum, it) => sum + it.loaded, 0),
    [items]
  );
  const doneCount = useMemo(
    () => items.filter(it => it.status === "done").length,
    [items]
  );
  const failedCount = useMemo(
    () => items.filter(it => it.status === "failed").length,
    [items]
  );
  const allDone = useMemo(
    () => items.length > 0 && items.every(it => it.status === "done" || it.status === "failed"),
    [items]
  );
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;

  useEffect(() => {
    if (!allDone) return;
    const timer = window.setTimeout(() => {
      onClose();
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [allDone, onClose]);

  if (!open || items.length === 0) return null;

  return (
    <div className="fixed top-3 right-3 z-50 w-80 rounded-lg border border-panel-strong bg-panel shadow-lg p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          {allDone
            ? failedCount > 0
              ? `${doneCount} uploaded, ${failedCount} failed`
              : `${doneCount} uploaded`
            : `Uploading ${doneCount + 1} of ${items.length}`}
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded-md border border-panel-strong flex items-center justify-center text-xs hover:bg-panel-soft"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="w-full h-2 rounded-full bg-panel overflow-hidden">
        <div
          className={`h-full transition-all duration-200 ${failedCount && allDone ? "bg-red-500" : "bg-accent"}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-muted">
        <span>{percent}%</span>
        <span>
          {formatBytes(loaded)} / {formatBytes(total)}
        </span>
      </div>

      <button
        onClick={() => setExpanded(prev => !prev)}
        className="text-xs text-left hover:text-foreground transition-smooth"
      >
        {expanded ? "Hide files" : `Show ${items.length} files`}
      </button>

      {expanded && (
        <div className="flex flex-col gap-1.5 max-h-60 overflow-auto pr-0.5">
          {items.map((it, idx) => (
            <div key={idx} className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate max-w-[70%]" title={it.fileName}>
                  {it.fileName}
                </span>
                <span
                  className={`shrink-0 ${
                    it.status === "failed"
                      ? "text-red-500"
                      : it.status === "done"
                      ? "text-green-600 dark:text-green-400"
                      : "text-muted"
                  }`}
                >
                  {it.status === "done"
                    ? "Done"
                    : it.status === "failed"
                    ? "Failed"
                    : it.status === "uploading"
                    ? "Uploading"
                    : "Pending"}
                </span>
              </div>
              <div className="w-full h-1 rounded-full bg-panel overflow-hidden">
                <div
                  className={`h-full transition-all duration-200 ${
                    it.status === "failed" ? "bg-red-500" : it.status === "done" ? "bg-green-500" : "bg-accent"
                  }`}
                  style={{
                    width: `${it.fileSize > 0 ? Math.min(100, Math.round((it.loaded / it.fileSize) * 100)) : 0}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
