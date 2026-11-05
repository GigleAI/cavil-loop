// Test-only: the real back end (cavil-core) behind stdin/stdout, so the
// TypeScript suites drive the Rust code that ships — a real child process, a
// real SQLite file, real HTTP to the fake GitHub on loopback.
//
// One JSON object per line.
//   test → harness   {"id": n, "cmd": "...", "args": {...}}
//   harness → test   {"id": n, "ok": value} | {"id": n, "err": "message"}
//   harness → test   {"cb": m, "op": "cred.get" | "cred.set" | "cred.clear" | "now" | "sleep" | "open", "args": {...}}
//   test → harness   {"cb": m, "ok": value} | {"cb": m, "err": "message"}
// The credential store, the clock and the browser are the test's: it can hold
// a keychain write, fail it, move time, or record which page was opened.
//
//   cavil-harness --db <file> --api <loopback url> --web <loopback url> [--memory-credentials] [--keychain-bin <stand-in for /usr/bin/security>]
//
// With --keychain-bin the back end uses its real macOS keychain store (against the
// stand-in executable); `test.cred.get|set|clear` then call that store directly.
// `test.refreshGrant` runs the real refresh classifier against the configured web base.

use async_trait::async_trait;
use cavil_core::api::dispatch;
use cavil_core::http::{is_loopback, Endpoints};
use cavil_core::platform::{Clock, CredentialStore, MacKeychainStore, Opener};
use cavil_core::store::Store;
use cavil_core::{Deps, Engine};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

struct Link {
    out: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    seq: AtomicU64,
}

impl Link {
    async fn call(&self, op: &str, args: Value) -> Result<Value, String> {
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let _ = self.out.send(json!({ "cb": id, "op": op, "args": args }).to_string());
        rx.await.unwrap_or_else(|_| Err("测试进程没有回应".into()))
    }
}

struct RemoteStore(Arc<Link>, bool);

#[async_trait]
impl CredentialStore for RemoteStore {
    fn persistent(&self) -> bool {
        self.1
    }
    async fn get(&self) -> Result<Option<String>, String> {
        let v = self.0.call("cred.get", Value::Null).await?;
        Ok(v.as_str().map(str::to_string))
    }
    async fn set(&self, token: &str) -> Result<(), String> {
        self.0.call("cred.set", json!({ "value": token })).await.map(|_| ())
    }
    async fn clear(&self) -> Result<(), String> {
        self.0.call("cred.clear", Value::Null).await.map(|_| ())
    }
}

struct RemoteClock(Arc<Link>);

#[async_trait]
impl Clock for RemoteClock {
    async fn now(&self) -> i64 {
        self.0.call("now", Value::Null).await.ok().and_then(|v| v.as_f64()).map(|f| f as i64).unwrap_or(0)
    }
    async fn sleep(&self, ms: i64) {
        let _ = self.0.call("sleep", json!({ "ms": ms })).await;
    }
}

struct RemoteOpener(Arc<Link>);

#[async_trait]
impl Opener for RemoteOpener {
    async fn open(&self, url: &str) -> Result<(), String> {
        self.0.call("open", json!({ "url": url })).await.map(|_| ())
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (db, api, web) = match (arg(&args, "--db"), arg(&args, "--api"), arg(&args, "--web")) {
        (Some(d), Some(a), Some(w)) => (d, a, w),
        _ => {
            eprintln!("usage: cavil-harness --db <file> --api <url> --web <url>");
            std::process::exit(2);
        }
    };
    // a test switch can never send the credential to another host
    if !is_loopback(&api) || !is_loopback(&web) {
        eprintln!("测试只允许把 GitHub 地址指向本机回环地址");
        std::process::exit(2);
    }
    let persistent = !args.iter().any(|a| a == "--memory-credentials");
    let store = match Store::open(std::path::Path::new(&db)) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let link = Arc::new(Link { out: out_tx.clone(), pending: Mutex::new(HashMap::new()), seq: AtomicU64::new(1) });
    let keychain: Option<Arc<MacKeychainStore>> = arg(&args, "--keychain-bin").map(|bin| Arc::new(MacKeychainStore { bin }));
    let credentials: Arc<dyn CredentialStore> = match &keychain {
        Some(k) => k.clone(),
        None => Arc::new(RemoteStore(link.clone(), persistent)),
    };
    let clock: Arc<dyn Clock> = Arc::new(RemoteClock(link.clone()));
    let engine = Engine::new(Deps {
        store,
        credentials,
        clock: clock.clone(),
        opener: Arc::new(RemoteOpener(link.clone())),
        endpoints: Endpoints { api: api.trim_end_matches('/').into(), web: web.trim_end_matches('/').into() },
    });

    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = out_rx.recv().await {
            if stdout.write_all(format!("{line}\n").as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(cb) = msg.get("cb").and_then(|v| v.as_u64()) {
            let tx = link.pending.lock().unwrap().remove(&cb);
            if let Some(tx) = tx {
                let r = match msg.get("err") {
                    Some(e) => Err(e.as_str().unwrap_or("error").to_string()),
                    None => Ok(msg.get("ok").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(r);
            }
            continue;
        }
        let Some(id) = msg.get("id").and_then(|v| v.as_u64()) else { continue };
        let cmd = msg.get("cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let a = msg.get("args").cloned().unwrap_or(Value::Null);
        let e = engine.clone();
        let out = out_tx.clone();
        let kc = keychain.clone();
        let clk = clock.clone();
        tokio::spawn(async move {
            let res = match (cmd.as_str(), &kc) {
                // the app's start-up choice of endpoints and credential store (the real function)
                ("test.selectPlatform", _) => {
                    let os = a.get("os").and_then(|v| v.as_str()).unwrap_or("");
                    let env: HashMap<String, String> = a
                        .get("env")
                        .and_then(|v| v.as_object())
                        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
                        .unwrap_or_default();
                    Ok(match cavil_core::platform::select(os, &env) {
                        Ok(s) => json!({
                            "api": s.endpoints.api,
                            "web": s.endpoints.web,
                            "store": match s.store {
                                cavil_core::platform::StoreKind::Keychain => "keychain".to_string(),
                                cavil_core::platform::StoreKind::Memory => "memory".to_string(),
                                cavil_core::platform::StoreKind::File(p) => format!("file:{}", p.display()),
                            },
                            "testMode": s.test_mode,
                        }),
                        Err(m) => json!({ "error": m }),
                    })
                }
                // which links may be opened in the system browser (the real function)
                ("test.allowedExternal", _) => {
                    let ep = Endpoints {
                        api: a.get("api").and_then(|v| v.as_str()).unwrap_or("").into(),
                        web: a.get("web").and_then(|v| v.as_str()).unwrap_or("").into(),
                    };
                    Ok(json!(cavil_core::engine::is_allowed_external(a.get("url").and_then(|v| v.as_str()).unwrap_or(""), &ep)))
                }
                // how one refresh answer is classified (the real function, against whatever the test serves)
                ("test.refreshGrant", _) => {
                    let id = a.get("clientId").and_then(|v| v.as_str()).unwrap_or("");
                    let rt = a.get("refreshToken").and_then(|v| v.as_str()).unwrap_or("");
                    Ok(match cavil_core::device::refresh_grant(e.endpoints(), id, rt, clk.as_ref()).await {
                        Ok(g) => json!({ "ok": g.access_token }),
                        Err(f) => json!({ "reason": f.reason.as_str(), "message": f.message }),
                    })
                }
                ("test.cred.get", Some(k)) => k.get().await.map(|v| json!(v)),
                ("test.cred.set", Some(k)) => k.set(a.get("value").and_then(|v| v.as_str()).unwrap_or("")).await.map(|_| Value::Null),
                ("test.cred.clear", Some(k)) => k.clear().await.map(|_| Value::Null),
                _ => dispatch(&e, &cmd, a).await,
            };
            let reply = match res {
                Ok(v) => json!({ "id": id, "ok": v }),
                Err(m) => json!({ "id": id, "err": m }),
            };
            let _ = out.send(reply.to_string());
        });
    }
    // stdin closed: the test is done with this process
    drop(out_tx);
    drop(link);
    let _ = tokio::time::timeout(std::time::Duration::from_millis(200), writer).await;
    std::process::exit(0);
}
