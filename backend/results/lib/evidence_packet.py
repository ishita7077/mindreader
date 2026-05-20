"""Evidence packet builder — deterministic pre-distillation of TRIBE data.

Takes NormalizedInputs (two VideoSignatures) and returns a compact dict of
the most important facts. This is the ONLY thing Gemma sees — not raw scores.

Architecture:
    TRIBE timeseries + couplings + chords + transcript
        ↓  (this file — no LLM)
    EvidencePacket
        ↓
    AnalysisBriefSlot (Gemma picks thesis + tradeoff)
        ↓
    Section writers (Gemma writes copy per slot)

Design rules:
- Every field is pre-sorted and capped so Gemma never has to rank.
- Quotes are attached at both peaks AND chord events so copy can cite moments.
- Cross-video coupling comparison is explicit — Gemma doesn't compute it.
- Chord gap (in A only / B only / both) is a first-class field.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

from .input_normalizer import CANONICAL_SYSTEMS, NormalizedInputs, VideoSignature


# ────────────────────────────────────────────────────────────
# Pretty display names (same as lead_insight.py)
# ────────────────────────────────────────────────────────────

_SYSTEM_PRETTY: dict[str, str] = {
    "personal_resonance": "Personal Resonance",
    "attention":          "Attention",
    "brain_effort":       "Brain Effort",
    "gut_reaction":       "Gut Reaction",
    "memory_encoding":    "Memory Encoding",
    "social_thinking":    "Social Thinking",
    "language_depth":     "Language Depth",
}


def _pretty(system: str) -> str:
    return _SYSTEM_PRETTY.get(system, system.replace("_", " ").title())


# ────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────

def _fmt_time(seconds: float) -> str:
    m, s = int(seconds // 60), int(seconds % 60)
    return f"{m}:{s:02d}"


def _quote_at(video: VideoSignature, t: float, window: float = 3.0) -> str:
    """Closest transcript line within ±window seconds of timestamp t."""
    best: str = ""
    best_dist = float("inf")
    for line in video.transcript:
        dist = abs(line.t - t)
        if dist < best_dist and dist <= window:
            best_dist = dist
            best = line.text
    return best[:180] if best else ""


# ────────────────────────────────────────────────────────────
# Sub-types
# ────────────────────────────────────────────────────────────

@dataclass
class DeltaRow:
    system: str
    display_name: str
    mean_a: float
    mean_b: float
    delta: float          # B - A; positive = B higher
    direction: str        # "A_higher" | "B_higher" | "similar"


@dataclass
class MomentRow:
    video_key: str        # "video_a" | "video_b"
    video_title: str
    timestamp: str        # M:SS
    timestamp_seconds: float
    kind: str             # "peak" | "chord"
    system_or_chord: str  # system name (peak) or chord_id (chord)
    display_label: str    # human label
    intensity: float      # 0-1, used for sorting
    quote: str


@dataclass
class CouplingRow:
    system_a: str
    system_b: str
    display_a: str
    display_b: str
    r_a: float            # r in video_a (None-ish → 0.0 if missing)
    r_b: float
    divergence: float     # abs(r_a - r_b) — how different are the two videos here


@dataclass
class ChordGap:
    in_a_only: list[str]
    in_b_only: list[str]
    in_both: list[str]


@dataclass
class VideoSummary:
    video_key: str
    title: str
    duration_seconds: float
    integration_score: float
    hub_node: str
    hub_node_display: str
    recipe_name: str
    recipe_built_for: str


@dataclass
class EvidencePacket:
    # Titles
    title_a: str
    title_b: str

    # Per-system comparison, sorted by abs(delta) descending
    top_deltas: list[DeltaRow]

    # Most important moments across both videos (peaks + chords), capped at 8
    top_moments: list[MomentRow]

    # All 21 coupling pairs, sorted by cross-video divergence descending
    coupling_comparison: list[CouplingRow]

    # Which chord types appeared in which video
    chord_gap: ChordGap

    # High-level per-video summary
    video_a: VideoSummary
    video_b: VideoSummary

    def as_prompt_block(self) -> str:
        """Render the packet as a plain-text evidence table for Gemma."""
        lines: list[str] = []

        lines.append("=== EVIDENCE PACKET ===")
        lines.append(f"Input A: {self.title_a}")
        lines.append(f"Input B: {self.title_b}")
        lines.append("")

        lines.append("--- BIGGEST SYSTEM CONTRASTS (B minus A) ---")
        for d in self.top_deltas[:5]:
            sign = "+" if d.delta > 0 else ""
            lines.append(
                f"  {d.display_name}: A={d.mean_a:.2f}  B={d.mean_b:.2f}  delta={sign}{d.delta:.2f}  ({d.direction})"
            )

        lines.append("")
        lines.append("--- TOP MOMENTS (peaks + chord events) ---")
        for m in self.top_moments:
            quote_str = f'  "{m.quote}"' if m.quote else ""
            lines.append(
                f"  [{m.video_key}] {m.timestamp}  {m.kind}: {m.display_label}  intensity={m.intensity:.2f}{quote_str}"
            )

        lines.append("")
        lines.append("--- COUPLING DIVERGENCES (biggest cross-video gaps first) ---")
        for c in self.coupling_comparison[:6]:
            lines.append(
                f"  {c.display_a} ↔ {c.display_b}:  A r={c.r_a:+.2f}  B r={c.r_b:+.2f}  divergence={c.divergence:.2f}"
            )

        lines.append("")
        lines.append("--- CHORD GAP ---")
        if self.chord_gap.in_a_only:
            lines.append(f"  Only in A: {', '.join(self.chord_gap.in_a_only)}")
        if self.chord_gap.in_b_only:
            lines.append(f"  Only in B: {', '.join(self.chord_gap.in_b_only)}")
        if self.chord_gap.in_both:
            lines.append(f"  In both:   {', '.join(self.chord_gap.in_both)}")
        if not (self.chord_gap.in_a_only or self.chord_gap.in_b_only or self.chord_gap.in_both):
            lines.append("  No chord events detected in either input.")

        lines.append("")
        lines.append("--- VIDEO SUMMARIES ---")
        for vs in (self.video_a, self.video_b):
            lines.append(
                f"  {vs.video_key}: integration={vs.integration_score:.2f}  hub={vs.hub_node_display}"
                f"  recipe={vs.recipe_name}  ({vs.recipe_built_for})"
            )

        lines.append("=== END EVIDENCE PACKET ===")
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ────────────────────────────────────────────────────────────
# Builder
# ────────────────────────────────────────────────────────────

def build_evidence_packet(inputs: NormalizedInputs) -> EvidencePacket:
    """Build the evidence packet from NormalizedInputs. No LLM calls."""
    va, vb = inputs.video_a, inputs.video_b

    return EvidencePacket(
        title_a=va.display_name,
        title_b=vb.display_name,
        top_deltas=_build_top_deltas(va, vb),
        top_moments=_build_top_moments(va, vb),
        coupling_comparison=_build_coupling_comparison(va, vb),
        chord_gap=_build_chord_gap(va, vb),
        video_a=_build_video_summary("video_a", va),
        video_b=_build_video_summary("video_b", vb),
    )


# ────────────────────────────────────────────────────────────
# Top deltas
# ────────────────────────────────────────────────────────────

def _build_top_deltas(va: VideoSignature, vb: VideoSignature) -> list[DeltaRow]:
    rows: list[DeltaRow] = []
    for sys in CANONICAL_SYSTEMS:
        ma = va.system_means.get(sys, 0.5)
        mb = vb.system_means.get(sys, 0.5)
        delta = mb - ma
        direction = (
            "A_higher" if ma - mb > 0.05
            else "B_higher" if mb - ma > 0.05
            else "similar"
        )
        rows.append(DeltaRow(
            system=sys,
            display_name=_pretty(sys),
            mean_a=round(ma, 3),
            mean_b=round(mb, 3),
            delta=round(delta, 3),
            direction=direction,
        ))
    rows.sort(key=lambda r: abs(r.delta), reverse=True)
    return rows


# ────────────────────────────────────────────────────────────
# Top moments — peaks + chord events unified
# ────────────────────────────────────────────────────────────

def _build_top_moments(va: VideoSignature, vb: VideoSignature, cap: int = 8) -> list[MomentRow]:
    moments: list[MomentRow] = []

    for vid_key, video in (("video_a", va), ("video_b", vb)):
        # Peak moments — one per system, attach nearest transcript quote
        for sys, peak in video.system_peaks.items():
            t = float(peak.get("time", 0))
            v = float(peak.get("value", 0))
            quote = _quote_at(video, t)
            moments.append(MomentRow(
                video_key=vid_key,
                video_title=video.display_name,
                timestamp=_fmt_time(t),
                timestamp_seconds=t,
                kind="peak",
                system_or_chord=sys,
                display_label=f"{_pretty(sys)} peak",
                intensity=v,
                quote=quote,
            ))

        # Chord moments — already have quotes in the event
        for ev in video.chord_events:
            vals = list(ev.formula_values.values()) if ev.formula_values else [0.5]
            intensity = sum(vals) / len(vals)
            quote = ev.quote or _quote_at(video, ev.timestamp_seconds)
            moments.append(MomentRow(
                video_key=vid_key,
                video_title=video.display_name,
                timestamp=_fmt_time(ev.timestamp_seconds),
                timestamp_seconds=ev.timestamp_seconds,
                kind="chord",
                system_or_chord=ev.chord_id,
                display_label=ev.chord_id.replace("-", " ").title(),
                intensity=intensity,
                quote=(quote or "")[:180],
            ))

    moments.sort(key=lambda m: m.intensity, reverse=True)
    return moments[:cap]


# ────────────────────────────────────────────────────────────
# Coupling comparison — all 21 pairs, divergence-sorted
# ────────────────────────────────────────────────────────────

def _build_coupling_comparison(va: VideoSignature, vb: VideoSignature) -> list[CouplingRow]:
    # Index by (sys_a, sys_b) — canonical order
    def _pair_key(a: str, b: str) -> tuple[str, str]:
        ia, ib = list(CANONICAL_SYSTEMS).index(a), list(CANONICAL_SYSTEMS).index(b)
        return (a, b) if ia < ib else (b, a)

    r_a: dict[tuple[str, str], float] = {}
    for c in va.couplings:
        r_a[_pair_key(c.system_a, c.system_b)] = c.r

    r_b: dict[tuple[str, str], float] = {}
    for c in vb.couplings:
        r_b[_pair_key(c.system_a, c.system_b)] = c.r

    all_pairs: set[tuple[str, str]] = set(r_a.keys()) | set(r_b.keys())
    rows: list[CouplingRow] = []
    for sa, sb in all_pairs:
        ra = r_a.get((sa, sb), 0.0)
        rb = r_b.get((sa, sb), 0.0)
        rows.append(CouplingRow(
            system_a=sa,
            system_b=sb,
            display_a=_pretty(sa),
            display_b=_pretty(sb),
            r_a=round(ra, 3),
            r_b=round(rb, 3),
            divergence=round(abs(ra - rb), 3),
        ))

    rows.sort(key=lambda r: r.divergence, reverse=True)
    return rows


# ────────────────────────────────────────────────────────────
# Chord gap
# ────────────────────────────────────────────────────────────

def _build_chord_gap(va: VideoSignature, vb: VideoSignature) -> ChordGap:
    types_a = {ev.chord_id for ev in va.chord_events}
    types_b = {ev.chord_id for ev in vb.chord_events}
    return ChordGap(
        in_a_only=sorted(types_a - types_b),
        in_b_only=sorted(types_b - types_a),
        in_both=sorted(types_a & types_b),
    )


# ────────────────────────────────────────────────────────────
# Video summary
# ────────────────────────────────────────────────────────────

def _build_video_summary(vid_key: str, video: VideoSignature) -> VideoSummary:
    from .library_matcher import match_recipe
    match = match_recipe(video)
    return VideoSummary(
        video_key=vid_key,
        title=video.display_name,
        duration_seconds=video.duration_seconds,
        integration_score=round(video.integration_score, 3),
        hub_node=video.hub_node or "unknown",
        hub_node_display=_pretty(video.hub_node or "unknown"),
        recipe_name=match.name,
        recipe_built_for=getattr(match, "built_for_tag", ""),
    )
