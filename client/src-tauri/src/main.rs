// The desktop app (Tauri, GitHub#151). Everything the app decides lives in
// the window's TypeScript (src/app) and in the back end (crates/core); this
// file only wires them together:
//   - one IPC command, `backend`, that hands a command to crates/core/src/api.rs
//   - the window: links never navigate it, GitHub links open in the browser
//   - the platform: keychain on macOS, where the profile lives, test mode
//   - the desktop side (desktop.rs, mac.rs): notifications, Dock badge, launch at
//     login, closing the window hides it, the sync beat (GitHub#169)
//
// The GitHub credential exists only in crates/core. Nothing here returns it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
#[cfg(target_os = "macos")]
mod mac;

use async_trait::async_trait;
use cavil_core::api::dispatch;
use cavil_core::engine::is_allowed_external;
use cavil_core::platform::{select, FileStore, MacKeychainStore, MemoryStore, Opener, StoreKind, SystemClock};
use cavil_core::store::Store;
use cavil_core::{Deps, Engine};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use desktop::{Desktop, TestHooks};
use serde_json::json;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

struct AppState {
    engine: Arc<Engine>,
}

/// Opens GitHub links in the system browser; in test mode appends them to a file instead.
struct SystemOpener {
    record: Option<PathBuf>,
}

#[async_trait]
impl Opener for SystemOpener {
    async fn open(&self, url: &str) -> Result<(), String> {
        if let Some(f) = &self.record {
            let mut file = std::fs::OpenOptions::new().create(true).append(true).open(f).map_err(|e| e.to_string())?;
            return writeln!(file, "{url}").map_err(|e| e.to_string());
        }
        let program = if cfg!(target_os = "macos") { "/usr/bin/open" } else { "xdg-open" };
        std::process::Command::new(program).arg(url).spawn().map(|_| ()).map_err(|e| format!("打不开浏览器：{e}"))
    }
}

/// The window's only way into the back end.
#[tauri::command]
async fn backend(state: tauri::State<'_, AppState>, cmd: String, args: Option<Value>) -> Result<Value, String> {
    dispatch(&state.engine, &cmd, args.unwrap_or(Value::Null)).await
}

/// The window is up. Under `--smoke-test` (the packaged-app check): it mounted and
/// reached the back end through IPC — report and quit; returns true so the window
/// does not start syncing meanwhile.
#[tauri::command]
fn mounted(app: tauri::AppHandle, detail: String) -> bool {
    if !smoke() {
        return false;
    }
    let ok = detail.starts_with("mounted");
    let target = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    smoke_result(&app, ok, &format!("{target} tauri {} {detail}", tauri::VERSION));
    true
}

fn smoke_result(app: &tauri::AppHandle, ok: bool, detail: &str) {
    let line = if ok { format!("CAVIL_SMOKE_OK {detail}") } else { format!("CAVIL_SMOKE_FAIL {detail}") };
    println!("{line}");
    if let Some(out) = smoke_out() {
        let _ = std::fs::write(out, format!("{line}\n"));
    }
    app.exit(if ok { 0 } else { 1 });
}

fn smoke() -> bool {
    std::env::args().any(|a| a == "--smoke-test")
}

/// Started at login (launch at login passes it): no window until the user asks for one.
fn hidden_start() -> bool {
    std::env::args().any(|a| a == "--hidden")
}

/// The packaged-app check (scripts/mac-open-check.sh): send one real notification through the
/// same code as a reminder, report what the system answered, quit. Never fails the check by itself.
fn notify_check() -> bool {
    std::env::args().any(|a| a == "--notify-check")
}

fn smoke_out() -> Option<String> {
    std::env::args().find_map(|a| a.strip_prefix("--smoke-out=").map(str::to_string))
}

/// Pages the window itself may show: the app's own files only.
fn is_app_url(url: &url::Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "data")
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions) && url.scheme() == "http" && url.host_str() == Some("localhost"))
}

fn main() {
    let env: HashMap<String, String> = std::env::vars().collect();
    let os = if cfg!(target_os = "macos") { "macos" } else { std::env::consts::OS };
    let selection = match select(os, &env) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let smoke = smoke();
    let notify_check = notify_check();
    let hidden = hidden_start();
    let hooks = TestHooks::from_env(selection.test_mode, &env);

    let mut builder = tauri::Builder::default().manage(Desktop::new(hooks));
    // one app instance per profile: a second launch brings the first window forward
    // (not in the smoke test or test mode: each run has its own throw-away profile, and
    // the plugin needs a desktop session bus a CI machine may not have)
    if !smoke && !selection.test_mode {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(
            tauri_plugin_autostart::Builder::new()
                .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
                .arg("--hidden")
                .build(),
        );
    }
    let app = builder
        .setup(move |app| {
            // Same profile folder as the Electron build ("Cavil Loop"), so an upgrade keeps
            // the sign-in and the cache. The smoke test gets a throw-away one; the test
            // suite may point it elsewhere (test mode only).
            let profile = if smoke || notify_check {
                std::env::temp_dir().join(format!("cavil-smoke-{}", std::process::id()))
            } else if let (true, Some(d)) = (selection.test_mode, env.get("CAVIL_CLIENT_USER_DATA")) {
                PathBuf::from(d)
            } else {
                app.path().data_dir()?.join("Cavil Loop")
            };
            let store = Arc::new(Store::open(&profile.join("cache.sqlite")).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?);
            let credentials: Arc<dyn cavil_core::platform::CredentialStore> = match &selection.store {
                StoreKind::Keychain => Arc::new(MacKeychainStore::default()),
                StoreKind::File(p) => Arc::new(FileStore(p.clone())),
                StoreKind::Memory => Arc::new(MemoryStore::default()),
            };
            let endpoints = selection.endpoints.clone();
            let engine = Engine::new(Deps {
                store,
                credentials,
                clock: Arc::new(SystemClock),
                opener: Arc::new(SystemOpener { record: selection.opened_file.clone() }),
                endpoints: endpoints.clone(),
            });
            app.manage(AppState { engine: engine.clone() });

            let open_ep = endpoints.clone();
            let open_engine = engine.clone();
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Cavil Loop")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .visible(!smoke && !notify_check && !hidden)
                // Links never navigate the app window; GitHub links go to the system browser.
                .on_navigation(move |url| {
                    if is_app_url(url) {
                        return true;
                    }
                    if is_allowed_external(url.as_str(), &open_ep) {
                        let e = open_engine.clone();
                        let u = url.to_string();
                        tauri::async_runtime::spawn(async move {
                            if let Err(err) = e.open_external(&u).await {
                                eprintln!("cavil: opening {u} in the browser failed: {err}");
                            }
                        });
                    }
                    false
                })
                // `<a target="_blank">` (the detail view's GitHub HTML): same rule, never a new window
                .on_new_window(move |url, _features| {
                    let e = engine.clone();
                    let u = url.to_string();
                    tauri::async_runtime::spawn(async move {
                        if let Err(err) = e.open_external(&u).await {
                            eprintln!("cavil: opening {u} in the browser failed: {err}");
                        }
                    });
                    NewWindowResponse::Deny
                })
                .build()?;
            let desk = app.state::<Desktop>();
            desk.record(json!({ "op": "start", "hidden": hidden }));
            #[cfg(target_os = "macos")]
            {
                let h = handle.clone();
                mac::setup(move |id| desktop::on_click(&h, &id));
            }
            desktop::spawn_background(handle.clone());
            if notify_check {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let alert = json!({ "kind": "summary", "title": "Cavil Loop 通知检查", "body": "打包检查发出的一条测试通知" });
                    let line = match desktop::desktop_notify(h.clone(), alert).await {
                        Ok(v) if v["ok"] == true => "CAVIL_NOTIFY_OK shown".to_string(),
                        Ok(v) => format!("CAVIL_NOTIFY_REFUSED {}", v["error"].as_str().unwrap_or("")),
                        Err(e) => format!("CAVIL_NOTIFY_REFUSED {e}"),
                    };
                    println!("{line}");
                    if let Some(out) = smoke_out() {
                        let _ = std::fs::write(out, format!("{line}\n"));
                    }
                    h.exit(0);
                });
            }
            if smoke {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio_sleep(30_000).await;
                    smoke_result(&h, false, "timeout");
                });
            }
            Ok(())
        })
        // closing the window hides it where the app keeps running (macOS; tests may ask for it elsewhere)
        .on_window_event(|w, ev| {
            if let WindowEvent::CloseRequested { api, .. } = ev {
                let d = w.state::<Desktop>();
                if w.label() == "main" && d.hide_on_close() {
                    api.prevent_close();
                    let _ = w.hide();
                    d.record(json!({ "op": "hidden" }));
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            backend,
            mounted,
            desktop::desktop_notify,
            desktop::desktop_badge,
            desktop::desktop_login_item,
            desktop::desktop_set_login_item,
            desktop::desktop_next_event
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app");
    app.run(|_app, _ev: RunEvent| {
        // the Dock icon clicked while the window is hidden: it comes back
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = _ev {
            desktop::show_main(_app, "reopen");
        }
    });
}

async fn tokio_sleep(ms: u64) {
    use cavil_core::platform::Clock;
    SystemClock.sleep(ms as i64).await;
}
