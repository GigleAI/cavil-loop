// Page zoom (GitHub#155): ⌘+ / ⌘- / ⌘0 step the whole window — board,
// detail and its discussion alike — through fixed levels, and the level is
// kept in the local store so a restart comes back at it. This module only
// decides the level and keeps it; the app shell (src/main.rs) turns it into
// the webview's zoom.

use crate::store::Store;
use serde_json::json;

/// The levels ⌘+ / ⌘- step through, in percent.
pub const LEVELS: [u32; 11] = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
pub const DEFAULT: u32 = 100;
/// The setting the level is kept under (not a credential key: the window may read it).
pub const SETTING: &str = "zoomPercent";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    In,
    Out,
    Reset,
}

impl Step {
    pub fn parse(s: &str) -> Option<Step> {
        match s {
            "in" => Some(Step::In),
            "out" => Some(Step::Out),
            "reset" => Some(Step::Reset),
            _ => None,
        }
    }
}

/// The next level from `current` (a level not in the list steps to the nearest one on that side); stops at the ends.
pub fn next(current: u32, step: Step) -> u32 {
    match step {
        Step::Reset => DEFAULT,
        Step::In => LEVELS.iter().copied().find(|&l| l > current).unwrap_or(LEVELS[LEVELS.len() - 1]),
        Step::Out => LEVELS.iter().rev().copied().find(|&l| l < current).unwrap_or(LEVELS[0]),
    }
}

/// The kept level; anything missing or not one of the levels reads as 100%.
pub fn saved(store: &Store) -> u32 {
    store
        .get_setting(SETTING)
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| LEVELS.contains(v))
        .unwrap_or(DEFAULT)
}

/// Step from the kept level and keep the result. The level is returned even
/// when keeping it failed (the window still zooms; the next start is at the old level).
pub fn apply(store: &Store, step: Step) -> (u32, Result<(), String>) {
    let level = next(saved(store), step);
    let kept = store.set_setting(SETTING, &json!(level));
    (level, kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("cavil-zoom-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir.join("cache.sqlite")).unwrap(), dir)
    }

    #[test]
    fn steps_through_the_levels_and_stops_at_the_ends() {
        assert_eq!(next(100, Step::In), 110);
        assert_eq!(next(100, Step::Out), 90);
        assert_eq!(next(200, Step::In), 200);
        assert_eq!(next(50, Step::Out), 50);
        assert_eq!(next(175, Step::Reset), 100);
        // a value between levels goes to the nearest level on that side
        assert_eq!(next(101, Step::In), 110);
        assert_eq!(next(101, Step::Out), 100);
    }

    #[test]
    fn the_level_is_kept_across_a_restart_and_a_bad_value_reads_as_100() {
        let (s, dir) = store();
        assert_eq!(saved(&s), 100);
        assert_eq!(apply(&s, Step::In).0, 110);
        assert_eq!(apply(&s, Step::In).0, 125);
        drop(s);
        let s = Store::open(&dir.join("cache.sqlite")).unwrap();
        assert_eq!(saved(&s), 125);
        assert_eq!(apply(&s, Step::Out).0, 110);
        s.set_setting(SETTING, &json!(333)).unwrap();
        assert_eq!(saved(&s), 100);
        s.set_setting(SETTING, &json!("110")).unwrap();
        assert_eq!(saved(&s), 100);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
