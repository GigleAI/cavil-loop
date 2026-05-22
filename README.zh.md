# coding-agent-work-loop

> [English](README.md) · **中文**

> 对 AI 批量提需求，异步 review PR，就像和真人同事一起工作一样。
>
> 把「陪 AI 一步步写代码」变成「睡一觉起来批 PR」。

## 它好在哪

平时跟 AI 写代码是**串行**的：发 prompt → 等回复 → 看 → 反馈 → 等 → 看……一步都不能走开，AI 的历史锁在某个聊天 UI 里翻不出来，而且每个 keystroke 都在烧 token。

这工具一次性解三件事：

### 1. 同步 → 异步并行

你的角色从「陪 AI 对话的人」变成「批阅 AI 提的 PR 的人」。

```
睡前：批量开 10 个 issue，每个打 pending/agent，关电脑去睡。
睡醒：GitHub 上躺着 10 个 PR / 设计提案——挨个 review，
     OK 就 merge，想改就在 PR 评论里写反馈 + 重新打标签，
     AI 自己再下一轮（你这边不用动）。
```

N 个需求**真并行**——每个 issue 独立 worker / worktree / git 分支，互不阻塞。进度看 GitHub 标签一眼清楚。手机端 [GitHub 官方 app](https://github.com/mobile) 也能 review + 评论 + 改标签，通勤路上也能推进。

### 2. 全过程 + 交付物按 issue 号可追溯

每个 issue 的所有产物都按它的**编号**归档：

| 产物 | 存哪 |
|---|---|
| 设计方案 + 讨论 | issue 评论 |
| 代码 | 独立 worktree + `feature/issue-<N>` 分支 |
| AI 完整对话（含思考过程 + tool 调用） | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` |
| tmux 历史 | `$STATE_DIR/sessions/<project>-issue<N>.log` |
| Review 报告 | PR 评论 |

半年后某段代码出问题、想搞清楚当时**为啥**那么写？`cd <worktree>/issue-42 && claude --resume` 直接接回原对话——考虑过的替代方案、被舍弃的方向、最终决策的推理链全在。**不是**靠一行 commit message 反推意图，也不是在无名 AI 聊天 session 里翻"那个之前的"。

典型场景：
- Debug 老代码："这里为啥没处理 X 情况？" → 接回那个 issue 的 session、读当时的讨论
- 接手 / onboarding：扔给同事一个 issue 号——设计依据、替代方案、AI 的推理过程都在里面
- Regression 复盘：回到决策点，看当时漏了什么

完整保留期 + 查找 / 断点续上 SOP：[docs/persistence.md](docs/persistence.zh.md)。

### 3. 便宜（吃 Pro/Max 月费、不烧 API token）

| | Webhook + Anthropic API 方案 | 本工具 |
|---|---|---|
| 每次触发模型调用成本 | 烧 API token（每个 call $$） | 跑 Pro/Max 订阅里的 `claude` CLI——**不烧 token** |
| Idle 时成本 | webhook infra + 待机费 | **$0**（60 秒轮询只调 GitHub API、不调模型） |
| 长期跑 6 个月（每周几十个 issue） | 几百到几千刀 | 固定 \$20–\$200/月 Pro/Max |

特别适合「24/7 AI 自动 review + 自动 fix」场景——webhook + API 方案 6 个月成本上千刀，本工具吃订阅 fixed cost。

## 工作机制

本机有个**后台轮询**，每 60 秒看一眼 GitHub：发现哪个 issue / PR 被你打了 `pending/agent` 标签，就在你本地启动 Claude Code，让它在一个**独立工作目录**里干活——读评论、写代码、跑测试、提交、推送、回评论，最后把标签翻回 `pending/human` 等你来看。所有沟通都在 GitHub 评论里留痕。

两种触发场景：

| 场景 | 触发 | AI 做的事 |
|------|------|---------|
| 新需求 | 给 issue 加 `pending/agent` | 先写一份**设计提案**当评论跟你确认（怎么做、要不要拆 PR），确认后建分支 → 实现 → 开 PR |
| Review 反馈 | 给 PR 加 `pending/agent`（带评论） | 找到正在干这个 PR 的 AI 会话，读最新评论后改代码 / 答疑 |

## 它**不**做什么

- ❌ **不是云端服务**：跑在你自己的电脑 / NAS。机器关机就停
- ❌ **不替代代码 review**：AI 会改代码 + 自动推送，review 仍是你的事。建议主分支保护 + required reviewer
- ❌ **不自动 merge**：merge / 关 PR 永远是你手动操作

---

## 快速开始

### 1. 安装（一次性）

```bash
npx skills add luosky/coding-agent-work-loop -g
```

走 [skills.sh](https://www.skills.sh/docs/faq)——把 skill 拉到 `~/.agents/skills/coding-agent-work-loop/`，自动探测本机所有 AI CLI（Claude Code / Cursor / Cline / Codex …）并把 skill symlink 进各自目录。再跑同一条命令就是升级。（不加 `-g` 就只装到当前项目目录。）

<details>
<summary>手动安装（不想用 npx 的话）</summary>

```bash
git clone https://github.com/luosky/coding-agent-work-loop.git ~/github/coding-agent-work-loop
mkdir -p ~/.agents/skills ~/.claude/skills
ln -s ~/github/coding-agent-work-loop ~/.agents/skills/coding-agent-work-loop
ln -s ~/.agents/skills/coding-agent-work-loop ~/.claude/skills/coding-agent-work-loop
```

把代码放 `~/github/`，再做两个软链让 Claude Code 能找到它。以后升级：`cd ~/github/coding-agent-work-loop && git pull`。
</details>

### 2. 接入一个项目

```bash
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/path/to/your-project
```

或者直接在 Claude Code 里说「帮我把 coding-agent-work-loop 装到 ~/path/to/your-project」，AI 会自己跑。

一条命令搞定：建项目专属配置、登记后台轮询、在 GitHub 仓库建好 `pending/agent` / `pending/human` 等标签、启动定时任务。无破坏性、可重复跑。

### 3. 关机也要继续跑（可选）

```bash
sudo loginctl enable-linger $USER
```

Linux 默认你登出就停所有后台服务，这条让它在你不在的时候也跑。

## 依赖

`git`、`gh`（先 `gh auth login`）、`tmux`、`jq`、`flock`、`claude`（Pro/Max 计划）。`setup.sh` 自动判 OS：Linux 用自带的 `systemd` user timer；macOS 用 `launchd` LaunchAgent（见 [operations.md → 按 OS 选调度器](docs/operations.zh.md#按-os-选调度器)）。测过 Ubuntu 22.04 / 24.04；macOS supported, community testing welcome.

---

## 用法

### 场景 1：新需求

```bash
gh issue create --title "..." --body "..."     # 假设拿到 #42
gh issue edit 42 --add-label pending/agent
```

60 秒内后台接活：建独立工作目录、起 Claude Code、写完开 PR（body 里 `Closes #42` 或 `Refs #42`），标签翻 `pending/human` 等你 review。想看 AI 在干啥：`tmux attach -t <project>-issue42`。

### 场景 2：PR Review 反馈

```bash
gh pr comment N --body "把 foo 改成 bar"
gh pr edit N --add-label pending/agent --remove-label pending/human
```

60 秒内后台找到对应的 AI 会话，把你的评论喂进去 → 改代码 → 测试 → 推送 → 回评论 → 翻标签。

### 场景 3：澄清问题

```bash
gh pr comment N --body "这里为什么不用 X 模式？"
gh pr edit N --add-label pending/agent --remove-label pending/human
```

AI 看是讨论性问题，只回评论不动代码，标签保持 `pending/human` 等你下一句。

---

## 深入阅读

| 文档 | 内容 |
|------|------|
| [docs/architecture.md](docs/architecture.zh.md) | 标签状态机的五种状态、PR↔Issue 闭环关系（A/B/C）、为什么这么设计 |
| [docs/collaboration.md](docs/collaboration.zh.md) | 多人 + 多 agent 协作：用 label 后缀（`pending/agent/PM`、`pending/human/Alex` …）走 PM → Dev → QA 接力 |
| [docs/persistence.md](docs/persistence.zh.md) | 设计方案 / 讨论 / 代码 / Claude 对话 / tmux 历史 都存哪、怎么事后查阅、怎么从断点续上 |
| [docs/security.md](docs/security.zh.md) | **公开仓库务必读**。匿名评论可能塞 prompt injection（用提示词劫持 AI），怎么防 |
| [docs/operations.md](docs/operations.zh.md) | 配置全字段、prompt 模板、多项目共存、升级、macOS launchd、即时触发 webhook、换其他 AI 工具、故障排查 |
| [docs/drivers.md](docs/drivers.zh.md) | Worker agent driver —— 内置 `claude` / `opencode` / `codex`、加自家 driver 教程 |

## 备注

本项目是个 **Agent Skill**——给 Claude Code 这类 AI 编程工具加载的功能包。但你不用 Claude Code 也能跑：后台脚本是纯 shell + `gh` 命令，cron / systemd / launchd 都能调度。Worker 选哪个 agent CLI 由 `WORKER_AGENT=<name>` 控制；内置 `claude` / `opencode` / `codex` 三个 driver，加自家 driver 见 [docs/drivers.zh.md](docs/drivers.zh.md)。

## License

MIT。见 [LICENSE](LICENSE)。
