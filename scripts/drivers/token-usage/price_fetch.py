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
import datetime, fcntl, json, math, os, re, sys, time, urllib.request

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
TIMEOUT = _num("PRICE_FETCH_TIMEOUT", "15", float) or 15.0
MAX_PRICE = 1000.0                      # 美元 / 百万 token；现役最贵的档位也远低于它
MAX_DIVERGE = price_solve.MAX_DIVERGE   # 与反解那一侧的交叉核对用同一个阈值
MODEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
AGENTS = ("claude", "codex")

# 每一侧的计价项，以及它们在三个来源里叫什么。顺序即输出顺序。
# claude：键名与 price_solve.REFERENCE 一致；codex：键名与 codex-prices.json 一致。
ITEMS = {
    "claude": ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h"),
    "codex": ("in", "out", "cached_in", "cache_write"),
}
CORE = {"claude": ("input", "output"), "codex": ("in", "out")}
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


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else default
    except Exception:
        return default


def _save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, path)


# ── 已有单价：内置表里有的模型从不抓 ─────────────────────────────────────────
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
            vals[item] = v * 1e6 if isinstance(v, (int, float)) and not isinstance(v, bool) else None
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


def lookup(table, model):
    """返回 (值, 原因)。原因非空表示没找到或有歧义。"""
    if table is None:
        return None, "解析不出价目表（页面可能改版）"
    for cand in candidates(model):
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
    c, why = lookup(parse_litellm(c_text, agent), model)
    if why:
        return None, f"LiteLLM：{why}"
    return reconcile(agent, o, c)


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
    markers = pending_markers()
    if not markers:
        return
    os.makedirs(price_solve.cache_dir(), exist_ok=True)
    # 多个项目的 daemon 共用这份缓存：同一时刻只让一个在抓，其余这一轮直接跳过
    lock = open(os.path.join(price_solve.cache_dir(), "price-fetch.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    fetched = price_solve.load_fetched()
    state = _load_json(state_path(), {})
    now = time.time()
    changed = False
    for agent, model, path in markers:
        key = f"{agent}/{model}"
        known = fetched.get(agent, {})
        if model in builtin_models(agent) or any(c in known for c in candidates(model)):
            _rm(path)                                  # 已经有价：不抓，也不再提
            continue
        last = (state.get(key) or {}).get("last_attempt") or 0
        if isinstance(last, (int, float)) and 0 <= now - last < COOLDOWN:
            continue                                   # 冷却中
        prices, why = resolve(agent, model)
        state[key] = {"last_attempt": now, "result": "ok" if prices else why}
        changed = True
        if not prices:
            log(f"{agent} 模型 {model} 抓价失败，{COOLDOWN // 3600} 小时后再试：{why}")
            continue
        fetched.setdefault(agent, {})[model] = {
            "prices": prices,
            "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sources": [ANTHROPIC_URL if agent == "claude" else OPENAI_URL, LITELLM_URL],
        }
        _save_json(price_solve.fetched_path(), fetched)
        _rm(path)
        log(f"{agent} 模型 {model} 已自动补上单价（官方页与 LiteLLM 一致）："
            + ", ".join(f"{k}=${v:g}/M" for k, v in prices.items()))
    if changed:
        _save_json(state_path(), state)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:                             # 抓价永远不许拖垮 daemon
        log(f"抓价异常（已忽略）：{type(e).__name__}: {e}")
