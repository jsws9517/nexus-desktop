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
// Render the SVG natively at 1024 so every smaller size is a real downscale.
// (Previously the window was 512px, which meant the macOS 1024 master was an
// upscale of a 512 capture — visibly soft in the .icns.)
const RENDER = 1024;
// Windows .ico entries (256 is the maximum size the .ico container allows).
const SIZES = [16, 24, 32, 48, 64, 128, 256];
// electron-builder Linux icon-set sizes (file named `<s>x<s>.png`).
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
// macOS iconset entry sizes. `<base>x<base>` and `<base>x<base>@2x` must each
// be a true 1x/2x pair, i.e. 16/32, 32/64, 128/256, 256/512, 512/1024.
const ICONSET_BASES = [16, 32, 128, 256, 512];

// Tray/menu-bar glyphs live in icon-drafts/: they are a different surface (no
// tile, 2px-equivalent stroke at 16px, theme-tinted) and must not be confused
// with the app icon. Rendered at 256 and downscaled so the tray slots get real
// antialiasing instead of an OS-side resample of a 64px canvas.
const TRAY_SRC = {
  dark: path.join(__dirname, '..', 'icon-drafts', 'tray-dark.svg'),
  light: path.join(__dirname, '..', 'icon-drafts', 'tray-light.svg'),
};
const TRAY_RENDER = 256;
const TRAY_SIZES = [16, 24, 32];

const FIT_CSS =
  'html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:100vw;height:100vh}';

/** Render one SVG document into a square nativeImage of exactly `size`. */
let shotWin = null;
async function renderSvg(file, size) {
  // Reuse one offscreen window: this Electron build fails to load a new
  // BrowserWindow right after the previous one is destroyed (ERR_FAILED -2).
  if (!shotWin) {
    shotWin = new BrowserWindow({
      width: size,
      height: size,
      show: false,
      frame: false,
      useContentSize: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
  }
  shotWin.setContentSize(size, size);
  await shotWin.loadFile(file);
  // Scale whatever canvas size the SVG declares into the capture window, so the
  // source can change dimensions without silently cropping the artwork.
  await shotWin.webContents.insertCSS(FIT_CSS);
  // Give Chromium time to rasterize filters before capture.
  await new Promise((r) => setTimeout(r, 400));
  const img = await shotWin.webContents.capturePage();
  const captured = img.getSize();
  if (captured.width !== size || captured.height !== size) {
    throw new Error(`expected a ${size}x${size} capture, got ${captured.width}x${captured.height}`);
  }
  return img;
}

async function run() {
  await app.whenReady();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const img = await renderSvg(SRC, RENDER);

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
  console.log('wrote', pngIconDir, sizes.length, 'png files (master', RENDER + 'px capture)');

  // Tray / menu-bar images. The packaged app ships only dist/ + package.json, so
  // the tray cannot read build/ at runtime — the PNGs are embedded as data URLs
  // in src/main/index.ts. Emit the exact constants so syncing is a paste.
  const trayDir = path.join(OUT_DIR, 'tray');
  fs.mkdirSync(trayDir, { recursive: true });
  const trayConstants = [];
  for (const theme of ['dark', 'light']) {
    const rendered = await renderSvg(TRAY_SRC[theme], TRAY_RENDER);
    for (const s of TRAY_SIZES) {
      const png = rendered.resize({ width: s, height: s, quality: 'best' }).toPNG();
      fs.writeFileSync(path.join(trayDir, `${theme}-${s}.png`), png);
    }
    const png32 = rendered.resize({ width: 32, height: 32, quality: 'best' }).toPNG();
    trayConstants.push(
      `const TRAY_ICON_${theme.toUpperCase()}_URL =\n  'data:image/png;base64,${png32.toString('base64')}';`
    );
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'tray-icon.dataurl.txt'),
    trayConstants.join('\n\n') + '\n'
  );
  console.log('wrote', trayDir, 'and build/tray-icon.dataurl.txt');

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