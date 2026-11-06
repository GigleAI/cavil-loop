// The isolated view's document: GitHub's HTML goes in as is, everything the
// client writes around it is escaped, and the frame's own policy forbids scripts.

import { describe, expect, it } from 'vitest';
import { blockedImages, FRAME_CSP, FRAME_SANDBOX, plainExcerpt, timelineDocument } from '../../src/renderer/detailHtml';
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
    expect(doc).not.toContain('<script>');
    expect(doc).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(doc).toContain('<p>rendered <b>by GitHub</b></p>');
  });

  it('no scripts, no forms, no navigation of the app; links open outside', () => {
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-scripts');
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-same-origin');
    expect(FRAME_SANDBOX.split(' ')).not.toContain('allow-top-navigation');
    expect(FRAME_CSP).toContain("script-src 'none'");
    const doc = timelineDocument(detail('a', 'b'), true);
    expect(doc).toContain(`content="${FRAME_CSP}"`);
    expect(doc).toContain('<base target="_blank">');
  });

  it('images: only github.com / api.github.com (and the avatar host) load; the others are counted and the entry says so', () => {
    const img = (src: string) => `<img alt="x" src="${src}">`;
    expect(blockedImages(img('https://github.com/o/r/raw/main/a.png') + img('https://api.github.com/x') + img('data:image/png;base64,AA'))).toBe(0);
    expect(blockedImages(img('https://avatars.githubusercontent.com/u/1?v=4'))).toBe(0);
    expect(
      blockedImages(
        img('https://camo.githubusercontent.com/a') +
          img('https://github.com.evil.example/a') +
          img('http://github.com/a') +
          img('https://private-user-images.githubusercontent.com/a.png') +
          img('https://avatars.githubusercontent.com.evil.example/a'),
      ),
    ).toBe(5);
    expect(FRAME_CSP).toMatch(/img-src https:\/\/github\.com https:\/\/api\.github\.com https:\/\/avatars\.githubusercontent\.com data:;/);
    expect(FRAME_CSP).not.toMatch(/\*/);
    expect(FRAME_CSP).not.toMatch(/(img|media|default)-src[^;]*https:(?!\/\/)/);
    const d = detail('a', 'b');
    d.timeline[0].bodyHtml = img('https://camo.githubusercontent.com/a');
    expect(timelineDocument(d, false)).toContain('data-blocked="1"');
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
    expect(doc).toContain('<span class="excerpt"> · the opening post</span>');
  });

  it('the preview is plain text, escaped again, and cut at 80 characters', () => {
    expect(plainExcerpt('<p>a &amp; b &lt;c&gt; &#x4e2d;&#25991;</p>\n<pre>x\n y</pre>')).toBe('a & b <c> 中文 x y');
    expect(plainExcerpt('<p>' + '字'.repeat(100) + '</p>')).toBe('字'.repeat(80) + '…');
    expect(plainExcerpt('&#99999999;')).toBe('');
    const doc = timelineDocument(withTimeline([entry('C', 'comment', '2026-11-03T00:00:00Z', '<p>&lt;img src=x onerror=alert(1)&gt;</p>')]), false);
    expect(doc).toContain('<span class="excerpt"> · &lt;img src=x onerror=alert(1)&gt;</span>');
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
