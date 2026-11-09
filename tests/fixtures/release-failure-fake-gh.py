#!/usr/bin/env python3
"""A stateful fake of the `gh api` calls scripts/release_failure_report.py makes (GitHub#285).

State in $FAKE_GH_DIR (repo = $GITHUB_REPOSITORY):
  issues.json        [ {number, title, state, user:{login}, body, html_url, labels:[{name}], pull_request?} ]
                     served as stored (a test may delete a field to make an item incomplete)
  repo_labels.json   ["name", ...]  the repo's labels; a create naming an unknown one makes it, like GitHub
  jobs.json          {"total_count": n, "jobs": [...]}  the run attempt's job list
  comments.json      {"<n>": [body, ...]}
  calls.log          one line per call: "<METHOD> <path>"
Failure injection (files):
  F_jobs                 job list → HTTP 502
  F_list_<page>          that page of the issue list → HTTP 502
  F_label                label read → HTTP 502
  F_create               issue create → HTTP 502
  F_create_nolabel       issue create succeeds but drops the labels
  F_readback             any GET of a single issue after a create → HTTP 502
  F_comment              comment create → HTTP 502
  getpatch_<n>           JSON object merged into every GET issues/<n> response (state untouched)
  hook_get_<n>           JSON object merged into stored issue <n> right before its next GET (consumed)
"""
import json, os, re, sys, urllib.parse

D = os.environ["FAKE_GH_DIR"]
REPO = os.environ["GITHUB_REPOSITORY"]
BASE = "repos/" + REPO + "/"


def p(n):
    return os.path.join(D, n)


def load(n, d):
    try:
        with open(p(n)) as f:
            return json.load(f)
    except FileNotFoundError:
        return d


def save(n, v):
    with open(p(n) + ".tmp", "w") as f:
        json.dump(v, f)
    os.replace(p(n) + ".tmp", p(n))


def has(n):
    return os.path.exists(p(n))


def die(code, msg):
    print(json.dumps({"message": msg}))
    sys.stderr.write(f"gh: {msg} (HTTP {code})\n")
    sys.exit(1)


a = sys.argv[1:]
if not a or a[0] != "api":
    sys.exit(9)
method, path, inp = "GET", None, None
i = 1
while i < len(a):
    if a[i] == "-X":
        method = a[i + 1]; i += 2
    elif a[i] == "--input":
        inp = a[i + 1]; i += 2
    else:
        path = a[i]; i += 1
with open(p("calls.log"), "a") as f:
    f.write(f"{method} {path}\n")
payload = json.load(open(inp)) if inp else None
if not path.startswith(BASE):
    die(404, "Not Found")
rest, _, qs = path[len(BASE):].partition("?")
q = dict(urllib.parse.parse_qsl(qs))
issues = load("issues.json", [])
byno = {it.get("number"): it for it in issues}

if method == "GET" and re.fullmatch(r"actions/runs/\d+/attempts/\d+/jobs", rest):
    if has("F_jobs"):
        die(502, "Bad Gateway")
    print(json.dumps(load("jobs.json", {"total_count": 0, "jobs": []})))
    sys.exit(0)

if method == "GET" and rest == "issues":
    page, per = int(q.get("page", 1)), int(q.get("per_page", 30))
    if has(f"F_list_{page}"):
        die(502, "Bad Gateway")
    sel = [it for it in issues if it.get("state", "open") == q.get("state", "open")
           and (it.get("user") or {}).get("login") == q.get("creator", (it.get("user") or {}).get("login"))]
    sel.sort(key=lambda it: -(it.get("number") or 0))
    print(json.dumps(sel[(page - 1) * per: page * per]))
    sys.exit(0)

m = re.fullmatch(r"issues/(\d+)", rest)
if method == "GET" and m:
    n = int(m.group(1))
    if has("F_readback") and has("created"):
        die(502, "Bad Gateway")
    if has(f"hook_get_{n}") and n in byno:
        byno[n].update(json.load(open(p(f"hook_get_{n}"))))
        os.unlink(p(f"hook_get_{n}"))
        save("issues.json", issues)
    if n not in byno:
        die(404, "Not Found")
    out = dict(byno[n])
    out["repository_url"] = "https://api.github.com/repos/" + REPO
    if has(f"getpatch_{n}"):
        out.update(json.load(open(p(f"getpatch_{n}"))))
    print(json.dumps(out))
    sys.exit(0)

m = re.fullmatch(r"labels/(.+)", rest)
if method == "GET" and m:
    if has("F_label"):
        die(502, "Bad Gateway")
    name = urllib.parse.unquote(m.group(1))
    if name not in load("repo_labels.json", []):
        die(404, "Not Found")
    print(json.dumps({"name": name}))
    sys.exit(0)

if method == "POST" and rest == "issues":
    if has("F_create"):
        die(502, "Bad Gateway")
    n = max([it.get("number") or 0 for it in issues] + [0]) + 1
    labels = list(payload.get("labels") or [])
    rl = load("repo_labels.json", [])
    for l in labels:
        if l not in rl:
            rl.append(l)  # what GitHub does: an unknown label name is created on the spot
    save("repo_labels.json", rl)
    if has("F_create_nolabel"):
        labels = []
    it = {"number": n, "title": payload["title"], "state": "open", "user": {"login": "github-actions[bot]"},
          "body": payload["body"], "html_url": f"https://github.com/{REPO}/issues/{n}",
          "labels": [{"name": l} for l in labels]}
    issues.append(it)
    save("issues.json", issues)
    open(p("created"), "w").close()
    print(json.dumps(it))
    sys.exit(0)

m = re.fullmatch(r"issues/(\d+)/comments", rest)
if method == "POST" and m:
    if has("F_comment"):
        die(502, "Bad Gateway")
    c = load("comments.json", {})
    c.setdefault(m.group(1), []).append(payload["body"])
    save("comments.json", c)
    print(json.dumps({"id": 1}))
    sys.exit(0)

# Anything else (label writes, issue edits, …) is recorded in calls.log and answered: the test
# asserts it never happens.
print("{}")
