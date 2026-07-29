"""Tests for api/folder_service.py — folder parent validation and cycle detection."""
import pytest
from fastapi import HTTPException
from sqlmodel import Session

from folder_service import validate_parent_folder
from models import Folder


def _add_folder(s: Session, name: str, parent_id=None) -> Folder:
    f = Folder(name=name, tags_json="[]", parent_id=parent_id)
    s.add(f)
    s.commit()
    s.refresh(f)
    return f


class TestValidateParentFolder:
    def test_none_parent_returns_none(self, app):
        from db import engine
        with Session(engine) as s:
            assert validate_parent_folder(s, None) is None

    def test_valid_parent_returns_id(self, app):
        from db import engine
        with Session(engine) as s:
            parent = _add_folder(s, "parent")
            assert validate_parent_folder(s, parent.id) == parent.id

    def test_missing_parent_raises_400(self, app):
        from db import engine
        with Session(engine) as s:
            with pytest.raises(HTTPException) as exc:
                validate_parent_folder(s, "nonexistent-id")
            assert exc.value.status_code == 400

    def test_self_parent_raises_400(self, app):
        from db import engine
        with Session(engine) as s:
            f = _add_folder(s, "self")
            with pytest.raises(HTTPException) as exc:
                validate_parent_folder(s, f.id, folder_id=f.id)
            assert exc.value.status_code == 400

    def test_direct_cycle_raises_400(self, app):
        from db import engine
        with Session(engine) as s:
            a = _add_folder(s, "a")
            b = _add_folder(s, "b", parent_id=a.id)
            # Try to make `b` the parent of `a` → a->b->a cycle
            with pytest.raises(HTTPException) as exc:
                validate_parent_folder(s, b.id, folder_id=a.id)
            assert exc.value.status_code == 400
            assert "cycle" in exc.value.detail.lower()

    def test_indirect_cycle_raises_400(self, app):
        from db import engine
        with Session(engine) as s:
            a = _add_folder(s, "a")
            b = _add_folder(s, "b", parent_id=a.id)
            c = _add_folder(s, "c", parent_id=b.id)
            # Try to make `c` the parent of `a` → a->b->c->a cycle
            with pytest.raises(HTTPException) as exc:
                validate_parent_folder(s, c.id, folder_id=a.id)
            assert exc.value.status_code == 400
