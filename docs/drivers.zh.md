# Worker Agent Driver

> [English](drivers.md) · **中文**

`cavil-loop` 的 daemon / dispatch 脚本和「在 tmux 里跑哪个 CLI」之间隔了一层 **driver 抽象**，让任何能接受 prompt 的 chat-REPL 风格 CLI 都能当 worker。配 `WORKER_AGENT=<name>` 即可切换，无需 fork。

## 内置 driver

| Driver | CLI | 历史路径 | Busy 探测关键字 | 状态 |
|--------|-----|---------|---------------|------|
| `claude`   | `claude`   | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `esc to interrupt` | ✅ 默认、稳定 |
| `opencode` | `opencode` | `~/.local/share/opencode/...` (按版本) | `thinking` / `working` / `esc to interrupt` / `stop` | ⚠️ 首版适配，请按你装的版本核对 |
| `codex`    | `codex`    | `~/.codex/sessions/` 或 `~/.codex/history/` | `thinking` / `running` / `esc to interrupt` | ⚠️ 首版适配，请按你装的版本核对 |
| `cursor`   | `agent`    | _(不按 cwd 探测；始终 new session)_ | `thinking` / `running` / spinner / `esc to interrupt` | ✅ macOS 验收通过（headless `-p --trust --force`）；不支持 mid-session stdin 注入，新 comment 会重起 session |

切换（Cursor 示例）：

```bash
# 1. 确保 Cursor Agent CLI 在 PATH 上（`agent --help`）
#    macOS：通常随 Cursor IDE 安装

# 2. 在 cavil-loop.config 里改
WORKER_AGENT="cursor"

# 3. 重跑 setup.sh 让 daemon EnvironmentFile 的 PATH 包含 `agent`
WORKER_AGENT=cursor bash ~/.agents/skills/cavil-loop/setup.sh ~/path/to/your-project
```

> launchd/systemd 下请确保 EnvironmentFile 含 `GH_TOKEN`，worker 里的 `gh` 才会用预期 PAT（见 `cavil-loop.config` 的 `WORKER_PASS_ENV`）。

> **Cursor 注意：** `-p` 是 non-interactive print 模式，mid-task 的 issue/PR comment 无法通过 stdin 注入。driver 会 kill 当前 session 并用新 prompt 重起（Case B），不会 silent drop。

切换（Codex 示例）：

```bash
# 1. 装好对应 CLI
npm i -g @openai/codex

# 2. 在 cavil-loop.config 里改
WORKER_AGENT="codex"

# 3. 重跑 setup.sh 让 daemon EnvironmentFile 的 PATH 指向新 CLI
WORKER_AGENT=codex bash ~/.agents/skills/cavil-loop/setup.sh ~/path/to/your-project
```

> 切换 driver 后**已有的 worktree 不变**，但新建的 worker session 会用新 CLI 启动。混用风险：同一 worktree 历史是给上一个 driver 写的，新 driver 可能找不到/认不出 → 把 worktree cleanup 后再启动。

## 加新 driver

复制 `scripts/drivers/_template.sh` 为 `scripts/drivers/<your>.sh`，实现 5 个函数。

也可放项目级而不动 skill：`<host>/.agents/skills/cavil-loop/drivers/<your>.sh`，自动覆盖同名内置 driver。

### 必填函数

```bash
agent_bin
agent_has_history <cwd>
agent_is_busy <tmux_session>
agent_command_new <cwd> <session_name> <prompt_file>
agent_command_resume <cwd> <session_name> <prompt_file>
```

另有 3 个可选函数，实现了才有按角色隔离会话的能力，见
[可选 hook：会话隔离](#可选-hook会话隔离)。

### 接口语义

#### `agent_bin`
stdout 写 CLI 可执行名。setup.sh 用它 `command -v` 检查依赖、并把所在目录拼进 systemd EnvironmentFile 的 `PATH`。

#### `agent_has_history <cwd>`
返回 0 = 该 cwd 有本 agent 的历史会话（dispatch 会走 `agent_command_resume`），非 0 = 没有（走 `agent_command_new`）。

工具：`encoded_cwd "$cwd"` 把 `/foo/bar` 转成 `-foo-bar`（Claude / OpenCode 通用编码）。

#### `agent_is_busy <tmux_session>`
返回 0 = agent 正在 thinking / tool-use；非 0 = idle / dead。
通常实现：`tmux capture-pane -t $sess -p | grep -q "<某个稳定关键字>"`。

#### `agent_command_new` / `agent_command_resume`
stdout 写**一行 shell 命令字符串**。该字符串会被 `tmux new-session -d -c <cwd> "<cmd>"` 在子 shell 里求值，所以可以用 `"$(cat $prompt_file)"` 之类延迟展开。

对于按模型派工的标签，内置 driver 会把 `worker_model_arg` 的结果
（`--model <WORKER_MODEL>`）同时拼入 new / resume 命令。自定义 driver 的 CLI
如果支持单次指定模型，也应接入该 helper。

典型实现：
```bash
agent_command_new() {
    local cwd="$1" name="$2" prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    printf 'your-cli %s %s "$(cat %s)"' \
        "${YOUR_AGENT_EXTRA_FLAGS:-}" "$model_arg" "$prompt_file"
}
```

没有 resume 概念的 agent：让 `agent_command_resume` 直接调 `agent_command_new`：

```bash
agent_command_resume() { agent_command_new "$@"; }
```

### 可选 hook：会话隔离

同一个 agent 既当 worker 又当交叉复审关卡时（`REVIEW_WORKER_AGENT` 配成跟
`WORKER_AGENT` 一样的 CLI），两个角色共用一个 worktree。内置 agent 的「续接」
都是「续这个目录里最近的一条对话」，于是复审会继承 worker 的上下文——连同 worker
为自己辩解的那些话一起继承，就不再是独立复审了。反方向一样糟：复审起完自己那条
之后，worker 下一轮续到的是复审那条，反而丢掉自己的实现上下文。

所以 daemon 给每次派工打一个**角色**（`worker` / `review`，从 prompt 模板类型推），
按 `(work number, agent, 角色)` 把 session id 记在 `$STATE_DIR/agent-sessions/` 下。

driver 想接入，实现下面三个函数并把 `AGENT_SESSION_ISOLATION` 置 1：

```bash
agent_session_new_id <cwd> <role>        # 启动时要钉的 id；CLI 不支持就写空串
agent_session_exists <cwd> <session_id>  # 返回 0 = 这条会话还在、能续
agent_session_list <cwd>                 # 这个 cwd 的会话 id，最近的在前
```

启动时钉不了 id 的 CLI 还要实现第四个，并把 `AGENT_SESSION_PROOF` 置 1：

```bash
agent_session_started_with <cwd> <session_id> <prompt_file>   # 返回 0 = 这条是本次启动建的
```

`agent_command_new` / `agent_command_resume` 读 `$WORKER_SESSION_ID`：起新会话时
钉住它，续接时续的就是它。`$WORKER_SESSION_ID` 为空只会出现在「本功能上线前留下的
会话」这一种情况，那时才回落到 CLI 自己的「续最近一条」。

两种形态都支持：

| CLI 能不能在启动时钉 id | driver 怎么做 | 内置例子 |
|---|---|---|
| 能 | `agent_session_new_id` 发一个，启动命令带上 | `claude --session-id <uuid>` |
| 不能 | `agent_session_new_id` 写空串，daemon 在启动后用 `agent_session_list` 把 id 捞回来 | `codex`（0.155.0 启动侧没有这种 flag；它的会话文件在启动后约 0.5s 落盘） |

CLI 钉不了 id 的，要保证 `agent_session_list` 够便宜、且「最近的在前」：daemon 在
启动后就靠轮询它来拿到本次的 id。这一步需要真证据，这就是 `agent_session_started_with`
的用处——「我启动之后才出现的会话」不是证据：前一个角色回捞失败的话，它那条会话
可能正好落在你的窗口里。内置 codex driver 比的是会话的**启动输入**——第一条 assistant
回复之前的所有 user 消息——跟本次启动用的 prompt 文件。三种偷懒写法实测都不行：只看
第一条 user 消息（真实会话开头是仓库的 AGENTS 指令，派工 prompt 是**第二**条）、
只取第一行（多行 prompt 连自己都匹配不上）、只比固定长度前缀（共享开头会匹配到错的角色）。daemon 还会给「将要走回捞」
的那次启动在 prompt 末尾追加一行唯一标记，好让渲染结果相同的两次启动也分得开；
用 `agent_session_prompt_tag` 读它。没实现这个 hook 时，daemon 退一步：只有「候选唯一 +
这条活此前没有认领失败过」才敢认。

回捞举证不出来时，那条会话就保持无主——daemon 不会把它交给别的角色，该角色下一轮
从零起。**不要**为了补偿而让收养变聪明：worker 只收养早于角色化派工的会话，这是故意的。

不实现也能跑：daemon 那时只保证 **review 角色一律起全新会话**，worker 角色保持
上线前「续最近一条」的行为。

### 可选 override：`agent_inject_prompt <tmux_session> <prompt_file>`

默认实现是 `tmux load-buffer + paste-buffer -p + Enter`，对大多数 chat-REPL CLI 通用。需要先 `/<slash-mode>` 切模式的 agent 可在 driver 里重写覆盖。

### 可选 hook：目录信任（`agent_trust_key`、`agent_trust_paths`、`AGENT_TRUST_PROMPT_*`）

有些 agent 进到没见过的目录会先要人确认「信不信这个目录」，claude 和 codex 都是——而且跳过权限确认的 flag（`--dangerously-skip-permissions`、`--dangerously-bypass-approvals-and-sandbox`）**不绕过它**。这个弹窗不会让 session 死掉，于是 dispatch 的秒退探测放行、issue 照常翻成 `doing/agent`：worker 看着活着，其实一动不动。

三样都是可选的，统一走 `scripts/drivers/_common.sh` 里的入口 `agent_trust_dirs <dir>...`：

- `agent_trust_key <dir>`：在 `<dir>` 里起会话时，agent **实际**按哪个目录判断信任。不是「目录本身或任一上级」——2026-11 实测（GitHub#108），在 git 仓库里两个 agent 都不认上级目录。不实现就按目录本身算。
- `agent_trust_paths <key>...`：把这些 key 记成可信。必须幂等：已经信任就一个字节都不写（那个文件通常正被活着的 agent 进程占着）。写文件一律走下面的 `trust_config_locked_update`，不要自己读改写。
- `AGENT_TRUST_PROMPT_TITLE` / `AGENT_TRUST_PROMPT_OPTION_RE` / `AGENT_TRUST_PROMPT_FOOTER_RE`：确认框的**结构**——屏幕最后一个非空行是框的底栏，其上有一整行是「信任」选项，标题（定长字符串，允许折行）也在这几行里。三样都设了，daemon 每次起完会话都看一眼屏幕（判定在 `_common.sh` 的 `agent_trust_prompt_on_screen`）；认出框就杀会话、转人工（`pending/human`），留言写清哪个 agent、哪个目录、该补哪条记录。不能只认一个短语：会话里引用这句话（改的正是这个功能时天天出现）会被误杀（PR #110 复审复现过）。三样照真机截屏写，截屏放进 `tests/fixtures/trust-dialog/`，同底栏的其他框也截一张当反例（claude 的 bypass permissions 确认框、codex 的升级提示）。

什么时候调：`setup.sh` 每次部署给仓库根调一次；**每次派工**在起会话之前都调——三个派工脚本的新建、续接、续接失败后重建全都算（调用放在 `agent_session_plan` 里）。必须每次派工都调：codex 对子模块项目按每个 worktree 单独记，部署时还不知道这些路径；顺带让这个改动之前部署的项目不用重跑 setup。写不成不挡派工——真卡在框上的那次由弹框识别兜住。

内置 driver 的规则（真 CLI 实测：claude 2.1.316 用隔离配置目录，codex 0.163.0）：

| 在哪里起会话 | claude 认 | codex 认 |
|---|---|---|
| 普通仓库的主 checkout 或它的 worktree | 主 checkout 目录 | 主 checkout 目录（框里写着「Trusting will apply to the repository root」） |
| 子模块，或子模块的 worktree | `<上层仓库>/.git/modules/<名字>` | worktree 自己（每个 issue 一条） |
| bare 仓库的 worktree | bare 仓库目录（同一规则推出，未实测） | worktree 自己 |
| 不在 git 里 | 目录本身或任一上级 | 目录本身 |

旧版 `setup.sh` 还写一条「worktree base」，以为 worktree 会继承它——从来没起过作用，已去掉。普通项目不弹，只是因为仓库根那条在。

`claude` 写 `~/.claude.json` 的 `projects["<绝对路径>"].hasTrustDialogAccepted`（`CLAUDE_JSON_PATH` 可改）；`codex` 在 `${CODEX_HOME:-~/.codex}/config.toml` 末尾追加 `[projects."<绝对路径>"] trust_level = "trusted"`（要 Python 3.11+ 的 `tomllib`；没有就不写、派工日志里会说）。配置文件是软链接（dotfiles）时只靠 `readlink` / `cd -P` 解析真实路径；解析不了（链接成环、目录建不出）就不写——直接替换会把链接换成普通文件，用户的 dotfiles 从此和真实配置分家，不重写文件其余部分，人设成非 `trusted` 的条目不改。

**并发。** 同一台机器上所有项目的 daemon 共用这两个文件，但各项目的轮询锁各管各的。两个「读 → 合并 → 原子替换」同时跑，会互相抹掉对方刚加的条目、两边都报成功——原子替换只防半截文件。所以 `trust_config_locked_update` 拿一把**按配置文件真实路径划分**的锁（在 `~/.local/state/cavil-loop-trust-locks/` 下，所有项目、新旧安装共用），拿到锁之后才读、判断、生成、替换。最多等 `TRUST_LOCK_WAIT_SECS`（10 秒），超时就不写。起会话后的弹框识别最多看 `AGENT_TRUST_PROMPT_WAIT_SECS`（4 秒；claude 实测 0.3 秒内出框），会话自己退了就不再等。

正在跑的 claude / codex 和手工编辑不认这把锁。替换前会再比一次内容指纹，变了就丢掉重来（最多 3 次），替换后读回核对。**保证不了的**：最后一次比对到替换之间那一瞬有人写入，会被覆盖；agent 按它自己的旧副本整体写回，可能冲掉刚加的记录。下次派工会再补；真卡在框上的那次由弹框识别变成明确的转人工。

## 验证你的 driver

```bash
# 1. 手动起一个 worker session 看启动是否成功
CODING_AGENT_CONFIG=~/path/to/your-project/cavil-loop.config \
    WORKER_AGENT=<your> bash ~/.agents/skills/cavil-loop/scripts/dispatch-new-issue.sh <test-issue-N>

# 2. 进 tmux 看
tmux attach -t <project>-issue<N>

# 3. 让 agent 跑一会儿，然后从外面查 busy 探测是否对上
CODING_AGENT_CONFIG=... WORKER_AGENT=<your> \
    bash -c 'source ~/.agents/skills/cavil-loop/scripts/_lib.sh; \
             agent_is_busy "<project>-issue<N>" && echo BUSY || echo IDLE'
```

如果某个内置 driver 在你机器上行为不对，欢迎提 issue / PR 修。
