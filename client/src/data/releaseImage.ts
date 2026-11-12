// Fetch one release attachment image with the sign-in (GitHub#395). Two steps:
//
//   1. look the attachment up — ordinary API reads through the GitHub client (the back end adds
//      the credential): the release of that tag, else (a draft has no tag to ask by) the newest
//      100 releases; the attachment is the one whose download address IS the image's address;
//   2. have the back end download it (`releaseImage`: only an attachment's API address is
//      accepted; the file comes from GitHub's two release-file hosts, without the credential).
//
// What a refusal means is decided once, by `refusalOf` (github.ts) — step 1's answers pass
// through it inside the client, step 2's answer is handed back by the back end as it came and
// passes through the same function here. A rate limit is told apart first; only then is a
// 403 / 404 "this sign-in cannot read it".

import type { Backend } from '../backend/backend';
import { parseReleaseImage, type ImageFailure, type ImageResult } from '../shared/images';
import { GitHubClient, GitHubError, MAX_LIMIT_WAIT_MS, RateLimitError, refusalOf, type Endpoints } from './github';

/** GitHub gave no time with a rate limit: ask again after this */
export const BLIND_LIMIT_WAIT_MS = 60_000;

interface Asset {
  url?: unknown;
  browser_download_url?: unknown;
}
interface Release {
  assets?: unknown;
}

/** the same address, whatever the escaping (GitHub writes a space as %20, a comment's author may not) */
function sameAddress(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

function assetOf(releases: Release[], src: string): string | null {
  for (const r of releases) {
    if (!Array.isArray(r?.assets)) continue;
    for (const a of r.assets as Asset[]) {
      if (typeof a?.browser_download_url === 'string' && typeof a.url === 'string' && sameAddress(a.browser_download_url, src)) return a.url;
    }
  }
  return null;
}

/** The one mapping from "what went wrong" to what is shown; both steps end here. */
export function imageFailureOf(e: unknown, now: number): ImageFailure {
  if (e instanceof RateLimitError) {
    let until = e.retryAfterMs !== null ? now + e.retryAfterMs : e.resetAt;
    if (until === null || until <= now) until = now + BLIND_LIMIT_WAIT_MS;
    return { kind: 'limited', until: Math.min(until, now + MAX_LIMIT_WAIT_MS) };
  }
  if (e instanceof GitHubError) {
    if (e.kind === 'auth') return { kind: 'auth' };
    if (e.kind === 'http' && (e.status === 403 || e.status === 404)) return { kind: 'denied' };
  }
  return { kind: 'unreachable' };
}

interface BackendImage {
  kind?: 'image' | 'answer' | 'tooLarge' | 'notImage' | 'badRedirect' | 'fileStatus';
  mime?: string;
  data?: string;
  status?: number;
  headers?: [string, string][];
  body?: string;
  error?: 'stale' | 'refused' | 'network';
}

const MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export async function fetchReleaseImage(client: GitHubClient, backend: Backend, session: number, endpoints: Endpoints, src: string, now: () => number): Promise<ImageResult> {
  const ref = parseReleaseImage(src, endpoints.web);
  if (!ref) return { ok: false, kind: 'denied' };
  const repo = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  try {
    let asset: string | null = null;
    try {
      const release = await client.rest<Release>('GET', `${repo}/releases/tags/${encodeURIComponent(ref.tag)}`);
      asset = release ? assetOf([release], src) : null;
    } catch (e) {
      // no release of that tag: a draft's attachments are only in the list (a rate limit is not a 404 — refusalOf said so)
      if (!(e instanceof GitHubError) || e instanceof RateLimitError || e.kind !== 'http' || e.status !== 404) throw e;
    }
    if (!asset) {
      const list = await client.rest<Release[]>('GET', `${repo}/releases?per_page=100`);
      asset = Array.isArray(list) ? assetOf(list, src) : null;
    }
    if (!asset) return { ok: false, kind: 'denied' };
    const r = await backend.call<BackendImage>('releaseImage', { session, url: asset });
    if (r.error === 'network') return { ok: false, kind: 'unreachable' };
    if (r.error === 'stale') return { ok: false, kind: 'auth' };
    if (r.error) return { ok: false, kind: 'denied' };
    switch (r.kind) {
      case 'image':
        if (typeof r.data !== 'string' || !MIMES.includes(r.mime ?? '')) return { ok: false, kind: 'notImage' };
        return { ok: true, dataUrl: `data:${r.mime};base64,${r.data}` };
      case 'tooLarge':
        return { ok: false, kind: 'tooLarge' };
      case 'notImage':
        return { ok: false, kind: 'notImage' };
      case 'answer': {
        const status = r.status ?? 0;
        // a Response cannot be built with every status (1xx, 204 with a body, …): those are no answer GitHub gives here
        if (status < 200 || status > 599 || status === 204 || status === 205 || status === 304) return { ok: false, kind: 'unreachable' };
        return { ok: false, ...imageFailureOf(await refusalOf(new Response(r.body ?? '', { status, headers: r.headers ?? [] })), now()) };
      }
      default:
        // a redirect somewhere else, or the file host did not hand the file over
        return { ok: false, kind: 'unreachable' };
    }
  } catch (e) {
    return { ok: false, ...imageFailureOf(e, now()) };
  }
}
