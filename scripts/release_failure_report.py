#!/usr/bin/env python3
"""Release workflow failed → open an issue, or comment on the open one of the same kind (GitHub#285).

Run by the `report failure` job of .github/workflows/release.yml after every run in which a job
it depends on failed (scheduled, tag push, manual release, manual gate-only). It only ever does one
of two writes, and never touches an existing issue's labels:

  find     list this repo's open issues created by the CI account (`github-actions[bot]`) whose body
           carries MARKER; page by page, every item checked for the fields the judgement uses.
           Any page that fails or any item missing a field → "don't know": no write, exit 1.
  create   (0 found) read whether the dispatch label exists (404 → create without it, exit 1, so
           GitHub does not invent a same-named label; any other failure → no write), find again
           right before writing (still 0 → create, ≥1 → comment), one create request carrying
           title, body and the label; then read the issue back: label missing / unreadable → exit 1
           and say so ("issue #N created, dispatch label not on it"). Never patched up afterwards.
  comment  (≥1 found) the lowest number; re-read it right before writing and compare repository,
           number, open, creator, marker. Mismatch → find once more and go by that; still a
           mismatch → no write, exit 1. Its labels are neither read for the decision nor written.

All GitHub access goes through `gh api` (REST) with the job's token.

Input (environment):
  GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT (default 1), GITHUB_SERVER_URL,
  GITHUB_SHA, GITHUB_REF_NAME   as Actions sets them
  EVENT          github.event_name
  GATE_ONLY      "true" for a manual gate-only run
  NEEDS          toJSON(needs) of the report job
  DISPATCH_LABEL the label that makes the daemon dispatch (default pending/agent)
  SELF_JOB       this job's name in the run's job list (default "report failure")
  SUMMARY_DIR    the gate summary's saved output (verify.md / tally.md), when downloaded
  CLIENT_DIR     the client gate's "did not go red" list (not-red.txt), when uploaded
  GITHUB_STEP_SUMMARY  where the one-line outcome is appended (optional)

Exit: 0 = nothing to report, or the report was written in full; 1 = anything else (see above).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse

MARKER = "<!-- cavil-release-failure -->"
CI_LOGIN = "github-actions[bot]"
PER_PAGE = 100
MAX_PAGES = 30
TITLE = "Release 工作流运行失败（自动报告）"

REPO = os.environ.get("GITHUB_REPOSITORY", "")
RUN_ID = os.environ.get("GITHUB_RUN_ID", "")
ATTEMPT = os.environ.get("GITHUB_RUN_ATTEMPT", "") or "1"
SERVER = (os.environ.get("GITHUB_SERVER_URL", "") or "https://github.com").rstrip("/")
EVENT = os.environ.get("EVENT", "")
GATE_ONLY = os.environ.get("GATE_ONLY", "") == "true"
LABEL = os.environ.get("DISPATCH_LABEL", "") or "pending/agent"
SELF_JOB = os.environ.get("SELF_JOB", "") or "report failure"
RUN_URL = f"{SERVER}/{REPO}/actions/runs/{RUN_ID}" + (f"/attempts/{ATTEMPT}" if ATTEMPT != "1" else "")

problems = []  # every reason this job ends red, in order


def log(msg):
    sys.stderr.write(msg + "\n")


def red(msg):
    problems.append(msg)
    print(f"::error::{msg}")


class GhError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status  # HTTP status when gh named one, else None
        self.detail = detail


def gh(method, path, payload=None):
    """One REST call. Returns the decoded JSON; raises GhError on any failure (non-zero exit,
    or output that is not JSON)."""
    cmd = ["gh", "api", "-X", method, path]
    tmp = None
    try:
        if payload is not None:
            fd, tmp = tempfile.mkstemp(prefix="release-failure-", suffix=".json")
            with os.fdopen(fd, "w") as f:
                json.dump(payload, f)
            cmd += ["--input", tmp]
        r = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        if tmp:
            os.unlink(tmp)
    if r.returncode != 0:
        m = re.search(r"HTTP (\d{3})", r.stderr)
        raise GhError(int(m.group(1)) if m else None,
                      f"{method} {path}: exit {r.returncode}: {r.stderr.strip()[:300]}")
    try:
        return json.loads(r.stdout)
    except ValueError:
        raise GhError(None, f"{method} {path}: response is not JSON")


# ── what failed ────────────────────────────────────────────────────────────────

def read_needs():
    try:
        needs = json.loads(os.environ.get("NEEDS", "") or "null")
    except ValueError:
        needs = None
    if not isinstance(needs, dict) or not needs:
        return None
    return needs


def job_list():
    """This run attempt's jobs, or None when any page cannot be read whole."""
    jobs, page = [], 1
    while page <= MAX_PAGES:
        try:
            d = gh("GET", f"repos/{REPO}/actions/runs/{RUN_ID}/attempts/{ATTEMPT}/jobs?per_page={PER_PAGE}&page={page}")
        except GhError as e:
            log(f"job list: {e.detail}")
            return None
        got = d.get("jobs") if isinstance(d, dict) else None
        total = d.get("total_count") if isinstance(d, dict) else None
        if not isinstance(got, list) or not isinstance(total, int):
            return None
        for j in got:
            if not isinstance(j, dict) or not isinstance(j.get("name"), str) or not isinstance(j.get("steps", []), list):
                return None
        jobs += got
        if len(jobs) >= total or not got:
            return jobs if len(jobs) >= total else None
        page += 1
    return None


def failed_steps(job):
    return [s.get("name") or "?" for s in job.get("steps") or [] if isinstance(s, dict) and s.get("conclusion") == "failure"]


def job_section(needs, jobs):
    """Markdown lines for the job layer, plus the release-only sentence when it applies."""
    out = []
    if jobs is not None:
        jobs = [j for j in jobs if j.get("name") != SELF_JOB]
        out.append("| 任务 | 结论 | 失败的步骤 |")
        out.append("|---|---|---|")
        for j in jobs:
            concl = j.get("conclusion") or j.get("status") or "?"
            steps = "、".join(f"「{s}」" for s in failed_steps(j)) or "—"
            name = j["name"]
            if j.get("html_url"):
                name = f"[{name}]({j['html_url']})"
            mark = "❌ " if concl == "failure" else ""
            out.append(f"| {mark}{name} | {concl} | {steps} |")
    else:
        out.append("⚠️ 步骤明细读不到（本次运行的任务列表读取失败），下面只有各依赖任务的结果：")
        out.append("")
        out.append("| 任务 | 结论 |")
        out.append("|---|---|")
        for name, v in needs.items():
            res = v.get("result", "?") if isinstance(v, dict) else "?"
            out.append(f"| {'❌ ' if res == 'failure' else ''}`{name}` | {res} |")
    return out


def release_only_line(needs, jobs):
    """Gate passed, release failed → say where it failed."""
    res = {k: (v.get("result") if isinstance(v, dict) else None) for k, v in needs.items()}
    if res.get("release") != "failure":
        return None
    if any(r == "failure" for k, r in res.items() if k != "release"):
        return None
    steps = []
    if jobs is not None:
        for j in jobs:
            if j.get("name") == "release":
                steps = failed_steps(j)
    if steps:
        return "门禁已通过，发版在" + "、".join(f"『{s}』" for s in steps) + "失败。"
    return "门禁已通过，发版任务失败（步骤明细读不到）。"


def read_text(d, name):
    if not d:
        return None
    try:
        with open(os.path.join(d, name), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def shell_section():
    d = os.environ.get("SUMMARY_DIR", "")
    verify, tally = read_text(d, "verify.md"), read_text(d, "tally.md")
    if verify is None and tally is None:
        return []
    out = ["### shell 测试单位", ""]
    if verify is not None:
        lines = [l for l in verify.splitlines() if l.startswith("- ❌ ")]
        head = next((l for l in verify.splitlines() if l.startswith("## ")), "")
        out.append(f"四个分片的核对：{head[3:].strip() or '（没有结论行）'}")
        out += lines
        out.append("")
    if tally is not None:
        ls = tally.splitlines()
        if "没通过的单位：" in ls:
            i = ls.index("没通过的单位：")
            bad = [l for l in ls[i + 1:] if l.startswith("- ")]
            out.append("负对照汇总（含 autopilot 六个任务）里没通过的单位：")
            out += bad
        else:
            out.append("负对照汇总（含 autopilot 六个任务）里没有没通过的单位。")
        out.append("")
    return out


def client_section(needs, jobs):
    res = needs.get("gate-client", {}).get("result") if isinstance(needs.get("gate-client"), dict) else None
    if res != "failure":
        return []
    txt = read_text(os.environ.get("CLIENT_DIR", ""), "not-red.txt")
    out = ["### 客户端负对照", ""]
    if txt is not None and txt.strip():
        out.append("没按预期变红的条目：")
        out += [f"- {l.strip()}" for l in txt.splitlines() if l.strip()]
    else:
        link = ""
        for j in jobs or []:
            if j.get("name") == "gate client" and j.get("html_url"):
                link = f"（[任务日志]({j['html_url']})）"
        out.append(f"客户端没留下条目清单，见该任务日志{link}。")
    out.append("")
    return out


def trigger_text():
    if EVENT == "schedule":
        return "定时（每周）"
    if EVENT == "push":
        return f"tag 推送（`{os.environ.get('GITHUB_REF_NAME', '')}`）"
    if EVENT == "workflow_dispatch":
        return "手动只跑门禁" if GATE_ONLY else "手动发版"
    return EVENT or "?"


def report_text(needs, jobs):
    sha = ""
    plan = needs.get("plan")
    if isinstance(plan, dict):
        sha = (plan.get("outputs") or {}).get("sha") or ""
    sha_line = f"`{sha}`" if sha else f"`{os.environ.get('GITHUB_SHA', '?')}`（计划任务没给出受测提交，这是本次运行检出的提交）"
    lines = [
        f"- 运行：{RUN_URL}",
        f"- 触发：{trigger_text()}",
        f"- 受测提交：{sha_line}",
    ]
    if EVENT == "workflow_dispatch" and GATE_ONLY:
        lines.append("- 这是诊断运行（只跑门禁，不打 tag、不发版）")
    one = release_only_line(needs, jobs)
    if one:
        lines += ["", f"**{one}**"]
    lines += ["", "### 各任务结果", ""] + job_section(needs, jobs) + [""]
    lines += shell_section()
    lines += client_section(needs, jobs)
    return "\n".join(lines).rstrip() + "\n"


# ── GitHub writes ──────────────────────────────────────────────────────────────

class Unknown(Exception):
    pass


def is_pr(it):
    return "pull_request" in it or "/pull/" in it.get("html_url", "")


def find():
    """Numbers of the open same-kind issues, ascending. Raises Unknown when the answer is not known."""
    found, page = [], 1
    creator = urllib.parse.quote(CI_LOGIN, safe="")
    while True:
        if page > MAX_PAGES:
            raise Unknown(f"列同类 issue 超过 {MAX_PAGES} 页，没有读完")
        try:
            items = gh("GET", f"repos/{REPO}/issues?state=open&creator={creator}&per_page={PER_PAGE}&page={page}")
        except GhError as e:
            raise Unknown(f"列同类 issue 第 {page} 页读取失败：{e.detail}")
        if not isinstance(items, list):
            raise Unknown(f"列同类 issue 第 {page} 页不是列表")
        for it in items:
            if not isinstance(it, dict):
                raise Unknown(f"列同类 issue 第 {page} 页有一条不是对象")
            miss = [k for k in ("number", "state", "user", "body", "html_url") if k not in it]
            if not miss and not (isinstance(it["user"], dict) and isinstance(it["user"].get("login"), str)):
                miss.append("user.login")
            if not miss and not isinstance(it["number"], int):
                miss.append("number")
            if miss:
                raise Unknown(f"列同类 issue 第 {page} 页有一条缺字段：{', '.join(miss)}")
            if is_pr(it) or it["state"] != "open" or it["user"]["login"] != CI_LOGIN:
                continue
            if MARKER in (it["body"] or ""):
                found.append(it["number"])
        if len(items) < PER_PAGE:
            return sorted(found)
        page += 1


def still_target(n):
    """Re-read issue n right before commenting; None when it still is the target, else why not."""
    try:
        it = gh("GET", f"repos/{REPO}/issues/{n}")
    except GhError as e:
        return f"重读 #{n} 失败：{e.detail}"
    if not isinstance(it, dict):
        return f"重读 #{n}：响应不是对象"
    repo_url = str(it.get("repository_url", ""))
    checks = [
        (repo_url.lower().endswith("/repos/" + REPO.lower()), "仓库不符"),
        (it.get("number") == n, "编号不符"),
        (it.get("state") == "open", "已不是打开状态"),
        (isinstance(it.get("user"), dict) and it["user"].get("login") == CI_LOGIN, "创建者不是 CI 账号"),
        (MARKER in (it.get("body") or ""), "正文里没有标记了"),
        (not is_pr(it), "是 PR"),
    ]
    bad = [why for ok, why in checks if not ok]
    return f"#{n}：" + "、".join(bad) if bad else None


def comment(n, others, report):
    body = "## 又一次发版运行失败\n\n" + report
    if others:
        body += "\n其余同类 issue：" + "、".join(f"#{o}" for o in others) + "\n"
    try:
        gh("POST", f"repos/{REPO}/issues/{n}/comments", {"body": body})
    except GhError as e:
        red(f"在 #{n} 下评论失败：{e.detail}")
        return
    print(f"已在同类 issue #{n} 下评论")
    summary(f"发版失败已评论在 #{n}")


def create(report):
    try:
        gh("GET", f"repos/{REPO}/labels/{urllib.parse.quote(LABEL, safe='')}")
        with_label = True
    except GhError as e:
        if e.status != 404:
            red(f"读取派工标签 {LABEL} 失败，本次不写：{e.detail}")
            return
        with_label = False
    # the second look, right before writing
    try:
        again = find()
    except Unknown as e:
        red(f"新建前复查失败，本次不写：{e}")
        return
    if again:
        print(f"新建前复查找到同类 issue #{again[0]}，改为评论")
        do_comment(again, report, retried=True)
        return
    body = (MARKER + "\n## 发版运行失败\n\n"
            "这条 issue 由 Release 工作流自动创建。之后的发版运行再失败，会作为评论追加在这里；"
            "关闭本 issue 后，下一次失败会新建一条。\n\n" + report)
    payload = {"title": TITLE, "body": body}
    if with_label:
        payload["labels"] = [LABEL]
    try:
        made = gh("POST", f"repos/{REPO}/issues", payload)
        n = made["number"]
        if not isinstance(n, int):
            raise KeyError
    except GhError as e:
        red(f"新建 issue 失败（不重试；若其实已建成，下一次运行会找到它并评论）：{e.detail}")
        return
    except (KeyError, TypeError):
        red("新建 issue 的响应里没有编号（不重试；若其实已建成，下一次运行会找到它并评论）")
        return
    print(f"已新建 issue #{n}")
    if not with_label:
        red(f"本仓库没有派工标签 {LABEL}：issue #{n} 已建、派工标签没打上，需维护者手动打 {LABEL}")
        summary(f"发版失败已新建 #{n}（没有派工标签）")
        return
    try:
        back = gh("GET", f"repos/{REPO}/issues/{n}")
        names = [l.get("name") for l in back.get("labels") or [] if isinstance(l, dict)]
    except (GhError, AttributeError) as e:
        red(f"issue #{n} 已建、读回失败，派工标签是否打上不知道，需维护者核对并手动打 {LABEL}：{getattr(e, 'detail', e)}")
        summary(f"发版失败已新建 #{n}（读回失败）")
        return
    if LABEL not in names:
        red(f"issue #{n} 已建、派工标签没打上，需维护者手动打 {LABEL}")
        summary(f"发版失败已新建 #{n}（派工标签没打上）")
        return
    summary(f"发版失败已新建 #{n}，已打 {LABEL}")


def do_comment(found, report, retried=False):
    n = found[0]
    why = still_target(n)
    if why is None:
        comment(n, found[1:], report)
        return
    if retried:
        red(f"写前重读不符，本次不写：{why}")
        return
    print(f"写前重读不符（{why}），重查一次")
    try:
        again = find()
    except Unknown as e:
        red(f"重查失败，本次不写：{e}")
        return
    if not again:
        create(report)
        return
    do_comment(again, report, retried=True)


def summary(line):
    p = os.environ.get("GITHUB_STEP_SUMMARY", "")
    if p:
        with open(p, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def main():
    if not REPO or not RUN_ID:
        red("缺 GITHUB_REPOSITORY / GITHUB_RUN_ID")
        return 1
    needs = read_needs()
    if needs is None:
        red("NEEDS 读不出来（不是非空的 JSON 对象），不知道哪些任务失败，本次不写")
        return 1
    if not any(isinstance(v, dict) and v.get("result") == "failure" for v in needs.values()):
        print("没有失败的任务，不报告")
        return 0
    report = report_text(needs, job_list())
    try:
        found = find()
    except Unknown as e:
        red(f"{e}；不知道有没有同类 issue，本次不写")
        return 1
    if found:
        do_comment(found, report)
    else:
        create(report)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
