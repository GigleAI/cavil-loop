// Opens one local HTML file in a plain Electron window (no app code, no
// preload), the way a browser opens a file double-clicked in Finder.
// Used by test/e2e/copy-page.spec.ts; the file is CAVIL_TEST_PAGE.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false });
  void win.loadFile(process.env.CAVIL_TEST_PAGE);
});
