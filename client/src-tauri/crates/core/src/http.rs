// The only way anything in the client reaches the network. Two bases are
// configured (production: https://api.github.com and https://github.com; test
// mode: a loopback fake). A request to any other origin is refused before it
// is sent, and the credential is only ever attached to requests for `api`.

use std::cell::Cell;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use ureq::unversioned::resolver::DefaultResolver;
use ureq::unversioned::transport::{ConnectionDetails, Connector, DefaultConnector, Transport};
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

#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// GitHub#364: how hard one request tries. `delays[i]` is the wait before retry i+1, so a request is
/// sent at most `delays.len() + 1` times; every attempt and every wait together stay within `budget`.
#[derive(Clone, Debug)]
pub struct Policy {
    pub budget: Duration,
    pub delays: Vec<Duration>,
}

impl Default for Policy {
    fn default() -> Policy {
        Policy { budget: Duration::from_secs(30), delays: [200, 500, 1000, 2000].iter().map(|ms| Duration::from_millis(*ms)).collect() }
    }
}

/// Send one request. Err = no complete answer at all (connection, timeout, malformed or cut-off response).
///
/// GitHub#364: requests share one connection pool, and a request whose connection broke is tried
/// again — see `send_with` for exactly when.
pub async fn send(req: HttpRequest) -> Result<HttpResponse, String> {
    tokio::task::spawn_blocking(move || send_with(&req, &Policy::default())).await.map_err(|e| e.to_string())?
}

/// Where an attempt broke. Only `Connect` proves that not one byte of the request was written.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    /// name lookup, TCP connect or TLS handshake of a new connection failed
    Connect,
    /// the request may have been written; no response head arrived
    BeforeHead,
    /// a response head arrived; its body did not arrive whole
    InBody,
}

struct Broke {
    phase: Phase,
    /// a lost or cut-off connection (worth another try), not e.g. a body over the size limit
    network: bool,
    message: String,
}

/// GitHub#364: the one retry rule.
///
/// | where it broke                      | read request    | write request |
/// |-------------------------------------|-----------------|---------------|
/// | ① new connection never came up      | again           | again         |
/// | ② sent, no response head            | again, in full  | no            |
/// | ③ head arrived, body cut off        | again, in full  | no            |
/// | ④ complete answer (any status)      | returned as is  | returned as is|
///
/// A failure on a pooled connection is ② or ③, never ①: it cannot be shown the request was not
/// written. The budget wins over the count: an attempt only gets the time that is left, and when
/// less time is left than the next wait, the request stops with the tries it made.
pub fn send_with(req: &HttpRequest, policy: &Policy) -> Result<HttpResponse, String> {
    let started = Instant::now();
    let read = is_read(req);
    let mut retries = 0usize;
    loop {
        let left = policy.budget.saturating_sub(started.elapsed());
        let broke = match attempt(req, left) {
            Ok(r) => return Ok(r),
            Err(b) => b,
        };
        let again = broke.network && (broke.phase == Phase::Connect || read);
        let wait = policy.delays.get(retries).copied();
        let left = policy.budget.saturating_sub(started.elapsed());
        match wait {
            Some(wait) if again && left > wait => {
                std::thread::sleep(wait);
                retries += 1;
            }
            _ => return Err(with_retries(broke.message, retries)),
        }
    }
}

fn with_retries(message: String, retries: usize) -> String {
    if retries == 0 {
        message
    } else {
        format!("{message}（已自动重试 {retries} 次）")
    }
}

/// A request that changes nothing on GitHub, so sending it again is harmless: GET, HEAD, and a
/// GraphQL POST whose document holds queries only. Anything that cannot be shown to be a read is a write.
fn is_read(req: &HttpRequest) -> bool {
    match req.method.to_ascii_uppercase().as_str() {
        "GET" | "HEAD" => true,
        "POST" => {
            let graphql = Url::parse(&req.url).map(|u| u.path().trim_end_matches('/').ends_with("/graphql")).unwrap_or(false);
            graphql
                && req
                    .body
                    .as_deref()
                    .and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok())
                    .and_then(|v| v.get("query").and_then(|q| q.as_str()).map(graphql_only_queries))
                    .unwrap_or(false)
        }
        _ => false,
    }
}

/// The GraphQL document's operations are all queries (named `query …` or the anonymous `{ … }`),
/// and there is at least one; fragments may sit beside them. `mutation`, `subscription`, anything
/// unknown at the top level, or a document that does not even tokenize, is not.
fn graphql_only_queries(doc: &str) -> bool {
    let c: Vec<char> = doc.chars().collect();
    let mut i = 0;
    // open brackets ('{', '(', '['); a definition starts only when none is open
    let mut open: Vec<char> = Vec::new();
    // between definitions (the previous one's selection set just closed, or the start)
    let mut at_start = true;
    let mut queries = 0;
    while i < c.len() {
        let ch = c[i];
        if ch == '#' {
            while i < c.len() && c[i] != '\n' && c[i] != '\r' {
                i += 1;
            }
            continue;
        }
        if ch == '"' {
            if c.get(i + 1) == Some(&'"') && c.get(i + 2) == Some(&'"') {
                i += 3;
                let triple = |at: usize| c.get(at) == Some(&'"') && c.get(at + 1) == Some(&'"') && c.get(at + 2) == Some(&'"');
                loop {
                    if i >= c.len() {
                        return false;
                    }
                    if c[i] == '\\' && triple(i + 1) {
                        i += 4;
                    } else if triple(i) {
                        i += 3;
                        break;
                    } else {
                        i += 1;
                    }
                }
            } else {
                i += 1;
                loop {
                    match c.get(i) {
                        None | Some('\n') | Some('\r') => return false,
                        Some('\\') => i += 2,
                        Some('"') => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
            }
            continue;
        }
        match ch {
            '{' | '(' | '[' => {
                if open.is_empty() && at_start {
                    if ch != '{' {
                        return false;
                    }
                    // the anonymous query shorthand
                    queries += 1;
                    at_start = false;
                }
                open.push(ch);
            }
            '}' | ')' | ']' => {
                let want = match ch {
                    '}' => '{',
                    ')' => '(',
                    _ => '[',
                };
                if open.pop() != Some(want) {
                    return false;
                }
                if open.is_empty() && ch == '}' {
                    at_start = true;
                }
            }
            _ if ch.is_ascii_alphabetic() || ch == '_' => {
                let s = i;
                while i < c.len() && (c[i].is_ascii_alphanumeric() || c[i] == '_') {
                    i += 1;
                }
                if open.is_empty() && at_start {
                    match c[s..i].iter().collect::<String>().as_str() {
                        "query" => queries += 1,
                        "fragment" => {}
                        _ => return false,
                    }
                    at_start = false;
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    queries > 0 && open.is_empty() && at_start
}

thread_local! {
    /// set by the connector when this thread's attempt failed while making a new connection;
    /// thread-local because ureq connects on the calling thread, so it never mixes requests up
    static CONNECT_FAILED: Cell<bool> = const { Cell::new(false) };
}

/// The default connector chain, noting a failure to connect (the only proof nothing was written).
#[derive(Debug)]
struct NoteConnectFailure(DefaultConnector);

impl Connector<()> for NoteConnectFailure {
    type Out = Box<dyn Transport>;
    fn connect(&self, details: &ConnectionDetails, chained: Option<()>) -> Result<Option<Self::Out>, ureq::Error> {
        let r = self.0.connect(details, chained);
        if r.is_err() {
            CONNECT_FAILED.with(|f| f.set(true));
        }
        r
    }
}

/// One agent for the whole process: its pool is what lets requests share connections.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let config = ureq::Agent::config_builder().http_status_as_error(false).max_redirects(0).build();
        ureq::Agent::with_parts(config, NoteConnectFailure(DefaultConnector::default()), DefaultResolver::default())
    })
}

fn attempt(req: &HttpRequest, left: Duration) -> Result<HttpResponse, Broke> {
    let local = |message: String| Broke { phase: Phase::Connect, network: false, message };
    let mut b = ureq::http::Request::builder().method(req.method.as_str()).uri(req.url.as_str());
    for (k, v) in &req.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    let a = agent();
    CONNECT_FAILED.with(|f| f.set(false));
    let res = match &req.body {
        Some(body) => {
            let r = b.body(body.clone()).map_err(|e| local(e.to_string()))?;
            a.run(a.configure_request(r).timeout_global(Some(left)).build())
        }
        None => {
            let r = b.body(()).map_err(|e| local(e.to_string()))?;
            a.run(a.configure_request(r).timeout_global(Some(left)).build())
        }
    };
    let mut res = res.map_err(|e| {
        let phase = if CONNECT_FAILED.with(|f| f.get()) || matches!(e, ureq::Error::HostNotFound) { Phase::Connect } else { Phase::BeforeHead };
        Broke { phase, network: is_network(&e), message: e.to_string() }
    })?;
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
        .map_err(|e| Broke { phase: Phase::InBody, network: is_network(&e), message: e.to_string() })?;
    Ok(HttpResponse { status, headers, body })
}

/// The connection was lost, refused, timed out or cut off — as opposed to a request ureq would
/// refuse again (bad address, body over the limit, …).
fn is_network(e: &ureq::Error) -> bool {
    matches!(
        e,
        ureq::Error::Io(_) | ureq::Error::Timeout(_) | ureq::Error::HostNotFound | ureq::Error::ConnectionFailed | ureq::Error::Protocol(_) | ureq::Error::Tls(_)
    ) || matches!(e, ureq::Error::Rustls(_))
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

    /// GitHub#261: GitHub answers a HEAD with the length of the body it did not send (measured:
    /// `content-length: 2089761` on a board's item page). The answer must come back at once,
    /// headers intact — not wait for 2 MB that never arrive — and a 304 the same way. (ureq
    /// already knows neither has a body; this pins it for the change check.)
    #[test]
    fn head_with_a_content_length_and_no_body_returns_at_once() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // answers the n-th request (on whichever connection it arrives: GitHub#364 reuses them) with
        // the n-th status; the connection stays open, as a keep-alive server's would
        let next = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server = std::thread::spawn(move || {
            for s in listener.incoming() {
                let Ok(mut s) = s else { return };
                let next = next.clone();
                std::thread::spawn(move || loop {
                    let mut buf = [0u8; 4096];
                    if s.read(&mut buf).unwrap_or(0) == 0 {
                        return;
                    }
                    let status = ["200 OK", "304 Not Modified"][next.fetch_add(1, std::sync::atomic::Ordering::SeqCst).min(1)];
                    let head = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: 2089761\r\netag: \"abc\"\r\nlink: <http://127.0.0.1:{port}/next>; rel=\"next\"\r\n\r\n"
                    );
                    s.write_all(head.as_bytes()).unwrap();
                });
            }
        });
        for want in [200u16, 304] {
            let t = std::time::Instant::now();
            let r = send_with(&HttpRequest { method: "HEAD".into(), url: format!("http://127.0.0.1:{port}/x"), headers: vec![], body: None }, &Policy::default()).unwrap();
            assert!(t.elapsed() < Duration::from_secs(3), "HEAD waited {:?} for a body", t.elapsed());
            assert_eq!(r.status, want);
            assert_eq!(r.body, "");
            assert!(r.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("etag") && v == "\"abc\""));
        }
        drop(server);
    }

    // ---- GitHub#364: one pool, and the retry rule — every case against a real local socket ----

    use std::io::{BufRead, BufReader, Read as _, Write as _};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// What the fake server does with the n-th request it reads (any connection). Past the list: answer 200.
    #[derive(Clone, Copy, Debug)]
    enum Act {
        /// a complete answer with this status (body `ok<n>`, none for 304), connection kept open
        Answer(u16),
        /// read the request, then close without a byte of answer (②)
        Close,
        /// 200 declaring 1000 bytes, send 500, close (③)
        CutLength,
        /// 200 chunked, one chunk, close before the last chunk (③)
        CutChunked,
        /// read the request, never answer
        Hang,
    }

    struct Fake {
        port: u16,
        conns: Arc<AtomicUsize>,
        /// "METHOD path" of every request read in full, in order
        reqs: Arc<Mutex<Vec<String>>>,
    }

    impl Fake {
        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }
        fn conns(&self) -> usize {
            self.conns.load(Ordering::SeqCst)
        }
        fn reqs(&self) -> Vec<String> {
            self.reqs.lock().unwrap().clone()
        }
    }

    fn fake(acts: Vec<Act>) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let conns = Arc::new(AtomicUsize::new(0));
        let reqs = Arc::new(Mutex::new(Vec::new()));
        let (c, r) = (conns.clone(), reqs.clone());
        std::thread::spawn(move || {
            for s in listener.incoming() {
                let Ok(s) = s else { return };
                c.fetch_add(1, Ordering::SeqCst);
                let (r, acts) = (r.clone(), acts.clone());
                std::thread::spawn(move || serve(s, &r, &acts));
            }
        });
        Fake { port, conns, reqs }
    }

    fn serve(s: TcpStream, reqs: &Mutex<Vec<String>>, acts: &[Act]) {
        let mut w = s.try_clone().unwrap();
        let mut rd = BufReader::new(s);
        loop {
            let mut line = String::new();
            if rd.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                if rd.read_line(&mut h).unwrap_or(0) == 0 {
                    return;
                }
                if h == "\r\n" {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; len];
            if rd.read_exact(&mut body).is_err() {
                return;
            }
            let n = {
                let mut g = reqs.lock().unwrap();
                let mut it = line.split_whitespace();
                g.push(format!("{} {}", it.next().unwrap_or(""), it.next().unwrap_or("")));
                g.len() - 1
            };
            match acts.get(n).copied().unwrap_or(Act::Answer(200)) {
                Act::Answer(st) => {
                    let b = if st == 304 { String::new() } else { format!("ok{n}") };
                    let _ = write!(w, "HTTP/1.1 {st} X\r\ncontent-length: {}\r\netag: \"e\"\r\n\r\n{b}", b.len());
                }
                Act::Close => return,
                Act::CutLength => {
                    let _ = write!(w, "HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\n{}", "x".repeat(500));
                    return;
                }
                Act::CutChunked => {
                    let _ = write!(w, "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n");
                    return;
                }
                Act::Hang => {
                    std::thread::sleep(Duration::from_secs(90));
                    return;
                }
            }
        }
    }

    /// A port that takes the TCP connection, reads the TLS ClientHello and hangs up: the handshake breaks (①).
    fn handshake_breaker() -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let conns = Arc::new(AtomicUsize::new(0));
        let c = conns.clone();
        std::thread::spawn(move || {
            for s in listener.incoming() {
                let Ok(mut s) = s else { return };
                c.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                drop(s);
            }
        });
        (port, conns)
    }

    /// the default rule with short waits (the count and the budget are the real ones)
    fn quick() -> Policy {
        Policy { budget: Duration::from_secs(30), delays: vec![Duration::from_millis(10); 4] }
    }

    fn req(method: &str, url: String, body: Option<&str>) -> HttpRequest {
        HttpRequest { method: method.into(), url, headers: vec![("Content-Type".into(), "application/json".into())], body: body.map(str::to_string) }
    }

    const MUTATION: &str = r#"{"query":"mutation CavilSetStatus($projectId: ID!) { updateProjectV2ItemFieldValue(input: {projectId: $projectId}) { clientMutationId } }","variables":{}}"#;
    const QUERY: &str = r#"{"query":"query CavilViewer { viewer { login } }","variables":{}}"#;

    #[test]
    fn requests_share_one_connection() {
        let f = fake(vec![]);
        for _ in 0..2 {
            assert_eq!(send_with(&req("GET", f.url("/a"), None), &quick()).unwrap().status, 200);
        }
        assert_eq!(f.reqs().len(), 2, "both requests reached the server");
        assert_eq!(f.conns(), 1, "the second request reused the first connection");
    }

    #[test]
    fn a_broken_handshake_is_retried_even_for_a_write() {
        let (port, conns) = handshake_breaker();
        let e = send_with(&req("POST", format!("https://127.0.0.1:{port}/api/repos/o/r/issues"), Some("{}")), &quick()).unwrap_err();
        assert_eq!(conns.load(Ordering::SeqCst), 5, "first try + 4 retries, each a new connection: {e}");
        assert!(e.ends_with("（已自动重试 4 次）"), "{e}");
    }

    #[test]
    fn a_read_cut_before_the_answer_is_sent_again() {
        let f = fake(vec![Act::Close, Act::Close, Act::Answer(200)]);
        let r = send_with(&req("GET", f.url("/api/repos/o/r/issues"), None), &quick()).unwrap();
        assert_eq!((r.status, r.body.as_str()), (200, "ok2"));
        assert_eq!(f.reqs().len(), 3, "{:?}", f.reqs());
    }

    #[test]
    fn a_write_cut_before_the_answer_is_not_sent_again() {
        for (method, path, body) in [("POST", "/api/repos/o/r/issues", "{}"), ("PATCH", "/api/repos/o/r/issues/1", "{}"), ("DELETE", "/api/repos/o/r/issues/1/labels/x", ""), ("POST", "/api/graphql", MUTATION)] {
            let f = fake(vec![Act::Close]);
            let e = send_with(&req(method, f.url(path), Some(body)), &quick()).unwrap_err();
            assert_eq!(f.reqs(), vec![format!("{method} {path}")], "reached the server exactly once");
            assert!(!e.contains("已自动重试"), "{method} {path}: {e}");
        }
    }

    #[test]
    fn a_read_whose_body_is_cut_off_is_read_again_in_full() {
        for cut in [Act::CutLength, Act::CutChunked] {
            let f = fake(vec![cut, Act::Answer(200)]);
            let r = send_with(&req("GET", f.url("/api/x"), None), &quick()).unwrap();
            assert_eq!(r.body, "ok1", "{cut:?}: only the second, whole answer is handed back");
            assert_eq!(f.reqs().len(), 2, "{cut:?}");
        }
    }

    #[test]
    fn a_write_whose_body_is_cut_off_is_not_sent_again() {
        for cut in [Act::CutLength, Act::CutChunked] {
            for (path, body) in [("/api/repos/o/r/issues", "{}"), ("/api/graphql", MUTATION)] {
                let f = fake(vec![cut]);
                let e = send_with(&req("POST", f.url(path), Some(body)), &quick()).unwrap_err();
                assert_eq!(f.reqs().len(), 1, "{cut:?} {path}: {e}");
                assert!(!e.contains("已自动重试"), "{e}");
            }
        }
    }

    #[test]
    fn a_graphql_query_is_a_read_and_an_unreadable_body_is_a_write() {
        let f = fake(vec![Act::Close, Act::Answer(200)]);
        assert_eq!(send_with(&req("POST", f.url("/api/graphql"), Some(QUERY)), &quick()).unwrap().status, 200);
        assert_eq!(f.reqs().len(), 2);
        for body in ["not json", r#"{"query": 1}"#, r#"[{"query":"query A { a }"}]"#] {
            let f = fake(vec![Act::Close]);
            assert!(send_with(&req("POST", f.url("/api/graphql"), Some(body)), &quick()).is_err());
            assert_eq!(f.reqs().len(), 1, "{body}");
        }
        // a query-shaped body sent anywhere but the GraphQL endpoint is still a write
        let f = fake(vec![Act::Close]);
        assert!(send_with(&req("POST", f.url("/api/markdown"), Some(QUERY)), &quick()).is_err());
        assert_eq!(f.reqs().len(), 1);
    }

    #[test]
    fn a_complete_answer_is_returned_as_it_is_whatever_its_status() {
        for (method, st) in [("GET", 500u16), ("GET", 502), ("GET", 304), ("GET", 401), ("POST", 500)] {
            let f = fake(vec![Act::Answer(st)]);
            let r = send_with(&req(method, f.url("/api/x"), if method == "POST" { Some("{}") } else { None }), &quick()).unwrap();
            assert_eq!(r.status, st);
            assert_eq!(f.reqs().len(), 1, "{method} {st}");
        }
    }

    #[test]
    fn a_failure_on_a_pooled_connection_never_counts_as_unsent() {
        // the first answer leaves the connection in the pool; the write then goes out on it and is cut
        let f = fake(vec![Act::Answer(200), Act::Close]);
        send_with(&req("GET", f.url("/a"), None), &quick()).unwrap();
        assert!(send_with(&req("POST", f.url("/api/repos/o/r/issues"), Some("{}")), &quick()).is_err());
        assert_eq!(f.conns(), 1, "the write went out on the pooled connection");
        assert_eq!(f.reqs(), vec!["GET /a".to_string(), "POST /api/repos/o/r/issues".to_string()]);
    }

    #[test]
    fn a_failed_connect_elsewhere_does_not_make_a_write_look_unsent() {
        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let st = stop.clone();
        let noise = std::thread::spawn(move || {
            let mut n = 0;
            while !st.load(Ordering::SeqCst) {
                let _ = send_with(&req("POST", format!("http://127.0.0.1:{closed}/x"), Some("{}")), &Policy { budget: Duration::from_secs(5), delays: vec![] });
                n += 1;
            }
            n
        });
        let f = fake(vec![Act::Close; 20]);
        for i in 0..20 {
            assert!(send_with(&req("POST", f.url(&format!("/w{i}")), Some("{}")), &quick()).is_err());
        }
        stop.store(true, Ordering::SeqCst);
        assert!(noise.join().unwrap() > 0, "the failing connects really ran alongside");
        assert_eq!(f.reqs().len(), 20, "every write reached the server exactly once");
    }

    #[test]
    fn the_time_budget_wins_over_the_count() {
        // the server never answers: the first try uses up the whole 30 s, nothing is left to retry with
        let f = fake(vec![Act::Hang; 5]);
        let t = Instant::now();
        let e = send_with(&req("GET", f.url("/api/x"), None), &Policy::default()).unwrap_err();
        assert!(t.elapsed() < Duration::from_secs(32), "took {:?}", t.elapsed());
        let n = f.reqs().len();
        assert!((1..5).contains(&n), "{n} requests");
        if n == 1 {
            assert!(!e.contains("已自动重试"), "{e}");
        } else {
            assert!(e.ends_with(&format!("（已自动重试 {} 次）", n - 1)), "{e}");
        }
    }

    #[test]
    fn too_little_time_for_the_next_wait_stops_with_the_tries_made() {
        // 1 s with the real waits (0.2 / 0.5 / 1 / 2 s): the third wait no longer fits
        let (port, conns) = handshake_breaker();
        let t = Instant::now();
        let e = send_with(&req("GET", format!("https://127.0.0.1:{port}/api/x"), None), &Policy { budget: Duration::from_secs(1), ..Policy::default() }).unwrap_err();
        assert!(t.elapsed() < Duration::from_millis(1500), "took {:?}", t.elapsed());
        let n = conns.load(Ordering::SeqCst);
        assert!((2..5).contains(&n), "{n} connections");
        assert!(e.ends_with(&format!("（已自动重试 {} 次）", n - 1)), "{n}: {e}");
    }

    #[test]
    fn only_documents_of_queries_count_as_reads() {
        for doc in [
            "query A { viewer { login } }",
            "{ viewer { login } }",
            "query A($x: Int = 3, $o: In = {a: [1, 2]}) @dir(if: true) { a(x: $x) { ...P } }\nfragment P on T { b }",
            "fragment P on T { b }\nquery A { ...P }",
            "# mutation in a comment\nquery A { a(s: \"mutation { }\") }",
            "query A { a(s: \"\"\"block \\\"\"\" mutation {\"\"\") }",
            "query A { a } query B { b }",
        ] {
            assert!(graphql_only_queries(doc), "{doc}");
        }
        for doc in [
            "mutation M { a }",
            "subscription S { a }",
            "query A { a } mutation M { b }",
            "fragment P on T { b }",
            "",
            "   ",
            "query A { a",
            "query A { a } }",
            "query A { a(s: \"open) }",
            "schema { query: Q }",
            "(x) { a }",
        ] {
            assert!(!graphql_only_queries(doc), "{doc}");
        }
    }
}
