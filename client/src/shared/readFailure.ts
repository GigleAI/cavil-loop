// GitHub#401: why a read did not work, said the same way everywhere it is shown — a source's row in
// Settings, an organisation in the Project picker, the board's empty-page card and the ⚠️ next to
// the refresh button. One classifier (`classifyFailure`) and one set of words (`describeFailure`);
// every place renders their output and nothing else.
//
// The order is the rule: the failures the client already tells apart (given up, no connection,
// rate limit, refused credential, GitHub's own temporary error) are settled first and never end up
// as "no access"; only then is GitHub's wording read for an organisation's restriction, single
// sign-on or a missing scope; whatever is left is "not found, or no access" without naming a cause,
// and anything else is a plain "读取失败". GitHub's own words are always kept underneath.

/** the kinds, in the order they are tried */
export const FAILURE_KINDS = ['cancelled', 'network', 'rateLimited', 'auth', 'transient', 'orgRestricted', 'sso', 'scope', 'notFound', 'other'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** What a failed read is, as data (kept with a source's status; the words come from `describeFailure`). */
export interface ReadFailure {
  kind: FailureKind;
  /** the organisation it is about (restriction / single sign-on), when known */
  org?: string;
  /** single sign-on: the page GitHub named for authorising (from its X-GitHub-SSO header) */
  ssoUrl?: string;
  /** rate limit: when reading may start again (epoch ms); absent = GitHub did not say */
  retryAt?: number;
  /** the error as raised (GitHub's words, or the connection's) */
  raw: string;
}

/** Everything the classifier looks at; built from an error by `failureInput` (data/github.ts). */
export interface FailureInput {
  /** the client's own kind of error */
  kind: 'network' | 'auth' | 'http' | 'graphql' | 'unknown';
  message: string;
  /** HTTP status, when the answer had one that matters */
  status?: number;
  /** the read was given up on (a dropped round) — not a failure */
  cancelled?: boolean;
  /** GitHub's rate limit (or the read gate it closed) */
  rateLimited?: boolean;
  /** rate limit: when GitHub said reading may start again (epoch ms); null / absent = it did not say */
  retryAt?: number | null;
  /** GitHub called it temporary (a GraphQL "something went wrong / timed out") */
  transient?: boolean;
  /** GraphQL error types (NOT_FOUND, FORBIDDEN, INSUFFICIENT_SCOPES, …) */
  gqlTypes?: string[];
  /** GitHub's X-GitHub-SSO header, when it sent one */
  sso?: string | null;
  /** GitHub's X-OAuth-Scopes header (an OAuth app's granted scopes); null / absent = not said */
  scopes?: string | null;
}

/** the organisation named in GitHub's restriction message: "… the `acme` organization has enabled …" */
const ORG_IN_MESSAGE = /`([A-Za-z0-9][A-Za-z0-9-]{0,38})`\s+organization/i;
/** GitHub's words for an organisation that has not approved this OAuth app (or a GitHub App's equivalent) */
const RESTRICTION = /OAuth App access restrictions|third-party application access|application access restrictions/i;
const SSO_WORDS = /SAML|single sign-on|\bSSO\b/i;
/** the scopes a read of Projects needs; a classic OAuth grant names them in X-OAuth-Scopes */
const PROJECT_SCOPES = ['project', 'read:project'];

function ssoUrlOf(header: string | null | undefined): string | undefined {
  const m = header?.match(/url=(\S+)/);
  if (!m) return undefined;
  try {
    const u = new URL(m[1]);
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which kind a failed read is. `org` = the organisation the read was about (a Project's or a
 * picker row's owner), used when GitHub's words do not name one. `projectRead` = the read needed
 * the Project scope (a Project, or a list of Projects): only then can a granted-scope list without
 * it explain a refusal — a missing repository is not a missing Project scope (PR #414 review round 1).
 */
export function classifyFailure(input: FailureInput, org?: string, projectRead = false): ReadFailure {
  const raw = input.message;
  const base = (kind: FailureKind, extra: Partial<ReadFailure> = {}): ReadFailure => ({ kind, raw, ...extra });
  if (input.cancelled) return base('cancelled');
  if (input.kind === 'network') return base('network');
  if (input.rateLimited) {
    return base('rateLimited', input.retryAt != null ? { retryAt: input.retryAt } : {});
  }
  if (input.kind === 'auth' || input.status === 401) return base('auth');
  const types = input.gqlTypes ?? [];
  if ((input.kind === 'http' && input.status !== undefined && input.status >= 500 && input.status <= 599) || (input.kind === 'graphql' && input.transient)) return base('transient');
  const named = raw.match(ORG_IN_MESSAGE)?.[1] ?? org;
  const withOrg = named ? { org: named } : {};
  const refused = input.status === 403 || types.includes('FORBIDDEN') || types.includes('NOT_FOUND') || input.status === 404;
  if (RESTRICTION.test(raw) && (refused || input.kind === 'graphql')) return base('orgRestricted', withOrg);
  const ssoHeader = input.sso ?? null;
  if ((ssoHeader !== null && /required/i.test(ssoHeader)) || (SSO_WORDS.test(raw) && (refused || input.kind === 'graphql'))) {
    const url = ssoUrlOf(ssoHeader);
    return base('sso', { ...withOrg, ...(url ? { ssoUrl: url } : {}) });
  }
  if (types.includes('INSUFFICIENT_SCOPES')) return base('scope');
  if (projectRead && input.scopes != null && refused) {
    const granted = input.scopes.split(',').map((s) => s.trim()).filter(Boolean);
    if (!granted.some((s) => PROJECT_SCOPES.includes(s))) return base('scope');
  }
  if (refused) return base('notFound', withOrg);
  return base('other');
}

/** a button a failure offers; the window turns each into its action */
export type FailureAction = 'retry' | 'authPage' | 'ssoPage' | 'relogin';

export interface FailureText {
  title: string;
  body: string;
  actions: FailureAction[];
  /** rate limit: "重新读取" stays off until then (epoch ms) */
  retryAt?: number;
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * The words and buttons for a failure — the only copy. `now` decides whether a rate limit's time
 * has passed (then "重新读取" is on again). `github-app` changes only the authorisation wording.
 */
export function describeFailure(f: ReadFailure, now: number, appKind: 'oauth' | 'github-app' = 'oauth'): FailureText {
  const org = f.org ? `组织 ${f.org} ` : '这个组织';
  switch (f.kind) {
    case 'cancelled':
      return { title: '这一轮读取已放弃', body: '读取被放弃（例如手动重新同步），不是失败；新一轮会接着读。', actions: [] };
    case 'network':
      return { title: '连不上 GitHub', body: '网络断开，或 GitHub 没有完整回应。这和账号权限无关，不需要重新授权；网络恢复后点「重新读取」。', actions: ['retry'] };
    case 'rateLimited': {
      const waiting = f.retryAt !== undefined && f.retryAt > now;
      return {
        title: 'GitHub 暂时限制了读取次数',
        body: waiting
          ? `请求太频繁，GitHub 要求稍等。${hhmm(f.retryAt!)} 之后会自动再读，不需要重新授权。`
          : '请求太频繁，GitHub 要求稍等。稍后会自动再读，不需要重新授权。',
        actions: ['retry'],
        ...(waiting ? { retryAt: f.retryAt } : {}),
      };
    }
    case 'auth':
      return { title: '登录已失效', body: 'GitHub 不再接受这次登录（凭据被撤销或已过期），需要重新登录。这不是 Project 的权限问题。', actions: ['relogin'] };
    case 'transient':
      return { title: 'GitHub 暂时出错', body: 'GitHub 服务端出错或超时，不代表 Project 不存在或没有权限。稍后点「重新读取」。', actions: ['retry'] };
    case 'orgRestricted':
      return {
        title: `${org}还没有批准 Cavil Loop 访问它的数据`,
        body:
          appKind === 'github-app'
            ? `${org}要先安装或批准 Cavil Loop 这个 GitHub App，才能读到它的私有仓库和 Project。请组织管理员在组织设置里批准后，回到这里点「重新读取」。`
            : `${org}开了「第三方应用访问限制」。账号本人授权过还不够，要组织管理员再批准一次；批准前读不到这个组织的私有仓库和 Project。\n1. 点「打开 GitHub 授权页」，在「Organization access」里找到${f.org ? ` ${f.org}` : '这个组织'}\n2. 旁边是「Request」就点它（发申请给管理员），是「Grant」就直接点（本人是管理员）\n3. 批准后回到这里点「重新读取」。`,
        actions: ['authPage', 'retry'],
      };
    case 'sso':
      return {
        title: `${org}要求单点登录授权`,
        body: `${org}开了 SAML 单点登录。要先在 GitHub 上用组织的单点登录授权这次登录，之后回到这里点「重新读取」。`,
        actions: [f.ssoUrl ? 'ssoPage' : 'authPage', 'retry'],
      };
    case 'scope':
      return { title: '登录时没有授予读 Project 的权限', body: '这次登录拿到的权限里没有读取 Project 所需的那一项。重新登录一次，在 GitHub 的授权页上同意全部权限。', actions: ['relogin'] };
    case 'notFound':
      return {
        title: '找不到，或当前账号 / 应用无权看',
        body: '可能是：地址或编号写错了；这是私有的 Project / 仓库，当前登录的账号看不到；或者所属组织还没批准 Cavil Loop。看不出是哪一种时不猜，可以在 GitHub 授权页确认组织的批准状态。',
        actions: ['authPage', 'retry'],
      };
    default:
      return { title: '读取失败', body: '没能读到这个来源。', actions: ['retry'] };
  }
}

/**
 * GitHub#401 / PR #414 review round 1: until when the "从 GitHub 选" list may not be read again — the
 * latest rate-limit time among its failures (the whole list, the organisation list, any one
 * organisation); null = no wait. One rule for the list's own button, each failure's button and the
 * controller, which answers a read asked for before then from what it has, without a request.
 */
export function choicesWaitUntil(r: { failure?: ReadFailure; orgsFailure?: ReadFailure; groups: { failure?: ReadFailure }[] }): number | null {
  let until: number | null = null;
  for (const f of [r.failure, r.orgsFailure, ...r.groups.map((g) => g.failure)])
    if (f?.kind === 'rateLimited' && f.retryAt !== undefined) until = Math.max(until ?? 0, f.retryAt);
  return until;
}

/** a status saved by an older version has no classification: shown as the plain "读取失败" */
export function failureOf(status: { error: string | null; failure?: ReadFailure }): ReadFailure {
  return status.failure ?? { kind: 'other', raw: status.error ?? '' };
}
