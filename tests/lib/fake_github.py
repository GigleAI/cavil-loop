#!/usr/bin/env python3
"""A stateful fake of the `gh api` calls cavil-loop's poller makes (GitHub#114 tests).

Invoked as `gh` (via a tiny wrapper on PATH). State lives in $FAKE_GH_DIR:

  items.json      {"<n>": {kind: issue|pr, ...GitHub fields...}}   labels are kept separately
  labels.json     {"<n>": ["label", ...]}
  events.json     {"<n>": [ {event, label:{name}, actor:{login,type}} ]}
  comments.json   {"<n>": [ {id, body, user:{login}, created_at} ]}
  perms.json      {"<login>": "admin|write|read|none"}
  files.json      {"<pr>": [ {filename, previous_filename?} ]}
  checks.json     {"<sha>": {"check_runs": [...], "statuses": [...]}}
  edits.json      {"<pr>": [ {editedAt, deletedAt, diff} ]}  PR 正文修改历史，倒序（GraphQL userContentEdits）
  calls.log       one line per call: "gh <argv...>"
  me              login of the token (default loop-bot)

Failure injection: a file F_<key> makes matching reads fail with HTTP 502 (key = path with
'/' -> '_', e.g. F_issues_7_events).  F_merge_<code> makes the merge endpoint fail with that code;
F_post_comment / F_post_labels / F_delete_labels make those writes fail.
Hooks: hook_<key>_<k> (a shell script) runs right before the k-th GET of that path is served;
used to change GitHub between the daemon's check and its re-read.
"""
import json, os, subprocess, sys, time

D = os.environ["FAKE_GH_DIR"]
REPO = os.environ.get("FAKE_GH_REPO", "example/ap")


def p(name):
    return os.path.join(D, name)


def load(name, default):
    try:
        with open(p(name)) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(name, data):
    tmp = p(name + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, p(name))


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def me():
    try:
        return open(p("me")).read().strip() or "loop-bot"
    except FileNotFoundError:
        return "loop-bot"


argv = sys.argv[1:]
with open(p("calls.log"), "a") as f:
    f.write("gh " + " ".join(argv) + "\n")


def fail(msg, code=1):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def list_cmd():
    # `gh issue list` / `gh pr list`（GitHub#159 的测试才打开：FAKE_GH_LISTS=1；不开时照旧返回 []，
    # 托管测试的调用与结果不受影响）。只实现轮询用到的那几种：--state open|closed|merged、--label、
    # --search "is:closed is:unmerged …"、--limit、--jq。按编号倒序（≈ 真接口按创建时间倒序）。
    what, opts, k = argv[0], {}, 2
    while k < len(argv):
        if argv[k].startswith("--") and k + 1 < len(argv):
            opts[argv[k]] = argv[k + 1]; k += 2
        else:
            k += 1
    its, lbs = load("items.json", {}), load("labels.json", {})
    out = []
    for n in sorted(its, key=int, reverse=True):
        it = its[n]
        if it["kind"] != what:
            continue
        merged = bool(it.get("merged"))
        state = "closed" if merged else it.get("state", "open")
        want = opts.get("--state", "open")
        search = opts.get("--search", "")
        if "is:unmerged" in search:
            if not (state == "closed" and not merged):
                continue
        elif want == "merged":
            if not merged:
                continue
        elif want != state:
            continue
        ls = lbs.get(n, [])
        if "--label" in opts and opts["--label"] not in ls:
            continue
        out.append({"number": int(n), "title": it.get("title", "t"),
                    "headRefName": it.get("head", {}).get("ref", ""),
                    "labels": [{"name": l} for l in ls],
                    "stateReason": (it.get("state_reason") or "").upper(),
                    "updatedAt": it.get("updated_at", "2026-01-01T00:00:00Z")})
    out = out[:int(opts.get("--limit", "30"))]
    txt = json.dumps(out)
    if "--jq" in opts:
        r = subprocess.run(["jq", "-r", opts["--jq"]], input=txt, capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        sys.exit(r.returncode)
    print(txt)
    sys.exit(0)


if not argv or argv[0] != "api":
    if os.environ.get("FAKE_GH_LISTS") == "1" and len(argv) > 1 and argv[0] in ("issue", "pr") \
            and argv[1] == "list":
        list_cmd()
    # gh pr list / gh issue list etc.: nothing
    print("[]")
    sys.exit(0)

method, jqexpr, paginate, slurp, path = "GET", None, False, False, None
fields = {}
labels_add = []
i = 1
while i < len(argv):
    a = argv[i]
    if a in ("-X", "--method"):
        method = argv[i + 1]; i += 2; continue
    if a == "--jq":
        jqexpr = argv[i + 1]; i += 2; continue
    if a == "--paginate":
        paginate = True; i += 1; continue
    if a == "--slurp":
        slurp = True; i += 1; continue
    if a in ("-f", "-F"):
        k, _, v = argv[i + 1].partition("=")
        if k == "labels[]":
            labels_add.append(v)
        else:
            fields[k] = v
        i += 2; continue
    if path is None and not a.startswith("-"):
        path = a
    i += 1

items = load("items.json", {})
labels = load("labels.json", {})


def key_of(path):
    return path.replace("repos/" + REPO + "/", "").replace("/", "_")


def view(n):
    it = dict(items[str(n)])
    kind = it.pop("kind")
    it["number"] = int(n)
    it["labels"] = [{"name": l} for l in labels.get(str(n), [])]
    if kind == "pr":
        it.setdefault("state", "open")
        it.setdefault("merged", False)
    return kind, it


def as_issue(n):
    kind, it = view(n)
    out = {k: it[k] for k in ("number", "state", "state_reason", "labels", "title", "body", "user", "updated_at") if k in it}
    out.setdefault("title", "t")
    out.setdefault("updated_at", "2026-01-01T00:00:00Z")
    out["pull_request"] = {"url": "x"} if kind == "pr" else None
    if kind == "pr" and it.get("merged"):
        out["state"] = "closed"
    return out


def emit(data, pages=False):
    # pages: data is a list that GitHub would paginate; --slurp wraps pages in an outer array
    if pages and slurp:
        data = [data]
    txt = json.dumps(data)
    if jqexpr:
        r = subprocess.run(["jq", "-r", jqexpr], input=txt, capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.returncode:
            fail(r.stderr)
    else:
        print(txt)
    sys.exit(0)


def touch(n):
    # GitHub 上打 / 摘标签会刷新条目的 updated_at（在 cavil-loop#128 上实测）
    its = load("items.json", {})
    if str(n) in its:
        its[str(n)]["updated_at"] = now_iso()
        save("items.json", its)


def append_event(n, ev, name):
    evs = load("events.json", {})
    evs.setdefault(str(n), []).append(
        {"event": ev, "label": {"name": name}, "actor": {"login": me(), "type": "User"},
         "created_at": now_iso()})
    save("events.json", evs)


if path == "user":
    emit({"login": me()})

if path == "graphql":
    # PR 正文的修改历史（GitHub#142）：edits.json {"<pr>": [ {editedAt, deletedAt, diff}, ... ]}，按时间倒序，
    # 和真接口一样；没有这一项 = 正文从没改过（历史为空）。F_graphql / F_graphql_<pr> 让读取失败；
    # FAKE_GH_EDIT_PAGE 控制每页几条（测分页）；F_graphql_nocursor_<pr> 让还有下一页时不给游标。
    n = fields.get("number", "")
    if os.path.exists(p("F_graphql")) or os.path.exists(p("F_graphql_" + n)):
        fail("HTTP 502: injected failure (graphql)")
    cnt_file = p("count_graphql_" + n)
    c = int(open(cnt_file).read()) + 1 if os.path.exists(cnt_file) else 1
    open(cnt_file, "w").write(str(c))
    hook = p("hook_graphql_%s_%d" % (n, c))
    if os.path.exists(hook):
        subprocess.run(["bash", hook], check=False, stdin=subprocess.DEVNULL, timeout=30)
    edits = load("edits.json", {}).get(n, [])
    size = int(os.environ.get("FAKE_GH_EDIT_PAGE", "100"))
    start = int(fields.get("after") or 0)
    nodes = edits[start:start + size]
    more = start + size < len(edits)
    cursor = str(start + size) if more and not os.path.exists(p("F_graphql_nocursor_" + n)) else None
    emit({"data": {"repository": {"pullRequest": {"userContentEdits": {
        "pageInfo": {"hasNextPage": more, "endCursor": cursor}, "nodes": nodes}}}}})

if path is None or not path.startswith("repos/" + REPO):
    emit([])

rel = path[len("repos/" + REPO):].lstrip("/").split("?")[0]
parts = rel.split("/") if rel else []
key = key_of(path.split("?")[0])

if method == "GET":
    if os.path.exists(p("F_" + key)):
        fail("HTTP 502: injected failure (" + key + ")")
    cnt_file = p("count_" + key)
    c = int(open(cnt_file).read()) + 1 if os.path.exists(cnt_file) else 1
    open(cnt_file, "w").write(str(c))
    hook = p("hook_%s_%d" % (key, c))
    if os.path.exists(hook):
        subprocess.run(["bash", hook], check=False, stdin=subprocess.DEVNULL, timeout=30)
        items = load("items.json", {})
        labels = load("labels.json", {})

    if parts == ["issues"]:
        emit([as_issue(n) for n in sorted(items, key=int)
              if as_issue(n)["state"] == "open"], pages=True)
    if parts == ["pulls"]:
        out = []
        for n in sorted(items, key=int):
            kind, it = view(n)
            if kind == "pr" and it.get("state") == "open" and not it.get("merged"):
                out.append(it)
        emit(out, pages=True)
    if len(parts) == 2 and parts[0] == "pulls":
        if parts[1] not in items or items[parts[1]]["kind"] != "pr":
            fail("HTTP 404: Not Found")
        emit(view(parts[1])[1])
    if len(parts) == 2 and parts[0] == "issues":
        if parts[1] not in items:
            fail("HTTP 404: Not Found")
        emit(as_issue(parts[1]))
    if len(parts) == 3 and parts[0] == "issues" and parts[2] == "events":
        emit(load("events.json", {}).get(parts[1], []), pages=True)
    if len(parts) == 3 and parts[0] == "issues" and parts[2] == "comments":
        emit(load("comments.json", {}).get(parts[1], []), pages=True)
    if len(parts) == 3 and parts[0] == "pulls" and parts[2] == "files":
        emit(load("files.json", {}).get(parts[1], [{"filename": "scripts/x.sh"}]), pages=True)
    if len(parts) == 3 and parts[0] == "pulls" and parts[2] in ("comments", "reviews"):
        emit([], pages=True)
    if len(parts) == 3 and parts[0] == "collaborators" and parts[2] == "permission":
        perm = load("perms.json", {}).get(parts[1], "read")
        emit({"permission": perm, "user": {"login": parts[1]}})
    if len(parts) == 3 and parts[0] == "commits" and parts[2] == "check-runs":
        c = load("checks.json", {}).get(parts[1], {})
        runs = c.get("check_runs", [])
        emit({"total_count": len(runs), "check_runs": runs}, pages=True)
    if len(parts) == 3 and parts[0] == "commits" and parts[2] == "status":
        c = load("checks.json", {}).get(parts[1], {})
        emit({"state": "success", "statuses": c.get("statuses", [])})
    emit([], pages=True)

if method == "POST" and len(parts) == 3 and parts[0] == "issues" and parts[2] == "comments":
    if os.path.exists(p("F_post_comment")):
        fail("HTTP 500: injected comment failure")
    cm = load("comments.json", {})
    lst = cm.setdefault(parts[1], [])
    lst.append({"id": 1000 + sum(len(v) for v in cm.values()), "body": fields.get("body", ""),
                "user": {"login": me()}, "created_at": now_iso()})
    save("comments.json", cm)
    emit({"id": lst[-1]["id"]})

if method == "POST" and len(parts) == 3 and parts[0] == "issues" and parts[2] == "labels":
    if os.path.exists(p("F_post_labels")):
        fail("HTTP 500: injected label failure")
    cur = labels.setdefault(parts[1], [])
    for l in labels_add:
        if l not in cur:
            cur.append(l)
            append_event(parts[1], "labeled", l)
    save("labels.json", labels)
    touch(parts[1])
    emit([{"name": l} for l in cur])

if method == "DELETE" and len(parts) == 4 and parts[0] == "issues" and parts[2] == "labels":
    from urllib.parse import unquote
    if os.path.exists(p("F_delete_labels")):
        fail("HTTP 500: injected label delete failure")
    name = unquote(parts[3])
    cur = labels.get(parts[1], [])
    if name not in cur:
        fail("HTTP 404: Label does not exist")
    cur.remove(name)
    labels[parts[1]] = cur
    save("labels.json", labels)
    append_event(parts[1], "unlabeled", name)
    touch(parts[1])
    emit({})

if method == "PUT" and len(parts) == 3 and parts[0] == "pulls" and parts[2] == "merge":
    for code in ("405", "409", "403", "502"):
        if os.path.exists(p("F_merge_" + code)):
            fail("gh: Pull Request is not mergeable (HTTP %s)" % code)
    it = items[parts[1]]
    if fields.get("sha") and fields["sha"] != it.get("head", {}).get("sha"):
        fail("gh: Head branch was modified. Review and try the merge again. (HTTP 409)")
    it["merged"] = True
    it["state"] = "closed"
    save("items.json", items)
    emit({"merged": True, "sha": "m" * 40})

emit({})
