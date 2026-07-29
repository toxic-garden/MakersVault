"""Integration tests for the FastAPI routes in api/main.py."""
import io

import pytest


class TestHealth:
    def test_health_ok(self, client):
        res = client.get("/health")
        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        assert body["auth_required"] is True


class TestAuthRequired:
    def test_list_assets_without_token_returns_401(self, client):
        res = client.get("/assets")
        assert res.status_code == 401

    def test_list_assets_with_token_succeeds(self, client, auth_headers):
        res = client.get("/assets", headers=auth_headers)
        assert res.status_code == 200
        assert res.json() == []

    def test_query_token_also_works(self, client, auth_token):
        res = client.get(f"/assets?token={auth_token}")
        assert res.status_code == 200

    def test_login_with_wrong_password_returns_401(self, client):
        res = client.post("/login", json={"username": "tester", "password": "wrong"})
        assert res.status_code == 401

    def test_login_with_correct_credentials_returns_token(self, client):
        res = client.post("/login", json={"username": "tester", "password": "secret"})
        assert res.status_code == 200
        body = res.json()
        assert body["token"]
        assert body["expires_in"] == 3600


class TestFolderCrud:
    def test_create_and_list_folders(self, client, auth_headers):
        res = client.post("/folders", headers=auth_headers, json={"name": "Models"})
        assert res.status_code == 200
        folder_id = res.json()["id"]
        assert res.json()["name"] == "Models"

        res = client.get("/folders", headers=auth_headers)
        assert res.status_code == 200
        names = [f["name"] for f in res.json()]
        assert "Models" in names

    def test_create_folder_with_unknown_parent_400(self, client, auth_headers):
        res = client.post(
            "/folders",
            headers=auth_headers,
            json={"name": "Child", "parent_id": "nonexistent"},
        )
        assert res.status_code == 400

    def test_create_folder_self_parent_400(self, client, auth_headers):
        f = client.post("/folders", headers=auth_headers, json={"name": "A"}).json()
        res = client.post(
            "/folders",
            headers=auth_headers,
            json={"name": "B", "parent_id": f["id"]},
        )
        assert res.status_code == 200
        # Now try to update A to be its own parent
        res = client.patch(
            f"/folder/{f['id']}",
            headers=auth_headers,
            json={"name": "A", "parent_id": f["id"]},
        )
        assert res.status_code == 400

    def test_delete_folder_detaches_children(self, client, auth_headers):
        a = client.post("/folders", headers=auth_headers, json={"name": "A"}).json()
        b = client.post(
            "/folders",
            headers=auth_headers,
            json={"name": "B", "parent_id": a["id"]},
        ).json()
        res = client.delete(f"/folder/{a['id']}", headers=auth_headers)
        assert res.status_code == 200
        # B should now have parent_id=None
        res = client.get("/folders", headers=auth_headers)
        folders = {f["id"]: f for f in res.json()}
        assert folders[b["id"]]["parent_id"] is None


class TestUploadAsset:
    def test_upload_creates_asset(self, client, auth_headers):
        content = b"solid openscad\n"
        res = client.post(
            "/upload",
            headers=auth_headers,
            files={"file": ("test.stl", io.BytesIO(content), "model/stl")},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["filename"] == "test.stl"
        assert body["mime"] == "model/stl"
        assert body["size"] == len(content)

    def test_upload_persists_file(self, client, auth_headers, temp_workspace):
        content = b"hello world"
        res = client.post(
            "/upload",
            headers=auth_headers,
            files={"file": ("test.stl", io.BytesIO(content), "model/stl")},
        )
        asset_id = res.json()["id"]
        on_disk = temp_workspace["storage"] / asset_id / "test.stl"
        assert on_disk.exists()
        assert on_disk.read_bytes() == content

    def test_upload_with_tags(self, client, auth_headers):
        res = client.post(
            "/upload",
            headers=auth_headers,
            files={"file": ("x.stl", io.BytesIO(b"x"), "model/stl")},
            data={"tags": "tag1, tag2 ,, tag3"},
        )
        assert res.status_code == 200
        # tags_json is round-tripped on subsequent fetch
        asset_id = res.json()["id"]
        res = client.get("/tags", headers=auth_headers)
        tag_names = res.json()
        assert "tag1" in tag_names
        assert "tag2" in tag_names
        assert "tag3" in tag_names


class TestMountImportSettings:
    def test_get_returns_current_state(self, client, auth_headers):
        res = client.get("/settings/mount-import", headers=auth_headers)
        assert res.status_code == 200
        body = res.json()
        assert "enabled" in body
        assert "copy_files" in body

    def test_update_persists(self, client, auth_headers):
        res = client.post(
            "/settings/mount-import",
            headers=auth_headers,
            json={"enabled": True, "copy_files": False},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["enabled"] is True
        assert body["copy_files"] is False
        # Round-trip
        res = client.get("/settings/mount-import", headers=auth_headers)
        assert res.json()["enabled"] is True
        assert res.json()["copy_files"] is False


class TestRefreshToken:
    def test_refresh_issues_new_token(self, client, auth_token):
        res = client.post("/refresh", params={"token": auth_token})
        assert res.status_code == 200
        body = res.json()
        assert body["token"]
        assert body["expires_in"] == 3600
        # Tokens minted within the same second are byte-identical; we verify
        # the payload instead.
        import jwt
        payload = jwt.decode(body["token"], options={"verify_signature": False})
        assert payload["sub"] == "tester"
        assert payload["exp"] - payload["iat"] == 3600

    def test_refresh_without_token_401(self, client):
        res = client.post("/refresh")
        assert res.status_code == 401

    def test_refresh_with_invalid_token_401(self, client):
        res = client.post("/refresh", params={"token": "garbage"})
        assert res.status_code == 401


class TestCorsResolution:
    def test_cors_allows_configured_origin(self, client):
        res = client.get("/health", headers={"Origin": "http://localhost:5173"})
        assert res.headers.get("access-control-allow-origin") == "http://localhost:5173"
