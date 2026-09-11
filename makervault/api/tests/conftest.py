"""Shared pytest fixtures for the MakerVault API test suite.

Strategy: use a single per-session SQLite database and storage directory so
the api modules can be imported exactly once (env vars are read at import time
and SQLModel.metadata is a global). Each test gets a clean DB state via
table truncation in the `client` and `db` fixtures.

NOTE: env vars must be set BEFORE the first api module import. The
session_workspace fixture therefore runs eagerly at collection time
(autouse, session scope).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Iterator

import pytest


def pytest_configure(config):
    """Set env vars BEFORE any api module is imported (runs at collection
    time, before test module imports). DB/storage live in a fresh temp dir so
    tests never touch the repo-local ./storage (a root-owned Docker volume
    leftover) or ./app.db.
    """
    os.environ.setdefault("AUTH_USERNAME", "tester")
    os.environ.setdefault("AUTH_PASSWORD", "secret")
    os.environ.setdefault("AUTH_SECRET", "test-secret-do-not-use-in-prod")
    os.environ.setdefault("AUTH_TOKEN_TTL", "3600")
    os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")
    if not os.environ.get("MV_TEST_WORKSPACE"):
        import tempfile
        workspace = tempfile.mkdtemp(prefix="mv-api-tests-")
        os.environ["MV_TEST_WORKSPACE"] = workspace
        os.environ["DB_URL"] = f"sqlite:///{workspace}/test.db"
        os.environ["FILE_STORAGE"] = os.path.join(workspace, "storage")
    else:
        os.environ["DB_URL"] = f"sqlite:///{os.environ['MV_TEST_WORKSPACE']}/test.db"
        os.environ["FILE_STORAGE"] = os.path.join(os.environ["MV_TEST_WORKSPACE"], "storage")
    os.environ.setdefault("IMPORT_MOUNT_PATH", "")
    os.environ.setdefault("IMPORT_MOUNT_ON_STARTUP", "false")


@pytest.fixture(scope="session", autouse=True)
def session_workspace(tmp_path_factory) -> Iterator[dict]:
    """Session-scoped workspace: one DB and storage dir for the whole test run.

    Uses the temp dir chosen in pytest_configure (NOT the repo-local
    ./storage / ./app.db defaults, which may be root-owned Docker leftovers).
    The storage directory was NOT created here before api modules imported —
    db.py itself does STORAGE.mkdir/THUMBS.mkdir on import.
    """
    workspace = os.environ["MV_TEST_WORKSPACE"]
    base = Path(workspace)
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

    # Purge cached api modules (e.g. imported by collection-time module code)
    import sys
    for name in list(sys.modules):
        if name.split(".")[0] in {
            "config", "auth", "db", "models", "schemas",
            "settings_service", "file_utils", "asset_service",
            "import_service", "mount_import", "folder_service", "main",
            "ai_tagging", "thumb_3d", "zip_service", "url_utils",
            "import_resolvers",
        }:
            sys.modules.pop(name, None)
    from sqlmodel import SQLModel
    SQLModel.metadata.clear()

    import main as main_module

    SQLModel.metadata.create_all(main_module.engine)
    main_module.ensure_folder_parent_column()
    main_module.ensure_asset_source_path_column()
    main_module.ensure_asset_indexes()

    yield {"base": base, "db": db_path, "storage": storage, "thumbs": thumbs}


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
def temp_workspace(session_workspace: dict) -> dict:
    """Alias retained for tests that referenced the old per-test workspace.

    The suite now uses a single session-scoped DB/storage (env vars must be
    set before module import), so 'temp_workspace' simply hands out the shared
    workspace. Test isolation is handled by the client/app fixtures, which
    truncate tables before and after every test.
    """
    return session_workspace


@pytest.fixture()
def app(session_workspace: dict):
    """FastAPI app on the shared session workspace, isolated per test.

    Truncates all tables before and after each test so a test that writes
    settings/rows never leaks state into another test (this replaces the old
    per-test temp_workspace fresh-DB behaviour).
    """
    import main as main_module
    main_module.ensure_folder_parent_column()
    main_module.ensure_asset_source_path_column()
    main_module.ensure_asset_indexes()
    _truncate_all_tables()
    yield main_module.app
    _truncate_all_tables()


@pytest.fixture()
def client(session_workspace: dict):
    """Synchronous FastAPI test client on the shared session workspace."""
    import main as main_module
    from fastapi.testclient import TestClient

    _truncate_all_tables()
    with TestClient(main_module.app) as c:
        yield c
    _truncate_all_tables()


@pytest.fixture()
def auth_token(session_workspace: dict) -> str:
    from auth import create_token

    return create_token("tester")


@pytest.fixture()
def auth_headers(auth_token: str) -> dict:
    return {"Authorization": f"Bearer {auth_token}"}