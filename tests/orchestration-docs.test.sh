#!/usr/bin/env bash
# kind: guard
# 编排文档 docs/orchestration.md / docs/orchestration.zh.md。
#
# 跑法：bash tests/orchestration-docs.test.sh      （约 1 秒）
# 依赖：python3（标准库）。
#
# 管五件事：
#   1. 文中出现的每个设置名（反引号里、代码块里的大写名字）都是 cavil-loop.config.example 里的设置；
#      不是设置的，只能是文中说挂点脚本拿到的环境变量，而且确实由调起那个脚本的地方传进去；
#      按出现位置判断：「拼提示词」一节里写成 ${NAME}、且列在占位符表里的是模板占位符（派工脚本真的把它换掉，
#      由 tests/orchestration-placeholders.test.sh 跑真实派工核对）；挂点一节里读取的变量只认调起那个挂点的脚本真传进去的
#      （配置名不会作为环境变量交给挂点，在那里读它也报错）。每一处出现单独判断，同一行的赋值不掩盖读取。
#      读法、占位符表和判断只在 tests/lib/doc_placeholders.py 一处
#   2. 中英两份提到的名字一样、## / ### 标题数一样
#   3. 折叠块成对、标题（## / ###）不在折叠块里、<summary> 后空一行
#   4. 两个示例脚本（开 PR 后、合并后清理）中英两份一字不差，并且照字面在只有 HOME / PATH 的环境里跑：
#      开 PR 后的脚本真的在那个 PR 上留言；清理脚本只关这个条目带后缀的会话（69 不会误关 695），
#      tmux 没在跑时也正常退出
#   5. 常驻站刷新的两条边界写进了两份文档：关掉合并后清理就不刷新；清理脚本报错照样刷新。
#      这两条行为本身由 tests/project-config-poll.test.sh 跑真实 agent-poll.sh 核对
#   6. 文档里「强制重建常驻站」的命令照字面跑真实 refresh-latest-site.sh（工具装在 ~/.agents/skills/cavil-loop、
#      项目在别处，只有 HOME / PATH）：退出 0、站点真的起来、构建的是主 checkout 工作区里的文件——有没提交的
#      改动时产物里就是它、记下的仍是 HEAD；停在别的分支时是那个分支的内容（文档写明的「不一定是最新主干」）；不带项目配置、在工具目录下跑会找不到配置
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
EN="$REPO_DIR/docs/orchestration.md"
ZH="$REPO_DIR/docs/orchestration.zh.md"
CONF_EX="$REPO_DIR/cavil-loop.config.example"
# 名字、占位符表的读法和按位置的判断只有一份：tests/lib/doc_placeholders.py（派工那个测试也用它）
DP="$TEST_DIR/lib/doc_placeholders.py"

TMP=$(mktemp -d)
trap '[ -n "${KEEP_TMP:-}" ] && echo "TMP=$TMP" || rm -rf "$TMP"' EXIT

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
CODING_AGENT_CONFIG scripts/_lib.sh
TXT

cat > "$TMP/names.py" <<'PY'
import re, sys
FENCE = re.compile(r'^\s*(```|~~~)')

mode, *args = sys.argv[1:]
if mode == 'none':
    pass
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
    out=$(cd "$REPO_DIR" && python3 "$DP" check "$doc" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR"); rc=$?
    chk "$name：每个大写名字都是配置样例里的设置或登记过的挂点环境变量" "$rc|$out" "0|"
    n=$(python3 "$DP" names "$doc" | wc -l | tr -d ' ')
    chk "  到达性 · 确实认出了很多名字（≥ 25，实认 $n）" "$([ "$n" -ge 25 ] && echo yes)" yes
done
for want in WORKTREE_SETUP_CMD PR_CREATED_HOOK CLEANUP_HOOK LATEST_SITE_REFRESH POST_RETROSPECTIVE_PROJECT_CMD AUTO_CLEANUP_ON_MERGE; do
    chk "  到达性 · 认出了 $want" "$(python3 "$DP" names "$EN" | grep -cx "$want")" 1
done
cp "$EN" "$TMP/typo.md"; echo 'Set `LATEST_SITE_REFRSH=true`.' >> "$TMP/typo.md"
out=$(cd "$REPO_DIR" && python3 "$DP" check "$TMP/typo.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR")
chk "拼错的设置名会报出来" "$(grep -c '^LATEST_SITE_REFRSH: 第 [0-9]* 行，不是配置样例里的设置' <<<"$out")/$(wc -l <<<"$out" | tr -d ' ')" "1/1"
sed 's/^PORT .*/PORT scripts\/cleanup-issue.sh/' "$TMP/envs.txt" > "$TMP/envs-bad.txt"
out=$(cd "$REPO_DIR" && python3 "$DP" check "$EN" "$CONF_EX" "$TMP/envs-bad.txt" "$REPO_DIR")
chk "登记的环境变量在那个文件里没传，也会报出来" "$out" "PORT: scripts/cleanup-issue.sh 里没有把它传给挂点脚本"
# 名字按出现位置判断：模板占位符只在「拼提示词」一节（含占位符表）里算数；挂点一节里只认调起它的脚本真传进去的
inject() {   # <out> <section heading prefix> <line>：在这一节标题后插一行
    awk -v h="$2" -v l="$3" '{print} index($0, h) == 1 {print ""; print l}' "$EN" > "$1"
}
inject "$TMP/ph1.md" '## Cleanup on merge' 'The cleanup hook receives `$CONCURRENT_WORK`.'
out=$(cd "$REPO_DIR" && python3 "$DP" check "$TMP/ph1.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR"); rc=$?
chk "清理挂点一节写「收到 \$CONCURRENT_WORK」：占位符表里有这个名字也报出来" "$rc|$(grep -c '^CONCURRENT_WORK: 第 [0-9]* 行在 scripts/cleanup-issue.sh 调起的挂点一节' <<<"$out")" "1|1"
inject "$TMP/ph2.md" '## Cleanup on merge' 'The cleanup hook placeholder `${CONCURRENT_WORK}` is set.'
out=$(cd "$REPO_DIR" && python3 "$DP" check "$TMP/ph2.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR"); rc=$?
chk "清理挂点一节写成 \${CONCURRENT_WORK}、哪怕标明是占位符，也报出来" "$rc|$(grep -c '^CONCURRENT_WORK: ' <<<"$out")" "1|1"
inject "$TMP/ph3.md" '## PR opened' 'The hook also gets `$PORT`.'
out=$(cd "$REPO_DIR" && python3 "$DP" check "$TMP/ph3.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR"); rc=$?
chk "开 PR 后挂点一节写别的挂点才有的 \$PORT：报出来" "$rc|$(grep -c '^PORT: 第 [0-9]* 行在 prompts/issue-comment.template.md 调起的挂点一节' <<<"$out")" "1|1"
inject "$TMP/ph6.md" '## Cleanup on merge' 'The cleanup hook receives `$WORKTREE_SETUP_CMD`.'
out=$(cd "$REPO_DIR" && python3 "$DP" check "$TMP/ph6.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR"); rc=$?
chk "清理挂点一节读一个配置名 \$WORKTREE_SETUP_CMD（设置不会作为环境变量交给挂点）：报出来" "$rc|$(grep -c '^WORKTREE_SETUP_CMD: 第 [0-9]* 行在 scripts/cleanup-issue.sh 调起的挂点一节' <<<"$out")" "1|1"
inject "$TMP/ph7.md" '## Cleanup on merge' 'The cleanup hook receives `$PORT`, falling back to `PORT=5555`.'
out=$(cd "$REPO_DIR" && python3 "$DP" check "$TMP/ph7.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR"); rc=$?
chk "同一行既读 \$PORT 又赋值 PORT=5555：赋值不掩盖读取，报出来" "$rc|$(grep -c '^PORT: 第 [0-9]* 行在 scripts/cleanup-issue.sh 调起的挂点一节' <<<"$out")" "1|1"
inject "$TMP/ph8.md" '## Cleanup on merge' 'Set `CLEANUP_HOOK=.agents/hook.sh` in the config; the hook gets `WORKTREE` and `$ISSUE`.'
chk "挂点一节写配置行、点名设置、读挂点真拿到的变量：放行" "$(cd "$REPO_DIR" && python3 "$DP" check "$TMP/ph8.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR"; echo "rc=$?")" "rc=0"
inject "$TMP/ph4.md" '## Compose prompt' 'A template line may say `${CONCURRENT_WORK}`.'
chk "同一个名字写在「拼提示词」一节：按占位符放行" "$(cd "$REPO_DIR" && python3 "$DP" check "$TMP/ph4.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR"; echo "rc=$?")" "rc=0"
cp "$EN" "$TMP/ph5.md"; echo 'A template may write `${ISSUE_NUMBR}`.' >> "$TMP/ph5.md"
out=$(cd "$REPO_DIR" && python3 "$DP" check "$TMP/ph5.md" "$CONF_EX" "$TMP/envs.txt" "$REPO_DIR")
chk "占位符表里没有的名字写成 \${…} 也报出来" "$(grep -c '^ISSUE_NUMBR: ' <<<"$out")" 1
chk "  到达性 · 占位符表认出了 ≥ 20 个名字，含 \${ISSUE_N}、\${CONCURRENT_WORK}" \
    "$(t=$(python3 "$DP" table "$EN"); [ "$(wc -l <<<"$t")" -ge 20 ] && grep -cxE 'ISSUE_N|CONCURRENT_WORK' <<<"$t")" 2
chk "两份的占位符表一样" "$(diff <(python3 "$DP" table "$EN") <(python3 "$DP" table "$ZH") && echo same)" same

echo "== 2. 中英两份对得上"
chk "两份提到的名字一样" "$(diff <(python3 "$DP" names "$EN") <(python3 "$DP" names "$ZH") && echo same)" same
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

echo "== 6. 强制重建常驻站的命令照字面能跑"
block "$EN" latest-site-force > "$TMP/lsf.en.sh"; block "$ZH" latest-site-force > "$TMP/lsf.zh.sh"
chk "两份文档里的命令一字不差，且是「cd 到项目根目录」加一行命令" \
    "$(cmp -s "$TMP/lsf.en.sh" "$TMP/lsf.zh.sh" && echo same) $(wc -l < "$TMP/lsf.en.sh" | tr -d ' ') $(head -1 "$TMP/lsf.en.sh" | grep -c '^cd /path/to/project ')" "same 2 1"
H="$TMP/h"; mkdir -p "$H/.agents/skills" "$H/fake"
ln -s "$REPO_DIR" "$H/.agents/skills/cavil-loop"
# tmux 替身：new-session 在后台真的跑那条命令；has-session / kill-session 按记下的进程号
cat > "$H/fake/tmux" <<'SH'
#!/usr/bin/env bash
d="$FAKE_TMUX_DIR"; mkdir -p "$d"
case "$1" in
    new-session) shift; s=""; c="."
        while [ $# -gt 1 ]; do case "$1" in -s) s="$2"; shift 2 ;; -c) c="$2"; shift 2 ;; -d) shift ;; *) break ;; esac; done
        ( cd "$c" && exec bash -c "$1" ) </dev/null >/dev/null 2>&1 & echo $! > "$d/$s.pid" ;;
    has-session) s="${3#=}"; [ -f "$d/$s.pid" ] && kill -0 "$(cat "$d/$s.pid")" 2>/dev/null ;;
    kill-session) s="${3#=}"; [ -f "$d/$s.pid" ] && { kill "$(cat "$d/$s.pid")" 2>/dev/null; rm -f "$d/$s.pid"; }; exit 0 ;;
    *) exit 0 ;;
esac
SH
chmod +x "$H/fake/tmux"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
G() { git -c user.email=t@x -c user.name=t "$@"; }
git init -q --bare -b main "$H/origin.git"
git clone -q "$H/origin.git" "$H/proj" 2>/dev/null
(cd "$H/proj" && echo v1 > index.html && G add index.html && G commit -q -m v1 && G push -q origin HEAD:main) >/dev/null 2>&1
cat > "$H/proj/cavil-loop.config" <<CONF
REPO="example/site"
PROJECT_ROOT="$H/proj"
STATE_DIR="$H/state"
TMUX_PREFIX="lsf"
WORKTREE_BASE="$H/wt"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
BASE_BRANCH="main"
LATEST_SITE_PORT=$PORT
LATEST_SITE_BUILD_CMD="cp index.html built.html"
LATEST_SITE_SERVER_CMD="python3 -m http.server --bind 127.0.0.1 $PORT"
PATH="$H/fake:\$PATH"
CONF
printf '%s\n' cavil-loop.config built.html > "$H/proj/.git/info/exclude"
mkdir -p "$H/state"
force_run() {   # 在项目根目录下照字面跑文档的第二行
    (cd "$H/proj" && env -i HOME="$H" PATH="/usr/bin:/bin" FAKE_TMUX_DIR="$H/tmuxd" bash -c "$(sed -n 2p "$TMP/lsf.en.sh")" >/dev/null 2>&1)
}
force_run; rc=$?
chk "照字面跑：退出 0，常驻站真的在监听，构建产物是主干上的内容，记下的是主干当前提交" \
    "$rc $(curl -s --max-time 2 "http://127.0.0.1:$PORT/built.html") $(cat "$H/state/latest-site-commit" 2>/dev/null)" \
    "0 v1 $(git -C "$H/proj" rev-parse HEAD)"
# 工作区有没提交的改动：不快进，构建读的是工作区里的文件（没提交的内容进了产物），记下的仍是 HEAD
echo dirty > "$H/proj/index.html"
force_run; rc=$?
chk "主 checkout 有未提交改动：构建产物是没提交的内容，记下的「已构建提交」仍是 HEAD（文档写明的限制）" \
    "$rc $(curl -s --max-time 2 "http://127.0.0.1:$PORT/built.html") $(cat "$H/state/latest-site-commit" 2>/dev/null)" \
    "0 dirty $(git -C "$H/proj" rev-parse HEAD)"
git -C "$H/proj" checkout -q -- index.html
(cd "$H/proj" && G checkout -q -b other && echo other > index.html && G commit -q -am other) >/dev/null 2>&1
force_run; rc=$?
chk "主 checkout 停在别的分支：不切回主干，构建的是那个分支的内容（主干上没有它）" \
    "$rc $(curl -s --max-time 2 "http://127.0.0.1:$PORT/built.html") $(cat "$H/state/latest-site-commit" 2>/dev/null) $(git -C "$H/proj" merge-base --is-ancestor HEAD origin/main && echo on-main || echo not-on-main)" \
    "0 other $(git -C "$H/proj" rev-parse other) not-on-main"
(cd "$H/.agents/skills/cavil-loop" && env -i HOME="$H" PATH="/usr/bin:/bin" FORCE=1 bash scripts/refresh-latest-site.sh >/dev/null 2>&1); rc=$?
chk "不带项目配置、在工具目录下跑：找不到配置，退出 2（所以文档要带上配置）" "$rc" 2
[ -f "$H/tmuxd/lsf-latest.pid" ] && kill "$(cat "$H/tmuxd/lsf-latest.pid")" 2>/dev/null

echo
report_counts "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
    echo "全部通过（$PASS 项）"
else
    echo "失败 $FAIL 项"
    exit 1
fi
