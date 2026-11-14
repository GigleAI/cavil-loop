// A daemon on another machine (GitHub#387): pairing, reading its status, stop / start of one
// project, the tail of one poll log, unpairing. The other end is scripts/remote-access/ in the
// daemon; the protocol is written down in docs/operations.md "Remote access".
//
// Tailscale only, and checked on this side before anything is sent:
//
//   · the machine is named by its full Tailscale name (`*.ts.net`), never by an address;
//   · the name must resolve to Tailscale addresses only, and the connection goes to exactly the
//     address that was checked (the check lives in the resolver the connection uses);
//   · the connection is HTTPS and the other end must present a valid certificate for that name —
//     only the Tailscale device holding the name can get one. Until that handshake is done
//     nothing is written: no pairing code, no signature;
//   · no redirect is followed.
//
// After pairing the key never travels again: each request carries a signature, and a reply is
// believed only when it carries the matching one. The GitHub credential is not involved at all —
// this module has no access to it and sends no header of it.
//
// "Could not reach / could not verify" never becomes "no projects" or "stopped": every failure is
// reported with its reason, and the last status that was read is kept, marked as old.

use crate::i18n::{tr, Said};
use crate::store::Store;
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};

/// The settings key holding the list of remote machines (the window may read it, only this module writes it).
pub const REMOTES: &str = "remotes";
pub const DEFAULT_PORT: u16 = 47387;
const T_PAIR: Duration = Duration::from_secs(20);
/// the status script may take up to 90 s on the other machine, a stop / start up to 120 s
const T_CALL: Duration = Duration::from_secs(150);
const T_QUICK: Duration = Duration::from_secs(15);
/// a save of a project's settings (GitHub#530): the machine reads the config (up to 60 s), then the
/// save waits up to 15 s for another save's lock and loads the config a few times (up to 120 s)
const T_CONFIG_SAVE: Duration = Duration::from_secs(210);
/// one "is the remote entry open" look at a machine in the device list
const T_HELLO: Duration = Duration::from_secs(5);

// ── where keys are kept ──

/// One secret per remote machine, by account name.
#[async_trait]
pub trait KeyStore: Send + Sync {
    /// true when a key survives an app restart
    fn persistent(&self) -> bool;
    async fn get(&self, account: &str) -> Result<Option<String>, Said>;
    async fn set(&self, account: &str, key: &str) -> Result<(), Said>;
    async fn clear(&self, account: &str) -> Result<(), Said>;
}

fn key_shape(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn account_shape(a: &str) -> bool {
    !a.is_empty() && a.len() <= 300 && a.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".:-".contains(&b))
}

/// Platforms without a keychain: this run only.
#[derive(Default)]
pub struct MemoryKeys(Mutex<HashMap<String, String>>);

#[async_trait]
impl KeyStore for MemoryKeys {
    fn persistent(&self) -> bool {
        false
    }
    async fn get(&self, account: &str) -> Result<Option<String>, Said> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    async fn set(&self, account: &str, key: &str) -> Result<(), Said> {
        self.0.lock().unwrap().insert(account.into(), key.into());
        Ok(())
    }
    async fn clear(&self, account: &str) -> Result<(), Said> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

/// Test mode only: one JSON file `{account: key}`.
pub struct FileKeys(pub PathBuf);

impl FileKeys {
    fn load(&self) -> Result<serde_json::Map<String, Value>, Said> {
        match std::fs::read_to_string(&self.0) {
            Ok(s) => serde_json::from_str(&s).map_err(|e| Said::new("钥匙文件读不懂：{e}", &[("e", &e.to_string())], "system")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(e) => Err(sys(e)),
        }
    }
    fn save(&self, m: &serde_json::Map<String, Value>) -> Result<(), Said> {
        if let Some(d) = self.0.parent() {
            std::fs::create_dir_all(d).map_err(sys)?;
        }
        std::fs::write(&self.0, serde_json::to_string(m).map_err(sys)?).map_err(sys)
    }
}

#[async_trait]
impl KeyStore for FileKeys {
    fn persistent(&self) -> bool {
        true
    }
    async fn get(&self, account: &str) -> Result<Option<String>, Said> {
        Ok(self.load()?.get(account).and_then(|v| v.as_str()).map(str::to_string))
    }
    async fn set(&self, account: &str, key: &str) -> Result<(), Said> {
        let mut m = self.load()?;
        m.insert(account.into(), Value::String(key.into()));
        self.save(&m)
    }
    async fn clear(&self, account: &str) -> Result<(), Said> {
        let mut m = self.load()?;
        m.remove(account);
        self.save(&m)
    }
}

/// The macOS login keychain through /usr/bin/security: the same service as the GitHub sign-in,
/// one account per remote machine. The key goes in on stdin, never in argv.
pub struct MacKeys {
    pub bin: String,
}

impl Default for MacKeys {
    fn default() -> Self {
        MacKeys { bin: "/usr/bin/security".into() }
    }
}

#[async_trait]
impl KeyStore for MacKeys {
    fn persistent(&self) -> bool {
        true
    }
    async fn get(&self, account: &str) -> Result<Option<String>, Said> {
        let out = tokio::process::Command::new(&self.bin)
            .args(["find-generic-password", "-s", crate::platform::KEYCHAIN_SERVICE, "-a", account, "-w"])
            .output()
            .await
            .map_err(|e| Said::new("读取钥匙串失败：{e}", &[("e", &e.to_string())], "system"))?;
        match out.status.code() {
            Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|t| !t.is_empty())),
            Some(44) => Ok(None),
            c => Err(Said::new("读取钥匙串失败：{e}", &[("e", &format!("exit {}", c.map(|c| c.to_string()).unwrap_or_else(|| "?".into())))], "system")),
        }
    }
    async fn set(&self, account: &str, key: &str) -> Result<(), Said> {
        use tokio::io::AsyncWriteExt;
        let mut child = tokio::process::Command::new(&self.bin)
            .arg("-i")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| Said::new("写入钥匙串失败：{e}", &[("e", &e.to_string())], "system"))?;
        // account and key are shape-checked by the caller: nothing here needs quoting
        let label = tr("Cavil Loop (远程 daemon)", &[]);
        let line = format!("add-generic-password -U -s \"{}\" -a \"{account}\" -l \"{label}\" -w \"{key}\"\n", crate::platform::KEYCHAIN_SERVICE);
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(line.as_bytes()).await.map_err(|e| Said::new("写入钥匙串失败：{e}", &[("e", &e.to_string())], "system"))?;
        }
        let out = child.wait_with_output().await.map_err(|e| Said::new("写入钥匙串失败：{e}", &[("e", &e.to_string())], "system"))?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        if out.status.success() && !stderr.to_lowercase().contains("error") {
            Ok(())
        } else {
            Err(Said::new("写入钥匙串失败：{e}", &[("e", stderr.trim())], "system"))
        }
    }
    async fn clear(&self, account: &str) -> Result<(), Said> {
        let out = tokio::process::Command::new(&self.bin)
            .args(["delete-generic-password", "-s", crate::platform::KEYCHAIN_SERVICE, "-a", account])
            .output()
            .await
            .map_err(|e| Said::new("删除钥匙串条目失败：{e}", &[("e", &e.to_string())], "system"))?;
        match out.status.code() {
            Some(0) | Some(44) => Ok(()),
            c => Err(Said::new("删除钥匙串条目失败：{e}", &[("e", &format!("exit {}", c.map(|c| c.to_string()).unwrap_or_else(|| "?".into())))], "system")),
        }
    }
}

// ── the name and the address ──

/// `name.tailnet.ts.net` or `name.tailnet.ts.net:port` → (host, port). Nothing else is a remote machine.
pub fn parse_host(input: &str) -> Result<(String, u16), String> {
    let t = input.trim().trim_end_matches('.').to_ascii_lowercase();
    let t = t.strip_prefix("https://").unwrap_or(&t).trim_end_matches('/').to_string();
    let (host, port) = match t.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().ok().filter(|p| *p >= 1024).ok_or_else(|| tr("端口不对（要在 1024–65535 之间）", &[]))?),
        None => (t, DEFAULT_PORT),
    };
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let labels: Vec<&str> = host.split('.').collect();
    if host.len() > 253 || labels.len() < 4 || !host.ends_with(".ts.net") || !labels.iter().all(|l| label_ok(l)) {
        return Err(tr("只接受 Tailscale 里的完整机器名（以 .ts.net 结尾，例如 mybox.tailnet-name.ts.net），不接受 IP 地址或别的域名", &[]));
    }
    Ok((host, port))
}

/// 100.64.0.0/10 or fd7a:115c:a1e0::/48 — the ranges Tailscale gives its devices.
pub fn is_tailscale_addr(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// The one rule about what a name resolved to: at least one address, every one a Tailscale address.
fn check_resolved(host: &str, addrs: &[IpAddr]) -> Result<(), Said> {
    if addrs.is_empty() {
        return Err(no_address(host));
    }
    if let Some(bad) = addrs.iter().find(|a| !is_tailscale_addr(a)) {
        return Err(Said::compose("{host} 解析到的不是 Tailscale 地址（{bad}）", &[("host", &Said::outside(host, "user")), ("bad", &Said::outside(&bad.to_string(), "system"))]));
    }
    Ok(())
}

/// "<name> does not resolve": the name is the one the person typed or picked
fn no_address(host: &str) -> Said {
    Said::new("{host} 解析不出地址", &[("host", host)], "user")
}

/// an error of the system / a library, in its own words
fn sys(e: impl std::fmt::Display) -> Said {
    Said::outside(&e.to_string(), "system")
}

thread_local! {
    /// why this thread's lookup was refused (ureq resolves on the calling thread)
    static REFUSED: RefCell<Option<Said>> = const { RefCell::new(None) };
}

/// Test mode: what a name "resolves to" and where the stand-in for that machine really listens.
/// Re-read on every lookup, so a test can take the machine off the network mid-way.
#[derive(Debug, Clone)]
pub struct TestNet {
    /// JSON: `{"<host>": {"resolves": ["100.64.0.5"], "connect": "127.0.0.1:4443"}}`
    pub hosts_file: PathBuf,
    /// PEM of the certificate authority the stand-in's certificate comes from
    pub ca_file: PathBuf,
}

#[derive(Debug)]
struct TailnetResolver {
    test: Option<TestNet>,
}

impl TailnetResolver {
    fn refuse(m: Said) -> ureq::Error {
        let text = m.text();
        REFUSED.with(|r| *r.borrow_mut() = Some(m));
        ureq::Error::Io(std::io::Error::other(text))
    }
}

impl Resolver for TailnetResolver {
    fn resolve(&self, uri: &ureq::http::Uri, config: &ureq::config::Config, timeout: NextTimeout) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let host = uri.host().unwrap_or("").to_string();
        let mut out = self.empty();
        match &self.test {
            None => {
                let found = DefaultResolver::default().resolve(uri, config, timeout).map_err(|e| Self::refuse(Said::compose("{host} 解析不出地址（{e}）", &[("host", &Said::outside(&host, "user")), ("e", &sys(e))])))?;
                let ips: Vec<IpAddr> = found.iter().map(|a| a.ip()).collect();
                check_resolved(&host, &ips).map_err(Self::refuse)?;
                for a in found.iter() {
                    out.push(*a);
                }
            }
            Some(t) => {
                let table: Value = std::fs::read_to_string(&t.hosts_file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
                let entry = &table[&host];
                let ips: Vec<IpAddr> = entry["resolves"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()?.parse().ok()).collect()).unwrap_or_default();
                check_resolved(&host, &ips).map_err(Self::refuse)?;
                let to: SocketAddr = entry["connect"].as_str().and_then(|s| s.parse().ok()).ok_or_else(|| Self::refuse(no_address(&host)))?;
                if !to.ip().is_loopback() {
                    return Err(Self::refuse(Said::plain(tr("测试模式只允许连本机回环地址", &[]))));
                }
                out.push(to);
            }
        }
        Ok(out)
    }
}

// ── signatures ──

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// HMAC-SHA256 (RFC 2104), hex.
pub fn hmac_hex(key: &[u8], msg: &[u8]) -> String {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.iter().map(|b| b ^ 0x36).collect::<Vec<u8>>());
    inner.update(msg);
    let mut outer = Sha256::new();
    outer.update(k.iter().map(|b| b ^ 0x5c).collect::<Vec<u8>>());
    outer.update(inner.finalize());
    hex(&outer.finalize())
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_hex(n: usize) -> Result<String, Said> {
    use std::io::Read;
    let mut b = vec![0u8; n];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).map_err(|e| Said::new("取不到随机数：{e}", &[("e", &e.to_string())], "system"))?;
    Ok(hex(&b))
}

// ── one request ──

struct Target {
    host: String,
    port: u16,
}

struct Signer {
    device: String,
    key: Vec<u8>,
}

struct Reply {
    status: u16,
    body: Value,
    /// the reply carried a signature made with this machine's key
    signed: bool,
}

enum Fail {
    /// the name does not lead to a Tailscale address: nothing was connected
    NotTailscale(Said),
    /// the other end could not prove it is that machine (certificate)
    Identity(Said),
    /// no answer (not reachable, timed out, cut off)
    Unreachable(Said),
    Local(Said),
}

impl Fail {
    fn kind(&self) -> &'static str {
        match self {
            Fail::NotTailscale(_) => "not_tailscale",
            Fail::Identity(_) => "identity",
            Fail::Unreachable(_) => "unreachable",
            Fail::Local(_) => "local",
        }
    }
    fn message(&self) -> Said {
        match self {
            Fail::NotTailscale(m) => Said::compose("无法确认这条连接经过 Tailscale：{m}。请确认这台电脑的 Tailscale 已连上。没有发出任何内容", &[("m", m)]),
            Fail::Identity(m) => Said::compose("对面没能证明自己是这台机器（证书核对不过：{m}）。没有发出任何内容", &[("m", m)]),
            Fail::Unreachable(m) => Said::compose("连不上这台机器：{m}。请确认这台电脑和那台机器的 Tailscale 都已连上，且那台机器上的远程入口在运行", &[("m", m)]),
            Fail::Local(m) => m.clone(),
        }
    }
}

pub struct Remote {
    store: Arc<Store>,
    keys: Arc<dyn KeyStore>,
    test: Option<TestNet>,
    /// the name this computer gives itself when pairing
    device_name: String,
    /// one change to the list at a time
    writing: tokio::sync::Mutex<()>,
}

impl Remote {
    pub fn new(store: Arc<Store>, keys: Arc<dyn KeyStore>, test: Option<TestNet>, device_name: String) -> Remote {
        Remote { store, keys, test, device_name, writing: tokio::sync::Mutex::new(()) }
    }

    /// The app: the keychain on macOS (memory elsewhere), the system resolver, the public
    /// certificate authorities. Test mode (the suites only): a key file, a table of names leading
    /// to loopback stand-ins, and the suite's own certificate authority.
    pub fn from_env(test_mode: bool, os: &str, env: &HashMap<String, String>, store: Arc<Store>) -> Remote {
        let mut test = None;
        let mut keys: Arc<dyn KeyStore> = if os == "macos" { Arc::new(MacKeys::default()) } else { Arc::new(MemoryKeys::default()) };
        let mut name = None;
        if test_mode {
            if let (Some(h), Some(ca)) = (env.get("CAVIL_CLIENT_TEST_REMOTE_HOSTS"), env.get("CAVIL_CLIENT_TEST_REMOTE_CA")) {
                test = Some(TestNet { hosts_file: PathBuf::from(h), ca_file: PathBuf::from(ca) });
            }
            if let Some(f) = env.get("CAVIL_CLIENT_TEST_REMOTE_KEYS") {
                keys = Arc::new(FileKeys(PathBuf::from(f)));
            }
            name = env.get("CAVIL_CLIENT_TEST_REMOTE_NAME").cloned();
        }
        let name = name.unwrap_or_else(|| {
            let out = if os == "macos" { std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() } else { std::process::Command::new("hostname").output() };
            out.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| tr("Cavil Loop 客户端", &[]))
        });
        Remote::new(store, keys, test, name)
    }

    fn agent(&self, limit: Duration) -> Result<ureq::Agent, Said> {
        let roots = match &self.test {
            None => RootCerts::WebPki,
            Some(t) => {
                let pem = std::fs::read(&t.ca_file).map_err(|e| Said::new("读不到测试用的证书：{e}", &[("e", &e.to_string())], "system"))?;
                let certs: Vec<ureq::tls::Certificate<'static>> = ureq::tls::parse_pem(&pem)
                    .filter_map(|i| match i {
                        Ok(ureq::tls::PemItem::Certificate(c)) => Some(c),
                        _ => None,
                    })
                    .collect();
                RootCerts::new_with_certs(&certs)
            }
        };
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .https_only(true)
            .timeout_global(Some(limit))
            .tls_config(TlsConfig::builder().root_certs(roots).build())
            .build();
        Ok(ureq::Agent::with_parts(config, DefaultConnector::default(), TailnetResolver { test: self.test.clone() }))
    }

    /// One HTTPS request to the machine. The resolver refuses a name that is not on Tailscale
    /// before any connection; the TLS handshake refuses a machine that is not that name before
    /// any byte of the request.
    async fn send(&self, t: &Target, method: &'static str, path: &str, body: Option<Value>, signer: Option<&Signer>, limit: Duration) -> Result<Reply, Fail> {
        let agent = self.agent(limit).map_err(Fail::Local)?;
        let url = format!("https://{}:{}{}", t.host, t.port, path);
        let body_text = body.map(|b| b.to_string()).unwrap_or_default();
        let mut headers: Vec<(&'static str, String)> = vec![];
        let mut nonce = String::new();
        if let Some(s) = signer {
            let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0).to_string();
            nonce = random_hex(16).map_err(Fail::Local)?;
            let msg = [method, path, &when, &nonce, &sha256_hex(body_text.as_bytes())].join("\n");
            headers.push(("X-Cavil-Device", s.device.clone()));
            headers.push(("X-Cavil-Time", when));
            headers.push(("X-Cavil-Nonce", nonce.clone()));
            headers.push(("X-Cavil-Signature", hmac_hex(&s.key, msg.as_bytes())));
        }
        let key = signer.map(|s| s.key.clone());
        let path_owned = path.to_string();
        let res = tokio::task::spawn_blocking(move || -> Result<(u16, Option<String>, String), Fail> {
            REFUSED.with(|r| *r.borrow_mut() = None);
            let mut b = ureq::http::Request::builder().method(method).uri(url.as_str()).header("Content-Type", "application/json");
            for (k, v) in &headers {
                b = b.header(*k, v.as_str());
            }
            let run = if method == "GET" {
                b.body(()).map_err(|e| Fail::Local(sys(e))).and_then(|r| agent.run(r).map_err(classify))
            } else {
                b.body(body_text.clone()).map_err(|e| Fail::Local(sys(e))).and_then(|r| agent.run(r).map_err(classify))
            };
            let mut res = run?;
            let status = res.status().as_u16();
            let sig = res.headers().get("X-Cavil-Signature").and_then(|v| v.to_str().ok()).map(str::to_string);
            let text = res.body_mut().with_config().limit(8 * 1024 * 1024).read_to_string().map_err(|e| Fail::Unreachable(Said::new("回复没有收全（{e}）", &[("e", &e.to_string())], "system")))?;
            Ok((status, sig, text))
        })
        .await
        .map_err(|e| Fail::Local(sys(e)))??;
        let (status, sig, text) = res;
        let signed = match (&key, &sig) {
            (Some(k), Some(sig)) => same(&hmac_hex(k, ["resp", &nonce, &status.to_string(), &sha256_hex(text.as_bytes())].join("\n").as_bytes()), sig),
            _ => false,
        };
        let body = serde_json::from_str::<Value>(&text).map_err(|_| Fail::Unreachable(Said::plain(tr("{path} 的回复不是 JSON（状态码 {status}）", &[("path", &path_owned), ("status", &status.to_string())]))))?;
        Ok(Reply { status, body, signed })
    }

    // ── the list ──

    fn list_raw(&self) -> Vec<Value> {
        self.store.get_setting(REMOTES).and_then(|v| v.as_array().cloned()).unwrap_or_default()
    }

    fn save(&self, list: &[Value]) -> Result<(), Said> {
        self.store.set_setting(REMOTES, &Value::Array(list.to_vec())).map_err(|e| e.said())
    }

    fn find(&self, id: &str) -> Option<Value> {
        self.list_raw().into_iter().find(|r| r["id"].as_str() == Some(id))
    }

    async fn update(&self, id: &str, f: impl FnOnce(&mut Value)) -> Result<(), Said> {
        let _g = self.writing.lock().await;
        let mut list = self.list_raw();
        if let Some(r) = list.iter_mut().find(|r| r["id"].as_str() == Some(id)) {
            f(r);
        }
        self.save(&list)
    }

    async fn remove(&self, id: &str) -> Result<(), Said> {
        let _g = self.writing.lock().await;
        let list: Vec<Value> = self.list_raw().into_iter().filter(|r| r["id"].as_str() != Some(id)).collect();
        self.save(&list)
    }

    /// The machines this computer's Tailscale knows, for picking one instead of typing its name
    /// (GitHub#387, "pair without a terminal"). Read-only: `tailscale status --json` here, then one
    /// unsigned `GET /v1/hello` to each online machine through the same checks as every other
    /// request (Tailscale address, certificate for that name). Nothing about this computer is sent.
    ///
    /// Each machine's `remote` is `open` (the entry answered as ours), `closed` (the connection was
    /// refused: nothing listens there), `unknown` (anything else — timed out, certificate, another
    /// service; never shown as "closed") or `offline` (Tailscale says it is not online: not asked).
    /// A device list that cannot be read is `unreadable`, never an empty list.
    pub async fn tailnet(&self, daemon: &crate::daemon::Daemon) -> Value {
        let path = match daemon.path().await {
            Ok(p) => if cfg!(target_os = "macos") { format!("{p}:/Applications/Tailscale.app/Contents/MacOS") } else { p },
            // the local daemon's own words (crate::daemon), already in the window's language
            Err(m) => return unreadable(&Said::plain(m)),
        };
        let out = daemon.run(&path, "tailscale", &["status", "--json"], T_QUICK).await;
        if !out.ok() {
            return unreadable(&sys(out.text()));
        }
        let peers = match parse_tailnet_said(&out.stdout) {
            Ok(p) => p,
            Err(m) => return unreadable(&m),
        };
        let probes = peers.into_iter().map(|mut p| async move {
            if p["online"] == json!(true) {
                let (state, why) = self.hello(p["host"].as_str().unwrap_or("")).await;
                p["remote"] = json!(state);
                if let Some(w) = why {
                    p["why"] = json!(w.text());
                    p["whySaid"] = w.to_json();
                }
            } else {
                p["remote"] = json!("offline");
            }
            p
        });
        let list: Vec<Value> = futures::future::join_all(probes).await;
        json!({ "result": "ok", "devices": list })
    }

    async fn hello(&self, host: &str) -> (&'static str, Option<Said>) {
        let t = Target { host: host.to_string(), port: DEFAULT_PORT };
        match self.send(&t, "GET", "/v1/hello", None, None, T_HELLO).await {
            Ok(r) if r.status == 200 && r.body["service"] == "cavil-loop-remote" => ("open", None),
            Ok(r) => ("unknown", Some(Said::plain(tr("这台机器的 {port} 端口上不是远程入口（状态码 {status}）", &[("port", &DEFAULT_PORT.to_string()), ("status", &r.status.to_string())])))),
            Err(Fail::Unreachable(m)) if m.text().to_lowercase().contains("refused") => ("closed", None),
            Err(f) => ("unknown", Some(f.message())),
        }
    }

    pub fn list(&self) -> Value {
        json!({ "remotes": self.list_raw(), "persistent": self.keys.persistent() })
    }

    /// A paired machine and its key, ready to sign; Err = a refusal to show.
    async fn paired(&self, id: &str) -> Result<(Target, Signer), Value> {
        let Some(r) = self.find(id) else { return Err(refused("no_remote", &own(tr("没有这台远程机器", &[])))) };
        if r["state"] != "paired" {
            return Err(refused("pending_revoke", &own(tr("这台机器正在取消配对，不再读取或操作它", &[]))));
        }
        self.signer_of(&r).await
    }

    async fn signer_of(&self, r: &Value) -> Result<(Target, Signer), Value> {
        let (Some(host), Some(port), Some(device), Some(id)) = (r["host"].as_str(), r["port"].as_u64(), r["device"].as_str(), r["id"].as_str()) else {
            return Err(refused("local", &own(tr("这台远程机器的记录不完整，请取消配对后重新配对", &[]))));
        };
        let key = match self.keys.get(id).await {
            Ok(Some(k)) if key_shape(&k) => unhex(&k).unwrap_or_default(),
            Ok(_) => return Err(refused("no_key", &own(tr("这台电脑上找不到这台机器的钥匙（可能被删掉了），请取消配对后重新配对", &[])))),
            Err(e) => return Err(refused("local", &Said::compose("读不到这台机器的钥匙：{e}", &[("e", &e)]))),
        };
        Ok((Target { host: host.to_string(), port: port as u16 }, Signer { device: device.to_string(), key }))
    }

    // ── pairing ──

    pub async fn pair(&self, host_input: &str, code: &str) -> Value {
        let (host, port) = match parse_host(host_input) {
            Ok(v) => v,
            Err(m) => return refused("bad_host", &own(m)),
        };
        let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
        if code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return refused("bad_code", &own(tr("配对码是 8 位数字", &[])));
        }
        let id = format!("{host}:{port}");
        if !account_shape(&id) {
            return refused("bad_host", &own(tr("机器名不合规", &[])));
        }
        if self.find(&id).is_some() {
            return refused("exists", &own(tr("这台机器已经在列表里了；要重新配对，先取消配对", &[])));
        }
        let t = Target { host: host.clone(), port };
        let reply = match self.send(&t, "POST", "/v1/pair", Some(json!({ "code": code, "name": self.device_name })), None, T_PAIR).await {
            Ok(r) => r,
            Err(f) => return refused(f.kind(), &f.message()),
        };
        if reply.status != 200 {
            return refused(reply.body["error"].as_str().unwrap_or("failed"), &said(&reply));
        }
        let (Some(device), Some(key)) = (reply.body["id"].as_str(), reply.body["key"].as_str()) else {
            return refused("failed", &own(tr("对面的回复里没有钥匙，没有配对", &[])));
        };
        if reply.body["version"] != 1 || !key_shape(key) || device.is_empty() || device.len() > 64 || !device.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return refused("failed", &own(tr("对面的回复格式认不出，没有配对（客户端可能需要更新）", &[])));
        }
        let signer = Signer { device: device.to_string(), key: unhex(key).unwrap_or_default() };
        // the key first, the list second: a listed machine always has its key
        if let Err(e) = self.keys.set(&id, key).await {
            // tell the machine to forget the key it just made; if that fails too, say so
            let undone = matches!(self.send(&t, "POST", "/v1/unpair", None, Some(&signer), T_QUICK).await, Ok(r) if r.status == 200 && r.signed);
            let m = if undone {
                Said::compose("钥匙没能存下来（{e}），没有配对。那台机器上的授权已撤销", &[("e", &e)])
            } else {
                Said::compose("钥匙没能存下来（{e}），没有配对。那台机器上已经登记了这台电脑，请在那台机器上撤销一次", &[("e", &e)])
            };
            return refused("local", &m);
        }
        let entry = json!({ "id": id, "host": host, "port": port, "device": device, "state": "paired", "paired_at": now_secs(), "last": Value::Null });
        let saved = {
            let _g = self.writing.lock().await;
            let mut list = self.list_raw();
            list.push(entry);
            self.save(&list)
        };
        if let Err(e) = saved {
            let _ = self.send(&t, "POST", "/v1/unpair", None, Some(&signer), T_QUICK).await;
            let _ = self.keys.clear(&id).await;
            return refused("local", &Said::compose("配对记录没能存下来（{e}），没有配对", &[("e", &e)]));
        }
        json!({ "result": "paired", "id": id })
    }

    // ── reading and acting ──

    /// `{state: "ok", status, at}` — or `{state: <why not>, message}`; the last status read stays in the list.
    pub async fn status(&self, id: &str) -> Value {
        let (t, s) = match self.paired(id).await {
            Ok(v) => v,
            Err(r) => return json!({ "state": r["reason"], "message": r["output"], "messageSaid": r["outputSaid"] }),
        };
        let reply = match self.send(&t, "GET", "/v1/status", None, Some(&s), T_CALL).await {
            Ok(r) => r,
            Err(f) => return failed_read(f.kind(), &f.message()),
        };
        if let Some(problem) = unbelievable(&reply) {
            return problem;
        }
        if reply.status != 200 {
            return failed_read(reply.body["error"].as_str().unwrap_or("failed"), &said(&reply));
        }
        let st = &reply.body["status"];
        if !crate::daemon::status_shape(st) {
            return failed_read("unreadable", &Said::new("那台机器返回的状态格式认不出（version = {v}），客户端或那台机器的 daemon 可能需要更新", &[("v", &st["version"].to_string())], "remote"));
        }
        let at = now_secs();
        let kept = self.update(id, |r| r["last"] = json!({ "at": at, "status": st })).await;
        json!({ "state": "ok", "status": st, "at": at, "kept": kept.as_ref().err().map(Said::text), "keptSaid": kept.as_ref().err().map(Said::to_json) })
    }

    /// `action`: "stop" | "start"
    pub async fn service(&self, id: &str, key: &str, action: &str) -> Value {
        if !crate::daemon::valid_key(key) {
            return refused("local", &own(tr("项目名不合规", &[])));
        }
        if action != "stop" && action != "start" {
            return refused("local", &own(tr("未知操作", &[])));
        }
        let (t, s) = match self.paired(id).await {
            Ok(v) => v,
            Err(r) => return r,
        };
        let path = format!("/v1/projects/{key}/{action}");
        let reply = match self.send(&t, "POST", &path, None, Some(&s), T_CALL).await {
            Ok(r) => r,
            // no answer after a connection was made: the request may or may not have been carried out — say so instead of guessing
            Err(f @ Fail::Unreachable(_)) => {
                let m = if action == "stop" {
                    Said::compose("{m}。这次「停」有没有执行不确定，请重新读取状态", &[("m", &f.message())])
                } else {
                    Said::compose("{m}。这次「启」有没有执行不确定，请重新读取状态", &[("m", &f.message())])
                };
                return json!({ "result": "unknown", "reason": f.kind(), "state": "unknown", "output": m.text(), "outputSaid": m.to_json() });
            }
            // refused before anything was sent
            Err(f) => return refused(f.kind(), &f.message()),
        };
        if let Some(problem) = unbelievable(&reply) {
            return json!({ "result": "refused", "reason": problem["state"], "output": problem["message"], "outputSaid": problem["messageSaid"] });
        }
        if reply.status != 200 {
            return refused(reply.body["error"].as_str().unwrap_or("failed"), &said(&reply));
        }
        let result = reply.body["result"].as_str().unwrap_or("failed");
        let state = match reply.body["state"].as_str() {
            Some(s @ ("running" | "stopped")) => s,
            _ => "unknown",
        };
        let output = reply.body["output"].as_str().unwrap_or("");
        // the machine's own words (its scripts' output), shown as it sent them
        json!({ "result": if matches!(result, "ok" | "failed" | "refused" | "not_found") { result } else { "failed" }, "state": state, "output": output, "outputSaid": Said::outside(output, "remote").to_json() })
    }

    pub async fn log(&self, id: &str, key: &str) -> Value {
        if !crate::daemon::valid_key(key) {
            return refused("local", &own(tr("项目名不合规", &[])));
        }
        let (t, s) = match self.paired(id).await {
            Ok(v) => v,
            Err(r) => return r,
        };
        let reply = match self.send(&t, "GET", &format!("/v1/projects/{key}/log"), None, Some(&s), T_CALL).await {
            Ok(r) => r,
            Err(f) => return refused(f.kind(), &f.message()),
        };
        if let Some(problem) = unbelievable(&reply) {
            return json!({ "result": "refused", "reason": problem["state"], "output": problem["message"], "outputSaid": problem["messageSaid"] });
        }
        if reply.status != 200 {
            return refused(reply.body["error"].as_str().unwrap_or("failed"), &said(&reply));
        }
        json!({ "result": "ok", "exists": reply.body["exists"] == true, "path": reply.body["path"].as_str().unwrap_or(""), "text": reply.body["text"].as_str().unwrap_or("") })
    }

    // ── a project's settings (GitHub#530) ──
    //
    // The machine runs its own scripts/project-config.sh, exactly as "本机 daemon → 配置" does here: it
    // decides where the file is, what may be changed and whether the file is still the one that was
    // read. The replies have the shapes of the local `daemonConfigGet` / `daemonConfigSet`, so the
    // same form shows both.

    /// `{result:"ok", config}` / `{result:"unsupported"|"unreadable"|"not_found"|"refused", output}`
    pub async fn config_get(&self, id: &str, key: &str) -> Value {
        if !crate::daemon::valid_key(key) {
            return refused("local", &own(tr("项目名不合规", &[])));
        }
        let (t, s) = match self.paired(id).await {
            Ok(v) => v,
            Err(r) => return r,
        };
        let reply = match self.send(&t, "GET", &format!("/v1/projects/{key}/config"), None, Some(&s), T_CALL).await {
            Ok(r) => r,
            Err(f) => return refused(f.kind(), &f.message()),
        };
        if let Some(problem) = unbelievable(&reply) {
            return json!({ "result": "refused", "reason": problem["state"], "output": problem["message"], "outputSaid": problem["messageSaid"] });
        }
        if reply.status == 404 && reply.body["error"] == "not_found" {
            let m = old_machine();
            return json!({ "result": "unsupported", "output": m.text(), "outputSaid": m.to_json() });
        }
        if reply.status != 200 {
            return refused(reply.body["error"].as_str().unwrap_or("failed"), &said(&reply));
        }
        let b = &reply.body;
        match b["result"].as_str() {
            Some("ok") => {
                let c = &b["config"];
                if c["version"] == 1 && c["state"] == "ok" && c["fields"].is_array() && c["rev"].is_string() {
                    json!({ "result": "ok", "config": c })
                } else {
                    let v = c["version"].to_string();
                    unreadable(&Said::new("那台机器返回的配置格式认不出（version = {v}），客户端或那台机器的 daemon 可能需要更新", &[("v", &v)], "remote"))
                }
            }
            Some(w @ ("not_found" | "refused")) => {
                let out = b["output"].as_str().unwrap_or("");
                json!({ "result": w, "output": out, "outputSaid": Said::outside(out, "remote").to_json() })
            }
            // "unreadable" and anything this client does not know: never shown as "nothing set"
            _ => match b["output"].as_str() {
                Some(out) => json!({ "result": "unreadable", "output": out, "outputSaid": Said::outside(out, "remote").to_json() }),
                None => unreadable(&own(tr("那台机器读不出这个项目的配置", &[]))),
            },
        }
    }

    /// `values`: `{SETTING: "value"}`. `{result: <the script's word> | "unconfirmed" | "refused", output, detail}`
    pub async fn config_set(&self, id: &str, key: &str, rev: &str, values: &Value) -> Value {
        if !crate::daemon::valid_key(key) {
            return refused("local", &own(tr("项目名不合规", &[])));
        }
        if !crate::daemon_config::valid_rev(rev) {
            return refused("local", &own(tr("指纹不合规：先重新读取配置", &[])));
        }
        let Some(map) = values.as_object().filter(|m| !m.is_empty() && m.len() <= 64) else { return refused("local", &own(tr("没有要改的配置项", &[]))) };
        for (name, v) in map {
            let Some(v) = v.as_str() else { return refused("local", &Said::new("{name} 的值不是文本", &[("name", name)], "daemon")) };
            if !crate::daemon_config::valid_setting(name) {
                return refused("local", &own(tr("配置项的名字不合规", &[])));
            }
            if !crate::daemon_config::valid_value(v) {
                return refused("local", &Said::new("{name} 的值里有不能写进配置文件的字符", &[("name", name)], "daemon"));
            }
        }
        let (t, s) = match self.paired(id).await {
            Ok(v) => v,
            Err(r) => return r,
        };
        let body = json!({ "rev": rev, "values": map });
        let reply = match self.send(&t, "POST", &format!("/v1/projects/{key}/config"), Some(body), Some(&s), T_CONFIG_SAVE).await {
            Ok(r) => r,
            // no answer after a connection was made: the save may or may not have happened — say so instead of guessing
            Err(f @ Fail::Unreachable(_)) => {
                let m = Said::compose("{m}。这次保存有没有执行不确定，请重新读取配置核对", &[("m", &f.message())]);
                return json!({ "result": "unconfirmed", "reason": f.kind(), "output": m.text(), "outputSaid": m.to_json(), "detail": {} });
            }
            // refused before anything was sent
            Err(f) => return refused(f.kind(), &f.message()),
        };
        // The request was sent. An answer without this machine's signature (missing, wrong, or a
        // refusal nobody can vouch for) says nothing about whether the save happened — the machine may
        // have written the file and the signature got lost on the way. Only a signed answer decides.
        if let Some(problem) = unbelievable(&reply) {
            let why = crate::daemon::said_from_json(&problem["messageSaid"])
                .unwrap_or_else(|| problem["message"].as_str().map(|m| own(m.to_string())).unwrap_or_else(|| own(tr("回复没有能验证的签名", &[]))));
            let m = Said::compose("{m}。这次保存有没有执行不确定，请重新读取配置核对", &[("m", &why)]);
            return json!({ "result": "unconfirmed", "reason": problem["state"], "output": m.text(), "outputSaid": m.to_json(), "detail": {} });
        }
        if reply.status == 404 && reply.body["error"] == "not_found" {
            return refused("unsupported", &old_machine());
        }
        if reply.status != 200 {
            return refused(reply.body["error"].as_str().unwrap_or("failed"), &said(&reply));
        }
        let b = &reply.body;
        // a result word as the script prints it; anything else is "unconfirmed", never one of its words
        let result = match b["result"].as_str() {
            Some(w) if !w.is_empty() && w.len() <= 40 && w.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') => w,
            _ => "unconfirmed",
        };
        let detail = if b["detail"].is_object() { b["detail"].clone() } else { json!({}) };
        let out = b["output"].as_str().unwrap_or("");
        json!({ "result": result, "output": out, "outputSaid": Said::outside(out, "remote").to_json(), "detail": detail })
    }

    // ── unpairing ──

    /// Ask the machine to revoke this computer. Only its signed "revoked" counts; then the key and
    /// the entry go. `local_only` (after the person was told what it means): stop using the key,
    /// keep the entry as "pending_revoke" and the key for the later revocation.
    pub async fn unpair(&self, id: &str, local_only: bool) -> Value {
        let Some(r) = self.find(id) else { return refused("no_remote", &own(tr("没有这台远程机器", &[]))) };
        let confirmed = self.ask_revoke(&r).await;
        match confirmed {
            Ok(()) => self.forget_local(id).await,
            Err(why) if local_only => match self.update(id, |r| r["state"] = json!("pending_revoke")).await {
                Ok(()) => json!({ "result": "pending", "reason": why["reason"], "output": why["output"], "outputSaid": why["outputSaid"] }),
                Err(e) => refused("local", &Said::compose("没能记下「取消配对未完成」（{e}），什么都没改", &[("e", &e)])),
            },
            Err(why) => json!({ "result": "unconfirmed", "reason": why["reason"], "output": why["output"], "outputSaid": why["outputSaid"] }),
        }
    }

    /// The person says the authorization was revoked on the machine itself: drop a pending entry and its key.
    pub async fn forget(&self, id: &str) -> Value {
        match self.find(id) {
            Some(r) if r["state"] == "pending_revoke" => self.forget_local(id).await,
            Some(_) => refused("local", &own(tr("这台机器还在配对中；要移除它，先取消配对", &[]))),
            None => refused("no_remote", &own(tr("没有这台远程机器", &[]))),
        }
    }

    async fn ask_revoke(&self, r: &Value) -> Result<(), Value> {
        let (t, s) = self.signer_of(r).await?;
        let reply = self.send(&t, "POST", "/v1/unpair", None, Some(&s), T_QUICK).await.map_err(|f| refused(f.kind(), &f.message()))?;
        if reply.status == 200 && reply.signed && matches!(reply.body["result"].as_str(), Some("revoked" | "absent")) {
            return Ok(());
        }
        if reply.status == 401 && reply.body["error"] == "revoked" {
            return Err(refused("revoked_unsigned", &own(tr("对面说这台电脑没有配对（可能已在那台机器上撤销），但这句话没有签名，无法确认是不是那台机器说的", &[]))));
        }
        Err(refused(reply.body["error"].as_str().unwrap_or("failed"), &said(&reply)))
    }

    async fn forget_local(&self, id: &str) -> Value {
        // the entry first: a key without an entry is harmless, an entry without a key is confusing
        if let Err(e) = self.remove(id).await {
            return refused("local", &Said::compose("没能从列表里移除（{e}）", &[("e", &e)]));
        }
        match self.keys.clear(id).await {
            Ok(()) => json!({ "result": "unpaired" }),
            Err(e) => {
                let m = Said::compose("已取消配对，但这台电脑上的钥匙没能删除（{e}）；它已经没有用了，可以在「钥匙串访问」里搜「Cavil Loop」手动删除", &[("e", &e)]);
                json!({ "result": "unpaired", "output": m.text(), "outputSaid": m.to_json() })
            }
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `tailscale status --json` → the other machines with a usable Tailscale name, sorted by name.
///
/// Only the shape Tailscale gives counts: an object with a `BackendState` word and a `Self`
/// object; `Peer` absent or null (no other machine) or an object of machine objects, each with an
/// `Online` true / false. Anything else is Err — the list is not known, never an empty one.
/// Tailscale not running (`BackendState` other than `Running`) is Err too: its peer list is stale.
pub fn parse_tailnet(text: &str) -> Result<Vec<Value>, String> {
    parse_tailnet_said(text).map_err(|e| e.text())
}

fn parse_tailnet_said(text: &str) -> Result<Vec<Value>, Said> {
    let odd = || Said::plain(tr("这台电脑的 Tailscale 给出的设备列表认不出", &[]));
    let v: Value = serde_json::from_str(text).map_err(|_| odd())?;
    let (Some(state), Some(me)) = (v.get("BackendState").and_then(Value::as_str), v.get("Self").filter(|s| s.is_object())) else {
        return Err(odd());
    };
    if state != "Running" {
        // Tailscale's own word for its state
        return Err(Said::new("这台电脑的 Tailscale 没有连上（状态：{state}）", &[("state", state)], "system"));
    }
    let me = me["DNSName"].as_str().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
    let peers = match v.get("Peer") {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Object(m)) => m,
        Some(_) => return Err(odd()),
    };
    let mut out = vec![];
    for p in peers.values() {
        let (Some(_), Some(online)) = (p.as_object(), p.get("Online").and_then(Value::as_bool)) else {
            return Err(odd()); // one machine that cannot be read makes the list not known
        };
        let dns = p["DNSName"].as_str().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
        let Ok((host, _)) = parse_host(&dns) else { continue }; // not reachable by a Tailscale name: cannot be paired
        if host == me {
            continue;
        }
        let name = p["HostName"].as_str().filter(|s| !s.trim().is_empty()).map(str::to_string).unwrap_or_else(|| host.split('.').next().unwrap_or("").to_string());
        out.push(json!({ "host": host, "name": name, "os": p["OS"].as_str().unwrap_or(""), "online": online }));
    }
    out.sort_by(|a, b| a["host"].as_str().cmp(&b["host"].as_str()));
    Ok(out)
}

/// A refusal: `output` is the message as one string (what it always was), `outputSaid` the same
/// message with the outside parts marked (GitHub#473), for the window to draw.
fn refused(reason: &str, m: &Said) -> Value {
    json!({ "result": "refused", "reason": reason, "output": m.text(), "outputSaid": m.to_json() })
}

/// A read that gave no status: why, as one string and marked.
fn failed_read(state: &str, m: &Said) -> Value {
    json!({ "state": state, "message": m.text(), "messageSaid": m.to_json() })
}

/// What a machine whose remote entry predates GitHub#530 answers to a config request (404 "没有这个请求").
fn old_machine() -> Said {
    own(tr("那台机器的 daemon 还不支持在这里改配置：更新那台机器的 daemon 以后再试，或到那台机器上用编辑器改", &[]))
}

fn unreadable(m: &Said) -> Value {
    json!({ "result": "unreadable", "output": m.text(), "outputSaid": m.to_json() })
}

/// the client's own words, nothing from outside in them
fn own(m: String) -> Said {
    Said::plain(m)
}

/// What the machine said went wrong, in its words.
fn said(r: &Reply) -> Said {
    match r.body["message"].as_str() {
        Some(m) if !m.is_empty() => Said::new("那台机器的回答：{m}", &[("m", m)], "remote"),
        _ => Said::plain(tr("那台机器回了状态码 {status}", &[("status", &r.status.to_string())])),
    }
}

/// A reply to a signed request that cannot be taken as that machine's word.
fn unbelievable(r: &Reply) -> Option<Value> {
    if r.signed {
        return None;
    }
    if r.status == 401 && r.body["error"] == "revoked" {
        return Some(failed_read("revoked", &own(tr("那台机器说这台电脑没有配对（配对可能已在那台机器上被撤销）。要继续使用，请取消配对后重新配对", &[]))));
    }
    if r.status == 200 {
        return Some(failed_read("mismatch", &own(tr("对面的回复没有配对钥匙的签名：它不是配对过的那台机器，没有采信它返回的内容", &[]))));
    }
    // an unsigned refusal (made before the machine knew which device asked): show its words, as unverified
    Some(failed_read(r.body["error"].as_str().unwrap_or("failed"), &Said::compose("{m}（这句话没有签名）", &[("m", &said(r))])))
}

fn classify(e: ureq::Error) -> Fail {
    if let Some(m) = REFUSED.with(|r| r.borrow_mut().take()) {
        return Fail::NotTailscale(m);
    }
    match e {
        ureq::Error::Tls(m) => Fail::Identity(sys(m)),
        ureq::Error::Rustls(m) => Fail::Identity(sys(m)),
        ureq::Error::Timeout(_) => Fail::Unreachable(Said::plain(tr("超时", &[]))),
        other => {
            // rustls reports a certificate it does not accept through the connection's io error
            let m = other.to_string();
            let l = m.to_lowercase();
            if l.contains("certificate") || l.contains("unknownissuer") || l.contains("notvalidforname") {
                Fail::Identity(sys(m))
            } else {
                Fail::Unreachable(sys(m))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailnet_list() {
        let js = r#"{"BackendState":"Running","Self":{"DNSName":"me.tn.ts.net."},"Peer":{
            "k1":{"HostName":"futurelab-01","DNSName":"futurelab-01.tn.ts.net.","OS":"linux","Online":true},
            "k2":{"HostName":"phone","DNSName":"phone.tn.ts.net.","OS":"iOS","Online":false},
            "k3":{"HostName":"odd","DNSName":"","OS":"linux","Online":true},
            "k4":{"HostName":"me","DNSName":"me.tn.ts.net.","Online":true}}}"#;
        let l = parse_tailnet(js).unwrap();
        let hosts: Vec<&str> = l.iter().map(|p| p["host"].as_str().unwrap()).collect();
        // sorted; no name = cannot be paired, left out; this computer left out
        assert_eq!(hosts, ["futurelab-01.tn.ts.net", "phone.tn.ts.net"]);
        assert_eq!(l[0]["online"], true);
        assert_eq!(l[1]["online"], false);
        // no other machine (Peer absent or null) is a real, empty list
        assert_eq!(parse_tailnet(r#"{"BackendState":"Running","Self":{}}"#).unwrap().len(), 0);
        assert_eq!(parse_tailnet(r#"{"BackendState":"Running","Self":{},"Peer":null}"#).unwrap().len(), 0);
        assert_eq!(parse_tailnet(r#"{"BackendState":"Running","Self":{},"Peer":{}}"#).unwrap().len(), 0);
        // anything not in Tailscale's shape is not known — never an empty list (PR #400 review round 7)
        for bad in [
            "not json",
            r#"{"unexpected":true}"#,
            r#"[]"#,
            r#"{"Self":{},"Peer":null}"#,
            r#"{"BackendState":"Running","Peer":null}"#,
            r#"{"BackendState":"Running","Self":"x"}"#,
            r#"{"BackendState":"Running","Self":{},"Peer":[1]}"#,
            r#"{"BackendState":"Running","Self":{},"Peer":{"k":1}}"#,
            r#"{"BackendState":"Running","Self":{},"Peer":{"k":{"DNSName":"a.tn.ts.net."}}}"#,
        ] {
            assert!(parse_tailnet(bad).is_err(), "{bad}");
        }
        // Tailscale not connected: its peer list is stale, not shown
        assert!(parse_tailnet(r#"{"BackendState":"Stopped","Self":{},"Peer":{}}"#).unwrap_err().contains("Stopped"));
    }

    #[test]
    fn only_full_tailscale_names_are_accepted() {
        assert_eq!(parse_host("MyBox.Tail-Net.ts.net").unwrap(), ("mybox.tail-net.ts.net".into(), DEFAULT_PORT));
        assert_eq!(parse_host(" mybox.tailnet.ts.net:47999 ").unwrap(), ("mybox.tailnet.ts.net".into(), 47999));
        assert_eq!(parse_host("https://mybox.tailnet.ts.net/").unwrap().0, "mybox.tailnet.ts.net");
        for bad in ["100.64.0.5", "100.64.0.5:47387", "mybox", "mybox.ts.net", "mybox.tailnet.ts.net.evil.com", "mybox.tailnet.example.com", "a b.tailnet.ts.net", "mybox.tailnet.ts.net:80", "mybox.tailnet.ts.net:x", "-x.tailnet.ts.net", "user@mybox.tailnet.ts.net", "mybox.tailnet.ts.net/path", ""] {
            assert!(parse_host(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn tailscale_address_ranges() {
        for ok in ["100.64.0.1", "100.127.255.254", "100.100.100.100", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12::7"] {
            assert!(is_tailscale_addr(&ok.parse().unwrap()), "{ok}");
        }
        for bad in ["100.63.255.255", "100.128.0.1", "10.0.0.1", "192.168.1.5", "127.0.0.1", "8.8.8.8", "fd7a:115c:a1e1::1", "::1", "2001:db8::1"] {
            assert!(!is_tailscale_addr(&bad.parse().unwrap()), "{bad}");
        }
        assert!(check_resolved("h", &[]).is_err());
        assert!(check_resolved("h", &["100.64.0.1".parse().unwrap()]).is_ok());
        // one address off Tailscale spoils the lot: the connection could go to that one
        assert!(check_resolved("h", &["100.64.0.1".parse().unwrap(), "8.8.8.8".parse().unwrap()]).is_err());
    }

    #[test]
    fn hmac_matches_the_rfc_4231_vectors() {
        assert_eq!(hmac_hex(&[0x0b; 20], b"Hi There"), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
        assert_eq!(hmac_hex(b"Jefe", b"what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        assert_eq!(hmac_hex(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First"), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }
}
