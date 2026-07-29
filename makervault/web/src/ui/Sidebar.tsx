import React, { useEffect, useState } from "react";
import { Folder, UnauthorizedError, createFolder, deleteFolder, downloadFolderZip, listFolders, updateFolder } from "../lib/api";
import { entriesFromDataTransfer, uploadEntriesToFolder } from "../lib/uploadTree";
import { buildUploadEntriesFromZip, isZipFile, readZipEntries } from "../lib/zipUtils";
import TagInput from "./TagInput";
import { useZipImportPrompt } from "./ZipImportModal";

type Props = {
  selectedId?: string | null;
  onSelect: (id: string | null) => void;
  onFoldersChanged?: () => void;
  foldersVersion?: number;
  onUnauthorized?: () => void;
  onOpenSettings?: () => void;
  activeView?: "library" | "settings";
  onAssetsChanged?: () => void;
};

const DROP_ALL_ID = "__all";

export default function Sidebar({
  selectedId,
  onSelect,
  onFoldersChanged,
  foldersVersion,
  onUnauthorized,
  onOpenSettings,
  activeView = "library",
  onAssetsChanged,
}: Props) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editParent, setEditParent] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropUploading, setDropUploading] = useState(false);
  const zipPrompt = useZipImportPrompt();

  const uploadWithZipPrompt = async (entries: Awaited<ReturnType<typeof entriesFromDataTransfer>>, folderId: string | null) => {
    const normalEntries = entries.filter(entry => !isZipFile(entry.file.name));
    const zipEntries = entries.filter(entry => isZipFile(entry.file.name));
    let uploaded = 0;
    const failed: string[] = [];
    const applyResult = (result: { uploaded: number; failed: string[] }) => {
      uploaded += result.uploaded;
      failed.push(...result.failed);
    };
    if (normalEntries.length) {
      const result = await uploadEntriesToFolder(normalEntries, folderId, onUnauthorized);
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
          const result = await uploadEntriesToFolder([entry], folderId, onUnauthorized);
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
          const result = await uploadEntriesToFolder(unzipEntries, folderId, onUnauthorized);
          applyResult(result);
        },
      });
    }
    if (uploaded) {
      onAssetsChanged?.();
    }
    if (failed.length) {
      alert(`Failed to upload: ${failed.join(", ")}`);
    }
  };

  const isFileDrag = (e: React.DragEvent<HTMLElement>) => {
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes("Files");
  };

  const handleDragOverTarget = (targetId: string) => (e: React.DragEvent<HTMLElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!dropUploading) {
      setDropTargetId(targetId);
    }
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDropFiles = (folderId: string | null) => async (
    e: React.DragEvent<HTMLElement>
  ) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (dropUploading) return;
    setDropTargetId(null);
    setDropUploading(true);
    const entries = await entriesFromDataTransfer(e.dataTransfer);
    if (!entries.length) {
      setDropUploading(false);
      return;
    }
    await uploadWithZipPrompt(entries, folderId);
    setDropUploading(false);
  };

  const handleSidebarDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  };

  const handleSidebarDragLeave = (e: React.DragEvent<HTMLElement>) => {
    if (!isFileDrag(e)) return;
    if (e.currentTarget !== e.target) return;
    e.preventDefault();
    setDropTargetId(null);
  };

  const handleSidebarDrop = (e: React.DragEvent<HTMLElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (dropUploading) return;
    const targetFolderId =
      dropTargetId === DROP_ALL_ID ? null : dropTargetId;
    setDropTargetId(null);
    if (!targetFolderId && dropTargetId !== DROP_ALL_ID) return;
    setDropUploading(true);
    void (async () => {
      const entries = await entriesFromDataTransfer(e.dataTransfer);
      if (!entries.length) {
        setDropUploading(false);
        return;
      }
      await uploadWithZipPrompt(entries, targetFolderId);
      setDropUploading(false);
    })();
  };

  const filenameFromDisposition = (res: Response, fallback: string) => {
    const dispo = res.headers.get("content-disposition") || "";
    const match = dispo.match(/filename="?([^\";]+)"?/i);
    return (match && match[1]) || fallback;
  };

  const saveResponseToDisk = async (res: Response, fallback: string) => {
    const filename = filenameFromDisposition(res, fallback);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleError = (err: unknown, message: string) => {
    if (err instanceof UnauthorizedError) {
      onUnauthorized?.();
      return;
    }
    console.error(err);
    alert(message);
  };

  const refresh = async () => {
    try {
      setFolders(await listFolders());
    } catch (err) {
      handleError(err, "Unable to load folders.");
    }
  };
  useEffect(() => { refresh(); }, [foldersVersion]);

  const startCreate = (parentId: string | null = null) => {
    setCreating(true);
    setNewName("");
    setNewParent(parentId ?? (selectedId || null));
  };
  const create = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await createFolder(newName.trim(), [], newParent || undefined);
      await refresh();
      if (newParent) {
        setExpanded(prev => new Set(prev).add(newParent));
      }
      onFoldersChanged?.();
    } catch (err) {
      handleError(err, "Folder creation failed. Please try again.");
    } finally { setBusy(false); setCreating(false); }
  };

  const startEdit = (f: Folder) => {
    setEditing(f.id);
    setEditName(f.name);
    setEditTags(f.tags);
    setEditParent(f.parent_id || null);
  };
  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await updateFolder(editing, editName.trim() || "Untitled", editTags, editParent || undefined);
      await refresh();
      onFoldersChanged?.();
    } catch (err) {
      handleError(err, "Folder update failed. Please try again.");
    } finally { setBusy(false); setEditing(null); setEditTags([]); setEditParent(null); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete folder? (Assets remain but become unassigned)")) return;
    setBusy(true);
    try {
      await deleteFolder(id);
      await refresh();
      onFoldersChanged?.();
      if (selectedId === id) onSelect(null);
    }
    catch (err) {
      handleError(err, "Failed to delete folder.");
    }
    finally { setBusy(false); }
  };

  const downloadFolder = async (folder: Folder) => {
    setBusy(true);
    try {
      const res = await downloadFolderZip(folder.id);
      const safe = (folder.name || "folder").replace(/\s+/g, "_") || "folder";
      await saveResponseToDisk(res, `${safe}.zip`);
    } catch (err) {
      handleError(err, "Unable to download folder.");
    } finally {
      setBusy(false);
    }
  };

  const folderById = React.useMemo(() => {
    const map: Record<string, Folder> = {};
    folders.forEach(f => { map[f.id] = f; });
    return map;
  }, [folders]);

  useEffect(() => {
    // Ensure selected folder path is expanded
    if (!selectedId) return;
    const next = new Set(expanded);
    let current = folderById[selectedId];
    const guard = new Set<string>();
    while (current?.parent_id && !guard.has(current.parent_id)) {
      next.add(current.parent_id);
      guard.add(current.parent_id);
      current = folderById[current.parent_id];
    }
    setExpanded(next);
  }, [selectedId, folderById]);

  const isDescendant = React.useCallback(
    (candidateId: string, targetId: string) => {
      let current = folderById[candidateId];
      const guard = new Set<string>();
      while (current) {
        if (!current.parent_id) return false;
        if (current.parent_id === targetId) return true;
        if (guard.has(current.parent_id)) break;
        guard.add(current.parent_id);
        current = folderById[current.parent_id];
      }
      return false;
    },
    [folderById]
  );

  const folderPath = React.useCallback(
    (folder: Folder) => {
      const segments = [folder.name || "Untitled"];
      let current = folder;
      const guard = new Set<string>([folder.id]);
      while (current.parent_id) {
        const parent = folderById[current.parent_id];
        if (!parent || guard.has(parent.id)) break;
        segments.unshift(parent.name || "Untitled");
        guard.add(parent.id);
        current = parent;
      }
      return segments.join(" / ");
    },
    [folderById]
  );

  const folderOptions = React.useMemo(() => {
    const opts = [{ id: null as string | null, name: "(Root)" }];
    const sorted = [...folders].sort((a, b) => folderPath(a).localeCompare(folderPath(b)));
    sorted.forEach(f => opts.push({ id: f.id, name: folderPath(f) }));
    return opts;
  }, [folders, folderPath]);

  const childrenMap = React.useMemo(() => {
    const map: Record<string, Folder[]> = {};
    const push = (key: string, f: Folder) => {
      if (!map[key]) map[key] = [];
      map[key].push(f);
    };
    folders.forEach(f => push(f.parent_id || "__root", f));
    Object.values(map).forEach(list => list.sort((a, b) => a.name.localeCompare(b.name)));
    return map;
  }, [folders]);

  // Default-expand root folders so they are visible
  useEffect(() => {
    const roots = childrenMap["__root"] || [];
    if (!roots.length) return;
    setExpanded(prev => {
      const next = new Set(prev);
      roots.forEach(r => next.add(r.id));
      return next;
    });
  }, [childrenMap]);

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const closeFolderMenu = (e: React.MouseEvent<HTMLElement>) => {
    const details = e.currentTarget.closest("details") as HTMLDetailsElement | null;
    if (details?.open) {
      details.open = false;
    }
  };

  const renderFolderNode = (folder: Folder, depth = 0) => {
    const children = childrenMap[folder.id] || [];
    const isSelected = selectedId === folder.id;
    const isOpen = expanded.has(folder.id);
    const isDropTarget = dropTargetId === folder.id;
    return (
      <div key={folder.id} className="flex flex-col w-full">
        <div
          className={`flex items-center gap-1.5 w-full rounded-md px-1.5 py-1.5 min-h-[32px] transition-smooth ${
            isSelected ? "bg-accent-soft" : "hover:bg-panel-soft"
          } ${isDropTarget ? "ring-2 ring-[color:var(--mv-accent)] ring-offset-1 ring-offset-[color:var(--mv-panel-strong)]" : ""}`}
          style={{ paddingLeft: 6 + depth * 10 }}
          onDragOver={handleDragOverTarget(folder.id)}
          onDrop={handleDropFiles(folder.id)}
        >
          {children.length ? (
            <button
              onClick={() => toggleExpand(folder.id)}
              className="text-xs w-4 h-4 flex items-center justify-center rounded border border-transparent hover:border-panel-strong shrink-0"
              aria-label={isOpen ? "Collapse" : "Expand"}
            >
              {isOpen ? "▾" : "▸"}
            </button>
          ) : (
            <span className="w-4 h-4 shrink-0" />
          )}
          <button className="flex-1 text-left truncate text-sm" onClick={() => onSelect(folder.id)} title={folderPath(folder)}>
            {depth > 0 ? "– " : ""}
            {folder.name || "Untitled"}
          </button>
          <div className="relative shrink-0">
            <details className="group">
              <summary className="list-none w-6 h-6 rounded-md border border-panel-strong flex items-center justify-center text-xs cursor-pointer select-none hover:bg-panel-soft">
                ⋯
              </summary>
              <div className="absolute right-0 mt-1 min-w-[130px] rounded-md border border-panel bg-panel-strong shadow-md z-10 overflow-hidden">
                <button
                  className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-panel-soft disabled:opacity-60"
                  disabled={busy}
                  onClick={(e) => { closeFolderMenu(e); startCreate(folder.id); }}
                >
                  + Subfolder
                </button>
                <button
                  className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-panel-soft disabled:opacity-60"
                  disabled={busy}
                  onClick={(e) => { closeFolderMenu(e); startEdit(folder); }}
                >
                  Edit
                </button>
                <button
                  className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-panel-soft disabled:opacity-60"
                  disabled={busy}
                  onClick={(e) => { closeFolderMenu(e); downloadFolder(folder); }}
                >
                  Zip download
                </button>
                <button
                  className="w-full text-left px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/40 disabled:opacity-60"
                  disabled={busy}
                  onClick={(e) => { closeFolderMenu(e); remove(folder.id); }}
                >
                  Delete
                </button>
              </div>
            </details>
          </div>
        </div>
        {isOpen && (
          <div className="flex flex-col w-full">
            {children.map(child => renderFolderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className="w-56 border-r border-panel p-2.5 flex flex-col gap-2.5"
    onDragOver={handleSidebarDragOver}
    onDragLeave={handleSidebarDragLeave}
    onDrop={handleSidebarDrop}
  >
    <div className="flex items-center justify-between">
      <div className="text-xs text-muted font-medium">Folders</div>
      <button className="h-7 px-2 text-xs rounded-md border border-panel-strong transition-smooth hover:bg-panel-soft" onClick={() => startCreate(null)}>New</button>
    </div>

    <button
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md border border-transparent text-sm transition-smooth ${
        !selectedId ? "bg-accent-soft" : "hover:bg-panel-soft"
      } ${dropTargetId === DROP_ALL_ID ? "border-accent ring-2 ring-[color:var(--mv-accent)] ring-offset-1 ring-offset-[color:var(--mv-panel-strong)]" : ""}`}
      onClick={() => onSelect(null)}
      onDragOver={handleDragOverTarget(DROP_ALL_ID)}
      onDrop={handleDropFiles(null)}
    >
      <span>All Items</span>
    </button>

    <div className="flex flex-col gap-0.5">
      {(childrenMap["__root"] || []).map(f => renderFolderNode(f, 0))}
      {folders.length === 0 && <div className="text-xs text-muted px-2">No folders yet</div>}
    </div>

      {creating && (
        <div className="mt-1 flex flex-col gap-1.5">
          <input
            value={newName}
            onChange={e=>setNewName(e.target.value)}
            placeholder="Folder name"
            className="px-2 py-1 text-sm rounded-md border border-panel-strong w-full bg-panel-strong text-foreground"
            autoFocus
          />
          <select
            value={newParent || ""}
            onChange={e => setNewParent(e.target.value || null)}
            className="px-2 py-1 text-xs rounded-md border border-panel-strong w-full bg-panel-strong text-foreground"
          >
            {folderOptions.map(opt => (
              <option key={opt.id ?? "root"} value={opt.id || ""}>{opt.name}</option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <button disabled={busy} className="text-xs px-2 py-1 rounded-md bg-accent flex-1" onClick={create}>Create</button>
            <button className="text-xs px-2 py-1 rounded-md border border-panel-strong flex-1" onClick={()=>{ setCreating(false); setNewParent(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {editing && (
        <div className="mt-1 flex flex-col gap-1.5">
          <input
            value={editName}
            onChange={e=>setEditName(e.target.value)}
            className="px-2 py-1 text-sm rounded-md border border-panel-strong bg-panel-strong text-foreground"
            autoFocus
          />
          <select
            value={editParent || ""}
            onChange={e => setEditParent(e.target.value || null)}
            className="px-2 py-1 text-xs rounded-md border border-panel-strong bg-panel-strong text-foreground"
          >
            {folderOptions
              .filter(opt => !editing || (opt.id !== editing && !(opt.id && isDescendant(opt.id, editing))))
              .map(opt => (
                <option key={opt.id ?? "root"} value={opt.id || ""}>{opt.name}</option>
              ))}
          </select>
          <TagInput value={editTags} onChange={setEditTags} placeholder="Add folder tags" />
          <div className="flex items-center gap-1.5">
            <button disabled={busy} className="text-xs px-2 py-1 rounded-md bg-accent" onClick={saveEdit}>Save</button>
            <button className="text-xs px-2 py-1 rounded-md border border-panel-strong" onClick={()=>{ setEditing(null); setEditTags([]); setEditParent(null); }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="mt-auto pt-2 border-t border-panel">
        <button
          type="button"
          onClick={onOpenSettings}
          className={`w-full flex items-center gap-2 h-8 px-3 rounded-md border text-sm transition-smooth ${
            activeView === "settings"
              ? "bg-accent-soft border-accent-soft"
              : "border-panel-strong hover:bg-panel-soft"
          }`}
          aria-label="Settings"
        >
          <GearIcon className="w-4 h-4" />
          <span>Settings</span>
        </button>
      </div>
      {zipPrompt.modal}
    </aside>
  );
}

function GearIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.54-1H3a2 2 0 0 1 0-4h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34 1.7 1.7 0 0 0 1-1.54V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1 1.54 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.54 1H21a2 2 0 0 1 0 4h-.08a1.7 1.7 0 0 0-1.54 1z" />
    </svg>
  );
}
