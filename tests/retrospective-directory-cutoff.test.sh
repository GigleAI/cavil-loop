#!/usr/bin/env bash
# 目录经验开关与「只复盘开关生效后合并的 PR」（GitHub#168）。
#
# 跑法：bash tests/retrospective-directory-cutoff.test.sh       （MUTATION=1 加跑负对照）
# 依赖：python3、git、flock。不碰网络、不调模型、不碰真实项目：HOME 指向临时目录，gh / claude 是假的。
#
# 用例在 tests/retrospective_cutoff_test.py：每个用例都在 env -i 干净环境里跑真实入口
# scripts/post-merge-retrospective.sh（它 source _lib.sh、自己导出开关、再 exec python），
# 项目 origin 是本地 bare 仓库，推送是真推。单个文件的写 / 删失败从外面注入（sitecustomize），
# 不在被测代码里留测试开关。
#
# 两段：
#   1. 用例全绿；其中「开关关掉」一例另和改动前的固定提交 954a294 对拍：GitHub 调用、模型输入、
#      推上去的经验和报告逐字节相同；
#   2. 负对照（只在 MUTATION=1 时跑）：把 scripts/ + prompts/ 复制一份、改坏一处，用例必须变红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$TEST_DIR/.." && pwd)"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
SUITE="$TEST_DIR/retrospective_cutoff_test.py"
pass=0; fail=0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

BASE_COMMIT=954a294
mkdir -p "$T/base"
if git -C "$REPO_DIR" archive "$BASE_COMMIT" scripts prompts | tar -x -C "$T/base"; then
    export BASELINE_RELEASE="$T/base"
else
    echo "  ❌ 准备失败：取不到改动前的固定提交 $BASE_COMMIT"; fail=$((fail+1))
fi

echo "── 用例（真实入口，开关关掉一例与 $BASE_COMMIT 对拍）──"
if out=$(QUIET=1 python3 "$SUITE" 2>&1); then
    echo "  ✅ $(printf '%s\n' "$out" | grep -E '^Ran ')"
    pass=$((pass+1))
else
    printf '%s\n' "$out" | tail -40
    echo "  ❌ 用例有红"
    fail=$((fail+1))
fi

mutation_on && echo "── 负对照：改坏一处，用例必须变红 ──"
mutant() {   # <说明> <文件(相对仓库)> <原文> <改成>
    mutation_gate || return 0
    local desc="$1" file="$2" src="$T/mut"
    rm -rf "$src"; mkdir -p "$src"; cp -R "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$src/"
    python3 - "$src/$file" "$3" "$4" <<'PY' || { echo "  ❌ 准备失败：$desc（原文已不在）"; fail=$((fail+1)); return; }
import sys
path, old, new = sys.argv[1:]
text = open(path, encoding='utf-8').read()
if text.count(old) != 1:
    sys.exit(1)
open(path, 'w', encoding='utf-8').write(text.replace(old, new))
PY
    if RETRO_RELEASE="$src" BASELINE_RELEASE= QUIET=1 python3 "$SUITE" >/dev/null 2>&1; then
        echo "  ❌ $desc 后用例仍全绿"; fail=$((fail+1))
    else
        echo "  ✅ $desc → 变红"; pass=$((pass+1))
    fi
}
PY_=scripts/post-merge-retrospective.py
mutant "入口默认值改成关" scripts/post-merge-retrospective.sh \
    'RETROSPECTIVE_DIRECTORY_LESSONS:-true}' 'RETROSPECTIVE_DIRECTORY_LESSONS:-false}'
mutant "跳过判断方向写反" $PY_ "        if merged >= since:" "        if merged < since:"
mutant "合并时间等于开始时间也算跳过" $PY_ "        if merged >= since:" "        if merged > since:"
mutant "分类时也看重试时间" $PY_ "        if job['status'] in TERMINAL:
            continue
        had = job.get('merged_at')" "        if job['status'] in TERMINAL or not due(job, time.time()):
            continue
        had = job.get('merged_at')"
mutant "碰到第一个合格任务就停止分类" $PY_ "            if had != merged:
                save(path, job)
            continue
        done = remote_report" "            if had != merged:
                save(path, job)
            break
        done = remote_report"
mutant "开关关掉也跳过" $PY_ "unknown = classify(repo, queue, value, log) if state == 'on' else set()" \
    "unknown = classify(repo, queue, value or start, log)"
mutant "开始时间不可用时照常处理队列" $PY_ "            if state in ('unknown', 'pause'):" "            if state == 'pause':"
mutant "暂停日志不写原因和时间文件位置" $PY_ "                log(f'retrospective queue paused this round: {value} '
                    f'(directory lessons file: {queue / MARKER})')" "                log('retrospective queue paused this round')"
mutant "一轮复盘不止一个" $PY_ "                break  # Bound each background invocation; next tick drains more." "                pass"
mutant "合并时间读不出也照常挑中" $PY_ "            unknown.add(path)
            log(f'retrospective PR #{job[\"pr\"]} merge time unreadable" "            log(f'retrospective PR #{job[\"pr\"]} merge time unreadable"
mutant "已跳过的会被再次挑中" $PY_ "TERMINAL = ('done', 'failed', 'skipped')" "TERMINAL = ('done', 'failed')"
mutant "远端已有报告也标跳过" $PY_ "        if done:
            job.update(status='done'" "        if False:
            job.update(status='done'"
mutant "坏的时间文件被覆盖" $PY_ "        if kind == 'bad':
            return 'unknown', value
" ""
mutant "关掉不留任何证据" $PY_ "    if kind != 'on':
        return 'off', None" "    if True:
        return 'off', None"
mutant "重开只认时间文件、不认扫描记录里的标记" $PY_ "        pending = state is None or bool(state.get(OFF_PENDING))" "        pending = False"
mutant "三处都记不下仍处理队列" $PY_ "        return 'pause', (f'switched off" "        return 'off', (f'switched off"
mutant "时间文件改在扫描之前处理" $PY_ "        scan(repo, queue)
        if '--scan-only'" "        sync_directory_state(queue, on, start)
        scan(repo, queue)
        if '--scan-only'"
mutant "不写目录经验时目录段照样给模型" $PY_ "                shown, reattach = lessons_format.detach_directory_section(old_lessons)" \
    "                shown, reattach = old_lessons, None"
mutant "不写目录经验时切掉了但不接回" $PY_ "                shown, reattach = lessons_format.detach_directory_section(old_lessons)" \
    "                shown, reattach = lessons_format.detach_directory_section(old_lessons)[0], None"
mutant "写目录经验时不补空段" $PY_ "                old_lessons = lessons_format.with_directory_section(old_lessons)" "                pass"
mutant "开关值写错也照跑" $PY_ "    if value not in ('true', 'false'):" "    if False:"

echo
mutation_summary "$0"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
