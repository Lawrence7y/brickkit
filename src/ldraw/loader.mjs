// LDraw .dat 解析加载器：把官方零件库文本（catalog/ldraw-full / catalog/ldraw 镜像）解析成
// brickkit 本地几何数据（纯 JS 对象，不依赖 THREE / 浏览器 / DOM）。
// 供两处使用：① cli/brickkit.mjs render --geom ldraw 预烘焙几何并嵌入单文件查看器；
// ② test/ldraw-loader.test.mjs 纯函数单测。浏览器侧的 THREE 构建在 src/viewer/ldraw-geom.js。
//
// 线类型（LDraw 规范）：
//   0 注释/元数据（识别 `0 BFC INVERTNEXT`：其后第一条子引用的多边形绕组翻转）；
//   1 子文件引用（沿矩阵链递归展开；负行列式 = 镜像 → 累计翻转奇偶）；
//   2 线段（边线）；
//   3 三角形；4 四边形（扇形拆两个三角形 v0v1v2 + v0v2v3）；
//   5 平滑组/移动记录（无实体几何，忽略并计数）。
// 颜色：16 = 继承零件主色；24 = 边线色，同样记录在继承主色下；
//   直接色码保留字符串键，由查看器查 catalog/colors.json，缺色给中性灰并记入 notes。
// 单位/坐标系：与 core.js ldrawLine（L597-604，本格式→LDraw 的 Y 朝下导出）互逆：
//   1 格 = 20 LDU，1 片 = 8 LDU；局部顶点 = (x/20, -y/20, -z/20) + ldrawOrigin 偏移
//   （ldrawOrigin 单位 [x 格, y 片, z 格]，y 分量乘 PLATE 换成格）。
//   产出框架与 geom.js partGeometry 一致：占地中心原点、底面 y=0、未旋转（rot/up 由调用方
//   baseMatrix 施加）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refCandidates, safeJoin, OFFICIAL_ALIASES } from './ldraw.js';
import { PLATE } from '../core/core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const LDRAW_ROOTS = [path.join(REPO_ROOT, 'catalog', 'ldraw-full'), path.join(REPO_ROOT, 'catalog', 'ldraw')];

export const LDU_PER_STUD = 20;
export const MAX_DEPTH = 12;        // 与 src/ldraw/ldraw.js 几何遍历同一上限

// —— 单行解析（纯函数） ——————————————————————————————————————————————
/** 返回 {type, ...}；注释/空行/非法行（type 非 0..5、字段数不足、坐标非有限）返回 null。 */
export function parseLine(line) {
  const t = String(line).trim();
  if (!t) return null;
  const tok = t.split(/\s+/);
  const type = Number(tok[0]);
  if (!Number.isInteger(type) || type < 0 || type > 5) return null;
  if (type === 0) return { type: 0, invertNext: /^0\s+BFC\s+INVERTNEXT\b/i.test(t), subfile: /^0\s+FILE\b/i.test(t), endFile: /^0\s+NOFILE\b/i.test(t) };
  const color = Number(tok[1]);
  if (!Number.isInteger(color)) return null;
  const pt = (i) => [+tok[i], +tok[i + 1], +tok[i + 2]];
  const ok3 = (p) => p.every((v) => Number.isFinite(v));
  if (type === 1) {
    if (tok.length < 15) return null;
    const pos = pt(2);
    const m = [+tok[5], +tok[6], +tok[7], +tok[8], +tok[9], +tok[10], +tok[11], +tok[12], +tok[13]];
    if (!ok3(pos) || m.some((v) => !Number.isFinite(v))) return null;
    return { type: 1, color, pos, m, file: tok.slice(14).join(' ') };
  }
  if (type === 5) return { type: 5, color };
  const n = type === 2 ? 2 : type === 3 ? 3 : 4;   // type 4 是四个顶点
  if (tok.length < 2 + n * 3) return null;
  const pts = [];
  for (let k = 0; k < n; k++) { const p = pt(2 + k * 3); if (!ok3(p)) return null; pts.push(p); }
  return type === 2 ? { type: 2, color, a: pts[0], b: pts[1] } : { type, color, pts };
}

// 引用规范化（循环检测键；与 refCandidates 同一大小写/分隔符规则）
const normRef = (raw) => String(raw).trim().toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');

// —— 文件解析器（镜像根目录列表 → resolve(rawRef) → text|null） ————————————
export function createResolver(roots = LDRAW_ROOTS) {
  const cache = new Map();
  return function resolve(raw) {
    const key = normRef(raw);
    if (cache.has(key)) return cache.get(key);
    let text = null;
    // refCandidates 只展开 parts/ 与 p/ 两个镜像布局；老式文件里的显式 p\xxx.dat 前缀
    // 会展开成 parts/p/... 与 p/p/...，永远落不到 p/xxx.dat —— 追加原样路径兜底（仍经
    // safeJoin 防穿越；官方整库实测无 p\ 引用，此候选只为鲁棒性，命中顺序保持最后）。
    const cands = refCandidates(key);
    if (!cands.includes(key)) cands.push(key);
    for (const lp of cands) {
      for (const root of roots) {
        const f = safeJoin(root, lp);
        if (f && fs.existsSync(f)) { text = fs.readFileSync(f, 'utf8'); break; }
      }
      if (text) break;
    }
    cache.set(key, text);
    return text;
  };
}

const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[2] * m[8] - m[5] * m[6]) + m[2] * (m[1] * m[7] - m[4] * m[6]);
const mul3 = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
const apply3 = (M, t, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + t[0], M[3] * p[0] + M[4] * p[1] + M[5] * p[2] + t[1], M[6] * p[0] + M[7] * p[1] + M[8] * p[2] + t[2]];

const r4 = (v) => Math.round(v * 1e4) / 1e4;   // 嵌入 JSON 前保留 4 位小数（≈1 微米）

/**
 * 解析一个 .dat 文本为 brickkit 本地几何（叶顶点已展开实例矩阵并换算坐标系）。
 * opts: { resolve(rawRef)→text|null, color: 零件主色码（16 的继承源）,
 *         origin: [x格, y格, z格]（ldrawOrigin 换算后）, fileName?: 顶层文件名（循环检测）, maxDepth? }
 * 返回 { groups: {色码: [x,y,z,...]三角形}, lines: {色码: [...]线段}, stats, notes }。
 */
export function buildPartFromText(text, opts) {
  const { resolve, color, origin = [0, 0, 0], fileName = '', maxDepth = MAX_DEPTH } = opts;
  const groups = new Map();   // 色码字符串 → 三角形顶点扁平数组（已按绕组翻转/变换到本地）
  const lines = new Map();
  const notes = new Set();
  const stats = { triangles: 0, quads: 0, lineSegments: 0, type5: 0, malformed: 0, files: 1, missingFiles: 0, cycles: 0, tooDeep: 0 };
  const emit = (map, key, verts) => { let a = map.get(key); if (!a) map.set(key, (a = [])); for (const v of verts) a.push(r4(v[0]), r4(v[1]), r4(v[2])); };
  const toLocal = (p) => [p[0] / LDU_PER_STUD + origin[0], -p[1] / LDU_PER_STUD + origin[1], -p[2] / LDU_PER_STUD + origin[2]];
  // 16=继承当前主色；24=边线色，同样记录在继承主色下（规范上 24 不应出现在实体面）
  const effColor = (c, cur) => (c === 16 || c === 24 ? cur : String(c));

  // INVERTNEXT 语义：对紧跟子树产出的全部三角形做绕组翻转（等价于 src/ldraw/ldraw.js
  // trianglesFromText L255 对每个多边形 reverse 一次）。snapshot 记录递归前每个色组的数组
  // 长度，递归后从各自偏移起把每个三角形 v1/v2 对调。lines 不受绕组影响，不处理。
  const snapshot = () => new Map([...groups].map(([k, a]) => [k, a.length]));
  const invertSince = (saved) => {
    for (const [k, a] of groups) {
      const n = saved.get(k) ?? 0;
      for (let i = n; i + 8 < a.length; i += 9) {
        const t = [a[i + 3], a[i + 4], a[i + 5]];
        a[i + 3] = a[i + 6]; a[i + 4] = a[i + 7]; a[i + 5] = a[i + 8];
        a[i + 6] = t[0]; a[i + 7] = t[1]; a[i + 8] = t[2];
      }
    }
  };

  const walk = (txt, M, t, cur, depth, flip, stack) => {
    if (depth > maxDepth) { stats.tooDeep++; return; }
    let invertNext = false;
    for (const raw of txt.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const l = parseLine(raw);
      if (!l) { stats.malformed++; continue; }
      if (l.type === 0) { if (l.invertNext) invertNext = true; continue; }
      if (l.type === 5) { stats.type5++; continue; }
      if (l.type === 1) {
        const key = normRef(l.file);
        const pending = invertNext;
        invertNext = false;
        if (stack.has(key)) { stats.cycles++; notes.add(`cycle:${key}`); continue; }
        const child = resolve(l.file);
        if (!child) { stats.missingFiles++; notes.add(`missing:${key}`); continue; }
        // 子文件绕组奇偶 = 祖先链 XOR 本实例镜像（det<0）；INVERTNEXT 不回传，递归返回后翻转
        const childFlip = flip !== (det3(l.m) < 0);
        const saved = pending ? snapshot() : null;
        stack.add(key); stats.files++;
        walk(child, mul3(M, l.m), apply3(M, t, l.pos), effColor(l.color, cur), depth + 1, childFlip, stack);
        stack.delete(key);
        if (saved) invertSince(saved);
        continue;
      }
      const col = effColor(l.color, cur);
      if (l.type === 2) { emit(lines, col, [toLocal(apply3(M, t, l.a)), toLocal(apply3(M, t, l.b))]); stats.lineSegments++; continue; }
      const pts = l.pts.map((p) => toLocal(apply3(M, t, p)));
      if (l.type === 3) { if (flip) pts.reverse(); emit(groups, col, pts); stats.triangles++; }
      else { let tris = [[pts[0], pts[1], pts[2]], [pts[0], pts[2], pts[3]]]; if (flip) tris = tris.map((x) => [x[0], x[2], x[1]]); for (const tr of tris) emit(groups, col, tr); stats.quads++; }
    }
  };

  walk(text, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], String(color), 0, false, new Set(fileName ? [normRef(fileName)] : []));
  const obj = (m) => Object.fromEntries(m);
  return { groups: obj(groups), lines: obj(lines), stats, notes: [...notes] };
}

/** 顶层：按零件 id（含官方别名）从镜像构建；无 .dat 返回 null（调用方负责回退与计数）。 */
export function buildPart({ partId, color, def, resolve = createResolver() }) {
  const official = OFFICIAL_ALIASES[String(partId)] || String(partId);
  const fileName = `${official}.dat`;
  const text = resolve(fileName);
  if (!text) return null;
  const o = (def && def.ldrawOrigin) || [0, (def && def.h) || 0, 0];
  const origin = [o[0], o[1] * PLATE, o[2]];   // [x 格, y 片→格, z 格]
  const built = buildPartFromText(text, { resolve, color, origin, fileName });
  built.partId = String(partId);
  built.official = official;
  return built;
}

/**
 * 遍历模型的 (part|color) 组合，产出可嵌入查看器的烘焙几何数据。纯内存操作，无浏览器依赖。
 * 返回 { data: {"part|color": {groups, lines, stats}}, notes, noDat, triangles, parts }。
 */
export function buildModelGeometries(model, cat, opts = {}) {
  const resolve = opts.resolve || createResolver(opts.roots || LDRAW_ROOTS);
  const data = {};
  const notes = new Set();
  const noDat = new Set();
  const builtCache = new Map();   // part|color → built（同色同件构建一次缓存复用）
  let triangles = 0;
  for (const p of model.parts || []) {
    const key = `${p.part}|${p.color}`;
    if (data[key]) continue;
    let b = builtCache.get(key);
    if (b === undefined) { b = buildPart({ partId: p.part, color: p.color, def: cat.parts?.[p.part], resolve }); builtCache.set(key, b); }
    if (!b) { noDat.add(key); continue; }
    data[key] = { groups: b.groups, lines: b.lines, stats: b.stats };
    triangles += b.stats.triangles + b.stats.quads * 2;
    for (const c of [...Object.keys(b.groups), ...Object.keys(b.lines)]) {
      if (c !== '16' && !cat.colors?.[c]) notes.add(`missing-color:${c}→中性灰`);
    }
    for (const n of b.notes) notes.add(n);
  }
  return { data, notes: [...notes], noDat: [...noDat], triangles, parts: Object.keys(data).length };
}
