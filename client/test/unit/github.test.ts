import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, nextLink } from '../../src/data/github';
import { join } from 'node:path';
import { HarnessBackend } from '../support/harness';
import { MemoryStore } from '../support/credentials';
import { tempDir } from './helpers';
import { GITHUB_IMAGE_HOSTS } from '../../src/shared/avatar';

describe('GitHub client boundaries', () => {
  it('parses Link headers', () => {
    expect(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"')).toBe('https://api.github.com/x?page=2');
    expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });

  it('refuses to follow a pagination link to another host (the token would go with it)', async () => {
    const seen: string[] = [];
    // only the first page links onward, so a client that does follow it still terminates
    const fetchImpl = async (u: string) => {
      seen.push(u);
      const headers: Record<string, string> = seen.length === 1 ? { Link: '<https://evil.example/x?page=2>; rel="next"' } : {};
      return new Response('[]', { status: 200, headers });
    };
    const c = new GitHubClient({ api: 'https://api.github.com', web: 'https://github.com' }, 'gho_x', fetchImpl);
    await expect(c.restList('/repos/a/b/issues')).rejects.toThrow(/其他主机/);
    expect(seen).toEqual(['https://api.github.com/repos/a/b/issues']);
  });

  it('classifies 401 as auth and connection failures as network', async () => {
    const c401 = new GitHubClient({ api: 'https://api.github.com', web: '' }, 't', async () => new Response('{}', { status: 401 }));
    await expect(c401.graphql('query X {x}', {})).rejects.toMatchObject({ kind: 'auth' });
    const cNet = new GitHubClient({ api: 'https://api.github.com', web: '' }, 't', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(cNet.graphql('query X {x}', {})).rejects.toMatchObject({ kind: 'network' });
    const c502 = new GitHubClient({ api: 'https://api.github.com', web: '' }, 't', async () => new Response('{"message":"x"}', { status: 502 }));
    const e = (await c502.graphql('query X {x}', {}).catch((x: unknown) => x)) as GitHubError;
    expect(e).toBeInstanceOf(GitHubError);
    expect(e.kind).toBe('http');
  });
});

// The platform rules live in the back end (src-tauri/crates/core): asked through the test harness.
describe('platform layer (back end)', () => {
  let b: HarnessBackend;
  beforeAll(() => {
    b = new HarnessBackend({ db: join(tempDir(), 'cache.sqlite'), endpoints: { api: 'http://127.0.0.1:1/api', web: 'http://127.0.0.1:1/web' }, credentials: new MemoryStore() });
  });
  afterAll(() => b.close());
  const isAllowedExternal = (url: string, ep: { api: string; web: string }) => b.call<boolean>('test.allowedExternal', { url, ...ep });
  const select = (os: string, env: Record<string, string>) => b.call<{ api?: string; web?: string; store?: string; error?: string }>('test.selectPlatform', { os, env });

  it('only github.com (or the loopback test server) may be opened in the browser', async () => {
    const prod = { api: 'https://api.github.com', web: 'https://github.com' };
    expect(await isAllowedExternal('https://github.com/login/device', prod)).toBe(true);
    expect(await isAllowedExternal('https://github.com.evil.example/', prod)).toBe(false);
    expect(await isAllowedExternal('http://127.0.0.1:9/web/login/device', prod)).toBe(false);
    expect(await isAllowedExternal('javascript:alert(1)', prod)).toBe(false);
    expect(await isAllowedExternal('http://127.0.0.1:9/web/x', { api: 'http://127.0.0.1:9/api', web: 'http://127.0.0.1:9/web' })).toBe(true);
  });

  it('GitHub#205: an image in the discussion (GitHub\'s own image hosts, the same list the pages load from) opens in the browser; look-alikes do not', async () => {
    const prod = { api: 'https://api.github.com', web: 'https://github.com' };
    for (const h of GITHUB_IMAGE_HOSTS) {
      expect(await isAllowedExternal(`${h}/307601/a.png?jwt=x`, prod)).toBe(true);
      expect(await isAllowedExternal(`${h.replace('https:', 'http:')}/a.png`, prod)).toBe(false);
      expect(await isAllowedExternal(`${h}.evil.example/a.png`, prod)).toBe(false);
    }
    expect(await isAllowedExternal('https://raw.githubusercontent.com/o/r/main/a.png', prod)).toBe(false);
    expect(await isAllowedExternal('https://avatars.githubusercontent.com/u/1', prod)).toBe(false);
    expect(await isAllowedExternal('https://github-production-user-asset-6210df.s3.amazonaws.com/1/a.png', prod)).toBe(false);
  });

  it('a link the window asks to open that is not GitHub: refused, nothing opened', async () => {
    const opened: string[] = [];
    const h = new HarnessBackend({ db: join(tempDir(), 'cache.sqlite'), endpoints: { api: 'http://127.0.0.1:9/api', web: 'http://127.0.0.1:9/web' }, credentials: new MemoryStore(), opened });
    await expect(h.call('openExternal', { url: 'https://example.com/' })).rejects.toThrow(/不打开非 GitHub 链接/);
    await h.call('openExternal', { url: 'https://github.com/GigleAI/cavil-loop' });
    expect(opened).toEqual(['https://github.com/GigleAI/cavil-loop']);
    await h.close();
  });

  it('test endpoints are only honoured in test mode and only on loopback', async () => {
    const off = await select('linux', { CAVIL_CLIENT_TEST_API: 'http://127.0.0.1:1/api', CAVIL_CLIENT_TEST_WEB: 'http://127.0.0.1:1/web' });
    expect(off.api).toBe('https://api.github.com');
    expect((await select('linux', { CAVIL_CLIENT_TEST_MODE: '1', CAVIL_CLIENT_TEST_API: 'http://evil.example/api', CAVIL_CLIENT_TEST_WEB: 'http://127.0.0.1:1/web' })).error).toBeTruthy();
    const on = await select('linux', { CAVIL_CLIENT_TEST_MODE: '1', CAVIL_CLIENT_TEST_API: 'http://127.0.0.1:1/api', CAVIL_CLIENT_TEST_WEB: 'http://127.0.0.1:1/web' });
    expect({ api: on.api, web: on.web }).toEqual({ api: 'http://127.0.0.1:1/api', web: 'http://127.0.0.1:1/web' });
    // a credential file is a test-mode thing only
    expect((await select('macos', { CAVIL_CLIENT_TEST_CREDENTIAL_FILE: '/tmp/x' })).store).toBe('keychain');
    expect((await select('linux', { CAVIL_CLIENT_TEST_MODE: '1', CAVIL_CLIENT_TEST_CREDENTIAL_FILE: '/tmp/x' })).store).toBe('file:/tmp/x');
  });

  it('macOS uses the keychain store; other platforms keep the token for this run only', async () => {
    expect((await select('macos', {})).store).toBe('keychain');
    expect((await select('linux', {})).store).toBe('memory');
  });
});
