#!/usr/bin/env python3
"""Upper-case names in the orchestration guide — the one reader both of its tests use.

tests/orchestration-docs.test.sh (text check) and tests/orchestration-placeholders.test.sh
(runs the real dispatch scripts) both take the placeholder table from `table()` here, so the
two cannot disagree on what the table lists.

Every occurrence of a name is judged where it stands, one occurrence at a time — never merged
with another occurrence on the same line:
  - kind "set":     `NAME=…`  (a config line or a shell assignment)
  - kind "ref":     `$NAME` / `${NAME}` read in a command or in prose
  - kind "mention": a bare `NAME` in inline code
Placement rules (check()):
  - a ${NAME} in the "compose prompt" section (the ## section holding the placeholder table)
    is a template placeholder, valid when the table lists it;
  - in a hook's section (its heading names the hook's setting) a "ref" or "mention" of an
    environment variable must be one that hook's caller passes; a config setting is never
    something a hook receives, so a "ref" of a setting there is an error too — only a bare
    mention or a `NAME=` config line may name a setting;
  - elsewhere: a config setting, a registered hook variable, or a ${NAME} from the table on a
    line that says it is a placeholder.
Usage:
  python3 tests/lib/doc_placeholders.py table <doc>
  python3 tests/lib/doc_placeholders.py names <doc>
  python3 tests/lib/doc_placeholders.py check <doc> <config example> <envs file> <repo>
"""
import re
import sys

FENCE = re.compile(r'^\s*(```|~~~)')
PH_HEAD = re.compile(r'^### (Placeholders|占位符)\s*$')
NAME = r'[A-Z][A-Z0-9_]{1,}'
SHELL = {'HOME', 'PWD', 'PATH', 'USER'}   # the shell's own, set for every command
# Which script hands a hook its environment, by the setting named in the section heading.
HOOK_FILE = {'PR_CREATED_HOOK': 'prompts/issue-comment.template.md',
             'CLEANUP_HOOK': 'scripts/cleanup-issue.sh',
             'LATEST_SITE_REFRESH': 'scripts/refresh-latest-site.sh',
             'POST_RETROSPECTIVE_PROJECT_CMD': 'scripts/post-merge-retrospective.py'}


def table_lines(lines):
    """The rows of the placeholder table: lines starting with | under ### Placeholders."""
    sect = None
    for line in lines:
        if line.startswith('#'):
            sect = line if line.startswith('### ') else None
        if sect and PH_HEAD.match(sect) and line.startswith('|'):
            yield line


def table(lines):
    out = set()
    for line in table_lines(lines):
        out |= set(re.findall(r'\$\{(' + NAME + r')\}', line.split('|')[1]))
    return out


def occurrences(lines):
    """(line number, ## heading, in code block, name, kind, braced) for every name."""
    out, fence, cur = [], False, None
    for i, line in enumerate(lines, 1):
        if FENCE.match(line):
            fence = not fence
            continue
        if not fence and line.startswith('## '):
            cur = line
        if fence:
            m = re.match(r'^\s*(' + NAME + r')=', line)
            if m:
                out.append((i, cur, True, m.group(1), 'set', False))
            for m in re.finditer(r'\$(\{)?(' + NAME + r')', line):
                out.append((i, cur, True, m.group(2), 'ref', bool(m.group(1))))
            continue
        for code in re.findall(r'`([^`]+)`', line):
            code = code.strip()
            m = re.match(r'^(' + NAME + r')=', code)
            if m:
                out.append((i, cur, False, m.group(1), 'set', False))
            elif re.match(r'^' + NAME + r'$', code):
                out.append((i, cur, False, code, 'mention', False))
            for m in re.finditer(r'\$(\{)?(' + NAME + r')', code):
                out.append((i, cur, False, m.group(2), 'ref', bool(m.group(1))))
    return out


def config_keys(path):
    return set(re.findall(r'^\s*#?\s*(' + NAME + r')=', open(path, encoding='utf-8').read(), re.M))


def check(doc, conf, envs, repo):
    lines = open(doc, encoding='utf-8').read().splitlines()
    keys = config_keys(conf)
    env = {}
    for line in open(envs, encoding='utf-8'):
        if line.strip():
            n, *files = line.split()
            env[n] = files
    tab = table(lines)
    owner, cur = None, None
    for line in lines:
        if line.startswith('## '):
            cur = line
        if PH_HEAD.match(line):
            owner = cur
    bad, seen = [], set()
    if not tab:
        bad.append('没找到占位符表')
    for i, sect, code, n, kind, brace in occurrences(lines):
        if n in SHELL:
            continue
        hook = next((f for k, f in HOOK_FILE.items() if sect and '`' + k + '`' in sect), None)
        text = lines[i - 1]
        if sect == owner and brace and n in tab:
            continue                                # a template placeholder where templates are composed
        if hook:
            if kind == 'set' and n in keys:
                continue                            # a config line naming the setting
            if kind == 'mention' and n in keys:
                continue                            # naming a setting in prose
            if n in env and hook in env[n]:
                seen.add(n)
                continue                            # the hook really receives it
            if n in env and kind == 'set':
                seen.add(n)
                continue                            # setting a registered variable for a command
            bad.append(f'{n}: 第 {i} 行在 {hook} 调起的挂点一节，但它不把 {n} 传给挂点')
            continue
        if n in keys:
            continue
        if brace and n in tab and re.search(r'placeholder|占位符', text):
            continue
        if n in env:
            seen.add(n)
            continue
        bad.append(f'{n}: 第 {i} 行，不是配置样例里的设置，也不是这里登记过的挂点环境变量')
    for n in sorted(seen):
        for f in env[n]:
            t = open(f'{repo}/{f}', encoding='utf-8').read()
            if not re.search(rf'(^|[^A-Z0-9_]){n}=|["\']{n}["\']|\$\{{{n}[:}}]', t):
                bad.append(f'{n}: {f} 里没有把它传给挂点脚本')
    return bad


def main(argv):
    mode, *args = argv
    if mode == 'table':
        print('\n'.join(sorted(table(open(args[0], encoding='utf-8').read().splitlines()))))
        return 0
    if mode == 'names':
        lines = open(args[0], encoding='utf-8').read().splitlines()
        print('\n'.join(sorted({o[3] for o in occurrences(lines)})))
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
