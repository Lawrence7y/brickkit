// 生成 LDraw 素材预览图库（素材库可视化）：
//   out/ldraw-gallery/<id>.svg    每个目录零件一张矢量预览（可复用进拼装图纸/清单）
//   out/ldraw-gallery/index.html  自包含离线画廊（全部 165 种，含核对状态，双击即看）
//   --fragment <path>             另写一份内嵌精简数据的会话内可视化片段
//   --screenshot                  用无头 Chromium 对 index.html 截图做视觉自检
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { trianglesFromText, refCandidates, safeJoin, OFFICIAL_ALIASES } from '../src/ldraw/ldraw.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const parts = readJSON(path.join(ROOT, 'catalog/parts.json')).parts;
const verif = fs.existsSync(path.join(ROOT, 'catalog/ldraw/verification.json')) ? readJSON(path.join(ROOT, 'catalog/ldraw/verification.json')) : null;
const verRow = Object.fromEntries((verif?.results || []).map((r) => [r.id, r]));

const roots = ['catalog/ldraw', 'catalog/ldraw-full'].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
const readLib = (raw) => { for (const root of roots) for (const lp of refCandidates(raw)) { const f = safeJoin(root, lp); if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); } return null; };

// —— 视图投影：偏航 -30°、自上方俯角 22° 的正交视图，画法器排序 + 背面剔除 + 平板光照 ——
// 注意 LDraw +y 朝下：俯视相机取负俯仰角，使零件顶部（y 更小）更靠近相机
const YAW = (-30 * Math.PI) / 180, PITCH = (-22 * Math.PI) / 180;
const CY = Math.cos(YAW), SY = Math.sin(YAW), CP = Math.cos(PITCH), SP = Math.sin(PITCH);
const toView = (p) => {
  const x = p[0] * CY + p[2] * SY, z1 = -p[0] * SY + p[2] * CY;
  return [x, p[1] * CP - z1 * SP, p[1] * SP + z1 * CP];
};
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// 投影为二维多边形（视图空间），可选最小投影面积过滤（ld²）；返回 null 表示无实体几何
function project(tris, minArea = 0, round = 0) {
  const polys = [];
  for (const poly of tris) {
    const v = poly.map(toView);
    const n = norm(cross(sub(v[1], v[0]), sub(v[2], v[0])));
    if (n[2] <= 0) continue; // 相机在 +z2 看向 -z2：只保留法线朝向相机的面
    const light = norm([0.35, -0.62, 0.7]); // 外法线语境：照亮物理顶面与正面
    let a = 0;
    for (let i = 0; i < v.length; i++) {
      const [p, q] = [v[i], v[(i + 1) % v.length]];
      a += p[0] * q[1] - q[0] * p[1];
    }
    if (Math.abs(a / 2) < minArea) continue;
    const shade = 0.52 + 0.48 * Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
    const r = (x) => (round ? Math.round(x * 10 ** round) / 10 ** round : x);
    polys.push({ pts: v.map((p) => [r(p[0]), r(p[1])]), d: v.reduce((s, p) => s + p[2], 0) / v.length, s: Math.round(shade * 100) / 100, a: Math.abs(a / 2) });
  }
  return polys.length ? polys : null;
}

// 轻量版：过滤微小多边形、按面积保留最大的 maxPolys 个，并压成扁平数组
// [x1,y1,x2,y2,…,depth,shade%]，供内嵌片段使用（体积约为对象编码的 1/3）
function litePolys(tris, minArea = 8, maxPolys = 100) {
  const polys = project(tris, minArea, 0);
  if (!polys) return polys;
  const picked = polys.length <= maxPolys ? polys : [...polys].sort((x, y) => y.a - x.a).slice(0, maxPolys);
  return picked.map((p) => [...p.pts.flat(), Math.round(p.d), Math.round(p.s * 100)]);
}

function svgOf(polys, w = 120, h = 120) {
  const xs = polys.flatMap((p) => p.pts.map((q) => q[0])), ys = polys.flatMap((p) => p.pts.map((q) => q[1]));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min((w - 12) / (x1 - x0 || 1), (h - 12) / (y1 - y0 || 1));
  const ox = w / 2 - (k * (x0 + x1)) / 2, oy = h / 2 - (k * (y0 + y1)) / 2;
  const body = [...polys].sort((a, b) => a.d - b.d).map((p) => {
    const pts = p.pts.map(([x, y]) => `${(k * x + ox).toFixed(1)},${(k * y + oy).toFixed(1)}`).join(' ');
    return `<polygon points="${pts}" fill="hsl(210 8% ${Math.round(28 + p.s * 46)}%)" stroke="hsl(210 12% 24%)" stroke-width="0.6" stroke-linejoin="round"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img">${body}</svg>`;
}

// —— 收集全部零件数据 ——
const dataset = [];
const CATEGORY_ZH = { brick: '基础砖', plate: '板', tile: '光面板', slope: '斜面砖', cslope: '弧面/拱门', round: '圆件', snot: 'SNOT 侧凸点', bracket: '支架', hinge: '把柄/夹板/合页', wedge: '楔形机翼', building: '门窗/挡板', technic: '科技件', extra: '官方补充件' };
const EXTRA = [
  // 不在 165 种目录内、但重建核对需要的官方库零件（渲染自 catalog/ldraw-full 全量镜像）
  ['60470b', '侧边双水平夹板 1×2（厚 C 夹，翼根候选）'],
  ['30367a', '穹顶 2×2（顶部盲孔凸点，553b 迁移号）'],
  ['30367b', '穹顶 2×2（带轴孔，顶部圆件接口候选）'],
  ['4085b', '竖直夹板 1×1（薄 U 夹）'],
  ['4085c', '竖直夹板 1×1（厚 U 夹）'],
  ['4589', '圆锥 1×1（4589b 迁移号）'],
];
const headerDesc = (text) => (text.split(/\r?\n/).find((l) => /^0\s/.test(l)) || '').replace(/^0\s+/, '').trim();
const headerDescOf = (id) => { const t = readLib(`${id}.dat`); return t ? headerDesc(t) : ''; };
let fail = [];
const addPart = (id, def) => {
  const text = readLib(`${OFFICIAL_ALIASES[id] || id}.dat`);
  const tris = text && trianglesFromText(text, readLib);
  if (!tris) { fail.push(id); return; }
  const row = verRow[id] || {};
  dataset.push({
    id, zh: def.zh, c: def.category || def.kind, s: row.status || 'match', bad: row.ok === false ? 1 : 0,
    alias: OFFICIAL_ALIASES[id] || undefined, desc: row.officialDesc || (def.category === 'extra' ? headerDescOf(OFFICIAL_ALIASES[id] || id) : undefined),
    m: row.measured, e: row.expected,
    full: project(tris, 2, 1), lite: litePolys(tris),
  });
};
for (const [id, def] of Object.entries(parts)) addPart(id, def);
for (const [id, zh] of EXTRA) addPart(id, { zh, category: 'extra' });
const cats = [...new Set(dataset.map((d) => d.c))];
console.error(`已渲染 ${dataset.length}/${Object.keys(parts).length + EXTRA.length} 种零件${fail.length ? `，失败：${fail.join(',')}` : ''}；类别：${cats.length}`);

const OUT = path.join(ROOT, 'out/ldraw-gallery');
fs.mkdirSync(OUT, { recursive: true });
for (const d of dataset) fs.writeFileSync(path.join(OUT, `${d.id}.svg`), svgOf(d.full, 160, 160));

const RENDERER = `
function polysOf(d, lite) {
  const polys = lite ? d.lite : d.full;
  return polys.map((p) => Array.isArray(p)
    ? { pts: Array.from({ length: (p.length - 2) / 2 }, (_, i) => [p[i * 2], p[i * 2 + 1]]), d: p[p.length - 2], s: p[p.length - 1] / 100 }
    : p);
}
function render(d, lite, w, h) {
  const polys = polysOf(d, lite);
  const xs = polys.flatMap(p => p.pts.map(q => q[0])), ys = polys.flatMap(p => p.pts.map(q => q[1]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.min((w - 10) / ((x1 - x0) || 1), (h - 10) / ((y1 - y0) || 1));
  const ox = w / 2 - k * (x0 + x1) / 2, oy = h / 2 - k * (y0 + y1) / 2;
  let s = '';
  for (const p of [...polys].sort((a, b) => a.d - b.d)) {
    const pts = p.pts.map(q => (k * q[0] + ox).toFixed(1) + ',' + (k * q[1] + oy).toFixed(1)).join(' ');
    s += '<polygon points="' + pts + '" fill="hsl(210 8% ' + Math.round(28 + p.s * 46) + '%)" stroke="hsl(210 12% 24%)" stroke-width="0.5" stroke-linejoin="round"/>';
  }
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img">' + s + '</svg>';
}`;

// —— 会话内可视化片段（主题自适应，精简数据） ——
if (process.argv.includes('--fragment')) {
  const fragPath = path.resolve(process.argv[process.argv.indexOf('--fragment') + 1]);
  const data = dataset.map((d) => ({ id: d.id, zh: d.zh, c: d.c, s: d.s, bad: d.bad, alias: d.alias, desc: d.desc, e: d.e, m: d.m, lite: d.lite }));
  const DATA = JSON.stringify(data).replace(/</g, '\\u003c');
  const frag = `<div id="ldraw-gallery-root">
<style>
#ldraw-gallery-root .pz-tile { display:flex; flex-direction:column; align-items:center; gap:4px; padding:6px 4px; min-height:0; }
#ldraw-gallery-root .pz-tile svg { width:100%; height:auto; }
#ldraw-gallery-root .pz-cap { font-size:11px; color:var(--muted-foreground); line-height:1.25; text-align:center; }
#ldraw-gallery-root .pz-cap b { color:var(--foreground); font-weight:500; }
#ldraw-gallery-root .pz-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(104px,1fr)); gap:6px; }
#ldraw-gallery-root .pz-lightbox { position:absolute; inset:0; background:color-mix(in srgb, var(--background) 78%, transparent); display:flex; align-items:center; justify-content:center; z-index:10; }
#ldraw-gallery-root .pz-detail { background:var(--card); color:var(--card-foreground); border-radius:var(--card-radius,12px); padding:16px; max-width:420px; width:calc(100% - 32px); box-shadow:0 8px 30px rgba(0,0,0,.25); }
#ldraw-gallery-root .pz-detail svg { width:200px; height:200px; float:left; margin-right:14px; }
#ldraw-gallery-root .pz-detail:after { content:''; display:block; clear:both; }
#ldraw-gallery-root .pz-bad { color:var(--destructive); }
#ldraw-gallery-root .pz-hidden { display:none; }
</style>
<div class="viz-row" role="tablist" aria-label="零件类别" id="pz-tabs"></div>
<p class="text-small text-muted" id="pz-count" aria-live="polite"></p>
<div class="pz-grid" id="pz-grid"></div>
<div class="pz-lightbox pz-hidden" id="pz-lightbox" role="dialog" aria-modal="true" aria-label="零件详情">
  <div class="pz-detail" id="pz-detail"></div>
</div>
<script>
(function () {
  const DATA = ${DATA};
  const CAT = ${JSON.stringify(CATEGORY_ZH)};
  ${RENDERER}
  const root = document.getElementById('ldraw-gallery-root');
  const tabs = document.getElementById('pz-tabs'), grid = document.getElementById('pz-grid'),
        lightbox = document.getElementById('pz-lightbox'), detail = document.getElementById('pz-detail'), count = document.getElementById('pz-count');
  let cat = 'all';
  const dims = (d) => d.m ? ('实测 ' + d.m.x + '×' + d.m.y + '×' + d.m.z + ' LDU，目录期望 ' + d.e.x + '×' + d.e.y + '×' + d.e.z) : '';
  function tile(d) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn viz-tile pz-tile';
    b.setAttribute('data-tooltip', d.id + ' ' + d.zh + (d.desc ? '｜官方：' + d.desc : '') + '｜' + dims(d));
    b.innerHTML = render(d, true, 100, 100) + '<span class="pz-cap"><b>' + d.id + '</b>' + (d.bad ? ' <span class="pz-bad">⚠</span>' : '') + '<br>' + d.zh + '</span>';
    b.addEventListener('click', () => open(d));
    return b;
  }
  function open(d) {
    detail.innerHTML = render({ full: d.lite }, false, 200, 200) +
      '<h3>' + d.id + (d.bad ? ' <span class="pz-bad">定义冲突</span>' : '') + '</h3>' +
      '<p class="text-small">' + d.zh + '</p>' +
      (d.desc ? '<p class="text-small text-muted">官方文件头：' + d.desc + '</p>' : '') +
      (d.alias ? '<p class="text-small text-muted">官方文件名映射：' + d.alias + '.dat</p>' : '') +
      '<p class="text-small text-muted">' + dims(d) + '</p>' +
      '<button type="button" class="btn" id="pz-close">关闭</button>';
    lightbox.classList.remove('pz-hidden');
    detail.querySelector('#pz-close').addEventListener('click', close);
  }
  function close() { lightbox.classList.add('pz-hidden'); }
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) close(); });
  function show() {
    grid.innerHTML = '';
    const list = DATA.filter((d) => cat === 'all' || d.c === cat);
    for (const d of list) grid.appendChild(tile(d));
    count.textContent = (cat === 'all' ? '全部 ' : (CAT[cat] || cat) + ' ') + list.length + ' 种 · 灰色几何为 LDraw 官方 .dat 实渲 · ⚠ = 目录定义与官方几何硬冲突';
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.cat === cat));
  }
  const all = document.createElement('button');
  all.type = 'button'; all.className = 'nav-link active'; all.dataset.cat = 'all'; all.setAttribute('role', 'tab'); all.setAttribute('aria-selected', 'true'); all.textContent = '全部';
  all.addEventListener('click', () => { cat = 'all'; show(); });
  tabs.appendChild(all);
  for (const c of [...new Set(DATA.map((d) => d.c))]) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nav-link'; b.dataset.cat = c; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', 'false');
    b.textContent = (CAT[c] || c) + ' ' + DATA.filter((d) => d.c === c).length;
    b.addEventListener('click', () => { cat = c; show(); });
    tabs.appendChild(b);
  }
  show();
})();
</script>
</div>`;
  fs.writeFileSync(fragPath, frag);
  console.error(`片段已写入 ${fragPath}（${(fs.statSync(fragPath).size / 1024).toFixed(0)} KB）`);
}

// —— 自包含离线画廊 ——
{
  const data = dataset.map((d) => ({ id: d.id, zh: d.zh, c: d.c, s: d.s, bad: d.bad, alias: d.alias, desc: d.desc, e: d.e, m: d.m, full: d.full }));
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>BrickKit 素材库 · LDraw 官方零件预览</title><style>
body { font-family: system-ui, sans-serif; margin: 0; background: #f6f6f5; color: #1c1c1c; }
header { padding: 20px 24px 8px; } h1 { font-size: 20px; margin: 0 0 4px; } .sub { color: #666; font-size: 13px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 24px; position: sticky; top: 0; background: #f6f6f5ee; backdrop-filter: blur(4px); z-index: 5; }
nav button { border: 1px solid #ccc; background: #fff; border-radius: 999px; padding: 4px 12px; font-size: 13px; cursor: pointer; }
nav button[aria-selected="true"] { background: #1c1c1c; color: #fff; border-color: #1c1c1c; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 10px; padding: 4px 24px 40px; }
.tile { border: 1px solid #e2e2e0; border-radius: 10px; background: #fff; padding: 10px 6px 8px; text-align: center; cursor: zoom-in; }
.tile:hover { border-color: #888; } .tile svg { width: 100%; height: auto; } .cap { font-size: 11px; color: #555; margin-top: 6px; line-height: 1.3; } .cap b { color: #111; font-weight: 600; }
.bad { color: #b42318; font-weight: 600; }
.lb { position: fixed; inset: 0; background: rgba(20,20,20,.55); display: none; align-items: center; justify-content: center; z-index: 50; }
.lb.open { display: flex; } .card { background: #fff; border-radius: 14px; padding: 22px; max-width: 460px; width: calc(100% - 40px); box-shadow: 0 12px 40px rgba(0,0,0,.35); }
.card svg { width: 210px; height: 210px; float: left; margin: 0 16px 8px 0; } .card:after { content: ''; display: block; clear: both; }
.mut { color: #666; font-size: 13px; } button.x { margin-top: 10px; border: 1px solid #ccc; background: #fff; border-radius: 8px; padding: 6px 14px; cursor: pointer; }
</style></head><body>
<header><h1>BrickKit 素材库 · LDraw 官方零件几何预览</h1><div class="sub">目录 ${Object.keys(parts).length} 种 + 官方补充件 ${EXTRA.length} 种（另含全量镜像 catalog/ldraw-full：约 2.5 万种 · 36,966 文件 · 602 MB，可按任意编号渲染）· 渲染自官方 .dat，CC BY 2.0 · <span class="bad">⚠</span> = 目录定义与官方几何硬冲突（详见 catalog/ldraw/README.md）</div></header>
<nav id="nav" aria-label="零件类别"></nav><div class="grid" id="grid"></div>
<div class="lb" id="lb"><div class="card" id="card"></div></div>
<script>
const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const CAT = ${JSON.stringify(CATEGORY_ZH)};
${RENDERER}
let cat = 'all';
const grid = document.getElementById('grid'), nav = document.getElementById('nav'), lb = document.getElementById('lb'), card = document.getElementById('card');
function show() {
  grid.innerHTML = '';
  for (const d of DATA.filter((d) => cat === 'all' || d.c === cat)) {
    const el = document.createElement('button');
    el.className = 'tile'; el.type = 'button';
    el.innerHTML = render(d, false, 140, 140) + '<div class="cap"><b>' + d.id + '</b>' + (d.bad ? ' <span class="bad">⚠</span>' : '') + '<br>' + d.zh + '</div>';
    el.addEventListener('click', () => open(d));
    grid.appendChild(el);
  }
  for (const b of nav.children) b.setAttribute('aria-selected', String(b.dataset.cat === cat));
}
function open(d) {
  card.innerHTML = render(d, false, 210, 210) + '<h3 style="margin:0 0 2px">' + d.id + (d.bad ? ' <span class="bad">定义冲突</span>' : '') + '</h3>' +
    '<div>' + d.zh + '</div>' + (d.desc ? '<div class="mut">官方文件头：' + d.desc + '</div>' : '') +
    (d.alias ? '<div class="mut">官方文件名映射：' + d.alias + '.dat</div>' : '') +
    (d.m ? '<div class="mut">实测 ' + d.m.x + '×' + d.m.y + '×' + d.m.z + ' LDU · 目录期望 ' + d.e.x + '×' + d.e.y + '×' + d.e.z + '（1 格=20，1 片=8）</div>' : '') +
    '<button class="x" id="x">关闭</button>';
  lb.classList.add('open'); document.getElementById('x').addEventListener('click', () => lb.classList.remove('open'));
}
lb.addEventListener('click', (e) => { if (e.target === lb) lb.classList.remove('open'); });
{
  const mk = (id, label) => { const b = document.createElement('button'); b.type = 'button'; b.dataset.cat = id; b.setAttribute('aria-selected', 'false'); b.textContent = label; b.addEventListener('click', () => { cat = id; show(); }); nav.appendChild(b); };
  mk('all', '全部 ' + DATA.length);
  for (const c of [...new Set(DATA.map((d) => d.c))]) mk(c, (CAT[c] || c) + ' ' + DATA.filter((d) => d.c === c).length);
}
show();
</script></body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.error(`离线画廊已写入 ${path.join(OUT, 'index.html')}（${(fs.statSync(path.join(OUT, 'index.html')).size / 1024).toFixed(0)} KB）`);
}

// —— 视觉自检截图 ——
if (process.argv.includes('--screenshot')) {
  const { chromium } = await import('playwright');
  const exe = process.env.CHROMIUM_PATH || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto('file:///' + path.join(OUT, 'index.html').replace(/\\/g, '/'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'qa-gallery.png') });
  await page.click('text=弧面/拱门').catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'qa-gallery-cat.png') });
  await browser.close();
  console.error('截图已写出 qa-gallery.png / qa-gallery-cat.png');
}
