#!/usr/bin/env python3
"""tests/relay-handoff.test.sh 用的假 gh：带状态的最小 GitHub。

状态放在 $FAKE_GH_DIR/state.json：
  {"me": "<当前账号>", "items": {"<N>": {number, title, user, body, state, labels[], assignees[],
   is_pr, head_ref, events[{event, actor, label}]}}}

只实现被测代码真实发出的那几种调用（agent-poll.sh / _lib.sh / notify-relay.sh）；--jq 交给真 jq。
每次调用往 calls.log 追一行，写调用（POST / DELETE / PATCH）带 "WRITE " 前缀，测试据此断言
「拒绝时零写请求」。

故障注入（$FAKE_GH_DIR/faults.json，列表，按顺序匹配第一条）：
  {"method": "POST", "path": "regex", "mode": "fail" | "noop", "times": n}
    fail = 返回非 0（HTTP 500）；noop = 返回成功但不落状态（读回会发现不符）
    times 省略 = 一直生效；每命中一次减 1，减到 0 失效
    field（可选）= 只匹配 -f 参数里含这段文字的调用（区分「加等待标签」和「加 pending/human」）
"""
import json
import os
import re
import subprocess
import sys
import urllib.parse

D = os.environ["FAKE_GH_DIR"]
REPO = os.environ.get("FAKE_GH_REPO", "example/relay")
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
    o["merged"] = False
    return o


# gh pr view N --json body --jq ...（pr_to_issue_num 的第 2 步）
if args[:2] == ["pr", "view"]:
    it = items.get(args[2])
    if not it:
        sys.exit(1)
    emit({"body": it.get("body", "")})
if args and args[0] in ("pr", "issue"):
    emit([])

if args and args[0] == "api":
    method = (method or ("POST" if fields and path and path.endswith(("labels", "assignees", "comments")) else "GET")).upper()
    is_write = method in ("POST", "DELETE", "PATCH", "PUT")
    if is_write:
        with open(os.path.join(D, "calls.log"), "a") as f:
            f.write(f"WRITE {method} {path}\n")
    faults = load("faults.json", [])
    for fl in faults:
        if fl.get("method", method) == method and re.search(fl["path"], path or "") \
                and (not fl.get("field") or any(fl["field"] in kv for kv in fields)):
            if fl.get("times", -1) == 0:
                continue
            if fl.get("times", -1) > 0:
                fl["times"] -= 1
                save("faults.json", faults)
            if fl["mode"] == "fail":
                sys.stderr.write("HTTP 500 (injected)\n")
                sys.exit(1)
            if fl["mode"] == "noop":
                print("{}")
                sys.exit(0)
            break

    if path == "user":
        emit({"login": st.get("me", "worker-bot")})

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
            evs = [{"event": e["event"], "actor": ({"login": e["actor"]} if e.get("actor") else None),
                    "label": {"name": e.get("label", "")}, "created_at": "2026-10-01T00:00:00Z"}
                   for e in it.get("events", [])]
            emit(evs)
        if rest == "/labels" and method == "POST":
            for kv in fields:
                if kv.startswith("labels[]="):
                    name = kv[len("labels[]="):]
                    if name not in labels_of():
                        labels_of().append(name)
                        it.setdefault("events", []).append({"event": "labeled", "actor": st.get("me"), "label": name})
            save("state.json", st)
            emit([{"name": x} for x in labels_of()])
        if rest.startswith("/labels/") and method == "DELETE":
            name = urllib.parse.unquote(rest[len("/labels/"):])
            if name not in labels_of():
                sys.stderr.write("HTTP 404 Label does not exist\n")
                sys.exit(1)
            labels_of().remove(name)
            it.setdefault("events", []).append({"event": "unlabeled", "actor": st.get("me"), "label": name})
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
        if rest == "/comments":
            if method == "POST":
                body = next((kv[5:] for kv in fields if kv.startswith("body=")), "")
                it.setdefault("comments", []).append(body)
                save("state.json", st)
                emit({"id": 1})
            emit([{"id": k + 1, "body": b} for k, b in enumerate(it.get("comments", []))])
        emit([] if method == "GET" else {})

    # 其余（PR 评论 / review 列表等）：空列表
    emit([] if method == "GET" else {})

emit([])
