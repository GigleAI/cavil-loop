// GitHub#473: the local daemon's back-end messages in Chinese / English. The real back end (Rust,
// child process) runs the daemon's real scripts in a fake HOME (test/support/daemon-world.ts):
// told English with `setLanguage`, its own words come back in English, and whatever came from
// outside (the scripts' output, a project name from this machine) travels as a marked part of the
// message, exactly as written. Without the setting, every text reads as it did before.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { daemonEnv, daemonWorld, dropWorlds, installByHand, pathFor, type DaemonWorld } from '../support/daemon-world';
import { tempDir } from './helpers';
import { readSaid, saidText, type Said } from '../../src/shared/i18n';

const open: HarnessBackend[] = [];
let w: DaemonWorld;

beforeEach(() => {
  w = daemonWorld(tempDir());
}, 30_000);
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
  dropWorlds();
}, 60_000);

async function backend(lang: 'zh' | 'en' | null) {
  const b = new HarnessBackend({
    db: join(w.dir, `cache-${open.length}.sqlite`),
    endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
    credentials: new MemoryStore(),
    env: daemonEnv(w, { os: 'Linux', path: pathFor(w) }),
  });
  open.push(b);
  if (lang) await b.call('setLanguage', { lang });
  return b;
}

/** the message's Said: present, well-formed, and the same text as the plain string next to it */
function said(r: any, key: string): Said {
  const s = readSaid(r[`${key}Said`]);
  expect(s, `${key}Said of ${JSON.stringify(r)}`).not.toBeNull();
  expect(saidText(s!)).toBe(r[key]);
  return s!;
}

const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

describe('the local daemon in English (GitHub#473)', () => {
  it('a refusal: the explanation in English, the project name from this machine as a marked part', async () => {
    installByHand(w);
    const r = await (await backend('en')).call<any>('daemonService', { key: '项目甲', action: 'stop' });
    // not a valid key: the client's own words only
    expect(r).toMatchObject({ result: 'refused', output: 'Invalid project name' });
    const r2 = await (await backend('en')).call<any>('daemonService', { key: 'nosuch', action: 'stop' });
    expect(r2.result).toBe('refused');
    expect(r2.output).toBe('No project nosuch is connected on this computer');
    expect(said(r2, 'output').parts).toEqual([{ name: 'key', text: 'nosuch', from: 'user' }]);
  });

  it("the status script failing: the explanation in English, the script's own Chinese words as written, marked as the daemon's", async () => {
    installByHand(w);
    writeFileSync(join(w.skill, 'scripts', 'install-status.sh'), '#!/usr/bin/env bash\necho "状态坏了 boom" >&2\nexit 5\n');
    const s = await (await backend('en')).call<any>('daemonStatus');
    expect(s.state).toBe('unreadable');
    expect(s.reason).toBe('The status script (exit code 5): 状态坏了 boom');
    const parts = said(s, 'reason').parts;
    expect(parts).toEqual([{ name: 'out_e', text: '状态坏了 boom', from: 'daemon' }]);
    // the Chinese is only in the outside part
    expect(CJK.test(said(s, 'reason').template)).toBe(false);
  });

  it("the project-config script's reason stays as it wrote it; the client's words around it are English", async () => {
    installByHand(w);
    const r = await (await backend('en')).call<any>('daemonConfigGet', { key: 'nosuch' });
    expect(r.result).toBe('not_found');
    const s = said(r, 'output');
    // all of it is the script's: no words of the client's own around it
    expect(s.template).toBe('{e}');
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0].from).toBe('daemon');
    expect(s.parts[0].text).toContain('本机没有接入项目 nosuch');
    // a refusal of the client's own, in English, with nothing from outside
    const bad = await (await backend('en')).call<any>('daemonConfigSet', { key: 'nosuch', rev: 'x', values: { A: '1' } });
    expect(bad).toMatchObject({ result: 'refused', output: 'Invalid fingerprint: read the config again first' });
    expect(said(bad, 'output').parts).toEqual([]);
  });

  it('the same in Chinese (told, and never told) reads exactly as before the language work', async () => {
    installByHand(w);
    for (const lang of ['zh', null] as const) {
      const b = await backend(lang);
      const r = await b.call<any>('daemonService', { key: 'nosuch', action: 'stop' });
      expect(r.output).toBe('本机没有接入项目 nosuch');
      expect(said(r, 'output').template).toBe('本机没有接入项目 {key}');
      const bad = await b.call<any>('daemonConfigSet', { key: 'nosuch', rev: 'x', values: { A: '1' } });
      expect(bad.output).toBe('指纹不合规：先重新读取配置');
    }
    writeFileSync(join(w.skill, 'scripts', 'install-status.sh'), '#!/usr/bin/env bash\necho "boom" >&2\nexit 5\n');
    const s = await (await backend(null)).call<any>('daemonStatus');
    expect(s.reason).toBe('状态脚本退出码 5：boom');
  });
});
