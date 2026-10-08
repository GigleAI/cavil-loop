#!/usr/bin/env bash
# 机器人账号判定（record.is_bot + WEEKLY_REPORT_BOT_LOGINS）。
#
# 跑法：bash tests/weekly-report-bot-logins.test.sh
# 依赖：python3。自造假 `gh` 喂 fixture，HOME 指向临时目录，不碰网络、不读本机日志。
#
# 为什么要有这个文件（GigleAI/cavil-loop#46）：
# 判定原来只认 `-bot` / `[bot]` 后缀，而且 record.py 和 collect.py 各抄一份。worker 换成
# `acme-bot-pusher` 这种名字后，两处一起错、都不报错：
#   · 它发的几百条评论被算进「你发的」；
#   · 它写的记账行在 record.extract() 第一步因「作者不是机器人」被整条丢掉 → 耗时 / 金额归零。
# 判定的基本用例（未配 / 配了 / 精确匹配 / 记账入账 / 共用一个函数）在 weekly-report-record.test.sh
# 里（随 #47 合入）。本文件只补它没覆盖的：大小写、换行分隔，以及**端到端**跑 collect.py——
# 只测函数挡不住「collect 里某处调用没走共用判定」。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
WR="$REPO_DIR/scripts/weekly-report"
COLLECT="$WR/collect.py"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }

# 在干净环境里调 record.is_bot；$1 是名单（传 - 表示完全不设变量），其余是登录名
is_bot() {
    local list="$1"; shift
    if [ "$list" = "-" ]; then
        env -u WEEKLY_REPORT_BOT_LOGINS python3 - "$WR" "$@" <<'PY'
import sys; sys.path.insert(0, sys.argv[1]); import record
print(",".join("1" if record.is_bot(x) else "0" for x in sys.argv[2:]))
PY
    else
        WEEKLY_REPORT_BOT_LOGINS="$list" python3 - "$WR" "$@" <<'PY'
import sys; sys.path.insert(0, sys.argv[1]); import record
print(",".join("1" if record.is_bot(x) else "0" for x in sys.argv[2:]))
PY
    fi
}

echo "— 判定本身：只补 weekly-report-record.test.sh 没覆盖的 —"
chk "不配名单：acme-bot-pusher 不认；后缀规则照旧" \
    "$(is_bot - acme-bot-pusher acme-bot 'app[bot]' luosky)" "0,1,1,0"
chk "逗号 / 空格 / 换行混合分隔，三个都认" \
    "$(is_bot $'a1, b2\nc3' a1 b2 c3)" "1,1,1"
chk "分隔产生的空项不会把空登录名当成机器人" \
    "$(is_bot ', ,a1,' '' a1)" "0,1"
chk "GitHub 登录名不区分大小写：名单与评论账号大小写不同也认" \
    "$(is_bot Acme-Bot-Pusher acme-bot-pusher ACME-BOT-PUSHER)" "1,1"
chk "不区分大小写不等于放宽：前缀 / 子串仍不认" \
    "$(is_bot Acme-Bot-Pusher acme-bot-pusher2 acme-bot-push x-acme-bot-pusher)" "0,0,0"

echo
MARK='干完了。

<!-- agent-metrics agent=claude wt=10 start=2025-01-08T10:00:00+08:00 end=2025-01-08T10:30:00+08:00 wall_secs=1800 in=1 out=1 cache_r=0 cache_w=0 cost_usd=12.5 -->'

echo "— 端到端：collect.py 的「你发的」与耗时 / 金额 —"
W=2025-01-06
py_json() { python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"; }
cat > "$TMP/issues.json" <<'JSON'
[ {"number":10,"title":"承载记账的 issue","state":"open","labels":[],
   "created_at":"2024-12-01T02:00:00Z","closed_at":null} ]
JSON
echo "[]" > "$TMP/pulls.json"
row() {   # id login hh body
    printf '{"id":%s,"issue_url":"https://api.github.com/repos/acme/widget/issues/10","html_url":"https://github.com/acme/widget/issues/10#issuecomment-%s","user":{"login":"%s"},"created_at":"2025-01-08T0%s:00:00Z","body":%s}' \
        "$1" "$1" "$2" "$3" "$(printf '%s' "$4" | py_json)"
}
printf '[%s,%s,%s]' \
    "$(row 1 acme-bot-pusher 2 "$MARK")" \
    "$(row 2 acme-bot-pusher 3 '再补一句')" \
    "$(row 3 luosky 4 '人话回一句')" > "$TMP/comments.json"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<SHIM
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *"/issues/comments"*) cat "$TMP/comments.json"; exit 0 ;;
    *"/pulls?"*)          cat "$TMP/pulls.json";    exit 0 ;;
    *"/issues?"*)         cat "$TMP/issues.json";   exit 0 ;;
  esac
done
echo "[]"
SHIM
chmod +x "$TMP/bin/gh"; export PATH="$TMP/bin:$PATH"
cd "$TMP"

# 输出「周总表人发 / 周总表机器人 / 耗时 / 金额 / issue 明细人发」。collect.py 有两处按评论数人：
# 周总表和 issue 明细，两处都要断言——只看周总表时，明细那处退回后缀规则测试照样全绿（复审实测）。
collect() {   # list
    WEEKLY_REPORT_BOT_LOGINS="$1" python3 "$COLLECT" --repo acme/widget --out "$TMP/d.json" \
        --weeks 2 --week-of "$W" >/dev/null 2>"$TMP/err.log" \
        || { echo "collect.py 跑挂了："; cat "$TMP/err.log"; exit 1; }
    python3 -c "
import json; w=json.load(open('$TMP/d.json'))['weekly']['$W']
D=json.load(open('$TMP/d.json')); d=[x for x in D['detail'] if x['num']==10]
print(int(w['human']), int(w['bot']), int(w['wall']), round(w['cost'], 2), int(d[0]['human']) if d else 'no-detail')"
}
chk "不配名单：机器人的 2 条算成人发的、耗时 / 金额归零（负对照，即 #46 的现象）" \
    "$(collect '')" "3 0 0 0 3"
chk "配了名单：周总表和明细的人发都只剩 1 条，30 分钟 / \$12.5 入账" \
    "$(collect acme-bot-pusher)" "1 2 1800 12.5 1"
chk "名单大小写与评论账号不同：结果同上" \
    "$(collect ACME-Bot-Pusher)" "1 2 1800 12.5 1"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
