// The desktop app (Tauri, GitHub#151). Everything the app decides lives in
// the window's TypeScript (src/app) and in the back end (crates/core); this
// file only wires them together:
//   - one IPC command, `backend`, that hands a command to crates/core/src/api.rs
//   - the window: links never navigate it, GitHub links open in the browser
//   - the platform: keychain on macOS, where the profile lives, test mode
//   - the desktop side (desktop.rs, mac.rs): notifications, Dock badge, launch at
//     login, closing the window hides it, the sync beat (GitHub#169)
//   - page zoom (GitHub#155): the 显示 menu's ⌘+ / ⌘- / ⌘0 (macOS), level kept by crates/core/src/zoom.rs
//   - the window's size and place kept across restarts (GitHub#333, window.rs; rules: crates/core/src/window_state.rs)
//   - updating itself (GitHub#184, updater.rs): Tauri's updater plugin; when and which release: crates/core/src/update.rs
//
// The GitHub credential exists only in crates/core. Nothing here returns it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod updater;
mod window;
#[cfg(target_os = "macos")]
mod mac;

use async_trait::async_trait;
use cavil_core::api::dispatch;
use cavil_core::engine::is_allowed_external;
use cavil_core::i18n::tr;
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
        std::process::Command::new(program).arg(url).spawn().map(|_| ()).map_err(|e| tr("打不开浏览器：{e}", &[("e", &e.to_string())]))
    }
}

/// The window's only way into the back end.
#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
async fn backend(app: tauri::AppHandle, state: tauri::State<'_, AppState>, cmd: String, args: Option<Value>) -> Result<Value, String> {
    let out = dispatch(&state.engine, &cmd, args.unwrap_or(Value::Null)).await?;
    // GitHub#471: the menu is the back end's words too — built again in the language just set
    #[cfg(target_os = "macos")]
    if cmd == "setLanguage" {
        let _ = app_menu(&app).and_then(|m| app.set_menu(m)).map(|_| ());
    }
    Ok(out)
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

// The menu is the macOS app's; it is built on every system so that the other ones compile it too.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const ZOOM_ITEMS: [(&str, fn() -> String, &str); 3] = [
    ("zoom-in", || tr("放大", &[]), "CmdOrCtrl+="),
    ("zoom-out", || tr("缩小", &[]), "CmdOrCtrl+-"),
    ("zoom-reset", || tr("实际大小", &[]), "CmdOrCtrl+0"),
];

/// The id of the menu's own "close" item (GitHub#397).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CLOSE_TAB_ID: &str = "close-tab";

/// The standard macOS menu plus 缩放 (zoom in / out / actual size).
///
/// GitHub#397: the same items as Tauri's default menu (`Menu::default`), except that ⌘W is not the
/// system's "Close Window" any more: it is the app's own item, which closes the detail tab in front
/// and — with no tab in front — closes the window as before (`desktop::close_key`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let close = MenuItem::with_id(app, CLOSE_TAB_ID, tr("关闭标签页", &[]), true, Some("CmdOrCtrl+W"))?;
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&close])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?,
            &Submenu::with_id_and_items(
                app,
                tauri::menu::WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
            )?,
            &Submenu::with_id_and_items(app, tauri::menu::HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )?;
    let items = ZOOM_ITEMS
        .iter()
        .map(|(id, text, key)| MenuItem::with_id(app, *id, text(), true, Some(*key)))
        .collect::<tauri::Result<Vec<_>>>()?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    menu.append(&Submenu::with_items(app, tr("缩放", &[]), true, &refs)?)?;
    Ok(menu)
}

/// One of the menu's own items was chosen (by the mouse or by its key).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn menu_event(app: &tauri::AppHandle, id: &str) {
    let step = match id {
        "zoom-in" => cavil_core::zoom::Step::In,
        "zoom-out" => cavil_core::zoom::Step::Out,
        "zoom-reset" => cavil_core::zoom::Step::Reset,
        CLOSE_TAB_ID => return desktop::close_key(app),
        _ => return,
    };
    zoom(app, Some(step));
}

/// Step the zoom (or just apply the kept level: `None`) and set it on the window.
fn zoom(app: &tauri::AppHandle, step: Option<cavil_core::zoom::Step>) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let store = state.engine.store();
    let percent = match step {
        Some(st) => {
            let (percent, kept) = cavil_core::zoom::apply(store, st);
            if let Err(e) = kept {
                eprintln!("cavil: keeping the zoom level failed: {e}");
            }
            percent
        }
        None => cavil_core::zoom::saved(store),
    };
    if let Some(w) = app.get_webview_window("main") {
        if let Err(e) = w.set_zoom(f64::from(percent) / 100.0) {
            eprintln!("cavil: zoom failed: {e}");
        }
    }
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
    // test mode: files the daemon section asked the system to open (GitHub#314)
    let daemon_opened = if selection.test_mode { env.get("CAVIL_CLIENT_TEST_DAEMON_OPENED_FILE").map(PathBuf::from) } else { None };

    let mut builder = tauri::Builder::default().manage(Desktop::new(hooks)).plugin(tauri_plugin_updater::Builder::new().build())
        // the folder picker of "接上 daemon" (GitHub#315); used from the back end only (DialogPicker)
        .plugin(tauri_plugin_dialog::init());
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
        builder = builder.menu(app_menu).on_menu_event(|app, event| menu_event(app, event.id().as_ref()));
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
            let update_store = store.clone();
            // the size and place the window was left at (GitHub#333)
            let (place, place_kept) = window::placement(app.handle(), &store);
            app.manage(window::Keeper::new(store.clone()));
            let credentials: Arc<dyn cavil_core::platform::CredentialStore> = match &selection.store {
                StoreKind::Keychain => Arc::new(MacKeychainStore::default()),
                StoreKind::File(p) => Arc::new(FileStore(p.clone())),
                StoreKind::Memory => Arc::new(MemoryStore::default()),
            };
            let endpoints = selection.endpoints.clone();
            let remote = Arc::new(cavil_core::remote::Remote::from_env(selection.test_mode, os, &env, store.clone()));
            let engine = Engine::new(Deps {
                remote,
                store,
                credentials,
                clock: Arc::new(SystemClock),
                opener: Arc::new(SystemOpener { record: selection.opened_file.clone() }),
                endpoints: endpoints.clone(),
                daemon: Arc::new(cavil_core::daemon::Daemon::new(
                    cavil_core::daemon::Config::from_env(selection.test_mode, &env),
                    Arc::new(cavil_core::daemon::SystemFileOpener { record: daemon_opened.clone() }),
                )
                .with_picker(Arc::new(DialogPicker(app.handle().clone())))),
            });
            app.manage(AppState { engine: engine.clone() });

            let open_ep = endpoints.clone();
            let open_engine = engine.clone();
            let handle = app.handle().clone();
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Cavil Loop")
                .inner_size(place.w, place.h)
                .min_inner_size(cavil_core::window_state::MIN_W, cavil_core::window_state::MIN_H)
                .maximized(place.maximized)
                .visible(!smoke && !notify_check && !hidden)
                // The window does the syncing; hidden (closed, or started at login) it must keep
                // running. By default macOS's WebKit suspends a page that is not on screen — at once
                // when it was never shown, after about 5 minutes otherwise (GitHub#169, found on the
                // CI Macs). WebKit honours this from macOS 14 on, which is why the app requires
                // macOS 14 (maintainer's choice on PR #173): on 11–13 nothing keeps a hidden page running.
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                // The board drags cards with the page's own HTML5 drag and drop (BoardView.tsx).
                // Tauri's native drag-drop handler (on by default, it turns dropped files into
                // window events) answers "handled" for every drag; on macOS that keeps WebKit from
                // ever giving the page dragover / drop, so cards lifted but never landed
                // (GitHub#295; tauri-runtime-wry 2.12 / wry 0.57, wkwebview/drag_drop.rs). Nothing
                // in the app uses dropped files, so it is off on every platform (Windows needs the
                // same for HTML5 drag and drop; Linux never blocked it). A dropped file still
                // cannot navigate the window: on_navigation below refuses non-app URLs.
                .disable_drag_drop_handler()
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
                });
            // GitHub#467: on macOS the page's top row is the title bar — the page is drawn under it, the
            // title text is hidden and the three window buttons sit in that 52 px row, centred
            // (src/renderer/TopBar.tsx leaves them room and moves the window). Elsewhere: the system's title bar.
            #[cfg(target_os = "macos")]
            let win = win
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(18.0, 19.0));
            // where it was; a kept place that is no longer on any screen: centred; nothing kept: the system's choice, as before
            let win = match place.pos {
                Some((x, y)) => win.position(x, y),
                None if place_kept => win.center(),
                None => win,
            };
            win.build()?;
            // the zoom level kept from the last run
            zoom(&handle, None);
            let desk = app.state::<Desktop>();
            desk.record(json!({ "op": "start", "hidden": hidden }));
            window::record_start(&handle, &place, place_kept);
            #[cfg(target_os = "macos")]
            {
                let h = handle.clone();
                mac::setup(move |id| desktop::on_click(&h, &id));
            }
            desktop::spawn_background(handle.clone());
            // the app updating itself: at start, then every 6 hours (when this build does at all)
            let mode = updater::mode(&updater::Facts {
                macos: cfg!(target_os = "macos"),
                debug: cfg!(debug_assertions),
                test_feature: cfg!(feature = "update-test"),
                test_mode: selection.test_mode,
                test_wants_it: env.get("CAVIL_CLIENT_TEST_UPDATE").map(String::as_str) == Some("1"),
                check_run: smoke || notify_check,
            });
            let up = updater::build(&handle, update_store, endpoints.clone(), mode, &env);
            if let Some(u) = &up {
                tauri::async_runtime::spawn(u.clone().run());
            }
            app.manage(updater::UpdateSlot(up));
            if notify_check {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let alert = json!({ "kind": "summary", "title": tr("Cavil Loop 通知检查", &[]), "body": tr("打包检查发出的一条测试通知", &[]) });
                    let line = match desktop::desktop_notify(h.clone(), alert).await {
                        // accepted = the system took the request without an error; whether it was on screen is not known here
                        Ok(v) if v["ok"] == true => "CAVIL_NOTIFY_OK accepted by the system (on screen or not: not known)".to_string(),
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
            // the window's size and place, kept for the next start (GitHub#333)
            if w.label() == "main" {
                match ev {
                    WindowEvent::Resized(_) | WindowEvent::Moved(_) => window::changed(w.app_handle()),
                    // before it is hidden or destroyed
                    WindowEvent::CloseRequested { .. } => window::look(w.app_handle()),
                    _ => {}
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = ev {
                let d = w.state::<Desktop>();
                if w.label() == "main" && d.hide_on_close() {
                    api.prevent_close();
                    let _ = w.hide();
                    d.record(json!({ "op": "hidden" }));
                    // hidden is "not in front", whether or not the system also reports the focus loss
                    desktop::set_active(w.app_handle(), false);
                }
            }
            // the user switched to the window, or away from it (GitHub#185: the unread badge)
            if let WindowEvent::Focused(focused) = ev {
                if w.label() == "main" {
                    desktop::set_active(w.app_handle(), *focused);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            backend,
            mounted,
            desktop::desktop_notify,
            desktop::desktop_badge,
            desktop::desktop_clear_notifications,
            desktop::desktop_login_item,
            desktop::desktop_set_login_item,
            desktop::desktop_next_event,
            desktop::desktop_close_window,
            desktop::desktop_window_frame,
            desktop::desktop_start_drag,
            desktop::desktop_toggle_zoom,
            updater::desktop_update_status,
            updater::desktop_update_check,
            updater::desktop_update_set_auto,
            updater::desktop_update_set_channel,
            updater::desktop_update_dismiss,
            updater::desktop_update_dismiss_installed,
            updater::desktop_update_restart
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app");
    app.run(|_app, _ev: RunEvent| {
        // quitting: the last resize / move may still be waiting for the window to be still
        if matches!(_ev, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            window::look(_app);
        }
        // the Dock icon clicked while the window is hidden: it comes back
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = _ev {
            desktop::show_main(_app, "reopen");
        }
    });
}

/// The folder picker of "接上 daemon" (GitHub#315): Tauri's dialog plugin, called from here — the
/// window has no access to the plugin itself, it only asks the back end.
struct DialogPicker(tauri::AppHandle);

#[async_trait::async_trait]
impl cavil_core::daemon::FolderPicker for DialogPicker {
    async fn pick_folder(&self, start: Option<String>) -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut d = self.0.dialog().file().set_title(tr("选本地目录", &[]));
        if let Some(s) = start {
            d = d.set_directory(s);
        }
        d.pick_folder(move |p| {
            let _ = tx.send(p);
        });
        match rx.await {
            Ok(Some(p)) => p.into_path().map(|p| Some(p.to_string_lossy().to_string())).map_err(|e| tr("选中的位置读不出路径：{e}", &[("e", &e.to_string())])),
            Ok(None) => Ok(None),
            Err(_) => Err(tr("选择框没有给出结果", &[])),
        }
    }
}

async fn tokio_sleep(ms: u64) {
    use cavil_core::platform::Clock;
    SystemClock.sleep(ms as i64).await;
}
