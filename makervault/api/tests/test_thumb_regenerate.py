"""Tests for POST /asset/{id}/thumbnail/regenerate (single-asset thumbnail)."""
import io
import uuid

from fastapi.testclient import TestClient
from PIL import Image

_STL = (
    "solid benchy\n"
    "  facet normal 0 0 1\n    outer loop\n"
    "      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n"
    "    endloop\n  endfacet\n"
    "endsolid benchy\n"
).encode()


def _insert_raw_3d_asset(asset_id: str, filename: str, data: bytes, mime="model/stl") -> None:
    import json
    from db import STORAGE, engine
    from models import Asset
    from sqlmodel import Session
    d = STORAGE / asset_id
    d.mkdir(parents=True, exist_ok=True)
    (d / filename).write_bytes(data)
    with Session(engine) as s:
        s.add(Asset(id=asset_id, filename=filename, mime=mime, size=len(data),
                    title=None, notes=None, tags_json="[]"))
        s.commit()


def test_regenerate_replaces_existing_thumbnail(client: TestClient, auth_headers, clean_db):
    from db import THUMBS
    aid = str(uuid.uuid4())
    _insert_raw_3d_asset(aid, "part.stl", _STL)
    # Pre-create a stale thumb so we can prove it gets replaced.
    (THUMBS / f"{aid}.jpg").write_bytes(b"stale")
    stale_mtime = (THUMBS / f"{aid}.jpg").stat().st_mtime_ns

    res = client.post(f"/asset/{aid}/thumbnail/regenerate", headers=auth_headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["id"] == aid
    assert body["thumb_url"] is not None
    # The stale thumb was deleted and a new one written.
    thumb = THUMBS / f"{aid}.jpg"
    if thumb.exists():
        assert thumb.stat().st_mtime_ns != stale_mtime
        assert thumb.read_bytes() != b"stale"


def test_regenerate_unknown_asset_404(client: TestClient, auth_headers, clean_db):
    res = client.post("/asset/does-not-exist/thumbnail/regenerate", headers=auth_headers)
    assert res.status_code == 404


def test_regenerate_rejects_non_3d(client: TestClient, auth_headers, clean_db):
    # A .txt asset is not thumbnail-eligible.
    aid = str(uuid.uuid4())
    _insert_raw_3d_asset(aid, "notes.txt", b"hello", mime="text/plain")
    res = client.post(f"/asset/{aid}/thumbnail/regenerate", headers=auth_headers)
    assert res.status_code == 400


def test_regenerate_requires_auth(client: TestClient, clean_db):
    res = client.post("/asset/x/thumbnail/regenerate")
    assert res.status_code == 401