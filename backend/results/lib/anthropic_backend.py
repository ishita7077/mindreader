"""Anthropic-API content-generation backend.

Replaces `LoadedTransformersBackend` (Gemma 1B) as the only production
content generator. Implements `ModelBackend` Protocol from model_manager.

Architecture notes:
  - One backend instance per worker.
  - Per-call model selection: each GenerationRequest carries a slot_address;
    we route to Sonnet 4.6 or Haiku 4.5 via `model_routing.model_for_slot`.
  - Prompt caching is opt-in per request via `req.prompt_blocks`. When
    blocks are supplied, the static prefix is wrapped with
    `cache_control={"type":"ephemeral","ttl":"1h"}` so subsequent calls
    with the same prefix pay the 90% cached rate. When only `req.prompt`
    (string) is supplied (e.g. repair attempts), no caching is requested.
  - Spend cap enforced BEFORE each call via `spend_tracker.assert_under_cap`.
  - Token usage from each response is recorded via `spend_tracker.record_spend`.
  - Retries on transient network failures are handled BY THE CALLER (the
    slot loop in base.py / analysis_brief.py). This backend either returns
    a clean response or raises a typed exception — never silently retries.

Failure modes this backend surfaces (caller decides what to do):
  - `SpendCapExceeded`     → daily cap hit; downstream slots should
                              abort-fast (worker returns spend_cap_reached).
  - `AnthropicRateLimited` → 429; caller may pause + retry.
  - `AnthropicRefused`     → response stop_reason=="refusal"; fall back.
  - `AnthropicAPIError`    → any other 4xx/5xx; treated as model failure.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

from .model_manager import GenerationRequest, GenerationResponse
from .model_routing import model_for_slot, estimate_cost_usd
from .spend_tracker import SpendCapExceeded, assert_under_cap, record_spend, get_cap_usd, get_today_spend_usd

log = logging.getLogger(__name__)


# ────────────────────────────────────────────────────────────
# Typed exception hierarchy — caller pattern-matches these.
# ────────────────────────────────────────────────────────────

class AnthropicBackendError(Exception):
    """Base for any Anthropic-side failure surfaced to the slot loop."""


class AnthropicRateLimited(AnthropicBackendError):
    """HTTP 429 from Anthropic. Caller may backoff + retry."""

    def __init__(self, retry_after_seconds: Optional[float] = None) -> None:
        self.retry_after_seconds = retry_after_seconds
        super().__init__(f"rate limited (retry_after={retry_after_seconds}s)")


class AnthropicRefused(AnthropicBackendError):
    """Response had stop_reason='refusal'. Content was rejected by the model."""


class AnthropicAPIError(AnthropicBackendError):
    """Any other API failure (4xx non-429, 5xx, network, timeout)."""


# ────────────────────────────────────────────────────────────
# Backend
# ────────────────────────────────────────────────────────────

class AnthropicBackend:
    """Implements model_manager.ModelBackend over the Anthropic SDK."""

    # The "primary" model_id reported via the Protocol attribute. The
    # backend may actually call multiple models (Sonnet + Haiku). We
    # report Haiku here as the default; per-slot model_id is logged in
    # raw_slot.json.model.model_id from each response.
    model_id: str = "claude-haiku-4-5"
    model_revision: str | None = None

    def __init__(self, *, api_key: str | None = None, request_timeout_s: float = 45.0) -> None:
        # Lazy import keeps the package optional for callers that only use
        # the stub backend (CLI smoke tests, etc.).
        try:
            from anthropic import AsyncAnthropic  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "anthropic package missing — pip install anthropic in the worker image"
            ) from exc

        key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
        if not key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY env var is unset — set it on the RunPod template"
            )

        self._client = AsyncAnthropic(api_key=key, timeout=request_timeout_s)
        self._request_timeout_s = request_timeout_s
        log.info("AnthropicBackend ready (timeout=%.0fs)", request_timeout_s)

    # ── ModelBackend Protocol no-ops (no GPU) ────────────────────────
    def vram_peak_mb(self) -> float | None:
        return None

    def reset_vram_peak(self) -> None:
        return None

    # ── Main entry point ─────────────────────────────────────────────
    async def generate(self, req: GenerationRequest) -> GenerationResponse:
        """Send one prompt to Anthropic. Raise on any non-success path.

        Resolves model per-slot via model_routing. Wraps the static
        prefix in `cache_control` when `req.prompt_blocks` is supplied.
        Records token spend after a successful response.
        """
        # 0. Spend gate — raises SpendCapExceeded before we burn another dollar.
        assert_under_cap()

        # 1. Pick model based on slot. Falls back to Haiku if slot_address
        #    is missing or unrecognised.
        model_id = model_for_slot(getattr(req, "slot_address", "") or "")

        # 2. Build the messages payload. If structured prompt_blocks are
        #    available, use them (with cache_control on the first block).
        #    Otherwise fall back to a single text block from req.prompt.
        content_blocks = self._build_content_blocks(req)

        # 3. Make the call.
        start = time.perf_counter()
        try:
            resp = await self._client.messages.create(
                model=model_id,
                max_tokens=req.max_new_tokens,
                temperature=req.temperature,
                messages=[{"role": "user", "content": content_blocks}],
                # extra_headers for cache_control 1h TTL — header-level beta opt-in.
                extra_headers={"anthropic-beta": "prompt-caching-2024-07-31"},
            )
        except Exception as exc:
            # Normalize SDK exception types to ours so the slot loop can
            # pattern-match without depending on the anthropic package.
            err_str = str(exc).lower()
            err_type = type(exc).__name__
            if "429" in err_str or "rate" in err_type.lower() or "ratelimit" in err_type.lower():
                raise AnthropicRateLimited() from exc
            raise AnthropicAPIError(f"{err_type}: {exc}") from exc

        latency_ms = int((time.perf_counter() - start) * 1000)

        # 4. Check for refusal stop_reason.
        if getattr(resp, "stop_reason", None) == "refusal":
            raise AnthropicRefused(
                f"model {model_id} refused to generate for slot "
                f"{getattr(req, 'slot_address', '?')}"
            )

        # 5. Extract text.
        text = self._extract_text(resp)

        # 6. Record spend from usage block.
        usage = getattr(resp, "usage", None)
        input_tokens = int(getattr(usage, "input_tokens", 0)) if usage else 0
        cache_read_tokens = int(getattr(usage, "cache_read_input_tokens", 0) or 0) if usage else 0
        cache_write_tokens = int(getattr(usage, "cache_creation_input_tokens", 0) or 0) if usage else 0
        output_tokens = int(getattr(usage, "output_tokens", 0)) if usage else 0

        cost = estimate_cost_usd(
            model_id,
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
            output_tokens=output_tokens,
        )
        new_total, cap, crossed_warning = record_spend(cost)
        if crossed_warning:
            log.warning(
                "spend warning: today=$%.4f / cap=$%.2f (slot=%s)",
                new_total, cap, getattr(req, "slot_address", "?"),
            )

        # 7. Return Protocol-compliant response.
        return GenerationResponse(
            text=text,
            latency_ms=latency_ms,
            tokens_input=input_tokens + cache_read_tokens + cache_write_tokens,
            tokens_output=output_tokens,
            model_id=model_id,
            model_revision=None,
            transformers_version=None,
            torch_version=None,
        )

    # ── Helpers ──────────────────────────────────────────────────────

    def _build_content_blocks(self, req: GenerationRequest) -> list[dict[str, Any]]:
        """Build the messages[0].content list for the API call.

        Priority:
          1. If req has `prompt_blocks` attribute (list of dicts), use it.
             The base.py slot.run() supplies this with cache_control already
             attached to static blocks.
          2. Otherwise fall back to a single text block from req.prompt.
             Used for repair-attempt prompts in base.py:165 that are
             dynamic per-call and don't benefit from caching.
        """
        blocks = getattr(req, "prompt_blocks", None)
        if blocks and isinstance(blocks, list):
            return blocks
        return [{"type": "text", "text": req.prompt}]

    def _extract_text(self, resp: Any) -> str:
        """Pull the first text content block from an Anthropic response."""
        try:
            for block in resp.content:
                if getattr(block, "type", None) == "text":
                    return getattr(block, "text", "") or ""
        except Exception:
            pass
        return ""


# ────────────────────────────────────────────────────────────
# Convenience: instantiate-once helper for the singleton.
# ────────────────────────────────────────────────────────────

def make_default_backend() -> AnthropicBackend:
    """Build the production AnthropicBackend with default settings.

    Called once at worker startup. Raises immediately if
    ANTHROPIC_API_KEY is missing — fail fast at boot is better than
    failing on the first job.
    """
    return AnthropicBackend(request_timeout_s=45.0)
