"""Minimal in-memory background job tracker for long-running admin tasks.

Jobs run on a background thread (daemon) and their progress is readable via
`get_job`. In-memory only (no persistence): a running job is lost on server
restart, which is fine for admin backfill tasks. The same process serves both
the start and status endpoints (single-worker uvicorn in the compose stack).
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional


@dataclass
class Job:
    id: str
    status: str = "running"  # running | done | error
    total: int = 0
    processed: int = 0
    generated: int = 0
    skipped: int = 0
    failed: int = 0
    error: Optional[str] = None
    message: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None


_JOBS: Dict[str, Job] = {}
_LOCK = threading.Lock()


def _snapshot(job: Job) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "total": job.total,
        "processed": job.processed,
        "generated": job.generated,
        "skipped": job.skipped,
        "failed": job.failed,
        "error": job.error,
        "message": job.message,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
    }


def start_job(fn: Callable[[str], Any]) -> Optional[dict]:
    """Start `fn(job_id)` on a daemon thread and return its job dict (or None)."""
    new_job = Job(id=uuid.uuid4().hex)
    with _LOCK:
        _JOBS[new_job.id] = new_job

    def _run() -> None:
        try:
            fn(new_job.id)
        except Exception as exc:  # noqa: BLE001
            with _LOCK:
                tracked = _JOBS.get(new_job.id)
                if tracked:
                    tracked.status = "error"
                    tracked.error = str(exc)
                    tracked.message = f"Job failed: {exc}"
                    tracked.finished_at = time.time()

    threading.Thread(target=_run, daemon=True).start()
    return _snapshot(new_job)


def update_job(job_id: str, **updates: Any) -> None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return
        for key, value in updates.items():
            setattr(job, key, value)


def get_job(job_id: str) -> Optional[dict]:
    with _LOCK:
        job = _JOBS.get(job_id)
        return _snapshot(job) if job else None
