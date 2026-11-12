// GigleAI/cavil-loop#401: an organisation's Project the account could not read gave the user
// nothing to go on — no list of what the account can see, and only GitHub's raw English message.
// Through the real controller, the real Rust back end and the fake GitHub over HTTP:
//   1. a source's failure is classified (the organisation's restriction, single sign-on, a missing
//      scope, a plain not found, no connection, a rate limit, GitHub's temporary error), and a source
//      that reads fine is read exactly as before (same requests);
//   2. "从 GitHub 选" lists the account's own Projects and each organisation's, every page; one
//      organisation that refuses says why and leaves the others; an organisation list that fails is
//      "could not read", never "no organisations";
//   3. the empty board's card: what to show for no source, every source failed, still reading,
//      partly read, read with nothing in it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, type SyncTimers } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { emptyGuideOf } from '../../src/shared/emptyGuide';
import type { SourceConfig, SourceStatus } from '../../src/shared/types';
import { describeFailure, failureOf } from '../../src/shared/readFailure';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const ACME_URL = 'https://github.com/orgs/acme-team/projects/3';
const ACME_KEY = 'project:org/acme-team/3';
const REPO = 'GigleAI/cavil-loop';

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake.close();
});

const NO_TIMERS: SyncTimers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };

async function boot(sources: string[], now: () => number = () => FIXTURE_NOW) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now, sleep: async () => {} });
  backends.push(harness);
  const c = await Controller.create({ backend: harness, endpoints, now, timers: NO_TIMERS, defaultClientId: '', followUpSyncMs: 600_000, readRetryDelaysMs: [0, 0] });
  controllers.push(c);
  for (const s of sources) c.addSource(s);
  await c.start();
  await c.syncNow();
  return c;
}
const status = (c: Controller, key: string) => c.getState().sync.sources.find((s) => s.sourceKey === key)!;

describe("a source's failure, classified (GitHub#401)", () => {
  it('an organisation that has not approved the app: orgRestricted, naming it; the other source reads as before', async () => {
    fake.state.restrictedOrgs.set('acme-team', { kind: 'oauth' });
    const c = await boot([ACME_URL, PROJECT_URL]);
    const st = status(c, ACME_KEY);
    expect(st.ok).toBe(false);
    expect(st.failure).toMatchObject({ kind: 'orgRestricted', org: 'acme-team' });
    expect(st.failure!.raw).toContain('OAuth App access restrictions');
    expect(status(c, PROJECT_KEY).ok).toBe(true);
    expect(c.getBoardData().items.length).toBeGreaterThan(0);
  });

  it('single sign-on: sso, with the address GitHub sent', async () => {
    fake.state.restrictedOrgs.set('acme-team', { kind: 'sso' });
    const c = await boot([ACME_URL]);
    expect(status(c, ACME_KEY).failure).toMatchObject({ kind: 'sso', org: 'acme-team', ssoUrl: 'https://github.com/orgs/acme-team/sso?authorization_request=fake' });
  });

  it('a Project that is not there: notFound (no cause named); with the project scope missing from the grant: scope', async () => {
    let c = await boot([ACME_URL]);
    expect(status(c, ACME_KEY).failure).toMatchObject({ kind: 'notFound', org: 'acme-team' });
    await c.stopTimer();
    fake.state.oauthScopes = 'read:org, repo';
    c = await boot([ACME_URL]);
    expect(status(c, ACME_KEY).failure?.kind).toBe('scope');
  });

  it('a missing repository with the project scope not granted: notFound, never "sign in again for Project access" (PR #414 review round 1)', async () => {
    fake.state.oauthScopes = 'repo, read:org';
    const c = await boot(['acme/missing', ACME_URL]);
    const repo = status(c, 'repo:acme/missing');
    expect(repo.failure?.kind).toBe('notFound');
    expect(describeFailure(failureOf(repo), FIXTURE_NOW).actions).not.toContain('relogin');
    // the same scope list explains the Project's refusal
    expect(status(c, ACME_KEY).failure?.kind).toBe('scope');
  });

  it('GitHub keeps failing a page (502): transient, not "no access"', async () => {
    fake.state.failProjectPage.set('org/gigleai/11', 0);
    const c = await boot([PROJECT_URL]);
    const st = status(c, PROJECT_KEY);
    expect(st.failure?.kind).toBe('transient');
    expect(describeFailure(failureOf(st), FIXTURE_NOW).actions).toEqual(['retry']);
  });

  it('rate limited: rateLimited, with the reset GitHub gave', async () => {
    const reset = Math.floor(FIXTURE_NOW / 1000) + 600;
    fake.state.answerOverride = (e: LoggedRequest) =>
      e.operation === 'CavilProjectItems' ? { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } } : null;
    const c = await boot([PROJECT_URL]);
    expect(status(c, PROJECT_KEY).failure).toMatchObject({ kind: 'rateLimited', retryAt: reset * 1000 });
  });

  it('offline: network for every source', async () => {
    const c = await boot([PROJECT_URL, REPO]);
    fake.state.offlineApi = true;
    await c.syncNow();
    for (const s of c.getState().sync.sources) expect(s.failure?.kind).toBe('network');
  });

  it('a source that reads fine: the same requests as without any of this', async () => {
    const c = await boot([PROJECT_URL, REPO]);
    expect(c.getState().sync.sources.every((s) => s.ok && s.failure === undefined)).toBe(true);
    expect(fake.log.some((e) => e.operation?.startsWith('CavilChoices'))).toBe(false);
  });
});

describe('"从 GitHub 选" (GitHub#401)', () => {
  it("the account's own Projects and each organisation's, every page; closed ones left out", async () => {
    fake.state.memberOrgs.set('user-1', ['GigleAI', 'tools-org', 'b-org']);
    fake.state.extraProjects.set('user/user-1', [
      { number: 2, title: '读书清单' },
      { number: 4, title: '旧的', closed: true },
    ]);
    fake.state.extraProjects.set('org/gigleai', [
      { number: 7, title: 'Tutor 迭代' },
      { number: 8, title: '八' },
      { number: 9, title: '九' },
    ]);
    const c = await boot([]);
    const r = await c.projectChoices();
    expect(r.ok).toBe(true);
    expect(r.viewer).toBe('user-1');
    expect(r.groups.map((g) => [g.owner, g.ownerType, g.ok, g.projects.map((p) => p.number)])).toEqual([
      ['user-1', 'user', true, [2]],
      ['GigleAI', 'org', true, [7, 8, 9, 11]],
      ['tools-org', 'org', true, []],
      ['b-org', 'org', true, []],
    ]);
    // pages of 2 in the fake: GigleAI's four Projects take two requests (the cursor was followed)
    expect(fake.log.filter((e) => e.operation === 'CavilChoicesOrg' && e.variables?.login === 'GigleAI').length).toBe(2);
    expect(r.groups[1].projects.find((p) => p.number === 11)?.url).toBe(PROJECT_URL);
  });

  it('one organisation refuses: it says why, the others are listed; a hidden one is not there at all', async () => {
    fake.state.memberOrgs.set('user-1', ['GigleAI', 'acme-team', 'quiet-org']);
    fake.state.restrictedOrgs.set('acme-team', { kind: 'oauth' });
    fake.state.restrictedOrgs.set('quiet-org', { kind: 'oauth', hidden: true });
    const c = await boot([]);
    const r = await c.projectChoices();
    const acme = r.groups.find((g) => g.owner === 'acme-team')!;
    expect(acme).toMatchObject({ ok: false, projects: [], failure: { kind: 'orgRestricted', org: 'acme-team' } });
    expect(r.groups.find((g) => g.owner === 'GigleAI')?.ok).toBe(true);
    expect(r.groups.some((g) => g.owner === 'quiet-org')).toBe(false);
  });

  it('the organisation list fails: "could not read" with why, the own Projects still there', async () => {
    fake.state.answerOverride = (e: LoggedRequest) => (e.operation === 'CavilChoicesOrgs' ? { status: 502, body: { message: 'Server Error' } } : null);
    const c = await boot([]);
    const r = await c.projectChoices();
    expect(r.ok).toBe(true);
    expect(r.orgsFailure?.kind).toBe('transient');
    expect(r.groups.map((g) => g.owner)).toEqual(['user-1']);
  });

  it('rate limited: every read asked for before GitHub\'s time gets the same answer without a request; after it, a real read (PR #414 review round 1)', async () => {
    const clock = { t: Date.now() };
    let limit = true;
    fake.state.answerOverride = (e: LoggedRequest) => (limit && e.operation === 'CavilChoicesViewer' ? { status: 429, body: { message: 'too many' }, headers: { 'retry-after': '120' } } : null);
    const c = await boot([], () => clock.t);
    const reads = () => fake.log.filter((e) => e.operation === 'CavilChoicesViewer').length;
    const first = await c.projectChoices();
    expect(first).toMatchObject({ ok: false, failure: { kind: 'rateLimited' } });
    expect(first.failure!.retryAt).toBeGreaterThan(clock.t + 100_000);
    expect(reads()).toBe(1);
    // asked again (the list's button, a failure's button, the list closed and opened): no request
    expect(await c.projectChoices()).toEqual(first);
    expect(await c.projectChoices()).toEqual(first);
    expect(reads()).toBe(1);
    // GitHub's time has passed: read again for real
    limit = false;
    clock.t = first.failure!.retryAt! + 1;
    const after = await c.projectChoices();
    expect(after.ok).toBe(true);
    expect(reads()).toBe(2);
  });

  it('nothing can be read (offline): not ok, network', async () => {
    const c = await boot([]);
    fake.state.offlineApi = true;
    const r = await c.projectChoices();
    expect(r).toMatchObject({ ok: false, groups: [], failure: { kind: 'network' } });
  });

  it('a Project picked from the list is added like a pasted address', async () => {
    const c = await boot([]);
    const r = await c.projectChoices();
    const p = r.groups.flatMap((g) => g.projects).find((x) => x.number === 11)!;
    expect(c.addSource(p.url)).toEqual({ ok: true });
    expect(c.getState().sources.map((s) => s.key)).toEqual([PROJECT_KEY]);
  });
});

describe("the empty board's card (GitHub#401)", () => {
  const src = (key: string): SourceConfig => ({ kind: 'repo', key, owner: 'o', name: key });
  const failed = (key: string): SourceStatus => ({ sourceKey: key, ok: false, error: 'x', dataFrom: null, failure: { kind: 'orgRestricted', raw: 'x', org: 'o' } });
  const ok = (key: string): SourceStatus => ({ sourceKey: key, ok: true, error: null, dataFrom: 1 });

  it('no source → how to add one', () => {
    expect(emptyGuideOf([], null, [], [])).toEqual({ kind: 'add' });
  });
  it('a source still waiting for its first answer → nothing (no failure card during the first sync)', () => {
    expect(emptyGuideOf([src('a'), src('b')], null, [failed('a')], [])).toBeNull();
  });
  it('every source in view failed and nothing of theirs is on hand → which ones, and why', () => {
    expect(emptyGuideOf([src('a'), src('b')], null, [failed('a'), failed('b')], [])).toEqual({ kind: 'failed', failed: [failed('a'), failed('b')] });
    // the view shows only `a`: `b` reading fine elsewhere does not hide it
    expect(emptyGuideOf([src('a'), src('b')], ['a'], [failed('a'), ok('b')], [['b']])).toEqual({ kind: 'failed', failed: [failed('a')] });
  });
  it('partly read → nothing (the ⚠️ says which failed)', () => {
    expect(emptyGuideOf([src('a'), src('b')], null, [failed('a'), ok('b')], [['b']])).toBeNull();
  });
  it('failed now but items from an earlier read on hand → nothing', () => {
    expect(emptyGuideOf([src('a')], null, [failed('a')], [['a']])).toBeNull();
  });
  it('read fine, nothing in it → nothing (the board is honestly empty)', () => {
    expect(emptyGuideOf([src('a')], null, [ok('a')], [])).toBeNull();
  });
});
