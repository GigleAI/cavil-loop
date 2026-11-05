// The isolated view's document: GitHub's HTML goes in as is, everything the
// client writes around it is escaped, and the frame's own policy forbids scripts.

import { describe, expect, it } from 'vitest';
import { FRAME_CSP, FRAME_SANDBOX, timelineDocument } from '../../src/renderer/detailHtml';
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
      moreLineComments: 0,
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
});
