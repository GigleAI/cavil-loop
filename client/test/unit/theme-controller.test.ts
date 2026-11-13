// GitHub#516: light / dark as the controller keeps it — read before the first screen, changed at
// once, kept across a restart, passed on to the back end (the native window), and following the
// system only while "跟随系统" is chosen — with the real back end (Rust, as a child process) on a
// real SQLite file. The window's half is test/e2e/theme.spec.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import type { Backend } from '../../src/backend/backend';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { normalizeThemeSetting, resolveTheme, type SystemScheme } from '../../src/shared/theme';
import { setLang } from '../../src/shared/i18n';
import { FIXTURE_NOW, tempDir } from './helpers';

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

/** a system whose light / dark the test switches; `dark` null = cannot be read */
function fakeSystem(initial: boolean | null) {
  const cbs = new Set<() => void>();
  let dark = initial;
  const scheme: SystemScheme = {
    dark: () => dark,
    watch(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
  return {
    scheme,
    switchTo(d: boolean) {
      dark = d;
      for (const cb of cbs) cb();
    },
    watchers: () => cbs.size,
  };
}

async function make(opts: { seed?: Record<string, unknown>; scheme?: SystemScheme } = {}) {
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
  const c = await Controller.create({ backend: recorded, endpoints, now: () => FIXTURE_NOW, defaultClientId: '', scheme: opts.scheme ?? fakeSystem(false).scheme });
  controllers.push(c);
  const told = () => calls.filter((x) => x.cmd === 'setTheme').map((x) => x.args);
  return { c, cache, told, backend };
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

describe('the rule', () => {
  it('the setting: only system / light / dark; anything else (nothing set, an old or a broken value) follows the system', () => {
    for (const v of ['system', 'light', 'dark'] as const) expect(normalizeThemeSetting(v)).toBe(v);
    for (const v of [undefined, null, '', 'Dark', 'auto', 'zh', 1, true, {}, ['dark']]) expect(normalizeThemeSetting(v), JSON.stringify(v)).toBe('system');
  });

  it('three choices × the system light / dark / unreadable', () => {
    const want = {
      system: { dark: 'dark', light: 'light', unreadable: 'light' },
      light: { dark: 'light', light: 'light', unreadable: 'light' },
      dark: { dark: 'dark', light: 'dark', unreadable: 'dark' },
    } as const;
    for (const setting of ['system', 'light', 'dark'] as const)
      for (const [sys, d] of [['dark', true], ['light', false], ['unreadable', null]] as const) expect(resolveTheme(setting, d), `${setting} on ${sys}`).toBe(want[setting][sys]);
  });
});

describe('light / dark in the controller', () => {
  it('nothing set: follows the system, as before — and the back end (native window) is not even told', async () => {
    for (const d of [false, true]) {
      dir = tempDir();
      const { c, told } = await make({ scheme: fakeSystem(d).scheme });
      expect(c.getState()).toMatchObject({ uiTheme: 'system', theme: d ? 'dark' : 'light' });
      await c.settled();
      expect(told()).toEqual([]);
    }
  });

  it('dark on a light system: at once, the back end is told, kept across a restart, and the restarted back end is told again', async () => {
    const first = await make();
    first.c.setUiTheme('dark');
    expect(first.c.getState()).toMatchObject({ uiTheme: 'dark', theme: 'dark' });
    await first.c.settled();
    expect(first.told()).toEqual([{ theme: 'dark' }]);
    expect(first.cache.getSetting('uiTheme', null)).toBe('dark');

    const second = await make();
    expect(second.c.getState()).toMatchObject({ uiTheme: 'dark', theme: 'dark' });
    await second.c.settled();
    expect(second.told()).toEqual([{ theme: 'dark' }]);

    // back to following the system: the native window is handed back to it
    second.c.setUiTheme('system');
    expect(second.c.getState()).toMatchObject({ uiTheme: 'system', theme: 'light' });
    await second.c.settled();
    expect(second.told()).toEqual([{ theme: 'dark' }, { theme: 'system' }]);
    const third = await make();
    expect(third.c.getState()).toMatchObject({ uiTheme: 'system', theme: 'light' });
    await third.c.settled();
    expect(third.told()).toEqual([]);
  });

  it('light on a dark system shows light', async () => {
    const { c } = await make({ seed: { uiTheme: 'light' }, scheme: fakeSystem(true).scheme });
    expect(c.getState()).toMatchObject({ uiTheme: 'light', theme: 'light' });
  });

  it('only "跟随系统" follows the system switching while the window is open', async () => {
    const sys = fakeSystem(false);
    const { c } = await make({ scheme: sys.scheme });
    expect(sys.watchers()).toBe(1);
    const seen: string[] = [];
    c.onChange((s) => seen.push(s.theme));
    sys.switchTo(true);
    expect(c.getState().theme).toBe('dark');
    sys.switchTo(false);
    expect(c.getState().theme).toBe('light');
    expect(seen).toEqual(['dark', 'light']);

    c.setUiTheme('light');
    sys.switchTo(true);
    expect(c.getState()).toMatchObject({ uiTheme: 'light', theme: 'light' });
    c.setUiTheme('dark');
    sys.switchTo(false);
    expect(c.getState()).toMatchObject({ uiTheme: 'dark', theme: 'dark' });
    // and back to following: the system's current look at once
    c.setUiTheme('system');
    expect(c.getState()).toMatchObject({ uiTheme: 'system', theme: 'light' });
  });

  it('a system that cannot be read is light; one that cannot be watched keeps what it showed', async () => {
    const unreadable = await make({
      scheme: {
        dark: () => {
          throw new Error('no media query');
        },
        watch: () => {
          throw new Error('no media query');
        },
      },
    });
    expect(unreadable.c.getState()).toMatchObject({ uiTheme: 'system', theme: 'light' });
    unreadable.c.setUiTheme('dark');
    expect(unreadable.c.getState().theme).toBe('dark');
  });

  it('a saved value this version does not know follows the system; a value the window does not offer is ignored', async () => {
    for (const v of ['Dark', 'auto', 1, null, {}, ['dark']]) {
      dir = tempDir();
      const { c } = await make({ seed: { uiTheme: v }, scheme: fakeSystem(true).scheme });
      expect(c.getState(), JSON.stringify(v)).toMatchObject({ uiTheme: 'system', theme: 'dark' });
    }
    dir = tempDir();
    const { c, cache, told } = await make();
    for (const v of ['Dark', 'auto', 1, null, undefined]) c.setUiTheme(v);
    // choosing what is already chosen writes nothing
    c.setUiTheme('system');
    await c.settled();
    expect(c.getState()).toMatchObject({ uiTheme: 'system', theme: 'light' });
    expect(cache.getSetting('uiTheme', 'untouched')).toBe('untouched');
    expect(told()).toEqual([]);
  });

  it('the back end accepts the three words and refuses anything else, in the window\'s language', async () => {
    const { backend } = await make();
    for (const theme of ['system', 'light', 'dark']) await expect(backend.call('setTheme', { theme })).resolves.toBeNull();
    for (const bad of [{ theme: 'auto' }, { theme: 'Dark' }, {}, { theme: 1 }]) await expect(backend.call('setTheme', bad)).rejects.toThrow();
    await expect(backend.call('setTheme', { theme: 'auto' })).rejects.toThrow('不认识的外观：auto');
    await backend.call('setLanguage', { lang: 'en' });
    await expect(backend.call('setTheme', { theme: 'auto' })).rejects.toThrow('Unknown appearance: auto');
  });
});
