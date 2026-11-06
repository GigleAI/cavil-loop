// What a sign-in gives us, and how it is kept in the credential store.
//
// An OAuth App token (gho_…) never expires: only `access_token` is set.
// A GitHub App user token (ghu_…) expires (8 h) and comes with a refresh token
// (ghr_…, ~6 months) that GitHub *rotates* on every refresh — the old one stops
// working, so a refresh must never run twice with the same refresh token.
//
// Same stored format as the Electron build (client <= 0.2), so an existing
// keychain entry keeps working after the upgrade.

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenGrant {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// epoch ms; None = does not expire
    pub expires_at: Option<i64>,
    /// epoch ms; None = unknown / does not expire
    pub refresh_expires_at: Option<i64>,
}

fn piece(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Stored form: a bare token (OAuth App, and every credential saved before refresh support) or `v2:access:refresh:exp:refreshExp`.
pub fn encode_grant(g: &TokenGrant) -> String {
    match &g.refresh_token {
        None => g.access_token.clone(),
        Some(r) => format!(
            "v2:{}:{}:{}:{}",
            g.access_token,
            r,
            g.expires_at.unwrap_or(0),
            g.refresh_expires_at.unwrap_or(0)
        ),
    }
}

pub fn decode_grant(stored: Option<&str>) -> Option<TokenGrant> {
    let s = stored?.trim();
    if s.is_empty() {
        return None;
    }
    if !s.starts_with("v2:") {
        return piece(s).then(|| TokenGrant { access_token: s.to_string(), refresh_token: None, expires_at: None, refresh_expires_at: None });
    }
    let parts: Vec<&str> = s.split(':').collect();
    let access = parts.get(1).copied().unwrap_or("");
    let refresh = parts.get(2).copied().unwrap_or("");
    if !piece(access) || !piece(refresh) {
        return None;
    }
    let n = |x: Option<&&str>| -> Option<i64> {
        let x = x?;
        if x.is_empty() || !x.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        x.parse::<i64>().ok().filter(|v| *v > 0)
    };
    Some(TokenGrant {
        access_token: access.to_string(),
        refresh_token: Some(refresh.to_string()),
        expires_at: n(parts.get(3)),
        refresh_expires_at: n(parts.get(4)),
    })
}

/// Parse GitHub's token response (device flow or refresh).
pub fn grant_from_response(body: &serde_json::Map<String, Value>, now: i64) -> Option<TokenGrant> {
    let access = body.get("access_token")?.as_str().filter(|s| !s.is_empty())?.to_string();
    let refresh = body.get("refresh_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    let secs = |v: Option<&Value>| -> Option<i64> {
        match v? {
            Value::Number(n) => n.as_f64().map(|f| f as i64),
            Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().ok(),
            _ => None,
        }
    };
    let exp = secs(body.get("expires_in"));
    let rexp = secs(body.get("refresh_token_expires_in"));
    let has_refresh = refresh.is_some();
    Some(TokenGrant {
        access_token: access,
        refresh_token: refresh,
        expires_at: match (has_refresh, exp) {
            (true, Some(e)) if e != 0 => Some(now + e * 1000),
            _ => None,
        },
        refresh_expires_at: match (has_refresh, rexp) {
            (true, Some(e)) if e != 0 => Some(now + e * 1000),
            _ => None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_reads_bare_tokens() {
        let g = TokenGrant { access_token: "ghu_a".into(), refresh_token: Some("ghr_b".into()), expires_at: Some(5), refresh_expires_at: Some(9) };
        assert_eq!(decode_grant(Some(&encode_grant(&g))), Some(g));
        let bare = decode_grant(Some("gho_x")).unwrap();
        assert_eq!(bare.refresh_token, None);
        assert_eq!(decode_grant(Some("not a token")), None);
        assert_eq!(decode_grant(Some("v2:a::1:2")), None);
        assert_eq!(decode_grant(Some("v2:a:b:0:x")).unwrap().expires_at, None);
    }
}
