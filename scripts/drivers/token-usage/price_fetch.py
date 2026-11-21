#!/usr/bin/env python3
"""缺价自动抓价（GitHub#51）：计价驱动发现「某模型有用量却没有单价」→ daemon 联网补上。

流程：
  ① 两个计价驱动（claude.sh / codex.sh）发现缺价模型时，在本机缓存目录的
     `unpriced/` 下留一个空标记文件 `<agent>--<model>`（驱动跑在 worker 里，
     worker 不许访问 github.com 以外的地址，所以它只留标记、不联网）。
  ② daemon 每轮看到有标记，就调本脚本：对每个到期的模型，抓**两个独立来源**——
     官方价目页（markdown 版）+ LiteLLM 社区价目表（GitHub 上的 JSON）——
     **两边一致才用**（issue #51 已确认 Q1=A），写进 `fetched-prices.json`。
  ③ 两个驱动读这份缓存，**只补内置表里没有的模型**，从不覆盖已有单价。

为什么一定要两个来源（而不是读到就用）：官方页是给人看的页面，排版一改就可能读错列；
LiteLLM 是第三方，可能抄错或晚收录。一个看起来正常、其实错了的金额比「金额未计」更糟——
没人会去怀疑它。两边一致才用，任何一边读错都会被另一边拦下。

抓来的数一律当**不可信数据**：
  · 每项必须是有限的非负数、每百万 token 不超过 MAX_PRICE；input / output 必须 > 0
  · 结构必须合理：output ≥ input、缓存读 ≤ input
  · 模型名精确匹配（官方页「Claude Opus 5.5」按固定规则转成 claude-opus-5-5）；
    同一个名字在官方页出现多行（例如按上下文长度分档的模型）视为有歧义，不用
  · 两边都有的项偏差必须 ≤ MAX_DIVERGE（沿用 price_solve 的交叉核对阈值）；
    任何一项对不上，整个模型都不用——那说明至少有一边读错了
  · 只有一边有的项不采用（该项照旧计入缺价），input / output 两边都必须有

失败的模型冷却 COOLDOWN 秒再试，不会每轮都去打外网；成功的模型删掉标记。

每日最新价（GitHub#606）：除了补缺，每天还把官方价目页上**全部** Claude 模型的价抓一遍，
写进 `latest-prices.json`。评论 footer 直接用它计价，不再从本机日志反推（维护者在 PR #612
定的：「不要反推，取最新的，缓存一天」）。这一步**只用官方页**，不拿 LiteLLM 对照（维护者在
PR #612：「使用当前的 api 返回的价格即可，不用再找别的」）；页面上的值仍要过上面的合理性校验、
五项齐全才收。上面「两个来源」的规则只管补缺。
成功后 LATEST_EVERY 秒（一天）内不再抓；下载失败冷却 COOLDOWN 秒再试，抓到却写不进缓存
WRITE_RETRY 秒后再试，旧文件都保留不动；连下次时刻也存不上时日志如实说下一轮会再抓。
一份都没抓到时 footer 用内置参照表。下次该抓的时刻写在 `latest-prices.next`（一个整数），
daemon 每轮只读这个数，没到时间不启动本脚本。
本脚本只往 stdout 打日志行（daemon 逐行转进 poll.log），退出码恒为 0——抓价失败
不能影响派工。

⚠️ 「两边一致」只说明**这两份公开资料彼此一致**，不等于与账单核对过。报告里它是
   独立的一档可信度 `fetched`，不和人工核对过的内置价混在一起。

用法：
    python3 price_fetch.py              # daemon 调用
    环境变量（测试与部署覆盖用）：
      PRICE_FETCH_ANTHROPIC_URL / PRICE_FETCH_OPENAI_URL / PRICE_FETCH_LITELLM_URL
      PRICE_FETCH_COOLDOWN_SECS（默认 21600 = 6 小时）
      PRICE_FETCH_TIMEOUT（单次请求秒数，默认 15）
      XDG_CACHE_HOME（缓存目录的父目录，同 price_solve）
"""
import datetime, fcntl, json, math, os, re, stat, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "weekly-report"))
import price_solve  # noqa: E402  内置参照表 + 缓存目录的单一来源

ANTHROPIC_URL = os.environ.get(
    "PRICE_FETCH_ANTHROPIC_URL", "https://platform.claude.com/docs/en/about-claude/pricing.md")
OPENAI_URL = os.environ.get(
    "PRICE_FETCH_OPENAI_URL", "https://developers.openai.com/api/docs/pricing.md")
LITELLM_URL = os.environ.get(
    "PRICE_FETCH_LITELLM_URL",
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json")
def _num(name, default, cast):
    """环境变量坏了就用默认值——抓价脚本不能因为一个配置笔误在 import 时就崩掉。"""
    try:
        v = cast(os.environ.get(name, default))
        return v if math.isfinite(v) and v >= 0 else cast(default)
    except ValueError:
        return cast(default)


COOLDOWN = _num("PRICE_FETCH_COOLDOWN_SECS", "21600", int)
LATEST_EVERY = _num("PRICE_LATEST_REFRESH_SECS", "86400", int)   # 最新价缓存一天（GitHub#606）
WRITE_RETRY = 600            # 抓到了价却写不进缓存时，多久后再试（PR #612 复审第 5 轮）
TIMEOUT = _num("PRICE_FETCH_TIMEOUT", "15", float) or 15.0
MAX_PRICE = price_solve.MAX_PRICE       # 美元 / 百万 token；现役最贵的档位也远低于它。读回时同一上限
MAX_DIVERGE = price_solve.MAX_DIVERGE   # 与反解那一侧的交叉核对用同一个阈值
MODEL_RE = re.compile(price_solve.MODEL_NAME_RE)
AGENTS = ("claude", "codex")

# 每一侧的计价项与必须有的两项：和读回缓存时核对的是同一张表（price_solve.FETCH_ITEMS /
# FETCH_CORE），写进去的和读出来认的永远一致。顺序即输出顺序。
# claude：键名与 price_solve.REFERENCE 一致；codex：键名与 codex-prices.json 一致。
ITEMS = price_solve.FETCH_ITEMS
CORE = price_solve.FETCH_CORE
LITELLM_KEYS = {
    "claude": {"input": "input_cost_per_token", "output": "output_cost_per_token",
               "cache_read": "cache_read_input_token_cost",
               "cache_write_5m": "cache_creation_input_token_cost",
               "cache_write_1h": "cache_creation_input_token_cost_above_1hr"},
    "codex": {"in": "input_cost_per_token", "out": "output_cost_per_token",
              "cached_in": "cache_read_input_token_cost",
              "cache_write": "cache_creation_input_token_cost"},
}


def log(msg):
    print(msg, flush=True)


# ── 路径 ─────────────────────────────────────────────────────────────────────
def marker_dir():
    return os.path.join(price_solve.cache_dir(), "unpriced")


def state_path():
    return os.path.join(price_solve.cache_dir(), "price-fetch-state.json")


def latest_due_path():
    """下次该抓最新价的时刻（epoch 整数）。daemon 的 price_fetch_tick 读同一个文件。"""
    return os.path.join(price_solve.cache_dir(), "latest-prices.next")


# 「下次时刻」文件合法的样子：不超过 64 字节，1–18 位数字，后面只跟换行。别的一律当作到时间。
# daemon 的 price_fetch_tick（_lib.sh）按同一条规则判断，两处对同一个文件必须给同一个答案
# （PR #612 复审第 1 轮：一边删掉中间空格读成未来时刻跳过，一边判到时，坏文件永远没人重写）。
DUE_RE = re.compile(rb"[0-9]{1,18}\n*")


def latest_due(now):
    """到时间了吗。文件没有、读不出、不合上面的格式 → 到了（宁可多抓一次，不要永远不抓）。"""
    # 不是普通文件（命名管道之类）也算到时：读它会一直等下去（PR #612 复审第 2 轮），
    # 钩子那边 `[ -f ]` 同样判到时；抓完写回的时刻文件会把它换成普通文件
    raw = price_solve.read_regular(latest_due_path(), limit=64)
    if raw is None or not DUE_RE.fullmatch(raw):
        return True
    return now >= int(raw.rstrip(b"\n"))


def _write_due(epoch):
    """写下次该抓的时刻。返回 None 表示写好了，否则是给日志用的一句话（PR #612 复审第 6 轮：
    以前吞掉失败，日志说「10 分钟后再试」，其实时刻没保存、下一轮立刻又抓，还留下临时文件）。
    时刻没保存时文件里还是旧值（或没有）→ 按 latest_due 的规则多半已到时，下一轮会再抓。"""
    try:
        _replace_file(latest_due_path(), f"{int(epoch)}\n")
    except Exception as e:
        return f"下次刷新时刻没能保存（{type(e).__name__}: {e}），下一轮会再抓"
    return None


def _when(secs):
    return f"{secs // 3600} 小时" if secs >= 3600 else f"{secs // 60} 分钟"


def _retry_note(due_err, secs):
    """日志里「什么时候再试」：时刻存上了才说过多久再试，没存上就如实说下一轮再抓。"""
    return due_err if due_err else f"{_when(secs)}后再试"


def _load_json(path, default):
    return price_solve.load_json_file(path, default)   # 不阻塞、有界、只认普通文件


STATE_TIME_MAX = 1e11        # 「上次尝试时刻」合法上限（约公元 5138 年）；超过的当作坏数据


def load_state():
    """抓价状态，读入时逐项核对（PR #612 复审第 4 轮：一个超大的尝试时刻让整轮抓价提前结束）。
    {"<agent>/<model>": {"last_attempt": 秒, "result": 文本}}：键不是字符串、项不是对象、时刻不是
    合法数的一律丢掉 —— 当作没试过，宁可多抓一次，不让一处坏数据挡住补价。"""
    out = {}
    for key, entry in _load_json(state_path(), {}).items():
        if not (isinstance(key, str) and isinstance(entry, dict)):
            continue
        last = price_solve.number_in(entry.get("last_attempt"), 0, STATE_TIME_MAX)
        if last is None:
            continue
        clean = {"last_attempt": last}
        if isinstance(entry.get("result"), str):
            clean["result"] = entry["result"]
        out[key] = clean
    return out


def _replace_file(path, text):
    """整份写到临时文件再换名——价格缓存、抓价状态、最新价、下次时刻都走这一处。
    失败就抛出（调用方据此不提交这一步），临时文件不留。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _save_json(path, obj):
    _replace_file(path, json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True))


def builtin_models(agent):
    if agent == "claude":
        return set(price_solve.REFERENCE)
    return set(_load_json(os.path.join(HERE, "codex-prices.json"), {}).get("models", {}))


def candidates(model):
    """精确名优先；带日期后缀的（claude-haiku-4-5-20251001）再试去掉日期的基名。"""
    out = [model.lower()]
    m = re.match(r"^(.*)-\d{8}$", out[0])
    if m:
        out.append(m.group(1))
    return out


# ── 下载（同一次运行里每个地址只下一次）──────────────────────────────────────
_cache = {}


def fetch(url):
    if url not in _cache:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cavil-loop-price-fetch"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                _cache[url] = (r.read().decode("utf-8", errors="replace"), None)
        except Exception as e:                         # 网络 / 证书 / 404 一律当「没拿到」
            _cache[url] = (None, f"{type(e).__name__}: {e}")
    return _cache[url]


# ── 解析 ─────────────────────────────────────────────────────────────────────
def _money(cell):
    """`$0.25 / MTok<sup>1</sup>` → 0.25；`-` / 空 / 解析不了 → None。"""
    cell = re.sub(r"<[^>]+>", "", cell or "")
    m = re.search(r"\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)", cell)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None


def _md_table_after(text, heading_re):
    """返回 heading 之后**第一张** markdown 表：(表头列表, [行列表])。找不到 → None。"""
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if re.match(heading_re, ln.strip()):
            start = i + 1
            break
    if start is None:
        return None
    rows = []
    for ln in lines[start:]:
        s = ln.strip()
        if s.startswith("#") and rows:
            break
        if not s.startswith("|"):
            if rows:
                break
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
            continue                                  # 分隔行
        rows.append(cells)
    if len(rows) < 2:
        return None
    return [h.lower() for h in rows[0]], rows[1:]


def _clean_name(cell):
    """去掉链接、上标、括号说明：`Claude Mythos 5 ([limited](…))` → `Claude Mythos 5`。"""
    s = re.sub(r"<[^>]+>", "", cell)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"\([^)]*\)", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _col(header, *needles):
    """表头里**同时**含所有 needles 的第一列；没有 → None。"""
    for i, h in enumerate(header):
        if all(n in h for n in needles):
            return i
    return None


def _rows_to_models(header, rows, colmap, name_to_id):
    """按列映射取数。同一个模型 ID 出现多行 → 有歧义，记为 None（不用）。"""
    out = {}
    for r in rows:
        if len(r) < len(header):
            continue
        mid = name_to_id(_clean_name(r[0]))
        if not mid:
            continue
        vals = {k: (_money(r[i]) if i is not None else None) for k, i in colmap.items()}
        out[mid] = None if mid in out else vals
    return out


def parse_anthropic(text):
    t = _md_table_after(text, r"^#+\s*Model pricing\s*$")
    if not t:
        return None
    header, rows = t
    colmap = {"input": _col(header, "base input"), "cache_write_5m": _col(header, "5m"),
              "cache_write_1h": _col(header, "1h"), "cache_read": _col(header, "cache hit"),
              "output": _col(header, "output")}
    if colmap["input"] is None or colmap["output"] is None:
        return None

    def name_to_id(n):
        # 官方页写显示名，模型 ID 是它的小写、空格和点都换成连字符：Claude Opus 5.5 → claude-opus-5-5
        if not re.fullmatch(r"Claude [A-Za-z]+ [0-9]+(?:\.[0-9]+)*", n):
            return None
        return n.lower().replace(" ", "-").replace(".", "-")
    return _rows_to_models(header, rows, colmap, name_to_id)


def parse_openai(text):
    t = _md_table_after(text, r"^#+\s*Standard pricing data\s*$")
    if not t:
        return None
    header, rows = t
    # 只取短上下文（标准档）那几列；长上下文列另有价，不混用
    colmap = {"in": _col(header, "short context input"),
              "cached_in": _col(header, "short context cached input"),
              "cache_write": _col(header, "short context cache write"),
              "out": _col(header, "short context output")}
    if colmap["in"] is None or colmap["out"] is None:
        return None

    def name_to_id(n):
        return n.lower() if MODEL_RE.match(n) else None
    return _rows_to_models(header, rows, colmap, name_to_id)


def parse_litellm(text, agent):
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    out = {}
    for key, entry in data.items():
        if not isinstance(entry, dict):
            continue
        vals = {}
        for item, field in LITELLM_KEYS[agent].items():
            v = entry.get(field)
            # 每 token 单价：同一个数值检查（超大整数 / 越界都算没有），再换算成每百万 token
            per = price_solve.number_in(v, 0, MAX_PRICE / 1e6)
            vals[item] = per * 1e6 if per is not None else None
        out[key.lower()] = vals
    return out


# ── 校验与比对 ────────────────────────────────────────────────────────────────
def sane(agent, vals):
    """单一来源自身是否站得住。返回 None 表示通过，否则是原因。"""
    a, b = CORE[agent]
    for k, v in vals.items():
        if v is None:
            continue
        if not math.isfinite(v) or v < 0 or v > MAX_PRICE:
            return f"{k}={v} 越界"
    if not vals.get(a) or not vals.get(b):
        return "缺 input / output"
    if vals[b] < vals[a]:
        return f"output({vals[b]}) < input({vals[a]})"
    cr = vals.get("cache_read" if agent == "claude" else "cached_in")
    if cr is not None and cr > vals[a]:
        return f"缓存读({cr}) > input({vals[a]})"
    return None


def reconcile(agent, official, community):
    """两边一致才用。返回 (单价 dict, None) 或 (None, 原因)。取官方页的值。"""
    for name, v in (("官方页", official), ("LiteLLM", community)):
        bad = sane(agent, v)
        if bad:
            return None, f"{name}数据不合理：{bad}"
    prices = {}
    for item in ITEMS[agent]:
        o, c = official.get(item), community.get(item)
        if o is None or c is None:
            continue                                   # 只有一边有：不采用，照旧缺价
        ref = max(abs(o), abs(c))
        if ref > 0 and abs(o - c) / ref > MAX_DIVERGE:
            return None, f"{item} 两边对不上（官方页 {o} / LiteLLM {c}）"
        prices[item] = o
    return prices, None


def lookup(table, model, exact=False):
    """返回 (值, 原因)。原因非空表示没找到或有歧义。exact=True 只认精确名，不退回基名。"""
    if table is None:
        return None, "解析不出价目表（页面可能改版）"
    for cand in ([model.lower()] if exact else candidates(model)):
        if cand in table:
            if table[cand] is None:
                return None, f"{cand} 在页面上有多行（分档），有歧义"
            return table[cand], None
    return None, "没有收录该模型"


def resolve(agent, model):
    official_url = ANTHROPIC_URL if agent == "claude" else OPENAI_URL
    parse = parse_anthropic if agent == "claude" else parse_openai
    o_text, o_err = fetch(official_url)
    if o_text is None:
        return None, f"官方页下载失败：{o_err}"
    c_text, c_err = fetch(LITELLM_URL)
    if c_text is None:
        return None, f"LiteLLM 下载失败：{c_err}"
    o, why = lookup(parse(o_text), model)
    if why:
        return None, f"官方页：{why}"
    # LiteLLM 按完整模型 ID 收录（含日期快照），所以这一侧**只认精确名**：官方页只写显示名、
    # 不得不按基名查，若 LiteLLM 也退回基名，两源核对的就都是基名的价，等于默认「日期快照
    # 与基名同价」——那是猜（PR #55 复审第 2 轮）。查不到就如实失败，冷却后再试。
    c, why = lookup(parse_litellm(c_text, agent), model, exact=True)
    if why:
        return None, f"LiteLLM：{why}"
    return reconcile(agent, o, c)


def refresh_latest(now):
    """抓官方价目页上全部 Claude 模型的最新价（GitHub#606）。只用官方页这一处的价，不再拿别的
    来源对照（维护者在 PR #612：「使用当前的 api 返回的价格即可，不用再找别的」）；页面上的值
    自身站得住（sane）、五项齐全的模型才收。一个都收不到算失败：旧的 latest-prices.json 不动，
    COOLDOWN 秒后再试。"""
    o_text, o_err = fetch(ANTHROPIC_URL)
    official = parse_anthropic(o_text) if o_text is not None else None
    why = (f"官方页下载失败：{o_err}" if o_text is None
           else "官方页解析不出价目表（页面可能改版）" if not official else None)
    ok, skipped = {}, []
    if why is None:
        for model, vals in official.items():
            bad = "有歧义" if vals is None else sane("claude", vals)
            prices = None if bad else {k: v for k, v in vals.items() if v is not None}
            if prices is not None and set(prices) != set(price_solve.LATEST_ITEMS):
                prices, bad = None, "缺项"
            if prices is None:
                skipped.append(f"{model}（{bad}）")
            else:
                ok[model] = prices
        if not ok:
            why = "没有一个模型的价站得住、五项齐全"
    if why:
        log(f"Claude 最新价目抓取失败，{_retry_note(_write_due(now + COOLDOWN), COOLDOWN)}"
            f"（评论 footer 继续用上次的价或内置价）：{why}")
        return
    try:
        _save_json(price_solve.latest_path(), {"claude": {
            "fetched_at": datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sources": [ANTHROPIC_URL], "models": ok}})
    except Exception as e:
        # 抓到了却没写进去：不算这一天已刷新，WRITE_RETRY 秒后再来（不是一天、也不是冷却期）
        log(f"Claude 最新价目已抓到但写不进缓存，{_retry_note(_write_due(now + WRITE_RETRY), WRITE_RETRY)}："
            f"{type(e).__name__}: {e}")
        return
    due_err = _write_due(now + LATEST_EVERY)
    log(f"已更新 Claude 最新价目：{len(ok)} 个模型"
        + (f"；未采用 {len(skipped)} 个：{'、'.join(skipped)}" if skipped else "")
        + (f"；{due_err}" if due_err else ""))


# ── 主流程 ────────────────────────────────────────────────────────────────────
def pending_markers():
    """[(agent, model, 标记路径)]。名字不合规的标记直接删掉（不是驱动写的）。"""
    d = marker_dir()
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return []
    out = []
    for n in names:
        p = os.path.join(d, n)
        agent, sep, model = n.partition("--")
        if not sep or agent not in AGENTS or not MODEL_RE.match(model):
            _rm(p)
            continue
        out.append((agent, model, p))
    return out


def _rm(p):
    try:
        os.remove(p)
    except OSError:
        pass


def main():
    if os.environ.get("PRICE_AUTO_FETCH", "1") in ("0", "false", "no", "off"):
        return
    now = time.time()
    markers = pending_markers()
    # daemon 只在调度器起的轮询里让本脚本做每日刷新（_lib.sh 的 price_fetch_tick 传 PRICE_FETCH_LATEST=off
    # 表示「这一轮只补缺」）；手动直接跑本脚本照旧两件都做
    latest_on = os.environ.get("PRICE_FETCH_LATEST", "on") not in ("0", "false", "no", "off")
    want_latest = latest_on and latest_due(now)
    if not markers and not want_latest:
        return
    os.makedirs(price_solve.cache_dir(), exist_ok=True)
    # 多个项目的 daemon 共用这份缓存：同一时刻只让一个在抓，其余这一轮直接跳过
    # 锁文件同样不阻塞地打开、只认普通文件：路径上若是命名管道，普通的 open(…, "w") 会一直等
    lock_path = os.path.join(price_solve.cache_dir(), "price-fetch.lock")
    try:
        fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0), 0o644)
    except OSError as e:
        log(f"抓价锁文件打不开，本轮跳过：{lock_path}：{e}")
        return
    lock = os.fdopen(fd, "w")
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        lock.close()
        log(f"抓价锁文件不是普通文件，本轮跳过：{lock_path}")
        return
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    # 拿到锁之后再看一次：别的项目的 daemon 可能刚抓完
    if latest_on and latest_due(now):
        # 每日刷新出了意外也只影响它自己，不挡住下面的补缺
        try:
            refresh_latest(now)
        except Exception as e:
            log(f"Claude 最新价目抓取异常（已忽略），{_retry_note(_write_due(now + COOLDOWN), COOLDOWN)}："
                f"{type(e).__name__}: {e}")
    fetched = price_solve.load_fetched()
    latest = price_solve.load_latest()
    state = load_state()
    changed = False
    for agent, model, path in markers:
        # 一个模型出了意外只影响它自己：记下来、留着标记，接着处理下一个
        try:
            changed = _fetch_one(agent, model, path, now, fetched, latest, state) or changed
        except Exception as e:
            log(f"{agent} 模型 {model} 抓价异常（已忽略，标记留着，下一轮再试）：{type(e).__name__}: {e}")
    if changed:
        _save_json(state_path(), state)


def _fetch_one(agent, model, path, now, fetched, latest, state):
    """补一个缺价标记。返回是否改了抓价状态。"""
    key = f"{agent}/{model}"
    # 「已经有价」用的是读入时已核对过的补抓价（price_solve.load_fetched）：取价丢掉的坏记录，
    # 这里也不算有价，标记留着、照常去抓（PR #612 复审第 3 轮）。
    # 「已经有价」必须和两个驱动取价用**同一个键**——它们只认精确模型名。拿去掉日期
    # 后缀的基名来判，会出现「缓存里有基名 → 删标记，驱动却仍取不到日期名的价」，
    # 之后每条 footer 留标记、每轮又被删，日期名永远补不上（PR #55 复审第 2 轮）。
    # 基名只用于在**价目来源**里查找（官方页只写显示名，没有日期），查到后两源核验，
    # 按驱动看到的实际模型名落缓存。
    if (model in builtin_models(agent) or model in fetched.get(agent, {})
            or (agent == "claude" and model in latest)):
        _rm(path)                                  # 已经有价：不抓，也不再提
        return False
    # 状态读入时已核对过（load_state）：在这里的时刻一定是合法的数
    last = (state.get(key) or {}).get("last_attempt")
    if last is not None and 0 <= now - last < COOLDOWN:
        return False                               # 冷却中
    prices, why = resolve(agent, model)
    if not prices:
        state[key] = {"last_attempt": now, "result": why}
        log(f"{agent} 模型 {model} 抓价失败，{COOLDOWN // 3600} 小时后再试：{why}")
        return True
    # 提交点是「价格缓存写进了磁盘」（PR #612 复审第 5 轮：写入失败后，内存里的价和 ok 状态被同轮
    # 另一个模型的状态保存带了出去，下一轮以为已补上、冷却 6 小时）。先在副本上写；写成功了才改
    # 共享的价格表和状态、删标记。写不进去就什么都不提交：不记这次尝试，标记留着，下一轮再来
    entry = {
        "prices": prices,
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": [ANTHROPIC_URL if agent == "claude" else OPENAI_URL, LITELLM_URL],
    }
    new = {a: dict(g) for a, g in fetched.items()}
    new.setdefault(agent, {})[model] = entry
    try:
        _save_json(price_solve.fetched_path(), new)
    except Exception as e:
        log(f"{agent} 模型 {model} 抓到了价但写不进缓存，标记留着，下一轮再试：{type(e).__name__}: {e}")
        return False
    fetched.setdefault(agent, {})[model] = entry
    state[key] = {"last_attempt": now, "result": "ok"}
    _rm(path)
    log(f"{agent} 模型 {model} 已自动补上单价（官方页与 LiteLLM 一致）："
        + ", ".join(f"{k}=${v:g}/M" for k, v in prices.items()))
    return True


if __name__ == "__main__":
    try:
        main()
    except Exception as e:                             # 抓价永远不许拖垮 daemon
        log(f"抓价异常（已忽略）：{type(e).__name__}: {e}")
