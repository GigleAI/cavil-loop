// GitHub OAuth device flow:
//   1. POST {web}/login/device/code            -> user_code + verification_uri
//   2. user opens the page in a browser, types the code, approves
//   3. POST {web}/login/oauth/access_token      (poll every `interval` s)
// https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
//
// Same rules as the Electron build's data/deviceFlow.ts (which this replaces).

use crate::grant::{grant_from_response, TokenGrant};
use crate::http::{send, Endpoints, HttpRequest};
use crate::i18n::tr;
use crate::platform::Clock;
use serde_json::{Map, Value};

pub const OAUTH_SCOPES: [&str; 3] = ["repo", "read:org", "project"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Denied,
    Expired,
    Error,
    Cancelled,
    Unreachable,
}

impl Failure {
    pub fn as_str(self) -> &'static str {
        match self {
            Failure::Denied => "denied",
            Failure::Expired => "expired",
            Failure::Error => "error",
            Failure::Cancelled => "cancelled",
            Failure::Unreachable => "unreachable",
        }
    }
}

/// GitHub#471: what went wrong, in two parts — the client's own explanation (in the window's
/// language, `tr`) and the outside text it is about (GitHub's words, the network error), as is.
#[derive(Debug, Clone)]
pub struct FlowError {
    pub reason: Failure,
    pub message: String,
    pub detail: Option<String>,
}

impl FlowError {
    /// both parts as one line, for the places that show a single text
    pub fn full(&self) -> String {
        match &self.detail {
            Some(d) => tr("{text}：{detail}", &[("text", &self.message), ("detail", d)]),
            None => self.message.clone(),
        }
    }
}

fn fail(reason: Failure, message: impl Into<String>) -> FlowError {
    FlowError { reason, message: message.into(), detail: None }
}

fn fail_with(reason: Failure, message: String, detail: String) -> FlowError {
    FlowError { reason, message, detail: Some(detail) }
}

#[derive(Clone, Debug)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// epoch ms
    pub expires_at: i64,
    /// seconds
    pub interval: i64,
}

fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish()
}

async fn post_form(url: String, pairs: &[(&str, &str)]) -> Result<Map<String, Value>, FlowError> {
    let res = send(HttpRequest {
        method: "POST".into(),
        url,
        headers: vec![
            ("Accept".into(), "application/json".into()),
            ("Content-Type".into(), "application/x-www-form-urlencoded".into()),
            ("User-Agent".into(), "cavil-loop-client".into()),
        ],
        body: Some(form(pairs)),
    })
    .await
    .map_err(|e| fail_with(Failure::Unreachable, tr("无法连接 GitHub", &[]), e.to_string()))?;
    // 5xx / 429 first, whatever the body says: GitHub is not answering properly,
    // which is never a verdict on the credential (a 503 can carry {"error": …}).
    if res.status >= 500 || res.status == 429 {
        return Err(fail(Failure::Unreachable, tr("GitHub 暂时不可用（HTTP {status}）", &[("status", &res.status.to_string())])));
    }
    let body = match serde_json::from_str::<Value>(&res.body) {
        Ok(Value::Object(m)) => m,
        _ => return Err(fail(Failure::Error, tr("GitHub 的回应无法解析（HTTP {status}）", &[("status", &res.status.to_string())]))),
    };
    let ok = (200..300).contains(&res.status);
    if !ok && !truthy(body.get("error")) {
        return Err(fail(Failure::Error, tr("GitHub 返回 HTTP {status}", &[("status", &res.status.to_string())])));
    }
    Ok(body)
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(_) => true,
    }
}

fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn num(v: Option<&Value>, fallback: f64) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(fallback),
        Some(Value::String(s)) => s.parse().unwrap_or(f64::NAN),
        None | Some(Value::Null) => fallback,
        _ => f64::NAN,
    }
}

pub async fn request_device_code(endpoints: &Endpoints, client_id: &str, clock: &dyn Clock) -> Result<DeviceCode, FlowError> {
    let scope = OAUTH_SCOPES.join(" ");
    let body = post_form(format!("{}/login/device/code", endpoints.web), &[("client_id", client_id), ("scope", &scope)]).await?;
    if truthy(body.get("error")) {
        let desc = if truthy(body.get("error_description")) { text(body.get("error_description")) } else { text(body.get("error")) };
        if body.get("error").and_then(|v| v.as_str()) == Some("device_flow_disabled") {
            return Err(fail_with(Failure::Error, tr("这个 OAuth 应用没有开启 Device Flow", &[]), desc));
        }
        return Err(fail_with(Failure::Error, tr("GitHub 拒绝了授权请求", &[]), desc));
    }
    let dc = text(body.get("device_code"));
    let uc = text(body.get("user_code"));
    let vu = text(body.get("verification_uri"));
    if dc.is_empty() || uc.is_empty() || vu.is_empty() {
        return Err(fail(Failure::Error, tr("GitHub 回应缺少设备码", &[])));
    }
    let now = clock.now().await;
    Ok(DeviceCode {
        device_code: dc,
        user_code: uc,
        verification_uri: vu,
        expires_at: now + (num(body.get("expires_in"), 900.0) * 1000.0) as i64,
        interval: num(body.get("interval"), 5.0) as i64,
    })
}

/// Poll until GitHub hands out a token, or the user denies / the code expires / `cancelled()` says stop.
pub async fn poll_for_token(
    endpoints: &Endpoints,
    client_id: &str,
    code: &DeviceCode,
    clock: &dyn Clock,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<TokenGrant, FlowError> {
    let mut interval = code.interval;
    loop {
        clock.sleep(interval * 1000).await;
        if cancelled() {
            return Err(fail(Failure::Cancelled, tr("已取消登录", &[])));
        }
        if clock.now().await >= code.expires_at {
            return Err(fail(Failure::Expired, tr("短码已过期，请重新开始登录", &[])));
        }
        let body = match post_form(
            format!("{}/login/oauth/access_token", endpoints.web),
            &[
                ("client_id", client_id),
                ("device_code", &code.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )
        .await
        {
            Ok(b) => b,
            // a hiccup while the user is still typing the code: keep waiting until the code expires
            Err(e) if e.reason == Failure::Unreachable => continue,
            Err(e) => return Err(e),
        };
        if cancelled() {
            return Err(fail(Failure::Cancelled, tr("已取消登录", &[])));
        }
        if let Some(g) = grant_from_response(&body, clock.now().await) {
            return Ok(g);
        }
        match body.get("error").and_then(|v| v.as_str()) {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                interval = match body.get("interval") {
                    None | Some(Value::Null) => interval + 5,
                    v => num(v, (interval + 5) as f64) as i64,
                };
                continue;
            }
            Some("expired_token") => return Err(fail(Failure::Expired, tr("短码已过期，请重新开始登录", &[]))),
            Some("access_denied") => return Err(fail(Failure::Denied, tr("你在 GitHub 页面上拒绝了授权", &[]))),
            _ => {
                if truthy(body.get("error_description")) {
                    return Err(fail_with(Failure::Error, tr("授权失败", &[]), text(body.get("error_description"))));
                }
                if truthy(body.get("error")) {
                    return Err(fail_with(Failure::Error, tr("授权失败", &[]), text(body.get("error"))));
                }
                return Err(fail(Failure::Error, tr("授权失败：未知错误", &[])));
            }
        }
    }
}

/// The one answer that proves the refresh token is dead (GitHub: "incorrect or expired").
pub const REFRESH_TOKEN_REJECTED: &str = "bad_refresh_token";

/// Exchange a GitHub App refresh token for a new access + refresh token.
///   Expired     — GitHub said bad_refresh_token: sign in again
///   Unreachable — no answer, 5xx or 429 (any body): keep everything, retry later
///   Error       — anything else: not proof the credential is dead; keep everything, tell the user, retry later
pub async fn refresh_grant(endpoints: &Endpoints, client_id: &str, refresh_token: &str, clock: &dyn Clock) -> Result<TokenGrant, FlowError> {
    let body = post_form(
        format!("{}/login/oauth/access_token", endpoints.web),
        &[("client_id", client_id), ("grant_type", "refresh_token"), ("refresh_token", refresh_token)],
    )
    .await?;
    if let Some(g) = grant_from_response(&body, clock.now().await) {
        return Ok(g);
    }
    let desc = || if truthy(body.get("error_description")) { text(body.get("error_description")) } else { text(body.get("error")) };
    if body.get("error").and_then(|v| v.as_str()) == Some(REFRESH_TOKEN_REJECTED) {
        return Err(fail_with(Failure::Expired, tr("GitHub 不再接受续期", &[]), desc()));
    }
    if truthy(body.get("error")) {
        return Err(fail_with(Failure::Error, tr("续期失败", &[]), desc()));
    }
    Err(fail(Failure::Error, tr("续期失败：GitHub 的回应里没有新令牌", &[])))
}
