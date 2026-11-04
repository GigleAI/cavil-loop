// GitHub OAuth device flow:
//   1. POST {web}/login/device/code            -> user_code + verification_uri
//   2. user opens the page in a browser, types the code, approves
//   3. POST {web}/login/oauth/access_token      (poll every `interval` s)
// https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

import type { Endpoints, FetchLike } from './github';

export const OAUTH_SCOPES = ['repo', 'read:org', 'project'];

export type DeviceFlowFailure = 'denied' | 'expired' | 'error' | 'cancelled';

export class DeviceFlowError extends Error {
  constructor(
    readonly reason: DeviceFlowFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** epoch ms */
  expiresAt: number;
  /** seconds */
  interval: number;
}

async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'cavil-loop-client' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new DeviceFlowError('error', `无法连接 GitHub：${(e as Error).message}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  if (!res.ok && !body.error) throw new DeviceFlowError('error', `GitHub 返回 HTTP ${res.status}`);
  return body;
}

export async function requestDeviceCode(
  endpoints: Endpoints,
  clientId: string,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<DeviceCode> {
  const body = await postForm(fetchImpl, `${endpoints.web}/login/device/code`, {
    client_id: clientId,
    scope: OAUTH_SCOPES.join(' '),
  });
  if (body.error) {
    const desc = String(body.error_description ?? body.error);
    if (body.error === 'device_flow_disabled') {
      throw new DeviceFlowError('error', `这个 OAuth 应用没有开启 Device Flow：${desc}`);
    }
    throw new DeviceFlowError('error', `GitHub 拒绝了授权请求：${desc}`);
  }
  const { device_code, user_code, verification_uri, expires_in, interval } = body as Record<string, string | number>;
  if (!device_code || !user_code || !verification_uri) throw new DeviceFlowError('error', 'GitHub 回应缺少设备码');
  return {
    deviceCode: String(device_code),
    userCode: String(user_code),
    verificationUri: String(verification_uri),
    expiresAt: now() + Number(expires_in ?? 900) * 1000,
    interval: Number(interval ?? 5),
  };
}

export interface PollOptions {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  cancelled: () => boolean;
}

/** Poll until GitHub hands out a token, or the user denies / the code expires / it is cancelled. */
export async function pollForToken(
  endpoints: Endpoints,
  clientId: string,
  code: DeviceCode,
  fetchImpl: FetchLike,
  opts: PollOptions,
): Promise<string> {
  let interval = code.interval;
  for (;;) {
    await opts.sleep(interval * 1000);
    if (opts.cancelled()) throw new DeviceFlowError('cancelled', '已取消登录');
    if (opts.now() >= code.expiresAt) throw new DeviceFlowError('expired', '短码已过期，请重新开始登录');
    const body = await postForm(fetchImpl, `${endpoints.web}/login/oauth/access_token`, {
      client_id: clientId,
      device_code: code.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (opts.cancelled()) throw new DeviceFlowError('cancelled', '已取消登录');
    if (typeof body.access_token === 'string' && body.access_token) return body.access_token;
    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval = Number(body.interval ?? interval + 5);
        continue;
      case 'expired_token':
        throw new DeviceFlowError('expired', '短码已过期，请重新开始登录');
      case 'access_denied':
        throw new DeviceFlowError('denied', '你在 GitHub 页面上拒绝了授权');
      default:
        throw new DeviceFlowError('error', `授权失败：${String(body.error_description ?? body.error ?? '未知错误')}`);
    }
  }
}
