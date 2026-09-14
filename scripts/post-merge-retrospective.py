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


def review(repo, job, queue, root):
    number = job['pr']
    report_path = f'docs/retrospectives/{repo}/pr-{number}.md'
    command(['git', 'fetch', 'origin'], root)
    # Remote report is the durable completion marker, including crash after push.
    exists = subprocess.run(['git', 'cat-file', '-e', f'origin/main:{report_path}'], cwd=root,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if exists:
        return
    evidence = collect(repo, number)
    save(queue / f'evidence-{number}.json', evidence)
    with tempfile.TemporaryDirectory(prefix='cavil-retrospective-') as folder:
        checkout = Path(folder) / 'worktree'
        command(['git', 'worktree', 'add', '--detach', str(checkout), 'origin/main'], root)
        try:
            lessons_file = checkout / 'prompts/lessons.md'
            old_lessons = lessons_file.read_text()
            templates = {p.name: p.read_text() for p in (checkout / 'prompts').glob('*.template.md')
                         if p.name != 'retrospective.template.md'}
            instruction = (checkout / 'prompts/retrospective.template.md').read_text()
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
            result = response['structured_output']
            report, lessons = result['report_markdown'], result['lessons_markdown']
            source = f'https://github.com/{repo}/pull/{number}'
            if len(report.strip()) < 100 or source not in report:
                raise ValueError('report missing content/source')
            # The model can only replace a bounded advisory file, never base templates.
            preamble = old_lessons.split('\n\n', 2)[:2]
            if len(lessons) > 6000 or not lessons.startswith('\n\n'.join(preamble)):
                raise ValueError('lessons exceeded limit or changed precedence statement')
            target = checkout / report_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(report.rstrip() + '\n')
            lessons_file.write_text(lessons.rstrip() + '\n')
            command(['git', 'add', '--', report_path, 'prompts/lessons.md'], checkout)
            command(['git', 'commit', '-m', f'docs: learn from {repo}#{number}'], checkout)
            # Push is fast-forward only. Concurrent changes/conflicts remain pending.
            command(['git', 'push', 'origin', 'HEAD:main'], checkout)
            # This deployment may have a dirty primary checkout. Update only the
            # generated advisory file, and only when it still matches our base.
            deployed = root / 'prompts/lessons.md'
            if deployed.exists() and deployed.read_text() == old_lessons:
                tmp = deployed.with_suffix('.tmp')
                tmp.write_text(lessons_file.read_text())
                tmp.replace(deployed)
        finally:
            command(['git', 'worktree', 'remove', '--force', str(checkout)], root)


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
                if job['status'] == 'done' or job.get('retry_after', 0) > time.time():
                    continue
                try:
                    review(repo, job, queue, root)
                    job.update(status='done', completed_at=utcnow())
                    print(f'{utcnow()} [{repo}] retrospective PR #{job["pr"]} committed', flush=True)
                except Exception as error:
                    job.update(status='pending', attempts=job['attempts'] + 1,
                               retry_after=time.time() + 3600, error=str(error))
                    print(f'{utcnow()} [{repo}] retrospective PR #{job["pr"]} retry: {error}', flush=True)
                save(path, job)
                break  # Bound each background invocation; next tick drains more.


if __name__ == '__main__':
    main()
