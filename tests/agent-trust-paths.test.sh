#!/usr/bin/env bash
# kind: install
# reads: repo
# 目录信任（GitHub#108）：派工 / 部署前给 agent 预写 folder-trust 记录，起会话后认出确认框。
#
# 跑法：bash tests/agent-trust-paths.test.sh            （默认回归，约 1 分钟）
# 依赖：git、jq、python3（3.11+，读 TOML）、flock。全程在临时 HOME 里，不碰真实
# ~/.claude.json / ~/.codex/config.toml，不调真 gh / tmux / claude / codex。
#
# 这条链路错了**不会报错**，所以每组都要分得出对错实现：
#   · 信任记到错的目录 → worker 挂在确认框上，session 活着、issue 照常翻 doing/agent，
#     日志里只剩一行回捞超时。claude / codex 对 git worktree 都**不认上级目录**，
#     子模块又各有说法——夹具因此用真实的 git 仓库 / worktree / 子模块 / bare 仓库布局；
#   · 几个项目共用一份配置文件：没有共享锁时两个写入者互相抹掉对方刚加的条目，两边都报成功——
#     用真实写入函数做受控交错；
#   · 写坏了 → 赔上用户整个配置文件；不幂等 → 每次派工都跟活着的 agent 抢写；
#   · 认不出确认框 → 卡住的那次静默挂着。派工脚本有四个起会话的入口，逐个跑真脚本。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP=$(mktemp -d)
TMP="$(cd "$TMP" && pwd -P)"
cleanup() { [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$TMP"; return 0; }; rm -rf "$TMP"; }
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1${2:+ —— $2}"; fail=$((fail+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望 '$3'，实得 '$2'"; fi; }
# suite 打印 PASS <名字> / FAIL <名字> :: <原因>，这里转成 ✅ / ❌（不用管道：计数要留在主 shell）
report() {
    local l n
    while IFS= read -r l; do
        case "$l" in
            PASS\ *) ok "${l#PASS }" ;;
            FAIL\ *) n="${l#FAIL }"; bad "${n%% ::*}" "${n#* :: }" ;;
            # 认不出的行一律算红：截断到半个汉字的行会让 case 匹配失败，以前就这样悄悄少算了一条
            *) [ -z "$l" ] || bad "认不出的检查输出" "$l" ;;
        esac
    done
}
run_suite() { report < <("$@"); }

# ── 真机截屏（tests/fixtures/trust-dialog/，路径已换成假路径）──────────────────
FIX="$TEST_DIR/fixtures/trust-dialog"
# 正常界面里插一段「对话内容」：正好在讨论这个功能，把确认框的标题、选项、底栏原样引用了一遍。
# 插在输入框上方——真实界面里对话永远在输入框和状态栏之上。
prose_screen() {   # <agent> <quote-full|one-phrase>
    local agent="$1" how="$2" normal quote
    normal="$FIX/$agent-normal.txt"
    if [ "$how" = one-phrase ]; then
        # 复审给的原句，补成完整标题——比只出现半句更难分辨
        quote="Assistant: I am investigating why the text Quick safety check: Is this a project you created or one you trust? / Trust this folder? appears in the startup code.
Working normally..."
    else
        quote="⏺ 用户贴过来的屏幕是这样的：
$(cat "$FIX/$agent-trust.txt" | grep -v '^[[:space:]]*$')
⏺ 这就是信任确认框，下面开始修。"
    fi
    awk -v q="$quote" -v a="$agent" '
        !done && ((a == "claude" && /^❯/) || (a == "codex" && /^› Ask Codex/)) { print q; done = 1 }
        { print }' "$normal"
}

# ── 假命令 ───────────────────────────────────────────────────────────────────
FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
REAL_MV="$(PATH=/usr/bin:/bin command -v mv)"
# mv：替换到 MV_PAUSE_TARGET 时先停住，等 MV_PAUSE_DIR/release 出现再放行（受控交错用）
cat > "$FAKEBIN/mv" <<SH
#!/usr/bin/env bash
dst="\${@: -1}"
if [ -n "\${MV_PAUSE_TARGET:-}" ] && [ "\$dst" = "\$MV_PAUSE_TARGET" ] && [ -n "\${MV_PAUSE_DIR:-}" ]; then
    : > "\$MV_PAUSE_DIR/paused"
    while [ ! -e "\$MV_PAUSE_DIR/release" ]; do sleep 0.05; done
fi
exec "$REAL_MV" "\$@"
SH
# tmux：有状态的假货。new-session 时把两份配置文件拍个快照（断言「起会话那一刻已经信任」）
cat > "$FAKEBIN/tmux" <<'SH'
#!/usr/bin/env bash
# 起 worker 前的 agent 命令检查（GitHub#731）开的检查会话：假 tmux 起不了，检查按「不知道」照常往下走；
# 不记录、不算起程序（检查在 tests/agent-bin-check.test.sh 测）
[[ "$*" == *" -s cavil-bincheck-"* ]] && exit 1
FT="${FAKE_TMUX_DIR:?}"; mkdir -p "$FT"
echo "$*" >> "$FT/calls"
tgt() { local a; while [ $# -gt 0 ]; do [ "$1" = -t ] && { a="$2"; a="${a#=}"; printf '%s' "${a%%:*}"; return; }; shift; done; }
case "$1" in
    new-session)
        shift; name=""; dir=""
        while [ $# -gt 0 ]; do
            case "$1" in -s) name="$2"; shift 2 ;; -c) dir="$2"; shift 2 ;; -e|-F) shift 2 ;; -d|-P) shift ;; *) break ;; esac
        done
        n=$(( $(cat "$FT/launches" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FT/launches"
        mkdir -p "$FT/snap.$n"
        cp "$HOME/.claude.json" "$FT/snap.$n/claude.json" 2>/dev/null
        cp "$HOME/.codex/config.toml" "$FT/snap.$n/config.toml" 2>/dev/null
        printf '%s\n' "$dir" > "$FT/snap.$n/cwd"
        printf '%s\n' "$1" > "$FT/snap.$n/cmd"
        : > "$FT/alive.$name"
        case " ${FAKE_TMUX_DIE_LAUNCHES:-} " in *" $n "*) rm -f "$FT/alive.$name" ;; esac
        exit 0 ;;
    has-session) [ -e "$FT/alive.$(tgt "$@")" ] ;;
    list-panes)  [ -e "$FT/alive.$(tgt "$@")" ] && echo 0 ;;
    capture-pane) [ -e "$FT/alive.$(tgt "$@")" ] || exit 1; cat "${FAKE_PANE_FILE:-/dev/null}" 2>/dev/null; exit 0 ;;
    kill-session) echo "$(tgt "$@")" >> "$FT/killed"; rm -f "$FT/alive.$(tgt "$@")"; exit 0 ;;
    *) exit 0 ;;
esac
SH
# gh：记下每次调用；标题等一律给个占位
cat > "$FAKEBIN/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GH_LOG:-/dev/null}"
# 派工先读条目、认领、读回（GitHub#700）：单条读取和标签增删按状态回答
[ -z "${FAKE_ITEM_LABELS_LIB:-}" ] || . "$FAKE_ITEM_LABELS_LIB" "$@"
case "$*" in
    "auth status"*) exit 0 ;;
    "repo view"*) echo "acme/widget"; exit 0 ;;
    *"--jq .title"*|*title*) echo "测试标题"; exit 0 ;;
    *"label create"*) exit 0 ;;
esac
echo "{}"
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/claude"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/codex"
cat > "$FAKEBIN/systemctl" <<'SH'
#!/usr/bin/env bash
case "$*" in *is-active*) exit 3 ;; *is-enabled*) echo disabled; exit 1 ;; esac
exit 0
SH
chmod +x "$FAKEBIN"/*
export PATH="$FAKEBIN:$PATH"

# ── 真实 git 布局 ─────────────────────────────────────────────────────────────
G="$TMP/git"; mkdir -p "$G"
gq() { git -c user.email=t@example.invalid -c user.name=t -c protocol.file.allow=always "$@" >/dev/null 2>&1; }
gq init -q --bare "$G/up.git"
gq clone -q "$G/up.git" "$G/seed"
(cd "$G/seed" && echo x > f && gq add f && gq commit -qm init && gq push -q origin HEAD:main)
gq clone -q "$G/up.git" "$G/proj"                          # 普通仓库的主 checkout
gq -C "$G/proj" worktree add -q "$G/wt/proj-1" -b f1       # 它的 worktree
gq init -q -b main "$G/super"                              # 上层仓库
gq -C "$G/super" submodule add -q "$G/up.git" sub          # 子模块
gq -C "$G/super" commit -qm s
gq -C "$G/super/sub" worktree add -q "$G/wt/sub-1" -b f2   # 子模块的 worktree
gq clone -q --bare "$G/up.git" "$G/bare.git"               # bare 仓库
gq -C "$G/bare.git" worktree add -q "$G/wt/bare-1" main    # bare 仓库的 worktree
mkdir -p "$G/plain/child"                                   # 不在 git 里
ln -s "$G/proj" "$G/link-proj"                              # 软链进来的路径

if [ ! -d "$G/wt/sub-1" ] || [ ! -d "$G/wt/bare-1" ] || [ ! -d "$G/wt/proj-1" ]; then
    echo "夹具没建成（git 版本？）"; exit 1
fi

# 在隔离 HOME 里 source 某个 skill 目录的 driver，跑一段命令。$1 = skill 目录，$2 = agent，其余 = 命令
in_driver() {
    local R="$1" agent="$2"; shift 2
    env -u CLAUDE_JSON_PATH -u CODEX_HOME -u CLAUDE_CONFIG_DIR -u CAVIL_TRUST_LOCK_DIR HOME="$H" \
        bash -c 'source "$1/scripts/drivers/_common.sh" && PROJECT_ROOT=/nonexistent source_driver "$2" >/dev/null 2>&1 || exit 99; shift 2; "$@"' \
        _ "$R" "$agent" "$@"
}
new_home() { H="$TMP/home-$1"; rm -rf "$H"; mkdir -p "$H"; }
cj() { printf '%s' "$H/.claude.json"; }
ct() { printf '%s' "$H/.codex/config.toml"; }
c_trusted() { jq -r --arg p "$2" '.projects[$p].hasTrustDialogAccepted // false' "$1" 2>/dev/null || echo false; }
x_level() {   # <toml> <key> → trust_level 或 none
    python3 -c 'import sys,tomllib
try: d=tomllib.load(open(sys.argv[1],"rb"))
except Exception: print("none"); sys.exit()
print(d.get("projects",{}).get(sys.argv[2],{}).get("trust_level","none"))' "$1" "$2"
}
real_of() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

# ═══ S1. 信任记到哪个目录：两种 agent × 真实布局 ═══
suite_keys() {   # <skill 目录>
    local R="$1" got
    new_home keys
    while IFS='|' read -r agent dir want name; do
        [ -n "$agent" ] || continue
        got="$(in_driver "$R" "$agent" agent_trust_key "$dir")"
        if [ "$got" = "$want" ]; then echo "PASS key·$agent·$name"
        else echo "FAIL key·$agent·$name :: 期望 $want，实得 $got"; fi
    done <<EOF
claude|$G/proj|$G/proj|普通仓库主 checkout → 仓库根
claude|$G/wt/proj-1|$G/proj|普通仓库的 worktree → 所属仓库根
claude|$G/super/sub|$G/super/.git/modules/sub|子模块 → .git/modules/<名字>
claude|$G/wt/sub-1|$G/super/.git/modules/sub|子模块的 worktree → .git/modules/<名字>
claude|$G/wt/bare-1|$G/bare.git|bare 仓库的 worktree → bare 仓库目录
claude|$G/plain/child|$G/plain/child|不在 git 里 → 目录本身
claude|$G/link-proj|$G/proj|软链路径 → 物理路径
codex|$G/proj|$G/proj|普通仓库主 checkout → 仓库根
codex|$G/wt/proj-1|$G/proj|普通仓库的 worktree → 仓库根
codex|$G/super/sub|$G/super/sub|子模块 → 它自己
codex|$G/wt/sub-1|$G/wt/sub-1|子模块的 worktree → worktree 自己
codex|$G/wt/bare-1|$G/wt/bare-1|bare 仓库的 worktree → worktree 自己
codex|$G/plain/child|$G/plain/child|不在 git 里 → 目录本身
codex|$G/link-proj|$G/proj|软链路径 → 物理路径
EOF
}

# ═══ S2. claude 写入函数：内容保留、幂等、坏文件不动 ═══
suite_claude_writer() {
    local R="$1" f ino sum rc
    new_home cw; f="$(cj)"
    in_driver "$R" claude agent_trust_paths /repo/acme 2>/dev/null; rc=$?
    [ "$rc" = 0 ] && [ "$(c_trusted "$f" /repo/acme)" = true ] && echo "PASS claude·文件不存在时建出来并信任" \
        || echo "FAIL claude·文件不存在时建出来并信任 :: rc=$rc"
    cat > "$f" <<'JSON'
{"numStartups":42,"projects":{"/repo/old":{"hasTrustDialogAccepted":true,"allowedTools":["Bash(ls)"],"history":[{"display":"x"}]}}}
JSON
    chmod 640 "$f"
    in_driver "$R" claude agent_trust_paths "/repo/ai hub" "/工作区/项目" 2>/dev/null
    if [ "$(jq -r .numStartups "$f")" = 42 ] && [ "$(jq -r '.projects["/repo/old"].history[0].display' "$f")" = x ] \
       && [ "$(jq -r '.projects["/repo/old"].allowedTools[0]' "$f")" = "Bash(ls)" ]; then
        echo "PASS claude·别的字段和别的项目原样保留"
    else echo "FAIL claude·别的字段和别的项目原样保留 :: $(tr "\n" " " < "$f")"; fi
    [ "$(c_trusted "$f" "/repo/ai hub")$(c_trusted "$f" "/工作区/项目")" = truetrue ] \
        && echo "PASS claude·带空格 / 中文的路径" || echo "FAIL claude·带空格 / 中文的路径 :: $(tr "\n" " " < "$f")"
    [ "$(stat -c %a "$f")" = 640 ] && echo "PASS claude·替换后保留原文件权限" || echo "FAIL claude·替换后保留原文件权限 :: $(stat -c %a "$f")"
    ino=$(ls -i "$f" | awk '{print $1}'); sum=$(cksum < "$f")
    in_driver "$R" claude agent_trust_paths "/repo/ai hub" 2>/dev/null; rc=$?
    [ "$rc" = 0 ] && [ "$(cksum < "$f")" = "$sum" ] && [ "$(ls -i "$f" | awk '{print $1}')" = "$ino" ] \
        && echo "PASS claude·已信任时一个字节都不写" || echo "FAIL claude·已信任时一个字节都不写 :: rc=$rc"
    echo '{"projects":{"/repo/acme":{"hasTrustDialogAccepted":false,"allowedTools":["Edit"]}}}' > "$f"
    in_driver "$R" claude agent_trust_paths /repo/acme 2>/dev/null
    [ "$(c_trusted "$f" /repo/acme)$(jq -r '.projects["/repo/acme"].allowedTools[0]' "$f")" = trueEdit ] \
        && echo "PASS claude·false 补成 true，其余字段不动" || echo "FAIL claude·false 补成 true，其余字段不动 :: $(tr "\n" " " < "$f")"
    printf '{ 这不是 json' > "$f"; sum=$(cksum < "$f")
    in_driver "$R" claude agent_trust_paths /repo/acme 2>/dev/null; rc=$?
    [ "$rc" != 0 ] && [ "$(cksum < "$f")" = "$sum" ] && [ "$(find "$H" -name '.claude.json.*' | wc -l)" = 0 ] \
        && echo "PASS claude·不是合法 JSON：失败、原文件不动、不留临时文件" || echo "FAIL claude·不是合法 JSON：失败、原文件不动、不留临时文件 :: rc=$rc"
    # 配置文件是软链（dotfiles）：写进链接指向的文件，链接本身保留
    rm -f "$f"; mkdir -p "$H/dotfiles"; echo '{"keep":1}' > "$H/dotfiles/claude.json"; ln -s "$H/dotfiles/claude.json" "$f"
    in_driver "$R" claude agent_trust_paths /repo/acme 2>/dev/null
    [ -L "$f" ] && [ "$(c_trusted "$H/dotfiles/claude.json" /repo/acme)" = true ] && [ "$(jq -r .keep "$H/dotfiles/claude.json")" = 1 ] \
        && echo "PASS claude·配置是软链：写进目标文件、链接保留" || echo "FAIL claude·配置是软链：写进目标文件、链接保留 :: $(ls -l "$f")"
    rm -f "$f"
    in_driver "$R" claude agent_trust_paths; rc=$?
    [ "$rc" = 0 ] && [ ! -e "$f" ] && echo "PASS claude·不给参数：不建文件" || echo "FAIL claude·不给参数：不建文件 :: rc=$rc"
}

# ═══ S3. codex 写入函数（TOML）═══
suite_codex_writer() {
    local R="$1" f ino sum rc orig
    new_home xw; f="$(ct)"
    in_driver "$R" codex agent_trust_paths /repo/acme 2>/dev/null; rc=$?
    [ "$rc" = 0 ] && [ "$(x_level "$f" /repo/acme)" = trusted ] && echo "PASS codex·文件不存在时建出来并信任" \
        || echo "FAIL codex·文件不存在时建出来并信任 :: rc=$rc $(tr "\n" " " < "$f" 2>/dev/null)"
    cat > "$f" <<'TOML'
# 用户自己的注释
model = "gpt-x"   # 行尾注释

[projects."/repo/old"]
trust_level = "trusted"

[projects."/repo/no"]
trust_level = "untrusted"
TOML
    orig="$(cat "$f")"
    in_driver "$R" codex agent_trust_paths '/repo/ai "hub"' "/工作区/项目" '/repo/no' 2>/dev/null
    case "$(cat "$f")" in
        "$orig"*) echo "PASS codex·原有内容（注释、排版）逐字节保留在前面" ;;
        *) echo "FAIL codex·原有内容（注释、排版）逐字节保留在前面 :: $(tr "\n" " " < "$f")" ;;
    esac
    [ "$(x_level "$f" '/repo/ai "hub"')$(x_level "$f" "/工作区/项目")" = trustedtrusted ] \
        && echo "PASS codex·带引号 / 中文的路径读回一致" || echo "FAIL codex·带引号 / 中文的路径读回一致 :: $(tr "\n" " " < "$f")"
    [ "$(x_level "$f" /repo/no)" = untrusted ] && echo "PASS codex·人设成不信任的条目不改" || echo "FAIL codex·人设成不信任的条目不改"
    ino=$(ls -i "$f" | awk '{print $1}'); sum=$(cksum < "$f")
    in_driver "$R" codex agent_trust_paths "/工作区/项目" 2>/dev/null; rc=$?
    [ "$rc" = 0 ] && [ "$(cksum < "$f")" = "$sum" ] && [ "$(ls -i "$f" | awk '{print $1}')" = "$ino" ] \
        && echo "PASS codex·已信任时一个字节都不写" || echo "FAIL codex·已信任时一个字节都不写 :: rc=$rc"
    printf 'projects = "不是表"\n' > "$f"; sum=$(cksum < "$f")
    in_driver "$R" codex agent_trust_paths /repo/acme 2>/dev/null; rc=$?
    [ "$rc" != 0 ] && [ "$(cksum < "$f")" = "$sum" ] && echo "PASS codex·projects 不是表：失败、原文件不动" \
        || echo "FAIL codex·projects 不是表：失败、原文件不动 :: rc=$rc"
    printf '[projects\n这不是 toml' > "$f"; sum=$(cksum < "$f")
    in_driver "$R" codex agent_trust_paths /repo/acme 2>/dev/null; rc=$?
    [ "$rc" != 0 ] && [ "$(cksum < "$f")" = "$sum" ] && [ "$(find "$H/.codex" -name 'config.toml.*' | wc -l)" = 0 ] \
        && echo "PASS codex·不是合法 TOML：失败、原文件不动、不留临时文件" || echo "FAIL codex·不是合法 TOML：失败、原文件不动、不留临时文件 :: rc=$rc"
}

# ═══ S4. 两个项目同时补记录：共享锁 ═══
# A 生成好新内容、正要替换时停住；B（另一个项目）此时进来。没有锁时 B 写完、A 再替换，
# B 那条被抹掉、两边都报成功。有锁时 B 必须等 A 放锁，再在锁里重读。
suite_race() {   # <skill 目录> <agent>
    local R="$1" agent="$2" f real P a b rca rcb waited=no
    new_home "race-$agent"
    if [ "$agent" = claude ]; then f="$(cj)"; echo '{"keep":"me","projects":{"/repo/old":{"hasTrustDialogAccepted":true}}}' > "$f"
    else f="$(ct)"; mkdir -p "$H/.codex"; printf '# keep me\n[projects."/repo/old"]\ntrust_level = "trusted"\n' > "$f"; fi
    real="$(real_of "$f")"; P="$TMP/pause-$agent"; rm -rf "$P"; mkdir -p "$P"
    MV_PAUSE_TARGET="$real" MV_PAUSE_DIR="$P" in_driver "$R" "$agent" agent_trust_dirs "$G/wt/proj-1" >/dev/null 2>&1 &
    a=$!
    for _ in $(seq 1 100); do [ -e "$P/paused" ] && break; sleep 0.05; done
    in_driver "$R" "$agent" agent_trust_dirs "$G/wt/sub-1" >/dev/null 2>&1 &
    b=$!
    sleep 1.5
    kill -0 "$b" 2>/dev/null && waited=yes
    : > "$P/release"
    wait "$a"; rca=$?; wait "$b"; rcb=$?
    [ -e "$P/paused" ] && echo "PASS race·$agent·A 确实停在替换前（交错发生了）" || echo "FAIL race·$agent·A 确实停在替换前（交错发生了） :: 没停住"
    [ "$waited" = yes ] && echo "PASS race·$agent·B 在 A 放锁前一直在等" || echo "FAIL race·$agent·B 在 A 放锁前一直在等 :: B 没等就跑完了"
    local ka kb kold
    if [ "$agent" = claude ]; then
        ka="$(c_trusted "$f" "$G/proj")"; kb="$(c_trusted "$f" "$G/super/.git/modules/sub")"; kold="$(c_trusted "$f" /repo/old)$(jq -r .keep "$f")"
        [ "$kold" = trueme ] || kold=bad
    else
        ka="$(x_level "$f" "$G/proj")"; kb="$(x_level "$f" "$G/wt/sub-1")"; kold="$(x_level "$f" /repo/old)"
        head -1 "$f" | grep -qx '# keep me' || kold=bad
    fi
    case "$ka$kb" in truetrue|trustedtrusted) echo "PASS race·$agent·两个项目的记录都在" ;;
        *) echo "FAIL race·$agent·两个项目的记录都在 :: A=$ka B=$kb" ;; esac
    [ "$kold" != bad ] && echo "PASS race·$agent·原有无关内容保留" || echo "FAIL race·$agent·原有无关内容保留 :: $(tr "\n" " " < "$f")"
    [ "$rca$rcb" = 00 ] && echo "PASS race·$agent·两边都返回成功" || echo "FAIL race·$agent·两边都返回成功 :: A=$rca B=$rcb"
}

# ═══ S5. 不认锁的写入者（活着的 claude / codex、人手工编辑）═══
suite_external() {   # <skill 目录> <agent>
    local R="$1" agent="$2" f err rc
    new_home "ext-$agent"
    if [ "$agent" = claude ]; then f="$(cj)"; echo '{}' > "$f"; else f="$(ct)"; mkdir -p "$H/.codex"; : > "$f"; fi
    # 第一次生成完新内容后，别人往文件里写了一笔 → 必须重读重来，别人那笔和自己那条都在
    err="$(in_driver "$R" "$agent" eval '
        trust_test_before_replace() {
            [ -e "$HOME/ext-done" ] && return 0; : > "$HOME/ext-done"
            if [ "$1" != "${1%.json}" ]; then jq ".external = 1" "$1" > "$1.x" && command cat "$1.x" > "$1"; rm -f "$1.x"
            else printf "\n[external]\nx = 1\n" >> "$1"; fi
        }
        agent_trust_dirs "'"$G/wt/proj-1"'" >/dev/null' 2>&1)"; rc=$?
    local ext mine
    if [ "$agent" = claude ]; then ext="$(jq -r .external "$f")"; mine="$(c_trusted "$f" "$G/proj")"
    else ext="$(python3 -c 'import sys,tomllib;print(tomllib.load(open(sys.argv[1],"rb")).get("external",{}).get("x"))' "$f")"; mine="$(x_level "$f" "$G/proj")"; fi
    case "$rc|$ext|$mine" in 0\|1\|true|0\|1\|trusted) echo "PASS ext·$agent·中途被改：重读重来，别人那笔和自己那条都在" ;;
        *) echo "FAIL ext·$agent·中途被改：重读重来，别人那笔和自己那条都在 :: rc=$rc external=$ext 自己=$mine" ;; esac
    case "$err" in *重读重来*) echo "PASS ext·$agent·日志写明重读" ;; *) echo "FAIL ext·$agent·日志写明重读 :: $err" ;; esac
    # 每次都被改：3 次后放弃，不覆盖别人的改动
    new_home "ext2-$agent"
    if [ "$agent" = claude ]; then f="$(cj)"; echo '{}' > "$f"; else f="$(ct)"; mkdir -p "$H/.codex"; : > "$f"; fi
    err="$(in_driver "$R" "$agent" eval '
        trust_test_before_replace() { printf "%s\n" x >> "$HOME/ext-count"; if [ "$1" != "${1%.json}" ]; then jq ".n = ((.n // 0) + 1)" "$1" > "$1.x" && command cat "$1.x" > "$1"; rm -f "$1.x"; else printf "# 改动\n" >> "$1"; fi; }
        agent_trust_dirs "'"$G/wt/proj-1"'" >/dev/null' 2>&1)"; rc=$?
    if [ "$agent" = claude ]; then mine="$(c_trusted "$f" "$G/proj")"; ext="$(jq -r .n "$f")"
    else mine="$(x_level "$f" "$G/proj")"; ext="$(grep -c '# 改动' "$f")"; fi
    case "$rc|$mine|$ext" in 0\|*) echo "FAIL ext·$agent·一直被改：放弃且不覆盖 :: 返回了成功" ;;
        *\|false\|3|*\|none\|3) echo "PASS ext·$agent·一直被改：放弃且不覆盖" ;;
        *) echo "FAIL ext·$agent·一直被改：放弃且不覆盖 :: rc=$rc 自己=$mine 别人改了 $ext 次" ;; esac
    case "$err" in *连续\ 3\ 次*) echo "PASS ext·$agent·日志写明放弃" ;; *) echo "FAIL ext·$agent·日志写明放弃 :: $err" ;; esac
}

# ═══ S6. 等锁超时：不写、不挂住 ═══
suite_timeout() {
    local R="$1" f real P a rc sum
    new_home tmo; f="$(cj)"; echo '{}' > "$f"; real="$(real_of "$f")"
    P="$TMP/pause-tmo"; rm -rf "$P"; mkdir -p "$P"
    MV_PAUSE_TARGET="$real" MV_PAUSE_DIR="$P" in_driver "$R" claude agent_trust_dirs "$G/wt/proj-1" >/dev/null 2>&1 &
    a=$!
    for _ in $(seq 1 100); do [ -e "$P/paused" ] && break; sleep 0.05; done
    sum=$(cksum < "$f")
    TRUST_LOCK_WAIT_SECS=1 in_driver "$R" claude agent_trust_dirs "$G/wt/sub-1" >/dev/null 2>&1; rc=$?
    [ "$rc" = 2 ] && [ "$(cksum < "$f")" = "$sum" ] && echo "PASS timeout·等不到锁：返回超时、文件不动" \
        || echo "FAIL timeout·等不到锁：返回超时、文件不动 :: rc=$rc"
    : > "$P/release"; wait "$a"
    [ "$(c_trusted "$f" "$G/proj")" = true ] && echo "PASS timeout·持锁的那个照常写完" || echo "FAIL timeout·持锁的那个照常写完"
}

# ═══ S7. 真派工脚本：每个起会话的入口 ═══
# 假 gh / 假 tmux；项目是真 git（普通仓库或子模块），worktree 由派工脚本自己建。
make_project() {   # <目录> normal|sub  → 打印 PROJECT_ROOT
    local d="$1" kind="$2"
    rm -rf "$d"; mkdir -p "$d"
    if [ "$kind" = normal ]; then gq clone -q "$G/up.git" "$d/p"; printf '%s\n' "$d/p"
    else
        gq init -q -b main "$d/super"; gq -C "$d/super" submodule add -q "$G/up.git" tool; gq -C "$d/super" commit -qm s
        printf '%s\n' "$d/super/tool"
    fi
}
write_config() {   # <文件> <PROJECT_ROOT> <worktree base> <state> <agent>
    cat > "$1" <<CONF
REPO="example/none"
PROJECT_ROOT="$2"
WORKTREE_BASE="$3"
STATE_DIR="$4"
TMUX_PREFIX="trusttest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
WORKER_AGENT="$5"
AGENT_TRUST_PROMPT_WAIT_SECS=1
AGENT_SESSION_CAPTURE_SECS=1
PATH="$FAKEBIN:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
}
# 跑一次派工。<skill 目录> <场景目录> <脚本> <参数…>；环境：H、FT、PANE、DIE
run_dispatch() {
    local R="$1" D="$2" script="$3"; shift 3
    (cd "$PROOT" && env -u CODING_AGENT_RELEASE_ROOT -u CLAUDE_JSON_PATH -u CODEX_HOME -u CAVIL_TRUST_LOCK_DIR -u WORKER_AGENT \
        HOME="$H" CODING_AGENT_CONFIG="$D/config" GH_LOG="$D/gh.log" FAKE_TMUX_DIR="$D/tmux" \
        FAKE_ITEM_LABELS_LIB="$TEST_DIR/lib/fake_item_labels.sh" FAKE_ITEM_DIR="$D/items" \
        FAKE_PANE_FILE="${PANE:-}" FAKE_TMUX_DIE_LAUNCHES="${DIE:-}" \
        bash "$R/scripts/$script" "$@") >/dev/null 2>&1
}
# 场景：<skill 目录> <名字> <normal|sub> <agent> <入口> <有无确认框 yes|no>
# 入口：new（新 issue）/ cmtB（issue 评论，worktree 在、会话没了）/ cmtR（同上但续接失败重建）/
#       prB（PR 评论，worktree 在）/ prC（PR 评论，worktree 没了，重建）
scenario() {
    local R="$1" name="$2" kind="$3" agent="$4" entry="$5" dialog="$6"
    local D="$TMP/disp/$name" N=4242 PROOT WT key snapf launches rc
    rm -rf "$D"; mkdir -p "$D/state" "$D/tmux"
    H="$D/home"; mkdir -p "$H"
    PROOT="$(make_project "$D/proj" "$kind")"
    write_config "$D/config" "$PROOT" "$D/wt" "$D/state" "$agent"
    WT="$D/wt/issue-$N"
    PANE="$D/pane"; DIE=""
    # 屏幕内容一律用真机截屏：yes = 信任确认框；no = 正常界面；prose = 正常界面里对话引用了整段确认框文字；
    # bypass = 项目带跳过权限确认的参数、屏幕停在 bypass 模式确认框；bpok = 同样的参数、屏幕正常（GitHub#744）
    case "$dialog" in
        yes)    cp "$FIX/$agent-trust.txt" "$PANE" ;;
        prose)  prose_screen "$agent" quote-full > "$PANE" ;;
        bypass) cp "$FIX/claude-bypass-modal.txt" "$PANE" ;;
        *)      cp "$FIX/$agent-normal.txt" "$PANE" ;;
    esac
    case "$dialog" in bypass|bpok) echo 'CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"' >> "$D/config" ;; esac
    case "$entry" in
        new)  run_dispatch "$R" "$D" dispatch-new-issue.sh "$N" ;;
        cmtB|cmtR|prB)
            gq -C "$PROOT" worktree add -q "$WT" -b "feature/issue-$N"
            if [ "$entry" = cmtR ]; then
                # 登记一条能续接的会话，并让第一次（续接）起的会话 2 秒内就死 → 走「降级为全新」
                mkdir -p "$D/state/agent-sessions" "$H/.claude/projects/$(printf %s "$WT" | tr -c 'A-Za-z0-9' '-')"
                echo 11111111-1111-1111-1111-111111111111 > "$D/state/agent-sessions/$N.claude.worker"
                : > "$H/.claude/projects/$(printf %s "$WT" | tr -c 'A-Za-z0-9' '-')/11111111-1111-1111-1111-111111111111.jsonl"
                DIE=1
            fi
            if [ "$entry" = prB ]; then run_dispatch "$R" "$D" dispatch-pr-comment.sh "$N" "feature/issue-$N" 0
            else run_dispatch "$R" "$D" dispatch-issue-comment.sh "$N" 0; fi ;;
        prC)
            gq -C "$G/seed" push -q origin "HEAD:refs/pull/$N/head"
            run_dispatch "$R" "$D" dispatch-pr-comment.sh "$N" "feature/issue-$N" 0 ;;
    esac
    rc=$?
    launches="$(cat "$D/tmux/launches" 2>/dev/null || echo 0)"
    # 期望的信任目录按实测规则手算（不调被测函数）
    if [ "$agent" = claude ]; then
        if [ "$kind" = normal ]; then key="$PROOT"; else key="$(dirname "$PROOT")/.git/modules/tool"; fi
    else
        if [ "$kind" = normal ]; then key="$PROOT"; else key="$WT"; fi
    fi
    [ "$launches" -ge 1 ] || { echo "FAIL disp·$name·起了会话 :: 一次 tmux new-session 都没有（rc=$rc）"; return; }
    [ "$entry" != cmtR ] || [ "$launches" = 2 ] || echo "FAIL disp·$name·续接失败后确实重建了 :: 起了 $launches 次"
    local i okall=yes
    for i in $(seq 1 "$launches"); do
        snapf="$D/tmux/snap.$i/claude.json"; [ "$agent" = codex ] && snapf="$D/tmux/snap.$i/config.toml"
        if [ "$agent" = claude ]; then [ "$(c_trusted "$snapf" "$key")" = true ] || okall=no
        else [ "$(x_level "$snapf" "$key")" = trusted ] || okall=no; fi
        [ "$(cat "$D/tmux/snap.$i/cwd")" = "$WT" ] || okall=no
    done
    [ "$okall" = yes ] && echo "PASS disp·$name·每次起会话那一刻已信任 $(basename "$key")" \
        || echo "FAIL disp·$name·每次起会话那一刻已信任 $(basename "$key") :: 快照里没有 $key"
    if [ "$dialog" = bypass ] || [ "$dialog" = bpok ]; then
        # 每次起会话的命令都在项目参数后面附了临时设置，设置文件那一刻已经写好、只含「已接受」那一项
        local sf okset=yes
        for i in $(seq 1 "$launches"); do
            sf="$(grep -o -- '--dangerously-skip-permissions --settings [^ ]*' "$D/tmux/snap.$i/cmd" | awk '{print $3}')"
            [ -n "$sf" ] && [ "$(jq -c . "$sf" 2>/dev/null)" = '{"skipDangerousModePermissionPrompt":true}' ] || okset=no
        done
        [ "$okset" = yes ] && echo "PASS disp·$name·每次起会话都附了「已接受 bypass 模式」的临时设置" \
            || echo "FAIL disp·$name·每次起会话都附了「已接受 bypass 模式」的临时设置 :: $(cat "$D/tmux/snap.1/cmd" 2>/dev/null)"
        [ ! -e "$H/.claude/settings.json" ] && echo "PASS disp·$name·账号的设置文件没被写" \
            || echo "FAIL disp·$name·账号的设置文件没被写 :: $(cat "$H/.claude/settings.json")"
    fi
    if [ "$dialog" = bypass ]; then
        if grep -q "issues/$N/labels.*labels\[\]=pending/human" "$D/gh.log" && grep -q "Bypass Permissions mode" "$D/gh.log" \
           && grep -q "trusttest-issue$N" "$D/tmux/killed" 2>/dev/null && [ "$(sort "$D/items/$N" 2>/dev/null | tr '\n' ,)" = "pending/human," ]; then
            echo "PASS disp·$name·卡在 bypass 框：杀会话、留言说的是 bypass 模式、转 pending/human"
        else
            echo "FAIL disp·$name·卡在 bypass 框：杀会话、留言说的是 bypass 模式、转 pending/human :: killed=$(tr "\n" " " < "$D/tmux/killed" 2>/dev/null)；标签=$(tr '\n' , < "$D/items/$N" 2>/dev/null)"
        fi
        grep -q "bypass 模式（跳过权限确认）确认框" "$D/state/poll.log" 2>/dev/null && ! grep -q "目录信任确认框" "$D/state/poll.log" \
            && echo "PASS disp·$name·poll.log 写明是 bypass 框、不说成目录信任" \
            || echo "FAIL disp·$name·poll.log 写明是 bypass 框、不说成目录信任 :: $(grep '确认框' "$D/state/poll.log" | tail -2 | tr '\n' '|')"
        [ ! -e "$D/state/selfheal/$N.launch" ] && echo "PASS disp·$name·没起成：不记本次启动" \
            || echo "FAIL disp·$name·没起成：不记本次启动 :: $(cat "$D/state/selfheal/$N.launch")"
    elif [ "$dialog" = yes ]; then
        local num_lbl="issues/$N/labels"
        # 起会话之前已经认领（GitHub#700），转人工时摘掉 doing/agent：最后只剩 pending/human
        if grep -q "$num_lbl.*labels\[\]=pending/human" "$D/gh.log" && grep -q "issues/$N/comments" "$D/gh.log" \
           && grep -q "trusttest-issue$N" "$D/tmux/killed" 2>/dev/null && [ "$(sort "$D/items/$N" 2>/dev/null | tr '\n' ,)" = "pending/human," ]; then
            echo "PASS disp·$name·卡在确认框：杀会话、留言、转 pending/human、doing/agent 已摘"
        else
            echo "FAIL disp·$name·卡在确认框：杀会话、留言、转 pending/human、doing/agent 已摘 :: $(grep -c . "$D/gh.log" 2>/dev/null) 次 gh 调用；killed=$(tr "\n" " " < "$D/tmux/killed" 2>/dev/null)；标签=$(tr '\n' , < "$D/items/$N" 2>/dev/null)"
        fi
        grep -q "目录信任确认框" "$D/state/poll.log" 2>/dev/null && echo "PASS disp·$name·poll.log 写明哪个 agent、哪个目录" \
            || echo "FAIL disp·$name·poll.log 写明哪个 agent、哪个目录 :: 日志里没有"
    else
        grep -q "labels\[\]=doing/agent" "$D/gh.log" && ! grep -q "labels\[\]=pending/human" "$D/gh.log" \
            && echo "PASS disp·$name·没有确认框：照常翻 doing/agent" \
            || { local calls; calls="$(tr '\n' '|' < "$D/gh.log" 2>/dev/null)"; echo "FAIL disp·$name·没有确认框：照常翻 doing/agent :: ${calls:0:300}"; }
        if [ "$agent" = claude ]; then
            # 起成了：记下本次启动的会话 id 和提示词里最后那个一次性标记（self-heal 凭它判「开工了没有」）
            local rec ptag pfile
            rec="$(jq -r '[.id, .tag] | join(" ")' "$D/state/selfheal/$N.launch" 2>/dev/null)"
            pfile="$(grep -o '"$(cat [^)]*)"' "$D/tmux/snap.$launches/cmd" | sed 's/^"$(cat //; s/)"$//')"
            ptag="$(grep -o 'coding-agent-launch: [0-9a-f-]*' "$pfile" 2>/dev/null | tail -1 | awk '{print $2}')"
            [ -n "$ptag" ] && [ "${rec#* }" = "$ptag" ] && [ -n "${rec%% *}" ] \
                && echo "PASS disp·$name·记下了本次启动（会话 id + 提示词里的标记）" \
                || echo "FAIL disp·$name·记下了本次启动（会话 id + 提示词里的标记） :: 记录=[$rec] 提示词标记=[$ptag]"
        fi
    fi
}
suite_dispatch() {   # <skill 目录> [只跑这些场景名的子串]
    local R="$1" only="${2:-}" line
    while read -r line; do
        [ -n "$line" ] || continue
        # shellcheck disable=SC2086
        set -- $line
        [ -z "$only" ] || case "$1" in *"$only"*) ;; *) continue ;; esac
        scenario "$R" "$@"
    done <<'EOF'
new-claude-normal normal claude new no
new-claude-sub sub claude new no
new-codex-sub sub codex new no
new-codex-normal normal codex new no
cmtB-claude-sub sub claude cmtB no
cmtR-claude-sub sub claude cmtR no
prB-codex-sub sub codex prB no
prC-codex-sub sub codex prC no
dlg-new-claude sub claude new yes
dlg-cmtB-codex sub codex cmtB yes
dlg-cmtR-claude sub claude cmtR yes
dlg-prB-codex sub codex prB yes
dlg-prC-claude normal claude prC yes
prose-new-claude normal claude new prose
prose-prB-codex sub codex prB prose
bp-new-claude normal claude new bypass
bp-cmtR-claude sub claude cmtR bypass
bpok-new-claude normal claude new bpok
bpok-cmtR-claude sub claude cmtR bpok
bpok-prC-claude normal claude prC bpok
EOF
}

# ═══ S8. 真跑 setup.sh：部署时的那一条，以及它和派工交错写同一份配置 ═══
make_skill_src() {   # <源目录> <目标>：做成可发布的 skill 仓库（setup.sh 会从 git 部署）
    local s="$1" d="$2"
    rm -rf "$d" "$d.git"; git init -q --bare "$d.git"; git init -q -b main "$d"
    (cd "$s" && git ls-files -co --exclude-standard -z 2>/dev/null || find . -type f -print0) \
        | (cd "$s" && xargs -0 -I{} cp --parents -P {} "$d/" 2>/dev/null)
    gq -C "$d" add -A; gq -C "$d" commit -qm snapshot
    gq -C "$d" remote add origin "$d.git"; gq -C "$d" push -q -u origin main
}
run_setup() {   # <skill 源> <HOST> [环境…]
    local src="$1" host="$2"; shift 2
    { cat "$REPO_DIR/cavil-loop.config.example"
      printf 'REPO="acme/widget"\nPROJECT_ROOT="%s"\nSTATE_DIR="%s/state"\nWORKTREE_BASE="%s/wt"\nTMUX_PREFIX="widget"\nREVIEW_WORKER_AGENT="codex"\n' "$host" "$H" "$H"
    } > "$host/cavil-loop.config"
    printf 'n\n' | env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CAVIL_DEPLOY_CONF -u CODING_AGENT_CONFIG \
        -u CODING_AGENT_RELEASE_ROOT -u WORKER_AGENT -u CLAUDE_JSON_PATH -u CODEX_HOME -u CAVIL_TRUST_LOCK_DIR \
        HOME="$H" PATH="$FAKEBIN:$PATH" GH_LOG="$H/gh.log" "$@" bash "$src/setup.sh" "$host" > "$H/setup.out" 2>&1
}
suite_setup() {   # <skill 目录>
    local R="$1" S="$TMP/setup" host key_c real P a rc
    mkdir -p "$S"; make_skill_src "$R" "$S/src"
    new_home setup
    rm -rf "$S/proj"; mkdir -p "$S/proj"
    gq init -q -b main "$S/proj/super"; gq -C "$S/proj/super" submodule add -q "$G/up.git" tool; gq -C "$S/proj/super" commit -qm s
    host="$S/proj/super/tool"
    run_setup "$S/src" "$host"; rc=$?
    key_c="$S/proj/super/.git/modules/tool"
    [ "$(c_trusted "$(cj)" "$key_c")" = true ] && echo "PASS setup·子模块项目：claude 记在 .git/modules/<名字>" \
        || echo "FAIL setup·子模块项目：claude 记在 .git/modules/<名字> :: rc=$rc；$(grep -A3 '1b\.' "$H/setup.out" | tr '\n' '|')"
    [ "$(x_level "$(ct)" "$host")" = trusted ] && echo "PASS setup·子模块项目：交叉复审用的 codex 也写了仓库那条" \
        || echo "FAIL setup·子模块项目：交叉复审用的 codex 也写了仓库那条 :: $(grep -A4 '1b\.' "$H/setup.out" | tr '\n' '|')"
    if jq -e --arg p "$H/wt" '.projects | has($p)' "$(cj)" >/dev/null 2>&1; then
        echo "FAIL setup·不再写没用的「worktree base」那条 :: 还写着 $H/wt"
    else echo "PASS setup·不再写没用的「worktree base」那条"; fi

    # 部署 × 派工交错：setup 正要替换 ~/.claude.json 时停住，另一个项目的真派工进来
    new_home setup-race
    echo '{"keep":1}' > "$(cj)"; real="$(real_of "$(cj)")"
    P="$TMP/pause-setup"; rm -rf "$P"; mkdir -p "$P"
    rm -rf "$S/proj2"; mkdir -p "$S/proj2"; gq clone -q "$G/up.git" "$S/proj2/p"
    run_setup "$S/src" "$S/proj2/p" MV_PAUSE_TARGET="$real" MV_PAUSE_DIR="$P" &
    a=$!
    for _ in $(seq 1 200); do [ -e "$P/paused" ] && break; sleep 0.05; done
    local D="$TMP/disp/setup-race" N=5151 b waited=no
    rm -rf "$D"; mkdir -p "$D/state" "$D/tmux"
    PROOT="$(make_project "$D/proj" sub)"; PANE=""; DIE=""
    write_config "$D/config" "$PROOT" "$D/wt" "$D/state" claude
    run_dispatch "$R" "$D" dispatch-new-issue.sh "$N" &
    b=$!
    sleep 2
    kill -0 "$b" 2>/dev/null && waited=yes
    : > "$P/release"
    wait "$a"; wait "$b"
    [ -e "$P/paused" ] && echo "PASS setup×派工·setup 确实停在替换前" || echo "FAIL setup×派工·setup 确实停在替换前 :: 没停住（$(tail -3 "$H/setup.out" | tr '\n' '|')）"
    [ "$waited" = yes ] && echo "PASS setup×派工·派工在 setup 放锁前一直在等" || echo "FAIL setup×派工·派工在 setup 放锁前一直在等 :: 没等"
    if [ "$(c_trusted "$(cj)" "$S/proj2/p")" = true ] \
       && [ "$(c_trusted "$(cj)" "$(dirname "$PROOT")/.git/modules/tool")" = true ] \
       && [ "$(jq -r .keep "$(cj)")" = 1 ]; then
        echo "PASS setup×派工·两边的记录和原有内容都在"
    else echo "FAIL setup×派工·两边的记录和原有内容都在 :: $(jq -c . "$(cj)" 2>/dev/null)"; fi
}

# ═══ S9. 认框：真机截屏，看结构不看单个词 ═══
suite_detect() {   # <skill 目录>
    local R="$1" agent f got want name
    new_home detect
    for agent in claude codex; do
        while IFS='|' read -r name want; do
            [ -n "$name" ] || continue
            case "$name" in
                prose-*) prose_screen "$agent" "${name#prose-}" > "$TMP/screen"
                         # 可达性：对话那段确实插进去了，而且标题原文就在屏幕上
                         if [ "$(grep -c 'Working normally\|这就是信任确认框' "$TMP/screen")" = 1 ] \
                            && tr -s '[:space:]' ' ' < "$TMP/screen" | grep -qF "$( [ "$agent" = claude ] && echo 'Quick safety check: Is this a project you created or one you trust?' || echo 'Trust this folder?')"; then
                             echo "PASS detect·$agent·$name·夹具里确有那段对话和标题原文"
                         else echo "FAIL detect·$agent·$name·夹具里确有那段对话和标题原文 :: 没插进去"; fi ;;
                other-trust) cp "$FIX/$([ "$agent" = claude ] && echo codex || echo claude)-trust.txt" "$TMP/screen" ;;
                modal) cp "$FIX/$([ "$agent" = claude ] && echo claude-bypass-modal || echo codex-update-modal).txt" "$TMP/screen" ;;
                *) cp "$FIX/$agent-$name.txt" "$TMP/screen" ;;
            esac
            if in_driver "$R" "$agent" agent_trust_prompt_on_screen < "$TMP/screen"; then got=yes; else got=no; fi
            if [ "$got" = "$want" ]; then echo "PASS detect·$agent·$name → $want"
            else echo "FAIL detect·$agent·$name → $want :: 实得 $got"; fi
        done <<'EOF'
trust|yes
normal|no
modal|no
other-trust|no
prose-one-phrase|no
prose-quote-full|no
EOF
    done
}

# ═══ S10. 配置是软链、python 不可用 / 链接解析不了 ═══
suite_symlink() {   # <skill 目录>
    local R="$1" f rc err bin T
    # (a) python3 存在但一调就失败；(b) PATH 里根本没有 python3
    for how in broken missing; do
        new_home "sym-$how"; f="$(cj)"
        mkdir -p "$H/dotfiles"; printf '{"keep":1}' > "$H/dotfiles/claude.json"; ln -s dotfiles/claude.json "$f"
        bin="$TMP/bin-$how"; rm -rf "$bin"; mkdir -p "$bin"
        for T in bash dirname basename mkdir cksum cut flock mktemp stat chmod cat jq mv rm readlink tr grep sed tail head ls env git cp; do
            ln -s "$(command -v "$T")" "$bin/$T" 2>/dev/null
        done
        [ "$how" = broken ] && printf '#!/bin/sh\nexit 1\n' > "$bin/python3" && chmod +x "$bin/python3"
        err="$(env PATH="$bin" HOME="$H" "$(command -v bash)" -c 'source "$1/scripts/drivers/_common.sh" && PROJECT_ROOT=/nonexistent source_driver claude >/dev/null 2>&1 || exit 99; agent_trust_paths /repo/test' _ "$R" 2>&1)"; rc=$?
        if [ "$rc" = 0 ] && [ -L "$f" ] && [ "$(c_trusted "$H/dotfiles/claude.json" /repo/test)" = true ] \
           && [ "$(jq -r .keep "$H/dotfiles/claude.json")" = 1 ]; then
            echo "PASS symlink·python $how：链接保留、记录写进目标文件"
        else
            echo "FAIL symlink·python $how：链接保留、记录写进目标文件 :: rc=$rc 链接=$([ -L "$f" ] && echo 在 || echo 被换掉) 目标=$(tr "\n" " " < "$H/dotfiles/claude.json") $err"
        fi
    done
    # (c) 链接成环：解析不了 → 拒绝写入、链接原样、不报成功
    new_home sym-loop; f="$(cj)"
    ln -s loop-b "$H/loop-a"; ln -s loop-a "$H/loop-b"; ln -s loop-a "$f"
    err="$(in_driver "$R" claude agent_trust_paths /repo/test 2>&1)"; rc=$?
    if [ "$rc" != 0 ] && [ -L "$f" ] && [ -L "$H/loop-a" ] && [ -L "$H/loop-b" ] && [ "$(readlink "$f")" = loop-a ]; then
        case "$err" in *已写入*) echo "FAIL symlink·链接成环：拒绝写入、链接原样 :: 日志说已写入" ;;
            *) echo "PASS symlink·链接成环：拒绝写入、链接原样" ;; esac
    else echo "FAIL symlink·链接成环：拒绝写入、链接原样 :: rc=$rc $(ls -l "$H" | tr '\n' '|')"; fi
}

# ═══ S11. 真实路径：拿内核的真实打开结果对拍 ═══
# 每个场景在两份一模一样的布局里各跑一次：一份给被测函数解析，一份让内核以「写、不存在就建」
# 打开（python os.open O_WRONLY|O_CREAT），看它实际落到哪个文件（按 inode 找回相对路径）。
# 内核报错的，被测函数必须拒绝。字符串化简（非严格 realpath）不当参照：它会把内核打不开的路径化简成能写的路径。
rp_layout() {   # <目录>：建出全部场景用到的布局（链接一律相对或指向本目录内）
    local L="$1"
    mkdir -p "$L/versions/v1" "$L/links" "$L/a/b/c" "$L/abs" "$L/plain" "$L/adir"
    printf '{"keep":"actual-target"}' > "$L/versions/claude.json"
    printf '{"keep":"unrelated-file"}' > "$L/links/claude.json"
    printf 'regular file' > "$L/not-a-dir"
    printf '{"keep":"unrelated"}' > "$L/real.json"
    echo '{}' > "$L/a/b/c/real.json"
    ln -s ../versions/v1 "$L/links/current"
    ln -s links/current/../claude.json "$L/dirlink-dotdot.json"   # 第 2 轮：目录链接后接 ..
    ln -s not-a-dir/../real.json "$L/notdir-dotdot.json"          # 第 3 轮：普通文件当目录再 ..
    ln -s not-a-dir/x.json "$L/notdir-child.json"                 # 普通文件当目录往下走
    ln -s real.json/ "$L/file-slash.json"                         # 文件后面带 /
    ln -s real.json "$L/filelink"; ln -s filelink/../real.json "$L/filelink-dotdot.json"  # 指向文件的链接当目录
    ln -s adir "$L/dir-target.json"                               # 目标是目录
    ln -s nodir/../real.json "$L/missing-dotdot.json"             # 不存在的目录后接 ..
    ln -s b/c "$L/a/bc"; ln -s ../a/bc/real.json "$L/plain/rel.json"
    ln -s rel.json "$L/plain/chain.json"
    ln -s "$L/a/b/c/real.json" "$L/abs/abs.json"
    ln -s ../a/bc "$L/plain/deep"
    ln -s missing.json "$L/plain/dangling.json"
    ln -s newdir/x/cfg.json "$L/plain/newdir.json"                # 待建目录（首次写，内核会 ENOENT，我们有意建出来）
    ln -s loop2 "$L/loop1"; ln -s loop1 "$L/loop2"
    # 末级后缀矩阵（复审第 2 轮）：目标存在 / 不存在 × 无后缀 / 「/」/ 「/.」× 直接路径 / 经链接
    local suf tag
    for suf in "" "/" "/."; do
        case "$suf" in '') tag=plain ;; /) tag=slash ;; *) tag=slashdot ;; esac
        ln -s "real.json$suf" "$L/sfx-link-exist-$tag.json"
        ln -s "nope-$tag.json$suf" "$L/sfx-link-missing-$tag.json"
    done
}
kernel_open() {   # <布局目录> <相对路径> → 打印内核实际写到的文件（相对布局目录）；打不开打印 ERR:<errno 名>
    python3 -I -c '
import os, sys, errno
base, rel = sys.argv[1], sys.argv[2]
try:
    fd = os.open(os.path.join(base, rel), os.O_WRONLY | os.O_CREAT, 0o600)
except OSError as e:
    print("ERR:" + errno.errorcode.get(e.errno, str(e.errno))); sys.exit()
st = os.fstat(fd)
for root, dirs, files in os.walk(base):
    for f in files:
        p = os.path.join(root, f)
        s = os.lstat(p)
        if (s.st_dev, s.st_ino) == (st.st_dev, st.st_ino):
            print(os.path.relpath(p, base)); sys.exit()
print("ERR:notfound")' "$1" "$2"
}
suite_realpath() {   # <skill 目录>
    local R="$1" name rel expect k got A B rc
    new_home rp
    while IFS='|' read -r name rel expect; do
        [ -n "$name" ] || continue
        A="$TMP/rp-ours"; B="$TMP/rp-kernel"; rm -rf "$A" "$B"; mkdir -p "$A" "$B"
        rp_layout "$A"; rp_layout "$B"
        k="$(kernel_open "$B" "$rel")"
        got="$(in_driver "$R" claude trust_real_file "$A/$rel" 2>/dev/null)" && got="${got#"$A"/}" || got="REFUSED"
        if [ "$expect" = kernel ]; then
            case "$k" in ERR:*) want=REFUSED ;; *) want="$k" ;; esac
            if [ "$got" = "$want" ]; then echo "PASS realpath·$name（内核：$k）"
            else echo "FAIL realpath·$name（内核：$k） :: 期望 $want，实得 $got"; fi
        else
            # 有意比内核宽的那一处：内核 ENOENT，我们建出待建目录
            if [ "$k" = ERR:ENOENT ] && [ "$got" = "$expect" ] && [ -d "$A/${expect%/*}" ]; then
                echo "PASS realpath·$name（内核 ENOENT；首次写入，建出目录）"
            else echo "FAIL realpath·$name :: 内核 $k，期望 $expect，实得 $got"; fi
        fi
    done <<'EOF'
目录链接后接 ..|dirlink-dotdot.json|kernel
普通文件当目录再 ..|notdir-dotdot.json|kernel
普通文件当目录往下走|notdir-child.json|kernel
文件后面带 /|file-slash.json|kernel
指向文件的链接当目录再 ..|filelink-dotdot.json|kernel
目标是目录|dir-target.json|kernel
不存在的目录后接 ..|missing-dotdot.json|kernel
相对链接 + 中间目录链接|plain/rel.json|kernel
链接接链接|plain/chain.json|kernel
绝对目标|abs/abs.json|kernel
多层 ..|plain/deep/../../versions/claude.json|kernel
多余的 . 和 //|plain//./chain.json|kernel
指向不存在的文件|plain/dangling.json|kernel
普通文件|versions/claude.json|kernel
链接成环|loop1|kernel
链接指进不存在的目录|plain/newdir.json|kernel
没经过链接、目录还没建（首次写配置）|fresh/sub/config.toml|fresh/sub/config.toml
后缀·直接·目标存在·无后缀|real.json|kernel
后缀·直接·目标存在·/|real.json/|kernel
后缀·直接·目标存在·/.|real.json/.|kernel
后缀·直接·目标不存在·无后缀|new-config.json|kernel
后缀·直接·目标不存在·/|new-config.json/|kernel
后缀·直接·目标不存在·/.|new-config.json/.|kernel
后缀·直接·目录不存在·/.|fresh2/./config.toml|kernel
后缀·链接·目标存在·无后缀|sfx-link-exist-plain.json|kernel
后缀·链接·目标存在·/|sfx-link-exist-slash.json|kernel
后缀·链接·目标存在·/.|sfx-link-exist-slashdot.json|kernel
后缀·链接·目标不存在·无后缀|sfx-link-missing-plain.json|kernel
后缀·链接·目标不存在·/|sfx-link-missing-slash.json|kernel
后缀·链接·目标不存在·/.|sfx-link-missing-slashdot.json|kernel
EOF
    A="$TMP/rp-ours"; rm -rf "$A"; mkdir -p "$A"; rp_layout "$A"
    got="$(cd "$A/plain" && in_driver "$R" claude trust_real_file chain.json 2>/dev/null)"
    [ "$got" = "$A/a/b/c/real.json" ] && echo "PASS realpath·相对路径输入" || echo "FAIL realpath·相对路径输入 :: $got"
    # 真实写入：合法布局写进真正目标；非法布局一个字节都不动、不报成功
    local before snap err
    before="$(cksum < "$A/links/claude.json")"
    rc=0; in_driver "$R" claude eval "CLAUDE_JSON_PATH='$A/dirlink-dotdot.json' agent_trust_paths /repo/test" >/dev/null 2>&1 || rc=$?
    if [ "$rc" = 0 ] && [ "$(c_trusted "$A/versions/claude.json" /repo/test)" = true ] \
       && [ "$(jq -r .keep "$A/versions/claude.json")" = actual-target ] \
       && [ "$(cksum < "$A/links/claude.json")" = "$before" ] && [ -L "$A/dirlink-dotdot.json" ]; then
        echo "PASS realpath·目录链接后接 ..：写进真正目标、无关文件不变、链接保留"
    else echo "FAIL realpath·目录链接后接 ..：写进真正目标、无关文件不变、链接保留 :: rc=$rc"; fi
    for name in notdir-dotdot.json notdir-child.json file-slash.json filelink-dotdot.json dir-target.json missing-dotdot.json loop1 \
                new-config.json/ new-config.json/. real.json/. sfx-link-missing-slash.json sfx-link-missing-slashdot.json sfx-link-exist-slashdot.json; do
        snap="$(cd "$A" && find . -path ./home -prune -o -print0 | sort -z | xargs -0 -I{} sh -c 'if [ -L "{}" ]; then echo "L {} $(readlink "{}")"; elif [ -f "{}" ]; then echo "F {} $(cksum < "{}")"; else echo "D {}"; fi')"
        rc=0; err="$(in_driver "$R" claude eval "CLAUDE_JSON_PATH='$A/$name' agent_trust_paths /repo/test" 2>&1)" || rc=$?
        if [ "$rc" != 0 ] && [ "$snap" = "$(cd "$A" && find . -path ./home -prune -o -print0 | sort -z | xargs -0 -I{} sh -c 'if [ -L "{}" ]; then echo "L {} $(readlink "{}")"; elif [ -f "{}" ]; then echo "F {} $(cksum < "{}")"; else echo "D {}"; fi')" ]; then
            case "$err" in *已写入*) echo "FAIL realpath·非法配置 $name：拒绝写入、所有文件和链接原样 :: 日志说已写入" ;;
                *) echo "PASS realpath·非法配置 $name：拒绝写入、所有文件和链接原样" ;; esac
        else echo "FAIL realpath·非法配置 $name：拒绝写入、所有文件和链接原样 :: rc=$rc"; fi
    done
    # 成功对照：目标不存在、无后缀 → 首次创建配置，直接路径和经链接各一次
    rc=0; in_driver "$R" claude eval "CLAUDE_JSON_PATH='$A/first-config.json' agent_trust_paths /repo/first" >/dev/null 2>&1 || rc=$?
    [ "$rc" = 0 ] && [ -f "$A/first-config.json" ] && [ "$(c_trusted "$A/first-config.json" /repo/first)" = true ] \
        && echo "PASS realpath·首次创建配置（直接路径）" || echo "FAIL realpath·首次创建配置（直接路径） :: rc=$rc"
    rc=0; in_driver "$R" claude eval "CLAUDE_JSON_PATH='$A/sfx-link-missing-plain.json' agent_trust_paths /repo/first" >/dev/null 2>&1 || rc=$?
    [ "$rc" = 0 ] && [ -L "$A/sfx-link-missing-plain.json" ] && [ "$(c_trusted "$A/nope-plain.json" /repo/first)" = true ] \
        && echo "PASS realpath·首次创建配置（经链接，链接保留）" || echo "FAIL realpath·首次创建配置（经链接，链接保留） :: rc=$rc"
    # 同一个真实文件的两个别名：A 从别名一进来停在替换前，B 从别名二进来必须等同一把锁
    local P="$TMP/pause-alias" a b waited=no
    rm -rf "$P"; mkdir -p "$P"; echo '{}' > "$A/a/b/c/real.json"
    MV_PAUSE_TARGET="$A/a/b/c/real.json" MV_PAUSE_DIR="$P" \
        in_driver "$R" claude eval "CLAUDE_JSON_PATH='$A/plain/chain.json' agent_trust_paths /repo/alias-a" >/dev/null 2>&1 &
    a=$!
    for _ in $(seq 1 100); do [ -e "$P/paused" ] && break; sleep 0.05; done
    in_driver "$R" claude eval "CLAUDE_JSON_PATH='$A/abs/abs.json' agent_trust_paths /repo/alias-b" >/dev/null 2>&1 &
    b=$!
    sleep 1.5; kill -0 "$b" 2>/dev/null && waited=yes
    : > "$P/release"; wait "$a"; wait "$b"
    if [ -e "$P/paused" ] && [ "$waited" = yes ] \
       && [ "$(c_trusted "$A/a/b/c/real.json" /repo/alias-a)$(c_trusted "$A/a/b/c/real.json" /repo/alias-b)" = truetrue ]; then
        echo "PASS realpath·两个别名共用一把锁，两条记录都在"
    else echo "FAIL realpath·两个别名共用一把锁，两条记录都在 :: 停住=$([ -e "$P/paused" ] && echo 是 || echo 否) 等了=$waited"; fi
    # 等锁期间链接被改指别处：持锁后重新解析发现不一致 → 不写，两边文件都不动
    printf '{"keep":"first"}' > "$A/a/b/c/real.json"; before="$(cksum < "$A/a/b/c/real.json")"
    local before2; before2="$(cksum < "$A/versions/claude.json")"
    rc=0; err="$(in_driver "$R" claude eval "
        trust_test_after_lock() { ln -sfn ../versions/claude.json '$A/plain/swap.json'; }
        ln -sfn ../a/b/c/real.json '$A/plain/swap.json'
        CLAUDE_JSON_PATH='$A/plain/swap.json' agent_trust_paths /repo/swap" 2>&1)" || rc=$?
    if [ "$rc" != 0 ] && [ "$(cksum < "$A/a/b/c/real.json")" = "$before" ] && [ "$(cksum < "$A/versions/claude.json")" = "$before2" ]; then
        echo "PASS realpath·等锁期间链接改指：持锁后重新解析，不一致就不写"
    else echo "FAIL realpath·等锁期间链接改指：持锁后重新解析，不一致就不写 :: rc=$rc"; fi
}

echo "== 0c. 真实路径：逐分量解析 =="
run_suite suite_realpath "$REPO_DIR"
echo "== 0a. 认框：真机截屏 =="
run_suite suite_detect "$REPO_DIR"
echo "== 0b. 配置软链接：不靠 python 解析，解析不了就不写 =="
run_suite suite_symlink "$REPO_DIR"
echo "== 1. 信任记到哪个目录（真实 git 布局）=="
run_suite suite_keys "$REPO_DIR"
echo "== 2. claude 写入函数 =="
run_suite suite_claude_writer "$REPO_DIR"
echo "== 3. codex 写入函数 =="
run_suite suite_codex_writer "$REPO_DIR"
echo "== 4. 两个项目同时补记录（受控交错）=="
run_suite suite_race "$REPO_DIR" claude
run_suite suite_race "$REPO_DIR" codex
echo "== 5. 不认锁的写入者 =="
run_suite suite_external "$REPO_DIR" claude
run_suite suite_external "$REPO_DIR" codex
echo "== 6. 等锁超时 =="
run_suite suite_timeout "$REPO_DIR"
echo "== 7. 真派工脚本：每个起会话的入口 =="
run_suite suite_dispatch "$REPO_DIR"
echo "== 8. 真跑 setup.sh =="
run_suite suite_setup "$REPO_DIR"

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
