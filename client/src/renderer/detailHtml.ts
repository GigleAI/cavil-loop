// The detail timeline as one HTML document for the isolated view: a frame
// with `sandbox` (no scripts, no same-origin, no forms, no top navigation)
// and its own Content-Security-Policy. GitHub's rendered HTML goes in as is;
// everything this file writes around it (names, times, paths) is escaped.
// Links open in a new window, which the main process turns into "open in
// the system browser" (GitHub addresses only).

import type { ItemDetail, TimelineEntry } from '../shared/actions';

export const FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * The app talks to github.com / api.github.com only (#135): images are loaded
 * from those two hosts and nowhere else — GitHub's own image proxy and
 * attachment hosts (*.githubusercontent.com) included. A blocked image shows
 * its alt text; the entry says how many were not loaded.
 */
export const IMAGE_HOSTS = ['https://github.com', 'https://api.github.com'];

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

function entryHtml(e: TimelineEntry): string {
  const who = escapeHtml(e.author ?? '（已删除的账号）');
  const head =
    e.kind === 'body'
      ? `<b>${who}</b> 发起 · ${escapeHtml(when(e.at))} · 正文`
      : e.kind === 'review'
        ? `<b>${who}</b> · ${escapeHtml(REVIEW_STATE[e.reviewState ?? ''] ?? e.reviewState ?? '评审')} · ${escapeHtml(when(e.at))}`
        : `<b>${who}</b> · ${escapeHtml(when(e.at))}`;
  const link = e.url ? ` · <a href="${escapeHtml(e.url)}">在网页上看</a>` : '';
  const blocked = blockedImages(e.bodyHtml) + (e.lineComments ?? []).reduce((n, l) => n + blockedImages(l.bodyHtml), 0);
  const note = blocked ? `<div class="blocked" data-blocked="${blocked}">有 ${blocked} 张图片存放在 github.com 以外的地址，客户端只和 github.com 通信，没有加载；点「在网页上看」查看</div>` : '';
  const body = (e.bodyHtml.trim() ? `<div class="md">${e.bodyHtml}</div>` : '') + note;
  let lines = '';
  if (e.lineComments?.length) {
    lines =
      '<div class="lines">' +
      e.lineComments
        .map(
          (l) =>
            `<div class="line" data-entry="${escapeHtml(l.id)}"><div class="head"><code>${escapeHtml(l.path)}${l.line != null ? `:${l.line}` : ''}</code> · <b>${escapeHtml(l.author ?? '')}</b> · ${escapeHtml(when(l.at))}</div><div class="md">${l.bodyHtml}</div></div>`,
        )
        .join('') +
      '</div>';
  }
  return `<article class="entry ${e.kind}${e.reviewState ? ` ${escapeHtml(e.reviewState.toLowerCase())}` : ''}" data-entry="${escapeHtml(e.id)}" data-kind="${e.kind}"><div class="head">${head}${link}</div>${body}${lines}</article>`;
}

export function timelineDocument(detail: ItemDetail, dark: boolean): string {
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
.entry>.head{padding:6px 10px;border-bottom:1px solid ${border};color:${muted};font-size:12px}
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
${detail.timeline.map(entryHtml).join('\n')}
</body></html>`;
}
