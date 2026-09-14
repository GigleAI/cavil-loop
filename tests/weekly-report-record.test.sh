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

NOID = "<!-- agent-metrics agent=claude wt=931 wall_secs=600 cost_usd=1.00 -->"
d = record.extract("---\n⏱️ 开始 2026-09-14 11:00:00 · 完工 11:10:00 · 耗时 10m 0s\ntoken 1 input ($1.00)\n\n" + NOID, BOT, 14)
chk("机器记录缺起止 → 回落到同评论里的可见记账行取身份", d["ident"], "marker+footer")
e = record.extract("只有记录\n\n" + NOID, BOT, 15)
f = record.extract("另一条只有记录\n\n" + NOID, BOT, 16)
chk("起止与记账行都没有 → 各自以评论 id 为身份", (e["ident"], f["ident"]), ("marker-noid", "marker-noid"))
chk("身份缺失的两条**不能**被并成一组",
    record.dispatch_key(e) == record.dispatch_key(f), False)

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
