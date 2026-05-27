"""Tiny bootstrap for the RunPod serverless worker.

Every checkpoint emits a code like [RP-NN] so that when a worker dies during
init you can read the last code in the RunPod console logs and know exactly
which step failed.  See the checklist in the project notes for what each
code means and how to fix it.
"""

# ─────────────────────────────────────────────────────────────────────────────
# [RP-01] Container started, Python is alive.
# This is the absolute first line before ANY import.  If you do not see RP-01
# in the worker logs, the Docker image itself did not boot (wrong CMD, wrong
# PYTHONPATH, image pull failed).
# ─────────────────────────────────────────────────────────────────────────────
print("[RP-01] container_started: python is alive", flush=True)

import importlib
import logging
import os
import platform
import sys
import time
import traceback
from typing import Any, Callable

# [RP-02] handler.py finished its standard-library imports.
print("[RP-02] handler_py_imports_ok: stdlib loaded", flush=True)

import runpod

# [RP-03] runpod SDK imported successfully.  If RP-02 prints but RP-03 does
# not, the runpod package is broken or missing from the image.
print("[RP-03] runpod_sdk_imported: ok", flush=True)


# Send ALL log records to stdout so they appear in RunPod's worker logs next
# to our print() codes.  Default basicConfig goes to stderr which sometimes
# gets buffered or hidden in the RunPod UI.
_root = logging.getLogger()
for _h in list(_root.handlers):
    _root.removeHandler(_h)
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
_root.addHandler(_handler)
_root.setLevel(os.getenv("BRAIN_DIFF_LOG_LEVEL", "INFO"))

log = logging.getLogger("braindiff.worker_bootstrap")


_impl_handler: Callable[[dict[str, Any]], Any] | None = None


def _env_flag(name: str) -> str:
    value = os.getenv(name)
    if value is None:
        return "missing"
    return f"set(len={len(value)})"


def _boot_snapshot() -> dict[str, Any]:
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cwd": os.getcwd(),
        "pythonpath": os.getenv("PYTHONPATH", ""),
        "hf_token": _env_flag("HF_TOKEN"),
        "atlas_dir": os.getenv("BRAIN_DIFF_ATLAS_DIR", ""),
        "tribev2_revision": os.getenv("TRIBEV2_REVISION", ""),
        "brain_diff_device": os.getenv("BRAIN_DIFF_DEVICE", ""),
        "text_backend": os.getenv("BRAIN_DIFF_TEXT_BACKEND", ""),
    }


def _job_id_from_event(event: dict[str, Any]) -> str:
    payload = (event or {}).get("input") or {}
    job_id = (event or {}).get("id") or payload.get("job_id") or ""
    return job_id.strip() if isinstance(job_id, str) else ""


def _emit_boot_progress(job_id: str, status: str, message: str) -> None:
    if not job_id:
        return
    try:
        from runpod_worker.progress import emitter_for

        emitter_for(job_id).emit(status, message)
    except Exception as exc:  # noqa: BLE001
        log.warning("boot_progress_emit_failed job_id=%s status=%s err=%s: %s",
                    job_id, status, type(exc).__name__, exc)


def _load_impl_handler() -> Callable[[dict[str, Any]], Any]:
    global _impl_handler
    if _impl_handler is not None:
        return _impl_handler
    started = time.time()
    # [RP-06] Beginning the heavy worker_impl import (TRIBE, transformers, etc.)
    print("[RP-06] worker_impl_import_started", flush=True)
    log.info("[RP-06] worker_impl_import: starting snapshot=%s", _boot_snapshot())
    module = importlib.import_module("runpod_worker.worker_impl")
    _impl_handler = module.handler
    elapsed = time.time() - started
    # [RP-07] worker_impl finished importing.  If you see RP-06 but never
    # RP-07, a top-level import inside worker_impl crashed (likely a missing
    # pip package such as `accelerate`).  Traceback is captured by handler()
    # below and returned in the job result.
    print(f"[RP-07] worker_impl_import_ok: elapsed_s={elapsed:.2f}", flush=True)
    log.info("[RP-07] worker_impl_import: ready elapsed_s=%.2f", elapsed)
    return _impl_handler


def handler(event: dict[str, Any]) -> Any:
    # [RP-05] First job event reached the bootstrap handler.
    job_id = _job_id_from_event(event)
    print(f"[RP-05] first_job_received: job_id={job_id}", flush=True)
    log.info("[RP-05] first_job_received: job_id=%s", job_id)
    _emit_boot_progress(job_id, "worker_received", "RunPod worker received the job.")
    _emit_boot_progress(job_id, "worker_impl_import_started", "Loading BrainDiff worker code...")
    try:
        impl = _load_impl_handler()
        _emit_boot_progress(job_id, "worker_impl_import_ready", "BrainDiff worker code loaded.")
        return impl(event)
    except Exception as exc:
        log.exception("worker_job_failed_before_or_inside_impl: %s: %s", type(exc).__name__, exc)
        _emit_boot_progress(
            job_id,
            "worker_failed_before_pipeline",
            f"Worker failed before analysis: {type(exc).__name__}: {exc}",
        )
        return {
            "error_type": f"{type(exc).__module__}.{type(exc).__name__}",
            "error_message": str(exc),
            "error_traceback": traceback.format_exc(),
            "stage": "worker_impl_import_or_handler",
            "boot_snapshot": _boot_snapshot(),
        }


# [RP-04] About to register the worker with RunPod.  This is the LAST thing
# we control before runpod.serverless.start() takes over and blocks forever.
# If RP-04 prints but the RunPod console keeps the worker stuck in
# "initializing", the failure is inside runpod.serverless.start() itself
# (network to RunPod control plane, mis-configured endpoint, etc.).
print("[RP-04] about_to_register_with_runpod", flush=True)
log.info("[RP-04] worker_bootstrap: starting runpod.serverless snapshot=%s", _boot_snapshot())
runpod.serverless.start({"handler": handler})
