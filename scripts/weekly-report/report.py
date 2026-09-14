#!/usr/bin/env python3
"""出周报 markdown（数据部分）。叙述性解读由 agent 在此基础上补写。"""
import argparse, datetime, json

def hm(s):
    s=int(s)
    if s>=3600: return f"{s//3600}h{(s%3600)//60:02d}m"
    if s>=60:   return f"{s//60}m"
    return f"{s}s"          # 不足一分钟就给秒，别显示成没意义的 0m

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--data",required=True); ap.add_argument("--out",required=True)
    ap.add_argument("--asset-url-base",required=True); ap.add_argument("--rev",required=True)
    # 纳入交叉 review 那一侧之后覆盖面变大，跟改算法是两件事，不能混成同口径趋势。
    # 切换后这么多周内，同时给「仅主 worker」和「两侧合计」两组数字。
    ap.add_argument("--parallel-weeks",type=int,default=4)
    a=ap.parse_args()
    D=json.load(open(a.data)); W=D["weeks"]; wk=D["weekly"]; tw=D["target_week"]
    t=lambda f: sum(wk[k][f] for k in W)
    cur=wk[tw["start"]]
    prev=wk[W[-2]] if len(W)>1 else cur
    L=[]
    s=datetime.date.fromisoformat(tw["start"]); e=datetime.date.fromisoformat(tw["end"])
    L.append(f"## 📊 上周数据（{s.month}/{s.day} 周一 ~ {e.month}/{e.day} 周日）\n")
    net=cur["add"]-cur["del"]
    def delta(a_, b_):
        return "—" if not b_ else f"{(a_ - b_) / b_ * 100:+.0f}%"

    L.append("| 指标 | 上周 | 前一周 | 变化 |")
    L.append("|---|---|---|---|")

    def row(name, cur_v, prev_v, fm=lambda v: f"{v:,.0f}"):
        L.append(f"| {name} | {fm(cur_v)} | {fm(prev_v)} | {delta(cur_v, prev_v)} |")

    for name, f in (("新提 issue", "iss_open"), ("关闭 issue", "iss_closed"),
                    ("合并 PR", "pr_merged"), ("讨论条数", "comments"),
                    ("你发的条数", "human")):
        row(name, cur[f], prev[f])
    row("主干净增代码行", net, prev["add"] - prev["del"])
    row("AI 工作时长（墙上）", cur["wall"], prev["wall"], hm)
    if cur.get("work_records") or prev.get("work_records"):
        row("其中模型 + 工具", cur["work"], prev["work"], hm)
    row("成本（按调用去重后的标价估算）", cur["cost"], prev["cost"], lambda v: f"${v:,.0f}")
    L.append(f"| 周末未关闭 issue 存量 | {cur['backlog']:,.0f} | {prev['backlog']:,.0f} | — |\n")

    # 切换周之后的过渡期：两组口径并列，避免把「覆盖面变大」读成「产出变多」
    first_codex=next((k for k in W if wk[k].get("records_codex")), None)
    if first_codex and cur.get("records_codex"):
        since=W.index(tw["start"])-W.index(first_codex)
        if since < a.parallel_weeks:
            L.append(f"> **口径切换过渡期（第 {since+1} / {a.parallel_weeks} 周）**：本周起统计同时发生两处变化"
                     f"——用量按 API 调用去重、纳入交叉 review 那一侧。两者叠加，**与切换前的周不可直接比**。\n")
            L.append("| 口径 | AI 工作时长（墙上） | 模型 + 工具 | 成本 | 记账条数 |")
            L.append("|---|---|---|---|---|")
            L.append(f"| 仅主 worker·新口径 | {hm(cur['wall_claude'])} | {hm(cur['work_claude'])} | "
                     f"${cur['cost_claude']:,.0f} | {cur['records_claude']:.0f} |")
            L.append(f"| 两侧合计·新口径 | {hm(cur['wall'])} | {hm(cur['work'])} | "
                     f"${cur['cost']:,.0f} | {cur['records']:.0f} |")
            share=cur['cost_codex']/cur['cost']*100 if cur['cost'] else 0
            L.append(f"\n其中交叉 review 那一侧占成本 {share:.0f}%。\n")

    czn={d["num"] for d in D["detail"]
         if d["closed_at"] and d["closed_at"][:10]>=tw["start"]}
    closed=[d for d in D["detail"] if d["num"] in czn]
    active=[d for d in D["detail"] if d["num"] not in czn and d["rounds"]>0]
    loose=[d for d in D.get("loose_prs",[]) if d["rounds"]>0 or d["merged_at"]]
    L.append(f"### 上周收口的 issue（{len(closed)} 个）\n")
    L.append("| # | 标题 | 轮数（你参与） | AI 耗时（墙上） | PR |")
    L.append("|---|---|---|---|---|")
    for d in closed:
        pr=" ".join(f"#{p['num']}{'（已合并）' if p['merged_at'] else ''}" for p in d["prs"]) or "—"
        L.append(f"| #{d['num']} | {d['title'][:60]} | {d['rounds']:.0f}（你 {d['human']:.0f}） | {hm(d['wall'])} | {pr} |")
    L.append(f"\n### 上周有推进但没关的 issue（{len(active)} 个）\n")
    L.append("| # | 标题 | 轮数（你参与） | AI 耗时（墙上） | 当前 label |")
    L.append("|---|---|---|---|---|")
    for d in active:
        L.append(f"| #{d['num']} | {d['title'][:60]} | {d['rounds']:.0f}（你 {d['human']:.0f}） | {hm(d['wall'])} | {', '.join(d['labels']) or '—'} |")

    if loose:
        L.append(f"\n### 上周没有对应 issue 的 PR（{len(loose)} 个）\n")
        L.append("> 多为 chore / 工具链改动。它们不挂在任何 issue 下，单列在这里，"
                 "否则只看 issue 清单会完全看不见这部分工作。\n")
        L.append("| PR | 标题 | 轮数（你参与） | AI 耗时（墙上） | 状态 |")
        L.append("|---|---|---|---|---|")
        for d in loose:
            stt="已合并" if d["merged_at"] else ("已关闭" if d["closed_at"] else "开着")
            L.append(f"| #{d['num']} | {d['title'][:60]} | {d['rounds']:.0f}（你 {d['human']:.0f}） "
                     f"| {hm(d['wall'])} | {stt} |")

    L.append(f"\n---\n\n## 📈 最近 {len(W)} 周趋势\n")
    L.append(f"![交付趋势]({a.asset_url_base}/delivery-{a.rev}.png)\n")
    L.append(f"![投入趋势]({a.asset_url_base}/effort-{a.rev}.png)\n")
    L.append("### 逐周数据\n")
    L.append("| 周 | 新提 issue | 关闭 issue | 合并 PR | 净增代码行 | 讨论条数 | 你发的 | AI 时长（墙上） | 模型+工具 | 成本 |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    for k in W:
        v=wk[k]; d0=datetime.date.fromisoformat(k); d1=d0+datetime.timedelta(days=6)
        mark="**" if k==tw["start"] else ""
        L.append(f"| {mark}{d0.month}/{d0.day}–{d1.month}/{d1.day}{mark} | {v['iss_open']:.0f} | {v['iss_closed']:.0f} | "
                 f"{v['pr_merged']:.0f} | {v['add']-v['del']:,} | {v['comments']:.0f} | {v['human']:.0f} | "
                 f"{hm(v['wall'])} | {hm(v['work']) if v.get('work_records') else '—'} | ${v['cost']:,.0f} |")
    tn=sum(wk[k]['add']-wk[k]['del'] for k in W)
    L.append(f"\n**{len(W)} 周合计**：新提 issue {t('iss_open'):.0f} / 关闭 {t('iss_closed'):.0f}，"
             f"合并 PR {t('pr_merged'):.0f} 个，净增 {tn:,} 行，讨论 {t('comments'):.0f} 条"
             f"（你 {t('human'):.0f} 条，{t('human')/t('comments')*100 if t('comments') else 0:.0f}%），"
             f"AI 墙上 {t('wall')/3600:.0f} 小时，成本 ${t('cost'):,.0f}。\n")
    lw=[x for x in D.get("long_windows",[]) if x["week"]==tw["start"]]
    ms=[x for x in D.get("misattributed",[]) if x["week"]==tw["start"]]
    if lw or ms:
        L.append("<details>\n<summary><b>🔎 需要人看一眼的记录（只列出，不影响上面任何数字）</b></summary>\n")
        if lw:
            L.append(f"\n**墙上时长 ≥ 4 小时的派工（{len(lw)} 条）**。只是列出来，"
                     "**不判断**它是卡住了还是真的跑了很久：\n")
            L.append("| # | 开始 | 完工 | 墙上时长 |")
            L.append("|---|---|---|---|")
            for x in lw:
                L.append(f"| #{x['num']} | {x['start'][:19]} | {x['end'][:19]} | {hm(x['wall'])} |")
        if ms:
            L.append(f"\n**「模型 + 工具」明显超过自身墙上时长的派工（{len(ms)} 条）**。"
                     "成因是它紧跟在一段长工作之后发了条短评论，差分把前面那段算到了它头上——"
                     "**位置挪错，不是凭空多出来的工作**。按原样计入（错位在合计上基本守恒，"
                     "封顶反而会抹掉真实工时），看单个 issue 耗时时请对照本清单：\n")
            L.append("| # | 墙上时长 | 模型 + 工具 | 倍数 |")
            L.append("|---|---|---|---|")
            for x in ms:
                L.append(f"| #{x['num']} | {hm(x['wall'])} | {hm(x['work'])} | {x['work']/max(x['wall'],1):.1f}× |")
        L.append("\n</details>\n")

    L.append("<details>\n<summary><b>📐 数据口径 & 已知误差</b></summary>\n")
    L.append(f"""
- **时间切片**：周一 00:00 ~ 周日 24:00（北京时间）。
- **讨论条数**：GitHub 上 issue + PR 的全部评论；「你发的」= 非 `*-bot` 账号发的条数。
- **记账来源**：只认评论**末尾**那条机器写的记录；历史评论（还没有机器记录的）只认「记账行 + 紧随其后的 token 行」，且必须是机器人发的、不是交叉 review 评论。**不再拿正则扫整条评论正文**——正文里描述别的东西（如某测试耗时多少毫秒、SQL 片段里的 `($1)`）曾被当成记账混进统计。
- **按派工去重**：同一次派工（同一 worktree + 同一起止时刻）发多条评论时只入账一次，本次区间折叠了 {t('dupes'):.0f} 条重复。
- **AI 工作时长（墙上）**：记账行里「完工 − 开始」。它**包含**那段派工里的等待——会话卡住时照算。
- **模型 + 工具**：agent 自己记录的模型调用 + 工具执行时间，**不含等待**；出报告时按派工窗口从本机 agent 日志取。本次区间 {t('work_records'):.0f} 条算得出、{t('work_missing'):.0f} 条拿不到（日志已不在或窗口配不上），拿不到的不计入该项。**这是估算，不是精确工时**：窗口归属靠快照前后配对，逐条可能错位。
- **成本**：按调用去重后的**标价估算**，**计价偏差尚未核实**——不是实际账单。本次区间有 {t('footers')-t('cost_footers'):.0f} 条记录没有金额，未计入，总额偏低。
- **明细的入选口径**：issue 自己当周有讨论 **或** 它的关联 PR 当周有讨论 **或** 当周关闭。很多 issue 定完方案后讨论全发生在 PR 上，只看 issue 侧活跃度会把整条工作漏掉。没有关联 issue 的 PR（chore / 工具链）单列一组。
- **代码行数**：`origin/main` 上当周提交的「新增 − 删除」，含自动生成文件与依赖锁文件，是工作量的粗略代理。
- **提交数不适合看趋势**（因此未入图）：合并方式改成 squash 后，一个 PR 只留一个提交，提交数会断崖式下降，那是记账方式变了而非产出变了。
- **数据生成时间**：{D['generated_at'][:19].replace('T',' ')}，由 `scripts/weekly-report/` 自动产出。
""")
    L.append("</details>")
    open(a.out,"w").write("\n".join(L)+"\n")
    print(f"[ok] {a.out}")

if __name__=="__main__":
    main()
