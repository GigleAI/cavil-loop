// GitHub#680: the blocks GitHub's web page draws with its own script (a mermaid diagram, a GeoJSON /
// TopoJSON map, an STL model). In the HTML GitHub hands out, such a block is a placeholder — the
// source in a hidden `<pre>`, a spinner with "Loading" — that only GitHub's page ever fills; shown
// as it is, the client had the bare source with a "Loading" under it that never ended.
//
// `annotateDiagrams` puts the client's own block in its place, the same way in every place that
// shows GitHub's HTML (an entry of the discussion, a review's line comment, the reply preview):
//   - mermaid: a box where the picture goes, and the source folded under it ("流程图原文");
//     the picture is drawn by the window (diagramHost.ts) and shown as an image
//   - any other kind: the source as an ordinary code block, with a line saying that only GitHub's
//     web page shows it
// A placeholder of any other shape (no kind, not exactly one `<pre>`) is left as it is. Runs before
// `annotateCodeBlocks`, so the source block gets its two buttons like any other.

import { t } from '../shared/i18n';
import type { DrawResult } from './diagramHost';

/** a section whose opening tag names the placeholder class (one inside another kind of section is found too) */
const SECTION = /<section\b[^>]*\bjs-render-needs-enrichment\b[^>]*>[\s\S]*?<\/section\s*>/gi;
const OPEN_TAG = /^<section\b[^>]*>/i;
const PRE = /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi;
/** an image address the discussion takes for a drawn diagram: SVG, base64, nothing else */
export const DIAGRAM_DATA = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** the text of HTML-escaped content, as a browser's `textContent` gives it */
export function decodeText(html: string): string {
  return html.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (all, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#')) {
      const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[k] ?? all;
  });
}

interface Placeholder {
  kind: string;
  /** the `<pre>`'s content as GitHub escaped it */
  inner: string;
}

/** a GitHub "drawn on the web page" placeholder, or null when `block` is not one of the known shape */
function placeholder(block: string): Placeholder | null {
  const open = OPEN_TAG.exec(block)?.[0] ?? '';
  const cls = attr(open, 'class') ?? '';
  if (!/(^|\s)js-render-needs-enrichment(\s|$)/.test(cls)) return null;
  const kind = (attr(open, 'data-type') ?? '').toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(kind)) return null;
  const pres = [...block.matchAll(PRE)];
  if (pres.length !== 1) return null;
  return { kind, inner: pres[0][1] };
}

/** The source of every mermaid diagram in GitHub's HTML, in order (the reply preview draws them first). */
export function diagramSources(html: string): string[] {
  if (!html.includes('js-render-needs-enrichment')) return [];
  const out: string[] = [];
  for (const m of html.matchAll(SECTION)) {
    const p = placeholder(m[0]);
    if (p?.kind === 'mermaid') out.push(decodeText(p.inner));
  }
  return out;
}

/** GitHub's HTML with each placeholder reduced to its source block (the one-line preview of a folded entry) */
export function withoutPlaceholders(html: string): string {
  if (!html.includes('js-render-needs-enrichment')) return html;
  return html.replace(SECTION, (block) => {
    const p = placeholder(block);
    return p ? `<pre>${p.inner}</pre>` : block;
  });
}

/** the line in place of a picture that could not be drawn */
export function notDrawnText(why: string): string {
  return why === 'syntax' ? t('这张流程图没画出来（写法有误），下面是原文') : why === 'tooBig' ? t('这张流程图太长，没有画，下面是原文') : t('这张流程图没画出来，下面是原文');
}

export interface DiagramOptions {
  /** the address of this entry on GitHub's web page: the failure line and the "web only" line link to it */
  web?: string;
  /** a diagram already drawn (the reply preview): the picture, or why not, goes in directly */
  drawn?: (src: string) => DrawResult | undefined;
}

function webLink(web: string | undefined): string {
  return web && /^https?:\/\//i.test(web) ? ` · <a class="mmdweb" href="${esc(web)}">${esc(t('在 GitHub 打开'))}</a>` : '';
}

/** GitHub's HTML with each "drawn on the web page" placeholder replaced by the client's own block. */
export function annotateDiagrams(html: string, opts: DiagramOptions = {}): string {
  if (!html.includes('js-render-needs-enrichment')) return html;
  return html.replace(SECTION, (block) => {
    const p = placeholder(block);
    if (!p) return block;
    const pre = `<pre lang="${esc(p.kind)}">${p.inner}</pre>`;
    if (p.kind !== 'mermaid') return `<div class="enrich" data-enrich="${esc(p.kind)}" data-find-skip>${esc(t('这类图只在 GitHub 网页上显示'))}${webLink(opts.web)}</div>${pre}`;
    const r = opts.drawn?.(decodeText(p.inner));
    let box: string;
    let open = false;
    if (!r) box = `<div class="mmdbox" data-state="drawing" data-find-skip>${esc(t('正在画流程图…'))}</div>`;
    else if (r.ok && DIAGRAM_DATA.test(r.data)) box = `<img class="mmdimg" alt="${esc(t('流程图'))}" src="${r.data}">`;
    else {
      box = `<div class="mmdbox" data-state="failed" data-find-skip>${esc(notDrawnText(r.ok ? 'failed' : r.why))}${webLink(opts.web)}</div>`;
      open = true;
    }
    return `<div class="mmd" data-mmd${opts.web ? ` data-web="${esc(opts.web)}"` : ''}>${box}<details class="mmdsrc"${open ? ' open' : ''}><summary data-find-skip>${esc(t('流程图原文'))}</summary>${pre}</details></div>`;
  });
}

/** The styles of these blocks; `scope` as in codeCss (".md " in the discussion, nothing in the preview). */
export function diagramCss(dark: boolean, scope = ''): string {
  const muted = dark ? '#9198a1' : '#59636e';
  const border = dark ? '#3d444d' : '#d1d9e0';
  const accent = dark ? '#4493f8' : '#0969da';
  return `${scope}.mmd{margin:8px 0}
${scope}.mmdbox,${scope}.enrich{border:1px dashed ${border};border-radius:6px;padding:8px 10px;margin:8px 0;font-size:12px;color:${muted}}
${scope}.mmdbox a,${scope}.enrich a{color:${accent}}
${scope}img.mmdimg{display:block;max-width:100%;height:auto;margin:4px auto}
${scope}.mmdsrc>summary{cursor:pointer;color:${muted};font-size:12px;margin:6px 0}`;
}
