// Build app icons from the source SVG.
// Runs under Electron (offscreen rasterization). Outputs:
//   - desktop/build/icon.ico          (Windows, PNG-compressed multi-size)
//   - desktop/build/icon.png          (512px, Linux single-file fallback)
//   - desktop/build/icons/<s>x<s>.png (electron-builder Linux icon set)
//   - desktop/build/icon.icns         (macOS, via iconutil on darwin)
//
// Linux builds (AppImage/deb) need a real PNG icon, not the Electron default,
// so a 512px source capture is resized to the sizes electron-builder looks
// for in a `build/icons` directory: 16, 24, 32, 48, 64, 128, 256, 512.
//
// macOS needs a 1024px master (electron-builder converts .png → .icns, but the
// 1024 master is also used to assemble a .iconset for `iconutil`, which is
// the only thing that produces a spec-compliant .icns on every macOS version).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Disable HW acceleration so offscreen page capture (capturePage) doesn't fail
// with Chromium "UnknownVizError" on GPU-less/remote sessions.
app.disableHardwareAcceleration();

const SRC = path.join(__dirname, '..', 'icon.svg');
const OUT_DIR = path.join(__dirname, '..', 'build');
const OUT = path.join(OUT_DIR, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
// electron-builder Linux icon-set sizes (file named `<s>x<s>.png`).
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
// macOS iconset entry sizes. `<base>x<base>` and `<base>x<base>@2x` must each
// be a true 1x/2x pair, i.e. 16/32, 32/64, 128/256, 256/512, 512/1024.
const ICONSET_BASES = [16, 32, 128, 256, 512];

async function run() {
  await app.whenReady();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    useContentSize: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await win.loadFile(SRC);
  // Give the SVG filters (feGaussianBlur / feMerge) time to rasterize before capture.
  await new Promise((r) => setTimeout(r, 800));

  const img = await win.webContents.capturePage();

  // Windows .ico source buffers (PNG-compressed entries).
  const pngs = [];
  for (const s of SIZES) {
    const resized = img.resize({ width: s, height: s, quality: 'best' });
    pngs.push({ size: s, buffer: resized.toPNG() });
  }

  // Linux icon set: 16x16.png … 512x512.png, plus a 512px master `icon.png`.
  // Capture the 512px resize once and reuse it for both the master PNG and the
  // 512 entry of the Linux set (identical bytes).
  const pngIconDir = path.join(OUT_DIR, 'icons');
  fs.mkdirSync(pngIconDir, { recursive: true });
  const sizes = Array.from(new Set([...LINUX_SIZES, 512]));
  for (const s of sizes) {
    const resized = s === 512 ? img.resize({ width: 512, height: 512, quality: 'best' })
                              : img.resize({ width: s, height: s, quality: 'best' });
    fs.writeFileSync(path.join(pngIconDir, `${s}x${s}.png`), resized.toPNG());
  }
  // Master 512px source PNG (Linux single-file fallback when a directory is not given).
  const master = img.resize({ width: 512, height: 512, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), master);
  console.log('wrote', pngIconDir, sizes.length, 'png files');

  // macOS .icns: assemble a .iconset from the 1024px master and run iconutil.
  // iconutil is a macOS built-in; on Windows/Linux this step is skipped and the
  // CI mac job (or electron-builder's png→icns conversion) covers it.
  if (process.platform === 'darwin') {
    const iconsetDir = path.join(OUT_DIR, 'icon.iconset');
    fs.rmSync(iconsetDir, { recursive: true, force: true });
    fs.mkdirSync(iconsetDir, { recursive: true });
    const master1024 = img.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG();
    const pairs = [
      ['icon_16x16.png', 16],
      ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32],
      ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128],
      ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256],
      ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512],
      ['icon_512x512@2x.png', 1024],
    ];
    for (const [name, px] of pairs) {
      const png = px === 1024 ? master1024 : img.resize({ width: px, height: px, quality: 'best' }).toPNG();
      fs.writeFileSync(path.join(iconsetDir, name), png);
    }
    const icnsOut = path.join(OUT_DIR, 'icon.icns');
    const res = spawnSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsOut], { stdio: 'inherit' });
    if (res.status === 0) {
      fs.rmSync(iconsetDir, { recursive: true, force: true });
      console.log('wrote', icnsOut);
    } else {
      console.error('iconutil failed (exit', res.status, ') — macOS .icns not generated');
    }
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