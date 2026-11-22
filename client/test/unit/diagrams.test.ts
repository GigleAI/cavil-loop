// GitHub#680: GitHub's "drawn on the web page" placeholders (a mermaid diagram, a GeoJSON map) become the
// client's own blocks — in every place that shows GitHub's HTML: an entry of the discussion, a review's line
// comment, the reply preview. The input is GitHub's real rendering of test/fixtures/github-enrichment.md
// (POST /markdown, mode gfm), saved as test/fixtures/github-enrichment.html.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { annotateDiagrams, decodeText, diagramSources, DIAGRAM_DATA, withoutPlaceholders } from '../../src/renderer/diagramBlocks';
import { DIAGRAM_SANDBOX, diagramCsp, drawAgain, helperDocument, svgDataUrl } from '../../src/renderer/diagramHost';
import { previewDocument, timelineDocument, plainExcerpt } from '../../src/renderer/detailHtml';
import type { ItemDetail } from '../../src/shared/actions';

const fixtures = join(__dirname, '..', 'fixtures');
const GH = readFileSync(join(fixtures, 'github-enrichment.html'), 'utf8');
/** the mermaid block's source exactly as written in the markdown */
const SOURCE = 'flowchart LR\n  A["Start & go"] --> B{Check<br/>it?}\n  B -- yes --> C[Done]\n';
const SVG = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>流程</text></svg>');
const WEB = 'https://github.com/o/r/issues/1#issuecomment-1';

describe('the fixture is GitHub\'s real placeholder shape', () => {
  it('has the two placeholders, their spinners and the markdown source', () => {
    expect(GH.match(/js-render-needs-enrichment/g)).toHaveLength(2);
    expect(GH).toContain('<span class="sr-only">Loading</span>');
    expect(GH).toContain('data-type="mermaid"');
    expect(GH).toContain('data-type="geojson"');
    expect(readFileSync(join(fixtures, 'github-enrichment.md'), 'utf8')).toContain(SOURCE);
  });
});

describe('annotateDiagrams', () => {
  const out = annotateDiagrams(GH, { web: WEB });
  it('leaves no placeholder and no endless "Loading" behind', () => {
    expect(out).not.toContain('js-render-needs-enrichment');
    expect(out).not.toContain('Loading');
    expect(out).not.toContain('viewscreen.githubusercontent.com');
  });
  it('mermaid: a box where the picture goes, the source folded under it, the entry\'s web address carried', () => {
    expect(out).toContain('<div class="mmd" data-mmd data-web="https://github.com/o/r/issues/1#issuecomment-1"><div class="mmdbox" data-state="drawing" data-find-skip>正在画流程图…</div>');
    expect(out).toContain('<details class="mmdsrc"><summary data-find-skip>流程图原文</summary><pre lang="mermaid">');
    // the source as GitHub escaped it, decoded to exactly what was written
    const pre = /<pre lang="mermaid">([\s\S]*?)<\/pre>/.exec(out)![1];
    expect(decodeText(pre)).toBe(SOURCE);
  });
  it('another kind: the source as an ordinary code block, with the "web page only" line and its link', () => {
    expect(out).toContain('<div class="enrich" data-enrich="geojson" data-find-skip>这类图只在 GitHub 网页上显示 · <a class="mmdweb" href="https://github.com/o/r/issues/1#issuecomment-1">在 GitHub 打开</a></div><pre lang="geojson">{"type": "Point", "coordinates": [1, 2]}\n</pre>');
  });
  it('everything else is left exactly as it was', () => {
    const before = GH.slice(GH.lastIndexOf('</section>') + '</section>'.length);
    expect(out.endsWith(before)).toBe(true);
    expect(out.startsWith('<p dir="auto">Before the diagram &amp; after.</p>\n<div class="mmd"')).toBe(true);
  });
  it('a drawn picture goes straight in; a failure says why, links to the web page and opens the source', () => {
    const drawn = annotateDiagrams(GH, { web: WEB, drawn: (s) => (s === SOURCE ? { ok: true, data: SVG } : undefined) });
    expect(drawn).toContain(`<div class="mmd" data-mmd data-web="${WEB}"><img class="mmdimg" alt="流程图" src="${SVG}"><details class="mmdsrc">`);
    const bad = annotateDiagrams(GH, { web: WEB, drawn: () => ({ ok: false, why: 'syntax' }) });
    expect(bad).toContain('<div class="mmdbox" data-state="failed" data-find-skip>这张流程图没画出来（写法有误），下面是原文 · <a class="mmdweb"');
    expect(bad).toContain('<details class="mmdsrc" open>');
    expect(annotateDiagrams(GH, { drawn: () => ({ ok: false, why: 'tooBig' }) })).toContain('这张流程图太长，没有画，下面是原文</div>');
    expect(annotateDiagrams(GH, { drawn: () => ({ ok: false, why: 'failed' }) })).toContain('这张流程图没画出来，下面是原文</div>');
    // an "answer" that is not an SVG data address is never put into an image
    for (const data of ['data:image/png;base64,AAAA', 'javascript:alert(1)', 'data:image/svg+xml,<svg onload=x>', `${SVG}"onerror="x`]) {
      const r = annotateDiagrams(GH, { drawn: () => ({ ok: true, data }) });
      expect(r).not.toContain('<img');
      expect(r).toContain('data-state="failed"');
    }
  });
  it('a placeholder of another shape is left as it is', () => {
    const noKind = '<section class="js-render-needs-enrichment"><pre>x</pre></section>';
    const twoPres = '<section class="js-render-needs-enrichment" data-type="mermaid"><pre>a</pre><pre>b</pre></section>';
    const badKind = '<section class="js-render-needs-enrichment" data-type="a b"><pre>a</pre></section>';
    const other = '<section data-footnotes class="footnotes"><ol><li>x</li></ol></section>';
    for (const h of [noKind, twoPres, badKind, other]) expect(annotateDiagrams(h)).toBe(h);
    // a placeholder after an ordinary section is still found
    expect(annotateDiagrams(other + GH)).toContain(other + '<p dir="auto">Before');
    expect(annotateDiagrams(other + GH)).not.toContain('js-render-needs-enrichment');
  });
  it('HTML with no placeholder is returned as it is', () => {
    const h = '<p>a</p><pre>b</pre>';
    expect(annotateDiagrams(h)).toBe(h);
  });
});

describe('diagramSources / withoutPlaceholders', () => {
  it('the mermaid sources only, decoded', () => {
    expect(diagramSources(GH)).toEqual([SOURCE]);
    expect(diagramSources(GH + GH)).toEqual([SOURCE, SOURCE]);
    expect(diagramSources('<p>x</p>')).toEqual([]);
  });
  it('a folded entry\'s one-line preview has the source, not "Loading"', () => {
    const line = plainExcerpt(withoutPlaceholders(GH), 400);
    expect(line).not.toContain('Loading');
    expect(line).toContain('flowchart LR A["Start & go"] --> B{Check<br/>it?}');
  });
});

describe('every place that shows GitHub\'s HTML', () => {
  const lines = GH.replace('Before the diagram', 'In a line comment');
  const detail: ItemDetail = {
    key: 'o/r#1', repo: 'o/r', number: 1, kind: 'pr', title: 't', url: 'https://github.com/o/r/pull/1', state: 'open', pr: null, fetchedAt: 0, labels: [],
    timeline: [
      { kind: 'review', id: 'R1', url: 'https://github.com/o/r/pull/1#r1', author: 'a', at: '2026-11-03T00:00:00Z', bodyHtml: '<p>see</p>', reviewState: 'COMMENTED',
        lineComments: [{ id: 'L1', url: 'https://github.com/o/r/pull/1#discussion_r9', author: 'a', at: '2026-11-03T00:00:00Z', path: 'a.md', line: 1, bodyHtml: lines }] },
      { kind: 'comment', id: 'C1', url: WEB, author: 'b', at: '2026-11-02T00:00:00Z', bodyHtml: GH },
    ],
  };
  const doc = timelineDocument(detail, false, 'all', { render: 'r' });
  it('an entry and a review\'s line comment: both blocks, each with its own web address, the source block with its buttons', () => {
    expect(doc).not.toContain('js-render-needs-enrichment');
    expect(doc).not.toContain('Loading');
    expect(doc.match(/<div class="mmd" data-mmd/g)).toHaveLength(2);
    expect(doc).toContain(`data-web="${WEB}"`);
    expect(doc).toContain('data-web="https://github.com/o/r/pull/1#discussion_r9"');
    // the source block inside the fold got the code block's two buttons
    expect(doc).toMatch(/<summary data-find-skip>流程图原文<\/summary><div class="cb"><div class="cbar">/);
    // the styles are in the frame
    expect(doc).toContain('.md .mmdbox');
  });
  it('the reply preview: the picture drawn by the window goes in; not drawn yet, the box', () => {
    const shown = previewDocument(GH, true, (s) => (s === SOURCE ? { ok: true, data: SVG } : undefined));
    expect(shown).toContain(`<img class="mmdimg" alt="流程图" src="${SVG}">`);
    expect(shown).not.toContain('Loading');
    expect(shown).toContain('.mmdbox');
    // PR #681 review round 1, problem 1: the preview's failure line and the "web page only" line link to the item's page
    const item = 'https://github.com/o/r/issues/1';
    for (const why of ['failed', 'syntax', 'tooBig'] as const) {
      const failed = previewDocument(GH, false, () => ({ ok: false, why }), item);
      expect(failed).toMatch(new RegExp(`<div class="mmdbox" data-state="failed" data-find-skip>[^<]*下面是原文 · <a class="mmdweb" href="${item}">在 GitHub 打开</a></div>`));
      expect(failed).toContain('<details class="mmdsrc" open>');
      expect(failed).toContain(`<div class="enrich" data-enrich="geojson" data-find-skip>这类图只在 GitHub 网页上显示 · <a class="mmdweb" href="${item}">在 GitHub 打开</a></div>`);
    }
    const waiting = previewDocument(GH, true);
    expect(waiting).toContain('data-state="drawing"');
    expect(waiting).not.toContain('<img');
  });
});

describe('which answers are asked for again (PR #681 review round 1, problem 2)', () => {
  it('never asked, or "failed" (the helper did not start / answer): asked again; a picture or a bad source: kept', () => {
    expect(drawAgain(undefined)).toBe(true);
    expect(drawAgain({ ok: false, why: 'failed' })).toBe(true);
    expect(drawAgain({ ok: false, why: 'syntax' })).toBe(false);
    expect(drawAgain({ ok: false, why: 'tooBig' })).toBe(false);
    expect(drawAgain({ ok: true, data: SVG })).toBe(false);
  });
});

describe('the helper frame', () => {
  it('runs scripts only, never as the window\'s origin', () => {
    expect(DIAGRAM_SANDBOX.split(/\s+/)).toEqual(['allow-scripts']);
  });
  it('its policy: the two scripts of diagram/ and no connection', () => {
    const doc = helperDocument('tauri://localhost/index.html');
    expect(doc).toContain('<script src="tauri://localhost/diagram/mermaid.min.js"></script><script src="tauri://localhost/diagram/draw.js"></script>');
    const csp = diagramCsp('tauri://localhost/diagram/');
    expect(csp).toContain("script-src tauri://localhost/diagram/;");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline'; *script/);
    expect(doc).toContain(`content="${csp.replace(/'/g, "'")}"`);
  });
  it('an SVG becomes a data address the frame takes, UTF-8 intact', () => {
    expect(DIAGRAM_DATA.test(SVG)).toBe(true);
    const b64 = SVG.slice('data:image/svg+xml;base64,'.length);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toContain('<text>流程</text>');
  });
});
