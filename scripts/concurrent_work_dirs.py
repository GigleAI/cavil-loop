#!/usr/bin/env python3
r"""Directories a branch touches, for the "other work in progress" list (GitHub#598).

stdin : the output of `git diff -z --name-only <base>...<head>` — raw paths, NUL-separated,
        never quoted or escaped by git.
argv  : <how many directories to show>
stdout: one line, `<count>\x1f<shown>` — <count> is the number of distinct parent directories,
        <shown> the first <max> of them (byte order) joined with 「、」, each in backticks; files
        at the top of the repository are 仓库根目录 (no backticks).

The whole path from git's bytes to the text an agent reads is in this one file. Review rounds on
PR #604 each found a different place that lost a directory's identity:
  1. taking the parent of git's *quoted* display form split one directory in two;
  2. decoding before grouping merged two directories that differ in one non-UTF-8 byte;
  3. the display name then printed both of those as the same `a\ufffd/`;
  4. a hash added only when two names in the *same item* looked alike made one directory read
     differently in two items, and an invalid byte and a valid control character shared `\x85`;
  5. a cut name carried only 8 hex digits of its hash: two real 84- / 85-character names were
     found that cut to the same text and the same 8 digits.
So the display name of a directory is a function of that directory's raw bytes alone — never of
which other directories are listed with it — and different raw bytes always give different text:
  - group and count on raw bytes (byte order);
  - escaping: valid UTF-8 is kept as is, except `\` -> `\\`, the backtick and every control /
    format / line or paragraph separator / unassigned / private-use / non-space whitespace
    character -> `\u{HEX}`; a byte that is not part of valid UTF-8 -> `\xHH`. Each escape is
    marked by its own prefix (`\\`, `\u{`, `\x`) and a literal backslash is itself escaped, so the
    text can be decoded back to the exact bytes: the mapping is one-to-one;
  - a name longer than SHOW_MAX_CHARS after escaping is cut there and gets `…#<the full 64-hex
    sha256 of its raw bytes>` — a cut name is always longer than any uncut one, so the two kinds
    never meet, and two cut names differ unless SHA-256 itself collides (finding one pair takes about
    2^128 hash computations). Fewer digits are not "enough in practice": with 8, a colliding pair of
    real directory names was found by brute force in review round 5.
Two items that touch the same directory therefore show the same text, and two different
directories never show the same text.
"""
import hashlib
import sys
import unicodedata

SHOW_MAX_CHARS = 80   # longer display names are cut and carry a hash
ROOT = "仓库根目录"


def _char(c):
    if c == "\\":
        return "\\\\"
    cat = unicodedata.category(c)
    if c == "`" or cat in ("Cc", "Cf", "Zl", "Zp", "Cs", "Co", "Cn") or (cat == "Zs" and c != " ") \
            or (c.isspace() and c != " "):
        return "\\u{%x}" % ord(c)
    return c


def escape(raw):
    # surrogateescape turns each byte that is not valid UTF-8 into U+DC80..U+DCFF; valid UTF-8
    # never decodes to a surrogate, so those (and only those) are the invalid bytes
    out = []
    for c in raw.decode("utf-8", "surrogateescape"):
        o = ord(c)
        out.append("\\x%02x" % (o - 0xDC00) if 0xDC80 <= o <= 0xDCFF else _char(c))
    return "".join(out)


def show(raw):
    s = escape(raw)
    return s if len(s) <= SHOW_MAX_CHARS else s[:SHOW_MAX_CHARS] + "…#" + tag(raw)


def tag(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    show_max = int(sys.argv[1])
    data = sys.stdin.buffer.read()
    dirs = sorted({(p.rsplit(b"/", 1)[0] + b"/") if b"/" in p else b"" for p in data.split(b"\0") if p})
    shown = dirs[:show_max]
    parts = [ROOT if d == b"" else "`" + show(d) + "`" for d in shown]
    sys.stdout.write("%d\x1f%s\n" % (len(dirs), "、".join(parts)))


if __name__ == "__main__":
    main()
