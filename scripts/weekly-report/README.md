# weekly-report — 每周一自动出周报

**解决的问题**：项目跑起来之后，「上周到底交付了什么、花了多少、积压在涨还是在降」
这些问题每次都要现查现算。人工算一遍要几十分钟，而且口径每次都不一样，周与周之间没法比。

这套脚本每周一 09:00 自动跑一遍：算好上周明细 + 最近 10 周趋势曲线，开成一个 issue，
再交给 agent 把数字写成人话。**数字是机器算的（口径恒定、可比），解读是 agent 写的（读得懂）。**

## 组成

| 文件 | 干什么 |
|---|---|
| `collect.py` | 采数 + 聚合。只跑 3 次列表型 `gh api --paginate`，**不做 per-issue 循环**——请求数不随 issue 数膨胀 |
| `render.py` | 把数据渲染成两张趋势图的 HTML（交付面 / 投入面），Gigle 极简配色 + Libre Baskerville |
| `shot.mjs` | HTML → 1280px 单倍像素 PNG（GitHub 评论配图标准） |
| `report.py` | 出周报 markdown（数据部分）：上周对比表、逐 issue 明细、逐周趋势表、口径说明 |
| `run.sh` | 串起来：采数 → 出图 → 传图（校验公网 200）→ 开 issue → 打 `pending/agent` |

## 用法

```bash
# 手动跑（不发 issue，产物落 ~/weekly-report-dryrun.md）
bash run.sh tutor --dry-run

# 补跑某一周
bash run.sh tutor --week-of 2026-08-24

# 真发
bash run.sh tutor
```

定时触发：`systemd/coding-agent-weekly-report@.{service,timer}`，`OnCalendar=Mon *-*-* 09:00`。

```bash
systemctl --user enable --now coding-agent-weekly-report@<project>.timer
```

## 配置

复用 daemon 的项目配置 `~/.config/coding-agent-work-loop/<project>.conf`
（`PROJECT_ROOT` / `PATH` / `GH_TOKEN`）。可选覆盖项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEEKLY_REPORT_REPO` | 从 `PROJECT_ROOT` 的 git remote 推 | `owner/name` |
| `WEEKLY_REPORT_ASSET_DIR` | `~/.local/state/coding-agent-poll/review-shots/weekly-report` | 配图落盘目录 |
| `WEEKLY_REPORT_ASSET_URL` | funnel 的 `/review-assets/weekly-report` | 配图公网 URL 前缀 |
| `WEEKLY_REPORT_FONTS_DIR` | `$PROJECT_ROOT/public/fonts` | 自托管 woff2；目录不在就回落系统字体 |
| `WEEKLY_REPORT_LABEL` | `pending/agent` | 开出的 issue 打什么 label。设成 `pending/human` 就只出数据、不叫 agent 写解读 |

## 口径上的几个坑（改之前先读）

1. **`⏱️ 耗时` footer 不能直接求和**。会话跨夜时它记的是墙上时间（含等人回话），
   实测出现过单条 5.6 万小时的坏值。`collect.py` 里 `OUTLIER_SECS = 4h`，超过一律剔除并计数，
   剔了多少条会写进报告的口径说明里。
2. **提交数不能用来看趋势**。合并方式改成 squash 之后一个 PR 只留一个提交，
   提交数会断崖式下降——那是记账方式变了。所以图里用 **PR 数 + 净增行数**。
3. **配图每轮必须换新 URL**。GitHub camo 按源 URL 缓存约一年，复用同名会把旧图钉死。
   文件名里的 `REV` 带纳秒就是为这个。传完必须 `curl` 核对公网 `HTTP 200`——
   纯 tailnet URL camo 抓不到，会图裂。
4. **周切片按北京时间**（`TZ = UTC+8`），GitHub 返回的是 UTC，直接按 UTC 切会和人的直觉差 8 小时。
5. **机器人账号判定**走 `-bot` / `[bot]` 后缀。新增别的机器人账号要同步改 `is_bot()`，
   否则它发的评论会被算进「人发的」。
