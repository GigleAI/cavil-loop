// What the back end needs from the outside world. The Tauri app plugs in the
// real ones (keychain, wall clock, system browser); the test harness plugs in
// stand-ins that call back into the test process, so the TypeScript suites can
// hold a keychain write, fail it, or move the clock.

use crate::i18n::{tr, Said};
use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::Mutex;

#[async_trait]
pub trait CredentialStore: Send + Sync {
    /// true when the credential survives an app restart
    fn persistent(&self) -> bool;
    /// GitHub#471: errors are messages — the store's own words translated, the system's output in a hole
    async fn get(&self) -> Result<Option<String>, Said>;
    async fn set(&self, token: &str) -> Result<(), Said>;
    async fn clear(&self) -> Result<(), Said>;
}

#[async_trait]
pub trait Clock: Send + Sync {
    /// epoch ms
    async fn now(&self) -> i64;
    async fn sleep(&self, ms: i64);
}

#[async_trait]
pub trait Opener: Send + Sync {
    async fn open(&self, url: &str) -> Result<(), String>;
}

// Stored credentials are GitHub tokens ([A-Za-z0-9_]) or the `v2:` form that
// joins them with ':'; anything else is refused rather than quoted.
pub fn assert_token_shape(token: &str) -> Result<(), Said> {
    let ok = (20..=1024).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b':');
    if ok {
        Ok(())
    } else {
        Err(Said::plain(tr("凭据格式不符合预期，未保存", &[])))
    }
}

pub struct SystemClock;

#[async_trait]
impl Clock for SystemClock {
    async fn now(&self) -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }
    async fn sleep(&self, ms: i64) {
        tokio::time::sleep(std::time::Duration::from_millis(ms.max(0) as u64)).await;
    }
}

/// Platforms v1 does not support yet: keep the token for this run only.
#[derive(Default)]
pub struct MemoryStore(Mutex<Option<String>>);

#[async_trait]
impl CredentialStore for MemoryStore {
    fn persistent(&self) -> bool {
        false
    }
    async fn get(&self) -> Result<Option<String>, Said> {
        Ok(self.0.lock().unwrap().clone())
    }
    async fn set(&self, token: &str) -> Result<(), Said> {
        assert_token_shape(token)?;
        *self.0.lock().unwrap() = Some(token.to_string());
        Ok(())
    }
    async fn clear(&self) -> Result<(), Said> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

/// Test mode only: a plain file (the UI suite points it into a temp dir).
pub struct FileStore(pub PathBuf);

#[async_trait]
impl CredentialStore for FileStore {
    fn persistent(&self) -> bool {
        true
    }
    async fn get(&self) -> Result<Option<String>, Said> {
        Ok(std::fs::read_to_string(&self.0).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    }
    async fn set(&self, token: &str) -> Result<(), Said> {
        assert_token_shape(token)?;
        if let Some(d) = self.0.parent() {
            std::fs::create_dir_all(d).map_err(|e| Said::outside(&e.to_string(), "system"))?;
        }
        std::fs::write(&self.0, token).map_err(|e| Said::outside(&e.to_string(), "system"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
    async fn clear(&self) -> Result<(), Said> {
        match std::fs::remove_file(&self.0) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Said::outside(&e.to_string(), "system")),
        }
    }
}

pub const KEYCHAIN_SERVICE: &str = "dev.luosky.cavil-loop.client";
pub const KEYCHAIN_ACCOUNT: &str = "github-oauth";

/// macOS login keychain through /usr/bin/security, exactly as the Electron
/// build did (same service / account, so an existing sign-in carries over).
/// The token goes in on stdin (`security -i`), never in argv.
pub struct MacKeychainStore {
    pub bin: String,
}

impl Default for MacKeychainStore {
    fn default() -> Self {
        MacKeychainStore { bin: "/usr/bin/security".into() }
    }
}

#[async_trait]
impl CredentialStore for MacKeychainStore {
    fn persistent(&self) -> bool {
        true
    }
    async fn get(&self) -> Result<Option<String>, Said> {
        let out = tokio::process::Command::new(&self.bin)
            .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"])
            .output()
            .await
            .map_err(|e| Said::new("读取钥匙串失败：{e}", &[("e", &e.to_string())], "system"))?;
        match out.status.code() {
            Some(0) => {
                let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
                Ok(if t.is_empty() { None } else { Some(t) })
            }
            // 44 = errSecItemNotFound
            Some(44) => Ok(None),
            c => Err(Said::new("读取钥匙串失败：{e}", &[("e", &stderr_or(&out.stderr, c))], "system")),
        }
    }
    async fn set(&self, token: &str) -> Result<(), Said> {
        assert_token_shape(token)?;
        use tokio::io::AsyncWriteExt;
        let mut child = tokio::process::Command::new(&self.bin)
            .arg("-i")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| Said::new("写入钥匙串失败：{e}", &[("e", &e.to_string())], "system"))?;
        let line = format!(
            "add-generic-password -U -s \"{KEYCHAIN_SERVICE}\" -a \"{KEYCHAIN_ACCOUNT}\" -l \"Cavil Loop (GitHub)\" -w \"{token}\"\n"
        );
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(line.as_bytes()).await.map_err(|e| Said::new("写入钥匙串失败：{e}", &[("e", &e.to_string())], "system"))?;
        }
        let out = child.wait_with_output().await.map_err(|e| Said::new("写入钥匙串失败：{e}", &[("e", &e.to_string())], "system"))?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        if out.status.success() && !stderr.to_lowercase().contains("error") {
            Ok(())
        } else {
            Err(Said::new("写入钥匙串失败：{e}", &[("e", &stderr_or(&out.stderr, out.status.code()))], "system"))
        }
    }
    async fn clear(&self) -> Result<(), Said> {
        let out = tokio::process::Command::new(&self.bin)
            .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT])
            .output()
            .await
            .map_err(|e| Said::new("删除钥匙串条目失败：{e}", &[("e", &e.to_string())], "system"))?;
        match out.status.code() {
            Some(0) | Some(44) => Ok(()),
            c => Err(Said::new("删除钥匙串条目失败：{e}", &[("e", &stderr_or(&out.stderr, c))], "system")),
        }
    }
}

fn stderr_or(stderr: &[u8], code: Option<i32>) -> String {
    let s = String::from_utf8_lossy(stderr).trim().to_string();
    if s.is_empty() {
        format!("exit {}", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
    } else {
        s
    }
}

/// Which credential store the app uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreKind {
    Keychain,
    Memory,
    File(PathBuf),
}

/// What the app runs against, decided once at start.
#[derive(Debug, Clone)]
pub struct Selection {
    pub endpoints: crate::http::Endpoints,
    pub store: StoreKind,
    pub test_mode: bool,
    /// test mode: append opened URLs to this file instead of opening a browser
    pub opened_file: Option<PathBuf>,
}

/// Test mode (CAVIL_CLIENT_TEST_MODE=1) exists for the automated suites only:
/// it may point the GitHub endpoints at a loopback fake server (loopback only —
/// a test switch can never send the credential to another host), store the
/// credential in a file, and record browser opens instead of performing them.
pub fn select(os: &str, env: &std::collections::HashMap<String, String>) -> Result<Selection, String> {
    let test_mode = env.get("CAVIL_CLIENT_TEST_MODE").map(String::as_str) == Some("1");
    let mut endpoints = crate::http::Endpoints::github();
    if test_mode {
        if let (Some(api), Some(web)) = (env.get("CAVIL_CLIENT_TEST_API"), env.get("CAVIL_CLIENT_TEST_WEB")) {
            if !crate::http::is_loopback(api) || !crate::http::is_loopback(web) {
                return Err("测试模式只允许把 GitHub 地址指向本机回环地址".into());
            }
            endpoints = crate::http::Endpoints { api: api.trim_end_matches('/').into(), web: web.trim_end_matches('/').into() };
        }
    }
    let store = match env.get("CAVIL_CLIENT_TEST_CREDENTIAL_FILE") {
        Some(f) if test_mode => StoreKind::File(PathBuf::from(f)),
        _ if os == "macos" => StoreKind::Keychain,
        _ => StoreKind::Memory,
    };
    let opened_file = if test_mode { env.get("CAVIL_CLIENT_TEST_OPENED_FILE").map(PathBuf::from) } else { None };
    Ok(Selection { endpoints, store, test_mode, opened_file })
}
