"""Tests for the .3MF metadata/thumbnail extraction module (three_mf.py)."""
import io
import zipfile

import pytest
from PIL import Image

from three_mf import extract_3mf_metadata


def _build_3mf(tmp_path, *, with_meta=True, with_thumb=True, thumb_path="Metadata/thumbnail.png"):
    """Create a minimal .3MF package and return its path."""
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        ' <Relationship Target="/3D/3dmodel.model" Id="rel0" '
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'
        '</Relationships>\n'
    )
    model = (
        '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
        'unit="millimeter">\n'
        '<metadata name="Application">TestSlicer</metadata>\n'
        '<metadata name="Title">My Test Part</metadata>\n'
        '<metadata name="Designer">Jane Doe</metadata>\n'
        '<metadata name="License">CC BY</metadata>\n'
        if with_meta else ""
    ) + (
        '<resources><object id="1" type="model"/>'
        '</resources><build><item objectid="1"/></build></model>'
    )
    content = (
        '<contentTypes xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '</contentTypes>'
    )
    img = Image.new("RGB", (32, 32), (200, 40, 40))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    thumb = buf.getvalue()

    path = tmp_path / "test.3mf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("_rels/.rels", rels)
        zf.writestr("[Content_Types].xml", content)
        zf.writestr("3D/3dmodel.model", model)
        if with_thumb and thumb_path:
            if thumb_path.startswith("Metadata/"):
                zf.writestr("Metadata/", b"")
            zf.writestr(thumb_path, thumb)
    return path


def test_extracts_title_designer_notes(tmp_path):
    path = _build_3mf(tmp_path)
    res = extract_3mf_metadata(path)
    assert res["title"] == "My Test Part"
    assert "Designer: Jane Doe" in res["notes"]
    assert "License: CC BY" in res["notes"]


def test_extracts_embedded_thumbnail(tmp_path):
    path = _build_3mf(tmp_path)
    res = extract_3mf_metadata(path)
    thumb = res.get("thumbnail_bytes")
    assert thumb is not None
    assert thumb[:8] == b"\x89PNG\r\n\x1a\n"


def test_prefers_thumb_middle_metadata_reference(tmp_path):
    # Build a package with both a fallback thumb and an explicit Thumbnail_Middle
    # reference that should win over the fallback.
    img = Image.new("RGB", (10, 10), (1, 2, 3))
    buf = io.BytesIO(); img.save(buf, format="PNG")
    model = (
        '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter">'
        '<metadata name="Title">Ref</metadata>'
        '<metadata name="Thumbnail_Middle">/Metadata/plate_2.png</metadata>'
        '<resources><object id="1"/></resources><build><item objectid="1"/></build></model>'
    )
    p = tmp_path / "referenced.3mf"
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
        )
        zf.writestr("3D/3dmodel.model", model)
        # Fallback thumb present too, at the "standard" location.
        zf.writestr("Metadata/thumbnail.png", b"fallback")
        zf.writestr("Metadata/plate_2.png", buf.getvalue())
    res = extract_3mf_metadata(p)
    assert res["title"] == "Ref"
    thumb = res.get("thumbnail_bytes")
    # The explicit Thumbnail_Middle reference must win over the fallback.
    assert thumb == buf.getvalue()


def test_returns_empty_for_3mf_without_metadata(tmp_path):
    path = _build_3mf(tmp_path, with_meta=False, with_thumb=False)
    res = extract_3mf_metadata(path)
    assert "title" not in res
    assert "notes" not in res
    assert "thumbnail_bytes" not in res