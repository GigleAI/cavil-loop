// GigleAI/cavil-loop#401: a Project the client could not read showed only GitHub's raw English
// message ("Could not resolve to a ProjectV2 with the number 3."), whatever the cause. Now every
// failure is classified once (shared/readFailure.ts), in a fixed order: the failures the client
// already tells apart (given up, no connection, rate limit, refused credential, GitHub's temporary
// error) first — never "no access" — then an organisation's restriction, single sign-on and a
// missing scope from GitHub's own words, then a plain "not found, or no access" that names no
// cause, then "读取失败". The input of each case is the error the real client raises for a real
// answer shape (a Response through GitHubClient), not a hand-built error object.

import { describe, expect, it } from 'vitest';
import { GitHubClient, failureInput } from '../../src/data/github';
import { choicesWaitUntil, classifyFailure, describeFailure, failureOf, type FailureKind, type ReadFailure } from '../../src/shared/readFailure';

const ENDPOINTS = { api: 'https://api.github.com', web: 'https://github.com' };
const NOW = Date.UTC(2026, 10, 12, 4, 0, 0);

/** what the real client raises when GitHub gives this answer to a GraphQL read */
async function raisedBy(answer: () => Response | Promise<Response>): Promise<unknown> {
  const c = new GitHubClient(ENDPOINTS, 'gho_x', async () => answer());
  try {
    await c.graphql('query CavilProjectItems { x }', {});
  } catch (e) {
    return e;
  }
  throw new Error('the read did not fail');
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const gqlErrors = (errors: { type?: string; message: string }[], headers: Record<string, string> = {}) => json(200, { data: { organization: null }, errors }, headers);

const RESTRICTED =
  'Although you appear to have the correct authorization credentials, the `acme-team` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.';
const SAML = 'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.';

async function kindOf(answer: () => Response | Promise<Response>, org?: string, projectRead = true): Promise<ReadFailure> {
  return classifyFailure(failureInput(await raisedBy(answer)), org, projectRead);
}
/** what the real client raises for a REST read (a repository source) */
async function restRaised(answer: () => Response): Promise<unknown> {
  const c = new GitHubClient(ENDPOINTS, 'gho_x', async () => answer());
  return c.restList('/repos/acme/missing/issues?state=open').then(() => { throw new Error('the read did not fail'); }, (e) => e);
}

describe('classifying a failed read (GitHub#401)', () => {
  it('no connection, or an answer cut short → network, whatever else is said', async () => {
    expect((await kindOf(() => Promise.reject(new TypeError('fetch failed')))).kind).toBe('network');
    expect((await kindOf(() => new Response('{"data":', { status: 200 }))).kind).toBe('network');
  });

  it('a given-up read → cancelled, not a failure', () => {
    const c = new GitHubClient(ENDPOINTS, 'gho_x', async () => json(200, {}), AbortSignal.abort());
    return c.graphql('query CavilViewer { viewer { login } }', {}).catch((e) => expect(classifyFailure(failureInput(e)).kind).toBe('cancelled'));
  });

  it('rate limits — 429, a 403 with the quota at 0, GraphQL RATE_LIMITED → rateLimited, with the time GitHub gave', async () => {
    const reset = Math.floor(NOW / 1000) + 12 * 60;
    const a = await kindOf(() => json(429, { message: 'too many' }, { 'retry-after': '90' }));
    expect(a.kind).toBe('rateLimited');
    expect(a.retryAt).toBeGreaterThan(Date.now() + 80_000);
    const b = await kindOf(() => json(403, { message: 'API rate limit exceeded for user ID 1.' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    expect(b).toMatchObject({ kind: 'rateLimited', retryAt: reset * 1000 });
    // GitHub said nothing about when: no time, never a made-up one
    const c = await kindOf(() => json(200, { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }));
    expect(c.kind).toBe('rateLimited');
    expect(c.retryAt).toBeUndefined();
  });

  it('a refused credential (401) → auth', async () => {
    expect((await kindOf(() => json(401, { message: 'Bad credentials' }))).kind).toBe('auth');
  });

  it("GitHub's own temporary errors → transient (even with access words in them)", async () => {
    expect((await kindOf(() => json(502, { message: 'Server Error' }))).kind).toBe('transient');
    expect((await kindOf(() => json(503, { message: 'forbidden by organization SAML enforcement' }))).kind).toBe('transient');
    expect((await kindOf(() => json(200, { errors: [{ message: 'Something went wrong while executing your query. Please try again later.' }] }))).kind).toBe('transient');
  });

  it("an organisation that has not approved the app → orgRestricted, with the organisation GitHub named", async () => {
    const f = await kindOf(() => gqlErrors([{ type: 'FORBIDDEN', message: RESTRICTED }]), 'someone-else');
    expect(f).toMatchObject({ kind: 'orgRestricted', org: 'acme-team', raw: RESTRICTED });
    // the same words over REST (a repository source)
    expect((await kindOf(() => json(403, { message: RESTRICTED }))).kind).toBe('orgRestricted');
  });

  it('single sign-on → sso; the address GitHub sent is used, an http one is not', async () => {
    const withUrl = await kindOf(() => gqlErrors([{ type: 'FORBIDDEN', message: SAML }], { 'x-github-sso': 'required; url=https://github.com/orgs/acme-team/sso?authorization_request=A1' }), 'acme-team');
    expect(withUrl).toMatchObject({ kind: 'sso', org: 'acme-team', ssoUrl: 'https://github.com/orgs/acme-team/sso?authorization_request=A1' });
    const noUrl = await kindOf(() => gqlErrors([{ type: 'FORBIDDEN', message: SAML }]), 'acme-team');
    expect(noUrl.kind).toBe('sso');
    expect(noUrl.ssoUrl).toBeUndefined();
    const http = await kindOf(() => gqlErrors([{ type: 'FORBIDDEN', message: SAML }], { 'x-github-sso': 'required; url=http://evil.example/' }));
    expect(http.ssoUrl).toBeUndefined();
    expect(describeFailure(noUrl, NOW).actions).toEqual(['authPage', 'retry']);
    expect(describeFailure(withUrl, NOW).actions).toEqual(['ssoPage', 'retry']);
  });

  it('a missing scope → scope, from GraphQL INSUFFICIENT_SCOPES or a granted-scope list without project', async () => {
    expect((await kindOf(() => json(200, { errors: [{ type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes to execute this query. The 'projectV2' field requires one of the following scopes: ['read:project']" }] }))).kind).toBe('scope');
    expect((await kindOf(() => gqlErrors([{ type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2 with the number 3.' }], { 'x-oauth-scopes': 'repo, read:org' }))).kind).toBe('scope');
    // the scope was granted: a plain not found
    expect((await kindOf(() => gqlErrors([{ type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2 with the number 3.' }], { 'x-oauth-scopes': 'project, read:org, repo' }))).kind).toBe('notFound');
  });

  it('the same 404 + granted scopes without project: scope only for a Project read — a missing repository or an organisation list is notFound (PR #414 review round 1)', async () => {
    const answer = () => json(404, { message: 'Not Found' }, { 'x-oauth-scopes': 'repo, read:org' });
    const repo = await restRaised(answer);
    expect(classifyFailure(failureInput(repo), 'acme', false).kind).toBe('notFound');
    expect(describeFailure(classifyFailure(failureInput(repo), 'acme', false), NOW).actions).not.toContain('relogin');
    expect(classifyFailure(failureInput(repo), 'acme', true).kind).toBe('scope');
    const nf = () => gqlErrors([{ type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2 with the number 3.' }], { 'x-oauth-scopes': 'repo, read:org' });
    expect((await kindOf(nf, 'acme', true)).kind).toBe('scope');
    expect((await kindOf(nf, 'acme', false)).kind).toBe('notFound');
    // GitHub saying INSUFFICIENT_SCOPES itself is believed whatever was read
    expect((await kindOf(() => json(200, { errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'scopes' }] }), undefined, false)).kind).toBe('scope');
  });

  it('a plain "not found" / "forbidden" → notFound, naming no cause; anything else → other', async () => {
    const nf = await kindOf(() => gqlErrors([{ type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2 with the number 3.' }]), 'acme-team');
    expect(nf).toMatchObject({ kind: 'notFound', org: 'acme-team' });
    expect((await kindOf(() => json(404, { message: 'Not Found' }))).kind).toBe('notFound');
    expect((await kindOf(() => json(422, { message: 'Validation Failed' }))).kind).toBe('other');
    expect((await kindOf(() => json(200, { errors: [{ message: "Field 'x' doesn't exist on type 'Query'" }] }))).kind).toBe('other');
  });

  it('order: a rate limit wins over a 403, a 5xx wins over access words, a refused credential over everything after it', () => {
    expect(classifyFailure({ kind: 'http', status: 403, message: RESTRICTED, rateLimited: true }).kind).toBe('rateLimited');
    expect(classifyFailure({ kind: 'http', status: 500, message: RESTRICTED }).kind).toBe('transient');
    expect(classifyFailure({ kind: 'auth', status: 401, message: SAML }).kind).toBe('auth');
    expect(classifyFailure({ kind: 'network', message: RESTRICTED }).kind).toBe('network');
  });

  it('a status saved by an older version (no classification) is a plain failure', () => {
    expect(failureOf({ error: 'GitHub 返回 HTTP 500' })).toEqual({ kind: 'other', raw: 'GitHub 返回 HTTP 500' });
  });
});

describe('what each kind says (GitHub#401)', () => {
  const all: Record<FailureKind, ReadFailure> = {
    cancelled: { kind: 'cancelled', raw: '已放弃这一轮同步' },
    network: { kind: 'network', raw: '无法连接 GitHub：fetch failed' },
    rateLimited: { kind: 'rateLimited', raw: 'x', retryAt: NOW + 12 * 60_000 },
    auth: { kind: 'auth', raw: 'x' },
    transient: { kind: 'transient', raw: 'x' },
    orgRestricted: { kind: 'orgRestricted', raw: 'x', org: 'acme-team' },
    sso: { kind: 'sso', raw: 'x', org: 'acme-team' },
    scope: { kind: 'scope', raw: 'x' },
    notFound: { kind: 'notFound', raw: 'x' },
    other: { kind: 'other', raw: 'x' },
  };

  it('title and buttons per kind', () => {
    const got = Object.fromEntries(Object.values(all).map((f) => [f.kind, (({ title, actions }) => ({ title, actions }))(describeFailure(f, NOW))]));
    expect(got).toEqual({
      cancelled: { title: '这一轮读取已放弃', actions: [] },
      network: { title: '连不上 GitHub', actions: ['retry'] },
      rateLimited: { title: 'GitHub 暂时限制了读取次数', actions: ['retry'] },
      auth: { title: '登录已失效', actions: ['relogin'] },
      transient: { title: 'GitHub 暂时出错', actions: ['retry'] },
      orgRestricted: { title: '组织 acme-team 还没有批准 Cavil Loop 访问它的数据', actions: ['authPage', 'retry'] },
      sso: { title: '组织 acme-team 要求单点登录授权', actions: ['authPage', 'retry'] },
      scope: { title: '登录时没有授予读 Project 的权限', actions: ['relogin'] },
      notFound: { title: '找不到，或当前账号 / 应用无权看', actions: ['authPage', 'retry'] },
      other: { title: '读取失败', actions: ['retry'] },
    });
  });

  it('no connection, a rate limit and a temporary error never send the user to authorise', () => {
    for (const k of ['network', 'rateLimited', 'transient'] as const) {
      const t = describeFailure(all[k], NOW);
      expect(t.actions).not.toContain('authPage');
      expect(t.actions).not.toContain('relogin');
      expect(t.body).toMatch(/不需要重新授权|不代表 Project 不存在或没有权限/);
    }
  });

  it('a rate limit: "重新读取" waits for the time GitHub gave; past it, or with no time, it is on', () => {
    const d = new Date(all.rateLimited.retryAt!);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const waiting = describeFailure(all.rateLimited, NOW);
    expect(waiting.retryAt).toBe(all.rateLimited.retryAt);
    expect(waiting.body).toContain(`${hhmm} 之后会自动再读`);
    expect(describeFailure(all.rateLimited, all.rateLimited.retryAt! + 1).retryAt).toBeUndefined();
    const noTime = describeFailure({ kind: 'rateLimited', raw: 'x' }, NOW);
    expect(noTime.retryAt).toBeUndefined();
    expect(noTime.body).toContain('稍后会自动再读');
  });

  it('the "从 GitHub 选" list waits for the latest rate-limit time among its failures; none = no wait', () => {
    const lim = (t: number): ReadFailure => ({ kind: 'rateLimited', raw: 'x', retryAt: t });
    expect(choicesWaitUntil({ groups: [] })).toBeNull();
    expect(choicesWaitUntil({ failure: lim(5), groups: [] })).toBe(5);
    expect(choicesWaitUntil({ orgsFailure: lim(3), groups: [{ failure: lim(9) }, { failure: { kind: 'network', raw: 'x' } }, {}] })).toBe(9);
    expect(choicesWaitUntil({ groups: [{ failure: { kind: 'rateLimited', raw: 'x' } }] })).toBeNull();
  });
});
