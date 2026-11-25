#!/usr/bin/env bash
# kind: guard
# reads: repo
# 调用另一个工作流（jobs.<id>.uses: ./.github/workflows/X.yml）的任务，给的权限必须盖住被调工作流里
# 每个任务要的权限，否则 GitHub 整个运行起不来（startup_failure：一个任务都不跑，失败报告也不会开）。
# GitHub#578：client.yml 的夜间失败报告任务要 issues: write + actions: read，Release 只给了
# contents: write，11-21、11-22 两次定时 Release 都没启动，客户端正式版没出。
#
# 跑法：bash tests/workflow-call-permissions.test.sh
# 依赖：python3 + PyYAML（GitHub 的 ubuntu 运行器自带）。
set -uo pipefail
. "$(dirname "$0")/lib/report.sh"
cd "$(dirname "$0")/.."

out=$(python3 - "$@" <<'PY'
import sys, glob, yaml
LEVEL = {"none": 0, "read": 1, "write": 2}
SCOPES = ["actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token",
          "issues", "models", "packages", "pages", "pull-requests", "security-events", "statuses"]

def norm(p, inherited):
    """A permissions value → {scope: level}; None = not set (inherits)."""
    if p is None:
        return inherited
    if isinstance(p, str):
        if p == "read-all": return {s: 1 for s in SCOPES}
        if p == "write-all": return {s: 2 for s in SCOPES}
        raise SystemExit(f"BAD unknown permissions value {p!r}")
    if p == {}:
        return {s: 0 for s in SCOPES}
    d = {s: 0 for s in SCOPES}
    for k, v in p.items():
        d[k] = LEVEL[v]
    return d

FULL = {s: 2 for s in SCOPES}  # caller with nothing set: repository default, not checked here
def load(path):
    with open(path) as f:
        return yaml.safe_load(f)

checked = 0
for path in sorted(glob.glob(".github/workflows/*.yml")):
    wf = load(path)
    top = norm(wf.get("permissions"), FULL)
    for jid, job in (wf.get("jobs") or {}).items():
        uses = job.get("uses") or ""
        if not uses.startswith("./.github/workflows/"):
            continue
        granted = norm(job.get("permissions"), top)
        called = load(uses[2:])
        ctop = norm(called.get("permissions"), granted)
        for cj, cjob in (called.get("jobs") or {}).items():
            need = norm(cjob.get("permissions"), ctop)
            for s, lv in need.items():
                checked += 1
                if lv > granted.get(s, 0):
                    print(f"FAIL {path} job {jid} → {uses} job {cj}: {s} needs {lv}, granted {granted.get(s,0)}")
print(f"CHECKED {checked}")
PY
)
rc=$?
echo "$out"
PASS=0; FAIL=0
if [ $rc -ne 0 ] || ! grep -q '^CHECKED [1-9]' <<<"$out"; then
    echo "❌ 检查没跑完或一个调用都没查到（exit $rc）"; FAIL=$((FAIL+1))
elif grep -q '^FAIL' <<<"$out"; then
    FAIL=$((FAIL + $(grep -c '^FAIL' <<<"$out")))
else
    echo "✅ 每个被调用工作流要的权限都在调用方给的范围内"; PASS=$((PASS+1))
fi
echo
echo "通过 $PASS，失败 $FAIL"
report_counts "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
