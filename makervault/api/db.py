import os
from pathlib import Path
from sqlmodel import create_engine

DB_URL = os.getenv("DB_URL", "sqlite:///./app.db")
STORAGE = Path(os.getenv("FILE_STORAGE", "./storage"))
STORAGE.mkdir(parents=True, exist_ok=True)
THUMBS = STORAGE / "thumbs"
THUMBS.mkdir(parents=True, exist_ok=True)

engine = create_engine(DB_URL, connect_args={"check_same_thread": False})


def ensure_folder_parent_column() -> None:
  """Lightweight migration for existing SQLite DBs to support nested folders."""
  with engine.connect() as conn:
    cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(folder);").fetchall()]
    # If the table doesn't exist yet, defer to metadata.create_all on startup.
    if not cols:
      return
    if "parent_id" not in cols:
      conn.exec_driver_sql("ALTER TABLE folder ADD COLUMN parent_id TEXT")


def ensure_asset_source_path_column() -> None:
  """Lightweight migration for mount import tracking."""
  with engine.connect() as conn:
    cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(asset);").fetchall()]
    if not cols:
      return
    if "source_path" not in cols:
      conn.exec_driver_sql("ALTER TABLE asset ADD COLUMN source_path TEXT")


def ensure_asset_source_url_column() -> None:
  """Lightweight migration for the asset object-source URL field."""
  with engine.connect() as conn:
    cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(asset);").fetchall()]
    if not cols:
      return
    if "source_url" not in cols:
      conn.exec_driver_sql("ALTER TABLE asset ADD COLUMN source_url TEXT")


def ensure_asset_indexes() -> None:
  """Create indexes that keep large asset libraries responsive."""
  with engine.connect() as conn:
    conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_asset_filename ON asset(filename)")
    conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_asset_folder_id ON asset(folder_id)")
    conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_asset_size ON asset(size)")
