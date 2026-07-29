import React from "react";
import { Asset, fileUrl } from "../lib/api";
import { ResolvedTheme } from "../lib/settings";
import TagBadge from "./TagBadge";
import { renderPreviewContent } from "./AssetPreview";
import { formatFileSize } from "./fileSize";

export default function AssetPreviewModal({
  asset,
  theme,
  onClose,
}: {
  asset: Asset;
  theme: ResolvedTheme;
  onClose: () => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-panel-strong rounded-lg shadow-2xl max-w-5xl w-full max-h-full overflow-hidden flex flex-col"
        onClick={stop}
      >
        <div className="flex items-center justify-between border-b border-panel px-4 py-3">
          <div>
            <h2 className="text-lg font-semibold">{asset.title || asset.filename}</h2>
            <p className="text-sm opacity-70">
              {asset.filename} · {formatFileSize(asset.size)}
            </p>
          </div>
          <button
            className="px-3 py-1 rounded-md border border-panel-strong text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-auto">
          <div className="w-full h-[70vh] min-h-[400px]">
            <div className="w-full h-full rounded-lg bg-panel-soft flex items-center justify-center overflow-hidden">
              {renderPreviewContent(asset, "modal", theme)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {asset.tags.length ? (
              asset.tags.map(tag => <TagBadge key={tag} tag={tag} />)
            ) : (
              <span className="text-xs opacity-60">No tags</span>
            )}
          </div>
          {asset.notes && (
            <div className="text-sm border border-dashed border-panel-strong rounded-md p-3 whitespace-pre-wrap">
              {asset.notes}
            </div>
          )}
          <div className="flex gap-3">
            <a
              className="px-3 py-2 rounded-md bg-accent text-sm"
              href={fileUrl(asset.url)}
              download={asset.filename}
            >
              Download
            </a>
            <button
              className="px-3 py-2 rounded-md border border-panel-strong text-sm"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
