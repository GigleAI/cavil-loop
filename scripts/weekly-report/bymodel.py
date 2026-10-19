"""目标周按模型拆分：归属规则 + 自检（GitHub#61）。

采集（collect.py）与出报告（report.py）都用这一份：采集侧用它累加，写 data.json 之前自检；
报告侧渲染之前再自检一遍，被改坏或缺行的 data.json 不会被印成一张对不上总数的表。

── 归属规则 ─────────────────────────────────────────────────────────────
按模型拆分**只在现有取数结果上再分一层桶**，取哪份金额 / token、进不进去重合计，全部沿用
collect.py 第二段已经定好的结论，所以各行之和天然等于原总数——自检就是钉住这一点。

    · 本机日志重算过的派工：token 与金额按**每次调用自己的模型**分组（`split_calls`），
      各组分别计价；时长按派工整体归属——只用了一个模型 → 该模型，多个 → 「多模型派工」行。
      **不按 token 比例拆时长**。
    · 其余（沿用原值 / 旧记录估算 / codex 补算）：记录里只写了一个模型、且没有
      `model_unknown=yes` → 整条归该模型；否则整条（时长、token、金额）进
      「未记录模型 / 多模型」行，**不去猜**。
    · 进不了去重合计的派工不进任何一行，照旧单列。

行的身份是 (模型, 侧)：同一个模型两侧都用过就是两行，每行只属于一侧，与现有按 agent
拆分的口径一致、能直接相加。
"""

ITEMS = ("in", "out", "cache_r", "cache_w")

# 两个特殊行。model 字段放这两个占位名，kind 区分开，报告按 kind 出中文名。
MULTI = "(multi-model dispatch)"        # 只有时长：重算过、用了多个模型的派工
UNRECORDED = "(unrecorded / multi)"     # 沿用原值、说不清模型的派工：时长 + token + 金额

# 记录里认不出模型的调用：load_claude_calls 给 "unknown"，与「没写模型」同样对待。
_UNKNOWN_NAMES = {"", "unknown"}

# 自检比对的字段：data.json 里目标周的总数字段 → 行里的字段。
# 时长 / 条数类总数包含进不了去重合计的派工，比对时减掉它们单列的那份。
CHECKS = (
    ("records", "records", "records_not_summable"),
    ("wall", "wall", "wall_not_summable"),
    ("work", "work", "work_not_summable"),
    ("work_records", "work_records", "work_records_not_summable"),
    ("cost", "cost", None),                 # cost / tok_* 总数本来就只含去重合计的部分
    ("tok_in", "tok_in", None),
    ("tok_out", "tok_out", None),
    ("tok_cache_r", "tok_cache_r", None),
    ("tok_cache_w", "tok_cache_w", None),
)


def record_model(rec):
    """沿用原值的那类派工：记录能不能确定唯一模型。能 → 模型名，不能 → None。"""
    ms = rec.get("models") or []
    if len(ms) != 1 or ms[0] in _UNKNOWN_NAMES or rec.get("model_unknown"):
        return None
    return ms[0]


def split_calls(calls, price_table, price_calls):
    """重算过的派工：认领到的调用按各自模型分组 → {模型: {"cost", "tok"}}。

    只收有用量的组（全零的组对拆分没有贡献，留着只会在表里多出一行 0）。
    `price_calls` 由调用方传入（attribute.price_calls），避免这里反向依赖。"""
    groups = {}
    for c in calls:
        m = c.get("model") or "unknown"
        groups.setdefault(m, []).append(c)
    out = {}
    for m, cs in groups.items():
        tok = {k: sum((c.get("tok") or {}).get(k, 0) for c in cs) for k in ITEMS}
        usd = price_calls(cs, price_table)[0]
        if any(tok.values()) or usd:
            out[m] = {"cost": usd, "tok": tok}
    return out


class Acc:
    """目标周的按模型累加器。"""

    def __init__(self):
        self.rows = {}

    def _row(self, kind, model, side):
        key = (kind, model, side)
        r = self.rows.get(key)
        if r is None:
            r = self.rows[key] = {"kind": kind, "model": model, "side": side,
                                  "records": 0, "wall": 0.0, "work": 0.0, "work_records": 0,
                                  "cost": 0.0, **{f"tok_{k}": 0.0 for k in ITEMS}}
        return r

    def add(self, side, rec, wall, work, cost, tok, split=None):
        """一条进得了去重合计的派工。

        split 为 None：沿用原值那一类，整条按记录里的模型归属。
        split 为 dict：重算过的派工，{模型: {"cost", "tok"}}，token / 金额照它拆。
        tok / cost 是这条派工最终计入总数的那份（已乘过历史重复计系数）。"""
        if split is None:
            m = record_model(rec)
            kind, model = ("model", m) if m else ("unrecorded", UNRECORDED)
            r = self._row(kind, model, side)
            r["cost"] += cost
            for k in ITEMS:
                r[f"tok_{k}"] += tok.get(k, 0) or 0
            tr = r
        else:
            named = {m: v for m, v in split.items() if m not in _UNKNOWN_NAMES}
            for m, v in split.items():
                kind, model = ("model", m) if m in named else ("unrecorded", UNRECORDED)
                r = self._row(kind, model, side)
                r["cost"] += v["cost"]
                for k in ITEMS:
                    r[f"tok_{k}"] += v["tok"].get(k, 0)
            if len(split) > 1:
                tr = self._row("multi", MULTI, side)
            elif named:
                tr = self._row("model", next(iter(named)), side)
            elif split:
                tr = self._row("unrecorded", UNRECORDED, side)    # 只有认不出模型的调用
            else:
                # 一次有用量的调用都没认领到（真实零调用）：没有调用证据，按记录归
                m = record_model(rec)
                tr = self._row("model", m, side) if m else self._row("unrecorded", UNRECORDED, side)
        tr["records"] += 1
        tr["wall"] += wall
        if work is not None:
            tr["work"] += work
            tr["work_records"] += 1

    def result(self):
        order = {"model": 0, "multi": 1, "unrecorded": 2}
        return sorted(self.rows.values(),
                      key=lambda r: (order[r["kind"]], -r["cost"], -r["wall"], r["model"], r["side"]))


def check(week, rows):
    """各行之和 = 目标周现有总数。返回对不上的项（空列表 = 通过）。

    week：data.json 里目标周那一格（weekly[target]）；rows：by_model 列表。"""
    bad = []
    for total_f, row_f, ns_f in CHECKS:
        want = float(week.get(total_f, 0) or 0) - (float(week.get(ns_f, 0) or 0) if ns_f else 0)
        got = sum(float(r.get(row_f, 0) or 0) for r in rows)
        if abs(want - got) > 1e-6 * max(1.0, abs(want)):
            bad.append(f"{total_f}: 总数 {want:g}，各模型之和 {got:g}")
    return bad
