// 渲染 vs 实拍照片的数值对账模块（Node 侧，不进 viewer bundle）。
// - createRenderSession：整个对账过程只启动一次浏览器，每张截图复用同一页面（每次写新临时文件保证完整导航）
// - 实拍照片前景掩膜：从四条边 flood-fill 背景（Lab 色差容差 18→48，边界吸收饱和即停），取反为前景
// - 说明书页（kind:'manual'）：官方渲染图，一等支持——三条路径按数据判定，返回值用 maskPath 区分：
//   ① near-white-flood：四条边近白占比 ≥ MANUAL_BORDER_OK 的白底页（泛洪后同样剥 UI 杂质）
//   ② uniform-bg-flood：统一页底（浅蓝 #D4EDFC、浅紫、白底封面等）——背景基准取四边像素颜色众数，
//      并把同族淡色背板 / 中性满版色带并入基准做多基准 4 邻域泛洪去背，
//      再剥离空心框线 / 平涂面板 / 高彩度 callout 框 / 分栏竖线 / 页码 / 指引线 / 微噪点
//   ③ photo-sweep-fallback：以上都不成立（页边被满版彩图打乱、边框一致度 < 0.60），退回实拍容差扫描
//   三条路径都跳过椭圆保底与 degraded 降权，因此掩膜可用于 diff 打分；
//   返回值统一带 maskPath / bg / borderUniformity 三个诊断字段（旧实现靠 whiteFallback 区分不通）
//   + yaw 择优基础上叠加 elevation 扫描（MANUAL_EL 默认 5..40 步 5，runDiff opts.manualEl 可覆盖），报告条目 source:'manual'
// - scorePair：轮廓 IoU / 掩膜包围盒长宽比相似度 / 掩膜内 RGB 4×4×4 直方图余弦 / 16×16 色块结构相似度
// - runDiff 三模式：joint（默认，联合标定：粗扫描全局 yaw 偏移后统一姿态打分，抑制逐照片择优虚高）|
//   sweep（旧逐照片 ±20° 方位角 + 4 向滚转择优，沿用旧总分公式）| fixed（仅清单姿态 + 4 向滚转，批量变体筛选）
// - calibratePhoto：低分辨率方位角/俯仰角扫描
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MASK_HEIGHT = 512;   // 对账统一工作高度（等比缩放）
const TOL_FROM = 18, TOL_TO = 48, TOL_STEP = 2; // Lab 色差容差：从 18 起、最宽放宽到 48
const BORDER_OK = 0.97;    // 边界像素被吸收为背景的比例达到该值才算“背景基准成立”
const BG_MAX = 0.92;       // 背景占比上限：超过说明前景（模型）被背景吞掉了
const BORDER_FLOOR = 0.85; // 边界吸收低于该值 → flood-fill 基准不可信，退回椭圆窗保底
// ---- 说明书页（kind:'manual'，白底/彩色统一底官方渲染图）常量，可调 ----
const MANUAL_BG_MIN_L = 95;    // 近白判据：Lab 明度下限（255 白=100、#F4F4F4≈95.8、232 灰≈92 → 灰背景落选，退回照片管线）
const MANUAL_BG_MAX_AB = 4;    // 近白判据：|a|、|b| 彩度上限（白/米白页底算近白；有彩色零件都不算）
const MANUAL_BORDER_OK = 0.95; // 四条边近白占比达到该值才接受“白底假设”，否则退回实拍 flood-fill 管线
const MANUAL_UNIFORM_MIN = 0.60; // 边框一致度（与 bg 色差 ΔE<10 的边框像素占比）超过它才认定“彩色统一页底”
const MANUAL_UNIFORM_DE = 10;    // “同色”判据的 Lab 欧氏色差上限（一致度统计与泛洪同口径，避免两套阈值打架）
const BG_BUCKET_SHIFT = 4;       // 背景众数统计的 RGB 量化桶：每通道右移 4 位（16 级），抗 JPEG/抗锯齿抖动
const MANUAL_PALETTE_SHIFT = 3;  // 面板/背板识别用的细量化桶：每通道右移 3 位（32 级），比背景众数桶更细
// ---- 说明书页 UI 杂质剥离阈值（全部按页面积/包围盒归一，不含任何硬编码底色作主判据）----
const MANUAL_FRAME_HOLE = 0.25;   // 空心框：包围盒内“被框住的页底”占比下限
const MANUAL_FRAME_BAND = 0.35;   // 空心框：组件像素落在包围盒 4px 边带上的占比下限（把稀疏模型与框线分开）
const MANUAL_PANEL_FILL = 0.85;   // 平涂面板：包围盒填充率下限（近实心矩形）
const MANUAL_PANEL_DOM = 0.55;    // 平涂面板：众数色占组件比例下限（强平涂）
const MANUAL_PANEL_DOM_PALE = 0.30;  // 淡色背板：众数色占比下限（背板上画着零件图，众数比例天然偏低）
const MANUAL_PANEL_MIN_AREA = 0.002; // 平涂面板：最小面积占比
const MANUAL_BACKDROP_MIN_AREA = 0.04;    // 淡色背板：该色总像素占页面积下限
const MANUAL_BACKDROP_MIN_BBOX = 0.12;    // 淡色背板：最大连通块包围盒占页面积下限（只吸收“整块示意面板”级别）
const MANUAL_BACKDROP_MIN_FILL = 0.25;    // 淡色背板：包围盒填充率下限（背板上画着零件，不会很实心）
const MANUAL_NEUTRAL_SPAN_W = 0.85;       // 中性满版色带（封面插画的天/地面）：该色横跨页宽比例下限
const MANUAL_NEUTRAL_MIN_FILL = 0.45;     // 中性满版色带：包围盒填充率下限（平涂色带，不是零散灰）
const MANUAL_NEUTRAL_MIN_AREA = 0.08;     // 中性满版色带：占页面积下限
const MANUAL_NEUTRAL_MAX_CHROMA = 8;      // 中性满版色带：彩度上限（有彩色大块按淡色背板规则处理）
const MANUAL_NEUTRAL_MAX_SET = 2;         // 中性满版色带：最多吸收几种（天空 + 地面）
const MANUAL_PANEL_PALE_L = 78;   // 淡色背板：明度下限（深色零件不可能是背板）
const MANUAL_BACKDROP_MAX_DE = 26; // 淡色背板：与页底的色差上限（再远就不是“同族淡色”了）
const MANUAL_BACKDROP_MAX_SET = 4; // 淡色背板：最多吸收几种基准色（防止把模型色也当背景）
const MANUAL_PANEL_CHROMA_SLACK = 14; // 淡色背板：彩度上限 = 页底彩度 + 该松弛量
const MANUAL_PANEL_HUE_DEG = 25;  // 淡色背板：与页底色相夹角上限（度）
const MANUAL_PANEL_ACCENT_L = 70, MANUAL_PANEL_ACCENT_C = 50; // 高彩度 UI 框（亮黄 callout 底）判据
const MANUAL_PANEL_LIGHT_L = 88, MANUAL_PANEL_LIGHT_C = 30;   // 浅色 UI 面板（米白清单框）判据
const MANUAL_MODAL_DE = 6;        // 擦面板底色时的色差上限：只擦平涂底色，画在其上的零件像素保留
const MANUAL_CALLOUT_FILL = 0.55;  // 高彩度 callout 框：框底 + 放大零件图的整体填充率下限
const MANUAL_CALLOUT_DOM = 0.45;   // 高彩度 callout 框：框底色占组件比例下限
const MANUAL_CALLOUT_MIN_BBOX = 0.02; // 高彩度 callout 框：包围盒占页面积下限
const MANUAL_CALLOUT_L = 65;       // 高彩度 callout 框：框底明度下限（暗红/深蓝零件不在此列）
const MANUAL_CALLOUT_C = 45;       // 高彩度 callout 框：框底彩度下限（亮黄 #FFCC01 / 亮品红）
const MANUAL_FOOTER_BAND = 0.88, MANUAL_FOOTER_MAX = 0.005, MANUAL_SPECK_MAX = 0.00015; // 页码/噪点
const MANUAL_DIVIDER_COV = 0.88;  // 分栏竖线：该列的纵向前景覆盖率下限
export const MANUAL_EL_FROM = 5, MANUAL_EL_TO = 40, MANUAL_EL_STEP = 5; // manual elevation 扫描默认范围（opts.manualEls 可覆盖）

let sharpPromise = null;
async function loadSharp() {
  if (!sharpPromise) sharpPromise = import('sharp').then((m) => m.default).catch((e) => { throw new Error(`照片对账需要 sharp：npm i sharp（${e.message}）`); });
  return sharpPromise;
}

function range(from, to, step) {   // [from..to] 含端点的等差数组（角度扫描共用）
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

// ------------------------------------------------------------------ 渲染会话
// dist/viewer.html 注入模型（同 cli/brickkit.mjs 的 embed 思路）
// baked = buildModelGeometries 的产物，传入即启用 LDraw 真实几何——对账必须用它：
// 参数化方盒的轮廓与实拍对不上，会系统性压低 IoU。
function embed(model, baked) {
  const html = fs.readFileSync(path.join(ROOT, 'dist/viewer.html'), 'utf8');
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  const geomTag = baked ? `<script>window.__LDRAW_GEOM__=${JSON.stringify(baked).replace(/</g, '\\u003c')}</script>` : '';
  return html.replace('<!--MODEL-->', () => `<script>window.__BRICK_MODEL__=${data}</script>${geomTag}`);
}

const CHROMIUM_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function resolveChromium(chromium) {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const found = CHROMIUM_CANDIDATES.find((p) => fs.existsSync(p));
  if (found) return found;
  try {   // playwright 自带 chromium：仅当可执行文件真实存在时才用
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return undefined;
}

/** 启动一次浏览器，返回 { shot(params), close() }。
 *  baked 传入即用 LDraw 真实几何（默认对账口径）；不传则退回参数化几何。
 *  shot 参数：{ az, el, w, h, ortho }，返回渲染 PNG Buffer（透明背景）。 */
export async function createRenderSession(model, baked) {
  const { chromium } = await import('playwright');
  const html = embed(model, baked);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickkit-diff-'));
  const browser = await chromium.launch({
    executablePath: resolveChromium(chromium),
    env: { ...process.env },
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  // 只写一份临时文件：参数走 query（每次导航到不同 URL 才会整页重新初始化；
  // 若只改 hash 查看器不会重读机位参数）
  const file = path.join(tmpDir, 'v.html');
  fs.writeFileSync(file, html);
  const fileUrl = 'file://' + file.replace(/\\/g, '/');
  return {
    async shot(params = {}) {
      const { az = 0, el = 5, w = 640, h = 640, ortho = true } = params;
      const q = new URLSearchParams({ shot: '1', az: String(az), el: String(el), w: String(w), h: String(h) });
      if (ortho) q.set('ortho', '1');
      errs.length = 0;
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${fileUrl}?${q}`);
      await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 60000 });
      const buf = await page.locator('#c').screenshot({ omitBackground: true });
      if (errs.length) throw new Error('渲染页面报错：' + errs.join('\n'));
      return buf;
    },
    async close() {
      await browser.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ 掩膜提取
// 等比缩放到目标高度后解出 RGBA
async function decodeRGBA(buf, height) {
  const sharp = await loadSharp();
  const meta = await sharp(buf).metadata();
  const w = Math.max(1, Math.round((meta.width / meta.height) * height));
  const { data, info } = await sharp(buf).resize(w, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// sRGB → CIELAB（D65）。不用 sharp 的 lab 色彩空间：其 8-bit raw 会把负 a/b 截断为 0
// （纯色探针实测：青 Lab(91,-48,-14) 得 [91,0,0]、绿 a=-86 得 0、蓝 b=-108 得 0），
// 绿/蓝系前景会与背景“同色”导致 flood-fill 把整个前景吞进背景。
const srgbToLin = (c8) => { const c = c8 / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const labF = (t) => (t > 0.008856451679035631 ? Math.cbrt(t) : (903.2962962 * t + 16) / 116);
/** RGBA 原始字节 → Float64Array 的 CIELAB（L=0..100，a/b 为真实有符号值，步长 3） */
export function rgbaToLab(rgba, n) {
  const lab = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = srgbToLin(rgba[i * 4]), g = srgbToLin(rgba[i * 4 + 1]), b = srgbToLin(rgba[i * 4 + 2]);
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    const fx = labF(x), fy = labF(y), fz = labF(z);
    lab[i * 3] = 116 * fy - 16;
    lab[i * 3 + 1] = 500 * (fx - fy);
    lab[i * 3 + 2] = 200 * (fy - fz);
  }
  return lab;
}

/** 从四条边 flood-fill 背景：与背景基准色（四条边像素的逐通道中位数）Lab 色差 ≤ tol 即并入背景。
 *  基准取中位数对个别贴边的前景鲁棒；对基准而非对邻居比较，避免渐变背景逐像素漂移渗透。返回 Uint8Array（1 = 背景）。 */
export function floodFillBackground(lab, w, h, tol) {
  const n = w * h, bg = new Uint8Array(n), queue = new Int32Array(n), t2 = tol * tol;
  const ls = [], as = [], bs = [];
  const collect = (i) => { ls.push(lab[i * 3]); as.push(lab[i * 3 + 1]); bs.push(lab[i * 3 + 2]); };
  for (let x = 0; x < w; x++) { collect(x); collect((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { collect(y * w); collect(y * w + w - 1); }
  const med = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
  const refL = med(ls), refA = med(as), refB = med(bs);
  let qh = 0, qt = 0;
  const join = (i) => {
    if (bg[i]) return;
    const dl = lab[i * 3] - refL, da = lab[i * 3 + 1] - refA, db = lab[i * 3 + 2] - refB;
    if (dl * dl + da * da + db * db <= t2) { bg[i] = 1; queue[qt++] = i; }
  };
  for (let x = 0; x < w; x++) { join(x); join((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { join(y * w); join(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++], x = i % w;
    if (x > 0) join(i - 1);
    if (x < w - 1) join(i + 1);
    if (i >= w) join(i - w);
    if (i + w < n) join(i + w);
  }
  return bg;
}

function borderBackgroundRatio(bg, w, h) {   // 边界吸收比例：四条边上被判为背景的像素占比
  let hit = 0, total = 2 * w + 2 * (h - 2);
  for (let x = 0; x < w; x++) { hit += bg[x]; hit += bg[(h - 1) * w + x]; }
  for (let y = 1; y < h - 1; y++) { hit += bg[y * w]; hit += bg[y * w + w - 1]; }
  return hit / total;
}

function ellipseMask(w, h) {   // 中心椭圆窗（半轴 42%）：flood-fill 失效时的保底掩膜
  const m = new Uint8Array(w * h), cx = (w - 1) / 2, cy = (h - 1) / 2, rx = 0.42 * w, ry = 0.42 * h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    if (dx * dx + dy * dy <= 1) m[y * w + x] = 1;
  }
  return m;
}

/** 实拍照片前景掩膜：四边 flood-fill，容差 18→48 逐级放宽。
 *  采纳判据：边界吸收比例 ≥ BORDER_OK（背景基准成立）且背景占比 ≤ BG_MAX（未吞掉模型）；
 *  边界已饱和但背景仍吞超上限（容差再放宽只会更糟）或全程达不到 BORDER_FLOOR 时，
 *  判定 flood-fill 不可信，退回中心椭圆窗并标 degraded:true。 */
export async function extractPhotoMask(photoBuf, { height = MASK_HEIGHT } = {}) {
  const { data: rgba, w, h } = await decodeRGBA(photoBuf, height);
  const lab = rgbaToLab(rgba, w * h);
  const n = w * h;
  const { accepted, best } = sweepTolerances(lab, w, h);
  const use = accepted ?? best;
  const hopeless = best.border < BORDER_FLOOR || best.bgRatio > BG_MAX;
  const mask = new Uint8Array(n);
  if (hopeless) return { mask: ellipseMask(w, h), rgba, w, h, tol: use.tol, bgRatio: use.bgRatio, maskConfidence: use.border, degraded: true };
  for (let i = 0; i < n; i++) mask[i] = use.bg[i] ? 0 : 1;
  return { mask, rgba, w, h, tol: use.tol, bgRatio: use.bgRatio, maskConfidence: use.border, degraded: !accepted };
}

/** 容差扫描共用逻辑（extractPhotoMask 与 manual 兜底都走它）：tol 从 TOL_FROM 放宽到 TOL_TO，
 *  返回 accepted（首个满足 BORDER_OK 且未吞模型的容差结果）与 best（边界吸收最高的结果）。 */
function sweepTolerances(lab, w, h) {
  const n = w * h;
  let accepted = null, best = null;
  for (let tol = TOL_FROM; tol <= TOL_TO; tol += TOL_STEP) {
    const bg = floodFillBackground(lab, w, h, tol);
    let count = 0;
    for (let i = 0; i < n; i++) count += bg[i];
    const bgRatio = count / n;
    const border = borderBackgroundRatio(bg, w, h);
    if (!best || border > best.border) best = { bg, tol, bgRatio, border };
    if (border >= BORDER_OK) {
      if (bgRatio <= BG_MAX) accepted = { bg, tol, bgRatio, border };
      break;   // bgRatio 随容差单调不降：边界已饱和时继续放宽只会吞更多
    }
  }
  return { accepted, best };
}

/** 近白像素判定图：L ≥ MANUAL_BG_MIN_L 且 |a|、|b| ≤ MANUAL_BG_MAX_AB。
 *  255 纯白 L=100，#F4F4F4 L≈95.8 都在内；灰 232 背景 L≈92 落选（灰底是照片，不是说明书页）。 */
export function nearWhiteMap(lab, n) {
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (lab[i * 3] >= MANUAL_BG_MIN_L && Math.abs(lab[i * 3 + 1]) <= MANUAL_BG_MAX_AB && Math.abs(lab[i * 3 + 2]) <= MANUAL_BG_MAX_AB) m[i] = 1;
  }
  return m;
}

/** 从四条边出发、只穿过近白像素做 4 连通洪泛 → 背景图（1 = 背景）。
 *  页底与连通到边界的近白算背景；模型内部孤立的近白（白色零件）不与边界连通，保留为前景。 */
export function floodFillNearWhite(white, w, h) {
  const n = w * h, bg = new Uint8Array(n), queue = new Int32Array(n);
  let qh = 0, qt = 0, count = 0;
  const join = (i) => {
    if (bg[i] || !white[i]) return;
    bg[i] = 1; count++; queue[qt++] = i;
  };
  for (let x = 0; x < w; x++) { join(x); join((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { join(y * w); join(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++], x = i % w;
    if (x > 0) join(i - 1);
    if (x < w - 1) join(i + 1);
    if (i >= w) join(i - w);
    if (i + w < n) join(i + w);
  }
  return { bg, count };
}

/** 说明书页背景基准自适应估计：统计四条边框像素的 RGB 众数（每通道量化 16 级分桶抗抖动），
 *  桶内取实际像素均值得到 bg，再算边框一致度 borderUniformity =（与 bg 的 Lab 色差 < MANUAL_UNIFORM_DE
 *  的边框像素占比）。取代旧实现的「单像素 (5,5) 当基准 + 硬编码 RGB 阈值」——旧法遇到封面满版彩图
 *  或页脚色条会把某个角落的颜色当成整页底色。
 *  返回 { r, g, b, L, a, b, uniformity }（Lab 字段与 srgb 同名冲突时用 l/a/b 之外的命名见实现）。 */
export function estimateManualBackground(rgba, lab, w, h) {
  const buckets = new Map();   // 量化键 → 像素计数
  const border = [];
  const push = (i) => border.push(i);
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { push(y * w); push(y * w + w - 1); }
  const key = (i) => ((rgba[i * 4] >> BG_BUCKET_SHIFT) << 8) | ((rgba[i * 4 + 1] >> BG_BUCKET_SHIFT) << 4) | (rgba[i * 4 + 2] >> BG_BUCKET_SHIFT);
  for (const i of border) buckets.set(key(i), (buckets.get(key(i)) || 0) + 1);
  let modeKey = -1, modeCount = -1;
  for (const [k, c] of buckets) if (c > modeCount || (c === modeCount && k < modeKey)) { modeKey = k; modeCount = c; }
  // 众数桶内取实际 RGB 均值（桶宽 16，均值比桶中心更贴近真实底色）
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (const i of border) {
    if (key(i) !== modeKey) continue;
    sr += rgba[i * 4]; sg += rgba[i * 4 + 1]; sb += rgba[i * 4 + 2]; cnt++;
  }
  const r = Math.round(sr / Math.max(1, cnt)), g = Math.round(sg / Math.max(1, cnt)), b = Math.round(sb / Math.max(1, cnt));
  const bgLab = rgbaToLab(new Uint8Array([r, g, b, 255]), 1);
  const t2 = MANUAL_UNIFORM_DE * MANUAL_UNIFORM_DE;
  let uni = 0;
  for (const i of border) {
    const dl = lab[i * 3] - bgLab[0], da = lab[i * 3 + 1] - bgLab[1], db = lab[i * 3 + 2] - bgLab[2];
    if (dl * dl + da * da + db * db <= t2) uni++;
  }
  return {
    r, g, b, L: bgLab[0], a: bgLab[1], bb: bgLab[2],
    uniformity: border.length ? uni / border.length : 0,
  };
}

/** 以给定背景 Lab 为基准、从四条边做 4 邻域泛洪（色差 ≤ de 即并入背景）；返回 { bg, count }。
 *  与 floodFillBackground 的区别：基准来自 estimateManualBackground 的众数（不是逐通道中位数），
 *  且只在 4 邻域内传播，页内同色的孤立块（例如与页底同色的零件高光）不会被误判为背景。 */
export function floodFillUniformBg(lab, w, h, bg, de = MANUAL_UNIFORM_DE) {
  const n = w * h, out = new Uint8Array(n), queue = new Int32Array(n), t2 = de * de;
  let qh = 0, qt = 0, count = 0;
  const join = (i) => {
    if (out[i]) return;
    const dl = lab[i * 3] - bg.L, da = lab[i * 3 + 1] - bg.a, db = lab[i * 3 + 2] - bg.bb;
    if (dl * dl + da * da + db * db > t2) return;
    out[i] = 1; count++; queue[qt++] = i;
  };
  for (let x = 0; x < w; x++) { join(x); join((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { join(y * w); join(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++], x = i % w;
    if (x > 0) join(i - 1);
    if (x < w - 1) join(i + 1);
    if (i >= w) join(i - w);
    if (i + w < n) join(i + w);
  }
  return { bg: out, count };
}

// ------------------------------------------------------------------ 说明书页 UI 杂质剥离
/** 4 邻域连通分量（限定在 mask 为 1 的像素上），返回 [{ pixels, size, minX, minY, maxX, maxY }] 按大小降序。 */
function maskComponents(mask, w, h) {
  const n = w * h, vis = new Uint8Array(n), queue = new Int32Array(n), out = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i] || vis[i]) continue;
    let qh = 0, qt = 0;
    queue[qt++] = i; vis[i] = 1;
    let minX = i % w, maxX = minX, minY = (i / w) | 0, maxY = minY;
    while (qh < qt) {
      const cur = queue[qh++], cx = cur % w, cy = (cur / w) | 0;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      if (cx > 0 && mask[cur - 1] && !vis[cur - 1]) { vis[cur - 1] = 1; queue[qt++] = cur - 1; }
      if (cx < w - 1 && mask[cur + 1] && !vis[cur + 1]) { vis[cur + 1] = 1; queue[qt++] = cur + 1; }
      if (cy > 0 && mask[cur - w] && !vis[cur - w]) { vis[cur - w] = 1; queue[qt++] = cur - w; }
      if (cy < h - 1 && mask[cur + w] && !vis[cur + w]) { vis[cur + w] = 1; queue[qt++] = cur + w; }
    }
    out.push({ pixels: queue.slice(0, qt), size: qt, minX, minY, maxX, maxY });
  }
  return out.sort((a, b) => b.size - a.size);
}

/** 组件内像素的颜色众数（每通道量化 16 级）+ 其 Lab。用于判定“整块平涂的框底色”。
 *  返回 frac（众数桶占组件比例）、分量实际均值色 rgb 与 Lab（比桶中心更贴近真实底色）。 */
function dominantLab(rgba, pixels) {
  const hist = new Map();
  for (const p of pixels) {
    const k = ((rgba[p * 4] >> 4) << 8) | ((rgba[p * 4 + 1] >> 4) << 4) | (rgba[p * 4 + 2] >> 4);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let bestK = 0, bestC = -1;
  for (const [k, c] of hist) if (c > bestC) { bestC = c; bestK = k; }
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (const p of pixels) {
    const k = ((rgba[p * 4] >> 4) << 8) | ((rgba[p * 4 + 1] >> 4) << 4) | (rgba[p * 4 + 2] >> 4);
    if (k !== bestK) continue;
    sr += rgba[p * 4]; sg += rgba[p * 4 + 1]; sb += rgba[p * 4 + 2]; cnt++;
  }
  const r = Math.round(sr / Math.max(1, cnt)), g = Math.round(sg / Math.max(1, cnt)), b = Math.round(sb / Math.max(1, cnt));
  const lab = rgbaToLab(new Uint8Array([r, g, b, 255]), 1);
  return { frac: bestC / Math.max(1, pixels.length), r, g, b, L: lab[0], a: lab[1], bb: lab[2], chroma: Math.hypot(lab[1], lab[2]) };
}

/** 背景色判定（与 bg 的 Lab 色差 ≤ de）。说明书页的“页底像素”统一用它，避免 RGB 阈值各写一套。 */
function makeBgTest(lab, bg, de) {
  const t2 = de * de;
  return (i) => {
    const dl = lab[i * 3] - bg.L, da = lab[i * 3 + 1] - bg.a, db = lab[i * 3 + 2] - bg.bb;
    return dl * dl + da * da + db * db <= t2;
  };
}

/** 2π 圆周上的最小夹角（弧度）。用于把“色相相近”与“色相差很远”区分开。 */
function hueDelta(a1, a2) {
  let d = Math.abs(a1 - a2) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/** 淡色背板识别：说明书里“浅蓝/浅紫的步骤示意图底”常常和页底同色族、只差一点明度与彩度。
 *  机械页底泛洪（MANUAL_UNIFORM_DE=10）吞不掉它们，于是整块示意图底被当成前景，前景占比飙到 0.6~0.8。
 *  这里按 32 级量化桶找出「占据大块包围盒 + 与页底同色相、更淡」的大面积平涂色，
 *  作为**额外的背景基准色族**交给多基准泛洪吸收（不是直接擦像素——背板上画着的零件图仍需保留）。
 *  注意不用“矩形度”当门槛：背板上必然画着零件，桶内最大连通块不会接近实心矩形，
 *  改为要求该连通块的**包围盒**够大（≥ MANUAL_BACKDROP_MIN_BBOX 页面积），这样小的 BOM 清单框
 *  （约占页 3%）不会被误吸收——它们另有平涂面板规则整块处理。
 *  返回 [{ r, g, b, L, a, bb, area }]，按面积降序；空数组表示本页没有这类背板。 */
export function detectManualBackdrops(rgba, lab, w, h, bgInfo) {
  const n = w * h;
  if (n === 0) return [];
  const bgChroma = Math.hypot(bgInfo.a, bgInfo.bb);
  const bgHue = Math.atan2(bgInfo.bb, bgInfo.a);
  const hist = new Map();   // 量化键 → 像素数
  for (let i = 0; i < n; i++) {
    const k = ((rgba[i * 4] >> MANUAL_PALETTE_SHIFT) << 10) | ((rgba[i * 4 + 1] >> MANUAL_PALETTE_SHIFT) << 5) | (rgba[i * 4 + 2] >> MANUAL_PALETTE_SHIFT);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const out = [];
  for (const [k, tot] of hist) {
    if (tot < n * MANUAL_BACKDROP_MIN_AREA) continue;
    const pred = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const ki = ((rgba[i * 4] >> MANUAL_PALETTE_SHIFT) << 10) | ((rgba[i * 4 + 1] >> MANUAL_PALETTE_SHIFT) << 5) | (rgba[i * 4 + 2] >> MANUAL_PALETTE_SHIFT);
      pred[i] = ki === k ? 1 : 0;
    }
    const big = maskComponents(pred, w, h)[0];
    if (!big || big.size < n * MANUAL_BACKDROP_MIN_AREA) continue;
    const bw = big.maxX - big.minX + 1, bh = big.maxY - big.minY + 1;
    const bboxArea = (bw * bh) / n;
    if (bboxArea < MANUAL_BACKDROP_MIN_BBOX) continue;   // 只吸收“整块示意面板”级别的大色块
    if (big.size / (bw * bh) < MANUAL_BACKDROP_MIN_FILL) continue; // 稀疏零散的同色像素不是平涂背板
    if (bw < w * 0.15 || bh < h * 0.10) continue;
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    for (let i = 0; i < n; i++) if (pred[i]) { sr += rgba[i * 4]; sg += rgba[i * 4 + 1]; sb += rgba[i * 4 + 2]; cnt++; }
    const r = Math.round(sr / cnt), g = Math.round(sg / cnt), b = Math.round(sb / cnt);
    const cLab = rgbaToLab(new Uint8Array([r, g, b, 255]), 1);
    const chroma = Math.hypot(cLab[1], cLab[2]);
    const de = Math.hypot(cLab[0] - bgInfo.L, cLab[1] - bgInfo.a, cLab[2] - bgInfo.bb);
    // 与页底太近 → 主泛洪已覆盖；差太远 → 是模型/UI 面板而不是同族淡色背板
    if (de <= MANUAL_UNIFORM_DE || de > MANUAL_BACKDROP_MAX_DE) continue;
    if (cLab[0] < MANUAL_PANEL_PALE_L) continue;                                   // 深色块不是背板
    if (chroma > bgChroma + MANUAL_PANEL_CHROMA_SLACK) continue;                    // 比页底更艳 → 是彩色零件/亮黄框
    if (chroma < 3) continue;                                                       // 中性白/灰 → 交给 near-white 或面板规则
    if (hueDelta(Math.atan2(cLab[2], cLab[1]), bgHue) > MANUAL_PANEL_HUE_DEG * Math.PI / 180) continue;
    out.push({ r, g, b, L: cLab[0], a: cLab[1], bb: cLab[2], area: big.size });
  }
  out.sort((a, b) => b.area - a.area);
  return out.slice(0, MANUAL_BACKDROP_MAX_SET);
}

/** 中性满版色带识别（封面插画的天空/地面这类大面积平涂中性色）：横跨页宽 + 够平涂 + 中性 + 面积够大，
 *  就当作额外背景基准吸收。与淡色背板分开写：淡色背板要求“与页底同色相”，封面色带本来就不同色相，
 *  但它是插画背景而不是零件，混进掩膜会把封面轮廓撑满整页（实测 fg 涨到 0.66~0.88）。
 *  只吸收中性色（彩度 ≤ MANUAL_NEUTRAL_MAX_CHROMA）：彩色大块可能真是模型，交给淡色背板/面板规则。
 *  返回 [{ r, g, b, L, a, bb, area }]，面积降序。 */
export function detectManualNeutralBands(rgba, lab, w, h, bgInfo) {
  const n = w * h;
  if (n === 0) return [];
  const hist = new Map();
  for (let i = 0; i < n; i++) {
    const k = ((rgba[i * 4] >> MANUAL_PALETTE_SHIFT) << 10) | ((rgba[i * 4 + 1] >> MANUAL_PALETTE_SHIFT) << 5) | (rgba[i * 4 + 2] >> MANUAL_PALETTE_SHIFT);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const out = [];
  for (const [k, tot] of hist) {
    if (tot < n * MANUAL_NEUTRAL_MIN_AREA) continue;
    const pred = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const ki = ((rgba[i * 4] >> MANUAL_PALETTE_SHIFT) << 10) | ((rgba[i * 4 + 1] >> MANUAL_PALETTE_SHIFT) << 5) | (rgba[i * 4 + 2] >> MANUAL_PALETTE_SHIFT);
      pred[i] = ki === k ? 1 : 0;
    }
    const big = maskComponents(pred, w, h)[0];
    if (!big || big.size < n * MANUAL_NEUTRAL_MIN_AREA) continue;
    const bw = big.maxX - big.minX + 1, bh = big.maxY - big.minY + 1;
    if (bw / w < MANUAL_NEUTRAL_SPAN_W) continue;                     // 必须横跨页宽
    if (big.size / (bw * bh) < MANUAL_NEUTRAL_MIN_FILL) continue;      // 必须够平涂
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    for (let i = 0; i < n; i++) if (pred[i]) { sr += rgba[i * 4]; sg += rgba[i * 4 + 1]; sb += rgba[i * 4 + 2]; cnt++; }
    const r = Math.round(sr / cnt), g = Math.round(sg / cnt), b = Math.round(sb / cnt);
    const cLab = rgbaToLab(new Uint8Array([r, g, b, 255]), 1);
    if (Math.hypot(cLab[1], cLab[2]) > MANUAL_NEUTRAL_MAX_CHROMA) continue;   // 有彩色大块不算背景带
    const de = Math.hypot(cLab[0] - bgInfo.L, cLab[1] - bgInfo.a, cLab[2] - bgInfo.bb);
    if (de <= MANUAL_UNIFORM_DE) continue;                                    // 与页底同色 → 主泛洪已覆盖
    out.push({ r, g, b, L: cLab[0], a: cLab[1], bb: cLab[2], area: big.size });
  }
  out.sort((a, b) => b.area - a.area);
  return out.slice(0, MANUAL_NEUTRAL_MAX_SET);
}

/** 多基准 4 邻域泛洪：任一基准色（页底 + 淡色背板）色差 ≤ de 即并入背景。
 *  背板由此被吸收，但画在背板上的零件（与背板色差大）仍留在前景。返回 { bg, count }。 */
export function floodFillMultiBg(lab, w, h, colors, de = MANUAL_UNIFORM_DE) {
  const n = w * h, out = new Uint8Array(n), queue = new Int32Array(n), t2 = de * de;
  const sets = colors.map((c) => [c.L, c.a, c.bb]);
  const match = (i) => {
    const p = i * 3, L = lab[p], A = lab[p + 1], B = lab[p + 2];
    for (const s of sets) {
      const dl = L - s[0], da = A - s[1], db = B - s[2];
      if (dl * dl + da * da + db * db <= t2) return true;
    }
    return false;
  };
  let qh = 0, qt = 0, count = 0;
  const join = (i) => { if (out[i] || !match(i)) return; out[i] = 1; count++; queue[qt++] = i; };
  for (let x = 0; x < w; x++) { join(x); join((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { join(y * w); join(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++], x = i % w;
    if (x > 0) join(i - 1);
    if (x < w - 1) join(i + 1);
    if (i >= w) join(i - w);
    if (i + w < n) join(i + w);
  }
  return { bg: out, count };
}

/** 说明书页 UI 杂质剥离，全部判据按页面积/包围盒归一（没有“BOM 蓝=某 RGB”这类硬编码主判据）：
 *  - 细指引线：宽度 ≤ 2·THIN_PROBE 的竖直/水平细条（两侧都是背景）。必须先做——否则一条指引线会把
 *    一侧的 BOM 框“桥”到中间模型上，连成一个整体包围盒，后续所有形状判据全部失真；
 *  - 分栏竖线：某列纵向前景覆盖率 ≥ MANUAL_DIVIDER_COV 且左右 3 列基本干净 → 清左侧更早的示意；
 *  - 空心框：包围盒内“被框住页底”≥ MANUAL_FRAME_HOLE **且**像素聚集在包围盒 4px 边带上
 *    （≥ MANUAL_FRAME_BAND）→ 只擦框线本身，框内零件图另有独立连通块，保留；
 *  - 平涂面板：填充率 ≥ MANUAL_PANEL_FILL、众数色占比 ≥ MANUAL_PANEL_DOM、面积达标，且众数色属
 *    “UI 面板色”（浅色 L≥MANUAL_PANEL_LIGHT_L / 高彩度 C≥MANUAL_PANEL_ACCENT_C / 中明度有彩）——
 *    只擦**该面板底色像素**（色差 ≤ MANUAL_MODAL_DE），画在面板上的零件像素保留；
 *  - 页脚孤立小块（页码、指引碎片）与全图微噪点。
 *  待擦像素仍叠加“包围盒里该色够多（≥0.30 包围盒面积）”这一条，防止把整块模型误当面板。
 *  保守模式 conservative=true 跳过“清左栏”与“擦面板”，用于掩膜被擦空的兜底重试。
 *  返回 { mask, stats, dropped }，stats 逐项记录剥离像素数，不做静默删除。 */
function stripManualChrome(mask, rgba, lab, w, h, n, bg, { conservative = false } = {}) {
  const isBg = makeBgTest(lab, bg, MANUAL_UNIFORM_DE);
  const stats = { thinPx: 0, dividerPx: 0, framePx: 0, panelPx: 0, footerPx: 0, speckPx: 0, droppedPx: 0 };
  const dropped = [];   // 每个被判定为杂质的连通分量摘要（kind/bbox/size），供报告逐页复核

  // 0) 细指引线先剥（理由见函数头）
  const THIN_PROBE = 3;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(mask);
    for (let y = THIN_PROBE; y < h - THIN_PROBE; y++) {
      for (let x = THIN_PROBE; x < w - THIN_PROBE; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        let thin = false;
        for (let d = 1; d <= THIN_PROBE && !thin; d++) {
          if (!mask[i - d] && !mask[i + d]) thin = true;
          else if (!mask[i - d * w] && !mask[i + d * w]) thin = true;
        }
        if (thin) { next[i] = 0; stats.thinPx++; }
      }
    }
    mask.set(next);
  }

  // 1) 分栏竖线：纵向覆盖率 ≥ MANUAL_DIVIDER_COV 且左右各 3 列覆盖率低（细线而非宽面板）
  const colCov = (x) => { let c = 0; for (let y = 0; y < h; y++) if (mask[y * w + x]) c++; return c / h; };
  const cov = new Float64Array(w);
  for (let x = 0; x < w; x++) cov[x] = colCov(x);
  let divX = -1;
  for (let x = Math.max(3, Math.floor(w * 0.10)); x < Math.floor(w * 0.70); x++) {
    if (cov[x] < MANUAL_DIVIDER_COV) continue;
    const l = Math.max(cov[x - 1] ?? 0, cov[x - 2] ?? 0, cov[x - 3] ?? 0);
    const r = Math.max(cov[x + 1] ?? 0, cov[x + 2] ?? 0, cov[x + 3] ?? 0);
    if (l <= 0.15 || r <= 0.15) { divX = x; break; }
  }
  if (divX > 0 && !conservative) {
    for (let y = 0; y < h; y++) for (let x = 0; x <= Math.min(w - 1, divX + 4); x++) {
      if (mask[y * w + x]) { mask[y * w + x] = 0; stats.dividerPx++; }
    }
    dropped.push({ kind: 'divider', x: divX, px: stats.dividerPx });
  }

  // 2) 空心框 / 平涂面板
  const BAND = 4;
  for (const c of maskComponents(mask, w, h)) {
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    const area = bw * bh, fill = c.size / area;
    // 包围盒内既不是本组件、又是页底色的像素 = 被框住的空洞
    let holes = 0;
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        const i = y * w + x;
        if (!mask[i] && isBg(i)) holes++;
      }
    }
    const holeRatio = holes / area;
    let bandPx = 0;
    for (const p of c.pixels) {
      const x = p % w, y = (p / w) | 0;
      if (x - c.minX < BAND || c.maxX - x < BAND || y - c.minY < BAND || c.maxY - y < BAND) bandPx++;
    }
    const bandFrac = bandPx / c.size;
    // 空心框：被框住页底够多 + 像素集中在边带（稀疏模型不会同时满足这两条）
    if (holeRatio >= MANUAL_FRAME_HOLE && bandFrac >= MANUAL_FRAME_BAND) {
      for (const p of c.pixels) mask[p] = 0;
      stats.framePx += c.size;
      dropped.push({ kind: 'frame', size: c.size, bbox: [c.minX, c.minY, c.maxX, c.maxY] });
      continue;
    }
    if (conservative) continue;
    const dom = dominantLab(rgba, c.pixels);
    if (c.size < n * MANUAL_PANEL_MIN_AREA) continue;
    // 高彩度 callout 框（亮黄/亮品红底的“放大看这里”标注）先判：判据比通用面板松（框里还画着放大零件图，
    // 整体填充率与底色占比都被拉低）。整块擦除——那是 UI 标注而非模型视图，混进掩膜会系统性拉偏 IoU。
    const accentBox = dom.L >= MANUAL_CALLOUT_L && dom.chroma >= MANUAL_CALLOUT_C
      && fill >= MANUAL_CALLOUT_FILL && dom.frac >= MANUAL_CALLOUT_DOM && area >= n * MANUAL_CALLOUT_MIN_BBOX;
    if (accentBox) {
      let hit = 0;
      for (let y = c.minY; y <= c.maxY; y++) for (let x = c.minX; x <= c.maxX; x++) {
        const i = y * w + x;
        if (mask[i]) { mask[i] = 0; hit++; }
      }
      stats.panelPx += hit;
      dropped.push({ kind: 'callout', size: c.size, erased: hit, bbox: [c.minX, c.minY, c.maxX, c.maxY], rgb: [dom.r, dom.g, dom.b] });
      continue;
    }
    // 面板色分类：淡色（近白/浅灰蓝）/ 高彩度（亮黄 callout）/ 中明度有彩（浅蓝 BOM 底）
    const pale = dom.L >= MANUAL_PANEL_LIGHT_L && dom.chroma <= MANUAL_PANEL_LIGHT_C;
    const accent = dom.L >= MANUAL_PANEL_ACCENT_L && dom.chroma >= MANUAL_PANEL_ACCENT_C;
    const midTone = dom.L >= MANUAL_PANEL_LIGHT_L - 18 && dom.chroma >= 5;
    if (!pale && !accent && !midTone) continue;
    if (fill < MANUAL_PANEL_FILL) continue;
    // 该色在包围盒里的占比：面板底几乎铺满包围盒；模型内部某色只会零散出现
    const t2 = MANUAL_MODAL_DE * MANUAL_MODAL_DE;
    let domInBox = 0;
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        const i = y * w + x;
        const dl = lab[i * 3] - dom.L, da = lab[i * 3 + 1] - dom.a, db = lab[i * 3 + 2] - dom.bb;
        if (dl * dl + da * da + db * db <= t2) domInBox++;
      }
    }
    const fracNeeded = Math.min(MANUAL_PANEL_DOM_PALE, MANUAL_PANEL_DOM);
    if (dom.frac < fracNeeded || domInBox / area < 0.30) continue;
    // 只擦面板底色像素：面板上画的零件（与底色反差大）不在此列
    let hit = 0;
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const dl = lab[i * 3] - dom.L, da = lab[i * 3 + 1] - dom.a, db = lab[i * 3 + 2] - dom.bb;
        if (dl * dl + da * da + db * db <= t2) { mask[i] = 0; hit++; }
      }
    }
    stats.panelPx += hit;
    dropped.push({ kind: 'panel', size: c.size, erased: hit, bbox: [c.minX, c.minY, c.maxX, c.maxY], rgb: [dom.r, dom.g, dom.b] });
  }

  // 3) 底部孤立小块（页码 / 指引箭头碎片）与全图微噪点
  for (const c of maskComponents(mask, w, h)) {
    const inFooter = c.minY > h * MANUAL_FOOTER_BAND;
    const tiny = c.size < n * MANUAL_FOOTER_MAX;
    const speck = c.size < n * MANUAL_SPECK_MAX;
    if ((inFooter && tiny) || speck) {
      for (const p of c.pixels) mask[p] = 0;
      stats.footerPx += inFooter && tiny ? c.size : 0;
      stats.speckPx += speck ? c.size : 0;
      dropped.push({ kind: speck ? 'speck' : 'footer', size: c.size, bbox: [c.minX, c.minY, c.maxX, c.maxY] });
    }
  }
  // 微噪点可能把统计里的 dropped 列表撑爆（一页上百个 3px 点），报告只留前 12 条 + 汇总计数
  stats.droppedPx = stats.thinPx + stats.dividerPx + stats.framePx + stats.panelPx + stats.footerPx + stats.speckPx;
  return { mask, stats, dropped };
}

/** 某一行里为 1 的像素数 */
function solidRow(mask, w, y) {
  let c = 0;
  for (let x = 0; x < w; x++) c += mask[y * w + x];
  return c;
}

/** 彩色统一页底（浅蓝 #D4EDFC、浅紫等）说明书页：以四边众数色为基准、叠加同族淡色背板色一起做
 *  4 邻域泛洪去背，再剥离空心框线 / 平涂面板（BOM 蓝框、黄 callout 框）/ 分栏竖线 / 页码 / 微噪点，只保留零件图。
 *  判据全部来自本页像素统计（borderUniformity + bg 非近白），不含任何硬编码底色作主判据。
 *  返回 null 表示“不是彩色统一页底”，由调用方继续往下退。 */
function extractUniformBgManualMask(rgba, lab, w, h, bgInfo) {
  const n = w * h;
  if (w < 64 || h < 64) return null;
  if (bgInfo.uniformity < MANUAL_UNIFORM_MIN) return null;
  // bg 是近白也走本路（以前这里直接 return null 交给 ①，但 ① 的门槛是“四条边近白 ≥0.95”：
  // 白底封面页常有一条满版色带压住页边（实测 60239 封面一致度 0.908），于是 ① 不成立、
  // ② 又主动弃权，最终掉进 ③ 容差扫描，把满版彩图整片算成前景（fg 0.66）。
  // 现在改用“白底 + 多基准泛洪 + UI 剥离”：白零件靠“不与边界连通”保留，与 ① 同性质，且能剥掉色带/面板。
  // 同族淡色背板（步骤示意面板底）并入背景基准：否则整块面板底会被算成前景
  const backdrops = detectManualBackdrops(rgba, lab, w, h, bgInfo);
  // 中性满版色带（封面插画的天/地面）：满版彩图页上它是“背景”而不是零件
  const neutralBands = detectManualNeutralBands(rgba, lab, w, h, bgInfo);
  const bases = [{ L: bgInfo.L, a: bgInfo.a, bb: bgInfo.bb }, ...backdrops, ...neutralBands];
  const { bg: bgPix, count } = bases.length > 1
    ? floodFillMultiBg(lab, w, h, bases, MANUAL_UNIFORM_DE)
    : floodFillUniformBg(lab, w, h, bgInfo, MANUAL_UNIFORM_DE);
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = bgPix[i] ? 0 : 1;
  const rawFg = countFg(raw);
  // 泛洪把整页都吞进背景（bg 估错）或前景几乎占满（页底未被去背）→ 判失败，让调用方继续退
  if (rawFg < n * 0.002 || rawFg > n * 0.85) return null;
  const { mask, stats, dropped, mode } = stripManualChromeSafely(raw, rgba, lab, w, h, n, bgInfo);
  return {
    mask, rgba, w, h, bgRatio: 1 - countFg(mask) / n, count, chrome: stats, chromeMode: mode, chromeDropped: dropped.slice(0, 12),
    backdrops: backdrops.map((b) => ({ r: b.r, g: b.g, b: b.b })),
    neutralBands: neutralBands.map((b) => ({ r: b.r, g: b.g, b: b.b })),
    maskConfidence: bgInfo.uniformity, degraded: false, manual: true,
    maskPath: 'uniform-bg-flood',
    bg: { r: bgInfo.r, g: bgInfo.g, b: bgInfo.b },
    borderUniformity: bgInfo.uniformity,
  };
}

/** 掩膜前景像素数 */
function countFg(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) c += mask[i];
  return c;
}

/** 对已泛洪出的前景掩膜跑 UI 杂质剥离，带“擦空”兜底：标准模式擦得几乎为空时退回保守模式，
 *  仍为空则原样返回泛洪结果。三条说明书页路径共用（白底页也有 BOM 蓝框 / 黄 callout / 页码）。
 *  返回 { mask, stats, dropped, mode }。 */
function stripManualChromeSafely(rawMask, rgba, lab, w, h, n, bgInfo) {
  const rawFg = countFg(rawMask);
  let mask = new Uint8Array(rawMask);
  let { stats, dropped } = stripManualChrome(mask, rgba, lab, w, h, n, bgInfo);
  let fg = countFg(mask);
  let mode = 'standard';
  if (fg < n * 0.005) {
    mask = new Uint8Array(rawMask);
    ({ stats, dropped } = stripManualChrome(mask, rgba, lab, w, h, n, bgInfo, { conservative: true }));
    fg = countFg(mask);
    mode = 'conservative';
  }
  if (fg === 0) {   // 兜底：保守模式仍为空 → 直接用泛洪结果（不做任何剥离）
    mask = new Uint8Array(rawMask);
    fg = rawFg;
    mode = 'raw';
  }
  return { mask, stats, dropped, mode, fg };
}

/** 说明书页（kind:'manual'）前景掩膜。三条路径按数据判定，返回值用 maskPath 区分：
 *  ① 'near-white-flood'：四条边近白占比 ≥ MANUAL_BORDER_OK（白底页），泛洪近白区域取反为前景；
 *     泛洪后同样跑 UI 杂质剥离——白底官方说明书页一样有 BOM 蓝框 / 黄 callout / 分栏竖线 / 页码，
 *     不剥离就会把这些 UI 当零件（合成页实测 IoU 只有 0.54）。
 *  ② 'uniform-bg-flood'：边框一致度 ≥ MANUAL_UNIFORM_MIN 的统一页底（浅蓝/浅紫/白底封面等）——
 *     背景基准取四边像素众数色，并把同族淡色背板 / 中性满版色带并入基准做多基准泛洪，
 *     之后剥离空心框线 / 平涂面板 / 高彩度 callout 框 / 分栏竖线 / 页码 / 指引线 / 微噪点；
 *  ③ 'photo-sweep-fallback'：以上均不成立（页边被满版彩图打乱、一致度 < 0.60），退回实拍容差扫描。
 *  三条路径都跳过照片专用的椭圆窗保底与 degraded 标记（说明书页掩膜可用于打分）。
 *  返回值额外带 bg（边界众数色 RGB）、borderUniformity（边框一致度）与 maskPath，便于逐页复核走了哪条路。 */
export async function extractManualMask(photoBuf, { height = MASK_HEIGHT } = {}) {
  const { data: rgba, w, h } = await decodeRGBA(photoBuf, height);
  const lab = rgbaToLab(rgba, w * h);
  const n = w * h;
  // 背景基准一次估出来，三条路径共用（诊断字段 bg / borderUniformity 也从这里出）
  const bgInfo = estimateManualBackground(rgba, lab, w, h);
  const diag = { bg: { r: bgInfo.r, g: bgInfo.g, b: bgInfo.b }, borderUniformity: bgInfo.uniformity };
  // ① 白底：四条边近白占比达标 → 近白泛洪去背（白零件靠“不与边界连通”保留），再剥 UI 杂质
  const white = nearWhiteMap(lab, n);
  const border = borderBackgroundRatio(white, w, h);
  if (border >= MANUAL_BORDER_OK) {
    const { bg, count } = floodFillNearWhite(white, w, h);
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = bg[i] ? 0 : 1;
    const { mask, stats, dropped, mode } = stripManualChromeSafely(raw, rgba, lab, w, h, n, bgInfo);
    return { mask, rgba, w, h, bgRatio: 1 - countFg(mask) / n, count, maskConfidence: border, degraded: false, manual: true,
      chrome: stats, chromeMode: mode, chromeDropped: dropped.slice(0, 12), ...diag, maskPath: 'near-white-flood' };
  }
  // ② 统一页底（浅蓝/浅紫/白底封面等）：众数色（+ 淡色背板 / 中性满版色带）泛洪 + UI 杂质剥离
  const uniform = extractUniformBgManualMask(rgba, lab, w, h, bgInfo);
  if (uniform) return { ...uniform, ...diag };
  // ③ 前两张假设都不成立：退回实拍容差扫描，但仍不用椭圆保底、不标 degraded
  const { accepted, best } = sweepTolerances(lab, w, h);
  const use = accepted ?? best;
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = use.bg[i] ? 0 : 1;
  const { mask, stats, dropped, mode } = stripManualChromeSafely(raw, rgba, lab, w, h, n, bgInfo);
  return { mask, rgba, w, h, tol: use.tol, bgRatio: 1 - countFg(mask) / n, maskConfidence: use.border, degraded: false, manual: true,
    chrome: stats, chromeMode: mode, chromeDropped: dropped.slice(0, 12),
    whiteFallback: true, ...diag, maskPath: 'photo-sweep-fallback' };
}

/** 渲染图前景掩膜：alpha > 8 即前景；alpha 不可用（全透明/全不透明）时退回 flood-fill 并标 degraded。 */
export async function extractRenderMask(renderBuf, { height = MASK_HEIGHT } = {}) {
  const { data: rgba, w, h } = await decodeRGBA(renderBuf, height);
  const n = w * h, mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] > 8) { mask[i] = 1; count++; }
  if (count === 0 || count === n) {
    const m = await extractPhotoMask(renderBuf, { height });
    return { mask: m.mask, rgba, w, h, maskConfidence: m.maskConfidence, degraded: true };
  }
  return { mask, rgba, w, h, maskConfidence: 1, degraded: false };
}

// ------------------------------------------------------------------ 可单测的纯函数
export function maskCentroid(mask, w, h) {   // 掩膜质心（像素坐标）；空掩膜返回 null
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { sx += x; sy += y; n++; }
  return n ? { x: sx / n, y: sy / n, count: n } : null;
}

export function maskBBox(mask, w, h) {   // 掩膜包围盒 { minX, minY, maxX, maxY }；空掩膜返回 null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

export function maskAspect(mask, w, h) {   // 掩膜包围盒长宽比（宽/高）
  const b = maskBBox(mask, w, h);
  return b ? (b.maxX - b.minX + 1) / (b.maxY - b.minY + 1) : null;
}

/** 说明书页右下角页码字形是否残留：找出**完全落在**页码窄带（x ≥ 0.94w、y ≥ 0.93h）内
 *  且面积 < 1.5% 页面积的连通分量，返回它们覆盖的像素数之和（0 = 干净）。
 *  只统计“整块都在带内的小分量”——模型/插画伸进页角的像素属于大分量，不算页码。
 *  窄带取自 60239 实测：页码字形落在 x∈[0.955,0.978]w、y∈[0.938,0.960]h。 */
export function manualPageNumberPixels(mask, w, h) {
  const n = w * h;
  if (!n) return 0;
  const x0 = Math.floor(w * 0.94), y0 = Math.floor(h * 0.93);
  const maxSize = n * 0.015;
  const vis = new Uint8Array(n), queue = new Int32Array(n);
  let total = 0;
  for (let s = y0 * w + x0; s < n; s++) {
    if (!mask[s] || vis[s]) continue;
    let qh = 0, qt = 0;
    queue[qt++] = s; vis[s] = 1;
    let minX = s % w, maxX = minX, minY = (s / w) | 0, maxY = minY;
    while (qh < qt) {
      const c = queue[qh++], cx = c % w, cy = (c / w) | 0;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      if (cx > 0 && mask[c - 1] && !vis[c - 1]) { vis[c - 1] = 1; queue[qt++] = c - 1; }
      if (cx < w - 1 && mask[c + 1] && !vis[c + 1]) { vis[c + 1] = 1; queue[qt++] = c + 1; }
      if (cy > 0 && mask[c - w] && !vis[c - w]) { vis[c - w] = 1; queue[qt++] = c - w; }
      if (cy < h - 1 && mask[c + w] && !vis[c + w]) { vis[c + w] = 1; queue[qt++] = c + w; }
    }
    if (minX >= x0 && minY >= y0 && qt < maxSize) total += qt;
  }
  return total;
}

export function aspectSim(a1, a2) {   // 长宽比相似度 0–1
  return a1 > 0 && a2 > 0 ? Math.min(a1, a2) / Math.max(a1, a2) : 0;
}

/** 把 b 平移 (dx, dy) 后与 a 在同一 w×h 画布上算 IoU（平移出界的部分丢弃） */
export function shiftedIoU(a, b, w, h, dx = 0, dy = 0) {
  let na = 0, nb = 0, inter = 0;
  for (let i = 0; i < a.length; i++) { na += a[i]; nb += b[i]; }
  if (!na || !nb) return 0;
  for (let y = 0; y < h; y++) {
    const by = y - dy;
    if (by < 0 || by >= h) continue;
    for (let x = 0; x < w; x++) {
      const bx = x - dx;
      if (bx < 0 || bx >= w) continue;
      if (a[y * w + x] && b[by * w + bx]) inter++;
    }
  }
  return inter / (na + nb - inter);
}

/** 尺度归一 IoU：b 以自身质心 cb 为中心缩放 s、再平移使 cb 对齐 a 的质心 ca 后与 a 求交并。
 *  实拍中模型占幅由拍摄距离决定、渲染按包围盒取景，二者天然不同；不归一会让 IoU 度量“取景”
 *  而不是“形状”。并集用变换后掩膜的实际像素数（近似 s²·|b|）。 */
export function scaledShiftedIoU(a, b, w, h, ca, cb, s = 1) {
  let na = 0;
  for (let i = 0; i < a.length; i++) na += a[i];
  if (!na) return 0;
  // 逆映射构造变换后掩膜：目标像素 (x,y) 属于 T(B) 当且仅当其原像落在 b 内。
  // （正映射按源像素打点在 s>1 时会留下稀疏空洞，不是实心区域。）
  const tb = new Uint8Array(w * h);
  let ntb = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const qx = Math.round(cb.x + (x - ca.x) / s), qy = Math.round(cb.y + (y - ca.y) / s);
    if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
    if (b[qy * w + qx]) { tb[y * w + x] = 1; ntb++; }
  }
  if (!ntb) return 0;
  let inter = 0;
  for (let i = 0; i < a.length; i++) if (a[i] && tb[i]) inter++;
  return inter / (na + ntb - inter);
}

export function rgbHistogram(rgba, w, h, mask) {   // 掩膜内 RGB 4×4×4 直方图（归一化）；空掩膜返回 null
  const hist = new Float64Array(64);
  let n = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) {
    hist[(rgba[i * 4] >> 6) * 16 + (rgba[i * 4 + 1] >> 6) * 4 + (rgba[i * 4 + 2] >> 6)]++;
    n++;
  }
  if (!n) return null;
  for (let i = 0; i < 64; i++) hist[i] /= n;
  return hist;
}

export function cosineSim(a, b) {   // 余弦相似度
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

// ------------------------------------------------------------------ 粗色类（色块结构度量的基础）
// 9 类：黑/灰/白（无彩色，按 L 分）+ 红（含深红）/ 橙黄（含黄与棕=深橙黄）/ 绿 / 蓝（含深蓝）/ 紫 / 粉。
// 紫与粉必须分家：灯笼照片里淡紫板与粉件是关键区分项——粉落在红区高明度侧（b≈0），
// 紫落在蓝侧（b<0）；淡紫（低饱和高明度）与真蓝靠 L/彩度再细分。
const COLOR_CLASS_NAMES = ['黑', '灰', '白', '红', '橙黄', '绿', '蓝', '紫', '粉'];

/** Lab → 粗色类索引（纯函数，阈值见注释）：
 *  彩度 c<10 视为无彩色按 L 分黑(<25)/灰/白(>75)；
 *  有彩色按色相角 h=atan2(b,a)（0°=+a 红方向，90°=+b 黄方向）分区：
 *  h<20∪h≥336 → 粉（红—品红区高明度侧，含亮粉/深粉/品红≈337°；目录内红色全部落在 h 24°~40°，不受影响）；
 *  20≤h<45 → 红（含深红）；45≤h<102 → 橙黄（黄≈93°、亮浅黄≈98°、橙≈55°、棕=深橙黄≈50°）；102≤h<165 → 绿；
 *  165≤h<270 → 蓝；270≤h<310 且 L≥55 且 c<45 → 紫（淡紫），否则蓝；310≤h<336 → 紫。 */
export function labColorClass(L, a, b) {
  const c = Math.sqrt(a * a + b * b);
  if (c < 10) return L < 25 ? 0 : L > 75 ? 2 : 1;
  const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  if (h < 20 || h >= 336) return 8;                       // 粉（亮粉/深粉/品红，与红按色相角分家）
  if (h < 45) return 3;                                   // 红（含深红）
  if (h < 102) return 4;                                  // 橙黄（含亮浅黄≈98°、棕=深橙黄）
  if (h < 165) return 5;                                  // 绿
  if (h < 270) return 6;                                  // 蓝
  if (h < 310) return L >= 55 && c < 45 ? 7 : 6;          // 淡紫 vs 真蓝
  return 7;                                               // 紫
}

/** RGB → 粗色类名称字符串（复用 rgbaToLab 做 sRGB→Lab 换算） */
export function colorClass(r, g, b) {
  const lab = rgbaToLab(new Uint8Array([r, g, b, 255]), 1);
  return COLOR_CLASS_NAMES[labColorClass(lab[0], lab[1], lab[2])];
}

/** 整图 RGBA（n 像素）→ 粗色类索引数组（与像素一一对应的 Uint8Array） */
export function colorClassImage(rgba, n) {
  const lab = rgbaToLab(rgba, n);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = labColorClass(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
  return out;
}

/** 色块结构相似度：两图掩膜按现有质心+面积比尺度对齐后，取对齐掩膜的并集 bbox 划 16×16 网格；
 *  每格分别统计两图格内掩膜像素的众数粗色类（格内无该图掩膜像素记“空”），
 *  structureSim = 众数色类相同的非空格数 / 非空格总数（双空格不计入分母）。
 *  A/B 形如 { mask: Uint8Array, classes: Uint8Array(colorClassImage 输出), w, h }，纯函数可单测。 */
export function gridStructureSim(A, B, { grid = 16 } = {}) {
  const W = Math.max(A.w, B.w), H = Math.max(A.h, B.h);
  const ma = padMask(A.mask, A.w, A.h, W, H), mb = padMask(B.mask, B.w, B.h, W, H);
  const ca = maskCentroid(ma, W, H), cb = maskCentroid(mb, W, H);
  if (!ca || !cb) return 0;
  let areaA = 0, areaB = 0;
  for (let i = 0; i < ma.length; i++) { areaA += ma[i]; areaB += mb[i]; }
  const scale = Math.min(4, Math.max(0.25, Math.sqrt(areaA / Math.max(1, areaB))));
  // 与 scaledShiftedIoU 同一变换（逆映射）：画布像素 p 属于 T(B) 当且仅当其原像落在 B 掩膜内，同时搬运色类索引
  const tb = new Uint8Array(W * H), tcb = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const qx = Math.round(cb.x + (x - ca.x) / scale), qy = Math.round(cb.y + (y - ca.y) / scale);
    if (qx < 0 || qx >= W || qy < 0 || qy >= H) continue;
    if (mb[qy * W + qx]) { tb[y * W + x] = 1; tcb[y * W + x] = B.classes[qy * B.w + qx]; }
  }
  const ba = maskBBox(ma, W, H), bb2 = maskBBox(tb, W, H);
  if (!ba || !bb2) return 0;
  const minX = Math.min(ba.minX, bb2.minX), minY = Math.min(ba.minY, bb2.minY);
  const spanX = Math.max(ba.maxX, bb2.maxX) - minX + 1, spanY = Math.max(ba.maxY, bb2.maxY) - minY + 1;
  const votesA = new Int32Array(COLOR_CLASS_NAMES.length), votesB = new Int32Array(COLOR_CLASS_NAMES.length);
  let match = 0, total = 0;
  for (let gy = 0; gy < grid; gy++) {
    const y0 = minY + Math.floor(gy * spanY / grid), y1 = minY + Math.floor((gy + 1) * spanY / grid);
    for (let gx = 0; gx < grid; gx++) {
      const x0 = minX + Math.floor(gx * spanX / grid), x1 = minX + Math.floor((gx + 1) * spanX / grid);
      votesA.fill(0); votesB.fill(0);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (ma[i]) votesA[A.classes[y * A.w + x]]++;
        if (tb[i]) votesB[tcb[i]]++;
      }
      const mode = (v) => { let best = -1, n = 0; for (let k = 0; k < v.length; k++) if (v[k] > n) { n = v[k]; best = k; } return best; };
      const clsA = mode(votesA), clsB = mode(votesB);   // -1 = 空
      if (clsA < 0 && clsB < 0) continue;               // 双空格不计
      total++;
      if (clsA >= 0 && clsA === clsB) match++;
    }
  }
  return total ? match / total : 0;
}

/** 圆周加权中位数（角度单位度，返回规范角 [0,360)）：最小化 Σ w_i·circDist(δ, δ_i) 的 δ。
 *  候选集 = 各样本角 + 相邻候选（圆周排序后）的正向中点，保证跨 0° 环绕时也能取到短弧上的解
 *  （线性中位数会把 [350,356,4,10] 排到 180° 的背面）；平局取规范角最小者，确定性可单测。
 *  joint 模式用它估计全组共享的全局 yaw 偏移 Δ，样本权重 = 各照片粗扫最优分数。 */
export function weightedCircularMedian(samples) {
  const valid = (samples || []).filter((s) => Number.isFinite(s.delta) && Number.isFinite(s.weight) && s.weight > 0);
  if (!valid.length) return 0;
  const norm = (d) => ((d % 360) + 360) % 360;
  if (valid.length === 1) return norm(valid[0].delta);
  const cand = new Set(valid.map((s) => norm(s.delta)));
  const sorted = [...cand].sort((x, y) => x - y);
  for (let i = 0; i < sorted.length; i++) {   // 相邻候选的正向弧中点（含首尾环绕）
    const a = sorted[i], b = sorted[(i + 1) % sorted.length];
    cand.add(norm(a + ((b - a + 360) % 360) / 2));
  }
  const dist = (x, y) => { const d = Math.abs(x - y) % 360; return Math.min(d, 360 - d); };
  let best = null;
  for (const c of cand) {
    let cost = 0;
    for (const s of valid) cost += s.weight * dist(c, norm(s.delta));
    if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) <= 1e-9 && c < best.at)) best = { at: c, cost };
  }
  return best.at;
}

// ------------------------------------------------------------------ 打分
// 联合总分权重（joint/fixed 模式，和 = 1）：
//  0.35 轮廓 IoU（质心+面积比尺度归一）—— 主体形状仍是第一信号
//  0.15 包围盒长宽比相似度 —— 整体比例
//  0.20 掩膜内颜色直方图余弦 —— 配色总量是否一致
//  0.20 色块结构相似度（16×16 网格众数粗色类一致率）—— 内部色块空间分布，
//        旧指标的盲区：同轮廓不同内部结构（如端面 V 形斜板 vs 平板）在此拉开差距
//  0.10 未归一 IoU（silhouetteIoURaw）—— 比例惩罚：尺度归一吃掉的整体比例错误（偏长偏瘦）由它扣回
// sweep 模式沿用旧公式 0.5*IoU + 0.2*aspect + 0.3*color（pairWith 返回的 score 字段）。
const JOINT_W = { iou: 0.35, aspect: 0.15, color: 0.2, structure: 0.2, rawIou: 0.1 };

/** joint/fixed 模式的总分（纯函数，输入 pairWith/scorePair 返回的度量对象） */
export function jointScore(m) {
  return JOINT_W.iou * m.silhouetteIoU + JOINT_W.aspect * m.bboxAspectSim + JOINT_W.color * m.colorSim
    + JOINT_W.structure * (m.structureSim ?? 0) + JOINT_W.rawIou * m.silhouetteIoURaw;
}

function padMask(m, w, h, W, H) {   // 左上角对齐补零到 W×H
  if (w === W && h === H) return m;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) out.set(m.subarray(y * w, y * w + w), y * W);
  return out;
}

/** 照片掩膜已预提取时，与一张渲染图打分（内部用：roll/方位角扫描时避免重复解码照片）。
 *  返回 score = 旧公式（sweep 模式沿用）；jointScore = 联合总分（joint/fixed 模式）；
 *  照片侧粗色类在 A 上记忆化（同一照片反复打分时只算一次）。 */
async function pairWith(A, renderBuf, { height = MASK_HEIGHT } = {}) {
  const B = await extractRenderMask(renderBuf, { height });
  const W = Math.max(A.w, B.w), H = Math.max(A.h, B.h);
  const ma = padMask(A.mask, A.w, A.h, W, H), mb = padMask(B.mask, B.w, B.h, W, H);
  const ca = maskCentroid(ma, W, H), cb = maskCentroid(mb, W, H);
  let areaA = 0, areaB = 0;
  for (let i = 0; i < ma.length; i++) { areaA += ma[i]; areaB += mb[i]; }
  // 尺度归一：按掩膜面积比对渲染掩膜缩放（夹在 0.25~4，避免极端情况下退化）
  const scale = ca && cb ? Math.min(4, Math.max(0.25, Math.sqrt(areaA / Math.max(1, areaB)))) : 1;
  const silhouetteIoURaw = ca && cb ? shiftedIoU(ma, mb, W, H, Math.round(ca.x - cb.x), Math.round(ca.y - cb.y)) : 0;
  const silhouetteIoU = ca && cb ? scaledShiftedIoU(ma, mb, W, H, ca, cb, scale) : 0;
  const aspA = maskAspect(A.mask, A.w, A.h), aspB = maskAspect(B.mask, B.w, B.h);
  const bboxAspectSim = aspectSim(aspA, aspB);
  const colorSim = cosineSim(rgbHistogram(A.rgba, A.w, A.h, A.mask), rgbHistogram(B.rgba, B.w, B.h, B.mask));
  if (!A.classes) A.classes = colorClassImage(A.rgba, A.w * A.h);
  const classesB = colorClassImage(B.rgba, B.w * B.h);
  const structureSim = gridStructureSim({ mask: A.mask, classes: A.classes, w: A.w, h: A.h }, { mask: B.mask, classes: classesB, w: B.w, h: B.h });
  const metrics = { silhouetteIoU, silhouetteIoURaw, bboxAspectSim, colorSim, structureSim };
  const score = 0.5 * silhouetteIoU + 0.2 * bboxAspectSim + 0.3 * colorSim;
  return { A, B, W, H, ca, cb, scale, ...metrics, score, jointScore: jointScore(metrics) };
}

/** 照片（或说明书页）vs 渲染打分：等比缩放到同高 512px，掩膜质心对齐 + 面积比尺度归一后算 IoU/长宽比/颜色/色块结构相似度。
 *  opts.kind === 'manual' 时照片掩膜走近白背景的 extractManualMask（说明书页通道）。 */
export async function scorePair(photoBuf, renderBuf, { height = MASK_HEIGHT, kind } = {}) {
  const A = kind === 'manual' ? await extractManualMask(photoBuf, { height }) : await extractPhotoMask(photoBuf, { height });
  const m = await pairWith(A, renderBuf, { height });
  const { silhouetteIoU, silhouetteIoURaw, bboxAspectSim, colorSim, structureSim, score, jointScore, scale } = m;
  return { silhouetteIoU, silhouetteIoURaw, scale, bboxAspectSim, colorSim, structureSim, score, jointScore };
}

// ------------------------------------------------------------------ 三联图与批量对账
async function pngFromRaw(data, w, h, channels) {
  const sharp = await loadSharp();
  return sharp(data.buffer ? Buffer.from(data.buffer, data.byteOffset, data.length) : Buffer.from(data), { raw: { width: w, height: h, channels } }).png().toBuffer();
}

/** 三联图：实拍 | 渲染 | 掩膜差异（都前景=浅灰、仅实拍=红、仅渲染=蓝、都背景=黑；渲染掩膜按质心对齐+面积比缩放） */
async function writeTriptych(outFile, pair) {
  const sharp = await loadSharp();
  const { A, B, W, H, ca, cb, scale } = pair;
  const ma = padMask(A.mask, A.w, A.h, W, H), mb = padMask(B.mask, B.w, B.h, W, H);
  const diff = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = ma[y * W + x];
    let b = 0;
    if (ca && cb) {
      const qx = Math.round(cb.x + (x - ca.x) / scale), qy = Math.round(cb.y + (y - ca.y) / scale);
      if (qx >= 0 && qx < W && qy >= 0 && qy < H) b = mb[qy * W + qx];
    }
    const o = (y * W + x) * 3;
    if (a && b) { diff[o] = 236; diff[o + 1] = 236; diff[o + 2] = 236; }
    else if (a) { diff[o] = 228; diff[o + 1] = 60; diff[o + 2] = 48; }
    else if (b) { diff[o] = 60; diff[o + 1] = 120; diff[o + 2] = 228; }
  }
  const gap = 4;
  await sharp({
    create: { width: A.w + B.w + W + gap * 2, height: H, channels: 3, background: { r: 24, g: 24, b: 26 } },
  }).composite([
    { input: await pngFromRaw(A.rgba, A.w, A.h, 4), left: 0, top: 0 },
    { input: await pngFromRaw(B.rgba, B.w, B.h, 4), left: A.w + gap, top: 0 },
    { input: await pngFromRaw(diff, W, H, 3), left: A.w + B.w + gap * 2, top: 0 },
  ]).png().toFile(outFile);
}

const mean = (list, get) => (list.length ? list.reduce((a, r) => a + get(r), 0) / list.length : 0);

/** 渲染图旋转 90° 整数倍：等价于把相机绕视线轴滚转同角度（实拍中模型躺倒/倒立即此情形），
 *  无损且零渲染成本，用于照片与直立渲染的姿态对齐择优。 */
async function sharpRotate(buf, deg) {
  const sharp = await loadSharp();
  return sharp(buf).rotate(deg).png().toBuffer();
}

/** 批量对账（三模式）：
 *  - joint（默认，联合标定）：a) 每张照片先 320px 粗扫 az∈{标注±30 步15}×4 滚转，按 jointScore 取该照片最优 (az_i, roll_i)；
 *    b) 全局 yaw 偏移 Δ = 各照片 (az_i − 标注az) 的分数加权圆周中位数 —— 全组只允许一个共享偏移，
 *       单张照片的偶然高分（择优虚高）无法再单独抬分；c) 正式打分统一 az=标注az+Δ、roll 冻结为粗扫 roll_i、
 *    el 用标注值，不做任何逐照片优化。
 *  - sweep（旧行为原样保留）：每张照片在 ±20° 步 10° 方位角 × 4 滚转内逐照片取最优，score 沿用旧公式。
 *  - fixed：只按清单姿态渲染 + 4 向滚转择优（不做方位角扫描），用 jointScore，适合批量变体筛选。
 *  kind:'manual'（说明书页）一等支持：掩膜走 extractManualMask（近白即背景，无椭圆保底 / 不标 degraded）；
 *  在上面各模式的方位角择优基础上叠加 elevation 扫描（默认 MANUAL_EL_FROM..MANUAL_EL_TO 步 MANUAL_EL_STEP，
 *  opts.manualEls 可覆盖为任意角度数组；标注 elevation 始终并入候选）；报告条目带 kind:'manual' + source:'manual'。
 *  逐张 report 新增 structureSim / roll / poseAz（正式打分姿态），保留 silhouetteIoURaw / scale / bestAz 作诊断。
 *  写 outDir/<id>.png 三联图与 outDir/report.json，返回汇总对象。 */
export async function runDiff(model, cat, photosSet, dir, opts = {}) {
  const { outDir = 'out/diff', width = 640, height = 640 } = opts;
  const mode = opts.mode ?? (opts.sweep === false ? 'fixed' : opts.sweep === true ? 'sweep' : 'joint');   // 兼容旧 sweep 布尔旗标
  if (!['joint', 'sweep', 'fixed'].includes(mode)) throw new Error(`未知 diff 模式 ${mode}（可选 joint / sweep / fixed）`);
  const manualEls = opts.manualEls ?? range(MANUAL_EL_FROM, MANUAL_EL_TO, MANUAL_EL_STEP);
  fs.mkdirSync(outDir, { recursive: true });
  // 默认用 LDraw 真实几何对账；opts.geom='param' 可显式退回参数化（仅供对照实验）
  const geom = opts.geom ?? 'ldraw';
  if (geom !== 'ldraw' && geom !== 'param') throw new Error(`未知 diff 几何 ${geom}（可选 ldraw / param）`);
  const { buildModelGeometries } = await import('../ldraw/loader.mjs');
  const baked = geom === 'ldraw' ? buildModelGeometries(model, cat) : null;
  const noDat = baked && !baked.parts ? baked.noDat : [];
  if (geom === 'ldraw' && !baked.parts) throw new Error(`LDraw 镜像中找不到任何零件 .dat，无法用真实几何对账（可用 --geom param 退回参数化）：${noDat.slice(0, 5).join(', ')}`);
  const session = await createRenderSession(model, baked);
  const rows = [], skipped = [], prepared = [];
  let yaw = 0;   // joint：全组共享的全局 yaw 偏移 Δ
  try {
    for (const p of photosSet.photos || []) {
      if (p.kind !== 'exterior' && p.kind !== 'detail' && p.kind !== 'manual') continue;
      if (p.state && p.state !== 'closed') {   // 机关张开状态的照片与闭合姿态渲染必然失配（口径同 checkPhotos）
        skipped.push({ id: p.id, file: p.file || '', reason: `机关 ${p.state} 状态照片，对账只渲染闭合姿态，已跳过` });
        continue;
      }
      const row = { id: p.id, file: p.file, kind: p.kind, azimuth: p.azimuth ?? 0, elevation: p.elevation ?? 0 };
      if (p.kind === 'manual') row.source = 'manual';   // 报告标注：说明书页来源（白底渲染图，非实拍）
      const file = p.file && !path.isAbsolute(p.file) ? path.join(dir, p.file) : p.file;
      let photoBuf = null;
      if (file && fs.existsSync(file)) photoBuf = fs.readFileSync(file);
      else { row.error = `找不到照片文件 ${p.file}`; rows.push(row); continue; }
      const A = p.kind === 'manual' ? await extractManualMask(photoBuf) : await extractPhotoMask(photoBuf);
      const els = p.kind === 'manual' ? [...new Set([...manualEls, row.elevation])].sort((a, b) => a - b) : [row.elevation];
      prepared.push({ p, row, A, els });
    }
    // 指定 (az, el) 渲染一张并尝试 4 向滚转，按 pick 指定的分数择优（sweep/fixed 与 joint 粗扫共用）
    const renderOnce = async (A, az, el, w, h, pick) => {
      const buf = await session.shot({ az, el, w, h, ortho: true });
      let best = null, roll = 0;
      for (let k = 0; k < 4; k++) {
        const rb = k === 0 ? buf : await sharpRotate(buf, k * 90);
        const m = await pairWith(A, rb);
        if (!best || pick(m) > pick(best)) { best = m; roll = k * 90; }
      }
      return { m: best, roll, az, el };
    };
    // joint 第 a/b 步：320px 粗扫每照片最优姿态（manual 含 elevation 扫描）→ 分数加权圆周中位数得全局 yaw 偏移
    if (mode === 'joint') {
      for (const it of prepared) {
        let best = null;
        for (const d of [-30, -15, 0, 15, 30]) {
          const az = (it.row.azimuth + d + 360) % 360;
          for (const el of it.els) {
            const r = await renderOnce(it.A, az, el, 320, 320, (m) => m.jointScore);
            if (!best || r.m.jointScore > best.m.jointScore) best = r;
          }
        }
        it.coarse = best;   // { m, roll, az, el }
      }
      const deltas = prepared.filter((it) => it.coarse)
        .map((it) => ({
          delta: ((it.coarse.az - it.row.azimuth + 540) % 360) - 180,
          // degraded 照片（椭圆保底掩膜）的分数不可信：yaw 投票降权 0.3，避免它带偏全局姿态。
          // manual 条目掩膜永不 degraded，不受此降权影响。
          weight: Math.max(0.05, it.coarse.m.jointScore) * ((it.coarse.m.A.degraded || it.coarse.m.B.degraded) ? 0.3 : 1),
        }));
      yaw = weightedCircularMedian(deltas);
    }
    // 正式打分（joint：统一姿态 az=标注+Δ、冻结粗扫 roll/el；sweep/fixed：逐照片择优）
    for (const it of prepared) {
      const { row, A, els } = it;
      let bestShot, poseAz, roll;
      if (mode === 'joint') {
        poseAz = (row.azimuth + yaw + 360) % 360;
        roll = it.coarse ? it.coarse.roll : 0;
        const el = it.coarse ? it.coarse.el : row.elevation;   // manual：用粗扫选出的 elevation
        const buf = await session.shot({ az: poseAz, el, w: width, h: height, ortho: true });
        const rb = roll === 0 ? buf : await sharpRotate(buf, roll);
        bestShot = { m: await pairWith(A, rb) };
        row.poseEl = el;
      } else {
        const pick = (m) => (mode === 'sweep' ? m.score : m.jointScore);   // sweep 保持旧口径原样；fixed（变体筛选通道）与报告统一用 jointScore
        const offsets = mode === 'sweep' ? [0, -20, -10, 10, 20] : [0];
        for (const d of offsets) {
          const az = (row.azimuth + d + 360) % 360;
          for (const el of els) {
            const r = await renderOnce(A, az, el, width, height, pick);
            if (!bestShot || pick(r.m) > pick(bestShot.m)) { bestShot = r; poseAz = r.az; roll = r.roll; row.poseEl = r.el; }
          }
        }
      }
      const bestAz = mode === 'joint' ? (it.coarse ? it.coarse.az : poseAz) : poseAz;
      Object.assign(row, {
        silhouetteIoU: bestShot.m.silhouetteIoU, silhouetteIoURaw: bestShot.m.silhouetteIoURaw, scale: bestShot.m.scale,
        bboxAspectSim: bestShot.m.bboxAspectSim, colorSim: bestShot.m.colorSim, structureSim: bestShot.m.structureSim,
        score: mode === 'sweep' ? bestShot.m.score : bestShot.m.jointScore,
        bestAz, bestRoll: bestShot.roll ?? roll, roll, poseAz, maskConfidence: bestShot.m.A.maskConfidence,
        degraded: !!(bestShot.m.A.degraded || bestShot.m.B.degraded),
      });
      // 说明书页掩膜诊断（只加字段，不动既有口径）：走了哪条路径、背景基准色、边框一致度。
      // 没有这三个字段就无法复核“这页掩膜为什么长这样”，也无法区分 uniform-bg-flood 与
      // photo-sweep-fallback（二者旧口径都带 whiteFallback，不可区分）。
      if (row.kind === 'manual') {
        row.maskPath = bestShot.m.A.maskPath ?? null;
        row.maskBg = bestShot.m.A.bg ?? null;
        row.maskBorderUniformity = bestShot.m.A.borderUniformity ?? null;
        if (bestShot.m.A.chromeMode) row.maskChromeMode = bestShot.m.A.chromeMode;
      }
      await writeTriptych(path.join(outDir, `${it.p.id}.png`), bestShot.m);
      rows.push(row);
    }
  } finally {
    await session.close();
  }
  const scored = rows.filter((r) => r.score != null);
  // 一张都没打上分是最危险的结果：wmean 对空数组返回 0，于是 overall.score=0 会伪装成
  // 「模型极差」，而真实原因可能是照片全缺、全是张开状态、或几何全部渲染失败。
  // 这里显式抛错，让调用方看到原因，而不是拿着 0 分去乱改模型。
  if (!scored.length) {
    const why = skipped.length
      ? `全部照片被跳过：${skipped.map((s) => `${s.id}(${s.reason})`).join('；')}`
      : rows.length
        ? `全部照片打分失败：${rows.map((r) => `${r.id}(${r.error || '未知'})`).join('；')}`
        : 'photos.json 里没有可对账的照片（kind 需为 exterior / detail / manual）';
    throw new Error(`diff 没有得到任何有效分数 —— ${why}`);
  }
  // degraded 照片（椭圆保底掩膜）在总分均值中降权 0.3：其 IoU 由保底掩膜产生，不代表真实轮廓匹配
  const wOf = (r) => (r.degraded ? 0.3 : 1);
  const wmean = (list, get) => { let s = 0, ws = 0; for (const r of list) { const w = wOf(r); s += get(r) * w; ws += w; } return ws ? s / ws : 0; };
  const degradedPhotos = scored.filter((r) => r.degraded).map((r) => r.id);
  const report = {
    generatedAt: new Date().toISOString(), mode, ...(mode === 'joint' ? { yawDelta: yaw } : {}),
    photos: rows,
    skipped,
    overall: {
      meanIoU: wmean(scored, (r) => r.silhouetteIoU), meanColorSim: wmean(scored, (r) => r.colorSim),
      meanStructureSim: wmean(scored, (r) => r.structureSim), score: wmean(scored, (r) => r.score),
      ...(degradedPhotos.length ? { degradedPhotos, note: 'degraded 照片（椭圆保底掩膜）均值降权 0.3' } : {}),
    },
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

/** 单张照片的机位标定：az 0..345 步进 15 × el [-10,0,15,30,45] × 相机滚转 0/90/180/270，
 *  320px 低分辨率渲染扫描，按 IoU 排序（roll 非零说明照片里模型躺倒/倒立） */
export async function calibratePhoto(model, cat, photoFile, opts = {}) {
  const { width = 320, height = 320 } = opts;
  const photoBuf = fs.readFileSync(photoFile);
  const A = await extractPhotoMask(photoBuf);
  const { buildModelGeometries } = await import('../ldraw/loader.mjs');
  const baked = buildModelGeometries(model, cat);
  const session = await createRenderSession(model, baked.parts ? baked : null);
  const all = [];
  try {
    for (const el of [-10, 0, 15, 30, 45]) {
      for (let az = 0; az < 360; az += 15) {
        const buf = await session.shot({ az, el, w: width, h: height, ortho: true });
        for (let k = 0; k < 4; k++) {
          const rb = k === 0 ? buf : await sharpRotate(buf, k * 90);
          const { silhouetteIoU } = await pairWith(A, rb);
          all.push({ az, el, roll: k * 90, iou: silhouetteIoU });
        }
      }
    }
  } finally {
    await session.close();
  }
  all.sort((a, b) => b.iou - a.iou);
  return { best: all[0] ?? null, top: all.slice(0, 5) };
}
