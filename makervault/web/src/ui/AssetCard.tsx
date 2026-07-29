import React, { useEffect, useState } from "react";
import { Asset } from "../lib/api";
import { ResolvedTheme } from "../lib/settings";
import TagBadge from "./TagBadge";
import TagInput from "./TagInput";
import { renderPreviewContent } from "./AssetPreview";

export type AssetCardProps = {
  item: Asset;
  onSaveTags: (id: string, tags: string[]) => void;
  onSaveNotes: (id: string, notes: string) => void;
  onRename: (id: string, filename: string) => void;
  onPreview: (asset: Asset | null) => void;
  onDownloadSingle: (asset: Asset) => void;
  onDownloadByTag: (tag: string) => void;
  onDownloadSelected: () => void;
  downloading: boolean;
  onDelete: (asset: Asset) => void;
  deleting: boolean;
  onMoveFolder: (id: string, folder_id: string | null) => void;
  folderOptions: { id: string | null; name: string }[];
  moving: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  hasSelection: boolean;
  bulkDownloading: boolean;
  theme: ResolvedTheme;
};

export default function AssetCard({
  item,
  onSaveTags,
  onSaveNotes,
  onRename,
  onPreview,
  onDownloadSingle,
  onDownloadByTag,
  onDownloadSelected,
  downloading,
  onDelete,
  deleting,
  onMoveFolder,
  folderOptions,
  moving,
  selected,
  onToggleSelected,
  hasSelection,
  bulkDownloading,
  theme,
}: AssetCardProps) {
  const [editingTags, setEditingTags] = useState(false);
  const [tagList, setTagList] = useState<string[]>(item.tags);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(item.notes || "");
  const [notesCollapsed, setNotesCollapsed] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(item.filename);
  const nameInputRef = React.useRef<HTMLInputElement | null>(null);
  const [downloadChoice, setDownloadChoice] = useState("");

  useEffect(() => {
    if (!editingTags) {
      setTagList(item.tags);
    }
  }, [item.tags, editingTags]);

  useEffect(() => {
    if (!editingNotes) {
      setNotesValue(item.notes || "");
    }
  }, [item.notes, editingNotes]);

  useEffect(() => {
    if (!renaming) {
      setNameValue(item.filename);
    } else {
      setTimeout(() => nameInputRef.current?.select(), 0);
    }
  }, [item.filename, renaming]);

  const startEditing = () => {
    setTagList(item.tags);
    setEditingTags(true);
  };

  const cancelEditing = () => {
    setEditingTags(false);
    setTagList(item.tags);
  };

  const save = async () => {
    await onSaveTags(item.id, tagList);
    setEditingTags(false);
  };

  const saveNotes = async () => {
    await onSaveNotes(item.id, notesValue);
    setEditingNotes(false);
  };

  const cancelNotes = () => {
    setEditingNotes(false);
    setNotesValue(item.notes || "");
  };

  const handleFolderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    onMoveFolder(item.id, val === "" ? null : val);
  };

  const handleDownloadChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (!val) return;
    setDownloadChoice("");
    if (val === "single") {
      onDownloadSingle(item);
    } else if (val === "selected") {
      onDownloadSelected();
    } else if (val.startsWith("tag:")) {
      onDownloadByTag(val.slice(4));
    }
  };

  const commitRename = async () => {
    const next = nameValue.trim();
    if (!next || next === item.filename) {
      setNameValue(item.filename);
      setRenaming(false);
      return;
    }
    try {
      await onRename(item.id, next);
      setRenaming(false);
    } catch {
      setNameValue(item.filename);
      setRenaming(false);
    }
  };

  const handleRenameKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setNameValue(item.filename);
      setRenaming(false);
    }
  };

  const noteText = notesValue.trim();

  return (
    <div className="rounded-lg border border-panel overflow-hidden bg-panel-soft">
      <div
        className="h-40 relative cursor-pointer"
        onDoubleClick={() => onPreview(item)}
        title="Double-click to open large preview"
        onClick={e => e.stopPropagation()}
      >
        {renderPreviewContent(item, "card", theme)}
      </div>
      <div className="p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelected}
              className="w-4 h-4"
            />
            <span>Select</span>
          </label>
          <div className="flex items-center gap-2">
            <select
              value={downloadChoice}
              onChange={handleDownloadChange}
              disabled={downloading || bulkDownloading}
              className="px-2 py-1 rounded-md border border-panel-strong bg-panel-strong text-sm"
            >
              <option value="">Download...</option>
              <option value="single">Download file</option>
              <option value="selected" disabled={!hasSelection}>Download all selected</option>
              {item.tags.map(t => (
                <option key={`tag-${t}`} value={`tag:${t}`}>Download tag: {t}</option>
              ))}
            </select>
            {(downloading || bulkDownloading) && (
              <span className="text-xs opacity-70">{downloading ? "Downloading..." : "Preparing..."}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold uppercase text-muted">
            {moving ? "Updating..." : "Folder"}
          </label>
          <select
            value={item.folder_id || ""}
            onChange={handleFolderChange}
            disabled={moving}
            className="px-2 py-1 rounded-md border border-panel-strong bg-panel-strong text-sm"
          >
            {folderOptions.map(opt => (
              <option key={opt.id || "none"} value={opt.id || ""}>
                {opt.name}
              </option>
            ))}
          </select>
        </div>
        <div
          className="text-sm font-medium truncate cursor-text"
          title={item.filename}
          onDoubleClick={e => { e.stopPropagation(); setRenaming(true); }}
          onClick={e => renaming && e.stopPropagation()}
        >
          {renaming ? (
            <input
              ref={nameInputRef}
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleRenameKey}
              onClick={e => e.stopPropagation()}
              className="px-2 py-1 w-full rounded-md border border-panel-strong bg-panel-soft text-sm"
              autoFocus
            />
          ) : (
            item.title || item.filename
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {item.tags.length ? (
            item.tags.map(t => <TagBadge key={t} tag={t} />)
          ) : (
            <span className="text-xs opacity-60">No tags</span>
          )}
        </div>
        <div className="border border-dashed border-panel-strong rounded-md p-2 text-sm flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs uppercase tracking-wide text-muted">
            <span>Notes</span>
            <button
              className="text-[11px] px-2 py-0.5 rounded-md border border-panel-strong"
              onClick={() => setNotesCollapsed(v => !v)}
            >
              {notesCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
          {!notesCollapsed && (
            <>
              {editingNotes ? (
                <>
                  <textarea
                    value={notesValue}
                    onChange={e => setNotesValue(e.target.value)}
                    className="w-full min-h-[80px] rounded-md border border-panel-strong bg-panel-soft p-2"
                    placeholder="Add some details about this asset"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button className="text-sm px-3 py-1 rounded-md bg-accent" onClick={saveNotes}>Save</button>
                    <button className="text-sm px-3 py-1 rounded-md border border-panel-strong" onClick={cancelNotes}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <div className={`text-sm whitespace-pre-wrap ${noteText ? "text-foreground" : "opacity-60"}`}>
                    {noteText || "Add notes"}
                  </div>
                  <button
                    className="self-start text-xs px-2 py-1 rounded-md border border-panel-strong"
                    onClick={() => setEditingNotes(true)}
                  >
                    {noteText ? "Edit notes" : "Add notes"}
                  </button>
                </>
              )}
            </>
          )}
          {notesCollapsed && (
            <div className={`text-sm ${noteText ? "text-foreground" : "opacity-60"}`}>
              {noteText ? `${noteText.slice(0, 60)}${noteText.length > 60 ? "..." : ""}` : "No notes"}
            </div>
          )}
        </div>

        {editingTags ? (
          <div className="flex flex-col gap-2">
            <TagInput
              value={tagList}
              onChange={setTagList}
              placeholder="Type and press comma/Enter"
            />
            <div className="flex flex-wrap gap-2">
              <button className="text-sm px-3 py-1 rounded-md bg-accent" onClick={save}>Save</button>
              <button className="text-sm px-3 py-1 rounded-md border border-panel-strong" onClick={cancelEditing}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <button className="text-sm px-2 py-1 rounded-md border border-panel-strong" onClick={startEditing}>Edit tags</button>
            <button
              className="text-sm px-2 py-1 rounded-md border border-red-300 text-red-700 dark:text-red-300 disabled:opacity-60"
              onClick={() => onDelete(item)}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
