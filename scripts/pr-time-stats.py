#!/usr/bin/env python3
"""每个已合并 PR 的 AI 耗时和测试耗时（估算，GitHub#593）。只读：只读 GitHub、本机测试流水，不写任何地方。

口径是维护者在 #593 选定的「估算」（Q1 = B），不做跨派工去重：

  · AI 耗时      = 这个 PR 的各轮派工 footer 机器记录里 `ai_secs` 直接相加。同一工作树上两轮
                   同一 agent 的派工时间重叠时，重叠段会算两次 → 偏高；这类 PR 标「派工重叠」。
  · 单跑测试     = footer 里 `adhoc_secs` 相加（直接跑某个测试文件，footer 只记合计，分不出种类）。
  · 整套测试     = 本机测试流水（tests/run.sh 每次运行一条开始、一条结束，运行编号唯一）按参数分类，
                   每类取时间段并集：冒烟 / 快速 / 按种类 / 相关改动 / 全部 / 其他。
  · CI           = 「Tests」「Client」两个工作流里属于这个 PR 的 pull_request 运行，每次尝试计一次；
                   Tests 按汇总那一步日志里的 `Selection:` 行分「全量 / 按改动挑选 / 挑选方式未知」。
  · 本地小计     = 整套测试并集 + 单跑合计；CI 小计 = 所有尝试的时间段并集；
    测试总耗时   = 本地小计 + CI 小计（两边时间上可能重叠，偏高）。
  · 「完整测试」= 带负对照的整套运行（维护者在 #593 的定义），只有每晚的负对照工作流这么跑，属于主干、
    PR 流程里不跑：每 PR 为 0，报告另给它窗口内每次运行多久。发版流水线、客户端完整测试单列「其他主干测试」。

缺数据怎么记（不把「不知道」当 0）：
  · 一个 PR 一条 footer 都没有 → AI / 单跑「无记录」，不进平均；本地小计和测试总耗时也说不出（缺单跑那部分），
    记未知、不进平均；整套测试各栏照流水算，CI 照常算。
  · 某条 footer 没有 `ai_secs`（AI 时间未知、旧格式）→ AI「未知」，不进平均。
  · 某条 footer 的测试字段带不确定标记（读取失败、写法认不出的命令、未计时、未关联、没有记账、
    未记到结束）→ 数字照常计入，标「测试记录不全」（是下限）。
  · 读 GitHub 或流水失败、列表没读全 → 整个命令失败退出（退出码 2），不出半份报告。

PR 对应的工作编号（issue 号）用 daemon 同一条规则（_lib.sh 的 pr_to_issue_num）：分支名
BRANCH_PREFIX<N> → 正文第一处 Closes/Fixes/Resolves/Refs #N → PR 号本身。tests/pr-time-stats.test.sh
拿同一批输入和 shell 版对拍。

用法：
  python3 scripts/pr-time-stats.py --repo OWNER/REPO --worktree-base DIR [--session-prefix issue]
      [--branch-prefix feature/issue-] [--since 2026-11-07] [--until YYYY-MM-DD]
      [--bot-login LOGIN]... [--runs-log FILE] [--no-ci-selection] [--no-cache] [--json]

请求量：每个 PR 读一两页评论；CI 每次尝试多读两次（作业列表和汇总那一步的日志），第一次跑 170 多个 PR
约要两千多次请求，和 daemon 共用一个账号时会占掉它一小时额度的一半左右。跑完的 CI 尝试的起止和挑选方式
存在 $XDG_CACHE_HOME/cavil-loop/（结果不会再变），重跑只读评论和列表；`--no-ci-selection` 不读日志。
`--since` 默认 2026-11-07（本机测试流水开始记的那天）：只算创建和所有派工都在这之后、并且在
[since, until] 合并的 PR。`gh` 从 PATH 找（测试用假的）。
"""
import argparse
import datetime
import json
import os
import re
import shlex
import statistics
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "weekly-report"))
sys.path.insert(0, os.path.join(HERE, "drivers", "token-usage"))
sys.path.insert(0, HERE)
import record      # noqa: E402  footer 机器记录：最后一个非空行、作者是机器人、派工身份去重
import test_time   # noqa: E402  流水路径、时间段并集（footer 用的同一份）
import round_log   # noqa: E402  往返记录拆单元（GitHub#610；与周报、读取命令同一份）

UTC = datetime.timezone.utc
LOCAL_CATS = ("smoke", "quick", "kind", "related", "all", "other")
CAT_NAME = {"smoke": "冒烟", "quick": "快速", "kind": "按种类", "related": "相关改动",
            "all": "全部", "other": "其他"}
CI_WORKFLOWS = {"tests.yml": "shell", "client.yml": "client"}
# 「完整测试」= 带负对照的整套运行（维护者在 #593 的定义），只有每晚的负对照工作流这么跑；
# 发版流水线和客户端完整测试另列「其他主干测试」参考，不叫完整测试
FULL_WORKFLOW = "negative-controls.yml"
OTHER_WORKFLOWS = ("release.yml", "client.yml")
TEST_FLAGS = ("adhoc_untimed", "cmd_unparsed", "suite_unlinked", "suite_unlogged", "suite_unfinished")


class Fail(Exception):
    pass


# ── GitHub（只读）───────────────────────────────────────────────────────────

CALLS = [0]          # 本次发出的 GitHub 请求数（报告里写明，和 daemon 共用额度时心里有数）
CACHE = {}           # 跑完的 CI 尝试的起止和挑选方式：结果不会再变，存在本机，重跑不再请求


def cache_path(repo):
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "cavil-loop", "pr-time-stats-" + re.sub(r"[^A-Za-z0-9._-]", "_", repo) + ".json")


def cache_load(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            CACHE.update(d)
    except (OSError, ValueError):
        pass             # 没有或读不懂：当成空的，大不了重新请求


def cache_save(path):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(CACHE, f)
        os.replace(tmp, path)
    except OSError as e:
        print(f"缓存写不进 {path}：{e}（不影响结果，下次会重新请求）", file=sys.stderr)


def gh(path, raw=False):
    CALLS[0] += 1
    try:
        # 作业日志里有终端转义字符，gh 默认拒绝原样输出（报错退出），读日志时要明说允许
        cmd = ["gh", "api"] + (["--allow-escape-sequences"] if raw else []) + [path]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Fail(f"gh api {path}：{e}")
    if p.returncode != 0:
        raise Fail(f"gh api {path} 退出码 {p.returncode}：{p.stderr.strip()[:300]}")
    if raw:
        return p.stdout
    try:
        return json.loads(p.stdout)
    except ValueError:
        raise Fail(f"gh api {path}：返回的不是 JSON")


def pages(path, key=None, stop=None):
    """按 page 逐页读到不满一页为止。key = 对象里装列表的字段（Actions 接口），带 total_count 时核对读全。"""
    out, page, total = [], 1, None
    sep = "&" if "?" in path else "?"
    while True:
        d = gh(f"{path}{sep}per_page=100&page={page}")
        items = d.get(key) if key else d
        if not isinstance(items, list):
            raise Fail(f"{path}：第 {page} 页的形状不对")
        if key and isinstance(d.get("total_count"), int):
            total = d["total_count"]
        out.extend(items)
        if len(items) < 100 or (stop and items and stop(items[-1])):
            break
        page += 1
    if total is not None and len(out) != total:
        raise Fail(f"{path}：读到 {len(out)} 条，接口说有 {total} 条（没读全）")
    return out


def ts(v):
    if not v:
        return None
    return datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()


# ── PR → 工作编号（与 _lib.sh 的 pr_to_issue_num 同一条规则）─────────────────

LINK = re.compile(r'(close[sd]?|fix(es|ed)?|resolve[sd]?|refs?)[ \t\r\f\v]+#[0-9]+', re.I)


def body_linked_issue(body):
    """pr_body_linked_issue：逐行找，第一处匹配里的编号。"""
    for line in (body or "").split("\n"):
        m = LINK.search(line)
        if m:
            return re.search(r'[0-9]+', m.group(0)).group(0)
    return ""


def item_num(pr, branch, body, prefix):
    m = re.match(re.escape(prefix) + r'([0-9]+)', branch or "")
    if m:
        return m.group(1)
    return body_linked_issue(body) or str(pr)


# ── footer 机器记录 ──────────────────────────────────────────────────────────

def footers(comments, default_wt):
    """评论里的派工记录，按派工身份去重（同一派工多条评论取最后那条，见 record.dispatch_key）。
    返回 (派工列表, 非机器人账号写的、形状像机器记录的评论条数)。"""
    best, skipped = {}, 0
    for c in comments:
        body, login = c.get("body") or "", (c.get("user") or {}).get("login", "")
        ne = [l.strip() for l in body.splitlines() if l.strip()]
        last = ne[-1] if ne else ""
        rec = record.extract(body, login, c.get("id"), default_wt=default_wt)
        if rec is None:
            if record.RE_MARK.match(last) and not record.is_bot(login):
                skipped += 1
            continue
        m = record.RE_MARK.match(last)
        rec["kv"] = dict(p.split("=", 1) for p in m.group(1).split() if "=" in p) if m else {}
        rec["created"] = ts(c.get("created_at"))
        k = record.dispatch_key(rec)
        best[k] = record.pick_latest(best.get(k), rec)
    return list(best.values()), skipped


def num(kv, key):
    try:
        return float(kv[key])
    except (KeyError, ValueError):
        return None


def windows_overlap(ds):
    """同一工作树、同一 agent 的派工时间窗有没有重叠（footer 的 AI / 单跑在重叠段会算两次）。"""
    seen = {}
    for d in ds:
        if not isinstance(d["start"], datetime.datetime):
            continue
        seen.setdefault((d["wt"], d.get("agent")), []).append((d["start"], d["end"]))
    for spans in seen.values():
        spans.sort()
        for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
            if b0 < a1:
                return True
    return False


# ── 本机测试流水 ────────────────────────────────────────────────────────────

VALUE_OPTS = {"-j", "--out", "--shard", "--kind", "--changed-from", "--verify"}
NON_RUN = {"--list", "--verify", "--tally", "-h", "--help"}


def classify_args(args):
    """tests/run.sh 一次运行的参数 → 类别；不跑测试的返回 None。"""
    try:
        toks = shlex.split(args or "")
    except ValueError:
        return "other"
    names, opts, i = [], set(), 0
    while i < len(toks):
        t = toks[i]
        if t.startswith("-"):
            o = t.split("=", 1)[0]
            if re.fullmatch(r"-j[0-9]+", t):
                o = "-j"
            elif o in VALUE_OPTS and "=" not in t and o == t:
                i += 1
            opts.add(o)
        else:
            names.append(t)
        i += 1
    if opts & NON_RUN:
        return None
    known = {"-j", "--out", "--ci", "--quick", "--kind", "--changed-from"}
    if opts - known:
        return "other"
    if names:
        return "smoke" if set(names) == {"smoke"} else "related"
    if "--changed-from" in opts:
        return "related"
    if "--quick" in opts:
        return "quick"
    if "--kind" in opts:
        return "kind"
    return "all"


def read_runs(path):
    """流水 → {工作树路径: [运行]}。读不了 → 失败退出；读不懂的行计数。"""
    try:
        f = open(path, encoding="utf-8")
    except OSError as e:
        raise Fail(f"测试流水 {path} 读不了：{e}")
    runs, bad = {}, 0
    with f:
        for line in f:
            try:
                r = json.loads(line)
                rid, wt, ev = r["id"], r["wt"], r["ev"]
            except (ValueError, KeyError, TypeError):
                bad += 1
                continue
            x = runs.setdefault(rid, {"wt": wt, "args": None, "t0": None, "t1": None, "exit": None})
            if ev == "start":
                x["args"], x["t0"] = r.get("args", ""), x["t0"] or r.get("t")
            elif ev == "end":
                x["t0"], x["t1"], x["exit"] = r.get("t0", x["t0"]), r.get("t"), r.get("exit")
    by_wt = {}
    for rid, x in runs.items():
        by_wt.setdefault(x["wt"], []).append(x)
    return by_wt, bad


def union(spans):
    return test_time.union_secs(spans, float("-inf"), float("inf")) if spans else 0.0


# ── CI ──────────────────────────────────────────────────────────────────────

def ci_runs(repo, wf, since, event=None):
    q = f"created=%3E%3D{since}" + (f"&event={event}" if event else "")
    return pages(f"repos/{repo}/actions/workflows/{wf}/runs?{q}", key="workflow_runs")


def attempts(repo, run):
    """一次运行的每次尝试：[(尝试号, 开始, 结束, 结论)]。"""
    out = []
    n = run.get("run_attempt") or 1
    for k in range(1, n + 1):
        key = f"attempt:{run['id']}:{k}"
        if k < n and key in CACHE:
            out.append((k, *CACHE[key]))
            continue
        a = run if k == n else gh(f"repos/{repo}/actions/runs/{run['id']}/attempts/{k}")
        row = (ts(a.get("run_started_at") or a.get("created_at")), ts(a.get("updated_at")), a.get("conclusion"))
        if k < n and row[2] is not None:      # 有结论 = 跑完了，以后不会再变
            CACHE[key] = list(row)
        out.append((k, *row))
    return out


def selection(repo, run_id, attempt, done):
    """Tests 运行汇总那一步写的挑选方式：full / changed / unknown。done = 这次尝试已跑完（结果可缓存）。"""
    key = f"sel2:{run_id}:{attempt}"   # 规则改过就换前缀，旧结论不再用
    if key in CACHE:
        return CACHE[key]
    v = _selection(repo, run_id, attempt)
    if done and v != "error":
        CACHE[key] = v
    return "unknown" if v in ("error", "none") else v


def _selection(repo, run_id, attempt):
    try:
        jobs = gh(f"repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100").get("jobs") or []
        job = next((j for j in jobs if j.get("name") == "测试"), None)
        if not job:
            return "none"
        log = gh(f"repos/{repo}/actions/jobs/{job['id']}/logs", raw=True)
    except Fail:
        return "error"       # 读失败（日志过期、限流）不缓存，下次再试
    if "Selection: full run" in log:
        return "full"
    if "only what this change can reach" in log:
        return "changed"
    # tests/run.sh --verify 只在带 --changed-from 时写 Selection 行；GitHub#495 之前 PR 上不带它、跑的就是全部。
    # 所以有结论标题（汇总那一步确实跑完了）却没有 Selection 行 = 全量
    if re.search(r"## (✅ All \d+ tests passed|❌ \d+ of \d+ tests did not pass)", log):
        return "full"
    return "none"


# ── 汇总 ────────────────────────────────────────────────────────────────────

def stat(values):
    if not values:
        return None
    return {"mean": sum(values) / len(values), "median": statistics.median(values), "n": len(values)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="每个已合并 PR 的 AI 耗时和测试耗时（估算，只读）")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--worktree-base", required=True)
    ap.add_argument("--session-prefix", default="issue")
    ap.add_argument("--branch-prefix", default="feature/issue-")
    ap.add_argument("--since", default="2026-11-07")
    ap.add_argument("--until", default=None)
    ap.add_argument("--bot-login", action="append", default=[])
    ap.add_argument("--runs-log", default=None)
    ap.add_argument("--no-ci-selection", action="store_true")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.bot_login:
        extra = os.environ.get("WEEKLY_REPORT_BOT_LOGINS", "")
        os.environ["WEEKLY_REPORT_BOT_LOGINS"] = " ".join([extra] + a.bot_login).strip()
    try:
        since = datetime.datetime.strptime(a.since, "%Y-%m-%d").replace(tzinfo=UTC).timestamp()
        until = (datetime.datetime.strptime(a.until, "%Y-%m-%d").replace(tzinfo=UTC)
                 + datetime.timedelta(days=1)).timestamp() if a.until else float("inf")
    except ValueError:
        print("--since / --until 要写成 YYYY-MM-DD", file=sys.stderr)
        return 2
    cpath = cache_path(a.repo)
    if not a.no_cache:
        cache_load(cpath)
    try:
        res = collect(a, since, until)
    except Fail as e:
        print(f"统计失败：{e}（本次已发 {CALLS[0]} 次请求）", file=sys.stderr)
        return 2
    finally:
        if not a.no_cache:
            cache_save(cpath)       # 失败也存：限流中断后重跑不必再读已经读过的
    res["gh_calls"] = CALLS[0]
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=1, sort_keys=True))
    else:
        print(render(res))
    return 0


def collect(a, since, until):
    repo = a.repo
    runs_by_wt, bad_lines = read_runs(a.runs_log or test_time.runs_log_path(os.environ))

    prs = pages(f"repos/{repo}/pulls?state=closed&sort=updated&direction=desc",
                stop=lambda p: (ts(p.get("updated_at")) or 0) < since)
    prs = [p for p in prs if p.get("merged_at") and since <= ts(p["merged_at"]) < until]
    prs.sort(key=lambda p: ts(p["merged_at"]))

    # 同一工作编号的 PR（共用 issue 和工作树）：按合并先后切时间段，各拿各的那段
    groups = {}
    for p in prs:
        n = item_num(p["number"], (p.get("head") or {}).get("ref"), p.get("body"), a.branch_prefix)
        p["_item"] = n
        groups.setdefault(n, []).append(p)

    # CI：两个工作流里 pull_request 事件的运行
    ci_by_pr, ci_unassigned = {}, 0
    head_index = {}
    for p in prs:
        h = p.get("head") or {}
        head_index.setdefault(((h.get("repo") or {}).get("full_name"), h.get("ref")), []).append(p)
    ci_since = datetime.datetime.fromtimestamp(since - 86400 * 30, UTC).strftime("%Y-%m-%d")
    for wf, kind in CI_WORKFLOWS.items():
        for r in ci_runs(repo, wf, ci_since, event="pull_request"):
            nums = [x.get("number") for x in (r.get("pull_requests") or [])]
            owner = [p for p in prs if p["number"] in nums]
            if not nums:
                cand = head_index.get(((r.get("head_repository") or {}).get("full_name"), r.get("head_branch")), [])
                t = ts(r.get("created_at"))
                owner = [p for p in cand if ts(p["created_at"]) <= t <= ts(p["merged_at"])]
            if not owner:
                continue              # 属于窗口外的 PR（没合并的、更早的）
            if len(owner) > 1:
                ci_unassigned += 1    # 能对上不止一个 PR：不算给任何一个
                continue
            ci_by_pr.setdefault(owner[0]["number"], []).append((kind, r))

    rows, skipped_nonbot, too_early = [], 0, []
    for n, plist in groups.items():
        # 工作编号是 issue 号（不是这组里某个 PR 自己的号）时，issue 上的派工也算进来
        is_issue = n not in {str(p["number"]) for p in plist}
        issue_comments = round_log.expand_github_comments(pages(f"repos/{repo}/issues/{n}/comments"), record.is_bot) if is_issue else []
        prev_merge = float("-inf")
        for p in plist:
            own = round_log.expand_github_comments(pages(f"repos/{repo}/issues/{p['number']}/comments"), record.is_bot)
            lo, hi = prev_merge, ts(p["merged_at"])
            mine = [c for c in issue_comments if lo < (ts(c.get("created_at")) or 0) <= hi]
            ds, sk = footers(own + mine, n)
            skipped_nonbot += sk
            starts = [d["start"].timestamp() for d in ds if isinstance(d["start"], datetime.datetime)]
            first = min(starts + [ts(p["created_at"])])
            if first < since:
                too_early.append(p["number"])
                prev_merge = hi
                continue
            row = pr_row(a, p, n, ds, runs_by_wt, ci_by_pr.get(p["number"], []),
                         max(first, prev_merge), hi, len(plist) > 1)
            rows.append(row)
            prev_merge = hi

    full, other = full_reference(repo, a.since, since, until)
    summary = summarize(rows)
    return {"repo": repo, "since": a.since, "until": a.until, "prs": rows, "summary": summary,
            "full_tests": full, "other_main_tests": other, "ci_unassigned": ci_unassigned, "skipped_nonbot_footers": skipped_nonbot,
            "excluded_too_early": sorted(too_early), "runs_log_bad_lines": bad_lines}


def pr_row(a, p, n, ds, runs_by_wt, ci, lo, hi, shared):
    flags = []
    if shared:
        flags.append("共用工作树")
    # AI / 单跑：footer 相加
    if not ds:
        ai = adhoc = None
        ai_state = adhoc_state = "none"
    else:
        vals = [num(d["kv"], "ai_secs") for d in ds]
        ai_state = "ok" if all(v is not None for v in vals) else "unknown"
        ai = sum(vals) if ai_state == "ok" else None
        avals = [num(d["kv"], "adhoc_secs") for d in ds]
        adhoc_state = "ok" if all(v is not None for v in avals) else "unknown"
        adhoc = sum(avals) if adhoc_state == "ok" else None
        incomplete = any(d["kv"].get("suite_read", "ok") != "ok" or d["kv"].get("adhoc_read", "ok") != "ok"
                         or any((num(d["kv"], f) or 0) > 0 for f in TEST_FLAGS) for d in ds)
        if incomplete:
            flags.append("测试记录不全")
        if windows_overlap(ds):
            flags.append("派工重叠")
    # 整套测试：本机流水
    wt = os.path.join(a.worktree_base, f"{a.session_prefix}-{n}")
    spans = {c: [] for c in LOCAL_CATS}
    counts = {c: 0 for c in LOCAL_CATS}
    unfinished = 0
    for r in runs_by_wt.get(wt, []):
        t0 = r["t0"]
        if t0 is None or not (lo <= t0 <= hi):
            continue
        cat = classify_args(r["args"])
        if cat is None:
            continue
        counts[cat] += 1
        if r["t1"] is None:
            unfinished += 1
            continue
        spans[cat].append((t0, r["t1"]))
    if unfinished:
        flags.append(f"{unfinished} 次整套测试未记到结束")
    local = {c: union(spans[c]) for c in LOCAL_CATS}
    suite_all = [s for c in LOCAL_CATS for s in spans[c]]
    suite_total = union(suite_all)
    # CI
    ci_spans = {"shell_full": [], "shell_changed": [], "shell_unknown": [], "client": []}
    ci_count = {k: 0 for k in ci_spans}
    cancelled = 0
    for kind, r in ci:
        for k, t0, t1, concl in attempts(a.repo, r):
            if t0 is None or t1 is None:
                flags.append("CI 尝试缺起止")
                continue
            if concl == "cancelled":
                cancelled += 1
            if kind == "client":
                key = "client"
            else:
                sel = "unknown" if a.no_ci_selection else selection(a.repo, r["id"], k, concl is not None)
                key = {"full": "shell_full", "changed": "shell_changed"}.get(sel, "shell_unknown")
            ci_spans[key].append((t0, t1))
            ci_count[key] += 1
    ci_secs = {k: union(v) for k, v in ci_spans.items()}
    ci_total = union([s for v in ci_spans.values() for s in v])
    # 本地小计 / 测试总耗时要用到单跑合计：footer 没有（无记录）或缺字段（未知）时说不出，记未知；
    # 能单独算的整套测试各栏和 CI 照常给出
    local_total = suite_total + adhoc if adhoc_state == "ok" else None
    return {
        "pr": p["number"], "item": n, "dispatches": len(ds),
        "ai_secs": ai, "ai_state": ai_state,
        "adhoc_secs": adhoc, "adhoc_state": adhoc_state,
        "local_secs": local, "local_runs": counts, "suite_secs": suite_total,
        "local_total_secs": local_total,
        "ci_secs": ci_secs, "ci_attempts": ci_count, "ci_cancelled": cancelled, "ci_total_secs": ci_total,
        "test_total_secs": (local_total + ci_total) if local_total is not None else None,
        "full_secs": 0, "flags": flags,
    }


COLUMNS = [("ai", "AI 耗时", lambda r: r["ai_secs"]),
           ("adhoc", "单跑（未分类）", lambda r: r["adhoc_secs"])] + \
          [(f"local_{c}", f"整套·{CAT_NAME[c]}", (lambda c: lambda r: r["local_secs"][c])(c)) for c in LOCAL_CATS] + \
          [("local_total", "本地小计", lambda r: r["local_total_secs"]),
           ("ci_shell_full", "CI shell·全量", lambda r: r["ci_secs"]["shell_full"]),
           ("ci_shell_changed", "CI shell·按改动挑选", lambda r: r["ci_secs"]["shell_changed"]),
           ("ci_shell_unknown", "CI shell·挑选方式未知", lambda r: r["ci_secs"]["shell_unknown"]),
           ("ci_client", "CI 客户端·快速", lambda r: r["ci_secs"]["client"]),
           ("ci_total", "CI 小计", lambda r: r["ci_total_secs"]),
           ("test_total", "测试总耗时", lambda r: r["test_total_secs"]),
           ("full", "完整测试", lambda r: r["full_secs"])]


def summarize(rows):
    out = {}
    for key, _name, get in COLUMNS:
        vals = [get(r) for r in rows]
        known = [v for v in vals if v is not None]
        out[key] = {"stat": stat(known), "excluded": len(vals) - len(known)}
    out["flagged"] = {f: sum(1 for r in rows if any(x == f or x.endswith(f) for x in r["flags"]))
                      for f in ("派工重叠", "测试记录不全", "共用工作树")}
    out["prs"] = len(rows)
    return out


def workflow_durations(repo, wf, since_s, until):
    runs = ci_runs(repo, wf, since_s)
    if wf == "client.yml":     # 只要完整测试那几种：每周定时、发版标签
        runs = [r for r in runs if r.get("event") == "schedule" or (r.get("head_branch") or "").startswith("client/v")]
    durs = [ts(r.get("updated_at")) - ts(r.get("run_started_at") or r.get("created_at"))
            for r in runs if r.get("status") == "completed" and ts(r.get("created_at")) < until]
    return stat(durs) or {"n": 0}


NC_TEST_JOB = re.compile(r"negative controls (?!summary$)")   # 跑负对照的作业：shell 分片、autopilot 各部分、客户端
NC_TEST_STEP = re.compile(r"negative controls", re.I)         # 这些作业里真正跑负对照的那一步（其余是检出、装依赖、上传）


def nc_verdict(jobs, total):
    """一次负对照运行有没有真的跑负对照，只看「负对照那一步」自己的结论（三种作业同一条规则）：
      ran      至少一个负对照步骤跑完（success / failure；跑红照样算）
      not_run  作业列表读全、每个负对照作业都在，且所有负对照步骤都明确 skipped（或作业整个 skipped）：
               只做了准备就收尾、或准备步骤失败后负对照没开始——都不算完整测试
      unknown  其余一切：列表没读全、认不出作业、作业里找不到负对照那一步、步骤状态是取消 / 空 / 不认识的词
    整条运行显示 completed、作业显示 failure 都不能说明负对照跑过（准备步骤失败时作业也是 failure）。"""
    if not isinstance(jobs, list) or total != len(jobs):
        return "unknown"
    tests = [j for j in jobs if NC_TEST_JOB.match(j.get("name") or "")]
    if not tests:
        return "unknown"
    states = []
    for j in tests:
        if j.get("conclusion") == "skipped":
            states.append("skipped")
            continue
        steps = [st for st in (j.get("steps") or []) if NC_TEST_STEP.search(st.get("name") or "")]
        if not steps:
            states.append("unknown")
            continue
        for st in steps:
            c = st.get("conclusion")
            states.append("ran" if c in ("success", "failure") else "skipped" if c == "skipped" else "unknown")
    if "ran" in states:
        return "ran"
    if all(x == "skipped" for x in states):
        return "not_run"
    return "unknown"


def nc_ran(repo, run):
    """读一次负对照运行的作业（含步骤）并判定，见 nc_verdict。读不到 = unknown，不缓存、下次重读。"""
    att = run.get("run_attempt") or 1
    key = f"nc2:{run['id']}:{att}"     # 判定规则改过就换前缀，旧结论不再用
    if key in CACHE:
        return CACHE[key]
    try:
        d = gh(f"repos/{repo}/actions/runs/{run['id']}/attempts/{att}/jobs?per_page=100")
    except Fail:
        return "unknown"
    v = nc_verdict(d.get("jobs"), d.get("total_count"))
    if v != "unknown":
        CACHE[key] = v
    return v


def full_runs(repo, since_s, until):
    """完整测试 = 负对照工作流里真的跑了负对照的那几次（跑红的也算，照实计时）。"""
    runs = [r for r in ci_runs(repo, FULL_WORKFLOW, since_s)
            if r.get("status") == "completed" and ts(r.get("created_at")) < until]
    kinds = {"ran": [], "not_run": 0, "unknown": 0}
    for r in runs:
        k = nc_ran(repo, r)
        if k == "ran":
            kinds["ran"].append(ts(r.get("updated_at")) - ts(r.get("run_started_at") or r.get("created_at")))
        else:
            kinds[k] += 1
    out = stat(kinds["ran"]) or {"n": 0}
    out.update(not_run=kinds["not_run"], unknown=kinds["unknown"])
    return out


def full_reference(repo, since_s, since, until):
    """(完整测试 = 真的跑了负对照的那几次运行, {其他主干测试工作流: 每次运行})"""
    return (full_runs(repo, since_s, until),
            {wf: workflow_durations(repo, wf, since_s, until) for wf in OTHER_WORKFLOWS})


def ref_row(wf, st):
    return [wf, str(st.get("n", 0)), dur(st.get("mean")), dur(st.get("median"))]


def md_table(head, rows):
    """表头、分隔行、数据行出自同一份列数，不会对不上（GitHub 列数对不上就不渲染成表格）"""
    for r in rows:
        assert len(r) == len(head), (head, r)
    return ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)] + ["| " + " | ".join(r) + " |" for r in rows]


# 逐 PR 那张表：每一列的表头和取值写在一起
PR_COLS = ([("PR", lambda r: f"#{r['pr']}"), ("编号", lambda r: r["item"]),
            ("AI", lambda r: dur(r["ai_secs"])), ("单跑", lambda r: dur(r["adhoc_secs"]))]
           + [(f"整套·{CAT_NAME[c]}", (lambda c: lambda r: dur(r["local_secs"][c]))(c)) for c in LOCAL_CATS]
           + [("本地", lambda r: dur(r["local_total_secs"])),
              ("CI 全量", lambda r: dur(r["ci_secs"]["shell_full"])),
              ("CI 挑选", lambda r: dur(r["ci_secs"]["shell_changed"])),
              ("CI 未知", lambda r: dur(r["ci_secs"]["shell_unknown"])),
              ("CI 客户端", lambda r: dur(r["ci_secs"]["client"])),
              ("CI 小计", lambda r: dur(r["ci_total_secs"])),
              ("测试总耗时", lambda r: dur(r["test_total_secs"])),
              ("标注", lambda r: "、".join(r["flags"]))])


def dur(x):
    if x is None:
        return "—"
    x = int(round(x))
    h, m, s = x // 3600, x % 3600 // 60, x % 60
    return f"{h}h {m}m" if h else (f"{m}m {s}s" if m else f"{s}s")


def render(res):
    s = res["summary"]
    L = [f"# 每个 PR 的 AI 与测试耗时（估算）", "",
         f"仓库 {res['repo']}，{res['since']} 起创建、{res['since']} 至 {res['until'] or '今天'} 合并的 PR：{s['prs']} 个。",
         "估算口径：AI 和单跑测试是各轮 footer 直接相加，同一 agent 的派工时间重叠时偏高；测试总耗时 = 本地 + CI，"
         "两边时间上重叠时也偏高。各栏分母不同，平均数不能相加。", "",
         ]
    L += md_table(["栏", "平均", "中位数", "计入 PR 数", "无记录 / 未知"],
                  [[name, dur(s[key]["stat"]["mean"]) if s[key]["stat"] else "—",
                    dur(s[key]["stat"]["median"]) if s[key]["stat"] else "—",
                    str(s[key]["stat"]["n"] if s[key]["stat"] else 0), str(s[key]["excluded"])]
                   for key, name, _ in COLUMNS])
    L += ["", "标注：" + "，".join(f"{k} {v} 个" for k, v in s["flagged"].items()), "",
          "「完整测试」= 带负对照的整套运行，只在主干上每晚跑，不属于某个 PR（每 PR 一栏为 0）：", ""]
    L += md_table(["工作流", "次数", "平均", "中位数"], [ref_row(FULL_WORKFLOW, res["full_tests"])])
    ft = res["full_tests"]
    if ft.get("not_run") or ft.get("unknown"):
        L += ["", f"另有 {ft.get('not_run', 0)} 次负对照没真跑（只做了准备就收尾，或准备步骤失败后负对照没开始），"
                  f"{ft.get('unknown', 0)} 次说不清负对照那一步有没有跑（作业或步骤读不到、状态认不出），都没算进上表。"]
    L += ["", "其他主干测试参考（不是完整测试，也不进每 PR）：", ""]
    L += md_table(["工作流", "次数", "平均", "中位数"], [ref_row(wf, st) for wf, st in res["other_main_tests"].items()])
    L += [""] + md_table([h for h, _ in PR_COLS], [[f(r) for _, f in PR_COLS] for r in res["prs"]])
    extra = [f"本次向 GitHub 发了 {res.get('gh_calls', '?')} 次请求"]
    if res["ci_unassigned"]:
        extra.append(f"{res['ci_unassigned']} 次 CI 运行归不到唯一一个 PR，没算进任何 PR")
    if res["skipped_nonbot_footers"]:
        extra.append(f"{res['skipped_nonbot_footers']} 条非机器人账号的评论末尾像机器记录，没算"
                     "（loop 账号名不以 -bot 结尾时用 --bot-login 指定）")
    if res["excluded_too_early"]:
        extra.append(f"{len(res['excluded_too_early'])} 个 PR 有派工早于 {res['since']}，不在统计里")
    if res["runs_log_bad_lines"]:
        extra.append(f"测试流水里 {res['runs_log_bad_lines']} 行读不懂，已跳过")
    if extra:
        L += [""] + [f"- {x}" for x in extra]
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())
