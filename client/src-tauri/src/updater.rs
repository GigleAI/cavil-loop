// The app updating itself (GitHub#184): Tauri's updater plugin does the parts
// that touch the installed app — read the release's update manifest, download
// the package, check its signature against the public key built into the app,
// swap the app bundle. When to look, which release, timeouts and what the
// window shows are decided in cavil_core::update (one implementation, the one
// the test suites drive).
//
// Which builds look for updates at all (`mode`): the released macOS app. Not a
// development build, not the packaged-app checks (--smoke-test / --notify-check),
// not test mode unless a test asks for it, not Linux (nothing is released there).
//
// Test builds only (cargo feature `update-test`, scripts/mac-update-check.sh): the
// public key may come from CAVIL_CLIENT_TEST_UPDATE_PUBKEY, the channel from
// CAVIL_CLIENT_TEST_UPDATE_CHANNEL, and a debug build may update. The released app
// has none of these.

use async_trait::async_trait;
use cavil_core::http::Endpoints;
use cavil_core::platform::SystemClock;
use cavil_core::store::Store;
use cavil_core::update::{self, Backend, Channel, Failure, Found, Timings, Updater};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The public half of the key the release job signs update packages with: `plugins.updater.pubkey`
/// in tauri.conf.json, the one place the app, the bundler and the release check
/// (scripts/update-manifest.mjs) all read it from. Empty until the maintainer has made one: then
/// this app cannot update itself, and says so.
fn configured_pubkey<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).unwrap_or("").trim().to_string()
}

/// Whether this app looks for updates.
#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    /// never; the window shows nothing about updates
    Off,
    /// looks (or, with a problem, says why it cannot)
    On { problem: Option<String> },
}

/// What the window says when the app has no public key to check update packages with.
pub const NO_KEY: &str = "这一版没有带更新用的公钥，不能自动更新，请手动下载新版";

pub struct Facts {
    pub macos: bool,
    pub debug: bool,
    pub test_feature: bool,
    pub test_mode: bool,
    /// test mode: the test asked for the updater (CAVIL_CLIENT_TEST_UPDATE=1)
    pub test_wants_it: bool,
    /// --smoke-test / --notify-check
    pub check_run: bool,
}

pub fn mode(f: &Facts) -> Mode {
    if f.check_run || (!f.macos && !f.test_feature) || (f.debug && !f.test_feature) || (f.test_mode && !f.test_wants_it) {
        return Mode::Off;
    }
    Mode::On { problem: None }
}

/// The updater, when this app has one.
pub struct UpdateSlot(pub Option<Arc<Updater>>);

struct PluginBackend<R: Runtime> {
    app: AppHandle<R>,
    endpoints: Endpoints,
    pubkey: String,
    seq: AtomicU64,
    updates: Mutex<HashMap<u64, Update>>,
}

fn failure(e: tauri_plugin_updater::Error) -> Failure {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => Failure::Signature(e.to_string()),
        E::Reqwest(_) | E::Network(_) => Failure::Network(e.to_string()),
        E::Io(_) | E::TempDirNotOnSameMountPoint | E::PreviousAppNotRestored(_) | E::AuthenticationFailed => Failure::Install(e.to_string()),
        other => Failure::Invalid(other.to_string()),
    }
}

#[async_trait]
impl<R: Runtime> Backend for PluginBackend<R> {
    async fn releases(&self) -> Result<Vec<Value>, String> {
        update::fetch_releases(&self.endpoints).await
    }

    async fn check(&self, url: &str) -> Result<Option<Found>, Failure> {
        let url = url::Url::parse(url).map_err(|e| Failure::Invalid(e.to_string()))?;
        let updater = self
            .app
            .updater_builder()
            .pubkey(self.pubkey.clone())
            .endpoints(vec![url])
            .and_then(|b| b.build())
            .map_err(failure)?;
        let Some(found) = updater.check().await.map_err(failure)? else { return Ok(None) };
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let version = found.version.clone();
        self.updates.lock().unwrap().insert(id, found);
        Ok(Some(Found { version, id }))
    }

    async fn download(&self, found: &Found, got: Box<dyn Fn(u64, Option<u64>) + Send + Sync>) -> Result<Vec<u8>, Failure> {
        let u = self.updates.lock().unwrap().get(&found.id).cloned().ok_or(Failure::Invalid("没有这个更新".into()))?;
        let mut sum = 0u64;
        // verifies the signature before it returns the bytes
        u.download(
            move |n, total| {
                sum += n as u64;
                got(sum, total);
            },
            || {},
        )
        .await
        .map_err(failure)
    }

    async fn install(&self, found: &Found, bytes: Vec<u8>) -> Result<(), Failure> {
        let u = self.updates.lock().unwrap().remove(&found.id).ok_or(Failure::Invalid("没有这个更新".into()))?;
        // verifies the signature again, then swaps the app bundle (may ask for an administrator's password)
        tokio::task::spawn_blocking(move || u.install(bytes)).await.map_err(|e| Failure::Install(e.to_string()))?.map_err(failure)?;
        clear_quarantine(&self.app);
        Ok(())
    }
}

/// A just-installed app carrying the "downloaded from the internet" mark would be stopped by macOS
/// on its next start. The plugin's own download does not set it; should anything have, take it off
/// the new app (only that bundle, which has just passed the signature check).
fn clear_quarantine<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        let bundle = std::env::current_exe().ok().and_then(|exe| tauri_plugin_updater::extract_path_from_executable(&exe).ok());
        let Some(bundle) = bundle else { return };
        let had = std::process::Command::new("/usr/bin/xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(&bundle)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if had {
            let r = std::process::Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(&bundle).status();
            eprintln!("cavil: the new app carried the quarantine mark; removing it: {r:?}");
        }
        app.state::<crate::desktop::Desktop>().record(json!({ "op": "quarantine", "had": had }));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The updater for this app, or None when it does not look for updates. Status changes go to the
/// window as `{ kind: "update", status }` events.
pub fn build<R: Runtime>(app: &AppHandle<R>, store: Arc<Store>, endpoints: Endpoints, m: Mode, env: &HashMap<String, String>) -> Option<Arc<Updater>> {
    let Mode::On { problem } = m else { return None };
    let mut pubkey = configured_pubkey(app);
    if cfg!(feature = "update-test") {
        if let Some(k) = env.get("CAVIL_CLIENT_TEST_UPDATE_PUBKEY").filter(|k| !k.is_empty()) {
            pubkey = k.clone();
        }
    }
    let problem = if pubkey.is_empty() { problem.or(Some(NO_KEY.into())) } else { problem };
    let backend = Arc::new(PluginBackend { app: app.clone(), endpoints: endpoints.clone(), pubkey, seq: AtomicU64::new(1), updates: Mutex::new(HashMap::new()) });
    let h = app.clone();
    let changed = Box::new(move |status: Value| {
        let d = h.state::<crate::desktop::Desktop>();
        d.record(json!({ "op": "update", "status": status }));
        d.push(json!({ "kind": "update", "status": status }));
    });
    let current = app.package_info().version.to_string();
    let u = Updater::new(backend, Arc::new(SystemClock), store, &current, &endpoints.web, Timings::default(), problem, dev_supported(), changed);
    if cfg!(feature = "update-test") {
        if let Some(c) = env.get("CAVIL_CLIENT_TEST_UPDATE_CHANNEL").and_then(|c| Channel::parse(c)) {
            if let Err(e) = u.set_channel(c) {
                eprintln!("cavil: CAVIL_CLIENT_TEST_UPDATE_CHANNEL={}: {e}", c.name());
            }
        }
    }
    Some(u)
}

/// Development builds exist for this machine: the updater platform key the plugin looks this
/// machine up by (`darwin-aarch64`, …) is one of `update::DEV_TARGETS`.
fn dev_supported() -> bool {
    let os = if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS };
    update::DEV_TARGETS.contains(&format!("{os}-{}", std::env::consts::ARCH).as_str())
}

fn slot<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<Updater>> {
    app.try_state::<UpdateSlot>().and_then(|s| s.0.clone())
}

// ---- commands the window calls (src/backend/tauri.ts, tauriDesktop) -------------------

/// null = this app does not update itself (the window shows nothing about it)
#[tauri::command]
pub fn desktop_update_status<R: Runtime>(app: AppHandle<R>) -> Value {
    slot(&app).map(|u| u.status()).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn desktop_update_check<R: Runtime>(app: AppHandle<R>) {
    if let Some(u) = slot(&app) {
        tauri::async_runtime::spawn(async move { u.check_now().await });
    }
}

#[tauri::command]
pub fn desktop_update_set_auto<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<(), String> {
    slot(&app).ok_or("这个版本不自动更新")?.set_auto(on)
}

/// Choose the update channel ("stable" / "dev", GitHub#215), then look on it at once. A round
/// running now drops what it found and starts over on the new channel.
#[tauri::command]
pub fn desktop_update_set_channel<R: Runtime>(app: AppHandle<R>, channel: String) -> Result<(), String> {
    let u = slot(&app).ok_or("这个版本不自动更新")?;
    u.set_channel(Channel::parse(&channel).ok_or("不认识的更新渠道")?)?;
    tauri::async_runtime::spawn(async move { u.check_now().await });
    Ok(())
}

#[tauri::command]
pub fn desktop_update_dismiss<R: Runtime>(app: AppHandle<R>, version: String) -> Result<(), String> {
    slot(&app).ok_or("这个版本不自动更新")?.dismiss(&version)
}

/// Quit and start the new version (only once it is in place).
#[tauri::command]
pub fn desktop_update_restart<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let u = slot(&app).ok_or("这个版本不自动更新")?;
    if u.status()["phase"] != "ready" {
        return Err("新版还没装好".into());
    }
    restart_now(&app)
}

/// Quit and start again. The window's size and place are kept first (GitHub#333): called on the
/// main thread, Tauri's restart skips the exit events the app otherwise keeps them on.
pub fn restart_now<R: Runtime>(app: &AppHandle<R>) -> ! {
    app.state::<crate::desktop::Desktop>().record(json!({ "op": "restart" }));
    crate::window::look(app);
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn released() -> Facts {
        Facts { macos: true, debug: false, test_feature: false, test_mode: false, test_wants_it: false, check_run: false }
    }

    #[test]
    fn only_the_released_mac_app_looks() {
        assert_eq!(mode(&released()), Mode::On { problem: None });
        assert_eq!(mode(&Facts { macos: false, ..released() }), Mode::Off);
        assert_eq!(mode(&Facts { debug: true, ..released() }), Mode::Off);
        assert_eq!(mode(&Facts { check_run: true, ..released() }), Mode::Off);
        assert_eq!(mode(&Facts { test_mode: true, ..released() }), Mode::Off);
        assert_eq!(mode(&Facts { test_mode: true, test_wants_it: true, ..released() }), Mode::On { problem: None });
        // the test build (scripts/mac-update-check.sh) is a debug build that does look
        assert_eq!(mode(&Facts { debug: true, test_feature: true, test_mode: true, test_wants_it: true, ..released() }), Mode::On { problem: None });
    }
}
