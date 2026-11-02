"""Percent-source cell parsing shared by notebook interchange and output projection."""

from __future__ import annotations

import io
import re
import tokenize

MARKER = re.compile(r"^#\s*%%(.*)$")


def parse_percent(text: str) -> list[dict]:
    """Find top-level comment markers with Python's string-aware tokenizer."""
    lines = re.findall(r".*?(?:\r\n|\r|\n|$)", text, re.DOTALL)
    if lines and not lines[-1]:
        lines.pop()
    markers = {}
    depth = 0
    try:
        for token in tokenize.generate_tokens(
            io.StringIO(text.replace("\r\n", "\n").replace("\r", "\n")).readline
        ):
            if token.type == tokenize.OP:
                if token.string in "([{":
                    depth += 1
                elif token.string in ")]}":
                    depth = max(0, depth - 1)
            if token.type == tokenize.COMMENT and token.start[1] == 0 and not depth:
                found = MARKER.match(token.string)
                if found:
                    suffix = found[1].strip().lower()
                    markers[token.start[0] - 1] = (
                        "markdown"
                        if suffix.startswith("[markdown]")
                        else "raw"
                        if suffix.startswith("[raw]")
                        else "code"
                    )
    except (tokenize.TokenError, IndentationError) as error:
        raise ValueError(f"Cannot identify cell boundaries: {error}") from error
    cells = []
    current = None
    for index, line in enumerate(lines):
        if index in markers:
            current = {"kind": markers[index], "body": "", "start": index + 1, "index": len(cells)}
            cells.append(current)
        else:
            if current is None:
                current = {"kind": "code", "body": "", "start": 0, "index": 0}
                cells.append(current)
            current["body"] += line
    return cells
