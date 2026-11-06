// The desktop side of the app (GitHub#139, rebuilt on Tauri in #169): system
// notifications, the Dock badge, launch at login, keeping the app running with
// its window closed, and the sync beat. The window decides *what* to show
// (src/app/controller.ts + src/data/pending.ts); this file only does it.
// Nothing here touches the GitHub credential.
//
// The sync beat lives here, not in the window: a hidden window's timers are
// slowed down by the web engine, so the shell keeps time and tells the window
// "sync now" through the same event queue a clicked notification uses.
//
// Test mode only (cavil_core::platform::select decides that; it requires a
// loopback GitHub), for test/tauri and scripts/mac-open-check.sh:
//   CAVIL_CLIENT_TEST_ALERTS_FILE    every notification / badge / beat / hide / show, one JSON line each,
//                                    instead of a real notification (the badge is still set)
//   CAVIL_CLIENT_TEST_NOTIFY_REFUSE  answer every notification with this refusal
//   CAVIL_CLIENT_TEST_TICK_MS        the sync beat (default: the app's 60 s)
//   CAVIL_CLIENT_TEST_HIDE_ON_CLOSE  "1": closing the window hides it on this OS too (normally macOS only)
//   CAVIL_CLIENT_TEST_CONTROL_FILE   lines the test appends: "close" (closes the window the way the
//                                    close button does) or "click <notification id>" (what a click on
//                                    that notification does)

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// The app's sync interval (src/shared/config.ts SYNC_INTERVAL_MS).
pub const SYNC_INTERVAL_MS: u64 = 60_000;

#[derive(Default)]
pub struct TestHooks {
    pub record: Option<PathBuf>,
    pub refuse: Option<String>,
    pub tick_ms: Option<u64>,
    pub hide_on_close: bool,
    pub control: Option<PathBuf>,
}

impl TestHooks {
    pub fn from_env(test_mode: bool, env: &std::collections::HashMap<String, String>) -> TestHooks {
        if !test_mode {
            return TestHooks::default();
        }
        let get = |k: &str| env.get(k).filter(|v| !v.is_empty()).cloned();
        TestHooks {
            record: get("CAVIL_CLIENT_TEST_ALERTS_FILE").map(PathBuf::from),
            refuse: get("CAVIL_CLIENT_TEST_NOTIFY_REFUSE"),
            tick_ms: get("CAVIL_CLIENT_TEST_TICK_MS").and_then(|v| v.parse().ok()).filter(|v| *v > 0),
            hide_on_close: get("CAVIL_CLIENT_TEST_HIDE_ON_CLOSE").as_deref() == Some("1"),
            control: get("CAVIL_CLIENT_TEST_CONTROL_FILE").map(PathBuf::from),
        }
    }
}

pub struct Desktop {
    queue: Mutex<VecDeque<Value>>,
    wake: tokio::sync::Notify,
    seq: AtomicU64,
    pub hooks: TestHooks,
}

impl Desktop {
    pub fn new(hooks: TestHooks) -> Desktop {
        Desktop { queue: Mutex::new(VecDeque::new()), wake: tokio::sync::Notify::new(), seq: AtomicU64::new(0), hooks }
    }

    /// Closing the window hides it (the app keeps syncing and reminding): macOS, or a test that asks for it.
    pub fn hide_on_close(&self) -> bool {
        cfg!(target_os = "macos") || self.hooks.hide_on_close
    }

    pub fn tick_ms(&self) -> u64 {
        self.hooks.tick_ms.unwrap_or(SYNC_INTERVAL_MS)
    }

    /// One event for the window. A beat that is already waiting is not queued twice
    /// (after the machine slept, one round is enough).
    pub fn push(&self, ev: Value) {
        let mut q = self.queue.lock().unwrap();
        if ev["kind"] == "tick" && q.iter().any(|e| e["kind"] == "tick") {
            return;
        }
        q.push_back(ev);
        drop(q);
        self.wake.notify_one();
    }

    /// The next event; waits until there is one.
    pub async fn next(&self) -> Value {
        loop {
            if let Some(e) = self.queue.lock().unwrap().pop_front() {
                return e;
            }
            self.wake.notified().await;
        }
    }

    /// Test mode: one line in the record file.
    pub fn record(&self, v: Value) {
        if let Some(f) = &self.hooks.record {
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
                let _ = writeln!(file, "{v}");
            }
        }
    }

    /// The system's id for one notification: what a click on it brings back.
    pub fn notification_id(&self, alert: &Value) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        match alert["kind"].as_str() {
            Some("item") => json!({ "key": alert["key"], "url": alert["url"], "n": n }).to_string(),
            _ => json!({ "summary": n }).to_string(),
        }
    }
}

/// What a click on a notification does, whoever reports it (the system, or a test's control file):
/// the window comes forward; an item notification opens that item.
pub fn on_click<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let d = app.state::<Desktop>();
    show_main(app, "click");
    if let Ok(v) = serde_json::from_str::<Value>(id) {
        if let (Some(key), Some(url)) = (v["key"].as_str(), v["url"].as_str()) {
            d.push(json!({ "kind": "open", "key": key, "url": url }));
        }
    }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>, why: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    app.state::<Desktop>().record(json!({ "op": "shown", "why": why }));
}

fn main_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

/// The sync beat, and (test mode) the control file. Runs for the life of the app.
pub fn spawn_background<R: Runtime>(app: AppHandle<R>) {
    let beat = app.clone();
    tauri::async_runtime::spawn(async move {
        let ms = beat.state::<Desktop>().tick_ms();
        let mut every = tokio::time::interval(std::time::Duration::from_millis(ms));
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        every.tick().await; // the first one fires at once; the window does its own first round at start
        loop {
            every.tick().await;
            let d = beat.state::<Desktop>();
            d.record(json!({ "op": "tick", "visible": main_visible(&beat) }));
            d.push(json!({ "kind": "tick" }));
        }
    });
    let control = app.state::<Desktop>().hooks.control.clone();
    if let Some(path) = control {
        tauri::async_runtime::spawn(async move {
            let mut offset = 0u64;
            let mut rest = String::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                let Ok(mut f) = std::fs::File::open(&path) else { continue };
                if f.seek(SeekFrom::Start(offset)).is_err() {
                    continue;
                }
                let mut buf = String::new();
                let Ok(n) = f.read_to_string(&mut buf) else { continue };
                offset += n as u64;
                rest.push_str(&buf);
                while let Some(i) = rest.find('\n') {
                    let line: String = rest.drain(..=i).collect();
                    let line = line.trim();
                    if line == "close" {
                        // the same request the window's close button sends (WindowEvent::CloseRequested)
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.close();
                        }
                    } else if let Some(id) = line.strip_prefix("click ") {
                        on_click(&app, id);
                    }
                }
            }
        });
    }
}

// ---- commands the window calls (src/backend/tauri.ts, tauriDesktop) -------------------

#[tauri::command]
pub async fn desktop_notify<R: Runtime>(app: AppHandle<R>, alert: Value) -> Result<Value, String> {
    let d = app.state::<Desktop>();
    let id = d.notification_id(&alert);
    let title = alert["title"].as_str().unwrap_or("").to_string();
    let body = alert["body"].as_str().unwrap_or("").to_string();
    let result: Result<(), String> = if d.hooks.record.is_some() || d.hooks.refuse.is_some() {
        match &d.hooks.refuse {
            Some(r) => Err(r.clone()),
            None => Ok(()),
        }
    } else {
        send(&app, &id, &title, &body).await
    };
    let answer = match &result {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    d.record(json!({ "op": "notify", "id": id, "alert": alert, "result": answer }));
    Ok(answer)
}

/// A real notification. v1: macOS only; elsewhere nothing is shown (and nothing is refused).
#[allow(unused_variables)]
async fn send<R: Runtime>(app: &AppHandle<R>, id: &str, title: &str, body: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::mac::notify(id, title, body).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

// async: runs on the async runtime, not queued behind the main thread
#[tauri::command]
pub async fn desktop_badge<R: Runtime>(app: AppHandle<R>, count: i64) -> Result<(), String> {
    let d = app.state::<Desktop>();
    d.record(json!({ "op": "badge", "count": count }));
    if cfg!(target_os = "macos") {
        if let Some(w) = app.get_webview_window("main") {
            w.set_badge_count(if count > 0 { Some(count) } else { None }).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Launch at login: on / off; null where this platform cannot (v1: macOS only).
#[tauri::command]
#[allow(unused_variables)]
pub fn desktop_login_item<R: Runtime>(app: AppHandle<R>) -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[tauri::command]
#[allow(unused_variables)]
pub fn desktop_set_login_item<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_autostart::ManagerExt;
        let l = app.autolaunch();
        return if on { l.enable() } else { l.disable() }.map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("这个系统还不支持开机自动启动".into())
    }
}

#[tauri::command]
pub async fn desktop_next_event<R: Runtime>(app: AppHandle<R>) -> Value {
    let d = app.state::<Desktop>();
    d.next().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_waiting_beat_is_not_queued_twice_and_clicks_keep_their_order() {
        let d = Desktop::new(TestHooks::default());
        d.push(json!({ "kind": "tick" }));
        d.push(json!({ "kind": "open", "key": "a#1", "url": "u1" }));
        d.push(json!({ "kind": "tick" }));
        d.push(json!({ "kind": "open", "key": "a#2", "url": "u2" }));
        assert_eq!(d.next().await["kind"], "tick");
        assert_eq!(d.next().await["key"], "a#1");
        assert_eq!(d.next().await["key"], "a#2");
        // after the waiting beat was taken, a new one queues again
        d.push(json!({ "kind": "tick" }));
        assert_eq!(d.next().await["kind"], "tick");
    }

    #[tokio::test]
    async fn next_waits_for_a_later_push() {
        let d = std::sync::Arc::new(Desktop::new(TestHooks::default()));
        let d2 = d.clone();
        let waiter = tokio::spawn(async move { d2.next().await });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        d.push(json!({ "kind": "tick" }));
        let got = tokio::time::timeout(std::time::Duration::from_secs(2), waiter).await.expect("woken").unwrap();
        assert_eq!(got["kind"], "tick");
    }

    #[test]
    fn notification_ids_bring_the_item_back_and_never_repeat() {
        let d = Desktop::new(TestHooks::default());
        let a = d.notification_id(&json!({ "kind": "item", "key": "o/r#1", "url": "https://github.com/o/r/issues/1" }));
        let b = d.notification_id(&json!({ "kind": "item", "key": "o/r#1", "url": "https://github.com/o/r/issues/1" }));
        assert_ne!(a, b);
        let v: Value = serde_json::from_str(&a).unwrap();
        assert_eq!(v["key"], "o/r#1");
        assert_eq!(v["url"], "https://github.com/o/r/issues/1");
        let s: Value = serde_json::from_str(&d.notification_id(&json!({ "kind": "summary" }))).unwrap();
        assert!(s.get("key").is_none());
    }

    #[test]
    fn test_hooks_only_in_test_mode() {
        let mut env = std::collections::HashMap::new();
        env.insert("CAVIL_CLIENT_TEST_HIDE_ON_CLOSE".to_string(), "1".to_string());
        env.insert("CAVIL_CLIENT_TEST_NOTIFY_REFUSE".to_string(), "no".to_string());
        env.insert("CAVIL_CLIENT_TEST_TICK_MS".to_string(), "500".to_string());
        let off = TestHooks::from_env(false, &env);
        assert!(!off.hide_on_close && off.refuse.is_none() && off.tick_ms.is_none());
        let on = TestHooks::from_env(true, &env);
        assert!(on.hide_on_close);
        assert_eq!(on.refuse.as_deref(), Some("no"));
        assert_eq!(on.tick_ms, Some(500));
    }
}
