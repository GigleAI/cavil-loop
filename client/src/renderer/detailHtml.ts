// The detail timeline as one HTML document for the isolated view: a frame
// with `sandbox` (no same-origin, no forms, no top navigation) and its own
// Content-Security-Policy. GitHub's rendered HTML goes in as is; everything
// this file writes around it (names, times, paths) is escaped. Links open in
// a new window, which the main process turns into "open in the system
// browser" (GitHub addresses only).
//
// The one script that runs in the timeline frame is FRAME_SCRIPT (GitHub#193:
// it reports a ticked task-list box to the window). Two policies stand between
// GitHub's HTML and running anything, each allowing that script alone by its
// hash: the window's (tauri.conf.json — a srcdoc frame inherits it) and the
// frame's own (TIMELINE_CSP). The reply preview frame runs no script at all.

import type { ItemDetail, TimelineEntry } from '../shared/actions';
import { AVATAR_HOST, GITHUB_IMAGE_HOSTS, avatarInitial, avatarUrl } from '../shared/avatar';
import { annotateTaskBoxes, type PendingTick } from '../data/taskList';
import { FRAME_SCRIPT, FRAME_SCRIPT_HASH } from './frameScript';
import { annotateCodeBlocks, codeCss } from './codeBlocks';
import { parseReleaseImage } from '../shared/images';

/** the reply preview: no scripts at all */
export const FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
/** the timeline: scripts on (only FRAME_SCRIPT gets past both policies), still no same-origin */
export const TIMELINE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

/**
 * The app talks to github.com / api.github.com only (#135): images are loaded
 * from those two hosts, GitHub's avatar host for people's avatars (#155) and
 * GitHub's own attachment / image-proxy hosts (GitHub#205) — the maintainer's
 * choices — and nowhere else. A blocked image shows its alt text; the entry
 * says how many were not loaded.
 */
export const IMAGE_HOSTS = ['https://github.com', 'https://api.github.com', AVATAR_HOST, ...GITHUB_IMAGE_HOSTS];

export const FRAME_CSP = `default-src 'none'; img-src ${IMAGE_HOSTS.join(' ')} data:; media-src 'none'; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;

/** The timeline frame's own policy: FRAME_CSP with FRAME_SCRIPT, and nothing else, allowed to run. */
export const TIMELINE_CSP = FRAME_CSP.replace("script-src 'none'", `script-src ${FRAME_SCRIPT_HASH}`);

const IMG_TAG = /<img\b[^>]*>/gi;
const IMG_SRC = /(\s)src(\s*=\s*)(["'])([^"']*)\3/i;

function unescapeAttr(s: string): string {
  return s.replace(/&(amp|quot|#39|#x27|lt|gt);/gi, (_, e: string) => ({ amp: '&', quot: '"', '#39': "'", '#x27': "'", lt: '<', gt: '>' })[e.toLowerCase()] ?? '');
}

/**
 * GitHub#395: release attachment images are not loaded by the frame (a private repo's answer is
 * 404 without the sign-in, a public one's redirect leaves the allowed hosts). Each such `<img>`
 * loses its `src` and carries the address as `data-rel` instead: nothing is fetched while the
 * document loads; FRAME_SCRIPT asks the window for it, and the window fetches it with the sign-in.
 * `web` = the web base of the GitHub in use; without one, or with no such image, the HTML is
 * returned as it is.
 */
export function markReleaseImages(html: string, web: string | undefined): string {
  if (!web || !html.includes('/releases/download/')) return html;
  return html.replace(IMG_TAG, (tag) => {
    const m = IMG_SRC.exec(tag);
    if (!m || /\sdata-rel\s*=/i.test(tag)) return tag;
    const src = unescapeAttr(m[4]);
    if (!parseReleaseImage(src, web)) return tag;
    return tag.replace(IMG_SRC, `$1data-rel$2"${escapeHtml(src)}"`);
  });
}

/**
 * How many <img> in GitHub's HTML point outside the allowed hosts (they will not load).
 * Only the `src` the frame loads counts (GitHub#439): GitHub serves an outside image through its
 * proxy and keeps the original address in `data-canonical-src`, which loads nothing — the same
 * tag / attribute rules as `markReleaseImages`, so `data-canonical-src` is never read as `src`.
 */
export function blockedImages(html: string): number {
  let n = 0;
  for (const tag of html.match(IMG_TAG) ?? []) {
    const m = IMG_SRC.exec(tag);
    if (!m) continue;
    const src = unescapeAttr(m[4]);
    if (src.startsWith('data:')) continue;
    if (!IMAGE_HOSTS.some((h) => src === h || src.startsWith(`${h}/`))) n++;
  }
  return n;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const REVIEW_STATE: Record<string, string> = {
  APPROVED: '批准',
  CHANGES_REQUESTED: '要求修改',
  COMMENTED: '评审意见',
  DISMISSED: '已撤销的评审',
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** An avatar that falls back to the first letter by itself, without a script: the image sits over the letter. */
function avatarHtml(login: string | null, px: number): string {
  const img = login ? `<img src="${escapeHtml(avatarUrl(login, px))}" alt="" width="${px}" height="${px}">` : '';
  return `<span class="av" style="width:${px}px;height:${px}px" data-avatar="${escapeHtml(login ?? '')}"><span>${escapeHtml(avatarInitial(login))}</span>${img}</span>`;
}

/**
 * Plain text of GitHub's HTML, for the one-line preview of a folded entry:
 * tags dropped, the common entities decoded, whitespace collapsed, cut at
 * `max` characters. The caller escapes it again.
 */
export function plainExcerpt(html: string, max = 80): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (_, e: string) => {
      const k = e.toLowerCase();
      const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? parseInt(k.slice(1), 10) : NaN;
      if (k.startsWith('#')) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[k] ?? ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** the white tick drawn in a ticked box (a data: image — the frame's img-src allows those, nothing is fetched) */
const TICK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

/** Which entries are unfolded: the newest only (the default), all, or none (GitHub#155). */
export type Unfold = 'latest' | 'all' | 'none';

/**
 * GitHub's HTML of one body / comment with its task-list boxes numbered; they
 * can be clicked only when the entry allows it (GitHub#193) and `canTick` (online,
 * no change in flight). A read-only entry says why under its text.
 */
function bodyWithTasks(e: TimelineEntry, canTick: boolean, pending: PendingTick | null, wrap: boolean, web?: string): { html: string; note: string } {
  const t = e.tasks;
  // GitHub#381: every code block gets its two buttons; the boxes are numbered first, exactly as before
  const html = markReleaseImages(annotateCodeBlocks(annotateTaskBoxes(e.bodyHtml, canTick && t?.clickable === true, pending), wrap), web);
  const note = t && !t.clickable ? `<div class="tasknote" data-testid="task-readonly">${escapeHtml(t.why)}</div>` : '';
  return { html, note };
}

function entryHtml(e: TimelineEntry, open: boolean, canTick: boolean, pending: PendingTick | null = null, wrap = false, web?: string): string {
  const who = escapeHtml(e.author ?? '（已删除的账号）');
  const head =
    e.kind === 'body'
      ? `<b>${who}</b> 发起 · ${escapeHtml(when(e.at))} · 正文`
      : e.kind === 'review'
        ? `<b>${who}</b> · ${escapeHtml(REVIEW_STATE[e.reviewState ?? ''] ?? e.reviewState ?? '评审')} · ${escapeHtml(when(e.at))}`
        : `<b>${who}</b> · ${escapeHtml(when(e.at))}`;
  const excerpt = plainExcerpt(e.bodyHtml) || (e.lineComments?.length ? `${e.lineComments.length} 条逐行评论` : '（没有文字）');
  const link = e.url ? ` · <a href="${escapeHtml(e.url)}">在网页上看</a>` : '';
  const blocked = blockedImages(e.bodyHtml) + (e.lineComments ?? []).reduce((n, l) => n + blockedImages(l.bodyHtml), 0);
  const note = blocked ? `<div class="blocked" data-blocked="${blocked}">有 ${blocked} 张图片不在 GitHub 的地址上，客户端不加载；点「在网页上看」查看</div>` : '';
  const tasks = bodyWithTasks(e, canTick, pending, wrap, web);
  // GitHub#205: only what GitHub says this account may change, only while a change can be sent
  const edit =
    e.editSource !== undefined && (e.kind === 'body' || e.kind === 'comment')
      ? `<div class="tools"><button type="button" class="edit" data-edit${canTick ? '' : ' disabled title="离线或有修改在途时不能编辑"'}>编辑</button></div>`
      : '';
  const body = (e.bodyHtml.trim() ? `<div class="md">${tasks.html}</div>` : '') + tasks.note + note + edit;
  let lines = '';
  if (e.lineComments?.length) {
    lines =
      '<div class="lines">' +
      e.lineComments
        .map(
          (l) =>
            `<div class="line" data-entry="${escapeHtml(l.id)}"><div class="head"><code>${escapeHtml(l.path)}${l.line != null ? `:${l.line}` : ''}</code> · ${avatarHtml(l.author, 16)}<b>${escapeHtml(l.author ?? '')}</b> · ${escapeHtml(when(l.at))}</div><div class="md">${markReleaseImages(annotateCodeBlocks(l.bodyHtml, wrap), web)}</div></div>`,
        )
        .join('') +
      '</div>';
  }
  // a folded entry is one line (who, when, what kind, the start of its text); the browser's own
  // <details> opens it — no script involved (FRAME_SCRIPT only reports boxes and the view)
  return `<details class="entry ${e.kind}${e.reviewState ? ` ${escapeHtml(e.reviewState.toLowerCase())}` : ''}" data-entry="${escapeHtml(e.id)}" data-kind="${e.kind}"${open ? ' open' : ''}><summary class="head">${avatarHtml(e.author, 20)}${head}${link}<span class="excerpt" data-find-skip> · ${escapeHtml(excerpt)}</span></summary>${body}${lines}</details>`;
}

/** Is entry `i` (newest first) unfolded? By default only the newest is — with no comments that is the opening post. */
export function isUnfolded(i: number, unfold: Unfold): boolean {
  return unfold === 'all' || (unfold === 'latest' && i === 0);
}

/**
 * What the frame reported before a re-render (GitHub#193): the entries it knew,
 * which of them were unfolded, how far it was scrolled. A re-read after ticking a
 * box puts all three back; an entry it did not know yet follows `unfold`.
 */
export interface FrameView {
  known: string[];
  open: string[];
  scroll: number;
}

export interface TimelineOptions {
  /** this rendering's id: the frame's messages carry it, older frames' messages are dropped */
  render?: string;
  /** boxes of clickable entries can be ticked (online, no change in flight) */
  canTick?: boolean;
  /**
   * GitHub#358: the click still on its way — that box of that entry shows what was asked for, in
   * grey, until GitHub confirmed it and the detail was read again. Only a body / comment entry.
   */
  pending?: (PendingTick & { entryId: string }) | null;
  view?: FrameView | null;
  /** GitHub#381: long lines of code blocks fold onto the next line (the user's switch; off = scroll sideways) */
  wrap?: boolean;
  /** GitHub#395: the web base of the GitHub in use — release attachment images under it are fetched with the sign-in */
  web?: string;
  /** GitHub#395: no connection — "reload" of a failed image cannot be asked for */
  offline?: boolean;
}

export function timelineDocument(detail: ItemDetail, dark: boolean, unfold: Unfold = 'latest', opts: TimelineOptions = {}): string {
  const { render = '', canTick = false, view = null, pending = null, wrap = false, web, offline = false } = opts;
  const known = new Set(view?.known ?? []);
  const opened = new Set(view?.open ?? []);
  const isOpen = (e: TimelineEntry, i: number) => (known.has(e.id) ? opened.has(e.id) : isUnfolded(i, unfold));
  const scroll = view && Number.isFinite(view.scroll) && view.scroll > 0 ? Math.round(view.scroll) : 0;
  const fg = dark ? '#e6edf3' : '#1f2328';
  const bg = dark ? '#151b23' : '#ffffff';
  const border = dark ? '#3d444d' : '#d1d9e0';
  const muted = dark ? '#9198a1' : '#59636e';
  const accent = dark ? '#4493f8' : '#0969da';
  // GitHub#181: same tokens as the window (styles.css): a softer rule between entries, a tinted head on the open one
  const line = dark ? '#2a313c' : '#e3e8ed';
  const canvas = dark ? '#0d1117' : '#f6f8fa';
  // GitHub#358: a box waiting for GitHub — grey, between "not ticked" and the accent of a confirmed tick
  const wait = dark ? '#656c76' : '#8c959f';
  const waitBg = dark ? '#262c36' : '#eaeef2';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${TIMELINE_CSP}">
<base target="_blank">
<style>
body{margin:0;padding:2px 0 8px;background:${bg};color:${fg};font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Noto Sans CJK SC','Segoe UI',sans-serif;word-wrap:break-word}
a{color:${accent}}
.entry{border:1px solid ${line};border-radius:8px;margin:0 0 10px;overflow:hidden;background:${bg}}
.entry>.head{padding:7px 12px;color:${muted};font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entry[open]>.head{border-bottom:1px solid ${line};background:${canvas};white-space:normal}
.entry>.head b{color:${fg}}
.entry[open]>.head>.excerpt{display:none}
.entry>.head::marker,.entry>.head::-webkit-details-marker{color:${muted}}
.av{position:relative;display:inline-block;vertical-align:middle;margin-right:5px;border-radius:50%;overflow:hidden;background:${border};color:${fg};font-size:10px;line-height:1;text-align:center}
.av>span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.av>img{position:absolute;inset:0;width:100%;height:100%;border-radius:50%}
.entry.body{border-style:dashed;border-color:${border}}
.entry.approved>.head{border-left:3px solid #1a7f37}.entry.changes_requested>.head{border-left:3px solid #cf222e}
.md{padding:8px 12px;line-height:1.6}
::highlight(cavil-find){background:${dark ? '#5c4a00' : '#fff3a3'};color:inherit}
::highlight(cavil-find-cur){background:#ff9632;color:#1f2328}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md img{max-width:100%}
${codeCss(dark, '.md ')}
.cb{position:relative;margin:1em 0}
.cb>pre{margin:0}
body[data-wrap] .md pre{white-space:pre-wrap;overflow-wrap:anywhere}
.cbar{position:absolute;top:6px;right:6px;display:flex;gap:4px;opacity:0}
.cb:hover>.cbar,.cb:focus-within>.cbar{opacity:1}
.cbtn{font:12px/18px -apple-system,BlinkMacSystemFont,'PingFang SC','Noto Sans CJK SC','Segoe UI',sans-serif;color:${muted};background:${bg};border:1px solid ${border};border-radius:6px;padding:1px 8px;cursor:pointer}
.cbtn:focus-visible{outline:2px solid ${accent};outline-offset:1px}
.cbtn[data-code-wrap]::after{content:'：关'}
body[data-wrap] .cbtn[data-code-wrap]::after{content:'：开'}
body[data-wrap] .cbtn[data-code-wrap]{color:${accent};border-color:${accent}}
.cbtn[data-state=ok]{color:${dark ? '#3fb950' : '#1a7f37'};border-color:${dark ? '#3fb950' : '#1a7f37'}}
.cbtn[data-state=fail]{color:${dark ? '#f85149' : '#cf222e'};border-color:${dark ? '#f85149' : '#cf222e'}}
.md table{border-collapse:collapse}.md td,.md th{border:1px solid ${border};padding:2px 6px}
.lines{margin:4px 12px 10px 22px;border-left:2px solid ${line}}
.line{padding:2px 8px}
.line>.head,.more{color:${muted};font-size:12px}
.blocked{margin:0 10px 6px;color:${muted};font-size:12px}
.md .contains-task-list{padding-left:2em}
.md .task-list-item{list-style-type:none}
.md .task-list-item+.task-list-item{margin-top:2px}
.md .task-list-item-checkbox{-webkit-appearance:none;appearance:none;box-sizing:border-box;width:14px;height:14px;border:1.5px solid ${muted};border-radius:3px;background:${bg} center/11px no-repeat;margin:0 .3em .2em -1.5em;vertical-align:middle}
.md .task-list-item-checkbox:checked{background-color:${accent};background-image:${TICK};border-color:${accent}}
.md .task-list-item-checkbox:not([disabled]){cursor:pointer}
.md .task-list-item-checkbox:focus-visible{outline:2px solid ${accent};outline-offset:1px}
.md .task-list-item-checkbox[disabled]:not(:checked){border-color:${border};background-color:${canvas}}
.md .task-list-item-checkbox[disabled]:checked{opacity:.5}
.md .task-list-item-checkbox[data-pending]{opacity:1;border-color:${wait};background-color:${waitBg}}
.md .task-list-item-checkbox[data-pending]:checked{opacity:1;background-color:${wait}}
.tasknote{margin:0 12px 8px;color:${muted};font-size:12px}
.tools{margin:0 12px 8px;text-align:right}
.tools .edit{font:12px inherit;color:${accent};background:none;border:1px solid ${line};border-radius:6px;padding:1px 10px;cursor:pointer}
.tools .edit[disabled]{color:${muted};cursor:default}
.imgbox{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;box-sizing:border-box;max-width:100%;min-height:40px;margin:2px 0;padding:8px 12px;border:1px dashed ${border};border-radius:6px;background:${canvas};color:${muted};font-size:12px;line-height:1.5}
.imgbox .alt{color:${fg};font-weight:600}
.imgbox .acts{margin-left:auto;display:flex;gap:10px;align-items:center}
.imgbox button{font:12px inherit;color:${accent};background:${bg};border:1px solid ${border};border-radius:6px;padding:2px 10px;cursor:pointer}
.imgbox button[disabled]{color:${muted};background:${canvas};cursor:default}
.imgbox[data-state="loading"] .why::before{content:"";display:inline-block;width:10px;height:10px;margin-right:6px;border:2px solid ${border};border-top-color:${accent};border-radius:50%;vertical-align:-2px;animation:imgspin 1s linear infinite}
@keyframes imgspin{to{transform:rotate(360deg)}}
[data-img-hidden]{display:none!important}
</style></head><body data-render="${escapeHtml(render)}" data-scroll="${scroll}"${wrap ? ' data-wrap=""' : ''}${offline ? ' data-offline=""' : ''}>
${detail.timeline.map((e, i) => entryHtml(e, isOpen(e, i), canTick, pending && pending.entryId === e.id && (e.kind === 'body' || e.kind === 'comment') ? pending : null, wrap, web)).join('\n')}
<script>${FRAME_SCRIPT}</script>
</body></html>`;
}

/**
 * The reply preview as one document (GitHub's rendering of what was typed): no
 * script, no buttons — only the code styles the discussion uses (GitHub#381),
 * so a block is coloured the same in both.
 */
export function previewDocument(html: string, dark: boolean): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(FRAME_CSP)}"><base target="_blank"><style>${codeCss(dark)}</style><body style="font:13px/1.5 sans-serif;margin:6px;color:${dark ? '#e6edf3' : '#1f2328'};background:${dark ? '#151b23' : '#ffffff'}">${html}</body>`;
}
