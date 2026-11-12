// This machine as the one being connected to (GitHub#387, "pair without a terminal"): the switch
// that opens / closes this machine's remote entry, a pairing code shown in the window, voiding it,
// the computers paired with this machine and revoking one. Everything goes through the daemon's
// own scripts/remote-access.sh — the same command a person runs on a server without a window — so
// there is one implementation of "open", "close", "make a code" and "revoke", not two.
//
// Reads are three-way like everywhere else in this area: the script's last line `RESULT=<word>`
// is the only thing that says what happened; no such line is "unconfirmed", never "closed" or
// "no devices". What the window shows after a change is what a fresh `status` reads back.

use crate::daemon::{refused, Daemon, Out, BUSY, T_SHORT, T_STATUS};
use serde_json::{json, Value};

const SCRIPT: &str = "remote-access.sh";

/// The value of a `KEY=` line the script prints for the client (the last one wins).
fn field(out: &Out, key: &str) -> Option<String> {
    let p = format!("{key}=");
    out.stdout.lines().rev().find_map(|l| l.trim().strip_prefix(p.as_str()).map(str::to_string))
}

fn digits(s: &str, n: std::ops::RangeInclusive<usize>) -> bool {
    n.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// a host name as the script prints it: a Tailscale name, maybe with `:port`
fn host_ok(h: &str) -> bool {
    crate::remote::parse_host(h).is_ok()
}

/// device ids are 16 hex digits (remote_access.py: secrets.token_hex(8))
fn device_id_ok(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `status` output → what the switch shows.
pub(crate) fn parse_host_status(out: &Out) -> Value {
    let Some(word) = out.result_word() else {
        return json!({ "state": "unknown", "output": out.outcome().1 });
    };
    let state = match word.as_str() {
        "open" | "closed" | "partial" | "unknown" => word,
        _ => "unknown".into(),
    };
    let host = field(out, "HOST").filter(|h| host_ok(h));
    let devices = field(out, "DEVICES").filter(|d| digits(d, 1..=6)).and_then(|d| d.parse::<u64>().ok());
    json!({ "state": state, "host": host, "devices": devices, "output": out.text() })
}

/// `list --machine` output → the paired computers, or None when it could not be read whole.
pub(crate) fn parse_devices(out: &Out) -> Option<Vec<Value>> {
    if !out.ok() || out.result_word().as_deref() != Some("ok") {
        return None;
    }
    let mut v = vec![];
    for l in out.stdout.lines() {
        let Some(rest) = l.strip_prefix("DEVICE=") else { continue };
        let f: Vec<&str> = rest.split('\t').collect();
        if f.len() != 4 || !device_id_ok(f[0]) {
            return None; // a row that cannot be read means the list is not known
        }
        v.push(json!({ "id": f[0], "name": f[1], "node": f[2], "paired": f[3] }));
    }
    Some(v)
}

impl Daemon {
    async fn host_path(&self) -> Result<String, String> {
        let p = self.path().await?;
        // the Mac App Store / standalone Tailscale app keeps its command line inside the app
        Ok(if cfg!(target_os = "macos") { format!("{p}:/Applications/Tailscale.app/Contents/MacOS") } else { p })
    }

    fn host_script_missing(&self) -> Option<Value> {
        match self.entry() {
            Ok(e) if e.join("scripts").join(SCRIPT).is_file() => None,
            Ok(_) => Some(json!({ "state": "missing", "output": "本机的 daemon 还没有远程连接功能（没有 remote-access.sh），请先更新 daemon" })),
            Err(m) => Some(json!({ "state": "missing", "output": m })),
        }
    }

    async fn host_status_with(&self, path: &str) -> Value {
        parse_host_status(&self.script(path, SCRIPT, &["status"], T_STATUS).await)
    }

    /// One action on this machine's remote entry:
    /// status / enable / disable / code / cancel / devices / revoke (with `target` = device id).
    pub async fn remote_host(&self, action: &str, target: Option<&str>) -> Value {
        if let Some(m) = self.host_script_missing() {
            return if action == "status" { m } else { refused(m["output"].as_str().unwrap_or("")) };
        }
        let path = match self.host_path().await {
            Ok(p) => p,
            Err(m) => return if action == "status" { json!({ "state": "unknown", "output": m }) } else { refused(&m) },
        };
        match action {
            "status" => self.host_status_with(&path).await,
            "devices" => {
                let out = self.script(&path, SCRIPT, &["list", "--machine"], T_SHORT).await;
                match parse_devices(&out) {
                    Some(d) => json!({ "result": "ok", "devices": d }),
                    None => json!({ "result": "unreadable", "output": out.text() }),
                }
            }
            "enable" | "disable" | "code" | "cancel" | "revoke" => {
                let Ok(_g) = self.busy.try_lock() else { return refused(BUSY) };
                let args: Vec<&str> = match action {
                    "enable" => vec!["enable"],
                    "disable" => vec!["disable"],
                    "code" => vec!["pair"],
                    "cancel" => vec!["pair-cancel"],
                    _ => {
                        let Some(id) = target.filter(|t| device_id_ok(t)) else { return refused("设备编号不合规") };
                        vec!["revoke", id]
                    }
                };
                let out = self.script(&path, SCRIPT, &args, T_STATUS).await;
                if action == "revoke" {
                    let result = match out.code {
                        Some(0) => "ok",
                        Some(1) => "not_found",
                        _ => "failed",
                    };
                    return json!({ "result": result, "output": out.text() });
                }
                let (word, text) = out.outcome();
                let mut v = json!({ "result": word, "output": text });
                if action == "code" && word == "code" {
                    let code = field(&out, "CODE").filter(|c| digits(c, 8..=8));
                    let expires = field(&out, "EXPIRES").filter(|e| digits(e, 9..=12)).and_then(|e| e.parse::<u64>().ok());
                    match (code, expires) {
                        (Some(c), Some(e)) => {
                            v["code"] = json!(c);
                            v["expires"] = json!(e);
                            v["host"] = json!(field(&out, "HOST").filter(|h| host_ok(h)));
                        }
                        // a code the window cannot show is no code: void it rather than leave one waiting
                        _ => {
                            let _ = self.script(&path, SCRIPT, &["pair-cancel"], T_SHORT).await;
                            v["result"] = json!("failed");
                            v["output"] = json!(format!("配对码的格式认不出，已作废，请再生成一次。脚本输出：\n{text}"));
                        }
                    }
                }
                if action == "enable" || action == "disable" {
                    // what the switch shows is what a fresh read says, never what was asked for
                    v["status"] = self.host_status_with(&path).await;
                }
                v
            }
            _ => refused("未知操作"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(code: i32, stdout: &str) -> Out {
        Out { code: Some(code), stdout: stdout.into(), stderr: String::new() }
    }

    #[test]
    fn status_lines() {
        let v = parse_host_status(&out(0, "常驻服务：running\nHOST=box.tailnet.ts.net\nPORT=47387\nDEVICES=2\nRESULT=open\n"));
        assert_eq!(v["state"], "open");
        assert_eq!(v["host"], "box.tailnet.ts.net");
        assert_eq!(v["devices"], 2);
        // devices unreadable stays unknown, never 0
        let v = parse_host_status(&out(0, "DEVICES=unknown\nRESULT=closed\n"));
        assert_eq!(v["state"], "closed");
        assert!(v["devices"].is_null());
        // no RESULT line: unknown, not closed
        let v = parse_host_status(&out(1, "常驻服务：running\n"));
        assert_eq!(v["state"], "unknown");
        // a word this client does not know: unknown
        assert_eq!(parse_host_status(&out(0, "RESULT=halfway\n"))["state"], "unknown");
    }

    #[test]
    fn device_rows() {
        let d = parse_devices(&out(0, "DEVICE=0123456789abcdef\tMacBook\tmacbook\t2026-11-12 10:00\nRESULT=ok\n")).unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0]["name"], "MacBook");
        assert_eq!(parse_devices(&out(0, "RESULT=ok\n")).unwrap().len(), 0);
        // unreadable list, or one row that does not parse: not known, never empty
        assert!(parse_devices(&out(2, "读不到已配对设备清单\n")).is_none());
        assert!(parse_devices(&out(0, "DEVICE=zz\tx\ty\tz\nRESULT=ok\n")).is_none());
        assert!(parse_devices(&out(0, "DEVICE=0123456789abcdef\tx\n")).is_none());
    }
}
