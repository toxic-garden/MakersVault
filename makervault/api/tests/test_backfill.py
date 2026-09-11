"""Tests for the /admin/backfill-3mf-metadata endpoint."""
import io
import zipfile

from fastapi.testclient import TestClient
from PIL import Image


def _3mf_bytes(title: str) -> bytes:
    img = Image.new("RGB", (24, 24), (8, 8, 8))
    buf = io.BytesIO(); img.save(buf, format="PNG")
    thumb = buf.getvalue()
    model = (
        '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter">'
        f'<metadata name="Title">{title}</metadata>'
        '<metadata name="Designer">Backfill Author</metadata>'
        '<resources><object id="1" type="model"/></resources>'
        '<build><item objectid="1"/></build></model>'
    )
    buf2 = io.BytesIO()
    with zipfile.ZipFile(buf2, "w") as zf:
        zf.writestr(
            "3D/3dmodel.model", model
        )
        zf.writestr("Metadata/thumbnail.png", thumb)
    return buf2.getvalue()


def _insert_raw_3mf_asset(asset_id: str, filename: str, data: bytes) -> None:
    """Insert a .3MF asset directly into storage (bypassing /upload, which now
    auto-extracts metadata) so it represents a pre-existing, untagged asset."""
    from db import STORAGE, engine
    from models import Asset
    from sqlmodel import Session
    import json
    d = STORAGE / asset_id
    d.mkdir(parents=True, exist_ok=True)
    (d / filename).write_bytes(data)
    with Session(engine) as s:
        a = Asset(
            id=asset_id,
            filename=filename,
            mime="application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
            size=len(data),
            title=None,
            notes=None,
            tags_json="[]",
        )
        s.add(a)
        s.commit()


def test_backfill_individual_asset(client: TestClient, auth_headers, clean_db):
    import uuid
    asset_id = str(uuid.uuid4())
    data = _3mf_bytes("Backfill Title")
    _insert_raw_3mf_asset(asset_id, "old.3mf", data)

    rb = client.post(f"/admin/backfill-3mf-metadata?asset_id={asset_id}", headers=auth_headers)
    assert rb.status_code == 200
    assert rb.json()["done"] == 1

    upd = [a for a in client.get("/assets", headers=auth_headers).json() if a["id"] == asset_id][0]
    assert upd["title"] == "Backfill Title"


def test_backfill_all_skips_non_3mf(client: TestClient, auth_headers, clean_db):
    import uuid
    # one .3MF to backfill + one STL that should be skipped as not_3mf
    aid = str(uuid.uuid4())
    _insert_raw_3mf_asset(aid, "old2.3mf", _3mf_bytes("Another"))
    stl_bytes = b"solid x"
    from db import STORAGE, engine
    from models import Asset
    from sqlmodel import Session
    import json
    sid = str(uuid.uuid4())
    d = STORAGE / sid; d.mkdir(parents=True, exist_ok=True)
    (d / "plain.stl").write_bytes(stl_bytes)
    with Session(engine) as s:
        s.add(Asset(id=sid, filename="plain.stl", mime="model/stl", size=len(stl_bytes), title=None, notes=None, tags_json="[]"))
        s.commit()

    rb = client.post("/admin/backfill-3mf-metadata", headers=auth_headers)
    assert rb.status_code == 200
    body = rb.json()
    assert body["done"] == 1
    assert body["not_3mf"] >= 1


def test_backfill_requires_auth(client: TestClient, clean_db):
    rb = client.post("/admin/backfill-3mf-metadata?asset_id=x")
    assert rb.status_code == 401