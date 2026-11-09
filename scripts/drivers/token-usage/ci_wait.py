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
  不算：单次查询、`gh workflow run`、轮询 PR 评论 / 标签、引号里的文字（`echo "gh run watch"`）。
  命令切分（去 heredoc、去引号）用测试统计（test_time.py）那一套；写在双引号里的 `$( … )` 照样认。
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

GH = r'\bgh\s+(?:(?:-R|--repo)\s+\S+\s+)?'
WATCH = re.compile(GH + r'run\s+watch\b')
CHECKS = re.compile(GH + r'pr\s+checks\b')
WATCH_FLAG = re.compile(r'(?:^|\s)--watch\b')
QUERY = re.compile(GH + r'(?:run\s+(?:view|list)\b|pr\s+checks\b|api\b[^\n;&|]*?'
                   r'(?:/actions/runs\b|/check-runs\b|/check-suites\b|/commits/[^\s/]+/status\b))')
LOOP = re.compile(r'(?:^|[\s;&|(])(?:for|while|until)\s')
SLEEP = re.compile(r'(?:^|[\s;&|(])sleep\s+\S')
VALUE_FLAGS = {"-i", "--interval", "--attempt", "-R", "--repo", "--json", "--jq", "-q", "-t", "--template",
               "-j", "--job", "-w", "--workflow", "-b", "--branch"}


def _subst_bodies(text):
    """所有 `$( … )` 的内容（括号配对），双引号里的也取出来。"""
    out, i = [], 0
    while True:
        j = text.find("$(", i)
        if j < 0:
            return out
        depth, k = 0, j + 1
        while k < len(text):
            if text[k] == "(":
                depth += 1
            elif text[k] == ")":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        out.append(text[j + 2:k])
        i = j + 2


def _plain(cmd):
    """去 heredoc、去引号内文字，再把各处 `$( … )` 的内容（同样去引号）接在后面。"""
    h = test_time.strip_heredocs(cmd)
    return "\n".join([test_time.strip_quotes(h)] + [test_time.strip_quotes(b) for b in _subst_bodies(h)])


def is_wait(cmd):
    text = _plain(cmd)
    for seg in re.split(r'&&|\|\||[;|&\n()]', text):
        if WATCH.search(seg) or (CHECKS.search(seg) and WATCH_FLAG.search(seg)):
            return True
    # 查询的路径常写在引号里（`gh api "repos/…/actions/runs/1"`），所以在只去了 heredoc 的原文里找；
    # 循环和 sleep 必须在引号外（`echo "while … sleep …"` 不是循环）
    return bool(LOOP.search(text) and SLEEP.search(text) and QUERY.search(test_time.strip_heredocs(cmd)))


def _resolve(tok, text):
    v = tok.strip("\"'")
    if re.fullmatch(r'\d+', v):
        return v
    m = re.fullmatch(r'\$\{?([A-Za-z_]\w*)\}?', v)
    if m:
        vals = set(re.findall(r'(?:^|[\s;&|(])' + m.group(1) + r'=["\']?(\d+)["\']?(?=[\s;&|)]|$)', text))
        if len(vals) == 1:
            return vals.pop()
    return ""


def _first_id(rest, text):
    toks = re.split(r'[\s]+', rest.strip())
    skip = False
    for t in toks:
        if not t or re.match(r'[;&|)<>]', t):
            break
        if skip:
            skip = False
            continue
        if t.startswith("-"):
            skip = t in VALUE_FLAGS
            continue
        v = _resolve(t, text)
        if v:
            return v
    return ""


def target(cmd):
    """→ (what, id)：等的是哪个运行 / 哪个 PR 的检查；编号读不出为空串。"""
    h = test_time.strip_heredocs(cmd)
    for m in re.finditer(GH + r'run\s+(?:watch|view)\b([^\n;&|]*)', h):
        v = _first_id(m.group(1), h)
        if v:
            return "run", v
    for m in re.finditer(r'/actions/runs/([^/\s\'"?]+)', h):
        v = _resolve(m.group(1), h)
        if v:
            return "run", v
    for m in re.finditer(GH + r'pr\s+checks\b([^\n;&|]*)', h):
        v = _first_id(m.group(1), h)
        if v:
            return "pr", v
    if re.search(GH + r'run\b', h) or "/actions/runs" in h:
        return "run", ""
    if CHECKS.search(h):
        return "pr", ""
    return "", ""


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
        if not is_wait(c["cmd"]) or _ms(c["t"]) > hi:
            continue
        end = c["end"] if c.get("end") is not None else c.get("done")
        a = max(_ms(c["t"]), lo)
        what, wid = target(c["cmd"])
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
