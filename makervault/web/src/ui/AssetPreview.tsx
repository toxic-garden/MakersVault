import React from "react";
import { Asset, fileUrl } from "../lib/api";
import { ResolvedTheme } from "../lib/settings";
import ModelViewer from "./ModelViewer";
import LightBurnPreview from "./LightBurnPreview";

const MODEL_EXTS = new Set(["stl", "3mf", "step", "stp", "obj"]);
const LIGHTBURN_EXTS = new Set(["lbrn", "lbrn2"]);

export function extOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name);
  return (m?.[1] || "").toLowerCase();
}

export type PreviewVariant = "card" | "modal";

/** A simple SVG cube icon shown on cards for 3D files that have no server-side thumbnail yet. */
function ModelFileIcon({ ext, className = "" }: { ext: string; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-1 ${className}`}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-50">
        <path d="M12 2L3 7v10l9 5 9-5V7l-9-5z" strokeLinejoin="round" />
        <path d="M3 7l9 5 9-5" strokeLinejoin="round" />
        <path d="M12 12v10" strokeLinejoin="round" />
      </svg>
      <span className="text-xs font-mono opacity-50 uppercase">{ext}</span>
    </div>
  );
}

export function renderPreviewContent(asset: Asset, variant: PreviewVariant, theme: ResolvedTheme) {
  const ext = extOf(asset.filename);
  const assetUrl = fileUrl(asset.url);
  const thumbUrl = asset.thumb_url ? fileUrl(asset.thumb_url) : null;
  const imgClass =
    variant === "card"
      ? "w-full h-full object-cover"
      : "w-full h-full object-contain bg-panel-strong";
  const is3d = MODEL_EXTS.has(ext);
  const isLightBurn = LIGHTBURN_EXTS.has(ext);

  if (variant === "card") {
    if (thumbUrl) {
      return <img src={thumbUrl} alt={asset.filename} className={imgClass} />;
    }
    if (ext === "svg") {
      return <img src={assetUrl} alt={asset.filename} className={imgClass} />;
    }
    if (is3d) {
      // No server-side thumbnail yet — show a lightweight placeholder icon
      // instead of spinning up a WebGL context per card.
      return <ModelFileIcon ext={ext} className="w-full h-full" />;
    }
    if (isLightBurn) {
      return (
        <LightBurnPreview
          url={assetUrl}
          assetId={asset.id}
          filename={asset.filename}
          imgClass={imgClass}
        />
      );
    }
    return (
      <div className="flex items-center justify-center w-full h-full text-sm opacity-60">
        No preview
      </div>
    );
  }

  if (is3d) {
    return <ModelViewer key={`${variant}-${asset.id}`} url={assetUrl} ext={ext} assetId={asset.id} theme={theme} />;
  }
  if (thumbUrl || ext === "svg") {
    const src = thumbUrl || assetUrl;
    return <img src={src} alt={asset.filename} className={imgClass} />;
  }
  if (isLightBurn) {
    return (
      <LightBurnPreview
        url={assetUrl}
        assetId={asset.id}
        filename={asset.filename}
        imgClass={imgClass}
      />
    );
  }
  return (
    <div className="flex items-center justify-center w-full h-full text-sm opacity-60">
      Preview unavailable
    </div>
  );
}
