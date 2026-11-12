// GitHub#395: release attachment images of the discussion, fetched with the sign-in.
// The controller against the real back end (the Rust child process) and the fake GitHub over
// real HTTP: who gets the credential, what each of GitHub's answers is shown as — the same
// whether it came while looking the attachment up or while downloading it — and that a rate
// limit stops the asking until its time.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, IMAGE_FETCHES } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type CannedAnswer, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { APP_CONTENTS_NOTE, imageFailureText, parseReleaseImage, sameReleaseImage, type ImageResult } from '../../src/shared/images';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
const BIG = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);

let fake: FakeGitHub;
let dir: string;
let cache: Cache;
let backend: HarnessBackend;
let c: Controller;
const clock = { t: FIXTURE_NOW };

const img = (file: string, tag = 'v1', repo = 'acme/app') => `${fake.web}/${repo}/releases/download/${tag}/${file}`;
const requests = (part: string) => fake.log.filter((l) => l.path.includes(part));
async function seen(part: string, n = 1) {
  for (let i = 0; i < 1000 && requests(part).length < n; i++) await new Promise((r) => setTimeout(r, 10));
  expect(requests(part).length).toBeGreaterThanOrEqual(n);
}

let credentialsFile: string;
/** the app again, on the same files, its sign-in made with `clientId` (what the back end recorded at that sign-in) */
async function restartSignedInWith(clientId: string) {
  c.stopTimer();
  await c.settled();
  await backend.close();
  cache.setSetting('grantClientId', clientId);
  const endpoints = { api: fake.api, web: fake.web };
  backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials: new FileStore(credentialsFile), now: () => clock.t, sleep: async () => {} });
  c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: '' });
  await c.start();
  expect(c.getState().phase).toBe('ready');
}

beforeEach(async () => {
  clock.t = FIXTURE_NOW;
  fake = await startFakeGitHub();
  fake.state.releases.set('acme/app', [
    {
      tag: 'v1',
      assets: [
        { id: 11, name: 'home.png', bytes: PNG },
        { id: 12, name: 'big.png', bytes: BIG },
        { id: 13, name: 'drawing.svg', bytes: SVG },
        { id: 14, name: 'away.png', bytes: PNG, redirect: `${fake.web}/elsewhere/14` },
        ...[31, 32, 33, 34, 35, 36].map((id) => ({ id, name: `p${id}.png`, bytes: PNG })),
      ],
    },
    { tag: 'untagged-0a1b2c', draft: true, assets: [{ id: 21, name: 'draft.png', bytes: PNG }] },
    { tag: 'client/v0.5.2-dev.486', assets: [{ id: 41, name: 'shot.png', bytes: PNG }] },
    { tag: 'untagged/x', draft: true, assets: [{ id: 42, name: 'draft2.png', bytes: PNG }] },
  ]);
  dir = tempDir();
  cache = new Cache(join(dir, 'cache.sqlite'));
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  credentialsFile = join(dir, 'cred');
  const credentials = new FileStore(credentialsFile);
  await credentials.set(FAKE_TOKEN);
  const endpoints = { api: fake.api, web: fake.web };
  backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {} });
  c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: '' });
  await c.start();
  expect(c.getState().phase).toBe('ready');
});
afterEach(async () => {
  c.stopTimer();
  await backend.close();
  cache.close();
  await fake.close();
});

describe('which addresses are release attachment images', () => {
  it('only <web>/<owner>/<repo>/releases/download/<tag>/<file> of the GitHub in use', () => {
    const web = 'https://github.com';
    expect(parseReleaseImage('https://github.com/acme/app/releases/download/v1.0/a%20b.png', web)).toEqual({ owner: 'acme', repo: 'app', tag: 'v1.0', file: 'a b.png' });
    // a tag with slashes, as GitHub writes it (this repo's own client releases: `client/v0.5.2-dev.486`) and escaped
    const slashed = { owner: 'GigleAI', repo: 'cavil-loop', tag: 'client/v0.5.2-dev.486', file: 'shot.png' };
    expect(parseReleaseImage('https://github.com/GigleAI/cavil-loop/releases/download/client/v0.5.2-dev.486/shot.png', web)).toEqual(slashed);
    expect(parseReleaseImage('https://github.com/GigleAI/cavil-loop/releases/download/client%2Fv0.5.2-dev.486/shot.png', web)).toEqual(slashed);
    expect(parseReleaseImage('https://github.com/acme/app/releases/download/a/b/c/x.png', web)).toEqual({ owner: 'acme', repo: 'app', tag: 'a/b/c', file: 'x.png' });
    expect(sameReleaseImage('https://github.com/Acme/App/releases/download/client/v1/a%20b.png', 'https://github.com/acme/app/releases/download/client%2Fv1/a b.png', web)).toBe(true);
    expect(sameReleaseImage('https://github.com/acme/app/releases/download/client/v1/a.png', 'https://github.com/acme/app/releases/download/client/v2/a.png', web)).toBe(false);
    expect(sameReleaseImage('https://github.com/acme/app/releases/download/a/b/c.png', 'https://github.com/acme/app/releases/download/a/b%2Fc.png', web)).toBe(false);
    for (const no of [
      'https://github.com/acme/app/releases/download/v1',
      'https://github.com/acme/app/releases/download/v1//a.png',
      'https://github.com/acme/app/releases/download/../a.png',
      'https://github.com/acme/app/releases/download/v1/%2E%2E/a.png',
      'https://github.com/acme/app/releases/download//a.png',
      'https://github.com/acme/app/releases/tag/v1',
      'https://github.com/acme/app/raw/main/a.png',
      'https://github.com.evil.example/acme/app/releases/download/v1/a.png',
      'https://user@github.com/acme/app/releases/download/v1/a.png',
      'http://github.com/acme/app/releases/download/v1/a.png',
      'https://raw.githubusercontent.com/acme/app/releases/download/v1/a.png',
      'https://github.com/acme/../releases/download/v1/a.png',
      'https://github.com/acme/app/releases/download/v1/%2F',
      'not a url',
    ])
      expect(parseReleaseImage(no, web), no).toBeNull();
    expect(parseReleaseImage(`${fake.web}/acme/app/releases/download/v1/home.png`, fake.web)).not.toBeNull();
    expect(parseReleaseImage(`${fake.api}/acme/app/releases/download/v1/home.png`, fake.web)).toBeNull();
  });
});

describe('fetching', () => {
  it('the image comes back; the credential went to the API only, the file was fetched without it; a second ask sends nothing', async () => {
    const r = await c.loadImage(img('home.png'));
    expect(r).toEqual({ ok: true, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` });
    const api = requests('/api/repos/acme/app/releases');
    expect(api.map((l) => l.path)).toEqual(['/api/repos/acme/app/releases/tags/v1', '/api/repos/acme/app/releases/assets/11']);
    expect(api.every((l) => l.auth === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    const file = requests('/web/release-assets/11');
    expect(file).toHaveLength(1);
    expect(file[0].auth).toBeNull();
    expect(file[0].status).toBe(200);
    const sent = fake.log.length;
    expect(await c.loadImage(img('home.png'))).toEqual(r);
    expect(fake.log.length).toBe(sent);
  });

  it("a draft release is not found by its tag: its attachment is found in the list of releases", async () => {
    const r = await c.loadImage(img('draft.png', 'untagged-0a1b2c'));
    expect(r.ok).toBe(true);
    expect(requests('/api/repos/acme/app/releases').map((l) => `${l.status} ${l.path}`)).toEqual([
      '404 /api/repos/acme/app/releases/tags/untagged-0a1b2c',
      '200 /api/repos/acme/app/releases?per_page=100',
      '302 /api/repos/acme/app/releases/assets/21',
    ]);
  });

  it('a release whose tag holds a slash (`client/v…`), written the way GitHub writes it or escaped: looked up, downloaded, shown', async () => {
    // the address as the API hands it out: the slash is a slash
    const listed = (await (await fetch(`${fake.api}/repos/acme/app/releases`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } })).json()) as { assets: { browser_download_url: string }[] }[];
    const written = listed.flatMap((r) => r.assets).find((a) => a.browser_download_url.endsWith('/shot.png'))!.browser_download_url;
    expect(written).toBe(`${fake.web}/acme/app/releases/download/client/v0.5.2-dev.486/shot.png`);
    fake.log.length = 0;
    expect(await c.loadImage(written)).toEqual({ ok: true, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(requests('/api/repos/acme/app/releases').map((l) => `${l.status} ${l.path}`)).toEqual([
      '200 /api/repos/acme/app/releases/tags/client/v0.5.2-dev.486',
      '302 /api/repos/acme/app/releases/assets/41',
    ]);
    expect(requests('/web/release-assets/41').map((l) => [l.status, l.auth])).toEqual([[200, null]]);
    // the same attachment with the slash escaped (a comment's author may write it so): one more fetch, the same image
    const escaped = `${fake.web}/acme/app/releases/download/client%2Fv0.5.2-dev.486/shot.png`;
    expect((await c.loadImage(escaped)).ok).toBe(true);
    expect(requests('/releases/assets/41')).toHaveLength(2);
    // a draft under a slashed tag: found in the list
    expect((await c.loadImage(img('draft2.png', 'untagged/x'))).ok).toBe(true);
    expect(requests('/web/release-assets/42')).toHaveLength(1);
  });

  it('not a release address, or no such attachment → not shown; nothing is downloaded', async () => {
    expect(await c.loadImage('https://example.com/a.png')).toEqual({ ok: false, kind: 'denied' });
    expect(fake.log.filter((l) => l.path.includes('releases'))).toHaveLength(0);
    expect(await c.loadImage(img('nope.png'))).toEqual({ ok: false, kind: 'denied' });
    expect(await c.loadImage(img('home.png', 'v1', 'acme/other'))).toEqual({ ok: false, kind: 'denied' });
    expect(requests('/release-assets/')).toHaveLength(0);
    expect(requests('/releases/assets/')).toHaveLength(0);
  });

  it('larger than 10 MB, not one of the four bitmap kinds (an SVG with a script), a redirect to somewhere else: never shown', async () => {
    expect(await c.loadImage(img('big.png'))).toEqual({ ok: false, kind: 'tooLarge' });
    expect(await c.loadImage(img('drawing.svg'))).toEqual({ ok: false, kind: 'notImage' });
    expect(requests('/web/release-assets/13')).toHaveLength(1);
    expect(await c.loadImage(img('away.png'))).toEqual({ ok: false, kind: 'unreachable' });
    // the redirect really was answered, and its target was never asked
    expect(requests('/releases/assets/14').map((l) => l.status)).toEqual([302]);
    expect(requests('/elsewhere/')).toHaveLength(0);
  });

  it('the back end takes nothing but an attachment address of the API', async () => {
    const info = await backend.call<{ session: number }>('grantInfo');
    for (const url of [`${fake.api}/user`, `${fake.api}/repos/acme/app/contents/a.png`, `${fake.web}/release-assets/11`, 'https://example.com/repos/a/b/releases/assets/1']) {
      const r = await backend.call<{ error?: string }>('releaseImage', { session: info.session, url });
      expect(r.error, url).toBe('refused');
    }
    expect(requests('/release-assets/')).toHaveLength(0);
    expect((await backend.call<{ error?: string }>('releaseImage', { session: info.session + 1, url: `${fake.api}/repos/acme/app/releases/assets/11` })).error).toBe('stale');
  });
});

describe("GitHub's refusals: one classification, wherever the answer arrived", () => {
  // each answer as GitHub would give it at `now`, and what it must be shown as
  const answers: { name: string; answer: (now: number) => CannedAnswer; want: (now: number) => ImageResult }[] = [
    { name: '403 without any rate-limit sign', answer: () => ({ status: 403, body: { message: 'Resource not accessible by integration' } }), want: () => ({ ok: false, kind: 'denied' }) },
    { name: '404', answer: () => ({ status: 404, body: { message: 'Not Found' } }), want: () => ({ ok: false, kind: 'denied' }) },
    {
      name: '403 with the quota at 0 and a reset time',
      answer: (now) => ({ status: 403, body: { message: 'API rate limit exceeded for user ID 1.' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 600) } }),
      want: (now) => ({ ok: false, kind: 'limited', until: (Math.floor(now / 1000) + 600) * 1000 }),
    },
    { name: '429 with a wait', answer: () => ({ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '30' } }), want: (now) => ({ ok: false, kind: 'limited', until: now + 30_000 }) },
    {
      name: '403 that only says "secondary rate limit", no time',
      answer: () => ({ status: 403, body: { message: 'You have exceeded a secondary rate limit.' } }),
      want: (now) => ({ ok: false, kind: 'limited', until: now + 60_000 }),
    },
    { name: '502', answer: () => ({ status: 502, body: { message: 'Server Error' } }), want: () => ({ ok: false, kind: 'unreachable' }) },
  ];
  for (const a of answers)
    it(`${a.name}: the same outcome at the look-up and at the download`, async () => {
      // the look-up is two reads (by tag, then — when there is no release of that tag — the list): both answer this way
      const steps: [string, (path: string) => boolean][] = [
        ['look-up', (path) => path.includes('/releases/tags/') || path.includes('/releases?')],
        ['download', (path) => path.includes('/releases/assets/')],
      ];
      for (const [step, at] of steps) {
        const now = clock.t;
        fake.state.answerOverride = (e) => (at(e.path) ? a.answer(now) : null);
        expect(await c.loadImage(img('home.png')), step).toEqual(a.want(now));
        // the answer really came from that step
        expect(fake.log.filter((l) => at(l.path)).at(-1)?.status, step).toBe(a.answer(now).status);
        // past any limit just heard, for the next step
        clock.t += 2 * 3600_000;
      }
      expect(requests('/release-assets/')).toHaveLength(0);
    });

  it('what is shown: only "denied" speaks of permissions, and of the GitHub App one only when the sign-in in use is a GitHub App\'s', () => {
    expect(imageFailureText({ kind: 'denied' })).toBe('没取到：当前登录读不到这个仓库的发布附件');
    expect(imageFailureText({ kind: 'denied', app: true })).toBe(`没取到：当前登录读不到这个仓库的发布附件；${APP_CONTENTS_NOTE}`);
    expect(imageFailureText({ kind: 'limited', until: new Date(2026, 10, 12, 10, 52).getTime() })).toBe('GitHub 限流，10:52 之后可以再试');
    for (const f of [{ kind: 'unreachable' }, { kind: 'tooLarge' }, { kind: 'notImage' }, { kind: 'auth' }] as const) {
      const text = imageFailureText(f);
      expect(text).not.toContain('Contents');
      expect(text).not.toContain('读不到');
    }
  });
});

describe('signed in through a GitHub App', () => {
  // the sign-in in use was made with a GitHub App's Client ID (the back end keeps it with the credential)
  const reset = () => Math.floor(clock.t / 1000) + 600;
  const refused: CannedAnswer = { status: 403, body: { message: 'Resource not accessible by integration' } };
  const limited = (): CannedAnswer => ({ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset()) } });

  it('a refusal says so (at the look-up and at the download, 403 and 404); a rate limit never does; nothing asks for more access', async () => {
    await restartSignedInWith('Iv1.fakeappclientid');
    const lookup = (path: string) => path.includes('/releases/tags/') || path.includes('/releases?');
    const download = (path: string) => path.includes('/releases/assets/');
    for (const at of [lookup, download]) {
      for (const answer of [refused, { status: 404, body: { message: 'Not Found' } }]) {
        fake.state.answerOverride = (e) => (at(e.path) ? answer : null);
        expect(await c.loadImage(img('home.png'))).toEqual({ ok: false, kind: 'denied', app: true });
      }
      const until = reset() * 1000;
      fake.state.answerOverride = (e) => (at(e.path) ? limited() : null);
      expect(await c.loadImage(img('home.png'))).toEqual({ ok: false, kind: 'limited', until });
      clock.t += 2 * 3600_000;
    }
    // with access (the App has the permission) the image is simply shown
    fake.state.answerOverride = null;
    expect((await c.loadImage(img('home.png'))).ok).toBe(true);
    // nothing but reads went out, and nothing to the sign-in pages
    expect(fake.writes()).toEqual([]);
    expect(fake.log.filter((l) => l.path.startsWith('/web/login'))).toEqual([]);
  });

  it('the default sign-in gets the same refusal without the GitHub App sentence', async () => {
    fake.state.answerOverride = (e) => (e.path.includes('/releases/assets/') ? refused : null);
    expect(await c.loadImage(img('home.png'))).toEqual({ ok: false, kind: 'denied' });
  });
});

describe('a rate limit', () => {
  it('stops the asking until its time — also for other images — and after it the image is fetched', async () => {
    const reset = Math.floor(FIXTURE_NOW / 1000) + 600;
    fake.state.answerOverride = (e) =>
      e.path.includes('/releases/assets/') ? { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } } : null;
    const limited = { ok: false, kind: 'limited', until: reset * 1000 };
    expect(await c.loadImage(img('home.png'))).toEqual(limited);
    // GitHub did say so
    expect(requests('/releases/assets/11').map((l) => l.status)).toEqual([403]);
    // GitHub answers again, but it is not asked: neither for that image nor for another
    fake.state.answerOverride = null;
    const sent = fake.log.length;
    expect(await c.loadImage(img('home.png'))).toEqual(limited);
    expect(await c.loadImage(img('p31.png'))).toEqual(limited);
    clock.t = reset * 1000 - 1;
    expect(await c.loadImage(img('p32.png'))).toEqual(limited);
    expect(fake.log.length).toBe(sent);
    // the time has come
    clock.t = reset * 1000;
    expect((await c.loadImage(img('home.png'))).ok).toBe(true);
    expect(requests('/web/release-assets/11').map((l) => l.status)).toEqual([200]);
    expect(fake.log.length).toBeGreaterThan(sent);
  });
});

describe('the account', () => {
  it('a repo this account cannot read: not shown, and nothing was downloaded', async () => {
    fake.state.deniedRepos.set(fake.state.viewer, new Set(['acme/app']));
    expect(await c.loadImage(img('home.png'))).toEqual({ ok: false, kind: 'denied' });
    expect(requests('/release-assets/')).toHaveLength(0);
  });

  it('after signing out, an image fetched before is not handed out and nothing is asked', async () => {
    expect((await c.loadImage(img('home.png'))).ok).toBe(true);
    await c.logout();
    const sent = fake.log.filter((l) => l.path.includes('releases')).length;
    expect(await c.loadImage(img('home.png'))).toEqual({ ok: false, kind: 'auth' });
    expect(fake.log.filter((l) => l.path.includes('releases')).length).toBe(sent);
  });

  it('an answer that arrives after signing out is not kept and not handed out', async () => {
    const release = fake.hold('/release-assets/11');
    const asked = c.loadImage(img('home.png'));
    await seen('/release-assets/11');
    await c.logout();
    release();
    expect(await asked).toEqual({ ok: false, kind: 'auth' });
  });
});

describe('several at once', () => {
  it(`at most ${IMAGE_FETCHES} are being fetched at a time; the rest wait their turn and all arrive`, async () => {
    const release = fake.hold('/releases/tags/');
    const all = [31, 32, 33, 34, 35, 36].map((id) => c.loadImage(img(`p${id}.png`)));
    await seen('/releases/tags/', IMAGE_FETCHES);
    await new Promise((r) => setTimeout(r, 300));
    expect(requests('/releases/tags/')).toHaveLength(IMAGE_FETCHES);
    release();
    expect((await Promise.all(all)).every((r) => r.ok)).toBe(true);
    expect(requests('/web/release-assets/')).toHaveLength(6);
  });

  it('two asks for one address are one fetch', async () => {
    const [a, b] = await Promise.all([c.loadImage(img('home.png')), c.loadImage(img('home.png'))]);
    expect(a.ok && b.ok).toBe(true);
    expect(requests('/web/release-assets/11')).toHaveLength(1);
  });
});
