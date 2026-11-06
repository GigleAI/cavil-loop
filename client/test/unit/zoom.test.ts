// Page zoom (GitHub#155): ⌘+ / ⌘- / ⌘0 step through fixed levels and the
// level outlives a restart. The real back end (Rust, child process) on a real
// SQLite file; a second process on the same file reads what the first kept.
// (Turning the level into the webview's zoom is the app shell's one call to
// `set_zoom`, checked on a Mac by hand — see the PR.)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { tempDir } from './helpers';

let fake: FakeGitHub;
let dir: string;
const open: HarnessBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
  await fake.close();
});

function backend() {
  const b = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints: { api: fake.api, web: fake.web }, credentials: new FileStore(join(dir, 'cred')) });
  open.push(b);
  return b;
}

const step = async (b: HarnessBackend, s: string) => ((await b.call('zoom', { step: s })) as { percent: number }).percent;

describe('page zoom (GitHub#155)', () => {
  it('steps through the levels, stops at both ends, ⌘0 goes back to 100%', async () => {
    const b = backend();
    expect(await step(b, 'get')).toBe(100);
    const up: number[] = [];
    for (let i = 0; i < 7; i++) up.push(await step(b, 'in'));
    expect(up).toEqual([110, 125, 150, 175, 200, 200, 200]);
    expect(await step(b, 'reset')).toBe(100);
    const down: number[] = [];
    for (let i = 0; i < 7; i++) down.push(await step(b, 'out'));
    expect(down).toEqual([90, 80, 75, 67, 50, 50, 50]);
    await expect(b.call('zoom', { step: 'sideways' })).rejects.toThrow(/未知的缩放/);
  });

  it('the level is kept: a restart on the same files comes back at it', async () => {
    const first = backend();
    await step(first, 'in');
    await step(first, 'in');
    await first.close();
    open.splice(0);
    const second = backend();
    expect(await step(second, 'get')).toBe(125);
    expect(await step(second, 'out')).toBe(110);
  });

  it('a kept value that is not one of the levels reads as 100%', async () => {
    const first = backend();
    await step(first, 'in');
    await first.close();
    open.splice(0);
    const db = new DatabaseSync(join(dir, 'cache.sqlite'));
    db.prepare("UPDATE setting SET v = '333' WHERE k = 'zoomPercent'").run();
    db.close();
    const second = backend();
    expect(await step(second, 'get')).toBe(100);
    expect(await step(second, 'in')).toBe(110);
  });
});
