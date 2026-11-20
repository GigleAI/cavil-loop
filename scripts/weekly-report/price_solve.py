#!/usr/bin/env python3
"""从本机 CLI 记账反解每个模型的逐项单价，并给出每项的可信状态（GigleTutor-Web#934）。

为什么不是一张手工维护的价目表（issue #934 已确认 Q3=C）：
原来 `scripts/drivers/token-usage/claude.sh` 硬编了一张表，表过期了没人发现——实测那张表
的 Opus 档是当前标价的 **3 倍**，算出来的金额比 CLI 自记高 193%，而且这个错不会报错、
只会让数字悄悄变大。改成运行时反解 + 两道检验，调价时能自己发现。

**两件事必须分开，缺一不可**：

  ① 数值稳定性闸门 —— 只回答「这个系数被这批数据钉得住吗」。
     判据（逐项、两条都过才算稳定）：
       · 观测噪声放大 = 扰动**右端项 b** 后该系数的相对变化 ÷ b 的相对扰动，≤ MAX_AMPLIFY
       · Bootstrap 相对标准差 ≤ MAX_SPREAD
     **不能用的判据**（都踩过）：
       · 整列缩放灵敏度 —— 整列乘 s 只是重参数化，解会正好除以 s、拟合值不变，
         放大倍数恒为 1，跟病态与否无关。
       · 拟合残差 —— 实测残差 0.4% 时 input 仍偏 76%。
       · 列 token 占比、条件数 —— 只作解释与提示，实测真实数据 κ 只有 9 却仍有项不稳定。

  ② 外部参照交叉核对 —— 准确性只能靠它。稳定性**测不出系统性计数误差**：
     合成反例（真实 input=$5/output=$25、观测把 output 记少一半）解出 output=$50、偏 100%，
     却两条闸门全过、残差为零。同类风险真实存在（用量少算是 #935 的主题）。

每项单价因此落到四态之一：
    corroborated    稳定 且 与参照相对偏差 ≤ MAX_DIVERGE          → 用反解值
    uncorroborated  稳定 但没有可比参照（含参照为 0 / 缺失）      → 用反解值，算**候选估算**
    disputed        稳定 但与参照偏差 > MAX_DIVERGE               → 报红；取值按 policy
    unstable        过不了闸门 / 无解 / 非有限值                   → 取值按 policy
    fetched         同 unstable，但兜底用的参照是 daemon 缺价时**联网抓来的**
                    （内置参照里没有这个模型，GitHub#51）           → 取值按 policy
    disputed_fetched 同 disputed，但冲突的那份参照是**联网抓来的**   → 报红；取值按 policy
                    （单独一态：既不能丢掉冲突警示，也不能丢掉「这个价是自动抓的」）

取值策略（issue #934 的 Q7，人工已确认 A）：
    A（默认）：disputed 用参照值；unstable 有参照用参照值、**没有参照就是未知**。
    B：只有 corroborated 出价，其余三态一律未知。
两个策略都**不改变**「以本机反解为主」这一点，参照只承担兜底与交叉核对。

⚠️ 阈值都是**操作阈值，不是真实误差保证**。标定依据见各常量旁的注释。
⚠️ 「与参照一致」只说明**和这份参照一致**，不等于已证明为真值——参照本身可能过期，
   那样两边会一起错，这套机制发现不了。所以报告要带上参照的来源与缓存日期。

用法：
    python3 price_solve.py --table          # 输出给 driver 用的 JSON 价目表
    python3 price_solve.py --report         # 人读：逐项状态与闸门指标
    python3 price_solve.py --table --policy B
    python3 price_solve.py --table --no-cache   # 不读也不写缓存，全量重扫（缓存见 load_samples_cached）
    环境变量 CLAUDE_PROJECTS_DIR 可覆盖 transcript 目录（测试用）。
"""
import argparse, datetime, hashlib, json, glob, math, os, random, statistics, sys

# ── 阈值（可配置；标定依据写在旁边，别改成拍脑袋的数）────────────────────────
MAX_AMPLIFY = float(os.environ.get("PRICE_MAX_AMPLIFY", "5"))
# 标定：本机实测 cache_read / cache_write 的放大倍数 1.07×（真实偏离 0.8% / 1.5%），
# output 6.8×（偏 7.9%）、input 411×（偏 76.5%）。5 落在 1.07 与 6.8 之间。
MAX_SPREAD = float(os.environ.get("PRICE_MAX_SPREAD", "0.05"))
# 标定：同一批数据 cache 两项 bootstrap 相对标准差 0.4% / 0.5%，input 160%。
MAX_DIVERGE = float(os.environ.get("PRICE_MAX_DIVERGE", "0.10"))
# 标定：本机已观测到的正常偏差 ≤ 1.5%（modelUsage 只给 cache 写入合计等口径差），
# 而真实价目故障量级大得多——「表过期」这次是 200%，参照表里最小的代际档位差也有 33%
# （Sonnet 4.6 $3 → Sonnet 5 $2）。10% 落在两者之间且远离两侧。
MIN_SESSIONS = int(os.environ.get("PRICE_MIN_SESSIONS", "8"))
BOOTSTRAP_N = int(os.environ.get("PRICE_BOOTSTRAP_N", "200"))
NOISE = float(os.environ.get("PRICE_NOISE", "0.001"))
SEED = int(os.environ.get("PRICE_SEED", "7"))

ITEMS = ("input", "output", "cache_read", "cache_write")

# ── 外部参照（只作兜底 + 交叉核对，不是真值）──────────────────────────────
# 来源：Anthropic 官方价目页的 Model pricing / Prompt caching / Fast mode pricing 三节，
# 2026-09-29 联网逐项核对整张表（GigleTutor-Web#982），2026-10-19 再核一遍（GitHub#66）：
# 改 Sonnet 5.5 的缓存读取倍率，补现行单一价格的 Mythos 5.1 / Mythos 5 / Opus 4.5 / Sonnet 4.5；
# 带日期的编号取自官方各型号页（4.5 一代的 CLI 记账用的是它，不是短名）。
# **故意不收**：Haiku 5.5（单次请求输入超 10 万 token 整次按高档价，一个模型一套价表达不了，
# 只放低档会把长请求悄悄算便宜）；官方标了 retired 的旧型号。这张表本身**运行时不联网**，官方调价后
# 要人来改这里——信号是周报出现 disputed。表里**没有**的新模型由 daemon 在缺价时自动联网补
# （GitHub#51，drivers/token-usage/price_fetch.py：官方页与 LiteLLM 一致才用），补来的价
# 存在本机缓存、只补缺不覆盖，可信状态单独记 fetched。
# 倍率：cache 写 5m 1.25×、1h 2×（全部型号一致）；cache 读**因型号而异**，默认 0.1×，
# Opus 5.5 / Sonnet 5.5 是 0.05×、Fable 5.1 / Mythos 5.1 是 0.025×——原来一律按 0.1× 推，
# Fable 5.1 被多算了 4 倍；9-29 那次补了 Opus 5.5 却漏了 Sonnet 5.5，又多算了 1 倍（GitHub#66）。
# 快速档：官方写明缓存倍率叠加在快速价之上，所以快速档与标准档用同一个读取倍率。
REFERENCE_SOURCE = "platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-19"
def _ref(inp, out, cache_read_mult=0.1):
    return dict(input=inp, output=out, cache_read=inp * cache_read_mult,
                cache_write_5m=inp * 1.25, cache_write_1h=inp * 2.0)
REFERENCE = {
    "claude-opus-5-5":   _ref(4, 20, cache_read_mult=0.05),
    "claude-opus-5":     _ref(5, 25),
    "claude-opus-4-8":   _ref(5, 25),
    "claude-opus-4-7":   _ref(5, 25),
    "claude-opus-4-6":   _ref(5, 25),
    "claude-opus-4-5":   _ref(5, 25),
    "claude-opus-4-5-20251101": _ref(5, 25),
    "claude-sonnet-5-5": _ref(2, 10, cache_read_mult=0.05),
    "claude-sonnet-5":   _ref(2, 10),
    "claude-sonnet-4-6": _ref(3, 15),
    "claude-sonnet-4-5": _ref(3, 15),
    "claude-sonnet-4-5-20250929": _ref(3, 15),
    "claude-haiku-4-5":  _ref(1, 5),
    "claude-haiku-4-5-20251001": _ref(1, 5),
    "claude-fable-5":    _ref(10, 50),
    "claude-fable-5-1":  _ref(10, 50, cache_read_mult=0.025),
    "claude-mythos-5":   _ref(10, 50),
    "claude-mythos-5-1": _ref(10, 50, cache_read_mult=0.025),
}
# 快速模式是同一模型的另一档价，本机 0 条流量、无法反解，只能用参照。
REFERENCE_FAST = {
    "claude-opus-5-5": _ref(8, 40, cache_read_mult=0.05),
    "claude-opus-5":   _ref(10, 50),
    "claude-opus-4-8": _ref(10, 50),
}


def cache_dir():
    d = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(d, "cavil-loop")


def fetched_path():
    """缺价时 daemon 联网抓来的单价（GitHub#51，见 drivers/token-usage/price_fetch.py）。"""
    return os.path.join(cache_dir(), "fetched-prices.json")


def load_fetched():
    """{"claude": {model: {"prices": {...}, ...}}, "codex": {...}}；没有或坏掉 → {}。"""
    try:
        with open(fetched_path(), encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def codex_price_table():
    """codex 那一侧的单价表，取价顺序与 drivers/token-usage/codex.sh 一致：
    · 部署者配了 CODEX_PRICES → 只用它（`{}` 表示关闭估价），来源记 configured；
    · 否则内置 codex-prices.json，再用缺价自动补抓来的价补**内置表里没有的**模型，来源记 default；
    · 旧的三个变量 CODEX_PRICE_{IN,CACHED_IN,OUT}_PER_M 齐全时，当成所有模型同价的兜底（键 `*`），
      来源记 configured，且不补抓来的价。
    返回 {"models": {model: {"in":…, "cached_in":…, "out":…, ["cache_write":…]}},
          "fetched": 用的是抓来的价的模型集合, "source": "default" | "configured",
          "checked": 内置表的核对日期（仅 default）, "stale": 内置表是否已超过 90 天未复核}。
    来源、核对日期、过期标记都要跟着**补算实际采用的这张表**走，不能沿用旧记录里的——
    旧记录写评论时根本没取到价。"""
    env = os.environ.get("CODEX_PRICES")
    legacy = [os.environ.get(k) for k in
              ("CODEX_PRICE_IN_PER_M", "CODEX_PRICE_CACHED_IN_PER_M", "CODEX_PRICE_OUT_PER_M")]
    fetched_models, source, checked, stale = set(), "configured", None, False
    if env is not None:
        try:
            table = json.loads(env)
        except Exception:
            table = {}
        table = table if isinstance(table, dict) else {}
    elif all(legacy):
        table = {}
    else:
        source = "default"
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "drivers", "token-usage", "codex-prices.json")
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            built = doc.get("models") or {}
            checked = doc.get("checked_at")
        except Exception:
            built = {}
        if checked:
            try:
                age = datetime.date.today() - datetime.date.fromisoformat(checked)
                stale = age.days > 90
            except ValueError:
                stale = False
        fetched = {m: e["prices"] for m, e in (load_fetched().get("codex") or {}).items()
                   if isinstance(e, dict) and isinstance(e.get("prices"), dict)}
        fetched_models = {m for m in fetched if m not in built}
        table = {**fetched, **built}          # 同名时内置覆盖抓来的
    if all(legacy):
        try:
            table = {**table, "*": {"in": float(legacy[0]), "cached_in": float(legacy[1]),
                                    "out": float(legacy[2])}}
        except ValueError:
            pass
    return {"models": table, "fetched": fetched_models, "source": source,
            "checked": checked, "stale": stale}


def codex_reprice(rec, pt):
    """没写金额的 codex 记录按记录里的 token 补算，规则与 drivers/token-usage/codex.sh 逐项一致。

    返回 None（不补算，记录保持「没有金额」）或
    {"cost", "cost_state", "unknown_tokens", "price_status", "price_source", "price_stale"}。

    · **模型归属必须完整**：只有一个模型、且没有 `model_unknown=yes`。记录里的四项 token 是全部
      调用的累计值；另有认不出模型的调用时，拆不出哪部分属于那个已知模型，套一个价就是把
      未知模型的用量算到已知模型头上（#59 交叉 review 第 1 轮）。
    · **逐项计价**：有价的项计金额，没价的项把 token 计进 unknown_tokens，状态落 partial ——
      抓来的价只收两个来源都列出的项，缺缓存读取价是合法的，不能因此整条放弃（同上）。
      判「算出过价」只认**有用量又有价**的项；一项都没算出来就不补算（返回 None）。
    · **可信度桶跟着实际用的价走**：用的是抓来的价，金额记进 `fetched` 桶，与驱动的机器记录同口径；
      内置或部署者配置的价不出桶，采集侧照旧归到「说不出可信度」。
    · 记录里的 `in` 已是**未命中缓存**的输入（驱动写的是 input − cached），不能再减一次。"""
    models = rec.get("models") or []
    if len(models) != 1 or rec.get("model_unknown"):
        return None
    m = models[0]
    table = pt.get("models") or {}
    p = table.get(m)
    from_model = isinstance(p, dict)
    if not from_model:
        p = table.get("*")
    if not isinstance(p, dict):
        return None
    t = rec.get("tokens") or {}
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    items = [(t.get("in") or 0, num(p.get("in"))), (t.get("cache_r") or 0, num(p.get("cached_in"))),
             (t.get("out") or 0, num(p.get("out"))), (t.get("cache_w") or 0, num(p.get("cache_write")))]
    usd, unk, known = 0.0, 0, 0
    for v, price in items:
        if price is None:
            unk += v
        else:
            usd += v * price / 1e6
            if v > 0:
                known += 1
    if unk == 0:
        state = "full"
    elif known:
        state = "partial"
    else:
        return None                         # 实际用量一项都算不出价：仍是「没有金额」
    fetched = from_model and m in (pt.get("fetched") or set())
    status = {"fetched": usd} if fetched and known and usd > 0 else {}
    return {"cost": usd, "cost_state": state, "unknown_tokens": unk, "price_status": status,
            "price_source": pt.get("source"),
            "price_stale": bool(pt.get("stale")) and pt.get("source") == "default"}


def fetched_reference():
    """claude 那一侧抓来的单价，形状同 REFERENCE。**内置参照里已有的模型一律不取**——
    抓来的价只补缺，从不覆盖人工核对过的那张表。"""
    out = {}
    for model, entry in (load_fetched().get("claude") or {}).items():
        prices = (entry or {}).get("prices") if isinstance(entry, dict) else None
        if model in REFERENCE or not isinstance(prices, dict):
            continue
        clean = {k: float(v) for k, v in prices.items()
                 if isinstance(v, (int, float)) and not isinstance(v, bool)
                 and math.isfinite(v) and v >= 0}
        if clean:
            out[model] = clean
    return out


def norm_model(m):
    """CLI 记账键带 [1m] 这类后缀，用量记录里的 message.model 没有。实测两者单价相同。"""
    return (m or "").split("[")[0]


def _solve(A, b):
    """正规方程 + 全选主元高斯消元。奇异或出现非有限值时返回 None。"""
    m = len(A[0])
    M = [[sum(A[k][i] * A[k][j] for k in range(len(A))) for j in range(m)]
         + [sum(A[k][i] * b[k] for k in range(len(A)))] for i in range(m)]
    for i in range(m):
        p = max(range(i, m), key=lambda r: abs(M[r][i]))
        M[i], M[p] = M[p], M[i]
        if abs(M[i][i]) < 1e-300:
            return None
        for r in range(m):
            if r != i:
                f = M[r][i] / M[i][i]
                for c in range(i, m + 1):
                    M[r][c] -= f * M[i][c]
    x = [M[i][m] / M[i][i] for i in range(m)]
    return None if any(not math.isfinite(v) for v in x) else x


def projects_base(projects_dir=None):
    return projects_dir or os.environ.get("CLAUDE_PROJECTS_DIR") \
        or os.path.expanduser("~/.claude/projects")


def _log_files(base):
    """全部会话日志，**按 glob 返回的顺序**。样本顺序决定 bootstrap 抽到哪些下标（固定种子），
    所以增量路径也必须按这个顺序拼样本，否则同一批日志会解出不同的数（GitHub#606）。"""
    return glob.glob(os.path.join(base, "*", "*.jsonl"))


def _extract(fh):
    """一个文件能给出的全部计价原料：最后一条带 modelUsage 的 cost-state 总账 + 本文件
    assistant 记录里 5m / 1h 缓存写入的累计。只留后面用得到的字段，按原值保存（不舍入）。
    过滤（单模型、金额门槛）不在这里做：缓存的是原料，规则只在 _accumulate 一处。"""
    last = None
    w5 = w1 = 0
    for line in fh:
        if '"cost-state"' not in line and '"assistant"' not in line:
            continue
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        t = r.get("type")
        if t == "cost-state" and r.get("modelUsage"):
            last = r
        elif t == "assistant":
            cc = ((r.get("message") or {}).get("usage") or {}).get("cache_creation") or {}
            w5 += cc.get("ephemeral_5m_input_tokens") or 0
            w1 += cc.get("ephemeral_1h_input_tokens") or 0
    if last is not None:
        last = {"modelUsage": last["modelUsage"], "totalCostUSD": last.get("totalCostUSD")}
    return {"last": last, "w5": w5, "w1": w1}


def _accumulate(rows, ttl, raw):
    """把一个文件的原料并进样本。全量与增量两条路径共用这一份规则。"""
    last = raw["last"]
    if not last or len(last["modelUsage"]) != 1:
        return
    cost = last.get("totalCostUSD") or 0
    if cost < 0.05:          # 太小的会话噪声占比过大，进方程只添乱
        return
    key, mu = list(last["modelUsage"].items())[0]
    key = norm_model(key)
    rows.setdefault(key, []).append((
        mu.get("inputTokens", 0) / 1e6, mu.get("outputTokens", 0) / 1e6,
        mu.get("cacheReadInputTokens", 0) / 1e6, mu.get("cacheCreationInputTokens", 0) / 1e6,
        cost))
    d = ttl.setdefault(key, {"w5": 0, "w1": 0})
    d["w5"] += raw["w5"]
    d["w1"] += raw["w1"]


def load_samples(projects_dir=None):
    """{model: [(input, output, cache_read, cache_write, costUSD), ...]}，只收单模型会话。

    多模型会话的 totalCostUSD 拆不回每个模型，收进来只会污染方程组。
    另外统计每个模型本机 cache 写入的 5m / 1h 构成，用来判断两档能不能分开。
    这是全量路径（--no-cache）：每个文件都读一遍。
    """
    rows, ttl = {}, {}
    for f in _log_files(projects_base(projects_dir)):
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            raw = _extract(fh)
        _accumulate(rows, ttl, raw)
    return rows, ttl


# ── 计价样本按文件缓存（GitHub#606）──────────────────────────────────────────
# 原来每次取表都把全部会话日志读一遍（本机 1,660 个文件 / 7.3 GB，约 25 秒），而判断
# 「能不能用旧表」的目录指纹（文件数 + 最新 mtime + 总字节数）在有 agent 写日志时隔几秒
# 就变，缓存几乎从不命中。现在逐文件缓存「这个文件读出的原料」，只重读变过的文件。
#
# 对号身份是五项：设备、inode、大小、mtime_ns、ctime_ns，全等才复用。ctime 是关键：等长
# 改写后再用 os.utime 恢复 mtime，大小 / mtime / inode 都不变，只有 ctime 变（本机实测）。
# 读之前 stat、读完对同一个打开的文件 fstat，两次不同 = 读的时候还在写：这次照常用读到的
# 原料（与全量扫描读到的一样），但不进缓存，下次重读。
#
# 不加有效期、不改成「只认已结束会话」：已写过总账的文件后面还会追加缓存写入记录，原料
# 照样会变（issue #606）。
#
# ⚠️ 「热缓存结果与全量重扫一致」的边界：日志只通过正常的写入、追加、替换、删除变化。
#   系统时钟回拨到原值、再等长改写文件这种情况不覆盖——那时用 --no-cache。
#
# 缓存坏掉（读不出、不是 JSON、结构不对）、程序版本或日志目录不是这次的，一律整份作废
# 重读；写不进去只影响下一次，不影响这一次的结果。
SAMPLE_CACHE_FORMAT = 2


def code_rev():
    """本文件内容的哈希：改了取样或反解的代码，旧缓存就不算数，不靠人记得升版本号。"""
    try:
        with open(os.path.abspath(__file__), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:16]
    except OSError:
        return "unknown"


def _ident(st):
    return [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def sample_cache_path(base):
    key = hashlib.sha256(os.path.abspath(base).encode("utf-8", "surrogateescape")).hexdigest()[:16]
    return os.path.join(cache_dir(), f"price-samples-{key}.json")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# _accumulate 从单模型总账里取的四个用量字段：缓存里的值必须是 _accumulate 吃得下的，
# 否则一份坏缓存会让求解器崩溃（PR #612 复审第 1 轮）。缺省照旧按 0 算，与全量扫描一致。
USAGE_KEYS = ("inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")


def _valid_raw(raw):
    """一个文件的原料是否完整、且 _accumulate 要用的每个值类型都对。

    只查 _accumulate 真正读的东西：多模型总账在那里直接跳过，它的内容不查。"""
    if not isinstance(raw, dict) or set(raw) != {"last", "w5", "w1"}:
        return False
    if not (_num(raw["w5"]) and _num(raw["w1"])):
        return False
    last = raw["last"]
    if last is None:
        return True
    if not (isinstance(last, dict) and set(last) == {"modelUsage", "totalCostUSD"}
            and isinstance(last["modelUsage"], dict) and last["modelUsage"]):
        return False
    if len(last["modelUsage"]) != 1:
        return True
    mu = next(iter(last["modelUsage"].values()))
    cost = last["totalCostUSD"]
    return (isinstance(mu, dict) and (cost is None or _num(cost))
            and all(_num(mu[k]) for k in USAGE_KEYS if k in mu))


def _content_sum(obj):
    """缓存内容的校验和：读回时重算，对不上就整份当作没有。结构检查只能查出认得的坏法，
    这一道查的是「和写进去的不是同一份」（PR #612 复审第 1 轮：两种结构损坏都绕过了检查）。"""
    blob = json.dumps(obj, sort_keys=True, ensure_ascii=False, allow_nan=True)
    return hashlib.sha256(blob.encode("utf-8", "surrogatepass")).hexdigest()


def _load_sample_cache(path, base, rev):
    """整份缓存：合格就返回 {文件: {"id": [...], "raw": {...}}}，任何一处不对都返回 {}。"""
    try:
        with open(path, encoding="utf-8") as f:
            c = json.load(f)
    except Exception:
        return {}
    if not (isinstance(c, dict) and c.get("format") == SAMPLE_CACHE_FORMAT
            and c.get("code") == rev and c.get("base") == os.path.abspath(base)
            and isinstance(c.get("files"), dict)):
        return {}
    files = c["files"]
    try:
        if c.get("sum") != _content_sum(files):
            return {}
    except (TypeError, ValueError):
        return {}
    for k, e in files.items():
        if not (isinstance(e, dict) and set(e) == {"id", "raw"}
                and isinstance(e["id"], list) and len(e["id"]) == 5
                and all(isinstance(x, int) and not isinstance(x, bool) for x in e["id"])
                and _valid_raw(e["raw"])):
            return {}
    return files


def _write_json_atomic(path, obj):
    """临时文件（带进程号，几个 worker 同时写互不踩）+ 原子改名。写不进去静默放弃：
    缓存只决定下一次要不要重读，不影响这一次的结果。"""
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def load_samples_cached(projects_dir=None):
    """同 load_samples()，但只读上次之后变过的文件。结果与全量扫描逐项一致（顺序也一致）。"""
    base = projects_base(projects_dir)
    rev = code_rev()
    path = sample_cache_path(base)
    old = _load_sample_cache(path, base, rev)
    new = {}
    rows, ttl = {}, {}
    for f in _log_files(base):
        try:
            st = os.stat(f)
        except OSError:
            st = None
        e = old.get(f)
        if st is not None and e is not None and e["id"] == _ident(st):
            raw = e["raw"]
            new[f] = e
        else:
            try:
                fh = open(f, encoding="utf-8", errors="replace")
            except OSError:
                continue
            with fh:
                raw = _extract(fh)
                try:
                    after = os.fstat(fh.fileno())
                except OSError:
                    after = None
            if st is not None and after is not None and _ident(after) == _ident(st):
                new[f] = {"id": _ident(st), "raw": raw}
        _accumulate(rows, ttl, raw)
    if new != old:
        _write_json_atomic(path, {"format": SAMPLE_CACHE_FORMAT, "code": rev,
                                  "base": os.path.abspath(base), "files": new,
                                  "sum": _content_sum(new)})
    return rows, ttl


def gate(samples):
    """逐项跑①数值稳定性闸门。返回 {item: {...metrics, stable}}；样本不够时全判不稳定。"""
    n = len(samples)
    out = {it: {"price": None, "amplify": None, "spread": None, "stable": False,
                "share": None, "n": n} for it in ITEMS}
    if n < MIN_SESSIONS:
        for it in ITEMS:
            out[it]["reason"] = f"样本不足（{n} < {MIN_SESSIONS}）"
        return out, None
    A = [list(r[:4]) for r in samples]
    b = [r[4] for r in samples]
    x0 = _solve(A, b)
    if x0 is None:
        for it in ITEMS:
            out[it]["reason"] = "方程组奇异或解非有限值"
        return out, None
    total = sum(sum(r) for r in A) or 1.0
    rnd = random.Random(SEED)
    amps = [[] for _ in ITEMS]
    for _ in range(BOOTSTRAP_N):                       # ② 扰动右端项 b（不是列）
        x = _solve(A, [v * (1 + rnd.gauss(0, NOISE)) for v in b])
        if x is None:
            continue
        for j in range(len(ITEMS)):
            if abs(x0[j]) > 1e-12:
                amps[j].append(abs(x[j] - x0[j]) / abs(x0[j]) / NOISE)
    boots = [[] for _ in ITEMS]
    for _ in range(BOOTSTRAP_N):                       # ③ bootstrap 重采样
        idx = [rnd.randrange(n) for _ in range(n)]
        x = _solve([A[i] for i in idx], [b[i] for i in idx])
        if x is None:
            continue
        for j in range(len(ITEMS)):
            boots[j].append(x[j])
    for j, it in enumerate(ITEMS):
        amp = statistics.median(amps[j]) if amps[j] else float("inf")
        spread = (statistics.pstdev(boots[j]) / abs(x0[j])
                  if boots[j] and abs(x0[j]) > 1e-12 else float("inf"))
        col = sum(r[j] for r in A)
        out[it].update(price=x0[j], amplify=amp, spread=spread, share=col / total,
                       stable=(math.isfinite(amp) and math.isfinite(spread)
                               and amp <= MAX_AMPLIFY and spread <= MAX_SPREAD
                               and x0[j] > 0))
        if not out[it]["stable"]:
            out[it]["reason"] = f"放大 {amp:.2f}× / 离散 {spread * 100:.1f}%"
    return out, x0


def classify(model, gated, ttl, policy="A", fetched=None):
    """②外部参照交叉核对 → 四态 + 最终取值。cache 写入按本机 5m/1h 构成拆成两档。

    内置参照里没有、但 daemon 联网抓到过价的模型（GitHub#51），用抓来的价当参照。
    这时「解不出、用参照兜底」的那一档不叫 unstable 而叫 **fetched**：兜底用的不是
    人工核对过的表，而是自动抓的公开价目，报告必须能把两者分开。"""
    fetched = fetched_reference() if fetched is None else fetched
    from_fetch = model not in REFERENCE and model in fetched
    ref = REFERENCE.get(model) or fetched.get(model) or {}
    res = {}

    def decide(item, solved, stable, ref_price, note=""):
        rel = None
        if not stable:
            status = "unstable"
        elif ref_price is None or ref_price == 0:
            status = "uncorroborated"       # 有解但无从核对（含参照为 0 / 缺失）
        else:
            rel = abs(solved - ref_price) / ref_price
            status = "corroborated" if rel <= MAX_DIVERGE else "disputed"
        if status == "corroborated" or status == "uncorroborated":
            price = solved
        elif status == "disputed":
            price = ref_price if policy == "A" else None
        else:                                # unstable：A 有参照才兜底，没有就是未知
            # ⚠️ 判「有没有参照」用 is not None：$0 是合法的已知单价（抓来的缓存项可以是 0），
            #   拿真假判断会把它当成「没参照」→ 这部分 token 变成缺价（PR #55 复审第 1 轮）
            price = ref_price if (policy == "A" and ref_price is not None) else None
        # 兜底取的是抓来的价 → 状态要带上来源。冲突那一态单独叫 disputed_fetched：
        # 只标 fetched 会丢掉冲突警示，只标 disputed 会丢掉「这是自动抓的价」（复审第 1 轮）
        if from_fetch and price is not None and status in ("unstable", "disputed"):
            status = "fetched" if status == "unstable" else "disputed_fetched"
        return {"status": status, "price": price, "solved": solved,
                "reference": ref_price, "divergence": rel, "note": note}

    for it in ("input", "output", "cache_read"):
        g = gated[it]
        res[it] = decide(it, g["price"], g["stable"], ref.get(it), g.get("reason", ""))
        res[it]["metrics"] = {k: g[k] for k in ("amplify", "spread", "share", "n")}

    # cache 写入：CLI 记账只给合计。本机某一档恒为 0 时另一档才可解；两档都非零就分不开。
    g = gated["cache_write"]
    w5, w1 = ttl.get("w5", 0), ttl.get("w1", 0)
    both = w5 > 0 and w1 > 0
    for tier, mine in (("cache_write_5m", w5), ("cache_write_1h", w1)):
        stable = g["stable"] and not both and mine > 0
        r = decide(tier, g["price"], stable, ref.get(tier),
                   "两档都有用量，合计里分不开" if both else g.get("reason", ""))
        r["metrics"] = {k: g[k] for k in ("amplify", "spread", "share", "n")}
        res[tier] = r
    return res


def build(policy="A", projects_dir=None):
    """全量：每个日志文件都读一遍再反解（--no-cache 走这里）。"""
    rows, ttl = load_samples(projects_dir)
    return solve_table(rows, ttl, policy, fetched_reference())


def solve_table(rows, ttl, policy, fetched):
    """样本 → 价目表。全量与带缓存两条路径共用。"""
    table = {}
    for model, samples in sorted(rows.items()):
        gated, _ = gate(samples)
        table[model] = classify(model, gated, ttl.get(model, {}), policy, fetched)
    # 本机没跑过的模型：没有反解依据，按 policy 决定是否用参照兜底。
    # 抓来的价同样只在 policy=A 时兜底，状态记 fetched（见 classify）。
    for model, ref, st in ([(m, r, "unstable") for m, r in sorted(REFERENCE.items())]
                           + [(m, r, "fetched") for m, r in sorted(fetched.items())]):
        if model in table:
            continue
        table[model] = {it: {"status": st, "price": (ref[it] if policy == "A" else None),
                             "solved": None, "reference": ref[it], "divergence": None,
                             "note": "本机无该模型流量", "metrics": {}}
                        for it in ref}
    return {"policy": policy, "reference_source": REFERENCE_SOURCE,
            "thresholds": {"max_amplify": MAX_AMPLIFY, "max_spread": MAX_SPREAD,
                           "max_diverge": MAX_DIVERGE, "min_sessions": MIN_SESSIONS},
            "fast": {m: v for m, v in REFERENCE_FAST.items()},
            "models": table}


def cache_path():
    return os.path.join(cache_dir(), "price-table.json")


def solve_fingerprint(rows, ttl, policy, fetched, rev=None):
    """反解的全部输入：样本（含顺序）、5m/1h 构成、参照、抓来的价、取值策略、阈值与抽样参数、
    程序版本。这些都没变，反解结果就一定相同，可以直接复用（GitHub#606）。

    原来的判据是日志目录的「文件数 + 最新 mtime + 总字节数」：有 agent 在写日志时隔几秒
    就变，可表本身没变；而阈值、抽样参数这些环境变量改了，判据却不变。"""
    blob = json.dumps([rev or code_rev(), policy, rows, ttl,
                       REFERENCE_SOURCE, REFERENCE, REFERENCE_FAST, fetched,
                       [MAX_AMPLIFY, MAX_SPREAD, MAX_DIVERGE, MIN_SESSIONS,
                        BOOTSTRAP_N, NOISE, SEED]],
                      sort_keys=True, allow_nan=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def build_cached(policy="A", projects_dir=None):
    """带缓存的 build()：样本按文件增量读（load_samples_cached），反解按输入指纹复用。
    缓存坏掉一律当没有，不让它挡路；结果与 build() 逐字节一致。"""
    rows, ttl = load_samples_cached(projects_dir)
    fetched = fetched_reference()
    sig = solve_fingerprint(rows, ttl, policy, fetched)
    path = cache_path()
    try:
        with open(path, encoding="utf-8") as f:
            c = json.load(f)
        t = c.get("table")
        if (c.get("signature") == sig and _valid_table(t, policy)
                and c.get("sum") == _content_sum(t)):
            return t
    except Exception:
        pass
    table = solve_table(rows, ttl, policy, fetched)
    _write_json_atomic(path, {"signature": sig, "table": table, "sum": _content_sum(table)})
    return table


def _valid_table(t, policy):
    """价目表有 solve_table() 产出的那几层：--report / --table 和两个驱动读的就是这些。"""
    if not (isinstance(t, dict)
            and set(t) == {"policy", "reference_source", "thresholds", "fast", "models"}
            and t["policy"] == policy and isinstance(t["reference_source"], str)
            and isinstance(t["thresholds"], dict) and isinstance(t["fast"], dict)
            and isinstance(t["models"], dict)):
        return False
    return all(isinstance(items, dict) and all(isinstance(v, dict) and "status" in v and "price" in v
                                               for v in items.values())
               for items in t["models"].values())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--table", action="store_true", help="输出 JSON 价目表（给 driver）")
    ap.add_argument("--report", action="store_true", help="人读的逐项状态")
    ap.add_argument("--no-cache", action="store_true", help="跳过缓存，强制重算")
    ap.add_argument("--policy", default=os.environ.get("PRICE_POLICY", "A"), choices=["A", "B"])
    a = ap.parse_args()
    t = build(a.policy) if a.no_cache else build_cached(a.policy)
    if a.report or not a.table:
        print(f"参照来源：{t['reference_source']}")
        print(f"阈值：{t['thresholds']}  ·  取值策略 {t['policy']}\n")
        for model, items in t["models"].items():
            solved_any = any(v.get("solved") is not None for v in items.values())
            if not solved_any and not a.report:
                continue
            print(f"{model}")
            for it, v in items.items():
                m = v.get("metrics") or {}
                amp = f"{m['amplify']:.2f}×" if m.get("amplify") is not None else "—"
                sp = f"{m['spread'] * 100:.1f}%" if m.get("spread") is not None else "—"
                dv = f"{v['divergence'] * 100:.1f}%" if v.get("divergence") is not None else "—"
                pr = f"${v['price']:.4f}" if v.get("price") is not None else "未知"
                print(f"  {it:<16} {v['status']:<15} 取值 {pr:<10} 放大 {amp:<9} 离散 {sp:<8} 与参照差 {dv}")
            print()
    if a.table:
        json.dump(t, sys.stdout, ensure_ascii=False)
        print()


if __name__ == "__main__":
    main()
