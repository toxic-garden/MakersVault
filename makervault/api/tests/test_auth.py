"""Tests for api/auth.py — JWT token creation and verification."""
import time

import jwt
import pytest

import auth


def test_create_token_has_expected_claims():
    token = auth.create_token("alice")
    payload = jwt.decode(token, auth.AUTH_SECRET, algorithms=[auth.AUTH_ALGO])
    assert payload["sub"] == "alice"
    assert "iat" in payload
    assert "exp" in payload
    assert payload["exp"] - payload["iat"] == auth.AUTH_TOKEN_TTL


def test_create_token_different_users_produce_different_tokens():
    t1 = auth.create_token("alice")
    t2 = auth.create_token("bob")
    assert t1 != t2


class TestRequireAuth:
    def test_auth_disabled_returns_none(self, monkeypatch):
        monkeypatch.setattr(auth, "AUTH_ENABLED", False)
        result = auth.require_auth()
        assert result is None

    def test_no_token_raises_401_when_enabled(self, monkeypatch):
        monkeypatch.setattr(auth, "AUTH_ENABLED", True)
        with pytest.raises(Exception) as exc:
            auth.require_auth(credentials=None, token_param=None)
        assert exc.value.status_code == 401

    def test_invalid_token_raises_401(self, monkeypatch):
        monkeypatch.setattr(auth, "AUTH_ENABLED", True)
        from fastapi.security import HTTPAuthorizationCredentials

        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="not-a-real-jwt")
        with pytest.raises(Exception) as exc:
            auth.require_auth(credentials=creds, token_param=None)
        assert exc.value.status_code == 401

    def test_valid_token_via_bearer_returns_token(self, monkeypatch):
        monkeypatch.setattr(auth, "AUTH_ENABLED", True)
        token = auth.create_token("alice")
        from fastapi.security import HTTPAuthorizationCredentials

        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        result = auth.require_auth(credentials=creds, token_param=None)
        assert result == token

    def test_valid_token_via_query_param(self, monkeypatch):
        monkeypatch.setattr(auth, "AUTH_ENABLED", True)
        token = auth.create_token("alice")
        result = auth.require_auth(credentials=None, token_param=token)
        assert result == token

    def test_expired_token_raises_401(self, monkeypatch):
        monkeypatch.setattr(auth, "AUTH_ENABLED", True)
        now = int(time.time())
        payload = {"sub": "alice", "iat": now - 7200, "exp": now - 3600}
        expired = jwt.encode(payload, auth.AUTH_SECRET, algorithm=auth.AUTH_ALGO)
        from fastapi.security import HTTPAuthorizationCredentials

        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=expired)
        with pytest.raises(Exception) as exc:
            auth.require_auth(credentials=creds, token_param=None)
        assert exc.value.status_code == 401


def test_auth_enabled_flag():
    """AUTH_ENABLED is true iff both username and password are set."""
    import os
    # Default in test conftest is tester/secret — AUTH_ENABLED should be True
    assert auth.AUTH_USERNAME and auth.AUTH_PASSWORD
    assert auth.AUTH_ENABLED is True
