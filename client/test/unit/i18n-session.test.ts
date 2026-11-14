// GitHub#473 (sub-issue ③ of #466): what the board's warning bar says when renewing the sign-in
// goes wrong — in English once the window is set to English, GitHub's / the keychain's own words
// kept apart and shown as written; in Chinese word for word as before. Real controller, the real
// back end (Rust) as a child process, fake GitHub over HTTP, real SQLite, a file credential store.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FIXTURE_NOW, tempDir } from './helpers';
import { saidText } from '../../src/shared/i18n';
import type { AppState } from '../../src/shared/types';
import { CJK } from '../i18n/scan';

const HOUR = 3_600_000;
const REPO = 'GigleAI/cavil-loop';

let fake: FakeGitHub;
let dir: string;
const caches: Cache[] = [];
const controllers: Controller[] = [];
const backends: HarnessBackend[] = [];

class FlakyStore extends FileStore {
  failing = false;
  async set(value: string): Promise<void> {
    if (this.failing) throw new Error('钥匙串拒绝写入 (-25308)');
    await super.set(value);
  }
}

async function until(c: Controller, pred: (s: AppState) => boolean, what: string) {
  for (let i = 0; i < 1500; i++) {
    if (pred(c.getState())) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout: ${what}`);
}

async function signInAsApp(store: FileStore, clock: { t: number }) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({
    db: join(dir, 'cache.sqlite'),
    endpoints,
    credentials: store,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((r) => setTimeout(r, 5));
    },
  });
  backends.push(backend);
  const calls: { cmd: string; args: unknown }[] = [];
  const watched = new Proxy(backend, {
    get(target, prop, recv) {
      if (prop === 'call') return (cmd: string, args: unknown) => (calls.push({ cmd, args }), target.call(cmd as never, args as never));
      return Reflect.get(target, prop, recv);
    },
  });
  fake.state.nextGrant = { token: 'ghu_fakeapptoken0000000000000000000001', refreshToken: 'ghr_fakeapprefresh00000000000000000000001', expiresIn: 8 * 3600 };
  const c = await Controller.create({ backend: watched, endpoints, now: () => clock.t, defaultClientId: fake.state.oauthClientId });
  controllers.push(c);
  c.addSource(REPO);
  await c.start();
  c.setAppKind('github-app');
  c.setClientId(fake.state.appClientId);
  const p = c.startLogin();
  await until(c, (s) => s.login.status === 'waiting', 'waiting');
  fake.resolveGrant('approved');
  await p;
  expect(c.getState().phase).toBe('ready');
  return { c, calls };
}

/** the window set to `lang`, and the back end told (the call went out and was answered) */
async function language(h: Awaited<ReturnType<typeof signInAsApp>>, lang: 'zh' | 'en') {
  h.c.setUiLanguage(lang);
  await h.c.settled();
  if (lang === 'en') expect(h.calls.filter((x) => x.cmd === 'setLanguage').map((x) => x.args)).toContainEqual({ lang: 'en' });
}

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stopTimer();
  await Promise.all(backends.splice(0).map((b) => b.close()));
  for (const c of caches.splice(0)) c.close();
  await fake.close();
});

describe('GitHub#473: renewal problems on the board follow the language; the outside words stay as written', () => {
  const REASON = '请稍后再试（GitHub 自己的话）';

  it('a renewal GitHub refuses with its own reason: English around it, the reason exactly as GitHub wrote it', async () => {
    const clock = { t: FIXTURE_NOW };
    const h = await signInAsApp(new FileStore(join(dir, 'cred')), clock);
    await language(h, 'en');
    clock.t += 9 * HOUR;
    fake.state.tokenAnswers.push({ kind: 'refresh', status: 400, body: { error: 'something_new', error_description: REASON } });
    await h.c.syncNow();
    const { problem, problemSaid } = h.c.getState().sync;
    expect(problemSaid).toBeTruthy();
    expect(problemSaid!.template).toMatch(/^Renewing the sign-in did not work \(.*\{e_detail\}\); it is retried next round/);
    expect(CJK.test(problemSaid!.template)).toBe(false);
    expect(problemSaid!.parts).toEqual([{ name: 'e_detail', text: REASON, from: 'github' }]);
    expect(problem).toBe(saidText(problemSaid!));
    expect(problem).toContain(REASON);
  });

  it('the same in Chinese reads exactly as before', async () => {
    const clock = { t: FIXTURE_NOW };
    const h = await signInAsApp(new FileStore(join(dir, 'cred')), clock);
    clock.t += 9 * HOUR;
    fake.state.tokenAnswers.push({ kind: 'refresh', status: 400, body: { error: 'something_new', error_description: REASON } });
    await h.c.syncNow();
    expect(h.c.getState().sync.problem).toBe(`登录续期没有成功（续期失败：${REASON}），会在下一轮自动重试；一直失败的话请退出后重新登录`);
    expect(h.c.getState().sync.problemSaid!.parts).toEqual([{ name: 'e_detail', text: REASON, from: 'github' }]);
  });

  it('a renewed credential the keychain will not save: English around it, the keychain\'s words as written; Chinese as before', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FlakyStore(join(dir, 'cred'));
    const h = await signInAsApp(store, clock);
    await language(h, 'en');
    clock.t += 9 * HOUR;
    store.failing = true;
    await h.c.syncNow();
    const s = h.c.getState().sync;
    expect(s.problemSaid!.template).toMatch(/^The new sign-in credential could not be saved in the keychain \(\{e_e\}\)\. This run works as usual/);
    expect(CJK.test(s.problemSaid!.template)).toBe(false);
    expect(s.problemSaid!.parts).toEqual([{ name: 'e_e', text: '钥匙串拒绝写入 (-25308)', from: 'system' }]);
    expect(s.problem).toBe(saidText(s.problemSaid!));
    // back to Chinese: the next failed save is worded as before, word for word
    await language(h, 'zh');
    await h.c.syncNow();
    expect(h.c.getState().sync.problem).toBe('新的登录凭据没能存进钥匙串（钥匙串拒绝写入 (-25308)）。这次运行照常可用，App 会每轮重试保存；在保存成功前退出 App，下次启动需要重新登录');
    // saved again: the bar goes away with its marked parts
    store.failing = false;
    await h.c.syncNow();
    expect(h.c.getState().sync).toMatchObject({ problem: null, problemSaid: null });
  });
});
