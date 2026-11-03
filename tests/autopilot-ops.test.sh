#!/usr/bin/env bash
# The two hand-run autopilot scripts in docs/operations{,.zh}.md (GitHub#124):
#   host-check  — run on every other machine before turning autopilot on; only HOST_VERDICT=STOPPED lets you go on
#   close       — turn autopilot off with the daemon stopped; only CLOSE_READY lets you restart it
#
# 跑法：bash tests/autopilot-ops.test.sh            （约 30 秒；有一条故意让配置卡 30 秒，验证 10 秒限时）
#       MUTATION=1 bash tests/autopilot-ops.test.sh （再跑 11 份改坏的副本，各自必须变红）
#
# 脚本原样取自两份文档里 `<!-- autopilot-ops:host-check -->` / `<!-- autopilot-ops:close -->` 后面的
# 第一个 bash 代码块——人照着文档复制的就是这一段，测的也是这一段。两份文档的同名脚本必须逐字一致。
# 假的 gh / systemctl / tmux 放在 PATH 最前面，临时 HOME，不碰真实配置和 GitHub。
# 「worker 退没退」那一组用真的 tmux（独立 socket）和真的子进程：会话关了、进程还活着这种情况，
# 假 tmux 模拟不出来（PR #127 复审第 1 轮正是在这里打回的）。
#
# 这一组脚本的规矩只有一条：读不到 ≠ 没有。设计方案经过 6 轮复审，每一轮打回的都是这条的一个变体
# （列表读失败被管道吃掉、配置不存在被 grep 取反成「已删」、单引号配置被文本匹配漏掉……），
# 所以下面每个「读失败」场景都要求 STOP / UNKNOWN，负对照把这些历史写法换回去，要求测试变红。
set -uo pipefail

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
    for m in host-check close; do
        out="$TMP/${doc%.md}.$m.sh"
        extract "$REPO_DIR/docs/$doc" "$m" > "$out"
        if [ ! -s "$out" ]; then echo "❌ docs/$doc 里找不到 $m 脚本（标记 <!-- autopilot-ops:$m --> 后的 bash 代码块）"; exit 1; fi
        bash -n "$out" || { echo "❌ docs/$doc 的 $m 脚本语法错"; exit 1; }
    done
done
HC="$TMP/operations.host-check.sh"; CL="$TMP/operations.close.sh"

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
# 假 gh：开着的 PR 和它们的标签在 $GHS（{"<n>":[labels]}）；列表接口可注入三种失败
cat > "$FAKE/gh" <<'EOF'
#!/bin/bash
shift   # api
m=GET; jqx=""; args=(); path=""
while [ $# -gt 0 ]; do case $1 in -X) m=$2; shift 2;; --paginate) shift;; --jq) jqx=$2; shift 2;; -f) args+=("$2"); shift 2;; *) path=$1; shift;; esac; done
pulls() { jq -c '[to_entries[] | {number:(.key|tonumber), labels:[.value[]|{name:.}]}]' "$GHS"; }
case "$m $path" in
  "GET repos/"*"/pulls?"*)
     c=$(( $(cat "$GHS.n" 2>/dev/null || echo 0) + 1 )); echo $c > "$GHS.n"
     case "${FAKE_LIST_FAIL:-}" in
       all) echo "HTTP 503 unavailable" >&2; exit 1;;
       second) [ $c -ge 2 ] && { echo "HTTP 503 unavailable" >&2; exit 1; };;
       partial) pulls | jq -c '.[:1]' | jq -r "$jqx"; echo "HTTP 502 on page 2" >&2; exit 1;;
     esac
     pulls | jq -r "$jqx";;
  "POST "*"/labels")
     [ -n "${FAKE_POST_FAIL:-}" ] && { echo "HTTP 500" >&2; exit 1; }
     n=$(echo "$path" | sed -E 's|.*/issues/([0-9]+)/labels|\1|'); L=${args[0]#labels[]=}
     jq --arg n "$n" --arg L "$L" '.[$n] = ((.[$n] + [$L])|unique)' "$GHS" > "$GHS.t" && mv "$GHS.t" "$GHS";;
  "DELETE "*)
     [ -n "${FAKE_DEL_FAIL:-}" ] && { echo "HTTP 500" >&2; exit 1; }
     n=$(echo "$path" | sed -E 's|.*/issues/([0-9]+)/labels/.*|\1|'); L=$(printf '%s' "${path##*/}" | jq -Rr @text | sed 's/%2F/\//g')
     jq --arg n "$n" --arg L "$L" '.[$n] -= [$L]' "$GHS" > "$GHS.t" && mv "$GHS.t" "$GHS";;
  "GET repos/"*"/issues/"*) n=${path##*/}; jq -c --arg n "$n" '{labels:[.[$n][]|{name:.}]}' "$GHS" | jq -r "$jqx";;
  *) echo "fake gh: unexpected $m $path" >&2; exit 9;;
esac
EOF
chmod +x "$FAKE"/*
export PATH="$FAKE:$PATH"

# ── 关闭段 ──
close_suite() {   # <close 脚本>
    local cl="$1" W="$TMP/cl"; rm -rf "$W"; mkdir -p "$W"
    local OUT RC LAST
    mkdir -p "$W/wt" "$W/out"
    reset() { printf 'REPO="acme/widget"\nTMUX_PREFIX=demo\nWORKTREE_BASE="%s/wt"\nLABEL_PENDING_HUMAN=pending/human\nLABEL_AUTOPILOT="autopilot"\nFOO=1\n' "$W" > "$W/cfg"
              echo '{"201":["pending/merge"],"202":["pending/merge","priority/p1"],"203":["pending/review"]}' > "$W/ghs"; rm -f "$W/ghs.n"; }
    run() { OUT=$(cd "$W/out" && env CFG="$W/cfg" UNIT=cavil-loop-poll@demo GHS="$W/ghs" "$@" bash "$cl" 2>/dev/null); RC=$?
            LAST=$(printf '%s\n' "$OUT" | tail -1); }
    stop() { if [ $RC -ne 0 ] && [ "$LAST" != CLOSE_READY ]; then ok "$1 → STOP"; else ng "$1：应 STOP，实得退出码 $RC、最后一行 $LAST"; fi; }
    ready() { if [ $RC -eq 0 ] && [ "$LAST" = CLOSE_READY ]; then ok "$1 → CLOSE_READY"; else ng "$1：应 CLOSE_READY，实得退出码 $RC、最后一行 $LAST"; fi; }
    untouched() { grep -q '^LABEL_AUTOPILOT=' "$W/cfg" && ok "  …配置没动" || ng "  …配置被改了"; }

    reset; run FAKE_ACTIVE=active;              stop "定时任务还在跑"; untouched
    reset; run FAKE_SC_FAIL=1;                  stop "连不上服务管理器"; untouched
    reset; run FAKE_SESS="demo-issue9 other-issue3"; stop "还有本项目会话"; untouched
    reset; rm -f "$W/cfg"; run X=1;             stop "配置文件不存在"
    reset; rm -f "$W/cfg"; echo '{}' > "$W/ghs"; run X=1; stop "配置文件不存在、也没有等合并 PR"
    if [ "$(id -u)" != 0 ]; then reset; chmod 000 "$W/cfg"; run X=1; chmod 644 "$W/cfg"; stop "配置文件读不了"; fi
    reset; run FAKE_LIST_FAIL=all;              stop "PR 列表两次都读失败"
    reset; echo '{"203":["pending/review"]}' > "$W/ghs"; run FAKE_LIST_FAIL=all; stop "没有等合并 PR、列表读失败"
    reset; run FAKE_LIST_FAIL=second;           stop "首次读成功、回读失败"
    reset; run FAKE_LIST_FAIL=partial;          stop "翻页中途失败（只拿到第一页）"
    reset; run FAKE_DEL_FAIL=1;                 stop "摘等合并标签失败（回读发现）"
    reset; run FAKE_POST_FAIL=1;                stop "打 pending/human 失败"
    [ "$(jq -c '.["201"]' "$W/ghs")" = '["pending/merge"]' ] && ok "  …那个 PR 的标签原样" || ng "  …那个 PR 的标签变了：$(jq -c '.["201"]' "$W/ghs")"
    reset; run FAKE_SESS="other-issue3 xdemo-issue1"; ready "只有别的项目的会话（含名字相近的）"
    reset; run X=1;                             ready "正常"
    [ "$(jq -cS . "$W/ghs")" = '{"201":["pending/human"],"202":["pending/human","priority/p1"],"203":["pending/review"]}' ] \
        && ok "  …两个等合并的改成 pending/human、其他标签保留、排队的不动" || ng "  …标签结果：$(jq -cS . "$W/ghs")"
    grep -q '^LABEL_AUTOPILOT=' "$W/cfg" && ng "  …配置那行还在" || ok "  …配置那行已删"
    [ "$(grep -c . "$W/cfg")" = 5 ] && ok "  …配置其他行保留" || ng "  …配置其他行变了：$(cat "$W/cfg")"
    run X=1;                                    ready "正常完成后重跑"
    reset; printf 'REPO="acme/widget"\nTMUX_PREFIX=demo\nLABEL_PENDING_HUMAN=pending/human\nLABEL_AUTOPILOT=autopilot\n' > "$W/cfg"; run X=1
                                                stop "配置里没有 worktree 目录"; untouched
    reset; printf 'REPO="acme/widget\nTMUX_PREFIX=demo\n' > "$W/cfg"; run X=1; stop "配置语法错"
    reset; OUT=$(cd "$W/wt" && env CFG="$W/cfg" UNIT=cavil-loop-poll@demo GHS="$W/ghs" bash "$cl" 2>/dev/null); RC=$?; LAST=$(printf '%s\n' "$OUT" | tail -1)
                                                stop "在 worktree 目录里跑"; untouched
}

# ── worker 退没退：真 tmux（独立 socket）+ 真子进程 ──
REAL_TMUX=$(PATH="${PATH#"$FAKE:"}" command -v tmux)
REAL="$TMP/fake-real"; mkdir -p "$REAL"; ln -s "$FAKE/gh" "$REAL/gh"; ln -s "$FAKE/systemctl" "$REAL/systemctl"
worker_suite() {   # <close 脚本>
    local cl="$1" W="$TMP/wk"; rm -rf "$W"; mkdir -p "$W/wt/issue-5" "$W/out" "$W/sock"
    local OUT RC LAST PIDF="$W/pid"
    export TMUX_TMPDIR="$W/sock"; unset TMUX
    cfg() { printf 'REPO="acme/widget"\nTMUX_PREFIX=demo\nWORKTREE_BASE="%s/wt"\nLABEL_PENDING_HUMAN=pending/human\nLABEL_AUTOPILOT=autopilot\n' "$W" > "$W/cfg"; echo '{}' > "$W/ghs"; }
    # 起一个 worker：会话 demo-issue5，工作目录在 worktree 里，忽略给定的信号，把自己的 pid 写下来
    start() { "$REAL_TMUX" new-session -d -s demo-issue5 -c "$W/wt/issue-5" \
        "python3 -c 'import os,signal,time; [signal.signal(getattr(signal,s),signal.SIG_IGN) for s in \"$1\".split()]; open(\"$PIDF\",\"w\").write(str(os.getpid())); time.sleep(300)'"
        local i=0; while [ ! -s "$PIDF" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; }
    alive() { kill -0 "$(cat "$PIDF")" 2>/dev/null; }
    cleanup() { [ -s "$PIDF" ] && kill -KILL "$(cat "$PIDF")" 2>/dev/null; "$REAL_TMUX" kill-server 2>/dev/null; rm -f "$PIDF"; sleep 0.2; }
    run() { OUT=$(cd "$W/out" && PATH="$REAL:$PATH" env CFG="$W/cfg" UNIT=cavil-loop-poll@demo GHS="$W/ghs" KILL_GRACE=2 "$@" bash "$cl" 2>/dev/null); RC=$?
            LAST=$(printf '%s\n' "$OUT" | tail -1); }
    stop() { if [ $RC -ne 0 ] && [ "$LAST" != CLOSE_READY ]; then ok "$1 → STOP"; else ng "$1：应 STOP，实得退出码 $RC、最后一行 $LAST"; fi; }
    ready() { if [ $RC -eq 0 ] && [ "$LAST" = CLOSE_READY ]; then ok "$1 → CLOSE_READY"; else ng "$1：应 CLOSE_READY，实得退出码 $RC、最后一行 $LAST"; fi; }

    cfg; start "SIGHUP"; alive && ok "前提：worker 起来了" || ng "前提：worker 没起来"
    run X=1; stop "会话还在、没让停"; alive && ok "  …worker 没被动" || ng "  …worker 被杀了"
    cleanup
    # 复审第 1 轮的场景：人手动关了会话，忽略 SIGHUP 的 worker 还活着
    cfg; start "SIGHUP"; "$REAL_TMUX" kill-session -t demo-issue5; sleep 0.5
    if alive && ! "$REAL_TMUX" has-session -t demo-issue5 2>/dev/null; then ok "前提：会话关了、worker 还活着"; else ng "前提没造出来（会话关了 worker 也没了）"; fi
    run X=1; stop "会话没了、进程还在"; alive && ok "  …worker 没被动" || ng "  …worker 被杀了"
    grep -q '^LABEL_AUTOPILOT=' "$W/cfg" && ok "  …配置没动" || ng "  …配置被改了"
    run KILL_WORKERS=1; ready "会话没了、进程还在，KILL_WORKERS=1"; alive && ng "  …报完成时 worker 还活着" || ok "  …worker 已退出"
    cleanup
    cfg; start "SIGHUP"; run KILL_WORKERS=1; ready "会话还在，KILL_WORKERS=1"
    alive && ng "  …worker 还活着" || ok "  …worker 已退出"
    "$REAL_TMUX" has-session -t demo-issue5 2>/dev/null && ng "  …会话还在" || ok "  …会话已关"
    cleanup
    cfg; start "SIGHUP SIGTERM"; run KILL_WORKERS=1; ready "连 SIGTERM 也不理，KILL_WORKERS=1"
    alive && ng "  …worker 还活着（没升级到 SIGKILL）" || ok "  …worker 被 SIGKILL 结束"
    cleanup
    unset TMUX_TMPDIR
}

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
for m in host-check close; do
    cmp -s "$TMP/operations.$m.sh" "$TMP/operations.zh.$m.sh" && ok "$m" || ng "$m：docs/operations.md 和 docs/operations.zh.md 不一致"
done
echo "关闭段："; close_suite "$CL"
echo "机器核对段："; host_suite "$HC"
echo "worker 退没退（真 tmux + 真进程）："; worker_suite "$CL"
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
mutant() {   # <名字> <close|worker|host|doc> <旧文本> <新文本> [<旧文本> <新文本> ...]：逐对替换后整套重跑
    local name="$1" kind="$2" src dst; shift 2
    mutation_gate || return 0
    case "$kind" in close|worker) src="$CL";; host) src="$HC";; doc) src="$TMP/operations.zh.close.sh";; esac
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
        close) QUIET=1 close_suite "$dst" ;;
        host)  QUIET=1 host_suite "$dst" ;;
        worker) QUIET=1 worker_suite "$dst" ;;
        doc)   cmp -s "$CL" "$dst" && PASS=1 || FAIL=1 ;;
    esac
    if [ "$FAIL" -gt 0 ]; then echo "  ✅ 负对照「$name」：$FAIL 条变红"; else echo "  ❌ 负对照「$name」：全绿，测试没拦住"; MUT_BAD=$((MUT_BAD+1)); fi
    PASS=$p; FAIL=$f
}
mutation_on && echo "负对照："
mutant "列表读失败被管道吃掉（第 4 版写法）" close \
  $'  local raw\n  raw=$(gh api --paginate "repos/$R/pulls?state=open&per_page=100" \\\n        --jq ".[] | select(any(.labels[]; .name==\\"$MERGE_LABEL\\")) | .number") || return 1\n  printf \'%s\\n\' "$raw" | tr \'\\n\' \' \'' \
  $'  set +o pipefail\n  gh api --paginate "repos/$R/pulls?state=open&per_page=100" --jq ".[] | select(any(.labels[]; .name==\\"$MERGE_LABEL\\")) | .number" | tr \'\\n\' \' \''
# 配置那段现在有四道关（先查文件、按 daemon 的读法载入、查行时分开读失败、删完回读），任何一道都单独
# 拦得住，所以负对照把四道一起换成第 4 版的样子：不载入配置（第 4 版的仓库名等是命令行传进来的），
# grep 读失败当「没有」，回读用 ! grep 取反
mutant "配置读不到被当成已删（第 4 版写法）" close \
  $'[ -f "$CFG" ] && [ -r "$CFG" ] && [ -w "$CFG" ] || die "config missing or not read/writable: $CFG"' ':' \
  $'\' _ "$CFG" </dev/null 2>/dev/null) || die "loading $CFG failed (syntax error or timeout)"' \
  $'\' _ "$CFG" </dev/null 2>/dev/null) || vals=$(printf \'%s\\n\' acme/widget demo "$PWD/../wt" pending/merge pending/human)' \
  $'  *) die "cannot read $CFG (grep exit $rc)" ;;' $'  *) ;;' \
  $'[ $rc -eq 1 ] || die' $'! has_line || die'
mutant "不回读等合并标签" close \
  $'[ -z "${left// /}" ] || die' ': ||'
mutant "服务状态只排除 active" close \
  $'[ "$a" = inactive ] || [ "$a" = failed ] || die' $'[ "$a" != active ] || die'
mutant "按文本匹配认实例（第 5 版写法）" host \
  $'  if ! got=$(load_instance "$f"); then' \
  $'  got=$(printf \'%s\\n%s\\n\' "$(sed -n \'s/^REPO="\\{0,1\\}\\([^"]*\\)"\\{0,1\\}$/\\1/p\' "$(sed -n \'s/^CODING_AGENT_CONFIG=//p\' "$f")" 2>/dev/null | tail -1)" "$(sed -n \'s/^TMUX_PREFIX="\\{0,1\\}\\([^"]*\\)"\\{0,1\\}$/\\1/p\' "$(sed -n \'s/^CODING_AGENT_CONFIG=//p\' "$f")" 2>/dev/null | tail -1)")\n  [ -n "$(printf \'%s\' "$got" | sed -n 1p)" ] || continue\n  if false; then'
mutant "登记目录读不了当成没装（第 4 版写法）" host \
  $'  [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ] || bad UNKNOWN "cannot read registry dir $d"' $'  :'
mutant "服务管理器连不上当成没装" host \
  $'bad UNKNOWN "instance $key: cannot query $u ($out)"; continue;' 'continue;'
mutant "只看会话、不看进程（PR #127 复审第 1 轮）" worker \
  $'[ -z "$left" ] || die "processes still working under' $': || die "processes still working under'
mutant "让停时不升级到 SIGKILL" worker \
  'for p in $pids $more; do kill -KILL' 'for p in ; do kill -KILL'
mutant "机器核对只看会话、不看进程" host \
  $'[ -z "$left" ] || bad RUNNING "instance $key: processes' $': || bad RUNNING "instance $key: processes'
mutant "中英两份脚本不一致" doc 'CLOSE_READY"' 'CLOSE-READY"'

echo
echo "合计：通过 $PASS / 失败 $FAIL"
mutation_summary "$0"
[ "$FAIL" -eq 0 ] && [ "$MUT_BAD" -eq 0 ]
