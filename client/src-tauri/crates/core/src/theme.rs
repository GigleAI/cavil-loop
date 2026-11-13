//! GitHub#516: the window's light / dark, as the window names it (src/shared/theme.ts). The shell
//! hands the native window (title bar, menus, native controls) the same choice; "system" = the
//! native window follows the system by itself.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Theme {
    System,
    Light,
    Dark,
}

impl Theme {
    /// only the window's three words; anything else is refused
    pub fn parse(v: &str) -> Option<Theme> {
        match v {
            "system" => Some(Theme::System),
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_words() {
        assert_eq!(Theme::parse("system"), Some(Theme::System));
        assert_eq!(Theme::parse("light"), Some(Theme::Light));
        assert_eq!(Theme::parse("dark"), Some(Theme::Dark));
        for bad in ["", "Dark", "auto", " light"] {
            assert_eq!(Theme::parse(bad), None, "{bad:?}");
        }
    }
}
