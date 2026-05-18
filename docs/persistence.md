# 按 issue 归类：事后随时找得到，断点随时能续上

每个 issue 的产物——设计方案、代码、Claude 的完整对话（含思考过程和工具调用）、tmux 历史——都用 **issue 号**绑在一起：worktree、branch、tmux session、Claude session、pane log 文件名都带 `issue<N>`。**记得 issue 号就能定位到任何一类产物**，不像裸用 AI 时那种「曾经聊过什么」要在一堆 session 里翻名字。

机器重启、tmux 误关、PR merge 自动 cleanup——按 issue 号都能找回 / 接着干。下面分两半：先列每类产物存哪，再给具体 SOP。

## 资产全清单

| 资产 | 路径 / 位置 | 谁会清理 | 备份建议 |
|------|------|------|------|
| 设计方案 | GitHub issue comment（worker 第一阶段产物） | 没人；issue 关了也在 | 无（GitHub 永久） |
| 讨论过程 | GitHub issue / PR comment thread | 没人 | 无 |
| 代码分支 | `feature/issue-N`（本地 + remote） | 你手动 `git branch -d` 才会删 | remote 即备份 |
| 中间 commit | git reflog + worktree 历史 | git 90 天 gc 后可能清未引用对象 | merge 前及时 push |
| Worktree | `$WORKTREE_BASE/issue-N/` | `AUTO_CLEANUP_ON_MERGE=true` 时 daemon 在 PR merge 后删 | 不需要备份（branch 在 remote） |
| Tmux 活会话 | tmux session `<TMUX_PREFIX>-issue<N>` | `AUTO_CLEANUP_ON_MERGE=true` 时 daemon 在 PR merge 后杀；机器重启自然消失 | 不可备份（运行时状态） |
| Tmux 历史输出 | `$STATE_DIR/sessions/<TMUX_PREFIX>-issue<N>.log`（append-only） | 没人；同一 issue 重起 session 续写同一份 | 文件即备份 |
| Claude 对话历史（含 thinking + tool_use 全程） | `~/.claude/projects/<encoded-cwd>/*.jsonl` | **没人**；`AUTO_CLEANUP_ON_MERGE` 不动这里 | 文件即备份 |
| 派工去重 / 进度 | `$STATE_DIR/state.json` | 没人；daemon 重启不丢 | 偶尔 cp 一份 |

> `<encoded-cwd>` 是把绝对路径的 `/` 全替换成 `-`。例如 `/home/sky/github/worktree/myproject/issue-42` → `-home-sky-github-worktree-myproject-issue-42`。

## 保留多久

短答：**只要你不删、磁盘还在，就一直在**。本工具 + Claude Code + git 都没有自动 GC 机制——

- **GitHub issue / PR / comment**：GitHub 永久保留，issue 关掉、PR merge 都不会消失
- **git branch + commit**：本地 + remote 都没自动清理；只有 `git gc` 清的是**没引用**的对象，所以只要 push 上去 / merge 进 main 就稳
- **`~/.claude/projects/<encoded-cwd>/*.jsonl`**：Claude Code 不自动清理（help 里没有 `--gc/--prune/--retain` 这类 flag、settings.json 也没保留期字段，截至 2026-05）。注意：Anthropic 未来策略可能加，长期归档想稳，自己 `cp -r ~/.claude/projects/` 到备份盘
- **`$STATE_DIR/sessions/*.log`、`$STATE_DIR/state.json`**：纯本机文件，没人清

**唯一会缩水的**：worktree 里的"中间 commit"如果**既没 push 也没 merge**，超过 90 天会被 `git gc` 当孤儿对象清掉。所以养成 push 习惯就稳。

## 事后查阅 SOP

### 「半年后想知道当时为什么这样设计」

GitHub 上一站式：

```bash
gh issue view <N> --repo <owner>/<repo> --comments    # 设计方案 + 讨论
gh pr list --repo <owner>/<repo> --search "<N> in:body" --state all   # 找对应 PR
gh pr view <P> --comments                              # 评审讨论 + 最终结论
```

### 「想看当时 Claude 怎么一步步推导的」

两条线索互补 —— **tmux pane log** 看终端原始输出，**Claude jsonl** 看完整 prompt/response 结构化历史：

```bash
# Tmux pane log（人类可读，按时间顺序）
bash ~/.agents/skills/coding-agent-work-loop/scripts/session-log.sh <N> -c

# Claude 会话原始 jsonl（按 cwd 索引）
ls ~/.claude/projects/<encoded-cwd>/
jq -r '.message.content' ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl | less
```

### 「想 diff 当时的中间实现 vs 最终 merge 的」

```bash
git log --all --source -- <file>           # 列出所有触碰过该文件的 commit
git reflog show feature/issue-N            # 看分支 HEAD 历史移动
gh pr diff <P>                             # 最终合入的 diff
```

## 断点续写 SOP

### Worker 干到一半电脑重启了

机器恢复后，daemon 下一轮 poll（最多 60s）自动重派工：发现 worktree + session 都没了，从 PR head branch 重建 worktree、起新 tmux session。**Claude 的对话历史不会自动续上**（新 session 是新对话），但磁盘上的 jsonl 还在 —— 想接上参考下一节。

### Tmux session 被误关 / `auto-cleanup` 清了 worktree

数据**没丢**，恢复路径四选一：

```bash
# ① 知道 session ID（看 jsonl 文件名）
claude --resume <session-id>          # 任何目录都能恢复

# ② 知道对应 PR 号
claude --from-pr <P>                   # 按 PR 索引恢复（见下面"机制"）

# ③ 啥都没记住，靠 picker
mkdir -p <原 worktree 路径>            # 重建空目录骗 picker
cd <原 worktree 路径>
claude --resume                        # picker 列当前 cwd 的所有会话

# ④ 工具都失灵，直接读源文件
jq . ~/.claude/projects/<encoded-cwd>/*.jsonl
```

> `claude --continue`（`-c`）只看**当前目录最近一次会话**，cleanup 后切目录就用不上；要跨目录恢复必须 `--resume`/`--from-pr`。

**`--from-pr` 是怎么对上 PR 的**：每条 jsonl 消息里有 `cwd`（当时的工作目录）和 `gitBranch`（当时的 git 分支）字段。`--from-pr <P>` 通过 `gh pr view <P>` 拿到 PR 的 head ref（比如 `feature/issue-42`），再到 `~/.claude/projects/` 下扫所有 jsonl，匹配 `gitBranch` = head ref 的会话拉起。所以**前提是 worker 当年用 `git checkout feature/issue-42` 启动 Claude**——本工具的 dispatch 脚本就是这么做的，天然兼容。

> 想自己 100% 锁定恢复目标 → 用 session ID（`claude --resume <uuid>`）。session ID 就是 `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` 的文件名 uuid。
>
> 进一步想让 worker 启动后自动把自己的 session ID 评论到 issue/PR（方便事后 `--resume <uuid>` 一键定位），是个**值得做但超出本 doc 范围的增强**，欢迎开新 issue 跟踪。

## auto-cleanup 边界

`AUTO_CLEANUP_ON_MERGE=true`（默认开）在 daemon 看到 PR merged 时触发，**只清运行时状态**：

| 会清 | 不会清 |
|------|------|
| `$WORKTREE_BASE/issue-N/`（worktree 目录） | git branch（本地 + remote） |
| Tmux session `<TMUX_PREFIX>-issue<N>` | `~/.claude/projects/<encoded-cwd>/*.jsonl` |
| `CLEANUP_HOOK` 钩子（端口 / tunnel / 通知） | `$STATE_DIR/sessions/*.log`（tmux pane log） |
|  | `$STATE_DIR/state.json` |
|  | GitHub issue / PR / comment |

想关掉自动清理（merge 后什么都不动，留全人工）：

```bash
# coding-agent.config
AUTO_CLEANUP_ON_MERGE="false"
```

之后想清就跑 `bash $SKILL_DIR/scripts/cleanup-issue.sh <N>`，flag 见 [operations.md](operations.md)。
