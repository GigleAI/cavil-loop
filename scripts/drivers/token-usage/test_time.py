#!/usr/bin/env python3
"""评论 footer 的「测试花了多久」（GitHub#244）：项目测试耗时命令（COMMENT_FOOTER_EXTRA_CMD）的内置实现。

由 test-time.sh 调用；comment_footer.py 在 worktree 里跑它，环境变量带上
CAVIL_FOOTER_START_EPOCH / CAVIL_FOOTER_WORKTREE / CAVIL_FOOTER_AGENT。输出照接口约定：
第一行 `test_secs=<秒>` 或 `test_secs=unknown`，一行 `kv <机器字段>`，其余是折叠细节分条。

两栏：
  · 整套测试：tests/run.sh 自己记的流水（实测）。每次运行生成一个运行编号，印在自己的输出里
    （`cavil-test-run id=<编号>`），流水的开始 / 结束行带同一个编号。
  · 单跑测试：从本 worktree、派工开始之后的 agent 会话记录里认出测试命令（估算）。

会话里的整套测试命令和流水**只按编号关联**：编号从这条命令自己的输出里读（前台看工具结果，
Claude 放后台的命令去读工具结果里写明的输出文件），不按时间远近、不按目录猜——人在附近手跑的
另一次、同一 agent 并发的另一次，时间再近也不是这一次（#244 方案复审第 2 轮）。

| 证据                                   | 结果                              |
| 编号在输出里，流水两行都在 / 只有结束行  | 按流水计时（结束行自带开始时刻）      |
| 编号在输出里，流水只有开始行            | 1 次「未记到结束」，不计时            |
| 编号在输出里，流水里没有这个编号        | 1 次「没有记账」，不计时              |
| 命令输出读不到 / 输出里没有编号         | 1 次「无法关联」，不计时              |
| 流水里有、没有任何会话命令印出过它的编号 | 单独算 1 次，按流水计时               |

回答：任何一栏读取失败 → unknown；有计时 → 已计时部分的时间段并集（另有未计时的写进细节，
是下限）；一秒都没计上但有运行证据 → unknown；两栏都读到、一次运行证据都没有 → 0。
两栏都读不到时非 0 退出（footer 写「测试未知」及原因）。

已知限制（docs/operations.md 有同样的说明）：命令按写法认，自己包一层脚本、`bash -c '…'`
认不出来；单跑测试的时间是整条命令的时间；Claude 放后台的单跑测试只计次数；codex 的单跑
测试只计次数（codex 一次工具调用里可以跑多条命令，输出和命令对不上号）；「无法关联」时同一次
运行可能还会按流水再算一次，次数多 1、秒数不多。

会话目录可用 CLAUDE_PROJECTS_DIR / CODEX_SESSIONS_DIR 覆盖，流水路径可用 CAVIL_TEST_RUNS_LOG
覆盖（都是测试用）。
"""
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import time

RUN_MARK = re.compile(r'cavil-test-run id=([A-Za-z0-9._-]+)')
MOVED_BG = re.compile(r'Command did not complete within [^.\n]{0,40}? timeout and was moved to the background\b')
BG_OUTPUT = re.compile(r'Output is being written to: (\S+?\.output)\b')
EXIT_CODE = re.compile(r'^Exit code (-?\d+)', re.M)
SKIP_WORDS = {"env", "time", "nice", "command", "exec", "nohup"}
SHELL_KEYWORDS = {"do", "then", "else", "elif", "if", "while", "until", "!", "{", "("}
# 不跑测试的整套入口模式：这几种不生成运行编号，也不是测试运行
SUITE_NON_RUN = {"--list", "--verify", "--verify=", "--tally", "-h", "--help"}


def runs_log_path(env):
    if env.get("CAVIL_TEST_RUNS_LOG"):
        return env["CAVIL_TEST_RUNS_LOG"]
    base = env.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "cavil-loop", "test-runs.jsonl")


# ── 认命令 ────────────────────────────────────────────────────────────────

def strip_heredocs(text):
    out, pending = [], []
    for line in text.split("\n"):
        if pending:
            tag, dash = pending[0]
            if (line.lstrip("\t") if dash else line).rstrip() == tag:
                pending.pop(0)
            continue
        out.append(line)
        for m in re.finditer(r'(?<!<)<<(?!<)(-?)\s*([\'"]?)([A-Za-z_][\w-]*)\2', line):
            pending.append((m.group(3), m.group(1) == "-"))
    return "\n".join(out)


def strip_quotes(text):
    """引号里的文字换成空串：`echo "bash tests/run.sh"` 不是在跑测试。"""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == "'":
            j = text.find("'", i + 1)
            out.append("''")
            i = n if j < 0 else j + 1
        elif c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append('""')
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def segments(cmd):
    text = strip_quotes(strip_heredocs(cmd))
    return [s for s in re.split(r'&&|\|\||[;|&\n()]', text) if s.strip()]


def classify_segment(seg):
    """'suite'（整套）/ 'suite-meta'（整套入口但不跑测试）/ 'adhoc'（单跑）/ None。"""
    toks = seg.split()
    i = 0
    while i < len(toks):
        t = toks[i]
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', t) or t in SHELL_KEYWORDS:
            i += 1
        elif t == "env":
            i += 1
            while i < len(toks) and (toks[i].startswith("-") or "=" in toks[i]):
                i += 2 if toks[i] in ("-u", "--unset", "-C", "--chdir", "-S") else 1
        elif t in SKIP_WORDS:
            i += 1
            while i < len(toks) and toks[i].startswith("-"):
                i += 1
        elif t == "timeout":
            i += 1
            while i < len(toks) and toks[i].startswith("-"):
                i += 1
            i += 1
        else:
            break
    if i >= len(toks):
        return None
    head, rest = toks[i], toks[i + 1:]
    base = os.path.basename(head)
    if base in ("bash", "sh"):
        args = [t for t in rest if not t.startswith("-")]
        if not args:
            return None
        opts = rest[:rest.index(args[0])]
        # -c：跑的是一段字符串（认不出来）；-n：只查语法、不执行（`bash -n tests/run.sh` 不是一次测试）
        if any(o == "-c" or (not o.startswith("--") and ("c" in o[1:] or "n" in o[1:])) for o in opts):
            return None
        head, rest = args[0], rest[rest.index(args[0]) + 1:]
        base = os.path.basename(head)
    if base == "run.sh" and os.path.basename(os.path.dirname(head)) == "tests":
        if any(a in SUITE_NON_RUN or a.startswith("--verify=") for a in rest):
            return "suite-meta"
        return "suite"
    if base.endswith(".test.sh") or (base == "mutations.sh" and "tauri" in head):
        return "adhoc"
    if base == "npm":
        k = 0
        while k < len(rest) and rest[k].startswith("-"):
            k += 2 if rest[k] in ("--prefix", "-C") else 1
        sub = rest[k] if k < len(rest) else ""
        if sub in ("test", "t", "tst"):
            return "adhoc"
        if sub in ("run", "run-script") and k + 1 < len(rest) and rest[k + 1].startswith("test"):
            return "adhoc"
        return None
    if base == "npx":
        args = [t for t in rest if not t.startswith("-")]
        if args[:1] == ["vitest"] or args[:2] == ["playwright", "test"]:
            return "adhoc"
        return None
    if base == "cargo" and [t for t in rest if not t.startswith("-")][:1] == ["test"]:
        return "adhoc"
    return None


def classify(cmd):
    kinds = {classify_segment(s) for s in segments(cmd)} - {None}
    return {"suite": "suite" in kinds, "adhoc": "adhoc" in kinds}


# ── 读流水 ────────────────────────────────────────────────────────────────

def read_runs(path, wt):
    """→ (ok, {编号: {"t0", "t1", "exit", "start", "end"}})，只留本 worktree 的。"""
    runs = {}
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return True, runs, 0
    except OSError:
        return False, runs, 0
    bad = 0
    with f:
        for line in f:
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except ValueError:
                bad += 1
                continue
            if not isinstance(d, dict) or not isinstance(d.get("id"), str):
                bad += 1
                continue
            if d.get("wt") != wt:
                continue
            r = runs.setdefault(d["id"], {"t0": None, "t1": None, "exit": None, "start": False, "end": False})
            if d.get("ev") == "start" and isinstance(d.get("t"), (int, float)):
                r["start"] = True
                r["t0"] = d["t"] if r["t0"] is None else r["t0"]
            elif d.get("ev") == "end" and isinstance(d.get("t"), (int, float)):
                r["end"] = True
                r["t1"] = d["t"]
                r["exit"] = d.get("exit")
                if isinstance(d.get("t0"), (int, float)):
                    r["t0"] = d["t0"]
            else:
                bad += 1
    return True, runs, bad


# ── 读会话 ────────────────────────────────────────────────────────────────

def _ts(v):
    try:
        return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _records(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if isinstance(r, dict):
                yield r


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and isinstance(b.get("text"), str))
    return ""


def claude_dir(projects, wt):
    for enc in (wt.replace("/", "-"), re.sub(r'[^A-Za-z0-9]', "-", wt)):
        d = os.path.join(projects, enc)
        if os.path.isdir(d):
            return d
    return None


def read_claude(env, wt, since):
    """→ (ok, why, [命令])，命令 = {"t", "end", "cmd", "bg", "text", "exit"}；只看主线程、开始之后的。"""
    projects = env.get("CLAUDE_PROJECTS_DIR") or os.path.join(os.path.expanduser("~"), ".claude", "projects")
    d = claude_dir(projects, wt)
    if not d:
        return False, "没找到本 worktree 的 Claude 会话目录", []
    files = sorted(glob.glob(os.path.join(d, "*.jsonl")))
    if not files:
        return False, "Claude 会话目录里没有会话文件", []
    uses, results = {}, {}
    try:
        for p in files:
            for r in _records(p):
                if r.get("type") not in ("assistant", "user") or r.get("isSidechain"):
                    continue    # api-request-blob 等记录重复带着工具调用、没有时刻，不看
                t = _ts(r.get("timestamp"))
                content = (r.get("message") or {}).get("content")
                if t is None or not isinstance(content, list):
                    continue
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if r["type"] == "assistant" and b.get("type") == "tool_use" and b.get("name") == "Bash":
                        cmd = (b.get("input") or {}).get("command")
                        if isinstance(b.get("id"), str) and isinstance(cmd, str) and b["id"] not in uses:
                            uses[b["id"]] = {"t": t, "cmd": cmd, "bg": bool((b.get("input") or {}).get("run_in_background"))}
                    elif r["type"] == "user" and b.get("type") == "tool_result":
                        tid = b.get("tool_use_id")
                        if isinstance(tid, str) and tid not in results:
                            tur = r.get("toolUseResult") if isinstance(r.get("toolUseResult"), dict) else {}
                            text = _text(b.get("content"))
                            ex = None
                            if tur.get("interrupted") is True:
                                ex = None
                            elif b.get("is_error") is False:
                                ex = 0
                            elif b.get("is_error") is True:
                                m = EXIT_CODE.search(text)
                                ex = int(m.group(1)) if m else None
                            results[tid] = {"t": t, "text": text, "exit": ex}
    except OSError as e:
        return False, f"Claude 会话记录读不了（{e.strerror}）", []
    out = []
    for tid, u in uses.items():
        if u["t"] < since:
            continue
        res = results.get(tid)
        text = res["text"] if res else None
        # 前台命令超时被挪到后台（工具结果以这句开头，原文按本机会话核对过）：此后和后台命令一样，
        # 工具结果的时刻不是结束时刻，编号要去输出文件里找
        if res and not u["bg"] and MOVED_BG.match(res["text"]):
            u = dict(u, bg=True)
        if u["bg"] and res:
            m = BG_OUTPUT.search(res["text"])
            text = None
            if m:
                try:
                    with open(m.group(1), encoding="utf-8", errors="replace") as f:
                        text = f.read()
                except OSError:
                    text = None
        out.append({"t": u["t"], "end": None if (u["bg"] or not res) else res["t"], "cmd": u["cmd"],
                    "bg": u["bg"], "text": text, "exit": None if u["bg"] or not res else res["exit"]})
    return True, "", out


CODEX_CMD = re.compile(r'\bcmd\s*:\s*("(?:[^"\\]|\\.)*")')


def read_codex(env, wt, since):
    """codex：一次工具调用里可以跑多条命令、输出和命令对不上号，所以只做两件事——
    认出跑了哪些测试命令（只计次数），以及在本会话全部输出里收集运行编号。"""
    root = env.get("CODEX_SESSIONS_DIR") or os.path.join(os.path.expanduser("~"), ".codex", "sessions")
    if not os.path.isdir(root):
        return False, "没找到 codex 会话目录", [], set()
    day = datetime.date.fromtimestamp(since) - datetime.timedelta(days=1)
    files = []
    while day <= datetime.date.today() + datetime.timedelta(days=1):
        files += glob.glob(os.path.join(root, f"{day:%Y}", f"{day:%m}", f"{day:%d}", "rollout-*.jsonl"))
        day += datetime.timedelta(days=1)
    cmds, ids, mine = [], set(), 0
    try:
        for p in sorted(files):
            recs = list(_records(p))
            if not any(r.get("type") == "session_meta" and (r.get("payload") or {}).get("cwd") == wt for r in recs):
                continue
            mine += 1
            for r in recs:
                pl = r.get("payload") or {}
                t = _ts(r.get("timestamp"))
                if t is None or t < since:
                    continue
                kind = pl.get("type")
                if kind in ("custom_tool_call", "function_call"):
                    src = pl.get("input") if kind == "custom_tool_call" else pl.get("arguments")
                    for m in CODEX_CMD.finditer(src if isinstance(src, str) else ""):
                        try:
                            c = json.loads(m.group(1))
                        except ValueError:
                            continue
                        cmds.append({"t": t, "end": None, "cmd": c, "bg": True, "text": None, "exit": None})
                elif kind in ("custom_tool_call_output", "function_call_output"):
                    o = pl.get("output")
                    ids.update(RUN_MARK.findall(o if isinstance(o, str) else json.dumps(o, ensure_ascii=False)))
    except OSError as e:
        return False, f"codex 会话记录读不了（{e.strerror}）", [], set()
    if not mine:
        return False, "没找到本 worktree 的 codex 会话", [], set()
    return True, "", cmds, ids


# ── 汇总 ──────────────────────────────────────────────────────────────────

def union_secs(spans, lo, hi):
    spans = sorted((max(a, lo), min(b, hi)) for a, b in spans)
    total, cur_a, cur_b = 0.0, None, None
    for a, b in spans:
        if b <= a:
            continue
        if cur_b is None or a > cur_b:
            if cur_b is not None:
                total += cur_b - cur_a
            cur_a, cur_b = a, b
        else:
            cur_b = max(cur_b, b)
    if cur_b is not None:
        total += cur_b - cur_a
    return total


def summarize(agent, wt, since, now, env):
    s = {"suite_read": True, "adhoc_read": True, "why": [], "spans": [],
         "suite_timed": 0, "suite_secs": [], "suite_failed": 0, "suite_unfinished": 0,
         "suite_unlogged": 0, "suite_unlinked": 0,
         "adhoc_runs": 0, "adhoc_timed": 0, "adhoc_spans": [], "adhoc_untimed": 0, "adhoc_failed": 0}
    log_ok, runs, bad = read_runs(runs_log_path(env), wt)
    if not log_ok:
        s["suite_read"] = False
        s["why"].append("整套测试的流水读不了")
    if agent == "claude":
        sess_ok, why, cmds = read_claude(env, wt, since)
        ids_any = set()
    elif agent == "codex":
        sess_ok, why, cmds, ids_any = read_codex(env, wt, since)
    else:
        sess_ok, why, cmds, ids_any = False, f"不认识的 agent「{agent}」", [], set()
    if not sess_ok:
        s["adhoc_read"] = False
        s["why"].append(f"会话记录读取失败：{why}")

    claimed = set()

    def take(rid):
        """一个编号对应的那次运行：计时 / 未记到结束 / 没有记账。"""
        r = runs.get(rid)
        claimed.add(rid)
        if not r or not (r["start"] or r["end"]):
            s["suite_unlogged"] += 1
        elif r["end"] and r["t0"] is not None:
            s["suite_timed"] += 1
            s["spans"].append((r["t0"], r["t1"]))
            s["suite_secs"].append((r["t0"], r["t1"]))
            if r["exit"] not in (0, None):
                s["suite_failed"] += 1
        else:
            s["suite_unfinished"] += 1

    suite_cmds = 0
    for c in cmds:
        k = classify(c["cmd"])
        if k["suite"]:
            suite_cmds += 1
            if agent == "claude":
                found = [i for i in RUN_MARK.findall(c["text"] or "") if i not in claimed]
                if not found:
                    s["suite_unlinked"] += 1
                for rid in dict.fromkeys(found):
                    take(rid)
        if k["adhoc"]:
            s["adhoc_runs"] += 1
            if c["end"] is not None and not k["suite"]:
                s["adhoc_timed"] += 1
                s["spans"].append((c["t"], c["end"]))
                s["adhoc_spans"].append((c["t"], c["end"]))
                if c["exit"] not in (0, None):
                    s["adhoc_failed"] += 1
            else:
                s["adhoc_untimed"] += 1
    if agent == "codex":
        # 输出和命令对不上号：本会话输出里出现过的编号逐个认领；整套命令比编号多出来的算「无法关联」
        for rid in sorted(ids_any):
            take(rid)
        s["suite_unlinked"] += max(0, suite_cmds - len(ids_any))
    # 流水里有、没有任何会话命令印出过它的编号（人手跑、换了写法）：单独算，按流水计
    for rid, r in sorted(runs.items()):
        if rid in claimed:
            continue
        t0 = r["t0"]
        if t0 is None or t0 < since:
            continue
        take(rid)
    s["bad_lines"] = bad
    s["secs"] = union_secs(s["spans"], since, now)
    return s


def dur(x):
    n = int(round(x))
    h, rem = divmod(n, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {sec}s"
    return f"{m}m {sec}s" if m else f"{sec}s"


def secs_text(x):
    ms = int(round(x * 1000))
    return str(ms // 1000) if ms % 1000 == 0 else f"{ms / 1000:.3f}".rstrip("0")


def render(s, since, now):
    suite_runs = s["suite_timed"] + s["suite_unfinished"] + s["suite_unlogged"] + s["suite_unlinked"]
    runs = suite_runs + s["adhoc_runs"]
    untimed = s["suite_unfinished"] + s["suite_unlogged"] + s["suite_unlinked"] + s["adhoc_untimed"]
    read_ok = s["suite_read"] and s["adhoc_read"]
    if not read_ok:
        answer = "unknown"
    elif s["secs"] > 0:
        answer = secs_text(s["secs"])
    elif runs > 0:
        answer = "unknown"
    else:
        answer = "0"
    kv = {
        "suite_read": "ok" if s["suite_read"] else "failed",
        "suite_runs": suite_runs, "suite_timed": s["suite_timed"],
        "suite_secs": secs_text(union_secs(s["suite_secs"], since, now)),
        "suite_failed": s["suite_failed"], "suite_unfinished": s["suite_unfinished"],
        "suite_unlogged": s["suite_unlogged"], "suite_unlinked": s["suite_unlinked"],
        "adhoc_read": "ok" if s["adhoc_read"] else "failed",
        "adhoc_runs": s["adhoc_runs"], "adhoc_timed": s["adhoc_timed"],
        "adhoc_secs": secs_text(union_secs(s["adhoc_spans"], since, now)),
        "adhoc_untimed": s["adhoc_untimed"], "adhoc_failed": s["adhoc_failed"],
    }
    segs = []
    if suite_runs:
        notes = []
        if s["suite_failed"]:
            notes.append(f"{s['suite_failed']} 次红")
        for key, label in (("suite_unfinished", "未记到结束"), ("suite_unlogged", "没有记账"),
                           ("suite_unlinked", "无法关联")):
            if s[key]:
                notes.append(f"{s[key]} 次{label}、未计时")
        timed = f"，已计时 {s['suite_timed']} 次 {dur(union_secs(s['suite_secs'], since, now))}（实测）" if s["suite_timed"] else ""
        segs.append(f"整套测试 {suite_runs} 次{timed}{'；' + '；'.join(notes) if notes else ''}")
    if s["adhoc_runs"]:
        notes = ["按命令名识别"]
        if s["adhoc_failed"]:
            notes.insert(0, f"{s['adhoc_failed']} 次红")
        if s["adhoc_untimed"]:
            notes.append(f"{s['adhoc_untimed']} 次后台运行或无法单独计时、只计次数")
        timed = f"，约 {dur(union_secs(s['adhoc_spans'], since, now))}" if s["adhoc_timed"] else ""
        segs.append(f"单跑 {s['adhoc_runs']} 次{timed}（{'；'.join(notes)}）")
    if s["bad_lines"]:
        segs.append(f"流水里有 {s['bad_lines']} 行读不懂，已跳过")
    segs += s["why"]
    if not runs and read_ok:
        lines = ["- 本轮未跑测试"]
    elif runs:
        head = f"- 测试 {runs} 次，已计时部分共 {dur(s['secs'])}" if s["secs"] > 0 else f"- 测试 {runs} 次，耗时未知"
        if untimed and s["secs"] > 0:
            head += f"（另有 {untimed} 次未计时，实际更长）"
        lines = [head + "："] + [f"  - {x}" for x in segs]
    else:
        lines = ["- 测试耗时没统计全："] + [f"  - {x}" for x in segs]
    return "\n".join([f"test_secs={answer}", "kv " + " ".join(f"{k}={v}" for k, v in kv.items())] + lines)


def git_top(d):
    try:
        r = subprocess.run(["git", "-C", d, "rev-parse", "--show-toplevel"], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return d


def main():
    env = os.environ
    try:
        since = float(env.get("CAVIL_FOOTER_START_EPOCH", ""))
    except ValueError:
        return 2
    if not since > 0:
        return 2
    wt = git_top(env.get("CAVIL_FOOTER_WORKTREE") or os.getcwd())
    now = time.time()
    s = summarize(env.get("CAVIL_FOOTER_AGENT", ""), wt, since, now, env)
    if not s["suite_read"] and not s["adhoc_read"]:
        print("；".join(s["why"]), file=sys.stderr)
        return 1
    print(render(s, since, now))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:   # 统计出错不能挡住评论：footer 会写「测试未知」及退出码
        print(f"test_time: {e}", file=sys.stderr)
        sys.exit(1)
