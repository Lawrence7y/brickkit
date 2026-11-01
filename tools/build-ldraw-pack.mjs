// 生成 catalog/ldraw-pack.json：精选真实几何包（.dat 依赖文本闭包，gzip+base64）。
//
// 为什么只打"精选"而不是全库：全库 4605 件的 .dat 依赖文本 gzip 后 16.7MB /
// base64 22.3MB，内联进单文件查看器会让首屏多付一次 20MB+ 的解析与解压
// （实测解析 100MB 文本约 20s），那不是"离线可用"，是把页面拖死。
// 精选集是 165 件（catalog/ldraw/manifest.json）+ 优先级补充件，gzip 约 0.12MB，
// 覆盖库列表首屏、示例模型与用户点名的零件。
//
// 其余零件走参数化外形，并在 UI 上如实标注「真实几何缺失」——
// 不假装全库都是真实网格（覆盖账本见 tools/geom-coverage-ledger.mjs）。
//
// 用法：node tools/build-ldraw-pack.mjs [--extra 584,35,36]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { mergeCatalogParts } from '../src/core/core.js';
import { createResolver, LDRAW_ROOTS, buildPart } from '../src/ldraw/loader.mjs';

/**
 * 目录自己合并，**不再 import src/viewer/geom.js**。
 *
 * 原来的 import { cat } from '../src/viewer/geom.js' 是一个自举死锁：
 * geom.js 第 7 行静态 import catalog/ldraw-pack.json，而本生成器正是产出这个包的人。
 * 结果包一旦缺失，生成器与 build.mjs 双双 exit 1 —— 想重建包的人必须先有包。
 * （ERRATA-002 / C5 实测；r2 由 assets-b 定位，Leader 集成）
 *
 * 合并不传 datumOf：datumOf 只影响合并后的连接器数组，而这里用 def 只是为了让
 * buildPart 按 size/h/kind 建几何，datum 本身由 .dat 几何算出。
 * 不读旧包也保证「第一次生成」与「第一百次生成」走同一条路径（可复现）。
 */
const _curatedParts = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8')).parts;
const _extParts = JSON.parse(fs.readFileSync('catalog/parts-ldraw.json', 'utf8')).parts;
const cat = { parts: mergeCatalogParts(_extParts, _curatedParts, {}) };

const ROOTS = ['catalog/ldraw-full', 'catalog/ldraw'];
const OUT = 'catalog/ldraw-pack.json';

// 与 src/ldraw/ldraw.js 的 OFFICIAL_ALIASES 保持一致（只做文件名映射，不改身份）
// 与 src/ldraw/ldraw.js 的 OFFICIAL_ALIASES 必须保持一致（两处任一漏改会让
// 「看图能装、校验说没几何」分叉）。
// 4085d / 4589b 的依据是目标 .dat 自己的官方交叉引用（2026-10-31 实测）：
//   catalog/ldraw/parts/60897.dat:9  0 !KEYWORDS BrickLink 4085d
//   catalog/ldraw/parts/59900.dat:9  0 !KEYWORDS BrickLink 4589b, pylon, Round
// 553b 维持 30367a（30367a 的 KEYWORDS 只提到 BrickLink 553a，553b 仍未确认 → 不改、不猜）。
const ALIASES = { '3040': '3040b', '553b': '30367a', '4085d': '60897', '4589b': '59900' };

/**
 * 优先级补充件：用户点名要核实的、或库列表首屏里必定出现的。
 * 这些件在 catalog/ldraw/manifest.json（精选 165）里可能没有，但在 ldraw-full 里能找到。
 * 逐个核实存在性，找不到就如实记录（不静默跳过）。
 */
// 【r39】移除了 '58584'：`audit/part-inventory-2026-10-31/c5-report.md` §478 与
// `tools/generate-shard-c-ledger.mjs` §3 都已核实「目录与 manifest 里都没有该编号」，
// 且明写『Part 584 才是正主，不要让 584 与 58584 混淆』。
// 它留在列表里只会让每次构建都打印一条 `补充件不可用` —— 用假信号污染真信号。
// 同时去掉重复项（48336 / 60470 / 3023 各出现两次，11211 三次）。
const PRIORITY_EXTRA = [
  '584', '35', '36', '3700', '60470', '48336', '87087', '4733', '11211',
  '99780', '99781', '99207', '36840', '3001', '3020', '3023', '3004', '3005',
  '3022', '3710', '3062b', '3941', '3037', '3039', '41539', '3068b', '3024',
  '3003', '3010', '60596', '3622', '3065', '60623', '3036', '3041', '3021',
  '22885', '99206', '41769', '41770', '24299', '24307', '60478', '63868',
  '44301', '3795', '3031',
];

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const extraFromArg = String(arg('extra', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const extras = [...new Set([...PRIORITY_EXTRA, ...extraFromArg])];

const norm = (raw) => String(raw).trim().toLowerCase().split(String.fromCharCode(92)).join('/').replace(/^\.\//, '');
const refCandidates = (raw) => {
  const ref = norm(raw);
  if (!/^[a-z0-9][a-z0-9._/-]*\.dat$/.test(ref) || ref.split('/').includes('..')) return [];
  if (ref.startsWith('s/')) return [`parts/s/${ref.slice(2)}`];
  if (ref.startsWith('parts/') || ref.startsWith('p/')) return [ref];
  return [`parts/${ref}`, `p/${ref}`, `parts/s/${ref}`];
};
const readLib = (ref) => {
  for (const lp of refCandidates(ref)) {
    for (const root of ROOTS) {
      const p = path.join(root, lp);
      try { if (fs.statSync(p).isFile()) return { rel: lp, text: fs.readFileSync(p, 'utf8') }; } catch { /* 不存在 */ }
    }
  }
  return null;
};
const refsOf = (text) => {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('1 ')) continue;
    const tok = t.split(/\s+/);
    if (tok.length >= 15) out.push(tok.slice(14).join(' '));
  }
  return out;
};

/**
 * 实测框架原点表。缺文件时烘焙空表并显式告警（不静默降级成看起来正常）：
 * 空表意味着所有 mismatch 件退回「不继承坐标」，4081b 的两个侧凸点会再次消失。
 */
const FRAME_FILE = 'catalog/ldraw-frame.json';
let frameByPart = {};
if (fs.existsSync(FRAME_FILE)) {
  frameByPart = JSON.parse(fs.readFileSync(FRAME_FILE, 'utf8')).frame || {};
} else {
  console.warn('[pack] 缺少 ' + FRAME_FILE + '：mismatch 件的 x/z 重锚不可用（4081b 侧凸点会丢失）。运行 node tools/geom-round2-frame.mjs 重新生成。');
}

const manifest = JSON.parse(fs.readFileSync('catalog/ldraw/manifest.json', 'utf8'));
const curated = Object.keys(manifest.parts || {}).map(String).sort();
const curatedSet = new Set(curated);

// 只保留目录里确实存在的编号（不 import 一个不存在身份的零件）
const extrasFound = [];
const extrasMissing = [];
for (const id of extras) {
  if (!cat.parts[id]) { extrasMissing.push({ id, why: '目录里没有该编号' }); continue; }
  if (curatedSet.has(id)) continue;
  const probe = readLib(`${ALIASES[id] || id}.dat`);
  if (!probe) { extrasMissing.push({ id, why: 'LDraw 镜像里没有 .dat' }); continue; }
  extrasFound.push(id);
}
const included = [...new Set([...curated, ...extrasFound])].filter((id) => cat.parts[id]).sort();

// 依赖闭包
const files = new Map();
const missing = [];
const seen = new Set();
const queue = included.map((id) => `${ALIASES[id] || id}.dat`);
while (queue.length) {
  const ref = queue.shift();
  const key = norm(ref);
  if (seen.has(key)) continue;
  seen.add(key);
  const got = readLib(ref);
  if (!got) { missing.push(ref); continue; }
  if (files.has(got.rel)) continue;
  files.set(got.rel, got.text);
  for (const c of refsOf(got.text)) if (!seen.has(norm(c))) queue.push(c);
}

const rels = [...files.keys()].sort();
const blob = rels.map((r) => `${r}\n${files.get(r)}`).join('\n@@FILE@@\n');
const raw = Buffer.from(blob, 'utf8');
const gz = zlib.gzipSync(raw, { level: 9 });

/**
 * 每件的**安装基准面**（LDraw LDU）一并烘焙进包。
 *
 * 为什么需要在包里带 datum：`mergeCatalogParts()` 要把扩展目录的连接器 ly 从
 * 「几何最低点为 0」的框架平移进「安装面为 0」的框架，平移量 = extOrigin×8 − datum。
 * 浏览器侧没有 fs、不能解析 .dat，所以这个数只能在构建期算好带进去。
 * 缺表时合并函数退回用 `c.h*8` 近似 —— 对 60623（datum=137 vs h×8=144）这类
 * datum≠h×8 的件会偏 7 LDU，所以这张表不是可选的优化，而是正确性的一部分。
 */
const packResolver = createResolver(LDRAW_ROOTS);
const datumByPart = {};
for (const id of included) {
  try {
    const built = buildPart({ partId: id, color: 16, def: cat.parts[id], resolve: packResolver });
    if (built && built.datum) datumByPart[id] = built.datum.datumLdu;
  } catch { /* 单件失败不影响打包，缺项如实不写 */ }
}

const pack = {
  format: 'brickkit-ldraw-pack',
  version: '1.1.0',
  // 逐字节可复现：generatedAt 若取 now()，同一份源码两次生成就会得到不同的包，
  // 而包是被整段内联进 dist/viewer.html 的 —— 于是「重建」永远不可能字节相同。
  // 约定：设置 SOURCE_DATE_EPOCH（秒）时用它，否则退回当前时间（便于人工排查）。
  // 这不是可选的洁癖：C5 的「两次独立目录逐字节相同」正是在固定包文件的前提下成立的。
  generatedAt: process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString(),
  generatedBy: 'tools/build-ldraw-pack.mjs',
  license: {
    name: 'CC BY 2.0',
    url: 'https://library.ldraw.org/license',
    attribution: 'LDraw.org 官方零件库（library.ldraw.org）。各 .dat 文件版权归其作者，按 CC BY 2.0 再分发。',
    source: 'https://library.ldraw.org/library/official',
    snapshot: manifest.fetchedAt || null,
  },
  sourceHashes: {
    'catalog/ldraw/manifest.json': crypto.createHash('sha256').update(fs.readFileSync('catalog/ldraw/manifest.json')).digest('hex'),
  },
  curatedParts: included,
  /** partId → 安装基准面（LDraw LDU）。供 mergeCatalogParts({datumOf}) 精确重锚连接器。 */
  datum: datumByPart,
  /**
   * partId → 实测「扩展目录框架原点」（body 包围盒中心，LDraw LDU）。
   * 供 mergeCatalogParts({frameOf}) 在两套目录 size 不一致（frame 为 mismatch）时
   * 把 x/z 一起重锚。没有它，那类件只能放弃继承坐标
   * （4081b 的 2 个侧凸点曾因此整条丢失）。
   * 数据来自 catalog/ldraw-frame.json（tools/geom-round2-frame.mjs 从 .dat 实测生成）。
   */
  frame: frameByPart,
  /** 来自精选 manifest 的数量（其余是 PRIORITY_EXTRA 补充进来的）。 */
  curatedManifestCount: curated.length,
  extras: extrasFound,
  extrasMissing,
  aliases: ALIASES,
  files: rels.length,
  missingFiles: missing.length,
  bytesRaw: raw.length,
  bytesGz: gz.length,
  sha256Raw: crypto.createHash('sha256').update(raw).digest('hex'),
  encoding: 'gzip+base64',
  blob: gz.toString('base64'),
};

fs.writeFileSync(OUT, JSON.stringify(pack));
console.log(`[pack] ${OUT} ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`
  + ` | parts ${included.length}（精选 ${curated.length} + 补充 ${extrasFound.length}）`
  + ` | .dat ${rels.length} | raw ${(raw.length / 1e6).toFixed(2)} MB | gz ${(gz.length / 1e6).toFixed(2)} MB`
  + ` | 缺引用 ${missing.length}`);
if (extrasMissing.length) console.log('[pack] 补充件不可用：', JSON.stringify(extrasMissing));
