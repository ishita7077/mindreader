import logging
import os
import tempfile
import threading
import time
import uuid
from typing import Any
from urllib.parse import unquote, urlparse

log = logging.getLogger("braindiff.handler")

# One GPU-heavy comparison at a time per worker process.
# RunPod endpoint-level concurrency (max_workers) handles parallelism
# across workers; inside a single worker we queue to avoid CUDA OOM.
_GPU_JOB_LOCK = threading.Semaphore(int(os.getenv("BRAIN_DIFF_GPU_JOB_CONCURRENCY", "1")))


def _gpu_snapshot(stage: str) -> dict:
    """Capture GPU memory state at a pipeline checkpoint."""
    try:
        import torch  # type: ignore
        if not torch.cuda.is_available():
            return {"stage": stage, "cuda": False}
        return {
            "stage": stage,
            "cuda": True,
            "device": torch.cuda.get_device_name(0),
            "allocated_mb": round(torch.cuda.memory_allocated() / 1024 ** 2, 1),
            "reserved_mb": round(torch.cuda.memory_reserved() / 1024 ** 2, 1),
            "peak_mb": round(torch.cuda.max_memory_allocated() / 1024 ** 2, 1),
        }
    except Exception:
        return {"stage": stage, "cuda": False}

import runpod


def _stub_result(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("input") or {}
    run_type = str(payload.get("run_type") or payload.get("runType") or "diff").strip().lower()
    if run_type == "single":
        text = (payload.get("text") or payload.get("text_a") or "Single input").strip()
        dims = [
            ("attention_salience", "Attention", 0.73),
            ("memory_encoding", "Memory Encoding", 0.66),
            ("language_depth", "Language Depth", 0.69),
            ("personal_resonance", "Personal Resonance", 0.57),
            ("brain_effort", "Brain Effort", 0.52),
            ("gut_reaction", "Gut Reaction", 0.53),
            ("social_thinking", "Social Thinking", 0.50),
        ]
        return {
            "run_type": "single",
            "dimensions": [
                {
                    "key": name,
                    "dimension": name,
                    "label": label,
                    "score": score,
                    "timeseries": [max(0.0, score - 0.03), score, min(1.0, score + 0.02)],
                }
                for name, label, score in dims
            ],
            "vertex_b64": "",
            "vertex_delta_b64": "",
            "vertex_a_b64": "",
            "vertex_b_b64": "",
            "warnings": ["Emergency fast-boot worker mode is enabled."],
            "meta": {
                "run_type": "single",
                "model_revision": "fast_boot_stub",
                "atlas": "HCP_MMP1.0",
                "pipeline": "text_fast_boot",
                "modality": payload.get("mode") or "text",
                "text": text,
                "transcript": text,
                "text_length": len(text),
                "transcript_length": len(text),
                "text_timesteps": 3,
                "processing_time_ms": 1,
                "dimensions_count": len(dims),
                "display_name": payload.get("display_name") or "Text",
            },
        }
    text_a = (payload.get("text_a") or "Version A").strip()
    text_b = (payload.get("text_b") or "Version B").strip()
    dims = [
        ("attention_salience", 0.62, 0.73),
        ("memory_encoding", 0.58, 0.66),
        ("language_depth", 0.71, 0.69),
        ("personal_resonance", 0.49, 0.57),
        ("cognitive_control", 0.52, 0.48),
        ("visceral_response", 0.44, 0.53),
        ("social_thinking", 0.46, 0.50),
    ]
    diff = {
        name: {
            "score_a": a,
            "score_b": b,
            "delta": b - a,
            "winner": "b" if b > a else "a",
            "timeseries_a": [a, min(0.99, a + 0.03), max(0.01, a - 0.02)],
            "timeseries_b": [b, min(0.99, b + 0.02), max(0.01, b - 0.03)],
        }
        for name, a, b in dims
    }
    return {
        "diff": diff,
        "dimensions": [
            {
                "dimension": name,
                "label": name.replace("_", " ").title(),
                "score_a": a,
                "score_b": b,
                "delta": b - a,
                "winner": "b" if b > a else "a",
            }
            for name, a, b in dims
        ],
        "insights": {
            "headline": "Version B creates a sharper attention and memory trace.",
            "summary": "Emergency fast-boot result generated from the live worker path.",
        },
        "vertex_delta_b64": "",
        "vertex_a_b64": "",
        "vertex_b_b64": "",
        "warnings": ["Emergency fast-boot worker mode is enabled."],
        "meta": {
            "model_revision": "fast_boot_stub",
            "atlas": "HCP_MMP1.0",
            "pipeline": "text_fast_boot",
            "modality": "text",
            "text_a": text_a,
            "text_b": text_b,
            "text_a_length": len(text_a),
            "text_b_length": len(text_b),
            "processing_time_ms": 1,
            "dimensions_count": len(dims),
            "headline": "Version B creates a sharper attention and memory trace.",
            "winner_summary": "Version B leads on attention and memory encoding.",
            "display_name_a": payload.get("display_name_a") or "A",
            "display_name_b": payload.get("display_name_b") or "B",
        },
    }


if os.getenv("BRAIN_DIFF_RUNPOD_STUB_RESULT", "0") == "1":
    runpod.serverless.start({"handler": _stub_result})
    raise SystemExit(0)

import httpx
import numpy as np


def _hf_login_from_env() -> None:
    """Authenticate with HuggingFace Hub before any model download.

    The huggingface_hub library auto-detects HF_TOKEN / HUGGING_FACE_HUB_TOKEN /
    HUGGINGFACE_HUB_TOKEN, but the priority order has changed across versions
    and the env-var-only path silently sends unauthenticated requests when the
    var name doesn't match. To make gated-model access (meta-llama/Llama-3.2-3B)
    rock-solid we explicitly call huggingface_hub.login() with whichever token
    env var is set, before any TribeModel.from_pretrained call.
    """
    token = (
        os.getenv("HF_TOKEN")
        or os.getenv("HUGGING_FACE_HUB_TOKEN")
        or os.getenv("HUGGINGFACE_HUB_TOKEN")
    )
    if not token:
        return
    try:
        from huggingface_hub import login as _hf_login
        _hf_login(token=token, add_to_git_credential=False)
        os.environ["HF_TOKEN"] = token
        os.environ["HUGGING_FACE_HUB_TOKEN"] = token
        os.environ["HUGGINGFACE_HUB_TOKEN"] = token
    except Exception:
        pass


# [RP-08] HF_TOKEN check — required for gated models (Llama-3.2-3B, Gemma).
# Logs whether a token was present and whether the explicit login() succeeded.
_token_present = bool(
    os.getenv("HF_TOKEN")
    or os.getenv("HUGGING_FACE_HUB_TOKEN")
    or os.getenv("HUGGINGFACE_HUB_TOKEN")
)
print(f"[RP-08] hf_token_check: present={_token_present}", flush=True)
log.info("[RP-08] hf_token_check: present=%s", _token_present)
_hf_login_from_env()


from backend.atlas_peaks import describe_peak_abs_delta
from backend.brain_regions import build_vertex_masks
from backend.differ import compute_diff
from backend.duration_utils import (
    DurationProbeError,
    MEDIA_SIMILARITY_SECONDS,
    probe_duration_seconds,
    trim_to_duration,
)
from backend.heatmap import compute_vertex_delta, generate_heatmap_artifact
from backend.media_features import WAVEFORM_BINS, audio_envelope, peak_moments, video_keyframes
from backend.model_service import TribeService
from backend.narrative import build_headline
from backend.result_semantics import UI_LABELS, TOOLTIPS, USER_MEANING, enrich_dimension_payload, winner_summary
from backend.scorer import reference_scale, score_predictions
from backend.vertex_codec import f32_b64

# New results-page content generation (uses the same LLaMA TRIBE loaded).
from backend.results.worker_integration import generate_content_for_worker

from runpod_worker.progress import emitter_for

MODEL_REVISION = os.getenv("TRIBEV2_REVISION", "facebook/tribev2")
ATLAS_DIR = os.getenv("BRAIN_DIFF_ATLAS_DIR", "atlases")

tribe_service = TribeService(model_revision=MODEL_REVISION)
masks: dict[str, dict[str, Any]] = {}

# ── Lazy warmup ────────────────────────────────────────────────────────────────
# Workers register with RunPod immediately (fast boot), then load TRIBE + atlases
# on the first incoming job. This avoids RunPod's ~3-minute worker-init timeout
# that killed workers while they were downloading the TRIBE model from HuggingFace.
_warmup_done = threading.Event()
_warmup_lock = threading.Lock()


def _progress_emit(progress: Any, status: str, message: str) -> None:
    try:
        if progress:
            progress.emit(status, message)
    except Exception:
        pass


def _warm_start(progress: Any = None) -> None:
    global masks
    # [RP-09] Atlas files lookup
    atlas_exists = os.path.isdir(ATLAS_DIR)
    print(f"[RP-09] atlas_lookup: dir={ATLAS_DIR} exists={atlas_exists}", flush=True)
    log.info("[RP-09] atlas_lookup: dir=%s exists=%s", ATLAS_DIR, atlas_exists)
    _progress_emit(progress, "atlas_lookup", f"Checking atlas files: exists={atlas_exists}")
    masks = build_vertex_masks(atlas_dir=ATLAS_DIR)

    # [RP-10] GPU detection — done inside detect_runtime_profile() via torch.cuda.is_available()
    try:
        import torch  # type: ignore
        _cuda = torch.cuda.is_available()
        _gpu_name = torch.cuda.get_device_name(0) if _cuda else "none"
    except Exception:
        _cuda = False
        _gpu_name = "torch-unavailable"
    print(f"[RP-10] gpu_detect: cuda={_cuda} device={_gpu_name}", flush=True)
    log.info("[RP-10] gpu_detect: cuda=%s device=%s", _cuda, _gpu_name)
    _progress_emit(progress, "gpu_detected", f"GPU detected: {_gpu_name}" if _cuda else "No CUDA GPU detected.")

    # [RP-11] TRIBE model download/load begins.  TribeService.load() does both:
    # downloads the safetensors from HF (or hits cache) and moves them to GPU.
    print("[RP-11] tribe_load_started", flush=True)
    log.info("[RP-11] tribe_load_started: revision=%s", tribe_service.model_revision)
    _progress_emit(progress, "tribe_load_started", "Loading the TRIBE model...")
    try:
        tribe_service.load()
    except Exception as exc:
        # [RP-13] TRIBE load FAILED — emit the code with a short cause so it
        # is greppable in the worker logs even before the traceback prints.
        print(f"[RP-13] tribe_load_FAILED err={type(exc).__name__}: {str(exc)[:200]}", flush=True)
        log.exception("[RP-13] tribe_load_FAILED")
        _progress_emit(
            progress,
            "tribe_load_failed",
            f"TRIBE model load failed: {type(exc).__name__}: {exc}",
        )
        raise
    # If we got here, both the download (RP-12) and the GPU placement (RP-13) succeeded.
    print("[RP-12] tribe_download_or_cache_ok", flush=True)
    print("[RP-13] tribe_loaded_on_gpu_ok", flush=True)
    log.info("[RP-12] tribe_download_or_cache_ok")
    log.info("[RP-13] tribe_loaded_on_gpu_ok")
    _progress_emit(progress, "tribe_loaded", "TRIBE model loaded.")


def _ensure_warm(progress: Any = None) -> None:
    """Load TRIBE + masks the first time a job arrives. Thread-safe one-shot.

    Gemma is kicked off in a daemon background thread so it can load in
    parallel while TRIBE initialises on the main thread. Gemma failure is
    non-fatal — the job still runs, just without LLM-generated content.
    """
    if _warmup_done.is_set():
        return
    with _warmup_lock:
        if _warmup_done.is_set():
            return  # another thread finished while we waited for the lock
        log.info("lazy_warmup: starting on first job (TRIBE + atlases on main thread)")
        _progress_emit(progress, "warmup_started", "Starting first-run model warmup...")
        # [RP-14] Gemma background load kicked off.  Non-blocking — the main
        # thread continues with TRIBE.  Gemma failure does not fail the job.
        print("[RP-14] gemma_bg_thread_start", flush=True)
        log.info("[RP-14] gemma_bg_thread_start")
        _progress_emit(progress, "content_model_warmup_started", "Preparing the content model client...")
        llm_thread = threading.Thread(
            target=_warm_llm_background, daemon=True, name="llm-warmup"
        )
        llm_thread.start()
        _warm_start(progress)
        _warmup_done.set()
        # [RP-15] Main-thread warmup is complete.  Worker is now hot and can
        # process the rest of the current job and any follow-up jobs without
        # re-loading TRIBE.
        print("[RP-15] warmup_complete_main_thread", flush=True)
        log.info("[RP-15] warmup_complete_main_thread — TRIBE ready, Anthropic HTTP client ready in background")
        _progress_emit(progress, "warmup_complete", "Model warmup complete.")


def _warm_llm_background() -> None:
    """Instantiate the production content backend in a background thread.

    Post-Gemma-migration this is a tiny op (Anthropic HTTP client construction,
    no model weights to load). We keep the background-thread pattern only so
    the first job sees a ready manager without a synchronous startup cost,
    and so the audit log shows which backend booted.
    """
    try:
        from backend.results.lib.model_manager import use_real_content_model, get_model_manager
        use_real_content_model(per_slot_timeout_seconds=45.0)
        mgr = get_model_manager()
        backend_name = type(mgr.backend).__name__
        model_id = getattr(mgr.backend, "model_id", "?")
        log.info("content_model_warmup: %s ready (default model_id=%s)", backend_name, model_id)
    except Exception as exc:
        log.warning("content_model_warmup failed (non-fatal, will retry on first job): %s: %s", type(exc).__name__, exc)


def _download_to_temp(url: str, blob_token: str = "") -> str:
    suffix = os.path.splitext(url.split("?", 1)[0])[1] or ".bin"
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        headers = {"authorization": f"Bearer {blob_token}"} if blob_token else None
        with httpx.stream("GET", url, headers=headers, timeout=60.0) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes():
                if not chunk:
                    continue
                handle.write(chunk)
        handle.close()
        return handle.name
    except Exception:
        handle.close()
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def _filename_from_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        return unquote(os.path.basename(parsed.path)) or ""
    except Exception:
        return ""


def _warnings_for_text(text_a: str, text_b: str) -> list[str]:
    warnings: list[str] = []
    words_a = len([w for w in text_a.strip().split() if w])
    words_b = len([w for w in text_b.strip().split() if w])
    if words_a < 3 or words_b < 3:
        warnings.append("Very short text may produce unreliable results")
    return warnings


def _coerce_prediction_output(output: Any) -> tuple[np.ndarray, Any, dict[str, Any]]:
    if not (isinstance(output, tuple) and len(output) == 3):
        raise ValueError(f"Unexpected prediction output shape: {type(output).__name__}")
    preds, segments, timing = output
    return preds, segments, timing


def _pipeline_label(modality: str) -> str:
    """Honest description of which pre-encoding pipeline ran.

    Replaces the old `text_to_speech: True` flag, which lied for audio/video
    (those skip TTS entirely — real audio goes straight to WhisperX, video is
    FFmpeg-extracted frames + audio).
    """
    if modality == "text":
        return "text_to_speech"
    if modality == "audio":
        return "audio_direct"
    return "video_frames_audio"


def _generate_results_content(
    *,
    job_id: str,
    scores_a: dict[str, dict[str, Any]],
    scores_b: dict[str, dict[str, Any]],
    transcript_segments_a: list[dict[str, Any]],
    transcript_segments_b: list[dict[str, Any]],
    duration_a_s: float,
    duration_b_s: float,
    title_a: str,
    title_b: str,
    progress: Any = None,
) -> dict[str, Any] | None:
    """Run the LLaMA-driven content pipeline using the same model TRIBE just used.

    Soft-fails: if anything goes wrong, returns None and the page falls back to
    its built-in stub copy. The brain prediction payload is still returned to
    the user — content generation is purely additive.
    """
    if not job_id:
        return None
    try:
        if progress:
            progress.emit("generating_content", "Writing the page copy with Claude...")
        # score_predictions returns per-second 'timeseries' per dim already.
        # Adapter shape: {dim_name: [v0..vT]} per video.
        ts_a = {k: list(v.get("timeseries", [])) for k, v in scores_a.items()}
        ts_b = {k: list(v.get("timeseries", [])) for k, v in scores_b.items()}
        result = generate_content_for_worker(
            video_a_id=f"{job_id}_a",
            video_b_id=f"{job_id}_b",
            video_a_title=title_a or "Video A",
            video_b_title=title_b or "Video B",
            duration_a_s=duration_a_s,
            duration_b_s=duration_b_s,
            timeseries_a=ts_a,
            timeseries_b=ts_b,
            transcript_segments_a=transcript_segments_a,
            transcript_segments_b=transcript_segments_b,
            analysis_version=os.getenv("TRIBEV2_REVISION", "tribev2.live"),
        )
        return result
    except Exception as exc:  # noqa: BLE001
        # Don't break the existing flow if content gen fails. Log to stderr so
        # the failure surfaces in worker logs even though the soft-fail keeps
        # the user-facing brain payload alive.
        import traceback
        log.error("CONTENT_GEN_FAILED: %s: %s\n%s", type(exc).__name__, exc, traceback.format_exc())
        try:
            if progress:
                progress.emit(
                    "content_generation_failed",
                    f"Content generation failed (non-fatal): {type(exc).__name__}: {exc}",
                )
        except Exception:
            pass
        return {"comparison_id": "", "content": None, "error": f"{type(exc).__name__}: {exc}"}


def _build_response(
    *,
    transcript_a: str,
    transcript_b: str,
    transcript_segments_a: list[dict[str, Any]],
    transcript_segments_b: list[dict[str, Any]],
    modality: str,
    stage_times: dict[str, int],
    processing_time_ms: int,
    preds_a: np.ndarray,
    preds_b: np.ndarray,
    diff: dict[str, Any],
    dimension_rows: list[dict[str, Any]],
    vertex_delta: np.ndarray,
    vertex_a: np.ndarray,
    vertex_b: np.ndarray,
    median_a: float,
    median_b: float,
    warnings: list[str],
    media_durations: dict[str, float] | None = None,
    media_filenames: dict[str, str] | None = None,
    media_features: dict[str, Any] | None = None,
    job_id: str | None = None,
    results_content: dict[str, Any] | None = None,
    display_name_a: str = "",
    display_name_b: str = "",
    gpu_snapshots: list[dict] | None = None,
) -> dict[str, Any]:
    request_id = str(uuid.uuid4())
    if not job_id:
        job_id = str(uuid.uuid4())
    # insight_engine.py removed May 25 2026. Its 6-bucket template engine
    # was producing word-salad nobody reads (only results-legacy.html
    # consumed `insights.headline`, and we don't ship that page). Editorial
    # vocabulary it contained was ported to backend/results/lib/dimension_framing.py
    # and feeds into Wave 0 analyst pass via evidence_packet.as_prompt_block().
    heatmap = generate_heatmap_artifact(vertex_delta)
    meta: dict[str, Any] = {
        "model_revision": tribe_service.model_revision,
        "atlas": "HCP_MMP1.0",
        "method_primary": "signed_roi_contrast",
        "normalization": "within_stimulus_median",
        "pipeline": _pipeline_label(modality),
        "modality": modality,
        "transcript_a": transcript_a,
        "transcript_b": transcript_b,
        "transcript_a_length": len(transcript_a),
        "transcript_b_length": len(transcript_b),
        "transcript_segments_a": transcript_segments_a,
        "transcript_segments_b": transcript_segments_b,
        "text_a_timesteps": int(preds_a.shape[0]),
        "text_b_timesteps": int(preds_b.shape[0]),
        "processing_time_ms": processing_time_ms,
        "request_id": request_id,
        "job_id": job_id,
        "headline": build_headline(diff),
        "winner_summary": winner_summary(dimension_rows),
        "stage_times": stage_times,
        "median_a": median_a,
        "median_b": median_b,
        "heatmap": heatmap,
        "atlas_peak": describe_peak_abs_delta(vertex_delta),
        "dimensions_count": len(diff),
        # Display names — single source of truth for "what to call A and B" in
        # the UI. Auto-suggested on the launch page (and optionally edited by
        # the user) so we never fall back to "Stimulus A" / raw input text.
        "display_name_a": display_name_a or "Stimulus A",
        "display_name_b": display_name_b or "Stimulus B",
    }
    if modality == "text":
        # Back-compat: text mode keeps text_a/text_b at the meta top level
        # because the recall card and tests still read them.
        meta["text_a"] = transcript_a
        meta["text_b"] = transcript_b
        meta["text_a_length"] = len(transcript_a)
        meta["text_b_length"] = len(transcript_b)
    if media_durations is not None:
        meta["media_duration_a_s"] = float(media_durations.get("a", 0.0))
        meta["media_duration_b_s"] = float(media_durations.get("b", 0.0))
    if media_filenames is not None:
        # Codex's status endpoint already populates `media_name_a/b` from the
        # job-meta blob URL; we mirror those names here so a worker-only
        # consumer still gets the filename even without the job-meta merge.
        meta["media_filename_a"] = media_filenames.get("a", "")
        meta["media_filename_b"] = media_filenames.get("b", "")
        meta["media_name_a"] = media_filenames.get("a", "")
        meta["media_name_b"] = media_filenames.get("b", "")
    if media_features is not None:
        meta["media_features"] = media_features
    response: dict[str, Any] = {
        "diff": diff,
        "dimensions": dimension_rows,
        "vertex_delta_b64": f32_b64(vertex_delta),
        "vertex_a_b64": f32_b64(vertex_a),
        "vertex_b_b64": f32_b64(vertex_b),
        "warnings": warnings,
        "meta": meta,
    }
    # Results-page payload: schema-locked content.json shape so the new
    # results.html can render directly without any extra API call. Only
    # included when content generation succeeded.
    if results_content and results_content.get("content"):
        response["results_content"] = results_content["content"]
        meta["results_comparison_id"] = results_content.get("comparison_id")
    if results_content and results_content.get("error"):
        meta["results_content_error"] = results_content["error"]
    elif results_content is None:
        meta["results_content_error"] = "content_pipeline_returned_none"
    if results_content and results_content.get("content_audit"):
        meta["content_audit"] = results_content["content_audit"]
    if gpu_snapshots:
        meta["gpu_audit"] = {"snapshots": gpu_snapshots, "safe_inprocess_concurrency": 1}

    # ── Persistence ──────────────────────────────────────────────────────
    # Save the full response + the audit log into Upstash Redis so the link
    # keeps working long after RunPod's serverless cache forgets it (RunPod
    # purges in ~30-60 min). 30-day TTL by default. Best-effort: if Redis
    # is unreachable we just return the response normally — never let
    # persistence failure break the user's result.
    try:
        from runpod_worker.persistence import store_result, store_audit_log
        store_result(job_id, response)
        if results_content and results_content.get("audit_log_path"):
            store_audit_log(job_id, results_content["audit_log_path"])
    except Exception as exc:
        log.warning("persistence: store failed (non-fatal) job_id=%s err=%s: %s",
                    job_id, type(exc).__name__, exc)

    return response


def _unit_signal(value: Any, clamp: float = 2.0) -> float:
    """Map signed TRIBE activation onto the 0..1 UI scale used by single reports."""
    try:
        x = float(value)
    except (TypeError, ValueError):
        return 0.5
    if x > clamp:
        x = clamp
    if x < -clamp:
        x = -clamp
    return round((x + clamp) / (2.0 * clamp), 6)


def _single_dimension_rows(scores: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for key in sorted(scores.keys(), key=lambda name: UI_LABELS.get(name, name)):
        payload = scores[key]
        raw_series = payload.get("timeseries", []) or []
        unit_series = [_unit_signal(v) for v in raw_series]
        rows.append(
            {
                "key": key,
                "dimension": key,
                "label": UI_LABELS.get(key, key.replace("_", " ").title()),
                "tooltip": TOOLTIPS.get(key, ""),
                "meaning": USER_MEANING.get(key, ""),
                "score": _unit_signal(payload.get("normalized_signed_mean", 0.0)),
                "raw_signed_mean": float(payload.get("raw_signed_mean", 0.0) or 0.0),
                "normalized_signed_mean": float(payload.get("normalized_signed_mean", 0.0) or 0.0),
                "raw_abs_mean": float(payload.get("raw_abs_mean", 0.0) or 0.0),
                "timeseries": unit_series,
                "vertex_count": int(payload.get("vertex_count", 0) or 0),
            }
        )
    return rows


def _warnings_for_single_text(text: str) -> list[str]:
    warnings: list[str] = []
    words = len([w for w in text.strip().split() if w])
    if words < 3:
        warnings.append("Very short text may produce unreliable results")
    return warnings


def _text_waveform(text: str, bins: int = WAVEFORM_BINS) -> list[float]:
    """Deterministic display waveform for text inputs.

    Text runs now use offline speech internally for TRIBE, but the result page
    still benefits from a stable visual rhythm. This avoids a second network
    gTTS call whose only purpose was drawing bars.
    """
    tokens = [tok.strip() for tok in (text or "").split() if tok.strip()]
    if not tokens or bins <= 0:
        return []
    values = np.zeros(bins, dtype=np.float32)
    for idx in range(bins):
        start = int(idx * len(tokens) / bins)
        end = max(start + 1, int((idx + 1) * len(tokens) / bins))
        chunk = tokens[start:end]
        avg_len = sum(len(tok.strip(".,;:!?()[]{}\"'")) for tok in chunk) / max(len(chunk), 1)
        punctuation = sum(1 for tok in chunk if tok[-1:] in {".", "?", "!", ","})
        values[idx] = min(1.0, 0.18 + avg_len / 16.0 + punctuation * 0.06)
    peak = float(values.max()) or 1.0
    return [round(float(v / peak), 4) for v in values]


def _build_single_response(
    *,
    transcript: str,
    transcript_segments: list[dict[str, Any]],
    modality: str,
    stage_times: dict[str, int],
    processing_time_ms: int,
    preds: np.ndarray,
    scores: dict[str, dict[str, Any]],
    median: float,
    warnings: list[str],
    media_duration_s: float | None = None,
    media_filename: str = "",
    media_features: dict[str, Any] | None = None,
    job_id: str | None = None,
    display_name: str = "",
    gpu_snapshots: list[dict] | None = None,
) -> dict[str, Any]:
    request_id = str(uuid.uuid4())
    if not job_id:
        job_id = str(uuid.uuid4())
    label = display_name or media_filename or ("Text" if modality == "text" else modality.title())
    dimension_rows = _single_dimension_rows(scores)
    vertex = preds.mean(axis=0) / reference_scale(preds)
    try:
        heatmap = generate_heatmap_artifact(vertex)
    except Exception as exc:
        log.warning(
            "single_heatmap_failed job_id=%s modality=%s err=%s: %s",
            job_id,
            modality,
            type(exc).__name__,
            exc,
        )
        heatmap = {"format": "unavailable", "error": f"{type(exc).__name__}: {exc}"}
    meta: dict[str, Any] = {
        "run_type": "single",
        "model_revision": tribe_service.model_revision,
        "atlas": "HCP_MMP1.0",
        "method_primary": "signed_roi_activation",
        "normalization": "within_stimulus_median",
        "pipeline": _pipeline_label(modality),
        "modality": modality,
        "transcript": transcript,
        "text": transcript if modality == "text" else "",
        "transcript_length": len(transcript),
        "transcript_segments": transcript_segments,
        "text_timesteps": int(preds.shape[0]),
        "processing_time_ms": processing_time_ms,
        "request_id": request_id,
        "job_id": job_id,
        "stage_times": stage_times,
        "median": median,
        "heatmap": heatmap,
        "atlas_peak": describe_peak_abs_delta(vertex),
        "dimensions_count": len(dimension_rows),
        "display_name": label,
    }
    if modality != "text":
        meta["media_duration_s"] = float(media_duration_s or 0.0)
        meta["media_filename"] = media_filename
        meta["media_name"] = media_filename
    if media_features is not None:
        meta["media_features"] = media_features
    if gpu_snapshots:
        meta["gpu_audit"] = {"snapshots": gpu_snapshots, "safe_inprocess_concurrency": 1}

    response: dict[str, Any] = {
        "run_type": "single",
        "dimensions": dimension_rows,
        "vertex_b64": f32_b64(vertex),
        "vertex_delta_b64": f32_b64(vertex),
        "vertex_a_b64": "",
        "vertex_b_b64": "",
        "warnings": warnings,
        "meta": meta,
    }
    try:
        from runpod_worker.persistence import store_result
        ok = store_result(job_id, response)
        log.info(
            "[RP-24] single_result_persisted job_id=%s ok=%s modality=%s size_dims=%d",
            job_id,
            ok,
            modality,
            len(dimension_rows),
        )
    except Exception as exc:
        log.warning(
            "[RP-24] single_result_persist_failed job_id=%s err=%s: %s",
            job_id,
            type(exc).__name__,
            exc,
        )
    return response


def _run_text_single(
    text: str,
    *,
    job_id: str | None = None,
    display_name: str = "",
) -> dict[str, Any]:
    with _GPU_JOB_LOCK:
        return _run_text_single_locked(text, job_id=job_id, display_name=display_name)


def _run_text_single_locked(
    text: str,
    *,
    job_id: str | None = None,
    display_name: str = "",
) -> dict[str, Any]:
    started = time.perf_counter()
    gpu_snapshots: list[dict] = [_gpu_snapshot("before_tribe")]
    warnings = _warnings_for_single_text(text)
    progress = emitter_for(job_id)
    log.info("[RP-21] single_text_started job_id=%s text_len=%d", job_id, len(text))

    progress.emit("predicting_single", "Encoding the input through TRIBE v2...")
    preds, _, timing = _coerce_prediction_output(
        tribe_service.text_to_predictions(text, progress=progress)
    )
    log.info(
        "[RP-22] single_prediction_ok job_id=%s modality=text pred_shape=%s timing=%s",
        job_id,
        getattr(preds, "shape", None),
        timing,
    )

    progress.emit("computing_brain_response", "Computing the brain response...")
    scores, median = score_predictions(preds, masks)
    gpu_snapshots.append(_gpu_snapshot("after_single_score"))
    stage_times = {
        "events_ms": int(timing.get("events_ms", 0) or 0),
        "predict_ms": int(timing.get("predict_ms", 0) or 0),
    }
    processing_time_ms = int((time.perf_counter() - started) * 1000)
    runtime = float(max(int(preds.shape[0]), 1))
    transcript_segments = [{"start": 0.0, "end": runtime, "text": text}]
    result = _build_single_response(
        transcript=text,
        transcript_segments=transcript_segments,
        modality="text",
        stage_times=stage_times,
        processing_time_ms=processing_time_ms,
        preds=preds,
        scores=scores,
        median=median,
        warnings=warnings,
        media_features={"waveform": _text_waveform(text)},
        job_id=job_id,
        display_name=display_name or "Text",
        gpu_snapshots=gpu_snapshots,
    )
    log.info(
        "[RP-23] single_text_complete job_id=%s processing_ms=%d dimensions=%d",
        job_id,
        processing_time_ms,
        len(result.get("dimensions", [])),
    )
    return result


def _run_media_single(
    modality: str,
    media_url: str,
    *,
    job_id: str | None = None,
    blob_token: str = "",
    media_name: str = "",
    display_name: str = "",
) -> dict[str, Any]:
    with _GPU_JOB_LOCK:
        return _run_media_single_locked(
            modality,
            media_url,
            job_id=job_id,
            blob_token=blob_token,
            media_name=media_name,
            display_name=display_name,
        )


def _run_media_single_locked(
    modality: str,
    media_url: str,
    *,
    job_id: str | None = None,
    blob_token: str = "",
    media_name: str = "",
    display_name: str = "",
) -> dict[str, Any]:
    started = time.perf_counter()
    gpu_snapshots: list[dict] = [_gpu_snapshot("before_tribe")]
    warnings: list[str] = []
    progress = emitter_for(job_id)
    temp_files: set[str] = set()

    def _track(path: str) -> str:
        if path:
            temp_files.add(path)
        return path

    log.info(
        "[RP-21] single_media_started job_id=%s modality=%s has_blob_token=%s url_host=%s",
        job_id,
        modality,
        bool(blob_token),
        urlparse(media_url).netloc if media_url else "",
    )
    try:
        progress.emit("downloading_single", f"Downloading {modality}...")
        path = _track(_download_to_temp(media_url, blob_token))
        try:
            duration = float(probe_duration_seconds(path))
        except DurationProbeError as err:
            raise RuntimeError(f"MEDIA_DURATION_PROBE_FAILED: {err}") from err
        filename = media_name or _filename_from_url(media_url)
        media_features_payload: dict[str, Any] = {}
        try:
            if modality == "audio":
                progress.emit("waveform", "Computing audio waveform...")
                media_features_payload["waveform"] = audio_envelope(path)
            else:
                progress.emit("keyframes", "Extracting video keyframes...")
                media_features_payload["keyframes"] = video_keyframes(path)
        except Exception as err:
            warnings.append(f"Media feature extraction failed: {err}")
            log.warning(
                "single_media_features_failed job_id=%s modality=%s err=%s: %s",
                job_id,
                modality,
                type(err).__name__,
                err,
            )

        progress.emit("predicting_single", f"Encoding the {modality} through TRIBE v2...")
        if modality == "audio":
            preds, _, timing = _coerce_prediction_output(
                tribe_service.audio_to_predictions(path, progress=progress)
            )
        else:
            preds, _, timing = _coerce_prediction_output(
                tribe_service.video_to_predictions(path, progress=progress)
            )
        log.info(
            "[RP-22] single_prediction_ok job_id=%s modality=%s pred_shape=%s timing_keys=%s",
            job_id,
            modality,
            getattr(preds, "shape", None),
            sorted((timing or {}).keys()),
        )

        progress.emit("computing_brain_response", "Computing the brain response...")
        scores, median = score_predictions(preds, masks)
        gpu_snapshots.append(_gpu_snapshot("after_single_score"))
        stage_times = {
            "events_ms": int(timing.get("events_ms", 0) or 0),
            "predict_ms": int(timing.get("predict_ms", 0) or 0),
        }
        processing_time_ms = int((time.perf_counter() - started) * 1000)
        transcript = str(timing.get("transcript_text", "") or "")
        transcript_segments = list(timing.get("transcript_segments") or [])
        if not transcript and transcript_segments:
            transcript = " ".join(str(seg.get("text", "")).strip() for seg in transcript_segments if seg.get("text")).strip()
        if not transcript:
            warnings.append("No transcript text was returned for this media input.")
        result = _build_single_response(
            transcript=transcript,
            transcript_segments=transcript_segments,
            modality=modality,
            stage_times=stage_times,
            processing_time_ms=processing_time_ms,
            preds=preds,
            scores=scores,
            median=median,
            warnings=warnings,
            media_duration_s=duration,
            media_filename=filename,
            media_features=media_features_payload,
            job_id=job_id,
            display_name=display_name or filename or modality.title(),
            gpu_snapshots=gpu_snapshots,
        )
        log.info(
            "[RP-23] single_media_complete job_id=%s modality=%s processing_ms=%d dimensions=%d transcript_len=%d",
            job_id,
            modality,
            processing_time_ms,
            len(result.get("dimensions", [])),
            len(transcript),
        )
        return result
    finally:
        for path in temp_files:
            try:
                os.unlink(path)
            except OSError:
                pass


def _run_text(
    text_a: str,
    text_b: str,
    *,
    job_id: str | None = None,
    display_name_a: str = "",
    display_name_b: str = "",
) -> dict[str, Any]:
    with _GPU_JOB_LOCK:
        return _run_text_locked(text_a, text_b, job_id=job_id, display_name_a=display_name_a, display_name_b=display_name_b)


def _run_text_locked(
    text_a: str,
    text_b: str,
    *,
    job_id: str | None = None,
    display_name_a: str = "",
    display_name_b: str = "",
) -> dict[str, Any]:
    started = time.perf_counter()
    gpu_snapshots: list[dict] = [_gpu_snapshot("before_tribe")]
    warnings = _warnings_for_text(text_a, text_b)
    progress = emitter_for(job_id)

    progress.emit("predicting_version_a", "Encoding Version A through TRIBE v2...")
    preds_a, _, timing_a = _coerce_prediction_output(
        tribe_service.text_to_predictions(text_a, progress=progress)
    )
    progress.emit("predicting_version_b", "Encoding Version B through TRIBE v2...")
    preds_b, _, timing_b = _coerce_prediction_output(
        tribe_service.text_to_predictions(text_b, progress=progress)
    )

    progress.emit("computing_brain_contrast", "Computing brain contrast...")
    scores_a, median_a = score_predictions(preds_a, masks)
    scores_b, median_b = score_predictions(preds_b, masks)
    diff = compute_diff(scores_a, scores_b)
    dimension_rows = enrich_dimension_payload(diff)
    vertex_delta, vertex_a, vertex_b = compute_vertex_delta(preds_a, preds_b)
    stage_times = {
        "events_a_ms": int(timing_a.get("events_ms", 0) or 0),
        "predict_a_ms": int(timing_a.get("predict_ms", 0) or 0),
        "events_b_ms": int(timing_b.get("events_ms", 0) or 0),
        "predict_b_ms": int(timing_b.get("predict_ms", 0) or 0),
    }
    processing_time_ms = int((time.perf_counter() - started) * 1000)
    # Use TRIBE's per-second per-dim scores to drive the results-page content.
    # Text mode has no transcript segments — synthesise minimal ones from the inputs.
    runtime_a = float(preds_a.shape[0])
    runtime_b = float(preds_b.shape[0])
    text_segments_a = [{"start": 0, "end": runtime_a, "text": text_a}]
    text_segments_b = [{"start": 0, "end": runtime_b, "text": text_b}]
    title_a = display_name_a or text_a[:60] or "Stimulus A"
    title_b = display_name_b or text_b[:60] or "Stimulus B"

    media_features_payload: dict[str, Any] | None = {
        "waveform_a": _text_waveform(text_a),
        "waveform_b": _text_waveform(text_b),
    }
    gpu_snapshots.append(_gpu_snapshot("before_content_gen"))
    results_content = _generate_results_content(
        job_id=job_id or "",
        scores_a=scores_a,
        scores_b=scores_b,
        transcript_segments_a=text_segments_a,
        transcript_segments_b=text_segments_b,
        duration_a_s=runtime_a,
        duration_b_s=runtime_b,
        title_a=title_a,
        title_b=title_b,
        progress=progress,
    )
    gpu_snapshots.append(_gpu_snapshot("after_content_gen"))
    return _build_response(
        transcript_a=text_a,
        transcript_b=text_b,
        transcript_segments_a=[],
        transcript_segments_b=[],
        modality="text",
        stage_times=stage_times,
        processing_time_ms=processing_time_ms,
        preds_a=preds_a,
        preds_b=preds_b,
        diff=diff,
        dimension_rows=dimension_rows,
        vertex_delta=vertex_delta,
        vertex_a=vertex_a,
        vertex_b=vertex_b,
        median_a=median_a,
        median_b=median_b,
        warnings=warnings,
        media_features=media_features_payload,
        job_id=job_id,
        results_content=results_content,
        display_name_a=title_a,
        display_name_b=title_b,
        gpu_snapshots=gpu_snapshots,
    )


def _run_media(
    modality: str,
    media_url_a: str,
    media_url_b: str,
    *,
    job_id: str | None = None,
    blob_token: str = "",
    trim_to_shorter: bool = False,
    display_name_a: str = "",
    display_name_b: str = "",
) -> dict[str, Any]:
    with _GPU_JOB_LOCK:
        return _run_media_locked(
            modality, media_url_a, media_url_b,
            job_id=job_id, blob_token=blob_token, trim_to_shorter=trim_to_shorter,
            display_name_a=display_name_a, display_name_b=display_name_b,
        )


def _run_media_locked(
    modality: str,
    media_url_a: str,
    media_url_b: str,
    *,
    job_id: str | None = None,
    blob_token: str = "",
    trim_to_shorter: bool = False,
    display_name_a: str = "",
    display_name_b: str = "",
) -> dict[str, Any]:
    started = time.perf_counter()
    gpu_snapshots: list[dict] = [_gpu_snapshot("before_tribe")]
    warnings: list[str] = []
    progress = emitter_for(job_id)

    # Track every temp file we create so cleanup works regardless of which
    # step fails. Optional trimming may produce a `.trim` sibling.
    temp_files: set[str] = set()

    def _track(p: str) -> str:
        if p:
            temp_files.add(p)
        return p

    progress.emit("downloading_a", f"Downloading Version A {modality}...")
    path_a = _track(_download_to_temp(media_url_a, blob_token))
    try:
        progress.emit("downloading_b", f"Downloading Version B {modality}...")
        path_b = _track(_download_to_temp(media_url_b, blob_token))
    except Exception:
        for p in list(temp_files):
            try:
                os.unlink(p)
            except OSError:
                pass
        raise

    media_durations: dict[str, float] = {}
    media_filenames: dict[str, str] = {
        "a": _filename_from_url(media_url_a),
        "b": _filename_from_url(media_url_b),
    }
    media_features_payload: dict[str, Any] = {}
    try:
        progress.emit(
            "decoding_video" if modality == "video" else "decoding_audio",
            (
                "Decoding video + extracting frames..."
                if modality == "video"
                else "Decoding audio features..."
            ),
        )
        try:
            dur_a = probe_duration_seconds(path_a)
            dur_b = probe_duration_seconds(path_b)
        except DurationProbeError as err:
            raise RuntimeError(f"MEDIA_DURATION_PROBE_FAILED: {err}") from err
        media_durations = {"a": float(dur_a), "b": float(dur_b)}
        duration_delta = abs(dur_a - dur_b)
        if trim_to_shorter and duration_delta > 0.05:
            target = min(dur_a, dur_b)
            if dur_a > target:
                progress.emit("trimming_a", f"Trimming Version A to {target:.1f}s to match Version B...")
                path_a = _track(trim_to_duration(path_a, target))
                dur_a = target
            if dur_b > target:
                progress.emit("trimming_b", f"Trimming Version B to {target:.1f}s to match Version A...")
                path_b = _track(trim_to_duration(path_b, target))
                dur_b = target
            media_durations = {"a": float(dur_a), "b": float(dur_b)}
            warnings.append(
                f"Duration mismatch fixed by comparing the first {target:.1f}s of both stimuli."
            )
        elif duration_delta > MEDIA_SIMILARITY_SECONDS:
            warnings.append(
                f"Stimuli durations differ by {duration_delta:.1f}s; compared both full {modality} files without trimming."
            )

        # Pre-compute the modality-specific features the result page needs.
        # Done before prediction so they're cheap to skip on failure (they
        # don't block the actual contrast).
        try:
            if modality == "audio":
                progress.emit("waveform_a", "Computing audio waveform A...")
                wave_a = audio_envelope(path_a)
                progress.emit("waveform_b", "Computing audio waveform B...")
                wave_b = audio_envelope(path_b)
                media_features_payload = {
                    "waveform_a": wave_a,
                    "waveform_b": wave_b,
                }
            else:
                progress.emit("keyframes_a", "Extracting keyframes A...")
                keys_a = video_keyframes(path_a)
                progress.emit("keyframes_b", "Extracting keyframes B...")
                keys_b = video_keyframes(path_b)
                media_features_payload = {
                    "keyframes_a": keys_a,
                    "keyframes_b": keys_b,
                }
        except Exception as err:
            # Feature extraction is best-effort. Surface the failure as a
            # warning and continue — the result page renders empty states
            # for missing features rather than fake placeholders.
            warnings.append(f"Media feature extraction failed: {err}")

        if modality == "audio":
            preds_a, _, timing_a = _coerce_prediction_output(
                tribe_service.audio_to_predictions(path_a, progress=progress)
            )
            preds_b, _, timing_b = _coerce_prediction_output(
                tribe_service.audio_to_predictions(path_b, progress=progress)
            )
        else:
            preds_a, _, timing_a = _coerce_prediction_output(
                tribe_service.video_to_predictions(path_a, progress=progress)
            )
            preds_b, _, timing_b = _coerce_prediction_output(
                tribe_service.video_to_predictions(path_b, progress=progress)
            )

        progress.emit("computing_brain_contrast", "Computing brain contrast...")
        scores_a, median_a = score_predictions(preds_a, masks)
        scores_b, median_b = score_predictions(preds_b, masks)
        diff = compute_diff(scores_a, scores_b)
        dimension_rows = enrich_dimension_payload(diff)
        vertex_delta, vertex_a, vertex_b = compute_vertex_delta(preds_a, preds_b)
        stage_times = {
            "events_a_ms": int(timing_a.get("events_ms", 0) or 0),
            "predict_a_ms": int(timing_a.get("predict_ms", 0) or 0),
            "events_b_ms": int(timing_b.get("events_ms", 0) or 0),
            "predict_b_ms": int(timing_b.get("predict_ms", 0) or 0),
        }

        # Real per-timestep peak-Δ moment detection — replaces the old
        # buildMoments() template that fabricated identical "{label}
        # changes at beat N" prose for every job.
        # Use Version-B duration as the timeline anchor (matches the
        # frontend, which scrubs along max(durA, durB)).
        anchor_duration = max(dur_a, dur_b) if dur_b else dur_a
        try:
            moments = peak_moments(
                preds_a, preds_b, masks,
                duration_seconds=anchor_duration,
                top_k=4,
            )
        except Exception:
            moments = []
        if moments:
            media_features_payload["moments"] = moments

        # Co-activation pattern detection. Reads the published-evidence
        # pattern definitions from frontend_new/data/pattern-definitions.json
        # (single source of truth — same file the frontend's Pattern Card
        # UI reads) and returns per-side instances with start/end/peak.
        try:
            from backend.pattern_detector import detect_patterns_both_sides
            patterns_payload = detect_patterns_both_sides(
                dimension_rows,
                duration_a_s=dur_a,
                duration_b_s=dur_b,
            )
            if patterns_payload.get("a") or patterns_payload.get("b"):
                media_features_payload["patterns"] = patterns_payload
        except Exception as err:
            warnings.append(f"Pattern detection failed: {err}")

        # Connectivity map: pairwise Pearson correlation between the
        # 7 cortical-system timeseries, integration / parallel scores,
        # hub + isolated node, plus the B−A delta matrix.
        # Cheap (21 correlations on ~30 floats); never blocks the result.
        try:
            from backend.connectivity import compute_connectivity_both_sides
            connectivity_payload = compute_connectivity_both_sides(dimension_rows)
            media_features_payload["connectivity"] = connectivity_payload
        except Exception as err:
            warnings.append(f"Connectivity map failed: {err}")

        # Structural Skeleton (Prompt 1, trimmed): when the *content*
        # changes across text / visual / audio. Uses transcript segments,
        # waveform RMS bins, and keyframe times we already extracted —
        # no new ML, no LLM summaries, no audio classifier (deferred to
        # v2 — see /methodology/skeleton).
        try:
            from backend.structural_skeleton import build_skeleton_both_sides
            transcripts_a_for_skeleton = list(timing_a.get("transcript_segments") or [])
            transcripts_b_for_skeleton = list(timing_b.get("transcript_segments") or [])
            skeleton_payload = build_skeleton_both_sides(
                transcripts_a_for_skeleton,
                transcripts_b_for_skeleton,
                media_features_payload.get("waveform_a") or [],
                media_features_payload.get("waveform_b") or [],
                media_features_payload.get("keyframes_a") or [],
                media_features_payload.get("keyframes_b") or [],
                duration_a_s=dur_a,
                duration_b_s=dur_b,
            )
            media_features_payload["skeleton"] = skeleton_payload
        except Exception as err:
            warnings.append(f"Structural skeleton failed: {err}")

        processing_time_ms = int((time.perf_counter() - started) * 1000)
        # LLaMA-driven results-page content (uses TRIBE's per-second per-dim scores).
        transcript_text_a = str(timing_a.get("transcript_text", "") or "")
        transcript_text_b = str(timing_b.get("transcript_text", "") or "")
        transcript_segs_a = list(timing_a.get("transcript_segments") or [])
        transcript_segs_b = list(timing_b.get("transcript_segments") or [])
        # Resolve display titles. Priority:
        #   1. user-supplied display_name_a/b from launch page (auto-suggested, editable)
        #   2. media filename without extension (best-effort)
        #   3. transcript first 60 chars
        #   4. generic fallback
        def _strip_ext(name: str) -> str:
            if not name:
                return ""
            return name.rsplit(".", 1)[0] if "." in name else name
        title_a = (
            display_name_a
            or _strip_ext((media_filenames or {}).get("a", ""))
            or transcript_text_a[:60]
            or ("Stimulus A" if modality != "video" else "Video A")
        )
        title_b = (
            display_name_b
            or _strip_ext((media_filenames or {}).get("b", ""))
            or transcript_text_b[:60]
            or ("Stimulus B" if modality != "video" else "Video B")
        )
        gpu_snapshots.append(_gpu_snapshot("before_content_gen"))
        results_content = _generate_results_content(
            job_id=job_id or "",
            scores_a=scores_a,
            scores_b=scores_b,
            transcript_segments_a=transcript_segs_a,
            transcript_segments_b=transcript_segs_b,
            duration_a_s=float(media_durations.get("a", dur_a) if media_durations else dur_a),
            duration_b_s=float(media_durations.get("b", dur_b) if media_durations else dur_b),
            title_a=title_a,
            title_b=title_b,
            progress=progress,
        )
        gpu_snapshots.append(_gpu_snapshot("after_content_gen"))
        return _build_response(
            transcript_a=transcript_text_a,
            transcript_b=transcript_text_b,
            transcript_segments_a=transcript_segs_a,
            transcript_segments_b=transcript_segs_b,
            modality=modality,
            stage_times=stage_times,
            processing_time_ms=processing_time_ms,
            preds_a=preds_a,
            preds_b=preds_b,
            diff=diff,
            dimension_rows=dimension_rows,
            vertex_delta=vertex_delta,
            vertex_a=vertex_a,
            vertex_b=vertex_b,
            median_a=median_a,
            median_b=median_b,
            warnings=warnings,
            media_durations=media_durations,
            media_filenames=media_filenames,
            media_features=media_features_payload,
            job_id=job_id,
            results_content=results_content,
            display_name_a=title_a,
            display_name_b=title_b,
            gpu_snapshots=gpu_snapshots,
        )
    finally:
        for path in temp_files:
            try:
                os.unlink(path)
            except OSError:
                pass


def handler(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("input", {})
    # RunPod assigns the outer job id; surface it so the worker can write
    # progress events to the same `events:{job_id}` key the status endpoint
    # reads. Falls back to payload.job_id (older callers) or "" (no events).
    job_id = (
        event.get("id")
        or payload.get("job_id")
        or ""
    )
    if isinstance(job_id, str):
        job_id = job_id.strip()
    else:
        job_id = ""
    progress = emitter_for(job_id)
    run_type = str(payload.get("run_type") or payload.get("runType") or "diff").strip().lower()
    if run_type not in {"single", "diff"}:
        run_type = "diff"
    mode = (payload.get("mode") or "text").strip().lower()
    _shape = {
        "run_type": run_type,
        "mode": mode or "?",
        "has_text": bool(payload.get("text")),
        "has_text_a": bool(payload.get("text_a")),
        "has_text_b": bool(payload.get("text_b")),
        "has_media_url": bool(payload.get("media_url")),
        "has_media_url_a": bool(payload.get("media_url_a")),
        "has_media_url_b": bool(payload.get("media_url_b")),
        "display_name_len": len(str(payload.get("display_name") or "")),
        "display_name_a_len": len(str(payload.get("display_name_a") or "")),
        "display_name_b_len": len(str(payload.get("display_name_b") or "")),
    }
    print(f"[RP-16] job_received_shape: {_shape}", flush=True)
    log.info("[RP-16] job_received_shape: job_id=%s shape=%s", job_id, _shape)
    progress.emit("worker_started", "Worker started, preparing the model...")
    try:
        _ensure_warm(progress)  # no-op after first call; blocks until TRIBE + masks ready
        print(f"[RP-17] job_validated_for_route: run_type={run_type} mode={mode}", flush=True)
        log.info("[RP-17] job_validated_for_route: job_id=%s run_type=%s mode=%s", job_id, run_type, mode)
        blob_token = (payload.get("blob_token") or "").strip()
        trim_to_shorter = bool(payload.get("trim_to_shorter"))
        progress.emit("inputs_validated", "Inputs validated; loading data...")

        if run_type == "single":
            display_name = (payload.get("display_name") or payload.get("display_name_a") or "").strip()
            if mode == "text":
                text = (payload.get("text") or payload.get("text_a") or "").strip()
                if not text:
                    raise ValueError("text is required for run_type=single mode=text")
                result = _run_text_single(text=text, job_id=job_id, display_name=display_name)
                progress.emit("done", "Done")
                return result
            if mode not in {"audio", "video"}:
                raise ValueError("mode must be one of: text, audio, video")
            media_url = (payload.get("media_url") or payload.get("media_url_a") or "").strip()
            if not media_url:
                raise ValueError("media_url is required for run_type=single audio/video mode")
            media_name = (payload.get("media_name") or payload.get("media_name_a") or "").strip()
            result = _run_media_single(
                mode,
                media_url=media_url,
                job_id=job_id,
                blob_token=blob_token,
                media_name=media_name,
                display_name=display_name,
            )
            progress.emit("done", "Done")
            return result

        # User-supplied display names (auto-suggested on the launch page, optionally
        # edited). When present, the worker uses them as titles instead of the raw
        # input text or filename. Stored on result.meta.display_name_a/b so the
        # whole UI can read them from one place.
        display_name_a = (payload.get("display_name_a") or "").strip()
        display_name_b = (payload.get("display_name_b") or "").strip()
        if mode == "text":
            text_a = (payload.get("text_a") or "").strip()
            text_b = (payload.get("text_b") or "").strip()
            if not text_a or not text_b:
                raise ValueError("text_a and text_b are required for mode=text")
            result = _run_text(
                text_a=text_a, text_b=text_b, job_id=job_id,
                display_name_a=display_name_a, display_name_b=display_name_b,
            )
            progress.emit("done", "Done")
            return result
        if mode not in {"audio", "video"}:
            raise ValueError("mode must be one of: text, audio, video")
        media_url_a = (payload.get("media_url_a") or "").strip()
        media_url_b = (payload.get("media_url_b") or "").strip()
        if not media_url_a or not media_url_b:
            raise ValueError("media_url_a and media_url_b are required for audio/video mode")
        result = _run_media(
            mode,
            media_url_a=media_url_a,
            media_url_b=media_url_b,
            job_id=job_id,
            blob_token=blob_token,
            trim_to_shorter=trim_to_shorter,
            display_name_a=display_name_a,
            display_name_b=display_name_b,
        )
        progress.emit("done", "Done")
        return result
    except Exception as exc:
        log.exception(
            "[RP-99] worker_job_failed job_id=%s run_type=%s mode=%s err=%s: %s",
            job_id,
            run_type,
            mode,
            type(exc).__name__,
            exc,
        )
        try:
            progress.emit("worker_failed", f"Worker failed: {type(exc).__name__}: {exc}")
        except Exception:
            pass
        raise


# Direct execution path for local/manual worker smoke tests. The production
# RunPod image starts `runpod_worker/handler.py`, which is a tiny bootstrap that
# imports this module only after RunPod has registered the worker as ready.
if __name__ == "__main__":
    log.info("worker_impl: direct start — TRIBE will load on first job")
    runpod.serverless.start({"handler": handler})
