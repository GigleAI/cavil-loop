#!/usr/bin/env bash
# 记账记录提取与派工去重（scripts/weekly-report/record.py）。
#
# 跑法：bash tests/weekly-report-record.test.sh
# 依赖：python3。纯逻辑测试，不碰网络、不读本机日志。
#
# 为什么要有这个文件（GigleTutor-Web#931）：
# 原来是拿正则在整条评论正文上扫「耗时」和「金额」，两类错都发生过且不会报错：
#   · 正文里「某测试耗时 5054ms」被读成 5054 分钟 = 84 小时；200ms / 83ms 换算后
#     低于当时的 4 小时剔除阈值，直接混进统计。金额正则命中正文 SQL 的 `($1)`。
#   · 同一次派工发多条评论，每条都带同一份记账行 → 逐条累加重复计。
# 这两类都只让数字悄悄变大，不会有任何报错，所以必须钉住。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

python3 - "$REPO_DIR" <<'PY'
import sys, datetime
sys.path.insert(0, sys.argv[1] + "/scripts/weekly-report")
import record

TZ = record.TZ
ok = bad = 0
def chk(name, got, want):
    global ok, bad
    if got == want:
        print(f"  ✅ {name}"); ok += 1
    else:
        print(f"  ❌ {name}\n       期望 {want!r}\n       实得 {got!r}"); bad += 1

REAL = "---\n⏱️ 开始 2026-09-14 10:00:00 · 完工 10:14:10 · 耗时 14m 10s\ntoken 44 input, 1k output ($16.64)"
BOT  = "acme-bot"

# ── 正文里的示例不能被当成记账 ────────────────────────────────────────────
ex_mark = ("说明格式：\n\n````text\n"
           "<!-- agent-metrics agent=claude wt=1 start=2020-01-01T00:00:00+08:00 "
           "end=2020-01-01T09:00:00+08:00 wall_secs=32400 cost_usd=999 -->\n````\n\n"
           "---\n<!-- agent-metrics agent=claude wt=931 start=2026-09-14T10:00:00+08:00 "
           "end=2026-09-14T10:14:10+08:00 wall_secs=850 cost_usd=16.64 -->")
r = record.extract(ex_mark, BOT, 1)
chk("正文有机器记录示例 + 末尾真记录 → 取末尾那条", (r["src"], r["wall"], r["cost"]), ("marker", 850, 16.64))

default_mark = ("<!-- agent-metrics agent=codex wt=22 "
                "start=2026-09-14T10:00:00+08:00 end=2026-09-14T10:14:10+08:00 "
                "wall_secs=850 in=1000000 out=0 cache_r=0 cache_w=0 cost_usd=10 "
                "cost_state=full cost_unknown_tokens=0 price_source=default "
                "price_checked=2026-09-16 price_stale=yes -->")
r = record.extract(default_mark, BOT, 40)
chk("内置价来源与过期状态从机器标记进入周报记录",
    (r["price_source"], r["price_stale"]), ("default", True))

ex_foot = ("历史排版长这样：\n\n````text\n"
           "⏱️ 开始 2020-01-01 00:00:00 · 完工 09:00:00 · 耗时 540m\ntoken 1 input ($999.00)\n````\n\n"
           "> 引用别人的：\n> ⏱️ 开始 2021-02-02 00:00:00 · 完工 08:00:00 · 耗时 480m\n\n" + REAL)
r = record.extract(ex_foot, BOT, 2)
chk("正文有记账行示例与引用 + 末尾真记账行", (r["src"], r["wall"], r["cost"]), ("footer", 850, 16.64))

only_ex = ("只有示例：\n\n````text\n"
           "⏱️ 开始 2020-01-01 00:00:00 · 完工 09:00:00 · 耗时 540m\ntoken 1 input ($999.00)\n````")
chk("只有示例·交叉 review 评论 → 不作为记账来源",
    record.extract("<!-- codex-review-round:1 -->\n" + only_ex, BOT, 3), None)
chk("只有示例·人发的评论 → 不作为记账来源", record.extract(only_ex, "luosky", 4), None)

# ── 正文毫秒（原始无空格写法，就是当年真把统计搞坏的那几种） ───────────────
for ms, label in (("5054ms", "5054ms"), ("240ms", "240ms"), ("200ms", "200ms"), ("83ms", "83ms")):
    body = f"这条测试耗时 {ms} 像是等超时。\n\n" + REAL
    r = record.extract(body, BOT, 5)
    chk(f"正文「耗时 {label}」+ 真记账行 → 只入账 850 秒", (r["wall"], r["cost"]), (850, 16.64))

# ── 正文里的 SQL 假金额 ──────────────────────────────────────────────────
r = record.extract("SQL: select pg_blocking_pids($1) blockers\n\n" + REAL, BOT, 6)
chk("正文 SQL 的 ($1) 不入账，只认记账行金额", r["cost"], 16.64)

# ── 历史排版：真记账行写在代码块里（折叠块 + ``` 那种） ───────────────────
fenced = ("<details><summary>⏱️ 耗时 / token</summary>\n\n```\n"
          "开始 2026-09-09 11:19:05 · 完工 11:56:34 · 耗时 37m 29s\n"
          "token 418 input ($141.85)\n```\n\n</details>")
r = record.extract(fenced, BOT, 7)
chk("真记账行写在代码块里（历史排版）仍能解析", (r["wall"], r["cost"]), (2249, 141.85))

# ── 跨零点 ──────────────────────────────────────────────────────────────
cross = "---\n⏱️ 开始 2026-09-09 23:52:10 · 完工 2026-09-10 00:10:30 · 耗时 18m 20s\ntoken 1 input ($1.00)"
chk("完工带完整日期的跨零点样本", record.extract(cross, BOT, 8)["wall"], 1100)
cross2 = "---\n⏱️ 开始 2026-09-06 17:37:05 · 完工 00:45:00 · 耗时 427m 55s\ntoken 1 input ($1.00)"
chk("完工只有时刻、比开始小 → 视为跨零点 +1 天", record.extract(cross2, BOT, 9)["wall"], 25675)

# ── 记账行之后没有 token 行 ─────────────────────────────────────────────
chk("记账行后无 token 行 → 不作为记账来源",
    record.extract("---\n⏱️ 开始 2026-09-14 10:00:00 · 完工 10:14:10 · 耗时 14m 10s\n\n（没有 token 行）", BOT, 10),
    None)

# ── 新机器记录的派工身份与去重 ───────────────────────────────────────────
M1 = ("<!-- agent-metrics agent=claude wt=931 start=2026-09-14T09:00:00+08:00 "
      "end=2026-09-14T09:10:00+08:00 wall_secs=600 cost_usd=1.00 -->")
M2 = ("<!-- agent-metrics agent=claude wt=931 start=2026-09-14T10:00:00+08:00 "
      "end=2026-09-14T10:10:00+08:00 wall_secs=600 cost_usd=1.00 -->")
a = record.extract("发在 issue 上\n\n" + M1, BOT, 11)
b = record.extract("发在关联 PR 上，同一次派工\n\n" + M1, BOT, 12)
chk("同一派工发两条评论 → 身份相同，去重后只计一次",
    record.dispatch_key(a) == record.dispatch_key(b), True)
c = record.extract("第二次派工\n\n" + M2, BOT, 13)
chk("两次不同派工即使时长金额完全相同 → 身份不同，各自计入",
    record.dispatch_key(a) == record.dispatch_key(c), False)

# ── 同一派工、不同 end 的累计快照：**最容易重复计的那种** ──────────────────
# 记账行里的时长 / 金额是「从派工开始起的累计」，end 是写这条评论的时刻。
# 同一次派工先在 issue 回一条、稍后在 PR 再回一条，两条 end 不同但 start 相同；
# 身份里若带 end 就成了两次派工，前半段被再加一遍（1800 秒 / $30 而不是 1200 / $20）。
CUM1 = ("<!-- agent-metrics agent=claude wt=931 start=2026-09-14T11:00:00+08:00 "
        "end=2026-09-14T11:10:00+08:00 wall_secs=600 cost_usd=10 -->")
CUM2 = ("<!-- agent-metrics agent=claude wt=931 start=2026-09-14T11:00:00+08:00 "
        "end=2026-09-14T11:20:00+08:00 wall_secs=1200 cost_usd=20 -->")
e1 = record.extract("同派工第 1 条（10 分钟时的累计）\n\n" + CUM1, BOT, 17)
e2 = record.extract("同派工第 2 条（20 分钟时的累计）\n\n" + CUM2, BOT, 18)
chk("同一派工、不同 end 的两条累计快照 → 身份仍相同",
    record.dispatch_key(e1) == record.dispatch_key(e2), True)
keep = record.pick_latest(e1, e2)
chk("同身份保留 end 更晚那条（累计值更完整，不能留最早的）",
    (keep["wall"], keep["cost"]), (1200, 20.0))
chk("pick_latest 与传参顺序无关",
    (record.pick_latest(e2, e1)["wall"], record.pick_latest(None, e1)["wall"]), (1200, 600))

# ── 身份类型必须归一：标记里的 wt 是字符串，回落用的 default_wt 是整数 ──────
# 不归一就成了 ('931', start) != (931, start)，同一次派工的两条评论各记一次。
M_NOWT = ("<!-- agent-metrics agent=claude start=2026-09-14T11:00:00+08:00 "
          "end=2026-09-14T11:10:00+08:00 wall_secs=600 cost_usd=10 -->")
FOOT_SAME = ("---\n⏱️ 开始 2026-09-14 11:00:00 · 完工 11:10:00 · 耗时 10m 0s\n"
             "token 1 input ($10.00)")
g1 = record.extract("标记里省了 wt，走回落\n\n" + M_NOWT, BOT, 19, default_wt=931)
g2 = record.extract("标记里带显式 wt\n\n" + CUM2, BOT, 20, default_wt=931)
g3 = record.extract("历史可见记账行，也走回落\n\n" + FOOT_SAME, BOT, 21, default_wt=931)
chk("wt 一律归一成字符串", (g1["wt"], g2["wt"], g3["wt"]), ("931", "931", "931"))
chk("缺 wt 的标记 与 显式 wt 的标记 → 同一派工",
    record.dispatch_key(g1) == record.dispatch_key(g2), True)
chk("历史可见记账行 与 新机器标记 → 同一派工",
    record.dispatch_key(g3) == record.dispatch_key(g2), True)
mix = {}
for r in (g1, g2, g3):
    k = record.dispatch_key(r)
    mix[k] = record.pick_latest(mix.get(k), r)
chk("三条混合来源只入账一次，取最终累计值",
    (len(mix), sum(r["wall"] for r in mix.values()), sum(r["cost"] for r in mix.values())),
    (1, 1200, 20.0))

NOID = "<!-- agent-metrics agent=claude wt=931 wall_secs=600 cost_usd=1.00 -->"
d = record.extract("---\n⏱️ 开始 2026-09-14 11:00:00 · 完工 11:10:00 · 耗时 10m 0s\ntoken 1 input ($1.00)\n\n" + NOID, BOT, 14)
chk("机器记录缺起止 → 回落到同评论里的可见记账行取身份", d["ident"], "marker+footer")
e = record.extract("只有记录\n\n" + NOID, BOT, 15)
f = record.extract("另一条只有记录\n\n" + NOID, BOT, 16)
chk("起止与记账行都没有 → 各自以评论 id 为身份", (e["ident"], f["ident"]), ("marker-noid", "marker-noid"))
chk("身份缺失的两条**不能**被并成一组",
    record.dispatch_key(e) == record.dispatch_key(f), False)

# ── 来源资格对**机器记录**同样生效（GitHub#932 review 第 3 轮） ─────────────
# 维护者在讨论里复制一行机器记录当例子、又恰好是评论最后一个非空行时，原来会凭空
# 多出一次派工；它的 end 还可能比真记录晚，于是在同一身份下顶掉真实那条。
HUMAN_MARK = ("我们的格式是这样：\n"
              "<!-- agent-metrics agent=claude wt=931 start=2026-09-14T10:00:00+08:00 "
              "end=2026-09-14T10:14:10+08:00 wall_secs=850 in=1 out=1234 cache_r=0 cache_w=0 cost_usd=16.64 -->")
chk("人发的评论末尾贴机器记录 → 不作为记账来源", record.extract(HUMAN_MARK, "luosky", 20, 931), None)

bot_mark = record.extract("收尾。\n" + HUMAN_MARK.split("\n", 1)[1], BOT, 21, 931)
chk("机器人发的同一条机器记录 → 照常入账",
    (bot_mark["src"], bot_mark["wall"], bot_mark["cost"]), ("marker", 850, 16.64))

cx_mark = record.extract("<!-- codex-review-round:3 -->\n## codex review 通过\n\n"
                         + HUMAN_MARK.split("\n", 1)[1], BOT, 22, 931)
chk("交叉 review 评论带机器记录 → 照常入账（改造后它也写记账）",
    (cx_mark["src"], cx_mark["wall"], cx_mark["cost"]), ("marker", 850, 16.64))
chk("交叉 review 评论只有历史记账行 → 仍不作为记账来源（那时它不写记账）",
    record.extract("<!-- codex-review-round:1 -->\n引用一下：\n\n" + REAL, BOT, 23), None)

# ── 输出 token 只从选中的那条记录自己读，不扫正文 ───────────────────────────
# 原来是拿正则扫整条评论正文累加 `token … output`：正文里一句示例就能把统计抬高几个
# 数量级，而机器记录里明明写着精确值。
BODY_EX = "示例：token 1 input, 999k output ($500)\n\n"
mk = ("<!-- agent-metrics agent=claude wt=931 start=2026-09-14T10:00:00+08:00 "
      "end=2026-09-14T10:14:10+08:00 wall_secs=850 in=1 out=1234 cache_r=0 cache_w=0 cost_usd=16.64 -->")
chk("机器记录 → 取 out= 的精确值（不是记账行里舍入过的 1k）",
    record.extract("干完了。\n\n" + mk, BOT, 24)["out"], 1234)
chk("机器记录 + 正文示例 → 正文不参与",
    record.extract(BODY_EX + mk, BOT, 25)["out"], 1234)
chk("机器记录没写 out= → 记 0，不回头扫正文",
    record.extract(BODY_EX + mk.replace("out=1234 ", ""), BOT, 26)["out"], 0)
chk("历史记账行 → 只读紧随其后那一行（1k），正文示例不参与",
    record.extract(BODY_EX + REAL, BOT, 27)["out"], 1000)

# ── 长窗口披露（只决定列不列，不改任何数字） ─────────────────────────────
def listed(sec):
    return sec >= record.LONG_WINDOW_SECS
chk("窗口 30 分钟的正常长调用 → 不列出", listed(1800), False)
chk("窗口 7 小时 → 列出", listed(7 * 3600), True)
chk("窗口正好 4 小时 → 列出（取 ≥）", listed(4 * 3600), True)
chk("窗口 3 小时 59 分 → 不列出", listed(4 * 3600 - 60), False)

print(f"\n  {ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
PY
