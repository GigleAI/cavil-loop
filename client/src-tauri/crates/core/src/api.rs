// The commands the window may send, and nothing else. The Tauri app and the
// test harness both call `dispatch`: one implementation, two transports.
//
// No command takes or returns the credential. Setting writes for the keys that
// describe the credential (store::SECRET_KEYS) are refused.

use crate::engine::{BeginOut, Engine, FinishOut, RequestError, StartOut};
use crate::http::HttpRequest;
use crate::i18n::{tr, Said};
use crate::store::{BACKEND_ONLY_KEYS, SECRET_KEYS};
use crate::theme::Theme;
use crate::zoom;
use serde_json::{json, Value};
use std::sync::Arc;

fn s<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    a.get(k).and_then(|v| v.as_str()).ok_or_else(|| tr("缺少参数 {k}", &[("k", k)]))
}

fn u(a: &Value, k: &str) -> Result<u64, String> {
    a.get(k).and_then(|v| v.as_u64()).ok_or_else(|| tr("缺少参数 {k}", &[("k", k)]))
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
            StartOut::Login { reason, wiped } => json!({ "phase": "login", "reason": reason.as_ref().map(Said::text), "reasonSaid": reason.as_ref().map(Said::to_json), "wiped": wiped }),
            StartOut::Ready { session, wiped } => json!({ "phase": "ready", "session": session, "wiped": wiped }),
        }),
        "loginBegin" => Ok(match e.login_begin(s(&a, "clientId")?).await {
            BeginOut::Waiting { run, user_code, verification_uri } => {
                json!({ "status": "waiting", "run": run, "userCode": user_code, "verificationUri": verification_uri })
            }
            BeginOut::Failed { status, said } => json!({ "status": status, "message": said.text(), "said": said.to_json() }),
            BeginOut::Stale => json!({ "status": "stale" }),
        }),
        "loginFinish" => Ok(match e.login_finish(u(&a, "run")?).await {
            FinishOut::Ok { session, viewer, wiped } => json!({ "status": "ok", "session": session, "viewer": viewer, "wiped": wiped }),
            FinishOut::Failed { status, said } => json!({ "status": status, "message": said.text(), "said": said.to_json() }),
            FinishOut::Stale { login_reason } => json!({ "status": "stale", "loginReason": login_reason.as_ref().map(Said::text), "loginReasonSaid": login_reason.as_ref().map(Said::to_json) }),
        }),
        "loginCancel" => Ok(match e.cancel_login(a.get("run").and_then(|v| v.as_u64())) {
            None => json!({}),
            Some((session, message)) => json!({ "signedOut": { "session": session, "message": message.as_ref().map(Said::text), "said": message.as_ref().map(Said::to_json) } }),
        }),
        "openVerification" => match e.verification_uri() {
            Some(uri) => e.open_external(&uri).await.map(|_| Value::Null),
            None => Ok(Value::Null),
        },
        "logout" => {
            let (session, message) = e.logout(a.get("reason").and_then(|v| v.as_str()));
            Ok(json!({ "session": session, "message": message.as_ref().map(Said::text), "said": message.as_ref().map(Said::to_json) }))
        }
        "logoutResult" => {
            let (message, current) = e.logout_result(u(&a, "session")?).await;
            Ok(json!({ "message": message.as_ref().map(Said::text), "said": message.as_ref().map(Said::to_json), "current": current }))
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
            Some(p) => json!({ "problem": p.as_ref().map(Said::text), "problemSaid": p.as_ref().map(Said::to_json) }),
        }),
        "grantInfo" => Ok(e.grant_info().await),
        "adoptViewer" => Ok(match e.adopt_viewer(u(&a, "session")?, s(&a, "login")?) {
            Ok(None) => json!({ "stale": true }),
            Ok(Some(wiped)) => json!({ "wiped": wiped }),
            Err(m) => {
                let p = Said::compose("本地缓存写入失败（{m}），这一轮的结果没有保存", &[("m", &m.said())]);
                json!({ "stale": true, "problem": p.text(), "problemSaid": p.to_json() })
            }
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
                Err(RequestError::Stale) => json!({ "error": "stale", "message": tr("还没有登录", &[]) }),
                Err(RequestError::Refused(m)) => json!({ "error": "refused", "message": m }),
                Err(RequestError::Network(m)) => json!({ "error": "network", "message": m }),
            })
        }
        // GitHub#395: a release attachment image of the discussion — only an attachment's API address is accepted
        "releaseImage" => Ok(e.release_image(u(&a, "session")?, s(&a, "url")?).await),
        // GitHub#471: the language of the back end's own words (menu, messages); the window decides it
        "setLanguage" => {
            let l = s(&a, "lang")?;
            let lang = crate::i18n::Lang::parse(l).ok_or_else(|| crate::i18n::tr("不认识的语言：{lang}", &[("lang", l)]))?;
            crate::i18n::set_lang(lang);
            Ok(Value::Null)
        }
        // GitHub#516: the window's light / dark; the shell (src-tauri/src/main.rs) passes it on to the native
        // window. Checked here, so a word the shell does not know never reaches it.
        "setTheme" => {
            let v = s(&a, "theme")?;
            Theme::parse(v).ok_or_else(|| crate::i18n::tr("不认识的外观：{theme}", &[("theme", v)]))?;
            Ok(Value::Null)
        }
        "setSetting" => {
            let k = s(&a, "key")?;
            if SECRET_KEYS.contains(&k) || BACKEND_ONLY_KEYS.contains(&k) {
                return Err(tr("这个设置只能由登录流程写：{k}", &[("k", k)]));
            }
            e.store().set_setting(k, a.get("value").unwrap_or(&Value::Null))?;
            Ok(Value::Null)
        }
        "replaceSnapshots" => {
            let snaps = match a.get("snapshots") {
                Some(Value::Array(v)) => v.clone(),
                _ => return Err(tr("缺少参数 {k}", &[("k", "snapshots")])),
            };
            Ok(json!({ "written": e.replace_snapshots(u(&a, "session")?, &snaps)? }))
        }
        "deleteSnapshot" => {
            e.store().delete_snapshot(s(&a, "key")?)?;
            Ok(Value::Null)
        }
        "openExternal" => e.open_external(s(&a, "url")?).await.map(|_| Value::Null),
        // GitHub#401: the authorisation page of the app this sign-in used (the back end builds it)
        "openAuthPage" => {
            let url = e.auth_page_url();
            e.open_external(&url).await.map(|_| Value::Null)
        }
        // page zoom (GitHub#155): "get" reads the kept level, "in" / "out" / "reset" step and keep it
        "zoom" => {
            let step = s(&a, "step")?;
            if step == "get" {
                return Ok(json!({ "percent": zoom::saved(e.store()) }));
            }
            let step = zoom::Step::parse(step).ok_or_else(|| tr("未知的缩放：{step}", &[("step", step)]))?;
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
        // "配置" on a project (GitHub#388): the window names a project and settings; the back end runs the
        // daemon's own project-config.sh, which decides where the file is and what may be changed
        "daemonConfigGet" => Ok(e.daemon().config_get(s(&a, "key")?).await),
        "daemonConfigSet" => Ok(e.daemon().config_set(s(&a, "key")?, s(&a, "rev")?, a.get("values").unwrap_or(&Value::Null)).await),
        // "接上 daemon" from the repository list (GitHub#315): the window names a repository, an agent and a folder;
        // the back end checks each of them again and runs the daemon's own setup.sh
        "daemonConnectInfo" => Ok(e.daemon().connect_info(s(&a, "repo")?).await),
        "daemonPrecheck" => Ok(e.daemon().precheck(s(&a, "agent")?).await),
        "daemonCheckDir" => Ok(e.daemon().check_dir_request(s(&a, "repo")?, s(&a, "dir")?).await),
        "daemonPickFolder" => Ok(e.daemon().pick_folder(a.get("start").and_then(|v| v.as_str()).map(str::to_string)).await),
        "daemonConnect" => Ok(e.daemon_arc().connect(s(&a, "repo")?, s(&a, "agent")?, a.get("dir").and_then(|v| v.as_str()), a.get("cloneInto").and_then(|v| v.as_str())).await),
        "daemonConnectPoll" => Ok(e.daemon().connect_poll(a.get("job").and_then(|v| v.as_u64()).ok_or_else(|| tr("缺参数 {k}", &[("k", "job")]))?, a.get("from").and_then(|v| v.as_u64()).unwrap_or(0) as usize)),
        // a daemon on another machine (GitHub#387): the window names a machine from the list and a
        // project; the back end holds the key, checks the connection and signs the request
        "remoteList" => Ok(e.remote().list()),
        "remotePair" => Ok(e.remote().pair(s(&a, "host")?, s(&a, "code")?).await),
        "remoteStatus" => Ok(e.remote().status(s(&a, "id")?).await),
        "remoteService" => Ok(e.remote().service(s(&a, "id")?, s(&a, "key")?, s(&a, "action")?).await),
        "remoteLog" => Ok(e.remote().log(s(&a, "id")?, s(&a, "key")?).await),
        // "配置" on a remote project (GitHub#530): that machine runs its own project-config.sh
        "remoteConfigGet" => Ok(e.remote().config_get(s(&a, "id")?, s(&a, "key")?).await),
        "remoteConfigSet" => Ok(e.remote().config_set(s(&a, "id")?, s(&a, "key")?, s(&a, "rev")?, a.get("values").unwrap_or(&Value::Null)).await),
        "remoteUnpair" => Ok(e.remote().unpair(s(&a, "id")?, a.get("localOnly").and_then(|v| v.as_bool()).unwrap_or(false)).await),
        "remoteForget" => Ok(e.remote().forget(s(&a, "id")?).await),
        "remoteTailnet" => Ok(e.remote().tailnet(e.daemon()).await),
        "remoteHost" => Ok(e.daemon().remote_host(s(&a, "action")?, a.get("target").and_then(|v| v.as_str())).await),
        other => Err(tr("未知命令：{other}", &[("other", other)])),
    }
}
