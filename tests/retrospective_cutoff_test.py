"""End-to-end cases for GitHub#168 (run via tests/retrospective-directory-cutoff.test.sh).

Every case runs the real entry, `scripts/post-merge-retrospective.sh`, in a clean
environment (`env -i`): it sources `_lib.sh`, exports the switch itself and execs the
python runner. Only the outside world is fake — `gh` answers from a small table and
logs every call, `claude` logs its input and answers like a well-behaved model, `git`
is real except `remote get-url` (the project's origin is a local bare repository).
Faults on single files are injected from outside the code under test, through a
`sitecustomize` that wraps pathlib only for the names a case lists.

RETRO_RELEASE points at the scripts/ + prompts/ to test (default: this checkout),
so the wrapper can rerun everything against a broken copy.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_DIR = HERE.parent
RELEASE = Path(os.environ.get('RETRO_RELEASE', REPO_DIR))
sys.path.insert(0, str(REPO_DIR / 'scripts'))
import retrospective_lessons as rl  # noqa: E402

REPO = 'acme/widget'
U = f'https://github.com/{REPO}'
LESSONS = '.agents/skills/cavil-loop/prompts/lessons.md'
OLD, MID, NEW = '2020-01-01T00:00:00Z', '2025-01-01T00:00:00Z', '2099-01-01T00:00:00Z'
REAL_GIT = shutil.which('git')

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, re, sys
d = os.environ['FAKE_DIR']
args = sys.argv[1:]
with open(os.path.join(d, 'gh.log'), 'a') as f:
    f.write(' '.join(args) + '\n')
prs = json.load(open(os.path.join(d, 'prs.json')))
fail = json.load(open(os.path.join(d, 'gh-fail.json')))
repo = os.environ['FAKE_REPO']
def out(v):
    print(json.dumps(v)); sys.exit(0)
if args[:2] == ['pr', 'view']:
    out({'closingIssuesReferences': []})
if args[0] != 'api':
    sys.exit(2)
ep = args[1]
if ep in fail:
    print('gh: Server Error (HTTP 502)', file=sys.stderr); sys.exit(1)
slurp = '--slurp' in args
m = re.fullmatch(rf'repos/{re.escape(repo)}/pulls/(\d+)', ep)
if m:
    n = m[1]
    if n not in prs:
        print('gh: Not Found (HTTP 404)', file=sys.stderr); sys.exit(1)
    out({'number': int(n), 'merged_at': prs[n], 'body': '', 'head': {'ref': f'topic-{n}'},
         'html_url': f'https://github.com/{repo}/pull/{n}'})
m = re.fullmatch(rf'repos/{re.escape(repo)}/issues/(\d+)/comments\?per_page=100', ep)
if m:
    out([[{'html_url': f'https://github.com/{repo}/pull/{m[1]}#issuecomment-{m[1]}00', 'body': 'review'}]])
m = re.fullmatch(rf'repos/{re.escape(repo)}/pulls/(\d+)/files\?per_page=100', ep)
if m:
    out([[{'filename': 'src/app/main.py'}]])
out([[]] if slurp else [])
'''

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, re, sys
d = os.environ['FAKE_DIR']
sys.path.insert(0, os.environ['RL_DIR'])
import retrospective_lessons as rl
args = sys.argv[1:]
payload = json.loads(sys.stdin.read())
n = len([p for p in os.listdir(d) if p.startswith('model-')]) + 1
json.dump({'instruction': args[args.index('--system-prompt') + 1], 'input': payload},
          open(os.path.join(d, f'model-{n}.json'), 'w'), ensure_ascii=False)
ev = payload['evidence']
pr = int(ev['pr']['html_url'].rsplit('/', 1)[1])
url = ev['conversation'][0]['html_url']
text = payload['lessons_markdown']
# A well-behaved model: count this PR on L1, and file one directory lesson when it got directories.
text = re.sub(r'^(- Seen )(\d+)(×:.*)$',
              lambda m: f'{m[1]}{int(m[2]) + 1}{m[3]} · #{pr} {url}', text, count=1, flags=re.M)
dirs = payload.get('directories')
if dirs:
    nid = rl.parse(text).next_id
    text = text.replace(f'<!-- next-id: {nid} -->', f'<!-- next-id: {nid + 1} -->')
    text = text.rstrip('\n') + f'\n\n### L{nid}\n- 规则：目录规则 {pr}\n- Seen 1×: #{pr} {url} [{dirs[-1]}]\n'
report = f'# 复盘 #{pr}\n\n来源：https://github.com/{os.environ["FAKE_REPO"]}/pull/{pr}\n\n' + '内容。' * 40
print(json.dumps({'is_error': False, 'structured_output': {'report_markdown': report, 'lessons_markdown': text}}))
'''

FAKE_GIT = f'''#!/usr/bin/env bash
if [ "$*" = "remote get-url origin" ]; then echo "https://github.com/{REPO}"; exit 0; fi
exec "{REAL_GIT}" "$@"
'''

# Faults are injected from outside: FAULTS = "name:op[:skip]" entries, op in write/replace/unlink.
SITECUSTOMIZE = r'''
import os, pathlib
rules = []
for item in filter(None, os.environ.get('FAULTS', '').split(',')):
    parts = item.split(':')
    rules.append([parts[0], parts[1], int(parts[2]) if len(parts) > 2 else 0])
def wrap(op, orig):
    def inner(self, *a, **k):
        for r in rules:
            if r[0] == self.name and r[1] == op:
                if r[2] > 0:
                    r[2] -= 1
                else:
                    raise PermissionError(13, 'injected fault', str(self))
        return orig(self, *a, **k)
    return inner
pathlib.Path.write_text = wrap('write', pathlib.Path.write_text)
pathlib.Path.replace = wrap('replace', pathlib.Path.replace)
pathlib.Path.unlink = wrap('unlink', pathlib.Path.unlink)
'''


def entry(n, rule, seen):
    items = ' · '.join(seen)
    return f'### L{n}\n- 规则：{rule}\n- Seen {len(seen)}×: {items}\n' if seen else f'### L{n}\n- 规则：{rule}\n- Seen 0×:\n'


def lessons(dirs=True):
    body = ['# 项目复盘经验', '', '说明。', '', '<!-- next-id: 3 -->', '', '## 硬规则', '', '## 待确认', '',
            '## 观察中', '', entry(1, '全局规则', ['#1']).rstrip('\n')]
    if dirs:
        body += ['', '## 目录经验', '', entry(2, '旧目录规则', ['#2 [src/]']).rstrip('\n')]
    return '\n'.join(body) + '\n'


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp(prefix='retro-cutoff-'))
        self.fake = self.t / 'fake'
        self.bin = self.t / 'bin'
        self.site = self.t / 'site'
        for d in (self.fake, self.bin, self.site, self.t / 'home'):
            d.mkdir()
        for name, text in (('gh', FAKE_GH), ('claude', FAKE_CLAUDE), ('git', FAKE_GIT)):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        (self.site / 'sitecustomize.py').write_text(SITECUSTOMIZE)
        (self.t / 'home/.gitconfig').write_text('[user]\n\tname = t\n\temail = t@example.com\n'
                                                '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
        self.origin, self.project = self.t / 'origin.git', self.t / 'project'
        self.git('init', '-q', '--bare', '-b', 'main', str(self.origin))
        self.git('clone', '-q', str(self.origin), str(self.project))
        self.state = self.t / 'state'
        self.queue = self.state / 'retrospectives'
        self.queue.mkdir(parents=True)
        self.prs = {}
        self.gh_fail = []
        self.switch = None
        self.extra_cfg = []
        (self.queue / 'cursor.json').write_text(json.dumps({'enabled_at': OLD, 'since': OLD}) + '\n')
        self.publish(lessons())

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def git(self, *args, cwd=None):
        env = dict(os.environ, HOME=str(self.t / 'home'), GIT_CONFIG_NOSYSTEM='1')
        return subprocess.run([REAL_GIT, *args], cwd=cwd, env=env, check=True,
                              capture_output=True, text=True).stdout

    def publish(self, text, report_for=None):
        path = self.project / LESSONS
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        (self.project / 'src/app').mkdir(parents=True, exist_ok=True)
        (self.project / 'src/app/main.py').write_text('x\n')
        if report_for:
            r = self.project / f'docs/retrospectives/pr-{report_for}.md'
            r.parent.mkdir(parents=True, exist_ok=True)
            r.write_text('done\n')
        self.git('add', '-A', cwd=self.project)
        self.git('commit', '-qm', 'seed', '--allow-empty', cwd=self.project)
        self.git('push', '-q', 'origin', 'HEAD:main', cwd=self.project)

    def job(self, n, merged=None, **extra):
        value = {'pr': n, 'status': 'pending', 'attempts': 0}
        if merged:
            value['merged_at'] = merged
        value.update(extra)
        (self.queue / f'pr-{n}.json').write_text(json.dumps(value) + '\n')

    def read_job(self, n):
        return json.loads((self.queue / f'pr-{n}.json').read_text())

    def snapshot(self):
        return {p.name: p.read_bytes() for p in sorted(self.queue.iterdir())
                if p.is_file() and p.name != 'scan.lock'}

    def run_round(self, faults='', release=None):
        (self.fake / 'prs.json').write_text(json.dumps(self.prs))
        (self.fake / 'gh-fail.json').write_text(json.dumps(self.gh_fail))
        cfg = self.t / 'config'
        lines = [f'REPO={REPO}', f'PROJECT_ROOT={self.project}', f'WORKTREE_BASE={self.t}/wt',
                 f'STATE_DIR={self.state}', 'TMUX_PREFIX=cut', 'BRANCH_PREFIX=feature/issue-',
                 'SESSION_NAME_PREFIX=issue-', 'LABEL_PENDING_AGENT=pending/agent',
                 'LABEL_PENDING_HUMAN=pending/human']
        if self.switch is not None:
            lines.append(f'RETROSPECTIVE_DIRECTORY_LESSONS={self.switch}')
        lines += self.extra_cfg
        cfg.write_text('\n'.join(lines) + '\n')
        env = {'HOME': str(self.t / 'home'), 'PATH': f'{self.bin}:/usr/bin:/bin',
               'CODING_AGENT_CONFIG': str(cfg), 'FAKE_DIR': str(self.fake), 'FAKE_REPO': REPO,
               'RL_DIR': str(REPO_DIR / 'scripts'), 'PYTHONPATH': str(self.site), 'FAULTS': faults}
        rel = release or RELEASE
        proc = subprocess.run(['bash', str(rel / 'scripts/post-merge-retrospective.sh')], env=env,
                              capture_output=True, text=True, timeout=120)
        self.out = proc.stdout + proc.stderr
        return proc.returncode

    def model_calls(self):
        return [json.loads(p.read_text()) for p in sorted(self.fake.glob('model-*.json'),
                                                    key=lambda p: int(p.stem.split('-')[1]))]

    def gh_calls(self):
        log = self.fake / 'gh.log'
        return log.read_text().splitlines() if log.exists() else []

    def on_origin(self, path):
        r = subprocess.run([REAL_GIT, '--git-dir', str(self.origin), 'show', f'main:{path}'],
                           capture_output=True, text=True)
        return r.stdout if r.returncode == 0 else None

    def marker(self):
        p = self.queue / 'directory-lessons.json'
        return json.loads(p.read_text()) if p.exists() else None


class Cutoff(Sandbox):
    def test_B1_首轮交错顺序_旧的全部跳过_新的复盘一个(self):
        self.prs = {'40': OLD, '50': NEW, '60': OLD, '70': OLD}
        self.job(40)
        self.job(50, NEW)
        self.job(60, OLD, retry_after=4102444800)
        self.job(70)
        self.assertEqual(self.run_round(), 0, self.out)
        status = {n: self.read_job(n)['status'] for n in (40, 50, 60, 70)}
        self.assertEqual(status, {40: 'skipped', 50: 'done', 60: 'skipped', 70: 'skipped'}, self.out)
        self.assertEqual(len(self.model_calls()), 1)
        calls = self.gh_calls()
        self.assertEqual(calls.count(f'api repos/{REPO}/pulls/40'), 1)
        self.assertEqual(calls.count(f'api repos/{REPO}/pulls/70'), 1)
        self.assertEqual(calls.count(f'api repos/{REPO}/pulls/60'), 0)
        self.assertEqual(len([c for c in calls if '/files' in c]), 1)
        self.assertIn('directories', self.model_calls()[0]['input'])
        for n in (40, 60, 70):
            self.assertIsNone(self.on_origin(f'docs/retrospectives/pr-{n}.md'))
        self.assertIsNotNone(self.on_origin('docs/retrospectives/pr-50.md'))
        pushed = rl.parse(self.on_origin(LESSONS))
        self.assertEqual(pushed.by_id()[1].seen_prs, [1, 50])
        self.assertEqual(pushed.by_id()[3].section, '目录经验')
        self.assertEqual(self.marker()['state'], 'on')
        self.assertIn('directory lessons on', self.out)

    def test_B1b_两个新任务一轮只复盘一个(self):
        self.prs = {'51': NEW, '52': NEW}
        self.job(51, NEW)
        self.job(52, NEW)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(sorted(self.read_job(n)['status'] for n in (51, 52)), ['done', 'pending'])
        self.assertEqual(len(self.model_calls()), 1)

    def test_B2_合并时间等于开始时间照常复盘(self):
        (self.queue / 'directory-lessons.json').write_text(json.dumps({'state': 'on', 'since': MID}) + '\n')
        self.prs = {'55': MID}
        self.job(55, MID)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(55)['status'], 'done', self.out)
        self.assertEqual(self.marker(), {'state': 'on', 'since': MID})

    def test_缺目录段时程序补空段_推上去带标题(self):
        self.publish(lessons(dirs=False))
        self.prs = {'56': NEW}
        self.job(56, NEW)
        self.assertEqual(self.run_round(), 0, self.out)
        sent = self.model_calls()[0]['input']['lessons_markdown']
        self.assertTrue(sent.rstrip('\n').endswith('## 目录经验'), sent)
        self.assertIn('## 目录经验', self.on_origin(LESSONS))

    def test_B3_开关关掉_不跳过_不写目录经验_与改动前一致(self):
        self.switch = 'false'
        self.publish(lessons(dirs=False))
        self.prs = {'41': OLD}
        self.job(41, OLD)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(41)['status'], 'done', self.out)
        self.assertIsNone(self.marker())
        model = self.model_calls()
        self.assertEqual(len(model), 1)
        self.assertNotIn('directories', model[0]['input'])
        self.assertNotIn('目录经验', model[0]['instruction'])
        self.assertNotIn('## 目录经验', self.on_origin(LESSONS))
        new = (self.gh_calls(), model, self.on_origin(LESSONS), self.on_origin('docs/retrospectives/pr-41.md'))
        base = os.environ.get('BASELINE_RELEASE')
        if not base:
            return
        # The same round on the fixed pre-change commit (954a294).
        self.tearDown()
        self.setUp()
        self.switch = 'false'
        self.publish(lessons(dirs=False))
        self.prs = {'41': OLD}
        self.job(41, OLD)
        self.assertEqual(self.run_round(release=Path(base)), 0, self.out)
        old = (self.gh_calls(), self.model_calls(), self.on_origin(LESSONS),
               self.on_origin('docs/retrospectives/pr-41.md'))
        self.assertEqual(new, old)

    def test_关掉时已有目录段_不交给模型_推上去一字不变_全局照常(self):
        self.switch = 'false'
        self.prs = {'42': OLD}
        self.job(42, OLD)
        self.assertEqual(self.run_round(), 0, self.out)
        model = self.model_calls()[0]
        self.assertNotIn('目录经验', model['input']['lessons_markdown'])
        pushed = self.on_origin(LESSONS)
        self.assertEqual(rl.split_directory_section(pushed)[1], rl.split_directory_section(lessons())[1])
        self.assertEqual(rl.parse(pushed).by_id()[1].seen_prs, [1, 42])

    def test_B4_关掉再打开_关着期间合并的被跳过(self):
        (self.queue / 'directory-lessons.json').write_text(json.dumps({'state': 'on', 'since': OLD}) + '\n')
        self.prs = {'80': MID}
        self.job(80, MID, retry_after=4102444800)
        self.switch = 'false'
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.marker(), {'state': 'off'})
        self.assertEqual(self.read_job(80)['status'], 'pending')
        self.switch = 'true'
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertGreater(self.marker()['since'], MID)
        self.assertEqual(self.read_job(80)['status'], 'skipped', self.out)
        self.assertEqual(len(self.model_calls()), 0)

    def test_B5_时间文件坏了_整个队列暂停_什么都不动(self):
        for bad in ('{broken', json.dumps({'state': 'on', 'since': 'yesterday'}), json.dumps({'state': 'on'})):
            with self.subTest(bad=bad):
                (self.queue / 'directory-lessons.json').write_text(bad)
                self.prs = {'43': OLD, '57': NEW}
                self.job(43, OLD)
                self.job(57, NEW)
                before = {k: v for k, v in self.snapshot().items() if k != 'cursor.json'}
                self.assertEqual(self.run_round(), 0, self.out)
                after = {k: v for k, v in self.snapshot().items() if k != 'cursor.json'}
                self.assertEqual(after, before)
                self.assertEqual(len(self.model_calls()), 0)
                self.assertIn('paused this round', self.out)
                self.assertIn(str(self.queue / 'directory-lessons.json'), self.out)
                cursor = json.loads((self.queue / 'cursor.json').read_text())
                self.assertEqual(cursor['enabled_at'], OLD)
                self.assertNotEqual(cursor['since'], OLD)   # the scan itself still ran

    def test_B5b_时间文件写不进去_暂停_恢复后下一轮记新时间(self):
        self.prs = {'58': NEW}
        self.job(58, NEW)
        self.assertEqual(self.run_round(faults='directory-lessons.json.tmp:write'), 0, self.out)
        self.assertIsNone(self.marker())
        self.assertFalse((self.queue / 'directory-lessons.json.tmp').exists())
        self.assertEqual(self.read_job(58)['status'], 'pending')
        self.assertIn('paused this round', self.out)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.marker()['state'], 'on')
        self.assertEqual(self.read_job(58)['status'], 'done', self.out)

    def test_B6_合并时间读失败_原样留着不计失败_其余照常(self):
        self.prs = {'44': OLD, '45': OLD}
        self.gh_fail = [f'repos/{REPO}/pulls/44']
        self.job(44)
        self.job(45, OLD)
        before = (self.queue / 'pr-44.json').read_bytes()
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual((self.queue / 'pr-44.json').read_bytes(), before)
        self.assertEqual(self.read_job(45)['status'], 'skipped')
        self.assertIn(f'api repos/{REPO}/pulls/44', self.gh_calls())
        self.assertEqual(len(self.model_calls()), 0)

    def test_B7_远端已有报告的算完成不算跳过(self):
        self.publish(lessons(), report_for=46)
        self.prs = {'46': OLD}
        self.job(46, OLD)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(46)['status'], 'done')

    def test_B8_已跳过的不会再被挑中(self):
        self.prs = {'47': OLD}
        self.job(47, OLD)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(47)['status'], 'skipped')
        first = (self.queue / 'pr-47.json').read_bytes()
        for _ in range(2):
            self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual((self.queue / 'pr-47.json').read_bytes(), first)
        self.assertEqual(len(self.model_calls()), 0)

    def test_13_开关写错_第一步就停_什么都不改(self):
        self.switch = 'yes'
        self.job(48, OLD)
        before = self.snapshot()
        self.assertNotEqual(self.run_round(), 0)
        self.assertIn('must be true or false', self.out)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.gh_calls(), [])

    def test_9_扫描记录坏了_时间文件不建_任务不动(self):
        (self.queue / 'cursor.json').write_text('{broken')
        self.job(49, NEW)
        before = self.snapshot()
        self.assertNotEqual(self.run_round(), 0)
        self.assertEqual(self.snapshot(), before)
        self.assertIsNone(self.marker())

    def test_10_扫描记录坏了_已有时间文件不动(self):
        (self.queue / 'cursor.json').write_text('{broken')
        (self.queue / 'directory-lessons.json').write_text(json.dumps({'state': 'on', 'since': OLD}) + '\n')
        before = self.snapshot()
        self.assertNotEqual(self.run_round(), 0)
        self.assertEqual(self.snapshot(), before)


class OffEvidence(Sandbox):
    """Turning the switch off must leave evidence, or a later "on" must not reuse the old start."""
    def start_on_old(self):
        (self.queue / 'directory-lessons.json').write_text(json.dumps({'state': 'on', 'since': OLD}) + '\n')
        self.prs = {'90': MID, '91': MID}
        self.job(90, MID, retry_after=4102444800)   # merged while off, still queued when turned on
        self.job(91, MID)                           # due while off: retrospected without directories

    def turn_on_again(self):
        self.switch = 'true'
        self.assertEqual(self.run_round(), 0, self.out)
        since = self.marker()['since']
        self.assertGreater(since, MID)
        self.assertEqual(self.read_job(90)['status'], 'skipped', self.out)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.marker()['since'], since)

    def test_12_改不了删不掉_扫描记录留标记_直接重开记新时间(self):
        self.start_on_old()
        self.switch = 'false'
        rc = self.run_round(faults='directory-lessons.json.tmp:write,directory-lessons.json:unlink')
        self.assertEqual(rc, 0, self.out)
        self.assertEqual(self.marker(), {'state': 'on', 'since': OLD})
        self.assertIn('directory_lessons_off_pending', json.loads((self.queue / 'cursor.json').read_text()))
        self.assertEqual(self.read_job(91)['status'], 'done', self.out)
        self.assertNotIn('directories', self.model_calls()[0]['input'])
        self.turn_on_again()
        self.assertNotIn('directory_lessons_off_pending', json.loads((self.queue / 'cursor.json').read_text()))

    def test_12b_关闭失败后持续关闭再打开(self):
        self.start_on_old()
        self.switch = 'false'
        self.run_round(faults='directory-lessons.json.tmp:write,directory-lessons.json:unlink')
        for _ in range(2):
            self.assertEqual(self.run_round(), 0, self.out)
        self.turn_on_again()

    def test_12c_写成关或删掉文件_直接重开都记新时间(self):
        for faults, expect in (('', {'state': 'off'}), ('directory-lessons.json.tmp:write', None)):
            with self.subTest(faults=faults):
                self.tearDown()
                self.setUp()
                self.start_on_old()
                self.switch = 'false'
                self.assertEqual(self.run_round(faults=faults), 0, self.out)
                self.assertEqual(self.marker(), expect)
                self.turn_on_again()

    def test_12d_三处都记不下_本轮队列暂停(self):
        self.start_on_old()
        self.switch = 'false'
        before = {k: v for k, v in self.snapshot().items() if k.startswith('pr-')}
        faults = 'directory-lessons.json.tmp:write,directory-lessons.json:unlink,cursor.tmp:write:1'
        self.assertEqual(self.run_round(faults=faults), 0, self.out)
        self.assertIn('paused this round', self.out)
        self.assertIn(str(self.queue / 'directory-lessons.json'), self.out)
        self.assertEqual({k: v for k, v in self.snapshot().items() if k.startswith('pr-')}, before)
        self.assertEqual(len(self.model_calls()), 0)
        cursor = json.loads((self.queue / 'cursor.json').read_text())
        self.assertNotEqual(cursor['since'], OLD)          # the scan's own save went through
        self.assertNotIn('directory_lessons_off_pending', cursor)


class Recovery(Sandbox):
    """The recovery steps in docs/operations{,.zh}.md, run as written (12e)."""
    def script(self, page):
        docs = RELEASE if (RELEASE / page).exists() else REPO_DIR
        text = (docs / page).read_text()
        block = text.split('<!-- retro-dir-recovery:begin -->', 1)[1].split('<!-- retro-dir-recovery:end -->', 1)[0]
        return block.strip().removeprefix('```bash').removesuffix('```').strip() + '\n'

    def test_12e_两页步骤相同_照做后下一轮重新计时(self):
        en, zh = self.script('docs/operations.md'), self.script('docs/operations.zh.md')
        self.assertEqual(en, zh)
        (self.queue / 'directory-lessons.json').write_text(json.dumps({'state': 'on', 'since': OLD}) + '\n')
        cursor_before = (self.queue / 'cursor.json').read_bytes()
        # The page says: replace <project> with the project's key — the state dir's name.
        home_state = self.t / 'home/.local/state/cavil-loop'
        home_state.mkdir(parents=True)
        (home_state / 'proj').symlink_to(self.state)
        script = en.replace('<project>', 'proj')
        (self.bin / 'systemctl').write_text(f'#!/usr/bin/env bash\necho "$*" >> {self.fake}/systemctl.log\n')
        (self.bin / 'systemctl').chmod(0o755)
        proc = subprocess.run(['bash'], input=script, capture_output=True, text=True,
                              env={'HOME': str(self.t / 'home'), 'PATH': f'{self.bin}:/usr/bin:/bin'})
        self.assertIn('reset done', proc.stdout, proc.stdout + proc.stderr)
        self.assertEqual((self.fake / 'systemctl.log').read_text().splitlines(),
                         ['--user stop cavil-loop-poll@proj.timer', '--user start cavil-loop-poll@proj.timer'])
        self.assertIsNone(self.marker())
        self.assertEqual((self.queue / 'cursor.json').read_bytes(), cursor_before)
        self.assertEqual(len(list(self.queue.glob('directory-lessons.json.bak-*'))), 1)
        self.assertEqual(len(list(self.queue.glob('cursor.json.bak-*'))), 1)
        self.prs = {'95': MID}
        self.job(95, MID)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertGreater(self.marker()['since'], MID)
        self.assertIn('directory lessons on: handling PRs merged at or after', self.out)
        self.assertEqual(self.read_job(95)['status'], 'skipped')

    def run_script(self, fakes):
        """Run the page's block with some commands replaced by failing fakes."""
        home_state = self.t / 'home/.local/state/cavil-loop'
        home_state.mkdir(parents=True, exist_ok=True)
        if not (home_state / 'proj').exists():
            (home_state / 'proj').symlink_to(self.state)
        over = self.t / 'over'
        shutil.rmtree(over, ignore_errors=True)
        over.mkdir()
        (self.bin / 'systemctl').write_text(
            f'#!/usr/bin/env bash\necho "$*" >> {self.fake}/systemctl.log\n'
            f'[ "$2" = "${{FAIL_SYSTEMCTL:-}}" ] && exit 1\nexit 0\n')
        (self.bin / 'systemctl').chmod(0o755)
        env = {'HOME': str(self.t / 'home'), 'PATH': f'{over}:{self.bin}:/usr/bin:/bin'}
        for name in fakes:
            if name.startswith('systemctl:'):
                env['FAIL_SYSTEMCTL'] = name.split(':', 1)[1]
                continue
            (over / name).write_text('#!/bin/sh\necho "$0 failed" >&2\nexit 7\n')
            (over / name).chmod(0o755)
        log = self.fake / 'systemctl.log'
        if log.exists():
            log.unlink()
        return subprocess.run(['bash'], input=self.script('docs/operations.md').replace('<project>', 'proj'),
                              capture_output=True, text=True, env=env)

    def test_12e_任何一步失败都停在原处_不删不重启(self):
        for fakes in (['systemctl:stop'], ['flock'], ['cp'], ['rm']):
            with self.subTest(fakes=fakes):
                (self.queue / 'directory-lessons.json').write_text(json.dumps({'state': 'on', 'since': OLD}) + '\n')
                before = (self.queue / 'directory-lessons.json').read_bytes()
                cursor = (self.queue / 'cursor.json').read_bytes()
                proc = self.run_script(fakes)
                self.assertIn('reset FAILED', proc.stdout, proc.stdout + proc.stderr)
                self.assertNotIn('reset done', proc.stdout)
                self.assertEqual((self.queue / 'directory-lessons.json').read_bytes(), before)
                self.assertEqual((self.queue / 'cursor.json').read_bytes(), cursor)
                calls = (self.fake / 'systemctl.log').read_text().splitlines()
                self.assertEqual(calls, ['--user stop cavil-loop-poll@proj.timer'])
        self.assertEqual(self.run_script([]).stdout.strip(), 'reset done')


class ReviewRound1(Sandbox):
    """Cases found in code review round 1 of PR #170."""
    def test_R1_时间文件读不出时关掉_扫描记录留标记_恢复后重开记新时间(self):
        if os.geteuid() == 0:
            self.skipTest('root reads a mode-000 file')
        marker = self.queue / 'directory-lessons.json'
        marker.write_text(json.dumps({'state': 'on', 'since': OLD}) + '\n')
        before = marker.read_bytes()
        self.prs = {'90': MID}
        self.job(90, MID, retry_after=4102444800)
        self.switch = 'false'
        marker.chmod(0)
        try:
            self.assertEqual(self.run_round(), 0, self.out)
        finally:
            marker.chmod(0o644)
        self.assertEqual(marker.read_bytes(), before)       # unreadable: left as it was
        self.assertIn('directory_lessons_off_pending', json.loads((self.queue / 'cursor.json').read_text()))
        self.switch = 'true'
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertGreater(self.marker()['since'], MID)
        self.assertEqual(self.read_job(90)['status'], 'skipped', self.out)
        self.assertEqual(len(self.model_calls()), 0)

    def test_R2_清标记失败只重试清理_开始时间不再移动(self):
        import time
        (self.queue / 'directory-lessons.json').write_text(json.dumps({'state': 'on', 'since': OLD}) + '\n')
        cursor = json.loads((self.queue / 'cursor.json').read_text())
        cursor['directory_lessons_off_pending'] = MID
        (self.queue / 'cursor.json').write_text(json.dumps(cursor) + '\n')
        self.assertEqual(self.run_round(faults='cursor.tmp:write:1'), 0, self.out)
        first = self.marker()
        self.assertEqual(first['consumed'], MID)
        self.assertGreater(first['since'], MID)
        self.assertIn('directory_lessons_off_pending', json.loads((self.queue / 'cursor.json').read_text()))
        # A PR merged exactly at the new start, still waiting to be retried: it must stay eligible.
        self.prs = {'96': first['since']}
        self.job(96, first['since'], retry_after=4102444800)
        job_before = (self.queue / 'pr-96.json').read_bytes()
        for faults in ('cursor.tmp:write:1', 'cursor.tmp:write:1', ''):
            time.sleep(1.1)
            self.assertEqual(self.run_round(faults=faults), 0, self.out)
            self.assertEqual(self.marker()['since'], first['since'])
            self.assertEqual((self.queue / 'pr-96.json').read_bytes(), job_before)
        self.assertNotIn('directory_lessons_off_pending', json.loads((self.queue / 'cursor.json').read_text()))
        time.sleep(1.1)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.marker()['since'], first['since'])

    def test_R3_目标分支取不到_旧任务原样留着(self):
        self.extra_cfg = ['BASE_BRANCH=missing']
        self.prs = {'97': OLD}
        self.job(97, OLD)
        before = (self.queue / 'pr-97.json').read_bytes()
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual((self.queue / 'pr-97.json').read_bytes(), before)
        self.assertIn('cannot check origin/missing for its report', self.out)
        self.extra_cfg = []
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(97)['status'], 'skipped')


if __name__ == '__main__':
    unittest.main(verbosity=1 if os.environ.get('QUIET') else 2)
