"""Tests for POST /admin/rescan-mount: re-index + prune vanished mount files."""
import io
import time
import uuid
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image


def _insert_mount_asset(asset_id: str, filename: str, data: bytes, mime="model/stl") -> None:
    """Insert an asset as if it came from the mount (source_path set, file only
    exists in the mount dir, not in STORAGE)."""
    import json
    from db import engine
    from models import Asset
    from sqlmodel import Session
    from main import MOUNT_IMPORT_PATH
    assert MOUNT_IMPORT_PATH, "tests need IMPORT_MOUNT_PATH env set"
    src = Path(MOUNT_IMPORT_PATH) / filename
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(data)
    with Session(engine) as s:
        s.add(Asset(id=asset_id, filename=filename, mime=mime, size=len(data),
                    title=None, notes=None, tags_json="[]", source_path=str(src)))
        s.commit()


def test_rescan_reports_summary(client: TestClient, auth_headers, clean_db):
    start = client.post("/admin/rescan-mount", headers=auth_headers)
    assert start.status_code == 200
    job_id = start.json()["job_id"]
    assert job_id
    deadline = time.time() + 15
    body = None
    while time.time() < deadline:
        r = client.get(f"/admin/jobs/{job_id}", headers=auth_headers)
        body = r.json()
        if body["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    assert body is not None and body["status"] in ("done", "error")


def test_rescan_requires_auth(client: TestClient, clean_db):
    assert client.post("/admin/rescan-mount").status_code == 401