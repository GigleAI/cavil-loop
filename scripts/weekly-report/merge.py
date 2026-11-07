#!/usr/bin/env python3
"""把几个仓库各自采好的数据合成一份周报数据（GitHub#232）。

为什么只在结果层合并：采数链里的派工认领、调用归属、重叠组能否相加、处理时长归属都只按
issue 号分组（`record.dispatch_key` / `attribute.owner` / `worktime.claim`）。两个仓库都有
#42 时，把两边的评论和日志塞进同一次采数就会串账。所以每个仓库先**各自**用 collect.py
走完整条链（只读它自己的 GitHub 数据和它自己 worktree 下的日志），这里只碰结果。

用法：
    python3 merge.py --out data.json --primary main.json extra1.json [extra2.json ...]

每个字段都在下面**逐项声明**合并方式；遇到没声明的字段直接报错退出——以后 collect.py
加了字段却忘了在这里声明，会当场失败，不会被静默丢掉、也不会按错的方式合进去。

合并后自检（不通过就报错退出，不写输出）：
    · 每周每个相加字段 = 各份之和
    · 中位数 = 对合并后的原始时长列表重算的值（不是各仓库中位数的平均）
    · 按模型拆分各行之和 = 合并后本周总数（与采集、出报告同一个 bymodel.check）
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bymodel      # noqa: E402  按模型拆分的自检（采集 / 出报告 / 合并共用一份）

# ── 每周格子里的字段 ──────────────────────────────────────────────────
# 相加：计数、时长、金额、token、条数、可信度分桶、周末存量。
WEEKLY_SUM = (
    "iss_open", "iss_closed", "pr_open", "pr_merged", "comments", "human", "bot",
    "wall", "work", "cost", "out", "commits", "add", "del",
    "records", "dupes", "footers", "cost_footers", "long_windows", "long_turns",
    "work_records", "work_missing", "work_in_progress", "codex", "backlog",
    "wall_claude", "wall_codex", "cost_claude", "cost_codex",
    "work_claude", "work_codex", "records_claude", "records_codex",
    "cost_records", "cost_records_claude", "cost_records_codex",
    "src_recomputed", "src_original", "src_estimated", "src_repriced",
    "tok_in", "tok_out", "tok_cache_r", "tok_cache_w",
    "tok_in_claude", "tok_out_claude", "tok_cache_r_claude", "tok_cache_w_claude",
    "tok_in_codex", "tok_out_codex", "tok_cache_r_codex", "tok_cache_w_codex",
    "tok_in_not_summable", "tok_out_not_summable",
    "tok_cache_r_not_summable", "tok_cache_w_not_summable",
    "state_full", "state_partial", "state_none",
    "log_no_shortfall_detected", "log_shortfall_detected", "log_unknown", "log_true_zero",
    "cost_not_summable", "records_not_summable",
    "wall_not_summable", "work_not_summable", "work_records_not_summable",
    "price_usd_corroborated", "price_usd_uncorroborated",
    "price_usd_disputed", "price_usd_unstable",
    "price_usd_reference_only", "price_usd_unrated", "price_usd_estimated",
    "price_usd_fetched", "price_usd_disputed_fetched",
    "price_src_solved", "price_src_configured", "price_src_default", "price_src_estimated",
    "price_stale_records",
)
# 重算：派工总耗时中位数（分钟），用拼接后的原始时长按 collect.py 的同一个公式重算。
WEEKLY_MEDIAN = ("sess_med",)

# ── 顶层字段 ──────────────────────────────────────────────────────────
#   same     各份必须相同（同一个统计窗口、同一台机器的同一份价目缓存），不同就报错
#   primary  取主仓库那份
#   concat   列表拼接，每行加上 repo
#   per_repo 每个仓库各留一份
#   special  下面单独处理
TOP = {
    "repo": "primary",
    "generated_at": "primary",
    "price_reference": "same",
    "target_week": "same",
    "weeks": "same",
    "switch_week": "per_repo",
    "long_windows": "concat",
    "long_turns": "concat",
    "work_unattributed": "concat",
    "by_model": "concat",
    "detail": "concat",
    "loose_prs": "concat",
    "weekly": "special",
    "durations": "special",
    "strict": "special",
}


class MergeError(Exception):
    pass


def median_min(ds):
    """与 collect.py 写 `sess_med` 的公式一字不差：排序后取下标 len//2，换成分钟。"""
    ds = sorted(ds)
    return (ds[len(ds) // 2] / 60) if ds else 0


def _check_declared(name, D):
    if D.get("strict") is not True:
        raise MergeError(f"{name}：不是严格采数产出的数据（缺严格采数标记）。"
                         "合并只收严格模式的结果，读失败被当成零数据的那种不能合进来")
    for k in D:
        if k not in TOP:
            raise MergeError(f"{name}：顶层字段 `{k}` 没有声明合并方式（见 merge.py 的 TOP）")
    for k in TOP:
        if k not in D:
            raise MergeError(f"{name}：缺字段 `{k}`")
    declared = set(WEEKLY_SUM) | set(WEEKLY_MEDIAN)
    for w, cell in D["weekly"].items():
        for f in cell:
            if f not in declared:
                raise MergeError(f"{name}：每周字段 `{f}`（{w}）没有声明合并方式"
                                 "（见 merge.py 的 WEEKLY_SUM / WEEKLY_MEDIAN）")
        for f in declared:
            if f not in cell:
                raise MergeError(f"{name}：每周字段 `{f}`（{w}）缺失")
    if set(D["durations"]) != set(D["weeks"]):
        raise MergeError(f"{name}：原始时长列表的周与统计窗口对不上")


def merge(parts):
    """parts: [(文件名, data)]，第一份是主仓库。返回合并后的 data。"""
    if len(parts) < 2:
        raise MergeError("至少要两份数据（主仓库 + 至少一个附加仓库）")
    for name, D in parts:
        _check_declared(name, D)
    repos = [D["repo"] for _, D in parts]
    if len(set(repos)) != len(repos):
        raise MergeError(f"同一个仓库出现了不止一次：{repos}（会重复计数）")
    P = parts[0][1]
    for name, D in parts[1:]:
        for k, how in TOP.items():
            if how == "same" and D[k] != P[k]:
                raise MergeError(f"{name}：`{k}` 与主仓库不同（{D[k]!r} ≠ {P[k]!r}），"
                                 "几份数据不是同一个统计窗口 / 同一份价目，不能相加")

    out = {}
    for k, how in TOP.items():
        if how in ("primary", "same"):
            out[k] = P[k]
        elif how == "concat":
            out[k] = [{**row, "repo": D["repo"]} for _, D in parts for row in D[k]]
        elif how == "per_repo":
            pass                                   # 下面统一写
    weeks = P["weeks"]
    out["weekly"] = {}
    out["durations"] = {}
    for w in weeks:
        cell = {}
        for f in WEEKLY_SUM:
            cell[f] = sum(D["weekly"][w][f] for _, D in parts)
        ds = [x for _, D in parts for x in D["durations"][w]]
        cell["sess_med"] = median_min(ds)
        # 字段顺序跟主仓库那份一致，report / render 读出来的顺序不变
        out["weekly"][w] = {f: cell[f] for f in P["weekly"][w]}
        out["durations"][w] = ds
    out["strict"] = True

    # 口径切换周：每个仓库各留一份。报告 / 图在任一仓库切换的那周都标「跨口径」。
    out["switch_weeks"] = {D["repo"]: D["switch_week"] for _, D in parts}
    sws = sorted(v for v in out["switch_weeks"].values() if v)
    # 单值字段给最近的那次切换：过渡期并列块、「新口径是否已上线」按它判断
    out["switch_week"] = sws[-1] if sws else None
    out["repos"] = repos
    # 按仓库拆分表的素材：每个仓库本周那一格（原样）
    tw = P["target_week"]["start"]
    out["by_repo"] = [{"repo": D["repo"], "week": D["weekly"][tw]} for _, D in parts]

    bad = self_check(parts, out)
    if bad:
        raise MergeError("合并自检没通过：\n  " + "\n  ".join(bad))
    return out


def self_check(parts, out):
    """合并后的数字必须能从各份原样复算出来。返回对不上的项（空 = 通过）。"""
    bad = []
    for w in out["weeks"]:
        for f in WEEKLY_SUM:
            want = sum(float(D["weekly"][w][f] or 0) for _, D in parts)
            got = float(out["weekly"][w][f] or 0)
            if abs(want - got) > 1e-6 * max(1.0, abs(want)):
                bad.append(f"{w} {f}：各仓库之和 {want:g}，合并结果 {got:g}")
        ds = [x for _, D in parts for x in D["durations"][w]]
        want = median_min(ds)
        if abs(want - float(out["weekly"][w]["sess_med"])) > 1e-9:
            bad.append(f"{w} sess_med：对合并后原始时长重算为 {want:g}，"
                       f"合并结果 {out['weekly'][w]['sess_med']:g}")
    tw = out["target_week"]["start"]
    bad += [f"按模型拆分：{x}" for x in bymodel.check(out["weekly"][tw], out["by_model"])]
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--primary", required=True, help="主仓库那份数据")
    ap.add_argument("extra", nargs="+", help="附加仓库的数据，按配置顺序")
    a = ap.parse_args()
    parts = []
    for f in [a.primary, *a.extra]:
        try:
            with open(f, encoding="utf-8") as fh:
                parts.append((f, json.load(fh)))
        except (OSError, ValueError) as e:
            sys.exit(f"[error] 读不了 {f}：{e}")
    try:
        out = merge(parts)
    except MergeError as e:
        sys.exit(f"[error] 合并失败：{e}")
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"[ok] {a.out}: 合并了 {len(parts)} 个仓库（{', '.join(out['repos'])}）")


if __name__ == "__main__":
    main()
