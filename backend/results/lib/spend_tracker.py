"""Daily spend tracking + cap enforcement for hosted-LLM calls.

WHY this exists:
  We pay per-token for Anthropic. Without a guard, a buggy retry storm or
  unexpected traffic spike could burn arbitrary money. This module:
    1. Tracks running spend per UTC day, persisted to /tmp so it survives
       worker restarts within the same day (full container loss does
       reset; that's fine — RunPod spins multiple workers and each carries
       its own counter).
    2. Refuses further calls once a hard cap is reached.
    3. Emits warning + cap-reached audit events.

  Triple-defence: this code is the FIRST line. Anthropic console spend
  limits are the SECOND. RunPod-level monthly cap is the THIRD. Any one
  of the three failing still leaves two more nets below it.

The cap defaults to $5/day (`BRAIN_DIFF_SPEND_CAP_DAILY_USD` env var to
override). When the cap is hit, `SpendCapExceeded` is raised at the next
generate() call; slot loops catch it and fail-fast, the worker returns a
structured error, and the frontend shows a banner instead of degraded
content.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)


# Persist across restarts within the same UTC day. Workers may share or
# may not share — that's fine, we err on the side of underestimating.
_STATE_FILE = Path(os.getenv("BRAIN_DIFF_SPEND_STATE_FILE", "/tmp/braindiff_spend.json"))
_LOCK = threading.Lock()


class SpendCapExceeded(Exception):
    """Raised when the daily Anthropic spend cap has been reached."""

    def __init__(self, *, day: str, spent_usd: float, cap_usd: float) -> None:
        self.day = day
        self.spent_usd = spent_usd
        self.cap_usd = cap_usd
        super().__init__(
            f"daily spend cap reached: spent ${spent_usd:.4f} / cap ${cap_usd:.2f} on {day}"
        )


def _today_utc() -> str:
    """YYYY-MM-DD in UTC. Used as the day key for the spend counter."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _read_state() -> dict:
    """Read the on-disk counter. Returns empty dict on first read or corruption."""
    if not _STATE_FILE.exists():
        return {}
    try:
        return json.loads(_STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        # Corruption shouldn't take the whole worker down — reset.
        log.warning("spend state file corrupted, resetting: %s", _STATE_FILE)
        return {}


def _write_state(state: dict) -> None:
    try:
        _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _STATE_FILE.write_text(json.dumps(state, indent=2))
    except OSError as exc:
        # Worst case: we don't persist between restarts. Don't kill the worker.
        log.warning("could not persist spend state: %s", exc)


def get_cap_usd() -> float:
    """Return today's spend cap in USD. Default $5; configurable via env."""
    raw = os.getenv("BRAIN_DIFF_SPEND_CAP_DAILY_USD", "5.0")
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 5.0


def get_today_spend_usd() -> float:
    """Read the current day's running total."""
    state = _read_state()
    return float(state.get(_today_utc(), 0.0))


def assert_under_cap() -> None:
    """Raise SpendCapExceeded if today's spend has hit the cap.

    Call this BEFORE making the next API call. The cap check is fast
    (one file read) and idempotent — safe to call as often as needed.
    """
    spent = get_today_spend_usd()
    cap = get_cap_usd()
    if cap <= 0:
        # cap=0 means caller disabled the guard explicitly — pass through.
        return
    if spent >= cap:
        raise SpendCapExceeded(day=_today_utc(), spent_usd=spent, cap_usd=cap)


def record_spend(usd: float) -> tuple[float, float, bool]:
    """Add `usd` to today's total and persist. Returns (new_total, cap, hit_warning).

    `hit_warning` is True the first time we cross 80% of the cap (caller
    can use this to emit a `spend_warning` audit event without flooding).
    """
    if usd <= 0:
        spent = get_today_spend_usd()
        cap = get_cap_usd()
        return spent, cap, False

    with _LOCK:
        state = _read_state()
        day = _today_utc()
        previous = float(state.get(day, 0.0))
        new_total = previous + usd
        state[day] = new_total
        # Garbage-collect old day entries so the file doesn't grow forever.
        state = {d: v for d, v in state.items() if d >= day or len(state) <= 7}
        _write_state(state)

    cap = get_cap_usd()
    crossed_warning = (cap > 0) and (previous < 0.8 * cap <= new_total)
    return new_total, cap, crossed_warning


def reset_today() -> None:
    """Zero today's counter. Provided for tests; do NOT call from prod code."""
    with _LOCK:
        state = _read_state()
        state.pop(_today_utc(), None)
        _write_state(state)
