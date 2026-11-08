// Local fake GitHub for the unit and UI tests: GraphQL (viewer + Project
// items), REST issue lists with Link pagination, and the OAuth device flow.
// Serves the recorded `cavil project` pages by default. Every request is
// logged so tests can assert what the client actually asked for.

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import { defaultWritable, digest, enrich, handleGraphql, handleRest, type Store, type WritableState } from './writes';

export type { WritableState } from './writes';

const here = dirname(fileURLToPath(import.meta.url));

export interface FixtureProjectPage {
  id: string;
  title: string;
  url: string;
  fields: { nodes: unknown[] };
  views?: { nodes: any[] };
  items: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: any[] };
}

export function loadCavilProjectPages(): FixtureProjectPage[] {
  return JSON.parse(readFileSync(join(here, '../fixtures/cavil-project-11.pages.json'), 'utf8')).pages;
}
export function loadCavilRepoIssues(): any[] {
  return JSON.parse(readFileSync(join(here, '../fixtures/cavil-loop.issues.json'), 'utf8')).issues;
}

export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  slowDownOnce?: boolean;
  token: string;
  /** the app the device code was requested for; polling must use the same one */
  clientId: string;
  /** GitHub App style grant: the token expires and comes with a refresh token */
  refreshToken?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
}

export interface FakeState {
  viewer: string;
  validTokens: Set<string>;
  /** key: `${ownerType}/${owner}/${number}` lower-cased -> GraphQL pages */
  projects: Map<string, FixtureProjectPage[]>;
  /** key: `owner/name` lower-cased -> REST issues */
  repos: Map<string, any[]>;
  restPageSize: number;
  /** drop every connection (simulates being offline) */
  offline: boolean;
  /** drop only API connections (sign-in / refresh still answer) */
  offlineApi: boolean;
  /** fail a given Project page index (0-based) with HTTP 502 */
  failProjectPage: Map<string, number>;
  /** fail REST lists for a repo with HTTP 502 on this page (1-based) */
  failRepoPage: Map<string, number>;
  /** the fake's OAuth app (an OAuth-app-shaped ID) */
  oauthClientId: string;
  /** the fake's GitHub App (a GitHub-App-shaped ID); both are accepted */
  appClientId: string;
  /** refresh token -> Client ID it was issued to: refreshing needs that same app, as on GitHub */
  refreshClients: Map<string, string>;
  grants: DeviceGrant[];
  deviceInterval: number;
  deviceExpiresIn: number;
  nextGrant: Partial<DeviceGrant>;
  /** `scope` sent with the latest device-code request */
  lastScope: string | null;
  /** client_id of every device-code request, in order */
  deviceClientIds: string[];
  /** token -> login; tokens not listed are `viewer` */
  tokenViewers: Map<string, string>;
  /** login -> repos (`owner/name` lower-cased) that answer 404 for that account */
  deniedRepos: Map<string, Set<string>>;
  /** responses of matching paths wait for `release()` (after the response is computed) */
  holds: { match: (path: string, entry: LoggedRequest) => boolean; gate: Promise<void> }[];
  /**
   * GitHub#250: REST writes whose connection is dropped. `apply: 'now'` = carried out, then the
   * answer is lost; `apply: 'later'` = the client sees the connection drop at once, the write is
   * carried out only when `land()` of `lateWhen` is called (it arrived and lands late).
   */
  lost: { match: (entry: LoggedRequest) => boolean; apply: 'now' | 'later'; pending: (() => void)[]; caught: number }[];
  /** live refresh tokens -> the access token they were issued with (GitHub rotates both on refresh) */
  refreshTokens: Map<string, string>;
  refreshSeq: number;
  /** canned answers for the token endpoint, used once each, in order: `refresh` = refresh requests, `poll` = device-flow polls */
  tokenAnswers: { kind: 'refresh' | 'poll'; status: number; body?: unknown; raw?: string }[];
  /** the writable side (labels, milestones, comments, PRs, …), see writes.ts */
  w: WritableState;
  /** GitHub#261: answer matching change-check requests (board field / item lists, repo HEAD) this way; null = honestly */
  checkFault: ((e: LoggedRequest) => CheckFault | null) | null;
}

/**
 * GitHub#261: how the fake answers one change-check request instead of honestly: an HTTP error,
 * a 200 without a version tag, or 304 whatever changed (a GitHub that lags behind its own data).
 */
export type CheckFault = { status: number } | 'no-etag' | 'not-modified';

export interface LoggedRequest {
  method: string;
  path: string;
  operation?: string;
  variables?: Record<string, unknown>;
  auth: string | null;
  status: number;
  /** parsed JSON body of a REST request that has one */
  body?: unknown;
}

export interface FakeGitHub {
  url: string;
  api: string;
  web: string;
  state: FakeState;
  log: LoggedRequest[];
  /** mark the pending grant for this user code (or the latest) approved/denied/expired */
  resolveGrant(state: DeviceGrant['state'], userCode?: string): DeviceGrant;
  /** hold responses of paths containing `fragment` until the returned function is called */
  hold(fragment: string): () => void;
  /** hold responses of requests matching `pred` (GraphQL: operation + variables are filled) until released */
  holdWhen(pred: (entry: LoggedRequest) => boolean): () => void;
  /** GitHub#250: matching REST writes are carried out, then their connection is dropped (the answer is lost) */
  dropAnswerWhen(pred: (entry: LoggedRequest) => boolean): { caught: () => number; stop: () => void };
  /** GitHub#250: matching REST writes see the connection drop at once and are carried out only on `land()` */
  lateWhen(pred: (entry: LoggedRequest) => boolean): { caught: () => number; land: () => void; stop: () => void };
  /** everything writable, serialised: equal before / after = GitHub changed nothing */
  digest(): string;
  /** requests that ask GitHub to change something (REST non-GET except the markdown renderer, GraphQL mutations) */
  writes(): LoggedRequest[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** GitHub#261: a version tag over exactly what the answer carries (GitHub's are a hash of the body too). */
export function etagOf(body: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(body)).digest('hex')}"`;
}

/**
 * GitHub#261: a REST list answer the way GitHub sends it to a conditional request — the tag
 * matches If-None-Match: 304, no body, no Link header (GitHub sends none with a 304, measured);
 * otherwise 200 with ETag (and the body unless HEAD).
 */
function conditional(req: IncomingMessage, res: ServerResponse, entry: LoggedRequest, body: unknown, headers: Record<string, string> = {}, fault: CheckFault | null = null) {
  const tag = etagOf(body);
  if (fault && typeof fault === 'object') {
    entry.status = fault.status;
    res.writeHead(fault.status, { 'Content-Type': 'application/json' });
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ message: 'fault' }));
  }
  if (fault === 'no-etag') {
    entry.status = 200;
    res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  }
  if (fault === 'not-modified' || req.headers['if-none-match'] === tag) {
    entry.status = 304;
    res.writeHead(304, { ETag: tag });
    return res.end();
  }
  entry.status = 200;
  res.writeHead(200, { 'Content-Type': 'application/json', ETag: tag, ...headers });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
}

export async function startFakeGitHub(init: Partial<FakeState> = {}): Promise<FakeGitHub> {
  const state: FakeState = {
    viewer: 'user-1',
    validTokens: new Set(['gho_faketoken000000000000000000000001']),
    projects: new Map([['org/gigleai/11', loadCavilProjectPages()]]),
    repos: new Map([['gigleai/cavil-loop', loadCavilRepoIssues()]]),
    restPageSize: 100,
    offline: false,
    offlineApi: false,
    failProjectPage: new Map(),
    failRepoPage: new Map(),
    oauthClientId: 'Ov23lifakeoauthapp00',
    appClientId: 'Iv1.fakeappclientid',
    refreshClients: new Map(),
    grants: [],
    deviceInterval: 1,
    deviceExpiresIn: 900,
    nextGrant: {},
    lastScope: null,
    deviceClientIds: [],
    tokenViewers: new Map(),
    deniedRepos: new Map(),
    holds: [],
    lost: [],
    refreshTokens: new Map(),
    refreshSeq: 0,
    tokenAnswers: [],
    w: defaultWritable(),
    checkFault: null,
    ...init,
  };
  const store: Store = { projects: state.projects, repos: state.repos, w: state.w };
  enrich(store);
  const log: LoggedRequest[] = [];
  const sockets = new Set<Socket>();
  let grantSeq = 0;

  const server: Server = createServer(async (req, res) => {
    if (state.offline || (state.offlineApi && (req.url ?? '').startsWith('/api/'))) {
      req.socket.destroy();
      return;
    }
    if (state.w.dropWrites && req.method !== 'GET' && req.method !== 'HEAD' && (req.url ?? '').startsWith('/api/') && req.url !== '/api/graphql') {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const auth = (req.headers.authorization as string | undefined) ?? null;
    const entry: LoggedRequest = { method: req.method ?? 'GET', path: url.pathname + url.search, auth, status: 0 };
    log.push(entry);
    const send = (status: number, body: unknown, headers?: Record<string, string>) => {
      entry.status = status;
      json(res, status, body, headers);
    };
    const token = auth?.replace(/^Bearer\s+/i, '') ?? '';
    const login = () => state.tokenViewers.get(token) ?? state.viewer;
    const authed = () => {
      if (state.validTokens.has(token)) return true;
      send(401, { message: 'Bad credentials' });
      return false;
    };
    const held = async () => {
      for (const h of state.holds) if (h.match(entry.path, entry)) await h.gate;
    };

    // ---- OAuth device flow (web base) ----
    if (req.method === 'POST' && url.pathname === '/web/login/device/code') {
      const form = new URLSearchParams(await readBody(req));
      state.lastScope = form.get('scope');
      state.deviceClientIds.push(form.get('client_id') ?? '');
      const clientId = form.get('client_id') ?? '';
      if (clientId !== state.oauthClientId && clientId !== state.appClientId) return send(200, { error: 'incorrect_client_credentials', error_description: 'The client_id is not valid.' });
      grantSeq++;
      const g: DeviceGrant = {
        deviceCode: `dc-${grantSeq}`,
        userCode: `ABCD-${String(1000 + grantSeq)}`,
        state: 'pending',
        token: `gho_faketoken${String(grantSeq).padStart(24, '0')}`,
        clientId,
        ...state.nextGrant,
      };
      state.nextGrant = {};
      state.grants.push(g);
      return send(200, {
        device_code: g.deviceCode,
        user_code: g.userCode,
        verification_uri: `${fake.web}/login/device`,
        expires_in: state.deviceExpiresIn,
        interval: state.deviceInterval,
      });
    }
    if (req.method === 'POST' && url.pathname === '/web/login/oauth/access_token') {
      const form = new URLSearchParams(await readBody(req));
      const kind = form.get('grant_type') === 'refresh_token' ? 'refresh' : 'poll';
      if (kind === 'refresh') entry.operation = 'refresh';
      const canned = state.tokenAnswers.findIndex((a) => a.kind === kind);
      if (canned >= 0) {
        const [a] = state.tokenAnswers.splice(canned, 1);
        await held();
        entry.status = a.status;
        res.writeHead(a.status, { 'Content-Type': 'application/json' });
        return res.end(a.raw ?? JSON.stringify(a.body ?? {}));
      }
      if (kind === 'refresh') {
        await held();
        const old = form.get('refresh_token') ?? '';
        const oldAccess = state.refreshTokens.get(old);
        if (!oldAccess || form.get('client_id') !== state.refreshClients.get(old)) {
          return send(200, { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
        }
        state.refreshSeq++;
        const access = `ghu_fakerefreshed${String(state.refreshSeq).padStart(20, '0')}`;
        const refresh = `ghr_fakerefresh${String(state.refreshSeq).padStart(22, '0')}`;
        state.refreshTokens.delete(old); // rotated: the old refresh token is spent
        state.refreshTokens.set(refresh, access);
        state.refreshClients.set(refresh, state.refreshClients.get(old)!);
        state.validTokens.add(access);
        const who = state.tokenViewers.get(oldAccess);
        if (who) state.tokenViewers.set(access, who);
        return send(200, { access_token: access, token_type: 'bearer', scope: '', expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600 });
      }
      const g = state.grants.find((x) => x.deviceCode === form.get('device_code'));
      if (!g || form.get('client_id') !== g.clientId) return send(200, { error: 'incorrect_device_code' });
      if (g.slowDownOnce) {
        g.slowDownOnce = false;
        return send(200, { error: 'slow_down', interval: state.deviceInterval + 1 });
      }
      if (g.state === 'pending') return send(200, { error: 'authorization_pending' });
      if (g.state === 'denied') return send(200, { error: 'access_denied' });
      if (g.state === 'expired') return send(200, { error: 'expired_token' });
      state.validTokens.add(g.token);
      if (g.refreshToken) {
        state.refreshTokens.set(g.refreshToken, g.token);
        state.refreshClients.set(g.refreshToken, g.clientId);
        return send(200, {
          access_token: g.token,
          token_type: 'bearer',
          scope: '',
          expires_in: g.expiresIn ?? 28800,
          refresh_token: g.refreshToken,
          refresh_token_expires_in: g.refreshExpiresIn ?? 15897600,
        });
      }
      return send(200, { access_token: g.token, token_type: 'bearer', scope: 'project,read:org,repo' });
    }
    if (req.method === 'GET' && url.pathname === '/web/login/device') {
      entry.status = 200;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<h1>fake device page</h1>');
    }

    // ---- GraphQL ----
    if (req.method === 'POST' && url.pathname === '/api/graphql') {
      const body = JSON.parse(await readBody(req)) as { query: string; variables: Record<string, any> };
      const opm = body.query.match(/(query|mutation)\s+(\w+)/);
      const op = opm?.[2];
      entry.operation = op;
      entry.variables = body.variables;
      if (opm?.[1] === 'mutation' && state.w.dropWrites) {
        req.socket.destroy();
        return;
      }
      if (!authed()) return;
      const live = handleGraphql(store, op, body.variables ?? {});
      if (live) {
        // frozen now (GitHub#229): a held answer carries the data of the moment it arrived
        const answered = JSON.parse(JSON.stringify(live));
        await held();
        if (answered.httpStatus) return send(answered.httpStatus, { message: 'Server Error' });
        return send(200, answered);
      }
      if (op === 'CavilViewer') return send(200, { data: { viewer: { login: login() } } });
      if (op === 'CavilProjectCounts') {
        // GitHub#261: p<i>: organization|user(login: $o<i>) { projectV2(number: $n<i>) { items { totalCount } } }
        const v = body.variables ?? {};
        const data: Record<string, unknown> = {};
        const errors: { type: string; message: string }[] = [];
        for (const m of body.query.matchAll(/p(\d+): (organization|user)\(login: \$o\d+\)/g)) {
          const i = m[1];
          const key = `${m[2] === 'organization' ? 'org' : 'user'}/${String(v[`o${i}`]).toLowerCase()}/${v[`n${i}`]}`;
          const pages = state.projects.get(key);
          if (!pages) {
            data[`p${i}`] = { projectV2: null };
            errors.push({ type: 'NOT_FOUND', message: `Could not resolve to a ProjectV2 with the number ${v[`n${i}`]}.` });
          } else data[`p${i}`] = { projectV2: { items: { totalCount: pages.reduce((n, p) => n + p.items.nodes.length, 0) } } };
        }
        const frozen = JSON.parse(JSON.stringify(errors.length ? { data, errors } : { data }));
        await held();
        return send(200, frozen);
      }
      if (op === 'CavilProjectItems') {
        const v = body.variables;
        const key = `${v.isOrg ? 'org' : 'user'}/${String(v.owner).toLowerCase()}/${v.number}`;
        const pages = state.projects.get(key);
        const holder = v.isOrg ? 'organization' : 'user';
        if (!pages) return send(200, { data: { [holder]: { projectV2: null } }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a ProjectV2 with the number ${v.number}.` }] });
        const idx = v.after ? pages.findIndex((p) => p.items.pageInfo.endCursor === v.after) + 1 : 0;
        if (idx <= 0 && v.after) return send(200, { errors: [{ message: 'bad cursor' }] });
        if (state.failProjectPage.get(key) === idx) return send(502, { message: 'Server Error' });
        // frozen now, then held like every other read (GitHub#229)
        const frozen = JSON.parse(JSON.stringify({ data: { [holder]: { projectV2: { ...pages[idx], viewerCanUpdate: !state.w.readOnlyProjects.has(key) } } } }));
        await held();
        return send(200, frozen);
      }
      return send(200, { errors: [{ message: `fake: unknown operation ${op}` }] });
    }

    // ---- GitHub#261: a board's REST field list and item list (what the change check reads) ----
    const pm = url.pathname.match(/^\/api\/(orgs|users)\/([^/]+)\/projectsV2\/(\d+)\/(fields|items)$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && pm) {
      if (!authed()) return;
      const key = `${pm[1] === 'orgs' ? 'org' : 'user'}/${decodeURIComponent(pm[2]).toLowerCase()}/${pm[3]}`;
      const pages = state.projects.get(key);
      if (!pages) return send(404, { message: 'Not Found' });
      if (state.failProjectPage.has(key)) return send(502, { message: 'Server Error' });
      // the fields as REST lists them: numeric ids (1, 2, …), each with everything the board read shows of it
      const fields = (pages[0]?.fields.nodes ?? []).map((f: any, i: number) => ({ id: i + 1, ...f }));
      const fault = state.checkFault?.(entry) ?? null;
      if (pm[4] === 'fields') {
        const frozen = JSON.parse(JSON.stringify(fields));
        await held();
        return conditional(req, res, entry, frozen, {}, fault);
      }
      // items: every node of every page, 100 a page, cursor = offset; the body carries each item
      // whole (content + field values) and the field ids asked for, as GitHub's does
      const per = Math.min(Number(url.searchParams.get('per_page') ?? 30), 100);
      const at = Number(url.searchParams.get('after') ?? 0);
      const all = pages.flatMap((p) => p.items.nodes);
      const slice = all.slice(at, at + per);
      const headers: Record<string, string> = {};
      if (at + per < all.length) {
        const next = new URL(`${fake.api}${url.pathname.replace(/^\/api/, '')}`);
        url.searchParams.forEach((val, k) => next.searchParams.set(k, val));
        next.searchParams.set('after', String(at + per));
        headers.Link = `<${next.toString()}>; rel="next"`;
      }
      const frozen = JSON.parse(JSON.stringify({ fields: url.searchParams.get('fields') ?? '', items: slice }));
      await held();
      return conditional(req, res, entry, frozen, headers, fault);
    }

    // ---- REST writes of #138, labels / milestones lists, markdown ----
    if (url.pathname.startsWith('/api/') && ((req.method !== 'GET' && req.method !== 'HEAD') || /\/(labels|milestones)$/.test(url.pathname) || /\/issues\/\d+\/(comments|events)$/.test(url.pathname))) {
      const raw = req.method === 'GET' ? '' : await readBody(req);
      let parsed: any = undefined;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        return send(400, { message: 'Problems parsing JSON' });
      }
      entry.body = parsed;
      if (!authed()) return;
      if (state.offlineApi) {
        req.socket.destroy();
        return;
      }
      // GitHub#250: a write whose answer is lost (carried out now or later)
      const lost = req.method !== 'GET' ? state.lost.find((l) => l.match(entry)) : undefined;
      if (lost) {
        lost.caught++;
        const run = () =>
          handleRest(
            store,
            req.method ?? 'GET',
            url.pathname + url.search,
            parsed,
            () => {},
            () => {},
            login(),
          );
        if (lost.apply === 'now') run();
        else lost.pending.push(run);
        entry.status = -1;
        req.socket.destroy();
        return;
      }
      // the answer is computed (and a write applied) first, then held: a held
      // request carries the data of the moment it arrived, like a slow network
      const out: (() => void)[] = [];
      const handled = handleRest(
        store,
        req.method ?? 'GET',
        url.pathname + url.search,
        parsed,
        // frozen now (GitHub#229): a held answer must not pick up a write that arrived after it
        (st, b) => {
          const frozen = b === undefined ? undefined : JSON.parse(JSON.stringify(b));
          out.push(() => send(st, frozen));
        },
        (t) =>
          out.push(() => {
            entry.status = 200;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(t);
          }),
        login(),
      );
      if (handled) {
        await held();
        for (const f of out) f();
        return;
      }
    }

    // ---- REST issue list ----
    const m = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/issues$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && m) {
      if (!authed()) return;
      const key = `${m[1]}/${m[2]}`.toLowerCase();
      const issues = state.repos.get(key);
      if (!issues || state.deniedRepos.get(login())?.has(key)) return send(404, { message: 'Not Found' });
      const st = url.searchParams.get('state') ?? 'open';
      const since = url.searchParams.get('since');
      const per = Math.min(Number(url.searchParams.get('per_page') ?? 30), state.restPageSize);
      const page = Number(url.searchParams.get('page') ?? 1);
      if (state.failRepoPage.get(key) === page) return send(502, { message: 'Server Error' });
      // GitHub#261: a repository set to fail fails its change check too (the round then reads it in full, and fails there)
      if (req.method === 'HEAD' && state.failRepoPage.has(key)) return send(502, { message: 'Server Error' });
      const all = issues
        .filter((i) => st === 'all' || i.state === st)
        .filter((i) => !since || i.updated_at >= since)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      const slice = all.slice((page - 1) * per, page * per);
      const headers: Record<string, string> = {};
      if (page * per < all.length) {
        const next = new URL(`${fake.api}${url.pathname.replace(/^\/api/, '')}`);
        url.searchParams.forEach((val, k) => next.searchParams.set(k, val));
        next.searchParams.set('page', String(page + 1));
        headers.Link = `<${next.toString()}>; rel="next"`;
      }
      // frozen now (GitHub#229): a held answer carries the data of the moment it arrived
      const frozen = JSON.parse(JSON.stringify(slice));
      await held();
      // GitHub#261: with a version tag, answered 304 when it still matches
      return conditional(req, res, entry, frozen, headers, req.method === 'HEAD' ? (state.checkFault?.(entry) ?? null) : null);
    }
    send(404, { message: 'Not Found' });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const fake: FakeGitHub = {
    url: base,
    api: `${base}/api`,
    web: `${base}/web`,
    state,
    log,
    resolveGrant(to, userCode) {
      const g = userCode ? state.grants.find((x) => x.userCode === userCode) : state.grants[state.grants.length - 1];
      if (!g) throw new Error('fake: no grant to resolve');
      g.state = to;
      return g;
    },
    hold(fragment) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const h = { match: (p: string) => p.includes(fragment), gate };
      state.holds.push(h);
      return () => {
        state.holds = state.holds.filter((x) => x !== h);
        release();
      };
    },
    holdWhen(pred) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const h = { match: (_p: string, e: LoggedRequest) => pred(e), gate };
      state.holds.push(h);
      return () => {
        state.holds = state.holds.filter((x) => x !== h);
        release();
      };
    },
    dropAnswerWhen(pred) {
      const l = { match: pred, apply: 'now' as const, pending: [], caught: 0 };
      state.lost.push(l);
      return { caught: () => l.caught, stop: () => void (state.lost = state.lost.filter((x) => x !== l)) };
    },
    lateWhen(pred) {
      const l = { match: pred, apply: 'later' as const, pending: [] as (() => void)[], caught: 0 };
      state.lost.push(l);
      return {
        caught: () => l.caught,
        land: () => {
          for (const f of l.pending.splice(0)) f();
        },
        stop: () => void (state.lost = state.lost.filter((x) => x !== l)),
      };
    },
    digest: () => digest(store),
    writes: () =>
      log.filter(
        (l) =>
          (l.path.startsWith('/api/') && l.path !== '/api/graphql' && l.path !== '/api/markdown' && l.method !== 'GET' && l.method !== 'HEAD') ||
          (l.path === '/api/graphql' && /^Cavil(AddProjectItem|SetIteration|SetStatus|ClearField|UpdateComment|UpdateIssueBody|UpdatePrBody)$/.test(l.operation ?? '')),
      ),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
  return fake;
}
