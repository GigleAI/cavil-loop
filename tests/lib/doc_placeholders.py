#!/usr/bin/env python3
"""Upper-case names in the orchestration guide — the one reader both of its tests use.

tests/orchestration-docs.test.sh (text check) and tests/orchestration-placeholders.test.sh
(runs the real dispatch scripts) both take the placeholder table from `table()` here, so the
two cannot disagree on what the table lists.

Everything is read from one pass over the lines, `lines_of()`: each line is text or code
(the fence rule is `fence_kinds` in tests/lib/doc_links.py, shared with the link check),
and carries the real `##` / `###` heading it sits under. Headings and table rows are only
ever taken from text lines, so a heading or a table quoted inside a code block changes
nothing. Every rule below reads that one result — never a second scan with its own idea of
where a section or a code block starts.

Every occurrence of an upper-case name is judged where it stands, one occurrence at a time:
  - kind "set":     `NAME=…` in inline code, or an assignment in a code block
  - kind "ref":     `$NAME` / `${NAME}` read in a command or in prose
  - kind "mention": a bare `NAME` in inline code
No shell semantics are inferred (see occurrences()): an example script's own variables are
written in lower case (the rule in docs/AGENTS.md), so they are never looked at, and an
upper-case name is always a setting or a variable the tool passes.
Placement rules (check()):
  - a ${NAME} in the "compose prompt" section (the ## section holding the placeholder table)
    is a template placeholder, valid when the table lists it;
  - in a hook's section (its heading names the hook's setting) a "ref" or a "mention" of an
    environment variable must be one that hook's caller passes; a config setting is never
    something a hook receives, so a "ref" of a setting there is an error too;
  - elsewhere: a config setting, a registered hook variable, or a ${NAME} from the table on a
    line that says it is a placeholder.
Usage:
  python3 tests/lib/doc_placeholders.py table <doc>
  python3 tests/lib/doc_placeholders.py names <doc>
  python3 tests/lib/doc_placeholders.py check <doc> <config example> <envs file> <repo>
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from doc_links import fence_kinds  # noqa: E402  (the one fence rule)

PH_HEAD = re.compile(r'^### (Placeholders|占位符)\s*$')
NAME = r'[A-Z][A-Z0-9_]{1,}'
SHELL = {'HOME', 'PWD', 'PATH', 'USER'}   # the shell's own, set for every command
# Which script hands a hook its environment, by the setting named in the section heading.
HOOK_FILE = {'PR_CREATED_HOOK': 'prompts/issue-comment.template.md',
             'CLEANUP_HOOK': 'scripts/cleanup-issue.sh',
             'LATEST_SITE_REFRESH': 'scripts/refresh-latest-site.sh',
             'POST_RETROSPECTIVE_PROJECT_CMD': 'scripts/post-merge-retrospective.py'}
# Assignments in a code block (an upper-case one must be a setting or a registered variable).
SET_RES = [re.compile(r'(?:^\s*|[;&|(]\s*|\b(?:export|local|readonly|declare(?:\s+-\w+)*)\s+)(' + NAME + r')='),
           re.compile(r'\bfor\s+(' + NAME + r')\s+in\b'),
           re.compile(r'\bread\s+(?:-\w+\s+)*(' + NAME + r')\b')]
REF_RE = re.compile(r'\$(\{)?(' + NAME + r')')


class Line:
    __slots__ = ('n', 'text', 'kind', 'h2', 'h3', 'block')

    def __init__(self, n, text, kind, h2, h3, block):
        self.n, self.text, self.kind, self.h2, self.h3, self.block = n, text, kind, h2, h3, block


def lines_of(text):
    """Every line with its kind (text / code / open / close), real headings, code block id."""
    raw = text.splitlines()
    out, h2, h3, block = [], None, None, 0
    for i, (line, kind) in enumerate(zip(raw, fence_kinds(raw)), 1):
        if kind == 'open':
            block += 1
        if kind == 'text':
            if line.startswith('## '):
                h2, h3 = line, None
            elif line.startswith('### '):
                h3 = line
        out.append(Line(i, line, kind, h2, h3, block if kind == 'code' else 0))
    return out


def table(lines):
    """The names in the first column of the placeholder table (text lines only)."""
    out = set()
    for ln in lines:
        if ln.kind == 'text' and ln.h3 and PH_HEAD.match(ln.h3) and ln.text.startswith('|'):
            out |= set(re.findall(r'\$\{(' + NAME + r')\}', ln.text.split('|')[1]))
    return out


def occurrences(lines):
    """(Line, name, kind, braced) for every upper-case name, in reading order; kind is
    set / ref / mention. No shell semantics are inferred: whether a line in a code block
    assigns a variable before another line reads it depends on how the shell runs it
    (indentation, subshells, command-prefix assignments, the right-hand side read first,
    commented-out lines), and every textual guess at that got cases wrong both ways. Instead
    the guide follows one writing rule (docs/AGENTS.md): an example script's own variables
    are lower-case, so every upper-case name is a setting or a variable the tool passes."""
    out = []
    for ln in lines:
        if ln.kind == 'code':
            ev = []
            for rx in SET_RES:
                ev += [(m.start(1), 'set', m.group(1), False) for m in rx.finditer(ln.text)]
            ev += [(m.start(), 'ref', m.group(2), bool(m.group(1))) for m in REF_RE.finditer(ln.text)]
            out += [(ln, n, kind, brace) for _, kind, n, brace in sorted(ev, key=lambda e: e[0])]
            continue
        if ln.kind != 'text':
            continue
        for code in re.findall(r'`([^`]+)`', ln.text):
            code = code.strip()
            m = re.match(r'^(' + NAME + r')=', code)
            if m:
                out.append((ln, m.group(1), 'set', False))
            elif re.match(r'^' + NAME + r'$', code):
                out.append((ln, code, 'mention', False))
            for m in REF_RE.finditer(code):
                out.append((ln, m.group(2), 'ref', bool(m.group(1))))
    return out


def config_keys(path):
    return set(re.findall(r'^\s*#?\s*(' + NAME + r')=', open(path, encoding='utf-8').read(), re.M))


def check(doc, conf, envs, repo):
    lines = lines_of(open(doc, encoding='utf-8').read())
    keys = config_keys(conf)
    env = {}
    for line in open(envs, encoding='utf-8'):
        if line.strip():
            n, *files = line.split()
            env[n] = files
    tab = table(lines)
    owner = next((ln.h2 for ln in lines if ln.kind == 'text' and PH_HEAD.match(ln.text)), None)
    bad, seen = [], set()
    if not tab:
        bad.append('没找到占位符表')
    for ln, n, kind, brace in occurrences(lines):
        if n in SHELL:
            continue                                # the shell's own
        sect = ln.h2
        hook = next((f for k, f in HOOK_FILE.items() if sect and '`' + k + '`' in sect), None)
        if sect == owner and brace and n in tab:
            continue                                # a template placeholder where templates are composed
        if hook:
            if kind in ('set', 'mention') and n in keys:
                continue                            # a config line naming the setting / naming it in prose
            if n in env and hook in env[n]:
                seen.add(n)
                continue                            # the hook really receives it
            if kind == 'set' and n in env:
                seen.add(n)
                continue                            # setting a registered variable for a command
            bad.append(f'{n}: 第 {ln.n} 行在 {hook} 调起的挂点一节，但它不把 {n} 传给挂点')
            continue
        if n in keys:
            continue
        if brace and n in tab and re.search(r'placeholder|占位符', ln.text):
            continue
        if n in env:
            seen.add(n)
            continue
        bad.append(f'{n}: 第 {ln.n} 行，不是配置样例里的设置，也不是这里登记过的挂点环境变量')
    for n in sorted(seen):
        for f in env[n]:
            t = open(f'{repo}/{f}', encoding='utf-8').read()
            if not re.search(rf'(^|[^A-Z0-9_]){n}=|["\']{n}["\']|\$\{{{n}[:}}]', t):
                bad.append(f'{n}: {f} 里没有把它传给挂点脚本')
    return bad


def main(argv):
    mode, *args = argv
    if mode == 'table':
        print('\n'.join(sorted(table(lines_of(open(args[0], encoding='utf-8').read())))))
        return 0
    if mode == 'names':
        lines = lines_of(open(args[0], encoding='utf-8').read())
        print('\n'.join(sorted({o[1] for o in occurrences(lines)})))
        return 0
    if mode == 'check':
        bad = check(*args)
        if bad:
            print('\n'.join(bad))
        return 1 if bad else 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
