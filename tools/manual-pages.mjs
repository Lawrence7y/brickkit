#!/usr/bin/env node
/**
 * tools/manual-pages.mjs — 说明书 PDF → 逐页高分辨率 PNG + manifest.json
 *
 * 用法：
 *   node tools/manual-pages.mjs <pdf> -o <dir> [--dpi 200] [--quiet] [--no-classify]
 *
 * 技术路线（选定理由）：
 *   pdfjs-dist 的 legacy 构建 + @napi-rs/canvas，纯 Node 渲染（提示①）。
 *   - pdfjs-dist v6 主构建用了 Promise.try（需 Node 24+），本仓库 Node 22 实测
 *     必须用 legacy/build/pdf.mjs（pdfjs 官方对 Node 环境的要求）。
 *   - @napi-rs/canvas 为预编译原生模块（免 node-gyp），pdfjs-dist v6 自身即把它
 *     列为 optionalDependency，说明 Node 端渲染是官方支持路径。
 *   - 相比提示②（Playwright + Chromium）省掉浏览器启动，实测更快、依赖更轻。
 *
 * 产出：
 *   <dir>/page-NN.png     两位数页序号（>99 页自动加宽）
 *   <dir>/manifest.json   { pages, dpi, tool, items:[{file,w,h,bytes,whiteRatio,…}], blank:[…] }
 *
 * blank 判定（任一命中，见 isBlank()；规则同时写入 manifest.blankRule）：
 *   whiteRatio > 0.995  或  inkRatio < 0.002  或  bytes < 15000
 *   依据：200 dpi A4 横版（≈1559×984）纯白 PNG 约 4–8 KB（实测合成白页 8211B）；
 *   实测 60239 最干净的内容页 164 KB，差一个数量级，15 KB 留了安全余量。
 *   注：whiteRatio 是绝对白像素占比（要求 ≥250），说明书页底色未必纯白
 *   （60239 步骤页底为浅蓝 212,237,252），故加 inkRatio（背景众数色偏离度）作主判据。
 *
 * 页分类（启发式，可 --no-classify 关闭）：classifyPage()，规则全部要求正向
 *   证据，拿不准返回 "other"，不硬猜；判据字段随 items 一并写出便于复核。
 *   - cover/step 用像素版式统计；parts-list 用【文本层零件号 token 计数】，
 *     在 60239_book1(36p)/10715_book1(48p)/31058_book1of3(48p) 上对真实清单页
 *     与步骤页交叉验证（清单页 token 35–131，步骤/引言页 0）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BLANK_WHITE_MAX = 0.995; // whiteRatio 超过它判 blank
const BLANK_MIN_BYTES = 15000; // PNG 体积低于它判 blank
const TOOL_NAME = 'tools/manual-pages.mjs';
const GRID_COLS = 64; // 版式网格：横向 64 格
const INK_CELL_MIN = 0.02; // 单元格内背景偏离像素 ≥ 2% 才算 ink 格

/* ------------------------------------------------------------------ 参数 */
function parseArgs(argv) {
  const out = { pdf: null, dir: null, dpi: 200, quiet: false, noClassify: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out' || a === '--out-dir') out.dir = argv[++i];
    else if (a === '--dpi') out.dpi = Number(argv[++i]);
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--no-classify') out.noClassify = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!out.pdf && !a.startsWith('-')) out.pdf = a;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

/* ------------------------------------------------- 原始 PDF 页树 /Count */
/**
 * 明文扫描 PDF，找根页树对象（/Type /Pages 且无 /Parent）的 /Count。
 * 页树被装进压缩对象流（/ObjStm）时可能扫不到，返回 null（如实上报，不猜）。
 */
export function readPageTreeCount(buf) {
  const s = buf.toString('latin1');
  const roots = [];
  const all = [];
  for (const m of s.matchAll(/\/Type\s*\/Pages\b/g)) {
    const start = s.lastIndexOf('<<', m.index);
    const end = s.indexOf('>>', m.index);
    if (start < 0 || end < 0 || end - start > 4000) continue;
    const dict = s.slice(start, end);
    const cm = dict.match(/\/Count\s+(\d+)/);
    if (!cm) continue;
    all.push(Number(cm[1]));
    if (!/\/Parent\s+\d+\s+0\s+R/.test(dict)) roots.push(Number(cm[1]));
  }
  return { root: roots.length ? Math.max(...roots) : null, allCounts: all.sort((a, b) => b - a) };
}

/* ------------------------------------------------------------- 像素统计 */
/**
 * 单遍扫描 RGBA 缓冲 + 64×? 版式网格，返回版面统计量。
 * 说明书页底色未必是纯白（如 60239 步骤页底为浅蓝 212,237,252），因此：
 *   whiteRatio：接近纯白（r,g,b ≥ 250）像素占比（指标，供 manifest 使用）。
 *   bgRatio：与「背景众数色」（32 阶量化直方图众数，平局取更亮者）距离 < 48
 *            的像素占比 —— 版面对空/满的真实度量。
 *   inkRatio = 1 − bgRatio：偏离背景色的像素占比。
 *   colorRatio：饱和彩色（max−min ≥ 40）像素占比（LEGO 零件多为高饱和色）。
 *   darkRatio：近黑（max ≤ 90）像素占比（文字、编号）。
 *   blobCount：ink 格 8 邻域连通分量数（面积 ≥ 3 格才计数，滤噪点）。
 *   areaCV：色块面积变异系数（低=大小均匀，典型零件清单网格）。
 *   dominantRatio：最大色块占全部 ink 格比例（高=整版大图，封面特征）。
 */
export function measureRgba(rgba, width, height) {
  const rows = Math.max(1, Math.round((GRID_COLS * height) / width));
  // 第一遍：32 阶量化直方图找背景众数色（记录每桶真实均值，避免桶下界失真）
  const hist = new Int32Array(8 * 8 * 8);
  const sumR = new Float64Array(8 * 8 * 8);
  const sumG = new Float64Array(8 * 8 * 8);
  const sumB = new Float64Array(8 * 8 * 8);
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 400000))); // 上限约 40 万样本
  for (let y = 0; y < height; y += step) {
    const rowBase = y * width;
    for (let x = 0; x < width; x += step) {
      const i = ((rowBase + x) << 2);
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const bi = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
      hist[bi]++; sumR[bi] += r; sumG[bi] += g; sumB[bi] += b;
    }
  }
  let best = -1, bestN = -1, bestLum = -1;
  for (let bi = 0; bi < hist.length; bi++) {
    const n = hist[bi];
    if (!n) continue;
    const lum = (sumR[bi] + sumG[bi] + sumB[bi]) / n; // 平局取更亮
    if (n > bestN || (n === bestN && lum > bestLum)) { bestN = n; best = bi; bestLum = lum; }
  }
  const bgR = best >= 0 ? Math.round(sumR[best] / bestN) : 255;
  const bgG = best >= 0 ? Math.round(sumG[best] / bestN) : 255;
  const bgB = best >= 0 ? Math.round(sumB[best] / bestN) : 255;

  // 第二遍：全图统计 + 网格
  const cellInk = new Float32Array(GRID_COLS * rows);
  const cellAll = new Float32Array(GRID_COLS * rows);
  let whitePix = 0, colorPix = 0, darkPix = 0, bgPix = 0;
  const cw = width / GRID_COLS, ch = height / rows;
  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, (y / ch) | 0);
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const i = ((rowBase + x) << 2);
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const k = gy * GRID_COLS + Math.min(GRID_COLS - 1, (x / cw) | 0);
      cellAll[k]++;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (r >= 250 && g >= 250 && b >= 250) whitePix++;
      if (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) < 48) bgPix++;
      else cellInk[k]++;
      if (mx - mn >= 40) colorPix++;
      else if (mx <= 90) darkPix++;
    }
  }
  const total = width * height;
  const ink = new Uint8Array(GRID_COLS * rows);
  let inkCells = 0;
  for (let k = 0; k < cellInk.length; k++) {
    if (cellAll[k] > 0 && cellInk[k] / cellAll[k] >= INK_CELL_MIN) { ink[k] = 1; inkCells++; }
  }
  // 8 邻域连通分量（栈迭代）
  const seen = new Uint8Array(ink.length);
  const stack = new Int32Array(ink.length);
  const blobs = [];
  for (let k = 0; k < ink.length; k++) {
    if (!ink[k] || seen[k]) continue;
    let top = 0; stack[top++] = k; seen[k] = 1;
    let area = 0, sx = 0, sy = 0;
    while (top > 0) {
      const c = stack[--top];
      area++;
      const cx = c % GRID_COLS, cy = (c / GRID_COLS) | 0;
      sx += cx; sy += cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_COLS || ny >= rows) continue;
        const nk = ny * GRID_COLS + nx;
        if (ink[nk] && !seen[nk]) { seen[nk] = 1; stack[top++] = nk; }
      }
    }
    blobs.push({ area, cy: sy / area });
  }
  const sig = blobs.filter((b) => b.area >= 3);
  // 小块统计（仅作 manifest 诊断字段，不参与分类规则——见 classifyPage 注释）
  const small = sig.filter((b) => b.area <= SMALL_BLOB_MAX_CELLS);
  const smallArea = small.reduce((a, b) => a + b.area, 0);
  const sigArea = sig.reduce((a, b) => a + b.area, 0) || 1;
  const sMean = small.length ? small.reduce((a, b) => a + b.area, 0) / small.length : 0;
  const sSd = small.length > 1
    ? Math.sqrt(small.reduce((a, b) => a + (b.area - sMean) ** 2, 0) / small.length) : 0;
  const areas = sig.map((b) => b.area);
  const mean = areas.length ? areas.reduce((a, b) => a + b, 0) / areas.length : 0;
  const sd = areas.length
    ? Math.sqrt(areas.reduce((a, b) => a + (b - mean) ** 2, 0) / areas.length) : 0;
  const rowsWithInk = new Set(blobs.map((b) => Math.round(b.cy))).size;
  return {
    whiteRatio: whitePix / total,
    bgRatio: bgPix / total,
    inkRatio: 1 - bgPix / total,
    colorRatio: colorPix / total,
    darkRatio: darkPix / total,
    bgColor: [bgR, bgG, bgB],
    blobCount: sig.length,
    smallCount: small.length,
    smallAreaCV: sMean > 0 ? sSd / sMean : 0,
    smallInkShare: small.length ? smallArea / sigArea : 0,
    areaCV: mean > 0 ? sd / mean : 0,
    dominantRatio: blobs.length
      ? Math.max(...blobs.map((b) => b.area)) / Math.max(1, inkCells)
      : 0,
    inkCells,
    rowsWithInk,
    gridRows: rows,
  };
}

/* --------------------------------------------------------------- 页分类 */
/**
 * 启发式版式分类。阈值全部是下面的具名常量，manifest.classification.rules
 * 由这些常量模板生成（见 main()），杜绝文档与代码漂移。
 * 每条规则都要求正向证据；不满足任何规则返回 "other"（不硬猜）。
 *
 * 零件清单判据用【文本层签名】而非像素小块统计：LEGO 说明书清单页每格都印
 * 零件号（5–8 位数字），一页 ≥PART_TOKEN_MIN 个不同的 6–8 位数字 token 即是
 * 清单页。该判据在 assets/instructions-lego 的 11 本书上交叉验证：8 个已知
 * 清单页 token 数 35–131，所有步骤/引言页均为 0。像素小色块统计（smallCount
 * 等）保留在 manifest.items 里供复核，但不再参与规则——实测它区分不了
 * "清单网格"与"步骤页底部一排小袋图标"（60239 p35 vs 31058 p45）。
 */
const BLANK_INK_MAX = 0.002;          // inkRatio 低于它：整页基本是底色 → blank
const COVER_INK_MIN = 0.5;            // 封面满版画面，墨量高
const COVER_DOMINANT_MIN = 0.45;      // 单一主导色块占比
const COVER_BLOB_MAX = 6;
const PART_TOKEN_MIN = 8;             // 零件清单：不同的 6-8 位数字 token 数下限
const PARTS_COLOR_MIN = 0.002;        // 零件清单：需有彩色零件格（排除纯数字表格页）
const SMALL_BLOB_MAX_CELLS = 30;      // "小块"上限（64 列版式网格格数；仅诊断用）
const STEP_BLOB_MIN = 2;              // 步骤页色块下限：60239 p2（一步半页）实测 2
const STEP_BLOB_MAX = 40;
const STEP_COLOR_MIN = 0.004;

export function classifyPage(st, pageIndex, pageCount, { partTokens = 0 } = {}) {
  if (isBlank(st)) return 'blank';
  const isFirstLast = pageIndex === 1 || pageIndex === pageCount;
  // 封面/封底：首末页 + 满版主导画面（整页几乎一块大色块）
  if (isFirstLast && st.inkRatio >= COVER_INK_MIN && st.dominantRatio >= COVER_DOMINANT_MIN &&
      st.blobCount <= COVER_BLOB_MAX) return 'cover';
  // 零件清单：文本层零件号签名（置于步骤页之前，混合页按清单归类）
  if (st.colorRatio >= PARTS_COLOR_MIN && partTokens >= PART_TOKEN_MIN) return 'parts-list';
  // 步骤页：非首末页 + 中等色块数 + 有彩色零件
  if (!isFirstLast && st.blobCount >= STEP_BLOB_MIN && st.blobCount <= STEP_BLOB_MAX &&
      st.colorRatio >= STEP_COLOR_MIN) return 'step';
  return 'other';
}

/**
 * 零件清单文本层签名：统计本页文本里出现的【不同的】6–8 位数字串个数。
 * LEGO 说明书清单页每格印零件号（如 3020 / 6052824 / 6129797），一步骤页
 * 只有 "1x/2x/页码" 等 1–2 位数字，命中数天然很低。
 */
export async function countPartTokens(page) {
  let tc;
  try {
    tc = await page.getTextContent();
  } catch {
    return 0; // 文本层异常不影响渲染主流程
  }
  const joined = tc.items.map((x) => x.str).join(' ');
  const set = new Set(joined.match(/\d{6,8}/g) || []);
  return set.size;
}

/**
 * blank 判定的唯一实现：classifyPage 与 manifest.blank 共用它，避免两处漂移。
 * 命中任一即空白：whiteRatio > 阈值；或 inkRatio < 阈值（整页几乎只有底色）；
 * 或 PNG 体积 < 阈值（纯色/近纯色压不出字节）。bytes 未知时只用前两条。
 */
function isBlank(st) {
  return st.whiteRatio > BLANK_WHITE_MAX ||
    st.inkRatio < BLANK_INK_MAX ||
    (st.bytes !== undefined && st.bytes < BLANK_MIN_BYTES);
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.pdf || !opts.dir) {
    console.error(`用法：node ${TOOL_NAME} <pdf> -o <dir> [--dpi 200] [--quiet] [--no-classify]`);
    process.exit(opts.help ? 0 : 2);
  }
  if (!Number.isFinite(opts.dpi) || opts.dpi <= 0) throw new Error(`--dpi 非法：${opts.dpi}`);
  const pdfPath = path.resolve(ROOT, opts.pdf);
  const outDir = path.resolve(ROOT, opts.dir);
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF 不存在：${pdfPath}`);
  fs.mkdirSync(outDir, { recursive: true });
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  const { getDocument, GlobalWorkerOptions, VerbosityLevel } = await import(
    'pdfjs-dist/legacy/build/pdf.mjs'
  );
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
  ).href;
  const { createCanvas, DOMMatrix, Path2D } = await import('@napi-rs/canvas');
  globalThis.DOMMatrix = DOMMatrix; // pdfjs 部分路径依赖全局构造器
  globalThis.Path2D = Path2D;

  const buf = fs.readFileSync(pdfPath);
  const pageTree = readPageTreeCount(buf);

  const doc = await getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    verbosity: VerbosityLevel.errors,
    useWorkerFetch: false, // Node 端用 fs.readFile 读 cmap/字体（fs 接受正斜杠；要求以 / 结尾）
    cMapUrl: toFsUrl(path.join(ROOT, 'node_modules/pdfjs-dist/cmaps')),
    cMapPacked: true,
    standardFontDataUrl: toFsUrl(path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts')),
    wasmUrl: toFsUrl(path.join(ROOT, 'node_modules/pdfjs-dist/wasm')),
  }).promise;

  const scale = opts.dpi / 72; // pdfjs 基准 72 dpi
  const items = [];
  const blank = [];
  const t0 = Date.now();

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    try {
      const vp = page.getViewport({ scale });
      const w = Math.round(vp.width), h = Math.round(vp.height);
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const png = canvas.toBuffer('image/png');
      const img = ctx.getImageData(0, 0, w, h);
      const st = measureRgba(img.data, w, h);
      st.bytes = png.length; // blank 判定共用字段（isBlank 读 st.bytes）
      const partTokens = await countPartTokens(page); // 文本层零件号签名
      const file = `page-${String(i).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(outDir, file), png);
      const kind = opts.noClassify ? 'unclassified'
        : classifyPage(st, i, doc.numPages, { partTokens });
      items.push({
        file, page: i, w, h, bytes: png.length,
        whiteRatio: r6(st.whiteRatio), inkRatio: r6(st.inkRatio),
        colorRatio: r6(st.colorRatio), darkRatio: r6(st.darkRatio),
        blobCount: st.blobCount, smallCount: st.smallCount,
        smallAreaCV: r6(st.smallAreaCV), smallInkShare: r6(st.smallInkShare),
        areaCV: r6(st.areaCV), dominantRatio: r6(st.dominantRatio),
        partTokens,
        kind,
      });
      if (isBlank(st)) blank.push(file);
      log(`  ${file}  ${w}x${h}  ${(png.length / 1024).toFixed(0)}KB  white=${st.whiteRatio.toFixed(4)}  ink=${st.inkRatio.toFixed(3)}  blobs=${st.blobCount}  ${kind}`);
    } finally {
      page.cleanup();
    }
  }

  const kinds = {};
  for (const it of items) kinds[it.kind] = (kinds[it.kind] || 0) + 1;

  const manifest = {
    pages: items.length,
    dpi: opts.dpi,
    tool: TOOL_NAME,
    source: path.relative(ROOT, pdfPath).replace(/\\/g, '/'),
    generatedAt: new Date().toISOString(),
    pdfPageTree: {
      rootCount: pageTree.root,
      agreesWithPages: pageTree.root === null ? 'unknown' : pageTree.root === items.length,
    },
    blankRule: {
      // 与 isBlank() 一一对应；改阈值只需改文件顶部常量，此处自动同步
      anyOf: [
        `whiteRatio > ${BLANK_WHITE_MAX}`,
        `inkRatio < ${BLANK_INK_MAX}`,
        `bytes < ${BLANK_MIN_BYTES}`,
      ],
      note: 'A4横@200dpi 纯白 PNG 约 4–8KB（实测合成白页 8211B），60239 最干净内容页 164KB，差一个数量级',
    },
    classification: opts.noClassify ? { heuristic: false } : {
      heuristic: true,
      // 规则文本由 classifyPage() 使用的同名常量生成，保证与代码一致
      rules: {
        blank: `whiteRatio > ${BLANK_WHITE_MAX} 或 inkRatio < ${BLANK_INK_MAX} 或 bytes < ${BLANK_MIN_BYTES}`,
        cover: `首/末页 且 inkRatio ≥ ${COVER_INK_MIN} 且 dominantRatio ≥ ${COVER_DOMINANT_MIN} 且 blobCount ≤ ${COVER_BLOB_MAX}`,
        'parts-list': `colorRatio ≥ ${PARTS_COLOR_MIN} 且 partTokens ≥ ${PART_TOKEN_MIN}（partTokens=文本层中不同的 6–8 位数字串个数，即零件号；11 本说明书实测：已知清单页 35–131，步骤/引言页 0）`,
        step: `非首末页 且 blobCount ∈ [${STEP_BLOB_MIN}, ${STEP_BLOB_MAX}] 且 colorRatio ≥ ${STEP_COLOR_MIN}`,
        other: '无规则命中（不硬猜）',
      },
      caveat: '60239 book1 无零件清单页（清单在 book2/3），parts-list 规则在 31058_book1of3.pdf p45（真实清单页，partTokens=67）上验证命中',
    },
    kinds,
    elapsedMs: Date.now() - t0,
    items,
    blank,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`\n${items.length} 页 → ${path.relative(ROOT, outDir).replace(/\\/g, '/')}  ` +
      `(${(manifest.elapsedMs / 1000).toFixed(1)}s)  blank=${blank.length}  kinds=${JSON.stringify(kinds)}`);
  log(`PDF 页树 /Count = ${pageTree.root} → ${
    pageTree.root === null ? '明文扫描未取到（可能在对象流中）'
    : pageTree.root === items.length ? '与渲染页数一致' : '与渲染页数不一致！'}`);

  await doc.cleanup();
  if (pageTree.root !== null && pageTree.root !== items.length) {
    throw new Error(`页数不一致：页树 /Count=${pageTree.root}，渲染 ${items.length} 页`);
  }
}

function r6(x) { return Math.round(x * 1e6) / 1e6; }

/** pdfjs 要求 factory url 以 / 结尾；Windows 反斜杠会触发校验失败，统一换正斜杠。 */
function toFsUrl(p) { return p.replace(/\\/g, '/') + '/'; }

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => {
  console.error(`[manual-pages] 失败：${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
