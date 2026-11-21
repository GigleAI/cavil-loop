#!/usr/bin/env bash
# 把公网资产目录的对外服务切到严格模式（GitHub#613），以及查看 / 核验它。
#
#   bash switch.sh --status   只读：配置、服务、状态、代码是否一致、旧图清单、自动切换开关；不写任何东西
#   bash switch.sh --verify   核验：放几个测试文件，经本机端口（和配了地址时的公网地址）查一遍，再删掉；不改配置
#   bash switch.sh            执行切换：备份配置 → 建 / 核对旧图清单 → 写严格模式 → 重启 → 核验；失败自动退回
#   bash switch.sh --auto     给 daemon 每轮调用：服务没在严格模式、或在跑的代码和磁盘上的不一样时才切换，
#                             失败按 1、5、15、60 分钟退避，每个代码版本最多 5 次；配置里 PUBLIC_ASSETS_AUTO_SWITCH=0 关掉
#
# 唯一的可信状态是服务配置里的 PUBLIC_ASSETS_LEGACY_SHA=<旧图清单的 SHA-256> 这一行：有它 = 清单已生效、
# 以它为准、永不重建；没有它 = 从未生效、可以（重新）建。严格模式那一行只在它之后写。
# 退出码：0 成功 / 无事可做；1 没切成（已退回）或核验不过；2 用法；3 退回也失败（照打印的手工步骤做）。
set -euo pipefail

HERE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=../_names.sh
source "$HERE/../_names.sh"
STRICT="$HERE/strict.mjs"
CONF="${PUBLIC_ASSETS_CONF:-$(cavil_public_assets_conf)}"
STATE_DIR="$CAVIL_PUBLIC_ASSETS_STATE"
STATUS_FILE="${PUBLIC_ASSETS_STATUS:-$(cavil_public_assets_status)}"
LISTS="${PUBLIC_ASSETS_LEGACY_LISTS:-$(cavil_public_assets_lists)}"
LIST1="${LISTS%%:*}"; LIST2="${LISTS#*:}"
PROJECT_DIRS="${PUBLIC_ASSETS_PROJECT_DIRS:-$(cavil_public_assets_project_dirs)}"
UNIT="cavil-loop-public-assets.service"
# 单元的 ExecStart 跑的是稳定技能入口下的这几个文件；比代码看的是它们
CODE_DIR="${PUBLIC_ASSETS_CODE_DIR:-$(cavil_skill_link)/scripts/public-assets}"
NODE="${PUBLIC_ASSETS_NODE_BIN:-node}"

MODE=apply
case "${1:-}" in
    "") ;;
    --status) MODE=status ;;
    --verify) MODE=verify ;;
    --auto) MODE=auto ;;
    *) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

say() { printf '%s\n' "$*" >&2; }
note() {   # 记进本机日志（状态目录里的 switch.log），同时打到 stderr
    say "$*"
    { mkdir -p "$STATE_DIR" && printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$STATE_DIR/switch.log"; } 2>/dev/null || true
}
# 配置文件里某一项的值（最后一行为准，去掉成对的引号）；没有这一行时输出空、返回 1
conf_get() {
    local line
    line="$(grep -E "^$1=" "$CONF" 2>/dev/null | tail -n 1)" || return 1
    line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
    printf '%s' "$line"
}
# 调 systemctl 时不把切换锁传下去：被它拉起的进程（或测试里的假 systemctl 起的服务）不该拿着这把锁
svc() { if [ -n "${LOCK_FD:-}" ]; then systemctl --user "$@" {LOCK_FD}>&-; else systemctl --user "$@"; fi; }
service_state() {   # active / inactive / failed / unknown（读不到或不认识的回答一律 unknown）
    local s
    s="$(svc is-active "$UNIT" 2>/dev/null)" || true
    case "$s" in active|inactive|failed) printf '%s' "$s" ;; *) printf unknown ;; esac
}
status_json() { "$NODE" "$STRICT" status-check "$STATUS_FILE" 2>/dev/null || printf '{"state":"unknown","reason":"检查命令没跑成"}'; }
jget() { printf '%s' "$1" | jq -r "$2 // \"\"" 2>/dev/null || true; }
disk_code() { "$NODE" "$STRICT" code-id "$CODE_DIR" 2>/dev/null || true; }
list_ok() { [ -f "$1" ] && "$NODE" "$STRICT" verify "$1" "$2"; }
# 旧图清单的状态：none（配置里没有校验值）/ bad-sha / ok / one-bad:<坏的那份> / both-bad
legacy_state() {
    local sha
    sha="$(conf_get PUBLIC_ASSETS_LEGACY_SHA)" || { printf none; return; }
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { printf bad-sha; return; }
    local a=0 b=0
    list_ok "$LIST1" "$sha" && a=1
    list_ok "$LIST2" "$sha" && b=1
    if [ "$a$b" = 11 ]; then printf ok
    elif [ "$a" = 1 ]; then printf 'one-bad:%s' "$LIST2"
    elif [ "$b" = 1 ]; then printf 'one-bad:%s' "$LIST1"
    else printf both-bad; fi
}

cmd_status() {
    local j st code_now
    if [ -f "$CONF" ]; then say "配置文件：$CONF"; else say "配置文件：没有（${CONF}）——这台机器没装对外服务"; fi
    say "服务：$(service_state)"
    j="$(status_json)"; st="$(jget "$j" .state)"
    say "服务端拦截：$st${j:+（$(jget "$j" .reason)）}"
    code_now="$(disk_code)"
    if [ -z "$(jget "$j" .code)" ] || [ -z "$code_now" ]; then say "在跑的代码和磁盘上的：未知"
    elif [ "$(jget "$j" .code)" = "$code_now" ]; then say "在跑的代码和磁盘上的：一致"
    else say "在跑的代码和磁盘上的：不一致（需要重启服务）"; fi
    case "$(legacy_state)" in
        none) say "旧图清单：未生效（配置里没有校验值那一行）" ;;
        bad-sha) say "旧图清单：配置里的校验值那一行格式不对——旧结构一律不交出，需要人处理" ;;
        ok) say "旧图清单：两份都正常" ;;
        one-bad:*) say "旧图清单：一份损坏（$(legacy_state | cut -d: -f2-)），另一份正常；跑一次切换会把好的那份复制回去" ;;
        both-bad) say "旧图清单：两份都丢失或损坏——旧结构一律不交出；从备份找回任一份（校验值对上即可），或由人决定删掉配置里校验值那一行后重建" ;;
    esac
    if [ "$(conf_get PUBLIC_ASSETS_AUTO_SWITCH || true)" = 0 ]; then say "自动切换：关"; else say "自动切换：开"; fi
    printf 'STATE=%s\n' "${st:-unknown}"
}

# ── 核验：在真实目录里放测试文件，看服务给不给 ──
VERIFY_FILES=()
verify_cleanup() {
    local f
    for f in "${VERIFY_FILES[@]}"; do rm -f "$f"; done
    VERIFY_FILES=()
    [ -z "${VERIFY_KEYDIR:-}" ] || { rmdir "$VERIFY_KEYDIR/0" 2>/dev/null || true; rmdir "$VERIFY_KEYDIR" 2>/dev/null || true; }
}
cmd_verify() {
    local j root port prefix key keys stamp pub_url sample ok=1 base bases
    j="$(status_json)"
    case "$(jget "$j" .state)" in
        enforced|strict-unverified) ;;
        *) say "核验：服务没在严格模式（$(jget "$j" .reason)），不核验"; return 1 ;;
    esac
    root="$(jget "$j" .root)"; port="$(jget "$j" .port)"; prefix="$(jget "$j" .prefix)"
    [ -n "$port" ] || port="$(conf_get PUBLIC_ASSETS_PORT || true)"
    [ -n "$prefix" ] || prefix=/review-assets/
    keys="$("$NODE" "$STRICT" keys ${PROJECT_DIRS//:/ } 2>/dev/null)" || { say "核验：读不出登记的项目"; return 1; }
    key="$(printf '%s\n' "$keys" | head -n 1)"
    [ -n "$key" ] || { say "核验：本机没有登记的项目，没法核验项目子目录"; return 1; }
    pub_url=""
    local d f v
    for d in ${PROJECT_DIRS//:/ }; do
        for f in "$d"/*.conf; do
            [ -f "$f" ] || continue
            v="$(grep -E '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$f" | tail -n 1 | sed -E 's/^[^=]*=//; s/^"//; s/"$//')" || true
            [ -n "$v" ] && { pub_url="${v%/}"; break 2; }
        done
    done
    stamp="$(date +%s%N)"
    VERIFY_KEYDIR="$root/$key"
    trap verify_cleanup EXIT
    mkdir -p "$root/$key/0"
    local fresh="cavil-verify-$stamp.png" okf="$key/0/cavil-verify-ok-$stamp.png" badf="$key/0/cavil-verify-secret-$stamp.png"
    printf '\x89PNG\r\n\x1a\n%s' "$stamp" > "$root/$fresh"; VERIFY_FILES+=("$root/$fresh")
    printf '\x89PNG\r\n\x1a\n%s' "$stamp" > "$root/$okf"; VERIFY_FILES+=("$root/$okf")
    # 假令牌：只为撞上凭证样式，运行时拼出来，不是任何真实服务的值
    printf '\x89PNG\r\n\x1a\n{"refresh_''token": "NOT-A-REAL-TOKEN-%s"}' "$stamp" > "$root/$badf"; VERIFY_FILES+=("$root/$badf")
    sample=""
    if [ -f "$LIST1" ]; then
        sample="$(jq -r '.files | keys[]' "$LIST1" 2>/dev/null | while IFS= read -r r; do [ -f "$root/$r" ] && { printf '%s' "$r"; break; }; done)" || sample=""
    fi
    bases="http://127.0.0.1:$port${prefix%/}"
    [ -z "$pub_url" ] && say "核验：没有配了公网地址的项目，只查本机端口" || bases="$bases $pub_url"
    for base in $bases; do
        expect() {   # <相对路径> <期望状态码>
            local got
            got="$(curl -sk -o /dev/null -w '%{http_code}' "$base/$1" 2>/dev/null)" || got=000
            if [ "$got" = "$2" ]; then say "  ✓ $base/… $3 → $got"; else say "  ✗ $base/… $3：期望 $2，实得 $got"; ok=0; fi
        }
        if [ -n "$sample" ]; then expect "$sample" 200 "旧图"; else say "  - 旧图清单里没有现存的文件，跳过旧图这一项"; fi
        expect "$fresh" 404 "旧结构位置新放的图"
        expect "$okf" 200 "项目子目录下的正常图"
        expect "$badf" 404 "项目子目录下带凭证样式的图"
    done
    verify_cleanup; trap - EXIT
    [ "$ok" = 1 ]
}

# ── 切换 ──
write_conf() {   # <是否写严格模式 1/0> <校验值>：整份写新文件再一次换上；保留原有其他行和权限
    local strict="$1" sha="$2" tmp
    tmp="$(mktemp "$(dirname "$CONF")/.public-assets.conf.XXXXXX")" || return 1
    cp -p "$CONF" "$tmp" || { rm -f "$tmp"; return 1; }
    { grep -vE '^PUBLIC_ASSETS_(STRICT|LEGACY_SHA)=' "$CONF" || [ $? -eq 1 ]; } > "$tmp" || { rm -f "$tmp"; return 1; }
    printf 'PUBLIC_ASSETS_LEGACY_SHA=%s\n' "$sha" >> "$tmp"
    [ "$strict" = 1 ] && printf 'PUBLIC_ASSETS_STRICT=1\n' >> "$tmp"
    mv "$tmp" "$CONF"
}
wait_status() {   # <期望 state> <旧 pid>：等到服务报告期望的状态、而且进程是新的；最多 20 秒
    local want="$1" old="$2" j i
    for i in $(seq 1 40); do
        j="$(status_json)"
        if [ "$(jget "$j" .pid)" != "$old" ] && [ -n "$(jget "$j" .pid)" ]; then
            [ "$(jget "$j" .state)" = "$want" ] && return 0
            [ "$want" = not-enforced ] || { [ "$(jget "$j" .state)" = not-enforced ] && { say "服务报告：$(jget "$j" .reason)"; return 1; }; }
        fi
        sleep 0.5
    done
    say "等了 20 秒，服务没有报告「${want}」（最后一次：$(jget "$j" .state) $(jget "$j" .reason)）"
    return 1
}
rollback() {   # <原因>
    local why="$1" sha pid
    sha="$(conf_get PUBLIC_ASSETS_LEGACY_SHA || true)"
    pid="$(jget "$(status_json)" .pid)"
    say "切换没成功（${why}），退回老规则…"
    if [ -n "$sha" ] && write_conf 0 "$sha" && svc restart "$UNIT" 2>/dev/null && wait_status not-enforced "$pid"; then
        note "已退回，原因：${why}（旧规则交图，旧图清单保留，下次切换沿用）"
        return 1
    fi
    note "退回也失败了，原因：$why"
    cat >&2 <<EOF
请照下面三步手工恢复老规则：
  1. 打开 ${CONF}，删掉 PUBLIC_ASSETS_STRICT=1 这一行（PUBLIC_ASSETS_LEGACY_SHA= 那一行保留）；
     文件改坏了就用同目录下最新的 $(basename "$CONF").bak-<时间> 覆盖它
  2. systemctl --user restart $UNIT && systemctl --user is-active $UNIT   （看到 active 算成功）
  3. bash $HERE/switch.sh --status   （看到「服务端拦截：not-enforced（服务报告严格模式关）」算恢复）
EOF
    return 3
}
# 只配了早期的「周报图片地址」、没配出图地址的项目：严格模式下它们的周报图放的位置不会被交出，
# 而新地址没法从旧地址推出来（公网路径可以自定义）。有这样的项目就不切换，点名要加哪一行。
old_weekly_projects() {
    local d f
    for d in ${PROJECT_DIRS//:/ }; do
        for f in "$d"/*.conf; do
            [ -f "$f" ] && grep -q '^PROJECT_ROOT=' "$f" || continue
            grep -Eq '^WEEKLY_REPORT_ASSET_URL=.+' "$f" || continue
            grep -Eq '^WEEKLY_REPORT_ASSET_ROOT_URL=("[^"]+"|[^"].*)$' "$f" && continue
            printf '%s\n' "$f"
        done
    done
}
cmd_apply() {
    local sha root max ls pid tmp olds
    [ -r "$CONF" ] || { say "没有对外服务的配置（${CONF}），这台机器没装对外服务，不切换"; return 1; }
    [ "$(service_state)" = active ] || { say "对外服务没在跑（$(service_state)），不切换"; return 1; }
    olds="$(old_weekly_projects)"
    if [ -n "$olds" ]; then
        say "下面这些项目只配了早期的周报图片地址（WEEKLY_REPORT_ASSET_URL），没配出图地址：切换后它们的周报会停。不切换，什么都没改。"
        printf '  %s\n' $olds >&2
        say "在每个文件里加一行出图地址（周报图片地址去掉末尾那一段 /weekly-report 通常就是它；以公网入口实际挂的路径为准），例如："
        say "  WEEKLY_REPORT_ASSET_ROOT_URL=\"https://<公网主机>/review-assets\""
        return 1
    fi
    root="$(conf_get PUBLIC_ASSETS_ROOT)" && [ -d "$root" ] || { say "配置里的 PUBLIC_ASSETS_ROOT 不是目录，不切换"; return 1; }
    max="$(conf_get PUBLIC_ASSETS_MAX_BYTES || true)"; [[ "$max" =~ ^[1-9][0-9]*$ ]] || max=$((256 * 1024 * 1024))
    cp -p "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)" || { say "备份配置失败，不切换"; return 1; }
    mkdir -p "$STATE_DIR" "$(dirname "$LIST1")" "$(dirname "$LIST2")"
    ls="$(legacy_state)"
    case "$ls" in
        none)
            say "建旧图清单（扫描 ${root}，大目录要一会儿）…"
            tmp="$(mktemp "$(dirname "$LIST1")/.public-assets-legacy.XXXXXX")"
            if ! "$NODE" "$STRICT" build "$root" "$tmp" "$max" ${PROJECT_DIRS//:/ }; then
                rm -f "$tmp"; say "旧图清单没建成，没改任何配置"; return 1
            fi
            sha="$(sha256sum "$tmp" | cut -d' ' -f1)"
            cp "$tmp" "$LIST2.tmp" && mv "$LIST2.tmp" "$LIST2" && mv "$tmp" "$LIST1" || { rm -f "$tmp" "$LIST2.tmp"; say "旧图清单写不进去，没改任何配置"; return 1; }
            list_ok "$LIST1" "$sha" && list_ok "$LIST2" "$sha" || { say "旧图清单写完核对不上，没改任何配置"; return 1; }
            note "旧图清单已建：$sha"
            ;;
        ok) sha="$(conf_get PUBLIC_ASSETS_LEGACY_SHA)" ;;
        one-bad:*)
            sha="$(conf_get PUBLIC_ASSETS_LEGACY_SHA)"
            local bad="${ls#one-bad:}" good
            [ "$bad" = "$LIST1" ] && good="$LIST2" || good="$LIST1"
            cp "$good" "$bad.tmp" && mv "$bad.tmp" "$bad" && list_ok "$bad" "$sha" || { say "修复损坏的那份清单失败，不切换"; return 1; }
            note "旧图清单：用 $good 修好了 $bad"
            ;;
        bad-sha) say "配置里的旧图清单校验值格式不对，不切换；需要人处理（见 --status）"; return 1 ;;
        both-bad) say "两份旧图清单都丢失或损坏，不切换；需要人处理（见 --status）"; return 1 ;;
    esac
    pid="$(jget "$(status_json)" .pid)"
    write_conf 1 "$sha" || { say "写配置失败；配置保持原样"; return 1; }
    svc restart "$UNIT" 2>/dev/null || { rollback "重启服务失败"; return $?; }
    wait_status strict-unverified "$pid" || { rollback "重启后服务没有报告严格模式在跑"; return $?; }
    cmd_verify || { rollback "核验没过"; return $?; }
    # 验收记录：核验对的就是这个进程。发布命令和自动切换只认有它的状态（核验没跑完、服务自己重启过都没有）
    "$NODE" "$STRICT" accept "$STATUS_FILE" || { rollback "验收记录写不成"; return $?; }
    note "已切换：服务端拦截已生效（旧图清单 ${sha}）"
    return 0
}
cmd_auto() {
    [ -f "$CONF" ] || return 0
    [ "$(conf_get PUBLIC_ASSETS_AUTO_SWITCH || true)" = 0 ] && return 0
    [ "$(service_state)" = active ] || return 0
    local j code now f="$STATE_DIR/auto.json" tries=0 next=0 was=""
    j="$(status_json)"; code="$(disk_code)"
    [ -n "$code" ] || return 0
    [ "$(jget "$j" .state)" = enforced ] && [ "$(jget "$j" .code)" = "$code" ] && return 0
    now="$(date +%s)"
    if [ -f "$f" ]; then
        was="$(jq -r '.code // ""' "$f" 2>/dev/null)" || was=""
        if [ "$was" = "$code" ]; then
            tries="$(jq -r '.tries // 0' "$f" 2>/dev/null)" || tries=0
            next="$(jq -r '.next // 0' "$f" 2>/dev/null)" || next=0
        fi
    fi
    [[ "$tries" =~ ^[0-9]+$ ]] || tries=5
    [[ "$next" =~ ^[0-9]+$ ]] || next=0
    [ "$tries" -lt 5 ] || return 0
    [ "$now" -ge "$next" ] || return 0
    local rc=0
    note "自动切换：服务端拦截$( [ "$(jget "$j" .state)" = enforced ] && echo '已生效但在跑的代码不是磁盘上的' || echo "没有生效（$(jget "$j" .reason)）")，开始切换"
    cmd_apply || rc=$?
    mkdir -p "$STATE_DIR"
    if [ "$rc" = 0 ]; then tries=0; next=0
    else
        tries=$((tries + 1))
        local gaps=(60 300 900 3600 3600)
        next=$((now + gaps[tries - 1 < 4 ? tries - 1 : 4]))
        [ "$tries" -lt 5 ] || note "自动切换：这个代码版本已试 5 次，不再自动试；人处理后跑 bash $HERE/switch.sh"
    fi
    printf '{"code":"%s","tries":%s,"next":%s}\n' "$code" "$tries" "$next" > "$f.tmp" && mv "$f.tmp" "$f"
    return 0
}

if [ "$MODE" = status ]; then cmd_status; exit 0; fi
[ "$MODE" = verify ] && { cmd_verify; exit $?; }
# 切换和自动切换拿同一把锁：两个切换不会同时改配置、同时重启
mkdir -p "$STATE_DIR"
exec {LOCK_FD}>>"$STATE_DIR/switch.lock"
if [ "$MODE" = auto ]; then
    flock -n "$LOCK_FD" || exit 0
    cmd_auto; exit 0
fi
flock -w 60 "$LOCK_FD" || { say "另一个切换在跑，等了 60 秒没等到"; exit 1; }
rc=0; cmd_apply || rc=$?
exit "$rc"
