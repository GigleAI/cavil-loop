#!/usr/bin/env python3
"""Directories a branch touches, for the "other work in progress" list (GitHub#598).

stdin : the output of `git diff -z --name-only <base>...<head>` — raw paths, NUL-separated,
        never quoted or escaped by git.
argv  : <how many directories to show>
stdout: one line, `<count>\x1f<shown>` — <count> is the number of distinct parent directories,
        <shown> the first <max> of them (byte order) joined with 「、」, each in backticks; files
        at the top of the repository are 仓库根目录 (no backticks).

The whole path from git's bytes to the text an agent reads is in this one file, because three
review rounds on PR #604 each found a different place that lost a directory's identity:
  1. taking the parent of git's *quoted* display form split one directory in two;
  2. decoding before grouping merged two directories that differ in one non-UTF-8 byte;
  3. the display name then printed both of those as the same `a�/`.
So: group and count on raw bytes; turn each into a display name with an escaping that is
one-to-one (two different byte strings never give the same text); shorten a long name only
by adding a hash of its raw bytes; and tag any names that would still look alike to a reader
(same text after Unicode normalisation and case folding) with that hash as well.

Escaping: valid UTF-8 is kept as is, except `\\` -> `\\\\`, the backtick -> `\\x60` (names sit
inside backticks) and every control / format / line- or paragraph-separator / non-space
whitespace character -> `\\xHH` or `\\uHHHH`; a byte that is not part of valid UTF-8 -> `\\xHH`.
Every escape starts with a backslash and a literal backslash is itself escaped, so the mapping
is reversible and therefore one-to-one.
"""
import hashlib
import sys
import unicodedata

SHOW_MAX_CHARS = 80   # longer display names are cut and carry a hash
ROOT = "仓库根目录"


def _char(c):
    if c == "\\":
        return "\\\\"
    if c == "`":
        return "\\x60"
    cat = unicodedata.category(c)
    if cat in ("Cc", "Cf", "Zl", "Zp", "Cs", "Co", "Cn") or (cat == "Zs" and c != " ") or (c.isspace() and c != " "):
        o = ord(c)
        return "\\x%02x" % o if o < 0x100 else ("\\u%04x" % o if o < 0x10000 else "\\U%08x" % o)
    return c


def escape(raw):
    # surrogateescape turns each byte that is not valid UTF-8 into U+DC80..U+DCFF; valid UTF-8
    # never decodes to a surrogate, so those (and only those) are the invalid bytes
    out = []
    for c in raw.decode("utf-8", "surrogateescape"):
        o = ord(c)
        out.append("\\x%02x" % (o - 0xDC00) if 0xDC80 <= o <= 0xDCFF else _char(c))
    return "".join(out)


def tag(raw):
    return hashlib.sha256(raw).hexdigest()[:8]


def main():
    show_max = int(sys.argv[1])
    data = sys.stdin.buffer.read()
    dirs = sorted({(p.rsplit(b"/", 1)[0] + b"/") if b"/" in p else b"" for p in data.split(b"\0") if p})
    shown = dirs[:show_max]
    names = {}
    for d in shown:
        if d == b"":
            continue
        s = escape(d)
        if len(s) > SHOW_MAX_CHARS:
            s = s[:SHOW_MAX_CHARS] + "…#" + tag(d)
        names[d] = s
    # names that would read the same to a person (normalisation, case) get their hash too
    looks = {}
    for d, s in names.items():
        looks.setdefault(unicodedata.normalize("NFKC", s).casefold(), []).append(d)
    for group in looks.values():
        if len(group) > 1:
            for d in group:
                if "#" + tag(d) not in names[d]:
                    names[d] += "#" + tag(d)
    parts = [ROOT if d == b"" else "`" + names[d] + "`" for d in shown]
    sys.stdout.write("%d\x1f%s\n" % (len(dirs), "、".join(parts)))


if __name__ == "__main__":
    main()
