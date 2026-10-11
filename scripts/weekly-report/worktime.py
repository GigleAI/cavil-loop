#!/usr/bin/env python3
"""按派工算「处理时长」：agent **每一轮**从开始到结束，不含轮与轮之间的等待（GigleTutor-Web#933）。

数据源：
  claude —— 会话日志里共用同一个 promptId 的一段主会话记录就是一轮。开始 = 这个编号第一次
            出现的时刻；结束 = 下一个编号出现前，最后一条非子代理的 user / assistant 记录。
            工具返回结果沿用所在轮的编号，不开新轮；子代理记录（isSidechain）不参与。
  codex  —— rollout 里逐项的 started_at_ms / completed_at_ms。

归属：每一轮 / 每一项以**开始时刻**交给 attribute.owner()（与 token 认领同一条规则：agent
相同、worktree 相同、start ≤ t < end；多个候选取开始最晚的；都不命中 → 未归属，单列，不分给
任何派工）。认领到的派工拿**整轮**时长，不封顶、不按窗口裁剪。

这个指标是什么、不是什么：
  是   —— 一轮处理从开始到结束经过的时间。排除得了轮与轮之间的等待（等下一次派工、prompt
          没提交上去）。实测与 CLI 自记的「模型时间 + 工具时间」逐轮基本吻合（#933 自报：
          干净样本 793 轮，中位数 1.003，p05–p95 为 0.999–1.038）。
  不是 —— 精确的执行时长。轮内的等待（权限确认、重试退避、进程挂起）排除不了；一轮在完工
          评论之后还在跑，整轮仍算给这次派工，所以它可能超过该派工的总耗时（这类会在报告
          里点名披露，不改数字，也不代表数据错配）。

为什么不再用累计快照（cost-state）前后相减：快照在派工结束后才落盘，窗口归属只能靠「前后
各配一份」去猜，一段长工作之后紧跟一条短评论时，前面那段会被差分到短窗口头上（实测 57 秒的
窗口算出 53 分钟）。按轮的起止算不需要配对。

台账：Claude Code 只保留一段时间的会话日志（本机观察为 30 天），删掉后这些轮就再也算不出。
所以每次采集把读到的轮写进 `<缓存目录>/worktime-turns.jsonl`，读时用「台账 ∪ 现存日志」。
"""
import datetime
import fcntl
import glob
import json
import os

import attribute
import price_solve

TZ = datetime.timezone(datetime.timedelta(hours=8))

# 处理时长超过该派工总耗时这么多倍就点名。只影响「要不要在报告里列出来」，**不改数字**。
# 按轮归属之后，超出的含义是「这一轮在完工评论之后仍在跑，或轮内有等待」，不是错配。
LONG_TURN_RATIO = 2.0


def _parse_iso(t):
    try:
        return datetime.datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _projects_dir():
    return os.environ.get("CLAUDE_PROJECTS_DIR") or os.path.expanduser("~/.claude/projects")


def _codex_dir():
    return os.environ.get("CODEX_SESSIONS_DIR") or os.path.expanduser("~/.codex/sessions")


# ── claude：分轮 ───────────────────────────────────────────────────────
def _turn_ended(rec):
    """这条记录能不能证明「本轮已结束」。"""
    if rec.get("type") == "system" and rec.get("subtype") in ("turn_duration", "stop_hook_summary"):
        return True
    return (rec.get("type") == "assistant"
            and (rec.get("message") or {}).get("stop_reason") == "end_turn")


def _synthetic(rec):
    """CLI 自己补写、不是模型产出的 assistant 记录（model=<synthetic>）。

    一轮跑到一半进程没了，下次来新指令时 CLI 会先给上一轮补一条「No response requested.」，
    时间戳是**补写的时刻**。拿它当上一轮的结束，那一轮就从几分钟变成几十小时（#933 实跑：
    41.8h / 75.3h / 522h 各一条，把一周的处理时长撑到总耗时的 3 倍）。它不延长任何一轮。
    """
    return (rec.get("type") == "assistant"
            and (rec.get("message") or {}).get("model") == "<synthetic>")


def claude_turns(worktree_path):
    """该 worktree 现存会话日志 → [{agent, wt, sid, pid, start, end, done}]（时刻为 epoch 秒）。"""
    enc = worktree_path.replace("/", "-")
    out = []
    for f in sorted(glob.glob(os.path.join(_projects_dir(), enc, "*.jsonl"))):
        sid = os.path.splitext(os.path.basename(f))[0]
        turns, cur = {}, None
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
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("isSidechain"):
                    continue
                pid = r.get("promptId")
                t = _parse_iso(r.get("timestamp") or "")
                if pid and r.get("type") == "user" and t is not None and pid not in turns:
                    # 新编号 = 新一轮。工具结果沿用旧编号，走不到这里。
                    if cur is not None:
                        cur["done"] = True          # 后面出现了下一轮，前一轮必然已结束
                    cur = turns[pid] = {"agent": "claude", "wt": worktree_path, "sid": sid,
                                        "pid": pid, "start": t, "end": t, "done": False}
                    continue
                if cur is None:
                    continue
                if pid and pid != cur["pid"] and pid in turns:
                    continue                        # 旧编号的迟到记录，不属于当前这轮
                if r.get("type") in ("user", "assistant") and t is not None \
                        and not _synthetic(r):
                    cur["end"] = max(cur["end"], t)
                if _turn_ended(r):
                    cur["done"] = True
        out.extend(turns.values())
    return out


# ── 台账 ──────────────────────────────────────────────────────────────
def ledger_path():
    return os.path.join(price_solve.cache_dir(), "worktime-turns.jsonl")


def _merge_into(dst, row):
    k = (row["sid"], row["pid"])
    old = dst.get(k)
    if old is None:
        dst[k] = dict(row)
        return
    old["end"] = max(old["end"], row["end"])          # 结束时刻只会往后推
    old["start"] = min(old["start"], row["start"])
    old["done"] = bool(old["done"] or row["done"])     # 「已结束」只能从否变成是


def _read_ledger(path):
    rows = {}
    try:
        fh = open(path, encoding="utf-8")
    except OSError:
        return rows
    with fh:
        for line in fh:
            try:
                r = json.loads(line)
                _merge_into(rows, {k: r[k] for k in ("agent", "wt", "sid", "pid",
                                                    "start", "end", "done")})
            except (ValueError, KeyError, TypeError):
                continue                             # 坏行跳过，不让一行毁掉整份台账
    return rows


def merge_ledger(turns):
    """把这次读到的轮并进台账，返回合并后的全部行。

    多个项目 / 补跑的周报可能同时写：整段读改写都在 flock 里，写临时文件后 os.replace
    原子替换——读到的永远是一份完整的旧台账或新台账，不会读到写了一半的。
    """
    path = ledger_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rows = _read_ledger(path)
        for t in turns:
            _merge_into(rows, t)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as out:
            for r in sorted(rows.values(), key=lambda r: (r["wt"], r["start"], r["sid"], r["pid"])):
                out.write(json.dumps(r, ensure_ascii=False) + "\n")
        os.replace(tmp, path)
    return list(rows.values())


# ── codex：逐项 ───────────────────────────────────────────────────────
_codex_index = None


def _codex_files_by_cwd():
    """{cwd: [rollout 文件, ...]}，一次采集只扫一遍。cwd 写在 session_meta 里。"""
    global _codex_index
    if _codex_index is None:
        idx = {}
        for f in glob.glob(os.path.join(_codex_dir(), "*", "*", "*", "rollout-*.jsonl")):
            try:
                with open(f, encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        try:
                            cwd = (json.loads(line).get("payload") or {}).get("cwd")
                        except ValueError:
                            continue
                        if cwd:
                            idx.setdefault(cwd, []).append(f)
                            break
            except OSError:
                continue
        _codex_index = idx
    return _codex_index


def codex_items(worktree_path):
    """该 worktree 的 codex rollout → [{start, end}]（epoch 秒）。"""
    items = []
    for f in _codex_files_by_cwd().get(worktree_path, []):
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                try:
                    p = json.loads(line).get("payload") or {}
                except ValueError:
                    continue
                a, b = p.get("started_at_ms"), p.get("completed_at_ms")
                if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                    items.append({"start": a / 1000.0, "end": max(a, b) / 1000.0})
    return items


# ── 统一认领 ──────────────────────────────────────────────────────────
def claim(windows, worktree_of):
    """windows: [{key, agent, wt, start, end}]（start / end 为带时区的 datetime）。
    worktree_of(wt) → 该 wt 的 worktree 路径。

    返回 (work, in_progress, unattributed)：
        work          {key: 秒}；该派工一轮 / 一项都没认领到时不出现在这里（= 拿不到）
        in_progress   {key: 认领到的轮里还在进行中的个数}
        unattributed  [{wt, agent, start, secs}]，逐轮 / 逐项列出，由调用方按周汇总
    """
    by_wt = {}
    for w in windows:
        by_wt.setdefault((w["wt"], w["agent"]), []).append(w)

    claude_live, units = [], []
    for (wt, agent), ws in by_wt.items():
        path = worktree_of(wt)
        if not path:
            continue
        if agent == "codex":
            for it in codex_items(path):
                units.append({"wt": wt, "agent": "codex", **it, "done": True})
        else:
            for t in claude_turns(path):
                claude_live.append(t)
    paths = {worktree_of(wt): wt for (wt, agent) in by_wt if agent != "codex" and worktree_of(wt)}
    if paths:
        for t in merge_ledger(claude_live):
            if t["wt"] in paths:
                units.append({"wt": paths[t["wt"]], "agent": "claude", "start": t["start"],
                              "end": t["end"], "done": t["done"]})

    work, in_progress, unattr = {}, {}, []
    for u in units:
        t = datetime.datetime.fromtimestamp(u["start"], TZ)
        w = attribute.owner(t, u["agent"], u["wt"], windows)
        secs = max(0.0, u["end"] - u["start"])
        if w is None:
            unattr.append({"wt": u["wt"], "agent": u["agent"], "start": t, "secs": secs})
            continue
        work[w["key"]] = work.get(w["key"], 0.0) + secs
        if not u["done"]:
            in_progress[w["key"]] = in_progress.get(w["key"], 0) + 1
    return work, in_progress, unattr


def long_turn(work_secs, wall_secs):
    """处理时长明显超过总耗时 ⇒ 点名披露（**不改数字**；不代表错配）。"""
    return (work_secs is not None and wall_secs > 0
            and work_secs > LONG_TURN_RATIO * wall_secs)
