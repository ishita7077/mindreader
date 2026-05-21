"""AnalysisBriefSlot — Gemma's analyst pass over the evidence packet.

This slot runs FIRST (wave 0) before any copy writers. It receives the
full evidence packet and returns a structured analysis:
  - thesis (the sharpest contrast)
  - tradeoff (what each strategy gains/loses)
  - why_it_happened (evidence-grounded claims)
  - recommendations (actionable, cited)
  - confidence (low/medium/high)

All downstream copy slots receive analysis_brief fields in their extra_context
so they can reference the thesis and tradeoff without re-deriving them.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from ..lib.audit_log import AuditLogger
from ..lib.evidence_packet import build_evidence_packet
from ..lib.ids import deterministic_seed, hash_string, now_iso
from ..lib.input_normalizer import NormalizedInputs
from ..lib.json_extract import extract_first_json_object
from ..lib.model_manager import GenerationRequest, ModelManager
from ..validators.analysis_brief import AnalysisBriefValidator
from ..validators.base import ValidationResult
from .base import Slot, SlotResult, TEMPLATES_DIR


_FALLBACK_BRIEF: dict[str, Any] = {
    "thesis": "These two inputs recruit distinct cortical strategies.",
    "tradeoff": "Each runs a different recipe — different systems pulled, different timing.",
    "why_it_happened": [{"claim": "The inputs differ in structure and pacing.", "evidence_refs": []}],
    "recommendations": [{"action": "Review the chord progression for specific moments of divergence.", "because": "Chord events mark where strategies diverge most sharply.", "evidence_refs": []}],
    "confidence": "low",
}


class AnalysisBriefSlot(Slot):
    slot_address = "analysis_brief"
    template_name = "analysis_brief.txt"
    max_new_tokens = 600
    output_is_json = True

    # Gemma analyst pass: sampling on, moderate temperature for consistent reasoning.
    temperature = 0.7
    top_p = 0.92
    do_sample = True

    def __init__(self) -> None:
        super().__init__(validator=AnalysisBriefValidator())

    def build_template_context(self, inputs: NormalizedInputs) -> dict[str, Any]:
        packet = build_evidence_packet(inputs)
        return {"evidence_block": packet.as_prompt_block()}

    def parse_selected(self, model_text: str) -> dict[str, Any]:
        return extract_first_json_object(model_text)

    async def run(
        self,
        *,
        inputs: NormalizedInputs,
        comparison_id: str,
        run_id: str,
        outputs_dir: Path,
        manager: ModelManager,
        audit: AuditLogger,
        extra_context: dict[str, Any] | None = None,
    ) -> SlotResult:
        audit.emit("slot_started", slot=self.slot_address)
        start = time.perf_counter()

        ctx = self.build_template_context(inputs)
        if extra_context:
            ctx.update(extra_context)
        prompt = self.render_prompt(ctx)
        prompt_hash = hash_string(prompt)
        audit.emit("slot_prompt_rendered", slot=self.slot_address, prompt_hash=prompt_hash)

        seed = deterministic_seed(comparison_id, self.slot_address)
        candidates: list[dict] = []
        validation = ValidationResult(passed=False)
        selected: dict[str, Any] = _FALLBACK_BRIEF.copy()
        attempts = 0
        last_error: str | None = None

        for attempt in range(1, 4):  # 3 attempts: sample → repair → resample
            attempts = attempt
            is_repair = attempt == 2 and candidates

            if is_repair and candidates:
                # Repair pass: tell Gemma what went wrong and ask it to fix only that.
                errors_text = "; ".join(
                    e.detail for e in validation.errors[:3]
                ) if validation.errors else "output did not pass validation"
                prev_raw = json.dumps(candidates[-1]) if candidates else ""
                repair_prompt = (
                    f"Your previous JSON output failed these checks:\n{errors_text}\n\n"
                    f"Previous output:\n{prev_raw}\n\n"
                    f"Return corrected JSON only. Start with {{ and end with }}. No explanation."
                )
                req = GenerationRequest(
                    prompt=repair_prompt,
                    max_new_tokens=self.max_new_tokens,
                    temperature=0.35,
                    top_p=0.9,
                    do_sample=True,
                    seed=seed + 100,
                )
            else:
                req = GenerationRequest(
                    prompt=prompt,
                    max_new_tokens=self.max_new_tokens,
                    temperature=self.temperature if attempt == 1 else 0.85,
                    top_p=self.top_p,
                    do_sample=self.do_sample,
                    seed=seed + (attempt - 1) * 7,
                )

            audit.emit(
                "slot_model_called",
                slot=self.slot_address,
                attempt=attempt,
                prompt_hash=prompt_hash,
                data={"repair": is_repair},
            )
            try:
                resp = await manager.generate(req)
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                audit.emit("slot_model_failed", slot=self.slot_address, attempt=attempt,
                           error_code="MODEL_CALL_FAILED", error_detail=last_error)
                continue

            audit.emit("slot_model_returned", slot=self.slot_address, attempt=attempt,
                       latency_ms=resp.latency_ms)

            try:
                parsed = self.parse_selected(resp.text)
            except Exception as exc:
                last_error = f"PARSE_ERROR: {exc}"
                audit.emit("slot_validation_failed", slot=self.slot_address, attempt=attempt,
                           error_code="OUTPUT_UNPARSEABLE", error_detail=str(exc))
                continue

            candidates.append(parsed)
            validation = self.validator.validate(parsed)
            if validation.passed:
                selected = parsed
                audit.emit("slot_validation_passed", slot=self.slot_address, attempt=attempt)
                break
            audit.emit("slot_validation_failed", slot=self.slot_address, attempt=attempt,
                       error_code=validation.errors[0].code if validation.errors else "VALIDATION_FAILED",
                       error_detail="; ".join(e.detail for e in validation.errors))

        latency_ms = int((time.perf_counter() - start) * 1000)
        succeeded = validation.passed

        if not succeeded:
            # Use the last parsed candidate (even if invalid) over the static fallback,
            # as it's more specific to this comparison.
            if candidates:
                selected = candidates[-1]
            audit.emit("slot_fallback_used", slot=self.slot_address,
                       error_code="ALL_ATTEMPTS_FAILED", error_detail=last_error or "validation failed")

        raw_path = outputs_dir / "raw" / f"{self.slot_address}.json"
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        raw_doc = {
            "schema_version": "raw_slot.v1",
            "slot": self.slot_address,
            "comparison_id": comparison_id,
            "run_id": run_id,
            "generated_at": now_iso(),
            "model": {
                "model_id": manager.backend.model_id,
                "model_revision": manager.backend.model_revision,
                "seed": seed,
                "temperature": self.temperature,
                "top_p": self.top_p,
                "do_sample": self.do_sample,
                "max_new_tokens": self.max_new_tokens,
            },
            "prompt_rendered": prompt,
            "candidates": candidates,
            "selected": selected,
            "attempts": attempts,
            "validation": validation.as_dict(),
            "latency_ms": latency_ms,
            "source": "llm" if succeeded else ("partial" if candidates else "fallback"),
        }
        raw_path.write_text(json.dumps(raw_doc, indent=2, ensure_ascii=False))
        audit.emit("slot_completed", slot=self.slot_address, attempt=attempts,
                   latency_ms=latency_ms, raw_output_path=str(raw_path),
                   error_code=None if succeeded else "VALIDATION_FAILED_FINAL")

        return SlotResult(
            slot_address=self.slot_address,
            selected=selected,
            candidates=candidates,
            validation=validation,
            raw_path=raw_path,
            attempts=attempts,
            latency_ms=latency_ms,
            succeeded=succeeded,
        )
