#!/usr/bin/env python3
"""周报数据采集 + 聚合。

只跑 4 次列表型 gh API（全部 --paginate），不做 per-issue 循环 —— 避免请求数随
issue 数线性膨胀。输出一份 JSON，供 render.py 出图 / 出 markdown。

用法：
    collect.py --repo OWNER/NAME --out data.json [--weeks 10] [--week-of YYYY-MM-DD]

--week-of 指定「目标周」内的任意一天（默认：今天所在周的上一周，即最近一个完整周）。
"""
import argparse, collections, datetime, json, re, subprocess, sys

TZ = datetime.timezone(datetime.timedelta(hours=8))  # 报告按北京时间切周

def gh(path):
    p = subprocess.run(["gh", "api", "--paginate", path],
                       capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        print(f"[warn] gh api {path} 失败: {p.stderr.strip()[:200]}", file=sys.stderr)
        return []
    txt = p.stdout.strip().replace("][", ",")   # --paginate 会把多页数组首尾相接
    if not txt:
        return []
    try:
        return json.loads(txt)
    except json.JSONDecodeError as e:
        print(f"[warn] gh api {path} 返回无法解析: {e}", file=sys.stderr)
        return []

def is_bot(login):
    """GitHub 机器人账号：约定后缀 `-bot`（我们的 worker）或 GitHub App 的 `[bot]`。"""
    return login.endswith("-bot") or login.endswith("[bot]")

def loc(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=datetime.timezone.utc).astimezone(TZ)

def monday(d):
    return d - datetime.timedelta(days=d.weekday())

# footer 解析：daemon 给每条 agent 评论追加的 ⏱️ 元数据
RE_FOOTER = re.compile(r'⏱️ 开始')
RE_DUR    = re.compile(r'耗时\s*(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?')
RE_OUT    = re.compile(r'token .*?([\d.]+)([km]?)\s*output')
RE_COST   = re.compile(r'\(\$([\d.]+)\)')
RE_CODEX  = re.compile(r'codex review')
MUL = {"": 1, "k": 1e3, "m": 1e6}
# 单条会话超过这个时长的，一律当「跨夜会话把等人回话的时间也算了进去」剔除。
# 实测最离谱的一条 footer 写着 5.6 万小时（START_EPOCH 坏了）。
OUTLIER_SECS = 4 * 3600

# PR ↔ issue 关联：标题尾巴的 （#123） / (#123)，以及 body 里的 Closes/Refs/Fixes #123
RE_LINK_TITLE = re.compile(r'[（(]#(\d+)[）)]')
RE_LINK_BODY  = re.compile(r'\b(?:Closes|Close|Closed|Fixes|Fix|Fixed|Refs|Ref)\s+#(\d+)', re.I)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--weeks", type=int, default=10)
    ap.add_argument("--week-of", default=None,
                    help="目标周内任意一天 YYYY-MM-DD；默认取最近一个完整周")
    a = ap.parse_args()

    today = datetime.datetime.now(TZ).date()
    if a.week_of:
        target = monday(datetime.date.fromisoformat(a.week_of))
    else:
        target = monday(today) - datetime.timedelta(days=7)
    weeks = [(target - datetime.timedelta(days=7 * i)).isoformat()
             for i in range(a.weeks - 1, -1, -1)]
    wset = set(weeks)
    start = weeks[0]

    R = a.repo
    items = gh(f"repos/{R}/issues?state=all&per_page=100")
    comments = gh(f"repos/{R}/issues/comments?since={start}T00:00:00Z&per_page=100")
    prs = gh(f"repos/{R}/pulls?state=all&per_page=100&sort=updated&direction=desc")

    st = {w: collections.defaultdict(float) for w in weeks}
    per_issue = collections.defaultdict(lambda: collections.defaultdict(float))
    durs = {w: [] for w in weeks}
    seen = set()

    def wk(dt):
        return monday(dt.date()).isoformat()

    for c in comments:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        w = wk(loc(c["created_at"]))
        if w not in wset:
            continue
        body = c.get("body") or ""
        user = c["user"]["login"]
        num = int(c["issue_url"].rsplit("/", 1)[-1])
        s = st[w]
        s["comments"] += 1
        s["bot" if is_bot(user) else "human"] += 1
        if RE_FOOTER.search(body):
            s["footers"] += 1
        if RE_COST.search(body):
            s["cost_footers"] += 1
        if RE_CODEX.search(body):
            s["codex"] += 1
        secs = 0
        for m in RE_DUR.finditer(body):
            h, mn, ss = m.groups()
            if not any([h, mn, ss]):
                continue
            v = int(h or 0) * 3600 + int(mn or 0) * 60 + int(ss or 0)
            if v > OUTLIER_SECS:
                s["outliers"] += 1
                continue
            secs += v
            durs[w].append(v)
        cost = sum(float(m.group(1)) for m in RE_COST.finditer(body))
        out = sum(float(m.group(1)) * MUL[m.group(2)] for m in RE_OUT.finditer(body))
        s["secs"] += secs; s["cost"] += cost; s["out"] += out
        if w == target.isoformat():
            p = per_issue[num]
            p["rounds"] += 1
            p["human"] += 0 if is_bot(user) else 1
            p["secs"] += secs; p["cost"] += cost

    # PR → 关联 issue
    link = {}
    for p in prs:
        n = p["number"]
        cands = RE_LINK_TITLE.findall(p.get("title") or "") + \
                RE_LINK_BODY.findall(p.get("body") or "")
        cands = [int(x) for x in cands if int(x) != n]
        if cands:
            link[n] = cands[0]

    meta = {}
    for it in items:
        n = it["number"]
        is_pr = it.get("pull_request") is not None
        cw = wk(loc(it["created_at"]))
        if cw in wset:
            st[cw]["pr_open" if is_pr else "iss_open"] += 1
        merged = it.get("pull_request", {}).get("merged_at") if is_pr else None
        if it.get("closed_at"):
            zw = wk(loc(it["closed_at"]))
            if zw in wset:
                if is_pr:
                    if merged:
                        st[zw]["pr_merged"] += 1
                else:
                    st[zw]["iss_closed"] += 1
        meta[n] = {
            "num": n, "title": it["title"], "is_pr": is_pr,
            "state": it["state"], "labels": [l["name"] for l in it.get("labels", [])],
            "created_at": it["created_at"], "closed_at": it.get("closed_at"),
            "merged_at": merged, "linked": link.get(n),
        }

    # 逐周 git 统计（提交数 / 增删行）
    for w in weeks:
        b = (datetime.date.fromisoformat(w) + datetime.timedelta(days=7)).isoformat()
        def git(*x):
            return subprocess.run(
                ["git", "log", "origin/main", f"--since={w} 00:00:00 +0800",
                 f"--until={b} 00:00:00 +0800", *x],
                capture_output=True, text=True).stdout
        st[w]["commits"] = len(git("--pretty=tformat:%H").split())
        add = dele = 0
        for line in git("--pretty=tformat:", "--numstat").splitlines():
            f = line.split("\t")
            if len(f) == 3 and f[0].isdigit():
                add += int(f[0]); dele += int(f[1]) if f[1].isdigit() else 0
        st[w]["add"] = add; st[w]["del"] = dele
        ds = sorted(durs[w])
        st[w]["sess_med"] = (ds[len(ds) // 2] / 60) if ds else 0

    # 周末时点的未关闭 issue 存量
    for w in weeks:
        end = datetime.datetime.fromisoformat(w + "T00:00:00").replace(tzinfo=TZ) \
              + datetime.timedelta(days=7)
        st[w]["backlog"] = sum(
            1 for it in items if it.get("pull_request") is None
            and loc(it["created_at"]) < end
            and (not it.get("closed_at") or loc(it["closed_at"]) >= end))

    FIELDS = ["iss_open", "iss_closed", "pr_open", "pr_merged", "comments", "human",
              "bot", "secs", "cost", "out", "commits", "add", "del", "footers",
              "cost_footers", "outliers", "codex", "sess_med", "backlog"]
    weekly = {w: {f: st[w].get(f, 0) for f in FIELDS} for w in weeks}

    tw = target.isoformat()
    tend = target + datetime.timedelta(days=6)
    # 上周明细：当周关闭的 issue + 当周有讨论的 issue
    detail = []
    for n, p in per_issue.items():
        m = meta.get(n)
        if not m or m["is_pr"]:
            continue
        detail.append({**m, **{k: p[k] for k in ("rounds", "human", "secs", "cost")}})
    for n, m in meta.items():
        if m["is_pr"] or n in per_issue:
            continue
        if m["closed_at"] and monday(loc(m["closed_at"]).date()).isoformat() == tw:
            detail.append({**m, "rounds": 0, "human": 0, "secs": 0, "cost": 0})
    # 把每个 issue 的关联 PR 挂上（PR 侧的讨论/耗时并进 issue）
    rev = collections.defaultdict(list)
    for pn, iss in link.items():
        rev[iss].append(pn)
    for d in detail:
        d["prs"] = []
        for pn in rev.get(d["num"], []):
            pm = meta.get(pn)
            if not pm:
                continue
            d["prs"].append({"num": pn, "title": pm["title"], "merged_at": pm["merged_at"],
                             "state": pm["state"]})
            pp = per_issue.get(pn)
            if pp:
                d["rounds"] += pp["rounds"]; d["human"] += pp["human"]
                d["secs"] += pp["secs"];     d["cost"] += pp["cost"]
    detail.sort(key=lambda d: -d["secs"])

    json.dump({"repo": R, "generated_at": datetime.datetime.now(TZ).isoformat(),
               "target_week": {"start": tw, "end": tend.isoformat()},
               "weeks": weeks, "weekly": weekly, "detail": detail},
              open(a.out, "w"), ensure_ascii=False, indent=1)
    print(f"[ok] {a.out}: 目标周 {tw}~{tend}，{len(weeks)} 周趋势，{len(detail)} 条 issue 明细")

if __name__ == "__main__":
    main()
