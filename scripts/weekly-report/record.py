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

# 只用于**披露**的界限：墙上时长 ≥ 这个值的记录在报告里逐条列出。
# 它只决定列不列，**不影响任何统计数字**，也不判断这条记录是不是「卡住了」。
# 取 4 小时是沿用历史上那个剔除阈值的数值，方便和旧报告对照。
LONG_WINDOW_SECS = 4 * 3600


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
      cost     金额（美元）—— 按调用去重后的**标价估算**，计价偏差尚未核实
      agent    'claude' / 'codex' / None
    """
    lines = body.splitlines()
    ne = [l.strip() for l in lines if l.strip()]
    if not ne:
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
        try:
            cost = float(kv.get("cost_usd", 0))
        except ValueError:
            cost = 0.0
        return {"src": "marker", "ident": ident, "agent": kv.get("agent"),
                "wt": kv.get("wt") or default_wt, "start": st, "end": en,
                "wall": wall, "cost": cost}

    # ② 历史评论（无机器记录）：四步判定，任何一步不满足就不作为记账来源
    if not is_bot(login):
        return None                      # 人发的评论里出现的记账行只会是引用
    if body.lstrip().startswith("<!-- codex-review-round"):
        return None                      # 该阶段交叉 review 不写记账行
    a, b, nxt = _footer_window(lines)
    if a is None:
        return None
    if not RE_TOKEN_LINE.match(nxt):
        return None                      # 记账行之后必须紧跟 token 行
    return {"src": "footer", "ident": "footer", "agent": None,
            "wt": default_wt, "start": a, "end": b,
            "wall": int((b - a).total_seconds()),
            "cost": sum(float(x.group(1)) for x in RE_COST.finditer(nxt))}


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
    return (rec.get("wt"), rec["start"])


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
