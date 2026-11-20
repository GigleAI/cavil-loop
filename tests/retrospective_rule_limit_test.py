"""The length limit on promotions (GitHub#600), through the real entry.

Every case runs scripts/post-merge-retrospective.sh in the sandbox of
tests/retrospective_cutoff_test.py (fake gh, real git, a local bare origin) with a
model stand-in that counts this PR on L1 — and, when told to, shortens L1's 为什么
or writes the program's held-over-limit line itself. What is asserted is what lands
on the origin (lessons, report), the job file and the log.

Run by tests/retrospective-rule-limit.test.sh.
"""
import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import retrospective_cutoff_test as base  # noqa: E402
from retrospective_cutoff_test import LESSONS, NEW, U, rl  # noqa: E402

MODEL = r'''#!/usr/bin/env python3
import json, os, re, subprocess, sys
d = os.environ['FAKE_DIR']
real = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'claude-real')
out = json.loads(subprocess.run([real] + sys.argv[1:], input=sys.stdin.read(), capture_output=True,
                                text=True, check=True).stdout)
text = out['structured_output']['lessons_markdown']
if os.path.exists(os.path.join(d, 'shorten')):
    # Q1 = A: the model may rewrite 为什么; this one cuts it to its first character.
    text = re.sub(r'^(- 为什么：.).*$', r'\1', text, count=1, flags=re.M)
if os.path.exists(os.path.join(d, 'write-held')):
    text = re.sub(r'^(<!-- next-id: \d+ -->)$', r'\1\n<!-- held-over-limit: L1 -->', text, count=1, flags=re.M)
out['structured_output']['lessons_markdown'] = text
print(json.dumps(out))
'''


def sized(n, rule='规'):
    """An L1 entry whose 规则 + 适用 + 为什么 is exactly n characters."""
    return rule * (n - 10), '适' * 5, '因' * 5


def lessons(n=None, seen=2, section='观察中', held=None, fields=None):
    rule, applies, why = fields or sized(n)
    sightings = ' · '.join(f'#{k}' for k in range(1, seen + 1))
    e = [f'### L1', f'- 规则：{rule}', f'- 适用：{applies}', f'- 为什么：{why}', f'- Seen {seen}×: {sightings}']
    body = ['# 项目复盘经验', '', '说明。', '', '<!-- next-id: 2 -->']
    if held is not None:
        body.append(held)
    for name in ('硬规则', '待确认', '观察中'):
        body += ['', f'## {name}']
        if name == section:
            body += [''] + e
    return '\n'.join(body) + '\n'


class Limit(base.Sandbox):
    def setUp(self):
        super().setUp()
        (self.bin / 'claude').rename(self.bin / 'claude-real')
        (self.bin / 'claude').write_text(MODEL)
        (self.bin / 'claude').chmod(0o755)
        self.switch = 'false'   # no 目录经验: the model's only edit is counting L1
        self.n = 50

    def publish(self, text, report_for=None):
        # The retrospective pushed to origin since the last seed: start from there.
        if self.on_origin(LESSONS) is not None:
            self.git('fetch', '-q', 'origin', cwd=self.project)
            self.git('reset', '-q', '--hard', 'origin/main', cwd=self.project)
        super().publish(text, report_for)

    def round(self, *cfg, expect='done'):
        self.prs[str(self.n)] = NEW
        self.job(self.n, NEW)
        self.extra_cfg = list(cfg)
        rc = self.run_round()
        self.assertEqual(rc, 0, self.out)
        job = self.read_job(self.n)
        self.assertEqual(job['status'], expect, self.out)
        self.n += 1
        return job

    def landed(self):
        return rl.parse(self.on_origin(LESSONS))

    def report(self, n):
        return self.on_origin(f'docs/retrospectives/pr-{n}.md')

    def test_300字第三次出现照常升档(self):
        self.publish(lessons(300))
        self.round()
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, len(got.by_id()[1].seen), got.held), ('硬规则', 3, ()))
        self.assertNotIn('程序附注', self.report(50))

    def test_301字第三次出现留在观察中_标记与报告写明(self):
        self.publish(lessons(301))
        self.round()
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, len(got.by_id()[1].seen), got.held), ('观察中', 3, (1,)))
        self.assertIn('<!-- next-id: 2 -->\n<!-- held-over-limit: L1 -->\n', self.on_origin(LESSONS))
        report = self.report(50)
        self.assertIn('## 程序附注：升档字数上限', report)
        self.assertIn('本次挡下：L1，301 字，上限 300', report)
        self.assertIn('rule length limit 300: held back L1(301)', self.out)
        model = self.model_calls()[0]
        self.assertIn('不超过 300 字符', model['instruction'])

    def test_确认模式目标段是待确认_挡下与补升同样适用(self):
        self.publish(lessons(301))
        self.round('RETROSPECTIVE_PROMOTION=confirm')
        self.assertEqual(self.landed().by_id()[1].section, '观察中')
        self.publish(lessons(300, seen=3, held='<!-- held-over-limit: L1 -->'))
        self.round('RETROSPECTIVE_PROMOTION=confirm')
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, got.held), ('待确认', ()))
        self.assertIn('本次补升：L1，300 字，已进「待确认」', self.report(51))

    def test_挡下后标记不给模型看_人压到300字下一次补升(self):
        self.publish(lessons(301))
        self.round()
        self.assertNotIn('held-over-limit', self.model_calls()[0]['input']['lessons_markdown'])
        # A human shortens it on the base branch; the program's line stays as it was.
        text = self.on_origin(LESSONS)
        self.publish(text.replace('规' * 291, '规' * 290))
        self.round()
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, len(got.by_id()[1].seen), got.held), ('硬规则', 4, ()))
        self.assertIn('本次补升：L1，300 字', self.report(51))
        self.assertIn('promoted late L1(300)', self.out)

    def test_挡下后调高上限或改成不限都补升(self):
        for value in ('301', '0'):
            with self.subTest(value=value):
                self.publish(lessons(301, seen=3, held='<!-- held-over-limit: L1 -->'))
                self.round(f'RETROSPECTIVE_RULE_MAX_CHARS={value}')
                got = self.landed()
                self.assertEqual((got.by_id()[1].section, got.held), ('硬规则', ()))

    def test_人从标记里删掉编号就不再补升(self):
        self.publish(lessons(300, seen=3))
        self.round()
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, len(got.by_id()[1].seen), got.held), ('观察中', 4, ()))

    def test_照报告删掉唯一的编号_下一轮照常跑完_条目留在观察中(self):
        for how in ('只删编号', '删掉整行'):
            with self.subTest(how=how):
                self.tearDown(); self.setUp()
                self.publish(lessons(301))
                self.round()
                text = self.on_origin(LESSONS)
                self.assertIn('<!-- held-over-limit: L1 -->\n', text)   # the line the program wrote
                edited = (text.replace('<!-- held-over-limit: L1 -->', '<!-- held-over-limit: -->')
                          if how == '只删编号' else text.replace('<!-- held-over-limit: L1 -->\n', ''))
                self.publish(edited)
                job = self.round()
                self.assertEqual(job['attempts'], 0)
                got = self.landed()
                self.assertEqual((got.by_id()[1].section, len(got.by_id()[1].seen), got.held), ('观察中', 4, ()))
                self.assertNotIn('held-over-limit', self.on_origin(LESSONS))

    def test_标记行挪到声明行上面_不调模型不计次(self):
        self.publish(lessons(301))
        self.round()
        text = self.on_origin(LESSONS)
        moved = text.replace('<!-- held-over-limit: L1 -->\n', '').replace(
            '<!-- next-id: 2 -->', '<!-- held-over-limit: L1 -->\n<!-- next-id: 2 -->')
        self.publish(moved)
        calls = len(self.model_calls())
        job = self.round(expect='pending')
        self.assertEqual((job['attempts'], len(self.model_calls())), (0, calls))
        self.assertIn('held-over-limit line above next-id', job['error'])

    def again(self, n):
        """Run the same queued job once more, as if its hourly retry time had come."""
        job = self.read_job(n)
        job['retry_after'] = 0
        (self.queue / f'pr-{n}.json').write_text(json.dumps(job) + '\n')
        self.assertEqual(self.run_round(), 0, self.out)
        return self.read_job(n)

    def test_坏标记行跨轮反复遇到都不计次_改好后同一任务跑完(self):
        bad = {
            '编号过长': '<!-- held-over-limit: L' + '9' * 4301 + ' -->',
            '写法不对': '<!--held-over-limit: L1-->',
            '挪到声明行上面': None,
        }
        for how, line in bad.items():
            with self.subTest(how=how):
                self.tearDown(); self.setUp()
                good = lessons(301, seen=3, held='<!-- held-over-limit: L1 -->')
                broken = (good.replace('<!-- held-over-limit: L1 -->', line) if line else
                          good.replace('<!-- held-over-limit: L1 -->\n', '').replace(
                              '<!-- next-id: 2 -->', '<!-- held-over-limit: L1 -->\n<!-- next-id: 2 -->'))
                self.publish(broken)
                job = self.round(expect='pending')
                n = self.n - 1
                for _ in range(2):
                    self.assertEqual((job['status'], job['attempts'], len(self.model_calls())), ('pending', 0, 0))
                    self.assertIn('held-over-limit line', job['error'])
                    self.assertRegex(job['error'], r'line \d+')
                    job = self.again(n)
                self.publish(good)
                job = self.again(n)
                self.assertEqual((job['status'], job['attempts'], len(self.model_calls())), ('done', 0, 1), self.out)
                self.assertEqual(self.landed().held, (1,))

    def test_序言里举例的标题不挡补升_序言原样推上去(self):
        example = '说明。\n\n举例：\n\n```\n## 硬规则\n### L1\n- 规则：示例\n```'
        text = lessons(300, seen=3, held='<!-- held-over-limit: L1 -->').replace('说明。', example)
        self.publish(text)
        job = self.round()
        self.assertEqual(job['attempts'], 0)
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, got.held), ('硬规则', ()))
        self.assertTrue(self.on_origin(LESSONS).startswith('# 项目复盘经验\n\n' + example + '\n\n<!-- next-id: 2 -->\n'))

    def test_挡着期间仍超长就继续等(self):
        self.publish(lessons(301, seen=3, held='<!-- held-over-limit: L1 -->'))
        self.round()
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, got.held), ('观察中', (1,)))
        self.assertIn('继续等待：L1，301 字', self.report(50))

    def test_模型把为什么压短_按改写后的字数当轮升档(self):
        self.publish(lessons(301))
        (self.fake / 'shorten').write_text('')
        self.round()
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, got.by_id()[1].why, got.held), ('硬规则', '因', ()))

    def test_已在硬规则的超长条目照常计次不降级(self):
        self.publish(lessons(509, seen=3, section='硬规则'))
        self.round()
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, len(got.by_id()[1].seen), got.held), ('硬规则', 4, ()))
        self.assertNotIn('程序附注', self.report(50))

    def test_模型自己写标记行_整份作废计一次(self):
        self.publish(lessons(301))
        (self.fake / 'write-held').write_text('')
        before = self.on_origin(LESSONS)
        job = self.round(expect='pending')
        self.assertEqual(job['attempts'], 1)
        self.assertIn('[held]', job['error'])
        self.assertEqual(self.on_origin(LESSONS), before)
        self.assertIsNone(self.report(50))

    def test_标记行写坏_不调模型_不计次_日志写明哪一行(self):
        for bad in ('<!-- held-over-limit: 1 -->', '<!-- held-over-limit: L1 L1 -->'):
            with self.subTest(bad=bad):
                self.publish(lessons(301, seen=3, held=bad))
                calls = len(self.model_calls())
                job = self.round(expect='pending')
                self.assertEqual(job['attempts'], 0)
                self.assertEqual(len(self.model_calls()), calls)
                self.assertIn('held-over-limit line', job['error'])
                self.assertIn('line 6', job['error'])
                self.assertIn('held-over-limit', self.out)

    def test_配置填错_任务不动_改对后原任务照常跑完(self):
        self.publish(lessons(301))
        self.prs['50'] = NEW
        self.job(50, NEW, attempts=1)
        before = self.snapshot()
        for bad in ('abc', '-1', '100001', '3.5'):
            with self.subTest(bad=bad):
                self.extra_cfg = [f'RETROSPECTIVE_RULE_MAX_CHARS={bad}']
                self.assertNotEqual(self.run_round(), 0)
                self.assertIn(f"RETROSPECTIVE_RULE_MAX_CHARS must be an integer from 0 to 100000 written without leading zeros, not '{bad}'",
                              self.out)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual((self.gh_calls(), self.model_calls()), ([], []))
        self.extra_cfg = ['RETROSPECTIVE_RULE_MAX_CHARS=300']
        self.assertEqual(self.run_round(), 0, self.out)
        job = self.read_job(50)
        self.assertEqual((job['status'], job['attempts']), ('done', 1), self.out)
        self.assertIn('retrospective PR #50 committed', self.out)

    def test_上限0且没有标记时与没有上限的结果相同(self):
        self.publish(lessons(5000))
        self.round('RETROSPECTIVE_RULE_MAX_CHARS=0')
        got = self.landed()
        self.assertEqual((got.by_id()[1].section, got.held), ('硬规则', ()))
        self.assertNotIn('程序附注', self.report(50))
        self.assertNotIn('字数上限', self.model_calls()[0]['instruction'])


if __name__ == '__main__':
    unittest.main(verbosity=0 if os.environ.get('QUIET') else 1)
