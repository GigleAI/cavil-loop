// Project settings → 「改名…」 on a flow label (GitHub#569): rename one of the daemon's flow labels on
// GitHub, in the project's config and in the client, together.
//
// The work is the daemon's own scripts/label-rename.sh, run for a project of this computer the same way
// daemon_config.rs runs project-config.sh: the window names a project key, a command word and a few
// plain values; every one is checked here before anything runs (the setting is one of the daemon's
// single-name flow labels, a name has only the characters a config line and GitHub both take, a label
// id is digits, a fingerprint is the one `get` hands out). Nothing is read from or written to a file
// here; the script decides where everything is.
//
// The script ends with fixed lines (GITHUB= CONFIG= STEP= PAUSED= WATCH= LABEL_ID= DETAIL= RESULT=);
// the lines before them are its words for a person. No RESULT line (killed, timed out, stopped half
// way) is "unconfirmed": what it changed is not known, so it is never read as one of its own words.

use crate::daemon::{bad_key, busy, outside, plain, put_said, refused_s, tail, valid_key, Daemon, T_SHORT};
use crate::daemon_config::valid_rev;
use crate::i18n::{tr, Said};
use serde_json::{json, Value};
use std::time::Duration;

const SCRIPT: &str = "label-rename.sh";
/// a changing command waits up to 60 s for the project's poll lock, then talks to GitHub and saves the config
const T_CHANGE: Duration = Duration::from_secs(240);

/// The settings the script may rename (scripts/_label_rename.sh LABEL_RENAME_FIELDS).
pub const FIELDS: [&str; 12] = [
    "LABEL_PENDING_AGENT",
    "LABEL_PENDING_AGENT_FABLE",
    "LABEL_AGENT_DOING",
    "LABEL_PENDING_HUMAN",
    "LABEL_PENDING_PR",
    "LABEL_DONE",
    "LABEL_PENDING_REVIEW",
    "LABEL_AUTOPILOT",
    "LABEL_PENDING_MERGE",
    "LABEL_PENDING_BLOCKED",
    "LABEL_PENDING_LATER",
    "LABEL_PENDING_REQUESTER_BOT",
];

/// The commands the window may send.
pub const COMMANDS: [&str; 10] = ["check", "rename", "follow", "continue", "resend", "finish", "undo", "abandon", "watch-end", "status"];

/// A label name the script takes (scripts/_label_rename.sh label_rename_name_ok): 1–50 of `A-Za-z0-9._:/@+-`.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 50 && n.bytes().all(|c| c.is_ascii_alphanumeric() || b"._:/@+-".contains(&c))
}

/// A GitHub label id: digits only.
pub fn valid_label_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 20 && s.bytes().all(|c| c.is_ascii_digit())
}

/// What the script's fixed last lines said. `result` None: there was no RESULT line.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub result: Option<String>,
    pub github: String,
    pub config: String,
    pub step: String,
    pub paused: Option<bool>,
    pub watch: Option<bool>,
    pub label_id: String,
    pub detail: Value,
    /// the lines before the fixed ones: the script's words for a person
    pub message: String,
}

const KEYS: [&str; 8] = ["GITHUB=", "CONFIG=", "STEP=", "PAUSED=", "WATCH=", "LABEL_ID=", "DETAIL=", "RESULT="];

fn three(v: &str) -> String {
    match v {
        "old" | "new" => v.to_string(),
        _ => "unknown".to_string(),
    }
}

fn yes_no(v: Option<&str>) -> Option<bool> {
    match v {
        Some("yes") => Some(true),
        Some("no") => Some(false),
        _ => None,
    }
}

/// Read the script's output. Only the trailing block of `KEY=` lines counts, and only when its last
/// non-empty line is `RESULT=<word>`; a field that is missing or not one of the script's words is
/// "unknown" — never "old" or "new".
pub fn parse(stdout: &str) -> Parsed {
    let lines: Vec<&str> = stdout.lines().collect();
    let mut end = lines.len();
    while end > 0 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && KEYS.iter().any(|k| lines[start - 1].starts_with(k)) {
        start -= 1;
    }
    let block = &lines[start..end];
    let get = |k: &str| block.iter().rev().find_map(|l| l.strip_prefix(k)).map(str::trim);
    let result = (end > start && lines[end - 1].starts_with("RESULT="))
        .then(|| lines[end - 1].trim_start_matches("RESULT=").trim().to_string())
        .filter(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
    let detail = get("DETAIL=").and_then(|d| serde_json::from_str::<Value>(d).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let label_id = get("LABEL_ID=").filter(|s| valid_label_id(s)).unwrap_or("").to_string();
    let step = get("STEP=").filter(|s| matches!(*s, "github" | "config" | "client")).unwrap_or("").to_string();
    Parsed {
        result,
        github: three(get("GITHUB=").unwrap_or("")),
        config: three(get("CONFIG=").unwrap_or("")),
        step,
        paused: yes_no(get("PAUSED=")),
        watch: yes_no(get("WATCH=")),
        label_id,
        detail,
        message: lines[..start].join("\n").trim().to_string(),
    }
}

fn arg<'a>(a: &'a Value, k: &str) -> &'a str {
    a.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The script's arguments after `<key> <cmd>`, or why the request is refused (nothing runs).
pub fn args_for(cmd: &str, a: &Value) -> Result<Vec<String>, Said> {
    if !COMMANDS.contains(&cmd) {
        return Err(plain(tr("未知操作", &[])));
    }
    let mut out: Vec<String> = vec![];
    let named = |out: &mut Vec<String>| -> Result<(), Said> {
        let field = arg(a, "field");
        if !FIELDS.contains(&field) {
            return Err(plain(tr("这个设置不是能在这里改名的流程标签", &[])));
        }
        let (from, to) = (arg(a, "from"), arg(a, "to"));
        if !valid_name(from) || !valid_name(to) {
            return Err(plain(tr("标签名只能用字母、数字和 . _ : / @ + -，1–50 个字符", &[])));
        }
        out.extend(["--field".into(), field.into(), "--from".into(), from.into(), "--to".into(), to.into()]);
        Ok(())
    };
    let id = |out: &mut Vec<String>| -> Result<(), Said> {
        let id = arg(a, "labelId");
        if !valid_label_id(id) {
            return Err(plain(tr("标签编号只能是数字", &[])));
        }
        out.extend(["--label-id".into(), id.into()]);
        Ok(())
    };
    let rev = |out: &mut Vec<String>| -> Result<(), Said> {
        let r = arg(a, "rev");
        if !valid_rev(r) {
            return Err(plain(tr("指纹不合规：先重新读取配置", &[])));
        }
        out.extend(["--rev".into(), r.into()]);
        Ok(())
    };
    let stopped = a.get("othersStopped").and_then(Value::as_bool) == Some(true);
    match cmd {
        "check" => {
            named(&mut out)?;
            if a.get("follow").and_then(Value::as_bool) == Some(true) {
                out.push("--follow".into());
                id(&mut out)?;
            } else if stopped {
                out.push("--others-stopped".into());
            }
        }
        "rename" => {
            named(&mut out)?;
            rev(&mut out)?;
            if !stopped {
                return Err(plain(tr("要先确认没有别的机器在轮询本仓库（或已经停掉）", &[])));
            }
            out.push("--others-stopped".into());
        }
        "follow" => {
            named(&mut out)?;
            id(&mut out)?;
            rev(&mut out)?;
        }
        // the window only finishes after it saved its own label names: never `--no-client`
        "finish" => out.push("--client-saved".into()),
        // the window asked the person first
        "abandon" => out.push("--yes".into()),
        _ => {}
    }
    Ok(out)
}

impl Daemon {
    /// `{result: <the script's word> | "unconfirmed" | "refused", ran, github, config, step, paused, watch,
    /// labelId, checks, record, message, output, code}`. `ran: false`: the back end refused, nothing ran.
    pub async fn label_rename(&self, key: &str, cmd: &str, a: &Value) -> Value {
        let refuse = |m: &Said| {
            let mut v = refused_s(m);
            v["ran"] = Value::Bool(false);
            v
        };
        if !valid_key(key) {
            return refuse(&bad_key());
        }
        let args = match args_for(cmd, a) {
            Ok(x) => x,
            Err(m) => return refuse(&m),
        };
        match self.entry_s() {
            Ok(e) if e.join("scripts").join(SCRIPT).is_file() => {}
            Ok(_) => return refuse(&plain(tr("这份 daemon 还没有给流程标签改名的脚本（早于 GitHub#569）：先更新 daemon", &[]))),
            Err(m) => return refuse(&m),
        }
        // read-only commands run beside anything; a changing one is the only daemon operation running
        let read_only = cmd == "check" || cmd == "status";
        let _g = if read_only {
            None
        } else {
            match self.busy.try_lock() {
                Ok(g) => Some(g),
                Err(_) => return refuse(&busy()),
            }
        };
        let path = match self.path_s().await {
            Ok(p) => p,
            Err(m) => return refuse(&m),
        };
        let mut all: Vec<&str> = vec![key, cmd];
        all.extend(args.iter().map(String::as_str));
        let out = self.script_s(&path, SCRIPT, &all, if read_only { T_SHORT } else { T_CHANGE }).await;
        let p = parse(&out.stdout);
        let (result, said) = match &p.result {
            Some(w) => (w.clone(), if p.message.is_empty() { plain(String::new()) } else { outside(&p.message, "daemon") }),
            None => {
                let shown = if out.note.is_none() && out.text().is_empty() { plain(tr("脚本没有输出", &[])) } else { out.said("daemon") };
                (
                    "unconfirmed".to_string(),
                    Said::compose("脚本没有给出最终结果，GitHub 上的标签和配置文件可能已经改了，也可能没改。脚本输出：\n{out}", &[("out", &shown)]),
                )
            }
        };
        let v = json!({
            "result": result,
            "ran": true,
            "code": out.code,
            "github": p.github,
            "config": p.config,
            "step": p.step,
            "paused": p.paused,
            "watch": p.watch,
            "labelId": p.label_id,
            "checks": p.detail.get("checks").cloned().filter(Value::is_array).unwrap_or_else(|| json!([])),
            "record": p.detail.get("record").cloned().unwrap_or(Value::Null),
            "message": tail(&p.message, 4000),
        });
        put_said(v, "output", &said)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_ids() {
        for n in ["pending/human", "a", "x.y_z:1/@+-", &"a".repeat(50)] {
            assert!(valid_name(n), "{n}");
        }
        for n in ["", "a b", "a,b", "a\"b", "$x", "中", &"a".repeat(51), "a\nb"] {
            assert!(!valid_name(n), "{n}");
        }
        assert!(valid_label_id("123") && !valid_label_id("") && !valid_label_id("1a") && !valid_label_id("-1"));
    }

    #[test]
    fn the_fixed_lines_are_read_from_the_end() {
        let out = "已改名：a → b（LABEL_PENDING_HUMAN）。本项目轮询恢复\nGITHUB=new\nCONFIG=new\nSTEP=\nPAUSED=no\nWATCH=no\nLABEL_ID=42\nDETAIL={\"checks\":[{\"id\":\"name\",\"ok\":true,\"text\":\"t\"}],\"record\":null,\"message\":\"m\"}\nRESULT=done\n";
        let p = parse(out);
        assert_eq!(p.result.as_deref(), Some("done"));
        assert_eq!((p.github.as_str(), p.config.as_str(), p.step.as_str()), ("new", "new", ""));
        assert_eq!((p.paused, p.watch), (Some(false), Some(false)));
        assert_eq!(p.label_id, "42");
        assert_eq!(p.detail["checks"][0]["id"], "name");
        assert_eq!(p.message, "已改名：a → b（LABEL_PENDING_HUMAN）。本项目轮询恢复");
    }

    #[test]
    fn no_result_line_is_not_a_result() {
        // killed half way: the fields that came are not taken for a verdict
        let p = parse("GITHUB=new\nCONFIG=old\n");
        assert_eq!(p.result, None);
        // a RESULT line that is not the last one does not count either
        assert_eq!(parse("RESULT=done\nGITHUB=new\n").result, None);
        assert_eq!(parse("").result, None);
        // a RESULT word the script never prints is still a word (the caller maps it); a malformed one is none
        assert_eq!(parse("RESULT=Done!\n").result, None);
    }

    #[test]
    fn a_field_out_of_its_words_is_unknown() {
        let p = parse("GITHUB=maybe\nCONFIG=\nSTEP=elsewhere\nPAUSED=perhaps\nLABEL_ID=12x\nDETAIL=not json\nRESULT=unknown\n");
        assert_eq!((p.github.as_str(), p.config.as_str(), p.step.as_str()), ("unknown", "unknown", ""));
        assert_eq!((p.paused, p.watch), (None, None));
        assert_eq!(p.label_id, "");
        assert_eq!(p.detail, json!({}));
    }

    #[test]
    fn arguments_are_checked_before_anything_runs() {
        let ok = json!({ "field": "LABEL_PENDING_HUMAN", "from": "pending/human", "to": "wait/human", "rev": "a1".repeat(32), "othersStopped": true, "labelId": "7" });
        assert_eq!(
            args_for("rename", &ok).unwrap(),
            ["--field", "LABEL_PENDING_HUMAN", "--from", "pending/human", "--to", "wait/human", "--rev", &"a1".repeat(32), "--others-stopped"]
        );
        assert_eq!(args_for("follow", &ok).unwrap()[6..8], ["--label-id".to_string(), "7".to_string()]);
        let mut follow = ok.clone();
        follow["follow"] = json!(true);
        assert!(args_for("check", &follow).unwrap().contains(&"--follow".to_string()));
        assert_eq!(args_for("finish", &json!({})).unwrap(), ["--client-saved"]);
        assert_eq!(args_for("abandon", &json!({})).unwrap(), ["--yes"]);
        assert!(args_for("continue", &json!({ "field": "x" })).unwrap().is_empty());
        for (cmd, bad) in [
            ("rename", json!({ "field": "WORKER_AGENT", "from": "a", "to": "b", "rev": "a1".repeat(32), "othersStopped": true })),
            ("rename", json!({ "field": "LABEL_DONE", "from": "a", "to": "b c", "rev": "a1".repeat(32), "othersStopped": true })),
            ("rename", json!({ "field": "LABEL_DONE", "from": "a", "to": "b", "rev": "x", "othersStopped": true })),
            ("rename", json!({ "field": "LABEL_DONE", "from": "a", "to": "b", "rev": "a1".repeat(32) })),
            ("follow", json!({ "field": "LABEL_DONE", "from": "a", "to": "b", "rev": "a1".repeat(32), "labelId": "x1" })),
            ("rm", json!({})),
        ] {
            assert!(args_for(cmd, &bad).is_err(), "{cmd} {bad}");
        }
    }

    #[test]
    fn same_settings_as_the_daemon() {
        let lib = include_str!("../../../../../scripts/_label_rename.sh");
        let line = lib.lines().find_map(|l| l.strip_prefix("LABEL_RENAME_FIELDS=\"")).unwrap().trim_end_matches('"');
        let theirs: Vec<&str> = line.split_whitespace().collect();
        assert_eq!(theirs, FIELDS);
    }
}
