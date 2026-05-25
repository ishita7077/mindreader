"""Persist worker results + audit logs to Upstash Redis.

WHY this exists:
  RunPod serverless purges job output from its in-memory store within 30-60
  minutes of job completion. Audit logs (the JSONL trail per comparison) live
  on the worker pod's /tmp filesystem and die when the pod exits — typically
  within a few minutes of the last job. The result: a link a user got 20
  minutes ago can already be broken, and we have zero historical
  observability for past runs.

  This module puts both artefacts into our existing Upstash Redis (the same
  one we use for progress events) so:
    1. Past job links keep working as long as we want (default 30-day TTL)
    2. Future admin tooling can replay any past run's full audit trail

Design:
  - Two keys per job: `result:{job_id}` and `audit:{job_id}`
  - JSON-encoded; one Upstash SET call per artefact
  - All calls are best-effort — if Redis is misconfigured we log and move on.
    Never let persistence break the actual job response.
  - Uses the existing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
    env vars already on the RunPod template (no new config to set).
  - 30-day TTL by default; configurable via BRAIN_DIFF_RESULT_TTL_DAYS.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("braindiff.persistence")

_HTTP_TIMEOUT_S = 10.0


def _ttl_seconds() -> int:
    """How long to keep stored results in Redis. Default: 30 days."""
    raw = os.environ.get("BRAIN_DIFF_RESULT_TTL_DAYS", "30")
    try:
        days = max(1, int(raw))
    except ValueError:
        days = 30
    return days * 24 * 60 * 60


def _redis_set(key: str, value: str) -> bool:
    """Issue a Redis SET with TTL via Upstash REST. Returns True on success."""
    url = (os.environ.get("UPSTASH_REDIS_REST_URL") or "").rstrip("/")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or ""
    if not (url and token):
        logger.info("persistence: redis not configured (url_set=%s token_set=%s)", bool(url), bool(token))
        return False

    # Upstash SET command with EX (TTL in seconds). Single round-trip.
    payload: list[Any] = ["SET", key, value, "EX", _ttl_seconds()]
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT_S) as client:
            resp = client.post(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
        return True
    except Exception as err:
        logger.warning("persistence: redis SET failed key=%s err=%s", key, err)
        return False


def store_result(job_id: str, payload: dict[str, Any]) -> bool:
    """Persist the worker's full result payload at `result:{job_id}`.

    Called once per job, AFTER the worker has assembled its complete response.
    Returns True if stored, False if Redis unreachable or job_id is empty.
    """
    if not job_id:
        return False
    try:
        encoded = json.dumps(payload, separators=(",", ":"), default=str)
    except (TypeError, ValueError) as err:
        logger.warning("persistence: payload not JSON-encodable for job_id=%s: %s", job_id, err)
        return False

    ok = _redis_set(f"result:{job_id}", encoded)
    logger.info("persistence: store_result job_id=%s ok=%s size=%d", job_id, ok, len(encoded))
    return ok


def store_audit_log(job_id: str, audit_log_path: str | None) -> bool:
    """Persist the per-comparison audit log JSONL at `audit:{job_id}`.

    Reads `audit_log_path` (a JSONL file written by AuditLogger), parses each
    line, and stores them as a single JSON array in Redis. If the file is
    missing or unreadable, returns False without raising.
    """
    if not (job_id and audit_log_path):
        return False
    path = Path(audit_log_path)
    if not path.exists():
        logger.info("persistence: audit log not found at %s (job_id=%s)", audit_log_path, job_id)
        return False

    events: list[dict[str, Any]] = []
    try:
        with path.open("r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    # Malformed line — skip without failing the whole store.
                    continue
    except OSError as err:
        logger.warning("persistence: audit log read failed path=%s err=%s", audit_log_path, err)
        return False

    encoded = json.dumps(events, separators=(",", ":"), default=str)
    ok = _redis_set(f"audit:{job_id}", encoded)
    logger.info(
        "persistence: store_audit_log job_id=%s ok=%s events=%d size=%d",
        job_id, ok, len(events), len(encoded),
    )
    return ok
