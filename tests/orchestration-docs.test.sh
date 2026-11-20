#!/usr/bin/env bash
# kind: guard
# 编排文档 docs/orchestration.md / docs/orchestration.zh.md。
#
# 跑法：bash tests/orchestration-docs.test.sh      （约 1 秒）
# 依赖：python3（标准库）。
#
# 管五件事：
#   1. 文中出现的每个设置名（反引号里、代码块里的大写名字）都是 cavil-loop.config.example 里的设置；
#      不是设置的，只能是文中说挂点脚本拿到的环境变量，而且确实由调起那个脚本的地方传进去
#   2. 中英两份提到的名字一样、## / ### 标题数一样
#   3. 折叠块成对、标题（## / ###）不在折叠块里、<summary> 后空一行
#   4. 两个示例脚本（开 PR 后、合并后清理）中英两份一字不差，并且照字面在只有 HOME / PATH 的环境里跑：
#      开 PR 后的脚本真的在那个 PR 上留言；清理脚本只关这个条目带后缀的会话（69 不会误关 695），
#      tmux 没在跑时也正常退出
#   5. 常驻站刷新的两条边界写进了两份文档：关掉合并后清理就不刷新；清理脚本报错照样刷新。
#      这两条行为本身由 tests/project-config-poll.test.sh 跑真实 agent-poll.sh 核对
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
EN="$REPO_DIR/docs/orchestration.md"
ZH="$REPO_DIR/docs/orchestration.zh.md"
CONF_EX="$REPO_DIR/cavil-loop.config.example"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3]，实得 [$2]）"; fi; }

# 挂点脚本拿到的环境变量：名字 → 把它传给脚本的那个文件（文件里必须出现「名字=」或「"名字"」）
cat > "$TMP/envs.txt" <<'TXT'
PR prompts/issue-comment.template.md
ISSUE prompts/issue-comment.template.md scripts/cleanup-issue.sh
WORKTREE prompts/issue-comment.template.md scripts/cleanup-issue.sh
BRANCH prompts/issue-comment.template.md scripts/cleanup-issue.sh
REPO prompts/issue-comment.template.md scripts/cleanup-issue.sh
PROJECT_ROOT prompts/issue-comment.template.md scripts/cleanup-issue.sh
RETROSPECTIVE_PR scripts/post-merge-retrospective.py
RETROSPECTIVE_LESSONS_FILE scripts/post-merge-retrospective.py
RETROSPECTIVE_REPORT_FILE scripts/post-merge-retrospective.py
PORT scripts/preview-run.sh
HOST scripts/preview-run.sh
FORCE scripts/refresh-latest-site.sh
TXT

cat > "$TMP/names.py" <<'PY'
import re, sys
FENCE = re.compile(r'^\s*(```|~~~)')

def names(path):
    out, fence = set(), False
    for line in open(path, encoding='utf-8'):
        if FENCE.match(line):
            fence = not fence
            continue
        if fence:
            m = re.match(r'^\s*([A-Z][A-Z0-9_]{1,})=', line)
            if m:
                out.add(m.group(1))
            continue
        for code in re.findall(r'`([^`]+)`', line):
            code = code.strip()
            m = re.match(r'^\$?\{?([A-Z][A-Z0-9_]{1,})\}?(=.*)?$', code) or re.match(r'^([A-Z][A-Z0-9_]{1,})=', code)
            if m:
                out.add(m.group(1))
            for v in re.findall(r'\$\{?([A-Z][A-Z0-9_]{1,})\}?', code):
                out.add(v)
    return out

def config_keys(path):
    return set(re.findall(r'^\s*#?\s*([A-Z][A-Z0-9_]{1,})=', open(path, encoding='utf-8').read(), re.M))

mode, *args = sys.argv[1:]
if mode == 'names':
    print('\n'.join(sorted(names(args[0]))))
elif mode == 'check':   # <doc> <config example> <envs.txt> <repo>
    doc, conf, envs, repo = args
    keys = config_keys(conf)
    env = {}
    for line in open(envs):
        n, *files = line.split()
        env[n] = files
    bad = []
    for n in sorted(names(doc)):
        if n in keys:
            continue
        if n not in env:
            bad.append(f'{n}: 不是配置样例里的设置，也不是登记过的挂点环境变量')
            continue
        for f in env[n]:
            text = open(f'{repo}/{f}', encoding='utf-8').read()
            if not re.search(rf'(^|[^A-Z0-9_]){n}=|["\']{n}["\']', text):
                bad.append(f'{n}: {f} 里没有把它传给挂点脚本')
    if bad:
        print('\n'.join(bad))
    sys.exit(1 if bad else 0)
elif mode == 'layout':   # <doc>: folds balanced, no heading inside a fold, blank line after <summary>
    depth, bad, lines = 0, [], open(args[0], encoding='utf-8').read().splitlines()
    fence = False
    for i, line in enumerate(lines, 1):
        if FENCE.match(line):
            fence = not fence
        if fence:
            continue
        depth += line.count('<details>') - line.count('</details>')
        if depth < 0:
            bad.append(f'{i}: 多出一个 </details>')
            depth = 0
        if depth and re.match(r'^#{1,6} ', line):
            bad.append(f'{i}: 标题在折叠块里：{line}')
        if '</summary>' in line and i < len(lines) and lines[i].strip():
            bad.append(f'{i}: <summary> 后没空一行')
    if depth:
        bad.append(f'折叠块没闭合（还差 {depth} 个 </details>）')
    if bad:
        print('\n'.join(bad))
    sys.exit(1 if bad else 0)
PY

echo "== 1. 文中的设置名都存在"
for doc in "$EN" "$ZH"; do
    name=${doc#"$REPO_DIR"/}
    out=$(cd "$REPO_DIR" && python3 "$TMP/names.py" check "$doc" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR"); rc=$?
    chk "$name：每个大写名字都是配置样例里的设置或登记过的挂点环境变量" "$rc|$out" "0|"
    n=$(python3 "$TMP/names.py" names "$doc" | wc -l | tr -d ' ')
    chk "  到达性 · 确实认出了很多名字（≥ 25，实认 $n）" "$([ "$n" -ge 25 ] && echo yes)" yes
done
for want in WORKTREE_SETUP_CMD PR_CREATED_HOOK CLEANUP_HOOK LATEST_SITE_REFRESH POST_RETROSPECTIVE_PROJECT_CMD AUTO_CLEANUP_ON_MERGE; do
    chk "  到达性 · 认出了 $want" "$(python3 "$TMP/names.py" names "$EN" | grep -cx "$want")" 1
done
cp "$EN" "$TMP/typo.md"; echo 'Set `LATEST_SITE_REFRSH=true`.' >> "$TMP/typo.md"
out=$(cd "$REPO_DIR" && python3 "$TMP/names.py" check "$TMP/typo.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR")
chk "拼错的设置名会报出来" "$out" "LATEST_SITE_REFRSH: 不是配置样例里的设置，也不是登记过的挂点环境变量"
sed 's/^PORT .*/PORT scripts\/cleanup-issue.sh/' "$TMP/envs.txt" > "$TMP/envs-bad.txt"
out=$(cd "$REPO_DIR" && python3 "$TMP/names.py" check "$EN" "$CONF_EX" "$TMP/envs-bad.txt" "$REPO_DIR")
chk "登记的环境变量在那个文件里没传，也会报出来" "$out" "PORT: scripts/cleanup-issue.sh 里没有把它传给挂点脚本"

echo "== 2. 中英两份对得上"
chk "两份提到的名字一样" "$(diff <(python3 "$TMP/names.py" names "$EN") <(python3 "$TMP/names.py" names "$ZH") && echo same)" same
chk "两份的 ## / ### 标题数一样" "$(grep -c '^##\{1,2\} ' "$EN")" "$(grep -c '^##\{1,2\} ' "$ZH")"
chk "两份的折叠块数一样" "$(grep -c '<details>' "$EN")" "$(grep -c '<details>' "$ZH")"

echo "== 3. 版式"
for doc in "$EN" "$ZH"; do
    name=${doc#"$REPO_DIR"/}
    chk "$name：折叠块成对、标题不在折叠块里、<summary> 后空一行" "$(python3 "$TMP/names.py" layout "$doc"; echo "rc=$?")" "rc=0"
done
printf '## a\n\n<details><summary>x</summary>\n### hidden\n\n</details>\n<details>\n' > "$TMP/badlayout.md"
chk "坏版式（没空行、标题在折叠块里、没闭合）三处都报出来" "$(python3 "$TMP/names.py" layout "$TMP/badlayout.md" | wc -l | tr -d ' ')" 3

echo "== 4. 示例脚本照字面能跑"
block() {   # <doc> <name>：标记之间、代码围栏里的内容
    awk -v b="<!-- orchestration-example:$2:begin -->" -v e="<!-- orchestration-example:$2:end -->" '
        $0 == b {on = 1; next} $0 == e {on = 0} on && /^```/ {f = !f; next} on && f' "$1"
}
for ex in pr-created-hook cleanup-hook; do
    block "$EN" "$ex" > "$TMP/$ex.en.sh"; block "$ZH" "$ex" > "$TMP/$ex.zh.sh"
    chk "$ex：两份文档里的示例一字不差，且不是空的" \
        "$(cmp -s "$TMP/$ex.en.sh" "$TMP/$ex.zh.sh" && [ -s "$TMP/$ex.en.sh" ] && echo same)" same
done
mkdir -p "$TMP/bin"
# 假 gh：把参数一行一个记下来
cat > "$TMP/bin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_LOG"
SH
# 假 tmux：list-sessions 打印 $FAKE_SESSIONS 里的会话（文件不在 = 没有 tmux 服务，失败退出），kill-session 记下目标
cat > "$TMP/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in
    list-sessions) [ -f "$FAKE_SESSIONS" ] || { echo "no server running" >&2; exit 1; }; cat "$FAKE_SESSIONS" ;;
    kill-session) echo "$3" >> "$FAKE_LOG" ;;
    *) exit 2 ;;
esac
SH
chmod +x "$TMP/bin/gh" "$TMP/bin/tmux"
P="$TMP/bin:/usr/bin:/bin"
env -i HOME="$TMP" PATH="$P" FAKE_LOG="$TMP/gh.log" PR=42 ISSUE=7 WORKTREE="$TMP/wt" BRANCH=feature/issue-7 REPO=octo/app PROJECT_ROOT="$TMP/wt" \
    bash "$TMP/pr-created-hook.en.sh"; rc=$?
chk "开 PR 后的示例：退出 0，在 PR #42 上留了一条带预览地址的评论" "$rc|$(paste -sd'|' "$TMP/gh.log" 2>/dev/null)" \
    "0|pr|comment|42|--repo|octo/app|--body|Preview of feature/issue-7: https://preview.example.com/pr-42/"
printf '%s\n' myproj-issue69 myproj-issue69-server myproj-issue695-server myproj-issue69-e2e other-issue69-server > "$TMP/sessions"
env -i HOME="$TMP" PATH="$P" FAKE_LOG="$TMP/tmux.log" FAKE_SESSIONS="$TMP/sessions" ISSUE=69 WORKTREE="$TMP/wt" BRANCH=feature/issue-69 REPO=octo/app PROJECT_ROOT="$TMP/p" \
    bash "$TMP/cleanup-hook.en.sh"; rc=$?
chk "清理示例：只关 #69 带后缀的两个会话，不碰 #695、不碰不带后缀的 worker 会话" "$rc|$(paste -sd'|' "$TMP/tmux.log" 2>/dev/null)" \
    "0|=myproj-issue69-server|=myproj-issue69-e2e"
rm -f "$TMP/tmux.log"
env -i HOME="$TMP" PATH="$P" FAKE_LOG="$TMP/tmux.log" FAKE_SESSIONS="$TMP/none" ISSUE=69 bash "$TMP/cleanup-hook.en.sh"; rc=$?
chk "清理示例：tmux 没在跑时也退出 0，什么都不关" "$rc|$([ -e "$TMP/tmux.log" ] && echo killed)" "0|"

echo "== 5. 常驻站刷新的两条边界写进了文档"
chk "英文：关掉合并后清理不刷新、清理脚本报错照样刷新" \
    "$(grep -c 'Cleanup on merge off (`AUTO_CLEANUP_ON_MERGE=false`), refresh on | No' "$EN") $(grep -c 'The cleanup script fails .* | Yes' "$EN")" "1 1"
chk "中文：关掉合并后清理不刷新、清理脚本报错照样刷新" \
    "$(grep -c '合并后清理关着（`AUTO_CLEANUP_ON_MERGE=false`），刷新开着 | 不刷新' "$ZH") $(grep -c '清理脚本报错.* | 照样刷新' "$ZH")" "1 1"

echo
report_counts "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
    echo "全部通过（$PASS 项）"
else
    echo "失败 $FAIL 项"
    exit 1
fi
