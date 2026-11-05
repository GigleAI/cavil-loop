// UI tests only (built in with `scripts/build.mjs --test-bridge`, never in the
// app): the window reaches the real back end — the same Rust code, run as the
// test harness — through a loopback HTTP bridge the test starts
// (test/e2e/bridge.ts). The page is served by that bridge, so `/call` is same-origin.

import type { Backend } from './backend';

export function bridgeBackend(): Backend {
  return {
    async call(cmd, args = {}) {
      const res = await fetch('/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, args }) });
      const body = (await res.json()) as { ok?: unknown; err?: string };
      if ('err' in body) throw new Error(body.err);
      return body.ok as any;
    },
  };
}
