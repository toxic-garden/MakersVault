import React, { useEffect, useState } from "react";
import { Download, Folder as FolderIcon, Pencil, Trash2, Type } from "lucide-react";
import { Asset } from "../lib/api";
import { ResolvedTheme } from "../lib/settings";
import TagBadge from "./TagBadge";
import TagInput from "./TagInput";
import { renderPreviewContent } from "./AssetPreview";

export type AssetCardProps = {
  item: Asset;
  onSaveTags: (id: string, tags: string[]) => void;
  onSaveNotes: (id: string, notes: string) => void;
  onSaveTitle: (id: string, title: string) => void;
  onRename: (id: string, filename: string) => void;
  onPreview: (asset: Asset | null) => void;
  onDownloadSingle: (asset: Asset) => void;
  downloading: boolean;
  onDelete: (asset: Asset) => void;
  deleting: boolean;
  onMoveFolder: (id: string, folder_id: string | null) => void;
  folderOptions: { id: string | null; name: string }[];
  moving: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  bulkDownloading: boolean;
  theme: ResolvedTheme;
};

const MAX_TAGS_COLLAPSED = 3;

export default function AssetCard({
  item,
  onSaveTags,
  onSaveNotes,
  onSaveTitle,
  onRename,
  onPreview,
  onDownloadSingle,
  downloading,
  onDelete,
  deleting,
  onMoveFolder,
  folderOptions,
  moving,
  selected,
  onToggleSelected,
  bulkDownloading,
  theme,
}: AssetCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  const [tagList, setTagList] = useState<string[]>(item.tags);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(item.notes || "");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(item.title || "");
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(item.filename);
  const nameInputRef = React.useRef<HTMLInputElement | null>(null);

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
    if (!editingTitle) {
      setTitleValue(item.title || "");
    }
  }, [item.title, editingTitle]);

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

  const saveTitle = async () => {
    await onSaveTitle(item.id, titleValue.trim());
    setEditingTitle(false);
  };

  const cancelTitle = () => {
    setEditingTitle(false);
    setTitleValue(item.title || "");
  };

  const handleTitleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelTitle();
    }
  };

  const handleFolderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    onMoveFolder(item.id, val === "" ? null : val);
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
  const visibleTags = expanded ? item.tags : item.tags.slice(0, MAX_TAGS_COLLAPSED);
  const hiddenTagCount = item.tags.length - visibleTags.length;

  return (
    <div
      className={`rounded-lg border overflow-hidden bg-panel-soft transition-smooth hover:shadow-md ${
        selected ? "border-accent ring-1 ring-[color:var(--mv-accent)]" : "border-panel"
      }`}
    >
      {/* Preview area — click to expand/collapse, double-click for large preview */}
      <div
        className="h-32 relative cursor-pointer group"
        onDoubleClick={() => onPreview(item)}
        title="Click to toggle details, double-click for large preview"
        onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
      >
        {renderPreviewContent(item, "card", theme)}
        {/* Checkbox overlay - top-left */}
        <label
          className="absolute top-2 left-2 flex items-center gap-1.5 px-1.5 py-1 rounded-md bg-panel-overlay backdrop-blur-sm cursor-pointer text-xs select-none"
          onClick={e => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            className="w-3.5 h-3.5 accent-[color:var(--mv-accent)]"
            onClick={e => e.stopPropagation()}
          />
        </label>
        {/* Download quick-action - top-right */}
        <button
          className="absolute top-2 right-2 p-1.5 rounded-md bg-panel-overlay backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-smooth disabled:opacity-40"
          onClick={e => { e.stopPropagation(); onDownloadSingle(item); }}
          disabled={downloading || bulkDownloading}
          title="Download file"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Collapsed content: filename + tags */}
      <div className="p-2.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <button
            className="flex-1 text-left text-sm font-medium truncate cursor-text min-w-0"
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
                className="px-2 py-0.5 w-full rounded-md border border-panel-strong bg-panel-soft text-sm"
                autoFocus
              />
            ) : (
              <span className="truncate block">{item.title || item.filename}</span>
            )}
          </button>
        </div>

        {/* Tags row - always visible, compact */}
        <div className="flex flex-wrap gap-1 min-h-[20px]">
          {visibleTags.length ? (
            <>
              {visibleTags.map(t => <TagBadge key={t} tag={t} />)}
              {!expanded && hiddenTagCount > 0 && (
                <span className="text-xs text-muted px-1 py-0.5">+{hiddenTagCount}</span>
              )}
            </>
          ) : (
            <span className="text-xs text-subtle">No tags</span>
          )}
        </div>

        {/* Expandable detail panel — clean rows, no border boxes */}
        <div className={`card-details ${expanded ? "expanded" : "collapsed"}`}>
          <div className="pt-2 flex flex-col gap-3">
            {/* Custom name */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted font-medium">
                <Type className="w-3 h-3" />
                <span>Custom name</span>
              </div>
              {editingTitle ? (
                <div className="flex flex-col gap-1.5">
                  <input
                    value={titleValue}
                    onChange={e => setTitleValue(e.target.value)}
                    onKeyDown={handleTitleKey}
                    onBlur={saveTitle}
                    placeholder="Enter a custom name…"
                    className="h-7 px-2 rounded-md border border-panel-strong bg-panel-soft text-xs"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button className="text-xs px-2 py-0.5 rounded-md bg-accent" onClick={saveTitle}>Save</button>
                    <button className="text-xs px-2 py-0.5 rounded-md border border-panel-strong" onClick={cancelTitle}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className={`text-xs flex-1 truncate ${item.title ? "text-foreground font-medium" : "text-subtle italic"}`}>
                    {item.title || "No custom name (showing filename)"}
                  </span>
                  <button
                    className="text-xs px-2 py-0.5 rounded-md border border-panel-strong shrink-0"
                    onClick={() => setEditingTitle(true)}
                  >
                    {item.title ? "Edit" : "Set name"}
                  </button>
                </div>
              )}
            </div>

            {/* Tags — display + edit inline */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted font-medium">
                <Pencil className="w-3 h-3" />
                <span>Tags</span>
              </div>
              {editingTags ? (
                <div className="flex flex-col gap-1.5">
                  <TagInput
                    value={tagList}
                    onChange={setTagList}
                    placeholder="Type and press comma/Enter"
                  />
                  <div className="flex gap-2">
                    <button className="text-xs px-2 py-0.5 rounded-md bg-accent" onClick={save}>Save</button>
                    <button className="text-xs px-2 py-0.5 rounded-md border border-panel-strong" onClick={cancelEditing}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1 flex-wrap min-h-[20px]">
                  {item.tags.length > 0 ? (
                    <>
                      {item.tags.map(t => <TagBadge key={t} tag={t} />)}
                      <button
                        className="text-xs px-1.5 py-0.5 rounded-md text-muted hover:text-foreground hover:bg-panel transition-smooth shrink-0"
                        onClick={startEditing}
                        title="Edit tags"
                      >
                        <Pencil className="w-3 h-3 inline" />
                      </button>
                    </>
                  ) : (
                    <button
                      className="text-xs px-2 py-0.5 rounded-md border border-panel-strong text-muted"
                      onClick={startEditing}
                    >
                      Add tags
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Folder */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted font-medium">
                <FolderIcon className="w-3 h-3" />
                <span>Folder</span>
              </div>
              <select
                value={item.folder_id || ""}
                onChange={handleFolderChange}
                disabled={moving}
                className="h-7 px-2 rounded-md border border-panel-strong bg-panel-strong text-xs"
              >
                {folderOptions.map(opt => (
                  <option key={opt.id || "none"} value={opt.id || ""}>
                    {opt.name}
                  </option>
                ))}
              </select>
              {moving && <span className="text-xs text-muted">…</span>}
            </div>

            {/* Notes — clean row, no border box */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted font-medium">
                <span>Notes</span>
              </div>
              {editingNotes ? (
                <div className="flex flex-col gap-1.5">
                  <textarea
                    value={notesValue}
                    onChange={e => setNotesValue(e.target.value)}
                    className="w-full min-h-[60px] rounded-md border border-panel-strong bg-panel-soft p-2 text-xs"
                    placeholder="Add details about this asset"
                  />
                  <div className="flex gap-2">
                    <button className="text-xs px-2 py-0.5 rounded-md bg-accent" onClick={saveNotes}>Save</button>
                    <button className="text-xs px-2 py-0.5 rounded-md border border-panel-strong" onClick={cancelNotes}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className={`text-xs flex-1 ${noteText ? "text-foreground" : "text-subtle italic"}`}>
                    {noteText ? `${noteText.slice(0, 80)}${noteText.length > 80 ? "…" : ""}` : "No notes"}
                  </span>
                  <button
                    className="text-xs px-2 py-0.5 rounded-md border border-panel-strong shrink-0"
                    onClick={() => setEditingNotes(true)}
                  >
                    {noteText ? "Edit" : "Add notes"}
                  </button>
                </div>
              )}
            </div>

            {/* Delete — divider + right-aligned danger button */}
            <div className="border-t border-panel pt-2 flex justify-end">
              <button
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-red-300 text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-60 transition-smooth"
                onClick={() => onDelete(item)}
                disabled={deleting}
              >
                <Trash2 className="w-3 h-3" /> {deleting ? "…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
