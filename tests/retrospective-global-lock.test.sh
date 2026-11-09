#!/usr/bin/env bash
# kind: guard
# 合并后复盘的全机锁（GitHub#165）：锁不再放在 skill 目录的 .git 里，改放本机固定的
# ~/.local/state/cavil-loop/retrospective.lock。
#
# 跑法：bash tests/retrospective-global-lock.test.sh
# 依赖：python3、git、flock。不碰网络、不调模型、不碰真实项目：HOME 指向临时目录，gh 是假的。
#
# 走真实入口：把 scripts/ + prompts/ 拷成一份「部署目录」，用 env -i 干净环境跑那份里的
# post-merge-retrospective.sh（它 source _lib.sh、导出锁路径、再 exec python）。测试不替
# 入口导出任何复盘变量，锁路径必须由入口自己传进 python。
#
# 场景：
#   1. 部署目录不是 git 仓库（按版本部署）、队列里有一个到期 PR → 不崩，开始处理这个 PR
#   2. 同上，但全机锁已被别人占着 → 安静退出、任务不变；扫描游标已更新（证明走到了拿锁这一步）
#   3. 两个项目（各自的状态目录）同时触发 → 一个处理中时，另一个不开始
#   4. 部署目录是 git checkout（老的部署方式）→ 1、2 照旧
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$TEST_DIR/.." && pwd)"
pass=0; fail=0
ok()  { echo "  ✅ $*"; pass=$((pass+1)); }
bad() { echo "  ❌ $*"; fail=$((fail+1)); }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
REAL_GIT=$(command -v git)

# 假 gh：所有 api 读都返回空列表（扫描读不到新合并的 PR，队列里只有预置的那一个）。
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in *--slurp*) echo '[[]]' ;; *) echo '[]' ;; esac
SH
# git 包一层：复盘处理 PR 的第一步是在项目目录里 `git remote get-url origin`。
# 设了 HOLD_DIR 时，到这一步先写一个「已开始」标记，再等放行文件出现——用来把一个项目
# 卡在「拿着全机锁、正在复盘」的状态，同时跑另一个项目。
cat > "$T/bin/git" <<SH
#!/usr/bin/env bash
if [ -n "\${HOLD_DIR:-}" ] && [ "\$*" = "remote get-url origin" ]; then
    : > "\$HOLD_DIR/started"
    for _ in \$(seq 1 300); do [ -e "\$HOLD_DIR/release" ] && break; sleep 0.1; done
fi
exec "$REAL_GIT" "\$@"
SH
chmod +x "$T/bin/gh" "$T/bin/git"

# make_release <dir> [git]：拷一份部署目录；第二个参数为 git 时做成 git checkout。
make_release() {
    local dir="$1" src="${RELEASE_SRC:-$REPO_DIR}"
    mkdir -p "$dir"
    cp -R "$src/scripts" "$src/prompts" "$dir/"
    if [ "${2:-}" = git ]; then
        "$REAL_GIT" -C "$dir" init -q -b main
        "$REAL_GIT" -C "$dir" -c user.name=t -c user.email=t@t add -A
        "$REAL_GIT" -C "$dir" -c user.name=t -c user.email=t@t commit -qm init
    fi
}

# make_project <name>：项目目录 + 配置 + 状态目录，队列里预置一个到期的 PR #7。
make_project() {
    local name="$1" p="$T/$1"
    mkdir -p "$p/root" "$p/state/retrospectives"
    "$REAL_GIT" -C "$p/root" init -q -b main
    "$REAL_GIT" -C "$p/root" remote add origin "https://github.com/example/other-$name"
    cat > "$p/config" <<CFG
REPO=example/$name
PROJECT_ROOT=$p/root
WORKTREE_BASE=$p/wt
STATE_DIR=$p/state
TMUX_PREFIX=$name
BRANCH_PREFIX=feature/issue-
SESSION_NAME_PREFIX=issue-
LABEL_PENDING_AGENT=pending/agent
LABEL_PENDING_HUMAN=pending/human
CFG
    printf '{"enabled_at": "2026-01-01T00:00:00Z", "since": "2026-01-01T00:00:00Z"}\n' \
        > "$p/state/retrospectives/cursor.json"
    # 合并时间晚于本轮：目录经验开关默认打开时只处理开关生效后合并的 PR（GitHub#168），
    # 这里要的是「会被真处理」的那种任务。
    printf '{"pr": 7, "status": "pending", "attempts": 0, "merged_at": "2099-01-01T00:00:00Z"}\n' \
        > "$p/state/retrospectives/pr-7.json"
}

# run_retro <release> <project> [VAR=val...]：干净环境跑真实入口，输出写 <project>/out，返回退出码。
run_retro() {
    local rel="$1" name="$2"; shift 2
    env -i HOME="$T/home" PATH="$T/bin:/usr/bin:/bin" CODING_AGENT_CONFIG="$T/$name/config" "$@" \
        bash "$rel/scripts/post-merge-retrospective.sh" > "$T/$name/out" 2>&1
}
job()    { cat "$T/$1/state/retrospectives/pr-7.json"; }
since()  { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["since"])' "$T/$1/state/retrospectives/cursor.json"; }
started_job() { grep -q 'retrospective PR #7 started' "$T/$1/out" && python3 -c '
import json,sys; j=json.load(open(sys.argv[1])); sys.exit(0 if j.get("started_at") and j.get("attempts")==1 else 1)' "$T/$1/state/retrospectives/pr-7.json"; }
LOCK="$T/home/.local/state/cavil-loop/retrospective.lock"

# scenario_runs <release> <tag>：场景 1。
scenario_runs() {
    local rel="$1" tag="$2"
    rm -rf "$T/home" "$T/p1"; mkdir -p "$T/home"; make_project p1
    if run_retro "$rel" p1 && started_job p1 && [ -e "$LOCK" ]; then
        ok "$tag：拿到全机锁、开始处理 PR（锁在 ~/.local/state/cavil-loop/）"
    else
        bad "$tag：没能开始处理 PR"; sed 's/^/      /' "$T/p1/out" | tail -8
    fi
}

# scenario_held <release> <tag>：场景 2。
scenario_held() {
    local rel="$1" tag="$2" before_job before_since
    rm -rf "$T/home" "$T/p1"; mkdir -p "$T/home/.local/state/cavil-loop"; make_project p1
    before_job=$(job p1); before_since=$(since p1)
    exec {lfd}>"$LOCK"; flock -n "$lfd"
    run_retro "$rel" p1; local rc=$?
    exec {lfd}>&-
    if [ "$rc" -eq 0 ] && [ "$(job p1)" = "$before_job" ] && [ "$(since p1)" != "$before_since" ] \
       && ! grep -q 'started' "$T/p1/out" && [ ! -s "$T/p1/out" ]; then
        ok "$tag：锁被占着 → 安静退出、任务不变，扫描已跑过（游标更新）"
    else
        bad "$tag：锁被占着时 rc=$rc，任务或游标不对"; sed 's/^/      /' "$T/p1/out" | tail -8
    fi
}

# scenario_two <release> <tag>：场景 3。
scenario_two() {
    local rel="$1" tag="$2" hold="$T/hold" pid b_job
    rm -rf "$T/home" "$T/p1" "$T/p2" "$hold"; mkdir -p "$T/home" "$hold"; make_project p1; make_project p2
    run_retro "$rel" p1 HOLD_DIR="$hold" & pid=$!
    for _ in $(seq 1 100); do [ -e "$hold/started" ] && break; sleep 0.1; done
    if [ ! -e "$hold/started" ]; then
        bad "$tag：第一个项目没走到复盘处理（准备失败）"; : > "$hold/release"; wait "$pid"; return
    fi
    b_job=$(job p2)
    run_retro "$rel" p2; local rc=$?
    : > "$hold/release"; wait "$pid"
    if [ "$rc" -eq 0 ] && [ "$(job p2)" = "$b_job" ] && ! grep -q started "$T/p2/out" && started_job p1; then
        ok "$tag：项目 A 复盘中，项目 B 同时触发 → B 不开始，A 照常处理"
    else
        bad "$tag：两个项目同时跑（B rc=$rc）"; sed 's/^/      B: /' "$T/p2/out" | tail -5
    fi
}

echo "── 按版本部署（部署目录不是 git 仓库）──"
make_release "$T/rel-plain"
if "$REAL_GIT" -C "$T/rel-plain" rev-parse --git-dir >/dev/null 2>&1; then
    bad "准备失败：临时部署目录落在某个 git 仓库里"
fi
scenario_runs "$T/rel-plain" "非 git 部署目录"
scenario_held "$T/rel-plain" "非 git 部署目录"
scenario_two  "$T/rel-plain" "非 git 部署目录"

echo "── 老的 git checkout 部署 ──"
make_release "$T/rel-git" git
scenario_runs "$T/rel-git" "git checkout"
scenario_held "$T/rel-git" "git checkout"
scenario_two  "$T/rel-git" "git checkout"

echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
