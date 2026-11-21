#!/usr/bin/env bash
# PR 正文版式的只读检查（GitHub#644）：worker 把要发出的 PR 正文写进本地文件，开 PR / 改正文之前先跑这一条。
#
# 用法：bash pr-body-lint.sh <正文文件>
#
# 只读这一个本地文件：不读 GitHub、不读项目配置、不写任何文件，也不打印正文里的文字。
# 输出：全部合格一行 `ok`；否则每个不合格项一行 `bad <码> <行号>`。码只有三种：
#   first-line         第一个块不是折叠区外的普通段落，或 daemon 列「同时在进行的工作」时从这份正文读出的摘要
#                      不是这一段第一行的那句（同一份规则：_concurrent_work_defs.sh 的 cw_first_sentence）
#   link-folded        关联行（Closes / Fixes / Resolves / Refs / Part of #N）在折叠块里
#   autopilot-summary  有托管总结段标记，但标记不成对、次序反了、不在折叠区外，或两个标记之间不是恰好三个折叠块
# 「章节都在折叠块里、折叠块成对」不查（维护者在 PR #650 选了 B：只查与 daemon 规则对得上的项，章节折叠靠
# worker 自查和复审）；「几章挤进同一个折叠块」「改写时关联行被增删」要读懂内容或对比历史，也不判。
# 块和行内的种类都由 CommonMark 解析器认：仓库里已有的 markdown-it-py（tests/lib/vendor/，随发布一起带着），
# 不另写逐行的猜测——行内代码（跨行的也算）、代码块、HTML 注释里的标签、HTML 属性值里的字都不算折叠。
# 退出码：0 = 合格；1 = 不合格；2 = 用法错误、文件读不了或解析器加载不了（不输出 ok）。
set -euo pipefail

usage() { echo "用法：bash $(basename "$0") <正文文件>" >&2; exit 2; }
[ $# -eq 1 ] || usage
f="$1"
[ -f "$f" ] && [ -r "$f" ] || { echo "读不了正文文件" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_concurrent_work_defs.sh
source "$here/_concurrent_work_defs.sh"
[ -f "$here/_autopilot_summary.sh" ] || { echo "找不到总结段截取规则（_autopilot_summary.sh）" >&2; exit 2; }
vendor="$here/../tests/lib/vendor"
[ -f "$vendor/markdown_it/__init__.py" ] || { echo "找不到 CommonMark 解析器（tests/lib/vendor/）" >&2; exit 2; }

body_summary=$(jq -Rsr "$CONCURRENT_WORK_JQ_DEFS"' cw_first_sentence' < "$f") || { echo "读不了正文文件" >&2; exit 2; }

PR_BODY_SUMMARY="$body_summary" PR_BODY_DEFS="$CONCURRENT_WORK_JQ_DEFS" PR_BODY_VENDOR="$vendor" PR_BODY_SUMMARY_LIB="$here/_autopilot_summary.sh" python3 -B - "$f" <<'PYEOF'
import os, re, subprocess, sys

# 只读：发布目录里的解析器不留字节码缓存（__pycache__），不靠调用方的环境
sys.dont_write_bytecode = True
sys.path.insert(0, os.environ["PR_BODY_VENDOR"])
try:
    from markdown_it import MarkdownIt
    from markdown_it.common.html_re import HTML_TAG_RE
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
bad = []

BEGIN = "<!-- autopilot-summary:begin -->"
END = "<!-- autopilot-summary:end -->"
LINK = re.compile(r"^\s*((close[sd]?|fix(e[sd])?|resolve[sd]?|refs?|part of)\b[^#\n]*#[0-9]+)", re.I)
TAG_NAME = re.compile(r"<(/?)([A-Za-z][A-Za-z0-9-]*)")
RAW_TEXT = ("script", "style", "textarea", "title")


# 折叠深度和「这一行的字处在第几层折叠里」都由同一个扫描器 Scan 按文档顺序算：HTML 块整段喂进去，
# 段落 / 标题里的行内 HTML 和文字按解析器给的次序逐个喂进去，扫描状态（在注释里、在原样文字元素里）
# 跨 token 保留——行内的 <textarea>、示例、</textarea> 是三个 token，中间那个照样算原样文字。
# 标签怎么算一个用解析器自己的写法（markdown_it.common.html_re.HTML_TAG_RE，行内 HTML 也是它认的）：
# 从每个 < 起整段匹配一个标签 / 注释 / 声明，属性值（引号里的也算）、注释里的字随整段跳过；
# 解析器的注释写法不收的注释（中间有 --）照浏览器到第一个 --> 为止，没关上的算到文末；
# script / style / textarea / title 里是原样文字，到它们的结尾标签为止。
# 代码块、行内代码是解析器给的别种 token，不喂标签，只占位（行首是代码的行不算关联行）。
# 正文扫描、关联行检查和托管总结段用的是同一串 token、同一个扫描器。
class Scan:
    def __init__(self):
        self.depth = 0
        self.mode = None       # None | "comment" | 原样文字元素名
        self.opens = []        # 还没关上的 <details> 所在行
        self.unbalanced = None
        self.detail_opens = [] # 每个 <details> 打开时：(行号, 打开前的深度)
        self.pieces = {}       # 行号 → [(文字, 当时的深度)]，只收看得见的文字
        self.events = []       # 每个折叠标签：(行号, 是不是结尾标签)，按出现顺序

    def depth_before(self, line):
        """第 line 行开头时的折叠深度（只算它之前各行的标签，多出来的结尾标签不往负数走）"""
        d = 0
        for ln, closing in self.events:
            if ln >= line:
                break
            d = max(d - 1, 0) if closing else d + 1
        return d

    def text(self, s, line):
        if self.mode is None and s:
            self.pieces.setdefault(line, []).append((s, self.depth))

    def _tag(self, closing, line):
        self.events.append((line, closing))
        if closing:
            self.depth -= 1
            if self.opens:
                self.opens.pop()
            if self.depth < 0 and self.unbalanced is None:
                self.unbalanced = line
                self.depth = 0
        else:
            self.detail_opens.append((line, self.depth))
            self.depth += 1
            self.opens.append(line)

    def html(self, h, line):
        """喂一段 HTML，line 是它第一个字所在的行"""
        pos = 0
        ln = lambda p: line + h.count("\n", 0, p)
        while pos < len(h):
            if self.mode == "comment":
                e = h.find("-->", pos)
                if e < 0:
                    return
                pos, self.mode = e + 3, None
                continue
            if self.mode is not None:
                e = re.compile(r"</" + self.mode + r"\s*>", re.I).search(h, pos)
                if e is None:
                    return
                pos, self.mode = e.end(), None
                continue
            lt = h.find("<", pos)
            seg = h[pos:] if lt < 0 else h[pos:lt]
            for k, part in enumerate(seg.split("\n")):
                self.text(part, ln(pos) + k)
            if lt < 0:
                return
            m = HTML_TAG_RE.match(h[lt:])
            if m is None:
                if h.startswith("<!--", lt):
                    pos, self.mode = lt + 4, "comment"
                else:
                    self.text("<", ln(lt))
                    pos = lt + 1
                continue
            t = m.group(0)
            name = TAG_NAME.match(t)
            if name:
                n = name.group(2).lower()
                if n == "details":
                    self._tag(name.group(1) == "/", ln(lt))
                elif n in RAW_TEXT and name.group(1) == "":
                    self.mode = n
            pos = lt + len(t)


def walk(text):
    """解析一份正文，按文档顺序喂给一个新的扫描器；返回 (扫描器, 第一个块)"""
    sc = Scan()
    first_block = None  # 第一个不是纯注释的块：(token, 深度)
    tokens = MarkdownIt("commonmark").parse(text)
    for i, tok in enumerate(tokens):
        line = tok.map[0] + 1 if tok.map else None
        if tok.type == "html_block":
            content = tok.content
            only_comment = re.fullmatch(r"\s*(<!--[\s\S]*?-->\s*)+", content) is not None
            if first_block is None and not only_comment:
                first_block = (tok, sc.depth)
            sc.html(content, line)
            continue
        if tok.type == "inline":
            # 行号：在这段的原文里顺着找每个换行、行内 HTML、行内代码的位置（文字不含换行，不用找）
            src, cur, base = tok.content, 0, tok.map[0] + 1
            ln = lambda p, src=src, base=base: base + src.count("\n", 0, p)
            for ch in tok.children or []:
                if ch.type in ("softbreak", "hardbreak"):
                    o = src.find("\n", cur)
                    cur = o + 1 if o >= 0 else cur
                elif ch.type == "html_inline":
                    o = src.find(ch.content, cur)
                    o = cur if o < 0 else o
                    sc.html(ch.content, ln(o))
                    cur = o + len(ch.content)
                elif ch.type == "text":
                    sc.text(ch.content, ln(cur))
                elif ch.type == "code_inline":
                    o = src.find(ch.markup, cur)
                    o = cur if o < 0 else o
                    sc.text("\x00", ln(o))
                    e = re.compile(r"(?<!`)" + re.escape(ch.markup) + r"(?!`)").search(src, o + len(ch.markup))
                    cur = e.end() if e else o + len(ch.markup)
            continue
        if tok.type.endswith("_close"):
            continue
        if first_block is None and tok.map is not None:
            first_block = (tok, sc.depth)
    return sc, first_block


sc, first_block = walk(text)

# 关联行：每一行看得见的文字从第一个非空字起拼起来，按那个字所在的折叠深度判
for ln, ps in sc.pieces.items():
    k = 0
    while k < len(ps) and not ps[k][0].strip():
        k += 1
    if k < len(ps) and ps[k][1] > 0 and LINK.match("".join(x for x, _ in ps[k:])):
        bad.append(("link-folded", ln))



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

# 托管总结段：daemon 合并后照搬的那一段，就照 daemon 的同一条规则截（_autopilot_summary.sh 的
# autopilot_summary_extract：按字面找含标记的行，不管它在注释、文本框还是代码里）。要求：含开始标记的行、
# 含结束标记的行各恰好一行，先开后关，各自整行就是标记、在折叠区外；截出来的那段单独解析，恰好三个最外层折叠块、
# 成对，折叠块外面除了空白没有别的字
mark_b = [i + 1 for i, l in enumerate(lines) if BEGIN in l]
mark_e = [i + 1 for i, l in enumerate(lines) if END in l]
if mark_b or mark_e:
    first_mark = min(mark_b + mark_e)
    ok_marks = (len(mark_b) == 1 and len(mark_e) == 1 and mark_b[0] < mark_e[0]
                and lines[mark_b[0] - 1].strip() == BEGIN and lines[mark_e[0] - 1].strip() == END
                and sc.depth_before(mark_b[0]) == 0 and sc.depth_before(mark_e[0]) == 0)
    if not ok_marks:
        bad.append(("autopilot-summary", first_mark))
    else:
        r = subprocess.run(["bash", "-c", 'source "$1" && autopilot_summary_extract', "_", os.environ["PR_BODY_SUMMARY_LIB"]],
                           input=raw, capture_output=True, text=True)
        if r.returncode != 0:
            print("总结段截取规则跑不了", file=sys.stderr)
            sys.exit(2)
        ssc, _ = walk(r.stdout)
        d, tops = 0, 0
        for _, closing in ssc.events:
            if closing:
                d -= 1
            else:
                tops += d == 0
                d += 1
        stray = any(x.strip() for ps in ssc.pieces.values() for x, dd in ps if dd == 0)
        if tops != 3 or ssc.depth != 0 or ssc.unbalanced is not None or stray:
            bad.append(("autopilot-summary", mark_b[0]))

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
