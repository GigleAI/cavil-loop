#!/usr/bin/env bash
# 周报明细的入选口径（collect.py 的 detail / loose_prs）。
#
# 跑法：bash tests/weekly-report-detail.test.sh
# 依赖：python3。自造假 `gh` 放 PATH 最前面喂 fixture，不碰网络、不碰真实仓库。
#
# 为什么要有这个文件：这条链路错了**不会报错，也不会体现在总量上**。
# 汇总数字（讨论条数 / AI 时长 / 成本）本来就按 issue + PR 全量算，怎么筛明细都不影响它们；
# 错的只有「这周到底在做哪些事」那份清单，而清单少一条根本看不出来。
#
#   · 只按「issue 自己有评论」筛 → 定完方案后讨论全搬到 PR 上的 issue 整条消失。
#     实测漏过一整周里耗时最高的那个单项：它的讨论全在 PR 上，issue 页整周零评论。
#   · 没有关联 issue 的 PR（chore / 工具链）不挂在任何 issue 下 → 只看 issue 清单完全看不见。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
COLLECT="$REPO_DIR/scripts/weekly-report/collect.py"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

# 目标周：2025-01-06（周一） ~ 01-12（周日），北京时间
W_IN="2025-01-08T02:00:00Z"    # 窗口内
W_OUT="2024-12-31T02:00:00Z"   # 窗口前一周

cat > "$TMP/issues.json" <<JSON
[
 {"number":10,"title":"讨论全在 PR 上的 issue","state":"open","labels":[{"name":"pending/PR"}],
  "created_at":"$W_OUT","closed_at":null},
 {"number":11,"title":"fix: 修一修（#10）","state":"open","labels":[],
  "created_at":"$W_OUT","closed_at":null,"pull_request":{"merged_at":null}},
 {"number":20,"title":"自己有讨论的 issue","state":"open","labels":[],
  "created_at":"$W_OUT","closed_at":null},
 {"number":30,"title":"当周关闭但零评论","state":"closed","labels":[],
  "created_at":"$W_OUT","closed_at":"$W_IN"},
 {"number":40,"title":"chore: 无 issue 的 PR，有讨论","state":"open","labels":[],
  "created_at":"$W_OUT","closed_at":null,"pull_request":{"merged_at":null}},
 {"number":50,"title":"chore: 无 issue 的 PR，当周合并","state":"closed","labels":[],
  "created_at":"$W_OUT","closed_at":"$W_IN","pull_request":{"merged_at":"$W_IN"}},
 {"number":60,"title":"整周没动静","state":"open","labels":[],
  "created_at":"$W_OUT","closed_at":null}
]
JSON

# #11（挂在 #10 下）3 条；#20 自己 1 条；#40 2 条。都带耗时 footer。
cat > "$TMP/comments.json" <<JSON
[
 {"id":1,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "html_url":"https://github.com/acme/widget/pull/11#issuecomment-1",
  "user":{"login":"acme-bot"},"created_at":"$W_IN","body":"干活\n⏱️ 开始 x · 耗时 1h 0m 0s (\$10.00)"},
 {"id":2,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "html_url":"https://github.com/acme/widget/pull/11#issuecomment-2",
  "user":{"login":"luosky"},"created_at":"$W_IN","body":"人话回一句"},
 {"id":3,"issue_url":"https://api.github.com/repos/acme/widget/issues/11",
  "html_url":"https://github.com/acme/widget/pull/11#issuecomment-3",
  "user":{"login":"acme-bot"},"created_at":"$W_IN","body":"再干\n⏱️ 开始 x · 耗时 30m 0s (\$5.00)"},
 {"id":4,"issue_url":"https://api.github.com/repos/acme/widget/issues/20",
  "html_url":"https://github.com/acme/widget/issues/20#issuecomment-4",
  "user":{"login":"acme-bot"},"created_at":"$W_IN","body":"干活\n⏱️ 开始 x · 耗时 15m 0s (\$1.00)"},
 {"id":5,"issue_url":"https://api.github.com/repos/acme/widget/issues/40",
  "html_url":"https://github.com/acme/widget/pull/40#issuecomment-5",
  "user":{"login":"acme-bot"},"created_at":"$W_IN","body":"干活\n⏱️ 开始 x · 耗时 20m 0s (\$2.00)"},
 {"id":6,"issue_url":"https://api.github.com/repos/acme/widget/issues/40",
  "html_url":"https://github.com/acme/widget/pull/40#issuecomment-6",
  "user":{"login":"acme-bot"},"created_at":"$W_IN","body":"再干"},
 {"id":7,"issue_url":"https://api.github.com/repos/acme/widget/issues/60",
  "html_url":"https://github.com/acme/widget/issues/60#issuecomment-7",
  "user":{"login":"acme-bot"},"created_at":"$W_OUT","body":"上上周的，不该进本周"}
]
JSON

cat > "$TMP/pulls.json" <<JSON
[
 {"number":11,"title":"fix: 修一修（#10）","body":"Closes #10"},
 {"number":40,"title":"chore: 无 issue 的 PR，有讨论","body":"没写关联"},
 {"number":50,"title":"chore: 无 issue 的 PR，当周合并","body":""}
]
JSON

# 假 gh：按 path 里的关键字回 fixture
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<SH
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *"/issues/comments"*) cat "$TMP/comments.json"; exit 0 ;;
    *"/pulls?"*)          cat "$TMP/pulls.json";    exit 0 ;;
    *"/issues?"*)         cat "$TMP/issues.json";   exit 0 ;;
  esac
done
echo "[]"
SH
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

# git 统计跑在空目录上会拿不到 origin/main，collect.py 容忍（行数记 0），不影响本测试
cd "$TMP"
python3 "$COLLECT" --repo acme/widget --out "$TMP/data.json" --weeks 2 --week-of 2025-01-06 \
    >/dev/null 2>"$TMP/err.log" || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }

# 断言失败时（比如某条 issue 根本没进明细）打印空串而不是抛 traceback，
# 让输出留给 chk 的 ❌ 行
q() { python3 -c "
import json
D=json.load(open('$TMP/data.json'))
def one(group,n):
    r=[d for d in D[group] if d['num']==n]
    return r[0] if r else {}
try:
    $1
except Exception:
    print('')
" ; }

nums=$(q "print(','.join(str(d['num']) for d in sorted(D['detail'],key=lambda x:x['num'])))")
chk "明细含：PR 侧有讨论的 #10、自己有讨论的 #20、当周关闭的 #30；不含没动静的 #60" "$nums" "10,20,30"

loose=$(q "print(','.join(str(d['num']) for d in sorted(D['loose_prs'],key=lambda x:x['num'])))")
chk "无关联 issue 的 PR 单列：#40（有讨论）+ #50（当周合并）" "$loose" "40,50"

r10=$(q "print(int(one('detail',10)['rounds']))")
chk "#10 的轮数并进了 PR #11 的 3 条" "$r10" "3"

h10=$(q "print(int(one('detail',10)['human']))")
chk "#10 的「你参与」只算非 bot 的那 1 条" "$h10" "1"

s10=$(q "print(int(one('detail',10)['secs']))")
chk "#10 的耗时并进 PR 侧 1h + 30m" "$s10" "5400"

p10=$(q "print(','.join(str(p['num']) for p in one('detail',10).get('prs',[])))")
chk "#10 挂上了关联 PR #11" "$p10" "11"

npr=$(q "print(sum(1 for d in D['detail'] if d['is_pr']))")
chk "明细里不混进 PR 本身" "$npr" "0"

s40=$(q "print(int(one('loose_prs',40)['secs']))")
chk "无 issue 的 PR #40 也带耗时" "$s40" "1200"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
