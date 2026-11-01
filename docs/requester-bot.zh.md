# 对接外部需求机器人：以 grokbot 为例

> [English](requester-bot.md) · **中文**

有的项目让另一个 AI 助手直接来提需求，下文叫它「外部需求机器人」，它背后是它服务的人（下文叫「提需求的人」）。机器人在装了 cavil-loop 的仓库里开 issue，cavil-loop 照常处理；这条需求**有要提需求方回答的问题**，或者**做完了**，都会把结果告诉机器人，由它带回答复或转告结果。这样机器人和 cavil-loop 之间形成闭环。

这份文档前半是照着做的对接步骤（以 [`grokbot`](https://github.com/grokbot) 为例，换成别的机器人只是名字不同），后半是参考资料。

**默认关闭**，全部靠配置开启；代码和配置模板里不写任何具体的机器人名字（GitHub#95 / #97 / #100）。

- [一条需求是怎么闭环的](#一条需求是怎么闭环的)
- [对接前要准备什么](#对接前要准备什么)
- [对接步骤](#对接步骤)
- [grokbot 那边要照做的约定](#grokbot-那边要照做的约定)
- [一条需求的完整来回：issue 上会看到什么](#一条需求的完整来回issue-上会看到什么)
- [排查](#排查)
- [暂停与退回](#暂停与退回)
- [参考](#参考)

## 一条需求是怎么闭环的

```
机器人开 issue（正文带标记、自己打 pending/agent）
   │
   ▼
agent 出方案 / 提问 / 汇报 ── 发评论 ── 跑叫醒脚本
   │                                   │ 挂等待标签、摘掉 pending/agent 等
   │                                   │ 调一次机器人的 webhook（配了才发）
   ▼                                   ▼
等待中：daemon 不派工          机器人来拉所有挂等待标签的条目 → 读讨论
   │                           → 带给提需求的人 → 在该条目上写「已转给谁」
   │                                   │
   │                                   ▼
   │                     拿到答复 → 原文贴回 → 摘等待标签 → 打 pending/agent 让 agent 接着干
   ▼
agent 读答复，继续 …… PR 合并（或关闭未合并）
   │
   ▼
daemon 在机器人提的 issue 上留一条结果评论、加等待标签、调 webhook → 机器人把结果告诉提需求的人、摘标签
```


## 对接前要准备什么

| 谁 | 要有什么 |
|---|---|
| 维护者（你） | 一个已经接入 cavil-loop 的仓库；worker / reviewer 发评论用的那个 GitHub 账号（下文叫 worker 账号），它要能改这个仓库的标签 |
| grokbot | 能在这个仓库开 issue、发评论、改标签（第 1 步给它权限），能读 issue / PR 的评论和标签 |
| grokbot（可选） | 一个能收 HTTPS POST 的 webhook 地址和一把密钥。没有也能用：只挂等待标签，靠 grokbot 自己定时扫描来发现，只是慢一些 |

## 对接步骤

### 1. 给 grokbot 一个能打标签的权限

开工靠 `pending/agent` 标签，只有仓库里有相应权限的人才打得上——这道门挡住陌生人随意让 agent 干活，本功能不改它。GitHub 仓库权限里最低的、能打标签的一档叫 **Triage**：能管标签，改不了代码。

- 仓库页 → Settings → Collaborators and teams → Add people → 输入 `grokbot` → 角色选 **Triage** → 发邀请；grokbot 那边接受邀请
- 想暂停 grokbot：在同一页把它移出即可

### 2. 填配置

在项目的 `cavil-loop.config` 里加（worker 账号换成你自己的）：

```bash
LABEL_PENDING_REQUESTER_BOT="pending/requester-bot"
REQUESTER_BOT_ACCOUNT="grokbot"
REQUESTER_BOT_ALLOWED_ACTORS="your-worker-bot"          # worker / reviewer 发评论用的那个账号
REQUESTER_BOT_ORIGIN_MARKER="<!-- requested-by-grokbot -->"
REQUESTER_BOT_REPORT_FIRST="true"                       # 做完先向 grokbot 汇报，提需求方认可后再交维护者
# webhook（grokbot 那边给的地址和密钥）
REQUESTER_BOT_WEBHOOK_URL="https://<grokbot 给的地址>"
REQUESTER_BOT_WEBHOOK_KEY_HEADER="Authorization"
REQUESTER_BOT_WEBHOOK_KEY="Bearer <grokbot 给的密钥>"
```

每一项的含义见[参考 → 配置](#配置)。前四项都填了才算开启；webhook 三项可以先不填，以后再加。

### 3. 收紧配置文件权限

配置文件里有 webhook 密钥，必须只有你自己能读，否则 webhook 一律不发（`poll.log` 记一行「配置文件权限过宽」）：

```bash
chmod 600 <项目目录>/cavil-loop.config
```

### 4. 建等待标签

仓库页 → Issues → Labels → New label，名字填 `pending/requester-bot`。（新接入的项目跑 `setup.sh` 时，配置里有这一项就会自动建。）

改完配置不用重启：后台每一轮巡检都重新读配置。

### 5. 和 grokbot 约定它那边的做法

把下一节[「grokbot 那边要照做的约定」](#grokbot-那边要照做的约定)整节交给 grokbot 的维护方照着实现。

### 6. 验证接上了

让 grokbot 提一条测试需求，然后依次核对：

1. agent 发出方案后，issue 上出现 `pending/requester-bot` 标签；`poll.log` 里有 `notify-requester-bot #<编号>: ✅ 已叫醒 grokbot`，紧跟 `已通知 webhook（HTTP 200）`
2. grokbot 在挂着等待标签的那个条目上留言说明转给了谁，之后在同一个条目上把答复原文贴回、摘掉 `pending/requester-bot`、打上 `pending/agent`；下一轮巡检 agent 接着干
3. PR 合并后，issue 上出现「需求已完成」评论并重新挂上 `pending/requester-bot`，`poll.log` 里有 `issue #<编号>：已通知 webhook（HTTP 200）`

任何一步对不上，看下面的[排查](#排查)。

## grokbot 那边要照做的约定

cavil-loop 只管自己这一侧，下面这些由 grokbot 实现：

1. **提需求**：开 issue，正文末尾带上标记文字 `<!-- requested-by-grokbot -->`，并打上 `pending/agent`。只有作者是 grokbot **而且**带这段标记的 issue 才算它提的需求——缺一条，cavil-loop 就按普通 issue 处理，有问题只交维护者
2. **收到 webhook，或自己定时扫描时**：拉取**所有**挂着 `pending/requester-bot` 的 issue / PR，**包括已关闭的**。webhook 请求体只是提示，照样全量拉，不按请求体办事（格式见[参考 → webhook 通知](#webhook-通知)）
3. **转给提需求的人**：读讨论，把最新那条评论带给提需求的人，然后**在挂着等待标签的那个条目上**留言说明转给了谁——方案、提问挂在 issue 上就回 issue，PR 上的结果汇报就回那个 PR。agent 只认这条留言作为「已通知提需求的人」的证据
4. **带回答复**：还是在**挂着等待标签的那个 issue 或 PR 上**，把答复**原文**贴回 → 摘掉它的 `pending/requester-bot` → 给它打上 `pending/agent` 让 agent 继续（`DISPATCH_MODE=greedy` 的项目可以不打，摘掉等待标签就会续上）。**别把 PR 上的答复贴到来源 issue**：daemon 按每个条目自己的标签派工，贴到 issue 上会把 issue 重新派出去，等待中的 PR 却一直停着。认可汇报时答复里要明确说认可；agent 还会核对被认可的那条汇报写的提交编号是不是 PR 当前最新提交，不是就会再问一次
5. **收到「需求已完成」/「已关闭，没有合并」的评论**（daemon 发在来源 issue 上）：把结果告诉提需求的人，再摘掉 `pending/requester-bot`；这条需求到此结束
6. **不碰挂着 `pending/human` 的条目**：那是交给维护者的
7. **附件**：提需求的人给的图片等可以贴进 issue，agent 会自己下载阅读；反方向（agent 发附件给 grokbot）目前不支持

## 一条需求的完整来回：issue 上会看到什么

以 `REQUESTER_BOT_REPORT_FIRST="true"` 为例：

| 步骤 | 谁做 | 标签 | 新出现的评论 |
|---|---|---|---|
| 1. 提需求 | grokbot | issue `pending/agent` | 正文带标记的 issue |
| 2. 派工 | daemon | issue `doing/agent` | — |
| 3. 出方案 | agent | issue `pending/requester-bot`（项目开了方案复审时先 `pending/review`，复审通过后才换成它） | 设计方案 |
| 4. 转达、带回答复 | grokbot | issue `pending/agent` | issue 上：「已转给谁」；答复原文 |
| 5. 开发、开 PR | agent | issue `pending/PR`；PR 先过复审（项目开了复审关卡时） | PR |
| 6. 汇报结果 | agent / reviewer | PR `pending/requester-bot` | 结果汇报（写明提交编号） |
| 7. 提需求方认可 | grokbot | PR `pending/agent` | PR 上（不是来源 issue）：「已转给谁」；认可的答复原文 |
| 8. 交维护者 | agent | PR `pending/human` | 交人评论 |
| 9. 合并 | 维护者 | PR `Done`；issue 挂上 `pending/requester-bot` | daemon 发「需求已完成」 |
| 10. 收尾 | grokbot | issue 摘掉 `pending/requester-bot` | — |

`REQUESTER_BOT_REPORT_FIRST="false"` 时没有第 6、7 步：做完直接交维护者，合并后照样有第 9、10 步。

## 排查

| 看到什么 | 原因 / 怎么办 |
|---|---|
| 条目挂 `pending/human`，有一条「叫醒失败，已交维护者」评论 | 按评论里贴的脚本输出排查；常见是 worker 账号没有改标签的权限 |
| 方案直接交到了维护者手上，没叫醒 grokbot | 叫醒脚本前置检查拒绝了：issue 作者不是 `REQUESTER_BOT_ACCOUNT`、正文没有标记、条目上挂着 `pending/human`，或维护者手打过 `pending/human` 且之后没有解除（要恢复：维护者自己摘掉它、重新打 `pending/agent`） |
| `poll.log` 有 `webhook 通知失败（…）` | 标签照样挂上了，grokbot 下一次定时扫描会看到；按括号里的原因（HTTP 状态 / 超时 / 连接失败）查 grokbot 那边 |
| `webhook 配置不完整，跳过` | 请求头名或密钥为空，或请求头名有字母、数字、`-` 以外的字符，或地址 / 密钥里有换行 |
| `配置文件权限过宽（应为 600），webhook 跳过` | 做第 3 步 |
| `找不到 curl，webhook 跳过` | 本机装上 curl |
| 合并后 grokbot 没收到「需求已完成」 | 合并后清理被关了（`AUTO_CLEANUP_ON_MERGE`）；或关闭未合并时同一项需求还有别的 PR 开着（这种不通知）；或写身份不在 `REQUESTER_BOT_ALLOWED_ACTORS` 里——`poll.log` 会写明原因 |

叫醒脚本的退出码见[参考 → 叫醒脚本](#叫醒脚本)。

## 暂停与退回

- **暂停 grokbot 提需求**：仓库 Settings → Collaborators and teams 里把它移出
- **只停 webhook、保留等待标签**：清空 `REQUESTER_BOT_WEBHOOK_URL`
- **整个关掉**：把配置里这几项清空，挂着等待标签的条目手动摘掉标签。清空后派工、提示词、合并后的处理和没开过一样

## 参考

### 配置

| 配置项 | 作用 |
|---|---|
| `LABEL_PENDING_REQUESTER_BOT` | 等待标签，例如 `pending/requester-bot`。`setup.sh` 会按这个名字建标签 |
| `REQUESTER_BOT_ACCOUNT` | 外部需求机器人的 GitHub 登录名。只用来认出哪些 issue 是它提的（见下一行），**不再**指派给它或请求它 review |
| `REQUESTER_BOT_ALLOWED_ACTORS` | 允许执行叫醒的账号（逗号分隔），一般就是 worker / reviewer 发评论用的那个账号 |
| `REQUESTER_BOT_ORIGIN_MARKER` | issue 正文里出现这段文字、**并且** issue 作者就是机器人账号，才算「机器人提的需求」；PR 看它关联的 issue：分支名里的 issue 编号，没有就看正文的 `Closes #N` 这类写法（关键词和编号分在两行时认不准，拒绝交维护者） |
| `REQUESTER_BOT_REPORT_FIRST` | `true`：做完先向机器人汇报，提需求方认可当前提交后再交维护者合并；`false`（默认）：做完直接交维护者 |
| `REQUESTER_BOT_WEBHOOK_URL` | 可选。机器人的 webhook 地址；留空 = 不发（只挂等待标签，靠机器人自己的定时扫描） |
| `REQUESTER_BOT_WEBHOOK_KEY_HEADER` | 放密钥的请求头名，按机器人那边的说明填，例如 `Authorization`。只许字母、数字、`-` |
| `REQUESTER_BOT_WEBHOOK_KEY` | 该请求头的值，原样发送（要 `Bearer ` 前缀就整串填） |

前四项都填了才算开启。webhook 三项只从项目配置文件读（systemd 环境文件里的同名变量不算），配置文件必须是 `600`。全部留空时，派工、挡工清单、四类提示词、合并后的处理都和以前逐字节一样。

**早期名字照样认**：这个功能早期的配置项是 `LABEL_PENDING_RELAY` / `RELAY_BOT_ACCOUNT` / `RELAY_ALLOWED_ACTORS` / `RELAY_ORIGIN_MARKER` / `RELAY_REPORT_FIRST`，叫醒脚本是 `notify-relay.sh`。已经按旧名字配好的项目什么都不用改。每一项单独挑：新名字有值就用新的，否则用旧的；同一项新旧都填了且不一样时用新的，叫醒脚本输出和 `poll.log` 会提示。想换成新名字时，把配置里的 `RELAY_` 换成 `REQUESTER_BOT_`、`LABEL_PENDING_RELAY` 换成 `LABEL_PENDING_REQUESTER_BOT` 即可，标签本身（比如 `pending/relay`）不用改名。


### 等待期间 daemon 怎么做

| 条目状态 | daemon 的处理 |
|---|---|
| 只挂等待标签 | 不派工：greedy 兜底跳过；worker 意外退出后的自动重派也不翻它的标签 |
| 等待标签 + 有人又打了触发标签（`pending/agent`、fable、追加的、`pending/review`） | 照该标签原流程派工，派工时 daemon 摘掉等待标签。触发标签只有能改标签的人才打得上，等于明说「接着干」 |
| 等待标签被摘掉、没有触发标签 | label 模式下不动（等有人打 `pending/agent`）；greedy 模式下照常续上 |

不做等待超时：机器人一直没回音时，由维护者自己看着处理。


### 叫醒脚本

worker / reviewer 发完评论后跑它。派工提示词里已经写好完整命令，形如：

```bash
bash ~/.agents/releases/cavil-loop/entrypoints/notify-requester-bot.sh --config <项目配置> <issue 或 PR 编号>
```

它先做前置检查，任一条不满足就拒绝，不发任何写请求：

- 当前 GitHub 账号在允许叫醒的名单里
- 是机器人提的需求（作者 + 标记，见上表）
- 条目上没挂 `pending/human`（包括复审轮次用尽的 `pending/review` + `pending/human` 双标签）
- 维护者手打的 `pending/human` 没有仍在生效的。「维护者」= 打标签的账号既不在允许名单里，也不是机器人账号。按事件编号排序，只看维护者最后一次手打之后：之后有维护者自己摘掉它、或打上派工标签（`pending/agent` 及其变体、`pending/review`），就算暂停已解除；机器人 / worker 账号摘掉、或解除者账号读不出，都不算。标签历史读不到、或事件缺编号 → 拒绝（GitHub#106）

然后叫醒。issue 和 PR 做法相同：**叫醒 = 挂等待标签 + 调一次机器人的 webhook**。早先的做法是重新指派机器人、PR 上再请求它 review，但第一个接入的项目实测机器人收不到这些事件，全靠它自己的定时扫描（白天约 15 分钟、夜里约 30 分钟）兜底；GitHub#100 起改为 webhook，不再指派、不再请求 review。

步骤：加等待标签 → 摘掉全部触发标签、`doing/agent`、`pending/review` → 读回核对（等待标签在、要摘的都不在）。失败整体重试一次；仍失败就交还维护者：加 `pending/human` → 摘触发标签等 → 读回核对 → **最后**才摘等待标签。等待标签最后摘，中途失败时 greedy 兜底和自动重派仍然被它挡着。

**只有叫醒成功（首次或重试后）才调 webhook**，每次叫醒恰好一次；退出码 2 / 3 / 4 时交接没确认成功，一律不调。

| 退出码 | 含义 | agent 怎么做 |
|---|---|---|
| 0 | 叫醒成功（只说明标签改好了；webhook 成败只在输出里记一行，不影响退出码；不说明机器人已转达） | 停下等答复 |
| 2 | 前置检查拒绝，标签没动 | 照常交维护者 |
| 3 | 叫醒失败，已交还维护者（只剩 `pending/human`） | 补一条评论说明 |
| 4 | 交还也失败，输出里是实际读回的标签 | 如实说明，不写「已交人」 |

机器人回复后自己摘等待标签——这部分由机器人那边负责，cavil-loop 不管。


### webhook 通知

POST 一次，机器人就来仓库拉取**所有**挂着等待标签的条目（它每次全量拉，不按请求体办事）。

- 请求：`POST`，`Content-Type: application/json`，请求体 `{"repo":"<owner/repo>","number":<编号>,"kind":"issue"|"pr"}`，只是提示，不含指令；配置的请求头名带上密钥
- 不发的情况（任一条成立：只记一行、不发请求、不改退出码）：地址为空（连日志都不记）→ `webhook 配置不完整，跳过`（请求头名或密钥为空、请求头名有字母数字 `-` 以外的字符、地址或密钥里有换行等控制字符）→ `配置文件权限过宽（应为 600），webhook 跳过`（组或其他用户有任何权限位）/ `读不到配置文件权限，webhook 跳过` → `找不到 curl，webhook 跳过`
- **地址、请求头、密钥不进命令行**：经标准输入喂给 `curl --config -`，`ps` 看不到；任何输出和日志都不含这三项
- 10 秒上限、不重试、不跟随跳转（跟随会把密钥头带去另一个地址）、只许 http / https、不读用户的 `~/.curlrc`
- 结果只记一行：`已通知 webhook（HTTP 200）`，或 `webhook 通知失败（HTTP 503 / 超时 / 连接失败）`。**失败不算叫醒失败**，退出码仍是 0，靠机器人的定时扫描兜底


### 做完时告诉机器人（合并 / 关闭未合并）

PR 合并、或没合并就被关掉时，daemon 自动通知机器人，不需要 worker 在场：

- **只通知机器人提的需求**：PR 关联的 issue 要满足上表「作者 + 标记」两条，判定和叫醒脚本是同一份
- **做法**：在那个 issue 上留一条结果评论（「需求已完成：PR #N 已合并」并写明合并提交；或「PR #N 已关闭，没有合并」）→ 给那个 issue 加等待标签并读回确认 → 调一次 webhook（`kind` 是 `issue`，编号是来源 issue）。issue 已被 `Closes #N` 自动关掉也照样留评论、加标签。不再指派机器人
- **机器人那边要约定**：已关闭但挂着等待标签的条目也要拉，转达后自己摘掉标签
- **关闭未合并、但同一项需求还有别的 PR 开着**：不通知（工作还在继续）。这一条每次要发之前都现查——首轮没发成、重试前新开了 PR，也不会再发；打开的 PR 列表读不到时当成不知道，留到下轮，不当成「没有」。这项需求已经通知过「已合并」时，旧 PR 的关闭也不再通知
- **写身份要在允许名单里**：和叫醒脚本同一关；不在名单或读不到身份就不写，留到下轮，`poll.log` 写明原因
- **只发一次**：评论里带一段隐藏标记，重试时先看 issue 上有没有本账号发过的那条，发过就只补标签。加标签或读回失败下一轮重试，同一个 PR 最多 30 轮，放弃时 `poll.log` 有一行 ⚠️。webhook 失败只记一行，不进重试
- **写之前现读一次 PR**：要已关闭，合并与否和当初看到的一致；读不全就这轮不写
- 依赖合并后清理（`AUTO_CLEANUP_ON_MERGE`，默认开）那一段：关了它，合并 / 关闭后就不会通知


### 交接规则（写进派工提示词）

功能开启后，daemon 在四类派工提示词（新 issue、issue 评论、PR 评论、复审）的**最末尾**追加一段「外部需求机器人交接规则」。放在最末尾是为了让整份替换了工具模板的项目也收得到。要点：

- **叫醒机器人**：方案 / 修订方案等提需求方确认（方案要先过复审时——项目开了方案复审，或项目追加要求里这样写——由 reviewer 在方案复审通过后叫醒；否则 worker 发完方案就叫醒）；实现中要提需求方回答的产品问题；汇报结果（`REQUESTER_BOT_REPORT_FIRST=true` 时）。合并 / 关闭后的结果由 daemon 自动告诉机器人，worker 不用管
- **仍然只交维护者**：维护者已接手、可疑内容、测试红灯要人裁决、冲突解不了、复审轮次用尽、权限 / 本机配置 / 凭据 / 数据库授权类事项
- **证据规则**：「已通知提需求的人」只认机器人在汇报之后留的「已转给谁」评论；「已认可」只认机器人贴回的答复原文明确认可，**并且**被认可的那条汇报写的提交编号就是 PR 当前最新提交。认可 → 交维护者合并；要求修改 → 改完、重新审查、再汇报；答复含糊 → 再问一次
- 机器人贴进 issue 的附件（图片等），agent 用自己的令牌下载阅读

不做：agent 往机器人**发**附件（GitHub 没有给程序用的评论附件上传接口），以后另开 issue。
