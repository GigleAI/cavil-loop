#!/usr/bin/env python3
"""A stateful fake of the `gh api` calls cavil-loop's poller makes (GitHub#114 tests).

Invoked as `gh` (via a tiny wrapper on PATH). State lives in $FAKE_GH_DIR:

  items.json      {"<n>": {kind: issue|pr, ...GitHub fields...}}   labels are kept separately
  labels.json     {"<n>": ["label", ...]}
  events.json     {"<n>": [ {event, label:{name}, actor:{login,type}} ]}   id 按位置补（写了 "id": null 的不补）
  comments.json   {"<n>": [ {id, body, user:{login}, created_at} ]}
  perms.json      {"<login>": "admin|write|read|none"}
  files.json      {"<pr>": [ {filename, previous_filename?} ]}   PR 详情的 changed_files 默认按它算（items 里可另写，
                  "__missing__" = 缺这个字段）；raw_pulls_<n>_files 文件 = 原样当作文件列表的响应（GitHub#337）
  checks.json     {"<sha>": {"check_runs": [...], "statuses": [...]}}
  edits.json      {"<pr>": [ {editedAt, deletedAt, diff, editor?} ]}  正文修改历史，倒序（GraphQL userContentEdits；
                  查询里写 issueOrPullRequest 时 issue 的也按编号从这里取，GitHub#391）
  review_comments.json / reviews.json  {"<pr>": [...]}  PR 行内评论 / review（GitHub#391；没有 = 空）
  perms.json 里写 "__404__" = 这个账号不存在
  blocked_by.json {"<n>": [<n>, ...]}  原生「Blocked by」关系（GitHub#157）；"<owner/repo>#<n>" 是别的仓库的条目
  subs.json       {"<n>": [<n> | "<owner/repo>#<n>", ...]}  子项（GitHub#233）：/issues/N/sub_issues 和 sub_issues_summary
  items 里的 parent_issue_url 原样带进 issue（GitHub#233）；repos/<owner>__<repo>/ 子目录 = 另一个仓库的同一套状态
  calls.log       one line per call: "gh <argv...>"
  me              login of the token (default loop-bot)

Failure injection: a file F_<key> makes matching reads fail with HTTP 502 (F403_<key>: a
permission 403, F403rl_<key>: a rate-limit 403 — GitHub#243) (key = path with
'/' -> '_', e.g. F_issues_7_events).  F_merge_<code> makes the merge endpoint fail with that code;
F_post_comment / F_post_labels / F_delete_labels make those writes fail (F_post_comment_lost: the comment
is created but the call reports failure; hook_POST_issues_<n>_comments_<k> / hook_after_POST_issues_<n>_comments_<k>
run right before / after the k-th comment on item n — GitHub#382; Flost_post_labels / Flost_delete_labels: the
label write takes effect and the caller still gets a failure — GitHub#341); F_post_label_<name> fails
adding just that label, F_post_label_noop_<name> answers success without adding it; F_user fails `gh api user`.
tokens.log records the GH_TOKEN each call ran with.
Hooks: hook_<key>_<k> (a shell script) runs right before the k-th GET of that path is served;
hook_<POST|DELETE>_issues_<n>_labels_<k> runs right before the k-th label add / remove on item n,
hook_after_POST_issues_<n>_labels_<k> right after the k-th label add took effect;
used to change GitHub between the daemon's check and its re-read.
jq_<key> (GitHub#382): a jq filter applied to the answer of GET pulls/<n> / issues/<n> (drop a field, set an
unknown state word). done_POST_issues_<n>_labels_<k> appears once the k-th label add on item n is fully saved —
a test that kills the caller mid-request waits for it instead of sleeping.
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
# 每次调用用的是哪把令牌（GitHub#190：daemon 的写入走写入身份），单独记一份，不改 calls.log 的格式
with open(p("tokens.log"), "a") as f:
    f.write(os.environ.get("GH_TOKEN", "") + " gh " + " ".join(argv) + "\n")


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

# 别的仓库（GitHub#233：跨仓库的父 issue / 前置）：$FAKE_GH_DIR/repos/<owner>__<repo>/ 存在时，
# 发往那个仓库的请求就用那个目录里的同一套状态文件（calls.log / tokens.log 仍记在主目录）
if path and path.startswith("repos/"):
    _seg = path.split("?")[0].split("/")
    if len(_seg) >= 3 and (_seg[1] + "/" + _seg[2]).lower() != REPO.lower():
        _od = os.path.join(D, "repos", _seg[1] + "__" + _seg[2])
        if os.path.isdir(_od):
            D = _od
            REPO = _seg[1] + "/" + _seg[2]

items = load("items.json", {})
labels = load("labels.json", {})


def other_items(repo):
    """另一个仓库的 (items, 目录)；没有这个仓库的目录 → ({}, None)"""
    if repo.lower() == REPO.lower():
        return items, D
    root = os.environ["FAKE_GH_DIR"]
    od = os.path.join(root, "repos", repo.replace("/", "__"))
    if repo.lower() == os.environ.get("FAKE_GH_REPO", "example/ap").lower():
        od = root
    if not os.path.isdir(od):
        return {}, None
    try:
        with open(os.path.join(od, "items.json")) as fh:
            return json.load(fh), od
    except FileNotFoundError:
        return {}, od


def sub_refs(n):
    """subs.json {"<父号>": [<子号> | "owner/repo#<子号>", ...]} → [(仓库, 子号)]"""
    out = []
    for s in load("subs.json", {}).get(str(n), []):
        if isinstance(s, str) and "#" in s:
            r, _, sn = s.partition("#")
            out.append((r, sn))
        else:
            out.append((REPO, str(s)))
    return out


def sub_state(repo, sn):
    its, _ = other_items(repo)
    it = its.get(str(sn))
    return None if it is None else it.get("state", "open")


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
        # GitHub#337：PR 详情自报的改动文件数。夹具没写就按 files.json 算；写成 "__missing__" = 这个字段缺失
        if it.get("changed_files") == "__missing__":
            del it["changed_files"]
        elif "changed_files" not in it:
            it["changed_files"] = len(load("files.json", {}).get(str(n), [{"filename": "scripts/x.sh"}]))
    return kind, it


def as_issue(n):
    kind, it = view(n)
    out = {k: it[k] for k in ("number", "state", "state_reason", "labels", "title", "body", "user", "updated_at") if k in it}
    out.setdefault("title", "t")
    out.setdefault("updated_at", "2026-01-01T00:00:00Z")
    out["pull_request"] = {"url": "x", "merged_at": it.get("merged_at") or ("2026-01-01T00:00:00Z" if it.get("merged") else None)} if kind == "pr" else None
    out["repository_url"] = "https://api.github.com/repos/" + REPO
    if "parent_issue_url" in it:
        out["parent_issue_url"] = it["parent_issue_url"]
    refs = sub_refs(n)
    if refs:
        sts = [sub_state(r, sn) for r, sn in refs]
        out["sub_issues_summary"] = {"total": len(refs), "completed": sum(1 for s in sts if s == "closed")}
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
    # 不存 id：读的时候统一按位置补（见 GET …/events），这样夹具手写的记录和 daemon 写出来的记录
    # 编号先后与发生先后一致，和真 GitHub 一样（GitHub#382：交人的写前核对按编号认先后）
    evs.setdefault(str(n), []).append(
        {"event": ev, "label": {"name": name},
         "actor": {"login": me(), "type": "User"}, "created_at": now_iso()})
    save("events.json", evs)


if path == "user":
    if os.path.exists(p("F_user")):
        fail("HTTP 502: injected failure (user)")
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
    # GitHub#391：外部内容保护按 issueOrPullRequest 读（issue 和 PR 的正文都要），节点里带 editor
    where = "issueOrPullRequest" if "issueOrPullRequest" in fields.get("query", "") else "pullRequest"
    emit({"data": {"repository": {where: {"userContentEdits": {
        "pageInfo": {"hasNextPage": more, "endCursor": cursor}, "nodes": nodes}}}}})

if path is None or not path.startswith("repos/" + REPO):
    emit([])

rel = path[len("repos/" + REPO):].lstrip("/").split("?")[0]
parts = rel.split("/") if rel else []
key = key_of(path.split("?")[0])

if method == "GET":
    if os.path.exists(p("F_" + key)):
        fail("HTTP 502: injected failure (" + key + ")")
    # GitHub#243：F403_<key> = 无权读（不是限流）；F403rl_<key> = 限流的 403
    if os.path.exists(p("F403_" + key)):
        fail("gh: Resource not accessible by personal access token (HTTP 403)")
    if os.path.exists(p("F403rl_" + key)):
        fail("gh: API rate limit exceeded for user ID 1. (HTTP 403)")
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
    # GitHub#382：jq_<key> 文件里的 jq 表达式套在这次 PR / issue 详情的响应上（删字段、改成不认识的状态词），
    # 模拟「读到了、但响应不完整」
    def shaped(data):
        f = p("jq_" + key)
        if not os.path.exists(f):
            return data
        r = subprocess.run(["jq", "-c", open(f).read()], input=json.dumps(data), capture_output=True, text=True)
        return json.loads(r.stdout)
    if len(parts) == 2 and parts[0] == "pulls":
        if parts[1] not in items or items[parts[1]]["kind"] != "pr":
            fail("HTTP 404: Not Found")
        emit(shaped(view(parts[1])[1]))
    if len(parts) == 2 and parts[0] == "issues":
        if parts[1] not in items:
            fail("HTTP 404: Not Found")
        emit(shaped(as_issue(parts[1])))
    if len(parts) == 3 and parts[0] == "issues" and parts[2] == "events":
        # 真接口的每个事件都带递增的 id；夹具没写 id 的按位置补上（写了 "id": null 的原样保留，测「缺编号」）
        evl = [dict(e) for e in load("events.json", {}).get(parts[1], [])]
        for i, e in enumerate(evl):
            if "id" not in e:
                e["id"] = 5000 + i
        emit(evl, pages=True)
    if len(parts) == 3 and parts[0] == "issues" and parts[2] == "comments":
        emit(load("comments.json", {}).get(parts[1], []), pages=True)
    if len(parts) == 3 and parts[0] == "issues" and parts[2] == "sub_issues":
        out = []
        for r, sn in sub_refs(parts[1]):
            st = sub_state(r, sn)
            if st is not None:
                out.append({"number": int(sn), "state": st, "repository_url": "https://api.github.com/repos/" + r})
        emit(out, pages=True)
    if len(parts) == 3 and parts[0] == "issues" and parts[2] == "parent":
        url = (items.get(parts[1]) or {}).get("parent_issue_url")
        if not url:
            fail("HTTP 404: Not Found")
        seg = url.split("/")
        emit({"number": int(seg[-1]), "repository_url": "/".join(seg[:-2])})
    if len(parts) == 4 and parts[0] == "issues" and parts[2] == "dependencies" and parts[3] == "blocked_by":
        out = []
        for b in load("blocked_by.json", {}).get(parts[1], []):
            if isinstance(b, str) and "#" in b:
                other, _, bn = b.partition("#")
                out.append({"number": int(bn), "state": "open", "html_url": "https://github.com/%s/issues/%s" % (other, bn),
                            "repository_url": "https://api.github.com/repos/" + other})
            elif str(b) in items:
                out.append(as_issue(b))
        emit(out, pages=True)
    if len(parts) == 3 and parts[0] == "pulls" and parts[2] == "files":
        # GitHub#337：raw_pulls_<n>_files 里的内容原样当作这次响应（缺页、坏形状、不是 JSON）
        if os.path.exists(p("raw_" + key)):
            sys.stdout.write(open(p("raw_" + key)).read())
            sys.exit(0)
        emit(load("files.json", {}).get(parts[1], [{"filename": "scripts/x.sh"}]), pages=True)
    if len(parts) == 3 and parts[0] == "pulls" and parts[2] in ("comments", "reviews"):
        # GitHub#391：review_comments.json（行内评论）/ reviews.json，{"<pr>": [...]}；没有 = 空
        emit(load(("review_comments" if parts[2] == "comments" else "reviews") + ".json", {}).get(parts[1], []), pages=True)
    if len(parts) == 3 and parts[0] == "collaborators" and parts[2] == "permission":
        perm = load("perms.json", {}).get(parts[1], "read")
        if perm == "__404__":   # GitHub#391：账号不存在（已删除）
            fail("gh: %s is not a user (HTTP 404)" % parts[1])
        emit({"permission": perm, "user": {"login": parts[1]}})
    if len(parts) == 3 and parts[0] == "commits" and parts[2] == "check-runs":
        c = load("checks.json", {}).get(parts[1], {})
        runs = c.get("check_runs", [])
        emit({"total_count": len(runs), "check_runs": runs}, pages=True)
    if len(parts) == 3 and parts[0] == "commits" and parts[2] == "status":
        c = load("checks.json", {}).get(parts[1], {})
        emit({"state": "success", "statuses": c.get("statuses", [])})
    emit([], pages=True)

# 开 issue / 改 issue 状态（GitHub#289：配置提示 issue）。F_post_issue / F_patch_issue 让这两种写失败。
if method == "POST" and parts == ["issues"]:
    if os.path.exists(p("F_post_issue")):
        fail("HTTP 500: injected issue create failure")
    n = str(max([int(k) for k in items] + [0]) + 1)
    items[n] = {"kind": "issue", "state": "open", "state_reason": None, "title": fields.get("title", ""),
                "body": fields.get("body", ""), "user": {"login": me()}, "updated_at": now_iso()}
    save("items.json", items)
    labels[n] = list(labels_add)
    save("labels.json", labels)
    emit({"number": int(n), "html_url": "https://github.com/%s/issues/%s" % (REPO, n)})

if method == "PATCH" and len(parts) == 2 and parts[0] == "issues":
    if os.path.exists(p("F_patch_issue")):
        fail("HTTP 500: injected issue update failure")
    if parts[1] not in items:
        fail("HTTP 404: Not Found")
    for k in ("state", "state_reason", "title", "body"):
        if k in fields:
            items[parts[1]][k] = fields[k]
    items[parts[1]]["updated_at"] = now_iso()
    save("items.json", items)
    emit(as_issue(parts[1]))

# 写之前的 hook（GitHub#233）：hook_<方法>_issues_<n>_labels_<k> 在对这个条目第 k 次加 / 摘标签之前运行，
# 用来模拟「上一个写请求已经完成、下一个还没发出时，人改了 GitHub」
if method in ("POST", "DELETE") and len(parts) >= 3 and parts[0] == "issues" and parts[2] == "labels":
    _wk = "%s_issues_%s_labels" % (method, parts[1])
    _wc = p("count_" + _wk)
    _c = int(open(_wc).read()) + 1 if os.path.exists(_wc) else 1
    open(_wc, "w").write(str(_c))
    _wh = p("hook_%s_%d" % (_wk, _c))
    if os.path.exists(_wh):
        subprocess.run(["bash", _wh], check=False, stdin=subprocess.DEVNULL, timeout=30)
        items = load("items.json", {})
        labels = load("labels.json", {})

if method == "POST" and len(parts) == 3 and parts[0] == "issues" and parts[2] == "comments":
    if os.path.exists(p("F_post_comment")):
        fail("HTTP 500: injected comment failure")
    # GitHub#382：hook_POST_issues_<n>_comments_<k> 在这个条目第 k 次发评论之前运行，hook_after_POST_issues_<n>_comments_<k>
    # 在它已经生效之后运行；F_post_comment_lost = 评论已经发上去了、却向调用方报失败（响应丢了）
    _ck = "POST_issues_%s_comments" % parts[1]
    _cc = p("count_" + _ck)
    _c = int(open(_cc).read()) + 1 if os.path.exists(_cc) else 1
    open(_cc, "w").write(str(_c))
    _ch = p("hook_%s_%d" % (_ck, _c))
    if os.path.exists(_ch):
        subprocess.run(["bash", _ch], check=False, stdin=subprocess.DEVNULL, timeout=30)
    cm = load("comments.json", {})
    lst = cm.setdefault(parts[1], [])
    lst.append({"id": 1000 + sum(len(v) for v in cm.values()), "body": fields.get("body", ""),
                "user": {"login": me()}, "author_association": "COLLABORATOR", "created_at": now_iso()})
    save("comments.json", cm)
    _ah = p("hook_after_%s_%d" % (_ck, _c))
    if os.path.exists(_ah):
        subprocess.run(["bash", _ah], check=False, stdin=subprocess.DEVNULL, timeout=30)
    if os.path.exists(p("F_post_comment_lost")):
        fail("HTTP 502: injected: comment was created but the response was lost")
    emit({"id": lst[-1]["id"]})

if method == "POST" and len(parts) == 3 and parts[0] == "issues" and parts[2] == "labels":
    if os.path.exists(p("F_post_labels")):
        fail("HTTP 500: injected label failure")
    cur = labels.setdefault(parts[1], [])
    for l in labels_add:
        # F_post_label_<标签> 只让加这一个标签失败；F_post_label_noop_<标签> 返回成功却没加上（GitHub#190）
        if os.path.exists(p("F_post_label_" + l)):
            fail("HTTP 500: injected label failure (" + l + ")")
        if os.path.exists(p("F_post_label_noop_" + l)):
            continue
        if l not in cur:
            cur.append(l)
            append_event(parts[1], "labeled", l)
    save("labels.json", labels)
    touch(parts[1])
    # 这次写入已经全部落盘的记号（GitHub#382）：调用方被杀掉之后请求还在这里继续跑，测试等这个文件出现再看结果
    open(p("done_%s_%d" % (_wk, _c)), "w").write("1")
    # hook_after_POST_issues_<n>_labels_<k>：第 k 次加标签已经生效之后运行（GitHub#233）
    _ah = p("hook_after_POST_issues_%s_labels_%d" % (parts[1], _c))
    if os.path.exists(_ah):
        subprocess.run(["bash", _ah], check=False, stdin=subprocess.DEVNULL, timeout=30)
        cur = load("labels.json", {}).get(parts[1], [])
    if os.path.exists(p("Flost_post_labels")):
        fail("HTTP 502: injected lost response (labels were added)")
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
    if os.path.exists(p("Flost_delete_labels")):
        fail("HTTP 502: injected lost response (label was removed)")
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
