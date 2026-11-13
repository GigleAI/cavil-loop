// GitHub#395: the last step of showing a release attachment image in the discussion.
//
// An image written as `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>` cannot be
// loaded by the window: a private repo answers 404 without the sign-in, and a public one redirects
// to a host the window's image policy does not allow. The window looks the attachment up through
// the ordinary request command (one classification of GitHub's answers, in src/data/github.ts) and
// then names the attachment's API address here. This side:
//
//   1. accepts only `<api>/repos/<owner>/<repo>/releases/assets/<number>`;
//   2. asks for it with the credential — the credential goes to the API base and nowhere else;
//   3. an answer that is not the file or a redirect to it goes back to the window as it is
//      (status, headers, body): what it means is decided there, by the same rule as every request;
//   4. follows ONE redirect, without the credential, only to GitHub's two release-file hosts;
//   5. returns the file only when it is at most MAX_BYTES and one of four bitmap kinds (by its
//      first bytes — never by the name or the content type; SVG can carry scripts and is refused).
//
// The signed address of step 4 never leaves this side.

use crate::http::{self, Endpoints, HttpRequest};
use serde_json::{json, Value};
use url::Url;

/// one image, at most
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Where GitHub keeps release files (the updater follows the same two, GitHub#184). Exact hosts.
pub const RELEASE_FILE_HOSTS: [&str; 2] = ["release-assets.githubusercontent.com", "objects.githubusercontent.com"];

/// test mode only: the loopback fake serves release files under this path of its web side
const TEST_FILE_PATH: &str = "/release-assets/";

/// `url` is `<api>/repos/<owner>/<repo>/releases/assets/<number>`, nothing more (no query, no fragment).
pub fn is_asset_url(endpoints: &Endpoints, url: &str) -> bool {
    if !http::under(&endpoints.api, url) {
        return false;
    }
    let (Ok(u), Ok(base)) = (Url::parse(url), Url::parse(&endpoints.api)) else { return false };
    if u.query().is_some() || u.fragment().is_some() {
        return false;
    }
    let base_path = base.path().trim_end_matches('/');
    let Some(rest) = u.path().strip_prefix(base_path) else { return false };
    let parts: Vec<&str> = rest.split('/').collect();
    // "", "repos", owner, repo, "releases", "assets", id
    parts.len() == 7
        && parts[0].is_empty()
        && parts[1] == "repos"
        && name_ok(parts[2])
        && name_ok(parts[3])
        && parts[4] == "releases"
        && parts[5] == "assets"
        && !parts[6].is_empty()
        && parts[6].len() <= 20
        && parts[6].bytes().all(|b| b.is_ascii_digit())
}

fn name_ok(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && s.len() <= 100 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// The redirect target may be fetched: https on one of GitHub's two release-file hosts — or, when the
/// configured GitHub is the loopback fake, that fake's own release-file path.
pub fn is_file_url(endpoints: &Endpoints, url: &str) -> bool {
    let Ok(u) = Url::parse(url) else { return false };
    if !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    if u.scheme() == "https" && u.port_or_known_default() == Some(443) {
        if let Some(h) = u.host_str() {
            if RELEASE_FILE_HOSTS.contains(&h) {
                return true;
            }
        }
    }
    let Ok(web) = Url::parse(&endpoints.web) else { return false };
    let under_files = u.path().strip_prefix(web.path().trim_end_matches('/')).map(|rest| rest.starts_with(TEST_FILE_PATH)).unwrap_or(false);
    http::is_loopback(&endpoints.api) && http::is_loopback(url) && http::under(&endpoints.web, url) && under_files
}

/// PNG, JPEG, GIF or WebP by the first bytes; anything else (SVG, HTML, a PDF, …) is None.
pub fn bitmap_kind(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn file_out(body: Option<Vec<u8>>) -> Value {
    match body {
        None => json!({ "kind": "tooLarge" }),
        Some(b) => match bitmap_kind(&b) {
            Some(mime) => json!({ "kind": "image", "mime": mime, "data": base64(&b) }),
            None => json!({ "kind": "notImage" }),
        },
    }
}

/// Steps 2–5. `api_headers` already carries the credential; the caller checked the session and `is_asset_url`.
pub async fn fetch(endpoints: &Endpoints, asset_url: &str, mut api_headers: Vec<(String, String)>) -> Value {
    if !is_asset_url(endpoints, asset_url) {
        return json!({ "error": "refused", "message": crate::i18n::tr("不是 Release 附件的接口地址：{url}", &[("url", asset_url)]) });
    }
    for h in api_headers.iter_mut() {
        if h.0.eq_ignore_ascii_case("accept") {
            h.1 = "application/octet-stream".into();
        }
    }
    let first = match http::send_bytes(HttpRequest { method: "GET".into(), url: asset_url.into(), headers: api_headers, body: None }, MAX_BYTES).await {
        Ok(r) => r,
        Err(m) => return json!({ "error": "network", "message": m }),
    };
    match first.status {
        // GitHub may answer with the file itself
        200 => file_out(first.body),
        301 | 302 | 303 | 307 | 308 => {
            let Some(to) = header(&first.headers, "location") else { return json!({ "kind": "badRedirect" }) };
            if !is_file_url(endpoints, to) {
                return json!({ "kind": "badRedirect" });
            }
            // no credential here: only a client name
            let plain = vec![("User-Agent".to_string(), "cavil-loop-client".to_string())];
            match http::send_bytes(HttpRequest { method: "GET".into(), url: to.into(), headers: plain, body: None }, MAX_BYTES).await {
                Err(m) => json!({ "error": "network", "message": m }),
                Ok(r) if r.status == 200 => file_out(r.body),
                // a second redirect is not followed; any other status of the file host is "not reached"
                Ok(r) => json!({ "kind": "fileStatus", "status": r.status }),
            }
        }
        status => {
            // not the file: GitHub's own answer, for the window to classify (a rate limit is a 403 too)
            let body = first.body.map(|b| String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]).into_owned()).unwrap_or_default();
            json!({ "kind": "answer", "status": status, "headers": first.headers, "body": body })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github() -> Endpoints {
        Endpoints::github()
    }

    fn fake() -> Endpoints {
        Endpoints { api: "http://127.0.0.1:5000/api".into(), web: "http://127.0.0.1:5000/web".into() }
    }

    #[test]
    fn only_an_asset_address_of_the_api_is_accepted() {
        let g = github();
        assert!(is_asset_url(&g, "https://api.github.com/repos/o/r/releases/assets/123"));
        assert!(is_asset_url(&g, "https://api.github.com/repos/Some-Org/a.b_c/releases/assets/7"));
        for bad in [
            "https://api.github.com/repos/o/r/releases/assets/",
            "https://api.github.com/repos/o/r/releases/assets/12x",
            "https://api.github.com/repos/o/r/releases/assets/12/extra",
            "https://api.github.com/repos/o/r/releases/assets/12?x=1",
            "https://api.github.com/repos/o/r/releases/assets/12#f",
            "https://api.github.com/repos/o/../releases/assets/12",
            "https://api.github.com/repos/o/r/contents/a.png",
            "https://api.github.com/user",
            "https://github.com/repos/o/r/releases/assets/12",
            "https://api.github.com.evil.example/repos/o/r/releases/assets/12",
            "http://api.github.com/repos/o/r/releases/assets/12",
            "https://user@api.github.com/repos/o/r/releases/assets/12",
        ] {
            assert!(!is_asset_url(&g, bad), "{bad}");
        }
        let f = fake();
        assert!(is_asset_url(&f, "http://127.0.0.1:5000/api/repos/o/r/releases/assets/12"));
        assert!(!is_asset_url(&f, "http://127.0.0.1:5000/repos/o/r/releases/assets/12"));
        assert!(!is_asset_url(&f, "http://127.0.0.1:5001/api/repos/o/r/releases/assets/12"));
    }

    #[test]
    fn the_file_is_fetched_from_the_two_release_hosts_only() {
        let g = github();
        assert!(is_file_url(&g, "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x"));
        assert!(is_file_url(&g, "https://objects.githubusercontent.com/x"));
        for bad in [
            "http://release-assets.githubusercontent.com/x",
            "https://release-assets.githubusercontent.com:8443/x",
            "https://release-assets.githubusercontent.com.evil.example/x",
            "https://evil.release-assets.githubusercontent.com/x",
            "https://raw.githubusercontent.com/x",
            "https://github.com/x",
            "https://u:p@objects.githubusercontent.com/x",
            "http://127.0.0.1:5000/web/release-assets/1",
            "not a url",
        ] {
            assert!(!is_file_url(&g, bad), "{bad}");
        }
        // the loopback fake: its own release-file path, and only while the configured GitHub is that fake
        let f = fake();
        assert!(is_file_url(&f, "http://127.0.0.1:5000/web/release-assets/1"));
        assert!(!is_file_url(&f, "http://127.0.0.1:5000/web/elsewhere/1"));
        assert!(!is_file_url(&f, "http://127.0.0.1:5000/release-assets/1"));
        assert!(!is_file_url(&f, "http://127.0.0.1:5000/webx/release-assets/1"));
        assert!(!is_file_url(&f, "http://127.0.0.1:5001/web/release-assets/1"));
    }

    #[test]
    fn four_bitmap_kinds_by_their_first_bytes() {
        assert_eq!(bitmap_kind(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), Some("image/png"));
        assert_eq!(bitmap_kind(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(bitmap_kind(b"GIF89a..."), Some("image/gif"));
        assert_eq!(bitmap_kind(b"RIFF\x10\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(bitmap_kind(b"<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"), None);
        assert_eq!(bitmap_kind(b"<!doctype html>"), None);
        assert_eq!(bitmap_kind(b"%PDF-1.7"), None);
        assert_eq!(bitmap_kind(b"RIFF\x10\0\0\0WAVEfmt "), None);
        assert_eq!(bitmap_kind(b""), None);
    }

    #[test]
    fn base64_with_every_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
    }
}
