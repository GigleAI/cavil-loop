// Code blocks in the discussion (GitHub#381): the "wrap" / "copy" buttons and
// the syntax colours, checked on GitHub's own renderings
// (test/fixtures/codeblocks.github.json, recorded by record-codeblocks.mjs).
// What a click does is tested in the real window (test/e2e/app.spec.ts).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, parseFragment } from 'parse5';
import { annotateCodeBlocks, codeBlockCount, codeCss } from '../../src/renderer/codeBlocks';
import { FRAME_CSP, previewDocument, timelineDocument } from '../../src/renderer/detailHtml';
import { annotateTaskBoxes } from '../../src/data/taskList';
import { DEFAULT_VIEW, isValidView, normalizeView } from '../../src/shared/viewSettings';
import type { ItemDetail, TimelineEntry } from '../../src/shared/actions';

const here = dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'codeblocks.github.json'), 'utf8')) as {
  samples: Record<string, { markdown: string; html: string }>;
  comments: { url: string; body: string; bodyHTML: string }[];
};
/** every recorded rendering: the short samples and the real comment */
const ALL: [string, string][] = [...Object.entries(recorded.samples).map(([k, v]) => [k, v.html] as [string, string]), ...recorded.comments.map((c) => [c.url, c.bodyHTML] as [string, string])];

interface El {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: El[];
  parentNode?: El;
  value?: string;
}
const walk = (n: El, f: (e: El) => void) => {
  f(n);
  for (const c of n.childNodes ?? []) walk(c, f);
};
const all = (root: El, ok: (e: El) => boolean) => {
  const out: El[] = [];
  walk(root, (e) => ok(e) && out.push(e));
  return out;
};
const attr = (e: El, name: string) => e.attrs?.find((a) => a.name === name)?.value;
const hasClass = (e: El, c: string) => (attr(e, 'class') ?? '').split(/\s+/).includes(c);
const tag = (name: string) => (e: El) => e.tagName === name;
const text = (e: El): string => (e.nodeName === '#text' ? (e.value ?? '') : (e.childNodes ?? []).map(text).join(''));
const within = (e: El, ok: (x: El) => boolean) => {
  for (let p = e.parentNode; p; p = p.parentNode) if (ok(p)) return true;
  return false;
};
const frag = (html: string) => parseFragment(html) as unknown as El;

const entry = (id: string, bodyHtml: string, extra: Partial<TimelineEntry> = {}): TimelineEntry => ({ kind: 'comment', id, url: `https://github.com/o/r/issues/1#${id}`, author: 'a', at: '2026-11-01T00:00:00Z', bodyHtml, ...extra });
const detail = (timeline: TimelineEntry[]): ItemDetail => ({ key: 'o/r#1', repo: 'o/r', number: 1, kind: 'issue', title: 't', url: 'https://github.com/o/r/issues/1', state: 'open', pr: null, fetchedAt: 0, labels: [], timeline });

/** the checks one annotated piece of GitHub's HTML must pass, against the HTML it was made from */
function expectButtons(original: string, annotated: El) {
  const pres = all(frag(original), tag('pre'));
  const blocks = all(annotated, (e) => hasClass(e, 'cb'));
  expect(blocks.length).toBe(pres.length);
  for (const [i, b] of blocks.entries()) {
    const kids = (b.childNodes ?? []).filter((c) => c.tagName);
    // the bar, then GitHub's own <pre>, nothing else
    expect(kids.map((k) => k.tagName)).toEqual(['div', 'pre']);
    expect(hasClass(kids[0], 'cbar')).toBe(true);
    const buttons = all(kids[0], tag('button'));
    expect(buttons.map((x) => [attr(x, 'data-code-wrap') !== undefined, attr(x, 'data-code-copy') !== undefined, attr(x, 'type')])).toEqual([
      [true, false, 'button'],
      [false, true, 'button'],
    ]);
    // the code is GitHub's, character for character
    expect(text(kids[1])).toBe(text(pres[i]));
  }
  // no button anywhere else: inline code has none
  const buttons = all(annotated, (e) => attr(e, 'data-code-wrap') !== undefined || attr(e, 'data-code-copy') !== undefined);
  expect(buttons.length).toBe(pres.length * 2);
  expect(buttons.every((x) => within(x, (p) => hasClass(p, 'cb')))).toBe(true);
  const inline = all(annotated, (e) => e.tagName === 'code' && !within(e, tag('pre')));
  expect(inline.length).toBe(all(frag(original), (e) => e.tagName === 'code' && !within(e, tag('pre'))).length);
  expect(inline.some((c) => within(c, (p) => hasClass(p, 'cb')))).toBe(false);
}

describe('GitHub#381: every code block gets "wrap" and "copy", inline code gets nothing', () => {
  it('the recording holds what the cases below need: blocks with and without a language, inline code, task boxes', () => {
    const real = recorded.comments[0].bodyHTML;
    expect(real).toContain('highlight-source-shell');
    expect(real).toMatch(/<pre class="notranslate"><code/);
    expect(real).toContain('task-list-item-checkbox');
    expect(codeBlockCount(real)).toBe(2);
    expect(codeBlockCount(recorded.samples['inline code only'].html)).toBe(0);
    expect(codeBlockCount(recorded.samples['two blocks and inline code'].html)).toBe(2);
  });

  for (const [name, html] of ALL)
    it(`${name}: one pair of buttons per block, the rest of GitHub's HTML untouched`, () => {
      const out = annotateCodeBlocks(html);
      expectButtons(html, frag(out));
      // taking the wrappers out again gives GitHub's HTML back, byte for byte
      const bar = out.match(/<div class="cbar">.*?<\/div>/)?.[0] ?? '';
      const back = out.split(`<div class="cb">${bar}`).join('').replace(/<\/pre><\/div>/g, '</pre>');
      expect(codeBlockCount(html) ? back : out).toBe(html);
    });

  it('<pre> tags that do not pair up: the HTML is left as it is', () => {
    for (const broken of ['<p>a</p><pre>one', 'one</pre><p>b</p>', '<pre>a</pre><pre>b']) {
      expect(annotateCodeBlocks(broken)).toBe(broken);
      expect(codeBlockCount(broken)).toBe(0);
    }
  });

  it('both ways GitHub\'s HTML enters the discussion get them: an entry\'s own text and a line comment under a review', () => {
    const real = recorded.comments[0].bodyHTML;
    const sample = recorded.samples['two blocks and inline code'].html;
    const d = detail([
      entry('C1', real),
      entry('R1', sample, { kind: 'review', reviewState: 'COMMENTED', lineComments: [{ id: 'L1', url: '', author: 'a', at: '2026-11-01T00:00:00Z', path: 'a.ts', line: 3, bodyHtml: recorded.samples['sql'].html }] }),
    ]);
    const doc = parse(timelineDocument(d, false, 'all')) as unknown as El;
    const byEntry = (id: string) => all(doc, (e) => attr(e, 'data-entry') === id)[0];
    const md = (root: El) => all(root, (e) => hasClass(e, 'md'));
    expectButtons(real, md(byEntry('C1'))[0]);
    expectButtons(sample, md(byEntry('R1'))[0]);
    // the line comment sits inside the review's entry, in its own .md
    expectButtons(recorded.samples['sql'].html, md(byEntry('L1'))[0]);
    expect(all(doc, (e) => hasClass(e, 'cb')).length).toBe(2 + 2 + 1);
  });

  it('task boxes are numbered and clickable exactly as without the buttons', () => {
    const boxes = (html: string) => (html.match(/<input\b[^>]*>/g) ?? []).join('\n');
    for (const html of [recorded.comments[0].bodyHTML, recorded.samples['a block inside a list item'].html]) {
      for (const canTick of [true, false]) {
        const e = entry('C1', html, { tasks: { clickable: true, source: '', why: '' } as TimelineEntry['tasks'] });
        const doc = timelineDocument(detail([e]), false, 'all', { canTick });
        const want = boxes(annotateTaskBoxes(html, canTick));
        expect(want).toContain('data-task="0"');
        expect(boxes(doc)).toBe(want);
      }
    }
  });
});

describe('GitHub#381: the "wrap long lines" switch', () => {
  const d = detail([entry('C1', recorded.samples['shell with a language, a long line'].html)]);
  const body = (doc: string) => all(parse(doc) as unknown as El, tag('body'))[0];
  it('off unless asked for: the document says which, on the body and on every switch', () => {
    for (const [opts, on] of [[{}, false], [{ wrap: false }, false], [{ wrap: true }, true]] as const) {
      const b = body(timelineDocument(d, false, 'all', opts));
      expect(attr(b, 'data-wrap') !== undefined).toBe(on);
      const sw = all(b, (e) => attr(e, 'data-code-wrap') !== undefined);
      expect(sw.length).toBe(1);
      expect(sw.map((x) => attr(x, 'aria-pressed'))).toEqual([on ? 'true' : 'false']);
    }
  });
  it('remembered with the view settings: off by default, an older saved view reads as off, only a boolean is taken', () => {
    expect(DEFAULT_VIEW.codeWrap).toBe(false);
    const { codeWrap: _gone, ...old } = DEFAULT_VIEW;
    expect(normalizeView(old).codeWrap).toBe(false);
    expect(normalizeView({ ...old, codeWrap: true }).codeWrap).toBe(true);
    for (const v of ['true', 1, null]) expect(normalizeView({ ...old, codeWrap: v }).codeWrap).toBe(false);
    expect(isValidView({ ...DEFAULT_VIEW, codeWrap: true })).toBe(true);
    expect(isValidView({ ...DEFAULT_VIEW, codeWrap: 'yes' })).toBe(false);
  });
});

describe('GitHub#381: syntax colours — GitHub\'s marks, one set of colours for the discussion and the reply preview', () => {
  /** the colour rules of a document: every rule on a pl-* class */
  const rules = (doc: string) =>
    [...doc.matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .flatMap((m) => m[1].split('\n'))
      .filter((l) => l.startsWith('.pl-'))
      .sort();
  const html = recorded.samples['typescript: indentation, <, > and &'].html;

  for (const dark of [false, true])
    it(`${dark ? 'dark' : 'light'}: the same input is coloured by the same rules in both`, () => {
      const inFrame = rules(timelineDocument(detail([entry('C1', html)]), dark, 'all'));
      const inPreview = rules(previewDocument(html, dark));
      expect(inFrame.length).toBeGreaterThan(10);
      expect(inPreview).toEqual(inFrame);
    });

  it('light and dark differ; every mark GitHub used in the recording has a colour', () => {
    expect(codeCss(false)).not.toBe(codeCss(true));
    // marks GitHub itself leaves in the text colour: punctuation, and a plain identifier outside a string
    const plain = new Set(['pl-kos', 'pl-s1']);
    const used = new Set(ALL.flatMap(([, h]) => [...h.matchAll(/class="(pl-[a-z0-9]+)"/g)].map((m) => m[1])));
    expect(used.size).toBeGreaterThan(8);
    for (const dark of [false, true]) {
      const css = codeCss(dark);
      const coloured = new Set([...css.matchAll(/\.(pl-[a-z0-9]+)/g)].map((m) => m[1]));
      expect([...used].filter((c) => !plain.has(c) && !coloured.has(c))).toEqual([]);
    }
  });

  it('the reply preview stays a document that runs nothing and has no buttons', () => {
    const doc = previewDocument(recorded.comments[0].bodyHTML, false);
    expect(doc).toContain(`content="${FRAME_CSP.replace(/&/g, '&amp;').replace(/'/g, '&#39;')}"`);
    expect(FRAME_CSP).toContain("script-src 'none'");
    const tree = parse(doc) as unknown as El;
    expect(all(tree, tag('script'))).toEqual([]);
    expect(all(tree, tag('button'))).toEqual([]);
    expect(all(tree, (e) => hasClass(e, 'cb'))).toEqual([]);
    // GitHub's HTML is in it as it came
    expect(doc).toContain(recorded.comments[0].bodyHTML);
  });
});
