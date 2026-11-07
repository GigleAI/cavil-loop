// The one terminal command that lets macOS open the unsigned app the first
// time (removes the "downloaded from the internet" mark). Defined here once;
// every place that shows it to a user carries a copy, and
// test/unit/dmg.test.ts requires each copy to match this text exactly:
// build/复制放行命令.html, build/dmg-background.html
// (drawn into the dmg background), RELEASE_NOTES.md, scripts/mac-open-check.sh.
export const RELEASE_COMMAND = 'xattr -dr com.apple.quarantine "/Applications/Cavil Loop.app"';

// Every file shown in the dmg window besides the app and the Applications link:
// one help page only (GitHub#228 — the .txt that repeated it is gone).
export const DMG_EXTRA_FILES = ['build/复制放行命令.html'];
