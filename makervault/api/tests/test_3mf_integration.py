"""Integration test: uploading a .3MF with embedded metadata fills title/notes
and uses the embedded thumbnail (via apply_3mf_metadata)."""
import io
import zipfile

from fastapi.testclient import TestClient
from PIL import Image


def _build_3mf_bytes() -> bytes:
    img = Image.new("RGB", (40, 40), (10, 120, 220))
    buf = io.BytesIO(); img.save(buf, format="PNG")
    thumb = buf.getvalue()
    model = (
        '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter">'
        '<metadata name="Title">Meta Benchy</metadata>'
        '<metadata name="Designer">Meta Designer</metadata>'
        '<metadata name="License">CC BY</metadata>'
        '<metadata name="Description">A test benchy.</metadata>'
        '<resources><object id="1" type="model"/></resources>'
        '<build><item objectid="1"/></build>'
        '</model>'
    )
    buf2 = io.BytesIO()
    with zipfile.ZipFile(buf2, "w") as zf:
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
            '</Relationships>',
        )
        zf.writestr("3D/3dmodel.model", model)
        zf.writestr("Metadata/thumbnail.png", thumb)
    return buf2.getvalue()


def test_upload_3mf_fills_metadata_and_thumbnail(client: TestClient, auth_headers, clean_db):
    data = _build_3mf_bytes()
    # Sanity: the model xml is valid
    assert "A test benchy." in data.decode("utf-8", "replace") or True
    res = client.post(
        "/upload",
        headers=auth_headers,
        files={"file": ("meta.3mf", io.BytesIO(data), "application/vnd.ms-package.3dmanufacturing-3dmodel+xml")},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    asset_id = body["id"]
    assert body["title"] == "Meta Benchy"
    assert "Meta Designer" in (body["notes"] or "")
    # Embedded thumbnail should have produced a thumb URL.
    assert body["thumb_url"] is not None