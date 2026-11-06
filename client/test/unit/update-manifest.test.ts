// The update manifest the release job publishes (GitHub#184, scripts/update-manifest.mjs), on real
// keys and signatures made by Tauri's own signer (the CLI the release job uses).

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, keyId, packageName } from '../../scripts/update-manifest.mjs';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauri = join(root, 'node_modules', '.bin', 'tauri');

function key(dir: string, name: string) {
  const f = join(dir, name);
  execFileSync(tauri, ['signer', 'generate', '--ci', '-p', '', '-w', f], { stdio: 'ignore' });
  return { priv: f, pub: readFileSync(`${f}.pub`, 'utf8') };
}

function pack(dir: string, version: string, arch: string, priv: string, signAs = version) {
  const f = join(dir, packageName(version, arch));
  writeFileSync(f, `package ${version} ${arch}`);
  execFileSync(tauri, ['signer', 'sign', '-f', priv, '-p', '', '--app-version', signAs, f], { stdio: 'ignore' });
}

describe('the update manifest (GitHub#184)', () => {
  it('both packages signed with the app\'s key: both platforms, this repository\'s download URLs, the signatures as signed', () => {
    const dir = tempDir();
    const k = key(dir, 'release.key');
    pack(dir, '0.5.0', 'arm64', k.priv);
    pack(dir, '0.5.0', 'x64', k.priv);
    const r = build({ version: '0.5.0', dir, pubkey: k.pub, notes: 'n', date: new Date('2026-11-06T00:00:00Z') });
    expect(r.ok).toBe(true);
    const m = (r as any).manifest;
    expect(m.version).toBe('0.5.0');
    expect(Object.keys(m.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64']);
    expect(m.platforms['darwin-aarch64'].url).toBe('https://github.com/GigleAI/cavil-loop/releases/download/client/v0.5.0/Cavil-Loop-0.5.0-arm64.app.tar.gz');
    expect(m.platforms['darwin-x86_64'].signature).toBe(readFileSync(join(dir, 'Cavil-Loop-0.5.0-x64.app.tar.gz.sig'), 'utf8').trim());
    expect(keyId(m.platforms['darwin-aarch64'].signature)).toBe(keyId(k.pub));
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
    const r = build({ version: '0.5.0', dir, pubkey: '' });
    expect(r.ok).toBe(false);
    const errs = (r as any).errors.join('\n');
    expect(errs).toMatch(/没有更新用的公钥/);
    expect(errs).toMatch(/x64：没有更新包/);
    expect(errs).toMatch(/arm64：签名绑定的版本是 0\.4\.9，不是 0\.5\.0/);
  });
});
