#!/usr/bin/env bash
# kind: e2e
# 周报把多个项目合并成一份（GitHub#232）：各仓库独立采数，只在结果层合并，同号不串账。
#
# 跑法：bash tests/weekly-report-multi-repo.test.sh            （默认回归，~7 s）
#       MUTATION=1 bash tests/weekly-report-multi-repo.test.sh （再跑 5 项负对照，~10 s）
# 依赖：bash / python3 / jq / git。走真实入口 scripts/weekly-report/run.sh（不加 --dry-run，
# 一路走到「开 issue」那一步）：真实 collect.py / merge.py / render.py / report.py 子进程，
# 假 gh（按仓库返回不同数据、记下每次调用带的凭据）、假 node（出图）、假 curl（公网 200），
# 临时 HOME、两个真 git 仓库（各有自己的 origin）、两套独立的假 claude 日志，不读本机真实日志。
#
# 夹具：两个项目 alpha（主，acme/alpha）与 beta（acme/beta），**都有 #42**：
#   alpha #42 窗口 10:00–11:00，日志里 10:20 一次调用 out=100 万、10:15–10:25 一轮 →
#             日志重算 $25（记录里写的是 $40）；处理时长 600 s
#   beta  #42 窗口 10:10–11:10，日志里 10:30 一次调用 out=10 万（记录写 out 50 万、缓存读取
#             30 万，日志里一条缓存读取都没有）→ 检出缺失，沿用原记录值 $7、token 50 万；
#             10:30–10:50 一轮 → 处理时长 1200 s
#   beta  #44 / #45 各 600 s、$1，没有日志 → 沿用原值（只为让中位数分得出「重算」和「平均」）
# 两边的窗口重叠、编号相同：只要被放进同一次认领，alpha 10:20 那次调用就会归给 start 更晚的
# beta，alpha 一次调用都没认领到（重算成 $0、处理时长拿不到），beta 照旧回退，两条重叠派工
# 一条重算一条回退、整组变成「不可相加」——下面第 2 组的断言就是为分开这两种实现写的
# （负对照 M1 实际跑一遍「合进同一次认领」的做法）。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/mutation.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/mutation.sh"
# shellcheck source=lib/compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/compat.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; echo "       期望 $3"; echo "       实得 $2"; fail=$((fail+1)); fi; }

export TZ=Asia/Shanghai
W=2025-01-06
export HOME="$TMP/home"; mkdir -p "$HOME/.config/cavil-loop"
export CLAUDE_PROJECTS_DIR="$TMP/projects"
export CODEX_SESSIONS_DIR="$TMP/codex"
export XDG_CACHE_HOME="$TMP/cache"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
printf '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
unset GH_TOKEN GITHUB_TOKEN WEEKLY_REPORT_EXTRA_PROJECTS WEEKLY_REPORT_BOT_LOGINS 2>/dev/null || true

# ── 被测脚本：本版，和合并基线（只用于「不配附加项目时逐字节一致」）──
mkdir -p "$TMP/new" "$TMP/old"
cp -r "$REPO_DIR/scripts" "$TMP/new/"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
git -C "$REPO_DIR" archive "$BASE_REV" scripts | tar -x -C "$TMP/old"

# ── 假外部命令 ──
FIX="$TMP/fix"; mkdir -p "$FIX" "$TMP/bin"
cat > "$TMP/bin/gh" <<'SH'
#!/usr/bin/env bash
# 假 gh：api --paginate repos/<owner>/<name>/... 按仓库返回 $FIX/<owner>_<name>/ 下的数据；
# issue create 记下正文；每次调用连同当时的 GH_TOKEN 记进 gh.log。
echo "token=${GH_TOKEN:-<none>} $*" >> "$FAKE_GH_LOG"
if [ "$1" = issue ] && [ "$2" = create ]; then
    while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_GH_BODY"; shift; done
    echo "https://github.com/acme/alpha/issues/999"; exit 0
fi
if [ "$1" = api ] && [ "$2" = -X ]; then echo '{}'; exit 0; fi
path="${@: -1}"
repo=$(printf '%s' "$path" | sed -E 's#^repos/([^/]+)/([^/?]+).*#\1_\2#')
case "${FAKE_GH_FAIL:-}" in
    exit)    echo "HTTP 401: Bad credentials" >&2; exit 1 ;;
    empty)   exit 0 ;;
    badjson) echo '[{"number": 1,'; exit 0 ;;
    object)  echo '{"message":"Not Found","documentation_url":"https://docs.github.com"}'; exit 0 ;;
    emptylist) echo '[]'; exit 0 ;;
esac
d="$FAKE_FIX/$repo"
pick() {
    if [ "${FAKE_GH_MIX:-}" = 1 ]; then jq -s 'add' "$FAKE_FIX"/*/"$1"; else cat "$d/$1"; fi
}
case "$path" in
    *"/issues/comments"*) pick comments.json ;;
    *"/pulls?"*)          pick pulls.json ;;
    *"/issues?"*)         pick issues.json ;;
    *) echo "[]" ;;
esac
SH
cat > "$TMP/bin/node" <<'SH'
#!/usr/bin/env bash
# 假 node：shot.mjs <项目目录> <in.html> <out.png> → 出一个占位 png
[ -f "$3" ] && printf 'png' > "$4"
SH
cat > "$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '200'
SH
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"
export FAKE_FIX="$FIX" FAKE_GH_LOG="$TMP/gh.log" FAKE_GH_BODY="$TMP/body.md"

# ── 夹具 ──
# 机器记录。$1 wt $2 起 HH:MM $3 止 HH:MM $4 wall_secs $5 out $6 cost_usd [$7 cache_r]
marker() {
    printf '干完了。\n\n<!-- agent-metrics agent=claude wt=%s start=%sT%s:00+08:00 end=%sT%s:00+08:00 wall_secs=%s in=0 out=%s cache_r=%s cache_w=0 cost_usd=%s cost_state=full cost_unknown_tokens=0 -->' \
        "$1" "$W" "$2" "$W" "$3" "$4" "$5" "${7:-0}" "$6"
}
# 评论数组：每个参数 "<编号>|<北京时间 HH:MM>|<正文>"
comments() {   # $1 owner/name，其余见上
    local repo="$1" n=0 rows=() num hh body; shift
    for a in "$@"; do
        n=$((n+1)); num="${a%%|*}"; a="${a#*|}"; hh="${a%%|*}"; body="${a#*|}"
        rows+=("$(jq -n --arg u "https://api.github.com/repos/$repo/issues/$num" --arg b "$body" \
            --arg t "$(date -u -d "$W $hh +0800" +%Y-%m-%dT%H:%M:%SZ)" --argjson id "$((n + ${#repo}*100))" \
            '{id:$id, issue_url:$u, user:{login:"acme-bot"}, created_at:$t, body:$b}')")
    done
    printf '%s\n' "${rows[@]}" | jq -s .
}
# claude 日志：$1 worktree 路径 $2 会话名，其余每行一条 jq 生成好的记录
logrec() { mkdir -p "$CLAUDE_PROJECTS_DIR/$(printf '%s' "$1" | tr / -)"; cat >> "$CLAUDE_PROJECTS_DIR/$(printf '%s' "$1" | tr / -)/$2.jsonl"; }
utc() { date -u -d "$W $1 +0800" +%Y-%m-%dT%H:%M:%S.000Z; }
call_line() {   # $1 HH:MM $2 out $3 reqid $4 promptId
    jq -nc --arg t "$(utc "$1")" --arg r "$3" --arg p "$4" --argjson o "$2" \
        '{type:"assistant",timestamp:$t,requestId:$r,promptId:$p,message:{model:"claude-opus-5",usage:{input_tokens:0,output_tokens:$o,cache_read_input_tokens:0,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:0}}}}'
}
user_line() { jq -nc --arg t "$(utc "$1")" --arg p "$2" '{type:"user",timestamp:$t,promptId:$p,message:{content:"go"}}'; }
end_line()  { jq -nc --arg t "$(utc "$1")" --arg p "$2" '{type:"assistant",timestamp:$t,promptId:$p,message:{model:"claude-opus-5",stop_reason:"end_turn"}}'; }

mkproject() {   # $1 项目名 $2 owner/name $3 新增行数 $4 worktree 基础目录
    local p="$1" repo="$2" root="$TMP/src/$1"
    git init -q --bare "$TMP/origin/$p.git"
    git init -q "$root"
    git -C "$root" remote add origin "$TMP/origin/$p.git"
    seq 1 "$3" > "$root/f.txt"; git -C "$root" add f.txt
    GIT_AUTHOR_DATE="${W}T12:00:00+08:00" GIT_COMMITTER_DATE="${W}T12:00:00+08:00" \
        git -C "$root" commit -qm init
    git -C "$root" push -q origin main
    printf 'WORKTREE_BASE=%s\nSESSION_NAME_PREFIX=issue\n' "$4" > "$root/cavil-loop.config"
    cat > "$HOME/.config/cavil-loop/$p.conf" <<EOF
PROJECT_ROOT=$root
WEEKLY_REPORT_REPO=$repo
WEEKLY_REPORT_ASSET_URL=https://example.invalid/wr
WEEKLY_REPORT_ASSET_DIR=$TMP/assets
GH_TOKEN=token-$p
EOF
}

build_fixtures() {   # 每组场景前重建，场景只改它要改的那一处
    rm -rf "$TMP/src" "$TMP/origin" "$FIX" "$CLAUDE_PROJECTS_DIR" "$XDG_CACHE_HOME" "$HOME/.config/cavil-loop"
    mkdir -p "$TMP/origin" "$FIX/acme_alpha" "$FIX/acme_beta" "$HOME/.config/cavil-loop"
    mkproject alpha acme/alpha 10 "$TMP/wt-alpha"
    mkproject beta  acme/beta   5 "$TMP/wt-beta"
    echo 'WEEKLY_REPORT_EXTRA_PROJECTS="beta"' >> "$HOME/.config/cavil-loop/alpha.conf"
    cat > "$FIX/acme_alpha/issues.json" <<'JSON'
[ {"number":42,"title":"alpha 的 42","state":"open","labels":[],"created_at":"2025-01-06T01:00:00Z","closed_at":null} ]
JSON
    cat > "$FIX/acme_beta/issues.json" <<'JSON'
[ {"number":42,"title":"beta 的 42","state":"closed","labels":[],"created_at":"2025-01-06T01:00:00Z","closed_at":"2025-01-08T01:00:00Z"},
  {"number":44,"title":"beta 的 44","state":"open","labels":[],"created_at":"2025-01-06T01:00:00Z","closed_at":null},
  {"number":45,"title":"beta 的 45","state":"open","labels":[],"created_at":"2025-01-06T01:00:00Z","closed_at":null},
  {"number":50,"title":"beta 修 42","state":"closed","labels":[],"created_at":"2025-01-07T01:00:00Z","closed_at":"2025-01-08T01:00:00Z",
   "pull_request":{"merged_at":"2025-01-08T01:00:00Z"}} ]
JSON
    echo '[]' > "$FIX/acme_alpha/pulls.json"
    echo '[{"number":50,"title":"beta 修 42","body":"Closes #42"}]' > "$FIX/acme_beta/pulls.json"
    comments acme/alpha "42|11:00|$(marker 42 10:00 11:00 3600 1000000 40.00)" > "$FIX/acme_alpha/comments.json"
    comments acme/beta "42|11:10|$(marker 42 10:10 11:10 3600 500000 7.00 300000)" \
                       "44|12:10|$(marker 44 12:00 12:10 600 0 1.00)" \
                       "45|13:10|$(marker 45 13:00 13:10 600 0 1.00)" > "$FIX/acme_beta/comments.json"
    { user_line 10:15 pA; call_line 10:20 1000000 rA pA; end_line 10:25 pA; } | logrec "$TMP/wt-alpha/issue-42" sa
    { user_line 10:30 pB; call_line 10:30 100000 rB pB; end_line 10:50 pB; } | logrec "$TMP/wt-beta/issue-42" sb
    rm -f "$TMP/gh.log" "$TMP/body.md"; rm -rf "$TMP/assets"
}

# 跑真实入口。$1 被测根目录  其余传给 run.sh
RUNSH_ERR="$TMP/run.err"
runsh() {
    local root="$1"; shift
    ( cd "$TMP" && bash "$root/scripts/weekly-report/run.sh" "$@" --week-of "$W" ) >"$TMP/run.out" 2>"$RUNSH_ERR"
}
# 跑一遍并留下数据文件（run.sh 不落盘 data.json：dry-run 才落）
runsh_data() {   # $1 根目录 $2 项目
    runsh "$1" "$2" --dry-run && cp "$HOME/weekly-report-dryrun.json" "$TMP/data-$2.json"
}
J() { python3 -c "import json,sys; D=json.load(open(sys.argv[1])); print($2)" "$1" 2>/dev/null || echo "<读不到>"; }
num() { python3 -c "import sys; v=float(sys.argv[1]); print(int(v) if v==int(v) else round(v,4))" "$1" 2>/dev/null || echo "$1"; }

# ════════════════════════════════════════════════════════════════════
# 第 1–5 组的断言放在一个函数里：默认跑一遍本版；负对照 M1 拿「合进同一次认领」的做法再跑一遍
check_merged() {   # $1 data.json  $2 本轮是否真出了报告（yes / no）
    local D="$1" WK="D['weekly']['$W']"
    local BR="{r['repo']:r['week'] for r in D.get('by_repo',[])}"
    echo "── 2. 同号跨仓不串账 ──"
    chk "合并后真的出了报告（这组断言是对一次成功运行下的）" "$2" "yes"
    chk "alpha 10:20 那次调用只归 alpha：alpha 金额 = 自己日志重算的 \$25（不是回退的 \$40）" \
        "$(num "$(J "$D" "$BR['acme/alpha']['cost']")")" "25"
    chk "alpha 计入的金额来源是重算" "$(num "$(J "$D" "$BR['acme/alpha']['src_recomputed']")")" "1"
    chk "beta 回退的一侧用原记录值：\$7 + #44 \$1 + #45 \$1 = \$9" \
        "$(num "$(J "$D" "$BR['acme/beta']['cost']")")" "9"
    chk "token 不串仓：alpha 输出 = 自己日志认领到的 100 万" "$(num "$(J "$D" "$BR['acme/alpha']['tok_out']")")" "1000000"
    chk "token 不串仓：beta 输出 = 原记录的 50 万" "$(num "$(J "$D" "$BR['acme/beta']['tok_out']")")" "500000"
    chk "处理时长不串仓：alpha 600 s / beta 1200 s" \
        "$(num "$(J "$D" "$BR['acme/alpha']['work']")")/$(num "$(J "$D" "$BR['acme/beta']['work']")")" "600/1200"
    chk "合计：金额 \$34、输出 150 万、处理时长 1800 s、算得出处理时长的派工 2 条" \
        "$(num "$(J "$D" "$WK['cost']")")/$(num "$(J "$D" "$WK['tok_out']")")/$(num "$(J "$D" "$WK['work']")")/$(num "$(J "$D" "$WK['work_records']")")" \
        "34/1500000/1800/2"
    chk "「能否相加」各自判定：两个仓库都没有不可相加的派工" \
        "$(num "$(J "$D" "$WK['records_not_summable']")")" "0"
    echo "── 1. 中位数按合并后的原始时长重算 ──"
    # alpha [3600] → 60 分；beta [600,600,3600] → 10 分；拼起来 [600,600,3600,3600] → 60 分。
    # 对两个中位数求平均是 35 分。
    chk "派工总耗时中位数 = 60 分（拼接后重算），不是 35 分（各仓库中位数的平均）" \
        "$(num "$(J "$D" "$WK['sess_med']")")" "60"
}

echo "════ 默认回归 ════"
build_fixtures
echo "── 0. 两个仓库各自单独出一份（作为「各仓库单独采数」的对照）──"
sed -i '/WEEKLY_REPORT_EXTRA_PROJECTS/d' "$HOME/.config/cavil-loop/alpha.conf"
runsh_data "$TMP/new" alpha; chk "alpha 单独出报告成功" "$?" "0"; cp "$TMP/data-alpha.json" "$TMP/single-alpha.json"
runsh "$TMP/new" alpha && cp "$TMP/body.md" "$TMP/body-single.md"
runsh_data "$TMP/new" beta;  chk "beta 单独出报告成功" "$?" "0";  cp "$TMP/data-beta.json" "$TMP/single-beta.json"
echo 'WEEKLY_REPORT_EXTRA_PROJECTS="beta"' >> "$HOME/.config/cavil-loop/alpha.conf"
rm -f "$TMP/gh.log" "$TMP/body.md"

runsh "$TMP/new" alpha; rc=$?
chk "配了附加项目：run.sh 成功" "$rc" "0"
[ "$rc" = 0 ] || sed 's/^/       /' "$RUNSH_ERR"
cp "$TMP/gh.log" "$TMP/gh-merged.log"; cp "$TMP/body.md" "$TMP/body-merged.md" 2>/dev/null
chk "真的开了 issue（走到了最后一步）" "$(grep -c ' issue create ' "$TMP/gh-merged.log")" "1"
runsh_data "$TMP/new" alpha >/dev/null; cp "$TMP/data-alpha.json" "$TMP/data-merged.json"

check_merged "$TMP/data-merged.json" "$([ "$rc" = 0 ] && echo yes || echo no)"

chk "每个相加字段 = 两个仓库各自单独采数之和（逐周逐字段，不含中位数）" \
    "$(python3 - "$TMP/data-merged.json" "$TMP/single-alpha.json" "$TMP/single-beta.json" "$TMP/new/scripts/weekly-report" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[4]); import merge
M, A, B = (json.load(open(f)) for f in sys.argv[1:4])
bad = [f"{w}.{f}" for w in M["weeks"] for f in merge.WEEKLY_SUM
       if abs(M["weekly"][w][f] - A["weekly"][w][f] - B["weekly"][w][f]) > 1e-6]
nz = sum(1 for w in M["weeks"] for f in merge.WEEKLY_SUM if M["weekly"][w][f])
print("ok" if not bad and nz > 10 else f"bad={bad[:5]} nonzero={nz}")
PY
)" "ok"
chk "合并的每周字段正好是采数输出的那些（声明表与采数器一一对应）" \
    "$(python3 - "$TMP/single-alpha.json" "$TMP/new/scripts/weekly-report" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[2]); import merge
A = json.load(open(sys.argv[1])); w = A["weeks"][0]
print("ok" if set(A["weekly"][w]) == set(merge.WEEKLY_SUM) | set(merge.WEEKLY_MEDIAN) else
      sorted(set(A["weekly"][w]) ^ (set(merge.WEEKLY_SUM) | set(merge.WEEKLY_MEDIAN))))
PY
)" "ok"

echo "── 4. 报告：编号带仓库前缀、明细按仓库分组、按仓库拆分表 ──"
B="$TMP/body-merged.md"
has() { grep -qF -- "$1" "$B" && echo yes || echo no; }
chk "主仓库条目照旧写 #42"                 "$(has '| #42 | alpha 的 42 |')" "yes"
chk "其他仓库条目写 acme/beta#42"          "$(has '| acme/beta#42 | beta 的 42 |')" "yes"
chk "其他仓库的 PR 也带前缀"               "$(has 'acme/beta#50（已合并）')" "yes"
chk "明细按仓库分小节"                     "$(has '**acme/beta**（')" "yes"
chk "有按仓库拆分表"                       "$(has '### 按仓库拆分（本周）')" "yes"
chk "按仓库拆分：alpha 一行（净增 10 行、\$25）" \
    "$(grep -F '| acme/alpha |' "$B" | grep -qF '| 10 |' && grep -F '| acme/alpha |' "$B" | grep -qF '$25' && echo yes || echo no)" "yes"
chk "按仓库拆分：合计行 \$34"              "$(grep -F '| **合计** | 4 | 1 | 1 |' "$B" | grep -qF '$34' && echo yes || echo no)" "yes"
chk "按模型拆分表多一列「仓库」"           "$(has '| 仓库 | 模型 | 用在哪一侧 |')" "yes"
chk "口径说明写明合并了哪几个仓库"         "$(has '合并了 2 个仓库**：acme/alpha、acme/beta')" "yes"
chk "PDF 页序不变：分页标记个数与单仓库报告相同" \
    "$(grep -c 'break-before: page' "$B")" "$(grep -c 'break-before: page' "$TMP/body-single.md")"

echo "── 凭据与配置各用各的 ──"
chk "读 acme/alpha 的调用用 alpha 的凭据" \
    "$(grep 'repos/acme/alpha/' "$TMP/gh-merged.log" | grep -vc '^token=token-alpha ')" "0"
chk "读 acme/beta 的调用用 beta 的凭据（主项目的凭据没漏过去）" \
    "$(grep 'repos/acme/beta/' "$TMP/gh-merged.log" | grep -vc '^token=token-beta ')" "0"
chk "两个仓库确实都读了（上两条不是因为一条没读）" \
    "$(grep -c 'repos/acme/alpha/issues/comments' "$TMP/gh-merged.log")/$(grep -c 'repos/acme/beta/issues/comments' "$TMP/gh-merged.log")" "1/1"

echo "── 口径切换周按仓库各留一份 ──"
build_fixtures
echo "WEEKLY_REPORT_SWITCH_WEEK=2024-12-18" >> "$HOME/.config/cavil-loop/alpha.conf"
runsh_data "$TMP/new" alpha >/dev/null; rc=$?
chk "主项目配了切换周、beta 没配：各自一份（主项目的设置没漏进 beta）" \
    "$rc/$(J "$TMP/data-alpha.json" "D['switch_weeks']")" "0/{'acme/alpha': '2024-12-16', 'acme/beta': None}"
chk "报告里那一周打 †" "$(grep -c '12/16–12/22 †' "$HOME/weekly-report-dryrun.md")" "4"
chk "† 的说明写明是哪个仓库（投入 / 成本 / token 三张表下各一句，与单仓库相同）" "$(grep -c 'acme/alpha 从 12/16 那周起' "$HOME/weekly-report-dryrun.md")" "3"
python3 - "$TMP/data-alpha.json" <<'PY'
import json, sys
D = json.load(open(sys.argv[1])); D["switch_weeks"]["acme/beta"] = "2024-12-30"
json.dump(D, open(sys.argv[1], "w"))
PY
python3 "$TMP/new/scripts/weekly-report/render.py" --data "$TMP/data-alpha.json" --out-dir "$TMP/html" \
    --asset-url-base x --rev y >/dev/null 2>&1
chk "两个仓库切换周不同：成本图上各画一条竖线、写明是哪个仓库" \
    "$(grep -o '口径切换（[a-z、]*）' "$TMP/html/cost.html" | sort | tr '\n' ' ')" "口径切换（alpha） 口径切换（beta） "

echo "── 3. 同仓重叠去重不变：现有测试原样通过（见 tests/weekly-report-*.test.sh），这里不重复 ──"

echo "── 4b. 合并器遇到没声明的字段报错 ──"
MERGE="$TMP/new/scripts/weekly-report/merge.py"
strict_part() {   # $1 项目 $2 输出：用真实 collect.py --strict 出一份
    ( cd "$TMP/src/$1" && GH_TOKEN=x python3 "$TMP/new/scripts/weekly-report/collect.py" --strict \
        --repo "acme/$1" --out "$2" --week-of "$W" --worktree-base "$TMP/wt-$1" --session-prefix issue ) >/dev/null 2>&1
}
strict_part alpha "$TMP/pa.json"; strict_part beta "$TMP/pb.json"
python3 "$MERGE" --out "$TMP/m-ok.json" --primary "$TMP/pa.json" "$TMP/pb.json" >/dev/null 2>"$TMP/m.err"
chk "两份严格采数的结果能合并（下面几条报错不是因为合并本身坏了）" "$?" "0"
jq '.weekly |= with_entries(.value.brand_new_metric = 1)' "$TMP/pb.json" > "$TMP/pb-weekly.json"
python3 "$MERGE" --out "$TMP/m1.json" --primary "$TMP/pa.json" "$TMP/pb-weekly.json" >/dev/null 2>"$TMP/m.err"; rc=$?
chk "每周格子里多一个没声明的字段 → 报错退出" "$rc/$(grep -c 'brand_new_metric' "$TMP/m.err")/$([ -e "$TMP/m1.json" ] && echo 写了 || echo 没写)" "1/1/没写"
jq '.brand_new_list = []' "$TMP/pb.json" > "$TMP/pb-top.json"
python3 "$MERGE" --out "$TMP/m2.json" --primary "$TMP/pa.json" "$TMP/pb-top.json" >/dev/null 2>"$TMP/m.err"; rc=$?
chk "顶层多一个没声明的字段 → 报错退出" "$rc/$(grep -c 'brand_new_list' "$TMP/m.err")" "1/1"

echo "── 7. 合并器只收严格采数的结果；worktree 目录规则相同报错 ──"
( cd "$TMP/src/beta" && GH_TOKEN=x python3 "$TMP/new/scripts/weekly-report/collect.py" \
    --repo acme/beta --out "$TMP/pb-loose.json" --week-of "$W" ) >/dev/null 2>&1
chk "不带 --strict 的采数结果没有严格采数标记" "$(J "$TMP/pb-loose.json" "D.get('strict')")" "None"
python3 "$MERGE" --out "$TMP/m3.json" --primary "$TMP/pa.json" "$TMP/pb-loose.json" >/dev/null 2>"$TMP/m.err"; rc=$?
chk "合并器拒收不带严格采数标记的文件" "$rc/$(grep -c '严格采数标记' "$TMP/m.err")" "1/1"
build_fixtures
sed -i "s#^WORKTREE_BASE=.*#WORKTREE_BASE=$TMP/wt-alpha#" "$TMP/src/beta/cavil-loop.config"
runsh "$TMP/new" alpha; rc=$?
chk "两个项目 worktree 目录规则相同 → 报错、不开 issue" \
    "$([ "$rc" != 0 ] && echo 失败)/$(grep -c 'worktree 目录规则相同' "$RUNSH_ERR")/$(cat "$TMP/gh.log" 2>/dev/null | grep -c ' issue create ')" "失败/1/0"
build_fixtures
printf 'WEEKLY_REPORT_EXTRA_PROJECTS="beta gamma"\n' >> "$HOME/.config/cavil-loop/alpha.conf"
runsh "$TMP/new" alpha; rc=$?
chk "附加项目名字找不到配置 → 报错并点名" "$([ "$rc" != 0 ] && echo 失败)/$(grep -c 'gamma' "$RUNSH_ERR")" "失败/1"

echo "── 6. 读不到 ≠ 没有：附加仓库读失败，整份不发 ──"
for mode in exit empty badjson object; do
    build_fixtures
    echo "FAKE_GH_FAIL=$mode" >> "$HOME/.config/cavil-loop/beta.conf"
    runsh "$TMP/new" alpha; rc=$?
    chk "beta 读取注入 [$mode]：非零退出 / 点名 beta / 不开 issue / alpha 确实读过" \
        "$([ "$rc" != 0 ] && echo 失败)/$(grep -c '项目 beta（acme/beta）：采数失败' "$RUNSH_ERR")/$(grep -c ' issue create ' "$TMP/gh.log")/$(grep -c 'repos/acme/alpha/issues/comments' "$TMP/gh.log")" \
        "失败/1/0/1"
done
build_fixtures
git -C "$TMP/src/beta" remote set-url origin "$TMP/origin/does-not-exist.git"
runsh "$TMP/new" alpha; rc=$?
chk "beta 取不到主干：非零退出 / 点名 beta / 不开 issue" \
    "$([ "$rc" != 0 ] && echo 失败)/$(grep -c '项目 beta（acme/beta）：取最新主干失败' "$RUNSH_ERR")/$(grep -c ' issue create ' "$TMP/gh.log")" "失败/1/0"
mkdir -p "$TMP/nomain"; git init -q "$TMP/nomain"
( cd "$TMP/nomain" && FAKE_GH_FAIL=emptylist python3 "$TMP/new/scripts/weekly-report/collect.py" --strict \
    --repo acme/beta --out "$TMP/nomain.json" --week-of "$W" ) >/dev/null 2>"$TMP/c.err"; rc=$?
chk "严格采数：读提交与增删行时主干不存在 → 退出 3、不写数据文件" \
    "$rc/$(grep -c 'git log origin/main 失败' "$TMP/c.err")/$([ -e "$TMP/nomain.json" ] && echo 写了 || echo 没写)" "3/1/没写"
( cd "$TMP/nomain" && FAKE_GH_FAIL=emptylist python3 "$TMP/new/scripts/weekly-report/collect.py" \
    --repo acme/beta --out "$TMP/nomain2.json" --week-of "$W" ) >/dev/null 2>&1; rc=$?
chk "同样情形不加 --strict：照旧成功（单项目旧行为）" "$rc" "0"

build_fixtures
echo "FAKE_GH_FAIL=emptylist" >> "$HOME/.config/cavil-loop/beta.conf"
runsh "$TMP/new" alpha; rc=$?
chk "beta 接口全部返回 []（真的没有）→ 成功出报告" "$rc/$(grep -c ' issue create ' "$TMP/gh.log")" "0/1"
chk "那一份报告里 beta 一行全是 0" \
    "$(grep -F '| acme/beta |' "$TMP/body.md" | grep -qF '| acme/beta | 0 | 0 | 0 |' && echo yes || echo no)" "yes"

echo "── 5. 不配附加项目：与合并基线逐字节一致（含单项目读失败的旧行为）──"
norm() { sed -E 's/wk-[0-9]{8}-[0-9]+/wk-REV/g; s/(数据生成时间\*\*：)[0-9: -]+/\1T/' "$1"; }
if ! compat_skip "不配附加项目：开出的 issue 正文与改动前" "$TMP/old" "$TMP/new" scripts/weekly-report scripts/_names.sh; then
    for variant in normal fail; do
        for side in old new; do
            build_fixtures
            sed -i '/WEEKLY_REPORT_EXTRA_PROJECTS/d' "$HOME/.config/cavil-loop/alpha.conf"
            [ "$variant" = fail ] && echo "FAKE_GH_FAIL=exit" >> "$HOME/.config/cavil-loop/alpha.conf"
            runsh "$TMP/$side" alpha; echo "rc=$?" > "$TMP/cmp-$side.txt"
            norm "$TMP/body.md" >> "$TMP/cmp-$side.txt"
            sed -E 's/--body-file [^ ]*/--body-file B/' "$TMP/gh.log" >> "$TMP/cmp-$side.txt"
        done
        chk "[$variant] 开出的 issue 正文、退出码、GitHub 调用与改动前一致" \
            "$(cmp -s "$TMP/cmp-old.txt" "$TMP/cmp-new.txt" && echo same || { diff "$TMP/cmp-old.txt" "$TMP/cmp-new.txt" | head -5; })" "same"
        chk "[$variant] 对拍的这次确实走到了开 issue（rc=0 且有正文）" \
            "$(head -1 "$TMP/cmp-new.txt")/$([ -s "$TMP/body.md" ] && echo 有正文)" "rc=0/有正文"
    done
    build_fixtures
    sed -i '/WEEKLY_REPORT_EXTRA_PROJECTS/d' "$HOME/.config/cavil-loop/alpha.conf"
    for side in old new; do
        runsh_data "$TMP/$side" alpha >/dev/null
        python3 -c "import json,sys; D=json.load(open(sys.argv[1])); D['generated_at']='T'; print(json.dumps(D,ensure_ascii=False,indent=1))" \
            "$TMP/data-alpha.json" > "$TMP/dj-$side.json"
    done
    chk "数据文件（除生成时间外）与改动前逐字节一致" "$(cmp -s "$TMP/dj-old.json" "$TMP/dj-new.json" && echo same || echo diff)" "same"
fi

# ════════════════════════════════════════════════════════════════════
echo "════ 负对照 ════"
mut_ran=0; mut_fail=0
mut() {   # $1 名字  $2 1 = 断言变红（负对照通过）/ 0 = 仍然全绿
    mut_ran=$((mut_ran+1))
    if [ "$2" = 1 ]; then echo "  ✅ 负对照 [$1]：断言变红"
    else echo "  ❌ 负对照 [$1]：断言仍然全绿，测试分不出这个错"; mut_fail=$((mut_fail+1)); fi
}
mutcopy() { rm -rf "$1"; mkdir -p "$1"; cp -r "$TMP/new/scripts" "$1/"; }
apply() {     # $1 文件 $2 原文 $3 改成：原文不在就算准备失败（这一项记红）
    if python3 -c '
import sys
p, old, new = sys.argv[1:]
s = open(p).read()
if s.count(old) != 1: sys.exit(1)
open(p, "w").write(s.replace(old, new))' "$1" "$2" "$3"; then return 0; fi
    echo "  ❌ 负对照准备失败：$1 里找不到要改的原文"; return 1
}
# 跑一组断言、把输出留下，不计入回归计数
quiet_check() {   # $1 输出文件  其余：命令
    local f="$1" p0=$pass f0=$fail; shift
    "$@" >"$f" 2>&1; pass=$p0; fail=$f0
}
red() { grep -F "❌ $2" "$1" >/dev/null; }

if mutation_gate; then
    # M1：把两个仓库的窗口和日志合进同一次认领（一次采数、一个日志目录）——
    # 也就是「不分仓库采数、直接把数据塞进同一条采数链」的做法
    mixed() {
        build_fixtures
        sed -i '/WEEKLY_REPORT_EXTRA_PROJECTS/d' "$HOME/.config/cavil-loop/alpha.conf"
        logrec "$TMP/wt-alpha/issue-42" sb < "$CLAUDE_PROJECTS_DIR/$(printf '%s' "$TMP/wt-beta/issue-42" | tr / -)/sb.jsonl"
        local ok=no; FAKE_GH_MIX=1 runsh_data "$TMP/new" alpha && ok=yes
        check_merged "$TMP/data-alpha.json" "$ok"
    }
    quiet_check "$TMP/m1.out" mixed
    r=1
    for k in '合并后真的出了报告' 'alpha 10:20 那次调用只归 alpha' '处理时长不串仓' '「能否相加」各自判定' '合计：金额'; do
        if [ "$k" = '合并后真的出了报告' ]; then
            red "$TMP/m1.out" "$k" && { echo "     M1 没跑成，不能算变红"; r=0; }
        else
            red "$TMP/m1.out" "$k" || { echo "     M1 下仍为绿：$k"; r=0; }
        fi
    done
    mut "M1 合进同一次认领 → 调用归属 / 处理时长 / 能否相加 / 合计各自变红" "$r"
fi
if mutation_gate; then
    # M2：中位数改成各仓库中位数的平均（自检一起改，否则自检先拦下）
    M2="$TMP/m2"; mutcopy "$M2"; r=0
    if apply "$M2/scripts/weekly-report/merge.py" '        cell["sess_med"] = median_min(ds)' \
           '        cell["sess_med"] = sum(D["weekly"][w]["sess_med"] for _, D in parts) / len(parts)' \
       && apply "$M2/scripts/weekly-report/merge.py" '        want = median_min(ds)' \
           '        want = sum(D["weekly"][w]["sess_med"] for _, D in parts) / len(parts)'; then
        build_fixtures; ok=no; runsh_data "$M2" alpha >/dev/null && ok=yes
        quiet_check "$TMP/m2.out" check_merged "$TMP/data-alpha.json" "$ok"
        red "$TMP/m2.out" '派工总耗时中位数' && ! red "$TMP/m2.out" '合并后真的出了报告' && r=1
    fi
    mut "M2 中位数求平均" "$r"
fi
if mutation_gate; then
    # M3：去掉「没声明的字段报错」
    M3="$TMP/m3"; mutcopy "$M3"; r=0
    if apply "$M3/scripts/weekly-report/merge.py" '            if f not in declared:
                raise' '            if False:
                raise'; then
        python3 "$M3/scripts/weekly-report/merge.py" --out "$TMP/m3.json" --primary "$TMP/pa.json" "$TMP/pb-weekly.json" >/dev/null 2>&1
        [ $? = 1 ] || r=1
    fi
    mut "M3 去掉未声明字段报错" "$r"
fi
if mutation_gate; then
    # M4：严格模式下接口失败仍当空列表
    M4="$TMP/m4"; mutcopy "$M4"; r=0
    if apply "$M4/scripts/weekly-report/collect.py" '    if STRICT:
        # 只有' '    if False:
        # 只有'; then
        r=1
        for mode in exit badjson; do
            build_fixtures; echo "FAKE_GH_FAIL=$mode" >> "$HOME/.config/cavil-loop/beta.conf"
            runsh "$M4" alpha; rc=$?
            if [ "$rc" != 0 ] && [ "$(grep -c ' issue create ' "$TMP/gh.log")" = 0 ]; then
                echo "     M4 [$mode] 仍被拦下"; r=0
            fi
        done
    fi
    mut "M4 严格模式吞掉接口失败（exit / badjson 两种注入都要漏过去）" "$r"
fi
if mutation_gate; then
    # M5：合并器去掉严格采数标记检查
    M5="$TMP/m5"; mutcopy "$M5"; r=0
    if apply "$M5/scripts/weekly-report/merge.py" '    if D.get("strict") is not True:' '    if False:'; then
        python3 "$M5/scripts/weekly-report/merge.py" --out "$TMP/m5.json" --primary "$TMP/pa.json" "$TMP/pb-loose.json" >/dev/null 2>"$TMP/m.err"
        rc=$?
        # 与回归断言同一判据：退出 1 且点名「严格采数标记」（缺别的字段也会退出 1，不算拦住）
        [ "$rc" = 1 ] && grep -q '严格采数标记' "$TMP/m.err" || r=1
    fi
    mut "M5 去掉严格采数标记检查" "$r"
fi

echo
mutation_summary
compat_summary
echo "通过 $pass / 失败 $fail"
if mutation_on; then REPORT_REGRESS_ONLY=1 report_counts "$pass" "$fail" "$mut_ran" "$mut_fail"
else report_counts "$pass" "$fail"; fi
[ "$fail" -eq 0 ] && [ "$mut_fail" -eq 0 ]
