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
# 并发满时的取工顺序 —— 第一排序键：优先级 label，列表里越靠前越优先，
# **没打优先级标签的条目等同最后一档**（所以平时什么都不用打，只在真着急时挂一个
# priority/p0 插队）。留空 = 关掉这一层，只按「阶段 → 等待时长」排。
# 排序细节见 agent-poll.sh 的 § 1&2。
PRIORITY_LABELS="${PRIORITY_LABELS:-priority/p0,priority/p1,priority/p2}"

IFS=',' read -r -a _prio_labels <<< "${PRIORITY_LABELS:-}"
# 没打优先级标签的排在最后一档；列表只配了 1 个标签时，没打的排在它之后
if [ "${#_prio_labels[@]}" -gt 1 ]; then
    _prio_rank_default=$(( ${#_prio_labels[@]} - 1 ))
else
    _prio_rank_default=${#_prio_labels[@]}
fi
# Project 那一路的档位表由 agent-poll 每轮装载（读不到就留空 = 全体回落到 label）。
declare -A PROJECT_PRIO=()
_proj_rank_default=""

# 第一排序键。两个来源的档位都是「越小越优先」的下标。
priority_rank() {
    local labels_csv=",$1," num="${2:-}" i l
    # Project 上真的设了值 → 直接用它（project / both 两种模式一致）
    if [ "${PRIORITY_SOURCE:-label}" != "label" ] && [ -n "$num" ] && [ -n "${PROJECT_PRIO[$num]:-}" ]; then
        echo "${PROJECT_PRIO[$num]}"; return
    fi
    # project 模式：Project 上没设 = 最后一档，**不看 label**（口径单一，免得两套标准打架）
    if [ "${PRIORITY_SOURCE:-label}" = "project" ]; then
        echo "$_proj_rank_default"; return
    fi
    for (( i = 0; i < ${#_prio_labels[@]}; i++ )); do
        l="${_prio_labels[$i]}"
        [ -n "$l" ] || continue
        case "$labels_csv" in
            *",$l,"*) echo "$i"; return ;;
        esac
    done
    echo "$_prio_rank_default"
}


# ── 派工模式 ──
# label（默认）：只有挂着触发 label（pending/agent[/fable]、pending/review）的条目才派工。
#   什么都不标 = 什么都不做，是最安全的默认值。
# greedy：不看触发 label，**开着的 issue / PR 只要没被下面「挡工 label」挡住就一律入队**，
#   照样按「优先级 → 阶段 → 等待时长」排。适合「仓库里的活就是要全干完」的自动化仓；
#   代价是任何人新开一个 issue（公开仓里包括匿名外部用户）都会立刻触发一个 worker 烧 token。
#   两种模式不是二选一：greedy 下 label 那几趟照样先跑，所以 fable / review 这些
#   **带模型和 agent 选择的 label 仍然生效**，greedy 只是最后兜底把剩下的收进来。
DISPATCH_MODE="${DISPATCH_MODE:-label}"
case "$DISPATCH_MODE" in
    label|greedy) ;;
    # 不静默回落到 label：拼错一个字母就等于悄悄关掉 greedy，人会以为配了却没生效。
    *) echo "❌ DISPATCH_MODE 只能是 label 或 greedy，实得：$DISPATCH_MODE" >&2; exit 1 ;;
esac

# greedy 模式的挡工 label。挂了其中任何一个就不派工——每一条都有非它不可的理由：
#   pending/human  用户明确要人接手（这是用户唯一需要记住的那个「停」）
#   doing/agent    已经有 worker 在跑，再派一次就是同一条活开两个 session
#   Done           已结案
#   pending/PR     issue 的活已经转到 PR 上跟踪，再从 issue 派一次会重复开工
#   pending/review 有自己的 agent / 模型 / 模板，由上面 review 那趟收，不该被兜底趟抢走
# GREEDY_SKIP_LABELS 是项目自定义的**追加**项（逗号分隔），比如 "blocked,discussion"。
greedy_skip_label_list() {
    printf '%s\n' \
        "$LABEL_PENDING_HUMAN" \
        "$LABEL_AGENT_DOING" \
        "$LABEL_DONE" \
        "$LABEL_PENDING_PR" \
        "${LABEL_PENDING_REVIEW:-}"
    if [ -n "${GREEDY_SKIP_LABELS:-}" ]; then
        printf '%s\n' "${GREEDY_SKIP_LABELS}" | tr ',' '\n'
    fi
    return 0
}

# 纯函数：labels_csv（逗号分隔的 label 名）挡不挡工。
# 挡 → stdout 写挡住它的那个 label 名 + return 0；不挡 → return 1。
# 用 case 逐个精确匹配而不是 grep：label 名里可能有空格（"good first issue"）和
# 正则元字符（"C++"），一 grep 就误伤。
greedy_skip_reason() {
    local labels_csv=",${1}," l
    while IFS= read -r l; do
        [ -n "$l" ] || continue
        case "$labels_csv" in
            *",$l,"*) printf '%s' "$l"; return 0 ;;
        esac
    done < <(greedy_skip_label_list)
    return 1
}

# greedy 每轮扫多少条（gh 默认只给 30）。仓库积压多时调大。
GREEDY_SCAN_LIMIT="${GREEDY_SCAN_LIMIT:-100}"

# ── 优先级来源：label / GitHub Project 字段 ──
# label （默认）：只看 PRIORITY_LABELS 里的标签。
# project      ：只看 GitHub Project (v2) 上那个单选字段（默认叫 Priority）的取值，
#                档位顺序**直接用该字段在 Project 里定义的选项顺序**——不用在这儿
#                再抄一遍，Project 里拖一下顺序就改了。没设值的条目落最后一档。
# both         ：Project 上设了就用 Project 的，没设的回落到 label。
#                ⚠️ 两套档位是各自独立的下标，混用时请让它们对齐（P0 ↔ priority/p0），
#                否则「Project 的第 2 档」和「label 的第 2 档」会被当成同一档。
PRIORITY_SOURCE="${PRIORITY_SOURCE:-label}"
case "$PRIORITY_SOURCE" in
    label|project|both) ;;
    *) echo "❌ PRIORITY_SOURCE 只能是 label / project / both，实得：$PRIORITY_SOURCE" >&2; exit 1 ;;
esac

# Project 上那个单选字段叫什么（GitHub 自带模板就叫 Priority）
PROJECT_PRIORITY_FIELD="${PROJECT_PRIORITY_FIELD:-Priority}"
# 用哪个 Project。留空 = 自动取本仓库关联的第一个 Project。
PROJECT_NUMBER="${PROJECT_NUMBER:-}"
# 读 Project 用的 token。留空 = 用 daemon 自己的 GH_TOKEN。
# 为什么要单独留这个口子：Projects v2 只有 GraphQL，classic PAT 必须勾 read:project；
# 而且**个人名下**的 Project（不是组织的）还要求该账号被加进 Project 的协作者。
# bot 账号两样都不满足时，与其去改 bot 的权限，不如在这里塞一个只读 Project 的 token。
PROJECT_GH_TOKEN="${PROJECT_GH_TOKEN:-}"

project_gh_graphql() {
    if [ -n "${PROJECT_GH_TOKEN:-}" ]; then
        GH_TOKEN="$PROJECT_GH_TOKEN" gh api graphql "$@"
    else
        gh api graphql "$@"
    fi
}

# stdout 写 "<issue/PR 编号>\t<档位下标>"，一行一条；失败返回非 0（调用方回落到 label）。
# 只输出**本仓库**的条目：一个 Project 常常挂着好几个仓库的卡片，编号会撞车。
project_priority_pairs() {
    local owner="${PROJECT_OWNER:-${REPO%%/*}}" name="${REPO##*/}"
    local field="${PROJECT_PRIORITY_FIELD:-Priority}"
    local resp pid after page

    resp=$(project_gh_graphql -f owner="$owner" -f name="$name" -f query='
        query($owner:String!,$name:String!){
          repository(owner:$owner,name:$name){
            projectsV2(first:20){ nodes{ id number title } }
          }
        }' 2>&1) || { printf '%s' "$resp" >&2; return 1; }

    if [ -n "${PROJECT_NUMBER:-}" ]; then
        pid=$(printf '%s' "$resp" | jq -r --argjson n "$PROJECT_NUMBER" \
            '.data.repository.projectsV2.nodes[]? | select(.!=null) | select(.number==$n) | .id' 2>/dev/null | head -1)
    else
        pid=$(printf '%s' "$resp" | jq -r \
            '[.data.repository.projectsV2.nodes[]? | select(.!=null)][0].id // empty' 2>/dev/null)
    fi
    if [ -z "$pid" ]; then
        echo "找不到可读的 Project（owner=$owner repo=$name number=${PROJECT_NUMBER:-auto}）" >&2
        return 1
    fi

    # 分页拉 items。档位 = 该选项在 Project 字段里定义的下标。
    after=""
    while :; do
        if [ -n "$after" ]; then
            page=$(project_gh_graphql -f pid="$pid" -f field="$field" -f after="$after" -f query='
                query($pid:ID!,$field:String!,$after:String){ node(id:$pid){ ... on ProjectV2 {
                  field(name:$field){ ... on ProjectV2SingleSelectField { options { name } } }
                  items(first:100, after:$after){ pageInfo{ hasNextPage endCursor }
                    nodes{ content{ ... on Issue { number repository{ nameWithOwner } }
                                    ... on PullRequest { number repository{ nameWithOwner } } }
                           fieldValueByName(name:$field){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }' 2>&1) \
                || { printf '%s' "$page" >&2; return 1; }
        else
            page=$(project_gh_graphql -f pid="$pid" -f field="$field" -f query='
                query($pid:ID!,$field:String!){ node(id:$pid){ ... on ProjectV2 {
                  field(name:$field){ ... on ProjectV2SingleSelectField { options { name } } }
                  items(first:100){ pageInfo{ hasNextPage endCursor }
                    nodes{ content{ ... on Issue { number repository{ nameWithOwner } }
                                    ... on PullRequest { number repository{ nameWithOwner } } }
                           fieldValueByName(name:$field){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }' 2>&1) \
                || { printf '%s' "$page" >&2; return 1; }
        fi

        # 先吐一行 "#options<TAB>N"：调用方拿它当「没设优先级」的档位（= 最后一档），
        # 跟 label 那套「没打标签的等同最后一档」保持同一个语义。
        printf '%s' "$page" | jq -r --arg repo "$REPO" '
            .data.node as $p
            | ([$p.field.options[]?.name] | to_entries | map({key:.value, value:.key}) | from_entries) as $rank
            | ("#options\t" + (($rank | length) | tostring)),
              ( $p.items.nodes[]?
            | select(.content.repository.nameWithOwner == $repo)
            | select(.fieldValueByName.name != null)
            | select($rank[.fieldValueByName.name] != null)
            | "\(.content.number)\t\($rank[.fieldValueByName.name])" )' 2>/dev/null || true

        [ "$(printf '%s' "$page" | jq -r '.data.node.items.pageInfo.hasNextPage // false' 2>/dev/null)" = "true" ] || break
        after=$(printf '%s' "$page" | jq -r '.data.node.items.pageInfo.endCursor // empty' 2>/dev/null)
        [ -n "$after" ] || break
    done
    return 0
}
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

# ── 完工 worker 回收（issue #745 现场诊断）──
# `list_active_workers` 那套是「label 在不在」的**工作流视角**；本函数补的是反方向的
# **本机视角**：session 还在、但 label 已经不是 doing/agent 了 —— 也就是活干完了、
# 进程没人收。两者合起来才是完整的 self-heal：
#
#   label 在 + session 没了  → self_heal_one（重新派工）
#   label 没了 + session 还在 → 本函数（回收）        ← 以前没人管
#
# 不回收的后果不是「多占一个 slot」——并发闸门数的是 label，看不见这些进程，所以它
# **照样派新工**，泄漏进程单调累积。2026-08-22 现场实测：MAX_CONCURRENT_WORKERS=3，
# 实际常驻 13 个 worker session / 11 个 claude 主进程（各 250–540 MB），15 GiB 内存
# 见底、swap 吃满，vmstat 的 b（卡在 uninterruptible IO）20–31 而 r 只有 12–18 ——
# load 28 里几乎没有一份是算出来的，全是等 IO 等出来的。回收 10 个完工 session 后
# load 15.25 → 8.77、已用内存 7356 → 5032 MB、b 归零。
#
# 同一个病根 2026-08-21 21:16 还以另一种形式发作过：systemd-oomd 在 user@1003.service
# 上跳闸，连 systemd --user 一起打死，5 个 timer 全消失、daemon 静默停摆 12 小时。
# 那次的对策是 systemd/app-coding\x2dagent\x2dpoll.slice 的 MemoryHigh/MemoryMax
# （**炸的时候别炸到 manager**），本函数是另一半（**先别堆到要炸**）。两者互补，都要。
#
# ⚠️ 只回收 worker session：`list_worker_sessions` 的正则是 `^prefix-issueN$`，
# 结尾锚点让 `-server` / `-api` 这些 dev server session 天然落在外面。**这是有意的**
# ——dev server 是人在用的预览服，不归 daemon 生命周期管，别顺手一起收了。
reap_finished_workers() {
    if [ "${REAP_FINISHED_WORKERS:-1}" != "1" ]; then
        return 0
    fi
    # active_keys 由调用方（agent-poll.sh）算好后用 nameref 传进来，复用同一份 label
    # 真值：既保证跟并发闸门口径完全一致，也不额外多打两次 gh API。
    local -n _active="$1"
    local grace="${REAP_GRACE_SECS:-300}"
    local now sess n last_act idle reaped=0
    now=$(date +%s)

    # session→最后活动时间，一次读完。
    # ⚠️ 必须走 `list-sessions -F`（或 `display-message -t '=name:'`——**末尾那个冒号
    # 不能省**）。写成 `display-message -p -t "=name"` 在 tmux 3.4 下 `#{session_activity}`
    # 返回**空字符串**而不是报错，空值算进减法就成了「闲置 17 亿秒」，宽限期直接失效、
    # 每个刚翻完 label 的 worker 都会被当场打断收尾。守卫自己 fail-open 是最难查的那种。
    local -A _last_act=()
    local _s _a
    while read -r _s _a; do
        # 用 if 而不是 `[ -n "$_s" ] && _last_act[...]=`：循环体最后一条命令返回 1 会让
        # 整个 while 返回非 0，set -e 下把调用方一起带走（同 list_active_workers 末尾那条）。
        if [ -n "$_s" ]; then
            _last_act[$_s]="$_a"
        fi
    done < <(tmux list-sessions -F '#{session_name} #{session_activity}' 2>/dev/null || true)

    for sess in $(list_worker_sessions); do
        n="${sess#"${TMUX_PREFIX}-${SESSION_NAME_PREFIX}"}"
        # 还在 doing/agent → 正在干活，不碰
        if [ -n "${_active[$n]:-}" ]; then
            continue
        fi
        # 宽限期：worker 是**先翻 label 再收尾**的（推 commit、发 review 评论、贴总结）。
        # label 一翻就杀会把收尾截断，所以要求 pane 已经安静够久。session_activity 在
        # pane 有输出时才更新，claude 空闲挂着不输出，正好是我们要的「真闲了多久」。
        last_act="${_last_act[$sess]:-}"
        # 拿不到活动时间就**不回收**（fail closed）：查不出来不等于「闲着」，
        # 宁可多留一轮，也不要在 worker 收尾时把它打断。
        if ! [[ "$last_act" =~ ^[0-9]+$ ]]; then
            log "⏳ 回收暂缓: $sess（issue #$n 已完工，但读不到 session_activity —— 保守跳过）"
            continue
        fi
        idle=$(( now - last_act ))
        if [ "$idle" -lt "$grace" ]; then
            log "⏳ 回收暂缓: $sess（issue #$n 已完工，但 pane ${idle}s 前还有输出 < ${grace}s 宽限，可能在收尾）"
            continue
        fi
        log "🧹 回收完工 worker: $sess（issue #$n 无 $LABEL_AGENT_DOING，闲置 ${idle}s）"
        kill_session_procs "$sess"
        tmux kill-session -t "=$sess" 2>/dev/null || true
        reaped=$((reaped + 1))
    done

    if [ "$reaped" -gt 0 ]; then
        log "🧹 本轮回收 $reaped 个完工 worker session"
    fi
    return 0
}

# 杀掉一个 session 下的进程，**再** kill-session。
#
# ⚠️ 顺序不能反、也不能只 kill-session：实测 `tmux kill-session` 只给 pane 发 SIGHUP，
# claude 不吃这一套 —— session 没了，claude 进程被 reparent 到 tmux server 底下继续
# 活着（PPID = tmux server pid），照样占着 250–540 MB。2026-08-22 现场就是这样：
# kill 掉 10 个 session 后内存只掉了 170 MB，进程一个没少。codex 倒是响应 SIGHUP
# 正常退出，所以光看 codex 会误判成「kill-session 够用了」。
#
# 杀的是**进程组**（claude/codex 的 PGID = 自己的 PID），这样它 fork 出来的 node /
# esbuild / vite 子进程能一起带走，不会留下新的孤儿。
kill_session_procs() {
    local sess="$1"
    local grace="${REAP_KILL_GRACE_SECS:-10}"
    local pids p waited alive
    pids=$(tmux list-panes -t "=$sess" -F '#{pane_pid}' 2>/dev/null || true)
    if [ -z "$pids" ]; then
        return 0
    fi
    for p in $pids; do
        kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true
    done
    # 给优雅退出的时间：claude 收到 SIGTERM 后要落盘会话记录，实测几秒到几十秒不等。
    waited=0
    while [ "$waited" -lt "$grace" ]; do
        alive=0
        for p in $pids; do
            if kill -0 "$p" 2>/dev/null; then alive=1; fi
        done
        if [ "$alive" -eq 0 ]; then
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    # 赖着不走 → SIGKILL。会话记录可能不完整，但留一个 500 MB 的僵尸更糟。
    for p in $pids; do
        kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true
    done
    return 0
}

# 构造 tmux new-session 的 -e 参数，把 WORKER_PASS_ENV 列的 env 透传给 worker。
# tmux 默认不继承父 shell 的 env，必须显式 -e VAR=VALUE。
# 默认透传 GH_TOKEN（让 worker 里的 gh CLI 用正确的 PAT，而不是 fallback 到 gh auth 默认账号）。
# 列在 WORKER_PASS_ENV 但 env 里没设的变量，会 log warn（典型：手动跑 daemon 但
# 没 export GH_TOKEN —— 否则 worker 静默走 gh 默认 token，导致多账号下 403）。
# ── 敏感 env 的传递：值不进命令行（issue #745 现场发现）──
# `-e VAR=值` 会把值写进 `tmux new-session` 的 argv，而 `/proc/<pid>/cmdline` 是
# **全局可读**的（0444，且本机 /proc 没挂 hidepid）——同机任何用户一个 `ps aux`
# 就能抄走 PAT。tmux server 还是长驻进程，它的 argv 一直挂到 server 退出为止：
# 2026-08-22 现场实测，一个 40 字符 classic PAT 在 tmux server 命令行里挂了 11 小时，
# 而那台机器上确实有第二个真实用户。
#
# 反直觉的地方是 `/proc/<pid>/environ` 恰恰是安全的（0400，仅属主），但 tmux 不从
# environ 取值——它只认 `-e`，所以「塞进环境变量」并不能解决问题。
#
# 解法是传**路径**而不是值：`-e GH_TOKEN_FILE=/path`，再让 worker 命令前缀里的
# `export GH_TOKEN=$(cat "$GH_TOKEN_FILE")` 在 **worker 自己的 shell** 里展开。
# 命令替换不产生新的 argv，值全程不出现在任何进程的命令行里；路径本身不敏感。
WORKER_SECRET_ENV="${WORKER_SECRET_ENV:-GH_TOKEN}"

# 既要透传、又属于敏感的那些变量（= WORKER_PASS_ENV ∩ WORKER_SECRET_ENV）。
# 取交集而不是直接用 WORKER_SECRET_ENV：某个项目如果压根不透传 GH_TOKEN，
# 就不该为它生成文件、也不该因为它没设而拒绝派工。
_secret_vars() {
    local pass="${WORKER_PASS_ENV:-GH_TOKEN}" v s
    for v in $pass; do
        for s in $WORKER_SECRET_ENV; do
            if [ "$v" = "$s" ]; then
                echo "$v"
            fi
        done
    done
}

# 把敏感 env 落到 0600 文件，echo 出路径。内容没变就不重写——poll 每分钟跑一次，
# 无谓的写盘既是 IO 也是把值反复暴露给 inotify 的机会。
# 值只在 bash 内部流转（cat 的 argv 里只有文件名），不会进任何 argv。
secret_env_file() {
    local var="$1" dir f val
    dir="$STATE_DIR/secrets"
    f="$dir/$var"
    eval "val=\${$var:-}"
    if [ -z "$val" ]; then
        return 1
    fi
    mkdir -p "$dir"
    chmod 700 "$dir" 2>/dev/null || true
    if [ ! -f "$f" ] || [ "$(cat "$f" 2>/dev/null)" != "$val" ]; then
        ( umask 077; printf '%s' "$val" > "$f" )
    fi
    chmod 600 "$f" 2>/dev/null || true
    printf '%s' "$f"
    return 0
}

# 派工前置校验：敏感变量缺失就**当场拒绝派工**，别让 worker 起来之后才撞 403。
# 403 的表现是 worker 秒退或原地打转，self-heal 会把它当「会话损坏」反复重派，
# 烧 API 还查不出根因——fail fast 在这里比 fail soft 便宜得多。
require_secret_env() {
    local var missing=0
    while read -r var; do
        if [ -z "$var" ]; then
            continue
        fi
        if ! secret_env_file "$var" >/dev/null; then
            echo "[coding-agent] ERROR: $var 在 WORKER_SECRET_ENV 里但当前 env 没设 —— 拒绝派工。" >&2
            echo "[coding-agent]        systemd 路径检查 EnvironmentFile；手动跑请先 export $var=..." >&2
            missing=1
        fi
    done < <(_secret_vars)
    if [ "$missing" -ne 0 ]; then
        return 1
    fi
    return 0
}

# worker 命令前缀：在 worker 自己的 shell 里把值读回来。
# 这段字符串会原样进 `tmux new-session` 的最后一个参数（由 sh -c 执行），所以
# `$(cat ...)` 和 `$VAR_FILE` 必须保持字面、留到那时候才展开——**这里绝不能提前求值**，
# 提前求值就等于把值写回 argv，整个改动就白做了。
secret_env_prefix() {
    local var out=""
    while read -r var; do
        if [ -z "$var" ]; then
            continue
        fi
        out="${out}export ${var}=\$(cat \"\$${var}_FILE\"); "
    done < <(_secret_vars)
    printf '%s' "$out"
}

tmux_env_args() {
    # PATH 硬透传：worker 跑 claude / git / node 等 binary 全靠 PATH 找。tmux new-session
    # 启的 child shell **继承的是 tmux server 启动时的 PATH**，**不继承** dispatch script
    # 自己的 PATH——如果 tmux server 启动时 user 自装 binary 目录（~/.hermes/node/bin、
    # ~/.local/bin/foo 等）不在 PATH 里，worker exec claude 立即 `command not found`、
    # session exit 127 死掉。dispatch script 自己跑时 PATH 是 systemd EnvironmentFile
    # 给的、含 claude；显式 -e PATH=$PATH 把这份 PATH 传给 worker session 才稳。
    # conf 不用列 PATH（即便列也 dedupe 不重复透传）。
    local vars="PATH ${WORKER_PASS_ENV:-GH_TOKEN}"
    local seen="" secrets
    # 前后各留一个空格，下面用 `*" $var "*` 做整词匹配（否则 GH_TOKEN 会被
    # GH_TOKEN_EXTRA 之类的名字前缀命中）
    secrets=" $(_secret_vars | tr '\n' ' ') "
    for var in $vars; do
        case " $seen " in *" $var "*) continue ;; esac
        seen="$seen $var"
        local val
        eval "val=\${$var:-}"
        # 敏感变量：只把**路径**写进 argv，值留在 0600 文件里，由 secret_env_prefix
        # 生成的前缀在 worker shell 里读回来。见本文件上方 WORKER_SECRET_ENV 那段。
        case "$secrets" in
            *" $var "*)
                local _sf
                if _sf=$(secret_env_file "$var"); then
                    printf -- '-e\0%s_FILE=%s\0' "$var" "$_sf"
                else
                    echo "[coding-agent] WARN: WORKER_SECRET_ENV 含 '$var' 但当前 env 没设；worker 不会拿到它。" >&2
                fi
                continue
                ;;
        esac
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
