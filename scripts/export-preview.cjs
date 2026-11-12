// Export a PNG preview of the SVG app icon so it can be visually inspected.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// Disable HW acceleration so offscreen page capture (capturePage) doesn't fail
// with Chromium "UnknownVizError" on GPU-less/remote sessions.
app.disableHardwareAcceleration();

const SRC = path.join(__dirname, '..', 'icon.svg');
const OUT = path.join(__dirname, '..', 'build', 'icon-preview.png');
// Preview at the SVG's own 1024 master size; the window scales the canvas so a
// future size change in icon.svg cannot silently crop the artwork.
const RENDER = 1024;

async function run() {
  await app.whenReady();
  fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
  const win = new BrowserWindow({
    width: RENDER, height: RENDER, show: false, frame: false, useContentSize: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await win.loadFile(SRC);
  await win.webContents.insertCSS(
    'html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:100vw;height:100vh}'
  );
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('wrote', OUT);
  app.quit();
}

app.on('window-all-closed', () => app.quit());
app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
