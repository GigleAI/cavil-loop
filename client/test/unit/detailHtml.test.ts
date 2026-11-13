// The isolated view's document: GitHub's HTML goes in as is, everything the
// client writes around it is escaped, and the frame's own policy forbids scripts.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blockedImages, FRAME_CSP, FRAME_SANDBOX, IMAGE_HOSTS, markReleaseImages, plainExcerpt, timelineDocument, TIMELINE_CSP, TIMELINE_SANDBOX } from '../../src/renderer/detailHtml';
import { FRAME_SCRIPT, FRAME_SCRIPT_HASH } from '../../src/renderer/frameScript';
import { avatarUrl } from '../../src/shared/avatar';
import type { TimelineEntry } from '../../src/shared/actions';
import type { ItemDetail } from '../../src/shared/actions';

const detail = (author: string, path: string): ItemDetail => ({
  key: 'o/r#1',
  repo: 'o/r',
  number: 1,
  kind: 'pr',
  title: 't',
  url: 'https://github.com/o/r/pull/1',
  state: 'open',
  pr: null,
  fetchedAt: 0,
  labels: [],
  timeline: [
    {
      kind: 'review',
      id: 'R1',
      url: 'https://github.com/o/r/pull/1#r1',
      author,
      at: '2026-11-01T00:00:00Z',
      bodyHtml: '<p>rendered <b>by GitHub</b></p>',
      reviewState: 'APPROVED',
      lineComments: [{ id: 'L1', url: '', author, at: '2026-11-01T00:00:00Z', path, line: 3, bodyHtml: '<p>line</p>' }],
    },
  ],
});

describe('isolated detail view', () => {
  it('names and paths around GitHub\'s HTML are escaped; GitHub\'s HTML is kept', () => {
    const doc = timelineDocument(detail('<img src=x onerror=alert(1)>', 'a/<script>.ts'), false);
    expect(doc).not.toContain('<img src=x');
    expect(doc).not.toContain('a/<script>.ts');
    expect(doc).toContain('a/&lt;script&gt;.ts');
    expect(doc).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(doc).toContain('<p>rendered <b>by GitHub</b></p>');
  });

  it('no scripts but the frame\'s own (GitHub#193), no forms, no navigation of the app; links open outside', () => {
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-scripts');
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-same-origin');
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-top-navigation');
    expect(TIMELINE_SANDBOX.split(' ')).not.toContain('allow-same-origin');
    expect(TIMELINE_SANDBOX.split(' ')).not.toContain('allow-top-navigation');
    expect(FRAME_CSP).toContain("script-src 'none'");
    expect(TIMELINE_CSP).toContain(`script-src ${FRAME_SCRIPT_HASH};`);
    const doc = timelineDocument(detail('a', 'b'), true);
    expect(doc).toContain(`content="${TIMELINE_CSP}"`);
    expect(doc).toContain('<base target="_blank">');
    // the one script in the document is the frame's own, byte for byte
    expect([...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])).toEqual([FRAME_SCRIPT]);
  });

  it('images: github.com / api.github.com, the avatar host and GitHub\'s own image hosts (GitHub#205) load; the others are counted and the entry says so', () => {
    const img = (src: string) => `<img alt="x" src="${src}">`;
    expect(blockedImages(img('https://github.com/o/r/raw/main/a.png') + img('https://api.github.com/x') + img('data:image/png;base64,AA'))).toBe(0);
    expect(blockedImages(img('https://avatars.githubusercontent.com/u/1?v=4'))).toBe(0);
    // GitHub#205: a pasted screenshot (as GitHub's HTML has it today), an attachment from before 2023, an image via GitHub's proxy
    expect(
      blockedImages(
        img('https://private-user-images.githubusercontent.com/307601/698127950-cb2c.png?jwt=eyJ0eXAi.x.y') +
          img('https://user-images.githubusercontent.com/1/a.png') +
          img('https://camo.githubusercontent.com/abc/def') +
          img('https://raw.githubusercontent.com/GigleAI/cavil-loop/5e5abdf/docs/design/a.png'),
      ),
    ).toBe(0);
    expect(
      blockedImages(
        img('https://github.com.evil.example/a') +
          img('http://github.com/a') +
          img('http://private-user-images.githubusercontent.com/a.png') +
          img('https://private-user-images.githubusercontent.com.evil.example/a.png') +
          img('https://camo.githubusercontent.com.evil.example/a') +
          img('https://raw.githubusercontent.com.evil.example/o/r/main/a.png') +
          img('http://raw.githubusercontent.com/o/r/main/a.png') +
          img('https://github-production-user-asset-6210df.s3.amazonaws.com/1/a.png') +
          img('https://example.com/a.png') +
          img('https://avatars.githubusercontent.com.evil.example/a'),
      ),
    ).toBe(10);
    expect(FRAME_CSP).toMatch(
      /img-src https:\/\/github\.com https:\/\/api\.github\.com https:\/\/avatars\.githubusercontent\.com https:\/\/private-user-images\.githubusercontent\.com https:\/\/user-images\.githubusercontent\.com https:\/\/camo\.githubusercontent\.com https:\/\/raw\.githubusercontent\.com data:;/,
    );
    expect(FRAME_CSP).not.toMatch(/\*/);
    expect(FRAME_CSP).not.toMatch(/(img|media|default)-src[^;]*https:(?!\/\/)/);
    const d = detail('a', 'b');
    d.timeline[0].bodyHtml = img('https://example.com/a.png') + img('https://private-user-images.githubusercontent.com/a.png');
    const doc = timelineDocument(d, false);
    expect(doc).toContain('data-blocked="1"');
    expect(doc).toContain('有 1 张图片不在 GitHub 的地址上');
  });

  it('GitHub#439: an image GitHub serves through its proxy is not counted — its original address sits in data-canonical-src, which loads nothing', () => {
    // a real loop comment as GitHub renders it (recorded fixture): three screenshots on an outside host, shown via camo
    const fx = JSON.parse(readFileSync(new URL('../fixtures/codeblocks.github.json', import.meta.url), 'utf8')) as { comments: { url: string; bodyHTML: string }[] };
    const real = fx.comments.find((c) => c.bodyHTML.includes('data-canonical-src='));
    expect(real, 'the fixture holds a comment with proxied images').toBeTruthy();
    const tags = real!.bodyHTML.match(/<img\b[^>]*>/gi) ?? [];
    expect(tags.filter((t) => /src="https:\/\/camo\.githubusercontent\.com\//.test(t) && /data-canonical-src="https:\/\/(?!camo)/.test(t)).length).toBe(3);
    expect(blockedImages(real!.bodyHTML)).toBe(0);
    const d = detail('a', 'b');
    d.timeline[0].bodyHtml = real!.bodyHTML;
    d.timeline[0].lineComments = [{ id: 'L1', url: 'https://github.com/o/r/pull/1#discussion_r1', path: 'a.ts', line: 1, author: 'x', at: '2026-11-12T00:00:00Z', bodyHtml: real!.bodyHTML }];
    const doc = timelineDocument(d, false);
    expect(doc).not.toContain('data-blocked=');
    expect(doc).not.toContain('不在 GitHub 的地址上');
    // the same proxied image, attribute order / quotes / case varied
    const camo = 'https://camo.githubusercontent.com/abc/def';
    const out = 'https://futurelab.example:8443/review-assets/a.png';
    for (const tag of [
      `<img data-canonical-src="${out}" src="${camo}" alt="x">`,
      `<img src='${camo}' alt='x' data-canonical-src='${out}'>`,
      `<IMG SRC="${camo}" DATA-CANONICAL-SRC="${out}">`,
      `<img\nsrc="${camo}"\ndata-canonical-src="${out}"\nstyle="max-width: 100%;">`,
    ])
      expect(blockedImages(tag), tag).toBe(0);
    // what really does not load is still counted, and the entry still says so
    expect(blockedImages(`<img src="${out}" alt="x">`)).toBe(1);
    expect(blockedImages(`<img alt="x" data-canonical-src="${camo}" src="${out}">`)).toBe(1);
    expect(blockedImages(`<img src="${camo}" data-canonical-src="${out}"><img src="${out}">`)).toBe(1);
    const d2 = detail('a', 'b');
    d2.timeline[0].bodyHtml = real!.bodyHTML + `<img src="${out}" alt="x">`;
    expect(timelineDocument(d2, false)).toContain('有 1 张图片不在 GitHub 的地址上');
    // an <img> with only the original-address attribute loads nothing: not counted
    expect(blockedImages(`<img alt="x" data-canonical-src="${out}">`)).toBe(0);
    // an escaped address is judged as the browser reads it
    expect(blockedImages('<img src="https://example.com/a.png?x=1&amp;y=2">')).toBe(1);
    expect(blockedImages('<img src="https://camo.githubusercontent.com/a?x=1&amp;y=2">')).toBe(0);
  });

  it('GitHub#205: the window\'s own policy (tauri.conf.json, which the frame also falls under) allows exactly the same image hosts', () => {
    const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    expect(conf.app.security.csp['img-src'].split(' ')).toEqual(["'self'", 'data:', ...IMAGE_HOSTS]);
  });
});

// GitHub#155: only the newest entry is unfolded; avatars in front of every name
const entry = (id: string, kind: TimelineEntry['kind'], at: string, bodyHtml: string, author: string | null = 'luosky'): TimelineEntry => ({
  kind,
  id,
  url: `https://github.com/o/r/issues/1#${id}`,
  author,
  at,
  bodyHtml,
});
const withTimeline = (timeline: TimelineEntry[]) => ({ ...detail('a', 'b'), kind: 'issue' as const, timeline });
/** entry id -> unfolded? (parsed from the document the frame shows) */
function unfolded(doc: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of doc.matchAll(/<details class="entry[^"]*" data-entry="([^"]+)" data-kind="[^"]+"( open)?>/g)) out[m[1]] = Boolean(m[2]);
  return out;
}

describe('detail: folded entries (GitHub#155)', () => {
  const timeline = [
    entry('C3', 'comment', '2026-11-03T00:00:00Z', '<p>newest</p>'),
    entry('C2', 'comment', '2026-11-02T00:00:00Z', '<p>middle</p>'),
    entry('B', 'body', '2026-11-01T00:00:00Z', '<p>the opening post</p>'),
  ];

  it('by default only the newest entry is unfolded; the opening post (oldest) is folded', () => {
    expect(unfolded(timelineDocument(withTimeline(timeline), false))).toEqual({ C3: true, C2: false, B: false });
  });

  it('no comments: the opening post is the newest entry, so it is unfolded', () => {
    expect(unfolded(timelineDocument(withTimeline([timeline[2]]), false))).toEqual({ B: true });
  });

  it('"unfold all" / "fold all"', () => {
    expect(unfolded(timelineDocument(withTimeline(timeline), false, 'all'))).toEqual({ C3: true, C2: true, B: true });
    expect(unfolded(timelineDocument(withTimeline(timeline), false, 'none'))).toEqual({ C3: false, C2: false, B: false });
  });

  it('a folded entry still carries its whole content (the browser only hides it) and a one-line preview of its text', () => {
    const doc = timelineDocument(withTimeline(timeline), false);
    expect(doc).toContain('<p>the opening post</p>');
    expect(doc).toContain('<span class="excerpt" data-find-skip> · <span data-verbatim="github">the opening post</span></span>');
  });

  it('the preview is plain text, escaped again, and cut at 80 characters', () => {
    expect(plainExcerpt('<p>a &amp; b &lt;c&gt; &#x4e2d;&#25991;</p>\n<pre>x\n y</pre>')).toBe('a & b <c> 中文 x y');
    expect(plainExcerpt('<p>' + '字'.repeat(100) + '</p>')).toBe('字'.repeat(80) + '…');
    expect(plainExcerpt('&#99999999;')).toBe('');
    const doc = timelineDocument(withTimeline([entry('C', 'comment', '2026-11-03T00:00:00Z', '<p>&lt;img src=x onerror=alert(1)&gt;</p>')]), false);
    expect(doc).toContain('<span class="excerpt" data-find-skip> · <span data-verbatim="github">&lt;img src=x onerror=alert(1)&gt;</span></span>');
    expect(doc).not.toContain('<img src=x');
  });

  it('every author has an avatar from the avatar host, with the first letter underneath; a deleted account only the letter', () => {
    const doc = timelineDocument(withTimeline([entry('C', 'comment', '2026-11-03T00:00:00Z', '<p>x</p>', 'github-actions[bot]'), entry('B', 'body', '2026-11-01T00:00:00Z', '<p>y</p>', null)]), false);
    expect(doc).toContain(`<img src="${avatarUrl('github-actions[bot]', 20)}" alt=""`);
    expect(avatarUrl('github-actions[bot]', 20)).toBe('https://avatars.githubusercontent.com/github-actions%5Bbot%5D?s=40');
    expect(doc).toContain('data-avatar="github-actions[bot]"><span>G</span>');
    expect(doc).toContain('data-avatar=""><span>?</span></span>');
  });
});

// GitHub#358: the box whose click is on its way is grey with the state asked for; nothing else changes
describe('detail: a box click waiting for GitHub (GitHub#358)', () => {
  const list = (a: boolean, b: boolean) =>
    `<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox"${a ? ' checked=""' : ''}> A</li>` +
    `<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox"${b ? ' checked=""' : ''}> B</li></ul>`;
  const tasks = { clickable: true as const, source: '- [ ] A\n- [x] B\n' };
  const timeline: TimelineEntry[] = [
    { ...entry('C2', 'comment', '2026-11-03T00:00:00Z', list(false, true)), tasks },
    { ...entry('C1', 'comment', '2026-11-02T00:00:00Z', list(false, true)), tasks },
    { ...entry('R', 'review', '2026-11-01T12:00:00Z', list(false, true)) },
  ];
  /** entry id -> its boxes as [checked, waiting, disabled] */
  function boxes(doc: string): Record<string, [boolean, boolean, boolean][]> {
    const out: Record<string, [boolean, boolean, boolean][]> = {};
    for (const part of doc.split('<details class="entry').slice(1)) {
      const id = /data-entry="([^"]+)"/.exec(part)![1];
      out[id] = (part.match(/<input\b[^>]*task-list-item-checkbox[^>]*>/g) ?? []).map((t) => [/\schecked(=|\s|>)/.test(t), /\sdata-pending(=|\s|>)/.test(t), /\sdisabled(=|\s|>)/.test(t)]);
    }
    return out;
  }
  const d = withTimeline(timeline);

  it('no click on its way: boxes of clickable entries take clicks, nothing is marked waiting', () => {
    expect(boxes(timelineDocument(d, false, 'all', { canTick: true }))).toEqual({
      C2: [[false, false, false], [true, false, false]],
      C1: [[false, false, false], [true, false, false]],
      R: [[false, false, true], [true, false, true]],
    });
  });

  it('ticking box 0 of C1: it alone is ticked + waiting; every box of every entry is disabled; the other values stay', () => {
    expect(boxes(timelineDocument(d, false, 'all', { canTick: false, pending: { entryId: 'C1', index: 0, checked: true } }))).toEqual({
      C2: [[false, false, true], [true, false, true]],
      C1: [[true, true, true], [true, false, true]],
      R: [[false, false, true], [true, false, true]],
    });
  });

  it('unticking box 1 of C2: it alone is unticked + waiting', () => {
    expect(boxes(timelineDocument(d, false, 'all', { canTick: false, pending: { entryId: 'C2', index: 1, checked: false } }))).toEqual({
      C2: [[false, false, true], [false, true, true]],
      C1: [[false, false, true], [true, false, true]],
      R: [[false, false, true], [true, false, true]],
    });
  });

  it('a click on an entry that is not there, or on a review: nothing is marked', () => {
    const plain = boxes(timelineDocument(d, false, 'all', { canTick: false }));
    expect(boxes(timelineDocument(d, false, 'all', { canTick: false, pending: { entryId: 'GONE', index: 0, checked: true } }))).toEqual(plain);
    expect(boxes(timelineDocument(d, false, 'all', { canTick: false, pending: { entryId: 'R', index: 0, checked: true } }))).toEqual(plain);
  });
});

// GitHub#395: release attachment images are fetched with the sign-in, never by the frame
describe('release attachment images in the frame document', () => {
  const WEB = 'https://github.com';
  const REL = 'https://github.com/acme/app/releases/download/v1/home.png';
  const body = (html: string, lineHtml = '<p>line</p>'): ItemDetail => {
    const d = detail('a', 'f.ts');
    d.timeline[0].bodyHtml = html;
    d.timeline[0].lineComments![0].bodyHtml = lineHtml;
    return d;
  };

  it('the image keeps everything but its src: the address moves to data-rel, so nothing is fetched while the document loads', () => {
    const html = `<p><a target="_blank" href="${REL}"><img src="${REL}" alt="首页" style="max-width: 100%;"></a></p>`;
    expect(markReleaseImages(html, WEB)).toBe(`<p><a target="_blank" href="${REL}"><img data-rel="${REL}" alt="首页" style="max-width: 100%;"></a></p>`);
    // an address with an escaped character comes out escaped again, once
    const amp = 'https://github.com/acme/app/releases/download/v1/a&amp;b.png';
    expect(markReleaseImages(`<img alt="x" src="${amp}">`, WEB)).toBe(`<img alt="x" data-rel="${amp}">`);
    // a tag with slashes, as GitHub writes it and escaped
    const slashed = 'https://github.com/GigleAI/cavil-loop/releases/download/client/v0.5.2-dev.486/shot.png';
    expect(markReleaseImages(`<img src="${slashed}" alt="s">`, WEB)).toBe(`<img data-rel="${slashed}" alt="s">`);
    const escaped = slashed.replace('client/v', 'client%2Fv');
    expect(markReleaseImages(`<img src="${escaped}" alt="s">`, WEB)).toBe(`<img data-rel="${escaped}" alt="s">`);
    // single quotes, upper case tag
    expect(markReleaseImages(`<IMG SRC='${REL}'>`, WEB)).toBe(`<IMG data-rel="${REL}">`);
  });

  it('every other image is left exactly as it is — and so is everything when the GitHub in use is not known', () => {
    const others = [
      '<img src="https://private-user-images.githubusercontent.com/1/2.png?jwt=x" alt="pasted">',
      '<img src="https://camo.githubusercontent.com/abc/68747470" alt="proxied">',
      '<img src="https://github.com/acme/app/raw/main/docs/releases/download/a.png" alt="a repo file">',
      '<img src="https://github.com.evil.example/acme/app/releases/download/v1/home.png" alt="look-alike">',
      '<img src="https://example.com/acme/app/releases/download/v1/home.png" alt="elsewhere">',
      `<a href="${REL}">a link, not an image</a>`,
      `<p>text that mentions ${REL} and src="${REL}"</p>`,
    ].join('');
    expect(markReleaseImages(others, WEB)).toBe(others);
    const rel = `<img src="${REL}" alt="r">`;
    expect(markReleaseImages(rel, undefined)).toBe(rel);
    expect(markReleaseImages(rel, 'https://ghe.example.com')).toBe(rel);
  });

  it('in the document: the body and the line comments of an entry are both marked', () => {
    const img = `<img src="${REL}" alt="r">`;
    const doc = timelineDocument(body(`<p>${img}</p>`, `<p>${img}</p>`), false, 'all', { web: WEB });
    expect(doc.match(/<img data-rel="https:\/\/github\.com\/acme\/app\/releases\/download\/v1\/home\.png" alt="r">/g)).toHaveLength(2);
    expect(doc).not.toContain(`<img src="${REL}"`);
  });

  it('a discussion without such an image is the same document with or without the option; "offline" only marks the body', () => {
    const d = body('<p><img src="https://camo.githubusercontent.com/abc/68747470" alt="p"> text</p>');
    const plain = timelineDocument(d, false, 'all', { render: 'r1' });
    expect(timelineDocument(d, false, 'all', { render: 'r1', web: WEB })).toBe(plain);
    expect(timelineDocument(d, false, 'all', { render: 'r1', web: WEB, offline: true })).toBe(plain.replace('<body data-render="r1" data-scroll="0">', '<body data-render="r1" data-scroll="0" data-offline="">'));
    expect(plain).toContain('<body data-render="r1" data-scroll="0">');
  });
});
