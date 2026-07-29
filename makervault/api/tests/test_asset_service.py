"""Tests for api/asset_service.py — two-step asset creation and lifecycle."""
import io

import pytest
from fastapi import HTTPException

from asset_service import (
    asset_dir,
    asset_path,
    cleanup_asset,
    create_asset_record,
    finalize_asset_record,
    save_thumb,
    stream_response_to_file,
)


class _FakeResp:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self.headers = {}

    def read(self, n):
        if not self._chunks:
            return b""
        chunk = self._chunks.pop(0)
        return chunk[:n]


class TestCreateAssetRecord:
    def test_inserts_with_size_zero(self, app):
        asset = create_asset_record("test.stl", "model/stl", "Title", "Notes", ["a", "b"], None)
        assert asset.id
        assert asset.filename == "test.stl"
        assert asset.mime == "model/stl"
        assert asset.size == 0
        assert asset.title == "Title"
        assert asset.notes == "Notes"
        assert asset.tags_json == '["a", "b"]'

    def test_strips_and_skips_empty_tags(self, app):
        asset = create_asset_record("x.stl", "model/stl", None, None, [" a ", "", "  ", "b"], None)
        import json
        assert json.loads(asset.tags_json) == ["a", "b"]


class TestFinalizeAssetRecord:
    def test_patches_size(self, app):
        asset = create_asset_record("x.stl", "model/stl", None, None, [], None)
        finalized = finalize_asset_record(asset.id, 12345, "model/stl")
        assert finalized.size == 12345
        assert finalized.mime == "model/stl"

    def test_keeps_existing_mime_when_not_provided(self, app):
        asset = create_asset_record("x.stl", "model/stl", None, None, [], None)
        finalized = finalize_asset_record(asset.id, 100, None)
        assert finalized.mime == "model/stl"

    def test_returns_none_for_unknown_id(self, app):
        assert finalize_asset_record("nonexistent", 100) is None


class TestStreamResponseToFile:
    def test_writes_file_and_returns_size(self, app, tmp_path):
        dest = tmp_path / "out.bin"
        resp = _FakeResp([b"hello ", b"world"])
        size = stream_response_to_file(resp, dest)
        assert size == 11
        assert dest.read_bytes() == b"hello world"

    def test_raises_on_oversize(self, app, tmp_path, monkeypatch):
        # Override the import-time limit reference
        from asset_service import IMPORT_MAX_BYTES
        # Use a very small limit via patching
        monkeypatch.setattr("asset_service.IMPORT_MAX_BYTES", 5)
        dest = tmp_path / "out.bin"
        resp = _FakeResp([b"hello world"])
        with pytest.raises(HTTPException) as exc:
            stream_response_to_file(resp, dest)
        assert exc.value.status_code == 413
        # File should be closed but data may exist; cleanup_asset is caller's job


class TestCleanupAsset:
    def test_removes_db_row_and_files(self, app, tmp_path):
        asset = create_asset_record("x.stl", "model/stl", None, None, [], None)
        # Create the storage directory and a file inside it
        d = asset_dir(asset.id)
        f = asset_path(asset.id, asset.filename)
        f.write_bytes(b"content")
        # Create a thumb
        from db import THUMBS
        THUMBS.mkdir(parents=True, exist_ok=True)
        thumb = THUMBS / f"{asset.id}.jpg"
        thumb.write_bytes(b"thumbdata")

        cleanup_asset(asset.id)

        # Verify DB row removed
        from db import engine
        from sqlmodel import Session, select
        from models import Asset
        with Session(engine) as s:
            assert s.get(Asset, asset.id) is None
        # Verify files removed
        assert not d.exists() or not any(d.iterdir())
        assert not thumb.exists()

    def test_handles_missing_files_gracefully(self, app):
        asset = create_asset_record("x.stl", "model/stl", None, None, [], None)
        # No files created; cleanup should not raise
        cleanup_asset(asset.id)
        from db import engine
        from sqlmodel import Session
        from models import Asset
        with Session(engine) as s:
            assert s.get(Asset, asset.id) is None
