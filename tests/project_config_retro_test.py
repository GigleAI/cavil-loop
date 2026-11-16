"""Which model the post-merge retrospective really asks for (GitHub#388), and whether it
runs at all and with which modes (GitHub#554).

scripts/config-fields.txt says what RETROSPECTIVE_MODEL, POST_MERGE_RETROSPECTIVE,
RETROSPECTIVE_PROMOTION and RETROSPECTIVE_DIRECTORY_LESSONS are when the config has no
such line. This runs the real entry, scripts/post-merge-retrospective.sh, on one
queued PR (the sandbox of tests/retrospective_cutoff_test.py: fake gh, real git,
a local bare origin) with a `claude` that records its arguments, and compares the
`--model` it was started with: line missing, empty value, and a value written the
way scripts/project-config.sh writes it. The same recorder writes down the two modes
the model program inherited from the retrospective process — the values that process
read (scripts/post-merge-retrospective.py takes both from its environment) — and
whether the model was called at all tells whether the retrospective ran.

Run by tests/project-config-poll.test.sh.
"""
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import retrospective_cutoff_test as base  # noqa: E402

FIELDS = HERE.parent / 'scripts/config-fields.txt'
RECORDER = r'''#!/usr/bin/env python3
import os, sys
a = sys.argv[1:]
with open(os.path.join(os.environ['FAKE_DIR'], 'models.log'), 'a') as f:
    f.write((a[a.index('--model') + 1] if '--model' in a else '<none>') + '\n')
with open(os.path.join(os.environ['FAKE_DIR'], 'modes.log'), 'a') as f:
    f.write(os.environ.get('RETROSPECTIVE_PROMOTION', '<unset>') + ' '
            + os.environ.get('RETROSPECTIVE_DIRECTORY_LESSONS', '<unset>') + '\n')
os.execv(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'claude-real'), ['claude'] + a)
'''


def registered_default(name):
    for line in FIELDS.read_text(encoding='utf-8').splitlines():
        cols = [c.strip() for c in line.split('|')]
        if cols and cols[0] == name:
            return cols[3].split(';empty=')[0]
    raise AssertionError(f'{name} is not in {FIELDS}')


class _Retro(base.Sandbox):
    def setUp(self):
        super().setUp()
        (self.bin / 'claude').rename(self.bin / 'claude-real')
        (self.bin / 'claude').write_text(RECORDER)
        (self.bin / 'claude').chmod(0o755)
        self.prs = {'50': base.NEW}
        self.job(50, base.NEW)

    def asked(self):
        log = self.fake / 'models.log'
        return log.read_text().split() if log.exists() else []

    def modes(self):
        log = self.fake / 'modes.log'
        return log.read_text().splitlines() if log.exists() else []

    def run_once(self, *cfg):
        self.extra_cfg = list(cfg)
        self.assertEqual(self.run_round(), 0, self.out)
        # the retrospective really ran to the end: the model was called and the job is done
        self.assertEqual(self.read_job(50)['status'], 'done', self.out)
        self.assertEqual(len(self.model_calls()), 1, self.out)
        return self.asked()


class RetroModel(_Retro):
    def test_line_missing_is_the_registered_default(self):
        self.assertEqual(registered_default('RETROSPECTIVE_MODEL'), 'sonnet')
        self.assertEqual(self.run_once(), [registered_default('RETROSPECTIVE_MODEL')])

    def test_empty_value_is_the_default_too(self):
        self.assertEqual(self.run_once('RETROSPECTIVE_MODEL=""'), [registered_default('RETROSPECTIVE_MODEL')])

    def test_a_written_value_is_what_the_model_program_gets(self):
        # the line as scripts/project-config.sh appends it
        self.assertEqual(self.run_once('RETROSPECTIVE_MODEL="opus-5.5"'), ['opus-5.5'])


    def test_modes_line_missing_are_the_registered_defaults(self):
        self.assertEqual(registered_default('RETROSPECTIVE_PROMOTION'), 'auto')
        self.assertEqual(registered_default('RETROSPECTIVE_DIRECTORY_LESSONS'), 'true')
        self.run_once()
        self.assertEqual(self.modes(), [registered_default('RETROSPECTIVE_PROMOTION') + ' '
                                        + registered_default('RETROSPECTIVE_DIRECTORY_LESSONS')])

    def test_modes_empty_values_are_the_defaults_too(self):
        self.run_once('RETROSPECTIVE_PROMOTION=""', 'RETROSPECTIVE_DIRECTORY_LESSONS=""')
        self.assertEqual(self.modes(), ['auto true'])

    def test_modes_written_values_reach_the_retrospective(self):
        self.run_once('RETROSPECTIVE_PROMOTION="confirm"', 'RETROSPECTIVE_DIRECTORY_LESSONS="false"')
        self.assertEqual(self.modes(), ['confirm false'])


class RetroSwitch(_Retro):
    """POST_MERGE_RETROSPECTIVE: missing / empty = the registered default (on), false = off."""

    def run_switch(self, *cfg):
        self.extra_cfg = list(cfg)
        self.assertEqual(self.run_round(), 0, self.out)
        return self.read_job(50)['status'], len(self.model_calls())

    def test_line_missing_runs(self):
        self.assertEqual(registered_default('POST_MERGE_RETROSPECTIVE'), 'true')
        self.assertEqual(self.run_switch(), ('done', 1))

    def test_empty_value_runs(self):
        self.assertEqual(self.run_switch('POST_MERGE_RETROSPECTIVE=""'), ('done', 1))

    def test_written_true_runs(self):
        self.assertEqual(self.run_switch('POST_MERGE_RETROSPECTIVE="true"'), ('done', 1))

    def test_written_false_does_not_run(self):
        before = self.read_job(50)
        self.assertEqual(self.run_switch('POST_MERGE_RETROSPECTIVE="false"'), (before['status'], 0))
        self.assertNotEqual(before['status'], 'done')


if __name__ == '__main__':
    unittest.main(verbosity=0 if os.environ.get('QUIET') else 1)
