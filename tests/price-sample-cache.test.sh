#!/usr/bin/env bash
# kind: e2e
# 价目表增量缓存 + 一条 footer 只取一次价目表（GitHub#606）。
#
# 跑法：bash tests/price-sample-cache.test.sh
# 依赖：python3、jq、git。不碰网络、不读本机真实会话（HOME / XDG_CACHE_HOME /
#       CLAUDE_PROJECTS_DIR 全指到临时目录）。
#
# 一份按真实日志形状造的固定快照（单模型 / 多模型 / 金额太小 / 没有总账 / 坏行 / 5m 与 1h
# 两档缓存写入），全部跑真实脚本：
#   【1】价目表：带缓存的 `price_solve.py --table` 每个场景都和同一份代码的 `--no-cache`（全量
#        重扫）逐字节比；冷缓存那一次另和合并基点的脚本比。「打开了哪些日志」由测试自己的
#        sitecustomize 审计钩子记录（生产代码里没有测试开关）。场景：冷缓存、热缓存不变（0 个
#        文件被打开）、往有总账的文件追加缓存写入（只打开这一个）、等长替换金额后用 os.utime
#        恢复修改时间、删掉重建同名同大小、删除、读到一半有新写入（那个文件不进缓存）、改参照 /
#        新增抓来的价 / 改缓存里记的程序版本 / 改抽样参数、缓存损坏、缓存目录不可写
#        另把 docs/operations{,.zh}.md 里的全量重扫命令在只有 HOME / PATH 的环境里原样跑一遍
#   【2】footer：真实 comment-footer.sh + 真实 claude.sh。Claude 一侧整条 footer 价目表只算 1 次；
#        `--both` 与分两次单独调用的两行逐字节一致；正常、参照价兜底、无价（cost_state=none）
#        三种输出与合并基点的 footer 逐字节一致；取表无输出时两行同口径，与合并基点同故障下一致；
#        「第一次取表失败、第二次成功」这种只有旧的两次调用才会遇到的情形，新路径只取一次、两行一致；
#        驱动只给一行 / 退出码非 0 / 没有输出时两行一起算未知，只调用 1 次；Codex 一侧照旧调两次
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/compat.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "TMP=$TMP" || { chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"; }' EXIT
export TZ=Asia/Shanghai

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail + 1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望 [$3] 实得 [$2]"; fi; }
same() { # 名字 文件A 文件B：逐字节一致，且不是空的
    if [ -s "$2" ] && cmp -s "$2" "$3"; then ok "$1"
    else bad "$1" "$(diff <(head -c 600 "$2") <(head -c 600 "$3") | head -6)"; fi
}

# ── 两份代码：当前的与合并基点的 ─────────────────────────────────────────────
NEW="$REPO_DIR/scripts"
OLD_ROOT="$TMP/old"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$OLD_ROOT"
git -C "$REPO_DIR" archive "$BASE_REV" scripts | tar -x -C "$OLD_ROOT"
OLD="$OLD_ROOT/scripts"
CMP_OLD=1
if compat_skip "价目表与 footer 跟合并基点比" "$OLD_ROOT" "$REPO_DIR" \
        scripts/weekly-report scripts/drivers/token-usage; then
    CMP_OLD=0
fi

# ── 探针：测试自己的 sitecustomize（审计钩子），生产代码不动 ─────────────────────
#   PROBE_LOG       每个 price_solve.py 进程记一行 "run"；它打开 PROBE_ROOT 下的文件记 "open <路径>"
#   PROBE_SOLVER_FAIL=all|first   price_solve.py 什么都不输出就退出（first：只有第一次）
#   PROBE_INJECT=<文件> PROBE_INJECT_LINE=<一行>   第一次打开这个文件时（已 stat、尚未读）往里追加
#   FOOTER_TEST_NOW 把 time.time() 钉住，footer 的结束时刻与 AI 时间的「现在」才可比
PROBE="$TMP/probe"
mkdir -p "$PROBE"
cat > "$PROBE/sitecustomize.py" <<'PY'
import os, sys, time
_now = os.environ.get("FOOTER_TEST_NOW")
if _now:
    time.time = lambda: float(_now)
_log = os.environ.get("PROBE_LOG")
_root = os.environ.get("PROBE_ROOT")
_is_solver = os.path.basename(sys.argv[0] if sys.argv else "") == "price_solve.py"
def _w(s):
    with open(_log, "a", encoding="utf-8") as f:
        f.write(s + "\n")
if _log and _is_solver:
    _w("run")
    mode = os.environ.get("PROBE_SOLVER_FAIL", "")
    if mode:
        flag = _log + ".failed-once"
        if mode == "all" or not os.path.exists(flag):
            open(flag, "w").close()
            os._exit(0)
if _log and _root and _is_solver:
    _inj = os.environ.get("PROBE_INJECT")
    _done = []
    def _hook(ev, args):
        if ev != "open" or not args or not isinstance(args[0], str):
            return
        p = args[0]
        if not p.startswith(_root + "/") or not p.endswith(".jsonl"):
            return
        _w("open " + p)
        if _inj and p == _inj and not _done:
            _done.append(1)
            with open(p, "a", encoding="utf-8") as f:
                f.write(os.environ["PROBE_INJECT_LINE"] + "\n")
    sys.addaudithook(_hook)
PY

P="$TMP/home/.claude/projects"
export PROBE_ROOT="$P"
mkdir -p "$TMP/home"

# ── 固定快照 ─────────────────────────────────────────────────────────────────
START=1790000000                              # 开始时间固定：2026-09-21 左右
WT="$TMP/wt/proj-issue-7"; WT2="$TMP/wt/proj-issue-8"; WT3="$TMP/wt/proj-issue-9"
mkdir -p "$WT" "$WT2" "$WT3"
python3 - "$P" "$START" "$WT" "$WT2" <<'PY'
import json, os, random, sys, datetime
base, start, wt, wt2 = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
rnd = random.Random(606)
def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
def put(d, name, recs):
    os.makedirs(os.path.join(base, d), exist_ok=True)
    with open(os.path.join(base, d, name), "w", encoding="utf-8") as f:
        for r in recs:
            f.write((r if isinstance(r, str) else json.dumps(r)) + "\n")
def asst(t, rid, model, i=1, o=1, cr=0, w5=0, w1=0):
    return {"type": "assistant", "timestamp": iso(t), "requestId": rid, "uuid": rid,
            "message": {"model": model, "usage": {
                "input_tokens": i, "output_tokens": o, "cache_read_input_tokens": cr,
                "cache_creation": {"ephemeral_5m_input_tokens": w5, "ephemeral_1h_input_tokens": w1}}}}
def total(cost, mu):
    return {"type": "cost-state", "startTime": 0, "totalCostUSD": cost, "modelUsage": mu}
# 30 个单模型会话（claude-opus-5，单价 5 / 25 / 0.5 / 1h 写 10），够反解
for k in range(30):
    i = rnd.uniform(20, 100) * 1000; o = rnd.uniform(4, 20) * 1000
    cr = rnd.uniform(200, 1000) * 1000; cw = rnd.uniform(10, 50) * 1000
    cost = (i * 5 + o * 25 + cr * 0.5 + cw * 10) / 1e6
    put(f"-s{k}", f"s{k}.jsonl", [
        asst(start - 9000 + k, f"q{k}", "claude-opus-5", w1=int(cw)),
        {"type": "user", "timestamp": iso(start - 8000), "message": {"content": "x"}},
        total(cost, {"claude-opus-5": {"inputTokens": int(i), "outputTokens": int(o),
                                       "cacheReadInputTokens": int(cr),
                                       "cacheCreationInputTokens": int(cw)}})])
# 不进样本的：多模型、金额太小、没有总账、坏行 + [1m] 后缀
put("-multi", "m.jsonl", [total(3.0, {"claude-opus-5": {"inputTokens": 1}, "claude-haiku-4-5": {"inputTokens": 1}})])
put("-small", "t.jsonl", [total(0.01, {"claude-opus-5": {"inputTokens": 10}})])
put("-nocost", "n.jsonl", [asst(start - 100, "nc", "claude-opus-5", w1=5)])
put("-broken", "b.jsonl", ['{"type":"assistant", broken', total(0.9, {"claude-opus-5[1m]": {
    "inputTokens": 50000, "outputTokens": 9000, "cacheReadInputTokens": 400000,
    "cacheCreationInputTokens": 20000}})])
# 本 worktree 的会话：本机反解的 opus-5 + 只有参照价的 haiku（兜底）+ 窗口外的一次
enc = wt.replace("/", "-")
put(enc, "w1.jsonl", [
    asst(start - 50, "old", "claude-opus-5", i=999, o=999),
    {"type": "user", "timestamp": iso(start + 2), "isSidechain": False, "message": {"role": "user", "content": "x"}},
    {"type": "api-request", "timestamp": iso(start + 3), "querySource": "repl_main_thread"},
    asst(start + 10, "a1", "claude-opus-5", i=1200, o=3400, cr=500000, w1=20000),
    asst(start + 12, "a1", "claude-opus-5", i=1200, o=3400, cr=500000, w1=20000),
    asst(start + 40, "a2", "claude-haiku-4-5", i=300, o=800, cr=90000, w5=4000),
    {"type": "api-request", "timestamp": iso(start + 30), "querySource": "repl_main_thread"}])
put(enc, "w2.jsonl", [asst(start + 70, "a3", "claude-opus-5", i=10, o=50, cr=1000)])
# 第二个 worktree：只有认不出的模型 → cost_state=none
put(wt2.replace("/", "-"), "z.jsonl", [asst(start + 5, "z1", "claude-zzz-1", i=100, o=200)])
PY
NFILES=$(find "$P" -name '*.jsonl' | wc -l)

run_env=(HOME="$TMP/home" CLAUDE_PROJECTS_DIR="$P" PYTHONPATH="$PROBE")
# tbl <输出文件> [env…]：当前代码、带缓存；探针日志写到 <输出文件>.log
tbl() {
    local out="$1"; shift
    : > "$out.log"
    env "${run_env[@]}" XDG_CACHE_HOME="$TMP/cache" PROBE_LOG="$out.log" "$@" \
        python3 "$NEW/weekly-report/price_solve.py" --table > "$out"
}
# ref <输出文件> [env…]：当前代码、全量重扫（不读也不写缓存）
ref() {
    local out="$1"; shift
    env "${run_env[@]}" XDG_CACHE_HOME="$TMP/cache" "$@" \
        python3 "$NEW/weekly-report/price_solve.py" --table --no-cache > "$out"
}
opens() { grep -c '^open ' "$1.log"; }
opened() { grep '^open ' "$1.log" | sed 's/^open //' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
SC() { ls "$TMP/cache/cavil-loop"/price-samples-*.json 2>/dev/null | head -1; }

echo "── 1. 价目表：带缓存 = 全量重扫 ──"
echo "  （快照 $NFILES 个会话文件）"

tbl "$TMP/c1.json"
ref "$TMP/r1.json"
same "冷缓存：与全量重扫逐字节一致" "$TMP/c1.json" "$TMP/r1.json"
chk "冷缓存：每个日志文件打开一次" "$(opens "$TMP/c1.json")" "$NFILES"
chk "价目表真的解出了本机单价（不是全靠参照）" \
    "$(jq -r '.models["claude-opus-5"].input.status' "$TMP/c1.json")" "corroborated"
if [ "$CMP_OLD" = 1 ]; then
    env "${run_env[@]}" XDG_CACHE_HOME="$TMP/cache-old" python3 "$OLD/weekly-report/price_solve.py" --table > "$TMP/o1.json"
    same "冷缓存：与合并基点的脚本逐字节一致" "$TMP/c1.json" "$TMP/o1.json"
fi

tbl "$TMP/c2.json"
same "热缓存、快照没变：一致" "$TMP/c2.json" "$TMP/r1.json"
chk "热缓存、快照没变：一个日志文件都没打开" "$(opens "$TMP/c2.json")" "0"
chk "热缓存那一次确实跑了价目表计算" "$(grep -c '^run$' "$TMP/c2.json.log")" "1"

# 往一个已有总账的文件追加一条带 5m 缓存写入的 assistant 记录：两档都有用量 → 缓存写入单价分不开，表会变
F3="$P/-s3/s3.jsonl"
printf '%s\n' '{"type":"assistant","timestamp":"2026-09-21T00:00:00.000Z","requestId":"late","message":{"model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":777,"ephemeral_1h_input_tokens":0}}}}' >> "$F3"
tbl "$TMP/c3.json"; ref "$TMP/r3.json"
same "追加缓存写入：一致" "$TMP/c3.json" "$TMP/r3.json"
chk "追加缓存写入：只打开这一个文件" "$(opened "$TMP/c3.json")" "$F3"
chk "追加确实改变了价目表（5m 档从不可解变成两档分不开）" \
    "$(cmp -s "$TMP/c3.json" "$TMP/r1.json" && echo 没变 || echo 变了)" "变了"

# 等长替换总账里的金额，再用 os.utime 把修改时间改回去：大小、修改时间、inode 都不变，只有 ctime 变
F5="$P/-s5/s5.jsonl"
python3 - "$F5" <<'PY'
import json, os, sys
f = sys.argv[1]; st = os.stat(f)
lines = open(f, encoding="utf-8").read().splitlines()
r = json.loads(lines[-1]); old = json.dumps(r)
s = repr(r["totalCostUSD"]); d = s[2] if s[2] != "9" else "8"
new = old.replace(s, s[:2] + ("9" if d != "9" else "8") + s[3:], 1)
assert len(new) == len(old) and new != old
lines[-1] = new
with open(f, "r+", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
st2 = os.stat(f)
assert (st2.st_size, st2.st_mtime_ns, st2.st_ino) == (st.st_size, st.st_mtime_ns, st.st_ino)
PY
tbl "$TMP/c4.json"; ref "$TMP/r4.json"
same "等长替换金额 + 恢复修改时间：一致" "$TMP/c4.json" "$TMP/r4.json"
chk "等长替换：认出了这一个文件（靠 ctime）" "$(opened "$TMP/c4.json")" "$F5"
chk "等长替换确实改变了价目表" "$(cmp -s "$TMP/c4.json" "$TMP/r3.json" && echo 没变 || echo 变了)" "变了"

# 删掉一个文件，重建成同名、同大小的另一份内容（并把修改时间设成原来的）
F7="$P/-s7/s7.jsonl"
python3 - "$F7" <<'PY'
import json, os, sys
f = sys.argv[1]; st = os.stat(f)
lines = open(f, encoding="utf-8").read().splitlines()
r = json.loads(lines[-1]); mu = r["modelUsage"]["claude-opus-5"]
s = str(mu["inputTokens"]); mu["inputTokens"] = int(("1" if s[0] != "1" else "2") + s[1:])
lines[-1] = json.dumps(r)
os.unlink(f)
with open(f, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
assert os.stat(f).st_size == st.st_size
PY
tbl "$TMP/c5.json"; ref "$TMP/r5.json"
same "删掉后重建成同名同大小的另一份：一致" "$TMP/c5.json" "$TMP/r5.json"
chk "删掉重建：只重读这一个文件" "$(opened "$TMP/c5.json")" "$F7"

# 删除一个文件
rm "$P/-s11/s11.jsonl"
tbl "$TMP/c6.json"; ref "$TMP/r6.json"
same "删除一个文件：一致" "$TMP/c6.json" "$TMP/r6.json"
chk "删除一个文件：不用打开任何文件" "$(opens "$TMP/c6.json")" "0"
chk "删除的文件从缓存里拿掉了" "$(jq -r --arg f "$P/-s11/s11.jsonl" '.files | has($f)' "$(SC)")" "false"

# 读到一半有新写入：探针在已 stat、尚未读的那一刻往文件里追加一条缓存写入记录
F9="$P/-s9/s9.jsonl"
touch "$F9"   # 先让它变一下，这次必须重读
LINE='{"type":"assistant","timestamp":"2026-09-21T00:00:01.000Z","requestId":"mid","message":{"model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":4242}}}}'
tbl "$TMP/c7.json" PROBE_INJECT="$F9" PROBE_INJECT_LINE="$LINE"
chk "读到一半：追加真的发生在这次读取中" "$(grep -c '"mid"' "$F9")" "1"
ref "$TMP/r7.json"
same "读到一半有新写入：与按同一内容全量重扫一致" "$TMP/c7.json" "$TMP/r7.json"
chk "读到一半：这个文件的样本没进缓存" "$(jq -r --arg f "$F9" '.files | has($f)' "$(SC)")" "false"
chk "读到一半：别的文件照常进了缓存" "$(jq -r '.files | length' "$(SC)")" "$((NFILES - 2))"
tbl "$TMP/c8.json"
same "下一次：一致" "$TMP/c8.json" "$TMP/r7.json"
chk "下一次：只重读那一个文件" "$(opened "$TMP/c8.json")" "$F9"

# 参照价变化：在进程里改参照表（同 price-identifiability 第 8 组），必须重新反解且等于全量
chk "改参照价：触发重算，结果等于全量" "$(env "${run_env[@]}" XDG_CACHE_HOME="$TMP/cache" \
    PYTHONPATH="$NEW/weekly-report" python3 -c "
import json, price_solve as ps
ps.build_cached('A')
ps.REFERENCE['claude-opus-5'] = dict(ps.REFERENCE['claude-opus-5'], output=77)
a = json.dumps(ps.build_cached('A')); b = json.dumps(ps.build('A'))
print('ok' if a == b and json.loads(a)['models']['claude-opus-5']['output']['reference'] == 77 else 'bad')")" "ok"
chk "改快速档参照：触发重算" "$(env "${run_env[@]}" XDG_CACHE_HOME="$TMP/cache" \
    PYTHONPATH="$NEW/weekly-report" python3 -c "
import price_solve as ps
ps.build_cached('A')
ps.REFERENCE_FAST['claude-opus-5'] = dict(ps.REFERENCE_FAST.get('claude-opus-5', {}), input=99)
print(ps.build_cached('A')['fast']['claude-opus-5']['input'])")" "99"

# 新增抓来的价
mkdir -p "$TMP/cache/cavil-loop"
printf '%s\n' '{"claude":{"claude-test-9":{"prices":{"input":3,"output":15,"cache_read":0.3,"cache_write_5m":3.75,"cache_write_1h":6}}}}' \
    > "$TMP/cache/cavil-loop/fetched-prices.json"
tbl "$TMP/c9.json"; ref "$TMP/r9.json"
same "新增抓来的价：一致" "$TMP/c9.json" "$TMP/r9.json"
chk "新增抓来的价：表里用上了" "$(jq -r '.models["claude-test-9"].input.status' "$TMP/c9.json")" "fetched"
chk "新增抓来的价：日志不用重读" "$(opens "$TMP/c9.json")" "0"

# 改抽样参数（环境变量）：原来的目录指纹不管它，改了也读旧表
tbl "$TMP/c10.json" PRICE_SEED=8 PRICE_BOOTSTRAP_N=150
ref "$TMP/r10.json" PRICE_SEED=8 PRICE_BOOTSTRAP_N=150
same "改抽样参数：重算且等于全量" "$TMP/c10.json" "$TMP/r10.json"
chk "改抽样参数：结果确实不同于默认参数" "$(cmp -s "$TMP/c10.json" "$TMP/r9.json" && echo 没变 || echo 变了)" "变了"

# 缓存里记的程序版本不是当前版本 → 整份样本重读
jq '.code = "0000000000000000"' "$(SC)" > "$TMP/sc.tmp" && mv "$TMP/sc.tmp" "$(SC)"
tbl "$TMP/c11.json"
same "改缓存里记的程序版本：一致" "$TMP/c11.json" "$TMP/r9.json"
chk "改缓存里记的程序版本：全部重读" "$(opens "$TMP/c11.json")" "$((NFILES - 1))"

# 缓存损坏：截断 / 不是 JSON / 结构不对 / 一条记录缺字段，都退回全量
corrupt() { # 名字 改法
    tbl "$TMP/cx.json"       # 先确保缓存是好的
    eval "$2"
    tbl "$TMP/cy.json"
    same "缓存损坏（$1）：一致" "$TMP/cy.json" "$TMP/r9.json"
    chk "缓存损坏（$1）：退回全量重读" "$(opens "$TMP/cy.json")" "$((NFILES - 1))"
}
corrupt 截断 'head -c 100 "$(SC)" > "$TMP/sc.tmp" && mv "$TMP/sc.tmp" "$(SC)"'
corrupt 不是JSON 'printf "garbage" > "$(SC)"'
corrupt 结构不对 'printf "[1,2,3]" > "$(SC)"'
# 改坏缓存里的一处：<文件> <jq 改法> <resum|stale>。resum = 按缓存的格式约定（内容按原样顺序的
# JSON 的 sha256）重算校验和，让坏内容「看起来是原样写进去的」，测的是结构 / 类型检查本身；
# stale = 校验和不动，测的是校验和（PR #612 复审第 1 轮：两种坏法都绕过了检查）
mangle() {
    python3 - "$1" "$2" "$3" <<'PY'
import hashlib, json, subprocess, sys
f, prog, mode = sys.argv[1:]
c = json.load(open(f, encoding="utf-8"))
out = subprocess.run(["jq", "-c", prog], input=json.dumps(c), capture_output=True, text=True, check=True).stdout
c = json.loads(out)
key = "files" if "files" in c else "table"
if mode == "resum":
    blob = json.dumps(c[key], ensure_ascii=False, allow_nan=True)   # 格式约定：按原样顺序，不排序
    c["sum"] = hashlib.sha256(blob.encode("utf-8", "surrogatepass")).hexdigest()
json.dump(c, open(f, "w", encoding="utf-8"))
PY
}
corrupt 记录缺字段 'mangle "$(SC)" ".files |= with_entries(.value |= del(.raw))" resum'
corrupt 身份不是整数 'mangle "$(SC)" ".files |= with_entries(.value.id[0] = \"x\")" resum'
# 求解要用的数值类型不对：单模型总账里的用量、金额改成字符串（复审第 1 轮第 2 条，原来求解器直接崩溃）
SINGLE='(.files[] | select(.raw.last != null and (.raw.last.modelUsage | length) == 1) | .raw.last)'
corrupt 用量不是数 "mangle \"\$(SC)\" '$SINGLE.modelUsage[].inputTokens = \"x\"' resum"
corrupt 金额不是数 "mangle \"\$(SC)\" '$SINGLE.totalCostUSD = \"x\"' resum"
corrupt 缓存写入不是数 'mangle "$(SC)" ".files[].raw.w1 = \"x\"" resum'
# 类型都对、数被改了：只有校验和能认出
corrupt 数值被改且校验和没跟着改 "mangle \"\$(SC)\" '$SINGLE.modelUsage[].inputTokens += 1' stale"
# 一条只有多模型总账的记录：内容不进样本，不因为它的值没查就当坏缓存（不该多重读）
tbl "$TMP/cm.json"
chk "多模型总账的记录照常沿用（只查求解真正读的值）" "$(opens "$TMP/cm.json")" "0"

# 反解结果缓存：签名对、内容坏（复审第 1 轮第 1 条：原来直接输出空表，--report 崩溃）
PT="$TMP/cache/cavil-loop/price-table.json"
table_bad() { # 名字 改法
    tbl "$TMP/tx.json"
    eval "$2"
    tbl "$TMP/ty.json"
    same "反解结果缓存损坏（$1）：重新反解，结果一致" "$TMP/ty.json" "$TMP/r9.json"
    eval "$2"
    env "${run_env[@]}" XDG_CACHE_HOME="$TMP/cache" python3 "$NEW/weekly-report/price_solve.py" --report > "$TMP/tr.txt" 2>&1
    chk "反解结果缓存损坏（$1）：--report 照常出" "$? $(grep -c '^参照来源：' "$TMP/tr.txt")" "0 1"
}
table_bad 不是JSON 'printf garbage > "$PT"'
table_bad 表是空的 'mangle "$PT" ".table = {}" resum'
table_bad 少了模型表 'mangle "$PT" ".table |= del(.models)" resum'
table_bad 某项单价缺字段 'mangle "$PT" ".table.models[\"claude-opus-5\"].input |= del(.price)" resum'
table_bad 单价被改且校验和没跟着改 'mangle "$PT" ".table.models[\"claude-opus-5\"].input.price = 123" stale'

# 只换顺序、内容不变（复审第 2 轮）：输出的字节跟着键顺序走，所以缓存命中必须连顺序都和全量一样
FP="$TMP/cache/cavil-loop/fetched-prices.json"
cp "$FP" "$TMP/fp.orig"
tbl "$TMP/o0.json"
jq -S . "$TMP/fp.orig" > "$FP"
tbl "$TMP/o1.json"; ref "$TMP/o1r.json"
same "抓来的价只换了键顺序：带缓存 = 同输入全量" "$TMP/o1.json" "$TMP/o1r.json"
chk "抓来的价换顺序确实改变了输出的字节（这一条测得到东西）" \
    "$(cmp -s "$TMP/o1.json" "$TMP/o0.json" && echo 没变 || echo 变了)" "变了"
chk "抓来的价换顺序：日志不用重读" "$(opens "$TMP/o1.json")" "0"
cp "$TMP/fp.orig" "$FP"
tbl "$TMP/o2.json"
same "抓来的价换回原顺序：又与原来一致" "$TMP/o2.json" "$TMP/r9.json"
jq -S . "$PT" > "$TMP/pt.tmp" && mv "$TMP/pt.tmp" "$PT"
tbl "$TMP/o3.json"
same "反解结果缓存只换了键顺序：重新反解，结果一致" "$TMP/o3.json" "$TMP/r9.json"
chk "反解结果缓存换顺序前后输出确实不同（这一条测得到东西）" \
    "$(jq -S -c . "$TMP/r9.json" | cmp -s - "$TMP/r9.json" && echo 没变 || echo 变了)" "变了"
corrupt 样本缓存只换了键顺序 'jq -S . "$(SC)" > "$TMP/sc.tmp" && mv "$TMP/sc.tmp" "$(SC)"'

# 缓存目录不可写（XDG_CACHE_HOME 指到一个普通文件）：结果照旧，只是每次都全量
: > "$TMP/notadir"
for k in 1 2; do
    : > "$TMP/cz.json.log"
    env "${run_env[@]}" XDG_CACHE_HOME="$TMP/notadir" PROBE_LOG="$TMP/cz.json.log" \
        python3 "$NEW/weekly-report/price_solve.py" --table > "$TMP/cz.json"
    env "${run_env[@]}" XDG_CACHE_HOME="$TMP/notadir" \
        python3 "$NEW/weekly-report/price_solve.py" --table --no-cache > "$TMP/rz.json"
    same "缓存目录不可写（第 $k 次）：一致" "$TMP/cz.json" "$TMP/rz.json"
    chk "缓存目录不可写（第 $k 次）：每次都全量" "$(opens "$TMP/cz.json")" "$((NFILES - 1))"
done

# 运维文档里的全量重扫命令：两份文档写的是同一条，在只有 HOME / PATH 的环境里原样跑
docs_cmd() { grep -o '`python3 scripts/weekly-report/price_solve.py --table --no-cache`' "$1" | head -1 | tr -d '`'; }
CMD_EN=$(docs_cmd "$REPO_DIR/docs/operations.md"); CMD_ZH=$(docs_cmd "$REPO_DIR/docs/operations.zh.md")
chk "两份运维文档写的是同一条全量重扫命令" "$([ -n "$CMD_EN" ] && [ "$CMD_EN" = "$CMD_ZH" ] && echo same)" "same"
(cd "$REPO_DIR" && env -i HOME="$TMP/home" PATH="$PATH" XDG_CACHE_HOME="$TMP/cache" bash -c "$CMD_EN") > "$TMP/doc.json"
same "文档里的全量重扫命令原样跑：结果等于全量" "$TMP/doc.json" "$TMP/r9.json"
# 文档说「删掉这两个文件，下一次也会全量重读」
rm -f "$(SC)" "$TMP/cache/cavil-loop/price-table.json"
tbl "$TMP/c13.json"
same "删掉两份缓存：一致" "$TMP/c13.json" "$TMP/r9.json"
chk "删掉两份缓存：下一次全量重读" "$(opens "$TMP/c13.json")" "$((NFILES - 1))"

echo "── 2. footer：Claude 一侧只取一次价目表 ──"
CFG="$TMP/cfg"; : > "$CFG"
NOW=$((START + 600))
STS=$(date -d "@$START" '+%Y-%m-%d %H:%M:%S')
# foot <脚本目录> <worktree> <输出文件> [env…]：真实 footer + 真实 claude.sh，时钟钉住
foot() {
    local s="$1" wt="$2" out="$3"; shift 3
    : > "$out.log"; rm -f "$out.log.failed-once"
    (cd "$wt" && env "${run_env[@]}" XDG_CACHE_HOME="$TMP/fcache" FOOTER_TEST_NOW="$NOW" PROBE_LOG="$out.log" "$@" \
        bash "$s/drivers/token-usage/comment-footer.sh" --agent claude \
        --driver "$s/drivers/token-usage/claude.sh" --config "$CFG" --start "$STS" --wt 7) > "$out"
}
runs() { grep -c '^run$' "$1.log"; }
kvof() { tail -1 "$1"; }
humanof() { grep -- '- token 明细：' "$1"; }

foot "$NEW" "$WT" "$TMP/f1.txt"
chk "正常：整条 footer 价目表只算 1 次" "$(runs "$TMP/f1.txt")" "1"
chk "正常：机器记录带金额与 AI 时间" \
    "$(kvof "$TMP/f1.txt" | grep -o 'cost_state=[a-z]*' ) $(kvof "$TMP/f1.txt" | grep -c 'ai_secs=')" "cost_state=full 1"
chk "正常：参照价兜底的模型也在里面（haiku 本机无样本）" \
    "$(kvof "$TMP/f1.txt" | grep -o 'models=[^ ]*')" "models=claude-haiku-4-5,claude-opus-5"
# --both 与分两次单独调用：同一份日志，两行逐字节一致
(cd "$WT" && env "${run_env[@]}" XDG_CACHE_HOME="$TMP/fcache" FOOTER_TEST_NOW="$NOW" \
    bash "$NEW/drivers/token-usage/claude.sh" "$START" --both) > "$TMP/both.txt"
{ (cd "$WT" && env "${run_env[@]}" XDG_CACHE_HOME="$TMP/fcache" FOOTER_TEST_NOW="$NOW" \
    bash "$NEW/drivers/token-usage/claude.sh" "$START")
  (cd "$WT" && env "${run_env[@]}" XDG_CACHE_HOME="$TMP/fcache" FOOTER_TEST_NOW="$NOW" \
    bash "$NEW/drivers/token-usage/claude.sh" "$START" --kv); } > "$TMP/sep.txt"
same "一次输出两行 = 分别单独调用的两行" "$TMP/both.txt" "$TMP/sep.txt"
chk "一次输出两行：恰好两行" "$(wc -l < "$TMP/both.txt")" "2"

foot "$NEW" "$WT2" "$TMP/f2.txt"
chk "无价：cost_state=none，人读行写单价未知" \
    "$(kvof "$TMP/f2.txt" | grep -o 'cost_state=[a-z]*') $(humanof "$TMP/f2.txt" | grep -c '单价未知')" "cost_state=none 1"
chk "无价：价目表只算 1 次" "$(runs "$TMP/f2.txt")" "1"

foot "$NEW" "$WT" "$TMP/f3.txt" PROBE_SOLVER_FAIL=all
chk "取表无输出：价目表只算 1 次" "$(runs "$TMP/f3.txt")" "1"
chk "取表无输出：两行同口径（都按空表：未计价）" \
    "$(kvof "$TMP/f3.txt" | grep -o 'cost_state=[a-z]*') $(humanof "$TMP/f3.txt" | grep -c '单价未知')" "cost_state=none 1"

foot "$NEW" "$WT" "$TMP/f4.txt" PROBE_SOLVER_FAIL=first
chk "第一次取表失败：新路径只取一次" "$(runs "$TMP/f4.txt")" "1"
chk "第一次取表失败：两行同口径" \
    "$(kvof "$TMP/f4.txt" | grep -o 'cost_state=[a-z]*') $(humanof "$TMP/f4.txt" | grep -c '单价未知')" "cost_state=none 1"

foot "$NEW" "$WT3" "$TMP/f5.txt"
chk "本 worktree 没有会话：不取价目表" "$(runs "$TMP/f5.txt")" "0"
chk "本 worktree 没有会话：footer 写用量未知" "$(grep -c '^- token 明细：未知' "$TMP/f5.txt")" "1"

if [ "$CMP_OLD" = 1 ]; then
    for c in "f1 $WT" "f2 $WT2" "f3 $WT PROBE_SOLVER_FAIL=all" "f5 $WT3"; do
        set -- $c; n="$1" wt="$2"; shift 2
        foot "$OLD" "$wt" "$TMP/o-$n.txt" "$@"
        same "与合并基点的 footer 逐字节一致（$n ${*:-正常}）" "$TMP/$n.txt" "$TMP/o-$n.txt"
    done
    chk "合并基点的 footer 价目表算 2 次（对照）" "$(runs "$TMP/o-f1.txt")" "2"
    foot "$OLD" "$WT" "$TMP/o-f4.txt" PROBE_SOLVER_FAIL=first
    chk "合并基点：第一次失败、第二次成功时两行口径不同（这次修掉的情形）" \
        "$(kvof "$TMP/o-f4.txt" | grep -o 'cost_state=[a-z]*') $(humanof "$TMP/o-f4.txt" | grep -c '单价未知')" \
        "cost_state=full 1"
fi

# 驱动给出半份结果：两行一起算未知，只调 1 次
FAKE="$TMP/fake-driver.sh"
cat > "$FAKE" <<'SH'
#!/usr/bin/env bash
echo "${2:-human}" >> "$FAKE_CALLS"
[ "${2:-}" = --ci-wait ] && exit 0      # 远端 CI 那一段不取价，这里不关心
case "$FAKE_MODE" in
    one)  echo "1 input, 2 output, 0 cache read, 0 cache write (\$0.01)（模型：m）" ;;
    rc)   printf 'h\nin=1 out=2 cache_r=0 cache_w=0 cost_state=none\n'; exit 3 ;;
    none) : ;;
    two)  case "${2:-}" in
              --both) printf 'H-LINE\nin=1 out=2 cache_r=0 cache_w=0 cost_state=none\n' ;;
              --kv) echo "in=1 out=2 cache_r=0 cache_w=0 cost_state=none" ;;
              *) echo "H-LINE" ;;
          esac ;;
esac
SH
ffoot() { # 模式 agent 输出文件
    : > "$3.calls"
    (cd "$WT" && env HOME="$TMP/home" FOOTER_TEST_NOW="$NOW" PYTHONPATH="$PROBE" FAKE_MODE="$1" FAKE_CALLS="$3.calls" \
        bash "$NEW/drivers/token-usage/comment-footer.sh" --agent "$2" --driver "$FAKE" --config "$CFG" \
        --start "$STS" --wt 7) > "$3"
}
ffoot none claude "$TMP/g0.txt"
for m in one rc; do
    ffoot "$m" claude "$TMP/g-$m.txt"
    chk "驱动给出半份结果（$m）：只调用 1 次用量" "$(grep -vc -- '--ci-wait' "$TMP/g-$m.txt.calls")" "1"
    same "驱动给出半份结果（$m）：两行一起当未知，与没有输出时相同" "$TMP/g-$m.txt" "$TMP/g0.txt"
done
ffoot two claude "$TMP/g-two.txt"
chk "Claude 一侧用 --both 调一次" "$(grep -v -- '--ci-wait' "$TMP/g-two.txt.calls" | tr '\n' ' ')" "--both "
chk "Claude 一侧两行都用上了" "$(grep -c 'H-LINE' "$TMP/g-two.txt") $(tail -1 "$TMP/g-two.txt" | grep -c 'cost_state=none')" "1 1"
ffoot two codex "$TMP/g-codex.txt"
chk "Codex 一侧照旧分两次调用" "$(grep -v -- '--ci-wait' "$TMP/g-codex.txt.calls" | tr '\n' ' ')" "human --kv "
if [ "$CMP_OLD" = 1 ]; then
    : > "$TMP/g-codex-old.txt.calls"
    (cd "$WT" && env HOME="$TMP/home" FOOTER_TEST_NOW="$NOW" PYTHONPATH="$PROBE" FAKE_MODE=two FAKE_CALLS="$TMP/g-codex-old.txt.calls" \
        bash "$OLD/drivers/token-usage/comment-footer.sh" --agent codex --driver "$FAKE" --config "$CFG" \
        --start "$STS" --wt 7) > "$TMP/g-codex-old.txt"
    same "Codex 一侧 footer 与合并基点逐字节一致" "$TMP/g-codex.txt" "$TMP/g-codex-old.txt"
fi

echo
compat_summary
echo "结果：$pass passed, $fail failed"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
