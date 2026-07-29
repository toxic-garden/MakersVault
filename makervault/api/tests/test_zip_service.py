"""Tests for api/zip_service.py — zip entry path normalization and folder resolution."""
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlmodel import Session

from zip_service import normalize_zip_entry_path, resolve_zip_folder_id
from models import Folder


class TestNormalizeZipEntryPath:
    def test_strips_leading_slash(self):
        assert normalize_zip_entry_path("/foo/bar.stl") == "foo/bar.stl"

    def test_replaces_backslashes(self):
        assert normalize_zip_entry_path("foo\\bar.stl") == "foo/bar.stl"

    def test_rejects_empty(self):
        assert normalize_zip_entry_path("") is None
        assert normalize_zip_entry_path(None) is None

    def test_rejects_directory_traversal(self):
        assert normalize_zip_entry_path("../foo.stl") is None
        assert normalize_zip_entry_path("foo/../bar.stl") is None
        assert normalize_zip_entry_path("foo/../../etc/passwd") is None

    def test_rejects_dot_only_segments(self):
        assert normalize_zip_entry_path("./foo.stl") == "foo.stl"
        assert normalize_zip_entry_path("foo/./bar.stl") == "foo/bar.stl"

    def test_rejects_directory_entries(self):
        assert normalize_zip_entry_path("foo/") is None

    def test_keeps_nested_paths(self):
        assert normalize_zip_entry_path("a/b/c.stl") == "a/b/c.stl"


class TestListZipEntries:
    def test_real_zip_lists_entries(self, tmp_path: Path):
        from zip_service import list_zip_entries
        zip_path = tmp_path / "test.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("a.stl", b"x" * 10)
            zf.writestr("subdir/b.stl", b"y" * 20)
        entries = list_zip_entries(zip_path)
        paths = sorted(e["path"] for e in entries)
        assert paths == ["a.stl", "subdir/b.stl"]

    def test_skips_traversal_entries(self, tmp_path: Path):
        from zip_service import list_zip_entries
        zip_path = tmp_path / "test.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("../evil.stl", b"x")
            zf.writestr("safe.stl", b"y")
        entries = list_zip_entries(zip_path)
        paths = [e["path"] for e in entries]
        assert "../evil.stl" not in paths
        assert "safe.stl" in paths


class TestResolveZipFolderId:
    def test_no_segments_returns_base(self, app):
        from db import engine
        with Session(engine) as s:
            assert resolve_zip_folder_id(s, None, "file.stl", {}) is None

    def test_creates_single_folder(self, app):
        from db import engine
        with Session(engine) as s:
            folder_id = resolve_zip_folder_id(s, None, "subdir/file.stl", {})
            assert folder_id is not None
            folder = s.get(Folder, folder_id)
            assert folder is not None
            assert folder.name == "subdir"
            assert folder.parent_id is None

    def test_creates_nested_folders(self, app):
        from db import engine
        with Session(engine) as s:
            folder_id = resolve_zip_folder_id(s, None, "a/b/c/file.stl", {})
            folder = s.get(Folder, folder_id)
            assert folder.name == "c"
            parent = s.get(Folder, folder.parent_id)
            assert parent.name == "b"
            grandparent = s.get(Folder, parent.parent_id)
            assert grandparent.name == "a"

    def test_reuses_existing_folders(self, app):
        from db import engine
        with Session(engine) as s:
            cache: dict = {}
            first = resolve_zip_folder_id(s, None, "x/y/file1.stl", cache)
            second = resolve_zip_folder_id(s, None, "x/y/file2.stl", cache)
            # Same folder should be returned, not a new one
            assert first == second
            # And only two folders should exist in the DB
            folders = s.exec(__import__("sqlmodel").select(Folder)).all()
            assert len(folders) == 2

    def test_respects_base_folder(self, app):
        from db import engine
        from models import Folder
        with Session(engine) as s:
            base = Folder(name="base", tags_json="[]", parent_id=None)
            s.add(base)
            s.commit()
            s.refresh(base)
            result = resolve_zip_folder_id(s, base.id, "sub/file.stl", {})
            assert result is not None
            sub = s.get(Folder, result)
            assert sub.parent_id == base.id
