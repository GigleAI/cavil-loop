#!/usr/bin/env bash
# kind: e2e
# 合并后的交接：PR 正文登记的待办、issue 上的清单评论和标签、机器人结果通知的依据 —— GitHub#656。
#
# 跑法：bash tests/merge-followup.test.sh
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py，FAKE_GH_LISTS=1
# 打开 issue / PR 列表）+ 假 tmux，HOME 指向临时目录。每一轮都**真的**起 agent-poll.sh 子进程，
# 评论、标签、state.json 都从假 GitHub 和状态文件里读，不读源码。
#
# 这块错了的方向都不报错：
#   · 待办读错（代码块里的示例当成登记、格式不对当成没提）→ 人看不到该做的事
#   · 每个 PR 各发各的、或者只列最后一个 PR 的 → 前一个 PR 的待办从 issue 上消失
#   · 清理没成功就先发评论、翻标签 → 和主干「清理成功后才处理 issue」的顺序不一致
#   · 评论发出但读回不到时重发 → 同一份清单两条
#   · 维护者亲手关闭之后还一直列旧清单 / 被合并带关就算结束 → 清单要么永远不消失、要么提前消失
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/mf"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
# 假 tmux：$FAKE_TMUX_BUSY 存在时，任何 session 都「在」且杀不掉 → cleanup-issue.sh 失败
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
if [ -n "${FAKE_TMUX_BUSY:-}" ] && [ -f "$FAKE_TMUX_BUSY" ]; then
    case "$1" in has-session) exit 0 ;; kill-session) exit 1 ;; capture-pane) exit 0 ;; esac
fi
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

W="$SANDBOX/run"; R="repos/example/mf"
fresh() {
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
    git init -q -b main "$W/project" 2>/dev/null
    GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
    export FAKE_TMUX_BUSY="$W/tmux-busy"
    CONF="$W/cavil-loop.config"
    cat > "$CONF" <<CONF
REPO="example/mf"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="mftest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_BLOCKED=""
LABEL_PENDING_LATER=""
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_DONE="Done"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
    echo '{}' > "$GD/comments.json"; echo '{"maint":"admin"}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$STATE"
}
jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
mkissue() {   # <n> <labels_csv> <open|closed>
    jset items.json '.[$n] = {kind:"issue", state:$s, state_reason:(if $s == "closed" then "completed" else null end),
            title:"需求", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}' --arg n "$1" --arg s "$3"
    jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
    jset events.json '.[$n] = [$l | split(",")[] | select(. != "") | {event:"labeled", label:{name:.}, actor:{login:"maint", type:"User"}, created_at:"2026-01-01T00:00:00Z"}]' \
        --arg n "$1" --arg l "$2"
}
mkmerged() {   # <n> <分支> <正文（"null" = 正文字段异常）> <合并时间> <labels_csv>
    jset items.json '.[$n] = {kind:"pr", state:"closed", merged:true, title:("PR " + $n), body:(if $b == "null" then null else $b end),
            merged_at:$t, merge_commit_sha:("c" * 40), user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z",
            head:{sha:"1111111111111111111111111111111111111111", ref:$r, repo:{full_name:"example/mf"}}, base:{ref:"main"}}' \
        --arg n "$1" --arg r "$2" --arg b "$3" --arg t "$4"
    jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$5"
}
close_by() {   # <issue> <账号> <时间> [commit]：issue 被关闭，记一条 closed 事件
    jset items.json '.[$n].state = "closed" | .[$n].state_reason = "completed"' --arg n "$1"
    jset events.json '.[$n] += [{event:"closed", actor:{login:$a, type:"User"}, created_at:$t, commit_id:(if $c == "" then null else $c end)}]' \
        --arg n "$1" --arg a "$2" --arg t "$3" --arg c "${4:-}"
}
tick() { : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$REPO_DIR/scripts/agent-poll.sh" >/dev/null 2>&1; }
labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
comments_of() { jq -r --arg n "$1" '[(.[$n] // [])[] | select(.body | contains("cavil-loop:merge-followup"))] | length' "$GD/comments.json"; }
last_comment() { jq -r --arg n "$1" '[(.[$n] // [])[] | select(.body | contains("cavil-loop:merge-followup"))] | last | .body // ""' "$GD/comments.json"; }
has() { printf '%s' "$1" | grep -qF -- "$2" && echo yes || echo no; }

LIST=$'<!-- merge-followup:begin -->\n- 谁做：维护者 ｜ 做什么：在生产库执行 `migrate-x.sql` ｜ 怎么触发：部署完成后手动执行\n<!-- merge-followup:end -->'
LIST2=$'<!-- merge-followup:begin -->\n- 谁做：维护者 ｜ 做什么：人工验收登录页 ｜ 怎么触发：部署后打开页面\n<!-- merge-followup:end -->'
NONE='<!-- merge-followup:none -->'

echo "① Refs #N 的 PR 登记了待办，issue 开着 → 一条清单评论 + pending/human；PR 打 Done"
fresh
mkissue 10 "pending/PR" open
mkmerged 11 feature/issue-10 "Refs #10"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
tick
c=$(last_comment 10)
chk "issue 上一条清单评论" "$(comments_of 10)" 1
chk "评论里列出了待办原文" "$(has "$c" '在生产库执行 `migrate-x.sql`')" yes
chk "评论标题说还有待办" "$(has "$c" '还有 1 个 PR 的待办没确认做完')" yes
chk "issue 翻 pending/human、摘 pending/PR" "$(labels_of 10)" "pending/human"
chk "PR 打 Done、摘流程标签" "$(labels_of 11)" "Done"
chk "记为已清理" "$(jq -c '.cleaned_prs' "$STATE")" "[11]"
tick
chk "下一轮不重发" "$(comments_of 10)" 1

echo "② Closes #N 合并带关 issue、PR 有待办 → 评论写明已关闭但还有待办，Done + pending/human"
fresh
mkissue 20 "pending/PR" open
mkmerged 21 feature/issue-20 "Closes #20"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
close_by 20 loop-bot 2026-03-01T10:00:00Z cccc
tick
c=$(last_comment 20)
chk "issue 上一条清单评论" "$(comments_of 20)" 1
chk "评论写明已关闭、待办还没做完" "$(has "$c" '已关闭，但下面的待办还没确认做完')" yes
chk "issue 打 Done 并挂 pending/human 提醒" "$(labels_of 20)" "Done,pending/human"

echo "③ Closes #N 合并带关 issue、PR 写明没有待办 → 不发评论，只打 Done（与主干相同）"
fresh
mkissue 30 "pending/PR" open
mkmerged 31 feature/issue-30 "Closes #30"$'\n\n'"$NONE" 2026-03-01T10:00:00Z ""
close_by 30 loop-bot 2026-03-01T10:00:00Z cccc
tick
chk "不发评论" "$(comments_of 30)" 0
chk "issue 只打 Done" "$(labels_of 30)" "Done"
chk "PR 打 Done" "$(labels_of 31)" "Done"

echo "④ Refs #N、PR 没提待办 → 评论说没写，翻 pending/human"
fresh
mkissue 40 "pending/PR" open
mkmerged 41 feature/issue-40 "Refs #40" 2026-03-01T10:00:00Z ""
tick
c=$(last_comment 40)
chk "一条评论" "$(comments_of 40)" 1
chk "说 PR 没写合并后有没有待办" "$(has "$c" 'PR 没写合并后有没有待办')" yes
chk "翻 pending/human" "$(labels_of 40)" "pending/human"

echo "⑤ 写法不对 → 原文照搬进评论、标出来；代码块里的示例不算登记"
fresh
mkissue 50 "" open
mkmerged 51 feature/issue-50 "Refs #50"$'\n\n<!-- merge-followup:begin -->\n- 谁做：维护者 ｜ 做什么：\n<!-- merge-followup:end -->' 2026-03-01T10:00:00Z ""
mkissue 52 "" open
mkmerged 53 feature/issue-52 "Refs #52"$'\n\n```\n<!-- merge-followup:none -->\n```' 2026-03-01T10:00:00Z ""
tick
c=$(last_comment 50)
chk "格式不对：评论标出写法不对" "$(has "$c" '待办的写法不对')" yes
chk "格式不对：原文照搬" "$(has "$c" '谁做：维护者 ｜ 做什么：')" yes
chk "格式不对：提示去 PR 核对" "$(has "$c" '完整正文见 PR #51')" yes
chk "代码块里的示例 → 算没提" "$(has "$(last_comment 52)" 'PR 没写合并后有没有待办')" yes

echo "⑥ 同一 issue 先后合并两个 PR：第二条评论列全两个 PR 的待办；维护者亲手关闭后旧清单不再列"
fresh
mkissue 60 "" open
mkmerged 61 feature/issue-60 "Refs #60"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
tick
mkmerged 62 feature/issue-60 "Refs #60"$'\n\n'"$LIST2" 2026-03-02T10:00:00Z ""
tick
c=$(last_comment 60)
chk "两条评论（每次合并一条，第二条覆盖两个 PR）" "$(comments_of 60)" 2
chk "第二条仍列第一个 PR 的待办" "$(has "$c" 'migrate-x.sql')" yes
chk "第二条也列第二个 PR 的待办" "$(has "$c" '人工验收登录页')" yes
chk "第二条标出两个 PR" "$(has "$c" 'covers=61,62')" yes
close_by 60 maint 2026-03-03T10:00:00Z
mkmerged 63 feature/issue-60 "Refs #60"$'\n\n'"$NONE" 2026-03-04T10:00:00Z ""
tick
chk "维护者亲手关闭之后合并、写明没有待办的第三个 PR：不再发评论（旧清单已结束）" "$(comments_of 60)" 2
chk "issue 打 Done（关闭、没有待办 → 不挂提醒）" "$(labels_of 60)" "Done"
chk "前两个 PR 记为已结束" "$(jq -c '[.merge_followup.prs["61","62"].ended]' "$STATE")" '["yes","yes"]'
mkmerged 64 feature/issue-60 "Refs #60"$'\n\n'"$LIST2" 2026-03-05T10:00:00Z ""
tick
c=$(last_comment 60)
chk "之后再合并带待办的 PR：只列它自己的待办" "$(has "$c" '人工验收登录页')$(has "$c" 'migrate-x.sql')" "yesno"
chk "关着的 issue 挂上提醒" "$(labels_of 60)" "Done,pending/human"

echo "⑦ 清理失败：等清理成功之后评论和标签一起交付；等的轮次不算重试"
fresh
mkissue 70 "pending/PR" open
mkmerged 71 feature/issue-70 "Refs #70"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
touch "$W/tmux-busy"
tick; tick
chk "清理失败期间没有评论" "$(comments_of 70)" 0
chk "清理失败期间 issue 标签不动" "$(labels_of 70)" "pending/PR"
chk "清理失败期间 PR 不打 Done" "$(labels_of 71)" ""
chk "等的轮次不计重试" "$(jq -r '.merge_followup.targets["70"].tries // 0' "$STATE")" 0
rm -f "$W/tmux-busy"
tick
chk "清理成功后：一条评论" "$(comments_of 70)" 1
chk "清理成功后：pending/human" "$(labels_of 70)" "pending/human"
chk "清理成功后：PR Done" "$(labels_of 71)" "Done"

echo "⑧ 评论发出但调用报失败 → 下一轮按标记找到、不重发"
fresh
mkissue 80 "" open
mkmerged 81 feature/issue-80 "Refs #80"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
touch "$GD/F_post_comment_lost"
tick
rm -f "$GD/F_post_comment_lost"
tick
chk "只有一条评论" "$(comments_of 80)" 1
chk "标签收敛" "$(labels_of 80)" "pending/human"

echo "⑨ 正文字段读不到、分支名认得出目标 → 清单里写「正文读不到」；补读到之后发新的完整评论"
fresh
mkissue 90 "" open
mkmerged 91 feature/issue-90 null 2026-03-01T10:00:00Z ""
tick
c=$(last_comment 90)
chk "评论写正文读不到" "$(has "$c" '正文读不到，有没有待办无法确认')" yes
chk "pending/human" "$(labels_of 90)" "pending/human"
jset items.json '.["91"].body = $b' --arg b "Refs #90"$'\n\n'"$LIST"
tick
c=$(last_comment 90)
chk "补读到后：新评论列出真实待办" "$(has "$c" 'migrate-x.sql')" yes
chk "补读到后：两条评论" "$(comments_of 90)" 2

echo "⑩ 迁移：主干旧的合并后标签条目 → 接管成记录，照新规则交接"
fresh
mkissue 100 "pending/PR" open
mkmerged 101 feature/issue-100 "Refs #100"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "Done"
echo '{"cleaned_prs":[101],"cleaned_issues":[],"merged_label_queue":{"100":{"pr":"101","tries":1}}}' > "$STATE"
tick
chk "旧条目已删" "$(jq -c '.merged_label_queue' "$STATE")" "{}"
chk "接管后发了清单评论" "$(comments_of 100)" 1
chk "issue 翻 pending/human" "$(labels_of 100)" "pending/human"

echo "⑪ 正文读不到、分支名也认不出属于哪个 issue → 不清理本机；30 轮后在 PR 本身上交人兜底"
fresh
mkmerged 111 chore/misc null 2026-03-01T10:00:00Z ""
tick
chk "第 1 轮：不清理、不记已清理" "$(jq -c '.cleaned_prs' "$STATE")/$(jq -r '.merge_followup.prs["111"].cleanup' "$STATE")" "[]/ended"
chk "第 1 轮：PR 上还没有兜底评论" "$(comments_of 111)" 0
for _ in $(seq 2 31); do tick; done
c=$(last_comment 111)
chk "30 轮后：PR 上一条兜底评论" "$(comments_of 111)" 1
chk "兜底评论写正文读不到、本机没清理" "$(has "$c" '正文读不到')/$(has "$c" '合并扫描没有为这个 PR 清理本机工作区')" "yes/yes"
chk "PR 挂 Done + pending/human" "$(labels_of 111)" "Done,pending/human"
chk "兜底送达记为是" "$(jq -r '.merge_followup.prs["111"].fb.sent' "$STATE")" true
tick
chk "之后不再重发" "$(comments_of 111)" 1

echo "⑫ 给机器人的结果评论（表 2）：只在证据齐全时写「需求已完成」"
nt() { printf '%s' "$1" | python3 -B "$REPO_DIR/scripts/merge_followup.py" notice | jq -r '"\(.row) \(.done)"'; }
B='"pr":"5","title":"t","base":"main","sha":"abc"'
chk "有待办 → 第 1 行，不写完成" "$(nt '{'"$B"',"conc":{"followups":true,"fu":[]},"own_s":"list","guard":false,"target_state":"closed","maintainer_closed":true}')" "1 false"
chk "有更早的正文读不到、兜底没送达 → 第 2 行" "$(nt '{'"$B"',"conc":{"followups":false,"fu":[]},"own_s":"none","guard":true,"target_state":"closed","maintainer_closed":true}')" "2 false"
chk "这个 PR 没提 → 第 3 行" "$(nt '{'"$B"',"conc":{"followups":false,"fu":[]},"own_s":"silent","guard":false,"target_state":"closed","maintainer_closed":true}')" "3 false"
chk "写明没有待办、维护者亲手关闭 → 第 4 行「需求已完成」" "$(nt '{'"$B"',"conc":{"followups":false,"fu":[]},"own_s":"none","guard":false,"target_state":"closed","maintainer_closed":true}')" "4 true"
chk "写明没有待办、被合并带关（不是维护者亲手关）→ 第 5 行" "$(nt '{'"$B"',"conc":{"followups":false,"fu":[]},"own_s":"none","guard":false,"target_state":"closed","maintainer_closed":false}')" "5 false"
chk "写明没有待办、目标还开着 → 第 5 行" "$(nt '{'"$B"',"conc":{"followups":false,"fu":[]},"own_s":"none","guard":false,"target_state":"open","maintainer_closed":false}')" "5 false"
chk "旧评论说过完成、现在不是完成 → 更正开头" "$(printf '%s' '{'"$B"',"conc":{"followups":true,"fu":[]},"own_s":"list","guard":false,"target_state":"open","correction":true}' | python3 -B "$REPO_DIR/scripts/merge_followup.py" notice | jq -r .body | head -1)" "## 更正：上一条『需求已完成』不准确"

echo "⑬ 关闭来源：PR 带关的关闭事件 commit_id 也是空的，只有 closer 为空才算维护者亲手关；读不到 closer = 判不了"
fresh
mkissue 130 "" open
mkmerged 131 feature/issue-130 "Refs #130"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
tick
# 维护者账号做的、但其实是别的 PR 带关的关闭（closer = PullRequest，commit_id 空）
jset items.json '.["130"].state = "closed" | .["130"].state_reason = "completed"'
jset events.json '.["130"] += [{event:"closed", actor:{login:"maint", type:"User"}, created_at:"2026-03-02T10:00:00Z", commit_id:null, closer:{"__typename":"PullRequest"}}]'
mkmerged 132 feature/issue-130 "Refs #130"$'\n\n'"$NONE" 2026-03-03T10:00:00Z ""
tick
chk "PR 带关（closer = PullRequest）→ 第一个 PR 的清单没结束、照列" "$(jq -r '.merge_followup.prs["131"].ended // "no"' "$STATE")/$(has "$(last_comment 130)" 'migrate-x.sql')" "no/yes"
fresh
mkissue 133 "" open
mkmerged 134 feature/issue-133 "Refs #133"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
tick
close_by 133 maint 2026-03-02T10:00:00Z
mkmerged 135 feature/issue-133 "Refs #133"$'\n\n'"$NONE" 2026-03-03T10:00:00Z ""
touch "$GD/F_graphql_closer"
tick
chk "关闭来源读不到 → 判不了，清单照列并注明无法确认" "$(jq -r '.merge_followup.prs["134"].ended // "no"' "$STATE")/$(has "$(last_comment 133)" '无法确认之后维护者是否亲手关闭过')" "no/yes"
rm -f "$GD/F_graphql_closer"
mkmerged 136 feature/issue-133 "Refs #133"$'\n\n'"$NONE" 2026-03-04T10:00:00Z ""
tick
chk "对照：同形的关闭、closer 为空（人亲手关）→ 记为已结束" "$(jq -r '.merge_followup.prs["134"].ended // "no"' "$STATE")" "yes"

echo "⑭ PR 自己的 Done 没写成 → 不算交接完成；下一轮只补标签、清单评论不重发"
fresh
mkissue 140 "pending/PR" open
mkmerged 141 feature/issue-140 "Refs #140"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
touch "$GD/F_post_label_Done"
tick
chk "第 1 轮：清单评论发了、PR 没 Done（先加 Done，失败就停，旧流程标签还在）、PR 记录没记已交接" "$(comments_of 140)/$(labels_of 141)/$(jq -r '.merge_followup.prs["141"].handed // "none"' "$STATE")" "1/pending/review/none"
rm -f "$GD/F_post_label_Done"
tick
chk "第 2 轮：PR 补上 Done、记已交接，评论仍只有一条" "$(comments_of 140)/$(labels_of 141)/$(jq -r '.merge_followup.prs["141"].handed // "none"' "$STATE")" "1/Done/1"

echo "⑮ 交接失败的目标：没有新合并、清理也没变化就一直停着；有新 PR 并进来才重新计数"
fresh
mkissue 150 "" open
mkmerged 151 feature/issue-150 "Refs #150"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
touch "$GD/F_issues_150"
tick
jq '.merge_followup.targets["150"] += {tries: 30, failed: "读不到", wake: false}' "$STATE" > "$STATE.t" && mv "$STATE.t" "$STATE"
rm -f "$GD/F_issues_150"
tick; tick
chk "失败之后两轮：没有评论、仍标着失败、次数不归零" "$(comments_of 150)/$(jq -r '.merge_followup.targets["150"].failed // "none"' "$STATE")/$(jq -r '.merge_followup.targets["150"].tries' "$STATE")" "0/读不到/30"
mkmerged 152 feature/issue-150 "Refs #150"$'\n\n'"$NONE" 2026-03-02T10:00:00Z ""
tick
chk "有新 PR 并进来 → 重新交接（覆盖两个 PR）" "$(comments_of 150)/$(has "$(last_comment 150)" 'covers=151,152')/$(jq -r '.merge_followup.targets["150"].failed // "none"' "$STATE")" "1/yes/none"

echo "⑯ 两次判定之间目标变了（挂上新一轮的流程标签）→ 这一轮零写入；下一轮按新状态交付"
fresh
mkissue 160 "pending/PR" open
mkmerged 161 feature/issue-160 "Refs #160"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
printf 'cd %q && jq %q labels.json > l.tmp && mv l.tmp labels.json\n' "$GD" '.["160"] += ["pending/review"]' > "$GD/hook_issues_160_comments_1"
tick
chk "这一轮：清单评论没发、issue 标签没被 daemon 写" "$(comments_of 160)/$(labels_of 160)" "0/pending/PR,pending/review"
chk "  → 到达性：hook 确实在两次判定之间跑了" "$([ -f "$GD/count_issues_160_comments" ] && echo ran || echo no)" "ran"
tick
chk "下一轮：按新状态发清单评论（写明新一轮在进行，标签不动）" "$(comments_of 160)/$(has "$(last_comment 160)" '已挂着新一轮的流程标签')/$(labels_of 160)" "1/yes/pending/PR,pending/review"

echo "⑰ 关闭来源的回答不完整（缺 closer 字段、closer 没有类型名）→ 判不了；回答里明确是 null 才算亲手关"
for shape in missing notype; do
    fresh
    mkissue 170 "" open
    mkmerged 171 feature/issue-170 "Refs #170"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
    tick
    jset items.json '.["170"].state = "closed" | .["170"].state_reason = "completed"'
    jset events.json '.["170"] += [{event:"closed", actor:{login:"maint", type:"User"}, created_at:"2026-03-02T10:00:00Z", commit_id:null, closer_shape:$s}]' --arg s "$shape"
    mkmerged 172 feature/issue-170 "Refs #170"$'\n\n'"$NONE" 2026-03-03T10:00:00Z ""
    tick
    chk "closer 回答 $shape → 没记结束、清单照列并注明无法确认" "$(jq -r '.merge_followup.prs["171"].ended // "no"' "$STATE")/$(has "$(last_comment 170)" '无法确认之后维护者是否亲手关闭过')" "no/yes"
done

echo "⑱ 分支最新提交和记录对不上（合并提交、分支名都一样）→ 不写"
fresh
mkissue 180 "" open
mkmerged 181 feature/issue-180 "Refs #180"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
touch "$GD/F_issues_180"
tick
rm -f "$GD/F_issues_180"
jset items.json '.["181"].head.sha = "9999999999999999999999999999999999999999"'
tick; tick
chk "现读 head.sha 和记录不同 → 零评论、日志写明对不上" "$(comments_of 180)/$(grep -c 'PR #181 现读的身份和记录对不上' "$W/state/poll.log")" "0/2"

echo "⑲ 合并之后有人给 PR 挂了流程标签（新一轮）→ PR 的标签不动，issue 照常交接"
fresh
mkissue 190 "" open
mkmerged 191 feature/issue-190 "Refs #190"$'\n\n'"$LIST" 2026-03-01T10:00:00Z ""
jset labels.json '.["191"] = ["pending/review"]'
jset events.json '.["191"] = [{event:"labeled", label:{name:"pending/review"}, actor:{login:"maint", type:"User"}, created_at:"2026-03-01T12:00:00Z"}]'
tick
chk "PR 标签原样、issue 有清单评论并翻 pending/human" "$(labels_of 191)/$(comments_of 190)/$(labels_of 190)" "pending/review/1/pending/human"
chk "  → 交接照常收敛" "$(jq -r '.merge_followup.prs["191"].handed // "none"' "$STATE")" "1"

echo "⑳ 给 PR 写标签的两步之间有人挂上 pending/review → 停手；下一轮认出是新一轮，不摘它"
fresh
mkissue 200 "" open
mkmerged 201 feature/issue-200 "Refs #200"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/merge"
printf 'cd %q && jq %q labels.json > l.tmp && mv l.tmp labels.json && jq %q events.json > e.tmp && mv e.tmp events.json\n' "$GD" \
    '.["201"] += ["pending/review"]' '.["201"] += [{event:"labeled", label:{name:"pending/review"}, actor:{login:"maint", type:"User"}, created_at:"2026-03-02T00:00:00Z"}]' \
    > "$GD/hook_after_POST_issues_201_labels_1"
tick
chk "这一轮：加了 Done 之后停手，pending/review 和 pending/merge 都还在、没记已交接" "$(labels_of 201)/$(jq -r '.merge_followup.prs["201"].handed // "none"' "$STATE")" "Done,pending/merge,pending/review/none"
tick
chk "下一轮：认出合并后挂上的是新一轮，PR 标签一个不动，交接收敛" "$(labels_of 201)/$(jq -r '.merge_followup.prs["201"].handed // "none"' "$STATE")/$(comments_of 200)" "Done,pending/merge,pending/review/1/1"

echo "㉑ PR 上的流程标签找不到「加上」它的事件 → 判不了，PR 标签不动、不算交接完成；事件补齐后照常收敛"
fresh
mkissue 210 "" open
mkmerged 211 feature/issue-210 "Refs #210"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
touch "$GD/nosynth_211"
jset events.json '.["211"] = [{event:"merged", actor:{login:"maint", type:"User"}, created_at:"2026-03-01T10:00:00Z"}]'
tick; tick
chk "两轮：PR 标签原样、没记已交接、日志写明判不了" "$(labels_of 211)/$(jq -r '.merge_followup.prs["211"].handed // "none"' "$STATE")/$([ "$(grep -c 'PR #211 有流程标签找不到加上它的事件' "$W/state/poll.log")" -ge 2 ] && echo yes)" "pending/review/none/yes"
jset events.json '.["211"] = [{event:"labeled", label:{name:"pending/review"}, actor:{login:"maint", type:"User"}, created_at:"2026-02-28T10:00:00Z"}, {event:"merged", actor:{login:"maint", type:"User"}, created_at:"2026-03-01T10:00:00Z"}]'
tick
chk "事件补齐（合并之前挂的）→ 摘掉、打 Done、交接收敛" "$(labels_of 211)/$(jq -r '.merge_followup.prs["211"].handed // "none"' "$STATE")" "Done/1"

echo "㉒ 加上流程标签的事件缺时间 → 读不全，PR 标签不动"
fresh
mkissue 220 "" open
mkmerged 221 feature/issue-220 "Refs #220"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
jset events.json '.["221"] = [{event:"labeled", label:{name:"pending/review"}, actor:{login:"maint", type:"User"}, created_at:""}]'
tick; tick
chk "两轮：PR 标签原样、没记已交接" "$(labels_of 221)/$(jq -r '.merge_followup.prs["221"].handed // "none"' "$STATE")" "pending/review/none"
chk "  → 到达性：确实读不全（日志）" "$([ "$(grep -c 'PR #221 的标签或标签事件读不全' "$W/state/poll.log")" -ge 2 ] && echo yes)" "yes"

echo "㉓ 两步写之间同名标签被摘掉又挂回去（标签集合不变）→ 停手；下一轮认出是新一轮，不摘它"
fresh
mkissue 230 "" open
mkmerged 231 feature/issue-230 "Refs #230"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
printf 'cd %q && jq %q events.json > e.tmp && mv e.tmp events.json\n' "$GD" \
    '.["231"] += [{event:"unlabeled", label:{name:"pending/review"}, actor:{login:"maint", type:"User"}, created_at:"2026-03-02T00:00:00Z"}, {event:"labeled", label:{name:"pending/review"}, actor:{login:"maint", type:"User"}, created_at:"2026-03-02T00:00:01Z"}]' \
    > "$GD/hook_after_POST_issues_231_labels_1"
tick
chk "这一轮：只加了 Done 就停手，pending/review 还在、没记已交接" "$(labels_of 231)/$(jq -r '.merge_followup.prs["231"].handed // "none"' "$STATE")" "Done,pending/review/none"
chk "  → 到达性：日志写明两次写之间被改" "$(grep -c 'PR #231 的标签在两次写之间被人改了' "$W/state/poll.log")" "1"
tick
chk "下一轮：重挂的 pending/review 是合并之后挂的 → 不动，交接收敛" "$(labels_of 231)/$(jq -r '.merge_followup.prs["231"].handed // "none"' "$STATE")" "Done,pending/review/1"

echo "㉔ 交接目标是 PR 本身、写了一半（加了 Done 和提醒、摘旧标签失败）→ 下一轮认得出提醒是自己加的，接着摘旧标签收尾"
fresh
mkmerged 241 chore/no-issue "改了点东西"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
touch "$GD/F_delete_labels"
tick
chk "第 1 轮：Done、提醒加上了，旧标签摘不掉，没记已交接" "$(labels_of 241)/$(jq -r '.merge_followup.prs["241"].handed // "none"' "$STATE")" "Done,pending/human,pending/review/none"
chk "  → 挂上提醒后当场记下了写入账号这次加上的那条事件" "$(jq -r '.merge_followup.prs["241"].reminder_ev | type' "$STATE")" "number"
rm -f "$GD/F_delete_labels"
tick
chk "第 2 轮：摘掉旧标签、提醒留着、交接收敛（没把自己加的提醒当成新一轮）" "$(labels_of 241)/$(jq -r '.merge_followup.prs["241"].handed // "none"' "$STATE")/$(jq -r '.merge_followup.prs["241"].pr_superseded // false' "$STATE")" "Done,pending/human/1/false"

echo "㉕ 两步写之间 PR 的目标分支变了（标签不变）→ 停手，之后也不再写"
fresh
mkissue 250 "" open
mkmerged 251 feature/issue-250 "Refs #250"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
printf 'cd %q && jq %q items.json > i.tmp && mv i.tmp items.json\n' "$GD" '.["251"].base.ref = "release"' > "$GD/hook_after_POST_issues_251_labels_1"
tick
chk "这一轮：加了 Done 就停手，旧标签还在、没记已交接、日志写明" "$(labels_of 251)/$(jq -r '.merge_followup.prs["251"].handed // "none"' "$STATE")/$(grep -c 'PR #251 的标签在两次写之间被人改了' "$W/state/poll.log")" "Done,pending/review/none/1"
tick
chk "下一轮：身份和记录对不上，不再写" "$(labels_of 251)/$(jq -r '.merge_followup.prs["251"].handed // "none"' "$STATE")" "Done,pending/review/none"

echo "㉖ 合并之后另一轮用同一个写入账号给 PR 挂了 pending/human（交接从没往这个 PR 写过提醒）→ 认不出归属：标签一个不动、不记完成；到上限在 PR 上留说明一次"
fresh
echo 'SUB_ISSUE_ROLLUP_MAX_TRIES=3' >> "$CONF"
mkissue 260 "" open
mkmerged 261 feature/issue-260 "Refs #260"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review,pending/human"
jset events.json '.["261"] = [{event:"labeled", label:{name:"pending/human"}, actor:{login:"loop-bot", type:"Bot"}, created_at:"2026-03-02T00:00:00Z"}]'
tick
chk "第 1 轮：PR 标签原样、没记让位也没记完成、issue 照常发清单" "$(labels_of 261)/$(jq -r '.merge_followup.prs["261"].pr_superseded // false' "$STATE")/$(jq -r '.merge_followup.prs["261"].handed // "none"' "$STATE")/$(comments_of 260)" "pending/human,pending/review/false/none/1"
chk "  → 到达性：日志写明认不出归属" "$(grep -c 'PR #261 合并之后写入账号挂的 pending/human 认不出' "$W/state/poll.log")" "1"
unote() { jq -r --arg n "$1" '[(.[$n] // [])[] | select(.body | contains("cavil-loop:merge-followup-unclaimed"))] | length' "$GD/comments.json"; }
chk "  → 还没到上限，PR 上没有说明" "$(unote 261)" "0"
tick; tick
chk "第 3 轮（到上限）：PR 上留了一条说明，标签仍原样，交接没记完成" "$(unote 261)/$(labels_of 261)/$(jq -r '.merge_followup.prs["261"].handed // "none"' "$STATE")" "1/pending/human,pending/review/none"
chk "  → 说明写明要维护者看的标签" "$(jq -r '[.["261"][] | select(.body | contains("merge-followup-unclaimed"))][0].body' "$GD/comments.json" | grep -c '摘掉它和其他合并前的流程标签')" "1"
tick
chk "之后再轮：说明不重复" "$(unote 261)" "1"

echo "㉗ 交接给 PR 挂上提醒后读不回事件 → 本轮停手；下一轮提醒认不出归属：旧标签不摘、不记完成"
fresh
mkmerged 271 chore/no-issue "改了点东西"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
printf 'touch %q\n' "$GD/F_issues_271_events" > "$GD/hook_after_POST_issues_271_labels_2"
tick
chk "第 1 轮：Done 和提醒加上了、旧标签还在、没记下事件、没记完成" "$(labels_of 271)/$(jq -r '.merge_followup.prs["271"].reminder_ev // "none"' "$STATE")/$(jq -r '.merge_followup.prs["271"].handed // "none"' "$STATE")" "Done,pending/human,pending/review/none/none"
chk "  → 到达性：日志写明挂完读不回" "$(grep -c 'PR #271 挂完提醒读不回事件' "$W/state/poll.log")" "1"
rm -f "$GD/F_issues_271_events"
tick
chk "第 2 轮：认不出归属，旧标签不摘、不记完成、不记让位" "$(labels_of 271)/$(jq -r '.merge_followup.prs["271"].handed // "none"' "$STATE")/$(jq -r '.merge_followup.prs["271"].pr_superseded // false' "$STATE")" "Done,pending/human,pending/review/none/false"

echo "㉘ 挂上提醒和读回之间，同一账号把它摘掉又挂回 → 不认领；下一轮认不出归属，标签不动"
fresh
mkmerged 281 chore/no-issue "改了点东西"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
printf 'cd %q && jq %q events.json > e.tmp && mv e.tmp events.json\n' "$GD" \
    '.["281"] += [{event:"unlabeled", label:{name:"pending/human"}, actor:{login:"loop-bot", type:"Bot"}, created_at:"2026-03-02T00:00:00Z"}, {event:"labeled", label:{name:"pending/human"}, actor:{login:"loop-bot", type:"Bot"}, created_at:"2026-03-02T00:00:01Z"}]' \
    > "$GD/hook_after_POST_issues_281_labels_2"
tick
chk "第 1 轮：没认领、旧标签还在、没记完成" "$(labels_of 281)/$(jq -r '.merge_followup.prs["281"].reminder_ev // "none"' "$STATE")/$(jq -r '.merge_followup.prs["281"].handed // "none"' "$STATE")" "Done,pending/human,pending/review/none/none"
chk "  → 到达性：日志写明认不出这次加上的事件" "$(grep -c 'PR #281 挂完提醒认不出这次加上的那条事件' "$W/state/poll.log")" "1"
tick
chk "第 2 轮：认不出归属，标签不动、不记完成" "$(labels_of 281)/$(jq -r '.merge_followup.prs["281"].handed // "none"' "$STATE")" "Done,pending/human,pending/review/none"

echo "㉙ 认领之后、摘旧标签之前，同一账号把提醒摘掉又挂回 → 写完读回对不上、不记完成；下一轮认不出归属，不再写"
fresh
mkmerged 291 chore/no-issue "改了点东西"$'\n\n'"$LIST" 2026-03-01T10:00:00Z "pending/review"
printf 'cd %q && jq %q events.json > e.tmp && mv e.tmp events.json\n' "$GD" \
    '.["291"] += [{event:"unlabeled", label:{name:"pending/human"}, actor:{login:"loop-bot", type:"Bot"}, created_at:"2026-03-02T00:00:00Z"}, {event:"labeled", label:{name:"pending/human"}, actor:{login:"loop-bot", type:"Bot"}, created_at:"2026-03-02T00:00:01Z"}]' \
    > "$GD/hook_DELETE_issues_291_labels_1"
tick
chk "第 1 轮：认领了本次的事件、写完读回对不上、没记完成" "$(jq -r '.merge_followup.prs["291"].reminder_ev | type' "$STATE")/$(jq -r '.merge_followup.prs["291"].handed // "none"' "$STATE")" "number/none"
cp "$GD/labels.json" "$W/l1"; : > "$CALLS"
tick
chk "  → 到达性：这一轮读了 PR 的事件" "$(grep -c 'issues/291/events' "$CALLS" | awk '{print ($1>0)?"yes":"no"}')" "yes"
chk "第 2 轮：认不出归属，没有任何标签写入、不记完成" "$(grep -c 'issues/291/labels' "$CALLS")/$(jq -r '.merge_followup.prs["291"].handed // "none"' "$STATE")/$(cmp -s "$GD/labels.json" "$W/l1" && echo same)" "0/none/same"

report_counts "$pass" "$fail"
echo "正式版：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
