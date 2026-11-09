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
const OUTPUT_LIMIT: usize = 20_000;

const T_STATUS: Duration = Duration::from_secs(90);
const T_SHORT: Duration = Duration::from_secs(60);
const T_NET: Duration = Duration::from_secs(300);
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
        cmd.arg(path).spawn().map(|_| ()).map_err(|e| format!("打不开文件：{e}"))
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
    fn ok(&self) -> bool {
        self.code == Some(0)
    }
    /// stdout then stderr, the end kept
    fn text(&self) -> String {
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
    /// the `RESULT=<word>` last line the GitHub#313 scripts print
    fn result_word(&self) -> Option<String> {
        let line = self.stdout.lines().rev().find(|l| !l.trim().is_empty())?;
        let w = line.trim().strip_prefix("RESULT=")?;
        w.bytes().all(|b| b.is_ascii_lowercase() || b == b'_').then(|| w.to_string()).filter(|w| !w.is_empty())
    }
}

fn tail(s: &str, n: usize) -> String {
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
    cfg: Config,
    opener: Arc<dyn FileOpener>,
    /// one changing operation at a time (install, stop / start, disconnect, update)
    busy: tokio::sync::Mutex<()>,
}

const BUSY: &str = "另一个 daemon 操作还没结束，等它结束再试";

impl Daemon {
    pub fn new(cfg: Config, opener: Arc<dyn FileOpener>) -> Daemon {
        Daemon { cfg, opener, busy: tokio::sync::Mutex::new(()) }
    }

    fn home(&self) -> Result<&Path, String> {
        self.cfg.home.as_deref().ok_or_else(|| "读不到本机用户目录（HOME），无法检查 daemon".to_string())
    }

    /// The stable skill entry: the new name, else the one from before the rename (scripts/_names.sh cavil_pick).
    fn entry(&self) -> Result<PathBuf, String> {
        let h = self.home()?;
        let new = h.join(".agents/skills/cavil-loop");
        let old = h.join(".agents/skills/coding-agent-work-loop");
        let there = |p: &Path| p.exists() || p.symlink_metadata().is_ok();
        Ok(if there(&new) || !there(&old) { new } else { old })
    }

    async fn path(&self) -> Result<String, String> {
        let home = self.home()?.to_path_buf();
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
    fn prepare(&self, c: &mut tokio::process::Command, home: &Path, path: &str) {
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

    async fn run(&self, path: &str, program: &str, args: &[&str], limit: Duration) -> Out {
        let home = match self.home() {
            Ok(h) => h.to_path_buf(),
            Err(e) => return Out { code: None, stdout: String::new(), stderr: e },
        };
        let Some(bin) = which(program, path) else {
            return Out { code: None, stdout: String::new(), stderr: format!("找不到 {program}（PATH：{path}）") };
        };
        let mut c = tokio::process::Command::new(bin);
        c.args(args).current_dir(&home).stdin(std::process::Stdio::null());
        self.prepare(&mut c, &home, path);
        match tokio::time::timeout(limit, c.output()).await {
            Ok(Ok(o)) => Out { code: o.status.code(), stdout: String::from_utf8_lossy(&o.stdout).into(), stderr: String::from_utf8_lossy(&o.stderr).into() },
            Ok(Err(e)) => Out { code: None, stdout: String::new(), stderr: format!("{program} 没能启动：{e}") },
            Err(_) => Out { code: None, stdout: String::new(), stderr: format!("{program} 超过 {} 秒没有结束，已停止", limit.as_secs()) },
        }
    }

    /// One of the daemon's own scripts, by its fixed path under the skill entry.
    async fn script(&self, path: &str, name: &str, args: &[&str], limit: Duration) -> Out {
        let file = match self.entry() {
            Ok(e) => e.join("scripts").join(name),
            Err(m) => return Out { code: None, stdout: String::new(), stderr: m },
        };
        let f = file.to_string_lossy().to_string();
        let mut all = vec![f.as_str()];
        all.extend_from_slice(args);
        self.run(path, "bash", &all, limit).await
    }

    // ── status ──

    /// `{state: "missing", entry}` / `{state: "unreadable", reason, entry}` / `{state: "ok", entry, status}`
    pub async fn status(&self) -> Value {
        let entry = match self.entry() {
            Ok(e) => e,
            Err(m) => return json!({ "state": "unreadable", "reason": m, "entry": Value::Null }),
        };
        let e = entry.to_string_lossy().to_string();
        if !entry.exists() && entry.symlink_metadata().is_err() {
            return json!({ "state": "missing", "entry": e });
        }
        if !entry.join("scripts/install-status.sh").is_file() {
            let reason = if !entry.exists() {
                format!("{e} 是一个指向不存在位置的链接")
            } else {
                format!("{e} 里没有状态脚本 scripts/install-status.sh：这份 daemon 早于 GitHub#313，请在终端里更新它（git -C {e} pull --ff-only）后重新检查")
            };
            return json!({ "state": "unreadable", "reason": reason, "entry": e });
        }
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return json!({ "state": "unreadable", "reason": m, "entry": e }),
        };
        let out = self.script(&path, "install-status.sh", &[], T_STATUS).await;
        match parse_status(&out) {
            Ok(st) => json!({ "state": "ok", "entry": e, "status": st }),
            Err(reason) => json!({ "state": "unreadable", "reason": reason, "entry": e }),
        }
    }

    async fn status_ok(&self, path: &str) -> Result<Value, String> {
        let out = self.script(path, "install-status.sh", &[], T_STATUS).await;
        parse_status(&out).map_err(|r| format!("读不到本机 daemon 状态，没有执行：{r}"))
    }

    // ── install ──

    pub async fn install(&self) -> Value {
        let Ok(_g) = self.busy.try_lock() else { return refused(BUSY) };
        let entry = match self.entry() {
            Ok(e) => e,
            Err(m) => return refused(&m),
        };
        if entry.exists() || entry.symlink_metadata().is_ok() {
            return json!({ "result": "existing", "entry": entry.to_string_lossy(), "output": "本机已经装了 daemon，沿用现有的，什么都没动" });
        }
        let home = match self.home() {
            Ok(h) => h.to_path_buf(),
            Err(m) => return refused(&m),
        };
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        let skills = entry.parent().unwrap_or(&home).to_path_buf();
        if let Err(e) = std::fs::create_dir_all(&skills) {
            return json!({ "result": "failed", "output": format!("建不出目录 {}：{e}", skills.display()) });
        }
        // clone next to it, then rename: a clone that fails half-way never looks like an install
        let tmp = skills.join(format!(".cavil-loop.cloning-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let t = tmp.to_string_lossy().to_string();
        let out = self.run(&path, "git", &["clone", "--quiet", &self.cfg.clone_url, &t], T_NET).await;
        if !out.ok() {
            let _ = std::fs::remove_dir_all(&tmp);
            return json!({ "result": "failed", "output": format!("从 {} 克隆失败：\n{}", self.cfg.clone_url, out.text()) });
        }
        if let Err(e) = std::fs::rename(&tmp, &entry) {
            let _ = std::fs::remove_dir_all(&tmp);
            return json!({ "result": "failed", "output": format!("克隆好了，但放不到 {}：{e}", entry.display()) });
        }
        let mut lines = vec![format!("已从 {} 克隆到 {}", self.cfg.clone_url, entry.display())];
        // the Claude Code skill link, as in the README (an existing one is left alone)
        let link = home.join(".claude/skills/cavil-loop");
        if link.symlink_metadata().is_ok() {
            lines.push(format!("{} 已存在，没有改动", link.display()));
        } else {
            let made = std::fs::create_dir_all(home.join(".claude/skills")).and_then(|_| symlink(&entry, &link));
            match made {
                Ok(()) => lines.push(format!("已建软链 {} → {}", link.display(), entry.display())),
                Err(e) => lines.push(format!("软链 {} 没建成：{e}（只影响在 Claude Code 里直接用这个 skill，不影响 daemon）", link.display())),
            }
        }
        json!({ "result": "installed", "entry": entry.to_string_lossy(), "output": lines.join("\n") })
    }

    // ── one project: stop / start / disconnect / open ──

    /// `action`: "stop" | "start"
    pub async fn service(&self, key: &str, action: &str) -> Value {
        if !valid_key(key) {
            return refused("项目名不合规");
        }
        if action != "stop" && action != "start" {
            return refused("未知操作");
        }
        let Ok(_g) = self.busy.try_lock() else { return refused(BUSY) };
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        let st = match self.status_ok(&path).await {
            Ok(s) => s,
            Err(m) => return refused(&m),
        };
        let Some(p) = find_project(&st, key) else { return refused(&format!("本机没有接入项目 {key}")) };
        let sched = &p["scheduler"];
        let state = sched["state"].as_str().unwrap_or("unknown");
        let want_from = if action == "stop" { "running" } else { "stopped" };
        if state != want_from {
            let shown = match state {
                "running" => "在跑",
                "stopped" => "已停",
                _ => "读不到",
            };
            return refused(&format!("{key} 现在的后台任务状态是「{shown}」，没有执行「{}」", if action == "stop" { "停" } else { "启" }));
        }
        let unit = sched["unit"].as_str().unwrap_or("");
        if !valid_unit(unit) {
            return refused("状态脚本给出的后台任务名不合规，没有执行");
        }
        let out = match sched["kind"].as_str() {
            Some("systemd") => {
                if !unit.ends_with(".timer") {
                    return refused("状态脚本给出的后台任务名不合规，没有执行");
                }
                self.run(&path, "systemctl", &["--user", action, unit], T_SHORT).await
            }
            Some("launchd") => {
                let uid = self.run(&path, "id", &["-u"], T_SHORT).await;
                let uid = uid.stdout.trim().to_string();
                if uid.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) {
                    return refused("读不到本机用户编号（id -u），没有执行");
                }
                if action == "stop" {
                    self.run(&path, "launchctl", &["bootout", &format!("gui/{uid}/{unit}")], T_SHORT).await
                } else {
                    let plist = p["scheduler"]["plist"].as_str().unwrap_or("");
                    let expect = match self.home() {
                        Ok(h) => h.join("Library/LaunchAgents").join(format!("{unit}.plist")),
                        Err(m) => return refused(&m),
                    };
                    if Path::new(plist) != expect || !expect.is_file() {
                        return refused(&format!("找不到 {key} 的后台任务配置文件 {}，没有执行", expect.display()));
                    }
                    self.run(&path, "launchctl", &["bootstrap", &format!("gui/{uid}"), plist], T_SHORT).await
                }
            }
            _ => return refused("认不出这台机器的后台任务管理器，没有执行"),
        };
        // read back: only the state the status script now reports counts
        let want = if action == "stop" { "stopped" } else { "running" };
        let after = self.status_ok(&path).await.ok();
        let now = after.as_ref().and_then(|s| find_project(s, key)).and_then(|p| p["scheduler"]["state"].as_str().map(str::to_string)).unwrap_or_else(|| "unknown".into());
        json!({
            "result": if now == want { "ok" } else { "failed" },
            "state": now,
            "output": out.text(),
        })
    }

    pub async fn disconnect(&self, key: &str) -> Value {
        if !valid_key(key) {
            return refused("项目名不合规");
        }
        let Ok(_g) = self.busy.try_lock() else { return refused(BUSY) };
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        let out = self.script(&path, "disconnect-project.sh", &[key], T_SHORT).await;
        json!({ "result": out.result_word().unwrap_or_else(|| "failed".into()), "code": out.code, "output": out.text() })
    }

    /// `what`: "log" (the project's poll.log) | "config" (its config file), both from the status script
    pub async fn open(&self, key: &str, what: &str) -> Value {
        if !valid_key(key) {
            return refused("项目名不合规");
        }
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        let st = match self.status_ok(&path).await {
            Ok(s) => s,
            Err(m) => return refused(&m),
        };
        let Some(p) = find_project(&st, key) else { return refused(&format!("本机没有接入项目 {key}")) };
        let file = match what {
            "log" => p["state_dir"].as_str().map(|d| Path::new(d).join("poll.log")),
            "config" => p["config"].as_str().map(PathBuf::from),
            _ => return refused("未知操作"),
        };
        let Some(file) = file.filter(|f| f.is_absolute()) else { return refused("状态脚本没有给出这个文件的位置") };
        if !file.is_file() {
            return refused(&format!("文件不存在：{}", file.display()));
        }
        match self.opener.open_file(&file.to_string_lossy(), what).await {
            Ok(()) => json!({ "result": "ok", "path": file.to_string_lossy() }),
            Err(m) => refused(&m),
        }
    }

    // ── update ──

    pub async fn update(&self) -> Value {
        let Ok(_g) = self.busy.try_lock() else { return refused(BUSY) };
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        let st = match self.status_ok(&path).await {
            Ok(s) => s,
            Err(m) => return refused(&m),
        };
        let d = &st["daemon"];
        let form = d["form"].as_str().unwrap_or("");
        if form == "managed" {
            return json!({ "result": "managed", "version": d["version"], "output": "这份 daemon 是受管安装，会自己跟着主干自动更新，不需要在这里更新" });
        }
        if form != "checkout" {
            return refused("这份 daemon 不是 git 代码目录，不能在这里更新");
        }
        let Some(dir) = d["target"].as_str().filter(|t| Path::new(t).is_absolute()) else { return refused("状态脚本没有给出 daemon 的位置") };
        let git = |args: Vec<&str>| {
            let mut all = vec!["-C", dir];
            all.extend(args);
            all.into_iter().map(str::to_string).collect::<Vec<_>>()
        };
        let run_git = |args: Vec<String>, limit: Duration| {
            let path = path.clone();
            async move {
                let a: Vec<&str> = args.iter().map(String::as_str).collect();
                self.run(&path, "git", &a, limit).await
            }
        };
        let blocked = |step: &str, out: &Out| json!({ "result": "blocked", "step": step, "output": out.text() });

        let dirty = run_git(git(vec!["status", "--porcelain", "--untracked-files=no"]), T_SHORT).await;
        if !dirty.ok() {
            return blocked("读不到代码目录的状态", &dirty);
        }
        if !dirty.stdout.trim().is_empty() {
            return blocked("代码目录里有没提交的改动，没有更新", &dirty);
        }
        let upstream = run_git(git(vec!["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]), T_SHORT).await;
        if !upstream.ok() || !upstream.stdout.trim().starts_with("origin/") {
            return blocked("当前分支没有跟踪 origin 上的分支，没有更新", &upstream);
        }
        let remote = run_git(git(vec!["remote", "get-url", "origin"]), T_SHORT).await;
        if !remote.ok() || !github_remote(remote.stdout.trim(), &self.cfg.extra_remotes) {
            return blocked("origin 不是 github.com 上的仓库，客户端只从 github.com 拉取，没有更新", &remote);
        }
        let before = run_git(git(vec!["rev-parse", "HEAD"]), T_SHORT).await.stdout.trim().to_string();
        let fetch = run_git(git(vec!["fetch", "--quiet", "origin"]), T_NET).await;
        if !fetch.ok() {
            return blocked("拉取失败", &fetch);
        }
        let merge = run_git(git(vec!["merge", "--ff-only", "@{upstream}"]), T_SHORT).await;
        if !merge.ok() {
            return blocked("不能快进（本地有分叉的提交，或会覆盖本地文件），没有更新", &merge);
        }
        let after = run_git(git(vec!["rev-parse", "HEAD"]), T_SHORT).await.stdout.trim().to_string();

        // every macOS project's launchd plist, one after another; one failing does not stop the rest
        let mut refresh = vec![];
        match self.status_ok(&path).await {
            Ok(st2) => {
                for p in st2["projects"].as_array().into_iter().flatten() {
                    if p["scheduler"]["kind"].as_str() != Some("launchd") {
                        continue;
                    }
                    let Some(key) = p["key"].as_str().filter(|k| valid_key(k)) else { continue };
                    let out = self.script(&path, "launchd-refresh.sh", &[key], T_REFRESH).await;
                    refresh.push(json!({ "key": key, "result": out.result_word().unwrap_or_else(|| "failed".into()), "code": out.code, "output": out.text() }));
                }
            }
            Err(m) => refresh.push(json!({ "key": Value::Null, "result": "unknown", "code": Value::Null, "output": m })),
        }
        let output = [fetch.text(), merge.text()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
        json!({
            "result": if before == after { "current" } else { "updated" },
            "before": before,
            "after": after,
            "output": output,
            "refresh": refresh,
        })
    }
}

fn refused(m: &str) -> Value {
    json!({ "result": "refused", "output": m })
}

fn parse_status(out: &Out) -> Result<Value, String> {
    if !out.ok() {
        let t = out.text();
        return Err(format!("状态脚本{}：{}", match out.code { Some(c) => format!("退出码 {c}"), None => "没有正常结束".into() }, if t.is_empty() { "没有输出".into() } else { t }));
    }
    match serde_json::from_str::<Value>(out.stdout.trim()) {
        Ok(v) if v["version"] == 1 && v["projects"].is_array() => Ok(v),
        Ok(v) => Err(format!("状态脚本输出的格式认不出（version = {}），客户端可能需要更新", v["version"])),
        Err(e) => Err(format!("状态脚本输出的不是 JSON（{e}）：{}", tail(out.stdout.trim(), 2000))),
    }
}

fn find_project<'a>(st: &'a Value, key: &str) -> Option<&'a Value> {
    st["projects"].as_array()?.iter().find(|p| p["key"].as_str() == Some(key))
}

fn which(program: &str, path: &str) -> Option<PathBuf> {
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
fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}
#[cfg(not(unix))]
fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "只支持 macOS / Linux"))
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
