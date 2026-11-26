#!/usr/bin/env bash
# kind: e2e
# 起 worker 前检查 agent 命令在不在，以及 worker 的退出码（GitHub#731）。
#
# 跑法：bash tests/agent-bin-check.test.sh   （约 1 分钟）
# 依赖：tmux、git、jq、python3。不碰网络：假 gh；真 tmux，开在本次运行自己的服务上（tests/lib/tmux-sandbox.sh）；
# 真派工脚本、真 agent-poll.sh。
#
# 2026-11-26 codex 升级后装到了 daemon 交给 worker 的 PATH 以外，每次起 worker 都 `command not found` 秒退，
# daemon 当成「会话损坏」重派三次再交人。这里断言：
#   1. 新 issue 派工：worker 环境里没有 agent 命令 → 不起会话、直接转人工（留言写命令名、~ 开头的 PATH、三步办法），
#      自愈计数清零、会话登记没写；有命令 → 照常起来（对照）；有文件但不能执行 → 留言写「不能执行」
#   2. 检查在 worker 的实际环境里做：tmux 的 shell 设置和它的启动文件（BASH_ENV）能加上或删掉命令时，检查结论
#      和「不检查直接起」的实际结果一致；PATH 里的相对目录按工作目录解析
#   3. 已有会话、worker 窗格没了（在会话里新开窗口）：检查在那个会话里做，用会话自己的 shell 设置；检查窗口不留下
#   4. 原窗格换程序：不检查（窗格沿用创建时的 shell，复审实测过和会话当前设置不同），照常起；起不来时记下退出码 127
#   5. 检查没跑成（超时）→ 不拦，照常起；起不来时新 issue 派工的交人留言写「退出码 127：找不到命令」，不说「会话损坏」
#   6. 检查之后、写 GitHub 之前检查依据变了 → 按不知道处理，照常起
#   7. 转人工写到一半失败（留言、加人工标签、摘派工标签）→ 停在那一步，自愈计数不清零、不起会话；留言没发成就不翻标签
#   7b. PR 评论派工的两个入口（工作目录在、要重建）：评论和标签写在 PR 上，自愈计数按关联 issue 清零，有对照
#   8. 真 agent-poll.sh：真起、真退出的程序留下的退出码，self-heal 的日志和用完次数的交人留言都带上，
#      不再说「疑似会话损坏」；下一轮派工检查到命令不在 → 转人工、计数清零（跨轮）
#   8b. 退出码矩阵：0、被信号结束、记录写坏、记号对不上；旧记录删不掉 / 新记号写不了时读出「没读到」，不冒充本次
#   8c. 同一次派工里续接失败、降级重起：旧记录删不掉时，能让它变旧就照常重起、之后读不到；连变旧也做不到就不重起，
#       之后读到的是唯一真跑过的那次的退出码
#   9. cleanup-issue.sh 删掉退出码记录
#   10. 交人留言和中英文档里给人的软链命令三处一字不差，在临时 HOME 里照字面跑：目标位置已有文件 / 目录 / 软链 /
#       悬空软链都停下不写，空位置才建；建好后下一次派工检查找得到
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# 本次运行独用一个 tmux 服务，跑完收掉（GitHub#647）。必须在建任何东西之前载入。
# shellcheck source=lib/tmux-sandbox.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
if ! command -v tmux > /dev/null 2>&1; then
    echo "⏭ 本机没有 tmux，整份跳过"; exit 0
fi
TMP="$(mktemp -d)" || exit 1
tmux_sandbox_own_dir "$TMP"
TMP="$(cd "$TMP" && pwd -P)"

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi; }
has() { case "$2" in *"$3"*) echo "  ✅ $1"; pass=$((pass+1)) ;; *) echo "  ❌ $1 (找不到 [$3]；实得 [${2:0:600}])"; fail=$((fail+1)) ;; esac; }
lacks() { case "$2" in *"$3"*) echo "  ❌ $1 (不该出现 [$3])"; fail=$((fail+1)) ;; *) echo "  ✅ $1"; pass=$((pass+1)) ;; esac; }

CTL="$TMP/ctl"; FAKEBIN="$TMP/fakebin"; AGENTDIR="$TMP/agentbin"; mkdir -p "$CTL" "$FAKEBIN" "$AGENTDIR"
NEXT_TMUX="$(command -v tmux)"   # 沙盒的 tmux 包装

# 本机 PATH 里凡是有 claude 的目录都从被测脚本的 PATH 里拿掉，「找不到」才是真找不到
: > "$CTL/hide"
IFS=: read -r -a _dirs <<< "$PATH"
for _d in "${_dirs[@]}"; do [ -n "$_d" ] && [ -e "$_d/claude" ] && printf '%s\n' "$_d" >> "$CTL/hide"; done
printf '%s\n' "$TMP/__none__" >> "$CTL/hide"

# 假 agent：在 tmux 里记一行再睡（会话保持活着）
cat > "$AGENTDIR/claude" <<SH
#!/usr/bin/env bash
[ -n "\${TMUX:-}" ] || exit 0
[ -z "\${CAVIL_DIRECT:-}" ] || exit 0   # 「不检查直接起」那一组：起得来就立刻退出 0
echo "ran \$(pwd -P)" >> "$CTL/ran"
# $CTL/mode：exit127 / exit0 = 3 秒后以这个码退出（过了派工的 2 秒秒退检查）；term = 3 秒后被 SIGTERM 结束；
# now127 = 立刻以 127 退出（秒退）；没有 = 一直睡
case "\$(cat "$CTL/mode" 2>/dev/null)" in
    exit127) sleep 3; exit 127 ;;
    exit0) sleep 3; exit 0 ;;
    term) sleep 3; kill -TERM \$\$; sleep 5 ;;
    now127) exit 127 ;;
    # 续接那次：先布好下一步的故障（删不掉退出码记录；arm-both 另让提示词标不成更新），再以 127 退出；
    # 降级重起的那次（如果真起了）就一直睡
    arm-rm|arm-both)
        touch "$CTL/fail-rm"; [ "\$(cat "$CTL/mode")" = arm-both ] && touch "$CTL/fail-touch"
        echo sleep > "$CTL/mode"; exit 127 ;;
esac
exec sleep 60
SH
chmod +x "$AGENTDIR/claude"

# 假 gh：条目读取 / 标签增删交给 fake_item_labels.sh；留言记下正文；$CTL/fail-* 注入写入失败
cat > "$FAKEBIN/gh" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CTL/gh.log"
a="\$*"
case "\$a" in
    *"-X POST"*"/comments"*)
        [ -e "$CTL/fail-comment" ] && { echo "HTTP 500" >&2; exit 1; }
        for x in "\$@"; do case "\$x" in body=*) printf '%s\n----\n' "\${x#body=}" >> "$CTL/comments" ;; esac; done
        echo '{"id":1}'; exit 0 ;;
    *"-X POST"*"/labels"*) [ -e "$CTL/fail-add" ] && { echo "HTTP 500" >&2; exit 1; } ;;
    *"-X DELETE"*"/labels/"*) [ -e "$CTL/fail-del" ] && { echo "HTTP 500" >&2; exit 1; } ;;
esac
FAKE_ITEM_DIR="$CTL/items" . "$TEST_DIR/lib/fake_item_labels.sh" "\$@"
case "\$a" in *title*) echo "测试标题"; exit 0 ;; esac
echo "{}"
SH
# tmux 垫片：记下参数；$CTL/stall 在时把检查会话 / 窗口的命令换成 sleep（模拟检查迟迟不出结果）；
# $CTL/flip-shell 在时，检查一结束就改全局 shell 设置（模拟检查依据在写之前变了）
cat > "$FAKEBIN/tmux" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CTL/tmux.log"
args=("\$@")
if [ -e "$CTL/stall" ] && [[ "\$*" == *cavil-bin-check* ]]; then args[\${#args[@]}-1]="sleep 30"; fi
if [ -e "$CTL/flip-shell" ] && [ "\${1:-}" = kill-session ] && [[ "\$*" == *cavil-bincheck-* ]]; then
    "$NEXT_TMUX" set-option -g default-shell /bin/bash >/dev/null 2>&1
fi
exec "$NEXT_TMUX" "\${args[@]}"
SH
# rm / touch 垫片：$CTL/fail-rm 在时删不掉退出码目录里的文件；$CTL/fail-touch 在时提示词文件标不成更新
cat > "$FAKEBIN/rm" <<SH
#!/usr/bin/env bash
if [ -e "$CTL/fail-rm" ]; then for a in "\$@"; do case "\$a" in */worker-exit/*) exit 1 ;; esac; done; fi
exec /bin/rm "\$@"
SH
cat > "$FAKEBIN/touch" <<SH
#!/usr/bin/env bash
if [ -e "$CTL/fail-touch" ]; then for a in "\$@"; do case "\$a" in */prompts/*) exit 1 ;; esac; done; fi
exec /usr/bin/touch "\$@"
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/systemctl"
chmod +x "$FAKEBIN"/*

# 真 git：bare origin + 主 checkout
gq() { git -c user.email=t@example.invalid -c user.name=t "$@" >/dev/null 2>&1; }
gq init -q --bare -b main "$TMP/up.git"
gq clone -q "$TMP/up.git" "$TMP/seed"
(cd "$TMP/seed" && echo x > f && gq add f && gq commit -qm init && gq push -q origin HEAD:main)
# 跑在空环境里的 shell 初始化文件：一个把假 agent 目录加进 PATH，一个把 PATH 换成只剩系统目录
printf 'PATH="%s:$PATH"; export PATH\n' "$AGENTDIR" > "$CTL/add.sh"
# 整个换成系统目录：命令就不在了（变量名拼出来写：这个文件只在被测的 worker shell 里执行，不经本测试的 tmux）
PV=PATH; printf '%s=/usr/bin:/bin; export %s\n' "$PV" "$PV" > "$CTL/strip.sh"

N=987311
P=987312   # 绑定 issue N 的 PR（分支 feature/issue-N）
(cd "$TMP/seed" && gq push -q origin "HEAD:refs/pull/$P/head")
S=""   # 当前场景目录
# 一个场景一套状态目录 + 配置。$1 = 名字，$2 = agent 目录在不在被测脚本的 PATH 里（yes / no / rel）
scenario() {
    S="$TMP/sc.$1"; rm -rf "$S"; mkdir -p "$S/state" "$S/logs" "$S/home"
    gq clone -q "$TMP/up.git" "$S/proj"
    local front="$FAKEBIN:"
    case "$2" in yes) front="$FAKEBIN:$AGENTDIR:" ;; rel) front="$FAKEBIN:relbin:" ;; esac
    cat > "$S/config" <<CONF
REPO="example/none"
PROJECT_ROOT="$S/proj"
WORKTREE_BASE="$S/wt"
STATE_DIR="$S/state"
SESSION_LOG_DIR="$S/logs"
TMUX_PREFIX="abc"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_BLOCKED=""
LABEL_AUTOPILOT=""
WORKER_AGENT="claude"
WORKER_SECRET_ENV=""
AGENT_TRUST_PROMPT_WAIT_SECS=1
AGENT_SESSION_CAPTURE_SECS=1
CAVIL_AGENT_BIN_CHECK_WAIT=2
GH_TOKEN="fake-token-for-test"
PATH="${front}\$(printf '%s' "\$PATH" | tr ':' '\n' | grep -vxF -f "$CTL/hide" | paste -sd: -)"
CONF
    rm -rf "$CTL/items" "$CTL/comments" "$CTL/ran" "$CTL/gh.log" "$CTL/tmux.log" "$CTL"/fail-* "$CTL/stall" "$CTL/flip-shell" "$CTL/mode"
    mkdir -p "$CTL/items"; : > "$CTL/items/$P.pr"
    tmux kill-session -t "=abc-issue$N" 2>/dev/null
    tmux set-option -gu default-shell 2>/dev/null; tmux set-environment -gu BASH_ENV 2>/dev/null
    return 0
}
# 派工。$1 = new | issue（issue 评论派工；worktree 先建好）| pr（PR 评论派工，worktree 先建好）| pr-rebuild（没有 worktree）
run_dispatch() {
    if { [ "$1" = issue ] || [ "$1" = pr ]; } && [ ! -d "$S/wt/issue-$N" ]; then
        gq -C "$S/proj" worktree add -q "$S/wt/issue-$N" -b "feature/issue-$N"
    fi
    local args=("$N" 0) script=dispatch-new-issue.sh
    case "$1" in
        issue) script=dispatch-issue-comment.sh ;;
        pr|pr-rebuild) script=dispatch-pr-comment.sh; args=("$P" "feature/issue-$N" 0) ;;
    esac
    (cd "$S/proj" && tmux_sandbox_env_i HOME="$S/home" LANG=C.UTF-8 CODING_AGENT_CONFIG="$S/config" \
        timeout 120 bash "$REPO_DIR/scripts/$script" "${args[@]}") > "$S/dispatch.out" 2>&1
    echo $? > "$S/rc"
}
labels() { sort "$CTL/items/$N" 2>/dev/null | paste -sd, -; }
prlabels() { sort "$CTL/items/$P" 2>/dev/null | grep -v '^$' | paste -sd, -; }
# 跨进程读这次的退出码（和 self-heal 一样：不带期望记号）
read_exit() {
    tmux_sandbox_env_i HOME="$S/home" CODING_AGENT_CONFIG="$S/config" REPO_DIR="$REPO_DIR" OUT="$CTL/exit.out" N="$N" \
        bash -c 'source "$REPO_DIR/scripts/_lib.sh"; agent_exit_read "abc-issue$N" "$N" > "$OUT"' > /dev/null 2>&1
    cat "$CTL/exit.out" 2>/dev/null
}
wait_gone() { local i; for ((i = 0; i < 100; i++)); do sess_alive || return 0; sleep 0.1; done; return 1; }
sess_alive() { tmux has-session -t "=abc-issue$N" 2>/dev/null; }
yesno() { if "$@"; then echo yes; else echo no; fi; }
comments() { cat "$CTL/comments" 2>/dev/null; }
polllog() { cat "$S/state/poll.log" 2>/dev/null; }
leftover_checks() { tmux ls -F '#{session_name}' 2>/dev/null | grep -c '^cavil-bincheck' ; }
wait_ran() { local i; for ((i = 0; i < 50; i++)); do [ -s "$CTL/ran" ] && return 0; sleep 0.1; done; return 1; }
selfheal_set() { mkdir -p "$S/state/selfheal"; echo "$1" > "$S/state/selfheal/$N"; }
selfheal_now() { cat "$S/state/selfheal/$N" 2>/dev/null || echo none; }

echo "【1】新 issue 派工：worker 环境里没有 agent 命令"
scenario missing no
selfheal_set 2
run_dispatch new
chk "没起 worker 会话" "$(yesno sess_alive)" no
chk "条目直接转人工" "$(labels)" "pending/human"
has "留言写明找不到命令" "$(comments)" '找不到 `claude` 命令'
has "留言里的 PATH 家目录写成 ~" "$(comments)" '~/.local/bin'
lacks "留言里没有 daemon 用户家目录的绝对路径" "$(comments)" "$S/home"
has "留言写了不覆盖的软链办法" "$(comments)" 'ln -s'
has "留言写了原派工标签" "$(comments)" '原来的派工标签 `pending/agent`'
has "poll.log 写了原因" "$(polllog)" "起 worker 前检查：daemon 交给 worker 的 PATH 里找不到"
chk "转人工全部写完后自愈计数清零" "$(selfheal_now)" none
chk "会话登记没写" "$(ls "$S/state/agent-sessions" 2>/dev/null | grep -c "^$N\." )" 0
chk "检查会话没留下" "$(leftover_checks)" 0
chk "到达性 · 检查确实起过一个检查会话" "$(grep -c 'new-session -d -s cavil-bincheck-' "$CTL/tmux.log" 2>/dev/null)" 1

echo "【1b】对照：命令在 PATH 里 → 照常起"
scenario present yes
selfheal_set 2
run_dispatch new
chk "起了 worker 会话" "$(yesno sess_alive)" yes
chk "agent 真的跑起来了" "$(yesno wait_ran)" yes
chk "标签是 doing/agent" "$(labels)" "doing/agent"
chk "没有转人工留言" "$(comments | grep -c '找不到')" 0
chk "自愈计数没被这次检查动过" "$(selfheal_now)" 2
chk "检查会话没留下" "$(leftover_checks)" 0

echo "【1c】有同名文件但不能执行"
scenario noexec no
mkdir -p "$S/noexec"; cp "$AGENTDIR/claude" "$S/noexec/claude"; chmod -x "$S/noexec/claude"
sed -i "s|^\(${PV}=\"$FAKEBIN:\)|\1$S/noexec:|" "$S/config"   # 不能执行的同名文件放在 PATH 最前面
run_dispatch new
chk "没起 worker 会话" "$(yesno sess_alive)" no
chk "转人工" "$(labels)" "pending/human"
has "留言写明不能执行" "$(comments)" '但它不能执行'

echo "【2】shell 启动文件决定命令在不在：检查结论 = 不检查直接起的结果"
direct_rc() {   # 不经检查，照派工的方式直接在新会话里起 claude，返回它的退出码。$1 = 调用方 PATH 前面加什么
    rm -f "$CTL/direct.rc"
    (cd "$TMP" && tmux_sandbox_env_i LANG=C.UTF-8 FRONT="$1" bash -c \
        'PATH="$FRONT$PATH" tmux new-session -d -s direct -e CAVIL_DIRECT=1 -c "$0" "claude; echo \$? > $1"' "$TMP" "$CTL/direct.rc")
    local i; for ((i = 0; i < 50; i++)); do [ -s "$CTL/direct.rc" ] && break; sleep 0.1; done
    tmux kill-session -t =direct 2>/dev/null
    cat "$CTL/direct.rc" 2>/dev/null || echo none
}
scenario bashenv-add no
tmux set-option -g default-shell /bin/bash; tmux set-environment -g BASH_ENV "$CTL/add.sh"
run_dispatch new
chk "启动文件把命令加进 PATH：检查判找得到、照常起" "$(labels)" "doing/agent"
chk "agent 真的跑起来了" "$(yesno wait_ran)" yes
chk "直接起也起得来（退出码 0）" "$(direct_rc "")" 0
scenario bashenv-strip yes
tmux set-option -g default-shell /bin/bash; tmux set-environment -g BASH_ENV "$CTL/strip.sh"
run_dispatch new
chk "启动文件把命令删掉：检查判找不到、转人工" "$(labels)" "pending/human"
chk "没起 worker 会话" "$(yesno sess_alive)" no
chk "直接起也起不来（退出码 127）" "$(direct_rc "$AGENTDIR:")" 127
scenario relative rel
mkdir -p "$S/wt/issue-$N"; rm -rf "$S/wt"
gq -C "$S/proj" worktree add -q "$S/wt/issue-$N" -b "feature/issue-$N"
mkdir -p "$S/wt/issue-$N/relbin"; cp "$AGENTDIR/claude" "$S/wt/issue-$N/relbin/claude"
run_dispatch issue
chk "PATH 里的相对目录按工作目录解析：照常起" "$(labels)" "doing/agent"
chk "agent 真的跑起来了" "$(yesno wait_ran)" yes

echo "【3】已有会话、worker 窗格没了：在那个会话里开检查窗口，用会话自己的 shell 设置"
setup_gone_pane() {   # 会话在、记录的 worker 窗格已不在、记的是别的 agent（逼派工走「换程序」）
    tmux new-session -d -s "abc-issue$N" -c "$TMP" "sleep 600"
    tmux set-option -t "=abc-issue$N:" @worker_pane '%99999'
    tmux set-option -t "=abc-issue$N:" @worker_agent codex
}
scenario window-add no
gq -C "$S/proj" worktree add -q "$S/wt/issue-$N" -b "feature/issue-$N"
setup_gone_pane
tmux set-option -t "=abc-issue$N:" default-shell /bin/bash
tmux set-environment -t "=abc-issue$N:" BASH_ENV "$CTL/add.sh"
run_dispatch issue
chk "会话的 shell 设置把命令加进 PATH：判找得到、照常起" "$(labels)" "doing/agent"
chk "agent 真的跑起来了" "$(yesno wait_ran)" yes
chk "检查窗口没留下（只剩人的窗口 + 新 worker 窗口）" "$(tmux list-windows -t "=abc-issue$N" -F x 2>/dev/null | wc -l | tr -d ' ')" 2
chk "到达性 · 检查是在这个会话里开窗口做的" "$(grep -c "new-window -d -P -F #{pane_id} -t =abc-issue$N:.*cavil-bin-check" "$CTL/tmux.log")" 1
scenario window-missing no
gq -C "$S/proj" worktree add -q "$S/wt/issue-$N" -b "feature/issue-$N"
setup_gone_pane
run_dispatch issue
chk "会话里找不到命令：转人工" "$(labels)" "pending/human"
chk "人的窗口还在，没多出窗口" "$(tmux list-windows -t "=abc-issue$N" -F x 2>/dev/null | wc -l | tr -d ' ')" 1

echo "【4】原窗格换程序：不检查，照常起；起不来时记下退出码 127"
scenario respawn no
gq -C "$S/proj" worktree add -q "$S/wt/issue-$N" -b "feature/issue-$N"
tmux set-option -g default-shell /bin/sh
tmux new-session -d -s "abc-issue$N" -c "$TMP" "sleep 600"
tmux set-option -t "=abc-issue$N:" @worker_pane "$(tmux list-panes -t "=abc-issue$N" -F '#{pane_id}' | head -1)"
tmux set-option -t "=abc-issue$N:" @worker_agent codex
# 复审实测的情形：窗格以 /bin/sh 创建后，会话改成 bash + 启动文件能找到命令；原窗格换程序时仍用 /bin/sh
tmux set-option -t "=abc-issue$N:" default-shell /bin/bash
tmux set-environment -t "=abc-issue$N:" BASH_ENV "$CTL/add.sh"
run_dispatch issue
has "poll.log 说原窗格检查不了" "$(polllog)" "原窗格里换程序"
chk "没有起检查窗口或检查会话" "$(grep -c 'cavil-bin-check' "$CTL/tmux.log")" 0
chk "照常认领、换程序" "$(labels)" "doing/agent"
for _i in $(seq 1 50); do [ -s "$S/state/worker-exit/abc-issue$N" ] && break; sleep 0.1; done
EXIT_REC="$(cut -d' ' -f1 "$S/state/worker-exit/abc-issue$N" 2>/dev/null)"
chk "程序起不来，退出码记成 127" "$EXIT_REC" 127
chk "记录属于这次启动（和启动记号一致）" "$(cut -d' ' -f2 "$S/state/worker-exit/abc-issue$N" 2>/dev/null)" "$(cat "$S/state/worker-exit/abc-issue$N.launch" 2>/dev/null)"
RESPAWN_S="$S"

echo "【5】检查没跑成（超时）→ 不拦；起不来时留言带退出码"
scenario stall no
touch "$CTL/stall"
run_dispatch new
has "poll.log 说按不知道处理" "$(polllog)" "按不知道处理，照常起"
has "照常起了，秒退后交人留言带退出码" "$(comments)" "退出码 127：找不到命令"
lacks "不再说会话损坏" "$(comments)" "会话损坏"
chk "检查会话没留下" "$(leftover_checks)" 0

echo "【6】检查之后、写 GitHub 之前依据变了 → 按不知道处理"
scenario basis no
touch "$CTL/flip-shell"
run_dispatch new
has "poll.log 说依据变了" "$(polllog)" "检查依据在写之前变了"
lacks "没有发「找不到命令」的留言" "$(comments)" '找不到 `claude` 命令'

echo "【7】转人工写到一半失败：停在那一步、计数不清零；留言没发成就不翻标签"
for step in comment add del; do
    scenario "half-$step" no
    selfheal_set 1
    touch "$CTL/fail-$step"
    run_dispatch new
    chk "[$step 失败] 没起 worker 会话" "$(yesno sess_alive)" no
    case "$step" in
        comment) chk "[留言失败] 不翻标签，仍是派工标签" "$(labels)" "pending/agent"
                 chk "[留言失败] 自愈计数没清零" "$(selfheal_now)" 1
                 chk "[留言失败] 派工以「结果不明」退出" "$(cat "$S/rc")" 77
                 has "[留言失败] poll.log 写明留言没发成" "$(polllog)" "说明留言没发成"
                 chk "到达性 · [留言失败] 确实发过一次留言请求" "$(grep -c -- '-X POST repos/example/none/issues/'"$N"'/comments' "$CTL/gh.log")" 1 ;;
        add) chk "[加人工标签失败] 自愈计数没清零" "$(selfheal_now)" 1
             chk "[加人工标签失败] 仍是派工标签" "$(labels)" "pending/agent"
             has "[加人工标签失败] 留言已发" "$(comments)" '找不到 `claude` 命令' ;;
        del) chk "[摘派工标签失败] 自愈计数没清零" "$(selfheal_now)" 1
             chk "[摘派工标签失败] 两个标签同挂" "$(labels)" "pending/agent,pending/human" ;;
    esac
done

echo "【7b】PR 评论派工的两个入口"
for entry in pr pr-rebuild; do
    scenario "$entry-missing" no
    selfheal_set 2
    run_dispatch "$entry"
    chk "[$entry 找不到] 没起 worker 会话" "$(yesno sess_alive)" no
    chk "[$entry 找不到] PR 转人工" "$(prlabels)" "pending/human"
    chk "[$entry 找不到] 关联 issue 的标签没被碰" "$(labels)" ""
    chk "[$entry 找不到] 留言写在 PR 上" "$(grep -c -- "-X POST repos/example/none/issues/$P/comments" "$CTL/gh.log")" 1
    has "[$entry 找不到] 留言写了原派工标签" "$(comments)" '原来的派工标签 `pending/agent`'
    chk "[$entry 找不到] 自愈计数按关联 issue 清零" "$(selfheal_now)" none
    chk "[$entry 找不到] 会话登记没写" "$(ls "$S/state/agent-sessions" 2>/dev/null | grep -c "^$N\." )" 0
    chk "到达性 · [$entry] 检查确实起过检查会话" "$(grep -c 'new-session -d -s cavil-bincheck-' "$CTL/tmux.log")" 1
    scenario "$entry-present" yes
    selfheal_set 2
    run_dispatch "$entry"
    chk "[$entry 对照] 起了 worker 会话" "$(yesno sess_alive)" yes
    chk "[$entry 对照] agent 真的跑起来了" "$(yesno wait_ran)" yes
    chk "[$entry 对照] PR 认领成 doing/agent" "$(prlabels)" "doing/agent"
    chk "[$entry 对照] 自愈计数没动" "$(selfheal_now)" 2
    chk "[$entry 对照] 工作目录在 feature 分支上" "$(git -C "$S/wt/issue-$N" rev-parse --abbrev-ref HEAD 2>/dev/null)" "feature/issue-$N"
done

echo "【8b】退出码矩阵（真起、真退出）"
for mode in exit0 term exit127; do
    scenario "exit-$mode" yes
    echo "$mode" > "$CTL/mode"
    run_dispatch new
    wait_gone
    case "$mode" in
        exit0) chk "正常结束 → 0" "$(read_exit)" 0; has "白话：正常结束" "$(tmux_sandbox_env_i REPO_DIR="$REPO_DIR" HOME="$S/home" CODING_AGENT_CONFIG="$S/config" OUT="$CTL/x" bash -c 'source "$REPO_DIR/scripts/_lib.sh"; agent_exit_explain 0 > "$OUT"' >/dev/null 2>&1; cat "$CTL/x")" "正常结束" ;;
        term)  chk "被 SIGTERM 结束 → 143" "$(read_exit)" 143 ;;
        exit127) chk "以 127 退出 → 127" "$(read_exit)" 127 ;;
    esac
done
EXIT_S="$S"
R="$S/state/worker-exit/abc-issue$N"
cp "$R" "$CTL/rec.bak"
printf 'abc def\n' > "$R"
chk "记录写坏 → 读不到" "$(read_exit)" ""
cp "$CTL/rec.bak" "$R"; echo other-token > "$R.launch"
chk "记号对不上 → 读不到" "$(read_exit)" ""
echo "$(cut -d' ' -f2 "$CTL/rec.bak")" > "$R.launch"
chk "到达性 · 恢复后又读得到 127" "$(read_exit)" 127
# 旧记录删不掉、新记号写不了：退出码目录只读，再派一次（新提示词）
chmod 555 "$S/state/worker-exit"
echo now127 > "$CTL/mode"; rm -f "$CTL/items/$N"
run_dispatch new
chk "旧记录确实还在（删不掉）" "$(cut -d' ' -f1 "$R" 2>/dev/null)" 127
has "秒退的交人留言写「没读到」，不冒充上次的 127" "$(comments)" "没读到最后一次的退出码"
lacks "交人留言里没有上次的「找不到命令」" "$(comments)" "退出码 127"
chk "跨进程（self-heal 那样）读也是读不到" "$(read_exit)" ""
chmod 755 "$S/state/worker-exit"

echo "【8c】续接失败、降级重起时旧记录删不掉"
# 先正常起一次（登记会话），再给这条会话补一份对话记录，让下一次派工走「续接」
prep_resume() {
    run_dispatch issue
    tmux kill-session -t "=abc-issue$N" 2>/dev/null
    local id hist
    id="$(cat "$S/state/agent-sessions/$N.claude.worker" 2>/dev/null)"
    hist="$(tmux_sandbox_env_i HOME="$S/home" CODING_AGENT_CONFIG="$S/config" REPO_DIR="$REPO_DIR" WT="$S/wt/issue-$N" OUT="$CTL/hist" \
        bash -c 'source "$REPO_DIR/scripts/_lib.sh"; claude_session_dir "$WT" > "$OUT"' >/dev/null 2>&1; cat "$CTL/hist")"
    mkdir -p "$hist"; echo '{"type":"user"}' > "$hist/$id.jsonl"
    rm -f "$CTL/ran" "$CTL/items/$N"
    [ -n "$id" ]
}
for variant in arm-rm arm-both; do
    scenario "fallback-$variant" yes
    chk "[$variant] 到达性 · 续接的前提布好了（登记了会话、有对话记录）" "$(prep_resume && echo yes)" yes
    echo "$variant" > "$CTL/mode"
    run_dispatch issue
    has "[$variant] 续接 2 秒内死了，日志带这次的退出码 127" "$(polllog)" "session 死了（退出码 127：找不到命令"
    case "$variant" in
        arm-rm)
            chk "[$variant] 旧记录确实没删掉" "$(cut -d' ' -f1 "$S/state/worker-exit/abc-issue$N" 2>/dev/null)" 127
            chk "[$variant] 旧记录能变旧：照常降级重起" "$(wc -l < "$CTL/ran" | tr -d ' ')" 2
            chk "[$variant] 重起的会话活着" "$(yesno sess_alive)" yes
            chk "[$variant] 之后（self-heal 那样）读不到，不冒充上次的 127" "$(read_exit)" "" ;;
        arm-both)
            chk "[$variant] 旧记录确实没删掉" "$(cut -d' ' -f1 "$S/state/worker-exit/abc-issue$N" 2>/dev/null)" 127
            has "[$variant] 不重起，日志写明原因" "$(polllog)" "也没法让它变旧：不起程序"
            chk "[$variant] 只真跑过续接那一次" "$(wc -l < "$CTL/ran" | tr -d ' ')" 1
            chk "[$variant] 没有会话" "$(yesno sess_alive)" no
            chk "[$variant] 派工以「结果不明」退出（条目留在 doing/agent，交给 self-heal）" "$(cat "$S/rc")" 77
            chk "[$variant] 之后读到的是唯一真跑过那次的退出码" "$(read_exit)" 127 ;;
    esac
    rm -f "$CTL/fail-rm" "$CTL/fail-touch"
done

echo "【8】真 agent-poll.sh：self-heal 带退出码；下一轮检查到命令不在 → 转人工、计数清零"
POLLS="$TMP/poll"; rm -rf "$POLLS"; mkdir -p "$POLLS/gh" "$POLLS/bin" "$POLLS/state" "$POLLS/wt" "$POLLS/home"
gq clone -q "$TMP/up.git" "$POLLS/project"
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$POLLS/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cp "$FAKEBIN/tmux" "$FAKEBIN/systemctl" "$POLLS/bin/"
GD="$POLLS/gh"
echo '{}' > "$GD/events.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
jq -n --arg i "$N" '{($i): {kind:"issue", state:"open", title:"新需求", body:"做一件事", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}}' > "$GD/items.json"
jq -n --arg i "$N" '{($i): ["pending/agent"]}' > "$GD/labels.json"
echo '{}' > "$GD/comments.json"
mkdir -p "$POLLS/agentbin"; cp "$AGENTDIR/claude" "$POLLS/agentbin/claude"
cat > "$POLLS/config" <<CONF
REPO="example/sm"
PROJECT_ROOT="$POLLS/project"
WORKTREE_BASE="$POLLS/wt"
STATE_DIR="$POLLS/state"
TMUX_PREFIX="abc"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
LABEL_PENDING_BLOCKED=""
LABEL_AUTOPILOT=""
WORKER_AGENT="claude"
WORKER_SECRET_ENV=""
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
SELFHEAL_MAX_RETRIES=1
AGENT_TRUST_PROMPT_WAIT_SECS=1
CAVIL_AGENT_BIN_CHECK_WAIT=2
GH_TOKEN="fake-token-for-test"
PATH="$POLLS/bin:$POLLS/agentbin:\$(printf '%s' "\$PATH" | tr ':' '\n' | grep -vxF -f "$CTL/hide" | paste -sd: -)"
CONF
chmod 600 "$POLLS/config"
echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$POLLS/state/state.json"
poll_round() {
    (cd "$POLLS/project" && tmux_sandbox_env_i HOME="$POLLS/home" LANG=C.UTF-8 CODING_AGENT_CONFIG="$POLLS/config" \
        FAKE_GH_LISTS=1 FAKE_GH_REPO=example/sm FAKE_GH_DIR="$GD" \
        timeout 180 bash "$REPO_DIR/scripts/agent-poll.sh") > /dev/null 2>&1
}
plabels() { jq -r --arg n "$N" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
# 第 0 轮：真派工、真起程序；程序 3 秒后以 127 退出，会话随之消失
echo exit127 > "$CTL/mode"
poll_round
chk "第 0 轮派工起了程序" "$(plabels)" "doing/agent"
wait_gone
rm -f "$CTL/mode"
poll_round
PLOG="$(cat "$POLLS/state/poll.log" 2>/dev/null)"
has "第 1 轮 self-heal 日志带退出码" "$PLOG" "不存在（退出码 127：找不到命令"
chk "第 1 轮 self-heal 计了一次" "$(cat "$POLLS/state/selfheal/$N" 2>/dev/null)" 1
chk "第 1 轮送回派工标签" "$(plabels)" "pending/agent"
rm -f "$POLLS/agentbin/claude"   # 命令在两轮之间不见了（这次的实际情形）
poll_round
PLOG="$(cat "$POLLS/state/poll.log" 2>/dev/null)"
has "第 2 轮派工时检查到命令不在" "$PLOG" "起 worker 前检查：daemon 交给 worker 的 PATH 里找不到"
chk "第 2 轮转人工" "$(plabels)" "pending/human"
chk "转人工后自愈计数清零" "$(cat "$POLLS/state/selfheal/$N" 2>/dev/null || echo none)" none
chk "没起 worker 会话" "$(yesno sess_alive)" no
# 用完次数的那条路：命令装回来、程序真起来后被 SIGTERM 结束，计数已到上限 → 会话消失直接交人，留言带退出码
cp "$AGENTDIR/claude" "$POLLS/agentbin/claude"; echo term > "$CTL/mode"
jq -n --arg i "$N" '{($i): ["pending/agent"]}' > "$GD/labels.json"
poll_round
chk "到达性 · 又真起了一次程序" "$(plabels)" "doing/agent"
wait_gone; rm -f "$CTL/mode"
mkdir -p "$POLLS/state/selfheal"; echo 1 > "$POLLS/state/selfheal/$N"
poll_round
PCOM="$(jq -r '.. | .body? // empty' "$GD"/comments*.json 2>/dev/null; cat "$GD"/*.log 2>/dev/null)"
has "用完次数交人：日志带退出码" "$(cat "$POLLS/state/poll.log")" "次仍死（退出码 143：程序被信号 15 结束"
lacks "不再说疑似会话损坏" "$(cat "$POLLS/state/poll.log")" "疑似会话损坏"
has "用完次数交人：留言带退出码" "$PCOM" "退出码 143：程序被信号 15 结束"
chk "用完次数交人：转 pending/human" "$(plabels)" "pending/human"

# 转人工停在「人工标签加上了、派工标签没摘掉」时，下一轮谁接手（第【7】组的中间态）：
#   pending/review + pending/human → 现有规则不派（等人）；pending/agent + pending/human → 照常派、再查一次
checks_so_far() { grep -c '起 worker 前检查：daemon 交给 worker 的 PATH 里找不到' "$POLLS/state/poll.log"; }
jq -n --arg i "$N" '{($i): ["pending/human", "pending/review"]}' > "$GD/labels.json"
echo 'LOG_LEVEL=debug' >> "$POLLS/config"   # 「按等人跳过」只在 debug 日志里记一行
c0=$(checks_so_far); poll_round
sed -i '/^LOG_LEVEL=debug$/d' "$POLLS/config"
chk "复审标签 + 人工标签同挂：这一轮不派工（等人）" "$(( $(checks_so_far) - c0 ))" 0
chk "复审标签 + 人工标签同挂：标签不动" "$(plabels)" "pending/human,pending/review"
has "到达性 · 这一轮确实看到了这个条目、按等人跳过" "$(cat "$POLLS/state/poll.log")" "review 轮次已用尽"
jq -n --arg i "$N" '{($i): ["pending/agent", "pending/human"]}' > "$GD/labels.json"
rm -f "$POLLS/agentbin/claude"
c0=$(checks_so_far); poll_round
chk "派工标签 + 人工标签同挂：这一轮照常派、再查了一次" "$(( $(checks_so_far) - c0 ))" 1
chk "再查仍找不到：转成只剩 pending/human" "$(plabels)" "pending/human"

echo "【9】cleanup-issue.sh 删掉退出码记录"
S="$RESPAWN_S"
tmux kill-session -t "=abc-issue$N" 2>/dev/null
(cd "$S/proj" && tmux_sandbox_env_i HOME="$S/home" LANG=C.UTF-8 CODING_AGENT_CONFIG="$S/config" \
    timeout 60 bash "$REPO_DIR/scripts/cleanup-issue.sh" "$N") > /dev/null 2>&1
chk "退出码记录删掉了" "$(ls "$S/state/worker-exit/" 2>/dev/null | grep -c "abc-issue$N")" 0

echo "【10】给人的软链命令：三处一字不差，照字面跑"
snippet_of() {   # <文件> → 含 ln -s "$new" "$t" 的那个 bash 代码块（去掉缩进）
    python3 - "$1" <<'PYX'
import sys, re
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
i = 0
while i < len(lines):
    if re.match(r"^\s*```bash\s*$", lines[i]):
        j = i + 1; block = []
        while j < len(lines) and not re.match(r"^\s*```\s*$", lines[j]):
            block.append(lines[j]); j += 1
        if any('ln -s "$new" "$t"' in l for l in block):
            ind = min(len(l) - len(l.lstrip()) for l in block if l.strip())
            print("\n".join(l[ind:] for l in block)); break
        i = j
    i += 1
PYX
}
scenario missing no; run_dispatch new
printf '%s' "$(comments)" > "$CTL/comment.md"
EN="$(snippet_of "$REPO_DIR/docs/operations.md")"; ZH="$(snippet_of "$REPO_DIR/docs/operations.zh.md")"
CMRAW="$(snippet_of "$CTL/comment.md")"; CM="$(printf '%s' "$CMRAW" | sed 's/claude/codex/g')"
chk "英文文档里有这段命令" "$([ -n "$EN" ] && echo yes)" yes
chk "中英文档一字不差" "$ZH" "$EN"
chk "交人留言里的命令和文档一字不差（命令名换成 codex 后）" "$CM" "$EN"
run_snippet() {   # <HOME> <new 的值> [命令段，默认文档那段] → 输出
    printf '%s\n' "${3:-$EN}" | sed "1s|^new=.*|new=$2|" > "$CTL/snip.sh"
    tmux_sandbox_env_i HOME="$1" LANG=C.UTF-8 bash "$CTL/snip.sh" 2>&1
}
H="$TMP/h10"
for kind in file dir link dangling; do
    rm -rf "$H"; mkdir -p "$H/.local/bin"
    case "$kind" in
        file) echo keep > "$H/.local/bin/codex" ;;
        dir) mkdir "$H/.local/bin/codex" ;;
        link) ln -s /bin/true "$H/.local/bin/codex" ;;
        dangling) ln -s "$H/nowhere" "$H/.local/bin/codex" ;;
    esac
    before="$(ls -la "$H/.local/bin" "$H/.local/bin/codex" 2>&1 | md5sum)"
    out="$(run_snippet "$H" "$AGENTDIR/claude")"
    has "[已有$kind] 停下，提示 already exists" "$out" "already exists"
    lacks "[已有$kind] 不说 linked" "$out" "linked"
    chk "[已有$kind] 那个位置原样不动（目录里也没多出软链）" "$(ls -la "$H/.local/bin" "$H/.local/bin/codex" 2>&1 | md5sum)" "$before"
done
rm -rf "$H"; mkdir -p "$H"
out="$(run_snippet "$H" "$AGENTDIR/claude")"
lacks "[目录本身不存在] 不说 linked" "$out" "linked"
# 空位置：照交人留言里的那段（命令名是本项目的 claude）真建软链，再照第 3 步等下一次派工——
# 检查在 worker 的环境里找得到（daemon 把 ~/.local/bin 放进 worker 的 PATH）
scenario relink no
mkdir -p "$S/home/.local/bin"
out="$(run_snippet "$S/home" "$AGENTDIR/claude" "$CMRAW")"
chk "[空位置] 输出 linked" "$out" "linked"
chk "[空位置] 软链指向新位置" "$(readlink "$S/home/.local/bin/claude")" "$AGENTDIR/claude"
run_dispatch new
chk "[建好之后] 下一次派工检查找得到，照常起" "$(labels)" "doing/agent"
chk "[建好之后] agent 真的跑起来了" "$(yesno wait_ran)" yes

echo
echo "结果：$pass 通过 / $fail 失败"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
