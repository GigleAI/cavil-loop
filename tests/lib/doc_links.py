#!/usr/bin/env python3

# ── External user documents in general: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# External user documents in general (GitHub#615: the rules in `docs/AGENTS.md`, the shared parser and
# the list of external documents in `tests/lib/doc_links.py`) → `tests/doc-links.test.sh` (~2 s; every
# relative link and anchor in the external documents, the links in `prompts/`, `.agents/` and every
# AGENTS.md that point at them, each document's other-language copy). Anchors keep the text of inline
# code in a heading (GitHub does; only the backticks go) — the earlier client-guide parser dropped
# inline code first and reported working links as broken. Markdown links, images and reference
# definitions are read by markdown-it-py, a CommonMark parser vendored under `tests/lib/vendor/` (MIT,
# with its `mdurl` dependency; copied unchanged from the Debian packages, `cli/` left out — see the
# README there; never edit those files, copy a newer release over them); raw HTML it passes through is
# read by Python's HTML parser for the `src` / `href` / `srcset` of `<img>` / `<a>` / `<source>`. Code
# and HTML comments therefore never yield a link, exactly as GitHub renders. Every reference
# definition is checked, used or not. The test keeps a table of link forms (existing and missing), one
# of non-links and one of block contexts (lists, quotes, indented code), and asserts the vendored copy
# is the one imported. Why a vendored parser: a hand-written scanner was found reading a new form
# wrongly in each of review rounds 1–4 on PR #620 (cut `draft(v(2)).md` short, ignored
# `src=missing.png`, read text, a title and a comment as links, skipped a definition after a fenced
# block), and the maintainer chose the parser (PR #620 Q1 = A); the tests need nothing installed, so
# CI is unchanged. `tests/client-docs.test.sh` uses the same module; never copy the parser again. No
# issue / PR numbers in the external documents (GitHub#617) → `tests/doc-numbers.test.sh` (~1 s):
# `--numbers` in the same module scans exactly `external_docs` — command blocks included, since a
# shell comment in a documented command is read by users — for `GitHub#N`, `PR #N`, `owner/repo#N` and
# a parenthesised `(#N)`; every AGENTS.md, `prompts/`, `.agents/`, `docs/retrospectives/` and
# `docs/design/` keep their numbers and are never scanned. A bare `#42` and a link whose text is a
# number are let through on purpose (the README's worked example, a search example, a link to a
# feature still in progress) — telling those from a history reference needs a reader, so the reviewer
# checks them. A number inside a command block a test runs verbatim is changed in both languages
# together (the tests compare the two copies). The orchestration guide (`docs/orchestration{,.zh}.md`,
# the third diagram in `scripts/doc-diagrams/gen.py`) → `tests/orchestration-docs.test.sh` (~3 s:
# every upper-case name is judged per occurrence where it stands by `tests/lib/doc_placeholders.py`
# (GitHub#617) — a `${NAME}` counts as a template placeholder only in the compose-prompt section and
# only when the placeholder table lists it; in a hook's section a name read there must be one that
# hook's caller passes, never a config setting, and an assignment on the same line never covers a
# read; no shell semantics are inferred (when an assignment takes effect cannot be read off the text —
# indentation, subshells, command-prefix assignments and commented-out lines each broke a guess in
# review rounds 3–4 of PR #642), so the guide's example scripts write their own variables in lower
# case (rule in `docs/AGENTS.md`, for the orchestration guide only — other documents' command blocks
# are not bound by it) and every upper-case name is checked; elsewhere a setting in the config example
# or an environment variable the calling script really reads or passes — both languages name the same
# ones, folds and headings, the two example hooks and the forced latest-site rebuild run verbatim with
# only HOME / PATH — the rebuild against the real `refresh-latest-site.sh` with the tool at
# `~/.agents/skills/cavil-loop` and the project elsewhere, checking what was built from a clean main
# checkout, one with uncommitted edits — they go into the build while HEAD is recorded — and one on
# another branch) plus `tests/doc-diagrams.test.sh`. Whether each placeholder in the table is really
# rendered is checked by running the three real dispatch scripts in a clean environment →
# `tests/orchestration-placeholders.test.sh` (~10 s): every table name has an expected value per entry
# (exact value, pattern, empty, or left as `${NAME}`), a name without an expectation or an expectation
# without a name fails, and a missing output line is a failure, never "replaced" — a new placeholder
# in the table needs its row there; its two latest-site-refresh boundaries (cleanup on merge off → no
# refresh; cleanup script fails → refresh still starts, and again next poll) are run against the real
# poller in `tests/project-config-poll.test.sh` 【4b】
#
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
Links are read by markdown-it-py, a CommonMark parser vendored under
tests/lib/vendor/ (see its README): every link / image destination and every reference
definition it finds, used or not. Raw HTML it passes through (html_inline / html_block
tokens) is read by Python's HTML parser for the src / href / srcset of <img>, <a> and
<source>. Code (fenced, indented, inline) and HTML comments therefore never yield a link,
exactly as GitHub renders them. The Markdown side used to be a hand-written scanner;
review rounds 1-4 on PR #620 each found a form it read wrongly, and the maintainer chose
the parser (PR #620, Q1 = A).

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
  python3 tests/lib/doc_links.py --numbers <root>    report every issue / PR number written
                                                      into an external document (see NUMBER)
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
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor'))
from markdown_it import MarkdownIt  # noqa: E402  (vendored, see vendor/README.md)

URL_ATTRS = ('src', 'href', 'srcset')
URL_TAGS = ('img', 'a', 'source')
_MD = MarkdownIt('commonmark')


def slug(text):
    t = text.strip().lower().replace('`', '')
    t = re.sub(r'<[^>]+>', '', t)
    keep = ''.join(c for c in t if c in ' -' or unicodedata.category(c)[0] in 'LMN'
                   or unicodedata.category(c) == 'Pc')
    return keep.replace(' ', '-')


def fence_kinds(lines):
    """For every line: 'open' / 'close' (a fence line), 'code' (inside a fenced block) or
    'text'. The one reading of where fenced code starts and ends: headings and table rows
    are only looked for on 'text' lines, by every doc check (tests/lib/doc_placeholders.py
    too). An unclosed fence runs to the end, as GitHub renders it."""
    out, fence = [], None
    for line in lines:
        m = FENCE.match(line)
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) \
                    and line.strip() == m.group(1)[0] * len(line.strip()):
                fence = None
                out.append('close')
            else:
                out.append('code')
            continue
        if m:
            fence = m.group(1)
            out.append('open')
            continue
        out.append('text')
    return out


def outside_fences(text):
    """The lines of text that are not inside a fenced code block (for headings)."""
    lines = text.splitlines()
    return [l for l, k in zip(lines, fence_kinds(lines)) if k == 'text']


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


# Issue / PR numbers of this repo's own work, as they get written into prose: "GitHub#461",
# "PR #620" / "PR#620" / "PRs #1", "owner/repo#12", and a parenthesised "(#337)" / "（#337）".
# External user documents say how things work now; where a number came from belongs in
# AGENTS.md (docs/AGENTS.md). Deliberately not matched: a bare "#42" (the README's worked
# example "say you get #42", a search for "#135", "sort key #1") and a link whose text is
# the number ("[#628](https://github.com/.../issues/628)", a feature still in progress) —
# both are legitimate, and telling them from a history reference needs a reader.
# Code blocks are scanned too: a shell comment in a documented command is read by users.
NUMBER = re.compile(r'GitHub#\d+|\bPRs? ?#\d+|\b[\w.-]+/[\w.-]+#\d+(?![\w-])|[（(]#\d+')


def issue_numbers(root):
    """Every issue / PR number in an external document: "<doc>:<line>: <match>"."""
    problems = []
    for d in external_docs(root):
        with open(os.path.join(root, d), encoding='utf-8') as f:
            for n, line in enumerate(f, 1):
                for m in NUMBER.finditer(line):
                    problems.append(f'{d}:{n}: 写了编号 {m.group(0)}')
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
    """The src / href / srcset values of <img>, <a> and <source> in a piece of raw HTML."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.urls = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() not in URL_TAGS:
            return
        for name, value in attrs:
            if value is None or name.lower() not in URL_ATTRS:
                continue
            if name.lower() == 'srcset':
                self.urls += [p.split()[0] for p in value.split(',') if p.strip()]
            else:
                self.urls.append(value.strip())

    handle_startendtag = handle_starttag


def _walk(tokens, md_out, html_parts):
    for t in tokens:
        if t.type == 'link_open':
            md_out.append(t.attrs.get('href', ''))
        elif t.type == 'image':
            md_out.append(t.attrs.get('src', ''))
        elif t.type in ('html_inline', 'html_block'):
            html_parts.append(t.content)
        if t.children:
            _walk(t.children, md_out, html_parts)


def link_targets(text):
    """Every link target in a markdown document: markdown links and images, every
    reference definition (used or not), then the URL attributes of HTML tags."""
    env = {}
    md_out, html_parts = [], []
    _walk(_MD.parse(text, env), md_out, html_parts)
    # every definition is checked, used or not; one whose target a link already
    # carries adds nothing (that target is checked anyway) and is not listed twice
    seen = set(md_out)
    md_out += [h for h in (d.get('href', '') for d in env.get('references', {}).values())
               if h not in seen]
    tags = _Tags()
    # one HTML tag can be split over several html_inline tokens only across lines, never
    # within a tag, so feeding the pieces one after another reads every tag whole
    for part in html_parts:
        tags.feed(part)
    tags.close()
    return md_out + tags.urls


def links(path):
    return link_targets(open(path, encoding='utf-8').read())


ABSOLUTE = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.-]*:')


def split_target(raw):
    """One link address -> (kind, path, query, anchor); kind is 'empty', 'absolute' or
    'relative'. The single place that decides how an address splits:
      - '' is empty; "scheme:..." and "//host/..." are absolute and nothing else of
        them is looked at (so an address only a URL library would reject, such as
        https://[invalid]/, is skipped like any other absolute one)
      - otherwise the still-encoded text is cut at the first "#" (anchor), then the
        part before it at the first "?" (query); only then are path and anchor
        percent-decoded. So "%23" / "%3F" in a file name stay part of the name and a
        "?query" never becomes part of the file
    query is None when there is no "?", anchor is None when there is no "#"."""
    if raw == '':
        return 'empty', '', None, None
    if ABSOLUTE.match(raw) or raw.startswith('//'):
        return 'absolute', '', None, None
    rest, hash_, frag = raw.partition('#')
    path, qmark, query = rest.partition('?')
    return ('relative', urllib.parse.unquote(path), query if qmark else None,
            urllib.parse.unquote(frag) if hash_ else None)


def shown(path, query, frag):
    """How a relative target is reported: decoded, with "%", "#" and "?" inside the
    path encoded again so they cannot be mistaken for separators."""
    return (path.replace('%', '%25').replace('#', '%23').replace('?', '%3F')
            + ('' if query is None else '?' + query)
            + ('' if frag is None else '#' + frag))


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
        for raw in links(path):
            try:
                kind, file_part, query, frag = split_target(raw)
            except Exception as e:  # never stop the whole document on one address
                problems.append(f'{doc}: 链接地址无法解析 {raw}（{type(e).__name__}）')
                continue
            if kind == 'empty':
                if into is None or os.path.relpath(path, root) in into:
                    problems.append(f'{doc}: 链接目标为空')
                continue
            if kind == 'absolute':
                continue   # absolute URL, mailto:, //host/…
            target = shown(file_part, query, frag)
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
                if frag not in anchors(dest):
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
    if len(argv) == 2 and argv[0] == '--numbers':
        problems = issue_numbers(argv[1])
        for p in problems:
            print(p)
        return 1 if problems else 0
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
