#!/usr/bin/env python3
"""Relative links and anchors in markdown documents — the one parser every doc check uses.

Used by tests/client-docs.test.sh (the client guide and its entry points) and
tests/doc-links.test.sh (every external user document, plus the links in prompts/
and every AGENTS.md that point at them). Keep one copy: two parsers of the same
rule drift, and the copy that drifted is the one nobody runs.

How GitHub builds a heading's anchor, as implemented here:
  - the heading text keeps inline code: `AUTOPILOT_HUMAN_PATHS` contributes
    "autopilot_human_paths" (only the backticks go). Only fenced code blocks are
    skipped when looking for headings, since a "# comment" in a shell block is no
    heading. Dropping inline code before reading headings computed anchors GitHub
    does not generate, and a working link was reported broken
  - lower-case; keep letters, marks, numbers, connector punctuation ("_"), spaces
    and "-"; spaces become "-"
  - a repeated anchor gets "-1", "-2", ... in order
Links are read from the text with code (fenced and inline) removed, so a link
written as an example inside code is not checked.

Which files are external user documents is decided here too (external_docs), the
same list docs/AGENTS.md describes: README / CONTRIBUTING in both languages and every
*.md directly under docs/ except docs/AGENTS.md (agent-facing, English only).

Usage as a program:
  python3 tests/lib/doc_links.py <root> <doc>...            check every relative link in <doc>
  python3 tests/lib/doc_links.py --into <a,b,..> <root> <doc>...
        check only the links whose target file is one of the comma-separated
        repo-relative paths (for documents that are not themselves checked whole)
  --list   also print every checked link as "OK <doc> -> <target>" on stdout
  python3 tests/lib/doc_links.py --external <root>   print the external user documents
  python3 tests/lib/doc_links.py --pairs <root>      report an external document without
                                                      its other-language copy
Exit 0 = no problem; each problem is one line on stdout.
"""
import html.parser
import os
import re
import sys
import unicodedata
import urllib.parse

FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})')
HEADING = re.compile(r'^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$')
# Link syntax is scanned, not matched with one regular expression: a destination may
# hold nested balanced parentheses and backslash escapes, and an HTML attribute value
# may contain ">" or text that looks like another attribute. The forms read (and
# nothing else):
#   - inline links / images  [text](dest) ![alt](dest), with an optional "title",
#     'title' or (title); dest is <...> (may hold spaces) or a run without spaces whose
#     parentheses balance to any depth; "\(" "\)" and other backslash escapes count as
#     the plain character
#   - reference definitions  [label]: dest "title"  at the start of a line
#   - HTML tags <img>, <a>, <source> read by Python's HTML parser: src, href and every
#     URL of srcset, attribute values double-quoted, single-quoted or bare
# The <img> / <a> / <source> tags that carry one of those attributes are read first and
# blanked out before the markdown scan, so markdown-looking
# text inside an attribute value (alt="see [x](y)") is never taken for a link.
URL_ATTRS = ('src', 'href', 'srcset')
URL_TAGS = ('img', 'a', 'source')
ASCII_PUNCT = set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')
REF_START = re.compile(r'^ {0,3}\[(?:[^\]\\]|\\.)+\]:', re.M)


def slug(text):
    t = text.strip().lower().replace('`', '')
    t = re.sub(r'<[^>]+>', '', t)
    keep = ''.join(c for c in t if c in ' -' or unicodedata.category(c)[0] in 'LMN'
                   or unicodedata.category(c) == 'Pc')
    return keep.replace(' ', '-')


def outside_fences(text):
    """The lines of text that are not inside a fenced code block."""
    out, fence = [], None
    for line in text.splitlines():
        m = FENCE.match(line)
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) \
                    and line.strip() == m.group(1)[0] * len(line.strip()):
                fence = None
            continue
        if m:
            fence = m.group(1)
            continue
        out.append(line)
    return out


def strip_code(text):
    """Text with fenced blocks and inline code removed (for finding links)."""
    body = '\n'.join(outside_fences(text))
    return re.sub(r'(`+)(?:(?!\1).)+?\1', '', body, flags=re.S)


ROOT_DOCS = ('README.md', 'README.zh.md', 'CONTRIBUTING.md', 'CONTRIBUTING.zh.md')
AGENT_ONLY = ('docs/AGENTS.md',)


def external_docs(root):
    """External user documents, repo-relative, sorted."""
    out = [d for d in ROOT_DOCS if os.path.isfile(os.path.join(root, d))]
    ddir = os.path.join(root, 'docs')
    if os.path.isdir(ddir):
        out += ['docs/' + f for f in os.listdir(ddir)
                if f.endswith('.md') and os.path.isfile(os.path.join(ddir, f))
                and 'docs/' + f not in AGENT_ONLY]
    return sorted(out)


def missing_pairs(root):
    """An external document whose other-language copy (x.md <-> x.zh.md) is missing."""
    docs = set(external_docs(root))
    problems = []
    for d in sorted(docs):
        twin = d[:-len('.zh.md')] + '.md' if d.endswith('.zh.md') else d[:-len('.md')] + '.zh.md'
        if twin not in docs:
            problems.append(f'{d}: 缺另一种语言的版本 {twin}')
    return problems


_anchor_cache = {}


def anchors(path):
    path = os.path.abspath(path)
    if path not in _anchor_cache:
        out, seen = set(), {}
        for line in outside_fences(open(path, encoding='utf-8').read()):
            m = HEADING.match(line)
            if not m:
                continue
            s = slug(m.group(2))
            n = seen.get(s, 0)
            out.add(s if n == 0 else f'{s}-{n}')
            seen[s] = n + 1
        _anchor_cache[path] = out
    return _anchor_cache[path]


class _Tags(html.parser.HTMLParser):
    """Collects URL attributes of <img> / <a> / <source> and where each tag sits."""

    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.urls, self.spans = [], []
        self._starts = [0]
        for line in text.splitlines(keepends=True):
            self._starts.append(self._starts[-1] + len(line))

    def handle_starttag(self, tag, attrs):
        if tag.lower() not in URL_TAGS or not any(
                v is not None and n.lower() in URL_ATTRS for n, v in attrs):
            return   # not ours; also keeps a markdown <dest with spaces> out of the way
        raw = self.get_starttag_text() or ''
        line, col = self.getpos()
        at = self._starts[line - 1] + col
        self.spans.append((at, at + len(raw)))
        for name, value in attrs:
            if value is None or name.lower() not in URL_ATTRS:
                continue
            if name.lower() == 'srcset':
                self.urls += [p.split()[0] for p in value.split(',') if p.strip()]
            else:
                self.urls.append(value.strip())

    handle_startendtag = handle_starttag


def _unescape(dest):
    out, i = [], 0
    while i < len(dest):
        if dest[i] == '\\' and i + 1 < len(dest) and dest[i + 1] in ASCII_PUNCT:
            out.append(dest[i + 1])
            i += 2
        else:
            out.append(dest[i])
            i += 1
    return ''.join(out)


def _dest(s, i):
    """Parse a link destination starting at s[i] (after optional blanks).
    Returns (destination, index after it) or None when there is no valid one."""
    while i < len(s) and s[i] in ' \t':
        i += 1
    if i < len(s) and s[i] == '\n':
        i += 1
        while i < len(s) and s[i] in ' \t':
            i += 1
    if i >= len(s):
        return None
    if s[i] == '<':
        j = i + 1
        while j < len(s):
            if s[j] == '\\' and j + 1 < len(s):
                j += 2
                continue
            if s[j] in '<\n':
                return None
            if s[j] == '>':
                return _unescape(s[i + 1:j]), j + 1
            j += 1
        return None
    j, depth = i, 0
    while j < len(s):
        c = s[j]
        if c == '\\' and j + 1 < len(s) and s[j + 1] in ASCII_PUNCT:
            j += 2
            continue
        if c.isspace() or ord(c) < 0x20:
            break
        if c == '(':
            depth += 1
        elif c == ')':
            if depth == 0:
                break
            depth -= 1
        j += 1
    if j == i or depth != 0:
        return None
    return _unescape(s[i:j]), j


def _title_end(s, i):
    """Skip an optional title and blanks; return the index of the closing ')' or None."""
    while i < len(s) and s[i].isspace():
        i += 1
    if i < len(s) and s[i] in '"\'(':
        close = ')' if s[i] == '(' else s[i]
        j = i + 1
        while j < len(s) and s[j] != close:
            j += 2 if s[j] == '\\' else 1
        if j >= len(s):
            return None
        i = j + 1
        while i < len(s) and s[i].isspace():
            i += 1
    return i if i < len(s) and s[i] == ')' else None


def link_targets(text):
    """Every link target in markdown text (code already removed), in order of the
    three forms above."""
    tags = _Tags(text)
    tags.feed(text)
    tags.close()
    chars = list(text)
    for a, b in tags.spans:
        for k in range(a, min(b, len(chars))):
            if chars[k] != '\n':
                chars[k] = ' '
    md = ''.join(chars)
    found = []
    i = md.find('](')
    while i != -1:
        got = _dest(md, i + 2)
        if got and _title_end(md, got[1]) is not None:
            found.append(got[0])
        elif md[i + 2:i + 3] == ')':
            found.append('')   # [x]() : an empty target, reported as such
        i = md.find('](', i + 2)
    for m in REF_START.finditer(md):
        got = _dest(md, m.end())
        if got:
            found.append(got[0])
    return found + tags.urls


def links(path):
    return link_targets(strip_code(open(path, encoding='utf-8').read()))


def check(root, docs, into=None, listing=None):
    """Problems (one string each) for the relative links in docs. into: a set of
    repo-relative paths; when given, only links whose target is one of them count."""
    root = os.path.abspath(root)
    problems = []
    for doc in docs:
        path = os.path.join(root, doc)
        if not os.path.isfile(path):
            problems.append(f'{doc}: 文件不存在')
            continue
        for target in links(path):
            if target == '':
                problems.append(f'{doc}: 链接目标为空')
                continue
            if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('//'):
                continue   # absolute URL, mailto:, …
            file_part, _, frag = target.partition('#')
            file_part = urllib.parse.unquote(file_part)
            if file_part == '':
                dest = path
            elif file_part.startswith('/'):
                dest = os.path.normpath(os.path.join(root, file_part.lstrip('/')))
            else:
                dest = os.path.normpath(os.path.join(os.path.dirname(path), file_part))
            if into is not None and os.path.relpath(dest, root) not in into:
                continue
            if not os.path.exists(dest):
                problems.append(f'{doc}: 链接指向不存在的文件 {target}')
                continue
            if frag and dest.endswith('.md') and os.path.isfile(dest):
                if urllib.parse.unquote(frag) not in anchors(dest):
                    problems.append(f'{doc}: 锚点不存在 {target}')
                    continue
            if listing is not None:
                listing.append(f'OK {doc} -> {target}')
    return problems


def main(argv):
    into, show = None, False
    if len(argv) == 2 and argv[0] == '--external':
        print('\n'.join(external_docs(argv[1])))
        return 0
    if len(argv) == 2 and argv[0] == '--pairs':
        problems = missing_pairs(argv[1])
        for p in problems:
            print(p)
        return 1 if problems else 0
    while argv and argv[0].startswith('--'):
        opt = argv.pop(0)
        if opt == '--into':
            into = {p for p in argv.pop(0).split(',') if p}
        elif opt == '--list':
            show = True
        else:
            print(f'unknown option {opt}')
            return 2
    if not argv:
        print(__doc__)
        return 2
    listing = [] if show else None
    problems = check(argv[0], argv[1:], into, listing)
    for line in listing or []:
        print(line)
    for p in problems:
        print(p)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
