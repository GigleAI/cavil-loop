"""Unit tests for scripts/retrospective_lessons.py (run via tests/retrospective-lessons.test.sh).

The validator is the only thing standing between a model's free-form rewrite and
the rules every later worker and reviewer is told to enforce. Each rejection rule
below has its own case, and the shell wrapper re-runs the suite with every check
switched off one at a time to prove each case actually depends on its check.
"""
import json
import os
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import retrospective_lessons as rl  # noqa: E402

PRE = '# 项目复盘经验\n\n以下规则按段落生效。\n'
U = 'https://github.com/acme/widget'


def doc(hard=(), confirm=(), watch=(), next_id=None, pre=PRE, dirs=None):
    """dirs=None: no 目录经验 section at all; dirs=[] / [...]: the section is there."""
    entries = list(hard) + list(confirm) + list(watch) + list(dirs or ())
    if next_id is None:
        next_id = max([int(e.split('\n', 1)[0][5:]) for e in entries] + [0]) + 1
    parts = [pre.rstrip('\n'), '', f'<!-- next-id: {next_id} -->', '', '## 硬规则', '']
    parts += [e.rstrip('\n') + '\n' for e in hard]
    parts += ['## 待确认', '']
    parts += [e.rstrip('\n') + '\n' for e in confirm]
    parts += ['## 观察中', '']
    parts += [e.rstrip('\n') + '\n' for e in watch]
    if dirs is not None:
        parts += ['## 目录经验', '']
        parts += [e.rstrip('\n') + '\n' for e in dirs]
    return '\n'.join(parts).rstrip('\n') + '\n'


def entry(n, rule, seen, applies='异步回调', why=None):
    lines = [f'### L{n}', f'- 规则：{rule}']
    if applies is not None:
        lines.append(f'- 适用：{applies}')
    if why:
        lines.append(f'- 为什么：{why}')
    def item(s):
        p, u, ds = (tuple(s) + (None,))[:3]
        text = f'#{p} {u}' if u else f'#{p}'
        return text + (f' [{" · ".join(ds)}]' if ds else '')
    items = ' · '.join(item(s) for s in seen)
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
        self.assertEqual(lessons.entries[0].seen[2], (3, f'{U}/pull/3#x', None))
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
    # RETRO_RUNNER: a deliberately broken copy (tests/retrospective-lessons.test.sh, MUTATION=1)
    path = Path(os.environ.get('RETRO_RUNNER') or
                Path(__file__).resolve().parent.parent / 'scripts' / 'post-merge-retrospective.py')
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
        # 迁移表只管迁移那一次：它自己写明「只在迁移时写一次；之后的 Seen 由复盘程序追加……
        # 不再记在这里」，并列出当时有报告的 PR。之后复盘追加的（#62 起）不该去表里找出处——
        # 以前不分来源一律查表，第一次自动复盘（#79）追加计数后这条就永久红了。
        m = re.search(r'只有 (\d+) 个 PR 有复盘报告（([^）]*)）', table)
        self.assertIsNotNone(m, 'migration table no longer states which PRs it covers')
        migrated = {int(x) for x in re.findall(r'#(\d+)', m.group(2))}
        self.assertEqual(len(migrated), int(m.group(1)), 'migration table: PR count does not match its list')
        checked = 0
        for e in lessons.entries:
            for pr, url, _ in e.seen:
                self.assertTrue(url, f'L{e.id} #{pr}: sighting without a link')
                if int(pr) in migrated:
                    checked += 1
                    self.assertTrue(any(f'#{pr}' in row and url in row for row in rows),
                                    f'L{e.id} #{pr}: not in the migration table with {url}')
                self.assertTrue((root / f'docs/retrospectives/pr-{pr}.md').exists(),
                                f'L{e.id} #{pr}: counted without a retrospective report')
        self.assertGreater(checked, 0, 'no migrated sighting was checked against the table')

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
        self.model_input, self.model_instruction, self.files_calls = None, None, 0
        self.pr_files = []
        self.saved = {k: os.environ.get(k) for k in ('PROJECT_ROOT', 'RETROSPECTIVE_MODEL',
                                                      'RETROSPECTIVE_PROMOTION', 'GIT_CONFIG_GLOBAL',
                                                      'POST_RETROSPECTIVE_PROJECT_CMD', 'GH_TOKEN')}
        os.environ.pop('POST_RETROSPECTIVE_PROJECT_CMD', None)
        gitconfig = self.tmp / 'gitconfig'
        gitconfig.write_text('[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n')
        os.environ.update(PROJECT_ROOT=str(self.project), RETROSPECTIVE_MODEL='fake',
                          RETROSPECTIVE_PROMOTION='auto', GIT_CONFIG_GLOBAL=str(gitconfig))
        self.real_command, self.real_collect = runner.command, runner.collect
        self.real_files, self.real_timeout = runner.changed_files, runner.PROJECT_CMD_TIMEOUT
        runner.command, runner.collect = self.command, lambda repo, number: self.evidence(number)
        runner.changed_files = self.changed_files

    def changed_files(self, repo, number):
        self.files_calls += 1
        return set(self.pr_files)

    def tearDown(self):
        import shutil
        runner.command, runner.collect = self.real_command, self.real_collect
        runner.changed_files, runner.PROJECT_CMD_TIMEOUT = self.real_files, self.real_timeout
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
            self.model_input = json.loads(stdin)
            self.model_instruction = args[args.index('--system-prompt') + 1]
            return json.dumps({'is_error': False, 'structured_output': self.model_output})
        return self.real_command(args, cwd=cwd, stdin=stdin, timeout=timeout)

    def evidence(self, number):
        return {'pr': {'html_url': f'{U}/pull/{number}'}, 'issues': [],
                'conversation': [{'html_url': C9}], 'reviews': [], 'inline_comments': []}

    def publish(self, lessons, files=None):
        path = self.project / self.LESSONS
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(lessons)
        for name, text in (files or {}).items():
            (self.project / name).parent.mkdir(parents=True, exist_ok=True)
            (self.project / name).write_text(text)
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

    def last_commit_files(self):
        out = self.git('--git-dir', str(self.origin), 'show', '--name-only', '--format=%s', 'main')
        lines = [l for l in out.split('\n') if l]
        return lines[0], sorted(lines[1:])

    def commits_on_origin(self):
        return int(self.git('--git-dir', str(self.origin), 'rev-list', '--count', 'main').strip())

    def test_不配项目命令时提交只有报告和经验(self):
        self.publish(self.old)
        self.model_output = {'report_markdown': REPORT,
                             'lessons_markdown': doc(hard=[entry(1, '判存活', [(1, None), (2, None), (9, C9)])])}
        self.review()
        self.assertEqual(self.last_commit_files(), (f'docs: learn from {self.REPO}#9',
                                                    sorted(['docs/retrospectives/pr-9.md', self.LESSONS])))

    def test_没有目录段时不取改动文件_输入与提示词不带目录(self):
        self.publish(self.old)
        self.model_output = {'report_markdown': REPORT, 'lessons_markdown': self.old}
        self.review()
        self.assertEqual(self.model_calls, 1)
        self.assertEqual(self.files_calls, 0)
        self.assertEqual(sorted(self.model_input), ['evidence', 'lessons_markdown', 'templates'])
        self.assertNotIn('目录经验', self.model_instruction)

    def test_有目录段时给出改动目录并推上带目录的新记录(self):
        old = doc(watch=[entry(1, '判存活', [(1, None)])], dirs=[])
        self.publish(old, {'server/credits/charge.ts': 'x\n', 'server/usage/meter.ts': 'y\n'})
        self.pr_files = ['server/credits/charge.ts', 'server/removed/old.ts']
        new = doc(watch=[entry(1, '判存活', [(1, None)])],
                  dirs=[entry(2, '锁账户再扣', [(9, C9, ('server/credits/',))])])
        self.model_output = {'report_markdown': REPORT, 'lessons_markdown': new}
        self.review()
        self.assertEqual(self.files_calls, 1)
        self.assertEqual(self.model_input['directories'], ['server/', 'server/credits/'])
        self.assertIn('## 目录经验', self.model_instruction)
        self.assertEqual(rl.parse(self.on_origin(self.LESSONS)).by_id()[2].seen[0][2], ('server/credits/',))

    def test_目录不在合并后的树里整份不推(self):
        old = doc(watch=[entry(1, '判存活', [(1, None)])], dirs=[])
        self.publish(old)
        new = doc(watch=[entry(1, '判存活', [(1, None)])],
                  dirs=[entry(2, '锁账户再扣', [(9, C9, ('server/credits/',))])])
        self.model_output = {'report_markdown': REPORT, 'lessons_markdown': new}
        before = self.commits_on_origin()
        with self.assertRaisesRegex(ValueError, r'\[dir_valid\]'):
            self.review()
        self.assertEqual(self.commits_on_origin(), before)

    def run_with_command(self, cmd, tracked=None):
        self.publish(self.old, tracked or {'server/credits/AGENTS.md': '# credits\n'})
        os.environ['POST_RETROSPECTIVE_PROJECT_CMD'] = cmd
        os.environ['GH_TOKEN'] = 'secret-token-for-test'
        self.model_output = {'report_markdown': REPORT,
                             'lessons_markdown': doc(hard=[entry(1, '判存活', [(1, None), (2, None), (9, C9)])])}
        return self.commits_on_origin()

    def test_项目命令的改动与新文件和复盘同一个提交(self):
        cmd = ('set -e; grep -q "## 硬规则" "$RETROSPECTIVE_LESSONS_FILE"; '
               'echo "- 来自 #$RETROSPECTIVE_PR" >> server/credits/AGENTS.md; '
               'mkdir -p server/usage && echo "# usage" > server/usage/AGENTS.md; '
               'echo ignored > build.log; echo "token=${GH_TOKEN:-none}" > env.txt; echo ranked')
        before = self.run_with_command(cmd, {'server/credits/AGENTS.md': '# credits\n', '.gitignore': '*.log\n'})
        self.review()
        self.assertEqual(self.commits_on_origin(), before + 1)
        subject, files = self.last_commit_files()
        self.assertEqual(subject, f'docs: learn from {self.REPO}#9')
        self.assertEqual(files, sorted(['docs/retrospectives/pr-9.md', self.LESSONS, 'env.txt',
                                        'server/credits/AGENTS.md', 'server/usage/AGENTS.md']))
        self.assertEqual(self.on_origin('server/credits/AGENTS.md'), '# credits\n- 来自 #9\n')
        self.assertEqual(self.on_origin('env.txt'), 'token=none\n')
        self.assertIsNone(self.on_origin('build.log'))

    def test_项目命令失败什么都不推_输出进错误(self):
        before = self.run_with_command('echo half >> server/credits/AGENTS.md; echo boom-detail; exit 3')
        with self.assertRaisesRegex(RuntimeError, r'exited 3: .*boom-detail'):
            self.review()
        self.assertEqual(self.commits_on_origin(), before)
        self.assertIsNone(self.on_origin('docs/retrospectives/pr-9.md'))
        self.assertEqual(self.on_origin('server/credits/AGENTS.md'), '# credits\n')

    def test_项目命令超时什么都不推(self):
        # bash 后面还有命令就不会 exec sleep：真的派生了子进程。只杀 bash 的话，子进程占着
        # 输出管道，复盘要干等它睡完——整组杀掉才能按时返回。
        import time
        runner.PROJECT_CMD_TIMEOUT = 1
        before = self.run_with_command('echo started; sleep 30; echo late')
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'timed out after 1s: started'):
            self.review()
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(self.commits_on_origin(), before)

    def test_项目命令改了经验文件被拒(self):
        before = self.run_with_command('echo "- 偷改" >> "$RETROSPECTIVE_LESSONS_FILE"')
        with self.assertRaisesRegex(RuntimeError, 'changed the validated'):
            self.review()
        self.assertEqual(self.commits_on_origin(), before)

    def test_项目命令改了报告被拒(self):
        before = self.run_with_command('rm "$RETROSPECTIVE_REPORT_FILE"')
        with self.assertRaisesRegex(RuntimeError, 'changed the validated'):
            self.review()
        self.assertEqual(self.commits_on_origin(), before)

    def test_项目命令自己提交被拒(self):
        before = self.run_with_command('echo x >> server/credits/AGENTS.md && git commit -qam sneaky')
        with self.assertRaisesRegex(RuntimeError, 'own commit'):
            self.review()
        self.assertEqual(self.commits_on_origin(), before)

# ── 目录经验（GitHub#152）──────────────────────────────────────────────────────

class DirTree:
    """A throwaway merged tree: server/credits/, server/usage/, docs/, and a link out of it."""
    def setUp(self):
        import tempfile
        self.root = Path(tempfile.mkdtemp(prefix='retro-dirs-'))
        for d in ('server/credits', 'server/usage', 'docs'):
            (self.root / d).mkdir(parents=True)
        self.outside = Path(tempfile.mkdtemp(prefix='retro-outside-'))
        (self.root / 'escape').symlink_to(self.outside)
        (self.root / 'server/file.txt').write_text('x')

    def tearDown(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.outside, ignore_errors=True)


CRED, USAGE = 'server/credits/', 'server/usage/'


class DirectoryParseTest(Case):
    def test_第四段可选_记录带多个目录(self):
        text = doc(watch=[entry(1, '判存活', [(1, None)])],
                   dirs=[entry(2, '锁账户再扣', [(3, f'{U}/pull/3#a', (CRED,)), (4, f'{U}/pull/4#b', (CRED, USAGE))])])
        lessons = rl.parse(text)
        self.assertTrue(lessons.has_dirs)
        e = lessons.by_id()[2]
        self.assertEqual((e.section, e.seen_prs), ('目录经验', [3, 4]))
        self.assertEqual(e.seen[1], (4, f'{U}/pull/4#b', (CRED, USAGE)))
        self.assertFalse(rl.parse(doc(watch=[entry(1, '判存活', [(1, None)])])).has_dirs)

    def test_目录段不在最后解析失败(self):
        text = doc(dirs=[]).replace('## 目录经验\n', '')
        text = text.replace('## 观察中', '## 目录经验\n\n## 观察中')
        with self.assertRaises(rl.LessonsError):
            rl.parse(text)

    def test_前三段的记录不许带目录(self):
        with self.assertRaisesRegex(rl.LessonsError, 'directories only belong'):
            rl.parse(doc(watch=[entry(1, '判存活', [(1, None, (CRED,))])]))

    def test_没有目录段的文件解析结果不变(self):
        text = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])])
        self.assertEqual(rl.prompt_text(text), text)


class DirectoryValidateTest(DirTree, Case):
    def setUp(self):
        DirTree.setUp(self)
        self.watch = entry(1, '判存活', [(1, None)])
        self.old = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,))])])

    def check(self, old, new, **kw):
        return check(old, new, **kw) if 'repo_root' in kw else \
            rl.validate(old, new, pr=9, evidence_urls=EVIDENCE, mode='auto', repo_root=self.root)

    def rejects(self, old, new, name):
        errors = self.check(old, new)
        self.assertTrue(any(e.startswith(f'[{name}]') for e in errors), f'expected [{name}], got {errors}')

    def new_with(self, sightings, section_dirs=True):
        return doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,))] + sightings)])

    def test_追加带目录的记录通过(self):
        self.assertEqual(self.check(self.old, self.new_with([(9, C9, (CRED, USAGE))])), [])

    def test_新开目录经验条目通过(self):
        new = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,))]),
                                            entry(3, '计量先落库', [(9, C9, (USAGE,))])], next_id=4)
        self.assertEqual(self.check(self.old, new), [])

    def test_新记录不带目录被拒(self):
        self.rejects(self.old, self.new_with([(9, C9)]), 'dir_required')

    def test_新条目的记录不带目录被拒(self):
        new = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,))]),
                                            entry(3, '计量先落库', [(9, C9)])], next_id=4)
        self.rejects(self.old, new, 'dir_required')

    def test_不存在的目录被拒(self):
        self.rejects(self.old, self.new_with([(9, C9, ('server/billing/',))]), 'dir_valid')

    def test_新条目的目录同样核对(self):
        new = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,))]),
                                            entry(3, '计量先落库', [(9, C9, ('nope/',))])], next_id=4)
        self.rejects(self.old, new, 'dir_valid')

    def test_非法目录写法逐个被拒(self):
        for bad in ('/etc/', '../outside/', 'server/../docs/', 'server/credits', './server/',
                    'server//credits/', '~/x/', 'server\\credits/', '.git/', 'escape/', 'server/file.txt/', '/'):
            with self.subTest(bad=bad):
                self.rejects(self.old, self.new_with([(9, C9, (bad,))]), 'dir_valid')

    def test_没有合并后的目录树无法核对(self):
        errors = rl.validate(self.old, self.new_with([(9, C9, (CRED,))]), pr=9,
                             evidence_urls=EVIDENCE, mode='auto')
        self.assertTrue(any(e.startswith('[dir_valid]') for e in errors), errors)

    def test_改已有记录的目录被拒(self):
        new = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (USAGE,)), (9, C9, (CRED,))])])
        self.rejects(self.old, new, 'seen_prefix')

    def test_删已有记录被拒(self):
        new = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(9, C9, (CRED,))])])
        self.rejects(self.old, new, 'seen_prefix')

    def test_旧记录的目录后来被删不追溯(self):
        old = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, ('gone/',))])])
        new = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, ('gone/',)), (9, C9, (CRED,))])])
        self.assertEqual(self.check(old, new), [])

    def test_同一PR记两次被拒(self):
        self.rejects(self.old, self.new_with([(9, C9, (CRED,)), (9, C9B, (USAGE,))]), 'dup_pr')

    def test_满三次留在本段通过且不要求升级(self):
        old = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,)), (4, None, (CRED,))])])
        new = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,)), (4, None, (CRED,)),
                                                                   (9, C9, (CRED,))])])
        self.assertEqual(self.check(old, new), [])

    def test_满三次挪进硬规则被拒(self):
        old = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,)), (4, None, (CRED,))])])
        third = [(3, None), (4, None), (9, C9)]
        new = doc(hard=[entry(2, '锁账户再扣', third)], watch=[self.watch], dirs=[])
        self.rejects(old, new, 'dir_section')

    def test_流程经验挪进目录经验被拒(self):
        new = doc(dirs=[entry(1, '判存活', [(1, None, (CRED,))]), entry(2, '锁账户再扣', [(3, None, (CRED,))])])
        self.rejects(self.old, new, 'dir_section')

    def test_硬规则借道挪进目录经验被拒(self):
        old = doc(hard=[entry(1, '判存活', [(1, None), (2, None), (3, None)])], dirs=[])
        new = doc(dirs=[entry(1, '判存活', [(1, None), (2, None), (3, None)])])
        self.rejects(old, new, 'dir_section')

    def test_基线没有目录段时模型不许自己加(self):
        old = doc(watch=[self.watch])
        new = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(9, C9, (CRED,))])])
        self.rejects(old, new, 'dir_section')

    def test_原样抄流程经验进目录经验被拒(self):
        new = doc(watch=[self.watch], dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,))]),
                                            entry(3, '判存活', [(9, C9, (CRED,))])], next_id=4)
        self.rejects(self.old, new, 'dup_rule')

    def test_新条目开在观察中或目录经验以外被拒(self):
        new = doc(confirm=[entry(3, '计量先落库', [(9, C9)])], watch=[self.watch],
                  dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,))])], next_id=4)
        self.rejects(self.old, new, 'section')

    def test_目录段单独计字数_不挤占流程经验(self):
        long_dir = entry(2, '锁账户再扣', [(3, None, (CRED,))], why='长' * (rl.MAX_CHARS - 1000))
        old = doc(watch=[entry(1, '判存活', [(1, None)], why='短' * (rl.MAX_CHARS - 1000))], dirs=[long_dir])
        self.assertGreater(len(old), rl.MAX_CHARS)
        self.assertEqual(self.check(old, old), [])

    def test_目录段自身超长被拒(self):
        huge = entry(2, '锁账户再扣', [(3, None, (CRED,))], why='长' * rl.MAX_DIR_CHARS)
        self.rejects(self.old, doc(watch=[self.watch], dirs=[huge]), 'length')

    def test_流程部分超长仍被拒(self):
        new = doc(watch=[entry(1, '判存活', [(1, None)], why='长' * rl.MAX_CHARS)],
                  dirs=[entry(2, '锁账户再扣', [(3, None, (CRED,))])])
        self.rejects(self.old, new, 'length')


class DirectoryInputTest(DirTree, unittest.TestCase):
    def test_改动目录只列合并后还在的(self):
        paths = {'server/credits/charge.ts', 'server/usage/meter.ts', 'server/gone/x.ts', 'README.md'}
        self.assertEqual(runner.changed_directories(paths, self.root),
                         ['server/', 'server/credits/', 'server/usage/'])


class DirectoryInstructionTest(unittest.TestCase):
    def setUp(self):
        self.template = (Path(__file__).resolve().parent.parent / 'prompts' / 'retrospective.template.md').read_text()

    def test_未开启时提示词与去掉占位符的模板逐字节相同(self):
        self.assertIn('${DIRECTORY_LESSONS}', self.template)
        for mode in ('auto', 'confirm'):
            plain = self.template.replace('${DIRECTORY_LESSONS}', '')
            expected = plain.replace('${PROMOTION_TARGET}', '硬规则' if mode == 'auto' else '待确认')
            self.assertEqual(runner.render_instruction(self.template, mode), expected)
            self.assertNotIn('目录经验', runner.render_instruction(self.template, mode))

    def test_开启时写明格式_目录来源与不升级(self):
        text = runner.render_instruction(self.template, 'auto', True)
        self.assertNotIn('${', text)
        for needle in ('## 目录经验', '[server/credits/ · server/usage/]', '`directories`',
                       '留在本段', f'{rl.MAX_DIR_CHARS} 字符'):
            self.assertIn(needle, text)


if __name__ == '__main__':
    unittest.main(verbosity=1 if os.environ.get('QUIET') else 2)
