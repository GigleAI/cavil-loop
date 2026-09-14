#!/usr/bin/env python3
"""周报数据采集 + 聚合。

只跑 4 次列表型 gh API（全部 --paginate），不做 per-issue 循环 —— 避免请求数随
issue 数线性膨胀。输出一份 JSON，供 render.py 出图 / 出 markdown。

用法：
    collect.py --repo OWNER/NAME --out data.json [--weeks 10] [--week-of YYYY-MM-DD]

--week-of 指定「目标周」内的任意一天（默认：今天所在周的上一周，即最近一个完整周）。
"""
import argparse, collections, datetime, json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record
import attribute
import price_solve      # noqa: E402  记账记录提取 + 派工去重
import worktime    # noqa: E402  「模型 + 工具」时长（排除等待）

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

# 记账记录的提取与去重全部交给 record.py —— 不再拿正则扫整条评论正文。
# 为什么（GigleTutor-Web#931）：正文里「某测试耗时 5054ms」会被读成 5054 分钟
# = 84 小时；`200ms` / `83ms` 换算后低于当时那个 4 小时剔除阈值，直接混进统计；
# 金额正则还会命中正文 SQL 的 `($1)`。同一次派工发多条评论时还会重复累加。
# 那个 4 小时**剔除**逻辑已经删掉：同一个数值改作「长窗口披露」用途，
# 只决定要不要在报告里列出来，不影响任何统计数字（见 record.LONG_WINDOW_SECS）。
# token 也一样：从 record 选中的那条记录自己读（机器记录读 `out=`，历史记录读记账行
# 紧随其后那一行），**不再扫正文**。扫正文会把讨论里写的示例累加进统计。
RE_CODEX  = re.compile(r'codex review')

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
    # 「模型 + 工具」时长要按派工窗口去本机 agent 日志里取，需要知道 worktree 路径。
    # 路径属于部署环境，不写死在本仓库里；调用方（run.sh）从项目配置传进来。
    # 两个都不给就跳过这个指标，其余照常出。
    ap.add_argument("--worktree-base", default=None, help="worktree 存放基础目录")
    ap.add_argument("--session-prefix", default=None, help="worktree 子目录名前缀")
    # 口径切换那一周（那周起用量按 API 调用去重 + 纳入交叉 review 那一侧）。
    # 它是**部署事实**，不是展示窗口的函数：报告与趋势图都据此判断哪些数字不可比。
    # 给任意一天即可，内部归到那周的周一。不给就按下面 switch_week() 的保守规则推。
    ap.add_argument("--switch-week", default=None,
                    help="口径切换那一周内的任意一天 YYYY-MM-DD")
    a = ap.parse_args()

    today = datetime.datetime.now(TZ).date()
    if a.week_of:
        target = monday(datetime.date.fromisoformat(a.week_of))
    else:
        target = monday(today) - datetime.timedelta(days=7)
    weeks = [(target - datetime.timedelta(days=7 * i)).isoformat()
             for i in range(a.weeks - 1, -1, -1)]
    wset = set(weeks)
    # GitHub 的 `since` 按 **UTC** 比较，而这里的「周一」是**北京时间**的周一（见 TZ）。
    # 直接拼 `<周一>T00:00:00Z` 等于从北京时间周一 **08:00** 才开始取：那天 00:00–08:00
    # 之间发出、之后又没被编辑过的评论整段拿不到。后果不是少一点点，而是**同一个历史周的
    # 数字会随展示窗口左移而变小**——那一周还在窗口内部时取得到（因为 since 更早），
    # 一旦滚到最左端就少掉这 8 小时（GitHub#932 交叉 review 实测：同一条 01:00 发的记录，
    # `--weeks 1` 时 records=0，`--weeks 2` 时 records=1）。这会直接砸掉「逐周核对旧周数值」。
    #
    # 再减 1 秒：`since` 的语义是「**晚于**这个时刻」，正好落在周一 00:00:00 的评论会被排除。
    # 多取进来的那 1 秒属于上一周，下面按 `created_at` 归周时本来就会被 `wset` 过滤掉。
    start = (datetime.datetime.combine(
                 datetime.date.fromisoformat(weeks[0]), datetime.time(0, 0), TZ)
             - datetime.timedelta(seconds=1)
             ).astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    R = a.repo
    items = gh(f"repos/{R}/issues?state=all&per_page=100")
    comments = gh(f"repos/{R}/issues/comments?since={start}&per_page=100")
    prs = gh(f"repos/{R}/pulls?state=all&per_page=100&sort=updated&direction=desc")

    # PR → 关联 issue。评论循环里要用它把一条 PR 评论定位回它的 worktree。
    link = {}
    for p in prs:
        n = p["number"]
        cands = RE_LINK_TITLE.findall(p.get("title") or "") + \
                RE_LINK_BODY.findall(p.get("body") or "")
        cands = [int(x) for x in cands if int(x) != n]
        if cands:
            link[n] = cands[0]

    def switch_week(st_):
        """口径切换那一周 —— **只认配置，猜不出来就说不知道**。

        它是一个部署事实（那一周起派工模板开始写机器记录、交叉 review 那一侧开始记账），
        只有部署方知道；报告与趋势图都据它判断哪些数字跨口径、不可比。

        为什么不从数据里推（GitHub#932 review 连着打回两次）：
          · 第一版在当前 10 周窗口里现找「第一个有 codex 记账的周」。窗口每周前滚一格，
            真实切换周滚出去之后，窗口里第一个有记录的周就成了新的切换点——同一份数据、
            窗口挪一周，标记就从 2/17 变成 2/24，每出一次报告往后漂一次。
          · 第二版加了「它前面还得有一个没有该侧记账的周」。仍然不成立：**切换之后某一周
            没有交叉 review，是再正常不过的事**，空周证明不了部署时间。实测把切换后
            2025-02-17 那周的 codex 记录删掉（只留 claude），真实边界 2025-02-10 滚出窗口后，
            它照样把 2025-02-24 标成了新的切换周。

        所以：没配置就返回 None —— **不知道就是不知道**，报告不标切换周、不画竖线、
        不出过渡期并列块，环比照常给。窗口里确实有交叉 review 记账却没配置时，
        下面会打一条 warn 提醒去配，报告的口径说明里也会写明这一点。
        """
        if a.switch_week:
            return monday(datetime.date.fromisoformat(a.switch_week)).isoformat()
        if any(st_[w].get("records_codex") for w in weeks):
            print("[warn] 窗口里有交叉 review 记账，但没配 WEEKLY_REPORT_SWITCH_WEEK —— "
                  "无法判断口径边界在哪一周，过渡期并列块与切换标记都不会出现。"
                  "请把它设成「新派工模板上线」那一周内的任意一天。", file=sys.stderr)
        return None

    st = {w: collections.defaultdict(float) for w in weeks}
    per_issue = collections.defaultdict(lambda: collections.defaultdict(float))
    durs = {w: [] for w in weeks}
    seen = set()
    claimed = {}               # 派工身份 (wt, 开始) → 该次派工最终那条累计记录
    long_windows = []          # 墙上 ≥ 4 小时的记录，报告里逐条点名（不改数字）
    misattributed = []         # 「模型+工具」明显超过自身墙上时长的，点名（不改数字）

    def wk(dt):
        return monday(dt.date()).isoformat()

    def worktree_of(num):
        """评论所在的 issue / PR 号 → 它的 worktree 路径。拿不到返回 None。"""
        if not (a.worktree_base and a.session_prefix):
            return None
        return f"{a.worktree_base}/{a.session_prefix}-{link.get(num, num)}"

    def rec_week(rec, fallback):
        """这条记账记录算在**哪一周** —— 按派工的**开始时刻**，不按写评论的时刻。

        为什么（GitHub#932 交叉 review）：一次派工完全可能跨周（周日 23:50 开工、
        周一 00:05 才发最终那条累计评论，模板允许）。原来用「最终那条评论所在的周」
        入账，于是同一份固定数据，报告目标周往后滚一格，上一周已记的账就整条**搬走**、
        旧周被清零——实测周日 300 秒/$5 在下一周的报告里变成 0，900 秒/$15 跑到新周。
        按 `start` 归账则与展示窗口无关：这次派工从哪一周开工，就一直算在哪一周。

        身份缺失兜底的那种记录（start 是 ('noid', 评论 id)）没有真实起点，
        退回用它那条评论的周。
        """
        st_ = rec.get("start")
        if isinstance(st_, datetime.datetime):
            return wk(st_.astimezone(TZ))
        return fallback

    dupes_by_key = collections.Counter()

    for c in comments:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        w = wk(loc(c["created_at"]))
        body = c.get("body") or ""
        user = c["user"]["login"]
        num = int(c["issue_url"].rsplit("/", 1)[-1])
        # 「讨论条数」这类**按评论算**的指标只看窗口内的评论。
        if w in wset:
            s = st[w]
            s["comments"] += 1
            s["bot" if is_bot(user) else "human"] += 1
            if RE_CODEX.search(body):
                s["codex"] += 1
            # 轮数 / 你发的条数按**全部**评论算（人发的、交叉 review 的都算一轮），
            # 必须在下面那些 continue 之前累加，否则「讨论轮数」会只剩记账评论。
            if w == target.isoformat():
                p = per_issue[num]
                p["rounds"] += 1
                p["human"] += 0 if is_bot(user) else 1

        rec = record.extract(body, user, c["id"], default_wt=link.get(num, num))
        if rec is None:
            continue                      # 这条评论不是记账来源
        # ⚠️ 认领**不按评论所在的周过滤**：跨周派工的最终累计快照就发在下一周，
        # 把它挡掉会让上一周只拿到中途那个较小的快照（同一份数据、换个窗口就变数）。
        # 真正决定入不入账的是下面 `rec_week()` 算出来的**开工周**在不在窗口里。
        #
        # 先只认领，不入账。记账行里的时长 / 金额 / token 都是**从派工开始起的累计值**，
        # 同一次派工发多条评论时每条都是一个更大的累计快照——必须留 end 最晚的那条，
        # 逐条求和会把前半段重复算（见 record.dispatch_key 的说明）。
        key = record.dispatch_key(rec)
        prev = claimed.get(key)
        kept = record.pick_latest(prev[0] if prev else None, rec)
        if prev is not None:
            dupes_by_key[key] += 1
        if prev is None or kept is rec:
            # 只留提取好的记录，**不留正文** —— 汇总阶段拿不到正文，也就没法再回头
            # 扫它（正文里的示例曾经被当成真实用量累加）。
            claimed[key] = (rec, w, num)

    # ── 第一段半：从本机日志重算金额，并决定哪些能进「去重合计」（GitHub#934）──
    #
    # 三步顺序固定、互不成环：① 调用唯一认领 → ② 逐派工定取值 → ③ 最后按重叠组取舍。
    # ② 不看组的状态，③ 才用 ② 的结果；写成「组能进合计才重算」会成环。
    #
    # 重算门槛是「**本机有这次派工的日志**且通过检验」，**不按周划线**（issue #934 的
    # Q5=B）。代价是同一个历史周的数值会随本机日志被清理而改变——报告里如实写明本周
    # 重算了几条、沿用原值几条，并带上生成时间；**不做任何固定倍数补齐**。
    windows, by_pair = [], {}
    for key, (rec, cw, num) in claimed.items():
        if not isinstance(rec.get("start"), datetime.datetime) \
           or not isinstance(rec.get("end"), datetime.datetime):
            continue                      # 身份缺失兜底的那种记录没有真实窗口，不参与重算
        agent = rec.get("agent") or "claude"     # 历史记录缺 agent 时的既定默认
        wt = rec.get("wt")
        w = {"key": key, "agent": agent, "wt": wt,
             "start": rec["start"].astimezone(TZ), "end": rec["end"].astimezone(TZ)}
        windows.append(w)
        by_pair.setdefault((wt, agent), []).append(w)

    price_table = price_solve.build_cached("A")
    recompute = {}
    for (wt, agent), ws in by_pair.items():
        if agent != "claude" or wt is None:
            continue                      # codex 的会话记录不带金额，这一侧只能沿用原值
        if not (a.worktree_base and a.session_prefix):
            continue                      # 没配 worktree 路径就拿不到日志，一律沿用原值
        wt_path = f"{a.worktree_base}/{a.session_prefix}-{wt}"
        calls, meta = attribute.load_claude_calls(wt_path, TZ)
        for c in calls:                   # 认领按 (wt, agent) 配对，这里统一成窗口那一侧的口径
            c["wt"], c["agent"] = wt, agent
        has_log = meta["files"] > 0
        own, foreign, unattr = attribute.claim(calls, ws)
        for w in ws:
            rec = claimed[w["key"]][0]
            mine = [c for c in calls
                    if w["start"] <= c["t"] < w["end"]
                    and max((x for x in ws if x["start"] <= c["t"] < x["end"]),
                            key=lambda y: y["start"])["key"] == w["key"]]
            chk = attribute.log_check(rec.get("tokens"), own[w["key"]]["tok"],
                                      foreign[w["key"]]["tok"], has_log, meta["parsed"])
            if chk in ("no_shortfall_detected", "true_zero"):
                usd, unk, state, bystat = attribute.price_calls(mine, price_table)
                recompute[w["key"]] = {"cost_source": "recomputed", "cost": usd,
                                       "log_check": chk, "cost_state": state,
                                       "unknown_tokens": unk,
                                       "price_source": "solved", "price_status": bystat}
            else:
                recompute[w["key"]] = {"cost_source": "original", "cost": rec["cost"],
                                       "log_check": chk,
                                       "cost_state": rec.get("cost_state") or "none",
                                       "unknown_tokens": rec.get("cost_unknown_tokens", 0),
                                       "price_source": rec.get("price_source"),
                                       "price_status": rec.get("price_status") or {}}
    # ③ 合计取舍：孤立派工不论取哪种值都进；重叠组内**全部重算**才整组进；含回退则整组
    #    单列。**不能相加**——两条重叠派工一条回退一条重算时，共用的调用会被算两遍。
    sources = {k: v["cost_source"] for k, v in recompute.items()}
    for w in windows:
        sources.setdefault(w["key"], "original")
    summable, _gid = attribute.summable(windows, sources)

    # ── 第二段：每次派工只按它最终那条累计记录入账，算在**开工那一周** ──
    for key, (rec, cw, num) in claimed.items():
        w = rec_week(rec, cw)
        if w not in wset:
            continue                      # 开工周不在展示窗口里（比如窗口之前开的工）
        s = st[w]
        s["footers"] += 1 + dupes_by_key[key]
        if rec.get("has_cost"):
            s["cost_footers"] += 1
        s["dupes"] += dupes_by_key[key]
        wall = rec["wall"]
        # ⚠️ 有没有重算结论，决定**整套**金额字段取哪一份；不能逐个字段用 `or` 回退。
        # 重算出来的空可信度桶 `{}` 是**合法结果**（这次派工一分钱都没认领到），
        # 用 `or` 会把它当成「没算」而回退到旧 footer 的桶，于是旧金额的可信度复活：
        # 实测两条重叠派工都重算、合计 $25，桶却成了 disputed $25 + unstable $25，
        # 最终报告报出一笔根本不存在的存疑金额（#934 交叉 review 第 2 轮）。
        info = recompute.get(key)
        if info is not None:
            cost_source = info["cost_source"]
            cost = info["cost"]
            cost_state = info["cost_state"]
            pstat = info["price_status"]
            psrc = info["price_source"]
        else:
            cost_source = "original"
            cost = rec["cost"]
            cost_state = rec.get("cost_state") or (
                "full" if rec.get("has_cost") else "none")
            pstat = rec.get("price_status") or {}
            psrc = rec.get("price_source")
        in_total = summable.get(key, True)      # 不参与重算的（如身份缺失）照旧计入
        out = rec["out"]
        # 历史记录（无机器标记）没写 agent。实测交叉 review 那一侧在改造前几乎不写
        # 记账行（上周 589 条里只有 2 条，且已被「交叉 review 评论不作记账来源」挡掉），
        # 所以历史记录一律归到主 worker 那一侧；改造后的记录由标记显式带 agent。
        agent = rec.get("agent") or "claude"
        s["wall"] += wall; s["out"] += out
        s["records"] += 1
        s[f"wall_{agent}"] += wall
        s[f"records_{agent}"] += 1
        # 能进「去重合计」的才计入金额；不能的单列披露，**不与上面的合计相加**
        if in_total:
            s["cost"] += cost
            s[f"cost_{agent}"] += cost
        else:
            s["cost_not_summable"] += cost
            s["records_not_summable"] += 1
        s[f"src_{cost_source}"] += 1
        s[f"state_{cost_state}"] += 1
        # 单价可信度：金额分到哪个桶里（GitHub#934 交叉 review 第 1 轮）。
        # ⚠️ 只有进得了「去重合计」的那部分才拆桶——单列的那部分本来就不能相加，
        #    把它的钱也摊进可信度桶里，桶的合计就对不上表头的金额了。
        if in_total:
            for st_name, amt in pstat.items():
                s[f"price_usd_{st_name}"] = s.get(f"price_usd_{st_name}", 0.0) + amt
            # 有金额、却说不出这金额用的是什么可信度的单价（历史评论 / codex 侧人工配价）。
            # 判据是**本条最终采用的金额**有没有桶，不是旧记录有没有写过金额——
            # 重算出 0 元的派工桶是空的，拿旧记录的 has_cost 判会把它算进这里。
            if cost and not pstat:
                s["price_usd_unrated"] = s.get("price_usd_unrated", 0.0) + cost
        if psrc:
            s[f"price_src_{psrc}"] = s.get(f"price_src_{psrc}", 0) + 1
        lc = info.get("log_check") if info else None
        if lc:
            s[f"log_{lc}"] += 1
        # 金额覆盖率：驱动没配单价时**有意**不出金额（见 drivers/token-usage/codex.sh），
        # 采集后就是 0。报告必须能区分「这一侧真的没花钱」和「这一侧的金额没采到」，
        # 否则 0 会被当成事实写成「占成本 0%」（GitHub#932 交叉 review 第 5 轮）。
        #
        # ⚠️ 判据是**金额有没有算出来**（`cost_state != "none"`），不是**金额是不是非零**：
        # 配了单价、但这段估算不足半美分时，驱动会如实写出 `cost_usd=0.00`；
        # 按非零判断会把它算成「没采到」，报告反过来说「该侧未配单价」（#932 第 3 轮）。
        #
        # ⚠️ 而且必须跟着**最终采用的那份金额**走，不能再看旧 footer 写没写
        # （`has_cost`）——上面金额已经改成按日志重算了，覆盖计数留在旧 footer 上就
        # 会自相矛盾（#934 交叉 review 第 3 轮，两个方向都实测过）：
        #   · 旧 footer 没金额、重算出 $25 → 表头写 $25，紧接着却说「1 条没有金额、
        #     成本一栏只含已知金额的那 0 条、真实开销更高」
        #   · 旧 footer 有 $25、重算时模型无价 → 表头直接写 $0，顶部缺金额告警消失
        # `cost_state` 在三条路径上都跟着最终取值：重算走 price_calls 的结果、沿用原值
        # 走记录自己的、没有重算结论的按记录推。所以这里一个判据就够。
        # 旧 footer 的原始证据没有丢，它记在 `cost_footers` 里（上面那段），只作证据
        # 统计，不参与「最终金额有没有」的结论。
        if cost_state != "none":
            s["cost_records"] += 1
            s[f"cost_records_{agent}"] += 1
        durs[w].append(wall)
        if wall >= record.LONG_WINDOW_SECS:
            s["long_windows"] += 1
            long_windows.append({"num": num, "week": w, "wall": wall,
                                 "start": str(rec["start"]), "end": str(rec["end"])})

        # 「模型 + 工具」时长：出报告时才算得出（累计快照是派工结束后才落盘的）
        work = worktime.window_work(rec.get("agent") or "claude",
                                    worktree_of(num), rec["start"], rec["end"])
        if work is None:
            s["work_missing"] += 1
        else:
            s["work"] += work
            s["work_records"] += 1
            s[f"work_{agent}"] += work
            if worktime.misattributed(work, wall):
                s["misattributed"] += 1
                misattributed.append({"num": num, "week": w, "wall": wall,
                                      "work": round(work)})

        if w == target.isoformat():
            p = per_issue[num]
            p["wall"] += wall; p["cost"] += cost
            if work is not None:
                p["work"] += work

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
              "bot", "wall", "work", "cost", "out", "commits", "add", "del",
              "records", "dupes", "footers", "cost_footers", "long_windows",
              "misattributed", "work_records", "work_missing",
              "codex", "sess_med", "backlog",
              # 按 agent 拆分：切换周之后同时纳入交叉 review 那一侧，覆盖面会变大，
              # 所以要能分别给出「仅主 worker」与「两侧合计」，不能混成同口径趋势。
              "wall_claude", "wall_codex", "cost_claude", "cost_codex",
              "work_claude", "work_codex", "records_claude", "records_codex",
              # 有金额的记账条数（分 agent）：报告据此判断占比能不能算
              "cost_records", "cost_records_claude", "cost_records_codex",
              # 金额来源与可信状态（GitHub#934）：
              #   src_*   重算 / 沿用原记录各几条
              #   state_* 价格覆盖三态（full / partial / none）
              #   log_*   日志检验结果（未检出缺失 / 检出缺失 / 覆盖未知 / 真实零调用）
              #   *_not_summable 重叠且证据不足、**不可与上面的合计相加**的那部分
              "src_recomputed", "src_original",
              "state_full", "state_partial", "state_none",
              "log_no_shortfall_detected", "log_shortfall_detected",
              "log_unknown", "log_true_zero",
              "cost_not_summable", "records_not_summable",
              # 单价**可信度**（与 state_* 的「有没有价」是两回事）：金额按桶拆开，
              # 报告据此把「存疑」「未核对」「用参照兜底」分别报出来，不再混成一个数
              "price_usd_corroborated", "price_usd_uncorroborated",
              "price_usd_disputed", "price_usd_unstable",
              "price_usd_reference_only", "price_usd_unrated",
              "price_src_solved", "price_src_configured"]
    weekly = {w: {f: st[w].get(f, 0) for f in FIELDS} for w in weeks}

    tw = target.isoformat()
    tend = target + datetime.timedelta(days=6)

    def issue_of(pn):
        """PR 关联到的真 issue 号；关联不到（或指向另一个 PR）返回 None。"""
        iss = link.get(pn)
        if iss is None:
            return None
        m = meta.get(iss)
        return iss if (m and not m["is_pr"]) else None

    def in_target_week(ts):
        return bool(ts) and monday(loc(ts).date()).isoformat() == tw

    # 上周明细的入选条件（三选一）。第 ② 条是必须的：很多 issue 定完方案就没人再回
    # issue 页了，整周的讨论全发生在它的 PR 上——只看 issue 侧活跃度会把整条工作漏掉。
    #   ① issue 自己当周有讨论
    #   ② 它的关联 PR 当周有讨论
    #   ③ issue 当周关闭（哪怕一条评论都没有）
    seed = set()
    for n in per_issue:
        m = meta.get(n)
        if not m:
            continue
        if m["is_pr"]:
            iss = issue_of(n)
            if iss is not None:
                seed.add(iss)
        else:
            seed.add(n)
    for n, m in meta.items():
        if not m["is_pr"] and in_target_week(m["closed_at"]):
            seed.add(n)

    detail = []
    for n in seed:
        m = meta[n]
        p = per_issue.get(n)
        detail.append({**m, "rounds": p["rounds"] if p else 0,
                       "human": p["human"] if p else 0,
                       "wall": p["wall"] if p else 0,
                       "work": p["work"] if p else 0,
                       "cost": p["cost"] if p else 0})
    # 把每个 issue 的关联 PR 挂上（PR 侧的讨论/耗时并进 issue）
    rev = collections.defaultdict(list)
    for pn in link:
        iss = issue_of(pn)
        if iss is not None:
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
                d["wall"] += pp["wall"];     d["cost"] += pp["cost"]
                d["work"] += pp["work"]
    detail.sort(key=lambda d: -d["wall"])

    # 没有关联 issue 的 PR（多为 chore / 工具链改动）。它们不挂在任何 issue 下，
    # 只看 issue 清单就完全看不见——单列一组，否则这部分工作凭空消失。
    loose = []
    for n, m in meta.items():
        if not m["is_pr"] or issue_of(n) is not None:
            continue
        p = per_issue.get(n)
        if not p and not in_target_week(m["merged_at"]):
            continue
        loose.append({**m, "rounds": p["rounds"] if p else 0,
                      "human": p["human"] if p else 0,
                      "wall": p["wall"] if p else 0,
                      "work": p["work"] if p else 0,
                      "cost": p["cost"] if p else 0})
    loose.sort(key=lambda d: -d["wall"])

    long_windows.sort(key=lambda x: -x["wall"])
    misattributed.sort(key=lambda x: -(x["work"] / max(x["wall"], 1)))
    json.dump({"repo": R, "generated_at": datetime.datetime.now(TZ).isoformat(),
               "price_reference": {"source": price_table.get("reference_source"),
                                  "policy": price_table.get("policy")},
               "switch_week": switch_week(st),
               "long_windows": long_windows, "misattributed": misattributed,
               "target_week": {"start": tw, "end": tend.isoformat()},
               "weeks": weeks, "weekly": weekly, "detail": detail,
               "loose_prs": loose},
              open(a.out, "w"), ensure_ascii=False, indent=1)
    print(f"[ok] {a.out}: 目标周 {tw}~{tend}，{len(weeks)} 周趋势，"
          f"{len(detail)} 条 issue 明细，{len(loose)} 条无 issue 的 PR")

if __name__ == "__main__":
    main()
