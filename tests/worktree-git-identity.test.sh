#!/usr/bin/env bash
# kind: e2e
# 提交署名跟着条目上的人走（GitHub#699）：worker 在 worktree 里的提交署成条目的负责人 / 提出者，找不到用
# 配置的身份；关掉开关或确定没人合格时撤回旧署名，读取失败时保留上一次的结果。
#
# 跑法：bash tests/worktree-git-identity.test.sh   （约 2 分钟）
# 依赖：bash、jq、python3、git。常驻假 GitHub（tests/lib/fake_github.py）+ 假 tmux / 假 claude，HOME 指向临时目录；
# 跑的是真实的派工脚本（dispatch-new-issue.sh → create-worktree.sh、dispatch-issue-comment.sh、
# dispatch-pr-comment.sh）、真实 git worktree，每条断言都先在 worktree 里真提交一次，再读这次提交的
# 作者 / 提交者的姓名和邮箱四项。
#
# 身份层次：仓库共用配置写 RepoName <repo@example.invalid>，全局配置（GIT_CONFIG_GLOBAL）写
# GlobalName <global@example.invalid>，两者不同，看得出提交身份是从哪一层来的。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
printf '[user]\n\tname = GlobalName\n\temail = global@example.invalid\n' > "$SANDBOX/gitconfig-global"
export GIT_CONFIG_GLOBAL="$SANDBOX/gitconfig-global" GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL EMAIL
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT LABEL_PENDING_BLOCKED GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN POLL_FAKE_NOW
# 从 worker 会话里跑时会继承派工变量（DISPATCH_WORKER_AGENT=codex、DISPATCH_PROMPT_KIND=review……），一律清掉
unset ${!DISPATCH_@} ${!CODING_AGENT_@} ${!CAVIL_@}
unset WORKTREE_GIT_USER_NAME WORKTREE_GIT_USER_EMAIL WORKTREE_GIT_USER_FROM_ITEM REQUESTER_BOT_ACCOUNT
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/wi"
R="example/wi"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
# 假 tmux（同 smoke）：new-session 记一行，之后 has-session 认得这个会话；别的命令一律成功
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
log="${FAKE_TMUX_LOG:?}"
case "$1" in
    new-session)
        name=""; prev=""
        for a in "$@"; do [ "$prev" = -s ] && name="$a"; prev="$a"; done
        echo "new-session $name" >> "$log"; echo "$name" >> "$log.live"; exit 0 ;;
    has-session)
        t=""; prev=""
        for a in "$@"; do [ "$prev" = -t ] && t="${a#=}"; prev="$a"; done
        grep -qxF -- "$t" "$log.live" 2>/dev/null; exit $? ;;
    ls|list-sessions) [ -s "$log.live" ] && cat "$log.live"; exit 0 ;;
esac
exit 0
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux" "$SANDBOX/bin/claude"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1"; echo "     期望：[$3]"; echo "     实得：[$2]"; fail=$((fail+1)); fi
}

# 真的 origin（裸库）；PR 的提交放在 refs/pull/<n>/head 上（PR 派工从那里取）
git init -q --bare -b main "$SANDBOX/origin.git"
git clone -q "$SANDBOX/origin.git" "$SANDBOX/seed" 2>/dev/null
N_PRA=987150
(cd "$SANDBOX/seed" && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main \
    && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m "pr work" && git push -q origin "HEAD:refs/pull/$N_PRA/head") >/dev/null 2>&1

# 账号：maint / alice / bob / carol 有写权限，outsider 只有读权限；loop-bot 是 loop 的写入账号；
# reqbot 是外部需求机器人；helper[bot] 是 GitHub 应用账号
noreply() { printf '%s+%s@users.noreply.github.com' "$(jq -r --arg l "$1" '.[$l].id' "$SANDBOX/users.json")" "$1"; }
cat > "$SANDBOX/users.json" <<'J'
{"maint": {"id": 1003}, "alice": {"id": 1001}, "bob": {"id": 1002}, "carol": {"id": 1004},
 "outsider": {"id": 1005}, "loop-bot": {"id": 1006}, "reqbot": {"id": 1007}, "helper[bot]": {"id": 1008, "type": "Bot"}}
J
REPO_ID="RepoName|repo@example.invalid|RepoName|repo@example.invalid"
id_of() { printf '%s|%s|%s|%s' "$1" "$(noreply "$1")" "$1" "$(noreply "$1")"; }

W=""; GD=""; CONF=""
world() {   # 新的一套：主 checkout、假 GitHub 状态、配置（追加的配置行从参数给）
    W="$SANDBOX/w$((++WORLD_N))"
    GD="$W/gh"; CONF="$W/cavil-loop.config"
    mkdir -p "$W/state" "$W/wt" "$GD"
    git clone -q "$SANDBOX/origin.git" "$W/project" 2>/dev/null
    git -C "$W/project" config user.name RepoName
    git -C "$W/project" config user.email repo@example.invalid
    export FAKE_GH_DIR="$GD" FAKE_TMUX_LOG="$W/tmux.log"
    echo '{}' > "$GD/events.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/comments.json"
    echo loop-bot > "$GD/me"
    cp "$SANDBOX/users.json" "$GD/users.json"
    echo '{"maint":"admin","alice":"write","bob":"write","carol":"write","outsider":"read","reqbot":"write"}' > "$GD/perms.json"
    echo '{}' > "$GD/items.json"
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$W/state/state.json"
    conf "$@"
}
WORLD_N=0
conf() {    # 重写配置：基础几行 + 参数里的每一行
    cat > "$CONF" <<CONF
REPO="$R"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="witest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
AGENT_TRUST_PROMPT_WAIT_SECS=1
WORKER_SECRET_ENV=""
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
    chmod 600 "$CONF"
}
# 条目：<编号> <kind> <作者> <作者类型> <负责人，逗号分隔，可空> [父 issue 编号]
item() {
    local n="$1" kind="$2" au="$3" at="$4" as="$5" parent="${6:-}"
    jq --arg n "$n" --arg k "$kind" --arg au "$au" --arg at "$at" --arg as "$as" --arg p "$parent" --arg r "$R" '
        .[$n] = ({kind: $k, state: "open", title: "条目", body: "x", user: {login: $au, type: $at},
                  assignees: ($as | split(",") | map(select(. != "")) | map({login: ., type: (if endswith("[bot]") then "Bot" else "User" end)})),
                  updated_at: "2026-01-01T00:00:00Z"}
                 + (if $p != "" then {parent_issue_url: ("https://api.github.com/repos/" + $r + "/issues/" + $p)} else {} end)
                 + (if $k == "pr" then {merged: false, draft: false,
                      head: {sha: "1111111111111111111111111111111111111111", ref: ("feature/issue-" + $p), repo: {full_name: $r}},
                      base: {ref: "main"}} else {} end))' "$GD/items.json" > "$GD/items.json.t" && mv "$GD/items.json.t" "$GD/items.json"
}
set_assignees() {   # <编号> <负责人，逗号分隔，可空>
    jq --arg n "$1" --arg as "$2" '.[$n].assignees = ($as | split(",") | map(select(. != "")) | map({login: ., type: "User"}))' \
        "$GD/items.json" > "$GD/items.json.t" && mv "$GD/items.json.t" "$GD/items.json"
}
run_new() { env CODING_AGENT_CONFIG="$CONF" timeout 60 bash "$REPO_DIR/scripts/dispatch-new-issue.sh" "$1" >>"$W/dispatch.log" 2>&1; }
run_cmt() { env CODING_AGENT_CONFIG="$CONF" timeout 60 bash "$REPO_DIR/scripts/dispatch-issue-comment.sh" "$1" 0 >>"$W/dispatch.log" 2>&1; }
run_pr()  { env CODING_AGENT_CONFIG="$CONF" timeout 60 bash "$REPO_DIR/scripts/dispatch-pr-comment.sh" "$1" "$2" 0 >>"$W/dispatch.log" 2>&1; }
# 在 <工作编号> 的 worktree 里真提交一次，读这次提交的作者 / 提交者四项
ident() {
    local wt="$W/wt/issue-$1"
    [ -d "$wt" ] || { echo "无 worktree"; return; }
    git -C "$wt" commit -q --allow-empty -m "probe" >/dev/null 2>&1 || { echo "提交失败"; return; }
    git -C "$wt" log -1 --format='%an|%ae|%cn|%ce'
}
calls() { grep -c -E "$1" "$GD/calls.log" 2>/dev/null || true; }
main_ident() { git -C "$W/project" var GIT_AUTHOR_IDENT | sed 's/ [0-9]* [-+][0-9]*$//'; }

echo "【1】条目自己的负责人"
world
item 987101 issue maint User alice
run_new 987101
chk "负责人 alice 有写权限 → 提交署 alice（姓名、免公开邮箱，作者和提交者）" "$(ident 987101)" "$(id_of alice)"
chk "到达性 · 确实查了 alice 的权限和账号编号" "$(calls 'collaborators/alice/permission') $(calls 'api users/alice')" "1 1"
chk "主 checkout 的身份没被改" "$(main_ident)" "RepoName <repo@example.invalid>"
item 987102 issue maint User outsider,bob
run_new 987102
chk "两个负责人、第一个是外部账号 → 跳过，署第二个 bob" "$(ident 987102)" "$(id_of bob)"
chk "两个条目的 worktree 各署各的：987101 仍是 alice" "$(ident 987101)" "$(id_of alice)"
chk "主 checkout 的身份仍没被改" "$(main_ident)" "RepoName <repo@example.invalid>"
chk "身份写在 worktree 自己那一层（仓库共用配置里还是 RepoName）" "$(git -C "$W/project" config --file "$W/project/.git/config" user.name)" "RepoName"

echo "【2】沿着链找负责人：父 issue、PR 绑定的 issue"
world
item 987110 issue maint User carol
item 987111 issue loop-bot User "" 987110
run_new 987111
chk "子 issue 没负责人、父 issue 负责人 carol → 署 carol" "$(ident 987111)" "$(id_of carol)"
item 987112 issue maint User alice
item "$N_PRA" pr loop-bot User "" 987112
run_pr "$N_PRA" feature/issue-987112
chk "PR 没负责人、绑定的 issue 负责人 alice → 署 alice（PR 全新建 worktree 的路径）" "$(ident 987112)" "$(id_of alice)"
set_assignees "$N_PRA" bob
run_pr "$N_PRA" feature/issue-987112
chk "PR 自己有负责人 bob → 先用 PR 的（worktree 已在的路径）" "$(ident 987112)" "$(id_of bob)"

echo "【3】没有负责人 → 提出者；提出者是机器人就看父 issue 的提出者"
world "REQUESTER_BOT_ACCOUNT=reqbot"
item 987120 issue maint User ""
run_new 987120
chk "没有负责人、提出者 maint → 署 maint" "$(ident 987120)" "$(id_of maint)"
item 987121 issue carol User ""
item 987122 issue loop-bot User "" 987121
run_new 987122
chk "提出者是 loop 账号 → 署父 issue 的提出者 carol" "$(ident 987122)" "$(id_of carol)"
item 987123 issue 'helper[bot]' Bot "" 987121
run_new 987123
chk "提出者是应用账号 helper[bot] → 署父 issue 的提出者 carol" "$(ident 987123)" "$(id_of carol)"
item 987124 issue reqbot User "" 987121
run_new 987124
chk "提出者是外部需求机器人（即使有写权限）→ 署父 issue 的提出者 carol" "$(ident 987124)" "$(id_of carol)"
item 987125 issue alice User "" 987121
set_assignees 987121 bob
run_new 987125
chk "负责人优先于提出者：子 issue 提出者 alice，父 issue 负责人 bob → 署 bob" "$(ident 987125)" "$(id_of bob)"

echo "【4】一路都不合格 → 配置的身份；兜底为空 → 仓库 / 全局原来的身份"
world
item 987130 issue outsider User ""
run_new 987130
chk "提出者是外部账号、没有父 issue、兜底为空 → 仓库原来的身份" "$(ident 987130)" "$REPO_ID"
world 'WORKTREE_GIT_USER_NAME="FbName"' 'WORKTREE_GIT_USER_EMAIL="fb@example.invalid"'
item 987131 issue outsider User ""
run_new 987131
chk "同上、兜底两项都填 → 兜底身份" "$(ident 987131)" "FbName|fb@example.invalid|FbName|fb@example.invalid"
world
git -C "$W/project" config --unset user.name; git -C "$W/project" config --unset user.email
item 987132 issue outsider User ""
run_new 987132
chk "仓库共用配置也没身份 → 全局身份" "$(ident 987132)" "GlobalName|global@example.invalid|GlobalName|global@example.invalid"

echo "【5】开关关掉 → 不读 GitHub 上的人，直接用配置的身份"
for v in false '""'; do
    world "WORKTREE_GIT_USER_FROM_ITEM=$v" 'WORKTREE_GIT_USER_NAME="FbName"'
    item 987140 issue maint User alice
    run_new 987140
    chk "开关写 $v → 兜底姓名 + 仓库邮箱" "$(ident 987140)" "FbName|repo@example.invalid|FbName|repo@example.invalid"
    chk "开关写 $v → 没有查任何人的权限或账号编号" "$(calls 'collaborators/[^ ]*/permission|api users/')" "0"
    chk "到达性 · 派工确实跑了（建了 worktree、起了会话）" "$(grep -c 'new-session witest-issue987140' "$W/tmux.log")" "1"
done

echo "【6】读取失败：第一次建 worktree 用配置的身份；已署过人的保留"
world 'WORKTREE_GIT_USER_NAME="FbName"' 'WORKTREE_GIT_USER_EMAIL="fb@example.invalid"'
item 987150 issue maint User alice
touch "$GD/F_collaborators_alice_permission"
run_new 987150
chk "第一次就读不到 alice 的权限 → 配置的身份" "$(ident 987150)" "FbName|fb@example.invalid|FbName|fb@example.invalid"
chk "到达性 · 确实去查了 alice 的权限" "$(calls 'collaborators/alice/permission')" "1"
rm -f "$GD/F_collaborators_alice_permission"
run_cmt 987150
chk "恢复后再派工 → alice" "$(ident 987150)" "$(id_of alice)"
touch "$GD/F_users_alice"
run_cmt 987150
chk "读不到 alice 的账号编号 → 保留 alice，不撤" "$(ident 987150)" "$(id_of alice)"
rm -f "$GD/F_users_alice"
item 987151 issue loop-bot User "" 987152
touch "$GD/F_issues_987152"
run_new 987151
chk "读不到父 issue → 第一次用配置的身份" "$(ident 987151)" "FbName|fb@example.invalid|FbName|fb@example.invalid"

echo "【7】负责人中途换了 → 会话不重起，下一次派工后的提交署新负责人"
world
item 987160 issue maint User alice
run_new 987160
chk "起初署 alice" "$(ident 987160)" "$(id_of alice)"
set_assignees 987160 bob
run_cmt 987160
chk "换成 bob 后再派工 → 署 bob" "$(ident 987160)" "$(id_of bob)"
chk "没有重起会话（只起过一次）" "$(grep -c 'new-session witest-issue987160' "$W/tmux.log")" "1"

echo "【8】跨轮退出：先署成 alice，再改条件、再派工、再提交"
cross() {   # <说明> <期望> <改条件的命令…>
    local what="$1" want="$2"; shift 2
    world "${CROSS_CONF[@]}"
    item 987170 issue outsider User alice
    run_new 987170
    chk "$what · 第一轮先署成 alice" "$(ident 987170)" "$(id_of alice)"
    "$@"
    run_cmt 987170
    chk "$what" "$(ident 987170)" "$want"
}
CROSS_CONF=()
cross "关掉开关、兜底两项都空 → 仓库原来的身份" "$REPO_ID" conf "WORKTREE_GIT_USER_FROM_ITEM=false"
cross "撤掉负责人、链上再没有合格的人 → 仓库原来的身份" "$REPO_ID" set_assignees 987170 ""
lose_perm() { jq '.alice = "read"' "$GD/perms.json" > "$GD/p.t" && mv "$GD/p.t" "$GD/perms.json"; }
cross "alice 失去写权限 → 仓库原来的身份" "$REPO_ID" lose_perm
cross "关掉开关、只填兜底姓名 → 兜底姓名 + 仓库邮箱（不是 alice 的邮箱）" \
    "FbName|repo@example.invalid|FbName|repo@example.invalid" conf "WORKTREE_GIT_USER_FROM_ITEM=false" 'WORKTREE_GIT_USER_NAME="FbName"'
cross "关掉开关、只填兜底邮箱 → 仓库姓名 + 兜底邮箱（不是 alice 的姓名）" \
    "RepoName|fb@example.invalid|RepoName|fb@example.invalid" conf "WORKTREE_GIT_USER_FROM_ITEM=false" 'WORKTREE_GIT_USER_EMAIL="fb@example.invalid"'
cross "撤掉负责人、兜底两项都填 → 兜底身份" \
    "FbName|fb@example.invalid|FbName|fb@example.invalid" \
    eval 'set_assignees 987170 ""; conf "WORKTREE_GIT_USER_NAME=\"FbName\"" "WORKTREE_GIT_USER_EMAIL=\"fb@example.invalid\""'
perm_fail() { touch "$GD/F_collaborators_alice_permission"; }
cross "这一轮读不到 alice 的权限 → 仍是 alice（不撤）" "$(id_of alice)" perm_fail
# 资料读不全（缺账号名、缺类型）= 判不了，和读取失败一样保留；明确的空列表、明确不合格的账号才撤（上面几条是对照）
patch_item() { jq --arg f "$1" '.["987170"] |= (. as $it | $f | fromjson | . as $p | $it + $p)' "$GD/items.json" > "$GD/i.t" && mv "$GD/i.t" "$GD/items.json"; }
cross "负责人列表为空、提出者资料是空对象 → 仍是 alice（不撤）" "$(id_of alice)" patch_item '{"assignees": [], "user": {}}'
cross "负责人列表里有一条空记录（提出者是明确的外部账号）→ 仍是 alice（不撤）" "$(id_of alice)" patch_item '{"assignees": [{}]}'
cross "负责人记录缺账号类型 → 仍是 alice（不补成真人、不撤）" "$(id_of alice)" patch_item '{"assignees": [{"login": "bob"}]}'
cross "提出者账号名是空字符串 → 仍是 alice（不撤）" "$(id_of alice)" patch_item '{"assignees": [], "user": {"login": "", "type": "User"}}'

echo
echo "结果：$pass 通过 / $fail 失败"
report_counts "$pass" "$fail"
[ "$fail" = 0 ]
