// Render icon drafts (icon-drafts/*.svg) to PNG sizes and a comparison sheet.
// Usage: electron scripts/render-icon-drafts.cjs
// Electron on Windows has no attached stdout, so progress goes to icon-drafts/render.log.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
const DRAFTS = path.join(ROOT, 'icon-drafts');
const OUT = path.join(DRAFTS, 'preview');
const SIZES = [16, 24, 32, 40, 48, 64, 128, 256, 512, 1024];

const VARIANTS = [
  {
    id: 'A-polyline',
    file: path.join(ROOT, 'icon.svg'),
    label: 'A · 折线枢纽（已采用）',
    note: '几何 N + 端点节点 / 纯平色 / 无滤镜',
  },
  { id: 'B-hub', label: 'B · 枢纽辐射', note: '中心核 + 四向连接 + 轨道环' },
  { id: 'C-lettermark', label: 'C · 几何字母标', note: '咬边 N + squircle 微光 + 投影' },
];

fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(DRAFTS, 'render.log');
fs.writeFileSync(LOG, '');
const log = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');

process.on('uncaughtException', (e) => {
  log('UNCAUGHT', e && e.stack ? e.stack : String(e));
  app.exit(1);
});
process.on('unhandledRejection', (e) => {
  log('UNHANDLED', e && e.stack ? e.stack : String(e));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One long-lived offscreen window, resized per capture.
let win = null;
let gen = 0;

async function shot(target, width, height, waitMs) {
  if (!win) {
    win = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      useContentSize: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.on('render-process-gone', (_e, d) => log('RENDER-GONE', JSON.stringify(d)));
    win.webContents.on('console-message', (_e, _l, msg) => log('page:', msg));
  }
  win.setContentSize(width, height);
  const tag = ++gen;
  log('load', target, width + 'x' + height, 'gen', tag);
  if (/^(https?|file):/.test(target)) await win.loadURL(target);
  else await win.loadFile(target);
  log('loaded gen', tag);
  await sleep(waitMs);
  log('capture gen', tag);
  const img = await win.webContents.capturePage();
  log('captured gen', tag, 'empty=' + img.isEmpty(), JSON.stringify(img.getSize()));
  return img;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function run() {
  await app.whenReady();
  log('electron', process.versions.electron);

  for (const v of VARIANTS) {
    const svg = v.file || path.join(DRAFTS, `${v.id}.svg`);
    if (!fs.existsSync(svg)) throw new Error(`missing ${svg}`);
    const master = await shot(svg, 1024, 1024, 600);
    if (master.isEmpty()) throw new Error('empty capture for ' + v.id);
    for (const s of SIZES) {
      const png =
        s === 1024 ? master.toPNG() : master.resize({ width: s, height: s, quality: 'best' }).toPNG();
      fs.writeFileSync(path.join(OUT, `${v.id}-${s}.png`), png);
    }
    log('rendered', v.id);
  }

  // ---- comparison sheet -------------------------------------------------
  const p = (id, s) => 'preview/' + id + '-' + s + '.png';
  const strip = (id, bg) =>
    `<div class="strip" style="background:${bg}">` +
    [16, 24, 32, 48, 64, 128]
      .map(
        (s) =>
          `<figure><img src="${p(id, s)}" width="${s}" height="${s}" alt=""><figcaption>${s}</figcaption></figure>`
      )
      .join('') +
    '</div>';

  const cards = VARIANTS.map(
    (v) => `
    <section class="card">
      <div class="hero">
        <img src="${p(v.id, 512)}" width="240" height="240" alt="">
        <div class="meta">
          <h2>${esc(v.label)}</h2>
          <p>${esc(v.note)}</p>
          <div class="tags"><span>squircle + 安全边距</span><span>无字体依赖</span><span>0 层发光滤镜</span></div>
        </div>
      </div>
      ${strip(v.id, '#12151c')}
      ${strip(v.id, '#f2f4f8')}
      ${strip(v.id, '#7b8089')}
    </section>`
  ).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin:0; padding:26px 28px; background:#0b0d12; color:#e7ecf5;
           font-family: "Segoe UI", system-ui, sans-serif; }
    h1 { font-size:19px; margin:0 0 4px; font-weight:650; letter-spacing:.2px; }
    .sub { color:#8b93a3; font-size:12.5px; margin:0 0 20px; }
    .grid { display:flex; flex-direction:column; gap:20px; }
    .card { background:#11141c; border:1px solid #1f2532; border-radius:16px; padding:18px 20px; }
    .hero { display:flex; gap:26px; align-items:center; margin-bottom:14px; }
    .hero img { border-radius:10px; }
    h2 { font-size:16px; margin:0 0 6px; font-weight:650; }
    .meta p { margin:0 0 10px; color:#98a1b2; font-size:13px; }
    .tags { display:flex; gap:8px; flex-wrap:wrap; }
    .tags span { font-size:11px; color:#9fb4d6; background:#182031; border:1px solid #223049;
                 border-radius:999px; padding:3px 9px; }
    .strip { display:flex; align-items:flex-end; gap:22px; padding:12px 16px; border-radius:10px;
             margin-top:8px; height:86px; }
    figure { margin:0; display:flex; flex-direction:column; align-items:center; gap:6px; }
    figcaption { font-size:9.5px; color:#cfd6e2; opacity:.55; font-variant-numeric:tabular-nums; }
    .strip[data-bg="light"] figcaption { color:#3a4250; opacity:1; }
  </style></head><body>
    <h1>Nexus Desktop · 图标重设计对比</h1>
    <p class="sub">1024 母版 → 真实缩放；每张卡片三行依次为深色底 / 浅色底 / 中性灰底。</p>
    <div class="grid">${cards}</div>
  </body></html>`;

  const sheet = path.join(DRAFTS, 'compare.html');
  fs.writeFileSync(sheet, html);
  log('wrote', sheet);

  await shot(sheet, 1180, 900, 400);
  const docH = await win.webContents.executeJavaScript(
    'Math.min(4000, Math.ceil(document.documentElement.scrollHeight))'
  );
  log('sheet height', docH);
  win.setContentSize(1180, docH);
  await sleep(500);
  const sheetShot = await win.webContents.capturePage();
  if (sheetShot.isEmpty()) throw new Error('empty sheet capture');
  fs.writeFileSync(path.join(OUT, 'compare.png'), sheetShot.toPNG());
  log('wrote', path.join(OUT, 'compare.png'));

  app.exit(0);
}

app.on('window-all-closed', () => app.quit());
app.whenReady().then(run).catch((e) => {
  log('FAILED', e && e.stack ? e.stack : String(e));
  app.exit(1);
});
