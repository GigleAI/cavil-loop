#!/usr/bin/env bash
# PR 正文版式的只读检查（GitHub#644）：worker 把要发出的 PR 正文写进本地文件，开 PR / 改正文之前先跑这一条。
#
# 用法：bash pr-body-lint.sh <正文文件>
#
# 只读这一个本地文件：不读 GitHub、不读项目配置、不写任何文件，也不打印正文里的文字。
# 输出：全部合格一行 `ok`；否则每个不合格项一行 `bad <码> <行号>`。码只有四种（都能从文字本身判定）：
#   first-line         第一行（去掉 HTML 注释后的第一个非空行）不是普通句子，或 daemon 列「同时在进行的工作」
#                      时从这份正文读出的摘要不是这一行的那句（同一份规则：_concurrent_work_defs.sh 的 cw_first_sentence）
#   link-folded        关联行（Closes / Fixes / Resolves / Refs / Part of #N）在折叠块里
#   section-outside    折叠区外有 Markdown 标题，或 <details> / </details> 不成对（报没关上的那个 <details> 所在行）
#   autopilot-summary  有托管总结段标记，但标记不成对、次序反了，或两个标记之间不是恰好三个折叠块
# 「几章挤进同一个折叠块」「改写时关联行被增删」要读懂内容或对比历史，这里不判。
# 代码块（``` / ~~~ 围起来的）里的行不参与判定。
# 退出码：0 = 合格；1 = 不合格；2 = 用法错误或文件读不了（不输出 ok）。
set -euo pipefail

usage() { echo "用法：bash $(basename "$0") <正文文件>" >&2; exit 2; }
[ $# -eq 1 ] || usage
f="$1"
[ -f "$f" ] && [ -r "$f" ] || { echo "读不了正文文件" >&2; exit 2; }

# shellcheck source=_concurrent_work_defs.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_concurrent_work_defs.sh"

body_summary=$(jq -Rsr "$CONCURRENT_WORK_JQ_DEFS"' cw_first_sentence' < "$f") || { echo "读不了正文文件" >&2; exit 2; }

PR_BODY_SUMMARY="$body_summary" PR_BODY_DEFS="$CONCURRENT_WORK_JQ_DEFS" python3 - "$f" <<'PY'
import os, re, subprocess, sys

path = sys.argv[1]
try:
    raw = open(path, encoding="utf-8").read()
except (OSError, UnicodeDecodeError):
    print("读不了正文文件", file=sys.stderr)
    sys.exit(2)

text = raw.replace("\r\n", "\n").replace("\r", "\n")
lines = text.split("\n")
bad = []

BEGIN = "<!-- autopilot-summary:begin -->"
END = "<!-- autopilot-summary:end -->"

# HTML 注释换成等长的空格（保住行号），总结段标记先记下位置
marks = []
for i, l in enumerate(lines):
    if l.strip() == BEGIN:
        marks.append(("b", i))
    elif l.strip() == END:
        marks.append(("e", i))
blank = re.sub(r"<!--[\s\S]*?-->", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
blank = re.sub(r"<!--[\s\S]*$", lambda m: re.sub(r"[^\n]", " ", m.group(0)), blank)
vis = blank.split("\n")

# 逐行：围栏代码块里的行跳过；数 <details> 深度
LINK = re.compile(r"^\s*(>\s*)*((close[sd]?|fix(e[sd])?|resolve[sd]?|refs?|part of)\b[^#\n]*#[0-9]+)", re.I)
HEAD = re.compile(r"^\s{0,3}#{1,6}(\s|$)")
OPEN = re.compile(r"<details\b", re.I)
CLOSE = re.compile(r"</details\s*>", re.I)
fence = None
depth = 0
opens = []      # 还没关上的 <details> 所在行
depth_at = []   # 每行开头时的深度（围栏内为 None）
unbalanced = None
for i, l in enumerate(vis):
    m = re.match(r"^\s{0,3}(`{3,}|~{3,})", l)
    if fence is not None:
        depth_at.append(None)
        if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
            fence = None
        continue
    if m:
        fence = m.group(1)
        depth_at.append(None)
        continue
    depth_at.append(depth)
    if depth == 0 and HEAD.match(l):
        bad.append(("section-outside", i + 1))
    if depth > 0 and LINK.match(l):
        bad.append(("link-folded", i + 1))
    for tok in re.finditer(r"</details\s*>|<details\b", l, re.I):
        if tok.group(0).lower().startswith("</"):
            depth -= 1
            if opens:
                opens.pop()
            if depth < 0 and unbalanced is None:
                unbalanced = i + 1
                depth = 0
        else:
            depth += 1
            opens.append(i + 1)
if depth != 0 and unbalanced is None:
    unbalanced = opens[0] if opens else len(lines)
if unbalanced is not None:
    bad.append(("section-outside", unbalanced))

# 第一行：去掉注释后的第一个非空行（不在代码块里）
first = None
for i, l in enumerate(vis):
    if l.strip():
        first = i
        break
def summary(s):
    r = subprocess.run(["jq", "-Rsr", os.environ["PR_BODY_DEFS"] + " cw_first_sentence"],
                       input=s, capture_output=True, text=True)
    if r.returncode != 0:
        print("摘要规则跑不了", file=sys.stderr)
        sys.exit(2)
    return r.stdout.rstrip("\n")
if first is None:
    bad.append(("first-line", 1))
else:
    l = vis[first]
    plain = not re.match(r"^\s*([#>|!<-]|[*+]\s|[0-9]+[.)]\s|`{3,}|~{3,}|\[[ xX]\])", l)
    body_sum = os.environ.get("PR_BODY_SUMMARY", "")
    line_sum = summary(l.strip() + "\n") if plain else ""
    if not plain or depth_at[first] != 0 or body_sum == "" or body_sum != line_sum:
        bad.append(("first-line", first + 1))

# 托管总结段
if marks:
    kinds = [k for k, _ in marks]
    if kinds != ["b", "e"]:
        bad.append(("autopilot-summary", marks[0][1] + 1))
    else:
        b, e = marks[0][1], marks[1][1]
        n, d, okd = 0, 0, True
        for i in range(b + 1, e):
            if depth_at[i] is None:
                continue
            for tok in re.finditer(r"</details\s*>|<details\b", vis[i], re.I):
                if tok.group(0).lower().startswith("</"):
                    d -= 1
                    if d < 0:
                        okd = False
                else:
                    if d == 0:
                        n += 1
                    d += 1
        if n != 3 or d != 0 or not okd:
            bad.append(("autopilot-summary", b + 1))

if bad:
    seen = set()
    for code, ln in bad:
        if (code, ln) in seen:
            continue
        seen.add((code, ln))
        print(f"bad {code} {ln}")
    sys.exit(1)
print("ok")
PY
