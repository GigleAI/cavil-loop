# coding-agent-work-loop

> 把「陪 AI 一步步写代码」变成「睡一觉起来批 PR」的工具。

## 它解决什么

平时跟 AI 写代码是**串行**的：发 prompt → 等回复 → 看 → 反馈 → 等 → 看……一步都不能走开，一晚上做不完几个需求。

这个工具把循环挪到 GitHub，让你**并行**：

```
睡前：批量开 10 个 issue，每个打 pending/agent 标签，关电脑去睡。
睡醒：GitHub 上躺着 10 个 PR / 设计提案，你像 reviewer 一样挨个看，
     OK 就 merge，想改就在 PR 评论里写反馈 + 重新打标签，
     AI 自己再下一轮（你这边不用动）。
```

你的角色从「陪 AI 对话的人」变成「批阅 AI 提的 PR 的人」。N 个需求并行跑，互不阻塞，进度看 GitHub 标签一眼清楚。手机上的 gh app 一样能 review + 评论 + 打标签，通勤路上也能推进。

## 工作机制

本机有个**后台轮询**，每 60 秒看一眼 GitHub：发现哪个 issue / PR 被你打了 `pending/agent` 标签，就在你本地启动 AI worker（Claude Code 或 opencode），让它在一个**独立工作目录**里干活——读评论、写代码、跑测试、提交、推送、回评论，最后把标签翻回 `pending/human` 等你来看。所有沟通都在 GitHub 评论里留痕。

两种触发场景：

| 场景 | 触发 | AI 做的事 |
|------|------|---------|
| 新需求 | 给 issue 加 `pending/agent` | 先写一份**设计提案**当评论跟你确认（怎么做、要不要拆 PR），确认后建分支 → 实现 → 开 PR |
| Review 反馈 | 给 PR 加 `pending/agent`（带评论） | 找到正在干这个 PR 的 AI 会话，读最新评论后改代码 / 答疑 |

**便宜**：AI 是本机命令行，吃你 Pro/Max 月费套餐，不烧 API token；空闲的轮询只调 GitHub API，不调模型。

## 它**不**做什么

- ❌ **不是云端服务**：跑在你自己的电脑。机器关机就停
- ❌ **不替代代码 review**：AI 会改代码 + 自动推送，review 仍是你的事。建议主分支保护 + required reviewer
- ❌ **不自动 merge**：merge / 关 PR 永远是你手动操作

---

## 快速开始

### 1. 安装（一次性）

```bash
git clone https://github.com/luosky/coding-agent-work-loop.git ~/github/coding-agent-work-loop
cd ~/github/coding-agent-work-loop
uv sync
```

把代码放 `~/github/`，`uv sync` 装好 Python 依赖。以后 `git pull && uv sync` 就是升级。

### 2. 接入一个项目

```bash
uv run coding-agent setup ~/path/to/your-project
```

一条命令搞定：建项目专属配置、在 GitHub 仓库建好 `pending/agent` / `pending/human` 等标签、初始化状态。无破坏性、可重复跑。

### 3. 启动后台轮询

```bash
uv run coding-agent daemon
```

前台运行，60 秒一轮。配合 systemd / launchd / pm2 等实现开机自启和后台驻留。

## 依赖

`git`、`gh`（先 `gh auth login`）、Python 3.11+、`uv`（推荐，也可用 pip）。AI worker 需要至少一个：`claude`（Claude Code CLI）或 `opencode`。跨平台支持 Linux / macOS / Windows。

---

## 用法

### 场景 1：新需求

```bash
uv run coding-agent setup ~/path/to/your-project   # 首次接入
gh issue create --title "..." --body "..."          # 假设拿到 #42
gh issue edit 42 --add-label pending/agent
```

60 秒内后台接活：建独立工作目录、起 AI worker、写完开 PR（body 里 `Closes #42` 或 `Refs #42`），标签翻 `pending/human` 等你 review。想看 AI 在干啥：`uv run coding-agent status` 或 `uv run coding-agent attach 42`。

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

## CLI 命令一览

| 命令 | 用途 |
|------|------|
| `coding-agent daemon` | 启动后台轮询（前台运行，60s 一轮） |
| `coding-agent poll` | 执行一次轮询后退出 |
| `coding-agent setup <path>` | 接入项目：建配置、建标签、初始化状态 |
| `coding-agent status` | 查看当前活跃的 worker 状态 |
| `coding-agent attach <issue>` | 进入指定 issue 的 worker 会话 |
| `coding-agent logs <issue>` | 查看指定 issue 的 worker 日志 |
| `coding-agent cleanup <issue>` | 清理指定 issue 的工作目录和会话 |
| `coding-agent seed <path>` | 初始化 state.json |

---

## 深入阅读

| 文档 | 内容 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 标签状态机的五种状态、PR↔Issue 闭环关系（A/B/C）、为什么这么设计 |
| [docs/security.md](docs/security.md) | **公开仓库务必读**。匿名评论可能塞 prompt injection（用提示词劫持 AI），怎么防 |
| [docs/operations.md](docs/operations.md) | 配置全字段、prompt 模板、多项目共存、升级、故障排查 |

## 备注

本项目用 Python 重写，通过 `WorkerBase` 抽象层支持多种 AI worker——目前内置 Claude Code 和 opencode，未来可扩展。核心机制不变：GitHub label 驱动、60 秒轮询、自动派工。不再依赖 tmux / jq / flock / systemctl，跨平台跑在 Linux / macOS / Windows 上。

## License

MIT。见 [LICENSE](LICENSE)。
