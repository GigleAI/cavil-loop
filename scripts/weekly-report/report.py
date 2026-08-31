#!/usr/bin/env python3
"""出周报 markdown（数据部分）。叙述性解读由 agent 在此基础上补写。"""
import argparse, datetime, json

def hm(s):
    s=int(s)
    return f"{s//3600}h{(s%3600)//60:02d}m" if s>=3600 else f"{s//60}m"

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--data",required=True); ap.add_argument("--out",required=True)
    ap.add_argument("--asset-url-base",required=True); ap.add_argument("--rev",required=True)
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
    row("AI 工作时长", cur["secs"], prev["secs"], hm)
    row("成本（API 标价折算）", cur["cost"], prev["cost"], lambda v: f"${v:,.0f}")
    L.append(f"| 周末未关闭 issue 存量 | {cur['backlog']:,.0f} | {prev['backlog']:,.0f} | — |\n")

    closed=[d for d in D["detail"] if d["closed_at"] and d["closed_at"][:10]>=tw["start"]]
    active=[d for d in D["detail"] if d not in closed and d["rounds"]>0]
    L.append(f"### 上周收口的 issue（{len(closed)} 个）\n")
    L.append("| # | 标题 | 轮数（你参与） | AI 耗时 | PR |")
    L.append("|---|---|---|---|---|")
    for d in closed:
        pr=" ".join(f"#{p['num']}{'（已合并）' if p['merged_at'] else ''}" for p in d["prs"]) or "—"
        L.append(f"| #{d['num']} | {d['title'][:60]} | {d['rounds']:.0f}（你 {d['human']:.0f}） | {hm(d['secs'])} | {pr} |")
    L.append(f"\n### 上周有推进但没关的 issue（{len(active)} 个）\n")
    L.append("| # | 标题 | 轮数（你参与） | AI 耗时 | 当前 label |")
    L.append("|---|---|---|---|---|")
    for d in active:
        L.append(f"| #{d['num']} | {d['title'][:60]} | {d['rounds']:.0f}（你 {d['human']:.0f}） | {hm(d['secs'])} | {', '.join(d['labels']) or '—'} |")

    L.append(f"\n---\n\n## 📈 最近 {len(W)} 周趋势\n")
    L.append(f"![交付趋势]({a.asset_url_base}/delivery-{a.rev}.png)\n")
    L.append(f"![投入趋势]({a.asset_url_base}/effort-{a.rev}.png)\n")
    L.append("### 逐周数据\n")
    L.append("| 周 | 新提 issue | 关闭 issue | 合并 PR | 净增代码行 | 讨论条数 | 你发的 | AI 时长 | 成本 |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for k in W:
        v=wk[k]; d0=datetime.date.fromisoformat(k); d1=d0+datetime.timedelta(days=6)
        mark="**" if k==tw["start"] else ""
        L.append(f"| {mark}{d0.month}/{d0.day}–{d1.month}/{d1.day}{mark} | {v['iss_open']:.0f} | {v['iss_closed']:.0f} | "
                 f"{v['pr_merged']:.0f} | {v['add']-v['del']:,} | {v['comments']:.0f} | {v['human']:.0f} | "
                 f"{hm(v['secs'])} | ${v['cost']:,.0f} |")
    tn=sum(wk[k]['add']-wk[k]['del'] for k in W)
    L.append(f"\n**{len(W)} 周合计**：新提 issue {t('iss_open'):.0f} / 关闭 {t('iss_closed'):.0f}，"
             f"合并 PR {t('pr_merged'):.0f} 个，净增 {tn:,} 行，讨论 {t('comments'):.0f} 条"
             f"（你 {t('human'):.0f} 条，{t('human')/t('comments')*100 if t('comments') else 0:.0f}%），"
             f"AI {t('secs')/3600:.0f} 小时，成本 ${t('cost'):,.0f}。\n")
    L.append("<details>\n<summary><b>📐 数据口径 & 已知误差</b></summary>\n")
    L.append(f"""
- **时间切片**：周一 00:00 ~ 周日 24:00（北京时间）。
- **讨论条数**：GitHub 上 issue + PR 的全部评论；「你发的」= 非 `*-bot` 账号发的条数。
- **AI 工作时长**：来自每条 agent 评论末尾的「⏱️ 耗时」footer，**只算真正在干活的时间**，不含等人回话的空档。单条超过 4 小时的一律剔除（那是会话跨夜把等待也算进去了）——本次趋势区间共剔除 {t('outliers'):.0f} 条。
- **成本**：footer 里按 API 标价折算的金额，**不是订阅制下的真实账单**，只用于周与周之间的相对比较。本次区间有 {t('footers')-t('cost_footers'):.0f} 条 footer 缺金额，未计入，总额偏低。
- **代码行数**：`origin/main` 上当周提交的「新增 − 删除」，含自动生成文件与依赖锁文件，是工作量的粗略代理。
- **提交数不适合看趋势**（因此未入图）：合并方式改成 squash 后，一个 PR 只留一个提交，提交数会断崖式下降，那是记账方式变了而非产出变了。
- **数据生成时间**：{D['generated_at'][:19].replace('T',' ')}，由 `scripts/weekly-report/` 自动产出。
""")
    L.append("</details>")
    open(a.out,"w").write("\n".join(L)+"\n")
    print(f"[ok] {a.out}")

if __name__=="__main__":
    main()
