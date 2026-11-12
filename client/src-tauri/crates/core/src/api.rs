// The commands the window may send, and nothing else. The Tauri app and the
// test harness both call `dispatch`: one implementation, two transports.
//
// No command takes or returns the credential. Setting writes for the keys that
// describe the credential (store::SECRET_KEYS) are refused.

use crate::engine::{BeginOut, Engine, FinishOut, RequestError, StartOut};
use crate::http::HttpRequest;
use crate::store::{BACKEND_ONLY_KEYS, SECRET_KEYS};
use crate::zoom;
use serde_json::{json, Value};
use std::sync::Arc;

fn s<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    a.get(k).and_then(|v| v.as_str()).ok_or_else(|| format!("缺少参数 {k}"))
}

fn u(a: &Value, k: &str) -> Result<u64, String> {
    a.get(k).and_then(|v| v.as_u64()).ok_or_else(|| format!("缺少参数 {k}"))
}

pub async fn dispatch(e: &Arc<Engine>, cmd: &str, a: Value) -> Result<Value, String> {
    match cmd {
        "init" => {
            let snapshots = e.visible_snapshots();
            let ep = e.endpoints();
            Ok(json!({
                "settings": e.public_settings(),
                "snapshots": snapshots,
                "persistent": e.persistent(),
                "endpoints": { "api": ep.api, "web": ep.web },
            }))
        }
        "start" => Ok(match e.start().await {
            StartOut::Login { reason, wiped } => json!({ "phase": "login", "reason": reason, "wiped": wiped }),
            StartOut::Ready { session, wiped } => json!({ "phase": "ready", "session": session, "wiped": wiped }),
        }),
        "loginBegin" => Ok(match e.login_begin(s(&a, "clientId")?).await {
            BeginOut::Waiting { run, user_code, verification_uri } => {
                json!({ "status": "waiting", "run": run, "userCode": user_code, "verificationUri": verification_uri })
            }
            BeginOut::Failed { status, message } => json!({ "status": status, "message": message }),
            BeginOut::Stale => json!({ "status": "stale" }),
        }),
        "loginFinish" => Ok(match e.login_finish(u(&a, "run")?).await {
            FinishOut::Ok { session, viewer, wiped } => json!({ "status": "ok", "session": session, "viewer": viewer, "wiped": wiped }),
            FinishOut::Failed { status, message } => json!({ "status": status, "message": message }),
            FinishOut::Stale { login_reason } => json!({ "status": "stale", "loginReason": login_reason }),
        }),
        "loginCancel" => Ok(match e.cancel_login(a.get("run").and_then(|v| v.as_u64())) {
            None => json!({}),
            Some((session, message)) => json!({ "signedOut": { "session": session, "message": message } }),
        }),
        "openVerification" => match e.verification_uri() {
            Some(uri) => e.open_external(&uri).await.map(|_| Value::Null),
            None => Ok(Value::Null),
        },
        "logout" => {
            let (session, message) = e.logout(a.get("reason").and_then(|v| v.as_str()));
            Ok(json!({ "session": session, "message": message }))
        }
        "logoutResult" => {
            let (message, current) = e.logout_result(u(&a, "session")?).await;
            Ok(json!({ "message": message, "current": current }))
        }
        "ensureFresh" => {
            let session = u(&a, "session")?;
            let force = a.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            if session != e.session() {
                return Ok(json!({ "result": "ended" }));
            }
            // "refresh the token this round used": a token that changed meanwhile is not refreshed again
            if let Some(gen) = a.get("gen").and_then(|v| v.as_u64()) {
                if gen != e.gen() {
                    return Ok(json!({ "result": "changed" }));
                }
            }
            let client_id = a.get("clientId").and_then(|v| v.as_str()).unwrap_or("");
            Ok(e.ensure_fresh(force, client_id).await.to_json())
        }
        "saveUnsaved" => Ok(match e.save_unsaved().await {
            None => json!({}),
            Some(p) => json!({ "problem": p }),
        }),
        "grantInfo" => Ok(e.grant_info().await),
        "adoptViewer" => Ok(match e.adopt_viewer(u(&a, "session")?, s(&a, "login")?) {
            Ok(None) => json!({ "stale": true }),
            Ok(Some(wiped)) => json!({ "wiped": wiped }),
            Err(m) => json!({ "stale": true, "problem": format!("本地缓存写入失败（{m}），这一轮的结果没有保存") }),
        }),
        "request" => {
            let session = u(&a, "session")?;
            let headers = match a.get("headers") {
                Some(Value::Object(m)) => m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect(),
                _ => vec![],
            };
            let req = HttpRequest {
                method: s(&a, "method")?.to_string(),
                url: s(&a, "url")?.to_string(),
                headers,
                body: a.get("body").and_then(|v| v.as_str()).map(str::to_string),
            };
            Ok(match e.request(session, req).await {
                Ok(r) => json!({ "status": r.status, "headers": r.headers, "body": r.body }),
                Err(RequestError::Stale) => json!({ "error": "stale", "message": "还没有登录" }),
                Err(RequestError::Refused(m)) => json!({ "error": "refused", "message": m }),
                Err(RequestError::Network(m)) => json!({ "error": "network", "message": m }),
            })
        }
        // GitHub#395: a release attachment image of the discussion — only an attachment's API address is accepted
        "releaseImage" => Ok(e.release_image(u(&a, "session")?, s(&a, "url")?).await),
        "setSetting" => {
            let k = s(&a, "key")?;
            if SECRET_KEYS.contains(&k) || BACKEND_ONLY_KEYS.contains(&k) {
                return Err(format!("这个设置只能由登录流程写：{k}"));
            }
            e.store().set_setting(k, a.get("value").unwrap_or(&Value::Null))?;
            Ok(Value::Null)
        }
        "replaceSnapshots" => {
            let snaps = match a.get("snapshots") {
                Some(Value::Array(v)) => v.clone(),
                _ => return Err("缺少参数 snapshots".into()),
            };
            Ok(json!({ "written": e.replace_snapshots(u(&a, "session")?, &snaps)? }))
        }
        "deleteSnapshot" => {
            e.store().delete_snapshot(s(&a, "key")?)?;
            Ok(Value::Null)
        }
        "openExternal" => e.open_external(s(&a, "url")?).await.map(|_| Value::Null),
        // page zoom (GitHub#155): "get" reads the kept level, "in" / "out" / "reset" step and keep it
        "zoom" => {
            let step = s(&a, "step")?;
            if step == "get" {
                return Ok(json!({ "percent": zoom::saved(e.store()) }));
            }
            let step = zoom::Step::parse(step).ok_or_else(|| format!("未知的缩放：{step}"))?;
            let (percent, kept) = zoom::apply(e.store(), step);
            Ok(json!({ "percent": percent, "kept": kept.err() }))
        }
        // the local daemon (GitHub#314): fixed requests, the back end decides every path and command
        "daemonStatus" => Ok(e.daemon().status().await),
        "daemonInstall" => Ok(e.daemon().install().await),
        "daemonService" => Ok(e.daemon().service(s(&a, "key")?, s(&a, "action")?).await),
        "daemonDisconnect" => Ok(e.daemon().disconnect(s(&a, "key")?).await),
        "daemonOpen" => Ok(e.daemon().open(s(&a, "key")?, s(&a, "what")?).await),
        "daemonUpdate" => Ok(e.daemon().update().await),
        // "接上 daemon" from the repository list (GitHub#315): the window names a repository, an agent and a folder;
        // the back end checks each of them again and runs the daemon's own setup.sh
        "daemonConnectInfo" => Ok(e.daemon().connect_info(s(&a, "repo")?).await),
        "daemonPrecheck" => Ok(e.daemon().precheck(s(&a, "agent")?).await),
        "daemonCheckDir" => Ok(e.daemon().check_dir_request(s(&a, "repo")?, s(&a, "dir")?).await),
        "daemonPickFolder" => Ok(e.daemon().pick_folder(a.get("start").and_then(|v| v.as_str()).map(str::to_string)).await),
        "daemonConnect" => Ok(e.daemon_arc().connect(s(&a, "repo")?, s(&a, "agent")?, a.get("dir").and_then(|v| v.as_str()), a.get("cloneInto").and_then(|v| v.as_str())).await),
        "daemonConnectPoll" => Ok(e.daemon().connect_poll(a.get("job").and_then(|v| v.as_u64()).ok_or_else(|| "缺参数 job".to_string())?, a.get("from").and_then(|v| v.as_u64()).unwrap_or(0) as usize)),
        other => Err(format!("未知命令：{other}")),
    }
}
