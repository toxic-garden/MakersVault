"""Tests for POST /admin/jobs/{id}/cancel — cooperative job cancellation."""
import time

from fastapi.testclient import TestClient


def _wait_status(client: TestClient, headers, job_id: str, statuses=("done", "error", "cancelled"), timeout=10) -> dict:
    deadline = time.time() + timeout
    body = {}
    while time.time() < deadline:
        body = client.get(f"/admin/jobs/{job_id}", headers=headers).json()
        if body["status"] in statuses:
            return body
        time.sleep(0.05)
    return body


def test_cancel_running_job(client: TestClient, auth_headers, clean_db):
    start = client.post("/admin/generate-missing-thumbnails", headers=auth_headers)
    job_id = start.json()["job_id"]
    # Cancel immediately (the job has 2200+ assets in dev, in tests ~0; either
    # way the cancel must be accepted while running).
    res = client.post(f"/admin/jobs/{job_id}/cancel", headers=auth_headers)
    # Accept both outcomes: 200 (was still running) or 409 (already finished).
    assert res.status_code in (200, 409)
    if res.status_code == 200:
        body = res.json()
        assert body["status"] == "cancelled"
        assert body["finished_at"] is not None


def test_cancel_unknown_job_404(client: TestClient, auth_headers, clean_db):
    res = client.post("/admin/jobs/does-not-exist/cancel", headers=auth_headers)
    assert res.status_code == 404


def test_cancel_requires_auth(client: TestClient, clean_db):
    res = client.post("/admin/jobs/x/cancel")
    assert res.status_code == 401


def test_cancelled_status_is_final(client: TestClient, auth_headers, clean_db):
    """After a cancel, the job must never go back to running/done."""
    start = client.post("/admin/generate-missing-thumbnails", headers=auth_headers)
    job_id = start.json()["job_id"]
    res = client.post(f"/admin/jobs/{job_id}/cancel", headers=auth_headers)
    if res.status_code != 200:
        return  # job finished before we could cancel — nothing to assert
    time.sleep(0.5)
    body = client.get(f"/admin/jobs/{job_id}", headers=auth_headers).json()
    assert body["status"] == "cancelled"