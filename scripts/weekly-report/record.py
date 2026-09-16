#!/usr/bin/env python3
"""从一条 GitHub 评论里提取「一次派工的记账记录」。

为什么要单独一个模块（GigleTutor-Web#931）：
原来的做法是拿正则在**整条评论正文**上扫「耗时」和「金额」，这会出两类错：

  · 正文里描述别的东西也会被当成记账。实测「某测试耗时 5054ms」被读成 `5054m`
    = 5054 分钟 = 84 小时；而 `200ms` → 3.33 小时、`83ms` → 1.38 小时，这些都
    低于当时那个 4 小时剔除阈值，**直接混进统计**。金额正则还会命中正文里的
    SQL 片段 `pg_blocking_pids($1)`，被读成 $1.00。
  · 同一次派工发多条评论时，每条都带同一份记账行，逐条累加 = 重复计。
    10 周实测 12 组、18 条重复，多算 5.19 小时 / $774。

所以改成：**只认评论末尾那条机器写的记录**，再按「派工身份」去重。

能保证什么、不能保证什么：
  能 —— 同一个派工窗口不会被重复入账；每条记录的来源与异常状态显性可查。
  不能 —— 历史评论是自由文本，一条评论里贴的记账行到底是它自己的、还是引用
          别处的，**判不出来**。去重能消掉「引用了真实窗口」那一类（它必然与
          原记录同窗口），但消不掉「凭空贴了个不对应任何记录的示例」。这一点
          如实写进报告，不用启发式假装解决。
"""
import re, datetime

import attribute

TZ = datetime.timezone(datetime.timedelta(hours=8))

# 机器可读记录：必须是整条评论的**最后一个非空行**
RE_MARK = re.compile(r'^<!--\s*agent-metrics\s+(.*?)-->$')

# 历史记账行的三种排版（逐条比对 10 周 5,223 条评论得出）：
#   ① ⏱️ 开始 <日期 时刻> · 完工 <时刻> · 耗时 …
#   ② 折叠块 + 代码块里以「开始」打头（⏱️ 在 <summary> 行上）
#   ③ 完工带完整日期（跨零点场景）
_TS = r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2})'
RE_FOOT = re.compile(r'^(?:⏱️\s*)?开始\s+' + _TS + r'\s*·\s*完工\s+' + _TS + r'\s*·\s*耗时\s*\S')
RE_HEAD = re.compile(r'^(?:⏱️\s*)?开始\s+' + _TS + r'\s*·\s*完工\s+' + _TS)
RE_TOKEN_LINE = re.compile(r'^token\s')
RE_COST = re.compile(r'\(\$([\d.]+)\)')
# 历史记账行的 token 数只从**紧随其后那一行**里读（`token 44 input, 1k output ($16.64)`），
# 绝不扫正文：正文里随手写的 `token … output` 示例会被原样累加进统计（实测正文一句
# 「示例：token 1 input, 999k output」就把这条记录的输出从 1.2k 抬到 100 万）。
RE_OUT = re.compile(r'token .*?([\d.]+)([km]?)\s*output')
_MUL = {"": 1, "k": 1e3, "m": 1e6}


def _out_of(token_line):
    """从一行 token 行里取输出 token 数。拿不到返回 0。"""
    return int(sum(float(m.group(1)) * _MUL[m.group(2)] for m in RE_OUT.finditer(token_line)))

# 只用于**披露**的界限：墙上时长 ≥ 这个值的记录在报告里逐条列出。
# 它只决定列不列，**不影响任何统计数字**，也不判断这条记录是不是「卡住了」。
# 取 4 小时是沿用历史上那个剔除阈值的数值，方便和旧报告对照。
LONG_WINDOW_SECS = 4 * 3600


def norm_wt(v):
    """把 worktree 编号归一成同一种类型（字符串），再进派工身份。

    为什么必须归一（GitHub#932 review 第 2 轮）：机器标记里的 `wt` 是从文本解析出来的
    **字符串**，而缺 `wt` 时回落用的 `default_wt` 是采集器传进来的**整数** issue 编号。
    两者直接进 key 就成了 `('931', start)` != `(931, start)`——同一次派工的两条评论
    （一条带显式 wt、一条走回落，或历史可见记账行与新机器记录混在一起）会各记一次，
    前半段被重复累加。实测这种混合场景会得出 1800 秒 / $30 而不是 1200 秒 / $20。
    """
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def is_bot(login):
    """机器人账号：约定后缀 `-bot`（worker）或 GitHub App 的 `[bot]`。"""
    return login.endswith("-bot") or login.endswith("[bot]")


def _parse_ts(v, date_hint=None):
    v = v.strip()
    if len(v) > 8:
        return datetime.datetime.strptime(v, "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)
    return datetime.datetime.strptime(f"{date_hint} {v}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)


def _footer_window(lines):
    """从可见记账行取 (开始, 完工, 紧随其后的第一个非空行)。取不到返回 (None, None, '')。"""
    hits = [i for i, l in enumerate(lines) if RE_FOOT.match(l.strip())]
    if not hits:
        return None, None, ""
    # 取**最后一处**：实测 10 周内 0 条评论存在两处真记账行，所以这不会丢数据；
    # 而正文里的示例总在真记录之前。
    idx = hits[-1]
    nxt = next((lines[j].strip() for j in range(idx + 1, len(lines)) if lines[j].strip()), "")
    h = RE_HEAD.match(lines[idx].strip())
    try:
        a = _parse_ts(h.group(1))
        b = _parse_ts(h.group(2), a.strftime("%Y-%m-%d"))
        if b < a:                      # 完工 < 开始 ⇒ 跨零点
            b += datetime.timedelta(days=1)
    except Exception:
        return None, None, ""
    return a, b, nxt


def extract(body, login, comment_id=None, default_wt=None):
    """提取一条记账记录；这条评论不是记账来源时返回 None。

    返回 dict：
      src      'marker'（新评论的机器记录）/ 'footer'（历史评论的记账行）
      ident    身份来源：marker / marker+footer / marker-noid / footer
      wt       worktree 编号（拿不到则 default_wt）
      start,end  派工窗口
      wall     墙上时长（秒）= 完工 − 开始
      cost     金额（美元）—— 按调用去重后、**逐条按自己模型的单价**折算出来的参考价值。
               单价来自本机 CLI 记账反解 + 官方公开价目交叉核对（见 price_solve.py），
               **不是账单**：本机是包月订阅，没有按 token 出的账单可对。
      tokens   四项 token（in / out / cache_r / cache_w）。采集侧拿它跟从日志重算的结果
               逐项比，只带 out 的话「只丢了 input」这类缺失检验不出来。
      tokens_exact  历史记录的 token 是 driver 的 fmt **floor 截断**过的（53.5k ⇒ ≥53500），
               这里拿到的是**下界**不是精确值，比对时要按下界判。
      cost_state   价格覆盖三态：full / partial（有模型没单价，金额必定偏低）/ none
      price_source 单价出处：solved（本机反解）/ default（内置 API 参考价）/
                   configured（部署者人工配置）
      price_status 金额按**单价可信度**拆开，{corroborated/uncorroborated/disputed/
               unstable/reference_only: 美元}。与 cost_state 是两回事：cost_state 说
               「有没有价」，这个说「这个价站不站得住」
      has_cost 这条记录**有没有写金额**。`cost=0` 有两种来源：驱动没配单价所以根本没写，
               和配了单价但估算不足半美分、如实写成 `0.00`。两者必须分开，否则报告会把
               后者说成「该侧未配单价」
      out      输出 token 数 —— 只从本条记录自己那一行读，不扫正文
      agent    'claude' / 'codex' / None
    """
    lines = body.splitlines()
    ne = [l.strip() for l in lines if l.strip()]
    if not ne:
        return None

    # ⓪ 来源资格：只有机器人写的评论才可能是记账来源。**两种格式都要过这一关**。
    # 原来这一条只挡历史格式，机器记录那一支在检查作者之前就返回了（GitHub#932
    # review 第 3 轮）：维护者在讨论里复制一行机器记录当例子、又恰好是评论的最后一个
    # 非空行时，就凭空多出一次派工；它的 `end` 还可能比真记录晚，于是在同一身份下
    # 把真实那条**顶掉**（见 pick_latest）。
    # 注意：交叉 review 评论的排除只能留在历史格式那一支，不能提到这里 —— 改造后
    # review 模板会正常写机器记录，那一侧的开销要照常入账。
    if not is_bot(login):
        return None

    # ① 机器记录：必须是最后一个非空行。正文里任何位置出现的同形内容一律忽略。
    m = RE_MARK.match(ne[-1])
    if m:
        kv = dict(p.split('=', 1) for p in m.group(1).split() if '=' in p)

        def _iso(v):
            try:
                return datetime.datetime.fromisoformat(v)
            except Exception:
                return None

        st, en = _iso(kv.get("start", "")), _iso(kv.get("end", ""))
        ident = "marker"
        if st is None or en is None:
            # 身份缺失 → 回落到同一条评论里的可见记账行（派工模板两者都会写）
            st, en, _ = _footer_window(lines)
            ident = "marker+footer"
            if st is None or en is None:
                # 仍拿不到 → 以自己的评论 id 作唯一身份，**不与任何记录合并**
                st = en = ("noid", comment_id)
                ident = "marker-noid"
        try:
            wall = int(kv.get("wall_secs", 0))
        except ValueError:
            wall = 0
        if not wall and isinstance(st, datetime.datetime):
            wall = int((en - st).total_seconds())
        # 「有没有金额」和「金额是不是 0」是两回事（GitHub#932 交叉 review）：
        # 驱动没配单价时**根本不写** `cost_usd`；配了单价、但这段估算不足半美分时，
        # 会如实写出 `cost_usd=0.00`。只看数值非零，后者会被当成「没采到金额」，
        # 报告于是白纸黑字写「该侧未配单价」——事实相反。所以把「有没有」单独带出去。
        raw_cost = kv.get("cost_usd")
        has_cost = False
        cost = 0.0
        if raw_cost is not None:
            try:
                cost = float(raw_cost)
                has_cost = True
            except ValueError:
                pass                     # 写了但读不出来 → 当作没有，别猜
        def _int(key):
            try:
                return int(float(kv.get(key, 0)))
            except ValueError:
                return 0
        out = _int("out")
        # 四项 token 都带出去：采集侧要拿它们跟从日志重算的结果逐项比（GitHub#934）。
        # 只带 out 的话，「只丢了 input」「只丢了 cache 写入」这两类缺失检验不出来。
        tokens = {"in": _int("in"), "out": out,
                  "cache_r": _int("cache_r"), "cache_w": _int("cache_w")}
        # 价格覆盖三态：full 全有单价 / partial 有一部分模型没单价（金额必定偏低）/
        # none 一条都算不出。老格式没有这个字段，按 has_cost 推。
        cost_state = kv.get("cost_state") or ("full" if has_cost else "none")
        return {"src": "marker", "ident": ident, "agent": kv.get("agent"),
                "wt": norm_wt(kv.get("wt")) or norm_wt(default_wt), "start": st, "end": en,
                "wall": wall, "cost": cost, "has_cost": has_cost, "out": out,
                "tokens": tokens, "tokens_exact": True, "cost_state": cost_state,
                "cost_unknown_tokens": _int("cost_unknown_tokens"),
                "price_source": kv.get("price_source"),
                "price_stale": kv.get("price_stale") == "yes",
                "price_status": _price_status(kv.get("price_status"))}

    # ② 历史评论（无机器记录）：连同上面那条作者判定一共四步，任何一步不满足
    #    就不作为记账来源
    if body.lstrip().startswith("<!-- codex-review-round"):
        return None                      # 该阶段交叉 review 不写记账行
    a, b, nxt = _footer_window(lines)
    if a is None:
        return None
    if not RE_TOKEN_LINE.match(nxt):
        return None                      # 记账行之后必须紧跟 token 行
    # 历史记账行同理：`token … ($0.00)` 是「记了，是 0」，整行没有 `($…)` 才是「没记」。
    costs = [float(x.group(1)) for x in RE_COST.finditer(nxt)]
    # 历史 token 行是 driver 的 fmt **floor 截断**过的（53.5k ⇒ x ≥ 53500），
    # 所以这里拿到的是**截断下界**，不是精确值；采集侧比对时要按下界判，
    # 按四舍五入假设（53450）会放过真实缺失。tokens_exact=False 标明这一点。
    return {"src": "footer", "ident": "footer", "agent": None,
            "wt": norm_wt(default_wt), "start": a, "end": b,
            "wall": int((b - a).total_seconds()),
            "cost": sum(costs), "has_cost": bool(costs),
            "out": _out_of(nxt),
            "tokens": attribute.parse_token_line(nxt), "tokens_exact": False,
            "cost_state": ("full" if costs else "none"), "cost_unknown_tokens": 0,
            # 历史评论是老驱动那张**过期价目表**算出来的（实测高 193%），既没有可信度
            # 也没有出处可言 —— 留空，报告里按「来源不明」披露，不硬塞进四态里充数
            "price_source": None, "price_status": {}}


def _price_status(raw):
    """`corroborated:41.20,disputed:2.16` → {状态: 美元}。解析不了的整条丢弃，不瞎猜。"""
    out = {}
    for part in (raw or "").split(","):
        st, _, amt = part.partition(":")
        st = st.strip()
        if not st or not amt:
            continue
        try:
            out[st] = out.get(st, 0.0) + float(amt)
        except ValueError:
            continue
    return out


def dispatch_key(rec):
    """一次派工的身份 —— **不含 end**。

    为什么不能把 end 放进身份里：记账行里的 `wall_secs` / 金额 / token 都是
    **从这次派工开始时刻起的累计值**，而 `end` 是「写这条评论的时刻」。同一次派工
    发多条评论时（先在 issue 回一条、稍后在关联 PR 再回一条，或先发验证再发收尾），
    start 相同、end 各不相同，若 end 进了身份就成了不同的派工，前半段会被再加一遍。

    实测：同一派工两条评论 `wall_secs=600/cost=10` 与 `wall_secs=1200/cost=20`，
    带 end 的身份会得出 1800 秒 / $30，而正确答案是 1200 秒 / $20。

    所以身份只取 (worktree, 开始时刻)，同一身份**取 end 最大的那条**——它才是这次
    派工的最终累计值。**不能保留最早那条**，那会漏掉后半段。见 `pick_latest`。
    """
    return (norm_wt(rec.get("wt")), rec["start"])


def pick_latest(cur, new):
    """同一派工身份下选该留哪条：end 更晚的那条（累计值更完整）。

    end 可能是「身份缺失」时兜底的 ('noid', 评论 id) 元组，那种身份本来就唯一、
    不会撞键；两边不是同类时保守保留已有的那条，不做跨类型比较。
    """
    if cur is None:
        return new
    a, b = cur.get("end"), new.get("end")
    if isinstance(a, datetime.datetime) and isinstance(b, datetime.datetime):
        return new if b > a else cur
    return cur
