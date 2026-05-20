"""Validator for the analysis_brief slot.

Expected shape:
{
  "thesis":          "one sentence — the strongest contrast",
  "tradeoff":        "what A gains/loses; what B gains/loses",
  "why_it_happened": [{"claim": "...", "evidence_refs": ["video_a:0:06"]}],
  "recommendations": [{"action": "...", "because": "...", "evidence_refs": [...]}],
  "confidence":      "low" | "medium" | "high"
}

Rules:
- thesis: 1 sentence, ≤ 25 words, no anatomical terms, no banned patterns
- tradeoff: 1–3 sentences, ≤ 50 words
- why_it_happened: 1–4 items, each claim ≤ 30 words
- recommendations: 1–4 items, each must have ≥ 1 evidence_ref
- No generic recommendations (banned phrases)
- confidence must be "low", "medium", or "high"
"""

from __future__ import annotations

import re
from typing import Any

from .base import BaseValidator, ValidationError, ValidationResult


_GENERIC_REC = re.compile(
    r"\b(make it more engaging|improve clarity|optimize content|consider audience needs"
    r"|be more creative|add more value|increase engagement)\b",
    re.IGNORECASE,
)

_ANATOMICAL = re.compile(
    r"\b(insula|cortex|cortical|prefrontal|amygdala|hippocampus|cingulate|"
    r"mpfc|dlpfc|vlpfc|tpj|broca|wernicke|parietal|frontal|temporal|occipital)\b",
    re.IGNORECASE,
)


class AnalysisBriefValidator(BaseValidator):
    slot = "analysis_brief"

    def validate(self, output: Any) -> ValidationResult:
        errors: list[ValidationError] = []

        if not isinstance(output, dict):
            return ValidationResult(passed=False, errors=[
                ValidationError(code="INVALID_TYPE", detail="analysis_brief must be a JSON object"),
            ])

        # Required keys
        for key in ("thesis", "tradeoff", "why_it_happened", "recommendations", "confidence"):
            if key not in output:
                errors.append(ValidationError(
                    code="MISSING_FIELD",
                    detail=f"analysis_brief missing required field '{key}'",
                ))

        if "thesis" in output and isinstance(output["thesis"], str):
            t = output["thesis"].strip()
            errors.extend(self.check_banned_patterns(t))
            if _ANATOMICAL.search(t):
                errors.append(ValidationError(code="ANATOMICAL_TERM", detail="thesis contains anatomical term"))
            if self.count_words(t) > 30:
                errors.append(ValidationError(
                    code="THESIS_TOO_LONG",
                    detail=f"thesis is {self.count_words(t)} words, max 30",
                ))
            if self.count_sentences(t) > 2:
                errors.append(ValidationError(code="THESIS_TOO_MANY_SENTENCES", detail="thesis should be 1–2 sentences"))

        if "tradeoff" in output and isinstance(output["tradeoff"], str):
            wc = self.count_words(output["tradeoff"])
            if wc > 60:
                errors.append(ValidationError(code="TRADEOFF_TOO_LONG", detail=f"tradeoff is {wc} words, max 60"))
            errors.extend(self.check_banned_patterns(output["tradeoff"]))

        if "why_it_happened" in output:
            items = output["why_it_happened"]
            if not isinstance(items, list) or len(items) == 0:
                errors.append(ValidationError(code="WHY_EMPTY", detail="why_it_happened must be a non-empty list"))
            elif len(items) > 5:
                errors.append(ValidationError(code="WHY_TOO_MANY", detail=f"why_it_happened has {len(items)} items, max 5"))
            else:
                for i, item in enumerate(items):
                    if not isinstance(item, dict) or "claim" not in item:
                        errors.append(ValidationError(code="WHY_MISSING_CLAIM", detail=f"why_it_happened[{i}] missing 'claim'"))
                    elif self.count_words(str(item["claim"])) > 40:
                        errors.append(ValidationError(code="CLAIM_TOO_LONG", detail=f"why_it_happened[{i}].claim over 40 words"))

        if "recommendations" in output:
            items = output["recommendations"]
            if not isinstance(items, list) or len(items) == 0:
                errors.append(ValidationError(code="RECS_EMPTY", detail="recommendations must be a non-empty list"))
            elif len(items) > 5:
                errors.append(ValidationError(code="RECS_TOO_MANY", detail=f"recommendations has {len(items)}, max 5"))
            else:
                for i, item in enumerate(items):
                    if not isinstance(item, dict):
                        continue
                    if "action" not in item:
                        errors.append(ValidationError(code="REC_MISSING_ACTION", detail=f"recommendations[{i}] missing 'action'"))
                    if not item.get("evidence_refs"):
                        errors.append(ValidationError(
                            code="REC_NO_EVIDENCE",
                            detail=f"recommendations[{i}] has no evidence_refs — every recommendation must cite real data",
                        ))
                    if "action" in item:
                        action_text = str(item["action"])
                        if _GENERIC_REC.search(action_text):
                            errors.append(ValidationError(
                                code="GENERIC_RECOMMENDATION",
                                detail=f"recommendations[{i}].action is too generic: {action_text!r}",
                            ))
                        errors.extend(self.check_banned_patterns(action_text))

        if "confidence" in output:
            if output["confidence"] not in ("low", "medium", "high"):
                errors.append(ValidationError(
                    code="INVALID_CONFIDENCE",
                    detail=f"confidence must be 'low', 'medium', or 'high', got {output['confidence']!r}",
                ))

        return ValidationResult(passed=not errors, errors=errors)
