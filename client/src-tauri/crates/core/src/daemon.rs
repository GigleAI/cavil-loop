// The local cavil-loop daemon (GitHub#314): check it, install it, list the
// projects connected to it, stop / start / disconnect one, update it.
//
// The window sends a handful of fixed requests (api.rs `daemon*`); everything
// that runs a program runs here. The rules:
//   - only the daemon's own scripts (GitHub#313: scripts/install-status.sh,
//     disconnect-project.sh, launchd-refresh.sh) plus fixed `git`, `systemctl`
//     and `launchctl` command lines, each argument checked first;
//   - every fact (where a project's config is, which scheduler unit it has,
//     what state it is in) comes from the status script, read again right
//     before acting — the window never names a path or a unit;
//   - a state the status script could not read ("unknown") never leads to
//     "start" or "stop": those would register a job twice or act blind;
//   - the child environment is built from a short allow-list, so nothing of
//     the client's (and never its GitHub credential, which is not in the
//     environment anyway) reaches the scripts; `gh` keeps its own sign-in;
//   - PATH: a macOS app starts with /usr/bin:/bin:/usr/sbin:/sbin, so take the
//     login shell's PATH and add the usual tool folders (compose_path);
//   - the network: `git clone` from the fixed GitHub URL, `git fetch` only
//     from a github.com remote.

use crate::i18n::{tr, Said};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// Where the daemon comes from (README "Install").
pub const CLONE_URL: &str = "https://github.com/GigleAI/cavil-loop.git";
/// What a GUI app gets on macOS when nothing else is known.
const FALLBACK_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
/// Tool folders added after the login shell's PATH (Homebrew on Apple silicon / Intel, user installs).
const EXTRA_PATH: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];
/// Environment variables a child keeps (everything else is dropped).
const KEEP_ENV: [&str; 9] = ["USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
/// Kept output per command, from the end (the last lines say what went wrong).
pub(crate) const OUTPUT_LIMIT: usize = 20_000;

pub(crate) const T_STATUS: Duration = Duration::from_secs(90);
pub(crate) const T_SHORT: Duration = Duration::from_secs(60);
pub(crate) const T_NET: Duration = Duration::from_secs(300);
/// launchd-refresh.sh waits up to 300 s for the project's poll lock
const T_REFRESH: Duration = Duration::from_secs(420);

#[derive(Clone, Debug)]
pub enum PathSource {
    /// the login shell's PATH plus EXTRA_PATH and ~/.local/bin
    Login,
    /// test mode: exactly this
    Fixed(String),
}

#[derive(Clone, Debug)]
pub struct Config {
    /// None: the feature is off (a test that did not set up a fake HOME)
    pub home: Option<PathBuf>,
    pub path: PathSource,
    pub clone_url: String,
    /// test mode: extra environment for the children (the fake scheduler's state folder)
    pub env: Vec<(String, String)>,
    /// test mode: remotes `git fetch` may use besides github.com (the local fake origin)
    pub extra_remotes: Vec<String>,
}

impl Config {
    pub fn off() -> Config {
        Config { home: None, path: PathSource::Login, clone_url: CLONE_URL.into(), env: vec![], extra_remotes: vec![] }
    }

    /// The app: the user's HOME and login PATH. Test mode (the suites only): a fake HOME, a fixed
    /// PATH, a local clone source and extra environment — or off when the test set no HOME.
    pub fn from_env(test_mode: bool, env: &std::collections::HashMap<String, String>) -> Config {
        if !test_mode {
            return Config { home: env.get("HOME").filter(|h| !h.is_empty()).map(PathBuf::from), ..Config::off() };
        }
        let (Some(home), Some(path)) = (env.get("CAVIL_CLIENT_TEST_DAEMON_HOME"), env.get("CAVIL_CLIENT_TEST_DAEMON_PATH")) else {
            return Config::off();
        };
        let extra: Vec<(String, String)> = env
            .get("CAVIL_CLIENT_TEST_DAEMON_ENV")
            .and_then(|j| serde_json::from_str::<serde_json::Map<String, Value>>(j).ok())
            .map(|m| m.into_iter().filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_string()))).collect())
            .unwrap_or_default();
        let clone = env.get("CAVIL_CLIENT_TEST_DAEMON_CLONE").cloned().unwrap_or_else(|| CLONE_URL.into());
        Config { home: Some(PathBuf::from(home)), path: PathSource::Fixed(path.clone()), clone_url: clone.clone(), env: extra, extra_remotes: vec![clone] }
    }
}

/// Hands a file to the system (log viewer / text editor). The app: `open` / `xdg-open`; the harness: the test.
#[async_trait]
pub trait FileOpener: Send + Sync {
    /// `what`: "log" or "config"
    async fn open_file(&self, path: &str, what: &str) -> Result<(), String>;
}

pub struct SystemFileOpener {
    /// test mode: append "<what> <path>" lines here instead of opening
    pub record: Option<PathBuf>,
}

#[async_trait]
impl FileOpener for SystemFileOpener {
    async fn open_file(&self, path: &str, what: &str) -> Result<(), String> {
        if let Some(f) = &self.record {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().create(true).append(true).open(f).map_err(|e| e.to_string())?;
            return writeln!(file, "{what} {path}").map_err(|e| e.to_string());
        }
        let mut cmd = if cfg!(target_os = "macos") {
            let mut c = std::process::Command::new("/usr/bin/open");
            // the config has no extension macOS knows: open it in the default text editor
            if what == "config" {
                c.arg("-t");
            }
            c
        } else {
            std::process::Command::new("xdg-open")
        };
        cmd.arg(path).spawn().map(|_| ()).map_err(|e| tr("打不开文件：{e}", &[("e", &e.to_string())]))
    }
}

/// A finished command.
#[derive(Debug, Clone)]
pub struct Out {
    /// None: killed (timeout) or did not start
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Out {
    pub(crate) fn ok(&self) -> bool {
        self.code == Some(0)
    }
    /// stdout then stderr, the end kept
    pub(crate) fn text(&self) -> String {
        let mut t = self.stdout.trim_end().to_string();
        let e = self.stderr.trim_end();
        if !e.is_empty() {
            if !t.is_empty() {
                t.push('\n');
            }
            t.push_str(e);
        }
        tail(&t, OUTPUT_LIMIT)
    }
    /// The outcome of a GitHub#313 script that ends with `RESULT=<word>`, as one string (the tests' view of
    /// `outcome_of`). No such line (killed, timed out, failed half-way) is "unconfirmed": what it changed is
    /// not known, so it is never mapped onto one of the script's own words.
    #[cfg(test)]
    pub(crate) fn outcome(&self) -> (String, String) {
        let (w, said) = outcome_of(self, None);
        (w, said.text())
    }

    /// the `RESULT=<word>` last line the GitHub#313 scripts print
    pub(crate) fn result_word(&self) -> Option<String> {
        let line = self.stdout.lines().rev().find(|l| !l.trim().is_empty())?;
        let w = line.trim().strip_prefix("RESULT=")?;
        w.bytes().all(|b| b.is_ascii_lowercase() || b == b'_').then(|| w.to_string()).filter(|w| !w.is_empty())
    }
}

/// GitHub#473: what a GitHub#313 script ended with, its words for the person — the script's own output
/// as is (from the daemon), or the client's note when it did not run (`note`).
fn outcome_of(out: &Out, note: Option<&Said>) -> (String, Said) {
    let shown = match note {
        Some(n) => n.clone(),
        None => Said::outside(&out.text(), "daemon"),
    };
    match out.result_word() {
        Some(w) => (w, shown),
        None => (
            "unconfirmed".into(),
            Said::compose(
                "脚本没有给出最终结果（{code}），中途可能已经改动了文件或后台任务，没有确认恢复。脚本输出：\n{out}",
                &[("code", &code_word(out.code)), ("out", &shown)],
            ),
        ),
    }
}

/// "退出码 1" / "没有正常结束"
pub(crate) fn code_word(code: Option<i32>) -> Said {
    Said::plain(match code {
        Some(c) => tr("退出码 {c}", &[("c", &c.to_string())]),
        None => tr("没有正常结束", &[]),
    })
}

/// outside text as one message part (GitHub#473)
pub(crate) fn outside(text: &str, from: &'static str) -> Said {
    Said::outside(text, from)
}

/// the client's own words, already in the window's language
pub(crate) fn plain(text: String) -> Said {
    Said::plain(text)
}

/// A command as it ran (Deref: everything an `Out` has), with the client's own note when it did not
/// run at all (not found, did not start, timed out): that note is the client's words, not the
/// program's, so it is never shown as the program's output.
pub(crate) struct Ran {
    pub out: Out,
    pub note: Option<Said>,
}

impl std::ops::Deref for Ran {
    type Target = Out;
    fn deref(&self) -> &Out {
        &self.out
    }
}

impl Ran {
    pub(crate) fn not_run(note: Said) -> Ran {
        Ran { out: Out { code: None, stdout: String::new(), stderr: note.text() }, note: Some(note) }
    }
    /// what it said: the program's output as is (marked as coming from `from`), or the client's note
    pub(crate) fn said(&self, from: &'static str) -> Said {
        match &self.note {
            Some(n) => n.clone(),
            None => Said::outside(&self.out.text(), from),
        }
    }
    pub(crate) fn outcome_said(&self) -> (String, Said) {
        outcome_of(&self.out, self.note.as_ref())
    }
}

/// `v` with `key` = the message as one string and `<key>Said` = the message with its outside parts marked
pub(crate) fn put_said(mut v: Value, key: &str, s: &Said) -> Value {
    v[key] = Value::String(s.text());
    v[format!("{key}Said")] = s.to_json();
    v
}

/// "找不到 git（PATH：…）"
pub(crate) fn not_found(program: &str, path: &str) -> Said {
    Said::compose("找不到 {program}（PATH：{path}）", &[("program", &plain(program.to_string())), ("path", &outside(path, "system"))])
}

/// "git 没能启动：<the system's words>"
pub(crate) fn not_started(program: &str, e: &str) -> Said {
    Said::compose("{program} 没能启动：{e}", &[("program", &plain(program.to_string())), ("e", &outside(e, "system"))])
}

/// "git 超过 60 秒没有结束，已停止"
pub(crate) fn timed_out(program: &str, limit: Duration) -> Said {
    Said::plain(tr("{program} 超过 {n} 秒没有结束，已停止", &[("program", program), ("n", &limit.as_secs().to_string())]))
}

pub(crate) fn tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut start = s.len() - n;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/// Login shell PATH + the usual tool folders, each once, in that order.
pub fn compose_path(login: &str, home: &Path) -> String {
    let local = home.join(".local/bin").to_string_lossy().to_string();
    let mut parts: Vec<String> = vec![];
    for p in login.split(':').map(str::to_string).chain(EXTRA_PATH.iter().map(|s| s.to_string())).chain([local]) {
        if !p.is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    }
    parts.join(":")
}

/// A project instance key as setup.sh accepts it (`^[A-Za-z0-9_.-]+$`, not "deploy").
pub fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 200 && k != "deploy" && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

/// A scheduler unit / label as the status script names it.
fn valid_unit(u: &str) -> bool {
    !u.is_empty() && u.len() <= 300 && !u.starts_with('-') && u.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-@".contains(&b))
}

/// `git fetch` may only reach github.com (or, in test mode, the configured local source).
pub fn github_remote(url: &str, extra: &[String]) -> bool {
    if extra.iter().any(|e| e == url) {
        return true;
    }
    if let Some(rest) = url.strip_prefix("git@github.com:") {
        return !rest.is_empty();
    }
    match url::Url::parse(url) {
        Ok(u) => matches!(u.scheme(), "https" | "ssh") && u.host_str() == Some("github.com"),
        Err(_) => false,
    }
}

pub struct Daemon {
    pub(crate) cfg: Config,
    opener: Arc<dyn FileOpener>,
    /// the system's folder picker (GitHub#315: "接上 daemon"); None: the dialog only takes a typed path
    pub(crate) picker: Option<Arc<dyn FolderPicker>>,
    /// one changing operation at a time (install, stop / start, disconnect, update, connect)
    pub(crate) busy: Arc<tokio::sync::Mutex<()>>,
    /// "接上 daemon" runs in the background; the window reads its output as it comes (GitHub#315)
    pub(crate) jobs: std::sync::Mutex<crate::daemon_connect::Jobs>,
}

/// Lets the person choose a folder (the app: Tauri's dialog plugin; the harness: the test).
#[async_trait]
pub trait FolderPicker: Send + Sync {
    /// None: the person cancelled
    async fn pick_folder(&self, start: Option<String>) -> Result<Option<String>, String>;
}

/// one changing operation at a time: the answer to a second one
pub(crate) fn busy() -> Said {
    Said::plain(tr("另一个 daemon 操作还没结束，等它结束再试", &[]))
}

impl Daemon {
    pub fn new(cfg: Config, opener: Arc<dyn FileOpener>) -> Daemon {
        Daemon { cfg, opener, picker: None, busy: Arc::new(tokio::sync::Mutex::new(())), jobs: std::sync::Mutex::new(Default::default()) }
    }

    pub fn with_picker(mut self, picker: Arc<dyn FolderPicker>) -> Daemon {
        self.picker = Some(picker);
        self
    }

    pub(crate) fn home(&self) -> Result<&Path, String> {
        self.home_s().map_err(|s| s.text())
    }

    pub(crate) fn home_s(&self) -> Result<&Path, Said> {
        self.cfg.home.as_deref().ok_or_else(|| Said::plain(tr("读不到本机用户目录（HOME），无法检查 daemon", &[])))
    }

    pub(crate) fn entry(&self) -> Result<PathBuf, String> {
        self.entry_s().map_err(|s| s.text())
    }

    /// The stable skill entry: the new name, else the one from before the rename (scripts/_names.sh cavil_pick).
    pub(crate) fn entry_s(&self) -> Result<PathBuf, Said> {
        let h = self.home_s()?;
        let new = h.join(".agents/skills/cavil-loop");
        let old = h.join(".agents/skills/coding-agent-work-loop");
        let there = |p: &Path| p.exists() || p.symlink_metadata().is_ok();
        Ok(if there(&new) || !there(&old) { new } else { old })
    }

    pub(crate) async fn path(&self) -> Result<String, String> {
        self.path_s().await.map_err(|s| s.text())
    }

    pub(crate) async fn path_s(&self) -> Result<String, Said> {
        let home = self.home_s()?.to_path_buf();
        Ok(match &self.cfg.path {
            PathSource::Fixed(p) => p.clone(),
            PathSource::Login => compose_path(&self.login_path(&home).await, &home),
        })
    }

    async fn login_path(&self, home: &Path) -> String {
        let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() });
        let current = std::env::var("PATH").unwrap_or_else(|_| FALLBACK_PATH.into());
        let mut c = tokio::process::Command::new(&shell);
        c.args(["-lc", "printf '\\n__CAVIL_PATH__%s\\n' \"$PATH\""]);
        self.prepare(&mut c, home, &current);
        c.stdin(std::process::Stdio::null());
        let out = tokio::time::timeout(Duration::from_secs(10), c.output()).await;
        if let Ok(Ok(o)) = out {
            let s = String::from_utf8_lossy(&o.stdout);
            if let Some(p) = s.lines().rev().find_map(|l| l.strip_prefix("__CAVIL_PATH__")) {
                if !p.trim().is_empty() {
                    return p.trim().to_string();
                }
            }
        }
        if current.trim().is_empty() {
            FALLBACK_PATH.into()
        } else {
            current
        }
    }

    /// The child's whole environment: the allow-list, HOME, PATH, no prompts.
    pub(crate) fn prepare(&self, c: &mut tokio::process::Command, home: &Path, path: &str) {
        c.env_clear();
        for k in KEEP_ENV {
            if let Ok(v) = std::env::var(k) {
                c.env(k, v);
            }
        }
        c.env("HOME", home).env("PATH", path).env("GIT_TERMINAL_PROMPT", "0");
        for (k, v) in &self.cfg.env {
            c.env(k, v);
        }
        c.kill_on_drop(true);
    }

    pub(crate) async fn run(&self, path: &str, program: &str, args: &[&str], limit: Duration) -> Out {
        self.run_input_s(path, program, args, None, limit).await.out
    }

    pub(crate) async fn run_s(&self, path: &str, program: &str, args: &[&str], limit: Duration) -> Ran {
        self.run_input_s(path, program, args, None, limit).await
    }

    /// `input`: what the child reads on standard input (None: nothing, /dev/null)
    pub(crate) async fn run_input_s(&self, path: &str, program: &str, args: &[&str], input: Option<&str>, limit: Duration) -> Ran {
        let home = match self.home_s() {
            Ok(h) => h.to_path_buf(),
            Err(e) => return Ran::not_run(e),
        };
        let Some(bin) = which(program, path) else {
            return Ran::not_run(not_found(program, path));
        };
        let mut c = tokio::process::Command::new(bin);
        c.args(args).current_dir(&home);
        c.stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() });
        c.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        self.prepare(&mut c, &home, path);
        let text = input.map(str::to_string);
        let work = async {
            let mut child = c.spawn()?;
            if let (Some(t), Some(mut stdin)) = (text, child.stdin.take()) {
                use tokio::io::AsyncWriteExt;
                // a child that exits without reading closes the pipe: its own output says why
                let _ = stdin.write_all(t.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
            child.wait_with_output().await
        };
        match tokio::time::timeout(limit, work).await {
            Ok(Ok(o)) => Ran { out: Out { code: o.status.code(), stdout: String::from_utf8_lossy(&o.stdout).into(), stderr: String::from_utf8_lossy(&o.stderr).into() }, note: None },
            Ok(Err(e)) => Ran::not_run(not_started(program, &e.to_string())),
            Err(_) => Ran::not_run(timed_out(program, limit)),
        }
    }

    /// One of the daemon's own scripts, by its fixed path under the skill entry.
    pub(crate) async fn script(&self, path: &str, name: &str, args: &[&str], limit: Duration) -> Out {
        self.script_input_s(path, name, args, None, limit).await.out
    }

    pub(crate) async fn script_s(&self, path: &str, name: &str, args: &[&str], limit: Duration) -> Ran {
        self.script_input_s(path, name, args, None, limit).await
    }

    pub(crate) async fn script_input_s(&self, path: &str, name: &str, args: &[&str], input: Option<&str>, limit: Duration) -> Ran {
        let file = match self.entry_s() {
            Ok(e) => e.join("scripts").join(name),
            Err(m) => return Ran::not_run(m),
        };
        let f = file.to_string_lossy().to_string();
        let mut all = vec![f.as_str()];
        all.extend_from_slice(args);
        self.run_input_s(path, "bash", &all, input, limit).await
    }

    // ── status ──

    /// `{state: "missing", entry}` / `{state: "unreadable", reason, entry}` / `{state: "ok", entry, status}`
    pub async fn status(&self) -> Value {
        let unreadable = |reason: &Said, entry: Value| put_said(json!({ "state": "unreadable", "entry": entry }), "reason", reason);
        let entry = match self.entry_s() {
            Ok(e) => e,
            Err(m) => return unreadable(&m, Value::Null),
        };
        let e = entry.to_string_lossy().to_string();
        if !entry.exists() && entry.symlink_metadata().is_err() {
            return json!({ "state": "missing", "entry": e });
        }
        if !entry.exists() {
            return unreadable(&Said::new("{e} 是一个指向不存在位置的链接", &[("e", &e)], "user"), json!(e));
        }
        let path = match self.path_s().await {
            Ok(p) => p,
            Err(m) => return unreadable(&m, json!(e)),
        };
        if !has_status_script(&entry) {
            // a daemon from before GitHub#313: say what kind of install it is, so a checkout can be updated from here (GitHub#320)
            let form = self.outdated_form(&entry, &path).await;
            let reason = Said::new("{e} 里没有状态脚本 scripts/install-status.sh：这份 daemon 版本太旧（早于 GitHub#313），客户端读不出它的状态", &[("e", &e)], "user");
            let mut v = unreadable(&reason, json!(e));
            v["outdated"] = form.to_json();
            return v;
        }
        let out = self.script_s(&path, "install-status.sh", &[], T_STATUS).await;
        match parse_status_s(&out) {
            Ok(st) => json!({ "state": "ok", "entry": e, "status": st }),
            Err(reason) => match parse_precheck(&out) {
                // the status script could only check the common tools (jq missing): show those, still unreadable
                Some(pre) => {
                    let said = out.stderr.trim();
                    let reason = if said.is_empty() { reason } else { outside(&tail(said, 2000), "daemon") };
                    let mut v = unreadable(&reason, json!(e));
                    v["precheck"] = pre;
                    v
                }
                None => unreadable(&reason, json!(e)),
            },
        }
    }

    pub(crate) async fn status_ok(&self, path: &str) -> Result<Value, String> {
        self.status_ok_s(path).await.map_err(|s| s.text())
    }

    pub(crate) async fn status_ok_s(&self, path: &str) -> Result<Value, Said> {
        let out = self.script_s(path, "install-status.sh", &[], T_STATUS).await;
        parse_status_s(&out).map_err(|r| Said::compose("读不到本机 daemon 状态，没有执行：{r}", &[("r", &r)]))
    }

    // ── install ──

    pub async fn install(&self) -> Value {
        let Ok(_g) = self.busy.try_lock() else { return refused_s(&busy()) };
        let entry = match self.entry_s() {
            Ok(e) => e,
            Err(m) => return refused_s(&m),
        };
        let failed = |m: &Said| put_said(json!({ "result": "failed" }), "output", m);
        if entry.exists() || entry.symlink_metadata().is_ok() {
            return put_said(json!({ "result": "existing", "entry": entry.to_string_lossy() }), "output", &plain(tr("本机已经装了 daemon，沿用现有的，什么都没动", &[])));
        }
        let home = match self.home_s() {
            Ok(h) => h.to_path_buf(),
            Err(m) => return refused_s(&m),
        };
        let path = match self.path_s().await {
            Ok(p) => p,
            Err(m) => return refused_s(&m),
        };
        let skills = entry.parent().unwrap_or(&home).to_path_buf();
        if let Err(e) = std::fs::create_dir_all(&skills) {
            return failed(&Said::compose("建不出目录 {d}：{e}", &[("d", &outside(&skills.to_string_lossy(), "user")), ("e", &outside(&e.to_string(), "system"))]));
        }
        // clone next to it, then rename: a clone that fails half-way never looks like an install
        let tmp = skills.join(format!(".cavil-loop.cloning-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let t = tmp.to_string_lossy().to_string();
        let out = self.run_s(&path, "git", &["clone", "--quiet", &self.cfg.clone_url, &t], T_NET).await;
        if !out.ok() {
            let _ = std::fs::remove_dir_all(&tmp);
            return failed(&Said::compose("从 {url} 克隆失败：\n{out}", &[("url", &plain(self.cfg.clone_url.clone())), ("out", &out.said("system"))]));
        }
        if let Err(e) = std::fs::rename(&tmp, &entry) {
            let _ = std::fs::remove_dir_all(&tmp);
            return failed(&Said::compose("克隆好了，但放不到 {d}：{e}", &[("d", &outside(&entry.to_string_lossy(), "user")), ("e", &outside(&e.to_string(), "system"))]));
        }
        let entry_s = entry.to_string_lossy().to_string();
        let mut lines = vec![Said::compose("已从 {url} 克隆到 {d}", &[("url", &plain(self.cfg.clone_url.clone())), ("d", &outside(&entry_s, "user"))])];
        // the Claude Code skill link, as in the README (an existing one is left alone)
        let link = home.join(".claude/skills/cavil-loop");
        let link_s = link.to_string_lossy().to_string();
        if link.symlink_metadata().is_ok() {
            lines.push(Said::new("{l} 已存在，没有改动", &[("l", &link_s)], "user"));
        } else {
            let made = std::fs::create_dir_all(home.join(".claude/skills")).and_then(|_| symlink(&entry, &link));
            match made {
                Ok(()) => lines.push(Said::new("已建软链 {l} → {d}", &[("l", &link_s), ("d", &entry_s)], "user")),
                Err(e) => lines.push(Said::compose(
                    "软链 {l} 没建成：{e}（只影响在 Claude Code 里直接用这个 skill，不影响 daemon）",
                    &[("l", &outside(&link_s, "user")), ("e", &outside(&e.to_string(), "system"))],
                )),
            }
        }
        put_said(json!({ "result": "installed", "entry": entry_s }), "output", &join_lines(&lines))
    }

    // ── one project: stop / start / disconnect / open ──

    /// `action`: "stop" | "start"
    pub async fn service(&self, key: &str, action: &str) -> Value {
        if !valid_key(key) {
            return refused_s(&bad_key());
        }
        if action != "stop" && action != "start" {
            return refused_s(&plain(tr("未知操作", &[])));
        }
        let Ok(_g) = self.busy.try_lock() else { return refused_s(&busy()) };
        let path = match self.path_s().await {
            Ok(p) => p,
            Err(m) => return refused_s(&m),
        };
        let st = match self.status_ok_s(&path).await {
            Ok(s) => s,
            Err(m) => return refused_s(&m),
        };
        let Some(p) = find_project(&st, key) else { return refused_s(&no_project(key)) };
        let sched = &p["scheduler"];
        let state = sched["state"].as_str().unwrap_or("unknown");
        let want_from = if action == "stop" { "running" } else { "stopped" };
        if state != want_from {
            let shown = match state {
                "running" => tr("在跑", &[]),
                "stopped" => tr("已停", &[]),
                _ => tr("读不到", &[]),
            };
            let act = if action == "stop" { tr("停", &[]) } else { tr("启", &[]) };
            return refused_s(&Said::compose(
                "{key} 现在的后台任务状态是「{shown}」，没有执行「{act}」",
                &[("key", &outside(key, "user")), ("shown", &plain(shown)), ("act", &plain(act))],
            ));
        }
        let unit = sched["unit"].as_str().unwrap_or("");
        let bad_unit = || refused_s(&plain(tr("状态脚本给出的后台任务名不合规，没有执行", &[])));
        if !valid_unit(unit) {
            return bad_unit();
        }
        let out = match sched["kind"].as_str() {
            Some("systemd") => {
                if !unit.ends_with(".timer") {
                    return bad_unit();
                }
                self.run_s(&path, "systemctl", &["--user", action, unit], T_SHORT).await
            }
            Some("launchd") => {
                let uid = self.run(&path, "id", &["-u"], T_SHORT).await;
                let uid = uid.stdout.trim().to_string();
                if uid.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) {
                    return refused_s(&plain(tr("读不到本机用户编号（id -u），没有执行", &[])));
                }
                if action == "stop" {
                    self.run_s(&path, "launchctl", &["bootout", &format!("gui/{uid}/{unit}")], T_SHORT).await
                } else {
                    let plist = p["scheduler"]["plist"].as_str().unwrap_or("");
                    let expect = match self.home_s() {
                        Ok(h) => h.join("Library/LaunchAgents").join(format!("{unit}.plist")),
                        Err(m) => return refused_s(&m),
                    };
                    if Path::new(plist) != expect || !expect.is_file() {
                        return refused_s(&Said::new("找不到 {key} 的后台任务配置文件 {f}，没有执行", &[("key", key), ("f", &expect.to_string_lossy())], "user"));
                    }
                    self.run_s(&path, "launchctl", &["bootstrap", &format!("gui/{uid}"), plist], T_SHORT).await
                }
            }
            _ => return refused_s(&plain(tr("认不出这台机器的后台任务管理器，没有执行", &[]))),
        };
        // read back: only the state the status script now reports counts
        let want = if action == "stop" { "stopped" } else { "running" };
        let after = self.status_ok(&path).await.ok();
        let now = after.as_ref().and_then(|s| find_project(s, key)).and_then(|p| p["scheduler"]["state"].as_str().map(str::to_string)).unwrap_or_else(|| "unknown".into());
        put_said(json!({ "result": if now == want { "ok" } else { "failed" }, "state": now }), "output", &out.said("system"))
    }

    pub async fn disconnect(&self, key: &str) -> Value {
        if !valid_key(key) {
            return refused_s(&bad_key());
        }
        let Ok(_g) = self.busy.try_lock() else { return refused_s(&busy()) };
        let path = match self.path_s().await {
            Ok(p) => p,
            Err(m) => return refused_s(&m),
        };
        let out = self.script_s(&path, "disconnect-project.sh", &[key], T_SHORT).await;
        let (result, output) = out.outcome_said();
        put_said(json!({ "result": result, "code": out.code }), "output", &output)
    }

    /// `what`: "log" (the project's poll.log) | "config" (its config file), both from the status script
    pub async fn open(&self, key: &str, what: &str) -> Value {
        if !valid_key(key) {
            return refused_s(&bad_key());
        }
        let path = match self.path_s().await {
            Ok(p) => p,
            Err(m) => return refused_s(&m),
        };
        let st = match self.status_ok_s(&path).await {
            Ok(s) => s,
            Err(m) => return refused_s(&m),
        };
        let Some(p) = find_project(&st, key) else { return refused_s(&no_project(key)) };
        let file = match what {
            "log" => p["state_dir"].as_str().map(|d| Path::new(d).join("poll.log")),
            "config" => p["config"].as_str().map(PathBuf::from),
            _ => return refused_s(&plain(tr("未知操作", &[]))),
        };
        let Some(file) = file.filter(|f| f.is_absolute()) else { return refused_s(&plain(tr("状态脚本没有给出这个文件的位置", &[]))) };
        if !file.is_file() {
            return refused_s(&Said::new("文件不存在：{f}", &[("f", &file.to_string_lossy())], "user"));
        }
        match self.opener.open_file(&file.to_string_lossy(), what).await {
            Ok(()) => json!({ "result": "ok", "path": file.to_string_lossy() }),
            // the opener words its own failure (the app: through tr(), the system's words inside)
            Err(m) => refused_s(&plain(m)),
        }
    }

    // ── update ──

    pub async fn update(&self) -> Value {
        let Ok(_g) = self.busy.try_lock() else { return refused_s(&busy()) };
        let path = match self.path_s().await {
            Ok(p) => p,
            Err(m) => return refused_s(&m),
        };
        let entry = match self.entry_s() {
            Ok(e) => e,
            Err(m) => return refused_s(&m),
        };
        // a daemon from before the status script (GitHub#320): judged again here, never taken from the window
        if entry.exists() && !has_status_script(&entry) {
            let dir = match self.outdated_form(&entry, &path).await {
                Form::Checkout(dir) => dir,
                other => return refused_s(&other.refusal()),
            };
            let d = dir.to_string_lossy().to_string();
            let (before, after, output) = match self.fast_forward(&path, &d).await {
                Ok(r) => r,
                Err(blocked) => return blocked,
            };
            if !has_status_script(&entry) {
                // pulled, but what it follows still has no status script (another branch, an old fork)
                let branch = self.run_s(&path, "git", &["-C", &d, "rev-parse", "--abbrev-ref", "HEAD"], T_SHORT).await;
                let branch = if branch.ok() { outside(branch.stdout.trim(), "system") } else { Said::compose("读不出（{e}）", &[("e", &branch.said("system"))]) };
                let v = json!({ "result": "still_old", "before": before, "after": after, "refresh": [] });
                return put_said(put_said(v, "branch", &branch), "output", &output);
            }
            let refresh = self.refresh_mac(&path).await;
            return put_said(json!({ "result": if before == after { "current" } else { "updated" }, "before": before, "after": after, "refresh": refresh }), "output", &output);
        }
        let st = match self.status_ok_s(&path).await {
            Ok(s) => s,
            Err(m) => return refused_s(&m),
        };
        let d = &st["daemon"];
        let form = d["form"].as_str().unwrap_or("");
        if form == "managed" {
            return put_said(json!({ "result": "managed", "version": d["version"] }), "output", &plain(tr("这份 daemon 是受管安装，会自己跟着主干自动更新，不需要在这里更新", &[])));
        }
        if form != "checkout" {
            return refused_s(&plain(tr("这份 daemon 不是 git 代码目录，不能在这里更新", &[])));
        }
        let Some(dir) = d["target"].as_str().filter(|t| Path::new(t).is_absolute()) else { return refused_s(&plain(tr("状态脚本没有给出 daemon 的位置", &[]))) };
        let (before, after, output) = match self.fast_forward(&path, dir).await {
            Ok(r) => r,
            Err(blocked) => return blocked,
        };
        let refresh = self.refresh_mac(&path).await;
        put_said(json!({ "result": if before == after { "current" } else { "updated" }, "before": before, "after": after, "refresh": refresh }), "output", &output)
    }

    /// The one fast-forward both update paths use: no local changes, an origin branch upstream, origin on
    /// github.com, fetch, `merge --ff-only`. Ok: (HEAD before, HEAD after, git's words); Err: the "blocked" result.
    async fn fast_forward(&self, path: &str, dir: &str) -> Result<(String, String, Said), Value> {
        let run_git = |args: Vec<&str>, limit: Duration| {
            let mut all = vec!["-C", dir];
            all.extend(args);
            let all: Vec<String> = all.into_iter().map(str::to_string).collect();
            async move {
                let a: Vec<&str> = all.iter().map(String::as_str).collect();
                self.run_s(path, "git", &a, limit).await
            }
        };
        // `step` is the client's words; `output` git's, as is
        let blocked = |step: String, out: &Ran| put_said(json!({ "result": "blocked", "step": step }), "output", &out.said("system"));

        let dirty = run_git(vec!["status", "--porcelain", "--untracked-files=no"], T_SHORT).await;
        if !dirty.ok() {
            return Err(blocked(tr("读不到代码目录的状态", &[]), &dirty));
        }
        if !dirty.stdout.trim().is_empty() {
            return Err(blocked(tr("代码目录里有没提交的改动，没有更新", &[]), &dirty));
        }
        let upstream = run_git(vec!["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], T_SHORT).await;
        if !upstream.ok() || !upstream.stdout.trim().starts_with("origin/") {
            return Err(blocked(tr("当前分支没有跟踪 origin 上的分支，没有更新", &[]), &upstream));
        }
        let remote = run_git(vec!["remote", "get-url", "origin"], T_SHORT).await;
        if !remote.ok() || !github_remote(remote.stdout.trim(), &self.cfg.extra_remotes) {
            return Err(blocked(tr("origin 不是 github.com 上的仓库，客户端只从 github.com 拉取，没有更新", &[]), &remote));
        }
        let before = run_git(vec!["rev-parse", "HEAD"], T_SHORT).await.stdout.trim().to_string();
        let fetch = run_git(vec!["fetch", "--quiet", "origin"], T_NET).await;
        if !fetch.ok() {
            return Err(blocked(tr("拉取失败", &[]), &fetch));
        }
        let merge = run_git(vec!["merge", "--ff-only", "@{upstream}"], T_SHORT).await;
        if !merge.ok() {
            return Err(blocked(tr("不能快进（本地有分叉的提交，或会覆盖本地文件），没有更新", &[]), &merge));
        }
        let after = run_git(vec!["rev-parse", "HEAD"], T_SHORT).await.stdout.trim().to_string();
        let output = [fetch.text(), merge.text()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
        Ok((before, after, outside(&output, "system")))
    }

    /// Every macOS project's launchd plist, one after another; one failing does not stop the rest.
    async fn refresh_mac(&self, path: &str) -> Vec<Value> {
        let mut refresh = vec![];
        match self.status_ok_s(path).await {
            Ok(st2) => {
                for p in st2["projects"].as_array().into_iter().flatten() {
                    if p["scheduler"]["kind"].as_str() != Some("launchd") {
                        continue;
                    }
                    let Some(key) = p["key"].as_str().filter(|k| valid_key(k)) else { continue };
                    let out = self.script_s(path, "launchd-refresh.sh", &[key], T_REFRESH).await;
                    let (result, output) = out.outcome_said();
                    refresh.push(put_said(json!({ "key": key, "result": result, "code": out.code }), "output", &output));
                }
            }
            Err(m) => refresh.push(put_said(json!({ "key": Value::Null, "result": "unknown", "code": Value::Null }), "output", &m)),
        }
        refresh
    }

    // ── a daemon from before the status script (GitHub#320) ──

    /// The managed releases folder, as scripts/install-status.sh names it.
    fn releases_root(&self) -> Option<PathBuf> {
        let root = match self.cfg.env.iter().find(|(k, _)| k == "CAVIL_DEPLOY_ROOT") {
            Some((_, v)) => PathBuf::from(v),
            None => self.home().ok()?.join(".agents/releases/cavil-loop"),
        };
        Some(root.join("releases"))
    }

    /// What kind of install `entry` is, judged without the status script. The order is the status
    /// script's (managed releases folder, then a git work tree, else a plain folder), but "not a git
    /// work tree" needs positive evidence: no `.git` in the folder or any folder above it, every one of
    /// them readable. A `.git` that git then does not confirm, a folder that cannot be read, git missing
    /// or failing — all "unknown", which offers nothing (the status script would say "directory" there).
    pub(crate) async fn outdated_form(&self, entry: &Path, path: &str) -> Form {
        let at = |p: &Path, e: &std::io::Error| [("p", outside(&p.to_string_lossy(), "user")), ("e", outside(&e.to_string(), "system"))];
        let target = match std::fs::canonicalize(entry) {
            Ok(t) => t,
            Err(e) => {
                let [a, b] = at(entry, &e);
                return Form::Unknown(Said::compose("解析不了 {p} 指向的位置：{e}", &[(a.0, &a.1), (b.0, &b.1)]));
            }
        };
        match std::fs::metadata(&target) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Form::Unknown(Said::new("{p} 不是目录", &[("p", &target.to_string_lossy())], "user")),
            Err(e) => {
                let [a, b] = at(&target, &e);
                return Form::Unknown(Said::compose("读不了 {p}：{e}", &[(a.0, &a.1), (b.0, &b.1)]));
            }
        }
        if let Some(rel) = self.releases_root() {
            let canon = std::fs::canonicalize(&rel).ok();
            if target.starts_with(&rel) || canon.is_some_and(|c| target.starts_with(c)) {
                return Form::Managed(target);
            }
        }
        let mut marked = false;
        for dir in target.ancestors() {
            match std::fs::symlink_metadata(dir.join(".git")) {
                Ok(_) => {
                    marked = true;
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    let [a, b] = at(&dir.join(".git"), &e);
                    return Form::Unknown(Said::compose("读不了 {p}：{e}", &[(a.0, &a.1), (b.0, &b.1)]));
                }
            }
        }
        if !marked {
            return Form::Directory(target);
        }
        let t = target.to_string_lossy().to_string();
        let out = self.run_s(path, "git", &["-C", &t, "rev-parse", "--is-inside-work-tree"], T_SHORT).await;
        if out.ok() && out.stdout.trim() == "true" {
            Form::Checkout(target)
        } else {
            let said = if out.note.is_none() && out.text().is_empty() { plain(tr("没有输出", &[])) } else { out.said("system") };
            Form::Unknown(Said::compose("{p} 里有 git 的标记，但 git 没有确认它是代码目录：{e}", &[("p", &outside(&t, "user")), ("e", &said)]))
        }
    }
}

/// The kind of an install without the status script (GitHub#320).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Form {
    Checkout(PathBuf),
    Managed(PathBuf),
    Directory(PathBuf),
    Unknown(Said),
}

impl Form {
    fn to_json(&self) -> Value {
        match self {
            Form::Checkout(t) => json!({ "form": "checkout", "target": t.to_string_lossy() }),
            Form::Managed(t) => json!({ "form": "managed", "target": t.to_string_lossy() }),
            Form::Directory(t) => json!({ "form": "directory", "target": t.to_string_lossy() }),
            Form::Unknown(e) => put_said(json!({ "form": "unknown" }), "error", e),
        }
    }

    fn refusal(&self) -> Said {
        match self {
            Form::Checkout(_) => plain(String::new()),
            Form::Managed(_) => plain(tr("这份 daemon 是受管安装，不能在这里更新", &[])),
            Form::Directory(_) => plain(tr("这份 daemon 不是 git 代码目录，也不是受管安装，客户端更新不了它", &[])),
            Form::Unknown(e) => Said::compose("读不出这份 daemon 是哪种安装，没有更新：{e}", &[("e", e)]),
        }
    }
}

fn has_status_script(entry: &Path) -> bool {
    entry.join("scripts/install-status.sh").is_file()
}

/// Nothing ran: `output` the reason as one string, `outputSaid` with its outside parts marked (GitHub#473)
pub(crate) fn refused_s(m: &Said) -> Value {
    put_said(json!({ "result": "refused" }), "output", m)
}

/// "项目名不合规"
pub(crate) fn bad_key() -> Said {
    plain(tr("项目名不合规", &[]))
}

/// "本机没有接入项目 <key>"
pub(crate) fn no_project(key: &str) -> Said {
    Said::new("本机没有接入项目 {key}", &[("key", key)], "user")
}

/// Several messages, one per line, their outside parts kept apart.
pub(crate) fn join_lines(lines: &[Said]) -> Said {
    join_sep(lines, "\n")
}

/// A message read back from its JSON (`put_said`'s `<key>Said`); None for anything malformed.
pub(crate) fn said_from_json(v: &Value) -> Option<Said> {
    const FROM: [&str; 5] = ["github", "daemon", "remote", "system", "user"];
    let template = v["template"].as_str()?.to_string();
    let mut parts = vec![];
    for p in v["parts"].as_array()? {
        let from = FROM.iter().find(|f| p["from"].as_str() == Some(**f))?;
        parts.push((p["name"].as_str()?.to_string(), p["text"].as_str()?.to_string(), *from));
    }
    Some(Said { template, parts })
}

/// Several messages with `sep` (the client's own words) between them, their outside parts kept apart.
pub(crate) fn join_sep(lines: &[Said], sep: &str) -> Said {
    let mut all = Said::default();
    for (i, l) in lines.iter().enumerate() {
        let mut t = l.template.clone();
        for (k, v, from) in &l.parts {
            let renamed = format!("l{i}_{k}");
            t = t.replace(&format!("{{{k}}}"), &format!("{{{renamed}}}"));
            all.parts.push((renamed, v.clone(), *from));
        }
        if i > 0 {
            all.template.push_str(sep);
        }
        all.template.push_str(&t);
    }
    all
}

/// The one test of "this is a status the client understands" — for the local status script and for
/// the same output relayed by a remote machine (GitHub#387).
pub(crate) fn status_shape(v: &Value) -> bool {
    v["version"] == 1 && v["projects"].is_array()
}

/// The status script's answer, or why it is not one (the script's own words kept apart).
pub(crate) fn parse_status_s(out: &Ran) -> Result<Value, Said> {
    if !out.ok() {
        let shown = if out.note.is_none() && out.text().is_empty() { plain(tr("没有输出", &[])) } else { out.said("daemon") };
        return Err(Said::compose("状态脚本{code}：{out}", &[("code", &code_word(out.code)), ("out", &shown)]));
    }
    match serde_json::from_str::<Value>(out.stdout.trim()) {
        Ok(v) if status_shape(&v) => Ok(v),
        Ok(v) => Err(Said::new("状态脚本输出的格式认不出（version = {v}），客户端可能需要更新", &[("v", &v["version"].to_string())], "daemon")),
        Err(e) => Err(Said::compose(
            "状态脚本输出的不是 JSON（{e}）：{out}",
            &[("e", &outside(&e.to_string(), "system")), ("out", &outside(&tail(out.stdout.trim(), 2000), "daemon"))],
        )),
    }
}

/// install-status.sh without jq (exit 3): `{version: 1, precheck: true, os, base_deps: {missing}}` only.
fn parse_precheck(out: &Out) -> Option<Value> {
    if out.code != Some(3) {
        return None;
    }
    let v: Value = serde_json::from_str(out.stdout.trim()).ok()?;
    let missing = v["base_deps"]["missing"].as_array()?;
    if v["version"] != 1 || v["precheck"] != true || !v["os"].is_string() || !missing.iter().all(|m| m.is_string()) {
        return None;
    }
    Some(json!({ "os": v["os"], "base_deps": { "missing": missing } }))
}

pub(crate) fn find_project<'a>(st: &'a Value, key: &str) -> Option<&'a Value> {
    st["projects"].as_array()?.iter().find(|p| p["key"].as_str() == Some(key))
}

pub(crate) fn which(program: &str, path: &str) -> Option<PathBuf> {
    if program.contains('/') {
        return Some(PathBuf::from(program));
    }
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(program)).find(|p| is_executable(p))
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}
#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

#[cfg(unix)]
pub(crate) fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}
#[cfg(not(unix))]
pub(crate) fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, tr("只支持 macOS / Linux", &[])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_adds_tool_folders_once_after_the_login_path() {
        let h = Path::new("/Users/a");
        assert_eq!(compose_path("/usr/bin:/bin", h), "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/a/.local/bin");
        assert_eq!(compose_path("/opt/homebrew/bin:/usr/bin::/usr/bin", h), "/opt/homebrew/bin:/usr/bin:/usr/local/bin:/Users/a/.local/bin");
        assert_eq!(compose_path("", h), "/opt/homebrew/bin:/usr/local/bin:/Users/a/.local/bin");
    }

    #[test]
    fn keys_follow_setup_sh() {
        for k in ["widget", "my.proj-2", "a_b"] {
            assert!(valid_key(k), "{k}");
        }
        for k in ["", "deploy", "a b", "../x", "a/b", "x;rm", "名字"] {
            assert!(!valid_key(k), "{k}");
        }
        assert!(!valid_unit("--user"));
        assert!(valid_unit("cavil-loop-poll@widget.timer"));
        assert!(!valid_unit("a b"));
    }

    #[test]
    fn only_github_remotes() {
        for u in ["https://github.com/GigleAI/cavil-loop.git", "git@github.com:me/cavil-loop.git", "ssh://git@github.com/me/x.git"] {
            assert!(github_remote(u, &[]), "{u}");
        }
        for u in ["https://gitlab.com/x/y.git", "https://github.com.evil.example/x", "http://github.com/x/y", "/tmp/src", "git@github.com:", "file:///tmp/x"] {
            assert!(!github_remote(u, &[]), "{u}");
        }
        assert!(github_remote("/tmp/src", &["/tmp/src".into()]));
    }

    #[test]
    fn result_word_is_the_last_line_only() {
        let o = |s: &str| Out { code: Some(0), stdout: s.into(), stderr: String::new() };
        assert_eq!(o("x\nRESULT=replaced\n").result_word().as_deref(), Some("replaced"));
        assert_eq!(o("RESULT=replaced\nmore\n").result_word(), None);
        assert_eq!(o("RESULT=Bad Word").result_word(), None);
        assert_eq!(o("").result_word(), None);
        // no final line: never one of the script's own words
        let half = Out { code: Some(1), stdout: "6. 加载失败\n".into(), stderr: "mktemp: No space left on device".into() };
        let (w, text) = half.outcome();
        assert_eq!(w, "unconfirmed");
        assert!(text.contains("退出码 1") && text.contains("No space left"));
        assert_eq!(o("RESULT=failed\n").outcome().0, "failed");
    }

    #[test]
    fn test_mode_without_a_fake_home_is_off() {
        let mut env = std::collections::HashMap::new();
        env.insert("HOME".to_string(), "/real".to_string());
        assert!(Config::from_env(true, &env).home.is_none());
        assert_eq!(Config::from_env(false, &env).home.as_deref(), Some(Path::new("/real")));
        env.insert("CAVIL_CLIENT_TEST_DAEMON_HOME".to_string(), "/fake".to_string());
        env.insert("CAVIL_CLIENT_TEST_DAEMON_PATH".to_string(), "/fake/bin".to_string());
        env.insert("CAVIL_CLIENT_TEST_DAEMON_ENV".to_string(), r#"{"FAKE_SD":"/s"}"#.to_string());
        let c = Config::from_env(true, &env);
        assert_eq!(c.home.as_deref(), Some(Path::new("/fake")));
        assert_eq!(c.env, vec![("FAKE_SD".to_string(), "/s".to_string())]);
        // the app (not test mode) never takes the test switches
        let c = Config::from_env(false, &env);
        assert_eq!(c.home.as_deref(), Some(Path::new("/real")));
        assert!(c.env.is_empty() && c.extra_remotes.is_empty());
    }
}
