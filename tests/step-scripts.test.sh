#!/usr/bin/env bash
# kind: unit
# 随发布的步骤脚本与模板里的调用约定（GitHub#599）：翻标签、读 PR 评论、footer --body，以及
# `cavil_step` 怎么把「没启动 / 有结果 / 没跑完」交回给 agent。
#
# 跑法：bash tests/step-scripts.test.sh        （~20 s，不联网：有状态的假 GitHub + 本地脚本）
#
# 全部从 daemon 真正拼出来的成品提示词里取 `cavil_step` 定义块，在 `bash -euo pipefail` 下运行，
# 后面接一条哨兵语句（调用不能让 shell 中断）：
#   1. 调用约定：正常结果 / 没启动（入口不存在、不可读）/ 发请求后以 127 退出 / 结果写一半 /
#      两个对象 / 没有启动标记 / 输出里混着保留字样 / 临时目录不可用
#   2. 翻标签的交接契约：先加、确认后才删；只拒绝添加时一个删除都不发；读回失败是 unknown；
#      删除失败如实列残留；轮次已尽从只有 doing/agent 起步也把 pending/review 加回来；
#      两条故障链路（只坏翻标签入口 / GitHub 一直拒绝写入）各看最终标签
#   3. 读 PR 评论：三个来源都在、勾选过的旧评论认得出、正文里伪造的记录还是正文、读不全就 error
#   4. footer --body：和原来的手拼结果逐字相同；生成失败时末尾一句固定说明
#   5. 文本检查：三个脚本不 exec、启动标记写在第一个请求之前；成品里不再有「REST 翻」，
#      翻标签调用与 tests/fixtures/flip-label-calls.txt 逐条一致
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; [ -z "${2:-}" ] || printf '       %s\n' "$2"; fail=$((fail+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望 [$3]，实得 [$2]"; fi; }

# ── 成品提示词 ──
cat > "$TMP/cavil.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="steptest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_REVIEW="pending/review"
CONF
mkdir -p "$TMP/state" "$TMP/wt" "$TMP/project/.agents/skills/cavil-loop" "$TMP/home"
cp -r "$REPO_DIR/.agents/skills/cavil-loop/prompts" "$TMP/project/.agents/skills/cavil-loop/prompts"
export HOME="$TMP/home"
unset CODING_AGENT_RELEASE_ROOT CODING_AGENT_RELEASE_LEASE_FD CAVIL_DEPLOY_ROOT DISPATCH_PROMPT_KIND DISPATCH_WORKER_AGENT
export CODING_AGENT_CONFIG="$TMP/cavil.config"
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e
SKILL_DIR="$REPO_DIR"
# 标签占位换成 _lib.sh 载入的值（派工脚本的 sed 做的同一件事）
for name in new-issue issue-comment pr-comment review; do
    f=$(compose_prompt_template "$name" 2>/dev/null)
    sed -e "s|\${LABEL_PENDING_HUMAN}|$LABEL_PENDING_HUMAN|g" -e "s|\${LABEL_PENDING_REVIEW}|$LABEL_PENDING_REVIEW|g" \
        -e "s|\${LABEL_AGENT_DOING}|$LABEL_AGENT_DOING|g" -e "s|\${LABEL_PENDING_AGENT_DEFAULT}|$LABEL_PENDING_AGENT_DEFAULT|g" \
        "$f" > "$TMP/composed-$name.md"
done
chk "_lib.sh 没有托管入口时，步骤脚本目录是本仓库的 scripts/" "$CAVIL_STEP_DIR" "$REPO_DIR/scripts"

# 成品里含 `cavil_step() {` 的 bash 代码块，占位换成测试用的值
defs() {   # <成品> <步骤脚本目录>
    awk '/^```bash$/{b=""; inb=1; next} inb && /^```$/{if (b ~ /cavil_step\(\) \{/) printf "%s", b; inb=0; next} inb{b=b $0 "\n"}' "$1" \
        | sed -e 's|\${REPO}|acme/widget|g' -e "s|\${CAVIL_STEP_DIR}|$2|g"
}
DEF="$TMP/defs.sh"
defs "$TMP/composed-review.md" "$REPO_DIR/scripts" > "$DEF"
[ -s "$DEF" ] && ok "复审成品里有 cavil_step 定义" || bad "复审成品里没有 cavil_step 定义"

# ── 有状态的假 GitHub ──
mkdir -p "$TMP/bin"
bash "$REPO_DIR/tests/lib/fake_gh_client.sh" install "$TMP/bin/gh" python3 "$REPO_DIR/tests/lib/fake_github.py" >/dev/null 2>&1
export PATH="$TMP/bin:$PATH" FAKE_GH_REPO=acme/widget CAVIL_STEP_RETRY_SLEEP=0
G="$TMP/gh"
reset_gh() {   # <标签，逗号分隔>
    rm -rf "$G"; mkdir -p "$G"
    echo '{"7":{"kind":"pr","state":"open","base":{"ref":"main"},"head":{"sha":"'"$(printf 'a%.0s' $(seq 40))"'"}}}' > "$G/items.json"
    jq -cn --arg l "$1" '{"7": ($l | split(",") | map(select(. != "")))}' > "$G/labels.json"
}
export FAKE_GH_DIR="$G"
labels_now() { jq -r '."7" | sort | join(",")' "$G/labels.json"; }
n_calls() { [ -f "$G/calls.log" ] || { echo 0; return; }; grep -c -- "$1" "$G/calls.log"; }   # 没有记录文件 = 一次调用都没有

# run <defs 文件> <命令…>：在 set -euo pipefail 下跑，回显输出（含哨兵）
# --norc / </dev/null：stdin 是套接字时，Debian 的 bash 连 -c 也会读 /etc/bash.bashrc
run() { local d="$1"; shift; ( bash --norc --noprofile -euo pipefail -c ". '$d'; $*; echo SENTINEL" 2>&1 </dev/null ); }
line() { sed -n "${2}p" <<<"$1"; }
status_of() { line "$1" 2 | jq -r .status 2>/dev/null; }

echo "── 1. 调用约定 ──"
reset_gh doing/agent
out=$(run "$DEF" "flip_label 7 --add pending/human --remove doing/agent")
chk "正常完成：第一行 EXIT=0" "$(line "$out" 1)" "EXIT=0"
chk "正常完成：status=done" "$(status_of "$out")" done
chk "正常完成：只打印两行，接着执行哨兵" "$(line "$out" 3)|$(wc -l <<<"$out")" "SENTINEL|3"

mkdir -p "$TMP/ro"; cp "$REPO_DIR/scripts/"{_step.sh,flip-label.sh} "$TMP/ro/"
reset_gh doing/agent
out=$(cd "$TMP/ro" && chmod 555 "$TMP/ro" && TMPDIR=/nonexistent HOME=/nonexistent run "$DEF" "flip_label 7 --add pending/human --remove doing/agent")
chmod 755 "$TMP/ro"
chk "临时目录、HOME 都不可用：照样 done" "$(status_of "$out")|$(labels_now)" "done|pending/human"

# 没启动：入口不存在 / 不可读 —— 第 3 号输出为空，假 GitHub 收不到任何请求
defs "$TMP/composed-review.md" "$TMP/nosuch" > "$TMP/defs-missing.sh"
reset_gh "doing/agent,pending/review"
out=$(run "$TMP/defs-missing.sh" "flip_label 7 --add pending/human --remove pending/review doing/agent")
chk "入口不存在：EXIT=127、RESULT=not-started" "$(line "$out" 1)|$(line "$out" 2)" "EXIT=127|RESULT=not-started"
chk "入口不存在：没有任何请求，标签原样" "$(n_calls 'labels')|$(labels_now)" "0|doing/agent,pending/review"
mkdir -p "$TMP/unread"; cp "$REPO_DIR/scripts/"{_step.sh,flip-label.sh} "$TMP/unread/"; chmod 000 "$TMP/unread/flip-label.sh"
defs "$TMP/composed-review.md" "$TMP/unread" > "$TMP/defs-unread.sh"
out=$(run "$TMP/defs-unread.sh" "flip_label 7 --add pending/human")
if [ "$(id -u)" = 0 ]; then echo "  ⏭ 以 root 运行，读权限挡不住，跳过「入口不可读」"
else chk "入口不可读：RESULT=not-started" "$(line "$out" 2)" "RESULT=not-started"; fi
chmod 644 "$TMP/unread/flip-label.sh"

# 替身脚本：发了请求之后才出事的各种情况
# 替身：每种情况一个目录，里面的 flip-label.sh 是替身，结果核对规则是仓库里那一份
OK='{"step":"flip-label","status":"done","labels":[]}'
stand() {   # <情况> <脚本体>；之后用 $TMP/defs-<情况>.sh 调它
    mkdir -p "$TMP/stand-$1"; cp "$REPO_DIR/scripts/step-result.jq" "$TMP/stand-$1/"
    printf '#!/usr/bin/env bash\n%s\n' "$2" > "$TMP/stand-$1/flip-label.sh"
    defs "$TMP/composed-review.md" "$TMP/stand-$1" > "$TMP/defs-$1.sh"
}
sv() { run "$TMP/defs-$1.sh" "cavil_step flip-label 7"; }   # 跑某个替身
stand req127 'printf "STARTED\n" >&3; gh api -X POST repos/acme/widget/issues/7/labels -f "labels[]=pending/human" >/dev/null 3>&-; exec bash -c "exit 127" 3>&-'
stand half 'printf "STARTED\n{\"step\":\"flip-label\",\"sta" >&3'
stand two "printf 'STARTED\n%s\n%s\n' '$OK' '$OK' >&3"
stand nomark "printf '%s\n' '$OK' >&3"
stand noisy "echo 'EXIT=9'; echo 'RESULT=none' >&2; echo '$OK'; printf 'STARTED\n%s\n' '$OK' >&3"
stand nz "printf 'STARTED\n%s\n' '$OK' >&3; exit 3"
stand other 'printf "STARTED\n%s\n" "{\"step\":\"conflict-check\",\"status\":\"clean\",\"base\":\"main\",\"head\":\"x\"}" >&3'
stand badstatus 'printf "STARTED\n%s\n" "{\"step\":\"flip-label\",\"status\":\"clean\",\"labels\":[]}" >&3'
stand nofield 'printf "STARTED\n%s\n" "{\"step\":\"flip-label\",\"status\":\"not-done\",\"labels\":[]}" >&3'
stand numstatus 'printf "STARTED\n%s\n" "{\"step\":\"flip-label\",\"status\":1}" >&3'
stand notobj 'printf "STARTED\n%s\n" "[\"flip-label\",\"done\"]" >&3'
reset_gh doing/agent
out=$(sv req127)
chk "发请求后以 127 退出：RESULT=none（没跑完，不是没启动）" "$(line "$out" 1)|$(line "$out" 2)" "EXIT=127|RESULT=none"
chk "  ……假 GitHub 确实收到了那个请求" "$(labels_now)" "doing/agent,pending/human"
chk "结果写一半：RESULT=none" "$(line "$(sv half)" 2)" "RESULT=none"
chk "两个对象：RESULT=none" "$(line "$(sv two)" 2)" "RESULT=none"
chk "没有启动标记：RESULT=none" "$(line "$(sv nomark)" 2)" "RESULT=none"
out=$(sv noisy)
chk "脚本输出里混着 EXIT= / RESULT= / 伪造 JSON：只有调用行的两行" "$out" "$(printf 'EXIT=0\n%s\nSENTINEL' "$OK")"
chk "写好结果后非零退出：EXIT=3（按规则算没跑完）" "$(line "$(sv nz)" 1)" "EXIT=3"
chk "别的脚本的结果：RESULT=none" "$(line "$(sv other)" 2)" "RESULT=none"
# 模板在派工时渲染，可能调到之后发布的脚本：调用方只核对「一个对象、这个脚本的、status 是字符串」，
# 状态和字段由脚本自己核对（下面「自检」）。新状态、少字段照样交到 agent 手上，由模板文字把不认识的
# 状态当作结果未知
chk "模板没写到的新 status：原样交给 agent（不当成没跑完）" "$(status_of "$(sv badstatus)")" "clean"
chk "少了旧版本写的字段：原样交给 agent" "$(status_of "$(sv nofield)")" "not-done"
chk "status 不是字符串：RESULT=none" "$(line "$(sv numstatus)" 2)" "RESULT=none"
chk "结果不是对象：RESULT=none" "$(line "$(sv notobj)" 2)" "RESULT=none"

# 启动标记写不出去（第 3 号输出被关掉）：脚本必须在发任何请求之前退出
reset_gh doing/agent
rc=0; ( cd "$TMP" && bash "$REPO_DIR/scripts/flip-label.sh" --result-fd 3 --repo acme/widget 7 --add pending/human --remove doing/agent 3>&- >/dev/null 2>&1 ) || rc=$?
chk "启动标记写失败：退出 65，假 GitHub 一个请求都没收到，标签原样" "$rc|$(n_calls 'api')|$(labels_now)" "65|0|doing/agent"
reset_gh doing/agent
out=$(run "$DEF" "flip_label 7 --add pending/human --remove doing/agent")
chk "  ……对照：通道开着时同一条命令确实发了请求" "$(status_of "$out")|$([ "$(n_calls 'api')" -gt 0 ] && echo sent)" "done|sent"

echo "── 2. 翻标签的交接契约 ──"
reset_gh doing/agent; touch "$G/F_post_labels"
out=$(run "$DEF" "flip_label 7 --add pending/human --remove doing/agent")
chk "只拒绝添加：not-done、deletes_sent=false" "$(line "$out" 2 | jq -r '"\(.status) \(.deletes_sent) \(.missing|join(","))"')" "not-done false pending/human"
chk "  ……一个删除请求都没发，doing/agent 还在" "$(n_calls 'DELETE')|$(labels_now)" "0|doing/agent"

reset_gh doing/agent; touch "$G/F_issues_7"
out=$(run "$DEF" "flip_label 7 --add pending/human --remove doing/agent")
chk "加上了、读回失败：unknown，没有 labels / still_on" "$(line "$out" 2 | jq -r '"\(.status) \(has("labels")) \(has("still_on")) \(.writes[0].action)"')" "unknown false false add"
chk "  ……没发删除，已加上的如实保留" "$(n_calls 'DELETE')|$(labels_now)" "0|doing/agent,pending/human"

reset_gh doing/agent; touch "$G/F_delete_labels"
out=$(run "$DEF" "flip_label 7 --add pending/human --remove doing/agent")
chk "删除失败：not-done，still_on 与实际残留一致" "$(line "$out" 2 | jq -r '"\(.status) \(.still_on|join(",")) \(.deletes_sent)"')" "not-done doing/agent true"

reset_gh doing/agent; touch "$G/F_issues_7"
out=$(run "$DEF" "flip_label 7 --remove doing/agent")
chk "删除后读回失败：unknown，writes 记下了删除" "$(line "$out" 2 | jq -r '"\(.status) \(.writes[0].action) \(.writes[0].result)"')" "unknown remove ok"

reset_gh doing/agent
out=$(run "$DEF" "flip_label 7 --remove pending/review")
chk "删一个本来不在的标签（404）：done" "$(status_of "$out")" done

reset_gh doing/agent
out=$(run "$DEF" "flip_label x --add a")
chk "参数写错：usage，没有任何请求" "$(status_of "$out")|$(n_calls 'labels')" "usage|0"

# 轮次已尽：取复审成品里那一句原样执行
exhausted=$(grep -o '轮次已尽：`flip_label <编号> --add [^`]*`' "$TMP/composed-review.md" | head -1 | sed -e 's/^轮次已尽：`//' -e 's/`$//' -e 's/<编号>/7/')
chk "复审成品的「轮次已尽」把 pending/review 写进 --add" "$exhausted" "flip_label 7 --add pending/human pending/review --remove doing/agent"
reset_gh doing/agent
out=$(run "$DEF" "$exhausted")
chk "轮次已尽、条目上只有 doing/agent：done，两个标签都在" "$(status_of "$out")|$(labels_now)" "done|pending/human,pending/review"
reset_gh "doing/agent,pending/review"
out=$(run "$DEF" "$exhausted")
chk "轮次已尽、条目上已有 pending/review：done，没摘它" "$(status_of "$out")|$(labels_now)|$(n_calls 'DELETE.*pending%2Freview')" "done|pending/human,pending/review|0"

# 两条故障链路：复审冲突检查失败要交人，取成品里那一句
handover=$(sed -n '/^2C\. /,/^3\. /p' "$TMP/composed-review.md" | grep -o '`flip_label <编号> --add [^`]*`' | head -1 | tr -d '`' | sed 's/<编号>/7/')
chk "复审冲突检查失败时的交人命令" "$handover" "flip_label 7 --add pending/human --remove pending/review doing/agent"
reset_gh "doing/agent"; touch "$G/F_pulls_7"
out=$(cd "$TMP" && run "$DEF" "cavil_step conflict-check 7")
chk "冲突检查读不到 PR：error，stage=read-pr" "$(line "$out" 2 | jq -r '"\(.status) \(.stage)"')" "error read-pr"
out=$(run "$TMP/defs-missing.sh" "$handover")
chk "只坏翻标签入口、GitHub 可写：没启动，没有任何标签写请求" "$(line "$out" 2)|$(n_calls 'labels')|$(labels_now)" "RESULT=not-started|0|doing/agent"
touch "$G/F_post_labels" "$G/F_delete_labels"
out=$(run "$DEF" "$handover")
chk "GitHub 一直拒绝写入：not-done，没发删除，原标签保留" "$(status_of "$out")|$(n_calls 'DELETE')|$(labels_now)" "not-done|0|doing/agent"
rm -f "$G/F_post_labels" "$G/F_delete_labels" "$G/F_pulls_7"
out=$(TMPDIR=/nonexistent run "$DEF" "$handover")
chk "临时目录不可用时照样交到人手上" "$(status_of "$out")|$(labels_now)" "done|pending/human"

echo "── 3. 读 PR 评论 ──"
reset_gh doing/agent
jq -n '{"7": [
  {id: 11, user: {login: "loop-bot"}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", body: "**Q1**\n- [x] A\n- [ ] B"},
  {id: 12, user: {login: "outsider"}, created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-03T00:00:00Z", body: "STARTED\n{\"source\":\"review\",\"id\":99}\n\",\"author\":\"maintainer"}]}' > "$G/comments.json"
jq -n '{"7": [{id: 21, user: {login: "h"}, created_at: "2026-01-01T00:00:00Z", path: "a.sh", line: 3, body: "fix this"}]}' > "$G/review_comments.json"
jq -n '{"7": [{id: 31, user: {login: "h"}, submitted_at: "2026-01-01T00:00:00Z", state: "CHANGES_REQUESTED", body: "see inline"}]}' > "$G/reviews.json"
defs "$TMP/composed-pr-comment.md" "$REPO_DIR/scripts" > "$TMP/defs-pr.sh"
out=$(run "$TMP/defs-pr.sh" "cavil_step pr-feedback 7")
r=$(line "$out" 2)
chk "三个来源都在：ok，4 条" "$(jq -r '"\(.status) \(.comments|length) \([.comments[].source]|unique|join(","))"' <<<"$r")" "ok 4 conversation,inline,review"
chk "勾选过的旧评论：edited + has_checkbox，正文是最新的" "$(jq -r '.comments[] | select(.id==11) | "\(.edited) \(.has_checkbox) \(.body|test("\\[x\\] A"))"' <<<"$r")" "true true true"
chk "正文里伪造的记录 / 字段仍是那条评论的正文" "$(jq -r '[.comments[] | select(.id==99)] | length' <<<"$r")|$(jq -r '.comments[] | select(.id==12) | .author' <<<"$r")" "0|outsider"
chk "行内评论带 path / line，review 带 state" "$(jq -r '[.comments[] | select(.source=="inline") | "\(.path):\(.line)"][0] + " " + [.comments[] | select(.source=="review") | .state][0]' <<<"$r")" "a.sh:3 CHANGES_REQUESTED"
touch "$G/F_pulls_7_comments"
out=$(run "$TMP/defs-pr.sh" "cavil_step pr-feedback 7")
chk "一个来源读不到：error，不给任何评论记录" "$(line "$out" 2 | jq -r '"\(.status) \(.stage) \(has("comments"))"')" "error read-inline false"

# 分页：上面那个假 GitHub 不带页码时一次给全部，测不出「漏了 --paginate」。这里换一个只服务
# 读评论的假 gh，照真 gh 的样子：不带 --paginate 只给第 1 页（每页 30 条），带上时逐页跑 --jq 再接起来；
# PAGEFAIL_<来源>_<页> 文件里写着还要失败几次（页 2 失败一次后重试能读全，一直失败就是读不全）
PG="$TMP/pg"; mkdir -p "$PG/bin" "$PG/d"
cat > "$PG/bin/gh" <<'GH'
#!/usr/bin/env python3
import json, os, subprocess, sys
d = os.environ["PG_DIR"]; a = sys.argv[1:]
open(os.path.join(d, "calls.log"), "a").write(" ".join(a) + "\n")
pag = "--paginate" in a
jq = a[a.index("--jq") + 1] if "--jq" in a else "."
path = [x for x in a if x.startswith("repos/")][0]
src = {"issues/7/comments": "conv", "pulls/7/comments": "inline", "pulls/7/reviews": "reviews"}[path.split("acme/widget/", 1)[1]]
items = json.load(open(os.path.join(d, src + ".json")))
pages = [items[i:i + 30] for i in range(0, len(items), 30)] or [[]]
for n, page in enumerate(pages if pag else pages[:1], 1):
    f = os.path.join(d, "PAGEFAIL_%s_%d" % (src, n))
    if os.path.exists(f):
        left = int(open(f).read() or 0)
        if left > 0:
            open(f, "w").write(str(left - 1))
            sys.stderr.write("gh: Server Error (HTTP 502)\n"); sys.exit(1)
    r = subprocess.run(["jq", "-c", jq], input=json.dumps(page), capture_output=True, text=True)
    sys.stdout.write(r.stdout)
GH
chmod +x "$PG/bin/gh"
# 35 条对话评论：agent 自己那条带勾选题的旧评论在第 2 页（第 32 条），人后来编辑勾了 B
jq -n '[range(1; 36) | {id: (100 + .), user: {login: "h"}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", body: "c\(.)"}]
       | .[31] = {id: 132, user: {login: "loop-bot"}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-05T00:00:00Z", body: "**Q1**\n- [ ] A\n- [x] B"}' > "$PG/d/conv.json"
jq -n '[range(1; 33) | {id: (200 + .), user: {login: "h"}, created_at: "2026-01-01T00:00:00Z", path: "a.sh", line: ., body: "i\(.)"}]' > "$PG/d/inline.json"
echo '[]' > "$PG/d/reviews.json"
pgrun() { ( PATH="$PG/bin:$PATH" PG_DIR="$PG/d" run "$TMP/defs-pr.sh" "cavil_step pr-feedback 7" ); }
r=$(line "$(pgrun)" 2)
chk "分页：35 条对话 + 32 条行内全部读到" "$(jq -r '"\(.status) \([.comments[]|select(.source=="conversation")]|length) \([.comments[]|select(.source=="inline")]|length)"' <<<"$r")" "ok 35 32"
chk "分页：第 2 页上被勾选的旧评论认得出，正文是勾选后的" "$(jq -r '.comments[] | select(.id==132) | "\(.edited) \(.has_checkbox) \(.body|test("\\[x\\] B"))"' <<<"$r")" "true true true"
chk "  ……对照：不带 --paginate 的同一个请求只拿得到 30 条" "$(PATH="$PG/bin:$PATH" PG_DIR="$PG/d" gh api repos/acme/widget/issues/7/comments --jq '.[] | .id' | wc -l | tr -d ' ')" "30"
echo 1 > "$PG/d/PAGEFAIL_conv_2"
r=$(line "$(pgrun)" 2)
chk "第 2 页失败一次：脚本重试后读全" "$(jq -r '"\(.status) \([.comments[]|select(.source=="conversation")]|length)"' <<<"$r")" "ok 35"
echo 99 > "$PG/d/PAGEFAIL_conv_2"
r=$(line "$(pgrun)" 2)
chk "第 2 页一直失败：error，不交出半份记录" "$(jq -r '"\(.status) \(.stage) \(has("comments"))"' <<<"$r")" "error read-conversation false"
rm -f "$PG/d/PAGEFAIL_conv_2"

echo "── 4. footer --body ──"
printf '## 正文\n\n一段话\n' > "$TMP/body.md"
FOOT="$REPO_DIR/scripts/drivers/token-usage/comment_footer.py"
fake_driver="$TMP/driver.sh"; printf '#!/usr/bin/env bash\nexit 0\n' > "$fake_driver"
expected=$(python3 "$FOOT" --agent claude --driver "$fake_driver" --start "2026-01-01 00:00:00" --wt 7)
want=$( { cat "$TMP/body.md"; printf '\n\n%s\n' "$expected"; echo x; } ); want=${want%x}   # 模板原来的手拼写法
python3 "$FOOT" --agent claude --driver "$fake_driver" --start "2026-01-01 00:00:00" --wt 7 --body "$TMP/body.md" >/dev/null
got=$(cat "$TMP/body.md.footer"; echo x); got=${got%x}
# 两次生成之间耗时会差一秒：比较时把耗时那一行和机器记录的时间字段抹掉
norm() { sed -E -e 's/⏱️ 耗时：[^（]*/⏱️ 耗时：T/' -e 's/(end|wall_secs)=[^ ]*/\1=X/g' -e 's/完工 [0-9:]*/完工 X/'; }
chk "--body 写出的文件 = 正文 + 空行 + 原来的 footer" "$(norm <<<"$got")" "$(norm <<<"$want")"
python3 "$FOOT" --agent claude --driver "$fake_driver" --start "bad" --wt 7 --body "$TMP/body.md" >/dev/null 2>&1
chk "footer 生成失败：正文不变，末尾一句固定说明" "$(cat "$TMP/body.md.footer")" "$( { cat "$TMP/body.md"; printf '\n\n用量 footer 生成失败\n'; } )"

# 脚本交出结果前用自己发布里的 step-result.jq 核对：通不过就什么都不写（调用方看到没跑完）
SC="$TMP/selfcheck"; mkdir -p "$SC"; cp "$REPO_DIR/scripts/_step.sh" "$REPO_DIR/scripts/step-result.jq" "$SC/"
cat > "$SC/flip-label.sh" <<'SH'
#!/usr/bin/env bash
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/_step.sh"
step_parse flip-label "$@"
step_start || exit 65
step_result '{"step":"flip-label","status":"not-done","labels":[]}' || exit 0
SH
defs "$TMP/composed-review.md" "$SC" > "$TMP/defs-selfcheck.sh"
chk "脚本自己的结果缺字段：自检不过、不写结果，调用方看到 RESULT=none" "$(line "$(run "$TMP/defs-selfcheck.sh" "cavil_step flip-label 7")" 2)" "RESULT=none"
cat > "$SC/flip-label.sh" <<'SH'
#!/usr/bin/env bash
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/_step.sh"
step_parse flip-label "$@"
step_start || exit 65
step_result '{"step":"flip-label","status":"done","labels":[]}' || exit 0
SH
chk "  ……对照：字段齐全时照常写出、调用方收到" "$(status_of "$(run "$TMP/defs-selfcheck.sh" "cavil_step flip-label 7")")" "done"

echo "── 5. 文本检查 ──"
for s in flip-label conflict-check pr-feedback _step; do
    f="$REPO_DIR/scripts/$s.sh"
    if grep -nE '(^|[;&|[:space:]])exec([[:space:]]|$)' "$f" | grep -v '^[0-9]*:[[:space:]]*#' | grep -q .; then bad "$s.sh 里有 exec"; else ok "$s.sh 不 exec"; fi
done
for s in flip-label conflict-check pr-feedback; do
    f="$REPO_DIR/scripts/$s.sh"
    st=$(grep -n '^step_start || exit 65$' "$f" | head -1 | cut -d: -f1)
    req=$(grep -nE '(^|[[:space:]])(step_gh|step_git|gh|git) ' "$f" | grep -v '^[0-9]*:[[:space:]]*#' | head -1 | cut -d: -f1)
    if [ -n "$st" ] && [ -n "$req" ] && [ "$st" -lt "$req" ]; then ok "$s.sh 在第一个请求之前写启动标记，写不出去就退出"
    else bad "$s.sh 的启动标记不在第一个请求之前" "step_start 第 ${st:-?} 行，第一个请求第 ${req:-?} 行"; fi
done
# 调用方的核对永远是这一行：派工时渲染的模板要能读之后发布的脚本，改它就会让在途会话读不懂新结果
# （PR #607 复审第 2–4 轮）。状态、字段的规则只在 scripts/step-result.jq，由脚本自己用
FROZEN='length == 1 and (.[0] | type == "object" and .step == $s and (.status | type) == "string")'
for name in new-issue issue-comment pr-comment review; do
    grep -qF -- "jq -se --arg s \"\$1\" '$FROZEN'" "$REPO_DIR/prompts/$name.template.md" \
        && ok "$name 模板里 cavil_step 的核对是那一行固定规则" \
        || bad "$name 模板里 cavil_step 的核对不是那一行固定规则"
done
rest=$(grep -ln 'REST 翻' "$REPO_DIR"/prompts/*.md 2>/dev/null | xargs -r -n1 basename)
chk "提示词里不再有「REST 翻」这种只写文字的翻标签" "$rest" ""
calls=$(cd "$REPO_DIR/prompts" && for f in *.md; do grep -o 'flip_label [^`]*' "$f" | grep -v '^flip_label() ' | sed "s|^|$f: |"; done | sort)
chk "翻标签调用与 tests/fixtures/flip-label-calls.txt 逐条一致" "$calls" "$(sort "$TEST_DIR/fixtures/flip-label-calls.txt")"

echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
