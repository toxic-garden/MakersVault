# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — 2026-09-11

This release bundles the feature work from September 2026. It extends assets
with AI tagging and richer metadata, adds server-side indexing for an existing
STL/3MF library, and polishes the sidebar UI.

### Added

- **AI tagging** — automatic tag generation via any OpenAI-compatible vision
  endpoint (`api/ai_tagging.py`).
  - New endpoints: `GET/POST /ai/settings`, `POST /ai/test` (real chat call,
    verifies endpoint *and* model), `POST /ai/tag/{asset_id}` (single) and
    `POST /ai/tag` (batch).
  - Thumbnails are sent as base64 data URLs together with filename-keyword
    context; temperature 0.3, optional `response_format: json_object` (can be
    disabled for endpoints that reject it, falls back to plain-text parsing).
  - Tag hygiene: lowercasing, punctuation stripping, generic-term blacklist
    ("model", "3d", "object", …), substring dedupe ("dragon" beats
    "dragon model"), max-tags cap (1–50).
  - Structured error messages for timeouts, unreachable endpoints, 401/403,
    429 and HTTP 4xx/5xx from the provider.
  - Settings UI section "AI Tagging" (base URL, API key, vision model, max
    tags, connection test) and a review modal: suggested tags can be deselected
    per asset before they are merged (configurable — review off = direct apply).
  - Optional auto-tagging of new uploads without tags (background thread,
    silent failures, only fires when a thumbnail exists).
  - Runtime dependency: `httpx==0.27.2`.

- **Object Source** — new `Asset.source_url` field to document where a file
  came from (Printables, MakerWorld, …).
  - Forward-only migration (`ensure_asset_source_url_column`), returned in
    `AssetOut`, settable/clearable via `POST /asset/{id}/meta`.
  - Editable inline in the asset card; stored URL renders as an external link.

- **3MF metadata extraction** (`api/three_mf.py`, stdlib `zipfile`, no new
  dependency).
  - Extracts `Title` → title, `Description` + `Designer`/`License` → notes
    (handles repeatedly HTML-escaped values, strips tags) and the slicer's
    embedded plate thumbnail (via `Thumbnail_Middle` metadata, with sensible
    fallbacks) from BambuStudio/OrcaSlicer packages.
  - Runs on upload, URL import and mount import. Only fills empty
    title/notes so manually entered values win; the embedded plate image
    replaces the server-side 3D render at upload time.
  - `POST /admin/backfill-3mf-metadata` fills metadata for existing untagged
    `.3mf` assets (single asset via `?asset_id=` or the whole library), plus a
    "Fill 3MF metadata" button in the selection toolbar.

- **Library indexing (mount import)** via Docker deploy.
  - `docker-compose.deploy.yml` now passes `IMPORT_MOUNT_PATH`,
    `IMPORT_MOUNT_ON_STARTUP`, `IMPORT_MOUNT_COPY`, `IMPORT_MOUNT_EXTS` and
    `IMPORT_MOUNT_INCLUDE_HIDDEN` to the API container and bind-mounts the
    host library read-only to `/library`.
  - `.env`-driven: `IMPORT_MOUNT_PATH` is the path inside the container,
    `MOUNT_IMPORT_SOURCE` the host folder; `IMPORT_MOUNT_COPY=false` indexes
    files in place without duplication. Documented in the README.

- **Thumbnail tooling.**
  - `POST /admin/generate-missing-thumbnails` renders thumbnails for every
    STL/OBJ/3MF asset without one (e.g. mount-imported files).
  - Runs as a background job (`api/job_tracker.py`, in-memory registry) with
    `GET /admin/jobs/{job_id}` progress reporting; the UI shows a live
    progress bar (`X/Y processed`) instead of blocking.
  - Per-asset regeneration: `POST /asset/{id}/thumbnail/regenerate`
    (embedded 3MF plate image preferred, otherwise a fresh render), exposed as
    a "Regenerate thumbnail" button in the card details — shown only for
    thumbnail-eligible file types (`thumb_eligible` flag on `AssetOut`).

- **Mount rescan** — `POST /admin/rescan-mount` re-indexes the mounted library
  without a container restart: adds new files and prunes mount-imported assets
  whose source file was deleted, then removes empty mount folders (deepest
  first, user-created folders untouched). Triggered from Settings → Imports via
  the "Rescan library" button with progress display.

### Changed

- **Sidebar**: folders start **collapsed** by default (previously all root
  folders were auto-expanded on every render). The selected folder's path and
  the parent of a newly created folder still expand automatically.
- **Scrollbars** are slim and theme-aware (8px, transparent track, rounded
  thumb in theme colors); the sidebar tree uses an extra-slim 6px variant
  whose thumb only appears while hovered.
- Settings → Imports gained the "Generate missing thumbnails" and
  "Rescan library" actions.

### Fixed

- Sidebar content overflowing the viewport no longer stretches the document
  and clips the right panel on long folder lists; the aside is now
  `h-screen sticky` with its own scroll window for the folder tree.
- Single-asset thumbnail regeneration passed the full filename instead of the
  suffix to the eligibility check, which would have rejected every type.

### Housekeeping

- `makervault/api/app.db` and `makervault/web/dist/` are no longer tracked and
  are ignored going forward (runtime DB and build output).
- Test suite runs against a temp DB/storage (pytest_configure sets
  `DB_URL`/`FILE_STORAGE`) with per-test truncation — it no longer trips over
  the root-owned leftover `api/storage` Docker volume.