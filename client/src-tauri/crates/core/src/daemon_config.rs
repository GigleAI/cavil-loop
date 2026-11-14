// Settings → 本机 daemon → 配置 (GitHub#388): read and change the everyday
// settings of one connected project.
//
// Both requests run the daemon's own scripts/project-config.sh; nothing here
// parses a config file. What the window may name is narrow on purpose:
//   - a project key, never a path — the script takes the config's location
//     from the daemon's own registration of that project;
//   - setting names that the script's read, taken again right before the
//     save, lists as editable: commands, hooks, tokens and folders are not
//     registered there, so the window can neither see nor set them;
//   - values of a few plain characters only, handed over on standard input,
//     never on a command line.
// The script's last line is its verdict; none (killed, timed out) is
// "unconfirmed" — the file may or may not have changed, so the window says
// neither "saved" nor "nothing written".

use crate::daemon::{bad_key, busy, outside, plain, put_said, refused_s, tail, valid_key, Daemon, T_SHORT};
use crate::i18n::{tr, Said};
use serde_json::{json, Map, Value};

const SCRIPT: &str = "project-config.sh";
/// the save waits up to 15 s for another save's lock, then loads the config a few times
const T_SAVE: std::time::Duration = std::time::Duration::from_secs(120);

// valid_setting / valid_value / valid_rev are also the remote entry's rules for a save sent from another
// computer (GitHub#530, scripts/remote-access/remote_access.py config_request_problem): both read the
// same table of examples, tests/fixtures/config-request-shapes.json, in their own tests.

/// A setting's name as a config file writes it.
pub fn valid_setting(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty() && b.len() <= 64 && b[0].is_ascii_uppercase() && b.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// A value the script may write on one config line: no quote, `$`, backtick, backslash, blank or `;`
/// (scripts/project-config.sh LIT_CHARS). The script checks it again, against the setting's type.
pub fn valid_value(v: &str) -> bool {
    v.len() <= 200 && v.bytes().all(|c| c.is_ascii_alphanumeric() || b"._:/@,+-".contains(&c))
}

/// The fingerprint `get` hands out (sha-256, hex).
pub fn valid_rev(r: &str) -> bool {
    r.len() == 64 && r.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl Daemon {
    fn has_config_script(&self) -> Result<bool, Said> {
        Ok(self.entry_s()?.join("scripts").join(SCRIPT).is_file())
    }

    /// The script's `get`: Ok(its JSON, state "ok") or Err((result word, words for the person)).
    async fn config_read(&self, path: &str, key: &str) -> Result<Value, (String, Said)> {
        let out = self.script_s(path, SCRIPT, &["get", key], T_SHORT).await;
        let v: Value = match serde_json::from_str(out.stdout.trim()) {
            Ok(v) => v,
            Err(_) => {
                let shown = if out.note.is_none() && out.text().is_empty() { plain(tr("脚本没有输出", &[])) } else { out.said("daemon") };
                return Err(("unreadable".into(), Said::compose("读不到这个项目的配置：{e}", &[("e", &shown)])));
            }
        };
        if v["version"] != 1 {
            return Err(("unreadable".into(), Said::new("配置脚本输出的格式认不出（version = {v}），客户端可能需要更新", &[("v", &v["version"].to_string())], "daemon")));
        }
        match v["state"].as_str() {
            Some("ok") if out.ok() && v["fields"].is_array() && v["rev"].is_string() => Ok(v),
            Some("not_found") => Err((
                "not_found".into(),
                v["reason"].as_str().map(|r| outside(r, "daemon")).unwrap_or_else(|| plain(tr("本机没有接入这个项目", &[]))),
            )),
            // "unreadable" and anything this client does not know: never shown as "nothing set"
            _ => Err(("unreadable".into(), outside(&v["reason"].as_str().map(str::to_string).unwrap_or_else(|| tail(&out.text(), 2000)), "daemon"))),
        }
    }

    /// `{result:"ok", config}` / `{result:"unsupported"|"unreadable"|"not_found"|"refused", output}`
    pub async fn config_get(&self, key: &str) -> Value {
        if !valid_key(key) {
            return refused_s(&bad_key());
        }
        match self.has_config_script() {
            Ok(true) => {}
            Ok(false) => {
                let why = plain(tr("这份 daemon 还没有读写项目配置的脚本（早于 GitHub#388）：更新 daemon 后可以在这里用表单改，现在只能用编辑器打开配置文件", &[]));
                return put_said(json!({ "result": "unsupported" }), "output", &why);
            }
            Err(m) => return refused_s(&m),
        }
        let path = match self.path_s().await {
            Ok(p) => p,
            Err(m) => return refused_s(&m),
        };
        match self.config_read(&path, key).await {
            Ok(v) => json!({ "result": "ok", "config": v }),
            Err((word, why)) => put_said(json!({ "result": word }), "output", &why),
        }
    }

    /// `values`: `{SETTING: "value"}`. `{result: <the script's word> | "unconfirmed" | "refused", output, detail}`
    pub async fn config_set(&self, key: &str, rev: &str, values: &Value) -> Value {
        if !valid_key(key) {
            return refused_s(&bad_key());
        }
        if !valid_rev(rev) {
            return refused_s(&plain(tr("指纹不合规：先重新读取配置", &[])));
        }
        let Some(map) = values.as_object().filter(|m| !m.is_empty() && m.len() <= 64) else { return refused_s(&plain(tr("没有要改的配置项", &[]))) };
        let mut send = Map::new();
        for (name, v) in map {
            let Some(v) = v.as_str() else { return refused_s(&plain(tr("{name} 的值不是文本", &[("name", name)]))) };
            if !valid_setting(name) {
                return refused_s(&plain(tr("配置项的名字不合规", &[])));
            }
            if !valid_value(v) {
                return refused_s(&plain(tr("{name} 的值里有不能写进配置文件的字符", &[("name", name)])));
            }
            send.insert(name.clone(), Value::String(v.to_string()));
        }
        match self.has_config_script() {
            Ok(true) => {}
            Ok(false) => return refused_s(&plain(tr("这份 daemon 还没有读写项目配置的脚本", &[]))),
            Err(m) => return refused_s(&m),
        }
        let Ok(_g) = self.busy.try_lock() else { return refused_s(&busy()) };
        let path = match self.path_s().await {
            Ok(p) => p,
            Err(m) => return refused_s(&m),
        };
        // read again right before the save: only what the daemon lists as editable now goes out
        let now = match self.config_read(&path, key).await {
            Ok(v) => v,
            Err((_, why)) => return refused_s(&Said::compose("保存前重新读取配置失败，没有保存：{why}", &[("why", &why)])),
        };
        let editable = |name: &str| now["fields"].as_array().into_iter().flatten().any(|f| f["name"].as_str() == Some(name) && f["mode"] == "edit" && f["editable"] == true);
        if let Some(name) = send.keys().find(|n| !editable(n)) {
            return refused_s(&plain(tr("{name} 不是能在这里改的配置项，没有保存", &[("name", name)])));
        }
        let input = Value::Object(send).to_string();
        let out = self.script_input_s(&path, SCRIPT, &["set", key, "--rev", rev], Some(&input), T_SAVE).await;
        let (result, output) = out.outcome_said();
        let detail = out.stdout.lines().rev().find_map(|l| l.strip_prefix("DETAIL=")).and_then(|d| serde_json::from_str::<Value>(d).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
        put_said(json!({ "result": result, "code": out.code, "detail": detail }), "output", &output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_names_and_values_are_plain() {
        for n in ["MAX_CONCURRENT_WORKERS", "A", "X9_Y"] {
            assert!(valid_setting(n), "{n}");
        }
        for n in ["", "max", "9A", "A B", "A=1", "A;B", "PATH\n", "名字"] {
            assert!(!valid_setting(n), "{n}");
        }
        for v in ["", "2", "claude", "opus-5.5", "anthropic/claude:1@x", "a,b+c"] {
            assert!(valid_value(v), "{v}");
        }
        for v in ["a b", "a\"b", "$HOME", "`id`", "a\\b", "a;b", "a\nb", "a'b", "a=b", "a#b", "中"] {
            assert!(!valid_value(v), "{v}");
        }
        assert!(valid_rev(&"a1".repeat(32)));
        assert!(!valid_rev("abc") && !valid_rev(&"G1".repeat(32)) && !valid_rev(&"A1".repeat(32)));
    }

    /// The same table the remote entry's Python check is run against (GitHub#530).
    #[test]
    fn same_shapes_as_the_remote_entry() {
        let t: Value = serde_json::from_str(include_str!("../../../../../tests/fixtures/config-request-shapes.json")).unwrap();
        let mut n = 0;
        for (kind, f) in [("settings", valid_setting as fn(&str) -> bool), ("values", valid_value), ("revs", valid_rev)] {
            for (want, list) in [(true, "ok"), (false, "bad")] {
                for v in t[kind][list].as_array().unwrap() {
                    let v = v.as_str().unwrap();
                    assert_eq!(f(v), want, "{kind} {v:?}");
                    n += 1;
                }
            }
        }
        assert!(n > 30, "the table was read ({n} examples)");
    }
}
