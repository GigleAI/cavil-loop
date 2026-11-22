// GitHub#651: a loop round log (one comment, one section per delivery / review) shows on its
// folded line the sum of its sections' times, how many deliveries and reviews it holds, and the
// last section's fold title. The records are written by the real scripts/round_log.py with
// footers from the real comment_footer.py, and the same records go through round_log.py's own
// cutting (`units`, what the read command, the weekly report and the per-PR statistics use) —
// the client's sections, roles, times and titles must equal those, section for section.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatDuration, roundLogOf, roundLogSections, titleSentence, wallSecsOf } from '../../src/shared/agentMetrics';
import { parse } from 'parse5';
import { buildTimeline } from '../../src/data/detail';
import { timelineDocument } from '../../src/renderer/detailHtml';
import type { ItemDetail, TimelineEntry } from '../../src/shared/actions';

const SCRIPTS = fileURLToPath(new URL('../../../scripts', import.meta.url));
// the CommonMark parser vendored for the shell tests (markdown-it-py, raw HTML on) stands in for GitHub's renderer
const VENDOR = fileURLToPath(new URL('../../../tests/lib/vendor', import.meta.url));
/** wall_secs values both sides must judge alike: in range, the edge, past it, very long, leading zeros, not numbers */
const WALL_VALUES = ['0', '1', '9007199254740991', '9007199254740992', '99999999999999999999', '9'.repeat(5000), '00000000000000000007', '0'.repeat(5000) + '5', '-1', '1.5', '', '1e3'];

interface PySection {
  sec: string;
  role: 'worker' | 'review';
  wall: number | null;
  title: string | null;
}
interface Run {
  cases: Case[];
  /** round_log.wall_secs_of and the fold title for each of WALL_VALUES */
  walls: { wall: number | null; title: string }[];
  /** the full record rendered to HTML */
  html: string;
}
interface Case {
  name: string;
  record: string;
  /** round_log.units on this one comment; null = round_log.py cannot read it */
  py: PySection[] | null;
}

/** Every record below, written and read back by the real python code in one run. */
function run(): Run {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
sys.path.insert(0, ${JSON.stringify(SCRIPTS + '/drivers/token-usage')})
sys.path.insert(0, ${JSON.stringify(VENDOR)})
import round_log as r, comment_footer as c
from markdown_it import MarkdownIt
START = 1794540000
KV = "in=1 out=2 cost_usd=1 cost_state=full models=m model_unknown=no ai_secs=5 ai_requests=1"
def foot(text, wall):
    return text + "\\n\\n" + c.render("2026-11-13 10:00:00", START, START + wall, "claude", "7", "1 input ($1.00)（模型：m）", KV, None, None)
W1 = foot("❓ 交付中有一处疑问\\n\\n## 验证结果\\n- 跑了", 625)
R1 = foot("<!-- codex-review-round:1 -->\\n> @m 说：\\n> 引用\\n\\n## ❌ 方案复审未通过，需补<b>齐</b> & 重跑\\n\\n正文", 80)
W2 = foot("✅ 修订版：补齐测试", 272)
R2 = foot("<!-- codex-review-round:2 -->\\n## ✅ 方案复审通过，可以开工", 70)
W3 = "修订版：这一轮没生成用量"
def sec(i, role, body, after=100, of=None):
    return r.section_text("aaaaaa00000%d" % i, role, "2026-01-01T0%d:00:00Z" % i, after, of, body)
def rec(*secs):
    return r.new_record("aaaaaa000001", "全文", "\\n\\n".join(secs))
full = rec(sec(1, "worker", W1), sec(2, "review", R1, of="aaaaaa000001"), sec(3, "worker", W2), sec(4, "review", R2, of="aaaaaa000003"))
partial = rec(sec(1, "worker", W1), sec(2, "review", R1, of="aaaaaa000001"), sec(3, "worker", W3))
none = rec(sec(1, "worker", W3))
dup = rec(sec(1, "worker", W1), sec(2, "review", R1), sec(1, "worker", W2))
order = rec(sec(2, "review", R1, after=300), sec(1, "worker", W1, after=200))
# a section written before fold titles existed (the header line of the older format), then a new one
oldsec = "### worker agent 交付 · 2026-01-01T05:00:00Z\\n<!-- cavil-round-log:sec id=aaaaaa000005 role=worker at=2026-01-01T05:00:00Z after=100 of=- -->\\n" + W2 + "\\n<!-- cavil-round-log:sec-end -->"
mixed_new_last = rec(oldsec, sec(6, "review", R2))
mixed_old_last = rec(sec(6, "review", R2), oldsec.replace("T05:", "T07:"))
unclosed = full.rstrip("\\n").rsplit("<!-- cavil-round-log:sec-end -->", 1)[0]
stray = full.replace("正文", "正文\\n<!-- cavil-round-log:sec-end -->", 1)
two_tops = full + "\\n<!-- cavil-round-log:top sec=bbbbbb000001 -->\\nx\\n<!-- cavil-round-log:top-end -->\\n"
crlf = full.replace("\\n", "\\r\\n")
out = []
for name, body in [("full", full), ("partial", partial), ("none", none), ("dup", dup), ("order", order),
                   ("mixed-new-last", mixed_new_last), ("mixed-old-last", mixed_old_last), ("unclosed", unclosed),
                   ("stray-marker", stray), ("two-tops", two_tops), ("crlf", crlf)]:
    try:
        us = [u for u in r.units([{"id": 9, "author": "loop-bot", "at": "", "body": body}], r.trusted_by("loop-bot")) if u["kind"] == "section"]
        py = [{"sec": u["sec"], "role": u["role"], "wall": r.wall_secs_of(u["body"]), "title": u["title"]} for u in us]
    except r.FormatError:
        py = None
    out.append({"name": name, "record": body, "py": py})
walls = []
for v in ${JSON.stringify(WALL_VALUES)}:
    b = "x\\n<!-- agent-metrics agent=claude wall_secs=%s in=1 -->" % v
    walls.append({"wall": r.wall_secs_of(b), "title": r.section_title("worker", b)})
print(json.dumps({"cases": out, "walls": walls, "html": MarkdownIt("commonmark", {"html": True}).render(full)}))`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', py], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: 'Asia/Shanghai' } }));
}

const ran = run();
const all = ran.cases;
const byName = (n: string) => all.find((c) => c.name === n)!;

describe('round log sections: the client cuts what round_log.py cuts (GitHub#651)', () => {
  it('every record: same sections, roles, times and titles as round_log.units; unreadable on both sides together', () => {
    expect(all.length).toBe(11);
    for (const c of all) {
      const ts = roundLogSections(c.record);
      if (c.py === null) {
        expect(ts, c.name).toBeUndefined();
        continue;
      }
      expect(ts, c.name).toBeDefined();
      expect(ts!.map((s) => ({ sec: s.sec, role: s.role, wall: s.wallSecs ?? null, title: s.title ?? null })), c.name).toEqual(c.py);
    }
    // the reachable side: python read most of them
    expect(all.filter((c) => c.py !== null).length).toBe(8);
    expect(all.filter((c) => c.py === null).map((c) => c.name)).toEqual(['unclosed', 'stray-marker', 'two-tops']);
  });

  it('a section id given twice counts once (the first copy), as round_log.units keeps it', () => {
    const s = roundLogSections(byName('dup').record)!;
    expect(s.map((x) => x.sec)).toEqual(['aaaaaa000001', 'aaaaaa000002']);
    expect(s[0].wallSecs).toBe(625);
    expect(roundLogOf(byName('dup').record)!.total).toBe(625 + 80);
  });

  it('the totals: every known time added, missing ones never as 0, the latest title without its time part', () => {
    const full = roundLogOf(byName('full').record)!;
    expect(full).toMatchObject({ workers: 2, reviews: 2, missing: 0, total: 625 + 80 + 272 + 70, latest: '✅ 方案复审通过，可以开工' });
    const partial = roundLogOf(byName('partial').record)!;
    expect(partial).toMatchObject({ workers: 2, reviews: 1, missing: 1, total: 625 + 80, latest: '📝 修订版：这一轮没生成用量' });
    const none = roundLogOf(byName('none').record)!;
    expect(none.total).toBeUndefined();
    expect(none.missing).toBe(1);
    // the latest section is an older one without a fold title: no sentence, the preview stays as before
    expect(roundLogOf(byName('mixed-old-last').record)!.latest).toBeUndefined();
    expect(roundLogOf(byName('mixed-old-last').record)!.total).toBe(70 + 272);
    expect(roundLogOf(byName('mixed-new-last').record)!.latest).toBe('✅ 方案复审通过，可以开工');
  });

  it('inside and outside agree: "latest" is exactly the last fold title after its time part', () => {
    for (const c of all) {
      const s = roundLogSections(c.record);
      if (!s?.length) continue;
      const last = s[s.length - 1];
      const rl = roundLogOf(c.record)!;
      if (last.title === undefined) expect(rl.latest, c.name).toBeUndefined();
      else expect(`⏱️ ${last.wallSecs === undefined ? '耗时未记录' : formatDuration(last.wallSecs)} · ${last.role === 'worker' ? 'worker' : '复审'} · ${rl.latest}`, c.name).toBe(last.title);
    }
    // the status line the worker wrote first stays, a later "## 验证结果" does not replace it
    expect(roundLogSections(byName('full').record)![0].title).toBe('⏱️ 10m 25s · worker · ❓ 交付中有一处疑问');
    expect(titleSentence('⏱️ 1m 20s · 复审 · ❌ 未通过 · 需补')).toBe('❌ 未通过 · 需补');
  });

  it('one valid range for a usage record\'s seconds on both sides: the same values in, the same verdicts out (GitHub#651 review #7)', () => {
    WALL_VALUES.forEach((v, i) => {
      const ts = wallSecsOf(`x\n<!-- agent-metrics agent=claude wall_secs=${v} in=1 -->`);
      expect(ts ?? null, v.slice(0, 24)).toBe(ran.walls[i].wall);
      // the writer's title agrees: a time exactly when both sides read one
      expect(ran.walls[i].title.startsWith(ts === undefined ? '⏱️ 耗时未记录 · ' : `⏱️ ${formatDuration(ts)} · `), v.slice(0, 24)).toBe(true);
    });
    // the reachable side: in-range values were read, the edge included
    expect(ran.walls.filter((w) => w.wall !== null).map((w) => w.wall)).toEqual([0, 1, 9007199254740991, 7, 5]);
  });

  it('a sum past the exactly representable range is no time, never a rounded one', () => {
    const big = (id: string, w: number) => `<details><summary>⏱️ x · worker · ✅ a</summary>\n\n<!-- cavil-round-log:sec id=${id} role=worker at=2026-01-01T00:00:00Z after=1 of=- -->\na\n<!-- agent-metrics agent=claude wall_secs=${w} in=1 -->\n<!-- cavil-round-log:sec-end -->\n\n</details>`;
    const rec = ['<!-- cavil-round-log:v1 -->', big('aaaaaa000001', 9007199254740991), big('aaaaaa000002', 1)].join('\n\n');
    const rl = roundLogOf(rec)!;
    expect(rl.sections.map((s) => s.wallSecs)).toEqual([9007199254740991, 1]);
    expect(rl.total).toBeUndefined();
    expect(roundLogOf(['<!-- cavil-round-log:v1 -->', big('aaaaaa000001', 9007199254740990), big('aaaaaa000002', 1)].join('\n\n'))!.total).toBe(9007199254740991);
  });

  it('not a round log: nothing', () => {
    expect(roundLogOf('正文\n<!-- agent-metrics agent=claude wall_secs=60 -->')).toBeUndefined();
    expect(roundLogOf(null)).toBeUndefined();
    expect(roundLogOf(`引用：\n${byName('full').record}`)).toBeUndefined();
  });
});

describe('the folded line of a round log (GitHub#651)', () => {
  const item = { __typename: 'Issue', id: 'I', number: 7, title: 't', url: 'u', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', bodyHTML: '<p>x</p>', body: 'x', author: null, labels: { nodes: [] } };
  const timeline = (body: string) =>
    buildTimeline({ item, comments: [{ id: 'C1', url: 'https://github.com/o/r/issues/7#issuecomment-1', createdAt: '2026-01-01T01:00:00Z', body, bodyHTML: '<p><strong>agent 往返记录</strong>：一段 agent 之间的来回……</p>', author: { login: 'loop-bot' }, viewerCanUpdate: false }], reviews: [] } as never);
  const doc = (tl: TimelineEntry[]) =>
    timelineDocument({ key: 'o/r#7', repo: 'o/r', number: 7, kind: 'issue', title: 't', url: 'https://github.com/o/r/issues/7', state: 'open', pr: null, fetchedAt: 0, labels: [], timeline: tl } as ItemDetail, false, 'none');
  const head = (html: string) => /data-entry="C1"[^>]*><summary class="head">([\s\S]*?)<\/summary>/.exec(html)![1];

  it('all times known: the sum, the counts, and the latest sentence instead of the fixed intro', () => {
    const tl = timeline(byName('full').record);
    const e = tl.find((x) => x.id === 'C1')!;
    expect(e.wallSecs).toBe(1047);
    expect(e.roundLog).toEqual({ sections: 4, workers: 2, reviews: 2, missing: 0, latest: '✅ 方案复审通过，可以开工' });
    const h = head(doc(tl));
    expect(h).toContain('<span class="dur" data-wall="1047" title="4 节耗时相加（worker 2 节、复审 2 节）；只算 agent 干活的时间，不含两节之间的等待">⏱️ 17m 27s</span>');
    expect(h).toContain('<span class="rounds" data-workers="2" data-reviews="2">交付 2 次 · 复审 2 次</span>');
    expect(h).toContain('<span class="latest">最新：</span><span data-verbatim="github">✅ 方案复审通过，可以开工</span>');
    expect(h).not.toContain('一段 agent 之间的来回');
  });

  it('some time missing: "≥" and the tooltip says how many are left out', () => {
    const h = head(doc(timeline(byName('partial').record)));
    expect(h).toContain('data-missing="1" title="3 节里有 1 节没有用量记录、未计入；已计入的 2 节相加">⏱️ ≥ 11m 45s</span>');
    expect(h).toContain('交付 2 次 · 复审 1 次');
  });

  it('no time at all: no ⏱️, the counts and the sentence still shown', () => {
    const h = head(doc(timeline(byName('none').record)));
    expect(h).not.toContain('class="dur"');
    expect(h).toContain('交付 1 次 · 复审 0 次');
    expect(h).toContain('📝 修订版：这一轮没生成用量');
  });

  it('the record as rendered HTML, through the client\'s detail: each section its own closed fold, its own footer inside it (GitHub#651 review #8)', () => {
    const tl = buildTimeline({ item, comments: [{ id: 'C1', url: 'https://github.com/o/r/issues/7#issuecomment-1', createdAt: '2026-01-01T01:00:00Z', body: byName('full').record, bodyHTML: ran.html, author: { login: 'loop-bot' }, viewerCanUpdate: false }], reviews: [] } as never);
    // unfolded, so the record's own HTML is in the document
    const html = timelineDocument({ key: 'o/r#7', repo: 'o/r', number: 7, kind: 'issue', title: 't', url: 'https://github.com/o/r/issues/7', state: 'open', pr: null, fetchedAt: 0, labels: [], timeline: tl } as ItemDetail, false, 'all');
    type N = { nodeName: string; attrs?: { name: string; value: string }[]; childNodes?: N[]; value?: string };
    const all: N[] = [];
    const walk = (n: N) => { all.push(n); (n.childNodes ?? []).forEach(walk); };
    walk(parse(html) as unknown as N);
    const text = (n: N): string => (n.nodeName === '#text' ? n.value! : (n.childNodes ?? []).map(text).join(''));
    const cls = (n: N) => n.attrs?.find((a) => a.name === 'class')?.value ?? '';
    const entry = all.find((n) => n.nodeName === 'details' && n.attrs?.some((a) => a.name === 'data-entry' && a.value === 'C1'))!;
    const md: N[] = [];
    const walkMd = (n: N) => { if (n.nodeName === 'div' && cls(n) === 'md') md.push(n); (n.childNodes ?? []).forEach(walkMd); };
    walkMd(entry);
    expect(md).toHaveLength(1);
    const kids = (n: N) => (n.childNodes ?? []).filter((c) => c.nodeName === 'details');
    const summaryOf = (n: N) => text((n.childNodes ?? []).find((c) => c.nodeName === 'summary')!);
    const secs = kids(md[0]).filter((d) => summaryOf(d).startsWith('⏱️ ') && !summaryOf(d).startsWith('⏱️ 耗时：'));
    // four sibling folds directly in the comment, none open: opening one does not open a neighbour
    expect(secs.map(summaryOf)).toEqual(roundLogSections(byName('full').record)!.map((s) => s.title));
    expect(secs.filter((d) => d.attrs!.some((a) => a.name === 'open'))).toEqual([]);
    for (const [i, d] of secs.entries()) {
      // each holds exactly one nested fold — its own usage footer — and no other section
      const inner = kids(d);
      expect(inner.map(summaryOf).every((s) => s.startsWith('⏱️ 耗时：')), String(i)).toBe(true);
      expect(inner, String(i)).toHaveLength(1);
      const others = secs.filter((x) => x !== d).map((x) => summaryOf(x).split(' · ')[2]);
      for (const o of others) expect(text(d), `${i}: ${o}`).not.toContain(o);
    }
    expect(text(secs[0])).toContain('验证结果');
    // the title was escaped by the writer, so it reads literally; the body is real markdown, so its tag renders
    expect(summaryOf(secs[1])).toBe('⏱️ 1m 20s · 复审 · ❌ 方案复审未通过，需补<b>齐</b> & 重跑');
    expect(text(secs[1]).slice(summaryOf(secs[1]).length)).toContain('❌ 方案复审未通过，需补齐 & 重跑');
  });

  it('a record that cannot be read: exactly as before (no time, no counts, the intro as the preview)', () => {
    for (const n of ['unclosed', 'stray-marker', 'two-tops']) {
      const e = timeline(byName(n).record).find((x) => x.id === 'C1')!;
      expect(e.roundLog, n).toBeUndefined();
      expect(e.wallSecs, n).toBeUndefined();
      const h = head(doc([e]));
      expect(h, n).not.toContain('class="dur"');
      expect(h, n).not.toContain('class="rounds"');
      expect(h, n).toContain('一段 agent 之间的来回');
    }
  });
});
