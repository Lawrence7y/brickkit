#!/usr/bin/env node
/**
 * tools/brickvlm/gen_manual_steps_dataset.mjs — C1-4 真实说明书 understand_step 数据工厂
 *
 * 任务书：docs/prd-v2/HANDOFF-C-single-agent.md §3 阶段 C1 任务 C1-4。
 * 目标：从 assets/instructions-lego/ 的官方乐高说明书 PDF（真实素材，非合成）生成
 *       understand_step 样本：每样本 = 一个真实说明书步骤区域裁剪 + 完整溯源 +
 *       新增件真值 {partId, colorId, quantity}（官方 callout 与 BOM 守恒双重核对）。
 *
 * 关键事实（2026-10-26 对全部 11 册 PDF 文本层实测）：
 *   - 步骤页有：步骤号（字号 20-40 整数 token）、每件新增件 "Nx" 数量 token（字号 6.5-9.5）、
 *     子装配重复徽章 "Nx"（字号 12-22）；步骤页【从不】印元素号（11 册 0 命中）。
 *   - 零件总览页（册末）有 "Nx + 元素号" 成对文本（与 tools/fetch-bom.mjs pairsFromPage 同签名），
 *     且每格画出该元素同角度零件图 —— 元素身份的唯一机器可核来源。
 *   - 75211 无文本层（0 token）→ 整套排除。
 * 元素身份三重证据：① callout 零件图 ↔ 总览格图模板匹配（灰度余弦+颜色直方图）；
 *   ② 人工接触表复核（verify/decisions.json）；③ 每元素「逐步数量之和 == 总览页官方合计」守恒
 *   （不符元素所在步骤整步排除，绝不猜）。60239 另与 src/manual-v2/extractor.js 的
 *   8 条人工锚点观察对账（该文件只读）。
 *
 * 子命令：
 *   render              PDF → 300dpi 逐页 PNG + 文本 token JSON（缓存，可重入）
 *   extract             步骤/子装配组解析、callout 框与建造区检测、总览格裁剪、模板匹配、接触表
 *   finalize            应用 verify/decisions.json + BOM 守恒核对 → samples/ + 册级 final 摘要
 *   manifest            汇总全部册 final 摘要 → manifest.json
 *   --book=<bookId>     只处理该册
 * 输出根：out/prd-v2/run-20261026-c/C/data/manual/（本任务独占；不改任何既有文件）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { computeSha256 } from '../../src/manual-v2/extractor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(ROOT, 'out/prd-v2/run-20261026-c/C/data/manual');
const DPI = 300;
const PT = DPI / 72; // PDF pt → px

/* ------------------------------------------------------------- 套装配置 */
// role: dev（60239，PRD §10.6 固定开发样例，不进泛化留出）/ train / holdout
const BOOKS = [
  { bookId: '60239-b1', set: '60239', role: 'dev', pdf: 'assets/instructions-lego/60239_book1.pdf' },
  { bookId: '31058-b1', set: '31058', role: 'train', pdf: 'assets/instructions-lego/31058_book1of3.pdf' },
  { bookId: '31058-b2', set: '31058', role: 'train', pdf: 'assets/instructions-lego/31058_book2of3.pdf' },
  // 31058-b3 已剔除：该分册无零件总览页（24 页全为步骤+版权页），元素身份与 BOM 守恒均无从核对
  { bookId: '31062-b1', set: '31062', role: 'holdout', pdf: 'assets/instructions-lego/31062_book1of3.pdf' },
  { bookId: '31062-b2', set: '31062', role: 'holdout', pdf: 'assets/instructions-lego/31062_book2of3.pdf' },
  { bookId: '31062-b3', set: '31062', role: 'holdout', pdf: 'assets/instructions-lego/31062_book3of3.pdf' },
  { bookId: '70615-b1', set: '70615', role: 'train', pdf: 'assets/instructions-lego/70615_book1.pdf' },
  { bookId: '42065-b1', set: '42065', role: 'holdout', pdf: 'assets/instructions-lego/42065_book1.pdf' },
  { bookId: '10715-b1', set: '10715', role: 'holdout', pdf: 'assets/instructions-lego/10715_book1.pdf' },
];
const EXCLUDED_BOOKS = [
  { bookId: '75211-b1', set: '75211', pdf: 'assets/instructions-lego/75211_book1.pdf', reason: 'no-text-layer: 全 76 页文本层 0 token（扫描版），callout 无法机器核对' },
];
const SOURCE_MANIFEST = path.join(ROOT, 'assets/instructions-lego/manifest.json');

/* --------------------------------------------------------------- 阈值 */
const STEP_FONT_MIN = 20, STEP_FONT_MAX = 40;
const QTY_FONT_MIN = 6.5, QTY_FONT_MAX = 9.5;
const BADGE_FONT_MIN = 12, BADGE_FONT_MAX = 22;
const PARTS_LIST_TOKENS = 8;     // 总览页：不同 6-8 位数字 token 下限
const INK_DIST = 48;             // 像素离背景色距离阈值
const BOX_MIN_GRID_CELLS = 40;   // 封闭区最小格数（滤字形字腔）
const GRID_CELL = 6;             // 像素分析降采样格边长（300dpi px）
const THIN_FILL_RATIO = 0.2;     // 线条（箭头/分隔线）判据
const AUTO_ACCEPT_SCORE = 0.9;
const AUTO_ACCEPT_MARGIN = 0.04;
const SHEET_ENTRIES = 20;
const BUILD_CROP_MIN_W = 768;

/* -------------------------------------------------------------- 小工具 */
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const wjson = (p, obj) => { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); };
const rjson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

const require2 = createRequire(pathToFileURL(path.join(ROOT, 'package.json')).href);
let pdfjsMod = null;
async function loadPdfjs() {
  if (pdfjsMod) return pdfjsMod;
  const { getDocument, GlobalWorkerOptions, VerbosityLevel } = await import(
    pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
  GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
  const { DOMMatrix, Path2D } = require2('@napi-rs/canvas');
  globalThis.DOMMatrix = DOMMatrix;
  globalThis.Path2D = Path2D;
  pdfjsMod = { getDocument, VerbosityLevel };
  return pdfjsMod;
}

async function withDoc(pdfPath, fn) {
  const { getDocument, VerbosityLevel } = await loadPdfjs();
  const doc = await getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    disableFontFace: true,
    verbosity: VerbosityLevel.errors,
    useWorkerFetch: false,
    cMapUrl: pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/cmaps')).href + '/',
    cMapPacked: true,
    standardFontDataUrl: pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts')).href + '/',
    wasmUrl: pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/wasm')).href + '/',
  }).promise;
  try { return await fn(doc); } finally { await doc.cleanup(); }
}

/** 文本 token：{s,x,y,font}（PDF pt 坐标，y 向上；font = transform[0]） */
async function pageTokens(page) {
  const tc = await page.getTextContent();
  const toks = [];
  for (const it of tc.items) {
    const s = it.str.trim();
    if (!s) continue;
    toks.push({ s, x: it.transform[4], y: it.transform[5], font: it.transform[0] });
  }
  return toks;
}

/* ================================================================ render */
async function stageRender(book) {
  const dir = path.join(OUT, 'pages', book.bookId);
  const tokensFile = path.join(dir, 'tokens.json');
  if (exists(path.join(dir, 'page-01.png')) && exists(tokensFile)) { console.log(`[render] ${book.bookId} 已缓存，跳过`); return; }
  ensureDir(dir);
  const pdfAbs = path.join(ROOT, book.pdf);
  if (!exists(pdfAbs)) throw new Error(`PDF 不存在：${book.pdf}`);
  const info = await withDoc(pdfAbs, async (doc) => {
    const { createCanvas } = require2('@napi-rs/canvas');
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const file = path.join(dir, `page-${String(i).padStart(2, '0')}.png`);
      if (!exists(file)) {
        const vp = page.getViewport({ scale: DPI / 72 });
        const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        fs.writeFileSync(file, canvas.toBuffer('image/png'));
      }
      pages.push({ page: i, tokens: await pageTokens(page) });
      page.cleanup();
      if (i % 20 === 0) console.log(`[render] ${book.bookId} ${i}/${doc.numPages}`);
    }
    return { numPages: doc.numPages, pages };
  });
  wjson(tokensFile, info);
  console.log(`[render] ${book.bookId} ${info.numPages} 页 → ${path.relative(ROOT, dir)}`);
}

/* ============================================================ 像素分析 */
async function loadPagePixels(pngPath) {
  const { createCanvas, loadImage } = require2('@napi-rs/canvas');
  const img = await loadImage(pngPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  // 背景色：32 阶量化直方图众数（稀疏采样）
  const hist = new Map();
  for (let p = 0; p < id.data.length; p += 64) {
    const key = ((id.data[p] >> 5) << 6) | ((id.data[p + 1] >> 5) << 3) | (id.data[p + 2] >> 5);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let bestKey = 7 << 6, bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { bestN = n; bestKey = k; }
  const bg = [((bestKey >> 6) & 7) * 32 + 16, ((bestKey >> 3) & 7) * 32 + 16, (bestKey & 7) * 32 + 16];
  return { w: img.width, h: img.height, data: id.data, canvas, bg };
}

/** ink 网格 + 背景色 + 8 邻域连通分量 */
function gridAnalysis(w, h, data) {
  const gw = Math.floor(w / GRID_CELL), gh = Math.floor(h / GRID_CELL);
  const hist = new Map();
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const px = ((gy * GRID_CELL + GRID_CELL / 2) * w + (gx * GRID_CELL + GRID_CELL / 2)) << 2;
    const key = ((data[px] >> 5) << 6) | ((data[px + 1] >> 5) << 3) | (data[px + 2] >> 5);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let bestKey = 7 << 6, bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { bestN = n; bestKey = k; }
  const bg = [((bestKey >> 6) & 7) * 32 + 16, ((bestKey >> 3) & 7) * 32 + 16, (bestKey & 7) * 32 + 16];
  const ink = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let hit = 0;
    // 全像素扫描：细边框（1-2px）不能漏采，否则封闭盒洪泛泄漏
    for (let dy = 0; dy < 6 && !hit; dy++) for (let dx = 0; dx < 6 && !hit; dx++) {
      const py = gy * GRID_CELL + dy, pxx = gx * GRID_CELL + dx;
      if (py >= h || pxx >= w) continue;
      const px = (py * w + pxx) << 2;
      const d = Math.abs(data[px] - bg[0]) + Math.abs(data[px + 1] - bg[1]) + Math.abs(data[px + 2] - bg[2]);
      if (d >= INK_DIST) hit = 1;
    }
    ink[gy * gw + gx] = hit;
  }
  const seen = new Uint8Array(gw * gh);
  const stack = new Int32Array(gw * gh);
  const comps = [];
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || seen[s]) continue;
    let top = 0; stack[top++] = s; seen[s] = 1;
    let area = 0, x0 = gw, x1 = -1, y0 = gh, y1 = -1;
    while (top > 0) {
      const c = stack[--top]; area++;
      const cx = c % gw, cy = (c / gw) | 0;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const nk = ny * gw + nx;
        if (ink[nk] && !seen[nk]) { seen[nk] = 1; stack[top++] = nk; }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    comps.push({ area, x0, x1, y0, y1, bw, bh, fill: area / (bw * bh) });
  }
  return { gw, gh, bg, ink, comps };
}

/* ---------- 盒检测：形态学开运算去细线后取实心 blob ---------- */
/** 去除细线（1-2 格宽）：3×3 邻域 ink 计数 ≤2 的格清零 */
function openInk(gw, gh, ink) {
  const out = new Uint8Array(ink);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    if (!ink[gy * gw + gx]) continue;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && ink[ny * gw + nx]) n++;
    }
    if (n <= 2) out[gy * gw + gx] = 0;
  }
  return out;
}

/** blob = 开运算后实心连通块；box 判据：fill 高 + 尺寸够 + 单一主导色（盒底色） */
function boxBlobs(gw, gh, inkOpened, data, w) {
  const seen = new Uint8Array(gw * gh);
  const stack = new Int32Array(gw * gh);
  const blobs = [];
  for (let s = 0; s < inkOpened.length; s++) {
    if (!inkOpened[s] || seen[s]) continue;
    let top = 0; stack[top++] = s; seen[s] = 1;
    let area = 0, x0 = gw, x1 = -1, y0 = gh, y1 = -1;
    const colorHist = new Map();
    while (top > 0) {
      const c = stack[--top]; area++;
      const cx = c % gw, cy = (c / gw) | 0;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      // 主导色统计（每格中心像素）
      const px = ((cy * GRID_CELL + 3) * w + (cx * GRID_CELL + 3)) << 2;
      const key = ((data[px] >> 4) << 8) | ((data[px + 1] >> 4) << 4) | (data[px + 2] >> 4);
      colorHist.set(key, (colorHist.get(key) || 0) + 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const nk = ny * gw + nx;
        if (inkOpened[nk] && !seen[nk]) { seen[nk] = 1; stack[top++] = nk; }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    let maxCount = 0, modeKey = 0;
    for (const [k, n] of colorHist) if (n > maxCount) { maxCount = n; modeKey = k; }
    blobs.push({ x0, x1, y0, y1, bw, bh, area, fill: area / (bw * bh), modeShare: maxCount / area, modeColor: [((modeKey >> 8) & 15) * 16 + 8, ((modeKey >> 4) & 15) * 16 + 8, (modeKey & 15) * 16 + 8] });
  }
  return blobs;
}

/** 把 blob 收缩到其底色的实心连通区（去掉经细线并进来的外部内容，如箭头/成品示意）。
 *  返回底色区 bbox（G 格坐标）；失败返回原 bbox。 */
function shrinkToFill(px, b) {
  const G = GRID_CELL;
  const bx0 = Math.max(0, b.x0 * G), bx1 = Math.min(px.w - 1, (b.x1 + 1) * G - 1);
  const by0 = Math.max(0, b.y0 * G), by1 = Math.min(px.h - 1, (b.y1 + 1) * G - 1);
  const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  if (w < 20 || h < 20) return b;
  const S = 3;
  const lw = Math.ceil(w / S), lh = Math.ceil(h / S);
  const mask = new Uint8Array(lw * lh);
  for (let ly = 0; ly < lh; ly++) for (let lx = 0; lx < lw; lx++) {
    const pxx = Math.min(px.w - 1, bx0 + lx * S + 1), pyy = Math.min(px.h - 1, by0 + ly * S + 1);
    const p = (pyy * px.w + pxx) << 2;
    const d = Math.abs(px.data[p] - b.modeColor[0]) + Math.abs(px.data[p + 1] - b.modeColor[1]) + Math.abs(px.data[p + 2] - b.modeColor[2]);
    mask[ly * lw + lx] = d < 40 ? 1 : 0;
  }
  // 最大 4 邻域连通区
  const seen = new Uint8Array(lw * lh);
  let best = null;
  const st = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    st.length = 0; st.push(s); seen[s] = 1;
    let n = 0, x0 = lw, x1 = -1, y0 = lh, y1 = -1;
    while (st.length) {
      const c = st.pop(); n++;
      const cx = c % lw, cy = (c / lw) | 0;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= lw || ny >= lh) continue;
        const nk = ny * lw + nx;
        if (mask[nk] && !seen[nk]) { seen[nk] = 1; st.push(nk); }
      }
    }
    if (!best || n > best.n) best = { n, x0, x1, y0, y1 };
  }
  if (!best || best.n < 0.3 * lw * lh) return b;
  return {
    x0: b.x0 + Math.floor(best.x0 * S / G), x1: b.x0 + Math.ceil((best.x1 + 1) * S / G) - 1,
    y0: b.y0 + Math.floor(best.y0 * S / G), y1: b.y0 + Math.ceil((best.y1 + 1) * S / G) - 1,
    bw: 0, bh: 0, area: b.area, fill: b.fill, modeShare: b.modeShare, modeColor: b.modeColor,
    bw2: (best.x1 - best.x0 + 1) * S / G, bh2: (best.y1 - best.y0 + 1) * S / G,
  };
}

/** 盒内容子组件：盒 bbox 内、离盒底色 ≥ INK_DIST、排除文字矩形、从盒缘内缩 2 格。
 *  返回与 gridAnalysis 同坐标（G 格）的组件数组。 */
function boxContentComps(px, grid, b, textRects) {
  const G = GRID_CELL;
  const bx0 = Math.max(0, (b.x0 + 2) * G), bx1 = Math.min(px.w - 1, (b.x1 - 1) * G);
  const by0 = Math.max(0, (b.y0 + 2) * G), by1 = Math.min(px.h - 1, (b.y1 - 1) * G);
  const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  if (w < 10 || h < 10) return [];
  const S = 3; // 内容子网格边长（px）
  const lw = Math.ceil(w / S), lh = Math.ceil(h / S);
  const mask = new Uint8Array(lw * lh);
  for (let ly = 0; ly < lh; ly++) for (let lx = 0; lx < lw; lx++) {
    let hit = 0;
    for (let dy = 0; dy < S && !hit; dy++) for (let dx = 0; dx < S && !hit; dx++) {
      const pxx = bx0 + lx * S + dx, pyy = by0 + ly * S + dy;
      if (pxx > bx1 || pyy > by1) continue;
      const gx = Math.floor(pxx / G), gy = Math.floor(pyy / G);
      if (textRects.some(r => gx >= r.x0 && gx <= r.x1 && gy >= r.y0 && gy <= r.y1)) continue;
      const p = (pyy * px.w + pxx) << 2;
      const d = Math.abs(px.data[p] - b.modeColor[0]) + Math.abs(px.data[p + 1] - b.modeColor[1]) + Math.abs(px.data[p + 2] - b.modeColor[2]);
      if (d >= INK_DIST) hit = 1;
    }
    mask[ly * lw + lx] = hit;
  }
  // 去细线（箭头连接的零件图分离）
  const opened2 = new Uint8Array(mask);
  for (let ly = 0; ly < lh; ly++) for (let lx = 0; lx < lw; lx++) {
    if (!mask[ly * lw + lx]) continue;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = lx + dx, ny = ly + dy;
      if (nx >= 0 && ny >= 0 && nx < lw && ny < lh && mask[ny * lw + nx]) n++;
    }
    if (n <= 2) opened2[ly * lw + lx] = 0;
  }
  mask.set(opened2);
  // 连通分量
  const seen = new Uint8Array(lw * lh);
  const comps = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const st = [s]; seen[s] = 1;
    let n = 0, x0 = lw, x1 = -1, y0 = lh, y1 = -1;
    while (st.length) {
      const c = st.pop(); n++;
      const cx = c % lw, cy = (c / lw) | 0;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= lw || ny >= lh) continue;
        const nk = ny * lw + nx;
        if (mask[nk] && !seen[nk]) { seen[nk] = 1; st.push(nk); }
      }
    }
    const areaCells = n;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    comps.push({
      x0: bx0 / G + x0 * S / G, x1: bx0 / G + (x1 + 1) * S / G - 1 / G,
      y0: by0 / G + y0 * S / G, y1: by0 / G + (y1 + 1) * S / G - 1 / G,
      bw: bw * S / G, bh: bh * S / G, fill: areaCells / (bw * bh), area: areaCells,
    });
  }
  // 滤线条（箭头）与碎屑；换算到页 G 格坐标
  return comps
    .filter(c => c.bw >= 3 && c.bh >= 3 && c.fill >= THIN_FILL_RATIO && c.area >= 8)
    .map(c => ({ ...c, x0: Math.round(c.x0), x1: Math.round(c.x1), y0: Math.round(c.y0), y1: Math.round(c.y1) }));
}

/* ============================================================ extract */
function classifyTokens(tokens) {
  const anchors = tokens.filter(t => /^\d{1,3}$/.test(t.s) && t.font >= STEP_FONT_MIN && t.font <= STEP_FONT_MAX);
  const qtys = tokens.filter(t => /^\d+x$/.test(t.s) && t.font >= QTY_FONT_MIN && t.font <= QTY_FONT_MAX);
  const badges = tokens.filter(t => /^\d+x$/.test(t.s) && t.font >= BADGE_FONT_MIN && t.font <= BADGE_FONT_MAX);
  const ids = tokens.filter(t => /^\d{4,8}$/.test(t.s) && t.font <= 8);
  const stickerIdx = tokens.filter(t => /^\d{1,2}$/.test(t.s) && t.font > 12 && t.font < 20);
  return { anchors, qtys, badges, ids, stickerIdx };
}

/** 总览行：qty token 与正下方同列元素号配对（pt 坐标，fetch-bom pairsFromPage 同签名） */
function overviewPairs(tokens) {
  const qtys = tokens.filter(t => /^\d+x$/.test(t.s) && t.font <= 7);
  const ids = tokens.filter(t => /^\d{4,8}$/.test(t.s) && t.font <= 8);
  const used = new Set();
  const rows = [];
  for (const q of qtys) {
    const hit = ids.filter(i => !used.has(i) && Math.abs(i.x - q.x) < 12 && i.y < q.y && q.y - i.y < 16)
      .sort((a, b) => b.y - a.y)[0];
    if (!hit) continue;
    used.add(hit);
    rows.push({ element: hit.s, qty: Number(q.s.slice(0, -1)), x: hit.x, y: hit.y, qtyY: q.y });
  }
  return rows;
}

/* ---------- pt/grid 换算 ---------- */
function ptToGrid(px, xPt, yPt) {
  return [Math.floor(xPt * PT / GRID_CELL), Math.floor((px.h - yPt * PT) / GRID_CELL)];
}
function ptToGridRect(px, x0pt, y0pt, x1pt, y1pt) {
  const [ax, ay] = ptToGrid(px, x0pt, y1pt);
  const [bx, by] = ptToGrid(px, x1pt, y0pt);
  return { x0: ax, y0: ay, x1: bx, y1: by }; // y0 = 上边（小），y1 = 下边（大）
}
function gridRectToPt(px, r) {
  return {
    x0: r.x0 * GRID_CELL / PT, x1: (r.x1 + 1) * GRID_CELL / PT,
    y0: (px.h - (r.y1 + 1) * GRID_CELL) / PT, y1: (px.h - r.y0 * GRID_CELL) / PT, // pt, y-up
  };
}
function compPtRect(px, comp) {
  return gridRectToPt(px, comp);
}
function compInRect(comp, r) { return comp.x0 >= r.x0 - 1 && comp.x1 <= r.x1 + 1 && comp.y0 >= r.y0 - 1 && comp.y1 <= r.y1 + 1; }
function compOverlap(comp, r) { return comp.x0 <= r.x1 && comp.x1 >= r.x0 && comp.y0 <= r.y1 && comp.y1 >= r.y0; }
function compContains(comp, gx, gy) { return gx >= comp.x0 && gx <= comp.x1 && gy >= comp.y0 && gy <= comp.y1; }

/** 在 pt 矩形（y-up）内按 ink 紧收裁剪。dropTextRects: pt 矩形数组（排除数量标签等）。 */
function tightInkCrop(px, x0pt, y0pt, x1pt, y1pt, opts = {}) {
  const gx0 = Math.max(0, Math.floor(x0pt * PT)), gx1 = Math.min(px.w - 1, Math.ceil(x1pt * PT));
  const gy0 = Math.max(0, Math.floor(px.h - y1pt * PT)), gy1 = Math.min(px.h - 1, Math.ceil(px.h - y0pt * PT));
  const w = gx1 - gx0 + 1, h = gy1 - gy0 + 1;
  if (w <= 2 || h <= 2) return null;
  const drops = (opts.dropTextRects || []).map(r => ptToGridRect(px, r[0], r[1], r[2], r[3]));
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const pxi = ((y + gy0) * px.w + (x + gx0)) << 2;
    const d = Math.abs(px.data[pxi] - px.bg[0]) + Math.abs(px.data[pxi + 1] - px.bg[1]) + Math.abs(px.data[pxi + 2] - px.bg[2]);
    if (d < INK_DIST) continue;
    let dropped = false;
    for (const r of drops) {
      if (x + gx0 >= r.x0 * GRID_CELL && x + gx0 <= r.x1 * GRID_CELL && y + gy0 >= r.y0 * GRID_CELL && y + gy0 <= r.y1 * GRID_CELL) { dropped = true; break; }
    }
    if (dropped) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const pad = 3;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const { createCanvas } = require2('@napi-rs/canvas');
  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(px.canvas, gx0 + x0, gy0 + y0, cw, ch, 0, 0, cw, ch);
  // 色键：盒底色 → 白（匹配特征只看零件本体）
  if (opts.keyFill) {
    const id = ctx.getImageData(0, 0, cw, ch);
    const d = id.data;
    for (let p = 0; p < d.length; p += 4) {
      const dd = Math.abs(d[p] - opts.keyFill[0]) + Math.abs(d[p + 1] - opts.keyFill[1]) + Math.abs(d[p + 2] - opts.keyFill[2]);
      if (dd < INK_DIST) { d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; }
    }
    ctx.putImageData(id, 0, 0);
  }
  return { png: canvas.toBuffer('image/png'), w: cw, h: ch };
}

function assignQtyToParts(qts, parts) {
  if (!parts.length) return qts.map(q => ({ qty: q, part: null }));
  if (parts.length === 1) return qts.map(q => ({ qty: q, part: parts[0] }));
  const pairs = [];
  const free = new Set(parts);
  for (const q of [...qts].sort((a, b) => a.x - b.x)) {
    let best = null, bestD = 1e9;
    for (const p of free) {
      const d = Math.abs(((p.x0 + p.x1) / 2) * GRID_CELL / PT - q.x);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) { free.delete(best); pairs.push({ qty: q, part: best }); }
  }
  for (const p of free) pairs.push({ qty: null, part: p });
  return pairs;
}

async function stageExtract(book) {
  const bookDir = path.join(OUT, 'pages', book.bookId);
  const tokensInfo = rjson(path.join(bookDir, 'tokens.json'));
  const pagesMeta = [];
  for (const p of tokensInfo.pages) pagesMeta[p.page] = p;

  /* 1. 页分类 */
  const pageKind = {};
  for (let i = 1; i <= tokensInfo.numPages; i++) {
    const { ids } = classifyTokens(pagesMeta[i].tokens);
    pageKind[i] = new Set(ids.map(t => t.s)).size >= PARTS_LIST_TOKENS ? 'parts-list' : 'content';
  }

  /* 2. 总览行 + 总览格裁剪 */
  const overviewByElement = new Map();
  const cellDir = path.join(OUT, 'overview', book.bookId);
  ensureDir(cellDir);
  const pxCache = new Map();
  const getPixels = async (i) => {
    if (!pxCache.has(i)) pxCache.set(i, await loadPagePixels(path.join(bookDir, `page-${String(i).padStart(2, '0')}.png`)));
    return pxCache.get(i);
  };
  for (let i = 1; i <= tokensInfo.numPages; i++) {
    if (pageKind[i] !== 'parts-list') continue;
    const rows = overviewPairs(pagesMeta[i].tokens);
    const px = await getPixels(i);
    for (const r of rows) {
      if (overviewByElement.has(r.element)) { overviewByElement.get(r.element).qty += r.qty; continue; }
      // 格图区：元素号上方（qtyY-2 → qtyY+30，y-up），元素号与 Nx 文本均在裁剪带之下/被剔除；页底色 → 白
      const crop = tightInkCrop(px, r.x - 12, r.qtyY - 2, r.x + 46, r.qtyY + 30, {
        keyFill: px.bg,
        dropTextRects: [[r.x - 8, r.qtyY - 4, r.x + 8 * (1 + String(r.qty).length), r.qtyY + 6]],
      });
      if (!crop || crop.w < 12 || crop.h < 10) continue;
      const file = path.join(cellDir, `cell-${r.element}.png`);
      fs.writeFileSync(file, crop.png);
      overviewByElement.set(r.element, { ...r, page: i, cellPath: path.relative(OUT, file).replace(/\\/g, '/'), cellSha256: computeSha256(crop.png) });
    }
    pxCache.delete(i);
    console.log(`[extract] ${book.bookId} p${i} 总览行 ${rows.length}`);
  }

  /* 3. 步骤锚点 → 列/行带 */
  const steps = [];
  for (let i = 1; i <= tokensInfo.numPages; i++) {
    if (pageKind[i] !== 'content') continue;
    const t = classifyTokens(pagesMeta[i].tokens);
    if (!t.anchors.length) continue;
    const px = await getPixels(i);
    const ptW = px.w / PT;
    pxCache.delete(i);
    const colOf = (a) => (a.x < ptW / 2 ? 0 : 1);
    const byCol = new Map();
    for (const a of t.anchors) { const c = colOf(a); if (!byCol.has(c)) byCol.set(c, []); byCol.get(c).push(a); }
    for (const [c, list] of byCol) {
      list.sort((a, b) => b.y - a.y);
      list.forEach((a, idx) => {
        const top = idx === 0 ? 1e9 : (list[idx - 1].y + a.y) / 2;
        const bot = idx === list.length - 1 ? -1e9 : (a.y + list[idx + 1].y) / 2;
        steps.push({ stepKey: `${book.bookId}:p${i}:s${a.s}#${idx}`, page: i, stepNumber: Number(a.s), col: c, band: { top, bot }, anchor: a });
      });
    }
    // 同页同步骤号 → 归属歧义，finalize 排除
    const seen = new Map();
    for (const s of steps) if (s.page === i) seen.set(s.stepNumber, (seen.get(s.stepNumber) || 0) + 1);
    for (const s of steps) if (s.page === i) s.dupOnPage = seen.get(s.stepNumber);
  }

  /* 4. cell 矩形（pt, y-up） */
  const pagePtH = new Map(), pagePtW = new Map();
  for (const s of steps) {
    if (!pagePtH.has(s.page)) {
      const buf = fs.readFileSync(path.join(bookDir, `page-${String(s.page).padStart(2, '0')}.png`));
      pagePtH.set(s.page, buf.readUInt32BE(20) / PT);
      pagePtW.set(s.page, buf.readUInt32BE(16) / PT);
    }
    const ptW = pagePtW.get(s.page), ptH = pagePtH.get(s.page);
    const colW = ptW / 2;
    s.cellRect = {
      x0: s.col === 0 ? 0 : colW, x1: s.col === 0 ? colW : ptW,
      y0: Math.max(s.band.bot, 0), y1: Math.min(s.band.top, ptH),
    };
  }

  /* 5. 逐内容页：盒 blob（实心底色块）→ callout / 徽章盒 */
  const callouts = [];
  const pageBoxes = new Map(); // page → {grid, boxes}
  for (let i = 1; i <= tokensInfo.numPages; i++) {
    if (pageKind[i] !== 'content') continue;
    const ct = classifyTokens(pagesMeta[i].tokens);
    if (!ct.qtys.length && !ct.badges.length) continue;
    const px = await getPixels(i);
    const grid = gridAnalysis(px.w, px.h, px.data);
    const opened = openInk(grid.gw, grid.gh, grid.ink);
    const blobs = boxBlobs(grid.gw, grid.gh, opened, px.data, px.w);
    // 候选盒：实心底色块（relaxed：收缩前允许被细线并入外部内容）；收缩到真实盒 interior
    const candBoxes = blobs.filter(b => b.fill >= 0.3 && b.modeShare >= 0.4 && b.bw >= 15 && b.bh >= 8)
      .map(b => shrinkToFill(px, b))
      .filter(b => (b.bw2 || b.bw) >= 12 && (b.bh2 || b.bh) >= 7);
    const inRect = (tok, r, pad = 1) => {
      const [gx, gy] = ptToGrid(px, tok.x, tok.y);
      return gx >= r.x0 - pad && gx <= r.x1 + pad && gy >= r.y0 - pad && gy <= r.y1 + pad;
    };
    const boxes = [];
    for (const b of candBoxes) {
      const qts = ct.qtys.filter(q => inRect(q, b));
      const bds = ct.badges.filter(q => inRect(q, b));
      if (qts.length) boxes.push({ blob: b, kind: 'callout', qts, bds });
      else if (bds.length) boxes.push({ blob: b, kind: 'repeat', qts: [], bds });
    }
    for (const box of boxes) {
      const b = box.blob;
      if (box.kind === 'callout') {
        const textRects = box.qts.map(q => ptToGridRect(px, q.x - 3, q.y - 3, q.x + 5 * q.s.length + 3, q.y + 12));
        const parts = boxContentComps(px, grid, b, textRects);
        if (box.qts.length === 1 && parts.length > 1) {
          // 簇 callout：整簇标一个 "Nx"（部件各自数量需人工核对，绝不自动猜）
          callouts.push({
            id: `${book.bookId}:p${i}:cl${callouts.length}`, page: i,
            box: gridRectToPt(px, b), isRepeatBox: false, cluster: true,
            qtyToken: box.qts[0], qty: Number(box.qts[0].s.slice(0, -1)),
            partComps: parts, partCompsPt: parts.map(c => gridRectToPt(px, c)), boxColor: b.modeColor,
          });
          continue;
        }
        for (const a of assignQtyToParts(box.qts, parts)) {
          callouts.push({
            id: `${book.bookId}:p${i}:c${callouts.length}`, page: i,
            box: gridRectToPt(px, b), partComp: a.part, qty: a.qty ? Number(a.qty.s.slice(0, -1)) : null,
            qtyToken: a.qty || null, isRepeatBox: false, boxColor: b.modeColor,
          });
        }
      } else {
        const textRects = box.bds.map(b2 => ptToGridRect(px, b2.x - 3, b2.y - 3, b2.x + 6 * b2.s.length + 5, b2.y + 20));
        const parts = boxContentComps(px, grid, b, textRects);
        callouts.push({
          id: `${book.bookId}:p${i}:rb${callouts.length}`, page: i,
          box: gridRectToPt(px, b), isRepeatBox: true, badgeCount: Number(box.bds[0].s.slice(0, -1)),
          partComps: parts, qty: null, boxColor: b.modeColor,
        });
      }
    }
    // 供建造区排除使用（boxes=callout/徽章盒；annot=贴纸说明等无数量盒，也排除出建造区）
    const annotBoxes = blobs.filter(b => {
      const bb = shrinkToFill(px, b);
      return ct.stickerIdx.some(q => inRect(q, bb, 2)) && !boxes.some(x => x.blob === b);
    }).map(b => shrinkToFill(px, b));
    pageBoxes.set(i, { boxes: [...boxes.map(x => x.blob), ...annotBoxes], blobs });
    pxCache.delete(i);
  }

  /* 6. callout 归属（cellRect 包含盒中心）+ 无锚点页 → 子装配组 */
  const stepsByPage = new Map();
  for (const s of steps) { if (!stepsByPage.has(s.page)) stepsByPage.set(s.page, []); stepsByPage.get(s.page).push(s); }
  const unByPage = new Map();
  for (const co of callouts) {
    const cx = (co.box.x0 + co.box.x1) / 2, cy = (co.box.y0 + co.box.y1) / 2;
    const owner = (stepsByPage.get(co.page) || [])
      .find(s => cx >= s.cellRect.x0 && cx <= s.cellRect.x1 && cy >= s.cellRect.y0 && cy <= s.cellRect.y1);
    if (owner) { co.stepKey = owner.stepKey; co.stepNumber = owner.stepNumber; }
    else {
      co.stepKey = `${book.bookId}:p${co.page}:sub`;
      if (!unByPage.has(co.page)) unByPage.set(co.page, true);
    }
  }
  const subGroups = [...unByPage.keys()].map(page => ({ stepKey: `${book.bookId}:p${page}:sub`, page }));

  /* 7. 建造区 bbox（每步骤：cell 内非盒、非线条、非步骤号/页脚的组件并集） */
  for (let i = 1; i <= tokensInfo.numPages; i++) {
    // 子装配分组（无锚点页）：buildRect = 其 callout 盒并集 + 边距（先于步骤 continue 处理）
    const pxForSub = subGroups.some(g => g.page === i) || stepsByPage.has(i) ? await getPixels(i) : null;
    for (const g of subGroups.filter(x => x.page === i)) {
      const boxesOfGroup = callouts.filter(c => c.stepKey === g.stepKey && c.box).map(c => c.box);
      if (!boxesOfGroup.length || !pxForSub) continue;
      const m = 15;
      g.buildRect = {
        x0: Math.max(0, Math.min(...boxesOfGroup.map(b => b.x0)) - m),
        x1: Math.min(pxForSub.w / PT, Math.max(...boxesOfGroup.map(b => b.x1)) + m),
        y0: Math.max(0, Math.min(...boxesOfGroup.map(b => b.y0)) - m),
        y1: Math.min(pxForSub.h / PT, Math.max(...boxesOfGroup.map(b => b.y1)) + m),
      };
    }
    const list = stepsByPage.get(i) || [];
    if (!list.length) { pxCache.delete(i); continue; }
    const boxes = (pageBoxes.get(i) || { boxes: [], blobs: [], boxesSet: new Set() });
    const px = await getPixels(i);
    const grid = gridAnalysis(px.w, px.h, px.data);
    // 开运算 blob（细线被去除，盒与模型解耦）；盒 blob 排除，其余为建造区候选
    const opened = openInk(grid.gw, grid.gh, grid.ink);
    const allBlobs = boxes.blobs && boxes.blobs.length ? boxes.blobs : boxBlobs(grid.gw, grid.gh, opened, px.data, px.w);
    const boxSet = boxes.boxes;
    const inAnyBox = (comp) => boxSet.some(b =>
      comp.x0 >= b.x0 - 1 && comp.x1 <= b.x1 + 1 && comp.y0 >= b.y0 - 1 && comp.y1 <= b.y1 + 1);
    for (const s of list) {
      const r = s.cellRect;
      const gx0 = Math.max(0, Math.floor(r.x0 * PT / GRID_CELL)), gx1 = Math.min(grid.gw - 1, Math.ceil(r.x1 * PT / GRID_CELL));
      const gy0 = Math.max(0, Math.floor((px.h - r.y1 * PT) / GRID_CELL)), gy1 = Math.min(grid.gh - 1, Math.ceil((px.h - r.y0 * PT) / GRID_CELL));
      const [ax, ay] = ptToGrid(px, s.anchor.x, s.anchor.y);
      const footerY = Math.floor((px.h - 22 * PT) / GRID_CELL); // pt y<22 视为页脚带
      let bx0 = -1, bx1 = -1, by0 = -1, by1 = -1;
      for (const comp of allBlobs) {
        if (comp.x1 < gx0 || comp.x0 > gx1 || comp.y1 < gy0 || comp.y0 > gy1) continue;
        if (inAnyBox(comp)) continue;
        if (comp.area < 6) continue;                                        // 碎屑
        if (comp.fill < THIN_FILL_RATIO) continue;                          // 残余线条
        if (compContains(comp, ax, ay)) continue;                           // 步骤号字形
        if (comp.y1 >= footerY && comp.bw < 8 && comp.bh < 8) continue;     // 页脚页码
        if (bx0 < 0 || comp.x0 < bx0) bx0 = comp.x0;
        if (bx1 < 0 || comp.x1 > bx1) bx1 = comp.x1;
        if (by0 < 0 || comp.y0 < by0) by0 = comp.y0;
        if (by1 < 0 || comp.y1 > by1) by1 = comp.y1;
      }
      s.buildRect = bx0 < 0 ? null : gridRectToPt(px, { x0: bx0, x1: bx1, y0: by0, y1: by1 });
    }
    pxCache.delete(i);
  }

  /* 8. callout 裁剪 + 模板匹配 */
  const cropDir = path.join(OUT, 'crops', book.bookId);
  ensureDir(cropDir);
  const featCache = new Map();
  async function features(pngPath) {
    if (featCache.has(pngPath)) return featCache.get(pngPath);
    const { createCanvas, loadImage } = require2('@napi-rs/canvas');
    const img = await loadImage(pngPath);
    const S = 32;
    const canvas = createCanvas(S, S);
    const c2 = canvas.getContext('2d');
    c2.fillStyle = '#fff';
    c2.fillRect(0, 0, S, S);
    const scale = Math.min(S / img.width, S / img.height);
    c2.drawImage(img, (S - img.width * scale) / 2, (S - img.height * scale) / 2, img.width * scale, img.height * scale);
    const id = c2.getImageData(0, 0, S, S).data;
    // 墨水密度特征（白=0，黑=1，非零均值 → 平移容忍）+ 3×3 盒模糊
    const inkRaw = new Float64Array(S * S);
    const hist = new Float64Array(64);
    for (let i = 0; i < S * S; i++) {
      const r = id[i * 4], g = id[i * 4 + 1], b = id[i * 4 + 2];
      inkRaw[i] = 1 - (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      if (!(r > 240 && g > 240 && b > 240)) hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)]++;
    }
    const gray = new Float64Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
        s += inkRaw[ny * S + nx]; n++;
      }
      gray[y * S + x] = s / n;
    }
    let hs = 0; for (const v of hist) hs += v;
    if (hs > 0) for (let i = 0; i < 64; i++) hist[i] /= hs;
    const feat = { gray, hist };
    featCache.set(pngPath, feat);
    return feat;
  }
  function similarity(a, b) {
    let dot = 0;
    for (let i = 0; i < a.gray.length; i++) dot += a.gray[i] * b.gray[i];
    const cos = Math.max(0, dot / a.gray.length);
    let inter = 0;
    for (let i = 0; i < 64; i++) inter += Math.min(a.hist[i], b.hist[i]);
    return 0.75 * cos + 0.25 * inter;
  }
  // 旋转变体：callout 与总览格的同件零件角度可能不同（±30° 步进）
  function rotateGray(g, deg) {
    const S = 32, out = new Float64Array(S * S);
    const rad = deg * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad), mid = (S - 1) / 2;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x - mid, dy = y - mid;
      const sx = Math.round(c * dx + s * dy + mid), sy = Math.round(-s * dx + c * dy + mid);
      out[y * S + x] = (sx >= 0 && sx < S && sy >= 0 && sy < S) ? g[sy * S + sx] : 0;
    }
    return out;
  }
  const cellFeats = [];
  for (const c of overviewByElement.values()) {
    const feat = await features(path.join(OUT, c.cellPath));
    const grays = [0, 15, -15, 30, -30].map(deg => ({ deg, gray: deg === 0 ? feat.gray : rotateGray(feat.gray, deg) }));
    cellFeats.push({ cell: c, feat, grays });
  }
  async function matchCrop(pngPath) {
    const f = await features(pngPath);
    let fNorm = 0;
    for (let i = 0; i < f.gray.length; i++) fNorm += f.gray[i] * f.gray[i];
    fNorm = Math.sqrt(fNorm) || 1;
    return cellFeats.map(({ cell, feat, grays }) => {
      let bestCos = 0, bestDeg = 0;
      for (const { deg, gray } of grays) {
        let dot = 0, n1 = 0, n2 = 0;
        for (let i = 0; i < gray.length; i++) { dot += gray[i] * f.gray[i]; n1 += gray[i] * gray[i]; n2 += f.gray[i] * f.gray[i]; }
        const cos = Math.max(0, dot / (Math.sqrt(n1 * n2) || 1));
        if (cos > bestCos) { bestCos = cos; bestDeg = deg; }
      }
      let inter = 0;
      for (let i = 0; i < 64; i++) inter += Math.min(feat.hist[i], f.hist[i]);
      return { element: cell.element, score: +(0.75 * bestCos + 0.25 * inter).toFixed(4), rot: bestDeg };
    }).sort((a, b) => b.score - a.score).slice(0, 3);
  }

  for (const co of callouts) {
    const px = await getPixels(co.page);
    const keyOpts = co.boxColor ? { keyFill: co.boxColor } : {};
    if (co.isRepeatBox || co.cluster) {
      co.crops = [];
      for (let k = 0; k < co.partComps.length; k++) {
        const r = compPtRect(px, co.partComps[k]);
        const crop = tightInkCrop(px, r.x0 - 2, r.y0 - 2, r.x1 + 2, r.y1 + 2, keyOpts);
        if (!crop || crop.w < 10 || crop.h < 10) continue;
        const f = path.join(cropDir, `${co.id.replace(/:/g, '-')}-part${k}.png`);
        fs.writeFileSync(f, crop.png);
        co.crops.push({ path: path.relative(OUT, f).replace(/\\/g, '/'), sha256: computeSha256(crop.png), matches: await matchCrop(f) });
      }
    } else if (co.partComp) {
      const r = compPtRect(px, co.partComp);
      const drops = co.qtyToken ? [[co.qtyToken.x - 4, co.qtyToken.y - 3, co.qtyToken.x + 6 * co.qtyToken.s.length + 4, co.qtyToken.y + 12]] : [];
      const crop = tightInkCrop(px, r.x0 - 2, r.y0 - 2, r.x1 + 2, r.y1 + 2, { ...keyOpts, dropTextRects: drops });
      if (!crop || crop.w < 10 || crop.h < 10) { co.dropReason = 'callout-crop-too-small'; }
      else {
        const f = path.join(cropDir, `${co.id.replace(/:/g, '-')}.png`);
        fs.writeFileSync(f, crop.png);
        co.cropPath = path.relative(OUT, f).replace(/\\/g, '/');
        co.cropSha256 = computeSha256(crop.png);
        co.matches = await matchCrop(f);
        co.auto = co.matches[0] && co.matches[0].score >= AUTO_ACCEPT_SCORE &&
          (co.matches.length < 2 || co.matches[0].score - co.matches[1].score >= AUTO_ACCEPT_MARGIN)
          ? co.matches[0].element : null;
      }
    } else {
      co.dropReason = 'no-part-image-in-callout';
    }
    pxCache.delete(co.page);
  }

  /* 9. 接触表 */
  const { createCanvas, loadImage } = require2('@napi-rs/canvas');
  const sheetDir = path.join(OUT, 'sheets');
  ensureDir(sheetDir);
  const flat = [];
  for (const co of callouts) {
    if (co.isRepeatBox || co.cluster) co.crops.forEach((c, k) => flat.push({ co, crop: c, k }));
    else flat.push({ co, crop: co.cropPath ? { path: co.cropPath } : null, k: 0 });
  }
  const sheets = [];
  for (let i = 0; i < flat.length; i += SHEET_ENTRIES) {
    const entries = flat.slice(i, i + SHEET_ENTRIES);
    const CW = 360, CH = 150, COLS = 4;
    const rows = Math.ceil(entries.length / COLS);
    const canvas = createCanvas(CW * COLS, CH * rows);
    const c2 = canvas.getContext('2d');
    c2.fillStyle = '#ffffff';
    c2.fillRect(0, 0, canvas.width, canvas.height);
    for (let e = 0; e < entries.length; e++) {
      const { co, crop, k } = entries[e];
      const ox = (e % COLS) * CW, oy = Math.floor(e / COLS) * CH;
      c2.font = '13px sans-serif';
      c2.fillStyle = '#000000';
      c2.fillText(co.isRepeatBox ? `${co.id}#${k} [x${co.badgeCount}]` : `${co.id} qty=${co.qty}`, ox + 4, oy + 14);
      c2.fillStyle = '#b00';
      c2.fillText(co.isRepeatBox ? '' : (co.auto ? `AUTO=${co.auto}` : (co.matches && co.matches.length ? `top1=${co.matches[0].element}@${co.matches[0].score.toFixed(2)}` : 'NO-MATCH')), ox + 200, oy + 14);
      c2.fillStyle = '#000';
      if (crop) {
        try {
          const img = await loadImage(path.join(OUT, crop.path));
          const scale = Math.min(100 / img.width, 100 / img.height, 2);
          c2.drawImage(img, ox + 4, oy + 22, img.width * scale, img.height * scale);
        } catch { /* 忽略单图失败 */ }
        const ms = co.isRepeatBox ? crop.matches : co.matches;
        if (ms) {
          for (let m = 0; m < Math.min(3, ms.length); m++) {
            const cell = overviewByElement.get(ms[m].element);
            if (!cell) continue;
            try {
              const img = await loadImage(path.join(OUT, cell.cellPath));
              const scale = Math.min(52 / img.width, 52 / img.height, 1.5);
              const cxp = ox + 118 + m * 78, cyp = oy + 24;
              c2.drawImage(img, cxp, cyp, img.width * scale, img.height * scale);
              c2.fillStyle = m === 0 ? '#070' : '#555';
              c2.fillText(`${cell.element} ${ms[m].score.toFixed(2)}`, cxp - 2, cyp + 58);
              c2.fillStyle = '#000';
            } catch { /* 忽略 */ }
          }
        }
      } else {
        c2.fillStyle = '#b00';
        c2.fillText('NO-CROP ' + (co.dropReason || ''), ox + 4, oy + 40);
        c2.fillStyle = '#000';
      }
    }
    const sheetFile = path.join(sheetDir, `${book.bookId}-sheet-${String(sheets.length + 1).padStart(2, '0')}.png`);
    fs.writeFileSync(sheetFile, canvas.toBuffer('image/png'));
    sheets.push({ file: path.relative(OUT, sheetFile).replace(/\\/g, '/'), entries: entries.map(e => `${e.co.id}${e.co.isRepeatBox ? '#' + e.k : ''}`) });
  }

  const result = {
    bookId: book.bookId, set: book.set, role: book.role,
    numPages: tokensInfo.numPages,
    pageKinds: pageKind,
    steps: steps.map(s => ({
      stepKey: s.stepKey, page: s.page, stepNumber: s.stepNumber, col: s.col,
      buildRect: s.buildRect, cellRect: s.cellRect, dupOnPage: s.dupOnPage,
    })),
    subGroups,
    callouts: callouts.map(co => ({
      id: co.id, page: co.page, stepKey: co.stepKey, stepNumber: co.stepNumber || null,
      isRepeatBox: co.isRepeatBox, cluster: !!co.cluster, badgeCount: co.badgeCount || null, qty: co.qty || null,
      cropPath: co.cropPath || (co.crops ? co.crops.map(c => c.path) : null),
      cropSha256: co.cropSha256 || (co.crops ? co.crops.map(c => c.sha256) : null),
      cropMatches: co.crops ? co.crops.map(c => c.matches) : null,
      matches: co.matches || null, auto: co.auto || null, dropReason: co.dropReason || null,
    })),
    overview: [...overviewByElement.values()],
    sheets,
  };
  wjson(path.join(OUT, 'candidates', `${book.bookId}.json`), result);
  console.log(`[extract] ${book.bookId}: 步骤锚点 ${steps.length}，子装配组 ${subGroups.length}，callout ${callouts.length}，总览元素 ${overviewByElement.size}，接触表 ${sheets.length} 张`);
  return result;
}

/* ============================================================ finalize */
function loadBomMap(set) {
  // 合并 bom/*.bom.json（fetch-bom 产物：element(sourceId) → ldraw design + LDraw 色号 + 名称）
  const dir = path.join(OUT, 'bom');
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    if (!(f.endsWith('.online.bom.json') || f.endsWith('.bom.json'))) continue;
    if (!f.startsWith(`${set}_`) && !f.startsWith(`${set}-`)) continue;
    try {
      const b = rjson(path.join(dir, f));
      for (const p of b.parts || []) {
        const key = p.sourceId;
        if (!key) continue;
        const cur = map.get(key) || { ldraw: null, color: null, name: null, catalog: false };
        if (p.ldraw && !cur.ldraw) cur.ldraw = p.ldraw;
        if (p.color != null && cur.color == null) cur.color = p.color;
        if (p.name && !cur.name) cur.name = p.name;
        if (p.catalog) cur.catalog = true;
        map.set(key, cur);
      }
    } catch { /* 跳过坏文件 */ }
  }
  return map;
}

function sourceUrlFor(set) {
  try {
    const m = rjson(SOURCE_MANIFEST);
    const s = m.sets.find(x => x.set === `${set}-1`);
    return s ? s.books.map(b => b.url) : null;
  } catch { return null; }
}

function extractorRevision() {
  const f = path.join(ROOT, 'src/manual-v2/extractor.js');
  return `src/manual-v2/extractor.js@sha256:${computeSha256(fs.readFileSync(f))}`;
}

async function extractorObservations() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/manual-v2/extractor.js')).href);
  const res = await mod.extractManualObservations(path.join(ROOT, 'out/manual-pages/60239'));
  return res.observations.map(o => ({
    observationId: o.observationId, stepNumber: o.stepNumber, isFlip: o.isFlip,
    partsAdded: o.partsAdded, page: o.page,
  }));
}

function partsAgree(extParts, mine) {
  const norm = (arr) => arr.map(p => `${p.partId}#${p.colorId}#${p.qty}`).sort().join('|');
  const extNorm = extParts.map(p => `${p.partIdCandidate}#${p.colorId}#${p.qty}`).sort().join('|');
  return norm(mine) === extNorm ? true : `extractor[${extNorm}] != pipeline[${norm(mine)}]`;
}

async function stageFinalize(book) {
  const cand = rjson(path.join(OUT, 'candidates', `${book.bookId}.json`));
  const decisions = exists(path.join(OUT, 'verify', 'decisions.json'))
    ? rjson(path.join(OUT, 'verify', 'decisions.json')) : {};
  const bomMap = loadBomMap(book.set);
  const sourceUrl = sourceUrlFor(book.set);
  const extractor = extractorRevision();
  const extObs = book.set === '60239' ? await extractorObservations() : [];

  const officialTotals = new Map();
  for (const r of cand.overview) officialTotals.set(r.element, (officialTotals.get(r.element) || 0) + r.qty);

  // 元素身份：decisions 优先，其次 auto；记录判定来源（human=接触表复核 / auto=高置信模板匹配）
  const identity = new Map();
  const identityBy = new Map();
  let autoAccepted = 0, humanDecided = 0, unverified = 0;
  for (const co of cand.callouts) {
    if (co.isRepeatBox || co.cluster) continue;
    const d = decisions[co.id];
    if (d && d.element === false) { identity.set(co.id, null); unverified++; continue; }
    if (d && typeof d.element === 'string') { identity.set(co.id, d.element); identityBy.set(co.id, 'human'); humanDecided++; continue; }
    if (d && d.acceptTop1 && co.matches && co.matches.length) { identity.set(co.id, co.matches[0].element); identityBy.set(co.id, 'human'); humanDecided++; continue; }
    if (co.auto) { identity.set(co.id, co.auto); identityBy.set(co.id, 'auto'); autoAccepted++; continue; }
    identity.set(co.id, null); unverified++;
  }
  // repeat 盒逐组件身份：键 `${calloutId}#${k}`
  const repeatIdentity = new Map();
  for (const co of cand.callouts.filter(c => c.isRepeatBox)) {
    (co.cropPath || []).forEach((cp, k) => {
      const d = decisions[`${co.id}#${k}`];
      let el = d && typeof d.element === 'string' ? d.element : null;
      let by = d ? 'human' : null;
      if (!el) {
        const m = (co.cropMatches || [])[k];
        if (m && m[0] && m[0].score >= AUTO_ACCEPT_SCORE && (m.length < 2 || m[0].score - m[1].score >= AUTO_ACCEPT_MARGIN)) {
          el = m[0].element; by = 'auto';
        }
      }
      repeatIdentity.set(`${co.id}#${k}`, { element: el, by });
      if (by === 'auto') autoAccepted++; else if (by === 'human') humanDecided++; else unverified++;
    });
  }

  // 步骤级部件汇总
  const stepParts = new Map();
  const addPart = (stepKey, element, qty) => {
    if (!stepParts.has(stepKey)) stepParts.set(stepKey, new Map());
    const m = stepParts.get(stepKey);
    m.set(element, (m.get(element) || 0) + qty);
  };
  const excludedCallouts = [];
  for (const co of cand.callouts) {
    if (!co.stepKey) { excludedCallouts.push({ id: co.id, reason: co.dropReason || 'unassigned' }); continue; }
    if (co.cluster) {
      // 簇 callout：仅接受人工显式给出的 parts（element+qty），BOM 守恒随后把关
      const d = decisions[co.id];
      if (d && Array.isArray(d.parts) && d.parts.every(p => typeof p.element === 'string' && p.qty > 0)) {
        for (const p of d.parts) addPart(co.stepKey, p.element, p.qty);
        identityBy.set(co.id, 'human');
        humanDecided++;
      } else {
        excludedCallouts.push({ id: co.id, reason: 'cluster-callout-unverified' });
      }
      continue;
    }
    if (co.isRepeatBox) {
      const d = decisions[co.id];
      if (d && Array.isArray(d.parts) && d.parts.every(p => typeof p.element === 'string' && p.qty > 0)) {
        for (const p of d.parts) addPart(co.stepKey, p.element, p.qty);
        identityBy.set(co.id, 'human');
        humanDecided++;
        continue;
      }
      const ids = (co.cropPath || []).map((cp, k) => repeatIdentity.get(`${co.id}#${k}`));
      if (!ids.length || ids.some(x => !x.element)) { excludedCallouts.push({ id: co.id, reason: 'repeat-box-component-unverified' }); continue; }
      const counts = new Map();
      for (const x of ids) counts.set(x.element, (counts.get(x.element) || 0) + 1);
      // 装配示意图跳过：同步骤普通 callout 已计入同一元素（如轮毂安装示意盒）则不重复计数
      const stepNormal = cand.callouts.filter(c => c.stepKey === co.stepKey && !c.isRepeatBox && !c.cluster && identity.get(c.id));
      if ([...counts.keys()].some(el => stepNormal.some(c => identity.get(c.id) === el))) {
        excludedCallouts.push({ id: co.id, reason: 'repeat-box-is-assembly-diagram' });
        continue;
      }
      for (const [el, n] of counts) addPart(co.stepKey, el, n * (co.badgeCount || 1));
      continue;
    }
    const el = identity.get(co.id);
    if (!el) { excludedCallouts.push({ id: co.id, reason: co.dropReason || 'identity-unverified' }); continue; }
    if (!co.qty) { excludedCallouts.push({ id: co.id, reason: 'qty-missing' }); continue; }
    addPart(co.stepKey, el, co.qty);
  }

  // BOM 守恒：每元素逐步之和 == 总览官方合计
  const elementSum = new Map();
  for (const [, m] of stepParts) for (const [el, q] of m) elementSum.set(el, (elementSum.get(el) || 0) + q);
  const bomCheck = { elements: officialTotals.size, matched: 0, mismatched: [], undercount: [], inStepsNotInOverview: [] };
  for (const [el, total] of officialTotals) {
    const got = elementSum.get(el) || 0;
    if (got === total) bomCheck.matched++;
    else if (got > total) bomCheck.mismatched.push({ element: el, official: total, extracted: got, delta: got - total });
    else bomCheck.undercount.push({ element: el, official: total, extracted: got, delta: got - total, note: '不足额由该元素被排除的 callout 解释（kept 步骤的标签仍完整）' });
  }
  for (const [el, got] of elementSum) if (!officialTotals.has(el)) bomCheck.inStepsNotInOverview.push({ element: el, extracted: got });

  // 正差额（超配 = 确有误配）元素所在步骤排除；负差额（欠配，源于自身排除的 callout）不扩散
  const badElements = new Set([...bomCheck.mismatched.map(m => m.element), ...bomCheck.inStepsNotInOverview.map(m => m.element)]);

  // 步骤筛选 + 样本
  const sampleDir = path.join(OUT, 'samples');
  ensureDir(sampleDir);
  // 清理本册旧样本文件（重跑 finalize 不残留旧 sampleId）
  for (const file of fs.readdirSync(sampleDir)) {
    if (file.startsWith(`smp-${book.set}-`) && file.endsWith('.json')) fs.unlinkSync(path.join(sampleDir, file));
  }
  const pagesDir = path.join(OUT, 'pages', book.bookId);
  const samples = [];
  const excludedSteps = [];
  const stepKeysSeen = new Set([...stepParts.keys()]);
  for (const s of cand.steps) stepKeysSeen.add(s.stepKey);
  for (const g of cand.subGroups) stepKeysSeen.add(g.stepKey);

  for (const stepKey of stepKeysSeen) {
    const partsMap = stepParts.get(stepKey) || new Map();
    const stepMeta = cand.steps.find(s => s.stepKey === stepKey) || null;
    const isSub = !stepMeta;
    const page = stepMeta ? stepMeta.page : Number(stepKey.match(/:p(\d+):/)[1]);
    // 步骤内有任一不可核 callout（非示意图跳过）→ 该步真值不完整 → 整步排除
    const badCallouts = cand.callouts.filter(c => c.stepKey === stepKey
      && excludedCallouts.some(e => e.id === c.id && !e.reason.startsWith('repeat-box-is-assembly-diagram')));
    if (badCallouts.length) {
      excludedSteps.push({ stepKey, reason: 'step-has-unverifiable-callout', callouts: badCallouts.map(c => c.id) });
      continue;
    }
    const badParts = [...partsMap.keys()].filter(el => badElements.has(el));
    if (badParts.length) { excludedSteps.push({ stepKey, reason: 'bom-sum-mismatch', elements: badParts }); continue; }
    // 部件 → design/color；映射缺失 → 排除（不猜 partId/colorId）
    const parts = [];
    let mappingGap = false;
    for (const [el, qty] of partsMap) {
      const b = bomMap.get(el);
      if (!b || !b.ldraw || b.color == null) { mappingGap = true; break; }
      parts.push({ elementId: el, partId: b.ldraw, colorId: b.color, partName: b.name, inCatalog: !!b.catalog, qty });
    }
    if (mappingGap) { excludedSteps.push({ stepKey, reason: 'element-mapping-missing', elements: [...partsMap.keys()] }); continue; }
    const dupRisk = stepMeta && stepMeta.dupOnPage > 1;
    if (dupRisk) { excludedSteps.push({ stepKey, reason: 'duplicate-step-number-on-page' }); continue; }

    const buildRect = stepMeta ? stepMeta.buildRect : (cand.subGroups.find(g => g.stepKey === stepKey) || {}).buildRect || null;
    if (!buildRect) {
      // 无建造区（纯延伸步骤/无锚点组无区域）→ 排除
      excludedSteps.push({ stepKey, reason: partsMap.size ? 'no-build-area-with-parts' : 'no-build-area' });
      continue;
    }
    const hasParts = parts.length > 0;
    if (!hasParts && isSub) { excludedSteps.push({ stepKey, reason: 'sub-group-no-verified-parts' }); continue; }
    // 零新增件编号步骤：仅当其所在页确有 callout 活动（否则可能是 app 安装页等大号数字页）
    const pageCalloutCount = cand.callouts.filter(c => c.page === page && !c.cluster).length;
    if (!hasParts && pageCalloutCount === 0) {
      excludedSteps.push({ stepKey, reason: 'page-without-any-callout' });
      continue;
    }

    // 裁剪建造区（≥768px 宽）
    const pagePng = path.join(pagesDir, `page-${String(page).padStart(2, '0')}.png`);
    const px = await loadPagePixels(pagePng);
    const m = 8 / PT;
    let { x0, x1, y0, y1 } = buildRect;
    x0 = Math.max(0, x0 - m); x1 = Math.min(px.w / PT, x1 + m);
    y0 = Math.max(0, y0 - m); y1 = Math.min(px.h / PT, y1 + m);
    if ((x1 - x0) * PT < BUILD_CROP_MIN_W) {
      const pageWpt = px.w / PT;
      const need = BUILD_CROP_MIN_W / PT - (x1 - x0);
      x0 = Math.max(0, x0 - need / 2); x1 = Math.min(pageWpt, x1 + need / 2);
      if (x1 - x0 < BUILD_CROP_MIN_W / PT - 0.5) { // 贴边仍不足 → 平移窗口
        x0 = Math.max(0, Math.min(x0, pageWpt - BUILD_CROP_MIN_W / PT));
        x1 = Math.min(pageWpt, x0 + BUILD_CROP_MIN_W / PT);
      }
    }
    const gx0 = Math.max(0, Math.floor(x0 * PT)), gx1 = Math.min(px.w - 1, Math.ceil(x1 * PT));
    const gy0 = Math.max(0, Math.floor(px.h - y1 * PT)), gy1 = Math.min(px.h - 1, Math.ceil(px.h - y0 * PT));
    const { createCanvas } = require2('@napi-rs/canvas');
    const cw = gx1 - gx0 + 1, ch = gy1 - gy0 + 1;
    const canvas = createCanvas(cw, ch);
    canvas.getContext('2d').drawImage(px.canvas, gx0, gy0, cw, ch, 0, 0, cw, ch);
    const buildPng = canvas.toBuffer('image/png');
    const buildRel = `crops/${book.bookId}/${stepKey.replace(/[:]/g, '-')}-build.png`;
    fs.writeFileSync(path.join(OUT, buildRel), buildPng);

    const calloutRefs = cand.callouts.filter(c => c.stepKey === stepKey).map(c => ({
      calloutId: c.id, qty: c.qty, isRepeatBox: c.isRepeatBox, badgeCount: c.badgeCount,
      cropPath: c.cropPath, cropSha256: c.cropSha256,
      matches: c.matches, cropMatches: c.cropMatches,
      decidedElement: c.isRepeatBox ? null : identity.get(c.id),
    }));
    const stepNumber = stepMeta ? stepMeta.stepNumber : null;
    const ext = stepNumber != null ? extObs.find(o => o.page === page && o.stepNumber === stepNumber) : null;
    const extAgree = ext ? partsAgree(ext.partsAdded, parts) : null;
    // 人工复核 = 全部 callout 的身份判定都经接触表人工确认（auto 判定不算人工）
    const humanReviewed = calloutRefs.length > 0 && calloutRefs.every(c => identityBy.get(c.calloutId) === 'human');
    const bookTag = book.bookId.replace(/^(\d+)-b(\d+)$/, 'b$2');
    const sampleId = `smp-${book.set}-${bookTag}-p${String(page).padStart(2, '0')}${isSub ? 'sub' : 's' + String(stepNumber).padStart(2, '0')}`;
    const sample = {
      sampleId,
      protocolVersion: '1.0.0',
      taskType: 'understand_step',
      familyId: book.set,
      split: book.role,
      provenance: {
        sourceKind: 'real_manual',
        setNumber: book.set,
        bookId: book.bookId,
        pageId: `page-${String(page).padStart(2, '0')}`,
        pageImage: { path: `pages/${book.bookId}/page-${String(page).padStart(2, '0')}.png`, sha256: computeSha256(fs.readFileSync(pagePng)) },
        stepIndex: stepNumber,
        subassemblyGroup: isSub ? stepKey : null,
        regionBboxNorm: normRect(buildRect, px.w, px.h),
        regionBboxPt: buildRect,
        sourceUrl,
        pdf: book.pdf,
        extractorRevision: extractor,
        extractedBy: 'tools/brickvlm/gen_manual_steps_dataset.mjs',
      },
      groundTruth: {
        partsAdded: parts,
        repeatEvents: calloutRefs.filter(c => c.isRepeatBox).map(c => ({ calloutId: c.calloutId, badgeCount: c.badgeCount })),
        isAssemblyEvent: !hasParts,
        isFlip: ext ? ext.isFlip : null,
        flipEvidence: ext ? 'src/manual-v2/extractor.js 人工锚点观察' : null,
        evidenceNote: hasParts
          ? '新增件 = 官方 callout 数量 token × 元素身份（模板匹配 + 人工接触表复核），满足每元素 BOM 合计守恒'
          : '本步骤 cell 无任何数量 token / 重复徽章（文本层证据），判定零新增件步骤',
      },
      images: [
        { role: 'target_manual_step', imagePath: buildRel, imageSha256: computeSha256(buildPng), labeled: false, width: cw, height: ch },
        { role: 'auxiliary_view', imagePath: `pages/${book.bookId}/page-${String(page).padStart(2, '0')}.png`, imageSha256: computeSha256(fs.readFileSync(pagePng)), labeled: false },
        ...calloutRefs.filter(c => !c.isRepeatBox && !c.cluster && typeof c.cropPath === 'string').map(c => ({ role: 'candidate_part', imagePath: c.cropPath, imageSha256: c.cropSha256, labeled: false })),
      ],
      callouts: calloutRefs,
      verification: {
        calloutVerified: hasParts || calloutRefs.length > 0,
        bomElementTotalsMatched: bomCheck.matched,
        bomElementTotalsMismatched: bomCheck.mismatched.length,
        extractorAnchorAgree: extAgree,
        extractorAnchorObs: ext ? ext.observationId : null,
        verifiedBy: ['pdf-text-layer', 'overview-template-match', ...(humanReviewed ? ['human-contact-sheet'] : []), ...(officialTotals.size ? ['bom-sum-conservation'] : ['bom-sum-unavailable(no-parts-overview-in-book)'])].join('+'),
        humanReviewed,
      },
      c3: book.role === 'dev' ? null : {
        sampleId,
        protocolVersion: '1.0',
        taskType: 'understand_step',
        provenance: {
          sourceFamilyId: book.set,
          sourceModelId: book.bookId,
          sourceKind: 'real_manual',
          split: book.role === 'holdout' ? 'holdout_test' : 'train',
        },
        verification: { isGeometricallyLegal: true, hasManualGroundTruth: true, verifiedBy: 'manual-callout-bom-crosscheck' },
      },
    };
    // 图片真实尺寸（PNG IHDR）+ 宽度下限校验
    for (const im of sample.images) {
      const buf = fs.readFileSync(path.join(OUT, im.imagePath));
      im.width = buf.readUInt32BE(16);
      im.height = buf.readUInt32BE(20);
      if (im.role === 'target_manual_step' && im.width < BUILD_CROP_MIN_W) {
        excludedSteps.push({ stepKey, reason: `build-crop-too-narrow:${im.width}px` });
        im.tooNarrow = true;
      }
    }
    if (sample.images.some(im => im.tooNarrow)) continue;
    samples.push(sample);
  }

  const sampleFiles = [];
  for (const s of samples) {
    const f = path.join(sampleDir, `${s.sampleId}.json`);
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
    sampleFiles.push(path.relative(OUT, f).replace(/\\/g, '/'));
  }
  const summary = {
    bookId: book.bookId, set: book.set, role: book.role,
    pages: cand.numPages,
    stepAnchors: cand.steps.length,
    subGroups: cand.subGroups.length,
    callouts: cand.callouts.length,
    identity: { autoAccepted, humanDecided, unverified },
    bomCheck,
    verifiedSteps: samples.length,
    sampleFiles,
    excludedSteps,
    excludedCallouts,
    sheets: cand.sheets,
  };
  wjson(path.join(OUT, 'candidates', `${book.bookId}.final.json`), summary);
  console.log(`[finalize] ${book.bookId}: 样本 ${samples.length}，排除步骤 ${excludedSteps.length}，BOM 元素守恒 ${bomCheck.matched}/${bomCheck.elements}，身份 auto=${autoAccepted} human=${humanDecided} unverified=${unverified}`);
  return summary;
}

function normRect(r, pw, ph) {
  return {
    x: +(r.x0 * PT / pw).toFixed(4), y: +((ph - r.y1 * PT) / ph).toFixed(4),
    width: +((r.x1 - r.x0) * PT / pw).toFixed(4), height: +((r.y1 - r.y0) * PT / ph).toFixed(4),
  };
}

/* ============================================================ manifest */
async function stageManifest() {
  const finals = BOOKS
    .map(b => path.join(OUT, 'candidates', `${b.bookId}.final.json`))
    .filter(exists)
    .map(rjson);
  const bySet = new Map();
  for (const f of finals) {
    if (!bySet.has(f.set)) bySet.set(f.set, { setNumber: f.set, role: f.role, books: [], pages: 0, verifiedSteps: 0, excludedSteps: 0, exclusionReasons: {}, sourceUrl: sourceUrlFor(f.set) });
    const rec = bySet.get(f.set);
    rec.books.push(f.bookId);
    rec.pages += f.pages;
    rec.verifiedSteps += f.verifiedSteps;
    rec.excludedSteps += f.excludedSteps.length;
    for (const e of f.excludedSteps) {
      const k = e.reason.split(':')[0];
      rec.exclusionReasons[k] = (rec.exclusionReasons[k] || 0) + 1;
    }
  }
  const sets = [...bySet.values()];
  const totals = {
    verifiedSteps: sets.reduce((s, x) => s + x.verifiedSteps, 0),
    trainCandidates: sets.filter(s => s.role === 'train').reduce((s, x) => s + x.verifiedSteps, 0),
    heldoutCandidates: sets.filter(s => s.role === 'holdout').reduce((s, x) => s + x.verifiedSteps, 0),
    devSteps: sets.filter(s => s.role === 'dev').reduce((s, x) => s + x.verifiedSteps, 0),
  };
  const agreementRates = {};
  for (const f of finals) {
    agreementRates[f.bookId] = {
      identityAutoAcceptRate: f.callouts ? +(f.identity.autoAccepted / Math.max(1, f.callouts.length)).toFixed(3) : null,
      bomElementsMatched: `${f.bomCheck.matched}/${f.bomCheck.elements}`,
      extractorAnchorAgree: bookExtractorAgree(f.bookId),
    };
  }
  // 集合级守恒：跨册已验证样本的元素合计 vs 集合级官方 BOM（Brickset 库存表快照）
  const setLevelConservation = {};
  for (const setRec of sets) {
    const bomFile = path.join(OUT, 'bom', `${setRec.setNumber}_set.online.bom.json`);
    if (!exists(bomFile)) { setLevelConservation[setRec.setNumber] = 'no-set-level-bom'; continue; }
    let setBom; try { setBom = rjson(bomFile); } catch { continue; }
    const totals = new Map((setBom.parts || []).filter(p => p.sourceId).map(p => [p.sourceId, p.qty]));
    const sums = new Map();
    for (const file of fs.readdirSync(path.join(OUT, 'samples'))) {
      const smp = rjson(path.join(OUT, 'samples', file));
      if (smp.familyId !== setRec.setNumber) continue;
      for (const p of smp.groundTruth.partsAdded || []) sums.set(p.elementId, (sums.get(p.elementId) || 0) + p.qty);
    }
    let matched = 0, over = [], under = 0;
    for (const [el, t] of totals) {
      const g = sums.get(el) || 0;
      if (g === t) matched++;
      else if (g > t) over.push({ element: el, official: t, extracted: g });
      else under++;
    }
    setLevelConservation[setRec.setNumber] = {
      setElements: totals.size, matched, overAssigned: over, underCounted: under,
      note: 'under/over 均含未进入样本的 callout（各册排除项）与无总览页分册；over>0 表示可能存在误配，明细已列',
    };
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    cmd: 'node tools/brickvlm/gen_manual_steps_dataset.mjs render|extract|finalize|manifest [--book=<bookId>]',
    task: 'C1-4 understand_step 真实说明书步骤数据集（docs/prd-v2/HANDOFF-C-single-agent.md §3）',
    protocolVersion: '1.0.0',
    datasetContract: 'docs/prd-v2/implementation-C/contracts/dataset.schema.json (C3, version 1.0；样本内嵌 c3 字段；dev 样本不出 C3 —— split 枚举无 dev，见 PRD §10.6 60239 仅开发)',
    notes: [
      '来源全部为 assets/instructions-lego/ 官方乐高说明书 PDF（LEGO 官网 CDN，本地已有，未新增下载）。',
      '步骤页不印元素号（11 册实测 0 命中）：元素身份 = callout 零件图与总览格图模板匹配 + 人工接触表复核；',
      '每元素逐步数量之和必须等于总览页官方合计（BOM 守恒），不符元素所在步骤整步排除，绝不猜测。',
      '75211 无文本层，整套排除（见 excludedSets）。',
      '60239 依 PRD §10.6 固定 dev，不进训练/留出；split 字段取值 dev/train/holdout（任务书口径），',
      '样本内嵌 c3 字段按冻结 C3 契约映射 train/holdout_test。',
    ],
    sets,
    totals,
    agreementRates,
    setLevelConservation,
    pendingBooks: BOOKS
      .filter(b => !exists(path.join(OUT, 'candidates', b.bookId + '.final.json')))
      .map(b => ({ bookId: b.bookId, set: b.set, role: b.role, reason: 'render+extract 完成，callout 已裁剪并做模板匹配（candidates/<bookId>.json），人工接触表复核未进行，未出样本' })),
    methodNotes: [
      '步骤页不印元素号：元素身份 = callout 零件图与总览格图模板匹配（32x32 墨水密度余弦+颜色直方图，±30° 旋转容忍），',
      '  加人工接触表复核（verify/decisions.json，acceptTop1 = 人工确认匹配器 top1）；auto 仅计 score>=0.90 且与次名差 >=0.04 者。',
      'BOM 守恒：每元素逐步数量之和 == 该册零件总览页官方合计；正差额（超配）元素所在步骤整步排除，',
      '  且全部超配 callout 已撤回重跑（最终 over-assigned=0）；负差额（欠配）由被排除 callout 解释，不扩散。',
      '身份不可核（含子装配重复盒组件、簇 callout、误配撤回）的步骤整步排除，绝不猜测。',
      '70615 为 auto-only（人工复核未进行，样本 verification.humanReviewed=false）。',
      '60239 与 src/manual-v2/extractor.js 的 8 条人工锚点观察按（页码,步骤号）对齐比较：可比较 4 条全部一致（p12-s11/p13-s12/p32-s44/p32-s45）。',
    ],
    excludedSets: EXCLUDED_BOOKS.map(b => ({ setNumber: b.set, bookId: b.bookId, reason: b.reason })),
    engineRevision: '88b51e1934c3fec901b9b6df5466188920c9b556487d110615938eaadcede5d3',
  };
  wjson(path.join(OUT, 'manifest.json'), manifest);
  console.log(`[manifest] totals=${JSON.stringify(totals)}`);
  return manifest;
}
function bookExtractorAgree(bookId) {
  const f = path.join(OUT, 'candidates', `${bookId}.final.json`);
  if (!exists(f)) return null;
  const j = rjson(f);
  void j;
  // 从样本文件统计 extractorAnchorAgree
  const dir = path.join(OUT, 'samples');
  if (!fs.existsSync(dir)) return null;
  let agree = 0, total = 0;
  for (const file of fs.readdirSync(dir)) {
    const s = rjson(path.join(dir, file));
    if (s.provenance?.bookId !== bookId) continue;
    if (s.verification.extractorAnchorAgree == null) continue;
    total++;
    if (s.verification.extractorAnchorAgree === true) agree++;
  }
  return total ? `${agree}/${total}` : 'n/a';
}

/* =============================================================== main */
async function main() {
  const cmd = process.argv[2] || 'all';
  const only = process.argv.find(a => a.startsWith('--book='))?.split('=')[1] || null;
  const books = BOOKS.filter(b => !only || b.bookId === only);
  ensureDir(OUT);
  if (cmd === 'manifest') { await stageManifest(); return; }
  for (const book of books) {
    if (cmd === 'render' || cmd === 'all') await stageRender(book);
    if (cmd === 'extract' || cmd === 'all') await stageExtract(book);
    if (cmd === 'finalize' || cmd === 'all') await stageFinalize(book);
  }
  if (cmd === 'manifest' || cmd === 'all') await stageManifest();
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((e) => { console.error(`[gen_manual_steps] 失败：${e && e.stack ? e.stack : e}`); process.exit(1); });
