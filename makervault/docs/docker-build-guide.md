# Docker Build Guide

This guide walks you through building the MakerVault Docker images yourself,
from a clean checkout to a running multi-container stack. It covers both the
**dev** images (bind-mounted source, hot reload) and the **production** images
(self-contained, smaller, suitable for pushing to a registry).

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Repository layout](#repository-layout)
3. [Quick start: dev stack](#quick-start-dev-stack)
4. [Building the dev images](#building-the-dev-images)
5. [Building the production images](#building-the-production-images)
6. [Multi-arch builds](#multi-arch-builds)
7. [Pushing to a registry](#pushing-to-a-registry)
8. [Running the production stack](#running-the-production-stack)
9. [Troubleshooting](#troubleshooting)
10. [Build customization](#build-customization)

---

## Prerequisites

### Required tools

| Tool         | Minimum version | Purpose                                |
|--------------|-----------------|----------------------------------------|
| Docker       | 24.0+           | Build + run containers                 |
| Docker Compose | 2.20+ (v2 plugin) | Orchestrate multi-container stacks  |
| Git          | 2.30+           | Clone the repository                   |
| (optional) `buildx` | bundled with Docker | Multi-arch builds                  |

Check your versions:

```bash
docker --version
docker compose version
```

If `docker compose version` reports "command not found", install the v2
plugin: <https://docs.docker.com/compose/install/>

### Optional accounts

- **Docker Hub account** — required only if you want to push your custom
  images to a public/private registry.
- A `DOCKERHUB_USERNAME` environment variable in your shell.

### Free disk space

- ~1.5 GB for the dev images (Python 3.11 + Node 20 + deps)
- ~800 MB for production images (slim base + multi-stage)
- 500 MB additional for the build cache

---

## Repository layout

```
makervault/
├── api/                          # FastAPI + SQLModel backend
│   ├── Dockerfile                # api/Dockerfile (python:3.11-slim)
│   ├── docker-entrypoint.sh      # UID/GID alignment, gosu
│   ├── requirements.txt          # Pinned runtime deps
│   ├── main.py                   # FastAPI entrypoint
│   └── ...
├── web/                          # Vite + React 18 SPA
│   ├── Dockerfile                # web/Dockerfile (node:20-alpine)
│   ├── docker-entrypoint.sh      # UID/GID alignment, su-exec
│   ├── package.json
│   └── ...
├── docker-compose.yml            # DEV compose: bind-mounts + hot reload
├── docker-compose.deploy.yml     # PROD compose: prebuilt images + volumes
└── docs/
    └── docker-build-guide.md     # this file
```

> **Note**: As of the post-slicing cleanup, the `slicer-bridge/` directory is
> no longer present. The build process no longer compiles a Go helper binary.

---

## Quick start: dev stack

If you just want to run MakerVault locally without building custom images:

```bash
git clone https://github.com/<your-org>/makervault.git
cd makervault
docker compose up
```

This pulls prebuilt images from Docker Hub (`shotgunwilly555/makersvault-api:v1`,
`shotgunwilly555/makersvault-web:v1`) and starts the dev stack on:

- API:  http://localhost:8000
- Web:  http://localhost:5173

Source code is bind-mounted into the containers, so any local edit triggers
an automatic reload on the API (uvicorn `--reload`) or the web (Vite HMR).

To stop:

```bash
docker compose down
```

---

## Building the dev images

The `docker-compose.yml` file at the repo root is the **dev** compose. It
builds the images from source on first run (or when the Dockerfile changes)
and bind-mounts the working tree.

### Build and start in one go

```bash
docker compose up --build
```

The `--build` flag forces a rebuild even if the image is cached.

### Build without starting

```bash
docker compose build
```

This builds both the `api` and `web` services according to their respective
Dockerfiles. The images are tagged:

- `makervault-api` (latest local)
- `makervault-web` (latest local)

### Build a single service

```bash
docker compose build api
docker compose build web
```

### Force a fresh build (no cache)

Use this when you've changed system packages, swapped base images, or suspect
stale layers:

```bash
docker compose build --no-cache
docker compose build --no-cache api
```

### Inspect what was built

```bash
docker images | grep makervault
docker compose images
```

---

## Building the production images

The production compose (`docker-compose.deploy.yml`) is meant to consume
**prebuilt, registry-hosted images**. To produce such images, use the same
Dockerfiles but tag the resulting images explicitly and (optionally) build
them with multi-stage optimization.

### Build the API production image

The current `api/Dockerfile` is a single-stage Python image. It is suitable
for both dev and prod. To build it for production:

```bash
docker build \
  --tag myregistry.example.com/makervault-api:1.0.0 \
  --tag myregistry.example.com/makervault-api:latest \
  ./api
```

This produces an image roughly 200 MB in size (Python 3.11-slim + deps).

### Build the web production image

The current `web/Dockerfile` runs `npm run dev` (Vite dev server) which is
fine for the dev compose but **not** for production. For a production web
image you have two options:

**Option A: Multi-stage build with a small custom Dockerfile**

Create `web/Dockerfile.prod` next to `web/Dockerfile`:

```Dockerfile
# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  location / {
    try_files $uri /index.html;
  }
  # Reverse-proxy the API at /api → api container
  location /api/ {
    proxy_pass http://api:8000/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
EOF
EXPOSE 80
```

Build:

```bash
docker build -f web/Dockerfile.prod \
  --tag myregistry.example.com/makervault-web:1.0.0 \
  ./web
```

This produces an nginx-served static bundle (~30 MB).

**Option B: Single-stage with `vite preview`**

The existing `web/Dockerfile` can be repurposed for production by changing
the final `CMD` to:

```Dockerfile
CMD ["npm", "run", "build", "--", "--mode", "production"]
```

Then run it with `npx vite preview --host --port 5173`. This is fine for
single-server deployments but not for multi-container reverse-proxy setups.

### Multi-arch builds (arm64 / amd64)

If you want to run the images on both x86 (Intel/AMD servers) and arm64
(Raspberry Pi, Apple Silicon, AWS Graviton) hosts, use `docker buildx`:

```bash
docker buildx create --name makervault --use
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag myregistry.example.com/makervault-api:1.0.0 \
  --push \
  ./api
```

Repeat for the web image. The first command creates (or reuses) a builder
that supports multiple architectures; the second builds and pushes both
variants in one step.

---

## Pushing to a registry

### Log in

```bash
docker login                  # Docker Hub
docker login registry.example.com   # Private registry
```

### Tag and push

For Docker Hub (no namespace prefix):

```bash
docker push myregistry.example.com/makervault-api:1.0.0
docker push myregistry.example.com/makervault-api:latest
docker push myregistry.example.com/makervault-web:1.0.0
docker push myregistry.example.com/makervault-web:latest
```

To overwrite an existing tag, push with `--force` (rare; usually the right
move is to bump the version tag instead).

### Verify the push

```bash
docker pull myregistry.example.com/makervault-api:1.0.0
```

---

## Running the production stack

Once your images are pushed (or built locally), point `docker-compose.deploy.yml`
at them:

### Option 1: Use your own images

```bash
API_IMAGE=myregistry.example.com/makervault-api:1.0.0 \
WEB_IMAGE=myregistry.example.com/makervault-web:1.0.0 \
docker compose -f docker-compose.deploy.yml pull
docker compose -f docker-compose.deploy.yml up -d
```

### Option 2: Use the official images

```bash
docker compose -f docker-compose.deploy.yml pull
docker compose -f docker-compose.deploy.yml up -d
```

This creates two named volumes:

- `makersvault_storage` — mounted at `/app/storage` in the api container
- `makersvault_db` — mounted at `/app/data` in the api container (SQLite file)

### Required environment variables for production

Create a `.env` file in the repo root or export them in your shell:

```bash
PUID=1000                       # UID the api runs as (match your data dir owner)
PGID=1000                       # GID likewise
AUTH_USERNAME=admin             # Set both AUTH_USERNAME and AUTH_PASSWORD
AUTH_PASSWORD=change-me         # to enable JWT auth
AUTH_SECRET=$(openssl rand -hex 32)  # A long random string
AUTH_TOKEN_TTL=43200            # 12 hours, in seconds
PUBLIC_URL=https://vault.example.com
CORS_ORIGINS=https://vault.example.com
API_PORT=8000
```

The `docker-entrypoint.sh` script (`api/docker-entrypoint.sh:27-33`) honors
`CHOWN_MODE=recursive` if you want it to chown the storage/data dirs on
startup (slow for large libraries; default is `minimal`).

### Check it's running

```bash
docker compose -f docker-compose.deploy.yml ps
curl http://localhost:8000/health
# → {"ok": true, "auth_required": true}
```

### Tail logs

```bash
docker compose -f docker-compose.deploy.yml logs -f api
docker compose -f docker-compose.deploy.yml logs -f web
```

### Stop and clean up

```bash
docker compose -f docker-compose.deploy.yml down              # keep volumes
docker compose -f docker-compose.deploy.yml down --volumes     # delete volumes
```

---

## Troubleshooting

### `vite: Permission denied` when building/running web

The `web/docker-entrypoint.sh` requires execute permission on the script
and the bundled `node_modules/.bin/vite`. If you've checked out the repo on
a system with restrictive umask, run once:

```bash
chmod +x web/docker-entrypoint.sh
chmod +x web/node_modules/.bin/*
```

For a more permanent fix, add to the repo's `.gitattributes`:

```
web/docker-entrypoint.sh    text eol=lf
web/node_modules/.bin/**    -text
```

### `CORS_ORIGINS` warnings / preflight failures

The API normalizes origins to `scheme://netloc` (path stripped) in
`api/main.py:66-91`. Trailing slashes are accepted; **paths are not**.
Set `CORS_ORIGINS` to the full origin including scheme:

```bash
CORS_ORIGINS=https://vault.example.com    # ✓ correct
CORS_ORIGINS=https://vault.example.com/    # also accepted
CORS_ORIGINS=vault.example.com             # ✗ missing scheme
```

### `VITE_API_URL` returns blank page

`VITE_API_URL` is baked into the web bundle at **build time**. If you
change it you must rebuild the web image, not just restart the container:

```bash
docker compose -f docker-compose.deploy.yml build web
docker compose -f docker-compose.deploy.yml up -d web
```

`VITE_API_URL` must be **browser-reachable**, not container-internal. Use
`http://localhost:8000` or your reverse-proxy URL — **not** `http://api:8000`.

### SQLite database lost after redeploy

In dev (`docker-compose.yml`), the DB lives at `./api/app.db` on the host.
In deploy (`docker-compose.deploy.yml`), it lives in the `makersvault_db`
named volume mounted at `/app/data/app.db`. If you switch between the two
without copying the file, you'll lose data.

To migrate:

```bash
# Save current DB
cp api/app.db api/app.db.bak
# After switching to deploy
docker compose -f docker-compose.deploy.yml run --rm api sh -c 'mkdir -p /app/data && cat > /app/data/app.db' < api/app.db
```

### Mount import scan slow on first start

The mount-import scan (`api/mount_import.py`) runs once at startup and walks
the entire configured directory tree. On large libraries (100k+ files) this
takes minutes. The scan is **not** repeated automatically; restart the
container to force a rescan.

### Image size bloat

If your images are much larger than expected:

```bash
docker history myregistry.example.com/makervault-api:1.0.0
```

Common culprits:

- `apt-get update` without `&& rm -rf /var/lib/apt/lists/*`
- `pip install` without `--no-cache-dir`
- Copying `node_modules` instead of running `npm ci`

The shipped Dockerfiles already handle these correctly.

---

## Build customization

### Custom UID/GID

Both entrypoints honor `PUID` / `PGID` (default `1000`). They align the
runtime `appuser`/`appgroup` to those values and chown the data directories.

For a non-default user (e.g. `PUID=33` for `www-data`):

```bash
PUID=33 PGID=33 docker compose up --build
```

### Custom DB location

By default the API uses `sqlite:///./app.db` (relative to the working
directory, which is `/app` in the container). To use a different DB
backend, set `DB_URL`:

```bash
# Postgres
DB_URL=postgresql+psycopg2://user:pass@db-host/makersvault

# MySQL
DB_URL=mysql+pymysql://user:pass@db-host/makersvault

# SQLite at a custom path
DB_URL=sqlite:////data/makervault.db
```

> Postgres/MySQL require installing the driver and (for some setups)
> switching off the `ensure_*` migrations. See `api/db.py:14-41`.

### Custom auth secret

```bash
AUTH_SECRET=$(openssl rand -hex 32) docker compose -f docker-compose.deploy.yml up -d
```

Restarting with a new `AUTH_SECRET` invalidates all existing tokens.

### Custom allowed hosts

Vite's dev server defaults to `allowedHosts: true` for reverse-proxy
friendliness. To lock down:

```bash
VITE_ALLOWED_HOSTS=vault.example.com,localhost docker compose -f docker-compose.deploy.yml build web
```

---

## Reference

### Useful commands cheat-sheet

```bash
# Build everything fresh
docker compose build --no-cache

# Tail logs
docker compose logs -f

# Open a shell in the api container
docker compose exec api sh

# Inspect the SQLite DB
docker compose exec api sqlite3 /app/data/app.db

# Backup volumes
docker run --rm \
  -v makervault_storage:/src:ro \
  -v $(pwd):/dst \
  alpine tar czf /dst/storage-backup.tar.gz -C /src .

# Restore
docker run --rm \
  -v makervault_storage:/dst \
  -v $(pwd):/src:ro \
  alpine tar xzf /src/storage-backup.tar.gz -C /dst

# Wipe everything (DESTRUCTIVE)
docker compose -f docker-compose.deploy.yml down --volumes --rmi all
```

### File locations inside the containers

| Path inside container   | What's there                          |
|-------------------------|---------------------------------------|
| `/app/`                 | API source (mounted in dev)           |
| `/app/storage/`         | Uploaded files + thumbs               |
| `/app/data/app.db`      | SQLite database (prod)                |
| `./app.db`              | SQLite database (dev)                 |
| `/usr/local/bin/docker-entrypoint.sh` | Entry script (api + web) |

### Environment variables quick reference

See the [API env section](../AGENTS.md#environment-variables-read-at-startup)
in AGENTS.md for the full list. The most important ones for a build:

- `VITE_API_URL` (web only, build-time)
- `AUTH_SECRET` (api, runtime)
- `PUID`/`PGID` (both, runtime)
- `CORS_ORIGINS` (api, runtime)

---

## See also

- [`AGENTS.md`](../AGENTS.md) — project conventions and architecture overview
- [`.roo/rules-architect/AGENTS.md`](../.roo/rules-architect/AGENTS.md) —
  architectural rationale for storage, auth, and import pipeline
- [`.roo/rules-debug/AGENTS.md`](../.roo/rules-debug/AGENTS.md) — common
  failure modes and how to diagnose them
