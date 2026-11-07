// The update manifest the release job publishes (GitHub#184, scripts/update-manifest.mjs), on real
// keys and signatures made by Tauri's own signer (the CLI the release job uses). Every verdict on
// a signature is cross-checked against minisign-verify — the library Tauri's updater plugin checks
// update packages with — run in the test harness on the same bytes (`test.update.verify`).

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_PLATFORMS, build, keyId, packageName, verifySignature } from '../../scripts/update-manifest.mjs';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauri = join(root, 'node_modules', '.bin', 'tauri');

function key(dir: string, name: string) {
  const f = join(dir, name);
  execFileSync(tauri, ['signer', 'generate', '--ci', '-p', '', '-w', f], { stdio: 'ignore' });
  return { priv: f, pub: readFileSync(`${f}.pub`, 'utf8').trim() };
}

function pack(dir: string, version: string, arch: string, priv: string, signAs = version) {
  const f = join(dir, packageName(version, arch));
  writeFileSync(f, `package ${version} ${arch} `.repeat(200));
  execFileSync(tauri, ['signer', 'sign', '-f', priv, '-p', '', '--app-version', signAs, f], { stdio: 'ignore' });
  return { file: f, sig: `${f}.sig` };
}

let harness: HarnessBackend | null = null;
afterAll(async () => harness?.close());
/** the update plugin's own check (minisign-verify, in the Rust harness) */
async function pluginSays(data: Buffer, signature: string, pubkey: string): Promise<boolean> {
  if (!harness) {
    const d = tempDir();
    harness = new HarnessBackend({ db: join(d, 'c.sqlite'), endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' }, credentials: new FileStore(join(d, 'cred')) });
  }
  const r = (await harness.call('test.update.verify', { data: data.toString('base64'), signature, pubkey })) as { ok: boolean };
  return r.ok;
}

/** a .sig with one byte of its base64 layer-2 line changed (after the key id) */
function flipSignatureByte(sigB64: string, line: 1 | 3, at: number): string {
  const lines = Buffer.from(sigB64, 'base64').toString('utf8').split('\n');
  const raw = Buffer.from(lines[line], 'base64');
  raw[at] ^= 0x01;
  lines[line] = raw.toString('base64');
  return Buffer.from(lines.join('\n')).toString('base64');
}

function editTrusted(sigB64: string, from: string, to: string): string {
  const text = Buffer.from(sigB64, 'base64').toString('utf8');
  return Buffer.from(text.replace(from, to)).toString('base64');
}

describe('the update manifest (GitHub#184)', () => {
  it('both packages signed with the app\'s key: both platforms, this repository\'s download URLs, the signatures as signed', async () => {
    const dir = tempDir();
    const k = key(dir, 'release.key');
    const a = pack(dir, '0.5.0', 'arm64', k.priv);
    pack(dir, '0.5.0', 'x64', k.priv);
    const r = build({ version: '0.5.0', dir, pubkey: k.pub, notes: 'n', date: new Date('2026-11-06T00:00:00Z') });
    expect(r.ok).toBe(true);
    const m = (r as any).manifest;
    expect(m.version).toBe('0.5.0');
    expect(Object.keys(m.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64']);
    expect(m.platforms['darwin-aarch64'].url).toBe('https://github.com/GigleAI/cavil-loop/releases/download/client/v0.5.0/Cavil-Loop-0.5.0-arm64.app.tar.gz');
    expect(m.platforms['darwin-x86_64'].signature).toBe(readFileSync(join(dir, 'Cavil-Loop-0.5.0-x64.app.tar.gz.sig'), 'utf8').trim());
    expect(keyId(m.platforms['darwin-aarch64'].signature)).toBe(keyId(k.pub));
    // the plugin's own library agrees
    expect(await pluginSays(readFileSync(a.file), readFileSync(a.sig, 'utf8').trim(), k.pub)).toBe(true);
  });

  it('every signature verdict matches the update plugin\'s own check: valid, package changed after signing, signature bytes broken (same key id), trusted comment edited, another key', async () => {
    const dir = tempDir();
    const k = key(dir, 'k');
    const other = key(dir, 'other');
    const p = pack(dir, '0.5.0', 'arm64', k.priv);
    const data = readFileSync(p.file);
    const sig = readFileSync(p.sig, 'utf8').trim();
    const cases: [string, Buffer, string, string, boolean][] = [
      ['valid', data, sig, k.pub, true],
      ['package changed after signing', Buffer.concat([data, Buffer.from('x')]), sig, k.pub, false],
      ['one package byte changed', Buffer.from(data.map((b, i) => (i === 7 ? b ^ 1 : b))), sig, k.pub, false],
      ['signature byte broken, key id kept', data, flipSignatureByte(sig, 1, 20), k.pub, false],
      ['global signature broken', data, flipSignatureByte(sig, 3, 5), k.pub, false],
      ['trusted comment (bound version) edited', data, editTrusted(sig, 'version:0.5.0', 'version:0.9.0'), k.pub, false],
      ['another key', data, sig, other.pub, false],
    ];
    for (const [what, d, s, pub, want] of cases) {
      expect(verifySignature(d, s, pub).ok, what).toBe(want);
      expect(await pluginSays(d, s, pub), `plugin: ${what}`).toBe(want);
    }
  });

  it('a package changed after signing, or a broken signature with the right key id, is refused (nothing to publish)', () => {
    const dir = tempDir();
    const k = key(dir, 'k');
    const a = pack(dir, '0.5.0', 'arm64', k.priv);
    const x = pack(dir, '0.5.0', 'x64', k.priv);
    writeFileSync(a.file, Buffer.concat([readFileSync(a.file), Buffer.from('tampered')]));
    writeFileSync(x.sig, flipSignatureByte(readFileSync(x.sig, 'utf8').trim(), 1, 20));
    const r = build({ version: '0.5.0', dir, pubkey: k.pub });
    expect(r.ok).toBe(false);
    const errs = (r as any).errors.join('\n');
    expect(errs).toMatch(/arm64：签名和包的内容对不上/);
    expect(errs).toMatch(/x64：签名和包的内容对不上/);
  });

  it('a package signed with another key is refused (every installed app would refuse it)', () => {
    const dir = tempDir();
    const app = key(dir, 'app.key');
    const other = key(dir, 'other.key');
    pack(dir, '0.5.0', 'arm64', app.priv);
    pack(dir, '0.5.0', 'x64', other.priv);
    const r = build({ version: '0.5.0', dir, pubkey: app.pub });
    expect(r.ok).toBe(false);
    expect((r as any).errors.join('\n')).toMatch(/x64：签名用的密钥.*不是 App 里公钥对应的那把/);
  });

  it('no public key in the app, a missing package, a signature bound to another version: refused', () => {
    const dir = tempDir();
    const k = key(dir, 'k');
    pack(dir, '0.5.0', 'arm64', k.priv, '0.4.9');
    const none = build({ version: '0.5.0', dir, pubkey: '' });
    expect(none.ok).toBe(false);
    expect((none as any).errors.join('\n')).toMatch(/没有更新用的公钥/);
    const r = build({ version: '0.5.0', dir, pubkey: k.pub });
    expect(r.ok).toBe(false);
    const errs = (r as any).errors.join('\n');
    expect(errs).toMatch(/x64：没有更新包/);
    expect(errs).toMatch(/arm64：签名绑定的版本是 0\.4\.9，不是 0\.5\.0/);
  });

  it('the command line: exit 1 and no latest.json when a package does not verify; --verify answers by exit code', () => {
    const dir = tempDir();
    const k = key(dir, 'k');
    const conf = join(dir, 'tauri.conf.json');
    writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: k.pub } } }));
    const a = pack(dir, '0.5.0', 'arm64', k.priv);
    pack(dir, '0.5.0', 'x64', k.priv);
    const run = (args: string[]) => {
      try {
        execFileSync('node', [join(root, 'scripts/update-manifest.mjs'), ...args], { stdio: 'pipe' });
        return 0;
      } catch (e: any) {
        return e.status;
      }
    };
    expect(run(['--verify', a.file, a.sig, '--conf', conf])).toBe(0);
    expect(run(['--version', '0.5.0', '--dir', dir, '--conf', conf, '--out', join(dir, 'latest.json')])).toBe(0);
    writeFileSync(a.file, 'changed');
    expect(run(['--verify', a.file, a.sig, '--conf', conf])).toBe(1);
    expect(run(['--version', '0.5.0', '--dir', dir, '--conf', conf, '--out', join(dir, 'latest2.json')])).toBe(1);
    expect(() => readFileSync(join(dir, 'latest2.json'))).toThrow();
  });
});

describe('per channel: which machines a manifest must carry (GitHub#215)', () => {
  const cli = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync('node', [join(root, 'scripts/update-manifest.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e: any) {
      return { code: e.status as number, out: String(e.stdout) };
    }
  };

  it('a development build with only the Apple silicon package: the manifest is made, for that machine only', () => {
    const dir = tempDir();
    const k = key(dir, 'k');
    pack(dir, '0.5.1-dev.387', 'arm64', k.priv);
    const r = build({ version: '0.5.1-dev.387', dir, pubkey: k.pub, channel: 'dev' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const m = (r as any).manifest;
    expect(m.version).toBe('0.5.1-dev.387');
    expect(Object.keys(m.platforms)).toEqual(['darwin-aarch64']);
    expect(m.platforms['darwin-aarch64'].url).toBe('https://github.com/GigleAI/cavil-loop/releases/download/client/v0.5.1-dev.387/Cavil-Loop-0.5.1-dev.387-arm64.app.tar.gz');
  });

  it('a release still needs both machines: missing either one is refused, whatever else is there', () => {
    for (const only of ['arm64', 'x64']) {
      const dir = tempDir();
      const k = key(dir, 'k');
      pack(dir, '0.5.1', only, k.priv);
      const r = build({ version: '0.5.1', dir, pubkey: k.pub });
      expect(r.ok, only).toBe(false);
      expect((r as any).errors.join('\n')).toMatch(only === 'arm64' ? /x64：没有更新包/ : /arm64：没有更新包/);
      expect(build({ version: '0.5.1', dir, pubkey: k.pub, channel: 'stable' }).ok).toBe(false);
    }
  });

  it('the development channel still refuses a missing, unsigned or wrongly signed Apple silicon package', () => {
    const dir = tempDir();
    const k = key(dir, 'k');
    const other = key(dir, 'o');
    expect((build({ version: '0.5.1-dev.3', dir, pubkey: k.pub, channel: 'dev' }) as any).errors.join('\n')).toMatch(/arm64：没有更新包/);
    pack(dir, '0.5.1-dev.3', 'arm64', other.priv);
    expect((build({ version: '0.5.1-dev.3', dir, pubkey: k.pub, channel: 'dev' }) as any).errors.join('\n')).toMatch(/arm64：签名用的密钥/);
    pack(dir, '0.5.1-dev.3', 'arm64', k.priv, '0.5.1-dev.2');
    expect((build({ version: '0.5.1-dev.3', dir, pubkey: k.pub, channel: 'dev' }) as any).errors.join('\n')).toMatch(/签名绑定的版本是 0\.5\.1-dev\.2/);
  });

  it('each channel takes only its own version shape; an unknown channel is refused', () => {
    const dir = tempDir();
    const k = key(dir, 'k');
    pack(dir, '0.5.1', 'arm64', k.priv);
    pack(dir, '0.5.1', 'x64', k.priv);
    expect((build({ version: '0.5.1', dir, pubkey: k.pub, channel: 'dev' }) as any).errors.join('\n')).toMatch(/版本号不是 X\.Y\.Z-dev\.N：0\.5\.1/);
    for (const v of ['0.5.1-dev.01', '0.5.1-dev.', '0.5.1-rc.1', '0.5.1-dev.1.2']) {
      expect(build({ version: v, dir, pubkey: k.pub, channel: 'dev' }).ok, v).toBe(false);
    }
    expect((build({ version: '0.5.1-dev.3', dir, pubkey: k.pub }) as any).errors.join('\n')).toMatch(/版本号不是 X\.Y\.Z：/);
    expect((build({ version: '0.5.1', dir, pubkey: k.pub, channel: 'arm64' }) as any).errors.join('\n')).toMatch(/不认识的渠道/);
    // a key that is not a channel but is a property of every object
    expect(build({ version: '0.5.1', dir, pubkey: k.pub, channel: 'constructor' }).ok).toBe(false);
  });

  it('the command line: --channel dev makes the development manifest; --print-platforms tells each channel\'s machines', () => {
    const dir = tempDir();
    const k = key(dir, 'k');
    const conf = join(dir, 'tauri.conf.json');
    writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: k.pub } } }));
    pack(dir, '0.5.1-dev.9', 'arm64', k.priv);
    expect(cli(['--version', '0.5.1-dev.9', '--dir', dir, '--conf', conf, '--out', join(dir, 'a.json')]).code).toBe(1);
    expect(cli(['--version', '0.5.1-dev.9', '--dir', dir, '--conf', conf, '--channel', 'dev', '--out', join(dir, 'b.json')]).code).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8')).platforms)).toEqual(['darwin-aarch64']);
    expect(JSON.parse(cli(['--print-platforms', 'dev']).out)).toEqual(CHANNEL_PLATFORMS.dev);
    expect(JSON.parse(cli(['--print-platforms', 'stable']).out)).toEqual(['darwin-aarch64', 'darwin-x86_64']);
    expect(cli(['--print-platforms', 'nightly']).code).toBe(1);
  });

  it('the app greys out the development channel on exactly the machines this table has no development build for', async () => {
    if (!harness) {
      const d = tempDir();
      harness = new HarnessBackend({ db: join(d, 'c.sqlite'), endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' }, credentials: new FileStore(join(d, 'cred')) });
    }
    const app = await harness.call('test.update.devTargets');
    const printed = JSON.parse(cli(['--print-platforms', 'dev']).out);
    expect(app).toEqual(printed);
  });
});
