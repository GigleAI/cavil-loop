#!/usr/bin/env bash
# GitHub#109: `systemctl enable` resolves the template symlink to the end, so an
# instance timer link points into one releases/<sha>/; the deployer later deletes
# that release and the timer silently vanishes. This checks the repair
# (scripts/repair-unit-links.sh) and every place that calls it:
#
#   【1】真 systemctl --root 离线 enable：链接形状确实直指发布目录，修复后指回稳定入口
#   【2】修复规则：只改自己的、先写「待重新加载」记号、重新加载失败的跨轮重试、
#        启动失败的跨轮重试、人停过 / 禁用 / 查不到时不启动、记号写不进不改链接
#   【3】整条发布链：主干上的旧部署器做升级（照旧删掉旧版本），同一轮新版本的轮询入口修回；
#        新部署器同轮修链后删旧版本；修链失败保留旧版本，下一轮修好再删
#   【4】setup.sh 回答 y 启用后，链接已在稳定入口
#   【5】文档里给人照做的命令在干净环境（env -i）按字面跑
#
# 不碰本机真实 systemd：除【1】用 `systemctl --root=<临时目录>`（只写文件、不连 user manager），
# 其余一律走假 systemctl（按单元记状态：是否启用 / 运行状态 / 结束原因，按顺序记每次调用，
# 可按次数注入失败）。HOME 指向临时目录。
#
#   bash tests/repair-unit-links.test.sh            默认（约 5 秒；MUTATION=1 约 11 秒）
#   MUTATION=1 bash tests/repair-unit-links.test.sh 另跑负对照：把被测代码改坏一处，对应检查必须变红
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/mutation.sh
source "$REPO_DIR/tests/lib/mutation.sh"
TMP="$(mktemp -d)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; [ -n "${KEEP_TMP:-}" ] || rm -rf "$TMP"; [ -n "${KEEP_TMP:-}" ] && echo "kept $TMP"' EXIT
REAL_SYSTEMCTL="$(command -v systemctl || true)"
TREES="$TMP"   # 新旧两份脚本快照；负对照在自己的临时目录里跑，但共用这两份

PASS=0; FAIL=0
chk() {   # <name> <actual> <expected>
    if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ✅ $1"
    else FAIL=$((FAIL + 1)); echo "  ❌ $1"; echo "     期望：[$3]"; echo "     实得：[$2]"; fi
}

# ── 假 systemctl ───────────────────────────────────────────────────────────────
# 状态：$SC/units/<unit> 一行「UnitFileState ActiveState Result」；调用按顺序记进 $SC/calls。
# 注入：$SC/fail-<cmd> 文件里写剩余失败次数（daemon-reload / start / show）。
# enable 照真 systemd 255 的实测行为把实例链接解析到底（见【1】）。
FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/systemctl" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = --user ] && shift
SC="${FAKE_SC:?}"
SYS="${CAVIL_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
mkdir -p "$SC/units"
printf '%s\n' "$*" >> "$SC/calls"
fail_once() {   # <cmd>：还有剩余失败次数就减一并返回 0
    local f="$SC/fail-$1" n
    [ -f "$f" ] || return 1
    n=$(cat "$f"); [ "$n" -gt 0 ] || return 1
    echo $((n - 1)) > "$f"; return 0
}
get() { [ -f "$SC/units/$1" ] && cat "$SC/units/$1" || echo "disabled inactive success"; }
cmd="${1:-}"; shift || true
now=0; units=(); props=()
while [ $# -gt 0 ]; do case "$1" in
    --now) now=1 ;;
    -p) props+=("$2"); shift ;;
    --*) ;;
    *) units+=("$1") ;;
esac; shift; done
case "$cmd" in
    daemon-reload) fail_once daemon-reload && exit 1; exit 0 ;;
    enable)
        for u in "${units[@]}"; do
            tpl="${u%%@*}@.${u##*.}"
            target="$(readlink -f "$SYS/$tpl")"
            ln -sfn "$target" "$SYS/$u"
            mkdir -p "$SYS/timers.target.wants"; ln -sfn "$target" "$SYS/timers.target.wants/$u"
            if [ $now = 1 ]; then echo "enabled active success" > "$SC/units/$u"
            else read -r _ a r <<< "$(get "$u")"; echo "enabled $a $r" > "$SC/units/$u"; fi
        done ;;
    start)
        fail_once start && exit 1
        for u in "${units[@]}"; do read -r e _ _ <<< "$(get "$u")"; echo "$e active success" > "$SC/units/$u"; done ;;
    stop)
        for u in "${units[@]}"; do read -r e _ _ <<< "$(get "$u")"; echo "$e inactive success" > "$SC/units/$u"; done ;;
    show)
        fail_once show && exit 1
        [ -f "$SC/show-empty" ] && exit 0
        read -r e a r <<< "$(get "${units[0]}")"
        [ "$e" = disabled ] && e=""
        echo "UnitFileState=$e"; echo "ActiveState=$a"; echo "Result=$r" ;;
    is-enabled) read -r e _ _ <<< "$(get "${units[0]}")"; echo "$e"; [ "$e" = enabled ] ;;
    is-active)  read -r _ a _ <<< "$(get "${units[0]}")"; echo "$a"; [ "$a" = active ] ;;
esac
exit 0
SH
chmod +x "$FAKEBIN/systemctl"
calls() { [ -f "$FAKE_SC/calls" ] || { echo 0; return; }; grep -c -- "$1" "$FAKE_SC/calls" || true; }
# 「重新加载」在「启动」之前：两类调用在调用记录里第一次出现的行号
order() {
    local r s
    r=$(grep -n -m1 -- 'daemon-reload' "$FAKE_SC/calls" | cut -d: -f1)
    s=$(grep -n -m1 -- '^start ' "$FAKE_SC/calls" | cut -d: -f1)
    [ -n "$r" ] && [ -n "$s" ] && [ "$r" -lt "$s" ] && echo reload-then-start || echo "reload=$r start=$s"
}

# ── 一套最小的受管布局：releases/<R>/systemd/ 放仓库真实单元文件，稳定入口指向它 ──
layout() {   # <home> <release-name>：建好并让稳定入口指向这一版
    local h="$1" r="$2" rel="$1/.agents/releases/cavil-loop/releases/$2"
    mkdir -p "$rel/systemd" "$h/.agents/skills" "$h/.config/systemd/user"
    cp "$REPO_DIR"/systemd/cavil-loop-poll@.timer "$REPO_DIR"/systemd/cavil-loop-poll@.service \
       "$REPO_DIR"/systemd/cavil-loop-weekly-report@.timer "$rel/systemd/"
    : > "$rel/.inuse"
    ln -sfn "$rel" "$h/.agents/skills/cavil-loop"
    local u
    for u in cavil-loop-poll@.timer cavil-loop-poll@.service cavil-loop-weekly-report@.timer; do
        ln -sfn "$h/.agents/skills/cavil-loop/systemd/$u" "$h/.config/systemd/user/$u"
    done
}
# 一次修复调用：干净环境，只给 HOME / PATH / 假 systemd 状态
repair() {   # <home> [extra env…]
    local h="$1"; shift
    env -i HOME="$h" PATH="$FAKEBIN:/usr/bin:/bin" FAKE_SC="$FAKE_SC" "$@" \
        bash "${REPAIR_SH:-$REPO_DIR/scripts/repair-unit-links.sh}" 2>>"$h/repair.log"
}
snap() { find "$1/.config/systemd/user" -type l -printf '%p -> %l\n' | sort; }

# ═════════════════════════════════════════════════════════════════════════════
group1() {
echo "【1】真 systemctl --root 离线 enable 产生的链接形状"
if [ -z "$REAL_SYSTEMCTL" ]; then echo "  ⏭  本机没有 systemctl，跳过本组（【2】起用同形状夹具照常跑）"; return; fi
local ROOT="$TMP/root" h="/h"
mkdir -p "$ROOT$h/.agents/releases/cavil-loop/releases/R1/systemd" "$ROOT/etc/systemd/user"
cp "$REPO_DIR"/systemd/cavil-loop-poll@.timer "$REPO_DIR"/systemd/cavil-loop-poll@.service \
   "$ROOT$h/.agents/releases/cavil-loop/releases/R1/systemd/"
mkdir -p "$ROOT$h/.agents/skills"
ln -s "$h/.agents/releases/cavil-loop/releases/R1" "$ROOT$h/.agents/skills/cavil-loop"
ln -s "$h/.agents/skills/cavil-loop/systemd/cavil-loop-poll@.timer" "$ROOT/etc/systemd/user/"
ln -s "$h/.agents/skills/cavil-loop/systemd/cavil-loop-poll@.service" "$ROOT/etc/systemd/user/"
if ! "$REAL_SYSTEMCTL" --global --root="$ROOT" enable cavil-loop-poll@demo.timer >/dev/null 2>&1; then
    echo "  ⏭  本机 systemctl 不支持 --root 离线 enable，跳过本组（【2】起用同形状夹具照常跑）"; return
fi
local want="$h/.agents/releases/cavil-loop/releases/R1/systemd/cavil-loop-poll@.timer"
chk "真 enable：实例链接直指发布目录（issue 描述的根因）" "$(readlink "$ROOT/etc/systemd/user/cavil-loop-poll@demo.timer")" "$want"
chk "真 enable：timers.target.wants/ 里那条也直指发布目录" "$(readlink "$ROOT/etc/systemd/user/timers.target.wants/cavil-loop-poll@demo.timer")" "$want"
# 把这组链接原样搬进一个真实 HOME 布局（链接文字只加上临时根目录前缀），再跑修复
local H="$TMP/h1"
layout "$H" R1
ln -sfn "$H${want#"$h"}" "$H/.config/systemd/user/cavil-loop-poll@demo.timer"
mkdir -p "$H/.config/systemd/user/timers.target.wants"
ln -sfn "$H${want#"$h"}" "$H/.config/systemd/user/timers.target.wants/cavil-loop-poll@demo.timer"
export FAKE_SC="$TMP/sc1"; mkdir -p "$FAKE_SC"
repair "$H"
local stable="$H/.agents/skills/cavil-loop/systemd/cavil-loop-poll@.timer"
chk "修复后实例链接指向稳定入口" "$(readlink "$H/.config/systemd/user/cavil-loop-poll@demo.timer")" "$stable"
chk "修复后 timers.target.wants/ 那条也指向稳定入口" "$(readlink "$H/.config/systemd/user/timers.target.wants/cavil-loop-poll@demo.timer")" "$stable"
chk "改了链接就重新加载了一次" "$(calls daemon-reload)" "1"
}

# ═════════════════════════════════════════════════════════════════════════════
fixture() {   # <home>：稳定入口 → R2；本项目两条实例链接还指着 R1（R1 在不在由调用方定）
    local h="$1"
    layout "$h" R1; layout "$h" R2
    local old="$h/.agents/releases/cavil-loop/releases/R1/systemd/cavil-loop-poll@.timer"
    ln -sfn "$old" "$h/.config/systemd/user/cavil-loop-poll@demo.timer"
    mkdir -p "$h/.config/systemd/user/timers.target.wants"
    ln -sfn "$old" "$h/.config/systemd/user/timers.target.wants/cavil-loop-poll@demo.timer"
}
group2() {
echo "【2】修复规则"
local H S u="cavil-loop-poll@demo.timer"
local stable_of='/.agents/skills/cavil-loop/systemd/cavil-loop-poll@.timer'

echo " 2a 只改自己的单元；别人的同样指向发布目录的链接原样不动"
H="$TMP/h2a"; fixture "$H"; export FAKE_SC="$TMP/sc2a"; mkdir -p "$FAKE_SC"
ln -s "$H/.agents/releases/cavil-loop/releases/R1/systemd/cavil-loop-poll@.service" "$H/.config/systemd/user/someone-else.service"
repair "$H"
chk "本项目实例链接改回稳定入口" "$(readlink "$H/.config/systemd/user/$u")" "$H$stable_of"
chk "别人的链接没动" "$(readlink "$H/.config/systemd/user/someone-else.service")" "$H/.agents/releases/cavil-loop/releases/R1/systemd/cavil-loop-poll@.service"
chk "记号已清" "$([ -e "$H/.agents/releases/cavil-loop/.unit-reload-pending" ] && echo left || echo gone)" "gone"

echo " 2b 重新加载失败：本轮不启动；下一轮链接没变化也照样重新加载，成功后才启动；再下一轮什么都不做"
H="$TMP/h2b"; fixture "$H"; export FAKE_SC="$TMP/sc2b"; mkdir -p "$FAKE_SC/units"
echo "enabled failed resources" > "$FAKE_SC/units/$u"
echo 1 > "$FAKE_SC/fail-daemon-reload"
repair "$H"; local rc1=$?
chk "第一轮：链接已改回" "$(readlink "$H/.config/systemd/user/$u")" "$H$stable_of"
chk "第一轮：调用了重新加载（失败）" "$(calls daemon-reload)" "1"
chk "第一轮：没有启动任何任务" "$(calls '^start ')" "0"
chk "第一轮：记号还在" "$([ -e "$H/.agents/releases/cavil-loop/.unit-reload-pending" ] && echo left)" "left"
chk "第一轮：退出码非 0（还有事留给下一轮）" "$([ "$rc1" -ne 0 ] && echo nonzero)" "nonzero"
S="$(snap "$H")"; : > "$FAKE_SC/calls"
repair "$H"
chk "第二轮：一条链接都没变" "$(snap "$H")" "$S"
chk "第二轮：仍调用了重新加载" "$(calls daemon-reload)" "1"
chk "第二轮：重新加载在启动之前" "$(order)" "reload-then-start"
chk "第二轮：启动了消失的任务" "$(calls "^start $u")" "1"
chk "第二轮：记号已清" "$([ -e "$H/.agents/releases/cavil-loop/.unit-reload-pending" ] && echo left || echo gone)" "gone"
: > "$FAKE_SC/calls"
repair "$H"
chk "第三轮：不再重新加载" "$(calls daemon-reload)" "0"
chk "第三轮：不再启动（已在运行）" "$(calls '^start ')" "0"
chk "第三轮：确实查过任务状态（不是什么都没跑）" "$([ "$(calls "^show .*$u")" -ge 1 ] && echo yes)" "yes"

echo " 2c 启动失败：下一轮不重新加载、再启动"
H="$TMP/h2c"; fixture "$H"; export FAKE_SC="$TMP/sc2c"; mkdir -p "$FAKE_SC/units"
echo "enabled failed resources" > "$FAKE_SC/units/$u"
echo 1 > "$FAKE_SC/fail-start"
repair "$H"
chk "第一轮：重新加载一次、尝试启动一次" "$(calls daemon-reload)/$(calls "^start $u")" "1/1"
: > "$FAKE_SC/calls"
repair "$H"
chk "第二轮：不再重新加载、再启动一次" "$(calls daemon-reload)/$(calls "^start $u")" "0/1"
chk "第二轮后任务在运行" "$(cat "$FAKE_SC/units/$u")" "enabled active success"

echo " 2d 第一轮重新加载失败之后人停了 / 禁用了：恢复重新加载，但不启动"
for st in "enabled inactive success" "disabled failed resources"; do
    H="$TMP/h2d-${st%% *}"; fixture "$H"; export FAKE_SC="$TMP/sc2d-${st%% *}"; mkdir -p "$FAKE_SC/units"
    echo "enabled failed resources" > "$FAKE_SC/units/$u"; echo 1 > "$FAKE_SC/fail-daemon-reload"
    repair "$H"; echo "$st" > "$FAKE_SC/units/$u"; : > "$FAKE_SC/calls"
    repair "$H"
    chk "「$st」：第二轮重新加载了" "$(calls daemon-reload)" "1"
    chk "「$st」：没有启动" "$(calls '^start ')" "0"
    chk "「$st」：查过状态" "$([ "$(calls "^show .*$u")" -ge 1 ] && echo yes)" "yes"
done

echo " 2e 状态查不到 / 返回空：重新加载照做，不启动"
for how in fail empty; do
    H="$TMP/h2e-$how"; fixture "$H"; export FAKE_SC="$TMP/sc2e-$how"; mkdir -p "$FAKE_SC/units"
    echo "enabled failed resources" > "$FAKE_SC/units/$u"
    if [ $how = fail ]; then echo 9 > "$FAKE_SC/fail-show"; else : > "$FAKE_SC/show-empty"; fi
    repair "$H"
    chk "查询$how：重新加载了" "$(calls daemon-reload)" "1"
    chk "查询$how：确实查过" "$([ "$(calls "^show .*$u")" -ge 1 ] && echo yes)" "yes"
    chk "查询$how：没有启动" "$(calls '^start ')" "0"
done

echo " 2f 记号写不进去：一条链接都不改，不重新加载"
H="$TMP/h2f"; fixture "$H"; export FAKE_SC="$TMP/sc2f"; mkdir -p "$FAKE_SC"
: > "$H/.agents/releases/cavil-loop/.unit-links.lock"
S="$(snap "$H")"
chmod a-w "$H/.agents/releases/cavil-loop"
repair "$H"; local rcf=$?
chmod u+w "$H/.agents/releases/cavil-loop"
chk "链接原样" "$(snap "$H")" "$S"
chk "没有重新加载" "$(calls daemon-reload)" "0"
chk "退出码非 0" "$([ "$rcf" -ne 0 ] && echo nonzero)" "nonzero"
chk "日志说明了原因" "$(grep -c 'cannot write' "$H/repair.log")" "1"
repair "$H"
chk "目录恢复可写后下一轮修好" "$(readlink "$H/.config/systemd/user/$u")" "$H$stable_of"

echo " 2g 一切正常时什么都不做（不重新加载、不启动、不出声）"
H="$TMP/h2g"; layout "$H" R1; export FAKE_SC="$TMP/sc2g"; mkdir -p "$FAKE_SC/units"
ln -s "$H/.agents/skills/cavil-loop/systemd/cavil-loop-poll@.timer" "$H/.config/systemd/user/$u"
echo "enabled active success" > "$FAKE_SC/units/$u"
: > "$H/repair.log"
repair "$H"; local rcg=$?
chk "退出码 0、无重新加载、无启动" "$rcg/$(calls daemon-reload)/$(calls '^start ')" "0/0/0"
chk "确实查过这个任务的状态（不是一进来就退出）" "$([ "$(calls "^show .*$u")" -ge 1 ] && echo yes)" "yes"
chk "日志为空" "$(cat "$H/repair.log")" ""
}

# ═════════════════════════════════════════════════════════════════════════════
# 【3】整条发布链。V1 = 主干上（本 PR 之前）的整套脚本，V2/V3/V4 = 当前工作区；轮询主体换成桩。
BASE_REV="$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD)"
make_tree() {   # <dir> <old|new>
    local d="$1"; mkdir -p "$d"
    if [ "$2" = old ]; then git -C "$REPO_DIR" archive "$BASE_REV" | tar -x -C "$d"
    else (cd "$REPO_DIR" && git ls-files -co --exclude-standard -z) \
        | (cd "$REPO_DIR" && xargs -0 -I{} cp --parents -P {} "$d/" 2>/dev/null); fi
    printf '#!/usr/bin/env bash\necho "polled $(basename "$CODING_AGENT_RELEASE_ROOT")"\n' > "$d/scripts/agent-poll.sh"
}
commit_tree() {   # <src repo> <tree dir> <msg>
    local src="$1"
    find "$src" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    cp -a "$2/." "$src/"
    git -C "$src" add -A >/dev/null
    git -C "$src" -c user.email=t@example.invalid -c user.name=t commit -qm "$3" --allow-empty
    git -C "$src" push -q origin main 2>/dev/null
    git -C "$src" rev-parse HEAD
}
group3() {   # [mutated new tree dir] [plain|linked]
local NEWTREE="${1:-$TREES/tree-new}" LAYOUT="${2:-plain}" L=""
if [ "$LAYOUT" = linked ]; then
    L="（单元目录本身是软链接）"
    echo "【3b】同一条发布链，但 ~/.config/systemd/user 是指向别处真实目录的软链接（PR #111 复审第 1 轮）"
else
    echo "【3】整条发布链：旧部署器升级 → 新轮询入口同轮修回 → 新部署器同轮修链再删旧版本"
fi
local H="$TMP/h3$$$RANDOM"; mkdir -p "$H"
local REMOTE="$H/remote.git" SRC="$H/src"
git init -q --bare "$REMOTE"; git init -q -b main "$SRC"; git -C "$SRC" remote add origin "$REMOTE"
export FAKE_SC="$H/sc"; mkdir -p "$FAKE_SC"
local DR="$H/.agents/releases/cavil-loop" SK="$H/.agents/skills/cavil-loop" SYS="$H/.config/systemd/user"
local u="cavil-loop-poll@demo.timer"
run() { env -i HOME="$H" PATH="$FAKEBIN:/usr/bin:/bin" FAKE_SC="$FAKE_SC" CAVIL_DEPLOY_REPO="$REMOTE" \
        CAVIL_DEPLOY_ALERT_AFTER=999999 "$@" 2>>"$H/run.log"; }
local V1 V2 V3 V4
V1=$(commit_tree "$SRC" "$TREES/tree-old" v1)
run bash "$SRC/scripts/skill-deploy.sh" --bootstrap --force
local REALSYS="$SYS"
if [ "$LAYOUT" = linked ]; then
    REALSYS="$H/elsewhere/units"; mkdir -p "$REALSYS"; cp -a "$SYS/." "$REALSYS/" 2>/dev/null; rm -rf "$SYS"; ln -s "$REALSYS" "$SYS"   # 部署器 bootstrap 已建好真目录，换成软链接
fi
mkdir -p "$SYS"
for f in cavil-loop-poll@.timer cavil-loop-poll@.service; do ln -sfn "$SK/systemd/$f" "$SYS/$f"; done
run systemctl --user enable --now "$u"
[ "$LAYOUT" = linked ] && chk "$L夹具：单元目录确实是软链接" "$([ -L "$SYS" ] && echo link)" "link"
chk "$L起点：稳定入口在 V1，enable 把链接解析进 V1" "$(readlink -f "$SK" | xargs basename)|$(readlink "$SYS/$u")" \
    "$V1|$DR/releases/$V1/systemd/cavil-loop-poll@.timer"

V2=$(commit_tree "$SRC" "$NEWTREE" v2)
run bash "$SK/scripts/skill-deploy.sh" --force   # V1 里的旧部署器
chk "$L旧部署器：切到 V2 并照旧删掉了 V1（问题重现）" \
    "$(readlink -f "$SK" | xargs basename)|$([ -e "$DR/releases/$V1" ] && echo kept || echo deleted)" "$V2|deleted"
chk "$L旧部署器之后：链接已断" "$([ -e "$SYS/$u" ] && echo ok || echo broken)" "broken"
echo "enabled failed resources" > "$FAKE_SC/units/$u"   # systemd 下次重新加载时就会这样记
: > "$FAKE_SC/calls"
local out; out=$(run bash "$DR/entrypoints/poll-entry.sh")
chk "$L同一轮新版本轮询主体照常跑了" "$out" "polled $V2"
chk "$L同一轮：两条链接都改回稳定入口且能解析" \
    "$(readlink "$SYS/$u")|$(readlink "$SYS/timers.target.wants/$u")|$([ -f "$SYS/$u" ] && echo ok)" \
    "$SK/systemd/cavil-loop-poll@.timer|$SK/systemd/cavil-loop-poll@.timer|ok"
chk "$L同一轮：先重新加载再启动消失的任务" "$(order)|$(calls "^start $u")" "reload-then-start|1"

run systemctl --user enable "$u"   # 又被人手动 enable 了一次：链接解析进 V2
chk "$L再次 enable：链接解析进 V2" "$(readlink "$SYS/$u")" "$DR/releases/$V2/systemd/cavil-loop-poll@.timer"
V3=$(commit_tree "$SRC" "$NEWTREE" v3)
run bash "$SK/scripts/skill-deploy.sh" --force   # 现在是 V2 里的新部署器
chk "$L新部署器：切到 V3、同一轮修链后删掉 V2" \
    "$(readlink -f "$SK" | xargs basename)|$([ -e "$DR/releases/$V2" ] && echo kept || echo deleted)|$(readlink "$SYS/$u")" \
    "$V3|deleted|$SK/systemd/cavil-loop-poll@.timer"
chk "$L新部署器之后任务链接仍能解析" "$([ -f "$SYS/$u" ] && [ -f "$SYS/timers.target.wants/$u" ] && echo ok)" "ok"

run systemctl --user enable "$u"   # 链接解析进 V3
# 改不了一条：普通布局里是 timers.target.wants/ 不可写；软链接布局里是软链接指向的那个真实目录不可写
local RO="$SYS/timers.target.wants"; [ "$LAYOUT" = linked ] && RO="$REALSYS"
chmod a-w "$RO"
V4=$(commit_tree "$SRC" "$NEWTREE" v4)
run bash "$SK/scripts/skill-deploy.sh" --force
chk "$L修链失败：V3 保留" "$(readlink -f "$SK" | xargs basename)|$([ -e "$DR/releases/$V3" ] && echo kept || echo deleted)" "$V4|kept"
chk "$L修链失败：日志说明保留原因" "$(grep -c "keeping $V3: a systemd unit link still points into it" "$H/run.log")" "1"
chmod u+w "$RO"
run bash "$SK/scripts/skill-deploy.sh" --force
chk "$L下一轮修好后删掉 V3，两条链接仍能解析" \
    "$([ -e "$DR/releases/$V3" ] && echo kept || echo deleted)|$(readlink "$SYS/$u")|$(readlink "$SYS/timers.target.wants/$u")|$([ -f "$SYS/$u" ] && [ -f "$SYS/timers.target.wants/$u" ] && echo ok)" \
    "deleted|$SK/systemd/cavil-loop-poll@.timer|$SK/systemd/cavil-loop-poll@.timer|ok"
}

# ═════════════════════════════════════════════════════════════════════════════
group4() {   # [mutated new tree dir]
local NEWTREE="${1:-$TREES/tree-new}"
echo "【4】setup.sh 回答 y 启用之后，链接已经在稳定入口"
local H="$TMP/h4$$$RANDOM" HOST
mkdir -p "$H"; HOST="$H/projects/widget"
local REMOTE="$H/remote.git" SRC="$H/src"
git init -q --bare "$REMOTE"; git init -q -b main "$SRC"; git -C "$SRC" remote add origin "$REMOTE"
commit_tree "$SRC" "$NEWTREE" snapshot >/dev/null
git init -q -b main "$HOST"; git -C "$HOST" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init
local GHB="$H/ghbin"; mkdir -p "$GHB"
cat > "$GHB/gh" <<'GH'
#!/usr/bin/env bash
case "$*" in "auth status"*) exit 0 ;; "repo view"*) echo acme/widget; exit 0 ;; esac
echo '[]'
GH
printf '#!/usr/bin/env bash\nexit 0\n' > "$GHB/claude"; chmod +x "$GHB"/*
export FAKE_SC="$H/sc"; mkdir -p "$FAKE_SC"
printf 'y\n' | env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CAVIL_DEPLOY_CONF -u CODING_AGENT_CONFIG \
    -u CODING_AGENT_RELEASE_ROOT -u WORKER_AGENT -u CAVIL_SYSTEMD_USER_DIR \
    HOME="$H" PATH="$GHB:$FAKEBIN:$PATH" FAKE_SC="$FAKE_SC" \
    bash "$SRC/setup.sh" "$HOST" > "$H/setup.out" 2>&1
local rc=$?
local SYS="$H/.config/systemd/user" SK="$H/.agents/skills/cavil-loop" u="cavil-loop-poll@widget.timer"
chk "setup.sh 退出码 0" "$rc" "0"
[ "$rc" = 0 ] || tail -15 "$H/setup.out"
chk "setup 确实执行了启用" "$(calls "^enable --now $u")" "1"
chk "启用后两条链接都指向稳定入口" "$(readlink "$SYS/$u")|$(readlink "$SYS/timers.target.wants/$u")" \
    "$SK/systemd/cavil-loop-poll@.timer|$SK/systemd/cavil-loop-poll@.timer"
}

# ═════════════════════════════════════════════════════════════════════════════
group5() {
echo "【5】文档里的人工命令按字面跑（干净环境，中英两份各跑一遍）"
local doc
for doc in "$REPO_DIR/docs/operations.md" "$REPO_DIR/docs/operations.zh.md"; do
    group5_doc "$doc"
done
}
group5_doc() {   # <doc>
local doc="$1" d; d="$(basename "$doc" .md)"
local H="$TMP/h5-$d" u="cavil-loop-poll@demo.timer" name
# 文档里 <!-- repair-unit-links:<name> --> 标出的代码块，原样取出来跑
for name in repair check fallback; do
    awk -v n="$name" '$0 ~ "<!-- repair-unit-links:" n " -->" {f=1; next} f && /^ *```bash/ {g=1; next} g && /^ *```/ {exit} g {sub(/^   /, ""); print}' "$doc" > "$TMP/$d-$name.sh"
    chk "$d：找到「$name」命令块" "$([ -s "$TMP/$d-$name.sh" ] && echo yes)" "yes"
done
fixture "$H"; rm -rf "$H/.agents/releases/cavil-loop/releases/R1"   # 已经断掉的那种
# 人在终端跑的是稳定入口里那一份：放进当前版本（R2）
mkdir -p "$H/.agents/releases/cavil-loop/releases/R2/scripts"
cp "${REPAIR_SH:-$REPO_DIR/scripts/repair-unit-links.sh}" "$REPO_DIR/scripts/_names.sh" "$H/.agents/releases/cavil-loop/releases/R2/scripts/"
export FAKE_SC="$TMP/sc5-$d"; mkdir -p "$FAKE_SC/units"; echo "enabled failed resources" > "$FAKE_SC/units/$u"
env -i HOME="$H" PATH="$FAKEBIN:/usr/bin:/bin" FAKE_SC="$FAKE_SC" bash "$TMP/$d-repair.sh" >/dev/null 2>&1
chk "$d 修复命令：链接改回、任务启动" "$(readlink "$H/.config/systemd/user/$u")|$(cat "$FAKE_SC/units/$u")" \
    "$H/.agents/skills/cavil-loop/systemd/cavil-loop-poll@.timer|enabled active success"
local out; out=$(env -i HOME="$H" PATH="$FAKEBIN:/usr/bin:/bin" FAKE_SC="$FAKE_SC" bash "$TMP/$d-check.sh" 2>&1)
chk "$d 检查命令：修好后没有任何问题行" "$(printf '%s\n' "$out" | grep -c '/\.config/systemd/user/')" "0"
# 检查命令确实分得出坏的：再弄断一条，它必须报出来
ln -sfn "$H/.agents/releases/cavil-loop/releases/R1/systemd/cavil-loop-poll@.timer" "$H/.config/systemd/user/$u"
out=$(env -i HOME="$H" PATH="$FAKEBIN:/usr/bin:/bin" FAKE_SC="$FAKE_SC" bash "$TMP/$d-check.sh" 2>&1)
chk "$d 检查命令：断链和指向发布目录的链接都会报出来" "$(printf '%s\n' "$out" | grep -c "/\.config/systemd/user/$u")" "2"
# 单元目录本身是软链接时也得报出来（find 默认不进软链接起点，这里会一行不打印）
mv "$H/.config/systemd/user" "$H/units-real"; ln -s "$H/units-real" "$H/.config/systemd/user"
out=$(env -i HOME="$H" PATH="$FAKEBIN:/usr/bin:/bin" FAKE_SC="$FAKE_SC" bash "$TMP/$d-check.sh" 2>&1)
chk "$d 检查命令：单元目录是软链接时同样报出来" "$(printf '%s\n' "$out" | grep -c "/\.config/systemd/user/$u")" "2"
# 手工兜底：示例里的项目名是 arktool，换成本夹具的 demo
local H2="$TMP/h5b-$d"; fixture "$H2"; rm -rf "$H2/.agents/releases/cavil-loop/releases/R1"
sed 's/^KEY=arktool$/KEY=demo/' "$TMP/$d-fallback.sh" > "$TMP/$d-fallback-demo.sh"
chk "$d 手工兜底：示例项目名替换成功" "$(grep -c '^KEY=demo$' "$TMP/$d-fallback-demo.sh")" "1"
export FAKE_SC="$TMP/sc5b-$d"; mkdir -p "$FAKE_SC"
env -i HOME="$H2" PATH="$FAKEBIN:/usr/bin:/bin" FAKE_SC="$FAKE_SC" bash "$TMP/$d-fallback-demo.sh" >/dev/null 2>&1
chk "$d 手工兜底：两条链接改回、重新加载并重启" \
    "$(readlink "$H2/.config/systemd/user/$u")|$(readlink "$H2/.config/systemd/user/timers.target.wants/$u")|$(calls daemon-reload)|$(calls "^restart $u")" \
    "$H2/.agents/skills/cavil-loop/systemd/cavil-loop-poll@.timer|$H2/.agents/skills/cavil-loop/systemd/cavil-loop-poll@.timer|1|1"
local H3="$TMP/h5c-$d"; mkdir -p "$H3/.config/systemd/user"; export FAKE_SC="$TMP/sc5c-$d"; mkdir -p "$FAKE_SC"
env -i HOME="$H3" PATH="$FAKEBIN:/usr/bin:/bin" FAKE_SC="$FAKE_SC" bash "$TMP/$d-fallback-demo.sh" >/dev/null 2>&1
chk "$d 手工兜底：模板不存在时停下，不留半截链接" "$(find "$H3/.config/systemd/user" -type l | wc -l)|$(calls daemon-reload)" "0|0"
}

group3_linked() { group3 "$1" linked; }

# ═════════════════════════════════════════════════════════════════════════════
make_tree "$TREES/tree-old" old
make_tree "$TREES/tree-new" new
group1
group2
group3
group3 "" linked
group4
group5

# ── 负对照：改坏一处，对应检查必须变红 ─────────────────────────────────────────
MUT_BAD=0
mutant() {   # <描述> <文件（相对仓库）> <python 替换：old> <new> <要跑的组> <期望变红的检查名片段>
    local desc="$1" file="$2" old="$3" new="$4" grp="$5" want="$6"
    mutation_gate || return 0
    local T="$TREES/mut$MUTATION_COUNT"; rm -rf "$T"; cp -a "$TREES/tree-new" "$T"
    if ! OLD="$old" NEW="$new" python3 -c '
import os,sys
p=sys.argv[1]; s=open(p).read(); o=os.environ["OLD"]
if s.count(o)!=1: sys.exit(1)
open(p,"w").write(s.replace(o,os.environ["NEW"]))' "$T/$file"; then
        echo "  ❌ 负对照准备失败（原文不在了）：$desc"; MUT_BAD=$((MUT_BAD + 1)); return
    fi
    local log; log=$(PASS=0 FAIL=0; TMP="$T.run"; mkdir -p "$TMP"; REPAIR_SH="$T/scripts/repair-unit-links.sh"; "$grp" "$T" 2>&1)
    if printf '%s\n' "$log" | grep -F "❌" | grep -qF -- "$want"; then echo "  ✅ 负对照拦下：$desc"
    else echo "  ❌ 负对照没拦下：$desc（期望「$want」变红）"; MUT_BAD=$((MUT_BAD + 1)); fi
}
if mutation_on; then echo "【负对照】"; fi
mutant "重新加载不论成败都清记号" scripts/repair-unit-links.sh \
    '    if systemctl --user daemon-reload >/dev/null 2>&1; then' \
    '    rm -f "$UL_MARK"; if systemctl --user daemon-reload >/dev/null 2>&1; then' group2 "第二轮：仍调用了重新加载"
mutant "重新加载失败也照样启动" scripts/repair-unit-links.sh \
    '    if _ul_reload; then' '    _ul_reload; if true; then' group2 "第一轮：没有启动任何任务"
mutant "启动条件放宽成「已启用就启动」" scripts/repair-unit-links.sh \
    '[ "$ufs" = enabled ] && [ "$as" = failed ] && [ "$res" = resources ] || continue' \
    '[ "$ufs" = enabled ] || continue' group2 "没有启动"
mutant "状态查不到当成「失败」" scripts/repair-unit-links.sh \
    '-p Result "$u" 2>/dev/null)" || continue' \
    '-p Result "$u" 2>/dev/null)" || out=$'"'"'UnitFileState=enabled\nActiveState=failed\nResult=resources'"'"'' group2 "查询fail：没有启动"
mutant "记号写不进也照改链接" scripts/repair-unit-links.sh \
    '        UL_RC=1
        return 1
    fi
    local item' '        UL_RC=1
    fi
    local item' group2 "链接原样"
mutant "只改自己的：判断去掉" scripts/repair-unit-links.sh \
    '        _ul_ours "$(basename "$l")" || continue
        printf' '        printf' group2 "别人的链接没动"
# 下面几处改坏的是整条发布链里的新版本（工作区快照），跑【3】/【4】
mutant "轮询入口不调用修复" scripts/poll-entry.sh \
    'if [ "$(uname -s)" = Linux ] && [ -f "$CODING_AGENT_RELEASE_ROOT/scripts/repair-unit-links.sh" ]; then' \
    'if false; then' group3 "同一轮：两条链接都改回稳定入口"
mutant "部署器不调用修复" scripts/skill-deploy.sh \
    'if [ "$(uname -s)" = Linux ] && [ -f "$UNIT_LINKS_SH" ]; then' 'if false; then' group3 "新部署器：切到 V3、同一轮修链后删掉 V2"
mutant "部署器删旧版本前不查引用" scripts/skill-deploy.sh \
    '    if [ -f "$UNIT_LINKS_SH" ] && CAVIL_SYSTEMD_USER_DIR' '    if false && CAVIL_SYSTEMD_USER_DIR' group3 "修链失败：V3 保留"
mutant "删前引用检查改回 find 列目录（复审第 1 轮的实现）" scripts/repair-unit-links.sh \
    '    list="$(_ul_all_links)" || return 0' \
    '    list="$(find "$UL_SYS_DIR" -maxdepth 2 -type l 2>/dev/null)" || return 0' group3_linked "（单元目录本身是软链接）修链失败：V3 保留"
mutant "setup 启用后不调用修复" setup.sh \
    '            bash "$SKILL_DIR/scripts/repair-unit-links.sh" \' '            false \' group4 "启用后两条链接都指向稳定入口"

echo
mutation_summary "$0"
[ "$MUT_BAD" -eq 0 ] || FAIL=$((FAIL + MUT_BAD))
echo "通过 $PASS，失败 $FAIL"
[ "$FAIL" -eq 0 ]
