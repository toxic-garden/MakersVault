# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Repository layout (2 separate codebases, no monorepo tooling)

- `api/` — FastAPI + SQLModel (SQLite) backend, mounted under `/` from container `/app`. No `pyproject.toml`/`pytest`; deps are pinned in `api/requirements.txt`.
- `web/` — Vite + React 18 + TypeScript SPA. Tailwind via PostCSS. Entry `web/src/main.tsx`; UI lives under `web/src/ui/`, libs under `web/src/lib/`.
- Docker compose (`docker-compose.yml`) runs `api` + `web` in dev (volumes + hot reload). `docker-compose.deploy.yml` uses prebuilt images and named volumes (`makersvault_storage`, `makersvault_db`).

## Commands

Dev (from repo root): `docker compose up --build` (or `docker-compose up --build`).
API only (host Python): `cd api && pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000`. Single endpoint smoke test: `curl http://localhost:8000/health`.
Web only (host Node 20): `cd web && npm ci && npm run dev` (Vite on `:5173`). Build: `npm run build`. Preview: `npm run preview`.

There is **no test suite, no linter, no formatter** configured. Do not invent `npm test`, `pytest`, or `go test` commands.

## Environment variables (read at startup)

- API: `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET`, `AUTH_TOKEN_TTL` (seconds, default 43200 = 12 h), `FILE_STORAGE` (default `./storage`), `DB_URL` (SQLAlchemy URL, default `sqlite:///./app.db`), `IMPORT_MOUNT_PATH`/`MOUNT_IMPORT_PATH`, `IMPORT_MOUNT_EXTS` (`*` for all, otherwise comma/space-separated), `IMPORT_MOUNT_INCLUDE_HIDDEN`, `IMPORT_MOUNT_ON_STARTUP`, `IMPORT_MOUNT_COPY`, `IMPORT_MAX_MB` (default 512), `IMPORT_TIMEOUT_SECONDS` (default 30), `IMPORT_HTML_MAX_KB` (default 4096), `MAKERWORLD_COOKIE`, `THINGIVERSE_COOKIE`, `CORS_ORIGINS`, `PUBLIC_URL`.
- Web: `VITE_API_URL` (browser-reachable URL — **must be reachable from the browser, not from the container**, see comment in `docker-compose.yml:21`), `VITE_ALLOWED_HOSTS`, `CORS_ORIGINS`, `PUID`, `PGID`.
- Docker entrypoints also honor `PUID`/`PGID`/`CHOWN_MODE` (`minimal` default, `recursive` opt-in to chown `storage` and `data`).

## Auth model

- JWT (HS256) bearer token. `AUTH_ENABLED` is true iff both `AUTH_USERNAME` and `AUTH_PASSWORD` are set (`api/auth.py:9-14`).
- Tokens can be passed as `Authorization: Bearer <token>` **or** as a `?token=<jwt>` query string. The query-string path is required for `<img>`/`<a>` tags the browser fetches without custom headers — see `api/auth.py:24-37` and `web/src/lib/auth.ts:37-48` (`appendTokenToUrl`).
- The web app auto-refreshes the token at `min(ttl*0.8, ttl-5min)` with a 5-minute floor (`web/src/ui/App.tsx:106-124`).

## CORS

- `api/main.py:79-91` resolves allowed origins in this order: `CORS_ORIGINS` → `PUBLIC_URL` → `VITE_API_URL` → `http://localhost:5173`. Each is normalized to `scheme://netloc` (path stripped). Trailing slashes matter — don't include them.
- Vite `allowedHosts` defaults to `true` (permissive for reverse-proxy use); set `VITE_ALLOWED_HOSTS` to lock down (`web/vite.config.js:13-40`).

## API base resolution in the browser

`web/src/lib/api.ts:115-147` (`resolveApiBase`) picks the API URL in this order: user-saved `network.publicUrl` in localStorage → `import.meta.env.VITE_API_URL` (absolute wins, port-only used when not behind reverse proxy on 80/443) → same-origin `/api` when behind a proxy on 80/443 → `http://<host>:8000` fallback. The "Reset saved proxy URL" button in the API-down banner clears the override.

## File storage layout

- All assets live under `$FILE_STORAGE/<asset-id>/`. Thumbs are flat files under `$FILE_STORAGE/thumbs/<asset-id>.jpg` (512×512, JPEG q88) — see `api/asset_service.py:26-35`.
- DB schema (`api/models.py`): UUID string PKs (uuid4) for `Asset`, `Folder`, plus `AppConfig` for key/value runtime settings. Tags are stored as a JSON array string in `tags_json` (no separate table).
- Migrations are run inline at startup via `ensure_folder_parent_column`, `ensure_asset_source_path_column`, `ensure_asset_indexes` in `api/db.py:14-41` — they use `PRAGMA table_info` and are forward-only (no rollback). Don't replace them with Alembic unless you migrate the whole DB lifecycle.
- Asset size is set to 0 on insert and updated via `finalize_asset_record` after streaming completes (`api/asset_service.py:64-75`). This is intentional — the size is not known until the download finishes.

## Asset import pipeline

- `api/main.py` routes split into upload (multipart `UploadFile`) and import (URL) flows. URL import goes through `api/import_service.py:open_import_response` which fetches HTML for known sites (MakerWorld, Thingiverse, Printables) using browser-like headers from `api/import_resolvers.py` and recursively resolves the real download URL (max depth 3).
- `api/url_utils.py:validate_remote_url` **blocks** local/private/loopback/link-local/multicast/unspecified IPs and `localhost`/`.local` hostnames (SSRF guard) — tests against `https://127.0.0.1` will fail by design.
- `IMPORT_ALLOWED_EXTS` and `IMPORT_BLOCKED_EXTS` in `api/config.py:19-42` are the only extensions accepted on import. The browser mirrors these via `MODEL_EXTS`/`LIGHTBURN_EXTS` constants in `web/src/ui/AssetGrid.tsx:32-33` for preview rendering (3D model viewer, LightBurn preview).
- ZIP extraction deduplicates entries, normalizes paths (`normalize_zip_entry_path` rejects `..` segments and absolute paths in `api/zip_service.py:18-26`), and auto-creates a folder hierarchy that mirrors the zip via `resolve_zip_folder_id`.

## Mount import (server-side folder watch)

- When `IMPORT_MOUNT_PATH` is set, `api/mount_import.py:scan_mount_imports` walks the tree in a background thread started from the FastAPI startup hook (`api/main.py:106-113`).
- Files are deduplicated by `source_path` (the resolved absolute path stored in `asset.source_path`). On `IMPORT_MOUNT_COPY=true` (default) files are copied into storage; otherwise the API streams the original via `resolve_asset_file` (`api/main.py:129-137`) — deleting the original breaks downloads.
- `IMPORT_MOUNT_EXTS="*"` means accept everything (returns `None` and skips the extension check). Anything falsy falls back to `DEFAULT_MOUNT_IMPORT_EXTS` in `api/config.py:60-75`.
- Hidden files (starting with `.`) are skipped unless `IMPORT_MOUNT_INCLUDE_HIDDEN=true`.

## Code style

- Python: 2-space indent throughout `api/` (see `api/main.py`, `api/auth.py`, `api/db.py`). snake_case modules. Pydantic models in `api/schemas.py`, SQLModel table models in `api/models.py`. FastAPI dependencies are module-level singletons (e.g. `auth_scheme = HTTPBearer(auto_error=False)` in `api/auth.py:15`).
- TypeScript/React: `type` imports with `import type` where applicable (`web/src/ui/App.tsx:7-9`). Components default-exported PascalCase files in `web/src/ui/`. CSS variables `--mv-*` defined in `web/src/index.css` per theme — consumed via `getComputedStyle(document.documentElement)` in 3D code (see `web/src/ui/ModelViewer.tsx:18-22`).
- No formatter or linter runs in CI; match the existing indentation in whatever file you touch.

## Common gotchas

- `VITE_API_URL` must be **browser-reachable**. If you set it to `http://api:8000` the browser will fail because `api` doesn't resolve from outside the compose network. Use `http://localhost:8000` (port-forwarded) or your reverse-proxy URL.
- `AUTH_SECRET` defaults to `changeme-secret` — tokens issued before changing it remain valid until they expire (12 h default). Restart the API to invalidate all sessions immediately.
- Mount-import scan is forward-only: it never deletes assets from the DB even if the source file disappears. Use the UI to delete assets manually.
- `api/asset_service.py:stream_response_to_file` reads 1 MiB chunks and enforces `IMPORT_MAX_BYTES` mid-stream — set the env var, not the constant.
- `db_url` for sqlite in dev uses `./app.db` (relative path); in `docker-compose.deploy.yml` it uses `/app/data/app.db` on a named volume. Don't mix the two paths or you'll lose data on redeploy.
- The web app stores the auth token and all user preferences (theme, network.publicUrl, cookies) in `localStorage` under keys `makersvault_auth_token` and `makersvault_settings` — clearing site data logs the user out.
- Theme is applied by toggling `dark`/`theme-neon`/`theme-purple`/`theme-blue` classes on `<html>` (`web/src/ui/App.tsx:41-53`); CSS variables in `index.css` drive both UI and the Three.js model viewer.
