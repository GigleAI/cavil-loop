#!/usr/bin/env bash
# 公共库：所有脚本通过 source _lib.sh 引入配置 + 工具函数。
# 调用方在脚本顶部：
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/_lib.sh"
#
# 配置查找顺序：
#   1. $CODING_AGENT_CONFIG 环境变量（systemd 用 EnvironmentFile 注入）
#   2. 当前 cwd 向上找 cavil-loop.config（改名前装的项目叫 coding-agent.config，同样认；
#      同一层两个都在时新名优先，见 _names.sh）
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
# process 让 tmux server 得以存活之后（见 systemd/cavil-loop-poll@.service），
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

# 新旧两套名字的对照表：下面找配置、找项目覆盖目录、找预览单元都从这里取。
# shellcheck source=_names.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_names.sh"

find_config() {
    if [ -n "${CODING_AGENT_CONFIG:-}" ] && [ -f "$CODING_AGENT_CONFIG" ]; then
        echo "$CODING_AGENT_CONFIG"
        return
    fi
    local d="$PWD" c
    while [ "$d" != "/" ]; do
        c="$(cavil_project_config "$d")"
        if [ -f "$c" ]; then
            echo "$c"
            return
        fi
        d="$(dirname "$d")"
    done
    echo ""
}

CONFIG_FILE="$(find_config)"
if [ -z "$CONFIG_FILE" ]; then
    echo "[cavil-loop] ERROR: 找不到 cavil-loop.config（改名前的项目叫 coding-agent.config）" >&2
    echo "  1) 在 host project 根放一份（参考 \$CLAUDE_PLUGIN_ROOT/cavil-loop.config.example）" >&2
    echo "  2) 或 export CODING_AGENT_CONFIG=/path/to/config" >&2
    exit 2
fi
# webhook 的地址 / 密钥只认项目配置文件（GitHub#100）：worker 跑叫醒脚本时只 source 这个文件，
# 拿不到 daemon 的环境变量；先清掉，两边才读同一处。
unset REQUESTER_BOT_WEBHOOK_URL REQUESTER_BOT_WEBHOOK_KEY_HEADER REQUESTER_BOT_WEBHOOK_KEY
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
FABLE_MODEL="${FABLE_MODEL:-fable}"
FABLE_WORKER_AGENT="${FABLE_WORKER_AGENT:-claude}"

# ── 追加触发 label（逗号分隔，默认空）──
# 语义跟 LABEL_PENDING_AGENT 一模一样：同一套 prompt、同一个 worker、同一个模型，
# 只是多认几个名字。**不是**用来做模型选择的（那是 fable 那条路）。
#
# 存在的理由：多机分工。两台机器盯同一个仓库时，各自把自己的主机标签配进来，
# 谁的标签谁接，互不抢活：
#   05 上：LABEL_PENDING_AGENT="pending/agent"    LABEL_PENDING_AGENT_EXTRA="pending/agent/05"
#   01 上：LABEL_PENDING_AGENT="pending/agent/01" LABEL_PENDING_AGENT_EXTRA=""
# 注意另一半必须同时配：greedy 模式下兜底趟不看触发 label，会把别人家的
# pending/agent/01 也收进来 —— 所以对方的标签要进 GREEDY_SKIP_LABELS。
LABEL_PENDING_AGENT_EXTRA="${LABEL_PENDING_AGENT_EXTRA:-}"

# ── 多机分工：self-heal 的归属判定 ──
# 本机在多机分工里的标识，记进 state.json 的 worker_hosts，self-heal 靠它认领。
# 默认取短主机名；两台机器重名时在项目配置里显式写死。
SELFHEAL_HOST_ID="${SELFHEAL_HOST_ID:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)}"

# 只自愈**本机派出去**的 worker。两台机器盯同一个仓库时**必须开**。
#
# 为什么不开就一定出事：self-heal 的判据是「GitHub 上挂着 doing/agent，但本机没有
# 同名 tmux session」。两台机器的 session 命名规则一模一样（都是 <prefix>-issue<N>），
# 所以 A 机看 B 机正在跑的活，看到的就是「doing/agent + 本地无 session」= 僵尸，
# 于是翻成自己的 pending label 抢过来。2026-09-04 实测：futurelab-01 第一次起 poll，
# 25 秒内把 FutureLab05 上四个正在跑的 worker 全判成僵尸并接管（PR #839/#838/#728、
# issue #842），其中一个已经开始重建 worktree 跑 npm ci。
#
# 代价：state.json 丢失后，存量 doing/agent 条目本机不再认领（worker_hosts 里没有
# 记录 = 不是我的）。恢复办法是人工把它们重标一次触发 label。单机场景不用开，
# 保持 false 就是原来的行为。
SELFHEAL_ONLY_OWN_WORKERS="${SELFHEAL_ONLY_OWN_WORKERS:-false}"

# 所有「会触发派工」的 label。派工时必须把它们**一并**摘掉：只摘触发的那一个，
# 剩下的下一轮又会把同一条活重新捡起来，worker 无限重开。
# 以前这里是三个变量硬写在五处 --remove 后面，加一个触发 label 就得记得改五个地方；
# 收进一个函数是为了新增 label 时不会漏。
trigger_labels_all() {
    printf '%s\n' \
        "$LABEL_PENDING_AGENT_DEFAULT" \
        "$LABEL_PENDING_AGENT_FABLE" \
        "${LABEL_PENDING_REVIEW:-}" \
        "${LABEL_PENDING_AGENT:-}"
    if [ -n "${LABEL_PENDING_AGENT_EXTRA:-}" ]; then
        printf '%s\n' "${LABEL_PENDING_AGENT_EXTRA}" | tr ',' '\n'
    fi
    return 0
}

# 上面那个列表去空 + 去重后的数组形式，直接展开给 `gh_label_flip --remove`。
# 空串必须滤掉：gh_label_flip 拿到空 label 会去 DELETE 一个空路径。
trigger_labels_array() {
    mapfile -t TRIGGER_LABELS_ALL < <(trigger_labels_all | awk 'NF && !seen[$0]++')
}

# ── 外部需求机器人（GitHub#95 / #97 / #100，可选，默认关闭）──
# 有的项目让另一个 AI 助手（有自己的 GitHub 账号，下称「外部需求机器人」）直接给项目开
# issue 提需求，cavil-loop 照常处理。闭环靠两处把结果告诉它：
#   · agent 要提需求方回答问题、或汇报结果时，不翻 pending/human，而是挂等待标签 + 叫醒
#     机器人（scripts/notify-requester-bot.sh：issue、PR 一样，确认挂上后调一次 webhook）
#   · PR 合并 / 关闭未合并时，daemon 在机器人提的 issue 上留一条结果评论、加等待标签、调 webhook
#     （requester_bot_done_*，见下）
# 全部留空 = 功能关闭，行为和以前一样。
#
# 等待标签在 daemon 这边只有三处作用，都在等待标签非空时才生效：
#   1. greedy 兜底趟挡工（greedy_skip_label_list）——只挂等待标签的条目不派
#   2. self-heal 不把挂着它的 doing/agent 条目翻回触发标签
#   3. 有人在等待期间**又打了触发标签** → 按该标签原流程派工，派工时一并摘掉等待标签
#      （REQUESTER_BOT_DISPATCH_CLEAR）。触发标签只有能改标签的人才打得上，是明确的
#      「接着干」；不摘的话，这轮 worker 交完活还挂着一个过期的等待标签
#
# 判定「功能已开启」（提示词追加交接规则、叫醒脚本肯干活、合并后通知）要四项都填：标签、
# 机器人账号、允许叫醒的账号、需求标记。只填了一部分时 daemon 侧的挡工照常生效（只会更保守），
# 其余都不做，叫醒脚本拒绝并说明缺哪项。
#
# 配置项名字（GitHub#97 Q1=B）：新名字是下面的 REQUESTER_BOT_* / LABEL_PENDING_REQUESTER_BOT；
# 早期的 RELAY_* / LABEL_PENDING_RELAY 继续认。每一项单独挑：新名字有值就用新的，否则用旧的
# （_names.sh 的 cavil_pick_setting，setup.sh 建等待标签时用的是同一个函数）。
# 两个都有值且不同 → 用新的，并记进 REQUESTER_BOT_NAME_CONFLICTS（叫醒脚本和轮询日志会提示）。
REQUESTER_BOT_NAME_CONFLICTS=""
_requester_bot_pick() {   # <新名字> <旧名字>
    local new="$1" old="$2"
    if [ -n "${!new:-}" ] && [ -n "${!old:-}" ] && [ "${!old}" != "${!new}" ]; then
        REQUESTER_BOT_NAME_CONFLICTS+="${REQUESTER_BOT_NAME_CONFLICTS:+, }$new（用它）/ $old（忽略）"
    fi
    printf -v "$new" '%s' "$(cavil_pick_setting "${!new:-}" "${!old:-}")"
}
_requester_bot_pick LABEL_PENDING_REQUESTER_BOT  LABEL_PENDING_RELAY
_requester_bot_pick REQUESTER_BOT_ACCOUNT        RELAY_BOT_ACCOUNT
_requester_bot_pick REQUESTER_BOT_ALLOWED_ACTORS RELAY_ALLOWED_ACTORS
_requester_bot_pick REQUESTER_BOT_ORIGIN_MARKER  RELAY_ORIGIN_MARKER
_requester_bot_pick REQUESTER_BOT_REPORT_FIRST   RELAY_REPORT_FIRST
REQUESTER_BOT_REPORT_FIRST="${REQUESTER_BOT_REPORT_FIRST:-false}"

requester_bot_enabled() {
    [ -n "$LABEL_PENDING_REQUESTER_BOT" ] && [ -n "$REQUESTER_BOT_ACCOUNT" ] \
        && [ -n "$REQUESTER_BOT_ALLOWED_ACTORS" ] && [ -n "$REQUESTER_BOT_ORIGIN_MARKER" ]
}

# 缺了哪几项（给叫醒脚本和日志说清楚），全齐时输出空
requester_bot_missing_settings() {
    local v out=""
    for v in LABEL_PENDING_REQUESTER_BOT REQUESTER_BOT_ACCOUNT REQUESTER_BOT_ALLOWED_ACTORS REQUESTER_BOT_ORIGIN_MARKER; do
        [ -n "${!v:-}" ] || out+=" $v"
    done
    printf '%s' "${out# }"
}

requester_bot_report_first() {
    case "$(printf '%s' "${REQUESTER_BOT_REPORT_FIRST:-}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on|是) return 0 ;;
        *) return 1 ;;
    esac
}

# 派工翻 doing/agent 时要一并摘掉的额外标签。没配等待标签时为空数组：
# 展开 "${REQUESTER_BOT_DISPATCH_CLEAR[@]}" 什么都不加，派工的 API 调用和以前逐个相同。
REQUESTER_BOT_DISPATCH_CLEAR=()
[ -z "$LABEL_PENDING_REQUESTER_BOT" ] || REQUESTER_BOT_DISPATCH_CLEAR=("$LABEL_PENDING_REQUESTER_BOT")

# 派工成功后翻 doing/agent：摘掉全部触发标签（+ 等待标签，见上）。三个 dispatch 脚本
# 共用这一份，等待标签只在这里加一次，不会有哪条派工路径漏摘。
# 用法：flip_to_doing <编号> <日志里的描述>
flip_to_doing() {
    [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
    run_gh "label 翻转 ($2)" \
        gh_label_flip "$1" \
        --add "$LABEL_AGENT_DOING" \
        --remove "${TRIGGER_LABELS_ALL[@]}" ${REQUESTER_BOT_DISPATCH_CLEAR[@]+"${REQUESTER_BOT_DISPATCH_CLEAR[@]}"}
}

# labels_csv 里挂没挂等待标签（整名匹配，label 名可能含空格 / 正则元字符）
labels_have_requester_bot_wait() {
    [ -n "$LABEL_PENDING_REQUESTER_BOT" ] || return 1
    case ",${1}," in *",$LABEL_PENDING_REQUESTER_BOT,"*) return 0 ;; esac
    return 1
}

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
# 设计方案要不要也先过复审（GitHub#102）。默认关：写完方案直接交人，和从前逐字一样。
# 只决定「写完方案 / 修订方案翻哪个标签」这一个出口；澄清答复、提问、受阻仍直接交人。
# 开着但没配 LABEL_PENDING_REVIEW 时照样交人——不能翻进一个不存在的标签。
#
# 项目自己在 <name>.extra.md 里写「方案翻 ${LABEL_REVIEW_OR_HUMAN}」的老做法不受影响：
# LABEL_REVIEW_OR_HUMAN 的取值和这个开关无关，追加段又排在通用模板后面、冲突时以它为准。
REVIEW_DESIGN_PROPOSALS="${REVIEW_DESIGN_PROPOSALS:-false}"
LABEL_DESIGN_REVIEW_OR_HUMAN="$LABEL_PENDING_HUMAN"
DESIGN_REVIEW_NOTE=""
case "$(printf '%s' "$REVIEW_DESIGN_PROPOSALS" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on)
        if [ -n "$LABEL_PENDING_REVIEW" ]; then
            LABEL_DESIGN_REVIEW_OR_HUMAN="$LABEL_PENDING_REVIEW"
            # 渲染进模板时走 sed 替换：这段文字里不能出现 | & \ 和换行
            DESIGN_REVIEW_NOTE="（本项目开了方案复审：独立复审者先审这份方案，通过后才交到人手上；不通过会带意见打回，那时是改方案，不是去实现）"
        fi ;;
esac
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
# 「哪儿都没标」的档位。规则只有一条：**它必须排在所有标过的后面**。
#
# 为什么不能沿用「等同最后一档」：两套档位（label 3 档 / 原生字段 4 档）下标各自独立，
# 混用时「没标」= label 的 2，而原生的 Low = 3 —— 什么都没标的条目就排到了明确标了
# Low 的前面。所以取两边档位数的**最大值**当下标：它比任何一边的任何一档都大。
# 单用 label 时这也顺带修了老行为：以前没打标签的跟 priority/p2 并列，现在排在它之后。
_prio_rank_unset=${#_prio_labels[@]}
# Project / 原生字段那一路的档位表由 agent-poll 每轮装载（读不到就留空 = 全体回落到 label）。
declare -A PROJECT_PRIO=()

# 第一排序键。所有来源的档位都是「越小越优先」的下标；哪儿都没标的一律 $_prio_rank_unset。
priority_rank() {
    local labels_csv=",$1," num="${2:-}" i l
    # Project / 原生字段上真的设了值 → 直接用它（project / both 两种模式一致）
    if [ "${PRIORITY_SOURCE:-label}" != "label" ] && [ -n "$num" ] && [ -n "${PROJECT_PRIO[$num]:-}" ]; then
        echo "${PROJECT_PRIO[$num]}"; return
    fi
    # project 模式：没设值就是没标，**不看 label**（口径单一，免得两套标准打架）
    if [ "${PRIORITY_SOURCE:-label}" = "project" ]; then
        echo "$_prio_rank_unset"; return
    fi
    for (( i = 0; i < ${#_prio_labels[@]}; i++ )); do
        l="${_prio_labels[$i]}"
        [ -n "$l" ] || continue
        case "$labels_csv" in
            *",$l,"*) echo "$i"; return ;;
        esac
    done
    echo "$_prio_rank_unset"
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
#   等待标签       在等外部需求机器人带回答复（GitHub#95）；有人打了触发标签才由 label 趟按原流程收
# GREEDY_SKIP_LABELS 是项目自定义的**追加**项（逗号分隔），比如 "blocked,discussion"。
greedy_skip_label_list() {
    printf '%s\n' \
        "$LABEL_PENDING_HUMAN" \
        "$LABEL_AGENT_DOING" \
        "$LABEL_DONE" \
        "$LABEL_PENDING_PR" \
        "${LABEL_PENDING_REVIEW:-}" \
        "${LABEL_PENDING_REQUESTER_BOT:-}"
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
# ── 优先级字段：为什么必须从 issue 那条路读 ──
# GitHub 新版的 Priority 是**issue 级字段**，但它会**投影到看板上**显示成一列，
# 在看板设置里也点得进去（.../projects/N/settings/fields/<databaseId>）。看着像看板
# 自定义字段，其实不是 —— 从 Projects API 那条路读它会得到两个反直觉的结果：
#
#   · field(name:"Priority") 返回 ProjectV2SingleSelectField，但 **options 是空的**
#     （实测 databaseId=350358622，跟设置页 URL 同一个字段，界面上明明有
#      Urgent/High/Medium/Low）；
#   · 条目上的值类型是 **ProjectV2ItemIssueFieldValue**，不是单选值类型，
#     fieldValueByName 那套取不到 name。
#
# 也就是说：**看板这条路读不到它**，必须走 issue 那条（issue.issueFieldValues），
# 选项顺序也只有在那儿才拿得到。对照组：Status 是真·看板自定义字段
# （databaseId=348734829），options 正常返回 Backlog/Preparing/...。
#
# 所以顺序是：先试 issue 原生字段，拿不到再试看板的真自定义单选字段（有些项目
# 确实用后者，而且**只有后者能标到 PR 上** —— PR 没有 issue 原生字段）。
priority_pairs() {
    local out err rc
    out=$(mktemp); err=$(mktemp)
    if issue_field_priority_pairs > "$out" 2> "$err"; then
        cat "$out"; rm -f "$out" "$err"; return 0
    fi
    # ① 没有 → 再试 ②。只有两条都失败才把错误抛出去（否则 ① 的「没有值」会盖掉真错误）
    if project_priority_pairs > "$out" 2>> "$err"; then
        cat "$out"; rm -f "$out" "$err"; return 0
    fi
    cat "$err" >&2; rm -f "$out" "$err"; return 1
}

# ① issue 原生字段。一次查 100 条 open issue，档位取该字段的选项顺序
# （Urgent > High > Medium > Low 这种，谁在前谁优先）。
# 只覆盖 issue：PR 没有原生 issue 字段，PR 那部分自然回落到 label。
issue_field_priority_pairs() {
    local field="${PROJECT_PRIORITY_FIELD:-Priority}"
    local owner="${REPO%%/*}" name="${REPO##*/}"
    local after="" page opts="" n_opts=0 pairs pairs_all=""

    while :; do
        if [ -n "$after" ]; then
            page=$(project_gh_graphql -f o="$owner" -f r="$name" -f a="$after" -f query='
                query($o:String!,$r:String!,$a:String!){ repository(owner:$o,name:$r){
                  issues(first:100, states:OPEN, after:$a){ pageInfo{hasNextPage endCursor}
                    nodes{ number issueFieldValues(first:10){ nodes{
                      ... on IssueFieldSingleSelectValue{ name
                        field{ ... on IssueFieldCommon{ name } ... on IssueFieldSingleSelect{ options{ name } } } } } } } } } }' 2>&1) \
                || { printf '%s' "$page" >&2; return 1; }
        else
            page=$(project_gh_graphql -f o="$owner" -f r="$name" -f query='
                query($o:String!,$r:String!){ repository(owner:$o,name:$r){
                  issues(first:100, states:OPEN){ pageInfo{hasNextPage endCursor}
                    nodes{ number issueFieldValues(first:10){ nodes{
                      ... on IssueFieldSingleSelectValue{ name
                        field{ ... on IssueFieldCommon{ name } ... on IssueFieldSingleSelect{ options{ name } } } } } } } } } }' 2>&1) \
                || { printf '%s' "$page" >&2; return 1; }
        fi

        # 选项顺序：从任意一条带值的记录上取（字段定义本身在 repository.issueFields 里
        # 查不到 —— 内置字段不在那个列表中，实测 totalCount=0）
        if [ "$n_opts" -eq 0 ]; then
            # 取**第一条**带值记录上的选项数组就够 —— 每条记录都重复带着同一份定义，
            # 全收会得到 N 份拼在一起（实测 9 条 × 4 个 = 36），档位数直接算错。
            opts=$(printf '%s' "$page" | jq -r --arg f "$field" '
                [.data.repository.issues.nodes[]?.issueFieldValues.nodes[]?
                 | select(.field.name == $f) | .field.options] | first // []
                | map(.name) | join("\t")' 2>/dev/null || true)
            if [ -n "$opts" ]; then
                n_opts=$(printf '%s' "$opts" | awk -F'\t' '{print NF}')
            fi
        fi

        pairs=$(printf '%s' "$page" | jq -r --arg f "$field" '
            .data.repository.issues.nodes[]? as $i
            | ($i.issueFieldValues.nodes[]? | select(.field.name == $f)) as $v
            | ([$v.field.options[]?.name] | to_entries | map({key:.value, value:.key}) | from_entries) as $rank
            | select($rank[$v.name] != null)
            | "\($i.number)\t\($rank[$v.name])"' 2>/dev/null || true)
        [ -n "$pairs" ] && pairs_all="${pairs_all}${pairs}"$'\n'

        [ "$(printf '%s' "$page" | jq -r '.data.repository.issues.pageInfo.hasNextPage // false' 2>/dev/null)" = "true" ] || break
        after=$(printf '%s' "$page" | jq -r '.data.repository.issues.pageInfo.endCursor // empty' 2>/dev/null)
        [ -n "$after" ] || break
    done

    if [ "${n_opts:-0}" -eq 0 ] || [ -z "$pairs_all" ]; then
        echo "issue 原生字段「$field」上没有任何取值（该仓库可能没启用它）" >&2
        return 1
    fi
    printf '#project\tissue 原生字段 %s（%s）\n' "$field" "$(printf '%s' "$opts" | tr '\t' '>')"
    printf '#options\t%s\n' "$n_opts"
    printf '%s' "$pairs_all"
}

# 定位「用哪个 Project」。两条路，行为差别很大，别混：
#
#   ① PROJECT_NUMBER 有值 → 按 <owner, number> 直接取，**不要求 Project 跟仓库有关联**。
#      owner 取 PROJECT_OWNER，没配才回落到仓库 owner —— 个人看板挂着组织仓库的卡片
#      是常见配置（看板在 github.com/users/<你>/projects/N，仓库在组织下），这时两个
#      owner 根本不是一个人，必须分开配。先试 organization 再试 user：两种 owner 的
#      GraphQL 入口不同名，猜错那次会报 NOT_FOUND，忽略掉换另一个即可。
#   ② PROJECT_NUMBER 留空 → 自动取**本仓库关联的** Project 里编号最小的那个。
#      显式写 orderBy=NUMBER ASC，不靠 API 的默认顺序 —— 默认顺序没有承诺，
#      仓库挂了两个看板时会变成「今天排这个明天排那个」，而且完全没有迹象。
#
# 成功时 stdout 写 "<project id>\t<number> <title>"。
project_resolve() {
    local n="${PROJECT_NUMBER:-}" owner kind resp id num title last=""
    if [ -n "$n" ]; then
        owner="${PROJECT_OWNER:-${REPO%%/*}}"
        for kind in organization user; do
            resp=$(project_gh_graphql -f owner="$owner" -F n="$n" -f query="
                query(\$owner:String!,\$n:Int!){ $kind(login:\$owner){ projectV2(number:\$n){ id number title } } }" 2>&1) || last="$resp"
            id=$(printf '%s' "$resp" | jq -r ".data.$kind.projectV2.id // empty" 2>/dev/null)
            if [ -n "$id" ]; then
                num=$(printf '%s' "$resp" | jq -r ".data.$kind.projectV2.number // empty" 2>/dev/null)
                title=$(printf '%s' "$resp" | jq -r ".data.$kind.projectV2.title // empty" 2>/dev/null)
                printf '%s\t%s %s' "$id" "$num" "$title"
                return 0
            fi
        done
        printf '按编号找不到 Project（owner=%s number=%s，organization / user 两种入口都试过）%s\n' \
            "$owner" "$n" "${last:+：$(printf '%s' "$last" | head -1 | cut -c1-160)}" >&2
        return 1
    fi

    resp=$(project_gh_graphql -f owner="${REPO%%/*}" -f name="${REPO##*/}" -f query='
        query($owner:String!,$name:String!){
          repository(owner:$owner,name:$name){
            projectsV2(first:20, orderBy:{field:NUMBER,direction:ASC}){ nodes{ id number title } }
          }
        }' 2>&1) || { printf '%s' "$resp" >&2; return 1; }
    id=$(printf '%s' "$resp" | jq -r '[.data.repository.projectsV2.nodes[]? | select(.!=null)][0] | .id // empty' 2>/dev/null)
    if [ -z "$id" ]; then
        echo "本仓库（$REPO）没有关联任何可读的 Project；要用别处的看板请配 PROJECT_NUMBER（+ PROJECT_OWNER）" >&2
        return 1
    fi
    num=$(printf '%s' "$resp" | jq -r '[.data.repository.projectsV2.nodes[]? | select(.!=null)][0].number // empty' 2>/dev/null)
    title=$(printf '%s' "$resp" | jq -r '[.data.repository.projectsV2.nodes[]? | select(.!=null)][0].title // empty' 2>/dev/null)
    printf '%s\t%s %s' "$id" "$num" "$title"
}

# stdout 写 "<issue/PR 编号>\t<档位下标>"，一行一条；失败返回非 0（调用方回落到 label）。
# 另外吐两行元信息给调用方记日志：#project（用了哪个看板）和 #options（选项数）。
# 只输出**本仓库**的条目：一个 Project 常常挂着好几个仓库的卡片，编号会撞车。
project_priority_pairs() {
    local field="${PROJECT_PRIORITY_FIELD:-Priority}"
    local resolved pid after page

    resolved=$(project_resolve) || return 1
    pid="${resolved%%$'\t'*}"
    printf '#project\t%s\n' "${resolved#*$'\t'}"

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

        # 字段没有选项 = 这一趟拿不到任何可用档位。必须当**失败**处理让调用方回落到
        # label，不能当"读到了、只是大家都没设值"——后者在 PRIORITY_SOURCE=project 下会
        # 把所有条目算成同一档（档位数为 0 时下标全落空，等于优先级键整体失效），
        # 排序静默失效且毫无迹象。现实里两种情况都会撞上：字段名写错，或者字段建了
        # 但选项还没配（GitHub 自带模板的 Priority 就是空的，要自己加 P0/P1/P2）。
        _opt_n=$(printf '%s' "$page" | jq -r '[.data.node.field.options[]?.name] | length' 2>/dev/null || echo 0)
        if [ "${_opt_n:-0}" -eq 0 ]; then
            echo "Project 字段「$field」没有可用选项（字段不存在 / 不是单选 / 选项还没配）——去看板上给它加档位（选项顺序 = 优先级顺序）" >&2
            return 1
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
#
# dispatch 子进程会把本次选择放进 DISPATCH_WORKER_MODEL。不能直接用
# WORKER_MODEL 传递：source 配置文件时会重新赋值同名变量，把 review 的模型
# 覆盖成普通 worker 的配置（甚至把明确的空覆盖误判成没有覆盖）。
if [ "${DISPATCH_WORKER_MODEL_SET:-0}" = 1 ]; then
    WORKER_MODEL="${DISPATCH_WORKER_MODEL:-}"
else
    WORKER_MODEL="${WORKER_MODEL:-}"
fi

# 本次派工的**会话角色**：worker（写代码的）/ review（交叉复审的）。
#
# 为什么需要它：review 关卡跟普通 worker 完全可以是同一个 agent
# （REVIEW_WORKER_AGENT 配成 claude 就是）。同一个 agent + 同一个 worktree，
# agent 自带的「续接这个目录最近的一条会话」会让 review 直接读到 worker 的上下文
# —— 复审就不独立了，它会连着 worker 为自己辩解的那些话一起继承。
# 反方向同样成立：review 起完自己的会话后，worker 下一轮再续接「最近一条」，
# 续到的是 review 那条，反而丢掉自己的实现上下文。
# 所以每次派工都带一个角色，会话按 (work number, agent, 角色) 各归各。
#
# 角色从 prompt 模板类型推（review 模板 = 交叉复审关卡），agent-poll 已经把
# DISPATCH_PROMPT_KIND 传给 dispatch 子进程了，不用再加一条传递链路。
DISPATCH_SESSION_ROLE="${DISPATCH_SESSION_ROLE:-}"
if [ -z "$DISPATCH_SESSION_ROLE" ]; then
    case "${DISPATCH_PROMPT_KIND:-}" in
        review) DISPATCH_SESSION_ROLE="review" ;;
        *)      DISPATCH_SESSION_ROLE="worker" ;;
    esac
fi
WORKER_SESSION_ROLE="$DISPATCH_SESSION_ROLE"

# Outbound GitHub 评论里附时间+token 元数据 footer（on / off）。默认 on。
# 项目级 prompt 模板可读 ${COMMENT_FOOTER}，自行决定本项目是否加 footer。
COMMENT_FOOTER="${COMMENT_FOOTER:-on}"

mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/poll.log"

# Pane log 目录：tmux pipe-pane 把 worker session 的输出旁路到文件，
# 这样 tmux session 退出后还能 cat / less 回看历史。
# 默认 $STATE_DIR/sessions。在 cavil-loop.config 里显式置空 (SESSION_LOG_DIR="") 即可关闭。
SESSION_LOG_DIR="${SESSION_LOG_DIR-$STATE_DIR/sessions}"

# Skill 目录（scripts/ 的父目录）。Claude Code 注入 $CLAUDE_PLUGIN_ROOT 时优先它。
SKILL_DIR="${CODING_AGENT_RELEASE_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"

log() {
    echo "[$(date -Iseconds)] [${TMUX_PREFIX}] $*" | tee -a "$LOG_FILE" >&2
}

# 默认仅输出常规日志；LOG_LEVEL=debug 额外显示排查用的例行明细。
LOG_LEVEL="${LOG_LEVEL:-info}"
log_debug() {
    if [ "$LOG_LEVEL" = "debug" ]; then
        log "[DEBUG] $*"
    fi
    return 0
}

# ── 两把 token：轮询 / 读用 GH_TOKEN，所有写用 WRITE_GH_TOKEN ──
# 留空 = 回落 GH_TOKEN。单账号部署不设它，行为与引入本机制之前完全一致。
# 形状对齐既有的 PROJECT_GH_TOKEN（`<用途>_GH_TOKEN`，空则回落），不引入第三种风格。
#
# 为什么要分：轮询是高频、大流量、最容易撞平台风控的那部分行为，而 commit 署名和
# 全部写权限压在同一把 token 上。2026-09-18 bot 账号被封那次，代价是轮询量把账号
# 烧掉、连带失去所有写能力和 commit 身份，三个项目全停。分开之后 poller 被封换一把
# 继续轮即可，commit 历史和写路径不受影响。
#
# 分割线画在「读 / 写」上，不是「daemon / worker」：daemon 侧除了翻 label，还会开 / 关
# 告警 issue（checkout_stale_alert_*），以及在复盘里 `git push` 到 base 分支
# （scripts/post-merge-retrospective.py）。按进程切的话 poller 就得拿 Contents: Write ——
# 那正好是要从它身上拿掉的东西。
WRITE_GH_TOKEN="${WRITE_GH_TOKEN:-}"

# 有效的写 token（值）。给「需要值本身」的地方用：交接给 worker 的那把、复盘子进程。
gh_write_token() {
    printf '%s' "${WRITE_GH_TOKEN:-${GH_TOKEN:-}}"
}

# 写 GitHub 的 gh 调用一律走它。**daemon 侧任何新增的写调用都用 gh_write，别用 gh。**
# 用命令前的变量赋值而不是 `-e` / argv：赋值进的是子进程的 environ
# （/proc/<pid>/environ 是 0400 仅属主），argv 则是全局可读的。
# 没配 WRITE_GH_TOKEN 时**原样调 gh**，不写成 GH_TOKEN="" —— 空值和未设对 gh 不是
# 同一回事，那会让单 token 部署的行为悄悄变掉。
gh_write() {
    if [ -n "${WRITE_GH_TOKEN:-}" ]; then
        GH_TOKEN="$WRITE_GH_TOKEN" gh "$@"
    else
        gh "$@"
    fi
}

# config 里写 `GH_TOKEN=xxx`（不加 export）时，gh / git 这些**子进程看不见它**。
# 这个坑在已有安装上测不出来：systemd / launchd 早把 GH_TOKEN 注进环境了，config 里
# 再来一次裸赋值会继承已有的 export 属性、照常工作。它只在全新安装、或 cron 部署
# （docs/operations.md 那条兜底路径根本没有 EnvironmentFile）上发作 —— gh 静默回落到
# ~/.config/gh/ 的默认账号，用错账号去写或者 403，日志里一个字都看不出来。
# 这里显式 export 一次，让裸赋值和 export 两种写法都对，用户不需要知道这个区别。
# WRITE_GH_TOKEN **不** export：它只在本进程内被读（gh_write / gh_write_token），
# 没有任何子进程需要它常驻在环境里。
if [ -n "${GH_TOKEN:-}" ]; then
    export GH_TOKEN
fi

# config 文件里是不是真的装着 token。两个条件都要：文本里确实有这个赋值 + 取到的值
# 非空。只看值分不清「config 和环境给了同一个值」，只看文本又会被 `WRITE_GH_TOKEN=""`
# 这种空赋值骗到。
config_holds_token() {
    [ -n "${GH_TOKEN:-}${WRITE_GH_TOKEN:-}" ] || return 1
    grep -qE '^[[:space:]]*(export[[:space:]]+)?(GH_TOKEN|WRITE_GH_TOKEN)=' "$CONFIG_FILE" 2>/dev/null
}

# 装着凭据却同组 / 其他人可读 = 同机任何用户一个 cat 就抄走。setup.sh 建文件时会
# chmod 600，但用户手工建、手工改之后没人管，只能在运行时再兜一道。
# 取不到权限位（stat 两种方言都不认）就闭嘴，不拿猜测去吵。
file_mode_octal() {
    stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo ""
}

warn_if_config_world_readable() {
    local mode go
    config_holds_token || return 0
    mode=$(file_mode_octal "$CONFIG_FILE")
    case "$mode" in
        ''|*[!0-7]*) return 0 ;;
    esac
    [ ${#mode} -ge 2 ] || return 0
    go="${mode: -2}"
    if [ $(( ${go:0:1} & 4 )) -ne 0 ] || [ $(( ${go:1:1} & 4 )) -ne 0 ]; then
        log "⚠️ $CONFIG_FILE 里写着 GitHub token，但权限是 $mode —— 同机其他用户可读，请 chmod 600"
    fi
    return 0
}
warn_if_config_world_readable

# 变量名打错 → 静默回落单 token，一切照常工作、不报错。这行是唯一能看出来的信号。
# 放 log_debug 不放 log：正常情况下它每轮都会打，不该给 poll.log 加噪音。
if [ -n "${WRITE_GH_TOKEN:-}" ]; then
    log_debug "token: 读 / 轮询走 GH_TOKEN，写走 WRITE_GH_TOKEN（双账号）"
else
    log_debug "token: 读写共用 GH_TOKEN（单账号；设 WRITE_GH_TOKEN 可分离）"
fi

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

# ── dispatch 连续失败计数（防失败条目变成每轮重试的热循环）──
# 派工失败时旧逻辑**什么状态都不改**：label 没翻、cursor 没动，于是下一轮看到的还是
# 「一条没在跑的 pending/agent」，原样再派一次，没有任何上限。2026-09-18 实测：一条
# PR 因为目标分支被别的 worktree 占住，2.4 小时里被重复派工 270 次，直到 GitHub 把
# bot 账号封停才停下。
#
# key 用 "<kind>-<num>"（如 issue-34 / pr-959），跟 selfheal 的 "<issue_n>"
# **分开命名空间**：GitHub 上 issue 和 PR 共用一套编号，而 selfheal 记的是 issue_n
# （PR 走 pr_to_issue_num 时可能 fallback 成 PR 编号本身），两套计数落进同一个目录
# 会互相清零——一边自愈成功把另一边的失败计数抹掉，退避就静默失效了。
DISPATCH_FAIL_DIR="$STATE_DIR/dispatch-fail"
dispatch_fail_bump() {
    mkdir -p "$DISPATCH_FAIL_DIR"
    local f="$DISPATCH_FAIL_DIR/$1" c=0
    [ -f "$f" ] && c=$(cat "$f" 2>/dev/null || echo 0)
    c=$((c + 1)); echo "$c" > "$f"; echo "$c"
}
dispatch_fail_reset() {
    rm -f "$DISPATCH_FAIL_DIR/$1" 2>/dev/null || true
}

# ── 轮询节奏：长期没动静的项目渐进退避（issue #35）──
#
# 闹钟（systemd timer / launchd）照旧每 POLL_INTERVAL_SECS 秒把 agent-poll.sh 叫醒一次；
# 这套东西决定的是**被叫醒之后要不要真的去打 GitHub**。脚本改不了自己下次被叫醒的
# 时间（闹钟不归它管），所以这里省的是**调用**而不是进程——进程每分钟起一次只要几十
# 毫秒加一次 flock，而调用才是稀缺资源。
#
# ⚠️ 最重要的边界：这套状态只决定「这一轮跑不跑」，**绝不决定「跑的时候怎么做」**。
# 派工给谁、并发满没满、哪个 session 该回收，真值仍然 100% 来自每轮现拉的 GitHub
# 标签。所以本地状态坏掉的后果只有「节奏不对」，不可能变成「派错工」或「误杀 worker」。
#
# 所有判定一律 **fail-open**：读不懂、算不出、超出合法范围的状态统统当作「该跑」。
# 反过来（坏了就不跑）会让一个项目静默停摆，而且日志上看不出异常——那正是这套东西
# 最危险的失败方向。
#
# 阶梯按**安静了多久**分档，不是按空闲了几轮：`<安静秒数>:<轮询间隔秒数>`，逗号分隔。
# 默认 = 安静 1 天 → 5 分钟，3 天 → 10 分钟，7 天 → 30 分钟。
#
# ⚠️ 这里用 `${VAR-default}` 而不是 `${VAR:-default}`：显式写成空串是「关掉整个特性」
# 的开关，`:-` 会把它当成「没设」又塞回默认阶梯，开关就废了。
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-60}"
POLL_BACKOFF_LADDER="${POLL_BACKOFF_LADDER-86400:300,259200:600,604800:1800}"
POLL_FORCE_SYNC_SECS="${POLL_FORCE_SYNC_SECS:-1800}"
POLL_FAIL_BACKOFF_MAX_SECS="${POLL_FAIL_BACKOFF_MAX_SECS:-1800}"
POLL_DUE_SLACK_SECS="${POLL_DUE_SLACK_SECS:-10}"

# ── 数值闸：进任何算术之前先验一遍 ──
#
# 「全是数字」**不等于** bash 算得对。bash 的算术是 64 位有符号的，一个位数超标但每位
# 都是数字的值会有两种截然不同的坏法，两种都很难看出来（本机实测，不是推理）：
#
#   $(( 18446744073710551916 ))          → 1000300      ← **静默回绕**成一个像模像样的时间戳
#   [ 18446744073710551916 -gt 1800 ]    → integer expression expected（报错，条件当假）
#
# 回绕那条最要命：一个损坏的 next_due 会变成「5 分钟后」这种完全合法的未来时间，于是
# 「比上限还远就当损坏」那道闸根本不触发，项目安安静静按回绕出来的间隔跳过 tick ——
# 正好绕过这套东西承诺的 fail-open。所以下面所有进算术的字段，先过这个闸限位数。
#
# 11 位 epoch ≈ 公元 5138 年；时长类（间隔 / 门槛）用 9 位 ≈ 31 年。都远超任何真实取值，
# 超了就只能是坏数据。
PACE_MAX_DIGITS=11
pace_num() {
    local v="$1" max="${2:-$PACE_MAX_DIGITS}"
    case "$v" in ''|*[!0-9]*) return 1 ;; esac
    [ "${#v}" -le "$max" ] || return 1
    # ⚠️ 还要求是**规范十进制写法**：要么就是 "0"，要么首位不是 0。
    # 带前导零的全数字串会被 bash 算术按**八进制**解释，里面只要有 8 或 9 就是
    # 「value too great for base」——那是个**致命**错误，不是返回非 0：实测直接调用
    # 会把整个 shell 打死。jq 写出来的 JSON 数字永远没有前导零，所以这种写法本来就
    # 不可能是 pace_write 产生的，归到「不是写入路径写得出来的状态」里一起拒掉。
    case "$v" in 0) ;; 0*) return 1 ;; esac
    printf '%s' "$v"
}

# 这几个配置值全都要进 `[ x -gt y ]`，写成 "30m" / "" / 超长数字都会让**算术本身**出问题
# （报错或回绕），而不是得出一个保守结果。这里一次性校验，非法值退回默认并留一行日志。
for _pv in POLL_INTERVAL_SECS:60 POLL_FORCE_SYNC_SECS:1800 POLL_FAIL_BACKOFF_MAX_SECS:1800 POLL_DUE_SLACK_SECS:10; do
    _pk="${_pv%%:*}"; _pd="${_pv##*:}"
    if ! pace_num "${!_pk}" 9 >/dev/null; then
        echo "[cavil-loop] ⚠️ $_pk='${!_pk}' 不是合理的非负整数秒数，回退到默认 $_pd" >&2
        printf -v "$_pk" '%s' "$_pd"
    fi
done
unset _pv _pk _pd

PACE_FILE="${PACE_FILE:-$STATE_DIR/poll-pace.json}"
# 跳过本轮时留给调用方打进 poll.log 的那行；真跑时为空。
PACE_SKIP_MSG=""

# 时间来源统一走这里，测试可以用 POLL_FAKE_NOW 把时钟拨到任意时刻。
# 生产路径上它永远没被设过，等价于 `date +%s`。
pace_now() {
    local n
    if [ -n "${POLL_FAKE_NOW:-}" ] && n=$(pace_num "$POLL_FAKE_NOW"); then
        printf '%s' "$n"; return 0
    fi
    n=$(date +%s 2>/dev/null) || n=""
    # `date` 基本不会失败，但这个值是**所有**比较的基准，拿不到就没有任何判断可信。
    # 空串在 bash 算术里会被静默当成 0——那样每条比较都得出「该跑」，方向虽然对，
    # 但那是巧合不是设计。显式验一遍：坏了就返回 0（＝1970 年），效果同样是立刻跑，
    # 而且是写明的。
    pace_num "$n" || printf '0'
}

# macOS 没有 sha256sum（只有 shasum）。指纹只要求「同输入同输出」，用哪个实现都行，
# 但**必须**在同一台机器上稳定——所以按可用性挑一次，不做跨机比较。
_pace_hash() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256
    else cksum; fi
}

# 退避上限：任何比这还远的 next_due 都不可能是本程序写出来的 → 判定状态损坏。
pace_hard_cap() {
    local cap="$POLL_FORCE_SYNC_SECS"
    if [ "$POLL_FAIL_BACKOFF_MAX_SECS" -gt "$cap" ]; then cap="$POLL_FAIL_BACKOFF_MAX_SECS"; fi
    printf '%s' "$cap"
}

# 阶梯查表：安静了 quiet 秒 → 该用多大间隔。
#
# 取「所有已跨过的门槛里**门槛最大**的那一档」，而不是「最后一个跨过的」——后者依赖
# 配置项按升序书写，用户把两档写反就会静默取到错的那档（不报错，只是节奏不对）。
#
# ⚠️ 一档都没跨过时返回 **0 = 完全不设闸**，而不是 POLL_INTERVAL_SECS。差别很要命：
# 返回 60 等于给脚本加了一条「最快 60 秒干一次活」的下限，于是 timer drop-in 跑 30 秒的
# 实例（tutor 就是）会被悄悄拉回 60 秒——不报错、只是变慢，正是这套东西最该避免的失败
# 方式。tests/dispatch-backoff.test.sh 的端到端那组当场就红了（连着四轮只派出去一次）。
# 不退避档的定义就是「每个 tick 都跑」，所以这里必须是 0。
pace_interval_for_quiet() {
    local quiet="$1" iv=0 best=-1 entry th val
    if [ -n "${POLL_BACKOFF_LADDER:-}" ]; then
        while IFS= read -r entry; do
            [ -n "$entry" ] || continue
            th="${entry%%:*}"; val="${entry##*:}"
            # 一个档位写歪了只跳过这一档，不要让一个 typo 把整条阶梯废掉
            pace_num "$th" 9 >/dev/null  || { log "⚠️ POLL_BACKOFF_LADDER 档位非法（门槛）：'$entry'，已跳过"; continue; }
            pace_num "$val" 9 >/dev/null || { log "⚠️ POLL_BACKOFF_LADDER 档位非法（间隔）：'$entry'，已跳过"; continue; }
            if [ "$quiet" -ge "$th" ] && [ "$th" -gt "$best" ]; then best="$th"; iv="$val"; fi
        done < <(printf '%s\n' "$POLL_BACKOFF_LADDER" | tr ',' '\n')
    fi
    # 心跳是硬上界：配得比心跳还慢的档位没有意义（心跳到点照样会跑），夹回去并说明。
    if [ "$iv" -gt "$POLL_FORCE_SYNC_SECS" ]; then
        log "⚠️ 阶梯档位 ${iv}s 超过心跳 ${POLL_FORCE_SYNC_SECS}s，按心跳夹紧"
        iv="$POLL_FORCE_SYNC_SECS"
    fi
    printf '%s' "$iv"
}

# 读不到 GitHub 时的节奏：POLL_INTERVAL_SECS 起步，每多失败一次翻倍，封顶
# POLL_FAIL_BACKOFF_MAX_SECS。跟「安静退避」完全分开：故障不是空闲，把它算成空闲会
# 越错越慢、故障恢复越拖越久（实测：2026-09-18~22 那 88 小时，5 个项目跑了 30040 轮
# 全是 403「账号已封」）。
pace_fail_interval() {
    local streak="$1" iv="$POLL_INTERVAL_SECS" i=1
    [ "$streak" -ge 1 ] || { printf '0'; return 0; }
    while [ "$i" -lt "$streak" ]; do
        iv=$((iv * 2))
        if [ "$iv" -ge "$POLL_FAIL_BACKOFF_MAX_SECS" ]; then iv="$POLL_FAIL_BACKOFF_MAX_SECS"; break; fi
        i=$((i + 1))
    done
    if [ "$iv" -gt "$POLL_FAIL_BACKOFF_MAX_SECS" ]; then iv="$POLL_FAIL_BACKOFF_MAX_SECS"; fi
    printf '%s' "$iv"
}

# 节奏状态读：输出 5 个 TAB 分隔字段 next_due / last_poll / last_active / fail_streak /
# fingerprint，读不出来的给**空串**。
#
# ⚠️ 缺字段绝不能 fallback 成 0：0 对 last_active 的含义是「1970 年就一直安静着」，
# 会把一个刚部署的项目直接打到最慢那一档。「没有值」和「值是 0」必须分得开。
pace_read() {
    jq -r '[(.next_due // ""), (.last_poll // ""), (.last_active // ""),
            (.fail_streak // ""), (.fingerprint // "")] | @tsv' "$PACE_FILE" 2>/dev/null || printf '\t\t\t\t'
}

# 节奏状态写。写失败**不算致命**：文件里留着的是上一轮那个很快就会过期的 next_due，
# 下一轮照样会跑（盘满 / 只读时行为退化成改动前的「每个 tick 都跑」）。
pace_write() {
    local next_due="$1" last_poll="$2" last_active="$3" fail_streak="$4" fingerprint="$5" tmp
    mkdir -p "$STATE_DIR" 2>/dev/null || return 1
    tmp=$(mktemp "$STATE_DIR/.poll-pace.XXXXXX" 2>/dev/null) || return 1
    if jq -n --argjson nd "$next_due" --argjson lp "$last_poll" --argjson la "$last_active" \
            --argjson fs "$fail_streak" --arg fp "$fingerprint" \
            '{next_due:$nd, last_poll:$lp, last_active:$la, fail_streak:$fs, fingerprint:$fp}' \
            > "$tmp" 2>/dev/null; then
        mv "$tmp" "$PACE_FILE" && return 0
    fi
    rm -f "$tmp" 2>/dev/null || true
    return 1
}

# 本轮「判断范围」的指纹：从**已经拉下来的本轮快照**里算，不多花一次调用。
#
# 取两层信息：
#   · daemon 会对之做判断的条目（挂着任一触发 label 或 doing/agent；greedy 模式下是
#     全部 open 条目）→ 记 编号 + 最后更新时间 + 标签，任何一项变了都算有动静；
#   · 其余所有 open 条目 → 只记**编号**。这样一条 PR 被合并 / issue 被关掉（从 open
#     集合里消失）照样能被发现，§3/§3c/§4 那几段清理不会被退避拖住；而对面机器在
#     一条跟本机无关的条目上翻标签，不会把本机从退避里叫醒。
#
# 这就是多机分工那条「别因为对方在干活就误判自己有活动」的落点。**greedy 模式下做不到
# 隔离**——greedy 的候选集按定义就是整个仓库的 open 条目，对面动了什么本来就在本机的
# 判断范围内。这是 greedy 的语义，不是 bug。
#
# 快照读不到时返回非 0 且不输出：调用方必须把它当成「这一轮没算出指纹」，而不是
# 「指纹是空的」——后者会被读成「所有条目都消失了」。
pace_fingerprint() {
    local kind rows="" num updated labels_csv want L
    [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
    for kind in issue pr; do
        snapshot_rows "$kind" "" >/dev/null 2>&1 || return 1
        while IFS=$'\t' read -r num _ updated labels_csv _; do
            [ -n "$num" ] || continue
            want=0
            if [ "${DISPATCH_MODE:-label}" = "greedy" ]; then
                want=1
            else
                for L in "${TRIGGER_LABELS_ALL[@]}" "$LABEL_AGENT_DOING"; do
                    [ -n "$L" ] || continue
                    case ",$labels_csv," in *",$L,"*) want=1; break ;; esac
                done
            fi
            if [ "$want" = 1 ]; then
                rows+="${kind}#${num}|${updated}|${labels_csv}"$'\n'
            else
                rows+="${kind}#${num}"$'\n'
            fi
        done < <(snapshot_rows "$kind" "" 2>/dev/null)
    done
    printf '%s' "$rows" | LC_ALL=C sort | _pace_hash | cut -c1-16
}

# 秒数 → 人读时长，只给日志用。
pace_human_secs() {
    local s="$1"
    if [ "$s" -lt 60 ]; then printf '%ds' "$s"
    elif [ "$s" -lt 3600 ]; then printf '%dm%ds' "$((s / 60))" "$((s % 60))"
    elif [ "$s" -lt 86400 ]; then printf '%dh%dm' "$((s / 3600))" "$(((s % 3600) / 60))"
    else printf '%dd%dh' "$((s / 86400))" "$(((s % 86400) / 3600))"; fi
}

# 这份状态是不是**正常写入路径可能写出来的**？不是 → 损坏 → 现在就跑。
#
# 为什么要有这么一条、而不是继续逐个字段加校验：光验「每个字段自己合不合法」是个
# 永远补不完的清单——字段都合法、但**彼此关系**不可能同时成立的状态照样存在，而且
# 组合是无穷的。与其等下一个变体被发现，不如把判据反过来写：正常写入恒满足下面这几条
# 不变式，任何一条不成立就说明这份文件不是本程序写的。
#
# 写入方（pace_record_ok / pace_record_fail）恒满足：
#   · last_active <= last_poll
#     record_ok 把 last_active 夹到 ≤ now，而 last_poll 就是同一个 now；
#     record_fail 沿用旧的 last_active，旧值 ≤ 旧 last_poll ≤ 现在的 now。
#   · last_poll <= next_due
#     next_due = last_poll + 间隔，两套阶梯的间隔都 ≥ 0（不退避档就是 0）。
#   · next_due - last_poll <= 硬上限
#     空闲档被夹在心跳值以内，故障档被夹在故障上限以内，取两者更大的那个。
#     注意这一条是按**写入时刻**算的，不看 now —— 比「next_due 离 now 多远」更严，
#     也不会因为时钟漂移产生假阳性。
#
# 配置被人改小之后，旧状态可能一次性判成越界 → 多跑一轮并重写 → 自愈，方向安全。
pace_state_sane() {
    local next_due="$1" last_poll="$2" last_active="$3" fail_streak="$4" cap
    if [ "$last_active" -gt "$last_poll" ]; then return 1; fi
    if [ "$next_due" -lt "$last_poll" ]; then return 1; fi
    # 上限按**当时走的是哪套阶梯**取，而不是笼统取两者最大值：fail_streak=0 说明上一轮
    # 是正常读到了 GitHub、走的空闲阶梯，那一套被夹在心跳值以内，拿故障上限去放宽它
    # 等于凭空多认一批本程序写不出来的状态。
    if [ "$fail_streak" -gt 0 ]; then cap="$POLL_FAIL_BACKOFF_MAX_SECS"; else cap="$POLL_FORCE_SYNC_SECS"; fi
    if [ $((next_due - last_poll)) -gt "$cap" ]; then return 1; fi
    return 0
}

# 闸门的**对外入口**：返回 0 = 本轮跳过（PACE_SKIP_MSG 已填好）；非 0 = 照常轮询。
#
# ⚠️ 极性是刻意反过来的：**只有明确得出「跳过」才返回 0**。判定整个跑在命令替换的子
# shell 里，万一它自己出错被打死（某个算术表达式炸了、某个 helper 被改坏了），子 shell
# 给不出 "skip"，这里就返回非 0 = 跑。反过来写（子 shell 失败当跳过）会把闸门自己的
# bug 变成整个项目静默停摆，而 _lib.sh 顶部那个永久 stderr 重定向让这种死法在
# poll.log 里一个字都看不见。
#
# 为什么不直接 `if ! pace_should_poll`：实测 bash 在 `if ! f` 里遇到致命算术错误时
# **两个分支都不执行**、直接往下走——恰好也是 fail-open，但那是 bash 的冷僻行为，
# 不是这里的设计。把调用方式换成 `pace_should_poll || { ...; exit 0; }` 就会翻面变成
# 硬停摆。安全不能建立在「碰巧」上，所以显式写成这样。
pace_gate_says_skip() {
    local out
    out=$(pace_should_poll >/dev/null 2>&1 && printf 'run' || printf 'skip\t%s' "$PACE_SKIP_MSG") || out=""
    case "$out" in
        skip*) PACE_SKIP_MSG="${out#skip$'\t'}"; return 0 ;;
        *)     PACE_SKIP_MSG=""; return 1 ;;
    esac
}

# 本轮该不该真跑。返回 0 = 跑；1 = 跳过（此时 PACE_SKIP_MSG 是要打进日志的那行）。
# **调用方一律走 pace_gate_says_skip，别直接调这个**——见上面那段。
#
# 五道闸，前四道全是「坏了就跑」的保险，只有最后一道才是真正的退避判断：
#   0. 阶梯留空          → 特性关闭，行为与改动前逐字节一致
#   1. 状态读不出/不是数字 → 防线 1：损坏即到期
#   2. next_due 比上限还远 → 防线 1：这个值不可能是本程序写的（时钟跳变 / 文件被改坏）
#   3. now < last_poll     → 防线 2：时钟往回跳了，状态不可信
#   4. 距上次真跑 ≥ 心跳   → 防线 3：保底跟 GitHub 对一次，独立于上面所有判断
#   5. 没到点              → 跳过
pace_should_poll() {
    PACE_SKIP_MSG=""
    [ -n "${POLL_BACKOFF_LADDER:-}" ] || return 0

    local now next_due last_poll last_active fail_streak fingerprint waited remain
    now=$(pace_now)
    IFS=$'\t' read -r next_due last_poll last_active fail_streak fingerprint < <(pace_read) || true

    # ── 一处验完，再谈跳不跳 ──
    # 状态里**每一个会被读到的数值字段**读不懂、缺失、或位数超标（会回绕成一个看着正常
    # 的时间戳）→ 一律当作损坏 = 现在就该跑。
    #
    # ⚠️ 必须**一次性验完、且在任何一条 skip 路径之前**。只验 next_due / last_poll 是不够的：
    # 一个坏掉的 last_active（或 fail_streak）会一路走到「没到点 → 跳过」，于是本轮仍然
    # 等到 next_due 才跑 —— 上限虽然被心跳兜住（最多 30 分钟），但「状态坏了下一个 tick
    # 就跑」这条明写在文档和注释里的承诺就被打了折。复审第 3 轮用 `last_active="broken"`
    # 实测到 skip，属实。
    #
    # 跟 pace_record_* 里那几处 `|| last_active="$now"` 的区别：那是**跑完之后的修复**
    # （必须给出一个能写回文件的值），这里是**跑不跑的判定**（存疑就跑）。两者方向相反，
    # 别互相抄。
    next_due=$(pace_num "$next_due")          || return 0
    last_poll=$(pace_num "$last_poll")        || return 0
    last_active=$(pace_num "$last_active")    || return 0
    fail_streak=$(pace_num "$fail_streak" 6)  || return 0

    # 字段各自合法之后，再看它们**彼此的关系**是否可能同时成立（见 pace_state_sane）。
    # 用 if/fi 而不是 `[ ] && return`：set -e 下 cond 为假会把 status 1 漏给调用方，
    # 而调用方正是 `if ! pace_should_poll` —— 漏出去就等于把「该跑」读成「跳过」。
    if ! pace_state_sane "$next_due" "$last_poll" "$last_active" "$fail_streak"; then return 0; fi
    if [ "$now" -lt "$last_poll" ]; then return 0; fi

    # 心跳不覆盖「读不到 GitHub」那套退避：读不到的时候强行再读一次正是它要避免的事，
    # 而且那个状态是自证的（上一次尝试真的失败了），没有推断错的空间。
    #
    # ⚠️ 诚实说明：自从 pace_state_sane 按写入侧不变式把 next_due - last_poll 夹在
    # 心跳值以内之后，**对合法状态而言这个 return 0 已经走不到了** —— waited ≥ 心跳值
    # 必然意味着已经到点，下面那条判断会先命中。留着它是第二道保险：万一哪天
    # pace_state_sane 本身被改出 bug，「最长多久必须跑一次」这条承诺还有人兜。
    # 它的**条件**仍然是活的：fail_streak > 0 时不触发，这一条由【5b】盯着。
    waited=$((now - last_poll))
    if [ "$fail_streak" -eq 0 ] && [ "$waited" -ge "$POLL_FORCE_SYNC_SECS" ]; then
        return 0
    fi

    if [ $((now + POLL_DUE_SLACK_SECS)) -ge "$next_due" ]; then return 0; fi

    remain=$((next_due - now))
    if [ "$fail_streak" -gt 0 ]; then
        PACE_SKIP_MSG="本轮跳过（GitHub 读取连续失败 ${fail_streak} 次，还差 $(pace_human_secs "$remain") 重试）"
    else
        PACE_SKIP_MSG="本轮跳过（已安静 $(pace_human_secs $((now - last_active)))，当前档位 $(pace_human_secs $((next_due - last_poll)))，还差 $(pace_human_secs "$remain")）"
    fi
    return 1
}

# 一轮真跑完、且这一轮**读到了** GitHub 时调用。
#   acted=1  daemon 这轮确实做了事（派工 / 自愈 / 回收 / 清理 / 队列里有活 / 有 worker 在跑）
#   fp       本轮指纹；空串 = 没算出来 → 保守当作「有动静」，并保留上一轮的指纹不覆盖
pace_record_ok() {
    local acted="$1" fp="$2"
    local now next_due last_poll last_active fail_streak prev_fp active quiet iv
    now=$(pace_now)
    IFS=$'\t' read -r next_due last_poll last_active fail_streak prev_fp < <(pace_read) || true

    last_active=$(pace_num "$last_active") || last_active="$now"
    # 时钟往回跳过 → last_active 落在未来 → 当场校正，否则 quiet 会算成负数
    if [ "$last_active" -gt "$now" ]; then last_active="$now"; fi

    active=0
    if [ "$acted" = 1 ]; then active=1; fi
    if [ -z "$fp" ]; then
        active=1          # 指纹没算出来：保守当有动静，且不覆盖上一轮的值
        fp="$prev_fp"
    elif [ "$fp" != "$prev_fp" ]; then
        active=1
    fi
    if [ "$active" = 1 ]; then last_active="$now"; fi

    quiet=$((now - last_active))
    iv=$(pace_interval_for_quiet "$quiet")
    PACE_TIER_SECS="$iv"; PACE_QUIET_SECS="$quiet"
    pace_write "$((now + iv))" "$now" "$last_active" 0 "$fp" \
        || log "⚠️ 节奏状态写入失败（不影响本轮；下一轮会照常跑）"
    return 0
}

# 一轮真跑、但**整轮读不到** GitHub 时调用。
# 安静计时在这里**冻结**（既不清零也不推进）：故障不是空闲，恢复之后要从故障前那一档
# 继续，而不是被一次网络抖动打回慢档、也不是被当成「没活干」越退越慢。
pace_record_fail() {
    local now next_due last_poll last_active fail_streak fp iv
    now=$(pace_now)
    IFS=$'\t' read -r next_due last_poll last_active fail_streak fp < <(pace_read) || true
    fail_streak=$(pace_num "$fail_streak" 6) || fail_streak=0
    if [ "$fail_streak" -gt 64 ]; then fail_streak=64; fi   # 状态被写坏时别让翻倍循环失控
    fail_streak=$((fail_streak + 1))
    last_active=$(pace_num "$last_active") || last_active="$now"
    if [ "$last_active" -gt "$now" ]; then last_active="$now"; fi
    iv=$(pace_fail_interval "$fail_streak")
    PACE_TIER_SECS="$iv"
    pace_write "$((now + iv))" "$now" "$last_active" "$fail_streak" "$fp" || true
    log "GitHub 读取连续失败 ${fail_streak} 次 → 下一轮 $(pace_human_secs "$iv") 后重试"
    return 0
}

# 目标分支是不是已经被**另一个** worktree 签出。命中 → 打印占用它的 worktree 路径并
# return 0；没占用 → return 1。调用方必须已经 cd 进仓库（主 checkout）。
#
# 为什么非查不可（两条都是本机实测，不是推理）：
#   1. 分支被别的 worktree 签出时，`git fetch` 会**无条件**拒绝写它
#      （`fatal: refusing to fetch into branch ... checked out at ...`，exit 128）——
#      哪怕要写的内容跟当前一模一样也照样拒绝。所以这类失败在占用者还在期间是确定的。
#   2. 紧随其后的 `git worktree add --force` 反而会**成功**，建出第二个签出同一分支的
#      worktree。也就是说：光把 fetch 修好并不安全，那只会把「派工失败」换成「两个
#      worker 往同一个分支上提交、互相覆盖」。
#
# 匹配必须是**全等**，不能是子串/前缀：`feature/issue-3` 绝不能匹配上
# `feature/issue-34`。这跟 greedy 挡工判据里防的 `pending/human` vs `pending/humanoid`
# 是同一类坑——错了不会报错，只会悄悄挡住或悄悄放过一条活。
branch_checked_out_elsewhere() {
    local branch="$1" self="${2:-}"
    local wt="" line
    while IFS= read -r line; do
        case "$line" in
            "worktree "*) wt="${line#worktree }" ;;
        esac
        # 用字符串全等而不是 case 的 glob：分支名虽然不允许 * ? [，但这里不值得赌。
        if [ "$line" = "branch refs/heads/$branch" ]; then
            # 自己那份不算占用（重复派工时 worktree 可能已经在了）
            if [ -n "$self" ] && [ "$wt" = "$self" ]; then
                continue
            fi
            printf '%s' "$wt"
            return 0
        fi
    done < <(git worktree list --porcelain 2>/dev/null || true)
    return 1
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

# PR 正文里写的关联 issue（Closes/Fixes/Resolves/Refs #N）。daemon 里这条规则一直有两种
# 写法，对「关键词和编号分在两行」的判断不同（main 上就如此，本 PR 不改它们的行为）：
#   pr_body_linked_issue     grep 逐行找：会话命名（pr_to_issue_num）用它
#   PR_BODY_LINK_JQ_RE       jq 整段找：活跃 worker 列表（list_active_workers）用它
# 外部需求机器人要从正文找来源时，两种都跑，结果一致才认（requester_bot_item_origin），这样它认定的
# 来源永远和会话命名、活跃 worker 列表都对得上；不一致就拒绝、交维护者。
# 正文从 stdin 读；没有就输出空。
pr_body_linked_issue() {
    grep -oiE '(close[sd]?|fix(es|ed)?|resolve[sd]?|refs?)[[:space:]]+#[0-9]+' \
        | head -1 \
        | grep -oE '[0-9]+' || true
}
PR_BODY_LINK_JQ_RE='(?i)(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?|refs?)[[:space:]]+#(?<n>[0-9]+)'
pr_body_linked_issue_jq() {
    jq -Rr --slurp --arg re "$PR_BODY_LINK_JQ_RE" 'try capture($re).n catch ""' 2>/dev/null || true
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
    n=$(gh pr view "$pr" --repo "$REPO" --json body --jq '.body // ""' 2>/dev/null | pr_body_linked_issue)
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
# 这条活是不是**本机**派出去的（多机分工用）。
# SELFHEAL_ONLY_OWN_WORKERS 关着时恒为真 —— 单机场景一切行为不变。
# state.json 还没建起来时也恒为真：宁可多算，也别在冷启动时把并发算成 0 乱派工。
worker_is_ours() {
    local issue_n="$1" owner
    [ "${SELFHEAL_ONLY_OWN_WORKERS:-false}" = "true" ] || return 0
    [ -n "${STATE_FILE:-}" ] && [ -f "$STATE_FILE" ] || return 0
    owner=$(jq -r --arg key "$issue_n" '.worker_hosts[$key] // ""' "$STATE_FILE" 2>/dev/null || echo "")
    [ "$owner" = "$SELFHEAL_HOST_ID" ]
}

# ── 本轮 open 快照 ──
# 一轮 poll 里，self-heal、并发计数、各 label 取工、greedy 兜底问的其实是同一批数据：
# 仓库里所有 open 的 issue / PR 和它们的 label。以前每个用途各发一次
# `gh issue list --label X` / `gh pr list --label X`——tutor 一轮实测 22 次调用里，
# 14 次是这么来的，而且内容高度重叠。现在一轮只拉两次 REST，其余全在本地 jq 过滤。
# 改完实测：tutor 22 → 8，另外四个项目各 11~15 → 5。
#
# 为什么坚持 REST 而不是 `gh issue list`：后者走 search / GraphQL，有索引延迟。这份
# 数据同时喂给并发闸门和**回收（kill session）**，读到过期结果会误杀正在干活的 worker。
# list_active_workers 当初就是为此选的 REST，现在整轮共用同一个来源，顺带把「取工看到
# 的世界」和「回收看到的世界」统一了——以前两者来自不同 endpoint，本身就可能打架。
#
# ⚠️ 缓存必须落文件，不能用 shell 变量：list_active_workers 是被
# `x=$(list_active_workers)` 调的，命令替换开子 shell，变量传不回来。
TICK_DIR="${TICK_DIR:-$STATE_DIR/.tick}"

# kind: issues（含 PR 条目，调用方自己 select(.pull_request == null)）| pulls
# fresh 非空 = 绕过缓存重新拉一次，并刷新缓存。
#
# ⚠️ 什么时候必须 fresh：**动手之前**。回收 worker 会 kill session，它在下手前那次
# 重读的全部意义就是「拿此刻的真值，别拿这一轮开头的」——本轮开头到回收之间隔着整个
# 取工流程，worker 完全可能在这中间翻了 label。让那次重读吃缓存 = 把这道保险拆了。
# 取工 / 并发计数这类只读判断才用缓存。
# stdout 给出 `--slurp` 的原始分页结果（[[...],[...]]）。失败返回非 0 且不落缓存。
open_snapshot() {
    local kind="$1" fresh="${2:-}"
    local f="$TICK_DIR/$kind.json" tmp
    if [ -z "$fresh" ] && [ -s "$f" ]; then cat "$f"; return 0; fi
    mkdir -p "$TICK_DIR"
    tmp=$(mktemp "$TICK_DIR/.$kind.XXXXXX")
    if ! run_gh_capture "读取 open $kind" gh api --method GET --paginate --slurp \
        "repos/$REPO/$kind" -f state=open -f per_page=100 > "$tmp"; then
        rm -f "$tmp"; return 1
    fi
    # 形状先验一遍再落盘：半截 / 非数组的结果绝不能进缓存——本轮后面每一个用途都拿它
    # 做判断，包括回收。宁可本轮整轮不动，也不要拿残缺快照去 kill session。
    if ! jq -e 'type == "array" and all(.[]; type == "array")' "$tmp" >/dev/null 2>&1; then
        log "  ⚠️ open $kind 快照结构异常，本轮不缓存也不使用"
        rm -f "$tmp"; return 1
    fi
    mv "$tmp" "$f"
    cat "$f"
}

# 从本轮快照按 label 取行，输出与原来 `gh issue/pr list --json ... --jq ...` 逐字段
# 一致的 5 列 TSV：编号 / 分支（issue 恒为 "-"）/ updatedAt / label 逗号串 / 标题。
# label 传空 = 不过滤（greedy 兜底那趟用）。
snapshot_rows() {
    local kind="$1" label="${2:-}" pages
    if [ "$kind" = "issue" ]; then
        pages=$(open_snapshot issues) || return 1
        printf '%s' "$pages" | jq -r --arg label "$label" '
            [ .[][] | select(.pull_request == null) ]
            | map(select($label == "" or any(.labels[]?; .name == $label)))
            | .[] | [ (.number|tostring), "-", .updated_at,
                      ([.labels[]?.name] | join(",")),
                      (.title | gsub("[\t\n]"; " ")) ] | @tsv'
    else
        pages=$(open_snapshot pulls) || return 1
        printf '%s' "$pages" | jq -r --arg label "$label" '
            [ .[][] ]
            | map(select($label == "" or any(.labels[]?; .name == $label)))
            | .[] | [ (.number|tostring), .head.ref, .updated_at,
                      ([.labels[]?.name] | join(",")),
                      (.title | gsub("[\t\n]"; " ")) ] | @tsv'
    fi
}

# ⚠️ 多机分工下这里**只列本机的** worker。它同时是并发计数的来源：
# 不过滤的话，A 机会把 B 机那几个 doing/agent 也算进自己的 max，slot 永远是满的，
# 于是 A 机一条活都派不出去，日志上还显示得一切正常。
list_active_workers() {
    # REST list endpoints avoid search-index lag; pagination must complete before
    # any result is used for capacity decisions or destructive cleanup.
    # fresh 非空 → 绕过本轮快照重新读一次。回收路径必须传它（见 open_snapshot 注释）。
    local scope="${1:-ours}" fresh="${2:-}" issue_pages pr_pages issue_nums pr_data
    # 数据来自本轮快照（open_snapshot），一轮只拉一次；doing/agent 的筛选从服务端挪到
    # 本地——语义不变，省掉的是同一轮里第二次、第三次问 GitHub 同样的问题。
    issue_pages=$(open_snapshot issues "$fresh") || return 1
    pr_pages=$(open_snapshot pulls "$fresh") || return 1
    issue_nums=$(printf '%s' "$issue_pages" | jq -er --arg label "$LABEL_AGENT_DOING" '
        if type != "array" or any(.[]; type != "array") then error("invalid issue pages")
        else [ .[][] | select(.pull_request == null)
               | select(any(.labels[]?; .name == $label)) | .number ] | map(tostring) | join("\n") end') || return 1
    # Include the body fallback in this successful snapshot instead of silently
    # falling back to the PR number when a separate gh pr view request fails.
    pr_data=$(printf '%s' "$pr_pages" | jq -er --arg label "$LABEL_AGENT_DOING" --arg re "$PR_BODY_LINK_JQ_RE" '
        if type != "array" or any(.[]; type != "array") then error("invalid PR pages")
        else [ .[][] | select(any(.labels[]; .name == $label)) |
            [.number, .head.ref, ((.body // "" | try capture($re).n catch "") // "")] | @tsv ] | join("\n") end') || return 1

    local -A handled_issue=()
    local -a items=()
    local n pr branch body_n

    # 先处理 PR：算 issue_n（用 pr_to_issue_num fallback 链）并合并显示。
    # 末尾附 GitHub URL 让终端自动识别成可点击链接（多数现代终端支持）。
    # URL 指向 worker 当前主战场——PR 阶段就指 PR、纯 issue 阶段就指 issue。
    if [ -n "$pr_data" ]; then
        while IFS=$'\t' read -r pr branch body_n; do
            n=$(branch_to_issue_num "$branch")
            n="${n:-${body_n:-$pr}}"
            if [ "$scope" != "all" ]; then worker_is_ours "$n" || continue; fi
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
            if [ "$scope" != "all" ]; then worker_is_ours "$n" || continue; fi
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
    # Capacity is ownership-filtered; it is only a fast skip, never proof of completion.
    local -n _active="$1"
    local grace="${REAP_GRACE_SECS:-300}"
    local now sess n last_act idle reaped=0 confirmed_list="" confirmed_loaded=0 line key
    local -A protected_keys=()
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
        # session_activity 仅作额外宽限；不能据此判定测试或 worker 已停止。
        last_act="${_last_act[$sess]:-}"
        # 拿不到活动时间就**不回收**（fail closed）：查不出来不等于「闲着」，
        # 宁可多留一轮，也不要在 worker 收尾时把它打断。
        if ! [[ "$last_act" =~ ^[0-9]+$ ]]; then
            log "⏳ 回收暂缓: $sess（issue #$n 读不到 session_activity —— 保守跳过）"
            continue
        fi
        idle=$(( now - last_act ))
        if [ "$idle" -lt "$grace" ]; then
            log "⏳ 回收暂缓: $sess（issue #$n session ${idle}s 前有活动 < ${grace}s 宽限，可能在收尾）"
            continue
        fi
        # Re-read before cleanup, including workers with missing/foreign ownership.
        # A failed or partial read must never authorize killing any session.
        if [ "$confirmed_loaded" -eq 0 ]; then
            if ! confirmed_list=$(list_active_workers all fresh); then
                log "⚠️ 回收暂缓：无法确认 GitHub worker 状态，保留所有 session"
                return 0
            fi
            while IFS= read -r line; do
                if [[ "$line" =~ ^(issue|PR)\ #([0-9]+) ]]; then
                    key="${BASH_REMATCH[2]}"
                    protected_keys[$key]=1
                fi
            done <<< "$confirmed_list"
            confirmed_loaded=1
        fi
        if [ -n "${protected_keys[$n]:-}" ]; then
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
    # 交给 worker 的 GH_TOKEN，值取写 token（双账号下 = pusher 那把，单账号下就是
    # GH_TOKEN 自己）。**只换值，不换名**：文件名、argv 里的 `-e GH_TOKEN_FILE=`、
    # worker shell 里的 export 前缀全部不变，gh CLI 和 git push 都不需要知道这件事。
    # 指向放在这一个函数里，是因为它是 require_secret_env 和 tmux_env_args 共同的
    # 唯一取值点 —— 散在各 dispatch 调用点上漏掉一个，后果是 worker **静默**拿到
    # 轮询那把 token：不报错、不失败，直到某次 push 署错名才看得出来。
    if [ "$var" = GH_TOKEN ]; then
        val="$(gh_write_token)"
    else
        eval "val=\${$var:-}"
    fi
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
            echo "[cavil-loop] ERROR: $var 在 WORKER_SECRET_ENV 里但当前 env 没设 —— 拒绝派工。" >&2
            echo "[cavil-loop]        systemd 路径检查 EnvironmentFile；手动跑请先 export $var=..." >&2
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
                    echo "[cavil-loop] WARN: WORKER_SECRET_ENV 含 '$var' 但当前 env 没设；worker 不会拿到它。" >&2
                fi
                continue
                ;;
        esac
        if [ -n "$val" ]; then
            printf -- '-e\0%s=%s\0' "$var" "$val"
        elif [ "$var" != "PATH" ]; then
            # PATH 当前 shell 一定有，不可能空；其他 var 空就 warn
            # 写 stderr，agent-poll.sh 的 log 会捕获到
            echo "[cavil-loop] WARN: WORKER_PASS_ENV 含 '$var' 但当前 env 没设；worker 不会拿到它。" >&2
            echo "[cavil-loop]       手动跑 daemon 请先 export $var=...（systemd 路径自动从 EnvironmentFile 注入）" >&2
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

# ── preview 端口与归属（GigleAI/GigleTutor-Web#1009）──
# 端口 = BASE + issue；配了 PREVIEW_PORT_MODULO 就改成 BASE + issue % MODULO，
# 让端口留在一个号段里（tutor：预览 4000–4999，不越界撞进 e2e 的 5000 段）。
#
# 取模的代价是「同余 issue 同端口」（#40 和 #1040 都是 4040），所以端口有了**主人**：
# 登记文件 $PREVIEW_CONF_DIR/<port>.conf 里的「项目 + 完整 issue + worktree」三项。
# 规则只有一句：**谁都只动登记在自己名下的端口；查不到登记就什么都不动。**
# 读登记 → 比对 → 动手（写 conf / systemd / tailscale / 删 conf）必须在同一把端口锁里，
# 注册和注销共用这把锁，否则两个 issue 并发注册时都会「检查时没人」、后写的赢。
# 没登记的遗留路由不自动拆：端口可能已被别的服务复用，按公式拆就是误伤别人。
#
# 预览单元有新旧两套名字（cavil-loop-preview* / 改名前的 coding-agent-preview*），登记也就
# 有新旧两个目录。**每个端口跟着它自己的登记走**（规则见 _names.sh）：查主人、注销、列清单
# 两个目录都看；只有全新注册才按本机装了哪套单元挑。端口锁新旧共用一把。
#   PREVIEW_UNIT_PREFIX / PREVIEW_CONF_DIR：全新注册用的那套单元和它的登记目录
#   PREVIEW_LOCK_DIR：端口锁所在目录
PREVIEW_UNIT_PREFIX="$(cavil_preview_unit_prefix)"
PREVIEW_CONF_DIR="$(cavil_preview_dir_of_prefix "$PREVIEW_UNIT_PREFIX")"
PREVIEW_LOCK_DIR="$(cavil_preview_lock_dir)"

preview_port() {
    local issue="$1" base="${PREVIEW_PORT_BASE:-4000}" mod="${PREVIEW_PORT_MODULO:-}"
    if [ -n "$mod" ]; then
        echo $(( base + issue % mod ))
    else
        echo $(( base + issue ))
    fi
}

# preview_with_port_lock <port> <cmd…>：持端口锁执行 cmd（在子 shell 里，退出码原样透出）。
# 等不到锁（默认 30s）就 exit 4，不硬闯。
preview_with_port_lock() {
    local port="$1"; shift
    mkdir -p "$PREVIEW_LOCK_DIR"
    (
        flock -w "${PREVIEW_LOCK_TIMEOUT:-30}" 7 \
            || { echo "❌ 等 preview 端口 :$port 的锁超时（${PREVIEW_LOCK_TIMEOUT:-30}s）" >&2; exit 4; }
        "$@"
    ) 7>"$PREVIEW_LOCK_DIR/.port-$port.lock"
}

# 某个端口的全部登记（新目录在前），每行「登记文件<TAB>项目|issue|worktree」；没登记输出空。
# 正常只有一行；改名过渡期的旧现场可能两个目录各有一份，调用方必须逐行看，不能只看第一行。
preview_registrations() {
    local d conf
    for d in "${CAVIL_PREVIEW_DIRS[@]}"; do
        conf="$d/$1.conf"
        [ -f "$conf" ] || continue
        # shellcheck disable=SC1090
        printf '%s\t%s\n' "$conf" \
            "$( source "$conf"; printf '%s|%s|%s' "${PREVIEW_PROJECT:-}" "${PREVIEW_ISSUE:-}" "${PREVIEW_WORKTREE:-}" )"
    done
}

# 登记在别人名下的那个主人（任一目录里有就算）；全是自己的或没登记输出空。
# 用法：preview_foreign_owner <port> <项目|issue|worktree>
preview_foreign_owner() {
    local conf owner
    while IFS=$'\t' read -r conf owner; do
        [ -n "$conf" ] || continue
        [ "$owner" = "$2" ] || { printf '%s\n' "$owner"; return 0; }
    done < <(preview_registrations "$1")
}

# 把「项目|issue|worktree」说成人话，给报错用。
preview_owner_human() {
    local project issue worktree
    IFS='|' read -r project issue worktree <<< "$1"
    echo "${project} #${issue}（${worktree}）"
}

# preview_release_owned <port> <project> <issue> <worktree>：**必须在端口锁里调**。
#   登记存在且三项全等 → 停 unit、解 tailscale 路由、删登记，返回 0
#   没登记             → 什么都不动，返回 0（幂等：清理路径上反复调不出错）
#   主人不是调用方     → 什么都不动，返回 3
preview_release_owned() {
    local port="$1" want="$2|$3|$4" owner regs conf prefix
    regs="$(preview_registrations "$port")"
    if [ -z "$regs" ]; then
        echo "preview :$port 没有登记，不动（不按公式拆未登记的路由）"
        return 0
    fi
    owner="$(preview_foreign_owner "$port" "$want")"
    if [ -n "$owner" ]; then
        echo "⚠️ preview :$port 登记在 $(preview_owner_human "$owner") 名下，不是 $(preview_owner_human "$want")，不动" >&2
        return 3
    fi
    # 每份登记停它自己那套单元（旧目录的登记跑在 coding-agent-preview* 上）。
    # 停的顺序：socket 先停，掐掉新连接触发重启的可能；再停 proxy，
    # app 靠 StopWhenUnneeded 自己跟着走（显式再停一次是兜底，幂等无害）。
    while IFS=$'\t' read -r conf owner; do
        prefix="$(cavil_preview_prefix_of_dir "$(dirname "$conf")")"
        systemctl --user stop "${prefix}-preview@${port}.socket"      2>/dev/null || true
        systemctl --user stop "${prefix}-preview@${port}.service"     2>/dev/null || true
        systemctl --user stop "${prefix}-preview-app@${port}.service" 2>/dev/null || true
    done <<< "$regs"
    if command -v tailscale >/dev/null 2>&1 \
        && tailscale serve status 2>/dev/null | grep -q ":${port}\b"; then
        sudo -n tailscale serve --https="$port" off >/dev/null 2>&1 \
            || echo "  ⚠️ tailscale serve off :$port 失败（sudo -n / 权限？）——路由留着，需人工处理" >&2
    fi
    while IFS=$'\t' read -r conf owner; do rm -f "$conf"; done <<< "$regs"
    echo "preview :$port 已注销（$(preview_owner_human "$want")）"
}

# 取 work number 对应的 GitHub issue 标题。GitHub 的 /issues/N REST endpoint
# 对普通 issue 和 PR 都有效，所以 pr_to_issue_num fallback 到 PR number 时也能显示标题。
github_issue_title() {
    local issue="$1"
    run_gh_capture "读取 issue #$issue 标题" \
        gh api "repos/$REPO/issues/$issue" --jq .title
}

# ── 拆分出来的 sub-issue（issue #43）──
# 一个 issue 要多个 PR 时，worker 在方案确认后把它拆成 GitHub 原生 sub-issue：每个子项
# 有自己的编号 → 自己的分支 / worktree / PR（`Closes #子号`），父 issue 只当总表。
# 子 issue 正文带一行 SPLIT_MARKER，派工时据此跳过设计轮（方案已在父 issue 上确认过）。

# 父 issue 查询：stdout 父 issue 编号；没有父 issue → 空串 + return 0；接口出错 → return 1。
# 两种「空」必须分开：没父 = 普通 issue、照常走；出错 = 不知道，调用方不能当成「没父」
# 之外的任何结论（尤其不能当成「父下全完成」）。
# 父 issue 不在本仓库（sub-issue 可以跨仓库挂）→ 当没父：本仓库的 daemon 管不着它。
issue_parent_num() {
    local issue="$1" out rc=0 errf
    errf=$(mktemp)
    out=$(gh api "repos/$REPO/issues/$issue/parent" \
        --jq 'if (.repository_url | endswith("/repos/'"$REPO"'")) then .number else "" end' 2>"$errf") || rc=$?
    if [ "$rc" != 0 ]; then
        if grep -q 'HTTP 404' "$errf"; then rm -f "$errf"; echo ""; return 0; fi
        log "  ⚠️ 查询 issue #$issue 的父 issue 失败: $(tr '\n' ' ' < "$errf") $out"
        rm -f "$errf"
        return 1
    fi
    rm -f "$errf"
    printf '%s\n' "$out"
}

# 写身份（worker 建 sub-issue 用的就是这把 token）的 login，本进程内缓存。
_WRITE_LOGIN_CACHE=""
write_identity_login() {
    if [ -z "$_WRITE_LOGIN_CACHE" ]; then
        _WRITE_LOGIN_CACHE=$(gh_write api user --jq .login 2>/dev/null) || _WRITE_LOGIN_CACHE=""
    fi
    printf '%s' "$_WRITE_LOGIN_CACHE"
}

# 这个 issue 是不是本工具拆出来、可以跳过设计轮的子项？是 → stdout 父 issue 编号。
# 三个条件缺一不可（任何人都能在自己开的 issue 里写一行 HTML 注释，所以只认标记不够）：
#   1. GitHub 上真有父子关系，且父 issue 在本仓库
#   2. 子 issue 正文里的标记指向的正是这个父 issue
#   3. 子 issue 由写身份（bot）创建
# 任何一步查不到 / 出错 → 空串，调用方回落到普通「先出方案」流程（fail-safe：多问一轮，
# 不会少一道人工确认）。
split_parent_of() {
    local issue="$1" parent meta author body me
    parent=$(issue_parent_num "$issue") || { echo ""; return 0; }
    [ -n "$parent" ] || { echo ""; return 0; }
    meta=$(gh api "repos/$REPO/issues/$issue" --jq '[.user.login, (.body // "")] | @json' 2>/dev/null) || { echo ""; return 0; }
    author=$(printf '%s' "$meta" | jq -r '.[0]' 2>/dev/null)
    body=$(printf '%s' "$meta" | jq -r '.[1]' 2>/dev/null)
    me=$(write_identity_login)
    if [ -z "$me" ] || [ "$author" != "$me" ]; then
        log "issue #$issue 挂在 #$parent 下，但作者是 ${author:-?}（不是写身份 ${me:-?}）→ 按普通 issue 先出方案"
        echo ""; return 0
    fi
    if ! printf '%s' "$body" | grep -qE "<!-- agent-split-from: #${parent} -->"; then
        log "issue #$issue 挂在 #$parent 下，但正文没有指向 #$parent 的拆分标记 → 按普通 issue 先出方案"
        echo ""; return 0
    fi
    echo "$parent"
}

# 子 issue 关闭后的父 issue 汇总：父下 sub-issue **全部**已关 → 父 issue 翻 pending/human
# 并留一条汇总评论。**不关父 issue**——关闭权留给人。
#
# 返回码是给重试队列（sub_issue_rollup_drain）看的：
#   0 = 已有定论，出队：汇总完成 / 没有父 issue / 兄弟子项还开着 / 父 issue 已关 / 早就汇总过
#   1 = 这次没做成，留在队里下轮再试：任何一步读或写失败
# 「查不到」绝不等于「全完成」，也绝不等于「不用做」——两边都会让父 issue 永远卡住。
#
# 幂等，而且评论和翻 label 分开记进度（state.json），重试时不会重复发评论：
#   split_rollup_commented[<父号>] = 已发汇总评论时的子项数
#   split_rollups[<父号>]          = 评论 + 翻 label 都成功时的子项数（= 完成）
# 同一轮里两个子 PR 同时合并，两次调用都会看到「全完成」，第二次读到 split_rollups 就停。
# 父 issue 后来又挂了新子项，子项数变了，全部完成时会再汇总一次。
sub_issue_rollup() {
    local sub="$1" state_file="${2:-${STATE_FILE:-$STATE_DIR/state.json}}"
    local parent subs total open_left parent_state done_total commented tmp body
    parent=$(issue_parent_num "$sub") || return 1
    [ -n "$parent" ] || return 0

    # 子项自己关了没有，由这里亲自读，不信调用方：merge 钩子读状态失败时会兜底成 OPEN，
    # 要是只在「确认 CLOSED」时才入队，一次 502 就让最后一个子项永远漏掉汇总。
    # 所以钩子无条件入队，是否关闭在这里判；读不到 = 下轮再试。
    # 有父却还开着（合并的 PR 没写 Closes，或 GitHub 自动关闭有延迟）也留队重试，到上限自然放弃。
    local sub_state
    sub_state=$(run_gh_capture "读取子 issue #$sub 状态" \
        gh api "repos/$REPO/issues/$sub" --jq .state) || return 1
    if [ "$sub_state" != "closed" ]; then
        log "  子 issue #$sub 仍是 ${sub_state:-?}，暂不汇总父 issue #$parent，下轮再看"
        return 1
    fi

    local parent_meta summary_total
    parent_meta=$(run_gh_capture "读取父 issue #$parent 状态" \
        gh api "repos/$REPO/issues/$parent" --jq '"\(.state)\t\(.sub_issues_summary.total // "")"') || return 1
    parent_state=${parent_meta%%$'\t'*}
    summary_total=${parent_meta#*$'\t'}
    [ "$parent_state" = "open" ] || { log "  父 issue #$parent 已关闭，不汇总"; return 0; }

    subs=$(run_gh_capture "列出父 issue #$parent 的 sub-issue" \
        gh api --paginate "repos/$REPO/issues/$parent/sub_issues?per_page=100" \
        --jq '.[] | "\(.number)\t\(.state)"') || return 1
    total=$(printf '%s\n' "$subs" | awk 'NF' | wc -l | tr -d ' ')
    # 「列表齐不齐」要先确认，才谈得上「列表里的都关了没有」。列表只要漏一项，剩下的
    # 恰好全关，就会被误判成「全部完成」。两道对拍，任一不过 = 列表还没刷新完，下轮再试：
    #   1. 当前子项必须在列表里——/parent 刚确认过它挂在这个父 issue 下
    #   2. 列表条数必须等于父 issue 自己记的子项总数（sub_issues_summary.total）——
    #      防的是漏掉**别的**兄弟子项；这个字段缺失也按「核不了」处理，不放行
    if ! printf '%s\n' "$subs" | awk -F'\t' -v s="$sub" '$1 == s {f=1} END {exit !f}'; then
        log "  父 issue #$parent 的 sub-issue 列表里没有 #$sub（接口未刷新？），下轮再试"
        return 1
    fi
    if ! [[ "$summary_total" =~ ^[0-9]+$ ]] || [ "$summary_total" != "$total" ]; then
        log "  父 issue #$parent 的 sub-issue 列表 $total 项，与父 issue 记的总数 '${summary_total}' 对不上，下轮再试"
        return 1
    fi
    # 这个子 issue 上面刚确认过 CLOSED；列表里它的状态若还没刷新，按已关算。
    open_left=$(printf '%s\n' "$subs" | awk -F'\t' -v s="$sub" 'NF && $1 != s && $2 != "closed"' | wc -l | tr -d ' ')
    if [ "$open_left" != 0 ]; then
        log "  父 issue #$parent 还有 $open_left/$total 个子项未完成，不动"
        return 0
    fi

    done_total=$(jq -r --arg p "$parent" '.split_rollups[$p] // empty' "$state_file" 2>/dev/null || true)
    if [ "$done_total" = "$total" ]; then
        log "  父 issue #$parent 已汇总过（$total 个子项），跳过"
        return 0
    fi

    commented=$(jq -r --arg p "$parent" '.split_rollup_commented[$p] // empty' "$state_file" 2>/dev/null || true)
    if [ "$commented" != "$total" ]; then
        body=$(mktemp)
        {
            printf '## 子项全部完成（%s/%s）\n\n' "$total" "$total"
            printf '本 issue 拆出的 sub-issue 都已关闭，请决定是否关闭本 issue（daemon 不会替你关）：\n\n'
            printf '%s\n' "$subs" | awk -F'\t' 'NF {print "- #" $1}'
        } > "$body"
        if ! run_gh "父 issue #$parent 汇总评论" gh_write issue comment "$parent" --repo "$REPO" --body-file "$body"; then
            rm -f "$body"; return 1
        fi
        rm -f "$body"
        tmp=$(mktemp)
        jq --arg p "$parent" --argjson n "$total" '.split_rollup_commented = ((.split_rollup_commented // {}) + {($p): $n})' \
            "$state_file" > "$tmp" && mv "$tmp" "$state_file"
    fi

    # 不用 gh_label_flip：它对每个 DELETE 都 `|| true`（翻 label 场景里「本来就没有」很常见），
    # 这里却必须分清「标签本来不在」（404，算成功）和「删除失败」（算失败、留队重试）——
    # 否则 pending/PR 删失败也记完成，父 issue 永远挂着两个互相矛盾的状态标签。
    if ! run_gh "父 issue #$parent 加 $LABEL_PENDING_HUMAN" \
        gh_write api -X POST "repos/$REPO/issues/$parent/labels" -f "labels[]=$LABEL_PENDING_HUMAN"; then
        return 1
    fi
    local L out
    for L in "$LABEL_PENDING_PR" "$LABEL_AGENT_DOING"; do
        [ -n "$L" ] || continue
        if ! out=$(gh_write api -X DELETE "repos/$REPO/issues/$parent/labels/$(printf '%s' "$L" | jq -sRr @uri)" 2>&1); then
            if printf '%s' "$out" | grep -q 'HTTP 404'; then continue; fi
            log "  ⚠️ 父 issue #$parent 摘 $L 失败: $out"
            return 1
        fi
    done
    tmp=$(mktemp)
    jq --arg p "$parent" --argjson n "$total" '.split_rollups = ((.split_rollups // {}) + {($p): $n})' \
        "$state_file" > "$tmp" && mv "$tmp" "$state_file"
    log "  父 issue #$parent 子项全部完成（$total 个）→ $LABEL_PENDING_HUMAN"
    return 0
}

# 合并后给 PR 对应的 issue 打标签：CLOSED（Closes #N 自动关）→ Done；OPEN（Refs #N / 手开 PR）
# → pending/human 等人 triage。返回 0 = 定了；1 = 状态读不到或加标签失败，一个错标签都不留、
# 由调用方入 merged_label_queue 下轮再判。**读不到绝不能当成 OPEN**：那会给已关闭的 issue
# 打上「待人工」，而 PR 已记入 cleaned_prs，没有第二次机会纠正。
# 摘旧标签仍走 gh_label_flip 的 `|| true`（与此前行为一致：「本来就不在」是常态）。
merged_issue_label() {
    local issue="$1" prnum="${2:-?}" state
    state=$(run_gh_capture "读取 issue #$issue 状态" \
        gh api "repos/$REPO/issues/$issue" --jq .state) || return 1
    case "$state" in
        closed)
            run_gh "auto-cleanup label issue #$issue → Done" \
                gh_label_flip "$issue" \
                --add "$LABEL_DONE" \
                --remove "$LABEL_PENDING_PR" "$LABEL_PENDING_HUMAN" "${LABEL_PENDING_AGENT_DEFAULT:-}" "${LABEL_PENDING_AGENT_FABLE:-}" "${LABEL_PENDING_REVIEW:-}" "$LABEL_AGENT_DOING" || return 1
            log "  PR #$prnum → Done；issue #$issue CLOSED (Closes #N) → Done"
            ;;
        open)
            run_gh "auto-cleanup label issue #$issue → pending/human" \
                gh_label_flip "$issue" \
                --add "$LABEL_PENDING_HUMAN" \
                --remove "$LABEL_PENDING_PR" "${LABEL_PENDING_AGENT_DEFAULT:-}" "${LABEL_PENDING_AGENT_FABLE:-}" "${LABEL_PENDING_REVIEW:-}" "$LABEL_AGENT_DOING" || return 1
            log "  PR #$prnum → Done；issue #$issue OPEN (Refs #N) → pending/human"
            ;;
        *)
            log "  ⚠️ issue #$issue 状态异常（'$state'），不打标签，下轮再判"
            return 1
            ;;
    esac
}

# merged_label_queue[<issue>] = {pr, tries}；上限同 SUB_ISSUE_ROLLUP_MAX_TRIES。
merged_label_enqueue() {
    local issue="$1" prnum="$2" state_file="$3" tmp
    tmp=$(mktemp)
    jq --arg i "$issue" --arg p "$prnum" \
        '.merged_label_queue = ((.merged_label_queue // {}) + {($i): {pr: $p, tries: (((.merged_label_queue // {})[$i].tries) // 0)}})' \
        "$state_file" > "$tmp" && mv "$tmp" "$state_file"
    log "  issue #$issue 的合并后标签暂未定（状态读不到或写失败），下轮重试"
}

merged_label_drain() {
    local state_file="$1" cap="${SUB_ISSUE_ROLLUP_MAX_TRIES:-30}" issue prnum tries tmp
    for issue in $(jq -r '(.merged_label_queue // {}) | keys[]' "$state_file" 2>/dev/null); do
        [[ "$issue" =~ ^[0-9]+$ ]] || continue
        prnum=$(jq -r --arg i "$issue" '.merged_label_queue[$i].pr // "?"' "$state_file")
        tmp=$(mktemp)
        if merged_issue_label "$issue" "$prnum"; then
            jq --arg i "$issue" 'del(.merged_label_queue[$i])' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
            continue
        fi
        tries=$(jq -r --arg i "$issue" '(.merged_label_queue[$i].tries // 0) + 1' "$state_file")
        if [ "$tries" -ge "$cap" ]; then
            log "⚠️ issue #$issue 合并后标签连续 $tries 次没定下来 → 放弃（请手动给它打 Done / pending/human）"
            jq --arg i "$issue" 'del(.merged_label_queue[$i])' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
        else
            jq --arg i "$issue" --argjson n "$tries" '.merged_label_queue[$i].tries = $n' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
        fi
    done
}

# 汇总重试队列。merge 钩子只负责「入队」，每轮 poll 再「清队」：
# 汇总所需的读写发生在 PR 已记入 cleaned_prs **之后**，那个 PR 下一轮不会再被扫到；
# 要是汇总当场失败就算了，而这恰好是最后一个子项，父 issue 就永远等不到汇总。
# 队列 = state.json 的 split_rollup_queue[<子号>] = 已试次数。
# 上限 SUB_ISSUE_ROLLUP_MAX_TRIES（默认 30 轮，约半小时）：接口持续报错（比如权限被收）时
# 不能每分钟打一遍 GitHub 打到天荒地老——放弃时记日志，人从父 issue 页面的进度条也看得到。
sub_issue_rollup_enqueue() {
    local sub="$1" state_file="$2" tmp
    tmp=$(mktemp)
    jq --arg s "$sub" '.split_rollup_queue = ((.split_rollup_queue // {}) + {($s): ((.split_rollup_queue // {})[$s] // 0)})' \
        "$state_file" > "$tmp" && mv "$tmp" "$state_file"
}

sub_issue_rollup_drain() {
    local state_file="$1" cap="${SUB_ISSUE_ROLLUP_MAX_TRIES:-30}" sub tries tmp
    for sub in $(jq -r '(.split_rollup_queue // {}) | keys[]' "$state_file" 2>/dev/null); do
        [[ "$sub" =~ ^[0-9]+$ ]] || continue
        if sub_issue_rollup "$sub" "$state_file"; then
            tmp=$(mktemp)
            jq --arg s "$sub" 'del(.split_rollup_queue[$s])' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
            continue
        fi
        tries=$(jq -r --arg s "$sub" '(.split_rollup_queue[$s] // 0) + 1' "$state_file")
        tmp=$(mktemp)
        if [ "$tries" -ge "$cap" ]; then
            log "⚠️ 子 issue #$sub 的父 issue 汇总连续 $tries 次失败 → 放弃（请到父 issue 手动确认子项是否全部完成）"
            jq --arg s "$sub" 'del(.split_rollup_queue[$s])' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
        else
            log "  子 issue #$sub 的父 issue 汇总未完成（第 $tries/$cap 次），下轮重试"
            jq --arg s "$sub" --argjson n "$tries" '.split_rollup_queue[$s] = $n' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
        fi
    done
}

# ── 外部需求机器人：叫醒脚本和 daemon 共用的几步（GitHub#95 / #97）──
# 「是不是机器人提的需求」「通知 webhook」这两条规则，叫醒脚本（notify-requester-bot.sh）
# 和合并后通知（requester_bot_done_notify）各用一次，只在这里写一份。
# 读用 gh（轮询身份），写用 gh_write（与 worker 发评论同一个身份）。
# 失败原因写进 REQUESTER_BOT_REASON，调用方负责输出。

requester_bot_lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# 允许名单（逗号 / 空白分隔）里有没有这个账号
requester_bot_actor_allowed() {
    local who x arr=()
    who="$(requester_bot_lc "$1")"
    [ -n "$who" ] || return 1
    read -ra arr <<< "$(printf '%s' "$REQUESTER_BOT_ALLOWED_ACTORS" | tr ',' ' ')"
    for x in ${arr[@]+"${arr[@]}"}; do [ "$(requester_bot_lc "$x")" = "$who" ] && return 0; done
    return 1
}

# 当前写身份（gh_write）是否允许去叫醒 / 通知机器人。叫醒脚本和合并后通知在任何写请求之前
# 都先过这一关。0 = 允许，REQUESTER_BOT_ME = 登录名；1 = 读不到身份或不在名单，原因在 REQUESTER_BOT_REASON。
requester_bot_check_actor() {
    REQUESTER_BOT_ME=$(gh_write api user --jq .login 2>/dev/null) || REQUESTER_BOT_ME=""
    if [ -z "$REQUESTER_BOT_ME" ]; then
        REQUESTER_BOT_REASON="读不到当前 GitHub 账号，无法核对是否允许叫醒"
        return 1
    fi
    if ! requester_bot_actor_allowed "$REQUESTER_BOT_ME"; then
        REQUESTER_BOT_REASON="当前账号 $REQUESTER_BOT_ME 不在允许叫醒的名单里"
        return 1
    fi
    return 0
}

# 某个需求 issue 现在还有哪些打开的 PR（排除指定的那个）。关联的认法与来源判定一致：分支名
# 里的编号，或正文的 Closes/Refs #N（逐行、整段两种写法任一指向它就算，宁可多算——多算只会
# 少发一条「关闭未合并」）。输出编号（空格分隔），没有就输出空；读失败 return 1。
requester_bot_open_prs_for() {
    local issue="$1" except="$2" rows n ref body
    # 单独现读，不用本轮开头的快照（open_snapshot）：马上要往外写，要的是此刻的真值
    rows=$(gh api --paginate -X GET "repos/$REPO/pulls" -f state=open -f sort=created -f per_page=100 \
        --jq '.[] | [(.number | tostring), (.head.ref // ""), ((.body // "") | @base64)] | @tsv') || return 1
    while IFS=$'\t' read -r n ref body; do
        [ -n "$n" ] && [ "$n" != "$except" ] || continue
        body=$(printf '%s' "$body" | base64 -d 2>/dev/null || true)
        if [ "$(branch_to_issue_num "$ref")" = "$issue" ] \
           || [ "$(printf '%s' "$body" | pr_body_linked_issue)" = "$issue" ] \
           || [ "$(printf '%s' "$body" | pr_body_linked_issue_jq)" = "$issue" ]; then
            printf '%s ' "$n"
        fi
    done <<< "$rows"
    return 0
}

# 判定一条 issue / PR 是不是外部需求机器人提的需求。
#   requester_bot_item_origin <编号> <条目 JSON（GET /issues/<编号> 的返回）>
# 返回 0 = 是：REQUESTER_BOT_ORIGIN = 来源 issue 编号，REQUESTER_BOT_ORIGIN_JSON = 它的 JSON，
#          条目是 PR 时 REQUESTER_BOT_PR_JSON = GET /pulls/<编号> 的返回
#      1 = 明确不是；2 = 读不到、判不了。两种都在 REQUESTER_BOT_REASON 里写原因。
#
# PR 的来源：分支名里的 issue 编号（BRANCH_PREFIX + N）优先；没有就看正文的 Closes/Fixes/Resolves/Refs #N。
# 正文这一步用 daemon 现成的两种写法各找一次（会话命名的逐行版、活跃 worker 列表的整段版，
# 见 pr_body_linked_issue），两者一致才认；不一致（典型是关键词和编号分在两行）就算「不是」——
# 这样认定的来源永远和 daemon 给这个 PR 用的工作编号、列表上显示的关联都对得上。
# 不用 pr_to_issue_num：它找不到时兜底返回 PR 自己的编号，拿来核验会让没关联需求的 PR 放行。
# 只认标记不认作者的话，公开仓库里谁都能在正文里写这段文字，所以作者和标记都要对上。
requester_bot_item_origin() {
    local num="$1" item="$2" is_pr branch body by_line by_whole origin ojson author
    REQUESTER_BOT_ORIGIN=""; REQUESTER_BOT_ORIGIN_JSON=""; REQUESTER_BOT_PR_JSON=""; REQUESTER_BOT_REASON=""
    is_pr=$(printf '%s' "$item" | jq -r 'has("pull_request") and .pull_request != null') \
        || { REQUESTER_BOT_REASON="#$num 的内容读不懂"; return 2; }
    origin="$num"; ojson="$item"
    if [ "$is_pr" = true ]; then
        REQUESTER_BOT_PR_JSON=$(gh api "repos/$REPO/pulls/$num") \
            || { REQUESTER_BOT_REASON="读不到 PR #$num"; return 2; }
        branch=$(printf '%s' "$REQUESTER_BOT_PR_JSON" | jq -r '.head.ref // ""')
        origin=$(branch_to_issue_num "$branch")
        if [ -z "$origin" ]; then
            body=$(printf '%s' "$REQUESTER_BOT_PR_JSON" | jq -r '.body // ""')
            by_line=$(printf '%s' "$body" | pr_body_linked_issue)
            by_whole=$(printf '%s' "$body" | pr_body_linked_issue_jq)
            if [ "$by_line" != "$by_whole" ]; then
                REQUESTER_BOT_REASON="PR #$num 正文里的关联写法有歧义（逐行看是 ${by_line:-无}、整段看是 ${by_whole:-无}，常见于关键词和 #编号分在两行），认不准来自哪个需求"
                return 1
            fi
            origin="$by_line"
        fi
        case "$origin" in ''|*[!0-9]*)
            REQUESTER_BOT_REASON="PR #$num 没有关联 issue（分支名 ${branch:-?} 不带编号，正文里也没有 Closes #N 这类写法）"
            return 1 ;;
        esac
        [ "$origin" != "$num" ] || { REQUESTER_BOT_REASON="PR #$num 没有关联 issue（关联编号就是它自己）"; return 1; }
        ojson=$(gh api "repos/$REPO/issues/$origin") || { REQUESTER_BOT_REASON="读不到关联的 issue #$origin"; return 2; }
        if [ "$(printf '%s' "$ojson" | jq -r 'has("pull_request") and .pull_request != null')" != false ]; then
            REQUESTER_BOT_REASON="PR #$num 关联的 #$origin 是 PR，不是 issue"
            return 1
        fi
    fi
    author=$(printf '%s' "$ojson" | jq -r '.user.login // ""')
    if [ "$(requester_bot_lc "$author")" != "$(requester_bot_lc "$REQUESTER_BOT_ACCOUNT")" ]; then
        REQUESTER_BOT_REASON="#$origin 不是外部需求机器人提的需求（作者是 ${author:-未知}，不是 $REQUESTER_BOT_ACCOUNT）"
        return 1
    fi
    if ! printf '%s' "$ojson" | jq -e --arg m "$REQUESTER_BOT_ORIGIN_MARKER" '(.body // "") | contains($m)' >/dev/null; then
        REQUESTER_BOT_REASON="#$origin 正文里没有外部需求标记"
        return 1
    fi
    REQUESTER_BOT_ORIGIN="$origin"
    REQUESTER_BOT_ORIGIN_JSON="$ojson"
    return 0
}

# 通知外部需求机器人的 webhook（GitHub#100）：POST 一次，机器人就来仓库全量拉取挂着等待标签的
# 条目。它只是「来看看」的提示，请求体不带指令；机器人那边按自己拉到的内容办事。
#   requester_bot_webhook_notify <编号> <issue|pr>
# 结果放进 REQUESTER_BOT_WEBHOOK_RESULT（一行，调用方负责输出）；地址没配时为空、什么都不做。
# 永远 return 0：webhook 失败不算叫醒失败，机器人自己的定时扫描兜底。
#
# 地址、请求头、密钥**不进命令行**（`ps`、/proc/<pid>/cmdline 看得到）：写成 curl 配置经标准
# 输入喂给 `curl --config -`。任何输出和日志都不含这三项；curl 的错误输出丢弃（可能带地址）。
# 写进 curl 配置前：请求头名只许字母数字和 -，地址 / 密钥里有控制字符（换行能拼出额外的 curl
# 指令）一律当配置不完整；再转义 \ 和 "。
# -q 必须是第一个参数：不读用户的 ~/.curlrc（代理等设置会让同一份配置在不同机器表现不同）。
# 不跟随跳转（会把密钥头带去另一个地址），只许 http / https，10 秒上限，不重试。
# --globoff：地址按字面发。curl 默认把 [1-2]、{a,b} 当范围展开成多个请求（写在配置文本里
# 也照样展开），一次叫醒就变成多次 POST，状态码还会拼成 200200 被误记成「连接失败」。
REQUESTER_BOT_WEBHOOK_RESULT=""
requester_bot_webhook_notify() {
    local num="$1" kind="$2" mode go body conf code rc
    REQUESTER_BOT_WEBHOOK_RESULT=""
    [ -n "${REQUESTER_BOT_WEBHOOK_URL:-}" ] || return 0
    if [ -z "${REQUESTER_BOT_WEBHOOK_KEY_HEADER:-}" ] || [ -z "${REQUESTER_BOT_WEBHOOK_KEY:-}" ] \
       || ! [[ "$REQUESTER_BOT_WEBHOOK_KEY_HEADER" =~ ^[A-Za-z0-9-]+$ ]] \
       || [[ "$REQUESTER_BOT_WEBHOOK_URL" =~ [[:cntrl:]] ]] || [[ "$REQUESTER_BOT_WEBHOOK_KEY" =~ [[:cntrl:]] ]]; then
        REQUESTER_BOT_WEBHOOK_RESULT="webhook 配置不完整，跳过"
        return 0
    fi
    mode=$(file_mode_octal "$CONFIG_FILE")
    case "$mode" in
        ''|*[!0-7]*) REQUESTER_BOT_WEBHOOK_RESULT="读不到配置文件权限，webhook 跳过"; return 0 ;;
    esac
    go="00$mode"; go="${go: -2}"   # 末两位 = 组、其他人
    if [ "$go" != 00 ]; then
        REQUESTER_BOT_WEBHOOK_RESULT="配置文件权限过宽（应为 600），webhook 跳过"
        return 0
    fi
    if ! command -v curl >/dev/null 2>&1; then
        REQUESTER_BOT_WEBHOOK_RESULT="找不到 curl，webhook 跳过"
        return 0
    fi
    body=$(jq -cn --arg r "$REPO" --argjson n "$num" --arg k "$kind" '{repo: $r, number: $n, kind: $k}') \
        || { REQUESTER_BOT_WEBHOOK_RESULT="webhook 通知失败（请求体生成失败）"; return 0; }
    _rb_curl_quote() { local v="${1//\\/\\\\}"; printf '"%s"' "${v//\"/\\\"}"; }
    conf=$(printf 'url = %s\nheader = %s\n' \
        "$(_rb_curl_quote "$REQUESTER_BOT_WEBHOOK_URL")" \
        "$(_rb_curl_quote "$REQUESTER_BOT_WEBHOOK_KEY_HEADER: $REQUESTER_BOT_WEBHOOK_KEY")")
    rc=0
    code=$(printf '%s\n' "$conf" | curl -q --config - --globoff -s -o /dev/null -w '%{http_code}' \
        -X POST -H 'Content-Type: application/json' --data-binary "$body" \
        --proto =http,https --max-redirs 0 --max-time 10 2>/dev/null) || rc=$?
    if [ "$rc" -eq 0 ] && [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
        REQUESTER_BOT_WEBHOOK_RESULT="已通知 webhook（HTTP $code）"
    elif [ "$rc" -eq 0 ] && [[ "$code" =~ ^[1-9][0-9][0-9]$ ]]; then
        REQUESTER_BOT_WEBHOOK_RESULT="webhook 通知失败（HTTP $code）"
    elif [ "$rc" -eq 28 ]; then
        REQUESTER_BOT_WEBHOOK_RESULT="webhook 通知失败（超时）"
    else
        REQUESTER_BOT_WEBHOOK_RESULT="webhook 通知失败（连接失败）"
    fi
    return 0
}

# ── PR 合并 / 关闭未合并后，把结果告诉外部需求机器人（GitHub#97 Q2=A）──
# § 3 记下一个新合并的 PR（cleaned_prs）、§ 3c 记下一个关闭未合并的 PR（unmerged_prs_handled）
# 的同一时刻入队，每轮清队。入队点每个 PR 只会走到一次，所以出队后不会被再次入队。
# 「该不该发」的全部条件（是机器人的需求、PR 现状、写身份在名单里、关闭时这项需求没有别的
# PR 开着）都在 requester_bot_done_notify 里、每次尝试现查，入队处不做判断——首轮失败后
# 重试时情况可能已经变了（比如同一需求新开了 PR）。
#   requester_bot_done_queue[<PR>] = {kind: merged|closed, tries}
# 功能关闭时不入队、也不写这个字段（state.json 和以前逐字节相同）。
#
# 一次通知 = 在来源 issue 上发一条带隐藏标记的结果评论 + 给来源 issue 加等待标签（issue 可能
# 已被合并自动关闭，照样加；机器人那边会连已关闭的一起拉，转达后自己摘）+ 读回确认 + 调一次
# webhook（GitHub#100，不再重新指派）。
# 「评论发过没有」以 issue 上实际有没有本身份发的那条标记评论为准，不另记进度：评论发了、
# 加标签失败时，重试只补标签，不会重复发评论。webhook 失败只记一行，不进重试。
#
# 返回 0 = 有定论、出队（通知完成 / 不是机器人提的需求 / PR 现状和入队时不符）；
#      1 = 这次没做成，下轮再试（任何读写失败、PR 状态字段缺失、写身份不在名单）。
REQUESTER_BOT_DONE_TAG='requester-bot-done'

requester_bot_done_enqueue() {   # <PR> <merged|closed> <state_file>
    local pr="$1" kind="$2" state_file="$3" tmp
    requester_bot_enabled || return 0
    tmp=$(mktemp)
    jq --arg p "$pr" --arg k "$kind" \
        '.requester_bot_done_queue = ((.requester_bot_done_queue // {}) + {($p): {kind: $k, tries: (((.requester_bot_done_queue // {})[$p].tries) // 0)}})' \
        "$state_file" > "$tmp" && mv "$tmp" "$state_file"
}

requester_bot_done_notify() {   # <PR> <merged|closed>
    local pr="$1" kind="$2" item rc st merged origin me marks body mark
    if ! requester_bot_enabled; then
        log "  外部需求机器人功能已关闭，丢弃 PR #$pr 的结果通知"
        return 0
    fi
    item=$(gh api "repos/$REPO/issues/$pr") || { log "  读取 PR #$pr 失败，结果通知下轮再试"; return 1; }
    rc=0; requester_bot_item_origin "$pr" "$item" || rc=$?
    case "$rc" in
        0) ;;
        1) log "  PR #$pr 不来自外部需求机器人提的需求（$REQUESTER_BOT_REASON），不通知"; return 0 ;;
        *) log "  PR #$pr 判不了是否来自外部需求机器人（$REQUESTER_BOT_REASON），下轮再试"; return 1 ;;
    esac
    origin="$REQUESTER_BOT_ORIGIN"
    # 写之前按刚读到的 PR 现状核对入队时的判断：必须已关闭，合并与否和入队时一致。
    # 字段缺失 = 判不了，本轮不写。
    st=$(printf '%s' "$REQUESTER_BOT_PR_JSON" | jq -r '.state // ""')
    merged=$(printf '%s' "$REQUESTER_BOT_PR_JSON" | jq -r 'if has("merged") then (.merged | tostring) elif has("merged_at") then (.merged_at != null | tostring) else "" end')
    if [ -z "$st" ] || [ -z "$merged" ]; then
        log "  PR #$pr 现状读不全（state='$st' merged='$merged'），下轮再试"
        return 1
    fi
    case "$kind:$st:$merged" in
        merged:closed:true|closed:closed:false) ;;
        *) log "  PR #$pr 现状（$st，merged=$merged）和入队时（$kind）不符，不通知"; return 0 ;;
    esac

    # 关闭未合并：这项需求还有别的 PR 开着 = 工作在继续，不发「没有落地」。每次尝试都现查；
    # 查不到不能当成「没有」，留到下轮。
    if [ "$kind" = closed ]; then
        local others
        if ! others=$(requester_bot_open_prs_for "$origin" "$pr"); then
            log "  读不到打开的 PR 列表，PR #$pr 的关闭通知下轮再试"
            return 1
        fi
        if [ -n "$others" ]; then
            log "  需求 #$origin 还有打开的 PR（${others% }），PR #$pr 关闭不通知"
            return 0
        fi
    fi
    # 写身份必须在允许名单里，和叫醒脚本同一关（requester_bot_check_actor）
    if ! requester_bot_check_actor; then
        log "  PR #$pr 的结果通知不发：$REQUESTER_BOT_REASON（下轮再试）"
        return 1
    fi
    # 只认本身份发过的标记评论：别人在评论里写同样的文字，不能挡掉通知
    me="$REQUESTER_BOT_ME"
    marks=$(gh api --paginate "repos/$REPO/issues/$origin/comments?per_page=100" \
        --jq ".[] | select((.user.login // \"\" | ascii_downcase) == \"$(requester_bot_lc "$me")\") | (.body // \"\") | scan(\"<!-- $REQUESTER_BOT_DONE_TAG pr=[0-9]+ kind=[a-z]+ -->\")") \
        || { log "  读不到 issue #$origin 的评论，PR #$pr 的结果通知下轮再试"; return 1; }
    if [ "$kind" = closed ] && printf '%s\n' "$marks" | grep -q 'kind=merged'; then
        log "  issue #$origin 已由别的 PR 合并完成并通知过，PR #$pr 关闭不再通知"
        return 0
    fi
    mark="<!-- $REQUESTER_BOT_DONE_TAG pr=$pr kind=$kind -->"
    if ! printf '%s\n' "$marks" | grep -qxF "$mark"; then
        if [ "$kind" = merged ]; then
            body=$(printf '## 需求已完成：PR #%s 已合并\n\nPR #%s（%s）已合并进 `%s`，合并提交 `%s`。这条需求到此完成。\n\n%s\n' \
                "$pr" "$pr" "$(printf '%s' "$REQUESTER_BOT_PR_JSON" | jq -r '.title // ""')" \
                "$(printf '%s' "$REQUESTER_BOT_PR_JSON" | jq -r '.base.ref // "?"')" \
                "$(printf '%s' "$REQUESTER_BOT_PR_JSON" | jq -r '(.merge_commit_sha // "?")[0:12]')" "$mark")
        else
            body=$(printf '## PR #%s 已关闭，没有合并\n\n这条需求的改动没有落地。后续是否继续，由维护者决定。\n\n%s\n' "$pr" "$mark")
        fi
        run_gh "issue #$origin 发 PR #$pr 的结果评论" \
            gh_write api -X POST "repos/$REPO/issues/$origin/comments" -f "body=$body" || return 1
    fi
    if ! gh_write api -X POST "repos/$REPO/issues/$origin/labels" -f "labels[]=$LABEL_PENDING_REQUESTER_BOT" >/dev/null 2>&1; then
        log "  issue #$origin 加等待标签 $LABEL_PENDING_REQUESTER_BOT 失败，PR #$pr 的结果通知下轮重试"
        return 1
    fi
    local labels
    if ! labels=$(gh api "repos/$REPO/issues/$origin" --jq '.labels[].name'); then
        log "  issue #$origin 加等待标签后读回失败，PR #$pr 的结果通知下轮重试"
        return 1
    fi
    if ! printf '%s\n' "$labels" | grep -qxF "$LABEL_PENDING_REQUESTER_BOT"; then
        log "  issue #$origin 读回没有等待标签 $LABEL_PENDING_REQUESTER_BOT，PR #$pr 的结果通知下轮重试"
        return 1
    fi
    log "  ✅ 已把 PR #$pr 的结果（$kind）告诉 $REQUESTER_BOT_ACCOUNT：issue #$origin 留了评论并挂上等待标签"
    requester_bot_webhook_notify "$origin" issue
    [ -z "$REQUESTER_BOT_WEBHOOK_RESULT" ] || log "  issue #$origin：$REQUESTER_BOT_WEBHOOK_RESULT"
    return 0
}

requester_bot_done_drain() {   # <state_file>
    local state_file="$1" cap="${SUB_ISSUE_ROLLUP_MAX_TRIES:-30}" pr kind tries tmp
    for pr in $(jq -r '(.requester_bot_done_queue // {}) | keys[]' "$state_file" 2>/dev/null); do
        [[ "$pr" =~ ^[0-9]+$ ]] || continue
        kind=$(jq -r --arg p "$pr" '.requester_bot_done_queue[$p].kind // ""' "$state_file")
        tmp=$(mktemp)
        if requester_bot_done_notify "$pr" "$kind"; then
            jq --arg p "$pr" 'del(.requester_bot_done_queue[$p])' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
            continue
        fi
        tries=$(jq -r --arg p "$pr" '(.requester_bot_done_queue[$p].tries // 0) + 1' "$state_file")
        if [ "$tries" -ge "$cap" ]; then
            log "⚠️ PR #$pr 的结果连续 $tries 次没能告诉外部需求机器人 → 放弃（请手动在来源 issue 上通知它）"
            jq --arg p "$pr" 'del(.requester_bot_done_queue[$p])' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
        else
            jq --arg p "$pr" --argjson n "$tries" '.requester_bot_done_queue[$p].tries = $n' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
        fi
    done
}

# ── 等人审的 PR 与目标分支冲突（GitHub#86，Q1=B + 「只对 2 天内有更新的自动解」）──
# PR 挂着 pending/human 等人审期间，别的 PR 合进目标分支，它就可能变成冲突，人打开时
# 合并按钮已经灰了。这里在每轮轮询里发现它：最近有更新的交回 worker 去解（翻回
# pending/agent），久没人碰的只留一条提醒，标签不动。
#
# 调用量是这一段设计的全部约束：只在「目标分支最新提交 或 PR 自己的提交」变了的那一轮
# 才判，其余轮次一次都不多。
#   · 目标分支最新提交用 `git ls-remote` 取，走 git 协议，不占 REST 额度；
#   · state.json 的 pr_conflict[<PR>] 记着「上次是在哪对 目标分支提交/PR 提交 上判定的」，
#     同一对已有结论就不再判；
#   · 已经处理过（发过提醒 / 交回 worker）的那个 PR 提交，之后无论目标分支再动多少次
#     都不再判，直到 PR 被推了新提交。
#
# 判定在本机用 git 试合并，**不用** GitHub 的 mergeable 字段。设计时本打算用它，实测
# 推翻了：tutor PR #571 的 mergeable=true / clean 是拿三版之前的 main 算的（试合并
# 提交的父提交是 e98338a，当时 main 已到 1207fdc），连问 4 次、隔 80 秒都不重算。
# 用它就只能二选一：采信过期结论（冲突被盖掉），或永远「还不知道」（冲突永远发现不了）。
# 判法与 worker 交出 PR 前那段冲突检查（GitHub#82，三份指令模板里的同一段命令）一致：
# `git merge-tree --write-tree`，退出码 0 = 干净；1 且首行是树对象 id = 冲突；其余 = 检查失败。
# 只把对象拉进主 checkout 的对象库（--no-write-fetch-head、不写任何引用、不动工作区）。
#
# 「查不到」绝不等于「没冲突」：拉取失败、对象不在、merge-tree 报错一律算「还不知道」，
# 下轮再判，同一对最多判 PENDING_HUMAN_CONFLICT_MAX_TRIES 次。

# 输出 clean / conflict / unknown。$1 = PR 编号，$2 = 目标分支名，$3 = 目标分支当前提交，
# $4 = 快照里看到的 PR 提交。
pr_conflict_verdict() {
    local num="$1" base="$2" tip="$3" head="$4" out rc=0 line
    # --refmap= 关掉 git 的「顺手更新 origin/<分支>」：不加的话 `fetch origin refs/heads/main`
    # 会悄悄挪动主 checkout 的 origin/main（负对照实测出来的）。
    if ! out=$(git -C "$PROJECT_ROOT" fetch -q --no-write-fetch-head --refmap= origin \
            "refs/heads/$base" "refs/pull/$num/head" 2>&1); then
        log "  ⚠️ PR #$num: 拉取 $base 与 PR 提交失败，本轮判不了冲突:"
        while IFS= read -r line; do [ -n "$line" ] && log "    $line"; done <<< "$out"
        echo unknown; return 0
    fi
    # 快照之后 PR 被强推、旧提交已不可达 → 下轮按新提交重来
    if ! git -C "$PROJECT_ROOT" cat-file -e "$tip^{commit}" 2>/dev/null \
       || ! git -C "$PROJECT_ROOT" cat-file -e "$head^{commit}" 2>/dev/null; then
        echo unknown; return 0
    fi
    out=$(git -C "$PROJECT_ROOT" merge-tree --write-tree --name-only "$head" "$tip" 2>&1) || rc=$?
    if [ "$rc" -eq 0 ]; then
        echo clean
    elif [ "$rc" -eq 1 ] && head -1 <<< "$out" | grep -qE '^[0-9a-f]{40}([0-9a-f]{24})?$'; then
        echo conflict
    else
        log "  ⚠️ PR #$num: git merge-tree 退出码 $rc，本轮判不了冲突:"
        while IFS= read -r line; do [ -n "$line" ] && log "    $line"; done <<< "$out"
        echo unknown
    fi
}

# 目标分支名 → 最新提交，每行 "<分支>\t<提交>"。只认 refs/heads/<分支> 的**整名**
# （ls-remote 的模式是按尾部匹配的，refs/heads/x/main 也会被 main 匹配上）。
# 失败返回非 0，什么都不输出——调用方必须把它当「本轮不查」，不能当「没变」。
pr_conflict_base_tips() {
    local out rc=0 b sha ref line
    [ $# -gt 0 ] || return 0
    local -a pats=()
    for b in "$@"; do pats+=("refs/heads/$b"); done
    out=$(git -C "$PROJECT_ROOT" ls-remote origin "${pats[@]}" 2>&1) || rc=$?
    if [ "$rc" -ne 0 ]; then
        log "  ⚠️ 取目标分支最新提交失败（git ls-remote 退出码 $rc），本轮不查等人 PR 的冲突:"
        while IFS= read -r line; do [ -n "$line" ] && log "    $line"; done <<< "$out"
        return 1
    fi
    while IFS=$'\t' read -r sha ref; do
        for b in "$@"; do
            [ "$ref" = "refs/heads/$b" ] && [[ "$sha" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] && printf '%s\t%s\n' "$b" "$sha"
        done
    done <<< "$out"
    return 0
}

# 交回 worker 时打哪个触发 label：这条活上次是被普通 / fable / 追加 label 派出去的就
# 沿用它（别把 fable 的活交给默认模型）；上次是复审（pending/review）或没记录 → 默认。
pr_conflict_return_label() {
    local issue_n="$1" state_file="$2" L t
    L=$(jq -r --arg k "$issue_n" '.worker_trigger_labels[$k] // ""' "$state_file" 2>/dev/null) || L=""
    if [ -n "$L" ] && [ "$L" != "${LABEL_PENDING_REVIEW:-}" ]; then
        [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
        for t in "${TRIGGER_LABELS_ALL[@]}"; do
            [ "$t" = "$L" ] && { printf '%s\n' "$L"; return 0; }
        done
    fi
    printf '%s\n' "$LABEL_PENDING_AGENT_DEFAULT"
}

# 一条 label 逗号串里有没有「别人正在处理」的标记：doing/agent 或任何触发 label
# （含 pending/review —— 复审轮次烧光的条目同时挂着 pending/review + pending/human，
# 那是在等人拍板复审分歧，不该被这里塞回 worker）。
pr_conflict_labels_busy() {
    local csv=",$1," t
    case "$csv" in *",$LABEL_AGENT_DOING,"*) return 0 ;; esac
    [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
    for t in "${TRIGGER_LABELS_ALL[@]}"; do
        case "$csv" in *",$t,"*) return 0 ;; esac
    done
    return 1
}

pr_conflict_state_set() {   # <state_file> <pr> <jq 表达式，作用于该条目 .>
    local tmp
    tmp=$(mktemp)
    jq --arg p "$2" ".pr_conflict[\$p] = ((.pr_conflict[\$p] // {}) | $3)" "$1" > "$tmp" && mv "$tmp" "$1"
}

# 同一对提交上又一次没判成：计数，到上限就放弃这一对（目标分支或 PR 再动才重来），
# 免得一个一直拉不下来的 PR 让每一轮都多一次拉取 / 调用。
pr_conflict_bump_tries() {   # <state_file> <pr> <cap> <原因>
    local tries
    tries=$(( $(jq -r --arg p "$2" '.pr_conflict[$p].tries // 0' "$1") + 1 ))
    if [ "$tries" -ge "$3" ]; then
        pr_conflict_state_set "$1" "$2" ".tries = $tries | .done = \"gaveup\""
        log "PR #$2: 连续 $tries 轮${4}，这一版先不查了"
    else
        pr_conflict_state_set "$1" "$2" ".tries = $tries"
    fi
}

# 每轮调一次。返回 0；真动了 GitHub（发评论 / 翻标签）时把 PR_CONFLICT_ACTED 置 1。
pending_human_conflict_tick() {
    local state_file="$1" pages rows bases tips
    local num head base fork tip key st_key st_done st_acted pr_json verdict
    local labels_csv updated recent days cap ret_label marker body host st_flip existing next_step
    PR_CONFLICT_ACTED=0
    [ "${PENDING_HUMAN_CONFLICT_CHECK:-true}" = "true" ] || return 0
    days="${PENDING_HUMAN_CONFLICT_AUTOFIX_DAYS:-2}"
    [[ "$days" =~ ^[0-9]+$ ]] || days=2
    cap="${PENDING_HUMAN_CONFLICT_MAX_TRIES:-10}"
    [[ "$cap" =~ ^[0-9]+$ ]] && [ "$cap" -gt 0 ] || cap=10

    pages=$(open_snapshot pulls) || return 0
    # 已关闭 / 已合并的 PR 不再需要记录
    # 只把编号传进去：整份快照当 --argjson 参数会撞「参数列表过长」
    local tmp open_nums
    if open_nums=$(printf '%s' "$pages" | jq -c '[ .[][] | .number | tostring ]' 2>/dev/null); then
        tmp=$(mktemp)
        if jq --argjson open "$open_nums" '
            .pr_conflict = ((.pr_conflict // {}) | with_entries(select(.key as $k | $open | index($k))))' \
            "$state_file" > "$tmp" 2>/dev/null; then mv "$tmp" "$state_file"; else rm -f "$tmp"; fi
    fi

    rows=$(printf '%s' "$pages" | jq -r --arg H "$LABEL_PENDING_HUMAN" --arg R "$REPO" '
        .[][] | select(any(.labels[]?; .name == $H))
        | [ (.number|tostring), (.head.sha // ""), (.base.ref // ""),
            (if ((.head.repo.full_name // "") | ascii_downcase) == ($R | ascii_downcase) then "same" else "fork" end),
            ([.labels[]?.name] | join(",")) ] | @tsv') || return 0
    [ -n "$rows" ] || return 0

    # 先在本地把「这轮根本不用问」的筛掉，剩下的才去取目标分支提交 —— 全部已处理时连
    # ls-remote 都不发。
    local -a todo=()
    while IFS=$'\t' read -r num head base fork labels_csv; do
        [ -n "$num" ] && [ -n "$head" ] && [ -n "$base" ] || continue
        pr_conflict_labels_busy "$labels_csv" && continue
        st_acted=$(jq -r --arg p "$num" '.pr_conflict[$p].acted_head // ""' "$state_file")
        [ "$st_acted" = "$head" ] && continue
        todo+=("$num"$'\t'"$head"$'\t'"$base"$'\t'"$fork")
    done <<< "$rows"
    [ ${#todo[@]} -gt 0 ] || return 0

    bases=$(printf '%s\n' "${todo[@]}" | cut -f3 | awk 'NF && !seen[$0]++')
    # shellcheck disable=SC2086
    tips=$(pr_conflict_base_tips $bases) || return 0

    local row
    for row in "${todo[@]}"; do
        IFS=$'\t' read -r num head base fork <<< "$row"
        ret_label=""
        tip=$(printf '%s\n' "$tips" | awk -F'\t' -v b="$base" '$1 == b { print $2; exit }')
        if [ -z "$tip" ]; then
            log_debug "PR #$num: 目标分支 $base 在远端找不到，跳过冲突检查"
            continue
        fi
        key="$tip $head"
        st_key=$(jq -r --arg p "$num" '.pr_conflict[$p].key // ""' "$state_file")
        st_done=$(jq -r --arg p "$num" '.pr_conflict[$p].done // ""' "$state_file")
        [ "$st_key" = "$key" ] && [ -n "$st_done" ] && continue
        if [ "$st_key" != "$key" ]; then
            pr_conflict_state_set "$state_file" "$num" ".key = \"$key\" | .tries = 0 | .done = \"\""
        fi

        verdict=$(pr_conflict_verdict "$num" "$base" "$tip" "$head")
        case "$verdict" in
            clean)
                pr_conflict_state_set "$state_file" "$num" '.done = "clean"'
                log_debug "PR #$num: 与 $base 无冲突（${tip:0:7} + ${head:0:7}）"
                continue ;;
            conflict) ;;
            *) pr_conflict_bump_tries "$state_file" "$num" "$cap" "判不出能否与 $base 合并"; continue ;;
        esac

        # 要往 GitHub 写了：现读一次这个 PR。快照是本轮开头的，从那以后它可能已经被关掉 /
        # 合并、改投了别的目标分支、被推了新提交、被人改了标签。下面要用到的每一项身份
        # （开着、目标分支、PR 提交、是不是外部仓库）都拿现读的值和这次判定用的那份逐项核对，
        # 缺字段也算对不上：对不上就本轮跳过、不记为已处理，下轮按新情况重新判。
        # 标签挡不住「已关闭」：关掉的 PR 照样留着 pending/human。
        if ! pr_json=$(gh api "repos/$REPO/pulls/$num" 2>/dev/null) || [ -z "$pr_json" ]; then
            log "  ⚠️ 读取 PR #$num 失败，本轮不处理它的冲突"
            pr_conflict_bump_tries "$state_file" "$num" "$cap" "读不到 PR"
            continue
        fi
        if ! printf '%s' "$pr_json" | jq -e --arg h "$head" --arg b "$base" --arg f "$fork" --arg R "$REPO" '
            .state == "open" and (.merged // false) == false
            and .head.sha == $h and .base.ref == $b
            and ((if ((.head.repo.full_name // "") | ascii_downcase) == ($R | ascii_downcase) then "same" else "fork" end) == $f)' \
            >/dev/null 2>&1; then
            log "PR #$num: 判定之后它已关闭 / 改了目标分支 / 有新提交，本轮不处理，下轮按现状重新判"
            # 计一次：正常情况下轮快照就变了（换了一对提交，计数归零）；万一 GitHub
            # 一直返回对不上的东西，也不会每轮都多拉一次、问一次
            pr_conflict_bump_tries "$state_file" "$num" "$cap" "现读的 PR 与判定时对不上"
            continue
        fi
        labels_csv=$(printf '%s' "$pr_json" | jq -r '[.labels[]?.name] | join(",")' 2>/dev/null) || labels_csv=""
        case ",$labels_csv," in
            *",$LABEL_PENDING_HUMAN,"*) ;;
            *) continue ;;
        esac
        pr_conflict_labels_busy "$labels_csv" && continue

        # ── 冲突 ──
        updated=$(printf '%s' "$pr_json" | jq -r '.updated_at // ""')
        recent=0
        if [ "$days" -gt 0 ] && [ "$fork" = same ] && [ -n "$updated" ] \
           && printf '%s' "$updated" | jq -Re --argjson d "$days" 'fromdateiso8601 >= (now - $d * 86400)' >/dev/null 2>&1; then
            recent=1
        fi
        # 两种评论各带各的标记。分开是因为「只提醒」那条评论本身会刷新 PR 的更新时间：
        # 状态文件丢了的话，下一轮这个 PR 就成了「最近有更新」，若共用一个标记，会被
        # 当成「交回 worker 的评论已发、只差翻标签」，静默升级成自动改代码。
        marker_worker="<!-- cavil-loop:pending-human-conflict head=$head mode=worker -->"
        marker_remind="<!-- cavil-loop:pending-human-conflict head=$head mode=remind -->"
        host="$(hostname -s 2>/dev/null || hostname)"
        # 同一个 PR 提交只说一次：评论里已有标记（上一轮发了评论但翻标签失败，
        # 或者另一台机器先处理了）就不再发。读不到评论 → 本轮不动，下轮再来。
        if ! existing=$(gh api --paginate "repos/$REPO/issues/$num/comments" --jq '.[].body' 2>/dev/null); then
            log "  ⚠️ 读取 PR #$num 的评论失败，本轮不处理它的冲突"
            continue
        fi
        st_flip=$(jq -r --arg p "$num" '.pr_conflict[$p].flip_pending // ""' "$state_file")
        if [ "$st_flip" = "$head" ] && printf '%s' "$existing" | grep -qF "$marker_worker"; then
            # 本机上一轮发了「交回 worker」的评论但翻标签失败：只补翻标签
            recent=1
        elif printf '%s' "$existing" | grep -qF "$marker_worker" \
             || printf '%s' "$existing" | grep -qF "$marker_remind"; then
            # 这个提交已经被处理过（本机状态丢了，或另一台机器先处理了）。交回过 worker
            # 而它又回到 pending/human、提交没变 = worker 自己没解开、已经交人，
            # 再交一次就是两台机器轮流把它塞回去的死循环。
            pr_conflict_state_set "$state_file" "$num" ".done = \"conflict\" | .acted_head = \"$head\""
            log "PR #$num: 这个提交的冲突已经处理过（评论里有标记），不再重复"
            continue
        else
            if [ "$recent" = 1 ]; then
                marker="$marker_worker"
                ret_label=$(pr_conflict_return_label "$(pr_to_issue_num "$num" "$(printf '%s' "$pr_json" | jq -r '.head.ref // ""')")" "$state_file")
                body="$(printf '⚠️ **与 `%s` 有冲突，已交回 worker 去解决**\n\n这个 PR 在等人审（`%s`）期间，`%s` 进了新提交，GitHub 显示它现在与 `%s` 冲突、不能直接合并。它最近 %s 天内有更新，所以已把标签改成 `%s`：worker 会把 `%s` 合进本分支、解决冲突、跑测试并推送，完成后照常交回。\n\n不想让 worker 动它：在下一轮派工（约 1 分钟）之前把 `%s` 换回 `%s`。\n\n**给 worker**：把 `%s` 合进本分支并解决冲突（按指令里「交出 PR 前：先查和主干有没有冲突」那一节处理），本轮不做别的改动。\n\n<sub>cavil-loop daemon @ %s 自动留言</sub>\n%s' \
                    "$base" "$LABEL_PENDING_HUMAN" "$base" "$base" "$days" "$ret_label" "$base" \
                    "$ret_label" "$LABEL_PENDING_HUMAN" "$base" "$host" "$marker")"
            else
                marker="$marker_remind"
                if [ "$fork" = same ]; then
                    next_step="要让 worker 把 \`$base\` 合进来并解决冲突：把标签改成 \`$LABEL_PENDING_AGENT_DEFAULT\`。"
                    [ "$days" -gt 0 ] && body="它超过 ${days} 天没有更新" || body="本项目关闭了自动解冲突"
                else
                    next_step="需要 PR 作者在自己的仓库里把 \`$base\` 合进来并解决冲突。"
                    body="它来自外部仓库，worker 推不上去"
                fi
                body="$(printf '⚠️ **与 `%s` 有冲突**\n\n这个 PR 在等人审（`%s`）期间，`%s` 进了新提交，GitHub 显示它现在与 `%s` 冲突、不能直接合并。%s，daemon 不自动处理，标签保持不变。\n\n%s\n\n<sub>cavil-loop daemon @ %s 自动留言</sub>\n%s' \
                    "$base" "$LABEL_PENDING_HUMAN" "$base" "$base" "$body" "$next_step" "$host" "$marker")"
            fi
            if ! run_gh "冲突提醒评论 (PR #$num)" \
                gh_write api -X POST "repos/$REPO/issues/$num/comments" -f "body=$body"; then
                continue    # 下轮重来；评论没发出去之前不翻标签
            fi
            PR_CONFLICT_ACTED=1
            if [ "$recent" = 1 ]; then
                pr_conflict_state_set "$state_file" "$num" ".flip_pending = \"$head\""
            fi
        fi
        if [ "$recent" = 1 ]; then
            [ -n "${ret_label:-}" ] || ret_label=$(pr_conflict_return_label "$(pr_to_issue_num "$num" "$(printf '%s' "$pr_json" | jq -r '.head.ref // ""')")" "$state_file")
            if ! run_gh "label 翻转 (PR #$num 与 $base 冲突 → $ret_label)" \
                gh_label_flip "$num" --add "$ret_label" --remove "$LABEL_PENDING_HUMAN"; then
                continue    # 下轮重来：评论已有标记不会重发，只补翻标签
            fi
            PR_CONFLICT_ACTED=1
            log "PR #$num 与 $base 冲突（最近 ${days} 天内有更新）→ 交回 worker：$LABEL_PENDING_HUMAN → $ret_label"
        else
            log "PR #$num 与 $base 冲突（$( [ "$fork" = same ] && echo "超过 ${days} 天没更新" || echo "外部仓库" )）→ 只留提醒，标签不动"
        fi
        pr_conflict_state_set "$state_file" "$num" ".done = \"conflict\" | .acted_head = \"$head\" | del(.flip_pending)"
        ret_label=""
    done
    return 0
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

    if ! tmux set-option -t "$sess" @worker_role "$WORKER_SESSION_ROLE" 2>&1 | \
        sed 's/^/  [tmux] /' | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 设置 tmux session $sess 的 @worker_role 失败（worker 继续运行）"
    fi

    if ! tmux bind-key -T prefix s choose-tree -Zs -F "$tree_format" 2>&1 | \
        sed 's/^/  [tmux] /' | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 配置 tmux prefix+s session 列表失败（worker 继续运行）"
    fi
}

# 返回 0 表示现有 session 已使用本次 dispatch 要求的 worker、模型和角色。老 session
# 没有元数据时按项目默认 worker + 默认模型 + worker 角色处理，所以普通 pending/agent
# 不会无故重启。
#
# 角色必须参与比对：不比的话，review 关卡会被当成「同一个 worker」而把 prompt 直接
# 注入 worker 那条活着的会话里，复审就继承了 worker 的全部上下文（本函数是唯一挡得住
# 这条路径的地方——注入不经过 agent_command_new/resume）。
# 本功能上线前起的 session 没有 @worker_role，按 worker 处理；于是升级后第一次派
# review 会重启一次 session 切到 review 角色，属预期内的一次性重启。
tmux_session_matches_worker() {
    local sess="$1"
    local actual_agent actual_model actual_role
    actual_agent="$(tmux show-options -qv -t "$sess" @worker_agent 2>/dev/null || true)"
    actual_model="$(tmux show-options -qv -t "$sess" @worker_model 2>/dev/null || true)"
    actual_role="$(tmux show-options -qv -t "$sess" @worker_role 2>/dev/null || true)"
    [ -n "$actual_agent" ] || actual_agent="$WORKER_AGENT_DEFAULT"
    [ -n "$actual_role" ] || actual_role="worker"
    [ "$actual_agent" = "$WORKER_AGENT" ] && [ "$actual_model" = "$WORKER_MODEL" ] && \
        [ "$actual_role" = "$WORKER_SESSION_ROLE" ]
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

# 列表端点里最后一条的 id（取不到就 0），永远只输出一行。
#
# 别写 `gh api --paginate <ep> --jq '.[-1].id'`：--paginate 下 --jq 是**逐页**跑的，
# 超过 100 条（一页）就每页各吐一个 id，变量成了多行。实测 GigleTutor-Web#1150
# （105 条评论）：prompt 文件名带上换行，driver 的 `"$(cat <路径>)"` 被切成两条命令，
# 越过 100 条之后连续四次派工 agent 拿到的都是空 prompt；同一个值写 seen_* 时 jq
# 语法错，已读位置也推不动。这里让每页输出该页最后一条，再只留最后一页的那一行。
gh_last_id() {   # <endpoint>
    local id
    id=$(gh api --paginate "$1" --jq '.[-1].id // empty' 2>/dev/null | tail -n1) || id=""
    printf '%s\n' "${id:-0}"
}

# run_gh 的孪生，给 git 用。**dispatch 脚本里的 git 一律走它**，别写
# `git ... 2>&1 | tail -N`，也别 `2>/dev/null || log "失败"`。
#
# 为什么非它不可（实测）：_lib.sh 顶部那句 `exec 9>&- 2>/dev/null` 是**永久**重定向
# （exec 不带命令时所有重定向都是永久的），所以每个 source 过本文件的脚本——包括
# agent-poll.sh 自己和全部 dispatch 脚本——fd 2 从此就是 /dev/null。git 写在 stderr
# 上的 `fatal:` 直接蒸发，既不进 poll.log 也不进 journal。
# 2026-09-18 那次排查之所以要翻 journal 才找到原因，唯一的原因是当时那行写了
# `2>&1`，把 stderr 转成了 stdout；把 `2>&1` 删掉，原因会彻底消失。
# 这里显式把 `2>&1` 收进变量，再经 log() 的 tee 写进 poll.log——那是唯一能穿过
# 那个 /dev/null 的通道。
#
# 只在失败时打，且**逐行**打、不截断：成功时一个字都不输出（日常噪音不变），失败时
# 真正有用的那行不保证落在最后两行里（`| tail -2` 正是上次「看不见原因」的来源）。
run_git() {
    local desc="$1"; shift
    local out line
    if ! out=$("$@" 2>&1); then
        log "  ⚠️ ${desc}失败:"
        while IFS= read -r line; do
            [ -n "$line" ] && log "    $line"
        done <<< "$out"
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
        gh_write api -X DELETE "repos/$REPO/issues/$num/labels/$encoded" >/dev/null 2>&1 || true
    done

    # add
    if [ ${#adds[@]} -gt 0 ]; then
        local args=()
        for L in "${adds[@]}"; do
            args+=(-f "labels[]=$L")
        done
        gh_write api -X POST "repos/$REPO/issues/$num/labels" "${args[@]}" >/dev/null 2>&1 || return 1
    fi
    return 0
}

# daemon 自己把活转人工（翻 $LABEL_PENDING_HUMAN）时，先在 issue / PR 上留一条评论。
# 只翻 label 不说话的话，看 issue 的人只看到标签变了，既不知道出了什么事也不知道该干什么
# ——原因只写在本机 poll.log 里，而没人会去翻 poll.log（tutor PR #959：留言「解一下冲突」
# 后一秒被翻回 pending/human，页面上零解释）。
# 用法：notify_bounced_to_human <num> <原因（一句话，可含 markdown）> <怎么继续>
# 评论失败只记日志、不挡后面的 label 翻转：说明丢了是体验问题，label 不翻会重新热循环。
notify_bounced_to_human() {
    local num="$1" reason="$2" next="$3" body
    body="$(printf '⚠️ **自动处理已暂停，转人工（`%s`）**\n\n**原因**：%s\n\n**怎么继续**：%s\n\n<sub>cavil-loop daemon @ %s 自动留言</sub>' \
        "$LABEL_PENDING_HUMAN" "$reason" "$next" "$(hostname -s 2>/dev/null || hostname)")"
    run_gh "转人工说明评论 (#$num)" \
        gh_write api -X POST "repos/$REPO/issues/$num/comments" -f "body=$body" || true
}

# ── 主 checkout 长期落后的告警 ──
# sync_project_checkout 的三条保护（不在 base / 有 WIP / 分叉）都是有意的：daemon
# 绝不碰人的工作区。代价是它们只写 poll.log —— 而没人会去翻 poll.log。实测过一次：
# 主 checkout 因 8 个未提交文件卡在原地 9 天、1523 次派工全被挡，期间零外部信号。
# 这里补上信号：本地 base 落后 origin/base 超过阈值就开一个 issue，跟上后自动关。
#
# 为什么比较 refs/heads/<base> 而不是 HEAD：主 checkout 常年停在别的分支上（那是
# 有意的设计），在 feature 分支上「落后 origin/main」是常态、不是故障。真正要盯的
# 是**本地 base 分支**离远端有多远 —— 人在主 checkout 上看到的、以及 §1 兜底读不到
# 远端时回落的，都是它。
#
# **默认关闭（0）**，要的项目在自己 config 里设个数字才开。为什么不默认开：会被卡住
# 的只有「人经常上手动的」那个主 checkout —— 纯自动跑的项目根本不会有人在上面留
# WIP 或切走分支，给它们默认开一个永不触发的检查只是噪音，何况告警要往仓库里开
# issue，不该是装上框架就自动获得的行为。
#
# 开出来的 issue 挂 $LABEL_PENDING_HUMAN：
#   · label 模式下它不是触发 label，本来就不会被派工；
#   · greedy 模式下**所有开着的 issue 都会被派**，只有挡工 label 拦得住它（见
#     greedy_skip_label_list）。不挂就会被 worker 捡去「修」—— 而这条 issue 讲的是
#     本机 checkout 状态，agent 在 worktree 里根本改不动，纯属白烧一轮。
# 语义上也正是 pending/human：commit 掉 WIP / 切回分支 / rebase 只能人来做。
CHECKOUT_STALE_ALERT_COMMITS="${CHECKOUT_STALE_ALERT_COMMITS:-0}"
CHECKOUT_STALE_ALERT_TITLE="${CHECKOUT_STALE_ALERT_TITLE:-[daemon] 主 checkout 长期落后 origin}"

# 已开告警的 issue 号记在这里：每个 poll 周期都去 GitHub 查一次「有没有开过」既费
# 配额又慢，本地标记足够（丢了最多重开一个，不会漏报）。
checkout_stale_marker() { printf '%s\n' "$STATE_DIR/checkout-stale-alert"; }

checkout_stale_alert_open() {
    local base="$1" behind="$2" reason="$3"
    local marker num body
    marker=$(checkout_stale_marker)
    if [ -s "$marker" ]; then
        log_debug "checkout_stale_alert: 已有告警 issue #$(cat "$marker")，不重开"
        return 0
    fi

    body="主 checkout 的本地 \`$base\` 已落后 \`origin/$base\` **${behind} 个 commit**，daemon 每轮派工前都试着 ff-only 同步，但一直没能动手。

**这轮没同步的原因**：${reason}

**daemon 看到的现场**

| 项 | 值 |
| --- | --- |
| 主 checkout | \`${PROJECT_ROOT}\` |
| 本地 \`$base\` | \`$(git -C "$PROJECT_ROOT" log -1 --format='%h %s' "refs/heads/$base" 2>/dev/null | head -c 100)\` |
| \`origin/$base\` | \`$(git -C "$PROJECT_ROOT" log -1 --format='%h %s' "origin/$base" 2>/dev/null | head -c 100)\` |
| 落后 | ${behind} commit |

**影响范围**：派工 prompt 本身**不受影响** —— find_project_prompt_file 把 \`origin/$base\` 当唯一真值直读远端，主 checkout 再旧也拿得到最新模板（GigleTutor-Web#516 的结构性修复）。真正受影响的是：你在主 checkout 上手工看到的代码是旧的，以及任何直接读工作区文件的流程（如常驻「最新站」刷新）。

**怎么解掉**：到主 checkout 里按现场选一种 —— 有 WIP 就 commit 掉或 \`git stash -u\`；停在别的分支就切回 \`$base\`；本地分叉就 rebase。之后 daemon 下一轮会自己 ff 上来。

---
这个 issue 由 daemon 自动开，主 checkout 跟上后会自动关闭，不用手动处理。"

    num=$(run_gh_capture "开主 checkout 落后告警 issue" \
        gh_write api -X POST "repos/$REPO/issues" \
        -f "title=$CHECKOUT_STALE_ALERT_TITLE（落后 ${behind} commit）" \
        -f "body=$body" \
        -f "labels[]=${LABEL_PENDING_HUMAN:-pending/human}" --jq '.number') || return 0
    case "$num" in ''|*[!0-9]*) return 0 ;; esac
    printf '%s\n' "$num" > "$marker"
    log "checkout_stale_alert: 本地 $base 落后 ${behind} commit（${reason}），已开 issue #$num"
    return 0
}

checkout_stale_alert_resolve() {
    local marker num
    marker=$(checkout_stale_marker)
    [ -s "$marker" ] || return 0
    num=$(cat "$marker")
    # 关不掉（已被人手动关掉 / 删了）也照样清标记：留着只会让下次真出问题时不告警。
    run_gh "关闭主 checkout 落后告警 #$num" \
        gh_write api -X PATCH "repos/$REPO/issues/$num" -f state=closed || true
    rm -f "$marker"
    log "checkout_stale_alert: 主 checkout 已跟上，关闭告警 issue #$num"
    return 0
}

# 落后超阈值 → 告警；已跟上 → 关掉旧告警。任何异常都只 return 0，派工不受影响。
check_checkout_staleness() {
    local base="$1" reason="$2"
    local threshold="${CHECKOUT_STALE_ALERT_COMMITS:-0}" behind
    case "$threshold" in ''|*[!0-9]*) return 0 ;; esac
    [ "$threshold" -gt 0 ] || return 0
    behind=$(git -C "$PROJECT_ROOT" rev-list --count "refs/heads/$base..origin/$base" 2>/dev/null || echo "")
    case "$behind" in ''|*[!0-9]*) return 0 ;; esac
    if [ "$behind" -ge "$threshold" ]; then
        checkout_stale_alert_open "$base" "$behind" "$reason"
    else
        checkout_stale_alert_resolve
    fi
    return 0
}

# ── 派工前同步主 checkout（GigleTutor-Web#516）──
# 主 checkout 是 prompt 模板 / 项目脚本的读取源；它落后 origin 时 daemon 会拿旧模板
# 渲染派工 prompt（#516 根因：主 checkout 落后 74 commit，#506 的 stale-e2e 分流段
# 从未进过 prompt）。本函数只在「当前在 base 分支 + 工作区干净」时 ff-only 前进；
# 有 WIP / 在别的分支绝不碰工作区（find_prompt_template 会走 origin/<base> 直读兜底）。
# 任何失败都只 log 不报错——离线时派工不能被 fetch 卡死。
# 三条「不动工作区」的路径都会过 check_checkout_staleness：不动是对的，但长期不动
# 得让人知道。
sync_project_checkout() {
    local base="${BASE_BRANCH:-main}"
    if ! git -C "$PROJECT_ROOT" fetch origin "$base" --quiet 2>/dev/null; then
        # 离线时 origin/<base> 是旧的，落后数不可信，这轮不判断 staleness。
        log "sync_project_checkout: fetch origin/$base 失败（离线?），跳过"
        return 0
    fi
    local cur
    cur=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    if [ "$cur" != "$base" ]; then
        log "sync_project_checkout: 主 checkout 在 '$cur' ≠ '$base'，不动工作区"
        check_checkout_staleness "$base" "主 checkout 停在分支 \`$cur\`，不在 \`$base\` 上"
        return 0
    fi
    if [ -n "$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null)" ]; then
        log "sync_project_checkout: 主 checkout 有未提交改动，不动工作区"
        check_checkout_staleness "$base" "主 checkout 有未提交改动（daemon 不碰你的工作区）"
        return 0
    fi
    if git -C "$PROJECT_ROOT" merge --ff-only "origin/$base" --quiet 2>/dev/null; then
        log "sync_project_checkout: 主 checkout → $(git -C "$PROJECT_ROOT" log -1 --format='%h %s' 2>/dev/null | head -c 80)"
        check_checkout_staleness "$base" ""
    else
        log "sync_project_checkout: ff-only 失败（本地分叉?），跳过"
        check_checkout_staleness "$base" "ff-only 失败：本地 \`$base\` 与 \`origin/$base\` 已分叉"
    fi
    return 0
}

# 在项目里找一个 prompt 文件（<file> 形如 "new-issue.template.md" / "new-issue.extra.md"）。
# 顺序：
#   0. origin/<base> 上的最新版（git show 直读远端 ref，落临时文件）——主 checkout
#      stale / 有 WIP 时也永远拿到最新版（GigleTutor-Web#516 的结构性修复）。
#      依赖最近一次 fetch 刷新 remote-tracking ref（dispatch 前 sync_project_checkout 会 fetch）。
#   1. 远端不可读时才看本地：<project>/.agents/skills/cavil-loop/prompts/<file>
#   2. <project>/.agents/skills/coding-agent-work-loop/prompts/<file>   ← 改名前的目录名（兼容）
#   3. <project>/.agents/skills/coding-agent-workflow/prompts/<file>    ← 更早的目录名（兼容；老 worktree/分支）
#   4. <project>/.coding-agent/prompts/<file>                           ← 最老路径（兼容）
# 目录顺序以 _names.sh 的 CAVIL_PROJECT_SKILL_DIRS 为准；远端和本地都按这个顺序找。
# 找不到返回空串（不含 skill 默认——那是 base 专属的兜底，见 find_prompt_template）。
find_project_prompt_file() {
    local file="$1" tag="$2"   # tag 只用于临时文件命名，避免 base / overlay 互相覆盖
    local base="${BASE_BRANCH:-main}"
    local remote_copy="$STATE_DIR/prompt-remote-${tag}-${file}"
    local rels=() rel c
    for rel in "${CAVIL_PROJECT_SKILL_DIRS[@]}"; do rels+=("$rel/prompts/${file}"); done
    rels+=(".coding-agent/prompts/${file}")

    # origin/<base> 能解析 → **它就是唯一真值**，不再看本地工作区。
    # 为什么必须这么绝对：主 checkout 常年停在别的分支上（daemon 见它 ≠ main 就不动
    # 工作区，这是有意的）。只在「远端有这个文件」时才用远端、否则回落本地，会踩到
    # 一个很隐蔽的坑——文件在 main 上**已经删了**，本地那条老分支还留着，于是 daemon
    # 捡起早就废弃的那份当 base。实测：tutor 把 .template.md 迁成 .extra.md 之后，
    # base 捡到本地分支上的旧覆写，跟新增量拼在一起，合成 558 行（应为 382）且内容重复。
    if git -C "$PROJECT_ROOT" rev-parse --verify -q "origin/${base}" >/dev/null 2>&1; then
        for rel in "${rels[@]}"; do
            if git -C "$PROJECT_ROOT" show "origin/${base}:${rel}" > "$remote_copy" 2>/dev/null \
               && [ -s "$remote_copy" ]; then
                echo "$remote_copy"
                return
            fi
        done
        rm -f "$remote_copy"
        echo ""      # 远端可读但没有这个文件 = 它确实不存在，别去本地捡尸
        return
    fi

    # 没有 origin/<base>（非 git / 无 remote / 首次 clone 前）→ 看本地工作区
    for rel in "${rels[@]}"; do
        c="$PROJECT_ROOT/$rel"
        if [ -f "$c" ]; then
            echo "$c"
            return
        fi
    done
    echo ""
}

# base 模板：项目有同名 .template.md 就用项目的（完全覆写，老行为不变），
# 否则用 skill 自带的那份。
find_prompt_template() {
    local name="$1"   # e.g. "new-issue" / "pr-comment"
    local found
    found="$(find_project_prompt_file "${name}.template.md" base)"
    if [ -n "$found" ]; then
        echo "$found"
        return
    fi
    [ -f "$SKILL_DIR/prompts/${name}.template.md" ] && echo "$SKILL_DIR/prompts/${name}.template.md" || echo ""
}

# ── base + 项目增量 ──
# 完全覆写一份模板的代价是**它从此拿不到 base 的任何更新**：实测 tutor 的三份覆写
# 里，跟 base 相同的行只剩一半，base 后来加的规范（比如「拍板问题要讲清上下文」）
# 一条都没进去，而且没有任何迹象提示它落后了。
#
# 所以推荐的做法是只写增量：项目放一个 <name>.extra.md，daemon 把它追加在 base 之后。
# 追加而不是插入：后文在 prompt 里天然覆盖前文，项目要推翻 base 的某条约定，
# 在自己的文件里写清"本项目改成 X"即可。
#
# 两者可以并存（项目自己的 .template.md 当 base + .extra.md 追加），但既然都覆写了
# 通常不需要。stdout 写最终要用的文件路径；没有增量时就是 base 本身。
# 渲染「外部需求机器人交接规则」段（prompts/requester-bot-handoff.md）。占位符用 @@NAME@@ 而不是 ${NAME}：
# 这一段由这里渲染完，后面 dispatch 的 sed 只认 ${NAME}，两边不会互相吃掉；值里有
# `|` `&` 这类 sed 特殊字符也不会坏。替换值加了引号：bash 5.2 起未加引号的 & 表示匹配串。
requester_bot_handoff_section() {
    local f="$SKILL_DIR/prompts/requester-bot-handoff.md" text rule cmd
    [ -s "$f" ] || { log "⚠️ 外部需求机器人交接规则文件缺失：$f" 2>/dev/null || true; return 0; }
    text="$(cat "$f")"
    if requester_bot_report_first; then
        rule="本项目要求**先向机器人汇报**：做完（启用交叉 review 时，在代码复审通过后由 reviewer）先叫醒机器人汇报，提需求方认可当前提交后，再交维护者合并"
    else
        rule="本项目**不**要求先向机器人汇报：做完照上文交维护者，不叫醒"
    fi
    cmd="$REQUESTER_BOT_NOTIFY_CMD"
    text="${text//@@LABEL_PENDING_HUMAN@@/"$LABEL_PENDING_HUMAN"}"
    text="${text//@@LABEL_PENDING_REQUESTER_BOT@@/"$LABEL_PENDING_REQUESTER_BOT"}"
    text="${text//@@REQUESTER_BOT_ACCOUNT@@/"$REQUESTER_BOT_ACCOUNT"}"
    text="${text//@@REQUESTER_BOT_ORIGIN_MARKER@@/"$REQUESTER_BOT_ORIGIN_MARKER"}"
    text="${text//@@REQUESTER_BOT_REPORT_RULE@@/"$rule"}"
    text="${text//@@REQUESTER_BOT_NOTIFY_CMD@@/"$cmd"}"
    printf '%s\n' "$text"
}

compose_prompt_template() {
    local name="$1" base_tpl overlay out lessons project_lessons
    base_tpl="$(find_prompt_template "$name")"
    if [ -z "$base_tpl" ]; then
        # 找不到模板 = 调用方会回落到内联的极简 prompt。那份 prompt 只说「实现 → 开 PR →
        # 翻 pending/human」，跳过设计阶段、跳过交叉 review、不贴测试输出 —— 产出看着
        # 像正常完工，实际绕过了所有关卡。这种降级必须留痕，否则只能靠肉眼看 PR 才发现。
        log "⚠️ 找不到 prompt 模板 '$name'（既不在项目里也不在 skill 里）→ 调用方将回落到内联极简 prompt，设计阶段 / review 关卡都会被跳过" 2>/dev/null || true
        echo ""; return
    fi
    overlay="$(find_project_prompt_file "${name}.extra.md" extra)"
    lessons="$SKILL_DIR/prompts/lessons.md"
    project_lessons="$(find_project_prompt_file lessons.md lessons)"
    if [ -z "$overlay" ] && [ ! -s "$lessons" ] && [ -z "$project_lessons" ] && ! requester_bot_enabled; then echo "$base_tpl"; return; fi

    out="$STATE_DIR/prompt-composed-${name}.md"
    {
        cat "$base_tpl"
        if [ -s "$lessons" ]; then
            printf '\n\n---\n\n'
            cat "$lessons"
        fi
        if [ -n "$project_lessons" ]; then
            printf '\n\n---\n\n'
            cat "$project_lessons"
        fi
        if [ -n "$overlay" ]; then
        printf '\n\n---\n\n'
        printf '# 本项目的附加要求（覆盖上面与之冲突的部分）\n\n'
        printf '> 上面是通用工作流，这一段是 %s 特有的。两者冲突时**以这一段为准**。\n\n' "${REPO:-本仓库}"
        cat "$overlay"
        fi
        # 外部需求机器人交接规则（GitHub#95）放在**最末尾**、项目追加要求之后：项目整份替换了
        # 工具自带模板时也收得到；写进工具模板里的话，那种项目就漏了。功能关着什么都不加。
        if requester_bot_enabled; then
            printf '\n\n---\n\n'
            requester_bot_handoff_section
        fi
    } > "$out"
    log "prompt: base=$(basename "$base_tpl") + 增量=$(basename "$overlay")（合成 $(wc -l < "$out") 行）" 2>/dev/null || true
    echo "$out"
}

# ── 加载 driver（按 WORKER_AGENT）──
# 放在文件末尾，确保 _lib.sh 自己的函数都已定义；driver 注入的函数
# (agent_is_busy / agent_has_history / agent_command_new/resume) 之后被 dispatch
# 脚本 + cleanup-issue.sh 在执行时取到。
_LIB_DIR="${CODING_AGENT_RELEASE_ROOT:+$CODING_AGENT_RELEASE_ROOT/scripts}"
_LIB_DIR="${_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck disable=SC1091
source "$_LIB_DIR/drivers/_common.sh"
source_driver "$WORKER_AGENT" || exit 2

# ── Token usage 脚本路径（项目级 prompt 通过 ${AGENT_TOKEN_USAGE_SCRIPT} 占位调用）──
# 优先 drivers/token-usage/<agent>.sh；没有 fallback _default.sh（输出空、worker
# 落"未知"兜底）。新增 driver 时按需在 token-usage/ 加 <agent>.sh 即可。
AGENT_TOKEN_USAGE_SCRIPT="$_LIB_DIR/drivers/token-usage/${WORKER_AGENT}.sh"
[ -f "$AGENT_TOKEN_USAGE_SCRIPT" ] || AGENT_TOKEN_USAGE_SCRIPT="$_LIB_DIR/drivers/token-usage/_default.sh"
_MANAGED_TOKEN_USAGE="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}/entrypoints/drivers/token-usage/$(basename "$AGENT_TOKEN_USAGE_SCRIPT")"
[ ! -f "$_MANAGED_TOKEN_USAGE" ] || AGENT_TOKEN_USAGE_SCRIPT="$_MANAGED_TOKEN_USAGE"

# ── 评论用量 footer（模板通过 ${COMMENT_FOOTER_CMD} 占位调用，GitHub#88）──
# 整段 footer 由脚本生成，worker 原样贴。用量驱动直接传上面选好的那一个，两处不各选各的；
# 项目配置路径传过去，脚本只从里面读 COMMENT_FOOTER_EXTRA_CMD（项目自己的测试统计命令）。
# 放在本机配置而不是仓库里：仓库里的脚本任何能改仓库的 PR 都能改，等于让 PR 决定 worker
# 发评论前跑什么。托管安装走长期入口，发版切换时路径不失效（同用量驱动）。
COMMENT_FOOTER_SCRIPT="$_LIB_DIR/drivers/token-usage/comment-footer.sh"
_MANAGED_FOOTER="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}/entrypoints/drivers/token-usage/comment-footer.sh"
[ ! -f "$_MANAGED_FOOTER" ] || COMMENT_FOOTER_SCRIPT="$_MANAGED_FOOTER"
COMMENT_FOOTER_CMD="bash '$COMMENT_FOOTER_SCRIPT' --agent '$WORKER_AGENT' --driver '$AGENT_TOKEN_USAGE_SCRIPT' --config '$CONFIG_FILE'"

# ── 叫醒外部需求机器人的命令（GitHub#95，写进「外部需求机器人交接规则」段）──
# 同 footer：托管安装走长期入口（发版切换时不失效），配置路径由这里给定，不让 worker 自己找。
# 早期的入口名 notify-relay.sh 仍保留（转发到新脚本），给发版切换那一刻还拿着旧提示词的 worker 用。
REQUESTER_BOT_NOTIFY_SCRIPT="$_LIB_DIR/notify-requester-bot.sh"
_MANAGED_REQUESTER_BOT="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}/entrypoints/notify-requester-bot.sh"
[ ! -f "$_MANAGED_REQUESTER_BOT" ] || REQUESTER_BOT_NOTIFY_SCRIPT="$_MANAGED_REQUESTER_BOT"
REQUESTER_BOT_NOTIFY_CMD="bash '$REQUESTER_BOT_NOTIFY_SCRIPT' --config '$CONFIG_FILE'"

# ── 缺价自动抓价（GitHub#51）──
# 计价驱动（跑在 worker 里，不许联网）发现「某模型有用量却没单价」时只在本机留一个空
# 标记；daemon 每轮调这里，有标记才去跑 price_fetch.py（官方价目页 + LiteLLM 两边一致
# 才用，写进本机缓存，只补缺不覆盖）。没有标记时只是一次 ls，不碰网络。
#
# 开关 PRICE_AUTO_FETCH：默认开（issue #51 Q2=A），0 / false / no / off 关。
# 抓价永远不许拖垮派工：脚本自己吞掉所有异常、恒返回 0，单次请求有超时，失败的模型
# 冷却 6 小时；这里再兜一层 `|| true`。输出逐行转进 log（带项目前缀进 poll.log）。
price_fetch_tick() {
    case "${PRICE_AUTO_FETCH:-1}" in 0|false|no|off) return 0 ;; esac
    local dir="${XDG_CACHE_HOME:-$HOME/.cache}/cavil-loop/unpriced"
    [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ] || return 0
    # cavil-loop.config 里的赋值是**不带 export 的**，子进程看不到——显式传过去，
    # 否则部署者改的地址 / 冷却时间静默不生效。没设的不传，让脚本用自己的默认值。
    local line v envs=()
    for v in PRICE_FETCH_ANTHROPIC_URL PRICE_FETCH_OPENAI_URL PRICE_FETCH_LITELLM_URL \
             PRICE_FETCH_COOLDOWN_SECS PRICE_FETCH_TIMEOUT; do
        [ -n "${!v:-}" ] && envs+=("$v=${!v}")
    done
    while IFS= read -r line; do
        [ -n "$line" ] && log "抓价：$line"
    done < <(env ${envs[@]+"${envs[@]}"} python3 "$_LIB_DIR/drivers/token-usage/price_fetch.py" 2>&1 || true)
    return 0
}

# ── 会话注册表：(work number, agent, 角色) → agent 侧的 session id ──
#
# 为什么不放 state.json：那是有兼容约束的接口（CONTRIBUTING 明写改了要申报），
# 而这里存的是纯本机、丢了能自己重建的缓存；而且 dispatch 是 agent-poll 的子进程，
# 两边同时 jq 改写同一个 state.json 属于没必要的写竞争。一角色一文件，最笨最稳。
AGENT_SESSION_DIR="${AGENT_SESSION_DIR:-$STATE_DIR/agent-sessions}"

# 「这个 driver 没法按 id 定位会话」的标记：走上线前的老路（--continue / resume --last）。
AGENT_SESSION_LEGACY="__legacy__"

agent_session_new_uuid() {
    if command -v uuidgen > /dev/null 2>&1; then
        uuidgen | tr 'A-Z' 'a-z'
    elif [ -r /proc/sys/kernel/random/uuid ]; then
        cat /proc/sys/kernel/random/uuid
    else
        python3 -c 'import uuid; print(uuid.uuid4())'
    fi
}

# ── 本次启动的唯一标记 ──
# 回捞要凭证据认领会话，最硬的证据是「只有这次启动才有的标记」：往 prompt 末尾追加一行
# markdown 注释，带一个本次独有的 uuid。会话文件里记着启动时收到的 prompt 原文，于是
# 「这条会话的第一条消息里有我的标记」就等价于「这条会话是我起的」。
#
# 为什么光比 prompt 正文不够：同一个角色连派两次、或者项目覆写的两个模板共享很长的
# 开头，正文比对都分不出来——复审第 2 轮把这两种都构造复现了。
#
# 只在「启动时钉不了 id、非得事后回捞」时才加。claude 那种能钉 id 的，prompt 一个字节
# 都不动。
AGENT_SESSION_TAG_PREFIX="coding-agent-launch:"

agent_session_prompt_tag() {   # <prompt_file> → 文件里的标记（没有就输出空）
    local f="${1:-}"
    [ -n "$f" ] && [ -f "$f" ] || return 0
    grep -o "$AGENT_SESSION_TAG_PREFIX [0-9a-fA-F-]\{36\}" "$f" 2>/dev/null \
        | tail -1 | awk '{print $2}'
    return 0
}

agent_session_tag_prompt() {   # <prompt_file> → 追加标记并输出它
    local f="${1:-}" tag
    [ -n "$f" ] && [ -f "$f" ] || return 0
    tag="$(agent_session_new_uuid)"
    [ -n "$tag" ] || return 0
    printf '\n<!-- %s %s -->\n' "$AGENT_SESSION_TAG_PREFIX" "$tag" >> "$f"
    echo "$tag"
    return 0
}

agent_session_file() {   # <num> <agent> <role>
    echo "$AGENT_SESSION_DIR/$1.$2.$3"
}

agent_session_id_get() {   # <num> <agent> <role>
    local f
    f="$(agent_session_file "$1" "$2" "$3")"
    [ -f "$f" ] || return 0
    tr -d '[:space:]' < "$f"
}

agent_session_id_set() {   # <num> <agent> <role> <id>
    local f
    f="$(agent_session_file "$1" "$2" "$3")"
    mkdir -p "$AGENT_SESSION_DIR"
    printf '%s\n' "$4" > "$f"
}

agent_session_id_forget() {   # <num> <agent> <role>
    rm -f "$(agent_session_file "$1" "$2" "$3")"
}

# 注册表目录里除了「当前用哪条」，还有三类**附属**文件。读写两边都靠这个函数认它们，
# 免得哪天有人新加一类、另一边忘了跳过（把 .preexisting 当成排除集读进去，
# 向后兼容会整条失效且一声不响）。
#   <num>.<agent>.<role>.retired  已知属于这个角色、但已被换掉的 id（只增不删）
#   <num>.<agent>.preexisting     本功能第一次管这条活时，cwd 里已经有的 id（可收养白名单）
#   <num>.<agent>.unresolved      回捞失败的启动记录，仅供排查
agent_session_is_aux_file() {   # <path>
    case "$1" in
        *.retired|*.preexisting|*.unresolved) return 0 ;;
    esac
    return 1
}

agent_session_retired_file() {     # <num> <agent> <role>
    echo "$AGENT_SESSION_DIR/$1.$2.$3.retired"
}
agent_session_preexisting_file() { # <num> <agent>
    echo "$AGENT_SESSION_DIR/$1.$2.preexisting"
}
agent_session_unresolved_file() {  # <num> <agent>
    echo "$AGENT_SESSION_DIR/$1.$2.unresolved"
}

# 把某个角色当前登记的 id 移进「退休」名单，再从登记里摘掉。
#
# 为什么不能直接删：强制起新会话（resume 秒退兜底、dispatch-new-issue）改的只是
# 「这个角色现在用哪条」，并不改变「那条对话是谁的」。直接删会让一条 review 对话在
# 磁盘上退化成「没人登记的旧会话」，worker 的收养就会把它捡走——第 1、2 轮复审
# 抓到的就是这个入口。退休名单只增不删，角色归属因此是永久的。
agent_session_retire() {   # <num> <agent> <role>
    local cur rf
    cur="$(agent_session_id_get "$1" "$2" "$3")"
    if [ -n "$cur" ]; then
        rf="$(agent_session_retired_file "$1" "$2" "$3")"
        mkdir -p "$AGENT_SESSION_DIR"
        printf '%s\n' "$cur" >> "$rf"
    fi
    agent_session_id_forget "$1" "$2" "$3"
}

# 本 work number 下所有**已知归属**的 id：各角色当前登记的 + 已退休的。
# 收养时拿它当排除集。
agent_session_ids_blocked() {   # <num>
    local f
    for f in "$AGENT_SESSION_DIR/$1".*; do
        [ -f "$f" ] || continue
        if agent_session_is_aux_file "$f"; then
            # 退休名单要读（它正是排除集的一半）；白名单和排查记录不能读进来
            case "$f" in
                *.retired) cat "$f" ;;
            esac
            continue
        fi
        tr -d '[:space:]' < "$f"
        echo
    done
}

# 第一次为这条活做角色化派工时，把 cwd 里**已经存在**的会话 id 快照下来。
#
# 这些是本功能上线前留下的会话：它们没有任何角色信息，但也只有它们才可能是 worker
# 自己的——之后每一条会话都是角色化派工建的，谁建的当场就知道（claude 启动时钉 id、
# codex 启动后回捞）。于是「可不可以收养」有了一个**正向**判据：在这张快照里才可以。
#
# 原来的判据是反向的（「当前没被别人登记」），于是任何一种登记丢失都会把别的角色的
# 对话误判成可收养：强制换会话把旧 id 删掉（第 1 轮复审）、codex 回捞超时导致新会话
# 从未登记（第 2 轮复审）。正向判据把这两个入口和以后同类的入口一起关掉。
#
# 只写一次：文件已存在就不动。**绝不能**在同一次派工的兜底里重新快照——那会把刚起的
# 那条会话也写进白名单。
agent_session_preexisting_snapshot() {   # <num> <cwd>
    local f tmp
    f="$(agent_session_preexisting_file "$1" "$WORKER_AGENT")"
    [ -f "$f" ] && return 0
    mkdir -p "$AGENT_SESSION_DIR"
    tmp="$f.tmp.$$"
    agent_session_list "$2" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$f"
    return 0
}

# 找一条可以被 worker 角色收养的旧会话。
# 返回：会话 id / $AGENT_SESSION_LEGACY（driver 不支持按 id 定位，走老路）/ 空（起全新）。
agent_session_adoptable() {   # <num> <cwd>
    local num="$1" cwd="$2"
    local blocked allowed line

    if [ "${AGENT_SESSION_ISOLATION:-0}" != 1 ]; then
        # driver 没实现会话枚举 → 保持上线前的行为，有历史就按它自己的方式续接
        if agent_has_history "$cwd"; then
            echo "$AGENT_SESSION_LEGACY"
        fi
        return 0
    fi

    blocked="$(agent_session_ids_blocked "$num")"
    allowed="$(cat "$(agent_session_preexisting_file "$num" "$WORKER_AGENT")" 2>/dev/null || true)"
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        # 已知归属（当前登记 / 已退休）的一律不碰
        printf '%s\n' "$blocked" | grep -Fxq "$line" && continue
        # 正向判据：只收养「本功能开始管这条活之前就存在」的会话
        printf '%s\n' "$allowed" | grep -Fxq "$line" || continue
        echo "$line"
        return 0
    done < <(agent_session_list "$cwd")
    # 能枚举、但一条没被登记的都没有（例如目录里只剩 review 那条）→ 起全新，
    # **绝不**回落到 --continue：那正好会续到 review 那条上。
    #
    # 必须显式 return 0：调用方是 `x="$(agent_session_adoptable ...)"`，而 dispatch
    # 脚本开着 set -e —— 函数返回非 0 会让整条派工当场中断，而「没有可收养的会话」
    # 明明是最常见的正常情况（全新 worktree 每次都走这里）。
    return 0
}

# ── 目录信任（GitHub#108）──
# 起会话前把本 agent 实际认的那个目录记成可信（规则在各 driver 的 agent_trust_key）。
# 放在派工时而不只在部署时：codex 对子模块项目只认每个 worktree 自己，部署时根本不知道
# 以后的 worktree 路径；顺带让部署在这个功能之前的老项目不用重跑 setup。
# 写不成也不挡派工——起完会话后的弹框识别会把真卡住的那次变成明确的启动失败。
agent_prepare_trust() {   # <cwd>
    local cwd="$1" out rc=0 line
    declare -f agent_trust_paths >/dev/null || return 0
    out="$(agent_trust_dirs "$cwd" 2>&1 >/dev/null)" || rc=$?
    while IFS= read -r line; do
        [ -n "$line" ] && log "  $line"
    done <<< "$out"
    [ "$rc" = 0 ] || log "  ⚠️ 没能给 $WORKER_AGENT 补上 $cwd 的目录信任（rc=$rc）；若卡在信任框，起会话后会转人工"
    return 0
}

# 起完会话后看一眼屏幕：认出本 agent 的目录信任确认框 → 截屏进日志、杀会话、返回 0。
# 没认出（或 driver 没给特征）→ 返回 1。最多看 AGENT_TRUST_PROMPT_WAIT_SECS 秒
# （claude 实测 0.3 秒内出框，codex 几秒内），会话自己退了就不再等。
agent_trust_prompt_blocked() {   # <tmux_session> <cwd>
    local sess="$1" cwd="$2" n i screen log_path key
    [ -n "${AGENT_TRUST_PROMPT_RE:-}" ] || return 1
    n=$(( ${AGENT_TRUST_PROMPT_WAIT_SECS:-4} * 2 ))
    for ((i = 0; i < n; i++)); do
        session_alive "$sess" || return 1
        screen="$(tmux capture-pane -t "$sess" -p 2>/dev/null | tr -s '[:space:]' ' ')"
        if printf '%s' "$screen" | grep -qE "$AGENT_TRUST_PROMPT_RE"; then
            key="$( (agent_trust_key "$cwd") 2>/dev/null || echo "$cwd")"
            log "  ❌ $sess 卡在 $WORKER_AGENT 的目录信任确认框上（工作目录 $cwd，该补的信任记录：$key）"
            log_path="$(session_log_path "$sess")"
            {
                printf '\n===== %s session=%s 卡在目录信任框，pane capture =====\n' "$(date -Iseconds)" "$sess"
                tmux capture-pane -t "$sess" -p -S -200 2>/dev/null | sed '/^[[:space:]]*$/d'
            } >> "${log_path:-/dev/null}" 2>/dev/null
            tmux kill-session -t "$sess" 2>/dev/null || true
            return 0
        fi
        sleep 0.5
    done
    return 1
}

# 起完会话后统一调用：卡在信任框上就留言、翻 pending/human 并返回 1（调用方 exit 0——
# 这种失败在记录补上前是确定性的，重试白费，所以不进重试计数）。
agent_launch_trust_gate() {   # <num> <tmux_session> <cwd>
    local num="$1" sess="$2" cwd="$3" key
    agent_trust_prompt_blocked "$sess" "$cwd" || return 0
    key="$( (agent_trust_key "$cwd") 2>/dev/null || echo "$cwd")"
    notify_bounced_to_human "$num" \
        "\`$WORKER_AGENT\` 在工作目录 \`$cwd\` 弹出了目录信任确认框，没法自动开工。daemon 起会话前已经尝试写入信任记录（\`$key\`），但 \`$WORKER_AGENT\` 仍然要确认——可能是它改了判定规则，或者配置文件写不进去（原因见 daemon 机器的 poll.log）。" \
        "在 daemon 所在机器上进入 \`$cwd\` 手动运行一次 \`$(agent_bin)\`，在确认框里选信任后退出，再把标签改回 \`$LABEL_PENDING_AGENT\`。"
    run_gh "label 翻转 (#$num 卡在目录信任框 → $LABEL_PENDING_HUMAN)" \
        gh_label_flip "$num" \
        --add "$LABEL_PENDING_HUMAN" \
        --remove "${TRIGGER_LABELS_ALL[@]}" "$LABEL_AGENT_DOING" || true
    return 1
}

# 决定本次派工该起哪条会话。**只做决策（外加给 prompt 打启动标记），不产出命令。**
# 设置三个全局：AGENT_LAUNCH_KIND（new|resume|adopt|legacy-resume）、WORKER_SESSION_ID
# （driver 的 agent_command_new / agent_command_resume 读它决定钉哪个 / 续哪条 id）、
# AGENT_SESSION_PRELAUNCH_IDS（给回捞用的开工前快照）。
#
# ⚠️ 必须在**当前 shell** 里直接调，不能写成 `X="$(agent_session_plan ...)"`：
# 命令替换开的是子 shell，上面三个全局会连同子 shell 一起消失，调用方只会读到空值
# （dispatch 脚本开着 set -u，读空值直接就是 unbound variable 崩在派工路上）。
# 「决策」和「产命令」分成两个函数，正是为了让产命令那步可以安全地放进 $( )。
#
# 收在一个函数里是因为三个 dispatch 脚本原来各写一份「有历史就 resume」，
# 角色隔离要在每份里重写一遍必然会漏掉一条路径。
agent_session_plan() {   # <num> <cwd> <prompt_file> [force_new]
    local num="$1" cwd="$2" prompt_file="${3:-}" force_new="${4:-0}"
    local role="$WORKER_SESSION_ROLE"
    local id="" adopted=""

    AGENT_LAUNCH_KIND=""
    WORKER_SESSION_ID=""
    AGENT_SESSION_PRELAUNCH_IDS=""

    # 每次起会话（新建 / 续接 / 续接失败重建，三个派工脚本全部经过这里）之前先补目录信任
    agent_prepare_trust "$cwd"

    # 白名单只在「本功能第一次管这条活」时拍一张，后面每次调用都只是存在性检查
    if [ "${AGENT_SESSION_ISOLATION:-0}" = 1 ]; then
        agent_session_preexisting_snapshot "$num" "$cwd"
    fi

    if [ "$force_new" != 1 ]; then
        id="$(agent_session_id_get "$num" "$WORKER_AGENT" "$role")"
        if [ -n "$id" ]; then
            if agent_session_exists "$cwd" "$id"; then
                WORKER_SESSION_ID="$id"
                AGENT_LAUNCH_KIND="resume"
                return 0
            fi
            # 登记过但会话没了（history 被清、worktree 重建过…）→ 退休掉，往下起全新。
            # 走退休不走删：万一那条对话之后又出现（备份恢复 / 挂载回来），
            # 它的角色归属还在，不会变成一条「谁都能收养的旧会话」。
            agent_session_retire "$num" "$WORKER_AGENT" "$role"
        fi

        # 普通 worker 的向后兼容：本功能上线前的会话一条都没登记过，
        # 不能因为「注册表里查不到」就把正在做的活的上下文丢掉。
        # review 角色不收养——它宁可从零开始，也不能捡到 worker 那条。
        if [ "$role" = "worker" ]; then
            adopted="$(agent_session_adoptable "$num" "$cwd" || true)"
            if [ "$adopted" = "$AGENT_SESSION_LEGACY" ]; then
                AGENT_LAUNCH_KIND="legacy-resume"
                return 0
            fi
            if [ -n "$adopted" ]; then
                agent_session_id_set "$num" "$WORKER_AGENT" "$role" "$adopted"
                WORKER_SESSION_ID="$adopted"
                AGENT_LAUNCH_KIND="adopt"
                return 0
            fi
        fi
    else
        # 强制起新：只换「现在用哪条」，旧那条的角色归属必须留下
        agent_session_retire "$num" "$WORKER_AGENT" "$role"
    fi

    # 全新会话。driver 能在启动时钉 id（claude 的 --session-id）就当场登记；
    # 钉不了的（codex 启动侧没有这种 flag）先记下开工前已有的 id，
    # 等 tmux 起完再由 agent_session_register_launched 回捞。
    id="$(agent_session_new_id "$cwd" "$role")"
    if [ -n "$id" ]; then
        agent_session_id_set "$num" "$WORKER_AGENT" "$role" "$id"
        WORKER_SESSION_ID="$id"
    elif [ "${AGENT_SESSION_ISOLATION:-0}" = 1 ]; then
        AGENT_SESSION_PRELAUNCH_IDS="$(agent_session_list "$cwd" || true)"
        # 钉不了 id → 启动后得回捞 → 给 prompt 打上本次启动独有的标记，回捞靠它认领
        agent_session_tag_prompt "$prompt_file" > /dev/null
    fi
    AGENT_LAUNCH_KIND="new"
}

# 按 agent_session_plan 定好的方案产出启动命令（写 stdout）。
# 这个可以放进 $( )：它不设任何调用方要读的全局。
agent_launch_command() {   # <cwd> <session_name> <prompt_file>
    case "${AGENT_LAUNCH_KIND:-new}" in
        new) agent_command_new "$1" "$2" "$3" ;;
        *)   agent_command_resume "$1" "$2" "$3" ;;
    esac
}

# 起完一条全新会话之后调用：给「启动时钉不了 id」的 driver（codex）把本次真正用上的
# session id 回捞并登记。其余情况是空操作。
#
# **登记前必须有证据证明候选属于本次启动。** 「本次启动后才出现的文件」不是证据：
# 别的角色回捞超时过，它那条会话的文件可能比我们自己的先落盘，于是「新出现」会把
# 别人的会话登记到我们名下，下一轮直接 resume 过去——这就绕开了收养那道正向判据。
# 复审连抓三轮，三次都是同一个根因（用反向/弱判据代替正向证据），这是第三个入口。
#
# 证据来自 driver 的 agent_session_started_with（codex 比对 rollout 里记下的第一条
# user 消息 == 本次传进去的 prompt 原文）。driver 举证不了时走保守路线：只有
# 「候选唯一 + 此前没有未解决的启动」才敢登记。
#
# 拿不到证据不让派工失败：留一条 .unresolved 记录 + 日志，该角色下一轮从零起一条。
# 丢上下文，但绝不串角色。
agent_session_register_launched() {   # <num> <cwd> <prompt_file>
    local num="$1" cwd="$2" prompt_file="${3:-}"
    local role="$WORKER_SESSION_ROLE"
    local step=0.5 line deadline found="" reason=""
    local -a cands proven

    [ "${AGENT_LAUNCH_KIND:-}" = "new" ] || return 0
    [ -z "${WORKER_SESSION_ID:-}" ] || return 0
    [ "${AGENT_SESSION_ISOLATION:-0}" = 1 ] || return 0

    local max="${AGENT_SESSION_CAPTURE_SECS:-15}"
    # 按真实流逝时间判，不按迭代数：每轮除了 sleep 还要花一次枚举（codex 扫 200 个
    # 文件约 0.3s），数迭代会让「配 15 秒」实际等成 20 秒，而且会随会话库变大继续漂——
    # 派工期间 agent-poll 攥着 flock，多等的时间全项目一起付。
    # SECONDS 是 bash 内置的整秒计数，所以实际窗口有不到 1 秒的截断误差
    # （实测：配 3 秒等了 2.4 秒），对这个用途够了。
    deadline=$((SECONDS + max))
    while :; do
        # 候选 = 本次启动之后才出现的会话（最近的在前）
        cands=()
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            printf '%s\n' "$AGENT_SESSION_PRELAUNCH_IDS" | grep -Fxq "$line" && continue
            cands+=("$line")
        done < <(agent_session_list "$cwd")

        if [ "${AGENT_SESSION_PROOF:-0}" = 1 ]; then
            proven=()
            for line in "${cands[@]:-}"; do
                [ -z "$line" ] && continue
                if agent_session_started_with "$cwd" "$line" "$prompt_file"; then
                    proven+=("$line")
                fi
            done
            if [ "${#proven[@]}" -eq 1 ]; then
                found="${proven[0]}"
                break
            fi
            if [ "${#proven[@]}" -gt 1 ]; then
                # 两条都自称是本次启动起的：没法判，宁可不登记
                reason="ambiguous-proof"
                break
            fi
            # 一条都举证不出来：可能我们自己那条还没写完 user 消息，继续等
        else
            # driver 举证不了：只在「候选唯一 + 此前没有未解决的启动」时才敢认
            if [ "${#cands[@]}" -eq 1 ] && [ ! -s "$(agent_session_unresolved_file "$num" "$WORKER_AGENT")" ]; then
                found="${cands[0]}"
                break
            fi
            if [ "${#cands[@]}" -gt 0 ]; then
                reason="no-proof-available"
                break
            fi
        fi

        [ "$SECONDS" -ge "$deadline" ] && break
        sleep "$step"
    done

    if [ -n "$found" ]; then
        agent_session_id_set "$num" "$WORKER_AGENT" "$role" "$found"
        WORKER_SESSION_ID="$found"
        log_debug "会话登记：#$num $WORKER_AGENT/$role -> $found"
        return 0
    fi

    [ -n "$reason" ] || reason="timeout"
    mkdir -p "$AGENT_SESSION_DIR"
    printf '%s unresolved-launch role=%s reason=%s candidates=%s\n' \
        "$(date -Iseconds)" "$role" "$reason" "${#cands[@]}" \
        >> "$(agent_session_unresolved_file "$num" "$WORKER_AGENT")"
    log "  ⚠️ 没能确认 $WORKER_AGENT 本次启动的 session id（#$num 角色 $role，原因 $reason，候选 ${#cands[@]} 条）；"
    log "     这条会话保持无主：别的角色既不会收养它（白名单挡着）也不会回捞到它（要举证），"
    log "     代价是该角色下一轮从零起一条新会话"
}

# 清掉某个 work number 下所有角色「当前用哪条」的登记（cleanup-issue 删 worktree 时调用）。
#
# ⚠️ 附属文件（退休名单 / 上线前白名单）**不清**。worktree 可能在同一路径上重建，
# 而 agent 的历史是按 cwd 存的，旧对话还在原地；把角色归属一并清掉，等于让那些旧的
# review 对话重新变成「谁都能收养」。这两个文件只有几行，留着是最便宜的保险。
agent_session_forget_all() {   # <num>
    local f
    for f in "$AGENT_SESSION_DIR/$1".*; do
        [ -f "$f" ] || continue
        agent_session_is_aux_file "$f" && continue
        rm -f "$f"
    done
    return 0
}
