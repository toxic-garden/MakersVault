import React from "react";
import { AppSettings, THEME_OPTIONS, ThemeId } from "../lib/settings";
import {
  UnauthorizedError,
  createFolder,
  generateMissingThumbnails,
  getAdminJob,
  getAiSettings,
  getMountImportSettings,
  rescanMount,
  testAiConnection,
  updateAiSettings,
  updateMountImportSettings,
  type AdminJobStatus,
  type AiSettings,
} from "../lib/api";
import { entriesFromFileList, uploadEntriesToFolder, type UploadEntry } from "../lib/uploadTree";
import { rememberJobId } from "./GlobalJobMonitor";

type Props = {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onAssetsChanged?: () => void;
  onFoldersChanged?: () => void;
  onUnauthorized?: () => void;
  onSelectFolder?: (id: string | null) => void;
};

type Section = "root" | "theme" | "network" | "imports" | "ai";

const THEME_SWATCHES: Record<ThemeId, string> = {
  system: "linear-gradient(135deg, #f8fafc 0%, #f8fafc 50%, #0b0f19 50%, #0b0f19 100%)",
  light: "linear-gradient(135deg, #ffffff, #e2e8f0)",
  dark: "linear-gradient(135deg, #0b0f19, #1f2937)",
  neon: "linear-gradient(135deg, #b6ff2b, #0a1508)",
  purple: "linear-gradient(135deg, #c77dff, #12091f)",
  blue: "linear-gradient(135deg, #74d4ff, #0a1324)",
};

const SCAN_EXTS = ["stl", "3mf", "step", "stp", "obj", "lbrn", "lbrn2"];
const SCAN_EXT_SET = new Set(SCAN_EXTS);
type FileSystemHandle = { kind: "file" | "directory"; name: string };
type FileSystemFileHandle = FileSystemHandle & { getFile: () => Promise<File> };
type FileSystemDirectoryHandle = FileSystemHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};
type DirectoryPicker = () => Promise<FileSystemDirectoryHandle>;

function extOf(name: string) {
  const match = /\.([^.]+)$/.exec(name || "");
  return (match?.[1] || "").toLowerCase();
}

function normalizeRelativePath(path: string) {
  return (path || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function findRootSegment(entries: UploadEntry[]) {
  if (!entries.length) return "";
  const first = normalizeRelativePath(entries[0].relativePath || entries[0].file.name);
  const parts = first.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const root = parts[0];
  if (!root) return "";
  for (const entry of entries) {
    const normalized = normalizeRelativePath(entry.relativePath || entry.file.name);
    if (!normalized.startsWith(`${root}/`)) {
      return "";
    }
  }
  return root;
}

function prepareScanEntries(entries: UploadEntry[], rootSegment: string, stripRoot: boolean) {
  const filtered: UploadEntry[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const ext = extOf(entry.file.name);
    if (!SCAN_EXT_SET.has(ext)) {
      skipped += 1;
      continue;
    }
    let relativePath = normalizeRelativePath(entry.relativePath || entry.file.name);
    if (stripRoot && rootSegment) {
      const parts = relativePath.split("/").filter(Boolean);
      if (parts[0] === rootSegment) {
        parts.shift();
        relativePath = parts.join("/");
      }
    }
    if (!relativePath) {
      relativePath = entry.file.name;
    }
    filtered.push({ ...entry, relativePath });
  }
  return { entries: filtered, skipped };
}

async function entriesFromDirectoryHandle(root: FileSystemDirectoryHandle) {
  const output: UploadEntry[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, basePath: string) => {
    for await (const [, handle] of dir.entries()) {
      if (handle.kind === "file") {
        const file = await (handle as FileSystemFileHandle).getFile();
        const relativePath = basePath ? `${basePath}/${handle.name}` : handle.name;
        output.push({ file, relativePath });
      } else if (handle.kind === "directory") {
        const nextPath = basePath ? `${basePath}/${handle.name}` : handle.name;
        await walk(handle as FileSystemDirectoryHandle, nextPath);
      }
    }
  };
  const rootPath = root.name || "";
  await walk(root, rootPath);
  return output;
}

function entryKey(entry: UploadEntry) {
  const relative = normalizeRelativePath(entry.relativePath || entry.file.name);
  return `${relative}::${entry.file.size}::${entry.file.lastModified}`;
}

export default function Settings({
  settings,
  onChange,
  onAssetsChanged,
  onFoldersChanged,
  onUnauthorized,
  onSelectFolder,
}: Props) {
  const [section, setSection] = React.useState<Section>("root");
  const [makerworldDraft, setMakerworldDraft] = React.useState(settings.makerworld.cookie);
  const [thingiverseDraft, setThingiverseDraft] = React.useState(settings.thingiverse.cookie);
  const [makerworldEditing, setMakerworldEditing] = React.useState(!settings.makerworld.cookie);
  const [thingiverseEditing, setThingiverseEditing] = React.useState(!settings.thingiverse.cookie);
  const [networkDraft, setNetworkDraft] = React.useState(settings.network.publicUrl);
  const [mountEnabled, setMountEnabled] = React.useState(false);
  const [mountCopyFiles, setMountCopyFiles] = React.useState(true);
  const [mountPath, setMountPath] = React.useState<string | null>(null);
  const [mountLoading, setMountLoading] = React.useState(false);
  const [mountSaving, setMountSaving] = React.useState(false);
  const [mountInitial, setMountInitial] = React.useState({ enabled: false, copy: true });
  const [scanRawEntries, setScanRawEntries] = React.useState<UploadEntry[]>([]);
  const [scanEntries, setScanEntries] = React.useState<UploadEntry[]>([]);
  const [scanRoot, setScanRoot] = React.useState("");
  const [scanSkipped, setScanSkipped] = React.useState(0);
  const [scanStatus, setScanStatus] = React.useState<string | null>(null);
  const [scanBusy, setScanBusy] = React.useState(false);
  const [scanStripRoot, setScanStripRoot] = React.useState(false);
  const [scanHandle, setScanHandle] = React.useState<FileSystemDirectoryHandle | null>(null);
  const [scanFolderId, setScanFolderId] = React.useState<string | null>(null);
  const folderInputRef = React.useRef<HTMLInputElement | null>(null);
  const uploadedKeysRef = React.useRef<Set<string>>(new Set());
  const [thumbBackfillBusy, setThumbBackfillBusy] = React.useState(false);
  const [thumbJob, setThumbJob] = React.useState<AdminJobStatus | null>(null);
  const [rescanBusy, setRescanBusy] = React.useState(false);
  const [rescanJob, setRescanJob] = React.useState<AdminJobStatus | null>(null);
  const [aiConfig, setAiConfig] = React.useState<AiSettings | null>(null);
  const [aiEndpointDraft, setAiEndpointDraft] = React.useState("");
  const [aiApiKeyDraft, setAiApiKeyDraft] = React.useState("");
  const [aiModelDraft, setAiModelDraft] = React.useState("");
  const [aiMaxTagsDraft, setAiMaxTagsDraft] = React.useState("10");
  const [aiSaving, setAiSaving] = React.useState(false);
  const [aiLoading, setAiLoading] = React.useState(false);
  const [aiTestStatus, setAiTestStatus] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [aiInitial, setAiInitial] = React.useState<{ endpoint: string; model: string; maxTags: string; jsonMode: boolean; reviewMode: boolean; autoTag: boolean } | null>(null);

  const recordUploadedEntries = (entries: UploadEntry[]) => {
    for (const entry of entries) {
      uploadedKeysRef.current.add(entryKey(entry));
    }
  };

  const filterNewEntries = (entries: UploadEntry[]) => {
    return entries.filter(entry => !uploadedKeysRef.current.has(entryKey(entry)));
  };

  const updateScanSelection = (
    rawEntries: UploadEntry[],
    rootLabel: string,
    stripRoot: boolean,
    resetUploaded: boolean
  ) => {
    const { entries, skipped } = prepareScanEntries(rawEntries, rootLabel, stripRoot);
    if (resetUploaded) {
      uploadedKeysRef.current = new Set();
    }
    setScanRawEntries(rawEntries);
    setScanRoot(rootLabel);
    setScanEntries(entries);
    setScanSkipped(skipped);
    return entries;
  };

  const uploadScanEntries = async (
    entries: UploadEntry[],
    note?: string,
    parentFolderId?: string | null
  ) => {
    const fresh = filterNewEntries(entries);
    if (!fresh.length) {
      setScanStatus(note || "No new files to upload.");
      return;
    }
    setScanBusy(true);
    setScanStatus("Uploading...");
    try {
      const result = await uploadEntriesToFolder(fresh, parentFolderId || null, onUnauthorized);
      if (result.uploadedEntries?.length) {
        recordUploadedEntries(result.uploadedEntries);
      } else if (result.uploaded) {
        recordUploadedEntries(fresh);
      }
      if (result.uploaded) {
        onAssetsChanged?.();
        onFoldersChanged?.();
      }
      if (result.failed.length) {
        setScanStatus(`Uploaded ${result.uploaded} file(s). Failed: ${result.failed.length}.`);
      } else {
        setScanStatus(`Uploaded ${result.uploaded} file(s).`);
      }
    } catch (err) {
      console.error("Folder scan upload failed", err);
      setScanStatus("Upload failed. Please try again.");
    } finally {
      setScanBusy(false);
    }
  };

  const ensureRootFolder = async (name: string) => {
    if (!name || scanStripRoot) {
      setScanFolderId(null);
      return null;
    }
    if (scanFolderId && scanRoot === name) return scanFolderId;
    try {
      const created = await createFolder(name, [], undefined);
      const id = (created as { id: string }).id;
      setScanFolderId(id);
      return id;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
        return null;
      }
      console.error("Root folder creation failed", err);
      setScanStatus("Failed to create the top-level folder.");
      return null;
    }
  };

  const updateTheme = (selected: ThemeId) => {
    onChange({
      ...settings,
      theme: {
        selected,
      },
    });
  };
  const updateMakerWorld = (patch: Partial<AppSettings["makerworld"]>) => {
    onChange({
      ...settings,
      makerworld: {
        ...settings.makerworld,
        ...patch,
      },
    });
  };
  const updateThingiverse = (patch: Partial<AppSettings["thingiverse"]>) => {
    onChange({
      ...settings,
      thingiverse: {
        ...settings.thingiverse,
        ...patch,
      },
    });
  };
  const saveMountSettings = async () => {
    setMountSaving(true);
    try {
      const data = await updateMountImportSettings({
        enabled: mountEnabled,
        copy_files: mountCopyFiles,
      });
      setMountEnabled(Boolean(data.enabled));
      setMountCopyFiles(Boolean(data.copy_files));
      setMountPath(data.path || null);
      setMountInitial({ enabled: Boolean(data.enabled), copy: Boolean(data.copy_files) });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
      } else {
        console.error(err);
      }
    } finally {
      setMountSaving(false);
    }
  };
  /** Poll an admin job until it finishes; onStatus receives every update.
   *  Transient poll failures (backend restart, brief proxy error) are
   *  tolerated for up to 30s — a running background job outlives them. */
  const pollAdminJob = async (jobId: string, onStatus: (s: AdminJobStatus) => void) => {
    let latest: AdminJobStatus | null = null;
    let consecutiveFailures = 0;
    for (let i = 0; i < 7200; i++) {
      let status: AdminJobStatus | null = null;
      try {
        status = await getAdminJob(jobId);
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof UnauthorizedError) throw err;
        consecutiveFailures += 1;
        if (consecutiveFailures > 30) throw err;
      }
      if (status) {
        latest = status;
        onStatus(status);
        if (status.status === "done" || status.status === "error") break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    return latest;
  };

  const runThumbnailBackfill = async () => {
    setThumbBackfillBusy(true);
    setThumbJob(null);
    try {
      const started = await generateMissingThumbnails();
      rememberJobId(started.job_id);
      const latest = await pollAdminJob(started.job_id, setThumbJob);
      // Job is done; refresh the asset grid so new thumbnails appear.
      onAssetsChanged?.();
      if (latest && latest.status === "error") {
        setThumbJob({ ...latest, message: latest.error || "Job failed" });
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
      } else {
        setThumbJob({ id: "local", status: "error", total: 0, processed: 0, generated: 0, skipped: 0, failed: 0, message: "Backfill failed to start." });
        console.error(err);
      }
    } finally {
      setThumbBackfillBusy(false);
    }
  };

  const runMountRescan = async () => {
    setRescanBusy(true);
    setRescanJob(null);
    try {
      const started = await rescanMount();
      rememberJobId(started.job_id);
      const latest = await pollAdminJob(started.job_id, setRescanJob);
      onAssetsChanged?.();
      onFoldersChanged?.();
      if (latest && latest.status === "error") {
        setRescanJob({ ...latest, message: latest.error || "Rescan failed" });
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
      } else {
        setRescanJob({ id: "local", status: "error", total: 0, processed: 0, generated: 0, skipped: 0, failed: 0, message: "Rescan failed to start." });
        console.error(err);
      }
    } finally {
      setRescanBusy(false);
    }
  };

  const updateNetwork = (patch: Partial<AppSettings["network"]>) => {
    onChange({
      ...settings,
      network: {
        ...settings.network,
        ...patch,
      },
    });
  };

  const applyAiConfig = (data: AiSettings) => {
    setAiConfig(data);
    setAiEndpointDraft(data.endpoint || "");
    setAiModelDraft(data.model || "");
    setAiMaxTagsDraft(String(data.max_tags || 10));
    setAiApiKeyDraft("");
    setAiInitial({
      endpoint: data.endpoint || "",
      model: data.model || "",
      maxTags: String(data.max_tags || 10),
      jsonMode: Boolean(data.json_mode),
      reviewMode: Boolean(data.review_mode),
      autoTag: Boolean(data.auto_tag),
    });
  };

  const saveAiSettings = async (
    overrides?: Partial<{ jsonMode: boolean; reviewMode: boolean; autoTag: boolean }>
  ) => {
    if (!aiConfig) return;
    setAiSaving(true);
    try {
      const merged = {
        endpoint: aiEndpointDraft.trim(),
        model: aiModelDraft.trim(),
        max_tags: Math.max(1, Math.min(50, parseInt(aiMaxTagsDraft, 10) || 10)),
        json_mode: overrides?.jsonMode ?? aiConfig.json_mode,
        review_mode: overrides?.reviewMode ?? aiConfig.review_mode,
        auto_tag: overrides?.autoTag ?? aiConfig.auto_tag,
        api_key: aiApiKeyDraft.trim() ? aiApiKeyDraft.trim() : null,
      };
      const data = await updateAiSettings({
        endpoint: merged.endpoint,
        api_key: merged.api_key ?? undefined,
        model: merged.model,
        max_tags: merged.max_tags,
        json_mode: merged.json_mode,
        review_mode: merged.review_mode,
        auto_tag: merged.auto_tag,
      });
      applyAiConfig(data);
      setAiTestStatus(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
      } else {
        console.error(err);
        setAiTestStatus({ ok: false, message: "Saving AI settings failed." });
      }
    } finally {
      setAiSaving(false);
    }
  };

  const runAiTest = async () => {
    setAiTestStatus({ ok: true, message: "Testing…" });
    try {
      const result = await testAiConnection();
      setAiTestStatus(
        result.ok
          ? { ok: true, message: "Connection OK." }
          : { ok: false, message: result.error || "Connection failed." }
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
        return;
      }
      setAiTestStatus({ ok: false, message: "Connection test failed." });
    }
  };

  const toggleAiFlag = async (flag: "json_mode" | "review_mode" | "auto_tag") => {
    if (!aiConfig) return;
    const next = !aiConfig[flag];
    setAiConfig({ ...aiConfig, [flag]: next });
    // saveAiSettings expects camelCase override keys (jsonMode/reviewMode/autoTag).
    const camel = flag === "json_mode" ? "jsonMode" : flag === "review_mode" ? "reviewMode" : "autoTag";
    await saveAiSettings({ [camel]: next } as Partial<{ jsonMode: boolean; reviewMode: boolean; autoTag: boolean }>);
  };

  React.useEffect(() => {
    if (section !== "imports") return;
    setMakerworldDraft(settings.makerworld.cookie || "");
    setThingiverseDraft(settings.thingiverse.cookie || "");
    setMakerworldEditing(!settings.makerworld.cookie);
    setThingiverseEditing(!settings.thingiverse.cookie);
  }, [section, settings.makerworld.cookie, settings.thingiverse.cookie]);

  React.useEffect(() => {
    if (section !== "imports") return;
    let active = true;
    setMountLoading(true);
    void (async () => {
      try {
        const data = await getMountImportSettings();
        if (!active) return;
        setMountEnabled(Boolean(data.enabled));
        setMountCopyFiles(Boolean(data.copy_files));
        setMountPath(data.path || null);
        setMountInitial({ enabled: Boolean(data.enabled), copy: Boolean(data.copy_files) });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.();
        } else {
          console.error(err);
        }
      } finally {
        if (active) setMountLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [section, onUnauthorized]);

  React.useEffect(() => {
    if (section !== "network") return;
    setNetworkDraft(settings.network.publicUrl || "");
  }, [section, settings.network.publicUrl]);

  React.useEffect(() => {
    if (section !== "ai") return;
    let active = true;
    setAiLoading(true);
    void (async () => {
      try {
        const data = await getAiSettings();
        if (!active) return;
        applyAiConfig(data);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.();
        } else {
          console.error(err);
        }
      } finally {
        if (active) setAiLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [section, onUnauthorized]);

  React.useEffect(() => {
    if (!makerworldEditing) {
      setMakerworldDraft(settings.makerworld.cookie || "");
    }
  }, [settings.makerworld.cookie, makerworldEditing]);

  React.useEffect(() => {
    if (!thingiverseEditing) {
      setThingiverseDraft(settings.thingiverse.cookie || "");
    }
  }, [settings.thingiverse.cookie, thingiverseEditing]);

  React.useEffect(() => {
    if (section !== "imports") return;
    if (!folderInputRef.current) return;
    folderInputRef.current.setAttribute("webkitdirectory", "");
    folderInputRef.current.setAttribute("directory", "");
  }, [section]);

  React.useEffect(() => {
    if (!scanRawEntries.length) {
      setScanEntries([]);
      setScanSkipped(0);
      return;
    }
    const stripRoot = Boolean(scanRoot);
    const { entries, skipped } = prepareScanEntries(scanRawEntries, scanRoot, stripRoot);
    setScanEntries(entries);
    setScanSkipped(skipped);
  }, [scanRawEntries, scanRoot]);

  if (section === "ai") {
    const aiDirty =
      Boolean(aiInitial) &&
      Boolean(aiConfig) &&
      (aiEndpointDraft.trim() !== aiInitial!.endpoint ||
        aiModelDraft.trim() !== aiInitial!.model ||
        aiMaxTagsDraft.trim() !== aiInitial!.maxTags ||
        aiApiKeyDraft.trim() !== "");
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">AI Tagging</h2>
            <p className="text-sm opacity-70">
              Automatic tags via any OpenAI-compatible vision endpoint.
            </p>
          </div>
          <button
            className="text-sm px-3 py-2 rounded-md border border-panel-strong"
            onClick={() => setSection("root")}
          >
            Back
          </button>
        </div>

        {aiLoading || !aiConfig ? (
          <div className="rounded-lg border border-panel bg-panel-soft p-4 text-sm opacity-70">
            Loading AI settings...
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-panel bg-panel-soft p-4 flex flex-col gap-3">
              <div>
                <div className="text-lg font-semibold">Endpoint</div>
                <p className="text-sm opacity-70">
                  Base URL of an OpenAI-compatible API (e.g. http://localhost:11434/v1 or
                  https://api.openai.com/v1). The path /chat/completions is appended automatically.
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-muted">API base URL</label>
                <input
                  type="text"
                  value={aiEndpointDraft}
                  onChange={e => setAiEndpointDraft(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                  className="px-3 py-2 rounded-md border border-panel-strong bg-panel-soft text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-muted">
                  API key {aiConfig.api_key_set ? "(stored — leave blank to keep)" : "(optional)"}
                </label>
                <input
                  type="password"
                  value={aiApiKeyDraft}
                  onChange={e => setAiApiKeyDraft(e.target.value)}
                  placeholder={aiConfig.api_key_set ? "••••••••" : "sk-…"}
                  className="px-3 py-2 rounded-md border border-panel-strong bg-panel-soft text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-muted">
                  Vision model (required, multimodal)
                </label>
                <input
                  type="text"
                  value={aiModelDraft}
                  onChange={e => setAiModelDraft(e.target.value)}
                  placeholder="llava, qwen2.5-vl, gpt-4o-mini, gemma3…"
                  className="px-3 py-2 rounded-md border border-panel-strong bg-panel-soft text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-muted">Max tags per file</label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={aiMaxTagsDraft}
                  onChange={e => setAiMaxTagsDraft(e.target.value)}
                  className="px-3 py-2 rounded-md border border-panel-strong bg-panel-soft text-sm w-24"
                />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
                  disabled={!aiDirty || aiSaving}
                  onClick={() => void saveAiSettings()}
                >
                  {aiSaving ? "Saving..." : "Save"}
                </button>
                <button
                  className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
                  disabled={aiSaving}
                  onClick={() => void runAiTest()}
                >
                  Test connection
                </button>
                {aiTestStatus && (
                  <span className={`text-xs font-medium ${aiTestStatus.ok ? "text-green-500" : "text-red-500"}`}>
                    {aiTestStatus.message}
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-panel bg-panel-soft p-4 flex flex-col gap-3">
              <div>
                <div className="text-lg font-semibold">Behavior</div>
                <p className="text-sm opacity-70">
                  How generated tags are handled. Toggling saves immediately.
                </p>
              </div>
              <label className="flex items-start gap-2.5 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={aiConfig.review_mode}
                  onChange={() => void toggleAiFlag("review_mode")}
                  disabled={aiSaving}
                  className="mt-0.5 w-4 h-4 accent-[color:var(--mv-accent)]"
                />
                <span>
                  <span className="font-medium">Review before applying (recommended)</span>
                  <span className="block text-xs text-muted mt-0.5">
                    Show a dialog where tags can be deselected before they are written.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={aiConfig.json_mode}
                  onChange={() => void toggleAiFlag("json_mode")}
                  disabled={aiSaving}
                  className="mt-0.5 w-4 h-4 accent-[color:var(--mv-accent)]"
                />
                <span>
                  <span className="font-medium">Structured JSON responses</span>
                  <span className="block text-xs text-muted mt-0.5">
                    Disable for endpoints that reject response_format (falls back to plain text).
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={aiConfig.auto_tag}
                  onChange={() => void toggleAiFlag("auto_tag")}
                  disabled={aiSaving}
                  className="mt-0.5 w-4 h-4 accent-[color:var(--mv-accent)]"
                />
                <span>
                  <span className="font-medium">Auto-tag new uploads</span>
                  <span className="block text-xs text-muted mt-0.5">
                    Tags are generated in the background for uploads without tags. Only fires when a
                    thumbnail exists; failures are silent.
                  </span>
                </span>
              </label>
            </div>
          </>
        )}
      </div>
    );
  }

  if (section === "theme") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Theme</h2>
            <p className="text-sm opacity-70">Choose how MakerVault looks and feels.</p>
          </div>
          <button
            className="text-sm px-3 py-2 rounded-md border border-panel-strong"
            onClick={() => setSection("root")}
          >
            Back
          </button>
        </div>

        <div className="rounded-lg border border-panel bg-panel-soft p-4 flex flex-col gap-3">
          {THEME_OPTIONS.map(option => {
            const selected = settings.theme.selected === option.id;
            return (
              <label
                key={option.id}
                className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition ${
                  selected ? "border-accent bg-accent-soft" : "border-panel-strong bg-panel-strong"
                }`}
              >
                <input
                  type="radio"
                  name="theme"
                  value={option.id}
                  checked={selected}
                  onChange={() => updateTheme(option.id)}
                  className="mt-1"
                />
                <span
                  aria-hidden="true"
                  className={`mt-0.5 h-8 w-8 shrink-0 rounded-md border ${
                    selected ? "border-accent" : "border-panel-strong"
                  }`}
                  style={{ backgroundImage: THEME_SWATCHES[option.id] }}
                />
                <div>
                  <div className="font-medium">{option.label}</div>
                  <div className="text-sm text-muted">{option.description}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>
    );
  }

  if (section === "network") {
    const trimmedUrl = (networkDraft || "").trim().replace(/\/+$/, "");
    const apiPreview = trimmedUrl
      ? (trimmedUrl.endsWith("/api") ? trimmedUrl : `${trimmedUrl}/api`)
      : "Auto (same origin)";
    const isDirty = trimmedUrl !== (settings.network.publicUrl || "");
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Reverse Proxy</h2>
            <p className="text-sm opacity-70">Point the app at your public domain.</p>
          </div>
          <button
            className="text-sm px-3 py-2 rounded-md border border-panel-strong"
            onClick={() => setSection("root")}
          >
            Back
          </button>
        </div>

        <div className="rounded-lg border border-panel bg-panel-soft p-4 flex flex-col gap-3">
          <div>
            <div className="text-lg font-semibold">Public URL</div>
            <p className="text-sm opacity-70">
              Use this when MakerVault is available at a reverse proxy domain like
              https://makersvault.local. The API will be called at /api.
            </p>
          </div>
          <p className="text-xs opacity-70">
            This setting is stored in your browser, so each device can point to a different URL if needed.
          </p>
          <div className="text-xs opacity-70 flex flex-col gap-1">
            <span>1) Configure your reverse proxy:</span>
            <span>/ → web:5173</span>
            <span>/api/* → api:8000</span>
            <span>2) Save the public URL below, then open it in your browser.</span>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-wide text-muted">
              Reverse proxy URL
            </label>
            <input
              type="text"
              value={networkDraft}
              onChange={e => setNetworkDraft(e.target.value)}
              placeholder="https://makersvault.local"
              className="px-3 py-2 rounded-md border border-panel-strong bg-panel-soft text-sm"
            />
          </div>
          <div className="text-xs opacity-70">
            API base: {apiPreview}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
              disabled={!isDirty}
              onClick={() => {
                const next = trimmedUrl;
                updateNetwork({ publicUrl: next });
                setNetworkDraft(next);
              }}
            >
              Save
            </button>
            <button
              className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
              disabled={!settings.network.publicUrl}
              onClick={() => {
                updateNetwork({ publicUrl: "" });
                setNetworkDraft("");
              }}
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (section === "imports") {
    const totalSelected = scanRawEntries.length;
    const supportedSelected = scanEntries.length;
    const newSelected = scanEntries.length ? filterNewEntries(scanEntries).length : 0;
    const mountDirty = mountEnabled !== mountInitial.enabled || mountCopyFiles !== mountInitial.copy;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Imports</h2>
            <p className="text-sm opacity-70">Manage session cookies and import local folders.</p>
          </div>
          <button
            className="text-sm px-3 py-2 rounded-md border border-panel-strong"
            onClick={() => setSection("root")}
          >
            Back
          </button>
        </div>

        <div className="rounded-lg border border-panel bg-panel-soft p-4 flex flex-col gap-3">
          <div>
            <div className="text-lg font-semibold">Mount import (server)</div>
            <p className="text-sm opacity-70">
              Index files from the server's mounted volume. Enable the no-copy option to keep
              files in place and avoid duplicates.
            </p>
          </div>
          <p className="text-xs opacity-70">
            Mount path: {mountPath || "Not configured"}
          </p>
          <p className="text-xs opacity-70">
            Changes apply on the next server restart. In no-copy mode, mounted files stay read-only and
            renaming is disabled.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mountEnabled}
              onChange={e => setMountEnabled(e.target.checked)}
              className="w-4 h-4"
              disabled={mountLoading || mountSaving}
            />
            <span>Enable mount import on startup</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mountCopyFiles}
              onChange={e => setMountCopyFiles(e.target.checked)}
              className="w-4 h-4"
              disabled={mountLoading || mountSaving}
            />
            <span>Copy files into MakerVault storage (disable to use mounted files directly)</span>
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
              disabled={!mountDirty || mountLoading || mountSaving}
              onClick={saveMountSettings}
            >
              {mountSaving ? "Saving..." : "Save"}
            </button>
            {mountLoading && <span className="text-xs opacity-70">Loading settings...</span>}
          </div>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button
              className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
              disabled={thumbBackfillBusy}
              onClick={() => void runThumbnailBackfill()}
              title="Generate thumbnails for all mounted 3D files that don't have one yet"
            >
              {thumbBackfillBusy ? "Generating…" : "Generate missing thumbnails"}
            </button>
            {thumbJob && <JobStatusView job={thumbJob} />}
          </div>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button
              className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
              disabled={rescanBusy}
              onClick={() => void runMountRescan()}
              title="Re-index the mounted library: add new files, remove assets whose source file was deleted"
            >
              {rescanBusy ? "Rescanning…" : "Rescan library"}
            </button>
            {rescanJob && <JobStatusView job={rescanJob} />}
          </div>
        </div>

        <div className="rounded-lg border border-panel bg-panel-soft p-4 flex flex-col gap-3">
          <div>
            <div className="text-lg font-semibold">Local folder scan</div>
            <p className="text-sm opacity-70">
              Select a folder from this device (USB included) and import supported files. The
              folder name becomes a top-level folder, and subfolders stay nested.
            </p>
          </div>
          <p className="text-xs opacity-70">
            Supported extensions: {SCAN_EXTS.join(", ")}. Selecting a folder uploads immediately.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={scanStripRoot}
              onChange={e => setScanStripRoot(e.target.checked)}
              className="w-4 h-4"
            />
            <span>Skip the top-level folder name</span>
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={folderInputRef}
              type="file"
              onChange={e => {
                const entries = entriesFromFileList(e.target.files || []);
                if (!entries.length) {
                  setScanRawEntries([]);
                  setScanRoot("");
                  setScanStatus(null);
                  setScanHandle(null);
                  setScanFolderId(null);
                  uploadedKeysRef.current = new Set();
                  return;
                }
                const root = findRootSegment(entries);
                setScanHandle(null);
                setScanFolderId(null);
                const stripRoot = Boolean(root);
                const prepared = updateScanSelection(entries, root, stripRoot, true);
                setScanStatus(null);
                void (async () => {
                  const parentFolderId = await ensureRootFolder(root);
                  await uploadScanEntries(prepared, undefined, parentFolderId);
                  onSelectFolder?.(parentFolderId ?? null);
                })();
                if (folderInputRef.current) folderInputRef.current.value = "";
              }}
              multiple
              className="hidden"
            />
            <button
              className="text-sm px-3 py-2 rounded-md border border-panel-strong disabled:opacity-60"
              disabled={scanBusy}
              onClick={async () => {
                const picker = typeof window !== "undefined"
                  && (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
                if (picker) {
                  try {
                    const handle = await picker();
                    const entries = await entriesFromDirectoryHandle(handle);
                    if (!entries.length) {
                      setScanRawEntries([]);
                      setScanRoot(handle.name || "");
                      setScanHandle(handle);
                      setScanFolderId(null);
                      uploadedKeysRef.current = new Set();
                      setScanStatus("No files found in that folder.");
                      return;
                    }
                    setScanHandle(handle);
                    setScanFolderId(null);
                    const rootLabel = handle.name || findRootSegment(entries);
                    const stripRoot = Boolean(rootLabel);
                    const prepared = updateScanSelection(entries, rootLabel, stripRoot, true);
                    setScanStatus(null);
                    void (async () => {
                      const parentFolderId = await ensureRootFolder(rootLabel);
                      await uploadScanEntries(prepared, undefined, parentFolderId);
                      onSelectFolder?.(parentFolderId ?? null);
                    })();
                    return;
                  } catch (err) {
                    if (err instanceof DOMException && err.name === "AbortError") {
                      return;
                    }
                    console.warn("Directory picker failed, falling back to file input", err);
                  }
                }
                if (folderInputRef.current) {
                  folderInputRef.current.setAttribute("webkitdirectory", "");
                  folderInputRef.current.setAttribute("directory", "");
                }
                folderInputRef.current?.click();
              }}
            >
              Choose folder
            </button>
            <button
              className="text-sm px-3 py-2 rounded-md bg-accent hover:bg-accent-strong disabled:opacity-60"
              disabled={scanBusy || supportedSelected === 0}
              onClick={async () => {
                if (scanHandle) {
                  const freshEntries = await entriesFromDirectoryHandle(scanHandle);
                  if (!freshEntries.length) {
                    setScanRawEntries([]);
                    setScanRoot(scanHandle.name || "");
                    setScanEntries([]);
                    setScanSkipped(0);
                    setScanStatus("No files found in that folder.");
                    uploadedKeysRef.current = new Set();
                    setScanFolderId(null);
                    return;
                  }
                  const rootLabel = scanHandle.name || findRootSegment(freshEntries) || scanRoot;
                  const stripRoot = Boolean(rootLabel);
                  const prepared = updateScanSelection(freshEntries, rootLabel, stripRoot, false);
                  const parentFolderId = await ensureRootFolder(rootLabel);
                  await uploadScanEntries(prepared, "No new files to upload.", parentFolderId);
                  onSelectFolder?.(parentFolderId ?? null);
                  return;
                }
                if (!scanEntries.length) {
                  setScanStatus("No supported files selected.");
                  return;
                }
                const parentFolderId = await ensureRootFolder(scanRoot);
                await uploadScanEntries(scanEntries, "No new files to upload.", parentFolderId);
                onSelectFolder?.(parentFolderId ?? null);
              }}
            >
              {scanBusy ? "Uploading..." : scanRawEntries.length ? "Rescan now" : "Scan now"}
            </button>
            <button
              className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
              disabled={scanBusy || totalSelected === 0}
              onClick={() => {
                setScanRawEntries([]);
                setScanRoot("");
                setScanStatus(null);
                setScanHandle(null);
                setScanFolderId(null);
                uploadedKeysRef.current = new Set();
              }}
            >
              Clear
            </button>
          </div>
          <div className="text-xs opacity-70">
            {totalSelected
              ? `Selected ${totalSelected} file(s)${
                  scanRoot ? ` from "${scanRoot}"` : ""
                }. Ready: ${supportedSelected}. New: ${newSelected}. Skipped: ${scanSkipped}.`
              : "No folder selected yet."}
          </div>
          {scanStatus && (
            <div className="text-xs font-medium">{scanStatus}</div>
          )}
        </div>

        <div className="rounded-lg border border-panel bg-panel-soft p-4 flex flex-col gap-3">
          <div>
            <div className="text-lg font-semibold">MakerWorld</div>
            <p className="text-sm opacity-70">Optional auth for importing MakerWorld models.</p>
          </div>
          <p className="text-xs opacity-70">
            Paste the Cookie header from a logged-in makerworld.com request to lift download limits.
            This value is stored only in your browser.
          </p>
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs uppercase tracking-wide text-muted">
              Session cookie
            </label>
            {makerworldEditing ? (
              <button
                className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
                onClick={() => {
                  updateMakerWorld({ cookie: makerworldDraft });
                  setMakerworldEditing(false);
                }}
              >
                Save
              </button>
            ) : (
              <button
                className="text-xs px-2 py-1 rounded-md border border-panel-strong"
                onClick={() => setMakerworldEditing(true)}
              >
                Edit
              </button>
            )}
          </div>
          <textarea
            rows={4}
            value={makerworldDraft}
            onChange={e => setMakerworldDraft(e.target.value)}
            placeholder="example: mw_session=...; mw_token=...;"
            readOnly={!makerworldEditing}
            className={`px-3 py-2 rounded-md border border-panel-strong bg-panel-soft text-sm ${
              makerworldEditing ? "" : "opacity-70"
            }`}
          />
        </div>

        <div className="rounded-lg border border-panel bg-panel-soft p-4 flex flex-col gap-3">
          <div>
            <div className="text-lg font-semibold">Thingiverse</div>
            <p className="text-sm opacity-70">Optional auth for importing Thingiverse models.</p>
          </div>
          <p className="text-xs opacity-70">
            Paste your Thingiverse Cookie header to pass Cloudflare checks when importing.
            This value is stored only in your browser.
          </p>
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs uppercase tracking-wide text-muted">
              Session cookie
            </label>
            {thingiverseEditing ? (
              <button
                className="text-xs px-2 py-1 rounded-md border border-panel-strong disabled:opacity-60"
                onClick={() => {
                  updateThingiverse({ cookie: thingiverseDraft });
                  setThingiverseEditing(false);
                }}
              >
                Save
              </button>
            ) : (
              <button
                className="text-xs px-2 py-1 rounded-md border border-panel-strong"
                onClick={() => setThingiverseEditing(true)}
              >
                Edit
              </button>
            )}
          </div>
          <textarea
            rows={4}
            value={thingiverseDraft}
            onChange={e => setThingiverseDraft(e.target.value)}
            placeholder="example: cf_clearance=...; PHPSESSID=...;"
            readOnly={!thingiverseEditing}
            className={`px-3 py-2 rounded-md border border-panel-strong bg-panel-soft text-sm ${
              thingiverseEditing ? "" : "opacity-70"
            }`}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          className="text-left rounded-lg border border-panel bg-panel-soft p-4 hover:shadow"
          onClick={() => setSection("theme")}
        >
          <div className="text-xs uppercase tracking-wide text-muted">Theme</div>
          <div className="text-lg font-semibold">Appearance</div>
          <div className="text-sm opacity-70">Switch between light, dark, and neon colors.</div>
        </button>
        <button
          className="text-left rounded-lg border border-panel bg-panel-soft p-4 hover:shadow"
          onClick={() => setSection("network")}
        >
          <div className="text-xs uppercase tracking-wide text-muted">Reverse Proxy</div>
          <div className="text-lg font-semibold">Public URL</div>
          <div className="text-sm opacity-70">Set the domain for proxied access.</div>
        </button>
        <button
          className="text-left rounded-lg border border-panel bg-panel-soft p-4 hover:shadow"
          onClick={() => setSection("imports")}
        >
          <div className="text-xs uppercase tracking-wide text-muted">Imports</div>
          <div className="text-lg font-semibold">Imports & Folder Scan</div>
          <div className="text-sm opacity-70">Manage import cookies and scan local folders.</div>
        </button>
        <button
          className="text-left rounded-lg border border-panel bg-panel-soft p-4 hover:shadow"
          onClick={() => setSection("ai")}
        >
          <div className="text-xs uppercase tracking-wide text-muted">AI Tagging</div>
          <div className="text-lg font-semibold">AI Tagging</div>
          <div className="text-sm opacity-70">Automatic tags via an OpenAI-compatible endpoint.</div>
        </button>
      </div>
    </div>
  );
}

/** Shared progress/status display for admin background jobs. */
function JobStatusView({ job }: { job: AdminJobStatus | null }) {
  if (!job) return null;
  if (job.status === "done") {
    return (
      <span className="text-xs font-medium text-muted">
        {job.message || `Done — ${job.generated} ok, ${job.failed} failed`}
      </span>
    );
  }
  if (job.status === "error") {
    return <span className="text-xs font-medium text-red-500">{job.message || "Job failed"}</span>;
  }
  const pct = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
  return (
    <div className="flex-1 min-w-[200px] flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">
        {job.message || `${job.processed}/${job.total} processed · ${job.generated} ok · ${job.failed} failed`}
      </span>
      <div className="h-1.5 w-full rounded-full bg-panel-strong overflow-hidden">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
