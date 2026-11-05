#!/usr/bin/env bash
# 分支被「主 checkout」占用时的提示与自动释放（GitHub#141）。
#
# 跑法：bash tests/branch-holder.test.sh            （默认回归，~30 s）
#       MUTATION=1 bash tests/branch-holder.test.sh （再跑负对照：改坏一处，对应场景必须变红）
# 依赖：git、jq。不碰网络、不调真 gh：每个场景自造上游 bare 仓库 + 主 checkout，跑**真的**
# scripts/dispatch-pr-comment.sh / create-worktree.sh，假 gh / tmux 只记录调用。
#
# 场景（方案验收 1–12）：
#   主 checkout 干净一致：开关关 → 提示 switch；开关开 → 自动切回并建好 worktree
#   脏 / 未跟踪 / 领先 / 落后 / bisect 中 / 拿不到 PR 提交 → 开关开也不动，提示里写现状
#   检查后、切换前插入同名被忽略文件 → git 拒绝，文件原样，不派工
#   项目配置在附加目录 B、分支被主目录 A 占着 → A 不动；配置写成指向 A 的符号链接 → 视为同一目录
#   项目配置在附加目录 B、B 自己占着分支 → 附加 worktree 不动
#   base 被另一个 worktree 签出 → 不切，提示占着 base 的路径
#   submodule → 提示真实目录（不含 .git/modules）；干净时能自动释放
#   新 issue 建 worktree 那条路 → 只给 switch 提示，开关开也不切
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

ROOT=$(mktemp -d)
cleanup() { [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$ROOT"; return 0; }; rm -rf "$ROOT"; }
trap cleanup EXIT

REAL_GIT=$(command -v git)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export TZ=UTC

FAKEBIN="$ROOT/bin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/gh" <<'FAKEGH'
#!/usr/bin/env bash
# 一次调用记一行（评论正文是多行的，按行 grep 才不会只看到第一行）
{ printf '%s' "gh $*" | tr '\n' ' '; printf '\n'; } >> "$GH_CALLS"
exit 0
FAKEGH
cat > "$FAKEBIN/tmux" <<'FAKETMUX'
#!/usr/bin/env bash
printf '%s\n' "tmux $*" >> "$GH_CALLS"
case "$1" in has-session) exit 1 ;; esac
exit 0
FAKETMUX
# 受控交错用的 git 包装器：遇到参数里有 $INTERLEAVE_ON 的那次 git 调用（只触发一次），
# 先用真 git 跑 $INTERLEAVE_DO（$G = 真 git），再原样执行原命令。生产代码里没有任何测试钩子。
INTERBIN="$ROOT/interbin"
mkdir -p "$INTERBIN"
cat > "$INTERBIN/git" <<FAKEGIT
#!/usr/bin/env bash
if [ -n "\${INTERLEAVE_ON:-}" ] && [ ! -e "\$INTERLEAVE_ONCE" ]; then
    for a in "\$@"; do
        if [ "\$a" = "\$INTERLEAVE_ON" ]; then
            : > "\$INTERLEAVE_ONCE"
            G="$REAL_GIT" bash -c "\$INTERLEAVE_DO" >/dev/null 2>&1
            break
        fi
    done
fi
exec "$REAL_GIT" "\$@"
FAKEGIT
chmod +x "$FAKEBIN/gh" "$FAKEBIN/tmux" "$INTERBIN/git"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail+1)); }
chk()     { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望 [$3]，实得 [$2]"; fi; }
chk_has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "找不到 [$3]"; esac; }
chk_not() { case "$2" in *"$3"*) bad "$1" "不该出现 [$3]" ;; *) ok "$1" ;; esac; }

# ── 场景构造 ────────────────────────────────────────────────────────────────
# mk_repo <dir>：上游 bare（main 上跟踪 f.txt 和 gen.txt）+ 主 checkout clone 到 <dir>/project，
# 并在主 checkout 里开 feature/issue-$N、提交、push 成分支和 refs/pull/$N/head（GitHub 的 PR 引用形状）。
# PR 分支删掉 gen.txt 并把它加进 .gitignore：受控交错场景就靠它（main 跟踪、PR 分支忽略）。
N=34
BR="feature/issue-$N"
mk_upstream() {
    local d="$1"
    git init -q --bare -b main "$d/upstream.git"
    git clone -q "$d/upstream.git" "$d/seed" 2>/dev/null
    (
        cd "$d/seed"
        echo hello > f.txt; echo committed-base > gen.txt
        git add f.txt gen.txt; git commit -qm init; git push -q origin HEAD:main
    )
}
mk_pr_branch() {   # 在 <checkout> 里开 PR 分支并推上去
    local co="$1"
    (
        cd "$co"
        git switch -qc "$BR"
        git rm -q gen.txt; echo gen.txt > .gitignore; echo pr > pr.txt
        git add .gitignore pr.txt; git commit -qm pr
        git push -q origin "$BR" "$BR:refs/pull/$N/head"
    )
}
# write_conf <case dir> <project root> <auto 0|1> [extra PATH dir]
write_conf() {
    local c="$1" root="$2" auto="$3" extra="${4:-}"
    # 夹具自检：场景目录必须是 $ROOT 下已存在的绝对路径，否则下面会把文件写到别处
    case "$c" in "$ROOT"/*) ;; *) echo "夹具错误：场景目录不在沙盘里：[$c]" >&2; exit 2 ;; esac
    [ -d "$c" ] || { echo "夹具错误：场景目录不存在：[$c]" >&2; exit 2; }
    mkdir -p "$c/state" "$c/wt"
    cat > "$c/cavil-loop.config" <<CONF
REPO="example/none"
PROJECT_ROOT="$root"
WORKTREE_BASE="$c/wt"
STATE_DIR="$c/state"
TMUX_PREFIX="holdertest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
AUTO_RELEASE_MAIN_CHECKOUT=$auto
PATH="${extra:+$extra:}$FAKEBIN:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    chmod 600 "$c/cavil-loop.config"
    : > "$c/gh-calls.log"
}
SCRIPTS="$REPO_DIR/scripts"
# run_pr <case dir>：在 PROJECT_ROOT 里跑真的 dispatch-pr-comment.sh（Case C：tmux 一律「不存在」）
run_pr() {
    local c="$1" root
    root=$(sed -n 's/^PROJECT_ROOT="\(.*\)"$/\1/p' "$c/cavil-loop.config")
    (cd "$root" && GH_CALLS="$c/gh-calls.log" CODING_AGENT_CONFIG="$c/cavil-loop.config" \
        bash "$SCRIPTS/dispatch-pr-comment.sh" "$N" "$BR" 0 >/dev/null 2>&1)
    echo $?
}
cur_branch() { git -C "$1" symbolic-ref -q --short HEAD 2>/dev/null || echo "(detached)"; }
comments() { grep -- "-X POST repos/example/none/issues/$N/comments" "$1/gh-calls.log" || true; }
labels()   { grep -- "/issues/$N/labels" "$1/gh-calls.log" || true; }
n_holders() { git -C "$1" worktree list --porcelain | grep -c "^branch refs/heads/$BR$"; }

# 标准场景：主 checkout 停在 PR 分支上、干净、与 PR 一致
# 每次都建全新目录：负对照会把同一个场景再跑一遍，目录名重复的话建仓库会失败，git 的输出
# 就会混进路径（实际发生过：测试往仓库工作区里写了文件）。
new_case_dir() { mktemp -d "$ROOT/$1.XXXXXX"; }
case_std() {   # <name> <auto>
    local c; c=$(new_case_dir "$1")
    { mk_upstream "$c"
      git clone -q "$c/upstream.git" "$c/project"
      mk_pr_branch "$c/project"; } >/dev/null 2>&1
    write_conf "$c" "$c/project" "$2"
    printf '%s' "$c"
}

# ── 每个场景一个函数：返回非 0 = 有断言失败（负对照靠它判「变红」） ───────────
s_main_clean_off() {
    echo "── 主 checkout 占用、干净一致，开关关 → 只提示 switch ──"
    local c f0=$fail; c=$(case_std main-off 0)
    chk "派工脚本正常退出"                  "$(run_pr "$c")" 0
    chk "主 checkout 仍在 PR 分支（开关关不动它）" "$(cur_branch "$c/project")" "$BR"
    chk_has "提示主 checkout 用 switch"     "$(comments "$c")" "git -C '$c/project' switch main"
    chk_not "不再提示必然失败的 worktree remove" "$(comments "$c")" "worktree remove"
    chk_has "说明里写出占用者是主 checkout"  "$(comments "$c")" "主 checkout"
    chk_has "现状：没有未提交改动"           "$(comments "$c")" "没有未提交改动"
    chk_has "现状：与 PR 最新提交完全一致"   "$(comments "$c")" "与 PR #$N 的最新提交 完全一致"
    chk_has "翻 pending/human"              "$(labels "$c")" "labels[]=pending/human"
    chk "没有建 worktree"                   "$([ -d "$c/wt/issue-$N" ] && echo yes || echo no)" no
    [ "$fail" -eq "$f0" ]
}

s_main_clean_on() {
    echo "── 主 checkout 占用、干净一致，开关开 → 自动切回 main 并继续派工 ──"
    local c f0=$fail; c=$(case_std main-on 1)
    chk "派工脚本正常退出"                  "$(run_pr "$c")" 0
    chk "主 checkout 已切回 main"           "$(cur_branch "$c/project")" main
    chk "worker 的 worktree 建好了"         "$([ -d "$c/wt/issue-$N" ] && echo yes || echo no)" yes
    chk "worktree 在 PR 分支上"             "$(cur_branch "$c/wt/issue-$N")" "$BR"
    chk "分支只有一个签出"                  "$(n_holders "$c/project")" 1
    chk_has "PR 上留言说明已切回"            "$(comments "$c")" "已从 \`$BR\` 切回 \`main\`"
    chk_not "没有转人工说明"                 "$(comments "$c")" "转人工"
    chk_has "翻成派工中"                     "$(labels "$c")" "labels[]=doing/agent"
    chk_not "没有翻 pending/human"           "$(labels "$c")" "labels[]=pending/human"
    [ "$fail" -eq "$f0" ]
}

# 开关开、但有一项不满足 → 不切、转人工、提示带现状。$1 名字，$2 造现场的命令，$3 现状里该出现的字样
blocked_case() {
    local name="$1" setup="$2" want="$3" c f0=$fail
    c=$(case_std "$name" 1)
    (cd "$c/project" && eval "$setup") >/dev/null 2>&1
    chk "[$name] 派工脚本正常退出"           "$(run_pr "$c")" 0
    chk "[$name] 主 checkout 没被切走"       "$(cur_branch "$c/project")" "$BR"
    chk "[$name] 没有建 worktree"            "$([ -d "$c/wt/issue-$N" ] && echo yes || echo no)" no
    chk_has "[$name] 转人工"                 "$(labels "$c")" "labels[]=pending/human"
    chk_has "[$name] 提示里写出现状"         "$(comments "$c")" "$want"
    chk_has "[$name] 仍给出 switch 命令"     "$(comments "$c")" "switch main"
    [ "$fail" -eq "$f0" ]
}
s_dirty()     { echo "── 有未提交改动 ──";     blocked_case dirty     'echo x >> f.txt'                "有 1 处未提交改动"; }
s_untracked() { echo "── 有未跟踪文件 ──";     blocked_case untracked 'echo x > new.txt'               "有 1 处未提交改动"; }
s_ahead()     { echo "── 比 PR 多一个提交 ──"; blocked_case ahead     'echo y >> pr.txt && git commit -qam more' "领先 1 个、落后 0 个"; }
s_behind()    { echo "── 比 PR 少一个提交 ──"; blocked_case behind    'git reset -q --hard HEAD~1 && git checkout -q HEAD -- . ; git clean -qfd' "领先 0 个、落后 1 个"; }
s_bisect()    { echo "── bisect 进行中（工作区干净）──"; blocked_case bisect 'git bisect start -q 2>/dev/null || git bisect start' "有进行中的 git 操作：bisect"; }
s_nopr()      { echo "── 拿不到 PR 最新提交 ──"; blocked_case nopr \
                  "git push -q origin --delete refs/pull/$N/head" "读不出 PR 的最新提交"; }

s_interleave() {
    echo "── 受控交错：检查之后、切换之前出现同名被忽略文件 ──"
    local c f0=$fail; c=$(case_std interleave 1)
    write_conf "$c" "$c/project" 1 "$INTERBIN"
    local rc
    rc=$(INTERLEAVE_ON=switch INTERLEAVE_ONCE="$c/once" \
        INTERLEAVE_DO="printf 'late local content\\n' > '$c/project/gen.txt'" run_pr "$c")
    chk "派工脚本正常退出"                  "$rc" 0
    chk "插入的文件确实写进去了（夹具生效）"   "$([ -f "$c/project/gen.txt" ] && echo yes || echo no)" yes
    chk "文件内容没被切换覆盖"               "$(cat "$c/project/gen.txt" 2>/dev/null)" "late local content"
    chk "主 checkout 没被切走"               "$(cur_branch "$c/project")" "$BR"
    chk "没有建 worktree"                    "$([ -d "$c/wt/issue-$N" ] && echo yes || echo no)" no
    chk_not "没有翻成派工中"                 "$(labels "$c")" "labels[]=doing/agent"
    chk_has "转人工"                         "$(labels "$c")" "labels[]=pending/human"
    chk_has "说明里带 git 的拒绝原文"         "$(comments "$c")" "would be overwritten"
    [ "$fail" -eq "$f0" ]
}

# A = 仓库主目录，B = 附加 worktree；项目配置指向 B，A 签出 PR 分支
s_ab_other_main() {
    echo "── 项目配置在附加目录 B，分支被主目录 A 占着 → A 不动 ──"
    local c f0=$fail; c=$(new_case_dir ab)
    { mk_upstream "$c"
      git clone -q "$c/upstream.git" "$c/A"
      git -C "$c/A" worktree add -q "$c/B" -b other origin/main
      mk_pr_branch "$c/A"; } >/dev/null 2>&1
    local a_head; a_head=$(git -C "$c/A" rev-parse HEAD)
    write_conf "$c" "$c/B" 1
    chk "派工脚本正常退出"                  "$(run_pr "$c")" 0
    chk "A 仍在 PR 分支"                    "$(cur_branch "$c/A")" "$BR"
    chk "A 的提交没变"                      "$(git -C "$c/A" rev-parse HEAD)" "$a_head"
    chk "A 的工作区没变"                    "$(git -C "$c/A" status --porcelain | wc -l | tr -d ' ')" 0
    chk_has "提示写明占着的是 A、不是本项目目录" "$(comments "$c")" "不是本项目配置的目录"
    chk_has "提示给出 A 的路径与命令"        "$(comments "$c")" "git -C '$c/A' switch main"
    chk_has "转人工"                         "$(labels "$c")" "labels[]=pending/human"
    [ "$fail" -eq "$f0" ]
}

s_symlink_root() {
    echo "── 项目配置写成指向主目录的符号链接（带尾部斜杠）→ 仍判为同一目录 ──"
    local c f0=$fail; c=$(case_std symlink 1)
    ln -s "$c/project" "$c/link"
    write_conf "$c" "$c/link/" 1
    chk "派工脚本正常退出"                  "$(run_pr "$c")" 0
    chk "主 checkout 已切回 main"           "$(cur_branch "$c/project")" main
    chk "worker 的 worktree 建好了"         "$([ -d "$c/wt/issue-$N" ] && echo yes || echo no)" yes
    [ "$fail" -eq "$f0" ]
}

s_linked_self() {
    echo "── 项目配置就是附加 worktree B，B 自己占着分支 → 附加 worktree 不动 ──"
    local c f0=$fail; c=$(new_case_dir linked)
    { mk_upstream "$c"
      git clone -q "$c/upstream.git" "$c/A"
      git -C "$c/A" worktree add -q "$c/B" -b other origin/main
      mk_pr_branch "$c/B"; } >/dev/null 2>&1
    # A 让出 main：否则「base 被占」那道检查先挡住，测不出「附加 worktree 不动」这一条
    git -C "$c/A" switch -q --detach
    write_conf "$c" "$c/B" 1
    chk "派工脚本正常退出"                  "$(run_pr "$c")" 0
    chk "B 仍在 PR 分支"                    "$(cur_branch "$c/B")" "$BR"
    chk_has "提示仍是 worktree remove"       "$(comments "$c")" "git worktree remove '$c/B'"
    chk_not "不提示 switch"                  "$(comments "$c")" "switch main"
    chk_has "转人工"                         "$(labels "$c")" "labels[]=pending/human"
    [ "$fail" -eq "$f0" ]
}

s_base_held() {
    echo "── base 分支被另一个 worktree 签出 → 不切 ──"
    local c f0=$fail; c=$(case_std basehold 1)
    git -C "$c/project" worktree add -q "$c/basewt" main 2>/dev/null
    chk "派工脚本正常退出"                  "$(run_pr "$c")" 0
    chk "主 checkout 没被切走"              "$(cur_branch "$c/project")" "$BR"
    chk_has "原因写明 base 被占、切不过去"   "$(comments "$c")" "\`main\` 正被另一个 worktree \`$c/basewt\` 签出，切不过去"
    chk_has "提示给出 --detach 的替代办法"   "$(comments "$c")" "switch --detach"
    chk_has "转人工"                         "$(labels "$c")" "labels[]=pending/human"
    [ "$fail" -eq "$f0" ]
}

# submodule：super/arktool 是子模块，PROJECT_ROOT 指向它（照 arkknights-tool#33 的形状）
mk_submodule_case() {   # <name> <auto>
    local c; c=$(new_case_dir "$1")
    mk_upstream "$c" >/dev/null 2>&1
    git init -q -b main "$c/super"
    (cd "$c/super" && git -c protocol.file.allow=always submodule add -q "$c/upstream.git" arktool \
        && git commit -qm sub) >/dev/null 2>&1
    mk_pr_branch "$c/super/arktool" >/dev/null 2>&1
    write_conf "$c" "$c/super/arktool" "$2"
    printf '%s' "$c"
}
s_submodule_off() {
    echo "── submodule 主 checkout 占用，开关关 → 提示真实目录 ──"
    local c f0=$fail; c=$(mk_submodule_case sub-off 0)
    chk "夹具：git 给主工作树报的是 gitdir"   "$(git -C "$c/super/arktool" worktree list --porcelain | head -1)" "worktree $c/super/.git/modules/arktool"
    chk "派工脚本正常退出"                  "$(run_pr "$c")" 0
    chk_has "提示用真实目录"                 "$(comments "$c")" "git -C '$c/super/arktool' switch main"
    chk_not "提示里不出现 .git/modules"       "$(comments "$c")" ".git/modules"
    chk_not "不提示 worktree remove"          "$(comments "$c")" "worktree remove"
    [ "$fail" -eq "$f0" ]
}
s_submodule_on() {
    echo "── submodule 主 checkout 占用、干净一致，开关开 → 自动释放 ──"
    local c f0=$fail; c=$(mk_submodule_case sub-on 1)
    chk "派工脚本正常退出"                  "$(run_pr "$c")" 0
    chk "子模块主 checkout 已切回 main"     "$(cur_branch "$c/super/arktool")" main
    chk "worker 的 worktree 建好了"         "$([ -d "$c/wt/issue-$N" ] && echo yes || echo no)" yes
    chk_has "留言里是真实目录"               "$(comments "$c")" "\`$c/super/arktool\` 已从"
    [ "$fail" -eq "$f0" ]
}

s_new_issue() {
    echo "── 新 issue 建 worktree 那条路：只提示 switch，开关开也不切 ──"
    local c f0=$fail out rc; c=$(case_std newissue 1)
    out=$(cd "$c/project" && GH_CALLS="$c/gh-calls.log" CODING_AGENT_CONFIG="$c/cavil-loop.config" \
        bash "$SCRIPTS/create-worktree.sh" "$N" main 2>&1 >/dev/null); rc=$?
    local logged; logged=$(cat "$c/state/poll.log" 2>/dev/null)
    chk "create-worktree 失败退出（交给重试计数）" "$rc" 1
    chk "主 checkout 没被切走"               "$(cur_branch "$c/project")" "$BR"
    chk_has "日志提示 switch 和真实目录"      "$logged" "git -C '$c/project' switch main"
    chk_has "日志写出现状"                    "$logged" "与 origin/$BR"
    chk_not "日志不再提示 worktree remove"    "$logged" "worktree remove"
    [ "$fail" -eq "$f0" ]
}

# 检查之后、切换之前，人在主 checkout 里往 PR 分支提交了一次（复审第 1 轮复现的场景）
s_commit_before_switch() {
    echo "── 受控交错：检查之后、切换之前有人往 PR 分支提交 ──"
    local c f0=$fail rc late; c=$(case_std commitrace 1)
    write_conf "$c" "$c/project" 1 "$INTERBIN"
    rc=$(INTERLEAVE_ON=switch INTERLEAVE_ONCE="$c/once" \
        INTERLEAVE_DO="cd '$c/project' && printf 'late commit\\n' >> pr.txt && \$G commit -qam late && \$G rev-parse HEAD > '$c/late-sha'" \
        run_pr "$c")
    late=$(cat "$c/late-sha" 2>/dev/null)
    chk "派工脚本正常退出"                  "$rc" 0
    chk "夹具生效：确实插入了一个新提交"      "$([ -n "$late" ] && echo yes || echo no)" yes
    chk "新提交仍在 PR 分支上（没被挤掉）"    "$(git -C "$c/project" rev-parse "refs/heads/$BR")" "$late"
    chk "没有建 worktree（不派工）"          "$([ -d "$c/wt/issue-$N" ] && echo yes || echo no)" no
    chk_not "没有翻成派工中"                 "$(labels "$c")" "labels[]=doing/agent"
    chk_has "转人工"                         "$(labels "$c")" "labels[]=pending/human"
    chk_has "说明里写出分支多了新提交"        "$(comments "$c")" "多出了新提交"
    chk_not "没有「没有丢任何东西」的说法"    "$(comments "$c")" "没有丢任何东西"
    [ "$fail" -eq "$f0" ]
}

# 切换之后、核对分支之前，分支被别处改了（例如 branch -f）
s_move_after_switch() {
    echo "── 受控交错：切换之后、核对分支之前分支被改动 ──"
    local c f0=$fail rc moved; c=$(case_std moverace 1)
    write_conf "$c" "$c/project" 1 "$INTERBIN"
    rc=$(INTERLEAVE_ON=update-ref INTERLEAVE_ONCE="$c/once" \
        INTERLEAVE_DO="cd '$c/project' && n=\$(\$G commit-tree -p $BR -m moved $BR^{tree}) && \$G update-ref refs/heads/$BR \$n && echo \$n > '$c/moved-sha'" \
        run_pr "$c")
    moved=$(cat "$c/moved-sha" 2>/dev/null)
    chk "派工脚本正常退出"                  "$rc" 0
    chk "夹具生效：分支确实被改动"            "$([ -n "$moved" ] && echo yes || echo no)" yes
    chk "改动后的提交仍在分支上（没被覆盖）"  "$(git -C "$c/project" rev-parse "refs/heads/$BR")" "$moved"
    chk "没有建 worktree"                    "$([ -d "$c/wt/issue-$N" ] && echo yes || echo no)" no
    chk_has "转人工"                         "$(labels "$c")" "labels[]=pending/human"
    chk_not "没有「没有丢任何东西」的说法"    "$(comments "$c")" "没有丢任何东西"
    [ "$fail" -eq "$f0" ]
}

# 核对之后、建 worktree 之前，有人又在主 checkout 里签出了这个分支
s_recheckout_before_add() {
    echo "── 受控交错：核对之后、建 worktree 之前主 checkout 又签出了分支 ──"
    local c f0=$fail rc; c=$(case_std recheckout 1)
    write_conf "$c" "$c/project" 1 "$INTERBIN"
    rc=$(INTERLEAVE_ON=add INTERLEAVE_ONCE="$c/once" \
        INTERLEAVE_DO="\$G -C '$c/project' switch -q $BR" run_pr "$c")
    chk "夹具生效：主 checkout 又回到了 PR 分支" "$(cur_branch "$c/project")" "$BR"
    chk "分支只有一个签出（没建出第二个）"     "$(n_holders "$c/project")" 1
    chk "这轮派工失败退出（下轮重新判断）"     "$rc" 1
    chk_not "没有翻成派工中"                 "$(labels "$c")" "labels[]=doing/agent"
    [ "$fail" -eq "$f0" ]
}

ALL=(s_main_clean_off s_main_clean_on s_dirty s_untracked s_ahead s_behind s_bisect s_nopr
     s_interleave s_commit_before_switch s_move_after_switch s_recheckout_before_add s_ab_other_main s_symlink_root s_linked_self s_base_held
     s_submodule_off s_submodule_on s_new_issue)
for s in "${ALL[@]}"; do "$s"; done

# ── 负对照：把生产脚本复制一份改坏一处，对应场景必须变红 ─────────────────────────
# 格式：名字 | 要改的文件 | python 替换（旧→新） | 必须变红的场景
mutate() {   # <name> <file> <old> <new> <scenario...>
    local name="$1" file="$2" old="$3" new="$4"; shift 4
    mutation_gate || return 0
    local m="$ROOT/mut-$name"
    mkdir -p "$m"; cp -r "$REPO_DIR/scripts" "$m/scripts"; ln -s "$REPO_DIR/prompts" "$m/prompts"
    if ! OLD="$old" NEW="$new" python3 - "$m/scripts/$file" <<'PY'
import os, sys
p = sys.argv[1]; s = open(p).read(); o = os.environ["OLD"]
if o not in s: sys.exit(1)
open(p, "w").write(s.replace(o, os.environ["NEW"]))
PY
    then bad "负对照 [$name]：要改的原文不在了（准备失败）"; return 0; fi
    local s red=0 saved_scripts="$SCRIPTS" saved_pass=$pass saved_fail=$fail
    SCRIPTS="$m/scripts"
    for s in "$@"; do
        if "$s" >/dev/null 2>&1; then :; else red=1; fi
    done
    SCRIPTS="$saved_scripts"; pass=$saved_pass; fail=$saved_fail
    if [ "$red" = 1 ]; then ok "负对照 [$name]：改坏后 $* 变红"
    else bad "负对照 [$name]：改坏后 $* 仍全绿——测试分不出对错"; fi
}

echo "── 负对照 ──"
mutate main-detect _lib.sh 'if [ "$idx" -eq 1 ]; then is_main=1' 'if false; then is_main=1' s_main_clean_off
mutate real-dir _lib.sh 'real=$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || true)' 'real=""' s_submodule_off
mutate same-dir _lib.sh '    [ -n "$mine" ] && [ -n "$theirs" ] && [ "$mine" = "$theirs" ]
}' '    return 0
}' s_ab_other_main
mutate no-overwrite-ignore _lib.sh 'switch --no-overwrite-ignore "$base"' 'switch "$base"' s_interleave
mutate dirty-check _lib.sh 'if [ "$BH_DIRTY" != 0 ]; then' 'if false; then' s_dirty
mutate same-commit _lib.sh '[ "$BH_HEAD" != "$pr_sha" ]; then' 'false; then' s_ahead
mutate ops-check _lib.sh 'if [ -n "$BH_OPS" ]; then
        AUTO_RELEASE_REASON' 'if false; then
        AUTO_RELEASE_REASON' s_bisect
mutate base-held _lib.sh 'if base_holder=$(branch_checked_out_elsewhere "$base" "$BH_DIR"); then
        AUTO_RELEASE_REASON' 'if false; then
        AUTO_RELEASE_REASON' s_base_held
mutate linked-untouched _lib.sh 'if [ "$BH_KIND" != main ]; then
        AUTO_RELEASE_REASON' 'if false; then
        AUTO_RELEASE_REASON' s_linked_self
mutate forced-fetch-after-release dispatch-pr-comment.sh 'if [ "${RELEASED:-0}" = 1 ]; then
    if ! cas_out' 'if false; then
    if ! cas_out' s_commit_before_switch
mutate cas-old-value dispatch-pr-comment.sh '"$PR_HEAD_SHA" "$PR_HEAD_SHA" 2>&1)' '"$PR_HEAD_SHA" 2>&1)' s_move_after_switch
mutate force-add-after-release dispatch-pr-comment.sh '[ "${RELEASED:-0}" = 1 ] && WT_FORCE=()' ':' s_recheckout_before_add
mutate switch-off dispatch-pr-comment.sh 'if [ "$AUTO_RELEASE_MAIN_CHECKOUT" = 1 ]; then
        if main_checkout_auto_release' 'if true; then
        if main_checkout_auto_release' s_main_clean_off

echo
mutation_summary "$0"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
