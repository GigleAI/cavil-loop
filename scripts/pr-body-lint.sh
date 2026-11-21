#!/usr/bin/env bash
# PR 正文版式的只读检查（GitHub#644）：worker 把要发出的 PR 正文写进本地文件，开 PR / 改正文之前先跑这一条。
#
# 用法：bash pr-body-lint.sh <正文文件>
#
# 只读这一个本地文件：不读 GitHub、不读项目配置、不写任何文件，也不打印正文里的文字。
# 输出：全部合格一行 `ok`；否则每个不合格项一行 `bad <码> <行号>`。码只有四种（都能从文字本身判定）：
#   first-line         第一个块不是折叠区外的普通段落，或 daemon 列「同时在进行的工作」时从这份正文读出的摘要
#                      不是这一段第一行的那句（同一份规则：_concurrent_work_defs.sh 的 cw_first_sentence）
#   link-folded        关联行（Closes / Fixes / Resolves / Refs / Part of #N）在折叠块里
#   section-outside    折叠区外有 Markdown 标题（井号式、下划线式都算），或 <details> / </details> 不成对
#                      （报没关上的那个 <details> 所在行）
#   autopilot-summary  有托管总结段标记，但标记不成对、次序反了、不在折叠区外，或两个标记之间不是恰好三个折叠块
# 「几章挤进同一个折叠块」「改写时关联行被增删」要读懂内容或对比历史，这里不判。
# 块和行内的种类（标题、段落、代码、HTML、分隔线、列表）都由 CommonMark 解析器认：仓库里已有的 markdown-it-py
# （tests/lib/vendor/，随发布一起带着），不另写逐行的猜测——行内代码（跨行的也算）、代码块、HTML 注释里的
# 标签都不算折叠，加粗、链接等写法的下划线式标题照样是标题。PR #650 复审两轮各找出逐行猜测漏掉的写法。
# 退出码：0 = 合格；1 = 不合格；2 = 用法错误、文件读不了或解析器加载不了（不输出 ok）。
set -euo pipefail

usage() { echo "用法：bash $(basename "$0") <正文文件>" >&2; exit 2; }
[ $# -eq 1 ] || usage
f="$1"
[ -f "$f" ] && [ -r "$f" ] || { echo "读不了正文文件" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_concurrent_work_defs.sh
source "$here/_concurrent_work_defs.sh"
vendor="$here/../tests/lib/vendor"
[ -f "$vendor/markdown_it/__init__.py" ] || { echo "找不到 CommonMark 解析器（tests/lib/vendor/）" >&2; exit 2; }

body_summary=$(jq -Rsr "$CONCURRENT_WORK_JQ_DEFS"' cw_first_sentence' < "$f") || { echo "读不了正文文件" >&2; exit 2; }

PR_BODY_SUMMARY="$body_summary" PR_BODY_DEFS="$CONCURRENT_WORK_JQ_DEFS" PR_BODY_VENDOR="$vendor" python3 - "$f" <<'PYEOF'
import os, re, subprocess, sys

sys.path.insert(0, os.environ["PR_BODY_VENDOR"])
try:
    from markdown_it import MarkdownIt
except Exception:
    print("CommonMark 解析器加载不了", file=sys.stderr)
    sys.exit(2)

path = sys.argv[1]
try:
    raw = open(path, encoding="utf-8").read()
except (OSError, UnicodeDecodeError):
    print("读不了正文文件", file=sys.stderr)
    sys.exit(2)

text = raw.replace("\r\n", "\n").replace("\r", "\n")
lines = text.split("\n")
tokens = MarkdownIt("commonmark").parse(text)
bad = []

BEGIN = "<!-- autopilot-summary:begin -->"
END = "<!-- autopilot-summary:end -->"
LINK = re.compile(r"^\s*((close[sd]?|fix(e[sd])?|resolve[sd]?|refs?|part of)\b[^#\n]*#[0-9]+)", re.I)
TAG = re.compile(r"</details\s*>|<details\b", re.I)


def tags(html):
    """一段 HTML（HTML 块或行内 HTML）里真正的折叠标签，按出现顺序：(是不是结尾标签, 在这段里的第几行)。
    注释里的不算（换成等长空白，行号不变）"""
    html = re.sub(r"<!--[\s\S]*?(-->|$)", lambda m: re.sub(r"[^\n]", " ", m.group(0)), html)
    return [(m.group(0).startswith("</"), html.count("\n", 0, m.start())) for m in TAG.finditer(html)]


# 折叠深度只由 HTML 块和行内 HTML 改变：代码块、行内代码是解析器给的别种 token，碰不到这里。
# 正文扫描和托管总结段用的是同一串 token、同一个 tags()。
depth = 0
opens = []          # 还没关上的 <details> 所在行
unbalanced = None
marks = []          # (b|e, 行号, 当时的深度)
detail_opens = []   # 每个 <details> 打开时：(行号, 打开前的深度)
first_block = None  # 第一个不是纯注释的块：(token, 深度)


def step(closing, line):
    global depth, unbalanced
    if closing:
        depth -= 1
        if opens:
            opens.pop()
        if depth < 0 and unbalanced is None:
            unbalanced = line
            depth = 0
    else:
        detail_opens.append((line, depth))
        depth += 1
        opens.append(line)


for i, tok in enumerate(tokens):
    line = tok.map[0] + 1 if tok.map else None
    if tok.type == "html_block":
        content = tok.content
        only_comment = re.fullmatch(r"\s*(<!--[\s\S]*?-->\s*)+", content) is not None
        if first_block is None and not only_comment:
            first_block = (tok, depth)
        # 这个块里的标记和标签按出现的先后一起处理：标记记下的是它那一刻的深度
        events = [(off, 1, closing) for closing, off in tags(content)]
        for off, l in enumerate(content.split("\n")):
            if l.strip() in (BEGIN, END):
                events.append((off, 0 if l.strip() == BEGIN else 2, l.strip()))
        for off, kind, v in sorted(events, key=lambda x: (x[0], x[1])):
            if kind == 1:
                step(v, line + off)
            else:
                marks.append(("b" if v == BEGIN else "e", line + off, depth))
        continue
    if tok.type.endswith("_close") or tok.type == "inline":
        if tok.type == "inline" and tokens[i - 1].type == "paragraph_open":
            base = tokens[i - 1].map[0] + 1
            if depth > 0:
                for off, l in enumerate(tok.content.split("\n")):
                    if LINK.match(l):
                        bad.append(("link-folded", base + off))
            for ch in tok.children or []:
                if ch.type == "html_inline":
                    for closing, _ in tags(ch.content):
                        step(closing, base)
        continue
    if first_block is None and tok.map is not None:
        first_block = (tok, depth)
    if tok.type == "heading_open" and depth == 0:
        bad.append(("section-outside", line))

if depth != 0 and unbalanced is None:
    unbalanced = opens[0] if opens else len(lines)
if unbalanced is not None:
    bad.append(("section-outside", unbalanced))


def summary(s):
    r = subprocess.run(["jq", "-Rsr", os.environ["PR_BODY_DEFS"] + " cw_first_sentence"],
                       input=s, capture_output=True, text=True)
    if r.returncode != 0:
        print("摘要规则跑不了", file=sys.stderr)
        sys.exit(2)
    return r.stdout.rstrip("\n")


# 第一行：第一个块必须是折叠区外的普通段落，而且摘要规则从整份正文读出的正是它第一行那句
if first_block is None:
    bad.append(("first-line", 1))
else:
    tok, d = first_block
    ok_first = tok.type == "paragraph_open" and tok.level == 0 and d == 0
    if ok_first:
        body_sum = os.environ.get("PR_BODY_SUMMARY", "")
        ok_first = body_sum != "" and body_sum == summary(lines[tok.map[0]].strip() + "\n")
    if not ok_first:
        bad.append(("first-line", tok.map[0] + 1))

# 托管总结段：恰好一对标记、先开后关、都在折叠区外，中间恰好三个最外层折叠块
if marks:
    if [k for k, _, _ in marks] != ["b", "e"] or marks[0][2] != 0 or marks[1][2] != 0:
        bad.append(("autopilot-summary", marks[0][1]))
    else:
        b, e = marks[0][1], marks[1][1]
        if sum(1 for ln, d in detail_opens if b < ln < e and d == 0) != 3:
            bad.append(("autopilot-summary", b))

if bad:
    seen = set()
    for code, ln in sorted(bad, key=lambda x: x[1]):
        if (code, ln) in seen:
            continue
        seen.add((code, ln))
        print(f"bad {code} {ln}")
    sys.exit(1)
print("ok")
PYEOF
