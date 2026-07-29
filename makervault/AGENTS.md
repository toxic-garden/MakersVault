# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Repository layout (2 codebases, no monorepo tooling)

- `api/` — FastAPI + SQLModel (SQLite) backend. No `pyproject.toml`; deps pinned in `api/requirements.txt`. Mounted at container `/app`; app object is `main:app`.
- `web/` — Vite + React 18 + TypeScript SPA. Tailwind via PostCSS. Entry `web/src/main.tsx`; UI in `web/src/ui/`, libs in `web/src/lib/`.
- `slicer-bridge/` — Standalone Go binary (custom `makersvault-slicer://` / `makersvault-engrave://` protocol handler). Built per-OS; not part of the Docker stack.
- `docker-compose.yml` = dev (bind-mount + hot reload). `docker-compose.deploy.yml` = prebuilt images + named volumes (`makersvault_storage`, `makersvault_db`).

## Commands

Dev stack (from `makervault/`): `docker compose up --build`.
API only (host Python 3.11): `cd api && pip install -r requirements-dev.txt && uvicorn main:app --port 8000`.
Web only (host Node 20): `cd web && npm ci && npm run dev` (Vite on `:5173`).

Tests (both suites exist and run):
- API: `cd api && pytest` (single file: `pytest tests/test_routes.py`; single test: `pytest tests/test_routes.py::TestAuthRequired::test_login_with_correct_credentials_returns_token`). Config in `api/pytest.ini`; `asyncio_mode = auto`.
- Web: `cd web && npm test` (single file: `npx vitest run src/lib/api.test.ts`; watch: `npm run test:watch`). jsdom env, setup at `web/src/test/setup.ts`.

No linter or formatter is configured — match existing indentation in each file.

## Code style

- Python `api/`: **2-space indent** (not 4). snake_case modules. Pydantic I/O models in `schemas.py`, SQLModel tables in `models.py`. FastAPI deps are module-level singletons (`auth_scheme = HTTPBearer(auto_error=False)` in `auth.py:15`).
- TS/React `web/`: `import type` for type-only imports. Components are default-exported PascalCase files. CSS vars `--mv-*` per theme in `src/index.css`; Three.js reads them via `getComputedStyle` (`ModelViewer.tsx:18-22`).

## Auth model (non-obvious)

- JWT HS256. `AUTH_ENABLED` is true **iff both** `AUTH_USERNAME` and `AUTH_PASSWORD` are set (`auth.py:14`).
- Tokens accepted as `Authorization: Bearer` **or** `?token=<jwt>` query string. The query path is required for `<img>`/`<a>` tags the browser fetches without custom headers — see `auth.py:24-37` and `appendTokenToUrl` in `web/src/lib/auth.ts:37-48`.
- Web auto-refreshes token at `min(ttl*0.8, ttl-5min)` with 5-min floor (`App.tsx:106-124`).

## CORS & API base resolution

- `main.py:97-109` resolves allowed origins: `CORS_ORIGINS` → `PUBLIC_URL` → `VITE_API_URL` → `http://localhost:5173`. Each normalized to `scheme://netloc` (path stripped, trailing slash ok).
- `resolveApiBase` in `web/src/lib/api.ts:115-147` picks API URL: saved `network.publicUrl` in localStorage → `VITE_API_URL` → same-origin `/api` (on 80/443) → `http://<host>:8000` fallback.

## File storage & DB

- Assets live under `$FILE_STORAGE/<asset-id>/`. Thumbs: `$FILE_STORAGE/thumbs/<asset-id>.jpg` (512×512 JPEG q88).
- Tags stored as JSON array string in `tags_json` (no separate table). UUID string PKs.
- Migrations are forward-only `PRAGMA table_info` checks in `db.py:14-41` (`ensure_folder_parent_column`, `ensure_asset_source_path_column`, `ensure_asset_indexes`). No Alembic — don't introduce it without migrating the whole lifecycle.
- Asset `size` is 0 on insert, updated by `finalize_asset_record` after streaming completes (`asset_service.py:64-75`) — intentional.
- Dev DB: `./app.db` (relative). Deploy DB: `/app/data/app.db` (named volume). Don't mix paths or data is lost on redeploy.

## Import pipeline gotchas

- URL import (`import_service.py`) fetches HTML for MakerWorld/Thingiverse/Printables with browser-like headers (`import_resolvers.py`), recursively resolves download URL (max depth 3).
- `url_utils.validate_remote_url` **blocks** private/loopback/link-local/multicast IPs and `localhost`/`.local` — tests against `https://127.0.0.1` fail by design (SSRF guard).
- `IMPORT_ALLOWED_EXTS` / `IMPORT_BLOCKED_EXTS` in `config.py:19-42` are the only accepted extensions on import. Browser mirrors via `MODEL_EXTS`/`LIGHTBURN_EXTS` in `AssetGrid.tsx:32-33`.
- ZIP extraction: `normalize_zip_entry_path` rejects `..` and absolute paths (`zip_service.py:18-26`); auto-creates folder hierarchy mirroring the zip.
- Mount import (`mount_import.py`) scans in a background thread at startup; dedupes by `source_path`; never deletes DB rows when source files disappear. `IMPORT_MOUNT_EXTS="*"` = accept all; falsy falls back to `DEFAULT_MOUNT_IMPORT_EXTS`.
- `stream_response_to_file` reads 1 MiB chunks and enforces `IMPORT_MAX_BYTES` mid-stream — set `IMPORT_MAX_MB` env var, not the constant.

## Common gotchas

- `VITE_API_URL` must be **browser-reachable**. `http://api:8000` fails (Docker-internal hostname). Use `http://localhost:8000` or reverse-proxy URL.
- `AUTH_SECRET` defaults to `changeme-secret`; changing it doesn't invalidate old tokens until they expire (12 h default). Restart API to invalidate all sessions.
- Web stores auth token + all prefs in `localStorage` under `makersvault_auth_token` and `makersvault_settings`. Clearing site data logs out.
- Theme applied by toggling `dark`/`theme-neon`/`theme-purple`/`theme-blue` classes on `<html>` (`App.tsx:41-53`); CSS vars drive both UI and Three.js viewer.
- Vite `allowedHosts` defaults to `true` (permissive for reverse-proxy); set `VITE_ALLOWED_HOSTS` to lock down.
