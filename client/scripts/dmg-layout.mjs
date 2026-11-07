// The dmg window (GitHub#151: built by dmgbuild, see scripts/make-dmg.mjs), defined once:
// make-dmg.mjs hands it to scripts/dmg-settings.py, test/unit/dmg.test.ts checks it.
// Finder sizes the window (title bar included) to the background, so only the
// top ~430 px are visible: every icon and label stays above that.
export const DMG_WINDOW = { width: 660, height: 460 };
export const DMG_ICON_SIZE = 100;

/** Everything shown in the window: the app, the Applications link, the extra files (release-command.mjs). */
export const DMG_ICONS = [
  { type: 'app', x: 180, y: 120 },
  { type: 'link', path: '/Applications', x: 480, y: 120 },
  // the one help page, centred below the help box drawn in the background
  { type: 'file', ...{ path: 'build/复制放行命令.html', x: 330, y: 368 } },
];
