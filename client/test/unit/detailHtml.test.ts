// The isolated view's document: GitHub's HTML goes in as is, everything the
// client writes around it is escaped, and the frame's own policy forbids scripts.

import { describe, expect, it } from 'vitest';
import { blockedImages, FRAME_CSP, FRAME_SANDBOX, timelineDocument } from '../../src/renderer/detailHtml';
import { isAllowedRequest } from '../../src/platform';
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

  it('images: only github.com / api.github.com load; the others are counted and the entry says so', () => {
    const img = (src: string) => `<img alt="x" src="${src}">`;
    expect(blockedImages(img('https://github.com/o/r/raw/main/a.png') + img('https://api.github.com/x') + img('data:image/png;base64,AA'))).toBe(0);
    expect(blockedImages(img('https://camo.githubusercontent.com/a') + img('https://github.com.evil.example/a') + img('http://github.com/a'))).toBe(3);
    expect(FRAME_CSP).toMatch(/img-src https:\/\/github\.com https:\/\/api\.github\.com data:;/);
    expect(FRAME_CSP).not.toMatch(/(img|media|default)-src[^;]*https:(?!\/\/)/);
    const d = detail('a', 'b');
    d.timeline[0].bodyHtml = img('https://camo.githubusercontent.com/a');
    expect(timelineDocument(d, false)).toContain('data-blocked="1"');
  });

  it('the main-process request filter: GitHub\'s two hosts, plus the loopback fake in tests', () => {
    const ep = { api: 'http://127.0.0.1:4000/api', web: 'http://127.0.0.1:4000/web' };
    expect(isAllowedRequest('https://github.com/a.png', ep)).toBe(true);
    expect(isAllowedRequest('https://api.github.com/graphql', ep)).toBe(true);
    expect(isAllowedRequest('http://127.0.0.1:4000/api/x', ep)).toBe(true);
    for (const u of ['https://camo.githubusercontent.com/a', 'https://evil.github.com/a', 'http://github.com/a', 'http://127.0.0.1:5000/x', 'https://example.com/']) {
      expect(isAllowedRequest(u, ep), u).toBe(false);
    }
  });
});
