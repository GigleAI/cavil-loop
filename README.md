# coding-agent-work-loop

> 一个 Agent Skill，把「陪 AI 一步步写」变成「睡一觉起来批 PR」。

## 它解决什么

平时跟 AI 写代码是**串行**的：发 prompt → 等回复 → 看 → 反馈 → 等 → 看……一步都不能走开，一晚上做不完几个需求。

这个 skill 把循环挪到 GitHub，让你**并行**：

```
睡前：批量开 10 个 issue，每个打 pending/agent label，关电脑去睡。
睡醒：GitHub 上躺着 10 个 PR / 设计提案，你像 reviewer 一样挨个看，
     OK 就 merge，想改就在 PR 评论里写反馈 + 重新打 label，
     AI 自己再下一轮（你这边不用动）。
```

你的角色从「陪 AI 对话的人」变成「批阅 AI 提的 PR 的人」。N 个需求并行跑，互不阻塞，进度通过 GitHub label 一眼看清。手机上的 gh app 一样能 review + 评论 + 打 label，通勤路上也能推进。

## 工作机制

本机一个 systemd timer 每 60 秒扫 GitHub，发现哪个 issue / PR 被你打了 `pending/agent`，就在本地 Claude Code 里建 worktree、起 tmux + claude session、读 issue / PR 评论、写代码、测试、commit + push、回评论，最后把 label 翻回 `pending/human` 等你。所有沟通在 GitHub 评论里留痕。

两种触发场景：

| 场景 | 触发 | Agent 做的事 |
|------|------|---------|
| 新需求 | 给 issue 加 `pending/agent` | 先发设计提案 comment（A/B/C 闭环选择）→ 你确认 → 建分支 → 实现 → 开 PR |
| Review 反馈 | 给 PR 加 `pending/agent`（带评论） | 找到该 PR 的 worker session，注入「读最新评论后处理」prompt |

**便宜**：worker 走本机 `claude` CLI，吃你 Pro/Max 月费套餐，不烧 API token；空闲的 60s 轮询不调模型。

## 它**不**做什么

- ❌ **不是云端 Action**：跑在你本机 / NAS，用本地环境 + Claude Code Max 计划；机器关机就停
- ❌ **不替代代码 review**：agent 会改代码 + 自动 push，review 仍是你的事。建议主分支保护 + required reviewer
- ❌ **不自动 merge**：merge / 关 PR 永远是你手动操作

---

## 快速开始

### 1. 装 skill（一次性）

```bash
git clone https://github.com/luosky/coding-agent-work-loop.git ~/github/coding-agent-work-loop
mkdir -p ~/.agents/skills ~/.claude/skills
ln -s ~/github/coding-agent-work-loop ~/.agents/skills/coding-agent-work-loop
ln -s ~/.agents/skills/coding-agent-work-loop ~/.claude/skills/coding-agent-work-loop
```

链路：`~/.claude/skills/...` → `~/.agents/skills/...` → `~/github/...`。`git pull` 升级，所有上游 symlink 自动看到新版本。

### 2. 接入一个 host project

```bash
bash ~/.agents/skills/coding-agent-work-loop/setup.sh ~/path/to/your-project
```

或在 Claude Code 里说「帮我把 coding-agent-work-loop 装到 ~/path/to/your-project」，Claude 会调本 skill 自动跑。

`setup.sh` 做的事（无破坏性，幂等）：生成 `coding-agent.config`、加 `.gitignore`、注册 systemd EnvironmentFile、symlink unit 模板、建 GitHub label、seed state.json、enable timer。

### 3. 长期跑（用户不在线也跑）

```bash
sudo loginctl enable-linger $USER
```

## 依赖

`git ≥ 2.5`、`gh`（先 `gh auth login`）、`tmux ≥ 3.0`、`jq`、`flock`、`claude`（Pro/Max 计划）、`systemd` user units。测过 Ubuntu 22.04 / 24.04，macOS 需要把 systemd 换成 launchd（见 [operations.md](docs/operations.md#其他调度器)）。

---

## 用法

### 场景 1：新需求

```bash
gh issue create --title "..." --body "..."     # 假设拿到 #42
gh issue edit 42 --add-label pending/agent
```

60 秒内 daemon 建 worktree + tmux session + 起 Claude，写完开 PR with `Closes #42` / `Refs #42`，label 翻 `pending/human` 等你 review。`tmux attach -t <project>-issue42` 可以看 Claude 干活。

### 场景 2：PR Review 反馈

```bash
gh pr comment N --body "把 foo 改成 bar"
gh pr edit N --add-label pending/agent --remove-label pending/human
```

60 秒内 daemon 找 tmux session、注入新 prompt，Claude 改代码 → 测试 → push → 回评论 → 翻 label。

### 场景 3：澄清问题

```bash
gh pr comment N --body "这里为什么不用 X 模式？"
gh pr edit N --add-label pending/agent --remove-label pending/human
```

Claude 看是讨论性问题，回评论 + label 保持 `pending/human` 等你下一句。

---

## 深入阅读

| 文档 | 适合你想了解…… |
|------|----------------|
| [docs/architecture.md](docs/architecture.md) | 五态 label 状态机、PR↔Issue 闭环关系（A/B/C）、worker 会话模型、为什么 worktree + tmux + paste-buffer + systemd template 这些选型 |
| [docs/security.md](docs/security.md) | **公开仓库务必读**。匿名评论 + prompt injection 攻击面、内建防护、label 纪律 |
| [docs/operations.md](docs/operations.md) | 配置全字段、prompt 模板覆盖、文件结构、多项目共存、skill 升级、其他调度器（cron/launchd）、webhook 即时触发、自定义 worker、故障排查、卸载 |

## 这是个 Agent Skill

「Agent Skill」= 给 agent（Claude Code、其他 LLM agent CLI）加载的一份独立功能包，含 SKILL.md 元数据 + 一组脚本 / 模板 / 配置。本仓库就是这样一份 skill 的源码。

| 范围 | 目录 | 谁用 |
|------|------|------|
| **全局** | `~/.agents/skills/<name>/` | 所有 agent runtime 共用的「规范单源」 |
| **工作区** | `<project-root>/.agents/skills/<name>/` | 仅在该项目下生效的 skill |
| **工具特定** | `~/.claude/skills/<name>/` 等 | 各 agent CLI 自己的加载目录，推荐 symlink 到上面规范目录 |

非 Claude Code 用户：daemon 和 dispatch 脚本是纯 shell + `gh` CLI，不依赖 agent 框架。直接 `bash scripts/agent-poll.sh`（或交给 cron / systemd 调起）即可。换其他 agent CLI 见 [operations.md → 自定义 worker](docs/operations.md#自定义-worker不是-claude-code)。

---

## License

MIT。见 [LICENSE](LICENSE)。
