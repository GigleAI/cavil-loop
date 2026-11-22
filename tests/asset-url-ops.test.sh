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
# 中途失败（复审第 2、3 轮）：配置只读、写到一半超出文件大小上限（prlimit 造的真实短写）、改名前遗留的
# 记录、删记录失败——每种都要求原配置不被写坏，并能按文档接着跑完。
#
# 并发（重新派工后复审第 1 轮）：撤销删记录前另一终端跑补地址，两段共用一把锁，后来的等前一个放锁。
#
# 跑法：bash tests/asset-url-ops.test.sh   依赖：bash、GNU coreutils、grep、sed、awk、prlimit、flock（util-linux）

# ── Which projects show images in comments: rules moved here from the root agent guide (GitHub#658); read before changing ──
# Which projects show images in comments (GitHub#602: the per-project `WEEKLY_REPORT_ASSET_ROOT_URL=`
# line in `~/.config/cavil-loop/<key>.conf`, the two bullets after "没配出图地址" in the three worker
# templates — private-repository files are never embedded as images, public images hold only public
# content — and the matching criteria in review step 2L ① / ④; the add / check / revert steps in
# `docs/operations{,.zh}.md` behind `<!-- asset-url-ops:*:begin -->`) →
# `tests/reply-layout-prompts.test.sh` (the bullets in every entry point, rendered by the real
# dispatch scripts with and without an address) and `tests/asset-url-ops.test.sh` (~1 s; the doc steps
# run verbatim with only HOME and PATH against a fake config). Turning a project on makes its
# screenshots public: it is decided per project by a person, never by a fallback to the machine's
# address. Add writes the address it added to `<key>.conf.asset-url-added`; revert compares with that
# record — never with the source project's current address, which may have changed since (PR #605
# review round 1) — removes only the added line, only when it is the one line and still equals the
# record, and stops when there is no record. Every combination of address lines × record × failed
# write has one documented outcome and next step (PR #605 review round 2, the third variant of this
# root cause): a record with no address line is a leftover (a failed add, or a revert that removed the
# line but not the record) — add rewrites it, revert clears it; the config file is only ever replaced
# whole — add and revert write the complete new file next to it, check it, copy the old file's
# permissions, and only then rename it over (PR #605 review round 3: an append cut short by a size
# limit left half an address line that neither add nor revert could get past; the test makes that
# short write for real with `prlimit --fsize`); a file that is not writable is `FAILED` before
# anything is written; each block takes one snapshot first (add: the backup) and makes every decision
# — how many address lines, which value — and the new file from that snapshot alone (PR #605 review
# round 5: revert checked the address on one read and built the result from another, and deleted an
# address changed in between) — right before the swap the file must still equal it (else `STOP`,
# nothing changed), and the replaced file, kept through a hard link taken just before the rename, must
# still equal it right after (else `CONFLICT`, that file is kept and named) — the same "compare once
# more right before the rename, state what cannot be prevented" rule as `project-config.sh` (PR #605
# review round 4: a save between read and rename was overwritten; the test pins both windows with
# `chmod` / `mv` wrappers); not caught: an editor's own rename in the instant between the last check
# and the swap — after six review rounds of variants the maintainer chose (PR #605 Q1 = A) to keep
# this design and accept that window, stated in the docs, rather than route every writer of the file
# through one lock (which still could not cover a person's editor) or drop the scripted steps; add and
# revert of one project hold one lock, `<key>.conf.asset-url.lock` (`flock -w 60`), from the first
# read to the last write, so they never interleave (re-dispatch review round 1: a revert that read
# zero address lines deleted the record of an add that finished in between); revert reports `REVERTED`
# only when the record is really gone, `PARTIAL` when the line is gone and the record is not; an
# unreadable file is `STOP`. Never copy a backup back over the file (a later token change would be
# lost). Keep the two doc copies identical
#
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
left=$(find "$CDIR" -maxdepth 1 -name 'myproject.conf.*' ! -name 'myproject.conf.bak-*' ! -name 'myproject.conf.asset-url.lock')
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

echo "── 中途失败后按文档继续（复审第 2、3 轮） ──"
left_tmp() { find "$CDIR" -maxdepth 1 -name 'myproject.conf.*' ! -name 'myproject.conf.bak-*' ! -name 'myproject.conf.asset-url-added' ! -name 'myproject.conf.asset-url.lock'; }
# 只读：打不开就不动任何东西（不留记录）
sandbox
chmod 400 "$CONF"
out=$(run add)
if grep -q '^FAILED: .* is not writable' <<<"$out" && cmp -s "$CONF" "$TMP/orig.conf" && [ ! -e "$REC" ] && [ -z "$(left_tmp)" ]; then
    ok "配置只读：补地址报 FAILED，配置一个字节没变，不留记录和临时文件"
else bad "配置只读时补地址结果不对：$out"; fi
chmod 600 "$CONF"
out=$(run add check)
if grep -q '^ADDED ' <<<"$out" && grep -qxF "OK: $URL" <<<"$out" && [ "$(addr_lines)" = 1 ]; then
    ok "恢复写权限后重跑补地址：ADDED，核对 OK"
else bad "恢复权限后重试仍不行：$out"; fi
out=$(run revert check)
if grep -qx 'REVERTED' <<<"$out" && grep -q '^NONE: no address — workers describe images in words$' <<<"$out" \
   && cmp -s "$CONF" "$TMP/orig.conf" && [ ! -e "$REC" ]; then ok "之后撤销：REVERTED，配置与改前逐字节一致、记录删掉"
else bad "重试后撤销不对：$out"; fi
# 真实短写：文件大小上限 64 字节（只作用于跑文档的那个 bash），备份能写下，新配置写到一半被截断
sandbox
printf 'GH_TOKEN=fake-old\n' > "$CONF"; chmod 640 "$CONF"; cp "$CONF" "$TMP/orig.conf"
out=$(cat "$TMP/vars.sh" "$TMP/add.sh" | env -i HOME="$TMP/home" PATH="$PATH" prlimit --fsize=64 -- bash -c 'trap "" XFSZ; exec bash' 2>&1)
if grep -q '^FAILED: .* not changed' <<<"$out" && grep -qi 'File too large' <<<"$out" \
   && cmp -s "$CONF" "$TMP/orig.conf" && [ ! -e "$REC" ] && [ -z "$(left_tmp)" ]; then
    ok "写到一半超出文件大小上限：报 FAILED，原配置一个字节没变，不留记录、不留半截临时文件"
else bad "短写时结果不对：$out / $(cat "$CONF")"; fi
out=$(run check)
if grep -q '^NONE: no address — workers describe images in words$' <<<"$out"; then ok "短写失败后核对：NONE"; else bad "短写失败后核对不对：$out"; fi
out=$(run add check)
if grep -q '^ADDED ' <<<"$out" && grep -qxF "OK: $URL" <<<"$out" && [ "$(stat -c %a "$CONF")" = 640 ]; then
    ok "去掉限制后重跑补地址：ADDED、核对 OK，配置仍是原来的权限 640"
else bad "短写后重试不对：$out / $(stat -c %a "$CONF")"; fi
out=$(run revert)
if grep -qx 'REVERTED' <<<"$out" && cmp -s "$CONF" "$TMP/orig.conf" && [ "$(stat -c %a "$CONF")" = 640 ] && [ ! -e "$REC" ]; then
    ok "之后撤销：REVERTED，与改前逐字节一致，权限仍是 640"
else bad "短写重试后撤销不对：$out"; fi
# 遗留记录（例如上次改名那一步失败）：直接撤销只清记录
sandbox
printf '%s\n' "$URL" > "$REC"
out=$(run check revert)
if grep -q '^NONE: .*leftover record' <<<"$out" && grep -q '^REVERTED: no address line, leftover record cleared' <<<"$out" \
   && [ ! -e "$REC" ] && cmp -s "$CONF" "$TMP/orig.conf"; then
    ok "只有遗留记录：核对提示遗留，撤销只清掉记录，报 REVERTED"
else bad "遗留记录时核对 / 撤销不对：$out"; fi
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

echo "── 别处在同一时刻保存了配置（复审第 4 轮） ──"
# 两个包装器只把「别处保存」放进固定的时刻，然后交给真正的命令：
#   chmod：新文件写好、换上去之前（这时必须停下、不换）；mv：换上去的那一刻（这时必须报 CONFLICT、留下被换下的文件）
REAL_MV=$(command -v mv); REAL_CHMOD=$(command -v chmod)
mkdir -p "$TMP/race-chmod" "$TMP/race-mv"
cat > "$TMP/race-chmod/chmod" <<SH
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in --reference=*) printf 'LATER_SETTING=enabled\\n' >> "\${a#--reference=}" ;; esac; done
exec "$REAL_CHMOD" "\$@"
SH
cat > "$TMP/race-mv/mv" <<SH
#!/usr/bin/env bash
printf 'LATER_SETTING=enabled\\n' >> "\${@: -1}"
exec "$REAL_MV" "\$@"
SH
"$REAL_CHMOD" +x "$TMP/race-chmod/chmod" "$TMP/race-mv/mv"
later() { grep -qx 'LATER_SETTING=enabled' "$1"; }
replaced() { find "$CDIR" -maxdepth 1 -name 'myproject.conf.replaced-*'; }
# 换上去之前有人保存：补地址停下，别处的保存留着，重跑后两样都在
sandbox
out=$(RUN_PATH="$TMP/race-chmod:$PATH" run add)
if grep -q '^STOP: .* was changed while this block ran' <<<"$out" && later "$CONF" && [ "$(addr_lines)" = 0 ] \
   && [ ! -e "$REC" ] && [ -z "$(left_tmp)" ] && [ -z "$(replaced)" ]; then
    ok "补地址：替换前别处保存了 → STOP，那次保存留着，没写地址、没留记录和临时文件"
else bad "补地址替换前被别处保存时结果不对：$out / $(cat "$CONF")"; fi
out=$(run add check)
if grep -q '^ADDED ' <<<"$out" && grep -qxF "OK: $URL" <<<"$out" && later "$CONF"; then ok "重跑补地址：ADDED，别处那次保存仍在"
else bad "替换前被保存后重跑补地址不对：$out"; fi
# 撤销同理
cp "$CONF" "$TMP/before.conf"
out=$(RUN_PATH="$TMP/race-chmod:$PATH" run revert)
if grep -q '^STOP: .* was changed while this block ran' <<<"$out" && [ "$(addr_lines)" = 1 ] && [ "$(grep -c '^LATER_SETTING=' "$CONF")" = 2 ] \
   && [ -e "$REC" ] && [ -z "$(left_tmp)" ] && [ -z "$(replaced)" ]; then
    ok "撤销：替换前别处保存了 → STOP，地址行和那次保存都留着"
else bad "撤销替换前被别处保存时结果不对：$out / $(cat "$CONF")"; fi
out=$(run revert)
if grep -qx 'REVERTED' <<<"$out" && [ "$(addr_lines)" = 0 ] && [ "$(grep -c '^LATER_SETTING=' "$CONF")" = 2 ] && [ ! -e "$REC" ]; then
    ok "重跑撤销：REVERTED，别处的保存都还在"
else bad "替换前被保存后重跑撤销不对：$out"; fi
# 换上去的那一刻有人保存：不能悄悄丢，报 CONFLICT 并留下被换下的文件
sandbox
out=$(RUN_PATH="$TMP/race-mv:$PATH" run add check)
old=$(replaced)
if grep -q '^CONFLICT: ADDED, but a change saved at the same moment is in ' <<<"$out" && grep -qxF "OK: $URL" <<<"$out" \
   && [ -n "$old" ] && later "$old" && [ "$(wc -l <<<"$old")" = 1 ]; then
    ok "补地址：替换那一刻别处保存了 → 报 CONFLICT，那次保存在被换下的文件里留着，没有悄悄丢"
else bad "补地址替换瞬间被别处保存时结果不对：$out"; fi
rm -f "$old"
out=$(RUN_PATH="$TMP/race-mv:$PATH" run revert check)
old=$(replaced)
if grep -q '^CONFLICT: REVERTED, but a change saved at the same moment is in ' <<<"$out" && grep -q '^NONE: ' <<<"$out" \
   && [ -n "$old" ] && later "$old" && [ ! -e "$REC" ]; then
    ok "撤销：替换那一刻别处保存了 → 报 CONFLICT，那次保存在被换下的文件里留着"
else bad "撤销替换瞬间被别处保存时结果不对：$out"; fi

# 复审第 5 轮：撤销读完记录、取快照的那一刻，地址被改成 B——判断和生成都只看快照，必须停下、留着 B
REAL_CAT=$(command -v cat); mkdir -p "$TMP/race-cat"
cat > "$TMP/race-cat/cat" <<SH
#!/usr/bin/env bash
if [ "\$#" = 1 ] && [ "\$1" = "$CONF" ] && [ ! -e "$TMP/race-cat/done" ]; then
    : > "$TMP/race-cat/done"
    sed -i 's|^WEEKLY_REPORT_ASSET_ROOT_URL=.*|WEEKLY_REPORT_ASSET_ROOT_URL="$URL_B"|' "$CONF"
fi
exec "$REAL_CAT" "\$@"
SH
"$REAL_CHMOD" +x "$TMP/race-cat/cat"
sandbox
run add >/dev/null
rm -f "$TMP/race-cat/done"
out=$(RUN_PATH="$TMP/race-cat:$PATH" run revert)
if [ -e "$TMP/race-cat/done" ] && grep -q "^STOP: 1 address line(s), value '$URL_B', recorded '$URL'" <<<"$out" \
   && grep -qxF "WEEKLY_REPORT_ASSET_ROOT_URL=\"$URL_B\"" "$CONF" && [ -e "$REC" ] && [ -z "$(left_tmp)" ]; then
    ok "撤销取快照时地址刚被改成 B：按快照判断 → STOP，B 和记录都留着"
else bad "撤销取快照时地址被改：结果不对：$out / $(cat "$CONF")"; fi
# 复审（重新派工后第 1 轮）：撤销读到零行地址、删遗留记录之前，另一个终端跑完整的补地址——
# 记录被撤销删掉、地址却留下。两段共用一把锁后，后来的补地址要等撤销放锁再跑，地址和记录始终配对。
LOCK="$CONF.asset-url.lock"
REAL_RM=$(command -v rm); mkdir -p "$TMP/race-rm"
cat > "$TMP/race-rm/rm" <<SH
#!/usr/bin/env bash
if [ "\$*" = "-f $REC" ] && [ ! -e "$TMP/race-rm/started" ]; then
    : > "$TMP/race-rm/started"
    flock -n "$LOCK" true && : > "$TMP/race-rm/unlocked"
    # 另一个终端不会继承这把锁的描述符：关掉它，免得后台的补地址等的是自己
    { cat "$TMP/vars.sh" "$TMP/add.sh" | env -i HOME="$TMP/home" PATH="$PATH" bash > "$TMP/race-rm/add.out" 2>&1; : > "$TMP/race-rm/add.done"; } 9>&- &
    sleep 1
    [ -e "$TMP/race-rm/add.done" ] && : > "$TMP/race-rm/add-early"
fi
exec "$REAL_RM" "\$@"
SH
"$REAL_CHMOD" +x "$TMP/race-rm/rm"
sandbox
printf '%s\n' "$URL" > "$REC"
"$REAL_RM" -f "$TMP/race-rm/"{started,unlocked,add.out,add.done,add-early}
out=$(RUN_PATH="$TMP/race-rm:$PATH" run revert)
for _ in $(seq 100); do [ -e "$TMP/race-rm/add.done" ] && break; sleep 0.1; done
if [ -e "$TMP/race-rm/started" ] && [ ! -e "$TMP/race-rm/unlocked" ] && [ ! -e "$TMP/race-rm/add-early" ] \
   && grep -q '^REVERTED: no address line, leftover record cleared' <<<"$out" && grep -q '^ADDED ' "$TMP/race-rm/add.out"; then
    ok "撤销删记录前另一终端补地址：补地址等撤销放锁后才跑，两边各报 REVERTED / ADDED"
else bad "并发撤销 / 补地址的顺序不对：$out / $(cat "$TMP/race-rm/add.out" 2>&1) / $(ls "$TMP/race-rm")"; fi
out=$(run check)
if grep -qxF "OK: $URL" <<<"$out" && [ "$(cat "$REC" 2>/dev/null)" = "$URL" ]; then ok "并发之后地址和记录配对，核对 OK"
else bad "并发之后地址和记录不配对：$out"; fi
out=$(run revert check)
if grep -qx 'REVERTED' <<<"$out" && grep -q '^NONE: ' <<<"$out" && cmp -s "$CONF" "$TMP/orig.conf"; then ok "并发之后照常撤销，与改前逐字节一致"
else bad "并发之后撤销不对：$out"; fi
# 锁打不开（这里把锁的位置占成目录）：两段都什么都不改
sandbox
mkdir "$LOCK"
out=$(run add); out2=$(run revert)
if grep -q '^FAILED: could not open ' <<<"$out" && grep -q '^FAILED: could not open ' <<<"$out2" && cmp -s "$CONF" "$TMP/orig.conf" && [ ! -e "$REC" ]; then
    ok "锁打不开：补地址和撤销都报 FAILED、配置不变"
else bad "锁打不开时结果不对：$out / $out2"; fi
# 补地址停下时不留没用的备份
sandbox
printf 'WEEKLY_REPORT_ASSET_ROOT_URL="%s"\n' "$URL_B" >> "$CONF"
run add >/dev/null
if [ -z "$(find "$CDIR" -maxdepth 1 -name 'myproject.conf.bak-*')" ]; then ok "补地址停下时不留备份"
else bad "补地址停下时留下了备份"; fi

echo "── 不该补的情况 ──"
sandbox
sed -i '/^WEEKLY_REPORT_ASSET_ROOT_URL=/d' "$CDIR/otherproject.conf"
out=$(run add)
if grep -q '^STOP: no address in otherproject' <<<"$out" && cmp -s "$CONF" "$TMP/orig.conf"; then ok "来源项目没有地址：停下、目标不变"
else bad "来源没有地址时没停下：$out"; fi
sandbox
printf 'WEEKLY_REPORT_ASSET_ROOT_URL=""\n' >> "$CONF"; cp "$CONF" "$TMP/before.conf"
out=$(run add)
if grep -q '^STOP: .* already has an address line' <<<"$out" && cmp -s "$CONF" "$TMP/before.conf"; then
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
if grep -q '^FAILED: .* is not writable' <<<"$out" && cmp -s "$CONF" "$TMP/orig.conf" && [ ! -e "$REC" ]; then
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
