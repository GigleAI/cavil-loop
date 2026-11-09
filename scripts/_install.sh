#!/usr/bin/env bash
# 安装、状态检查、断开、换新 Mac 后台任务配置四个入口共用的判断（GitHub#313）。
#
# 每条规则只写在这里一份：setup.sh 用它判断「缺什么、生成什么」，install-status.sh 用同一份
# 规则报给客户端，launchd-refresh.sh 用同一份规则生成新的后台任务配置去比对——三处结论
# 不会各说各的。只定义变量和函数，source 时不做任何 I/O。
#
# 依赖：调用方先 source scripts/_names.sh（名字表）。

# ── 依赖清单 ──
# cavil_required_cmds <os> [agent 程序名]：按 setup.sh 一直以来的顺序逐行写出必需的命令：
# 通用工具、agent 程序（给了才写）、调度器（Linux：systemctl timeout；macOS：launchctl）。
cavil_required_cmds() {
    local os="$1" bin="${2:-}"
    printf '%s\n' git gh tmux jq flock
    [ -n "$bin" ] && printf '%s\n' "$bin"
    case "$os" in
        Linux)  printf '%s\n' systemctl timeout ;;
        Darwin) printf '%s\n' launchctl ;;
    esac
    return 0
}

# cavil_agent_deps <skill 目录> <项目根> <agent> <os>
#   按所选 agent 加载 driver（项目自带的 driver 优先，和派工同一个加载器）、取程序名、拼出依赖
#   清单并逐个 command -v。结果放进三个全局变量（所以必须在调用方自己的 shell 里调，不能放进 $( )）：
#     CAVIL_AGENT_BIN       agent 程序名
#     CAVIL_DEPS            依赖清单（数组）
#     CAVIL_DEPS_MISSING    其中本机找不到的（数组，可能为空）
#   返回 0 = 判断完成（缺不缺看 CAVIL_DEPS_MISSING）；2 = 找不到这个 agent 的 driver。
#   driver 在子 shell 里加载，不污染调用方。
cavil_agent_deps() {
    local skill_dir="$1" root="$2" agent="$3" os="$4" bin c
    CAVIL_AGENT_BIN=""; CAVIL_DEPS=(); CAVIL_DEPS_MISSING=()
    bin="$(
        # shellcheck source=drivers/_common.sh
        source "$skill_dir/scripts/drivers/_common.sh" || exit 2
        PROJECT_ROOT="$root" source_driver "$agent" || exit 2
        agent_bin
    )" || return 2
    [ -n "$bin" ] || return 2
    CAVIL_AGENT_BIN="$bin"
    while IFS= read -r c; do
        CAVIL_DEPS+=("$c")
        command -v "$c" >/dev/null 2>&1 || CAVIL_DEPS_MISSING+=("$c")
    done < <(cavil_required_cmds "$os" "$bin")
    return 0
}

# ── 后台任务用哪个 bash ──
# macOS 自带 bash 3.2 不支持 associative array，优先 homebrew bash。
cavil_bash_bin() {
    if [ "$1" = "Darwin" ] && [ -x /opt/homebrew/bin/bash ]; then
        printf '%s\n' /opt/homebrew/bin/bash
    elif command -v bash >/dev/null 2>&1; then
        command -v bash
    else
        printf '%s\n' /bin/bash
    fi
}

# ── 从项目配置里取一个整数配置（没有 / 取不到就用默认值）──
# 用 grep 而不是 source：不把别人的整份配置拉进自己的进程。
cavil_config_int() {   # <配置文件> <键> <默认值>
    local config="$1" key="$2" def="$3" v
    v=$(grep -E "^[[:space:]]*$key=" "$config" 2>/dev/null | tail -1 | sed -e 's/^[^=]*=//' -e 's/[^0-9]//g')
    case "$v" in ''|*[!0-9]*) printf '%s' "$def" ;; *) printf '%s' "$v" ;; esac
}

# ── 新旧两套名字下的后台任务名 ──
# cavil_layout_of_env <环境文件路径>：这个项目是改名前的旧安装（legacy）还是新安装（new）。
cavil_layout_of_env() {
    case "$1" in
        "$CAVIL_LEGACY_CONFIG_HOME"/*) printf '%s\n' legacy ;;
        *) printf '%s\n' new ;;
    esac
}
cavil_launchd_label()   { if [ "$1" = legacy ]; then printf '%s\n' "dev.luosky.coding-agent-work-loop.$2"; else printf '%s\n' "dev.luosky.cavil-loop.$2"; fi; }
cavil_launchd_log_dir() { if [ "$1" = legacy ]; then printf '%s\n' "$HOME/Library/Logs/coding-agent-work-loop"; else printf '%s\n' "$HOME/Library/Logs/cavil-loop"; fi; }
cavil_systemd_timer()   { if [ "$1" = legacy ]; then printf '%s\n' "$CAVIL_LEGACY_UNIT_PREFIX-poll@$2.timer"; else printf '%s\n' "$CAVIL_UNIT_PREFIX-poll@$2.timer"; fi; }

# ── 生成 launchd 后台任务配置（plist）──
# cavil_render_plist <模板> <label> <key> <skill 目录> <环境文件> <日志目录> <bash> <轮询间隔秒>
# 写到 stdout。安装（setup.sh）和换新（launchd-refresh.sh）都用它，生成的内容才比得上。
cavil_render_plist() {
    local template="$1" label="$2" key="$3" skill_dir="$4" env_file="$5" log_dir="$6" bash_bin="$7" poll="$8"
    sed \
        -e "s|{{LABEL}}|$label|g" \
        -e "s|{{KEY}}|$key|g" \
        -e "s|{{HOME}}|$HOME|g" \
        -e "s|{{SKILL_DIR}}|$skill_dir|g" \
        -e "s|{{ENV_FILE}}|$env_file|g" \
        -e "s|{{LOG_DIR}}|$log_dir|g" \
        -e "s|{{BASH_BIN}}|$bash_bin|g" \
        -e "s|{{POLL_INTERVAL}}|$poll|g" \
        "$template"
}

# ── 读调度器状态：只认已知状态词 ──
# 读失败、空输出、不认识的词一律是 unknown（「读不到」），绝不当成「已停」——
# 把读不到当成已停，调用方就会去重复登记或删文件。
# 结果放在全局变量里（在调用方自己的 shell 里调）：
#   CAVIL_SCHED_STATE   running|stopped|unknown（systemd）/ loaded|unloaded|unknown（launchd）
#   CAVIL_SCHED_RAW     读到的原文（含 stderr），给人看出错原因
#   CAVIL_SCHED_PATH    launchd 报的任务配置文件路径（读不到为空）

# systemd：定时器的 ActiveState。active / reloading = 在跑；inactive / failed = 已停。
cavil_systemd_probe() {   # <unit>
    local out rc=0
    out="$(systemctl --user show "$1" --property=ActiveState --value 2>&1)" || rc=$?
    CAVIL_SCHED_RAW="$out"; CAVIL_SCHED_PATH=""
    if [ "$rc" -ne 0 ]; then CAVIL_SCHED_STATE=unknown; return 0; fi
    case "$out" in
        active|reloading) CAVIL_SCHED_STATE=running ;;
        inactive|failed)  CAVIL_SCHED_STATE=stopped ;;
        *)                CAVIL_SCHED_STATE=unknown ;;
    esac
}
# systemd：是否开机自启。enabled = 是；disabled / not-found = 否；别的一律读不到。
cavil_systemd_enabled_probe() {   # <unit> → 写 CAVIL_SCHED_ENABLED=yes|no|unknown
    local out
    out="$(systemctl --user is-enabled "$1" 2>/dev/null)" || true
    case "$out" in
        enabled|enabled-runtime) CAVIL_SCHED_ENABLED=yes ;;
        disabled|not-found)      CAVIL_SCHED_ENABLED=no ;;
        *)                       CAVIL_SCHED_ENABLED=unknown ;;
    esac
}

# launchd：`launchctl print gui/<uid>/<label>`。退出码 0 且有输出 = 已加载；
# 退出码 113（launchd 的「找不到这个服务」）= 未加载；其余（含空输出）= 读不到。
cavil_launchd_probe() {   # <label>
    local out rc=0
    out="$(launchctl print "gui/$(id -u)/$1" 2>&1)" || rc=$?
    CAVIL_SCHED_RAW="$out"; CAVIL_SCHED_PATH=""
    if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
        CAVIL_SCHED_STATE=loaded
        CAVIL_SCHED_PATH="$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*path = //p' | head -1)"
    elif [ "$rc" -eq 113 ]; then
        CAVIL_SCHED_STATE=unloaded
    else
        CAVIL_SCHED_STATE=unknown
    fi
}
