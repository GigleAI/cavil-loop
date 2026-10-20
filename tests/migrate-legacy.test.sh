#!/usr/bin/env bash
# 旧安装自动迁移（GigleAI/cavil-loop#71）的守卫。
#
# 跑法：bash tests/migrate-legacy.test.sh   （几秒）
# 依赖：jq / flock。不碰网络、不碰本机真实安装——HOME 指向 temp，systemctl / tmux 是假的
# （假 systemctl 把每个单元的 enabled / active 记成文件，假 tmux 从文件里列 session）。
#
# 为什么必须有这个文件：迁移错了**不会报错**——
#   · 状态目录没跟配置一起改 → 轮询照跑，但用的是空状态，历史评论全被当成新评论重新派工；
#   · 有 worker 在跑时动了目录 → 那个 worker 的 _lib.sh 在旧位置建出空目录，新旧各一份；
#   · 原来停用的项目被顺手启用、或者新旧两个 timer 同时开着 → 两个轮询抢同一批 issue；
#   · 中途断了不能接着做 → 卡在半新半旧，没人发现。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP="$(mktemp -d)"
cleanup() { chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

H="$TMP/home"
SYS="$H/.config/systemd/user"
OLDC="$H/.config/coding-agent-work-loop"
NEWC="$H/.config/cavil-loop"
OLDS="$H/.local/state/coding-agent-poll"
NEWS="$H/.local/state/cavil-loop"
SCTL="$TMP/sctl"            # 假 systemctl 的状态：$SCTL/enabled/<unit>、$SCTL/active/<unit>
TMUXF="$TMP/tmux-sessions"  # 假 tmux 列出的 session，一行一个
FAKEBIN="$TMP/bin"
mkdir -p "$SYS" "$OLDC" "$OLDS" "$SCTL/enabled" "$SCTL/active" "$FAKEBIN" "$H/.agents/skills" "$H/.claude/skills"
: > "$TMUXF"

cat > "$FAKEBIN/systemctl" <<'SH'
#!/usr/bin/env bash
[ "$1" = --user ] && shift
printf '%s\n' "$*" >> "$SCTL/calls"
cmd="$1"; shift
now=0; quiet=0; units=()
for a in "$@"; do case "$a" in --now) now=1 ;; --quiet) quiet=1 ;; *) units+=("$a") ;; esac; done
case "$cmd" in
    is-enabled) [ -e "$SCTL/enabled/${units[0]}" ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
    is-active)  [ -e "$SCTL/active/${units[0]}" ] && { [ $quiet = 1 ] || echo active; exit 0; }; [ $quiet = 1 ] || echo inactive; exit 3 ;;
    enable)  for u in "${units[@]}"; do [ -e "$SCTL/fail-enable" ] && exit 1; : > "$SCTL/enabled/$u"; [ $now = 1 ] && : > "$SCTL/active/$u"; done ;;
    disable) for u in "${units[@]}"; do rm -f "$SCTL/enabled/$u"; [ $now = 1 ] && rm -f "$SCTL/active/$u"; done ;;
    start)   for u in "${units[@]}"; do : > "$SCTL/active/$u"; done ;;
    stop)    for u in "${units[@]}"; do rm -f "$SCTL/active/$u"; done ;;
esac
exit 0
SH
cat > "$FAKEBIN/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in list-sessions|ls) [ -s "$TMUXF" ] || exit 1; cat "$TMUXF" ;; esac
SH
chmod +x "$FAKEBIN"/*

# ── 旧布局的假安装：技能入口指向本仓库（开发模式那种装法），四个项目 ──
ln -s "$REPO_DIR" "$H/.agents/skills/coding-agent-work-loop"
ln -s "$H/.agents/skills/coding-agent-work-loop" "$H/.claude/skills/coding-agent-work-loop"
for u in coding-agent-poll@.service coding-agent-poll@.timer 'app-coding\x2dagent\x2dpoll.slice' \
         coding-agent-preview@.socket coding-agent-preview@.service coding-agent-preview-app@.service \
         coding-agent-weekly-report@.service coding-agent-weekly-report@.timer; do
    ln -s "$H/.agents/skills/coding-agent-work-loop/systemd/$u" "$SYS/$u"
done
mkdir -p "$SYS/app-coding\x2dagent\x2dpoll.slice.d"
printf '[Slice]\nMemoryHigh=18G\n' > "$SYS/app-coding\x2dagent\x2dpoll.slice.d/limits.conf"
printf 'CAVIL_SKILL_LINK="$HOME/.agents/skills/coding-agent-work-loop"\nCAVIL_DEPLOY_FETCH_INTERVAL=120\n' > "$OLDC/deploy.conf"
chmod 600 "$OLDC/deploy.conf"
mkdir -p "$OLDC/preview"; printf 'PREVIEW_PORT=4007\n' > "$OLDC/preview/4007.conf"
mkdir -p "$OLDS/review-shots"; : > "$OLDS/review-shots/keep.png"

# make_project <key> <STATE_DIR 的写法> <enabled?> [weekly?]
make_project() {
    local k="$1" sdline="$2" en="$3" wk="${4:-}" p="$TMP/projects/$1"
    mkdir -p "$p" "$OLDS/$k/agent-sessions" "$OLDS/$k/sessions"
    cat > "$p/coding-agent.config" <<CONF
REPO="acme/$k"
PROJECT_ROOT="$p"
WORKTREE_BASE="$TMP/wt/$k"
# 旧的会话日志曾放在 \$HOME/.local/state/coding-agent-poll/$k/sessions
# 隔壁项目 \$HOME/.local/state/coding-agent-poll/${k}2 不能被一起改
STATE_DIR=$sdline
TMUX_PREFIX="$k"
SESSION_NAME_PREFIX="issue"
BRANCH_PREFIX="feature/issue-"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
    chmod 600 "$p/coding-agent.config"
    printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s/coding-agent.config\nPATH=/usr/bin:/bin\nGH_TOKEN=secret-%s\n' "$p" "$p" "$k" > "$OLDC/$k.conf"
    chmod 600 "$OLDC/$k.conf"
    printf '{"seen_comments":{"12":%s},"seen_issue_comments":{"7":99}}\n' "${#k}000" > "$OLDS/$k/state.json"
    printf 'uuid-%s\n' "$k" > "$OLDS/$k/agent-sessions/42.claude.worker"
    printf 'pane log\n' > "$OLDS/$k/sessions/issue42.log"
    ln -s "$H/.agents/skills/coding-agent-work-loop/systemd/coding-agent-poll@.timer" "$SYS/coding-agent-poll@$k.timer"
    if [ "$en" = yes ]; then : > "$SCTL/enabled/coding-agent-poll@$k.timer"; : > "$SCTL/active/coding-agent-poll@$k.timer"; fi
    if [ -n "$wk" ]; then : > "$SCTL/enabled/coding-agent-weekly-report@$k.timer"; : > "$SCTL/active/coding-agent-weekly-report@$k.timer"; fi
}
make_project alpha '"$HOME/.local/state/coding-agent-poll/alpha"' yes weekly
make_project beta  "\"$OLDS/beta\"" yes
make_project gamma "\"$OLDS/gamma\"" no
mkdir -p "$SYS/coding-agent-poll@alpha.timer.d"
printf '# 手写的：30 秒一轮\n[Timer]\nOnUnitActiveSec=\nOnBootSec=30s\nOnActiveSec=30s\nOnUnitActiveSec=30s\n' \
    > "$SYS/coding-agent-poll@alpha.timer.d/interval.conf"
cp -p "$OLDS/alpha/state.json" "$TMP/alpha-state.orig"
cp -p "$OLDS/beta/state.json" "$TMP/beta-state.orig"

migrate() {   # [args...]：默认 --all
    env -u CAVIL_SYSTEMD_USER_DIR HOME="$H" PATH="$FAKEBIN:$PATH" SCTL="$SCTL" TMUXF="$TMUXF" \
        bash "$REPO_DIR/scripts/migrate-legacy.sh" "${@:---all}" 2>>"$TMP/stderr"
}
enabled() { [ -e "$SCTL/enabled/$1" ] && echo yes || echo no; }
active()  { [ -e "$SCTL/active/$1" ] && echo yes || echo no; }
sdline()  { grep '^STATE_DIR=' "$TMP/projects/$1/coding-agent.config"; }

# ─────────────────────────────────────────────────────────────────────────────
echo "【1】alpha 有 worker 在跑：alpha 一步都不动，空闲的 beta / gamma 照迁"
printf 'alpha-issue5\nalpha-server\nbeta-dev\n' > "$TMUXF"
out=$(migrate)
chk "beta、gamma 迁了，alpha 没迁" "$(printf '%s\n' "$out" | cut -f2 | sort | tr '\n' ' ')" "beta gamma "
chk "alpha 旧环境文件还在、没有新的" "$([ -f "$OLDC/alpha.conf" ] && [ ! -e "$NEWC/alpha.conf" ] && echo yes)" "yes"
chk "alpha 状态目录原地未动"       "$([ -d "$OLDS/alpha" ] && [ ! -e "$NEWS/alpha" ] && echo yes)" "yes"
chk "alpha 配置未改"               "$(sdline alpha)" 'STATE_DIR="$HOME/.local/state/coding-agent-poll/alpha"'
chk "alpha 旧 timer 仍开着"         "$(enabled coding-agent-poll@alpha.timer)/$(active coding-agent-poll@alpha.timer)" "yes/yes"
chk "alpha 没起进度文件"            "$([ -e "$NEWC/migration/alpha.inprogress" ] && echo yes || echo no)" "no"
chk "日志写明 alpha 为什么没迁"     "$(grep -c 'alpha.*暂不迁移：还有 worker 在跑（alpha-issue5）' "$NEWS/migrate.log")" "1"

echo "【2】beta 迁完：新任务接手，已读评论记录与会话记录不丢"
chk "新环境文件在 ~/.config/cavil-loop/、权限 600" "$(stat -c %a "$NEWC/beta.conf" 2>/dev/null)" "600"
chk "新环境文件内容照搬（token 也在）" "$(grep -c '^GH_TOKEN=secret-beta$' "$NEWC/beta.conf")" "1"
chk "旧环境文件改名留底" "$(ls "$OLDC" | grep -c '^beta\.conf\.migrated-')" "1"
chk "旧位置没有状态目录了" "$([ -e "$OLDS/beta" ] && echo yes || echo no)" "no"
chk "已读评论记录原样搬到新位置" "$(cmp -s "$NEWS/beta/state.json" "$TMP/beta-state.orig" && echo same)" "same"
chk "会话记录在" "$(cat "$NEWS/beta/agent-sessions/42.claude.worker")" "uuid-beta"
chk "pane 日志在" "$([ -f "$NEWS/beta/sessions/issue42.log" ] && echo yes)" "yes"
chk "项目配置的状态目录改成新位置" "$(sdline beta)" "STATE_DIR=\"$NEWS/beta\""
chk "项目配置权限仍是 600" "$(stat -c %a "$TMP/projects/beta/coding-agent.config")" "600"
chk "项目根目录的本地配置文件没改名、没多出文件" "$(ls -A "$TMP/projects/beta" | tr '\n' ' ')" "coding-agent.config "
chk "新 timer 启用并启动" "$(enabled cavil-loop-poll@beta.timer)/$(active cavil-loop-poll@beta.timer)" "yes/yes"
chk "旧 timer 停用" "$(enabled coding-agent-poll@beta.timer)/$(active coding-agent-poll@beta.timer)" "no/no"
chk "没有停旧 service（迁移可能就跑在它这一轮里）" "$(grep -c 'coding-agent-poll@beta.service' "$SCTL/calls")" "0"
chk "单元目录里旧实例链接已移走" "$([ -e "$SYS/coding-agent-poll@beta.timer" ] || [ -L "$SYS/coding-agent-poll@beta.timer" ] && echo yes || echo no)" "no"
for u in cavil-loop-poll@.service cavil-loop-poll@.timer 'app-cavil\x2dloop\x2dpoll.slice' cavil-loop-preview@.socket \
         cavil-loop-weekly-report@.timer; do
    chk "新模板 $u 装好（经新技能入口、目标存在）" \
        "$([ "$(readlink "$SYS/$u")" = "$H/.agents/skills/cavil-loop/systemd/$u" ] && [ -f "$SYS/$u" ] && echo ok)" "ok"
done
chk "本机 slice 内存数字复制到新 slice" "$(cat "$SYS/app-cavil\x2dloop\x2dpoll.slice.d/limits.conf" 2>/dev/null | grep -c 18G)" "1"
chk "旧 slice 的 drop-in 留着（旧 tmux server 还挂在它下面）" "$([ -f "$SYS/app-coding\x2dagent\x2dpoll.slice.d/limits.conf" ] && echo yes)" "yes"
chk "新技能入口与旧入口指向同一处" "$(readlink "$H/.agents/skills/cavil-loop")" "$REPO_DIR"
chk "Claude Code 技能换成新名、不留旧名" \
    "$(readlink "$H/.claude/skills/cavil-loop")|$([ -L "$H/.claude/skills/coding-agent-work-loop" ] && echo old-left)" \
    "$H/.agents/skills/cavil-loop|"
chk "部署器配置搬到新目录，写死的旧入口换成新的" "$(head -1 "$NEWC/deploy.conf")" 'CAVIL_SKILL_LINK="$HOME/.agents/skills/cavil-loop"'
chk "部署器配置其余内容不变、权限 600" "$(grep -c '^CAVIL_DEPLOY_FETCH_INTERVAL=120$' "$NEWC/deploy.conf")/$(stat -c %a "$NEWC/deploy.conf")" "1/600"
chk "共享的配图目录不搬（公网地址指着它）" "$([ -f "$OLDS/review-shots/keep.png" ] && [ ! -e "$NEWS/review-shots" ] && echo yes)" "yes"
chk "旧预览登记不动（旧端口跟着自己的登记走）" "$([ -f "$OLDC/preview/4007.conf" ] && echo yes)" "yes"
bk=$(ls -d "$NEWC/migration/beta-"* 2>/dev/null | head -1)
chk "备份里有环境文件、项目配置、已读记录" \
    "$([ -f "$bk/beta.conf" ] && [ -f "$bk/coding-agent.config" ] && cmp -s "$bk/state/state.json" "$TMP/beta-state.orig" && echo yes)" "yes"
chk "备份的项目配置是改写前的原文" "$(grep -c "^STATE_DIR=\"$OLDS/beta\"" "$bk/coding-agent.config")" "1"
chk "备份目录 700（里面有 token）" "$(stat -c %a "$bk")" "700"
chk "本项目 poll.log 里留了一笔" "$(grep -c '本项目已从' "$NEWS/beta/poll.log")" "1"
chk "migrate.log 写清搬了什么" \
    "$(grep -E '\[migrate beta\]' "$NEWS/migrate.log" | grep -cE '状态目录：|项目配置：|新后台任务：cavil-loop-poll@beta.timer 已启用|✅ 迁移完成')" "4"
echo "【2b】gamma 原本是停用的：迁完新任务也保持停用"
chk "gamma 新 timer 没被启用" "$(enabled cavil-loop-poll@gamma.timer)/$(active cavil-loop-poll@gamma.timer)" "no/no"
chk "gamma 文件照样迁了" "$([ -f "$NEWC/gamma.conf" ] && [ -d "$NEWS/gamma" ] && echo yes)" "yes"

echo "【3】重复跑：迁过的不再动，没迁的照旧等"
cp "$SCTL/calls" "$TMP/calls.before"
before=$(cd "$H" && find . | sort | md5sum)
out=$(migrate); rc=$?
chk "退出码 0、没有新迁的" "$rc|$out" "0|"
chk "文件一个没变" "$(cd "$H" && find . | sort | md5sum)" "$before"
chk "没有再去启停任何单元" "$(diff "$TMP/calls.before" "$SCTL/calls" | grep -cE '^> (enable|disable|start|stop)')" "0"
chk "alpha 的等待原因没有重复记日志（一小时一次）" "$(grep -c 'alpha.*暂不迁移' "$NEWS/migrate.log")" "1"

echo "【4】alpha 空闲了，但写回项目配置那一步失败：状态目录已搬、配置还旧——下次接着做完"
: > "$TMUXF"
chmod 555 "$TMP/projects/alpha"
out=$(migrate)
chk "这一轮没算迁完" "$out" ""
chk "状态目录已经在新位置" "$([ -d "$NEWS/alpha" ] && [ ! -e "$OLDS/alpha" ] && echo yes)" "yes"
chk "配置还是旧的" "$(sdline alpha)" 'STATE_DIR="$HOME/.local/state/coding-agent-poll/alpha"'
chk "旧 timer 还没停（没做完就不交接）" "$(enabled coding-agent-poll@alpha.timer)" "yes"
chk "旧环境文件还在（下次会回来接着做）" "$([ -f "$OLDC/alpha.conf" ] && echo yes)" "yes"
chk "日志写明卡在哪" "$(grep -c '写回项目配置.*失败' "$NEWS/migrate.log")" "1"
chmod 755 "$TMP/projects/alpha"
out=$(migrate)
chk "第二次迁完 alpha" "$(printf '%s\n' "$out" | cut -f2)" "alpha"
chk "配置改成新位置，保留 \$HOME 写法" "$(sdline alpha)" 'STATE_DIR="$HOME/.local/state/cavil-loop/alpha"'
chk "注释里同一路径也改了" "$(grep -c '^# 旧的会话日志曾放在 \$HOME/.local/state/cavil-loop/alpha/sessions$' "$TMP/projects/alpha/coding-agent.config")" "1"
chk "名字只是前缀相同的隔壁路径没被误改" "$(grep -c 'coding-agent-poll/alpha2 不能' "$TMP/projects/alpha/coding-agent.config")" "1"
chk "已读评论记录不丢" "$(cmp -s "$NEWS/alpha/state.json" "$TMP/alpha-state.orig" && echo same)" "same"
chk "手写的轮询间隔 drop-in 原样带到新 timer" \
    "$(cmp -s "$SYS/cavil-loop-poll@alpha.timer.d/interval.conf" "$(ls -d "$NEWC/migration/alpha-"*)/coding-agent-poll@alpha.timer.d/interval.conf" && echo same)" "same"
chk "旧 timer 的 drop-in 收进备份、不留在单元目录" "$([ -e "$SYS/coding-agent-poll@alpha.timer.d" ] && echo yes || echo no)" "no"
chk "alpha 新轮询 timer 接手" "$(enabled cavil-loop-poll@alpha.timer)/$(active cavil-loop-poll@alpha.timer)" "yes/yes"
chk "alpha 周报 timer 也换成新的" \
    "$(enabled cavil-loop-weekly-report@alpha.timer)/$(enabled coding-agent-weekly-report@alpha.timer)" "yes/no"
chk "进度文件以第一次记的原状态为准、迁完标记 done" \
    "$(grep -c '^POLL_ENABLED=yes$' "$NEWC/migration/alpha.done")/$([ -e "$NEWC/migration/alpha.inprogress" ] && echo left || echo gone)" "1/gone"

echo "【5】全部迁完：旧技能入口删掉，原先经过它的旧单元链接改走新入口、仍然有效"
chk "旧技能入口删了" "$([ -e "$H/.agents/skills/coding-agent-work-loop" ] || [ -L "$H/.agents/skills/coding-agent-work-loop" ] && echo yes || echo no)" "no"
dangling=0; via_old=0
for u in "$SYS"/*; do
    [ -L "$u" ] || continue
    [ -e "$u" ] || dangling=$((dangling+1))
    case "$(readlink "$u")" in *coding-agent-work-loop*) via_old=$((via_old+1)) ;; esac
done
chk "单元目录里没有悬空链接" "$dangling" "0"
chk "没有链接还经过旧入口" "$via_old" "0"
chk "旧预览模板仍在（旧端口还要用）" "$([ -f "$SYS/coding-agent-preview@.socket" ] && echo yes)" "yes"
chk "新旧 timer 没有同时开着的项目" \
    "$(for k in alpha beta gamma; do [ "$(enabled coding-agent-poll@$k.timer)$(enabled cavil-loop-poll@$k.timer)" = yesyes ] && echo $k; done)" ""
chk "stderr 里没有脚本报错" "$(grep -cE 'line [0-9]+:|unbound variable|syntax error' "$TMP/stderr")" "0"

echo "【6】停手等人的两种情况"
# 新旧环境文件都在、又不是迁移留下的半成品
printf 'PROJECT_ROOT=/x\nCODING_AGENT_CONFIG=/x/c\n' > "$OLDC/delta.conf"
printf 'PROJECT_ROOT=/x\nCODING_AGENT_CONFIG=/x/c\n' > "$NEWC/delta.conf"
ln -sfn "$REPO_DIR" "$H/.agents/skills/coding-agent-work-loop"
migrate --key delta; rc=$?
chk "新旧环境文件都在 → 不动、报需要人工" "$rc|$(grep -c 'delta.*⛔ 新旧两份环境文件都在' "$NEWS/migrate.log")" "1|1"
rm -f "$OLDC/delta.conf" "$NEWC/delta.conf"
# 新旧两个状态目录都在
make_project eps "\"$OLDS/eps\"" yes
mkdir -p "$NEWS/eps"
migrate --key eps >/dev/null; rc=$?
chk "新旧状态目录都在 → 不搬、报需要人工" "$rc|$(grep -c 'eps.*⛔ 新旧两个状态目录都在' "$NEWS/migrate.log")" "1|1"
chk "  旧状态目录原封不动" "$(cmp -s "$OLDS/eps/state.json" <(printf '{"seen_comments":{"12":3000},"seen_issue_comments":{"7":99}}\n') && echo same)" "same"
chk "  旧 timer 仍开着" "$(enabled coding-agent-poll@eps.timer)" "yes"
rm -rf "$NEWS/eps"
migrate --key eps >/dev/null; rc=$?
chk "人清掉多余的那份后，再跑就迁完" "$rc|$(sdline eps)" "0|STATE_DIR=\"$NEWS/eps\""

echo "【7】轮询入口：迁的正是本项目时这一轮让位给新任务，不跑主轮询"
make_project zeta "\"$OLDS/zeta\"" yes
EH="$H"
out=$(env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CAVIL_DEPLOY_CONF -u CODING_AGENT_RELEASE_ROOT \
          HOME="$EH" PATH="$FAKEBIN:$PATH" SCTL="$SCTL" TMUXF="$TMUXF" \
          CODING_AGENT_CONFIG="$TMP/projects/zeta/coding-agent.config" PROJECT_ROOT="$TMP/projects/zeta" \
          timeout 30 bash "$REPO_DIR/scripts/poll-entry.sh" 2>&1); rc=$?
chk "退出码 0" "$rc" "0"
chk "zeta 迁了" "$([ -f "$NEWC/zeta.conf" ] && [ -d "$NEWS/zeta" ] && echo yes)" "yes"
chk "这一轮没进主轮询（poll.log 里没有 poll start）" "$(grep -c 'poll start' "$NEWS/zeta/poll.log" 2>/dev/null)" "0"

echo "【8】「哪些 tmux 会话算 worker」：迁移的判断与轮询自己的 list_worker_sessions 逐个对拍"
# 迁移不能 source _lib.sh（一 source 就在配置的状态目录 mkdir），只好自己写一份同样的匹配；
# 两份必须对同一批会话名给出同样的答案。
make_project eta "\"$OLDS/eta\"" yes
names=(eta-issue5 eta-issue12 eta-issue eta-issue5-x eta-server xeta-issue5 eta-issue5a etaissue5 beta-issue5 'eta-issue5 ')
lib_says() {   # <session>：轮询的 list_worker_sessions 认不认它
    printf '%s\n' "$1" > "$TMUXF"
    env HOME="$H" PATH="$FAKEBIN:$PATH" TMUXF="$TMUXF" CODING_AGENT_CONFIG="$TMP/projects/eta/coding-agent.config" \
        bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; list_worker_sessions' _ "$REPO_DIR" | grep -c .
}
mig_says() {   # <session>：迁移会不会因为它而等
    printf '%s\n' "$1" > "$TMUXF"
    migrate --key eta >/dev/null; [ $? = 3 ] && echo 1 || echo 0
}
# 对拍前先把 eta 的状态备份——lib_says 会在它的状态目录建东西，但不会迁走它
diffs=""; worker_seen=0
for n in "${names[@]}"; do
    l=$(lib_says "$n")
    [ "$l" = 1 ] && worker_seen=$((worker_seen+1))
    if [ "$l" = 1 ]; then
        m=$(mig_says "$n")
        [ "$m" = "$l" ] || diffs+="[$n] "
    fi
done
chk "轮询认作 worker 的会话，迁移都会等" "$diffs" ""
chk "夹具里确实有会被认作 worker 的会话（对拍不是空跑）" "$([ "$worker_seen" -ge 2 ] && echo yes)" "yes"
# 不是 worker 的会话放在最后逐个跑：一旦判成空闲，eta 就真迁走了，后面的就没得比
diffs=""
for n in "${names[@]}"; do
    l=$(lib_says "$n"); [ "$l" = 0 ] || continue
    [ -f "$OLDC/eta.conf" ] || { diffs+="(eta 已提前迁走) "; break; }
    m=$(mig_says "$n")
    [ "$m" = 0 ] || diffs+="[$n] "
    # 判成空闲时迁移已经做完——把它恢复成旧布局，接着比下一个
    if [ "$m" = 0 ] && [ -f "$NEWC/eta.conf" ]; then
        rm -f "$NEWC/eta.conf" "$NEWC/migration/eta.done"; rm -rf "$NEWC/migration/eta-"*
        mv "$OLDC"/eta.conf.migrated-* "$OLDC/eta.conf"; mv "$NEWS/eta" "$OLDS/eta"
        sed -i "s|$NEWS/eta|$OLDS/eta|" "$TMP/projects/eta/coding-agent.config"
        rm -f "$SCTL/enabled/cavil-loop-poll@eta.timer" "$SCTL/active/cavil-loop-poll@eta.timer"
        : > "$SCTL/enabled/coding-agent-poll@eta.timer"
        [ -e "$SYS/coding-agent-poll@eta.timer" ] || ln -s "$H/.agents/skills/cavil-loop/systemd/coding-agent-poll@.timer" "$SYS/coding-agent-poll@eta.timer"
    fi
done
chk "轮询不认的会话（预览服、前缀相近的别的项目），迁移也不因它而等" "$diffs" ""
: > "$TMUXF"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
