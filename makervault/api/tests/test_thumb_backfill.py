"""Tests for the /admin/generate-missing-thumbnails endpoint (3D thumbnail backfill)."""
import io

from fastapi.testclient import TestClient
from PIL import Image


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


def test_generates_missing_3d_thumbnails(client: TestClient, auth_headers, clean_db):
    import uuid
    # A valid minimal STL (ASCII solid) so trimesh can render it.
    stl = (
        "solid benchy\n"
        "  facet normal 0 0 1\n    outer loop\n"
        "      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n"
        "    endloop\n  endfacet\n"
        "endsolid benchy\n"
    ).encode()
    aid = str(uuid.uuid4())
    _insert_raw_3d_asset(aid, "part.stl", stl)

    rb = client.post("/admin/generate-missing-thumbnails", headers=auth_headers)
    assert rb.status_code == 200
    body = rb.json()
    assert body["generated"] >= 1
    assert body["failed"] == 0

    # Thumbnail file should now exist.
    from db import THUMBS
    assert (THUMBS / f"{aid}.jpg").exists() or (THUMBS / f"{aid}.png").exists()


def test_skips_assets_that_already_have_thumb(client: TestClient, auth_headers, clean_db):
    import uuid
    from db import STORAGE, THUMBS, engine
    from models import Asset
    from sqlmodel import Session
    import json
    aid = str(uuid.uuid4())
    dd = STORAGE / aid; dd.mkdir(parents=True, exist_ok=True)
    (dd / "x.3mf").write_bytes(b"not-a-real-3mf")
    with Session(engine) as s:
        s.add(Asset(id=aid, filename="x.3mf", mime="model/stl", size=0, title=None, notes=None, tags_json="[]"))
        s.commit()
    # Pre-create a thumb so it should be skipped.
    (THUMBS / f"{aid}.jpg").write_bytes(b"fake")

    rb = client.post("/admin/generate-missing-thumbnails", headers=auth_headers)
    body = rb.json()
    assert body["generated"] == 0
    # The 3MF has a thumb -> skipped. (Its file is not a valid 3MF but the thumb
    # check short-circuits before reading it.)
    assert body["skipped"] >= 1


def test_requires_auth(client: TestClient, clean_db):
    assert client.post("/admin/generate-missing-thumbnails").status_code == 401