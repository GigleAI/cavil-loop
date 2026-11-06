// People's avatars (GitHub#155). GitHub serves every avatar from one host,
// avatars.githubusercontent.com (github.com/<login>.png only redirects
// there). The maintainer allowed this one host for avatars — the client still
// talks to github.com / api.github.com for everything else; GitHub's image
// proxy and attachment hosts stay blocked. One function builds the address
// for the board, the table and the detail view alike.

export const AVATAR_HOST = 'https://avatars.githubusercontent.com';

/** Avatar of a GitHub login, `px` CSS pixels square (fetched at twice that for sharp screens). */
export function avatarUrl(login: string, px: number): string {
  return `${AVATAR_HOST}/${encodeURIComponent(login)}?s=${Math.round(px * 2)}`;
}

/** What stands in for a missing avatar (deleted account, image not loaded): the first letter. */
export function avatarInitial(login: string | null): string {
  const c = (login ?? '').trim().charAt(0);
  return c ? c.toUpperCase() : '?';
}
