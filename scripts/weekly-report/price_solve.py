#!/usr/bin/env python3
"""从本机 CLI 记账反解每个模型的逐项单价，并给出每项的可信状态（GigleTutor-Web#934）。

为什么不是一张手工维护的价目表（issue #934 已确认 Q3=C）：
原来 `scripts/drivers/token-usage/claude.sh` 硬编了一张表，表过期了没人发现——实测那张表
的 Opus 档是当前标价的 **3 倍**，算出来的金额比 CLI 自记高 193%，而且这个错不会报错、
只会让数字悄悄变大。改成运行时反解 + 两道检验，调价时能自己发现。

**两件事必须分开，缺一不可**：

  ① 数值稳定性闸门 —— 只回答「这个系数被这批数据钉得住吗」。
     判据（逐项、两条都过才算稳定）：
       · 观测噪声放大 = 扰动**右端项 b** 后该系数的相对变化 ÷ b 的相对扰动，≤ MAX_AMPLIFY
       · Bootstrap 相对标准差 ≤ MAX_SPREAD
     **不能用的判据**（都踩过）：
       · 整列缩放灵敏度 —— 整列乘 s 只是重参数化，解会正好除以 s、拟合值不变，
         放大倍数恒为 1，跟病态与否无关。
       · 拟合残差 —— 实测残差 0.4% 时 input 仍偏 76%。
       · 列 token 占比、条件数 —— 只作解释与提示，实测真实数据 κ 只有 9 却仍有项不稳定。

  ② 外部参照交叉核对 —— 准确性只能靠它。稳定性**测不出系统性计数误差**：
     合成反例（真实 input=$5/output=$25、观测把 output 记少一半）解出 output=$50、偏 100%，
     却两条闸门全过、残差为零。同类风险真实存在（用量少算是 #935 的主题）。

每项单价因此落到四态之一：
    corroborated    稳定 且 与参照相对偏差 ≤ MAX_DIVERGE          → 用反解值
    uncorroborated  稳定 但没有可比参照（含参照为 0 / 缺失）      → 用反解值，算**候选估算**
    disputed        稳定 但与参照偏差 > MAX_DIVERGE               → 报红；取值按 policy
    unstable        过不了闸门 / 无解 / 非有限值                   → 取值按 policy

取值策略（issue #934 的 Q7，人工已确认 A）：
    A（默认）：disputed 用参照值；unstable 有参照用参照值、**没有参照就是未知**。
    B：只有 corroborated 出价，其余三态一律未知。
两个策略都**不改变**「以本机反解为主」这一点，参照只承担兜底与交叉核对。

⚠️ 阈值都是**操作阈值，不是真实误差保证**。标定依据见各常量旁的注释。
⚠️ 「与参照一致」只说明**和这份参照一致**，不等于已证明为真值——参照本身可能过期，
   那样两边会一起错，这套机制发现不了。所以报告要带上参照的来源与缓存日期。

用法：
    python3 price_solve.py --table          # 输出给 driver 用的 JSON 价目表
    python3 price_solve.py --report         # 人读：逐项状态与闸门指标
    python3 price_solve.py --table --policy B
    环境变量 CLAUDE_PROJECTS_DIR 可覆盖 transcript 目录（测试用）。
"""
import argparse, json, glob, math, os, random, statistics, sys

# ── 阈值（可配置；标定依据写在旁边，别改成拍脑袋的数）────────────────────────
MAX_AMPLIFY = float(os.environ.get("PRICE_MAX_AMPLIFY", "5"))
# 标定：本机实测 cache_read / cache_write 的放大倍数 1.07×（真实偏离 0.8% / 1.5%），
# output 6.8×（偏 7.9%）、input 411×（偏 76.5%）。5 落在 1.07 与 6.8 之间。
MAX_SPREAD = float(os.environ.get("PRICE_MAX_SPREAD", "0.05"))
# 标定：同一批数据 cache 两项 bootstrap 相对标准差 0.4% / 0.5%，input 160%。
MAX_DIVERGE = float(os.environ.get("PRICE_MAX_DIVERGE", "0.10"))
# 标定：本机已观测到的正常偏差 ≤ 1.5%（modelUsage 只给 cache 写入合计等口径差），
# 而真实价目故障量级大得多——「表过期」这次是 200%，参照表里最小的代际档位差也有 33%
# （Sonnet 4.6 $3 → Sonnet 5 $2）。10% 落在两者之间且远离两侧。
MIN_SESSIONS = int(os.environ.get("PRICE_MIN_SESSIONS", "8"))
BOOTSTRAP_N = int(os.environ.get("PRICE_BOOTSTRAP_N", "200"))
NOISE = float(os.environ.get("PRICE_NOISE", "0.001"))
SEED = int(os.environ.get("PRICE_SEED", "7"))

ITEMS = ("input", "output", "cache_read", "cache_write")

# ── 外部参照（只作兜底 + 交叉核对，不是真值）──────────────────────────────
# 来源：本地 claude-api 参考资料的 Current Models 表，文件自带缓存日期 2026-06-24。
# https://www.anthropic.com/pricing 未联网核验。倍率：cache 读 0.1×、写 5m 1.25×、1h 2×。
REFERENCE_SOURCE = "claude-api reference (Current Models), cached 2026-06-24; anthropic.com/pricing not fetched"
def _ref(inp, out):
    return dict(input=inp, output=out, cache_read=inp * 0.1,
                cache_write_5m=inp * 1.25, cache_write_1h=inp * 2.0)
REFERENCE = {
    "claude-opus-5":     _ref(5, 25),
    "claude-opus-4-8":   _ref(5, 25),
    "claude-opus-4-7":   _ref(5, 25),
    "claude-opus-4-6":   _ref(5, 25),
    "claude-sonnet-5":   _ref(2, 10),
    "claude-sonnet-4-6": _ref(3, 15),
    "claude-haiku-4-5":  _ref(1, 5),
    "claude-fable-5":    _ref(10, 50),
    "claude-fable-5-1":  _ref(10, 50),
}
# 快速模式是同一模型的另一档价（Opus 5 fast $10/$50），本机 0 条流量、无法反解。
REFERENCE_FAST = {"claude-opus-5": _ref(10, 50), "claude-opus-4-8": _ref(10, 50)}


def norm_model(m):
    """CLI 记账键带 [1m] 这类后缀，用量记录里的 message.model 没有。实测两者单价相同。"""
    return (m or "").split("[")[0]


def _solve(A, b):
    """正规方程 + 全选主元高斯消元。奇异或出现非有限值时返回 None。"""
    m = len(A[0])
    M = [[sum(A[k][i] * A[k][j] for k in range(len(A))) for j in range(m)]
         + [sum(A[k][i] * b[k] for k in range(len(A)))] for i in range(m)]
    for i in range(m):
        p = max(range(i, m), key=lambda r: abs(M[r][i]))
        M[i], M[p] = M[p], M[i]
        if abs(M[i][i]) < 1e-300:
            return None
        for r in range(m):
            if r != i:
                f = M[r][i] / M[i][i]
                for c in range(i, m + 1):
                    M[r][c] -= f * M[i][c]
    x = [M[i][m] / M[i][i] for i in range(m)]
    return None if any(not math.isfinite(v) for v in x) else x


def load_samples(projects_dir=None):
    """{model: [(input, output, cache_read, cache_write, costUSD), ...]}，只收单模型会话。

    多模型会话的 totalCostUSD 拆不回每个模型，收进来只会污染方程组。
    另外统计每个模型本机 cache 写入的 5m / 1h 构成，用来判断两档能不能分开。
    """
    base = projects_dir or os.environ.get("CLAUDE_PROJECTS_DIR") \
        or os.path.expanduser("~/.claude/projects")
    rows, ttl = {}, {}
    for f in glob.glob(os.path.join(base, "*", "*.jsonl")):
        last = None
        w5 = w1 = 0
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"cost-state"' not in line and '"assistant"' not in line:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                t = r.get("type")
                if t == "cost-state" and r.get("modelUsage"):
                    last = r
                elif t == "assistant":
                    cc = ((r.get("message") or {}).get("usage") or {}).get("cache_creation") or {}
                    w5 += cc.get("ephemeral_5m_input_tokens") or 0
                    w1 += cc.get("ephemeral_1h_input_tokens") or 0
        if not last or len(last["modelUsage"]) != 1:
            continue
        cost = last.get("totalCostUSD") or 0
        if cost < 0.05:          # 太小的会话噪声占比过大，进方程只添乱
            continue
        key, mu = list(last["modelUsage"].items())[0]
        key = norm_model(key)
        rows.setdefault(key, []).append((
            mu.get("inputTokens", 0) / 1e6, mu.get("outputTokens", 0) / 1e6,
            mu.get("cacheReadInputTokens", 0) / 1e6, mu.get("cacheCreationInputTokens", 0) / 1e6,
            cost))
        d = ttl.setdefault(key, {"w5": 0, "w1": 0})
        d["w5"] += w5
        d["w1"] += w1
    return rows, ttl


def gate(samples):
    """逐项跑①数值稳定性闸门。返回 {item: {...metrics, stable}}；样本不够时全判不稳定。"""
    n = len(samples)
    out = {it: {"price": None, "amplify": None, "spread": None, "stable": False,
                "share": None, "n": n} for it in ITEMS}
    if n < MIN_SESSIONS:
        for it in ITEMS:
            out[it]["reason"] = f"样本不足（{n} < {MIN_SESSIONS}）"
        return out, None
    A = [list(r[:4]) for r in samples]
    b = [r[4] for r in samples]
    x0 = _solve(A, b)
    if x0 is None:
        for it in ITEMS:
            out[it]["reason"] = "方程组奇异或解非有限值"
        return out, None
    total = sum(sum(r) for r in A) or 1.0
    rnd = random.Random(SEED)
    amps = [[] for _ in ITEMS]
    for _ in range(BOOTSTRAP_N):                       # ② 扰动右端项 b（不是列）
        x = _solve(A, [v * (1 + rnd.gauss(0, NOISE)) for v in b])
        if x is None:
            continue
        for j in range(len(ITEMS)):
            if abs(x0[j]) > 1e-12:
                amps[j].append(abs(x[j] - x0[j]) / abs(x0[j]) / NOISE)
    boots = [[] for _ in ITEMS]
    for _ in range(BOOTSTRAP_N):                       # ③ bootstrap 重采样
        idx = [rnd.randrange(n) for _ in range(n)]
        x = _solve([A[i] for i in idx], [b[i] for i in idx])
        if x is None:
            continue
        for j in range(len(ITEMS)):
            boots[j].append(x[j])
    for j, it in enumerate(ITEMS):
        amp = statistics.median(amps[j]) if amps[j] else float("inf")
        spread = (statistics.pstdev(boots[j]) / abs(x0[j])
                  if boots[j] and abs(x0[j]) > 1e-12 else float("inf"))
        col = sum(r[j] for r in A)
        out[it].update(price=x0[j], amplify=amp, spread=spread, share=col / total,
                       stable=(math.isfinite(amp) and math.isfinite(spread)
                               and amp <= MAX_AMPLIFY and spread <= MAX_SPREAD
                               and x0[j] > 0))
        if not out[it]["stable"]:
            out[it]["reason"] = f"放大 {amp:.2f}× / 离散 {spread * 100:.1f}%"
    return out, x0


def classify(model, gated, ttl, policy="A"):
    """②外部参照交叉核对 → 四态 + 最终取值。cache 写入按本机 5m/1h 构成拆成两档。"""
    ref = REFERENCE.get(model, {})
    res = {}

    def decide(item, solved, stable, ref_price, note=""):
        rel = None
        if not stable:
            status = "unstable"
        elif ref_price is None or ref_price == 0:
            status = "uncorroborated"       # 有解但无从核对（含参照为 0 / 缺失）
        else:
            rel = abs(solved - ref_price) / ref_price
            status = "corroborated" if rel <= MAX_DIVERGE else "disputed"
        if status == "corroborated" or status == "uncorroborated":
            price = solved
        elif status == "disputed":
            price = ref_price if policy == "A" else None
        else:                                # unstable：A 有参照才兜底，没有就是未知
            price = ref_price if (policy == "A" and ref_price) else None
        return {"status": status, "price": price, "solved": solved,
                "reference": ref_price, "divergence": rel, "note": note}

    for it in ("input", "output", "cache_read"):
        g = gated[it]
        res[it] = decide(it, g["price"], g["stable"], ref.get(it), g.get("reason", ""))
        res[it]["metrics"] = {k: g[k] for k in ("amplify", "spread", "share", "n")}

    # cache 写入：CLI 记账只给合计。本机某一档恒为 0 时另一档才可解；两档都非零就分不开。
    g = gated["cache_write"]
    w5, w1 = ttl.get("w5", 0), ttl.get("w1", 0)
    both = w5 > 0 and w1 > 0
    for tier, mine in (("cache_write_5m", w5), ("cache_write_1h", w1)):
        stable = g["stable"] and not both and mine > 0
        r = decide(tier, g["price"], stable, ref.get(tier),
                   "两档都有用量，合计里分不开" if both else g.get("reason", ""))
        r["metrics"] = {k: g[k] for k in ("amplify", "spread", "share", "n")}
        res[tier] = r
    return res


def build(policy="A", projects_dir=None):
    rows, ttl = load_samples(projects_dir)
    table = {}
    for model, samples in sorted(rows.items()):
        gated, _ = gate(samples)
        table[model] = classify(model, gated, ttl.get(model, {}), policy)
    # 本机没跑过的模型：没有反解依据，按 policy 决定是否用参照兜底
    for model, ref in sorted(REFERENCE.items()):
        if model in table:
            continue
        table[model] = {it: {"status": "unstable", "price": (ref[it] if policy == "A" else None),
                             "solved": None, "reference": ref[it], "divergence": None,
                             "note": "本机无该模型流量", "metrics": {}}
                        for it in ref}
    return {"policy": policy, "reference_source": REFERENCE_SOURCE,
            "thresholds": {"max_amplify": MAX_AMPLIFY, "max_spread": MAX_SPREAD,
                           "max_diverge": MAX_DIVERGE, "min_sessions": MIN_SESSIONS},
            "fast": {m: v for m, v in REFERENCE_FAST.items()},
            "models": table}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--table", action="store_true", help="输出 JSON 价目表（给 driver）")
    ap.add_argument("--report", action="store_true", help="人读的逐项状态")
    ap.add_argument("--policy", default=os.environ.get("PRICE_POLICY", "A"), choices=["A", "B"])
    a = ap.parse_args()
    t = build(a.policy)
    if a.report or not a.table:
        print(f"参照来源：{t['reference_source']}")
        print(f"阈值：{t['thresholds']}  ·  取值策略 {t['policy']}\n")
        for model, items in t["models"].items():
            solved_any = any(v.get("solved") is not None for v in items.values())
            if not solved_any and not a.report:
                continue
            print(f"{model}")
            for it, v in items.items():
                m = v.get("metrics") or {}
                amp = f"{m['amplify']:.2f}×" if m.get("amplify") is not None else "—"
                sp = f"{m['spread'] * 100:.1f}%" if m.get("spread") is not None else "—"
                dv = f"{v['divergence'] * 100:.1f}%" if v.get("divergence") is not None else "—"
                pr = f"${v['price']:.4f}" if v.get("price") is not None else "未知"
                print(f"  {it:<16} {v['status']:<15} 取值 {pr:<10} 放大 {amp:<9} 离散 {sp:<8} 与参照差 {dv}")
            print()
    if a.table:
        json.dump(t, sys.stdout, ensure_ascii=False)
        print()


if __name__ == "__main__":
    main()
