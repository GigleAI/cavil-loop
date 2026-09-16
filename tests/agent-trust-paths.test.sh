#!/usr/bin/env bash
# claude driver 的 `agent_trust_paths`：给 setup.sh 预写 folder-trust 记录。
#
# 跑法：bash tests/agent-trust-paths.test.sh
# 依赖：jq。全程在临时目录里操作假的 .claude.json，不碰真实 ~/.claude.json。
#
# 为什么要有这个文件：这条链路错了同样**不会报错**——
#   · 没写进去 → 新项目第一次派工时 worker 挂在 folder-trust 弹窗上，
#     session 活着、issue 翻成 doing/agent，看日志一切正常，纯粹假在跑；
#   · 写坏了 → 赔上的是用户整个 ~/.claude.json（onboarding、历史、缓存全在里面），
#     而且是在一台可能正有 claude 在跑的机器上；
#   · 不幂等 → 每次 setup 都重写一遍那个文件，平白多一次跟活着的 claude 抢写。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=../scripts/drivers/claude.sh
source "$REPO_DIR/scripts/drivers/claude.sh"

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

trusted() { jq -r --arg p "$2" '.projects[$p].hasTrustDialogAccepted // false' "$1"; }
inode()   { ls -i "$1" | awk '{print $1}'; }

echo "== 1. 文件不存在：建出来，两条路径都信任 =="
export CLAUDE_JSON_PATH="$TMP/fresh.json"
agent_trust_paths "/repo/acme" "/wt/acme"; rc=$?
chk "返回 0"                "$rc" "0"
chk "仓库根 trusted"        "$(trusted "$CLAUDE_JSON_PATH" /repo/acme)" "true"
chk "worktree base trusted" "$(trusted "$CLAUDE_JSON_PATH" /wt/acme)"   "true"

echo "== 2. 已有内容一律保留，只加自己那两条 =="
export CLAUDE_JSON_PATH="$TMP/existing.json"
cat > "$CLAUDE_JSON_PATH" <<'JSON'
{"numStartups":42,"userID":"u1","projects":{"/repo/old":{"hasTrustDialogAccepted":true,"allowedTools":["Bash(ls)"],"history":[{"display":"x"}]}}}
JSON
agent_trust_paths "/repo/acme" "/wt/acme"
chk "无关顶层字段还在"   "$(jq -r '.numStartups' "$CLAUDE_JSON_PATH")" "42"
chk "老项目的 allowedTools 没被清" "$(jq -r '.projects["/repo/old"].allowedTools[0]' "$CLAUDE_JSON_PATH")" "Bash(ls)"
chk "老项目的 history 没被清"      "$(jq -r '.projects["/repo/old"].history[0].display' "$CLAUDE_JSON_PATH")" "x"
chk "新项目 trusted"     "$(trusted "$CLAUDE_JSON_PATH" /repo/acme)" "true"

echo "== 3. 幂等：已经信任就一个字节都不写 =="
before_inode=$(inode "$CLAUDE_JSON_PATH")
before_sum=$(cksum < "$CLAUDE_JSON_PATH")
agent_trust_paths "/repo/acme" "/wt/acme"; rc=$?
chk "返回 0"       "$rc" "0"
chk "内容没变"     "$(cksum < "$CLAUDE_JSON_PATH")" "$before_sum"
chk "文件没被重写" "$(inode "$CLAUDE_JSON_PATH")" "$before_inode"

echo "== 4. 已有条目但 trust 是 false：补成 true，别的字段不动 =="
export CLAUDE_JSON_PATH="$TMP/false.json"
echo '{"projects":{"/repo/acme":{"hasTrustDialogAccepted":false,"allowedTools":["Edit"]}}}' > "$CLAUDE_JSON_PATH"
agent_trust_paths "/repo/acme"
chk "翻成 true"        "$(trusted "$CLAUDE_JSON_PATH" /repo/acme)" "true"
chk "allowedTools 保留" "$(jq -r '.projects["/repo/acme"].allowedTools[0]' "$CLAUDE_JSON_PATH")" "Edit"

echo "== 5. 文件不是合法 JSON：失败退出，原文件一字不动 =="
export CLAUDE_JSON_PATH="$TMP/broken.json"
printf '{ 这不是 json' > "$CLAUDE_JSON_PATH"
before_sum=$(cksum < "$CLAUDE_JSON_PATH")
agent_trust_paths "/repo/acme" 2>/dev/null; rc=$?
chk "返回非 0"     "$([ "$rc" != 0 ] && echo yes || echo no)" "yes"
chk "原文件没被动" "$(cksum < "$CLAUDE_JSON_PATH")" "$before_sum"
chk "没留下临时文件" "$(find "$TMP" -name 'broken.json.*' | wc -l | tr -d ' ')" "0"

echo "== 6. 路径带空格 / 中文也能进 key =="
export CLAUDE_JSON_PATH="$TMP/space.json"
agent_trust_paths "/repo/ai hub" "/工作区/项目"
chk "带空格的路径"  "$(trusted "$CLAUDE_JSON_PATH" "/repo/ai hub")" "true"
chk "中文路径"      "$(trusted "$CLAUDE_JSON_PATH" "/工作区/项目")" "true"

echo "== 7. 不给参数：直接返回 0，不建文件 =="
export CLAUDE_JSON_PATH="$TMP/never.json"
agent_trust_paths; rc=$?
chk "返回 0"     "$rc" "0"
chk "文件没被建" "$([ -e "$CLAUDE_JSON_PATH" ] && echo yes || echo no)" "no"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
