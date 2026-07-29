"""Tests for api/url_utils.py — SSRF guard and URL validation."""
import pytest
from fastapi import HTTPException

from url_utils import (
    is_blocked_ip,
    normalize_import_url,
    validate_remote_host,
    validate_remote_url,
)


class TestIsBlockedIp:
    def test_loopback_v4_is_blocked(self):
        import ipaddress
        assert is_blocked_ip(ipaddress.ip_address("127.0.0.1")) is True

    def test_loopback_v6_is_blocked(self):
        import ipaddress
        assert is_blocked_ip(ipaddress.ip_address("::1")) is True

    def test_private_rfc1918_is_blocked(self):
        import ipaddress
        assert is_blocked_ip(ipaddress.ip_address("10.0.0.1")) is True
        assert is_blocked_ip(ipaddress.ip_address("192.168.1.1")) is True
        assert is_blocked_ip(ipaddress.ip_address("172.16.0.1")) is True

    def test_link_local_is_blocked(self):
        import ipaddress
        assert is_blocked_ip(ipaddress.ip_address("169.254.169.254")) is True

    def test_public_ip_is_allowed(self):
        import ipaddress
        assert is_blocked_ip(ipaddress.ip_address("8.8.8.8")) is False
        assert is_blocked_ip(ipaddress.ip_address("1.1.1.1")) is False


class TestValidateRemoteHost:
    def test_localhost_is_blocked(self):
        with pytest.raises(HTTPException) as exc:
            validate_remote_host("localhost")
        assert exc.value.status_code == 400
        assert "Local addresses" in exc.value.detail

    def test_dot_local_suffix_is_blocked(self):
        with pytest.raises(HTTPException):
            validate_remote_host("server.local")

    def test_empty_host_is_blocked(self):
        with pytest.raises(HTTPException):
            validate_remote_host("")

    def test_public_hostname_passes(self):
        # This should not raise
        validate_remote_host("example.com")

    def test_ip_literal_loopback_is_blocked(self):
        with pytest.raises(HTTPException):
            validate_remote_host("127.0.0.1")

    def test_ip_literal_private_is_blocked(self):
        with pytest.raises(HTTPException):
            validate_remote_host("192.168.1.1")


class TestValidateRemoteUrl:
    def test_http_scheme_allowed(self):
        assert validate_remote_url("http://example.com/path") == "http://example.com/path"

    def test_https_scheme_allowed(self):
        assert validate_remote_url("https://example.com/path") == "https://example.com/path"

    def test_ftp_scheme_blocked(self):
        with pytest.raises(HTTPException):
            validate_remote_url("ftp://example.com/path")

    def test_file_scheme_blocked(self):
        with pytest.raises(HTTPException):
            validate_remote_url("file:///etc/passwd")

    def test_url_with_credentials_blocked(self):
        with pytest.raises(HTTPException):
            validate_remote_url("https://user:pass@example.com/")

    def test_url_without_hostname_blocked(self):
        with pytest.raises(HTTPException):
            validate_remote_url("https:///path")


class TestNormalizeImportUrl:
    def test_prepends_https_when_no_scheme(self):
        assert normalize_import_url("example.com/file.stl") == "https://example.com/file.stl"

    def test_strips_whitespace(self):
        assert normalize_import_url("  https://example.com/file.stl  ") == "https://example.com/file.stl"

    def test_empty_raises(self):
        with pytest.raises(HTTPException):
            normalize_import_url("")

    def test_localhost_is_blocked_after_normalize(self):
        with pytest.raises(HTTPException):
            normalize_import_url("localhost")
