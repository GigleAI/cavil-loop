#!/usr/bin/env bash
# kind: unit
# 「哪些项目的评论能出图」的补地址 / 核对 / 撤销步骤（GitHub#602）：docs/operations.md 和
# docs/operations.zh.md 里 <!-- asset-url-ops:*:begin --> 之间的命令，两份逐字一致，并在只有
# HOME 和 PATH 的干净环境里对一份临时假项目配置按字面执行（不碰真配置）。
#
# 三种撤销时机：补完什么都没改（撤销后与改前逐字节一致）；补完改了无关设置（无关设置保留，只少
# 出图地址那一行）；补完地址被改成别的值（撤销停在核对、文件一个字节不变）。另加几种不该补 / 不该
# 删的情况：来源项目没有地址、目标已有地址行、地址有两行，以及原文件末尾没有换行。
#
# 跑法：bash tests/asset-url-ops.test.sh   依赖：bash、coreutils、grep、sed、awk
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap 'rm -rf "${TMP:?}"' EXIT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

block() {   # <doc> <name>：取出标记之间那段 bash 代码（去掉 ``` 行）
    awk -v b="<!-- asset-url-ops:$2:begin -->" -v e="<!-- asset-url-ops:$2:end -->" \
        '$0==b{on=1; next} $0==e{on=0} on && !/^```/' "$1"
}

echo "── 两份文档的命令逐字一致 ──"
for n in vars add check revert; do
    en=$(block "$REPO_DIR/docs/operations.md" "$n"); zh=$(block "$REPO_DIR/docs/operations.zh.md" "$n")
    if [ -z "$en" ]; then bad "$n：英文文档里没取到命令"
    elif [ "$en" != "$zh" ]; then bad "$n：中英两份不一致"
    else ok "$n：两份一致（$(wc -l <<<"$en") 行）"; printf '%s\n' "$en" > "$TMP/$n.sh"; fi
done

URL="https://assets.example.invalid/review-assets"
CDIR="$TMP/home/.config/cavil-loop"
CONF="$CDIR/myproject.conf"
REC="$CONF.asset-url-added"
URL_B="https://assets-b.example.invalid/review-assets"
# 沙盘：假 HOME 下两份项目配置；myproject 没有地址，otherproject 有
sandbox() {
    rm -rf "${TMP:?}/home"; mkdir -p "$CDIR"
    printf 'PROJECT_ROOT=/x/myproject\nCODING_AGENT_CONFIG=/x/myproject/cavil-loop.config\nGH_TOKEN=fake-old\n' > "$CONF"
    printf 'PROJECT_ROOT=/x/other\nGH_TOKEN=fake-o\nWEEKLY_REPORT_ASSET_ROOT_URL="%s"\n' "$URL" > "$CDIR/otherproject.conf"
    chmod 600 "$CDIR"/*.conf
    cp "$CONF" "$TMP/orig.conf"
}
run() {   # <块...>：在同一个干净 shell 里依次按字面跑 vars + 这些块
    local f=("$TMP/vars.sh") b
    for b in "$@"; do f+=("$TMP/$b.sh"); done
    cat "${f[@]}" | env -i HOME="$TMP/home" PATH="${RUN_PATH:-$PATH}" bash 2>&1
}
addr_lines() { grep -c '^WEEKLY_REPORT_ASSET_ROOT_URL=' "$CONF"; }

echo "── 补完什么都没改，直接撤销 ──"
sandbox
out=$(run add check)
if grep -q '^ADDED (backup / 备份: ' <<<"$out" && grep -qxF "OK: $URL" <<<"$out"; then ok "补地址打印 ADDED，核对打印 OK"
else bad "补地址 / 核对输出不对：$out"; fi
if [ "$(addr_lines)" = 1 ] && grep -qxF "WEEKLY_REPORT_ASSET_ROOT_URL=\"$URL\"" "$CONF" \
   && [ "$(head -n 3 "$CONF")" = "$(cat "$TMP/orig.conf")" ] && [ "$(wc -l < "$CONF")" = 4 ]; then ok "配置只多出一行出图地址"
else bad "补完的配置不对：$(cat "$CONF")"; fi
bak=$(find "$CDIR" -maxdepth 1 -name 'myproject.conf.bak-*')
if [ -n "$bak" ] && [ "$(wc -l <<<"$bak")" = 1 ] && cmp -s "$bak" "$TMP/orig.conf" && [ "$(stat -c %a "$bak")" = 600 ]; then
    ok "备份在同目录、权限 600、与改前逐字节一致"
else bad "备份不对：${bak:-没有}"; fi
if [ "$(cat "$REC" 2>/dev/null)" = "$URL" ] && [ "$(stat -c %a "$REC")" = 600 ]; then ok "记录文件写下了本次加的地址、权限 600"
else bad "记录文件不对：$(cat "$REC" 2>&1)"; fi
if grep -q 'fake-old' <<<"$out"; then bad "输出里打印了配置内容（令牌）"; else ok "输出里没有令牌"; fi
out=$(run revert check)
if grep -qx 'REVERTED' <<<"$out" && grep -q '^NONE: ' <<<"$out"; then ok "撤销打印 REVERTED，之后核对打印 NONE"
else bad "撤销输出不对：$out"; fi
if cmp -s "$CONF" "$TMP/orig.conf"; then ok "撤销后与改前逐字节一致"; else bad "撤销后与改前不同"; fi
if [ "$(stat -c %a "$CONF")" = 600 ]; then ok "撤销后权限仍是 600"; else bad "撤销后权限变了：$(stat -c %a "$CONF")"; fi
left=$(find "$CDIR" -maxdepth 1 -name 'myproject.conf.*' ! -name 'myproject.conf.bak-*')
if [ -z "$left" ]; then ok "没留临时文件，记录随这一行删掉"; else bad "留下了文件：$left"; fi

echo "── 补完改了无关设置，再撤销 ──"
sandbox
run add >/dev/null
sed -i 's/^GH_TOKEN=fake-old$/GH_TOKEN=fake-new/' "$CONF"
out=$(run revert)
if grep -qx 'REVERTED' <<<"$out" && grep -qx 'GH_TOKEN=fake-new' "$CONF" && [ "$(addr_lines)" = 0 ] \
   && [ "$(sed 's/fake-new/fake-old/' "$CONF")" = "$(cat "$TMP/orig.conf")" ]; then
    ok "无关设置保留改后的值，只少了出图地址那一行"
else bad "撤销动了无关设置：$out / $(cat "$CONF")"; fi

echo "── 补完地址被改成别的值，再撤销 ──"
sandbox
run add >/dev/null
sed -i 's|^WEEKLY_REPORT_ASSET_ROOT_URL=.*|WEEKLY_REPORT_ASSET_ROOT_URL="https://other.example.invalid/x"|' "$CONF"
cp "$CONF" "$TMP/before.conf"
out=$(run check revert)
if grep -qF 'MISMATCH: 1 line(s): https://other.example.invalid/x' <<<"$out" && grep -q '^STOP: ' <<<"$out" \
   && cmp -s "$CONF" "$TMP/before.conf"; then ok "核对报 MISMATCH，撤销停下、文件一个字节不变"
else bad "地址被改后撤销没停下：$out"; fi
sandbox
run add >/dev/null
printf 'WEEKLY_REPORT_ASSET_ROOT_URL="%s"\n' "$URL" >> "$CONF"; cp "$CONF" "$TMP/before.conf"
out=$(run revert)
if grep -q '^STOP: 2 address line' <<<"$out" && cmp -s "$CONF" "$TMP/before.conf"; then ok "地址有两行时撤销停下、文件不变"
else bad "地址有两行时撤销没停下：$out"; fi

echo "── 接入后来源项目的地址换了，再撤销（按记录比对，不按来源现值） ──"
sandbox
run add >/dev/null
sed -i "s|^WEEKLY_REPORT_ASSET_ROOT_URL=.*|WEEKLY_REPORT_ASSET_ROOT_URL=\"$URL_B\"|" "$CDIR/otherproject.conf"
out=$(run check revert)
if grep -qxF "OK: $URL" <<<"$out" && grep -qx 'REVERTED' <<<"$out" && cmp -s "$CONF" "$TMP/orig.conf" && [ ! -e "$REC" ]; then
    ok "来源换成 B：目标里仍是本次加的 A，核对 OK、撤销删掉 A"
else bad "来源换了以后撤销不了本次加的地址：$out"; fi
sandbox
run add >/dev/null
sed -i "s|^WEEKLY_REPORT_ASSET_ROOT_URL=.*|WEEKLY_REPORT_ASSET_ROOT_URL=\"$URL_B\"|" "$CDIR/otherproject.conf" "$CONF"
cp "$CONF" "$TMP/before.conf"
out=$(run check revert)
if grep -qF "MISMATCH: 1 line(s): $URL_B (recorded / 记录: $URL)" <<<"$out" && grep -q '^STOP: ' <<<"$out" \
   && cmp -s "$CONF" "$TMP/before.conf" && [ -e "$REC" ]; then
    ok "来源和目标都换成 B：B 不是本次加的，撤销停下、B 保留"
else bad "目标被改成来源的新地址后被误删：$out / $(cat "$CONF")"; fi
sandbox
printf 'WEEKLY_REPORT_ASSET_ROOT_URL="%s"\n' "$URL" >> "$CONF"; cp "$CONF" "$TMP/before.conf"
out=$(run revert)
if grep -q "^STOP: .*recorded 'none'" <<<"$out" && cmp -s "$CONF" "$TMP/before.conf"; then
    ok "没有记录（不是这套步骤加的）：撤销停下、文件不变"
else bad "没有记录时撤销没停下：$out"; fi

echo "── 中途失败后按文档继续（复审第 2 轮） ──"
sandbox
chmod 400 "$CONF"
out=$(run add)
if grep -q '^FAILED: could not write ' <<<"$out" && cmp -s "$CONF" "$TMP/orig.conf" && [ -e "$REC" ]; then
    ok "配置只读：补地址报 FAILED、配置一个字节没变（记录留下）"
else bad "配置只读时补地址结果不对：$out"; fi
out=$(run check)
if grep -q '^NONE: .*leftover record' <<<"$out"; then ok "失败后核对：NONE，并提示有遗留记录"; else bad "失败后核对不对：$out"; fi
chmod 600 "$CONF"
out=$(run add check)
if grep -q '^ADDED ' <<<"$out" && grep -qxF "OK: $URL" <<<"$out" && [ "$(addr_lines)" = 1 ]; then
    ok "恢复写权限后重跑补地址：ADDED，核对 OK"
else bad "恢复权限后重试仍不行：$out"; fi
out=$(run revert check)
if grep -qx 'REVERTED' <<<"$out" && grep -q '^NONE: no address — workers describe images in words$' <<<"$out" \
   && cmp -s "$CONF" "$TMP/orig.conf" && [ ! -e "$REC" ]; then ok "之后撤销：REVERTED，配置与改前逐字节一致、记录删掉"
else bad "重试后撤销不对：$out"; fi
sandbox
chmod 400 "$CONF"; run add >/dev/null; chmod 600 "$CONF"
out=$(run revert)
if grep -q '^REVERTED: no address line, leftover record cleared' <<<"$out" && [ ! -e "$REC" ] && cmp -s "$CONF" "$TMP/orig.conf"; then
    ok "失败后不重试、直接撤销：只清掉遗留记录，报 REVERTED"
else bad "失败后直接撤销不对：$out"; fi
# 撤销删了行、删记录失败：报 PARTIAL，不报 REVERTED；再跑一次清掉记录
sandbox
run add >/dev/null
mkdir -p "$TMP/badrm"
cat > "$TMP/badrm/rm" <<'SH'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in *.asset-url-added) echo "rm: refused (test)" >&2; exit 1 ;; esac; done
exec /bin/rm "$@"
SH
chmod +x "$TMP/badrm/rm"
out=$(RUN_PATH="$TMP/badrm:$PATH" run revert)
if grep -q '^PARTIAL: ' <<<"$out" && ! grep -q 'REVERTED' <<<"$out" && [ "$(addr_lines)" = 0 ] && [ -e "$REC" ]; then
    ok "删记录失败：报 PARTIAL（地址行已删、记录还在），不报 REVERTED"
else bad "删记录失败时报告不对：$out"; fi
out=$(run revert check)
if grep -q '^REVERTED: no address line, leftover record cleared' <<<"$out" && grep -q '^NONE: no address — workers describe images in words$' <<<"$out" \
   && [ ! -e "$REC" ] && cmp -s "$CONF" "$TMP/orig.conf"; then ok "PARTIAL 后再跑撤销：清掉记录，与改前逐字节一致"
else bad "PARTIAL 后再撤销不对：$out"; fi
sandbox
printf '%s\n' "$URL" > "$REC"
out=$(RUN_PATH="$TMP/badrm:$PATH" run revert)
if grep -q '^FAILED: could not remove ' <<<"$out" && [ -e "$REC" ]; then ok "只剩记录且删不掉：报 FAILED"
else bad "只剩记录删不掉时报告不对：$out"; fi

echo "── 不该补的情况 ──"
sandbox
sed -i '/^WEEKLY_REPORT_ASSET_ROOT_URL=/d' "$CDIR/otherproject.conf"
out=$(run add)
if grep -q "^STOP: address to add ''" <<<"$out" && cmp -s "$CONF" "$TMP/orig.conf"; then ok "来源项目没有地址：停下、目标不变"
else bad "来源没有地址时没停下：$out"; fi
sandbox
printf 'WEEKLY_REPORT_ASSET_ROOT_URL=""\n' >> "$CONF"; cp "$CONF" "$TMP/before.conf"
out=$(run add)
if grep -q "^STOP: .*'1' address line" <<<"$out" && cmp -s "$CONF" "$TMP/before.conf"; then
    ok "目标已有地址行（哪怕为空）：停下、文件不变"
else bad "目标已有地址行时没停下：$out"; fi
sandbox
printf '%s\n' "$URL" > "$REC"
out=$(run add)
if grep -q '^ADDED ' <<<"$out" && [ "$(addr_lines)" = 1 ] && [ "$(cat "$REC")" = "$URL" ]; then
    ok "没有地址行却有遗留记录：照常补上，记录按本次地址重写"
else bad "遗留记录挡住了补地址：$out"; fi
sandbox
chmod 000 "$CONF"
out=$(run add); chmod 600 "$CONF"
if grep -q "^STOP: .*'unreadable' address line" <<<"$out" && cmp -s "$CONF" "$TMP/orig.conf" && [ ! -e "$REC" ]; then
    ok "配置读不了：补地址停下，不写记录"
else bad "配置读不了时没停下：$out"; fi
sandbox
printf 'GH_TOKEN=fake-old' > "$CONF"
run add >/dev/null
if [ "$(sed -n 1p "$CONF")" = 'GH_TOKEN=fake-old' ] && [ "$(addr_lines)" = 1 ]; then ok "原文件末尾没有换行时，地址另起一行"
else bad "地址粘到了上一行：$(cat "$CONF")"; fi

echo "结果：$pass 通过 / $fail 失败"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
