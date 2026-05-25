"""Body paragraph validator (Slot 2)."""

from __future__ import annotations

import re

from .base import BaseValidator, ValidationError, ValidationResult


# Same anatomical-term blocklist used by the headline validator. The body
# should be written for general readers in plain English; the editorial
# framing dict gives Claude the right NOUNs to use instead (e.g.
# "attentional engagement" not "prefrontal cortex").
_ANATOMICAL_TERMS = re.compile(
    r"\b(insula|cortex|cortical|prefrontal|amygdala|hippocampus|cingulate|"
    r"mpfc|dlpfc|vlpfc|tpj|fef|ips|broca|wernicke|fusiform|parietal|frontal|"
    r"temporal|occipital|hemisphere|medial|lateral|dorsal|ventral|anterior|"
    r"posterior)\b",
    re.IGNORECASE,
)


class BodyValidator(BaseValidator):
    slot = "body"

    def validate(self, output: str) -> ValidationResult:
        errors: list[ValidationError] = []
        if not isinstance(output, str) or not output.strip():
            return ValidationResult(passed=False, errors=[
                ValidationError(code="EMPTY_OUTPUT", detail="body is empty"),
            ])

        text = output.strip()
        n = self.count_sentences(text)
        if not (2 <= n <= 4):
            errors.append(ValidationError(
                code="WRONG_SENTENCE_COUNT",
                detail=f"body should be 2-4 sentences, got {n}",
            ))

        wc = self.count_words(text)
        if wc > 90:
            errors.append(ValidationError(
                code="OVER_WORD_LIMIT",
                detail=f"body has {wc} words, max 90",
            ))

        # Anatomical-term ban — same enforcement as the headline. The
        # editorial framing dict gives Claude the right plain-English nouns.
        anat = _ANATOMICAL_TERMS.search(text)
        if anat:
            errors.append(ValidationError(
                code="ANATOMICAL_TERM",
                detail=f"body contains anatomical term {anat.group(0)!r} — use the plain-English noun from the editorial framing block instead",
            ))

        errors.extend(self.check_banned_patterns(text))
        return ValidationResult(passed=not errors, errors=errors)
