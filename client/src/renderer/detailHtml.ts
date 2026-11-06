// The detail timeline as one HTML document for the isolated view: a frame
// with `sandbox` (no scripts, no same-origin, no forms, no top navigation)
// and its own Content-Security-Policy. GitHub's rendered HTML goes in as is;
// everything this file writes around it (names, times, paths) is escaped.
// Links open in a new window, which the main process turns into "open in
// the system browser" (GitHub addresses only).

import type { ItemDetail, TimelineEntry } from '../shared/actions';
import { AVATAR_HOST, avatarInitial, avatarUrl } from '../shared/avatar';

export const FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * The app talks to github.com / api.github.com only (#135): images are loaded
 * from those two hosts, plus GitHub's avatar host for people's avatars
 * (#155, the maintainer's choice), and nowhere else — GitHub's image proxy and
 * attachment hosts (camo / user-images *.githubusercontent.com) stay blocked.
 * A blocked image shows its alt text; the entry says how many were not loaded.
 */
export const IMAGE_HOSTS = ['https://github.com', 'https://api.github.com', AVATAR_HOST];

export const FRAME_CSP = `default-src 'none'; img-src ${IMAGE_HOSTS.join(' ')} data:; media-src 'none'; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;

/** How many <img> in GitHub's HTML point outside the allowed hosts (they will not load). */
export function blockedImages(html: string): number {
  let n = 0;
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']*)["']/gi)) {
    const src = m[1];
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

/** An avatar that falls back to the first letter by itself (the frame runs no scripts): the image sits over the letter. */
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

/** Which entries are unfolded: the newest only (the default), all, or none (GitHub#155). */
export type Unfold = 'latest' | 'all' | 'none';

function entryHtml(e: TimelineEntry, open: boolean): string {
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
  const note = blocked ? `<div class="blocked" data-blocked="${blocked}">有 ${blocked} 张图片存放在 GitHub 的图片代理或附件地址，客户端不加载这些地址；点「在网页上看」查看</div>` : '';
  const body = (e.bodyHtml.trim() ? `<div class="md">${e.bodyHtml}</div>` : '') + note;
  let lines = '';
  if (e.lineComments?.length) {
    lines =
      '<div class="lines">' +
      e.lineComments
        .map(
          (l) =>
            `<div class="line" data-entry="${escapeHtml(l.id)}"><div class="head"><code>${escapeHtml(l.path)}${l.line != null ? `:${l.line}` : ''}</code> · ${avatarHtml(l.author, 16)}<b>${escapeHtml(l.author ?? '')}</b> · ${escapeHtml(when(l.at))}</div><div class="md">${l.bodyHtml}</div></div>`,
        )
        .join('') +
      '</div>';
  }
  // a folded entry is one line (who, when, what kind, the start of its text); the browser's own
  // <details> opens it — the frame runs no scripts
  return `<details class="entry ${e.kind}${e.reviewState ? ` ${escapeHtml(e.reviewState.toLowerCase())}` : ''}" data-entry="${escapeHtml(e.id)}" data-kind="${e.kind}"${open ? ' open' : ''}><summary class="head">${avatarHtml(e.author, 20)}${head}${link}<span class="excerpt"> · ${escapeHtml(excerpt)}</span></summary>${body}${lines}</details>`;
}

/** Is entry `i` (newest first) unfolded? By default only the newest is — with no comments that is the opening post. */
export function isUnfolded(i: number, unfold: Unfold): boolean {
  return unfold === 'all' || (unfold === 'latest' && i === 0);
}

export function timelineDocument(detail: ItemDetail, dark: boolean, unfold: Unfold = 'latest'): string {
  const fg = dark ? '#e6edf3' : '#1f2328';
  const bg = dark ? '#151b23' : '#ffffff';
  const border = dark ? '#3d444d' : '#d1d9e0';
  const muted = dark ? '#9198a1' : '#59636e';
  const accent = dark ? '#4493f8' : '#0969da';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<base target="_blank">
<style>
body{margin:0;padding:8px 12px;background:${bg};color:${fg};font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Noto Sans CJK SC','Segoe UI',sans-serif;word-wrap:break-word}
a{color:${accent}}
.entry{border:1px solid ${border};border-radius:8px;margin:0 0 10px;overflow:hidden}
.entry>.head{padding:6px 10px;color:${muted};font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entry[open]>.head{border-bottom:1px solid ${border};white-space:normal}
.entry[open]>.head>.excerpt{display:none}
.entry>.head::marker,.entry>.head::-webkit-details-marker{color:${muted}}
.av{position:relative;display:inline-block;vertical-align:middle;margin-right:5px;border-radius:50%;overflow:hidden;background:${border};color:${fg};font-size:10px;line-height:1;text-align:center}
.av>span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.av>img{position:absolute;inset:0;width:100%;height:100%;border-radius:50%}
.entry.body{border-style:dashed}
.entry.approved>.head{border-left:3px solid #1a7f37}.entry.changes_requested>.head{border-left:3px solid #cf222e}
.md{padding:4px 10px}
.md img{max-width:100%}
.md pre{overflow:auto;background:${dark ? '#0d1117' : '#f6f8fa'};padding:8px;border-radius:6px}
.md table{border-collapse:collapse}.md td,.md th{border:1px solid ${border};padding:2px 6px}
.lines{margin:4px 10px 8px 20px;border-left:2px solid ${border}}
.line{padding:2px 8px}
.line>.head,.more{color:${muted};font-size:12px}
.blocked{margin:0 10px 6px;color:${muted};font-size:12px}
</style></head><body>
${detail.timeline.map((e, i) => entryHtml(e, isUnfolded(i, unfold))).join('\n')}
</body></html>`;
}
