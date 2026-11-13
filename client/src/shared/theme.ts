// GitHub#516: light / dark for the window — the user's choice in Settings, and the one rule that
// turns it into what the window shows. Pure; shared by the controller (reads / writes the setting,
// tells the back end) and the renderer (marks the page, colours label chips and the discussion).

/** what the user picked in Settings; 'system' = follow the system's light / dark */
export type ThemeSetting = 'system' | 'light' | 'dark';
/** what the window shows */
export type Theme = 'light' | 'dark';

/** the settings key, kept on this machine only */
export const THEME_SETTING = 'uiTheme';
/** nothing set, or a value this version does not know: follow the system, as before the setting existed */
export const DEFAULT_THEME_SETTING: ThemeSetting = 'system';

/** whatever was saved: one of the three words, anything else follows the system */
export function normalizeThemeSetting(raw: unknown): ThemeSetting {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : DEFAULT_THEME_SETTING;
}

/** the setting against the system's light / dark (`null`: the system could not be read — light, the window's base look) */
export function resolveTheme(setting: ThemeSetting, systemDark: boolean | null): Theme {
  if (setting === 'light' || setting === 'dark') return setting;
  return systemDark === true ? 'dark' : 'light';
}

/** the system's light / dark as the window sees it, and its changes */
export interface SystemScheme {
  /** true = dark, false = light, null = cannot tell */
  dark(): boolean | null;
  /** call `cb` whenever the system switches; returns the way to stop */
  watch(cb: () => void): () => void;
}

/** the window's own media query ("prefers-color-scheme"); without one: cannot tell, never changes */
export function windowScheme(): SystemScheme {
  const q = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  return {
    dark: () => (q ? q.matches : null),
    watch(cb) {
      if (!q) return () => {};
      // Safari 14 has only the old listener API
      if (q.addEventListener) q.addEventListener('change', cb);
      else q.addListener(cb);
      return () => (q.removeEventListener ? q.removeEventListener('change', cb) : q.removeListener(cb));
    },
  };
}
