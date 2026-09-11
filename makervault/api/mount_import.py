import os
import re
import shutil
from pathlib import Path
from typing import Any, Dict, Optional

from sqlmodel import Session, select

from asset_service import (
    asset_path,
    cleanup_asset,
    create_asset_record,
    finalize_asset_record,
    save_thumb,
    apply_3mf_metadata,
)
from ai_tagging import maybe_autotag_asset
from config import (
    DEFAULT_MOUNT_IMPORT_EXTS,
    IMPORT_MAX_BYTES,
    MOUNT_IMPORT_EXTS_RAW,
    MOUNT_IMPORT_INCLUDE_HIDDEN,
    MOUNT_IMPORT_COPY,
)
from db import STORAGE, engine
from file_utils import guess_mime_from_path, sanitize_filename
from models import Asset, Folder
from settings_service import get_mount_import_copy
from zip_service import resolve_zip_folder_id


def parse_mount_import_exts(raw: str) -> Optional[set]:
    if not raw:
        return set(DEFAULT_MOUNT_IMPORT_EXTS)
    lowered = raw.strip().lower()
    if lowered == "*":
        return None
    parts = re.split(r"[,\s]+", lowered)
    exts = set()
    for part in parts:
        if not part:
            continue
        ext = part if part.startswith(".") else f".{part}"
        exts.add(ext)
    return exts or set(DEFAULT_MOUNT_IMPORT_EXTS)


def should_skip_mount_entry(name: str) -> bool:
    return not MOUNT_IMPORT_INCLUDE_HIDDEN and name.startswith(".")


def scan_mount_imports(prune_missing: bool = False) -> Dict[str, Any]:
    """Scan the mount path and index new files.

    With `prune_missing=True`, mount-imported assets whose source file has
    disappeared are removed from the library (DB row + files). Pruning is
    skipped entirely when the mount looks unavailable (missing/unreadable),
    so a transient network-filesystem hiccup cannot wipe the library.

    Note: the mount path is read via the config module at RUNTIME (not from a
    module-level binding) so tests can point it at a temp dir by patching
    `config.MOUNT_IMPORT_PATH`.
    """
    import config as _config

    root_raw = _config.MOUNT_IMPORT_PATH
    if not root_raw:
        return {"imported": 0, "skipped": 0, "failed": 0, "pruned": 0, "reason": "not_configured"}
    root = Path(root_raw)
    if not root.exists() or not root.is_dir():
        print(f"[mount-import] Skipping: mount path not found: {root_raw}")
        return {"imported": 0, "skipped": 0, "failed": 0, "pruned": 0, "reason": "mount_not_found"}

    allowed_exts = parse_mount_import_exts(MOUNT_IMPORT_EXTS_RAW)
    copy_files = get_mount_import_copy(MOUNT_IMPORT_COPY)
    root_abs = root.resolve()
    root_prefix = root_abs.as_posix().rstrip("/")
    storage_abs = STORAGE.resolve()
    skip_storage_dirs = root_abs == storage_abs
    imported = 0
    skipped = 0
    failed = 0
    pruned = 0

    print(f"[mount-import] Scanning {root_abs}...")
    with Session(engine) as session:
        existing_sources: set = set()
        if root_prefix:
            existing_sources = set(
                session.exec(
                    select(Asset.source_path).where(Asset.source_path.like(f"{root_prefix}/%"))
                ).all()
            )
        else:
            existing_sources = set(
                session.exec(
                    select(Asset.source_path).where(Asset.source_path.is_not(None))
                ).all()
            )
        asset_ids = set()
        if skip_storage_dirs:
            asset_ids = set(session.exec(select(Asset.id)).all())

        folder_cache: dict = {}
        seen_paths: set = set()
        for dirpath, dirnames, filenames in os.walk(root_abs):
            rel_dir = Path(dirpath).relative_to(root_abs)
            dirnames[:] = [d for d in dirnames if not should_skip_mount_entry(d)]
            if skip_storage_dirs:
                dirnames[:] = [d for d in dirnames if d != "thumbs" and d not in asset_ids]

            for filename in filenames:
                if should_skip_mount_entry(filename):
                    continue
                path = Path(dirpath) / filename
                if not path.is_file():
                    continue
                ext = path.suffix.lower()
                if allowed_exts is not None and ext not in allowed_exts:
                    continue

                rel_path = (rel_dir / filename).as_posix() if rel_dir != Path(".") else filename
                source_path = (root_abs / rel_path).as_posix()
                seen_paths.add(source_path)
                if source_path in existing_sources:
                    skipped += 1
                    continue
                try:
                    size = path.stat().st_size
                except OSError:
                    failed += 1
                    continue
                if size > IMPORT_MAX_BYTES:
                    failed += 1
                    continue

                folder_id = resolve_zip_folder_id(session, None, rel_path, folder_cache)
                safe_name = sanitize_filename(filename)
                mime = guess_mime_from_path(path)
                asset = create_asset_record(
                    safe_name,
                    mime,
                    None,
                    None,
                    [],
                    folder_id,
                    source_path=source_path,
                )
                try:
                    if copy_files:
                        dest = asset_path(asset.id, asset.filename)
                        shutil.copyfile(path, dest)
                        if (mime or "").startswith("image/") and dest.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
                            save_thumb(asset.id, dest)
                    else:
                        if (mime or "").startswith("image/") and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
                            save_thumb(asset.id, path)
                    finalize_asset_record(asset.id, size, mime)
                    if path.suffix.lower() == ".3mf":
                        apply_3mf_metadata(asset.id, path)
                    maybe_autotag_asset(asset.id, asset.filename)
                    imported += 1
                    existing_sources.add(source_path)
                except Exception:
                    cleanup_asset(asset.id)
                    failed += 1

        # Prune mount-imported assets whose source file has vanished.
        if prune_missing:
            prunable = list(
                session.exec(
                    select(Asset).where(Asset.source_path.like(f"{root_prefix}/%"))
                ).all()
            )
            # Collect the mount's folder chains BEFORE pruning — once the
            # assets are gone we can no longer tell which folders the mount
            # created (user folders must not be touched afterwards).
            mount_folder_ids = _collect_mount_folder_ids(session, prunable)
            for asset in prunable:
                source = Path(asset.source_path or "")
                if asset.source_path in seen_paths:
                    continue
                # Double-check on disk before deleting (file could exist but be
                # filtered out by extension changes etc.).
                if source.exists():
                    continue
                cleanup_asset(asset.id)
                pruned += 1

            pruned_folders = _prune_empty_folders(session, mount_folder_ids)
        else:
            pruned_folders = 0

    print(f"[mount-import] Done. Imported {imported}, skipped {skipped}, failed {failed}, "
          f"pruned {pruned} assets, {pruned_folders} folders.")
    return {
        "imported": imported,
        "skipped": skipped,
        "failed": failed,
        "pruned": pruned,
        "pruned_folders": pruned_folders,
    }


def _collect_mount_folder_ids(session: Session, mount_assets) -> set:
    """All folder ids on the ancestor chains of the given mount assets' folders.

    Must be called BEFORE asset pruning — afterwards the chain can no longer be
    reconstructed.
    """
    folders: dict = {f.id: f for f in session.exec(select(Folder)).all()}
    ids: set = set()
    for asset in mount_assets:
        current = folders.get(asset.folder_id) if asset.folder_id else None
        guard: set = set()
        while current and current.id not in guard:
            guard.add(current.id)
            ids.add(current.id)
            current = folders.get(current.parent_id) if current.parent_id else None
    return ids


def _prune_empty_folders(session: Session, mount_folder_ids: set) -> int:
    """Delete empty folders from the given set — children before parents.

    A folder is removed only when it has no assets, no remaining child folders,
    and is part of the mount subtree. Folders created by the user elsewhere in
    the tree are never touched.
    """
    if not mount_folder_ids:
        return 0
    folders: dict = {f.id: f for f in session.exec(select(Folder)).all()}
    occupied = {a.folder_id for a in session.exec(select(Asset)).all() if a.folder_id}

    removed = 0
    changed = True
    while changed:
        changed = False
        for fid in sorted(mount_folder_ids, key=lambda i: _chain_depth(i, folders), reverse=True):
            if fid not in folders or fid in occupied:
                continue
            has_child_folder = any(f.parent_id == fid for f in folders.values())
            if has_child_folder or not _has_no_assets(session, fid):
                continue
            session.delete(folders.pop(fid))
            occupied.discard(fid)
            removed += 1
            changed = True
    session.commit()
    return removed


def _chain_depth(folder_id: str, folders: dict) -> int:
    depth = 0
    current = folders.get(folder_id)
    guard: set = set()
    while current and current.parent_id and current.parent_id not in guard:
        guard.add(current.parent_id)
        current = folders.get(current.parent_id)
        if not current:
            break
        depth += 1
    return depth


def _has_no_assets(session: Session, folder_id: str) -> bool:
    return session.exec(
        select(Asset).where(Asset.folder_id == folder_id)
    ).first() is None