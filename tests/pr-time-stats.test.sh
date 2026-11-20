#!/usr/bin/env bash
# kind: unit
# 每个 PR 的 AI 与测试耗时估算（GitHub#593，维护者选定口径 B）：scripts/pr-time-stats.py。
#
# 跑法：bash tests/pr-time-stats.test.sh   （约 2 秒）
# 依赖：python3、bash。不碰网络：PATH 最前面放一个假 gh，按请求路径返回夹具文件；HOME 指向临时目录，
# 测试流水用 --runs-log 指到夹具。跑的是真实脚本入口，断言读它的 --json 输出和退出码。
#
# 覆盖：
#   【1】AI / 单跑 = 各轮 footer 相加；同一派工两条评论只算一次（取最后那条）；派工重叠、测试不确定标记只标注
#   【2】整套测试按参数分类：快速 / 按种类 / 冒烟 / 相关改动 / 全部；--list 不算；只有开始的标「未记到结束」；
#        别的工作树、窗口外的不算
#   【3】CI：重跑的每次尝试都算，挑选方式按汇总日志；fork 运行按分支认；归不到唯一 PR 的单列
#   【4】没有 footer → AI「无记录」不进平均、CI 照算；footer 缺 ai_secs → AI 未知、不当 0
#   【5】两个 PR 共用工作编号：issue 评论按合并时刻切开，各算各的，标「共用工作树」
#   【6】创建早于窗口的 PR 不算；非机器人账号的机器记录不算、计数
#   【7】平均数 / 中位数 / 分母
#   【8】读 GitHub 失败、流水读不了 → 退出码 2，不出报告
#   【9】工作编号与 _lib.sh 的 pr_to_issue_num 同一批输入对拍
#   【10】跑完的 CI 尝试的起止和挑选方式存本机缓存：重跑不再请求；读失败的不存；报告写明请求数
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
SB=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SB" || rm -rf "$SB"' EXIT
mkdir -p "$SB/bin" "$SB/home" "$SB/gh"
export HOME="$SB/home" TZ=UTC
unset GH_TOKEN GITHUB_TOKEN WEEKLY_REPORT_BOT_LOGINS CODING_AGENT_RELEASE_ROOT

pass=0; fail=0
tally() {   # 读断言输出：OK <名字> / FAIL <名字> <说明>
    local line
    while IFS= read -r line; do
        case "$line" in
            OK\ *) echo "  ✅ ${line#OK }"; pass=$((pass+1)) ;;
            FAIL\ *) echo "  ❌ ${line#FAIL }"; fail=$((fail+1)) ;;
            *) echo "  $line" ;;
        esac
    done
}

# 假 gh：`gh api <路径>` → $FAKE_GH_DIR/<路径的 sha1>；没有这个文件 = 404。$FAKE_GH_FAIL 里写的路径一律失败。
cat > "$SB/bin/gh" <<'EOF'
#!/usr/bin/env python3
import hashlib, os, sys
a = sys.argv[1:]
is_log = a[-1:] and a[-1].endswith("/logs")
# 真 gh 读到带终端转义字符的日志时，不带 --allow-escape-sequences 就报错退出：照样学
if is_log and "--allow-escape-sequences" not in a:
    sys.stderr.write("the response contains terminal escape sequences\n"); sys.exit(1)
a = [x for x in a if x != "--allow-escape-sequences"]
if len(a) != 2 or a[0] != "api":
    sys.stderr.write("fake gh: unsupported %r\n" % a); sys.exit(3)
d = os.environ["FAKE_GH_DIR"]
with open(os.path.join(d, "calls.log"), "a") as f:
    f.write(a[1] + "\n")
if a[1] in os.environ.get("FAKE_GH_FAIL", "").split("\n"):
    sys.stderr.write("HTTP 502\n"); sys.exit(1)
p = os.path.join(d, hashlib.sha1(a[1].encode()).hexdigest())
if not os.path.exists(p):
    sys.stderr.write("HTTP 404: Not Found (%s)\n" % a[1]); sys.exit(1)
sys.stdout.write(open(p, encoding="utf-8").read())
EOF
chmod +x "$SB/bin/gh"
export PATH="$SB/bin:$PATH" FAKE_GH_DIR="$SB/gh"

# ── 夹具 ────────────────────────────────────────────────────────────────────
python3 - "$SB" <<'PY'
import hashlib, json, os, sys
sb = sys.argv[1]; d = os.path.join(sb, "gh"); R = "o/r"; WT = os.path.join(sb, "wt")
def put(path, obj):
    open(os.path.join(d, hashlib.sha1(path.encode()).hexdigest()), "w", encoding="utf-8").write(
        obj if isinstance(obj, str) else json.dumps(obj))
def pr(n, ref, body, created, merged, repo=R):
    return {"number": n, "body": body, "created_at": created, "merged_at": merged, "updated_at": merged,
            "head": {"ref": ref, "repo": {"full_name": repo}}}
BOT = "loop-bot-pusher"
def footer(start, end, wt, **kv):
    kv.setdefault("agent", "claude")
    f = " ".join(f"{k}={v}" for k, v in kv.items())
    return f"正文\n\n<!-- agent-metrics wt={wt} start={start} end={end} {f} -->"
def com(i, body, created, login=BOT):
    return {"id": i, "body": body, "created_at": created, "user": {"login": login}}
OKT = dict(suite_read="ok", adhoc_read="ok", cmd_unparsed=0, adhoc_untimed=0,
           suite_unlinked=0, suite_unlogged=0, suite_unfinished=0)
prs = [
    pr(10, "feature/issue-5", "改动说明\nRefs #5", "2026-11-10T00:00:00Z", "2026-11-12T00:00:00Z"),
    pr(11, "docs-fix", "只改文档", "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z", repo="someone/fork"),
    pr(12, "feature/issue-7", "Closes #7", "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z"),
    pr(13, "feature/issue-7", "Refs #7", "2026-11-11T06:00:00Z", "2026-11-13T00:00:00Z"),
    pr(14, "feature/issue-8", "Refs #8", "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z"),
    pr(15, "feature/issue-9", "Refs #9", "2026-11-01T00:00:00Z", "2026-11-11T00:00:00Z"),
    # 没合并的、窗口外合并的：不算
    {**pr(16, "feature/issue-16", "", "2026-11-10T00:00:00Z", None), "updated_at": "2026-11-12T00:00:00Z"},
    pr(17, "feature/issue-17", "", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
]
put(f"repos/{R}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1", prs)
# issue 5：两轮派工（同一 agent，时间窗重叠），第一轮发了两条评论（同一派工身份，取 end 晚的那条）
put(f"repos/{R}/issues/5/comments?per_page=100&page=1", [
    com(1, footer("2026-11-10T09:00:00+08:00", "2026-11-10T09:05:00+08:00", 5, ai_secs=40, adhoc_secs=5, **OKT), "2026-11-10T01:05:00Z"),
    com(2, footer("2026-11-10T09:00:00+08:00", "2026-11-10T09:10:00+08:00", 5, ai_secs=100, adhoc_secs=20, **OKT), "2026-11-10T01:10:00Z"),
    com(3, footer("2026-11-10T09:08:00+08:00", "2026-11-10T09:20:00+08:00", 5, ai_secs=50, adhoc_secs=0, **OKT), "2026-11-10T01:20:00Z"),
    com(4, "人说的话", "2026-11-10T02:00:00Z", login="maintainer"),
    com(5, footer("2026-11-10T09:30:00+08:00", "2026-11-10T09:40:00+08:00", 5, ai_secs=999, adhoc_secs=999, **OKT), "2026-11-10T02:10:00Z", login="maintainer"),
])
put(f"repos/{R}/issues/10/comments?per_page=100&page=1", [
    com(6, footer("2026-11-11T09:00:00+08:00", "2026-11-11T09:10:00+08:00", 5, agent="codex", ai_secs=30, adhoc_secs=10,
                  **{**OKT, "cmd_unparsed": 2}), "2026-11-11T01:10:00Z"),
])
put(f"repos/{R}/issues/11/comments?per_page=100&page=1", [com(7, "没有用量记录", "2026-11-10T03:00:00Z")])
# issue 7 被两个 PR 共用：#12 合并（11-11 00:00）之前的评论归 #12，之后的归 #13
put(f"repos/{R}/issues/7/comments?per_page=100&page=1", [
    com(8, footer("2026-11-10T08:00:00+08:00", "2026-11-10T08:10:00+08:00", 7, ai_secs=60, adhoc_secs=0, **OKT), "2026-11-10T00:10:00Z"),
    com(9, footer("2026-11-12T08:00:00+08:00", "2026-11-12T08:10:00+08:00", 7, ai_secs=70, adhoc_secs=0, **OKT), "2026-11-12T00:10:00Z"),
])
put(f"repos/{R}/issues/12/comments?per_page=100&page=1", [])
put(f"repos/{R}/issues/13/comments?per_page=100&page=1", [])
# issue 8：一条机器记录缺 ai_secs
put(f"repos/{R}/issues/8/comments?per_page=100&page=1", [
    com(10, footer("2026-11-10T08:00:00+08:00", "2026-11-10T08:10:00+08:00", 8, adhoc_secs=0, **OKT), "2026-11-10T00:10:00Z"),
    com(11, footer("2026-11-10T09:00:00+08:00", "2026-11-10T09:10:00+08:00", 8, ai_secs=20, adhoc_secs=0, **OKT), "2026-11-10T01:10:00Z"),
])
put(f"repos/{R}/issues/14/comments?per_page=100&page=1", [])
# issue 9：派工早于窗口
put(f"repos/{R}/issues/9/comments?per_page=100&page=1", [
    com(12, footer("2026-11-01T08:00:00+08:00", "2026-11-01T08:10:00+08:00", 9, ai_secs=60, adhoc_secs=0, **OKT), "2026-11-01T00:10:00Z")])
put(f"repos/{R}/issues/15/comments?per_page=100&page=1", [])

# CI
def run(i, prs_, attempt, started, updated, branch, repo=R, concl="success", created=None):
    return {"id": i, "pull_requests": [{"number": n} for n in prs_], "run_attempt": attempt,
            "run_started_at": started, "updated_at": updated, "created_at": created or started,
            "head_branch": branch, "head_repository": {"full_name": repo}, "conclusion": concl, "status": "completed"}
tests_runs = [
    run(100, [10], 2, "2026-11-11T02:00:00Z", "2026-11-11T02:10:00Z", "feature/issue-5"),     # 第 2 次尝试 600 s
    run(101, [], 1, "2026-11-10T05:00:00Z", "2026-11-10T05:03:00Z", "docs-fix", repo="someone/fork"),  # fork：按分支认 #11
    run(102, [12, 13], 1, "2026-11-11T03:00:00Z", "2026-11-11T03:05:00Z", "feature/issue-7"),  # 归不到唯一 PR
    run(103, [99], 1, "2026-11-11T03:00:00Z", "2026-11-11T03:05:00Z", "x"),                    # 窗口外的 PR：不算
    run(104, [], 1, "2026-11-11T03:00:00Z", "2026-11-11T03:05:00Z", "unmerged-branch", repo="x/fork"),  # fork、对不上窗口内任何 PR：不算、也不算「归不到」
]
put(f"repos/{R}/actions/workflows/tests.yml/runs?created=%3E%3D2026-10-08&event=pull_request&per_page=100&page=1",
    {"total_count": len(tests_runs), "workflow_runs": tests_runs})
put(f"repos/{R}/actions/runs/100/attempts/1", {"run_started_at": "2026-11-11T01:00:00Z", "updated_at": "2026-11-11T01:05:00Z", "conclusion": "failure"})
put(f"repos/{R}/actions/runs/100/attempts/1/jobs?per_page=100", {"jobs": [{"id": 501, "name": "测试"}]})
put(f"repos/{R}/actions/runs/100/attempts/2/jobs?per_page=100", {"jobs": [{"id": 502, "name": "测试"}]})
put(f"repos/{R}/actions/runs/101/attempts/1/jobs?per_page=100", {"jobs": [{"id": 601, "name": "shard 1/8"}]})   # 没有汇总那一步：挑选方式未知
put(f"repos/{R}/actions/jobs/501/logs", "...\nSelection: **only what this change can reach** — docs only\n")
put(f"repos/{R}/actions/jobs/502/logs", "\x1b[36;1m...\x1b[0m\n2026-11-11T02:09:00Z Selection: full run — scripts changed\n")
client_runs = [run(200, [10], 1, "2026-11-11T02:00:00Z", "2026-11-11T02:04:00Z", "feature/issue-5")]   # 与 Tests 重叠 4 分钟
put(f"repos/{R}/actions/workflows/client.yml/runs?created=%3E%3D2026-10-08&event=pull_request&per_page=100&page=1",
    {"total_count": 1, "workflow_runs": client_runs})
# 完整测试参考
put(f"repos/{R}/actions/workflows/negative-controls.yml/runs?created=%3E%3D2026-11-07&per_page=100&page=1",
    {"total_count": 2, "workflow_runs": [run(300, [], 1, "2026-11-10T18:10:00Z", "2026-11-10T19:10:00Z", "main"),
                                          run(301, [], 1, "2026-11-11T18:10:00Z", "2026-11-11T20:10:00Z", "main")]})
put(f"repos/{R}/actions/workflows/release.yml/runs?created=%3E%3D2026-11-07&per_page=100&page=1", {"total_count": 0, "workflow_runs": []})
put(f"repos/{R}/actions/workflows/client.yml/runs?created=%3E%3D2026-11-07&per_page=100&page=1",
    {"total_count": 2, "workflow_runs": [{**run(400, [], 1, "2026-11-10T16:40:00Z", "2026-11-10T17:40:00Z", "main"), "event": "schedule"},
                                          {**run(401, [10], 1, "2026-11-11T02:00:00Z", "2026-11-11T02:04:00Z", "feature/issue-5"), "event": "pull_request"}]})

# 本机测试流水
def epoch(s):
    import datetime
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
w5, w7 = os.path.join(WT, "issue-5"), os.path.join(WT, "issue-7")
L = []
def runlog(i, wt, args, t0, secs=None):
    L.append({"ev": "start", "id": i, "wt": wt, "t": epoch(t0), "args": args})
    if secs is not None:
        L.append({"ev": "end", "id": i, "wt": wt, "t0": epoch(t0), "t": epoch(t0) + secs, "exit": 0, "units": 1, "failed": 0})
runlog("a", w5, "--quick -j 8", "2026-11-10T01:00:00Z", 60)
runlog("b", w5, "-j 6 --kind unit", "2026-11-10T01:02:00Z", 30)
runlog("c", w5, "smoke", "2026-11-10T01:03:00Z", 10)
runlog("d", w5, "-j 4 smoke autopilot", "2026-11-10T01:04:00Z", 40)
runlog("e", w5, "", "2026-11-10T01:05:00Z", 100)
runlog("f", w5, "--list", "2026-11-10T01:06:00Z", 1)
runlog("g", w5, "--quick", "2026-11-10T01:07:00Z")                   # 只有开始
runlog("h", w5, "--changed-from origin/main", "2026-11-10T01:08:00Z", 15)
runlog("i", w5, "--quick", "2026-11-13T00:00:00Z", 500)              # 合并之后：不算
runlog("j", os.path.join(WT, "issue-55"), "--quick", "2026-11-10T01:00:00Z", 77)   # 别的工作树
runlog("k", w7, "", "2026-11-10T05:00:00Z", 200)                     # 归 #12
runlog("l", w7, "", "2026-11-12T05:00:00Z", 300)                     # 归 #13
with open(os.path.join(sb, "runs.jsonl"), "w") as f:
    for x in L:
        f.write(json.dumps(x) + "\n")
    f.write("not json\n")
PY

run_stats() {   # 额外参数原样传给脚本
    python3 "$REPO_DIR/scripts/pr-time-stats.py" --repo o/r --worktree-base "$SB/wt" --bot-login loop-bot-pusher \
        --runs-log "$SB/runs.jsonl" --since 2026-11-07 "$@"
}
export XDG_CACHE_HOME="$SB/cache"

echo "【1–7】一次完整运行"
rc=0; run_stats --json --no-cache > "$SB/out.json" 2> "$SB/err" || rc=$?
if [ "$rc" = 0 ]; then echo "  ✅ 退出码 0"; pass=$((pass+1)); else echo "  ❌ 退出码 $rc：$(cat "$SB/err")"; fail=$((fail+1)); fi
tally < <(python3 - "$SB/out.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"FAIL 输出不是 JSON：{e}"); sys.exit()
P = {r["pr"]: r for r in d["prs"]}
def eq(name, got, want):
    print(f"OK {name}" if got == want else f"FAIL {name}：得到 {got!r}，期望 {want!r}")
eq("统计到的 PR：#10–#14（#15 派工早于窗口、#16 没合并、#17 窗口外）", sorted(P), [10, 11, 12, 13, 14])
eq("#15 列入「早于窗口」", d["excluded_too_early"], [15])
r = P[10]
eq("【1】#10 AI = 100（同一派工取最后一条）+ 50 + 30（PR 上 codex 一轮）", r["ai_secs"], 180.0)
eq("【1】#10 单跑 = 20 + 0 + 10", r["adhoc_secs"], 30.0)
eq("【1】#10 派工数 3（非机器人那条不算）", r["dispatches"], 3)
eq("【1】#10 标注派工重叠、测试记录不全、1 次未记到结束", sorted(r["flags"]),
   sorted(["派工重叠", "测试记录不全", "1 次整套测试未记到结束"]))
eq("【6】非机器人账号的机器记录计数 1", d["skipped_nonbot_footers"], 1)
eq("【2】#10 整套各类秒数", r["local_secs"],
   {"quick": 60.0, "kind": 30.0, "smoke": 10.0, "related": 55.0, "all": 100.0, "other": 0.0})
eq("【2】#10 整套各类次数（--list 不算，只有开始的也计次）", r["local_runs"],
   {"quick": 2, "kind": 1, "smoke": 1, "related": 2, "all": 1, "other": 0})
eq("【2】#10 本地小计 = 整套并集 255 + 单跑 30", r["local_total_secs"], 285.0)
eq("【3】#10 CI：第 1 次尝试按改动挑选 300 s、第 2 次全量 600 s、客户端 240 s",
   (r["ci_secs"]["shell_changed"], r["ci_secs"]["shell_full"], r["ci_secs"]["client"]), (300.0, 600.0, 240.0))
eq("【3】#10 CI 尝试次数", r["ci_attempts"], {"shell_full": 1, "shell_changed": 1, "shell_unknown": 0, "client": 1})
eq("【3】#10 CI 小计按并集（客户端与 Tests 第 2 次重叠）= 900", r["ci_total_secs"], 900.0)
eq("#10 测试总耗时 = 285 + 900", r["test_total_secs"], 1185.0)
eq("#10 完整测试 0", r["full_secs"], 0)
r = P[11]
eq("【4】#11 没有 footer → AI 无记录", (r["ai_secs"], r["ai_state"]), (None, "none"))
eq("【3】#11 fork 运行按分支认到 #11，挑选方式未知（没有汇总那一步）", (r["ci_secs"]["shell_unknown"], r["ci_attempts"]["shell_unknown"]), (180.0, 1))
eq("【4】#11 测试总耗时照算 = CI 180", r["test_total_secs"], 180.0)
eq("【3】归不到唯一 PR 的运行 1 次（#102；#103 #104 属于窗口外的 PR，不计）", d["ci_unassigned"], 1)
eq("【5】#12 拿 issue 7 合并前那轮 AI 60、工作树合并前那次 200 s", (P[12]["ai_secs"], P[12]["local_secs"]["all"]), (60.0, 200.0))
eq("【5】#13 拿合并后那轮 AI 70、那次 300 s", (P[13]["ai_secs"], P[13]["local_secs"]["all"]), (70.0, 300.0))
eq("【5】#12 / #13 标注共用工作树", ("共用工作树" in P[12]["flags"], "共用工作树" in P[13]["flags"]), (True, True))
eq("【4】#14 一条 footer 缺 ai_secs → AI 未知，不当 0", (P[14]["ai_secs"], P[14]["ai_state"]), (None, "unknown"))
s = d["summary"]
eq("【7】AI 平均只用 #10 #12 #13：(180+60+70)/3", round(s["ai"]["stat"]["mean"], 3), round(310 / 3, 3))
eq("【7】AI 中位数 70、分母 3、未计入 2", (s["ai"]["stat"]["median"], s["ai"]["stat"]["n"], s["ai"]["excluded"]), (70.0, 3, 2))
eq("【7】测试总耗时分母 5（#11 没 footer 也算）", s["test_total"]["stat"]["n"], 5)
eq("【7】标注计数", s["flagged"], {"派工重叠": 1, "测试记录不全": 1, "共用工作树": 2})
eq("完整测试参考：负对照 2 次、平均 90 分钟；客户端只算定时那 1 次", (d["full_tests"]["negative-controls.yml"]["n"],
   d["full_tests"]["negative-controls.yml"]["mean"], d["full_tests"]["client.yml"]["n"], d["full_tests"]["release.yml"]["n"]),
   (2, 5400.0, 1, 0))
eq("流水读不懂的行计数 1", d["runs_log_bad_lines"], 1)
PY
)

echo "【7】人读报告"
run_stats --no-cache > "$SB/out.md" 2>&1
for want in "AI 耗时 | 1m 43s | 1m 10s | 3 | 2" "1 次 CI 运行归不到唯一一个 PR" "| #10 | 5 | 3m 0s |"; do
    if grep -qF -- "$want" "$SB/out.md"; then echo "  ✅ 报告含「$want」"; pass=$((pass+1))
    else echo "  ❌ 报告缺「$want」"; fail=$((fail+1)); fi
done

echo "【3】--no-ci-selection：不读日志，挑选方式记未知"
: > "$SB/gh/calls.log"
run_stats --json --no-cache --no-ci-selection > "$SB/out2.json" 2>/dev/null
got=$(python3 -c 'import json,sys; r={x["pr"]:x for x in json.load(open(sys.argv[1]))["prs"]}[10]; print(r["ci_attempts"]["shell_unknown"])' "$SB/out2.json" 2>/dev/null)
if [ "$got" = 2 ] && ! grep -q '/logs$' "$SB/gh/calls.log"; then echo "  ✅ 两次尝试都记未知、没读日志"; pass=$((pass+1))
else echo "  ❌ 得到 $got；日志调用：$(grep -c '/logs$' "$SB/gh/calls.log")"; fail=$((fail+1)); fi

echo "【10】跑完的 CI 尝试存本机缓存：重跑不再读，读失败的不存"
rm -rf "$SB/cache"
FAKE_GH_FAIL="repos/o/r/actions/jobs/502/logs" run_stats --json > "$SB/c1.json" 2>/dev/null
v1=$(python3 -c 'import json,sys; r={x["pr"]:x for x in json.load(open(sys.argv[1]))["prs"]}[10]; print(r["ci_attempts"]["shell_unknown"], r["ci_attempts"]["shell_full"])' "$SB/c1.json")
: > "$SB/gh/calls.log"
run_stats --json > "$SB/c2.json" 2>/dev/null
v2=$(python3 -c 'import json,sys; r={x["pr"]:x for x in json.load(open(sys.argv[1]))["prs"]}[10]; print(r["ci_attempts"]["shell_unknown"], r["ci_attempts"]["shell_full"])' "$SB/c2.json")
reread=$(grep -c 'jobs/502/logs' "$SB/gh/calls.log")
if [ "$v1" = "1 0" ] && [ "$v2" = "0 1" ] && [ "$reread" = 1 ]; then echo "  ✅ 读失败那次记未知、没进缓存，下次重新读到全量"; pass=$((pass+1))
else echo "  ❌ 第一次「$v1」第二次「$v2」重读 $reread 次"; fail=$((fail+1)); fi
: > "$SB/gh/calls.log"
run_stats --json > "$SB/c3.json" 2>/dev/null
n=$(grep -cE '/logs$|/jobs\?|/attempts/[0-9]+$' "$SB/gh/calls.log")
same=$(python3 -c 'import json,sys
a,b=(json.load(open(f)) for f in sys.argv[1:]); a.pop("gh_calls"); b.pop("gh_calls"); print(a==b)' "$SB/c2.json" "$SB/c3.json")
if [ "$n" = 0 ] && [ "$same" = True ]; then echo "  ✅ 第三次：CI 尝试、作业、日志一次都没再读，结果相同"; pass=$((pass+1))
else echo "  ❌ 第三次还读了 $n 次；结果相同：$same"; fail=$((fail+1)); fi
calls=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gh_calls"])' "$SB/c3.json")
if [ "$calls" = "$(wc -l < "$SB/gh/calls.log")" ]; then echo "  ✅ 报告的请求数 $calls = 假 gh 收到的请求数"; pass=$((pass+1))
else echo "  ❌ 报告 $calls 次，假 gh 收到 $(wc -l < "$SB/gh/calls.log") 次"; fail=$((fail+1)); fi

echo "【8】读失败 → 退出码 2，不出报告"
for f in "repos/o/r/issues/7/comments?per_page=100&page=1" \
         "repos/o/r/actions/workflows/client.yml/runs?created=%3E%3D2026-10-08&event=pull_request&per_page=100&page=1" \
         "repos/o/r/actions/runs/100/attempts/1"; do
    rc=0; out=$(FAKE_GH_FAIL="$f" run_stats --json --no-cache 2>"$SB/err") || rc=$?
    if [ "$rc" = 2 ] && [ -z "$out" ] && grep -q '统计失败' "$SB/err"; then echo "  ✅ ${f%%\?*} 失败 → 2"; pass=$((pass+1))
    else echo "  ❌ ${f%%\?*} 失败时 rc=$rc 输出 ${#out} 字节"; fail=$((fail+1)); fi
done
rc=0; out=$(python3 "$REPO_DIR/scripts/pr-time-stats.py" --repo o/r --worktree-base "$SB/wt" --runs-log "$SB/nope.jsonl" 2>"$SB/err") || rc=$?
if [ "$rc" = 2 ] && [ -z "$out" ]; then echo "  ✅ 流水读不了 → 2"; pass=$((pass+1)); else echo "  ❌ 流水读不了时 rc=$rc"; fail=$((fail+1)); fi
# 列表没读全：total_count 比实际多
python3 - "$SB" <<'PY'
import hashlib, json, os, sys
d = os.path.join(sys.argv[1], "gh")
p = "repos/o/r/actions/workflows/release.yml/runs?created=%3E%3D2026-11-07&per_page=100&page=1"
open(os.path.join(d, hashlib.sha1(p.encode()).hexdigest()), "w").write(json.dumps({"total_count": 3, "workflow_runs": []}))
PY
rc=0; out=$(run_stats --json --no-cache 2>"$SB/err") || rc=$?
if [ "$rc" = 2 ] && grep -q '没读全' "$SB/err"; then echo "  ✅ 列表没读全 → 2"; pass=$((pass+1)); else echo "  ❌ 列表没读全时 rc=$rc"; fail=$((fail+1)); fi

echo "【9】工作编号与 _lib.sh 的 pr_to_issue_num 对拍"
{ cat "$REPO_DIR/cavil-loop.config.example"; cat <<EOF
REPO="o/r"
PROJECT_ROOT="$SB"
WORKTREE_BASE="$SB/wt"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
TMUX_PREFIX="t"
STATE_DIR="$SB/state"
EOF
} > "$SB/conf"
cases=$'1\tfeature/issue-5\tRefs #9\n2\tfeature/issue-x\tCloses #3\n3\tmain\tfixed  #44 and closes #2\n4\tother\tno link\n5\tother\tSee #7\\nrefs #8\n6\tfeature/issue-12abc\t\n7\tother\tResolves #10\r\n8\tother\tclose\\n#11'
while IFS=$'\t' read -r n br body; do
    body=${body//\\n/$'\n'}
    sh=$(CODING_AGENT_CONFIG="$SB/conf" bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; pr_to_issue_num "$2" "$3" "$4"' _ "$REPO_DIR" "$n" "$br" "$body")
    py=$(python3 -c 'import importlib.util,sys
s=importlib.util.spec_from_file_location("m", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
print(m.item_num(int(sys.argv[2]), sys.argv[3], sys.argv[4], "feature/issue-"))' "$REPO_DIR/scripts/pr-time-stats.py" "$n" "$br" "$body")
    if [ -n "$sh" ] && [ "$sh" = "$py" ]; then echo "  ✅ PR $n（$br）→ $sh"; pass=$((pass+1))
    else echo "  ❌ PR $n（$br）：shell「$sh」python「$py」"; fail=$((fail+1)); fi
done <<< "$cases"

report_counts "$pass" "$fail"
echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
