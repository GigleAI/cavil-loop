# shellcheck shell=bash
# 用真 tmux 的测试专用：每次运行一个自己的 tmux 服务（GitHub#647）。
#
# 为什么要有：这些测试以前都在本机默认 tmux 服务上建会话、会话名又写死，两份同时跑
# （不同 worktree，或同一 worktree 跑两次）时，一份的回收 / 清理会把另一份的会话列出来、
# 杀掉。w01 上 reap-finished-workers 跑了 587 次红了 40 次，其中 31 次另有一份在跑。
#
# 用法（顺序就是规则，tests/tmux-sandbox-guard.test.sh 会核对）：
#
#   set -uo pipefail
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"   # ① 载入：建任何东西之前
#   tmux_sandbox_on_exit my_cleanup                               # ② 登记本文件的清理（可选）
#   tmux_sandbox_start                                            # ③ 第一次用 tmux 之前
#   TMP=$(mktemp -d) || exit 1; tmux_sandbox_own_dir "$TMP"       # ④ 本次建的目录交给收尾删
#
# ① 载入只做三件事，不建任何资源：
#    - 让本测试进程成为「收养人」（Linux 的 PR_SET_CHILD_SUBREAPER）：测试里起的后台进程
#      ——tmux 服务、服务退出后留下的窗格程序——祖先一退出就过继到本进程名下，收尾时能
#      在本进程的直接子进程里看到它们。做法是用 python3 设上这个属性，再用同样的参数
#      重新执行本测试文件（进程号、环境不变，属性在重新执行后保留）。所以必须在本文件
#      建任何东西之前载入，否则那些东西会在重新执行时再建一遍。
#    - 注册本脚本自己的 EXIT 处理。各文件不要再自己 `trap … EXIT`，改用 ② 登记。
#    - 定义下面的函数。
# ② tmux_sandbox_on_exit <命令>：退出时依登记顺序执行，每一项放在单独的子 shell 里
#    （读到未赋值变量、执行了 exit，都只结束那个子 shell，不会中断后面的清理）。回调
#    在资源建出来之前就登记好，所以它要先判断资源在不在，资源不在时返回 0。回调在本测试
#    原来的选项下执行（set -u 照样生效），子 shell 里跑，改不了本进程的变量。**删目录不
#    用回调**：变量可能是从环境继承来的，回调里 `rm -rf "$TMP"` 会删掉别人的目录——用 ④。
# ④ tmux_sandbox_own_dir <目录>：mktemp 成功后立刻登记，收尾时（进程确认收干净之后）删掉
#    并核对真的没了；删不掉算清理失败。
# ③ tmux_sandbox_start：建短路径临时目录，TMUX_TMPDIR 指向它、清掉 TMUX / TMUX_PANE
#    （外层 TMUX 优先于 TMUX_TMPDIR，不清等于没隔离）；在 PATH 最前面放一个 tmux 包装，
#    每次调用都加 `-f /dev/null`——第一次起服务和中途重开都不读 /etc/tmux.conf 和用户
#    配置；起服务并建保活会话 cavil-sandbox-keep（不带测试前缀，按前缀过滤的地方看不到
#    它；测试杀光自己的会话时服务不跟着退出）。本机没有 tmux 时什么都不做（测试照旧
#    按「没有 tmux」那条路走）。任何一步失败都直接以失败退出。
#    清空环境的子进程（env -i）要带上 TMUX_TMPDIR="$TMUX_TMPDIR" 和 PATH="$PATH"。
#    测试中途服务退了，下一条 tmux 命令会在同一地址重开——允许（维护者在 #647 选的）。
#
# 退出时（尽力清理，维护者在 #647 选的 A）：
#   1. 依次跑登记的清理（各自的子 shell，失败只记一条）；
#   2. 关门：写一个标记，包装此后拒绝一切调用，不会再有经包装起的服务；
#   3. 用显式 -S 直接对真 tmux 执行 kill-server；
#   4. 结束本进程名下能看到的全部直接子进程（tmux 服务、窗格程序、没结束的后台任务）：
#      用进程句柄打开、核对父进程号仍是本进程，SIGTERM，2 秒后 SIGKILL；循环读清单，
#      直到连续 3 次读到空，总时限 10 秒；
#   5. 读到空 → 删临时目录、打印一行汇总；否则保留目录、打印剩余进程号和原因；
#   6. 删掉 ④ 登记的目录（第 5 步保留现场时一并保留）；
#   7. 退出码：原来非 0 保留原值；原来是 0、但有清理失败（回调失败、关门标记写不了、
#      目录删不掉）或沙盒没确认收干净 → 1。
#
# ⚠️ 这是尽力清理，不保证一个不漏：读清单是一个个进程地读，扫描途中正好被过继过来的
# 进程可能漏掉、也报不出来。漏下的进程不会被别的运行连上或误杀（每次运行的服务地址都
# 不一样），但会占着它自己的 CPU / 内存直到有人清理。
# 管不到的：绕过 PATH、用绝对路径调真 tmux 的调用（不受关门约束、不加 -f /dev/null；
# 守卫对测试文件里的这种写法报错，被测脚本里没有）；不经本进程起的服务（如交给 systemd）。
# 依赖：Linux（/proc、进程句柄、收养人机制）、python3 ≥ 3.9。

if [ "$(uname -s 2>/dev/null)" != Linux ]; then
    echo "tmux 沙盒：只支持 Linux（需要 /proc、进程句柄和收养人机制）" >&2
    exit 1
fi

if [ "${CAVIL_TMUX_SUBREAPER:-}" != "$$" ]; then
    # 设收养人，再用同样参数重新执行本测试文件。失败（没有 python3、prctl 被拒）就在
    # 跑任何用例之前退出——此时本文件还什么都没建。
    exec python3 -c '
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:          # PR_SET_CHILD_SUBREAPER
    sys.exit("tmux 沙盒：设收养人失败（errno %d）" % ctypes.get_errno())
os.environ["CAVIL_TMUX_SUBREAPER"] = str(os.getpid())
os.execv(sys.argv[1], sys.argv[1:])
' "$BASH" "$0" "$@" || exit 1
    echo "tmux 沙盒：没能重新执行 $0" >&2
    exit 1
fi

_TMUX_SANDBOX_DIR=""
_TMUX_SANDBOX_REAL=""
_TMUX_SANDBOX_HOOKS=()
_TMUX_SANDBOX_OWNED=()
_TMUX_SANDBOX_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tmux_sandbox_on_exit() {   # <命令>
    _TMUX_SANDBOX_HOOKS+=("$1")
}

_tmux_sandbox_fail() {
    echo "tmux 沙盒：$*" >&2
    exit 1
}

tmux_sandbox_start() {
    [ -z "$_TMUX_SANDBOX_DIR" ] || return 0
    _TMUX_SANDBOX_REAL="$(command -v tmux 2>/dev/null)" || _TMUX_SANDBOX_REAL=""
    [ -n "$_TMUX_SANDBOX_REAL" ] || return 0
    case "$_TMUX_SANDBOX_REAL" in
        /*) ;;
        *) _tmux_sandbox_fail "找到的 tmux 不是一个文件（$_TMUX_SANDBOX_REAL），不能当真 tmux 用" ;;
    esac
    python3 -c 'import os; os.pidfd_open; import signal; signal.pidfd_send_signal' 2>/dev/null \
        || _tmux_sandbox_fail "python3 没有进程句柄功能（需要 3.9 以上），收尾没法确认进程退出"
    # socket 路径有长度上限，所以放在 /tmp 下的短目录里。
    _TMUX_SANDBOX_DIR="$(mktemp -d /tmp/cvtmx.XXXXXX)" || _tmux_sandbox_fail "建临时目录失败"
    mkdir -p "$_TMUX_SANDBOX_DIR/s" "$_TMUX_SANDBOX_DIR/bin" || _tmux_sandbox_fail "建临时目录失败"
    chmod 700 "$_TMUX_SANDBOX_DIR/s"
    cat > "$_TMUX_SANDBOX_DIR/bin/tmux" <<WRAP || _tmux_sandbox_fail "写 tmux 包装失败"
#!/usr/bin/env bash
# tmux 沙盒的包装（tests/lib/tmux-sandbox.sh 生成）：关门后拒绝一切调用；每次都加
# -f /dev/null；成功建出的会话、它所在服务的进程号记进 log。
d='$_TMUX_SANDBOX_DIR'
real='$_TMUX_SANDBOX_REAL'
if [ -e "\$d/closed" ]; then echo "tmux 沙盒已关闭，拒绝：tmux \$*" >&2; exit 1; fi
"\$real" -f /dev/null "\$@"; rc=\$?
if [ "\$rc" -eq 0 ]; then
    new=0; name=""; prev=""
    for a in "\$@"; do
        case "\$a" in new-session|new) new=1 ;; esac
        [ "\$prev" = "-s" ] && name="\$a"
        prev="\$a"
    done
    if [ "\$new" = 1 ] && [ -n "\$name" ]; then
        pid=\$("\$real" display-message -p -t "=\$name:" '#{pid}' 2>/dev/null)
        printf 'session %s\nserver %s\n' "\$name" "\$pid" >> "\$d/log"
    fi
fi
exit "\$rc"
WRAP
    chmod +x "$_TMUX_SANDBOX_DIR/bin/tmux"
    unset TMUX TMUX_PANE
    export TMUX_TMPDIR="$_TMUX_SANDBOX_DIR/s"
    export PATH="$_TMUX_SANDBOX_DIR/bin:$PATH"
    "$_TMUX_SANDBOX_REAL" -f /dev/null new-session -d -s cavil-sandbox-keep 'sleep 2147483647' \
        || _tmux_sandbox_fail "起专用 tmux 服务失败"
    "$_TMUX_SANDBOX_REAL" has-session -t '=cavil-sandbox-keep' 2>/dev/null \
        || _tmux_sandbox_fail "专用 tmux 服务上找不到保活会话"
    local pid
    pid="$("$_TMUX_SANDBOX_REAL" display-message -p -t '=cavil-sandbox-keep:' '#{pid}' 2>/dev/null)"
    printf 'server %s\n' "$pid" >> "$_TMUX_SANDBOX_DIR/log"
}

# 专用服务的 socket（显式 -S 用）。没启动时为空。
tmux_sandbox_socket() {
    [ -n "$_TMUX_SANDBOX_DIR" ] || return 1
    echo "$_TMUX_SANDBOX_DIR/s/tmux-$(id -u)/default"
}

# tmux_sandbox_own_dir <目录>：本次运行自己建的目录，收尾时删掉（GitHub#647 复审 #1）。
# 只在 mktemp 成功之后、拿着它刚打印的路径调用——不要登记一个从变量里读出来、可能是从
# 环境继承下来的路径。拒绝空串、相对路径、/ 和不存在的目录（以失败退出）。
tmux_sandbox_own_dir() {
    case "${1:-}" in
        ""|/|/.|//) _tmux_sandbox_fail "拒绝登记要删除的目录：「${1:-}」" ;;
        /*) ;;
        *) _tmux_sandbox_fail "拒绝登记相对路径：$1" ;;
    esac
    [ -d "$1" ] || _tmux_sandbox_fail "要登记删除的目录不存在：$1"
    _TMUX_SANDBOX_OWNED+=("$1")
}

_tmux_sandbox_rm() {   # <目录>：删掉并核对真的没了；失败返回 1 并说明
    local r=0
    rm -rf -- "$1" || r=$?
    if [ "$r" -ne 0 ] || [ -e "$1" ]; then
        echo "tmux 沙盒：清理失败：删除 $1（退出码 $r，$([ -e "$1" ] && echo 目录还在 || echo 目录已不在)）" >&2
        return 1
    fi
}

_tmux_sandbox_exit() {
    local rc=$? bad=0 hook r i keep=0 opts=$-
    # 回调在本测试原来的选项下执行（PR #660 复审 #3）：-u、pipefail 不动；-e 先在本函数里
    # 关掉（否则一个回调失败就把整个收尾中断），再在每个回调自己的子 shell 里按原样打开
    # ——不能把子 shell 放在 `if` / `||` 里，那样 bash 会在里面忽略 -e，回调中途失败也
    # 照样往下跑、最后报成功。读到未赋值变量、exit、-e 触发的退出都只结束那个子 shell。
    set +e
    for ((i = 0; i < ${#_TMUX_SANDBOX_HOOKS[@]}; i++)); do
        hook="${_TMUX_SANDBOX_HOOKS[$i]}"
        ( case "$opts" in *e*) set -e ;; esac; eval "$hook" )
        r=$?
        if [ "$r" -ne 0 ]; then
            echo "tmux 沙盒：清理失败：$hook，退出码 $r" >&2
            bad=1
        fi
    done
    set +u
    if [ -n "$_TMUX_SANDBOX_DIR" ]; then
        if ! : > "$_TMUX_SANDBOX_DIR/closed" 2>/dev/null || [ ! -e "$_TMUX_SANDBOX_DIR/closed" ]; then
            echo "tmux 沙盒：清理失败：写不了关门标记 $_TMUX_SANDBOX_DIR/closed，包装没能关上" >&2
            bad=1
        fi
        "$_TMUX_SANDBOX_REAL" -S "$_TMUX_SANDBOX_DIR/s/tmux-$(id -u)/default" kill-server >/dev/null 2>&1
        local reap
        reap="$(python3 "$_TMUX_SANDBOX_LIB/tmux_sandbox_reap.py" "$$" 2>&1)"
        r=$?
        if [ "$r" -eq 0 ]; then
            local sessions servers
            sessions=$(grep -c '^session ' "$_TMUX_SANDBOX_DIR/log" 2>/dev/null)
            servers=$(awk '$1 == "server" && $2 != "" {print $2}' "$_TMUX_SANDBOX_DIR/log" 2>/dev/null | sort -u | wc -l)
            if _tmux_sandbox_rm "$_TMUX_SANDBOX_DIR"; then
                echo "tmux 沙盒：成功建出 ${sessions:-0} 个业务会话，起过 ${servers:-0} 个服务，全部已退出（${reap}）"
            else
                bad=1
            fi
        else
            echo "tmux 沙盒：没能确认本次运行的进程都已退出，保留 $_TMUX_SANDBOX_DIR：${reap}" >&2
            bad=1; keep=1
        fi
    fi
    # 本次运行登记的目录：进程没确认收干净时一起保留（现场），否则逐个删并核对。
    for ((i = 0; i < ${#_TMUX_SANDBOX_OWNED[@]}; i++)); do
        if [ "$keep" = 1 ]; then
            echo "tmux 沙盒：一并保留 ${_TMUX_SANDBOX_OWNED[$i]}" >&2
        else
            _tmux_sandbox_rm "${_TMUX_SANDBOX_OWNED[$i]}" || bad=1
        fi
    done
    if [ "$rc" -eq 0 ] && [ "$bad" -ne 0 ]; then rc=1; fi
    exit "$rc"
}
trap _tmux_sandbox_exit EXIT
