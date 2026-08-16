#!/usr/bin/env bash
# 公共库：所有脚本通过 source _lib.sh 引入配置 + 工具函数。
# 调用方在脚本顶部：
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/_lib.sh"
#
# 配置查找顺序：
#   1. $CODING_AGENT_CONFIG 环境变量（systemd 用 EnvironmentFile 注入）
#   2. 当前 cwd 向上找 coding-agent.config
#   3. 找不到 → fail
set -euo pipefail

# ── 关掉从父进程继承来的 poll.lock fd ──
# agent-poll.sh 用 `exec 9>"$LOCK_FILE"` + flock 防两轮 poll 撞车。fd 9 会一路继承给
# 它 fork 出来的 dispatch 脚本，再继承给 `tmux new-session` 拉起的 tmux server 和它下面
# 的 worker —— 这些都是要活几小时的常驻进程。
#
# flock 是随「打开文件描述」走的：只要还有任何一个进程持有那个 fd，锁就不释放。所以
# 一旦 tmux server 落在 poll 自己的进程树下，poll 退出后锁仍被 worker 攥着，之后每一轮
# 都只能打印「上一轮还没跑完，跳过」——daemon 彻底停摆，且没有任何报错。
#
# 以前 systemd 的 KillMode=control-group 顺手杀光残留进程，掩盖了这个问题；改成
# process 让 tmux server 得以存活之后（见 systemd/coding-agent-poll@.service），
# 这条继承链就必须显式切断。
#
# 放在这里是因为：agent-poll.sh 是**先 source 本文件、后 exec 9>** 的，所以对 poll
# 自己是 no-op；而所有 dispatch / cleanup 子脚本都在顶部 source，正好在它们 spawn
# 常驻进程之前把 fd 关掉。关一个没打开的 fd 在 bash 里是安全的。
exec 9>&- 2>/dev/null || true

# ── daemon PATH 强化 ──
# systemd user timer 跑 daemon 时 PATH 通常 = minimal "/usr/local/sbin:/usr/local/bin:
# /usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"，**不含** user
# 自装 binary 目录如 ~/.hermes/node/bin（claude code 默认装位置）、~/.local/bin、
# ~/.cargo/bin 等。daemon 进程自己 `which claude` 都 fail → dispatch script 跑的
# 命令字符串里 "claude" 解析不到 → worker session 起来 exec claude `command not found`
# 立即 exit 127 死。
#
# 即便 tmux_env_args -e PATH=$PATH 透传给 worker session，daemon PATH 本身就坏 →
# 透传一份坏 PATH 出去仍找不到 claude。
#
# 修：daemon 进程 PATH 头部 prepend 常见 user binary 目录。conf 文件 `PATH=...` 仍
# 可 override（source CONFIG_FILE 在本段之后）。
PATH="$HOME/.hermes/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export PATH

find_config() {
    if [ -n "${CODING_AGENT_CONFIG:-}" ] && [ -f "$CODING_AGENT_CONFIG" ]; then
        echo "$CODING_AGENT_CONFIG"
        return
    fi
    local d="$PWD"
    while [ "$d" != "/" ]; do
        if [ -f "$d/coding-agent.config" ]; then
            echo "$d/coding-agent.config"
            return
        fi
        d="$(dirname "$d")"
    done
    echo ""
}

CONFIG_FILE="$(find_config)"
if [ -z "$CONFIG_FILE" ]; then
    echo "[coding-agent] ERROR: 找不到 coding-agent.config" >&2
    echo "  1) 在 host project 根放一份（参考 \$CLAUDE_PLUGIN_ROOT/coding-agent.config.example）" >&2
    echo "  2) 或 export CODING_AGENT_CONFIG=/path/to/config" >&2
    exit 2
fi
# shellcheck disable=SC1090
source "$CONFIG_FILE"

# 必填校验
: "${REPO:?REPO 未设}"
: "${PROJECT_ROOT:?PROJECT_ROOT 未设}"
: "${WORKTREE_BASE:?WORKTREE_BASE 未设}"
: "${STATE_DIR:?STATE_DIR 未设}"
: "${TMUX_PREFIX:?TMUX_PREFIX 未设}"
: "${BRANCH_PREFIX:?BRANCH_PREFIX 未设}"
: "${SESSION_NAME_PREFIX:?SESSION_NAME_PREFIX 未设}"
: "${LABEL_PENDING_AGENT:?LABEL_PENDING_AGENT 未设}"
: "${LABEL_PENDING_HUMAN:?LABEL_PENDING_HUMAN 未设}"
# 兼容老配置：未设时给默认值
LABEL_PENDING_AGENT_DEFAULT="$LABEL_PENDING_AGENT"
LABEL_PENDING_AGENT_FABLE="${LABEL_PENDING_AGENT_FABLE:-pending/agent/fable}"
FABLE_MODEL="${FABLE_MODEL:-claude-fable-5}"
FABLE_WORKER_AGENT="${FABLE_WORKER_AGENT:-claude}"

# ── 交叉 review 关卡（可选）──
# 设了 LABEL_PENDING_REVIEW 才启用：worker 产出代码后不直接翻 pending/human，
# 而是翻到这个 label；daemon 看到它用**另一个 agent**（默认 codex）起独立 session
# 做 review，通过才翻 pending/human，不通过打回 pending/agent 重修。
# 留空 = 关闭，行为与从前完全一致（其它项目不受影响）。
LABEL_PENDING_REVIEW="${LABEL_PENDING_REVIEW:-}"
REVIEW_WORKER_AGENT="${REVIEW_WORKER_AGENT:-codex}"
REVIEW_MODEL="${REVIEW_MODEL:-}"
# 打回重修的轮次上限，超了就转人工。**它唯一的作用是防两个 agent 互相打回烧 API**，
# 所以人显式要的 review 不受它约束（review 模板负责实现这条）：
#   - 人手动挂 review 标签 → 无视上限，照常审
#   - 人留了评论 → 计数从那条评论之后重新算，自然归零
# 轮次不存 state.json，而是数 issue/PR 上「最近一次人工动作之后」的
# <!-- codex-review-round --> 标记：看板上看得见、state 丢了也不会重置。
REVIEW_MAX_ROUNDS="${REVIEW_MAX_ROUNDS:-3}"
# 「worker 产出可评审的东西之后该翻到哪个 label」——模板一律用这个占位符，**不要**直接写
# ${LABEL_PENDING_REVIEW}。启用 review 关卡时它是 pending/review，没启用时自动退化成
# pending/human，于是同一份模板在开/关两种配置下都对，review 环节变成纯配置开关。
#
# 直接写 ${LABEL_PENDING_REVIEW} 的后果：项目没配这个 label 时渲染成空串 → worker 执行
# `flip_label N --add "" --remove doing/agent` → 活丢了 doing/agent 又没拿到任何 pending
# 标签，从看板上彻底消失；self-heal 只扫 doing/agent，也捞不回来。
LABEL_REVIEW_OR_HUMAN="${LABEL_PENDING_REVIEW:-$LABEL_PENDING_HUMAN}"
# agent-poll 给 child dispatch 传这个变量，令同一套 prompt / label flip 逻辑
# 针对实际触发标签工作；daemon 自己不传时仍使用普通 pending/agent。
LABEL_PENDING_AGENT="${DISPATCH_PENDING_AGENT_LABEL:-$LABEL_PENDING_AGENT_DEFAULT}"
LABEL_AGENT_DOING="${LABEL_AGENT_DOING:-doing/agent}"
LABEL_PENDING_PR="${LABEL_PENDING_PR:-pending/PR}"
LABEL_DONE="${LABEL_DONE:-Done}"
# PR 创建后调用的 hook（agent 在 tmux 里执行）。
# 相对路径解释为相对 PROJECT_ROOT。留空跳过。
# Hook env: PR, ISSUE, WORKTREE, BRANCH, REPO, PROJECT_ROOT
PR_CREATED_HOOK="${PR_CREATED_HOOK:-}"
# Worker 写回 GitHub 的内容（issue / PR 评论、设计提案、PR body）用的语言。
# ISO 639-1 code. Default "en"。代码 / commit / 分支名仍按仓库惯例，不受影响。
OUTPUT_LANGUAGE="${OUTPUT_LANGUAGE:-en}"

# Worker agent CLI（claude / opencode / codex / cursor / 你自家 driver）。
# 默认 claude → 行为完全等同未引入 driver 抽象前。
WORKER_AGENT_DEFAULT="${WORKER_AGENT:-claude}"
WORKER_AGENT="${DISPATCH_WORKER_AGENT:-$WORKER_AGENT_DEFAULT}"
# 单次 dispatch 指定的模型；空 = agent 自己的默认模型。
WORKER_MODEL="${WORKER_MODEL:-}"

# Outbound GitHub 评论里附时间+token 元数据 footer（on / off）。默认 on。
# 项目级 prompt 模板可读 ${COMMENT_FOOTER}，自行决定本项目是否加 footer。
COMMENT_FOOTER="${COMMENT_FOOTER:-on}"

mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/poll.log"

# Pane log 目录：tmux pipe-pane 把 worker session 的输出旁路到文件，
# 这样 tmux session 退出后还能 cat / less 回看历史。
# 默认 $STATE_DIR/sessions。在 coding-agent.config 里显式置空 (SESSION_LOG_DIR="") 即可关闭。
SESSION_LOG_DIR="${SESSION_LOG_DIR-$STATE_DIR/sessions}"

# Skill 目录（scripts/ 的父目录）。Claude Code 注入 $CLAUDE_PLUGIN_ROOT 时优先它。
SKILL_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

log() {
    echo "[$(date -Iseconds)] [${TMUX_PREFIX}] $*" | tee -a "$LOG_FILE" >&2
}

# agent_inject_prompt 的带日志包装。**注入相关的排障一律走这个，别直接调 driver。**
#
# 为什么要有它：default_inject_prompt 把「卡在 modal」「idle 重试 5 次」这类关键诊断
# 写在 stderr 上，而 dispatch 脚本是被 agent-poll.sh 直接 `bash ...` 调起的、stderr
# 没有接进 $LOG_FILE —— 于是 poll.log 里**一条都没有**（全仓 grep 命中 0），信息全
# 漏进了 systemd journal。2026-07-29 排「注入失败率 98%」时就因为这个盲飞了半个月，
# 最后是靠 journalctl 才捞出「10 次全是同一分支」这个决定性线索。
#
# 用临时文件而不是 `2> >(...)` 进程替换：后者的输出可能在函数返回之后才落盘，跟
# 后续 log 行交错，排障时时序看着是乱的。
inject_prompt_logged() {
    local sess="$1" prompt_file="$2"
    local err rc line
    err="$(mktemp)"
    agent_inject_prompt "$sess" "$prompt_file" 2>"$err"
    rc=$?
    if [ -s "$err" ]; then
        while IFS= read -r line; do
            [ -n "$line" ] && log "  [inject] $line"
        done < "$err"
    fi
    rm -f "$err"
    return "$rc"
}

# worker session 判活：必须 EXACT 匹配。tmux `has-session -t NAME` 默认按前缀/fnmatch
# 匹配，会把 worker session `tutor-issueN` 误配到并存的 preview `tutor-issueN-server`
# 上（session 早死了却报"存在"），导致 self-heal / 派工判活全假阳性。加 `=` 前缀关掉
# 模糊匹配，只认同名 session。所有针对 worker session 的存活判断都走这个。
session_alive() {
    tmux has-session -t "=$1" 2>/dev/null
}

# self-heal 连续失败计数（防损坏会话被无限自动重派烧 API）。key = issue_n。
# 每次探到 session 死就 bump，探到活就 reset；累计超 SELFHEAL_MAX_RETRIES 转人工。
SELFHEAL_DIR="$STATE_DIR/selfheal"
selfheal_bump() {
    mkdir -p "$SELFHEAL_DIR"
    local f="$SELFHEAL_DIR/$1" c=0
    [ -f "$f" ] && c=$(cat "$f" 2>/dev/null || echo 0)
    c=$((c + 1)); echo "$c" > "$f"; echo "$c"
}
selfheal_reset() {
    rm -f "$SELFHEAL_DIR/$1" 2>/dev/null || true
}

branch_to_issue_num() {
    local branch="$1"
    local prefix_escaped
    prefix_escaped=$(printf '%s' "$BRANCH_PREFIX" | sed 's/[.[\*^$/]/\\&/g')
    if [[ "$branch" =~ ^${prefix_escaped}([0-9]+) ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo ""
    fi
}

# 找一个 PR 对应的「工作编号 N」，用作 worktree / tmux / branch 命名标识。
# fallback 链（任何一步成功就返回）：
#   1. 分支名匹配 BRANCH_PREFIX → 拿数字（覆盖 daemon 自己派工出来的 PR）
#   2. PR body 找 Closes/Fixes/Resolves/Refs #N → 拿数字（外部贡献者 / 手开 PR 但绑 issue）
#   3. fallback 到 PR 编号本身（catch-all：unrelated meta PR / doc fix / external PR）
#
# 设计前提：GitHub 上 issue/PR 共用编号 namespace，第 3 步 fallback 不会跟某个 issue 撞 id。
# 跨平台（GitLab MR、Bitbucket 等）独立 namespace 的情况未来用 adapter 层隔离。
pr_to_issue_num() {
    local pr="$1"
    local branch="$2"
    local n

    # 1. 分支名
    n="$(branch_to_issue_num "$branch")"
    [ -n "$n" ] && { echo "$n"; return; }

    # 2. PR body 关键词
    n=$(gh pr view "$pr" --repo "$REPO" --json body --jq '.body // ""' 2>/dev/null \
        | grep -oiE '(close[sd]?|fix(es|ed)?|resolve[sd]?|refs?)[[:space:]]+#[0-9]+' \
        | head -1 \
        | grep -oE '[0-9]+' || true)
    [ -n "$n" ] && { echo "$n"; return; }

    # 3. fallback：PR 编号本身
    echo "$pr"
}

# 列出本项目的所有 worker session 名字（不含 dev server 或别的同前缀 session）。
# tmux ls 格式 "name: 1 windows ..."，awk -F: 取 field 1 后用 ^...$ 严格匹配。
list_worker_sessions() {
    tmux ls 2>/dev/null | awk -F: -v p="^${TMUX_PREFIX}-${SESSION_NAME_PREFIX}[0-9]+\$" '$1 ~ p {print $1}'
}

# 数活的 worker：用 GitHub 上 `doing/agent` 标签作真值——
# daemon dispatch 时立刻贴上、worker 完工时翻成 pending/human，
# 期间 label 没改 = 工作还在进行中。
#
# 老方案用 tmux capture-pane 找 "esc to interrupt" 字串判 busy，
# 但该字串只在 agent 正在 streaming token 那一瞬间出现——
# worker 在等 permission 弹窗 / 读文件 / tool 调用间隙时都没了，
# 导致 daemon 误以为 idle 又派下一个，破坏 MAX_CONCURRENT_WORKERS。
# label 是 workflow 层意图的表达，远比 pane 内省可靠。
count_active_workers() {
    local issues prs
    issues=$(gh issue list --repo "$REPO" --state open --label "$LABEL_AGENT_DOING" \
        --json number --jq 'length' 2>/dev/null || echo 0)
    prs=$(gh pr list --repo "$REPO" --label "$LABEL_AGENT_DOING" \
        --json number --jq 'length' 2>/dev/null || echo 0)
    echo $((issues + prs))
}

# 列出活的 worker：以 issue 为主显示，如果正在跑 PR（doing/agent on PR）就用括号补
# 上 PR 编号。同款 doing/agent 标签真值；给 log 用。
#
# 输出格式（每行一个 worker）：
#   issue #42              ← 只 issue doing/agent（设计阶段 / 实现阶段还没开 PR）
#   issue #51 (PR #56)     ← PR doing/agent 且通过 pr_to_issue_num 找得到关联 issue
#   PR #43                 ← PR doing/agent 但找不到关联 issue（standalone 元 PR / external PR）
list_active_workers() {
    local issue_nums pr_data
    issue_nums=$(gh issue list --repo "$REPO" --state open --label "$LABEL_AGENT_DOING" \
        --json number --jq '.[] | .number' 2>/dev/null || true)
    pr_data=$(gh pr list --repo "$REPO" --label "$LABEL_AGENT_DOING" \
        --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)

    local -A handled_issue=()
    local -a items=()
    local n pr branch

    # 先处理 PR：算 issue_n（用 pr_to_issue_num fallback 链）并合并显示。
    # 末尾附 GitHub URL 让终端自动识别成可点击链接（多数现代终端支持）。
    # URL 指向 worker 当前主战场——PR 阶段就指 PR、纯 issue 阶段就指 issue。
    if [ -n "$pr_data" ]; then
        while IFS=$'\t' read -r pr branch; do
            n=$(pr_to_issue_num "$pr" "$branch")
            if [ "$n" = "$pr" ]; then
                # standalone：fallback 到 PR 编号本身（无关联 issue / 外部 PR）
                items+=("PR #$pr  https://github.com/${REPO}/pull/${pr}")
            else
                items+=("issue #$n (PR #$pr)  https://github.com/${REPO}/pull/${pr}")
                handled_issue[$n]=1
            fi
        done <<< "$pr_data"
    fi

    # 再处理只 issue doing/agent（且没被任何 PR 关联到）的：单独显示
    if [ -n "$issue_nums" ]; then
        while read -r n; do
            [ -z "$n" ] && continue
            if [ -z "${handled_issue[$n]:-}" ]; then
                items+=("issue #$n  https://github.com/${REPO}/issues/${n}")
            fi
        done <<< "$issue_nums"
    fi

    # 注意：用 if 而不是 `[ ... ] && printf ...`——当 items 空时短路返回 exit 1，
    # set -e 下命令替换 active_list=$(list_active_workers) 会让 caller 整个 script 死。
    if [ ${#items[@]} -gt 0 ]; then
        printf '%s\n' "${items[@]}"
    fi
    return 0
}

# 构造 tmux new-session 的 -e 参数，把 WORKER_PASS_ENV 列的 env 透传给 worker。
# tmux 默认不继承父 shell 的 env，必须显式 -e VAR=VALUE。
# 默认透传 GH_TOKEN（让 worker 里的 gh CLI 用正确的 PAT，而不是 fallback 到 gh auth 默认账号）。
# 列在 WORKER_PASS_ENV 但 env 里没设的变量，会 log warn（典型：手动跑 daemon 但
# 没 export GH_TOKEN —— 否则 worker 静默走 gh 默认 token，导致多账号下 403）。
tmux_env_args() {
    # PATH 硬透传：worker 跑 claude / git / node 等 binary 全靠 PATH 找。tmux new-session
    # 启的 child shell **继承的是 tmux server 启动时的 PATH**，**不继承** dispatch script
    # 自己的 PATH——如果 tmux server 启动时 user 自装 binary 目录（~/.hermes/node/bin、
    # ~/.local/bin/foo 等）不在 PATH 里，worker exec claude 立即 `command not found`、
    # session exit 127 死掉。dispatch script 自己跑时 PATH 是 systemd EnvironmentFile
    # 给的、含 claude；显式 -e PATH=$PATH 把这份 PATH 传给 worker session 才稳。
    # conf 不用列 PATH（即便列也 dedupe 不重复透传）。
    local vars="PATH ${WORKER_PASS_ENV:-GH_TOKEN}"
    local seen=""
    for var in $vars; do
        case " $seen " in *" $var "*) continue ;; esac
        seen="$seen $var"
        local val
        eval "val=\${$var:-}"
        if [ -n "$val" ]; then
            printf -- '-e\0%s=%s\0' "$var" "$val"
        elif [ "$var" != "PATH" ]; then
            # PATH 当前 shell 一定有，不可能空；其他 var 空就 warn
            # 写 stderr，agent-poll.sh 的 log 会捕获到
            echo "[coding-agent] WARN: WORKER_PASS_ENV 含 '$var' 但当前 env 没设；worker 不会拿到它。" >&2
            echo "[coding-agent]       手动跑 daemon 请先 export $var=...（systemd 路径自动从 EnvironmentFile 注入）" >&2
        fi
    done
}

tmux_session_name() {
    echo "${TMUX_PREFIX}-${SESSION_NAME_PREFIX}$1"
}

# Agent 侧 session display name（claude -n / opencode / codex 都用作 conversation
# 的 cosmetic 标签——出现在 /resume picker / 终端标题 / prompt box）。用完整
# GitHub URL —— iTerm2 / kitty / wezterm / vscode / 现代 gnome-terminal 会
# 自动识别 https://... 文本并加 hyperlink，用户从 claude UI 直接 ⌘-click 跳到
# GitHub 那条 issue / PR。
#
# 用 `/issues/N` 不用 `/pull/N`：GitHub 内部对 PR 走 `/issues/N` 自动 redirect 到
# 正确 PR 页；`/pull/N` 当 N 是真 issue 时反而 404。统一 `/issues/N` 不破不漏。
#
# 注：display name 不参与历史定位（agent_has_history 走 cwd），改 name 不破坏
# 既有 conversation——老 worker --continue 仍能 resume，只是显示的 name 变了。
worker_session_name() {
    echo "https://github.com/${REPO}/issues/$1"
}

worktree_path() {
    echo "${WORKTREE_BASE}/${SESSION_NAME_PREFIX}-$1"
}

branch_name() {
    echo "${BRANCH_PREFIX}$1"
}

# 取 work number 对应的 GitHub issue 标题。GitHub 的 /issues/N REST endpoint
# 对普通 issue 和 PR 都有效，所以 pr_to_issue_num fallback 到 PR number 时也能显示标题。
github_issue_title() {
    local issue="$1"
    run_gh_capture "读取 issue #$issue 标题" \
        gh api "repos/$REPO/issues/$issue" --jq .title
}

# 给 worker session 加可读标题、记录实际 worker / 模型，并让 tmux 默认的 prefix+s
# choose-tree 在 session 行显示标题。
# `#{E:tree_mode_format}` 保留 tmux 自带的 pane/window/session 格式；只在 session 行追加
# session-scoped @desc。@worker_agent / @worker_model 用来判断复用时是否需要重启。
# 每次建/复用 worker session 都重设，tmux server 重启后也能自愈。
configure_tmux_session_display() {
    local sess="$1"
    local desc="${2:-}"
    local tree_format
    tree_format='#{E:tree_mode_format}#{?#{||:#{pane_format},#{window_format}},,#{?@desc, | #{@desc},}}'

    session_alive "$sess" || return 0

    if [ -n "$desc" ] && ! tmux set-option -t "$sess" @desc "$desc" 2>&1 | \
        sed 's/^/  [tmux] /' | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 设置 tmux session $sess 的 @desc 失败（worker 继续运行）"
    fi

    if ! tmux set-option -t "$sess" @worker_model "$WORKER_MODEL" 2>&1 | \
        sed 's/^/  [tmux] /' | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 设置 tmux session $sess 的 @worker_model 失败（worker 继续运行）"
    fi

    if ! tmux set-option -t "$sess" @worker_agent "$WORKER_AGENT" 2>&1 | \
        sed 's/^/  [tmux] /' | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 设置 tmux session $sess 的 @worker_agent 失败（worker 继续运行）"
    fi

    if ! tmux bind-key -T prefix s choose-tree -Zs -F "$tree_format" 2>&1 | \
        sed 's/^/  [tmux] /' | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 配置 tmux prefix+s session 列表失败（worker 继续运行）"
    fi
}

# 返回 0 表示现有 session 已使用本次 dispatch 要求的 worker 和模型。老 session
# 没有元数据时按项目默认 worker + 默认模型处理，所以普通 pending/agent 不会无故重启。
tmux_session_matches_worker() {
    local sess="$1"
    local actual_agent actual_model
    actual_agent="$(tmux show-options -qv -t "$sess" @worker_agent 2>/dev/null || true)"
    actual_model="$(tmux show-options -qv -t "$sess" @worker_model 2>/dev/null || true)"
    [ -n "$actual_agent" ] || actual_agent="$WORKER_AGENT_DEFAULT"
    [ "$actual_agent" = "$WORKER_AGENT" ] && [ "$actual_model" = "$WORKER_MODEL" ]
}

# 给一个 tmux session 名拼出对应的 pane log 路径。
# SESSION_LOG_DIR 为空 → 返回空字符串，调用方据此跳过日志。
session_log_path() {
    local sess="$1"
    [ -z "${SESSION_LOG_DIR:-}" ] && { echo ""; return; }
    echo "$SESSION_LOG_DIR/${sess}.log"
}

# 在指定 tmux session 上开 pipe-pane，把 pane 输出 append 到日志文件。
# 使用 `pipe-pane -o`：已有 pipe 时不动，幂等；session 退出时 cat 见 EOF 自然结束。
# 调用方在 `tmux new-session -d` 之后（或重新注入之前）调用。
start_session_logging() {
    local sess="$1"
    local log_path
    log_path="$(session_log_path "$sess")"
    [ -z "$log_path" ] && return 0
    mkdir -p "$(dirname "$log_path")"
    {
        printf '\n===== %s session=%s opened =====\n' \
            "$(date -Iseconds)" "$sess"
    } >> "$log_path"
    # pipe-pane 偶发失败几乎都是 `tmux new-session -d` 刚返回、pane 尚未就绪的 race，
    # 或 worker 进程已秒退 session 没了。先重试一次（0.3s 后），仍失败才报警——
    # 报警此时基本等价于"worker 启动即死"（详见 verify_fresh_session 的 capture）。
    if ! tmux pipe-pane -o -t "$sess" "cat >> '$log_path'" 2>/dev/null; then
        sleep 0.3
        tmux pipe-pane -o -t "$sess" "cat >> '$log_path'" 2>/dev/null || \
            log "  ⚠️ pipe-pane 失败：$sess → $log_path（session 可能已秒退）"
    fi
}

# 起完 fresh session 后探活并 capture 秒退死因。
# 前置条件：caller 必须在 `tmux new-session` 时就用 `\; set-option -w remain-on-exit on`
#   把 remain-on-exit 链式设上——否则亚毫秒级秒退会抢在本函数前把 pane 销毁、capture 到空。
# - 活着：关掉 remain-on-exit（恢复正常——claude 自然退出时 session 应当销毁），return 0
# - 死了：把 pane 内容（含报错）抓进 session log + daemon log，kill-session
#   （保持 "has-session==false == worker 死" 的语义，self-heal 才能正常翻 label），return 1
# 只在没有 has-session-based fallback 的路径（dispatch-new-issue）用；
# 注入/resume 路径靠各自 Case 逻辑，不在这里碰。
verify_fresh_session() {
    local sess="$1"
    local wait_s="${2:-2}"
    sleep "$wait_s"
    local dead
    dead="$(tmux list-panes -t "=$sess" -F '#{pane_dead}' 2>/dev/null | head -1)"
    if [ "$dead" = "1" ] || ! session_alive "$sess"; then
        log "  ❌ $sess 启动后 ${wait_s}s 内秒退，capture pane 死因："
        local log_path
        log_path="$(session_log_path "$sess")"
        {
            printf '\n===== %s session=%s 秒退，pane capture =====\n' \
                "$(date -Iseconds)" "$sess"
            tmux capture-pane -t "$sess" -p -S -200 2>/dev/null | sed '/^[[:space:]]*$/d'
        } | tee -a "${log_path:-/dev/null}" | tail -25 | sed 's/^/      /' | tee -a "$LOG_FILE" >&2
        tmux kill-session -t "$sess" 2>/dev/null || true
        return 1
    fi
    tmux set-option -w -t "$sess" remain-on-exit off 2>/dev/null || true
    return 0
}

# 跑一条 gh / 任意命令；非 0 时把它的 stderr 拼到 log 里（不退出脚本）。
# 历史上脚本到处 `gh ... 2>/dev/null || log "失败"`，把真正报错全吞了，
# 出问题（如 PAT scope 不够）时只能复现一遍才看到原因——非常痛。
# 用法：run_gh "label 翻转" gh_label_flip "$ISSUE" --add foo --remove bar
run_gh() {
    local desc="$1"; shift
    local out
    if ! out=$("$@" 2>&1); then
        log "  ⚠️ ${desc}失败: $out"
        return 1
    fi
    return 0
}

# 需要使用命令 stdout 的 GitHub 调用版本。失败时与 run_gh 一样保留完整 stderr，
# 成功时只把 stdout 交给 caller（通常用于 command substitution）。
run_gh_capture() {
    local desc="$1"; shift
    local out
    if ! out=$("$@" 2>&1); then
        log "  ⚠️ ${desc}失败: $out"
        return 1
    fi
    printf '%s\n' "$out"
}

# Label 翻转 helper：走 REST API 的 /issues/N/labels endpoint，绕过 `gh pr edit
# --add-label` 内部 GraphQL `updatePullRequest` mutation（它要 read:org scope
# 去查 login 字段——bot PAT 一般没这个 scope，调用直接 fail）。REST 路径只要
# repo scope 就能改 label，PR / issue 都通用（GitHub API 里 PR 是 issue 的子集）。
# 用法：gh_label_flip <pr_or_issue_number> [--add label1 [label2 ...]] [--remove label1 ...]
gh_label_flip() {
    local num="$1"; shift
    local mode=""
    local adds=() removes=()
    while [ $# -gt 0 ]; do
        case "$1" in
            --add) mode=add; shift;;
            --remove) mode=remove; shift;;
            *)
                if [ "$mode" = add ]; then adds+=("$1")
                elif [ "$mode" = remove ]; then removes+=("$1")
                fi
                shift
                ;;
        esac
    done

    # remove first（防短暂同时有新旧 label 的窗口）
    local L encoded
    for L in "${removes[@]}"; do
        # 跳过空串：调用方的 label 列表里可能含未配置的可选 label（如没启用 review
        # 关卡时的 $LABEL_PENDING_REVIEW），拿空串去 DELETE 只会白打一次 404。
        [ -n "$L" ] || continue
        encoded=$(printf '%s' "$L" | jq -sRr @uri)
        # 404 表示 label 已经不在了——视为成功（idempotent）
        gh api -X DELETE "repos/$REPO/issues/$num/labels/$encoded" >/dev/null 2>&1 || true
    done

    # add
    if [ ${#adds[@]} -gt 0 ]; then
        local args=()
        for L in "${adds[@]}"; do
            args+=(-f "labels[]=$L")
        done
        gh api -X POST "repos/$REPO/issues/$num/labels" "${args[@]}" >/dev/null 2>&1 || return 1
    fi
    return 0
}

# ── 派工前同步主 checkout（GigleTutor-Web#516）──
# 主 checkout 是 prompt 模板 / 项目脚本的读取源；它落后 origin 时 daemon 会拿旧模板
# 渲染派工 prompt（#516 根因：主 checkout 落后 74 commit，#506 的 stale-e2e 分流段
# 从未进过 prompt）。本函数只在「当前在 base 分支 + 工作区干净」时 ff-only 前进；
# 有 WIP / 在别的分支绝不碰工作区（find_prompt_template 会走 origin/<base> 直读兜底）。
# 任何失败都只 log 不报错——离线时派工不能被 fetch 卡死。
sync_project_checkout() {
    local base="${BASE_BRANCH:-main}"
    if ! git -C "$PROJECT_ROOT" fetch origin "$base" --quiet 2>/dev/null; then
        log "sync_project_checkout: fetch origin/$base 失败（离线?），跳过"
        return 0
    fi
    local cur
    cur=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    if [ "$cur" != "$base" ]; then
        log "sync_project_checkout: 主 checkout 在 '$cur' ≠ '$base'，不动工作区"
        return 0
    fi
    if [ -n "$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null)" ]; then
        log "sync_project_checkout: 主 checkout 有未提交改动，不动工作区"
        return 0
    fi
    if git -C "$PROJECT_ROOT" merge --ff-only "origin/$base" --quiet 2>/dev/null; then
        log "sync_project_checkout: 主 checkout → $(git -C "$PROJECT_ROOT" log -1 --format='%h %s' 2>/dev/null | head -c 80)"
    else
        log "sync_project_checkout: ff-only 失败（本地分叉?），跳过"
    fi
    return 0
}

# Prompt 模板查找顺序：
#   0. origin/<base> 上的最新版（git show 直读远端 ref，落临时文件）——主 checkout
#      stale / 有 WIP 时也永远拿到最新模板（GigleTutor-Web#516 的结构性修复）。
#      依赖最近一次 fetch 刷新 remote-tracking ref（dispatch 前 sync_project_checkout 会 fetch）。
#   1. <project>/.agents/skills/coding-agent-work-loop/prompts/<name>.template.md   ← 新规范（推荐）
#   2. <project>/.agents/skills/coding-agent-workflow/prompts/<name>.template.md    ← 旧目录名（兼容；老 worktree/分支）
#   3. <project>/.coding-agent/prompts/<name>.template.md                           ← 更老路径（兼容）
#   4. <skill-dir>/prompts/<name>.template.md                                       ← skill 默认
find_prompt_template() {
    local name="$1"   # e.g. "new-issue" / "pr-comment"
    local base="${BASE_BRANCH:-main}"
    local rel=".agents/skills/coding-agent-work-loop/prompts/${name}.template.md"
    local remote_copy="$STATE_DIR/prompt-remote-${name}.template.md"
    if git -C "$PROJECT_ROOT" show "origin/${base}:${rel}" > "$remote_copy" 2>/dev/null \
       && [ -s "$remote_copy" ]; then
        echo "$remote_copy"
        return
    fi
    rm -f "$remote_copy"
    local candidates=(
        "$PROJECT_ROOT/.agents/skills/coding-agent-work-loop/prompts/${name}.template.md"
        "$PROJECT_ROOT/.agents/skills/coding-agent-workflow/prompts/${name}.template.md"
        "$PROJECT_ROOT/.coding-agent/prompts/${name}.template.md"
        "$SKILL_DIR/prompts/${name}.template.md"
    )
    for c in "${candidates[@]}"; do
        if [ -f "$c" ]; then
            echo "$c"
            return
        fi
    done
    echo ""
}

# ── 加载 driver（按 WORKER_AGENT）──
# 放在文件末尾，确保 _lib.sh 自己的函数都已定义；driver 注入的函数
# (agent_is_busy / agent_has_history / agent_command_new/resume) 之后被 dispatch
# 脚本 + cleanup-issue.sh 在执行时取到。
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_LIB_DIR/drivers/_common.sh"
source_driver "$WORKER_AGENT" || exit 2

# ── Token usage 脚本路径（项目级 prompt 通过 ${AGENT_TOKEN_USAGE_SCRIPT} 占位调用）──
# 优先 drivers/token-usage/<agent>.sh；没有 fallback _default.sh（输出空、worker
# 落"未知"兜底）。新增 driver 时按需在 token-usage/ 加 <agent>.sh 即可。
AGENT_TOKEN_USAGE_SCRIPT="$_LIB_DIR/drivers/token-usage/${WORKER_AGENT}.sh"
[ -f "$AGENT_TOKEN_USAGE_SCRIPT" ] || AGENT_TOKEN_USAGE_SCRIPT="$_LIB_DIR/drivers/token-usage/_default.sh"
