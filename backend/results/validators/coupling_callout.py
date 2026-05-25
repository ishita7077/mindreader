"""Coupling callout validator (Slot 6)."""

from __future__ import annotations

from .base import BaseValidator, ValidationError, ValidationResult


# Display names of the canonical systems (rough English forms the LLM is told to use).
_SYSTEM_DISPLAY: dict[str, list[str]] = {
    "personal_resonance": ["personal", "self-relevance", "resonance"],
    "attention":          ["attention"],
    "brain_effort":       ["effort", "control", "cognitive control"],
    "gut_reaction":       ["gut", "visceral", "body"],
    "memory_encoding":    ["memory"],
    "social_thinking":    ["social", "theory-of-mind", "mentalising"],
    "language_depth":     ["language"],
}


class CouplingCalloutValidator(BaseValidator):
    slot = "coupling_callout"

    def __init__(self, *, system_a: str, system_b: str) -> None:
        self.system_a = system_a
        self.system_b = system_b

    def validate(self, output: str) -> ValidationResult:
        errors: list[ValidationError] = []
        if not isinstance(output, str) or not output.strip():
            return ValidationResult(passed=False, errors=[
                ValidationError(code="EMPTY_OUTPUT", detail="coupling_callout is empty"),
            ])

        text = output.strip()

        n = self.count_sentences(text)
        if n != 2:
            errors.append(ValidationError(
                code="WRONG_SENTENCE_COUNT",
                detail=f"coupling_callout must be exactly 2 sentences, got {n}",
            ))

        wc = self.count_words(text)
        # Tightened from 38 → 22 to match the new prompt that explicitly caps
        # the callout at 22 words. Cards are small; long callouts were
        # crowding the layout per user feedback.
        if wc > 22:
            errors.append(ValidationError(
                code="OVER_WORD_LIMIT",
                detail=f"coupling_callout has {wc} words, max 22",
            ))
        # MISSING_SYSTEM_NAME check removed (May 25 2026): the prompt now
        # explicitly forbids opening with the system pair names (they're on
        # the chip above the card). The "must reference both systems" rule
        # is incompatible with the new "lead with what's distinctive" goal.
        # System pairing is preserved via the chip/eyebrow row.

        errors.extend(self.check_banned_patterns(text))
        return ValidationResult(passed=not errors, errors=errors)
