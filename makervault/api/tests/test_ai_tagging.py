"""Tests for the AI tagging feature: tag hygiene, response parsing, and the
HTTP endpoints (with a mocked chat-completions backend).

NOTE: api modules are imported lazily inside fixtures/tests so the conftest
session fixture can set DB_URL/FILE_STORAGE env vars first. Module-level
imports would hit the repo-local default paths at collection time.
"""
import base64
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from settings_service import set_setting


def create_thumb_png(asset_id: str) -> None:
  from db import THUMBS
  img = Image.new("RGB", (16, 16), color=(200, 120, 60))
  buf = io.BytesIO()
  img.save(buf, format="PNG")
  (THUMBS / f"{asset_id}.png").write_bytes(buf.getvalue())


def create_asset(**overrides) -> str:
  from models import Asset
  with _session() as s:
    asset = Asset(
      filename=overrides.get("filename", "test_dragon_figurine.stl"),
      mime=overrides.get("mime", "model/stl"),
      size=123,
      tags_json=json.dumps(overrides.get("tags", [])),
    )
    s.add(asset)
    s.commit()
    s.refresh(asset)
    return asset.id


def _session():
  from sqlmodel import Session
  from db import engine
  return Session(engine)


def login_token(client: TestClient) -> dict:
  res = client.post("/login", json={"username": "tester", "password": "secret"})
  assert res.status_code == 200
  return {"Authorization": f"Bearer {res.json()['token']}"}


def configure_ai(monkeypatch: pytest.MonkeyPatch, response: dict) -> list:
  """Point AI settings at a dummy URL and stub the HTTP call.

  Returns the list of captured payloads for assertions.
  """
  import ai_tagging
  from ai_tagging import save_ai_settings
  save_ai_settings(
    endpoint="http://ai.test/v1",
    api_key="test-key",
    model="test-vision",
    max_tags=10,
    json_mode=True,
    review_mode=True,
    auto_tag=False,
  )
  captured: list = []

  def fake_post(url, json=None, headers=None, timeout=None):  # noqa: A002
    captured.append({"url": url, "payload": json, "headers": headers})

    class R:
      status_code = 200

      def json(self):
        return {"choices": [{"message": {"content": response}}]}

    return R()

  monkeypatch.setattr(ai_tagging.httpx, "post", fake_post)
  return captured


# Unit tests: tag hygiene -----------------------------------------------------

def test_normalize_tag_lowercases_and_strips():
  from ai_tagging import normalize_tag
  assert normalize_tag("  Dragon!  ") == "dragon"
  assert normalize_tag("3D Model") == ""
  assert normalize_tag(None) == ""


def test_is_tag_valid_rejects_generic_terms():
  from ai_tagging import is_tag_valid
  assert not is_tag_valid("model")
  assert not is_tag_valid("3d")
  assert not is_tag_valid("x")
  assert is_tag_valid("dragon")


def test_deduplicate_tags_keeps_shorter_variant():
  from ai_tagging import deduplicate_tags
  assert deduplicate_tags(["dragon", "dragon model"]) == ["dragon"]
  assert deduplicate_tags(["vase", "vase"]) == ["vase"]


# Unit tests: response parsing -------------------------------------------------

def test_parse_json_object_response():
  from ai_tagging import parse_tags_from_response
  tags = parse_tags_from_response('{"tags": ["Dragon", "Figure"]}', 10, True)
  assert tags == ["dragon", "figure"]


def test_parse_json_in_markdown_fence():
  from ai_tagging import parse_tags_from_response
  content = '```json\n{"tags": ["bracket", "mount"]}\n```'
  assert parse_tags_from_response(content, 10, True) == ["bracket", "mount"]


def test_parse_strips_think_block():
  from ai_tagging import parse_tags_from_response
  content = "<think>Let me analyze this image. The object looks like a dragon.</think>" + '{"tags": ["dragon"]}'
  assert parse_tags_from_response(content, 10, True) == ["dragon"]


def test_parse_falls_back_to_comma_text():
  from ai_tagging import parse_tags_from_response
  assert parse_tags_from_response("dragon, vase, decorative", 10, False) == [
    "dragon",
    "vase",
    "decorative",
  ]


def test_parse_limits_to_max_tags():
  from ai_tagging import parse_tags_from_response
  content = '{"tags": ["a1", "b2", "c3", "d4", "e5"]}'
  assert len(parse_tags_from_response(content, 3, True)) == 3


def test_empty_response_returns_empty_list():
  from ai_tagging import parse_tags_from_response
  assert parse_tags_from_response("", 10, True) == []


# Endpoint tests ----------------------------------------------------------------

def test_get_and_save_ai_settings(client: TestClient, clean_db):
  headers = login_token(client)
  res = client.get("/ai/settings", headers=headers)
  assert res.status_code == 200
  data = res.json()
  assert data["max_tags"] == 10
  assert data["api_key_set"] is False

  res = client.post(
    "/ai/settings",
    headers=headers,
    json={
      "endpoint": "http://llm.local/v1",
      "api_key": "sk-test",
      "model": "llava",
      "max_tags": 5,
      "json_mode": True,
      "review_mode": True,
      "auto_tag": False,
    },
  )
  assert res.status_code == 200
  data = res.json()
  assert data["endpoint"] == "http://llm.local/v1"
  assert data["model"] == "llava"
  assert data["max_tags"] == 5
  assert data["api_key_set"] is True

  # Empty api_key keeps the stored key
  res = client.post(
    "/ai/settings",
    headers=headers,
    json={"endpoint": "http://llm.local/v1", "model": "llava", "max_tags": 5},
  )
  assert res.json()["api_key_set"] is True


def test_ai_requires_auth(client: TestClient, clean_db):
  res = client.get("/ai/settings")
  assert res.status_code == 401


def test_ai_test_endpoint_reports_failure(client: TestClient, clean_db, monkeypatch):
  import ai_tagging
  from ai_tagging import save_ai_settings
  headers = login_token(client)
  save_ai_settings(
    endpoint="http://ai.test/v1",
    api_key="test-key",
    model="test-vision",
    max_tags=10,
    json_mode=True,
    review_mode=True,
    auto_tag=False,
  )

  def failing_post(url, json=None, headers=None, timeout=None):  # noqa: A002
    class R:
      status_code = 500

      def json(self):
        return {"error": {"message": "boom"}}

    return R()

  monkeypatch.setattr(ai_tagging.httpx, "post", failing_post)
  res = client.post("/ai/test", headers=headers)
  assert res.status_code == 200
  assert res.json()["ok"] is False
  assert "boom" in res.json()["error"]


def test_generate_tags_review_mode_returns_suggestions(client: TestClient, clean_db, monkeypatch):
  from models import Asset
  headers = login_token(client)
  configure_ai(monkeypatch, '{"tags": ["dragon", "figure", "collectible"]}')
  asset_id = create_asset()
  create_thumb_png(asset_id)

  res = client.post(f"/ai/tag/{asset_id}", headers=headers)
  assert res.status_code == 200
  data = res.json()
  assert data["applied"] is False
  assert data["tags"] == ["dragon", "figure", "collectible"]
  # Tags are NOT written yet in review mode
  with _session() as s:
    stored = json.loads(s.get(Asset, asset_id).tags_json)
  assert stored == []


def test_generate_tags_applies_directly_when_review_off(
  client: TestClient, clean_db, monkeypatch
):
  import ai_tagging
  from ai_tagging import save_ai_settings
  from models import Asset
  headers = login_token(client)
  save_ai_settings(
    endpoint="http://ai.test/v1",
    api_key="k",
    model="test-vision",
    max_tags=10,
    json_mode=True,
    review_mode=False,
    auto_tag=False,
  )
  monkeypatch.setattr(
    ai_tagging.httpx,
    "post",
    lambda *a, **kw: _ok_response('{"tags": ["dragon", "figure"]}'),
  )
  asset_id = create_asset(tags=["existing"])
  create_thumb_png(asset_id)

  res = client.post(f"/ai/tag/{asset_id}", headers=headers)
  assert res.status_code == 200
  data = res.json()
  assert data["applied"] is True
  assert set(data["asset"]["tags"]) == {"dragon", "figure", "existing"}
  with _session() as s:
    stored = json.loads(s.get(Asset, asset_id).tags_json)
  assert set(stored) == {"dragon", "figure", "existing"}


def test_generate_tags_missing_thumb_returns_error(client: TestClient, clean_db, monkeypatch):
  headers = login_token(client)
  configure_ai(monkeypatch, '{"tags": ["x"]}')
  asset_id = create_asset()
  res = client.post(f"/ai/tag/{asset_id}", headers=headers)
  assert res.status_code == 502
  assert "thumbnail" in res.json()["detail"].lower()


def test_generate_tags_unknown_asset_404(client: TestClient, clean_db):
  headers = login_token(client)
  res = client.post("/ai/tag/does-not-exist", headers=headers)
  assert res.status_code == 404


def test_batch_review_mode(client: TestClient, clean_db, monkeypatch):
  headers = login_token(client)
  configure_ai(monkeypatch, '{"tags": ["a-tag", "b-tag"]}')
  id1 = create_asset(filename="one.stl")
  id2 = create_asset(filename="two.stl")
  create_thumb_png(id1)
  create_thumb_png(id2)

  res = client.post("/ai/tag", headers=headers, json={"asset_ids": [id1, id2, "missing"]})
  assert res.status_code == 200
  data = res.json()
  assert data["failed"] == 1
  ok = [r for r in data["results"] if r["ok"]]
  assert len(ok) == 2
  assert all(r["applied"] is False for r in ok)
  missing = [r for r in data["results"] if r["asset_id"] == "missing"]
  assert missing[0]["error"] == "Asset not found"


def test_batch_merges_into_existing_tags_in_direct_mode(
  client: TestClient, clean_db, monkeypatch
):
  import ai_tagging
  from ai_tagging import save_ai_settings
  from models import Asset
  headers = login_token(client)
  save_ai_settings(
    endpoint="http://ai.test/v1",
    api_key="k",
    model="test-vision",
    max_tags=10,
    json_mode=True,
    review_mode=False,
    auto_tag=False,
  )
  monkeypatch.setattr(
    ai_tagging.httpx,
    "post",
    lambda *a, **kw: _ok_response('{"tags": ["shared", "new-tag"]}'),
  )
  id1 = create_asset(tags=["existing"])
  create_thumb_png(id1)

  res = client.post("/ai/tag", headers=headers, json={"asset_ids": [id1]})
  assert res.status_code == 200
  results = res.json()["results"]
  assert results[0]["ok"] is True
  assert results[0]["applied"] is True
  with _session() as s:
    stored = json.loads(s.get(Asset, id1).tags_json)
  assert set(stored) == {"existing", "shared", "new-tag"}


def test_batch_without_model_configured_reports_error(
  client: TestClient, clean_db, monkeypatch
):
  from ai_tagging import save_ai_settings
  headers = login_token(client)
  # Model intentionally empty
  save_ai_settings(
    endpoint="http://ai.test/v1",
    api_key="k",
    model="",
    max_tags=10,
    json_mode=True,
    review_mode=True,
    auto_tag=False,
  )
  asset_id = create_asset()
  create_thumb_png(asset_id)
  res = client.post("/ai/tag", headers=headers, json={"asset_ids": [asset_id]})
  data = res.json()
  assert data["failed"] == 1
  assert "model" in data["results"][0]["error"].lower()


def test_batch_stops_repeating_endpoint_errors(client: TestClient, clean_db, monkeypatch):
  import ai_tagging
  headers = login_token(client)
  configure_ai(monkeypatch, "unused")
  calls = {"n": 0}

  def failing_post(url, json=None, headers=None, timeout=None):  # noqa: A002
    calls["n"] += 1

    class R:
      status_code = 401

      def json(self):
        return {"error": {"message": "bad key"}}

    return R()

  monkeypatch.setattr(ai_tagging.httpx, "post", failing_post)
  id1 = create_asset(filename="a.stl")
  id2 = create_asset(filename="b.stl")
  create_thumb_png(id1)
  create_thumb_png(id2)
  res = client.post("/ai/tag", headers=headers, json={"asset_ids": [id1, id2]})
  data = res.json()
  assert data["failed"] == 2
  assert calls["n"] == 2  # one call per asset, no retry storm


# Helpers -------------------------------------------------------------------------

def _ok_response(content: str):
  class R:
    status_code = 200

    def json(self):
      return {"choices": [{"message": {"content": content}}]}

  return R()