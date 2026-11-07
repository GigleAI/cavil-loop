// The version stamped into a development build (GitHub#215, scripts/dev-version.mjs): on real git
// repositories (a full one, a shallow clone), on copies of the client's own three version files.
// The stamped version is then handed to the app's own picker (the Rust back end) and to the
// release job's manifest builder, so the three agree on what a development version is.

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devVersion, readVersions, stamp } from '../../scripts/dev-version.mjs';
import { VERSION_SHAPE } from '../../scripts/update-manifest.mjs';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** a repository holding copies of the client's three version files, with `commits` commits */
function repo(commits: number) {
  const d = tempDir();
  mkdirSync(join(d, 'src-tauri'));
  copyFileSync(join(root, 'package.json'), join(d, 'package.json'));
  copyFileSync(join(root, 'src-tauri', 'tauri.conf.json'), join(d, 'src-tauri', 'tauri.conf.json'));
  copyFileSync(join(root, 'src-tauri', 'Cargo.toml'), join(d, 'src-tauri', 'Cargo.toml'));
  git(d, 'init', '-q', '-b', 'main');
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(d, 'n'), String(i));
    git(d, 'add', '-A');
    git(d, 'commit', '-q', '-m', `c${i}`);
  }
  return d;
}

let harness: HarnessBackend | null = null;
afterAll(async () => harness?.close());

describe('the development build\'s version (GitHub#215)', () => {
  it('X.Y.Z + N commits → X.Y.(Z+1)-dev.N; anything else is refused', () => {
    expect(devVersion('0.5.0', 387)).toBe('0.5.1-dev.387');
    expect(devVersion('0.9.9', 1)).toBe('0.9.10-dev.1');
    expect(devVersion('1.0.0', 12)).toBe('1.0.1-dev.12');
    for (const bad of ['0.5', '0.5.0-dev.1', '05.0.0', '', undefined]) expect(() => devVersion(bad as any, 3), String(bad)).toThrow();
    for (const n of [0, -1, 1.5, NaN]) expect(() => devVersion('0.5.0', n), String(n)).toThrow();
  });

  it('on a real repository: the commit count, written into all three files (only the version line of Cargo.toml changes)', () => {
    const d = repo(5);
    const before = readVersions(d);
    const base = before.pkg;
    const [x, y, z] = base.split('.').map(Number);
    const want = `${x}.${y}.${z + 1}-dev.5`;
    expect(stamp(d)).toBe(want);
    // printing changes nothing
    expect(readVersions(d).text).toEqual(before.text);
    expect(stamp(d, { write: true })).toBe(want);
    const after = readVersions(d);
    expect([after.pkg, after.conf, after.cargo]).toEqual([want, want, want]);
    const lines = (t: string) => t.split('\n');
    const changed = lines(after.text.cargo).filter((l, i) => l !== lines(before.text.cargo)[i]);
    expect(changed).toEqual([`version = "${want}"`]);
    // nothing else in package.json / tauri.conf.json moved
    expect({ ...JSON.parse(after.text.pkg), version: base }).toEqual(JSON.parse(before.text.pkg));
    expect({ ...JSON.parse(after.text.conf), version: base }).toEqual(JSON.parse(before.text.conf));
    // one more commit, one higher N
    expect(stamp(repo(6))).toBe(want.replace(/dev\.5$/, 'dev.6'));
  });

  it('a shallow clone cannot count its commits: refused, nothing written', () => {
    const full = repo(4);
    const shallow = join(tempDir(), 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${full}`, shallow]);
    const before = readVersions(shallow).text;
    expect(() => stamp(shallow, { write: true })).toThrow(/浅克隆/);
    expect(readVersions(shallow).text).toEqual(before);
  });

  it('the three files disagreeing: refused, nothing written', () => {
    const d = repo(2);
    const conf = join(d, 'src-tauri', 'tauri.conf.json');
    writeFileSync(conf, readFileSync(conf, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    const pkg = readFileSync(join(d, 'package.json'), 'utf8');
    expect(() => stamp(d, { write: true })).toThrow(/三处版本号不一致/);
    expect(readFileSync(join(d, 'package.json'), 'utf8')).toBe(pkg);
  });

  it('the command line on this checkout prints the version for its own commit count and changes nothing', () => {
    const before = readFileSync(join(root, 'package.json'), 'utf8');
    const out = execFileSync('node', [join(root, 'scripts', 'dev-version.mjs')], { encoding: 'utf8' }).trim();
    const n = Number(execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
    expect(out).toBe(devVersion(JSON.parse(before).version, n));
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
  });

  it('what it stamps is a development version to the release job and to the app: newer than the release it came from, older than the next', async () => {
    const v = devVersion('0.5.0', 387);
    expect(VERSION_SHAPE.dev.test(v)).toBe(true);
    expect(VERSION_SHAPE.stable.test(v)).toBe(false);
    if (!harness) {
      const d = tempDir();
      harness = new HarnessBackend({ db: join(d, 'c.sqlite'), endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' }, credentials: new FileStore(join(d, 'cred')) });
    }
    const rel = (tag: string, prerelease: boolean) => ({ tag_name: tag, draft: false, prerelease, assets: [{ name: 'latest.json', browser_download_url: `https://github.com/GigleAI/cavil-loop/releases/download/${tag}/latest.json` }] });
    const pick = async (pages: unknown[], current: string) =>
      ((await harness!.call('test.update.pick', { pages, current, web: 'https://github.com', channel: 'dev' })) as any).pick?.version ?? null;
    expect(await pick([[rel(`client/v${v}`, true)]], '0.5.0')).toBe(v);
    expect(await pick([[rel('client/v0.5.1', false)]], v)).toBe('0.5.1');
    expect(await pick([[rel('client/v0.6.0', false)]], v)).toBe('0.6.0');
    expect(await pick([[rel(`client/v${devVersion('0.5.0', 388)}`, true)]], v)).toBe('0.5.1-dev.388');
  });
});
