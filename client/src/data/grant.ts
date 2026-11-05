// What a sign-in gives us, and how it is kept in the credential store.
//
// An OAuth App token (gho_…) never expires: only `accessToken` is set.
// A GitHub App user token (ghu_…) expires (8 h) and comes with a refresh token
// (ghr_…, ~6 months) that GitHub *rotates* on every refresh — the old one stops
// working, so a refresh must never run twice with the same refresh token.

export interface TokenGrant {
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms; null = does not expire */
  expiresAt: number | null;
  /** epoch ms; null = unknown / does not expire */
  refreshExpiresAt: number | null;
}

const PIECE = /^[A-Za-z0-9_]+$/;

/** Stored form: a bare token (OAuth App, and every credential saved before refresh support) or `v2:access:refresh:exp:refreshExp`. */
export function encodeGrant(g: TokenGrant): string {
  if (!g.refreshToken) return g.accessToken;
  return ['v2', g.accessToken, g.refreshToken, String(g.expiresAt ?? 0), String(g.refreshExpiresAt ?? 0)].join(':');
}

export function decodeGrant(stored: string | null): TokenGrant | null {
  if (!stored) return null;
  const s = stored.trim();
  if (!s.startsWith('v2:')) return PIECE.test(s) ? { accessToken: s, refreshToken: null, expiresAt: null, refreshExpiresAt: null } : null;
  const [, access, refresh, exp, rexp] = s.split(':');
  if (!access || !refresh || !PIECE.test(access) || !PIECE.test(refresh)) return null;
  const n = (x: string | undefined) => (x && /^\d+$/.test(x) && Number(x) > 0 ? Number(x) : null);
  return { accessToken: access, refreshToken: refresh, expiresAt: n(exp), refreshExpiresAt: n(rexp) };
}

/** Parse GitHub's token response (device flow or refresh). */
export function grantFromResponse(body: Record<string, unknown>, now: number): TokenGrant | null {
  const access = body.access_token;
  if (typeof access !== 'string' || !access) return null;
  const refresh = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null;
  const secs = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v) : null);
  const exp = secs(body.expires_in);
  const rexp = secs(body.refresh_token_expires_in);
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: refresh && exp ? now + exp * 1000 : null,
    refreshExpiresAt: refresh && rexp ? now + rexp * 1000 : null,
  };
}
