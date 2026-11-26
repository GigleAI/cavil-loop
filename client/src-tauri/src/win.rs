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
    // switched off for this app (or for the whole system) in Windows' settings: say so, like macOS's refusal.
    // A setting that cannot be read (the system has not listed the app yet) is not a refusal: the
    // notification is still sent, and what Show answers is the result.
    if let Ok(st) = notifier.Setting() {
        if st != NotificationSetting::Enabled {
            return Err(tr("Windows 设置里关掉了通知（{why}）", &[("why", &format!("{}", st.0))]));
        }
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

/// GitHub#730: open a web address (already checked by the back end) with the program the system has
/// for it — the default browser — through the shell's "open", the documented way to do so. Handing the
/// address to Explorer as an argument (what this replaced) reported success whatever Explorer then did,
/// and a new-issue address carrying the typed text opened a folder instead.
///
/// No dialog of the system's own on failure (the caller shows the error); waits until the shell has
/// handed the address on, so call it on a thread that may block. The shell can hand an address to a
/// COM-based handler, which needs COM on the calling thread: started here when the thread has none,
/// and ended again only when started here.
pub fn open_url(url: &str) -> Result<(), String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file = HSTRING::from(url);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: w!("open"),
        lpFile: PCWSTR(file.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    // S_OK / S_FALSE: this call started (or re-entered) COM and must end it; anything else (the thread
    // already runs another kind of COM) leaves COM as it is
    let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok();
    let done = unsafe { ShellExecuteExW(&mut info) };
    if com {
        unsafe { CoUninitialize() };
    }
    done.map_err(|e| tr("打不开浏览器：{e}", &[("e", &e.message().to_string())]))
}

/// GitHub#730: `open_url` itself, on a real Windows. The address types registered here exist only for
/// the test (a random name under the current user's own classes, removed afterwards): the program the
/// shell starts for one writes the address it was given into a file, so the test sees exactly what a
/// browser would have been handed. These run only where Windows runs the tests — no check on a pull
/// request does (they run on Linux).
#[cfg(test)]
mod tests {
    use super::open_url;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegDeleteTreeW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

    fn set(key: &str, name: Option<&str>, value: &str) {
        let wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
        let name = name.map(HSTRING::from).unwrap_or_default();
        let r = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(key), &name, REG_SZ.0, Some(wide.as_ptr().cast()), (wide.len() * 2) as u32) };
        assert!(r.is_ok(), "registry write {key}: {r:?}");
    }

    /// A throw-away address type whose handler writes the address into `out`; removed on drop.
    struct Scheme {
        name: String,
        dir: PathBuf,
    }

    impl Scheme {
        fn new(out: &str) -> Scheme {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let tag = format!("{:x}-{nanos:x}", std::process::id());
            let name = format!("cavil-test-{tag}");
            let dir = std::env::temp_dir().join(&name);
            std::fs::create_dir_all(&dir).unwrap();
            let target = dir.join(out);
            let script = dir.join("handler.ps1");
            // written to a side file first, then moved: the test never reads half an address
            std::fs::write(
                &script,
                format!(
                    "param([string]$u)\r\n$t = '{t}.part'\r\n[System.IO.File]::WriteAllText($t, $u, (New-Object System.Text.UTF8Encoding $false))\r\nMove-Item -LiteralPath $t -Destination '{t}'\r\n",
                    t = target.display()
                ),
            )
            .unwrap();
            let key = format!("Software\\Classes\\{name}");
            set(&key, None, &format!("URL:{name}"));
            set(&key, Some("URL Protocol"), "");
            set(
                &format!("{key}\\shell\\open\\command"),
                None,
                &format!("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{}\" \"%1\"", script.display()),
            );
            Scheme { name, dir }
        }

        fn out(&self, file: &str) -> PathBuf {
            self.dir.join(file)
        }
    }

    impl Drop for Scheme {
        fn drop(&mut self) {
            let _ = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(format!("Software\\Classes\\{}", self.name))) };
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn wait_for(path: &Path) -> String {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(60) {
            if let Ok(s) = std::fs::read_to_string(path) {
                return s;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("the handler never wrote {}", path.display());
    }

    /// percent-encoded the way the window builds a new-issue address (URLSearchParams)
    fn encoded(s: &str) -> String {
        s.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
    }

    #[test]
    fn hands_the_whole_address_to_its_program() {
        let s = Scheme::new("got.txt");
        let title = encoded("wiindows 版新建issue点击 「到 GitHub 网页上继续新建」无法打开浏览器");
        let body = encoded(&"正文里的一段中文，带 & 和 # 号。\n".repeat(20));
        let cases = [
            format!("{}://github.com/GigleAI/cavil-loop/issues/730", s.name),
            format!("{}://github.com/GigleAI/cavil-loop/issues/new?title={title}&body={body}&labels=pending%2Fagent%2Cautopilot#top", s.name),
        ];
        assert!(cases[1].len() > 2000, "the long case is long: {}", cases[1].len());
        for (i, url) in cases.iter().enumerate() {
            let file = format!("got-{i}.txt");
            open_url(url).expect("the shell accepted the address");
            let got = wait_for(&s.out("got.txt"));
            // the handler always writes `got.txt`: moved aside before the next case
            std::fs::rename(s.out("got.txt"), s.out(&file)).unwrap();
            assert_eq!(got, *url, "case {i}: the program got exactly the address");
        }
    }

    #[test]
    fn says_when_nothing_opens_the_address() {
        let name = format!("cavil-test-none-{:x}", std::process::id());
        let err = open_url(&format!("{name}://github.com/")).expect_err("no program for this address type");
        assert!(err.starts_with("打不开浏览器：") || err.starts_with("Cannot open the browser: "), "{err}");
    }

    #[test]
    fn the_address_reaches_the_system_unchanged() {
        let url = "https://github.com/o/r/issues/new?title=%E4%B8%AD&body=a%26b#x";
        let h = HSTRING::from(url);
        assert_eq!(h.to_string_lossy(), url);
        // what the shell reads: every character, then the terminating zero
        let wide = unsafe { std::slice::from_raw_parts(h.as_ptr(), h.len() + 1) };
        assert_eq!(&wide[..h.len()], url.encode_utf16().collect::<Vec<u16>>().as_slice());
        assert_eq!(wide[h.len()], 0);
    }
}
