# 设计原理

## Label 状态机（五态）

| Label | 谁标 | 含义 |
|------|------|------|
| `pending/agent` | 你 | 等 agent pick up（issue 待派工 / PR 有 review 反馈待修） |
| `agent/doing` | daemon | agent 正在 dispatching / worker session 正在处理 |
| `pending/human` | worker / daemon | 等你 review / merge / 决策 |
| `pending/PR` | worker（开 PR 时） | issue 工作已转 PR 跟踪；去看 PR |
| `Done` | daemon（auto-cleanup） | **只标 PR**（PR merged = 真闭环）；**不标 issue**（issue 是长期 tracker，关闭权交给你） |

### 关于 PR↔Issue 闭环关系：worker 在设计阶段就决定

| 场景 | PR body 用 | merge 时 issue 状态 | daemon auto-cleanup |
|------|-------|------|------|
| **A. 完整闭环**：一个 PR 全解决 issue | `Closes #N` | GitHub 自动关 | issue 加 Done（与 PR 同状态） |
| **B. 部分实现**：多 PR 才完成 issue | `Refs #N` | 保持 open | issue 翻 `pending/human` 等你 triage |
| **C. issue 太大**：建议拆 sub-issue | 不直接派工 | — | 你拆完每个 sub-issue 再单独 label |

worker 在「设计提案」comment 里就会列出选 A/B/C 的判断，跟你讨论确认后才开干。所以 `Closes` 还是 `Refs` 是**设计阶段共识**，不是 worker 默认行为。

### 状态流转图

```
新 issue ──────────────────► label: pending/human（默认，等你 triage）
   │
   │ 你加 label: pending/agent
   ▼
pending/agent ──► daemon dispatch ──► label: agent/doing  ← GitHub UI 实时可见
                                              │
                                              │ worker 干活（建分支、写代码、跑测试、push、开 PR with `Refs #N`）
                                              ▼
                                       worker 完工 →
                                          - PR  : pending/human
                                          - Issue: pending/PR （工作已转 PR 跟踪）
                                              │
                                              ▼
                                       PR(pending/human) → 你 review
                                              │
                                              ▼ (你 merge PR)
                                       daemon auto-cleanup →
                                          - PR  : Done（PR 闭环）
                                          - Issue: pending/human（issue 仍 open，**等你 triage** 这次 PR 是否真把问题彻底搞定）
                                              │
                                              ▼
                                       你决定：
                                          - 真闭环 → 手动关 issue（可加 Done label）
                                          - 还差点 → 评论 + 标 pending/agent，进新一轮设计或开发
```

## 重入与并发安全

- **文件锁**：`poll.py` 用 `$STATE_DIR/poll.lock`（`state.py:acquire_lock`）防多个 poll cycle 撞车
- **派工立刻翻 label**：daemon 发现 `pending/agent` → dispatch → **第一件事翻成 `agent/doing`**。下一 tick daemon 看到的是 `agent/doing`，不在 `pending/agent` 扫描范围内，不会重复触发
- **agent/doing 也是 UI 信号**：你在 GitHub 上一眼能区分「agent 在干」（agent/doing）和「agent 干完等你」（pending/human），无需 attach session 才能知道
- **state.json**：记录每个 PR「上次见过的最大 comment ID」。同一条评论永远不会被两次派工
- **active worker 计数**：通过 `worker.list_sessions()` + `WorkerStatus.WORKING` 统计活的 worker；超过 `MAX_CONCURRENT_WORKERS` 时新任务排队等下一轮

## Worker 抽象层

所有 worker 后端继承 `WorkerBase`（`coding_agent/worker/__init__.py`），用 `@register_worker` 装饰器注册到全局注册表。daemon 和 CLI 通过 `get_worker(name)` 获取实例，无需关心底层差异。

### WorkerBase 接口

```python
class WorkerBase(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def start(self, session_name, worktree, prompt, env=None, extra_flags=None) -> SessionInfo: ...

    @abstractmethod
    def resume(self, session_id, worktree, prompt, extra_flags=None) -> SessionInfo: ...

    @abstractmethod
    def get_status(self, session_id) -> WorkerStatus: ...

    @abstractmethod
    def list_sessions(self) -> list[SessionInfo]: ...

    @abstractmethod
    def stop(self, session_id) -> None: ...

    @abstractmethod
    def get_logs(self, session_id) -> str: ...

    @abstractmethod
    def has_history(self, worktree) -> bool: ...

    @abstractmethod
    def attach(self, session_id) -> None: ...

    def cleanup(self, session_id) -> None: ...  # optional
```

`SessionInfo` dataclass 包含 `id`、`name`、`status`（`WorkerStatus` 枚举）、`worktree`、`worker`。`WorkerStatus` 有 `WORKING / IDLE / NEEDS_INPUT / COMPLETED / FAILED / STOPPED / NOT_FOUND` 七种状态。

### ClaudeWorker（`coding_agent/worker/claude.py`）

通过 `claude` CLI 交互：

| 操作 | 实现 |
|------|------|
| 启动新 session | `claude --bg --name <name> <prompt>`，解析输出中的 hex session ID |
| 恢复已有 session | `claude -r <session_id> -p <prompt>`（session 存在）；`claude --continue -p <prompt>`（session 丢失但有历史） |
| 查状态 | 读 `~/.claude/jobs/<session_id>/state.json` |
| 列出 session | 遍历 `~/.claude/jobs/` 目录 |
| 停止 | `claude stop <session_id>` |
| 日志 | `claude logs <session_id>` |
| 历史检测 | `~/.claude/projects/<encoded-worktree>/*.jsonl` 是否存在 |
| Attach | `claude attach <session_id>`（exec 替换当前进程） |

`--bg` 让 Claude Code 在后台运行（detached），不需要 tmux 保活。`-r` 通过 session ID 续上已有对话。

### OpencodeWorker（`coding_agent/worker/opencode.py`）

通过 `opencode serve` 的 HTTP API 交互：

| 操作 | 实现 |
|------|------|
| 启动新 session | `POST /session`（创建）+ `POST /session/<id>/message`（发 prompt） |
| 恢复已有 session | `GET /session/<id>` 确认存在 + `POST /session/<id>/message` |
| 查状态 | `GET /session/status` |
| 列出 session | `GET /session` |
| 停止 | `POST /session/<id>/abort` |
| 日志 | `GET /session/<id>/message`（返回消息列表） |
| 历史检测 | `GET /session` 查 worktree 匹配 |
| Attach | `opencode attach <url> --session <id>`（exec 替换当前进程） |

OpencodeWorker 会自动检测 `opencode serve` 是否在运行（`GET /global/health`），未运行则 spawn 一个后台 `opencode serve` 进程。`OPENCODE_SERVER_URL` 控制连接地址，默认 `http://127.0.0.1:4096`。

## Worker 会话模型

- 每个 issue → 一个 git worktree → 一个 worker session（由 `WorkerBase` 子类管理）
- 命名：worktree = `<WORKTREE_BASE>/<SESSION_NAME_PREFIX>-<N>`、branch = `<BRANCH_PREFIX><N>`、session name = `<SESSION_NAME_PREFIX><N>`
- PR 评论触发：通过 `worker.resume(session_id, worktree, prompt)` 把 prompt 注入已有 session
- **自动 resume**：worker session 死了后被触发，daemon 先查 `worker.has_history(worktree)`——有历史就 `worker.resume()` 续上原对话（保留所有上下文 + 工具调用历史），没有就 `worker.start()` 全新起。这意味着 worker 中途退出不丢进度。
- Session 没了（worktree 也被清掉）→ 自动从 PR head branch 重建 worktree + spawn 新 session（同样按上面规则尝试 resume）
- **日志持久化**：每个 worker session 的输出 append 到 `$SESSION_LOG_DIR/<session-name>.log`（默认 `$STATE_DIR/sessions/`）。session 退出后该文件仍在，可以 `coding-agent logs <N>` / `coding-agent logs <N> -f` 回看

## 设计选择 FAQ

### 为什么用 Python 重写

- bash 脚本在复杂逻辑（状态管理、并发控制、多 worker 后端）下可维护性差——`jq` 解析 + 字符串拼接易出错，缺类型检查
- Python stdlib 覆盖了所有需要（`subprocess` / `json` / `urllib` / `pathlib` / `filelock`），**无第三方依赖**
- `WorkerBase` 抽象层用 ABC + 注册表模式，加新 worker 后端只需一个文件，不需要 fork 整套 dispatch 脚本
- 统一的 CLI（`coding-agent <command>`）替代散落的 shell 脚本，用户体验一致

### 为什么用 WorkerBase 抽象层

- 原方案把 Claude Code 的 tmux 交互硬编码在 dispatch 脚本里，换 worker 就要重写整套脚本
- `WorkerBase` 把「启动 / 恢复 / 查状态 / 停止 / 日志 / attach」抽象成统一接口，daemon 和 CLI 只跟接口打交道
- 新 worker 后端（Aider、自定义 agent）只需继承 `WorkerBase`、实现方法、加 `@register_worker`，零侵入
- `WorkerStatus` 枚举统一了不同后端的状态语义，daemon 的并发控制逻辑不用为每个 worker 写特判

### 为什么用 git worktree

- 主 working tree 不被打扰，你可以并行干自己的事
- 每个 issue 一个独立目录，依赖独立装，互不污染
- 删 worktree 不影响 git history

### 为什么不用 tmux

- Claude Code 的 `--bg` 模式自带后台运行能力，不需要 tmux 保活
- OpencodeWorker 通过 HTTP API（`opencode serve`）交互，完全不依赖伪终端
- 去掉 tmux 依赖后：少一个外部工具要求、少一层进程嵌套、日志直接由 Python 管理
- `TMUX_PREFIX` 保留在配置里做日志前缀和兼容命名，不再用于创建 tmux session

### 为什么不直接用 Claude Code 的 `--from-pr`

Claude Code CLI 有 `--from-pr` flag 但依赖 Anthropic 官方 GitHub App / Action 流。本项目走「label + 本机 daemon」就是为了**避免依赖**官方 App，让你用自己机器的环境 + Max 计划，不需要 API key。

### 为什么这套架构便宜（对比 webhook + Claude API 方案）

1. **轮询循环不烧 token**：每 60 秒跑一次的 `coding-agent poll` 是纯 Python + `gh` API 调用，**不调模型**。空闲时 0 token 消耗。只有真的发现 `pending/agent` 的 issue/PR 评论时，才 dispatch 到 worker 进程。
2. **dispatch 走 Claude Code CLI，吃 Max 月费套餐**：worker 是本机 `claude` CLI 进程，计费按你的 Pro/Max 订阅算，不需要 API key、不按 token 计价。相比传统 webhook + Anthropic API 的方案（每次触发都按 token 收钱），长期跑下来便宜一大截。
