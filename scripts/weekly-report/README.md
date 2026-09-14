# weekly-report — 每周一自动出周报

**解决的问题**：项目跑起来之后，「上周到底交付了什么、花了多少、积压在涨还是在降」
这些问题每次都要现查现算。人工算一遍要几十分钟，而且口径每次都不一样，周与周之间没法比。

这套脚本每周一 07:00 自动跑一遍：算好上周明细 + 最近 10 周趋势曲线，开成一个 issue，
再交给 agent 把数字写成人话。**数字是机器算的（口径恒定、可比），解读是 agent 写的（读得懂）。**

## 组成

| 文件 | 干什么 |
|---|---|
| `collect.py` | 采数 + 聚合。只跑 3 次列表型 `gh api --paginate`，**不做 per-issue 循环**——请求数不随 issue 数膨胀 |
| `render.py` | 把数据渲染成两张趋势图的 HTML：**交付面** 2 块面板（PR 数 vs 净增行 / 待办存量）、**投入面** 3 块面板（讨论轮数 / AI 投入时间 / 花销）。极简配色 + Libre Baskerville |
| `shot.mjs` | HTML → 1280px 单倍像素 PNG（GitHub 评论配图标准） |
| `report.py` | 出周报 markdown（数据部分）：上周对比表、逐 issue 明细、逐周趋势表、口径说明 |
| `topdf.mjs` | 周报 markdown → A4 PDF（极简版式、中文字体、页码）。自带 md 子集渲染器，不引第三方 md 库 |
| `publish-asset.sh` | 把 PDF / 附件发到 funnel 公网目录，自动加 `rev` 并校验 HTTP 200，打印 URL |
| `run.sh` | 串起来：采数 → 出图 → 传图（校验公网 200）→ 开 issue → 打 `pending/agent` |

## 用法

```bash
# 手动跑（不发 issue，产物落 ~/weekly-report-dryrun.md）
bash run.sh <project> --dry-run

# 补跑某一周
bash run.sh <project> --week-of 2026-08-24

# 真发
bash run.sh <project>
```

定时触发：`systemd/coding-agent-weekly-report@.{service,timer}`，`OnCalendar=Mon *-*-* 07:00`。

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
| `WEEKLY_REPORT_ASSET_URL` | **必填，无默认** | 配图公网 URL 前缀。GitHub 要能抓到，必须公网可达；主机名属于部署环境，不写在本仓库里 |
| `WEEKLY_REPORT_ASSET_ROOT_URL` | **必填，无默认** | `publish-asset.sh` 用的公网 URL 根（配图前缀去掉末段） |
| `WEEKLY_REPORT_ASSET_ROOT` | `~/.local/state/coding-agent-poll/review-shots` | `publish-asset.sh` 的落盘根目录 |
| `WEEKLY_REPORT_FONTS_DIR` | `$PROJECT_ROOT/public/fonts` | 自托管 woff2；目录不在就回落系统字体 |
| `WEEKLY_REPORT_LABEL` | `pending/agent` | 开出的 issue 打什么 label。设成 `pending/human` 就只出数据、不叫 agent 写解读 |

## 周报文档规范

数字由脚本出，**解读和 PDF 由 agent 写**。派工要求写在 `run.sh` 的 issue 模板里，
改规范就改那一段（它是唯一真值，README 这里只是转述）。

**PDF 结构固定四段，顺序不要改**：

1. **本周总体数据表格** —— 开篇第一屏就是数字，含环比
2. **总体结论与注意事项** —— **精简**，3~5 条，每条一句话结论 + 一句话解释
3. **详细展开** —— 按「已上线 / 不用写代码就闭环 / 有推进没完成（等验收合并、等拍板）/ 新提未开工」分组
4. 数据口径附在末尾

⚠️ **PDF 里不写周报工具自身的元信息**（口径修正、数据遗漏、复核过程）。
那些留在 issue 评论里说；PDF 是给人看「这周干了什么」的。

出 PDF 与发布：

```bash
node topdf.mjs <项目目录> report.md report.pdf --title "标题" --subtitle "副标题"
URL=$(bash publish-asset.sh <project-key> report.pdf)   # 自动加 rev + 校验公网 200
```

`topdf.mjs` 从 `<项目目录>/node_modules` 解析 playwright（同 `shot.mjs`）。
markdown 只支持周报用得到的子集：标题 / 表格 / 列表 / 引用 / 图片 / 行内强调 / `<sub>` 等原样 HTML。
表格里**整列都是数字**的会自动右对齐 + 等宽数字。

## 口径上的几个坑（改之前先读）

1. **记账只认评论末尾那条机器记录，别再拿正则扫正文**（2026-09 重做，见 `record.py`）。
   扫正文出过两类错，且都不会报错：正文里「某测试耗时 5054ms」被读成 5054 分钟 = 84 小时，
   而 `200ms` / `83ms` 换算后低于当时那个 4 小时剔除阈值、**直接混进统计**；金额正则还会
   命中正文 SQL 片段的 `($1)`。那个 4 小时**剔除**逻辑已经删掉——同一个数值改作
   「长窗口披露」用途（`record.LONG_WINDOW_SECS`），只决定要不要在报告里列出来，
   **不影响任何统计数字**，也不判断那条记录是不是卡住了。
   历史评论（还没有机器记录的）走四步判定：机器人发的 / 不是交叉 review 评论 /
   取最后一处记账行 / 紧随其后必须是 `token` 行。
2. **同一次派工只能入账一次**。一次派工发多条评论时每条都带同一份记账行，
   逐条累加会重复计——10 周实测 12 组、18 条，多算 5.19 小时 / $774。
   按 `(worktree, 开始, 完工)` 去重（`record.dispatch_key`）；身份缺失时三级回落，
   **绝不把空身份并成一组**，否则不同派工会被误合并成一条。
3. **用量必须按 API 调用去重**。一次调用会写下多条输出记录且携带**同一份**用量
   （正文一条、思考一条、每次工具调用各一条）。53 个会话实测：逐条累加是按
   `requestId` 去重后的 1.68 倍（中位数，范围 1.39–2.46）；去重后与 agent CLI
   自记的基本吻合（中位数 1.00）。金额另有独立问题（驱动取窗口第一条消息的模型
   定一个单价套全部用量），所以报告里一律标注「按调用去重后的标价估算，计价偏差尚未核实」。
4. **「模型 + 工具」时长要在出报告时算，不能在驱动里算**。agent 的累计快照是
   **派工结束之后**才落盘的（实测 13/13 个窗口内部一条都没有），而驱动跑在发评论
   之前，那时拿不到。所以它放在 `worktime.py`，由 `collect.py` 在出报告时按窗口差分。
   这个数是**估算**：窗口归属靠快照前后配对，中位数比该窗口自身墙上时长多 4%，
   约 1.7% 的记录明显错位（最大 56 倍）。错位的**原样计入**（在合计上基本守恒，
   封顶反而会抹掉真实工时），并在报告里逐条点名。
5. **提交数不能用来看趋势**。合并方式改成 squash 之后一个 PR 只留一个提交，
   提交数会断崖式下降——那是记账方式变了。所以图里用 **PR 数 + 净增行数**。
6. **配图每轮必须换新 URL**。GitHub camo 按源 URL 缓存约一年，复用同名会把旧图钉死。
   文件名里的 `REV` 带纳秒就是为这个。传完必须 `curl` 核对公网 `HTTP 200`——
   纯 tailnet URL camo 抓不到，会图裂。
7. **柱顶数字的格式是 per-series 的，别改成全局**。`render.py` 的 series 可以带一个 `fmt`
   字段覆盖数值格式——只有「AI 投入时间」用（`fmt_h`，不足 10 小时给一位小数 `3.7h`，
   否则取整 `102h`）。**其余 series 必须保持全局 `fmt()`**（成本是 `7.2k` 这种），
   一旦格式器泄漏出去，「成本 7.2k」会变成 `7.2kh`。另外零值柱子本来就不打柱顶标签
   （`if v`），所以零工时那周顶上是空的，`0h` 只出现在左轴刻度上；「行 / 小时」折线的
   分母为零时取 `None`，在那一周**断开**而不是画到 0——画到 0 会被读成「那周产出为 0」。
   这几条都由 `tests/weekly-report-render.test.sh` 钉住。
8. **周切片按北京时间**（`TZ = UTC+8`），GitHub 返回的是 UTC，直接按 UTC 切会和人的直觉差 8 小时。
9. **机器人账号判定**走 `-bot` / `[bot]` 后缀。新增别的机器人账号要同步改 `is_bot()`，
   否则它发的评论会被算进「人发的」。
10. **明细不能只看 issue 侧的活跃度**。很多 issue 定完方案就没人再回 issue 页了，
   整周的讨论全发生在它的 PR 上——只按「issue 有评论」筛，会把整条工作漏掉。
   `collect.py` 的入选条件是三选一：**issue 自己有讨论 / 关联 PR 有讨论 / 当周关闭**。
   另外**没有关联 issue 的 PR**（chore、工具链）不挂在任何 issue 下，用 `loose_prs` 单列一组，
   否则这部分工作在清单里凭空消失。
   > 实测教训：一周的明细里漏掉过 6 条，其中一条是当周耗时最高的单项——它的讨论全在 PR 上，
   > issue 页整周零评论。汇总数字当时是对的（本来就按 issue+PR 全量算），**错的只是明细清单**，
   > 所以这类 bug 从总量上看不出来，只能靠逐条对。
