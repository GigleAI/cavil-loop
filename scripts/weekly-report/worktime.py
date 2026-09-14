#!/usr/bin/env python3
"""按派工窗口算「模型 + 工具」时长（排除等待）。

为什么放在周报这一侧、而不是放进写记账行的 driver（GigleTutor-Web#931）：
claude 的累计快照（cost-state）是**派工结束之后**才落盘的——实测 13/13 个派工
窗口内部一条都没有，每条都落在评论发出后 20–40 秒。而 driver 跑在发评论之前，
那时本次派工的快照还不存在，算不出来。出周报时所有派工早就结束了，快照齐全。

这个指标是什么、不是什么：
  是   —— agent CLI 自己记录的模型调用 + 工具执行时间，不含等待。
  不是 —— 精确工时。窗口归属靠快照前后配对，**逐条可能错位**：实测中位数比该
          窗口自身的墙上时长多 4%（77.8% 的窗口在 10% 以内），但有约 1.7% 的
          记录明显错位（最大 56 倍），原因是它们紧跟在一段长工作之后发了条短
          评论，差分把前面那段算到了它头上。这类**原样计入**（错位在合计上基本
          守恒，封顶反而会抹掉真实工时），并在报告里逐条点名。

墙上时长不受本模块影响：它一直由记账行的起止时刻直接算，两个数并列给出。
"""
import json, glob, os, datetime

TZ = datetime.timezone(datetime.timedelta(hours=8))

# 逐条明显错位的判据：算出来超过该窗口自身墙上时长这么多倍就点名。
# 只影响「要不要在报告里列出来」，**不改数字**。
MISATTRIB_RATIO = 2.0


def _parse_iso(t):
    try:
        return datetime.datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(TZ)
    except Exception:
        return None


# ── claude：累计快照差分 ────────────────────────────────────────────────
_claude_cache = {}


def _claude_snapshots(worktree_path):
    """{会话文件: {"first": 会话首条记录时刻, "last": 末条记录时刻, "seq": [(锚定时刻, 累计值), ...]}}

    累计值只在**同一个文件内**单调，所以必须按文件分组配对，不能把多个会话混在一起排序。
    快照本身不带 timestamp，用它前面最近一条带 timestamp 的记录作锚定时刻。

    `first` / `last` 记的是**会话自己的时间范围**（任何带 timestamp 的记录，不限于快照）。
    判断会话跟派工窗口有没有交集必须用它，不能用第一份快照的时刻——见 `_claude_work`。
    """
    if worktree_path in _claude_cache:
        return _claude_cache[worktree_path]
    enc = worktree_path.replace("/", "-")
    per = {}
    for f in glob.glob(os.path.expanduser(f"~/.claude/projects/{enc}/*.jsonl")):
        seq, last, first = [], None, None
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o.get("type") == "cost-state":
                    if last:
                        seq.append((last, {k: o.get(k, 0) for k in
                                           ("totalAPIDuration", "totalToolDuration")}))
                elif o.get("timestamp"):
                    d = _parse_iso(o["timestamp"])
                    if d:
                        last = d
                        if first is None:
                            first = d
        if seq:
            per[f] = {"first": first or seq[0][0], "last": last or seq[-1][0], "seq": seq}
    _claude_cache[worktree_path] = per
    return per


def _claude_work(worktree_path, start, end):
    best = None
    for _f, s in _claude_snapshots(worktree_path).items():
        seq = s["seq"]
        # ⚠️ 判「这个会话跟本窗口有没有交集」要用**会话自己的时间范围**，
        # 不能用第一份累计快照的时刻（GitHub#932 交叉 review）。
        # 快照是**派工结束之后**才落盘的：一个**新会话的第一次派工**——10:00 开工、
        # 10:10 发完工评论、10:10:30 才落下第一份 cost-state——`seq[0][0] > end` 就成立，
        # 整个会话被跳过。日志在、累计值也在，却被记成 `work_missing`，合计系统性漏算。
        # 用 first / last 之后，这种情况照常走下面的「零基线 + 收尾快照」估算规则；
        # 而**真正晚于窗口才开始**的会话仍然被 `s["first"] > end` 挡住，不会被认领进来。
        if s["first"] > end or s["last"] < start:
            continue                       # 这个会话文件的时间范围不覆盖本窗口
        base = None
        for d, p in seq:
            if d < start:
                base = p
        cur = next((p for d, p in seq if d >= end), None)
        if cur is None:
            continue
        z = base or {k: 0 for k in cur}
        secs = sum(cur[k] - z.get(k, 0) for k in cur) / 1000.0
        if secs < 0:
            continue
        if best is None or secs < best:     # 多个候选文件取最小，避免把整段会话算进来
            best = secs
    return best


# ── codex：逐项起止时刻求和 ─────────────────────────────────────────────
_codex_index = None


def _codex_sessions():
    """{cwd: [会话文件, ...]}。codex 的 rollout 按日期分目录，cwd 写在 session_meta 里。"""
    global _codex_index
    if _codex_index is not None:
        return _codex_index
    idx = {}
    for f in glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/rollout-*.jsonl")):
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    cwd = (o.get("payload") or {}).get("cwd")
                    if cwd:
                        idx.setdefault(cwd, []).append(f)
                        break
        except OSError:
            continue
    _codex_index = idx
    return idx


def _codex_work(worktree_path, start, end):
    files = _codex_sessions().get(worktree_path)
    if not files:
        return None
    total, seen = 0.0, False
    lo, hi = start.timestamp() * 1000, end.timestamp() * 1000
    for f in files:
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                p = o.get("payload") or {}
                a, b = p.get("started_at_ms"), p.get("completed_at_ms")
                if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
                    continue
                if a < lo or a > hi:
                    continue
                seen = True
                if b > a:
                    total += (b - a) / 1000.0
    return total if seen else None


def window_work(agent, worktree_path, start, end):
    """返回该派工窗口的「模型 + 工具」秒数；拿不到返回 None（报告里如实标注）。"""
    if not worktree_path or not isinstance(start, datetime.datetime):
        return None
    try:
        if agent == "codex":
            return _codex_work(worktree_path, start, end)
        return _claude_work(worktree_path, start, end)
    except Exception:
        return None


def misattributed(work_secs, wall_secs):
    """算出来明显超过自身墙上时长 ⇒ 归属错位，点名列出（**不改数字**）。"""
    return (work_secs is not None and wall_secs > 0
            and work_secs > MISATTRIB_RATIO * wall_secs)
