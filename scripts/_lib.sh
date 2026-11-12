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
# 令牌脱敏入口（GitHub#342）：log() 和所有往 poll.log / 窗格历史追加内容的地方都用它
# shellcheck source=_redact.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_redact.sh"
# 重测试排队的公共判断（GitHub#343），scripts/heavy-test.sh 用的是同一份
# shellcheck source=_heavy.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_heavy.sh"

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

# ── 配置缺新功能的设置（GitHub#289）──
# 必须紧跟在 source 配置之后、任何默认值补上之前记：这时「未设置」才等于「项目配置（和 systemd
# 环境文件）里没有这一行」。写成空值（KEY=""）是「已决定不开」，${!k+x} 认它为已设置。
# 登记表见 scripts/config-notices.txt；用的人是 config_notice_tick。
CONFIG_NOTICE_REGISTRY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config-notices.txt"
CONFIG_NOTICE_UNSET=""
if [ -f "$CONFIG_NOTICE_REGISTRY" ]; then
    while IFS='|' read -r _cn_key _cn_kind _; do
        _cn_key="${_cn_key//[[:space:]]/}"; _cn_kind="${_cn_kind//[[:space:]]/}"
        [ "$_cn_kind" = notice ] || continue
        [[ "$_cn_key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
        [ -n "${!_cn_key+x}" ] || CONFIG_NOTICE_UNSET="$CONFIG_NOTICE_UNSET$_cn_key "
    done < "$CONFIG_NOTICE_REGISTRY"
fi
unset _cn_key _cn_kind

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
# GitHub#133：非机器人提的条目（维护者自己的 issue / PR）也允许叫醒。默认关；没有早期名字。
REQUESTER_BOT_WAKE_ANY_ITEM="${REQUESTER_BOT_WAKE_ANY_ITEM:-false}"

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

# 非机器人提的条目也允许叫醒（GitHub#133）：功能本身开启 + 开关打开才算。
# 只放开「能不能叫醒」；合并后通知、先汇报、托管排除照旧只认机器人提的条目（它们不读这个开关）。
requester_bot_wake_any_item() {
    requester_bot_enabled || return 1
    case "$(printf '%s' "${REQUESTER_BOT_WAKE_ANY_ITEM:-}" | tr '[:upper:]' '[:lower:]')" in
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
        --remove "${TRIGGER_LABELS_ALL[@]}" ${REQUESTER_BOT_DISPATCH_CLEAR[@]+"${REQUESTER_BOT_DISPATCH_CLEAR[@]}"} \
            ${BLOCKED_DISPATCH_CLEAR[@]+"${BLOCKED_DISPATCH_CLEAR[@]}"}
}

# labels_csv 里挂没挂等待标签（整名匹配，label 名可能含空格 / 正则元字符）
labels_have_requester_bot_wait() {
    [ -n "$LABEL_PENDING_REQUESTER_BOT" ] || return 1
    case ",${1}," in *",$LABEL_PENDING_REQUESTER_BOT,"*) return 0 ;; esac
    return 1
}

# ── 等待被提前摘掉时不自动续工（GitHub#162）──
# 约定是：机器人转达后等待标签不动，贴回答复时才摘、并打 pending/agent。机器人提前摘掉时（实测
# GigleTutor-Web#1455：转达后 6 秒就摘），条目变成「一个流程标签都没有」，三条**自动**续工的路会把它
# 当成「接着干」空派一轮：greedy 兜底趟、只挂托管标签的 issue、托管接手没有流程标签的 PR。这三处
# 在准备续工那一刻都问这一个函数。明确派工（pending/agent 等触发标签那几趟）不问：那就是有人说了接着干。
#
# 判据只看 GitHub 的标签历史，按事件编号排先后（同一秒的事件常见，不按时间比）：
#   最近一次「打上等待标签」的事件 E；没有 → 放行
#   E 之后有人「打上」任一触发标签（trigger_labels_all：pending/agent 及其变体、追加的、pending/review）→ 放行
#   否则 → 拦住
# 看历史而不是本机见没见过等待标签：挂上和摘掉都发生在两次轮询之间也拦得住，换机器、删状态目录也不影响。
# 谁摘的等待标签不看——机器人、维护者、worker 摘的都要等派工标签。
# 0 = 拦住（REQUESTER_BOT_WAIT_REASON）；1 = 放行；2 = 判不了（读不到 / 事件缺编号：本轮不续工，下轮再判）
# 功能关着（requester_bot_enabled 不成立）→ 1，一次 GitHub 调用都不发。
# **不缓存结论**（代码复审第 1 轮）：GitHub 的 updated_at 只到秒，同一秒里又挂上又摘掉等待标签时它不变，
# 按它缓存的「放行」会放过新的一次等待；改了等待标签 / 触发标签的配置，旧结论也会被沿用。所以每次都现读。
# 只对「没有任何流程标签、正要自动续工」的条目读（明确派工、挡工标签都不走到这里），被拦住的条目每轮读一次。
# 日志去重另记在 $STATE_DIR/requester-bot-wait-log.json（编号 → 「等待标签名|那次挂上的事件编号」）：只决定
# 要不要再记一行日志，**从不参与判断**；文件坏了、丢了只会多记几行。
# REQUESTER_BOT_WAIT_LOGGED=1 = 这一次拦住的原因（同一个等待标签、同一次挂上）已经记过日志。
REQUESTER_BOT_WAIT_REASON=""; REQUESTER_BOT_WAIT_LOGGED=""
requester_bot_wait_hold() {   # <编号>
    local n="$1" rows sorted e L lf key tmp
    REQUESTER_BOT_WAIT_REASON=""; REQUESTER_BOT_WAIT_LOGGED=""
    requester_bot_enabled || return 1
    if ! rows=$(gh api --paginate "repos/$REPO/issues/$n/events" \
            --jq '.[] | select(.event == "labeled") | [(.id // "" | tostring), (.label.name // "")] | @tsv' 2>/dev/null); then
        REQUESTER_BOT_WAIT_REASON="读不到 #$n 的标签记录"; return 2
    fi
    rows=$(printf '%s\n' "$rows" | awk -F'\t' 'NF')
    if [ -n "$rows" ] && ! printf '%s\n' "$rows" | awk -F'\t' '$1 !~ /^[0-9]+$/ { bad=1 } END { exit bad }'; then
        REQUESTER_BOT_WAIT_REASON="#$n 的标签记录缺事件编号"; return 2
    fi
    [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
    # 排序在拿全所有页之后做（--paginate 下 --jq 逐页执行）；排序和挑事件分两步，退出码各自查
    sorted=$(printf '%s\n' "$rows" | awk -F'\t' 'NF' | sort -t$'\t' -k1,1n) || { REQUESTER_BOT_WAIT_REASON="#$n 的标签记录排不了序"; return 2; }
    e=$(printf '%s\n' "$sorted" | awk -F'\t' -v W="$LABEL_PENDING_REQUESTER_BOT" '$2 == W { e = $1 } END { print e }')
    [ -n "$e" ] || return 1
    for L in "${TRIGGER_LABELS_ALL[@]}"; do
        if printf '%s\n' "$sorted" | awk -F'\t' -v E="$e" -v T="$L" '($1 + 0) > (E + 0) && $2 == T { f = 1 } END { exit !f }'; then
            return 1
        fi
    done
    REQUESTER_BOT_WAIT_REASON="#$n 最近一次挂上等待标签 $LABEL_PENDING_REQUESTER_BOT 之后，没人打过派工标签（等待标签已被摘掉）"
    # 日志去重（不影响上面的结论）
    lf="$STATE_DIR/requester-bot-wait-log.json"; key="$LABEL_PENDING_REQUESTER_BOT|$e"
    if [ "$(jq -r --arg n "$n" '.[$n] // ""' "$lf" 2>/dev/null)" = "$key" ]; then
        REQUESTER_BOT_WAIT_LOGGED=1
    else
        tmp=$(mktemp "$lf.XXXXXX" 2>/dev/null) || tmp=""
        if [ -n "$tmp" ]; then
            { [ -s "$lf" ] && cat "$lf" || echo '{}'; } \
                | jq --arg n "$n" --arg k "$key" '(if type == "object" then . else {} end) | .[$n] = $k' \
                > "$tmp" 2>/dev/null && mv "$tmp" "$lf" || rm -f "$tmp"
        fi
    fi
    return 0
}

# ── 等前置标签（GitHub#157，可选，默认关闭）──
# 一条活卡在「别的 issue / PR 还没完成」上（不是卡在要人拍板；前置可以在本仓库，也可以在别的仓库，
# GitHub#243）时，worker 挂这个标签并登记
# 前置；daemon 定期检查（blocked_tick），前置全部成功完成 → 留一条说明、翻回原触发标签接着干；
# 有前置以失败收场 / 读全了却找不到前置 → 交人。留空 = 功能关闭，行为和以前一样。
#
# 和外部需求机器人的等待标签一样，daemon 这边另有三处作用（标签非空才生效）：
#   1. greedy 兜底趟挡工（greedy_skip_label_list；托管的「只挂托管标签就派」也因此不收它）
#   2. self-heal 不把挂着它的 doing/agent 条目翻回触发标签
#   3. 有人在等待期间**又打了触发标签** → 照常派工，派工时一并摘掉它（BLOCKED_DISPATCH_CLEAR）
LABEL_PENDING_BLOCKED="${LABEL_PENDING_BLOCKED:-}"
# 同一个等待条目两次细查的最短间隔；也是「有条目在等」时轮询退避的上限（见 agent-poll.sh § 5）
BLOCKED_RECHECK_SECS="${BLOCKED_RECHECK_SECS:-300}"
# 判定已定、写 GitHub 连续失败多少次就放弃（留在等待标签上、记日志）
BLOCKED_MAX_TRIES="${BLOCKED_MAX_TRIES:-10}"
case "$BLOCKED_RECHECK_SECS" in ''|*[!0-9]*) BLOCKED_RECHECK_SECS=300 ;; esac
case "$BLOCKED_MAX_TRIES" in ''|*[!0-9]*) BLOCKED_MAX_TRIES=10 ;; esac
BLOCKED_DISPATCH_CLEAR=()
[ -z "$LABEL_PENDING_BLOCKED" ] || BLOCKED_DISPATCH_CLEAR=("$LABEL_PENDING_BLOCKED")
blocked_enabled() { [ -n "$LABEL_PENDING_BLOCKED" ]; }
labels_have_blocked() {   # <labels_csv>
    [ -n "$LABEL_PENDING_BLOCKED" ] || return 1
    case ",${1}," in *",$LABEL_PENDING_BLOCKED,"*) return 0 ;; esac
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
REVIEW_MAX_ROUNDS="${REVIEW_MAX_ROUNDS:-6}"
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
# ── 托管标签（GitHub#114，可选，默认关闭）──
# 维护者在 issue 上打这个标签 = 这条从方案到合并全交给 agent：方案只过复审、不等人确认，
# 代码复审通过后翻 LABEL_PENDING_MERGE，由 daemon 按固定条件合并（autopilot_merge_tick）。
# 它是「模式标签」不是触发标签：派工时不摘、全程挂着。只在 issue 上打才算数——PR 上的同名
# 标签一概不看（PR 由 worker 开，上面的任何标签都可能是 worker 打的）。
# 留空 = 关闭：下面的 LABEL_PENDING_MERGE 也随之清空，派工、提示词、GitHub 调用、state.json
# 和以前逐字节一样。开着但没配复审关卡（LABEL_PENDING_REVIEW）时不托管任何条目：没人把关。
LABEL_AUTOPILOT="${LABEL_AUTOPILOT:-}"
LABEL_PENDING_MERGE="${LABEL_PENDING_MERGE:-pending/merge}"
# 关掉之后的收尾（autopilot_off_sweep）还要认得这个标签名，所以清空之前先留一份
AUTOPILOT_MERGE_LABEL_NAME="$LABEL_PENDING_MERGE"
[ -n "$LABEL_AUTOPILOT" ] || LABEL_PENDING_MERGE=""
AUTOPILOT_MERGE_METHOD="${AUTOPILOT_MERGE_METHOD:-squash}"
# 检查（CI）一直没跑完的上限，过了就交人
AUTOPILOT_CHECKS_TIMEOUT_HOURS="${AUTOPILOT_CHECKS_TIMEOUT_HOURS:-6}"
# 授权 / PR / 检查连续读不到几轮后交人（读不到不等于「没授权」，也不等于「有授权」）
AUTOPILOT_UNKNOWN_MAX="${AUTOPILOT_UNKNOWN_MAX:-10}"
# 合并前必须人过目的文件清单（GitHub#337）。留空 / 不写 = 和以前逐字节一样（只拦 .github/，走原来的代码）。
# 非空才进入新判断：清单匹配、改动文件列表读全校验、命中交人前原样重判一次。写法见 autopilot_paths_verdict
AUTOPILOT_HUMAN_PATHS="${AUTOPILOT_HUMAN_PATHS:-}"
# `default` 这个词展开成的内置清单：之后会以维护者身份运行代码的文件（CI、git hooks、agent 配置、
# 项目级提示词覆盖、打开目录就可能执行任务的编辑器 / 容器配置、安装 / 构建 / 环境配置）
AUTOPILOT_HUMAN_PATHS_DEFAULT="/.github/ .husky/ .githooks/ /.pre-commit-config.yaml /lefthook.yml .claude/ .codex/ .agents/ .mcp.json .devcontainer/ .vscode/ package.json Makefile .envrc"
# 互通仓库名单（GitHub#233）：逗号 / 空格分隔的 owner/repo。名单里的仓库 ① 可以当拆分子项的父 issue 所在仓库
# （父 issue 上维护者亲手打的托管标签，授权本仓库的子项；打标签的人在两个仓库都要有写权限）；② 可以当
# 等前置的前置所在仓库（`<!-- agent-blocked-by: owner/repo#N -->`、「Blocked by」里那个仓库的条目）。
# 留空 = 不认任何别的仓库：拆分父 issue 只认本仓库；写了别的仓库的前置标记交人（GitHub#243 起不再按本仓库同号误读）。
TRUSTED_REPOS="${TRUSTED_REPOS:-}"
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
#   pending/merge  托管条目复审已通过、等 daemon 合并（GitHub#114；托管关闭时为空、不挡）
#   等前置标签     在等本仓库别的 issue / PR 完成（GitHub#157；功能关闭时为空、不挡）
# GREEDY_SKIP_LABELS 是项目自定义的**追加**项（逗号分隔），比如 "blocked,discussion"。
greedy_skip_label_list() {
    printf '%s\n' \
        "$LABEL_PENDING_HUMAN" \
        "$LABEL_AGENT_DOING" \
        "$LABEL_DONE" \
        "$LABEL_PENDING_PR" \
        "${LABEL_PENDING_REVIEW:-}" \
        "${LABEL_PENDING_REQUESTER_BOT:-}" \
        "${LABEL_PENDING_MERGE:-}" \
        "${LABEL_PENDING_BLOCKED:-}"
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

# ── 自动把本仓库 issue / PR 加进 Project（GitHub#116）──
# 一个或多个「组织或用户名/编号」，空格或逗号分隔；留空 = 关闭（默认），不多发任何请求。
# 逻辑全在 scripts/project-auto-add.sh；这里只放默认值和每轮的入口 project_auto_add_tick。
AUTO_ADD_PROJECTS="${AUTO_ADD_PROJECTS:-}"

# ── base 分支测试工作流失败 → 自动开 / 续报告 issue（GitHub#345）──
# CI_FAILURE_REPORT_WORKFLOWS：要监视的工作流文件名（空格或逗号分隔）；留空 = 关闭（默认），
# 一个请求都不多发、派工一处都不多查。逻辑在 scripts/ci_failure_report.py（经 ci-failure-report.sh 运行），
# 这里只放默认值、每轮的入口 ci_failure_report_tick，和派工入口问的那一个函数 ci_report_dispatch_hold。
CI_FAILURE_REPORT_WORKFLOWS="${CI_FAILURE_REPORT_WORKFLOWS:-}"
CI_FAILURE_REPORT_BRANCH="${CI_FAILURE_REPORT_BRANCH:-main}"
CI_FAILURE_REPORT_DISPATCH="${CI_FAILURE_REPORT_DISPATCH:-false}"
CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS="${CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS:-2}"
# 报告 issue 正文首行标记的固定开头（ci_failure_report.py 的 REPORT_RE 同一个写法）
CI_REPORT_BODY_MARK='<!-- cavil-ci-failure v=1 '

ci_failure_report_enabled() {
    [ -n "$(printf '%s' "${CI_FAILURE_REPORT_WORKFLOWS:-}" | tr -d ' ,\t\n')" ]
}

# 本项目配置下的全部流程标签：现有那份（派工标签含追加的、等人、等 PR、进行中、等合并、等外部机器人、
# 等前置）补上复审和 Done。报告身上有其中任何一个，就是有人或某个流程在管它。
ci_report_flow_labels() {
    {
        closed_done_flow_labels
        printf '%s\n' "${LABEL_PENDING_REVIEW:-}" "${LABEL_DONE:-}"
    } | awk 'NF && !seen[$0]++'
}

# 检查的整条进程链（入口脚本 → 检查程序 → gh → gh 再起的任何进程）放在同一个进程组里，组号就是
# 入口脚本的进程号。要停就停整组、并等到组里一个进程都不剩：只停检查程序的话，它正在等的那次 gh 写
# 请求还活着，主轮询往下走了之后它照样把报告建出来（PR #393 复审第 4 轮）。只用 bash 内建
# （set -m、kill、wait），Linux 和 macOS 一样。
ci_report_group_alive() {   # <组号>：组里还有进程 → 0
    kill -0 -- "-$1" 2>/dev/null
}
ci_report_group_stop() {   # <组号>：TERM 整组，最多等 3 秒；还有就 KILL 整组，再等到清空（最多 10 秒）
    local g="$1" i=0
    ci_report_group_alive "$g" || return 0
    kill -TERM -- "-$g" 2>/dev/null || true
    while ci_report_group_alive "$g" && [ "$i" -lt 15 ]; do sleep 0.2; i=$((i + 1)); done
    ci_report_group_alive "$g" || return 0
    kill -KILL -- "-$g" 2>/dev/null || true
    i=0
    while ci_report_group_alive "$g" && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
    ! ci_report_group_alive "$g"
}

# 每轮一次，在轮询锁内、节奏闸门之前（它有自己的 5 分钟间隔，项目空闲退避时照样按时查；它不读也不写
# state.json）。跑成子进程：里面任何失败都只留日志，不碰这一轮的派工和退出码。
#
# 时限分两层，都不用 coreutils 的 timeout（macOS 没有，安装时也只要求 Linux 有）：
#   · 检查程序自己：每次 gh 调用有时限（默认 60 秒），整轮有预算（默认 90 秒），到了就收尾退出
#   · 这里兜底：只用 bash 内建等它，超过「预算 + 120 秒」还没退就把整个进程组停掉
# 不管是哪种结束法，返回之前组里都必须已经没有进程——返回之后不会再有迟到的 GitHub 写入。
ci_failure_report_tick() {
    ci_failure_report_enabled || return 0
    local rc=0 budget="${CI_FAILURE_REPORT_BUDGET:-90}" limit pid waited=0 monitor=off
    case "$budget" in ''|*[!0-9]*) budget=90 ;; esac
    limit="${CI_FAILURE_REPORT_HARD_LIMIT:-$((budget + 120))}"
    case "$limit" in ''|*[!0-9]*) limit=$((budget + 120)) ;; esac
    # set -m 只为这一次启动：后台作业自成一个进程组（组号 = 它的进程号），启动完立刻还原
    case "$-" in *m*) monitor=on ;; esac
    set -m
    CODING_AGENT_CONFIG="$CONFIG_FILE" CI_FAILURE_REPORT_IN_POLL=1 \
        bash "$_LIB_DIR/ci-failure-report.sh" 9>&- &
    pid=$!
    [ "$monitor" = on ] || set +m
    # 自成一组之后，停主轮询的信号不再自动传到它：主轮询被停时先把这一组停干净，再照原信号结束自己
    # （不改成普通退出——主轮询「被信号停掉」这件事对外保持原样）
    local sig
    for sig in TERM INT HUP; do
        # shellcheck disable=SC2064
        trap "ci_report_group_stop '$pid' || true; trap - TERM INT HUP; kill -s $sig \$\$" "$sig"
    done
    # 以 0.2 秒为一步等：平时这一步不到 1 秒就结束，不该为了兜底让每轮多睡 1 秒
    while kill -0 "$pid" 2>/dev/null; do
        if [ "$waited" -ge $((limit * 5)) ]; then
            log "⚠️ CI 失败报告：检查超过 ${limit} 秒没有结束，强制停掉；不派工名单照常生效"
            break
        fi
        sleep 0.2
        waited=$((waited + 1))
    done
    # 入口已经退出时组里通常已空；还有进程（超时没退，或某次 gh 调用超时后它起的进程还在）就整组停掉
    if ! ci_report_group_stop "$pid"; then
        log "⚠️ CI 失败报告：检查的进程组 $pid 停不干净，仍有进程在；不派工名单照常生效"
    fi
    wait "$pid" 2>/dev/null || rc=$?
    trap - TERM INT HUP
    [ "$rc" = 0 ] || log "⚠️ CI 失败报告：检查异常退出（退出码 $rc），本轮跳过；不派工名单照常生效"
    return 0
}

# 「这条 issue 现在能不能派工」——普通标签入口、greedy 入口、托管入口和启动 worker 之前都问这一个函数。
# 返回 0 = 不能派（原因在 CI_REPORT_HOLD_REASON），1 = 这个功能不拦它。功能关闭时直接返回 1，什么都不读。
#   · 在不派工名单里（修复失败达到上限、交人还没做完）→ 不派，不管它身上是什么标签
#   · 本机记录没有或读不懂（暂停中 / 还不知道是不是首次启用）→ 本功能开的报告一律不派；
#     是不是报告看 issue 正文首行的标记，读不到这条 issue 也按不能派算
# 本机记录能不能用，只有一个定义：ci_failure_report.py 的 load_state（state-check 子命令）。这里不另写
# 一套判据——两边不一样时，损坏的记录会被这边当成正常、放开派工。每次都现问、不缓存：按修改时间 /
# 大小缓存的话，同一秒里原位改坏、长度不变的文件会沿用旧结论（PR #393 复审第 2 轮）；也不依赖 stat
# 这类各平台参数不同的工具。读不出结论（python 起不来等）按不能用算。
ci_report_state_usable() {
    local sf="$STATE_DIR/ci-failure-report.json" out
    [ -f "$sf" ] || return 1
    out=$(CI_REPORT_REPO="$REPO" CI_REPORT_STATE_DIR="$STATE_DIR" \
        python3 "$_LIB_DIR/ci_failure_report.py" state-check 2>/dev/null) || out=""
    [ "$out" = ok ]
}

ci_report_dispatch_hold() {   # <issue 编号>
    ci_failure_report_enabled || return 1
    local n="$1" sf="$STATE_DIR/ci-failure-report.json" hf="$STATE_DIR/ci-failure-report.hold" usable=0 item body listed
    CI_REPORT_HOLD_REASON=""
    if ci_report_state_usable; then
        usable=1
        # 记录可用却读不出名单（文件刚好在换）→ 按在名单里算
        if ! listed=$(jq -r --arg n "$n" '.handover | has($n)' "$sf" 2>/dev/null) || [ "$listed" != false ]; then
            CI_REPORT_HOLD_REASON="修复失败次数已到上限、正在交人"
            return 0
        fi
    fi
    if [ "$usable" = 1 ] && [ ! -f "$hf" ]; then
        return 1
    fi
    if ! item=$(autopilot_snapshot_item issues "$n") || [ -z "$item" ]; then
        CI_REPORT_HOLD_REASON="CI 失败报告的本机记录不可用，且读不到这条 issue"
        return 0
    fi
    body=$(printf '%s' "$item" | jq -r '.body // ""' 2>/dev/null) || body=""
    case "$body" in
        "$CI_REPORT_BODY_MARK"*)
            CI_REPORT_HOLD_REASON="CI 失败报告的本机记录丢失或损坏，已暂停"
            return 0 ;;
    esac
    return 1
}

# 被拦下的条目：同一批只在名单变了的时候写一行日志（每分钟一轮，原样重复写没有信息量）
CI_REPORT_HELD=""
ci_report_hold_note() {   # <issue 编号>
    CI_REPORT_HELD="$CI_REPORT_HELD #$1（$CI_REPORT_HOLD_REASON）"
}
ci_report_hold_flush() {
    ci_failure_report_enabled || return 0
    local f="$STATE_DIR/ci-failure-report.heldlog" cur
    cur=$(printf '%s' "$CI_REPORT_HELD" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | sort | tr '\n' ' ')
    if [ "$cur" != "$(cat "$f" 2>/dev/null || true)" ]; then
        [ -z "$cur" ] || log "CI 失败报告：这些 issue 本轮不派工：$cur"
        printf '%s' "$cur" > "$f" 2>/dev/null || true
    fi
    return 0
}

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

# 日志文字里出现 GitHub 令牌前缀时先替换再写（GitHub#342）：写文件和写 stderr（进 journal）
# 用的是同一份替换后的文字。平常的日志行不含前缀，不多起进程。
log() {
    local msg="$*"
    case "$msg" in
        *gh[pousr]_*|*github_pat_*) msg="$(printf '%s' "$msg" | redact_pipe)" ;;
    esac
    echo "[$(date -Iseconds)] [${TMUX_PREFIX}] $msg" | tee -a "$LOG_FILE" >&2   # redact-ok：上面已替换
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
# 空闲时的轻量检查（GitHub#252）：退避判定「本轮跳过」时，先用一次条件请求问 GitHub
# 「仓库里最近更新的那一条变了没有」——没变回 304（正确认证时不占主调用额度）照旧跳过，
# 变了就提前完整跑一轮。开着时完整检查的最长间隔另封顶 POLL_IDLE_PROBE_MAX_SECS。
# 只认 "true" / "false"；其他写法一律按默认 true（打开），见 pace_probe_on。
POLL_IDLE_PROBE="${POLL_IDLE_PROBE:-true}"
POLL_IDLE_PROBE_MAX_SECS="${POLL_IDLE_PROBE_MAX_SECS:-600}"

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
# 轻量检查的版本标记（ETag）。跟节奏状态分开：删掉它只会让下一次检查回 200、多跑一轮。
#   PROBE_ETAG_FILE          已确认的标记：拿到它之后有一整轮成功读过 GitHub
#   PROBE_ETAG_FILE.pending  检查回 200 时拿到的新标记，等这一轮成功读完才转正
PROBE_ETAG_FILE="${PROBE_ETAG_FILE:-$STATE_DIR/poll-probe.etag}"
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

    local now next_due last_poll last_active fail_streak fingerprint waited remain pcap
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
        return 1
    fi
    # 空闲退避、本来要跳过：先问一次「仓库变没变」（GitHub#252）。故障退避（上面那条）
    # 不问——读不到 GitHub 的时候每分钟再问一次，正是故障阶梯要避免的事。
    # 只有明确拿到 304 才继续跳过；变了、读不到、回了看不懂的东西，一律跑。
    if pace_probe_on; then
        # 封顶在**读**这一侧也要生效，不能只在写下一轮时夹：状态是按写入那一刻的配置算的。
        # 封顶被调小、或者关着检查时退到 30 分钟档后又打开，文件里的 next_due 还是旧的那个
        # 更远的期限；只看它会照旧等满，「开着时最长 POLL_IDLE_PROBE_MAX_SECS」就落空了
        # （代码复审第 1 轮实测：旧档 600、新封顶 60、已等 120 秒仍跳过）。用同一个
        # pace_probe_cap，按跟 next_due 一样的抖动余量算到期。
        if pcap=$(pace_probe_cap quiet) && [ $((now + POLL_DUE_SLACK_SECS)) -ge $((last_poll + pcap)) ]; then
            return 0
        fi
        if ! pace_probe; then
            log "轻量检查：$PACE_PROBE_REASON → 提前跑一轮（原定还差 $(pace_human_secs "$remain")）"
            return 0
        fi
        PACE_SKIP_MSG="本轮跳过（已安静 $(pace_human_secs $((now - last_active)))，当前档位 $(pace_human_secs $((next_due - last_poll)))，还差 $(pace_human_secs "$remain")；轻量检查：无变化）"
        return 1
    fi
    PACE_SKIP_MSG="本轮跳过（已安静 $(pace_human_secs $((now - last_active)))，当前档位 $(pace_human_secs $((next_due - last_poll)))，还差 $(pace_human_secs "$remain")）"
    return 1
}

# ── 空闲时的轻量检查（GitHub#252）──
#
# GitHub 没有给本机进程用的订阅接口（没有 WebSocket / SSE，GraphQL 没有 subscription；
# webhook 要公网接收端 + 仓库设置），能用的是 REST 的条件请求：带上次拿到的 ETag 再问，
# 没变化回 304，正确认证时不占主调用额度。问的是「整个仓库最近更新的那一条」：
# `issues?state=all&sort=updated&direction=desc&per_page=1`，issue 和 PR 都在里面，
# 任一条目的更新时间一变，它排到第一，ETag 跟着变。用 state=all 而不是 open：关掉一条
# 不在第一位的 open 条目，在 open 列表第一页上看不出来。
#
# 它**看不到**的：主干有新提交、CI 结果（都不是条目的更新），以及不刷新条目更新时间的
# 事件（实测：被别的条目引用不刷新；打标签、评论、行内评论、推送、关闭 / 合并都刷新）。这些靠完整检查兜底，开着时完整检查最长间隔封顶 POLL_IDLE_PROBE_MAX_SECS。
#
# 和节奏状态一样，它只决定「这一轮跑不跑」，不决定跑的时候做什么；而且只会让一轮
# 提前，不会让任何一轮推迟。

# 开关：只有写成 "false" 才关；阶梯留空（整个退避关掉）时它也无事可做。
pace_probe_on() {
    [ -n "${POLL_BACKOFF_LADDER:-}" ] || return 1
    [ "${POLL_IDLE_PROBE:-true}" != "false" ]
}

# 开着时完整检查的最长间隔。合法 = 1 到心跳值之间的整数秒；不合法打一行警告、
# 返回非 0（= 不封顶，按原阶梯走，阶梯本身已被心跳夹住）。0 不算合法：那等于关掉退避，
# 该用阶梯留空来表达，而不是让一个写错的封顶值悄悄变成每 tick 都跑。
# 第 1 个参数写 quiet = 不打警告：闸门每个 tick 都调，警告只在每轮记账时打一次就够。
pace_probe_cap() {
    local v
    if v=$(pace_num "${POLL_IDLE_PROBE_MAX_SECS:-}" 9) && [ "$v" -ge 1 ] && [ "$v" -le "$POLL_FORCE_SYNC_SECS" ]; then
        printf '%s' "$v"; return 0
    fi
    [ "${1:-}" = quiet ] && return 1
    log "⚠️ POLL_IDLE_PROBE_MAX_SECS='${POLL_IDLE_PROBE_MAX_SECS:-}' 不是 1 到心跳 ${POLL_FORCE_SYNC_SECS} 之间的秒数，本轮不封顶（按原阶梯，最长心跳值）"
    return 1
}

# ETag 的合法形状：可选 W/ 前缀 + 双引号括起来的一串字母数字及少量符号。拿它进 -H 之前必须验，
# 文件被写坏（多行、带控制字符）时宁可不带标记（= 回 200 = 多跑一轮），也不拼出一个
# 奇怪的请求头。
pace_etag_ok() {
    # 字符集写死、不用区间：`[!#-~]` 这类区间在非 C locale 下实测一个都匹配不上。
    # GitHub 的 ETag 是十六进制摘要，这个集合足够宽。
    local re='^(W/)?"[A-Za-z0-9._:+/=-]+"$'
    [[ "$1" =~ $re ]]
}

pace_probe_etag_read() {   # <文件> → 合法的 ETag 或空
    local e=""
    [ -f "$1" ] && IFS= read -r e < "$1" 2>/dev/null
    if pace_etag_ok "$e"; then printf '%s' "$e"; fi
}

pace_probe_etag_write() {  # <文件> <ETag>
    local tmp
    mkdir -p "$STATE_DIR" 2>/dev/null || return 1
    tmp=$(mktemp "$STATE_DIR/.poll-probe.XXXXXX" 2>/dev/null) || return 1
    if printf '%s\n' "$2" > "$tmp" 2>/dev/null && mv "$tmp" "$1" 2>/dev/null; then return 0; fi
    rm -f "$tmp" 2>/dev/null || true
    return 1
}

# 返回 0 = 确定没变化（304）；非 0 = 变了或说不准，PACE_PROBE_REASON 写着原因。
#
# 状态码从 `gh api -i` 的第一行读，不看退出码：gh 对 304 也以 1 退出（实测，并在 stderr
# 打一行 "gh: HTTP 304"），对 200 以 0 退出；只认这两个状态码，其余一律「说不准」。
# 回 200 时把新 ETag 存成 pending，**不**直接转正：转正在 pace_record_ok（这一轮完整读过
# GitHub 之后）。要是先转正、这一轮又半路失败，下一次检查就回 304，这次变化要等完整
# 检查才被看到。304 响应里 GitHub 给回的 ETag 去掉了 W/ 前缀（实测），所以 304 时沿用
# 已存的，不覆盖。
pace_probe() {
    local etag out status new_etag p_rc=0
    PACE_PROBE_REASON=""
    etag=$(pace_probe_etag_read "$PROBE_ETAG_FILE")
    local -a cmd=(gh api -i --method GET)
    if [ -n "$etag" ]; then cmd+=(-H "If-None-Match: $etag"); fi
    cmd+=("repos/$REPO/issues" -f state=all -f sort=updated -f direction=desc -f per_page=1)
    if command -v timeout >/dev/null 2>&1; then cmd=(timeout 30 "${cmd[@]}"); fi
    # RUNLOG_NO_TALLY：这一次调用的计数由下面的 runlog_probe_note 统一记，gh 计数函数不重复记。
    out=$(RUNLOG_NO_TALLY=1 "${cmd[@]}" 2>/dev/null) || p_rc=$?
    status=$(printf '%s\n' "$out" | head -n1 | tr -d '\r' | sed -n 's|^HTTP/[0-9.]* \([0-9][0-9][0-9]\).*|\1|p')
    # 运行记录（GitHub#344）：把这次检查的结果旁路记一笔——超时、读不到、各状态码分开。只记，
    # 下面怎么放行一个字不变。
    if declare -F runlog_probe_note >/dev/null; then runlog_probe_note "$p_rc" "$status"; fi
    case "$status" in
        304)
            if [ -n "$etag" ]; then return 0; fi
            PACE_PROBE_REASON="没带版本标记却回了 304，按说不准处理"; return 1 ;;
        200)
            new_etag=$(printf '%s\n' "$out" | tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: *//p' | head -n1)
            if pace_etag_ok "$new_etag"; then
                pace_probe_etag_write "$PROBE_ETAG_FILE.pending" "$new_etag" || true
            fi
            if [ -z "$etag" ]; then PACE_PROBE_REASON="还没有版本标记（第一次检查，或标记文件丢失 / 损坏）"
            else PACE_PROBE_REASON="仓库有变化"; fi
            return 1 ;;
        "") PACE_PROBE_REASON="读不到 GitHub"; return 1 ;;
        *)  PACE_PROBE_REASON="GitHub 回了 HTTP $status"; return 1 ;;
    esac
}

# 这一轮完整读过 GitHub：把检查时拿到的新标记转正（没有就什么都不做）。
pace_probe_commit() {
    local e
    [ -f "$PROBE_ETAG_FILE.pending" ] || return 0
    e=$(pace_probe_etag_read "$PROBE_ETAG_FILE.pending")
    if [ -n "$e" ]; then pace_probe_etag_write "$PROBE_ETAG_FILE" "$e" || true; fi
    rm -f "$PROBE_ETAG_FILE.pending" 2>/dev/null || true
}

# 一轮真跑完、且这一轮**读到了** GitHub 时调用。
#   acted=1  daemon 这轮确实做了事（派工 / 自愈 / 回收 / 清理 / 队列里有活 / 有 worker 在跑）
#   fp       本轮指纹；空串 = 没算出来 → 保守当作「有动静」，并保留上一轮的指纹不覆盖
pace_record_ok() {
    local acted="$1" fp="$2" cap="${3:-}"
    local now next_due last_poll last_active fail_streak prev_fp active quiet iv pcap
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
    # 第 3 个参数：本轮另有理由要求「最晚这么久后再来一轮」（有条目在等前置，GitHub#157）。只往短里夹
    if [ -n "$cap" ] && cap=$(pace_num "$cap" 9) && [ "$iv" -gt "$cap" ]; then iv="$cap"; fi
    # 轻量检查开着：看得到的变化每个 tick 都能提前叫醒，看不到的（主干提交、CI 结果……）
    # 只能靠完整检查，所以完整检查的最长间隔另封顶（GitHub#252）。同样只往短里夹。
    if [ "$iv" -gt 0 ] && pace_probe_on && pcap=$(pace_probe_cap) && [ "$iv" -gt "$pcap" ]; then iv="$pcap"; fi
    if pace_probe_on; then pace_probe_commit; fi
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
    # 这一轮没读完 GitHub：检查拿到的新标记作废，下一次检查仍对照旧标记（GitHub#252）
    rm -f "$PROBE_ETAG_FILE.pending" 2>/dev/null || true
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
# 实现：find_branch_holder（在调用方 shell 里设全局，不要放进 $( )）。
# branch_checked_out_elsewhere 是它的薄包装，只打印占用者的真实目录，给只要路径的地方用。
branch_checked_out_elsewhere() {
    find_branch_holder "$@" || return 1
    printf '%s' "$BH_DIR"
}

# 找出签出 $1 的另一个 worktree，并说清它是谁（GitHub#141）：
#   BH_KIND      main（仓库的主 checkout）| linked（git worktree add 出来的附加 worktree）
#   BH_DIR       占用者的真实工作目录（给人看、给 git -C 用）
#   BH_RAW       `git worktree list --porcelain` 原样给的路径
#   BH_RESOLVED  1 = 真实目录解析成功；0 = 没解析出来，BH_DIR 退回 BH_RAW
# 命中 return 0，没命中 return 1。调用方必须已经 cd 进仓库。
#
# 为什么不能直接用 porcelain 的路径（本机实测，git 2.43）：仓库是别的仓库的 submodule 时，
# 主 checkout 那条报的是 gitdir（…/.git/modules/<name>），不是工作目录——人在磁盘上找不到
# 对应的目录，`git worktree remove` 它也只会得到 `is a main working tree`。对它跑
# `rev-parse --show-toplevel` 会按子模块的 core.worktree 解析出真实目录。附加 worktree
# 那条本来就是真实目录，同一条命令原样返回。
#
# 「哪条是主 checkout」：porcelain 的第一条恒为主工作树（git 文档保证），不靠路径猜。
#
# 匹配必须是**全等**，不能是子串/前缀：`feature/issue-3` 绝不能匹配上
# `feature/issue-34`。这跟 greedy 挡工判据里防的 `pending/human` vs `pending/humanoid`
# 是同一类坑——错了不会报错，只会悄悄挡住或悄悄放过一条活。
find_branch_holder() {
    local branch="$1" self="${2:-}"
    local wt="" line idx=0 is_main=0 real
    BH_KIND=""; BH_DIR=""; BH_RAW=""; BH_RESOLVED=0
    while IFS= read -r line; do
        case "$line" in
            "worktree "*) wt="${line#worktree }"; idx=$((idx + 1)) ;;
        esac
        # 用字符串全等而不是 case 的 glob：分支名虽然不允许 * ? [，但这里不值得赌。
        if [ "$line" = "branch refs/heads/$branch" ]; then
            if [ "$idx" -eq 1 ]; then is_main=1; else is_main=0; fi
            real=$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || true)
            # 自己那份不算占用（重复派工时 worktree 可能已经在了）
            if [ -n "$self" ] && { [ "$wt" = "$self" ] || [ "$real" = "$self" ]; }; then
                continue
            fi
            BH_RAW="$wt"
            if [ -n "$real" ]; then BH_DIR="$real"; BH_RESOLVED=1
            else BH_DIR="$wt"; BH_RESOLVED=0; fi
            if [ "$is_main" -eq 1 ]; then BH_KIND=main; else BH_KIND=linked; fi
            return 0
        fi
    done < <(git worktree list --porcelain 2>/dev/null || true)
    return 1
}

# 目录的物理路径（消掉符号链接、..、尾部斜杠）；目录不存在 → 空。
canon_dir() {
    [ -n "${1:-}" ] || return 0
    (cd "$1" 2>/dev/null && pwd -P) || true
}

# 占用者是不是本项目配置的那个目录（PROJECT_ROOT 所在工作树的根）。两边都要解析成功、
# 规范化后全等才算；任一边解析不出 → 不算（拿不准就不动）。
branch_holder_is_project_root() {
    local mine theirs root
    [ "${BH_RESOLVED:-0}" = 1 ] || return 1
    root=$(git -C "$PROJECT_ROOT" rev-parse --show-toplevel 2>/dev/null || true)
    mine=$(canon_dir "$root")
    theirs=$(canon_dir "$BH_DIR")
    [ -n "$mine" ] && [ -n "$theirs" ] && [ "$mine" = "$theirs" ]
}

# 读占用者（find_branch_holder 刚找到的那个）的现状，设全局并拼一行给人看的说明：
#   BH_DIRTY   未提交改动行数（含未跟踪文件）；读不出 = "?"
#   BH_OPS     进行中的 git 操作（空格分隔）；没有 = 空；读不出 = "?"
#   BH_HEAD    本地分支 $1 的提交；读不出 = 空
#   BH_AHEAD / BH_BEHIND  本地分支相对 $2 领先 / 落后几个提交；读不出 = "?"
#   BH_STATE_TEXT        一行中文说明（评论和 poll.log 共用）
# $2 = 拿来比的提交（空 = 没有可比的），$3 = 它在说明里的叫法，$4 = 没有可比提交时的原因。
# 规则：任何一项读不出都写「读不出」，绝不当成「干净 / 一致」。
branch_holder_state() {
    local branch="$1" ref="${2:-}" ref_label="${3:-远端}" no_ref_note="${4:-读不出}"
    local out gitdir counts dirty_txt ops_txt cmp_txt
    if out=$(git -C "$BH_DIR" status --porcelain 2>/dev/null); then
        BH_DIRTY=$(printf '%s' "$out" | awk 'NF' | wc -l | tr -d ' ')
    else
        BH_DIRTY="?"
    fi
    BH_OPS="?"
    if gitdir=$(git -C "$BH_DIR" rev-parse --absolute-git-dir 2>/dev/null) && [ -d "$gitdir" ]; then
        BH_OPS=""
        [ -e "$gitdir/MERGE_HEAD" ] && BH_OPS="$BH_OPS merge"
        { [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; } && BH_OPS="$BH_OPS rebase"
        [ -e "$gitdir/CHERRY_PICK_HEAD" ] && BH_OPS="$BH_OPS cherry-pick"
        [ -e "$gitdir/REVERT_HEAD" ] && BH_OPS="$BH_OPS revert"
        [ -e "$gitdir/BISECT_LOG" ] && BH_OPS="$BH_OPS bisect"
        BH_OPS="${BH_OPS# }"
    fi
    BH_HEAD=$(git -C "$BH_DIR" rev-parse -q --verify "refs/heads/$branch^{commit}" 2>/dev/null || true)
    BH_AHEAD="?"; BH_BEHIND="?"
    if [ -n "$ref" ] && [ -n "$BH_HEAD" ] \
       && counts=$(git -C "$BH_DIR" rev-list --left-right --count "$BH_HEAD...$ref" 2>/dev/null); then
        BH_AHEAD=$(printf '%s' "$counts" | awk '{print $1}')
        BH_BEHIND=$(printf '%s' "$counts" | awk '{print $2}')
    fi

    case "$BH_DIRTY" in
        "?") dirty_txt="未提交改动：读不出" ;;
        0)   dirty_txt="没有未提交改动" ;;
        *)   dirty_txt="有 $BH_DIRTY 处未提交改动（含未跟踪文件）" ;;
    esac
    case "$BH_OPS" in
        "?") ops_txt="进行中的 git 操作：读不出" ;;
        "")  ops_txt="没有进行中的合并 / 变基等操作" ;;
        *)   ops_txt="有进行中的 git 操作：$BH_OPS" ;;
    esac
    if [ -z "$ref" ]; then
        cmp_txt="与 ${ref_label} 比：${no_ref_note}"
    elif [ "$BH_AHEAD" = "?" ]; then
        cmp_txt="与 ${ref_label} 比：读不出"
    elif [ "$BH_AHEAD" = 0 ] && [ "$BH_BEHIND" = 0 ]; then
        cmp_txt="与 ${ref_label} 完全一致"
    else
        cmp_txt="比 ${ref_label} 领先 $BH_AHEAD 个、落后 $BH_BEHIND 个提交"
    fi
    BH_STATE_TEXT="$dirty_txt；$ops_txt；$cmp_txt"
}

# 给人看的「怎么继续」，按占用者种类分两种命令（主 checkout 不能 worktree remove）。
# $1 = base 分支。要先跑过 find_branch_holder。
branch_holder_next_step() {
    local base="$1" base_holder
    if [ "$BH_KIND" = main ]; then
        printf '确认上面的现状没问题后，在 daemon 所在机器上执行 `git -C %s switch %s`（让主 checkout 回到 `%s`，分支就释放了），再把标签改回 `%s`。' \
            "'$BH_DIR'" "$base" "$base" "${LABEL_PENDING_AGENT:-pending/agent}"
        if base_holder=$(branch_checked_out_elsewhere "$base" "$BH_DIR"); then
            printf '注意：`%s` 正被另一个 worktree `%s` 签出，上面的命令会被 git 拒绝；可以改用 `git -C %s switch --detach` 释放分支。' \
                "$base" "$base_holder" "'$BH_DIR'"
        fi
        if ! branch_holder_is_project_root; then
            printf '（占着分支的 `%s` 不是本项目配置的目录 `%s`，daemon 不会自动动它。）' \
                "$BH_DIR" "$PROJECT_ROOT"
        fi
    else
        printf '在 daemon 所在机器上确认那个 worktree 没有未提交 / 未推送的改动后执行 `git worktree remove %s`，再把标签改回 `%s`。' \
            "'$BH_DIR'" "${LABEL_PENDING_AGENT:-pending/agent}"
    fi
    if [ "${BH_RESOLVED:-0}" != 1 ]; then
        printf '（没能解析出真实目录，上面是 git 原样报的路径。）'
    fi
}

# 一句话说清占用者是谁，评论和 poll.log 共用。
branch_holder_who() {
    if [ "$BH_KIND" = main ]; then
        printf '主 checkout `%s`' "$BH_DIR"
    else
        printf '另一个 worktree `%s`' "$BH_DIR"
    fi
}

# 默认关。只认 1：它放宽了「daemon 不碰你的工作区」，要项目维护者自己在配置里打开。
AUTO_RELEASE_MAIN_CHECKOUT="${AUTO_RELEASE_MAIN_CHECKOUT:-0}"

# 分支被本项目主 checkout 占着、而且确定切走不会丢任何东西时，把主 checkout 切回 base，
# 释放分支（GitHub#141）。成功 return 0；不满足 / 失败 return 1，原因在 AUTO_RELEASE_REASON。
# 先跑过 find_branch_holder + branch_holder_state（$2 = 刚 fetch 的 PR 最新提交）。
#
# 全部满足才动：
#   1. 占用者是主 checkout，且就是本项目配置的那个目录（附加 worktree、别的目录一律不动）
#   2. 工作区没有任何改动（含未跟踪文件）
#   3. 没有进行中的 merge / rebase / cherry-pick / revert / bisect
#   4. 本地分支与 PR 最新提交完全相同（不领先、不落后、不分叉）
#   5. 主 checkout 此刻确实停在这个分支上
#   6. base 分支没被别的 worktree 占着（否则 git 会拒绝切换）
# 动作固定是 `git switch --no-overwrite-ignore <base>`：检查和切换之间若有人新建了一个
# base 上跟踪、当前分支忽略的同名文件，普通 switch 会直接覆盖它（实测），这个参数让 git
# 拒绝。有人改了跟踪文件，git 按自己的规则拒绝或带过去，都不会丢内容。被拒不重试。
main_checkout_auto_release() {
    local branch="$1" pr_sha="${2:-}" base="${BASE_BRANCH:-main}" cur out rc base_holder
    AUTO_RELEASE_REASON=""
    if [ "$BH_KIND" != main ]; then
        AUTO_RELEASE_REASON="占用者是附加 worktree，daemon 不动它"; return 1
    fi
    if ! branch_holder_is_project_root; then
        AUTO_RELEASE_REASON="占用者不是本项目配置的目录（$PROJECT_ROOT），daemon 不动它"; return 1
    fi
    if [ "$BH_DIRTY" != 0 ]; then
        AUTO_RELEASE_REASON="主 checkout 有未提交改动或读不出"; return 1
    fi
    if [ -n "$BH_OPS" ]; then
        AUTO_RELEASE_REASON="主 checkout 有进行中的 git 操作或读不出（$BH_OPS）"; return 1
    fi
    if [ -z "$pr_sha" ] || [ -z "$BH_HEAD" ] || [ "$BH_HEAD" != "$pr_sha" ]; then
        AUTO_RELEASE_REASON="本地分支与 PR 最新提交不一致或读不出"; return 1
    fi
    cur=$(git -C "$BH_DIR" symbolic-ref -q HEAD 2>/dev/null || true)
    if [ "$cur" != "refs/heads/$branch" ]; then
        AUTO_RELEASE_REASON="主 checkout 当前不在 $branch 上（实得 ${cur:-读不出}）"; return 1
    fi
    if base_holder=$(branch_checked_out_elsewhere "$base" "$BH_DIR"); then
        AUTO_RELEASE_REASON="\`$base\` 正被另一个 worktree \`$base_holder\` 签出，切不过去"; return 1
    fi
    out=$(git -C "$BH_DIR" switch --no-overwrite-ignore "$base" 2>&1); rc=$?
    if [ "$rc" -ne 0 ]; then
        AUTO_RELEASE_REASON="git 拒绝切换（退出码 $rc）：$(printf '%s' "$out" | tr '\n' ' ' | head -c 400)"
        return 1
    fi
    return 0
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
# 可选第 3 个参数：调用方手上已有的 PR 正文（托管判定读过 PR 了，不再多发一次 gh pr view）。
pr_to_issue_num() {
    local pr="$1"
    local branch="$2"
    local n

    # 1. 分支名
    n="$(branch_to_issue_num "$branch")"
    [ -n "$n" ] && { echo "$n"; return; }

    # 2. PR body 关键词
    if [ "$#" -ge 3 ]; then
        n=$(printf '%s' "$3" | pr_body_linked_issue)
    else
        n=$(gh pr view "$pr" --repo "$REPO" --json body --jq '.body // ""' 2>/dev/null | pr_body_linked_issue)
    fi
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
    local pids
    pids=$(tmux list-panes -t "=$sess" -F '#{pane_pid}' 2>/dev/null || true)
    kill_pane_pids $pids
}

# 按进程组 TERM → 等最多 REAP_KILL_GRACE_SECS 秒 → 还活着就 KILL。参数是若干 pane pid。
# kill_session_procs（回收整个 session）和 worker_session_launch（原地换程序，只杀
# worker 那个窗格）共用这一份：claude 不理 SIGHUP 的坑两边一样。
kill_pane_pids() {
    local grace="${REAP_KILL_GRACE_SECS:-10}"
    local pids="$*" p waited alive
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
    # 重测试排队（GitHub#343）：这次启动的条目、代数、启动编号；功能关着什么都不加
    heavy_tmux_env_args
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

# 互通名单里有没有这个仓库（不分大小写）。本仓库自己总算（GitHub#233）
repo_trusted() {   # <owner/repo>
    local r x
    r=$(requester_bot_lc "$1")
    [ -n "$r" ] || return 1
    [ "$r" = "$(requester_bot_lc "$REPO")" ] && return 0
    for x in $(printf '%s' "${TRUSTED_REPOS:-}" | tr ',' ' '); do
        [ "$(requester_bot_lc "$x")" = "$r" ] && return 0
    done
    return 1
}

# 这个 issue 是不是本工具拆出来的子项、父 issue 是谁（GitHub#233，托管授权和跨仓库派工用）。三种结果：
#   0 = 是：SPLIT_PARENT_REPO / SPLIT_PARENT_NUM / SPLIT_PARENT_JSON（父 issue 现读的内容）
#   1 = 明确不是：没有父、父在名单外的仓库、子项不是 loop 写入账号建的、正文没有指向这个父 issue 的拆分标记
#   2 = 判不了：读不到写入账号、读不到父 issue（SPLIT_PARENT_WHY）
# 和 split_parent_of 同三条核对，只是「有没有父」从 issue 自己的 parent_issue_url 读（GitHub 维护，正文改不了；
# 打开列表里就带着，不多发请求）。这个字段整个不存在（旧接口、测试夹具）= 没有父。
# 拆分标记写 `<!-- agent-split-from: #P -->`（P 是父 issue 在它自己仓库里的编号），也认带仓库名的 `owner/repo#P`。
SPLIT_PARENT_REPO=""; SPLIT_PARENT_NUM=""; SPLIT_PARENT_JSON=""; SPLIT_PARENT_WHY=""
split_parent_check() {   # <issue 编号> <issue JSON>
    local num="$1" ij="$2" url prepo pnum author body me pj
    SPLIT_PARENT_REPO=""; SPLIT_PARENT_NUM=""; SPLIT_PARENT_JSON=""; SPLIT_PARENT_WHY=""
    url=$(printf '%s' "$ij" | jq -r '.parent_issue_url // ""' 2>/dev/null) || url=""
    [ -n "$url" ] || return 1
    if [[ "$url" =~ /repos/([^/]+/[^/]+)/issues/([0-9]+)$ ]]; then
        prepo="${BASH_REMATCH[1]}"; pnum="${BASH_REMATCH[2]}"
    else
        SPLIT_PARENT_WHY="读不懂 #$num 的父 issue 地址"; return 2
    fi
    if ! repo_trusted "$prepo"; then
        SPLIT_PARENT_WHY="#$num 的父 issue 在 $prepo，不在互通名单里"; return 1
    fi
    author=$(printf '%s' "$ij" | jq -r '.user.login // ""' 2>/dev/null) || author=""
    me=$(write_identity_login)
    if [ -z "$me" ]; then SPLIT_PARENT_WHY="读不到 loop 的写入账号，无法核对 #$num 是不是本工具拆的"; return 2; fi
    if [ -z "$author" ] || [ "$(requester_bot_lc "$author")" != "$(requester_bot_lc "$me")" ]; then
        SPLIT_PARENT_WHY="#$num 不是 loop 写入账号建的"; return 1
    fi
    body=$(printf '%s' "$ij" | jq -r '.body // ""' 2>/dev/null) || body=""
    if ! printf '%s' "$body" | grep -qiE "<!-- agent-split-from: (#|$(printf '%s' "$prepo" | sed 's/[.[\*^$/]/\\&/g')#)${pnum} -->"; then
        SPLIT_PARENT_WHY="#$num 正文没有指向父 issue $prepo#$pnum 的拆分标记"; return 1
    fi
    if ! pj=$(gh api "repos/$prepo/issues/$pnum" 2>/dev/null) || [ -z "$pj" ] \
       || ! printf '%s' "$pj" | jq -e '(.number != null) and (.state | type) == "string" and (.labels | type) == "array"' >/dev/null 2>&1; then
        SPLIT_PARENT_WHY="读不到 #$num 的父 issue $prepo#$pnum"; return 2
    fi
    if ! printf '%s' "$pj" | jq -e '.pull_request == null' >/dev/null 2>&1; then
        SPLIT_PARENT_WHY="#$num 的父 $prepo#$pnum 不是 issue"; return 1
    fi
    SPLIT_PARENT_REPO="$prepo"; SPLIT_PARENT_NUM="$pnum"; SPLIT_PARENT_JSON="$pj"
    return 0
}

# 父 issue 给人看的写法：本仓库写 #P，别的仓库写 owner/repo#P
split_parent_ref() {   # <repo> <编号>
    if [ "$(requester_bot_lc "$1")" = "$(requester_bot_lc "$REPO")" ]; then printf '#%s' "$2"; else printf '%s#%s' "$1" "$2"; fi
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
        # 托管合并后子项留给人关（GitHub#233），可能很久都开着：不在这里空转重试。子项关掉之后，
        # 父 issue 所在仓库每轮从打开列表里发现「子项全部完成」再汇总（sub_issue_rollup_discover）
        log "  子 issue #$sub 仍是 ${sub_state:-?}，暂不汇总父 issue #$parent（子项关闭后由父 issue 一侧发现）"
        return 0
    fi
    sub_issue_rollup_parent "$parent" "$state_file" "$sub"
}

# 父 issue 一侧的汇总（GitHub#233 从 sub_issue_rollup 拆出）：子项从哪来不管（本仓库或别的仓库），
# 只看父 issue 自己的子项列表。第 3 个参数给了 = 由这个刚关掉的子项触发，额外要求它在列表里。
sub_issue_rollup_parent() {   # <父号> <state_file> [触发的子号]
    local parent="$1" state_file="$2" sub="${3:-}"
    local subs total open_left parent_state done_total commented tmp body
    local parent_meta summary_total
    parent_meta=$(run_gh_capture "读取父 issue #$parent 状态" \
        gh api "repos/$REPO/issues/$parent" --jq '"\(.state)\t\(.sub_issues_summary.total // "")"') || return 1
    parent_state=${parent_meta%%$'\t'*}
    summary_total=${parent_meta#*$'\t'}
    [ "$parent_state" = "open" ] || { log "  父 issue #$parent 已关闭，不汇总"; return 0; }

    subs=$(run_gh_capture "列出父 issue #$parent 的 sub-issue" \
        gh api --paginate "repos/$REPO/issues/$parent/sub_issues?per_page=100" \
        --jq '.[] | "\(.number)\t\(.state)\t\(.repository_url // "")"') || return 1
    total=$(printf '%s\n' "$subs" | awk 'NF' | wc -l | tr -d ' ')
    # 「列表齐不齐」要先确认，才谈得上「列表里的都关了没有」。列表只要漏一项，剩下的
    # 恰好全关，就会被误判成「全部完成」。两道对拍，任一不过 = 列表还没刷新完，下轮再试：
    #   1. 当前子项必须在列表里——/parent 刚确认过它挂在这个父 issue 下
    #   2. 列表条数必须等于父 issue 自己记的子项总数（sub_issues_summary.total）——
    #      防的是漏掉**别的**兄弟子项；这个字段缺失也按「核不了」处理，不放行
    if [ -n "$sub" ] && ! printf '%s\n' "$subs" | awk -F'\t' -v s="$sub" '$1 == s {f=1} END {exit !f}'; then
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
            printf '本 issue 拆出的 sub-issue 都已关闭，请人决定是否关闭本 issue（daemon 不会自动关）：\n\n'
            printf '%s\n' "$subs" | awk -F'\t' -v me="https://api.github.com/repos/$REPO" '
                NF { r = $3; sub("^https://api.github.com/repos/", "", r)
                     if ($3 == "" || tolower($3) == tolower(me)) print "- #" $1; else print "- " r "#" $1 }'
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
    local issue="$1" prnum="${2:-?}" state hissue
    # 托管合并的 PR（GitHub#233）：交接另有一套（不动新一轮的标签、补发合并说明）
    hissue=$(jq -r --arg p "$prnum" '.autopilot.handoff[$p].issue // empty' "${STATE_FILE:-$STATE_DIR/state.json}" 2>/dev/null) || hissue=""
    if [ -n "$hissue" ]; then
        autopilot_merged_handoff "$hissue" "$prnum"; return $?
    fi
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

# ── 人手动关闭（已完成）的 issue 打 Done（GitHub#159）──
# 合并路径只给「合并的 PR」和「被 Closes #N 带关的 issue」打 Done；人在网页上直接关掉、选「已完成」
# 的 issue，§ 4 清理只删本机工作目录，标签一个不动，关掉的 issue 还挂着 pending/human / pending/PR。
#
# 和本机清理分开：§ 4 每看到一个还没记入 cleaned_issues 的已关闭 issue，就入 closed_done_queue
# （重复入队不重置次数），每轮清一次队。清理失败不拖住标签，标签失败也不拖住清理。
# 队列字段故意不进 agent-poll.sh 顶部的补字段循环：没有条目入队时 state.json 和以前逐字节一样；
# 读处一律 `// {}` 兜底（同 requester_bot_done_queue）。
#
# 一条记录的值：数字 = 还要再试、已试几次；"done" = 标签这件事已结束（打成了 / 确认不该打 / 到上限放弃）。
# 结束时不能直接删记录：本机清理失败的 issue 不会记入 cleaned_issues，下一轮 § 4 会再入队一次，
# 记录没了就从 0 重新数，「最多 30 轮」变成无限重试（代码复审第 1 轮）。所以结束时标 "done"，
# 入队不覆盖已有值；等这个 issue 也记进 cleaned_issues（清理成功）时才删掉，见 closed_done_forget。
#
# 合并路径的两份 --remove 清单（agent-poll.sh § 3 的 PR、merged_issue_label 的 issue）各自不同，
# 本次一行不动；这里是第三份，由全部派工标签加其余流程标签拼出，自定义派工标签自动包含。
# 托管模式标签不是流程标签，不在清单里（daemon 永不摘它）。
# 等前置标签（GitHub#157）也是流程标签：关成「已完成」的条目不该还挂着「等前置」。没配时为空、被滤掉
closed_done_flow_labels() {
    {
        trigger_labels_all
        printf '%s\n' \
            "$LABEL_PENDING_HUMAN" \
            "$LABEL_PENDING_PR" \
            "$LABEL_AGENT_DOING" \
            "${LABEL_PENDING_MERGE:-}" \
            "${LABEL_PENDING_REQUESTER_BOT:-}" \
            "${LABEL_PENDING_BLOCKED:-}"
    } | awk 'NF && !seen[$0]++'
}

closed_done_enqueue() {
    local issue="$1" state_file="$2" tmp
    # 只收编号：列表接口异常时 § 4 读到的可能是别的字符串，进了队也永远清不掉
    [[ "$issue" =~ ^[0-9]+$ ]] || return 0
    tmp=$(mktemp)
    jq --arg i "$issue" '.closed_done_queue = ((.closed_done_queue // {}) + {($i): ((.closed_done_queue // {})[$i] // 0)})' \
        "$state_file" > "$tmp" && mv "$tmp" "$state_file"
}

# 一个 issue 处理一次。返回 0 = 定了（打成了 / 已确认不该打），出队；1 = 还没定，留队下轮再判。
# 每次都先重读：入队到现在可能已被重新打开、改了关闭原因、标签被人动过。
# 「打成了」= Done 已在、且每个该摘的流程标签都确认摘掉——只有 Done 不算（摘除失败时 Done 可能
# 已经加上，下一轮还得补摘）。不用 gh_label_flip：它对每个摘除都 `|| true`，分不清
# 「本来就不在」（404，算成功）和真失败；旧调用方保持原样。
closed_done_label() {
    local issue="$1" info st reason
    info=$(run_gh_capture "读取 issue #$issue 状态" \
        gh api "repos/$REPO/issues/$issue" \
        --jq '{s: (.state // ""), r: (.state_reason // ""), pr: (.pull_request != null), l: [(.labels // [])[].name]}') \
        || return 1
    st=$(printf '%s' "$info" | jq -r '.s' 2>/dev/null) || st=""
    reason=$(printf '%s' "$info" | jq -r '.r' 2>/dev/null) || reason=""
    if [ "$(printf '%s' "$info" | jq -r '.pr' 2>/dev/null)" = true ]; then
        return 0   # PR 不归这条路管（合并的 PR 由 § 3 打）
    fi
    case "$st" in
        open)
            log "  issue #$issue 已重新打开，不打 $LABEL_DONE"
            return 0 ;;
        closed) ;;
        *)
            log "  ⚠️ issue #$issue 状态读不出来（'$st'），下轮再判"
            return 1 ;;
    esac
    case "$reason" in
        completed) ;;
        not_planned|duplicate)
            log "  issue #$issue 以「$reason」关闭，不打 $LABEL_DONE"
            return 0 ;;
        *)
            # 读不到 / 为空 / 没见过的原因：绝不当成「已完成」
            log "  ⚠️ issue #$issue 关闭原因未知（'$reason'），不打标签，下轮再判"
            return 1 ;;
    esac

    local L out ok=1 has_done=0 stale=()
    printf '%s' "$info" | jq -e --arg d "$LABEL_DONE" '.l | index($d)' >/dev/null 2>&1 && has_done=1
    while IFS= read -r L; do
        [ -n "$L" ] || continue
        printf '%s' "$info" | jq -e --arg L "$L" '.l | index($L)' >/dev/null 2>&1 && stale+=("$L")
    done < <(closed_done_flow_labels)
    if [ "$has_done" = 1 ] && [ ${#stale[@]} -eq 0 ]; then
        return 0
    fi
    for L in "${stale[@]}"; do
        if ! out=$(gh_write api -X DELETE "repos/$REPO/issues/$issue/labels/$(printf '%s' "$L" | jq -sRr @uri)" 2>&1); then
            if printf '%s' "$out" | grep -q 'HTTP 404'; then continue; fi
            log "  ⚠️ issue #$issue 摘 $L 失败: $out"
            ok=0
        fi
    done
    if [ "$has_done" = 0 ]; then
        if ! out=$(gh_write api -X POST "repos/$REPO/issues/$issue/labels" -f "labels[]=$LABEL_DONE" 2>&1); then
            log "  ⚠️ issue #$issue 加 $LABEL_DONE 失败: $out"
            ok=0
        fi
    fi
    [ "$ok" = 1 ] || return 1
    log "  issue #$issue 手动关闭（已完成）→ $LABEL_DONE${stale[*]:+，摘掉 ${stale[*]}}"
    return 0
}

# 标签这件事结束了：本机清理已经成功（记进 cleaned_issues，§ 4 不会再入队）就删记录，
# 否则标 "done"，挡住下一轮的再次入队。
closed_done_finish() {
    local issue="$1" state_file="$2" tmp
    tmp=$(mktemp)
    jq --arg i "$issue" --argjson n "$issue" \
        'if ((.cleaned_issues // []) | index($n)) != null then del(.closed_done_queue[$i])
         else .closed_done_queue[$i] = "done" end' \
        "$state_file" > "$tmp" && mv "$tmp" "$state_file"
}

# § 4 清理成功、记入 cleaned_issues 之后调：标签已结束的记录到此删掉；还在重试的留着。
closed_done_forget() {
    local issue="$1" state_file="$2" tmp
    [[ "$issue" =~ ^[0-9]+$ ]] || return 0
    tmp=$(mktemp)
    jq --arg i "$issue" 'if (.closed_done_queue // {})[$i] == "done" then del(.closed_done_queue[$i]) else . end' \
        "$state_file" > "$tmp" && mv "$tmp" "$state_file"
}

# 上限同 SUB_ISSUE_ROLLUP_MAX_TRIES（默认 30 轮）；放弃时记日志，要人手动补 Done。
closed_done_drain() {
    local state_file="$1" cap="${SUB_ISSUE_ROLLUP_MAX_TRIES:-30}" issue tries tmp
    for issue in $(jq -r '(.closed_done_queue // {}) | to_entries[] | select(.value | type == "number") | .key' "$state_file" 2>/dev/null); do
        [[ "$issue" =~ ^[0-9]+$ ]] || continue
        tmp=$(mktemp)
        if closed_done_label "$issue"; then
            closed_done_finish "$issue" "$state_file"
            continue
        fi
        tries=$(jq -r --arg i "$issue" '((.closed_done_queue // {})[$i] // 0) + 1' "$state_file")
        if [ "$tries" -ge "$cap" ]; then
            log "⚠️ issue #$issue 关闭后的 $LABEL_DONE 连续 $tries 次没打成 → 放弃（请手动打 $LABEL_DONE、摘掉流程标签）"
            closed_done_finish "$issue" "$state_file"
        else
            jq --arg i "$issue" --argjson n "$tries" '.closed_done_queue[$i] = $n' "$state_file" > "$tmp" && mv "$tmp" "$state_file"
        fi
    done
}

# 父 issue 一侧发现「子项全部完成」（GitHub#233）：子项留给人关、子项在别的仓库时，合并钩子都等不到它关闭；
# 改由父 issue 所在仓库每轮看打开列表里的子项统计（sub_issues_summary，列表自带，不多发请求）：
# 挂着 pending/PR、有子项、已完成数 = 总数、还没按这个总数汇总过 → 走同一个汇总（它自己再读全子项列表核对）。
sub_issue_rollup_discover() {   # <state_file>
    local sf="$1" pages rows p n
    # 只用本轮已经读过的打开列表，不为它多发请求（这一轮没读过就下一轮）
    [ -s "${TICK_DIR:-/nonexistent}/issues.json" ] || return 0
    pages=$(open_snapshot issues) || return 0
    # 只看还挂着 pending/PR（拆分那一步设的状态）的父 issue：早就交给人、故意留着的旧父 issue 不去打扰
    rows=$(printf '%s' "$pages" | jq -r --arg P "$LABEL_PENDING_PR" '.[][] | select(.pull_request == null)
        | select(any(.labels[]?; .name == $P))
        | select((.sub_issues_summary.total // 0) > 0 and .sub_issues_summary.completed == .sub_issues_summary.total)
        | "\(.number)\t\(.sub_issues_summary.total)"' 2>/dev/null) || return 0
    while IFS=$'\t' read -r p n; do
        [ -n "$p" ] || continue
        [ "$(jq -r --arg p "$p" '.split_rollups[$p] // empty' "$sf" 2>/dev/null)" != "$n" ] || continue
        sub_issue_rollup_parent "$p" "$sf" || true
    done <<< "$rows"
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

# ── 等前置：前置完成后自动接着干（GitHub#157）──
# 前置是谁，从两处取并集（只认本仓库）：
#   · GitHub 原生「Blocked by」关系（issue 侧栏 Relationships；有写权限的人才改得了）。
#     实测（2026-11-06，GigleAI/cavil-loop）：前置只能是 issue，把 PR 设成前置报 422
#     「Target issue may only be an issue」；PR 本身的这个列表读得到（200，空）
#   · 评论里的隐藏标记 `<!-- agent-blocked-by: #12 OWNER/REPO#34 resume=<触发标签> -->`（`#12` 是本仓库，
#     `OWNER/REPO#34` 是别的仓库，GitHub#243；写成本仓库自己的全名等同 `#12`）：只认 loop 的写入账号
#     或仓库维护者（OWNER / MEMBER / COLLABORATOR）发的，而且发在「最近一次摘掉等前置标签」之后
#     （属于这一轮等待）；多条取最新一条。等 PR、或被挡的本身是 PR，都靠它。
#     「之后」是严格晚于：GitHub 的时间只到秒，和摘标签同一秒的登记分不出先后，按上一轮的算、不认
#     （代码复审第 1 轮：同秒的旧登记曾被当成本轮前置自动开工）。daemon 自己的结论评论（带
#     agent-blocked-resolved）里有给人照抄的标记写法，一律不当登记
# 普通评论里的「等 #12」这类文字不认：任何人都能写，让它决定什么时候自动开工等于把派工开关交出去。
#
# 完成的口径：issue 以 completed 关闭；PR 已合并。其余关闭（not planned / duplicate / 没写原因 /
# PR 没合就关 / 读到 404）都是「失败收场」→ 交人。
#
# 别的仓库的前置（GitHub#243）：标记里的 OWNER/REPO#N 和侧栏「Blocked by」里别的仓库的 issue 都当前置，
# 但只认互通名单 TRUSTED_REPOS 里的仓库（GitHub#233），名单外的不读、交人（v=foreign）。名单内的用轮询身份只读 repos/OWNER/REPO/issues/N，结局判法和本仓库同一段代码。读不到分三种：
# 404 / 410（不存在、已删除，或私有仓库令牌无权读——GitHub 对后者也回 404）和不是限流的 403（无权读）
# 等多久都不会自己好 → 结局记「读不到」，算失败收场交人、写明原因；其余失败（网络、限流、5xx）→ 判不了。
# 本仓库的前置读到 403 仍是判不了（和以前一样）。daemon 从不往别的仓库写任何东西。
# 前置在判定里是 {r, n}：r 空 = 本仓库，否则是小写的 owner/repo（GitHub 仓库名不分大小写）。
#
# 一个判定函数（blocked_decide）判两次：第一次决定要不要动手，要写之前**全部重新读**再判一次，
# 两次的完整结论（打标签那次事件、前置集合、恢复标签、每个前置的结局）一字不差才写。判完之后
# 有人加了新前置、加了 pending/human、摘了又挂了等前置标签、前置被重开，第二次都会不一样。
# 「读不到 / 读不全」一律判不了（return 2）：不写、下一轮再看，绝不当成「已完成」或「没有前置」。

BLOCKED_MARK='<!-- agent-blocked-by:'

# 挂着就说明这条活不归「等前置」管：人叫停了，或已经在别的流程里
blocked_stop_labels() {
    [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
    printf '%s\n' "$LABEL_PENDING_HUMAN" "$LABEL_AGENT_DOING" "$LABEL_DONE" "$LABEL_PENDING_PR" \
        "${LABEL_PENDING_REVIEW:-}" "${LABEL_PENDING_MERGE:-}" "${LABEL_PENDING_REQUESTER_BOT:-}" \
        "${TRIGGER_LABELS_ALL[@]}" | awk 'NF && !seen[$0]++'
}

blocked_stop_reason() {   # <labels_csv> → stdout 挡住它的标签；return 1 = 没挡
    local l
    while IFS= read -r l; do
        case ",${1}," in *",$l,"*) printf '%s' "$l"; return 0 ;; esac
    done < <(blocked_stop_labels)
    return 1
}

# 判不了：原因写进 BLOCKED_REASON，同时打到 stdout（调用方在 $( ) 里调，变量带不出来）
_bfail() { BLOCKED_REASON="$1"; printf '%s\n' "$1"; }

# 互通名单（小写 JSON 数组，不含本仓库）
blocked_trusted_json() {
    # -s：名单为空时也要输出 []（-R 逐行读，空输入一行都没有、什么都不输出——GitHub#243 起名单为空也要用它）
    printf '%s' "${TRUSTED_REPOS:-}" | tr ',' ' ' | tr '[:upper:]' '[:lower:]' | jq -Rsc '[splits("[ \t\n]+")] | map(select(. != ""))'
}

# 判定。stdout 一行 JSON（键固定顺序，两次判定直接按字符串比）：
#   {v, event, set:[{r,n}], resume, pre:[{r,n,o}], why}
#   v = resume（全部完成）/ failed（有前置失败收场）/ none（读全了却没有前置）
#       / foreign（有不在互通名单里的别的仓库的前置）/ wait（还有没完成的）/ skip（不归这里管：关了、标签没了、人叫停或在别的流程里）
# return 0 = 判得出；2 = 判不了（原因在 stdout）
blocked_decide() {   # <编号>
    local num="$1" item labels_csv stop ev ep comments me deps self_set mark pre_json p pj o out resume
    BLOCKED_REASON=""
    if ! item=$(gh api "repos/$REPO/issues/$num" 2>/dev/null) || [ -z "$item" ]; then
        _bfail "读不到 #$num"; return 2
    fi
    if ! printf '%s' "$item" | jq -e '(.number != null) and (.state != null) and (.labels | type == "array")' >/dev/null 2>&1; then
        _bfail "#$num 的内容缺字段"; return 2
    fi
    if [ "$(printf '%s' "$item" | jq -r .state)" != open ]; then
        jq -cn '{v:"skip", event:null, set:[], resume:"", pre:[], why:"closed"}'; return 0
    fi
    labels_csv=$(printf '%s' "$item" | jq -r '[.labels[].name] | join(",")')
    if ! labels_have_blocked "$labels_csv"; then
        jq -cn '{v:"skip", event:null, set:[], resume:"", pre:[], why:"no-label"}'; return 0
    fi
    if stop=$(blocked_stop_reason "$labels_csv"); then
        jq -cn --arg s "$stop" '{v:"skip", event:null, set:[], resume:"", pre:[], why:("stopped:" + $s)}'; return 0
    fi

    # 这一轮等待：等前置标签最后一次打上的那条事件（id 是这一轮的身份），以及它之前最后一次摘掉的时间
    if ! ev=$(gh api --paginate --slurp "repos/$REPO/issues/$num/events" 2>/dev/null) || [ -z "$ev" ]; then
        _bfail "读不到 #$num 的标签记录"; return 2
    fi
    if ! ep=$(printf '%s' "$ev" | jq -c --arg L "$LABEL_PENDING_BLOCKED" '
        [ .[][]? | select((.event == "labeled" or .event == "unlabeled") and ((.label.name // "") == $L)) ]
        | { last: (last.event // ""),
            id: (map(select(.event == "labeled")) | last | .id // null),
            since: (map(select(.event == "unlabeled")) | last | .created_at // "") }' 2>/dev/null) || [ -z "$ep" ]; then
        _bfail "读不懂 #$num 的标签记录"; return 2
    fi
    if [ "$(printf '%s' "$ep" | jq -r .last)" != labeled ] || [ "$(printf '%s' "$ep" | jq -r '.id // ""')" = "" ]; then
        _bfail "#$num 的标签记录和当前标签对不上（找不到打上等前置标签的那一次）"; return 2
    fi

    me=$(write_identity_login)
    if [ -z "$me" ]; then _bfail "读不到 loop 的写入账号，无法核对前置标记是谁写的"; return 2; fi
    if ! comments=$(gh api --paginate --slurp "repos/$REPO/issues/$num/comments" 2>/dev/null) || [ -z "$comments" ]; then
        _bfail "读不到 #$num 的评论"; return 2
    fi
    if ! mark=$(printf '%s' "$comments" | jq -c --arg M "$BLOCKED_MARK" --arg me "$me" --arg self "$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')" --arg since "$(printf '%s' "$ep" | jq -r .since)" '
        [ .[][]? | select((.body // "") | contains($M))
          | select(((.user.login // "") | ascii_downcase) == ($me | ascii_downcase)
                   or ((.author_association // "") as $a | ["OWNER","MEMBER","COLLABORATOR"] | index($a)))
          | select((.body | contains("<!-- agent-blocked-resolved")) | not)
          | select($since == "" or (.created_at // "") > $since) ]
        | sort_by(.created_at // "", .id // 0) | last
        | if . == null then {set: [], resume: ""} else
            (.body | [ match("<!-- agent-blocked-by:([^>]*)-->"; "g") ] | last | .captures[0].string // "") as $m
            | { set: ([ $m | scan("(?<![A-Za-z0-9_./-])([A-Za-z0-9][A-Za-z0-9-]*/\\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*)?#([0-9]+)")
                          | {r: ((.[0] // "") | ascii_downcase | if . == $self then "" else . end), n: (.[1] | tonumber)} ] | unique),
                resume: (first($m | capture("resume=(?<r>[^ ]+)") | .r) // "") } end' 2>/dev/null) || [ -z "$mark" ]; then
        _bfail "读不懂 #$num 评论里的前置标记"; return 2
    fi
    if ! deps=$(gh api --paginate --slurp "repos/$REPO/issues/$num/dependencies/blocked_by" 2>/dev/null) || [ -z "$deps" ]; then
        _bfail "读不到 #$num 的「Blocked by」关系"; return 2
    fi
    # 侧栏关系按条目所属仓库归类（repository_url 的末两段）；仓库或编号读不出来 → 判不了
    if ! self_set=$(printf '%s' "$deps" | jq -c --arg self "$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')" '
        [ .[][]? | { r: ((.repository_url // "") | ascii_downcase
                         | (capture("/repos/(?<x>[^/]+/[^/]+)$").x // "?") | if . == $self then "" else . end),
                     n: .number } ]
        | if any(.[]; .r == "?" or (.n | type) != "number") then error("bad") else . end' 2>/dev/null) || [ -z "$self_set" ]; then
        _bfail "读不懂 #$num 的「Blocked by」关系"; return 2
    fi

    # 恢复用哪个触发标签：标记里写的，必须是本项目配置的触发标签之一；没写 / 不认识 → 默认那个
    resume=$(printf '%s' "$mark" | jq -r .resume)
    [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
    local t ok=""
    for t in "${TRIGGER_LABELS_ALL[@]}"; do [ "$t" = "$resume" ] && ok=1; done
    [ -n "$ok" ] || resume="$LABEL_PENDING_AGENT_DEFAULT"

    local base
    base=$(jq -cn --argjson e "$(printf '%s' "$ep" | jq .id)" --argjson a "$mark" --argjson b "$self_set" --arg r "$resume" --argjson me "$num" \
        '{event: $e, set: (($a.set + $b) | unique | map(select(.r != "" or .n != $me))), resume: $r}')
    # 别的仓库只认互通名单里的（GitHub#233 的维护者决定：没有名单就限定不了读哪些仓库）；名单外的一律
    # 不读、交人。名单为空时别的仓库的前置都走这里——不再像以前那样丢掉仓库名、按本仓库同号去判（GitHub#243）
    if ! base=$(printf '%s' "$base" | jq -c --argjson T "$(blocked_trusted_json)" \
            '. + {foreign: [ .set[] | select(.r != "" and (.r as $o | $T | index($o) | not)) | "\(.r)#\(.n)" ]}') || [ -z "$base" ]; then
        _bfail "读不懂互通名单"; return 2
    fi
    if [ "$(printf '%s' "$base" | jq '.foreign | length')" -gt 0 ]; then
        printf '%s' "$base" | jq -c '{v:"foreign", event, set, resume, pre:[], why:(.foreign | join(" "))}'; return 0
    fi
    if [ "$(printf '%s' "$base" | jq '.set | length')" = 0 ]; then
        printf '%s' "$base" | jq -c '{v:"none", event, set, resume, pre:[], why:""}'; return 0
    fi

    pre_json='[]'
    local pr name
    # 分隔符不能用制表符：本仓库的 r 是空串，IFS 里的空白会把开头的空字段吞掉
    while IFS='|' read -r pr p; do
        [ -n "$p" ] || continue
        name=$(blocked_pre_name "$pr" "$p")
        if ! pj=$(gh api "repos/${pr:-$REPO}/issues/$p" 2>&1); then
            if [ -z "$pr" ] && printf '%s' "$pj" | grep -q 'HTTP 404'; then
                o=missing
            elif [ -n "$pr" ] && printf '%s' "$pj" | grep -qE 'HTTP 404|HTTP 410'; then
                o=unreadable
            elif [ -n "$pr" ] && printf '%s' "$pj" | grep -q 'HTTP 403' && ! printf '%s' "$pj" | grep -qiE 'rate limit|abuse'; then
                o=forbidden
            else
                _bfail "读不到前置 $name"; return 2
            fi
        elif ! o=$(printf '%s' "$pj" | jq -r '
            if (.state // "") == "" then "?"
            elif .pull_request != null then
                (if (.pull_request | has("merged_at") | not) then "?"
                 elif .pull_request.merged_at != null then "merged"
                 elif .state == "closed" then "closed-unmerged" else "open" end)
            elif .state == "open" then "open"
            elif .state_reason == "completed" then "completed"
            else "closed-" + (.state_reason // "no-reason") end' 2>/dev/null) || [ "$o" = "?" ] || [ -z "$o" ]; then
            _bfail "前置 $name 的状态缺字段"; return 2
        fi
        pre_json=$(printf '%s' "$pre_json" | jq -c --arg r "$pr" --argjson n "$p" --arg o "$o" '. + [{r: $r, n: $n, o: $o}]')
    done < <(printf '%s' "$base" | jq -r '.set[] | "\(.r)|\(.n)"')
    out=$(printf '%s' "$base" | jq -c --argjson pre "$pre_json" '
        del(.foreign) | ($pre | map(.o)) as $os
        | {v: (if any($os[]; . == "missing" or . == "unreadable" or . == "forbidden" or startswith("closed-")) then "failed"
               elif any($os[]; . == "open") then "wait" else "resume" end),
           event, set, resume, pre: $pre, why: ""}')
    printf '%s\n' "$out"
}

# 前置在评论 / 日志里的写法：本仓库 #12，别的仓库 owner/repo#12
blocked_pre_name() {   # <r> <n>
    if [ -n "$1" ]; then printf '%s#%s' "$1" "$2"; else printf '#%s' "$2"; fi
}

blocked_outcome_text() {   # <o>
    case "$1" in
        merged) printf '已合并' ;;
        completed) printf '已完成并关闭' ;;
        open) printf '还开着' ;;
        closed-unmerged) printf 'PR 没合并就关了' ;;
        closed-not_planned) printf '关闭为「不做」' ;;
        closed-duplicate) printf '关闭为「重复」' ;;
        closed-no-reason) printf '已关闭，但没写关闭原因（不算完成）' ;;
        missing) printf '读不到（不存在或已转走）' ;;
        unreadable) printf '读不到（不存在、已删除，或轮询用的令牌无权读这个仓库）' ;;
        forbidden) printf '读不到（轮询用的令牌无权读这个仓库）' ;;
        closed-*) printf '已关闭（%s，不算完成）' "${1#closed-}" ;;
        *) printf '%s' "$1" ;;
    esac
}

blocked_state_set() {   # <state_file> <jq 表达式> [jq 参数…]
    local sf="$1" e="$2" tmp; shift 2
    tmp=$(mktemp)
    if jq "$@" "$e" "$sf" > "$tmp" 2>/dev/null; then mv "$tmp" "$sf"; else rm -f "$tmp"; return 1; fi
}

# 判定已定（两次一致）后写 GitHub：先评论、再加目标标签、最后摘等前置标签。
# 进度按「编号 + 这一轮等待的事件 id」记在 state.json 的 blocked_resume 里，评论和翻标签分开记，
# 重试不重复评论；标签摘了又挂是新事件 id，旧进度作废。
# 先加后摘：加成功、摘失败时条目同时挂着触发标签和等前置标签，下一轮照常派工、派工时一并摘掉；
# 反过来（先摘后加，加失败）条目就什么标签都没有了。
blocked_apply() {   # <state_file> <编号> <判定 JSON>
    local sf="$1" num="$2" d="$3" v event rec commented tries target body out
    v=$(printf '%s' "$d" | jq -r .v); event=$(printf '%s' "$d" | jq -r .event)
    rec=$(jq -c --arg n "$num" '(.blocked_resume // {})[$n] // {}' "$sf" 2>/dev/null) || rec='{}'
    if [ "$(printf '%s' "$rec" | jq -r '.event // "" | tostring')" != "$event" ]; then
        rec=$(jq -cn --argjson e "$event" '{event: $e, commented: false, tries: 0}')
    fi
    if [ "$(printf '%s' "$rec" | jq -r '.gaveup // false')" = true ]; then
        blocked_state_set "$sf" '.blocked_resume[$n].checked_at = $t' --arg n "$num" --argjson t "$(pace_now)" || true
        log_debug "等前置：#$num 这一轮的写入早已放弃（连续失败到上限），不再重试；摘掉重挂等前置标签即重新开始"
        return 0
    fi
    commented=$(printf '%s' "$rec" | jq -r '.commented // false')
    tries=$(printf '%s' "$rec" | jq -r '.tries // 0')
    if [ "$v" = resume ]; then target=$(printf '%s' "$d" | jq -r .resume); else target="$LABEL_PENDING_HUMAN"; fi

    local ok=1
    if [ "$commented" != true ]; then
        body=$(blocked_comment_body "$d")
        if run_gh "等前置：#$num 留言" gh_write api -X POST "repos/$REPO/issues/$num/comments" -f "body=$body"; then
            commented=true; BLOCKED_ACTED=1
            rec=$(printf '%s' "$rec" | jq -c '.commented = true')
            blocked_state_set "$sf" '.blocked_resume = ((.blocked_resume // {}) + {($n): $r})' --arg n "$num" --argjson r "$rec" || true
        else
            ok=0
        fi
    fi
    if [ "$ok" = 1 ]; then
        if run_gh "等前置：#$num 加 $target" gh_write api -X POST "repos/$REPO/issues/$num/labels" -f "labels[]=$target"; then
            BLOCKED_ACTED=1
            if ! out=$(gh_write api -X DELETE "repos/$REPO/issues/$num/labels/$(printf '%s' "$LABEL_PENDING_BLOCKED" | jq -sRr @uri)" 2>&1) \
               && ! printf '%s' "$out" | grep -q 'HTTP 404'; then
                log "  ⚠️ 等前置：#$num 摘 $LABEL_PENDING_BLOCKED 失败: $out"
                ok=0
            fi
        else
            ok=0
        fi
    fi
    if [ "$ok" = 1 ]; then
        blocked_state_set "$sf" 'del(.blocked_resume[$n])' --arg n "$num" || true
        case "$v" in
            resume) log "等前置：#$num 的前置全部完成（$(printf '%s' "$d" | jq -r '.set | map(.r + "#" + (.n | tostring)) | join(" ")')）→ $target，下一轮派工" ;;
            *) log "等前置：#$num 交人（$v）→ $LABEL_PENDING_HUMAN" ;;
        esac
        return 0
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge "$BLOCKED_MAX_TRIES" ]; then
        log "⚠️ 等前置：#$num 判定已定（$v），但写 GitHub 连续 $tries 次失败 → 放弃，留在 $LABEL_PENDING_BLOCKED 上，请人工处理"
        rec=$(printf '%s' "$rec" | jq -c --argjson t "$tries" '.tries = $t | .gaveup = true')
    else
        log "等前置：#$num 判定已定（$v），写 GitHub 没做完（第 $tries/$BLOCKED_MAX_TRIES 次），下轮重试"
        rec=$(printf '%s' "$rec" | jq -c --argjson t "$tries" '.tries = $t')
    fi
    blocked_state_set "$sf" '.blocked_resume = ((.blocked_resume // {}) + {($n): $r})' --arg n "$num" --argjson r "$rec" || true
    return 1
}

# 交人评论里「怎么继续」的步骤（失败收场 / 找不到前置共用）。要人照做，所以写全：在哪改前置、
# 怎么解除人工等待、怎么重新挂、看到什么算成功（代码复审第 1 轮：只写「重新挂等前置标签」，
# 人照做后 pending/human 还在，daemon 按叫停处理，条目永远卡住）。
blocked_recovery_steps() {   # <failed|none>
    local fix
    if [ "$1" = failed ]; then
        fix="1. **更新前置**：本条侧栏 Relationships 的「Blocked by」里如果有上面那个失败收场的条目，点它旁边的 × 去掉；要等的新 issue 在同一处用「Add blocked by」加上（只能加 issue）"
    else
        fix="1. **登记前置**：要等的 issue 在本条侧栏 Relationships 里用「Add blocked by」加上（只能加 issue）"
    fi
    printf '**接着等别的前置**（按顺序做）：\n\n%s；要等的是 PR，就在本条发一条评论，单独一行写 `<!-- agent-blocked-by: #编号 -->`（多个编号用空格隔开；别的仓库的写成 `OWNER/REPO#编号`，那个仓库要在本项目的互通名单里；以前的登记不用删，daemon 只认这次之后的）\n2. **解除人工等待**：摘掉本条的 `%s` 标签\n3. **重新挂** `%s`\n\n成功的样子：前置还没完成时，本条一直只挂着 `%s`，daemon 不留言；前置完成后几分钟内，daemon 留一条「前置已完成，自动继续」并改挂 `%s`。如果又出现一条「找不到在等谁」，说明第 1 步的登记没被认出（登记评论要由有写权限的人发）。\n\n**不需要再等**：摘掉 `%s`，打 `%s` 接着干。\n' \
        "$fix" "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_BLOCKED" "$LABEL_PENDING_BLOCKED" "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_AGENT_DEFAULT"
}

blocked_comment_body() {   # <判定 JSON>
    local d="$1" v list r n o access=""
    v=$(printf '%s' "$d" | jq -r .v)
    list=""
    while IFS='|' read -r r n o; do
        [ -n "$n" ] || continue
        list+="- $(blocked_pre_name "$r" "$n")：$(blocked_outcome_text "$o")"$'\n'
        case "$o" in unreadable|forbidden) access=1 ;; esac
    done < <(printf '%s' "$d" | jq -r '.pre[] | "\(.r)|\(.n)|\(.o)"')
    case "$v" in
        resume)
            printf '## 前置已完成，自动继续\n\n本条在等的前置都已完成：\n\n%s\n已摘掉 `%s`、改挂 `%s`，daemon 下一轮派工接着干。本条不需要人做任何事；想先拦住，给本条加 `%s`。\n' \
                "$list" "$LABEL_PENDING_BLOCKED" "$(printf '%s' "$d" | jq -r .resume)" "$LABEL_PENDING_HUMAN" ;;
        failed)
            printf '## 前置没有完成，交给人决定\n\n本条在等的前置里有以失败收场的，daemon 不会自动继续：\n\n%s\n已摘掉 `%s`、改挂 `%s`。\n\n' \
                "$list" "$LABEL_PENDING_BLOCKED" "$LABEL_PENDING_HUMAN"
            [ -z "$access" ] || printf '「读不到」的是别的仓库的条目：GitHub 对不存在和私有仓库无权读取都回 404，daemon 分不出是哪种。先在浏览器里打开它确认编号和仓库名写对了；条目在私有仓库的，给 daemon 轮询用的令牌加上那个仓库的读权限，再照下面的步骤重新挂。\n\n' 
            blocked_recovery_steps failed ;;
        none)
            printf '## 挂了等前置标签，但找不到在等谁\n\n本条挂着 `%s`，可是侧栏 Relationships 的「Blocked by」是空的，这一轮等待里也没有可信的前置登记，daemon 不知道该等谁，已摘掉 `%s`、改挂 `%s`。\n\n' \
                "$LABEL_PENDING_BLOCKED" "$LABEL_PENDING_BLOCKED" "$LABEL_PENDING_HUMAN"
            blocked_recovery_steps none ;;
        foreign)
            printf '## 前置在互通名单以外的仓库，daemon 不去查\n\n本条登记的前置里有别的仓库的条目（%s），这个仓库不在本项目的互通名单里，daemon 不读它的状态，已摘掉 `%s`、改挂 `%s`。\n\n' \
                "$(printf '%s' "$d" | jq -r .why)" "$LABEL_PENDING_BLOCKED" "$LABEL_PENDING_HUMAN"
            printf '**要 daemon 自动等它**：维护者在本项目轮询用的配置文件里，把这个仓库（`owner/repo` 形式）加进 `TRUSTED_REPOS`（逗号分隔），再照下面的步骤重新挂。不加名单，就等它完成后照最后一条「不需要再等」手动接着干。\n\n'
            blocked_recovery_steps none ;;
    esac
    printf '\n<!-- agent-blocked-resolved event=%s v=%s -->\n%s\n' "$(printf '%s' "$d" | jq -r .event)" "$v" "$(autopilot_daemon_sig)"
}

# 每轮一次。BLOCKED_WAITING=1 表示本轮看到了真在等前置的条目（轮询退避据此封顶）；
# BLOCKED_ACTED=1 表示本轮往 GitHub 写了东西。功能关闭时第一行就返回，一次调用都不发。
BLOCKED_WAITING=0
BLOCKED_ACTED=0
blocked_tick() {   # <state_file>
    local sf="$1" rows kind num labels_csv nums="" now rec checked d1 d2 rc v stop
    BLOCKED_WAITING=0; BLOCKED_ACTED=0
    blocked_enabled || return 0
    rows=""
    for kind in issue pr; do
        rows+=$(snapshot_rows "$kind" "$LABEL_PENDING_BLOCKED" 2>/dev/null | cut -f1,4)$'\n' || true
    done
    # 已经不在等的条目（标签摘了、关了）清掉进度
    while IFS=$'\t' read -r num _; do [ -n "$num" ] && nums+="$num,"; done <<< "$rows"
    if jq -e 'has("blocked_resume")' "$sf" >/dev/null 2>&1; then
        blocked_state_set "$sf" '.blocked_resume |= with_entries(select(.key as $k | ($keep | split(",") | index($k))))' --arg keep "$nums" || true
    fi
    now=$(pace_now)
    # 写入账号在主 shell 里先取一次（缓存），判定在 $( ) 里调，不然每次判定都要重新问一遍
    write_identity_login >/dev/null || true
    while IFS=$'\t' read -r num labels_csv; do
        [ -n "$num" ] || continue
        if stop=$(blocked_stop_reason "$labels_csv"); then
            log_debug "等前置：#$num 同时挂着 $stop，不归这里管"
            continue
        fi
        # 真在等前置的才算（人叫停的、在别的流程里的不用为它加快轮询）
        BLOCKED_WAITING=1
        rec=$(jq -c --arg n "$num" '(.blocked_resume // {})[$n] // {}' "$sf" 2>/dev/null) || rec='{}'
        checked=$(printf '%s' "$rec" | jq -r '.checked_at // 0')
        if [[ "$checked" =~ ^[0-9]+$ ]] && [ "$now" -ge "$checked" ] && [ $((now - checked)) -lt "$BLOCKED_RECHECK_SECS" ]; then
            continue
        fi
        rc=0; d1=$(blocked_decide "$num") || rc=$?
        if [ "$rc" != 0 ]; then
            log "等前置：#$num 判不了（${d1:-?}），本轮不动，下轮再看"
            blocked_state_set "$sf" '.blocked_resume[$n] = (((.blocked_resume // {})[$n] // {}) + {checked_at: $t})' --arg n "$num" --argjson t "$now" || true
            continue
        fi
        v=$(printf '%s' "$d1" | jq -r .v)
        case "$v" in
            skip) continue ;;
            wait)
                log_debug "等前置：#$num 还在等（$(printf '%s' "$d1" | jq -r '[.pre[] | select(.o == "open") | .r + "#" + (.n | tostring)] | join(" ")')）"
                blocked_state_set "$sf" '.blocked_resume[$n] = (((.blocked_resume // {})[$n] // {}) + {checked_at: $t})' --arg n "$num" --argjson t "$now" || true
                continue ;;
        esac
        # 要写了：全部重新读、再判一次，结论必须一字不差
        rc=0; d2=$(blocked_decide "$num") || rc=$?
        if [ "$rc" != 0 ] || [ "$d2" != "$d1" ]; then
            if [ "$rc" != 0 ]; then
                log "等前置：#$num 写之前重读判不了（${d2:-?}），本轮不写"
            else
                log "等前置：#$num 写之前重读，结论变了（$(printf '%s' "$d1" | jq -r .v) → $(printf '%s' "$d2" | jq -r .v)），本轮不写"
            fi
            continue
        fi
        blocked_apply "$sf" "$num" "$d1" || true
    done <<< "$rows"
    return 0
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
# 返回值的含义不变（合并后通知、托管判定只看它）；另外给叫醒入口一个更细的分类（GitHub#133）：
#   REQUESTER_BOT_ORIGIN_CLASS = bot           是机器人提的（返回 0）
#                                linked-other  关联确定、但不是机器人提的（返回 1）；
#                                              REQUESTER_BOT_LINKED = 关联的 issue（issue 本身就是自己）
#                                none          PR 确定没有关联 issue（返回 1）
#                                unknown       判不了：读失败（返回 2），或关联有歧义 / 关联的是 PR（返回 1）
# 只有 linked-other / none 允许走「非机器人条目」的叫醒；unknown 一律拒绝。
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
    REQUESTER_BOT_ORIGIN_CLASS=unknown; REQUESTER_BOT_LINKED=""
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
                return 1   # 分类保持 unknown
            fi
            origin="$by_line"
        fi
        case "$origin" in ''|*[!0-9]*)
            [ -n "$origin" ] || REQUESTER_BOT_ORIGIN_CLASS=none
            REQUESTER_BOT_REASON="PR #$num 没有关联 issue（分支名 ${branch:-?} 不带编号，正文里也没有 Closes #N 这类写法）"
            return 1 ;;
        esac
        [ "$origin" != "$num" ] || { REQUESTER_BOT_ORIGIN_CLASS=none; REQUESTER_BOT_REASON="PR #$num 没有关联 issue（关联编号就是它自己）"; return 1; }
        ojson=$(gh api "repos/$REPO/issues/$origin") || { REQUESTER_BOT_REASON="读不到关联的 issue #$origin"; return 2; }
        if [ "$(printf '%s' "$ojson" | jq -r 'has("pull_request") and .pull_request != null')" != false ]; then
            REQUESTER_BOT_REASON="PR #$num 关联的 #$origin 是 PR，不是 issue"
            return 1
        fi
    fi
    author=$(printf '%s' "$ojson" | jq -r '.user.login // ""')
    if [ "$(requester_bot_lc "$author")" != "$(requester_bot_lc "$REQUESTER_BOT_ACCOUNT")" ]; then
        REQUESTER_BOT_ORIGIN_CLASS=linked-other; REQUESTER_BOT_LINKED="$origin"
        REQUESTER_BOT_REASON="#$origin 不是外部需求机器人提的需求（作者是 ${author:-未知}，不是 $REQUESTER_BOT_ACCOUNT）"
        return 1
    fi
    if ! printf '%s' "$ojson" | jq -e --arg m "$REQUESTER_BOT_ORIGIN_MARKER" '(.body // "") | contains($m)' >/dev/null; then
        REQUESTER_BOT_ORIGIN_CLASS=linked-other; REQUESTER_BOT_LINKED="$origin"
        REQUESTER_BOT_REASON="#$origin 正文里没有外部需求标记"
        return 1
    fi
    REQUESTER_BOT_ORIGIN_CLASS=bot
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
# 上限可用环境变量 REQUESTER_BOT_WEBHOOK_TIMEOUT 改（GitHub#211，测试用来缩短真实等待）：只认
# 1–600 的正整数，未设置、空、0、负数、非数字、带前导 0 等一律按 10 秒。
# --globoff：地址按字面发。curl 默认把 [1-2]、{a,b} 当范围展开成多个请求（写在配置文本里
# 也照样展开），一次叫醒就变成多次 POST，状态码还会拼成 200200 被误记成「连接失败」。
REQUESTER_BOT_WEBHOOK_RESULT=""
requester_bot_webhook_notify() {
    local num="$1" kind="$2" mode go body conf code rc limit=10
    REQUESTER_BOT_WEBHOOK_RESULT=""
    if [[ "${REQUESTER_BOT_WEBHOOK_TIMEOUT:-}" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$REQUESTER_BOT_WEBHOOK_TIMEOUT" -le 600 ]; then
        limit="$REQUESTER_BOT_WEBHOOK_TIMEOUT"
    fi
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
        --proto =http,https --max-redirs 0 --max-time "$limit" 2>/dev/null) || rc=$?
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

# ═════════════════════════════════════════════════════════════════════════
# ── 托管标签：授权、绑定、合并（GitHub#114）──
# 三个判断各只有一份实现，派工（autopilot_for_item）、合并检查与合并前重读
# （autopilot_merge_one）都调它们：
#   autopilot_pr_kind        PR 属于哪一种：绑 issue（分支名与正文关闭关键词同时指向同一个 issue，
#                            autopilot_pr_binding）/ 以 PR 为准（没绑 issue、正文不关本仓库任何 issue，
#                            GitHub#142）/ 不合条件
#   autopilot_authorization  托管授权是否有效：最近一次打上托管标签的是有写权限的真人；以 PR 为准时
#                            只看 PR，而且打标签那一刻的 PR 正文也得是「以 PR 为准」那一种
#   叫停                     摘了托管标签，或挂 pending/human（绑 issue 时看 issue 和 PR 两处，以 PR 为准时只看 PR）
# 读不到（网络、接口报错）一律算「判不了」：不当成有授权，也不当成没授权，本轮不写、下轮再查。
# ═════════════════════════════════════════════════════════════════════════
AUTOPILOT_ACTED=0
AUTOPILOT_REASON=""; AUTOPILOT_DENY=""; AUTOPILOT_ACTOR=""; AUTOPILOT_ISSUE=""; AUTOPILOT_PR=""
AUTOPILOT_PR_KIND=""; AUTOPILOT_PR_N=""
AUTOPILOT_AUTH_KIND=""; AUTOPILOT_AUTH_NUM=""; AUTOPILOT_AUTH_T=""; AUTOPILOT_AUTH_IDX=""; AUTOPILOT_AUTH_REPO=""
AUTOPILOT_PR_EVENTS=""; AUTOPILOT_PLACE=""; AUTOPILOT_PLACE_EVENTS=""; AUTOPILOT_AUTH_CANDS=""
AUTOPILOT_PLACE_COPY=""; AUTOPILOT_PR_COPY=""; AUTOPILOT_PR_COPY_READ=""

# 托管标签配了（不管复审关卡在不在）
autopilot_configured() { [ -n "$LABEL_AUTOPILOT" ]; }
# 真正生效：托管标签 + 复审关卡都在。没有复审 = 没人把关，不托管。
autopilot_enabled() { [ -n "$LABEL_AUTOPILOT" ] && [ -n "${LABEL_PENDING_REVIEW:-}" ] && [ -n "$LABEL_PENDING_MERGE" ]; }

# 改 state.json 的 .autopilot 子树。<jq 表达式> 作用于 .autopilot；之后的参数原样交给 jq（--arg …）。
# 功能关闭时没有任何调用方，state.json 不会多出这个字段。
autopilot_state_set() {   # <state_file> <jq 表达式> [jq 参数…]
    local sf="$1" expr="$2" tmp
    shift 2
    tmp=$(mktemp)
    if jq "$@" ".autopilot = ((.autopilot // {}) | $expr)" "$sf" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$sf"
    else
        rm -f "$tmp"
        log "  ⚠️ 托管状态写入失败：$expr"
        return 1
    fi
}
autopilot_state_get() {   # <state_file> <jq 表达式（作用于 .autopilot）> [jq 参数…]
    local sf="$1" expr="$2"
    shift 2
    jq -r "$@" "(.autopilot // {}) | ($expr) // \"\"" "$sf" 2>/dev/null || true
}

# 本轮快照里的一条（issues / pulls），找不到输出空；快照读不到 return 1
autopilot_snapshot_item() {   # <issues|pulls> <编号>
    local pages
    pages=$(open_snapshot "$1") || return 1
    printf '%s' "$pages" | jq -c --argjson n "$2" 'first(.[][] | select(.number == $n)) // empty' 2>/dev/null
}

# labels_csv 是否已经在某个流程里（状态 / 触发 / 挡工标签）：在 = 只挂托管标签的 issue 不当新活派
autopilot_labels_in_flow() {   # <labels_csv>
    local csv=",$1," t
    greedy_skip_reason "$1" >/dev/null && return 0
    if [ -n "$LABEL_PENDING_MERGE" ]; then
        case "$csv" in *",$LABEL_PENDING_MERGE,"*) return 0 ;; esac
    fi
    [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
    for t in "${TRIGGER_LABELS_ALL[@]}"; do
        case "$csv" in *",$t,"*) return 0 ;; esac
    done
    return 1
}

# 正文里的关闭关键词（GitHub 会在合并时关掉的那些 issue）。两种读法：逐行（关键词和编号同一行）
# 与整段（中间可隔换行），读出来的集合必须一致——不一致说明写法有歧义，认不准。
# 只认关闭类关键词（Close/Fix/Resolve 各变体，可带冒号）；Refs #N 不会关 issue，不算。
AUTOPILOT_CLOSE_GREP='(^|[^[:alnum:]_])(close[sd]?|fix(es|ed)?|resolve[sd]?):?[[:space:]]+#[0-9]+'
AUTOPILOT_CLOSE_JQ='(?i)\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?):?\s+#([0-9]+)'
# 第 2 个参数 any（GitHub#142，判「正文关不关本仓库的 issue」用）：除了 #N，再认 GitHub 也会照着关的写法——
# owner/repo#N、https://github.com/owner/repo/issues/N（带不带 www、末尾斜杠），以及保守起见的 GH-N；
# 只输出指向本仓库（REPO，不分大小写）的编号，指向别的仓库的不算。关键词表和不带 any 时同一份。
# 不带 any 的严格读法（只认 #N）留给「绑 issue」：绑定的规则不因这次改动变宽。
AUTOPILOT_CLOSE_REF='(#[0-9]+|gh-[0-9]+|[[:alnum:]_.-]+/[[:alnum:]_.-]+#[0-9]+|https?://(www\.)?github\.com/[[:alnum:]_.-]+/[[:alnum:]_.-]+/issues/[0-9]+)'
AUTOPILOT_CLOSE_ANY_GREP="(^|[^[:alnum:]_])(close[sd]?|fix(es|ed)?|resolve[sd]?):?[[:space:]]+$AUTOPILOT_CLOSE_REF"
AUTOPILOT_CLOSE_ANY_JQ='(?i)\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?):?\s+(#[0-9]+|gh-[0-9]+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+|https?://(?:www\.)?github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[0-9]+)'
# 一个引用（关键词后面那一段）→ 本仓库的编号，别的仓库的输出空。两种读法共用这一个 jq 定义
AUTOPILOT_CLOSE_LOCAL_DEF='def localnum($repo): ascii_downcase as $r | ($repo | ascii_downcase) as $me
    | if ($r | test("^#[0-9]+$")) then ($r | ltrimstr("#"))
      elif ($r | test("^gh-[0-9]+$")) then ($r | ltrimstr("gh-"))
      elif ($r | test("github\\.com/")) then ($r | capture("github\\.com/(?<o>[^/]+/[^/]+)/issues/(?<n>[0-9]+)") | select(.o == $me) | .n)
      else ($r | capture("^(?<o>[^#]+)#(?<n>[0-9]+)$") | select(.o == $me) | .n) end;'
autopilot_body_closes() {   # <line|whole> [any]，正文从 stdin → 逗号分隔的编号（升序去重）
    if [ "${2:-}" = any ]; then
        local gre="$AUTOPILOT_CLOSE_ANY_GREP" jre="$AUTOPILOT_CLOSE_ANY_JQ"
        if [ "$1" = line ]; then
            { grep -oiE "$gre" || true; } | awk '{print $NF}' \
                | jq -Rr --arg repo "$REPO" "$AUTOPILOT_CLOSE_LOCAL_DEF"' localnum($repo)' 2>/dev/null \
                | sort -un | paste -sd, - || true
        else
            jq -Rrs --arg re "$jre" --arg repo "$REPO" "$AUTOPILOT_CLOSE_LOCAL_DEF"'
                [scan($re)[0] | localnum($repo) | tonumber] | unique | map(tostring) | join(",")' 2>/dev/null || printf '?'
        fi
        return 0
    fi
    if [ "$1" = line ]; then
        { grep -oiE "$AUTOPILOT_CLOSE_GREP" || true; } | grep -oE '[0-9]+$' | sort -un | paste -sd, - || true
    else
        jq -Rrs --arg re "$AUTOPILOT_CLOSE_JQ" \
            '[scan($re)[0] | tonumber] | unique | map(tostring) | join(",")' 2>/dev/null || printf '?'
    fi
}

# PR 绑定到哪个 issue。两条依据**同时**对上才算：
#   ① PR 来自本仓库，分支名正好是 BRANCH_PREFIX + N（不许带后缀）
#   ② 正文的关闭关键词只指向 #N（逐行、整段两种读法一致）
# 只看正文：任何 PR 写一句 Closes #N 就能借走 #N 的授权；只看分支名：人手开的同名分支也能借。
# 不用 pr_to_issue_num / branch_to_issue_num：前者兜底返回 PR 自己的编号、只取第一个匹配，
# 后者允许编号后带后缀——都是找工作编号的回退规则，不是授权证明。
autopilot_pr_binding() {   # <PR JSON> → stdout issue 编号；return 1 = 对不上（AUTOPILOT_REASON）
    local pj="$1" repo ref esc n body by_line by_whole
    AUTOPILOT_REASON=""
    repo=$(printf '%s' "$pj" | jq -r '.head.repo.full_name // ""' 2>/dev/null) || repo=""
    if [ -z "$repo" ] || [ "$(requester_bot_lc "$repo")" != "$(requester_bot_lc "$REPO")" ]; then
        AUTOPILOT_REASON="PR 不是从本仓库的分支开的（来源：${repo:-未知}）"
        return 1
    fi
    ref=$(printf '%s' "$pj" | jq -r '.head.ref // ""' 2>/dev/null) || ref=""
    esc=$(printf '%s' "$BRANCH_PREFIX" | sed 's/[.[\*^$/]/\\&/g')
    if [[ "$ref" =~ ^${esc}([0-9]+)$ ]]; then
        n="${BASH_REMATCH[1]}"
    else
        AUTOPILOT_REASON="PR 的分支 \`${ref:-?}\` 不是某个 issue 的工作分支（应为 \`${BRANCH_PREFIX}<编号>\`）"
        return 1
    fi
    body=$(printf '%s' "$pj" | jq -r '.body // ""' 2>/dev/null) || body=""
    by_line=$(printf '%s\n' "$body" | autopilot_body_closes line)
    by_whole=$(printf '%s' "$body" | autopilot_body_closes whole)
    if [ "$by_line" != "$by_whole" ]; then
        AUTOPILOT_REASON="PR 正文的关闭写法有歧义（逐行看关闭 ${by_line:-无}、整段看关闭 ${by_whole:-无}，常见于关键词和 #编号分在两行）"
        return 1
    fi
    # 另一种绑法（GitHub#233）：正文一个本仓库关闭关键词都没有（任何写法），只引用唯一一个 `Refs #N`，
    # 且 N 就是分支指向的编号。合并时 GitHub 不会关 issue，issue 留给人验收、关闭
    if [ -z "$by_line" ] && [ -z "$(printf '%s\n' "$body" | autopilot_body_closes line any)" ] \
       && [ -z "$(printf '%s' "$body" | autopilot_body_closes whole any)" ] \
       && [ "$(printf '%s\n' "$body" | autopilot_body_refs)" = "$n" ]; then
        printf '%s\n' "$n"
        return 0
    fi
    if [ "$by_line" != "$n" ]; then
        AUTOPILOT_REASON="PR 正文关闭的是 ${by_line:+#}${by_line:-（没有关闭关键词）}，和分支 \`$ref\` 指向的 #$n 不一致（正文必须只写一个 \`Refs #$n\`，或只写一个 \`Closes #$n\`）"
        return 1
    fi
    printf '%s\n' "$n"
}

# 正文里引用（不关闭）的本仓库编号：逐行认 `Refs #N` / `Ref #N`（可带冒号），逗号分隔、升序去重
autopilot_body_refs() {
    { grep -oiE '(^|[^[:alnum:]_])refs?:?[[:space:]]+#[0-9]+' || true; } | grep -oE '[0-9]+$' | sort -un | paste -sd, - || true
}

# PR 正文还带着会让 GitHub 在合并时关掉本仓库 issue 的关键词吗（GitHub#233：托管合并后 issue 要留给人关）
autopilot_body_has_close() {   # 正文从 stdin
    local body
    body=$(cat)
    [ -n "$(printf '%s\n' "$body" | autopilot_body_closes line any)" ] || [ -n "$(printf '%s' "$body" | autopilot_body_closes whole any)" ]
}

# PR 属于哪一种（GitHub#142）。在调用方自己的 shell 里调，结果在全局变量里：
#   AUTOPILOT_PR_KIND = issue  绑 issue（AUTOPILOT_PR_N = issue 编号），授权和叫停看 issue 和 PR 两处
#                     = pr     没绑 issue：授权和叫停都只看 PR 自己
#                     = bad    不合条件（AUTOPILOT_REASON 是原因）
# 第 2 个参数给了就拿它代替 PR 现在的正文（判「打标签那一刻的正文」用），其余照 PR JSON。
# 「以 PR 为准」只给来自本仓库、正文一个本仓库关闭关键词都没有的 PR：正文谁都能改，不能靠它决定
# 「借哪个 issue 的授权、看哪个 issue 的叫停」。写了关闭关键词却没正常绑定的，判不合条件。
autopilot_pr_kind() {   # <PR JSON> [正文]
    local pj="$1" n repo body by_line by_whole
    AUTOPILOT_PR_KIND=bad; AUTOPILOT_PR_N=""; AUTOPILOT_REASON=""
    if [ "$#" -ge 2 ] && ! pj=$(printf '%s' "$pj" | jq -c --arg b "$2" '.body = $b' 2>/dev/null); then
        AUTOPILOT_REASON="读不懂 PR 的内容"; return 0
    fi
    if n=$(autopilot_pr_binding "$pj"); then
        AUTOPILOT_PR_KIND=issue; AUTOPILOT_PR_N="$n"; return 0
    fi
    repo=$(printf '%s' "$pj" | jq -r '.head.repo.full_name // ""' 2>/dev/null) || repo=""
    if [ -z "$repo" ] || [ "$(requester_bot_lc "$repo")" != "$(requester_bot_lc "$REPO")" ]; then
        AUTOPILOT_REASON="PR 不是从本仓库的分支开的（来源：${repo:-未知}）"; return 0
    fi
    body=$(printf '%s' "$pj" | jq -r '.body // ""' 2>/dev/null) || body=""
    by_line=$(printf '%s\n' "$body" | autopilot_body_closes line any)
    by_whole=$(printf '%s' "$body" | autopilot_body_closes whole any)
    if [ -z "$by_line" ] && [ -z "$by_whole" ]; then
        AUTOPILOT_PR_KIND=pr; return 0
    fi
    if [ "$by_line" != "$by_whole" ]; then
        AUTOPILOT_REASON="PR 正文的关闭写法有歧义（逐行看关闭 ${by_line:-无}、整段看关闭 ${by_whole:-无}，常见于关键词和 #编号分在两行）"
    else
        AUTOPILOT_REASON="PR 正文写着合并时关闭本仓库的 #${by_line//,/、#}，但 PR 没有正常绑定它（绑 issue：分支正好是 \`${BRANCH_PREFIX}<编号>\`、正文只写一个 \`Closes #<编号>\`；不绑 issue：把关闭改成只引用 \`Refs #<编号>\`）"
    fi
}

# 打标签那一刻生效的 PR 正文（GitHub#142）。GitHub 给 PR 正文保存修改历史（GraphQL 的
# userContentEdits：按时间倒序，每一版有修改时间 editedAt 和那一版的全文 diff，最早一版是开 PR 时的
# 正文；在 #59、#115 上实测过最新一版和当前正文逐字一致）。取「修改时间不晚于打标签时间」的最新一版；
# 同一秒既有修改又有打标签，分不出先后：同一秒的各版和它之前那一版都算候选，调用方要求全部合条件。
# 没有早于打标签的版本时，只有一种情况查得到：历史最早那一版就是开 PR 时的正文（修改时间 = PR 的
# created_at，#59 / #115 实测如此）而且和打标签同一秒——PR 刚开就打（复审第 1 轮）；这时同一秒的各版都算
# 候选。最早一版不是开 PR 那一刻的（更早的版本缺了），一律算查不到。
# 两边都是 GitHub 的时间，不受本机时钟影响。daemon 本机不记任何东西。
#   0 = AUTOPILOT_BODY_CANDS 是候选正文（JSON 字符串数组）
#   1 = 那一版查不到（被从历史里删掉 / 历史里没有早于打标签的版本）：AUTOPILOT_REASON
#   2 = 读不到（接口报错、字段缺、分页读不全）
# 历史为空 = 正文从开 PR 起没改过，候选就是现在的正文。
AUTOPILOT_BODY_CANDS=""
AUTOPILOT_EDITS_QUERY='query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    userContentEdits(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { editedAt deletedAt diff } } } } }'
autopilot_body_at() {   # <PR 编号> <打标签时间> <PR JSON>
    local pr="$1" t="$2" pj="$3" owner name after="" page nodes edits='[]' out
    local -a args
    AUTOPILOT_BODY_CANDS=""
    [ -n "$t" ] || { AUTOPILOT_REASON="PR #$pr 的标签记录里没有打标签的时间"; return 2; }
    owner="${REPO%%/*}"; name="${REPO#*/}"
    while :; do
        args=(api graphql -f query="$AUTOPILOT_EDITS_QUERY" -f owner="$owner" -f name="$name" -F number="$pr")
        [ -z "$after" ] || args+=(-f after="$after")
        if ! page=$(gh "${args[@]}" 2>/dev/null) \
           || ! nodes=$(printf '%s' "$page" | jq -ce '.data.repository.pullRequest.userContentEdits
                  | select((.nodes | type) == "array" and (.pageInfo.hasNextPage | type) == "boolean") | .nodes' 2>/dev/null); then
            AUTOPILOT_REASON="读不到 PR #$pr 正文的修改历史"; return 2
        fi
        edits=$(jq -cn --argjson a "$edits" --argjson b "$nodes" '$a + $b')
        # 倒序：已经读到早于打标签的那一版就够了
        printf '%s' "$nodes" | jq -e --arg t "$t" 'any(.[]; (.editedAt | type) == "string" and .editedAt < $t)' >/dev/null 2>&1 && break
        [ "$(printf '%s' "$page" | jq -r '.data.repository.pullRequest.userContentEdits.pageInfo.hasNextPage')" = true ] || break
        after=$(printf '%s' "$page" | jq -r '.data.repository.pullRequest.userContentEdits.pageInfo.endCursor // ""')
        [ -n "$after" ] || { AUTOPILOT_REASON="PR #$pr 正文的修改历史分页读不全"; return 2; }
    done
    out=$(jq -cn --argjson e "$edits" --arg t "$t" --arg cur "$(printf '%s' "$pj" | jq -r '.body // ""')" \
              --arg created "$(printf '%s' "$pj" | jq -r '.created_at // ""')" '
        if ($e | length) == 0 then {ok: [$cur]}
        elif any($e[]; (.editedAt | type) != "string" or .editedAt == "") then {err: "unreadable"}
        else
          ([$e[] | select(.editedAt == $t)] + ([$e[] | select(.editedAt < $t)] | sort_by(.editedAt) | .[-1:])) as $c
          | ($e | min_by(.editedAt) | .editedAt) as $first
          | if ($c | map(select(.editedAt < $t)) | length) == 0
               and ($created == "" or $first != $created or $first != $t) then {err: "none"}
            elif any($c[]; .deletedAt != null or (.diff | type) != "string") then {err: "deleted"}
            else {ok: [$c[].diff]} end
        end' 2>/dev/null) || out=""
    case "$out" in
        '{"ok":'*) AUTOPILOT_BODY_CANDS=$(printf '%s' "$out" | jq -c '.ok'); return 0 ;;
        '{"err":"deleted"}') AUTOPILOT_REASON="打标签那一刻的 PR 正文那一版已从修改历史里删掉，查不到当时写的是什么"; return 1 ;;
        '{"err":"none"}') AUTOPILOT_REASON="PR 正文的修改历史里找不到打标签那一刻（或更早）的那一版"; return 1 ;;
        *) AUTOPILOT_REASON="读不懂 PR #$pr 正文的修改历史"; return 2 ;;
    esac
}

# 托管判定规则的版本，写进两份「判过、条目没变就不再判」的本机记录（state.json 的 .autopilot.denied、
# .autopilot.takeover）的值里。规则改了、旧的「不」可能变成「是」时**必须改这个值**：旧版留下的记录对不上，
# 每个条目按新规则重判一次后再记。GitHub#162 放开了机器人需求的托管，旧版记下的拒绝若照旧复用，升级后
# 新授权永远不生效（代码复审第 2 轮）。只让旧记录失效一次，不删 state、不碰暂停 / 授权的判断本身。
AUTOPILOT_JUDGE_REV="r233"

# 托管授权是否有效。两种调法：
#   autopilot_authorization <issue> <issue JSON>                   只看 issue 一处（issue 自己的派工）
#   autopilot_authorization <issue> <issue JSON> <PR> <PR JSON>    PR 的托管：issue 和 PR 两处合起来判（GitHub#128）
#   autopilot_authorization "" "" <PR> <PR JSON>                   没绑 issue 的 PR：只看 PR（GitHub#142）
#   0 = 有效（AUTOPILOT_ACTOR = 打标签的人；AUTOPILOT_AUTH_KIND / _NUM = 授权打在哪一处，issue / pr）
#   1 = 无效（AUTOPILOT_DENY = 原因类别，AUTOPILOT_REASON = 一句话）
#   2 = 判不了（读不到）
# issue 本身的条件：是 issue、开着。外部需求机器人提的需求也能托管（GitHub#162）：授权看的是谁打的
# 托管标签，不看需求是谁提的；机器人账号自己打的标签照样不算（autopilot_actor_check）。提需求方的确认
# 由提示词里「机器人需求 + 托管」那一段保留（prompts/autopilot-requester-bot.md）。
# 授权本身只有一条判据（两处共用，见 autopilot_place_read / autopilot_actor_check）：
#   停止线 = 两处所有「摘掉托管标签」事件里最晚的那一个
#   授权成立 ⇔ 有一处现在挂着托管标签，它最后一次「打上」的操作人是有写权限的真人（不是 loop 的写入
#   账号——worker 和复审用的就是它，被注入的 worker 给自己打个标签不能就此获得自动合并——也不是外部需求
#   机器人账号），并且这次打上晚于停止线。
# 「谁恢复了托管」和「谁提供了真人授权」因此是同一次操作：叫停之后 loop 账号补打的标签既不算授权，
# 也不能借另一处叫停之前的旧授权复活。没有停止线时，worker 在另一处打的标签不影响已有的授权。
autopilot_authorization() {   # <issue 编号> <issue JSON> [<PR 编号> <PR JSON>]
    local num="$1" ij="$2" pr="${3:-}" pj="${4:-}" rc
    AUTOPILOT_REASON=""; AUTOPILOT_DENY=""; AUTOPILOT_ACTOR=""
    AUTOPILOT_AUTH_KIND=""; AUTOPILOT_AUTH_NUM=""; AUTOPILOT_AUTH_T=""; AUTOPILOT_AUTH_IDX=""; AUTOPILOT_AUTH_REPO=""
    AUTOPILOT_PR_EVENTS=""; AUTOPILOT_AUTH_CANDS=""; AUTOPILOT_PR_COPY=""; AUTOPILOT_PR_COPY_READ=""
    if [ -z "$num" ]; then
        autopilot_authorization_pr_only "$pr" "$pj"; return $?
    fi
    if ! printf '%s' "$ij" | jq -e '(.number != null) and (.pull_request == null)' >/dev/null 2>&1; then
        AUTOPILOT_DENY=not-issue; AUTOPILOT_REASON="#$num 不是 issue（托管标签只在 issue 上算数）"; return 1
    fi
    if [ "$(printf '%s' "$ij" | jq -r '.state // ""')" != open ]; then
        AUTOPILOT_DENY=closed; AUTOPILOT_REASON="issue #$num 已关闭"; return 1
    fi
    # 拆分子项（GitHub#233）：父 issue 是第三处，走同一条判据（autopilot_authorization_split）。
    # 不是子项的 issue 照旧只看 issue 和 PR 两处，下面的代码一字未动
    rc=0; split_parent_check "$num" "$ij" || rc=$?
    case "$rc" in
        0) autopilot_authorization_split "$num" "$ij" "$pr" "$pj"; return $? ;;
        2) AUTOPILOT_REASON="$SPLIT_PARENT_WHY"; return 2 ;;
    esac
    if [ -z "$pr" ] && ! autopilot_has_label "$ij"; then
        AUTOPILOT_DENY=no-label; AUTOPILOT_REASON="issue #$num 上的托管标签 \`$LABEL_AUTOPILOT\` 已摘掉"; return 1
    fi
    if [ -n "$pr" ] && ! autopilot_has_label "$ij" && ! autopilot_has_label "$pj"; then
        AUTOPILOT_DENY=no-label; AUTOPILOT_REASON="issue #$num 和 PR #$pr 上的托管标签 \`$LABEL_AUTOPILOT\` 都已摘掉（已叫停）"; return 1
    fi
    local ip pp
    autopilot_place_read "$num" "$ij" "issue #$num" || return 2
    ip="$AUTOPILOT_PLACE"
    if [ -z "$pr" ]; then
        # 只看 issue：现在挂着（上面已确认），最后一次是打上，看那次的操作人
        rc=0; autopilot_actor_check "$(printf '%s' "$ip" | jq -r '.lab.actor')" "$(printf '%s' "$ip" | jq -r '.lab.atype')" || rc=$?
        [ "$rc" = 0 ] || return "$rc"
        autopilot_auth_from "$ip" issue "$num"
        return 0
    fi
    autopilot_place_read "$pr" "$pj" "PR #$pr" || return 2
    # PR 上 daemon 补的副本（GitHub#190）不是授权，当作没挂
    autopilot_place_strip_copy "PR #$pr" || return 2
    pp="$AUTOPILOT_PLACE"; AUTOPILOT_PR_EVENTS="$AUTOPILOT_PLACE_EVENTS"; AUTOPILOT_PR_COPY="$AUTOPILOT_PLACE_COPY"; AUTOPILOT_PR_COPY_READ=1
    # 两处合判：和拆分子项的三处合判是同一个函数（autopilot_auth_combine，GitHub#233 起共用）
    rc=0; autopilot_auth_combine "$(jq -cn --argjson i "$ip" --argjson p "$pp" --arg n "$num" --arg q "$pr" --arg r "$REPO" \
        '[{kind: "issue", num: $n, repo: $r, what: ("issue #" + $n), p: $i}, {kind: "pr", num: $q, repo: $r, what: ("PR #" + $q), p: $p}]')" || rc=$?
    [ "$rc" = 3 ] || return "$rc"
    AUTOPILOT_DENY=no-label
    if [ -n "$AUTOPILOT_PR_COPY" ] && [ "$(printf '%s' "$ip" | jq -r '.present')" != true ]; then
        AUTOPILOT_REASON="issue #$num 上没有托管标签 \`$LABEL_AUTOPILOT\`；PR #$pr 上那个是 loop 自己的账号打的（daemon 从 issue 补过来的副本，或 worker 打的），不算授权"
    else
        AUTOPILOT_REASON="托管标签 \`$LABEL_AUTOPILOT\` 在 issue #$num 或 PR #$pr 上被摘掉过（已叫停），之后没有维护者亲手重新打上"
    fi
    return 1
}

# 几处托管标签合起来判授权——两处（issue + PR）和三处（子项 + PR + 父 issue，GitHub#233）共用这一个实现：
#   停止线 = 所有各处「摘掉托管标签」里最晚的那一次
#   授权   = 有一处现在挂着托管标签，最后一次打上的人合格（autopilot_actor_check；父 issue 还要求在它的仓库有写权限），
#            并且这次打上晚于其他各处所有的摘掉
# <places> = JSON 数组，每项 {kind: issue|pr|parent, num, repo, what（给人看的称呼）, p（autopilot_place_read 的结果）}。
# 返回 0 = 成立（AUTOPILOT_ACTOR / AUTOPILOT_AUTH_* / AUTOPILOT_AUTH_CANDS）；1 = 不成立（AUTOPILOT_DENY / _REASON）；
# 2 = 判不了；3 = 哪一处都没有晚于停止线的打上（调用方写自己那句「已叫停」）。在调用方自己的 shell 里调。
autopilot_auth_combine() {   # <places JSON>
    local places="$1" n i here kind cnum crepo what when rc also other
    local ok_kind="" ok_num="" ok_repo="" ok_place="" ok_t="" ok_actor="" unknown="" deny_kind="" deny_reason=""
    n=$(printf '%s' "$places" | jq 'length' 2>/dev/null) || { AUTOPILOT_REASON="读不懂托管标签记录"; return 2; }
    other="另一处"; [ "$n" -le 2 ] || other="别处"
    for ((i = 0; i < n; i++)); do
        here=$(printf '%s' "$places" | jq -c --argjson i "$i" '.[$i]')
        [ "$(printf '%s' "$here" | jq -r '.p.present')" = true ] || continue
        kind=$(printf '%s' "$here" | jq -r '.kind'); cnum=$(printf '%s' "$here" | jq -r '.num')
        crepo=$(printf '%s' "$here" | jq -r '.repo'); what=$(printf '%s' "$here" | jq -r '.what')
        when=$(printf '%s' "$places" | jq -r --argjson i "$i" '
            .[$i].p.lab.t as $t | ([ to_entries[] | select(.key != $i) | .value.p.unl[] | .t ]) as $u
            | if ($u | length) == 0 then "after"
              elif $t == null or $t == "" or any($u[]; . == null or . == "") then "unknown"
              elif all($u[]; . < $t) then "after" else "before" end' 2>/dev/null) || when=unknown
        also=""; [ "$kind" = parent ] && also="$crepo"
        rc=0; autopilot_actor_check "$(printf '%s' "$here" | jq -r '.p.lab.actor')" "$(printf '%s' "$here" | jq -r '.p.lab.atype')" "$also" || rc=$?
        case "$rc:$when" in
            0:after)
                # 每一条成立的授权都记下（接手时和 PR 上的 pending/human 比先后要逐条看：同秒时只留一条，
                # 会把 PR 自己事件里明确在后的那条遮住）；对外报的「授权」取较晚的那次
                # 分隔用 \x1f：tab 是空白，read 会把连续的空字段吞掉
                AUTOPILOT_AUTH_CANDS+="$kind"$'\x1f'"$cnum"$'\x1f'"$(printf '%s' "$here" | jq -r '.p.lab.t // ""')"$'\x1f'"$(printf '%s' "$here" | jq -r '.p.lab.idx // ""')"$'\x1f'"$AUTOPILOT_ACTOR"$'\n'
                if [ -z "$ok_kind" ] || [[ "$(printf '%s' "$here" | jq -r '.p.lab.t // ""')" > "$ok_t" ]]; then
                    ok_kind="$kind"; ok_num="$cnum"; ok_repo="$crepo"; ok_place=$(printf '%s' "$here" | jq -c '.p')
                    ok_t="$(printf '%s' "$here" | jq -r '.p.lab.t // ""')"; ok_actor="$AUTOPILOT_ACTOR"
                fi ;;
            # 早于停止线的那次打上：叫停之前的旧授权，不管是谁打的都不算
            *:before) ;;
            1:*) deny_kind="$AUTOPILOT_DENY"; deny_reason="$AUTOPILOT_REASON（打在 $what 上）" ;;
            *) unknown="${AUTOPILOT_REASON:-判不了 $what 上的托管标签和${other}摘掉的先后（标签记录缺时间）}" ;;
        esac
    done
    if [ -n "$ok_kind" ]; then
        AUTOPILOT_ACTOR="$ok_actor"; AUTOPILOT_DENY=""; AUTOPILOT_REASON=""
        autopilot_auth_from "$ok_place" "$ok_kind" "$ok_num"
        AUTOPILOT_AUTH_REPO="$ok_repo"
        return 0
    fi
    AUTOPILOT_ACTOR=""
    if [ -n "$unknown" ]; then AUTOPILOT_DENY=""; AUTOPILOT_REASON="$unknown"; return 2; fi
    if [ -n "$deny_kind" ]; then AUTOPILOT_DENY="$deny_kind"; AUTOPILOT_REASON="$deny_reason"; return 1; fi
    return 3
}

# 拆分子项的授权（GitHub#233，只由 autopilot_authorization 调，split_parent_check 已判定是子项）。
# 判据和两处合判是同一条，只是多了一处——父 issue（可以在互通名单里的别的仓库）：
#   停止线 = 子项、PR、父 issue 三处所有「摘掉托管标签」里最晚的那一次
#   授权   = 有一处现在挂着托管标签，最后一次打上的人合格，并且晚于停止线
# 父 issue 上的托管标签要求打标签的人在父 issue 的仓库和本仓库都有写权限。父 issue 关了、挂了 pending/human，
# 全部子项一起停（一处叫停，整棵都停）。子项和它的 PR 上不用挂标签：标签只在父 issue 上也成立。
autopilot_authorization_split() {   # <issue 编号> <issue JSON> [<PR 编号> <PR JSON>]（SPLIT_PARENT_* 已设好）
    local num="$1" ij="$2" pr="${3:-}" pj="${4:-}" prepo="$SPLIT_PARENT_REPO" pnum="$SPLIT_PARENT_NUM" paj="$SPLIT_PARENT_JSON"
    local pref places='[]' rc
    pref="父 issue $(split_parent_ref "$prepo" "$pnum")"
    if [ "$(printf '%s' "$paj" | jq -r '.state // ""')" != open ]; then
        AUTOPILOT_DENY=closed; AUTOPILOT_REASON="$pref 已关闭（整组子项停止托管）"; return 1
    fi
    if printf '%s' "$paj" | jq -e --arg H "$LABEL_PENDING_HUMAN" 'any(.labels[]?; .name == $H)' >/dev/null 2>&1; then
        AUTOPILOT_DENY=no-label; AUTOPILOT_REASON="$pref 上挂了 \`$LABEL_PENDING_HUMAN\`（已叫停）"; return 1
    fi
    if ! autopilot_has_label "$ij" && ! autopilot_has_label "$paj" && { [ -z "$pr" ] || ! autopilot_has_label "$pj"; }; then
        AUTOPILOT_DENY=no-label
        AUTOPILOT_REASON="issue #$num${pr:+、PR #$pr} 和 $pref 上都没有托管标签 \`$LABEL_AUTOPILOT\`（已叫停或从没打过）"
        return 1
    fi
    autopilot_place_read "$num" "$ij" "issue #$num" || return 2
    places=$(jq -cn --argjson p "$AUTOPILOT_PLACE" --arg n "$num" --arg r "$REPO" '[{kind: "issue", num: $n, repo: $r, what: ("issue #" + $n), p: $p}]')
    if [ -n "$pr" ]; then
        autopilot_place_read "$pr" "$pj" "PR #$pr" || return 2
        autopilot_place_strip_copy "PR #$pr" || return 2
        AUTOPILOT_PR_EVENTS="$AUTOPILOT_PLACE_EVENTS"; AUTOPILOT_PR_COPY="$AUTOPILOT_PLACE_COPY"; AUTOPILOT_PR_COPY_READ=1
        places=$(printf '%s' "$places" | jq -c --argjson p "$AUTOPILOT_PLACE" --arg n "$pr" --arg r "$REPO" '. + [{kind: "pr", num: $n, repo: $r, what: ("PR #" + $n), p: $p}]')
    fi
    autopilot_place_read "$pnum" "$paj" "$pref" "$prepo" || return 2
    places=$(printf '%s' "$places" | jq -c --argjson p "$AUTOPILOT_PLACE" --arg n "$pnum" --arg r "$prepo" --arg w "$pref" '. + [{kind: "parent", num: $n, repo: $r, what: $w, p: $p}]')
    rc=0; autopilot_auth_combine "$places" || rc=$?
    [ "$rc" = 3 ] || return "$rc"
    AUTOPILOT_DENY=no-label
    AUTOPILOT_REASON="托管标签 \`$LABEL_AUTOPILOT\` 在 issue #$num${pr:+、PR #$pr} 或 $pref 上被摘掉过（已叫停），之后没有维护者亲手重新打上"
    return 1
}

# 条目自己挂着托管标签，或者它是拆分子项、父 issue 挂着托管标签（GitHub#233）：各入口在调授权判断之前
# 的「这条和托管有关吗」都用它，标签只打在父 issue 上的子项才进得去。0 = 有关 / 1 = 无关 / 2 = 判不了
autopilot_labeled_or_parent() {   # <issue 编号> <issue JSON>
    local rc
    autopilot_has_label "$2" && return 0
    rc=0; split_parent_check "$1" "$2" || rc=$?
    case "$rc" in
        0) autopilot_has_label "$SPLIT_PARENT_JSON" && return 0; return 1 ;;
        2) AUTOPILOT_REASON="$SPLIT_PARENT_WHY"; return 2 ;;
    esac
    return 1
}

# 没绑 issue 的 PR 的授权（GitHub#142，只由 autopilot_authorization 调）。判据和两处合判是同一套：
# PR 现在挂着托管标签、最后一次打上的人合格（autopilot_place_read / autopilot_actor_check）；PR 上的
# 「摘掉」都早于这次打上（标签记录和当前标签对得上时自然成立）。另加两条：
#   · 打标签那一刻的 PR 正文（autopilot_body_at）也必须是「以 PR 为准」那一种：先被拒、之后有人改了
#     正文的，那次打标签不算，要维护者看过现在的 PR 重新打——旧标签不会因为正文改了就自己生效
autopilot_authorization_pr_only() {   # <PR 编号> <PR JSON>
    local pr="$1" pj="$2" pp rc actor t i nb body
    if [ -z "$pr" ] || [ -z "$pj" ]; then AUTOPILOT_REASON="缺少 PR 编号或内容"; return 2; fi
    if ! autopilot_has_label "$pj"; then
        AUTOPILOT_DENY=no-label; AUTOPILOT_REASON="PR #$pr 上的托管标签 \`$LABEL_AUTOPILOT\` 已摘掉（已叫停）"; return 1
    fi
    autopilot_place_read "$pr" "$pj" "PR #$pr" || return 2
    autopilot_place_strip_copy "PR #$pr" || return 2
    pp="$AUTOPILOT_PLACE"; AUTOPILOT_PR_EVENTS="$AUTOPILOT_PLACE_EVENTS"; AUTOPILOT_PR_COPY="$AUTOPILOT_PLACE_COPY"; AUTOPILOT_PR_COPY_READ=1
    if [ -n "$AUTOPILOT_PR_COPY" ]; then
        AUTOPILOT_DENY=no-label
        AUTOPILOT_REASON="PR #$pr 上的托管标签是 loop 自己的账号打的（daemon 补的副本，或 worker 打的），不算授权"
        return 1
    fi
    rc=0; autopilot_actor_check "$(printf '%s' "$pp" | jq -r '.lab.actor')" "$(printf '%s' "$pp" | jq -r '.lab.atype')" || rc=$?
    [ "$rc" = 0 ] || return "$rc"
    actor="$AUTOPILOT_ACTOR"; AUTOPILOT_ACTOR=""
    t=$(printf '%s' "$pp" | jq -r '.lab.t // ""')
    rc=0; autopilot_body_at "$pr" "$t" "$pj" || rc=$?
    case "$rc" in
        0) ;;
        1) AUTOPILOT_DENY=label-body
           AUTOPILOT_REASON="$AUTOPILOT_REASON（\`$actor\` 打标签的时间 $t）"; return 1 ;;
        *) return 2 ;;
    esac
    nb=$(printf '%s' "$AUTOPILOT_BODY_CANDS" | jq 'length' 2>/dev/null) || nb=0
    [ "${nb:-0}" -gt 0 ] 2>/dev/null || { AUTOPILOT_REASON="读不懂 PR #$pr 正文的修改历史"; return 2; }
    for ((i = 0; i < nb; i++)); do
        body=$(printf '%s' "$AUTOPILOT_BODY_CANDS" | jq -r --argjson i "$i" '.[$i]')
        autopilot_pr_kind "$pj" "$body"
        if [ "$AUTOPILOT_PR_KIND" != pr ]; then
            AUTOPILOT_DENY=label-body
            AUTOPILOT_REASON="\`$actor\` 打标签那一刻（$t），PR 正文不合条件：${AUTOPILOT_REASON:-那时它绑着 issue}。PR 后来改过，那次打标签不算"
            return 1
        fi
    done
    AUTOPILOT_ACTOR="$actor"; AUTOPILOT_DENY=""; AUTOPILOT_REASON=""
    AUTOPILOT_AUTH_CANDS="pr"$'\x1f'"$pr"$'\x1f'"$t"$'\x1f'"$(printf '%s' "$pp" | jq -r '.lab.idx // ""')"$'\x1f'"$actor"$'\n'
    autopilot_auth_from "$pp" pr "$pr"
    return 0
}

autopilot_has_label() {   # <条目 JSON>
    printf '%s' "$1" | jq -e --arg L "$LABEL_AUTOPILOT" 'any(.labels[]?; .name == $L)' >/dev/null 2>&1
}

# 记下授权来自哪一次打标签
autopilot_auth_from() {   # <autopilot_place_read 的输出> <issue|pr> <编号>
    AUTOPILOT_AUTH_KIND="$2"; AUTOPILOT_AUTH_NUM="$3"
    AUTOPILOT_AUTH_T=$(printf '%s' "$1" | jq -r '.lab.t // ""')
    AUTOPILOT_AUTH_IDX=$(printf '%s' "$1" | jq -r '.lab.idx // ""')
}

# 一处（issue 或 PR）的托管标签记录，结果放在 AUTOPILOT_PLACE（一行 JSON；在调用方自己的 shell 里调）：
#   {present, lab:{actor,atype,t,idx}|null, unl:[{t,idx}]}   idx = 在这一处全部事件里的位置
# 全部事件原样留在 AUTOPILOT_PLACE_EVENTS（和 PR 上 pending/human 比先后用）。
# return 2 = 读不到，或记录和当前标签对不上（挂着却找不到打上、最后一次是摘掉却还挂着、没挂却最后一次是打上）
autopilot_place_read() {   # <编号> <条目 JSON> <称呼> [仓库，默认本仓库：拆分子项的父 issue 可以在互通名单里的别的仓库]
    local num="$1" item="$2" what="$3" prepo="${4:-$REPO}" ev out present=false
    AUTOPILOT_PLACE=""; AUTOPILOT_PLACE_EVENTS=""
    autopilot_has_label "$item" && present=true
    if ! ev=$(gh api --paginate --slurp "repos/$prepo/issues/$num/events" 2>/dev/null) || [ -z "$ev" ]; then
        AUTOPILOT_REASON="读不到 $what 的标签记录"; return 2
    fi
    if ! out=$(printf '%s' "$ev" | jq -c --arg L "$LABEL_AUTOPILOT" --argjson present "$present" '
        [ .[][]? ] | to_entries
        | map(select((.value.event == "labeled" or .value.event == "unlabeled") and ((.value.label.name // "") == $L)))
        | { present: $present,
            last: (last.value.event // ""),
            lab: (map(select(.value.event == "labeled")) | last
                  | if . == null then null else {actor: (.value.actor.login // ""), atype: (.value.actor.type // ""),
                                                  t: (.value.created_at // ""), idx: .key} end),
            unl: map(select(.value.event == "unlabeled") | {t: (.value.created_at // ""), idx: .key}) }' 2>/dev/null) || [ -z "$out" ]; then
        AUTOPILOT_REASON="读不懂 $what 的标签记录"; return 2
    fi
    AUTOPILOT_PLACE_EVENTS="$ev"
    case "$present:$(printf '%s' "$out" | jq -r '.last')" in
        true:labeled|false:unlabeled|false:) ;;
        true:) AUTOPILOT_REASON="$what 的标签记录里找不到是谁打的托管标签"; return 2 ;;
        true:unlabeled) AUTOPILOT_REASON="$what 的标签记录（最后一次是摘掉）和当前标签对不上"; return 2 ;;
        *) AUTOPILOT_REASON="$what 的标签记录（最后一次是打上）和当前标签（没挂）对不上"; return 2 ;;
    esac
    AUTOPILOT_PLACE="$out"
}

# PR 上的托管标签是不是 daemon 补过去的副本（GitHub#190）：PR 上最后一次打上托管标签的是 loop 的写入账号。
# 副本只是让 PR 列表看得出这是托管 PR，不是授权：在 AUTOPILOT_PLACE 上原地当作没挂（present=false），
# AUTOPILOT_PLACE_COPY = 那次打标签在这一处全部事件里的位置。worker 违规打在 PR 上的也是这个账号，同样处理。
# 只用在 PR 上：issue 上被 loop 账号打的照旧判「不生效」并说明。
# 在调用方自己的 shell 里调（紧跟 autopilot_place_read）。return 2 = 写入账号读不到，判不了。
autopilot_place_strip_copy() {   # <称呼>
    local me actor
    AUTOPILOT_PLACE_COPY=""
    [ "$(printf '%s' "$AUTOPILOT_PLACE" | jq -r '.present' 2>/dev/null)" = true ] || return 0
    actor=$(printf '%s' "$AUTOPILOT_PLACE" | jq -r '.lab.actor // ""' 2>/dev/null) || actor=""
    me=$(write_identity_login)
    if [ -z "$me" ]; then
        AUTOPILOT_REASON="读不到 loop 的写入账号，无法判断 $1 上的托管标签是不是 daemon 补的"; return 2
    fi
    [ -n "$actor" ] && [ "$(requester_bot_lc "$actor")" = "$(requester_bot_lc "$me")" ] || return 0
    AUTOPILOT_PLACE_COPY=$(printf '%s' "$AUTOPILOT_PLACE" | jq -r '.lab.idx // ""' 2>/dev/null) || AUTOPILOT_PLACE_COPY=""
    if [ -z "$AUTOPILOT_PLACE_COPY" ]; then
        AUTOPILOT_REASON="读不懂 $1 的标签记录"; return 2
    fi
    AUTOPILOT_PLACE=$(printf '%s' "$AUTOPILOT_PLACE" | jq -c '.present = false | .copy = true')
}

# 打托管标签的这个人算不算维护者授权：User 类型、不是 loop 的写入账号、不是外部需求机器人账号、有写权限。
#   0 = 算（AUTOPILOT_ACTOR）；1 = 不算（AUTOPILOT_DENY / AUTOPILOT_REASON）；2 = 判不了
autopilot_actor_check() {   # <操作人> <账号类型> [另一个也要有写权限的仓库（跨仓库的父 issue，GitHub#233）]
    local actor="$1" atype="$2" also="${3:-}" me perm
    AUTOPILOT_ACTOR=""; AUTOPILOT_DENY=""; AUTOPILOT_REASON=""
    if [ -z "$actor" ] || [ "$actor" = null ]; then
        AUTOPILOT_REASON="标签记录里没有操作人"; return 2
    fi
    if [ "$atype" != User ]; then
        AUTOPILOT_DENY=actor-bot; AUTOPILOT_REASON="托管标签是 \`$actor\`（${atype:-未知类型} 账号）打的，只认真人维护者"; return 1
    fi
    me=$(write_identity_login)
    if [ -z "$me" ]; then
        AUTOPILOT_REASON="读不到 loop 的写入账号，无法核对托管标签是谁打的"; return 2
    fi
    if [ "$(requester_bot_lc "$actor")" = "$(requester_bot_lc "$me")" ]; then
        AUTOPILOT_DENY=actor-loop; AUTOPILOT_REASON="托管标签是 loop 自己的写入账号 \`$actor\` 打的（worker 和复审用的就是它），不算维护者授权"; return 1
    fi
    if [ -n "${REQUESTER_BOT_ACCOUNT:-}" ] && [ "$(requester_bot_lc "$actor")" = "$(requester_bot_lc "$REQUESTER_BOT_ACCOUNT")" ]; then
        AUTOPILOT_DENY=actor-requester-bot; AUTOPILOT_REASON="托管标签是外部需求机器人账号 \`$actor\` 打的"; return 1
    fi
    if ! perm=$(gh api "repos/$REPO/collaborators/$actor/permission" --jq '.permission // ""' 2>/dev/null) || [ -z "$perm" ]; then
        AUTOPILOT_REASON="查不到 \`$actor\` 在仓库里的权限"; return 2
    fi
    case "$perm" in
        admin|write) ;;
        *) AUTOPILOT_DENY=actor-perm; AUTOPILOT_REASON="打托管标签的 \`$actor\` 在仓库里只有 $perm 权限，需要写权限"; return 1 ;;
    esac
    if [ -n "$also" ] && [ "$(requester_bot_lc "$also")" != "$(requester_bot_lc "$REPO")" ]; then
        if ! perm=$(gh api "repos/$also/collaborators/$actor/permission" --jq '.permission // ""' 2>/dev/null) || [ -z "$perm" ]; then
            AUTOPILOT_REASON="查不到 \`$actor\` 在 $also 的权限"; return 2
        fi
        case "$perm" in
            admin|write) ;;
            *) AUTOPILOT_DENY=actor-perm; AUTOPILOT_REASON="打托管标签的 \`$actor\` 在 $also 只有 $perm 权限，需要写权限"; return 1 ;;
        esac
    fi
    AUTOPILOT_ACTOR="$actor"
    return 0
}

# 授权在哪一处，给人看的说法
autopilot_auth_where() {
    case "$AUTOPILOT_AUTH_KIND" in
        pr) printf 'PR #%s' "$AUTOPILOT_AUTH_NUM" ;;
        parent) printf '父 issue %s' "$(split_parent_ref "$AUTOPILOT_AUTH_REPO" "$AUTOPILOT_AUTH_NUM")" ;;
        *) printf 'issue #%s' "$AUTOPILOT_AUTH_NUM" ;;
    esac
}

# 一条说明只在一个 issue 上说一次：本机记录 + 评论里的标记（本机状态丢了、或另一台机器先说过）
autopilot_notice_once() {   # <state_file> <编号> <类别> <正文>
    local sf="$1" num="$2" kind="$3" text="$4" marker existing body
    if [ -n "$(autopilot_state_get "$sf" '.notices[$n] // [] | index($k)' --arg n "$num" --arg k "$kind")" ]; then
        return 0
    fi
    marker="<!-- cavil-loop:autopilot-notice kind=$kind -->"
    if ! existing=$(gh api --paginate "repos/$REPO/issues/$num/comments" --jq '.[].body' 2>/dev/null); then
        log "  ⚠️ 读取 #$num 的评论失败，托管说明下轮再发"
        return 1
    fi
    if ! printf '%s' "$existing" | grep -qF "$marker"; then
        body="$(printf '%s\n\n<sub>cavil-loop daemon @ %s 自动留言</sub>\n%s' \
            "$text" "$(hostname -s 2>/dev/null || hostname)" "$marker")"
        run_gh "托管说明评论 (#$num)" gh_write api -X POST "repos/$REPO/issues/$num/comments" -f "body=$body" || return 1
        AUTOPILOT_ACTED=1
    fi
    autopilot_state_set "$sf" '.notices[$n] = (((.notices[$n] // []) + [$k]) | unique)' --arg n "$num" --arg k "$kind"
}

# 授权无效时要不要在 issue 上说一声（只说一次）。标签被摘 / issue 关了 —— 那是人自己做的，不说。
autopilot_note_denial() {   # <state_file> <issue 编号>
    local sf="$1" num="$2" text
    case "$AUTOPILOT_DENY" in
        actor-*)
            text="⚠️ **托管标签 \`$LABEL_AUTOPILOT\` 不生效**

**原因**：$AUTOPILOT_REASON。托管只认在仓库有写权限的维护者亲手在 issue 或 PR 上打的标签；维护者摘掉托管之后，别的账号再打上也不算恢复。

**怎么继续**：要托管，请维护者摘掉再亲手打一次 \`$LABEL_AUTOPILOT\`；不托管就照普通流程处理。" ;;
        *) return 0 ;;
    esac
    autopilot_notice_once "$sf" "$num" "$AUTOPILOT_DENY" "$text" || true
}

# 这次派工是不是托管条目。是 → return 0：绑 issue 时 AUTOPILOT_ISSUE = 授权所在的 issue；
# 没绑 issue、以 PR 为准时（GitHub#142）AUTOPILOT_ISSUE 为空、AUTOPILOT_PR = 这个 PR。
# 只读本轮快照找托管标签；挂着标签才去查授权记录（读不到 → 本次按普通流程派，更保守）。
autopilot_for_item() {   # <state_file> <issue|pr> <编号>
    local sf="$1" kind="$2" num="$3" pj ij n rc
    AUTOPILOT_ISSUE=""; AUTOPILOT_PR=""
    autopilot_enabled || return 1
    if [ "$kind" = pr ]; then
        pj=$(autopilot_snapshot_item pulls "$num") || return 1
        [ -n "$pj" ] || return 1
        autopilot_pr_kind "$pj"
        case "$AUTOPILOT_PR_KIND" in
            issue) n="$AUTOPILOT_PR_N" ;;
            pr)
                autopilot_has_label "$pj" || return 1
                rc=0; autopilot_authorization "" "" "$num" "$pj" || rc=$?
                case "$rc" in
                    0) AUTOPILOT_PR="$num"; return 0 ;;
                    1) log "托管：PR #$num（没绑 issue）挂着托管标签但不托管（$AUTOPILOT_REASON），按普通流程派工"
                       autopilot_note_pr_denial "$sf" "$num"
                       return 1 ;;
                    *) log "托管：PR #$num（没绑 issue）的托管授权判不了（$AUTOPILOT_REASON），本次按普通流程派工"
                       return 1 ;;
                esac ;;
            *) return 1 ;;
        esac
    else
        n="$num"
    fi
    ij=$(autopilot_snapshot_item issues "$n") || return 1
    [ -n "$ij" ] || return 1
    rc=0
    # 拆分子项的标签可以只在父 issue 上（GitHub#233）；父 issue 读不到 = 本轮判不了：return 2，
    # 调用方本轮不派（不按普通流程派出去，免得托管的子项丢了托管规则），下轮再判
    if [ "$kind" = pr ] && autopilot_has_label "$pj"; then :
    else
        autopilot_labeled_or_parent "$n" "$ij" || rc=$?
        case "$rc" in
            0) ;;
            2) log "托管：#$n 是不是托管的拆分子项判不了（$AUTOPILOT_REASON），${kind} #$num 本轮不派，下轮再判"
               return 2 ;;
            *) return 1 ;;
        esac
    fi
    if [ "$kind" = pr ]; then
        # PR 的托管：issue 或 PR 任一处挂着托管标签才去查两处的标签记录（GitHub#128）
        autopilot_authorization "$n" "$ij" "$num" "$pj" || rc=$?
    else
        autopilot_authorization "$n" "$ij" || rc=$?
    fi
    case "$rc" in
        2) if [ -n "$SPLIT_PARENT_NUM" ] || { [ -n "$SPLIT_PARENT_WHY" ] && [ "$AUTOPILOT_REASON" = "$SPLIT_PARENT_WHY" ]; }; then
               log "托管：#$n（拆分子项）的托管授权判不了（$AUTOPILOT_REASON），${kind} #$num 本轮不派，下轮再判"
               return 2
           fi ;;
    esac
    case "$rc" in
        0) AUTOPILOT_ISSUE="$n"; return 0 ;;
        1) log "托管：#$n 挂着托管标签但不托管（$AUTOPILOT_REASON），${kind} #$num 按普通流程派工"
           autopilot_note_denial "$sf" "$n"
           return 1 ;;
        *) log "托管：#$n 的托管授权判不了（$AUTOPILOT_REASON），${kind} #$num 本次按普通流程派工"
           return 1 ;;
    esac
}

# 派复审时记下 PR 此刻的最新提交**和目标分支**：daemon 只把这一个提交合进这一个目标分支。
# 之后有新推送、或改投了别的目标分支（同一提交对另一个分支是另一份改动），都必须重审。
# 先读再派工：派工之后才发生的变化一定对不上（安全方向）。读不全就清掉旧记录（→ 重审）。
# 永远 return 0：记不下来只会让合并前多一轮重审，不许把整轮派工带崩。
autopilot_remember_review() {   # <state_file> <PR 编号>
    local sf="$1" pr="$2" pj head base at
    pj=$(gh api "repos/$REPO/pulls/$pr" 2>/dev/null) || pj=""
    head=$(printf '%s' "$pj" | jq -r '.head.sha // ""' 2>/dev/null) || head=""
    base=$(printf '%s' "$pj" | jq -r '.base.ref // ""' 2>/dev/null) || base=""
    # 时间用 jq 算，不用 `date -d @…`（GNU 才有，macOS 的 BSD date 不认）。
    # 往前留 2 分钟：本机时钟比 GitHub 快一点时，复审刚发的评论也不会被判成「早于派工」
    at=$(jq -nr 'now - 120 | floor | strftime("%Y-%m-%dT%H:%M:%SZ")' 2>/dev/null) || at=""
    if [ -z "$head" ] || [ -z "$base" ] || [ -z "$at" ]; then
        log "  ⚠️ 托管：读不全 PR #$pr 的提交 / 目标分支（或算不出时间），不记复审记录（合并前会要求重新复审）"
        autopilot_state_set "$sf" '.prs[$p] = ((.prs[$p] // {}) | del(.reviewed_head, .reviewed_base, .reviewed_at))' \
            --arg p "$pr" || true
        return 0
    fi
    autopilot_state_set "$sf" '.prs[$p] = ((.prs[$p] // {}) + {reviewed_head: $h, reviewed_base: $b, reviewed_at: $t})' \
        --arg p "$pr" --arg h "$head" --arg b "$base" --arg t "$at" || true
    log "托管：PR #$pr 派复审，记下复审的提交 ${head:0:7} → $base"
    return 0
}

# 复审亲手重跑测试的记录：复审在通过评论里留一行
#   <!-- autopilot-review-pass head=<提交> passed=<通过数> failed=<失败数> -->
# 认的条件：写入账号发的、在这次派复审之后、提交号就是要合的那个、失败 0、通过 ≥ 1。
# daemon 只能核对「贴没贴、对不对得上」，证明不了真跑了 —— 这是方案 Q2 选 A 时写明的代价。
autopilot_review_evidence() {   # <PR> <提交> <派复审时间> → 0 有 / 1 没有 / 2 读不到
    local pr="$1" head="$2" since="$3" me cm
    me=$(write_identity_login)
    [ -n "$me" ] || return 2
    cm=$(gh api --paginate --slurp "repos/$REPO/issues/$pr/comments" 2>/dev/null) || return 2
    if printf '%s' "$cm" | jq -e --arg me "$me" --arg h "$head" --arg t "$since" '
        [ .[][]?
          | select(((.user.login // "") | ascii_downcase) == ($me | ascii_downcase) and (.created_at // "") >= $t)
          | (.body // "")
          | capture("<!-- autopilot-review-pass head=(?<h>[0-9a-f]{40,64}) passed=(?<p>[0-9]+) failed=(?<f>[0-9]+) -->")?
          | select(.h == $h and (.f | tonumber) == 0 and (.p | tonumber) > 0) ] | length > 0' >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

# 提交上的自动检查（check runs + 老式 commit status）。
# AUTOPILOT_CHECKS = pass / none（一个检查都没有）/ pending / fail / error（读不到），
# AUTOPILOT_CHECKS_DETAIL = 没过 / 没跑完的检查名
autopilot_checks() {   # <提交>
    local sha="$1" runs st out
    AUTOPILOT_CHECKS=error; AUTOPILOT_CHECKS_DETAIL=""
    runs=$(mktemp); st=$(mktemp)
    if ! gh api --paginate --slurp "repos/$REPO/commits/$sha/check-runs" > "$runs" 2>/dev/null \
       || ! gh api "repos/$REPO/commits/$sha/status" > "$st" 2>/dev/null; then
        rm -f "$runs" "$st"; return 0
    fi
    out=$(jq -rn --slurpfile r "$runs" --slurpfile s "$st" '
        ([ $r[0][]?.check_runs[]? ]) as $cr
        | ($s[0].statuses // []) as $ss
        | ([ $cr[] | select(.status == "completed"
                            and ((.conclusion // "") as $c | ["success", "neutral", "skipped"] | index($c) | not))
                   | .name ]
           + [ $ss[] | select(.state == "failure" or .state == "error") | .context ]) as $bad
        | ([ $cr[] | select(.status != "completed") | .name ] + [ $ss[] | select(.state == "pending") | .context ]) as $wait
        | if ($bad | length) > 0 then "fail\t\($bad | join(", "))"
          elif ($wait | length) > 0 then "pending\t\($wait | join(", "))"
          elif (($cr | length) + ($ss | length)) == 0 then "none\t"
          else "pass\t" end' 2>/dev/null) || out=""
    rm -f "$runs" "$st"
    [ -n "$out" ] || return 0
    AUTOPILOT_CHECKS="${out%%$'\t'*}"
    AUTOPILOT_CHECKS_DETAIL="${out#*$'\t'}"
}

autopilot_daemon_sig() { printf '<sub>cavil-loop daemon @ %s 自动留言</sub>' "$(hostname -s 2>/dev/null || hostname)"; }

# ── 交人的写前核对（GitHub#382）──
# 交人要连发几个独立请求（发说明 → 加 pending/human → 摘 pending/merge），GitHub 没有「状态没变才写」的写法，
# 所以三条流程（交人 autopilot_to_human、PR 上已挂 pending/human 的收尾 autopilot_halt_dequeue、托管关掉后的
# 收尾 autopilot_off_sweep）都照同两条规则：
#   1. 判定被基准夹住：先取一份现状指纹作基准，再判定，再取一次确认和基准相同。更早的判断只算触发，不作依据。
#   2. 之后每次写入之前现取指纹，必须等于「基准 + daemon 自己已确认的写入」；别的差异一概停手，本轮不再写。
# 消除不了的窗口只剩「最后一次取指纹」到「写请求到达 GitHub」之间。
#
# 指纹（一行 JSON，键排好序，整串比较）：
#   pr     {open, draft, head, base, ref, repo, body（正文校验和）, labels（排序）, q, last}
#   issue  {open, labels, last}（绑了 issue 才有）；parent 同 issue（拆分子项才有）
#   q    = 排队编号：标签记录里最后一次「加上等合并标签」那条事件的编号（同一提交重新入队就变）
#   last = 标签记录里最后一条加 / 摘标签事件的编号（任何人动过任何标签就变）
# 只在同一个条目的标签事件之间比编号；不和评论编号比、不比时间（GitHub#337 实测：评论编号和事件编号不可比）。
# 读不到、事件缺编号 / 编号重复、等合并标签或 pending/human 在记录里的最后一次和当前标签对不上 → 分不清（return 1），
# 调用方本轮不写。
#
# 字段规则（都在 autopilot_fp_place 这一处校验；缺字段、类型不对、不认识的状态词一律是「分不清」，绝不默认成
# 「没合并」「不是草稿」「已关闭」——代码复审第 1 轮：缺 merged 的响应被当成没合并，照样交了人；不认识的 state 被当成
# 「有人动过」，删掉了还欠着说明的待办）：
#   PR 和 issue 都要：state 是 "open" 或 "closed"；labels 是数组，每项的 name 是字符串
#   PR 另外要：merged、draft 是布尔值；head.sha、head.ref、base.ref 是非空字符串
#   标签事件：是「页的数组」，每页是数组；加 / 摘标签的事件 id 是数字、不重复，label.name 是字符串

# 一处的现状。结果在 AF_PLACE（一行 JSON）、AF_EVENTS（这一处的标签事件 [{id,event,name,actor}]，按编号排序）；
# 分不清时 return 1、AF_WHY 是原因。在调用方自己的 shell 里调。
autopilot_fp_place() {   # <编号> <pr|issue> [仓库]
    local n="$1" kind="$2" repo="${3:-$REPO}" j ev ck out m="${AUTOPILOT_MERGE_LABEL_NAME:-$LABEL_PENDING_MERGE}"
    AF_PLACE=""; AF_EVENTS=""; AF_WHY=""
    if [ "$kind" = pr ]; then j=$(gh api "repos/$repo/pulls/$n" 2>/dev/null) || j=""
    else j=$(gh api "repos/$repo/issues/$n" 2>/dev/null) || j=""; fi
    if [ -z "$j" ]; then AF_WHY="读不到 #$n"; return 1; fi
    if ! ev=$(gh api --paginate --slurp "repos/$repo/issues/$n/events" 2>/dev/null) || [ -z "$ev" ]; then
        AF_WHY="读不到 #$n 的标签记录"; return 1
    fi
    ck=$(printf '%s' "$j" | jq -r '.body // ""' 2>/dev/null | cksum 2>/dev/null | tr -s ' \t' '-') || ck=""
    if [ -z "$ck" ]; then AF_WHY="读不懂 #$n"; return 1; fi
    # 条目和事件都从 stdin 进 jq：事件列表可以很长，放不进命令行参数
    if ! out=$({ printf '%s\n' "$j"; printf '%s\n' "$ev"; } | jq -cS -s --arg M "$m" --arg H "$LABEL_PENDING_HUMAN" --arg kind "$kind" --arg ck "$ck" '
        .[0] as $j | .[1] as $ev
        | if ($j | type) != "object" or ($j.labels | type) != "array" or ($ev | type) != "array"
             or any($ev[]; type != "array") or any($ev[][]; type != "object")
             or any($j.labels[]; (type != "object") or ((.name | type) != "string"))
          then error("shape") else . end
        | if ($j.state == "open" or $j.state == "closed") then . else error("state") end
        | if $kind == "pr" and ((($j.merged | type) != "boolean") or (($j.draft | type) != "boolean")
                                or (($j.head | type) != "object") or (($j.base | type) != "object"))
          then error("fields") else . end
        | [ $ev[][] | select(.event == "labeled" or .event == "unlabeled")
            | {id, event, name: .label.name, actor: (.actor.login // "")} ] as $raw
        | if any($raw[]; ((.id | type) != "number") or ((.name | type) != "string")) then error("id") else . end
        | if ($raw | map(.id) | unique | length) != ($raw | length) then error("dup") else . end
        | ($raw | sort_by(.id)) as $le
        | ($j.labels | map(.name) | sort) as $labels
        | if all([$M, $H][]; . as $L
                 | (($le | map(select(.name == $L)) | last | .event) == "labeled") == ($labels | index($L) != null))
          then . else error("mismatch") end
        | { events: $le,
            place: ({open: ($j.state == "open" and ($kind != "pr" or $j.merged == false)), labels: $labels, last: ($le | last | .id)}
                    + (if $kind == "pr" then
                         (if all([$j.head.sha, $j.head.ref, $j.base.ref][]; (type == "string") and (. != ""))
                          then . else error("fields") end)
                         | {draft: $j.draft, head: $j.head.sha, base: $j.base.ref, ref: $j.head.ref,
                            repo: ($j.head.repo.full_name // ""), body: $ck,
                            q: ($le | map(select(.name == $M and .event == "labeled")) | last | .id)}
                       else {} end)) }' 2>/dev/null) || [ -z "$out" ]; then
        AF_WHY="#$n 的现状或标签记录读不全（缺字段、不认识的状态、事件缺编号，或标签记录和当前标签对不上）"; return 1
    fi
    AF_PLACE=$(printf '%s' "$out" | jq -cS '.place') || return 1
    AF_EVENTS=$(printf '%s' "$out" | jq -c '.events') || return 1
    [ -n "$AF_PLACE" ] && [ -n "$AF_EVENTS" ]
}

# 整份指纹：PR，加上（给了的话）绑定的 issue 和拆分子项的父 issue。结果在 AF_FP、AF_PR_EVENTS；return 1 = 分不清
autopilot_fingerprint() {   # <PR> [issue 编号] [父 issue「仓库#编号」]
    local pr="$1" n="${2:-}" parent="${3:-}" a b=null c=null
    AF_FP=""; AF_PR_EVENTS=""
    autopilot_fp_place "$pr" pr || return 1
    a="$AF_PLACE"; AF_PR_EVENTS="$AF_EVENTS"
    if [ -n "$n" ]; then autopilot_fp_place "$n" issue || return 1; b="$AF_PLACE"; fi
    if [ -n "$parent" ]; then autopilot_fp_place "${parent##*#}" issue "${parent%#*}" || return 1; c="$AF_PLACE"; fi
    AF_FP=$(jq -cnS --argjson a "$a" --argjson b "$b" --argjson c "$c" '{pr: $a, issue: $b, parent: $c}' 2>/dev/null) || AF_FP=""
    if [ -z "$AF_FP" ]; then AF_WHY="拼不出 PR #$pr 的现状"; return 1; fi
}

# 现取指纹，必须和 <预期> 一字不差。0 = 相同；1 = 不同或分不清（AF_WHY）
autopilot_fp_expect() {   # <预期指纹> <PR> [issue] [父]
    local want="$1"; shift
    autopilot_fingerprint "$@" || return 1
    [ "$AF_FP" = "$want" ] && return 0
    AF_WHY="PR #$1 的现状和判定时不一样了（有人动过）"; return 1
}

# 刚取的指纹（AF_FP / AF_PR_EVENTS）是不是「<基准> + 恰好一次 daemon 自己的标签写入」：基准之后 PR 的标签记录
# 恰好多一条、是写入账号做的这一次加 / 摘，其余一字不差。多出别的事件、或那一条不是写入账号的 → 1
autopilot_fp_is_own_write() {   # <基准指纹> <labeled|unlabeled> <标签>
    local base="$1" op="$2" label="$3" me want m="${AUTOPILOT_MERGE_LABEL_NAME:-$LABEL_PENDING_MERGE}"
    me=$(write_identity_login)
    [ -n "$me" ] && [ -n "$AF_FP" ] || return 1
    want=$(printf '%s' "$AF_PR_EVENTS" | jq -cS --argjson b "$base" --arg op "$op" --arg L "$label" --arg me "$me" --arg M "$m" '
        ($b.pr.last // -1) as $last | [ .[] | select(.id > $last) ] as $new
        | if ($new | length) == 1 and $new[0].event == $op and $new[0].name == $L
             and (($new[0].actor | ascii_downcase) == ($me | ascii_downcase))
          then $b | .pr.last = $new[0].id
               | .pr.labels = (if $op == "labeled" then (.pr.labels + [$L] | unique) else (.pr.labels - [$L]) end)
               | (if $op == "labeled" and $L == $M then .pr.q = $new[0].id else . end)
          else empty end' 2>/dev/null) || want=""
    [ -n "$want" ] && [ "$want" = "$AF_FP" ]
}

# 摘一个标签，确认摘掉了才算成功：2xx，或 404（已经不在了）
autopilot_label_delete() {   # <编号> <标签>
    local out
    out=$(gh_write api -X DELETE "repos/$REPO/issues/$1/labels/$(printf '%s' "$2" | jq -sRr @uri)" 2>&1) && return 0
    case "$out" in *"HTTP 404"*) return 0 ;; esac
    log "  ⚠️ 托管：#$1 摘 $2 失败：$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
    return 1
}

# 交人原因重判：合并许可原样再判一遍，结论、原因代号、命中内容和身份都要和触发时（HO_*）一样。
# 「读不到到上限」那种只要求仍是读不到（读不到的位置可以不同；提交 / 分支由指纹比）
autopilot_handover_rejudge() {   # <state_file> <PR> [mine：PR 上那枚 pending/human 是 daemon 本次已确认加上的]
    local AP_HANDOVER_MINE="${3:-}"
    autopilot_permit "$1" "$2"
    [ "$AP_V" = "$HO_WANT" ] && [ "$AP_STOP" = "$HO_STOP" ] && [ "$AP_STOP_KEY" = "$HO_SKEY" ] \
        && [ "$AP_N" = "$HO_N" ] && [ "$AP_KIND" = "$HO_KIND" ] && [ "$AP_PARENT" = "$HO_PARENT" ] || return 1
    [ "$HO_WANT" = unknown ] && return 0
    [ "$AP_HEAD" = "$HO_HEAD" ] && [ "$AP_BASE" = "$HO_BASE" ] && [ "$AP_REF" = "$HO_REF" ]
}

# 交人（所有托管交人原因共用，流程一）：说明 → 加 pending/human → 摘 pending/merge，每次写入之前都核对。
# 调用时 AP_* 是触发这次交人的那次许可判定的结果；<期望的许可结论> 是那次判定的 AP_V。触发只是触发：
# 作数的判定在这里重做，夹在两次取指纹之间。不记本机待办——中断后 PR 上的标签和已发的说明就是进度：
#   仍在合并队列 → 下一轮从头重判；同一次入队、同一提交、同一原因的说明已在就不重发；
#   两枚标签都在 → 下一轮走 autopilot_halt_dequeue。
# 顺序固定：先摘等合并标签的话，许可判断就不再认这个 PR，后面的重判全部失效。
autopilot_to_human() {   # <state_file> <PR> <原因代号> <期望的许可结论> <原因> [怎么继续]
    local sf="$1" pr="$2" why="$3" reason="$5" next="${6:-}" fp0 fp1 q head me cmts marker body
    local HO_WANT="$4" HO_STOP="$AP_STOP" HO_SKEY="$AP_STOP_KEY" HO_N="$AP_N" HO_KIND="$AP_KIND" HO_PARENT="$AP_PARENT"
    local HO_HEAD="$AP_HEAD" HO_BASE="$AP_BASE" HO_REF="$AP_REF"
    [ -n "$next" ] || next="要继续托管：处理好之后把 PR 的标签改成 \`${LABEL_PENDING_REVIEW}\`（重新复审，通过后 daemon 再检查、合并）。不托管了：自己审、自己合并。"
    # ① 基准
    if ! autopilot_fingerprint "$pr" "$HO_N" "$HO_PARENT"; then
        log "托管：PR #$pr 该交人（$reason），但交人前读不全现状（$AF_WHY），本轮不写，下轮再试"; return 0
    fi
    fp0="$AF_FP"
    if ! printf '%s' "$fp0" | jq -e --arg M "$LABEL_PENDING_MERGE" --arg H "$LABEL_PENDING_HUMAN" \
            '.pr.open and (.pr.labels | index($M) != null) and (.pr.labels | index($H) == null)' >/dev/null 2>&1; then
        log "托管：PR #$pr 交人前现状已变（不在合并队列、已挂 $LABEL_PENDING_HUMAN 或已关闭），本轮不写"; return 0
    fi
    q=$(printf '%s' "$fp0" | jq -r '.pr.q // ""'); head=$(printf '%s' "$fp0" | jq -r '.pr.head // ""')
    me=$(write_identity_login)
    if [ -z "$q" ] || [ -z "$head" ] || [ -z "$me" ]; then
        log "托管：PR #$pr 交人前读不到排队记录或写入账号，本轮不写"; return 0
    fi
    # ② 已经发过的说明（认本次入队：标记里有排队编号）
    if ! cmts=$(gh api --paginate --slurp "repos/$REPO/issues/$pr/comments" 2>/dev/null) || [ -z "$cmts" ] \
       || ! printf '%s' "$cmts" | jq -e 'type == "array"' >/dev/null 2>&1; then
        log "托管：PR #$pr 交人前读不到已有评论（分不清说明发没发过），本轮不写"; return 0
    fi
    marker="<!-- cavil-loop:autopilot-handover pr=$pr q=$q head=$head why=$why -->"
    # ③ 作数的判定 + 确认基准
    if ! autopilot_handover_rejudge "$sf" "$pr"; then
        log "托管：PR #$pr 交人之前重判有变化（重判结果 $AP_V${AP_REASON:+：$AP_REASON}），本轮不写"; return 0
    fi
    if ! autopilot_fp_expect "$fp0" "$pr" "$HO_N" "$HO_PARENT"; then
        log "托管：PR #$pr 交人之前现状有变化（$AF_WHY），本轮不写"; return 0
    fi
    # ④ 说明
    if ! printf '%s' "$cmts" | jq -e --arg T "$marker" --arg me "$me" \
            'any(.[][]?; ((.user.login // "") | ascii_downcase) == ($me | ascii_downcase) and ((.body // "") | contains($T)))' >/dev/null 2>&1; then
        body="$(printf '⚠️ **自动处理已暂停，转人工（`%s`）**\n\n**原因**：%s\n\n**怎么继续**：%s\n\n%s\n%s' \
            "$LABEL_PENDING_HUMAN" "托管自动合并已停下。$reason" "$next" "$(autopilot_daemon_sig)" "$marker")"
        if ! run_gh "托管交人说明评论 (PR #$pr)" gh_write api -X POST "repos/$REPO/issues/$pr/comments" -f "body=$body"; then
            log "托管：PR #$pr 交人说明没发出去，不翻标签，下轮再试"; return 0
        fi
        AUTOPILOT_ACTED=1
        if ! autopilot_handover_rejudge "$sf" "$pr"; then
            log "托管：PR #$pr 说明发出后重判有变化（重判结果 $AP_V${AP_REASON:+：$AP_REASON}），不翻标签"; return 0
        fi
        if ! autopilot_fp_expect "$fp0" "$pr" "$HO_N" "$HO_PARENT"; then
            log "托管：PR #$pr 说明发出后现状有变化（$AF_WHY），不翻标签"; return 0
        fi
    fi
    # ⑤ 加 pending/human，再确认多出来的恰好是自己这一次
    if ! run_gh "托管交人：PR #$pr 加 $LABEL_PENDING_HUMAN" \
            gh_write api -X POST "repos/$REPO/issues/$pr/labels" -f "labels[]=$LABEL_PENDING_HUMAN"; then
        return 0
    fi
    AUTOPILOT_ACTED=1
    if ! autopilot_fingerprint "$pr" "$HO_N" "$HO_PARENT" || ! autopilot_fp_is_own_write "$fp0" labeled "$LABEL_PENDING_HUMAN"; then
        log "托管：PR #$pr 加 $LABEL_PENDING_HUMAN 之后现状对不上（${AF_WHY:-除了这一次加标签还有别的变化}），不摘 $LABEL_PENDING_MERGE，下轮按现状处理"
        return 0
    fi
    fp1="$AF_FP"
    # ⑥ 摘等合并标签
    if ! autopilot_handover_rejudge "$sf" "$pr" mine; then
        log "托管：PR #$pr 摘 $LABEL_PENDING_MERGE 之前重判有变化（重判结果 $AP_V${AP_REASON:+：$AP_REASON}），不摘，下轮按现状处理"; return 0
    fi
    if ! autopilot_fp_expect "$fp1" "$pr" "$HO_N" "$HO_PARENT"; then
        log "托管：PR #$pr 摘 $LABEL_PENDING_MERGE 之前现状有变化（$AF_WHY），不摘，下轮按现状处理"; return 0
    fi
    autopilot_label_delete "$pr" "$LABEL_PENDING_MERGE" || return 0
    autopilot_state_set "$sf" '.prs[$p] = ((.prs[$p] // {}) | del(.unknown, .checks_pending_since))' --arg p "$pr" || true
    log "托管：PR #$pr 交人 → $LABEL_PENDING_HUMAN：$reason"
}

# 开着的 PR 同时挂着 pending/human 和等合并标签 → 只摘等合并标签，不说话（流程二）。维护者自己叫停、
# autopilot_to_human 加完 pending/human 后停下或中断，都走这里。判定的全部输入（开着、两枚标签都在）都在指纹里，
# 所以判定直接从基准得出；摘之前现取指纹必须等于基准。
autopilot_halt_dequeue() {   # <PR>
    local pr="$1" fp
    if ! autopilot_fingerprint "$pr"; then
        log "托管：PR #$pr 上挂着 $LABEL_PENDING_HUMAN，摘 $LABEL_PENDING_MERGE 之前读不全现状（$AF_WHY），下轮再试"; return 0
    fi
    fp="$AF_FP"
    if ! printf '%s' "$fp" | jq -e --arg M "$LABEL_PENDING_MERGE" --arg H "$LABEL_PENDING_HUMAN" \
            '.pr.open and (.pr.labels | index($M) != null) and (.pr.labels | index($H) != null)' >/dev/null 2>&1; then
        log "托管：PR #$pr 现状已变（不再同时挂着两个标签，或已关闭），本轮不写"; return 0
    fi
    if ! autopilot_fp_expect "$fp" "$pr"; then
        log "托管：PR #$pr 摘 $LABEL_PENDING_MERGE 之前现状有变化（$AF_WHY），本轮不写"; return 0
    fi
    autopilot_label_delete "$pr" "$LABEL_PENDING_MERGE" || return 0
    AUTOPILOT_ACTED=1
    log "托管：PR #$pr 上挂着 $LABEL_PENDING_HUMAN（已被叫停）→ 不合并，摘掉 $LABEL_PENDING_MERGE"
}

# 交回 worker 修（检查没过、冲突）。打回次数单独计，上限沿用复审轮数上限 REVIEW_MAX_ROUNDS。
autopilot_to_worker() {   # <state_file> <PR> <issue 编号> <原因>
    local sf="$1" pr="$2" issue_n="$3" reason="$4" bounces cap label body
    bounces=$(autopilot_state_get "$sf" '.prs[$p].bounces // 0' --arg p "$pr"); bounces="${bounces:-0}"
    cap="${REVIEW_MAX_ROUNDS:-6}"
    if [ "$bounces" -ge "$cap" ] 2>/dev/null; then
        autopilot_to_human "$sf" "$pr" bounce-cap worker "合并前检查已经打回 worker $bounces 次（上限 $cap），这次仍没过：$reason"
        return 0
    fi
    label=$(pr_conflict_return_label "$issue_n" "$sf")
    body="$(printf '## ❌ 托管：合并前检查没过，已交回 worker\n\n**原因**：%s\n\n**给 worker**：修好后照常推送，并把 PR 交回复审（`%s`）；复审通过后 daemon 会重新检查再合并。这是第 %s 次打回，上限 %s 次。\n\n%s' \
        "$reason" "$LABEL_PENDING_REVIEW" "$((bounces + 1))" "$cap" "$(autopilot_daemon_sig)")"
    run_gh "托管打回评论 (PR #$pr)" gh_write api -X POST "repos/$REPO/issues/$pr/comments" -f "body=$body" || return 0
    AUTOPILOT_ACTED=1
    run_gh "label 翻转 (托管 PR #$pr → $label)" \
        gh_label_flip "$pr" --add "$label" --remove "$LABEL_PENDING_MERGE" || return 0
    autopilot_state_set "$sf" '.prs[$p] = ((.prs[$p] // {}) | .bounces = ((.bounces // 0) + 1) | del(.unknown, .checks_pending_since))' \
        --arg p "$pr" || true
    log "托管：PR #$pr 合并前检查没过 → 交回 worker（$label）：$reason"
}

# 复审之后有新提交 / 没有复审记录 → 重新交复审
autopilot_to_review() {   # <state_file> <PR> <现在的提交> <复审时记下的提交> [现在的目标分支] [复审时的目标分支]
    local sf="$1" pr="$2" head="$3" rh="$4" base="${5:-}" rbase="${6:-}" why body
    if [ -n "$rh" ] && [ "$rh" != "$head" ]; then
        why="复审看的是提交 \`${rh:0:7}\`，PR 现在的最新提交是 \`${head:0:7}\`：复审之后又有了新提交"
    elif [ -n "$rh" ] && [ -n "$rbase" ] && [ "$rbase" != "$base" ]; then
        why="复审时 PR 要合进 \`$rbase\`，现在改投了 \`$base\`：同一个提交对另一个分支是另一份改动，复审没看过"
    elif [ -n "$rh" ]; then
        why="本机的复审记录不完整（没记目标分支，可能是旧版记下的），不知道复审看的是合进哪个分支的改动"
    else
        why="本机没有这个 PR 的复审记录（复审在别处派的，或本机状态丢了），不知道复审看的是哪个提交"
    fi
    body="$(printf '## 托管：重新交复审\n\n%s。daemon 只合并复审亲眼看过的那个提交，所以把 PR 重新交给复审（`%s`），通过后再检查、合并。\n\n%s' \
        "$why" "$LABEL_PENDING_REVIEW" "$(autopilot_daemon_sig)")"
    run_gh "托管重审评论 (PR #$pr)" gh_write api -X POST "repos/$REPO/issues/$pr/comments" -f "body=$body" || return 0
    AUTOPILOT_ACTED=1
    run_gh "label 翻转 (托管 PR #$pr → $LABEL_PENDING_REVIEW)" \
        gh_label_flip "$pr" --add "$LABEL_PENDING_REVIEW" --remove "$LABEL_PENDING_MERGE" || return 0
    autopilot_state_set "$sf" '.prs[$p] = ((.prs[$p] // {}) | del(.unknown, .checks_pending_since))' --arg p "$pr" || true
    log "托管：PR #$pr 重新交复审：$why"
}

# 读不到：本轮什么都不写；连续 AUTOPILOT_UNKNOWN_MAX 轮读不到才交人
autopilot_unknown() {   # <state_file> <PR> <原因> [触发时的许可结论，默认 unknown；合并请求失败时是 ok]
    local sf="$1" pr="$2" reason="$3" k cap
    cap="${AUTOPILOT_UNKNOWN_MAX:-10}"
    [[ "$cap" =~ ^[0-9]+$ ]] && [ "$cap" -gt 0 ] || cap=10
    k=$(autopilot_state_get "$sf" '.prs[$p].unknown // 0' --arg p "$pr"); k=$(( ${k:-0} + 1 ))
    if [ "$k" -ge "$cap" ]; then
        autopilot_to_human "$sf" "$pr" unknown-cap "${4:-unknown}" "连续 $k 轮读不到判断所需的信息，最后一次：$reason"
        return 0
    fi
    autopilot_state_set "$sf" '.prs[$p] = ((.prs[$p] // {}) + {unknown: ($k | tonumber)})' --arg p "$pr" --arg k "$k" || true
    log "托管：PR #$pr 本轮判不了（第 $k/$cap 次，下轮再查）：$reason"
}

# 改动有没有碰仓库自动化（.github/）：ok / touches / unknown
autopilot_files_verdict() {   # <PR>
    local files
    if ! files=$(gh api --paginate --slurp "repos/$REPO/pulls/$1/files" 2>/dev/null) || [ -z "$files" ]; then
        echo unknown; return 0
    fi
    if printf '%s' "$files" | jq -e '[ .[][]? | (.filename // ""), (.previous_filename // empty) ] | any(startswith(".github/"))' >/dev/null 2>&1; then
        echo touches
    else
        echo ok
    fi
}
# 改动有没有碰「合并前必须人过目」的文件（GitHub#337，只在 AUTOPILOT_HUMAN_PATHS 非空时调用）。
# 结果放全局变量（在调用方自己的 shell 里调，不放进 $( )）：
#   AP_PATHS_V       ok（读全了、没命中）/ hit（命中）/ bad（清单里有写法不认识的条目）/ unread（读不全）
#   AP_PATHS_DETAIL  hit：命中的文件，JSON 数组（排序去重）；bad：不认识的条目和原因；unread：原因
#
# 条目写法（空格或逗号分隔，和 .gitignore 的常用部分一致）：
#   开头 /  = 只认仓库根目录（/setup.sh 不命中 tools/setup.sh）；不写 = 任何深度（package.json 命中 client/package.json）
#   末尾 /  = 目录（其下任何文件）；没有 = 文件。* 只在一段内通配
#   default = 内置清单 AUTOPILOT_HUMAN_PATHS_DEFAULT；/.github/ 始终在清单里，配置去不掉
#   写法不认识（开头没 / 却在中间含 /、含 . 或 .. 段、空段、**）→ bad，绝不悄悄忽略：忽略 = 少拦
# 读全：PR 详情自报的改动文件数（changed_files）和列表条数对得上才算读全。缺页（这个接口一个 PR 最多给
# 3000 个文件）、缺自报数、坏响应、请求失败、空输出都是 unread —— 读不到绝不当成「没命中」。
# 改名的文件新旧路径都拿来匹配。
autopilot_paths_verdict() {   # <PR> <PR JSON>
    local pr="$1" pj="$2" files out
    AP_PATHS_V=unread; AP_PATHS_DETAIL=""
    # 先看配置（不用读 GitHub）：写错了就不必读文件列表
    out=$(jq -rn --arg spec "$AUTOPILOT_HUMAN_PATHS" --arg def "$AUTOPILOT_HUMAN_PATHS_DEFAULT" "$AUTOPILOT_PATHS_JQ"'
        rules($spec; $def) | map(select(.bad)) | if length > 0 then "bad\t\(.[0].raw)（\(.[0].bad)）" else "fine" end' 2>/dev/null) || out=""
    case "$out" in
        fine) ;;
        bad$'\t'*) AP_PATHS_V=bad; AP_PATHS_DETAIL="${out#*$'\t'}"; return 0 ;;
        *) AP_PATHS_DETAIL="清单解析失败"; return 0 ;;
    esac
    if ! files=$(gh api --paginate --slurp "repos/$REPO/pulls/$pr/files" 2>/dev/null) || [ -z "$files" ]; then
        AP_PATHS_DETAIL="请求失败或空输出"; return 0
    fi
    out=$(printf '%s' "$files" | jq -r --arg spec "$AUTOPILOT_HUMAN_PATHS" --arg def "$AUTOPILOT_HUMAN_PATHS_DEFAULT" \
        --argjson pj "$pj" "$AUTOPILOT_PATHS_JQ"'
        ($pj.changed_files) as $n
        | if ($n | type) != "number" or $n < 0 or $n != ($n | floor) then "unread\tPR 详情里没有可用的改动文件数"
          elif (type != "array") or (all(.[]; type == "array") | not)
               or (all(.[][]; type == "object" and (.filename | type) == "string" and .filename != ""
                               and ((.previous_filename // "") | type) == "string") | not)
          then "unread\t文件列表的形状不对"
          elif ([.[][]] | length) != $n then "unread\t列表有 \([.[][]] | length) 个文件，PR 自报 \($n) 个"
          else (rules($spec; $def) | map(.re)) as $res
            | ([ .[][] | .filename, (.previous_filename // empty) | select(. != "") ]
               | map(select(. as $f | any($res[]; . as $re | $f | test($re)))) | unique) as $hits
            | if ($hits | length) > 0 then "hit\t\($hits | tojson)" else "ok\t" end
          end' 2>/dev/null) || out=""
    case "$out" in
        ok$'\t'*) AP_PATHS_V=ok ;;
        hit$'\t'*) AP_PATHS_V=hit; AP_PATHS_DETAIL="${out#*$'\t'}" ;;
        unread$'\t'*) AP_PATHS_DETAIL="${out#*$'\t'}" ;;
        *) AP_PATHS_DETAIL="文件列表不是合法的 JSON" ;;
    esac
}
# 清单条目 → 正则。rules(spec; def)：[{raw, re} | {raw, bad}]
# shellcheck disable=SC2016
AUTOPILOT_PATHS_JQ='
    def esc: explode | map([.] | implode | . as $c
        | if $c == "*" then "[^/]*"
          elif ([".", "^", "$", "+", "?", "(", ")", "[", "]", "{", "}", "|", "\\"] | index($c)) != null then "\\" + $c
          else $c end) | join("");
    def rule: . as $raw
        | startswith("/") as $rooted | endswith("/") as $dir
        | (if $rooted then .[1:] else . end | if $dir then .[:-1] else . end) as $core
        | ($core | split("/")) as $segs
        | if $core == "" then {raw: $raw, bad: "空条目"}
          elif ($segs | any(. == "")) then {raw: $raw, bad: "有空的一段"}
          elif ($segs | any(. == "." or . == "..")) then {raw: $raw, bad: "不能含 . 或 .. 段"}
          elif ($core | contains("**")) then {raw: $raw, bad: "不支持 **"}
          elif (($rooted | not) and ($segs | length) > 1) then {raw: $raw, bad: "中间含 / 的条目要以 / 开头"}
          else {raw: $raw, re: ((if $rooted then "^" else "(^|/)" end) + ($segs | map(esc) | join("/")) + (if $dir then "/" else "$" end))}
          end;
    def rules($spec; $def):
        ([$spec | splits("[,\\s]+") | select(. != "")]
         | map(if . == "default" then ($def | splits("\\s+") | select(. != "")) else . end)
         | ["/.github/"] + . | unique) | map(rule);
'

# 与目标分支冲突没有：GitHub 两个信号任一说冲突就算冲突（mergeable=false 或 mergeable_state=dirty），
# mergeable=null 是还在算。输出 ok / conflict / computing
autopilot_conflict_verdict() {   # <PR JSON>
    printf '%s' "$1" | jq -r 'if .mergeable == false or .mergeable_state == "dirty" then "conflict"
                              elif .mergeable == null then "computing" else "ok" end' 2>/dev/null || echo computing
}

# ── 合并许可：一个纯判断函数，两次调用（GitHub#114 复审第 2 轮）──
# 合并许可依赖的输入全部在这里读、在这里判，**不写任何东西**（不发评论、不翻标签、不改 state）：
#
#   远端、可被人或 agent 随时改的（每次调用都现读）：
#     PR：开着 / 未合并 / 草稿 / 提交 / 目标分支 / 分支名 / 来源仓库 / 标签（pending/merge、叫停）/
#         正文（绑定）/ 能否合并（冲突）
#     issue：开着 / 标签（托管标签、叫停）/ 标签记录（授权人）/ 授权人权限
#     PR 改动文件（.github/）、PR 评论（复审测试记录：可编辑、可删除）、提交上的检查
#   本机、只有持着轮询锁的 daemon 会写的：复审记录（提交 / 目标分支 / 时间）
#
# autopilot_merge_one 先调一次决定怎么处理；判定为可以合并时，紧挨着合并请求**原样再调一次**，
# 两次结果都是 ok 且身份（提交 / 目标分支 / issue）一致才合并。第二次走的就是同一个函数，所以
# 「最后一刻重读漏了某一项」这类问题不会再出现——以后加新的合并条件，只要加进这里，两处都有。
#
# 结果放在全局变量里（必须在调用方自己的 shell 里调，不能放进 $( )）：
#   AP_V        skip / halt_pr / human / worker / review / unknown / wait_checks / computing / ok
#   AP_REASON   给人看的一句话；AP_NEXT 交人时「怎么继续」（可空）
#   AP_N AP_HEAD AP_BASE AP_REF AP_RH AP_RB AP_RAT AP_CHECKS AP_CHECKS_DETAIL
#   AP_KIND（issue / pr，GitHub#142；pr 时 AP_N 为空）AP_WN（这个 PR 的工作编号）
#   AP_STOP    结论是 human 时的原因代号（draft / not-eligible / issue-halt / auth / github-dir / paths /
#              paths-config / no-evidence），AP_STOP_KEY 是命中的内容（只有需人过目清单那两种有）；交人说明的
#              隐藏标记和交人前的重判都认它（GitHub#337 / #382）。加新的交人原因时在这里给一个代号
#   AP_PARENT  绑的 issue 是拆分子项时，父 issue 的「仓库#编号」（交人的写前核对连它一起比，GitHub#382）
autopilot_permit() {   # <state_file> <PR 编号>
    local sf="$1" pr="$2" pj ij labels rc
    AP_V=unknown; AP_REASON=""; AP_NEXT=""; AP_N=""; AP_KIND=""; AP_WN=""; AP_HEAD=""; AP_BASE=""; AP_REF=""
    AP_RH=""; AP_RB=""; AP_RAT=""; AP_CHECKS=""; AP_CHECKS_DETAIL=""; AP_BODY=""; AP_TITLE=""
    AP_STOP=""; AP_STOP_KEY=""; AP_PARENT=""
    if ! pj=$(gh api "repos/$REPO/pulls/$pr" 2>/dev/null) || [ -z "$pj" ]; then
        AP_REASON="读不到 PR #$pr"; return 0
    fi
    if ! printf '%s' "$pj" | jq -e '.state == "open" and .merged == false' >/dev/null 2>&1; then
        AP_V=skip; return 0
    fi
    labels=$(printf '%s' "$pj" | jq -r '[.labels[]?.name] | join(",")')
    case ",$labels," in *",$LABEL_PENDING_MERGE,"*) ;; *) AP_V=skip; return 0 ;; esac
    # AP_HANDOVER_MINE：交人进行中（autopilot_to_human 摘等合并标签之前的那次重判），PR 上这枚 pending/human 是
    # daemon 本次已确认加上的，当它不在、继续往下判；是不是「那一枚」由调用方紧接着比指纹保证（GitHub#382）
    case ",$labels," in *",$LABEL_PENDING_HUMAN,"*) [ -n "${AP_HANDOVER_MINE:-}" ] || { AP_V=halt_pr; return 0; } ;; esac
    # PR 属于哪一种（GitHub#142）：绑 issue → issue 和 PR 两处判；以 PR 为准 → AP_N 为空、ij 为空，
    # 下面 issue 上的叫停自然不成立，授权函数只看 PR
    autopilot_pr_kind "$pj"
    case "$AUTOPILOT_PR_KIND" in
        issue) AP_KIND=issue; AP_N="$AUTOPILOT_PR_N"; AP_WN="$AP_N" ;;
        pr)    AP_KIND=pr; AP_N=""
               AP_WN=$(pr_to_issue_num "$pr" "$(printf '%s' "$pj" | jq -r '.head.ref // ""')" "$(printf '%s' "$pj" | jq -r '.body // ""')") ;;
        *)     AP_V=human; AP_STOP=not-eligible; AP_REASON="这个 PR 不满足托管条件：$AUTOPILOT_REASON。"; return 0 ;;
    esac
    # 多机：复审记录只在派复审的那台机器上。别家的活不碰，免得两台机器互相送回重审。
    if ! worker_is_ours "$AP_WN"; then AP_V=skip; return 0; fi
    ij=""
    if [ "$AP_KIND" = issue ] && { ! ij=$(gh api "repos/$REPO/issues/$AP_N" 2>/dev/null) || [ -z "$ij" ]; }; then
        AP_REASON="读不到 issue #$AP_N"; return 0
    fi
    if printf '%s' "$ij" | jq -e --arg H "$LABEL_PENDING_HUMAN" 'any(.labels[]?; .name == $H)' >/dev/null 2>&1; then
        AP_V=human; AP_STOP=issue-halt; AP_REASON="issue #$AP_N 上挂了 \`$LABEL_PENDING_HUMAN\`（已叫停）。"; return 0
    fi
    rc=0; autopilot_authorization "$AP_N" "$ij" "$pr" "$pj" || rc=$?
    # 拆分子项的父 issue（GitHub#233）也是交人判定的输入：记下来，交人的写前核对连它一起比（GitHub#382）
    if [ "$AP_KIND" = issue ] && [ -n "${SPLIT_PARENT_NUM:-}" ]; then AP_PARENT="$SPLIT_PARENT_REPO#$SPLIT_PARENT_NUM"; fi
    case "$rc" in
        0) ;;
        1) AP_V=human; AP_STOP=auth
           if [ "$AUTOPILOT_DENY" = no-label ]; then
               AP_REASON="$AUTOPILOT_REASON。"
           else
               AP_REASON="托管授权不成立：$AUTOPILOT_REASON。"
           fi
           return 0 ;;
        *) AP_REASON="$AUTOPILOT_REASON"; return 0 ;;
    esac
    # 绑 issue 的托管 PR 上必须挂着托管标签才合（GitHub#190）：PR 列表上要看得出它会被自动合并、能在 PR 上
    # 叫停。标签由每轮的补标签那一趟（autopilot_mirror_tick，排在合并之前）从 issue 补过来；没补上就算判不了，
    # 下轮再看，连续判不了到上限交人
    if [ "$AP_KIND" = issue ] && ! autopilot_has_label "$pj"; then
        AP_REASON="PR #$pr 上还没有托管标签 \`$LABEL_AUTOPILOT\`（daemon 每轮从 issue #$AP_N 补过来），补上之前不合并"
        return 0
    fi
    AP_BODY=$(printf '%s' "$pj" | jq -r '.body // ""'); AP_TITLE=$(printf '%s' "$pj" | jq -r '.title // ""')
    # 托管合并后 issue 留给人验收、关闭（GitHub#233）：正文里还有会让 GitHub 合并时关掉本仓库 issue 的关键词，
    # 就不合，交回 worker 改成只引用。合并前那次现读重判同样走到这里，改回去照样拦下
    if [ "$AP_KIND" = issue ] && printf '%s' "$AP_BODY" | autopilot_body_has_close; then
        AP_V=worker
        AP_REASON="PR 正文写着关闭关键词（如 \`Closes #$AP_N\`），合并时 GitHub 会自动关掉 issue；托管合并后 issue 要留给人验收、关闭。请只把正文里的关闭写法改成 \`Refs #$AP_N\`（只写这一个，正文其他内容不动）"
        return 0
    fi
    AP_HEAD=$(printf '%s' "$pj" | jq -r '.head.sha // ""')
    AP_BASE=$(printf '%s' "$pj" | jq -r '.base.ref // ""')
    AP_REF=$(printf '%s' "$pj" | jq -r '.head.ref // ""')
    if [ -z "$AP_HEAD" ] || [ -z "$AP_BASE" ] || [ -z "$AP_REF" ]; then
        AP_REASON="PR #$pr 的提交 / 目标分支 / 分支名读不全"; return 0
    fi
    if printf '%s' "$pj" | jq -e '.draft == true' >/dev/null 2>&1; then
        AP_V=human; AP_STOP=draft; AP_REASON="PR 是草稿状态。"; return 0
    fi
    AP_RH=$(autopilot_state_get "$sf" '.prs[$p].reviewed_head' --arg p "$pr")
    AP_RB=$(autopilot_state_get "$sf" '.prs[$p].reviewed_base' --arg p "$pr")
    AP_RAT=$(autopilot_state_get "$sf" '.prs[$p].reviewed_at' --arg p "$pr")
    # 复审看过的是「这个提交合进这个目标分支」：两样都得对上，缺一样（含旧版没记目标分支的记录）都重审
    if [ -z "$AP_RH" ] || [ "$AP_RH" != "$AP_HEAD" ] || [ -z "$AP_RB" ] || [ "$AP_RB" != "$AP_BASE" ] || [ -z "$AP_RAT" ]; then
        AP_V=review; return 0
    fi
    # 需人过目清单（GitHub#337）：配了才走新判断；没配走下面原来的 .github/ 判断，一行不变
    if [ -n "$AUTOPILOT_HUMAN_PATHS" ]; then
        autopilot_paths_verdict "$pr" "$pj"
        case "$AP_PATHS_V" in
            ok) ;;
            hit)
                AP_V=human; AP_STOP=paths; AP_STOP_KEY="$AP_PATHS_DETAIL"
                AP_REASON="改动碰了合并前需人过目的文件：$(printf '%s' "$AP_PATHS_DETAIL" | jq -r '
                    (.[:10] | map("`" + . + "`") | join("、")) + (if length > 10 then " 等 \(length) 个" else "" end)')。托管不自动合并这类改动。"
                AP_NEXT="请人工审这部分改动后自己合并；不合就关掉 PR 或改回去再交复审。"
                return 0 ;;
            bad)
                AP_V=human; AP_STOP=paths-config; AP_STOP_KEY="$AP_PATHS_DETAIL"
                AP_REASON="本项目配置里「合并前需人过目的文件」清单（\`AUTOPILOT_HUMAN_PATHS\`）有一个条目写法不认识：\`$AP_PATHS_DETAIL\`。清单不完整时托管不自动合并。"
                AP_NEXT="请改好配置里的这个条目（开头 \`/\` = 只认仓库根目录，不写 = 任何深度；末尾 \`/\` = 目录），再把 PR 的标签改成 \`${LABEL_PENDING_REVIEW}\` 重新走复审和合并。"
                return 0 ;;
            *) AP_REASON="读不全 PR #$pr 的改动文件列表（$AP_PATHS_DETAIL）"; return 0 ;;
        esac
    else
    case "$(autopilot_files_verdict "$pr")" in
        ok) ;;
        touches)
            AP_V=human; AP_STOP=github-dir; AP_REASON="改动碰了 \`.github/\` 目录（Actions 和仓库自动化），托管不自动合并这类改动。"
            AP_NEXT="请人工审这部分改动后自己合并；不合就关掉 PR 或改回去再交复审。"
            return 0 ;;
        *) AP_REASON="读不到 PR #$pr 的改动文件列表"; return 0 ;;
    esac
    fi
    # 复审的测试重跑记录是一条普通评论：可以被编辑、被删除，每次都现读
    rc=0; autopilot_review_evidence "$pr" "$AP_HEAD" "$AP_RAT" || rc=$?
    case "$rc" in
        0) ;;
        1) AP_V=human; AP_STOP=no-evidence; AP_REASON="复审的通过评论里找不到提交 \`${AP_HEAD:0:7}\` 的有效测试重跑记录（要求失败 0、通过至少 1；记录被删掉或改成有失败也算没有）。没有它 daemon 不合并。"; return 0 ;;
        *) AP_REASON="读不到 PR #$pr 的评论"; return 0 ;;
    esac
    autopilot_checks "$AP_HEAD"
    AP_CHECKS="$AUTOPILOT_CHECKS"; AP_CHECKS_DETAIL="$AUTOPILOT_CHECKS_DETAIL"
    case "$AP_CHECKS" in
        pass|none) ;;
        fail) AP_V=worker; AP_REASON="自动检查没过：$AP_CHECKS_DETAIL"; return 0 ;;
        pending) AP_V=wait_checks; AP_REASON="$AP_CHECKS_DETAIL"; return 0 ;;
        *) AP_REASON="读不到提交 ${AP_HEAD:0:7} 的自动检查结果"; return 0 ;;
    esac
    case "$(autopilot_conflict_verdict "$pj")" in
        ok) ;;
        conflict) AP_V=worker; AP_REASON="与目标分支 \`$AP_BASE\` 有冲突，先把 \`$AP_BASE\` 合进来解决冲突"; return 0 ;;
        *) AP_V=computing; return 0 ;;
    esac
    AP_V=ok
}

autopilot_merge_one() {   # <state_file> <PR 编号>
    local sf="$1" pr="$2" n kind head base ref checks since now limit out short where body
    autopilot_permit "$sf" "$pr"
    case "$AP_V" in
        skip) return 0 ;;
        halt_pr)
            # PR 上挂着 pending/human（人叫停，或交人做到一半）：只摘 pending/merge，不说话；摘之前同样核对现状
            autopilot_halt_dequeue "$pr"; return 0 ;;
        human)
            # 所有交人原因走同一个函数：作数的判定在里面重做，每次写入之前都核对现状（GitHub#382；
            # 需人过目清单那两种原先在这里单独重判一次，GitHub#337，现在并进去了）
            autopilot_to_human "$sf" "$pr" "${AP_STOP:-human}" human "$AP_REASON" "$AP_NEXT"; return 0 ;;
        worker) autopilot_to_worker "$sf" "$pr" "$AP_WN" "$AP_REASON"; return 0 ;;
        review) autopilot_to_review "$sf" "$pr" "$AP_HEAD" "$AP_RH" "$AP_BASE" "$AP_RB"; return 0 ;;
        unknown) autopilot_unknown "$sf" "$pr" "$AP_REASON"; return 0 ;;
        computing) log "托管：PR #$pr GitHub 还在算能不能合并，下轮再看"; return 0 ;;
        wait_checks)
            since=$(autopilot_state_get "$sf" '.prs[$p].checks_pending_since' --arg p "$pr")
            now=$(date +%s)
            if [ -z "$since" ]; then
                autopilot_state_set "$sf" '.prs[$p] = ((.prs[$p] // {}) + {checks_pending_since: ($t | tonumber)} | del(.unknown))' \
                    --arg p "$pr" --arg t "$now" || true
                since="$now"
            fi
            limit=$(( ${AUTOPILOT_CHECKS_TIMEOUT_HOURS:-6} * 3600 ))
            if [ $(( now - since )) -ge "$limit" ] 2>/dev/null; then
                autopilot_to_human "$sf" "$pr" checks-timeout wait_checks "自动检查超过 ${AUTOPILOT_CHECKS_TIMEOUT_HOURS:-6} 小时还没跑完：$AP_REASON。"
            else
                log "托管：PR #$pr 等自动检查跑完（$AP_REASON）"
            fi
            return 0 ;;
        ok) ;;
        *) return 0 ;;
    esac
    autopilot_state_set "$sf" '.prs[$p] = ((.prs[$p] // {}) | del(.checks_pending_since))' --arg p "$pr" || true
    n="$AP_N"; kind="$AP_KIND"; head="$AP_HEAD"; base="$AP_BASE"; ref="$AP_REF"; checks="$AP_CHECKS"

    # ── 合并前最后一刻：同一个许可函数原样再判一遍（全部输入现读）──
    # 结果不是 ok、或身份（issue / 提交 / 目标分支 / 分支名）和刚才不一样：本轮不合、不记任何状态，
    # （绑 issue 和没绑 issue 之间来回变，issue 编号就从有变成空或反过来，同样算变；GitHub#142）
    # 下轮按现状重判。原本没有检查、现在冒出来的，检查结果从 none 变了，也算变化。
    autopilot_permit "$sf" "$pr"
    if [ "$AP_V" != ok ] || [ "$AP_N" != "$n" ] || [ "$AP_HEAD" != "$head" ] || [ "$AP_BASE" != "$base" ] \
       || [ "$AP_REF" != "$ref" ] || { [ "$checks" = none ] && [ "$AP_CHECKS" != none ]; }; then
        log "托管：PR #$pr 判定之后有变化（重判结果 $AP_V${AP_REASON:+：$AP_REASON}），本轮不合并"
        return 0
    fi
    # 剩下的窗口只有「这次重判」到「合并请求到达 GitHub」之间——daemon 消除不了。合并请求带的提交号
    # 能挡住其中的新推送；要连检查一起由服务端兜底，请给目标分支开「必须通过的检查」。

    if out=$(gh_write api -X PUT "repos/$REPO/pulls/$pr/merge" -f "sha=$head" -f "merge_method=$AUTOPILOT_MERGE_METHOD" 2>&1); then
        AUTOPILOT_ACTED=1
        short="${head:0:7}"
        log "✅ 托管：PR #$pr 已自动合并（提交 $short → $base，授权 $AUTOPILOT_ACTOR @ $(autopilot_auth_where)）"
        # 说明发在绑定的 issue 上；没绑 issue（GitHub#142）就发在 PR 上
        if [ "$kind" = pr ]; then n="$pr"; where="本 PR 上"
        elif [ "$AUTOPILOT_AUTH_KIND" = pr ]; then where=" PR #$pr 上"
        elif [ "$AUTOPILOT_AUTH_KIND" = parent ]; then where="$(autopilot_auth_where) 上"
        else where="本 issue "; fi
        body=$(autopilot_merged_comment "$pr" "$kind" "$short" "$base" "$where" "$head")
        if [ "$kind" = issue ]; then
            # 合并后的交接（GitHub#233）：issue 留着、翻 pending/human 给人验收。先记下要做的事和评论全文，
            # 评论发不出去、标签没翻好，都由合并后的清理那一步（merged_issue_label → autopilot_merged_handoff）接着做
            autopilot_state_set "$sf" '.handoff[$p] = {issue: $n, body: $b}' --arg p "$pr" --arg n "$n" --arg b "$body" || true
        fi
        if run_gh "托管合并说明评论 (#$n)" gh_write api -X POST "repos/$REPO/issues/$n/comments" -f "body=$body"; then
            [ "$kind" != issue ] || autopilot_state_set "$sf" '.handoff[$p].commented = true' --arg p "$pr" || true
        fi
        autopilot_state_set "$sf" 'del(.prs[$p])' --arg p "$pr" || true
        return 0
    fi
    case "$out" in
        *"HTTP 409"*) log "托管：PR #$pr 合并时提交对不上（刚有新推送），下轮重新判" ;;
        *"HTTP 405"*|*"HTTP 403"*|*"HTTP 422"*)
            autopilot_to_human "$sf" "$pr" merge-refused ok "GitHub 拒绝合并：$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)（常见原因：仓库规则要求人工批准、该合并方式未开启）。" ;;
        *) autopilot_unknown "$sf" "$pr" "合并请求失败：$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)" ok ;;
    esac
    return 0
}

# 托管合并后发的那条说明（GitHub#233）：外面一句话结论 +「要人做什么」，背景 / 采用的方案 / 排除的方案和原因
# 照搬 worker 写在 PR 正文里的总结段（AUTOPILOT_SUMMARY_BEGIN / _END 之间，各自折叠），合并依据折叠在最后。
# 读的是 autopilot_permit 刚现读的 PR 正文（AP_BODY）和标题（AP_TITLE）。最后一行是标记，重发前按它去重。
AUTOPILOT_SUMMARY_BEGIN='<!-- autopilot-summary:begin -->'
AUTOPILOT_SUMMARY_END='<!-- autopilot-summary:end -->'
autopilot_merged_comment() {   # <PR> <issue|pr> <短提交号> <目标分支> <授权在哪（给人看）> <完整提交号>
    local pr="$1" kind="$2" short="$3" base="$4" where="$5" head="$6" summary todo
    summary=$(printf '%s\n' "$AP_BODY" | awk -v b="$AUTOPILOT_SUMMARY_BEGIN" -v e="$AUTOPILOT_SUMMARY_END" '
        index($0, e) { on = 0 } on { print } index($0, b) { on = 1; found = 1 }' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
    [ -n "$summary" ] || summary="⚠️ PR #$pr 的正文里没有总结段（背景 / 采用的方案 / 排除的方案和原因），细节请看 PR #$pr。"
    if [ "$kind" = issue ]; then
        todo="要人做的：看过之后满意就关闭本 issue（关成「已完成」会自动打 \`$LABEL_DONE\`）；要返工就打 \`$LABEL_PENDING_AGENT_DEFAULT\`。"
    else
        todo="本条不需要人做任何事；要撤回就在 GitHub 上 revert 这个 PR。"
    fi
    printf '## ✅ 托管：已自动合并 PR #%s：%s\n\n%s\n\n%s\n\n<details><summary>合并依据</summary>\n\n复审通过的提交 `%s` 已用 %s 方式合进 `%s`。依据：`%s` 在%s打的托管标签 `%s`；复审贴了测试重跑记录；自动检查%s；与 `%s` 无冲突。合并后的清理和标签照常由 daemon 处理。要撤回就在 GitHub 上 revert 这个 PR。\n\n</details>\n\n%s\n<!-- cavil-loop:autopilot-merged pr=%s head=%s -->' \
        "$pr" "${AP_TITLE:-}" "$todo" "$summary" "$short" "$AUTOPILOT_MERGE_METHOD" "$base" "$AUTOPILOT_ACTOR" \
        "$where" "$LABEL_AUTOPILOT" \
        "$( [ "$AP_CHECKS" = none ] && echo '：仓库没有配置' || echo '全部通过' )" "$base" \
        "$(autopilot_daemon_sig)" "$pr" "$head"
}

# 托管合并后 issue 的交接（GitHub#233，由 merged_issue_label 在这个 PR 有交接记录时调用）。
# 目标：issue 上有合并说明；issue 仍打开 → 翻 pending/human、摘 pending/PR，留给人验收、关闭；人先关了 → 打 Done。
# 但人可能已经接着动了：issue 上挂着派工 / 进行中 / 复审 / 等前置 / 等人 等任何流程标签，说明新一轮已经开始
# 或已交人——这时一个标签都不动，只补说明（还没发的话），这条交接作废。
# 判定只有一个（autopilot_handoff_judge），每次写标签之前都现读重判一次，结论和依据（状态 + 标签集合 + 本机
# 记下的「pending/human 是 daemon 自己加的」）都没变才写。摘标签只认 2xx / 404 为成功，其余失败交接记录留着，
# 下轮接着收敛。返回 0 = 定了（记录已清）；1 = 下轮再试。
autopilot_merged_handoff() {   # <issue> <PR>
    local issue="$1" pr="$2" sf="${STATE_FILE:-$STATE_DIR/state.json}" body comments me v id
    # 1. 合并说明：还没确认发出去就先查有没有（按标记），没有再发。说明在任何结论下都要有，所以先做
    if [ "$(autopilot_state_get "$sf" '.handoff[$p].commented // false' --arg p "$pr")" != true ]; then
        me=$(write_identity_login)
        if [ -z "$me" ] || ! comments=$(gh api --paginate --slurp "repos/$REPO/issues/$issue/comments" 2>/dev/null); then
            log "  ⚠️ 托管合并交接：读不到 issue #$issue 的评论（或写入账号），下轮再试"; return 1
        fi
        if ! printf '%s' "$comments" | jq -e --arg me "$me" --arg m "<!-- cavil-loop:autopilot-merged pr=$pr " '
                any(.[][]?; ((.user.login // "") | ascii_downcase) == ($me | ascii_downcase) and ((.body // "") | contains($m)))' >/dev/null 2>&1; then
            body=$(autopilot_state_get "$sf" '.handoff[$p].body' --arg p "$pr")
            [ -n "$body" ] || body="## ✅ 托管：已自动合并 PR #$pr"$'\n\n'"$(autopilot_daemon_sig)"$'\n'"<!-- cavil-loop:autopilot-merged pr=$pr head= -->"
            run_gh "托管合并说明评论 (#$issue，补发)" gh_write api -X POST "repos/$REPO/issues/$issue/comments" -f "body=$body" || return 1
        fi
        autopilot_state_set "$sf" '.handoff[$p].commented = true' --arg p "$pr" || true
    fi
    # 2. 一次只写一个标签：每一步都现读判定两次（结论、依据、下一步都不变才写），写完回到循环开头重新判。
    #    这样加完 Done / pending/human 之后、摘下一个标签之前，有人重开 issue、新一轮开工，下一圈就停手
    local step=0 kind lab next
    while [ "$step" -lt 12 ]; do
        step=$((step + 1))
        autopilot_handoff_judge "$issue" "$pr"
        v="$AH_V"; id="$AH_ID|$AH_NEXT"; next="$AH_NEXT"
        case "$v" in
            unknown) log "  ⚠️ 托管合并交接：$AH_REASON，下轮再试"; return 1 ;;
            finished)
                autopilot_state_set "$sf" 'del(.handoff[$p])' --arg p "$pr" || true
                log "  PR #$pr → Done；托管 issue #$issue 交接完成（$( [ "$AH_STATE" = closed ] && echo "已关闭 → $LABEL_DONE" || echo "留给人验收 → $LABEL_PENDING_HUMAN")）"
                return 0 ;;
            superseded)
                autopilot_state_set "$sf" 'del(.handoff[$p])' --arg p "$pr" || true
                log "  托管 PR #$pr 已合并；issue #$issue 已经挂着 $AH_REASON（新一轮已开始或已交人）→ 标签不动"
                return 0 ;;
        esac
        autopilot_handoff_judge "$issue" "$pr"
        if [ "$AH_V" != "$v" ] || [ "$AH_ID|$AH_NEXT" != "$id" ]; then
            log "  托管合并交接：issue #$issue 判定之后有变化（重判 $AH_V${AH_REASON:+：$AH_REASON}），本轮不写"; return 1
        fi
        # 写的是第一次判定定下的那一步（两次一致时它和第二次的相同）
        kind="${next%%:*}"; lab="${next#*:}"
        case "$kind" in
            add)
                run_gh "托管合并交接 issue #$issue 加 $lab" \
                    gh_write api -X POST "repos/$REPO/issues/$issue/labels" -f "labels[]=$lab" >/dev/null || return 1
                # 记下「这个 pending/human 是 daemon 自己加的」：下一圈重判认得出它不是人的新动作
                [ "$lab" != "$LABEL_PENDING_HUMAN" ] || autopilot_state_set "$sf" '.handoff[$p].human_added = true' --arg p "$pr" || true ;;
            del) autopilot_handoff_converge "$issue" "" "$lab" || return 1 ;;
            *) log "  ⚠️ 托管合并交接：issue #$issue 下一步读不懂（$AH_NEXT）"; return 1 ;;
        esac
    done
    log "  ⚠️ 托管合并交接：issue #$issue 收敛步数超出上限，下轮再试"
    return 1
}

# 交接的纯判定（不写任何东西）：现读 issue，AH_V =
#   unknown     读不到 / 缺字段 / 状态不认识
#   finished    已经是目标状态（关闭且挂着 Done、没有要摘的；或打开、挂着 daemon 自己加的 pending/human、没有 pending/PR）
#   superseded  打开，挂着任何流程标签（daemon 自己加的那个 pending/human 除外）→ 新一轮已开始，不动
#   done        关闭，还没收敛到 Done；flip  打开，没有流程标签（或只有 daemon 自己加的 pending/human），还没收敛
# AH_NEXT = 下一个要写的标签（add:<标签> / del:<标签>），一次只写一个
# AH_ID = 状态 | 排好序的标签集合 | daemon 自己加没加过 pending/human，两次判定逐字比较
autopilot_handoff_judge() {   # <issue> <PR>
    local issue="$1" pr="$2" sf="${STATE_FILE:-$STATE_DIR/state.json}" ij st labs mine rest
    AH_V=unknown; AH_ID=""; AH_REASON=""; AH_NEXT=""; AH_STATE=""
    if ! ij=$(gh api "repos/$REPO/issues/$issue" 2>/dev/null) \
       || ! printf '%s' "$ij" | jq -e '(.state | type) == "string" and (.labels | type) == "array"' >/dev/null 2>&1; then
        AH_REASON="读不到 issue #$issue（或缺字段）"; return 0
    fi
    st=$(printf '%s' "$ij" | jq -r .state); labs=$(printf '%s' "$ij" | jq -c '[.labels[].name] | sort')
    AH_STATE="$st"
    mine=no; [ "$(autopilot_state_get "$sf" '.handoff[$p].human_added // false' --arg p "$pr")" = true ] && mine=yes
    AH_ID="$st|$labs$( [ "$mine" = yes ] && echo '|human-by-daemon')"
    _ah_has() { printf '%s' "$labs" | jq -e --arg L "$1" 'index($L) != null' >/dev/null 2>&1; }
    case "$st" in
        closed)
            AH_V=done
            if ! _ah_has "$LABEL_DONE"; then AH_NEXT="add:$LABEL_DONE"
            else
                AH_NEXT=$(printf '%s' "$labs" | jq -r --argjson r "$(autopilot_handoff_done_remove)" \
                    'first(.[] | select(. as $l | $r | index($l))) // ""' 2>/dev/null)
                if [ -n "$AH_NEXT" ]; then AH_NEXT="del:$AH_NEXT"; else AH_V=finished; fi
            fi ;;
        open)
            # 流程标签（daemon 自己加的那个 pending/human 不算）：有就说明新一轮已开始或已交人
            rest=$(printf '%s' "$labs" | jq -r --argjson f "$(autopilot_handoff_flow_labels)" --arg H "$LABEL_PENDING_HUMAN" --arg m "$mine" \
                '[.[] | select($m != "yes" or . != $H) | select(. as $l | $f | index($l))] | join(",")')
            if [ -n "$rest" ]; then
                AH_V=superseded; AH_REASON="$rest"
            elif [ "$mine" = yes ] && ! _ah_has "$LABEL_PENDING_HUMAN"; then
                # daemon 加过 pending/human，现在却没了：人摘的，算人接过了这件事
                AH_V=superseded; AH_REASON="（人已摘掉 daemon 加的 $LABEL_PENDING_HUMAN）"
            elif [ "$mine" != yes ]; then
                AH_V=flip; AH_NEXT="add:$LABEL_PENDING_HUMAN"
            elif _ah_has "$LABEL_PENDING_PR"; then
                AH_V=flip; AH_NEXT="del:$LABEL_PENDING_PR"
            else
                AH_V=finished
            fi ;;
        *) AH_REASON="issue #$issue 状态异常（'$st'）" ;;
    esac
    unset -f _ah_has
}

# 关闭的托管 issue 收敛到 Done 时要摘的标签（JSON 数组）
autopilot_handoff_done_remove() {
    printf '%s\n' "$LABEL_PENDING_PR" "$LABEL_PENDING_HUMAN" "${LABEL_PENDING_AGENT_DEFAULT:-}" "${LABEL_PENDING_AGENT_FABLE:-}" \
        "${LABEL_PENDING_REVIEW:-}" "$LABEL_AGENT_DOING" | awk 'NF && !seen[$0]++' | jq -Rsc 'split("\n") | map(select(. != ""))'
}

# 标签收敛：加 <要加的>（空 = 不加），逐个摘 <要摘的…>。摘只认成功或 404（本来就没有）；任何一步失败返回 1，
# 交接记录留着下轮再来（gh_label_flip 吞掉摘标签的错误，这里不能用它）
autopilot_handoff_converge() {   # <issue> <要加的> <要摘的…>
    local issue="$1" add="$2" L out
    shift 2
    if [ -n "$add" ]; then
        run_gh "托管合并交接 issue #$issue 加 $add" \
            gh_write api -X POST "repos/$REPO/issues/$issue/labels" -f "labels[]=$add" >/dev/null || return 1
    fi
    for L in "$@"; do
        [ -n "$L" ] || continue
        if ! out=$(gh_write api -X DELETE "repos/$REPO/issues/$issue/labels/$(printf '%s' "$L" | jq -sRr @uri)" 2>&1); then
            printf '%s' "$out" | grep -q 'HTTP 404' && continue
            log "  ⚠️ 托管合并交接：issue #$issue 摘 $L 失败，下轮再试：$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
            return 1
        fi
    done
    return 0
}

# 合并后交接要让路的流程标签（JSON 数组）：派工、进行中、复审、等合并、等前置、等人、等外部需求机器人、Done
autopilot_handoff_flow_labels() {
    [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
    printf '%s\n' "$LABEL_PENDING_HUMAN" "$LABEL_AGENT_DOING" "$LABEL_DONE" "${LABEL_PENDING_REVIEW:-}" \
        "${LABEL_PENDING_MERGE:-}" "${LABEL_PENDING_BLOCKED:-}" "${LABEL_PENDING_REQUESTER_BOT:-}" "${TRIGGER_LABELS_ALL[@]}" \
        | awk 'NF && !seen[$0]++' | jq -Rsc 'split("\n") | map(select(. != ""))'
}

# 每轮：扫挂着 pending/merge 的 PR，逐个检查、合并（GitHub#114）。功能关闭时什么都不做。
autopilot_merge_tick() {   # <state_file>
    local sf="$1" pages open_nums rows num tmp
    autopilot_enabled || return 0
    pages=$(open_snapshot pulls) || return 0
    # 已关闭 / 已合并的 PR 不再需要记录
    if jq -e '.autopilot.prs' "$sf" >/dev/null 2>&1 \
       && open_nums=$(printf '%s' "$pages" | jq -c '[ .[][] | .number | tostring ]' 2>/dev/null); then
        tmp=$(mktemp)
        if jq --argjson open "$open_nums" \
            '.autopilot.prs = ((.autopilot.prs // {}) | with_entries(select(.key as $k | $open | index($k))))' \
            "$sf" > "$tmp" 2>/dev/null; then mv "$tmp" "$sf"; else rm -f "$tmp"; fi
    fi
    rows=$(printf '%s' "$pages" | jq -r --arg M "$LABEL_PENDING_MERGE" \
        '.[][] | select(any(.labels[]?; .name == $M)) | .number' 2>/dev/null) || return 0
    for num in $rows; do
        autopilot_merge_one "$sf" "$num" || true
    done
    return 0
}

# ── 维护者在 PR 上打托管标签：daemon 接手，从复审重来（GitHub#128）──
# 已经开好的 PR（比如复审通过后停在 pending/human 等人合并），维护者直接在 PR 上打托管标签：
# 授权成立就把 PR 翻回复审（pending/review），之后完全是普通的托管流程（派复审时记下提交、复审通过
# 翻 pending/merge、合并前全套核对）。只接手两种状态：
#   · 除托管标签外只挂着 pending/human，而且授权那次打标签晚于 PR 上最后一次打 pending/human（之后打的
#     pending/human 是叫停，不动）。授权可以在 PR 上，也可以在绑定的 issue 上：PR 摘标交人之后，维护者
#     只在 issue 上重新亲手打托管，也算重新授权这个 PR
#   · 一个状态 / 触发标签都没有，而且 PR 自己挂着托管标签（只有 issue 挂着时不碰：worker 刚开出、还没
#     来得及打标签的 PR 就是这个样子）
# 还挂着别的流程标签的（pending/agent、doing/agent、pending/review、pending/merge…，哪怕同时挂着
# pending/human）一律不接手：那是正在进行的工作，下次派工自然带上托管规则。
#
# autopilot_takeover_permit 是纯判定，和合并前许可一样调两次：判定可接手之后，紧挨着写之前用现读的
# 数据原样再判一遍，结论和身份（issue / 提交 / 目标分支 / 分支名 / 来源 / 接手方式）都一致才写。
# 结果在全局变量里（必须在调用方自己的 shell 里调）：
#   AT_V   skip / take / deny / unknown；AT_MODE human / none；AT_N AT_HEAD AT_BASE AT_REF AT_REPO
#   AT_KIND issue / pr（GitHub#142：没绑 issue、以 PR 为准时 AT_N 为空，只看 PR）
#   deny 时 AUTOPILOT_DENY / AUTOPILOT_REASON 是原因
autopilot_takeover_permit() {   # <PR 编号>
    local pr="$1" pj ij labels rest when rc pl
    AT_V=unknown; AT_MODE=""; AT_N=""; AT_KIND=""; AT_HEAD=""; AT_BASE=""; AT_REF=""; AT_REPO=""; AT_REASON=""
    AT_WHY=""; AT_HUMAN_BY=""
    AUTOPILOT_DENY=""; AUTOPILOT_REASON=""
    AT_PJ=""
    if ! pj=$(gh api "repos/$REPO/pulls/$pr" 2>/dev/null) || [ -z "$pj" ] \
       || ! printf '%s' "$pj" | jq -e '(.state | type) == "string" and (.merged | type) == "boolean" and (.labels | type) == "array"' >/dev/null 2>&1; then
        AT_REASON="读不到 PR #$pr（或缺字段）"; return 0
    fi
    AT_PJ="$pj"
    if ! printf '%s' "$pj" | jq -e '.state == "open" and .merged == false and (.draft | not)' >/dev/null 2>&1; then
        AT_V=skip; AT_WHY=closed; return 0
    fi
    pl=no; autopilot_has_label "$pj" && pl=yes
    labels=$(printf '%s' "$pj" | jq -r '[.labels[]?.name] | join(",")')
    # 先保护正在进行的工作：除了托管标签和 pending/human，还挂着任何流程标签就不接手
    rest=$(printf '%s' "$pj" | jq -r --arg L "$LABEL_AUTOPILOT" --arg H "$LABEL_PENDING_HUMAN" \
        '[.labels[]?.name | select(. != $L and . != $H)] | join(",")')
    if autopilot_labels_in_flow "$rest"; then AT_V=skip; return 0; fi
    case ",$labels," in
        *",$LABEL_PENDING_HUMAN,"*) AT_MODE=human ;;
        *) AT_MODE=none
           [ "$pl" = yes ] || { AT_V=skip; return 0; } ;;
    esac
    # 一个流程标签都没有、自己挂着托管标签：接手 = 自动续工。等待标签被提前摘掉、之后没人打派工标签的
    # 不接手（GitHub#162）；判不了本轮不接手
    if [ "$AT_MODE" = none ]; then
        rc=0; requester_bot_wait_hold "$pr" || rc=$?
        case "$rc" in
            0) AT_V=skip; AT_WHY=requester-wait; return 0 ;;
            2) AT_REASON="$REQUESTER_BOT_WAIT_REASON"; return 0 ;;
        esac
    fi
    AT_HEAD=$(printf '%s' "$pj" | jq -r '.head.sha // ""')
    AT_BASE=$(printf '%s' "$pj" | jq -r '.base.ref // ""')
    AT_REF=$(printf '%s' "$pj" | jq -r '.head.ref // ""')
    AT_REPO=$(printf '%s' "$pj" | jq -r '.head.repo.full_name // ""')
    if [ -z "$AT_HEAD" ] || [ -z "$AT_BASE" ] || [ -z "$AT_REF" ]; then
        AT_REASON="PR #$pr 的提交 / 目标分支 / 分支名读不全"; return 0
    fi
    autopilot_pr_kind "$pj"
    case "$AUTOPILOT_PR_KIND" in
        issue) AT_KIND=issue; AT_N="$AUTOPILOT_PR_N" ;;
        # 没绑 issue（GitHub#142）：只看 PR 自己；PR 没挂托管标签就和托管无关
        pr)    AT_KIND=pr; AT_N=""
               [ "$pl" = yes ] || { AT_V=skip; return 0; } ;;
        # 不合条件：PR 自己没挂托管标签时和托管无关
        *)     if [ "$pl" = yes ]; then AT_V=deny; AUTOPILOT_DENY=binding; else AT_V=skip; fi
               return 0 ;;
    esac
    ij=""
    if [ "$AT_KIND" = issue ] && { ! ij=$(gh api "repos/$REPO/issues/$AT_N" 2>/dev/null) || [ -z "$ij" ]; }; then
        AT_REASON="读不到 issue #$AT_N"; return 0
    fi
    # 两处都没挂托管标签：不是托管的 PR（普通的等人 PR 一概不碰）。拆分子项的标签可以只在父 issue 上（GitHub#233）
    if [ "$pl" = no ]; then
        rc=0; autopilot_labeled_or_parent "$AT_N" "$ij" || rc=$?
        case "$rc" in
            0) ;;
            2) AT_REASON="$AUTOPILOT_REASON"; return 0 ;;
            *) AT_V=skip; return 0 ;;
        esac
    fi
    # issue 上挂着 pending/human = 叫停，不接手（是人做的，不说话）
    if printf '%s' "$ij" | jq -e --arg H "$LABEL_PENDING_HUMAN" 'any(.labels[]?; .name == $H)' >/dev/null 2>&1; then
        AT_V=skip; return 0
    fi
    rc=0; autopilot_authorization "$AT_N" "$ij" "$pr" "$pj" || rc=$?
    case "$rc" in
        0) ;;
        1) if [ "$AUTOPILOT_DENY" = no-label ]; then AT_V=skip; else AT_V=deny; fi; return 0 ;;
        *) AT_REASON="$AUTOPILOT_REASON"; return 0 ;;
    esac
    # 没有流程标签时只接手「PR 自己挂着」的：daemon 补过去的副本不算 PR 自己挂着（GitHub#190）——
    # 否则 worker 刚开、还没打流程标签的 PR 会被副本带着绕过「只有 issue 挂着时不碰」
    if [ "$AT_MODE" = none ] && [ -n "$AUTOPILOT_PR_COPY" ]; then AT_V=skip; return 0; fi
    if [ "$AT_MODE" = human ]; then
        # 每一条成立的授权都和 PR 上最后一次打 pending/human 比：同在 PR 上按记录顺序比，在 issue 上按时间比
        # （同秒 = 不在后）。有一条在后就接手，用的就是那一条；没有在后的、但有比不出的 → 判不了；否则叫停
        local ck cn ct ci ca w any_unknown=""
        when=before
        while IFS=$'\x1f' read -r ck cn ct ci ca; do
            [ -n "$ck" ] || continue
            w=$(printf '%s' "$AUTOPILOT_PR_EVENTS" | jq -r --arg H "$LABEL_PENDING_HUMAN" \
                    --arg kind "$ck" --arg t "$ct" --arg idx "$ci" '
                [ .[][]? ] | to_entries
                | map(select(.value.event == "labeled" and (.value.label.name // "") == $H)) | last
                | if . == null then "unknown"
                  elif $kind == "pr" then (if $idx != "" and ($idx | tonumber) > .key then "after" else "before" end)
                  elif $t == "" or (.value.created_at // "") == "" then "unknown"
                  elif $t > .value.created_at then "after" else "before" end' 2>/dev/null) || w=unknown
            if [ "$w" = after ]; then
                when=after
                AUTOPILOT_AUTH_KIND="$ck"; AUTOPILOT_AUTH_NUM="$cn"; AUTOPILOT_AUTH_T="$ct"; AUTOPILOT_AUTH_IDX="$ci"; AUTOPILOT_ACTOR="$ca"
                break
            fi
            [ "$w" = before ] || any_unknown=1
        done <<< "$AUTOPILOT_AUTH_CANDS"
        [ "$when" = after ] || [ -z "$any_unknown" ] || when=unknown
        case "$when" in
            after) ;;
            before)   # pending/human 打在授权之后：那是叫停（交人待办要知道这个 pending/human 是不是 daemon 自己加的）
                AT_V=skip; AT_WHY=human-later
                AT_HUMAN_BY=$(printf '%s' "$AUTOPILOT_PR_EVENTS" | jq -r --arg H "$LABEL_PENDING_HUMAN" \
                    '[ .[][]? | select(.event == "labeled" and (.label.name // "") == $H) ] | last | .actor.login // ""' 2>/dev/null) || AT_HUMAN_BY=""
                return 0 ;;
            *) AT_REASON="判不了 PR #$pr 上的 \`$LABEL_PENDING_HUMAN\` 和托管标签谁先谁后"; return 0 ;;
        esac
    fi
    AT_V=take
}

autopilot_takeover_one() {   # <state_file> <PR 编号> <缓存键>
    local sf="$1" pr="$2" key="$3" n kind head base ref repo mode body where
    autopilot_takeover_permit "$pr"
    case "$AT_V" in skip|deny) autopilot_takeover_reset "$sf" "$pr" ;; esac
    case "$AT_V" in
        skip)
            # 等待被提前摘掉而不接手的不记进接手缓存：缓存按 PR 的 updated_at（只到秒）认，同一秒里的新标签
            # 事件、改了标签配置都会被它盖住（代码复审第 1 轮）。每轮重判，日志只在原因变了时记
            if [ "$AT_WHY" = requester-wait ]; then
                [ -n "$REQUESTER_BOT_WAIT_LOGGED" ] || log "托管：PR #$pr 不接手——$REQUESTER_BOT_WAIT_REASON，等有人打派工标签"
                return 0
            fi
            autopilot_state_set "$sf" '.takeover[$p] = $k' --arg p "$pr" --arg k "$key" || true
            return 0 ;;
        deny)
            log "托管：PR #$pr 挂着托管标签但不接手（${AUTOPILOT_REASON:-$AUTOPILOT_DENY}）"
            autopilot_note_pr_denial "$sf" "$pr"
            autopilot_state_set "$sf" '.takeover[$p] = $k' --arg p "$pr" --arg k "$key" || true
            return 0 ;;
        take) ;;
        *) autopilot_takeover_unknown "$sf" "$pr" "$AT_REASON" "$key"; return 0 ;;
    esac
    n="$AT_N"; kind="$AT_KIND"; head="$AT_HEAD"; base="$AT_BASE"; ref="$AT_REF"; repo="$AT_REPO"; mode="$AT_MODE"
    where="$(autopilot_auth_where)"
    # 写之前：同一个判定用现读的数据原样再跑一遍，结论和身份都没变才写
    autopilot_takeover_permit "$pr"
    # 这一轮的结论看这最后一次判定：判不了就照判不了计数，确定了才清零
    if [ "$AT_V" = unknown ]; then autopilot_takeover_unknown "$sf" "$pr" "$AT_REASON" "$key"; return 0; fi
    autopilot_takeover_reset "$sf" "$pr"
    if [ "$AT_V" != take ] || [ "$AT_N" != "$n" ] || [ "$AT_HEAD" != "$head" ] || [ "$AT_BASE" != "$base" ] \
       || [ "$AT_REF" != "$ref" ] || [ "$AT_REPO" != "$repo" ] || [ "$AT_MODE" != "$mode" ]; then
        log "托管：PR #$pr 判定接手之后有变化（重判结果 $AT_V），本轮不动"
        return 0
    fi
    if [ "$mode" = human ]; then
        run_gh "label 翻转 (托管接手 PR #$pr：$LABEL_PENDING_HUMAN → $LABEL_PENDING_REVIEW)" \
            gh_label_flip "$pr" --add "$LABEL_PENDING_REVIEW" --remove "$LABEL_PENDING_HUMAN" || return 0
    else
        run_gh "label 翻转 (托管接手 PR #$pr → $LABEL_PENDING_REVIEW)" \
            gh_label_flip "$pr" --add "$LABEL_PENDING_REVIEW" || return 0
    fi
    AUTOPILOT_ACTED=1
    # 维护者重新授权 = 重新开始：之前的打回 / 读不到计数、旧的复审记录都作废
    autopilot_state_set "$sf" 'del(.takeover[$p]) | .prs[$p] = ((.prs[$p] // {}) | del(.bounces, .unknown, .checks_pending_since, .reviewed_head, .reviewed_base, .reviewed_at))' \
        --arg p "$pr" || true
    if [ "$kind" = pr ]; then
        # 没绑 issue（GitHub#142）：授权和叫停都只看 PR
        body="$(printf '## 托管：已接手 PR #%s，重新交复审\n\n`%s` 在 %s 上打了托管标签 `%s`，所以 daemon 接手这个 PR：已翻到 `%s` 重新复审。这个 PR 没绑 issue，授权和叫停都只看 PR 自己。复审通过并贴出测试重跑记录后，daemon 核对授权、提交、自动检查和冲突，全部满足才合并。\n\n要叫停：摘掉本 PR 上的 `%s`，或打 `%s`。\n\n%s\n<!-- cavil-loop:autopilot-takeover pr=%s head=%s -->' \
            "$pr" "$AUTOPILOT_ACTOR" "$where" "$LABEL_AUTOPILOT" "$LABEL_PENDING_REVIEW" \
            "$LABEL_AUTOPILOT" "$LABEL_PENDING_HUMAN" "$(autopilot_daemon_sig)" "$pr" "$head")"
    else
    body="$(printf '## 托管：已接手 PR #%s，重新交复审\n\n`%s` 在 %s 上打了托管标签 `%s`，所以 daemon 接手这个 PR：已翻到 `%s` 重新复审（对应 issue #%s）。复审通过并贴出测试重跑记录后，daemon 核对授权、提交、自动检查和冲突，全部满足才合并。\n\n要叫停：摘掉 issue 或 PR 上的 `%s`，或在任一处打 `%s`。\n\n%s\n<!-- cavil-loop:autopilot-takeover pr=%s head=%s -->' \
        "$pr" "$AUTOPILOT_ACTOR" "$where" "$LABEL_AUTOPILOT" "$LABEL_PENDING_REVIEW" "$n" \
        "$LABEL_AUTOPILOT" "$LABEL_PENDING_HUMAN" "$(autopilot_daemon_sig)" "$pr" "$head")"
    fi
    run_gh "托管接手说明评论 (PR #$pr)" gh_write api -X POST "repos/$REPO/issues/$pr/comments" -f "body=$body" || true
    log "托管：PR #$pr 已接手（授权 $AUTOPILOT_ACTOR @ $where）→ $LABEL_PENDING_REVIEW"
}

# ── 接手阶段「判不了」的完整生命周期（GitHub#128 复审第 2–5 轮）──
# 一轮的结论只看这一轮**最后一次**许可判定（判定可接手时，写之前那次重判才是最后一次）：
#   确定（接手 / 不接手 / 不生效 / 两次之间有变化）→ 连续判不了的计数清零（done / cancelled 也清掉）
#   判不了（第一次或写前那次，读不到或缺字段都算）→ 计数 +1；到 AUTOPILOT_UNKNOWN_MAX 记下「要交人」
#
# 「要交人」这个决定只有一个依据：**判不了**。每次动手之前，用同一个接手许可（autopilot_takeover_permit）
# 现读重判，再按下表处理（.takeover_handoff = 待办；labeled = 本地记过 daemon 已加 pending/human）：
#
#   现读结果                                   前提①身份同  前提②标签在   处理
#   ────────────────────────────────────────  ───────────  ────────────  ─────────────────────────────
#   PR 读不全（读不到 / 缺分支或 issue）       —            —             不写，待办留着，下轮再试
#   仍判不了                                   是           是 / 未加过   继续：缺标签就加，缺说明就发，都齐了收尾 done
#   pending/human 晚于授权，且是 daemon 加的   是           是            继续（标签已在，只补说明），收尾 done
#   上面两行之一，但身份变了                   否           —             作废，改按现在的结论走普通接手
#   上面两行之一，但 labeled 而 pending/human  是           否            作废，记 cancelled：人已接过这件事，
#     已不在（被人摘了）                                                  不补说明、不再交人，直到有确定结论
#   其他任何确定结论（重新授权可接手、PR 关闭  —            —             作废，改按现在的结论走普通接手
#     / 合并 / 改绑 / 转进别的流程 / 人叫停…）
#
# 待办在动 GitHub 之前就记下；加标签、发说明都可重复（标签已在不再加，评论里有标记不再发），所以写到
# 一半失败、进程被杀，下一轮按同一张表接着判。done / cancelled 之后仍判不了也不再交人。
autopilot_takeover_reset() {   # <state_file> <PR>
    [ -z "$(autopilot_state_get "$1" '.takeover_unknown[$p]' --arg p "$2")" ] \
        || autopilot_state_set "$1" 'del(.takeover_unknown[$p])' --arg p "$2" || true
}
autopilot_takeover_unknown() {   # <state_file> <PR> <原因> <缓存键>
    local sf="$1" pr="$2" reason="$3" key="$4" k max
    k=$(autopilot_state_get "$sf" '.takeover_unknown[$p] // 0' --arg p "$pr")
    if [ "$k" = done ] || [ "$k" = cancelled ]; then
        # done = 已交人；cancelled = 交人途中维护者摘掉了 pending/human（人已接过这件事）。
        # 两种都在有确定结论之前不再交人
        log "托管：PR #$pr 能不能接手仍判不了（$reason），之前已$( [ "$k" = done ] && echo 交人 || echo 由人接过)"
        return 0
    fi
    [[ "$k" =~ ^[0-9]+$ ]] || k=0
    k=$(( k + 1 ))
    max="${AUTOPILOT_UNKNOWN_MAX:-10}"
    autopilot_state_set "$sf" '.takeover_unknown[$p] = ($k | tonumber)' --arg p "$pr" --arg k "$k" || return 0
    if [ "$k" -lt "$max" ] 2>/dev/null; then
        log "托管：PR #$pr 能不能接手判不了（$reason），第 $k 次，下轮再看"
        return 0
    fi
    # 到上限：先记下待办（连同这次判定读到的 issue / 分支 / 来源），再走待办（它自己会现读重判）
    autopilot_state_set "$sf" '.takeover_handoff[$p] = {k: ($k | tonumber), reason: $r, n: $n, ref: $ref, repo: $repo, labeled: false}' \
        --arg p "$pr" --arg k "$k" --arg r "$reason" --arg n "${AT_N:-}" --arg ref "${AT_REF:-}" --arg repo "${AT_REPO:-}" || return 0
    log "托管：PR #$pr 连续 $k 轮判不了能不能接手 → 交人"
    autopilot_takeover_handoff "$sf" "$pr" "$key"
}
autopilot_takeover_handoff() {   # <state_file> <PR> <缓存键>
    local sf="$1" pr="$2" key="$3" h k reason n ref repo labeled labels cmts body me drop=""
    h=$(jq -c --arg p "$pr" '.autopilot.takeover_handoff[$p] // empty' "$sf" 2>/dev/null) || h=""
    [ -n "$h" ] || return 0
    k=$(printf '%s' "$h" | jq -r '.k'); reason=$(printf '%s' "$h" | jq -r '.reason')
    n=$(printf '%s' "$h" | jq -r '.n // ""')
    ref=$(printf '%s' "$h" | jq -r '.ref // ""'); repo=$(printf '%s' "$h" | jq -r '.repo // ""')
    labeled=$(printf '%s' "$h" | jq -r '.labeled // false')
    # 现读重判：和普通接手用的是同一个许可函数。结论分三类（完整状态表见本节开头）：
    #   现状读不全 → 本轮不写，待办留着
    #   结论仍是「判不了」，或是「标签由 daemon 为这条待办加上、只差说明」→ 这两种才可能继续，
    #     而且都必须先通过同一组前提：①身份（issue / 分支 / 来源）和交人决定时一样；
    #     ②本地记过「标签已加」的，现读到的标签里 pending/human 必须还在（被人摘了 = 人已接过这件事）
    #   其他任何确定结论 → 作废，改按现在的结论走普通接手
    autopilot_takeover_permit "$pr"
    local cont=""
    case "$AT_V" in
        unknown)
            if [ -z "$AT_PJ" ] || [ -z "$AT_KIND" ] || { [ "$AT_KIND" = issue ] && [ -z "$AT_N" ]; } || [ -z "$AT_REF" ]; then
                log "托管：PR #$pr 交人前读不全它的现状（${AT_REASON:-缺字段}），下轮再试"; return 0
            fi
            cont=unknown ;;
        skip)
            me=$(write_identity_login)
            if [ "$AT_WHY" = human-later ] && [ -n "$me" ] \
               && [ "$(requester_bot_lc "$AT_HUMAN_BY")" = "$(requester_bot_lc "$me")" ]; then
                cont=mine; labeled=true   # 标签是 daemon 为这条待办加的，只差说明
            else
                drop="现在判得出结论了（不接手）"
            fi ;;
        *) drop="现在判得出结论了（${AT_V}）" ;;
    esac
    if [ -n "$cont" ]; then
        # 前提①：身份
        if { [ -n "$n" ] && [ "$AT_N" != "$n" ]; } || { [ -n "$ref" ] && [ "$AT_REF" != "$ref" ]; } \
           || { [ -n "$repo" ] && [ "$AT_REPO" != "$repo" ]; }; then
            drop="PR 的 issue / 分支 / 来源和交人决定时不一样了"
        # 前提②：本地记过标签已加，现读到的 pending/human 必须还在
        elif [ "$labeled" = true ] && ! printf '%s' "$AT_PJ" | jq -e --arg H "$LABEL_PENDING_HUMAN" \
                 'any(.labels[]?; .name == $H)' >/dev/null 2>&1; then
            log "托管：PR #$pr 加上的 $LABEL_PENDING_HUMAN 已被人摘掉，交人待办作废，不补说明；在有确定结论之前不再交人"
            autopilot_state_set "$sf" 'del(.takeover_handoff[$p]) | .takeover_unknown[$p] = "cancelled"' --arg p "$pr" || true
            return 0
        fi
    fi
    if [ -n "$drop" ]; then
        log "托管：PR #$pr 的交人待办作废（$drop），改按现在的结论处理"
        autopilot_state_set "$sf" 'del(.takeover_handoff[$p]) | del(.takeover_unknown[$p])' --arg p "$pr" || return 0
        autopilot_takeover_one "$sf" "$pr" "$key"
        return 0
    fi
    if [ "$labeled" != true ]; then
        labels=$(printf '%s' "$AT_PJ" | jq -r '[.labels[]?.name] | join(",")')
        case ",$labels," in
            *",$LABEL_PENDING_HUMAN,"*) ;;
            *) run_gh "label 翻转 (托管接手判不了 PR #$pr → $LABEL_PENDING_HUMAN)" \
                   gh_label_flip "$pr" --add "$LABEL_PENDING_HUMAN" || return 0
               AUTOPILOT_ACTED=1 ;;
        esac
    fi
    autopilot_state_set "$sf" '.takeover_handoff[$p].labeled = true' --arg p "$pr" || return 0
    # 说明只发一条：评论里已有标记（上次发成功但没来得及记、或别的机器发过）就不再发
    if ! cmts=$(gh api --paginate --slurp "repos/$REPO/issues/$pr/comments" 2>/dev/null) || [ -z "$cmts" ]; then
        log "托管：PR #$pr 交人说明发之前读不到已有评论，下轮再试"; return 0
    fi
    if ! printf '%s' "$cmts" | jq -e --arg T "<!-- cavil-loop:autopilot-takeover-unknown pr=$pr -->" \
            'any(.[][]?; (.body // "") | contains($T))' >/dev/null 2>&1; then
        body="$(printf '⚠️ **托管：判断不了能不能接手 PR #%s，已转人工（`%s`）**\n\n**原因**：PR 上的托管标签 `%s` 连续 %s 轮判断不了，最后一次：%s。\n\n**怎么继续**：处理好之后请维护者摘掉再亲手打一次 `%s`（daemon 会重新判断、接手）；不托管就照普通流程处理。\n\n%s\n<!-- cavil-loop:autopilot-takeover-unknown pr=%s -->' \
            "$pr" "$LABEL_PENDING_HUMAN" "$LABEL_AUTOPILOT" "$k" "$reason" "$LABEL_AUTOPILOT" "$(autopilot_daemon_sig)" "$pr")"
        run_gh "托管接手判不了的交人说明 (PR #$pr)" gh_write api -X POST "repos/$REPO/issues/$pr/comments" -f "body=$body" || return 0
        AUTOPILOT_ACTED=1
    fi
    autopilot_state_set "$sf" 'del(.takeover_handoff[$p]) | .takeover_unknown[$p] = "done"' --arg p "$pr" || true
    log "托管：PR #$pr 交人完成（加 $LABEL_PENDING_HUMAN、留言）"
}

# PR 上的托管标签不生效时在 PR 上说一次（只说「不是维护者打的」「PR 不合条件」「issue 关了」
# 「打标签那一刻的正文不合条件」）
autopilot_note_pr_denial() {   # <state_file> <PR 编号>
    local sf="$1" pr="$2" text kind="$AUTOPILOT_DENY"
    case "$kind" in
        actor-*|binding|closed|label-body) ;;
        *) return 0 ;;
    esac
    text="⚠️ **PR 上的托管标签 \`$LABEL_AUTOPILOT\` 不生效**

**原因**：${AUTOPILOT_REASON:-判定不成立}。托管只认在仓库有写权限的维护者亲手打的标签（外部需求机器人账号、loop 自己的账号打的都不算）。PR 绑了 issue（分支 \`${BRANCH_PREFIX}<编号>\`、正文只写一个 \`Closes #<编号>\`）时 issue 或 PR 上打都行；没绑 issue 时只看 PR 自己，正文里不能写关闭本仓库 issue 的关键词（只引用写 \`Refs #<编号>\`），而且打标签那一刻的正文也要满足这一条。

**怎么继续**：条件满足后请维护者看过现在的 PR、摘掉再亲手打一次 \`$LABEL_AUTOPILOT\`；不托管就照普通流程处理。"
    autopilot_notice_once "$sf" "$pr" "pr-$kind" "$text" || true
}

# 每轮：扫挂着托管标签的 PR，看要不要接手。判过「不接手」的按 PR 更新时间 + 绑定的 issue 编号 +
# 该 issue 的更新时间记下，三样都没变就不再读标签记录（打 / 摘标签会刷新条目的更新时间）。
# 只缓存「不接手」：合并前许可从不走这个缓存。
# 本轮快照里，issue #n 本身或者它的父 issue 挂着托管标签吗（GitHub#233，接手 / 补标签两趟筛候选用，不发请求）。
# 父 issue 在别的仓库（不在本仓库快照里）时说不准，一律当候选，由判定现读。
# stdout：yes / no；有父 issue 时另加一段父 issue 的更新时间（缓存键用；别的仓库的父 issue 写 "foreign"）
autopilot_snapshot_labeled() {   # <issue 编号> <issues 快照>
    printf '%s' "$2" | jq -r --argjson n "$1" --arg L "$LABEL_AUTOPILOT" --arg R "https://api.github.com/repos/$REPO/issues/" '
        ([.[][]]) as $all
        | (first($all[] | select(.number == $n)) // null) as $i
        | if $i == null then "no"
          elif any($i.labels[]?; .name == $L) then "yes"
          elif ($i.parent_issue_url // "") == "" then "no"
          elif ($i.parent_issue_url | ascii_downcase | startswith($R | ascii_downcase)) then
            ($i.parent_issue_url | split("/") | last | tonumber) as $p
            | (first($all[] | select(.number == $p)) // null) as $pi
            | if $pi != null and any($pi.labels[]?; .name == $L) then "yes|\($pi.updated_at // "")" else "no" end
          else "yes|foreign" end' 2>/dev/null || echo no
}

autopilot_takeover_tick() {   # <state_file>
    local sf="$1" pages ipages rows num upd pj n iupd key open_nums tmp owed sl
    autopilot_configured || return 0
    pages=$(open_snapshot pulls) || return 0
    # 候选：PR 自己挂着托管标签；或者 PR 挂着 pending/human、绑定的 issue 挂着托管标签（PR 摘标交人之后，
    # 维护者只在 issue 上重新授权）。后一种先在本地按快照筛，普通的等人 PR 一次 GitHub 调用都不多花。
    # 另外，欠着交人待办的 PR 不管现在挂什么标签都要过一遍（待办自己判断还要不要做）
    owed=$(jq -c '(.autopilot.takeover_handoff // {}) | keys' "$sf" 2>/dev/null) || owed='[]'
    rows=$(printf '%s' "$pages" | jq -r --arg L "$LABEL_AUTOPILOT" --arg H "$LABEL_PENDING_HUMAN" --argjson owed "${owed:-[]}" \
        '.[][] | select(any(.labels[]?; .name == $L or .name == $H) or ((.number | tostring) as $n | $owed | index($n)))
         | "\(.number)\t\(.updated_at // "")"' 2>/dev/null) || return 0
    if jq -e '.autopilot.takeover or .autopilot.takeover_unknown or .autopilot.takeover_handoff' "$sf" >/dev/null 2>&1 \
       && open_nums=$(printf '%s' "$pages" | jq -c '[ .[][] | .number | tostring ]' 2>/dev/null); then
        tmp=$(mktemp)
        if jq --argjson open "$open_nums" \
            '.autopilot.takeover = ((.autopilot.takeover // {}) | with_entries(select(.key as $k | $open | index($k))))
             | .autopilot.takeover_unknown = ((.autopilot.takeover_unknown // {}) | with_entries(select(.key as $k | $open | index($k))))
             | .autopilot.takeover_handoff = ((.autopilot.takeover_handoff // {}) | with_entries(select(.key as $k | $open | index($k))))' \
            "$sf" > "$tmp" 2>/dev/null; then mv "$tmp" "$sf"; else rm -f "$tmp"; fi
    fi
    [ -n "$rows" ] || return 0
    if ! autopilot_enabled; then
        while IFS=$'\t' read -r num upd; do
            [ -n "$num" ] || continue
            printf '%s' "$pages" | jq -e --argjson n "$num" --arg L "$LABEL_AUTOPILOT" \
                'any(.[][]; .number == $n and any(.labels[]?; .name == $L))' >/dev/null 2>&1 || continue
            autopilot_notice_once "$sf" "$num" no-review-gate "⚠️ **托管标签 \`$LABEL_AUTOPILOT\` 不生效：本项目没有开复审关卡**

托管靠独立复审把关、通过后自动合并；本项目没配复审标签，就没人把关，所以不托管。这个 PR 照普通流程处理。" || true
        done <<< "$rows"
        return 0
    fi
    ipages=$(open_snapshot issues) || ipages="[]"
    while IFS=$'\t' read -r num upd; do
        [ -n "$num" ] || continue
        pj=$(printf '%s' "$pages" | jq -c --argjson n "$num" 'first(.[][] | select(.number == $n)) // empty' 2>/dev/null) || pj=""
        n=$(autopilot_pr_binding "$pj" 2>/dev/null) || n="-"
        iupd="-"
        if [ "$n" != "-" ]; then
            iupd=$(printf '%s' "$ipages" | jq -r --argjson n "$n" 'first(.[][] | select(.number == $n) | .updated_at) // "closed"' 2>/dev/null) || iupd="?"
        fi
        key="$AUTOPILOT_JUDGE_REV|$upd|$n|$iupd"
        # 欠着的交人待办先做（它自己现读重判，判得出结论就作废、改走普通接手），不看缓存、不筛候选
        if [ -n "$(autopilot_state_get "$sf" '.takeover_handoff[$p]' --arg p "$num")" ]; then
            autopilot_takeover_handoff "$sf" "$num" "$key" || true; continue
        fi
        # 快照里除托管标签和 pending/human 外还挂着流程标签：接手许可第一步就会判「正在进行的工作，不接手」，
        # 不为它多读 PR（GitHub#190 起托管 PR 自己都挂着 daemon 补的托管标签，不筛的话每个都要读一次）
        if autopilot_labels_in_flow "$(printf '%s' "$pj" | jq -r --arg L "$LABEL_AUTOPILOT" --arg H "$LABEL_PENDING_HUMAN" \
                '[.labels[]?.name | select(. != $L and . != $H)] | join(",")' 2>/dev/null)"; then
            continue
        fi
        if ! autopilot_has_label "$pj"; then
            # 只挂着 pending/human：绑定的 issue（或拆分子项的父 issue，GitHub#233）在快照里挂着托管标签才算候选
            [ "$n" != "-" ] || continue
            sl=$(autopilot_snapshot_labeled "$n" "$ipages")
            case "$sl" in no) continue ;; yes) ;; *) key="$key|${sl#yes|}" ;; esac
        fi
        if [ "$iupd" != "?" ] && [ "$key" = "${key%|foreign}" ] && [ "$(autopilot_state_get "$sf" '.takeover[$p]' --arg p "$num")" = "$key" ]; then
            continue
        fi
        autopilot_takeover_one "$sf" "$num" "$key" || true
    done <<< "$rows"
    return 0
}

# ── 托管 PR 上补一份托管标签（GitHub#190）──
# issue 进到 PR 阶段后，PR 上也挂一个托管标签：PR 列表上看得出哪些 PR 会被自动合并，也能直接在 PR 上
# 摘标签叫停。issue 上维护者亲手打的那个原样保留（它才是授权）；PR 上这份由 daemon 的写入账号打，
# 判授权时当作没挂（autopilot_place_strip_copy），不授权、不触发接手、不引出「不生效」说明。
# 授权明确不成立之后（标签被摘、issue 关了…），daemon 把自己补的那份收回；维护者亲手打的从不动。
#
# 补和收回是同一个纯判定 autopilot_mirror_judge，和合并前许可一样判两次：第一次判出 add / remove 之后，
# 紧挨着写之前全部现读再判一次，结论和下面每个身份字段都一样才写；变了、缺字段、读不到 → 本轮不写、不缓存。
#   PR：是否打开 / 已合并、最新提交、目标分支、来源仓库、分支名、托管标签在不在
#   绑定：issue 编号（同 autopilot_pr_kind）；issue：状态；两处有没有 pending/human
#   副本：PR 上最后一次打上托管标签的那条记录的位置（两次之间有人亲手重打，位置就变了）
#   授权：结论、所依据那次打标签的位置
# 结果在全局变量里（必须在调用方自己的 shell 里调）：AM_V = add / remove / none / unknown；AM_ID；AM_REASON
autopilot_mirror_judge() {   # <PR 编号>
    local pr="$1" pj ij="" state merged head base repo ref pl kind n="" wn istate="-" ph ih copy="-" rc
    AM_V=unknown; AM_ID=""; AM_REASON=""
    if ! pj=$(gh api "repos/$REPO/pulls/$pr" 2>/dev/null) || [ -z "$pj" ] \
       || ! printf '%s' "$pj" | jq -e '(.state | type) == "string" and (.merged | type) == "boolean" and (.labels | type) == "array"' >/dev/null 2>&1; then
        AM_REASON="读不到 PR #$pr（或缺字段）"; return 0
    fi
    state=$(printf '%s' "$pj" | jq -r '.state'); merged=$(printf '%s' "$pj" | jq -r '.merged')
    if [ "$state" != open ] || [ "$merged" != false ]; then AM_V=none; return 0; fi
    head=$(printf '%s' "$pj" | jq -r '.head.sha // ""'); base=$(printf '%s' "$pj" | jq -r '.base.ref // ""')
    repo=$(printf '%s' "$pj" | jq -r '.head.repo.full_name // ""'); ref=$(printf '%s' "$pj" | jq -r '.head.ref // ""')
    if [ -z "$head" ] || [ -z "$base" ] || [ -z "$repo" ] || [ -z "$ref" ]; then
        AM_REASON="PR #$pr 的提交 / 目标分支 / 来源 / 分支名读不全"; return 0
    fi
    pl=no; autopilot_has_label "$pj" && pl=yes
    autopilot_pr_kind "$pj"; kind="$AUTOPILOT_PR_KIND"
    if [ "$kind" = issue ]; then
        n="$AUTOPILOT_PR_N"; wn="$n"
    else
        wn=$(pr_to_issue_num "$pr" "$ref" "$(printf '%s' "$pj" | jq -r '.body // ""')")
    fi
    # 多机：别的机器负责的活不碰（和合并那一趟同一条规则）
    if ! worker_is_ours "$wn"; then AM_V=none; return 0; fi
    if [ "$kind" = issue ]; then
        if ! ij=$(gh api "repos/$REPO/issues/$n" 2>/dev/null) || [ -z "$ij" ] \
           || ! printf '%s' "$ij" | jq -e '(.state | type) == "string" and (.labels | type) == "array"' >/dev/null 2>&1; then
            AM_REASON="读不到 issue #$n（或缺字段）"; return 0
        fi
        istate=$(printf '%s' "$ij" | jq -r '.state')
    fi
    ph=no; printf '%s' "$pj" | jq -e --arg H "$LABEL_PENDING_HUMAN" 'any(.labels[]?; .name == $H)' >/dev/null 2>&1 && ph=yes
    ih=no; [ -n "$ij" ] && printf '%s' "$ij" | jq -e --arg H "$LABEL_PENDING_HUMAN" 'any(.labels[]?; .name == $H)' >/dev/null 2>&1 && ih=yes
    if [ "$pl" = no ]; then
        # 补：只给绑 issue、两处都没叫停、授权成立的 PR
        if [ "$kind" != issue ] || [ "$istate" != open ] || [ "$ph" = yes ] || [ "$ih" = yes ]; then
            AM_V=none; return 0
        fi
        # issue 自己挂着，或者是拆分子项、父 issue 挂着（GitHub#233）
        rc=0; autopilot_labeled_or_parent "$n" "$ij" || rc=$?
        case "$rc" in
            0) ;;
            2) AM_REASON="$AUTOPILOT_REASON"; return 0 ;;
            *) AM_V=none; return 0 ;;
        esac
        rc=0; autopilot_authorization "$n" "$ij" "$pr" "$pj" || rc=$?
        case "$rc" in
            0) AM_V=add ;;
            1) AM_V=none; return 0 ;;
            *) AM_REASON="$AUTOPILOT_REASON"; return 0 ;;
        esac
    else
        # 收回：PR 上的是副本，而且授权明确不成立（判不了不算）
        autopilot_place_read "$pr" "$pj" "PR #$pr" || { AM_REASON="$AUTOPILOT_REASON"; return 0; }
        autopilot_place_strip_copy "PR #$pr" || { AM_REASON="$AUTOPILOT_REASON"; return 0; }
        if [ -z "$AUTOPILOT_PLACE_COPY" ]; then AM_V=none; return 0; fi
        copy="$AUTOPILOT_PLACE_COPY"
        rc=0; AUTOPILOT_PR_COPY=""; AUTOPILOT_PR_COPY_READ=""
        case "$kind" in
            issue) autopilot_authorization "$n" "$ij" "$pr" "$pj" || rc=$? ;;
            pr)    autopilot_authorization "" "" "$pr" "$pj" || rc=$? ;;
            *)     rc=1; AUTOPILOT_AUTH_KIND=""; AUTOPILOT_AUTH_NUM=""; AUTOPILOT_AUTH_IDX="" ;;   # 不合托管条件：没有授权可言
        esac
        case "$rc" in
            0) AM_V=none; return 0 ;;
            1) ;;
            *) AM_REASON="$AUTOPILOT_REASON"; return 0 ;;
        esac
        # 授权判定自己又读了一遍 PR 的标签记录（PR #203 代码复审第 1 轮）：两次读之间维护者可能亲手重打了，
        # 授权那次读到的已经不是副本、甚至因为和 issue 上的摘掉同一秒而仍判「不成立」。「要删的仍是自己那份」
        # 只能由同一份证据证明：这一次判定里读过几遍 PR 的标签记录，每一遍都必须指向同一条副本记录，否则判不了。
        # 授权判定没读 PR（issue 关了之类提前返回）时，这次判定只有上面那一遍，证据本来就是同一份。
        if [ -n "$AUTOPILOT_PR_COPY_READ" ] && [ "$AUTOPILOT_PR_COPY" != "$copy" ]; then
            AM_REASON="同一次判定里两遍读到的 PR #$pr 托管标签记录不一致（副本位置 ${copy} → ${AUTOPILOT_PR_COPY:-不是副本}），本轮不收回"
            return 0
        fi
        AM_V=remove; AUTOPILOT_AUTH_KIND=""; AUTOPILOT_AUTH_NUM=""; AUTOPILOT_AUTH_IDX=""
    fi
    AM_ID="$state|$merged|$head|$base|$repo|$ref|$pl|$kind|$n|$istate|$ph|$ih|$copy|$AUTOPILOT_AUTH_KIND|$AUTOPILOT_AUTH_NUM|$AUTOPILOT_AUTH_IDX"
}

autopilot_mirror_one() {   # <state_file> <PR 编号> <缓存键>
    local sf="$1" pr="$2" key="$3" v id enc out
    autopilot_mirror_judge "$pr"
    case "$AM_V" in
        none) autopilot_state_set "$sf" '.mirror[$p] = $k' --arg p "$pr" --arg k "$key" || true; return 0 ;;
        add|remove) ;;
        *) log "托管：PR #$pr 要不要补 / 收回托管标签判不了（$AM_REASON），下轮再看"; return 0 ;;
    esac
    v="$AM_V"; id="$AM_ID"
    # 写之前：同一个判定用现读的数据原样再跑一遍，结论和身份都没变才写
    autopilot_mirror_judge "$pr"
    if [ "$AM_V" != "$v" ] || [ "$AM_ID" != "$id" ]; then
        log "托管：PR #$pr 判定$( [ "$v" = add ] && echo 补 || echo 收回)托管标签之后有变化（重判结果 $AM_V${AM_REASON:+：$AM_REASON}），本轮不动"
        return 0
    fi
    if [ "$v" = add ]; then
        run_gh "托管：给 PR #$pr 补托管标签 $LABEL_AUTOPILOT（来自 issue）" \
            gh_write api -X POST "repos/$REPO/issues/$pr/labels" -f "labels[]=$LABEL_AUTOPILOT" >/dev/null || return 0
        AUTOPILOT_ACTED=1
        # 读回：返回成功不等于标签真挂上了；没挂上下轮再补，合并前许可也会拦住
        if gh api "repos/$REPO/issues/$pr" 2>/dev/null | jq -e --arg L "$LABEL_AUTOPILOT" 'any(.labels[]?; .name == $L)' >/dev/null 2>&1; then
            log "托管：PR #$pr 补上托管标签 $LABEL_AUTOPILOT（授权在 $(autopilot_auth_where)）"
        else
            log "  ⚠️ 托管：PR #$pr 补托管标签的请求返回成功，读回却没有（或读不到），下轮再补"
        fi
        return 0
    fi
    enc=$(printf '%s' "$LABEL_AUTOPILOT" | jq -sRr @uri)
    if out=$(gh_write api -X DELETE "repos/$REPO/issues/$pr/labels/$enc" 2>&1); then
        :
    else
        case "$out" in
            *"HTTP 404"*) ;;   # 已经不在了：目标就是没有
            *) log "  ⚠️ 托管：收回 PR #$pr 上的托管标签副本失败，下轮再试：$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
               return 0 ;;
        esac
    fi
    AUTOPILOT_ACTED=1
    log "托管：PR #$pr 的托管授权已不成立，收回 daemon 补在 PR 上的托管标签 $LABEL_AUTOPILOT"
}

# 每轮：补 / 收回托管标签。候选只在本轮快照里本地筛，普通 PR 一个 GitHub 调用都不多花：
#   补    PR 没挂托管标签，按绑定规则绑到一个挂着托管标签、仍打开的 issue
#   收回  PR 挂着托管标签，而且（没绑 issue，或绑定的 issue 不在打开列表里、没挂托管标签）——是不是副本、
#         授权还在不在，由判定现读。issue 还挂着托管标签的不当候选：健康的托管 PR 每轮零调用
# 判过「不动」的按 PR 更新时间 + 绑定的 issue 编号 + 该 issue 的更新时间记下（打 / 摘标签会刷新更新时间），
# 都没变就不再读标签记录。判不了不缓存。排在接手之后、合并之前：补上标签的 PR 同一轮就能合。
autopilot_mirror_tick() {   # <state_file>
    local sf="$1" pages ipages open_nums tmp rows num upd pj n iupd key ilab sl
    autopilot_enabled || return 0
    pages=$(open_snapshot pulls) || return 0
    ipages=$(open_snapshot issues) || return 0
    if jq -e '.autopilot.mirror' "$sf" >/dev/null 2>&1 \
       && open_nums=$(printf '%s' "$pages" | jq -c '[ .[][] | .number | tostring ]' 2>/dev/null); then
        tmp=$(mktemp)
        if jq --argjson open "$open_nums" \
            '.autopilot.mirror = ((.autopilot.mirror // {}) | with_entries(select(.key as $k | $open | index($k))))' \
            "$sf" > "$tmp" 2>/dev/null; then mv "$tmp" "$sf"; else rm -f "$tmp"; fi
    fi
    # 打开的 issue / PR 都没挂托管标签：没有候选。父 issue 在别的仓库的子项（GitHub#233）这里看不到父 issue 的标签，
    # 只要有挂在别的仓库 issue 下的子项（互通名单开着时）就不提前返回
    if ! printf '%s\n%s' "$pages" "$ipages" | jq -se --arg L "$LABEL_AUTOPILOT" \
            'any(.[][][]; any(.labels[]?; .name == $L))' >/dev/null 2>&1 \
       && { [ -z "${TRUSTED_REPOS:-}" ] || ! printf '%s' "$ipages" | jq -e --arg R "https://api.github.com/repos/$REPO/" \
                'any(.[][]; (.parent_issue_url // "") != "" and ((.parent_issue_url | ascii_downcase) | startswith($R | ascii_downcase) | not))' >/dev/null 2>&1; }; then
        return 0
    fi
    rows=$(printf '%s' "$pages" | jq -r '.[][] | "\(.number)\t\(.updated_at // "")"' 2>/dev/null) || return 0
    while IFS=$'\t' read -r num upd; do
        [ -n "$num" ] || continue
        pj=$(printf '%s' "$pages" | jq -c --argjson n "$num" 'first(.[][] | select(.number == $n)) // empty' 2>/dev/null) || pj=""
        [ -n "$pj" ] || continue
        n=$(autopilot_pr_binding "$pj" 2>/dev/null) || n="-"
        iupd="-"
        if [ "$n" != "-" ]; then
            iupd=$(printf '%s' "$ipages" | jq -r --argjson n "$n" 'first(.[][] | select(.number == $n) | .updated_at) // "closed"' 2>/dev/null) || iupd="?"
        fi
        ilab=no; sl=no
        # issue 自己挂着，或者拆分子项的父 issue 挂着（GitHub#233；父 issue 在别的仓库时快照里看不到，每轮现判、不缓存）
        [ "$n" = "-" ] || sl=$(autopilot_snapshot_labeled "$n" "$ipages")
        case "$sl" in no) ;; *) ilab=yes ;; esac
        if autopilot_has_label "$pj"; then
            [ "$ilab" = no ] || [ "$sl" = "yes|foreign" ] || continue
        else
            [ "$ilab" = yes ] || continue
        fi
        key="$AUTOPILOT_JUDGE_REV|$upd|$n|$iupd"
        case "$sl" in yes\|*) key="$key|${sl#yes|}" ;; esac
        if [ "$iupd" != "?" ] && [ "$sl" != "yes|foreign" ] && [ "$(autopilot_state_get "$sf" '.mirror[$p]' --arg p "$num")" = "$key" ]; then
            continue
        fi
        autopilot_mirror_one "$sf" "$num" "$key" || true
    done <<< "$rows"
    return 0
}

# 托管关掉之后的收尾（GitHub#124）：关托管只要改配置，剩下的 daemon 自己处理。
#
# 配置一关，合并那一趟（autopilot_merge_tick）就整个跳过，而开着时留下的状态还在：
#   · 已经挂着等合并标签的 PR——没人合、也没人交给人，会一直挂着；
#   · 开着时就派出去的复审还拿着托管规则，跑完照样会把 PR 翻成等合并。
# 其余状态都不用管：配置关了以后派工不再拼托管规则，排队、被打断的活按普通流程走完、交人。
# 所以这里每轮把本机托管过的 PR（state.json 里 .autopilot.prs 有记录）交给人。
#
# 交接要做到的最终状态：有 pending/human、没有等合并标签、PR 上有一条交人说明。顺序：加 pending/human →
# 摘等合并标签 → 发说明。三次写入照「交人的写前核对」那两条规则做（GitHub#382，流程三），而且这里的待办是跨轮的，
# 所以**待办带着基准**：.prs[n].off_handover = {base, expect, pending}
#   base    开始收尾时 PR 的指纹（判定「开着、挂着等合并标签」直接从它得出）
#   expect  base + daemon 已确认的自己的写入 = 现在 PR 应该是的样子
#   pending 已经决定要发、还没确认结果的那一次标签写入 {op, label}（先记再写）
# 每一轮、每一次写入之前现取指纹：
#   = expect                        → 接着做
#   = expect + 恰好 pending 那一次  → 上次写成了、没来得及记：记上，接着做
#   其他任何差异                    → 有人动过：待办作废（删掉），本轮不再写。之后 PR 不在合并队列就不再碰
#                                     （人已接手）；仍挂着等合并标签的，下一轮当作新的一件事从头开始
#   分不清（读不到）                → 本轮不写，待办原样留着
# 说明只发一条：发之前读评论，已有本次入队标记的不再发。最终状态都确认了才删待办。
# 托管重新开启时清掉全部待办（只改本机文件）：之后再关，一律从头开始，旧待办不会复活。旧版留下的
# 「true」记号没有基准，按作废处理。
# 只认本机托管过的 PR：别的项目可能恰好也有叫这个名字的标签，从没开过托管的项目（没有 .autopilot.prs）
# 这里直接返回，一个 GitHub 调用都不多。
AUTOPILOT_OFF_TAG='<!-- autopilot-off-handover -->'
# 收尾里的一次标签写入：先记 pending → 现取指纹必须等于 expect → 写 → 重读，确认只多了自己这一条 → 记进 expect。
# 0 = 写成并确认；1 = 本轮到此为止（待办留着，下一轮由 autopilot_off_sweep 判断是补完还是作废）
autopilot_off_write() {   # <state_file> <PR> <labeled|unlabeled> <标签>
    local sf="$1" pr="$2" op="$3" label="$4" exp
    exp=$(jq -c --arg p "$pr" '.autopilot.prs[$p].off_handover.expect' "$sf" 2>/dev/null) || return 1
    autopilot_state_set "$sf" '.prs[$p].off_handover.pending = {op: $o, label: $l}' --arg p "$pr" --arg o "$op" --arg l "$label" \
        || { log "托管已关：PR #$pr 记不下待写的那一步，本轮不动"; return 1; }
    if ! autopilot_fp_expect "$(printf '%s' "$exp" | jq -cS .)" "$pr"; then
        log "托管已关：PR #$pr 写之前现状有变化（$AF_WHY），本轮不写"; return 1
    fi
    if [ "$op" = labeled ]; then
        run_gh "托管已关：PR #$pr 加 $label" gh_write api -X POST "repos/$REPO/issues/$pr/labels" -f "labels[]=$label" || return 1
    else
        autopilot_label_delete "$pr" "$label" || return 1
    fi
    AUTOPILOT_ACTED=1
    if ! autopilot_fingerprint "$pr" || ! autopilot_fp_is_own_write "$(printf '%s' "$exp" | jq -cS .)" "$op" "$label"; then
        log "托管已关：PR #$pr 写完后现状对不上（${AF_WHY:-除了这一次还有别的变化}），本轮到此为止"; return 1
    fi
    autopilot_state_set "$sf" '.prs[$p].off_handover |= ((.expect = $e) | del(.pending))' --arg p "$pr" --argjson e "$AF_FP" \
        || { log "托管已关：PR #$pr 记不下刚确认的写入，下轮再对"; return 1; }
}

autopilot_off_sweep() {   # <state_file>
    local sf="$1" m="${AUTOPILOT_MERGE_LABEL_NAME:-}" mine pages open_nums tmp pr rec exp pend cands cmts q marker
    # 只在托管开关本身关掉时收尾。配了开关但没配复审关卡是另一回事（托管没生效、但人没说要关），
    # 那种情况合并这一段照旧整个不动。托管开着：上次关掉时没做完的收尾待办作废（只改本机文件）
    if autopilot_configured; then
        if jq -e '[(.autopilot.prs // {})[] | select(has("off_handover"))] | length > 0' "$sf" >/dev/null 2>&1; then
            autopilot_state_set "$sf" '.prs |= with_entries(.value |= del(.off_handover))' || true
        fi
        return 0
    fi
    [ -n "$m" ] && [ -n "${LABEL_PENDING_HUMAN:-}" ] || return 0
    mine=$(jq -r '(.autopilot.prs // {}) | keys[]' "$sf" 2>/dev/null) || return 0
    [ -n "$mine" ] || return 0
    pages=$(open_snapshot pulls) || return 0
    # 已关闭 / 已合并的 PR 不再需要记录：记录清空后这里就不再读 GitHub
    if open_nums=$(printf '%s' "$pages" | jq -c '[ .[][] | .number | tostring ]' 2>/dev/null); then
        tmp=$(mktemp)
        if jq --argjson open "$open_nums" \
            '.autopilot.prs = ((.autopilot.prs // {}) | with_entries(select(.key as $k | $open | index($k))))' \
            "$sf" > "$tmp" 2>/dev/null; then mv "$tmp" "$sf"; else rm -f "$tmp"; fi
    fi
    # 候选：本机有记录、开着的 PR 里，挂着等合并标签的，或者收尾做到一半的
    cands=$(printf '%s' "$pages" | jq -r --arg M "$m" --slurpfile st "$sf" '
        (($st[0].autopilot.prs) // {}) as $prs
        | .[][] | select($prs[(.number | tostring)] != null)
        | select(any(.labels[]?; .name == $M) or ($prs[(.number | tostring)] | has("off_handover")))
        | .number' 2>/dev/null) || return 0
    for pr in $cands; do
        if ! autopilot_fingerprint "$pr"; then log "托管已关：读不全 PR #$pr 的现状（$AF_WHY），下轮再收尾"; continue; fi
        rec=$(jq -c --arg p "$pr" '.autopilot.prs[$p].off_handover // null' "$sf" 2>/dev/null) || continue
        if [ "$rec" = null ]; then
            # 新的一件事：判定直接从这份指纹得出（开着、挂着等合并标签），它就是基准。先记待办，记不下本轮不碰 GitHub
            printf '%s' "$AF_FP" | jq -e --arg M "$m" '.pr.open and (.pr.labels | index($M) != null)' >/dev/null 2>&1 || continue
            autopilot_state_set "$sf" '.prs[$p] = ((.prs[$p] // {}) + {off_handover: {base: $f, expect: $f}})' --arg p "$pr" --argjson f "$AF_FP" \
                || { log "托管已关：PR #$pr 记不下收尾待办，本轮不动"; continue; }
        else
            exp=$(printf '%s' "$rec" | jq -cS '.expect? // empty' 2>/dev/null) || exp=""
            pend=$(printf '%s' "$rec" | jq -c '.pending? // empty' 2>/dev/null) || pend=""
            if [ -n "$exp" ] && [ "$AF_FP" = "$exp" ]; then
                :
            elif [ -n "$exp" ] && [ -n "$pend" ] \
                 && autopilot_fp_is_own_write "$exp" "$(printf '%s' "$pend" | jq -r '.op')" "$(printf '%s' "$pend" | jq -r '.label')"; then
                # 上次那一步写成了、没来得及记
                autopilot_state_set "$sf" '.prs[$p].off_handover |= ((.expect = $e) | del(.pending))' --arg p "$pr" --argjson e "$AF_FP" \
                    || { log "托管已关：PR #$pr 记不下已确认的写入，本轮不动"; continue; }
            else
                autopilot_state_set "$sf" '.prs[$p] |= del(.off_handover)' --arg p "$pr" || true
                log "托管已关：PR #$pr 的现状和收尾做到一半时不一样了（有人动过），收尾待办作废，本轮不再写"
                continue
            fi
        fi
        # 标签收敛到目标：先加 pending/human，再摘等合并标签（每一步都以 expect 为准）
        exp=$(jq -c --arg p "$pr" '.autopilot.prs[$p].off_handover.expect' "$sf" 2>/dev/null) || continue
        if printf '%s' "$exp" | jq -e --arg H "$LABEL_PENDING_HUMAN" '.pr.labels | index($H) == null' >/dev/null 2>&1; then
            autopilot_off_write "$sf" "$pr" labeled "$LABEL_PENDING_HUMAN" || continue
        fi
        exp=$(jq -c --arg p "$pr" '.autopilot.prs[$p].off_handover.expect' "$sf" 2>/dev/null) || continue
        if printf '%s' "$exp" | jq -e --arg M "$m" '.pr.labels | index($M) != null' >/dev/null 2>&1; then
            autopilot_off_write "$sf" "$pr" unlabeled "$m" || continue
        fi
        exp=$(jq -cS --arg p "$pr" '.autopilot.prs[$p].off_handover.expect' "$sf" 2>/dev/null) || continue
        printf '%s' "$exp" | jq -e --arg M "$m" --arg H "$LABEL_PENDING_HUMAN" \
            '.pr.open and (.pr.labels | index($M) == null) and (.pr.labels | index($H) != null)' >/dev/null 2>&1 || continue
        # 交人说明只发一条：已经有了（上一轮发出去、只是待办没清）就不再发。认本次入队（基准里的排队编号）
        q=$(jq -r --arg p "$pr" '.autopilot.prs[$p].off_handover.base.pr.q // ""' "$sf" 2>/dev/null) || q=""
        marker="<!-- cavil-loop:autopilot-off pr=$pr q=$q -->"
        if ! cmts=$(gh api --paginate --slurp "repos/$REPO/issues/$pr/comments" 2>/dev/null) || [ -z "$cmts" ] \
           || ! printf '%s' "$cmts" | jq -e 'type == "array"' >/dev/null 2>&1; then
            log "托管已关：PR #$pr 评论读不到，下轮再发说明"; continue
        fi
        if ! printf '%s' "$cmts" | jq -e --arg T "$marker" 'any(.[][]?; (.body // "") | contains($T))' >/dev/null 2>&1; then
            if ! autopilot_fp_expect "$exp" "$pr"; then
                log "托管已关：PR #$pr 发说明之前现状有变化（$AF_WHY），本轮不写"; continue
            fi
            run_gh "托管已关：PR #$pr 交人说明" gh_write api -X POST "repos/$REPO/issues/$pr/comments" \
                -f "body=$(printf '⚠️ **托管已关掉，这个 PR 不再自动合并（`%s`）**\n\n**原因**：托管已在配置里关掉。这个 PR 是托管开着时复审通过、挂着 `%s` 等合并的，现在交给人。\n\n**怎么继续**：自己审、自己合并；或者重新打开托管后，把标签改成 `%s` 重新复审。\n\n%s\n%s\n%s' \
                    "$LABEL_PENDING_HUMAN" "$m" "${LABEL_PENDING_REVIEW:-pending/review}" "$(autopilot_daemon_sig)" "$AUTOPILOT_OFF_TAG" "$marker")" \
                || { log "托管已关：PR #$pr 交人说明没发出去，下轮补发"; continue; }
            AUTOPILOT_ACTED=1
            log "托管已关：PR #$pr 不再等自动合并 → $LABEL_PENDING_HUMAN"
        fi
        # 最终状态都确认了才删待办（删不掉：下一轮看到说明已在，只删待办、不重复发）
        autopilot_state_set "$sf" '.prs[$p] |= del(.off_handover)' --arg p "$pr" || true
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

    # 旧版本 / 新 issue 派工起的 session 没有 worker 窗格记录：只有一个窗格时它就是 worker，补记上。
    # 不止一个窗格、或读不到时不猜（见 worker_pane_lookup）。
    local st only
    read -r st only _ <<<"$(worker_pane_lookup "$sess")"
    if [ "$st" = single ]; then
        worker_pane_record "$sess" "$only" || true
    fi

    if [ -n "$desc" ] && ! tmux set-option -t "$sess" @desc "$desc" 2>&1 | \
        sed 's/^/  [tmux] /' | redact_pipe | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 设置 tmux session $sess 的 @desc 失败（worker 继续运行）"
    fi

    if ! tmux set-option -t "$sess" @worker_model "$WORKER_MODEL" 2>&1 | \
        sed 's/^/  [tmux] /' | redact_pipe | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 设置 tmux session $sess 的 @worker_model 失败（worker 继续运行）"
    fi

    if ! tmux set-option -t "$sess" @worker_agent "$WORKER_AGENT" 2>&1 | \
        sed 's/^/  [tmux] /' | redact_pipe | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 设置 tmux session $sess 的 @worker_agent 失败（worker 继续运行）"
    fi

    if ! tmux set-option -t "$sess" @worker_role "$WORKER_SESSION_ROLE" 2>&1 | \
        sed 's/^/  [tmux] /' | redact_pipe | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 设置 tmux session $sess 的 @worker_role 失败（worker 继续运行）"
    fi

    if ! tmux bind-key -T prefix s choose-tree -Zs -F "$tree_format" 2>&1 | \
        sed 's/^/  [tmux] /' | redact_pipe | tee -a "$LOG_FILE" >&2; then
        log "  ⚠️ 配置 tmux prefix+s session 列表失败（worker 继续运行）"
    fi
}

# ── worker 所在的窗格（GitHub#197）──
#
# 人会在 worker 的 session 里自己分屏、开窗口（`split-window -b` 会把新窗格排在 worker
# 前面），所以「第一个窗格」「当前窗格」都不能当 worker——按排列顺序认领，换程序时就会
# 杀掉人的程序、留下旧 worker（PR #219 复审第 1 轮实测）。
#
# 唯一可靠的身份是 tmux 的 pane id（%N）：在一个 tmux server 里单调递增、不复用，
# respawn-pane 换程序时也不变。daemon 每次建出 worker 窗格时就把它记在 session 选项
# @worker_pane 上；读的时候再核对这个窗格仍在、仍属于这个 session。
#
# 本功能上线前起的 session 没有记录：只有一个窗格时它必然是 worker（configure_tmux_session_display
# 会顺手补记）；有多个窗格时**不猜**。
#
# **读不到不等于没有**（PR #219 复审第 2 轮）：这里的结论会被拿去杀进程、重建 session、
# 另起 worker、改记录，所以每一次 tmux 读取都核对退出码和输出形状，任何一步没读成就是
# unknown——调用方遇到 unknown 一律什么都不动，留给下一轮。只有成功读到的完整窗格清单
# 里确实没有记录的窗格，才算「记录的窗格已不在」。

worker_pane_record() {   # <tmux_session> <pane id>
    [ -n "$2" ] || return 1
    tmux set-option -t "=$1:" @worker_pane "$2" 2>/dev/null
}

# 一次读全 worker 窗格的状态。输出一行「状态 窗格 进程号 已结束 日志管道」，状态是：
#   found  <id> <pid> <dead> <pipe>  记录的窗格在、属于这个 session
#   single <id> <pid> <dead> <pipe>  没有记录，session 只有一个窗格（就是 worker）
#   gone   <记录的 id>        有记录，且成功读到的窗格清单里确实没有它
#   multi                     没有记录，又不止一个窗格：认不出
#   unknown                   任何一次读取失败或输出不成形
# 两次读取：@worker_pane 选项（未设置时 -q 返回 0 且输出空，失败才非 0）和整个 session 的
# 窗格清单（一次 list-panes 同时拿 id / pid / 是否已结束 / 是否已挂日志管道）。
worker_pane_lookup() {   # <tmux_session>
    local sess="$1" rec panes line id pid dead pipe n=0 hit=""
    if ! rec="$(tmux show-options -qv -t "=$sess:" @worker_pane 2>/dev/null)"; then
        echo unknown; return 0
    fi
    if [ -n "$rec" ] && ! [[ "$rec" =~ ^%[0-9]+$ ]]; then
        echo unknown; return 0
    fi
    if ! panes="$(tmux list-panes -s -t "=$sess:" -F '#{pane_id} #{pane_pid} #{pane_dead} #{pane_pipe}' 2>/dev/null)"; then
        echo unknown; return 0
    fi
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        read -r id pid dead pipe <<<"$line"
        if ! [[ "$id" =~ ^%[0-9]+$ && "$pid" =~ ^[0-9]+$ && "$dead" =~ ^[01]$ && "$pipe" =~ ^[01]$ ]]; then
            echo unknown; return 0
        fi
        n=$((n + 1))
        if [ -n "$rec" ] && [ "$id" = "$rec" ]; then hit="$id $pid $dead $pipe"; fi
        [ -z "$rec" ] && [ "$n" -eq 1 ] && hit="$id $pid $dead $pipe"
    done <<<"$panes"
    if [ "$n" -eq 0 ]; then echo unknown; return 0; fi
    if [ -n "$rec" ]; then
        if [ -n "$hit" ]; then echo "found $hit"; else echo "gone $rec"; fi
    elif [ "$n" -eq 1 ]; then
        echo "single $hit"
    else
        echo multi
    fi
}

# worker 窗格的 id（found / single 时），否则返回 1。只给「找到了才做事」的调用方用。
worker_pane_id() {   # <tmux_session>
    local st id
    read -r st id _ <<<"$(worker_pane_lookup "$1")"
    case "$st" in found|single) printf '%s\n' "$id" ;; *) return 1 ;; esac
}

# worker 窗格里的程序还在不在。人另开的窗格让 session 一直活着，所以派工判断「刚起的程序
# 有没有秒退」要看 worker 窗格本身，不能只看 session 在不在。
#   返回 0 = 活着；1 = 确定已经不在；2 = 读不到，不知道
# 「确定不在」只认三种成功读到的证据：完整的 session 清单里没有它、完整的窗格清单里没有
# 记录的窗格、窗格明确标着已结束。has-session 不行：查询失败和「没有」都是非 0。
# 调用方只在 1 时才去重起 / 退休会话记录；2 一律什么都不动（PR #219 复审第 3 轮）。
worker_session_exists() {   # <tmux_session> → 0 在 / 1 确定不在 / 2 读不到
    local list err
    err="$(mktemp)"
    if list="$(tmux list-sessions -F '#{session_name}' 2>"$err")"; then
        rm -f "$err"
        grep -qxF -- "$1" <<<"$list" && return 0
        return 1
    fi
    # 只认 tmux 自己说的「没有 server」（最后一个 session 退出后 server 就退出了）：
    # 那时 session 当然不在。其余失败一律读不到。两种原文实测于 tmux 3.4。
    if grep -qE '^(no server running on |error connecting to .*\(No such file or directory\))' "$err"; then
        rm -f "$err"; return 1
    fi
    rm -f "$err"
    return 2
}

worker_alive() {   # <tmux_session>
    local st id pid dead e
    worker_session_exists "$1"; e=$?
    [ "$e" = 0 ] || return "$e"
    read -r st id pid dead _ <<<"$(worker_pane_lookup "$1")"
    case "$st" in
        gone) return 1 ;;
        found|single)
            [ "$dead" = 1 ] && return 1
            return 0 ;;
        multi) return 0 ;;      # 认不出 worker：按原来的判据，session 在就算活着
        *) return 2 ;;
    esac
}

# 在 worker session 里起一条命令（GitHub#197）。
#
# - session 不在：照旧 `tmux new-session -d`，记下新窗格。
# - session 在、认得出 worker 窗格（换 agent / 模型 / 角色、注入失败、续接秒退后降级）：
#   **不删 session**，在这个窗格里换程序。删 session 会把 attach 在上面的终端一起踢出
#   tmux——换去复审的那一刻正是人最想盯着看的时候。步骤：
#     1. 窗格设 remain-on-exit on，旧程序退出后窗格留在原地（否则唯一的窗格一关 session 就没了）
#     2. 按进程组 TERM → 等 → KILL 旧程序（kill_pane_pids；只发 SIGHUP 的话 claude 会变孤儿）
#     3. respawn-pane 在同一窗格起新命令，环境参数、工作目录和 new-session 用同一份
#     4. remain-on-exit 关回去：之后程序自然退出，窗格照旧消失，
#        「session 不在 == worker 死了」这条 self-heal 依赖的语义不变
#     5. 新程序在第 4 步之前就已经退出（窗格停在「已结束」）：关掉这个窗格，等价于
#        new-session 起的程序秒退
#   会话日志的 pipe-pane 挂在窗格上，换程序不断，接着写同一份文件。
# - session 在、记录的 worker 窗格已经不在了（worker 退出，人另开的窗格撑着 session）：
#   在这个 session 里新开一个窗口起 worker 并记下，人的窗格一个不动。
# - session 在、从没记录过、又不止一个窗格（本功能上线前起的、被人分过屏的 session）：
#   认不出哪个是 worker，不猜——按进程组停掉 session 里全部程序再删掉重建。这会像以前一样
#   踢出 attach 的终端，但不会杀错一个、留下另一个；只发生一次，之后的 session 都有记录。
# - 任何一次读取失败（unknown）：什么都不动，返回 1。
#
# 返回非 0：读不到窗格状态，或 tmux 命令本身失败。程序是否起得来由调用方用 worker_alive 判断。
worker_session_launch() {   # <tmux_session> <cwd> <command> [tmux -e 参数…]
    local sess="$1" cwd="$2" cmd="$3" st pane pid dead i
    shift 3
    if ! session_alive "$sess"; then
        pane="$(tmux new-session -d -P -F '#{pane_id}' -s "$sess" "$@" -c "$cwd" "$cmd")" || return 1
        worker_pane_record "$sess" "$pane" || true
        return 0
    fi
    read -r st pane pid dead _ <<<"$(worker_pane_lookup "$sess")"
    case "$st" in
        found|single) ;;
        gone)
            log "  $sess 里记录的 worker 窗格 $pane 已不在（session 由别的窗格撑着）：新开窗口起 worker"
            pane="$(tmux new-window -d -P -F '#{pane_id}' -t "=$sess:" "$@" -c "$cwd" "$cmd")" || return 1
            worker_pane_record "$sess" "$pane" || true
            return 0 ;;
        multi)
            log "  ⚠️ $sess 有多个窗格且没有 worker 窗格记录（旧版本起的 session），认不出 worker：停掉全部程序后重建 session"
            kill_session_procs "$sess"
            tmux kill-session -t "=$sess" 2>/dev/null || true
            pane="$(tmux new-session -d -P -F '#{pane_id}' -s "$sess" "$@" -c "$cwd" "$cmd")" || return 1
            worker_pane_record "$sess" "$pane" || true
            return 0 ;;
        *)
            # 读不到 = 不知道哪个是 worker、它还在不在：不杀、不起、不改记录，本次派工失败，
            # 下一轮再判（调用方开着 set -e，非 0 让派工脚本在翻标签之前就退出）
            log "  ❌ $sess 的 worker 窗格状态读不到（tmux 查询失败），本轮不换程序、不动任何窗格"
            return 1 ;;
    esac
    tmux set-option -w -t "$pane" remain-on-exit on 2>/dev/null || true
    if [ "$dead" != 1 ]; then
        kill_pane_pids "$pid"
        # 进程没了到 tmux 把窗格标成「已结束」之间有一点延迟
        for ((i = 0; i < 20; i++)); do
            [ "$(tmux display-message -p -t "$pane" '#{pane_dead}' 2>/dev/null)" = 1 ] && break
            sleep 0.1
        done
    fi
    # -k：上面没等到「已结束」时兜底（此时旧进程已被 KILL，-k 只是让 tmux 放手）
    if ! tmux respawn-pane -k -t "$pane" "$@" -c "$cwd" "$cmd"; then
        tmux set-option -w -t "$pane" remain-on-exit off 2>/dev/null || true
        return 1
    fi
    worker_pane_record "$sess" "$pane" || true
    tmux set-option -w -t "$pane" remain-on-exit off 2>/dev/null || true
    if [ "$(tmux display-message -p -t "$pane" '#{pane_dead}' 2>/dev/null)" = 1 ]; then
        tmux kill-pane -t "$pane" 2>/dev/null || true
    fi
    return 0
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
tmux_session_matches_worker() {   # 返回 0 一致 / 1 不一致 / 2 读不到
    local sess="$1"
    local actual_agent actual_model actual_role
    # 读不到 ≠ 没设：没设时 -q 返回 0、输出空（老 session 走默认）；查询失败才非 0。
    # 读不到时既不能当「一致」（会把 prompt 注入给别的角色），也不能当「不一致」（会停掉正在
    # 干活的 worker 换程序）——返回 2，调用方本轮什么都不做（PR #219 复审第 3 轮）。
    actual_agent="$(tmux show-options -qv -t "=$sess:" @worker_agent 2>/dev/null)" || return 2
    actual_model="$(tmux show-options -qv -t "=$sess:" @worker_model 2>/dev/null)" || return 2
    actual_role="$(tmux show-options -qv -t "=$sess:" @worker_role 2>/dev/null)" || return 2
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

# 在 worker 窗格上开 pipe-pane，把 pane 输出 append 到日志文件。
# session 退出时 cat 见 EOF 自然结束。调用方在 `tmux new-session -d` 之后（或重新注入之前）调用。
#
# ⚠️ 绝不用 `pipe-pane -o`：它是开关，已有 pipe 时会把它关掉、且不再开新的（tmux 手册
# 「allowing a pipe to be toggled」，tmux 3.4 实测）。注入、原地换程序（GitHub#197）都会
# 对活着的 session 再调这里，一次误判就把日志关了。不带 -o 时，已有 pipe 会被换成指向同一
# 文件的新 pipe，日志继续写（实测）——所以就算状态读错，最坏也只是重开一次，不会关掉。
# 状态（是否已开）从 worker_pane_lookup 那一次窗格清单里拿：成功读到「已开」→ 什么都不做；
# 成功读到「没开」→ 开；读不到 / 认不出 worker 窗格 → 不碰，记一行日志，下次调用再判
# （PR #219 复审第 3 轮：读不到曾被当成「没开」，接着 -o 把已开的日志关掉）。
start_session_logging() {
    local sess="$1"
    local log_path st tgt pid dead pipe
    log_path="$(session_log_path "$sess")"
    [ -z "$log_path" ] && return 0
    mkdir -p "$(dirname "$log_path")"
    {
        printf '\n===== %s session=%s opened =====\n' \
            "$(date -Iseconds)" "$sess"
    } >> "$log_path"   # redact-ok：固定文字 + 会话名
    # 日志挂在 worker 窗格上：人分屏后「当前窗格」可能是人的那个
    read -r st tgt pid dead pipe <<<"$(worker_pane_lookup "$sess")"
    case "$st" in
        found|single) ;;
        *)
            log "  ⚠️ 认不出 $sess 的 worker 窗格（或读不到，状态 $st），本次不碰会话日志"
            return 0 ;;
    esac
    session_log_pipe_ensure "$sess" "$tgt" "$pipe" "$log_path" || \
        log "  ⚠️ pipe-pane 失败：$sess → $log_path（session 可能已秒退）"
}

# 让 worker 窗格的日志管道是「带令牌过滤」的那种（GitHub#342）。返回 1 = 没挂上。
#   已经挂着、会话上有 @redact_pipe 标记 → 什么都不做
#   挂着但没有标记 = 升级前用 `cat` 挂的 → 换成过滤版（不带 -o 再挂一次是直接替换，不会关掉）
#   没挂 → 挂上
# 标记读不到时不换（下次再判）：读不到不等于没有。
session_log_pipe_ensure() {   # <tmux_session> <worker 窗格> <已挂=1> <日志路径>
    local sess="$1" tgt="$2" pipe="$3" log_path="$4" mark pipe_cmd
    if [ "$pipe" = 1 ]; then
        mark="$(tmux show-options -qv -t "=$sess:" @redact_pipe 2>/dev/null)" || return 0
        [ "$mark" = 1 ] && return 0
    fi
    pipe_cmd="$(redact_pane_pipe_cmd "$log_path")"
    # pipe-pane 偶发失败几乎都是 `tmux new-session -d` 刚返回、pane 尚未就绪的 race，
    # 或 worker 进程已秒退 session 没了。先重试一次（0.3s 后），仍失败才报警——
    # 报警此时基本等价于"worker 启动即死"（详见 verify_fresh_session 的 capture）。
    if ! tmux pipe-pane -t "$tgt" "$pipe_cmd" 2>/dev/null; then
        sleep 0.3
        tmux pipe-pane -t "$tgt" "$pipe_cmd" 2>/dev/null || return 1
    fi
    tmux set-option -t "=$sess:" @redact_pipe 1 2>/dev/null || true
    return 0
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
        } | redact_pipe | tee -a "${log_path:-/dev/null}" | tail -25 | sed 's/^/      /' | tee -a "$LOG_FILE" >&2
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

**影响范围**：派工 prompt 本身**不受影响** —— find_project_prompt_file 把 \`origin/$base\` 当唯一真值直读远端，主 checkout 再旧也拿得到最新模板（GigleTutor-Web#516 的结构性修复）。真正受影响的是：人在主 checkout 上手工看到的代码是旧的，以及任何直接读工作区文件的流程（如常驻「最新站」刷新）。

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

# ── 配置缺新功能的设置：提示维护者（GitHub#289）──
# 自动升级把新代码带到老项目，却不改项目的配置。「不写就关」而模板里开着的新功能（登记成
# notice 的项，见 scripts/config-notices.txt）在老项目上就一直关着，没有任何信号——维护者以为
# 早已生效（arkknights-tool#38：等前置标签）。这里每轮做一次纯本地比对（CONFIG_NOTICE_UNSET，
# 在 source 配置之后立刻记下），缺项集合变了才对外动作：
#   · 新出现的缺项 → 写一行轮询日志（每项一次）
#   · CONFIG_NOTICE_ISSUE=true（默认）时：没有开着的提示 issue → 开一条挂 pending/human 的
#     （greedy 模式也靠它才不被派工）；已有开着的 → 在上面评论新增的；缺项全补上 → 关掉它；
#     人手动关掉 → 这一批不再提示，只有出现新缺项才开新的
# daemon 从不改配置。只在调度器经 poll-entry.sh 起的轮询里运行（POLL_SCHEDULED=1，agent-poll.sh
# 开头从 poll-entry.sh 交来的 CAVIL_SCHEDULED_POLL 收下，并立刻 unset，worker 继承不到）：手动直接跑
# agent-poll.sh 做试跑、worker 会话里跑、以及直接起 agent-poll.sh 的测试都不该往仓库里开 issue。
# 不用 CODING_AGENT_RELEASE_ROOT 当判据：它是导出的，worker 会话里也有。
#
# 状态在 $STATE_DIR/config-notice.json（不进 state.json：删掉它只意味着「重新判断一次」，最坏
# 多开一条提示）：{"issue": <号|null>, "logged": [已写过日志的项], "issued": [已在 issue 里提示过的项]}。
# 读写规矩同其它 daemon 写入：写之前重读那条 issue（是否开着、是不是本功能开的、不是 PR），
# 读不到 / 写失败 → 本轮不写、不记，下一轮重来；从不把「读不到」当成「已关」。
CONFIG_NOTICE_ISSUE="${CONFIG_NOTICE_ISSUE:-true}"
CONFIG_NOTICE_MARKER='<!-- cavil-config-notice -->'

config_notice_state_file() { printf '%s\n' "$STATE_DIR/config-notice.json"; }

# 登记表里 KEY 那一行的第 n 个字段（去掉两侧空白）
config_notice_field() {   # <KEY> <n>
    local key="$1" n="$2" line
    line=$(grep -E "^[[:space:]]*$key[[:space:]]*\|" "$CONFIG_NOTICE_REGISTRY" 2>/dev/null | head -1) || return 0
    printf '%s' "$line" | awk -F'|' -v n="$n" '{ v = $n; sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); printf "%s", v }'
}

# 配置模板里 KEY 那一行原文（要开时照抄的那一行）；模板里找不到就输出空
config_notice_template_line() {   # <KEY>
    grep -m1 -E "^$1=" "$SKILL_DIR/cavil-loop.config.example" 2>/dev/null || true
}

# 一项缺项的说明（issue 正文和追加评论共用）
config_notice_item_md() {   # <序号> <KEY>
    local i="$1" key="$2" ref off text line
    ref=$(config_notice_field "$key" 3); off=$(config_notice_field "$key" 4); text=$(config_notice_field "$key" 5)
    line=$(config_notice_template_line "$key")
    printf '### %s. `%s`%s\n\n%s\n\n' "$i" "$key" "${ref:+（$ref）}" "$text"
    if [ -n "$line" ]; then
        printf '要开：在配置里加这一行（配置模板里的原文）\n\n```bash\n%s\n```\n\n' "$line"
    fi
    printf '不开：写成 `%s=%s`，daemon 就不再提示这一项。\n\n' "$key" "$off"
}

config_notice_log_line() {   # <KEY>
    local key="$1" line
    line=$(config_notice_template_line "$key")
    log "⚠️ 配置提示：本项目配置里没有 $key，这个新功能现在是关着的（$(config_notice_field "$key" 3)）。要开就在 $CONFIG_FILE 里加 ${line:-$key=...}；不开就写 $key=$(config_notice_field "$key" 4)"
}

config_notice_issue_body() {   # <KEY>...
    local n=$# i=0 key
    printf '%s\n## 本项目配置里缺 %s 项新功能的设置\n\n' "$CONFIG_NOTICE_MARKER" "$n"
    printf 'cavil-loop 自动升级带来了新功能，但本项目的配置文件（`%s`，在 daemon 所在的机器 `%s` 上）里没有对应的行，下面这些功能现在是**关着**的。新装的项目从配置模板拷配置，这些功能默认是开的。\n\n' \
        "$CONFIG_FILE" "$(hostname -s 2>/dev/null || hostname)"
    printf '**要人做的事**：逐项决定开或不开，把对应的那一行写进配置文件（开：照抄下面的行；不开：写成空值）。daemon 只提示、不改配置；下一轮轮询发现每一项都写进去了，会自动关闭这条 issue。不想处理也可以直接关掉，同一批缺项不会再提示。\n\n'
    for key in "$@"; do
        i=$((i + 1))
        config_notice_item_md "$i" "$key"
    done
    printf -- '---\n这条 issue 由 daemon 自动开。不想再收到这类提示：在配置里写 `CONFIG_NOTICE_ISSUE=false`（之后只写轮询日志）。\n'
}

# 重读提示 issue，判定能不能动它（评论 / 关闭之前各读一次，L41）。输出：
#   ours     开着、正文带本功能标记、不是 PR，且标签正好是 daemon 开它时挂的那个保护标签
#            （pending/human 在、没有任何别的流程标签）——只有这时才可以评论或关闭
#   closed   已关（人手动关掉）
#   foreign  不是本功能开的 issue，或是 PR
#   handed   开着，但保护标签被摘、或挂上了别的流程标签（人把它转进了别的流程，如派给 worker）
# 读不到、字段缺失、状态词不认识 → 返回 1（未知：本轮不写、不记）。
config_notice_issue_state() {   # <号>
    local out st pr mk labels flow l
    out=$(run_gh_capture "读配置提示 issue #$1" gh api "repos/$REPO/issues/$1" \
        --jq "[.state // \"\", (.pull_request != null | tostring), ((.body // \"\") | contains(\"$CONFIG_NOTICE_MARKER\") | tostring), (if (.labels | type) == \"array\" then ([.labels[].name] | join(\"\\n\")) + \"\\n\" | @base64 else \"-\" end)] | join(\" \")") \
        || return 1
    read -r st pr mk labels <<<"$out"
    case "$pr/$mk" in true/*|false/false) printf 'foreign\n'; return 0 ;; false/true) ;; *) return 1 ;; esac
    case "$st" in open) ;; closed) printf 'closed\n'; return 0 ;; *) return 1 ;; esac
    [ -n "$labels" ] && [ "$labels" != - ] || return 1
    labels=$(printf '%s' "$labels" | base64 -d 2>/dev/null) || return 1
    printf '%s\n' "$labels" | grep -qxF -- "${LABEL_PENDING_HUMAN:-pending/human}" || { printf 'handed\n'; return 0; }
    flow=$({ closed_done_flow_labels; printf '%s\n' "${LABEL_DONE:-}"; } | grep -vxF -- "${LABEL_PENDING_HUMAN:-pending/human}" | awk 'NF')
    while IFS= read -r l; do
        [ -n "$l" ] || continue
        if printf '%s\n' "$flow" | grep -qxF -- "$l"; then printf 'handed\n'; return 0; fi
    done <<<"$labels"
    printf 'ours\n'
}

config_notice_tick() {
    [ "${POLL_SCHEDULED:-}" = 1 ] || return 0
    local f missing st issue logged issued new_log new_iss k state num body changed=0
    f=$(config_notice_state_file)
    missing=$(printf '%s\n' $CONFIG_NOTICE_UNSET | jq -Rsc 'split("\n") | map(select(. != "")) | unique')
    if [ -f "$f" ]; then
        if ! st=$(jq -ce 'if type == "object" then . else error("bad") end' "$f" 2>/dev/null); then
            log "⚠️ 配置提示：$f 读不懂，按全新状态重来（最坏多开一条提示 issue）"
            st='{}'; changed=1
        fi
    else
        [ "$missing" = '[]' ] && return 0
        st='{}'; changed=1
    fi
    issue=$(jq -r '.issue // empty | tostring' <<<"$st")
    case "$issue" in ''|*[!0-9]*) issue="" ;; esac
    # 补上又去掉的项要能再提示一次：已提示记录只保留仍然缺的
    logged=$(jq -c --argjson m "$missing" '[(.logged // [])[] | select(. as $k | $m | index($k))] | unique' <<<"$st")
    issued=$(jq -c --argjson m "$missing" '[(.issued // [])[] | select(. as $k | $m | index($k))] | unique' <<<"$st")
    [ "$logged" = "$(jq -c '(.logged // []) | unique' <<<"$st")" ] || changed=1
    [ "$issued" = "$(jq -c '(.issued // []) | unique' <<<"$st")" ] || changed=1

    new_log=$(jq -r --argjson l "$logged" '.[] | select(. as $k | $l | index($k) | not)' <<<"$missing")
    for k in $new_log; do config_notice_log_line "$k"; done
    if [ -n "$new_log" ]; then logged="$missing"; changed=1; fi

    if [ "${CONFIG_NOTICE_ISSUE}" = true ]; then
        new_iss=$(jq -r --argjson l "$issued" '.[] | select(. as $k | $l | index($k) | not)' <<<"$missing")
        if [ -n "$issue" ] && { [ "$missing" = '[]' ] || [ -n "$new_iss" ]; }; then
            if ! state=$(config_notice_issue_state "$issue"); then
                state=unknown
            fi
            case "$state" in
                ours)
                    if [ "$missing" = '[]' ]; then
                        if run_gh "关闭配置提示 issue #$issue" gh_write api -X PATCH "repos/$REPO/issues/$issue" \
                                -f state=closed -f state_reason=completed; then
                            log "配置提示：缺的设置都已写进配置，关闭提示 issue #$issue"
                            issue=""; changed=1
                        fi
                    else
                        local i=0 add=""
                        for k in $new_iss; do i=$((i + 1)); add="$add$(config_notice_item_md "$i" "$k")"$'\n'; done
                        body="$CONFIG_NOTICE_MARKER"$'\n'"## 配置里又多了 $i 项新功能的设置没写"$'\n\n'"做法和上面一样：逐项写进配置文件 \`$CONFIG_FILE\`（开或写成空值），每一项都写进去后 daemon 自动关闭这条 issue。"$'\n\n'"$add"
                        if run_gh "在配置提示 issue #$issue 上追加新缺项" gh_write api -X POST \
                                "repos/$REPO/issues/$issue/comments" -f "body=$body"; then
                            log "配置提示：在提示 issue #$issue 上追加了 $(printf '%s ' $new_iss)"
                            issued="$missing"; new_iss=""; changed=1
                        fi
                    fi
                    ;;
                closed|foreign|handed)
                    # 人已经关掉、这个号已不是本功能的 issue、或人把它转进了别的流程：不评论、不关闭，
                    # 从此不再跟踪它（否则每轮都要重读）。仍有新缺项时下面开一条新的
                    [ "$state" = handed ] && log "配置提示：提示 issue #$issue 已被转进别的流程（保护标签变了），不再碰它"
                    issue=""; changed=1
                    ;;
                *)  # 读不到：什么都不写、不记，下一轮再看
                    new_iss=""
                    ;;
            esac
        fi
        if [ -z "$issue" ] && [ -n "$new_iss" ]; then
            # shellcheck disable=SC2046
            body=$(config_notice_issue_body $(jq -r '.[]' <<<"$missing"))
            num=$(run_gh_capture "开配置提示 issue" gh_write api -X POST "repos/$REPO/issues" \
                -f "title=[daemon] 本项目配置缺 $(jq 'length' <<<"$missing") 项新功能的设置" \
                -f "body=$body" -f "labels[]=${LABEL_PENDING_HUMAN:-pending/human}" --jq '.number') || num=""
            case "$num" in
                ''|*[!0-9]*) ;;
                *) issue="$num"; issued="$missing"; changed=1
                   log "配置提示：本项目配置缺 $(jq -r 'join(" ")' <<<"$missing")，已开提示 issue #$num" ;;
            esac
        fi
    fi

    [ "$changed" = 1 ] || return 0
    jq -n --arg i "$issue" --argjson l "$logged" --argjson s "$issued" \
        '{issue: (if $i == "" then null else ($i | tonumber) end), logged: $l, issued: $s}' > "$f.tmp" \
        && mv "$f.tmp" "$f"
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
        check_checkout_staleness "$base" "主 checkout 有未提交改动（daemon 不碰人的工作区）"
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
    # GitHub#238：先汇报时，交维护者合并前先发一条合并说明。不先汇报时什么都不加，上面就是原样输出
    if requester_bot_report_first; then
        f="$SKILL_DIR/prompts/requester-bot-merge-note.md"
        if [ -s "$f" ]; then
            text="$(cat "$f")"
            text="${text//@@LABEL_PENDING_HUMAN@@/"$LABEL_PENDING_HUMAN"}"
            printf '\n%s\n' "$text"
        else
            log "⚠️ 外部需求机器人合并说明规则文件缺失：$f" 2>/dev/null || true
        fi
    fi
    # GitHub#133：开关打开时，再追加「维护者自己的条目」一段；关着时上面就是全部输出，逐字节不变
    requester_bot_wake_any_item || return 0
    f="$SKILL_DIR/prompts/requester-bot-handoff-any-item.md"
    [ -s "$f" ] || { log "⚠️ 外部需求机器人交接规则（非机器人条目）文件缺失：$f" 2>/dev/null || true; return 0; }
    text="$(cat "$f")"
    text="${text//@@LABEL_PENDING_HUMAN@@/"$LABEL_PENDING_HUMAN"}"
    text="${text//@@LABEL_PENDING_REQUESTER_BOT@@/"$LABEL_PENDING_REQUESTER_BOT"}"
    text="${text//@@REQUESTER_BOT_ACCOUNT@@/"$REQUESTER_BOT_ACCOUNT"}"
    text="${text//@@REQUESTER_BOT_NOTIFY_CMD@@/"$cmd"}"
    printf '\n%s\n' "$text"
}

# 渲染「等前置规则」段（prompts/blocked-handoff.md，GitHub#157）。占位符同上用 @@NAME@@；段里的
# ${LABEL_PENDING_AGENT} 这类照常由 dispatch 的 sed 渲染（追加在模板末尾，一起过 sed）。
# 拆分子项「有前置 → 等人点」那条老规矩也在这里改掉，不改模板本身：功能关着时模板和拼装结果
# 逐字节不变；项目整份替换了模板，也照样收到这一段（后文覆盖前文）。
# 参数 sub-issue：给「本工具拆出来的子项」追加的那一小段（追加在子项说明之后，覆盖它的「前置还没合并 → 交人」）。
blocked_handoff_section() {   # [sub-issue]
    local f="$SKILL_DIR/prompts/blocked-handoff.md" text rule
    if [ "${1:-}" = sub-issue ]; then
        printf '# 等前置（本项目开启了等前置标签 `%s`）\n\n' "$LABEL_PENDING_BLOCKED"
        printf '上文「子项正文写了「前置：#X」而 #X 还没合并 → 翻 `%s`」那条改成：照「等前置规则」登记前置（标记里写 #X，`resume=${LABEL_PENDING_AGENT}`）、挂 `%s`（remove `%s`），停 idle；#X 合并后 daemon 会自动叫你回来开工。\n' \
            "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_BLOCKED" "$LABEL_AGENT_DOING"
        return 0
    fi
    [ -s "$f" ] || { log "⚠️ 等前置规则文件缺失：$f" 2>/dev/null || true; return 0; }
    text="$(cat "$f")"
    rule="## 拆分子项的起始标签（覆盖上文）

上文拆分步骤里「有前置 → 挂 \`${LABEL_PENDING_HUMAN}\`；前置合并后由人打 \`${LABEL_PENDING_AGENT}\`」改成：有前置的子项建好后，在子项上照上面「怎么挂」登记前置（标记里写前置子项的编号，\`resume=${LABEL_PENDING_AGENT_DEFAULT}\`），再挂 \`$LABEL_PENDING_BLOCKED\`；前置合并后 daemon 会自动把它翻成 \`${LABEL_PENDING_AGENT_DEFAULT}\` 开工。交人评论的子项表里，这类子项的「当前状态」写「等前置 #X 合并后自动开工」。没有前置的子项照旧直接打派工标签。"
    text="${text//@@LABEL_PENDING_BLOCKED@@/"$LABEL_PENDING_BLOCKED"}"
    text="${text//@@BLOCKED_SPLIT_RULE@@/"$rule"}"
    # 别的仓库的前置只认互通名单里的（GitHub#233 / #243）：把本项目的名单写进说明，worker 才知道该挂还是该交人
    local trusted
    trusted=$(blocked_trusted_json 2>/dev/null | jq -r 'map("`" + . + "`") | join("、")' 2>/dev/null) || trusted=""
    if [ -n "$trusted" ]; then
        trusted="daemon 只查本项目互通名单里的仓库：${trusted}；名单外的仓库 daemon 不查、会直接交人，等名单外的仓库照上文翻 \`${LABEL_PENDING_HUMAN}\`。名单里的这样写："
    else
        trusted="本项目没有配互通名单，daemon 不查任何别的仓库——等别的仓库的前置照上文翻 \`${LABEL_PENDING_HUMAN}\` 交人，下面这种写法只在配了名单之后才有用："
    fi
    text="${text//@@BLOCKED_TRUSTED_REPOS@@/"$trusted"}"
    printf '%s\n' "$text"
}

# 托管规则段（GitHub#114）：这次派工是托管条目才追加。agent-poll 判定后传 DISPATCH_AUTOPILOT=1 和
# 授权所在的 issue 编号（DISPATCH_AUTOPILOT_ISSUE）、授权打在哪一处（DISPATCH_AUTOPILOT_WHERE）；复审拿 autopilot-review.md，其余拿 autopilot-worker.md。
# 占位符同上用 @@NAME@@，由这里渲染完。
# 没绑 issue 的 PR（GitHub#142）：DISPATCH_AUTOPILOT_ISSUE 为空、DISPATCH_AUTOPILOT_PR = PR 编号，worker 拿
# autopilot-worker-pr.md（没有设计阶段、不改正文的关闭关键词和分支）
autopilot_section_active() {
    [ "${DISPATCH_AUTOPILOT:-}" = 1 ] && { [[ "${DISPATCH_AUTOPILOT_ISSUE:-}" =~ ^[0-9]+$ ]] || [[ "${DISPATCH_AUTOPILOT_PR:-}" =~ ^[0-9]+$ ]]; } && autopilot_enabled
}
autopilot_handoff_section() {   # <模板名>
    local f text pr_only=""
    [[ "${DISPATCH_AUTOPILOT_ISSUE:-}" =~ ^[0-9]+$ ]] || pr_only=1
    if [ "$1" = review ]; then f="$SKILL_DIR/prompts/autopilot-review.md"
    elif [ -n "$pr_only" ]; then f="$SKILL_DIR/prompts/autopilot-worker-pr.md"
    else f="$SKILL_DIR/prompts/autopilot-worker.md"; fi
    [ -s "$f" ] || { log "⚠️ 托管规则文件缺失：$f（本次按普通流程，不会自动合并）" 2>/dev/null || true; return 0; }
    text="$(cat "$f")"
    # 授权打在哪一处（GitHub#128：维护者也可以在 PR 上打）；没传就是 issue 上（没绑 issue 时是 PR 上）
    if [ -n "$pr_only" ]; then
        text="${text//@@AUTH_WHERE@@/"${DISPATCH_AUTOPILOT_WHERE:-PR #$DISPATCH_AUTOPILOT_PR}"}"
        text="${text//@@PR@@/"$DISPATCH_AUTOPILOT_PR"}"
    else
    text="${text//@@AUTH_WHERE@@/"${DISPATCH_AUTOPILOT_WHERE:-issue #$DISPATCH_AUTOPILOT_ISSUE}"}"
    text="${text//@@ISSUE@@/"$DISPATCH_AUTOPILOT_ISSUE"}"
    text="${text//@@BRANCH@@/"$(branch_name "$DISPATCH_AUTOPILOT_ISSUE")"}"
    fi
    text="${text//@@LABEL_AUTOPILOT@@/"$LABEL_AUTOPILOT"}"
    text="${text//@@LABEL_PENDING_MERGE@@/"$LABEL_PENDING_MERGE"}"
    text="${text//@@LABEL_PENDING_REVIEW@@/"$LABEL_PENDING_REVIEW"}"
    text="${text//@@LABEL_PENDING_HUMAN@@/"$LABEL_PENDING_HUMAN"}"
    text="${text//@@LABEL_PENDING_AGENT@@/"$LABEL_PENDING_AGENT_DEFAULT"}"
    text="${text//@@LABEL_AGENT_DOING@@/"$LABEL_AGENT_DOING"}"
    printf '%s\n' "$text"
}

# 「外部需求机器人提的需求 + 托管」合并规则段（GitHub#162，prompts/autopilot-requester-bot.md）：机器人
# 交接规则和托管规则两段都出现时才追加，放在两段之后。机器人的需求也能托管之后，两段对「方案通过后翻什么」
# 「代码通过后翻什么」说法相反，这一段把每条路径写清楚：提需求方的确认一步不省，托管只替掉交维护者那两步。
# 哪条是机器人提的需求，worker / 复审照交接规则判断（叫醒脚本再核对一遍）。只开其中一个功能时不出现，
# 那两种提示词与改动前逐字节一样。
autopilot_requester_bot_section() {
    local f="$SKILL_DIR/prompts/autopilot-requester-bot.md" text rule
    [ -s "$f" ] || { log "⚠️ 机器人需求 + 托管合并规则文件缺失：$f" 2>/dev/null || true; return 0; }
    text="$(cat "$f")"
    if requester_bot_report_first; then
        rule="本项目要求**先向机器人汇报结果**：

- **复审，代码通过、但 PR 上还没有提需求方对 PR 最新提交的认可**：不翻 \`$LABEL_PENDING_MERGE\`，**不写**托管规则里那行测试重跑的机器记录；先发通过评论（写明你审过的提交编号，给提需求方看），再照交接规则叫醒机器人汇报。
- **worker，机器人贴回的答复认可了当前提交**（照交接规则的「证据规则」核对：明确认可、被认可的那条汇报写的提交就是 PR 最新提交、没有被后来的评论作废）：**不交维护者**，交复审——翻 \`$LABEL_PENDING_REVIEW\`、摘 \`$LABEL_AGENT_DOING\`，评论里写明认可是哪条评论、认可的是哪个提交。答复要求修改 → 改完重新走复审、重新汇报；答复含糊 → 再问一次。
- **复审，PR 上已有提需求方对 PR 最新提交的认可**（同样照证据规则亲自核对，只认最新、没被作废的那条）：照托管规则「代码通过」处理——亲手重跑测试、翻 \`$LABEL_PENDING_MERGE\`、写机器记录，评论里写明认可是哪条评论。认可的不是最新提交、被作废了或含糊：不翻 \`$LABEL_PENDING_MERGE\`；代码没问题就叫醒机器人重新汇报最新提交。
- 认可之后又有新提交（比如维护者在 PR 上提了修改）：旧认可作废，改完重新复审、重新汇报。"
    else
        rule="本项目**不**要求先向机器人汇报结果：代码复审通过照托管规则翻 \`$LABEL_PENDING_MERGE\`，不叫醒机器人。合并后 daemon 照常告诉机器人「需求已完成」。"
    fi
    text="${text//@@REPORT_RULE@@/"$rule"}"
    text="${text//@@LABEL_PENDING_MERGE@@/"$LABEL_PENDING_MERGE"}"
    text="${text//@@LABEL_PENDING_REVIEW@@/"$LABEL_PENDING_REVIEW"}"
    text="${text//@@LABEL_PENDING_HUMAN@@/"$LABEL_PENDING_HUMAN"}"
    text="${text//@@LABEL_PENDING_AGENT@@/"$LABEL_PENDING_AGENT_DEFAULT"}"
    text="${text//@@LABEL_AGENT_DOING@@/"$LABEL_AGENT_DOING"}"
    printf '%s\n' "$text"
}

# 把经验文件拼进派工说明时用。两件事，规则都按行首认、不看内容：
# ① 可选的「## 目录经验」段（只在某块代码会踩的坑，GitHub#152）经项目自己的各层目录说明到达
#    agent，不进派工说明。从这一行切到下一个「## 」标题或文件末尾。
# ② 计次格式的经验文件（有 `<!-- next-id: N -->` 这一行，GitHub#208）只带要照做的部分：去掉整段
#    「## 观察中」，每条经验去掉「这样做是对的」举例和「Seen」出现记录；硬规则、待确认的编号 /
#    规则 / 适用 / 为什么都留着（自审和复审逐条核对要用）。末尾加一句说明完整版在哪。
#    没有这一行的文件（工具自带的通用经验、项目手写的自由文本）不做这一步：普通文本里恰好以
#    「- Seen」开头的行不能被误删。
# 切完再去掉切口留下的末尾空行。
# 换行按 python 读文本的规矩认（复盘程序就是这么读、这么判断有没有这一段的）：\r\n、单独的 \r
# 都算换行。否则 Windows 换行的文件 python 认出了这一段、这里却认不出，整段原样进了派工说明。
# 两件事都不用做的文件原样 cat、逐字节不变——awk 会给缺末尾换行的文件补一个，所以不能一律走 awk。
# 输出（按同样的换行规矩读回）与 scripts/retrospective_lessons.py:prompt_text 相同
# （tests/retrospective-directory-lessons.test.sh 用同一批输入对拍两边）。
LESSONS_PROMPT_NOTE='> 派工说明里只带上面这些：硬规则和待确认经验的编号、规则、适用、为什么。「观察中」的经验，以及每条的「这样做是对的」举例和 Seen 出现记录，只在本项目仓库的经验文件 `lessons.md` 里（项目 prompts 目录下），需要时自己去读。'
_lessons_lf() { sed 's/\r$//' "$1" | tr '\r' '\n'; }
lessons_for_prompt() {   # <经验文件>
    local counted=0
    # 进程替换而不是管道：grep -q 找到就退出，sed 可能吃 SIGPIPE，pipefail 下整条管道会算失败、判反
    if grep -qxE '<!-- next-id: [0-9]+ -->' < <(_lessons_lf "$1"); then
        counted=1
    elif ! grep -qx '## 目录经验' < <(_lessons_lf "$1"); then
        cat "$1"; return
    fi
    _lessons_lf "$1" | awk -v counted="$counted" -v note="$LESSONS_PROMPT_NOTE" '
         /^## / { sec = substr($0, 4); entry = 0
                  skip = (sec == "目录经验") || (counted && sec == "观察中") }
         skip { next }
         /^### L[0-9]+$/ { entry = 1 }
         counted && entry && /^- (这样做是对的：|Seen [0-9]+×:)/ { next }
         /^$/ { blank++; next }
         { while (blank > 0) { print ""; blank-- } print }
         END { if (counted) { print ""; print note } }'
}

# ── 同时在进行的其他工作（GitHub#340）──
# 派工时告诉 worker：此刻还有哪些条目在进行（doing / 待复审 / 已转 PR）、各自的分支已经改了哪些文件，
# 让文件重叠在开工时就被看见，而不是等交接时的冲突检查或对方合并之后。
#
#   · 只在派工那一刻读（三个 dispatch 脚本写完 prompt 之后调 concurrent_work_fill），轮询本身不多一次调用；
#     开关关着、prompt 里又没有占位符时什么都不读，拼出来的 prompt 逐字节不变。
#   · GitHub 调用数不随条目数增长：每个状态标签一次打开条目列表 + 一次打开 PR 列表（满 100 条才翻页），
#     轮询身份只读。文件清单不走 API：一次 ls-remote + 一次 fetch，本地 `git diff --name-only 基准...分支`。
#   · 比较基准：已有 PR → 那个 PR 的实际目标分支；没有 PR → 固定 CONCURRENT_WORK_DEFAULT_BASE（main）。
#     这是新 issue 入口建工作分支时传的固定值（dispatch-new-issue.sh 调 create-worktree.sh "$ISSUE" main），
#     不是配置里的 BASE_BRANCH——那一项只用于同步主 checkout。基准取不到就写「未能读取」，不退回别的分支。
#   · 「读不到」绝不写成「没有」：任何一次列表调用失败、形状不对 → 整段「未能读取」；ls-remote / fetch 失败 →
#     条目照列、每行「改动文件未能读取」；只有 ls-remote 成功且远端确实没有这个分支，才写「还没有推送改动」。
#   · 标题、文件名是别人写的数据：标题压成一行、去掉控制字符和反引号、截到 80 字；分支名只认安全字符，
#     不认的不拿去喂 git。清单在 dispatch 的 sed 全部跑完之后才填进去，里面的 ${...}、|、& 不会再被渲染。
#   · 任何失败都不挡派工。
ENABLE_CONCURRENT_WORK_HINT="${ENABLE_CONCURRENT_WORK_HINT:-}"
CONCURRENT_WORK_MAX_ITEMS=20
CONCURRENT_WORK_MAX_FILES=30
CONCURRENT_WORK_DEFAULT_BASE="main"
CONCURRENT_WORK_PLACEHOLDER='${CONCURRENT_WORK}'
CONCURRENT_WORK_UNREAD="未能读取当前进行中的其他工作（不代表没有）；交接前照常做冲突检查。"

concurrent_work_enabled() {
    case "$(printf '%s' "${ENABLE_CONCURRENT_WORK_HINT:-}" | tr '[:upper:]' '[:lower:]')" in
        true|1|yes|on) return 0 ;;
    esac
    return 1
}

# 这份模板要不要追加这一段：只给 worker 的三种派工（子项走 issue-comment 打底，也在内）；复审不加。
concurrent_work_section_active() {   # <模板名>
    concurrent_work_enabled || return 1
    case "$1" in new-issue|issue-comment|pr-comment) return 0 ;; esac
    return 1
}

concurrent_work_section() {
    local f="$SKILL_DIR/prompts/concurrent-work.md"
    [ -s "$f" ] || { log "⚠️ 同时进行的其他工作说明文件缺失：$f" 2>/dev/null || true; return 0; }
    cat "$f"
}

_concurrent_work_log_file() {   # <说明> <文件>
    local line
    log "  ⚠️ $1"
    while IFS= read -r line; do [ -n "$line" ] && log "    $line"; done < "$2"
    return 0
}

# 清单正文（不含标题和规则）。永远 return 0、永远有输出。
concurrent_work_text() {   # <本次工作分支> <本次工作编号>...
    local tmp
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/cavil-concurrent.XXXXXX" 2>/dev/null) || { printf '%s\n' "$CONCURRENT_WORK_UNREAD"; return 0; }
    # 先写进临时文件：中途失败时不把已经写出的半截清单和「未能读取」拼在一起
    if _concurrent_work_text_in "$tmp" "$@" > "$tmp/out" && [ -s "$tmp/out" ]; then cat "$tmp/out"
    else printf '%s\n' "$CONCURRENT_WORK_UNREAD"; fi
    rm -rf "$tmp"
    return 0
}

# 返回非 0 = 条目读不到（调用方输出「未能读取」）；这时自己不输出任何东西。
_concurrent_work_text_in() {   # <临时目录> <本次工作分支> <本次工作编号>...
    local tmp="$1" self_branch="$2"; shift 2
    local L enc self_json
    local -a wanted=("$LABEL_AGENT_DOING")
    [ -z "${LABEL_PENDING_REVIEW:-}" ] || wanted+=("$LABEL_PENDING_REVIEW")
    wanted+=("$LABEL_PENDING_PR")
    self_json=$(printf '%s\n' "$@" | jq -Rsc 'split("\n") | map(select(test("^[0-9]+$")) | tonumber)') || return 1

    # 1. 各状态标签下的打开条目（issue 和 PR 都在 issues 接口里）
    : > "$tmp/issues"
    for L in "${wanted[@]}"; do
        [ -n "$L" ] || continue
        enc=$(printf '%s' "$L" | jq -sRr @uri) || return 1
        if ! gh api --paginate "repos/$REPO/issues?state=open&labels=$enc&per_page=100" \
                --jq '.[] | {number, title, pr: (.pull_request != null), labels: [.labels[]?.name]}' \
                >> "$tmp/issues" 2> "$tmp/err"; then
            _concurrent_work_log_file "同时进行的其他工作：读取带 $L 标签的条目失败，本次写「未能读取」" "$tmp/err"
            return 1
        fi
    done
    # 2. 打开的 PR：工作分支、目标分支、是不是本仓库的分支
    if ! gh api --paginate "repos/$REPO/pulls?state=open&per_page=100" \
            --jq '.[] | {number, title, head: .head.ref, base: .base.ref, head_repo: (.head.repo.full_name // "")}' \
            > "$tmp/pulls" 2> "$tmp/err"; then
        _concurrent_work_log_file "同时进行的其他工作：读取打开的 PR 列表失败，本次写「未能读取」" "$tmp/err"
        return 1
    fi

    # 3. 归并成行：同一分支上的 issue 和它的 PR 合成一行；自己这一条排除
    if ! jq -rn \
            --slurpfile issues "$tmp/issues" --slurpfile pulls "$tmp/pulls" \
            --arg repo "$REPO" --arg prefix "$BRANCH_PREFIX" --arg self_branch "$self_branch" \
            --argjson self "$self_json" \
            --arg doing "$LABEL_AGENT_DOING" --arg review "${LABEL_PENDING_REVIEW:-}" --arg ppr "$LABEL_PENDING_PR" \
            --argjson max "$CONCURRENT_WORK_MAX_ITEMS" '
        def clean: (. // "") | tostring
            | gsub("[\\p{Cc}\\p{Zl}\\p{Zp}\\s]+"; " ") | gsub("`"; "") | gsub("「"; "『") | gsub("」"; "』")
            | sub("^ +"; "") | sub(" +$"; "")
            | if length > 80 then .[0:80] + "…" else . end
            | if . == "" then "（无标题）" else . end;
        def safe: type == "string" and length > 0 and length <= 200
            and test("^[A-Za-z0-9._/-]+$") and (test("\\.\\.|//|^[-/.]|[/.]$|\\.lock$|/\\.") | not);
        def shape: type == "object" and (.number | type == "number") and (.number == (.number | floor)) and .number > 0;
        if (($issues + $pulls) | all(shape)) | not then error("unexpected shape") else . end
        | ([$doing, $review, $ppr] | map(select(. != ""))) as $want
        | ($repo | ascii_downcase) as $r
        | ($pulls | unique_by(.number)) as $prs
        | ($prs | map(select((.head_repo | tostring | ascii_downcase) == $r))) as $own
        | [ $issues | unique_by(.number)[]
            | select(.labels as $l | $want | any(. as $w | $l | index($w) != null))
            | . as $it
            | if $it.pr then
                  ($prs | map(select(.number == $it.number)) | first) as $p
                  | if $p == null then {key: "nopr:\($it.number)", kind: "nopr", pr: $it.number, it: $it}
                    elif (($p.head_repo | tostring | ascii_downcase) != $r) then {key: "fork:\($it.number)", kind: "fork", pr: $it.number, it: $it}
                    else {key: "b:\($p.head)", kind: "ok", head: $p.head, base: $p.base, pr: $it.number, it: $it} end
              else
                  ($prefix + ($it.number | tostring)) as $b
                  | ($own | map(select(.head == $b)) | first) as $p
                  | {key: "b:\($b)", kind: "ok", head: $b, base: ($p.base // null), pr: ($p.number // null), issue: $it.number, it: $it}
              end ]
        | group_by(.key)
        | map(
            . as $g
            | ($g | map(select(.issue != null)) | first) as $i
            | ($g | map(select(.pr != null)) | first) as $pp
            | ($g | map(.it.labels[]) | unique) as $labs
            | { nums: ($g | map(.issue, .pr) | map(select(. != null)) | unique),
                sort: (($i.issue) // ($pp.pr)),
                issue: ($i.issue // null), pr: ($pp.pr // null),
                title: ((($i // $g[0]).it.title) | clean),
                state: (if ($labs | index($doing)) != null then "进行中"
                        elif $review != "" and ($labs | index($review)) != null then "待复审"
                        else "已转 PR" end),
                kind: $g[0].kind, head: ($g[0].head // ""),
                base: (($g | map(select(.base != null)) | first | .base) // "") } )
        | map(select((.kind != "ok" or .head != $self_branch) and ((.nums - $self) == .nums)))
        | map(if .kind == "ok" and (((.head | safe) and (.base == "" or (.base | safe))) | not)
              then .kind = "badbranch" | .head = "" | .base = "" else . end)
        | sort_by(.sort)
        | "TOTAL\u001f\(length)",
          (.[0:$max][]
           | [ (if .issue != null and .pr != null then "#\(.issue)（PR #\(.pr)，\(.state)）"
                elif .issue != null then "#\(.issue)（\(.state)）"
                else "PR #\(.pr)（\(.state)）" end),
               .title, .kind, .head, .base ] | join("\u001f"))
        ' > "$tmp/rows" 2> "$tmp/err"; then
        _concurrent_work_log_file "同时进行的其他工作：GitHub 返回的条目不是预期的形状，本次写「未能读取」" "$tmp/err"
        return 1
    fi

    # 字段之间用 US（0x1f）隔开，不用制表符：制表符是 IFS 的「空白」分隔符，read 会把连续的几个并成一个，
    # 中间一列为空（没有 PR 的条目目标分支是空的、fork 的分支是空的）后面的列就整体前移——标题清理成空串时
    # 分支被读成目标分支、已推送的改动被写成「还没有推送」（PR #352 复审第 1 轮）。US 不是空白，空列原样保留；
    # 标题里的控制字符在上面已经清掉，分支名只认安全字符，字段里不会出现它。
    local total=0 shown=0 tag disp title kind head base
    IFS=$'\x1f' read -r tag total < "$tmp/rows" || return 1
    [ "$tag" = TOTAL ] && [[ "$total" =~ ^[0-9]+$ ]] || return 1
    if [ "$total" -eq 0 ]; then
        printf '目前没有其他进行中的条目。\n'
        return 0
    fi

    # 4. 远端分支的当前提交（一次 ls-remote）+ 把它们拉进主 checkout 的对象库（一次 fetch，不写任何引用）
    local git_ok=1 b sha ref
    local -A need=() tips=()
    while IFS=$'\x1f' read -r disp title kind head base; do
        [ "$kind" = ok ] && [ -n "$head" ] || continue
        need["$head"]=1; need["${base:-$CONCURRENT_WORK_DEFAULT_BASE}"]=1
    done < <(tail -n +2 "$tmp/rows")
    if [ "${#need[@]}" -gt 0 ]; then
        local -a pats=() have=()
        for b in "${!need[@]}"; do pats+=("refs/heads/$b"); done
        if git -C "$PROJECT_ROOT" ls-remote origin "${pats[@]}" > "$tmp/ls" 2> "$tmp/err"; then
            # ls-remote 的模式按尾部匹配（refs/heads/x/main 也会被 main 匹配上），只认整名
            while IFS=$'\t' read -r sha ref; do
                b="${ref#refs/heads/}"
                [ "$ref" = "refs/heads/$b" ] && [ -n "${need[$b]:-}" ] && [[ "$sha" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || continue
                tips["$b"]="$sha"; have+=("refs/heads/$b")
            done < "$tmp/ls"
            # --refmap= ：不顺手挪动主 checkout 的 origin/<分支>
            if [ "${#have[@]}" -gt 0 ] && ! git -C "$PROJECT_ROOT" fetch -q --no-write-fetch-head --refmap= origin "${have[@]}" > "$tmp/err" 2>&1; then
                git_ok=0
                _concurrent_work_log_file "同时进行的其他工作：拉取各分支失败，改动文件写「未能读取」" "$tmp/err"
            fi
        else
            git_ok=0
            _concurrent_work_log_file "同时进行的其他工作：读取远端分支失败（git ls-remote），改动文件写「未能读取」" "$tmp/err"
        fi
    fi

    # 5. 逐行输出
    local eb against n files more
    while IFS=$'\x1f' read -r disp title kind head base; do
        shown=$((shown + 1))
        case "$kind" in
            fork)      printf -- '- %s「%s」：来自 fork，改动文件未读取\n' "$disp" "$title"; continue ;;
            nopr)      printf -- '- %s「%s」：PR 信息未能读取，改动文件未能读取\n' "$disp" "$title"; continue ;;
            badbranch) printf -- '- %s「%s」：分支名异常，未列出\n' "$disp" "$title"; continue ;;
            ok)        [ -n "$head" ] || return 1 ;;
            *)         return 1 ;;   # 行的形状不对：宁可整段「未能读取」，也不按错位的字段往下写
        esac
        eb="${base:-$CONCURRENT_WORK_DEFAULT_BASE}"
        if [ -n "$base" ]; then against=" → \`$eb\`"; else against="（相对 \`$eb\`）"; fi
        printf -- '- %s「%s」分支 `%s`%s：' "$disp" "$title" "$head" "$against"
        if [ "$git_ok" != 1 ]; then
            printf '改动文件未能读取（本机这次读不到远端分支）\n'
        elif [ -z "${tips[$head]:-}" ]; then
            if [ -z "$base" ]; then printf '还没有推送改动\n'
            else printf '改动文件未能读取（分支 `%s` 取不到）\n' "$head"; fi
        elif [ -z "${tips[$eb]:-}" ]; then
            printf '改动文件未能读取（目标分支 `%s` 取不到）\n' "$eb"
        elif ! git -C "$PROJECT_ROOT" -c core.quotePath=true diff --name-only "${tips[$eb]}...${tips[$head]}" > "$tmp/files.raw" 2> "$tmp/err"; then
            printf '改动文件未能读取（算不出和 `%s` 的差异）\n' "$eb"
            _concurrent_work_log_file "同时进行的其他工作：$head 相对 $eb 的差异算不出来" "$tmp/err"
        else
            LC_ALL=C tr -d '`\000-\010\013-\037\177' < "$tmp/files.raw" | awk 'NF' > "$tmp/files"
            n=$(wc -l < "$tmp/files" | tr -d ' ')
            if [ "$n" -eq 0 ]; then
                printf '相对 `%s` 没有改动文件\n' "$eb"
            else
                files=$(head -n "$CONCURRENT_WORK_MAX_FILES" "$tmp/files" | awk '{ printf "%s`%s`", (NR > 1 ? "、" : ""), $0 }')
                more=""
                [ "$n" -le "$CONCURRENT_WORK_MAX_FILES" ] || more="；另有 $((n - CONCURRENT_WORK_MAX_FILES)) 个文件未列出"
                printf '已改 %s 个文件：\n  %s%s\n' "$n" "$files" "$more"
            fi
        fi
    done < <(tail -n +2 "$tmp/rows")
    [ "$total" -le "$shown" ] || printf '另有 %s 个条目未列出。\n' "$((total - shown))"
    return 0
}

# 把 prompt 里独占一行的 ${CONCURRENT_WORK} 换成清单。放在 dispatch 的 sed **之后**：清单是多行的，
# 里面的标题、文件名是别人写的，不能再过一遍占位符替换。没有占位符 → 什么都不读、文件不动。
# 永远 return 0：这一步出什么事都不能挡派工。
concurrent_work_fill() {   # <prompt 文件> <本次工作分支> <本次工作编号>...
    local f="$1"; shift
    [ -f "$f" ] && grep -qxF -- "$CONCURRENT_WORK_PLACEHOLDER" "$f" || return 0
    local t
    t=$(mktemp "${TMPDIR:-/tmp}/cavil-concurrent-fill.XXXXXX" 2>/dev/null) || t=""
    if [ -n "$t" ]; then
        if concurrent_work_enabled; then
            # 放在子 shell 里跑：dispatch 脚本开着 set -eu，清单生成里任何一个致命错误（数组下标为空、
            # 变量没定义……）在当前 shell 里会直接结束整个派工。子 shell 里出事只丢这一段：非 0 退出或
            # 没有输出一律写「未能读取」，不留半截清单。
            ( concurrent_work_text "$@" ) > "$t" 2>/dev/null || : > "$t"
        else printf '（本项目没有开启这项提示。）\n' > "$t"; fi
        [ -s "$t" ] || printf '%s\n' "$CONCURRENT_WORK_UNREAD" > "$t"
        if awk -v ph="$CONCURRENT_WORK_PLACEHOLDER" -v src="$t" '
                $0 == ph { while ((getline line < src) > 0) print line; close(src); next }
                { print }' "$f" > "$t.out" && [ -s "$t.out" ]; then
            cat "$t.out" > "$f" || true
        else
            log "  ⚠️ 同时进行的其他工作：填充 prompt 失败（$f），占位符原样留着" 2>/dev/null || true
        fi
        rm -f "$t" "$t.out"
    fi
    return 0
}

# ── 重测试排队 + 条目结束时清掉它的测试（GitHub#343）──
# 项目在 HEAVY_TEST_COMMANDS 里列出哪些命令算「重测试」（每行一条），空 = 不限制、本段什么都不做。
# 非空时：
#   · worker 的提示词多一段，要求这些命令通过 scripts/heavy-test.sh 跑（同一账号下一次只放行一套，
#     放行依据是上一套的进程分组已清空，规则见那个脚本和 _heavy.sh）；
#   · 派工和清理整段拿着同一把「条目锁」，两者只能一先一后——清理不会删掉正在启动的 worker 的
#     工作树，也不会误停清理之后才起的测试；
#   · 每个条目一个「代数」，清理一拿到锁就加一。worker 启动时带着当时的代数，测试登记和开跑前
#     都在条目锁里核对，对不上就退出；清理在同一把锁里停掉本条目登记着的分组，确认消失才删工作树；
#   · 每次起 worker 记一份启动记录（窗格进程号 + 进程启动时间），每轮轮询据此把「worker 已经
#     结束、测试还在排队或运行」的分组停掉——不依赖 tmux 会话还在。
# 判断全部在 _heavy.sh，wrapper 和这里用的是同一份。「读不到」从不当成「没有 / 已停」。
HEAVY_TEST_COMMANDS="${HEAVY_TEST_COMMANDS:-}"
HEAVY_TEST_LOCK_WAIT="${HEAVY_TEST_LOCK_WAIT:-0}"
HEAVY_TEST_SCOPE_PROPERTIES="${HEAVY_TEST_SCOPE_PROPERTIES:-}"
ITEM_LOCK_WAIT_SECS="${ITEM_LOCK_WAIT_SECS:-60}"
# 清理时停一个分组后最多等多久确认它消失（秒）。systemd 那边 10 秒后会强杀，30 秒足够
HEAVY_STOP_WAIT_SECS="${HEAVY_STOP_WAIT_SECS:-30}"
# worker 在会话里跑的包装命令：托管安装走长期入口，发版切换后路径不失效（同用量 footer）
HEAVY_TEST_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/heavy-test.sh"
_MANAGED_HEAVY_TEST="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}/entrypoints/heavy-test.sh"
[ ! -f "$_MANAGED_HEAVY_TEST" ] || HEAVY_TEST_SCRIPT="$_MANAGED_HEAVY_TEST"

heavy_enabled() { [ -n "${HEAVY_TEST_COMMANDS//[[:space:]]/}" ]; }

# 派工 / 清理脚本的开头调：还没拿条目锁 → 在锁里把本脚本重跑一遍并以它的退出码退出；已经在锁里
# （上一层传下来的标记）→ 返回 0 接着跑。锁由 flock 进程自己拿着（-o：不把描述符传给脚本），
# 所以它不会顺着 tmux server 漏到 worker 手里——那样 worker 活着锁就一直不放。
# 等不到锁退出码 75：派工那边标签不翻、下一轮重试；清理那边什么都没动。
ITEM_LOCK_HELD_FOR=""
item_lock_reexec() {   # <条目号> <脚本路径> [原参数…]
    local n="$1" self="$2" lock rc=0
    shift 2
    if [ "${CAVIL_ITEM_LOCK_HELD:-}" = "$n" ]; then
        unset CAVIL_ITEM_LOCK_HELD      # 不留在环境里：起 tmux server 时会被它整份抄走
        ITEM_LOCK_HELD_FOR="$n"
        return 0
    fi
    lock="$(heavy_item_lock_path "$STATE_DIR" "$n")"
    mkdir -p "$(dirname "$lock")"
    CAVIL_ITEM_LOCK_HELD="$n" flock -o -x -w "$ITEM_LOCK_WAIT_SECS" -E 75 "$lock" bash "$self" "$@" || rc=$?
    if [ "$rc" = 75 ]; then
        log "条目 #$n 的锁被占用超过 ${ITEM_LOCK_WAIT_SECS} 秒（正在派工或清理），本次什么都不做"
    fi
    exit "$rc"
}

# 派工：定下这次启动的编号和代数，tmux_env_args 会把它们交给 worker。读不到代数 → 非 0，本轮不派。
HEAVY_LAUNCH_ID=""; HEAVY_LAUNCH_ITEM=""; HEAVY_LAUNCH_GEN=""
heavy_launch_prepare() {   # <条目号>
    heavy_enabled || return 0
    local g
    if ! g="$(heavy_gen_read "$STATE_DIR" "$1")"; then
        log "❌ 读不到条目 #$1 的清理记录（$(heavy_gen_file "$STATE_DIR" "$1")），本轮不派工"
        return 1
    fi
    HEAVY_LAUNCH_ID="$(tr -d '-' < /proc/sys/kernel/random/uuid 2>/dev/null || true)"
    if ! [[ "$HEAVY_LAUNCH_ID" =~ ^[0-9a-f]{32}$ ]]; then
        # 没有 /proc（macOS）：那里包装命令只排队、不登记，启动编号用不上
        HEAVY_LAUNCH_ID=""
    fi
    HEAVY_LAUNCH_ITEM="$1"; HEAVY_LAUNCH_GEN="$g"
}

heavy_launch_write() {   # <进程号 | pending> <进程启动时间>
    local f tmp
    f="$(heavy_launch_file "$STATE_DIR" "$HEAVY_LAUNCH_ID")"
    mkdir -p "$(dirname "$f")" || return 1
    tmp="$f.tmp.$$"
    printf 'pid=%s\nstart=%s\nitem=%s\ngen=%s\nat=%s\n' \
        "$1" "$2" "$HEAVY_LAUNCH_ITEM" "$HEAVY_LAUNCH_GEN" "$(date +%s)" > "$tmp" && mv -f "$tmp" "$f"
}

# 交给 worker 的环境变量（tmux -e 参数，NUL 分隔，格式同 tmux_env_args 的其余部分）。
heavy_tmux_env_args() {
    [ -n "$HEAVY_LAUNCH_ITEM" ] || return 0
    # 这里只在真的要起 worker 时才会走到（注入现有会话不拼环境参数），而且在起之前：先登记这次启动
    # （进程号待定）。worker 一起来就可能跑排队命令，那时记录必须已经在——排队命令对「没有记录的
    # 启动编号」一律不放行。写不进去时 worker 照常起，只是它的重测试会被拒绝（不放行比乱放行安全）。
    if [ -n "$HEAVY_LAUNCH_ID" ] && [ ! -e "$(heavy_launch_file "$STATE_DIR" "$HEAVY_LAUNCH_ID")" ]; then
        heavy_launch_write pending "" || echo "[cavil-loop] WARN: 写不进这次启动的记录，这个 worker 的重测试会被排队命令拒绝" >&2
    fi
    printf -- '-e\0CAVIL_HEAVY_ITEM=%s\0' "$HEAVY_LAUNCH_ITEM"
    printf -- '-e\0CAVIL_HEAVY_GEN=%s\0' "$HEAVY_LAUNCH_GEN"
    printf -- '-e\0CAVIL_HEAVY_LAUNCH=%s\0' "$HEAVY_LAUNCH_ID"
    printf -- '-e\0CAVIL_HEAVY_STATE_DIR=%s\0' "$STATE_DIR"
    printf -- '-e\0CAVIL_HEAVY_PROJECT=%s\0' "$REPO"
    printf -- '-e\0CAVIL_HEAVY_LOCK_WAIT=%s\0' "$HEAVY_TEST_LOCK_WAIT"
    printf -- '-e\0CAVIL_HEAVY_SCOPE_PROPERTIES=%s\0' "$HEAVY_TEST_SCOPE_PROPERTIES"
}

# 起完 worker 之后调：把这次启动的记录补上窗格进程号和它的启动时间。
# 认不出 worker 窗格 / 读不到进程 → 记录停在「进程号待定」：这次启动起的测试可以跑、只会被等，
# 不会被每轮检查停掉。注入现有会话（没有新起程序）不调，那种情况也没有登记过新的启动。
heavy_launch_record() {   # <tmux_session>
    [ -n "$HEAVY_LAUNCH_ID" ] || return 0
    local sess="$1" st pane pid dead start
    read -r st pane pid dead _ <<<"$(worker_pane_lookup "$sess")"
    case "$st" in found|single) ;; *) st="" ;; esac
    if [ -z "$st" ] || [ "$dead" = 1 ] || ! start="$(heavy_proc_start "$pid")"; then
        log "  ⚠️ 读不到 $sess 的 worker 窗格进程，这次启动的进程号没记下（它起的重测试不会被自动停）"
        return 0
    fi
    heavy_launch_write "$pid" "$start" || log "  ⚠️ 写不进这次启动的记录（它起的重测试不会被自动停）"
}

# 条目清理（代数已经加一）之后：这个条目以前的启动记录都用不上了——带旧代数的测试在核对代数那一步
# 就被拦下，轮不到看启动记录。在条目锁里调。
heavy_launch_forget_item() {   # <条目号>
    local f d="$STATE_DIR/worker-launch"
    [ -d "$d" ] || return 0
    for f in "$d"/*; do
        [ -f "$f" ] || continue
        [[ "${f##*/}" =~ ^[0-9a-f]{32}$ ]] || continue
        [ "$(heavy_field "$f" item)" = "$1" ] || continue
        rm -f "$f"
    done
}

# 本账号下登记着的全部运行记录文件，一行一个路径（只看文件名，不读内容）。是不是本项目 / 本条目的，
# 由调用方用 heavy_run_load 读过之后再问 heavy_run_is_mine——读不到的记录不能在这里被悄悄筛掉。
heavy_run_files() {
    local f
    for f in "$CAVIL_HEAVY_TEST_RUNS"/*; do
        [ -f "$f" ] || [ -L "$f" ] || continue
        heavy_is_run_id "${f##*/}" || continue
        printf '%s\n' "$f"
    done
}
# 刚用 heavy_run_load 读过的那条记录是不是本项目的（可选：是不是这个条目的）。只在读成功（返回 0）之后问。
heavy_run_is_mine() {   # [条目号]
    [ "$HR_STATEDIR" = "$STATE_DIR" ] || return 1
    [ -z "${1:-}" ] || [ "$HR_ITEM" = "$1" ]
}

# 清理这个条目要不要走条目锁 / 代数 / 停分组：功能开着，或者（功能后来关了但）它还有登记着的运行、
# 或被清理过。三样都没有 = 这个项目从没用过，清理过程和以前一模一样。
heavy_cleanup_needed() {   # <条目号>
    heavy_enabled && return 0
    [ -e "$(heavy_gen_file "$STATE_DIR" "$1")" ] && return 0
    local f rc
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        rc=0; heavy_run_load "$f" || rc=$?
        case "$rc" in
            0) ! heavy_run_is_mine "$1" || return 0 ;;
            2) return 0 ;;      # 读不到：可能就是这个条目的，不能当成没有
        esac
    done < <(heavy_run_files)
    return 1
}

# 清理：代数加一并落盘。在条目锁里调。读不出旧值 / 写不进去 → 非 0，调用方不继续清理。
heavy_gen_bump() {   # <条目号>
    local f g tmp
    if ! g="$(heavy_gen_read "$STATE_DIR" "$1")"; then
        log "❌ 读不到条目 #$1 的清理记录（$(heavy_gen_file "$STATE_DIR" "$1")）"
        return 1
    fi
    f="$(heavy_gen_file "$STATE_DIR" "$1")"
    mkdir -p "$(dirname "$f")" || return 1
    tmp="$f.tmp.$$"
    printf '%s\n' $((g + 1)) > "$tmp" && mv -f "$tmp" "$f" || { log "❌ 写不进 $f"; return 1; }
}

# 清理：停掉本条目登记着的全部运行（排队中和运行中），逐个确认分组消失。在条目锁里、代数加一之后调。
# 任何一个查不清 / 停不掉 → 非 0，调用方保留工作树。
heavy_stop_item_runs() {   # <条目号>
    local f unit st rc=0 lr
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        lr=0; heavy_run_load "$f" || lr=$?
        [ "$lr" != 1 ] || continue
        unit="$(heavy_unit_name "${f##*/}")"       # 分组名由文件名决定，记录读不到也推得出来
        if [ "$lr" = 0 ] && ! heavy_run_is_mine "$1"; then continue; fi
        st="$(heavy_scope_state "$unit")"
        if [ "$st" = gone ]; then rm -f "$f"; continue; fi
        if [ "$lr" = 2 ]; then
            # 读不到它是谁的：可能就是本条目的。不停它（也可能是别人的），但也不能当它不存在去删工作树
            log "  ⚠️ 运行记录 $f 读不出来或内容不认识，它的分组 $unit 还在（或查不清）：没法确认不是条目 #$1 的"
            rc=1; continue
        fi
        if [ "$st" != active ]; then
            log "  ⚠️ 查不清重测试分组 $unit 的状态，当它还在跑"; rc=1; continue
        fi
        log "  停掉条目 #$1 的重测试：$unit（$HR_STATE，$HR_CMD）"
        # heavy_stop_unit 自己会再读一次状态：这一次读不出来就不发停止请求
        if heavy_stop_unit "$unit" "$HEAVY_STOP_WAIT_SECS"; then
            rm -f "$f"
        else
            log "  ⚠️ 没能确认 $unit 已停（或这一次查不到它的状态；现在：$(heavy_scope_state "$unit")）"
            rc=1
        fi
    done < <(heavy_run_files)
    return "$rc"
}

# 每轮轮询：本项目登记着的运行里，分组已经消失的删记录；起它的 worker 已确认结束、分组还在的，
# 整组停掉。worker 还在 / 认不清 / 没读到进程号的一律不动。
# 已结束的启动记录**不删**，只盖上「已结束」：删了的话，这个启动编号再被拿来问就成了「没记录」，
# 旧 worker 留下的迟到请求会被重新放行。记录到条目清理时才删（那时代数已变，旧请求过不了代数那一关）。
# 没有任何记录时只是两次目录读。
heavy_sweep_tick() {
    local f unit d id lr
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        lr=0; heavy_run_load "$f" || lr=$?
        [ "$lr" != 1 ] || continue
        if [ "$lr" = 0 ] && ! heavy_run_is_mine; then continue; fi
        unit="$(heavy_unit_name "${f##*/}")"
        case "$(heavy_scope_state "$unit")" in
            gone) rm -f "$f"; continue ;;       # 分组确认消失：不管记录读没读到，这条运行都了结了
            active) ;;
            *) continue ;;
        esac
        # 读不到的记录：不知道是谁的、谁起的，不停。它会挡着排队和本账号下的条目清理，所以每轮说一声
        if [ "$lr" = 2 ]; then
            log "⚠️ 重测试的运行记录 $f 读不出来或内容不认识，它的分组 $unit 还在：不动它（确认后可 heavy-test.sh --stop ${f##*/}）"
            continue
        fi
        if [ -n "$HR_LAUNCH" ] && [ "$(heavy_launch_state "$STATE_DIR" "$HR_LAUNCH")" = ended ]; then
            log "🧹 起它的 worker 已结束，停掉遗留的重测试：$unit（条目 #$HR_ITEM，$HR_CMD）"
            if heavy_stop_unit "$unit" 15; then rm -f "$f"; continue; fi
            log "  ⚠️ 没能确认 $unit 已停（或这一次查不到它的状态），下一轮再试"
        fi
    done < <(heavy_run_files)
    d="$STATE_DIR/worker-launch"
    [ -d "$d" ] || return 0
    for f in "$d"/*; do
        [ -f "$f" ] || continue
        id="${f##*/}"
        [[ "$id" =~ ^[0-9a-f]{32}$ ]] || continue
        [ "$(heavy_field "$f" ended)" = 1 ] && continue
        [ "$(heavy_launch_state "$STATE_DIR" "$id")" = ended ] || continue
        heavy_launch_mark_ended "$STATE_DIR" "$id"
    done
    return 0
}

# 提示词里追加的那一段（compose_prompt_template 在功能开着时加）。
heavy_prompt_section() {
    local f="$SKILL_DIR/prompts/heavy-test.md" text cmds="" line wrapper
    # 路径不加引号（只在含特殊字符时由 %q 转义）：用量 footer 认测试命令时会把引号里的内容整个去掉，
    # 加了引号它就看不出这是排队命令、后面跟的是哪条测试了（test_time.py 的 classify_segment）
    printf -v wrapper '%q' "$HEAVY_TEST_SCRIPT"
    [ -s "$f" ] || { log "⚠️ 重测试排队说明文件缺失：$f" 2>/dev/null || true; return 0; }
    while IFS= read -r line; do
        line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
        [ -n "$line" ] || continue
        cmds="${cmds}${cmds:+$'\n'}bash $wrapper -- $line"
    done <<<"$HEAVY_TEST_COMMANDS"
    text="$(cat "$f")"
    text="${text//@@HEAVY_TEST_COMMANDS@@/"$cmds"}"
    text="${text//@@HEAVY_TEST_LIST@@/"bash $wrapper --list"}"
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
    if [ -z "$overlay" ] && [ ! -s "$lessons" ] && [ -z "$project_lessons" ] && ! requester_bot_enabled && ! blocked_enabled && ! autopilot_section_active && ! concurrent_work_section_active "$name" && ! heavy_enabled; then echo "$base_tpl"; return; fi

    out="$STATE_DIR/prompt-composed-${name}.md"
    {
        cat "$base_tpl"
        if [ -s "$lessons" ]; then
            printf '\n\n---\n\n'
            lessons_for_prompt "$lessons"
        fi
        if [ -n "$project_lessons" ]; then
            printf '\n\n---\n\n'
            lessons_for_prompt "$project_lessons"
        fi
        if [ -n "$overlay" ]; then
        printf '\n\n---\n\n'
        printf '# 本项目的附加要求（覆盖上面与之冲突的部分）\n\n'
        printf '> 上面是通用工作流，这一段是 %s 特有的。两者冲突时**以这一段为准**。\n\n' "${REPO:-本仓库}"
        cat "$overlay"
        fi
        # 同时在进行的其他工作（GitHub#340）：追加在这里，整份替换了模板的项目也收得到。清单本身是
        # 占位符 ${CONCURRENT_WORK}，由 dispatch 在 sed 之后填（concurrent_work_fill）。功能关着什么都不加。
        if concurrent_work_section_active "$name"; then
            printf '\n\n---\n\n'
            concurrent_work_section
        fi
        # 重测试排队（GitHub#343）：项目配了重测试命令才加，整份替换了模板的项目也收得到。
        if heavy_enabled; then
            printf '\n\n---\n\n'
            heavy_prompt_section
        fi
        # 外部需求机器人交接规则（GitHub#95）放在**最末尾**、项目追加要求之后：项目整份替换了
        # 工具自带模板时也收得到；写进工具模板里的话，那种项目就漏了。功能关着什么都不加。
        if requester_bot_enabled; then
            printf '\n\n---\n\n'
            requester_bot_handoff_section
        fi
        # 等前置规则（GitHub#157）同理放在末尾：整份替换了模板的项目也收得到。功能关着什么都不加。
        if blocked_enabled; then
            printf '\n\n---\n\n'
            blocked_handoff_section
        fi
        # 托管规则（GitHub#114）同理放在最末尾。外部需求机器人提的需求也能托管（GitHub#162），两段都在时
        # 再追加合并规则段，写清两段说法相反的地方以哪个为准。
        if autopilot_section_active; then
            printf '\n\n---\n\n'
            autopilot_handoff_section "$name"
            if requester_bot_enabled; then
                printf '\n\n---\n\n'
                autopilot_requester_bot_section
            fi
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
# 每轮一次：把本仓库的 issue / PR 补进配置的 Project（GitHub#116）。
# 跑成独立子进程：同步里任何失败（读不到、写不进、脚本自己出错）都只留一行日志，
# 不碰这一轮的派工、清理和退出码。不标 PACE_ACTED：加卡片不改仓库，不该打断空闲退避。
project_auto_add_tick() {
    [ -n "$(printf '%s' "${AUTO_ADD_PROJECTS:-}" | tr -d ' ,\t\n')" ] || return 0
    local rc=0
    CODING_AGENT_CONFIG="$CONFIG_FILE" bash "$_LIB_DIR/project-auto-add.sh" || rc=$?
    [ "$rc" = 0 ] || log "⚠️ 自动加入 Project：同步脚本异常退出（退出码 $rc），本轮跳过，派工不受影响"
    return 0
}

# ── 令牌脱敏：定期扫描（GitHub#342）──
# daemon 自己写的日志在落盘前就替换了（log() / redact_pipe / 窗格历史的过滤管道）。这里补两件事：
#   1. agent 自己写的会话记录（claude / codex 的对话记录）：CLI 写入时 daemon 插不上手，
#      改为定期原地替换。只碰工作目录在本项目 WORKTREE_BASE 下的会话。
#   2. 升级前已经落盘的窗格历史 / poll.log，以及升级前用 `cat` 挂着日志的活会话（换成过滤版）。
# REDACT_AGENT_RECORDS 写成空值 / false 只关第 1 件；daemon 自己的日志始终处理。
# 每 REDACT_SCAN_INTERVAL_SECS（默认 600）秒一次；一次最多跑 REDACT_SCAN_BUDGET_SECS（默认 20）秒，
# 没扫完不记时间，下一轮接着扫（位置记在 $STATE_DIR/redact-scan.json）。
# 这里的任何失败都只记日志，不影响派工。
REDACT_AGENT_RECORDS="${REDACT_AGENT_RECORDS-true}"

redact_agent_records_on() {
    case "$(printf '%s' "${REDACT_AGENT_RECORDS:-}" | tr '[:upper:]' '[:lower:]')" in
        ""|0|false|no|off) return 1 ;;
    esac
    return 0
}

redact_scan_tick() {
    local stamp="$STATE_DIR/redact-scan.stamp" now last=0
    local every="${REDACT_SCAN_INTERVAL_SECS:-600}"
    [[ "$every" =~ ^[0-9]+$ ]] || every=600
    now="$(date +%s)"
    [ -f "$stamp" ] && last="$(cat "$stamp" 2>/dev/null || true)"
    [[ "$last" =~ ^[0-9]+$ ]] || last=0
    [ $((now - last)) -ge "$every" ] || return 0

    # tmux 会话清单：成功读到才算数（「没有 server」也是成功读到：一个会话都没有）。
    # 读不到时不给清单，扫描就不会把任何窗格历史当成「已经写完」。
    local live="" live_ok=0 err list name
    err="$(mktemp)"
    if list="$(tmux list-sessions -F '#{session_name}' 2>"$err")"; then
        live="$list"; live_ok=1
    elif grep -qE '^(no server running on |error connecting to .*\(No such file or directory\))' "$err"; then
        live_ok=1
    fi
    rm -f "$err"

    # 升级前用 `cat` 挂着日志的本项目活会话：认得出 worker 窗格的换成过滤版
    if [ "$live_ok" = 1 ] && [ -n "${SESSION_LOG_DIR:-}" ]; then
        local st tgt pid dead pipe rest
        while IFS= read -r name; do
            # 只认本项目的 worker 会话：名字是「前缀-issue<编号>」，而且它的日志就在本项目的
            # 日志目录里。别的项目的前缀可能以本项目的前缀开头（tutor / tutor-web），
            # 认错了会把别人的日志管道改指到这里来。
            rest="${name#"${TMUX_PREFIX}-${SESSION_NAME_PREFIX}"}"
            [ "$rest" != "$name" ] && [[ "$rest" =~ ^[0-9]+$ ]] || continue
            [ -f "$(session_log_path "$name")" ] || continue
            read -r st tgt pid dead pipe <<<"$(worker_pane_lookup "$name")"
            case "$st" in found|single) ;; *) continue ;; esac
            [ "$pipe" = 1 ] || continue
            session_log_pipe_ensure "$name" "$tgt" "$pipe" "$(session_log_path "$name")" || true
        done <<<"$live"
    fi

    # 不加全机锁：几个项目的 daemon 同时扫到同一份会话记录也没关系——每一处都是「再读一次，
    # 还是那个令牌才写」，写进去的又是同样的字节，谁先谁后结果一样。扫描位置各项目各记各的。
    local args=(scan --state "$STATE_DIR/redact-scan.json"
                --budget-secs "${REDACT_SCAN_BUDGET_SECS:-20}" --plain "$LOG_FILE")
    local live_file=""
    if [ -n "${SESSION_LOG_DIR:-}" ]; then
        args+=(--pane-dir "$SESSION_LOG_DIR")
        if [ "$live_ok" = 1 ]; then
            live_file="$(mktemp)"
            printf '%s\n' "$live" > "$live_file"
            args+=(--live-sessions "$live_file")
        fi
    fi
    if redact_agent_records_on && [ -n "${WORKTREE_BASE:-}" ]; then
        args+=(--cwd-prefix "$WORKTREE_BASE"
               --claude-root "${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
               --codex-root "${CODEX_SESSIONS_DIR:-${CODEX_HOME:-$HOME/.codex}/sessions}")
    fi
    local out rc=0 line done=1
    # 和上面各个入口用同一份脚本（_redact.sh 里定的路径），不另拼一个
    out="$(python3 "$_REDACT_PY" "${args[@]}" 2>&1)" || rc=$?
    [ -n "$live_file" ] && rm -f "$live_file"
    if [ "$rc" != 0 ]; then
        log "⚠️ 令牌脱敏：扫描异常退出（退出码 $rc），下一轮重试：$(printf '%s' "$out" | tail -1)"
        return 0
    fi
    while IFS= read -r line; do
        case "$line" in
            error=*) log "⚠️ 令牌脱敏：${line#error=}（这个文件本轮没处理，下一轮重试）" ;;
            files=*)
                [[ "$line" == *" unfinished=1 "* ]] && done=0
                if [[ "$line" =~ changed=([0-9]+)\ replaced=([0-9]+) ]] && [ "${BASH_REMATCH[2]}" -gt 0 ]; then
                    log "令牌脱敏：${BASH_REMATCH[1]} 个文件里替换了 ${BASH_REMATCH[2]} 处（指纹 ${line##*fingerprints=}）"
                fi ;;
        esac
    done <<<"$out"
    [ "$done" = 1 ] && printf '%s\n' "$now" > "$stamp"
    return 0
}

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
    local sess="$1" cwd="$2" n i log_path key
    [ -n "${AGENT_TRUST_PROMPT_FOOTER_RE:-}" ] || return 1
    n=$(( ${AGENT_TRUST_PROMPT_WAIT_SECS:-4} * 2 ))
    for ((i = 0; i < n; i++)); do
        session_alive "$sess" || return 1
        if tmux capture-pane -t "$sess" -p 2>/dev/null | agent_trust_prompt_on_screen; then
            key="$( (agent_trust_key "$cwd") 2>/dev/null || echo "$cwd")"
            log "  ❌ $sess 卡在 $WORKER_AGENT 的目录信任确认框上（工作目录 $cwd，该补的信任记录：$key）"
            log_path="$(session_log_path "$sess")"
            {
                printf '\n===== %s session=%s 卡在目录信任框，pane capture =====\n' "$(date -Iseconds)" "$sess"
                tmux capture-pane -t "$sess" -p -S -200 2>/dev/null | sed '/^[[:space:]]*$/d'
            } | redact_pipe >> "${log_path:-/dev/null}" 2>/dev/null
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

# ── 用量上限：撞上限的 agent 停派到解除，被打断的条目转人工（GitHub#341，可选，默认关闭）──
#
# 两个 agent 都跑在包月订阅上，有时段用量上限。worker 撞上之后界面停在一条提示上：会话活着、
# 标签还是 doing/agent、名额占着，而新派出去的会话一开口又撞一次。开了 ENABLE_USAGE_LIMIT_PAUSE
# 之后 daemon 每轮看一眼本机派出去、挂着 doing/agent 的会话，认出上限提示就做两件事，别的都不做：
#
#   1. 这个 agent 在解除时间之前不再派新活（整台机器、同一个账号目录共用一份暂停记录；别的 agent
#      照常）。排队的条目标签不动、不计派工失败，到点自动恢复。
#   2. 被打断的那一条：留言（哪个 agent、几点解除、标签改回哪个）→ 加 pending/human → 摘 doing/agent。
#      不往会话里送字、不停进程、不关会话、不自己续接。
#
# 几条规矩（每一条都是方案复审里踩出来的，改之前先读 tests/usage-limit.test.sh 对应那组）：
#   · 认定要四样齐：屏幕最后一块是上限提示（规则在 usage_limit.py，按真实截屏写的）、agent 空闲、
#     会话是本项目登记的那条且它的记录里模型回复 / 工具输出都没有这句、连续两轮屏幕和记录都没变。
#     任何一样读不到 = 证据不足 = 什么都不做（和没开这项功能一样）。
#   · 暂停只按时刻结束，或由人删掉记录文件。不因为「别的会话在忙」提前结束：忙是按终端文字判的，
#     证明不了额度恢复，还会被另一个账号的会话误清。
#   · 转人工的三次写入，每一次之前都重读条目、PR、标签事件和本机会话，和认定时记下的那份整份比对。
#     只允许多出 daemon 自己上一步写的标签（按标签事件的操作人和「先记意图再写」的记录认）。
#     确认变了 → 停手，不补偿（不摘回标签、不补留言）；读不到 → 本轮不写，记录留着下一轮再来。
#   · 这里不做任何会改并发名额的事：三步期间条目一直挂 doing/agent，摘掉之后名额才空出。
ENABLE_USAGE_LIMIT_PAUSE="${ENABLE_USAGE_LIMIT_PAUSE:-}"
USAGE_LIMIT_FALLBACK_SECS="${USAGE_LIMIT_FALLBACK_SECS:-3600}"
case "$USAGE_LIMIT_FALLBACK_SECS" in ''|*[!0-9]*) USAGE_LIMIT_FALLBACK_SECS=3600 ;; esac
if [ "$USAGE_LIMIT_FALLBACK_SECS" -lt 60 ] || [ "$USAGE_LIMIT_FALLBACK_SECS" -gt 604800 ]; then USAGE_LIMIT_FALLBACK_SECS=3600; fi
USAGE_LIMIT_MAX_AHEAD=$((8 * 86400 + 3600))   # 比这还远的暂停不是本程序写的 → 当作没有
USAGE_LIMIT_PACE_SECS=120                      # 有暂停 / 有没做完的转人工时，轮询最慢多久一轮
USAGE_LIMIT_WRITE_TRIES=10                     # 同一条的写入累计失败这么多次就停手
USAGE_LIMIT_MARK='agent-usage-limit'
USAGE_LIMIT_WAITING=0
USAGE_LIMIT_ACTED=0
USAGE_LIMIT_SKIPPED=""
USAGE_LIMIT_UNTIL=""
USAGE_LIMIT_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/usage_limit.py"
declare -A _USAGE_LIMIT_INFO=()
declare -A _USAGE_LIMIT_PAUSE=()
declare -A _USAGE_LIMIT_SAID=()

usage_limit_enabled() {
    case "$(printf '%s' "${ENABLE_USAGE_LIMIT_PAUSE:-}" | tr '[:upper:]' '[:lower:]')" in
        true|1|yes|on) return 0 ;;
    esac
    return 1
}

# 当前时刻：和轮询节奏用同一个来源（测试用 POLL_FAKE_NOW 拨钟，样本屏上的解除时间是写死的）。
usage_limit_now() { pace_now; }

usage_limit_clock() {   # <epoch> → 给人看的本机时间
    printf '%(%Y-%m-%d %H:%M %z)T' "$1"
}

usage_limit_file() { printf '%s\n' "$STATE_DIR/usage-limit.json"; }

usage_limit_get() {   # <jq 表达式> [jq 参数…] → stdout（文件不在 / 读不出当空对象）
    local f; f="$(usage_limit_file)"
    if [ -s "$f" ] && jq -e 'type == "object"' "$f" >/dev/null 2>&1; then
        jq -r "${@:2}" "$1" "$f"
    else
        jq -rn "${@:2}" "{} | $1"
    fi
}

usage_limit_put() {   # <jq 表达式> [jq 参数…]
    local f tmp; f="$(usage_limit_file)"
    tmp="$(mktemp "$f.XXXXXX")" || return 1
    if [ -s "$f" ] && jq -e 'type == "object"' "$f" >/dev/null 2>&1; then
        jq "${@:2}" "$1" "$f" > "$tmp" || { rm -f "$tmp"; return 1; }
    else
        jq -n "${@:2}" "{} | $1" > "$tmp" || { rm -f "$tmp"; return 1; }
    fi
    mv "$tmp" "$f"
}

# 同一句话同一轮只说一次（暂停记录读不出这类，每个派工入口都会碰到）
usage_limit_say_once() {   # <键> <日志>
    [ -z "${_USAGE_LIMIT_SAID[$1]:-}" ] || return 0
    _USAGE_LIMIT_SAID[$1]=1
    log "$2"
}

# 这个 agent 支不支持认上限、账号目录在哪。设 UL_KIND / UL_ACCOUNT；不支持返回 1。
# 放在子 shell 里加载它的 driver：轮询进程自己加载的是默认 worker 的 driver，复审可能是另一个 agent，
# 在本进程里换 driver 会把默认 worker 的函数全盖掉。
usage_limit_agent_info() {   # <agent>
    local a="$1" out
    if [ -z "${_USAGE_LIMIT_INFO[$a]+x}" ]; then
        out="$( (
            source_driver "$a" >/dev/null 2>&1 || exit 0
            [ -n "${AGENT_USAGE_LIMIT:-}" ] || exit 0
            declare -F agent_account_dir >/dev/null && declare -F agent_session_record >/dev/null || exit 0
            printf '%s\t%s' "$AGENT_USAGE_LIMIT" "$(agent_account_dir)"
        ) 2>/dev/null )" || out=""
        _USAGE_LIMIT_INFO[$a]="$out"
    fi
    out="${_USAGE_LIMIT_INFO[$a]}"
    UL_KIND="${out%%$'\t'*}"; UL_ACCOUNT="${out#*$'\t'}"
    [ -n "$out" ] && [ -n "$UL_KIND" ] && [ -n "$UL_ACCOUNT" ] && [ "$UL_ACCOUNT" != "$out" ]
}

usage_limit_pause_file() {   # <agent> → 暂停记录文件（整机共用，一个 agent + 账号目录一个）
    usage_limit_agent_info "$1" || return 1
    local h
    h="$(printf '%s' "$UL_ACCOUNT" | _pace_hash | cut -c1-12)"
    printf '%s/%s-%s.json\n' "$CAVIL_USAGE_LIMIT_DIR" "$1" "$h"
}

# 这个 agent 现在是不是在暂停中。是 → 返回 0，USAGE_LIMIT_UNTIL = 解除时刻。
# 读不出的记录按「没有暂停」：最坏是派出去再撞一次、再被认出来；按「暂停」处理则是整个项目悄悄停摆。
usage_limit_paused() {   # <agent>
    local a="$1" f until now
    USAGE_LIMIT_UNTIL=""
    if [ -z "${_USAGE_LIMIT_PAUSE[$a]+x}" ]; then
        until=0
        if f="$(usage_limit_pause_file "$a")" && [ -e "$f" ]; then
            if until="$(jq -er '.until | select(type == "number") | floor' "$f" 2>/dev/null)"; then
                now="$(usage_limit_now)"
                if [ "$until" -le "$now" ]; then
                    until=0
                elif [ $((until - now)) -gt "$USAGE_LIMIT_MAX_AHEAD" ]; then
                    usage_limit_say_once "far-$a" "⚠️ 用量上限：$a 的暂停记录 $f 写着 $(usage_limit_clock "$until")，超出合理范围，按「没有暂停」处理"
                    until=0
                fi
            else
                usage_limit_say_once "bad-$a" "⚠️ 用量上限：$a 的暂停记录 $f 读不出，按「没有暂停」处理"
                until=0
            fi
        fi
        _USAGE_LIMIT_PAUSE[$a]="$until"
    fi
    until="${_USAGE_LIMIT_PAUSE[$a]}"
    [ "$until" -gt 0 ] || return 1
    USAGE_LIMIT_UNTIL="$until"
    return 0
}

# 记下暂停。只往后延：已经有一条更晚、仍有效的就留着它。几个项目的轮询会同时写，所以加锁、整文件替换。
usage_limit_pause_set() {   # <agent> <解除时刻> <来源 screen|fallback> <哪个条目>
    local a="$1" until="$2" src="$3" item="$4" f now rc=0
    f="$(usage_limit_pause_file "$a")" || return 1
    usage_limit_agent_info "$a" || return 1   # 上一行在子 shell 里，UL_ACCOUNT 要在本 shell 再取一次
    mkdir -p "$CAVIL_USAGE_LIMIT_DIR" || return 1
    now="$(usage_limit_now)"
    (
        flock -w 10 7 || exit 1
        cur="$(jq -er '.until | select(type == "number") | floor' "$f" 2>/dev/null)" || cur=0
        if [ "$cur" -ge "$until" ] && [ $((cur - now)) -le "$USAGE_LIMIT_MAX_AHEAD" ]; then exit 3; fi
        tmp="$(mktemp "$f.XXXXXX")" || exit 1
        jq -n --arg agent "$a" --arg account "$UL_ACCOUNT" --argjson until "$until" --arg source "$src" \
              --arg item "$item" --argjson seen "$now" --arg host "$SELFHEAL_HOST_ID" \
              '{agent: $agent, account: $account, until: $until, source: $source, item: $item, seen: $seen, host: $host}' \
              > "$tmp" || { rm -f "$tmp"; exit 1; }
        mv "$tmp" "$f"
    ) 7>"$CAVIL_USAGE_LIMIT_DIR/.lock" || rc=$?
    case "$rc" in
        0) _USAGE_LIMIT_PAUSE[$a]="$until"; return 0 ;;
        3) unset "_USAGE_LIMIT_PAUSE[$a]"; return 3 ;;   # 已有更晚的：没写，下次读文件为准
        *) return 1 ;;
    esac
}

# 派工前的闸门：这次派工要用的 agent 在暂停中 → 返回 0（调用方跳过这一条，什么都不改）。
# 所有派工入口（新 issue、issue 评论、PR 评论、复审、往已有会话注入）都过这一个函数。
usage_limit_gate() {   # <agent（空 = 默认 worker）> <条目称呼>
    usage_limit_enabled || return 1
    local a="${1:-$WORKER_AGENT_DEFAULT}"
    usage_limit_paused "$a" || return 1
    USAGE_LIMIT_SKIPPED+="${a}"$'\t'"${USAGE_LIMIT_UNTIL}"$'\t'"${2}"$'\n'
    USAGE_LIMIT_WAITING=1
    return 0
}

usage_limit_skip_summary() {
    [ -n "$USAGE_LIMIT_SKIPPED" ] || return 0
    local a until items
    while IFS=$'\t' read -r a until; do
        [ -n "$a" ] || continue
        items="$(printf '%s' "$USAGE_LIMIT_SKIPPED" | awk -F'\t' -v a="$a" '$1 == a { printf "%s%s", (n++ ? "、" : ""), $3 }')"
        log "⏸ 用量上限：$a 暂停派工到 $(usage_limit_clock "$until")，本轮跳过（标签不动、不计失败）：$items"
    done < <(printf '%s' "$USAGE_LIMIT_SKIPPED" | cut -f1,2 | awk '!seen[$0]++')
    return 0
}

# 派工成功后记下这次派工的开始时刻：核对会话记录时只看这之后的内容（之前几轮的对话里
# 引用过这句话不算数）。功能关着时不写任何东西。
usage_limit_note_dispatch() {   # <工作编号> <开始时刻>
    usage_limit_enabled || return 0
    usage_limit_put '.dispatched[$k] = $t' --arg k "$1" --argjson t "$2" || true
}

# 除了 doing/agent 之外的流程标签（JSON 数组）。条目上挂着其中任何一个 = 已经在别的流程里，不转人工。
usage_limit_other_flow_labels() {
    [ -n "${TRIGGER_LABELS_ALL+x}" ] || trigger_labels_array
    printf '%s\n' "$LABEL_PENDING_HUMAN" "$LABEL_DONE" "$LABEL_PENDING_PR" "${LABEL_PENDING_REVIEW:-}" \
        "${LABEL_PENDING_MERGE:-}" "${LABEL_PENDING_BLOCKED:-}" "${LABEL_PENDING_REQUESTER_BOT:-}" "${TRIGGER_LABELS_ALL[@]}" \
        | awk 'NF && !seen[$0]++' | jq -Rsc 'split("\n") | map(select(. != ""))'
}

# 条目现在的样子（重读 GitHub）。stdout 一行 JSON；读不到 / 缺字段返回 2。
usage_limit_item_doc() {   # <issue|pr> <编号>
    local kind="$1" num="$2" ij pj doc
    ij="$(gh api "repos/$REPO/issues/$num" 2>/dev/null)" || return 2
    doc="$(printf '%s' "$ij" | jq -ce '
        if (.state | type) != "string" or (.labels | type) != "array" then error("shape") else
        {state: .state, is_pr: (.pull_request != null), labels: ([.labels[].name] | sort)} end' 2>/dev/null)" || return 2
    if [ "$kind" = pr ]; then
        pj="$(gh api "repos/$REPO/pulls/$num" 2>/dev/null)" || return 2
        doc="$(printf '%s' "$pj" | jq -ce --argjson d "$doc" '
            if (.base.ref | type) != "string" or (.head.sha | type) != "string" or (.head.ref | type) != "string"
               or ((.merged // false) | type) != "boolean" then error("shape") else
            $d + {merged: (.merged // false), base: .base.ref, head: .head.sha, ref: .head.ref,
                  src: (.head.repo.full_name // "")} end' 2>/dev/null)" || return 2
    fi
    printf '%s\n' "$doc"
}

# 条目的标签事件（加 / 摘），按编号排好。读不到、缺编号或缺操作人返回 2。
usage_limit_label_events() {   # <编号>
    local ev
    ev="$(gh api --paginate --slurp "repos/$REPO/issues/$1/events" 2>/dev/null)" || return 2
    printf '%s' "$ev" | jq -ce '
        if type != "array" or any(.[]; type != "array") then error("shape") else
        [ .[][] | select(.event == "labeled" or .event == "unlabeled")
          | {id: .id, e: .event, l: .label.name, a: .actor.login} ]
        | if any(.[]; (.id | type) != "number" or (.l | type) != "string" or (.a | type) != "string")
          then error("shape") else sort_by(.id) end end' 2>/dev/null || return 2
}

# 本机这一侧现在的样子：会话、登记的工作窗格、窗格里那个进程（进程号 + 启动时刻）、agent 与角色、
# 这个角色登记的 agent 会话编号、派工归属、触发标签。
# 窗格编号不变不等于还是撞上限的那个 worker：换 agent / 换角色 / 续接失败降级都是在**原窗格**里
# 换程序（worker_session_launch 的 respawn-pane），角色登记的会话编号也会跟着换。所以进程和登记都
# 进这份身份（代码复审第 1 轮：只比窗格编号时，新起的正常 worker 被当成旧的上限事件转给了人）。
# 进程号会被系统复用，所以带上启动时刻；读不出启动时刻算读不到，不算「没变」。
# stdout 一行 JSON。会话 / 窗格确定不在了返回 1；读不到返回 2。
usage_limit_local_doc() {   # <工作编号>
    local work="$1" sess st pane pid dead pipe agent role host trigger started sid rc=0
    sess="$(tmux_session_name "$work")"
    worker_session_exists "$sess" || rc=$?
    [ "$rc" = 0 ] || return "$rc"
    agent="$(tmux show-options -qv -t "=$sess:" @worker_agent 2>/dev/null)" || return 2
    role="$(tmux show-options -qv -t "=$sess:" @worker_role 2>/dev/null)" || return 2
    [ -n "$agent" ] || agent="$WORKER_AGENT_DEFAULT"
    [ -n "$role" ] || role="worker"
    read -r st pane pid dead pipe <<<"$(worker_pane_lookup "$sess")"
    case "$st" in
        found|single) ;;
        gone) return 1 ;;
        *) return 2 ;;
    esac
    [ "$dead" = 0 ] || return 1
    started="$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//')" || return 2
    [ -n "$started" ] || return 2
    sid="$(agent_session_id_get "$work" "$agent" "$role")" || return 2
    host="$(jq -er --arg k "$work" '.worker_hosts[$k] // ""' "$STATE_FILE" 2>/dev/null)" || return 2
    trigger="$(jq -er --arg k "$work" '.worker_trigger_labels[$k] // ""' "$STATE_FILE" 2>/dev/null)" || return 2
    jq -cn --arg sess "$sess" --arg pane "$pane" --arg agent "$agent" --arg role "$role" \
           --arg host "$host" --arg trigger "$trigger" --arg pid "$pid" --arg started "$started" --arg sid "$sid" \
           '{sess: $sess, pane: $pane, pid: $pid, started: $started, agent: $agent, role: $role, sid: $sid,
             host: $host, trigger: $trigger}'
}

# 把 usage_limit_local_doc 的结果摊到 UL_PANE / UL_AGENT / UL_ROLE（那个函数总在 $( ) 里调，设不了全局）
usage_limit_use_loc() {   # <local doc JSON>
    UL_PANE="$(printf '%s' "$1" | jq -r '.pane // ""')"
    UL_AGENT="$(printf '%s' "$1" | jq -r '.agent // ""')"
    UL_ROLE="$(printf '%s' "$1" | jq -r '.role // ""')"
    [ -n "$UL_PANE" ] && [ -n "$UL_AGENT" ]
}

# 看一眼这个会话的屏幕（和会话记录）。stdout 是 usage_limit.py 的那一行 JSON。
#   返回 0 = 认定是上限（verdict=limit）；1 = 不是；2 = 像但证据不足 / 读不到（stdout 仍可能有 reason）
# 要先调过 usage_limit_use_loc（用它设的 UL_PANE / UL_AGENT / UL_ROLE）。
usage_limit_look() {   # <工作编号> [screen-only]
    local work="$1" only="${2:-}" screen sfile info busy record sid wt since out verdict rc=1
    screen="$(tmux capture-pane -p -t "$UL_PANE" 2>/dev/null)" || return 2
    # 屏上根本没有这句话：绝大多数轮次到这里就结束，不加载 driver、不起 python、不读会话记录
    case "$screen" in *"hit your "*) ;; *) return 1 ;; esac
    usage_limit_agent_info "$UL_AGENT" || return 1
    sid="$(agent_session_id_get "$work" "$UL_AGENT" "$UL_ROLE")"
    wt="$(worktree_path "$work")"
    info="$( (
        source_driver "$UL_AGENT" >/dev/null 2>&1 || exit 1
        b=0
        if printf '%s\n' "$screen" | tail -"${AGENT_BUSY_TAIL}" | grep -qiE "$AGENT_BUSY_RE"; then b=1; fi
        r=""
        if [ -n "$sid" ]; then r="$(agent_session_record "$wt" "$sid")"; fi
        printf '%s\t%s' "$b" "$r"
    ) 2>/dev/null )" || return 2
    busy="${info%%$'\t'*}"; record="${info#*$'\t'}"
    [ "$busy" = 0 ] || return 1
    sfile="$(mktemp)" || return 2
    printf '%s\n' "$screen" > "$sfile"
    since="$(usage_limit_get '.dispatched[$k] // 0' --arg k "$work")" || since=0
    local -a args=(detect --agent "$UL_KIND" --screen "$sfile" --since "$since"
                   --now "$(usage_limit_now)" --fallback "$USAGE_LIMIT_FALLBACK_SECS")
    if [ -z "$only" ]; then
        # 会话登记了但找不到记录文件：照样交给脚本，它会答「读不到」；没登记则不带这个参数
        if [ -n "$sid" ]; then args+=(--record "${record:-/nonexistent/usage-limit-record}"); fi
    fi
    out="$(python3 -I "$USAGE_LIMIT_SCRIPT" "${args[@]}" 2>/dev/null)" || { rm -f "$sfile"; return 2; }
    rm -f "$sfile"
    verdict="$(printf '%s' "$out" | jq -er '.verdict' 2>/dev/null)" || return 2
    printf '%s\n' "$out"
    case "$verdict" in
        limit) rc=0 ;;
        no) rc=1 ;;
        *) rc=2 ;;
    esac
    return "$rc"
}

usage_limit_comment_body() {   # <记录 JSON>
    local rec="$1" agent role until src text trigger nonce when how role_cn
    agent="$(printf '%s' "$rec" | jq -r '.agent')"; role="$(printf '%s' "$rec" | jq -r '.role')"
    until="$(printf '%s' "$rec" | jq -r '.until')"; src="$(printf '%s' "$rec" | jq -r '.src')"
    text="$(printf '%s' "$rec" | jq -r '.reset_text // ""')"; nonce="$(printf '%s' "$rec" | jq -r '.nonce')"
    trigger="$(printf '%s' "$rec" | jq -r '.ident.local.trigger // ""')"
    [ -n "$trigger" ] || trigger="$LABEL_PENDING_AGENT_DEFAULT"
    case "$role" in review) role_cn="复审" ;; *) role_cn="开发" ;; esac
    if [ "$src" = screen ]; then
        when="$(usage_limit_clock "$until")（agent 界面上写的是「${text}」）"
    else
        when="$(usage_limit_clock "$until")（界面上读不出解除时间，按固定等待 $((USAGE_LIMIT_FALLBACK_SECS / 60)) 分钟估的；到点如果还在上限里，daemon 会再认出来、再顺延）"
    fi
    how="解除时间之后，把这一条的标签从 \`$LABEL_PENDING_HUMAN\` 改回 \`$trigger\`，daemon 会照常派工并续接原来的会话。提前改回也可以，daemon 会等到解除时间再派。"
    printf '<!-- %s n=%s -->\n⚠️ **agent 撞到用量上限，这一条已转人工（`%s`）**\n\n- 撞上限的 agent：`%s`（%s）\n- 解除时间：%s\n- 在此之前 daemon 不再给这个 agent 派新活；排队的条目标签不动，到点自动恢复。\n\n**怎么继续**：%s\n\n<sub>cavil-loop daemon @ %s 自动留言</sub>' \
        "$USAGE_LIMIT_MARK" "$nonce" "$LABEL_PENDING_HUMAN" "$agent" "$role_cn" "$when" "$how" \
        "$(hostname -s 2>/dev/null || hostname)"
}

usage_limit_drop() {   # <键> <日志（空 = 不说）>
    [ -z "${2:-}" ] || log "$2"
    usage_limit_put 'del(.items[$k])' --arg k "$1" || true
}

# 停手：记录换成一块「这一屏已经处理过」的牌子（同一屏、同一份会话记录不再从头来一遍——否则
# 留过言之后停手的条目，两轮后又会被认出来、再留一条）。条目离开 doing/agent、屏幕不再是上限提示、
# 或会话记录又长了（= 之后又干过活、再撞的是新的一次）时，牌子自然作废。
usage_limit_close() {   # <键> <日志>
    [ -z "${2:-}" ] || log "$2"
    usage_limit_put '.items[$k] = {step: -1, fp: (.items[$k].fp // ""), rsize: (.items[$k].rsize // -1)}' --arg k "$1" || true
}

# 转人工：从记录里的那一步接着做。每圈重读一遍、最多做一次写入，直到做完、停手或读不到。
usage_limit_handoff() {   # <issue|pr> <编号>
    local kind="$1" num="$2" key="$1:$2" name rec work step item loc evs me base_ev base_cm ident phase
    local human="$LABEL_PENDING_HUMAN" doing="$LABEL_AGENT_DOING" out rc round tries cid body look
    local UL_PANE="" UL_AGENT="" UL_ROLE=""
    [ "$kind" = pr ] && name="PR #$num" || name="issue #$num"
    USAGE_LIMIT_WAITING=1
    for round in 1 2 3 4 5 6 7 8; do
        rec="$(usage_limit_get '.items[$k] // empty | tojson' --arg k "$key")"
        [ -n "$rec" ] || return 0
        work="$(printf '%s' "$rec" | jq -r '.work')"
        step="$(printf '%s' "$rec" | jq -r '.step')"
        tries="$(printf '%s' "$rec" | jq -r '.tries // 0')"
        if [ "$tries" -ge "$USAGE_LIMIT_WRITE_TRIES" ]; then
            usage_limit_close "$key" "⚠️ 用量上限：$name 转人工的写入累计失败 $tries 次 → 停手，条目留在现在的标签上，请人工处理"
            return 0
        fi

        # ── 重读：条目、本机会话、标签事件、写身份 ──
        item="$(usage_limit_item_doc "$kind" "$num")" || {
            log "  用量上限：$name 的条目读不到，本轮不写（转人工停在第 $step 步，下轮接着）"; return 0; }
        rc=0; loc="$(usage_limit_local_doc "$work")" || rc=$?
        if [ "$rc" = 2 ]; then
            log "  用量上限：$name 的本机会话读不到（tmux），本轮不写（转人工停在第 $step 步，下轮接着）"; return 0
        fi
        [ "$rc" = 0 ] || loc='{"gone":true}'
        evs="$(usage_limit_label_events "$num")" || {
            log "  用量上限：$name 的标签事件读不到，本轮不写（转人工停在第 $step 步，下轮接着）"; return 0; }
        me="$(write_identity_login)"
        [ -n "$me" ] || { log "  用量上限：读不到 daemon 写身份的账号名，本轮不写（$name 转人工停在第 $step 步）"; return 0; }

        ident="$(printf '%s' "$rec" | jq -c '.ident // empty')"
        if [ -z "$ident" ]; then
            # 第一次：记下认定时的样子和基线（之后的每一步都和它比）
            if ! printf '%s' "$item" | jq -e --arg d "$doing" --argjson flow "$(usage_limit_other_flow_labels)" \
                    '.state == "open" and (.merged // false) == false
                     and (.labels | index($d)) != null and ((.labels - (.labels - $flow)) | length) == 0' >/dev/null 2>&1; then
                usage_limit_close "$key" "用量上限：$name 不转人工——已关闭 / 已合并，或标签不是单独一个 $doing（现在是：$(printf '%s' "$item" | jq -r '.labels | join(", ")')）。暂停派工不受影响"
                return 0
            fi
            if [ "$rc" != 0 ] || [ "$(printf '%s' "$loc" | jq -r '.host')" != "$SELFHEAL_HOST_ID" ]; then
                usage_limit_close "$key" "用量上限：$name 不转人工——本机会话不在了，或派工归属不是本机"
                return 0
            fi
            base_cm="$(gh api --paginate "repos/$REPO/issues/$num/comments" --jq '.[] | .id' 2>/dev/null | tail -n1)" || {
                log "  用量上限：$name 的评论读不到，本轮不写（下轮接着）"; return 0; }
            base_ev="$(printf '%s' "$evs" | jq -r '(map(.id) | max) // 0')"
            usage_limit_put '.items[$k].ident = {item: $i, local: $l} | .items[$k].base_ev = $e | .items[$k].base_cm = $c' \
                --arg k "$key" --argjson i "$item" --argjson l "$loc" --argjson e "$base_ev" --argjson c "${base_cm:-0}" || return 0
            continue
        fi
        base_ev="$(printf '%s' "$rec" | jq -r '.base_ev')"; base_cm="$(printf '%s' "$rec" | jq -r '.base_cm')"

        # ── 比对：除了 daemon 自己写的标签，别的必须和认定时一模一样 ──
        phase="$(jq -rn --argjson id "$ident" --argjson item "$item" --argjson loc "$loc" --argjson evs "$evs" \
                    --argjson base "$base_ev" --arg me "$me" --arg human "$human" --arg doing "$doing" '
            ($id.item.labels) as $l0 | (($l0 + [$human]) | unique) as $l1 | ($l1 - [$doing]) as $l2
            | [ $evs[] | select(.id > $base) | {e, l, a} ] as $new
            | {e: "labeled", l: $human, a: $me} as $e1 | {e: "unlabeled", l: $doing, a: $me} as $e2
            | if ($item | del(.labels)) != ($id.item | del(.labels)) then "changed:条目变了（开闭、合并、目标分支、最新提交或来源）"
              # 三次写入都已经在 GitHub 上了：本机会话之后怎么样（比如被完工回收关掉）不再相干
              elif $item.labels == $l2 and $new == [$e1, $e2] then "C"
              elif $loc != $id.local then "changed:本机会话、工作窗格、窗格里的进程、agent、角色、登记的会话编号、派工归属或触发标签变了"
              elif $item.labels == $l0 and $new == [] then "A"
              elif $item.labels == $l1 and $new == [$e1] then "B"
              else "changed:标签被改过（现在是：" + ($item.labels | join(", ")) + "）" end')" || return 0
        case "$phase" in
            changed:*)
                usage_limit_close "$key" "用量上限：$name 转人工停手（做到第 $step 步）——${phase#changed:}。已经写上去的不撤回，之后不再写"
                return 0 ;;
        esac

        case "$step:$phase" in
            1:A)
                # ① 留言。上一轮可能已经发出去、只是没收到回应：先按随机编号找
                cid=""
                if [ "$(printf '%s' "$rec" | jq -r '.c_tried // 0')" = 1 ]; then
                    out="$(gh api --paginate --slurp "repos/$REPO/issues/$num/comments" 2>/dev/null)" || {
                        log "  用量上限：$name 的评论读不到，本轮不写（下轮接着）"; return 0; }
                    cid="$(printf '%s' "$out" | jq -er --argjson base "$base_cm" --arg me "$me" \
                            --arg mark "<!-- $USAGE_LIMIT_MARK n=$(printf '%s' "$rec" | jq -r '.nonce') -->" '
                        if type != "array" or any(.[]; type != "array") then error("shape") else
                        [ .[][] | select(.id > $base and .user.login == $me and (.body | contains($mark))) | .id ] | (.[0] // "") end' \
                        2>/dev/null)" || { log "  用量上限：$name 的评论读不全，本轮不写（下轮接着）"; return 0; }
                fi
                if [ -z "$cid" ]; then
                    usage_limit_use_loc "$loc" || { log "  用量上限：$name 的本机会话读不全，本轮不写（下轮接着）"; return 0; }
                    rc=0; look="$(usage_limit_look "$work" screen-only)" || rc=$?
                    if [ "$rc" = 2 ] && [ -z "$look" ]; then
                        log "  用量上限：$name 的屏幕读不到，本轮不写（下轮接着）"; return 0
                    fi
                    if [ "$(printf '%s' "$look" | jq -r '.fingerprint // ""' 2>/dev/null)" != "$(printf '%s' "$rec" | jq -r '.fp')" ]; then
                        usage_limit_close "$key" "用量上限：$name 转人工停手——屏幕已经不是那条上限提示（agent 又动了）。什么都没写"
                        return 0
                    fi
                    usage_limit_put '.items[$k].c_tried = 1' --arg k "$key" || return 0
                    body="$(usage_limit_comment_body "$rec")"
                    if ! out="$(gh_write api -X POST "repos/$REPO/issues/$num/comments" -f "body=$body" 2>&1)"; then
                        log "  ⚠️ 用量上限：$name 留言失败，下轮再试：$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
                        usage_limit_put '.items[$k].tries = ((.items[$k].tries // 0) + 1)' --arg k "$key" || true
                        return 0
                    fi
                    cid="$(printf '%s' "$out" | jq -r '.id // empty' 2>/dev/null)" || cid=""
                    [ -n "$cid" ] || cid=0
                fi
                USAGE_LIMIT_ACTED=1
                usage_limit_put '.items[$k].comment_id = $c | .items[$k].step = 2' --arg k "$key" --argjson c "$cid" || return 0
                ;;
            2:A)
                # ② 加 pending/human（意图在进这一步时已经记下）
                if ! out="$(gh_write api -X POST "repos/$REPO/issues/$num/labels" -f "labels[]=$human" 2>&1)"; then
                    log "  ⚠️ 用量上限：$name 加 $human 失败，下轮再核对：$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
                    usage_limit_put '.items[$k].tries = ((.items[$k].tries // 0) + 1)' --arg k "$key" || true
                    return 0
                fi
                USAGE_LIMIT_ACTED=1
                ;;
            2:B)
                usage_limit_put '.items[$k].step = 3' --arg k "$key" || return 0
                ;;
            3:B)
                # ③ 摘 doing/agent。404 = 已经不在了，下一圈重读时自然会分清是谁摘的
                if ! out="$(gh_write api -X DELETE "repos/$REPO/issues/$num/labels/$(printf '%s' "$doing" | jq -sRr @uri)" 2>&1)" \
                   && ! printf '%s' "$out" | grep -q 'HTTP 404'; then
                    log "  ⚠️ 用量上限：$name 摘 $doing 失败，下轮再核对：$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
                    usage_limit_put '.items[$k].tries = ((.items[$k].tries // 0) + 1)' --arg k "$key" || true
                    return 0
                fi
                USAGE_LIMIT_ACTED=1
                ;;
            3:C)
                usage_limit_drop "$key" "⏸ 用量上限：$name 已留言并转人工（$doing → $human），会话原样留着；解除后由人把标签改回 $(printf '%s' "$ident" | jq -r '.local.trigger | if . == "" then "派工标签" else . end')"
                return 0 ;;
            *)
                usage_limit_close "$key" "用量上限：$name 转人工停手（记录在第 $step 步，条目却已经是另一个样子）——标签不是 daemon 这一步写成的。之后不再写"
                return 0 ;;
        esac
    done
    return 0
}

# 每轮一次：先把没做完的转人工接着做，再看本机派出去、挂着 doing/agent 的会话。
usage_limit_tick() {
    usage_limit_enabled || return 0
    local rows="" kind num branch labels work key rec rc look loc fp rsize until src text note seen_keys=" " n agent
    local UL_PANE="" UL_AGENT="" UL_ROLE=""
    local -A work_count=()

    # 没做完的转人工：条目这一轮还挂不挂 doing/agent 都要接着核对（摘掉它的可能正是 daemon 自己）
    while IFS= read -r key; do
        [ -n "$key" ] || continue
        usage_limit_handoff "${key%%:*}" "${key#*:}"
        seen_keys+="$key "
    done < <(usage_limit_get '(.items // {}) | to_entries[] | select((.value.step // 0) >= 1) | .key')

    rows+="$(snapshot_rows issue "$LABEL_AGENT_DOING" 2>/dev/null | awk -F'\t' '{print "issue\t" $1 "\t" $2}')"$'\n' || true
    rows+="$(snapshot_rows pr "$LABEL_AGENT_DOING" 2>/dev/null | awk -F'\t' '{print "pr\t" $1 "\t" $2}')"$'\n' || true
    # 同一个工作编号下 issue 和 PR 都挂着 doing/agent：分不清会话在干哪一条，都不碰
    while IFS=$'\t' read -r kind num branch; do
        [ -n "$num" ] || continue
        if [ "$kind" = pr ]; then work="$(pr_to_issue_num "$num" "$branch")"; else work="$num"; fi
        work_count[$work]=$(( ${work_count[$work]:-0} + 1 ))
    done <<< "$rows"

    while IFS=$'\t' read -r kind num branch; do
        [ -n "$num" ] || continue
        key="$kind:$num"
        case "$seen_keys" in *" $key "*) continue ;; esac
        seen_keys+="$key "
        if [ "$kind" = pr ]; then work="$(pr_to_issue_num "$num" "$branch")"; n="PR #$num"; else work="$num"; n="issue #$num"; fi
        rec="$(usage_limit_get '.items[$k] // empty | tojson' --arg k "$key")"
        if [ "${work_count[$work]:-0}" -gt 1 ] \
           || [ "$(jq -r --arg k "$work" '.worker_hosts[$k] // ""' "$STATE_FILE" 2>/dev/null)" != "$SELFHEAL_HOST_ID" ]; then
            [ -z "$rec" ] || usage_limit_drop "$key" ""
            continue
        fi
        rc=0; loc="$(usage_limit_local_doc "$work")" || rc=$?
        look=""
        if [ "$rc" = 0 ]; then usage_limit_use_loc "$loc" || rc=2; fi
        if [ "$rc" = 0 ]; then look="$(usage_limit_look "$work")" || rc=$?; fi
        case "$rc" in
            0) ;;
            1) [ -z "$rec" ] || usage_limit_drop "$key" ""
               continue ;;
            *) # 像上限但证据不足 / 读不到：什么都不做。同一个原因只说一次
               note="$(printf '%s' "$look" | jq -r '.reason // ""' 2>/dev/null)" || note=""
               if [ -n "$note" ] && [ "$(printf '%s' "${rec:-null}" | jq -r '.note? // ""' 2>/dev/null)" != "$note" ]; then
                   log "用量上限：$n 的屏幕像是撞了上限，但证据不足（$note）→ 不暂停、不转人工"
                   usage_limit_put '.items[$k] = {step: 0, note: $n}' --arg k "$key" --arg n "$note" || true
               fi
               continue ;;
        esac
        fp="$(printf '%s' "$look" | jq -r '.fingerprint')"; rsize="$(printf '%s' "$look" | jq -r '.record_size')"
        if [ -n "$rec" ] && [ "$(printf '%s' "$rec" | jq -r '.step // 0')" = -1 ] \
           && [ "$(printf '%s' "$rec" | jq -r '.fp // ""')" = "$fp" ] \
           && [ "$(printf '%s' "$rec" | jq -r '.rsize // ""')" = "$rsize" ]; then
            continue   # 这一屏已经处理过（转人工停手了）：不从头再来
        fi
        if [ -z "$rec" ] || [ "$(printf '%s' "$rec" | jq -r '.step // 0')" != 0 ] \
           || [ "$(printf '%s' "$rec" | jq -r '.fp // ""')" != "$fp" ] \
           || [ "$(printf '%s' "$rec" | jq -r '.rsize // ""')" != "$rsize" ]; then
            # 第一次看到（或者和上一轮不一样）：记下，下一轮屏幕和会话记录都没变才算数
            log "用量上限：$n 的屏幕最后一块是上限提示（$UL_AGENT），下一轮屏幕和会话记录都没变就认定"
            usage_limit_put '.items[$k] = {step: 0, fp: $fp, rsize: $rs, seen: $t}' --arg k "$key" --arg fp "$fp" \
                --argjson rs "$rsize" --argjson t "$(usage_limit_now)" || true
            USAGE_LIMIT_WAITING=1
            continue
        fi
        # 认定
        agent="$UL_AGENT"
        until="$(printf '%s' "$look" | jq -r '.reset_epoch')"; src="$(printf '%s' "$look" | jq -r '.reset_source')"
        text="$(printf '%s' "$look" | jq -r '.reset_text // ""')"
        rc=0; usage_limit_pause_set "$agent" "$until" "$src" "$REPO $n" || rc=$?
        case "$rc" in
            0) if [ "$src" = screen ]; then
                   log "⏸ 用量上限：$agent 撞到用量上限（$n），暂停派工到 $(usage_limit_clock "$until")（读自界面「$text」，会话记录已核对）"
               else
                   log "⏸ 用量上限：$agent 撞到用量上限（$n），界面上读不出解除时间，按固定等待暂停派工到 $(usage_limit_clock "$until")"
               fi ;;
            3) ;;
            *) log "  ⚠️ 用量上限：$agent 的暂停记录写不进去（$CAVIL_USAGE_LIMIT_DIR），本轮不转人工，下轮再试"
               continue ;;
        esac
        USAGE_LIMIT_ACTED=1
        usage_limit_put '.items[$k] = {step: 1, work: $w, agent: $a, role: $r, fp: $fp, rsize: $rs, until: $u, src: $s, reset_text: $x, nonce: $n}' \
            --arg k "$key" --arg w "$work" --arg a "$agent" --arg r "$UL_ROLE" --arg fp "$fp" --argjson rs "$rsize" --argjson u "$until" \
            --arg s "$src" --arg x "$text" --arg n "$(agent_session_new_uuid)" || continue
        usage_limit_handoff "$kind" "$num"
    done <<< "$rows"

    # 已经不挂 doing/agent 的观察记录和「处理过」的牌子不留
    while IFS= read -r key; do
        [ -n "$key" ] || continue
        case "$seen_keys" in *" $key "*) ;; *) usage_limit_drop "$key" "" ;; esac
    done < <(usage_limit_get '(.items // {}) | to_entries[] | select((.value.step // 0) <= 0) | .key')

    # 本项目会用到的 agent 里有在暂停的：下一轮别退避得太远，到点好恢复
    for agent in "$WORKER_AGENT_DEFAULT" "${REVIEW_WORKER_AGENT:-}" "${FABLE_WORKER_AGENT:-}"; do
        [ -n "$agent" ] || continue
        if usage_limit_paused "$agent"; then USAGE_LIMIT_WAITING=1; fi
    done
    if [ -n "$(usage_limit_get '(.items // {}) | to_entries[] | select((.value.step // 0) >= 0) | .key' | head -1)" ]; then USAGE_LIMIT_WAITING=1; fi
    return 0
}
