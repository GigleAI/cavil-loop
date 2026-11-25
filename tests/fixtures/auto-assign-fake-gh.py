#!/usr/bin/env python3
"""tests/auto-assign.test.sh 用的假 gh：带状态的最小 GitHub，只够轮询派工跑通 + 自动指派要读写的几条。

世界状态 $FAKE_GH_DIR/world.json：
  {
    "repo": "acme/widget",
    "tokens": {"<GH_TOKEN 的值>": "<身份名>"},        没列出的值算 "other"
    "logins": {"<身份名>": "<login>"},                  `gh api user` 按调用身份回答
    "items": {"<n>": {"kind": "issue"|"pr", "state": "open"|"closed", "user": "<login>", "utype": "User"|"Bot",
                      "assignees": [...], "body": "...", "created_at": "...", "labels": [...],
                      "parent": "<parent_issue_url>"|null, "deleted": true?,
                      "head_ref", "head_sha", "head_repo", "base"}},
    "unassignable": ["<login>", ...],                   指派时 GitHub 不接受的账号（照常回 201，只是不加）
    "faults": [{"path": "<不带查询串的路径>", "method": "GET"?, "times": n?}],   命中 = HTTP 502，times 省略 = 一直
    "hooks":  [{"path": "...", "nth": k, "jq": "<改 world 的 jq 过滤器>"}]     第 k 次 GET 这个路径前先改世界
  }
每次调用往 calls.log 追一行：`<METHOD> <路径（带查询串）> token=<身份>`；写入另加 `WRITE ...`。
"""
import json
import os
import re
import subprocess
import sys

D = os.environ["FAKE_GH_DIR"]
WP = os.path.join(D, "world.json")
with open(WP) as f:
    W = json.load(f)
REPO = W.get("repo", "acme/widget")
WHO = W.get("tokens", {}).get(os.environ.get("GH_TOKEN", ""), "other")


def save():
    with open(WP + ".tmp", "w") as f:
        json.dump(W, f, ensure_ascii=False, indent=1)
    os.replace(WP + ".tmp", WP)


def logline(s):
    with open(os.path.join(D, "calls.log"), "a") as f:
        f.write(s + "\n")


args = sys.argv[1:]
jq = None
method = None
fields = []
path = None
slurp = False
i = 1 if args and args[0] == "api" else 0
while i < len(args):
    a = args[i]
    if a == "--jq":
        jq = args[i + 1]; i += 2; continue
    if a in ("-X", "--method"):
        method = args[i + 1]; i += 2; continue
    if a in ("-f", "-F", "--raw-field", "--field"):
        fields.append(args[i + 1]); i += 2; continue
    if a in ("-H", "--header", "--repo", "--cache", "--hostname"):
        i += 2; continue
    if a == "--slurp":
        slurp = True
    if a.startswith("-"):
        i += 1; continue
    if path is None:
        path = a
    i += 1


def emit(obj, rc=0):
    if slurp and isinstance(obj, list):
        obj = [obj]
    s = json.dumps(obj, ensure_ascii=False)
    if jq:
        r = subprocess.run(["jq", "-r", jq], input=s, text=True, capture_output=True)
        sys.stdout.write(r.stdout)
        sys.exit(r.returncode or rc)
    sys.stdout.write(s)
    sys.exit(rc)


def http_fail(code, msg):
    sys.stderr.write(f"gh: {msg} (HTTP {code})\n")
    sys.exit(1)


if not args or args[0] != "api":
    logline("CLI " + " ".join(args[:3]))
    emit([])

m_ = (method or ("POST" if fields else "GET")).upper()
bare, _, query = (path or "").partition("?")
q = dict(kv.partition("=")[::2] for kv in query.split("&") if kv)
if m_ == "GET":
    q.update(kv.partition("=")[::2] for kv in fields)
logline(f"{m_} {path} token={WHO}")

# 钩子：第 k 次 GET 这个路径之前先改世界
if m_ == "GET":
    cnt = W.setdefault("_gets", {})
    cnt[bare] = cnt.get(bare, 0) + 1
    for h in W.get("hooks", []):
        if h["path"] == bare and h["nth"] == cnt[bare]:
            r = subprocess.run(["jq", h["jq"]], input=json.dumps(W), text=True, capture_output=True, check=True)
            W = json.loads(r.stdout)
            W["_gets"] = cnt
    save()

for fl in W.get("faults", []):
    if fl["path"] == bare and fl.get("method", "GET") == m_ and fl.get("times", -1) != 0:
        if fl.get("times", -1) > 0:
            fl["times"] -= 1
            save()
        http_fail(502, "Bad Gateway")

if path == "user":
    login = W.get("logins", {}).get(WHO)
    if not login:
        http_fail(401, "Bad credentials")
    emit({"login": login})

ITEMS = W.setdefault("items", {})


def issue_view(n):
    x = ITEMS[str(n)]
    v = {"number": int(n), "title": f"item {n}", "state": x.get("state", "open"),
         "user": {"login": x["user"], "type": x.get("utype", "User")},
         "assignees": [{"login": a} for a in x.get("assignees", [])],
         "labels": [{"name": l} for l in x.get("labels", [])],
         "body": x.get("body", ""), "created_at": x["created_at"], "updated_at": x["created_at"]}
    if x.get("parent"):
        v["parent_issue_url"] = x["parent"]
    if x.get("kind") == "pr":
        v["pull_request"] = {"url": f"https://api.github.com/repos/{REPO}/pulls/{n}"}
    return v


if m_ == "GET" and bare == f"repos/{REPO}":
    emit({"full_name": REPO})

if m_ == "GET" and bare == f"repos/{REPO}/issues":
    live = [n for n, x in ITEMS.items()]
    if q.get("sort") == "created":
        rows = sorted((int(n) for n in live), reverse=True)
        per, page = int(q.get("per_page", 30)), int(q.get("page", 1))
        emit([issue_view(n) for n in rows[(page - 1) * per: page * per]])
    lab = q.get("labels", "").replace("%2F", "/")
    rows = [issue_view(n) for n in sorted(live, key=int)
            if ITEMS[n].get("state", "open") == "open" and not ITEMS[n].get("deleted")
            and ITEMS[n].get("kind") != "pr" and (not lab or lab in ITEMS[n].get("labels", []))]
    emit(rows)

m = re.fullmatch(rf"repos/{re.escape(REPO)}/(issues|pulls)/(\d+)", bare)
if m and m_ == "GET":
    n = m.group(2)
    x = ITEMS.get(n)
    if x is None or x.get("deleted"):
        http_fail(404, "Not Found")
    if m.group(1) == "issues":
        emit(issue_view(n))
    if x.get("kind") != "pr":
        http_fail(404, "Not Found")
    emit({"number": int(n), "state": x.get("state", "open"), "body": x.get("body", ""),
          "user": {"login": x["user"]},
          "head": {"ref": x.get("head_ref", ""), "sha": x.get("head_sha", "0" * 40),
                   "repo": {"full_name": x.get("head_repo", REPO)}},
          "base": {"ref": x.get("base", "main")}})

m = re.fullmatch(rf"repos/{re.escape(REPO)}/issues/(\d+)/assignees", bare)
if m and m_ == "POST":
    n = m.group(1)
    who = [kv.partition("=")[2] for kv in fields if kv.startswith("assignees[]=")]
    x = ITEMS.get(n)
    if x is None:
        http_fail(404, "Not Found")
    for w in who:
        logline(f"WRITE assign #{n} {w} token={WHO}")
        if w not in W.get("unassignable", []) and w not in x.setdefault("assignees", []):
            x["assignees"].append(w)
    save()
    emit(issue_view(n))

emit([] if m_ == "GET" else {})
