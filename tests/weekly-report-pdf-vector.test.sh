#!/usr/bin/env bash
# kind: unit
# 周报 PDF 里的趋势图是矢量，不是单倍截图（GitHub#273）。
#
# 跑法：bash tests/weekly-report-pdf-vector.test.sh            （默认回归，~5 s；有浏览器时再加 ~10 s）
#       MUTATION=1 bash tests/weekly-report-pdf-vector.test.sh （再跑 4 项负对照）
# 依赖：bash / python3 / node / git。
#   真出 PDF 的第 4 组另需 playwright 的 chromium 与 poppler（pdfimages / pdftotext）：
#   WEEKLY_REPORT_TEST_PLAYWRIGHT_DIR=<装了 @playwright/test 的项目目录>，不设时试 client/；
#   都没有就只跳过这一组（缩进的 ⏭），其余照跑。
#   WEEKLY_REPORT_TEST_FONTS_DIR=<含周报那四个 woff2 的目录> 时再核对 PDF 里的设计字体。
#
# 原来的毛病：render.py 画的是矢量 SVG，run.sh 把它截成 1280 宽单倍 PNG（GitHub 配图标准），
# topdf.mjs 又把这张 PNG 原样压进 A4——约 180 像素/英寸，放大就糊；图表源随临时目录删掉。
# 现在：render.py 每张图另出一份字体内嵌的矢量版，run.sh 把它和 PNG 同名同戳放进资产目录，
# topdf.mjs 按 PNG 地址取矢量版嵌进 PDF；取不到就报错，--allow-raster 才退回 PNG。
#
#   1. render.py：截 PNG 用的网页源与改动前逐字节一致（GitHub 配图不变）；矢量版图表内容相同、
#      字体内嵌、不带本机路径
#   2. run.sh（真实入口，--dry-run）：矢量版和 PNG 同名同戳进资产目录，公网地址两样都核对 200；
#      矢量版不可达就中止；派工说明写了怎么出矢量 PDF
#   3. topdf.mjs（真实脚本、经本机 HTTP 取图，浏览器换成记录页面的假模块）：四张趋势图换成矢量、
#      其他图片不动、取不到就报错不出 PDF、--allow-raster 退回位图并列出
#   4. 真浏览器出 PDF：默认 0 张位图、坐标文字抽得出；--allow-raster 的对照组正好 4 张
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/mutation.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/mutation.sh"
# shellcheck source=lib/compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/compat.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
SRV_PID=""
cleanup() { [ -z "$SRV_PID" ] || kill "$SRV_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
pass=0; fail=0
QUIET=0
chk() {
    if [ "$2" = "$3" ]; then [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else [ "$QUIET" = 1 ] || { echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; }; fail=$((fail+1)); fi
}

export TZ=Asia/Shanghai
# 浏览器装在真实 HOME 的缓存里（playwright 按 XDG_CACHE_HOME / HOME 找）；下面换掉 HOME 前先记下
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright}"
export HOME="$TMP/home"; mkdir -p "$HOME/.config/cavil-loop"
export CLAUDE_PROJECTS_DIR="$TMP/no-claude" CODEX_SESSIONS_DIR="$TMP/no-codex" XDG_CACHE_HOME="$TMP/cache"
mkdir -p "$CLAUDE_PROJECTS_DIR" "$CODEX_SESSIONS_DIR" "$XDG_CACHE_HOME"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
printf '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
unset GH_TOKEN GITHUB_TOKEN WEEKLY_REPORT_EXTRA_PROJECTS 2>/dev/null || true
REAL_PATH="$PATH"

# ── 被测脚本：本版与合并基线 ──
mkdir -p "$TMP/new" "$TMP/old"
cp -r "$REPO_DIR/scripts" "$TMP/new/"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
git -C "$REPO_DIR" archive "$BASE_REV" scripts | tar -x -C "$TMP/old"

# ── 夹具 ──
# 图表数据：5 周，3.7h 那周的柱顶文字第 4 组拿来证明「图里的字是字」
python3 - "$TMP/data.json" <<'PY'
import json, sys
weeks = ["2025-01-06", "2025-01-13", "2025-01-20", "2025-01-27", "2025-02-03"]
weekly = {}
for i, k in enumerate(weeks):
    weekly[k] = {"iss_open": 10 + i, "iss_closed": 8 + i, "pr_merged": 5 + i,
                 "add": 1000 * (i + 1), "del": 100, "commits": 3, "pr_open": 4,
                 "comments": 100 + i, "human": 10 + i, "bot": 90 + i, "codex": 1,
                 "cost": 700 + i, "wall": [13320, 35640, 36000, 367200, 7200][i], "backlog": 40 + i,
                 "footers": 9, "cost_footers": 9, "outliers": 0, "out": 1000, "sess_med": 60,
                 "tok_in": 1e6, "tok_out": 2e6, "tok_cache_r": 9e7, "tok_cache_w": 3e6}
json.dump({"weeks": weeks, "weekly": weekly,
           "target_week": {"start": weeks[-1], "end": "2025-02-09"},
           "detail": [], "loose_prs": [], "generated_at": "2025-02-10T09:00:00"},
          open(sys.argv[1], "w"))
PY
# 字体：内容是假的（浏览器认不出就回落），只为让 render.py 走「有字体」那条路、看它怎么引用
FONTS="${WEEKLY_REPORT_TEST_FONTS_DIR:-}"
if [ -z "$FONTS" ]; then
    FONTS="$TMP/fonts"; mkdir -p "$FONTS"
    for f in libre-baskerville-400-normal-latin libre-baskerville-700-normal-latin \
             space-grotesk-500-normal-latin space-grotesk-700-normal-latin; do
        printf 'wOF2-fake-%s' "$f" > "$FONTS/$f.woff2"
    done
fi
CHARTS="delivery effort cost token"

# 本机 HTTP 服务（topdf.mjs 走真实的「按公网地址取图」那条路）：绑 0 号端口，打印实际端口
WEB="$TMP/web"; mkdir -p "$WEB"
python3 -I - "$WEB" > "$TMP/port" 2>/dev/null <<'PY' &
import functools, http.server, sys
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
H.log_message = lambda *a: None
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
SRV_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT=$(cat "$TMP/port" 2>/dev/null)
[ -n "$PORT" ] || { echo "本机 HTTP 服务起不来"; exit 1; }
BASE_URL="http://127.0.0.1:$PORT"

# 假浏览器模块：topdf.mjs 用 createRequire(<项目目录>/package.json) 解析 @playwright/test。
# 它不出 PDF，只把浏览器拿到的那个页面原样存一份（<out>.seen.html），并记下有没有被启动。
FAKEPW="$TMP/fakepw"; mkdir -p "$FAKEPW/node_modules/@playwright/test"
echo '{"name":"fake-host"}' > "$FAKEPW/package.json"
echo '{"name":"@playwright/test","main":"index.js"}' > "$FAKEPW/node_modules/@playwright/test/package.json"
cat > "$FAKEPW/node_modules/@playwright/test/index.js" <<'JS'
const fs = require('fs');
exports.chromium = {
  launch: async () => {
    fs.appendFileSync(process.env.FAKE_PW_LOG, 'launch\n');
    const page = {
      goto: async (u) => { page.u = u; },
      evaluate: async () => {},
      pdf: async (o) => {
        fs.copyFileSync(decodeURIComponent(page.u.replace(/^file:\/\//, '')), o.path + '.seen.html');
        fs.writeFileSync(o.path, '%PDF-fake');
      },
    };
    return { newContext: async () => ({ newPage: async () => page }), close: async () => {} };
  },
};
JS
export FAKE_PW_LOG="$TMP/pw.log"

# 报告 markdown：照 report.py 的写法引用四张图（分页标记 + 小节 + 图 + 表），外加一张非趋势图
mkreport() {   # $1 输出  $2 图片地址前缀  $3 戳
    {
        echo "## 上周数据"; echo; echo "结论一句。"; echo
        for n in $CHARTS; do
            echo '<div style="break-before: page"></div>'; echo
            echo "### $n"; echo
            echo "![${n}趋势]($2/$n-$3.png)"; echo
            echo "| 周 | 值 |"; echo "|---|---|"; echo "| 1/6 | 1 |"; echo
        done
        echo "![别的图]($2/other-$3.png)"
    } > "$1"
}

# ══════════════════════════════════════════════════════════════════
# 断言组 1–3：默认对本版跑一遍；负对照对改坏的副本再跑
check_render() {   # $1 根目录
    local root="$1" out="$TMP/r-$RANDOM"
    mkdir -p "$out"
    python3 "$root/scripts/weekly-report/render.py" --data "$TMP/data.json" --out-dir "$out" \
        --asset-url-base x --rev r --fonts-dir "$FONTS" >/dev/null 2>&1
    chk "render.py 跑成功，四张图都有矢量版" \
        "$(for n in $CHARTS; do [ -s "$out/$n.chart.html" ] && echo -n y; done)" "yyyy"
    chk "矢量版不带本机路径（没有 file://）" \
        "$(cat "$out"/*.chart.html 2>/dev/null | grep -c 'file://')" "0"
    chk "矢量版四个字体都内嵌成 data URI（每张图 4 个）" \
        "$(for n in $CHARTS; do grep -o "url('data:font/woff2;base64," "$out/$n.chart.html" 2>/dev/null | wc -l; done | sort -u | tr '\n' ' ')" "4 "
    # 矢量版与截 PNG 那份是同一张图：<body> 整段（标题、说明、SVG）逐字节相同，只有字体引用方式不同
    chk "矢量版的图表内容与截 PNG 的那份逐字节相同" \
        "$(for n in $CHARTS; do python3 -c '
import re, sys
b = lambda p: re.search(r"<body>.*</body>", open(p).read(), re.S).group(0)
print("same" if b(sys.argv[1]) == b(sys.argv[2]) else "diff")' "$out/$n.html" "$out/$n.chart.html" 2>/dev/null || echo err; done | sort -u)" "same"
    rm -rf "$out"
}

check_runsh() {   # $1 根目录
    local root="$1" fx="$TMP/rs"
    rm -rf "$fx"; mkdir -p "$fx/bin" "$fx/assets"
    git init -q --bare "$fx/origin.git"; git init -q "$fx/src"
    git -C "$fx/src" remote add origin "$fx/origin.git"
    echo x > "$fx/src/f"; git -C "$fx/src" add f
    GIT_AUTHOR_DATE="2025-01-06T12:00:00+08:00" GIT_COMMITTER_DATE="2025-01-06T12:00:00+08:00" \
        git -C "$fx/src" commit -qm init; git -C "$fx/src" push -q origin main
    cat > "$HOME/.config/cavil-loop/p.conf" <<EOF
PROJECT_ROOT=$fx/src
WEEKLY_REPORT_REPO=acme/p
WEEKLY_REPORT_ASSET_URL=https://example.invalid/wr
WEEKLY_REPORT_ASSET_DIR=$fx/assets
WEEKLY_REPORT_FONTS_DIR=$FONTS
EOF
    # 假 gh：仓库里什么都没有；假 node：截图出占位 PNG；假 curl：记下核对过的地址，按 $FAKE_404 回 404
    printf '#!/usr/bin/env bash\necho "[]"\n' > "$fx/bin/gh"
    printf '#!/usr/bin/env bash\n[ -f "$3" ] && printf png > "$4"\n' > "$fx/bin/node"
    cat > "$fx/bin/curl" <<'SH'
#!/usr/bin/env bash
url="${@: -1}"; echo "$url" >> "$FAKE_CURL_LOG"
case "$url" in *"${FAKE_404:-<none>}") printf '404' ;; *) printf '200' ;; esac
SH
    chmod +x "$fx/bin/"*
    local rc
    ( cd "$fx" && PATH="$fx/bin:$REAL_PATH" FAKE_CURL_LOG="$fx/curl.log" \
        bash "$root/scripts/weekly-report/run.sh" p --dry-run --week-of 2025-02-03 ) >"$fx/out" 2>&1; rc=$?
    chk "run.sh --dry-run 成功" "$rc" "0"
    [ "$rc" = 0 ] || [ "$QUIET" = 1 ] || sed 's/^/       /' "$fx/out" | tail -5
    local rev; rev=$(ls "$fx/assets" | sed -nE 's/^delivery-(wk-[0-9]+-[0-9]+)\.png$/\1/p')
    chk "GitHub 配图照旧：四张 <名字>-wk-<日期>-<戳>.png 进资产目录" \
        "$(for n in $CHARTS; do [ -s "$fx/assets/$n-$rev.png" ] && echo -n y; done)" "yyyy"
    chk "矢量版和 PNG 同名同戳进资产目录" \
        "$(for n in $CHARTS; do [ -s "$fx/assets/$n-$rev.chart.html" ] && echo -n y; done)" "yyyy"
    chk "资产目录里的矢量版不带本机路径" \
        "$(cat "$fx/assets/"*.chart.html 2>/dev/null | grep -c 'file://')" "0"
    chk "公网地址两样都核对过：4 张 PNG + 4 份矢量版" \
        "$(grep -cE "^https://example.invalid/wr/(delivery|effort|cost|token)-$rev\.(png|chart\.html)$" "$fx/curl.log" 2>/dev/null)" "8"
    chk "派工说明写了：命令不变、自动用矢量版、取不到怎么办" \
        "$(grep -cE 'chart\.html|--allow-raster' "$HOME/weekly-report-dryrun.md" 2>/dev/null | awk '{print ($1>=2)?"yes":"no"}')" "yes"
    rm -f "$fx/curl.log" "$HOME/weekly-report-dryrun.md"
    ( cd "$fx" && PATH="$fx/bin:$REAL_PATH" FAKE_CURL_LOG="$fx/curl.log" FAKE_404=".chart.html" \
        bash "$root/scripts/weekly-report/run.sh" p --dry-run --week-of 2025-02-03 ) >"$fx/out" 2>&1; rc=$?
    chk "矢量版公网不可达 → run.sh 中止（不出报告）" \
        "$rc/$([ -e "$HOME/weekly-report-dryrun.md" ] && echo 出了 || echo 没出)" "1/没出"
    chk "中止的这一轮确实查到了矢量版那一步" "$(grep -c '\.chart\.html$' "$fx/curl.log" 2>/dev/null)" "1"
}

check_topdf() {   # $1 根目录
    local root="$1" rev="wk-20250210-123456" d="$TMP/td"
    rm -rf "$d" "$WEB"/*; mkdir -p "$d" "$WEB/a" "$WEB/old"
    python3 "$root/scripts/weekly-report/render.py" --data "$TMP/data.json" --out-dir "$d" \
        --asset-url-base x --rev r --fonts-dir "$FONTS" >/dev/null 2>&1
    for n in $CHARTS; do
        printf 'png' > "$WEB/a/$n-$rev.png"; cp "$d/$n.chart.html" "$WEB/a/$n-$rev.chart.html" 2>/dev/null
        printf 'png' > "$WEB/old/$n-$rev.png"   # 旧期：只有 PNG
    done
    mkreport "$d/report.md" "$BASE_URL/a" "$rev"
    mkreport "$d/old.md" "$BASE_URL/old" "$rev"

    local rc seen="$d/out.pdf.seen.html"
    rm -f "$FAKE_PW_LOG"
    node "$root/scripts/weekly-report/topdf.mjs" "$FAKEPW" "$d/report.md" "$d/out.pdf" --title T >"$d/o" 2>&1; rc=$?
    chk "有矢量版：topdf 成功、浏览器拿到了页面" "$rc/$([ -s "$seen" ] && echo 有页面)" "0/有页面"
    chk "四张趋势图都换成矢量（4 个独立样式作用域里各有一张 SVG）" \
        "$(python3 -c '
import re, sys
s = open(sys.argv[1]).read()
print(len(re.findall(r"<template shadowrootmode=\"open\">(?:(?!</template>).)*<svg ", s, re.S)))' "$seen" 2>/dev/null)" "4"
    chk "页面里不再引用趋势图 PNG" \
        "$(grep -oE '(delivery|effort|cost|token)-wk-[0-9-]+\.png' "$seen" 2>/dev/null | wc -l)" "0"
    chk "非趋势图片原样保留" "$(grep -c "src=\"$BASE_URL/a/other-$rev.png\"" "$seen" 2>/dev/null)" "1"
    chk "字体声明提到页面顶层（作用域内的 @font-face 浏览器不认）" \
        "$(python3 -c '
import re, sys
s = open(sys.argv[1]).read()
top = s.split("<template", 1)[0]
inner = "".join(re.findall(r"<template.*?</template>", s, re.S))
print(top.count("@font-face"), inner.count("@font-face"))' "$seen" 2>/dev/null)" "4 0"
    chk "图表自己的 body 样式只作用在作用域内（页面顶层没有图表的 1280 宽）" \
        "$(python3 -c '
import sys
s = open(sys.argv[1]).read()
print("width:1280px" in s.split("<template", 1)[0])' "$seen" 2>/dev/null)" "False"

    rm -f "$FAKE_PW_LOG" "$d/old.pdf" "$d/old.pdf.seen.html"
    node "$root/scripts/weekly-report/topdf.mjs" "$FAKEPW" "$d/old.md" "$d/old.pdf" --title T >"$d/o" 2>&1; rc=$?
    chk "取不到矢量版：退出码 1、不出 PDF、浏览器没启动" \
        "$rc/$([ -e "$d/old.pdf" ] && echo 出了 || echo 没出)/$([ -e "$FAKE_PW_LOG" ] && echo 启动了 || echo 没启动)" "1/没出/没启动"
    chk "报错逐张列出取不到的矢量版地址" \
        "$(grep -cE "$BASE_URL/old/(delivery|effort|cost|token)-$rev\.chart\.html：HTTP 404" "$d/o")" "4"

    rm -f "$FAKE_PW_LOG"
    node "$root/scripts/weekly-report/topdf.mjs" "$FAKEPW" "$d/old.md" "$d/old.pdf" --title T --allow-raster >"$d/o" 2>&1; rc=$?
    chk "--allow-raster：成功，四张趋势图按 PNG 放进去，并列出是哪几张" \
        "$rc/$(grep -oE '(delivery|effort|cost|token)-wk-[0-9-]+\.png"' "$d/old.pdf.seen.html" 2>/dev/null | wc -l)/$(grep -c 'HTTP 404' "$d/o")" "0/4/4"
}

run_all() { check_render "$1"; check_runsh "$1"; check_topdf "$1"; }

echo "════ 默认回归 ════"
echo "── 1. render.py：截 PNG 的网页源与改动前逐字节一致 ──"
if ! compat_skip "截 PNG 用的网页源与改动前" "$TMP/old" "$TMP/new" scripts/weekly-report; then
    for side in old new; do
        mkdir -p "$TMP/cmp-$side"
        python3 "$TMP/$side/scripts/weekly-report/render.py" --data "$TMP/data.json" --out-dir "$TMP/cmp-$side" \
            --asset-url-base x --rev r --fonts-dir "$FONTS" >/dev/null 2>&1
    done
    chk "四张图截 PNG 用的网页源与改动前逐字节一致（GitHub 配图不变）" \
        "$(for n in $CHARTS; do cmp -s "$TMP/cmp-old/$n.html" "$TMP/cmp-new/$n.html" && echo -n y; done)" "yyyy"
fi
check_render "$TMP/new"
echo "── 2. run.sh：矢量版随 PNG 发布 ──"
check_runsh "$TMP/new"
echo "── 3. topdf.mjs：换矢量 / 报错 / 显式退回 ──"
check_topdf "$TMP/new"

echo "── 4. 真浏览器出 PDF ──"
PW="${WEEKLY_REPORT_TEST_PLAYWRIGHT_DIR:-}"
[ -n "$PW" ] || { [ -d "$REPO_DIR/client/node_modules/@playwright/test" ] && PW="$REPO_DIR/client"; }
if [ -z "$PW" ] || ! command -v pdfimages >/dev/null || ! command -v pdftotext >/dev/null; then
    echo "  ⏭ 跳过真浏览器这一组：没有 playwright 项目目录（WEEKLY_REPORT_TEST_PLAYWRIGHT_DIR）或没装 poppler"
else
    d="$TMP/td"
    imgs() { pdfimages -list "$1" 2>/dev/null | tail -n +3 | grep -c .; }
    # GitHub 配图照旧：真截一张，宽 1280
    node "$TMP/new/scripts/weekly-report/shot.mjs" "$PW" "$d/delivery.html" "$WEB/a/delivery-wk-20250210-123456.png" >"$d/shot" 2>&1
    chk "真截的 PNG 仍是 1280 宽（GitHub 配图标准不变）" "$(grep -oE '[0-9]+x[0-9]+' "$d/shot" | cut -dx -f1)" "1280"
    for n in effort cost token; do
        node "$TMP/new/scripts/weekly-report/shot.mjs" "$PW" "$d/$n.html" "$WEB/a/$n-wk-20250210-123456.png" >/dev/null 2>&1
        cp "$WEB/a/$n-wk-20250210-123456.png" "$WEB/old/"
    done
    cp "$WEB/a/delivery-wk-20250210-123456.png" "$WEB/old/"
    cp "$WEB/a/delivery-wk-20250210-123456.png" "$WEB/a/other-wk-20250210-123456.png"
    cp "$WEB/a/delivery-wk-20250210-123456.png" "$WEB/old/other-wk-20250210-123456.png"
    node "$TMP/new/scripts/weekly-report/topdf.mjs" "$PW" "$d/report.md" "$d/v.pdf" --title T >"$d/o" 2>&1
    chk "默认出 PDF：成功" "$?" "0"
    chk "PDF 里只剩那张非趋势图是位图（四张趋势图 0 张）" "$(imgs "$d/v.pdf")" "1"
    chk "图里的坐标 / 柱顶文字是字（抽得出 3.7h 和面板标题）" \
        "$(pdftotext "$d/v.pdf" - 2>/dev/null | grep -cE '^3\.7h$|交付节奏' | awk '{print ($1>=2)?"yes":"no"}')" "yes"
    node "$TMP/new/scripts/weekly-report/topdf.mjs" "$PW" "$d/old.md" "$d/r.pdf" --title T --allow-raster >/dev/null 2>&1
    chk "对照组（--allow-raster、只有 PNG）：位图 5 张 = 4 张趋势图 + 1 张非趋势图" "$(imgs "$d/r.pdf")" "5"
    if [ -n "${WEEKLY_REPORT_TEST_FONTS_DIR:-}" ] && command -v pdffonts >/dev/null; then
        chk "PDF 用上了图表的设计字体（Libre Baskerville、Space Grotesk）" \
            "$(pdffonts "$d/v.pdf" | grep -cE 'LibreBaskerville|SpaceGrotesk' | awk '{print ($1>=2)?"yes":"no"}')" "yes"
    fi
fi

# ══════════════════════════════════════════════════════════════════
echo "════ 负对照 ════"
REAL_PASS=$pass; REAL_FAIL=$fail; mut_ran=0; mut_fail=0
mutant() {   # $1 名字 $2 文件（相对根目录）$3 原文 $4 改成 → 打印副本根目录；原文不在就失败
    local m="$TMP/mut-$1"; rm -rf "$m"; mkdir -p "$m"; cp -r "$TMP/new/scripts" "$m/"
    python3 - "$m/$2" "$3" "$4" <<'PY' || return 1
import sys
p, old, new = sys.argv[1:]
s = open(p).read()
if s.count(old) != 1:
    sys.exit("原文出现 %d 次" % s.count(old))
open(p, "w").write(s.replace(old, new))
PY
    printf '%s' "$m"
}
mut() {   # $1 名字 $2 说明 $3 文件 $4 原文 $5 改成 $6 跑哪一组
    mutation_gate || return 0
    mut_ran=$((mut_ran + 1))
    local m
    if ! m=$(mutant "$1" "$3" "$4" "$5"); then
        echo "  ❌ 负对照准备失败 [$1]：$3 里找不到要改的原文"; mut_fail=$((mut_fail + 1)); return
    fi
    pass=0; fail=0; QUIET=1; "$6" "$m"; QUIET=0
    if [ "$fail" -gt 0 ]; then echo "  ✅ 负对照拦下 [$1] $2（$fail 条变红）"
    else echo "  ❌ 负对照没拦下 [$1] $2"; mut_fail=$((mut_fail + 1)); fi
}
mut no-swap "topdf 不换矢量（照旧放 PNG）" scripts/weekly-report/topdf.mjs \
    'outHtml = outHtml.replace(m[0], () => c.html);' 'void c;' check_topdf
mut silent-fallback "取不到矢量版时悄悄退回 PNG" scripts/weekly-report/topdf.mjs \
    'if (!allowRaster) {' 'if (false) {' check_topdf
mut no-publish "run.sh 不把矢量版放进资产目录" scripts/weekly-report/run.sh \
    'cp "$WORK/$n.chart.html" "$ASSET_DIR/$n-$REV.chart.html"' ':' check_runsh
mut local-path "矢量版仍按本机路径引用字体" scripts/weekly-report/render.py \
    'if embed:' 'if False:' check_render
pass=$REAL_PASS; fail=$REAL_FAIL

echo
mutation_summary "$0"
compat_summary
echo "正式版：$pass 通过 / $fail 失败；负对照失效 $mut_fail 条（本次跑了 $mut_ran 条）"
REPORT_REGRESS_ONLY=1 report_counts "$pass" "$fail" "$mut_ran" "$mut_fail"
[ "$fail" -eq 0 ] && [ "$mut_fail" -eq 0 ]
