"""Shared pytest fixtures for the MakerVault API test suite.

Strategy: use a single per-session SQLite database and storage directory so
the api modules can be imported exactly once (env vars are read at import time
and SQLModel.metadata is a global). Each test gets a clean DB state via
table truncation in the `client` and `db` fixtures.
"""
from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path
from typing import Iterator

import pytest


def pytest_configure(config):
    """Set env vars BEFORE any api module is imported so module-level
    singletons pick them up.
    """
    os.environ.setdefault("AUTH_USERNAME", "tester")
    os.environ.setdefault("AUTH_PASSWORD", "secret")
    os.environ.setdefault("AUTH_SECRET", "test-secret-do-not-use-in-prod")
    os.environ.setdefault("AUTH_TOKEN_TTL", "3600")
    os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")


@pytest.fixture(scope="session")
def session_workspace(tmp_path_factory) -> dict:
    """Session-scoped workspace: one DB and storage dir for the whole test run."""
    base = tmp_path_factory.mktemp("api-tests")
    db_path = base / "test.db"
    storage = base / "storage"
    thumbs = storage / "thumbs"
    storage.mkdir(parents=True, exist_ok=True)
    thumbs.mkdir(parents=True, exist_ok=True)

    # Set env vars before the first import of any api module
    os.environ["DB_URL"] = f"sqlite:///{db_path}"
    os.environ["FILE_STORAGE"] = str(storage)
    os.environ["IMPORT_MOUNT_PATH"] = ""
    os.environ["IMPORT_MOUNT_ON_STARTUP"] = "false"

    return {"base": base, "db": db_path, "storage": storage, "thumbs": thumbs}


@pytest.fixture(scope="session", autouse=True)
def _import_api_once(session_workspace):
    """Import api modules once after env is set; create tables once."""
    import main as main_module
    from sqlmodel import SQLModel

    SQLModel.metadata.create_all(main_module.engine)
    main_module.ensure_folder_parent_column()
    main_module.ensure_asset_source_path_column()
    main_module.ensure_asset_indexes()

    yield


def _truncate_all_tables() -> None:
    """Delete all rows from every table to isolate tests."""
    from sqlmodel import Session
    from db import engine
    from sqlmodel.sql.expression import select
    from models import Asset, Folder, AppConfig

    with Session(engine) as s:
        for model in (Asset, Folder, AppConfig):
            for row in s.exec(select(model)).all():
                s.delete(row)
        s.commit()


@pytest.fixture()
def clean_db(session_workspace):
    """Truncate tables before each test that needs isolation."""
    _truncate_all_tables()
    yield session_workspace
    _truncate_all_tables()


@pytest.fixture()
def temp_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[dict]:
    """Per-test workspace: fresh DB and storage.

    Reloads api modules to pick up the new env vars. SQLModel.metadata is
    cleared before re-importing so tables can be re-registered cleanly.
    """
    db_path = tmp_path / "test.db"
    storage = tmp_path / "storage"
    thumbs = storage / "thumbs"
    storage.mkdir(parents=True, exist_ok=True)
    thumbs.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("DB_URL", f"sqlite:///{db_path}")
    monkeypatch.setenv("FILE_STORAGE", str(storage))
    monkeypatch.setenv("AUTH_USERNAME", "tester")
    monkeypatch.setenv("AUTH_PASSWORD", "secret")
    monkeypatch.setenv("AUTH_SECRET", "test-secret-do-not-use-in-prod")
    monkeypatch.setenv("AUTH_TOKEN_TTL", "3600")
    monkeypatch.setenv("IMPORT_MOUNT_PATH", "")
    monkeypatch.setenv("IMPORT_MOUNT_ON_STARTUP", "false")
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173")

    # Purge cached api modules and reset metadata before re-importing
    from sqlmodel import SQLModel
    SQLModel.metadata.clear()
    for name in list(sys.modules):
        if name in {
            "config", "auth", "db", "models", "schemas",
            "settings_service", "file_utils", "asset_service",
            "import_service", "mount_import", "folder_service", "main",
        }:
            sys.modules.pop(name, None)
    import main as main_module
    SQLModel.metadata.create_all(main_module.engine)

    yield {
        "tmp": tmp_path,
        "db": db_path,
        "storage": storage,
        "thumbs": thumbs,
    }


@pytest.fixture()
def app(temp_workspace: dict):
    """FastAPI app with tables created (temp_workspace already did this)."""
    import main as main_module
    main_module.ensure_folder_parent_column()
    main_module.ensure_asset_source_path_column()
    main_module.ensure_asset_indexes()
    return main_module.app


@pytest.fixture()
def client(temp_workspace: dict):
    """Synchronous FastAPI test client with fresh DB per test."""
    import main as main_module
    from fastapi.testclient import TestClient

    with TestClient(main_module.app) as c:
        yield c


@pytest.fixture()
def auth_token(temp_workspace: dict) -> str:
    from auth import create_token

    return create_token("tester")


@pytest.fixture()
def auth_headers(auth_token: str) -> dict:
    return {"Authorization": f"Bearer {auth_token}"}
