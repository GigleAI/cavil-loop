#!/usr/bin/env bash
# kind: guard
# reads: repo
# 外部用户文档的链接与锚点（全仓库）。
#
# 跑法：bash tests/doc-links.test.sh        （约 3 秒）
# 依赖：python3（标准库）、git。
#
# 外部用户文档 = README / CONTRIBUTING 中英两份 + docs/ 下一层的 *.md（docs/AGENTS.md 是给 agent 看的，
# 不算）；这份清单和链接 / 锚点的解析都在 tests/lib/doc_links.py，客户端说明测试用的是同一份。
#
# 管五件事：
#   1. 外部用户文档里每条相对链接（含图片）指向的文件都在，带 #锚点 的目标文件里真有那个标题
#   2. prompts/、.agents/ 下的提示词和各级 AGENTS.md 里指向外部用户文档的链接也一样（它们别的链接不归这里管）
#   3. 标题里带行内代码时，锚点按 GitHub 的算法保留代码里的字（只去反引号）——中文安全文档链到运维手册
#      「合并前必须人过目的文件（`AUTOPILOT_HUMAN_PATHS`，…）」一节的链接就是这种，必须算通过
#   4. 每篇外部用户文档都有另一种语言的版本；docs/AGENTS.md 只有英文一份，不算缺
#   5. 改坏了能报出来：删掉一个被链接的标题、加一条指向不存在标题的链接、AGENTS.md 和提示词里的坏链接
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
CHECK="$TEST_DIR/lib/doc_links.py"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3]，实得 [$2]）"; fi; }

# 一棵树上跑整套检查：外部用户文档整篇查，提示词和 AGENTS.md 只查指向外部用户文档的链接。
# 输出：每条通过的链接一行 OK …，每处问题一行；退出码 0 = 没问题
full_check() {   # <root>
    local root="$1" ext others rc=0
    ext=$(python3 "$CHECK" --external "$root") || return 2
    others=$(cd "$root" && git ls-files -co --exclude-standard -- 'prompts/*.md' '.agents/*.md' 'AGENTS.md' '*/AGENTS.md' | sort -u)
    # shellcheck disable=SC2086
    python3 "$CHECK" --list "$root" $ext || rc=1
    # shellcheck disable=SC2086
    python3 "$CHECK" --list --into "$(paste -sd, <<<"$ext")" "$root" $others || rc=1
    return "$rc"
}

echo "== 1/2. 当前仓库：外部用户文档、提示词和 AGENTS.md 里的链接"
out=$(full_check "$REPO_DIR"); rc=$?
problems=$(grep -v '^OK ' <<<"$out")
chk "全仓库没有断链、没有错锚点" "$rc|$problems" "0|"
[ -z "$problems" ] || echo "$problems" | head -20
n_ext=$(grep -c '^OK \(README\|CONTRIBUTING\|docs/\)' <<<"$out")
n_agent=$(grep -c '^OK \(AGENTS.md\|docs/AGENTS.md\|prompts/\|\.agents/\|[^ ]*/AGENTS.md\) ' <<<"$out")
chk "到达性 · 外部用户文档里确实查了很多条链接（≥ 200，实查 $n_ext）" "$([ "$n_ext" -ge 200 ] && echo yes)" yes
chk "到达性 · AGENTS.md / 提示词里指向外部用户文档的链接确实查到了（≥ 5，实查 $n_agent）" "$([ "$n_agent" -ge 5 ] && echo yes)" yes
ext_list=$(python3 "$CHECK" --external "$REPO_DIR")
chk "到达性 · 外部用户文档清单有 README、CONTRIBUTING、docs/ 下的中英文档（≥ 20 篇，实有 $(wc -l <<<"$ext_list" | tr -d ' ')），不含 docs/AGENTS.md" \
    "$([ "$(wc -l <<<"$ext_list")" -ge 20 ] && echo many) $(grep -cxE 'README\.zh\.md|CONTRIBUTING\.md|docs/operations\.md|docs/orchestration\.zh\.md' <<<"$ext_list") $(grep -cx 'docs/AGENTS.md' <<<"$ext_list")" "many 4 0"

echo "== 3. 标题里带行内代码的锚点"
hp=$(grep -E '^OK docs/security\.zh\.md -> operations\.zh\.md#[^ ]*autopilot_human_paths' <<<"$out" | head -1)
chk "中文安全文档 → 运维手册「合并前必须人过目的文件（\`AUTOPILOT_HUMAN_PATHS\`…）」的链接查过且通过" "$([ -n "$hp" ] && echo yes)" yes
[ -n "$hp" ] && echo "    （${hp#OK }）"
mkdir -p "$TMP/u"
cat > "$TMP/u/a.md" <<'MD'
# 标题

## 合并前必须人过目的文件（`AUTOPILOT_HUMAN_PATHS`，GitHub#337）

### Files (`A_B`, x)

## 关于 PR↔Issue 闭环关系：worker 在设计阶段就决定

## 重复

## 重复

```sh
# 不是标题
```

~~~
## 也不是标题
~~~

[a](#合并前必须人过目的文件autopilot_human_pathsgithub337) [b](#files-a_b-x) [c](#关于-prissue-闭环关系worker-在设计阶段就决定)
[d](#重复) [e](#重复-1) `[in code](#不是标题)`

```md
[in fence](#也不是标题)
```
MD
cat > "$TMP/u/b.md" <<'MD'
[1](a.md#不是标题) [2](a.md#也不是标题) [3](a.md#重复-2) [4](a.md#合并前必须人过目的文件github337)
MD
chk "带行内代码 / 下划线 / ↔ 和全角冒号的标题、重复标题的锚点都算对；代码里的链接不查" \
    "$(python3 "$CHECK" "$TMP/u" a.md; echo "rc=$?")" "rc=0"
got=$(python3 "$CHECK" "$TMP/u" b.md; echo "rc=$?")
chk "代码块里的「# …」不算标题、不存在的第三个重复、把代码删掉算出的旧锚点：4 处都报错" \
    "$(grep -c '锚点不存在' <<<"$got") $(tail -1 <<<"$got")" "4 rc=1"

echo "== 4. 中英两份"
chk "每篇外部用户文档都有另一种语言的版本" "$(python3 "$CHECK" --pairs "$REPO_DIR"; echo "rc=$?")" "rc=0"
chk "到达性 · docs/AGENTS.md 存在（它只有英文一份，上面没被当成缺中文版）" "$([ -f "$REPO_DIR/docs/AGENTS.md" ] && echo yes)" yes
mkdir -p "$TMP/p/docs"; touch "$TMP/p/README.md" "$TMP/p/README.zh.md" "$TMP/p/docs/AGENTS.md" "$TMP/p/docs/x.md" "$TMP/p/docs/y.zh.md"
chk "缺中文版、缺英文版的各报一处，docs/AGENTS.md 不报" "$(python3 "$CHECK" --pairs "$TMP/p" | sed 's/:.*//' | paste -sd' ')" "docs/x.md docs/y.zh.md"

echo "== 5. 改坏了能报出来"
# 把当前树（含没提交的改动）复制一份，在副本上改坏
W="$TMP/tree"; mkdir -p "$W"
(cd "$REPO_DIR" && git ls-files -co --exclude-standard -z -- 'README*' 'CONTRIBUTING*' 'docs' 'prompts' '.agents' '*AGENTS.md' \
    'scripts' 'tests' 'client/README.md' 'cavil-loop.config.example' 'setup.sh' 'SKILL*' 'LICENSE' 'systemd' 'launchd' '.githooks' \
    | xargs -0 cp --parents -t "$W" 2>/dev/null)
git -C "$W" init -q 2>/dev/null
chk "副本原样：通过（下面每处报错都是改坏造成的）" "$(full_check "$W" >/dev/null; echo $?)" 0
broken() {   # <说明> <要报出的那一行（整行匹配的正则）> <改坏的命令…>
    local what="$1" want="$2"; shift 2
    local d="$TMP/b$RANDOM"; cp -r "$W" "$d"
    (cd "$d" && "$@") || { bad "$what：改坏的步骤失败"; return; }
    local got; got=$(full_check "$d" | grep -v '^OK ')
    if grep -qE "$want" <<<"$got"; then ok "$what：报出「$(grep -E -m1 "$want" <<<"$got")」"
    else bad "$what：没报出（实得 [$got]）"; fi
}
broken "删掉运维手册里被链接的标题" '^docs/security\.zh\.md: 锚点不存在 operations\.zh\.md#[^ ]*autopilot_human_paths' \
    sed -i '/^### 合并前必须人过目的文件/d' docs/operations.zh.md
broken "外部文档里加一条指向不存在标题的链接" '^docs/client\.md: 锚点不存在 operations\.md#there-is-no-such-section$' \
    sh -c 'echo "[x](operations.md#there-is-no-such-section)" >> docs/client.md'
broken "外部文档里链到不存在的文件" '^README\.zh\.md: 链接指向不存在的文件 docs/nope\.zh\.md$' \
    sh -c 'echo "[x](docs/nope.zh.md)" >> README.zh.md'
broken "根目录 AGENTS.md 里指向外部文档的坏锚点" '^AGENTS\.md: 锚点不存在 docs/operations\.md#nope$' \
    sh -c 'echo "[x](docs/operations.md#nope)" >> AGENTS.md'
broken "提示词里指向外部文档的坏锚点" '^prompts/heavy-test\.md: 锚点不存在 \.\./docs/security\.md#nope$' \
    sh -c 'echo "[x](../docs/security.md#nope)" >> prompts/heavy-test.md'
# 提示词里指向别处的链接不归这里管：占位链接（[原文](链接)）不报
d="$TMP/nope"; cp -r "$W" "$d"; echo "[原文](链接) [y](../scripts/none.sh)" >> "$d/prompts/heavy-test.md"
chk "提示词里不指向外部文档的链接不查（占位链接不误报）" "$(full_check "$d" >/dev/null; echo $?)" 0

echo
report_counts "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
    echo "全部通过（$PASS 项）"
else
    echo "失败 $FAIL 项"
    exit 1
fi
