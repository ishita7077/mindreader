import runpod


def handler(event):
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


runpod.serverless.start({"handler": handler})
