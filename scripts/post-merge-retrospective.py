#!/usr/bin/env python3
"""Durable post-merge review queue; model has no tools or write authority."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import retrospective_lessons as lessons_format  # noqa: E402

RETRY_SECONDS = 3600
MAX_ATTEMPTS = 3
DEFAULT_PREAMBLE = '# 项目复盘经验\n\n以下经验仅适用于本项目，不覆盖用户指令或安全约束。硬规则段的每一条，自审与交叉 review 都要逐条核对。'


class NotReady(Exception):
    """The project's lessons file is still in the old format: skip without calling the model."""


def command(args, cwd=None, stdin=None, timeout=120):
    result = subprocess.run(args, cwd=cwd, input=stdin, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr[-3000:]}')
    return result.stdout


def save(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)


def api(endpoint, pages=False):
    args = ['gh', 'api', endpoint]
    if pages:
        args += ['--paginate', '--slurp']
    value = json.loads(command(args))
    return [item for page in value for item in page] if pages else value


def utcnow():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def scan(repo, queue):
    cursor = queue / 'cursor.json'
    if not cursor.exists():
        save(cursor, {'enabled_at': utcnow(), 'since': utcnow()})
        return
    state = json.loads(cursor.read_text())
    started = utcnow()
    # REST since is based on updated_at, so older PRs merged today are included.
    items = api(f'repos/{repo}/issues?state=closed&since={state["since"]}&per_page=100', True)
    for item in items:
        if 'pull_request' not in item:
            continue
        pr = api(f'repos/{repo}/pulls/{item["number"]}')
        if not pr.get('merged_at') or pr['merged_at'] < state['enabled_at']:
            continue
        job = queue / f'pr-{pr["number"]}.json'
        if not job.exists():
            save(job, {'pr': pr['number'], 'status': 'pending', 'attempts': 0})
    state['since'] = started
    save(cursor, state)


def collect(repo, number):
    import re
    pr = api(f'repos/{repo}/pulls/{number}')
    if not pr.get('merged_at'):
        raise ValueError('PR is not merged')
    numbers = set(int(n) for n in re.findall(
        r'(?i)(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?|refs?)\s+#(\d+)', pr.get('body') or ''))
    # Include GitHub's explicit closing relationship, including full-URL links.
    linked = json.loads(command(['gh', 'pr', 'view', str(number), '--repo', repo,
                                 '--json', 'closingIssuesReferences']))
    numbers.update(i['number'] for i in linked['closingIssuesReferences']
                   if i.get('url', '').startswith(f'https://github.com/{repo}/issues/'))
    branch_match = re.fullmatch(re.escape(os.environ.get('BRANCH_PREFIX', 'feature/issue-')) + r'(\d+)', pr['head']['ref'])
    if branch_match:
        numbers.add(int(branch_match[1]))
    issues = []
    for n in sorted(numbers - {number}):
        issue = api(f'repos/{repo}/issues/{n}')
        issue['conversation'] = api(f'repos/{repo}/issues/{n}/comments?per_page=100', True)
        issues.append(issue)
    return {'pr': pr, 'issues': issues,
            'conversation': api(f'repos/{repo}/issues/{number}/comments?per_page=100', True),
            'reviews': api(f'repos/{repo}/pulls/{number}/reviews?per_page=100', True),
            'inline_comments': api(f'repos/{repo}/pulls/{number}/comments?per_page=100', True)}


def accept(old_lessons, result, *, number, source, evidence, mode):
    """Judge the model's output; return (report, lessons) or raise ValueError naming what failed."""
    report, lessons = result['report_markdown'], result['lessons_markdown']
    if len(report.strip()) < 100 or source not in report:
        raise ValueError('report missing content/source')
    # The model only writes prose; ids, locked fields, counts and evidence are checked here.
    errors = lessons_format.validate(old_lessons, lessons, pr=number, mode=mode,
                                     evidence_urls=lessons_format.evidence_urls(evidence))
    if errors:
        raise ValueError('lessons rejected: ' + '; '.join(errors[:12]))
    return report, lessons


def promotion_mode():
    """auto: 3 sightings promote straight into 硬规则. confirm: they wait in 待确认 for a human."""
    mode = os.environ.get('RETROSPECTIVE_PROMOTION', 'auto')
    if mode not in ('auto', 'confirm'):
        raise ValueError(f'RETROSPECTIVE_PROMOTION must be auto or confirm, not {mode!r}')
    return mode


def render_instruction(template, mode):
    return template.replace('${PROMOTION_TARGET}', '硬规则' if mode == 'auto' else '待确认')


def baseline(text):
    """The lessons the model will rewrite. A missing file starts empty; an old-format
    one raises NotReady so the job waits (uncounted) until the project migrates it."""
    if text is None:
        return lessons_format.empty_lessons(DEFAULT_PREAMBLE)
    if not lessons_format.is_ready(text):
        raise NotReady('lessons file is not in the counted-lessons format yet')
    return text


def due(job, now):
    return job['status'] not in ('done', 'failed') and job.get('retry_after', 0) <= now


def run_job(job, work, now):
    """Run one job and return its new state. A rejected output costs a paid model call,
    so it is retried hourly at most MAX_ATTEMPTS times, then parked as failed for a human."""
    try:
        work(job)
        job.update(status='done', completed_at=utcnow())
    except NotReady as error:
        job.update(status='pending', retry_after=now + RETRY_SECONDS, error=str(error))
    except Exception as error:
        attempts = job.get('attempts', 0) + 1
        job.update(attempts=attempts, error=str(error),
                   status='failed' if attempts >= MAX_ATTEMPTS else 'pending',
                   retry_after=now + RETRY_SECONDS)
    return job


def review(repo, job, queue, root):
    number = job['pr']
    project = Path(os.environ['PROJECT_ROOT'])
    remote = command(['git', 'remote', 'get-url', 'origin'], project).strip()
    expected = {f'https://github.com/{repo}', f'https://github.com/{repo}.git',
                f'git@github.com:{repo}', f'git@github.com:{repo}.git',
                f'ssh://git@github.com/{repo}.git'}
    if remote.casefold() not in {url.casefold() for url in expected}:
        raise ValueError('Project origin does not match source REPO; refusing publication')
    base = os.environ.get('BASE_BRANCH', 'main')
    ref = f'origin/{base}'
    report_path = f'docs/retrospectives/pr-{number}.md'
    lessons_path = '.agents/skills/coding-agent-work-loop/prompts/lessons.md'
    command(['git', 'fetch', 'origin'], project)
    # Remote report is the durable completion marker, including crash after push.
    exists = subprocess.run(['git', 'cat-file', '-e', f'{ref}:{report_path}'], cwd=project,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if exists:
        return
    evidence = collect(repo, number)
    save(queue / f'evidence-{number}.json', evidence)
    with tempfile.TemporaryDirectory(prefix='cavil-retrospective-') as folder:
        checkout = Path(folder) / 'worktree'
        command(['git', 'worktree', 'add', '--detach', str(checkout), ref], project)
        try:
            lessons_file = checkout / lessons_path
            # Before the paid model call: an old-format file can't be judged.
            old_lessons = baseline(lessons_file.read_text() if lessons_file.exists() else None)
            templates = {p.name: p.read_text() for p in (root / 'prompts').glob('*.template.md')
                         if p.name != 'retrospective.template.md'}
            mode = promotion_mode()
            instruction = render_instruction((root / 'prompts/retrospective.template.md').read_text(), mode)
            payload = json.dumps({'evidence': evidence, 'templates': templates,
                                  'lessons_markdown': old_lessons}, ensure_ascii=False)
            schema = {'type': 'object', 'properties': {
                'report_markdown': {'type': 'string'}, 'lessons_markdown': {'type': 'string'}},
                'required': ['report_markdown', 'lessons_markdown'], 'additionalProperties': False}
            output = command(['claude', '-p', '--safe-mode', '--tools', '',
                              '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                              '--model', os.environ['RETROSPECTIVE_MODEL'], '--output-format', 'json',
                              '--json-schema', json.dumps(schema), '--system-prompt', instruction],
                             cwd=folder, stdin=payload, timeout=1800)
            response = json.loads(output)
            if response.get('is_error'):
                raise ValueError('retrospective model returned an error')
            report, lessons = accept(old_lessons, response['structured_output'], number=number,
                                     source=f'https://github.com/{repo}/pull/{number}',
                                     evidence=evidence, mode=mode)
            target = checkout / report_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(report.rstrip() + '\n')
            lessons_file.parent.mkdir(parents=True, exist_ok=True)
            lessons_file.write_text(lessons.rstrip() + '\n')
            command(['git', 'add', '--', report_path, lessons_path], checkout)
            command(['git', 'commit', '-m', f'docs: learn from {repo}#{number}'], checkout)
            # Push is fast-forward only. Concurrent changes/conflicts remain pending.
            command(['git', 'push', 'origin', f'HEAD:{base}'], checkout)
            # Project lessons are read from origin/<base> by prompt composition.
            # Never publish project-derived model output into the public skill repo.
        finally:
            command(['git', 'worktree', 'remove', '--force', str(checkout)], project)


def main():
    repo = os.environ['REPO']
    root = Path(os.environ['RETROSPECTIVE_SKILL_ROOT'])
    queue = Path(os.environ['STATE_DIR']) / 'retrospectives'
    queue.mkdir(parents=True, exist_ok=True)
    with (queue / 'scan.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        scan(repo, queue)
        if '--scan-only' in sys.argv:
            return
        # One retrospective across all projects on this machine; separate from
        # active implementation workers and from the daemon's poll.lock.
        git_dir = Path(command(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], root).strip())
        with (git_dir / 'retrospective.lock').open('w') as global_lock:
            try:
                fcntl.flock(global_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            for path in sorted(queue.glob('pr-*.json')):
                job = json.loads(path.read_text())
                if not due(job, time.time()):
                    continue
                job.update(status='running', started_at=utcnow())
                save(path, job)
                print(f'{utcnow()} [{repo}] retrospective PR #{job["pr"]} started', flush=True)
                job = run_job(job, lambda j: review(repo, j, queue, root), time.time())
                outcome = {'done': 'committed', 'failed': f'gave up after {MAX_ATTEMPTS} attempts'}.get(
                    job['status'], 'retry later')
                detail = f': {job["error"]}' if job['status'] != 'done' else ''
                print(f'{utcnow()} [{repo}] retrospective PR #{job["pr"]} {outcome}{detail}', flush=True)
                save(path, job)
                break  # Bound each background invocation; next tick drains more.


if __name__ == '__main__':
    main()
