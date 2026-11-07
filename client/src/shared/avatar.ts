// People's avatars (GitHub#155). GitHub serves every avatar from one host,
// avatars.githubusercontent.com (github.com/<login>.png only redirects
// there). The maintainer allowed this one host for avatars; GitHub's own image
// hosts for attachments and its image proxy followed in GitHub#205 (see
// GITHUB_IMAGE_HOSTS). One function builds the avatar address for the board,
// the table and the detail view alike.

export const AVATAR_HOST = 'https://avatars.githubusercontent.com';

/**
 * GitHub's own image hosts the discussion may load from (GitHub#205, the
 * maintainer's choice): pasted attachments (`private-user-images` — what
 * GitHub's rendered HTML points at today, a signed address that needs no
 * credential; `user-images` — attachments from before 2023) and GitHub's image
 * proxy (`camo`, which fetches external images on the reader's behalf). Exact
 * hosts only, never `*.githubusercontent.com`. The window's policy
 * (src-tauri/tauri.conf.json) and the "open in the browser" rule
 * (src-tauri/crates/core/src/engine.rs) carry the same list; tests check both.
 */
export const GITHUB_IMAGE_HOSTS = [
  'https://private-user-images.githubusercontent.com',
  'https://user-images.githubusercontent.com',
  'https://camo.githubusercontent.com',
];

/** Avatar of a GitHub login, `px` CSS pixels square (fetched at twice that for sharp screens). */
export function avatarUrl(login: string, px: number): string {
  return `${AVATAR_HOST}/${encodeURIComponent(login)}?s=${Math.round(px * 2)}`;
}

/** What stands in for a missing avatar (deleted account, image not loaded): the first letter. */
export function avatarInitial(login: string | null): string {
  const c = (login ?? '').trim().charAt(0);
  return c ? c.toUpperCase() : '?';
}
