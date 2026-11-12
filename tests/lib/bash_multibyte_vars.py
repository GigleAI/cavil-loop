#!/usr/bin/env python3
"""Find `$NAME` expansions directly followed by a non-ASCII byte in bash scripts (GitHub#411).

macOS ships bash 3.2, which decides where a variable name ends with the C library's
isalnum() on single bytes. In a UTF-8 locale on macOS that is true for many bytes >= 0x80,
so in `"$label：x"` bash 3.2 reads the first byte of `：` as part of the name, looks up a
variable that does not exist, and under `set -u` exits ("label\\357: unbound variable").
The fix is always `${label}：`.

Only places where bash would actually expand count: unquoted code, double quotes, `$( )`,
backticks, `${ }` and unquoted here-documents. Single quotes, `$'...'`, comments and
here-documents with a quoted delimiter are literal text — rewriting them would change the
output — so they are skipped.

  bash_multibyte_vars.py check FILE...   print FILE:LINE:COL: $NAME for each hit; exit 1 if any
  bash_multibyte_vars.py fix FILE...     rewrite each hit to ${NAME} in place
"""
import re
import sys

NAME_START = re.compile(rb"[A-Za-z_]")
NAME_REST = re.compile(rb"[A-Za-z0-9_]*")
WORD_BREAK = b" \t\n;&|()<>"


class Scanner:
    def __init__(self, data):
        self.d = data
        self.n = len(data)
        self.hits = []          # (offset of '$', name)
        self.pending = []       # here-documents waiting for the end of the current line

    # ---- helpers -------------------------------------------------------------------------
    def _var(self, i):
        """At d[i] == '$'. Record a hit if it is $NAME + non-ASCII. Returns index after name."""
        j = i + 1
        if j < self.n and NAME_START.match(self.d, j):
            m = NAME_REST.match(self.d, j + 1)
            end = m.end()
            if end < self.n and self.d[end] >= 0x80:
                self.hits.append((i, self.d[j:end].decode()))
            return end
        return j

    def _heredoc_start(self, i):
        """At d[i:i+2] == '<<' (not '<<<'). Parse the delimiter, queue the body. Returns new i."""
        j = i + 2
        strip = False
        if j < self.n and self.d[j:j + 1] == b"-":
            strip = True
            j += 1
        while j < self.n and self.d[j:j + 1] in (b" ", b"\t"):
            j += 1
        quoted = False
        word = bytearray()
        while j < self.n and self.d[j:j + 1] not in (b" ", b"\t", b"\n", b";", b"&", b"|", b")", b"<", b">"):
            c = self.d[j:j + 1]
            if c in (b"'", b'"'):
                quoted = True
                k = self.d.find(c, j + 1)
                if k < 0:
                    k = self.n
                word += self.d[j + 1:k]
                j = k + 1
                continue
            if c == b"\\":
                quoted = True
                j += 1
                if j < self.n:
                    word += self.d[j:j + 1]
                j += 1
                continue
            word += c
            j += 1
        if word:
            self.pending.append((bytes(word), strip, quoted))
        return j

    def _heredoc_bodies(self, i):
        """At the start of a line, after a newline that ended a line with pending here-docs."""
        while self.pending:
            word, strip, quoted = self.pending.pop(0)
            while i < self.n:
                e = self.d.find(b"\n", i)
                if e < 0:
                    e = self.n
                line = self.d[i:e]
                cmp = line.lstrip(b"\t") if strip else line
                if cmp == word:
                    i = e + 1
                    break
                if not quoted:
                    self._dq_line(i, e)
                i = e + 1
        return i

    def _dq_line(self, i, end):
        """Expanding text without quote handling (here-doc body)."""
        while i < end:
            c = self.d[i]
            if c == 0x5C:  # backslash
                i += 2
                continue
            if c == 0x24:  # $
                if self.d[i + 1:i + 2] == b"(":
                    i = self.code(i + 2, b")")
                    continue
                if self.d[i + 1:i + 2] == b"{":
                    i = self.brace(i + 2, True)
                    continue
                i = self._var(i)
                continue
            if c == 0x60:  # backtick
                i = self.code(i + 1, b"`")
                continue
            i += 1

    # ---- contexts ------------------------------------------------------------------------
    def dquote(self, i):
        """Inside "...", from just after the opening quote. Returns index after closing quote."""
        while i < self.n:
            c = self.d[i]
            if c == 0x5C:
                i += 2
                continue
            if c == 0x22:
                return i + 1
            if c == 0x24:
                if self.d[i + 1:i + 2] == b"(":
                    i = self.code(i + 2, b")")
                    continue
                if self.d[i + 1:i + 2] == b"{":
                    i = self.brace(i + 2, True)
                    continue
                i = self._var(i)
                continue
            if c == 0x60:
                i = self.code(i + 1, b"`")
                continue
            i += 1
        return i

    def brace(self, i, in_dq):
        """Inside ${...}, from just after '{'. Returns index after the matching '}'.

        Whether a single quote inside the braces quotes depends on where the expansion sits
        (measured on bash 5.2): outside double quotes it always quotes; inside double quotes
        (or an unquoted here-doc body) it is an ordinary character after the default-value
        operators (- = ? + with or without ':'), so "${x:+'$y'}" still expands $y, while after
        the pattern operators (# % / ^ ,) it quotes as usual.
        """
        j = i
        if self.d[j:j + 1] in (b"!", b"#") and self.d[j + 1:j + 2] not in (b"}", b""):
            j += 1                                  # ${!name} / ${#name}
        m = re.compile(rb"[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-]").match(self.d, j)
        if m:
            j = m.end()
        if self.d[j:j + 1] == b"[":                 # ${a[...]}
            k = self.d.find(b"]", j)
            j = self.n if k < 0 else k + 1
        op = self.d[j:j + 2]
        default_op = op[:1] in (b"-", b"=", b"?", b"+") or op in (b":-", b":=", b":?", b":+")
        squote_literal = in_dq and default_op
        i = j
        while i < self.n:
            c = self.d[i]
            if c == 0x5C:
                i += 2
                continue
            if c == 0x7D:
                return i + 1
            if c == 0x22:
                i = self.dquote(i + 1)
                continue
            if c == 0x27 and not squote_literal:
                k = self.d.find(b"'", i + 1)
                i = self.n if k < 0 else k + 1
                continue
            if c == 0x24:
                if self.d[i + 1:i + 2] == b"(":
                    i = self.code(i + 2, b")")
                    continue
                if self.d[i + 1:i + 2] == b"{":
                    i = self.brace(i + 2, in_dq)
                    continue
                i = self._var(i)
                continue
            if c == 0x60:
                i = self.code(i + 1, b"`")
                continue
            i += 1
        return i

    def code(self, i, close):
        """Unquoted shell code. close is None (top level), b')' or b'`'. Returns index after close."""
        depth = 0
        at_word_start = True
        while i < self.n:
            c = self.d[i]
            ch = self.d[i:i + 1]
            if close == b"`" and ch == b"`":
                return i + 1
            if close == b")" and ch == b")":
                if depth == 0:
                    return i + 1
                depth -= 1
                i += 1
                at_word_start = True
                continue
            if ch == b"(":
                depth += 1 if close == b")" else 0
                i += 1
                at_word_start = True
                continue
            if c == 0x5C:
                if self.d[i + 1:i + 2] == b"\n" and self.pending:
                    i += 2
                    continue
                i += 2
                at_word_start = False
                continue
            if ch == b"\n":
                i += 1
                if self.pending:
                    i = self._heredoc_bodies(i)
                at_word_start = True
                continue
            if ch == b"#" and at_word_start:
                e = self.d.find(b"\n", i)
                i = self.n if e < 0 else e
                continue
            if ch == b"'":
                k = self.d.find(b"'", i + 1)
                i = self.n if k < 0 else k + 1
                at_word_start = False
                continue
            if ch == b'"':
                i = self.dquote(i + 1)
                at_word_start = False
                continue
            if ch == b"`":
                i = self.code(i + 1, b"`")
                at_word_start = False
                continue
            if ch == b"$":
                nx = self.d[i + 1:i + 2]
                if nx == b"'":
                    k = i + 2
                    while k < self.n and self.d[k:k + 1] != b"'":
                        k += 2 if self.d[k:k + 1] == b"\\" else 1
                    i = k + 1
                elif nx == b"(":
                    i = self.code(i + 2, b")")
                elif nx == b"{":
                    i = self.brace(i + 2, False)
                else:
                    i = self._var(i)
                at_word_start = False
                continue
            if self.d[i:i + 3] == b"<<<":      # here-string: an ordinary word follows
                i += 3
                at_word_start = True
                continue
            if self.d[i:i + 2] == b"<<":
                i = self._heredoc_start(i)
                at_word_start = False
                continue
            at_word_start = ch in WORD_BREAK
            i += 1
        return i


def scan(data):
    s = Scanner(data)
    s.code(0, None)
    return s.hits


def line_col(data, off):
    line = data.count(b"\n", 0, off) + 1
    col = off - (data.rfind(b"\n", 0, off) + 1) + 1
    return line, col


def main(argv):
    if len(argv) < 2 or argv[1] not in ("check", "fix"):
        sys.stderr.write(__doc__)
        return 2
    mode, files = argv[1], argv[2:]
    total = 0
    for f in files:
        with open(f, "rb") as fh:
            data = fh.read()
        hits = scan(data)
        total += len(hits)
        if mode == "check":
            for off, name in hits:
                ln, col = line_col(data, off)
                print(f"{f}:{ln}:{col}: ${name}")
        elif hits:
            out = bytearray(data)
            for off, name in sorted(hits, reverse=True):
                end = off + 1 + len(name)
                out[off:end] = b"${" + name.encode() + b"}"
            with open(f, "wb") as fh:
                fh.write(out)
            print(f"{f}: {len(hits)}")
    if mode == "check":
        return 1 if total else 0
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
