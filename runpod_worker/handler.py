import importlib
import logging
import os
import platform
import sys
import time
import traceback
from typing import Any, Callable

import runpod

logging.basicConfig(
    level=os.getenv("BRAIN_DIFF_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
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


def _load_impl_handler() -> Callable[[dict[str, Any]], Any]:
    global _impl_handler
    if _impl_handler is not None:
        return _impl_handler
    started = time.time()
    log.info("worker_impl_import: starting snapshot=%s", _boot_snapshot())
    module = importlib.import_module("runpod_worker.worker_impl")
    _impl_handler = module.handler
    log.info("worker_impl_import: ready elapsed_s=%.2f", time.time() - started)
    return _impl_handler


def handler(event: dict[str, Any]) -> Any:
    try:
        return _load_impl_handler()(event)
    except Exception as exc:
        log.exception("worker_job_failed_before_or_inside_impl: %s: %s", type(exc).__name__, exc)
        return {
            "error_type": f"{type(exc).__module__}.{type(exc).__name__}",
            "error_message": str(exc),
            "error_traceback": traceback.format_exc(),
            "stage": "worker_impl_import_or_handler",
            "boot_snapshot": _boot_snapshot(),
        }


log.info("worker_bootstrap: starting runpod.serverless snapshot=%s", _boot_snapshot())
runpod.serverless.start({"handler": handler})
