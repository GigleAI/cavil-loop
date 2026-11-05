// What the app says about the two sign-in methods, in one place: the login
// page, Settings and the "what is the difference" page all read it, and the
// controller uses the same Client ID check before it contacts GitHub
// (GigleAI/cavil-loop#140 review round 1).
//
// What the app can and cannot promise:
// - The OAuth app's scopes are what this client asks for (repo, read:org,
//   project), so those it can state.
// - A GitHub App's permissions are whatever that App was registered with;
//   the sign-in request cannot narrow them, and there is no built-in GitHub App
//   to vouch for. So it never promises "no code access" for a GitHub App.
// - Whether a token expires is a setting of the app (GitHub Apps default to
//   on, OAuth apps can turn it on too), not of the method; the client handles
//   both, so it never states a fixed lifetime for either.

import type { AppKind } from './types';

/**
 * GitHub App Client IDs start with "Iv" (Iv1.… / Iv23li…); OAuth app IDs do
 * not (Ov23li… or 20 hex digits). A mismatch would sign in through a
 * different kind of app than the page describes, so it is refused.
 * Returns null when the pair is fine (or there is no ID yet).
 */
export function clientIdKindProblem(kind: AppKind, clientId: string): string | null {
  const v = clientId.trim();
  if (!v) return null;
  const isAppId = /^Iv/.test(v);
  if (kind === 'github-app' && !isAppId) {
    return '这个 Client ID 不是 GitHub App 的（GitHub App 的以 Iv 开头，例如 Iv23li…）。它是 OAuth 应用的：要用它，请把登录方式改回「OAuth 应用」。';
  }
  if (kind === 'oauth' && isAppId) {
    return '这个 Client ID 是 GitHub App 的（以 Iv 开头）。要用它，请把登录方式改成「GitHub App」。';
  }
  return null;
}

/** The permission line under the choice; never promises more than is known. */
export function permissionText(kind: AppKind, clientId: string): string {
  if (clientIdKindProblem(kind, clientId)) return '所填的 Client ID 和登录方式对不上，登录前请先改好。';
  return kind === 'github-app'
    ? '用 GitHub App 时，权限由那个 App 登记时勾选的决定，登录时没法再收窄；GitHub 授权页上列的才算数。本应用这一版只读取看板数据。'
    : 'GitHub 授权页上会列出：repo（仓库读写，含代码与设置）、read:org、project——OAuth 应用读私有仓库只能要整个 repo。本应用这一版只读取看板数据。';
}

export const APP_KIND_FACTS: { topic: string; oauth: string; app: string }[] = [
  {
    topic: '第一次用，要谁点头',
    oauth: '你在浏览器里点「授权」就行。只有组织开了「第三方应用访问限制」时，要组织管理员批准一次；批准前看不到这个组织的私有仓库和 Project。',
    app: '组织管理员（或仓库所有者）要先把这个 App 安装到组织、选好允许哪些仓库，然后你再点「授权」。',
  },
  {
    topic: '向你申请的权限',
    oauth: '本应用申请 repo（你能访问的全部仓库读写，包括代码和设置）、read:org、project。GitHub 给 OAuth 应用的权限分得粗：要读私有仓库的 issue，就只能要整个 repo。',
    app: '由建 App 的人登记时逐项勾选，可以只勾 Issues、Pull requests、Projects 而不给代码权限——但给了什么取决于那个 App 的设置，登录时没法再收窄，以 GitHub 授权页上列的为准。',
  },
  {
    topic: '实际能看到哪些',
    oauth: '你本人能看到的，在上面申请的范围内。',
    app: '三者都满足才行：你本人能看到的、App 登记的权限允许的、App 被安装到的仓库。',
  },
  {
    topic: '登录凭据多久过期',
    oauth: '看应用的设置：开了「令牌过期」的会过期（本应用会自动续期）；没开的不过期，直到你撤销。',
    app: '看 App 的设置：默认开着「令牌过期」（8 小时，本应用会自动续期），建 App 的人也可以关掉，关掉就不过期。',
  },
  {
    topic: '凭据万一泄露',
    oauth: '拿到的人能以你的名义做 repo 权限范围内的一切（包括推代码）。令牌会过期的，单拿到令牌只能用到过期；连续期凭据一起拿到，或者令牌不过期，就能一直用，直到你撤销。',
    app: '拿到的人能做的不超过那个 App 登记的权限。过期规则同左：单拿到会过期的令牌只能用到过期；连续期凭据一起拿到，或者令牌不过期，就能一直用，直到你撤销。',
  },
  {
    topic: '怎么撤销',
    oauth: 'GitHub 网页 → 头像 → Settings → Applications → Authorized OAuth Apps。',
    app: 'GitHub 网页 → 头像 → Settings → Applications → Authorized GitHub Apps；组织管理员也可以直接卸载这个 App。',
  },
  {
    topic: '这一版的支持',
    oauth: '已内置，直接点「用 GitHub 登录」。',
    app: '预览：还没有内置的 GitHub App，要填你自己（或组织）建的 GitHub App 的 Client ID（以 Iv 开头），那个 App 要勾上「Enable Device Flow」。填的 ID 和所选方式对不上时不让登录。',
  },
];

export const APP_KIND_ADVICE: string[] = [
  '大多数情况用默认的 OAuth 应用：不用等组织管理员安装，登录就能用。',
  '想把权限压到最小（例如不给代码权限），或者组织不允许 OAuth 应用访问时，用 GitHub App——前提是那个 App 只勾了需要的权限。',
];
