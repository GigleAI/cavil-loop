#!/usr/bin/env bash
# 注册并起一个按需 preview（systemd socket 激活）。
#
# 用法：
#   bash scripts/preview-serve.sh <issue-number>          注册 + 起监听，打印 URL
#   bash scripts/preview-serve.sh <issue-number> --warm   顺便立刻把 app 拉起来（预热）
#   bash scripts/preview-serve.sh <issue-number> --restart 重新 build 之后用：停掉旧进程，
#                                                         让下次访问加载新产物
#   bash scripts/preview-serve.sh --list                  列出本项目所有已注册 preview
#
# 跟旧的「tmux 起一个常驻 node」相比，变化只有一处：**进程闲置 PREVIEW_IDLE 后自己退出**，
# 下次有人访问那个端口时由 systemd 重新拉起（冷启 ~1s，dist 已经 build 好，不重新 build）。
# URL 本身永远有效 —— 监听的是 .socket，不是 app 进程。
#
# 前置：setup.sh 装过 cavil-loop-preview*@ 三个 unit（改名前装的 coding-agent-preview*@ 同样认，
# 装了哪套用哪套，见 _names.sh 的 cavil_preview_unit_prefix）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _lib.sh 顶部的 `exec 9>&- 2>/dev/null` 会永久吞掉 stderr；本脚本的报错（端口被谁占了、
# 锁超时）必须让调用方看得见，所以 source 前后存还 fd 2。
exec 8>&2
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
exec 2>&8 8>&-
# shellcheck source=_preview_adopt.sh
source "$SCRIPT_DIR/_preview_adopt.sh"

PREVIEW_PORT_BASE="${PREVIEW_PORT_BASE:-4000}"
PREVIEW_BACKEND_OFFSET="${PREVIEW_BACKEND_OFFSET:-10000}"
PREVIEW_IDLE="${PREVIEW_IDLE:-30min}"
PREVIEW_EXEC="${PREVIEW_EXEC:-}"
PREVIEW_READY_TIMEOUT="${PREVIEW_READY_TIMEOUT:-90}"
PREVIEW_TAILSCALE_SERVE="${PREVIEW_TAILSCALE_SERVE:-false}"
PREVIEW_URL_HOST="${PREVIEW_URL_HOST:-}"
PREVIEW_PROBE_TIMEOUT="${PREVIEW_PROBE_TIMEOUT:-30}"

# 全新注册用的那套单元和登记目录；端口已有自己名下的登记时，下面 register_locked 会改成
# 那份登记所在的那套（旧项目的预览继续跑在旧单元上，不因为装了新单元就被切走）。
CONF_DIR="$PREVIEW_CONF_DIR"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$PREVIEW_UNIT_PREFIX"   # cavil-loop，或改名前的 coding-agent

# ── --list ──
if [ "${1:-}" = "--list" ]; then
    shopt -s nullglob
    found=0
    # 新旧两个登记目录都列：旧项目的预览登记在旧目录、跑在旧单元上
    for d in "${CAVIL_PREVIEW_DIRS[@]}"; do
        list_unit="$(cavil_preview_prefix_of_dir "$d")"
        for f in "$d"/*.conf; do
            # shellcheck disable=SC1090
            ( source "$f"
              [ "${PREVIEW_PROJECT:-}" = "$TMUX_PREFIX" ] || exit 1
              state=$(systemctl --user is-active "${list_unit}-preview-app@${PREVIEW_PORT}.service" 2>/dev/null || true)
              printf 'issue #%-5s :%-6s %-10s %s\n' \
                  "$PREVIEW_ISSUE" "$PREVIEW_PORT" "${state:-unknown}" "$PREVIEW_WORKTREE" ) && found=1
        done
    done
    [ "$found" = 0 ] && echo "（$TMUX_PREFIX 没有已注册的 preview）"
    exit 0
fi

ISSUE="${1:?need issue number（或 --list）}"
shift || true
WARM=0
RESTART=0
for arg in "$@"; do
    case "$arg" in
        --warm) WARM=1 ;;
        --restart) RESTART=1 ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

[ -n "$PREVIEW_EXEC" ] || {
    echo "❌ 项目配置（cavil-loop.config）没配 PREVIEW_EXEC —— 不知道该怎么起这个项目的 preview server。" >&2
    echo "   例：PREVIEW_EXEC=\"node server/index.mjs\"（进程需读 \$PORT / \$HOST 环境变量）" >&2
    exit 2
}

PORT="$(preview_port "$ISSUE")"
BACKEND_PORT=$((PORT + PREVIEW_BACKEND_OFFSET))
WORKTREE="$(worktree_path "$ISSUE")"

[ -d "$WORKTREE" ] || { echo "❌ worktree 不存在：$WORKTREE" >&2; exit 2; }
require_units() {
    [ -f "$UNIT_DIR/${UNIT}-preview@.socket" ] || {
        echo "❌ 没装 preview unit（$UNIT_DIR/${UNIT}-preview@.socket）。先跑 setup.sh。" >&2
        exit 2
    }
}
require_units

# 失败时把单元最后 20 行日志给调用方看，省得 worker 再去翻 journal
show_unit_log() {
    command -v journalctl >/dev/null 2>&1 || return 0
    echo "   ── journalctl --user -u $1 最后 20 行 ──" >&2
    journalctl --user -u "$1" -n 20 --no-pager 2>&1 | sed 's/^/   /' >&2 || true
}

# 对公开端口发一次 GET，输出 HTTP 状态码（连不上输出空）。不跟随跳转：3xx 本身就算能打开。
probe_http() {
    command -v curl >/dev/null 2>&1 || { echo "  ⚠️ 没有 curl，没法做预热请求" >&2; return 0; }
    curl -s -o /dev/null -w '%{http_code}' --max-time "$PREVIEW_PROBE_TIMEOUT" "http://127.0.0.1:$1/" 2>/dev/null \
        | grep -E '^[1-5][0-9][0-9]$' || true
}

# 从认主到 tailscale 绑定整段持端口锁：与 preview-unserve.sh 共用同一把，
# 并发注册 / 注册与注销交错时，登记、unit、路由三者不会落在不同主人名下。
register_locked() {
    # ── 认主（在端口锁里）──
    # 端口已登记在别人名下（取模后的同余 issue，或别的项目）→ 拒绝，报出占用方，一个字节都不写。
    # 登记在自己名下 → 照常重注册（--warm / --restart 都走这里）。
    # 新旧两个登记目录里有任何一份在别人名下都算占用。
    want="$TMUX_PREFIX|$ISSUE|$WORKTREE"
    owner="$(preview_foreign_owner "$PORT" "$want")"
    if [ -n "$owner" ]; then
        echo "❌ preview 端口 :$PORT 已被 $(preview_owner_human "$owner") 占用，$TMUX_PREFIX #$ISSUE 不注册。" >&2
        echo "   等对方注销（preview-unserve.sh --issue <它的号>），或人工处理后重跑本脚本。" >&2
        exit 2
    fi

    # 自己名下的登记还在旧目录、本机又装了新单元 → 先搬到新单元再注册（GigleAI/cavil-loop#75）：
    # 旧单元写死了旧技能入口下的脚本路径，迁移删掉旧入口后它就再也起不来。
    # 搬迁与迁移脚本是同一个函数；没搬完就到此为止，不在一个起不来的单元上给地址。
    if [ -f "$CAVIL_LEGACY_CONFIG_HOME/preview/$PORT.conf" ] && [ -e "$UNIT_DIR/$CAVIL_UNIT_PREFIX-preview@.socket" ]; then
        local arc=0
        preview_adopt_legacy "$PORT" "$UNIT_DIR" yes || arc=$?
        if [ "$arc" != 0 ]; then
            echo "❌ preview :$PORT 的旧登记没能搬到新单元（见上一行），这次不注册、不给地址；修好后重跑本脚本" >&2
            return 1
        fi
    fi

    # 自己名下已有登记 → 留在那份登记所在的那套单元上重注册
    local own_conf
    own_conf="$(preview_registrations "$PORT" | head -1 | cut -f1)"
    if [ -n "$own_conf" ]; then
        CONF_DIR="$(dirname "$own_conf")"
        UNIT="$(cavil_preview_prefix_of_dir "$CONF_DIR")"
        require_units
    fi

    # ── 写 per-port conf ──
    # 三个 unit 都 EnvironmentFile 这一个文件；端口算术只在这里做一次，
    # unit / run / wait 谁都不再自己算，避免 offset 改了漏改一处。
    mkdir -p "$CONF_DIR"
    CONF="$CONF_DIR/${PORT}.conf"
    umask 077
    # ⚠️ 值一律加双引号。这个文件有两个读者，容忍度不一样：
    #   · systemd EnvironmentFile —— 整行右侧都算 value，不加引号也对
    #   · preview-run.sh / preview-wait.sh 的 bash `source` —— 不加引号，
    #     `PREVIEW_EXEC=node srv.mjs` 会被解析成「带临时环境变量执行 srv.mjs」，
    #     报 `srv.mjs: command not found` 后 exit 127，socket 反复重试直到撞
    #     trigger limit 熄火。带空格的 PREVIEW_EXEC（几乎必然带空格）每次都踩。
    # systemd 侧认这对引号并会剥掉，两边都满足。
    cat > "$CONF" <<EOF
# 由 preview-serve.sh 生成，别手改（下次注册会覆盖）
PREVIEW_PROJECT="$TMUX_PREFIX"
PREVIEW_ISSUE="$ISSUE"
PREVIEW_PORT="$PORT"
PREVIEW_BACKEND_PORT="$BACKEND_PORT"
PREVIEW_WORKTREE="$WORKTREE"
PREVIEW_EXEC="$PREVIEW_EXEC"
PREVIEW_IDLE="$PREVIEW_IDLE"
PREVIEW_READY_TIMEOUT="$PREVIEW_READY_TIMEOUT"
PATH="$PATH"
EOF

    # ── 起监听 ──
    # start 而不是 enable：preview 是随 issue 生灭的临时物，不该在重启后自动复活
    # （worktree 那时多半已经被 cleanup 删了）。重启后要用就再跑一次本脚本。
    systemctl --user daemon-reload
    # reset-failed 不能省：app 起不来时 socket 会连续重触发，撞上 TriggerLimitBurst 后
    # 整个 socket 进 failed 且**不再接受激活**——URL 从此静默变死，且 `start` 是 no-op。
    # 修完配置重跑本脚本就该能恢复，所以先清 failed 状态再 start。
    systemctl --user reset-failed \
        "${UNIT}-preview@${PORT}.socket" \
        "${UNIT}-preview@${PORT}.service" \
        "${UNIT}-preview-app@${PORT}.service" 2>/dev/null || true
    # socket 单元的 start 成功就是已经 bind 上在听；失败（端口被占等）返回非零
    if ! systemctl --user start "${UNIT}-preview@${PORT}.socket"; then
        echo "❌ preview :$PORT 的监听 ${UNIT}-preview@${PORT}.socket 没起来，不给地址" >&2
        show_unit_log "${UNIT}-preview@${PORT}.socket"
        return 1
    fi

    # 改完代码要让 preview 反映新产物：正式 server 不热更新，进程得换一个。
    # 只 stop 不 start —— socket 还在监听，下次访问自然拉起新的（要立刻生效就配 --warm）。
    # 注意先 stop app 会连带把 proxy 拽下来（proxy Requires app），这正是想要的。
    if [ "$RESTART" = 1 ]; then
        systemctl --user stop "${UNIT}-preview-app@${PORT}.service" 2>/dev/null || true
    fi

    if [ "$WARM" = 1 ]; then
        if ! systemctl --user start "${UNIT}-preview-app@${PORT}.service"; then
            echo "❌ preview :$PORT 的 app（${UNIT}-preview-app@${PORT}.service）起不来，不给地址" >&2
            show_unit_log "${UNIT}-preview-app@${PORT}.service"
            return 1
        fi
        # 单元起来了不等于页面能打开：经公开端口真的走一遍 socket → 代理 → app
        local code
        code="$(probe_http "$PORT")"
        case "$code" in
            2??|3??) ;;
            *)  echo "❌ preview :$PORT 预热请求没拿到 2xx/3xx（实得 ${code:-连不上}），不给地址" >&2
                show_unit_log "${UNIT}-preview-app@${PORT}.service"
                return 1 ;;
        esac
    fi

    # ── tailscale serve 绑定（可选）──
    if [ "$PREVIEW_TAILSCALE_SERVE" = "true" ]; then
        if command -v tailscale >/dev/null 2>&1; then
            if ! sudo -n tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
                echo "  ⚠️ tailscale serve 绑定失败（sudo -n / 权限？）——本地 http://127.0.0.1:$PORT 仍可用" >&2
            fi
        else
            echo "  ⚠️ 没有 tailscale 命令，跳过反代绑定" >&2
        fi
    fi
}
# 必须是裸调用，别写成 `… || exit $?` / `if …`：bash 里跟在 `||` 左边（或 if 条件里）执行的
# 函数，内部的 set -e 整体失效，起不来的单元会一路被当成成功、照样打印地址
# （GigleAI/cavil-loop#75）。裸调用时任何一步失败，子 shell 带着它的退出码退出，set -e 让本脚本
# 跟着退出，后面打印地址的那几行走不到。
preview_with_port_lock "$PORT" register_locked

if [ -n "$PREVIEW_URL_HOST" ]; then
    echo "https://${PREVIEW_URL_HOST}:${PORT}/"
else
    echo "http://127.0.0.1:${PORT}/"
fi
echo "  issue #$ISSUE · 闲置 $PREVIEW_IDLE 自动停 · 再次访问自动拉起（无需重跑本脚本）" >&2
if [ "$WARM" = 1 ]; then
    echo "  已预热：经公开端口实际访问过一次，拿到 2xx/3xx" >&2
else
    echo "  只确认了监听已起来，尚未实际访问验证（要验证就加 --warm）" >&2
fi
