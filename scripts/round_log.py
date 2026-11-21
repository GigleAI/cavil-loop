#!/usr/bin/env python3
"""往返记录（GitHub#610）：一段 agent ↔ agent 的来回只占一条评论，每次交付在末尾追加一节。

这里是**唯一**懂记录格式的地方。写入命令（round-log.sh post）、读取（round-log.sh show 和托管条目的
受保护读取命令）、复审轮次、周报（weekly-report/collect.py）、单 PR 耗时统计（pr-time-stats.py）都调同一个
拆单元函数 `units()`，不各写一份（硬规则 L3）。

一条往返记录长这样（只由 loop 写评论的账号写、只由它改；人在交人评论里回复）：

    <!-- cavil-round-log:v1 -->
    ……一段给人看的说明……
    <!-- cavil-round-log:top sec=<节编号> -->
    ……当前完整版本（这一节交付时的完整方案 / 完整交付说明）……
    <!-- cavil-round-log:top-end -->
    <!-- cavil-round-log:sec id=<节编号> role=worker|review at=<UTC 时间> after=<追加时评论区最新评论编号> of=<所审的节|-> -->
    ……这一节：改了什么、给下一个 agent 的交代、用量 footer……
    <!-- cavil-round-log:sec-end -->
    ……更多节……

拆单元：普通评论一条一个单元；往返记录每节一个单元，位置是「紧跟在它追加时评论区最新那条之后」；
同一节编号出现多次（改写超时其实成功了、又另起了一条新记录）只留位置靠后的那份（所在评论编号更大）。
只认 `trusted(login)` 为真的账号写的记录；别的账号带同样标记的评论只当普通评论。
"""
import json
import re
import sys

HEAD = "<!-- cavil-round-log:v1 -->"
TOP_END = "<!-- cavil-round-log:top-end -->"
SEC_END = "<!-- cavil-round-log:sec-end -->"
RE_TOP = re.compile(r"^<!-- cavil-round-log:top sec=([0-9a-f]{6,32}) -->$")
RE_SEC = re.compile(
    r"^<!-- cavil-round-log:sec id=([0-9a-f]{6,32}) role=(worker|review) "
    r"at=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) after=([0-9]+) of=([0-9a-f]{6,32}|-) -->$")
# 正文里出现任何一行像标记的东西都不许写进记录（会把记录切坏）
RE_ANY_MARK = re.compile(r"^\s*<!-- cavil-round-log:")
MAX_CHARS = 60000


class FormatError(Exception):
    pass


class Superseded(FormatError):
    """复审所审的那一版在读取之后已经被新的交付取代：这条结论过期了，不发、不翻标签。"""


def is_record(body):
    return (body or "").split("\n", 1)[0].strip() == HEAD


def parse_record(body):
    """→ (top, sections)。top = {sec, text} 或 None；sections = [{sec, role, at, after, of, body, idx}]。
    标记不成对、出现在不该出现的地方 → FormatError（调用方按「读不懂」处理，不猜）。"""
    lines = (body or "").replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != HEAD:
        raise FormatError("不是往返记录")
    top, secs, cur, buf, mode = None, [], None, [], None
    for ln in lines[1:]:
        s = ln.rstrip()
        if mode is None:
            m = RE_TOP.match(s)
            if m:
                if top is not None:
                    raise FormatError("记录里有两个完整版本")
                mode, cur, buf = "top", {"sec": m.group(1)}, []
                continue
            m = RE_SEC.match(s)
            if m:
                mode, buf = "sec", []
                cur = {"sec": m.group(1), "role": m.group(2), "at": m.group(3), "after": int(m.group(4)),
                       "of": None if m.group(5) == "-" else m.group(5), "idx": len(secs)}
                continue
            if RE_ANY_MARK.match(s):
                raise FormatError("位置不对的标记：%s" % s[:60])
            continue
        if mode == "top" and s == TOP_END:
            cur["text"] = "\n".join(buf).strip("\n")
            top, mode = cur, None
            continue
        if mode == "sec" and s == SEC_END:
            cur["body"] = "\n".join(buf).strip("\n")
            secs.append(cur)
            mode = None
            continue
        if RE_ANY_MARK.match(s):
            raise FormatError("没收尾的标记：%s" % s[:60])
        buf.append(ln)
    if mode is not None:
        raise FormatError("最后一段没收尾")
    return top, secs


def _trusted(c, trusted):
    """一条评论可信与否：受保护读取已经判过的（带 trusted 字段）就用它的判断，否则按作者判。"""
    return c["trusted"] if isinstance(c.get("trusted"), bool) else trusted(c.get("author") or "")


def units(comments, trusted):
    """comments：[{id, author, at, body, url}]（任意顺序）；trusted(login) → 是否认这个账号写的记录。
    → 按位置排好的单元列表。读不懂的记录（trusted 账号写的、标记坏了）→ FormatError。"""
    out = []
    best = {}
    for c in comments:
        cid = int(c["id"])
        if is_record(c.get("body")) and _trusted(c, trusted):
            top, secs = parse_record(c["body"])
            for s in secs:
                u = {"kind": "section", "id": cid, "author": c.get("author"), "url": c.get("url", ""),
                     "sec": s["sec"], "role": s["role"], "of": s["of"], "at": s["at"], "after": s["after"],
                     "body": s["body"], "top": top, "key": (s["after"], 1, s["at"], cid, s["idx"])}
                prev = best.get(s["sec"])
                if prev is None or prev["id"] < cid:   # 同一节多份：留所在评论编号更大的
                    best[s["sec"]] = u
            continue
        out.append({"kind": "comment", "id": cid, "author": c.get("author"), "url": c.get("url", ""),
                    "at": c.get("at", ""), "body": c.get("body") or "", "key": (cid, 0, "", 0, 0),
                    "_trusted": _trusted(c, trusted)})
    out.extend(best.values())
    out.sort(key=lambda u: u["key"])
    return out


def version_of(unit, all_units):
    """一节对应的完整版本：worker 节 = 它自己交付的版本；复审节 = 它所审的那一节的版本。
    取的是保留下来那份所在记录的顶部，顶部的节编号必须对得上，对不上 → None（不拿旧版本充数）。"""
    if unit["kind"] != "section":
        return None
    want = unit["sec"] if unit["role"] == "worker" else unit["of"]
    if not want:
        return None
    top = unit.get("top")
    if top and top.get("sec") == want:
        return top.get("text")
    # 复审节在一条新开的记录里、所审那一节在旧记录：新开时顶部已经抄了所审版本，上面就对上了；
    # 对不上时再看所审那一节本身保留下来的那份
    for u in all_units:
        if u["kind"] == "section" and u["sec"] == want and u.get("top") and u["top"].get("sec") == want:
            return u["top"].get("text")
    return None


def desc(u):
    if u["kind"] == "comment":
        return "评论 #%s（@%s，%s）%s" % (u["id"], u["author"], u["at"], (" " + u["url"]) if u["url"] else "")
    who = "worker agent 交付" if u["role"] == "worker" else "复审"
    return "往返记录里的一节（%s，节 %s，%s，所在评论 %s）" % (who, u["sec"], u["at"], u["url"] or u["id"])


def render(us, show_all):
    """给 agent 看的文字。→ (文字, 退出码)；退出码 4 = 最新一节的完整版本对不上（不给任何当前版本）。"""
    lines = ["<!-- 下面是 cavil-loop 往返记录视图（GitHub#610）：评论按「单元」排好，最新的在最后 -->"]
    if not us:
        # 一条评论都没有：交付就是正文本身（首次开 PR 时交付说明写在 PR 正文里）
        lines += ["（还没有任何评论：这一轮的交付就是正文本身）", "",
                  "（复审对这次交付发结论时，写入命令带上 `--of body`）"]
        return "\n".join(lines) + "\n", 0
    if show_all:
        for i, u in enumerate(us, 1):
            lines += ["", "### 单元 %d / %d：%s" % (i, len(us), desc(u)), "", u["body"]]
        lines.append("")
    last = us[-1]
    lines += ["", "## 最新单元：%s" % desc(last), ""]
    # 复审发结论时要原样带上这个值（--of）：写入命令据它判断这期间有没有新的交付
    rev = None
    for u in reversed(us):
        if u["kind"] == "section" and u["role"] == "worker":
            rev = u["sec"]
            break
        if u["kind"] == "comment" and u.get("_trusted"):
            rev = "comment-%s" % u["id"]
            break
    # 线程里还没有任何交付（agent 的评论或记录里的一节）：所审的交付是正文本身
    lines += ["（复审对这次交付发结论时，写入命令带上 `--of %s`）" % (rev or "body"), ""]
    lines.append(last["body"])
    if last["kind"] == "section":
        v = version_of(last, us)
        if v is None:
            return ("❌ 版本对不上：最新一节（节 %s）对应的完整版本在记录里找不到。没有输出任何当前版本。"
                    "照读评论失败的规则处理。\n" % last["sec"]), 4
        lines += ["", "## 最新单元对应的完整版本", "", v]
    rounds = sum(1 for u in us if u["body"].lstrip().startswith("<!-- codex-review-round"))
    lines += ["", "（共 %d 个单元，其中带复审轮次标记的 %d 个；同一节在评论区出现多次的只算一次）" % (len(us), rounds)]
    return "\n".join(lines) + "\n", 0


# ── 写入：算出这次要整段写回的正文（或新开记录的正文）──────────────────────────────

def check_body(text, what):
    for ln in (text or "").split("\n"):
        if RE_ANY_MARK.match(ln):
            raise FormatError("%s里有一行像往返记录的标记，不能写进记录" % what)
        if "<!-- autopilot-review-pass" in ln:
            raise FormatError("%s里带着托管合并用的测试记录标记，这类结论必须单独发" % what)


INTRO = ("**agent 往返记录**：一段 agent 之间的来回（交方案 / 交 PR → 复审 → 修订 → ……）都追加在这一条里，"
         "交给人的评论另外单独发。本条只由 agent 写，请不要编辑；要回复或拍板请在交人评论里。")


def section_text(sec, role, at, after, of, body):
    head = "### %s · %s" % ("worker agent 交付" if role == "worker" else "复审", at)
    return "\n".join([head, "<!-- cavil-round-log:sec id=%s role=%s at=%s after=%d of=%s -->" % (sec, role, at, after, of or "-"),
                      body.strip("\n"), SEC_END])


def top_text(sec, text):
    return "\n".join(["<details><summary>当前完整版本</summary>", "", "<!-- cavil-round-log:top sec=%s -->" % sec,
                      text.strip("\n"), TOP_END, "", "</details>"])


def new_record(top_sec, top_body, secs_text):
    parts = [HEAD, INTRO, ""]
    if top_sec:
        parts += [top_text(top_sec, top_body), ""]
    parts.append(secs_text)
    return "\n".join(parts) + "\n"


def plan(inp):
    """inp：{comments, trusted_login, role, body, full, of, sec, at, max}
    → {mode: append|new, comment_id, append_body, new_body, of}。
    append_body = 追加到现有记录时整段写回的正文（mode=append 才有）；new_body = 新开 / 另起一条时的正文
    （两种情况都给：改写失败时另起用的就是它，内容与新开完全相同）。"""
    trusted = trusted_by(inp.get("trusted_login"))
    role, body, full = inp["role"], inp.get("body") or "", inp.get("full")
    check_body(body, "本节正文")
    if full is not None:
        check_body(full, "完整版本")
    if role == "worker" and not (full or "").strip():
        raise FormatError("worker 交付要给完整版本")
    if not body.strip():
        raise FormatError("本节正文是空的")
    comments = sorted(inp["comments"], key=lambda c: int(c["id"]))
    us = units(comments, trusted)
    latest_id = int(comments[-1]["id"]) if comments else 0
    of = inp.get("of") or None
    if role == "review":
        # 复审依据的交付由调用方给（--of = 读取时最新单元标出的那个值）：读取之后线程可能又多了新的交付，
        # 写入时不能按当时的线程重新挑一版。结果只有三种：
        #   ① 所审的就是记录里最新的那一节 worker 交付 → 照常写（of = 它）
        #   ② 所审的是一条单独的评论（开关打开前的旧式交付等）或正文本身（--of body：线程里还没有任何交付，
        #      如首次开 PR 时交付说明只写在 PR 正文里），且它仍是最新交付 → 拒收，照现在单独发
        #   ③ 所审的那一版之后又有了交付（新的一节，或 loop 账号又单独发了评论），或者它已经找不到 → 过期，不发
        if not of:
            raise FormatError("复审要给 --of（读取时最新单元标出的值）")
        latest = None
        for u in reversed(us):
            if (u["kind"] == "section" and u["role"] == "worker") or (u["kind"] == "comment" and u.get("_trusted")):
                latest = u
                break
        # 还没有任何交付（只有正文，如首次开 PR 时交付说明写在 PR 正文里）= 所审的是正文：记作 body
        latest_key = "body" if latest is None else (latest["sec"] if latest["kind"] == "section" else "comment-%s" % latest["id"])
        if latest_key != of:
            raise Superseded("所审的那一版（%s）读取之后已经不是最新的交付（现在是 %s），这条复审结论过期了" % (of, latest_key or "无"))
        if latest is None:
            raise FormatError("所审的交付是正文本身、不在往返记录里，这一条复审结论照现在单独发")
        if latest["kind"] == "comment":
            raise FormatError("所审的交付是一条单独的评论、不在往返记录里，这一条复审结论照现在单独发")
    sec, at = inp["sec"], inp["at"]
    # 新开记录时顶部放的版本：worker = 本次完整版本；复审 = 所审那一节的完整版本（取不到就不放，读的时候报对不上）
    if role == "worker":
        top_sec, top_body = sec, full
    else:
        top_sec, top_body = of, None
        if of:
            for u in us:
                if u["kind"] == "section" and u["sec"] == of:
                    top_body = version_of(u, us)
        if top_body is None:
            # 所审的交付不在往返记录里（开关打开前的旧式独立评论，或版本取不到）：这一条复审结论照现在单独发，
            # 不写一条下一轮读不出版本的记录
            raise FormatError("所审的交付不在往返记录里（取不到它的完整版本），这一条复审结论照现在单独发")
    out = {"mode": "new", "comment_id": None, "of": of, "sec": sec}
    cap = int(inp.get("max") or MAX_CHARS)
    nb = new_record(top_sec, top_body or "", section_text(sec, role, at, latest_id, of, body))
    if len(nb) > cap:
        raise FormatError("这一节加上完整版本超过 %d 字，放不进一条评论" % cap)
    out["new_body"] = nb
    # 能追加：评论区最新一条就是可信账号写的往返记录（中途有任何新评论 → 来回被打断，另起一条）
    if comments and is_record(comments[-1].get("body")) and _trusted(comments[-1], trusted):
        cur = comments[-1]
        top, _ = parse_record(cur["body"])
        text = cur["body"].replace("\r\n", "\n").rstrip("\n")
        if role == "worker":
            new_top = top_text(sec, full)
            if top is None:
                # 记录里还没有完整版本（复审开的记录、所审版本取不到）：放在说明之后
                first, rest = text.split("\n", 1) if "\n" in text else (text, "")
                text = "\n".join([first, new_top, rest])
            else:
                text = _replace_top(text, new_top)
        text = text + "\n\n" + section_text(sec, role, at, latest_id, of, body) + "\n"
        if len(text) <= cap:
            parse_record(text)   # 写回前自己再读一遍，读不懂就不写
            out.update(mode="append", comment_id=int(cur["id"]), append_body=text)
    return out


def _replace_top(text, new_top):
    lines = text.split("\n")
    s = next(i for i, ln in enumerate(lines) if RE_TOP.match(ln.rstrip()))
    e = next(i for i in range(s, len(lines)) if lines[i].rstrip() == TOP_END)
    # 连同包着它的 <details> 一起换掉（我们自己写的固定样子）
    if s >= 2 and lines[s - 2].startswith("<details><summary>当前完整版本") and lines[s - 1] == "":
        s -= 2
        if e + 2 < len(lines) and lines[e + 1] == "" and lines[e + 2] == "</details>":
            e += 2
    return "\n".join(lines[:s] + [new_top] + lines[e + 1:])


# ── 统计用：把评论展开成「一个单元一条」的评论（周报、单 PR 统计）──────────────────

def loop_login():
    """loop 写评论的账号（统计入口用）：和写入命令里的 write_identity_login 同一个来源——有 WRITE_GH_TOKEN
    就用它问 `gh api user`，没有就用 gh 自己的登录。问不到 → FormatError（调用方报错退出，不猜、不退回按名字认）。"""
    import os
    import subprocess
    env = dict(os.environ)
    if env.get("WRITE_GH_TOKEN"):
        env["GH_TOKEN"] = env["WRITE_GH_TOKEN"]
    try:
        p = subprocess.run(["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True, timeout=60, env=env)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise FormatError("问不到 loop 写评论账号：%s" % e)
    login = p.stdout.strip()
    if p.returncode != 0 or not login or "\n" in login:
        raise FormatError("问不到 loop 写评论账号（gh api user 退出码 %d）" % p.returncode)
    return login


def trusted_by(login):
    """「这条记录可信」只有一种判法：作者就是 loop 写评论的账号（不区分大小写）。写入、读取、统计都用它。"""
    want = (login or "").lower()
    return lambda a: bool(want) and (a or "").lower() == want


def expand_github_comments(comments, trusted):
    """GitHub 评论原样（user.login / created_at / body / id / issue_url / html_url）→ 同样形状的列表，
    往返记录换成它的各节：id 写成 "<评论编号>:<节编号>"、created_at 换成这一节的追加时间。
    可信账号写的记录读不懂 → FormatError（调用方报错退出：不退回按整条评论算，也不丢掉别的节）。"""
    norm = []
    raw_by_id = {}
    for c in comments:
        raw_by_id[int(c["id"])] = c
        norm.append({"id": c["id"], "author": (c.get("user") or {}).get("login", ""), "at": c.get("created_at", ""),
                     "body": c.get("body") or "", "url": c.get("html_url", "")})
    us = units(norm, trusted)
    out = []
    for u in us:
        raw = raw_by_id[u["id"]]
        if u["kind"] == "comment":
            out.append(raw)
            continue
        d = dict(raw)
        d["id"] = "%s:%s" % (u["id"], u["sec"])
        d["created_at"] = u["at"]
        d["updated_at"] = u["at"]
        d["body"] = u["body"]
        out.append(d)
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        inp = json.load(sys.stdin)
        if cmd == "show":
            us = units(inp["comments"], trusted_by(inp.get("trusted_login")))
            text, rc = render(us, bool(inp.get("all")))
            sys.stdout.write(text)
            return rc
        if cmd == "plan":
            json.dump(plan(inp), sys.stdout, ensure_ascii=False)
            return 0
    except Superseded as e:
        sys.stdout.write("❌ %s\n" % e)
        return 4 if cmd == "show" else 7
    except FormatError as e:
        sys.stdout.write("❌ %s\n" % e)
        return 4 if cmd == "show" else 3
    except (ValueError, KeyError, TypeError) as e:
        sys.stdout.write("❌ 输入读不懂：%s\n" % e)
        return 5
    sys.stderr.write("用法: round_log.py show|plan < 输入 JSON\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
