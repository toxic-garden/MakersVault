import json
from pathlib import Path
from typing import List, Optional

from fastapi import HTTPException
from PIL import Image
from sqlmodel import Session

from config import IMPORT_MAX_BYTES
from db import STORAGE, THUMBS, engine
from file_utils import build_import_filename, mime_from_content_type
from models import Asset
from schemas import ImportRequest


def asset_dir(asset_id: str) -> Path:
    p = STORAGE / asset_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def asset_path(asset_id: str, name: str) -> Path:
    return asset_dir(asset_id) / name


def save_thumb(asset_id: str, src: Path) -> Optional[str]:
    try:
        thumb = THUMBS / f"{asset_id}.jpg"
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((512, 512))
            im.save(thumb, quality=88)
        return f"/thumb/{asset_id}.jpg"
    except Exception:
        return None


def create_asset_record(
    filename: str,
    mime: str,
    title: Optional[str],
    notes: Optional[str],
    tags: List[str],
    folder_id: Optional[str],
    source_path: Optional[str] = None,
) -> Asset:
    asset = Asset(
        filename=filename,
        mime=mime,
        size=0,
        title=title,
        notes=notes,
        tags_json=json.dumps([t.strip() for t in tags if t.strip()]),
        folder_id=folder_id,
        source_path=source_path,
    )
    with Session(engine) as s:
        s.add(asset)
        s.commit()
        s.refresh(asset)
    return asset


def finalize_asset_record(asset_id: str, size: int, mime: Optional[str] = None) -> Optional[Asset]:
    with Session(engine) as s:
        db_a = s.get(Asset, asset_id)
        if not db_a:
            return None
        db_a.size = size
        if mime:
            db_a.mime = mime
        s.add(db_a)
        s.commit()
        s.refresh(db_a)
        return db_a


def cleanup_asset(asset_id: str) -> None:
    with Session(engine) as s:
        a = s.get(Asset, asset_id)
        if a:
            s.delete(a)
            s.commit()
    # Each cleanup step in its own try-block so one failure cannot block
    # the others (e.g. a non-empty asset dir must not prevent thumb removal).
    ap = STORAGE / asset_id
    try:
        if ap.exists():
            for child in ap.iterdir():
                child.unlink(missing_ok=True)
            ap.rmdir()
    except Exception:
        pass
    try:
        (THUMBS / f"{asset_id}.jpg").unlink(missing_ok=True)
    except Exception:
        pass


def stream_response_to_file(resp, dest: Path) -> int:
    size = 0
    with open(dest, "wb") as f:
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > IMPORT_MAX_BYTES:
                raise HTTPException(status_code=413, detail="Imported file exceeds size limit")
            f.write(chunk)
    return size


def persist_asset_from_response(resp, final_url: str, body: ImportRequest) -> Asset:
    content_length = resp.headers.get("Content-Length")
    if content_length:
        try:
            if int(content_length) > IMPORT_MAX_BYTES:
                raise HTTPException(status_code=413, detail="Imported file exceeds size limit")
        except ValueError:
            pass

    filename = build_import_filename(final_url, resp.headers, body.filename)
    mime = mime_from_content_type(resp.headers.get("Content-Type", ""), filename)
    asset = create_asset_record(filename, mime, body.title, body.notes, body.tags, body.folder_id)
    dest = asset_path(asset.id, asset.filename)
    try:
        size = stream_response_to_file(resp, dest)
        if (mime or "").startswith("image/") and dest.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
            save_thumb(asset.id, dest)
        refreshed = finalize_asset_record(asset.id, size, mime)
        return refreshed or asset
    except HTTPException:
        cleanup_asset(asset.id)
        raise
    except Exception as exc:
        cleanup_asset(asset.id)
        raise HTTPException(status_code=500, detail=f"Import failed: {exc}")
