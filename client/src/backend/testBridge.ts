// UI tests only (built in with `scripts/build.mjs --test-bridge`, never in the
// app): the window reaches the real back end — the same Rust code, run as the
// test harness — through a loopback HTTP bridge the test starts
// (test/e2e/bridge.ts). The page is served by that bridge, so `/call` is same-origin.
// The desktop side (notifications, badge, sync beat) is the test's: `/desktop`.

import type { Backend } from './backend';
import type { Desktop } from '../app/desktop';

async function post(path: string, payload: unknown): Promise<any> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = (await res.json()) as { ok?: unknown; err?: string };
  if ('err' in body) throw new Error(body.err);
  return body.ok as any;
}

export function bridgeBackend(): Backend {
  return {
    call: (cmd, args = {}) => post('/call', { cmd, args }),
  };
}

export function bridgeDesktop(): Desktop {
  const d = (op: string, args: Record<string, unknown> = {}) => post('/desktop', { op, args });
  return {
    notify: (alert) => d('notify', { alert }),
    setBadge: (count) => d('badge', { count }),
    clearNotifications: () => d('clearNotifications'),
    loginItem: () => d('loginItem'),
    setLoginItem: (on) => d('setLoginItem', { on }),
    nextEvent: () => d('nextEvent'),
    updateStatus: () => d('updateStatus'),
    checkUpdate: () => d('checkUpdate'),
    setAutoUpdate: (on) => d('setAutoUpdate', { on }),
    setUpdateChannel: (channel) => d('setUpdateChannel', { channel }),
    dismissUpdate: (version) => d('dismissUpdate', { version }),
    dismissInstalledUpdate: (version) => d('dismissInstalledUpdate', { version }),
    restartToUpdate: () => d('restartToUpdate'),
    closeWindow: () => d('closeWindow'),
  };
}
