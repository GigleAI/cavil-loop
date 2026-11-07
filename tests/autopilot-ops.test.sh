#!/usr/bin/env bash
# kind: guard
# The hand-run autopilot host check in docs/operations{,.zh}.md (GitHub#124): run on every OTHER machine
# before turning autopilot on; only HOST_VERDICT=STOPPED lets you go on. (Turning autopilot off needs no
# script: the daemon cleans up by itself — that is covered by tests/autopilot.test.sh §11.)
#
# 跑法：bash tests/autopilot-ops.test.sh            （约 30 秒；有一条故意让配置卡 30 秒，验证 10 秒限时）
#       MUTATION=1 bash tests/autopilot-ops.test.sh （再跑 5 份改坏的副本，各自必须变红）
#
# 脚本原样取自两份文档里 `<!-- autopilot-ops:host-check -->` 后面的第一个 bash 代码块——人照着文档复制的
# 就是这一段，测的也是这一段。两份文档里的脚本必须逐字一致。假的 systemctl / tmux 放在 PATH 最前面，
# 临时 HOME，不碰真实配置。「会话没了、进程还在」那条用真的子进程。
#
# 规矩只有一条：读不到 ≠ 没有。设计阶段每一轮打回的都是这条的一个变体（登记目录读不了当成没装、
# 单引号配置被文本匹配漏掉……），所以每个「读失败」场景都要求 UNKNOWN，负对照把这些历史写法换回去。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

TMP=$(mktemp -d)
trap 'chmod -R u+rwx "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); [ -n "${QUIET:-}" ] || echo "  ✅ $1"; }
ng() { FAIL=$((FAIL+1)); [ -n "${QUIET:-}" ] || echo "  ❌ $1"; }

# ── 从文档取脚本 ──
extract() {   # <doc> <marker> → stdout；找不到返回 1
    awk -v m="<!-- autopilot-ops:$2 -->" '
        $0 == m { seen = 1; next }
        seen == 1 && /^```bash$/ { inb = 1; next }
        inb && /^```$/ { exit }
        inb { print }
    ' "$1"
}
for doc in operations.md operations.zh.md; do
    for m in host-check; do
        out="$TMP/${doc%.md}.$m.sh"
        extract "$REPO_DIR/docs/$doc" "$m" > "$out"
        if [ ! -s "$out" ]; then echo "❌ docs/$doc 里找不到 $m 脚本（标记 <!-- autopilot-ops:$m --> 后的 bash 代码块）"; exit 1; fi
        bash -n "$out" || { echo "❌ docs/$doc 的 $m 脚本语法错"; exit 1; }
    done
done
HC="$TMP/operations.host-check.sh"

# ── 假命令 ──
FAKE="$TMP/fake"; mkdir -p "$FAKE"
cat > "$FAKE/systemctl" <<'EOF'
#!/bin/bash
[ -n "${FAKE_SC_FAIL:-}" ] && { echo "Failed to connect to bus: No medium found" >&2; exit 1; }
shift   # --user
cmd=$1; shift
case "$cmd" in
  is-active) echo "${FAKE_ACTIVE:-inactive}"; [ "${FAKE_ACTIVE:-inactive}" = active ] && exit 0 || exit 3 ;;
  show) u="${@: -1}"
        echo "LoadState=loaded"; echo "ActiveState=${FAKE_ACTIVE:-inactive}"
        case "$u" in *.timer) echo "UnitFileState=${FAKE_ENABLED:-disabled}";; *) echo "UnitFileState=static";; esac ;;
esac
EOF
cat > "$FAKE/tmux" <<'EOF'
#!/bin/bash
[ -n "${FAKE_SESS:-}" ] && { printf '%s\n' $FAKE_SESS; exit 0; }
echo "no server running on /tmp/tmux-0/default" >&2; exit 1
EOF
chmod +x "$FAKE"/*
export PATH="$FAKE:$PATH"

# ── 机器核对段 ──
host_suite() {   # <host-check 脚本>
    local hc="$1" H="$TMP/home"; rm -rf "$H"; mkdir -p "$H/.config/cavil-loop" "$H/p"
    local V
    clr() { rm -f "$H"/.config/cavil-loop/*.conf "$H"/p/*; }
    inst() { printf '%s\nWORKTREE_BASE=%s\n' "$2" "$H/wt-$1" > "$H/p/$1.config"; printf 'CODING_AGENT_CONFIG=%s\n' "$H/p/$1.config" > "$H/.config/cavil-loop/$1.conf"; }
    run() { V=$(env HOME="$H" REPO=GigleAI/cavil-loop "$@" bash "$hc" 2>/dev/null | tail -1); }
    want() { [ "$V" = "HOST_VERDICT=$1" ] && ok "$2 → $1" || ng "$2：应 $1，实得 ${V:-（无输出）}"; }
    std() { clr; inst w $'REPO="GigleAI/cavil-loop"\nTMUX_PREFIX="workloop"'; inst t $'REPO="Other/x"\nTMUX_PREFIX="tutor"'; }

    std; run X=1;                                   want STOPPED "登记还在、服务全停、无会话"
    std; run FAKE_SESS="tutor-issue1";              want STOPPED "只有别的项目有会话"
    std; run FAKE_SC_FAIL=1;                        want UNKNOWN "连不上服务管理器"
    std; run FAKE_ENABLED=enabled;                  want RUNNING "停了但开机仍自启"
    std; run FAKE_ACTIVE=active FAKE_ENABLED=enabled; want RUNNING "定时任务在跑"
    std; run FAKE_SESS="workloop-issue7";           want RUNNING "还有本仓库会话"
    if [ "$(id -u)" != 0 ]; then
        std; chmod 000 "$H/p/t.config"; run X=1; chmod 644 "$H/p/t.config"; want UNKNOWN "另一个项目的配置读不了"
        std; chmod 000 "$H/.config/cavil-loop"; run X=1; chmod 755 "$H/.config/cavil-loop"; want UNKNOWN "登记目录读不了"
    fi
    std; printf 'CODING_AGENT_CONFIG=/nonexist\n' > "$H/.config/cavil-loop/b.conf"; run X=1; want UNKNOWN "登记指向的配置不存在"
    clr; run X=1;                                   want STOPPED "根本没装"
    clr; inst t $'REPO="Other/x"\nTMUX_PREFIX="tutor"'; run X=1; want STOPPED "只装了别的仓库"
    # 配置写法：认实例必须和 daemon 一样读配置
    clr; inst a $'REPO=\'GigleAI/cavil-loop\'\nTMUX_PREFIX=\'workloop\''; run FAKE_ACTIVE=active FAKE_ENABLED=enabled; want RUNNING "单引号写法、服务在跑"
    clr; inst a $'REPO=GigleAI/cavil-loop\nTMUX_PREFIX=workloop'; run FAKE_ACTIVE=active FAKE_ENABLED=enabled; want RUNNING "不带引号、服务在跑"
    clr; inst a $'REPO="Other/x"\nTMUX_PREFIX=workloop\nREPO="GigleAI/cavil-loop"'; run FAKE_ACTIVE=active FAKE_ENABLED=enabled; want RUNNING "重复赋值、最后一次是本仓库"
    clr; inst a $'REPO="GigleAI/cavil-loop"\nTMUX_PREFIX=workloop\nREPO="Other/x"'; run FAKE_ACTIVE=active FAKE_ENABLED=enabled; want STOPPED "重复赋值、最后一次是别的仓库"
    clr; inst a $'R=GigleAI\nREPO="$R/cavil-loop"\nTMUX_PREFIX="$R-x"'; run FAKE_SESS="GigleAI-x-issue1"; want RUNNING "用变量拼出仓库名和会话前缀"
    clr; inst a $'REPO="gigleai/Cavil-Loop"\nTMUX_PREFIX=workloop'; run FAKE_ACTIVE=active FAKE_ENABLED=enabled; want RUNNING "大小写不同"
    clr; inst a $'TMUX_PREFIX=workloop'; printf 'CODING_AGENT_CONFIG=%s\nREPO=GigleAI/cavil-loop\n' "$H/p/a.config" > "$H/.config/cavil-loop/a.conf"
         run FAKE_ACTIVE=active FAKE_ENABLED=enabled; want RUNNING "仓库名只写在安装登记里"
    clr; inst a $'REPO="GigleAI/cavil-loop\nTMUX_PREFIX=workloop'; run X=1; want UNKNOWN "配置语法错"
    clr; inst a $'TMUX_PREFIX=workloop'; run X=1;   want UNKNOWN "配置里没有仓库名"
    clr; inst a $'REPO=GigleAI/cavil-loop'; run X=1; want UNKNOWN "本仓库但没有会话前缀"
    clr; inst a $'REPO=GigleAI/cavil-loop\nTMUX_PREFIX=workloop'; sed -i '/^WORKTREE_BASE=/d' "$H/p/a.config"
         run X=1; want UNKNOWN "本仓库但没有 worktree 目录"
    # 会话没了、进程还在：工作目录在那个实例的 worktree 底下的进程也算在跑
    clr; inst a $'REPO=GigleAI/cavil-loop\nTMUX_PREFIX=workloop'; mkdir -p "$H/wt-a/issue-9"
         ( cd "$H/wt-a/issue-9" && exec sleep 60 ) & local sp=$!; sleep 0.3
         run X=1; want RUNNING "会话没了、worktree 里还有进程"; kill "$sp" 2>/dev/null; wait "$sp" 2>/dev/null
         run X=1; want STOPPED "那个进程退出后"
    clr; inst a $'echo REPO=fake\nREPO=GigleAI/cavil-loop\nTMUX_PREFIX=workloop'; run FAKE_ACTIVE=active FAKE_ENABLED=enabled; want RUNNING "配置载入时自己打印东西"
    clr; inst a $'sleep 30\nREPO=GigleAI/cavil-loop\nTMUX_PREFIX=workloop'; local t0; t0=$(date +%s); run X=1
         want UNKNOWN "配置载入卡住"
         [ $(( $(date +%s) - t0 )) -lt 25 ] && ok "  …10 秒限时生效" || ng "  …等了 $(( $(date +%s) - t0 )) 秒"
}

echo "两份文档的脚本逐字一致："
for m in host-check; do
    cmp -s "$TMP/operations.$m.sh" "$TMP/operations.zh.$m.sh" && ok "$m" || ng "$m：docs/operations.md 和 docs/operations.zh.md 不一致"
done
echo "机器核对段："; host_suite "$HC"
# 没有 timeout 命令的机器（macOS）走 perl 限时：把两种限时命令藏起来再跑一遍会卡住的那一条
sed 's/command -v timeout >/command -v no_such_timeout_cmd >/; s/command -v gtimeout >/command -v no_such_gtimeout_cmd >/' "$HC" > "$TMP/hc-perl.sh"
echo "机器核对段（没有 timeout 命令，走 perl 限时）："
H="$TMP/home"; rm -rf "$H"; mkdir -p "$H/.config/cavil-loop" "$H/p"
printf 'sleep 30\nREPO=GigleAI/cavil-loop\nTMUX_PREFIX=workloop\n' > "$H/p/a.config"
printf 'CODING_AGENT_CONFIG=%s\n' "$H/p/a.config" > "$H/.config/cavil-loop/a.conf"
t0=$(date +%s); V=$(env HOME="$H" REPO=GigleAI/cavil-loop bash "$TMP/hc-perl.sh" 2>/dev/null | tail -1)
[ "$V" = HOST_VERDICT=UNKNOWN ] && [ $(( $(date +%s) - t0 )) -lt 25 ] && ok "配置载入卡住 → UNKNOWN（10 秒内）" || ng "perl 限时：实得 $V，用时 $(( $(date +%s) - t0 )) 秒"
printf 'REPO=GigleAI/cavil-loop\nTMUX_PREFIX=workloop\nWORKTREE_BASE=%s/wt-a\n' "$H" > "$H/p/a.config"
V=$(env HOME="$H" REPO=GigleAI/cavil-loop FAKE_ACTIVE=active bash "$TMP/hc-perl.sh" 2>/dev/null | tail -1)
[ "$V" = HOST_VERDICT=RUNNING ] && ok "正常配置照常读出 → RUNNING" || ng "perl 限时下正常配置：实得 $V"

# ── 负对照：把历次复审打回的写法换回去，测试必须变红 ──
MUT_BAD=0
mutant() {   # <名字> <host|doc> <旧文本> <新文本> [<旧文本> <新文本> ...]：逐对替换后整套重跑
    local name="$1" kind="$2" src dst; shift 2
    mutation_gate || return 0
    case "$kind" in host) src="$HC";; doc) src="$TMP/operations.zh.host-check.sh";; esac
    dst="$TMP/mut.sh"
    if ! python3 -c '
import sys
s = open(sys.argv[1]).read()
pairs = sys.argv[3:]
for o, n in zip(pairs[0::2], pairs[1::2]):
    assert o in s, o
    s = s.replace(o, n, 1)
open(sys.argv[2], "w").write(s)' "$src" "$dst" "$@" 2>/dev/null; then
        echo "  ❌ 负对照「$name」准备失败：原文里找不到要改的那段"; MUT_BAD=$((MUT_BAD+1)); return 0
    fi
    local p=$PASS f=$FAIL; PASS=0; FAIL=0
    case "$kind" in
        host)  QUIET=1 host_suite "$dst" ;;
        doc)   cmp -s "$HC" "$dst" && PASS=1 || FAIL=1 ;;
    esac
    if [ "$FAIL" -gt 0 ]; then echo "  ✅ 负对照「$name」：$FAIL 条变红"; else echo "  ❌ 负对照「$name」：全绿，测试没拦住"; MUT_BAD=$((MUT_BAD+1)); fi
    PASS=$p; FAIL=$f
}
mutation_on && echo "负对照："
mutant "按文本匹配认实例（第 5 版写法）" host \
  $'  if ! got=$(load_instance "$f"); then' \
  $'  got=$(printf \'%s\\n%s\\n\' "$(sed -n \'s/^REPO="\\{0,1\\}\\([^"]*\\)"\\{0,1\\}$/\\1/p\' "$(sed -n \'s/^CODING_AGENT_CONFIG=//p\' "$f")" 2>/dev/null | tail -1)" "$(sed -n \'s/^TMUX_PREFIX="\\{0,1\\}\\([^"]*\\)"\\{0,1\\}$/\\1/p\' "$(sed -n \'s/^CODING_AGENT_CONFIG=//p\' "$f")" 2>/dev/null | tail -1)")\n  [ -n "$(printf \'%s\' "$got" | sed -n 1p)" ] || continue\n  if false; then'
mutant "登记目录读不了当成没装（第 4 版写法）" host \
  $'  [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || bad UNKNOWN "cannot read registry dir $d"' $'  :'
mutant "服务管理器连不上当成没装" host \
  $'bad UNKNOWN "instance $key: cannot query $u ($out)"; continue;' 'continue;'
mutant "机器核对只看会话、不看进程" host \
  $'[ -z "$left" ] || bad RUNNING "instance $key: processes' $': || bad RUNNING "instance $key: processes'
mutant "中英两份脚本不一致" doc 'echo "HOST_VERDICT=$verdict"' 'echo "HOST_VERDICT= $verdict"'

echo
echo "合计：通过 $PASS / 失败 $FAIL"
mutation_summary "$0"
report_counts "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && [ "$MUT_BAD" -eq 0 ]
