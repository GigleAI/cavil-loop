// The Windows desktop side (GitHub#577), the counterpart of mac.rs: notifications through the
// system's toast API, taking them back, the icon in the notification area. What they say and how
// they are found again is decided in cavil_core::toast; when to send one, in the window.
//
// A notification names the app by its AppUserModelID, which is the bundle identifier: the
// installer writes it onto the Start menu shortcut, which is what lets the system show the app's
// name and icon on it. An app started without that shortcut (a development build) may have its
// notifications refused by the system; the refusal is reported like any other.

use cavil_core::i18n::tr;
use cavil_core::toast;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager};

/// tauri.conf.json `identifier`, the AppUserModelID the installer gives the app.
pub const APP_ID: &str = "dev.luosky.cavil-loop.client";

/// The notifications sent by this start of the app, kept so their click handlers stay alive.
static SHOWN: Mutex<Vec<ToastNotification>> = Mutex::new(Vec::new());
const KEEP: usize = 64;

fn app_id() -> HSTRING {
    HSTRING::from(APP_ID)
}

/// Show one notification; a click on it calls `on_click` with `id`.
pub fn notify(id: &str, title: &str, body: &str, on_click: impl Fn(String) + Send + Sync + 'static) -> Result<(), String> {
    let e = |e: windows::core::Error| e.message().to_string();
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&app_id()).map_err(e)?;
    // switched off for this app (or for the whole system) in Windows' settings: say so, like macOS's refusal
    match notifier.Setting() {
        Ok(NotificationSetting::Enabled) => {}
        Ok(s) => return Err(tr("Windows 设置里关掉了通知（{why}）", &[("why", &format!("{}", s.0))])),
        Err(err) => return Err(e(err)),
    }
    let doc = XmlDocument::new().map_err(e)?;
    doc.LoadXml(&HSTRING::from(toast::xml(title, body))).map_err(e)?;
    let t = ToastNotification::CreateToastNotification(&doc).map_err(e)?;
    t.SetTag(&HSTRING::from(toast::tag(id))).map_err(e)?;
    t.SetGroup(&HSTRING::from(toast::group(id))).map_err(e)?;
    let id = id.to_string();
    t.Activated(&TypedEventHandler::new(move |_, _| {
        on_click(id.clone());
        Ok(())
    }))
    .map_err(e)?;
    notifier.Show(&t).map_err(e)?;
    let mut shown = SHOWN.lock().unwrap();
    shown.push(t);
    if shown.len() > KEEP {
        let n = shown.len() - KEEP;
        shown.drain(..n);
    }
    Ok(())
}

/// Take back every notification of this app still in the notification centre.
pub fn clear_delivered() {
    if let Ok(h) = ToastNotificationManager::History() {
        let _ = h.ClearWithId(&app_id());
    }
}

/// Take back one notification, by its whole id (GitHub#369).
pub fn clear_delivered_one(id: &str) {
    if let Ok(h) = ToastNotificationManager::History() {
        let _ = h.RemoveGroupedTagWithId(&HSTRING::from(toast::tag(id)), &HSTRING::from(toast::group(id)), &app_id());
    }
}

/// Take back every notification about this item, of any start of the app (GitHub#522).
pub fn clear_delivered_for(key: &str) {
    if let Ok(h) = ToastNotificationManager::History() {
        let _ = h.RemoveGroupWithId(&HSTRING::from(toast::item_group(key)), &app_id());
    }
}

/// The icon in the notification area: a click brings the window back, its menu has 打开 / 退出 —
/// with the window closed, the app keeps syncing and reminding until 退出 is chosen.
pub fn tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItem::with_id(app, "tray-open", tr("打开 Cavil Loop", &[]), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", tr("退出", &[]), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut b = TrayIconBuilder::with_id("main")
        .tooltip("Cavil Loop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "tray-open" => crate::desktop::show_main(app, "tray"),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|icon, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                crate::desktop::show_main(icon.app_handle(), "tray");
            }
        });
    if let Some(i) = app.default_window_icon() {
        b = b.icon(i.clone());
    }
    b.build(app)?;
    Ok(())
}

/// The unread count on the taskbar button: a picture laid over the app's icon (cavil_core::badge).
pub fn set_badge<R: Runtime>(app: &AppHandle<R>, count: i64) -> Result<(), String> {
    let Some(w) = app.get_webview_window("main") else { return Ok(()) };
    let icon = cavil_core::badge::overlay(count).map(|px| tauri::image::Image::new_owned(px, cavil_core::badge::SIZE, cavil_core::badge::SIZE));
    w.set_overlay_icon(icon).map_err(|e| e.to_string())
}
