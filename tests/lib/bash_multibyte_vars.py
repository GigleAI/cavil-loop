#!/usr/bin/env python3
"""Find `$NAME` directly followed by a non-ASCII byte in shell scripts (GitHub#411).

macOS ships bash 3.2, which decides where a variable name ends with the C library's
isalnum() on single bytes. In a UTF-8 locale on macOS that is true for many bytes >= 0x80,
so in `"$label：x"` bash 3.2 reads the first byte of `：` as part of the name, looks up a
variable that does not exist, and under `set -u` exits ("label\\357: unbound variable").
The fix is always `${label}：`.

The rule is purely textual on purpose: the sequence is not allowed anywhere in a script —
not in double quotes, not in single quotes, not in a comment, not in a here-document.
Telling expanded text from literal text means parsing shell (quotes inside ${...},
subscripts, arithmetic `<<` vs here-documents, ...); three review rounds on PR #417 each
found one more context a hand-written parser got wrong, and every miss either let a real
expansion through or made the fixer change literal output. A textual check cannot miss
an expansion. Its only cost is that literal text and comments must be written another
way too (braces in a comment, `\\$x` or a different wording in literal output) — and
there is no automatic fix, because only a person can tell which of the two a hit is.

  bash_multibyte_vars.py FILE...   print FILE:LINE:COL: $NAME for each hit; exit 1 if any
"""
import re
import sys

PATTERN = re.compile(rb"\$([A-Za-z_][A-Za-z0-9_]*)(?=[\x80-\xff])")


def scan(data):
    """[(offset of '$', name)] for every `$NAME` directly followed by a byte >= 0x80."""
    return [(m.start(), m.group(1).decode()) for m in PATTERN.finditer(data)]


def main(argv):
    files = argv[1:]
    if not files:
        sys.stderr.write(__doc__)
        return 2
    total = 0
    for f in files:
        with open(f, "rb") as fh:
            data = fh.read()
        for off, name in scan(data):
            line = data.count(b"\n", 0, off) + 1
            col = off - (data.rfind(b"\n", 0, off) + 1) + 1
            print(f"{f}:{line}:{col}: ${name}")
            total += 1
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
