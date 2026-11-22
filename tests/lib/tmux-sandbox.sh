# shellcheck shell=bash
# 用真 tmux 的测试专用：每次运行一个自己的 tmux 服务（GitHub#647）。
#
# 为什么要有：这些测试以前都在本机默认 tmux 服务上建会话、会话名又写死，两份同时跑
# （不同 worktree，或同一 worktree 跑两次）时，一份的回收 / 清理会把另一份的会话列出来、
# 杀掉。w01 上 reap-finished-workers 跑了 587 次红了 40 次，其中 31 次另有一份在跑。
#
# 规则全文（原样从根目录 AGENTS.md 搬来，那里只留一行索引；GitHub#658 的做法）：
#
# - **A test that uses real tmux gets a tmux server of its own** (GitHub#647). Five tests used to
#   create sessions on the machine's default tmux server under fixed names; two copies running at once
#   (another worktree, or the same one twice) listed and killed each other's sessions —
#   `reap-finished-workers` went red 40 times in 587 runs on w01, 31 of them with another copy running.
#   Such a test sources `tests/lib/tmux-sandbox.sh` before it creates anything, registers its own
#   clean-up with `tmux_sandbox_on_exit` (no `trap … EXIT` of its own) and calls `tmux_sandbox_start`
#   before its first tmux call; a directory it creates is handed over with `tmux_sandbox_own_dir`
#   right after `mktemp` succeeds — never deleted from a callback through a variable, which may have
#   been inherited from the environment and name someone else's directory (PR #660 review round 1); a
#   child with an empty environment is started only through `tmux_sandbox_env_i [NAME=VALUE …] cmd …`,
#   which appends this run's `TMUX_TMPDIR` and `PATH` itself (a reset `PATH` skips the wrapper) and
#   refuses, without starting anything, an env option or any caller assignment of `PATH` / `TMUX_TMPDIR`
#   / `TMUX` / `TMUX_PANE` — checked at run time on the arguments bash really passes, so redirections,
#   quoting and `"$@"` are already resolved. The script re-runs the test as a subreaper, points `TMUX_TMPDIR` at a private directory,
#   clears `TMUX` (it wins over `TMUX_TMPDIR`), and puts a `tmux` wrapper first on `PATH` that always
#   adds `-f /dev/null` (a server restarted mid-test reads no user config either — restarting is
#   allowed, the maintainer's choice) and refuses every call once the exit has begun. Isolation is
#   checked at run time (PR #660 review round 6, the maintainer chose this over more text rules): the
#   wrapper asks `check` in `tests/lib/tmux_sandbox_reap.py`, which splits tmux's global options with
#   tmux's own getopt string (combined forms like `-2S path` included; an option it does not know is
#   refused), works out the socket the call will really use in tmux's own order (`-S`; else `-L` under
#   `TMUX_TMPDIR`; else the socket in `TMUX`; else `default` under `TMUX_TMPDIR`, `/tmp` when unset),
#   and refuses, and records, the call when that socket is not this run's or its directory does not
#   exist (tmux itself would skip such a directory and fall back to another one); a call it lets
#   through is run with the checked real path passed as `-S`, so tmux chooses nothing on its own — and any record fails the
#   file; the exit also looks at every tmux server among the processes reparented to the test and fails
#   the file when one listens on a socket that is not this run's (a child that lost `PATH` and ran the
#   real tmux elsewhere). "This run's" is one rule for both, `owns` in `tests/lib/tmux_sandbox_reap.py`:
#   the socket's resolved real path lies inside the run's server directory (`…/s`), so `..` and
#   symbolic links count where they really point (PR #660 review: each side had matched a text prefix,
#   over different directories). Not caught at run time: a child that bypasses the wrapper
#   and talks to a server that was already running before the test (it starts no new server). The exit runs the
#   registered clean-ups each in its own subshell under the test's own options (`set -u` still holds),
#   writes the close marker, kills the server and stops every process reparented to the test (servers,
#   pane programs that ignore SIGHUP, leftover background jobs) — a whole batch at a time, every wait
#   bounded by the 10-second total — and then deletes the owned directories. A failed clean-up, close
#   marker or delete fails the file (an already red file keeps its code); a leftover it can see, or a
#   process list it cannot read, keeps the directories and fails the file. **It is a best-effort
#   clean-up, not a proof** (the maintainer chose this on #647 after eight design rounds on a proof):
#   the list is read one process at a time, so a process reparented in the middle of a scan can be
#   missed and not reported. Nothing checks for that; a missed process cannot be reached by another run
#   (its server address is unique) but keeps its own CPU / memory. The text lint is
#   `tests/tmux-sandbox-guard.test.sh` (rules in `tests/lib/tmux_guard.py`: a literal tmux call without
#   `-S` / `-L` needs the sandbox, or `export TMUX_TMPDIR=` plus a cleared `TMUX`, before it; a sandbox
#   file creates nothing before sourcing it, sets no EXIT trap, deletes nothing from a clean-up
#   callback, and contains no other way to empty the environment: `env` followed by any option word is
#   reported unless the options are only `-u NAME` (which keeps the environment), and so is `exec -c` —
#   also inside quotes and trailing comments, on purpose, since it never tries to read what `env -i` was
#   given (PR #660 review rounds 2–4 each found a shell form that a text reading of `env -i`'s arguments
#   got wrong: single quotes, an empty value or a comment, a redirection before a reassignment); the
#   isolation variables are guarded anywhere in the file, by text, also over-reporting: `-u` / `--unset`
#   / `unset` naming `PATH`, `TMUX_TMPDIR`, `TMUX` or `TMUX_PANE`, any assignment of the last three,
#   and a `PATH=` whose value does not contain `$PATH` / `${PATH}` (adding directories around it is
#   allowed) are reported (round 5: the `-u` exception let `env -u TMUX_TMPDIR` through); an
#   absolute-path tmux call is always reported; continuation lines are joined first). It cannot see
#   `PATH` changed somewhere else, a child that changes its own `PATH` or empties its own environment,
#   `env` called through a variable, names or values built from variables, a directory put in front of
#   `PATH` that holds its own `tmux`, tmux called through a
#   variable or a wrapper function (`"$REAL_TMUX" …`), a test that only reaches tmux through the script
#   under test, or a script written out through a here-doc — the author and the reviewer check those.
#   Start-up and exit are tested in `tests/tmux-sandbox.test.sh`
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
#    它；测试杀光自己的会话时服务不跟着退出）。本机没有 tmux 时什么都不起（测试照旧
#    按「没有 tmux」那条路走），只把 TMUX_TMPDIR 设上（可能为空）。任何一步失败都直接以失败退出。
#    清空环境的子进程一律用 ⑤ 起，不直接写 `env -i`（tests/lib/tmux_guard.py 拦）。
#    测试中途服务退了，下一条 tmux 命令会在同一地址重开——允许（维护者在 #647 选的）。
# ⑤ tmux_sandbox_env_i [名字=值 ...] <命令> [参数 ...]：在空环境里起子进程，只带调用方
#    给的赋值，外加本次运行的 TMUX_TMPDIR 和 PATH（放在最后、原样传，子进程连的是专用
#    服务、找到的是包装）。调用方给的参数里，命令名之前凡是带等号的都按赋值看（env 就是
#    这么认的），其中有 PATH / TMUX_TMPDIR / TMUX / TMUX_PANE 就拒绝；带 env 选项（以 - 开头）
#    也拒绝；拒绝时不起子进程，返回 125。重定向由 bash 先处理掉，不进参数。
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
    if [ -z "$_TMUX_SANDBOX_REAL" ]; then
        # 本机没有 tmux：什么都不起；TMUX_TMPDIR 照样设上（可能为空），子进程统一写
        # TMUX_TMPDIR="$TMUX_TMPDIR"，在 set -u 下也不会因为没设而出错。
        export TMUX_TMPDIR="${TMUX_TMPDIR-}"
        return 0
    fi
    case "$_TMUX_SANDBOX_REAL" in
        /*) ;;
        *) _tmux_sandbox_fail "找到的 tmux 不是一个文件（$_TMUX_SANDBOX_REAL），不能当真 tmux 用" ;;
    esac
    python3 -c 'import os; os.pidfd_open; import signal; signal.pidfd_send_signal' 2>/dev/null \
        || _tmux_sandbox_fail "python3 没有进程句柄功能（需要 3.9 以上），收尾没法确认进程退出"
    # socket 路径有长度上限，所以放在 /tmp 下的短目录里。
    _TMUX_SANDBOX_DIR="$(mktemp -d /tmp/cvtmx.XXXXXX)" || _tmux_sandbox_fail "建临时目录失败"
    # 解析成真实路径：服务地址归不归本次运行，按解析后的路径判断（tmux_sandbox_reap.py 的 owns）
    _TMUX_SANDBOX_DIR="$(cd "$_TMUX_SANDBOX_DIR" && pwd -P)" || _tmux_sandbox_fail "解析临时目录失败"
    mkdir -p "$_TMUX_SANDBOX_DIR/s" "$_TMUX_SANDBOX_DIR/bin" || _tmux_sandbox_fail "建临时目录失败"
    chmod 700 "$_TMUX_SANDBOX_DIR/s"
    cat > "$_TMUX_SANDBOX_DIR/bin/tmux" <<WRAP || _tmux_sandbox_fail "写 tmux 包装失败"
#!/usr/bin/env bash
# tmux 沙盒的包装（tests/lib/tmux-sandbox.sh 生成）：关门后拒绝一切调用；每次都加
# -f /dev/null；成功建出的会话、它所在服务的进程号记进 log。
d='$_TMUX_SANDBOX_DIR'
lib='$_TMUX_SANDBOX_LIB'
real='$_TMUX_SANDBOX_REAL'
if [ -e "\$d/closed" ]; then echo "tmux 沙盒已关闭，拒绝：tmux \$*" >&2; exit 1; fi
# 运行时核对这次调用连的是本次运行的专用服务（PR #660 复审第 6 轮，维护者选 A）：
# 设了 TMUX 就看它指的 socket，没设就看 TMUX_TMPDIR；全局选项 -S 给的 socket 也要在里面。
# 不符就拒绝、记进 violations，收尾时整个文件判失败。
# 这次调用实际会连的服务地址归不归本次运行，整件事交给 tmux_sandbox_reap.py check：它照 tmux 自己的
# getopt 串拆全局选项（合并写法也认），按 tmux 的顺序算出地址，再用 owns（解析成真实路径后在服务目录
# 里）判断；收尾认沙盒外服务也用 owns（PR #660 复审：原来包装自己在 shell 里拆选项，漏了合并写法）。
# 核过的地址用 -S 显式交给 tmux（放在最前，用户给的 -S 只会是同一个地址）：tmux 不再自己选址，
# 也就不会在目录失效时退回别的临时目录（PR #660 复审 #9）。
bad=""
sock=\$(python3 "\$lib/tmux_sandbox_reap.py" check "\$d/s" "\$@" 2>&1) || bad="\${sock:-判断服务地址失败}"
if [ -n "\$bad" ]; then
    printf '%s | tmux %s\n' "\$bad" "\$*" >> "\$d/violations"
    echo "tmux 沙盒：这次调用连的不是本次运行的专用服务（\$bad），拒绝：tmux \$*" >&2
    exit 1
fi
"\$real" -f /dev/null -S "\$sock" "\$@"; rc=\$?
if [ "\$rc" -eq 0 ]; then
    new=0; name=""; prev=""
    for a in "\$@"; do
        case "\$a" in new-session|new) new=1 ;; esac
        [ "\$prev" = "-s" ] && name="\$a"
        prev="\$a"
    done
    if [ "\$new" = 1 ] && [ -n "\$name" ]; then
        pid=\$("\$real" -S "\$sock" display-message -p -t "=\$name:" '#{pid}' 2>/dev/null)
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

tmux_sandbox_env_i() {
    local -a assigns=()
    while [ "$#" -gt 0 ]; do
        case "$1" in
            -*)
                echo "tmux 沙盒：tmux_sandbox_env_i 不接受 env 选项：$1" >&2
                return 125 ;;
            *=*)
                case "${1%%=*}" in
                    PATH|TMUX_TMPDIR|TMUX|TMUX_PANE)
                        echo "tmux 沙盒：tmux_sandbox_env_i 不接受调用方给的 ${1%%=*}（由沙盒原样传）" >&2
                        return 125 ;;
                esac
                assigns+=("$1"); shift ;;
            *) break ;;
        esac
    done
    if [ "$#" -eq 0 ]; then
        echo "tmux 沙盒：tmux_sandbox_env_i 没给命令" >&2
        return 125
    fi
    env -i ${assigns[@]+"${assigns[@]}"} TMUX_TMPDIR="${TMUX_TMPDIR-}" PATH="$PATH" "$@"
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
        if [ -s "$_TMUX_SANDBOX_DIR/violations" ]; then
            echo "tmux 沙盒：有 tmux 调用没连到本次运行的专用服务（已拒绝）：" >&2
            sed 's/^/  /' "$_TMUX_SANDBOX_DIR/violations" >&2
            bad=1
        fi
        reap="$(python3 "$_TMUX_SANDBOX_LIB/tmux_sandbox_reap.py" "$$" --tmux "$_TMUX_SANDBOX_REAL" --sandbox "$_TMUX_SANDBOX_DIR/s" 2>&1)"
        r=$?
        if [ "$r" -eq 3 ]; then
            # 进程都收掉了，但其中有 tmux 服务不在本次运行的地址上：测试的某个子进程绕过了沙盒
            echo "tmux 沙盒：发现沙盒外的 tmux 服务（本次运行的子进程起的，已结束）：${reap}" >&2
            bad=1; r=0
        fi
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
