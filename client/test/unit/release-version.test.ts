// The version of a client release (GitHub#576, scripts/release-version.mjs): the next release, which
// tags are valid releases, what a development build counts from — and, on real git repositories with
// a bare remote, the weekly run's decision and the release build's check. The workflow steps that run
// these are exercised in tests/release-auto.test.sh.

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, devBase, nextRelease, plan, releaseVersions, remoteTags, tagProblems } from '../../scripts/release-version.mjs';
import { readVersions, stamp } from '../../scripts/dev-version.mjs';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** a bare remote + a clone whose client/ holds copies of the three version files at `version` */
function repo(version: string) {
  const d = tempDir();
  const remote = join(d, 'remote.git');
  const work = join(d, 'work');
  git(d, 'init', '-q', '--bare', '-b', 'main', remote);
  git(d, 'clone', '-q', remote, work);
  const client = join(work, 'client');
  mkdirSync(join(client, 'src-tauri'), { recursive: true });
  copyFileSync(join(root, 'package.json'), join(client, 'package.json'));
  copyFileSync(join(root, 'src-tauri', 'tauri.conf.json'), join(client, 'src-tauri', 'tauri.conf.json'));
  copyFileSync(join(root, 'src-tauri', 'Cargo.toml'), join(client, 'src-tauri', 'Cargo.toml'));
  const set = (v: string) => {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'release-version.mjs'), 'write', v, '--root', client], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  set(version);
  const commit = (file: string, msg: string) => {
    writeFileSync(join(work, file), msg);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', msg);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const first = commit('readme', 'first');
  return { remote, work, client, commit, first, set, tag: (name: string, at: string) => git(work, 'push', '-q', 'origin', `${at}:refs/tags/${name}`) };
}

describe('the client release version (GitHub#576)', () => {
  it('next release: the highest client/vX.Y.Z plus one, or package.json when higher', () => {
    expect(nextRelease('0.5.2', [])).toBe('0.5.2');
    expect(nextRelease('0.5.2', ['0.5.2'])).toBe('0.5.3');
    expect(nextRelease('0.5.2', ['0.5.1', '0.5.10', '0.5.9'])).toBe('0.5.11');
    expect(nextRelease('0.6.0', ['0.5.9'])).toBe('0.6.0');
    expect(nextRelease('0.6.0', ['0.6.0'])).toBe('0.6.1');
    expect(() => nextRelease('0.6.0-dev.3', [])).toThrow(/X\.Y\.Z/);
  });

  it('only tags shaped exactly client/vX.Y.Z count', () => {
    expect(releaseVersions(['client/v0.5.2', 'client/v0.5.3-dev.598', 'release/v2026.11.15.1', 'client/v05.1.0', 'client/v0.6', 'v0.7.0', 'client/v1.0.0'])).toEqual(['0.5.2', '1.0.0']);
  });

  it('a development build counts from the higher of package.json and the highest release tag', () => {
    expect(devBase('0.5.2', [])).toBe('0.5.2');
    expect(devBase('0.5.2', ['0.5.2', '0.5.4'])).toBe('0.5.4');
    expect(devBase('0.6.0', ['0.5.4'])).toBe('0.6.0');
  });

  it('a release tag: the shape, not below package.json, above every other release tag', () => {
    expect(tagProblems('client/v0.5.3', '0.5.2', ['client/v0.5.2'])).toEqual([]);
    expect(tagProblems('client/v0.5.3', '0.5.2', ['client/v0.5.3', 'client/v0.5.2'])).toEqual([]); // a rerun of the same tag
    expect(tagProblems('client/v0.5.1', '0.5.2', [])).toEqual(['client/v0.5.1 低于 package.json 的版本 0.5.2']);
    expect(tagProblems('client/v0.5.3', '0.5.2', ['client/v0.5.4'])).toEqual(['已有 client/v0.5.4，client/v0.5.3 不比它高']);
    expect(tagProblems('client/v0.5.3', '0.5.2', ['client/v0.5.9-dev.4'])).toEqual([]);
    for (const bad of ['client/v0.5.3-dev.1', 'client/v0.5', 'v0.5.3', 'client/v00.5.3']) expect(tagProblems(bad, '0.5.2', []).length, bad).toBe(1);
  });

  it('the weekly decision on a real repository: first release, unchanged, changed, a tag whose release failed', () => {
    const r = repo('0.5.2');
    expect(plan(r.client, r.first, [])).toMatchObject({ tag: 'client/v0.5.2', since: '' });
    r.tag('client/v0.5.2', r.first);
    const outside = r.commit('daemon', 'outside client/');
    expect(plan(r.client, outside, ['client/v0.5.2'])).toMatchObject({ tag: '', since: 'client/v0.5.2' });
    const inside = r.commit('client/app', 'inside client/');
    expect(plan(r.client, inside, ['client/v0.5.2'])).toMatchObject({ tag: 'client/v0.5.3', version: '0.5.3' });
    // the planned commit decides, not the newest one
    expect(plan(r.client, outside, ['client/v0.5.2']).tag).toBe('');
    // 0.5.3 tagged but its page never came: its changes are still unreleased, the number is taken
    r.tag('client/v0.5.3', inside);
    expect(plan(r.client, inside, ['client/v0.5.2'])).toMatchObject({ tag: 'client/v0.5.4', since: 'client/v0.5.2' });
    expect(plan(r.client, inside, ['client/v0.5.2', 'client/v0.5.3']).tag).toBe('');
    expect([...remoteTags(r.client).keys()].sort()).toEqual(['client/v0.5.2', 'client/v0.5.3']);
  });

  it('the release build\'s check reads package.json at the tested commit and the remote\'s tags', () => {
    const r = repo('0.5.2');
    r.tag('client/v0.5.2', r.first);
    expect(check(r.client, 'client/v0.5.3', r.first)).toBe('0.5.3');
    r.tag('client/v0.6.0', r.first);
    expect(() => check(r.client, 'client/v0.5.3', r.first)).toThrow(/已有 client\/v0\.6\.0/);
    r.set('0.7.0');
    const raised = r.commit('client/x', 'raise to 0.7.0');
    expect(() => check(r.client, 'client/v0.6.5', raised)).toThrow(/低于 package\.json 的版本 0\.7\.0/);
    expect(check(r.client, 'client/v0.7.0', raised)).toBe('0.7.0');
  });

  it('a remote that cannot be read is an error, never "no tags"', () => {
    const r = repo('0.5.2');
    git(r.work, 'remote', 'set-url', 'origin', join(r.work, 'no-such-remote'));
    expect(() => plan(r.client, r.first, [])).toThrow(/读不到远端的客户端标签/);
    expect(() => check(r.client, 'client/v0.5.3', r.first)).toThrow(/读不到远端的客户端标签/);
  });

  it('the command line: plan prints key=value lines, write puts the version into all three files, failures are exit 1', () => {
    const r = repo('0.5.2');
    const cli = (...a: string[]) => spawnSync(process.execPath, [join(root, 'scripts', 'release-version.mjs'), ...a, '--root', r.client], { encoding: 'utf8' });
    const rel = join(r.work, '..', 'released.txt');
    writeFileSync(rel, '');
    const p = cli('plan', '--at', r.first, '--released', rel);
    expect(p.status).toBe(0);
    expect(p.stdout).toMatch(/^tag=client\/v0\.5\.2\nversion=0\.5\.2\nsince=\nreason=.+\n$/);
    const c = cli('check', 'client/v0.5.1', '--at', r.first);
    expect([c.status, c.stdout]).toEqual([1, '']);
    const w = cli('write', '0.8.1');
    expect([w.status, w.stdout.trim()]).toEqual([0, '0.8.1']);
    const v = readVersions(r.client);
    expect([v.pkg, v.conf, v.cargo]).toEqual(['0.8.1', '0.8.1', '0.8.1']);
    expect(cli('write', '0.8.1-dev.2').status).toBe(1);
  });

  it('a development build after a release that is not in package.json is still newer than that release', () => {
    const r = repo('0.5.2');
    const n = Number(git(r.work, 'rev-list', '--count', 'HEAD'));
    expect(stamp(r.client, { tags: [] })).toBe(`0.5.3-dev.${n}`);
    expect(stamp(r.client, { tags: ['client/v0.5.2', 'client/v0.5.6', 'client/v0.9.0-dev.1'] })).toBe(`0.5.7-dev.${n}`);
    git(r.work, 'tag', 'client/v0.5.4');
    expect(stamp(r.client)).toBe(`0.5.5-dev.${n}`);
  });
});
