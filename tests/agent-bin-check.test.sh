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
#   7. 转人工写到一半失败：加人工标签、摘派工标签失败 → 停在那一步，自愈计数不清零、不起会话；留言失败时沿用
#      现有转人工函数的做法（留言失败不拦后面的标签，所有派工前转人工都这样）
#   8. 真 agent-poll.sh：会话消失后 self-heal 的日志和用完次数的交人留言带上退出码，不再说「疑似会话损坏」；
#      下一轮派工检查到命令不在 → 转人工、计数清零（跨轮）
#   9. cleanup-issue.sh 删掉退出码记录
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
    rm -rf "$CTL/items" "$CTL/comments" "$CTL/ran" "$CTL/gh.log" "$CTL/tmux.log" "$CTL"/fail-* "$CTL/stall" "$CTL/flip-shell"
    tmux kill-session -t "=abc-issue$N" 2>/dev/null
    tmux set-option -gu default-shell 2>/dev/null; tmux set-environment -gu BASH_ENV 2>/dev/null
    return 0
}
# 派工。$1 = new | issue（issue 评论派工；worktree 先建好）
run_dispatch() {
    if [ "$1" = issue ] && [ ! -d "$S/wt/issue-$N" ]; then
        gq -C "$S/proj" worktree add -q "$S/wt/issue-$N" -b "feature/issue-$N"
    fi
    local script=dispatch-new-issue.sh; [ "$1" = issue ] && script=dispatch-issue-comment.sh
    (cd "$S/proj" && tmux_sandbox_env_i HOME="$S/home" LANG=C.UTF-8 CODING_AGENT_CONFIG="$S/config" \
        timeout 120 bash "$REPO_DIR/scripts/$script" "$N" 0) > "$S/dispatch.out" 2>&1
    echo $? > "$S/rc"
}
labels() { sort "$CTL/items/$N" 2>/dev/null | paste -sd, -; }
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

echo "【7】转人工写到一半失败：标签写失败就停在那一步、计数不清零；留言失败照现有转人工的做法继续翻标签"
for step in comment add del; do
    scenario "half-$step" no
    selfheal_set 1
    touch "$CTL/fail-$step"
    run_dispatch new
    chk "[$step 失败] 没起 worker 会话" "$(yesno sess_alive)" no
    case "$step" in
        comment) chk "[留言失败] 照现有转人工函数继续翻成 pending/human" "$(labels)" "pending/human"
                 chk "[留言失败] 标签都写成了，计数清零" "$(selfheal_now)" none
                 chk "到达性 · [留言失败] 确实发过一次留言请求" "$(grep -c -- '-X POST repos/example/none/issues/'"$N"'/comments' "$CTL/gh.log")" 1 ;;
        add) chk "[加人工标签失败] 自愈计数没清零" "$(selfheal_now)" 1
             chk "[加人工标签失败] 仍是派工标签" "$(labels)" "pending/agent"
             has "[加人工标签失败] 留言已发" "$(comments)" '找不到 `claude` 命令' ;;
        del) chk "[摘派工标签失败] 自愈计数没清零" "$(selfheal_now)" 1
             chk "[摘派工标签失败] 两个标签同挂" "$(labels)" "pending/agent,pending/human" ;;
    esac
done

echo "【8】真 agent-poll.sh：self-heal 带退出码；下一轮检查到命令不在 → 转人工、计数清零"
POLLS="$TMP/poll"; rm -rf "$POLLS"; mkdir -p "$POLLS/gh" "$POLLS/bin" "$POLLS/state" "$POLLS/wt" "$POLLS/home"
gq clone -q "$TMP/up.git" "$POLLS/project"
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$POLLS/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cp "$FAKEBIN/tmux" "$FAKEBIN/systemctl" "$POLLS/bin/"
GD="$POLLS/gh"
echo '{}' > "$GD/events.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
jq -n --arg i "$N" '{($i): {kind:"issue", state:"open", title:"新需求", body:"做一件事", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}}' > "$GD/items.json"
jq -n --arg i "$N" '{($i): ["doing/agent"]}' > "$GD/labels.json"
echo '{}' > "$GD/comments.json"
gq -C "$POLLS/project" worktree add -q "$POLLS/wt/issue-$N" -b "feature/issue-$N"
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
PATH="$POLLS/bin:\$(printf '%s' "\$PATH" | tr ':' '\n' | grep -vxF -f "$CTL/hide" | paste -sd: -)"
CONF
chmod 600 "$POLLS/config"
# 上一次这个条目的程序以 127 退出（和第【4】组同一种记录），会话已经不在
mkdir -p "$POLLS/state/worker-exit"
echo "tok-1" > "$POLLS/state/worker-exit/abc-issue$N.launch"
echo "127 tok-1" > "$POLLS/state/worker-exit/abc-issue$N"
HOSTID=$(tmux_sandbox_env_i HOME="$POLLS/home" CODING_AGENT_CONFIG="$POLLS/config" REPO_DIR="$REPO_DIR" OUT="$POLLS/hostid" \
    bash -c 'source "$REPO_DIR/scripts/_lib.sh"; printf "%s" "$SELFHEAL_HOST_ID" > "$OUT"' 2>/dev/null; cat "$POLLS/hostid" 2>/dev/null)
jq -n --arg i "$N" --arg h "$HOSTID" '{cleaned_prs:[], cleaned_issues:[], worker_hosts: {($i): $h}, worker_trigger_labels: {($i): "pending/agent"}}' > "$POLLS/state/state.json"
poll_round() {
    (cd "$POLLS/project" && tmux_sandbox_env_i HOME="$POLLS/home" LANG=C.UTF-8 CODING_AGENT_CONFIG="$POLLS/config" \
        FAKE_GH_LISTS=1 FAKE_GH_REPO=example/sm FAKE_GH_DIR="$GD" \
        timeout 180 bash "$REPO_DIR/scripts/agent-poll.sh") > /dev/null 2>&1
}
plabels() { jq -r --arg n "$N" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
poll_round
PLOG="$(cat "$POLLS/state/poll.log" 2>/dev/null)"
has "第 1 轮 self-heal 日志带退出码" "$PLOG" "不存在（退出码 127：找不到命令"
chk "第 1 轮 self-heal 计了一次" "$(cat "$POLLS/state/selfheal/$N" 2>/dev/null)" 1
chk "第 1 轮送回派工标签" "$(plabels)" "pending/agent"
poll_round
PLOG="$(cat "$POLLS/state/poll.log" 2>/dev/null)"
has "第 2 轮派工时检查到命令不在" "$PLOG" "起 worker 前检查：daemon 交给 worker 的 PATH 里找不到"
chk "第 2 轮转人工" "$(plabels)" "pending/human"
chk "转人工后自愈计数清零" "$(cat "$POLLS/state/selfheal/$N" 2>/dev/null || echo none)" none
chk "没起 worker 会话" "$(yesno sess_alive)" no
# 用完次数的那条路：计数已到上限时，会话消失直接交人，留言带退出码
jq -n --arg i "$N" '{($i): ["doing/agent"]}' > "$GD/labels.json"
mkdir -p "$POLLS/state/selfheal"; echo 1 > "$POLLS/state/selfheal/$N"
poll_round
PCOM="$(jq -r '.. | .body? // empty' "$GD"/comments*.json 2>/dev/null; cat "$GD"/*.log 2>/dev/null)"
has "用完次数交人：日志带退出码" "$(cat "$POLLS/state/poll.log")" "次仍死（退出码 127：找不到命令"
lacks "不再说疑似会话损坏" "$(cat "$POLLS/state/poll.log")" "疑似会话损坏"
has "用完次数交人：留言带退出码" "$PCOM" "退出码 127：找不到命令"
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
c0=$(checks_so_far); poll_round
chk "派工标签 + 人工标签同挂：这一轮照常派、再查了一次" "$(( $(checks_so_far) - c0 ))" 1
chk "再查仍找不到：转成只剩 pending/human" "$(plabels)" "pending/human"

echo "【9】cleanup-issue.sh 删掉退出码记录"
S="$RESPAWN_S"
tmux kill-session -t "=abc-issue$N" 2>/dev/null
(cd "$S/proj" && tmux_sandbox_env_i HOME="$S/home" LANG=C.UTF-8 CODING_AGENT_CONFIG="$S/config" \
    timeout 60 bash "$REPO_DIR/scripts/cleanup-issue.sh" "$N") > /dev/null 2>&1
chk "退出码记录删掉了" "$(ls "$S/state/worker-exit/" 2>/dev/null | grep -c "abc-issue$N")" 0

echo
echo "结果：$pass 通过 / $fail 失败"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
