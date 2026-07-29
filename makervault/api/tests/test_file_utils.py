"""Tests for api/file_utils.py — filename sanitization and MIME helpers."""
import pytest
from fastapi import HTTPException

from file_utils import (
    build_import_filename,
    is_html_content_type,
    is_json_content_type,
    mime_from_content_type,
    parse_content_disposition,
    sanitize_filename,
)
import config


class TestSanitizeFilename:
    def test_strips_null_bytes(self):
        assert sanitize_filename("foo\x00bar.stl") == "foobar.stl"

    def test_replaces_slashes_with_underscore(self):
        assert sanitize_filename("foo/bar.stl") == "foo_bar.stl"
        assert sanitize_filename("foo\\bar.stl") == "foo_bar.stl"

    def test_strips_directory_traversal(self):
        # os.path.basename strips the path, leaving only the final segment
        result = sanitize_filename("../../../etc/passwd")
        assert "/" not in result
        assert "\\" not in result

    def test_empty_falls_back_to_imported_file(self):
        assert sanitize_filename("") == "imported-file"
        assert sanitize_filename("   ") == "imported-file"

    def test_strips_whitespace(self):
        assert sanitize_filename("  foo.stl  ") == "foo.stl"


class TestParseContentDisposition:
    def test_filename_star_with_encoding(self):
        cd = "attachment; filename*=UTF-8''my%20file.stl"
        assert parse_content_disposition(cd) == "my file.stl"

    def test_simple_filename(self):
        cd = "attachment; filename=\"model.stl\""
        assert parse_content_disposition(cd) == "model.stl"

    def test_filename_without_quotes(self):
        cd = "attachment; filename=model.stl"
        assert parse_content_disposition(cd) == "model.stl"

    def test_empty_returns_none(self):
        assert parse_content_disposition("") is None
        assert parse_content_disposition(None) is None


class TestBuildImportFilename:
    def test_uses_override_when_provided(self):
        headers = {"Content-Type": "application/octet-stream"}
        assert build_import_filename("http://x/y.stl", headers, "custom.3mf") == "custom.3mf"

    def test_uses_content_disposition(self):
        headers = {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": "attachment; filename=\"server.stl\"",
        }
        assert build_import_filename("http://x/y.stl", headers, None) == "server.stl"

    def test_uses_url_path_when_no_override_or_header(self):
        headers = {"Content-Type": "application/octet-stream"}
        assert build_import_filename("http://x/path/model.stl", headers, None) == "model.stl"

    def test_falls_back_to_url_extension_when_no_filename(self):
        headers = {"Content-Type": "application/octet-stream"}
        result = build_import_filename("http://x/download?token=abc", headers, None)
        assert result.endswith(".stl")

    def test_raises_on_unsupported_extension(self):
        headers = {"Content-Type": "application/octet-stream"}
        with pytest.raises(HTTPException) as exc:
            build_import_filename("http://x/file.exe", headers, None)
        assert exc.value.status_code == 415

    def test_raises_when_no_extension_can_be_determined(self):
        headers = {"Content-Type": "application/octet-stream"}
        with pytest.raises(HTTPException) as exc:
            build_import_filename("not-a-url", headers, None)
        assert exc.value.status_code == 415

    def test_accepts_all_whitelisted_extensions(self):
        headers = {"Content-Type": "application/octet-stream"}
        for ext in config.IMPORT_ALLOWED_EXTS:
            result = build_import_filename(f"http://x/file{ext}", headers, None)
            assert result.endswith(ext)


class TestMimeFromContentType:
    def test_uses_provided_content_type(self):
        assert mime_from_content_type("model/stl", "x.stl") == "model/stl"

    def test_strips_parameters(self):
        assert mime_from_content_type("model/stl; charset=utf-8", "x.stl") == "model/stl"

    def test_falls_back_to_filename_guess(self):
        assert mime_from_content_type("application/octet-stream", "x.png") == "image/png"

    def test_octet_stream_with_unknown_extension(self):
        assert mime_from_content_type("application/octet-stream", "x.weird") == "application/octet-stream"


class TestContentTypePredicates:
    def test_html_detection(self):
        assert is_html_content_type("text/html") is True
        assert is_html_content_type("application/xhtml+xml") is True
        assert is_html_content_type("text/html; charset=utf-8") is True
        assert is_html_content_type("application/json") is False

    def test_json_detection(self):
        assert is_json_content_type("application/json") is True
        assert is_json_content_type("application/ld+json") is True
        assert is_json_content_type("text/json") is True
        assert is_json_content_type("text/html") is False
