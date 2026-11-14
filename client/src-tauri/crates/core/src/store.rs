// Local store (SQLite, compiled in). Only ever written from GitHub or from the
// user's own settings; nothing here is ever sent back up. Same file layout as
// the Electron build (client <= 0.2), so a profile carries over.
//
// The back end owns the file. The window only reaches it through the commands
// in api.rs, which refuse the keys that describe the credential (see SECRET_KEYS).

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

// 2: items carry node ids, Project items their ids, Projects their field ids
// 3: items also carry author / parent / sub-issues / linked PRs, Projects their saved views (#137)
const SCHEMA_VERSION: i64 = 3;

/// Settings that describe the credential: written by the back end only, never shown to the window.
pub const TRUSTED: &str = "trustedCredentials";
pub const CACHE_CREDENTIAL: &str = "cacheCredential";
pub const CACHE_OWNER: &str = "cacheOwner";
pub const GRANT_CLIENT_ID: &str = "grantClientId";
pub const SECRET_KEYS: [&str; 4] = [TRUSTED, CACHE_CREDENTIAL, CACHE_OWNER, GRANT_CLIENT_ID];
/// The signed-in account's login (GitHub#266): the window reads it, only the back end writes it,
/// and only under the session check — a window write could arrive after a sign-out and put the
/// previous account's name back.
pub const VIEWER: &str = "viewer";
/// Settings the window may read but never write.
pub const BACKEND_ONLY_KEYS: [&str; 2] = [VIEWER, crate::remote::REMOTES];

pub struct Store {
    db: Mutex<Connection>,
    /// next to the database: "a sign-out happened whose trust-list write failed" (see `mark_signed_out`)
    marker: std::path::PathBuf,
}

/// File name of the sign-out marker, next to the database.
pub const SIGNED_OUT_MARKER: &str = "signed-out";

/// GitHub#471: a database error, its own words kept apart (`raw`) so a message can show them as
/// written next to the client's own explanation; as one string it reads "本地存储出错：…" in the
/// window's language, as before.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreError {
    pub raw: String,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&crate::i18n::tr("本地存储出错：{e}", &[("e", &self.raw)]))
    }
}

impl StoreError {
    /// as a message: the client's prefix in the window's language, the database's own words in the hole
    pub fn said(&self) -> crate::i18n::Said {
        crate::i18n::Said::new("本地存储出错：{e}", &[("e", &self.raw)], "system")
    }
}

impl std::error::Error for StoreError {}

impl From<StoreError> for String {
    fn from(e: StoreError) -> String {
        e.to_string()
    }
}

fn err(e: impl std::fmt::Display) -> StoreError {
    StoreError { raw: e.to_string() }
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let db = Connection::open(path).map_err(err)?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS snapshot (source_key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS setting (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
        )
        .map_err(err)?;
        let row: Option<String> = db.query_row("SELECT v FROM meta WHERE k = 'schema'", [], |r| r.get(0)).optional().map_err(err)?;
        match row {
            None => {
                db.execute("INSERT INTO meta (k, v) VALUES ('schema', ?1)", params![SCHEMA_VERSION.to_string()]).map_err(err)?;
            }
            Some(v) if v.parse::<i64>().ok() != Some(SCHEMA_VERSION) => {
                // The cache is rebuildable from GitHub; an unknown layout is simply dropped.
                db.execute_batch("DELETE FROM snapshot;").map_err(err)?;
                db.execute("UPDATE meta SET v = ?1 WHERE k = 'schema'", params![SCHEMA_VERSION.to_string()]).map_err(err)?;
            }
            _ => {}
        }
        let marker = path.parent().map(|d| d.join(SIGNED_OUT_MARKER)).unwrap_or_else(|| SIGNED_OUT_MARKER.into());
        Ok(Store { db: Mutex::new(db), marker })
    }

    /// A second, independent record that the user signed out, for when the database
    /// refused the trust-list write (GitHub#151 review): written and synced to disk,
    /// then the folder entry synced. While it exists, start-up trusts no stored credential.
    pub fn mark_signed_out(&self) -> Result<(), StoreError> {
        use std::io::Write;
        let mut f = std::fs::File::create(&self.marker).map_err(err)?;
        f.write_all(b"1\n").map_err(err)?;
        f.sync_all().map_err(err)?;
        if let Some(dir) = self.marker.parent() {
            if let Ok(d) = std::fs::File::open(dir) {
                let _ = d.sync_all(); // best effort: not every platform syncs a directory handle
            }
        }
        Ok(())
    }

    pub fn signed_out_marked(&self) -> bool {
        self.marker.exists()
    }

    /// Only once the trust list is empty on disk and the credential is gone.
    pub fn clear_signed_out_mark(&self) -> Result<(), StoreError> {
        match std::fs::remove_file(&self.marker) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(err(e)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn get_setting(&self, k: &str) -> Option<Value> {
        let db = self.lock();
        let v: Option<String> = db.query_row("SELECT v FROM setting WHERE k = ?1", params![k], |r| r.get(0)).optional().ok().flatten();
        v.and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn get_str(&self, k: &str) -> Option<String> {
        self.get_setting(k).and_then(|v| v.as_str().map(str::to_string))
    }

    pub fn set_setting(&self, k: &str, v: &Value) -> Result<(), StoreError> {
        let db = self.lock();
        set_in(&db, k, v)
    }

    pub fn all_settings(&self) -> Vec<(String, Value)> {
        let db = self.lock();
        let mut out = vec![];
        if let Ok(mut st) = db.prepare("SELECT k, v FROM setting") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                for (k, v) in rows.flatten() {
                    if let Ok(v) = serde_json::from_str(&v) {
                        out.push((k, v));
                    }
                }
            }
        }
        out
    }

    pub fn snapshot_count(&self) -> i64 {
        self.lock().query_row("SELECT COUNT(*) FROM snapshot", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn load_snapshots(&self) -> Vec<Value> {
        let db = self.lock();
        let mut out = vec![];
        if let Ok(mut st) = db.prepare("SELECT data FROM snapshot") {
            if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) {
                // a corrupt row is dropped; the next sync rewrites it
                for s in rows.flatten() {
                    if let Ok(v) = serde_json::from_str(&s) {
                        out.push(v);
                    }
                }
            }
        }
        out
    }

    /// Replace whole snapshots (one row per source) in one transaction.
    pub fn replace_snapshots(&self, snaps: &[Value]) -> Result<(), String> {
        if snaps.is_empty() {
            return Ok(());
        }
        let mut db = self.lock();
        let tx = db.transaction().map_err(err)?;
        for s in snaps {
            let key = s.get("sourceKey").and_then(|v| v.as_str()).ok_or_else(|| crate::i18n::tr("快照缺少 {field}", &[("field", "sourceKey")]))?;
            let at = s.get("fetchedAt").and_then(|v| v.as_f64()).ok_or_else(|| crate::i18n::tr("快照缺少 {field}", &[("field", "fetchedAt")]))? as i64;
            tx.execute(
                "INSERT INTO snapshot (source_key, fetched_at, data) VALUES (?1, ?2, ?3)
                 ON CONFLICT(source_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data",
                params![key, at, s.to_string()],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(|e| String::from(err(e)))
    }

    pub fn delete_snapshot(&self, key: &str) -> Result<(), String> {
        self.lock().execute("DELETE FROM snapshot WHERE source_key = ?1", params![key]).map(|_| ()).map_err(|e| String::from(err(e)))
    }

    /// Several setting writes plus (optionally) dropping every snapshot, as one transaction.
    pub fn write_all(&self, settings: &[(&str, Value)], wipe_snapshots: bool) -> Result<(), StoreError> {
        let mut db = self.lock();
        let tx = db.transaction().map_err(err)?;
        if wipe_snapshots {
            tx.execute_batch("DELETE FROM snapshot;").map_err(err)?;
        }
        for (k, v) in settings {
            set_in(&tx, k, v)?;
        }
        tx.commit().map_err(err)
    }
}

fn set_in(db: &Connection, k: &str, v: &Value) -> Result<(), StoreError> {
    db.execute(
        "INSERT INTO setting (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        params![k, v.to_string()],
    )
    .map(|_| ())
    .map_err(err)
}
