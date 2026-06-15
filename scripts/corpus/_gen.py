#!/usr/bin/env python3
"""Generate the byte-exact percent-format round-trip corpus (verify item ⑥).

Each file deliberately exercises a property the serializer must preserve to the
byte: CRLF, mixed tab/space indentation, trailing whitespace, missing final
newline, empty cells, `# %%` sequences *inside* string literals (must NOT
split), IPython magics, markdown cells, and a module header before the first
separator. Run from anywhere: writes siblings next to this file.
"""
from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent

FILES: dict[str, bytes] = {}

# 1) CRLF throughout, tab/space mix, trailing whitespace, NO final newline.
FILES["crlf_mixed.py"] = (
    "# %% header\r\n"
    "import os\t \r\n"          # trailing tab+space
    "x = 1   \r\n"               # trailing spaces
    "\r\n"                        # blank CRLF line
    "# %% second\r\n"
    "\tif x:\r\n"               # tab indent
    "        y = 2\r\n"          # space indent (8)
    "\t    z = 3"                # mixed tab+space, NO final newline
).encode("utf-8")

# 2) A `# %%`-looking line inside a triple-quoted string must NOT split.
FILES["string_marker.py"] = (
    "# %% real-a\n"
    "doc = '''\n"
    "# %% this is text, not a cell marker\n"
    "still inside the string\n"
    "'''\n"
    "# %% real-b\n"
    "s = \"# %% also not a marker\"\n"
    "print(s)\n"
).encode("utf-8")

# 3) Empty cells: consecutive markers, whitespace-only bodies.
FILES["empty_cells.py"] = (
    "# %%\n"
    "# %%\n"
    "# %% titled\n"
    "   \n"        # whitespace-only body line
    "# %%\n"
).encode("utf-8")

# 4) Module header (docstring + imports) before the first separator.
FILES["module_header.py"] = (
    '"""Module level docstring.\n'
    "\n"
    "Spans multiple lines, contains # %% which is NOT a marker (in string).\n"
    '"""\n'
    "from __future__ import annotations\n"
    "import sys\n"
    "\n"
    "\n"
    "# %% first real cell\n"
    "print(sys.version)\n"
).encode("utf-8")

# 5) IPython magics + markdown cells (jupytext comments markdown content).
FILES["magics_markdown.py"] = (
    "# %% [markdown]\n"
    "# # A heading\n"
    "# some *markdown* prose\n"
    "# %%\n"
    "%matplotlib inline\n"
    "%%timeit\n"
    "import time; time.sleep(0)\n"
    "# %%\n"
    "!echo hi\n"
    "%load_ext autoreload\n"
).encode("utf-8")

# 6) `#%%` (no space) markers, and a missing final newline on a code line.
FILES["no_final_newline.py"] = (
    "#%%\n"
    "a = 1\n"
    "#%% next\n"
    "b = a + 1\n"
    "print(b)"          # NO final newline
).encode("utf-8")

# 7) Tab/space indentation mix and trailing whitespace on blank lines.
FILES["mixed_indent.py"] = (
    "# %%\n"
    "def f():\n"
    "\treturn 1\n"          # tab indent
    "    \n"                  # trailing spaces on an otherwise-blank line
    "def g():\n"
    "        return 2\n"      # 8-space indent
    "\t \t# trailing comment after mixed indent\n"
).encode("utf-8")

# 8) Nastiest: CRLF + a marker-looking line inside a CRLF triple string.
FILES["crlf_string_marker.py"] = (
    "# %% a\r\n"
    "t = \"\"\"\r\n"
    "# %% not a marker (in crlf string)\r\n"
    "\"\"\"\r\n"
    "# %% b\r\n"
    "u = 0\r\n"
).encode("utf-8")


def main() -> None:
    for name, data in FILES.items():
        (HERE / name).write_bytes(data)
        print(f"wrote {name} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
