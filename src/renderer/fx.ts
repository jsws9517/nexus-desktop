/**
 * Minimal ambient particle-network background for the Nexus desktop UI.
 *
 * Zero dependencies: everything is drawn on the local #fx-canvas, so the CSP
 * in static/index.html (`script-src 'self'`) stays valid. The palette follows
 * `document.documentElement.dataset.theme` (dark | warm) automatically.
 */

interface FxNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  glow: boolean;
}

interface FxPalette {
  node: string; // css color for node fill
  linkRgb: string; // "r, g, b" triplet for rgba() connecting lines
  span: number; // link distance threshold in logical px
}

const DARK: FxPalette = { node: '#9cc0ff', linkRgb: '79, 140, 255', span: 150 };
const WARM: FxPalette = { node: '#e8c98a', linkRgb: '224, 164, 88', span: 150 };

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let nodes: FxNode[] = [];
let raf = 0;
let running = false;
let resizeTimer = 0;
let reducedMotion = false;

function palette(): FxPalette {
  return document.documentElement.dataset.theme === 'warm' ? WARM : DARK;
}

function resize(): void {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const wl = window.innerWidth;
  const hl = window.innerHeight;
  const target = Math.min(110, Math.max(36, Math.floor((wl * hl) / 22000)));
  nodes = [];
  for (let i = 0; i < target; i++) {
    nodes.push({
      x: Math.random() * wl,
      y: Math.random() * hl,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      r: 1 + Math.random() * 1.5,
      glow: i % 7 === 0,
    });
  }
}

function draw(t: number): void {
  if (!ctx) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  const pal = palette();
  const time = t / 1000;

  for (const n of nodes) {
    n.x += n.vx;
    n.y += n.vy;
    if (n.x < -20) n.x = w + 20;
    else if (n.x > w + 20) n.x = -20;
    if (n.y < -20) n.y = h + 20;
    else if (n.y > h + 20) n.y = -20;
  }

  ctx.lineWidth = 1;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      const span = pal.span;
      if (d2 < span * span) {
        const alpha = (1 - Math.sqrt(d2) / span) * 0.34;
        if (alpha <= 0.004) continue;
        ctx.strokeStyle = `rgba(${pal.linkRgb}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  for (const n of nodes) {
    if (n.glow) {
      const pulse = 0.55 + 0.45 * Math.sin(time * 2 + n.x * 0.03);
      ctx.globalAlpha = 0.35 + 0.4 * pulse;
      ctx.fillStyle = pal.node;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = pal.node;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function tick(t: number): void {
  if (!running) return;
  draw(t);
  raf = requestAnimationFrame(tick);
}

function start(): void {
  if (running || reducedMotion || !ctx) return;
  running = true;
  raf = requestAnimationFrame(tick);
}

function stop(): void {
  running = false;
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

function onVisibility(): void {
  if (document.hidden) stop();
  else start();
}

export function initFx(): void {
  if (!canvas) {
    canvas = document.getElementById('fx-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    if (!ctx) return;
  }
  reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? true : false;
  resize();
  window.addEventListener('resize', () => {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 180);
  });
  document.addEventListener('visibilitychange', onVisibility);
  // Repaint once when the theme attribute flips (matters for reduced-motion
  // users; live animation already picks up the new palette each frame).
  const mo = new MutationObserver(() => {
    if (reducedMotion) draw(performance.now());
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (reducedMotion) {
    draw(performance.now());
  } else {
    start();
  }
}