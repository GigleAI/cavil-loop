// Run in a separate Node process by test/unit/subprocess-unhandled.test.ts
// (bundled with esbuild). Reproduces the review finding of 2026-11-05: a
// refresh succeeds at GitHub, the keychain refuses to store the new
// credential. The caller catches whatever start() throws; afterwards the
// process must not see any unhandled rejection.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../../src/main/controller';
import { Cache } from '../../src/data/cache';
import { encodeGrant } from '../../src/data/grant';
import type { CredentialStore } from '../../src/platform/credentials';
import { createHash } from 'node:crypto';

const unhandled: string[] = [];
process.on('unhandledRejection', (r) => unhandled.push(String((r as Error)?.message ?? r)));

const now = Date.parse('2026-11-05T10:00:00Z');
const stored = encodeGrant({
  accessToken: 'ghu_expired000000000000000000000000001',
  refreshToken: 'ghr_valid0000000000000000000000000000001',
  expiresAt: now - 60_000,
  refreshExpiresAt: now + 30 * 86_400_000,
});
const store: CredentialStore = {
  persistent: true,
  get: async () => stored,
  set: async () => {
    throw new Error('keychain write denied');
  },
  clear: async () => {},
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchImpl = async (url: string, init?: RequestInit) => {
  if (url.endsWith('/login/oauth/access_token')) {
    return json({ access_token: 'ghu_new0000000000000000000000000000001', refresh_token: 'ghr_new000000000000000000000000000001', expires_in: 28800, refresh_token_expires_in: 15897600 });
  }
  if (url.endsWith('/graphql')) return json({ data: { viewer: { login: 'user-1' } } });
  void init;
  return json([]);
};

const cache = new Cache(join(mkdtempSync(join(tmpdir(), 'cavil-driver-')), 'cache.sqlite'));
// a profile that signed in with this credential (what a completed sign-in records)
cache.setSetting('trustedCredentials', [createHash('sha256').update('ghu_expired000000000000000000000000001').digest('hex')]);
const c = new Controller({
  credentials: store,
  endpoints: { api: 'http://127.0.0.1:9/api', web: 'http://127.0.0.1:9/web' },
  cache,
  fetch: fetchImpl,
  now: () => now,
  openExternal: async () => {},
  defaultClientId: 'Iv1.test',
});
await c.start().catch((e: Error) => console.log('CALLER_CAUGHT', e.message));
console.log('AFTER_START', c.getState().phase, JSON.stringify(c.getState().sync.problem));
await c.syncNow().catch((e: Error) => console.log('CALLER_CAUGHT', e.message));
await new Promise((r) => setTimeout(r, 50));
console.log('UNHANDLED', JSON.stringify(unhandled));
cache.close();
process.exit(unhandled.length ? 3 : 0);
