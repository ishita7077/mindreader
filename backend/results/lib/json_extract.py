"""Extract the first valid JSON object from raw LLM text.

Gemma 1B often adds preamble ("Sure! Here is your JSON:") or postamble
("Let me know if you need anything else."). This extracts the first
balanced {...} block and parses it.
"""

from __future__ import annotations

import json
import re


def extract_first_json_object(text: str) -> dict:
    """Find the first {...} block in text and parse it as JSON.

    Raises ValueError if no valid JSON object is found.
    """
    text = text.strip()

    # Fast path: the whole thing is JSON already.
    try:
        result = json.loads(text)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    # Scan for the first '{' and walk forward tracking depth.
    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found in model output")

    depth = 0
    in_string = False
    escape_next = False

    for i in range(start, len(text)):
        ch = text[i]
        if escape_next:
            escape_next = False
            continue
        if ch == "\\" and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = text[start : i + 1]
                try:
                    result = json.loads(candidate)
                    if isinstance(result, dict):
                        return result
                except json.JSONDecodeError:
                    # Malformed block — keep scanning for the next one.
                    start_next = text.find("{", i + 1)
                    if start_next == -1:
                        break
                    start = start_next
                    depth = 0

    raise ValueError(f"No valid JSON object found. Raw text: {text[:300]!r}")
