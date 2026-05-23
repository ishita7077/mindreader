"""ModelManager — centralised access to the LLM (audit point #2).

Why this exists: every slot needs to call LLaMA, but if we let each slot
directly invoke the model we get GPU memory pressure, parallel queue thrash,
and silent latency spikes when TRIBE inference is also running.

ModelManager:
  * owns the single LLaMA instance (lazy load)
  * caps parallel slot generations
  * enforces a per-slot timeout
  * logs model_load_ms, generation_ms, peak_vram_mb (when GPU available)
  * queues content generation behind cortical inference (hook in scheduler)

Phase 0 ships a working interface with:
  * lazy load + asyncio.Semaphore concurrency cap
  * timeout enforcement via asyncio.wait_for
  * a deterministic-mode flag (do_sample=False) for production
  * a StubBackend for development without a GPU

Phase 1 wires the real transformers backend in.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol


log = logging.getLogger(__name__)


# ────────────────────────────────────────────────────────────
# Generation request / response
# ────────────────────────────────────────────────────────────

@dataclass
class GenerationRequest:
    """One model call. Slot runner builds these.

    Anthropic-era fields (additions, all optional / non-breaking):
      - slot_address: which slot this call is for; AnthropicBackend uses
        it to pick Sonnet vs Haiku via model_routing.
      - prompt_blocks: structured prompt for caching (list of dicts with
        cache_control on static parts). When supplied, takes precedence
        over `prompt` for the AnthropicBackend. The `prompt` string is
        still populated for the audit log + raw_slot.json archive.
    """
    prompt: str
    max_new_tokens: int
    temperature: float = 1.0
    top_p: float = 0.95
    top_k: int = 64
    do_sample: bool = True
    seed: int = 0                                       # No-op on Anthropic; kept for audit/raw_slot compatibility.
    stop: list[str] = field(default_factory=list)
    # ── Anthropic-era additions ────────────────────────────────────────
    slot_address: str = ""                              # Routes to Sonnet/Haiku via model_routing.
    prompt_blocks: list[dict] | None = None             # For prompt-caching; None = use `prompt` as-is.


@dataclass
class GenerationResponse:
    text: str
    latency_ms: int
    tokens_input: int
    tokens_output: int
    model_id: str
    model_revision: str | None
    transformers_version: str | None = None
    torch_version: str | None = None


# ────────────────────────────────────────────────────────────
# Backend protocol — swap real LLaMA in Phase 1
# ────────────────────────────────────────────────────────────

class ModelBackend(Protocol):
    model_id: str
    model_revision: str | None

    async def generate(self, req: GenerationRequest) -> GenerationResponse:
        ...

    def vram_peak_mb(self) -> float | None:
        """Peak VRAM since last reset, in MB. None on CPU-only runs."""
        ...

    def reset_vram_peak(self) -> None:
        ...


class StubBackend:
    """In-process backend for dev / pre-LLaMA testing — no GPU, no model load.

    Returns slot-aware deterministic placeholder text so the full pipeline can be
    exercised end-to-end without a model. The stub recognises which slot called
    it by scanning the prompt for the slot-prompt's opening line, then returns
    fixture content that passes the slot's validator.

    When the real LLaMA backend lands (Phase 1.5), it implements the same
    `ModelBackend` protocol and is swapped in via `set_model_manager()`.
    """

    model_id = "stub-llama-3.2-3b-instruct"
    model_revision = "stub-v0"

    # Slot-detection markers — unique generation-line phrases that appear in
    # exactly one slot prompt. Stops cross-matching across slots (where a body
    # prompt mentions "hero headline" in its description).
    _STUB_FIXTURES: tuple[tuple[str, str], ...] = (
        # Headline: 2 short sentences, ≤10 words each.
        ("Generate 5 candidate headlines",   "B reaches the gut. A builds the argument."),
        # Body: 2-3 sentences, ≤60 words, supports headline + hooks the reader.
        ("Generate 3 candidate body",        "These two videos pull the cortex apart in opposite directions. One arrives in the chest before deliberation, the other builds in the head as you follow the argument. The systems they recruit barely overlap — keep scrolling for the chord-by-chord breakdown."),
        # Frame 02 sub.
        ("Frame 02",                          "Two recipes unfold across the runtime. A chord fires when two systems cross threshold at the same second and hold for at least one or two more. Watch where each video's chords land — the timing IS the strategy."),
        # Recipe match rationale (deterministic match writes the rationale).
        ("rationale for a Brain Diff recipe","System means landed in the spec'd range and the characteristic chords appeared at the right times across the runtime."),
        # Recipe description: 2 sentences, ≤35 words, ends with *Built for X.*
        ("Generate 2 candidate descriptions","Gradual attention building over the runtime, deep language and memory engagement, climax in a Reasoning Beat at 0:32. *Built for retention.*"),
        # Coupling callout: 2 sentences, ≤38 words.
        ("Generate 2 candidate callouts",    "Memory and Language systems rose together across the runtime. The two systems fired as a team — the signature of content built to stick."),
    )

    async def generate(self, req: GenerationRequest) -> GenerationResponse:
        start = time.perf_counter()
        await asyncio.sleep(0.005)

        text = self._fixture_for_prompt(req.prompt)

        latency_ms = int((time.perf_counter() - start) * 1000)
        return GenerationResponse(
            text=text,
            latency_ms=latency_ms,
            tokens_input=len(req.prompt.split()),
            tokens_output=len(text.split()),
            model_id=self.model_id,
            model_revision=self.model_revision,
        )

    def _fixture_for_prompt(self, prompt: str) -> str:
        import re

        # Chord contextual meaning: 2-3 sentences ≤70 words, references the firing.
        if "rewriting the meaning of a chord" in prompt.lower():
            ts_m = re.search(r"Firing timestamp \(M:SS\): (\d+:\d{2})", prompt)
            title_m = re.search(r"Video title: (.+)", prompt)
            ts = ts_m.group(1) if ts_m else "0:08"
            title = title_m.group(1).strip() if title_m else "this video"
            return (
                f"At {ts} in {title}, the body reacts before the mind catches up. "
                f"The systems involved cross threshold together while cognitive control stays quiet — "
                f"a moment that lands in the chest before the brain has decided whether to care."
            )

        # OLD chord_context marker (now removed — kept as fallback so legacy
        # prompts don't crash if invoked).
        if "personalized sentence to append to a chord" in prompt.lower():
            ts_m = re.search(r"Firing timestamp \(M:SS\): (\d+:\d{2})", prompt)
            ts = ts_m.group(1) if ts_m else "0:08"
            return f"The viewer's body responds at {ts} before deciding whether to care."

        # Frame 02 sub: must mention both recipe names.
        if "Frame 02" in prompt:
            ra = re.search(r"Recipe A name: (.+)", prompt)
            rb = re.search(r"Recipe B name: (.+)", prompt)
            recipe_a = ra.group(1).strip() if ra else "Recipe A"
            recipe_b = rb.group(1).strip() if rb else "Recipe B"
            return (
                f"{recipe_a} and {recipe_b} unfold across the runtime. "
                "A chord fires when two systems cross threshold at the same second and hold."
            )

        # Coupling callout: must mention both system display names.
        if "coupling callout" in prompt.lower():
            sa = re.search(r"System pair: (\w+) ", prompt)
            sb = re.search(r"System pair: \w+ . (\w+)", prompt)
            sys_a = sa.group(1) if sa else "memory_encoding"
            sys_b = sb.group(1) if sb else "language_depth"
            display = {
                "personal_resonance": "Self-relevance", "attention": "Attention",
                "brain_effort": "Effort", "gut_reaction": "Gut",
                "memory_encoding": "Memory", "social_thinking": "Social",
                "language_depth": "Language",
            }
            a_disp = display.get(sys_a, sys_a)
            b_disp = display.get(sys_b, sys_b)
            return (
                f"{a_disp} and {b_disp} systems rose together across the runtime. "
                "The two systems fired as a team — the signature of content built to stick."
            )

        for marker, fixture in self._STUB_FIXTURES:
            if marker.lower() in prompt.lower():
                return fixture

        return "Stub backend: no fixture matched this prompt."

    def vram_peak_mb(self) -> float | None:
        return None

    def reset_vram_peak(self) -> None:
        return None


# ────────────────────────────────────────────────────────────
# ModelManager — the public face
# ────────────────────────────────────────────────────────────

class ModelTimeoutError(Exception):
    """Raised when a generation exceeds its per-slot timeout."""


class ModelManager:
    """Owns the model. Caps parallelism. Enforces timeouts.

    Use one instance per process.
    """

    def __init__(
        self,
        backend: ModelBackend,
        *,
        max_parallel: int = 2,
        per_slot_timeout_seconds: float = 12.0,
        priority_lock: asyncio.Lock | None = None,
    ) -> None:
        self.backend = backend
        self._sem = asyncio.Semaphore(max_parallel)
        self._timeout = per_slot_timeout_seconds
        # priority_lock = held by cortical inference. If set, ModelManager
        # will await this lock's release before each generation. Wire from
        # the TRIBE scheduler in Phase 1.
        self._priority_lock = priority_lock

    async def generate(self, req: GenerationRequest) -> GenerationResponse:
        """Bounded, queued, timeout-enforced generation."""
        # If cortical inference holds the priority lock, wait for it.
        if self._priority_lock is not None:
            async with self._priority_lock:
                pass  # just await release; do not hold during our own work

        async with self._sem:
            try:
                return await asyncio.wait_for(
                    self.backend.generate(req),
                    timeout=self._timeout,
                )
            except asyncio.TimeoutError as exc:
                raise ModelTimeoutError(
                    f"Generation exceeded {self._timeout:.1f}s "
                    f"(prompt_len={len(req.prompt)} max_new_tokens={req.max_new_tokens})"
                ) from exc

    def vram_peak_mb(self) -> float | None:
        return self.backend.vram_peak_mb()

    def reset_vram_peak(self) -> None:
        self.backend.reset_vram_peak()


# ────────────────────────────────────────────────────────────
# Convenience: process-singleton accessor
# ────────────────────────────────────────────────────────────

_singleton: ModelManager | None = None


def get_model_manager() -> ModelManager:
    """Process-singleton ModelManager. Defaults to StubBackend in Phase 0."""
    global _singleton
    if _singleton is None:
        _singleton = ModelManager(StubBackend())
    return _singleton


def set_model_manager(mgr: ModelManager) -> None:
    """Override the singleton. Phase 1 calls this with the real backend."""
    global _singleton
    _singleton = mgr


def use_real_content_model(
    *,
    cache_folder: str | None = None,      # ignored on Anthropic path; kept for signature compat
    device: str | None = None,            # ignored on Anthropic path; kept for signature compat
    max_parallel: int = 1,
    per_slot_timeout_seconds: float = 45.0,   # was 600 for Gemma cold load — 45s is plenty for HTTP
) -> ModelManager:
    """Swap the singleton to the production Anthropic backend.

    Idempotent — safe to call multiple times (the AnthropicBackend
    instance is cheap to recreate; we replace it on every call).

    `cache_folder` and `device` are accepted to preserve the legacy
    signature used by `worker_impl._warm_llm_background` but are no-ops
    on the Anthropic path — there's nothing to cache or device-place
    for an HTTP client.
    """
    from .anthropic_backend import make_default_backend  # local import to avoid circulars
    backend = make_default_backend()
    mgr = ModelManager(
        backend,
        max_parallel=max_parallel,
        per_slot_timeout_seconds=per_slot_timeout_seconds,
    )
    set_model_manager(mgr)
    return mgr


# Backward-compat alias — remove once all callers are updated.
def use_real_llama(**kwargs) -> ModelManager:  # noqa: D401
    return use_real_content_model(**kwargs)
