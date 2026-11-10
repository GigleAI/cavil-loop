#!/usr/bin/env bash
# kind: unit
# 跑法：bash tests/public-assets.test.sh
# 依赖：node、curl、git。无网络（只打本机回环）、不起真浏览器（playwright 换成假模块）。
#
# 验证「评论配图的公网入口只放行图片和视频」这一组（GigleTutor-Web#1467）：
#   ① 对外服务 scripts/public-assets/serve.mjs：图片 / 视频照给（含分段请求），目录、其他类型、
#      改了扩展名的文件、点开头的路径、指到目录外的符号链接一律同一个 404，且不漏文件名
#   ② 发图前自查 scripts/public-assets/check.mjs：含凭证样式 → 退出码 1、点名、不输出值
#   ③ scripts/weekly-report/publish-asset.sh：图片进公网目录；PDF 不公开；含凭证的拒绝；不再造 index.html
#   ④ scripts/review-screenshot.mjs：登录状态副本只在原件旁边、权限 600，结束 / 被中断都删；
#      原件在输出目录里或没被 git 忽略 → 拒绝
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(dirname "$TEST_DIR")}"
TMP="$(mktemp -d)"
SERVER_PID=""
HOLD_PID=""
cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    [ -n "$HOLD_PID" ] && kill "$HOLD_PID" 2>/dev/null
    rm -rf "$TMP"
}
trap cleanup EXIT

pass=0
fail=0
chk() {
    if [ "$2" = "$3" ]; then
        echo "  ✅ $1"
        pass=$((pass + 1))
    else
        echo "  ❌ $1 (期望 '$3'，实得 '$(printf '%s' "$2" | tr '\n' '|')')"
        fail=$((fail + 1))
    fi
}

# 假凭证：只为撞上凭证样式，不是任何真实服务的值。
FAKE_SECRET="NOT-A-REAL-TOKEN-0123456789abcdef"

# ── 夹具：一个资产目录 ──
ROOT="$TMP/assets"; OUTSIDE="$TMP/outside"
mkdir -p "$ROOT/pr-1/sub" "$ROOT/.hidden" "$OUTSIDE"
png() { printf '\x89PNG\r\n\x1a\n' > "$1"; head -c "${2:-200}" /dev/zero >> "$1"; }
png "$ROOT/pr-1/ok.png" 200
png "$ROOT/pr-1/sub/deep.png" 10
png "$ROOT/pr-1/.dot.png" 10
png "$ROOT/.hidden/in-hidden.png" 10
png "$OUTSIDE/secret.png" 10
printf '\x00\x00\x00\x18ftypmp42' > "$ROOT/pr-1/clip.mp4"; printf '0123456789abcdefghij' >> "$ROOT/pr-1/clip.mp4"
printf 'GIF89a...........' > "$ROOT/pr-1/anim.gif"
printf '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>' > "$ROOT/pr-1/pic.svg"
printf '<svg xmlns="http://www.w3.org/2000/svg"><!-- "refresh_token": "%s" --></svg>' "$FAKE_SECRET" > "$ROOT/pr-1/leaky.svg"
printf '{"refresh_token": "%s"}' "$FAKE_SECRET" > "$ROOT/pr-1/state.json"
printf '{"refresh_token": "%s"}' "$FAKE_SECRET" > "$ROOT/pr-1/renamed.png"
printf 'plain log line\n' > "$ROOT/pr-1/run.log"
printf 'notes\n' > "$ROOT/pr-1/notes.txt"
printf '<!doctype html><p>prototype</p>' > "$ROOT/pr-1/page.html"
printf '<!doctype html><p>index</p>' > "$ROOT/pr-1/index.html"
printf '%%PDF-1.4 fake' > "$ROOT/pr-1/report.pdf"
printf 'no extension' > "$ROOT/pr-1/noext"
ln -s "$OUTSIDE/secret.png" "$ROOT/pr-1/escape.png"
ln -s "$ROOT/pr-1/ok.png" "$ROOT/pr-1/alias.png"

echo "① 对外服务：只放行图片 / 视频"
PUBLIC_ASSETS_ROOT="$ROOT" PUBLIC_ASSETS_PORT=0 node "$REPO_DIR/scripts/public-assets/serve.mjs" 2> "$TMP/serve.log" &
SERVER_PID=$!
PORT=""
for _ in $(seq 1 50); do
    PORT="$(sed -nE 's/^public-assets: 127\.0\.0\.1:([0-9]+) .*/\1/p' "$TMP/serve.log" 2>/dev/null | head -1)"
    [ -n "$PORT" ] && break
    sleep 0.1
done
chk "服务起来了，只绑本机回环" "$([ -n "$PORT" ] && echo up)" "up"
B="http://127.0.0.1:$PORT"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
hdr() { curl -s -D - -o /dev/null "${@:2}" | tr -d '\r' | awk -F': ' -v k="$1" 'tolower($1)==k {print $2}'; }

chk "PNG：200" "$(code "$B/review-assets/pr-1/ok.png")" "200"
chk "PNG：内容类型和长度对" "$(hdr content-type "$B/review-assets/pr-1/ok.png")/$(hdr content-length "$B/review-assets/pr-1/ok.png")" "image/png/208"
chk "PNG：拿到的字节和原文件一样" "$(curl -s "$B/review-assets/pr-1/ok.png" | cmp -s - "$ROOT/pr-1/ok.png" && echo same)" "same"
chk "入口已剥掉前缀时也认" "$(code "$B/pr-1/ok.png")" "200"
chk "子目录里的图：200" "$(code "$B/review-assets/pr-1/sub/deep.png")" "200"
chk "GIF：200" "$(code "$B/review-assets/pr-1/anim.gif")" "200"
chk "视频：200、video/mp4" "$(code "$B/review-assets/pr-1/clip.mp4")/$(hdr content-type "$B/review-assets/pr-1/clip.mp4")" "200/video/mp4"
chk "视频分段请求：206 + 范围对" "$(code -H 'Range: bytes=12-15' "$B/review-assets/pr-1/clip.mp4")/$(hdr content-range -H 'Range: bytes=12-15' "$B/review-assets/pr-1/clip.mp4")/$(curl -s -H 'Range: bytes=12-15' "$B/review-assets/pr-1/clip.mp4")" "206/bytes 12-15/32/0123"
chk "分段请求取末尾 N 字节" "$(curl -s -H 'Range: bytes=-4' "$B/review-assets/pr-1/clip.mp4")" "ghij"
chk "越界的分段请求：416" "$(code -H 'Range: bytes=999-' "$B/review-assets/pr-1/clip.mp4")" "416"
chk "HEAD：200、带长度、没有正文" "$(curl -s -I -o /dev/null -w '%{http_code}' "$B/review-assets/pr-1/ok.png")/$(curl -s -I "$B/review-assets/pr-1/ok.png" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-length"{print $2}')" "200/208"
chk "SVG：200，带禁止脚本的响应头" "$(code "$B/review-assets/pr-1/pic.svg")/$(hdr content-security-policy "$B/review-assets/pr-1/pic.svg" | grep -c "default-src 'none'")" "200/1"
chk "指向目录内文件的符号链接：200" "$(code "$B/review-assets/pr-1/alias.png")" "200"

deny_all=""
for p in "" "pr-1/" "pr-1" "pr-1/sub/" "pr-1/state.json" "pr-1/run.log" "pr-1/notes.txt" "pr-1/page.html" "pr-1/index.html" \
         "pr-1/report.pdf" "pr-1/noext" "pr-1/renamed.png" "pr-1/leaky.svg" "pr-1/.dot.png" ".hidden/in-hidden.png" \
         "pr-1/escape.png" "pr-1/missing.png" "pr-1/..%2f..%2foutside/secret.png" "..%2foutside%2fsecret.png"; do
    c="$(code "$B/review-assets/$p")"
    [ "$c" = 404 ] || deny_all="$deny_all [$p→$c]"
done
chk "目录 / 日志 / JSON / HTML / PDF / 无扩展名 / 改名的 JSON / 带凭证的 SVG / 点开头 / 逃出目录 / 不存在：全是 404" "$deny_all" ""
chk "目录的 404 正文里没有任何文件名" "$(curl -s "$B/review-assets/pr-1/" | grep -cE 'ok\.png|state\.json|run\.log|sub')" "0"
chk "各种拒绝对外是同一个正文（不透露原因）" "$( { curl -s "$B/review-assets/pr-1/"; curl -s "$B/review-assets/pr-1/state.json"; curl -s "$B/review-assets/pr-1/missing.png"; curl -s "$B/review-assets/pr-1/renamed.png"; } | sort -u | wc -l | tr -d ' ')" "1"
chk "POST：404" "$(code -X POST "$B/review-assets/pr-1/ok.png")" "404"
chk "拒绝的原因进了本机日志" "$(grep -c 'renamed\.png — 内容不是 \.png 格式' "$TMP/serve.log" | awk '{print ($1>0)?"有":"无"}')/$(grep -c '目录不对外' "$TMP/serve.log" | awk '{print ($1>0)?"有":"无"}')" "有/有"
chk "日志里没有凭证的值" "$(grep -c "$FAKE_SECRET" "$TMP/serve.log")" "0"
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
chk "不给目录 / 端口：用法错误，退出码 2" "$(node "$REPO_DIR/scripts/public-assets/serve.mjs" >/dev/null 2>&1; echo $?)" "2"

echo "② 发图前自查"
CHECK="$REPO_DIR/scripts/public-assets/check.mjs"
out="$(node "$CHECK" "$ROOT/pr-1/state.json" 2>&1)"; rc=$?
chk "含 refresh_token 的 JSON：退出码 1" "$rc" "1"
chk "点了文件名、说了是哪类" "$(printf '%s' "$out" | grep -c 'state\.json.*凭证样式（token-field）')" "1"
chk "输出里没有凭证的值" "$(printf '%s' "$out" | grep -c "$FAKE_SECRET")" "0"
out="$(node "$CHECK" --root "$ROOT" "$ROOT/pr-1/sub" "$ROOT/pr-1/ok.png" "$ROOT/pr-1/run.log" "$ROOT/pr-1/report.pdf" 2>&1)"; rc=$?
chk "没有凭证：退出码 0" "$rc" "0"
chk "图片报拿得到，日志 / PDF 报拿不到并给原因" "$(printf '%s\n' "$out" | grep -c '^拿得到 ')/$(printf '%s\n' "$out" | grep -c '^拿不到 .*不是图片 / 视频')" "2/2"
out="$(node "$CHECK" --root "$ROOT" "$ROOT/pr-1" 2>&1)"; rc=$?
chk "扫整个目录：有凭证就 1，三处都点名（JSON、改名的 PNG、SVG）" "$rc/$(printf '%s\n' "$out" | grep -c '^❌ 凭证')" "1/3"
# 样本在运行时拼出来：仓库里不留任何长得像真凭证的整串（免得被密钥扫描当成泄露）。
filler='0123456789abcdefghijABCDEFGHIJ0123456789'
for kind in "ghp""_$filler" "-----BEGIN OPENSSH PRIVATE"" KEY-----" \
            "postgres""://user:hunter2222@db.example.invalid/x" "SUPABASE_SERVICE""_ROLE_KEY=x" \
            "eyJ${filler:10:20}.eyJ${filler:10:20}.${filler:0:16}"; do
    printf '%s\n' "$kind" > "$TMP/one.txt"
    node "$CHECK" "$TMP/one.txt" >/dev/null 2>&1; r=$?
    [ "$r" = 1 ] || deny_all="$deny_all [${kind:0:12}→$r]"
done
chk "令牌 / 私钥 / 带密码的连接串 / service role / JWT 样式都拦" "$deny_all" ""
# 大文件、跨读取块边界：没有「太大就不扫」这回事（曾经超过 32MiB 的文件跳过检查、照样报拿得到）。
BIG="$TMP/big"; mkdir -p "$BIG"
secret_json="{\"refresh_token\": \"$FAKE_SECRET\"}"
mkbig() {   # <文件> <凭证前的填充字节数> <凭证后的填充字节数>：合法 PNG 开头 + 填充 + 假凭证 + 填充
    printf '\x89PNG\r\n\x1a\n' > "$1"; head -c "$2" /dev/zero >> "$1"; printf '%s' "$secret_json" >> "$1"; head -c "$3" /dev/zero >> "$1"
}
mkbig "$BIG/tail.png" $((33 * 1024 * 1024)) 0
out="$(node "$CHECK" "$BIG/tail.png" 2>&1)"; rc=$?
chk "33MiB 的图、凭证在末尾：退出码 1 并点名" "$rc/$(printf '%s' "$out" | grep -c 'tail\.png — 内容里有凭证样式')" "1/1"
mkbig "$BIG/straddle.png" $((1024 * 1024 - 8 - 20)) 4096
out="$(node "$CHECK" "$BIG/straddle.png" 2>&1)"; rc=$?
chk "凭证正好跨在两个读取块的边界上：照样拦" "$rc" "1"
mkbig "$BIG/straddle2.png" $((5 * 1024 * 1024 - 8 - 3)) $((40 * 1024 * 1024))
out="$(node "$CHECK" "$BIG/straddle2.png" 2>&1)"; rc=$?
chk "45MiB 的图、凭证跨在第 5 个块的边界上：照样拦" "$rc" "1"
printf '\x89PNG\r\n\x1a\n' > "$BIG/clean.png"; head -c $((33 * 1024 * 1024)) /dev/zero >> "$BIG/clean.png"
out="$(node "$CHECK" "$BIG/clean.png" 2>&1)"; rc=$?
chk "33MiB 的干净图：退出码 0，报拿得到" "$rc/$(printf '%s\n' "$out" | grep -c '^拿得到 ')" "0/1"
chk "不给参数：退出码 2" "$(node "$CHECK" >/dev/null 2>&1; echo $?)" "2"

echo "③ publish-asset.sh"
H="$TMP/home"; mkdir -p "$H/.config/cavil-loop" "$TMP/bin" "$TMP/pub" "$TMP/priv"
cat > "$H/.config/cavil-loop/p.conf" <<CONF
WEEKLY_REPORT_ASSET_ROOT="$TMP/pub"
WEEKLY_REPORT_ASSET_ROOT_URL="https://example.invalid/review-assets"
WEEKLY_REPORT_PRIVATE_ASSET_ROOT="$TMP/priv"
CONF
cat > "$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
echo "${@: -1}" >> "$FAKE_CURL_LOG"; printf '%s' "${FAKE_CODE:-200}"
SH
chmod +x "$TMP/bin/curl"
pub() { HOME="$H" PATH="$TMP/bin:$PATH" FAKE_CURL_LOG="$TMP/curl.log" bash "$REPO_DIR/scripts/weekly-report/publish-asset.sh" "$@"; }
url="$(pub p "$ROOT/pr-1/ok.png" shots 2>/dev/null)"; rc=$?
chk "图片：成功，打印公网地址" "$rc/$(printf '%s' "$url" | grep -cE '^https://example\.invalid/review-assets/shots/ok-rev-[0-9]+\.png$')" "0/1"
chk "图片进了公网目录" "$(ls "$TMP/pub/shots" 2>/dev/null | grep -cE '^ok-rev-[0-9]+\.png$')" "1"
chk "不再往目录里放 index.html" "$(find "$TMP/pub" -name index.html | wc -l | tr -d ' ')" "0"
url="$(pub p "$ROOT/pr-1/report.pdf" 2>/dev/null)"; rc=$?
chk "PDF：成功，打印的是不公开目录里的本机路径" "$rc/$(printf '%s' "$url" | grep -cE "^$TMP/priv/weekly-report/report-rev-[0-9]+\.pdf$")/$([ -f "$url" ] && echo 在)" "0/1/在"
chk "PDF 没进公网目录" "$(find "$TMP/pub" -name '*.pdf' | wc -l | tr -d ' ')" "0"
chk "不公开目录权限 700" "$(stat -c %a "$TMP/priv")" "700"
echo "WEEKLY_REPORT_PRIVATE_ASSET_ROOT_URL=\"https://intranet.invalid/private\"" >> "$H/.config/cavil-loop/p.conf"
url="$(pub p "$ROOT/pr-1/report.pdf" 2>/dev/null)"; rc=$?
chk "配了内网地址：PDF 打印内网地址" "$rc/$(printf '%s' "$url" | grep -cE '^https://intranet\.invalid/private/weekly-report/report-rev-[0-9]+\.pdf$')" "0/1"
err="$(pub p "$ROOT/pr-1/state.json" 2>&1 >/dev/null)"; rc=$?
chk "含凭证的文件：拒绝，退出码 1，说了原因" "$rc/$(printf '%s' "$err" | grep -c 'state\.json — 内容里有凭证样式')" "1/1"
chk "被拒的文件哪儿都没进" "$(find "$TMP/pub" "$TMP/priv" -name 'state*' | wc -l | tr -d ' ')" "0"
chk "拒绝信息里没有凭证的值" "$(printf '%s' "$err" | grep -c "$FAKE_SECRET")" "0"
err="$(pub p "$ROOT/pr-1/renamed.png" 2>&1 >/dev/null)"; rc=$?
chk "改名成 .png 的凭证文件：同样拒绝" "$rc" "1"
err="$(pub p "$BIG/tail.png" shots 2>&1 >/dev/null)"; rc=$?
chk "33MiB、末尾带凭证的合法图片：拒绝发布，没进公网目录" "$rc/$(find "$TMP/pub" "$TMP/priv" -name 'tail*' | wc -l | tr -d ' ')" "1/0"

echo "④ review-screenshot.mjs：登录状态副本"
PJ="$TMP/proj"; mkdir -p "$PJ/node_modules/@playwright/test" "$PJ/e2e/.auth" "$PJ/tracked" "$TMP/shots"
( cd "$PJ" && git init -q && printf 'e2e/.auth/\nnode_modules/\n' > .gitignore )
echo '{"name":"p"}' > "$PJ/package.json"
echo '{"name":"@playwright/test","main":"index.js"}' > "$PJ/node_modules/@playwright/test/package.json"
cat > "$PJ/node_modules/@playwright/test/index.js" <<'JS'
const fs = require('fs');
const page = { goto: async () => {}, waitForTimeout: async () => {}, evaluate: async () => 400, screenshot: async (o) => fs.writeFileSync(o.path, 'png') };
module.exports = { chromium: { launch: async () => ({
  newContext: async (o) => {
    fs.writeFileSync(process.env.FAKE_PW_LOG, JSON.stringify({ storageState: o.storageState || null,
      mode: o.storageState ? (fs.statSync(o.storageState).mode & 0o777).toString(8) : null,
      origins: o.storageState ? JSON.parse(fs.readFileSync(o.storageState, 'utf8')).origins.map((x) => x.origin) : [] }));
    return { newPage: async () => page };
  },
  close: async () => {},
}) } };
JS
AUTH="$PJ/e2e/.auth/user.json"
printf '{"cookies":[],"origins":[{"origin":"http://localhost:3000","localStorage":[{"name":"t","value":"%s"}]}]}' "$FAKE_SECRET" > "$AUTH"
shot() { ( cd "$PJ" && FAKE_PW_LOG="$TMP/pw.json" TMPDIR="$TMP/systmp" node "$REPO_DIR/scripts/review-screenshot.mjs" --port 4321 --rev r1 --pages '/=home' "$@" ); }
mkdir -p "$TMP/systmp"
shot --out "$TMP/shots" --auth "$AUTH" > "$TMP/shot.out" 2>&1; rc=$?
chk "正常截图：成功，出了图" "$rc/$([ -f "$TMP/shots/home-r1.png" ] && echo 有图)" "0/有图"
clone="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).storageState||"")' "$TMP/pw.json" 2>/dev/null)"
chk "副本写在原件所在的目录里" "$(dirname "$clone")" "$(cd "$PJ/e2e/.auth" && pwd -P)"
chk "副本权限 600，且带上了预览端口的 origin" "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.mode+"/"+j.origins.join(","))' "$TMP/pw.json")" "600/http://localhost:3000,http://127.0.0.1:4321"
chk "结束后副本删了：登录状态目录只剩原件" "$(ls -A "$PJ/e2e/.auth" | tr '\n' ' ')" "user.json "
chk "系统临时目录和截图输出目录里没有登录状态文件" "$(grep -rl "$FAKE_SECRET" "$TMP/systmp" "$TMP/shots" 2>/dev/null | wc -l | tr -d ' ')" "0"
chk "副本落在被 git 忽略的目录里：工作区是干净的" "$(cd "$PJ" && git status --porcelain --untracked-files=all | grep -c 'e2e/')" "0"

( cd "$PJ" && REVIEW_SHOT_TEST_HOLD=1 FAKE_PW_LOG="$TMP/pw.json" exec node "$REPO_DIR/scripts/review-screenshot.mjs" --port 4321 --rev r2 --pages '/=home' --out "$TMP/shots" --auth "$AUTH" ) > "$TMP/hold.out" 2>&1 &
HOLD_PID=$!
held=""
for _ in $(seq 1 50); do
    held="$(sed -n 's/^hold: //p' "$TMP/hold.out" 2>/dev/null | head -1)"
    [ -n "$held" ] && break
    sleep 0.1
done
chk "运行中：副本在登录状态目录里" "$([ -n "$held" ] && [ -f "$held" ] && dirname "$held")" "$(cd "$PJ/e2e/.auth" && pwd -P)"
kill -TERM "$HOLD_PID" 2>/dev/null; wait "$HOLD_PID" 2>/dev/null; HOLD_PID=""
chk "被中断（终止信号）：副本删了" "$([ -n "$held" ] && [ ! -e "$held" ] && echo 删了)/$(ls -A "$PJ/e2e/.auth" | tr '\n' ' ')" "删了/user.json "

cp "$AUTH" "$TMP/shots/auth.json"
shot --out "$TMP/shots" --auth "$TMP/shots/auth.json" > "$TMP/shot.out" 2>&1; rc=$?
chk "原件在截图输出目录里：拒绝（退出码 3），说了原因" "$rc/$(grep -c '在截图输出目录里' "$TMP/shot.out")" "3/1"
chk "拒绝时没有留下副本" "$(ls -A "$TMP/shots" | grep -c 'review-clone')" "0"
rm -f "$TMP/shots/auth.json" "$TMP/shots/home-r1.png"
cp "$AUTH" "$PJ/tracked/user.json"
shot --out "$TMP/shots" --auth "$PJ/tracked/user.json" > "$TMP/shot.out" 2>&1; rc=$?
chk "原件不在被 git 忽略的路径里：拒绝（退出码 3），没截图" "$rc/$(grep -c '不在被 git 忽略的路径里' "$TMP/shot.out")/$(ls "$TMP/shots" | grep -c 'home-r1')" "3/1/0"
chk "拒绝时没有留下副本" "$(ls -A "$PJ/tracked" | tr '\n' ' ')" "user.json "
shot --out "$TMP/shots" > "$TMP/shot.out" 2>&1; rc=$?
chk "不带登录状态：照常截图，不产生任何副本" "$rc/$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).storageState)' "$TMP/pw.json")" "0/null"

echo
echo "结果：$pass 通过，$fail 失败"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
