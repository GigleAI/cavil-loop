// The window's size and place across restarts (GitHub#333). What to keep and what a start
// uses is decided in crates/core/src/window_state.rs; this file only reads the real window
// and the real screens for it, and says when to look:
//   - the window was resized or moved: one look once it has been still for a moment
//     (the state is read then, not at the event — mid-way through maximizing or going
//     full screen the system still reports the old state with the new size)
//   - the window is closed (hidden on macOS), the app quits or restarts itself: one look now
// A window that is not on screen is never looked at: nothing about it changed, and a
// window that was never shown has no real size yet.

use crate::desktop::Desktop;
use cavil_core::store::Store;
use cavil_core::window_state::{self as ws, Mode, Placement, Screen};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

/// How long the window has to be still before a resize / move is kept.
const STILL_MS: u64 = 400;

pub struct Keeper {
    store: Arc<Store>,
    changes: AtomicU64,
}

impl Keeper {
    pub fn new(store: Arc<Store>) -> Keeper {
        Keeper { store, changes: AtomicU64::new(0) }
    }
}

/// The screens there are now in logical pixels, the primary one first; empty when they cannot be read.
fn screens<R: Runtime>(app: &AppHandle<R>) -> Vec<Screen> {
    let to_screen = |m: &tauri::Monitor| {
        let f = m.scale_factor();
        let (p, s) = (m.position().to_logical::<f64>(f), m.size().to_logical::<f64>(f));
        Screen { x: p.x, y: p.y, w: s.width, h: s.height }
    };
    let Ok(all) = app.available_monitors() else { return vec![] };
    let primary = app.primary_monitor().ok().flatten().map(|m| to_screen(&m));
    let mut out: Vec<Screen> = all.iter().map(to_screen).collect();
    if let Some(p) = primary {
        out.retain(|s| *s != p);
        out.insert(0, p);
    }
    out
}

/// What this start builds the window with, and whether there was a kept record behind it.
pub fn placement<R: Runtime>(app: &AppHandle<R>, store: &Store) -> (Placement, bool) {
    let saved = ws::saved(store);
    (ws::placement(saved.as_ref(), &screens(app)), saved.is_some())
}

/// Test mode: what this start built the window with (after the "start" record: a start's first record is "start").
pub fn record_start<R: Runtime>(app: &AppHandle<R>, place: &Placement, kept: bool) {
    app.state::<Desktop>().record(json!({
        "op": "window", "kept": kept, "w": place.w, "h": place.h,
        "x": place.pos.map(|p| p.0), "y": place.pos.map(|p| p.1), "maximized": place.maximized,
    }));
}

/// Look at the window now and keep what changed.
pub fn look<R: Runtime>(app: &AppHandle<R>) {
    let (Some(k), Some(w)) = (app.try_state::<Keeper>(), app.get_webview_window("main")) else { return };
    if !matches!(w.is_visible(), Ok(true)) {
        return;
    }
    // any state that cannot be read is "do not know": nothing is kept from this look
    let mode = match (w.is_fullscreen(), w.is_minimized(), w.is_maximized()) {
        (Ok(false), Ok(false), Ok(false)) => Mode::Normal,
        (Ok(false), Ok(false), Ok(true)) => Mode::Maximized,
        _ => Mode::Other,
    };
    let (Ok(scale), Ok(size)) = (w.scale_factor(), w.inner_size()) else { return };
    let size = size.to_logical::<f64>(scale);
    let pos = w.outer_position().ok().map(|p| p.to_logical::<f64>(scale)).map(|p| (p.x, p.y));
    if let Some((rec, kept)) = ws::keep(&k.store, mode, (size.width, size.height), pos) {
        if let Err(e) = &kept {
            eprintln!("cavil: keeping the window size failed: {e}");
        }
        app.state::<Desktop>().record(json!({
            "op": "windowKept", "ok": kept.is_ok(), "w": rec.w, "h": rec.h,
            "x": rec.pos.map(|p| p.0), "y": rec.pos.map(|p| p.1), "maximized": rec.maximized,
        }));
    }
}

/// The window was resized or moved: look once it has been still for `STILL_MS`.
pub fn changed<R: Runtime>(app: &AppHandle<R>) {
    let Some(k) = app.try_state::<Keeper>() else { return };
    let mine = k.changes.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let still_ms = app.state::<Desktop>().hooks.window_still_ms.unwrap_or(STILL_MS);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(still_ms)).await;
        let still = app.try_state::<Keeper>().is_some_and(|k| k.changes.load(Ordering::SeqCst) == mine);
        if still {
            look(&app);
        }
    });
}
