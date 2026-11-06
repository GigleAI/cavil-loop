// The only way anything in the client reaches the network. Two bases are
// configured (production: https://api.github.com and https://github.com; test
// mode: a loopback fake). A request to any other origin is refused before it
// is sent, and the credential is only ever attached to requests for `api`.

use std::time::Duration;
use url::Url;

#[derive(Clone, Debug)]
pub struct Endpoints {
    /// REST + GraphQL base, e.g. https://api.github.com
    pub api: String,
    /// web base used for the OAuth device flow, e.g. https://github.com
    pub web: String,
}

impl Endpoints {
    pub fn github() -> Endpoints {
        Endpoints { api: "https://api.github.com".into(), web: "https://github.com".into() }
    }
}

pub fn is_loopback(u: &str) -> bool {
    match Url::parse(u) {
        Ok(url) => url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")),
        Err(_) => false,
    }
}

/// `url` lies under `base` (same scheme, host, port; path below the base path). No tricks: parsed, not prefix-matched.
pub fn under(base: &str, url: &str) -> bool {
    let (Ok(b), Ok(u)) = (Url::parse(base), Url::parse(url)) else { return false };
    if u.scheme() != b.scheme() || u.host_str() != b.host_str() || u.port_or_known_default() != b.port_or_known_default() {
        return false;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    let bp = b.path().trim_end_matches('/');
    let up = u.path();
    bp.is_empty() || up == bp || up.starts_with(&format!("{bp}/"))
}

pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// Send one request. Err = no answer at all (connection, timeout, malformed response).
pub async fn send(req: HttpRequest) -> Result<HttpResponse, String> {
    tokio::task::spawn_blocking(move || send_blocking(req)).await.map_err(|e| e.to_string())?
}

fn send_blocking(req: HttpRequest) -> Result<HttpResponse, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(30)))
        .max_redirects(0)
        .build()
        .into();
    let mut b = ureq::http::Request::builder().method(req.method.as_str()).uri(req.url.as_str());
    for (k, v) in &req.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    let res = match req.body {
        Some(body) => agent.run(b.body(body).map_err(|e| e.to_string())?),
        None => agent.run(b.body(()).map_err(|e| e.to_string())?),
    };
    let mut res = res.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
        .collect();
    let body = res
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())?;
    Ok(HttpResponse { status, headers, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_is_parsed_not_prefix_matched() {
        assert!(under("https://api.github.com", "https://api.github.com/graphql"));
        assert!(under("http://127.0.0.1:5000/api", "http://127.0.0.1:5000/api/repos/x"));
        assert!(!under("http://127.0.0.1:5000/api", "http://127.0.0.1:5000/apix"));
        assert!(!under("http://127.0.0.1:5000/api", "http://127.0.0.1:5001/api/x"));
        assert!(!under("https://api.github.com", "https://api.github.com.evil.example/x"));
        assert!(!under("https://api.github.com", "https://user@api.github.com/x"));
        assert!(!under("https://api.github.com", "http://api.github.com/x"));
        assert!(!under("https://api.github.com", "https://github.com/x"));
    }
}
