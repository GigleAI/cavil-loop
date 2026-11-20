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
import os
import re
import sys
import unicodedata
import urllib.parse

FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})')
HEADING = re.compile(r'^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$')
MD_LINK = re.compile(r'!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)')
REF_DEF = re.compile(r'^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$', re.M)
HTML_ATTR = re.compile(r'<(?:img|a|source)\b[^>]*?\s(?:src|href|srcset)="([^"]+)"', re.I)


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


def links(path):
    text = strip_code(open(path, encoding='utf-8').read())
    found = MD_LINK.findall(text) + REF_DEF.findall(text)
    for v in HTML_ATTR.findall(text):
        found += [p.split()[0] for p in v.split(',')] if ' ' in v.strip() else [v]
    return found


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
