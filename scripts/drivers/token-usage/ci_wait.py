#!/usr/bin/env python3
"""一次派工里 agent「在等远端 CI」的时间（GitHub#293）：认出等待命令，按会话记录定起止，扣掉 AI 时间。

用法: python3 ci_wait.py <claude|codex> <start_epoch> <end_epoch|now> <会话文件...>
输出: 一行 JSON（footer 据此排总览、细节和机器记录）：

    {"v": 1, "read": true, "secs": 6630.245, "untimed": 0, "overlap": false, "ai_cut": 0, "unparsed": 0,
     "waits": [{"what": "run", "id": "42565983194", "start": 1762665190.056, "end": 1762671820.301,
                "secs": 6630.245}]}

  · waits     每条等待：what = run（Actions 运行）/ pr（PR 的检查）/ 空；id = 命令里读得出的编号，读不出为空；
              start / end 为秒级时间戳（毫秒精度），end 与这一条的 secs 在没记到结束时为 null。
              这一条的 secs 是它自己的长度（裁到 [本轮开始, 现在]），不扣 AI——人拿去和 Actions 页面对
  · secs      汇总：已计时等待时段的并集，再减去与 AI 请求时段重合的部分；没有等待为 0，
              有等待但一条都没计上时间为 null
  · untimed   没记到结束的条数；overlap = 几条等待时间上有重叠；ai_cut = 从并集里扣掉的 AI 秒数
  · unparsed  codex 里写法解析不了的命令条数（可能含等待，没算进来）
  · 会话记录读不了：{"v": 1, "read": false, "why": "<原因>"}

由用量驱动（claude.sh / codex.sh）的 --ci-wait 模式调用，文件清单就是驱动读 token 的那一批，
所以和 AI 时间、token 是同一批会话、同一个时间窗。

哪些命令算「在等远端 CI」（Claude 的 Bash / Monitor 调用，codex 的 exec 命令）：
  1. 本身阻塞到运行结束：`gh run watch …`、`gh pr checks … --watch`
  2. 一个 for / while / until 循环，里面同时有 sleep 和远端 CI 状态查询：`gh run view` / `gh run list` /
     `gh pr checks`，或 `gh api` 访问 …/actions/runs…、…/check-runs、…/check-suites、…/commits/<sha>/status
  只认处在命令位置、真正会执行的 gh 调用（按 shell 规则拆：单引号里是文字，双引号和不带引号处的
  `$( … )` / 反引号会执行、递归拆开；`echo gh run watch 1` 里的只是参数）。循环那一条要求 sleep 和
  查询都在循环体（含条件）里。不算：单次查询、`gh workflow run`、轮询 PR 评论 / 标签、打印出来的文字。
  编号只从认定为等待的那条命令里取（阻塞命令优先），命令里用变量时找同一条命令里的数字赋值。
  heredoc 内容先去掉（用测试统计 test_time.py 的那一份），那是数据不是命令。
  已知限制：把等待包进脚本文件、或 `bash -c '…'` 包一层，认不出来。

起止：开始 = 工具调用写进会话的时刻（codex：单元时刻 + 前面各条耗时）；结束 = 前台命令的工具结果时刻 /
后台命令和 Monitor 的「后台任务结束」通知时刻 / codex 命令自报的耗时或报出退出码那次轮询的结束。
都取自 test_time.py 的会话读取函数，测试统计和这里读的是同一份「命令 + 它的结束证据」。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ai_time      # noqa: E402
import test_time    # noqa: E402

VALUE_FLAGS = {"-i", "--interval", "--attempt", "-R", "--repo", "--json", "--jq", "-q", "-t", "--template",
               "-j", "--job", "-w", "--workflow", "-b", "--branch", "-L", "--limit", "-u", "--user", "-e", "--event",
               "-s", "--status", "-c", "--commit"}


# ── 认命令：按 shell 的执行位置拆出「真正会执行的简单命令」（GitHub#293 代码复审第 1 轮）────────────
# 只认真正处在命令位置的 gh 调用：`echo gh run watch 1`、`printf '%s' '$(gh run watch 1)'`、
# `echo "gh run view 1"` 里的都只是参数或文字。单引号里一律是文字；双引号和不带引号处的 `$( … )` /
# 反引号是会执行的命令替换，递归拆开。每条简单命令带一个「是否在 for / while / until 循环里」的标记。
# 判等待和取编号都只看这一份拆分结果（analyze），不再各自扫原文。

LOOP_KW = {"for", "while", "until", "select"}
PREFIX_KW = {"do", "then", "else", "elif", "if", "!", "{", "}", "time", "fi", "esac", "in"}
WRAPPERS = {"env", "nohup", "command", "exec", "nice", "time", "builtin", "xargs"}
ASSIGN = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', re.S)
SUB_MARK = "\x00"      # 词里命令替换所在的位置（替换本身另行拆开）


def _balanced(s, i, open_ch="(", close_ch=")"):
    """s[i] 紧跟在开括号之后：返回 (里面的文字, 配对的闭括号之后的位置)；引号里的括号不算。"""
    depth, j, n = 1, i, len(s)
    while j < n:
        c = s[j]
        if c == "\\":
            j += 2
            continue
        if c == "'":
            k = s.find("'", j + 1)
            j = n if k < 0 else k + 1
            continue
        if c == '"':
            k = j + 1
            while k < n and s[k] != '"':
                k += 2 if s[k] == "\\" else 1
            j = k + 1
            continue
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return s[i:j], j + 1
        j += 1
    return s[i:], n


def _backtick(s, i):
    j, n = i, len(s)
    while j < n and s[j] != "`":
        j += 2 if s[j] == "\\" else 1
    return s[i:j], min(j + 1, n)


def _tokenize(s):
    """→ [(词列表, [替换里的文字...])...]，每项一条简单命令；分隔符 ; & | && || 换行 ( ) 都切开。"""
    cmds, words, subs = [], [], []
    cur, has_cur, skip_next = [], False, False
    i, n = 0, len(s)

    def end_word():
        nonlocal cur, has_cur, skip_next
        if has_cur:
            w = "".join(cur)
            if skip_next:
                skip_next = False
            else:
                words.append(w)
        cur, has_cur = [], False

    def end_cmd():
        nonlocal words, subs
        end_word()
        if words or subs:
            cmds.append((words, subs))
        words, subs = [], []

    while i < n:
        c = s[i]
        if c == "\\":
            if i + 1 < n and s[i + 1] != "\n":
                cur.append(s[i + 1]); has_cur = True
            i += 2
        elif c == "'":
            k = s.find("'", i + 1)
            k = n if k < 0 else k
            cur.append(s[i + 1:k]); has_cur = True
            i = k + 1
        elif c == '"':
            has_cur = True
            j = i + 1
            while j < n and s[j] != '"':
                if s[j] == "\\" and j + 1 < n:
                    cur.append(s[j + 1]); j += 2
                elif s.startswith("$(", j) and not s.startswith("$((", j):
                    body, j = _balanced(s, j + 2)
                    subs.append(body); cur.append(SUB_MARK)
                elif s[j] == "`":
                    body, j = _backtick(s, j + 1)
                    subs.append(body); cur.append(SUB_MARK)
                else:
                    cur.append(s[j]); j += 1
            i = j + 1
        elif s.startswith("$((", i):
            body, i = _balanced(s, i + 3)
            if i < n and s[i] == ")":
                i += 1
            cur.append("0"); has_cur = True
        elif s.startswith("$(", i):
            body, i = _balanced(s, i + 2)
            subs.append(body); cur.append(SUB_MARK); has_cur = True
        elif c == "`":
            body, i = _backtick(s, i + 1)
            subs.append(body); cur.append(SUB_MARK); has_cur = True
        elif s.startswith("${", i):
            body, i = _balanced(s, i + 2, "{", "}")
            cur.append("${" + body + "}"); has_cur = True
        elif c == "#" and not has_cur:
            k = s.find("\n", i)
            i = n if k < 0 else k
        elif c in " \t":
            end_word(); i += 1
        elif c in "\n;&|()":
            end_cmd()
            i += 1
        elif c in "<>":
            if has_cur and "".join(cur).isdigit():      # 2>/dev/null 的 2
                cur, has_cur = [], False
            end_word()
            while i < n and s[i] in "<>&":
                i += 1
            if i < n and s[i] == "-":                    # >&- 关闭描述符
                i += 1
            elif not (i < n and s[i].isdigit() and s[i - 1] == "&"):
                skip_next = True                         # 重定向目标不是参数
            else:
                while i < n and s[i].isdigit():
                    i += 1
        else:
            cur.append(c); has_cur = True; i += 1
    end_cmd()
    return cmds


def simple_commands(cmd, in_loop=False, depth=0, assigns=None):
    """→ ([{"argv": [...], "loop": bool}], 赋值表)。递归拆开命令替换；heredoc 内容先去掉（那是数据）。"""
    assigns = {} if assigns is None else assigns
    out = []
    loop = 1 if in_loop else 0
    text = test_time.strip_heredocs(cmd) if depth == 0 else cmd
    for words, subs in _tokenize(text):
        argv, starts_loop = [], False
        k = 0
        while k < len(words):                     # 跳过关键字、赋值前缀、包一层的命令
            w = words[k]
            if w in LOOP_KW:
                starts_loop = True
                k += 1
                if w in ("for", "select"):        # for 头部 `i in …` 不是命令
                    k = len(words)
                continue
            if w == "done":
                loop = max(0, loop - 1)
                k += 1
                continue
            if w in PREFIX_KW:
                k += 1
                continue
            m = ASSIGN.match(w)
            if m:
                if re.fullmatch(r'\d+', m.group(2)):
                    assigns.setdefault(m.group(1), set()).add(m.group(2))
                k += 1
                continue
            if w in WRAPPERS or w == "timeout":
                k += 1
                while k < len(words) and (words[k].startswith("-") or (w == "env" and "=" in words[k])):
                    k += 1
                if w == "timeout" and k < len(words):
                    k += 1                        # 时长
                continue
            break
        if starts_loop:
            loop += 1
        argv = words[k:]
        here = loop > 0
        if argv:
            out.append({"argv": argv, "loop": here})
        if depth < 8:
            for body in subs:
                sub, _ = simple_commands(body, here, depth + 1, assigns)
                out += sub
    return out, assigns


def _gh(argv):
    """gh 调用 → 去掉全局 -R / --repo 之后的参数；不是 gh 返回 None。"""
    if not argv or os.path.basename(argv[0]) != "gh":
        return None
    a, k = argv[1:], 0
    while k < len(a) and a[k] in ("-R", "--repo"):
        k += 2
    return a[k:]


RUNS_PATH = re.compile(r'/actions/runs(?:/|$|\?)|/check-runs\b|/check-suites\b|/commits/[^/\s]+/status\b')


def _kind(argv):
    """一条简单命令 → 'block'（本身阻塞到运行结束）/ 'query'（远端 CI 状态查询）/ None。"""
    a = _gh(argv)
    if a is None:
        if argv and argv[0] == "sleep":
            return "sleep"
        return None
    if a[:2] == ["run", "watch"] or (a[:2] == ["pr", "checks"] and "--watch" in a):
        return "block"
    if a[:2] in (["run", "view"], ["run", "list"], ["pr", "checks"]):
        return "query"
    if a[:1] == ["api"] and any(RUNS_PATH.search(x) for x in a[1:] if not x.startswith("-")):
        return "query"
    return None


def _resolve(tok, assigns):
    if re.fullmatch(r'\d+', tok):
        return tok
    m = re.fullmatch(r'\$\{?([A-Za-z_]\w*)\}?', tok)
    if m and len(assigns.get(m.group(1), ())) == 1:
        return next(iter(assigns[m.group(1)]))
    return ""


def _target(argv, assigns):
    """这一条 gh 命令自己的等待对象 → (what, id)。"""
    a = _gh(argv)
    if a[:1] == ["api"]:
        for x in a[1:]:
            m = re.search(r'/actions/runs/([^/?\s]+)', x)
            if m:
                return "run", _resolve(m.group(1), assigns)
        return "run", ""
    what = "pr" if a[:1] == ["pr"] else "run"
    skip = False
    for x in a[2:]:
        if skip:
            skip = False
            continue
        if x.startswith("-"):
            skip = x in VALUE_FLAGS
            continue
        v = _resolve(x, assigns)
        if v:
            return what, v
    return what, ""


def analyze(cmd):
    """→ None（不是在等远端 CI）| (what, id)。

    等待 = 有一条真正执行的阻塞等待命令；或者在同一个循环里既有 sleep、又有远端 CI 状态查询。
    编号只从认定为等待的那一条命令里取：阻塞命令优先，否则取循环里第一条读得出编号的查询。
    """
    cmds, assigns = simple_commands(cmd)
    kinds = [(c, _kind(c["argv"])) for c in cmds]
    for c, k in kinds:
        if k == "block":
            return _target(c["argv"], assigns)
    queries = [c for c, k in kinds if k == "query" and c["loop"]]
    if queries and any(k == "sleep" and c["loop"] for c, k in kinds):
        for c in queries:
            what, wid = _target(c["argv"], assigns)
            if wid:
                return what, wid
        return _target(queries[0]["argv"], assigns)
    return None


# ── 时间段（毫秒整数，免得浮点相减凭空多出零头）────────────────────────────────

def _ms(t):
    return int(round(t * 1000))


def merge(spans):
    out = []
    for a, b in sorted(s for s in spans if s[1] > s[0]):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def measure(spans):
    return sum(b - a for a, b in spans)


def intersect(xs, ys):
    """两组已合并的时间段的交集总长。"""
    i = j = total = 0
    while i < len(xs) and j < len(ys):
        a, b = max(xs[i][0], ys[j][0]), min(xs[i][1], ys[j][1])
        if b > a:
            total += b - a
        if xs[i][1] < ys[j][1]:
            i += 1
        else:
            j += 1
    return total


def summarize(cmds, ai_spans_ms, since, now, unparsed=0):
    lo, hi = _ms(since), _ms(now)
    waits, timed = [], []
    for c in sorted(cmds, key=lambda c: c["t"]):
        found = analyze(c["cmd"])
        if found is None or _ms(c["t"]) > hi:
            continue
        end = c["end"] if c.get("end") is not None else c.get("done")
        a = max(_ms(c["t"]), lo)
        what, wid = found
        w = {"what": what, "id": wid, "start": a / 1000, "end": None, "secs": None}
        if end is not None:
            b = max(a, min(_ms(end), hi))
            w["end"], w["secs"] = b / 1000, (b - a) / 1000
            timed.append((a, b))
        waits.append(w)
    u = merge(timed)
    ai = merge((max(a, lo), min(b, hi)) for a, b in ai_spans_ms)
    cut = intersect(u, ai)
    total = measure(u) - cut
    untimed = sum(1 for w in waits if w["end"] is None)
    return {"v": 1, "read": True,
            "secs": (total / 1000) if (timed or not waits) else None,
            "waits": waits, "untimed": untimed,
            "overlap": sum(b - a for a, b in timed) > measure(u),
            "ai_cut": cut / 1000, "unparsed": unparsed}


def run(agent, since, now, paths):
    if agent == "claude":
        ok, why, cmds = test_time.claude_commands(paths, since, tools=("Bash", "Monitor"))
        unparsed = 0
    else:
        ok, why, cmds, unparsed = test_time.codex_commands(paths, since)
    if not ok:
        return {"v": 1, "read": False, "why": why}
    return summarize(cmds, ai_time.request_spans(agent, since, paths), since, now, unparsed)


def main(argv):
    if len(argv) < 3 or argv[0] not in ("claude", "codex"):
        print(__doc__.splitlines()[2], file=sys.stderr)
        return 2
    try:
        since = float(argv[1])
        now = time.time() if argv[2] == "now" else float(argv[2])
    except ValueError:
        return 2
    try:
        res = run(argv[0], since, now, argv[3:])
    except Exception as e:   # 统计出错不能挡住评论，也不能冒充「没等过」
        res = {"v": 1, "read": False, "why": f"统计出错（{type(e).__name__}）"}
    print(json.dumps(res, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
