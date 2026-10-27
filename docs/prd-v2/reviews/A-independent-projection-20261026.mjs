// Independent rerun; derived from out/prd-v2/2026-10-26-a/A/render/verify-projection.mjs, sha256=51054ff39c1f8b9033df64ef6ec2a52c47b4728bae0a14d3a452a37af31b3fc6.
// Only ROOT and output filename changed; original A evidence is not overwritten.
// 交叉验证：离线 renderState 投影 vs 真实浏览器 viewer 的像素投影。
//
// 关键点：不猜相机。先从页面读 cameraSnapshot()（真实在用相机），
// 把同一组参数（eye/target/fov/aspect/viewport/viewRect）喂给离线 makeCamera，
// 再对同一批世界点逐点比较像素。误差应当只在浮点量级（<0.01 px）。
//
// 用法：node out/prd-v2/2026-10-26-a/A/render/verify-projection.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rs = await import(pathToFileURL(path.join(ROOT, 'src/core/actions-v1/render-state.js')).href);
const core = await import(pathToFileURL(path.join(ROOT, 'src/core/core.js')).href);

const PLATE = 0.4;
const pick = (o, k, d) => (o && o[k] !== undefined ? o[k] : d);

function findChromium() {
  return [process.env.CHROMIUM_PATH,
    'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean).find((p) => fs.existsSync(p)) || null;
}
const exe = findChromium();
if (!exe) { console.log(JSON.stringify({ ok: false, reason: 'no-chromium' })); process.exit(2); }
const { chromium } = await import('playwright');

const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts;
const ext = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts;
const cat = { parts: { ...ext, ...curated }, colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors };
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/cottage.brick.json'), 'utf8'));

const html = fs.readFileSync(path.join(ROOT, 'dist/viewer.html'), 'utf8');
const embedded = html.replace('<!--MODEL-->', () => `<script>window.__BRICK_MODEL__=${JSON.stringify(model).replace(/</g, '\\u003c')}</script><script>window.__GEOM_PARAM__=false</script>`);
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-')), 'v.html');
fs.writeFileSync(tmp, embedded, 'utf8');

const W = 900, H = 1000;
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('file://' + tmp + `#shot=1&az=0&el=5&w=${W}&h=${H}&geom=param`);
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 60000 });
await page.waitForTimeout(300);

const snap = await page.evaluate(() => window.brickkit.cameraSnapshot());
if (!snap || !snap.position) {
  await browser.close();
  console.log(JSON.stringify({ ok: false, reason: 'cameraSnapshot-unavailable' }));
  process.exit(2);
}

// 探测点：零件中心的 3D 世界坐标（覆盖画面各个方位），用 viewer 自己的投影取真值
const probes = model.parts.slice(0, 60).map((p) => {
  const def = cat.parts[p.part];
  const c = core.partCenter(p, def);
  return { id: p.id, part: p.part, core: c };
});
const viewerPx = await page.evaluate((pts) => pts.map((q) => window.brickkit.projectWorldPoint(q[0], q[1], q[2])), probes.map((p) => p.core));
await browser.close();
if (errs.length) { console.log(JSON.stringify({ ok: false, reason: 'page-error', errs: errs.slice(0, 5) })); process.exit(1); }

// 用真实相机参数构造离线相机（等价参数化：由 eye/target 反解 distance，fov/aspect 直接取）
const target = snap.target;
const dist = Math.hypot(snap.position[0] - target[0], snap.position[1] - target[1], snap.position[2] - target[2]);
const d = snap.dir;
const cam = rs.makeCamera({
  azimuthDeg: (Math.atan2(d[0], d[2]) * 180) / Math.PI,
  elevationDeg: (Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI,
  target, distance: dist,
  width: snap.canvas.clientWidth, height: snap.canvas.clientHeight,
  fovYDeg: snap.fov,
  near: snap.near, far: snap.far,
  viewRect: { x: 0, y: 0, width: snap.canvas.clientWidth, height: snap.canvas.clientHeight },
});

// 逐点比较（核心点在 [x格, y片, z格]）
const rows = probes.map((p, i) => {
  const world = rs.coreToWorld(p.core);
  const off = rs.projectPoint(cam, world);
  const v = viewerPx[i];
  const dx = off.x - v.x, dy = off.y - v.y;
  return {
    id: p.id, part: p.part,
    core: p.core, world: world.map((x) => Math.round(x * 1e6) / 1e6),
    offline: [Math.round(off.x * 1e4) / 1e4, Math.round(off.y * 1e4) / 1e4],
    viewer: [Math.round(v.x * 1e4) / 1e4, Math.round(v.y * 1e4) / 1e4],
    dPx: Math.round(Math.hypot(dx, dy) * 1e4) / 1e4,
    depthDiff: Math.round((off.depth - (v.z !== undefined ? v.z : 0)) * 1e6) / 1e6,
  };
});
const maxD = Math.max(...rows.map((r) => r.dPx));
const meanD = rows.reduce((s, r) => s + r.dPx, 0) / rows.length;
const within = (t) => rows.filter((r) => r.dPx <= t).length;

const out = {
  ok: maxD <= 0.5,
  tolerancePx: 0.5,
  maxDeltaPx: maxD,
  meanDeltaPx: Math.round(meanD * 1e4) / 1e4,
  within0_01: within(0.01),
  within0_1: within(0.1),
  within0_5: within(0.5),
  total: rows.length,
  cameraFromViewer: snap,
  cameraOffline: { eye: cam.eye, target: cam.target, distance: cam.distance, fovYDeg: cam.fovYDeg, aspect: cam.aspect, mode: cam.mode },
  worst: [...rows].sort((a, b) => b.dPx - a.dPx).slice(0, 5),
};
const outDir = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'A-independent-projection-20261026.json'), JSON.stringify({ summary: out, rows }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(out, null, 1));
