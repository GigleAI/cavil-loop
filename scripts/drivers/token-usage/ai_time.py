#!/usr/bin/env python3
"""估算一次派工里「AI 在干活」的时间：把每次等模型回话的时间段取并集再求和（GitHub#88）。

用法: python3 ai_time.py <claude|codex> <start_epoch> <end_epoch|now> <会话文件...>
输出: `ai_secs=<秒，毫秒精度> ai_requests=<参与估算的请求数>`；一个请求都认不出时不输出。

由用量驱动（claude.sh / codex.sh）在 --kv 模式下调用，文件清单就是驱动自己读的那一批，
所以 AI 时间和 token 用的是同一批会话、同一个时间窗。

一次请求的时间段 = [请求发出, 这次回复最后一段写进会话记录]：
  claude —— 发出时刻取 `api-request`（主线程）记录；老版本 CLI 没有这种记录，退回到这次
            回复之前最近的一条 user 记录（工具结果 / 提示词），CLI 收到它就立刻发请求。
            结束取同一个 requestId 下最晚的一条 assistant 记录。
  codex  —— 结束取 `token_usage_record`（每次 API 调用回完写一条）；发出时刻取它之前最近的
            「输入就绪」时刻：本轮开始（task_started）、用户消息、工具结果、上一次回复结束。
归属沿用驱动的规则：claude 按 requestId 归组、组内最早时刻落窗口；codex 按记录时刻落窗口。
时间段再裁到 [start, end] 里，最后取并集——子任务并行、同一秒只算一次。

这是估算，不是计时器。偏差来源（评论里原样说明）：
  · 含网络往返和排队等首字的时间，不只是纯生成
  · 会话记录的时间是写盘时刻，与真实收发差几毫秒到几秒
  · AI 在想的时候后台命令可能也在跑，这段在「AI」和项目自报的「测试」里都会算
"""
import datetime
import json
import sys
import time


def _ts_ms(v):
    try:
        t = datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(round(t.timestamp() * 1000))


def _records(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict):
                    yield r
    except OSError:
        return


def claude_requests(path, start_ms):
    """一份 claude 会话文件里的请求时间段 [(发出, 结束)]（毫秒）。"""
    ready = None                 # 最近一次「请求发出」的时刻
    groups = {}                  # requestId → [发出, 最早回复, 最晚回复]
    for r in _records(path):
        if r.get("isSidechain"):
            continue
        t = r.get("type")
        ts = _ts_ms(r.get("timestamp")) if r.get("timestamp") else None
        if ts is None:
            continue
        if t == "api-request":
            if r.get("querySource", "repl_main_thread") == "repl_main_thread":
                ready = ts
        elif t == "user":
            ready = ts
        elif t == "assistant":
            rid = r.get("requestId")
            model = (r.get("message") or {}).get("model") or ""
            if not rid or model == "<synthetic>":
                continue
            g = groups.get(rid)
            if g is None:
                groups[rid] = [ready, ts, ts]
            else:
                g[1] = min(g[1], ts)
                g[2] = max(g[2], ts)
    out = []
    for begin, first, last in groups.values():
        if begin is None or begin > first or first < start_ms:
            continue
        out.append((begin, last))
    return out


_CODEX_OUTPUTS = {"function_call_output", "custom_tool_call_output", "local_shell_call_output"}


def codex_requests(path, start_ms):
    """一份 codex rollout 里的请求时间段 [(发出, 结束)]（毫秒）。"""
    ready = None
    out = []
    for r in _records(path):
        t = r.get("type")
        p = r.get("payload") or {}
        ts = _ts_ms(r.get("timestamp")) if r.get("timestamp") else None
        if ts is None:
            continue
        pt = p.get("type")
        if t == "event_msg" and pt == "task_started":
            ready = ts
        elif t == "event_msg" and pt == "task_complete":
            ready = None
        elif t == "event_msg" and pt == "item_completed" and (p.get("item") or {}).get("type") == "UserMessage":
            ready = ts
        elif t == "response_item" and pt in _CODEX_OUTPUTS:
            ready = ts
        elif t == "token_usage_record":
            if ready is not None and ready <= ts and ts >= start_ms:
                out.append((ready, ts))
            ready = ts
    return out


def union_ms(spans, lo, hi):
    """时间段裁到 [lo, hi] 后取并集的总长（毫秒）。"""
    total, cur_a, cur_b = 0, None, None
    for a, b in sorted((max(a, lo), min(b, hi)) for a, b in spans):
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


def estimate(agent, start_epoch, end_epoch, paths):
    start_ms, end_ms = int(start_epoch * 1000), int(end_epoch * 1000)
    reader = claude_requests if agent == "claude" else codex_requests
    spans = [s for p in paths for s in reader(p, start_ms)]
    return union_ms(spans, start_ms, end_ms), len(spans)


def main(argv):
    if len(argv) < 3 or argv[0] not in ("claude", "codex"):
        print(__doc__.splitlines()[2], file=sys.stderr)
        return 2
    try:
        start = float(argv[1])
        end = time.time() if argv[2] == "now" else float(argv[2])
    except ValueError:
        return 2
    ms, n = estimate(argv[0], start, end, argv[3:])
    if n:
        # 毫秒精度原样发：会话记录本身就是毫秒，三位小数不丢信息（机器字段不舍入）
        print(f"ai_secs={ms // 1000}.{ms % 1000:03d} ai_requests={n}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
