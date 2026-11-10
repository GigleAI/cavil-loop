// GitHub#193: task-list boxes. The client's reading of a markdown source is
// compared box for box with GitHub's own rendering of the same source
// (test/fixtures/tasklists.github.json, recorded by record-tasklists.mjs) —
// GitHub is the reference, never another reimplementation. Plus the one-character
// flip, the box numbering in the frame, and the frame script's hash agreeing
// with both policies.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotateTaskBoxes, findTaskBoxes, flipTask, planTasks, renderedTaskBoxes } from '../../src/data/taskList';
import { taskEntry } from '../../src/data/detail';
import { FRAME_SCRIPT, FRAME_SCRIPT_HASH } from '../../src/renderer/frameScript';
import { FRAME_CSP, TIMELINE_CSP, TIMELINE_SANDBOX, FRAME_SANDBOX } from '../../src/renderer/detailHtml';

const here = dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'tasklists.github.json'), 'utf8')) as {
  samples: Record<string, { markdown: string; html: string }>;
  comments: { url: string; body: string; bodyHTML: string }[];
};
const states = (b: { checked: boolean }[] | null) => (b ? b.map((x) => x.checked) : null);

describe('reading the boxes like GitHub does', () => {
  it('every recorded sample: the source gives exactly the boxes GitHub rendered, in order, ticked or not', () => {
    const names = Object.keys(recorded.samples);
    expect(names.length).toBe(18);
    for (const name of names) {
      const s = recorded.samples[name];
      expect(states(findTaskBoxes(s.markdown)), name).toEqual(renderedTaskBoxes(s.html));
    }
  });

  it('the placements that are not boxes really render none on GitHub (the fixture tells candidates apart)', () => {
    const count = (n: string) => renderedTaskBoxes(recorded.samples[n].html).length;
    expect(count('fenced code block is not a box')).toBe(2);
    expect(count('tilde fence and indented code are not boxes')).toBe(1);
    expect(count('inside <details> without a blank line is raw HTML')).toBe(1);
    expect(count('HTML comment is not a box')).toBe(1);
    expect(count('table cell is not a box')).toBe(1);
    expect(count('no space after ] or empty item')).toBe(1);
    expect(count('five spaces after marker')).toBe(1);
    // a naive "every `- [ ]` line" count would see more boxes than GitHub in each of these
    for (const n of ['fenced code block is not a box', 'tilde fence and indented code are not boxes', 'inside <details> without a blank line is raw HTML', 'HTML comment is not a box', 'table cell is not a box'])
      expect((recorded.samples[n].markdown.match(/^\s*(?:> )?(?:\| )?(?:<!-- )?[-*+] \[[ xX]\]/gm) ?? []).length, n).toBeGreaterThan(count(n));
  });

  it('real comments with choice questions (body + bodyHTML as GraphQL gives them): clickable, boxes agree', () => {
    expect(recorded.comments.length).toBe(2);
    for (const c of recorded.comments) {
      const plan = planTasks(c.body, c.bodyHTML);
      expect(plan.ok, c.url).toBe(true);
      expect(plan.ok && plan.boxes.map((b) => b.checked)).toEqual(renderedTaskBoxes(c.bodyHTML));
      expect(renderedTaskBoxes(c.bodyHTML).length).toBeGreaterThan(1);
    }
  });

  it('source and rendering disagree (count or state): read-only, with the reason', () => {
    const s = recorded.samples['plain list, lower and upper x'];
    expect(planTasks(s.markdown, s.html).ok).toBe(true);
    expect(planTasks(s.markdown.replace('- [x] B', '- [ ] B'), s.html)).toEqual({ ok: false, why: '这条评论的勾选框客户端对不上，请在网页上勾' });
    expect(planTasks(`${s.markdown}- [ ] one more\n`, s.html).ok).toBe(false);
    expect(planTasks(s.markdown, '<p>no boxes</p>')).toEqual({ ok: false, why: '没有勾选框' });
  });

  it('whether an entry may be clicked: only with source and permission both read, and agreeing', () => {
    const s = recorded.samples['choice question as the templates write it'];
    expect(taskEntry('<p>no boxes</p>', 'x', true)).toBeUndefined();
    expect(taskEntry(s.html, s.markdown, true)).toEqual({ clickable: true, source: s.markdown });
    expect(taskEntry(s.html, s.markdown, false)).toEqual({ clickable: false, why: 'GitHub 说你没有权限改这一条，勾选框只读' });
    // not read is never "probably fine"
    expect(taskEntry(s.html, undefined, true)).toMatchObject({ clickable: false });
    expect(taskEntry(s.html, s.markdown, undefined)).toMatchObject({ clickable: false });
    expect(taskEntry(s.html, s.markdown.replace('- [ ] **B', '- [x] **B'), true)).toMatchObject({ clickable: false });
  });
});

describe('ticking one box changes exactly one character', () => {
  /** offsets (UTF-16 units, the same as TaskBox.at) where two strings of equal length differ */
  const diff = (a: string, b: string) => Array.from({ length: a.length }, (_, i) => i).filter((i) => a[i] !== b[i]);

  it('each box of every recorded sample and real comment, both ways', () => {
    const sources = [...Object.values(recorded.samples).map((s) => s.markdown), ...recorded.comments.map((c) => c.body)];
    let flipped = 0;
    for (const src of sources) {
      const boxes = findTaskBoxes(src)!;
      boxes.forEach((b, i) => {
        const out = flipTask(src, i, !b.checked)!;
        expect(out.length).toBe(src.length);
        expect(diff(src, out)).toEqual([b.at]);
        expect(states(findTaskBoxes(out))).toEqual(boxes.map((x, j) => (j === i ? !b.checked : x.checked)));
        flipped++;
      });
    }
    expect(flipped).toBeGreaterThan(20);
  });

  it('the box text that looks like a box ("`[x]` in code", a link) is never what changes', () => {
    const src = recorded.samples['box text with brackets and code'].markdown;
    const out = flipTask(src, 0, true)!;
    expect(out).toBe(src.replace('- [ ] uses', '- [x] uses'));
    expect(flipTask(src, 1, true)).toBe(src.replace('- [ ] link', '- [x] link'));
  });

  it('a box already in that state, or a box that is not there: nothing (no guess)', () => {
    const src = '- [ ] a\n- [x] b\n';
    expect(flipTask(src, 0, false)).toBeNull();
    expect(flipTask(src, 1, true)).toBeNull();
    expect(flipTask(src, 2, true)).toBeNull();
    expect(flipTask(src, -1, true)).toBeNull();
    expect(flipTask(src, 0.5, true)).toBeNull();
    expect(flipTask('```\n- [ ] code\n```\n', 0, true)).toBeNull();
  });
});

describe('the boxes in the frame', () => {
  const html = recorded.samples['plain list, lower and upper x'].html;

  it('numbered in the order they are counted; clickable drops disabled, read-only keeps it', () => {
    const on = annotateTaskBoxes(html, true);
    expect([...on.matchAll(/data-task="(\d+)"/g)].map((m) => m[1])).toEqual(['0', '1', '2']);
    expect(on).not.toMatch(/<input[^>]*disabled/);
    expect(renderedTaskBoxes(on)).toEqual(renderedTaskBoxes(html));
    const off = annotateTaskBoxes(html, false);
    expect((off.match(/<input[^>]*disabled=""/g) ?? []).length).toBe(3);
    expect([...off.matchAll(/data-task="(\d+)"/g)].length).toBe(3);
  });

  it('GitHub#358: a click on its way — that one box shows what was asked for and is marked waiting; the others keep GitHub\'s state; nothing can be clicked', () => {
    const was = renderedTaskBoxes(html);
    for (let k = 0; k < was.length; k++) {
      for (const want of [true, false]) {
        const out = annotateTaskBoxes(html, false, { index: k, checked: want });
        const tags = out.match(/<input\b[^>]*>/g)!;
        expect(tags).toHaveLength(was.length);
        // the waiting mark is on box k alone, and it sits on the box numbered k
        expect(tags.map((t) => /\sdata-pending(=|\s|>)/.test(t))).toEqual(was.map((_, i) => i === k));
        expect(tags[k]).toContain(`data-task="${k}"`);
        expect(renderedTaskBoxes(out)).toEqual(was.map((c, i) => (i === k ? want : c)));
        expect(tags.every((t) => /\sdisabled(=|\s|>)/.test(t))).toBe(true);
      }
    }
    // no click on its way: no mark anywhere, with or without the argument
    expect(annotateTaskBoxes(html, true, null)).toBe(annotateTaskBoxes(html, true));
    expect(annotateTaskBoxes(html, false)).not.toContain('data-pending');
    // a box that is not there marks nothing
    expect(annotateTaskBoxes(html, false, { index: was.length, checked: true })).toBe(annotateTaskBoxes(html, false));
  });
});

describe('the frame script and the two policies (GitHub#193)', () => {
  it('its hash is the one both policies allow: the frame\'s own and the window\'s (tauri.conf.json)', () => {
    const hash = `'sha256-${createHash('sha256').update(FRAME_SCRIPT).digest('base64')}'`;
    expect(FRAME_SCRIPT_HASH).toBe(hash);
    const conf = JSON.parse(readFileSync(join(here, '..', '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
    expect(conf.app.security.csp['script-src'].split(/\s+/)).toEqual(["'self'", hash]);
    expect(TIMELINE_CSP).toContain(`script-src ${hash};`);
    // nothing else may run in either: no unsafe-inline, no other hash or nonce
    expect(TIMELINE_CSP).not.toMatch(/unsafe-inline'[^;]*script|script-src[^;]*unsafe/);
    expect(TIMELINE_CSP.match(/script-src ([^;]*)/)![1]).toBe(hash);
  });

  it('the timeline frame may run scripts but is never same-origin; the reply preview runs none', () => {
    expect(TIMELINE_SANDBOX.split(' ')).toContain('allow-scripts');
    expect(TIMELINE_SANDBOX.split(' ')).not.toContain('allow-same-origin');
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-scripts');
    expect(FRAME_CSP).toContain("script-src 'none'");
    expect(TIMELINE_CSP).toContain("connect-src 'none'");
  });
});
