// C0-2 独立复核用的改编副本：与 out/prd-v2/2026-10-26-a/A/render/verify-projection-ortho.mjs
// 逐字相同，仅改两处——ROOT 相对层数（本文件位于 docs/prd-v2/reviews/）与
// 输出路径（写到 docs/prd-v2/reviews/C0-2-projection-verify-ortho.json，不覆盖 A 的原始证据）。
// 正交投影对账：离线 renderState 的 orthographic 分支 vs 真实浏览器 viewer 的 ortho=1。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rs = await import(pathToFileURL(path.join(ROOT, 'src/core/actions-v1/render-state.js')).href);
const core = await import(pathToFileURL(path.join(ROOT, 'src/core/core.js')).href);

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
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ortho-')), 'v.html');
fs.writeFileSync(tmp, embedded, 'utf8');

const W = 900, H = 1000;
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
// ortho=1 才会把相机换成 OrthographicCamera
await page.goto('file://' + tmp + `#shot=1&az=0&el=5&w=${W}&h=${H}&geom=param&ortho=1`);
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 60000 });
await page.waitForTimeout(300);

const snap = await page.evaluate(() => window.brickkit.cameraSnapshot());
if (!snap || !snap.position) {
  await browser.close();
  console.log(JSON.stringify({ ok: false, reason: 'cameraSnapshot-unavailable' }));
  process.exit(2);
}
if (snap.orthoHalfHeight === null || snap.orthoHalfHeight === undefined) {
  await browser.close();
  console.log(JSON.stringify({ ok: false, reason: 'viewer-not-orthographic', cameraType: snap.type }));
  process.exit(2);
}

const probes = model.parts.slice(0, 60).map((p) => {
  const def = cat.parts[p.part];
  return { id: p.id, part: p.part, core: core.partCenter(p, def) };
});
const viewerPx = await page.evaluate((pts) => pts.map((q) => window.brickkit.projectWorldPoint(q[0], q[1], q[2])), probes.map((p) => p.core));
await browser.close();
if (errs.length) { console.log(JSON.stringify({ ok: false, reason: 'page-error', errs: errs.slice(0, 5) })); process.exit(1); }

// 用 viewer 真实在用的半高构造离线正交相机 —— 不自己算取景
const target = snap.target;
const dist = Math.hypot(snap.position[0] - target[0], snap.position[1] - target[1], snap.position[2] - target[2]);
const d = snap.dir;
const cam = rs.makeCamera({
  mode: 'orthographic',
  orthoHalfHeight: snap.orthoHalfHeight,
  azimuthDeg: (Math.atan2(d[0], d[2]) * 180) / Math.PI,
  elevationDeg: (Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI,
  target, distance: dist,
  width: snap.canvas.clientWidth, height: snap.canvas.clientHeight,
  near: snap.near, far: snap.far,
  viewRect: { x: 0, y: 0, width: snap.canvas.clientWidth, height: snap.canvas.clientHeight },
});

const rows = probes.map((p, i) => {
  const world = rs.coreToWorld(p.core);
  const off = rs.projectPoint(cam, world);
  const v = viewerPx[i];
  const dx = off.x - v.x, dy = off.y - v.y;
  return {
    id: p.id, part: p.part,
    offline: [Math.round(off.x * 1e4) / 1e4, Math.round(off.y * 1e4) / 1e4],
    viewer: [Math.round(v.x * 1e4) / 1e4, Math.round(v.y * 1e4) / 1e4],
    dPx: Math.round(Math.hypot(dx, dy) * 1e4) / 1e4,
  };
});
const maxD = Math.max(...rows.map((r) => r.dPx));
const meanD = rows.reduce((s, r) => s + r.dPx, 0) / rows.length;

const out = {
  ok: maxD <= 0.5,
  mode: 'orthographic',
  tolerancePx: 0.5,
  maxDeltaPx: maxD,
  meanDeltaPx: Math.round(meanD * 1e4) / 1e4,
  within0_01: rows.filter((r) => r.dPx <= 0.01).length,
  within0_1: rows.filter((r) => r.dPx <= 0.1).length,
  within0_5: rows.filter((r) => r.dPx <= 0.5).length,
  total: rows.length,
  // 注意：透视模式下 fov 是主参数，正交模式下 orthoHalfHeight 才是；两者不可互换
  cameraFromViewer: { type: snap.type, orthoHalfHeight: snap.orthoHalfHeight, orthoHalfWidth: snap.orthoHalfWidth, fov: snap.fov, aspect: snap.aspect },
  worst: [...rows].sort((a, b) => b.dPx - a.dPx).slice(0, 5),
};
const outDir = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(outDir, 'C0-2-projection-verify-ortho.json'), JSON.stringify({ summary: out, rows }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 1);
