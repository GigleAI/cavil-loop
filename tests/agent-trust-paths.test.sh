#!/usr/bin/env bash
# 目录信任（GitHub#108）：派工 / 部署前给 agent 预写 folder-trust 记录，起会话后认出确认框。
#
# 跑法：bash tests/agent-trust-paths.test.sh            （默认回归，约 1 分钟）
#       MUTATION=1 bash tests/agent-trust-paths.test.sh （另跑负对照：改坏一处，对应检查必须变红）
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

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

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
        esac
    done
}
run_suite() { report < <("$@"); }

# 负对照：<说明> <要求变红的检查名（子串）> <suite 及参数…>
neg_fails=0
neg() {
    local desc="$1" want="$2"; shift 2
    local out
    out="$("$@" 2>/dev/null)"
    if printf '%s\n' "$out" | grep -q "^FAIL [^:]*$want"; then
        ok "负对照·$desc → 「$want」变红"
    else
        bad "负对照·$desc → 「$want」没变红（测试分不出对错实现）"
        neg_fails=$((neg_fails+1))
    fi
}
# 做一份改坏的副本：<名字> <相对路径> <old> <new>；原文找不到 → 准备失败，算红
mutant() {
    local name="$1" rel="$2" old="$3" new="$4" d="$TMP/mut/$1"
    rm -rf "$d"; mkdir -p "$d"
    (cd "$REPO_DIR" && git ls-files -co --exclude-standard -z) \
        | (cd "$REPO_DIR" && xargs -0 -I{} cp --parents -P {} "$d/" 2>/dev/null)
    if ! python3 - "$d/$rel" "$old" "$new" <<'PY'
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if s.count(old) != 1:
    sys.exit(1)
open(p, "w").write(s.replace(old, new))
PY
    then
        bad "负对照准备失败：$name（$rel 里找不到要改的原文）"
        return 1
    fi
    printf '%s\n' "$d"
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
FT="${FAKE_TMUX_DIR:?}"; mkdir -p "$FT"
echo "$*" >> "$FT/calls"
tgt() { local a; while [ $# -gt 0 ]; do [ "$1" = -t ] && { a="$2"; a="${a#=}"; printf '%s' "${a%%:*}"; return; }; shift; done; }
case "$1" in
    new-session)
        shift; name=""; dir=""
        while [ $# -gt 0 ]; do
            case "$1" in -s) name="$2"; shift 2 ;; -c) dir="$2"; shift 2 ;; -e) shift 2 ;; -d) shift ;; *) break ;; esac
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
    else echo "FAIL claude·别的字段和别的项目原样保留 :: $(cat "$f")"; fi
    [ "$(c_trusted "$f" "/repo/ai hub")$(c_trusted "$f" "/工作区/项目")" = truetrue ] \
        && echo "PASS claude·带空格 / 中文的路径" || echo "FAIL claude·带空格 / 中文的路径 :: $(cat "$f")"
    [ "$(stat -c %a "$f")" = 640 ] && echo "PASS claude·替换后保留原文件权限" || echo "FAIL claude·替换后保留原文件权限 :: $(stat -c %a "$f")"
    ino=$(ls -i "$f" | awk '{print $1}'); sum=$(cksum < "$f")
    in_driver "$R" claude agent_trust_paths "/repo/ai hub" 2>/dev/null; rc=$?
    [ "$rc" = 0 ] && [ "$(cksum < "$f")" = "$sum" ] && [ "$(ls -i "$f" | awk '{print $1}')" = "$ino" ] \
        && echo "PASS claude·已信任时一个字节都不写" || echo "FAIL claude·已信任时一个字节都不写 :: rc=$rc"
    echo '{"projects":{"/repo/acme":{"hasTrustDialogAccepted":false,"allowedTools":["Edit"]}}}' > "$f"
    in_driver "$R" claude agent_trust_paths /repo/acme 2>/dev/null
    [ "$(c_trusted "$f" /repo/acme)$(jq -r '.projects["/repo/acme"].allowedTools[0]' "$f")" = trueEdit ] \
        && echo "PASS claude·false 补成 true，其余字段不动" || echo "FAIL claude·false 补成 true，其余字段不动 :: $(cat "$f")"
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
        || echo "FAIL codex·文件不存在时建出来并信任 :: rc=$rc $(cat "$f" 2>/dev/null)"
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
        *) echo "FAIL codex·原有内容（注释、排版）逐字节保留在前面 :: $(cat "$f")" ;;
    esac
    [ "$(x_level "$f" '/repo/ai "hub"')$(x_level "$f" "/工作区/项目")" = trustedtrusted ] \
        && echo "PASS codex·带引号 / 中文的路径读回一致" || echo "FAIL codex·带引号 / 中文的路径读回一致 :: $(cat "$f")"
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
    [ "$kold" != bad ] && echo "PASS race·$agent·原有无关内容保留" || echo "FAIL race·$agent·原有无关内容保留 :: $(cat "$f")"
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
    if [ "$dialog" = yes ]; then
        if [ "$agent" = claude ]; then printf ' Accessing workspace:\n\n %s\n\n Quick safety check: Is this a project you created or one\n you trust?\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n' "$WT" > "$PANE"
        else printf '  Folder access %s\n\n  Trust this folder? Codex can read, edit, and run files here.\n\n› 1. Trust and continue\n' "$WT" > "$PANE"; fi
    else printf ' 正常的输入框\n > \n' > "$PANE"; fi
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
    if [ "$dialog" = yes ]; then
        local num_lbl="issues/$N/labels"
        if grep -q "$num_lbl.*labels\[\]=pending/human" "$D/gh.log" && grep -q "issues/$N/comments" "$D/gh.log" \
           && grep -q "trusttest-issue$N" "$D/tmux/killed" 2>/dev/null && ! grep -q "labels\[\]=doing/agent" "$D/gh.log"; then
            echo "PASS disp·$name·卡在确认框：杀会话、留言、转 pending/human、不翻 doing"
        else
            echo "FAIL disp·$name·卡在确认框：杀会话、留言、转 pending/human、不翻 doing :: $(grep -c . "$D/gh.log" 2>/dev/null) 次 gh 调用；killed=$(cat "$D/tmux/killed" 2>/dev/null)"
        fi
        grep -q "目录信任确认框" "$D/state/poll.log" 2>/dev/null && echo "PASS disp·$name·poll.log 写明哪个 agent、哪个目录" \
            || echo "FAIL disp·$name·poll.log 写明哪个 agent、哪个目录 :: 日志里没有"
    else
        grep -q "labels\[\]=doing/agent" "$D/gh.log" && ! grep -q "labels\[\]=pending/human" "$D/gh.log" \
            && echo "PASS disp·$name·没有确认框：照常翻 doing/agent" \
            || echo "FAIL disp·$name·没有确认框：照常翻 doing/agent :: $(tr '\n' '|' < "$D/gh.log" 2>/dev/null | cut -c1-300)"
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

echo "== 9. 负对照（改坏一处，对应检查必须变红）=="
LOCK_LINE='if ! flock -w "${TRUST_LOCK_WAIT_SECS:-10}" "$fd"; then'
if mutation_gate && M=$(mutant no-lock scripts/drivers/_common.sh "$LOCK_LINE" 'if false; then'); then
    neg "去掉共享锁（claude）" "race·claude·两个项目的记录都在" suite_race "$M" claude
fi
if mutation_gate && M=$(mutant no-lock scripts/drivers/_common.sh "$LOCK_LINE" 'if false; then'); then
    neg "去掉共享锁（codex）" "race·codex·两个项目的记录都在" suite_race "$M" codex
fi
if mutation_gate && M=$(mutant old-writer scripts/drivers/claude.sh \
    '    trust_config_locked_update "$cfg" _claude_trust_render _claude_trust_verify "$@"' \
    '    local t; t="$(mktemp "$cfg.XXXXXX")"; _claude_trust_render "$cfg" "$t" "$@"; mv -f "$t" "$cfg"'); then
    neg "claude 退回旧写法（锁外读改写）" "race·claude·两个项目的记录都在" suite_race "$M" claude
fi
if mutation_gate && M=$(mutant no-recheck scripts/drivers/_common.sh 'if [ "$before" != "$after" ]; then' 'if false; then'); then
    neg "替换前不再比对（claude）" "ext·claude·中途被改" suite_external "$M" claude
fi
if mutation_gate && M=$(mutant no-recheck scripts/drivers/_common.sh 'if [ "$before" != "$after" ]; then' 'if false; then'); then
    neg "替换前不再比对（codex）" "ext·codex·中途被改" suite_external "$M" codex
fi
if mutation_gate && M=$(mutant claude-key-self scripts/drivers/claude.sh \
    '    if common="$(trust_git_common_dir "$dir")"; then
        case "$common" in
            */.git) dirname "$common" ;;' \
    '    if false; then
        case "$common" in
            */.git) dirname "$common" ;;'); then
    neg "claude 规则退回「信任目录本身」" "key·claude·普通仓库的 worktree" suite_keys "$M"
    neg "claude 规则退回「信任目录本身」（派工）" "disp·new-claude-sub·每次起会话" suite_dispatch "$M" new-claude-sub
fi
if mutation_gate && M=$(mutant codex-key-common scripts/drivers/codex.sh \
    '            *)      trust_git_toplevel "$dir" && return 0 ;;' \
    '            *)      printf "%s\n" "$common"; return 0 ;;'); then
    neg "codex 子模块规则改成 .git/modules" "key·codex·子模块的 worktree" suite_keys "$M"
    neg "codex 子模块规则改成 .git/modules（派工）" "disp·new-codex-sub·每次起会话" suite_dispatch "$M" new-codex-sub
fi
if mutation_gate && M=$(mutant no-prepare scripts/_lib.sh '    agent_prepare_trust "$cwd"
' ''); then
    neg "派工起会话前不补信任" "disp·cmtR-claude-sub·每次起会话" suite_dispatch "$M" cmtR-claude-sub
    neg "派工起会话前不补信任（PR 重建）" "disp·prC-codex-sub·每次起会话" suite_dispatch "$M" prC-codex-sub
fi
neg_gate() {   # <入口名> <文件> <要删掉的那行> <场景>
    local M
    if mutation_gate && M=$(mutant "no-gate-$1" "$2" "$3" ""); then
        neg "去掉 $1 入口的确认框识别" "disp·$4·卡在确认框" suite_dispatch "$M" "$4"
    fi
}
neg_gate new scripts/dispatch-new-issue.sh 'agent_launch_trust_gate "$ISSUE" "$TMUX_SESSION" "$WORKTREE" || exit 0' dlg-new-claude
neg_gate 评论续接 scripts/dispatch-issue-comment.sh '    agent_launch_trust_gate "$ISSUE" "$TMUX_SESSION" "$WORKTREE" || exit 0' dlg-cmtB-codex
neg_gate PR续接 scripts/dispatch-pr-comment.sh '    agent_launch_trust_gate "$PR" "$TMUX_SESSION" "$WORKTREE" || exit 0' dlg-prB-codex
neg_gate PR重建 scripts/dispatch-pr-comment.sh $'\nagent_launch_trust_gate "$PR" "$TMUX_SESSION" "$WORKTREE" || exit 0' dlg-prC-claude
if mutation_gate && M=$(mutant no-claude-re scripts/drivers/claude.sh \
    "AGENT_TRUST_PROMPT_RE='Quick safety check|Yes, I trust this folder|Do you trust the files in this folder'" \
    "AGENT_TRUST_PROMPT_RE=''"); then
    neg "claude 不给确认框特征" "disp·dlg-cmtR-claude·卡在确认框" suite_dispatch "$M" dlg-cmtR-claude
fi
if mutation_gate && M=$(mutant setup-old setup.sh '        agent_trust_dirs "$HOST"' \
    '        agent_trust_paths "$HOST" "$(config_value WORKTREE_BASE)"'); then
    neg "setup.sh 退回旧写法（仓库根 + worktree base）" "setup·子模块项目：claude" suite_setup "$M"
fi

echo
mutation_summary "$0"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
