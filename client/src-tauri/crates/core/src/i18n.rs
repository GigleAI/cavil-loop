//! Chinese / English for the back end's own words (GitHub#466 / #471): the menu, and the messages
//! it sends to the window. The Chinese text is the key, the English comes from the same JSON
//! tables the window imports (client/src/i18n/en/*.json, compiled in), filled by the same rules as
//! the window's `translate` (client/src/shared/i18n.ts). test/fixtures/i18n-cases.json is run
//! through both and must give the same text.
//!
//! The language is the window's: it tells the back end with the `setLanguage` command. Until it
//! does, everything here is Chinese, as before the setting existed.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

impl Lang {
    /// Only the two words the window sends; anything else is refused by the caller.
    pub fn parse(s: &str) -> Option<Lang> {
        match s {
            "zh" => Some(Lang::Zh),
            "en" => Some(Lang::En),
            _ => None,
        }
    }
}

/// The English tables, by area — the same files, in the same order, as the window's EN_TABLES.
pub const TABLES: [(&str, &str); 7] = [
    ("shell", include_str!("../../../../src/i18n/en/shell.json")),
    ("board", include_str!("../../../../src/i18n/en/board.json")),
    ("detail", include_str!("../../../../src/i18n/en/detail.json")),
    ("dialogs", include_str!("../../../../src/i18n/en/dialogs.json")),
    ("notice", include_str!("../../../../src/i18n/en/notice.json")),
    ("actions", include_str!("../../../../src/i18n/en/actions.json")),
    ("daemon", include_str!("../../../../src/i18n/en/daemon.json")),
];

enum EnText {
    One(String),
    Plural { one: String, other: String },
}

static CURRENT: AtomicU8 = AtomicU8::new(0);

fn table() -> &'static HashMap<String, EnText> {
    static T: OnceLock<HashMap<String, EnText>> = OnceLock::new();
    T.get_or_init(|| {
        let mut m = HashMap::new();
        for (_, text) in TABLES {
            // a table that does not parse is caught by the tests (here and in the window's checks);
            // in a build it only means English falls back to the Chinese
            let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(text) else { continue };
            for (k, v) in obj {
                if m.contains_key(&k) {
                    continue;
                }
                let entry = match v {
                    Value::String(s) => EnText::One(s),
                    Value::Object(o) => match (o.get("one").and_then(Value::as_str), o.get("other").and_then(Value::as_str)) {
                        (Some(one), Some(other)) => EnText::Plural { one: one.to_string(), other: other.to_string() },
                        _ => continue,
                    },
                    _ => continue,
                };
                m.insert(k, entry);
            }
        }
        m
    })
}

pub fn lang() -> Lang {
    if CURRENT.load(Ordering::Relaxed) == 1 {
        Lang::En
    } else {
        Lang::Zh
    }
}

pub fn set_lang(l: Lang) {
    CURRENT.store(if l == Lang::En { 1 } else { 0 }, Ordering::Relaxed);
}

/// `{name}` → its value; a placeholder with no value stays as written (the window's `fill`).
fn fill(text: &str, params: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_len = after
            .char_indices()
            .take_while(|(i, c)| c.is_ascii_alphabetic() || *c == '_' || (*i > 0 && c.is_ascii_digit()))
            .count();
        if name_len > 0 && after[name_len..].starts_with('}') {
            let name = &after[..name_len];
            match params.iter().find(|(k, _)| *k == name) {
                Some((_, v)) => out.push_str(v),
                None => {
                    out.push('{');
                    out.push_str(name);
                    out.push('}');
                }
            }
            rest = &after[name_len + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// The window's `translate`: one language, one key, its values.
pub fn translate(l: Lang, zh: &str, params: &[(&str, &str)]) -> String {
    if l == Lang::Zh {
        return fill(zh, params);
    }
    match table().get(zh) {
        None => fill(zh, params),
        Some(EnText::One(s)) => fill(s, params),
        Some(EnText::Plural { one, other }) => {
            let n = params.iter().find(|(k, _)| *k == "n").and_then(|(_, v)| v.trim().parse::<f64>().ok());
            fill(if n == Some(1.0) { one } else { other }, params)
        }
    }
}

/// The back end's own words, in the language the window last asked for.
pub fn tr(zh: &str, params: &[(&str, &str)]) -> String {
    translate(lang(), zh, params)
}

/// GitHub#471 (PR #480 review round 2): a message of the back end's own words with holes for text
/// from outside (an error of the system / the keychain / the database, GitHub's words). `template`
/// is translated with the holes kept as `{name}`; `parts` fill them and are shown as written. The
/// window draws the template in its language and each part inside its "as is" marker
/// (`<Said>`, src/renderer/Verbatim.tsx); `text()` is the same message as one string.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Said {
    pub template: String,
    /// (hole name, outside text, where it comes from: one of the window's VERBATIM_SOURCES)
    pub parts: Vec<(String, String, &'static str)>,
}

impl Said {
    /// `zh`: the Chinese key with `{name}` holes; every hole is one of `parts` (all from `from`)
    pub fn new(zh: &str, parts: &[(&str, &str)], from: &'static str) -> Said {
        Said { template: translate(lang(), zh, &[]), parts: parts.iter().map(|(k, v)| (k.to_string(), v.to_string(), from)).collect() }
    }

    /// nothing but outside text (no words of the client's own around it)
    pub fn outside(text: &str, from: &'static str) -> Said {
        Said { template: "{e}".into(), parts: vec![("e".into(), text.to_string(), from)] }
    }

    /// the client's own words with no outside text in them (already in the window's language)
    pub fn plain(text: String) -> Said {
        Said { template: text, parts: vec![] }
    }

    /// `zh` with each `{name}` replaced by a whole message (`pieces`); their holes are renamed so
    /// they cannot collide
    pub fn compose(zh: &str, pieces: &[(&str, &Said)]) -> Said {
        let mut parts = vec![];
        let mut fills: Vec<(String, String)> = vec![];
        for (name, piece) in pieces {
            let mut t = piece.template.clone();
            for (k, v, from) in &piece.parts {
                let renamed = format!("{name}_{k}");
                t = t.replace(&format!("{{{k}}}"), &format!("{{{renamed}}}"));
                parts.push((renamed, v.clone(), *from));
            }
            fills.push((name.to_string(), t));
        }
        let refs: Vec<(&str, &str)> = fills.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        Said { template: translate(lang(), zh, &refs), parts }
    }

    /// the message as one string (the template with every hole filled)
    pub fn text(&self) -> String {
        let refs: Vec<(&str, &str)> = self.parts.iter().map(|(k, v, _)| (k.as_str(), v.as_str())).collect();
        fill(&self.template, &refs)
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "template": self.template,
            "parts": self.parts.iter().map(|(k, v, from)| serde_json::json!({ "name": k, "text": v, "from": from })).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases the window's test runs through `translate` too (test/unit/i18n.test.ts).
    #[test]
    fn same_text_as_the_window_for_the_shared_cases() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../../../test/fixtures/i18n-cases.json")).unwrap();
        assert!(cases.len() >= 8, "the shared cases are there");
        for c in &cases {
            let l = Lang::parse(c["lang"].as_str().unwrap()).unwrap();
            let key = c["key"].as_str().unwrap();
            let owned: Vec<(String, String)> = c["params"]
                .as_object()
                .map(|o| {
                    o.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())))
                        .collect()
                })
                .unwrap_or_default();
            let params: Vec<(&str, &str)> = owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            assert_eq!(translate(l, key, &params), c["expect"].as_str().unwrap(), "case {c}");
        }
    }

    #[test]
    fn every_table_parses_and_names_only_text_or_one_other() {
        for (name, text) in TABLES {
            let v: Value = serde_json::from_str(text).unwrap_or_else(|e| panic!("{name}.json: {e}"));
            for (k, e) in v.as_object().unwrap() {
                match e {
                    Value::String(_) => {}
                    Value::Object(o) => assert!(o.len() == 2 && o["one"].is_string() && o["other"].is_string(), "{name}.json {k}"),
                    _ => panic!("{name}.json {k}: not text"),
                }
            }
        }
    }

    #[test]
    fn said_reads_as_one_string_and_keeps_outside_text_apart() {
        // (the language is process-wide and other tests run alongside: Chinese only here, English in the UI tests)
        let save = Said::new("登录没能保存到本机（{e}）", &[("e", "disk full")], "system");
        assert_eq!(save.text(), "登录没能保存到本机（disk full）");
        assert_eq!(save.template, "登录没能保存到本机（{e}）");
        // a reason in front, then two messages: holes renamed, text as the old format! wording
        let r = Said::plain("登录已取消".into());
        let both = Said::compose("{reason}。{rest}", &[("reason", &r), ("rest", &save)]);
        assert_eq!(both.text(), "登录已取消。登录没能保存到本机（disk full）");
        assert_eq!(both.parts, vec![("rest_e".to_string(), "disk full".to_string(), "system")]);
        let joined = Said::compose("{a}；{b}", &[("a", &both), ("b", &Said::outside("{x} as written", "github"))]);
        assert_eq!(joined.text(), "登录已取消。登录没能保存到本机（disk full）；{x} as written");
        assert_eq!(joined.parts.len(), 2);
        // outside text is never read as a hole, whatever braces it carries
        assert_eq!(Said::new("没能删除（{e}）", &[("e", "{e}{rest_e}")], "system").text(), "没能删除（{e}{rest_e}）");
        assert_eq!(translate(Lang::En, "登录没能保存到本机（{e}）", &[("e", "disk full")]), "The sign-in could not be saved on this computer (disk full)");
    }

    #[test]
    fn chinese_until_told_and_only_two_words() {
        assert_eq!(Lang::parse("en"), Some(Lang::En));
        assert_eq!(Lang::parse("zh"), Some(Lang::Zh));
        assert_eq!(Lang::parse("auto"), None);
        assert_eq!(Lang::parse("EN"), None);
    }
}
