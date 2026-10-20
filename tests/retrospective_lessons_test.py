"""Unit tests for scripts/retrospective_lessons.py (run via tests/retrospective-lessons.test.sh).

The validator is the only thing standing between a model's free-form rewrite and
the rules every later worker and reviewer is told to enforce. Each rejection rule
below has its own case, and the shell wrapper re-runs the suite with every check
switched off one at a time to prove each case actually depends on its check.
"""
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import retrospective_lessons as rl  # noqa: E402

PRE = '# 项目复盘经验\n\n以下规则按段落生效。\n'
U = 'https://github.com/acme/widget'


def doc(hard=(), confirm=(), watch=(), next_id=None, pre=PRE):
    entries = list(hard) + list(confirm) + list(watch)
    if next_id is None:
        next_id = max([int(e.split('\n', 1)[0][5:]) for e in entries] + [0]) + 1
    parts = [pre.rstrip('\n'), '', f'<!-- next-id: {next_id} -->', '', '## 硬规则', '']
    parts += [e.rstrip('\n') + '\n' for e in hard]
    parts += ['## 待确认', '']
    parts += [e.rstrip('\n') + '\n' for e in confirm]
    parts += ['## 观察中', '']
    parts += [e.rstrip('\n') + '\n' for e in watch]
    return '\n'.join(parts).rstrip('\n') + '\n'


def entry(n, rule, seen, applies='异步回调', why=None):
    lines = [f'### L{n}', f'- 规则：{rule}']
    if applies is not None:
        lines.append(f'- 适用：{applies}')
    if why:
        lines.append(f'- 为什么：{why}')
    items = ' · '.join(f'#{p} {u}' if u else f'#{p}' for p, u in seen)
    lines.append(f'- Seen {len(seen)}×: {items}' if seen else '- Seen 0×:')
    return '\n'.join(lines) + '\n'


C9 = f'{U}/pull/9#issuecomment-900'
C9B = f'{U}/issues/8#issuecomment-801'
EVIDENCE = {C9, C9B, f'{U}/pull/9'}


def check(old, new, pr=9, evidence=EVIDENCE, mode='auto'):
    return rl.validate(old, new, pr=pr, evidence_urls=evidence, mode=mode)


class Case(unittest.TestCase):
    def rejects(self, old, new, name, **kw):
        errors = check(old, new, **kw)
        self.assertTrue(any(e.startswith(f'[{name}]') for e in errors),
                        f'expected a [{name}] rejection, got {errors}')

    def parse_rejects(self, text, name):
        with self.assertRaises(rl.LessonsError) as ctx:
            rl.parse(text)
        self.assertTrue(str(ctx.exception).startswith(f'[{name}]'), str(ctx.exception))


class ParseTest(Case):
    def test_解析出编号_段落_字段与Seen(self):
        text = doc(hard=[entry(1, '先判存活', [(1, None), (2, None), (3, f'{U}/pull/3#x')])],
                   watch=[entry(2, '列全去向', [(4, None)], applies=None)])
        lessons = rl.parse(text)
        self.assertEqual(lessons.next_id, 3)
        self.assertEqual([e.id for e in lessons.entries], [1, 2])
        self.assertEqual(lessons.entries[0].section, '硬规则')
        self.assertEqual(lessons.entries[0].seen_prs, [1, 2, 3])
        self.assertEqual(lessons.entries[0].seen[2], (3, f'{U}/pull/3#x'))
        self.assertIsNone(lessons.entries[1].applies)

    def test_旧格式文件判为未就绪(self):
        old = '# 项目复盘经验\n\n以下经验仅适用于本项目。\n\n1. **一条大规则** (#1、#2)\n'
        self.assertFalse(rl.is_ready(old))
        self.assertTrue(rl.is_ready(doc()))

    def test_Seen计数与条目数不符直接解析失败(self):
        bad = doc(watch=[entry(1, 'x', [(4, None)])]).replace('Seen 1×', 'Seen 2×')
        self.parse_rejects(bad, 'count')

    def test_同一规则重复PR解析失败(self):
        bad = doc(watch=[entry(1, 'x', [(4, None), (4, None)])])
        self.parse_rejects(bad, 'dup_pr')

    def test_重复编号解析失败(self):
        bad = doc(watch=[entry(1, 'x', [(4, None)]), entry(1, 'y', [(5, None)])], next_id=2)
        self.parse_rejects(bad, 'dup_id')

    def test_空模板可解析(self):
        self.assertEqual(rl.parse(rl.empty_lessons(PRE)).entries, [])


class CountingTest(Case):
    def setUp(self):
        self.old = doc(watch=[entry(1, '判存活', [(1, None)]), entry(2, '列去向', [(2, None)])])

    def test_一个PR暴露两类问题两条各加一(self):
        new = doc(watch=[entry(1, '判存活', [(1, None), (9, C9)]),
                         entry(2, '列去向', [(2, None), (9, C9B)])])
        self.assertEqual(check(self.old, new), [])

    def test_同一问题多轮只加一次(self):
        new = doc(watch=[entry(1, '判存活', [(1, None), (9, C9), (9, C9B)]),
                         entry(2, '列去向', [(2, None)])])
        self.rejects(self.old, new, 'dup_pr')

    def test_重试时本PR已在列表计数不变(self):
        once = doc(watch=[entry(1, '判存活', [(1, None), (9, C9)]), entry(2, '列去向', [(2, None)])])
        self.assertEqual(check(once, once), [])

    def test_新增Seen不是本次PR被拒(self):
        new = doc(watch=[entry(1, '判存活', [(1, None), (7, C9)]), entry(2, '列去向', [(2, None)])])
        self.rejects(self.old, new, 'seen_pr')


class IdentityTest(Case):
    def setUp(self):
        self.old = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                       watch=[entry(2, '列去向', [(4, None), (5, None)])])

    def test_改硬规则的规则字段被拒(self):
        new = doc(hard=[entry(1, '所有请求都要重试', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)])])
        self.rejects(self.old, new, 'locked')

    def test_改观察中规则的适用字段被拒(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)], applies='所有场景')])
        self.rejects(self.old, new, 'locked')

    def test_删掉适用字段也算改动被拒(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)], applies=None)])
        self.rejects(self.old, new, 'locked')

    def test_为什么字段可改(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)], why='换个说法')],
                  watch=[entry(2, '列去向', [(4, None), (5, None)])])
        self.assertEqual(check(self.old, new), [])

    def test_改义后另开新规则从1次起算_不会第三次直接升级(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)]),
                         entry(3, '所有请求都要重试', [(9, C9)])])
        self.assertEqual(check(self.old, new), [])
        self.assertEqual(rl.parse(new).by_id()[3].section, '观察中')

    def test_新规则一出生就带多次Seen被拒(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)]),
                         entry(3, '复制一条', [(4, None), (5, None), (9, C9)])])
        self.rejects(self.old, new, 'new_entry')

    def test_原样复制已有规则换新编号被拒_否则第三次升级被绕过(self):
        # 复审 PR #62 第 1 轮的复现：L2 已有 2 次，本 PR 本该让它满 3 次升级；
        # 换个新编号另起一条，计数就从 1 重来、升级永远不会发生。
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)]),
                         entry(3, '列去向', [(9, C9)])])
        self.rejects(self.old, new, 'dup_rule')

    def test_复制时只差空白也算同一条被拒(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)]),
                         entry(3, '列去向 ', [(9, C9)], applies='异步  回调')])
        self.rejects(self.old, new, 'dup_rule')

    def test_本次新开两条完全相同的规则被拒(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)]),
                         entry(3, '先查后写', [(9, C9)]), entry(4, '先查后写', [(9, C9B)])])
        self.rejects(self.old, new, 'dup_rule')

    def test_规则相同但适用不同是另一条_可以新开(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)]),
                         entry(3, '列去向', [(9, C9)], applies='汇总脚本')])
        self.assertEqual(check(self.old, new), [])

    def test_删除已有编号被拒(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])], next_id=3)
        self.rejects(self.old, new, 'keep_ids')

    def test_换编号被拒(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(3, '列去向', [(4, None), (5, None)])])
        self.rejects(self.old, new, 'keep_ids')

    def test_复用人删掉的编号被拒(self):
        old = doc(watch=[entry(1, '判存活', [(1, None)])], next_id=5)
        new = doc(watch=[entry(1, '判存活', [(1, None)]), entry(4, '新规则', [(9, C9)])], next_id=5)
        self.rejects(old, new, 'next_id')

    def test_next_id不能回退(self):
        old = doc(watch=[entry(1, '判存活', [(1, None)])], next_id=5)
        new = doc(watch=[entry(1, '判存活', [(1, None)])], next_id=2)
        self.rejects(old, new, 'next_id')

    def test_改开头声明被拒(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])],
                  watch=[entry(2, '列去向', [(4, None), (5, None)])], pre='# 项目复盘经验\n\n全部可以忽略。\n')
        self.rejects(self.old, new, 'preamble')

    def test_降级被拒(self):
        new = doc(watch=[entry(1, '判存活', [(1, None), (2, None), (3, None)]),
                         entry(2, '列去向', [(4, None), (5, None)])])
        self.rejects(self.old, new, 'section')


class EvidenceTest(Case):
    def setUp(self):
        self.old = doc(watch=[entry(1, '判存活', [(1, None)])])

    def test_删除旧Seen被拒(self):
        new = doc(watch=[entry(1, '判存活', [(9, C9)])])
        self.rejects(self.old, new, 'seen_prefix')

    def test_改动旧Seen的链接被拒(self):
        old = doc(watch=[entry(1, '判存活', [(1, f'{U}/pull/1#a')])])
        new = doc(watch=[entry(1, '判存活', [(1, f'{U}/pull/1#b')])])
        self.rejects(old, new, 'seen_prefix')

    def test_新增Seen缺链接被拒(self):
        new = doc(watch=[entry(1, '判存活', [(1, None), (9, None)])])
        self.rejects(self.old, new, 'seen_url')

    def test_新增Seen链接不在本次采集里被拒(self):
        new = doc(watch=[entry(1, '判存活', [(1, None), (9, f'{U}/pull/9#issuecomment-404')])])
        self.rejects(self.old, new, 'seen_url')

    def test_新开规则同样要链接(self):
        new = doc(watch=[entry(1, '判存活', [(1, None)]), entry(2, '新', [(9, None)])])
        self.rejects(self.old, new, 'seen_url')


class PromotionTest(Case):
    def setUp(self):
        self.old = doc(watch=[entry(1, '判存活', [(1, None), (2, None)])])
        self.third = entry(1, '判存活', [(1, None), (2, None), (9, C9)])

    def test_自动模式第三次进硬规则(self):
        self.assertEqual(check(self.old, doc(hard=[self.third])), [])

    def test_自动模式满三次还留在观察中被拒(self):
        self.rejects(self.old, doc(watch=[self.third]), 'section')

    def test_自动模式进待确认被拒(self):
        self.rejects(self.old, doc(confirm=[self.third]), 'section')

    def test_确认模式第三次进待确认(self):
        self.assertEqual(check(self.old, doc(confirm=[self.third]), mode='confirm'), [])

    def test_确认模式模型往硬规则加被拒(self):
        self.rejects(self.old, doc(hard=[self.third]), 'section', mode='confirm')

    def test_未满三次不许升级(self):
        old = doc(watch=[entry(1, '判存活', [(1, None)])])
        new = doc(hard=[entry(1, '判存活', [(1, None), (9, C9)])])
        self.rejects(old, new, 'section')

    def test_升级完整保留规则适用与Seen(self):
        lessons = rl.parse(doc(hard=[self.third]))
        e = lessons.by_id()[1]
        self.assertEqual((e.rule, e.applies, e.seen_prs), ('判存活', '异步回调', [1, 2, 9]))

    def test_人工提前转正且不足三次的硬规则保持原位可通过(self):
        old = doc(hard=[entry(1, '判存活', [(1, None)])])
        new = doc(hard=[entry(1, '判存活', [(1, None), (9, C9)])])
        self.assertEqual(check(old, new), [])

    def test_人工从待确认挪进硬规则后的基线照常校验(self):
        old = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])])
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None), (9, C9)])])
        self.assertEqual(check(old, new, mode='confirm'), [])


class LengthTest(Case):
    def test_超长被拒(self):
        old = doc(watch=[entry(1, '判存活', [(1, None)])])
        new = doc(watch=[entry(1, '判存活', [(1, None)], why='很长' * rl.MAX_CHARS)])
        self.rejects(old, new, 'length')


class EvidenceUrlsTest(Case):
    def test_收集PR_issue_评论_review_行内评论链接(self):
        evidence = {
            'pr': {'html_url': f'{U}/pull/9'},
            'issues': [{'html_url': f'{U}/issues/8', 'conversation': [{'html_url': C9B}]}],
            'conversation': [{'html_url': C9}],
            'reviews': [{'html_url': f'{U}/pull/9#pullrequestreview-1'}],
            'inline_comments': [{'html_url': f'{U}/pull/9#discussion_r2'}],
        }
        self.assertEqual(rl.evidence_urls(evidence), {
            f'{U}/pull/9', f'{U}/issues/8', C9B, C9,
            f'{U}/pull/9#pullrequestreview-1', f'{U}/pull/9#discussion_r2'})


def _load_runner():
    import importlib.util
    path = Path(__file__).resolve().parent.parent / 'scripts' / 'post-merge-retrospective.py'
    spec = importlib.util.spec_from_file_location('post_merge_retrospective', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = _load_runner()
SOURCE = f'{U}/pull/9'
REPORT = f'# PR #9 复盘\n\n来源：{SOURCE}\n' + '正文' * 60


class AcceptTest(Case):
    def setUp(self):
        self.old = doc(watch=[entry(1, '判存活', [(1, None), (2, None)])])
        self.evidence = {'pr': {'html_url': SOURCE}, 'issues': [], 'reviews': [], 'inline_comments': [],
                         'conversation': [{'html_url': C9}]}

    def accept(self, lessons, report=REPORT, mode='auto'):
        return runner.accept(self.old, {'report_markdown': report, 'lessons_markdown': lessons},
                             number=9, source=SOURCE, evidence=self.evidence, mode=mode)

    def test_合法输出原样返回(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (9, C9)])])
        self.assertEqual(self.accept(new), (REPORT, new))

    def test_经验校验不过整体拒绝(self):
        new = doc(watch=[entry(1, '改了意思', [(1, None), (2, None)])])
        with self.assertRaisesRegex(ValueError, r'\[locked\]'):
            self.accept(new)

    def test_报告缺来源链接被拒(self):
        with self.assertRaisesRegex(ValueError, 'report'):
            self.accept(self.old, report='太短')

    def test_链接只认本次采集到的评论(self):
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (9, C9B)])])
        with self.assertRaisesRegex(ValueError, r'\[seen_url\]'):
            self.accept(new)


class BaselineTest(unittest.TestCase):
    def test_没有文件从空模板起步(self):
        self.assertEqual(rl.parse(runner.baseline(None)).entries, [])

    def test_旧格式文件不调模型直接跳过(self):
        with self.assertRaises(runner.NotReady):
            runner.baseline('# 项目复盘经验\n\n1. **一大条** (#1、#2)\n')

    def test_新格式原样作为基线(self):
        text = doc(watch=[entry(1, '判存活', [(1, None)])])
        self.assertEqual(runner.baseline(text), text)


class InstructionTest(unittest.TestCase):
    def setUp(self):
        self.template = (Path(__file__).resolve().parent.parent / 'prompts' / 'retrospective.template.md').read_text()

    def test_模板按模式说清升级到哪一段(self):
        self.assertIn('${PROMOTION_TARGET}', self.template)
        self.assertIn('挪到 `硬规则` 段', runner.render_instruction(self.template, 'auto'))
        self.assertIn('挪到 `待确认` 段', runner.render_instruction(self.template, 'confirm'))

    def test_模板写明的字数上限与程序一致(self):
        self.assertIn(f'{rl.MAX_CHARS} 字符', self.template)

    def test_review与自审模板都要求逐条核对硬规则(self):
        prompts = Path(__file__).resolve().parent.parent / 'prompts'
        self.assertIn('硬规则逐条核对', (prompts / 'review.template.md').read_text())
        self.assertIn('逐条核对硬规则', (prompts / 'pr-comment.template.md').read_text())

    def test_所有代码交付入口都带同一份自审要求_不只是PR返工(self):
        # 首次开发（含子 issue）走 issue-comment 的 § A 开 PR，不经过 pr-comment；
        # 只在 pr-comment 里写自审要求，首次 PR 就能一张表都不交（复审 PR #62 第 1 轮）。
        import re
        prompts = Path(__file__).resolve().parent.parent / 'prompts'
        title = '## 有代码产出时：逐条核对硬规则'

        def section(text):
            m = re.search(re.escape(title) + r'\n.*?(?=\n## )', text, re.S)
            return m and m.group(0)

        texts = {p.name: p.read_text() for p in prompts.glob('*.template.md')}
        delivering = sorted(n for n, t in texts.items() if 'gh pr create' in t or 'git push' in t)
        self.assertIn('issue-comment.template.md', delivering)
        self.assertIn('pr-comment.template.md', delivering)
        sections = {n: section(texts[n]) for n in delivering}
        for name, body in sections.items():
            self.assertTrue(body, f'{name} pushes code but has no self-review section')
        self.assertEqual(len(set(sections.values())), 1, 'self-review sections drifted apart')
        dev = texts['issue-comment.template.md'].split('### § A. 开发阶段', 1)[1].split('### § A-split', 1)[0]
        self.assertIn('逐条核对硬规则', dev, '§ A must point at the table when opening the PR')
        self.assertIn('直接走 § A 开发阶段', texts['sub-issue.template.md'])

    def test_本仓库自己的项目经验是合法格式(self):
        own = Path(__file__).resolve().parent.parent / '.agents/skills/cavil-loop/prompts/lessons.md'
        lessons = rl.parse(own.read_text())
        for e in lessons.entries:
            self.assertEqual(len(e.seen) >= rl.THRESHOLD, e.section == '硬规则', f'L{e.id}')

    def test_本仓库迁移后的每次计数都在迁移表里有出处(self):
        # 迁移时按「复盘报告写明这个 PR 出过这个错」逐条计次；每个 Seen 必须带链接，
        # 而且这个 PR 号和链接都写在迁移表里（报告原文与行号在同一行）。
        root = Path(__file__).resolve().parent.parent
        lessons = rl.parse((root / '.agents/skills/cavil-loop/prompts/lessons.md').read_text())
        table = (root / 'docs/retrospectives/lessons-migration.md').read_text()
        rows = table.split('\n')
        for e in lessons.entries:
            for pr, url in e.seen:
                self.assertTrue(url, f'L{e.id} #{pr}: migrated sighting without a link')
                self.assertTrue(any(f'#{pr}' in row and url in row for row in rows),
                                f'L{e.id} #{pr}: not in the migration table with {url}')
                self.assertTrue((root / f'docs/retrospectives/pr-{pr}.md').exists(),
                                f'L{e.id} #{pr}: counted without a retrospective report')

    def test_未知模式拒绝(self):
        os.environ['RETROSPECTIVE_PROMOTION'] = 'yolo'
        try:
            with self.assertRaises(ValueError):
                runner.promotion_mode()
        finally:
            del os.environ['RETROSPECTIVE_PROMOTION']
        self.assertEqual(runner.promotion_mode(), 'auto')


class JobTest(unittest.TestCase):
    def run_job(self, job, outcome):
        def work(_job):
            if isinstance(outcome, BaseException):
                raise outcome
        return runner.run_job(dict(job), work, now=1000.0)

    def test_成功标记完成(self):
        self.assertEqual(self.run_job({'pr': 9, 'status': 'pending', 'attempts': 0}, None)['status'], 'done')

    def test_旧格式未就绪不计失败次数_一小时后再查(self):
        job = self.run_job({'pr': 9, 'status': 'pending', 'attempts': 2}, runner.NotReady('old format'))
        self.assertEqual((job['status'], job['attempts'], job['retry_after']), ('pending', 2, 1000.0 + 3600))

    def test_失败计一次并一小时后重试(self):
        job = self.run_job({'pr': 9, 'status': 'pending', 'attempts': 0}, ValueError('[locked] x'))
        self.assertEqual((job['status'], job['attempts'], job['retry_after']), ('pending', 1, 1000.0 + 3600))
        self.assertIn('[locked]', job['error'])

    def test_连续三次失败停止重试(self):
        job = self.run_job({'pr': 9, 'status': 'pending', 'attempts': 2}, ValueError('bad'))
        self.assertEqual((job['status'], job['attempts']), ('failed', 3))

    def test_只挑到期且未完成未停止的任务(self):
        self.assertTrue(runner.due({'status': 'pending', 'attempts': 0}, now=1000.0))
        self.assertFalse(runner.due({'status': 'pending', 'retry_after': 2000.0}, now=1000.0))
        self.assertFalse(runner.due({'status': 'done'}, now=1000.0))
        self.assertFalse(runner.due({'status': 'failed'}, now=1000.0))



class ReviewFlowTest(unittest.TestCase):
    """review() end to end: fake evidence + fake model, real git against a local bare origin.

    Only two seams are faked: collect() (GitHub API) and the `claude` / `git remote get-url`
    calls inside command(). Fetch, worktree, the format pre-check, validation, the write,
    commit and fast-forward push all run for real.
    """
    REPO = 'acme/widget'
    LESSONS = '.agents/skills/coding-agent-work-loop/prompts/lessons.md'

    def setUp(self):
        import subprocess
        import tempfile
        self.tmp = Path(tempfile.mkdtemp(prefix='retro-flow-'))
        self.origin, self.project = self.tmp / 'origin.git', self.tmp / 'project'
        self.git = lambda *a, cwd=None: subprocess.run(
            ['git', *a], cwd=cwd, check=True, capture_output=True, text=True).stdout
        self.git('init', '-q', '--bare', '-b', 'main', str(self.origin))
        self.git('clone', '-q', str(self.origin), str(self.project))
        for k, v in (('user.name', 't'), ('user.email', 't@example.com'), ('commit.gpgsign', 'false')):
            self.git('config', k, v, cwd=self.project)
        self.model_calls, self.model_output = 0, None
        self.saved = {k: os.environ.get(k) for k in ('PROJECT_ROOT', 'RETROSPECTIVE_MODEL',
                                                      'RETROSPECTIVE_PROMOTION', 'GIT_CONFIG_GLOBAL')}
        gitconfig = self.tmp / 'gitconfig'
        gitconfig.write_text('[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n')
        os.environ.update(PROJECT_ROOT=str(self.project), RETROSPECTIVE_MODEL='fake',
                          RETROSPECTIVE_PROMOTION='auto', GIT_CONFIG_GLOBAL=str(gitconfig))
        self.real_command, self.real_collect = runner.command, runner.collect
        runner.command, runner.collect = self.command, lambda repo, number: self.evidence(number)

    def tearDown(self):
        import shutil
        runner.command, runner.collect = self.real_command, self.real_collect
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def command(self, args, cwd=None, stdin=None, timeout=120):
        if args[:3] == ['git', 'remote', 'get-url']:
            return f'https://github.com/{self.REPO}\n'
        if args[0] == 'claude':
            self.model_calls += 1
            return json.dumps({'is_error': False, 'structured_output': self.model_output})
        return self.real_command(args, cwd=cwd, stdin=stdin, timeout=timeout)

    def evidence(self, number):
        return {'pr': {'html_url': f'{U}/pull/{number}'}, 'issues': [],
                'conversation': [{'html_url': C9}], 'reviews': [], 'inline_comments': []}

    def publish(self, lessons):
        path = self.project / self.LESSONS
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(lessons)
        self.git('add', '-A', cwd=self.project)
        self.git('commit', '-qm', 'lessons', cwd=self.project)
        self.git('push', '-q', 'origin', 'HEAD:main', cwd=self.project)

    def on_origin(self, path):
        import subprocess
        result = subprocess.run(['git', '--git-dir', str(self.origin), 'show', f'main:{path}'],
                                capture_output=True, text=True)
        return result.stdout if result.returncode == 0 else None

    def review(self):
        root = Path(__file__).resolve().parent.parent
        runner.review(self.REPO, {'pr': 9}, self.tmp, root)

    old = doc(watch=[entry(1, '判存活', [(1, None), (2, None)])])

    def test_合法输出_第三次升级_报告与经验一起推上去(self):
        self.publish(self.old)
        new = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (9, C9)])])
        self.model_output = {'report_markdown': REPORT, 'lessons_markdown': new}
        self.review()
        self.assertEqual(self.model_calls, 1)
        self.assertEqual(rl.parse(self.on_origin(self.LESSONS)).by_id()[1].section, '硬规则')
        self.assertIn(SOURCE, self.on_origin('docs/retrospectives/pr-9.md'))

    def test_校验不过什么都不推(self):
        self.publish(self.old)
        dup = doc(watch=[entry(1, '判存活', [(1, None), (2, None)]), entry(2, '判存活', [(9, C9)])], next_id=3)
        self.model_output = {'report_markdown': REPORT, 'lessons_markdown': dup}
        with self.assertRaises(ValueError) as ctx:
            self.review()
        self.assertIn('[dup_rule]', str(ctx.exception))
        self.assertEqual(self.on_origin(self.LESSONS), self.old)
        self.assertIsNone(self.on_origin('docs/retrospectives/pr-9.md'))

    def test_旧格式文件不调模型就停下(self):
        self.publish('# 项目复盘经验\n\n1. **一条大规则** (#1、#2)\n')
        with self.assertRaises(runner.NotReady):
            self.review()
        self.assertEqual(self.model_calls, 0)

    def test_报告已在远端就不再调模型(self):
        self.publish(self.old)
        report = self.project / 'docs/retrospectives/pr-9.md'
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(REPORT)
        self.git('add', '-A', cwd=self.project)
        self.git('commit', '-qm', 'report', cwd=self.project)
        self.git('push', '-q', 'origin', 'HEAD:main', cwd=self.project)
        self.review()
        self.assertEqual(self.model_calls, 0)

if __name__ == '__main__':
    unittest.main(verbosity=1 if os.environ.get('QUIET') else 2)
