"""Tests for api/settings_service.py — key/value AppConfig persistence."""
from sqlmodel import Session

from settings_service import (
    get_bool_setting,
    get_mount_import_copy,
    get_mount_import_enabled,
    get_setting,
    set_bool_setting,
    set_mount_import_copy,
    set_mount_import_enabled,
    set_setting,
)


class TestSettingRoundTrip:
    def test_get_returns_none_for_missing_key(self, app):
        assert get_setting("missing.key") is None

    def test_set_then_get_returns_value(self, app):
        set_setting("test.key", "hello")
        assert get_setting("test.key") == "hello"

    def test_set_overwrites_existing(self, app):
        set_setting("test.key", "first")
        set_setting("test.key", "second")
        assert get_setting("test.key") == "second"


class TestBoolSetting:
    def test_default_returned_when_missing(self, app):
        assert get_bool_setting("missing.bool", default=True) is True
        assert get_bool_setting("missing.bool", default=False) is False

    def test_truthy_values(self, app):
        for value in ("1", "true", "yes", "y", "on", "TRUE", "Yes"):
            set_setting("test.bool", value)
            assert get_bool_setting("test.bool", default=False) is True

    def test_falsy_values(self, app):
        for value in ("0", "false", "no", "n", "off", ""):
            set_setting("test.bool", value)
            assert get_bool_setting("test.bool", default=True) is False

    def test_unrecognized_defaults(self, app):
        set_setting("test.bool", "garbage")
        assert get_bool_setting("test.bool", default=True) is True
        assert get_bool_setting("test.bool", default=False) is False


class TestMountImportDefaults:
    def test_mount_enabled_default(self, app):
        # No DB record yet → uses default arg
        assert get_mount_import_enabled(True) is True
        assert get_mount_import_enabled(False) is False

    def test_mount_copy_default(self, app):
        assert get_mount_import_copy(True) is True
        assert get_mount_import_copy(False) is False

    def test_persistence(self, app):
        set_mount_import_enabled(True)
        set_mount_import_copy(False)
        assert get_mount_import_enabled(False) is True
        assert get_mount_import_copy(True) is False
