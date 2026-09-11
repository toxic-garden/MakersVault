"""Tests for the asset "Object Source" (source_url) metadata field."""
import json

from fastapi.testclient import TestClient


def _upload_asset(client: TestClient, headers: dict) -> str:
  res = client.post(
    "/upload",
    headers=headers,
    files={"file": ("test.stl", b"solid openscad\n", "model/stl")},
  )
  assert res.status_code == 200
  return res.json()["id"]


def test_set_source_url(client: TestClient, auth_headers, clean_db):
  asset_id = _upload_asset(client, auth_headers)
  res = client.post(
    f"/asset/{asset_id}/meta",
    headers=auth_headers,
    json={"source_url": "https://www.printables.com/model/123-example"},
  )
  assert res.status_code == 200
  body = res.json()
  assert body["source_url"] == "https://www.printables.com/model/123-example"

  res = client.get("/assets", headers=auth_headers)
  assert res.json()[0]["source_url"] == "https://www.printables.com/model/123-example"


def test_clear_source_url(client: TestClient, auth_headers, clean_db):
  asset_id = _upload_asset(client, auth_headers)
  client.post(
    f"/asset/{asset_id}/meta",
    headers=auth_headers,
    json={"source_url": "https://makerworld.com/en/models/456"},
  )
  # Sending source_url: null clears it (model_fields_set contains the field)
  res = client.post(
    f"/asset/{asset_id}/meta",
    headers=auth_headers,
    json={"source_url": None},
  )
  assert res.status_code == 200
  assert res.json()["source_url"] is None


def test_source_url_defaults_to_null(client: TestClient, auth_headers, clean_db):
  asset_id = _upload_asset(client, auth_headers)
  res = client.get("/assets", headers=auth_headers)
  assert res.json()[0]["source_url"] is None