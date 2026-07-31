> **Note:** This repository is a fork of the original [MakersVault](https://github.com/GhostLabs-ent/MakersVault) project. It retains the original goal — a self-hosted home for 3D print files and creative assets — and adds a number of enhancements around deployment, reliability, and day-to-day use.

# Makers Vault (Revived Fork)

Makers Vault is a self-hosted web application for organizing, tagging, and previewing 3D print and laser engraver files directly in your browser. Create folders, drag-and-drop uploads, preview STL/STEP/OBJ/3MF/SVG models and images, and manage everything through a clean web UI.

This fork focuses on:

- **Reliable Docker deployments** with prebuilt images and a production-ready compose file.
- **Reverse-proxy-friendly networking** via `PUBLIC_URL` and `/api` routing.
- **Smoother authentication UX**, including fixes for repeated session-expired dialogs and stale-token handling.
- **Continued maintenance** of the FastAPI + React stack.
- **performance improvements** by shifting the rendering to the backend
- **UI overhaul** for a cleaner and more streamlined look

## Quick start with Docker Compose (local)

The fastest way to run the app locally is with the production-oriented compose files in [`makervault/`](makervault/):

- [`docker-compose.deploy.yml`](makervault/docker-compose.deploy.yml) — base stack (API is internal-only).
- [`docker-compose.deploy.local.yml`](makervault/docker-compose.deploy.local.yml) — override that publishes the API port on the host for direct/LAN use.

### 1. Clone the repository

```bash
git clone <repository-url>
cd MakersVault
```

### 2. Create an `.env` file

Create a file named `.env` in the repository root (next to `docker-compose.deploy.yml`):

```env
PUID=1000
PGID=1000
AUTH_USERNAME=admin
AUTH_PASSWORD=super-secret
AUTH_SECRET=replace-with-a-random-secret
AUTH_TOKEN_TTL=86400
PUBLIC_URL=
CORS_ORIGINS=http://localhost:8080
VITE_API_URL=http://localhost:8000
VITE_ALLOWED_HOSTS=
WEB_PORT=8080
API_PORT=8000
```

> Change `AUTH_USERNAME`, `AUTH_PASSWORD`, and `AUTH_SECRET` before exposing the app to a network.

### 3. Start the stack

**if you do NOT have a reverse proxy like nginx or HAproxy):**

```bash
docker compose \
  -f makervault/docker-compose.deploy.yml \
  -f makervault/docker-compose.deploy.local.yml \
  up -d
```

**if you DO have a reverse proxy:**

```bash
docker compose -f makervault/docker-compose.deploy.yml up -d
```

### 4. Open the app

Browse to:

```
http://localhost:8080
```
 (or the port and domain you configured manually via `.env` file)

Log in with the credentials from your `.env` file.

### Direct/LAN mode vs reverse-proxy mode

The same base compose file works for both setups by adding or omitting the local override:

| Mode | Compose files | `PUBLIC_URL` | `VITE_API_URL` | `CORS_ORIGINS` | API port |
|------|---------------|--------------|----------------|----------------|----------|
| Direct/LAN | `docker-compose.deploy.yml` + `docker-compose.deploy.local.yml` | empty | `http://localhost:8000` | `http://localhost:8080` | host-mapped via `API_PORT` |
| Reverse proxy | `deploy.yml` only | `https://mv.example.com` | empty | your public origin(s) | internal only (`expose`) |


### 5. Stopping the stack

```bash
docker compose -f makervault/docker-compose.deploy.yml down
```

To remove persistent volumes as well, add `-v`:

```bash
docker compose -f makervault/docker-compose.deploy.yml down -v
```

If you used the local override, include it when stopping too:

```bash
docker compose \
  -f makervault/docker-compose.deploy.yml \
  -f makervault/docker-compose.deploy.local.yml \
  down -v
```

## What's different from upstream?

| Area | Change |
|------|--------|
| Images | Prebuilt images published to `ghcr.io/toxic-garden/makersvaultrevived-api` and `ghcr.io/toxic-garden/makersvaultrevived-web`. |
| Compose | `makervault/docker-compose.deploy.yml` is tuned for local or server deployment with volumes and health-preserving defaults. |
| Auth UX | Fixed repeated "Your session has expired" alerts caused by concurrent 401 responses and stale tokens. |
| removed unused functions | the slicer bridge was removed, as it does not make sense in my opinion 
| Theme cleanup | the themes and the overall UI are now more streamlined 
| Performance improvements | Thumbnails are now generated on the backend after upload/import, so no heavy CPU usage on the client when browsing the library
| several bugfixes | like the max upload size, Session timeout notifications, multiple folder creations when uploading ZIP files and some more


For development (hot-reload builds), use [`makervault/docker-compose.yml`](makervault/docker-compose.yml) instead.

## Tech Stack

- **Frontend:** React 18 + TypeScript, Vite, Tailwind CSS, three.js, occt-import-js.
- **Backend:** FastAPI (Python), SQLModel, SQLite.
- **Deployment:** Docker + Docker Compose.

## License

This fork inherits the license of the original MakersVault project. See [`LICENSE`](LICENSE) for details.
