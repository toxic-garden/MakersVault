"""Extract metadata and embedded thumbnails from .3MF (3D Manufacturing Format).

A .3MF is a ZIP package. The main document `3D/3dmodel.model` holds model-level
metadata (title, designer, description, license, …) in `<metadata name="…">`
elements. Slicers (BambuStudio, OrcaSlicer) additionally embed plate thumbnails
under `Metadata/` or `Auxiliaries/.thumbnails/` and reference one via a
`Thumbnail_*` metadata entry.

We read the ZIP directly with stdlib `zipfile` (no new dependency) rather than
relying on trimesh, which does not expose the model metadata or the embedded
thumbnail images.
"""
from __future__ import annotations

import html
import io
import re
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

# Metadata names we understand, mapped to MakerVault asset fields.
TITLE_KEYS = ("Title", "Name")
NOTES_KEYS = ("Description",)
ORIGIN_KEYS = ("Designer", "License")

_THUMB_META_PATTERNS = re.compile(r"thumb(?:nail)?[_ ]?(?:small|middle|large)?", re.IGNORECASE)

# Candidate locations for embedded thumbnails, in priority order. The
# Thumbnail_Middle metadata wins when present; otherwise we fall back to the
# first matching file (preferring the larger/middle variant).
_THUMB_PATHS = (
    "Metadata/plate_1.png",
    "Metadata/plate_no_light_1.png",
    "Metadata/top_1.png",
    "Metadata/thumbnail.png",
)
_THUMB_FALLBACK_DIRS = ("Metadata/", "Auxiliaries/.thumbnails/")
_THUMB_EXTS = (".png", ".jpg", ".jpeg", ".webp")


def _parse_metadata(model_xml: str) -> Dict[str, str]:
    """Extract {name: value} from `<metadata name="…">value</metadata>`."""
    out: Dict[str, str] = {}
    pattern = re.compile(r'<metadata(?:\s+[^>]*?name\s*=\s*"([^"]*)"[^>]*|\s+name="([^"]*)"[^>]*)>(.*?)</metadata>', re.S)
    for name1, name2, value in pattern.findall(model_xml):
        name = (name1 or name2 or "").strip()
        if name:
            out[name] = value
    return out


def _decode_html(value: str) -> str:
    """Decode (possibly repeatedly-escaped) HTML entities and strip tags → plain text."""
    text = html.unescape(value)
    # Slicers sometimes double/triple-encode entities; loop until stable.
    prev = None
    while prev != text:
        prev = text
        text = html.unescape(text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def extract_3mf_metadata(path: Path | str) -> Dict[str, Any]:
    """Return MakerVault asset fields derived from a .3MF file.

    Keys produced (all optional): `title`, `notes`, `thumbnail_bytes`.
    """
    result: Dict[str, Any] = {}
    model_xml: Optional[str] = None

    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        if "3D/3dmodel.model" in names:
            model_xml = zf.read("3D/3dmodel.model").decode("utf-8", "replace")

        if model_xml:
            metas = _parse_metadata(model_xml)
            title = _first_nonempty(metas.get(k, "") for k in TITLE_KEYS)
            if title:
                result["title"] = _decode_html(title)

            notes: List[str] = []
            for key in NOTES_KEYS:
                value = metas.get(key)
                if value:
                    notes.append(_decode_html(value))
            # Origin: designer + license describe where the object came from.
            origin: List[str] = []
            for key in ORIGIN_KEYS:
                value = metas.get(key)
                if value and value.strip():
                    origin.append(f"{key}: {value.strip()}")
            if origin:
                notes.append(" | ".join(origin))
            if notes:
                result["notes"] = "\n".join(n for n in notes if n)

        thumb = _find_thumbnail(zf, names, model_xml)
        if thumb:
            result["thumbnail_bytes"] = thumb

    return result


def _first_nonempty(values):
    for value in values:
        if value and value.strip():
            return value
    return None


def _find_thumbnail(zf: zipfile.ZipFile, names: List[str], model_xml: Optional[str]) -> Optional[bytes]:
    """Return the best embedded thumbnail image, or None."""
    candidates: List[str] = []

    # 1. Explicit Thumbnail_* metadata path, e.g. "/Metadata/plate_1.png".
    if model_xml:
        metas = _parse_metadata(model_xml)
        for key in ("Thumbnail_Middle", "Thumbnail_Small", "Thumbnail_Large", "Thumbnail"):
            target = metas.get(key)
            if target:
                cleaned = target.strip().lstrip("/")
                if cleaned in names:
                    candidates.append(cleaned)

    # 2. Known explicit paths.
    for p in _THUMB_PATHS:
        if p in names and p not in candidates:
            candidates.append(p)

    # 3. Fallback: any image under the thumbnail-ish dirs, prefer middle-sized.
    fallback: List[tuple[str, int]] = []
    for name in names:
        lowered = name.lower()
        if not lowered.endswith(_THUMB_EXTS):
            continue
        if name.startswith(_THUMB_FALLBACK_DIRS):
            # Prefer a "middle" or "large" variant over "small".
            score = 2 if "middle" in lowered or "large" in lowered else (1 if "small" not in lowered else 0)
            fallback.append((name, score))
    fallback.sort(key=lambda x: x[0].lower())
    for name, _ in sorted(fallback, key=lambda x: -x[1]):
        if name not in candidates:
            candidates.append(name)

    for name in candidates:
        try:
            data = zf.read(name)
            if data and _looks_like_image(data):
                return data
        except (KeyError, zipfile.BadZipFile):
            continue
    return None


def _looks_like_image(data: bytes) -> bool:
    head = data[:12]
    return head[:3] in (b"\xff\xd8\xff",) or head.startswith(b"\x89PNG") or head.startswith(b"RIFF") or head.startswith(b"\x47\x49\x46")
