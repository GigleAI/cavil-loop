import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, nextLink } from '../../src/data/github';
import { isAllowedExternal, createPlatform } from '../../src/platform';
import { assertTokenShape } from '../../src/platform/credentials';

describe('GitHub client boundaries', () => {
  it('parses Link headers', () => {
    expect(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"')).toBe('https://api.github.com/x?page=2');
    expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });

  it('refuses to follow a pagination link to another host (the token would go with it)', async () => {
    const seen: string[] = [];
    const fetchImpl = async (u: string) => {
      seen.push(u);
      return new Response('[]', { status: 200, headers: { Link: '<https://evil.example/x?page=2>; rel="next"' } });
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

describe('platform layer', () => {
  it('only github.com (or the loopback test server) may be opened in the browser', () => {
    const prod = { api: 'https://api.github.com', web: 'https://github.com' };
    expect(isAllowedExternal('https://github.com/login/device', prod)).toBe(true);
    expect(isAllowedExternal('https://github.com.evil.example/', prod)).toBe(false);
    expect(isAllowedExternal('http://127.0.0.1:9/web/login/device', prod)).toBe(false);
    expect(isAllowedExternal('javascript:alert(1)', prod)).toBe(false);
    expect(isAllowedExternal('http://127.0.0.1:9/web/x', { api: 'http://127.0.0.1:9/api', web: 'http://127.0.0.1:9/web' })).toBe(true);
  });

  it('test endpoints are only honoured in test mode and only on loopback', () => {
    const open = async () => {};
    const off = createPlatform({ platform: 'linux', env: { CAVIL_CLIENT_TEST_API: 'http://127.0.0.1:1/api', CAVIL_CLIENT_TEST_WEB: 'http://127.0.0.1:1/web' }, shellOpen: open });
    expect(off.endpoints.api).toBe('https://api.github.com');
    expect(() =>
      createPlatform({ platform: 'linux', env: { CAVIL_CLIENT_TEST_MODE: '1', CAVIL_CLIENT_TEST_API: 'http://evil.example/api', CAVIL_CLIENT_TEST_WEB: 'http://127.0.0.1:1/web' }, shellOpen: open }),
    ).toThrow();
    const on = createPlatform({ platform: 'linux', env: { CAVIL_CLIENT_TEST_MODE: '1', CAVIL_CLIENT_TEST_API: 'http://127.0.0.1:1/api', CAVIL_CLIENT_TEST_WEB: 'http://127.0.0.1:1/web' }, shellOpen: open });
    expect(on.endpoints).toEqual({ api: 'http://127.0.0.1:1/api', web: 'http://127.0.0.1:1/web' });
  });

  it('macOS uses the keychain store; other platforms keep the token for this run only', () => {
    const open = async () => {};
    expect(createPlatform({ platform: 'darwin', env: {}, shellOpen: open }).credentials.constructor.name).toBe('MacKeychainStore');
    expect(createPlatform({ platform: 'linux', env: {}, shellOpen: open }).credentials.persistent).toBe(false);
  });

  it('token shape is checked before it reaches the keychain command line', () => {
    expect(() => assertTokenShape('gho_' + 'a'.repeat(36))).not.toThrow();
    expect(() => assertTokenShape('gho_x" -w "evil')).toThrow();
  });
});
