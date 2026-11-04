#!/usr/bin/env python3
"""tests/requester-bot.test.sh 用的假 gh：带状态的最小 GitHub。

状态放在 $FAKE_GH_DIR/state.json：
  {"me": "<当前账号>", "items": {"<N>": {number, title, user, body, state, labels[], assignees[],
   is_pr, head_ref, events[{event, actor, label, id?}], events_page?, reviewers[], merged, comments[]}}}
  PR：state = open / closed，merged = true / false（合并的 PR 是 closed + merged）；
  reviewers = 待 review 名单（个人账号）；comments 每条是 {user, body}（只写字符串时算 "someone" 发的）

只实现被测代码真实发出的那几种调用（agent-poll.sh / _lib.sh / notify-requester-bot.sh）；--jq 交给真 jq。
每次调用往 calls.log 追一行，写调用（POST / DELETE / PATCH）带 "WRITE " 前缀，测试据此断言
「拒绝时零写请求」。

故障注入（$FAKE_GH_DIR/faults.json，列表，按顺序匹配第一条）：
  {"method": "POST", "path": "regex", "mode": "fail" | "noop", "times": n}
    fail = 返回非 0（HTTP 500）；noop = 返回成功但不落状态（读回会发现不符）
    times 省略 = 一直生效；每命中一次减 1，减到 0 失效
    field（可选）= 只匹配 -f 参数里含这段文字的调用（区分「加等待标签」和「加 pending/human」）
    skip（可选）= 前 n 次命中放过（照常处理），之后才生效
  GitHub#133 加的几种 mode：
    applyfail = 照常落状态，但返回非 0（「请求报错、其实已生效」）
    set       = 处理这次调用之前，先用 "jq" 字段里的 jq 表达式改一下 state.json（模拟别人同时动了数据），
                然后照常处理
    noevent   = 加标签照常生效，但不记标签事件
    hidenew   = 读标签事件时藏起 id ≥ 5000 的（本次运行新记的）事件（模拟读到的是旧数据）

评论（GitHub#133）：comments 里每条可带 id；没带的按位置编号（1、2…）。新发的评论从
next_comment_id（默认 1000）起编号。GET / PATCH repos/<R>/issues/comments/<id> 按编号找，PATCH 读 --input 的 JSON。
标签事件：新记的事件带全局递增的 id（next_event_id，默认 5000 起）；夹具里没写 id 的按位置编号。
观察钩子：设了 $FAKE_GH_OBSERVER（一条 shell 命令）时，每次调用处理之前先跑它一次（测试用它
在被测脚本的每一步之间看「机器人此刻会怎么判」）。
"""
import json
import os
import re
import subprocess
import sys
import urllib.parse

D = os.environ["FAKE_GH_DIR"]
REPO = os.environ.get("FAKE_GH_REPO", "example/requester-bot")
R = f"repos/{REPO}"


def load(name, default):
    p = os.path.join(D, name)
    if not os.path.exists(p):
        return default
    with open(p) as f:
        return json.load(f)


def save(name, obj):
    p = os.path.join(D, name)
    with open(p + ".tmp", "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(p + ".tmp", p)


args = sys.argv[1:]
with open(os.path.join(D, "calls.log"), "a") as f:
    f.write("gh " + " ".join(args) + "\n")
if os.environ.get("FAKE_GH_OBSERVER"):
    subprocess.run(["sh", "-c", os.environ["FAKE_GH_OBSERVER"]], stdin=subprocess.DEVNULL)
FAIL_AFTER = False
input_file = None

jq = None
method = None
fields = []
path = None
paginate = slurp = False
i = 0
while i < len(args):
    a = args[i]
    if a == "--jq":
        jq = args[i + 1]; i += 2; continue
    if a == "--input":
        input_file = args[i + 1]; i += 2; continue
    if a in ("-X", "--method"):
        method = args[i + 1]; i += 2; continue
    if a in ("-f", "-F"):
        fields.append(args[i + 1]); i += 2; continue
    if a == "--paginate":
        paginate = True
    elif a == "--slurp":
        slurp = True
    elif a == "--repo":
        i += 2; continue
    elif path is None and (a.startswith("repos/") or a == "user"):
        path = a
    i += 1


def emit(obj):
    s = json.dumps(obj, ensure_ascii=False)
    if FAIL_AFTER:
        sys.stderr.write("HTTP 502 (injected after apply)\n")
        sys.exit(1)
    if jq:
        r = subprocess.run(["jq", "-r", jq], input=s, text=True, capture_output=True)
        sys.stdout.write(r.stdout)
        sys.exit(r.returncode)
    print(s)
    sys.exit(0)


st = load("state.json", {"me": "worker-bot", "items": {}})
items = st["items"]


def issue_view(it):
    o = {
        "number": it["number"], "title": it.get("title", "t"), "state": it.get("state", "open"),
        "user": {"login": it.get("user", "someone")}, "body": it.get("body", ""),
        "labels": [{"name": n} for n in it.get("labels", [])],
        "assignees": [{"login": n} for n in it.get("assignees", [])],
        "updated_at": "2026-10-01T00:00:00Z",
    }
    o["pull_request"] = {"url": "x"} if it.get("is_pr") else None
    if not it.get("is_pr"):
        del o["pull_request"]
    return o


def pull_view(it):
    o = issue_view(it)
    o.pop("pull_request", None)
    o["head"] = {"ref": it.get("head_ref", f"feature/issue-{it['number']}"), "sha": "abc"}
    o["base"] = {"ref": "main"}
    o["merged"] = bool(it.get("merged", False))
    o["merged_at"] = "2026-10-01T00:00:00Z" if it.get("merged") else None
    o["merge_commit_sha"] = "0123456789abcdef0123" if it.get("merged") else None
    for k in it.get("drop_pull_fields", []):   # 模拟接口少字段
        o.pop(k, None)
    return o


def comment_view(k, c, n=None):
    if isinstance(c, str):
        c = {"user": "someone", "body": c}
    o = {"id": c.get("id", k + 1), "user": {"login": c.get("user", "someone")}, "body": c.get("body", ""),
         "created_at": "2026-10-01T00:00:00Z"}
    if n is not None:
        o["issue_url"] = f"https://api.github.com/{R}/issues/{n}"
    return o


def add_event(it, ev):
    ev["id"] = st.get("next_event_id", 5000)
    st["next_event_id"] = ev["id"] + 1
    it.setdefault("events", []).append(ev)


# gh pr view N --json body --jq ...（pr_to_issue_num 的第 2 步）
if args[:2] == ["pr", "view"]:
    it = items.get(args[2])
    if not it:
        sys.exit(1)
    emit({"body": it.get("body", "")})
# gh pr list：只有合并后清理那一段（不带 --label）要真数据；带 --label 的照旧返回空
if args[:2] == ["pr", "list"] and "--label" not in args:
    def opt(name):
        return args[args.index(name) + 1] if name in args else ""
    state, search = opt("--state"), opt("--search")
    rows = []
    for it in sorted(items.values(), key=lambda x: -x["number"]):
        if not it.get("is_pr"):
            continue
        st_ = it.get("state", "open")
        merged = bool(it.get("merged"))
        if (state == "merged" and merged) or (state == "open" and st_ == "open") \
                or ("is:unmerged" in search and st_ == "closed" and not merged):
            rows.append({"number": it["number"], "headRefName": it.get("head_ref", f"feature/issue-{it['number']}")})
    emit(rows)
if args and args[0] in ("pr", "issue"):
    emit([])

if args and args[0] == "api":
    method = (method or ("POST" if fields and path and path.endswith(("labels", "assignees", "comments")) else "GET")).upper()
    is_write = method in ("POST", "DELETE", "PATCH", "PUT")
    if is_write:
        with open(os.path.join(D, "calls.log"), "a") as f:
            f.write(f"WRITE {method} {path}\n")
    faults = load("faults.json", [])
    NOEVENT = False
    HIDENEW = False
    for fl in faults:
        if fl.get("method", method) == method and re.search(fl["path"], path or "") \
                and (not fl.get("field") or any(fl["field"] in kv for kv in fields)):
            if fl.get("times", -1) == 0:
                continue
            if fl.get("skip", 0) > 0:
                fl["skip"] -= 1
                save("faults.json", faults)
                continue
            if fl.get("times", -1) > 0:
                fl["times"] -= 1
                save("faults.json", faults)
            if fl["mode"] == "set":
                cur = json.dumps(load("state.json", {"me": "worker-bot", "items": {}}))
                r = subprocess.run(["jq", fl["jq"]], input=cur, text=True, capture_output=True)
                if r.returncode != 0:
                    sys.stderr.write("bad set fault: " + r.stderr)
                    sys.exit(99)
                save("state.json", json.loads(r.stdout))
                break
            if fl["mode"] == "applyfail":
                FAIL_AFTER = True
                break
            if fl["mode"] == "noevent":
                NOEVENT = True
                break
            if fl["mode"] == "hidenew":
                HIDENEW = True
                break
            if fl["mode"] == "fail":
                sys.stderr.write("HTTP 500 (injected)\n")
                sys.exit(1)
            if fl["mode"] == "noop":
                print("{}")
                sys.exit(0)
            break

    st = load("state.json", {"me": "worker-bot", "items": {}})
    items = st["items"]
    if path == "user":
        emit({"login": st.get("me", "worker-bot")})

    m = re.fullmatch(re.escape(R) + r"/issues/comments/(\d+)", path or "")
    if m:
        cid = int(m.group(1))
        for n, it in items.items():
            for k, c in enumerate(it.get("comments", [])):
                if isinstance(c, str):
                    c = it["comments"][k] = {"user": "someone", "body": c}
                if c.get("id", k + 1) == cid:
                    if method == "PATCH":
                        body = None
                        if input_file:
                            with open(input_file, encoding="utf-8") as f:
                                body = json.load(f).get("body")
                        if body is None:
                            body = next((kv[5:] for kv in fields if kv.startswith("body=")), None)
                        if body is None:
                            sys.stderr.write("HTTP 422 no body\n")
                            sys.exit(1)
                        c["body"] = body
                        c["edited"] = c.get("edited", 0) + 1
                        save("state.json", st)
                    emit(comment_view(k, c, it["number"]))
        sys.stderr.write("HTTP 404 comment\n")
        sys.exit(1)

    m = re.fullmatch(re.escape(R) + r"/(issues|pulls)", path or "")
    if m and method == "GET":
        kind = m.group(1)
        rows = []
        for it in sorted(items.values(), key=lambda x: x["number"]):
            if it.get("state", "open") != "open":
                continue
            if kind == "pulls" and not it.get("is_pr"):
                continue
            rows.append(pull_view(it) if kind == "pulls" else issue_view(it))
        emit([rows] if slurp else rows)

    m = re.fullmatch(re.escape(R) + r"/(issues|pulls)/(\d+)(/.*)?", path or "")
    if m:
        kind, n, rest = m.group(1), m.group(2), m.group(3) or ""
        it = items.get(n)
        if it is None:
            sys.stderr.write("HTTP 404\n")
            sys.exit(1)
        def labels_of(): return it.setdefault("labels", [])
        if rest == "" and method == "GET":
            emit(pull_view(it) if kind == "pulls" else issue_view(it))
        if rest == "/events" and method == "GET":
            # 真接口每条事件都有全局递增的 id；夹具可以显式给 id（故意乱序），没给就按落库顺序编号。
            # id 为 None = 模拟缺字段。events_page = 每页几条（--paginate 时 --jq 逐页执行，同真 gh）
            evs = [{"id": e.get("id", k + 1), "event": e["event"],
                    "actor": ({"login": e["actor"]} if e.get("actor") else None),
                    "label": {"name": e.get("label", "")}, "created_at": "2026-10-01T00:00:00Z"}
                   for k, e in enumerate(it.get("events", []))]
            if HIDENEW:
                evs = [e for e in evs if not (isinstance(e["id"], int) and e["id"] >= 5000)]
            size = it.get("events_page")
            if paginate and size and jq:
                rc = 0
                for k in range(0, max(len(evs), 1), size):
                    r = subprocess.run(["jq", "-r", jq], input=json.dumps(evs[k:k + size], ensure_ascii=False),
                                       text=True, capture_output=True)
                    sys.stdout.write(r.stdout)
                    rc = rc or r.returncode
                sys.exit(rc)
            emit(evs)
        if rest == "/labels" and method == "POST":
            for kv in fields:
                if kv.startswith("labels[]="):
                    name = kv[len("labels[]="):]
                    if name not in labels_of():
                        labels_of().append(name)
                        if not NOEVENT:
                            add_event(it, {"event": "labeled", "actor": st.get("me"), "label": name})
            save("state.json", st)
            emit([{"name": x} for x in labels_of()])
        if rest.startswith("/labels/") and method == "DELETE":
            name = urllib.parse.unquote(rest[len("/labels/"):])
            if name not in labels_of():
                sys.stderr.write("HTTP 404 Label does not exist\n")
                sys.exit(1)
            labels_of().remove(name)
            add_event(it, {"event": "unlabeled", "actor": st.get("me"), "label": name})
            save("state.json", st)
            emit([{"name": x} for x in labels_of()])
        if rest == "/assignees" and method in ("POST", "DELETE"):
            who = [kv[len("assignees[]="):] for kv in fields if kv.startswith("assignees[]=")]
            cur = it.setdefault("assignees", [])
            for w in who:
                if method == "POST" and w not in cur:
                    cur.append(w)
                    it.setdefault("events", []).append({"event": "assigned", "actor": st.get("me"), "label": w})
                if method == "DELETE" and w in cur:
                    cur.remove(w)
            save("state.json", st)
            emit(issue_view(it))
        if rest.split("?")[0] == "/comments":
            if method == "POST":
                body = next((kv[5:] for kv in fields if kv.startswith("body=")), "")
                cid = st.get("next_comment_id", 1000)
                st["next_comment_id"] = cid + 1
                it.setdefault("comments", []).append({"id": cid, "user": st.get("me"), "body": body})
                save("state.json", st)
                emit({"id": cid})
            emit([comment_view(k, c, it["number"]) for k, c in enumerate(it.get("comments", []))])
        if rest == "/requested_reviewers" and kind == "pulls":
            cur = it.setdefault("reviewers", [])
            who = [kv[len("reviewers[]="):] for kv in fields if kv.startswith("reviewers[]=")]
            if method == "GET":
                emit({"users": [{"login": x} for x in cur], "teams": []})
            for w in who:
                if method == "POST" and w not in cur:
                    cur.append(w)
                    it.setdefault("events", []).append({"event": "review_requested", "actor": st.get("me"), "label": w})
                if method == "DELETE" and w in cur:
                    cur.remove(w)
            save("state.json", st)
            emit(pull_view(it))
        emit([] if method == "GET" else {})

    # 其余（PR 评论 / review 列表等）：空列表
    emit([] if method == "GET" else {})

emit([])
