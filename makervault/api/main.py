from fastapi import BackgroundTasks, Depends, FastAPI, UploadFile, File, Form, HTTPException, Query, Response
from fastapi.responses import FileResponse
from starlette.middleware.cors import CORSMiddleware
from sqlmodel import SQLModel, Session, select
from typing import List, Optional
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, BadZipFile
import tempfile
import threading
from typing import Annotated, List, Optional
from urllib.parse import quote, urlparse
import json
import os
import jwt
from jwt import PyJWTError
from fastapi import Depends

from auth import (
    AUTH_ENABLED,
    AUTH_PASSWORD,
    AUTH_USERNAME,
    AUTH_TOKEN_TTL,
    AUTH_SECRET,
    AUTH_ALGO,
    create_token,
    require_auth,
)
from asset_service import asset_path, cleanup_asset, finalize_asset_record, save_thumb, stream_response_to_file
from config import IMPORT_MAX_BYTES, MOUNT_IMPORT_ENABLED, MOUNT_IMPORT_PATH, MOUNT_IMPORT_COPY
from db import STORAGE, THUMBS, engine, ensure_folder_parent_column, ensure_asset_source_path_column, ensure_asset_indexes
from file_utils import build_import_filename, mime_from_content_type, sanitize_filename
from folder_service import validate_parent_folder
from import_service import download_import_to_temp, import_asset_from_url, open_import_response
from mount_import import scan_mount_imports
from models import Asset, Folder
from settings_service import (
    get_mount_import_copy,
    get_mount_import_enabled,
    set_mount_import_copy,
    set_mount_import_enabled,
)
from schemas import (
    AssetOut,
    FolderIn,
    FolderOut,
    LoginRequest,
    LoginResponse,
    DownloadRequest,
    TagUpdate,
    AssetMetaUpdate,
    AssetRename,
    AssetFolderUpdate,
    ImportRequest,
    ImportInspectOut,
    ImportZipEntriesRequest,
    ImportZipEntriesOut,
    ImportZipExtractRequest,
    ImportZipResult,
    MountImportSettings,
    MountImportSettingsOut,
)
from zip_service import extract_zip_entries_to_assets, list_zip_entries
from url_utils import normalize_import_url

app = FastAPI(title="MakerVault API")

# Module-level dependency singletons
AuthDep = Annotated[Optional[str], Depends(require_auth)]
_IMAGE_THUMB_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def build_mount_import_response() -> MountImportSettingsOut:
    return MountImportSettingsOut(
        enabled=get_mount_import_enabled(MOUNT_IMPORT_ENABLED),
        copy_files=get_mount_import_copy(MOUNT_IMPORT_COPY),
        path=MOUNT_IMPORT_PATH or None,
    )


def is_thumb_eligible(mime: Optional[str], suffix: str) -> bool:
    return bool(mime and mime.startswith("image/") and suffix.lower() in _IMAGE_THUMB_EXTS)


def normalize_origin(raw: str) -> Optional[str]:
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        parsed = urlparse(raw)
    except Exception:
        return None
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def resolve_cors_origins() -> str:
    raw = os.getenv("CORS_ORIGINS")
    if raw:
        return raw
    candidates: List[str] = []
    for name in ("PUBLIC_URL", "VITE_API_URL"):
        origin = normalize_origin(os.getenv(name, ""))
        if origin:
            candidates.append(origin)
    if candidates:
        # Preserve order, remove duplicates.
        return ",".join(dict.fromkeys(candidates))
    return "http://localhost:5173"


origins_env = resolve_cors_origins()
origins = [o.strip() for o in origins_env.split(",") if o.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Has-More", "X-Next-Offset"],
)


@app.on_event("startup")
def on_startup():
    SQLModel.metadata.create_all(engine)
    ensure_folder_parent_column()
    ensure_asset_source_path_column()
    ensure_asset_indexes()
    if MOUNT_IMPORT_PATH and get_mount_import_enabled(MOUNT_IMPORT_ENABLED):
        threading.Thread(target=scan_mount_imports, daemon=True).start()


# Utilities ------------------------------------------------------

def is_mount_source_allowed(path: Path) -> bool:
    if not MOUNT_IMPORT_PATH:
        return False
    try:
        root = Path(MOUNT_IMPORT_PATH).resolve()
        candidate = path.resolve()
    except Exception:
        return False
    return candidate == root or root in candidate.parents


def resolve_asset_file(asset: Asset) -> Optional[Path]:
    p = STORAGE / asset.id / asset.filename
    if p.exists():
        return p
    if asset.source_path:
        source = Path(asset.source_path)
        if source.exists() and is_mount_source_allowed(source):
            return source
    return None


def folder_to_out(f: Folder) -> "FolderOut":
    return FolderOut(id=f.id, name=f.name, tags=json.loads(f.tags_json or "[]"), parent_id=f.parent_id)


def to_out(a: Asset) -> AssetOut:
    tags = json.loads(a.tags_json or "[]")
    safe_filename = quote(a.filename or "", safe="")
    return AssetOut(
        id=a.id,
        filename=a.filename,
        mime=a.mime,
        size=a.size,
        title=a.title,
        notes=a.notes,
        tags=tags,
        url=f"/file/{a.id}/{safe_filename}",
        thumb_url=f"/thumb/{a.id}.jpg" if (THUMBS / f"{a.id}.jpg").exists() else None,
        folder_id=a.folder_id,
    )


def arcname_for_asset(asset: Asset, folder_label_map: Optional[dict] = None) -> str:
    folder_part = "unassigned"
    if asset.folder_id:
        folder_part = (folder_label_map or {}).get(asset.folder_id, asset.folder_id)
    return f"{folder_part}/{asset.filename}"


def zip_assets_response(assets: List[Asset], download_name: str, background: BackgroundTasks, folder_label_map: Optional[dict] = None):
    files: List[tuple[str, Path]] = []
    for a in assets:
        path = resolve_asset_file(a)
        if not path:
            continue
        files.append((arcname_for_asset(a, folder_label_map), path))
    if not files:
        raise HTTPException(status_code=404, detail="No files available for download")

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    tmp_path = Path(tmp.name)
    tmp.close()
    with ZipFile(tmp_path, "w", ZIP_DEFLATED) as zf:
        for arc, fs_path in files:
            zf.write(fs_path, arcname=arc)

    background.add_task(lambda p=tmp_path: p.unlink(missing_ok=True))
    return FileResponse(tmp_path, media_type="application/zip", filename=download_name)


# Routes ---------------------------------------------------------


@app.get("/health")
def health():
    return {"ok": True, "auth_required": AUTH_ENABLED}


@app.get("/settings/mount-import", response_model=MountImportSettingsOut)
def get_mount_import_settings(_: AuthDep):
    return build_mount_import_response()


@app.post("/settings/mount-import", response_model=MountImportSettingsOut)
def update_mount_import_settings(body: MountImportSettings, _: AuthDep):
    set_mount_import_enabled(body.enabled)
    set_mount_import_copy(body.copy_files)
    return build_mount_import_response()


@app.post("/login", response_model=LoginResponse)
def login(body: LoginRequest):
    if not AUTH_ENABLED:
        raise HTTPException(status_code=503, detail="Authentication is not configured on the server")
    if body.username != AUTH_USERNAME or body.password != AUTH_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = create_token(body.username)
    return LoginResponse(token=token, expires_in=AUTH_TOKEN_TTL)


@app.post("/refresh", response_model=LoginResponse)
def refresh_token(token: Optional[str] = Depends(require_auth)):
    if not AUTH_ENABLED:
        raise HTTPException(status_code=503, detail="Authentication is not configured on the server")
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        payload = jwt.decode(token, AUTH_SECRET, algorithms=[AUTH_ALGO])
    except PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    new_token = create_token(username)
    return LoginResponse(token=new_token, expires_in=AUTH_TOKEN_TTL)


async def persist_uploaded_asset(
    file: UploadFile,
    title: Optional[str],
    notes: Optional[str],
    tags: Optional[str],
    folder_id: Optional[str],
) -> Asset:
    """Mirror of `persist_asset_from_response` for the multipart upload path.

    Inserts with size=0, streams the body to disk, optionally creates a thumbnail,
    then patches size/mime. On any failure the partial row + storage dir is removed.
    """
    safe_name = sanitize_filename(file.filename)
    mime = file.content_type or "application/octet-stream"
    parsed_tags = [t.strip() for t in (tags or "").split(",") if t.strip()]
    asset = Asset(
        filename=safe_name,
        mime=mime,
        size=0,
        title=title,
        notes=notes,
        tags_json=json.dumps(parsed_tags),
        folder_id=folder_id,
    )
    with Session(engine) as s:
        s.add(asset)
        s.commit()
        s.refresh(asset)

    dest = asset_path(asset.id, asset.filename)
    size = 0
    try:
        with open(dest, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > IMPORT_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="Uploaded file exceeds size limit")
                f.write(chunk)
        if is_thumb_eligible(asset.mime, dest.suffix):
            save_thumb(asset.id, dest)
    except Exception:
        cleanup_asset(asset.id)
        raise

    finalized = finalize_asset_record(asset.id, size, mime)
    return finalized or asset


@app.post("/upload", response_model=AssetOut)
async def upload(
    file: UploadFile = File(...),
    title: Optional[str] = Form(default=None),
    notes: Optional[str] = Form(default=None),
    tags: Optional[str] = Form(default=None),  # comma-separated
    folder_id: Optional[str] = Form(default=None),
    _: AuthDep = None,
):
    asset = await persist_uploaded_asset(file, title, notes, tags, folder_id)
    return to_out(asset)


@app.post("/import", response_model=AssetOut)
def import_from_link(body: ImportRequest, _: AuthDep):
    url = normalize_import_url(body.url)
    asset = import_asset_from_url(url, body)
    return to_out(asset)


@app.post("/import/inspect", response_model=ImportInspectOut)
def inspect_import_link(body: ImportRequest, _: AuthDep):
    url = normalize_import_url(body.url)
    resp, final_url = open_import_response(url, body)
    with resp:
        filename = build_import_filename(final_url, resp.headers, body.filename)
        mime = mime_from_content_type(resp.headers.get("Content-Type", ""), filename)
    is_zip = Path(filename).suffix.lower() == ".zip"
    return ImportInspectOut(filename=filename, mime=mime, is_zip=is_zip)


@app.post("/import/zip/entries", response_model=ImportZipEntriesOut)
def list_import_zip_entries(body: ImportZipEntriesRequest, _: AuthDep):
    url = normalize_import_url(body.url)
    tmp_path, filename, _ = download_import_to_temp(url, body)
    try:
        if Path(filename).suffix.lower() != ".zip":
            raise HTTPException(status_code=415, detail="Imported file is not a zip")
        try:
            entries = list_zip_entries(tmp_path)
        except BadZipFile:
            raise HTTPException(status_code=400, detail="Invalid zip file")
        if not entries:
            raise HTTPException(status_code=400, detail="No files found in zip")
        return ImportZipEntriesOut(filename=filename, entries=entries)
    finally:
        tmp_path.unlink(missing_ok=True)


@app.post("/import/zip", response_model=ImportZipResult)
def import_zip_entries(body: ImportZipExtractRequest, _: AuthDep):
    url = normalize_import_url(body.url)
    tmp_path, filename, _ = download_import_to_temp(url, body)
    try:
        if Path(filename).suffix.lower() != ".zip":
            raise HTTPException(status_code=415, detail="Imported file is not a zip")
        try:
            assets, failed = extract_zip_entries_to_assets(tmp_path, body.entries, body)
        except BadZipFile:
            raise HTTPException(status_code=400, detail="Invalid zip file")
        return ImportZipResult(assets=[to_out(asset) for asset in assets], failed=failed)
    finally:
        tmp_path.unlink(missing_ok=True)


@app.get("/file/{asset_id}/{name}")
def get_file(asset_id: str, name: str, _: AuthDep):
    media_type: Optional[str] = None
    with Session(engine) as s:
        a = s.get(Asset, asset_id)
        if a:
            media_type = a.mime
            p = resolve_asset_file(a)
        else:
            p = None

    if not p or not p.exists():
        raise HTTPException(404)

    return FileResponse(
        p,
        media_type=media_type or "application/octet-stream",
        filename=name,
    )


@app.get("/thumb/{asset_id}.jpg")
def get_thumb(asset_id: str, _: AuthDep):
    p = THUMBS / f"{asset_id}.jpg"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


def apply_asset_filters(stmt, q: Optional[str], tags: Optional[str], folder_id: Optional[str]):
    if q:
        qlike = f"%{q}%"
        stmt = stmt.where((Asset.filename.like(qlike)) | (Asset.title.like(qlike)) | (Asset.notes.like(qlike)))
    if folder_id:
        stmt = stmt.where(Asset.folder_id == folder_id)
    tag_filter = [t.strip() for t in (tags or "").split(",") if t.strip()]
    for tag in tag_filter:
        stmt = stmt.where(Asset.tags_json.like(f'%"{tag}"%'))
    return stmt


@app.get("/assets", response_model=List[AssetOut])
def list_assets(
    response: Response,
    q: Optional[str] = None,
    tags: Optional[str] = Query(default=None, description="Comma-separated tags"),
    folder_id: Optional[str] = None,
    limit: Optional[int] = Query(default=None, ge=1, le=1000),
    offset: Optional[int] = Query(default=None, ge=0),
    *,
    _: AuthDep,
):
    with Session(engine) as s:
        stmt = apply_asset_filters(select(Asset), q, tags, folder_id)
        stmt = stmt.order_by(Asset.filename, Asset.id)
        if limit is not None:
            stmt = stmt.limit(limit + 1)
            if offset:
                stmt = stmt.offset(offset)
        assets = list(s.exec(stmt))

    has_more = False
    if limit is not None and len(assets) > limit:
        has_more = True
        assets = assets[:limit]
    if limit is not None and response is not None:
        response.headers["X-Has-More"] = "true" if has_more else "false"
        response.headers["X-Next-Offset"] = str((offset or 0) + len(assets))

    out: List[AssetOut] = [to_out(a) for a in assets]
    return out


@app.get("/tags", response_model=List[str])
def list_tags(
    q: Optional[str] = None,
    tags: Optional[str] = Query(default=None, description="Comma-separated tags"),
    folder_id: Optional[str] = None,
    *,
    _: AuthDep,
):
    with Session(engine) as s:
        stmt = apply_asset_filters(select(Asset.tags_json), q, tags, folder_id)
        rows = list(s.exec(stmt))

    found: set[str] = set()
    for raw in rows:
        try:
            parsed = json.loads(raw or "[]")
        except Exception:
            continue
        if not isinstance(parsed, list):
            continue
        for tag in parsed:
            if isinstance(tag, str):
                cleaned = tag.strip()
                if cleaned:
                    found.add(cleaned)

    return sorted(found, key=lambda v: v.lower())


@app.post("/download/zip")
def download_zip(body: DownloadRequest, background: BackgroundTasks, _: AuthDep):
    if not (body.asset_ids or body.tag or body.folder_id):
        raise HTTPException(status_code=400, detail="Provide asset_ids, tag, or folder_id to download.")

    with Session(engine) as s:
        stmt = select(Asset)
        if body.asset_ids:
            stmt = stmt.where(Asset.id.in_(body.asset_ids))
        if body.folder_id:
            stmt = stmt.where(Asset.folder_id == body.folder_id)
        assets = list(s.exec(stmt))
        folder_map = {}
        folder_ids = {a.folder_id for a in assets if a.folder_id}
        if folder_ids:
            for f in s.exec(select(Folder).where(Folder.id.in_(folder_ids))):
                folder_map[f.id] = f.name

    if body.tag:
        tag = body.tag.strip()
        assets = [a for a in assets if tag in json.loads(a.tags_json or "[]")]

    download_name = body.filename or "makersvault.zip"
    if body.tag:
        safe_tag = body.tag.replace(" ", "_")[:50] or "tag"
        download_name = f"{safe_tag}.zip"
    if body.folder_id and folder_map.get(body.folder_id):
        safe_name = folder_map[body.folder_id].replace(" ", "_")[:50] or "folder"
        download_name = f"{safe_name}.zip"

    return zip_assets_response(assets, download_name, background, folder_map)


@app.post("/asset/{asset_id}/tags", response_model=AssetOut)
def set_tags(asset_id: str, body: TagUpdate, _: AuthDep):
    with Session(engine) as s:
        a = s.get(Asset, asset_id)
        if not a:
            raise HTTPException(404)
        a.tags_json = json.dumps(body.tags)
        s.add(a)
        s.commit()
        s.refresh(a)
        return to_out(a)


@app.post("/asset/{asset_id}/meta", response_model=AssetOut)
def update_asset_meta(asset_id: str, body: AssetMetaUpdate, _: AuthDep):
    with Session(engine) as s:
        a = s.get(Asset, asset_id)
        if not a:
            raise HTTPException(404)
        if body.title is not None:
            a.title = body.title
        if body.notes is not None:
            a.notes = body.notes
        s.add(a)
        s.commit()
        s.refresh(a)
        return to_out(a)


@app.post("/asset/{asset_id}/rename", response_model=AssetOut)
def rename_asset(asset_id: str, body: AssetRename, _: AuthDep):
    new_name = (body.filename or "").strip()
    if not new_name:
        raise HTTPException(400, "Filename cannot be empty")
    if "/" in new_name or "\\" in new_name:
        raise HTTPException(400, "Invalid filename")

    with Session(engine) as s:
        a = s.get(Asset, asset_id)
        if not a:
            raise HTTPException(404)
        old_path = STORAGE / asset_id / a.filename
        if not old_path.exists():
            if a.source_path:
                raise HTTPException(400, "Renaming is not supported for mounted files.")
            raise HTTPException(404, "File not found on disk")
        root, ext = os.path.splitext(os.path.basename(a.filename))
        proposed_root, proposed_ext = os.path.splitext(os.path.basename(new_name))
        final_ext = proposed_ext or ext
        if not final_ext:
            raise HTTPException(400, "Filename must include an extension")
        new_name_only = (proposed_root or root) + final_ext
        new_path = STORAGE / asset_id / new_name_only
        if new_name_only == a.filename:
            return to_out(a)
        if new_path.exists():
            raise HTTPException(400, "A file with that name already exists")
        old_path.rename(new_path)
        a.filename = new_name_only
        s.add(a)
        s.commit()
        s.refresh(a)
        return to_out(a)


@app.delete("/asset/{asset_id}")
def delete_asset(asset_id: str, _: AuthDep):
    with Session(engine) as s:
        a = s.get(Asset, asset_id)
        if not a:
            raise HTTPException(404)
        s.delete(a)
        s.commit()
    cleanup_asset(asset_id)
    return {"ok": True}


# Folder endpoints ----------------------------------------------


@app.get("/folders", response_model=List[FolderOut])
def list_folders(_: AuthDep):
    with Session(engine) as s:
        rows = list(s.exec(select(Folder)))
    return [folder_to_out(f) for f in rows]


@app.post("/folders", response_model=FolderOut)
def create_folder(body: FolderIn, _: AuthDep):
    with Session(engine) as s:
        parent_id = validate_parent_folder(s, body.parent_id)
        f = Folder(name=body.name, tags_json=json.dumps(body.tags), parent_id=parent_id)
        s.add(f)
        s.commit()
        s.refresh(f)
    return folder_to_out(f)


@app.patch("/folder/{folder_id}", response_model=FolderOut)
def update_folder(folder_id: str, body: FolderIn, _: AuthDep):
    with Session(engine) as s:
        f = s.get(Folder, folder_id)
        if not f:
            raise HTTPException(404)
        parent_id = validate_parent_folder(s, body.parent_id, folder_id)
        f.name = body.name
        f.tags_json = json.dumps(body.tags)
        f.parent_id = parent_id
        s.add(f)
        s.commit()
        s.refresh(f)
        return folder_to_out(f)


@app.delete("/folder/{folder_id}")
def delete_folder(folder_id: str, _: AuthDep):
    with Session(engine) as s:
        f = s.get(Folder, folder_id)
        if not f:
            raise HTTPException(404)
        # Detach children to root
        for child in s.exec(select(Folder).where(Folder.parent_id == folder_id)):
            child.parent_id = None
            s.add(child)
        # Unassign assets in this folder
        for asset in s.exec(select(Asset).where(Asset.folder_id == folder_id)):
            asset.folder_id = None
            s.add(asset)
        s.delete(f)
        s.commit()
    return {"ok": True}


@app.get("/folder/{folder_id}/download")
def download_folder(folder_id: str, background: BackgroundTasks, _: AuthDep):
    with Session(engine) as s:
        folder = s.get(Folder, folder_id)
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")
        assets = list(s.exec(select(Asset).where(Asset.folder_id == folder_id)))
        folder_map = {folder_id: folder.name}
    download_name = f"{(folder.name or 'folder').replace(' ', '_')[:50] or 'folder'}.zip"
    return zip_assets_response(assets, download_name, background, folder_map)

@app.post("/asset/{asset_id}/folder", response_model=AssetOut)
def update_asset_folder(asset_id: str, body: AssetFolderUpdate, _: AuthDep):
    with Session(engine) as s:
        asset = s.get(Asset, asset_id)
        if not asset:
            raise HTTPException(404)
        folder_id = body.folder_id or None
        if folder_id:
            folder = s.get(Folder, folder_id)
            if not folder:
                raise HTTPException(status_code=400, detail="Folder not found")
            asset.folder_id = folder.id
        else:
            asset.folder_id = None
        s.add(asset)
        s.commit()
        s.refresh(asset)
        return to_out(asset)
