"""Editorial vocabulary for the 7 cortical dimensions.

Extracted from the legacy `backend/insight_engine.py` (April 9 2026 — predates
the LLM pipeline). The template engine that originally USED this dict produced
broken output, but the underlying vocabulary is genuinely good editorial
material: plain-English names for each dimension, what it means for a reader,
and concrete editorial knobs to dial each direction up or down.

The slot pipeline (Wave 0 analyst + Wave 1 writers) now reads this dict via
the evidence packet so Claude has the same editorial framings the original
author intended for the page.

Do not add per-comparison logic here — keep it pure data so it's easy to
audit and tweak.
"""

from __future__ import annotations


# Per-dimension editorial vocabulary. Each entry contains:
#   noun:   the dimension's plain-English noun (use in body prose)
#   plain:  what high activity feels like to a reader (use in headlines/body)
#   a_tip:  editorial move to make Video A's signature stronger
#   b_tip:  editorial move to make Video B's signature stronger
DIMENSION_FRAMING: dict[str, dict[str, str]] = {
    "personal_resonance": {
        "noun":  "self-relevance",
        "plain": "feels more about me",
        "a_tip": "Make the message more universal, detached, or observational.",
        "b_tip": "Use second-person framing, concrete stakes, or personal consequences.",
    },
    "social_thinking": {
        "noun":  "social reasoning",
        "plain": "makes people think more about other people",
        "a_tip": "Lean into relationships, motives, consequences, or group dynamics.",
        "b_tip": "Strip back social context and focus on facts or direct instruction.",
    },
    "brain_effort": {
        "noun":  "cognitive effort",
        "plain": "asks the brain to work harder",
        "a_tip": "Shorten sentences, reduce abstraction, and simplify structure.",
        "b_tip": "Add precision, nuance, or more layered reasoning.",
    },
    "language_depth": {
        "noun":  "language depth",
        "plain": "engages deeper meaning-making",
        "a_tip": "Use simpler words and flatter syntax to keep things surface-level.",
        "b_tip": "Use richer phrasing, layered meaning, or stronger semantic contrast.",
    },
    "gut_reaction": {
        "noun":  "visceral salience",
        "plain": "lands more viscerally",
        "a_tip": "Lower the emotional temperature and remove vivid sensory triggers.",
        "b_tip": "Add vivid detail, immediacy, tension, or felt stakes.",
    },
    "memory_encoding": {
        "noun":  "memory encoding likelihood",
        "plain": "is more likely to be remembered",
        "a_tip": "Add concrete personal stakes or vivid details to increase encoding drive.",
        "b_tip": "Reduce vividness and emotional salience if recall is not the goal.",
    },
    "attention_salience": {
        "noun":  "attentional engagement",
        "plain": "captures and holds attention",
        "a_tip": "Increase novelty, urgency, and explicit salience cues to pull attention faster.",
        "b_tip": "Reduce urgency cues and lower novelty if sustained attention is not needed.",
    },
}


# Brain effort needs special handling — high cognitive effort can mean three
# very different things, and the brain signal alone cannot tell them apart.
# Cite this framework when brain_effort is the top dimension.
BRAIN_EFFORT_THREE_LOADS = (
    "High cognitive effort can mean one of three things, and the brain signal "
    "cannot distinguish them: "
    "(1) INTRINSIC load — the content is genuinely complex/dense; "
    "(2) EXTRANEOUS load — the writing itself is hard to parse (jargon, "
    "poor structure); "
    "(3) GERMANE load — the reader is actively learning, building new "
    "understanding. "
    "(Sweller, 1988; Owen et al., 2005). "
    "When you cite this contrast, name the most likely load type given the "
    "input text, and acknowledge that the brain signal alone does not "
    "resolve which it is."
)


# Sticky caveat — should appear in every analyst confidence field so readers
# don't over-interpret cortical contrast as a behavioral prediction.
TRIBEV2_SCIENTIFIC_CAVEAT = (
    "These are directional cortical contrasts, not engagement or virality "
    "predictions. TRIBEv2 predicts average cortical response patterns; it "
    "does not predict clicks, likes, or individual minds."
)


# Recommendation pattern — when both videos have a clear strongest dimension
# of their own, the analyst can suggest a "best hybrid move" combining both.
HYBRID_MOVE_PATTERN = (
    'Pattern for the recommendations array when A and B each have a distinct '
    'strongest dimension: '
    '"Keep [b_top_dimension_in_plain_english] from B, but preserve '
    '[a_top_dimension_in_plain_english] from A. That gives you the strongest '
    'combined tradeoff in this run." '
    "Include both a_top and b_top as evidence_refs."
)


def framing_block_for_analyst() -> str:
    """Render the framing dict as a prompt-friendly block.

    Called by `evidence_packet.py` to include this editorial vocabulary
    in the evidence the analyst (Wave 0) sees. Plain text, no markdown
    nesting tricks — readable both to humans editing prompts and to Claude.
    """
    lines = ["Editorial vocabulary (use these when writing about each dimension):"]
    for system, framing in DIMENSION_FRAMING.items():
        lines.append(
            f"  - {system}: '{framing['noun']}' — content with high activity here {framing['plain']}.\n"
            f"      To push this up in Version A: {framing['a_tip']}\n"
            f"      To push this up in Version B: {framing['b_tip']}"
        )
    lines.append("")
    lines.append("Brain effort caveat (cite when brain_effort is the top dimension):")
    lines.append("  " + BRAIN_EFFORT_THREE_LOADS)
    lines.append("")
    lines.append("Scientific caveat (include in every confidence statement):")
    lines.append("  " + TRIBEV2_SCIENTIFIC_CAVEAT)
    lines.append("")
    lines.append("Recommendation pattern (use when A and B each have a distinct strongest dimension):")
    lines.append("  " + HYBRID_MOVE_PATTERN)
    return "\n".join(lines)
