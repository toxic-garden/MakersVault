"""Tests for empty-folder pruning during POST /admin/rescan-mount."""
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from db import engine
from models import Asset, Folder
from typing import Iterator


@pytest.fixture()
def mount_root(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Path]:
    """Point main.MOUNT_IMPORT_PATH at a fresh temp dir for this test.

    main.py reads MOUNT_IMPORT_PATH from the env at import time; the rescan
    worker reads the module attribute at runtime, so patching it here is safe.
    """
    root = Path("/tmp") / f"mv-mount-test-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True, exist_ok=True)
    # scan_mount_imports reads the path from the config module (import-time
    # binding), so patch it there; main.MOUNT_IMPORT_PATH is only surfaced to
    # the settings API and read at runtime too.
    monkeypatch.setattr("config.MOUNT_IMPORT_PATH", str(root))
    monkeypatch.setattr("main.MOUNT_IMPORT_PATH", str(root))
    yield root
    import shutil
    shutil.rmtree(root, ignore_errors=True)


def _wait_job(client: TestClient, headers, job_id: str, timeout=15) -> dict:
    deadline = time.time() + timeout
    body = None
    while time.time() < deadline:
        body = client.get(f"/admin/jobs/{job_id}", headers=headers).json()
        if body["status"] in ("done", "error"):
            return body
        time.sleep(0.1)
    raise AssertionError("rescan job did not finish in time")


def test_rescan_prunes_empty_mount_folders(client: TestClient, auth_headers, clean_db, mount_root: Path):
    # Simulate a previously imported nested library: root/sub/deep/gone.stl
    deep_dir = mount_root / "sub" / "deep"
    deep_dir.mkdir(parents=True, exist_ok=True)
    src = deep_dir / "gone.stl"
    src.write_bytes(b"solid x")

    # Build the folder chain the import would have created: sub -> deep
    sub_id = deep_id = None
    with Session(engine) as s:
        sub = Folder(name="sub", tags_json="[]", parent_id=None)
        deep = Folder(name="deep", tags_json="[]", parent_id=sub.id)
        s.add(sub); s.add(deep); s.commit()
        sub_id, deep_id = sub.id, deep.id
        s.add(Asset(id=str(uuid.uuid4()), filename="gone.stl", mime="model/stl", size=7,
                    title=None, notes=None, tags_json="[]", folder_id=deep_id,
                    source_path=str(src)))
        s.commit()

    # User removed the source file from the library.
    src.unlink()

    start = client.post("/admin/rescan-mount", headers=auth_headers)
    assert start.status_code == 200
    summary = _wait_job(client, auth_headers, start.json()["job_id"])
    assert summary["status"] == "done"

    folders = {f["id"]: f for f in client.get("/folders", headers=auth_headers).json()}
    assert deep_id not in folders, "empty mount folder should be pruned"
    assert sub_id not in folders, "parent folder becomes empty after child removal -> pruned"


def test_rescan_keeps_nonempty_and_user_folders(client: TestClient, auth_headers, clean_db, mount_root: Path):
    # A mount asset that still exists -> its folder must survive.
    src = mount_root / "keep" / "keep.stl"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(b"solid keep")
    keep = Folder(name="keep", tags_json="[]", parent_id=None)
    user_folder = Folder(name="my own stuff", tags_json="[]", parent_id=None)
    keep_id = user_id = None
    with Session(engine) as s:
        s.add(keep); s.add(user_folder); s.commit()
        keep_id, user_id = keep.id, user_folder.id
        s.add(Asset(id=str(uuid.uuid4()), filename="keep.stl", mime="model/stl", size=10,
                    title=None, notes=None, tags_json="[]", folder_id=keep_id,
                    source_path=str(src)))
        s.commit()

    start = client.post("/admin/rescan-mount", headers=auth_headers)
    summary = _wait_job(client, auth_headers, start.json()["job_id"])
    assert summary["status"] == "done"

    folders = {f["id"]: f for f in client.get("/folders", headers=auth_headers).json()}
    assert keep_id in folders, "folder with existing source file must survive"
    assert user_id in folders, "user-created folder without mount relation must survive"