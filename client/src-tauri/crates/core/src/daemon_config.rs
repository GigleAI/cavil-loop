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

use crate::daemon::{refused, tail, valid_key, Daemon, BUSY, T_SHORT};
use serde_json::{json, Map, Value};

const SCRIPT: &str = "project-config.sh";
/// the save waits up to 15 s for another save's lock, then loads the config a few times
const T_SAVE: std::time::Duration = std::time::Duration::from_secs(120);

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
fn valid_rev(r: &str) -> bool {
    r.len() == 64 && r.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl Daemon {
    fn has_config_script(&self) -> Result<bool, String> {
        Ok(self.entry()?.join("scripts").join(SCRIPT).is_file())
    }

    /// The script's `get`: Ok(its JSON, state "ok") or Err((result word, words for the person)).
    async fn config_read(&self, path: &str, key: &str) -> Result<Value, (String, String)> {
        let out = self.script(path, SCRIPT, &["get", key], T_SHORT).await;
        let v: Value = match serde_json::from_str(out.stdout.trim()) {
            Ok(v) => v,
            Err(_) => {
                let t = out.text();
                return Err(("unreadable".into(), format!("读不到这个项目的配置：{}", if t.is_empty() { "脚本没有输出".into() } else { t })));
            }
        };
        if v["version"] != 1 {
            return Err(("unreadable".into(), format!("配置脚本输出的格式认不出（version = {}），客户端可能需要更新", v["version"])));
        }
        match v["state"].as_str() {
            Some("ok") if out.ok() && v["fields"].is_array() && v["rev"].is_string() => Ok(v),
            Some("not_found") => Err(("not_found".into(), v["reason"].as_str().unwrap_or("本机没有接入这个项目").to_string())),
            // "unreadable" and anything this client does not know: never shown as "nothing set"
            _ => Err(("unreadable".into(), v["reason"].as_str().map(str::to_string).unwrap_or_else(|| tail(&out.text(), 2000)))),
        }
    }

    /// `{result:"ok", config}` / `{result:"unsupported"|"unreadable"|"not_found"|"refused", output}`
    pub async fn config_get(&self, key: &str) -> Value {
        if !valid_key(key) {
            return refused("项目名不合规");
        }
        match self.has_config_script() {
            Ok(true) => {}
            Ok(false) => return json!({ "result": "unsupported", "output": "这份 daemon 还没有读写项目配置的脚本（早于 GitHub#388）：更新 daemon 后可以在这里用表单改，现在只能用编辑器打开配置文件" }),
            Err(m) => return refused(&m),
        }
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        match self.config_read(&path, key).await {
            Ok(v) => json!({ "result": "ok", "config": v }),
            Err((word, why)) => json!({ "result": word, "output": why }),
        }
    }

    /// `values`: `{SETTING: "value"}`. `{result: <the script's word> | "unconfirmed" | "refused", output, detail}`
    pub async fn config_set(&self, key: &str, rev: &str, values: &Value) -> Value {
        if !valid_key(key) {
            return refused("项目名不合规");
        }
        if !valid_rev(rev) {
            return refused("指纹不合规：先重新读取配置");
        }
        let Some(map) = values.as_object().filter(|m| !m.is_empty() && m.len() <= 64) else { return refused("没有要改的配置项") };
        let mut send = Map::new();
        for (name, v) in map {
            let Some(v) = v.as_str() else { return refused(&format!("{name} 的值不是文本")) };
            if !valid_setting(name) {
                return refused("配置项的名字不合规");
            }
            if !valid_value(v) {
                return refused(&format!("{name} 的值里有不能写进配置文件的字符"));
            }
            send.insert(name.clone(), Value::String(v.to_string()));
        }
        match self.has_config_script() {
            Ok(true) => {}
            Ok(false) => return refused("这份 daemon 还没有读写项目配置的脚本"),
            Err(m) => return refused(&m),
        }
        let Ok(_g) = self.busy.try_lock() else { return refused(BUSY) };
        let path = match self.path().await {
            Ok(p) => p,
            Err(m) => return refused(&m),
        };
        // read again right before the save: only what the daemon lists as editable now goes out
        let now = match self.config_read(&path, key).await {
            Ok(v) => v,
            Err((_, why)) => return refused(&format!("保存前重新读取配置失败，没有保存：{why}")),
        };
        let editable = |name: &str| now["fields"].as_array().into_iter().flatten().any(|f| f["name"].as_str() == Some(name) && f["mode"] == "edit" && f["editable"] == true);
        if let Some(name) = send.keys().find(|n| !editable(n)) {
            return refused(&format!("{name} 不是能在这里改的配置项，没有保存"));
        }
        let input = Value::Object(send).to_string();
        let out = self.script_input(&path, SCRIPT, &["set", key, "--rev", rev], Some(&input), T_SAVE).await;
        let (result, output) = out.outcome();
        let detail = out.stdout.lines().rev().find_map(|l| l.strip_prefix("DETAIL=")).and_then(|d| serde_json::from_str::<Value>(d).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
        json!({ "result": result, "code": out.code, "output": output, "detail": detail })
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
}
