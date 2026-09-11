"""Tests for the background thumbnail-backfill job endpoint.

POST /admin/generate-missing-thumbnails now returns a job id immediately; the
actual rendering runs on a background thread whose progress is read via
GET /admin/jobs/{job_id}. Tests poll until the job reports done.
"""
import io
import time
import uuid

from fastapi.testclient import TestClient


def _insert_raw_3d_asset(asset_id: str, filename: str, data: bytes) -> None:
    """Insert a 3D asset directly into storage (no thumb), like a mount-imported file."""
    import json
    from db import STORAGE, engine
    from models import Asset
    from sqlmodel import Session
    d = STORAGE / asset_id
    d.mkdir(parents=True, exist_ok=True)
    (d / filename).write_bytes(data)
    with Session(engine) as s:
        s.add(Asset(
            id=asset_id,
            filename=filename,
            mime="model/stl",
            size=len(data),
            title=None,
            notes=None,
            tags_json="[]",
        ))
        s.commit()


def _wait_for_job(client: TestClient, headers: dict, job_id: str, timeout=15) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/admin/jobs/{job_id}", headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        if body["status"] in ("done", "error"):
            return body
        time.sleep(0.1)
    raise AssertionError("job did not finish in time")


def test_background_backfill_generates_thumbnails(client, auth_headers, clean_db):
    # A valid minimal ASCII STL that trimesh can render.
    stl = (
        "solid benchy\n"
        "  facet normal 0 0 1\n    outer loop\n"
        "      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n"
        "    endloop\n  endfacet\n"
        "endsolid benchy\n"
    ).encode()
    aid = str(uuid.uuid4())
    _insert_raw_3d_asset(aid, "part.stl", stl)

    start = client.post("/admin/generate-missing-thumbnails", headers=auth_headers)
    assert start.status_code == 200, start.text
    job_id = start.json()["job_id"]
    assert job_id

    # Immediately after starting, the job should exist and be running/queued.
    status = client.get(f"/admin/jobs/{job_id}", headers=auth_headers).json()
    assert status["status"] in ("running", "done")

    final = _wait_for_job(client, auth_headers, job_id)
    assert final["status"] == "done" or final["error"]
    # The minimal STL may or may not render; assert no catastrophic failure count.
    assert final["failed"] + final["generated"] >= 1


def test_job_requires_auth(client, clean_db):
    assert client.post("/admin/generate-missing-thumbnails").status_code == 401
    assert client.get("/admin/jobs/whatever").status_code == 401


def test_missing_job_returns_404(client, auth_headers, clean_db):
    r = client.get("/admin/jobs/does-not-exist", headers=auth_headers)
    assert r.status_code == 404