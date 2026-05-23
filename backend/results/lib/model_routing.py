"""Slot → model routing config.

Maps each slot_address to the Anthropic model that handles it.

Two tiers:
  - REASONING tier (Claude Sonnet 4.6): slots that need to read evidence,
    reason about brain data, and produce nuanced multi-sentence prose.
  - FORMATTED tier (Claude Haiku 4.5): slots that need to follow strict
    format rules and emit short, well-structured text.

Edit this file (no other) to promote/demote a slot between tiers.

Costing reference (May 2026 prices, per million tokens):
  - claude-sonnet-4-6:  $3.00 input / $15.00 output
  - claude-haiku-4-5:   $1.00 input / $5.00 output
  - With prompt caching (90% discount on cache reads), effective input
    cost is ~$0.30 (Sonnet) / ~$0.10 (Haiku) for cached portions.
"""

from __future__ import annotations

# Exact model IDs as Anthropic's API expects them.
SONNET_4_6 = "claude-sonnet-4-6"
HAIKU_4_5 = "claude-haiku-4-5"

# Default model for any slot not explicitly listed below.
DEFAULT_MODEL = HAIKU_4_5

# Reasoning-tier slots: need real thinking, get the better model.
# These slots' outputs feed downstream prose; quality compounds.
REASONING_SLOTS: dict[str, str] = {
    "analysis_brief": SONNET_4_6,            # Wave 0 — the analyst pass over the evidence packet.
    "body":           SONNET_4_6,            # Hero paragraph; voice + accuracy matter.
    # chord_contextual_meaning slots have a per-firing suffix like
    # "chord_meaning.firing_0"; we route them via prefix match below.
}

# Slot-address prefixes routed to a tier. Used when a slot_address contains
# a dynamic suffix (e.g. chord firings indexed by position).
REASONING_PREFIXES: tuple[str, ...] = (
    "chord_meaning.",   # Per-firing chord meaning; reasoning helps.
)


def model_for_slot(slot_address: str) -> str:
    """Return the Anthropic model ID that should handle this slot.

    Falls back to DEFAULT_MODEL (Haiku) when neither explicit name nor
    prefix matches. Pure function — no env-var reads, easy to test.
    """
    if slot_address in REASONING_SLOTS:
        return REASONING_SLOTS[slot_address]
    for prefix in REASONING_PREFIXES:
        if slot_address.startswith(prefix):
            return SONNET_4_6
    return DEFAULT_MODEL


# Per-million-token prices in USD as of May 2026. Used by spend_tracker
# to estimate cost from usage tokens reported by the API. If Anthropic
# repricesinterest, update here once and the rest of the system follows.
PRICE_PER_MTOK_USD: dict[str, dict[str, float]] = {
    SONNET_4_6: {
        "input":             3.00,
        "input_cache_write": 3.75,   # 25% premium when writing to cache
        "input_cache_read":  0.30,   # 90% discount on cache hits
        "output":           15.00,
    },
    HAIKU_4_5: {
        "input":             1.00,
        "input_cache_write": 1.25,
        "input_cache_read":  0.10,
        "output":            5.00,
    },
}


def estimate_cost_usd(
    model_id: str,
    *,
    input_tokens: int = 0,
    cache_write_tokens: int = 0,
    cache_read_tokens: int = 0,
    output_tokens: int = 0,
) -> float:
    """Compute approximate USD spend for one Anthropic API call.

    Token counts come straight from the response's `usage` block.
    Unknown model_id returns 0.0 (so we never raise from accounting code).
    """
    rates = PRICE_PER_MTOK_USD.get(model_id)
    if not rates:
        return 0.0
    return (
        input_tokens       * rates["input"]             / 1_000_000
        + cache_write_tokens * rates["input_cache_write"] / 1_000_000
        + cache_read_tokens  * rates["input_cache_read"]  / 1_000_000
        + output_tokens      * rates["output"]            / 1_000_000
    )
