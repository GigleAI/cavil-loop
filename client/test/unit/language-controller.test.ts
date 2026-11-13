// GitHub#471: the interface language as the controller keeps it — read before the first screen,
// changed at once, kept across a restart, passed on to the back end — with the real back end
// (Rust, as a child process) on a real SQLite file. The window's half is test/e2e/i18n.spec.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import type { Backend } from '../../src/backend/backend';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { getLang, setLang, t } from '../../src/shared/i18n';
import { FIXTURE_NOW, tempDir } from './helpers';

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

async function make(opts: { seed?: Record<string, unknown>; languages?: () => readonly string[] } = {}) {
  await Promise.all(controllers.map((c) => c.settled()));
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  for (const [k, v] of Object.entries(opts.seed ?? {})) cache.setSetting(k, v);
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials: new FileStore(join(dir, 'cred')), now: () => FIXTURE_NOW, opened: [] });
  backends.push(backend);
  const calls: { cmd: string; args: unknown }[] = [];
  const recorded: Backend = {
    call: (cmd, args) => {
      calls.push({ cmd, args });
      return backend.call(cmd, args);
    },
  };
  const c = await Controller.create({ backend: recorded, endpoints, now: () => FIXTURE_NOW, defaultClientId: '', ...(opts.languages ? { languages: opts.languages } : {}) });
  controllers.push(c);
  return { c, cache, calls, backend };
}

/** the back end's own words: its refusal of a language it does not know is worded in the language it is in */
async function backendSays(b: HarnessBackend): Promise<string> {
  try {
    await b.call('setLanguage', { lang: 'fr' });
    return 'accepted';
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  controllers = [];
  backends = [];
  caches = [];
  await fake.close();
  setLang('zh');
});

describe('the interface language', () => {
  it('nothing set: Chinese, as before — whatever the system says — and the back end is not even told', async () => {
    const { c, calls, backend } = await make({ languages: () => ['en-US'] });
    expect(c.getState().uiLanguage).toBe('zh');
    expect(c.getState().lang).toBe('zh');
    expect(getLang()).toBe('zh');
    expect(t('刷新')).toBe('刷新');
    await c.settled();
    expect(calls.filter((x) => x.cmd === 'setLanguage')).toEqual([]);
    expect(await backendSays(backend)).toBe('不认识的语言：fr');
  });

  it('English: at once (state, t(), the back end), kept across a restart, and the back end of the restarted app is told before anything else is shown', async () => {
    const first = await make();
    first.c.setUiLanguage('en');
    expect(first.c.getState()).toMatchObject({ uiLanguage: 'en', lang: 'en' });
    expect(t('刷新')).toBe('Refresh');
    await first.c.settled();
    expect(first.calls.filter((x) => x.cmd === 'setLanguage').map((x) => x.args)).toEqual([{ lang: 'en' }]);
    expect(await backendSays(first.backend)).toBe('Unknown language: fr');

    setLang('zh'); // a fresh window starts from nothing
    const second = await make();
    expect(second.c.getState()).toMatchObject({ uiLanguage: 'en', lang: 'en' });
    expect(getLang()).toBe('en');
    await second.c.settled();
    expect(second.calls.filter((x) => x.cmd === 'setLanguage').map((x) => x.args)).toEqual([{ lang: 'en' }]);
    expect(await backendSays(second.backend)).toBe('Unknown language: fr');

    // back to Chinese: the back end follows
    second.c.setUiLanguage('zh');
    await second.c.settled();
    expect(second.c.getState()).toMatchObject({ uiLanguage: 'zh', lang: 'zh' });
    expect(await backendSays(second.backend)).toBe('不认识的语言：fr');
    const third = await make();
    expect(third.c.getState()).toMatchObject({ uiLanguage: 'zh', lang: 'zh' });
  });

  it('follow the system: the system decides, the choice itself ("auto") is what is kept', async () => {
    for (const [langs, want] of [
      [['zh-CN'], 'zh'],
      [['zh-TW'], 'zh'],
      [['en-US'], 'en'],
      [['ja-JP'], 'en'],
      [[], 'zh'],
    ] as const) {
      setLang('zh');
      const { c, cache } = await make({ seed: { uiLanguage: 'auto' }, languages: () => langs });
      expect(c.getState(), JSON.stringify(langs)).toMatchObject({ uiLanguage: 'auto', lang: want });
      expect(getLang()).toBe(want);
      expect(cache.getSetting('uiLanguage', null)).toBe('auto');
    }
    // a system that cannot be read is Chinese
    setLang('zh');
    const broken = await make({
      seed: { uiLanguage: 'auto' },
      languages: () => {
        throw new Error('no navigator');
      },
    });
    expect(broken.c.getState().lang).toBe('zh');
  });

  it('switching to "follow the system" from English on a Chinese system goes back to Chinese and keeps "auto"', async () => {
    const { c, backend } = await make({ seed: { uiLanguage: 'en' }, languages: () => ['zh-CN'] });
    expect(c.getState().lang).toBe('en');
    c.setUiLanguage('auto');
    await c.settled();
    expect(c.getState()).toMatchObject({ uiLanguage: 'auto', lang: 'zh' });
    expect(await backendSays(backend)).toBe('不认识的语言：fr');
    const again = await make({ languages: () => ['zh-CN'] });
    expect(again.c.getState().uiLanguage).toBe('auto');
  });

  it('a saved value this version does not know reads as Chinese; a value the window does not offer is ignored', async () => {
    for (const v of ['EN', 'fr', 1, null, {}, ['en']]) {
      setLang('zh');
      const { c } = await make({ seed: { uiLanguage: v }, languages: () => ['en-US'] });
      expect(c.getState(), JSON.stringify(v)).toMatchObject({ uiLanguage: 'zh', lang: 'zh' });
    }
    dir = tempDir(); // a profile with nothing set
    const { c, cache } = await make();
    for (const v of ['fr', 'EN', 1, null]) c.setUiLanguage(v);
    await c.settled();
    expect(c.getState()).toMatchObject({ uiLanguage: 'zh', lang: 'zh' });
    expect(cache.getSetting('uiLanguage', 'untouched')).toBe('untouched');
  });

  it('the back end refuses anything but the two words, and stays as it was', async () => {
    const { backend } = await make();
    await backend.call('setLanguage', { lang: 'en' });
    for (const bad of [{ lang: 'auto' }, { lang: 'EN' }, {}, { lang: 1 }]) await expect(backend.call('setLanguage', bad)).rejects.toThrow();
    expect(await backendSays(backend)).toBe('Unknown language: fr');
  });
});
