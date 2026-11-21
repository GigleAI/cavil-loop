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


def outside_fences(text):
    """The lines of text that are not inside a fenced code block (for headings)."""
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
            # markdown-it percent-encodes destinations; report them as written
            target = urllib.parse.unquote(target)
            if target == '':
                if into is None or os.path.relpath(path, root) in into:
                    problems.append(f'{doc}: 链接目标为空')
                continue
            if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('//'):
                continue   # absolute URL, mailto:, …
            file_part, _, frag = target.partition('#')
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
