// Run in a separate Node process by test/unit/subprocess-unhandled.test.ts
// (bundled with esbuild). Reproduces the review finding of 2026-11-05: a
// refresh succeeds at GitHub, the keychain refuses to store the new
// credential. The caller catches whatever start() throws; afterwards the
// process must not see any unhandled rejection.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { encodeGrant } from '../support/grant';
import type { CredentialStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
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
// a tiny GitHub on loopback: the back end (Rust) makes real HTTP requests
const server = createServer((req, res) => {
  const json = (b: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(b));
  };
  req.resume();
  req.on('end', () => {
    const url = req.url ?? '';
    if (url.endsWith('/login/oauth/access_token')) {
      return json({ access_token: 'ghu_new0000000000000000000000000000001', refresh_token: 'ghr_new000000000000000000000000000001', expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (url.endsWith('/graphql')) return json({ data: { viewer: { login: 'user-1' } } });
    return json([]);
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const endpoints = { api: `http://127.0.0.1:${port}/api`, web: `http://127.0.0.1:${port}/web` };

const db = join(mkdtempSync(join(tmpdir(), 'cavil-driver-')), 'cache.sqlite');
const cache = new Cache(db);
// a profile that signed in with this credential (what a completed sign-in records)
cache.setSetting('trustedCredentials', [createHash('sha256').update('ghu_expired000000000000000000000000001').digest('hex')]);
const backend = new HarnessBackend({ db, endpoints, credentials: store, now: () => now });
const c = await Controller.create({ backend, endpoints, now: () => now, defaultClientId: 'Ov23litestclient0000' });
await c.start().catch((e: Error) => console.log('CALLER_CAUGHT', e.message));
console.log('AFTER_START', c.getState().phase, JSON.stringify(c.getState().sync.problem));
await c.syncNow().catch((e: Error) => console.log('CALLER_CAUGHT', e.message));
await new Promise((r) => setTimeout(r, 50));
console.log('UNHANDLED', JSON.stringify(unhandled));
cache.close();
await backend.close();
process.exit(unhandled.length ? 3 : 0);
