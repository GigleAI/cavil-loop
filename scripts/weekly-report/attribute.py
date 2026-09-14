#!/usr/bin/env python3
"""把本机日志里的 API 调用**唯一**认领给派工，并判断哪些金额可以相加（GigleTutor-Web#934）。

驱动写 footer 时只拿得到自己的 start，看不见别的派工的窗口，所以跨派工的重叠只能在
这一侧消解。这里做三步，**顺序不能颠倒，也不能互相依赖**：

    ① 调用认领   —— 每次调用归给唯一一个派工
    ② 逐派工取值 —— 通过日志检验就用重算值，否则用记录里的原值
    ③ 合计取舍   —— 最后按重叠组决定哪些能进「去重合计」

②**不看**组的状态，③才用②的结果；写成「组能进合计才重算」会成环。

── ① 认领规则 ───────────────────────────────────────────────────────────
候选窗口要**同时**满足三条：
    · agent 相同 —— 调用的 agent 由**日志来源**决定（~/.claude → claude，~/.codex → codex）；
      记录的 agent 取 rec["agent"]，历史记录缺这个字段时复用采集侧既有默认值 "claude"。
      ⚠️ 派工身份是 (worktree, 开始时刻)、**不含 agent**（见 record.dispatch_key），
      所以不加这条过滤，Claude 的调用会被记到同 worktree 的 codex 派工头上。
    · worktree 相同
    · start ≤ 规范时刻 < end（**半开**区间）
命中多个候选时取 **start 最晚**的那个；一个都没有 → 记为**未归属**，按 (worktree, agent)
汇总报出，**不摊给任何派工**。

── ② 日志检验（只证伪，证明不了完整）─────────────────────────────────────
拿记录里写的 token R 与重算得到的 T 比：
    · 日志不存在 / 读不出 / 可解析记录为 0 且 R 非全零 → unknown
    · R 全零且 T 全零                                   → true_zero
    · **逐项**比较 T + X 与 R（四项都比）任一项不足      → shortfall_detected
    · 否则                                              → no_shortfall_detected
`X` = 落在本派工窗口内、但**实际被同 agent 其他派工认领走**的调用的 token 合计。
⚠️ 缺口必须由 X 这种**逐条可列举的证据**解释，**不能**因为「窗口跟别人相交」就推定：
   A=[0,20)、B=[10,15)，A 的调用在 t=2 与 t=17（重叠区里一个都没有），删掉 t=2 所在
   文件后 X=0，缺口没人认领 —— 这种必须判 shortfall。
⚠️ 「比得过」只说明**未检出缺失**，证明不了日志完整：记录里的 R 本身就可能没看全，
   footer 之后新增的调用也可能把被删调用的 token 补上。全文不写「覆盖完整」。

历史记录（无机器标记）的 token 是 driver 的 fmt **floor 截断**过的，所以按**截断下界**比：
    "53.5k" ⇒ floor(x/100)==535 ⇒ x ≥ 53500（**不是** 53450）
    "4.8m"  ⇒ floor(x/100000)==48 ⇒ x ≥ 4800000
这类记录在报告里标「截断下界检验」，证据强度低于新格式。

── ③ 合计取舍 ───────────────────────────────────────────────────────────
在每个 (worktree, agent) 内把窗口互相重叠的派工按连通关系分组：
    · 组里只有它自己            → 进「去重合计」，**不论**取的是重算值还是原值
    · 组内每一条都用了重算值    → 整组进（认领已把调用划分给唯一一条）
    · 其余                      → **整组不进合计**，单列披露、注明不可相加
⚠️ 不能把原值和重算值直接相加：两条窗口重叠的派工，一条回退 footer、一条用重算值时，
   它们共用的那次调用会被算两遍（实测反例：真实 $2 被算成 $3）。
⚠️ 也**不能**从原值里扣掉 X —— footer 是驱动按自己窗口、自己那套价目算的累计值，
   价目、精度与计入范围都和重算不一致，逐调用拆不开。
"""
import datetime, glob, json, os, re

ITEMS = ("in", "out", "cache_r", "cache_w")

# 人读 token 行：`84 input, 53.5k output, 4.8m cache read, 166.7k cache write`
_RE_TOK = re.compile(r"([\d.]+)([km]?)\s+(input|output|cache read|cache write)")
_LABEL = {"input": "in", "output": "out", "cache read": "cache_r", "cache write": "cache_w"}


def floor_lower_bound(text, unit):
    """driver 的 fmt 是 floor 截断，不是四舍五入。给出该显示值对应的**真实值下界**。

    fmt: >=1e6 → (x/100000|floor)/10 + "m"；>=1e3 → (x/100|floor)/10 + "k"；否则 floor。
    所以 "53.5k" 的下界是 53500、"4.8m" 是 4800000、"84" 是 84。
    """
    v = float(text)
    if unit == "m":
        return int(round(v * 10)) * 100000
    if unit == "k":
        return int(round(v * 10)) * 100
    return int(v)


def parse_token_line(line):
    """历史记账行紧随其后的 token 行 → {项: 截断下界}；解析不出返回 None。"""
    out = {}
    for num, unit, label in _RE_TOK.findall(line or ""):
        out[_LABEL[label]] = floor_lower_bound(num, unit)
    return out or None


def claim(calls, windows):
    """① 认领。calls: [{t, agent, wt, tok}]；windows: [{key, agent, wt, start, end}]。

    返回 (claimed, unattributed)：
        claimed       {key: {"tok": 合计, "n": 条数}}
        unattributed  {(wt, agent): {"tok": 合计, "n": 条数}}
    另外给每个窗口算出 X（落在它窗口内但被别人认领走的 token 合计）。
    """
    by_owner = {w["key"]: {"tok": {k: 0 for k in ITEMS}, "n": 0} for w in windows}
    foreign = {w["key"]: {"tok": {k: 0 for k in ITEMS}, "n": 0} for w in windows}
    unattr = {}
    for c in calls:
        cands = [w for w in windows
                 if w["agent"] == c["agent"] and w["wt"] == c["wt"]
                 and w["start"] <= c["t"] < w["end"]]
        if not cands:
            d = unattr.setdefault((c["wt"], c["agent"]),
                                  {"tok": {k: 0 for k in ITEMS}, "n": 0})
            for k in ITEMS:
                d["tok"][k] += c["tok"].get(k, 0)
            d["n"] += 1
            continue
        owner = max(cands, key=lambda w: w["start"])       # start 最晚的那个
        by_owner[owner["key"]]["n"] += 1
        for k in ITEMS:
            by_owner[owner["key"]]["tok"][k] += c["tok"].get(k, 0)
        for w in cands:                                     # 被别人拿走的，记进 X
            if w["key"] != owner["key"]:
                foreign[w["key"]]["n"] += 1
                for k in ITEMS:
                    foreign[w["key"]]["tok"][k] += c["tok"].get(k, 0)
    return by_owner, foreign, unattr


def log_check(recorded, claimed_tok, foreign_tok, has_log, parsed_records):
    """② 日志检验。recorded 为 None 表示记录里没有可比的 token。"""
    if not has_log or parsed_records == 0:
        if recorded and any(recorded.get(k, 0) > 0 for k in ITEMS):
            return "unknown"
        if not has_log:
            return "unknown"
    if recorded is None:
        return "unknown"
    tot_r = sum(recorded.get(k, 0) for k in ITEMS)
    tot_t = sum(claimed_tok.get(k, 0) for k in ITEMS)
    if tot_r == 0 and tot_t == 0:
        return "true_zero"
    for k in ITEMS:                     # 四项都比，任一项不足就是确证缺失
        if claimed_tok.get(k, 0) + foreign_tok.get(k, 0) < recorded.get(k, 0):
            return "shortfall_detected"
    return "no_shortfall_detected"


def overlap_groups(windows):
    """③ 分组：同 (wt, agent) 内按窗口相交做连通分量。返回 {key: group_id}。"""
    groups = {}
    for (wt, agent) in {(w["wt"], w["agent"]) for w in windows}:
        ws = sorted([w for w in windows if w["wt"] == wt and w["agent"] == agent],
                    key=lambda w: w["start"])
        gid, reach = None, None
        for w in ws:
            if gid is None or w["start"] >= reach:          # 与前一组不相交 → 新开一组
                gid = f"{wt}/{agent}/{len(groups)}"
                reach = w["end"]
            else:
                reach = max(reach, w["end"])
            groups[w["key"]] = gid
    return groups


def summable(windows, sources):
    """哪些派工能进「去重合计」。sources: {key: "recomputed" | "original"}。"""
    gid = overlap_groups(windows)
    members = {}
    for w in windows:
        members.setdefault(gid[w["key"]], []).append(w["key"])
    ok = {}
    for g, keys in members.items():
        if len(keys) == 1:
            ok[keys[0]] = True                               # 孤立派工：没人共享它的调用
        else:
            allrec = all(sources.get(k) == "recomputed" for k in keys)
            for k in keys:
                ok[k] = allrec                               # 含回退 → 整组不进合计
    return ok, gid


# ── 日志加载（claude / codex 两侧；测试可用 CLAUDE_PROJECTS_DIR / CODEX_SESSIONS_DIR 改路径）──
def _iso(t):
    try:
        return datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
    except Exception:
        return None


def load_claude_calls(worktree, tz=None):
    """该 worktree 的全部会话文件 → 调用列表（按 requestId 归组，规范时刻取组内最早）。"""
    base = os.environ.get("CLAUDE_PROJECTS_DIR") or os.path.expanduser("~/.claude/projects")
    enc = worktree.replace("/", "-")
    files = glob.glob(os.path.join(base, enc, "*.jsonl"))
    groups, parsed, bad = {}, 0, 0
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
                    r = json.loads(line)
                except ValueError:
                    bad += 1
                    continue
                if r.get("type") != "assistant":
                    continue
                u = (r.get("message") or {}).get("usage")
                if not u:
                    continue
                parsed += 1
                rid = r.get("requestId") or f"__norid_{f}:{r.get('uuid')}"
                t = _iso(r.get("timestamp") or "")
                cc = u.get("cache_creation") or {}
                tok = {"in": u.get("input_tokens") or 0,
                       "out": u.get("output_tokens") or 0,
                       "cache_r": u.get("cache_read_input_tokens") or 0,
                       "cache_w": (cc.get("ephemeral_5m_input_tokens") or 0)
                                  + (cc.get("ephemeral_1h_input_tokens") or 0)}
                g = groups.get(rid)
                if g is None:
                    groups[rid] = {"t": t, "tok": tok, "agent": "claude", "wt": worktree}
                elif t and (g["t"] is None or t < g["t"]):
                    g["t"] = t
    calls = [g for g in groups.values() if g["t"] is not None]
    if tz:
        for c in calls:
            c["t"] = c["t"].astimezone(tz)
    return calls, {"files": len(files), "parsed": parsed, "bad_lines": bad}
