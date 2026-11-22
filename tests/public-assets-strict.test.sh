#!/usr/bin/env bash
# kind: unit
# reads: repo
# （假 HOME 的技能入口是指向整个仓库的符号链接，服务和切换命令都从那里跑）
# 跑法：bash tests/public-assets-strict.test.sh   （~40 s）
# 依赖：node、curl、jq、git。无网络（只打本机回环），HOME 指到临时目录。
#
# 公网出图目录按项目分目录、只经一个发布命令、发布和对外服务都强制查凭证（GitHub#613）。
# 全部走真实入口：真起 scripts/public-assets/serve.mjs（经 run.sh，和 systemd 单元一样），
# 切换命令 switch.sh 面对的是一个真会起停服务进程的假 systemctl。
#   ① 严格模式的交图规则：项目子目录 / 旧图清单 / 其余一律 404；内容在内存里查、从内存送出
#   ② 不开严格模式：和合并基点的服务对同一组请求给出同样的回答
#   ③ 旧图清单的每种状态：未生效 / 两份好 / 一份坏 / 两份坏 / 校验值格式不对 / 中断后重建 / 生效后不重建
#   ④ 切换命令：--status 只读、--verify 只放又删测试文件、切换成功、超限不切、核验不过自动退回、
#      自动切换的退避、文档里的手动退回步骤原样执行
#   ⑤ 发布命令：未生效拒绝、落在 <key>/<编号>/、含凭证拒绝且不留文件、写错目录时删掉自己放的文件、
#      周报保留文件名、同名不覆盖、早期写法
#   ⑥ 派工提示词：配了地址且找得到 key → 两条换成发布命令；找不到 key → 写明发不了；没配地址 → 不动
#   ⑦ 周报 run.sh：发布模式下图链 = 发布命令返回的地址；未生效时出图前就停；只有旧周报地址且已严格 → 停
#   ⑨ 同一文件身份的几个路径（硬链接）：各按自己的路径判，不随缓存冷热和请求先后变
#   ⑩ 非默认路径前缀：切换核验和发布按服务报告的前缀 / 端口走；状态缺这两项 = 判断不了
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/prompt-files.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/prompt-files.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(dirname "$TEST_DIR")}"
TMP="$(mktemp -d)"
export HOME="$TMP/home"
mkdir -p "$HOME/.config/cavil-loop" "$HOME/.agents/skills" "$TMP/bin"
ln -s "$REPO_DIR" "$HOME/.agents/skills/cavil-loop"
REAL_PATH="$PATH"
export PATH="$TMP/bin:$PATH"
unset GH_TOKEN GITHUB_TOKEN WEEKLY_REPORT_EXTRA_PROJECTS PUBLIC_ASSETS_STATUS PUBLIC_ASSETS_LEGACY_LISTS PUBLIC_ASSETS_PROJECT_DIRS CODING_AGENT_RELEASE_ROOT WEEKLY_REPORT_ASSET_ROOT_URL 2>/dev/null || true
for v in $(env | sed -n 's/^\(DISPATCH_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
printf '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"

SVC_PIDS="$TMP/svc.pids"
cleanup() {
    [ -f "$SVC_PIDS" ] && while read -r p; do kill "$p" 2>/dev/null; done < "$SVC_PIDS"
    rm -rf "$TMP"
}
trap cleanup EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass + 1))
    else echo "  ❌ $1 (期望 '$3'，实得 '$(printf '%s' "$2" | tr '\n' '|')')"; fail=$((fail + 1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
png() { printf '\x89PNG\r\n\x1a\n' > "$1"; head -c "${2:-64}" /dev/urandom >> "$1"; }
FAKE_SECRET="NOT-A-REAL-TOKEN-0123456789abcdef"
secret_png() { printf '\x89PNG\r\n\x1a\n{"refresh_''token": "%s"}' "$FAKE_SECRET" > "$1"; }
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }

ROOT="$TMP/assets"
CONF="$HOME/.config/cavil-loop/public-assets.conf"
STATE="$HOME/.local/state/cavil-loop/public-assets"
LIST1="$HOME/.config/cavil-loop/public-assets-legacy.json"
LIST2="$STATE/legacy.json"
PORT="$(free_port)"
B="http://127.0.0.1:$PORT/review-assets"
mkdir -p "$ROOT/issue-464" "$ROOT/weekly-report" "$ROOT/acme/12"
png "$ROOT/issue-464/old-a.png"; png "$ROOT/issue-464/old-b.png"; png "$ROOT/weekly-report/delivery-wk-1.png"
printf '<!doctype html>x' > "$ROOT/issue-464/page.html"
# 两个登记的项目（带 PROJECT_ROOT= 行）；另有一个不像项目的 conf（public-assets.conf 本身）
for k in acme 919.club; do
    printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\nWEEKLY_REPORT_ASSET_ROOT_URL="%s"\n' "$TMP/proj-$k" "$TMP/proj-$k/cavil-loop.config" "$B" > "$HOME/.config/cavil-loop/$k.conf"
done
cat > "$CONF" <<CONF
PUBLIC_ASSETS_ROOT=$ROOT
PUBLIC_ASSETS_PORT=$PORT
CONF

# 假 systemctl：真起停服务进程（和单元一样：读 EnvironmentFile、跑稳定技能入口下的 run.sh）。
# FAKE_SVC_NOKEYS=1：起服务时把它看的配置目录换成空目录（模拟「重启后新规则没按预期工作」）。
cat > "$TMP/bin/systemctl" <<SH
#!/usr/bin/env bash
pidf="$TMP/svc.pid"
alive() { [ -f "\$pidf" ] && kill -0 "\$(cat "\$pidf")" 2>/dev/null; }
case "\$*" in
    "--user is-active cavil-loop-public-assets.service") if alive; then echo active; else echo inactive; exit 3; fi ;;
    "--user show -p MainPID --value cavil-loop-public-assets.service") if alive; then cat "\$pidf"; else echo 0; fi ;;
    "--user restart cavil-loop-public-assets.service"|"--user start cavil-loop-public-assets.service")
        if alive; then p="\$(cat "\$pidf")"; kill "\$p"; for _ in \$(seq 1 50); do kill -0 "\$p" 2>/dev/null || break; sleep 0.1; done; fi
        extra=()
        [ "\${FAKE_SVC_NOKEYS:-0}" = 1 ] && extra=(PUBLIC_ASSETS_PROJECT_DIRS="$TMP/empty-cfg")
        mkdir -p "$TMP/empty-cfg"
        ( set -a; . "$CONF"; set +a; exec env "\${extra[@]}" bash "$HOME/.agents/skills/cavil-loop/scripts/public-assets/run.sh" ) >> "$TMP/svc.log" 2>&1 &
        echo \$! > "\$pidf"; echo \$! >> "$SVC_PIDS"
        for _ in \$(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done ;;
    *) echo "fake systemctl: \$*" >&2; exit 1 ;;
esac
SH
chmod +x "$TMP/bin/systemctl"
SWITCH="$REPO_DIR/scripts/public-assets/switch.sh"
PUBLISH="$REPO_DIR/scripts/publish-asset.sh"
sw() { bash "$SWITCH" "$@" 2> "$TMP/sw.err"; local r=$?; { echo "== sw $* → $r"; cat "$TMP/sw.err"; } >> "$TMP/sw.all"; return $r; }
state_of() { node "$REPO_DIR/scripts/public-assets/strict.mjs" status-check "$STATE/status.json" | jq -r .state; }

echo "② 不开严格模式：和合并基点的服务回答一样"
BASE_REV="$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || true)"
if [ -n "$BASE_REV" ] && git -C "$REPO_DIR" cat-file -e "$BASE_REV:scripts/public-assets/serve.mjs" 2>/dev/null; then
    # 基点上整个服务目录原样取出：服务由哪几个文件组成由基点自己决定，测试不点名（GitHub#632）
    mkdir -p "$TMP/old-src"
    git -C "$REPO_DIR" archive "$BASE_REV" scripts/public-assets | tar -x -C "$TMP/old-src"
    OLD_PA="$TMP/old-src/scripts/public-assets"
    OLD_LOG="$TMP/old-pa.log"
    OPORT="$(free_port)"
    PUBLIC_ASSETS_ROOT="$ROOT" PUBLIC_ASSETS_PORT="$OPORT" node "$OLD_PA/serve.mjs" > "$OLD_LOG" 2>&1 &
    OLD_PID=$!; echo "$OLD_PID" >> "$SVC_PIDS"
    # 起来了 = 本轮启动的这个进程还活着，且它自己打印了监听本端口的那一行（端口上别人的回答不算）。
    # 最多等 30 秒，打印出那一行就立即往下走：原来只等 5 秒，CI 上负载高时 node 还没打印就判了失败
    # （GitHub#658，PR #661 的 shard 1/8：日志为空、进程还活着）
    old_up=no
    for _ in $(seq 1 300); do
        kill -0 "$OLD_PID" 2>/dev/null || break
        if grep -q "^public-assets: 127\.0\.0\.1:$OPORT " "$OLD_LOG"; then old_up=yes; break; fi
        sleep 0.1
    done
    old_why=""
    [ "$old_up" = yes ] || old_why="$(head -n 5 "$OLD_LOG" | tr '\n' '|')"
    chk "合并基点的旧服务确实起来了（进程活着、它自己报告在分给它的端口上监听）${old_why:+；旧服务日志：$old_why}" "$old_up" "yes"
    systemctl --user start cavil-loop-public-assets.service
    secret_png "$ROOT/issue-464/leak.png"
    if [ "$old_up" = yes ]; then
        diffs=""
        for p in issue-464/old-a.png issue-464/page.html issue-464/leak.png issue-464/ weekly-report/delivery-wk-1.png acme/12/none.png missing.png; do
            a="$(curl -s -D - "http://127.0.0.1:$OPORT/review-assets/$p" | tr -d '\r' | grep -aviE '^(date|last-modified|connection|keep-alive):' | sha256sum)"
            b="$(curl -s -D - "$B/$p" | tr -d '\r' | grep -aviE '^(date|last-modified|connection|keep-alive):' | sha256sum)"
            [ "$a" = "$b" ] || diffs="$diffs $p"
        done
        chk "七个请求（图、HTML、带凭证的 PNG、目录、周报图、不存在的）：状态码、响应头、正文都一样" "$diffs" ""
        chk "七个请求问完，旧服务进程还活着（回答都来自它）" "$(kill -0 "$OLD_PID" 2>/dev/null && echo alive || echo gone)" "alive"
    else
        echo "  ⏭ 旧服务没起来，七个请求的对拍没有跑（原因见上一条）"
    fi
    chk "对照确实跑了：老规则下带凭证样式的 PNG 照样交出（这正是严格模式要拦的）" "$(code "$B/issue-464/leak.png")" "200"
    rm -f "$ROOT/issue-464/leak.png"
else
    systemctl --user start cavil-loop-public-assets.service
    echo "  ⏭ 没有合并基点的服务可比（git 历史不全）"
fi
chk "不开严格模式也写状态文件，报告 not-enforced" "$(state_of)" "not-enforced"

echo "④ 切换命令"
snap() { find "$HOME" "$ROOT" -path "$HOME/.agents" -prune -o -printf '%P %s %T@\n' 2>/dev/null | sort; }
before="$(snap)"; sw --status > "$TMP/st.out"; rc=$?
chk "--status：退出码 0、STATE=not-enforced、清单未生效" "$rc/$(cat "$TMP/st.out")/$(grep -c '旧图清单：未生效' "$TMP/sw.err")" "0/STATE=not-enforced/1"
chk "--status 前后 HOME 和资产目录一个字节都没变" "$( [ "$before" = "$(snap)" ] && echo same)" "same"
chk "没切换时 --verify 不核验（不放任何测试文件）" "$(sw --verify; echo $?)/$(find "$ROOT" -name 'cavil-verify-*' | wc -l | tr -d ' ')" "1/0"

# 超过上限的旧图：不切换，配置不动
cp "$CONF" "$TMP/conf.before"
printf 'PUBLIC_ASSETS_MAX_BYTES=40\n' >> "$CONF"
sw; rc=$?
chk "有旧图超过单文件上限：不切换（退出码 1），点名了超限文件" "$rc/$(grep -c '超过上限：issue-464/old-a.png' "$TMP/sw.err")" "1/1"
chk "超限时配置里没有写严格模式，也没有清单" "$(grep -c 'PUBLIC_ASSETS_STRICT\|LEGACY_SHA' "$CONF")/$([ -e "$LIST1" ] && echo 有 || echo 无)" "0/无"
cp "$TMP/conf.before" "$CONF"

sw; rc=$?
chk "切换成功：退出码 0、服务报告 enforced" "$rc/$(state_of)" "0/enforced"
chk "配置里写了校验值和严格模式各一行，另有切换前的备份（备份名按秒，前面超限那次也留了一份，同一秒会合成一份）" "$(grep -c '^PUBLIC_ASSETS_LEGACY_SHA=[0-9a-f]\{64\}$' "$CONF")/$(grep -c '^PUBLIC_ASSETS_STRICT=1$' "$CONF")/$(ls "$HOME/.config/cavil-loop" | grep -c '^public-assets.conf.bak-' | awk '{print ($1>=1)?"有":"无"}')" "1/1/有"
SHA="$(sed -n 's/^PUBLIC_ASSETS_LEGACY_SHA=//p' "$CONF")"
chk "两份清单都在、校验值对得上" "$(sha256sum "$LIST1" | cut -d' ' -f1)/$(sha256sum "$LIST2" | cut -d' ' -f1)" "$SHA/$SHA"
chk "核验做了四项、两个地址各一遍（全部 ✓）" "$(grep -c '  ✓ ' "$TMP/sw.err")/$(grep -c '  ✗ ' "$TMP/sw.err")" "8/0"
chk "核验的测试文件都删了，0 号目录也没留下" "$(find "$ROOT" -name 'cavil-verify-*' | wc -l | tr -d ' ')/$([ -e "$ROOT/acme/0" ] && echo 留了 || echo 没留)" "0/没留"
chk "切换记进了本机日志" "$(grep -c '已切换' "$STATE/switch.log")" "1"
chk "--verify 单独跑：通过，测试文件也删干净" "$(sw --verify; echo $?)/$(find "$ROOT" -name 'cavil-verify-*' | wc -l | tr -d ' ')" "0/0"

echo "① 严格模式的交图规则"
png "$ROOT/acme/12/shot.png"; png "$ROOT/919.club/weekly-report/w.png" 2>/dev/null || { mkdir -p "$ROOT/919.club/weekly-report"; png "$ROOT/919.club/weekly-report/w.png"; }
mkdir -p "$ROOT/nobody/3" "$ROOT/acme/abc" "$ROOT/acme/12/deeper"
png "$ROOT/nobody/3/x.png"; png "$ROOT/acme/abc/x.png"; png "$ROOT/acme/12/deeper/x.png"
secret_png "$ROOT/acme/12/leak.png"
png "$ROOT/issue-464/new-after-switch.png"
res=""
for p in acme/12/shot.png 919.club/weekly-report/w.png issue-464/old-a.png weekly-report/delivery-wk-1.png \
         nobody/3/x.png acme/abc/x.png acme/12/deeper/x.png acme/12/leak.png issue-464/new-after-switch.png issue-464/page.html; do
    res="$res $(code "$B/$p")"
done
chk "项目子目录下 200 ×2；清单里的旧图 200 ×2；未登记的 key、编号不对、层级不对、含凭证、切换后新放的旧位置文件、HTML 一律 404" \
    "$res" " 200 200 200 200 404 404 404 404 404 404"
chmod 600 "$ROOT/issue-464/old-a.png"; touch -d '2001-01-01' "$ROOT/issue-464/old-a.png"
chk "旧图只改权限、改修改时间：仍 200" "$(code "$B/issue-464/old-a.png")" "200"
cp -a "$ROOT/issue-464/old-a.png" "$TMP/old-a.bak"; rm "$ROOT/issue-464/old-a.png"; cp -a "$TMP/old-a.bak" "$ROOT/issue-464/old-a.png"
chk "按原路径原内容从备份还原：仍 200" "$(code "$B/issue-464/old-a.png")" "200"
mv "$ROOT/issue-464/old-b.png" "$ROOT/issue-464/old-b-renamed.png"
chk "旧图改名：404" "$(code "$B/issue-464/old-b-renamed.png")" "404"
mv "$ROOT/issue-464/old-b-renamed.png" "$ROOT/issue-464/old-b.png"
cp "$ROOT/issue-464/old-a.png" "$TMP/keep.png"; png "$ROOT/issue-464/old-a.png"
chk "旧图被换了内容：404" "$(code "$B/issue-464/old-a.png")" "404"
cp "$TMP/keep.png" "$ROOT/issue-464/old-a.png"
chk "换回原内容：200" "$(code "$B/issue-464/old-a.png")" "200"
# 已交出过的文件原地改成含凭证内容，修改时间改回原值：状态变更时间变了，身份变了，重新判 → 404
chk "（先交出一次，进缓存）" "$(code "$B/acme/12/shot.png")" "200"
mt="$(stat -c %Y "$ROOT/acme/12/shot.png")"
printf '{"refresh_''token": "%s"}' "$FAKE_SECRET" | dd of="$ROOT/acme/12/shot.png" bs=1 seek=20 conv=notrunc 2>/dev/null
touch -d "@$mt" "$ROOT/acme/12/shot.png"
chk "原地改成含凭证内容、修改时间改回原值：404" "$(code "$B/acme/12/shot.png")" "404"
# 上限两侧
printf 'PUBLIC_ASSETS_MAX_BYTES=4096\n' >> "$CONF"
sw >/dev/null 2>&1
png "$ROOT/acme/12/at.png" $((4096 - 8)); png "$ROOT/acme/12/over.png" $((4096 - 7))
chk "单文件上限两侧：正好上限 200，多 1 字节 404" "$(code "$B/acme/12/at.png")/$(code "$B/acme/12/over.png")" "200/404"
sed -i '/^PUBLIC_ASSETS_MAX_BYTES=/d' "$CONF"; sw >/dev/null 2>&1
chk "（改回默认上限，重新切换后仍 enforced）" "$(state_of)" "enforced"
# 分段请求从内存里切
printf '\x89PNG\r\n\x1a\n0123456789abcdef' > "$ROOT/acme/12/r.png"
chk "分段请求：206 + 正确的字节" "$(code -H 'Range: bytes=8-11' "$B/acme/12/r.png")/$(curl -s -H 'Range: bytes=8-11' "$B/acme/12/r.png")" "206/0123"
# 响应过程中改写磁盘上的文件：收到的仍是检查过的那一份
png "$ROOT/acme/12/big.png" $((3 * 1024 * 1024)); cp "$ROOT/acme/12/big.png" "$TMP/big.orig"
curl -s --limit-rate 1M "$B/acme/12/big.png" -o "$TMP/big.got" & cpid=$!
sleep 0.8
head -c $((3 * 1024 * 1024)) /dev/urandom | dd of="$ROOT/acme/12/big.png" bs=1M seek=0 conv=notrunc 2>/dev/null
wait "$cpid"
chk "响应途中文件被改写：收到的字节和改写前检查过的那份完全一致" "$(cmp -s "$TMP/big.got" "$TMP/big.orig" && echo same)" "same"
chk "改写后的下一次请求重新判（仍是合法 PNG 开头才 200）" "$(code "$B/acme/12/big.png")" "404"

echo "③ 旧图清单的每种状态"
cp "$LIST2" "$TMP/list2.good"
printf 'x' >> "$LIST2"
sw --status > /dev/null
chk "一份损坏：--status 点名坏的那份" "$(grep -c "一份损坏（$LIST2）" "$TMP/sw.err")" "1"
systemctl --user restart cavil-loop-public-assets.service
chk "一份损坏、服务重启后：用另一份，旧图照常 200（重启后核验没重做，状态是 strict-unverified）" "$(state_of)/$(code "$B/issue-464/old-b.png")" "strict-unverified/200"
sw; rc=$?
chk "再跑一次切换：把好的那份复制回去，两份都正常" "$rc/$(sha256sum "$LIST2" | cut -d' ' -f1)" "0/$SHA"
printf 'x' >> "$LIST1"; printf 'x' >> "$LIST2"
systemctl --user restart cavil-loop-public-assets.service
chk "两份都坏：服务报告清单不可用（not-enforced），旧结构 404，项目子目录照常" "$(state_of)/$(code "$B/issue-464/old-b.png")/$(code "$B/acme/12/at.png")" "not-enforced/404/200"
chk "两份都坏：日志里写了原因" "$(grep -c '旧图清单不可用' "$TMP/svc.log" | awk '{print ($1>0)?"有":"无"}')" "有"
sw; rc=$?
chk "两份都坏：切换命令不切换、不重建（退出码 1），清单文件没被改写" "$rc/$(grep -c '需要人处理' "$TMP/sw.err")/$(sha256sum "$LIST1" | cut -d' ' -f1 | grep -c "$SHA")" "1/1/0"
cp "$TMP/list2.good" "$LIST1"; cp "$TMP/list2.good" "$LIST2"
sw; rc=$?
chk "从备份找回清单后：切换成功，旧图 200，切换后新放的仍 404" "$rc/$(code "$B/issue-464/old-b.png")/$(code "$B/issue-464/new-after-switch.png")" "0/200/404"
sed -i 's/^PUBLIC_ASSETS_LEGACY_SHA=.*/PUBLIC_ASSETS_LEGACY_SHA=nothex/' "$CONF"
systemctl --user restart cavil-loop-public-assets.service
sw; rc=$?
chk "校验值那一行格式不对：旧结构 404，切换命令不重建" "$(code "$B/issue-464/old-b.png")/$rc/$(grep -c '格式不对' "$TMP/sw.err")" "404/1/1"
sed -i "s/^PUBLIC_ASSETS_LEGACY_SHA=.*/PUBLIC_ASSETS_LEGACY_SHA=$SHA/" "$CONF"
sw >/dev/null 2>&1
chk "（校验值改回后恢复 enforced）" "$(state_of)" "enforced"

echo "④ 核验不过 → 自动退回；自动切换的退避"
FAKE_SVC_NOKEYS=1 sw; rc=$?
chk "重启后新规则没按预期（项目子目录全 404）：退出码 1，自动退回" "$rc/$(grep -c '已退回' "$TMP/sw.err")" "1/1"
chk "退回后：服务报告严格模式关、配置里没有严格模式行、校验值那一行保留" "$(node "$REPO_DIR/scripts/public-assets/strict.mjs" status-check "$STATE/status.json" | jq -r .reason)/$(grep -c '^PUBLIC_ASSETS_STRICT=' "$CONF")/$(grep -c "^PUBLIC_ASSETS_LEGACY_SHA=$SHA$" "$CONF")" "服务报告严格模式关/0/1"
chk "退回后旧图照常 200（老规则）" "$(code "$B/issue-464/old-b.png")" "200"
chk "核验测试文件没有留下" "$(find "$ROOT" -name 'cavil-verify-*' | wc -l | tr -d ' ')" "0"
FAKE_SVC_NOKEYS=1 bash "$SWITCH" --auto 2> "$TMP/sw.err"
chk "自动切换：失败一次，记下退避（tries=1）" "$(jq -r .tries "$STATE/auto.json")" "1"
pid_before="$(cat "$TMP/svc.pid")"
bash "$SWITCH" --auto 2> "$TMP/sw.err"
chk "退避期内再调一次：不重启服务、不重试" "$(cat "$TMP/svc.pid")/$(jq -r .tries "$STATE/auto.json")" "$pid_before/1"
jq '.next = 0' "$STATE/auto.json" > "$STATE/auto.json.t" && mv "$STATE/auto.json.t" "$STATE/auto.json"
bash "$SWITCH" --auto 2> "$TMP/sw.err"
chk "退避期过了：自动切换成功，计数清零" "$(state_of)/$(jq -r .tries "$STATE/auto.json")" "enforced/0"
pid_before="$(cat "$TMP/svc.pid")"
bash "$SWITCH" --auto 2> "$TMP/sw.err"
chk "已生效且代码一致：自动切换什么都不做（不重启）" "$(cat "$TMP/svc.pid")/$(wc -c < "$TMP/sw.err" | tr -d ' ')" "$pid_before/0"
printf 'PUBLIC_ASSETS_AUTO_SWITCH=0\n' >> "$CONF"
systemctl --user restart cavil-loop-public-assets.service >/dev/null 2>&1
sed -i '/^PUBLIC_ASSETS_STRICT=/d' "$CONF"; systemctl --user restart cavil-loop-public-assets.service
pid_before="$(cat "$TMP/svc.pid")"
bash "$SWITCH" --auto 2> "$TMP/sw.err"
chk "配置里关了自动切换：没生效也不动" "$(cat "$TMP/svc.pid")/$(state_of)" "$pid_before/not-enforced"
sed -i '/^PUBLIC_ASSETS_AUTO_SWITCH=/d' "$CONF"
sw >/dev/null 2>&1
chk "（重新切换后 enforced）" "$(state_of)" "enforced"

echo "④ 文档里的手动退回步骤，按原文执行"
blk_of() { awk '/<!-- public-assets-rollback:begin -->/{f=1;next} /<!-- public-assets-rollback:end -->/{f=0} f' "$REPO_DIR/docs/$1" | sed -n '/^```bash$/,/^```$/p' | sed '1d;$d'; }
run_blk() { env -i HOME="$HOME" PATH="$TMP/bin:$REAL_PATH" LANG=C.UTF-8 OLD_IMAGE_URL="$B/issue-464/old-b.png" bash -c "$1" 2>&1; }
# 备份写不进去：命令块就地停下，配置和服务都不动
cp "$CONF" "$TMP/conf.pre"; chmod 500 "$HOME/.config/cavil-loop"
out="$(run_blk "$(blk_of operations.md)")"; rc=$?
chmod 700 "$HOME/.config/cavil-loop"
chk "备份失败：命令块退出非 0、说 BACKUP-FAILED，配置一字没动，服务仍是 enforced" \
    "$([ "$rc" != 0 ] && echo 非0)/$(printf '%s\n' "$out" | grep -c '^BACKUP-FAILED')/$(cmp -s "$CONF" "$TMP/conf.pre" && echo 没动)/$(state_of)" "非0/1/没动/enforced"
for doc in operations.md operations.zh.md; do
    blk="$(awk '/<!-- public-assets-rollback:begin -->/{f=1;next} /<!-- public-assets-rollback:end -->/{f=0} f' "$REPO_DIR/docs/$doc" | sed -n '/^```bash$/,/^```$/p' | sed '1d;$d')"
    [ -n "$blk" ] || { chk "$doc 有手动退回的命令块" "无" "有"; continue; }
    out="$(run_blk "$blk")"; rc=$?
    chk "$doc：手动退回命令块跑通，看到 active、服务自报严格模式关（true）、旧图 200、ROLLED-BACK" "$rc/$(printf '%s\n' "$out" | grep -cx 'active')/$(printf '%s\n' "$out" | grep -cx 'true')/$(printf '%s\n' "$out" | grep -cx '200')/$(printf '%s\n' "$out" | tail -n 1)/$(state_of)" "0/1/1/1/ROLLED-BACK/not-enforced"
    sw >/dev/null 2>&1
done
chk "两份文档的手动退回命令块一字不差" "$(diff <(awk '/<!-- public-assets-rollback:begin -->/{f=1;next} /<!-- public-assets-rollback:end -->/{f=0} f' "$REPO_DIR/docs/operations.md" | sed -n '/^```bash$/,/^```$/p') <(awk '/<!-- public-assets-rollback:begin -->/{f=1;next} /<!-- public-assets-rollback:end -->/{f=0} f' "$REPO_DIR/docs/operations.zh.md" | sed -n '/^```bash$/,/^```$/p') >/dev/null && echo same)" "same"
chk "文档步骤加上了「不再自动切换」那一行" "$(grep -c '^PUBLIC_ASSETS_AUTO_SWITCH=0$' "$CONF")" "1"
sed -i '/^PUBLIC_ASSETS_AUTO_SWITCH=/d' "$CONF"
chk "（文档步骤之后重新切换，enforced）" "$(state_of)" "enforced"

echo "④ 验收记录：服务在严格模式不等于核验已完成"
chk "切换成功后有验收记录" "$([ -s "$STATE/accepted.json" ] && echo 有)" "有"
rm -f "$STATE/accepted.json"
chk "切换在核验前被中断（没有验收记录）：服务仍在严格模式，但状态是 strict-unverified" "$(state_of)/$(code "$B/issue-464/new-after-switch.png")" "strict-unverified/404"
chk "strict-unverified 时发布命令不发图" "$(bash "$PUBLISH" --project acme --check-ready 2>/dev/null; echo $?)" "1"
jq '.next = 0 | .tries = 0' "$STATE/auto.json" > "$STATE/auto.json.t" && mv "$STATE/auto.json.t" "$STATE/auto.json"
bash "$SWITCH" --auto 2> "$TMP/sw.err"
chk "自动切换看到核验没完成：重新切换、核验、写验收记录 → enforced" "$(state_of)/$([ -s "$STATE/accepted.json" ] && echo 有)" "enforced/有"
systemctl --user restart cavil-loop-public-assets.service
chk "服务自己重启过（进程换了）：旧验收记录不算数，strict-unverified，发布命令不发图" "$(state_of)/$(bash "$PUBLISH" --project acme --check-ready 2>/dev/null; echo $?)" "strict-unverified/1"
sw >/dev/null 2>&1
chk "（重新切换后 enforced）" "$(state_of)" "enforced"

echo "④ 核验期间服务换了进程"
REALCURL="$(PATH="$REAL_PATH" command -v curl)"
cat > "$TMP/bin/curl" <<SH
#!/usr/bin/env bash
# 透传给真 curl；FAKE_RESTART_ON_VERIFY=1 时，在第 2 次请求「带假令牌的核验图」之后重启服务（核验的最后一个请求）
"$REALCURL" "\$@"; rc=\$?
if [ "\${FAKE_RESTART_ON_VERIFY:-0}" = 1 ] && printf '%s' "\$*" | grep -q 'cavil-verify-secret'; then
    n=\$(( \$(cat "$TMP/verify-hits" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "$TMP/verify-hits"
    [ "\$n" = 2 ] && systemctl --user restart cavil-loop-public-assets.service >/dev/null 2>&1
fi
exit \$rc
SH
chmod +x "$TMP/bin/curl"
rm -f "$STATE/accepted.json" "$TMP/verify-hits"
pid_before="$(cat "$TMP/svc.pid")"
FAKE_RESTART_ON_VERIFY=1 sw; rc=$?
chk "核验的四项都过了、但最后一刻服务重启：切换不算成功（退出码 1），不写验收记录，不退回" \
    "$rc/$(grep -c '核验期间服务换了进程' "$TMP/sw.err")/$([ -e "$STATE/accepted.json" ] && echo 写了 || echo 没写)/$(grep -c '^PUBLIC_ASSETS_STRICT=1$' "$CONF")" "1/2/没写/1"
chk "新进程保持「严格模式在跑、核验没完成」，发布命令不发图" "$(state_of)/$(bash "$PUBLISH" --project acme --check-ready 2>/dev/null; echo $?)" "strict-unverified/1"
# 写验收记录那一步自己也比身份：拿换进程前的身份去写，被拒
old_id="$(jq -r '"\(.pid) \(.start) \(.code) \(.legacy_sha)"' "$STATE/status.json")"
systemctl --user restart cavil-loop-public-assets.service
node "$REPO_DIR/scripts/public-assets/strict.mjs" accept "$STATE/status.json" $old_id 2> "$TMP/acc.err"; rc=$?
chk "写验收记录时状态文件已是另一个进程：拒绝写（退出码 1），说了原因" "$rc/$(grep -c '核验期间服务换了进程' "$TMP/acc.err")/$([ -e "$STATE/accepted.json" ] && echo 写了 || echo 没写)" "1/1/没写"
sw >/dev/null 2>&1
chk "（没有干扰时重新切换：enforced）" "$(state_of)" "enforced"

echo "⑤ 发布命令"
pub() { bash "$PUBLISH" "$@" 2> "$TMP/pub.err"; }
png "$TMP/a b#c.png"
url="$(pub --project acme --item 12 "$TMP/a b#c.png")"; rc=$?
chk "发布成功：地址在 <出图地址>/acme/12/ 下，文件名只剩安全字符并带唯一戳" "$rc/$(printf '%s' "$url" | grep -cE "^$B/acme/12/a-b-c-rev-[0-9]+\.png$")" "0/1"
chk "公网（本机回环）拿得到，字节一样" "$(curl -s "$url" | cmp -s - "$TMP/a b#c.png" && echo same)" "same"
chk "没留下隐藏的临时文件" "$(find "$ROOT/acme" -name '.publish*' | wc -l | tr -d ' ')" "0"
secret_png "$TMP/publeak.png"
url="$(pub --project acme --item 12 "$TMP/publeak.png")"; rc=$?
chk "含凭证样式：拒绝，目录里不留文件，信息里没有值" "$rc/$(find "$ROOT/acme" -name 'publeak*' | wc -l | tr -d ' ')/$(grep -c "$FAKE_SECRET" "$TMP/pub.err")" "1/0/0"
png "$TMP/delivery-wk-20261123-1234567.png"
url="$(pub --project acme --weekly-report --keep-name "$TMP/delivery-wk-20261123-1234567.png")"; rc=$?
chk "周报：保留文件名，落在 acme/weekly-report/" "$rc/$url" "0/$B/acme/weekly-report/delivery-wk-20261123-1234567.png"
url="$(pub --project acme --weekly-report --keep-name "$TMP/delivery-wk-20261123-1234567.png")"; rc=$?
chk "同名已存在：拒绝，不覆盖" "$rc/$(grep -c '不覆盖' "$TMP/pub.err")" "1/1"
url="$(bash "$REPO_DIR/scripts/weekly-report/publish-asset.sh" acme "$TMP/a b#c.png" 12 2>/dev/null)"; rc=$?
chk "早期写法（经旧路径转发）：照样发到 acme/12/" "$rc/$(printf '%s' "$url" | grep -cE "^$B/acme/12/a-b-c-rev-[0-9]+\.png$")" "0/1"
chk "条目编号 0 留给核验，不许发；不是数字也不许" "$(pub --project acme --item 0 "$TMP/a b#c.png"; echo $?)/$(pub --project acme --item x "$TMP/a b#c.png"; echo $?)" "2/2"
# 出图地址指错（交出的不是写入的目录）：核对不过，删掉自己刚放的文件
sed -i "s|^WEEKLY_REPORT_ASSET_ROOT_URL=.*|WEEKLY_REPORT_ASSET_ROOT_URL=\"http://127.0.0.1:$PORT/review-assets/wrong\"|" "$HOME/.config/cavil-loop/919.club.conf"
n0="$(find "$ROOT/919.club" -type f | wc -l)"
url="$(pub --project 919.club --item 5 "$TMP/a b#c.png")"; rc=$?
chk "出图地址和服务目录对不上：报错，删掉了刚放的文件" "$rc/$(grep -c '公网核对没过' "$TMP/pub.err")/$(( $(find "$ROOT/919.club" -type f | wc -l) - n0 ))" "1/1/0"
sed -i "s|^WEEKLY_REPORT_ASSET_ROOT_URL=.*|WEEKLY_REPORT_ASSET_ROOT_URL=\"$B\"|" "$HOME/.config/cavil-loop/919.club.conf"
# 服务端拦截没生效：拒绝（三种：严格模式关 / 状态文件坏 / 记录的进程不在）
sed -i '/^PUBLIC_ASSETS_STRICT=/d' "$CONF"; systemctl --user restart cavil-loop-public-assets.service
pub --project acme --item 12 "$TMP/a b#c.png" >/dev/null; r1=$?
sw >/dev/null 2>&1
cp "$STATE/status.json" "$TMP/status.good"; printf '{' > "$STATE/status.json"
pub --project acme --item 12 "$TMP/a b#c.png" >/dev/null; r2=$?
jq '.pid = 999999999' "$TMP/status.good" > "$STATE/status.json"
pub --project acme --item 12 "$TMP/a b#c.png" >/dev/null; r3=$?
cp "$TMP/status.good" "$STATE/status.json"
chk "严格模式关 / 状态文件坏 / 记录的进程不在：都拒绝" "$r1/$r2/$r3" "1/1/1"
chk "--check-ready：生效时 0" "$(pub --project acme --check-ready; echo $?)" "0"
before="$(find "$ROOT" -printf '%P %s %T@\n' | sort)"
u="$(bash "$REPO_DIR/scripts/public-assets/usage.sh" 2>&1)"; rc=$?
chk "占用统计：列出 acme 和 acme/12、旧结构单列一行" "$rc/$(printf '%s\n' "$u" | grep -cE '^acme +[0-9]+$')/$(printf '%s\n' "$u" | grep -cE '^  acme/12 +[0-9]+$')/$(printf '%s\n' "$u" | grep -c '^旧结构（未归属项目）')" "0/1/1/1"
chk "占用统计不改资产目录里的任何东西" "$( [ "$before" = "$(find "$ROOT" -printf '%P %s %T@\n' | sort)" ] && echo same)" "same"

echo "⑥ 派工提示词"
DSB="$TMP/dispatch"; mkdir -p "$DSB/bin" "$DSB/home"
git init -q --bare "$DSB/upstream.git"; git clone -q "$DSB/upstream.git" "$DSB/seed" 2>/dev/null
( cd "$DSB/seed" && echo x > f && git add f && git commit -qm init && git push -q origin main ) 2>/dev/null
cat > "$DSB/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
    *"--jq .title"*|*title*) echo "测试标题" ;;
    *) echo "{}" ;;
esac
exit 0
SH
# 假 tmux：派工不会真起会话
cat > "$DSB/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; esac
exit 0
SH
chmod +x "$DSB/bin/gh" "$DSB/bin/tmux"
N7=$((900000000 + ($$ % 1000000) * 3)); N8=$((N7 + 1)); N9=$((N7 + 2))
render() {   # <出图地址> <是否登记 key 1/0> <输出>
    local url="$1" reg="$2" out="$3" w="$DSB/w-$RANDOM"
    mkdir -p "$w/state" "$w/wt"; git clone -q "$DSB/upstream.git" "$w/project" 2>/dev/null
    cat > "$w/config" <<CONF
REPO="example/none"
PROJECT_ROOT="$w/project"
WORKTREE_BASE="$w/wt"
STATE_DIR="$w/state"
TMUX_PREFIX="pas"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
WORKER_AGENT_DEFAULT="claude"
WEEKLY_REPORT_ASSET_ROOT_URL="$url"
PATH="$DSB/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    rm -rf "$DSB/home/.config"; mkdir -p "$DSB/home/.config/cavil-loop"
    [ "$reg" = 1 ] && printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$w/project" "$w/config" > "$DSB/home/.config/cavil-loop/demo.conf"
    prompt_files_clear "$REPO_DIR" "$w/state"
    (cd "$w/project" && env -u CODING_AGENT_RELEASE_ROOT -u WEEKLY_REPORT_ASSET_ROOT_URL HOME="$DSB/home" CODING_AGENT_CONFIG="$w/config" \
        bash "$REPO_DIR/scripts/dispatch-new-issue.sh" "$N7") >/dev/null 2>&1
    cp "$(prompt_file_of "$REPO_DIR" "$w/state" new "$N7")" "$out" 2>/dev/null || : > "$out"
    (cd "$w/project" && env -u CODING_AGENT_RELEASE_ROOT -u WEEKLY_REPORT_ASSET_ROOT_URL HOME="$DSB/home" CODING_AGENT_CONFIG="$w/config" \
        bash "$REPO_DIR/scripts/dispatch-issue-comment.sh" "$N8" 0) >/dev/null 2>&1
    cp "$(prompt_file_of "$REPO_DIR" "$w/state" cmt "$N8" 0)" "$out.cmt" 2>/dev/null || : > "$out.cmt"
    (cd "$w/project" && env -u CODING_AGENT_RELEASE_ROOT -u WEEKLY_REPORT_ASSET_ROOT_URL HOME="$DSB/home" CODING_AGENT_CONFIG="$w/config" \
        bash "$REPO_DIR/scripts/dispatch-pr-comment.sh" "$N9" "feature/issue-$N9" 0) >/dev/null 2>&1
    cp "$(prompt_file_of "$REPO_DIR" "$w/state" pr "$N9")" "$out.pr" 2>/dev/null || : > "$out.pr"
}
render "https://assets.example.invalid/review-assets" 1 "$TMP/p-reg.md"
render "https://assets.example.invalid/review-assets" 0 "$TMP/p-noreg.md"
render "" 1 "$TMP/p-none.md"
chk "三种情况都写出了 prompt" "$([ -s "$TMP/p-reg.md" ] && [ -s "$TMP/p-noreg.md" ] && [ -s "$TMP/p-none.md" ] && echo yes)" "yes"
chk "配了地址、找得到 key：两条都换成了带本项目 key 和本条编号的发布命令" \
    "$(grep -c -- "--project 'demo' --item $N7" "$TMP/p-reg.md")/$(grep -c '^- \*\*怎么出图\*\*：' "$TMP/p-reg.md")/$(grep -c '^- \*\*评论配图标准' "$TMP/p-reg.md")" "2/1/1"
for k in cmt:$N8 pr:$N9; do
    f="$TMP/p-reg.md.${k%%:*}"; n="${k#*:}"
    chk "配了地址、找得到 key（${k%%:*} 入口）：两条都换成带本条编号的发布命令，旧说法不再出现" \
        "$(grep -c -- "--project 'demo' --item $n" "$f")/$(grep -cE 'public-assets/check\.mjs|curl -skI|放进截图目录' "$f")" "2/0"
    f="$TMP/p-none.md.${k%%:*}"
    chk "没配地址（${k%%:*} 入口）：讲出图的两条和模板原文一字不差，没有发布命令" \
        "$(grep -cF -- "$(grep '^- \*\*评论配图标准' "$REPO_DIR/prompts/new-issue.template.md")" "$f")/$(grep -c 'publish-asset.sh' "$f")" "1/0"
done
chk "配了地址：旧说法（跑自查脚本、curl 核对、放进截图目录）不再出现" \
    "$(grep -cE 'public-assets/check\.mjs|curl -skI|放进截图目录' "$TMP/p-reg.md")" "0"
chk "配了地址、找不到 key：写明发不了图，不给任何命令" \
    "$(grep -c '发不了图' "$TMP/p-noreg.md" | awk '{print ($1>0)?"有":"无"}')/$(grep -c 'publish-asset.sh' "$TMP/p-noreg.md")" "有/0"
base_tpl="$REPO_DIR/prompts/new-issue.template.md"
chk "没配地址：讲出图的两条和模板原文一字不差，没有发布命令" \
    "$(grep -F -- "$(grep '^- \*\*怎么出图\*\*' "$base_tpl")" "$TMP/p-none.md" | wc -l | tr -d ' ')/$(grep -cF -- "$(grep '^- \*\*评论配图标准' "$base_tpl")" "$TMP/p-none.md")/$(grep -c 'publish-asset.sh' "$TMP/p-none.md")" "1/1/0"
chk "配了地址时其余部分和没配时只差这两条和出图地址那一行" \
    "$(diff <(grep -vE '^- \*\*(怎么出图|评论配图标准)|本项目的公网出图地址|^TASK_START|开始时间' "$TMP/p-reg.md") <(grep -vE '^- \*\*(怎么出图|评论配图标准)|本项目的公网出图地址|^TASK_START|开始时间' "$TMP/p-none.md") | grep -c '^[<>]' | awk '{print ($1<=4)?"ok":$1}')" "ok"

echo "⑦ 周报 run.sh"
WR="$TMP/wr"; mkdir -p "$WR/bin" "$WR/vector"
git init -q --bare "$WR/origin.git"; git init -q "$WR/src"; git -C "$WR/src" remote add origin "$WR/origin.git"
echo x > "$WR/src/f"; git -C "$WR/src" add f
GIT_AUTHOR_DATE="2025-01-06T12:00:00+08:00" GIT_COMMITTER_DATE="2025-01-06T12:00:00+08:00" git -C "$WR/src" commit -qm init
git -C "$WR/src" push -q origin main
cat >> "$HOME/.config/cavil-loop/acme.conf" <<EOF
PROJECT_ROOT=$WR/src
WEEKLY_REPORT_REPO=acme/p
WEEKLY_REPORT_VECTOR_DIR=$WR/vector
EOF
printf '#!/usr/bin/env bash\necho "[]"\n' > "$WR/bin/gh"
# 假 node：只替换截图（出一张合法 PNG），其余照常交给真 node
cat > "$WR/bin/node" <<SH
#!/usr/bin/env bash
case "\$1" in */shot.mjs) printf '\x89PNG\r\n\x1a\n%s' "\$RANDOM\$4" > "\$4" ;; *) exec "$(command -v node)" "\$@" ;; esac
SH
chmod +x "$WR/bin/"*
wr() { ( cd "$WR" && env CLAUDE_PROJECTS_DIR="$TMP/nc" CODEX_SESSIONS_DIR="$TMP/nx" XDG_CACHE_HOME="$TMP/xc" TZ=Asia/Shanghai PATH="$WR/bin:$TMP/bin:$REAL_PATH" \
    bash "$REPO_DIR/scripts/weekly-report/run.sh" acme --dry-run --week-of 2025-02-03 ) > "$WR/out" 2>&1; }
mkdir -p "$TMP/nc" "$TMP/nx" "$TMP/xc"
wr; rc=$?
rev="$(ls "$ROOT/acme/weekly-report" 2>/dev/null | sed -nE 's/^delivery-(wk-[0-9]+-[0-9]+)\.png$/\1/p' | head -1)"
chk "发布模式：run.sh 成功，四张图经发布命令落在 acme/weekly-report/" "$rc/$(for n in delivery effort cost token; do [ -s "$ROOT/acme/weekly-report/$n-$rev.png" ] && printf y; done)" "0/yyyy"
chk "报告里的图链就是发布命令返回的地址" "$(grep -oE "$B/acme/weekly-report/(delivery|effort|cost|token)-$rev\.png" "$HOME/weekly-report-dryrun.md" 2>/dev/null | sort -u | wc -l | tr -d ' ')" "4"
chk "矢量版同名同戳留在本机矢量版目录（PDF 按图链文件名找得到）" "$(for n in delivery effort cost token; do [ -s "$WR/vector/$n-$rev.chart.html" ] && printf y; done)" "yyyy"
sed -i '/^PUBLIC_ASSETS_STRICT=/d' "$CONF"; systemctl --user restart cavil-loop-public-assets.service
rm -f "$HOME/weekly-report-dryrun.md"
wr; rc=$?
chk "服务端拦截没生效：出图之前就停（退出码 1、没截图、没出报告）" "$rc/$(grep -c '== 2/4 出图' "$WR/out")/$([ -e "$HOME/weekly-report-dryrun.md" ] && echo 出了 || echo 没出)" "1/0/没出"
# 升级链路：项目只配了早期的周报图片地址（自定义公网路径），没配出图地址
AC="$HOME/.config/cavil-loop/acme.conf"
sed -i '/^WEEKLY_REPORT_ASSET_ROOT_URL=/d' "$AC"
printf 'WEEKLY_REPORT_ASSET_URL=%s/custom-wr\nWEEKLY_REPORT_ASSET_DIR=%s/custom-wr\n' "$B" "$ROOT" >> "$AC"
rm -f "$HOME/weekly-report-dryrun.md"
wr; rc=$?
chk "老规则下、只有自定义的旧周报地址：周报照旧出（图在旧目录、图链是旧地址、公网能打开）" \
    "$rc/$(grep -oE "$B/custom-wr/delivery-wk-[0-9]+-[0-9]+\.png" "$HOME/weekly-report-dryrun.md" 2>/dev/null | sort -u | wc -l | tr -d ' ')/$(code "$(grep -oE "$B/custom-wr/delivery-wk-[0-9]+-[0-9]+\.png" "$HOME/weekly-report-dryrun.md" | head -1)")" "0/1/200"
cp "$CONF" "$TMP/conf.pre"
sw; rc=$?
chk "有这样的项目：切换命令不切换、点名它、配置一字没动，服务仍是老规则" \
    "$rc/$(grep -c "$AC" "$TMP/sw.err")/$(cmp -s "$CONF" "$TMP/conf.pre" && echo 没动)/$(state_of)" "1/1/没动/not-enforced"
jq '.next = 0 | .tries = 0' "$STATE/auto.json" > "$STATE/auto.json.t" && mv "$STATE/auto.json.t" "$STATE/auto.json"
bash "$SWITCH" --auto 2> "$TMP/sw.err"
chk "自动切换同样不切换（周报不会被自动切换停掉）" "$(state_of)/$(grep -c "$AC" "$TMP/sw.err")" "not-enforced/1"
rm -f "$HOME/weekly-report-dryrun.md"; wr; rc=$?
chk "没切换：周报照常出" "$rc" "0"
# 出图地址写成空值（合法的 bash 写法）或者先写后被覆盖成空：加载后都是空，和周报看到的一致
for v in "''" '""' "\"$B\"\nWEEKLY_REPORT_ASSET_ROOT_URL=''"; do
    cp "$AC" "$TMP/ac.pre"; printf "WEEKLY_REPORT_ASSET_ROOT_URL=$v\n" >> "$AC"
    rm -f "$HOME/weekly-report-dryrun.md"; wr; wrc=$?
    sw; rc=$?
    jq '.next = 0 | .tries = 0' "$STATE/auto.json" > "$STATE/auto.json.t" && mv "$STATE/auto.json.t" "$STATE/auto.json"
    bash "$SWITCH" --auto 2> "$TMP/auto.err"
    chk "出图地址加载后为空（写法：$(printf "$v" | tr '\n' ' ')）：周报照旧路出、手动和自动切换都拒绝" \
        "$wrc/$rc/$(grep -c "$AC" "$TMP/sw.err")/$(grep -c "$AC" "$TMP/auto.err")/$(state_of)" "0/1/1/1/not-enforced"
    cp "$TMP/ac.pre" "$AC"
done
printf 'WEEKLY_REPORT_ASSET_ROOT_URL="%s"\nWEEKLY_REPORT_ASSET_ROOT_URL=""\nWEEKLY_REPORT_ASSET_ROOT_URL="%s"\n' "$B" "$B" > "$TMP/multi.conf"
cp "$AC" "$TMP/ac.pre"; cat "$TMP/multi.conf" >> "$AC"
chk "同一键写了几次、最后一次非空：按加载结果算出图地址已配（不点名这个项目）" \
    "$(bash -c 'source "$1/scripts/weekly-report/_asset_mode.sh"; weekly_asset_mode_of_conf "$2"' _ "$REPO_DIR" "$AC")" "publish"
cp "$TMP/ac.pre" "$AC"
printf 'WEEKLY_REPORT_ASSET_ROOT_URL="unterminated\n' > "$TMP/broken.conf"
chk "配置读不出：判断结果是「读不出」（切换命令据此不切换）" \
    "$(bash -c 'source "$1/scripts/weekly-report/_asset_mode.sh"; weekly_asset_mode_of_conf "$2"' _ "$REPO_DIR" "$TMP/broken.conf")" "unreadable"
printf 'WEEKLY_REPORT_ASSET_ROOT_URL="%s"\n' "$B" >> "$AC"
sw; rc=$?
chk "按提示补上出图地址：切换成功" "$rc/$(state_of)" "0/enforced"
rm -f "$HOME/weekly-report-dryrun.md"; wr; rc=$?
chk "补上之后：周报走发布命令，图链在 acme/weekly-report/ 下" "$rc/$(grep -cE "$B/acme/weekly-report/delivery-wk-" "$HOME/weekly-report-dryrun.md" 2>/dev/null)" "0/1"
sed -i '/^WEEKLY_REPORT_ASSET_ROOT_URL=/d' "$AC"
wr; rc=$?
chk "切换之后又删掉出图地址：出图之前停下，说明要加出图地址那一行" "$rc/$(grep -c 'WEEKLY_REPORT_ASSET_ROOT_URL=' "$WR/out")/$(grep -c '== 2/4 出图' "$WR/out")" "1/1/0"

echo "⑧ 同一组配置走过切换、自动切换、核验、发布和周报"
C9="$HOME/.config/cavil-loop/919.club.conf"
cp "$C9" "$TMP/c9.pre"; cp "$AC" "$TMP/ac.pre"
sed -i '/^WEEKLY_REPORT_ASSET_ROOT_URL=/d' "$C9" "$AC"
printf "WEEKLY_REPORT_ASSET_ROOT_URL='%s'\n" "$B" >> "$AC"     # 合法的单引号写法，且是唯一配了公网地址的项目
sed -i '/^PUBLIC_ASSETS_STRICT=/d' "$CONF"; systemctl --user restart cavil-loop-public-assets.service
sw; rc=$?
chk "单引号的出图地址：手动切换成功，核验用的是加载后的地址（两个地址各四项全 ✓）" "$rc/$(state_of)/$(grep -c '  ✓ ' "$TMP/sw.err")/$(grep -c "  ✓ $B/" "$TMP/sw.err")/$(grep -c '  ✗ ' "$TMP/sw.err")" "0/enforced/8/8/0"
sed -i '/^PUBLIC_ASSETS_STRICT=/d' "$CONF"; systemctl --user restart cavil-loop-public-assets.service
jq '.next = 0 | .tries = 0' "$STATE/auto.json" > "$STATE/auto.json.t" && mv "$STATE/auto.json.t" "$STATE/auto.json"
bash "$SWITCH" --auto 2> "$TMP/auto.err"
chk "单引号的出图地址：自动切换也成功" "$(state_of)/$(grep -c '  ✗ ' "$TMP/auto.err")" "enforced/0"
url="$(bash "$PUBLISH" --project acme --item 12 "$TMP/a b#c.png" 2>/dev/null)"; rc=$?
chk "单引号的出图地址：发布命令发出的地址就是加载后的地址" "$rc/$(printf '%s' "$url" | grep -cE "^$B/acme/12/")" "0/1"
rm -f "$HOME/weekly-report-dryrun.md"; wr; rc=$?
chk "单引号的出图地址：周报走发布命令，图链在加载后的地址下" "$rc/$(grep -cE "$B/acme/weekly-report/delivery-wk-" "$HOME/weekly-report-dryrun.md" 2>/dev/null)" "0/1"
# 读不出的项目配置：项目清单就读不出，所有入口都当「判断不了」
sed -i '/^PUBLIC_ASSETS_STRICT=/d' "$CONF"; systemctl --user restart cavil-loop-public-assets.service
chmod 000 "$C9"
sw; rc=$?
chk "有项目配置读不出：手动切换不切换，说了读不出，配置没写严格模式" "$rc/$(grep -c '读不出' "$TMP/sw.err" | awk '{print ($1>0)?"有":"无"}')/$(grep -c '^PUBLIC_ASSETS_STRICT=' "$CONF")/$(state_of)" "1/有/0/not-enforced"
jq '.next = 0 | .tries = 0' "$STATE/auto.json" > "$STATE/auto.json.t" && mv "$STATE/auto.json.t" "$STATE/auto.json"
bash "$SWITCH" --auto 2> "$TMP/auto.err"
chk "有项目配置读不出：自动切换也不切换" "$(state_of)/$(grep -c '读不出' "$TMP/auto.err" | awk '{print ($1>0)?"有":"无"}')" "not-enforced/有"
chk "有项目配置读不出：核验命令也不核验（服务没在严格模式之外，项目清单读不出同样拒绝）" "$(bash "$SWITCH" --verify 2>/dev/null; echo $?)" "1"
chmod 644 "$C9"
# 严格模式运行中有项目配置读不出：旧图（只看旧图清单）照常交出，项目子目录的图和清单外的新文件不交出
cp "$TMP/c9.pre" "$C9"; cp "$TMP/ac.pre" "$AC"; printf 'WEEKLY_REPORT_ASSET_ROOT_URL="%s"\n' "$B" >> "$AC"
sw >/dev/null 2>&1
png "$ROOT/issue-464/new-while-unreadable.png"
chmod 000 "$C9"
systemctl --user restart cavil-loop-public-assets.service   # 新进程第一次请求就重读项目清单（不等缓存过期）
chk "严格模式运行中有项目配置读不出：清单里的旧图仍 200，项目子目录的图 404，清单外新放的文件 404" \
    "$(code "$B/issue-464/old-b.png")/$(code "$B/acme/12/at.png")/$(code "$B/issue-464/new-while-unreadable.png")" "200/404/404"
cp "$ROOT/issue-464/old-b.png" "$TMP/oldb.keep"; png "$ROOT/issue-464/old-b.png"
chk "同时旧图内容被换掉：仍按清单核对，404" "$(code "$B/issue-464/old-b.png")" "404"
cp "$TMP/oldb.keep" "$ROOT/issue-464/old-b.png"
chmod 644 "$C9"
systemctl --user restart cavil-loop-public-assets.service
chk "配置恢复可读后：旧图 200、项目子目录的图 200、清单外新文件仍 404" \
    "$(code "$B/issue-464/old-b.png")/$(code "$B/acme/12/at.png")/$(code "$B/issue-464/new-while-unreadable.png")" "200/200/404"
cp "$TMP/c9.pre" "$C9"; cp "$TMP/ac.pre" "$AC"
printf 'WEEKLY_REPORT_ASSET_ROOT_URL="%s"\n' "$B" >> "$AC"
sw; rc=$?
chk "（配置恢复后切换成功）" "$rc/$(state_of)" "0/enforced"

echo "⑨ 同一个文件身份挂在几个路径上（硬链接）：每个路径按自己的规则判，和缓存冷热、请求先后无关"
# 项目子目录下一张合法 PNG（不在旧图清单里），再把清单里的旧图位置和一个 .gif 名字都硬链接到它：
# 三个路径是同一个文件身份。旧图位置的清单条目记的是原内容，所以那里必须 404；.gif 名字格式不对，404。
cp -a "$ROOT/issue-464/old-a.png" "$TMP/olda.keep"
png "$ROOT/acme/12/hl.png"
ln -f "$ROOT/acme/12/hl.png" "$ROOT/issue-464/old-a.png"
ln -f "$ROOT/acme/12/hl.png" "$ROOT/acme/12/hl.gif"
hl_round() { local r="" p; for p in "$@"; do r="$r $p=$(code "$B/$p")"; done; echo "$r"; }
want=" acme/12/hl.png=200 issue-464/old-a.png=404 acme/12/hl.gif=404"
for order in "acme/12/hl.png issue-464/old-a.png acme/12/hl.gif" "issue-464/old-a.png acme/12/hl.gif acme/12/hl.png" "acme/12/hl.gif acme/12/hl.png issue-464/old-a.png"; do
    systemctl --user restart cavil-loop-public-assets.service   # 新进程 = 冷缓存
    # shellcheck disable=SC2086
    first="$(hl_round $order)"; second="$(hl_round $order)"
    got=""; for p in acme/12/hl.png issue-464/old-a.png acme/12/hl.gif; do got="$got $p=$(code "$B/$p")"; done
    chk "请求顺序「$order」：冷缓存第一轮、热缓存第二轮、再按固定顺序一轮，各路径结论一致" \
        "$(printf '%s\n' $first | sort | tr '\n' ' ')|$(printf '%s\n' $second | sort | tr '\n' ' ')|$got" \
        "$(printf '%s\n' $want | sort | tr '\n' ' ')|$(printf '%s\n' $want | sort | tr '\n' ' ')|$want"
done
# 反过来：旧图位置放回原内容，项目子目录的名字硬链接到它（同一身份，一个是清单条目、一个是项目路径）：两处都 200
rm -f "$ROOT/acme/12/hl.gif"; cp -a "$TMP/olda.keep" "$ROOT/issue-464/old-a.png"; ln -f "$ROOT/issue-464/old-a.png" "$ROOT/acme/12/hl.png"
systemctl --user restart cavil-loop-public-assets.service
chk "旧图和项目子目录同一身份、内容和清单相符：两处都 200（先旧图后项目）" "$(code "$B/issue-464/old-a.png")/$(code "$B/acme/12/hl.png")" "200/200"
systemctl --user restart cavil-loop-public-assets.service
chk "同上，先项目后旧图" "$(code "$B/acme/12/hl.png")/$(code "$B/issue-464/old-a.png")" "200/200"
# 未登记的项目路径硬链接到同一身份：缓存里有这份内容，也仍 404
mkdir -p "$ROOT/nobody/4"; ln -f "$ROOT/issue-464/old-a.png" "$ROOT/nobody/4/hl.png"
chk "未登记的路径挂在已缓存的同一身份上：仍 404" "$(code "$B/acme/12/hl.png")/$(code "$B/nobody/4/hl.png")" "200/404"
rm -f "$ROOT/acme/12/hl.png" "$ROOT/nobody/4/hl.png"

echo "⑩ 服务配了非默认的路径前缀：切换核验、发布都按服务报告的前缀和端口走"
cp "$CONF" "$TMP/conf.pre10"; cp "$AC" "$TMP/ac.pre10"; cp "$C9" "$TMP/c9.pre10"
printf 'PUBLIC_ASSETS_PREFIX=/team-assets/\n' >> "$CONF"
for f in "$AC" "$C9"; do sed -i "s|^WEEKLY_REPORT_ASSET_ROOT_URL=.*|WEEKLY_REPORT_ASSET_ROOT_URL=\"http://127.0.0.1:$PORT/team-assets\"|" "$f"; done
T="http://127.0.0.1:$PORT/team-assets"
sw; rc=$?
chk "自定义前缀：切换成功、拦截生效，状态里记的是实际前缀和端口" \
    "$rc/$(state_of)/$(node "$REPO_DIR/scripts/public-assets/strict.mjs" status-check "$STATE/status.json" | jq -r '.prefix + " " + (.port|tostring)')" \
    "0/enforced//team-assets/ $PORT"
chk "核验请求的是自定义前缀下的地址（没有去请求默认前缀）" \
    "$(grep -c "127.0.0.1:$PORT/team-assets/" "$TMP/sw.err" | awk '{print ($1>0)?"有":"无"}')/$(grep -c "127.0.0.1:$PORT/review-assets/" "$TMP/sw.err")" "有/0"
png "$TMP/team.png"
url="$(pub --project acme --item 12 "$TMP/team.png")"; rc=$?
chk "自定义前缀下发布：地址在新前缀下，公网（本机回环）200 且字节一样" \
    "$rc/$(printf '%s' "$url" | grep -cE "^$T/acme/12/team-rev-[0-9]+\.png$")/$(curl -s "$url" | cmp -s - "$TMP/team.png" && echo same)" "0/1/same"
chk "默认前缀下同一张图：404（服务不认没配的前缀）" "$(code "$B/acme/12/$(basename "$url")")" "404"
# 状态文件缺了前缀 / 端口：判断不了，核验和发布都不做（不猜默认值）
cp "$STATE/status.json" "$TMP/status.keep"
jq -c 'del(.prefix)' "$TMP/status.keep" > "$STATE/status.json"
chk "状态文件缺路径前缀：状态未知，核验拒绝，发布拒绝" \
    "$(state_of)/$(bash "$SWITCH" --verify >/dev/null 2>&1; echo $?)/$(pub --project acme --item 12 "$TMP/team.png" >/dev/null; echo $?)" "unknown/1/1"
jq -c 'del(.port)' "$TMP/status.keep" > "$STATE/status.json"
chk "状态文件缺监听端口：同样状态未知" "$(state_of)" "unknown"
cp "$TMP/status.keep" "$STATE/status.json"
cp "$TMP/conf.pre10" "$CONF"; cp "$TMP/ac.pre10" "$AC"; cp "$TMP/c9.pre10" "$C9"
sw; rc=$?
chk "（改回默认前缀后再切换：成功，默认前缀下的图 200）" "$rc/$(state_of)/$(code "$B/issue-464/old-b.png")" "0/enforced/200"

echo
echo "结果：$pass 通过，$fail 失败"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
