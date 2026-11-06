// macOS: notifications through the system's current notification API
// (UserNotifications), and keeping the app awake while its window is closed.
//
// Why not the Tauri notification plugin (checked against plugins-workspace
// 4356356d, plugin 2.7.0): on macOS it never asks for permission (it reports
// "granted" unconditionally) and it drops the system's error when a
// notification is refused — the app could not tell the user that macOS is
// blocking it. A click on a notification is reported there too; here the
// delegate below does it. UserNotifications is also what Electron used, so the
// CI results can be compared with #146's.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSActivityOptions, NSBundle, NSError, NSProcessInfo, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::sync::{Mutex, OnceLock};

/// What a click on a notification does (set once at start): gets the notification's id.
static ON_CLICK: OnceLock<Box<dyn Fn(String) + Send + Sync>> = OnceLock::new();

define_class!(
    // SAFETY: NSObject has no subclassing requirements; no ivars, nothing to drop.
    #[unsafe(super(NSObject))]
    #[name = "CavilNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// Shown also while the app is in front (by default macOS would drop it silently).
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            if let Some(f) = ON_CLICK.get() {
                f(id);
            }
            completion.call(());
        }
    }
);

/// The notification center exists only for a bundled app (`npm start` runs an unbundled binary,
/// where asking for it crashes the process).
fn bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Called once at start: clicks go to `on_click`; the app is not put to sleep while its window is closed.
pub fn setup(on_click: impl Fn(String) + Send + Sync + 'static) {
    let _ = ON_CLICK.set(Box::new(on_click));
    // App Nap would suspend a windowless app: the sync beat, and so the reminders, would stop.
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &NSString::from_str("Cavil Loop 在后台同步并提醒待处理条目"),
    );
    // kept for the life of the process: ending the activity would let App Nap back in
    std::mem::forget(activity);
    if !bundled() {
        return;
    }
    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
    UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // the center holds its delegate weakly: it must live as long as the process
    std::mem::forget(delegate);
}

fn describe(err: *mut NSError) -> Option<String> {
    if err.is_null() {
        None
    } else {
        Some(unsafe { &*err }.localizedDescription().to_string())
    }
}

/// Ask for permission (the first time macOS shows its "allow?" prompt; once decided it answers at
/// once). Everything Objective-C stays in this function: only the receiver crosses an await.
fn ask_permission() -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let tx = Mutex::new(Some(tx));
    let asked = RcBlock::new(move |_granted: Bool, _err: *mut NSError| {
        if let Some(tx) = tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
        &asked,
    );
    rx
}

/// Hand one notification to the system; the receiver gets its answer.
fn add_request(id: &str, title: &str, body: &str) -> tokio::sync::oneshot::Receiver<Result<(), String>> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let tx = Mutex::new(Some(tx));
    let done = RcBlock::new(move |err: *mut NSError| {
        if let Some(tx) = tx.lock().unwrap().take() {
            let _ = tx.send(match describe(err) {
                None => Ok(()),
                Some(m) => Err(m),
            });
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&done));
    rx
}

/// One notification. Resolves with what the system said: Ok once it accepted the request (that is not
/// proof it was on screen), Err with its own words
/// (e.g. "Notifications are not allowed for this application").
pub async fn notify(id: &str, title: &str, body: &str) -> Result<(), String> {
    if !bundled() {
        return Err("未打包的开发版不能发系统通知".into());
    }
    // the answer itself is not needed: a refusal comes back from the request below, in the system's words
    let asked = ask_permission();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(60), asked).await;
    let answered = add_request(id, title, body);
    match tokio::time::timeout(std::time::Duration::from_secs(15), answered).await {
        Ok(Ok(r)) => r,
        _ => Err("系统没有回应这条通知（等了 15 秒）".into()),
    }
}
