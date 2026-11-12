#!/usr/bin/env bash
# kind: e2e
# 托管合并：改动碰了「合并前必须人过目」的文件就交人 —— GitHub#337（AUTOPILOT_HUMAN_PATHS）。
#
# 跑法：bash tests/autopilot-human-paths.test.sh
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py）+ 假 tmux，HOME 指向
# 临时目录。每一轮都**真的**起 agent-poll.sh 子进程；「合没合、翻了什么标签、说了什么」都从假 GitHub 的调用
# 记录和状态里读，不读源码。
#
# 单独一个文件、不放进 tests/autopilot.test.sh：那个文件的每份负对照都把整套场景重跑一遍，场景加在那里
# 每周发版的关卡要多跑一百多遍。本文件不带负对照（GitHub#234 起不新增）。
#
# 这块错了的方向都不报错：
#   · 没配清单的项目行为变了（多读、多写、文字变了）→ 升级后托管悄悄变样
#   · 读不全（缺页、缺自报数、坏响应）当成「没命中」→ 该人过目的改动被自动合并
#   · 写错的条目被忽略 → 清单少了一条，没人知道
#   · 根目录写法和任意深度写法分不清 → 拦多了或拦少了
#   · 判定命中之后不重读就交人 → 人刚改完状态又被写一遍
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR \
      DISPATCH_AUTOPILOT_WHERE DISPATCH_PROMPT_KIND AUTOPILOT_HUMAN_PATHS AUTOPILOT_HUMAN_PATHS_DEFAULT
unset GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN
export FAKE_GH_REPO="example/ap"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/tmux"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then
        echo "  ✅ $1"; pass=$((pass+1))
    else
        echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1))
        if [ -n "${KEEP_SANDBOX:-}" ] && [ -n "${W:-}" ]; then
            cp "$W/state/poll.log" "$SANDBOX/fail-$fail.poll.log" 2>/dev/null; cp "$W/gh/calls.log" "$SANDBOX/fail-$fail.calls.log" 2>/dev/null
        fi
    fi
}
section() { echo "$1"; }

# 改动前的脚本（没配清单时逐字节对拍用）
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old"
rm -rf "$SANDBOX/old/prompts"; cp -r "$REPO_DIR/prompts" "$SANDBOX/old/prompts"

H1=1111111111111111111111111111111111111111
H2=2222222222222222222222222222222222222222
R="repos/example/ap"
SCRIPTS="$REPO_DIR/scripts"
W="$SANDBOX/run"

fresh() {   # [额外配置行…]
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
    git init -q "$W/project" 2>/dev/null
    GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
    CONF="$W/cavil-loop.config"
    cat > "$CONF" <<CONF
REPO="example/ap"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="aptest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AUTOPILOT="autopilot"
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
AUTOPILOT_UNKNOWN_MAX=3
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
    EVN=0
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
    echo '{}' > "$GD/comments.json"; echo '{"maint":"admin","helper":"read"}' > "$GD/perms.json"
    echo '{}' > "$GD/checks.json"; echo '{}' > "$GD/files.json"; echo loop-bot > "$GD/me"
}
jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
ev() {   # <n> <labeled|unlabeled> <标签> <操作人>
    EVN=$((EVN + 1))
    jset events.json '.[$n] = ((.[$n] // []) + [{event:$e, label:{name:$l}, actor:{login:$a, type:"User"}, created_at:$c}])' \
        --arg n "$1" --arg e "$2" --arg l "$3" --arg a "$4" --arg c "$(printf '2026-01-01T00:%02d:00Z' "$EVN")"
}
# 一个准备好合并的托管 PR：issue 7（maint 打的托管标签）+ PR 8，复审记录和测试重跑记录齐全
happy() {
    jset items.json '.["7"] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}'
    jset labels.json '.["7"] = ["autopilot","pending/PR"]'
    ev 7 labeled autopilot maint
    jset items.json '.["8"] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:"做了 X。\n\nRefs #7",
            user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
            head:{sha:$h, ref:"feature/issue-7", repo:{full_name:"example/ap"}}, base:{ref:"main"},
            mergeable:true, mergeable_state:"clean"}' --arg h "$H1"
    jset labels.json '.["8"] = ["pending/merge","autopilot"]'
    ev 8 labeled autopilot loop-bot
    echo '{}' > "$STATE"
    jq --arg h "$H1" '.autopilot.prs["8"] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}' \
        "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    jset comments.json '.["8"] = [{id:900, user:{login:"loop-bot"}, created_at:"2026-06-01T00:00:00Z",
            body:("## ✅ 复审通过\n\n<!-- autopilot-review-pass head=" + $h + " passed=12 failed=0 -->")}]' --arg h "$H1"
}
files() { jset files.json '.["8"] = $f' --argjson f "$1"; }   # <JSON 数组>
tick() { : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "${1:-$SCRIPTS}/agent-poll.sh" >/dev/null 2>&1; }
n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
merged() { n_calls "^gh api -X PUT $R/pulls/8/merge "; }
labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
has_label() { case ",$(labels_of 8)," in *",$1,"*) echo yes ;; *) echo no ;; esac; }
comments_with() { jq -r '(.["8"] // [])[].body' "$GD/comments.json" | grep -cF -- "$1" || true; }
writes() { n_calls "^gh api -X (POST|PUT|DELETE|PATCH) "; }
files_reads() { n_calls "^gh api --paginate --slurp $R/pulls/8/files"; }
unknown_n() { jq -r '.autopilot.prs["8"].unknown // 0' "$STATE" 2>/dev/null; }
hook() {   # <key> <第几次读之前> <在假 GitHub 目录里跑的命令>
    printf 'cd %q && { %s; } < /dev/null\n' "$GD" "$3" > "$GD/hook_$1_$2"
}
jhook() {  # <key> <k> <文件> <jq 表达式>：第 k 次读之前原地改假 GitHub 的一个状态文件
    hook "$1" "$2" "jq '$4' $3 > $3.tmp && mv $3.tmp $3"
}
ON='AUTOPILOT_HUMAN_PATHS="default"'

# ─────────────────────────────────────────────────────────────────────────
section "【1】没配清单（不写 / 写成空）：GitHub 调用、state.json、评论、标签和改动前逐字节一致"
# 四个场景各自从干净状态起跑若干轮；连读数不正常的情况也要一样（没配就是原来的代码）
off_run() {   # <scripts 根> <配置行（可空）> <场景> → 输出一份可比的记录
    local root="$1" line="$2" sc="$3" i
    if [ -n "$line" ]; then fresh "$line"; else fresh; fi
    happy
    case "$sc" in
        clean) ;;
        dotgithub) files '[{"filename":"scripts/x.sh"},{"filename":".github/workflows/ci.yml"}]' ;;
        emptypages) files '[{"filename":"client/package.json"}]'; printf '[[]]' > "$GD/raw_pulls_8_files" ;;
        readfail) : > "$GD/F_pulls_8_files" ;;
        packagejson) files '[{"filename":"client/package.json"}]' ;;
    esac
    for i in 1 2 3; do
        tick "$root/scripts"
        echo "── 第 $i 轮调用"; cat "$CALLS"
    done
    # daemon 翻标签时假 GitHub 把条目的更新时间记成「现在」，state 里引用它的地方按秒变：抹成同一个占位
    echo "── state"; jq -S 'del(.autopilot.handoff)' "$STATE" | sed -E 's/20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/<时间>/g'
    echo "── 标签"; jq -S . "$GD/labels.json"
    echo "── 评论"; jq -S '[.[] | .[] | .body]' "$GD/comments.json"
    echo "── 合并后交接记录（去掉时间）"; jq -S '(.autopilot.handoff // {}) | map_values(.body)' "$STATE"
}
if ! compat_skip "没配清单时的调用、state、评论、标签与改动前" "$SANDBOX/old" "$REPO_DIR" scripts; then
    for sc in clean dotgithub emptypages readfail packagejson; do
        old=$(off_run "$SANDBOX/old" "" "$sc")
        for line in "" 'AUTOPILOT_HUMAN_PATHS=""'; do
            new=$(off_run "$REPO_DIR" "$line" "$sc")
            chk "场景 $sc，${line:-不写这一行} → 和改动前一样" "$([ -n "$new" ] && [ "$old" = "$new" ] && echo same || echo differ)" same
            [ "$old" = "$new" ] || [ -z "${KEEP_SANDBOX:-}" ] || { printf '%s\n' "$old" > "$SANDBOX/off-$sc.old"; printf '%s\n' "$new" > "$SANDBOX/off-$sc.new"; }
        done
    done
fi
# 到达性：上面比的不是两份空记录——没配清单时这几个场景确实合并了 / 交人了
fresh; happy; files '[{"filename":"client/package.json"}]'; tick
chk "到达性 · 没配清单：改 package.json 的 PR 照常合并" "$(merged)" 1
fresh; happy; files '[{"filename":".github/workflows/ci.yml"}]'; tick
chk "到达性 · 没配清单：改 .github/ 的 PR 交人，文字是原来那句" "$(has_label pending/human)/$(comments_with '改动碰了 `.github/` 目录（Actions 和仓库自动化）')" "yes/1"
chk "到达性 · 没配清单：交人前只读了一次文件列表（没有新加的重判）" "$(files_reads)" 1

# ─────────────────────────────────────────────────────────────────────────
section "【2】配了默认清单：命中 → 交人并列出文件；没命中 → 照常合并"
for c in 'client/package.json|[{"filename":"scripts/x.sh"},{"filename":"client/package.json"}]|深层的 package.json' \
         '.claude/settings.json|[{"filename":".claude/settings.json"}]|根目录的 agent 配置' \
         '.github/workflows/ci.yml|[{"filename":".github/workflows/ci.yml"}]|.github/（清单里始终有）' \
         '.husky/pre-commit|[{"filename":"hooks.txt","previous_filename":".husky/pre-commit"}]|改名前的旧路径' \
         '.agents/skills/cavil-loop/prompts/review.extra.md|[{"filename":".agents/skills/cavil-loop/prompts/review.extra.md"}]|项目级提示词覆盖'; do
    IFS='|' read -r hit fj what <<< "$c"
    fresh "$ON"; happy; files "$fj"
    tick
    chk "$what → 不合并" "$(merged)" 0
    chk "$what → 交人：挂 pending/human、摘 pending/merge" "$(has_label pending/human)/$(has_label pending/merge)" "yes/no"
    chk "$what → 说明里列出命中的文件" "$(comments_with "改动碰了合并前需人过目的文件：\`$hit\`")" 1
    chk "$what → 交人前把文件列表又读了一遍（重判）" "$(files_reads)" 2
done
fresh "$ON"; happy; files '[{"filename":"scripts/x.sh"},{"filename":"docs/a.md"},{"filename":"apackage.json"},{"filename":"Makefile.am"}]'
tick
chk "只改脚本、文档和名字相近的文件 → 照常合并" "$(merged)/$(has_label pending/human)" "1/no"
chk "到达性 · 这一轮读了文件列表（决定时 + 合并前各一次）" "$(files_reads)" 2

fresh "$ON"; happy
files "$(jq -nc '[range(0; 12) | {filename: ("pkg\(. + 100)/package.json")}]')"
tick
chk "命中 12 个 → 说明只列 10 个，写「等 12 个」" "$(comments_with '`pkg109/package.json` 等 12 个')/$(comments_with 'pkg110')" "1/0"

# ─────────────────────────────────────────────────────────────────────────
section "【3】条目写法：开头 / 只认根目录，不写 = 任何深度；末尾 / = 目录"
# 清单 | 改动的文件 | 期望（hit = 交人，ok = 合并）
while IFS='|' read -r spec f want; do
    [ -n "$spec" ] || continue
    fresh "AUTOPILOT_HUMAN_PATHS=\"$spec\""; happy; files "[{\"filename\":\"$f\"}]"
    tick
    got=$([ "$(merged)" = 1 ] && echo ok || { [ "$(has_label pending/human)" = yes ] && echo hit || echo other; })
    chk "清单 [$spec]，改 $f → $want" "$got" "$want"
done <<'EOF'
/setup.sh|setup.sh|hit
/setup.sh|tools/setup.sh|ok
setup.sh|setup.sh|hit
setup.sh|tools/setup.sh|hit
setup.sh|tools/setup.sh.bak|ok
/scripts/|scripts/x.sh|hit
/scripts/|scripts/a/b/x.sh|hit
/scripts/|client/scripts/x.sh|ok
/scripts/|scripts|ok
.husky/|.husky/pre-commit|hit
.husky/|a/b/.husky/pre-commit|hit
.husky/|a/x.husky/pre-commit|ok
/docs/*.md|docs/a.md|hit
/docs/*.md|docs/sub/a.md|ok
/docs/*.md|docs/amd|ok
default /scripts/|scripts/x.sh|hit
default /scripts/|client/package.json|hit
default,/scripts/|scripts/x.sh|hit
/scripts/|client/package.json|ok
/scripts/|.github/workflows/ci.yml|hit
/scripts/|sub/.github/x.yml|ok
EOF

# ─────────────────────────────────────────────────────────────────────────
section "【4】清单里有写法不认识的条目 → 交人并写明是哪一条，不悄悄忽略"
for bad in 'a/b.txt' '/../x' '**' '/a//b'; do
    fresh "AUTOPILOT_HUMAN_PATHS=\"default $bad\""; happy    # 改动本身没碰清单里的任何文件
    tick
    chk "条目 [$bad] → 不合并、交人" "$(merged)/$(has_label pending/human)" "0/yes"
    chk "条目 [$bad] → 说明点名这个条目" "$(comments_with "写法不认识：\`$bad（")" 1
    chk "条目 [$bad] → 不用读文件列表" "$(files_reads)" 0
done

# ─────────────────────────────────────────────────────────────────────────
section "【5】读全：自报的改动文件数和列表对得上才算读全；读不全绝不当成没命中"
fresh "$ON"; happy; files '[]'
tick
chk "真没有改动（自报 0、列表空）→ 照常合并" "$(merged)" 1

unread() {   # <说明> <日志里应出现的原因>：本轮不合并、不写、计一次读不到
    tick
    chk "$1 → 不合并、不写任何东西" "$(merged)/$(writes)" "0/0"
    chk "$1 → 计一次读不到" "$(unknown_n)" 1
    chk "$1 → 日志写明原因" "$(grep -cF -- "$2" "$W/state/poll.log")" 1
}
# 下面每个场景里真正被改的都是 package.json：读不全时一旦当成「没命中」就会合并
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; jset items.json '.["8"].changed_files = 3'
printf '[[{"filename":"scripts/x.sh"}]]' > "$GD/raw_pulls_8_files"
unread "列表缺页（1 个，自报 3 个）" "列表有 1 个文件，PR 自报 3 个"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; printf '[[]]' > "$GD/raw_pulls_8_files"
unread "每页都是空、自报 1 个" "列表有 0 个文件，PR 自报 1 个"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; jset items.json '.["8"].changed_files = "__missing__"'
unread "PR 详情里缺改动文件数" "PR 详情里没有可用的改动文件数"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; jset items.json '.["8"].changed_files = "1"'
unread "改动文件数不是数字" "PR 详情里没有可用的改动文件数"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; printf '[[{"sha":"abc"}]]' > "$GD/raw_pulls_8_files"
unread "条目缺文件名" "文件列表的形状不对"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; printf '{"message":"Server Error"}' > "$GD/raw_pulls_8_files"
unread "响应不是按页的数组" "文件列表的形状不对"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; printf '<html>502</html>' > "$GD/raw_pulls_8_files"
unread "响应不是 JSON" "文件列表不是合法的 JSON"
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'; : > "$GD/F_pulls_8_files"
unread "请求失败" "请求失败或空输出"

tick; tick
chk "连续 3 轮读不全（上限）→ 交人，不合并" "$(merged)/$(has_label pending/human)/$(has_label pending/merge)" "0/yes/no"
chk "  → 说明写连续读不到和最后一次的原因" "$(comments_with '连续 3 轮读不到判断所需的信息')/$(comments_with '读不全 PR #8 的改动文件列表')" "1/1"

fresh "$ON"; happy; : > "$GD/F_pulls_8_files"
tick; tick
chk "读不全两轮后（未到上限）没写过东西" "$(unknown_n)/$(has_label pending/human)" "2/no"
rm -f "$GD/F_pulls_8_files"
tick
chk "之后读全了、没命中 → 照常合并" "$(merged)" 1

# ─────────────────────────────────────────────────────────────────────────
section "【6】判定命中之后、交人之前有变化 → 重判拦住，本轮什么都不写"
# 第 2 次读（= 交人前的重判）之前改掉 GitHub 上的状态
re() {   # <说明> <key> <文件> <jq 表达式>
    fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'
    jhook "$2" 2 "$3" "$4"
    tick
    chk "$1 → 本轮不写、不合并" "$(writes)/$(merged)/$(comments_with '需人过目')" "0/0/0"
    chk "$1 → 到达性：第一次判定确实读了文件列表" "$([ "$(files_reads)" -ge 1 ] && echo yes || echo no)" yes
}
re "新推送把文件改回去了（同一提交号的列表变了）" pulls_8_files files.json '.["8"] = [{"filename":"scripts/x.sh"}]'
tick
chk "  → 下一轮按现状：没命中，合并" "$(merged)" 1
re "命中的文件换了一批" pulls_8_files files.json '.["8"] = [{"filename":"Makefile"}]'
tick
chk "  → 下一轮按现状交人，说明写的是新的文件" "$(comments_with '需人过目的文件：`Makefile`')/$(comments_with 'client/package.json')" "1/0"
re "PR 被关闭" pulls_8 items.json '.["8"].state = "closed"'
re "PR 推了新提交" pulls_8 items.json ".[\"8\"].head.sha = \"$H2\""
re "PR 改投了别的目标分支" pulls_8 items.json '.["8"].base.ref = "release"'
re "有人摘了 pending/merge" pulls_8 labels.json '.["8"] = ["autopilot"]'
re "issue 上摘了托管标签" pulls_8 labels.json '.["7"] = ["pending/PR"]'
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'
# 假 GitHub 先看失败开关、再跑 hook：第 1 次读的 hook 里打开开关，第 2 次读（重判）就失败
hook pulls_8_files 1 ': > F_pulls_8_files'
tick
chk "重判时文件列表请求失败 → 本轮不写" "$(writes)/$(has_label pending/human)" "0/no"
chk "  → 到达性：第一次读到了命中、第二次读（重判）确实发出并失败" \
    "$(files_reads)/$([ -e "$GD/F_pulls_8_files" ] && echo 开关已开 || echo 没开)/$(grep -cF '交人之前重判有变化（重判结果 unknown：读不全 PR #8 的改动文件列表（请求失败或空输出））' "$W/state/poll.log")" "2/开关已开/1"

fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'
jhook pulls_8 2 labels.json '.["8"] += ["pending/human"]'
tick
chk "重判时人已在 PR 上挂了 pending/human → daemon 不发说明、不动标签" "$(writes)/$(comments_with '需人过目')" "0/0"
# 到达性：第一次判定读了文件列表（命中）；重判读 PR 时标签已被挂上，停在读文件列表之前；两个标签都原样留着
chk "  → 到达性：第一次命中、重判读到了人挂的标签并停下" \
    "$(files_reads)/$(n_calls "^gh api $R/pulls/8\$")/$(has_label pending/human)/$(has_label pending/merge)/$(grep -cF '交人之前重判有变化（重判结果 halt_pr' "$W/state/poll.log")" "1/2/yes/yes/1"

section "【7】决定时没命中、合并请求前一刻新推了清单里的文件 → 不合并"
fresh "$ON"; happy
jhook pulls_8_files 2 files.json '.["8"] = [{"filename":"scripts/x.sh"},{"filename":"client/package.json"}]'
tick
chk "合并前重读拦住 → 不合并、本轮不写" "$(merged)/$(writes)" "0/0"
tick
chk "  → 下一轮交人，列出文件" "$(has_label pending/human)/$(comments_with '需人过目的文件：`client/package.json`')" "yes/1"

# ─────────────────────────────────────────────────────────────────────────
section "【8】文档里给维护者照抄的配置行：两份文档一致，每一行都是 daemon 认得的写法"
ex_of() { sed -n '/<!-- autopilot-human-paths:examples:begin -->/,/<!-- autopilot-human-paths:examples:end -->/p' "$1" | grep -E '^AUTOPILOT_HUMAN_PATHS='; }
EX_EN=$(ex_of "$REPO_DIR/docs/operations.md"); EX_ZH=$(ex_of "$REPO_DIR/docs/operations.zh.md")
chk "两份文档的示例行一致，且至少有 3 行" "$([ -n "$EX_EN" ] && [ "$EX_EN" = "$EX_ZH" ] && [ "$(printf '%s\n' "$EX_EN" | wc -l)" -ge 3 ] && echo yes || echo no)" yes
while IFS= read -r line; do
    [ -n "$line" ] || continue
    fresh "$line"; happy; files '[{"filename":"docs/a.md"}]'
    tick
    chk "示例 $line：只改文档的 PR 照常合并（清单写法都认得）" "$(merged)" 1
    fresh "$line"; happy; files '[{"filename":".claude/settings.json"}]'
    tick
    chk "示例 $line：改 agent 配置的 PR 交人" "$(merged)/$(has_label pending/human)" "0/yes"
done <<< "$EX_EN"
# 开启 → 生效 → 关掉（删掉这一行）→ 恢复，全程同一份配置、同一份 state 和假 GitHub，不重建环境
fresh "$ON"; happy; files '[{"filename":"client/package.json"}]'
tick
chk "生命周期 ① 开启后第一轮：改 package.json 的 PR #8 交人、没合并" "$(merged)/$(has_label pending/human)/$(has_label pending/merge)" "0/yes/no"
# 第二个候选：issue 9 + PR 10，同样只改 package.json（不动已有的 state 和夹具，只往里加）
jset items.json '.["9"] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}'
jset labels.json '.["9"] = ["autopilot","pending/PR"]'
ev 9 labeled autopilot maint
jset items.json '.["10"] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:"做了 Y。\n\nRefs #9",
        user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
        head:{sha:$h, ref:"feature/issue-9", repo:{full_name:"example/ap"}}, base:{ref:"main"},
        mergeable:true, mergeable_state:"clean"}' --arg h "$H2"
jset labels.json '.["10"] = ["pending/merge","autopilot"]'
ev 10 labeled autopilot loop-bot
jq --arg h "$H2" '.autopilot.prs["10"] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}' \
    "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
jset comments.json '.["10"] = [{id:950, user:{login:"loop-bot"}, created_at:"2026-06-01T00:00:00Z",
        body:("## ✅ 复审通过\n\n<!-- autopilot-review-pass head=" + $h + " passed=12 failed=0 -->")}]' --arg h "$H2"
jset files.json '.["10"] = [{"filename":"client/package.json"}]'
merged10() { n_calls "^gh api -X PUT $R/pulls/10/merge "; }
tick
chk "生命周期 ② 仍开着：新候选 PR #10 也交人、没合并" "$(merged10)/$(labels_of 10)" "0/autopilot,pending/human"
# 维护者想让 #10 按旧规则走：照文档删掉配置行，再把 #10 送回合并队列
grep -v '^AUTOPILOT_HUMAN_PATHS=' "$CONF" > "$CONF.tmp" && mv "$CONF.tmp" "$CONF"
chk "生命周期 ③ 配置行已删" "$(grep -c '^AUTOPILOT_HUMAN_PATHS=' "$CONF")" 0
jset labels.json '.["10"] = ["pending/merge","autopilot"]'
jq --arg h "$H2" '.autopilot.prs["10"] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}' \
    "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
tick
chk "生命周期 ④ 删掉之后：PR #10 按旧规则合并" "$(merged10)" 1
chk "生命周期 ④ 已经交给人的 PR #8 仍在人手上：没合并、标签没动、没有新留言" \
    "$(merged)/$(labels_of 8)/$(comments_with 'cavil-loop daemon')" "0/autopilot,pending/human/1"
chk "模板里这一项是空值（不写和照抄模板行为一样）" "$(grep -cE '^AUTOPILOT_HUMAN_PATHS=""$' "$REPO_DIR/cavil-loop.config.example")" 1

echo
compat_summary
echo "通过 $pass / 失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
