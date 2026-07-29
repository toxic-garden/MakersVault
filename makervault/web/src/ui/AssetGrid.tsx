import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Asset,
  Folder,
  UnauthorizedError,
  deleteAsset,
  fileUrl,
  listAssets,
  listTags,
  listFolders,
  renameAsset,
  setTags,
  updateAssetFolder,
  updateAssetMeta,
  downloadZip,
} from "../lib/api";
import AssetCard from "./AssetCard";
import AssetPreviewModal from "./AssetPreviewModal";
import TagInput from "./TagInput";
import { colorForTag } from "./tagColors";
import { ResolvedTheme } from "../lib/settings";
import { entriesFromDataTransfer, uploadEntriesToFolder } from "../lib/uploadTree";
import { buildUploadEntriesFromZip, isZipFile, readZipEntries } from "../lib/zipUtils";
import { useZipImportPrompt } from "./ZipImportModal";

const ROWS_PER_BATCH = 5;
const CARD_MIN_WIDTH_PX = 260;
const GRID_GAP_PX = 16;

function rowsBatchSizeForWidth(width: number) {
  const cols = Math.max(1, Math.floor((width + GRID_GAP_PX) / (CARD_MIN_WIDTH_PX + GRID_GAP_PX)));
  return cols * ROWS_PER_BATCH;
}

type Props = {
  folderId?: string | null;
  foldersVersion?: number;
  onUnauthorized?: () => void;
  theme: ResolvedTheme;
};

type RefreshOpts = { tags?: string[]; search?: string };
type GroupBucket = { id: string; title: string; items: Asset[] };

export default function AssetGrid({
  folderId,
  foldersVersion = 0,
  onUnauthorized,
  theme,
}: Props) {
  const [items, setItems] = useState<Asset[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [previewItem, setPreviewItem] = useState<Asset | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<"name" | "size" | "type" | "folder">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDownloading, setBulkDownloading] = useState<string | null>(null);
  const [pageSize] = useState<number>(() => {
    if (typeof window === "undefined") return ROWS_PER_BATCH;
    return rowsBatchSizeForWidth(window.innerWidth);
  });
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [dropUploading, setDropUploading] = useState(false);
  const zipPrompt = useZipImportPrompt();

  const handleApiError = (err: unknown, message?: string) => {
    if (err instanceof UnauthorizedError) {
      onUnauthorized?.();
      return true;
    }
    console.error(err);
    if (message) alert(message);
    return false;
  };

  const refresh = async (opts: RefreshOpts = {}) => {
    setLoading(true);
    setHasMore(false);
    setOffset(0);
    const search = opts.search ?? q;
    const tags = opts.tags ?? activeTags;
    const targetFolderId = folderId || undefined;
    const [assetsResult, tagsResult] = await Promise.allSettled([
      listAssets({
        q: search,
        tags,
        folder_id: targetFolderId,
        limit: pageSize,
        offset: 0,
      }),
      listTags({
        q: search,
        folder_id: targetFolderId,
      }),
    ]);

    if (assetsResult.status === "fulfilled") {
      setItems(assetsResult.value.items);
      setOffset(assetsResult.value.items.length);
      setHasMore(assetsResult.value.hasMore);
    } else {
      handleApiError(assetsResult.reason, "Failed to load assets. Please sign in again or refresh.");
    }

    if (tagsResult.status === "fulfilled") {
      setAllTags(tagsResult.value);
    } else {
      setAllTags([]);
      handleApiError(tagsResult.reason);
    }

    setLoading(false);
  };

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await listAssets({
        q,
        tags: activeTags,
        folder_id: folderId || undefined,
        limit: pageSize,
        offset,
      });
      setItems(prev => [...prev, ...data.items]);
      setOffset(offset + data.items.length);
      setHasMore(data.hasMore);
    } catch (err) {
      handleApiError(err, "Failed to load more assets.");
    } finally {
      setLoadingMore(false);
    }
  };

  const isFileDrag = (e: React.DragEvent<HTMLDivElement>) => {
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes("Files");
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragActive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);
    setDropUploading(true);
    const entries = await entriesFromDataTransfer(e.dataTransfer);
    if (!entries.length) {
      setDropUploading(false);
      return;
    }
    const normalEntries = entries.filter(entry => !isZipFile(entry.file.name));
    const zipEntries = entries.filter(entry => isZipFile(entry.file.name));
    let uploaded = 0;
    const failed: string[] = [];
    const applyResult = (result: { uploaded: number; failed: string[] }) => {
      uploaded += result.uploaded;
      failed.push(...result.failed);
    };
    if (normalEntries.length) {
      const result = await uploadEntriesToFolder(normalEntries, folderId || null, onUnauthorized);
      applyResult(result);
    }
    for (const entry of zipEntries) {
      let zipData: Record<string, Uint8Array> | null = null;
      const baseParts = entry.relativePath.split("/").filter(Boolean);
      baseParts.pop();
      const basePath = baseParts.join("/");
      await zipPrompt.prompt({
        label: entry.file.name,
        onImportAsZip: async () => {
          const result = await uploadEntriesToFolder([entry], folderId || null, onUnauthorized);
          applyResult(result);
        },
        loadEntries: async () => {
          const result = await readZipEntries(entry.file);
          zipData = result.data;
          return result.entries;
        },
        onImportSelected: async (selectedPaths: string[]) => {
          if (!zipData) {
            const result = await readZipEntries(entry.file);
            zipData = result.data;
          }
          const unzipEntries = buildUploadEntriesFromZip(zipData || {}, selectedPaths, basePath);
          const result = await uploadEntriesToFolder(unzipEntries, folderId || null, onUnauthorized);
          applyResult(result);
        },
      });
    }
    if (uploaded) {
      await refresh();
    }
    if (failed.length) {
      alert(`Failed to upload: ${failed.join(", ")}`);
    }
    setDropUploading(false);
  };

  useEffect(() => { refresh(); }, [folderId]);
  useEffect(() => {
    (async () => {
      try {
        setFolders(await listFolders());
      } catch (err) {
        handleApiError(err, "Failed to load folders. Please refresh.");
      }
    })();
  }, [foldersVersion]);

  useEffect(() => {
    const present = new Set(items.map(i => i.id));
    setSelectedIds(prev => new Set([...prev].filter(id => present.has(id))));
  }, [items]);

  const itemById = useMemo(() => {
    const map: Record<string, Asset> = {};
    items.forEach(it => { map[it.id] = it; });
    return map;
  }, [items]);

  const folderById = useMemo(() => {
    const map: Record<string, Folder> = {};
    folders.forEach(f => { map[f.id] = f; });
    return map;
  }, [folders]);

  const dropTargetName = useMemo(() => {
    if (!folderId) return "All Items";
    return folderById[folderId]?.name || "this folder";
  }, [folderId, folderById]);

  const folderNames = useMemo(() => {
    const m: Record<string, string> = {};
    const pathFor = (f: Folder): string => {
      const parts = [f.name || "Untitled"];
      let current = f;
      const guard = new Set<string>([f.id]);
      while (current.parent_id) {
        const parent = folderById[current.parent_id];
        if (!parent || guard.has(parent.id)) break;
        parts.unshift(parent.name || "Untitled");
        guard.add(parent.id);
        current = parent;
      }
      return parts.join(" / ");
    };
    for (const f of folders) {
      m[f.id] = pathFor(f);
    }
    return m;
  }, [folders, folderById]);

  const folderOptions = useMemo(() => {
    return [
      { id: null as string | null, name: "Unassigned" },
      ...folders
        .map(f => ({ id: f.id, name: folderNames[f.id] || f.name || "Untitled" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }, [folders, folderNames]);

  const sortedItems = useMemo(() => {
    const copy = [...items];
    const dir = sortDir === "asc" ? 1 : -1;
    const nameForFolder = (a: Asset) => (a.folder_id ? folderNames[a.folder_id] || "" : "");
    copy.sort((a, b) => {
      if (sortKey === "size") {
        return (a.size - b.size) * dir;
      }
      if (sortKey === "type") {
        return extOf(a.filename).localeCompare(extOf(b.filename)) * dir;
      }
      if (sortKey === "folder") {
        return nameForFolder(a).localeCompare(nameForFolder(b)) * dir;
      }
      // default name
      return a.filename.localeCompare(b.filename) * dir;
    });
    return copy;
  }, [items, sortKey, sortDir, folderNames]);

  const folderGroups = useMemo<GroupBucket[]>(() => {
    if (sortKey !== "folder") return [];
    const grouping: Record<string, GroupBucket> = {};
    for (const item of items) {
      const key = item.folder_id || "__ungrouped";
      if (!grouping[key]) {
        grouping[key] = {
          id: `folder:${key}`,
          title: item.folder_id ? folderNames[item.folder_id] || "Untitled" : "Unassigned",
          items: [],
        };
      }
      grouping[key].items.push(item);
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return Object.values(grouping)
      .sort((a, b) => a.title.localeCompare(b.title) * dir)
      .map(group => ({
        ...group,
        items: group.items.sort((a, b) => a.filename.localeCompare(b.filename)),
      }));
  }, [items, folderNames, sortKey, sortDir]);

  const typeGroups = useMemo<GroupBucket[]>(() => {
    if (sortKey !== "type") return [];
    const grouping: Record<string, GroupBucket> = {};
    for (const item of items) {
      const ext = extOf(item.filename) || "other";
      if (!grouping[ext]) {
        grouping[ext] = {
          id: `type:${ext}`,
          title: ext === "other" ? "Other" : ext.toUpperCase(),
          items: [],
        };
      }
      grouping[ext].items.push(item);
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return Object.values(grouping)
      .sort((a, b) => a.title.localeCompare(b.title) * dir)
      .map(group => ({
        ...group,
        items: group.items.sort((a, b) => a.filename.localeCompare(b.filename)),
      }));
  }, [items, sortKey, sortDir]);

  const toggleGroup = (id: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTag = (t: string) => {
    setActiveTags(prev => {
      const next = prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t];
      refresh({ tags: next });
      return next;
    });
  };

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filenameFromDisposition = (res: Response, fallback: string) => {
    const dispo = res.headers.get("content-disposition") || "";
    const match = dispo.match(/filename="?([^\";]+)"?/i);
    return (match && match[1]) || fallback || "download";
  };

  const saveResponseToDisk = async (res: Response, fallback: string) => {
    const filename = filenameFromDisposition(res, fallback);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  };

  const onSaveTags = async (id: string, tags: string[]) => {
    const bulkEdit = selectedIds.has(id) && selectedIds.size > 1;
    const targets = bulkEdit ? Array.from(selectedIds) : [id];
    const failed: string[] = [];
    let aborted = false;
    for (const targetId of targets) {
      try {
        await setTags(targetId, tags);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.();
          aborted = true;
          break;
        }
        console.error(err);
        failed.push(itemById[targetId]?.filename || targetId);
      }
    }
    if (!aborted) {
      await refresh();
      if (bulkEdit) {
        setSelectedIds(new Set());
      }
    }
    if (failed.length) {
      alert(`Tag update failed for: ${failed.join(", ")}`);
    }
  };

  const onSaveNotes = async (id: string, notes: string) => {
    try {
      await updateAssetMeta(id, { notes });
      await refresh();
    } catch (err) {
      handleApiError(err, "Failed to save notes. Please try again.");
    }
  };

  const onRename = async (id: string, filename: string) => {
    try {
      await renameAsset(id, filename);
      await refresh();
    } catch (err) {
      handleApiError(err, "Rename failed. Please try again.");
    }
  };

  const onMoveFolder = async (id: string, folder_id: string | null) => {
    try {
      setMovingId(id);
      await updateAssetFolder(id, folder_id);
      await refresh();
    } catch (err) {
      if (!handleApiError(err)) {
        alert("Folder update failed. Please try again.");
      }
    } finally {
      setMovingId(null);
    }
  };

  const downloadAsset = async (asset: Asset) => {
    try {
      setDownloadingId(asset.id);
      const res = await fetch(fileUrl(asset.url));
      if (res.status === 401) {
        onUnauthorized?.();
        throw new Error("Unauthorized");
      }
      if (!res.ok) throw new Error("Download failed");
      await saveResponseToDisk(res, asset.filename || "download");
    } catch (err) {
      if (!handleApiError(err)) {
        console.error(err);
        alert("Download failed. Please try again.");
      }
    } finally {
      setDownloadingId(null);
    }
  };

  const downloadSelected = async () => {
    if (!selectedIds.size) {
      alert("Select at least one item to download.");
      return;
    }
    try {
      setBulkDownloading("selected");
      const res = await downloadZip({ asset_ids: Array.from(selectedIds) });
      await saveResponseToDisk(res, "makersvault-selected.zip");
    } catch (err) {
      if (!handleApiError(err, "Bulk download failed.")) {
        console.error(err);
      }
    } finally {
      setBulkDownloading(null);
    }
  };

  const downloadByTag = async (tag: string) => {
    if (!tag) return;
    try {
      setBulkDownloading(`tag:${tag}`);
      const res = await downloadZip({ tag });
      await saveResponseToDisk(res, `${tag}.zip`);
    } catch (err) {
      if (!handleApiError(err, "Download by tag failed.")) {
        console.error(err);
      }
    } finally {
      setBulkDownloading(null);
    }
  };

  const removeAsset = async (asset: Asset) => {
    const targets = selectedIds.has(asset.id) && selectedIds.size > 1
      ? Array.from(selectedIds)
      : [asset.id];
    const confirmLabel = targets.length > 1
      ? `Delete ${targets.length} selected items? This cannot be undone.`
      : `Delete "${asset.title || asset.filename}"? This cannot be undone.`;
    if (!confirm(confirmLabel)) {
      return;
    }
    setDeletingId(asset.id);
    const failed: string[] = [];
    let aborted = false;
    for (const targetId of targets) {
      try {
        await deleteAsset(targetId);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.();
          aborted = true;
          break;
        }
        console.error(err);
        failed.push(itemById[targetId]?.filename || targetId);
      }
    }
    if (!aborted) {
      await refresh();
    }
    if (failed.length) {
      alert(`Delete failed for: ${failed.join(", ")}`);
    }
    setDeletingId(null);
  };

  const showDropOverlay = dragActive || dropUploading;
  const dropMessage = dropUploading
    ? `Uploading to ${dropTargetName}...`
    : `Drop files or folders to upload to ${dropTargetName}`;

  return (
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showDropOverlay && (
        <div className="absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-panel-overlay pointer-events-none">
          <div className="px-4 py-3 rounded-md border border-panel-strong bg-panel-strong shadow-sm text-sm">
            {dropMessage}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <input
          value={q}
          onChange={e=>setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              const val = (e.currentTarget as HTMLInputElement).value;
              refresh({ search: val });
            }
          }}
          placeholder="Search title, filename, notes..."
          className="px-3 py-2 rounded-md border border-panel-strong bg-panel-soft w-80"
        />
        <button
          className="px-3 py-2 rounded-md border border-panel-strong disabled:opacity-60"
          onClick={() => refresh({ search: q })}
          disabled={loading}
        >
          Search
        </button>
        {loading && <span className="text-sm opacity-70">Loading...</span>}
        <div className="flex items-center gap-2 text-sm">
          <span className="opacity-70">Sort</span>
          <select
            className="px-2 py-1 rounded-md border border-panel-strong bg-panel-soft"
            value={sortKey}
            onChange={e => setSortKey(e.target.value as typeof sortKey)}
          >
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="type">File type</option>
            <option value="folder">Folder</option>
          </select>
          <button
            type="button"
            onClick={() => setSortDir(prev => (prev === "asc" ? "desc" : "asc"))}
            className="px-2 py-1 rounded-md border border-panel-strong"
          >
            {sortDir === "asc" ? "Asc" : "Desc"}
          </button>
        </div>
      </div>

      {!!allTags.length && (
        <div className="flex flex-wrap gap-2">
          {allTags.map(t => {
            const colors = colorForTag(t);
            const active = activeTags.includes(t);
            return (
              <button
                key={t}
                className={`px-2 py-1 rounded-full text-sm border transition-colors ${
                  active ? "ring-2 ring-offset-1 ring-[color:var(--mv-accent)] ring-offset-[color:var(--mv-bg)]" : ""
                }`}
                style={{
                  backgroundColor: active ? colors.bg : "transparent",
                  color: colors.text,
                  borderColor: colors.border,
                }}
                onClick={()=>toggleTag(t)}
              >
                {t}
              </button>
            );
          })}
          {activeTags.length>0 && (
            <button
              className="px-2 py-1 rounded-full text-sm border border-panel-strong"
              onClick={() => { setActiveTags([]); refresh({ tags: [] }); }}
            >
              Reset
            </button>
          )}
        </div>
      )}

      {["folder", "type"].includes(sortKey) ? (
        <div className="space-y-4">
          {(sortKey === "folder" ? folderGroups : typeGroups).map(group => {
            const collapsed = collapsedGroups.has(group.id);
            return (
              <div
                key={group.id}
                className="rounded-lg border border-panel bg-panel-soft"
              >
                <button
                  className="w-full flex items-center justify-between px-4 py-3 text-left"
                  onClick={() => toggleGroup(group.id)}
                >
                  <div>
                    <div className="font-medium">{group.title}</div>
                    <div className="text-xs opacity-70">{group.items.length} item{group.items.length === 1 ? "" : "s"}</div>
                  </div>
                  <span className="text-sm opacity-70">{collapsed ? "Show" : "Hide"}</span>
                </button>
                {!collapsed && (
                  <div className="px-4 pb-4 overflow-x-auto">
                    <div className="flex gap-4 min-h-[280px]">
                      {group.items.map(it => (
                        <div key={it.id} className="min-w-[260px] max-w-[320px]">
                          <AssetCard
                            item={it}
                            onSaveTags={onSaveTags}
                            onSaveNotes={onSaveNotes}
                            onRename={onRename}
                            onPreview={setPreviewItem}
                            onDownloadSingle={downloadAsset}
                            downloading={downloadingId === it.id}
                            onDelete={removeAsset}
                            deleting={deletingId === it.id}
                            onMoveFolder={onMoveFolder}
                            folderOptions={folderOptions}
                            moving={movingId === it.id}
                            onDownloadByTag={downloadByTag}
                            onDownloadSelected={downloadSelected}
                            selected={selectedIds.has(it.id)}
                            onToggleSelected={() => toggleSelected(it.id)}
                            hasSelection={selectedIds.size > 0}
                            bulkDownloading={Boolean(bulkDownloading)}
                            theme={theme}
                          />
                        </div>
                      ))}
                      {!group.items.length && (
                        <div className="px-2 py-4 text-sm opacity-60">No assets in this folder</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {sortedItems.map(it => (
            <AssetCard
              key={it.id}
              item={it}
              onSaveTags={onSaveTags}
              onSaveNotes={onSaveNotes}
              onRename={onRename}
              onPreview={setPreviewItem}
              onDownloadSingle={downloadAsset}
              downloading={downloadingId === it.id}
              onDelete={removeAsset}
              deleting={deletingId === it.id}
              onMoveFolder={onMoveFolder}
              folderOptions={folderOptions}
              moving={movingId === it.id}
              onDownloadByTag={downloadByTag}
              onDownloadSelected={downloadSelected}
              selected={selectedIds.has(it.id)}
              onToggleSelected={() => toggleSelected(it.id)}
              hasSelection={selectedIds.size > 0}
              bulkDownloading={Boolean(bulkDownloading)}
              theme={theme}
            />
          ))}
        </div>
      )}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            className="px-4 py-2 rounded-md border border-panel-strong text-sm disabled:opacity-60"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
      {previewItem && (
        <AssetPreviewModal asset={previewItem} theme={theme} onClose={() => setPreviewItem(null)} />
      )}
      {zipPrompt.modal}
      </div>
    </div>
  );
}

