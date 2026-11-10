// The window's size and place (GitHub#333): a restart comes back the way the
// window was left — size, position, maximized or not — instead of the fixed
// 1280×820. Kept in the local store next to the zoom level. This module only
// decides what to keep and what a start should use; the app shell
// (src/main.rs) reads the real window and the real screens and applies it.
//
// All numbers are logical pixels (independent of a screen's scale factor), so a
// window looks the same size on a Retina and a plain screen. Positions are the
// window's outer top-left corner in the system's logical screen space.
//
// Rules, all in `placement` (start) and `observe` (keep):
//   - nothing kept, or a record that is not exactly the expected shape → the default size, centred
//   - a size below the minimum is raised to it; above the screen it shrinks to the screen
//   - a position is used only while part of the title bar is on a screen that exists now;
//     otherwise (screen unplugged, screens unreadable) the size stays and the window is centred
//   - while maximized only "maximized" is updated: the normal size and place stay what they
//     were, so un-maximizing after a restart goes back to them
//   - full screen, minimized, or a state that could not be read changes nothing

use crate::store::Store;
use serde_json::{json, Value};

/// The setting the record is kept under (not a credential key).
pub const SETTING: &str = "windowState";
pub const DEFAULT_W: f64 = 1280.0;
pub const DEFAULT_H: f64 = 820.0;
pub const MIN_W: f64 = 720.0;
pub const MIN_H: f64 = 480.0;
/// Larger than any real screen arrangement: a kept number beyond it is a broken record.
const LIMIT: f64 = 100_000.0;
/// The strip at the window's top edge that has to stay reachable (to drag the window back).
const TITLE_H: f64 = 28.0;
/// How much of that strip has to be on a screen.
const REACH_W: f64 = 100.0;
const REACH_H: f64 = 14.0;

/// What is kept: the window's normal (not maximized) size and place, and whether it was maximized.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Saved {
    pub w: f64,
    pub h: f64,
    pub pos: Option<(f64, f64)>,
    pub maximized: bool,
}

/// One screen, in the same logical space as a kept position.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// What a start builds the window with. `pos: None` = centred.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub w: f64,
    pub h: f64,
    pub pos: Option<(f64, f64)>,
    pub maximized: bool,
}

/// What the window is doing when it is looked at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Normal,
    Maximized,
    /// full screen, minimized, or the state could not be read: nothing to learn from this look
    Other,
}

fn size_ok(v: f64) -> bool {
    v.is_finite() && v > 0.0 && v <= LIMIT
}

fn coord_ok(v: f64) -> bool {
    v.is_finite() && v.abs() <= LIMIT
}

/// A record value → `Saved`; anything not exactly the expected shape is no record at all.
pub fn parse(v: &Value) -> Option<Saved> {
    let o = v.as_object()?;
    let w = o.get("w")?.as_f64().filter(|v| size_ok(*v))?;
    let h = o.get("h")?.as_f64().filter(|v| size_ok(*v))?;
    let maximized = match o.get("maximized") {
        None => false,
        Some(m) => m.as_bool()?,
    };
    let pos = match (o.get("x"), o.get("y")) {
        (None, None) => None,
        (Some(x), Some(y)) => Some((x.as_f64().filter(|v| coord_ok(*v))?, y.as_f64().filter(|v| coord_ok(*v))?)),
        _ => return None,
    };
    Some(Saved { w, h, pos, maximized })
}

pub fn to_value(s: &Saved) -> Value {
    let mut v = json!({ "w": s.w, "h": s.h, "maximized": s.maximized });
    if let Some((x, y)) = s.pos {
        v["x"] = json!(x);
        v["y"] = json!(y);
    }
    v
}

/// The kept record; missing or broken reads as none.
pub fn saved(store: &Store) -> Option<Saved> {
    store.get_setting(SETTING).as_ref().and_then(parse)
}

/// The record after one look at the window: `size` is its inner size, `pos` its outer top-left
/// corner (None when the system would not say). Returns None when this look changes nothing.
pub fn observe(prev: Option<Saved>, mode: Mode, size: (f64, f64), pos: Option<(f64, f64)>) -> Option<Saved> {
    let next = match mode {
        Mode::Other => return None,
        Mode::Maximized => match prev {
            Some(p) => Saved { maximized: true, ..p },
            None => Saved { w: DEFAULT_W, h: DEFAULT_H, pos: None, maximized: true },
        },
        Mode::Normal => {
            if !size_ok(size.0) || !size_ok(size.1) {
                return None;
            }
            Saved { w: size.0, h: size.1, pos: pos.filter(|(x, y)| coord_ok(*x) && coord_ok(*y)), maximized: false }
        }
    };
    if Some(next) == prev {
        None
    } else {
        Some(next)
    }
}

/// `observe`, kept: returns the record when it changed (and whether keeping it worked).
pub fn keep(store: &Store, mode: Mode, size: (f64, f64), pos: Option<(f64, f64)>) -> Option<(Saved, Result<(), String>)> {
    let next = observe(saved(store), mode, size, pos)?;
    let kept = store.set_setting(SETTING, &to_value(&next));
    Some((next, kept))
}

/// How much of the window's title strip (top-left `pos`, `w` wide) lies on `s`.
fn reach(pos: (f64, f64), w: f64, s: &Screen) -> (f64, f64) {
    let ow = (pos.0 + w).min(s.x + s.w) - pos.0.max(s.x);
    let oh = (pos.1 + TITLE_H).min(s.y + s.h) - pos.1.max(s.y);
    (ow.max(0.0), oh.max(0.0))
}

/// What this start builds the window with. `screens`: the screens there are now, the primary
/// one first; empty when they could not be read.
pub fn placement(saved: Option<&Saved>, screens: &[Screen]) -> Placement {
    let Some(s) = saved else {
        return fit(DEFAULT_W, DEFAULT_H, None, false, screens.first());
    };
    // the screen the kept position is on: the one holding most of the title strip
    let home = s.pos.and_then(|p| {
        screens
            .iter()
            .map(|sc| (reach(p, s.w, sc), sc))
            .filter(|((ow, oh), _)| *ow >= REACH_W.min(s.w) && *oh >= REACH_H)
            .max_by(|a, b| (a.0 .0 * a.0 .1).total_cmp(&(b.0 .0 * b.0 .1)))
            .map(|(_, sc)| sc)
    });
    match home {
        Some(sc) => fit(s.w, s.h, s.pos, s.maximized, Some(sc)),
        None => fit(s.w, s.h, None, s.maximized, screens.first()),
    }
}

fn fit(w: f64, h: f64, pos: Option<(f64, f64)>, maximized: bool, screen: Option<&Screen>) -> Placement {
    let (mut w, mut h) = (w, h);
    if let Some(sc) = screen {
        if sc.w > 0.0 && sc.h > 0.0 {
            w = w.min(sc.w);
            h = h.min(sc.h);
        }
    }
    // the minimum wins over a screen smaller than it: the window is built with that minimum anyway
    Placement { w: w.max(MIN_W), h: h.max(MIN_H), pos, maximized }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("cavil-window-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir.join("cache.sqlite")).unwrap(), dir)
    }

    const MAIN: Screen = Screen { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 };
    const SIDE: Screen = Screen { x: 1920.0, y: 0.0, w: 2560.0, h: 1440.0 };

    #[test]
    fn nothing_kept_is_the_default_size_centred() {
        assert_eq!(placement(None, &[MAIN]), Placement { w: 1280.0, h: 820.0, pos: None, maximized: false });
        // screens unreadable: still the default
        assert_eq!(placement(None, &[]), Placement { w: 1280.0, h: 820.0, pos: None, maximized: false });
    }

    #[test]
    fn what_was_kept_comes_back_through_the_store() {
        let (s, dir) = store("roundtrip");
        assert_eq!(saved(&s), None);
        let (rec, kept) = keep(&s, Mode::Normal, (1600.0, 1000.0), Some((2000.0, 80.0))).unwrap();
        kept.unwrap();
        assert_eq!(rec, Saved { w: 1600.0, h: 1000.0, pos: Some((2000.0, 80.0)), maximized: false });
        assert_eq!(saved(&s), Some(rec));
        // a restart with both screens: exactly as left
        assert_eq!(placement(saved(&s).as_ref(), &[MAIN, SIDE]), Placement { w: 1600.0, h: 1000.0, pos: Some((2000.0, 80.0)), maximized: false });
        // the same look again changes nothing (no write)
        assert!(keep(&s, Mode::Normal, (1600.0, 1000.0), Some((2000.0, 80.0))).is_none());
        // a look without a position keeps the size alone
        let (rec, _) = keep(&s, Mode::Normal, (900.0, 600.0), None).unwrap();
        assert_eq!(rec.pos, None);
        assert_eq!(saved(&s), Some(rec));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_broken_record_is_no_record() {
        let (s, dir) = store("broken");
        for bad in [
            json!("1600x1000"),
            json!(1600),
            json!(null),
            json!([1600, 1000]),
            json!({}),
            json!({ "w": 1600 }),
            json!({ "w": "1600", "h": 1000 }),
            json!({ "w": -1600, "h": 1000 }),
            json!({ "w": 0, "h": 1000 }),
            json!({ "w": 1600, "h": 1e9 }),
            json!({ "w": 1600, "h": 1000, "x": 10 }),
            json!({ "w": 1600, "h": 1000, "x": 10, "y": "20" }),
            json!({ "w": 1600, "h": 1000, "x": 1e12, "y": 0 }),
            json!({ "w": 1600, "h": 1000, "maximized": "yes" }),
        ] {
            s.set_setting(SETTING, &bad).unwrap();
            assert_eq!(saved(&s), None, "{bad}");
            assert_eq!(placement(saved(&s).as_ref(), &[MAIN]), Placement { w: 1280.0, h: 820.0, pos: None, maximized: false }, "{bad}");
        }
        // and a good one written the same way is read (the loop above is not vacuous)
        s.set_setting(SETTING, &json!({ "w": 1600, "h": 1000, "x": -30, "y": 40, "maximized": true })).unwrap();
        assert_eq!(saved(&s), Some(Saved { w: 1600.0, h: 1000.0, pos: Some((-30.0, 40.0)), maximized: true }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sizes_are_held_between_the_minimum_and_the_screen() {
        let small = Saved { w: 300.0, h: 200.0, pos: Some((100.0, 100.0)), maximized: false };
        assert_eq!(placement(Some(&small), &[MAIN]), Placement { w: 720.0, h: 480.0, pos: Some((100.0, 100.0)), maximized: false });
        let big = Saved { w: 3000.0, h: 2000.0, pos: Some((0.0, 0.0)), maximized: false };
        assert_eq!(placement(Some(&big), &[MAIN]), Placement { w: 1920.0, h: 1080.0, pos: Some((0.0, 0.0)), maximized: false });
        // the limit is the screen the window is on, not the primary one
        let on_side = Saved { w: 2400.0, h: 1300.0, pos: Some((2000.0, 50.0)), maximized: false };
        assert_eq!(placement(Some(&on_side), &[MAIN, SIDE]), Placement { w: 2400.0, h: 1300.0, pos: Some((2000.0, 50.0)), maximized: false });
        // a screen smaller than the minimum: the minimum
        let tiny = Screen { x: 0.0, y: 0.0, w: 640.0, h: 400.0 };
        assert_eq!(placement(None, &[tiny]), Placement { w: 720.0, h: 480.0, pos: None, maximized: false });
        // the default shrinks to a small screen too
        let laptop = Screen { x: 0.0, y: 0.0, w: 1024.0, h: 768.0 };
        assert_eq!(placement(None, &[laptop]), Placement { w: 1024.0, h: 768.0, pos: None, maximized: false });
    }

    #[test]
    fn a_place_on_a_screen_that_is_gone_is_dropped_and_the_size_refitted() {
        let on_side = Saved { w: 2400.0, h: 1300.0, pos: Some((2000.0, 50.0)), maximized: false };
        // the side screen is unplugged: centred on the primary one, shrunk to it
        assert_eq!(placement(Some(&on_side), &[MAIN]), Placement { w: 1920.0, h: 1080.0, pos: None, maximized: false });
        // screens unreadable: the place cannot be checked, so it is not used; the size stays
        assert_eq!(placement(Some(&on_side), &[]), Placement { w: 2400.0, h: 1300.0, pos: None, maximized: false });
    }

    #[test]
    fn the_title_bar_has_to_stay_reachable() {
        let at = |x: f64, y: f64| Saved { w: 1000.0, h: 700.0, pos: Some((x, y)), maximized: false };
        let pos = |s: Saved| placement(Some(&s), &[MAIN]).pos;
        // partly off the left / right edge, enough of the title bar left: kept
        assert_eq!(pos(at(-800.0, 100.0)), Some((-800.0, 100.0)));
        assert_eq!(pos(at(1800.0, 100.0)), Some((1800.0, 100.0)));
        // only a sliver left: centred
        assert_eq!(pos(at(-950.0, 100.0)), None);
        assert_eq!(pos(at(1900.0, 100.0)), None);
        // title bar above the screen (the body still on it), or below it: centred
        assert_eq!(pos(at(100.0, -40.0)), None);
        assert_eq!(pos(at(100.0, 1075.0)), None);
        // bottom of the window off screen, title bar on it: kept
        assert_eq!(pos(at(100.0, 900.0)), Some((100.0, 900.0)));
    }

    #[test]
    fn maximized_keeps_the_normal_size_underneath() {
        let (s, dir) = store("max");
        keep(&s, Mode::Normal, (1500.0, 900.0), Some((60.0, 40.0))).unwrap().1.unwrap();
        // maximized: the look reports the screen-filling size, which must not replace the normal one
        let (rec, kept) = keep(&s, Mode::Maximized, (1920.0, 1052.0), Some((0.0, 0.0))).unwrap();
        kept.unwrap();
        assert_eq!(rec, Saved { w: 1500.0, h: 900.0, pos: Some((60.0, 40.0)), maximized: true });
        assert_eq!(placement(saved(&s).as_ref(), &[MAIN]), Placement { w: 1500.0, h: 900.0, pos: Some((60.0, 40.0)), maximized: true });
        // full screen / minimized / unreadable: nothing changes, nothing is written
        assert!(keep(&s, Mode::Other, (1920.0, 1080.0), Some((0.0, 0.0))).is_none());
        assert_eq!(saved(&s), Some(rec));
        // back to normal
        let (rec, _) = keep(&s, Mode::Normal, (1500.0, 900.0), Some((60.0, 40.0))).unwrap();
        assert!(!rec.maximized);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn maximized_with_nothing_kept_yet_and_unusable_looks() {
        assert_eq!(observe(None, Mode::Maximized, (1920.0, 1052.0), None), Some(Saved { w: 1280.0, h: 820.0, pos: None, maximized: true }));
        assert_eq!(observe(None, Mode::Other, (1000.0, 700.0), None), None);
        // a size the system could not have meant is not kept
        assert_eq!(observe(None, Mode::Normal, (0.0, 700.0), None), None);
        assert_eq!(observe(None, Mode::Normal, (f64::NAN, 700.0), None), None);
        // an unusable position: the size alone
        assert_eq!(observe(None, Mode::Normal, (1000.0, 700.0), Some((f64::INFINITY, 0.0))), Some(Saved { w: 1000.0, h: 700.0, pos: None, maximized: false }));
    }
}
