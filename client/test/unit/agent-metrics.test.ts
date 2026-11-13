// GitHub#503: the folded line of a discussion entry shows the round's total time, read
// from the usage record the loop appends to its comments. The footer is produced by the
// real comment_footer.py (its pure `render`), so the client's reading and the footer's
// visible "耗时：…" are compared on the same text; the two recorded comments are real
// GitHub answers (source + rendered HTML), re-recorded with:
//   gh api graphql -f query='query{repository(owner:"GigleAI",name:"cavil-loop"){issue(number:503){comments(first:2){nodes{id url createdAt body bodyHTML author{login}}}}}}'

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatDuration, wallSecsOf, withoutFooter } from '../../src/shared/agentMetrics';
import { buildTimeline } from '../../src/data/detail';
import { plainExcerpt, timelineDocument } from '../../src/renderer/detailHtml';
import type { ItemDetail, TimelineEntry } from '../../src/shared/actions';

const FOOTER_DIR = fileURLToPath(new URL('../../../scripts/drivers/token-usage', import.meta.url));
const recorded = JSON.parse(readFileSync(new URL('../fixtures/footer-comments.github.json', import.meta.url), 'utf8')) as {
  comments: { id: string; url: string; createdAt: string; body: string; bodyHTML: string; author: { login: string } }[];
};

const WALLS = [0, 9, 59, 60, 61, 2527, 3599, 3600, 3725, 86399, 90061];

/** The real footer for each wall time, and the real fmt_dur for each number, from one python run. */
function realFooters(): { footers: string[]; fmt: string[] } {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(FOOTER_DIR)})
import comment_footer as c
walls = ${JSON.stringify(WALLS)}
start = 1794540000
kv = "in=1 out=2 cost_usd=1 cost_state=full models=m model_unknown=no ai_secs=5 ai_requests=1"
print(json.dumps({
  "footers": [c.render("2026-11-13 10:00:00", start, start + w, "claude", "7", "1 input, 2 output ($1.00)（模型：m）", kv, None, None) for w in walls],
  "fmt": [c.fmt_dur(w) for w in walls],
}))`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', py], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: 'Asia/Shanghai' } }));
}

/** what the footer's own head line says after "耗时：" */
const visible = (footer: string) => /<summary>⏱️ 耗时：(.+?)（/.exec(footer)?.[1];

describe('total time from the usage record (GitHub#503)', () => {
  const real = realFooters();

  it('the duration is written exactly as the footer writes it', () => {
    expect(WALLS.map(formatDuration)).toEqual(real.fmt);
  });

  it('a comment ending with the real footer: the record\'s seconds, shown as the footer\'s own head shows them', () => {
    WALLS.forEach((w, i) => {
      const footer = real.footers[i];
      for (const nl of ['\n', '\r\n']) {
        const body = ['## 标题', '', '正文', '', footer, ''].join('\n').replace(/\n/g, nl);
        expect(wallSecsOf(body), `${w}s`).toBe(w);
        expect(formatDuration(wallSecsOf(body)!)).toBe(visible(footer));
      }
    });
  });

  it('real recorded comments: read through the detail timeline, the time matches the visible footer', () => {
    const tl = buildTimeline({
      item: { __typename: 'Issue', id: 'I', number: 503, title: 't', url: 'u', state: 'OPEN', createdAt: '2026-11-13T00:00:00Z', bodyHTML: '<p>x</p>', body: 'x', author: null, labels: { nodes: [] } },
      comments: recorded.comments.map((c) => ({ ...c, viewerCanUpdate: false })),
      reviews: [],
    });
    const byId = new Map(tl.map((e) => [e.id, e]));
    expect(recorded.comments).toHaveLength(2);
    for (const c of recorded.comments) {
      const e = byId.get(c.id)!;
      expect(e.wallSecs).toBeGreaterThan(0);
      expect(formatDuration(e.wallSecs!)).toBe(visible(c.bodyHTML));
    }
    // the opening post has no record: nothing
    expect(byId.get('I')!.wallSecs).toBeUndefined();
  });

  it('no valid record on the last non-empty line: no time', () => {
    const rec = (f: string) => `<!-- agent-metrics agent=claude wt=1 ${f} in=1 -->`;
    const cases: [string, unknown][] = [
      ['no record', '正文\n\n耗时：5m 3s'],
      ['the visible line alone', '<details><summary>⏱️ 耗时：8m 0s（AI 约 1m）</summary>\n\n</details>'],
      ['record not on the last line', `${rec('wall_secs=60')}\n后面还有字`],
      ['a record quoted in the middle, text after it', `示例：\n\n${rec('wall_secs=60')}\n\n收尾`],
      ['inside a code block', `\`\`\`\n${rec('wall_secs=60')}\n\`\`\``],
      ['field missing', rec('wall=60')],
      ['decimal', rec('wall_secs=60.5')],
      ['negative', rec('wall_secs=-60')],
      ['empty', rec('wall_secs=')],
      ['given twice', rec('wall_secs=60 wall_secs=61')],
      ['too large to be exact', rec('wall_secs=99999999999999999999')],
      ['another record name', '<!-- agent-metricsx wall_secs=60 -->'],
      ['not text', null],
      ['not text', 60],
    ];
    for (const [why, src] of cases) expect(wallSecsOf(src), why).toBeUndefined();
    // the reachable side of the same shapes
    expect(wallSecsOf(rec('wall_secs=60'))).toBe(60);
    expect(wallSecsOf(`正文\n${rec('wall_secs=60')}\n\n  \n`)).toBe(60);
  });

  it('the preview leaves out the footer: real GitHub HTML, the GitHub#88 layout, and HTML with no footer', () => {
    for (const c of recorded.comments) {
      const head = `⏱️ 耗时：${visible(c.bodyHTML)}（`;
      expect(plainExcerpt(c.bodyHTML, 100000)).toContain(head);
      const cut = withoutFooter(c.bodyHTML);
      // exactly the text before the footer's rule: the footer and the rule are gone, nothing else
      expect(c.bodyHTML.startsWith(cut)).toBe(true);
      expect(c.bodyHTML.slice(cut.length)).toMatch(/^\s*<hr>\s*<details><summary>⏱️ 耗时：[^<]*<\/summary>[\s\S]*<\/details>\s*$/);
      expect(plainExcerpt(cut, 100000)).not.toContain(head);
      expect(cut.length).toBeGreaterThan(c.bodyHTML.length / 2);
    }
    const old = '<p>正文</p>\n<hr>\n<p dir="auto">⏱️ 耗时：8m 0s（AI 约 2m）｜模型：m</p>\n<details><summary>细节</summary><ul><li>开始</li></ul></details>';
    expect(withoutFooter(old)).toBe('<p>正文</p>');
    // a quoted footer earlier and the real one last: cut at the last one
    const two = '<p>例子</p><details><summary>⏱️ 耗时：1s（…）</summary></details><p>中间</p><hr><details><summary>⏱️ 耗时：2s（…）</summary></details>';
    expect(withoutFooter(two)).toBe('<p>例子</p><details><summary>⏱️ 耗时：1s（…）</summary></details><p>中间</p>');
    expect(withoutFooter('<p>没有用量</p>')).toBe('<p>没有用量</p>');
  });
});

describe('the folded line and the unfolded entry (GitHub#503)', () => {
  const entry = (over: Partial<TimelineEntry>): TimelineEntry => ({
    kind: 'comment',
    id: 'C1',
    url: 'https://github.com/o/r/issues/1#issuecomment-1',
    author: 'bot',
    at: '2026-11-13T05:15:00Z',
    bodyHtml: '<p>已修复两条</p><hr><details><summary>⏱️ 耗时：42m 7s（AI 约 10m）｜模型：m</summary><ul><li>开始</li></ul></details>',
    ...over,
  });
  const doc = (timeline: TimelineEntry[]) =>
    timelineDocument({ key: 'o/r#1', repo: 'o/r', number: 1, kind: 'issue', title: 't', url: 'https://github.com/o/r/issues/1', state: 'open', pr: null, fetchedAt: 0, labels: [], timeline } as ItemDetail, false, 'none');
  const summary = (html: string, id: string) => new RegExp(`data-entry="${id}"[^>]*><summary class="head">([\\s\\S]*?)</summary>`).exec(html)![1];

  it('with a record: the time sits in the head, no web link there; the preview has no footer text', () => {
    const html = doc([entry({ wallSecs: 2527 })]);
    const head = summary(html, 'C1');
    expect(head).toContain('<span class="dur" data-wall="2527"');
    expect(head).toContain('⏱️ 42m 7s</span>');
    expect(head).not.toContain('<a ');
    expect(head).not.toContain('在网页上看');
    expect(head).toContain('已修复两条');
    expect(head).not.toContain('耗时：');
  });

  it('without a record: no time, no link in the head, the preview as before', () => {
    const e = entry({});
    const html = doc([e]);
    const head = summary(html, 'C1');
    expect(head).not.toContain('class="dur"');
    expect(head).not.toContain('<a ');
    expect(head).toContain(plainExcerpt(e.bodyHtml).slice(0, 10));
  });

  it('the unfolded entry ends with a link to this one entry on the web, next to "edit"; a review below its line comments', () => {
    const html = doc([
      entry({ editSource: 'x', wallSecs: 1 }),
      {
        kind: 'review',
        id: 'R1',
        url: 'https://github.com/o/r/pull/1#pullrequestreview-9',
        author: 'a',
        at: '2026-11-12T00:00:00Z',
        bodyHtml: '<p>r</p>',
        reviewState: 'COMMENTED',
        lineComments: [{ id: 'L1', url: 'https://github.com/o/r/pull/1#discussion_r1', author: 'a', at: '2026-11-12T00:00:00Z', path: 'a.ts', line: 1, bodyHtml: '<p>l</p>' }],
      },
    ]);
    expect(html).toContain('<div class="tools"><a class="web" href="https://github.com/o/r/issues/1#issuecomment-1">在网页上看这一条</a><button type="button" class="edit" data-edit');
    expect(html).toMatch(/data-entry="L1"[\s\S]*<\/div><\/div><div class="tools"><a class="web" href="https:\/\/github.com\/o\/r\/pull\/1#pullrequestreview-9">在网页上看这一条<\/a><\/div><\/details>/);
  });

  it('images not loaded: the note carries the link itself (the head no longer has one)', () => {
    const html = doc([entry({ bodyHtml: '<p><img src="https://example.com/a.png" alt="x"></p>' })]);
    expect(html).toContain('<div class="blocked" data-blocked="1">有 1 张图片不在 GitHub 的地址上，客户端不加载；<a class="web" href="https://github.com/o/r/issues/1#issuecomment-1">在网页上看这一条</a></div>');
    expect(html).not.toContain('点「在网页上看」');
  });
});
