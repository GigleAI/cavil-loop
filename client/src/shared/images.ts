// Release attachment images in the discussion (GitHub#395): what the window asks for and what it
// is told — and the one place the words shown for each outcome are written.
//
// An image whose address is `<github>/<owner>/<repo>/releases/download/<tag>/<file>` cannot be
// loaded by the window itself (a private repo answers 404 without the sign-in; a public one
// redirects to a host outside the image policy). The client fetches it with the sign-in instead
// (src/data/releaseImage.ts); every other image is loaded by the window as before.

export interface ReleaseImageRef {
  owner: string;
  repo: string;
  tag: string;
  file: string;
}

/**
 * `src` is a release download address of the GitHub this client talks to (`web` = its web base,
 * https://github.com in the app). Parsed, never prefix-matched; anything else is null.
 */
export function parseReleaseImage(src: string, web: string): ReleaseImageRef | null {
  let u: URL;
  let base: URL;
  try {
    u = new URL(src);
    base = new URL(web);
  } catch {
    return null;
  }
  if (u.origin !== base.origin || u.username || u.password) return null;
  const root = base.pathname.replace(/\/+$/, '');
  if (!u.pathname.startsWith(`${root}/`)) return null;
  const parts = u.pathname.slice(root.length + 1).split('/');
  // owner / repo / "releases" / "download" / tag … / file — a tag may hold slashes (`client/v1.2`,
  // GitHub writes them as they are; `client%2Fv1.2` is the same tag): the file is the last part,
  // the tag everything between
  if (parts.length < 6 || parts[2] !== 'releases' || parts[3] !== 'download' || parts.some((p) => p === '')) return null;
  let seg: string[];
  try {
    seg = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  const [owner, repo] = seg;
  const file = seg[seg.length - 1];
  const tag = seg.slice(4, -1).join('/');
  const name = /^[A-Za-z0-9._-]{1,100}$/;
  if (!name.test(owner) || !name.test(repo) || owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  // a file name holds no slash; a tag holds no empty, "." or ".." part (git refuses those names too)
  if (file.includes('/') || file === '.' || file === '..') return null;
  if (tag.split('/').some((t) => t === '' || t === '.' || t === '..')) return null;
  return { owner, repo, tag, file };
}

/**
 * Why an image is not shown.
 *   limited      GitHub's rate limit: wait until `until` (epoch ms), then ask again — says nothing about access
 *   denied       GitHub refused or does not know it: this sign-in cannot read that repo's attachments, or there is no such file
 *                (`app`: the sign-in in use went through a GitHub App — whose permissions may not include it)
 *   unreachable  no answer worth the name: no connection, GitHub's own error
 *   auth         the sign-in is over
 *   tooLarge / notImage   the file arrived (or would have) and cannot be shown
 */
export type ImageFailure =
  | { kind: 'limited'; until: number }
  | { kind: 'denied'; app?: boolean }
  | { kind: 'unreachable' | 'auth' | 'tooLarge' | 'notImage' };

export type ImageResult = { ok: true; dataUrl: string } | ({ ok: false } & ImageFailure);

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The app needs this to download a private repo's release attachment when signed in through a GitHub App. */
export const APP_CONTENTS_NOTE = '用 GitHub App 登录时，需要那个 App 有读取仓库内容（Contents）的权限';

/** The line shown in the image's place. Only "denied" speaks of permissions; a rate limit never does. */
export function imageFailureText(f: ImageFailure): string {
  switch (f.kind) {
    case 'limited':
      return `GitHub 限流，${clock(f.until)} 之后可以再试`;
    case 'denied':
      return `没取到：当前登录读不到这个仓库的发布附件${f.app ? `；${APP_CONTENTS_NOTE}` : ''}`;
    case 'unreachable':
      return '没取到：连不上 GitHub';
    case 'auth':
      return '没取到：登录已失效，请重新登录';
    case 'tooLarge':
      return '没取到：图片超过 10 MB';
    case 'notImage':
      return '没取到：这个附件不是 PNG / JPEG / GIF / WebP 图片';
  }
}

/** Two addresses name the same attachment, whatever the escaping (`client/v1` and `client%2Fv1`, a space and %20). */
export function sameReleaseImage(a: string, b: string, web: string): boolean {
  const x = parseReleaseImage(a, web);
  const y = parseReleaseImage(b, web);
  return !!x && !!y && x.owner.toLowerCase() === y.owner.toLowerCase() && x.repo.toLowerCase() === y.repo.toLowerCase() && x.tag === y.tag && x.file === y.file;
}
