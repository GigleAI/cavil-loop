"""Where the post-merge retrospective writes its report (GitHub#688), run via
tests/retrospective-report-dir.test.sh.

Every case runs the real entry, `scripts/post-merge-retrospective.sh`, in the sandbox of
tests/retrospective_cutoff_test.py: fake `gh` and `claude`, real git, the project's origin a
local bare repository, pushes are real. What a round did is read back from origin, the job
file, the model's recorded input and the round's output.

- line missing: the round is byte for byte the one of the fixed pre-change commit
  (BASELINE_RELEASE, set by the wrapper): GitHub calls, model input and instruction, what
  was pushed
- a configured directory: the report lands there and nowhere else, the instruction and the
  project command name it, the commit holds exactly the report and the lessons file
- "already retrospected": a report in the configured directory or in the default one counts,
  in both places that ask (the job itself and the directory-lessons classification); a git
  read that fails is never taken for "no report"
- a path through a symbolic link: no model call, nothing written outside
- tests/fixtures/repodir-cases.txt through the real entry and through the settings dialog's
  real save (scripts/project-config.sh set): both agree with the list
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import retrospective_cutoff_test as base  # noqa: E402

CASES = HERE / 'fixtures/repodir-cases.txt'
NEW_DIR = 'internal/retrospectives'


def cases():
    out = []
    for line in CASES.read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        verdict, value = line.split('|', 1)
        assert verdict in ('ok', 'bad'), line
        out.append((verdict == 'ok', value))
    return out


def quoted(value):
    """The config line's value in single quotes (none of the listed values holds a quote)."""
    assert "'" not in value
    return f"'{value}'"


class _ReportDir(base.Sandbox):
    def setUp(self):
        super().setUp()
        self.prs = {'50': base.NEW}
        self.job(50, base.NEW)

    def configure(self, value=None, *more):
        self.extra_cfg = ([f'RETROSPECTIVE_REPORT_DIR={quoted(value)}'] if value is not None else []) + list(more)

    def pushed_files(self):
        """Files the last commit on origin changed."""
        out = subprocess.run([base.REAL_GIT, '--git-dir', str(self.origin), 'diff-tree', '--no-commit-id',
                              '--name-only', '-r', 'main'], capture_output=True, text=True, check=True)
        return sorted(out.stdout.split())

    def seed_report(self, folder, n=50):
        path = self.project / folder / f'pr-{n}.md'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('done\n')
        self.git('add', '-A', cwd=self.project)
        self.git('commit', '-qm', 'old report', cwd=self.project)
        self.git('push', '-q', 'origin', 'HEAD:main', cwd=self.project)


class Default(_ReportDir):
    def round(self):
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(50)['status'], 'done', self.out)
        return (self.gh_calls(), self.model_calls(), self.on_origin(base.LESSONS),
                self.on_origin('docs/retrospectives/pr-50.md'), self.pushed_files())

    def test_line_missing_writes_where_it_always_did(self):
        new = self.round()
        self.assertIsNotNone(new[3])
        self.assertEqual(new[4], sorted(['docs/retrospectives/pr-50.md', base.LESSONS]))
        self.assertIn('报告路径为 docs/retrospectives/pr-N.md', new[1][0]['instruction'])
        self.assertNotIn('${', new[1][0]['instruction'])
        ref = os.environ.get('BASELINE_RELEASE')
        if not ref:
            self.skipTest('BASELINE_RELEASE not set: no comparison with the pre-change commit')
        self.tearDown()
        self.setUp()
        self.assertEqual(self.run_round(release=Path(ref)), 0, self.out)
        old = (self.gh_calls(), self.model_calls(), self.on_origin(base.LESSONS),
               self.on_origin('docs/retrospectives/pr-50.md'), self.pushed_files())
        self.assertEqual(new, old)

    def test_empty_value_is_the_default(self):
        self.configure('')
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.pushed_files(), sorted(['docs/retrospectives/pr-50.md', base.LESSONS]))


class Configured(_ReportDir):
    def test_report_goes_to_the_configured_directory_only(self):
        self.configure(NEW_DIR, 'POST_RETROSPECTIVE_PROJECT_CMD=\'echo "file=$RETROSPECTIVE_REPORT_FILE"\'')
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(50)['status'], 'done', self.out)
        self.assertEqual(len(self.model_calls()), 1)
        self.assertIsNotNone(self.on_origin(f'{NEW_DIR}/pr-50.md'))
        self.assertIsNone(self.on_origin('docs/retrospectives/pr-50.md'))
        self.assertEqual(self.pushed_files(), sorted([f'{NEW_DIR}/pr-50.md', base.LESSONS]))
        text = self.model_calls()[0]['instruction']
        self.assertIn(f'报告路径为 {NEW_DIR}/pr-N.md', text)
        self.assertNotIn('docs/retrospectives', text)
        self.assertIn(f'file={NEW_DIR}/pr-50.md', self.out)

    def test_report_in_configured_directory_counts_as_done(self):
        self.seed_report(NEW_DIR)
        self.configure(NEW_DIR)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(50)['status'], 'done', self.out)
        self.assertEqual(self.model_calls(), [])

    def test_report_in_default_directory_counts_as_done_after_the_move(self):
        self.seed_report('docs/retrospectives')
        self.configure(NEW_DIR)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(50)['status'], 'done', self.out)
        self.assertEqual(self.model_calls(), [])
        self.assertIsNone(self.on_origin(f'{NEW_DIR}/pr-50.md'))

    def test_report_in_another_directory_does_not_count(self):
        # sibling of the two above: a report somewhere else is not taken for done, the model is asked
        self.seed_report('elsewhere')
        self.configure(NEW_DIR)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(len(self.model_calls()), 1)
        self.assertIsNotNone(self.on_origin(f'{NEW_DIR}/pr-50.md'))


class Classify(_ReportDir):
    """The directory-lessons switch's classification of PRs merged before it took effect:
    one with a report is `done`, one without is `skipped` — in either directory."""

    def setUp(self):
        super().setUp()
        (self.queue / 'pr-50.json').unlink()
        (self.queue / 'directory-lessons.json').write_text(json.dumps({'state': 'on', 'since': base.MID}) + '\n')
        self.prs = {'40': base.OLD, '41': base.OLD, '42': base.OLD}
        for n in (40, 41, 42):
            self.job(n, base.OLD)
        self.seed_report('docs/retrospectives', 40)
        self.seed_report(NEW_DIR, 41)
        self.configure(NEW_DIR)

    def test_both_directories_count(self):
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual({n: self.read_job(n)['status'] for n in (40, 41, 42)},
                         {40: 'done', 41: 'done', 42: 'skipped'}, self.out)
        self.assertEqual(self.model_calls(), [])


FAILING_LS_TREE = f'''#!/usr/bin/env bash
if [ "$*" = "remote get-url origin" ]; then echo "https://github.com/{base.REPO}"; exit 0; fi
if [ "$1" = ls-tree ]; then echo "fatal: injected" >&2; exit 128; fi
exec "{base.REAL_GIT}" "$@"
'''


class ReadFailure(_ReportDir):
    def test_git_cannot_tell_means_no_model_call_and_retry(self):
        (self.bin / 'git').write_text(FAILING_LS_TREE)
        self.configure(NEW_DIR)
        self.assertEqual(self.run_round(), 0, self.out)
        job = self.read_job(50)
        self.assertEqual(job['status'], 'pending', self.out)
        self.assertIn('cannot read origin/main', job.get('error', ''))
        self.assertEqual(self.model_calls(), [])

    def test_classification_leaves_unknown_jobs_alone(self):
        (self.bin / 'git').write_text(FAILING_LS_TREE)
        (self.queue / 'pr-50.json').unlink()
        (self.queue / 'directory-lessons.json').write_text(json.dumps({'state': 'on', 'since': base.MID}) + '\n')
        self.prs = {'40': base.OLD}
        self.job(40, base.OLD)
        self.configure(NEW_DIR)
        self.assertEqual(self.run_round(), 0, self.out)
        self.assertEqual(self.read_job(40)['status'], 'pending', self.out)
        self.assertIn('cannot check origin/main for its report', self.out)


class Symlink(_ReportDir):
    def test_directory_through_a_link_out_of_the_repository_is_refused(self):
        outside = self.t / 'outside'
        outside.mkdir()
        (self.project / 'internal').symlink_to(outside)
        self.git('add', '-A', cwd=self.project)
        self.git('commit', '-qm', 'link', cwd=self.project)
        self.git('push', '-q', 'origin', 'HEAD:main', cwd=self.project)
        self.configure(NEW_DIR)
        self.assertEqual(self.run_round(), 0, self.out)
        job = self.read_job(50)
        self.assertNotEqual(job['status'], 'done', self.out)
        self.assertIn('symbolic link', job.get('error', ''))
        self.assertEqual(self.model_calls(), [])
        self.assertEqual(list(outside.iterdir()), [])


class SameRule(_ReportDir):
    """tests/fixtures/repodir-cases.txt through the retrospective's real entry and the
    settings dialog's real save: each must accept exactly the values the list says."""

    def test_retrospective_entry_agrees_with_the_list(self):
        (self.queue / 'pr-50.json').unlink()
        verdicts = {}
        for ok, value in cases():
            before = self.snapshot()
            self.configure(value)
            rc = self.run_round()
            refused = 'RETROSPECTIVE_REPORT_DIR' in self.out and 'is not a directory inside' in self.out
            verdicts[value] = (ok, rc == 0 and not refused)
            if not ok:
                # stopped before the queue: nothing read or written
                self.assertNotEqual(rc, 0, value)
                self.assertEqual(self.snapshot(), before, value)
        self.assertEqual({v: a for v, a in verdicts.items() if a[0] != a[1]}, {})
        self.assertEqual({b for _, b in verdicts.values()}, {True, False})

    def save(self, value):
        pc = str(base.REPO_DIR / 'scripts/project-config.sh')
        env = {'HOME': str(self.t / 'home'), 'PATH': '/usr/bin:/bin'}
        got = subprocess.run(['bash', pc, 'get', 'retro'], env=env, capture_output=True, text=True)
        rev = json.loads(got.stdout)['rev']
        body = json.dumps({'RETROSPECTIVE_REPORT_DIR': value})
        out = subprocess.run(['bash', pc, 'set', 'retro', '--rev', rev], input=body, env=env,
                             capture_output=True, text=True).stdout
        return out.strip().splitlines()[-1]

    def test_dialog_save_agrees_with_the_list(self):
        self.assertEqual(self.run_round(), 0, self.out)          # writes the config file
        cfg = self.t / 'config'
        plain = cfg.read_text()
        reg = self.t / 'home/.config/cavil-loop'
        reg.mkdir(parents=True, exist_ok=True)
        (reg / 'retro.conf').write_text(f'PROJECT_ROOT={self.project}\nCODING_AGENT_CONFIG={cfg}\n')
        verdicts = {}
        for ok, value in cases():
            cfg.write_text(plain)
            saved = self.save(value)
            self.assertIn(saved, ('RESULT=saved', 'RESULT=invalid', 'RESULT=unchanged'), value)
            verdicts[value] = (ok, saved != 'RESULT=invalid')
            if saved == 'RESULT=saved':
                self.assertIn(f'RETROSPECTIVE_REPORT_DIR="{value}"', cfg.read_text(), value)
        self.assertEqual({v: a for v, a in verdicts.items() if a[0] != a[1]}, {})
        self.assertEqual({b for _, b in verdicts.values()}, {True, False})


if __name__ == '__main__':
    unittest.main(verbosity=0 if os.environ.get('QUIET') else 1)
