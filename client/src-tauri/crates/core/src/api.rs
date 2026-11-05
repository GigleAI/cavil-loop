// The commands the window may send, and nothing else. The Tauri app and the
// test harness both call `dispatch`: one implementation, two transports.
//
// No command takes or returns the credential. Setting writes for the keys that
// describe the credential (store::SECRET_KEYS) are refused.

use crate::engine::{BeginOut, Engine, FinishOut, RequestError, StartOut};
use crate::http::HttpRequest;
use crate::store::SECRET_KEYS;
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
        "loginCancel" => {
            e.cancel_login();
            Ok(Value::Null)
        }
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
        "setSetting" => {
            let k = s(&a, "key")?;
            if SECRET_KEYS.contains(&k) {
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
        other => Err(format!("未知命令：{other}")),
    }
}
