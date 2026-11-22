#!/usr/bin/env python3

# ── The round log's per-section fold titles and the client's summary of it: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# The round log's per-section fold titles and the client's summary of it (GitHub#651: `section_title`
# / `first_line` / `wall_secs_of` / `section_text` in `scripts/round_log.py`, the title kept by
# `parse_record`; `roundLogSections` / `roundLogOf` / `isRoundLog` in
# `client/src/shared/agentMetrics.ts`, `wallSecs` in `client/src/data/detail.ts`, the `rounds` /
# `latest` head in `client/src/renderer/detailHtml.ts`; the first-line rule in `prompts/round-log.md`)
# → `tests/round-log.test.sh` group 11 (~5 s of the ~1 min file; real `round-log.sh post`, footers
# from the real `comment_footer.render`) and `cd client && npx vitest run
# test/unit/round-log-summary.test.ts`. Each new section is wrapped in `<details><summary>⏱️ <time> ·
# worker|复审 · <first line></summary>` **outside** its markers, so cutting is unchanged: the read
# command, the weekly report and `pr-time-stats.py` see byte-identical sections (the test writes one
# set of deliveries with the pre-change writer, fixed commit `10622996`, and with the current one and
# compares `units`, `expand_github_comments`, the top version and the read view). The title is made
# **only** by the writer; the client reads that line and never derives a sentence itself. The sentence
# is the section's first text line after blank lines, whole-line HTML comments (the round marker),
# quote lines and rules, footer excluded — never "the first `##` heading first" (a worker's status
# line would lose to a later "## 验证结果"). A section's seconds have one valid range on both sides: a
# non-negative integer, leading zeros ignored, at most 2^53−1 (`MAX_WALL_SECS` =
# `Number.MAX_SAFE_INTEGER`); anything else, very long digit strings included, is "no record" — never
# an exception that keeps the title from being written (PR #655 review round 1). The client test feeds
# one list of values to `wall_secs_of` and `wallSecsOf`. Both sides also share one whitespace set for
# the record and the round-log markers — the six ASCII whitespace characters (`WS` in both files),
# used for every trim, the field split and the marker lines — never the language's own `strip()` /
# `trim()` / `split()` / `\s`: Python takes U+0085 for a space and JavaScript takes U+FEFF, so one
# record read a time on one side and none on the other (PR #655 review round 2); the JavaScript record
# pattern carries the `s` flag so its `.` takes the line and paragraph separators Python's `.` takes.
# The test runs twelve characters (the six, plus U+0085, U+FEFF, NBSP, U+2028, U+2029, U+001C, U+3000)
# at every position through both and requires the same verdict and title. "No record" is never 0: the
# title says 耗时未记录, the client's sum gets "≥", a sum past the safe range shows no time, and a record
# that starts with the round-log header but cannot be cut shows no time at all (its last line may be
# one section's usage record). Rendering is checked on real HTML, not on source lines: the shell test
# renders the record with the vendored markdown-it-py and walks the `<details>` tree, the client test
# puts that HTML through `buildTimeline` / `timelineDocument` and parses the result with parse5 —
# sibling section folds, none open, each with exactly its own footer inside. Sections written before
# this change keep their `### role · time` header and simply have no title
#
"""往返记录（GitHub#610）：一段 agent ↔ agent 的来回只占一条评论，每次交付在末尾追加一节。

这里是**唯一**懂记录格式的地方。写入命令（round-log.sh post）、读取（round-log.sh show 和托管条目的
受保护读取命令）、复审轮次、周报（weekly-report/collect.py）、单 PR 耗时统计（pr-time-stats.py）都调同一个
拆单元函数 `units()`，不各写一份（硬规则 L3）。

一条往返记录长这样（只由 loop 写评论的账号写、只由它改；人在交人评论里回复）：

    <!-- cavil-round-log:v1 -->
    ……一段给人看的说明……
    <!-- cavil-round-log:top sec=<节编号> -->
    ……当前完整版本（这一节交付时的完整方案 / 完整交付说明）……
    <!-- cavil-round-log:top-end -->
    <!-- cavil-round-log:sec id=<节编号> role=worker|review at=<UTC 时间> after=<追加时评论区最新评论编号> of=<所审的节|-> -->
    ……这一节：改了什么、给下一个 agent 的交代、用量 footer……
    <!-- cavil-round-log:sec-end -->
    ……更多节……

拆单元：普通评论一条一个单元；往返记录每节一个单元，位置是「紧跟在它追加时评论区最新那条之后」；
同一节编号出现多次（改写超时其实成功了、又另起了一条新记录）只留位置靠后的那份（所在评论编号更大）。
只认 `trusted(login)` 为真的账号写的记录；别的账号带同样标记的评论只当普通评论。
"""
import json
import re
import sys

# 机器记录与记录标记只认这六个空白字符（与客户端 client/src/shared/agentMetrics.ts 的 WS 同一个集合）：
# 首尾去空白、字段分隔都只用它。Python 的 strip() / split() / \s 和 JavaScript 的 trim() / \s 认的 Unicode
# 空白不一样（U+0085 Python 认、JS 不认；U+FEFF 反过来），用各自的默认规则，同一条记录两边读出的结果会不同（PR #655 复审第 2 轮）
WS = " \t\n\r\x0b\x0c"
_WS_CLASS = "[ \\t\\n\\r\\x0b\\x0c]"


def _trim(s):
    return s.strip(WS)


HEAD = "<!-- cavil-round-log:v1 -->"
TOP_END = "<!-- cavil-round-log:top-end -->"
SEC_END = "<!-- cavil-round-log:sec-end -->"
RE_TOP = re.compile(r"^<!-- cavil-round-log:top sec=([0-9a-f]{6,32}) -->$")
RE_SEC = re.compile(
    r"^<!-- cavil-round-log:sec id=([0-9a-f]{6,32}) role=(worker|review) "
    r"at=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) after=([0-9]+) of=([0-9a-f]{6,32}|-) -->$")
# 正文里出现任何一行像标记的东西都不许写进记录（会把记录切坏）
RE_ANY_MARK = re.compile("^" + _WS_CLASS + "*<!-- cavil-round-log:")
# 复审轮次标记：第一个非空行整行就是它（不是前缀匹配，正文里举的例子、半截写法都不算）
RE_ROUND = re.compile(r"^<!-- codex-review-round:([0-9]{1,4}) -->$")
MAX_CHARS = 60000


class FormatError(Exception):
    pass


class Unreadable(FormatError):
    """评论区里已有的往返记录读不懂（缺标记、版本对不上）：分不清最新交付是哪一版，什么都不写，
    照读评论失败处理——不能当成「这一条不进记录」改为单独发（PR #625 复审重派第 1 轮）。"""


class Usage(FormatError):
    """调用方少给了参数（复审没给 --of）：补齐重跑，不改成单独发。"""


class Superseded(FormatError):
    """复审所审的那一版在读取之后已经被新的交付取代：这条结论过期了，不发、不翻标签。"""


def is_record(body):
    return _trim((body or "").split("\n", 1)[0]) == HEAD


def parse_record(body):
    """→ (top, sections)。top = {sec, text} 或 None；sections = [{sec, role, at, after, of, body, idx}]。
    标记不成对、出现在不该出现的地方 → FormatError（调用方按「读不懂」处理，不猜）。"""
    lines = (body or "").replace("\r\n", "\n").split("\n")
    if not lines or _trim(lines[0]) != HEAD:
        raise FormatError("不是往返记录")
    top, secs, cur, buf, mode = None, [], None, [], None
    prev = []   # 节外最近两行：节标记前面是「折叠标题行、空行」时，记下这一节的标题（GitHub#651）
    for ln in lines[1:]:
        s = ln.rstrip(WS)
        if mode is None:
            prev = (prev + [s])[-3:]
            m = RE_TOP.match(s)
            if m:
                if top is not None:
                    raise FormatError("记录里有两个完整版本")
                mode, cur, buf = "top", {"sec": m.group(1)}, []
                continue
            m = RE_SEC.match(s)
            if m:
                mode, buf = "sec", []
                cur = {"sec": m.group(1), "role": m.group(2), "at": m.group(3), "after": int(m.group(4)),
                       "of": None if m.group(5) == "-" else m.group(5), "idx": len(secs), "title": None}
                tm = RE_TITLE_LINE.match(prev[0]) if len(prev) == 3 and prev[1] == "" else None
                if tm:
                    cur["title"] = _unesc(tm.group(1))
                continue
            if RE_ANY_MARK.match(s):
                raise FormatError("位置不对的标记：%s" % s[:60])
            continue
        if mode == "top" and s == TOP_END:
            cur["text"] = "\n".join(buf).strip("\n")
            top, mode = cur, None
            continue
        if mode == "sec" and s == SEC_END:
            cur["body"] = "\n".join(buf).strip("\n")
            secs.append(cur)
            mode = None
            continue
        if RE_ANY_MARK.match(s):
            raise FormatError("没收尾的标记：%s" % s[:60])
        buf.append(ln)
    if mode is not None:
        raise FormatError("最后一段没收尾")
    return top, secs


def _trusted(c, trusted):
    """一条评论可信与否：受保护读取已经判过的（带 trusted 字段）就用它的判断，否则按作者判。"""
    return c["trusted"] if isinstance(c.get("trusted"), bool) else trusted(c.get("author") or "")


def units(comments, trusted):
    """comments：[{id, author, at, body, url}]（任意顺序）；trusted(login) → 是否认这个账号写的记录。
    → 按位置排好的单元列表。读不懂的记录（trusted 账号写的、标记坏了）→ FormatError。"""
    out = []
    best = {}
    for c in comments:
        cid = int(c["id"])
        if is_record(c.get("body")) and _trusted(c, trusted):
            top, secs = parse_record(c["body"])
            for s in secs:
                u = {"kind": "section", "id": cid, "author": c.get("author"), "url": c.get("url", ""),
                     "sec": s["sec"], "role": s["role"], "of": s["of"], "at": s["at"], "after": s["after"],
                     "body": s["body"], "title": s.get("title"), "top": top, "key": (s["after"], 1, s["at"], cid, s["idx"])}
                prev = best.get(s["sec"])
                if prev is None or prev["id"] < cid:   # 同一节多份：留所在评论编号更大的
                    best[s["sec"]] = u
            continue
        out.append({"kind": "comment", "id": cid, "author": c.get("author"), "url": c.get("url", ""),
                    "at": c.get("at", ""), "body": c.get("body") or "", "key": (cid, 0, "", 0, 0),
                    "_trusted": _trusted(c, trusted)})
    out.extend(best.values())
    out.sort(key=lambda u: u["key"])
    return out


def version_of(unit, all_units):
    """一节对应的完整版本：worker 节 = 它自己交付的版本；复审节 = 它所审的那一节的版本。
    取的是保留下来那份所在记录的顶部，顶部的节编号必须对得上，对不上 → None（不拿旧版本充数）。"""
    if unit["kind"] != "section":
        return None
    want = unit["sec"] if unit["role"] == "worker" else unit["of"]
    if not want:
        return None
    top = unit.get("top")
    if top and top.get("sec") == want:
        return top.get("text")
    # 复审节在一条新开的记录里、所审那一节在旧记录：新开时顶部已经抄了所审版本，上面就对上了；
    # 对不上时再看所审那一节本身保留下来的那份
    for u in all_units:
        if u["kind"] == "section" and u["sec"] == want and u.get("top") and u["top"].get("sec") == want:
            return u["top"].get("text")
    return None


def round_mark(body):
    """第一个非空行整行是轮次标记 → 轮次号；否则 None。"""
    for ln in (body or "").split("\n"):
        if ln.strip():
            m = RE_ROUND.match(ln.strip())
            return m.group(1) if m else None
    return None


def desc(u):
    if u["kind"] == "comment":
        return "评论 #%s（@%s，%s）%s" % (u["id"], u["author"], u["at"], (" " + u["url"]) if u["url"] else "")
    who = "worker agent 交付" if u["role"] == "worker" else "复审"
    return "往返记录里的一节（%s，节 %s，%s，所在评论 %s）" % (who, u["sec"], u["at"], u["url"] or u["id"])


def render(us, show_all):
    """给 agent 看的文字。→ (文字, 退出码)；退出码 4 = 最新一节的完整版本对不上（不给任何当前版本）。"""
    lines = ["<!-- 下面是 cavil-loop 往返记录视图（GitHub#610）：评论按「单元」排好，最新的在最后 -->"]
    if not us:
        # 一条评论都没有：交付就是正文本身（首次开 PR 时交付说明写在 PR 正文里）
        lines += ["（还没有任何评论：这一轮的交付就是正文本身）", "",
                  "（复审对这次交付发结论时，写入命令带上 `--of body`）"]
        return "\n".join(lines) + "\n", 0
    if show_all:
        for i, u in enumerate(us, 1):
            lines += ["", "### 单元 %d / %d：%s" % (i, len(us), desc(u)), "", u["body"]]
        lines.append("")
    last = us[-1]
    lines += ["", "## 最新单元：%s" % desc(last), ""]
    # 复审发结论时要原样带上这个值（--of）：写入命令据它判断这期间有没有新的交付
    rev = None
    for u in reversed(us):
        if u["kind"] == "section" and u["role"] == "worker":
            rev = u["sec"]
            break
        if u["kind"] == "comment" and u.get("_trusted"):
            rev = "comment-%s" % u["id"]
            break
    # 线程里还没有任何交付（agent 的评论或记录里的一节）：所审的交付是正文本身
    lines += ["（复审对这次交付发结论时，写入命令带上 `--of %s`）" % (rev or "body"), ""]
    lines.append(last["body"])
    if last["kind"] == "section":
        v = version_of(last, us)
        if v is None:
            return ("❌ 版本对不上：最新一节（节 %s）对应的完整版本在记录里找不到。没有输出任何当前版本。"
                    "照读评论失败的规则处理。\n" % last["sec"]), 4
        lines += ["", "## 最新单元对应的完整版本", "", v]
    # 复审轮次的材料：只列事实，不替复审算当前轮次——重置点还要看评论的编辑和标签事件，这些不在评论视图里
    # （PR #625 复审第 5 轮）。算作一轮复审的只有两种：往返记录里的复审节、loop 账号写的单独评论，且第一个
    # 非空行整行是轮次标记；别人写的评论一律只当「不是 loop 账号写的评论」列出（可能是重置点），
    # loop 账号的其它评论不列（复审第 6 轮）
    lines += ["", "## 复审轮次的材料（全部历史，不是当前轮次）", ""]
    n_marked = 0
    for u in us:
        if u["kind"] == "comment" and not u.get("_trusted"):
            lines.append("- %s　@%s 的评论 #%s（不是 loop 账号写的）" % (u["at"], u["author"], u["id"]))
            continue
        if u["kind"] == "section" and u["role"] != "review":
            continue
        n = round_mark(u["body"])
        if n is None:
            continue
        n_marked += 1
        where = ("往返记录里的复审节 %s" % u["sec"]) if u["kind"] == "section" else ("单独评论 #%s" % u["id"])
        lines.append("- %s　复审轮次标记 %s（%s，@%s）" % (u["at"], n, where, u["author"]))
    lines += ["", "（共 %d 个单元，其中带复审轮次标记的 %d 个，是全部历史；同一节在评论区出现多次的只算一次。"
              "当前轮次照上文规则：先定最近一次人工动作——上面只列了评论，评论的编辑、只改标签这类动作要照上文"
              "分页读评论编辑信息和 issue events 另外确定——只数它之后的带标记单元）" % (len(us), n_marked)]
    return "\n".join(lines) + "\n", 0


# ── 写入：算出这次要整段写回的正文（或新开记录的正文）──────────────────────────────

def check_body(text, what):
    for ln in (text or "").split("\n"):
        if RE_ANY_MARK.match(ln):
            raise FormatError("%s里有一行像往返记录的标记，不能写进记录" % what)
        if "<!-- autopilot-review-pass" in ln:
            raise FormatError("%s里带着托管合并用的测试记录标记，这类结论必须单独发" % what)


INTRO = ("**agent 往返记录**：一段 agent 之间的来回（交方案 / 交 PR → 复审 → 修订 → ……）都追加在这一条里，"
         "交给人的评论另外单独发。本条只由 agent 写，请不要编辑；要回复或拍板请在交人评论里。")


# ── 每一节的折叠标题（GitHub#651）──────────────────────────────────────────────
# 每节包在一个 <details> 里，标题 = 「⏱️ <这一节的耗时> · <worker|复审> · <状态 emoji + 一句话>」。
# 折叠块在节标记外面：切节只认标记，标题和 <details> 行不进节正文，周报、单 PR 统计、读取命令看到的
# 每节内容与没有标题时完全一样。标题只在这里生成；客户端读这一行，不另写取句规则。

RE_METRICS = re.compile("^<!--" + _WS_CLASS + "*agent-metrics" + _WS_CLASS + "+(.*?)-->$")
RE_FOOTER_START = re.compile(r"^<details><summary>⏱️ 耗时：")
RE_HTML_COMMENT_LINE = re.compile(r"^<!--.*-->$")
RE_HR = re.compile(r"^(?:-{3,}|\*{3,}|_{3,})$")
TITLE_MAX = 80
MAX_WALL_SECS = 2 ** 53 - 1   # = Number.MAX_SAFE_INTEGER，客户端 wallSecsOf 的上限
ROLE_WORD = {"worker": "worker", "review": "复审"}


def wall_secs_of(body):
    """节正文最后一个非空行的用量记录里的 wall_secs；没有记录、字段缺或给了两次、不是整数 → None。
    和客户端（client/src/shared/agentMetrics.ts wallSecsOf）、周报的读法同一条规则，测试对拍。"""
    last = ""
    for ln in reversed((body or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")):
        if _trim(ln):
            last = _trim(ln)
            break
    m = RE_METRICS.fullmatch(last)
    if not m:
        return None
    vals = [t[len("wall_secs="):] for t in re.split(_WS_CLASS + "+", m.group(1)) if t.startswith("wall_secs=")]
    # 有效范围与客户端相同：非负整数、不超过 2^53−1（JavaScript 能精确表示的最大整数）；越界、超长都算没有记录。
    # 先限位数再转整数：超长数字串直接 int() 会抛 ValueError（Python 的整数转换位数上限），交付就写不出标题
    if len(vals) != 1 or not re.fullmatch(r"[0-9]+", vals[0]):
        return None
    digits = vals[0].lstrip("0") or "0"   # 前导零不算位数（客户端 Number("007") 也是 7）
    if len(digits) > 16:
        return None
    n = int(digits)
    return n if n <= MAX_WALL_SECS else None


def fmt_dur(secs):
    """用量 footer 的写法（comment_footer.py fmt_dur）：1h 3m 15s / 42m 7s / 9s。"""
    secs = max(0, int(secs))
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    if h:
        return "%dh %dm %ds" % (h, m, s)
    if m:
        return "%dm %ds" % (m, s)
    return "%ds" % s


def _plain(s):
    s = re.sub(r"^#{1,6}\s+", "", s)
    s = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = s.replace("**", "").replace("__", "").replace("~~", "").replace("`", "")
    return re.sub(r"\s+", " ", s).strip()


def first_line(body):
    """一句话 = 节正文第一行文字：跳过空行、整行 HTML 注释（轮次标记等）、引用行、分隔线；用量 footer 不参与。
    复审节第一行就是 `## ✅/❌ 结论标题`，worker 节第一行是 worker 写的状态句——两种角色同一条规则，
    后面正文里的小标题不会顶替它。去掉 markdown 记号，截到 TITLE_MAX 字。取不到 → ""。"""
    for ln in (body or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        s = ln.strip()
        if RE_FOOTER_START.match(s):
            break
        if not s or RE_HTML_COMMENT_LINE.match(s) or s.startswith(">") or RE_HR.match(s):
            continue
        s = _plain(s)
        if not s:
            continue
        return s if len(s) <= TITLE_MAX else s[:TITLE_MAX] + "…"
    return ""


def _starts_with_symbol(s):
    import unicodedata
    return bool(s) and unicodedata.category(s[0]) == "So"


def section_title(role, body):
    """折叠标题的文字（未转义）：⏱️ <耗时 | 耗时未记录> · <角色> · <状态 + 一句话>。"""
    w = wall_secs_of(body)
    line = first_line(body) or "（这一节没有文字）"
    if not _starts_with_symbol(line):
        line = "📝 " + line
    return "⏱️ %s · %s · %s" % (fmt_dur(w) if w is not None else "耗时未记录", ROLE_WORD[role], line)


def _esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _unesc(s):
    return s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


RE_TITLE_LINE = re.compile(r"^<details><summary>(⏱️ .*)</summary>$")


def section_text(sec, role, at, after, of, body):
    head = "<details><summary>%s</summary>" % _esc(section_title(role, body))
    return "\n".join([head, "", "<!-- cavil-round-log:sec id=%s role=%s at=%s after=%d of=%s -->" % (sec, role, at, after, of or "-"),
                      body.strip("\n"), SEC_END, "", "</details>"])


def top_text(sec, text):
    return "\n".join(["<details><summary>当前完整版本</summary>", "", "<!-- cavil-round-log:top sec=%s -->" % sec,
                      text.strip("\n"), TOP_END, "", "</details>"])


def new_record(top_sec, top_body, secs_text):
    parts = [HEAD, INTRO, ""]
    if top_sec:
        parts += [top_text(top_sec, top_body), ""]
    parts.append(secs_text)
    return "\n".join(parts) + "\n"


def plan(inp):
    """inp：{comments, trusted_login, role, body, full, of, sec, at, max}
    → {mode: append|new, comment_id, append_body, new_body, of}。
    append_body = 追加到现有记录时整段写回的正文（mode=append 才有）；new_body = 新开 / 另起一条时的正文
    （两种情况都给：改写失败时另起用的就是它，内容与新开完全相同）。"""
    trusted = trusted_by(inp.get("trusted_login"))
    role, body, full = inp["role"], inp.get("body") or "", inp.get("full")
    check_body(body, "本节正文")
    if full is not None:
        check_body(full, "完整版本")
    if role == "worker" and not (full or "").strip():
        raise FormatError("worker 交付要给完整版本")
    if not body.strip():
        raise FormatError("本节正文是空的")
    comments = sorted(inp["comments"], key=lambda c: int(c["id"]))
    try:
        us = units(comments, trusted)
    except FormatError as e:
        raise Unreadable("评论区里的往返记录读不懂：%s" % e)
    latest_id = int(comments[-1]["id"]) if comments else 0
    of = inp.get("of") or None
    if role == "review":
        # 复审依据的交付由调用方给（--of = 读取时最新单元标出的那个值）：读取之后线程可能又多了新的交付，
        # 写入时不能按当时的线程重新挑一版。结果只有三种：
        #   ① 所审的就是记录里最新的那一节 worker 交付 → 照常写（of = 它）
        #   ② 所审的是一条单独的评论（开关打开前的旧式交付等）或正文本身（--of body：线程里还没有任何交付，
        #      如首次开 PR 时交付说明只写在 PR 正文里），且它仍是最新交付 → 拒收，照现在单独发
        #   ③ 所审的那一版之后又有了交付（新的一节，或 loop 账号又单独发了评论），或者它已经找不到 → 过期，不发
        if not of:
            raise Usage("复审要给 --of（读取时最新单元标出的值）")
        latest = None
        for u in reversed(us):
            if (u["kind"] == "section" and u["role"] == "worker") or (u["kind"] == "comment" and u.get("_trusted")):
                latest = u
                break
        # 还没有任何交付（只有正文，如首次开 PR 时交付说明写在 PR 正文里）= 所审的是正文：记作 body
        latest_key = "body" if latest is None else (latest["sec"] if latest["kind"] == "section" else "comment-%s" % latest["id"])
        if latest_key != of:
            raise Superseded("所审的那一版（%s）读取之后已经不是最新的交付（现在是 %s），这条复审结论过期了" % (of, latest_key or "无"))
        if latest is None:
            raise FormatError("所审的交付是正文本身、不在往返记录里，这一条复审结论照现在单独发")
        if latest["kind"] == "comment":
            raise FormatError("所审的交付是一条单独的评论、不在往返记录里，这一条复审结论照现在单独发")
    sec, at = inp["sec"], inp["at"]
    # 新开记录时顶部放的版本：worker = 本次完整版本；复审 = 所审那一节的完整版本（取不到就不放，读的时候报对不上）
    if role == "worker":
        top_sec, top_body = sec, full
    else:
        top_sec, top_body = of, None
        if of:
            for u in us:
                if u["kind"] == "section" and u["sec"] == of:
                    top_body = version_of(u, us)
        if top_body is None:
            # 走到这里，所审的一定是记录里最新的那一节（单独评论、正文在上面已经拒收）：它的完整版本取不到 =
            # 记录读不懂（读取命令此时报「版本对不上」），同样什么都不写、照读评论失败处理
            raise Unreadable("所审那一节（%s）的完整版本在记录里找不到" % of)
    out = {"mode": "new", "comment_id": None, "of": of, "sec": sec}
    cap = int(inp.get("max") or MAX_CHARS)
    nb = new_record(top_sec, top_body or "", section_text(sec, role, at, latest_id, of, body))
    if len(nb) > cap:
        raise FormatError("这一节加上完整版本超过 %d 字，放不进一条评论" % cap)
    out["new_body"] = nb
    # 能追加：评论区最新一条就是可信账号写的往返记录（中途有任何新评论 → 来回被打断，另起一条）
    if comments and is_record(comments[-1].get("body")) and _trusted(comments[-1], trusted):
        cur = comments[-1]
        top, _ = parse_record(cur["body"])
        text = cur["body"].replace("\r\n", "\n").rstrip("\n")
        if role == "worker":
            new_top = top_text(sec, full)
            if top is None:
                # 记录里还没有完整版本（复审开的记录、所审版本取不到）：放在说明之后
                first, rest = text.split("\n", 1) if "\n" in text else (text, "")
                text = "\n".join([first, new_top, rest])
            else:
                text = _replace_top(text, new_top)
        text = text + "\n\n" + section_text(sec, role, at, latest_id, of, body) + "\n"
        if len(text) <= cap:
            parse_record(text)   # 写回前自己再读一遍，读不懂就不写
            out.update(mode="append", comment_id=int(cur["id"]), append_body=text)
    return out


def _replace_top(text, new_top):
    lines = text.split("\n")
    s = next(i for i, ln in enumerate(lines) if RE_TOP.match(ln.rstrip(WS)))
    e = next(i for i in range(s, len(lines)) if lines[i].rstrip(WS) == TOP_END)
    # 连同包着它的 <details> 一起换掉（我们自己写的固定样子）
    if s >= 2 and lines[s - 2].startswith("<details><summary>当前完整版本") and lines[s - 1] == "":
        s -= 2
        if e + 2 < len(lines) and lines[e + 1] == "" and lines[e + 2] == "</details>":
            e += 2
    return "\n".join(lines[:s] + [new_top] + lines[e + 1:])


# ── 统计用：把评论展开成「一个单元一条」的评论（周报、单 PR 统计）──────────────────

def loop_login():
    """loop 写评论的账号（统计入口用）：和写入命令里的 write_identity_login 同一个来源——有 WRITE_GH_TOKEN
    就用它问 `gh api user`，没有就用 gh 自己的登录。问不到 → FormatError（调用方报错退出，不猜、不退回按名字认）。"""
    import os
    import subprocess
    env = dict(os.environ)
    if env.get("WRITE_GH_TOKEN"):
        env["GH_TOKEN"] = env["WRITE_GH_TOKEN"]
    try:
        p = subprocess.run(["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True, timeout=60, env=env)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise FormatError("问不到 loop 写评论账号：%s" % e)
    login = p.stdout.strip()
    if p.returncode != 0 or not login or "\n" in login:
        raise FormatError("问不到 loop 写评论账号（gh api user 退出码 %d）" % p.returncode)
    return login


def trusted_by(login):
    """「这条记录可信」只有一种判法：作者就是 loop 写评论的账号（不区分大小写）。写入、读取、统计都用它。"""
    want = (login or "").lower()
    return lambda a: bool(want) and (a or "").lower() == want


def expand_github_comments(comments, trusted):
    """GitHub 评论原样（user.login / created_at / body / id / issue_url / html_url）→ 同样形状的列表，
    往返记录换成它的各节：id 写成 "<评论编号>:<节编号>"、created_at 换成这一节的追加时间。
    可信账号写的记录读不懂 → FormatError（调用方报错退出：不退回按整条评论算，也不丢掉别的节）。"""
    norm = []
    raw_by_id = {}
    for c in comments:
        raw_by_id[int(c["id"])] = c
        norm.append({"id": c["id"], "author": (c.get("user") or {}).get("login", ""), "at": c.get("created_at", ""),
                     "body": c.get("body") or "", "url": c.get("html_url", "")})
    us = units(norm, trusted)
    out = []
    for u in us:
        raw = raw_by_id[u["id"]]
        if u["kind"] == "comment":
            out.append(raw)
            continue
        d = dict(raw)
        d["id"] = "%s:%s" % (u["id"], u["sec"])
        d["created_at"] = u["at"]
        d["updated_at"] = u["at"]
        d["body"] = u["body"]
        out.append(d)
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "is-record":
        # 标准输入是一条评论正文：是往返记录 → 0，不是 → 1（复审算修复范围的命令用，GitHub#676）
        return 0 if is_record(sys.stdin.read()) else 1
    try:
        inp = json.load(sys.stdin)
        if cmd == "expand":
            # {comments: GitHub 评论原样的列表, trusted_login} → 同样形状、往返记录换成各节、按位置排好的列表
            # （复审算修复范围的命令用它找上一轮的复审结论，GitHub#676）；读不懂的记录 → 退出码 3
            json.dump(expand_github_comments(inp["comments"], trusted_by(inp.get("trusted_login"))),
                      sys.stdout, ensure_ascii=False)
            return 0
        if cmd == "show":
            us = units(inp["comments"], trusted_by(inp.get("trusted_login")))
            text, rc = render(us, bool(inp.get("all")))
            sys.stdout.write(text)
            return rc
        if cmd == "plan":
            json.dump(plan(inp), sys.stdout, ensure_ascii=False)
            return 0
    except Superseded as e:
        sys.stdout.write("❌ %s\n" % e)
        return 4 if cmd == "show" else 7
    except Unreadable as e:
        sys.stdout.write("❌ %s\n" % e)
        return 4 if cmd == "show" else 6
    except Usage as e:
        sys.stdout.write("❌ %s\n" % e)
        return 4 if cmd == "show" else 8
    except FormatError as e:
        sys.stdout.write("❌ %s\n" % e)
        return 4 if cmd == "show" else 3
    except (ValueError, KeyError, TypeError) as e:
        sys.stdout.write("❌ 输入读不懂：%s\n" % e)
        return 5
    sys.stderr.write("用法: round_log.py show|plan|expand < 输入 JSON；round_log.py is-record < 评论正文\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
