#!/usr/bin/env python3
"""出周报 markdown（数据部分）。叙述性解读由 agent 在此基础上补写。"""
import argparse, datetime, json
import os, calendar

def hm(s):
    s=int(s)
    if s>=3600: return f"{s//3600}h{(s%3600)//60:02d}m"
    if s>=60:   return f"{s//60}m"
    return f"{s}s"          # 不足一分钟就给秒，别显示成没意义的 0m

def _subscription_week(monday):
    """某周实付 = Σ（该周每一天所属月份的月费 ÷ 该月天数）。跨月的周自然按天拆开。

    月费只从 WEEKLY_REPORT_SUBSCRIPTION_MONTHLY 读（可以是一个数，也可以是多份订阅
    相加的 JSON 列表）。**没配就返回「未配置」**——不猜、也不拿别处的数字凑。

    ⚠️ **这个值必须以美元填**：这里读的是个裸数字，渲染时无条件加 `$`，报告其余金额
    也全是美元。按人民币月费填进来会被原样当成美元印出去，而且不会有任何报错
    （GigleTutor-Web#931：维护者问「成本单位是人民币还是美元」）。
    """
    raw = os.environ.get("WEEKLY_REPORT_SUBSCRIPTION_MONTHLY", "").strip()
    if not raw:
        return "未配置"
    try:
        v = json.loads(raw)
        monthly = sum(float(x) for x in v) if isinstance(v, list) else float(v)
    except (ValueError, TypeError):
        return "未配置"
    total = 0.0
    for i in range(7):
        d = monday + datetime.timedelta(days=i)
        days_in_month = calendar.monthrange(d.year, d.month)[1]
        total += monthly / days_in_month
    return f"${total:,.0f}"


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--data",required=True); ap.add_argument("--out",required=True)
    ap.add_argument("--asset-url-base",required=True); ap.add_argument("--rev",required=True)
    # 纳入交叉 review 那一侧之后覆盖面变大，跟改算法是两件事，不能混成同口径趋势。
    # 切换后这么多周内，同时给「仅主 worker」和「两侧合计」两组数字。
    ap.add_argument("--parallel-weeks",type=int,default=4)
    a=ap.parse_args()
    D=json.load(open(a.data)); W=D["weeks"]; wk=D["weekly"]; tw=D["target_week"]
    # 缺字段一律按 0：旧的 data.json（新字段上线之前跑出来的）里没有这些键，
    # 直接下标会让整份报告挂掉，而它们本来就该当成「这一项没有」。
    t=lambda f: sum(wk[k].get(f, 0) for k in W)
    cur=wk[tw["start"]]
    prev=wk[W[-2]] if len(W)>1 else cur
    L=[]
    s=datetime.date.fromisoformat(tw["start"]); e=datetime.date.fromisoformat(tw["end"])
    L.append(f"## 📊 上周数据（{s.month}/{s.day} 周一 ~ {e.month}/{e.day} 周日）\n")
    net=cur["add"]-cur["del"]

    # 口径切换那一周：本周起同时发生两处变化——用量按 API 调用去重（驱动侧，只影响
    # 切换之后写下的记录）、纳入交叉 review 那一侧（覆盖面）。这两样都让「上周 vs 前一周」
    # 的时长 / 成本类指标**不是同一把尺子量出来的**，算出来的百分比会把「量得更全了」
    # 读成「干得更多了」。所以在这条边界上，相关指标的变化列给「口径变化」而不是数字；
    # issue / PR / 讨论条数这些真正同口径的指标照常给环比。
    # 切换周是**采集侧给的一份事实**（`switch_week`），不是「窗口里第一个有 codex 记账的周」——
    # 后者会随 10 周窗口每周往后滚一格，把历史上的切换日期越推越晚（GitHub#932 review 第 6 轮）。
    # 报告与趋势图读同一个字段，保证两边说的是同一周。拿不到就什么都不标。
    first_codex=D.get("switch_week")
    at_switch=(first_codex is not None and tw["start"]==first_codex)

    def delta(a_, b_):
        return "—" if not b_ else f"{(a_ - b_) / b_ * 100:+.0f}%"

    L.append("| 指标 | 上周 | 前一周 | 变化 |")
    L.append("|---|---|---|---|")

    def row(name, cur_v, prev_v, fm=lambda v: f"{v:,.0f}", cross=False):
        chg="—（口径变化，不可比）" if (cross and at_switch) else delta(cur_v, prev_v)
        L.append(f"| {name} | {fm(cur_v)} | {fm(prev_v)} | {chg} |")

    for name, f in (("新提 issue", "iss_open"), ("关闭 issue", "iss_closed"),
                    ("合并 PR", "pr_merged"), ("讨论条数", "comments"),
                    ("你发的条数", "human")):
        row(name, cur[f], prev[f])
    row("主干净增代码行", net, prev["add"] - prev["del"])
    row("AI 总耗时（含等待）", cur["wall"], prev["wall"], hm, cross=True)
    if cur.get("work_records") or prev.get("work_records"):
        row("其中模型 + 工具（不含等待）", cur["work"], prev["work"], hm, cross=True)
    # 「折算价值」不是「成本」：本机两侧都是包月订阅，没有按 token 出的账单（见
    # docs/architecture.md）。这一栏回答的是「这些活按公开标价买要花多少钱」，
    # 实付是另一行的固定订阅费。两者**口径不同、不相除**（GitHub#934 的 Q1=A）。
    row("折算价值（美元，按公开标价）", cur["cost"], prev["cost"],
        lambda v: f"${v:,.0f}", cross=True)
    # 实付：某周 = Σ（该周每一天所属月份的月费 ÷ 该月天数）。按天摊，跨月的周自然拆开。
    # 月费只认配置，**没配就显示「未配置」**，不猜。
    # ⚠️ 两列各按**各自那一周的起点**摊（#934 交叉 review 第 7 轮）：只算一次再填两格，
    # 跨月的周会把本周数值复制到前周。实测月费 300、目标周 2026-03-02：本周 7 天全在
    # 3 月（31 天）= $68，前周 2026-02-23 是 6 天 2 月 + 1 天 3 月 = $74，旧写法两格都是 $68。
    _cur_monday = datetime.date.fromisoformat(tw["start"])
    _prev_monday = _cur_monday - datetime.timedelta(days=7)
    L.append(f"| 实付（美元，订阅月费按天摊到本周） | {_subscription_week(_cur_monday)} | "
             f"{_subscription_week(_prev_monday)} | — |")
    if cur.get("records_not_summable"):
        L.append(f"| 另有：重叠且证据不足，**无法去重合计** | "
                 f"${cur.get('cost_not_summable', 0):,.0f} · {cur['records_not_summable']:.0f} 条 | — | — |")
    L.append(f"| 周末未关闭 issue 存量 | {cur['backlog']:,.0f} | {prev['backlog']:,.0f} | — |\n")

    # 金额覆盖：没配单价的一侧**有意**不出金额，采集后是 0。不说清楚的话，
    # 上面那个成本数字会被当成「全部开销」。
    miss=cur.get("records",0)-cur.get("cost_records",0)
    if miss > 0:
        miss_cd=cur.get("records_codex",0)-cur.get("cost_records_codex",0)
        extra=f"（其中交叉 review 那一侧 {miss_cd:.0f} 条）" if miss_cd > 0 else ""
        L.append(f"> 本周 {cur['records']:.0f} 条记账里有 **{miss:.0f} 条没有金额**{extra}，"
                 f"成本一栏**只含已知金额的那 {cur.get('cost_records',0):.0f} 条**，真实开销更高。\n")

    # ── 交叉 review 那一侧占成本多少：**常驻**，不随四周过渡期结束而消失 ──
    # #931 Q3 已拍板「合并一个总数 + 括注 codex 占比」，那条没有截止时间；四周过渡期
    # 管的只是「两组口径并列的那张表」。原来把这两件事绑在同一个 if 里，过渡期一结束
    # 占比就整个不见了（GitHub#932 交叉 review 复现：switch_week=2024-12-30、目标周
    # 2025-01-27、两侧金额齐全，全文找不到应有的 33%）。
    def money(v, have, total):
        txt=f"${v:,.0f}"
        if total and have < total:
            txt += f"（仅 {have:.0f}/{total:.0f} 条有金额）"
        return txt

    rc_cl, cc_cl = cur.get('records_claude', 0), cur.get('cost_records_claude', 0)
    rc_cd, cc_cd = cur.get('records_codex', 0), cur.get('cost_records_codex', 0)
    # 新口径是否已经生效：配了切换周、或者本周确实有交叉 review 记账。都没有就还没上线，
    # 这段整个不出（现在真实数据就是这种状态）。
    codex_live = bool(first_codex) or bool(rc_cd)
    if codex_live:
        if rc_cd == 0:
            L.append("> 本周交叉 review 那一侧**没有记账记录**（那一侧本周没产出，或它的记账还没覆盖到），"
                     "所以上面的成本里不含它。\n")
        elif cc_cd == 0:
            # 金额缺失时**不能**输出「占成本 X%」：驱动没配单价时是有意不出金额，
            # 采集后的 0 是「没采到」而不是「没花钱」。
            L.append(f"> 交叉 review 那一侧本周 {rc_cd:.0f} 条记账**一条都没带金额**"
                     "（该侧未配单价，驱动如实不出金额），因此**它占成本多少算不出来——不是 0%**。"
                     "上面的成本只含已知金额的记录。\n")
        elif cc_cd < rc_cd or cc_cl < rc_cl:
            sh=cur['cost_codex']/cur['cost']*100 if cur['cost'] else 0
            L.append(f"> **按已知金额**算，交叉 review 那一侧占 {sh:.0f}%——"
                     f"分母只含带金额的记账（该侧 {cc_cd:.0f}/{rc_cd:.0f} 条、"
                     f"主 worker {cc_cl:.0f}/{rc_cl:.0f} 条），其余未计，"
                     "**不是完整的两侧占比**。\n")
        elif cur['cost']:
            # 金额齐全。注意「占 0%」在这里是**估算按分舍入后的 0**，不是账单为零——
            # 驱动配了单价、但那一侧这周的估算不足半美分时会如实写 `cost_usd=0.00`。
            zero=("——该侧 %d 条记账都带了金额，合计按标价估算为 $0（金额按分舍入，"
                  "不代表真实账单为零）" % rc_cd) if cur['cost_codex'] == 0 else ""
            L.append(f"> 其中交叉 review 那一侧占成本 {cur['cost_codex']/cur['cost']*100:.0f}%"
                     f"（两侧 {cur['records']:.0f} 条记账金额齐全）{zero}。\n")
        else:
            L.append(f"> 两侧本周 {cur['records']:.0f} 条记账**都带了金额**，"
                     "但按标价估算合计为 $0（金额按分舍入后为 0），占比无意义——"
                     "这不代表真实账单为零。\n")

    # ── 切换后连续四周：两组口径并列，避免把「覆盖面变大」读成「产出变多」 ──
    # 出不出这张表**只由配置的切换日期 + 周数差决定**。原来还要求「本周得有 codex 记账」，
    # 于是过渡期里某一周没人做 review（正常情形）就整张表消失（GitHub#932 交叉 review
    # 复现：switch_week=2025-01-13、目标周 2025-01-20 只有 claude，表和「第 2 / 4 周」全没了）。
    # 那一周两行数值相同，照样要出——它本身就是「这周该侧没有产出」这个事实。
    if first_codex:
        # 过渡期按**配置的切换日期**算周数差，不按它在窗口里的下标——切换周可能已经滚出窗口。
        since=(datetime.date.fromisoformat(tw["start"])
               - datetime.date.fromisoformat(first_codex)).days // 7
        if 0 <= since < a.parallel_weeks:
            L.append(f"> **口径切换过渡期（第 {since+1} / {a.parallel_weeks} 周）**：{first_codex} 那周起统计同时发生两处变化"
                     f"——用量按 API 调用去重、纳入交叉 review 那一侧。两者叠加，**与切换前的周不可直接比**。\n")
            L.append("| 口径 | AI 总耗时（含等待） | 模型 + 工具 | 成本 | 记账条数 |")
            L.append("|---|---|---|---|---|")
            L.append(f"| 仅主 worker·新口径 | {hm(cur['wall_claude'])} | {hm(cur['work_claude'])} | "
                     f"{money(cur['cost_claude'], cc_cl, rc_cl)} | {rc_cl:.0f} |")
            L.append(f"| 两侧合计·新口径 | {hm(cur['wall'])} | {hm(cur['work'])} | "
                     f"{money(cur['cost'], cur.get('cost_records', 0), cur['records'])} | {cur['records']:.0f} |")
            if rc_cd == 0:
                L.append("\n本周交叉 review 那一侧**没有记账记录**，所以两行数值相同——"
                         "这不代表口径回退了，只是那一侧本周没有产出。\n")

    czn={d["num"] for d in D["detail"]
         if d["closed_at"] and d["closed_at"][:10]>=tw["start"]}

    def worked(d):
        """这一周在它身上**确实记到账了** —— 不是只看「当周有没有讨论」。

        跨周派工（周日开工、周一才发唯一那条完工评论）按开工周入账，可是那一周
        它一条评论都没有，`rounds` 就是 0。只按 `rounds > 0` 过滤的话，这条工作
        已经进了当周的总时长和成本，却从明细里整条消失（GitHub#932 交叉 review）。
        所以入选条件再加一条「当周记到了时长或金额」。
        **轮数照实写 0**，不为了留住明细去伪造它。
        """
        return d["rounds"] > 0 or d["wall"] > 0 or d["cost"] > 0

    closed=[d for d in D["detail"] if d["num"] in czn]
    active=[d for d in D["detail"] if d["num"] not in czn and worked(d)]
    loose=[d for d in D.get("loose_prs",[]) if worked(d) or d["merged_at"]]
    L.append(f"### 上周收口的 issue（{len(closed)} 个）\n")
    L.append("| # | 标题 | 轮数（你参与） | AI 总耗时 | PR |")
    L.append("|---|---|---|---|---|")
    for d in closed:
        pr=" ".join(f"#{p['num']}{'（已合并）' if p['merged_at'] else ''}" for p in d["prs"]) or "—"
        L.append(f"| #{d['num']} | {d['title'][:60]} | {d['rounds']:.0f}（你 {d['human']:.0f}） | {hm(d['wall'])} | {pr} |")
    L.append(f"\n### 上周有推进但没关的 issue（{len(active)} 个）\n")
    L.append("| # | 标题 | 轮数（你参与） | AI 总耗时 | 当前 label |")
    L.append("|---|---|---|---|---|")
    for d in active:
        L.append(f"| #{d['num']} | {d['title'][:60]} | {d['rounds']:.0f}（你 {d['human']:.0f}） | {hm(d['wall'])} | {', '.join(d['labels']) or '—'} |")

    if loose:
        L.append(f"\n### 上周没有对应 issue 的 PR（{len(loose)} 个）\n")
        L.append("> 多为 chore / 工具链改动。它们不挂在任何 issue 下，单列在这里，"
                 "否则只看 issue 清单会完全看不见这部分工作。\n")
        L.append("| PR | 标题 | 轮数（你参与） | AI 总耗时 | 状态 |")
        L.append("|---|---|---|---|---|")
        for d in loose:
            stt="已合并" if d["merged_at"] else ("已关闭" if d["closed_at"] else "开着")
            L.append(f"| #{d['num']} | {d['title'][:60]} | {d['rounds']:.0f}（你 {d['human']:.0f}） "
                     f"| {hm(d['wall'])} | {stt} |")

    L.append(f"\n---\n\n## 📈 最近 {len(W)} 周趋势\n")
    L.append(f"![交付趋势]({a.asset_url_base}/delivery-{a.rev}.png)\n")
    L.append(f"![投入趋势]({a.asset_url_base}/effort-{a.rev}.png)\n")
    L.append("### 逐周数据\n")
    L.append("| 周 | 新提 issue | 关闭 issue | 合并 PR | 净增代码行 | 讨论条数 | 你发的 | AI 总耗时 | 模型+工具 | 成本（美元） |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    for k in W:
        v=wk[k]; d0=datetime.date.fromisoformat(k); d1=d0+datetime.timedelta(days=6)
        mark="**" if k==tw["start"] else ""
        # 切换周打个记号：它左右两侧的时长 / 成本不是同一把尺子量的，不能连着读趋势
        flag=" †" if k==first_codex else ""
        L.append(f"| {mark}{d0.month}/{d0.day}–{d1.month}/{d1.day}{mark}{flag} | {v['iss_open']:.0f} | {v['iss_closed']:.0f} | "
                 f"{v['pr_merged']:.0f} | {v['add']-v['del']:,} | {v['comments']:.0f} | {v['human']:.0f} | "
                 f"{hm(v['wall'])} | {hm(v['work']) if v.get('work_records') else '—'} | ${v['cost']:,.0f} |")
    if first_codex in W:
        fd=datetime.date.fromisoformat(first_codex)
        L.append(f"\n† {fd.month}/{fd.day} 那周起口径改了（用量按 API 调用去重 + 纳入交叉 review 那一侧）。"
                 "**它前后的「AI 时长 / 模型+工具 / 成本」三列不是同一把尺子量的**，别连成一条趋势读；"
                 "issue / PR / 讨论条数这几列不受影响。")
    tn=sum(wk[k]['add']-wk[k]['del'] for k in W)
    L.append(f"\n**{len(W)} 周合计**：新提 issue {t('iss_open'):.0f} / 关闭 {t('iss_closed'):.0f}，"
             f"合并 PR {t('pr_merged'):.0f} 个，净增 {tn:,} 行，讨论 {t('comments'):.0f} 条"
             f"（你 {t('human'):.0f} 条，{t('human')/t('comments')*100 if t('comments') else 0:.0f}%），"
             f"AI 总耗时 {t('wall')/3600:.0f} 小时，成本 ${t('cost'):,.0f} 美元。\n")
    lw=[x for x in D.get("long_windows",[]) if x["week"]==tw["start"]]
    ms=[x for x in D.get("misattributed",[]) if x["week"]==tw["start"]]
    if lw or ms:
        L.append("<details>\n<summary><b>🔎 需要人看一眼的记录（只列出，不影响上面任何数字）</b></summary>\n")
        if lw:
            L.append(f"\n**总耗时 ≥ 4 小时的派工（{len(lw)} 条）**。只是列出来，"
                     "**不判断**它是卡住了还是真的跑了很久：\n")
            L.append("| # | 开始 | 完工 | 总耗时 |")
            L.append("|---|---|---|---|")
            for x in lw:
                L.append(f"| #{x['num']} | {x['start'][:19]} | {x['end'][:19]} | {hm(x['wall'])} |")
        if ms:
            L.append(f"\n**「模型 + 工具」明显超过自身总耗时的派工（{len(ms)} 条）**。"
                     "成因是它紧跟在一段长工作之后发了条短评论，差分把前面那段算到了它头上——"
                     "**位置挪错，不是凭空多出来的工作**。按原样计入（错位在合计上基本守恒，"
                     "封顶反而会抹掉真实工时），看单个 issue 耗时时请对照本清单：\n")
            L.append("| # | 总耗时 | 模型 + 工具 | 倍数 |")
            L.append("|---|---|---|---|")
            for x in ms:
                L.append(f"| #{x['num']} | {hm(x['wall'])} | {hm(x['work'])} | {x['work']/max(x['wall'],1):.1f}× |")
        L.append("\n</details>\n")

    # ── 单价可信度：金额按「这个价站不站得住」分桶（GitHub#934 交叉 review 第 1 轮）──
    # 不带到这里的后果：用参照兜底的存疑金额，和已与参照核对过的金额，在报告上长得
    # 一模一样，设计里承诺的「报红」就不存在。
    _TRUST = [
        ("disputed",       "⚠️ 与参照冲突（存疑）", "反解值与外部参照对不上，**两边都没有被判为对**，这部分金额只能当线索看"),
        ("unstable",       "反解不出、用外部参照兜底",   "本机样本不足以解出这个单价，取的是参照价，**没有本机证据支持**"),
        ("uncorroborated", "反解稳定但无参照可比",       "解得稳，但没有可比的外部参照，属候选估算"),
        ("reference_only", "直接取参照价",               "加速档没有可反解的样本，直接用参照价"),
        ("corroborated",   "反解稳定且与参照一致",       "两个独立来源对上了 —— 只说明**和那份参照一致**，不等于已证明为真值"),
        ("unrated",        "说不出可信度",               "历史评论是旧驱动那张**过期价目表**算的（实测高 193%），交叉 review 那一侧则是人工配置的单价，两者都没有可信度可言"),
    ]
    # ⚠️ 「有没有这一桶」由**金额本身**决定，不由显示取整决定（#934 交叉 review 第 7 轮）。
    # 原来按 `round(...) != 0` 筛，$0.10 的存疑金额直接消失，还反过来输出「本次区间没有
    # 算出金额，无从谈可信度」—— 把「显示成零」说成了「没算出来」，报红也跟着没了。
    # 小额改用能看见的写法：≥ $1 取整、不足 $1 显示到分、不足 1 分写「< $0.01」。
    def _usd_small(v):
        if v == 0:
            return "$0"
        if abs(v) < 0.01:
            return "< $0.01"
        if abs(v) < 1:
            return f"${v:,.2f}"
        return f"${v:,.0f}"

    _parts = [f"**{lbl}** {_usd_small(t('price_usd_' + k))}（{why}）"
              for k, lbl, why in _TRUST if t("price_usd_" + k) != 0]
    _ref = (D.get("price_reference") or {}).get("source") or "未记录"
    price_trust = ("；".join(_parts) + "。" if _parts else "本次区间没有算出金额，无从谈可信度。") + \
        f"参照出处：`{_ref}` —— 是**本机缓存的一份公开价目**，本次**没有联网核验**；参照若已过期，反解值与它会一起错，这套机制发现不了。" + \
        f"另：本 worker 那一侧的单价是**本机反解**的（{t('price_src_solved'):.0f} 条），交叉 review 那一侧是**人工配置**的（{t('price_src_configured'):.0f} 条）—— 后者没经过任何交叉核对，两侧不是同一把尺子。"

    L.append("<details>\n<summary><b>📐 数据口径 & 已知误差</b></summary>\n")
    L.append(f"""
- **金额单位：一律是美元（USD），不是人民币。** 上面所有 `$` 数字、逐周表的成本列、趋势图里的花销面板都是美元。单价来源是按**美元 / 百万 token** 计的公开标价（本 worker 那一侧从本机 CLI 记账反解、交叉 review 那一侧人工配置），本工具**不做任何汇率换算**。注意：正文解读里若引用了某个 issue 自己算出的人民币金额（形如 `¥…`），那是那条 issue 的口径，与本表无关。
- **时间切片**：周一 00:00 ~ 周日 24:00（北京时间）。
- **讨论条数**：GitHub 上 issue + PR 的全部评论；「你发的」= 非 `*-bot` 账号发的条数。
- **记账来源**：只认评论**末尾**那条机器写的记录；历史评论（还没有机器记录的）只认「记账行 + 紧随其后的 token 行」，且必须是机器人发的、不是交叉 review 评论。**不再拿正则扫整条评论正文**——正文里描述别的东西（如某测试耗时多少毫秒、SQL 片段里的 `($1)`）曾被当成记账混进统计。
- **按派工去重**：一次派工的身份是 **(worktree, 开始时刻)** 两项，**不含完工时刻**——记账行里的时长 / 金额 / token 都是从开始起的**累计值**，而「完工」只是写那条评论的时刻，同一次派工发多条评论就是多个越来越大的累计快照。所以同一身份只入账一次，并取**完工最晚**的那条（累计值最完整）。本次区间折叠了 {t('dupes'):.0f} 条这样的快照。
- **AI 总耗时（含等待）**：一次派工从「开工」到「完工」之间**走过的钟点时间**，也就是记账行里的「完工 − 开始」。它**把中间的干等也算进去**——会话卡住不动的那几个钟头照样计入，所以它回答的是「这件事占了多长时间」，**不是「AI 真干了多少活」**。
- **模型 + 工具**：AI 自己记录的模型调用 + 工具执行时间，**不含等待**，这条才接近「真干了多少活」；出报告时按派工窗口从本机 agent 日志取。本次区间 {t('work_records'):.0f} 条算得出、{t('work_missing'):.0f} 条拿不到（日志已不在或窗口配不上），拿不到的不计入该项。**这是估算，不是精确工时**：窗口归属靠快照前后配对，逐条可能错位。
- **口径切换周**：{'配置为 ' + first_codex + '（那周起用量按 API 调用去重、纳入交叉 review 那一侧；它前后的时长 / 成本不是同一把尺子量的）。' if first_codex else ('**未配置**——所以本报告不标切换周、不画切换竖线、也不出过渡期并列块，环比照常给。本次区间里交叉 review 那一侧**已经有记账**，说明新口径已经上线，请把 `WEEKLY_REPORT_SWITCH_WEEK` 设成它上线那一周内的任意一天。' if t('records_codex') else '未配置，且本次区间里交叉 review 那一侧还没有记账 —— 新口径尚未上线，暂时无需配置。')}
- **金额来源**：本次区间 {t('src_recomputed'):.0f} 条按本机日志**重算**、{t('src_original'):.0f} 条**沿用记录里的原值**。重算只在「本机有这次派工的日志且通过检验」时才做，**不按周划线**——所以**同一个历史周的数值会随本机日志被清理而改变**，重跑可能不一样（报告生成时间见文末）。日志检验只能**证伪**（比记录里少就是确证缺失），**证明不了日志完整**：记录本身可能就没看全，后来新增的调用也可能把被删调用的 token 补上。{f"其中 {t('log_shortfall_detected'):.0f} 条检出缺失、{t('log_unknown'):.0f} 条覆盖未知，这些一律沿用原值、不拿残缺的重算值顶替。" if (t('log_shortfall_detected') or t('log_unknown')) else ""}
- **不可去重合计的部分**：{f"本次区间另有 **{t('records_not_summable'):.0f} 条**派工的窗口互相重叠、且组内有沿用原值的，合计 ${t('cost_not_summable'):,.0f}——原值是驱动按自己窗口、自己那套价目算的累计值，和重算值**不是同一个口径**，两者直接相加会把共用的调用算两遍。所以这部分**单列，不可与上面的成本相加**。" if t('records_not_summable') else "本周没有「重叠且证据不足」的派工，成本栏就是全部。"}
- **单价覆盖**：本次区间 {t('state_full'):.0f} 条金额完整、{t('state_partial'):.0f} 条**只算了一部分用量**（有的模型、或同一模型里的某一项没有单价，那部分没计进金额，所以金额必定偏低）、{t('state_none'):.0f} 条一条都算不出。
- **单价可信度**（说的是「这个价站不站得住」，跟上一条「有没有价」是两回事）：{price_trust}
{f"（其中交叉 review 那一侧 {t('records_codex')-t('cost_records_codex'):.0f} 条）" if t('records_codex')-t('cost_records_codex') else ""}；没金额的**不计入**，所以总额偏低。**缺金额 ≠ 没花钱**：某一侧没配单价时驱动是有意不出金额的，报告里也因此不会给出它的成本占比。
- **明细的入选口径**：issue 自己当周有讨论 **或** 它的关联 PR 当周有讨论 **或** 当周关闭 **或** 当周在它身上记到了时长 / 金额（跨周派工——周日开工、周一才发完工评论——按开工周入账，那一周它的讨论条数确实是 0，但工作已经计进当周总数；轮数照实显示 0，不为留住明细伪造）。很多 issue 定完方案后讨论全发生在 PR 上，只看 issue 侧活跃度会把整条工作漏掉。没有关联 issue 的 PR（chore / 工具链）单列一组。
- **代码行数**：`origin/main` 上当周提交的「新增 − 删除」，含自动生成文件与依赖锁文件，是工作量的粗略代理。
- **提交数不适合看趋势**（因此未入图）：合并方式改成 squash 后，一个 PR 只留一个提交，提交数会断崖式下降，那是记账方式变了而非产出变了。
- **数据生成时间**：{D['generated_at'][:19].replace('T',' ')}，由 `scripts/weekly-report/` 自动产出。
""")
    L.append("</details>")
    open(a.out,"w").write("\n".join(L)+"\n")
    print(f"[ok] {a.out}")

if __name__=="__main__":
    main()
