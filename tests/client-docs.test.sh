#!/usr/bin/env bash
# kind: guard
# 客户端使用说明（GitHub#475）：docs/client.md / docs/client.zh.md、两份 README 的客户端一节、
# 开发文档 client/README.md 里指向它们的链接。
#
# 跑法：bash tests/client-docs.test.sh
# 依赖：python3（标准库）。
#
# 管四件事：
#   1. 这几份文档里指向仓库内文件的相对链接（含图片）都存在；带 #锚点 的，目标文件里真有那个标题
#      （按 GitHub 生成锚点的规则算，解析在 tests/lib/doc_links.py，和全仓库链接检查共用），同一页内的 #锚点 也一样
#   2. docs/client-screens/ 里的每张图都被中英两份说明引用，两份引用的图一模一样；两份 README 引用的图也一样
#   3. 中英两份说明的 ## 章节数相同，「正在开发中」一节列的 issue 编号相同
#   4. 网络边界的说法：四份对外文档（两份 README、两份说明）都写到远程 daemon 的三段连接（打开添加窗口就探测
#      每台在线设备、只连选定 / 已配对的机器、不带 GitHub 凭据），且没有「配对前没有任何连接」的旧说法
# 另把检查器喂一份坏文档（断链、错锚点、缺图），它必须报错——证明上面的「全过」不是什么都没查。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

# 链接与锚点的解析和全仓库链接检查（tests/doc-links.test.sh）共用一份：tests/lib/doc_links.py
CHECK="$TEST_DIR/lib/doc_links.py"

echo "== 1. 相对链接与锚点"
DOCS=(README.md README.zh.md docs/client.md docs/client.zh.md client/README.md)
if out=$(python3 "$CHECK" "$REPO_DIR" "${DOCS[@]}" 2>&1); then
    ok "${#DOCS[@]} 份文档里的相对链接、图片和锚点都找得到"
else
    bad "有断链："; echo "$out" | head -20
fi

# the checker refuses a broken document (so the pass above checked something)
mkdir -p "$TMP/bad/docs"
cat > "$TMP/bad/docs/x.md" <<'MD'
# 标题

## 第一次用（只用客户端）

[ok](#第一次用只用客户端) [missing file](nope.md) [bad anchor](#没有这一节) ![gone](client-screens/none.png)
`[in code](ignored.md)`
MD
if out=$(python3 "$CHECK" "$TMP/bad" docs/x.md 2>&1); then
    bad "检查器放过了一份坏文档"
else
    n=$(printf '%s\n' "$out" | grep -c .)
    if [ "$n" -eq 3 ] && ! grep -q 'ignored.md\|第一次用只用客户端' <<<"$out"; then
        ok "检查器对坏文档报出 3 处（缺文件、错锚点、缺图），没误报代码里的和正确的锚点"
    else
        bad "检查器对坏文档的报告不对："; echo "$out"
    fi
fi

echo "== 2. 截图"
imgs_of() { grep -o 'client-screens/[A-Za-z0-9._-]*\.png' "$1" | sed 's#.*/##' | sort -u; }
on_disk=$(cd "$REPO_DIR/docs/client-screens" 2>/dev/null && ls ./*.png 2>/dev/null | sed 's#^\./##' | sort -u)
if [ -n "$on_disk" ]; then
    ok "docs/client-screens 里有 $(printf '%s\n' "$on_disk" | wc -l) 张图"
else
    bad "docs/client-screens 里没有图"
fi
en=$(imgs_of "$REPO_DIR/docs/client.md"); zh=$(imgs_of "$REPO_DIR/docs/client.zh.md")
if [ "$en" = "$zh" ]; then ok "中英两份说明引用同一组图"; else bad "中英两份说明引用的图不同：en=[$en] zh=[$zh]"; fi
if [ "$en" = "$on_disk" ]; then ok "docs/client-screens 里每张图都被说明引用，说明引用的图都在"; else bad "说明引用的图 [$en] 和目录里的图 [$on_disk] 不一致"; fi
ren=$(imgs_of "$REPO_DIR/README.md"); rzh=$(imgs_of "$REPO_DIR/README.zh.md")
if [ -n "$ren" ] && [ "$ren" = "$rzh" ]; then ok "两份 README 引用同一组截图（$(printf '%s ' $ren)）"; else bad "两份 README 引用的截图不同或没有：en=[$ren] zh=[$rzh]"; fi

echo "== 3. 中英两份说明结构一致"
h_en=$(grep -c '^## ' "$REPO_DIR/docs/client.md"); h_zh=$(grep -c '^## ' "$REPO_DIR/docs/client.zh.md")
if [ "$h_en" = "$h_zh" ] && [ "$h_en" -gt 5 ]; then ok "两份都是 $h_en 个 ## 章节"; else bad "章节数不同：en=$h_en zh=$h_zh"; fi
dev_issues() { awk -v h="$2" '$0 ~ "^## " {on = ($0 == h)} on' "$1" | grep -o 'issues/[0-9]*' | sort -u; }
d_en=$(dev_issues "$REPO_DIR/docs/client.md" '## In progress')
d_zh=$(dev_issues "$REPO_DIR/docs/client.zh.md" '## 正在开发中')
if [ -n "$d_en" ] && [ "$d_en" = "$d_zh" ]; then ok "「正在开发中」两份列的 issue 相同（$(printf '%s\n' "$d_en" | wc -l) 个）"; else bad "「正在开发中」两份列的 issue 不同：en=[$d_en] zh=[$d_zh]"; fi

echo "== 4. 网络边界写到远程 daemon（GitHub#475 PR #485 复审第 1 轮：未配对时打开添加窗口也会探测在线设备）"
# 每份页面都要写到三段：打开添加窗口时探测每台在线设备、只连选定 / 已配对的机器、不带 GitHub 凭据；
# 不得再出现「只有配对后才连」这类绝对说法。
net_check() { # file  probe-phrase  picked-phrase  cred-phrase
    local f="$REPO_DIR/$1" miss=""
    grep -q "$2" "$f" || miss="$miss「$2」"
    grep -q "$3" "$f" || miss="$miss「$3」"
    grep -q "$4" "$f" || miss="$miss「$4」"
    if [ -z "$miss" ]; then ok "$1 写了添加窗口的探测、只连选定 / 已配对的机器、不带 GitHub 凭据"; else bad "$1 缺：$miss"; fi
    if grep -qiE '只有人主动配对|没配对时没有|only after you pair' "$f"; then bad "$1 还有「配对前没有任何连接」的旧说法"; else ok "$1 没有「配对前没有任何连接」的旧说法"; fi
}
net_check README.zh.md       '每台在线设备' '选定的那一台' '不带 GitHub 凭据'
net_check docs/client.zh.md  '每台在线设备' '选定的那一台' '不带 GitHub 凭据'
net_check README.md          'every online device' 'the one machine you picked' 'never with a GitHub credential'
net_check docs/client.md     'every online device' 'the one machine picked' 'carries a GitHub credential'

echo
report_counts "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
    echo "全部通过（$PASS 项）"
else
    echo "失败 $FAIL 项"
    exit 1
fi
