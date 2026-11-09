// "接上 daemon" from the repository list (GitHub#315): connect one repository
// the client already shows to the local cavil-loop daemon.
//
// The window names a repository (owner/name), an agent and either a local
// folder or a folder to clone into. Everything is checked again here:
//   - the agent must be one of the daemon's own drivers (scripts/drivers/*.sh);
//   - the folder must be an existing git repository (its top level) whose
//     `origin` is that repository on github.com; a clone goes to
//     <folder>/<name> from the fixed https://github.com/<owner>/<name>.git;
//   - what is missing for that agent comes from the daemon's status script
//     (`install-status.sh --agent`, the same rule setup.sh uses), asked again
//     right before setup runs — anything missing and nothing runs;
//   - then the daemon's own `setup.sh --yes <folder> <key>` with
//     WORKER_AGENT=<agent>, its output kept as it comes so the window can show
//     it live; "connected" only when the status script afterwards lists a
//     project for that folder.
// The child environment is the same allow-list as the rest of daemon.rs.

use crate::daemon::{find_project, parse_status, refused, tail, which, Daemon, Out, BUSY, T_NET, T_SHORT, T_STATUS};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// setup.sh: labels on GitHub, a release on Linux, the scheduler — minutes at most
const T_SETUP: Duration = Duration::from_secs(900);
/// output kept per job; beyond it the rest is cut (the window reads it by offset, so nothing is dropped from the front)
const JOB_OUTPUT_LIMIT: usize = 1_000_000;
/// finished jobs kept for the window to read
const JOBS_KEPT: usize = 8;
/// how deep the search for an existing copy goes below each folder it starts from
const SEARCH_DEPTH: usize = 2;
/// folders looked at in all, at most (a home folder can be huge)
const SEARCH_LIMIT: usize = 4000;
/// the usual places for code, below HOME
const SEARCH_ROOTS: [&str; 16] =
    ["github", "GitHub", "code", "Code", "src", "projects", "Projects", "Developer", "dev", "workspace", "work", "repos", "git", "git-repos", "Documents/GitHub", "Sites"];

#[derive(Default)]
pub struct Jobs {
    next: u64,
    all: HashMap<u64, Job>,
}

struct Job {
    output: String,
    cut: bool,
    done: bool,
    outcome: Value,
}

/// `owner/name` as GitHub accepts it (shared/sources.ts NAME), lowercased for comparing.
pub fn parse_repo(s: &str) -> Option<(String, String)> {
    let (o, n) = s.split_once('/')?;
    let ok = |x: &str| {
        !x.is_empty()
            && x.len() <= 100
            && x.as_bytes()[0].is_ascii_alphanumeric()
            && x.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
            && x != "."
            && x != ".."
    };
    (ok(o) && ok(n)).then(|| (o.to_string(), n.to_string()))
}

/// Which github.com repository a remote URL names (`owner/name`, lowercased); None for anything else.
pub fn github_repo_of(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some(rest) = url.strip_prefix("git@github.com:") {
        rest.to_string()
    } else {
        let u = url::Url::parse(url).ok()?;
        if !matches!(u.scheme(), "https" | "ssh") || u.host_str() != Some("github.com") {
            return None;
        }
        u.path().trim_start_matches('/').to_string()
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (o, n) = parse_repo(path)?;
    Some(format!("{}/{}", o.to_lowercase(), n.to_lowercase()))
}

/// The `url` of `[remote "origin"]` in a git config file (a quick read for the search; the check runs git itself).
fn origin_in_config(text: &str) -> Option<String> {
    let mut inside = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            inside = l.replace(' ', "").eq_ignore_ascii_case("[remote\"origin\"]");
            continue;
        }
        if inside {
            if let Some((k, v)) = l.split_once('=') {
                if k.trim().eq_ignore_ascii_case("url") {
                    return Some(v.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    None
}

/// The project config already in a folder, as the daemon reads it (`install-status.sh --project`:
/// the same shell reading setup.sh and the poller use). setup.sh keeps such a config as it is, so its
/// repository and worker agent — not the dialog's choice — are what the daemon will run with.
#[derive(Debug, PartialEq)]
pub enum ExistingConfig {
    /// no config: setup.sh writes a new one
    None,
    Read { path: String, repo: String, agent: String },
    /// there is one, but sourcing it failed
    Unreadable(String),
}

/// `project_check` of the status script's output, for `dir`; anything else is an error (never "no config").
pub fn parse_project_check(st: &Value, dir: &str) -> Result<ExistingConfig, String> {
    let pc = &st["project_check"];
    if pc["dir"].as_str() != Some(dir) {
        return Err("状态脚本没有给出这个目录的项目配置（daemon 可能早于 GitHub#315，请先更新 daemon）".into());
    }
    let path = pc["config"].as_str().unwrap_or("").to_string();
    match pc["config_state"].as_str() {
        Some("none") => Ok(ExistingConfig::None),
        Some("ok") => match (pc["repo"].as_str(), pc["worker_agent"].as_str()) {
            (Some(r), Some(a)) if !path.is_empty() => Ok(ExistingConfig::Read { path, repo: r.to_string(), agent: a.to_string() }),
            _ => Err("状态脚本给出的项目配置缺字段".into()),
        },
        Some("unreadable") => Ok(ExistingConfig::Unreadable(path)),
        _ => Err("状态脚本给出的项目配置状态认不出".into()),
    }
}

/// Whether an existing config fits the chosen repository. Ok(Some((path, agent))): it does, and the
/// daemon will use that agent; Ok(None): no config; Err: it names another repository, or cannot be read.
pub fn config_verdict(c: &ExistingConfig, owner: &str, name: &str) -> Result<Option<(String, String)>, String> {
    match c {
        ExistingConfig::None => Ok(None),
        ExistingConfig::Unreadable(p) => Err(format!("{p} 已有项目配置，但 daemon 读不出它，没有接上；请先修好这个文件")),
        ExistingConfig::Read { path, repo, agent } => {
            if repo.to_lowercase() != format!("{}/{}", owner.to_lowercase(), name.to_lowercase()) {
                let shown = if repo.is_empty() { "（没写）".to_string() } else { repo.clone() };
                return Err(format!("{path} 已有项目配置，里面的仓库是 {shown}，不是 {owner}/{name}；setup.sh 会沿用这份配置，接上的会是那个仓库，所以没有接上。请先改那个文件里的 REPO，或换一个目录"));
            }
            Ok(Some((path.clone(), agent.clone())))
        }
    }
}

/// The instance key: the folder's name, as setup.sh would pick it, unless another project already
/// uses it; then `<owner>-<name>`. None when neither is free (or valid).
pub fn pick_key(dir: &Path, owner: &str, name: &str, taken: &[(String, Option<String>)]) -> Option<String> {
    let base = dir.file_name()?.to_string_lossy().to_string();
    let here = dir.to_string_lossy().to_string();
    let free = |k: &str| crate::daemon::valid_key(k) && taken.iter().all(|(t, host)| t != k || host.as_deref() == Some(here.as_str()));
    [base, format!("{owner}-{name}")].into_iter().find(|k| free(k))
}

impl Daemon {
    /// The agents the daemon knows: one driver file each under scripts/drivers (not the `_` helpers).
    pub(crate) fn drivers(&self) -> Result<Vec<String>, String> {
        let dir = self.entry()?.join("scripts/drivers");
        let mut out = vec![];
        for e in std::fs::read_dir(&dir).map_err(|e| format!("读不到 daemon 的 agent 列表（{}）：{e}", dir.display()))?.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let Some(a) = n.strip_suffix(".sh") else { continue };
            if a.is_empty() || a.starts_with('_') || !a.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_') {
                continue;
            }
            if e.path().is_file() {
                out.push(a.to_string());
            }
        }
        out.sort();
        // the daemon's default first (setup.sh: WORKER_AGENT defaults to claude)
        if let Some(i) = out.iter().position(|a| a == "claude") {
            let c = out.remove(i);
            out.insert(0, c);
        }
        if out.is_empty() {
            return Err(format!("{} 里没有 agent", dir.display()));
        }
        Ok(out)
    }

    // ── what the dialog shows first ──

    /// `{result:"ok", repo, agents, connected:[{key, host, state}], candidates:[dir], clone_parent}`
    pub async fn connect_info(&self, repo: &str) -> Value {
        let Some((owner, name)) = parse_repo(repo) else { return refused("仓库名不合规") };
        let want = format!("{}/{}", owner.to_lowercase(), name.to_lowercase());
        let agents = match self.drivers() {
            Ok(a) => a,
            Err(m) => return refused(&m),
        };
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        let st = match self.status_ok(&path).await {
            Ok(s) => s,
            Err(m) => return refused(&m),
        };
        let connected: Vec<Value> = st["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["repo"].as_str().map(str::to_lowercase).as_deref() == Some(want.as_str()))
            .map(|p| json!({ "key": p["key"], "host": p["host"], "state": p["scheduler"]["state"] }))
            .collect();
        let home = match self.home() {
            Ok(h) => h.to_path_buf(),
            Err(m) => return refused(&m),
        };
        let candidates = find_copies(&home, &want);
        let github = home.join("github");
        let clone_parent = if github.is_dir() { github } else { home.clone() };
        json!({
            "result": "ok",
            "repo": format!("{owner}/{name}"),
            "agents": agents,
            "connected": connected,
            "candidates": candidates,
            "clone_parent": clone_parent.to_string_lossy(),
        })
    }

    /// What is missing on this machine for `agent` (the status script's own answer).
    /// `{result:"ok", agent, ready, missing, gh_logged_in, os}` / refused / `{result:"unreadable", output}`
    pub async fn precheck(&self, agent: &str) -> Value {
        match self.drivers() {
            Ok(d) if d.iter().any(|a| a == agent) => {}
            Ok(_) => return refused(&format!("daemon 里没有叫 {agent} 的 agent")),
            Err(m) => return refused(&m),
        }
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        self.precheck_on(&path, agent).await
    }

    async fn precheck_on(&self, path: &str, agent: &str) -> Value {
        let out = self.script(path, "install-status.sh", &["--agent", agent], T_STATUS).await;
        let st = match parse_status(&out) {
            Ok(s) => s,
            Err(m) => return json!({ "result": "unreadable", "agent": agent, "ready": false, "output": m }),
        };
        let check = &st["agent_check"];
        if check["state"] == "no_driver" || !check["missing"].is_array() {
            return json!({ "result": "unreadable", "agent": agent, "ready": false, "output": format!("状态脚本认不出 agent {agent}") });
        }
        let missing: Vec<Value> = check["missing"].as_array().cloned().unwrap_or_default();
        let gh = st["gh"]["logged_in"].as_bool();
        json!({
            "result": "ok",
            "agent": agent,
            "bin": check["bin"],
            "missing": missing,
            "gh_logged_in": gh,
            "os": st["os"],
            // setup.sh stops on any missing program and on a gh that is not signed in
            "ready": missing.is_empty() && gh == Some(true),
        })
    }

    /// The window asks whether a typed / picked folder will do.
    /// `{result:"ok", dir, config:{path, agent|null}|null}` / refused with the reason
    pub async fn check_dir_request(&self, repo: &str, dir: &str) -> Value {
        let Some((owner, name)) = parse_repo(repo) else { return refused("仓库名不合规") };
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        let d = match self.check_dir(&path, &owner, &name, dir).await {
            Ok(d) => d,
            Err(m) => return refused(&m),
        };
        match self.project_config(&path, &d).await.and_then(|c| config_verdict(&c, &owner, &name)) {
            Ok(c) => json!({ "result": "ok", "dir": d.to_string_lossy(), "config": c.map(|(p, a)| json!({ "path": p, "agent": a })) }),
            Err(m) => refused(&m),
        }
    }

    /// The daemon's reading of the project config in `dir` (`install-status.sh --project`).
    pub(crate) async fn project_config(&self, path: &str, dir: &Path) -> Result<ExistingConfig, String> {
        let d = dir.to_string_lossy().to_string();
        let out = self.script(path, "install-status.sh", &["--project", &d], T_STATUS).await;
        let st = parse_status(&out).map_err(|r| format!("读不到这个目录里的项目配置：{r}"))?;
        parse_project_check(&st, &d)
    }

    /// An existing git repository's top level whose origin is github.com/<owner>/<name>.
    pub(crate) async fn check_dir(&self, path: &str, owner: &str, name: &str, dir: &str) -> Result<PathBuf, String> {
        let want = format!("{}/{}", owner.to_lowercase(), name.to_lowercase());
        let p = Path::new(dir.trim());
        if dir.trim().is_empty() {
            return Err("还没选本地目录".into());
        }
        if !p.is_absolute() {
            return Err(format!("{dir} 不是完整路径（要从 / 开始）"));
        }
        if !p.is_dir() {
            return Err(format!("{dir} 不存在，或不是目录"));
        }
        let real = std::fs::canonicalize(p).map_err(|e| format!("读不到 {dir}：{e}"))?;
        let r = real.to_string_lossy().to_string();
        let top = self.run(path, "git", &["-C", &r, "rev-parse", "--show-toplevel"], T_SHORT).await;
        if !top.ok() || top.stdout.trim().is_empty() {
            return Err(if real.join(".git").exists() { format!("{r} 读不出 git 仓库信息：{}", top.text()) } else { format!("{r} 不是 git 仓库（里面没有 .git）") });
        }
        let top_real = std::fs::canonicalize(top.stdout.trim()).unwrap_or_else(|_| PathBuf::from(top.stdout.trim()));
        if top_real != real {
            return Err(format!("{r} 在 git 仓库 {} 里面，要选仓库最上层的那个目录", top_real.display()));
        }
        // the remote as written in the repository's config (not rewritten by url.*.insteadOf)
        let origin = self.run(path, "git", &["-C", &r, "config", "--get", "remote.origin.url"], T_SHORT).await;
        let url = origin.stdout.trim().to_string();
        if !origin.ok() || url.is_empty() {
            return Err(format!("{r} 没有 origin 远端，认不出它是不是 {owner}/{name}"));
        }
        match github_repo_of(&url) {
            Some(got) if got == want => Ok(real),
            Some(got) => Err(format!("{r} 的 origin 是 {got}，不是 {owner}/{name}")),
            None => Err(format!("{r} 的 origin（{url}）不是 github.com 上的仓库")),
        }
    }

    /// The system's folder picker. `{result:"ok", path|null}` (null: cancelled)
    pub async fn pick_folder(&self, start: Option<String>) -> Value {
        let Some(p) = &self.picker else { return refused("这里弹不出选择框，请直接填写路径") };
        let start = start.filter(|s| Path::new(s).is_absolute() && Path::new(s).is_dir());
        match p.pick_folder(start).await {
            Ok(path) => json!({ "result": "ok", "path": path }),
            Err(m) => refused(&m),
        }
    }

    // ── connecting: runs in the background ──

    /// Start connecting `repo` with `agent`, from the folder `dir` or a fresh clone into `clone_into`.
    /// `{result:"started", job}` / refused (nothing ran)
    pub async fn connect(self: Arc<Self>, repo: &str, agent: &str, dir: Option<&str>, clone_into: Option<&str>) -> Value {
        let Some((owner, name)) = parse_repo(repo) else { return refused("仓库名不合规") };
        match self.drivers() {
            Ok(d) if d.iter().any(|a| a == agent) => {}
            Ok(_) => return refused(&format!("daemon 里没有叫 {agent} 的 agent")),
            Err(m) => return refused(&m),
        }
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        let source = match (dir.map(str::trim).filter(|d| !d.is_empty()), clone_into.map(str::trim).filter(|d| !d.is_empty())) {
            (Some(d), None) => match self.check_dir(&path, &owner, &name, d).await {
                Ok(real) => Source::Existing(real),
                Err(m) => return refused(&m),
            },
            (None, Some(c)) => {
                let parent = Path::new(c);
                if !parent.is_absolute() || !parent.is_dir() {
                    return refused(&format!("克隆位置 {c} 不存在，或不是完整路径"));
                }
                let parent = match std::fs::canonicalize(parent) {
                    Ok(p) => p,
                    Err(e) => return refused(&format!("读不到 {c}：{e}")),
                };
                let target = parent.join(&name);
                if target.exists() || target.symlink_metadata().is_ok() {
                    return refused(&format!("{} 已经存在，不克隆到那里（是这个仓库的话，直接选它）", target.display()));
                }
                Source::Clone(parent, target)
            }
            _ => return refused("要么选一个本地目录，要么选克隆位置"),
        };
        let Ok(guard) = self.busy.clone().try_lock_owned() else { return refused(BUSY) };
        let id = {
            let mut jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
            jobs.next += 1;
            let id = jobs.next;
            // forget the oldest finished ones
            let mut done: Vec<u64> = jobs.all.iter().filter(|(_, j)| j.done).map(|(k, _)| *k).collect();
            done.sort();
            while jobs.all.len() >= JOBS_KEPT && !done.is_empty() {
                let k = done.remove(0);
                jobs.all.remove(&k);
            }
            jobs.all.insert(id, Job { output: String::new(), cut: false, done: false, outcome: Value::Null });
            id
        };
        let me = self.clone();
        let agent = agent.to_string();
        tokio::spawn(async move {
            let outcome = me.connect_job(id, &path, &owner, &name, &agent, source).await;
            let mut jobs = me.jobs.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(j) = jobs.all.get_mut(&id) {
                j.done = true;
                j.outcome = outcome;
            }
            drop(guard);
        });
        json!({ "result": "started", "job": id })
    }

    /// What a job printed from byte `from` on, and its outcome once done.
    pub fn connect_poll(&self, job: u64, from: usize) -> Value {
        let jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
        let Some(j) = jobs.all.get(&job) else { return refused("没有这个任务") };
        let mut start = from.min(j.output.len());
        while !j.output.is_char_boundary(start) {
            start -= 1;
        }
        json!({
            "result": "ok",
            "output": &j.output[start..],
            "next": j.output.len(),
            "done": j.done,
            "outcome": j.outcome,
        })
    }

    fn say(&self, job: u64, text: &str) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
        let Some(j) = jobs.all.get_mut(&job) else { return };
        if j.cut {
            return;
        }
        if j.output.len() + text.len() > JOB_OUTPUT_LIMIT {
            j.output.push_str("\n…（输出太长，后面的不再显示）\n");
            j.cut = true;
            return;
        }
        j.output.push_str(text);
    }

    fn line(&self, job: u64, text: &str) {
        self.say(job, &format!("{text}\n"));
    }

    async fn connect_job(&self, job: u64, path: &str, owner: &str, name: &str, agent: &str, source: Source) -> Value {
        let failed = |m: String| json!({ "result": "failed", "output": m });
        // 1. the folder: as given, or a fresh clone
        let dir = match source {
            Source::Existing(d) => {
                self.line(job, &format!("本地目录：{}", d.display()));
                d
            }
            Source::Clone(parent, target) => {
                let url = format!("https://github.com/{owner}/{name}.git");
                self.line(job, &format!("$ git clone {url} {}", target.display()));
                // clone next to it, then rename: a clone that fails half-way never looks like a copy
                let tmp = parent.join(format!(".{name}.cloning-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&tmp);
                let t = tmp.to_string_lossy().to_string();
                let out = self.run_stream(job, path, "git", &["clone", "--progress", &url, &t], &[], &parent, T_NET).await;
                if !out.ok() {
                    let _ = std::fs::remove_dir_all(&tmp);
                    return failed(format!("克隆失败（{}）", code_word(&out)));
                }
                if target.exists() || target.symlink_metadata().is_ok() {
                    let _ = std::fs::remove_dir_all(&tmp);
                    return failed(format!("克隆期间 {} 被别的程序建出来了，没有放进去", target.display()));
                }
                if let Err(e) = std::fs::rename(&tmp, &target) {
                    let _ = std::fs::remove_dir_all(&tmp);
                    return failed(format!("克隆好了，但放不到 {}：{e}", target.display()));
                }
                match self.check_dir(path, owner, name, &target.to_string_lossy()).await {
                    Ok(d) => d,
                    Err(m) => return failed(m),
                }
            }
        };
        // 2. a config already in the folder is kept by setup.sh: its repository and agent must be the chosen ones
        match self.project_config(path, &dir).await.and_then(|c| config_verdict(&c, owner, name)) {
            Err(m) => return failed(m),
            Ok(Some((f, a))) if a != agent => {
                return failed(format!("{f} 已有项目配置，daemon 读到里面的 agent 是 {a}，和这次选的 {agent} 不一样；setup.sh 不会改它。要换 agent 请先改那个文件，或这次选 {a}"));
            }
            Ok(_) => {}
        }
        // 3. what is missing, asked again now
        self.line(job, &format!("检查 {agent} 需要的程序…"));
        let pre = self.precheck_on(path, agent).await;
        if pre["ready"] != true {
            let why = if pre["result"] != "ok" {
                pre["output"].as_str().unwrap_or("读不到").to_string()
            } else {
                let miss: Vec<&str> = pre["missing"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                let mut w = vec![];
                if !miss.is_empty() {
                    w.push(format!("缺 {}", miss.join("、")));
                }
                if pre["gh_logged_in"] != true {
                    w.push("gh 没有登录".into());
                }
                w.join("；")
            };
            return json!({ "result": "blocked", "output": format!("没有接上：{why}") });
        }
        // 4. the instance key, and whether this folder is connected already
        let st = match self.status_ok(path).await {
            Ok(s) => s,
            Err(m) => return failed(m),
        };
        let here = dir.to_string_lossy().to_string();
        let projects: Vec<&Value> = st["projects"].as_array().into_iter().flatten().collect();
        let want = format!("{}/{}", owner.to_lowercase(), name.to_lowercase());
        let same_repo = |p: &Value| p["repo"].as_str().map(str::to_lowercase).as_deref() == Some(want.as_str());
        if let Some(p) = projects.iter().find(|p| p["host"].as_str() == Some(here.as_str())) {
            if !same_repo(p) {
                return failed(format!("这个目录已经作为 {}（仓库 {}）接上了，不是 {owner}/{name}，什么都没动", p["key"].as_str().unwrap_or(""), p["repo"].as_str().unwrap_or("读不出")));
            }
            return json!({ "result": "connected", "already": true, "key": p["key"], "state": p["scheduler"]["state"], "dir": here, "output": format!("这个目录已经接上了（{}），什么都没动", p["key"].as_str().unwrap_or("")) });
        }
        let taken: Vec<(String, Option<String>)> =
            projects.iter().filter_map(|p| Some((p["key"].as_str()?.to_string(), p["host"].as_str().map(str::to_string)))).collect();
        let Some(key) = pick_key(&dir, owner, name, &taken) else {
            return failed(format!("项目名 {} 和 {owner}-{name} 都已经被别的项目用了（或不合规），没有接上", dir.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default()));
        };
        // 5. the daemon's own setup.sh
        let setup = match self.entry() {
            Ok(e) => e.join("setup.sh"),
            Err(m) => return failed(m),
        };
        let s = setup.to_string_lossy().to_string();
        self.line(job, &format!("$ WORKER_AGENT={agent} bash {s} --yes {here} {key}"));
        let home = match self.home() {
            Ok(h) => h.to_path_buf(),
            Err(m) => return failed(m),
        };
        let out = self.run_stream(job, path, "bash", &[&s, "--yes", &here, &key], &[("WORKER_AGENT", agent)], &home, T_SETUP).await;
        if !out.ok() {
            return failed(format!("setup.sh 没有成功（{}），没有接上", code_word(&out)));
        }
        // 6. read back: only what the status script lists counts
        let after = match self.status_ok(path).await {
            Ok(s) => s,
            Err(m) => return failed(format!("setup.sh 跑完了，但{m}")),
        };
        match find_project(&after, &key).filter(|p| p["host"].as_str() == Some(here.as_str())) {
            Some(p) if !same_repo(p) => failed(format!("setup.sh 跑完了，但 daemon 登记的 {key} 是仓库 {}，不是 {owner}/{name}；没有确认接上，请在下面「本机 daemon」里断开它", p["repo"].as_str().unwrap_or("读不出"))),
            Some(p) => json!({ "result": "connected", "already": false, "key": key, "state": p["scheduler"]["state"], "dir": here, "output": format!("已接上：{key}") }),
            None => failed(format!("setup.sh 跑完了，但本机状态里找不到 {key}（{here}），没有确认接上")),
        }
    }

    /// Run a program and keep its output (stdout and stderr, as they come) in the job.
    #[allow(clippy::too_many_arguments)]
    async fn run_stream(&self, job: u64, path: &str, program: &str, args: &[&str], extra: &[(&str, &str)], cwd: &Path, limit: Duration) -> Out {
        let home = match self.home() {
            Ok(h) => h.to_path_buf(),
            Err(e) => return self.not_run(job, e),
        };
        let Some(bin) = which(program, path) else { return self.not_run(job, format!("找不到 {program}（PATH：{path}）")) };
        let mut c = tokio::process::Command::new(bin);
        c.args(args).current_dir(cwd).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        self.prepare(&mut c, &home, path);
        for (k, v) in extra {
            c.env(k, v);
        }
        let mut child = match c.spawn() {
            Ok(ch) => ch,
            Err(e) => return self.not_run(job, format!("{program} 没能启动：{e}")),
        };
        let (Some(mut so), Some(mut se)) = (child.stdout.take(), child.stderr.take()) else {
            return self.not_run(job, format!("{program} 没能启动：拿不到输出"));
        };
        let pump = async {
            let mut a = [0u8; 4096];
            let mut b = [0u8; 4096];
            let (mut so_done, mut se_done) = (false, false);
            let (mut keep_o, mut keep_e) = (Vec::new(), Vec::new());
            // bytes of a UTF-8 character split across two reads wait for the rest
            let (mut part_o, mut part_e): (Vec<u8>, Vec<u8>) = (vec![], vec![]);
            while !(so_done && se_done) {
                tokio::select! {
                    n = so.read(&mut a), if !so_done => match n {
                        Ok(0) | Err(_) => so_done = true,
                        Ok(n) => { keep_o.extend_from_slice(&a[..n]); self.say(job, &take_utf8(&mut part_o, &a[..n])); }
                    },
                    n = se.read(&mut b), if !se_done => match n {
                        Ok(0) | Err(_) => se_done = true,
                        Ok(n) => { keep_e.extend_from_slice(&b[..n]); self.say(job, &take_utf8(&mut part_e, &b[..n])); }
                    },
                }
            }
            for rest in [part_o, part_e] {
                if !rest.is_empty() {
                    self.say(job, &String::from_utf8_lossy(&rest));
                }
            }
            let status = child.wait().await;
            (status, keep_o, keep_e)
        };
        match tokio::time::timeout(limit, pump).await {
            Ok((status, o, e)) => Out {
                code: status.ok().and_then(|s| s.code()),
                stdout: tail(&String::from_utf8_lossy(&o), crate::daemon::OUTPUT_LIMIT),
                stderr: tail(&String::from_utf8_lossy(&e), crate::daemon::OUTPUT_LIMIT),
            },
            Err(_) => {
                let m = format!("{program} 超过 {} 秒没有结束，已停止", limit.as_secs());
                self.line(job, &m);
                Out { code: None, stdout: String::new(), stderr: m }
            }
        }
    }

    fn not_run(&self, job: u64, m: String) -> Out {
        self.line(job, &m);
        Out { code: None, stdout: String::new(), stderr: m }
    }
}

enum Source {
    Existing(PathBuf),
    /// (parent, parent/<name>)
    Clone(PathBuf, PathBuf),
}

fn code_word(o: &Out) -> String {
    match o.code {
        Some(c) => format!("退出码 {c}"),
        None => "没有正常结束".into(),
    }
}

/// The complete UTF-8 text of `pending + bytes`; an incomplete last character stays in `pending`.
fn take_utf8(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    let cut = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => pending.len(),
    };
    let rest = pending.split_off(cut);
    let text = String::from_utf8_lossy(pending).to_string();
    *pending = rest;
    text
}

/// Copies of `want` (`owner/name`, lowercased) below the usual folders: git repositories (a `.git`
/// folder, not a worktree) whose origin is that repository. Hidden folders are not entered.
fn find_copies(home: &Path, want: &str) -> Vec<String> {
    let mut found: Vec<String> = vec![];
    let mut seen = 0usize;
    // the usual code folders first (deeper), then whatever sits right in HOME
    let mut roots: Vec<(PathBuf, usize)> = SEARCH_ROOTS.iter().map(|r| (home.join(r), SEARCH_DEPTH)).collect();
    roots.push((home.to_path_buf(), 1));
    let mut visited = std::collections::HashSet::new();
    for (root, depth) in roots {
        let mut stack = vec![(root, 0usize)];
        while let Some((d, level)) = stack.pop() {
            seen += 1;
            if seen > SEARCH_LIMIT {
                return found;
            }
            let Ok(real) = std::fs::canonicalize(&d) else { continue };
            if !visited.insert(real.clone()) {
                continue;
            }
            let git = real.join(".git");
            if git.is_dir() {
                if let Ok(text) = std::fs::read_to_string(git.join("config")) {
                    if origin_in_config(&text).and_then(|u| github_repo_of(&u)).as_deref() == Some(want) {
                        let s = real.to_string_lossy().to_string();
                        if !found.contains(&s) {
                            found.push(s);
                        }
                    }
                }
                continue;
            }
            if level >= depth {
                continue;
            }
            let Ok(rd) = std::fs::read_dir(&real) else { continue };
            let mut kids: Vec<PathBuf> = rd
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.') && e.file_name() != "Library" && e.file_name() != "node_modules")
                .map(|e| e.path())
                .collect();
            kids.sort();
            kids.reverse();
            stack.extend(kids.into_iter().map(|k| (k, level + 1)));
        }
    }
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_names() {
        assert_eq!(parse_repo("GigleAI/cavil-loop"), Some(("GigleAI".into(), "cavil-loop".into())));
        for bad in ["", "a", "a/b/c", "../x", "a/..", "a /b", "-a/b", "a/b;rm"] {
            assert_eq!(parse_repo(bad), None, "{bad}");
        }
    }

    #[test]
    fn remotes_name_a_github_repository() {
        for u in ["https://github.com/GigleAI/Cavil-Loop.git", "https://github.com/gigleai/cavil-loop", "git@github.com:GigleAI/cavil-loop.git", "ssh://git@github.com/GigleAI/cavil-loop.git", "https://x@github.com/GigleAI/cavil-loop/"] {
            assert_eq!(github_repo_of(u).as_deref(), Some("gigleai/cavil-loop"), "{u}");
        }
        for u in ["https://gitlab.com/GigleAI/cavil-loop.git", "http://github.com/a/b", "/tmp/a/b", "https://github.com/a", "https://github.com.evil.example/a/b", "file:///github.com/a/b"] {
            assert_eq!(github_repo_of(u), None, "{u}");
        }
    }

    #[test]
    fn origin_from_a_git_config() {
        let t = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://github.com/x/y.git\n[remote \"origin\"]\n\turl = git@github.com:a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n";
        assert_eq!(origin_in_config(t).as_deref(), Some("git@github.com:a/b.git"));
        assert_eq!(origin_in_config("[remote \"upstream\"]\nurl = x\n"), None);
    }

    #[test]
    fn keys_avoid_other_projects() {
        let d = Path::new("/h/github/widget");
        assert_eq!(pick_key(d, "acme", "widget", &[]).as_deref(), Some("widget"));
        let other = vec![("widget".to_string(), Some("/h/elsewhere/widget".to_string()))];
        assert_eq!(pick_key(d, "acme", "widget", &other).as_deref(), Some("acme-widget"));
        let same = vec![("widget".to_string(), Some("/h/github/widget".to_string()))];
        assert_eq!(pick_key(d, "acme", "widget", &same).as_deref(), Some("widget"));
        let both = vec![("widget".to_string(), None), ("acme-widget".to_string(), None)];
        assert_eq!(pick_key(d, "acme", "widget", &both), None);
        // a folder name setup.sh would refuse
        assert_eq!(pick_key(Path::new("/h/my widget"), "acme", "widget", &[]).as_deref(), Some("acme-widget"));
    }

    #[test]
    fn utf8_split_across_reads() {
        let bytes = "接上".as_bytes();
        let mut p = vec![];
        assert_eq!(take_utf8(&mut p, &bytes[..2]), "");
        assert_eq!(take_utf8(&mut p, &bytes[2..4]), "接");
        assert_eq!(take_utf8(&mut p, &bytes[4..]), "上");
        assert!(p.is_empty());
    }

    #[test]
    fn an_existing_config_must_name_the_chosen_repository() {
        let st = |pc: Value| json!({ "project_check": pc });
        let d = "/h/github/widget";
        let read = |repo: &str, agent: &str| st(json!({ "dir": d, "config": "/h/github/widget/cavil-loop.config", "config_state": "ok", "repo": repo, "worker_agent": agent }));
        assert_eq!(parse_project_check(&st(json!({ "dir": d, "config": null, "config_state": "none" })), d), Ok(ExistingConfig::None));
        let c = parse_project_check(&read("Acme/Widget", "codex"), d).unwrap();
        assert_eq!(config_verdict(&c, "acme", "widget"), Ok(Some(("/h/github/widget/cavil-loop.config".into(), "codex".into()))));
        let other = parse_project_check(&read("acme/other", "claude"), d).unwrap();
        assert!(config_verdict(&other, "acme", "widget").unwrap_err().contains("acme/other"));
        let empty = parse_project_check(&read("", "claude"), d).unwrap();
        assert!(config_verdict(&empty, "acme", "widget").unwrap_err().contains("没写"));
        let bad = parse_project_check(&st(json!({ "dir": d, "config": "/x", "config_state": "unreadable" })), d).unwrap();
        assert!(config_verdict(&bad, "acme", "widget").is_err());
        // no answer for this folder (an older daemon, or another folder) is never "no config"
        assert!(parse_project_check(&json!({}), d).is_err());
        assert!(parse_project_check(&st(json!({ "dir": "/elsewhere", "config_state": "none" })), d).is_err());
        assert!(parse_project_check(&st(json!({ "dir": d, "config_state": "maybe" })), d).is_err());
    }
}
