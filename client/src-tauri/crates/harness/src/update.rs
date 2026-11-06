// Test-only: the app's updater (cavil_core::update) with a back end that talks
// to the fake GitHub, so the TypeScript suites drive the real decisions — which
// release, when, one round at a time, timeouts, a stalled download, what a
// failure shows — against real HTTP on loopback and the test's clock.
//
// What this back end does instead of the shell's (Tauri's updater plugin):
//   - the release list: the app's own `fetch_releases` (real HTTP, no credential)
//   - the manifest: the same shape the release job publishes (version, platforms[target].url/signature)
//   - "signature": the package's sha256 in hex must equal the manifest's `signature`
//     (a stand-in: the real minisign check is the plugin's, run on the CI Macs)
//   - install: the bytes are written to <dir>/installed.bin; a test can make it fail

use async_trait::async_trait;
use cavil_core::http::{self, Endpoints, HttpRequest};
use cavil_core::platform::Clock;
use cavil_core::store::Store;
use cavil_core::update::{self, Backend, Failure, Found, Timings, Updater};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub struct FakeBackend {
    pub endpoints: Endpoints,
    pub current: String,
    pub target: String,
    pub dir: PathBuf,
    pub fail_install: AtomicBool,
    seq: AtomicU64,
    found: Mutex<HashMap<u64, (String, String)>>,
}

impl FakeBackend {
    pub fn new(endpoints: Endpoints, current: &str, target: &str, dir: PathBuf) -> FakeBackend {
        FakeBackend {
            endpoints,
            current: current.into(),
            target: target.into(),
            dir,
            fail_install: AtomicBool::new(false),
            seq: AtomicU64::new(1),
            found: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl Backend for FakeBackend {
    async fn releases(&self) -> Result<Vec<Value>, String> {
        update::fetch_releases(&self.endpoints).await
    }

    async fn check(&self, url: &str) -> Result<Option<Found>, Failure> {
        let res = http::send(HttpRequest { method: "GET".into(), url: url.into(), headers: vec![], body: None })
            .await
            .map_err(Failure::Network)?;
        if res.status != 200 {
            return Err(Failure::Network(format!("HTTP {}", res.status)));
        }
        let m: Value = serde_json::from_str(&res.body).map_err(|_| Failure::Invalid("更新说明文件看不懂".into()))?;
        let version = m["version"].as_str().ok_or_else(|| Failure::Invalid("更新说明文件没有版本号".into()))?.to_string();
        let (Some(new), Some(cur)) = (update::parse_version(&version), update::parse_version(&self.current)) else {
            return Err(Failure::Invalid(format!("版本号看不懂：{version}")));
        };
        if new <= cur {
            return Ok(None);
        }
        let p = &m["platforms"][&self.target];
        let (Some(u), Some(sig)) = (p["url"].as_str(), p["signature"].as_str()) else {
            return Err(Failure::Invalid(format!("更新说明文件里没有这台机器（{}）的更新包", self.target)));
        };
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        self.found.lock().unwrap().insert(id, (u.to_string(), sig.to_string()));
        Ok(Some(Found { version, id }))
    }

    async fn download(&self, found: &Found, got: Box<dyn Fn(u64, Option<u64>) + Send + Sync>) -> Result<Vec<u8>, Failure> {
        let (url, sig) = self.found.lock().unwrap().get(&found.id).cloned().ok_or(Failure::Invalid("没有这个更新".into()))?;
        let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, Failure> {
            let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).max_redirects(0).build().into();
            let res = agent.get(&url).call().map_err(|e| Failure::Network(e.to_string()))?;
            if res.status().as_u16() != 200 {
                return Err(Failure::Network(format!("HTTP {}", res.status().as_u16())));
            }
            let total = res.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
            let mut reader = res.into_body().into_reader();
            let mut buf = vec![];
            let mut chunk = [0u8; 4096];
            loop {
                let n = reader.read(&mut chunk).map_err(|e| Failure::Network(format!("网络中断（{e}）")))?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                got(buf.len() as u64, total);
            }
            if total.is_some_and(|t| t != buf.len() as u64) {
                return Err(Failure::Network("网络中断（没收全）".into()));
            }
            Ok(buf)
        })
        .await
        .map_err(|e| Failure::Network(e.to_string()))??;
        let hex: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if hex != sig {
            return Err(Failure::Signature("签名不符".into()));
        }
        Ok(bytes)
    }

    async fn install(&self, _found: &Found, bytes: Vec<u8>) -> Result<(), Failure> {
        if self.fail_install.load(Ordering::SeqCst) {
            return Err(Failure::Install("没有权限写入（测试要求失败）".into()));
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| Failure::Install(e.to_string()))?;
        std::fs::write(self.dir.join("installed.bin"), bytes).map_err(|e| Failure::Install(e.to_string()))
    }
}

/// The harness's one updater (a test starts it with `test.update.start`).
#[derive(Default)]
pub struct Slot {
    pub updater: Mutex<Option<(Arc<Updater>, Arc<FakeBackend>)>>,
}

fn num(a: &Value, k: &str, d: i64) -> i64 {
    a.get(k).and_then(|v| v.as_i64()).unwrap_or(d)
}

/// `test.update.*`. `emit` sends each status change to the test.
pub async fn command(
    slot: &Slot,
    cmd: &str,
    a: &Value,
    endpoints: &Endpoints,
    store: &Arc<Store>,
    clock: &Arc<dyn Clock>,
    emit: impl Fn(Value) + Send + Sync + 'static,
) -> Result<Value, String> {
    let s = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    if cmd == "test.update.pick" {
        let pages: Vec<Value> = a.get("pages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        return Ok(match update::pick(&pages, &s("current"), &s("web")) {
            Ok(p) => json!({ "pick": p.map(|p| json!({ "version": p.version, "tag": p.tag, "manifest": p.manifest_url })) }),
            Err(m) => json!({ "error": m }),
        });
    }
    if cmd == "test.update.start" {
        let d = Timings::default();
        let timings = Timings {
            every_ms: num(a, "everyMs", d.every_ms),
            query_timeout_ms: num(a, "queryTimeoutMs", d.query_timeout_ms),
            stall_ms: num(a, "stallMs", d.stall_ms),
            poll_ms: num(a, "pollMs", d.poll_ms),
        };
        let current = s("current");
        let backend = Arc::new(FakeBackend::new(endpoints.clone(), &current, &s("target"), PathBuf::from(s("dir"))));
        let problem = a.get("problem").and_then(|v| v.as_str()).map(str::to_string);
        let u = Updater::new(backend.clone(), clock.clone(), store.clone(), &current, &endpoints.web, timings, problem, Box::new(emit));
        if a.get("run").and_then(|v| v.as_bool()).unwrap_or(false) {
            tokio::spawn(u.clone().run());
        }
        let st = u.status();
        *slot.updater.lock().unwrap() = Some((u, backend));
        return Ok(st);
    }
    let Some((u, backend)) = slot.updater.lock().unwrap().clone() else {
        return Err("还没有 test.update.start".into());
    };
    match cmd {
        "test.update.status" => Ok(u.status()),
        "test.update.check" => {
            u.check_now().await;
            Ok(u.status())
        }
        "test.update.setAuto" => u.set_auto(a.get("on").and_then(|v| v.as_bool()).unwrap_or(true)).map(|_| u.status()),
        "test.update.dismiss" => u.dismiss(&s("version")).map(|_| u.status()),
        "test.update.failInstall" => {
            backend.fail_install.store(a.get("on").and_then(|v| v.as_bool()).unwrap_or(true), Ordering::SeqCst);
            Ok(Value::Null)
        }
        _ => Err(format!("unknown {cmd}")),
    }
}
