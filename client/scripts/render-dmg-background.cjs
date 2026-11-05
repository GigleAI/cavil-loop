// Render build/dmg-background.html into build/background.png (660x480) and
// build/background@2x.png with Electron. Run by hand after editing the HTML:
//   npx electron scripts/render-dmg-background.cjs   (Linux without a display: add --ozone-platform=headless --no-sandbox)
// The PNGs are committed; electron-builder uses them as the dmg window background.
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const W = 660, H = 480;
const build = join(__dirname, '..', 'build');
// keep running between the two windows (default: quit when the last one closes)
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
    const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, webPreferences: { offscreen: true } });
    win.setContentSize(W * scale, H * scale);
    await win.loadFile(join(build, 'dmg-background.html'));
    win.webContents.setZoomFactor(scale);
    await new Promise((r) => setTimeout(r, 500));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: W * scale, height: H * scale });
    writeFileSync(join(build, name), img.toPNG());
    console.log(name, img.getSize());
    win.destroy();
  }
  app.quit();
});
