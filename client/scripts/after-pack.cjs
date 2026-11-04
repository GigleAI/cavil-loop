// electron-builder afterPack hook (macOS): give the whole .app bundle an
// ad-hoc signature before it goes into the dmg. Apple silicon refuses to run
// unsigned code, and electron-builder's own signing is turned off (no Apple
// Developer ID in v1). An ad-hoc signature is NOT an Apple signature:
// Gatekeeper still asks on first open (see RELEASE_NOTES.md).
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
