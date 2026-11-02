#!/usr/bin/env python3
"""tests/project-auto-add.test.sh 用的假 gh：带状态的最小 GitHub（REST 派工那几条 + Projects GraphQL）。

世界状态 $FAKE_GH_DIR/world.json：
  {
    "repo": "acme/widget",
    "tokens":   {"<GH_TOKEN 的值>": "<身份名>"},          没列出的值一律算 "other"
    "owners":   {"myorg": "org", "alice": "user"},
    "projects": {"<owner>/<n>": {"id": "PVT_A", "readers": [身份...], "writers": [身份...]}},
    "items":    [{"id", "number", "kind": "issue"|"pr", "state": "OPEN"|"CLOSED"|"MERGED",
                  "createdAt", "updatedAt", "projects": [project id...]}],
    "rest_issues": [{"number", "labels": [...]}],          给派工那一路看的开着的 issue
    "faults":   [{"op": "read"|"write"|"resolve"|"items", "seg": "ri", "page": 2,
                  "content": "I_3", "project": "PVT_A", "all": true, "times": n}]
  }
  · read 故障：给 seg（+ 可选 page，从 1 起）时只让那一段那一页出 GraphQL 局部错误（其余段正常返回，
    退出码 1，同真 gh）；给 all 时整个请求失败、stdout 为空（网络错误的样子）
  · times 省略 = 一直生效；每命中一次减 1
  · 条目上「挂在哪些 Project」只返回调用身份看得见的那些（真 GitHub 也是这样）——读身份看不见
    某个 Project 时，每个条目都会显得「不在里面」

每次调用往 calls.log 追一行，形如：
  READ token=<身份> segs=ri:1,rp:1 verify=2
  ITEMS token=<身份> id=<条目>
  RESOLVE token=<身份> owner=<owner> n=<n> kind=organization|user
  WRITE token=<身份> project=<pid> content=<条目 id> ok|fail
  REST <METHOD> <path>
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
TOKEN = W.get("tokens", {}).get(os.environ.get("GH_TOKEN", ""), "other")


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
fields = {}
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
        k, _, v = args[i + 1].partition("=")
        fields[k] = v; i += 2; continue
    if a == "--paginate":
        paginate = True
    elif a == "--slurp":
        slurp = True
    elif a == "--repo":
        i += 2; continue
    elif path is None and (a.startswith("repos/") or a in ("user", "graphql")):
        path = a
    i += 1


def emit(obj, rc=0):
    s = json.dumps(obj, ensure_ascii=False)
    if jq:
        r = subprocess.run(["jq", "-r", jq], input=s, text=True, capture_output=True)
        sys.stdout.write(r.stdout)
        sys.exit(r.returncode or rc)
    sys.stdout.write(s)
    sys.exit(rc)


def fault(op, **kw):
    """找第一条匹配的故障并消耗一次；返回它（没有就 None）。"""
    for fl in W.get("faults", []):
        if fl.get("op") != op:
            continue
        if any(k in fl and fl[k] != v for k, v in kw.items()):
            continue
        if any(k in fl and k not in kw for k in ("seg", "page", "content", "project")):
            continue
        t = fl.get("times", -1)
        if t == 0:
            continue
        if t > 0:
            fl["times"] = t - 1
            save()
        return fl
    return None


def proj_by_id(pid):
    for key, p in W.get("projects", {}).items():
        if p["id"] == pid:
            return key, p
    return None, None


def can_read(pid):
    _, p = proj_by_id(pid)
    return p is not None and TOKEN in p.get("readers", [])


def visible_projects(it):
    return [p for p in it.get("projects", []) if can_read(p)]


def gql_fail(msg):
    sys.stderr.write(f"gh: {msg}\n")
    sys.exit(1)


# ── GraphQL ──
if args[:2] == ["api", "graphql"]:
    q = fields.get("query", "")

    # 写：addProjectV2ItemById
    if "addProjectV2ItemById" in q:
        pid, cid = fields.get("p", ""), fields.get("c", "")
        _, p = proj_by_id(pid)
        it = next((x for x in W["items"] if x["id"] == cid), None)
        bad = None
        if fault("write", content=cid, project=pid) or fault("write", content=cid) or fault("write", project=pid):
            bad = "Something went wrong while executing your query (injected)"
        elif p is None or TOKEN not in p.get("writers", []):
            bad = f"Resource not accessible by personal access token"
        elif it is None:
            bad = f"Could not resolve to a node with the global id of '{cid}'"
        if bad:
            logline(f"WRITE token={TOKEN} project={pid} content={cid} fail")
            sys.stdout.write(json.dumps({"data": {"addProjectV2ItemById": None},
                                         "errors": [{"type": "FORBIDDEN", "path": ["addProjectV2ItemById"], "message": bad}]}))
            gql_fail(bad)
        if pid not in it.setdefault("projects", []):
            it["projects"].append(pid)
        save()
        logline(f"WRITE token={TOKEN} project={pid} content={cid} ok")
        emit({"data": {"addProjectV2ItemById": {"item": {"id": f"PVTI_{pid}_{cid}"}}}})

    # 解析 Project 编号（_lib.sh: project_resolve）
    m = re.search(r"\b(organization|user)\(login:", q)
    if m and "projectV2(number:" in q:
        kind = m.group(1)
        owner, n = fields.get("owner", ""), fields.get("n", "")
        logline(f"RESOLVE token={TOKEN} owner={owner} n={n} kind={kind}")
        if fault("resolve"):
            gql_fail("HTTP 502 (injected)")
        # GitHub 的登录名不分大小写
        okind = {k.lower(): v for k, v in W.get("owners", {}).items()}.get(owner.lower())
        if okind is None or (okind == "org") != (kind == "organization"):
            sys.stdout.write(json.dumps({"data": {kind: None}, "errors": [{"type": "NOT_FOUND", "path": [kind],
                                         "message": f"Could not resolve to an {kind} with the login of '{owner}'."}]}))
            gql_fail(f"Could not resolve to an {kind} with the login of '{owner}'.")
        p = {k.lower(): v for k, v in W.get("projects", {}).items()}.get(f"{owner.lower()}/{n}")
        if p is None or TOKEN not in p.get("readers", []):
            sys.stdout.write(json.dumps({"data": {kind: {"projectV2": None}}, "errors": [{"type": "NOT_FOUND",
                                         "path": [kind, "projectV2"], "message": f"Could not resolve to a ProjectV2 with the number {n}."}]}))
            gql_fail(f"Could not resolve to a ProjectV2 with the number {n}.")
        emit({"data": {kind: {"projectV2": {"id": p["id"], "number": int(n), "title": f"board {n}"}}}})

    # 补翻某个条目挂的 Project
    if "project-auto-add item-projects" in q:
        iid, after = fields.get("id", ""), fields.get("after", "")
        logline(f"ITEMS token={TOKEN} id={iid}")
        if fault("items", content=iid) or fault("items"):
            gql_fail("HTTP 502 (injected)")
        it = next((x for x in W["items"] if x["id"] == iid), None)
        if it is None:
            gql_fail(f"Could not resolve to a node with the global id of '{iid}'")
        vis = visible_projects(it)
        off = int(after) if after.isdigit() else 0
        page = vis[off:off + 100]
        emit({"data": {"node": {"projectItems": {
            "pageInfo": {"hasNextPage": off + 100 < len(vis), "endCursor": str(off + len(page))},
            "nodes": [{"project": {"id": p}} for p in page]}}}})

    # 共用读取
    if "project-auto-add read" in q:
        segs = re.findall(r"\b(ri|rp|oi|op): (issues|pullRequests)\(first:(\d+),(.*?)\)\{ pageInfo", q)
        verify = re.findall(r"\b(v\d+): node\(id:\"([^\"]*)\"\)", q)
        m = re.search(r"projectItems\(first:(\d+)\)", q)
        per_item = int(m.group(1)) if m else 20
        pages = {}
        for alias, _, _, rest in segs:
            ma = re.search(r'after:"([^"]*)"', rest)
            off = int(ma.group(1)) if ma else 0
            pages[alias] = off
        logline(f"READ token={TOKEN} segs=" + ",".join(f"{a}:{pages[a] // int(n) + 1}" for a, _, n, _ in segs)
                + f" verify={len(verify)}")
        if fault("read", all=True):
            sys.stderr.write("HTTP 502 Bad Gateway (injected)\n")
            sys.exit(1)
        data = {"repository": {}}
        errors = []
        for alias, conn, n, rest in segs:
            n = int(n)
            off = pages[alias]
            page_no = off // n + 1
            if fault("read", seg=alias, page=page_no) or fault("read", seg=alias):
                data["repository"][alias] = None
                errors.append({"type": "INTERNAL", "path": ["repository", alias], "message": "Something went wrong (injected)"})
                continue
            kind = "issue" if conn == "issues" else "pr"
            rows = [x for x in W["items"] if x["kind"] == kind]
            if "states:OPEN" in rest:
                rows = [x for x in rows if x["state"] == "OPEN"]
            if "UPDATED_AT" in rest:
                rows.sort(key=lambda x: (x["updatedAt"], x["number"]), reverse=True)
            else:
                rows.sort(key=lambda x: (x["createdAt"], x["number"]))
            page = rows[off:off + n]
            nodes = []
            for x in page:
                vis = visible_projects(x)
                nodes.append({"id": x["id"], "number": x["number"], "state": x["state"],
                              "createdAt": x["createdAt"], "updatedAt": x["updatedAt"],
                              "projectItems": {"pageInfo": {"hasNextPage": len(vis) > per_item,
                                                            "endCursor": str(min(len(vis), per_item))},
                                               "nodes": [{"project": {"id": p}} for p in vis[:per_item]]}})
            data["repository"][alias] = {"pageInfo": {"hasNextPage": off + n < len(rows),
                                                      "endCursor": str(off + len(page))}, "nodes": nodes}
        for alias, pid in verify:
            if can_read(pid):
                data[alias] = {"id": pid}
            else:
                data[alias] = None
                errors.append({"type": "NOT_FOUND", "path": [alias],
                               "message": f"Could not resolve to a node with the global id of '{pid}'"})
        out = {"data": data}
        if errors:
            out["errors"] = errors
            sys.stdout.write(json.dumps(out))
            gql_fail(errors[0]["message"])
        emit(out)

    # 其余 GraphQL（优先级字段之类）：一律失败，让调用方回落
    logline(f"GRAPHQL-OTHER token={TOKEN}")
    gql_fail("not implemented in fake")

# ── REST：只够轮询派工跑通 ──
if args and args[0] == "api":
    m_ = (method or ("POST" if fields and path and path.endswith(("labels", "comments")) else "GET")).upper()
    logline(f"REST {m_} {path}")
    if path == "user":
        emit({"login": "worker-bot"})
    if m_ == "GET" and path == f"repos/{REPO}/issues":
        rows = [{"number": x["number"], "title": f"item {x['number']}", "state": "open",
                 "user": {"login": "someone"}, "body": "", "assignees": [],
                 "labels": [{"name": l} for l in x.get("labels", [])],
                 "updated_at": "2026-10-01T00:00:00Z"} for x in W.get("rest_issues", [])]
        emit([rows] if slurp else rows)
    if m_ == "GET" and path == f"repos/{REPO}/pulls":
        emit([[]] if slurp else [])
    m = re.fullmatch(rf"repos/{re.escape(REPO)}/issues/(\d+)", path or "")
    if m and m_ == "GET":
        x = next((r for r in W.get("rest_issues", []) if str(r["number"]) == m.group(1)), None)
        if x is None:
            sys.stderr.write("HTTP 404\n"); sys.exit(1)
        emit({"number": x["number"], "title": "t", "state": "open", "user": {"login": "someone"}, "body": "",
              "labels": [{"name": l} for l in x.get("labels", [])], "assignees": [], "updated_at": "2026-10-01T00:00:00Z"})
    emit([] if m_ == "GET" else {})

if args and args[0] in ("pr", "issue"):
    logline("CLI " + " ".join(args[:2]))
    emit([])
emit([])
