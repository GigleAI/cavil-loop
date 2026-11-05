// Local fake GitHub for the unit and UI tests: GraphQL (viewer + Project
// items), REST issue lists with Link pagination, and the OAuth device flow.
// Serves the recorded `cavil project` pages by default. Every request is
// logged so tests can assert what the client actually asked for.

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
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
  /** live refresh tokens -> the access token they were issued with (GitHub rotates both on refresh) */
  refreshTokens: Map<string, string>;
  refreshSeq: number;
  /** canned answers for the token endpoint, used once each, in order: `refresh` = refresh requests, `poll` = device-flow polls */
  tokenAnswers: { kind: 'refresh' | 'poll'; status: number; body?: unknown; raw?: string }[];
  /** the writable side (labels, milestones, comments, PRs, …), see writes.ts */
  w: WritableState;
}

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
    refreshTokens: new Map(),
    refreshSeq: 0,
    tokenAnswers: [],
    w: defaultWritable(),
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
    if (state.w.dropWrites && req.method !== 'GET' && (req.url ?? '').startsWith('/api/') && req.url !== '/api/graphql') {
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
      const answered = handleGraphql(store, op, body.variables ?? {});
      if (answered) {
        await held();
        if (answered.httpStatus) return send(answered.httpStatus, { message: 'Server Error' });
        return send(200, answered);
      }
      if (op === 'CavilViewer') return send(200, { data: { viewer: { login: login() } } });
      if (op === 'CavilProjectItems') {
        const v = body.variables;
        const key = `${v.isOrg ? 'org' : 'user'}/${String(v.owner).toLowerCase()}/${v.number}`;
        const pages = state.projects.get(key);
        const holder = v.isOrg ? 'organization' : 'user';
        if (!pages) return send(200, { data: { [holder]: { projectV2: null } }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a ProjectV2 with the number ${v.number}.` }] });
        const idx = v.after ? pages.findIndex((p) => p.items.pageInfo.endCursor === v.after) + 1 : 0;
        if (idx <= 0 && v.after) return send(200, { errors: [{ message: 'bad cursor' }] });
        if (state.failProjectPage.get(key) === idx) return send(502, { message: 'Server Error' });
        return send(200, { data: { [holder]: { projectV2: { ...pages[idx], viewerCanUpdate: !state.w.readOnlyProjects.has(key) } } } });
      }
      return send(200, { errors: [{ message: `fake: unknown operation ${op}` }] });
    }

    // ---- REST writes of #138, labels / milestones lists, markdown ----
    if (url.pathname.startsWith('/api/') && (req.method !== 'GET' || /\/(labels|milestones)$/.test(url.pathname))) {
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
      // the answer is computed (and a write applied) first, then held: a held
      // request carries the data of the moment it arrived, like a slow network
      const out: (() => void)[] = [];
      const handled = handleRest(
        store,
        req.method ?? 'GET',
        url.pathname + url.search,
        parsed,
        (st, b) => out.push(() => send(st, b)),
        (t) =>
          out.push(() => {
            entry.status = 200;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(t);
          }),
      );
      if (handled) {
        await held();
        for (const f of out) f();
        return;
      }
    }

    // ---- REST issue list ----
    const m = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/issues$/);
    if (req.method === 'GET' && m) {
      if (!authed()) return;
      const key = `${m[1]}/${m[2]}`.toLowerCase();
      const issues = state.repos.get(key);
      if (!issues || state.deniedRepos.get(login())?.has(key)) return send(404, { message: 'Not Found' });
      const st = url.searchParams.get('state') ?? 'open';
      const since = url.searchParams.get('since');
      const per = Math.min(Number(url.searchParams.get('per_page') ?? 30), state.restPageSize);
      const page = Number(url.searchParams.get('page') ?? 1);
      if (state.failRepoPage.get(key) === page) return send(502, { message: 'Server Error' });
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
      await held();
      return send(200, slice, headers);
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
    digest: () => digest(store),
    writes: () =>
      log.filter(
        (l) =>
          (l.path.startsWith('/api/') && l.path !== '/api/graphql' && l.path !== '/api/markdown' && l.method !== 'GET') ||
          (l.path === '/api/graphql' && /^Cavil(AddProjectItem|SetIteration|SetStatus|ClearField)$/.test(l.operation ?? '')),
      ),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
  return fake;
}
