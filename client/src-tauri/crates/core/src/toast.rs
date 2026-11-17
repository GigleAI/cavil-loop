// Windows notifications ("toasts", GitHub#577): the parts that decide, kept here so every system
// tests them. The shell (src-tauri/src/win.rs) only hands them to the system.
//
//   - the notification's text goes to the system as XML: titles and bodies come from GitHub (an
//     issue title anyone may write), so every character that means something in XML is escaped
//   - the system finds a delivered notification again by a tag and a group of at most 64
//     characters. The app's own id for one notification (desktop.rs `notification_id`, a JSON
//     text) is longer, so the tag is a hash of that id and the group a hash of the item it is about:
//     taking back "this one" removes by tag + group, "every one about this item" by group —
//     also those an earlier start of the app sent, since the hash does not change between starts.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// The group of a notification that is about no item (the packaging check's).
pub const NO_ITEM_GROUP: &str = "cavil";

fn short_hash(s: &str) -> String {
    let d = Sha256::digest(s.as_bytes());
    d.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// Text for XML: the five characters that mean something there, and control characters (which XML
/// cannot carry at all) dropped. Line breaks and tabs stay.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\n' | '\t' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{fffe}' || c == '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

/// The notification as the system reads it: a title line and a body.
pub fn xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape(title),
        escape(body)
    )
}

/// The tag of one notification: from its whole id (`notification_id`).
pub fn tag(id: &str) -> String {
    format!("n{}", short_hash(id))
}

/// The group of the item `key` (`owner/repo#N`).
pub fn item_group(key: &str) -> String {
    format!("i{}", short_hash(key))
}

/// The group of one notification: its item's, read out of its id; no item: NO_ITEM_GROUP.
pub fn group(id: &str) -> String {
    serde_json::from_str::<Value>(id).ok().and_then(|v| v["key"].as_str().map(item_group)).unwrap_or_else(|| NO_ITEM_GROUP.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_from_github_cannot_change_the_notification() {
        let x = xml("Fix <script> & \"quotes\" 'x'", "</text></binding><action/>\u{1}ok\nnext");
        assert_eq!(
            x,
            "<toast><visual><binding template=\"ToastGeneric\"><text>Fix &lt;script&gt; &amp; &quot;quotes&quot; &apos;x&apos;</text><text>&lt;/text&gt;&lt;/binding&gt;&lt;action/&gt;ok\nnext</text></binding></visual></toast>"
        );
        // exactly the two text elements the app writes
        assert_eq!(x.matches("<text>").count(), 2);
        assert_eq!(escape("café #12"), "café #12");
    }

    #[test]
    fn tags_and_groups_fit_the_system_and_find_the_item_again() {
        let a = r#"{"key":"o/r#1","n":0,"run":"aaaa","url":"https://github.com/o/r/issues/1"}"#;
        let b = r#"{"key":"o/r#1","n":3,"run":"bbbb","url":"https://github.com/o/r/issues/1"}"#;
        let c = r#"{"key":"o/r#2","n":0,"run":"aaaa","url":"https://github.com/o/r/issues/2"}"#;
        for id in [a, b, c] {
            assert!(tag(id).len() <= 64 && group(id).len() <= 64);
        }
        // one tag per notification
        assert_ne!(tag(a), tag(b));
        assert_ne!(tag(a), tag(c));
        // one group per item, whatever start of the app sent it
        assert_eq!(group(a), group(b));
        assert_eq!(group(a), item_group("o/r#1"));
        assert_ne!(group(a), group(c));
        // the same id always gives the same tag (an earlier start's notification is found again)
        assert_eq!(tag(a), tag(a));
        // no item: the app's own group, never an item's
        assert_eq!(group(r#"{"summary":0,"run":"aaaa"}"#), NO_ITEM_GROUP);
        assert_eq!(group("not json"), NO_ITEM_GROUP);
        assert_ne!(item_group("cavil"), NO_ITEM_GROUP);
    }
}
