// Updating the app itself (GitHub#184): when to look, which release is the
// new one, and what the window shows while it downloads and installs.
//
// The work that touches the installed app — reading the release's update
// manifest, downloading the package, checking its signature, swapping the
// bundle — is the shell's (src-tauri/src/updater.rs, Tauri's updater plugin).
// Everything that decides is here, once, so the app and the test harness run
// the same code:
//   - which release: `pick` (the client's own `client/vX.Y.Z` releases; on the development
//     channel also the `client/vX.Y.Z-dev.N` pre-releases built from main, GitHub#215)
//   - when: at start, then every `every_ms` while automatic checks are on, or when asked
//   - one round at a time; a round that finds nothing / fails never reads as "up to date"
//   - a download that receives nothing for `stall_ms` is given up
//   - switching the channel mid-round: the round is dropped (a download is stopped) and one
//     starts on the new channel; only while the new app is being put in place is switching refused
//
// No GitHub credential is used: the repository is public, the release list is
// read without a token.

use crate::http::{self, Endpoints, HttpRequest};
use crate::platform::Clock;
use crate::store::Store;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

/// The repository the client's releases live in.
pub const REPO: &str = "GigleAI/cavil-loop";
/// Tags of the client's releases (the daemon's weekly releases are `release/v…`).
pub const TAG_PREFIX: &str = "client/v";
/// The release asset the updater reads.
pub const MANIFEST: &str = "latest.json";
/// Release pages read at most (100 releases each, newest first). A list that is still going on
/// the last of them was not read to its end: that round fails, it never reads as "up to date".
pub const MAX_PAGES: u32 = 10;

/// Kept settings (the local store).
pub const AUTO_KEY: &str = "update.auto";
pub const DISMISSED_KEY: &str = "update.dismissed";
pub const CHANNEL_KEY: &str = "update.channel";
/// What the last installed update changed (GitHub#348): the notes of that round, kept at the moment
/// the new app is in place so the restarted app can still show them.
pub const INSTALLED_KEY: &str = "update.installed";
/// The "updated to X" notice was closed for this version.
pub const INSTALLED_SEEN_KEY: &str = "update.installedSeen";

/// Which releases an app updates to (GitHub#215).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    /// the tagged `client/vX.Y.Z` releases (the default)
    Stable,
    /// also the `client/vX.Y.Z-dev.N` pre-releases CI publishes from main
    Dev,
}

impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Dev => "dev",
        }
    }
    /// What the store / the window says; anything else is not a channel.
    pub fn parse(s: &str) -> Option<Channel> {
        match s {
            "stable" => Some(Channel::Stable),
            "dev" => Some(Channel::Dev),
            _ => None,
        }
    }
}

/// The machines development builds are published for (updater platform keys). The release job's
/// manifest builder has the same table (scripts/update-manifest.mjs `CHANNEL_PLATFORMS.dev`);
/// test/unit/update-manifest.test.ts compares the two.
pub const DEV_TARGETS: &[&str] = &["darwin-aarch64"];

/// Why the development channel cannot be chosen on a machine with no development builds.
pub const NO_DEV_BUILD: &str = "开发版只有 Apple 芯片的包，这台 Mac 只能用正式版";

#[derive(Clone, Copy, Debug)]
pub struct Timings {
    /// between automatic checks
    pub every_ms: i64,
    /// the release list and the manifest: no answer within this = failed
    pub query_timeout_ms: i64,
    /// a download that gets no data for this long is given up
    pub stall_ms: i64,
    /// how often the download watchdog looks
    pub poll_ms: i64,
}

impl Default for Timings {
    fn default() -> Timings {
        Timings { every_ms: 6 * 3600 * 1000, query_timeout_ms: 30_000, stall_ms: 60_000, poll_ms: 1_000 }
    }
}

/// A version this app installs: `X.Y.Z` (a release) or `X.Y.Z-dev.N` (a development build).
/// Ordered as semver orders them — what the updater plugin compares with: the same X.Y.Z with no
/// suffix is newer than any of its development builds; development builds by N as a number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Version {
    pub core: (u64, u64, u64),
    /// N of `-dev.N`; None = a release
    pub dev: Option<u64>,
}

impl Ord for Version {
    fn cmp(&self, o: &Version) -> std::cmp::Ordering {
        self.core.cmp(&o.core).then_with(|| match (self.dev, o.dev) {
            (None, None) => std::cmp::Ordering::Equal,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
            (Some(a), Some(b)) => a.cmp(&b),
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Version) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (a, b, c) = self.core;
        match self.dev {
            None => write!(f, "{a}.{b}.{c}"),
            Some(n) => write!(f, "{a}.{b}.{c}-dev.{n}"),
        }
    }
}

/// Digits only, no leading zero (`0` itself is fine).
fn number(p: &str) -> Option<u64> {
    if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) || (p.len() > 1 && p.starts_with('0')) {
        return None;
    }
    p.parse().ok()
}

/// `X.Y.Z` or `X.Y.Z-dev.N`, digits only, no leading zeros. Anything else is not a version this app
/// installs (`-rc.1`, `-dev.01`, `-dev.`, build metadata…).
pub fn parse_version(s: &str) -> Option<Version> {
    let (core, dev) = match s.split_once('-') {
        None => (s, None),
        Some((core, rest)) => (core, Some(number(rest.strip_prefix("dev.")?)?)),
    };
    let mut it = core.split('.');
    let mut n = || number(it.next()?);
    let v = (n()?, n()?, n()?);
    if it.next().is_some() {
        return None;
    }
    Some(Version { core: v, dev })
}

/// The release to update to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pick {
    pub version: String,
    pub tag: String,
    /// where the release's update manifest is
    pub manifest_url: String,
}

/// The version a release's tag names, when it is one of the client's (`client/v` + a version).
fn tagged_version(r: &Value) -> Option<Version> {
    r["tag_name"].as_str().and_then(|t| t.strip_prefix(TAG_PREFIX)).and_then(parse_version)
}

/// The version of one entry of the release list, when it is a release this app installs on
/// `channel` (the rule in `pick`'s comment). One rule for choosing the release to update to and for
/// listing what the versions in between changed (`notes`).
fn installable(r: &Value, channel: Channel) -> Option<Version> {
    if r["draft"] != json!(false) || !r["prerelease"].is_boolean() {
        return None;
    }
    let v = tagged_version(r)?;
    let pre = r["prerelease"] == json!(true);
    let wanted = match v.dev {
        None => !pre,
        Some(_) => pre && channel == Channel::Dev,
    };
    wanted.then_some(v)
}

/// Out of the release list (pages as GitHub returned them), the newest release of the client
/// that is newer than `current`, on `channel`. Ok(None) = there is none. Err = the list cannot be
/// read, or the newest release cannot be updated to (no manifest, a manifest outside this
/// repository's downloads).
///
/// A release counts when it is not a draft and its tag is `client/v` + a version, and:
///   - `X.Y.Z`: not marked pre-release (both channels)
///   - `X.Y.Z-dev.N`: marked pre-release, and only on the development channel
/// Any other mix (a pre-release on a release version, a development version not marked
/// pre-release) is not one this app installs.
pub fn pick(pages: &[Value], current: &str, web: &str, channel: Channel) -> Result<Option<Pick>, String> {
    let cur = parse_version(current).ok_or_else(|| format!("当前版本号看不懂：{current}"))?;
    let mut best: Option<(Version, &Value)> = None;
    for page in pages {
        let list = page.as_array().ok_or("GitHub 返回的发版列表看不懂")?;
        for r in list {
            let Some(v) = installable(r, channel) else { continue };
            if v <= cur || best.is_some_and(|(b, _)| v <= b) {
                continue;
            }
            best = Some((v, r));
        }
    }
    let Some((v, r)) = best else { return Ok(None) };
    let version = v.to_string();
    let tag = r["tag_name"].as_str().unwrap_or_default().to_string();
    let assets = r["assets"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let url = assets
        .iter()
        .find(|x| x["name"] == MANIFEST)
        .and_then(|x| x["browser_download_url"].as_str())
        .ok_or_else(|| format!("新版 {version} 的发版里没有更新说明文件（{MANIFEST}）"))?;
    let base = format!("{}/{REPO}/releases/download/", web.trim_end_matches('/'));
    if !url.starts_with(&base) || !http::under(&base, url) {
        return Err(format!("新版 {version} 的更新说明文件不在本仓库的下载地址下：{url}"));
    }
    Ok(Some(Pick { version, tag, manifest_url: url.to_string() }))
}

// ---- what the versions in between changed (GitHub#348) ---------------------------------
//
// Read out of the release list the round already has: no further request, no credential. Every
// installable release above the running version and up to the one being installed is listed, each
// with what its release page says. Nothing here can fail a round: a page that says nothing readable
// is listed with no items.

/// The heading the development build's publisher puts above the notes it adds to a release page
/// (scripts/dev-release.mjs `NOTES_HEADING`; test/fixtures/update-notes/dev-body.md is written by
/// that script and read by this parser).
pub const NOTES_HEADING: &str = "### 更新内容";
/// The heading of the current version's part of the release notes (RELEASE_NOTES.md), which is the
/// whole body of a tagged release's page.
pub const RELEASE_HEADING_PREFIX: &str = "### 这一版";
/// Versions listed at most (the newest ones); the rest is counted in `more`.
pub const MAX_NOTE_VERSIONS: usize = 30;
/// Items listed per version at most; the rest is counted in that version's `more`.
pub const MAX_NOTE_ITEMS: usize = 20;
/// Characters kept of an item's title, and of its description.
pub const MAX_NOTE_CHARS: usize = 2000;

/// The first `max` characters, with an ellipsis when something was cut.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Shown as plain text: the markdown marks the release notes use are taken off, nothing is rendered.
fn plain(s: &str) -> String {
    s.replace("**", "").replace('`', "").trim().to_string()
}

/// One `- ` line of release notes → { title, more }. `- **title**（GitHub#N）：description` gives the
/// bold part (with the bracket right behind it) as the title and the rest as the description;
/// any other line is a title alone.
fn note_item(line: &str) -> Value {
    let text = line.trim();
    let split = text.strip_prefix("**").and_then(|rest| rest.find("**").map(|i| (&rest[..i], &rest[i + 2..])));
    let (title, more) = match split {
        Some((bold, rest)) if !bold.trim().is_empty() => {
            let mut title = bold.to_string();
            let mut rest = rest;
            if rest.starts_with('（') {
                if let Some(i) = rest.find('）') {
                    let end = i + '）'.len_utf8();
                    title.push_str(&rest[..end]);
                    rest = &rest[end..];
                }
            }
            let rest = rest.trim_start().trim_start_matches(['：', ':']).trim();
            (title, (!rest.is_empty()).then(|| rest.to_string()))
        }
        _ => (text.to_string(), None),
    };
    json!({ "title": clip(&plain(&title), MAX_NOTE_CHARS), "more": more.map(|m| clip(&plain(&m), MAX_NOTE_CHARS)) })
}

/// The `- ` lines under the first heading line `is_heading` accepts, up to the next heading.
fn section_items<'a>(body: &'a str, is_heading: impl Fn(&str) -> bool) -> Option<Vec<&'a str>> {
    let mut lines = body.lines().map(|l| l.trim_end_matches('\r'));
    lines.by_ref().find(|l| is_heading(l.trim()))?;
    Some(lines.take_while(|l| !l.starts_with('#')).filter_map(|l| l.strip_prefix("- ")).filter(|l| !l.trim().is_empty()).collect())
}

/// What one release page says changed, as raw note lines (without the `- `):
///   1. the notes the publisher added under `NOTES_HEADING`, when there are any
///   2. a tagged release: the current version's part of the release notes
///   3. a development build: the commit title its first line ends with
///      (`开发版 X，构建自 main 的 <commit>：<title>`)
/// Nothing readable → no lines.
fn body_lines(body: &str, dev: bool) -> Vec<String> {
    if let Some(items) = section_items(body, |l| l == NOTES_HEADING).filter(|i| !i.is_empty()) {
        return items.into_iter().map(str::to_string).collect();
    }
    if !dev {
        return section_items(body, |l| l.starts_with(RELEASE_HEADING_PREFIX)).unwrap_or_default().into_iter().map(str::to_string).collect();
    }
    let first = body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    match first.strip_prefix("开发版 ").and_then(|l| l.split_once('：')) {
        Some((_, title)) if !title.trim().is_empty() => vec![title.trim().to_string()],
        _ => vec![],
    }
}

/// What every version above `current` and up to `to` changed, on `channel`, newest first:
/// `{ from, to, complete, more, entries: [{ version, at, items: [{ title, more }], more }] }`.
/// Null when no release in that range is in the list (or a version cannot be read).
///
/// `complete` = the running version's own release page is still in the list, so nothing between it
/// and `to` can have been cleaned away (only the newest development builds are kept). When it is
/// not, older versions may be missing and the window says so.
///
/// A note line that an older version in the range already carries, or that the running version's
/// page carries, is not repeated (a tagged release's page holds the whole notes of its series).
pub fn notes(pages: &[Value], current: &str, to: &str, channel: Channel) -> Value {
    let (Some(cur), Some(top)) = (parse_version(current), parse_version(to)) else { return Value::Null };
    let mut found: Vec<(Version, &Value)> = vec![];
    let mut seen: std::collections::HashSet<String> = Default::default();
    let mut complete = false;
    for r in pages.iter().filter_map(Value::as_array).flatten() {
        if tagged_version(r) == Some(cur) && r["draft"] == json!(false) {
            complete = true;
            seen.extend(r["body"].as_str().unwrap_or("").lines().filter_map(|l| l.trim_end_matches('\r').strip_prefix("- ")).map(str::to_string));
        }
        let Some(v) = installable(r, channel) else { continue };
        if v > cur && v <= top && !found.iter().any(|(f, _)| *f == v) {
            found.push((v, r));
        }
    }
    if found.is_empty() {
        return Value::Null;
    }
    // oldest first, so a repeated line stays with the version that brought it
    found.sort_by(|a, b| a.0.cmp(&b.0));
    let mut entries: Vec<Value> = vec![];
    for (v, r) in found {
        let lines: Vec<String> = body_lines(r["body"].as_str().unwrap_or(""), v.dev.is_some()).into_iter().filter(|l| seen.insert(l.clone())).collect();
        let more = lines.len().saturating_sub(MAX_NOTE_ITEMS);
        let items: Vec<Value> = lines.iter().take(MAX_NOTE_ITEMS).map(|l| note_item(l)).collect();
        entries.push(json!({ "version": v.to_string(), "at": r["published_at"].as_str(), "items": items, "more": more }));
    }
    entries.reverse();
    let more = entries.len().saturating_sub(MAX_NOTE_VERSIONS);
    entries.truncate(MAX_NOTE_VERSIONS);
    json!({ "from": cur.to_string(), "to": top.to_string(), "complete": complete, "more": more, "entries": entries })
}

/// The whole release list, page by page, until a page has fewer than 100 entries. No credential.
/// Any page that fails fails the whole read; so does a list longer than MAX_PAGES pages (its end
/// was never seen, so "nothing newer" could not be told).
pub async fn fetch_releases(ep: &Endpoints) -> Result<Vec<Value>, String> {
    let mut pages = vec![];
    for page in 1..=MAX_PAGES {
        let res = http::send(HttpRequest {
            method: "GET".into(),
            url: format!("{}/repos/{REPO}/releases?per_page=100&page={page}", ep.api),
            headers: vec![("Accept".into(), "application/vnd.github+json".into()), ("User-Agent".into(), "cavil-loop-client".into())],
            body: None,
        })
        .await
        .map_err(|e| format!("连不上 GitHub（{e}）"))?;
        if res.status != 200 {
            return Err(format!("GitHub 返回 HTTP {}", res.status));
        }
        let v: Value = serde_json::from_str(&res.body).map_err(|_| "GitHub 返回的发版列表看不懂".to_string())?;
        let n = v.as_array().map(Vec::len).ok_or("GitHub 返回的发版列表看不懂")?;
        pages.push(v);
        if n < 100 {
            return Ok(pages);
        }
    }
    Err(format!("发版列表超过 {MAX_PAGES} 页，没读完"))
}

/// Why a step of a round failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// no answer / connection broke / a status that is not success
    Network(String),
    /// the answer could not be used (unreadable manifest, no package for this machine)
    Invalid(String),
    /// the package's signature does not match: never installed
    Signature(String),
    /// putting the new app in place failed (the old one stays)
    Install(String),
}

impl Failure {
    fn message(&self) -> &str {
        match self {
            Failure::Network(m) | Failure::Invalid(m) | Failure::Signature(m) | Failure::Install(m) => m,
        }
    }
}

/// What the manifest announced, for this machine.
#[derive(Clone, Debug)]
pub struct Found {
    pub version: String,
    /// the backend's own handle on it (the shell keeps the plugin's update object behind it)
    pub id: u64,
}

/// The parts of a round that touch the network and the installed app.
#[async_trait]
pub trait Backend: Send + Sync {
    /// The release list (`fetch_releases` in the app).
    async fn releases(&self) -> Result<Vec<Value>, String>;
    /// Read the manifest at `url`. Ok(None) = it announces nothing newer than this app.
    async fn check(&self, url: &str) -> Result<Option<Found>, Failure>;
    /// Download the package and check its signature; `got(bytes so far, total if known)` after
    /// every piece. Dropping the future stops the download.
    async fn download(&self, found: &Found, got: Box<dyn Fn(u64, Option<u64>) + Send + Sync>) -> Result<Vec<u8>, Failure>;
    /// Put the downloaded package in place of the installed app.
    async fn install(&self, found: &Found, bytes: Vec<u8>) -> Result<(), Failure>;
}

#[derive(Clone, Debug, PartialEq)]
enum Phase {
    Idle,
    Checking,
    Downloading { version: String, got: u64, total: Option<u64> },
    /// the new app is being put in place: cannot be stopped, so the channel cannot change now
    Installing { version: String },
    Ready { version: String },
}

#[derive(Clone, Debug)]
struct Last {
    at: i64,
    ok: bool,
    message: String,
}

struct Inner {
    phase: Phase,
    last: Option<Last>,
    /// Bumped (under this lock, together with the stored channel) whenever the channel changes.
    /// A round remembers the one it started with; once it differs, whatever that round found is
    /// for the other channel: dropped, never downloaded on, never installed.
    generation: u64,
    /// What the versions up to the one this round found changed (`notes`); shown while that
    /// version downloads, installs and waits for the restart, gone with the round otherwise.
    notes: Value,
}

/// What a round that was overtaken by a channel switch returns (never shown: the round is rerun).
const SWITCHED: &str = "渠道已切换";

/// The updater: one per app.
pub struct Updater {
    backend: Arc<dyn Backend>,
    clock: Arc<dyn Clock>,
    store: Arc<Store>,
    current: String,
    /// the web base release downloads must be under (https://github.com; a loopback fake in tests)
    web: String,
    timings: Timings,
    /// why this app cannot update itself at all (shown, never checks)
    problem: Option<String>,
    /// development builds are published for this machine (`DEV_TARGETS`)
    dev_supported: bool,
    inner: Mutex<Inner>,
    /// `Inner::generation`, for the parts of a round that wait (they stop as soon as it moves)
    generation: watch::Sender<u64>,
    changed: Box<dyn Fn(Value) + Send + Sync>,
}

impl Updater {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        backend: Arc<dyn Backend>,
        clock: Arc<dyn Clock>,
        store: Arc<Store>,
        current: &str,
        web: &str,
        timings: Timings,
        problem: Option<String>,
        dev_supported: bool,
        changed: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Arc<Updater> {
        Arc::new(Updater {
            backend,
            clock,
            store,
            current: current.to_string(),
            web: web.trim_end_matches('/').to_string(),
            timings,
            problem,
            dev_supported,
            inner: Mutex::new(Inner { phase: Phase::Idle, last: None, generation: 0, notes: Value::Null }),
            generation: watch::Sender::new(0),
            changed,
        })
    }

    /// Automatic checks (on unless turned off).
    pub fn auto(&self) -> bool {
        self.store.get_setting(AUTO_KEY).and_then(|v| v.as_bool()).unwrap_or(true)
    }

    pub fn set_auto(&self, on: bool) -> Result<(), String> {
        self.store.set_setting(AUTO_KEY, &json!(on))?;
        self.emit();
        Ok(())
    }

    /// The channel in effect: what was chosen, the release channel when nothing (or nothing
    /// readable) was, and always the release channel on a machine with no development builds.
    pub fn channel(&self) -> Channel {
        match self.store.get_str(CHANNEL_KEY).as_deref().and_then(Channel::parse) {
            Some(Channel::Dev) if self.dev_supported => Channel::Dev,
            _ => Channel::Stable,
        }
    }

    /// Choose the channel (kept). A round running now is dropped and the caller's next check runs
    /// on the new channel; refused while the new app is being put in place.
    pub fn set_channel(&self, c: Channel) -> Result<(), String> {
        if c == Channel::Dev && !self.dev_supported {
            return Err(NO_DEV_BUILD.into());
        }
        {
            let mut g = self.inner.lock().unwrap();
            if let Phase::Installing { version } = &g.phase {
                return Err(format!("正在安装 {version}，装好后可以切换"));
            }
            if self.channel() != c {
                self.store.set_setting(CHANNEL_KEY, &json!(c.name()))?;
                g.generation += 1;
                self.generation.send_replace(g.generation);
                // a round in flight is now for the other channel: what it was fetching is no longer
                // what is shown (it starts over, on this channel)
                if matches!(g.phase, Phase::Downloading { .. }) {
                    g.phase = Phase::Checking;
                }
            }
        }
        self.emit();
        Ok(())
    }

    /// The ready banner for `version` was closed: not shown again for that version.
    pub fn dismiss(&self, version: &str) -> Result<(), String> {
        self.store.set_setting(DISMISSED_KEY, &json!(version))?;
        self.emit();
        Ok(())
    }

    /// The "updated to `version`" notice was closed: not shown again for that version (the notes
    /// stay readable from Settings).
    pub fn dismiss_installed(&self, version: &str) -> Result<(), String> {
        self.store.set_setting(INSTALLED_SEEN_KEY, &json!(version))?;
        self.emit();
        Ok(())
    }

    /// What the update this app was started from changed: the notes kept when it was installed,
    /// only when they are for the version running now (anything else — nothing kept, kept for
    /// another version, unreadable — is nothing to show).
    fn installed(&self) -> Value {
        let Some(mut v) = self.store.get_setting(INSTALLED_KEY).filter(|v| v["to"].as_str() == Some(self.current.as_str()) && v["entries"].is_array()) else {
            return Value::Null;
        };
        v["dismissed"] = json!(self.store.get_str(INSTALLED_SEEN_KEY).as_deref() == Some(self.current.as_str()));
        v
    }

    /// What the window shows.
    pub fn status(&self) -> Value {
        let (phase, last, notes) = {
            let g = self.inner.lock().unwrap();
            (g.phase.clone(), g.last.clone(), g.notes.clone())
        };
        let mut v = json!({
            "supported": true,
            "current": self.current,
            "auto": self.auto(),
            "channel": self.channel().name(),
            "devUnavailable": if self.dev_supported { Value::Null } else { json!(NO_DEV_BUILD) },
            "problem": self.problem,
            "dismissed": self.store.get_str(DISMISSED_KEY),
            "last": last.map(|l| json!({ "at": l.at, "ok": l.ok, "message": l.message })),
            "installed": self.installed(),
        });
        // the notes belong to the version on the screen: none while idle or checking
        v["notes"] = if matches!(phase, Phase::Idle | Phase::Checking) { Value::Null } else { notes };
        match phase {
            Phase::Idle => v["phase"] = json!("idle"),
            Phase::Checking => v["phase"] = json!("checking"),
            Phase::Downloading { version, got, total } => {
                v["phase"] = json!("downloading");
                v["version"] = json!(version);
                v["got"] = json!(got);
                v["total"] = json!(total);
            }
            Phase::Installing { version } => {
                v["phase"] = json!("installing");
                v["version"] = json!(version);
            }
            Phase::Ready { version } => {
                v["phase"] = json!("ready");
                v["version"] = json!(version);
            }
        }
        v
    }

    fn emit(&self) {
        (self.changed)(self.status());
    }

    fn set_phase(&self, p: Phase) {
        self.inner.lock().unwrap().phase = p;
        self.emit();
    }

    fn generation_now(&self) -> u64 {
        self.inner.lock().unwrap().generation
    }

    /// Start a round unless one is running or the new version is already in place.
    /// true = this call started it.
    fn begin(&self) -> bool {
        let mut g = self.inner.lock().unwrap();
        if g.phase != Phase::Idle || self.problem.is_some() {
            return false;
        }
        g.phase = Phase::Checking;
        true
    }

    async fn finish(&self, phase: Phase, ok: bool, message: String) {
        let at = self.clock.now().await;
        {
            let mut g = self.inner.lock().unwrap();
            g.phase = phase;
            g.last = Some(Last { at, ok, message });
        }
        self.emit();
    }

    /// One round, now (the settings page's button, the start-up check, the timer, a channel
    /// switch). Returns when it is over; a call while one runs returns at once (the running one
    /// shows its progress). A round overtaken by a channel switch is dropped and run again on the
    /// new channel, until one finishes on the channel still chosen.
    pub async fn check_now(self: &Arc<Self>) {
        if !self.begin() {
            self.emit();
            return;
        }
        self.emit();
        loop {
            let (generation, channel) = {
                let g = self.inner.lock().unwrap();
                (g.generation, self.channel())
            };
            let r = self.round(generation, channel).await;
            // installed = it started installing on this very generation (checked under the lock)
            if !matches!(r, Ok(Some(_))) && self.generation_now() != generation {
                self.set_phase(Phase::Checking);
                continue;
            }
            match r {
                Ok(Some(version)) => self.finish(Phase::Ready { version: version.clone() }, true, format!("新版 {version} 已下载，重启后生效")).await,
                Ok(None) => self.finish(Phase::Idle, true, "已是最新".into()).await,
                Err(m) => self.finish(Phase::Idle, false, m).await,
            }
            return;
        }
    }

    /// Ok(Some(v)) = v is in place; Ok(None) = nothing newer; Err = what to show.
    async fn round(self: &Arc<Self>, generation: u64, channel: Channel) -> Result<Option<String>, String> {
        let t = self.timings;
        let pages = self
            .unless_switched(generation, self.within(t.query_timeout_ms, self.backend.releases()))
            .await
            .ok_or(SWITCHED)?
            .ok_or("检查失败：GitHub 没有回应")?
            .map_err(|e| format!("检查失败：{e}"))?;
        let Some(p) = pick(&pages, &self.current, &self.web, channel).map_err(|e| format!("检查失败：{e}"))? else {
            return Ok(None);
        };
        let found = match self.unless_switched(generation, self.within(t.query_timeout_ms, self.backend.check(&p.manifest_url))).await.ok_or(SWITCHED)? {
            None => return Err("检查失败：GitHub 没有回应".into()),
            Some(Err(f)) => return Err(format!("检查失败：{}", f.message())),
            Some(Ok(None)) => return Ok(None),
            Some(Ok(Some(f))) => f,
        };
        let version = found.version.clone();
        let changes = notes(&pages, &self.current, &version, channel);
        {
            let mut g = self.inner.lock().unwrap();
            if g.generation != generation {
                return Err(SWITCHED.into());
            }
            g.phase = Phase::Downloading { version: version.clone(), got: 0, total: None };
            g.notes = changes.clone();
        }
        self.emit();
        let bytes = match self.unless_switched(generation, self.download_watched(&found, generation)).await.ok_or(SWITCHED)? {
            Ok(b) => b,
            Err(Failure::Signature(_)) => return Err(format!("新版 {version} 签名校验失败，没有安装")),
            Err(f) => return Err(format!("下载 {version} 失败：{}", f.message())),
        };
        // the last point a switch can stop this round: from here on the old app is being replaced
        {
            let mut g = self.inner.lock().unwrap();
            if g.generation != generation {
                return Err(SWITCHED.into());
            }
            g.phase = Phase::Installing { version: version.clone() };
        }
        self.emit();
        match self.backend.install(&found, bytes).await {
            Ok(()) => {
                // for the restarted app; not kept = that app shows nothing, the update is done all the same
                if !changes.is_null() {
                    let _ = self.store.set_setting(INSTALLED_KEY, &changes);
                }
                Ok(Some(version))
            }
            Err(Failure::Signature(_)) => Err(format!("新版 {version} 签名校验失败，没有安装")),
            Err(f) => Err(format!("安装 {version} 失败：{}", f.message())),
        }
    }

    /// `fut`'s result, or None as soon as the channel is switched (`fut` is dropped: a download stops).
    async fn unless_switched<T>(&self, generation: u64, fut: impl Future<Output = T>) -> Option<T> {
        let mut rx = self.generation.subscribe();
        let switched = async move {
            loop {
                if *rx.borrow_and_update() != generation {
                    return;
                }
                if rx.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        };
        tokio::select! {
            biased;
            _ = switched => None,
            r = fut => Some(r),
        }
    }

    /// The download, given up when no data arrives for `stall_ms` (a slow download that keeps
    /// receiving data is never given up).
    async fn download_watched(self: &Arc<Self>, found: &Found, generation: u64) -> Result<Vec<u8>, Failure> {
        let seen = Arc::new(AtomicU64::new(0));
        let me = Arc::downgrade(self);
        let counter = seen.clone();
        let version = found.version.clone();
        let progress: Box<dyn Fn(u64, Option<u64>) + Send + Sync> = Box::new(move |got, total| {
            counter.fetch_add(1, Ordering::SeqCst);
            let Some(u) = me.upgrade() else { return };
            // a download the round has let go of (a channel switch) may still report: it must not
            // put its version back on the screen
            {
                let mut g = u.inner.lock().unwrap();
                if g.generation != generation || !matches!(g.phase, Phase::Downloading { .. }) {
                    return;
                }
                g.phase = Phase::Downloading { version: version.clone(), got, total };
            }
            u.emit();
        });
        let watchdog = async {
            let mut last_n = seen.load(Ordering::SeqCst);
            let mut last_at = self.clock.now().await;
            loop {
                self.clock.sleep(self.timings.poll_ms).await;
                let n = seen.load(Ordering::SeqCst);
                let now = self.clock.now().await;
                if n != last_n {
                    last_n = n;
                    last_at = now;
                } else if now - last_at >= self.timings.stall_ms {
                    return Failure::Network(format!("{} 秒没有收到数据", self.timings.stall_ms / 1000));
                }
            }
        };
        tokio::select! {
            r = self.backend.download(found, progress) => r,
            f = watchdog => Err(f),
        }
    }

    /// `fut`'s result, or None when it has not answered within `ms`.
    async fn within<T>(&self, ms: i64, fut: impl Future<Output = T>) -> Option<T> {
        tokio::select! {
            r = fut => Some(r),
            _ = self.clock.sleep(ms) => None,
        }
    }

    /// The automatic checks, for the life of the app: one at start, then one every `every_ms`.
    /// Turned off = the timer still runs but no round starts. Ready = no more rounds (the new
    /// version is in place; a restart runs it).
    pub async fn run(self: Arc<Self>) {
        loop {
            if self.auto() {
                self.check_now().await;
            }
            self.clock.sleep(self.timings.every_ms).await;
        }
    }
}
