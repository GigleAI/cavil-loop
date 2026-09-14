#!/usr/bin/env python3
"""价目对账：把本机算出来的金额跟 CLI 自己记的账比一比（GigleTutor-Web#934）。

**没有按 token 出的账单可对**——本机两侧都是包月订阅，所以「对账」的参照物是
Claude CLI 自己在 transcript 里落的 `cost-state`（它按官方价目算的每模型金额），
再加上官方公开价目表。**CLI 相符不等于真实账单相符**。

两个度量互相独立，不能合称「逐条对得上」：

  M1  只测**价目表**对不对。输入 = `cost-state.modelUsage[<model>]` 里 CLI 自己记的
      四个 token 数，乘我们的单价，对照同一条 `totalCostUSD`。分子分母用同一份 token，
      所以不含 token 统计误差。
      假设：`modelUsage` 只给 cache 写入**合计**、不分 5m/1h；本机实测 5m 恒为 0，
      故按 1h 档计价。若某部署用 5m 缓存，这个方法要改用带档位的原始 usage。

  M2  **端到端**：价目表 + 调用级归组 + 范围截齐。输入 = transcript 里的
      `message.usage`，按 `requestId` 归组后取一份，再截到
      `[cost-state.startTime, 末份快照锚定时刻]`。
      ⚠️ 范围必须截齐：会话被 resume / fork 时，文件里带着**上一段会话**的历史记录，
      而 `cost-state` 只算本段会话。不截齐会把继承来的历史算进分母（实测本机 106 个
      会话里 17 个有这种记录、占全部调用的 17.2%），得出的偏差完全是假的。

比值方向统一为 `本口径算出 / CLI自记`，**> 1 表示我们算高了**。

用法：python3 reconcile.py            # 人读
      python3 reconcile.py --json     # 机器可读
"""
import argparse, datetime, glob, json, os, statistics, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import price_solve


def _iso(t):
    try:
        return datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
    except Exception:
        return None


def collect(projects_dir=None):
    base = projects_dir or os.environ.get("CLAUDE_PROJECTS_DIR") \
        or os.path.expanduser("~/.claude/projects")
    rows = []
    for f in glob.glob(os.path.join(base, "*", "*.jsonl")):
        last = anchor = last_anchor = None
        recs = []
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
                t = r.get("type")
                if t == "cost-state":
                    if r.get("modelUsage"):
                        last, last_anchor = r, anchor
                else:
                    if r.get("timestamp"):
                        d = _iso(r["timestamp"])
                        if d:
                            anchor = d
                    if t == "assistant" and (r.get("message") or {}).get("usage"):
                        recs.append(r)
        if not last or len(last["modelUsage"]) != 1 or (last.get("totalCostUSD") or 0) < 0.05:
            continue
        if not last_anchor or not last.get("startTime"):
            continue
        lo = datetime.datetime.fromtimestamp(last["startTime"] / 1000, datetime.timezone.utc)
        hi = last_anchor
        groups = {}
        for i, r in enumerate(recs):                    # ① 先按 requestId 归组
            rid = r.get("requestId") or f"__norid_{i}"
            d = _iso(r.get("timestamp") or "")
            g = groups.setdefault(rid, {"t": d, "u": r["message"]["usage"],
                                        "m": (r.get("message") or {}).get("model")})
            if d and (g["t"] is None or d < g["t"]):
                g["t"] = d
        inr, head, tail = [], 0, 0
        for g in groups.values():                       # ② 再按范围截齐
            if g["t"] is None or g["t"] < lo:
                head += 1
            elif g["t"] > hi:
                tail += 1
            else:
                inr.append(g)
        mk, mu = list(last["modelUsage"].items())[0]
        rows.append({"model": price_solve.norm_model(mk), "cost": last["totalCostUSD"],
                     "mu": mu, "calls": inr, "head": head, "tail": tail,
                     "total_calls": len(groups)})
    return rows


def price_mu(mu, entry):
    """M1：用 modelUsage 自己的 token 数计价（cache 写入按 1h 档）。缺单价返回 None。"""
    items = {"input": mu.get("inputTokens", 0), "output": mu.get("outputTokens", 0),
             "cache_read": mu.get("cacheReadInputTokens", 0),
             "cache_write_1h": mu.get("cacheCreationInputTokens", 0)}
    usd = 0.0
    for k, tok in items.items():
        p = (entry.get(k) or {}).get("price")
        if p is None:
            return None
        usd += tok * p / 1e6
    return usd


def dist(vals):
    v = sorted(vals)
    if not v:
        return None
    return {"n": len(v), "median": statistics.median(v),
            "p10": v[int(len(v) * .1)], "p90": v[int(len(v) * .9)],
            "min": v[0], "max": v[-1]}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    table = price_solve.build_cached("A")
    rows = collect()
    import attribute
    m1, m2, cli = [], [], 0.0
    s1 = s2 = 0.0
    for r in rows:
        entry = (table.get("models") or {}).get(r["model"]) or {}
        cli += r["cost"]
        v1 = price_mu(r["mu"], entry)
        if v1:
            m1.append(v1 / r["cost"]); s1 += v1
        calls = [{"model": price_solve.norm_model(c["m"]), "speed": (c["u"].get("speed") or "standard"),
                  "priced": {"input": c["u"].get("input_tokens") or 0,
                             "output": c["u"].get("output_tokens") or 0,
                             "cache_read": c["u"].get("cache_read_input_tokens") or 0,
                             "cache_write_5m": (c["u"].get("cache_creation") or {}).get("ephemeral_5m_input_tokens") or 0,
                             "cache_write_1h": (c["u"].get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0}}
                 for c in r["calls"]]
        v2, _unk, _st = attribute.price_calls(calls, table)
        if v2:
            m2.append(v2 / r["cost"]); s2 += v2
    tot = sum(r["total_calls"] for r in rows) or 1
    out = {"samples": len(rows), "cli_total": cli,
           "m1": {"dist": dist(m1), "total": s1},
           "m2": {"dist": dist(m2), "total": s2},
           "out_of_range": {"head": sum(r["head"] for r in rows),
                            "tail": sum(r["tail"] for r in rows),
                            "head_pct": sum(r["head"] for r in rows) / tot * 100},
           "models": sorted({r["model"] for r in rows}),
           "reference_source": table.get("reference_source")}
    if a.json:
        json.dump(out, sys.stdout, ensure_ascii=False, indent=1); print()
        return
    print(f"样本：{out['samples']} 个单模型会话；模型 = {out['models']}")
    print(f"CLI 自记金额合计 ${cli:,.2f}")
    print(f"参照来源：{out['reference_source']}\n")
    for name, d, s, note in (("M1 只验价目表", out["m1"]["dist"], s1, "分子分母同一份 token"),
                             ("M2 端到端", out["m2"]["dist"], s2, "调用级归组 + 范围截齐")):
        if not d:
            print(f"{name}：没有可比样本"); continue
        print(f"{name}（{note}）—— 比值 = 本口径算出 / CLI自记")
        print(f"  n={d['n']}  中位={d['median']:.4f}  p10={d['p10']:.4f}  p90={d['p90']:.4f}  "
              f"最小={d['min']:.4f}  最大={d['max']:.4f}")
        print(f"  合计 ${s:,.0f} vs CLI ${cli:,.0f}（{(s / cli - 1) * 100:+.2f}%）\n")
    o = out["out_of_range"]
    print(f"范围外（不进比值，如实报出）：早于会话起点 {o['head']:,} 次调用（{o['head_pct']:.1f}%，"
          f"resume/fork 带进来的历史）、晚于末份快照 {o['tail']:,} 次")


if __name__ == "__main__":
    main()
