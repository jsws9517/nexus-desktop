// Build the Windows app icon from source SVG -> multi-size .ico (PNG-compressed entries).
// Runs under Electron (offscreen rasterization), outputs desktop/build/icon.ico.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'icon.svg');
const OUT_DIR = path.join(__dirname, '..', 'build');
const OUT = path.join(OUT_DIR, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function run() {
  await app.whenReady();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await win.loadFile(SRC);
  await new Promise((r) => setTimeout(r, 400));

  const img = await win.webContents.capturePage();
  const pngs = [];
  for (const s of SIZES) {
    const resized = img.resize({ width: s, height: s, quality: 'best' });
    pngs.push({ size: s, buffer: resized.toPNG() });
  }

  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  let offset = 6 + 16 * count;
  const entries = [];
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(p.size === 256 ? 0 : p.size, 0);
    e.writeUInt8(p.size === 256 ? 0 : p.size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(p.buffer.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.buffer.length;
    entries.push(e);
  }

  const ico = Buffer.concat([header, ...entries, ...pngs.map((p) => p.buffer)]);
  fs.writeFileSync(OUT, ico);
  console.log('wrote', OUT, ico.length, 'bytes');
  app.quit();
}

app.on('window-all-closed', () => app.quit());
app.whenReady().then(run).catch((e) => {
  console.error(e);
  app.exit(1);
});