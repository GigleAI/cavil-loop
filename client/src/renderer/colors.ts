import { useSyncExternalStore, type CSSProperties } from 'react';
import type { Theme } from '../shared/theme';

// Label chips (GitHub#181): one rule for the board card, the table and the detail panel.
// GitHub's label colours are picked for a light page; in dark mode a solid chip glares,
// so — like GitHub's own dark theme — the chip becomes a tinted see-through fill with a
// lightened text colour. Either way the text keeps at least 4.5:1 against what is behind it.

type RGB = [number, number, number];

function parseHex(hex: string): RGB | null {
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
}

/** WCAG relative luminance */
function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio of two opaque colours */
export function contrast(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB;
const css = ([r, g, b]: RGB) => `rgb(${r}, ${g}, ${b})`;

const INK: RGB = [31, 35, 40]; // --fg (light)
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
/** the lightest surface a chip sits on in dark mode (--hover, a hovered table row); light text only loses contrast on lighter ground */
export const DARK_SURFACE: RGB = [33, 40, 48];
const FALLBACK = 'dddddd';

/** Text colour for a solid chip on a light page: whichever of ink / white reads better, pure black if neither reaches 4.5:1. */
export function textColor(hex: string): string {
  const bg = parseHex(hex) ?? parseHex(FALLBACK)!;
  const best = contrast(INK, bg) >= contrast(WHITE, bg) ? INK : WHITE;
  return css(contrast(best, bg) >= 4.5 ? best : BLACK);
}

/** The chip's style. `dark`: the window is in dark mode. */
export function labelStyle(hex: string, dark: boolean): CSSProperties {
  const c = parseHex(hex) ?? parseHex(FALLBACK)!;
  if (!dark) return { background: css(c), color: textColor(hex), borderColor: 'transparent' };
  // the fill as it looks on the lightest dark surface: 18% of the label colour over it
  const fill = mix(DARK_SURFACE, c, 0.18);
  // lighten the label colour until it reads on that fill
  let fg = c;
  for (let t = 0; t <= 1 && contrast(fg, fill) < 4.5; t += 0.05) fg = mix(c, WHITE, t);
  if (contrast(fg, fill) < 4.5) fg = WHITE;
  return { background: `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.18)`, color: css(fg), borderColor: `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.45)` };
}

/**
 * GitHub#516: what the window shows, light or dark — the controller's `theme` (Settings' choice
 * resolved against the system), not the system's own setting. `applyTheme` marks the page root
 * (the stylesheet's tokens follow it) and re-renders everything that colours itself in code.
 */
let shown: Theme | null = null;
const listeners = new Set<() => void>();

export function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  if (theme === shown) return;
  shown = theme;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True while the window shows dark (before anything was applied: what the page root says, else light). */
export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribe, isDark, isDark);
}

function isDark(): boolean {
  if (shown) return shown === 'dark';
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
}
