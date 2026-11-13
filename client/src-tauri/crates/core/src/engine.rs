// The sign-in lifecycle. This is the only place that ever holds the GitHub
// credential: the window gets the sign-in *state* (phase, viewer, a session
// number) and asks this side to send requests for it.
//
// Ported rule for rule from the Electron build's main/controller.ts (the part
// of it that touched the credential). The one rule that keeps every sign-out /
// cancel / crash safe — the trust list:
//   - a sign-out empties it FIRST (one transaction with dropping the cache),
//     before the window switches pages and before the keychain delete runs;
//   - a login empties it before writing the keychain and adds the new
//     credential only after the write succeeded and the login is still current;
//   - a refresh trusts {old, new} while writing, then only the new one;
//   - start uses the stored credential only if its hash is listed, otherwise
//     it is a leftover (sign-out not finished, cancelled login, …): login page,
//     and the leftover is deleted.
// So whatever point the process stops at, a restart never signs in with a
// credential the user signed out of.

use crate::device::{self, DeviceCode, Failure};
use crate::grant::{decode_grant, encode_grant, TokenGrant};
use crate::http::{self, Endpoints, HttpRequest};
use crate::platform::{Clock, CredentialStore, Opener};
use crate::i18n::{tr, Said};
use crate::store::StoreError;
use crate::store::{Store, CACHE_CREDENTIAL, CACHE_OWNER, GRANT_CLIENT_ID, SECRET_KEYS, TRUSTED, VIEWER};
use futures::future::{BoxFuture, FutureExt, Shared};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// the sign-out reason when GitHub no longer renews the login, in the window's language
pub fn reason_refresh_ended() -> String {
    tr("登录已到期，GitHub 不再接受续期，请重新登录", &[])
}
/// refresh this long before the access token expires
pub const REFRESH_MARGIN_MS: i64 = 5 * 60_000;

/// Which credential a setting refers to: a hash, never the token itself.
pub fn credential_tag(token: &str) -> String {
    let d = Sha256::digest(token.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn not_deleted_message(reason: Option<&Said>, err: &Said) -> Said {
    with_reason(
        reason,
        Said::compose(
            "本机保存的旧登录凭据没能删除（{e}），它可能还留在钥匙串里。App 不会再用它自动登录；你可以直接重新登录（会覆盖它），或在「钥匙串访问」里搜「Cavil Loop」手动删除",
            &[("e", err)],
        ),
    )
}

/// GitHub#471: "<reason>。<rest>" — a sign-out's reason in front of what else went wrong
fn with_reason(reason: Option<&Said>, rest: Said) -> Said {
    match reason {
        Some(r) => Said::compose("{reason}。{rest}", &[("reason", r), ("rest", &rest)]),
        None => rest,
    }
}

/// "<a>；<b>": two messages one after the other
fn and_then(a: &Said, b: &Said) -> Said {
    Said::compose("{a}；{b}", &[("a", a), ("b", b)])
}

pub struct Deps {
    pub store: Arc<Store>,
    pub credentials: Arc<dyn CredentialStore>,
    pub clock: Arc<dyn Clock>,
    pub opener: Arc<dyn Opener>,
    pub endpoints: Endpoints,
    /// the local cavil-loop daemon (GitHub#314)
    pub daemon: Arc<crate::daemon::Daemon>,
    /// daemons on other machines, over Tailscale (GitHub#387)
    pub remote: Arc<crate::remote::Remote>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fresh {
    Ok,
    Unreachable,
    Ended,
    Failed,
}

impl Fresh {
    fn as_str(self) -> &'static str {
        match self {
            Fresh::Ok => "ok",
            Fresh::Unreachable => "unreachable",
            Fresh::Ended => "ended",
            Fresh::Failed => "failed",
        }
    }
}

/// What a refresh did, for every caller that waited on it.
#[derive(Clone, Debug)]
pub struct FreshOut {
    pub result: Fresh,
    /// None = leave the shown problem as it is; Some(None) = clear it; Some(Some(m)) = show m
    pub problem: Option<Option<Said>>,
    /// the refresh ended the sign-in (session after the sign-out, reason)
    pub signed_out: Option<(u64, Said)>,
    /// why GitHub could not be used (set with `Unreachable` only): shown with "offline" (GitHub#270)
    pub reason: Option<String>,
}

impl FreshOut {
    fn of(result: Fresh) -> FreshOut {
        FreshOut { result, problem: None, signed_out: None, reason: None }
    }
}

type SharedFresh = Shared<BoxFuture<'static, FreshOut>>;
/// a queued keychain delete: None = done, Some(message) = failed, what to tell the user
type SharedDone = Shared<BoxFuture<'static, Option<Said>>>;

struct State {
    /// the signed-in credential (None = signed out)
    grant: Option<TokenGrant>,
    /// bumps whenever `grant` changes: "is this still the token the round started with?"
    gen: u64,
    /// bumps on every login / logout: anything started in another session is dropped
    session: u64,
    login_run: u64,
    pending_code: Option<(u64, String, DeviceCode)>,
    /// the grant in use was refreshed but could not be written to the credential store
    unsaved_grant: bool,
    unsaved_problem: Option<Said>,
    /// GitHub login the cached snapshots belong to (None = nobody: the cache must be empty)
    owner: Option<String>,
    /// the one refresh in flight: GitHub rotates refresh tokens, a second refresh with the same one would fail
    refreshing: Option<(u64, SharedFresh)>,
    refresh_seq: u64,
    /// keychain deletes queued by sign-outs, by the session they ended
    logouts: HashMap<u64, SharedDone>,
    /// the login attempt the current sign-in came from (a cancel of that attempt signs it out)
    committed_run: Option<u64>,
}

pub struct Engine {
    d: Deps,
    st: Mutex<State>,
    /// every credential write / delete runs here, one after another, in call order
    queue: Mutex<Shared<BoxFuture<'static, ()>>>,
}

pub enum StartOut {
    Login { reason: Option<Said>, wiped: bool },
    Ready { session: u64, wiped: bool },
}

pub enum BeginOut {
    Waiting { run: u64, user_code: String, verification_uri: String },
    /// `detail`: the outside text the explanation is about (GitHub#471), shown as is
    Failed { status: &'static str, said: Said },
    Stale,
}

#[derive(Clone)]
pub enum FinishOut {
    Ok { session: u64, viewer: Option<String>, wiped: bool },
    Failed { status: &'static str, said: Said },
    /// cancelled / signed out / a newer login meanwhile: whoever did that already said so
    Stale { login_reason: Option<Said> },
}

impl Engine {
    pub fn new(d: Deps) -> Arc<Engine> {
        let owner = d.store.get_str(CACHE_OWNER);
        let ready: BoxFuture<'static, ()> = async {}.boxed();
        let e = Arc::new(Engine {
            d,
            st: Mutex::new(State {
                grant: None,
                gen: 0,
                session: 0,
                login_run: 0,
                pending_code: None,
                unsaved_grant: false,
                unsaved_problem: None,
                owner,
                refreshing: None,
                refresh_seq: 0,
                logouts: HashMap::new(),
                committed_run: None,
            }),
            queue: Mutex::new(ready.shared()),
        });
        // A cache nobody owns cannot be shown to anybody. If dropping it fails, it is still
        // never handed to the window (see `visible_snapshots`); the next start tries again.
        if e.lock().owner.is_none() && e.d.store.snapshot_count() > 0 {
            if let Err(err) = e.d.store.write_all(&[], true) {
                eprintln!("cavil: dropping an ownerless cache failed: {err}");
            }
        }
        e
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn daemon(&self) -> &crate::daemon::Daemon {
        &self.d.daemon
    }

    pub fn remote(&self) -> &crate::remote::Remote {
        &self.d.remote
    }

    /// the same, for work that outlives one request ("接上 daemon" runs in the background, GitHub#315)
    pub fn daemon_arc(&self) -> Arc<crate::daemon::Daemon> {
        self.d.daemon.clone()
    }

    pub fn endpoints(&self) -> &Endpoints {
        &self.d.endpoints
    }

    pub fn persistent(&self) -> bool {
        self.d.credentials.persistent()
    }

    pub fn session(&self) -> u64 {
        self.lock().session
    }

    /// Run `f` after every credential operation queued before it (whatever their outcome).
    /// Queued at call time, run even if nobody awaits the result.
    fn serial<T: Clone + Send + Sync + 'static>(self: &Arc<Self>, f: BoxFuture<'static, T>) -> Shared<BoxFuture<'static, T>> {
        let mut q = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        let prev = q.clone();
        let job: Shared<BoxFuture<'static, T>> = async move {
            prev.await;
            f.await
        }
        .boxed()
        .shared();
        let done = job.clone();
        let tail: BoxFuture<'static, ()> = async move {
            done.await;
        }
        .boxed();
        let tail = tail.shared();
        *q = tail.clone();
        tokio::spawn(tail);
        job
    }

    fn set_trusted(&self, tokens: &[&str]) -> Result<(), StoreError> {
        let tags: Vec<Value> = tokens.iter().map(|t| Value::String(credential_tag(t))).collect();
        self.d.store.set_setting(TRUSTED, &Value::Array(tags))
    }

    fn trusted(&self) -> Vec<String> {
        match self.d.store.get_setting(TRUSTED) {
            Some(Value::Array(a)) => a.into_iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            _ => vec![],
        }
    }

    /// The cache may only hold data read by `login`; another (or unknown) account wipes it first.
    /// Ok(true) = wiped. Err = the database refused: nothing about the account change is
    /// certain on disk, so the caller must not let data land or be shown on its strength.
    fn adopt_account(&self, st: &mut State, login: Option<&str>, token: Option<&str>) -> Result<bool, StoreError> {
        let tag = match (login, token) {
            (Some(_), Some(t)) => Value::String(credential_tag(t)),
            _ => Value::Null,
        };
        // GitHub#266: a known account's login is written here, under the caller's state lock and
        // session check, in the same transaction as the binding — never by the window
        let viewer = login.map(|l| (VIEWER, Value::String(l.to_string())));
        if login.is_some() && login.map(str::to_string) == st.owner {
            let mut w = vec![(CACHE_CREDENTIAL, tag)];
            w.extend(viewer);
            self.d.store.write_all(&w, false)?;
            return Ok(false);
        }
        let owner = login.map(|l| Value::String(l.to_string())).unwrap_or(Value::Null);
        // one transaction: the old account's data goes, the new owner and credential binding come
        let mut w = vec![(CACHE_OWNER, owner), (CACHE_CREDENTIAL, tag)];
        w.extend(viewer);
        self.d.store.write_all(&w, true)?;
        st.owner = login.map(str::to_string);
        Ok(true)
    }

    /// What the window may show from disk: nothing unless the cache has an owner.
    pub fn visible_snapshots(&self) -> Vec<Value> {
        if self.lock().owner.is_none() {
            return vec![];
        }
        self.d.store.load_snapshots()
    }

    /// Delete the stored credential. Never fails: the error is returned for the caller to show.
    async fn clear_stored(creds: Arc<dyn CredentialStore>) -> Option<Said> {
        creds.clear().await.err()
    }

    // ---- start -------------------------------------------------------------

    pub async fn start(self: &Arc<Self>) -> StartOut {
        let raw = match self.d.credentials.get().await {
            Ok(v) => v,
            // keychain unreadable: not "signed out" (nothing is deleted), just cannot use it now
            Err(e) => return StartOut::Login { reason: Some(Said::compose("读取本机保存的登录凭据失败（{e}），请重新登录", &[("e", &e)])), wiped: false },
        };
        let Some(stored) = decode_grant(raw.as_deref()) else {
            return StartOut::Login { reason: None, wiped: false };
        };
        let tag = credential_tag(&stored.access_token);
        // The sign-out marker (written when a sign-out could not clear the trust list in
        // the database) outranks the list: nothing stored is trusted while it exists.
        let marked = self.d.store.signed_out_marked();
        if marked || !self.trusted().contains(&tag) {
            // A leftover the user signed out of (or a login that never completed, or a
            // credential put there from outside): never sign in with it, show nothing
            // cached for it. Delete it now; say so if that fails again.
            let wipe = {
                let mut st = self.lock();
                self.adopt_account(&mut st, None, None)
            };
            let creds = self.d.credentials.clone();
            let err = self.serial(async move { Engine::clear_stored(creds).await }.boxed()).await;
            // the marker goes only once nothing is trusted on disk and the credential is gone
            if marked && err.is_none() && self.set_trusted(&[]).is_ok() {
                if let Err(e) = self.d.store.clear_signed_out_mark() {
                    eprintln!("cavil: removing the sign-out marker failed (next start asks to sign in again): {e}");
                }
            }
            let mut reason = err.map(|e| not_deleted_message(None, &e));
            if let Err(e) = wipe {
                let wiped = Said::compose("本地缓存没能清空（{e}）", &[("e", &e.said())]);
                reason = Some(match reason {
                    Some(r) => and_then(&r, &wiped),
                    None => wiped,
                });
            }
            return StartOut::Login { reason, wiped: true };
        }
        let mut st = self.lock();
        // A credential the cache was not read with (changed outside the app) means
        // the account is unknown until GitHub answers: show nothing cached meanwhile.
        let mut wiped = false;
        if self.d.store.get_str(CACHE_CREDENTIAL).as_deref() != Some(tag.as_str()) {
            match self.adopt_account(&mut st, None, None) {
                Ok(w) => wiped = w,
                // another account's data may still be on disk: do not sign in on top of it
                Err(e) => {
                    return StartOut::Login {
                        reason: Some(Said::compose("本地缓存没能清空（{e}），为免显示别的账号的数据，这次没有自动登录；可以重新登录", &[("e", &e.said())])),
                        wiped: true,
                    }
                }
            }
        }
        st.grant = Some(stored);
        st.gen += 1;
        StartOut::Ready { session: st.session, wiped }
    }

    // ---- login -------------------------------------------------------------

    /// Every login attempt (and every cancel) bumps the run: an older attempt can no longer land.
    /// `run`: the attempt the window means. If that attempt already committed (its "signed in"
    /// was on the way when the user cancelled), it is signed out here: a cancelled login never
    /// survives, whatever the window manages to do afterwards. Returns that sign-out.
    pub fn cancel_login(self: &Arc<Self>, run: Option<u64>) -> Option<(u64, Option<Said>)> {
        let committed = {
            let mut st = self.lock();
            st.login_run += 1;
            st.pending_code = None;
            run.is_some() && st.committed_run == run && st.grant.is_some()
        };
        committed.then(|| self.logout(Some(&tr("登录已取消", &[]))))
    }

    pub async fn login_begin(self: &Arc<Self>, client_id: &str) -> BeginOut {
        let run = {
            let mut st = self.lock();
            st.login_run += 1;
            st.pending_code = None;
            st.login_run
        };
        match device::request_device_code(&self.d.endpoints, client_id, self.d.clock.as_ref()).await {
            Err(e) => {
                if run != self.lock().login_run {
                    return BeginOut::Stale;
                }
                BeginOut::Failed { status: failure_status(e.reason), said: e.said() }
            }
            Ok(code) => {
                let mut st = self.lock();
                if run != st.login_run {
                    return BeginOut::Stale;
                }
                let out = BeginOut::Waiting { run, user_code: code.user_code.clone(), verification_uri: code.verification_uri.clone() };
                st.pending_code = Some((run, client_id.to_string(), code));
                out
            }
        }
    }

    pub fn verification_uri(&self) -> Option<String> {
        self.lock().pending_code.as_ref().map(|(_, _, c)| c.verification_uri.clone())
    }

    pub async fn login_finish(self: &Arc<Self>, run: u64) -> FinishOut {
        let Some((client_id, code)) = ({
            let st = self.lock();
            match &st.pending_code {
                Some((r, id, c)) if *r == run && st.login_run == run => Some((id.clone(), c.clone())),
                _ => None,
            }
        }) else {
            return FinishOut::Stale { login_reason: None };
        };
        let me = self.clone();
        let cancelled = move || me.lock().login_run != run;
        let grant = match device::poll_for_token(&self.d.endpoints, &client_id, &code, self.d.clock.as_ref(), &cancelled).await {
            Ok(g) => g,
            Err(e) => {
                if run != self.lock().login_run || e.reason == Failure::Cancelled {
                    return FinishOut::Stale { login_reason: None };
                }
                return FinishOut::Failed { status: failure_status(e.reason), said: e.said() };
            }
        };
        // Who is this? Asked with the token in memory only: nothing is persisted
        // until the very last step. Unknown (query failed) is never "the same account".
        let login = self.viewer_login(&grant.access_token).await;
        if run != self.lock().login_run {
            return FinishOut::Stale { login_reason: None };
        }
        // Persist and switch to "signed in" as one step of the credential queue.
        // A cancel / sign-out / newer login that happens while the keychain write
        // is in progress makes this login stale: the token it just wrote is
        // removed in the same step, before anything queued after it (a newer
        // login's write, a sign-out) runs — so it can neither survive nor delete
        // somebody else's credential.
        let me = self.clone();
        let job = async move {
            if run != me.lock().login_run {
                return Ok::<FinishOut, Said>(FinishOut::Stale { login_reason: None });
            }
            // nothing stored is trusted while the new credential is being written
            // (as before: only the database's / the keychain's own words)
            me.set_trusted(&[]).map_err(|e| e.said())?;
            me.d.credentials.set(&encode_grant(&grant)).await?;
            // The decision and everything it records happen under the state lock, the same
            // lock a cancel or sign-out takes first: either this login commits before them (and
            // a cancel of it then signs it out), or they win and nothing of it is recorded.
            // Everything recorded goes in one transaction: the trust, the app it came from (a
            // GitHub App token is refreshed with that app, whatever the setting says later),
            // whose cache this is (another account's data goes), the viewer.
            // Err: the outside text of what refused (the database's or the keychain's own words)
            let outcome: Result<FinishOut, StoreError> = {
                let mut st = me.lock();
                if run != st.login_run {
                    Ok(FinishOut::Stale { login_reason: None })
                } else {
                    let tag = Value::String(credential_tag(&grant.access_token));
                    let same_owner = login.is_some() && login == st.owner;
                    let owner = login.clone().map(Value::String).unwrap_or(Value::Null);
                    let viewer = owner.clone();
                    match me.d.store.write_all(
                        &[
                            (TRUSTED, Value::Array(vec![tag.clone()])),
                            (GRANT_CLIENT_ID, Value::String(client_id.clone())),
                            (CACHE_OWNER, owner),
                            (CACHE_CREDENTIAL, if login.is_some() { tag } else { Value::Null }),
                            (VIEWER, viewer),
                        ],
                        !same_owner,
                    ) {
                        Err(e) => Err(e),
                        Ok(()) => {
                            // a sign-out marker from before is superseded by this trusted sign-in (if it
                            // cannot be removed, the next start only asks to sign in again: the safe direction)
                            if let Err(e) = me.d.store.clear_signed_out_mark() {
                                eprintln!("cavil: removing the sign-out marker failed: {e}");
                            }
                            st.session += 1;
                            st.grant = Some(grant.clone());
                            st.gen += 1;
                            st.pending_code = None;
                            st.unsaved_grant = false;
                            st.owner = login.clone();
                            st.committed_run = Some(run);
                            Ok(FinishOut::Ok { session: st.session, viewer: login.clone(), wiped: !same_owner })
                        }
                    }
                }
            };
            match outcome {
                Ok(FinishOut::Stale { .. }) => {
                    // cancelled / signed out / a newer login while the keychain write was on its way:
                    // the token this login wrote goes again
                    let err = Engine::clear_stored(me.d.credentials.clone()).await;
                    let cancelled = Said::plain(tr("登录已取消", &[]));
                    Ok(FinishOut::Stale { login_reason: err.map(|e| not_deleted_message(Some(&cancelled), &e)) })
                }
                Ok(out) => Ok(out),
                // the database refused: the credential just written is removed again, no half sign-in
                Err(e) => {
                    let left = Engine::clear_stored(me.d.credentials.clone()).await;
                    Err(match left {
                        None => Said::compose("登录没能保存到本机（{e}），已撤销这次登录，请重试", &[("e", &e.said())]),
                        Some(d) => not_deleted_message(Some(&Said::compose("登录没能保存到本机（{e}）", &[("e", &e.said())])), &d),
                    })
                }
            }
        };
        match self.serial(job.boxed()).await {
            Ok(out) => out,
            Err(said) => {
                if run != self.lock().login_run {
                    return FinishOut::Stale { login_reason: None };
                }
                FinishOut::Failed { status: "error", said }
            }
        }
    }

    async fn viewer_login(&self, token: &str) -> Option<String> {
        let body = json!({ "query": "query CavilViewer { viewer { login } }", "variables": {} }).to_string();
        let res = http::send(HttpRequest {
            method: "POST".into(),
            url: format!("{}/graphql", self.d.endpoints.api),
            headers: api_headers(token, &[("Content-Type".into(), "application/json".into())]),
            body: Some(body),
        })
        .await
        .ok()?;
        if res.status != 200 {
            return None;
        }
        let v: Value = serde_json::from_str(&res.body).ok()?;
        v.pointer("/data/viewer/login").and_then(|l| l.as_str()).map(str::to_string)
    }

    // ---- sign out ----------------------------------------------------------

    /// Sign out. Returns once nothing on disk trusts the credential any more and
    /// the cache is gone; the keychain delete is queued (see `logout_result`).
    /// Returns the new session and, when the sign-out could not be made fully durable,
    /// what to tell the user right away (it is never reported as a clean success then).
    pub fn logout(self: &Arc<Self>, reason: Option<&str>) -> (u64, Option<Said>) {
        // the reason is the client's own words, already in the window's language
        let reason: Option<Said> = reason.map(|r| Said::plain(r.to_string()));
        let (session, durable) = {
            let mut st = self.lock();
            st.login_run += 1;
            st.session += 1;
            st.grant = None;
            st.gen += 1;
            st.pending_code = None;
            st.unsaved_grant = false;
            st.owner = None;
            st.committed_run = None;
            // First of all, durably: the stored credential may never sign us in again,
            // whatever happens to the keychain delete below (queued, pending, failing,
            // or the process ending before it returns). Signing out forgets everything
            // read with that account — in the same transaction.
            let write = || {
                self.d.store.write_all(
                    &[(TRUSTED, Value::Array(vec![])), (CACHE_OWNER, Value::Null), (CACHE_CREDENTIAL, Value::Null), (VIEWER, Value::Null)],
                    true,
                )
            };
            // If the database refuses (twice), the revocation goes to the sign-out marker
            // instead — an independent file start-up honours before the trust list.
            let durable = match write().or_else(|_| write()) {
                Ok(()) => Durable::Yes,
                Err(db) => match self.d.store.mark_signed_out() {
                    Ok(()) => Durable::Marker(db),
                    Err(m) => Durable::No(db, m),
                },
            };
            (st.session, durable)
        };
        let now_message = match &durable {
            Durable::Yes => None,
            Durable::Marker(db) => Some(with_reason(
                reason.as_ref(),
                Said::compose("退出时本地数据库写入失败（{db}），已改用备用标记确保下次启动不会自动登录", &[("db", &db.said())]),
            )),
            Durable::No(db, m) => Some(with_reason(
                reason.as_ref(),
                Said::compose(
                    "退出没能保存到本机（数据库：{db}；备用标记：{m}）。正在删除钥匙串里的凭据；删除成功前关掉 App，下次启动可能会自动登录回去",
                    &[("db", &db.said()), ("m", &m.said())],
                ),
            )),
        };
        let creds = self.d.credentials.clone();
        let undurable = matches!(durable, Durable::No(..));
        // what is still worth saying once the delete is over, whatever it did
        let note = if matches!(durable, Durable::Marker(_)) { now_message.clone() } else { None };
        let done = self.serial(
            async move {
                match Engine::clear_stored(creds).await {
                    None => note,
                    // nothing on disk says "signed out" and the credential is still there
                    Some(e) if undurable => Some(with_reason(
                        reason.as_ref(),
                        Said::compose(
                            "退出没能保存到本机，钥匙串里的凭据也没能删除（{e}）。下次启动可能会自动登录回去：请在「钥匙串访问」里搜「Cavil Loop」手动删除",
                            &[("e", &e)],
                        ),
                    )),
                    Some(e) => Some(match &note {
                        Some(n) => and_then(n, &not_deleted_message(None, &e)),
                        None => not_deleted_message(reason.as_ref(), &e),
                    }),
                }
            }
            .boxed(),
        );
        let mut st = self.lock();
        st.logouts.retain(|s, _| *s + 16 > session);
        st.logouts.insert(session, done);
        (session, now_message)
    }

    /// The keychain delete of the sign-out that ended in `session`: what to tell the user when it failed.
    pub async fn logout_result(&self, session: u64) -> (Option<Said>, bool) {
        let fut = self.lock().logouts.get(&session).cloned();
        let err = match fut {
            Some(f) => f.await,
            None => None,
        };
        let current = self.lock().session == session;
        (err, current)
    }

    // ---- refresh -----------------------------------------------------------

    /// Make sure the access token is usable (GitHub App tokens expire after 8 h).
    /// `force` refreshes even before the deadline (GitHub said 401).
    ///
    /// Every way a refresh can go, and what it leaves behind:
    ///   not needed (no refresh token / not due)        → ok
    ///   refresh token past its own deadline            → ended: signed out with the reason
    ///   no answer, 5xx, 429 (whatever the body says)   → unreachable: keep everything, next round retries
    ///   GitHub says bad_refresh_token                  → ended: signed out with the reason
    ///   any other error / unparseable / no token       → failed: keep everything, tell the user, next round retries
    ///   new token, but saving it fails                 → ok: GitHub already retired the old refresh token, so the
    ///                                                    new grant stays in memory, the user is told, every later
    ///                                                    round retries the save (see save_unsaved)
    ///   signed out / new login before or during save   → ended: the newer action wins, nothing of this refresh lands
    /// Single-flight: concurrent callers share one refresh (refresh tokens rotate).
    pub async fn ensure_fresh(self: &Arc<Self>, force: bool, client_id_fallback: &str) -> FreshOut {
        let now = self.d.clock.now().await;
        let (used, session, existing) = {
            let st = self.lock();
            (st.grant.clone(), st.session, st.refreshing.clone())
        };
        let Some(used) = used else { return FreshOut::of(Fresh::Ok) };
        if used.refresh_token.is_none() {
            return FreshOut::of(Fresh::Ok);
        }
        if !force && used.expires_at.map(|e| e - now > REFRESH_MARGIN_MS).unwrap_or(true) {
            return FreshOut::of(Fresh::Ok);
        }
        if let Some((_, f)) = existing {
            return f.await;
        }
        let me = self.clone();
        let fallback = client_id_fallback.to_string();
        let run: BoxFuture<'static, FreshOut> = async move { me.refresh_once(used, session, now, fallback).await }.boxed();
        let shared = run.shared();
        let joined: Result<u64, SharedFresh> = {
            let mut st = self.lock();
            match st.refreshing.clone() {
                Some((_, f)) => Err(f),
                None => {
                    st.refresh_seq += 1;
                    st.refreshing = Some((st.refresh_seq, shared.clone()));
                    Ok(st.refresh_seq)
                }
            }
        };
        let id = match joined {
            Ok(id) => id,
            Err(f) => return f.await,
        };
        let out = shared.await;
        let mut st = self.lock();
        if st.refreshing.as_ref().map(|(i, _)| *i) == Some(id) {
            st.refreshing = None;
        }
        out
    }

    async fn refresh_once(self: Arc<Self>, used: TokenGrant, session: u64, now: i64, fallback: String) -> FreshOut {
        let still = {
            let used = used.clone();
            move |st: &State| st.session == session && st.grant.as_ref() == Some(&used)
        };
        let current = {
            let still = still.clone();
            move |me: &Engine| still(&me.lock())
        };
        if let Some(rexp) = used.refresh_expires_at {
            if now >= rexp {
                return self.sign_out_from_refresh(current(&self));
            }
        }
        let client_id = self.d.store.get_str(GRANT_CLIENT_ID).filter(|s| !s.is_empty()).unwrap_or(fallback);
        let refresh = used.refresh_token.clone().unwrap_or_default();
        let next = match device::refresh_grant(&self.d.endpoints, &client_id, &refresh, self.d.clock.as_ref()).await {
            Ok(g) => g,
            Err(e) => {
                return match e.reason {
                    Failure::Expired => self.sign_out_from_refresh(current(&self)),
                    Failure::Unreachable => FreshOut { reason: Some(e.full()), ..FreshOut::of(Fresh::Unreachable) },
                    _ => FreshOut {
                        result: Fresh::Failed,
                        problem: current(&self).then(|| {
                            Some(Said::compose("登录续期没有成功（{e}），会在下一轮自动重试；一直失败的话请退出后重新登录", &[("e", &e.said())]))
                        }),
                        signed_out: None,
                        reason: None,
                    },
                };
            }
        };
        // Store + switch as one step of the credential queue, like a login: a
        // sign-out / new login meanwhile wins, and anything queued after (a
        // sign-out's delete, a newer login's write) runs after this write.
        let me = self.clone();
        let job = async move {
            // While writing, either the old or the new one may be what ends up stored. Trust is
            // only ever added under the state lock together with the "still current" check: a
            // sign-out cannot slip in between and have its empty list overwritten. If the
            // database refuses, only the old one stays trusted: a restart may ask to sign in
            // again (never the reverse), and the user is told.
            let mut db_problem = {
                let st = me.lock();
                if !still(&st) {
                    return FreshOut::of(Fresh::Ended);
                }
                me.set_trusted(&[&used.access_token, &next.access_token]).err()
            };
            let saved = match me.d.credentials.set(&encode_grant(&next)).await {
                Ok(()) => true,
                Err(e) => {
                    me.lock().unsaved_problem = Some(e);
                    false
                }
            };
            // GitHub has rotated the refresh token: only `next` works from now on,
            // saved or not. Keep using it; an unsaved grant is retried every round.
            // Check and switch under one lock (see above).
            let mut st = me.lock();
            if !still(&st) {
                return FreshOut::of(Fresh::Ended);
            }
            st.grant = Some(next.clone());
            st.gen += 1;
            st.unsaved_grant = !saved;
            // saved: only the new one; not saved: the store still holds the old one (spent at
            // GitHub, so using it later just ends in "please sign in again") and the retry may store the new
            if saved && db_problem.is_none() {
                db_problem = me.set_trusted(&[&next.access_token]).err();
            }
            // same account, new token: the cache stays bound to it
            if st.owner.is_some() && saved {
                if let Err(e) = me.d.store.set_setting(CACHE_CREDENTIAL, &Value::String(credential_tag(&next.access_token))) {
                    db_problem.get_or_insert(e);
                }
            }
            let problem = if !saved {
                Some(unsaved_message(st.unsaved_problem.as_ref()))
            } else {
                db_problem.map(db_problem_message)
            };
            FreshOut { result: Fresh::Ok, problem: Some(problem), signed_out: None, reason: None }
        };
        self.serial(job.boxed()).await
    }

    fn sign_out_from_refresh(self: &Arc<Self>, current: bool) -> FreshOut {
        if !current {
            return FreshOut::of(Fresh::Ended);
        }
        let ended = reason_refresh_ended();
        let (session, message) = self.logout(Some(&ended));
        FreshOut { result: Fresh::Ended, problem: None, signed_out: Some((session, message.unwrap_or_else(|| Said::plain(ended.clone())))), reason: None }
    }

    /// A refreshed grant that could not be stored: try again (same queue and session rules as any credential write).
    pub async fn save_unsaved(self: &Arc<Self>) -> Option<Option<Said>> {
        let (grant, session) = {
            let st = self.lock();
            if !st.unsaved_grant {
                return None;
            }
            match &st.grant {
                Some(g) => (g.clone(), st.session),
                None => return None,
            }
        };
        let me = self.clone();
        let job = async move {
            let same = |me: &Engine| {
                let st = me.lock();
                st.session == session && st.grant.as_ref() == Some(&grant)
            };
            if !same(&me) || !me.lock().unsaved_grant {
                return None;
            }
            if let Err(e) = me.d.credentials.set(&encode_grant(&grant)).await {
                let mut st = me.lock();
                st.unsaved_problem = Some(e);
                return Some(Some(unsaved_message(st.unsaved_problem.as_ref())));
            }
            // check and record trust under one lock: a sign-out cannot slip in between
            let mut st = me.lock();
            if !(st.session == session && st.grant.as_ref() == Some(&grant)) {
                return None;
            }
            let mut db_problem = me.set_trusted(&[&grant.access_token]).err();
            st.unsaved_grant = false;
            if st.owner.is_some() {
                if let Err(e) = me.d.store.set_setting(CACHE_CREDENTIAL, &Value::String(credential_tag(&grant.access_token))) {
                    db_problem.get_or_insert(e);
                }
            }
            Some(db_problem.map(db_problem_message))
        };
        self.serial(job.boxed()).await
    }

    /// About the credential in use, without revealing it.
    pub async fn grant_info(&self) -> Value {
        let now = self.d.clock.now().await;
        // GitHub#395: which kind of application this sign-in went through — by the Client ID it was made
        // with (a GitHub App's starts with "Iv"), not by what the next sign-in is set to use. Only the kind crosses.
        let github_app = self.d.store.get_str(GRANT_CLIENT_ID).map(|id| id.starts_with("Iv")).unwrap_or(false);
        let st = self.lock();
        match &st.grant {
            None => json!({ "signedIn": false, "gen": st.gen, "session": st.session }),
            Some(g) => json!({
                "signedIn": true,
                "gen": st.gen,
                "session": st.session,
                "canRefresh": g.refresh_token.is_some(),
                "expired": g.expires_at.map(|e| now >= e).unwrap_or(false),
                "githubApp": github_app,
            }),
        }
    }

    pub fn gen(&self) -> u64 {
        self.lock().gen
    }

    // ---- the account the cache belongs to -----------------------------------

    /// GitHub said who the token belongs to. Data of anybody else goes first.
    /// Ok(None) = session over; Err = the database refused (nothing of the round may land).
    pub fn adopt_viewer(&self, session: u64, login: &str) -> Result<Option<bool>, StoreError> {
        let mut st = self.lock();
        if st.session != session {
            return Ok(None);
        }
        let Some(token) = st.grant.as_ref().map(|g| g.access_token.clone()) else { return Ok(None) };
        self.adopt_account(&mut st, Some(login), Some(&token)).map(Some)
    }

    /// Write snapshots read in `session`; refused (false) when that session is over.
    pub fn replace_snapshots(&self, session: u64, snaps: &[Value]) -> Result<bool, String> {
        let st = self.lock();
        if st.session != session || st.grant.is_none() {
            return Ok(false);
        }
        self.d.store.replace_snapshots(snaps)?;
        Ok(true)
    }

    pub fn store(&self) -> &Store {
        &self.d.store
    }

    pub fn public_settings(&self) -> serde_json::Map<String, Value> {
        self.d.store.all_settings().into_iter().filter(|(k, _)| !SECRET_KEYS.contains(&k.as_str())).collect()
    }

    // ---- requests on behalf of the window ------------------------------------

    /// Send one GitHub API request with the credential of `session`. The window
    /// never sees the credential: it names the session, this side adds the header.
    pub async fn request(&self, session: u64, req: HttpRequest) -> Result<http::HttpResponse, RequestError> {
        let token = {
            let st = self.lock();
            if st.session != session {
                return Err(RequestError::Stale);
            }
            match &st.grant {
                Some(g) => g.access_token.clone(),
                None => return Err(RequestError::Stale),
            }
        };
        if !http::under(&self.d.endpoints.api, &req.url) {
            return Err(RequestError::Refused(tr("拒绝发往 GitHub 接口以外的请求：{url}", &[("url", &req.url)])));
        }
        let method = req.method.to_ascii_uppercase();
        // HEAD: the change check before a sync read (GitHub#261) asks for headers only
        if !matches!(method.as_str(), "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE") {
            return Err(RequestError::Refused(tr("不支持的请求方法：{method}", &[("method", &method)])));
        }
        let extra: Vec<(String, String)> = req
            .headers
            .into_iter()
            .filter(|(k, _)| {
                let k = k.to_ascii_lowercase();
                k != "authorization" && k != "cookie" && k != "host"
            })
            .collect();
        http::send(HttpRequest { method, url: req.url, headers: api_headers(&token, &extra), body: req.body })
            .await
            .map_err(RequestError::Network)
    }

    /// GitHub#395: one release attachment image, fetched with the credential of `session` (see
    /// release_image.rs). The window gets the image or GitHub's answer — never the credential,
    /// never the signed address of the file.
    pub async fn release_image(&self, session: u64, asset_url: &str) -> Value {
        let token = {
            let st = self.lock();
            match &st.grant {
                Some(g) if st.session == session => g.access_token.clone(),
                _ => return json!({ "error": "stale", "message": tr("还没有登录", &[]) }),
            }
        };
        let out = crate::release_image::fetch(&self.d.endpoints, asset_url, api_headers(&token, &[])).await;
        // the account changed while the file was on its way: the answer belongs to nobody
        if self.lock().session != session {
            return json!({ "error": "stale", "message": tr("还没有登录", &[]) });
        }
        out
    }

    /// GitHub#401: GitHub's page for the application this sign-in went through, where each
    /// organisation's access is requested / granted: an OAuth app's own page, a GitHub App's
    /// authorisations, or (no sign-in recorded) the list of authorised OAuth apps. Built here from
    /// the Client ID the sign-in was made with — never from the one Settings holds for the next
    /// sign-in — so the window never sees that ID (it stays one of SECRET_KEYS).
    pub fn auth_page_url(&self) -> String {
        let web = self.d.endpoints.web.trim_end_matches('/');
        let signed_in = self.lock().grant.is_some();
        match self.d.store.get_str(GRANT_CLIENT_ID).filter(|id| signed_in && !id.is_empty()) {
            Some(id) if id.starts_with("Iv") => format!("{web}/settings/apps/authorizations"),
            Some(id) if id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') => {
                format!("{web}/settings/connections/applications/{id}")
            }
            _ => format!("{web}/settings/applications"),
        }
    }

    pub async fn open_external(&self, url: &str) -> Result<(), String> {
        if !is_allowed_external(url, &self.d.endpoints) {
            return Err(tr("不打开非 GitHub 链接：{url}", &[("url", url)]));
        }
        self.d.opener.open(url).await
    }
}

/// How durable a sign-out's revocation is.
enum Durable {
    /// the trust list is empty in the database
    Yes,
    /// the database refused; the sign-out marker holds it
    Marker(StoreError),
    /// neither could be written: (database error, marker error)
    No(StoreError, StoreError),
}

pub enum RequestError {
    Stale,
    Refused(String),
    Network(String),
}

fn failure_status(f: Failure) -> &'static str {
    match f {
        Failure::Denied => "denied",
        Failure::Expired => "expired",
        _ => "error",
    }
}

fn db_problem_message(e: StoreError) -> Said {
    Said::compose("本地数据库写入失败（{e}）。这次运行照常可用；下次启动可能需要重新登录，离线时可能看不到缓存", &[("e", &e.said())])
}

fn unsaved_message(problem: Option<&Said>) -> Said {
    let unknown = Said::plain(tr("未知错误", &[]));
    Said::compose(
        "新的登录凭据没能存进钥匙串（{e}）。这次运行照常可用，App 会每轮重试保存；在保存成功前退出 App，下次启动需要重新登录",
        &[("e", problem.unwrap_or(&unknown))],
    )
}

fn api_headers(token: &str, extra: &[(String, String)]) -> Vec<(String, String)> {
    let mut h: Vec<(String, String)> = vec![
        ("Authorization".into(), format!("Bearer {token}")),
        ("User-Agent".into(), "cavil-loop-client".into()),
        ("Accept".into(), "application/vnd.github+json".into()),
        ("X-GitHub-Api-Version".into(), "2022-11-28".into()),
    ];
    for (k, v) in extra {
        if let Some(slot) = h.iter_mut().find(|(hk, _)| hk.eq_ignore_ascii_case(k)) {
            slot.1 = v.clone();
        } else {
            h.push((k.clone(), v.clone()));
        }
    }
    h
}

/// GitHub's own image hosts (GitHub#205; a repo's raw files since GitHub#267): an image in the discussion links to itself, a click opens it.
/// The same list as GITHUB_IMAGE_HOSTS (src/shared/avatar.ts); exact hosts only.
pub const GITHUB_IMAGE_HOSTS: [&str; 4] = ["private-user-images.githubusercontent.com", "user-images.githubusercontent.com", "camo.githubusercontent.com", "raw.githubusercontent.com"];

/// Links the app may open in the system browser: GitHub (and its image hosts), plus — in test mode — the loopback fake's web side.
pub fn is_allowed_external(url: &str, endpoints: &Endpoints) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    if u.scheme() == "https" {
        if let Some(h) = u.host_str() {
            if h == "github.com" || h.ends_with(".github.com") || GITHUB_IMAGE_HOSTS.contains(&h) {
                return true;
            }
        }
    }
    http::is_loopback(url) && url::Url::parse(&endpoints.web).map(|w| w.origin() == u.origin()).unwrap_or(false)
}

impl FreshOut {
    pub fn to_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("result".into(), Value::String(self.result.as_str().into()));
        if let Some(p) = &self.problem {
            m.insert("problem".into(), p.as_ref().map(|s| Value::String(s.text())).unwrap_or(Value::Null));
            m.insert("problemSaid".into(), p.as_ref().map(Said::to_json).unwrap_or(Value::Null));
        }
        if let Some((s, r)) = &self.signed_out {
            m.insert("signedOut".into(), json!({ "session": s, "reason": r.text(), "reasonSaid": r.to_json() }));
        }
        if let Some(r) = &self.reason {
            m.insert("reason".into(), Value::String(r.clone()));
        }
        Value::Object(m)
    }
}
