// Export a 256px PNG preview of the SVG icon so it can be visually inspected.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'icon.svg');
const OUT = path.join(__dirname, '..', 'build', 'icon-preview.png');

async function run() {
  await app.whenReady();
  fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
  const win = new BrowserWindow({
    width: 512, height: 512, show: false, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await win.loadFile(SRC);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('wrote', OUT);
  app.quit();
}

app.on('window-all-closed', () => app.quit());
app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });