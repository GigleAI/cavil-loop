// GitHub#473 (sub-issue ③ of #466): the remote daemon area in English — the real back end (Rust,
// child process) against the daemon's real remote-access service behind the stand-in for
// Tailscale's HTTPS forwarding, the same world test/unit/remote.test.ts uses. What the back end
// says is in the window's language; what came from outside (the other machine's words, the local
// script's output, the machine name the person typed) arrives as marked parts, exactly as it was
// — and the Chinese text reads word for word as before.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, pathFor, type DaemonWorld } from '../support/daemon-world';
import { BOX, closeRemote, installFakeTailscale, pairCode, remoteWorld, setHosts, type RemoteWorld } from '../support/remote-world';
import { readSaid, saidText, type Said } from '../../src/shared/i18n';
import { tempDir } from './helpers';

const ID = `${BOX}:47387`;
const open: HarnessBackend[] = [];
let w: DaemonWorld;
let r: RemoteWorld;
let path: string;
let snapshot: string;

beforeAll(() => {
  w = daemonWorld(tempDir());
  installFakeTailscale(w);
  installByHand(w);
  path = pathFor(w);
  connect(w, 'widget', 'Linux', path);
  snapshot = `${w.dir}.tar`;
  execFileSync('tar', ['-cf', snapshot, '-C', w.dir, '.']);
}, 60_000);
afterAll(() => {
  dropWorlds();
  if (snapshot) rmSync(snapshot, { force: true });
});
beforeEach(async () => {
  execFileSync('bash', ['-c', 'rm -rf "$1" && mkdir -p "$1" && tar -xf "$2" -C "$1"', '_', w.dir, snapshot]);
  r = await remoteWorld(w, path);
}, 60_000);
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
  await closeRemote(r);
});

function backend(local = false) {
  const b = new HarnessBackend({
    db: join(w.dir, `cache-${open.length}.sqlite`),
    endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
    credentials: new MemoryStore(),
    env: { ...(local ? daemonEnv(w, { os: 'Linux', path, extra: { FAKE_TS: r.ts } }) : {}), ...r.env },
  });
  open.push(b);
  return b;
}

/** the marked form, checked to read exactly as the plain string next to it */
function marked(text: string, raw: unknown): Said {
  const s = readSaid(raw);
  expect(s, 'a marked form came with the message').not.toBeNull();
  expect(saidText(s!)).toBe(text);
  return s!;
}

describe('remote daemon: the back end speaks the window’s language, outside words travel marked and unchanged', () => {
  it('a wrong pairing code: the other machine’s words as written, around them English — and the Chinese as before', async () => {
    const zh = backend();
    const code = pairCode(w, r);
    const wrong = String((Number(code) + 1) % 100000000).padStart(8, '0');
    const a = await zh.call('remotePair', { host: BOX, code: wrong });
    expect(a).toMatchObject({ result: 'refused', reason: 'pairing_wrong' });
    expect(a.output.startsWith('那台机器的回答：')).toBe(true);
    const sa = marked(a.output, a.outputSaid);
    expect(sa.template).toBe('那台机器的回答：{m}');
    expect(sa.parts).toHaveLength(1);
    expect(sa.parts[0].from).toBe('remote');
    const theirs = sa.parts[0].text;
    expect(theirs).toContain('配对码不对');
    expect(a.output).toBe(`那台机器的回答：${theirs}`);

    const en = backend();
    await en.call('setLanguage', { lang: 'en' });
    const b = await en.call('remotePair', { host: BOX, code: wrong });
    expect(b).toMatchObject({ result: 'refused', reason: 'pairing_wrong' });
    const sb = marked(b.output, b.outputSaid);
    expect(sb.template).toBe('That machine answered: {m}');
    // the machine's own words are not translated, not touched
    expect(sb.parts).toEqual([{ name: 'm', text: theirs, from: 'remote' }]);
    // the back end's own refusals have no outside part at all
    const exists = await en.call('remotePair', { host: 'x.tailnet.ts.net', code: '1234' });
    expect(exists).toMatchObject({ result: 'refused', reason: 'bad_code', output: 'The pairing code is 8 digits' });
    expect(readSaid(exists.outputSaid)).toEqual({ template: 'The pairing code is 8 digits', parts: [] });
  });

  it('off Tailscale: the explanation is English, the name the person gave stays marked as theirs; nothing was sent either way', async () => {
    const b = backend();
    expect(await b.call('remotePair', { host: BOX, code: pairCode(w, r) })).toMatchObject({ result: 'paired' });
    setHosts(r, {});
    const zh = await b.call('remoteStatus', { id: ID });
    expect(zh).toMatchObject({ state: 'not_tailscale' });
    expect(zh.message).toBe(`无法确认这条连接经过 Tailscale：${BOX} 解析不出地址。请确认这台电脑的 Tailscale 已连上。没有发出任何内容`);
    marked(zh.message, zh.messageSaid);

    await b.call('setLanguage', { lang: 'en' });
    const en = await b.call('remoteStatus', { id: ID });
    expect(en.message).toBe(`Could not confirm that this connection goes over Tailscale: ${BOX} does not resolve to an address. Check that Tailscale is connected on this computer. Nothing was sent`);
    const s = marked(en.message, en.messageSaid);
    expect(s.parts).toEqual([{ name: 'm_host', text: BOX, from: 'user' }]);
    // the same in the refusals of an action
    const stop = await b.call('remoteService', { id: ID, key: 'widget', action: 'stop' });
    expect(stop).toMatchObject({ result: 'refused', reason: 'not_tailscale', output: en.message });
    marked(stop.output, stop.outputSaid);
    const unpair = await b.call('remoteUnpair', { id: ID, localOnly: false });
    expect(unpair.result).toBe('unconfirmed');
    expect(unpair.output).toBe(en.message);
  });

  it('this machine’s pairing code it cannot read: the client’s words in English, the script’s output marked as the daemon’s and unchanged', async () => {
    // the same wrapper remote.test.ts uses: the real script, its CODE= line spoiled
    const dir = join(w.skill, 'scripts');
    execFileSync('mv', [join(dir, 'remote-access.sh'), join(dir, 'remote-access.real.sh')]);
    writeFileSync(
      join(dir, 'remote-access.sh'),
      `#!/usr/bin/env bash
d="$(cd "$(dirname "$0")" && pwd)"
case "$1" in
  pair) bash "$d/remote-access.real.sh" "$@" | grep -v '^RESULT='; echo CODE=12ab; echo RESULT=code ;;
  *) exec bash "$d/remote-access.real.sh" "$@" ;;
esac
`,
    );
    const b = backend(true);
    expect(await b.call('remoteHost', { action: 'enable' })).toMatchObject({ result: 'enabled' });
    const zh = await b.call('remoteHost', { action: 'code' });
    expect(zh.result).toBe('failed');
    expect(zh.output.startsWith('配对码的格式认不出，已作废，请再生成一次。脚本输出：\n')).toBe(true);
    const sz = marked(zh.output, zh.outputSaid);
    expect(sz.parts.map((p) => p.from)).toEqual(['daemon']);
    const script = sz.parts[0].text;
    expect(script).toContain('CODE=12ab');

    await b.call('setLanguage', { lang: 'en' });
    const en = await b.call('remoteHost', { action: 'code' });
    expect(en.result).toBe('failed');
    const se = marked(en.output, en.outputSaid);
    expect(se.template).toBe('The pairing code has a shape this client does not recognise; it was voided — make a new one. Script output:\n{text_e}');
    expect(se.parts).toHaveLength(1);
    expect(se.parts[0]).toMatchObject({ name: 'text_e', from: 'daemon' });
    expect(se.parts[0].text).toContain('CODE=12ab');
    // the status the switch reads: the script's own output, marked, the same in both languages
    const st = await b.call('remoteHost', { action: 'status' });
    expect(st.state).toBe('open');
    expect(readSaid(st.outputSaid)).toEqual({ template: '{e}', parts: [{ name: 'e', text: st.output, from: 'daemon' }] });
  });

  it('an unreadable Tailscale state: English around Tailscale’s own word', async () => {
    writeFileSync(join(r.ts, 'status.raw'), '{"BackendState":"Stopped","Self":{},"Peer":null}');
    const b = new HarnessBackend({
      db: join(w.dir, 'cache-ts.sqlite'),
      endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
      credentials: new MemoryStore(),
      env: { ...daemonEnv(w, { os: 'Linux', path, extra: { FAKE_TS: r.ts, FAKE_TS_STATUS: 'raw' } }), ...r.env },
    });
    open.push(b);
    const zh = await b.call('remoteTailnet');
    expect(zh).toMatchObject({ result: 'unreadable', output: '这台电脑的 Tailscale 没有连上（状态：Stopped）' });
    await b.call('setLanguage', { lang: 'en' });
    const en = await b.call('remoteTailnet');
    expect(en).toMatchObject({ result: 'unreadable', output: 'Tailscale is not connected on this computer (state: Stopped)' });
    expect(marked(en.output, en.outputSaid).parts).toEqual([{ name: 'state', text: 'Stopped', from: 'system' }]);
  });
});
