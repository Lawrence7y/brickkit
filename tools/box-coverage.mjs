// 分解包围盒覆盖率审计：用官方 .dat 网格顶点检验 partBoxes 是否覆盖全部实体材料。
// 判定口径：把零件放在原点（at=[0,0,0]、rot=0、up='+y'），取 loader 渲染用的同一套本地顶点，
// 逐顶点问「是否落在任一个碰撞盒内」。落在盒外 = 该处材料在碰撞判定里"不存在"，
// 即允许真实穿模通过 validate——这是红线一（零穿模）的静默失效，比报错更危险。
//
// 用法：
//   node tools/box-coverage.mjs                 # 审计全部带 boxes 的目录条目
//   node tools/box-coverage.mjs 28324 50745     # 只审指定件
//   node tools/box-coverage.mjs --min 0.90      # 覆盖率低于阈值才列出（默认 0.98）
// 输出：按覆盖率升序的 JSON（含 miss 采样点），stdout 首行汇总。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPart, createResolver } from '../src/ldraw/loader.mjs';
import { partBoxes, PLATE } from '../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const extFile = path.join(ROOT, 'catalog/parts-ldraw.json');
const ext = fs.existsSync(extFile) ? readJSON(extFile).parts : {};
const curated = readJSON(path.join(ROOT, 'catalog/parts.json')).parts;
const parts = { ...ext, ...curated };

const argv = process.argv.slice(2);
let min = 0.98;
const mIdx = argv.indexOf('--min');
if (mIdx >= 0) { min = Number(argv[mIdx + 1]); argv.splice(mIdx, 2); }
const ids = argv.length ? argv : Object.keys(parts);
const resolve = createResolver();

// 坐标口径：loader 顶点 y 为「格」(1 格 = 2.5 片)；partBoxes 的 y 为「片」→ 比较前 ×2.5。
// 容差与引擎 boxesCollide 一致（水平 0.04 格、竖直 0.10 片）：分解盒按整数格/1/4 片量化，
// 官方 .dat 常有 1 LDU（0.05 格）薄唇/倒角落在格线外，属设计容差而非"漏保护"，
// 用更严的容差会把这类亚容差毛刺报成缺陷，掩盖真正的采空（50745 覆盖率 0.03 那种）。
const PLATES_PER_STUD = 1 / PLATE;   // 2.5
const inBox = (p, b) => p[0] >= b.x0 - 0.04 && p[0] <= b.x1 + 0.04
  && p[1] >= b.y0 - 0.10 && p[1] <= b.y1 + 0.10
  && p[2] >= b.z0 - 0.04 && p[2] <= b.z1 + 0.04;

const rows = [];
let scanned = 0;
for (const id of ids) {
  const def = parts[id];
  if (!def) { rows.push({ id, note: '不在目录' }); continue; }
  if (!def.boxes && !['corner', 'bracket', 'pinplate', 'slope', 'snot'].includes(def.kind)) {
    // 实心件走单盒 fast path：单盒即整体 AABB，覆盖率恒 1，不占审计时间
    continue;
  }
  const built = buildPart({ partId: id, color: 0, def, resolve });
  if (!built) { rows.push({ id, note: '无官方 .dat' }); continue; }
  const boxes = partBoxes({ id, part: id, color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 }, def);
  if (!boxes.length) { rows.push({ id, note: 'partBoxes 返回空' }); continue; }
  scanned++;
  const [sx, sz] = def.size;
  const localBoxes = boxes.map((b) => ({ x0: b.x0 - sx / 2, x1: b.x1 - sx / 2, y0: b.y0, y1: b.y1, z0: b.z0 - sz / 2, z1: b.z1 - sz / 2 }));
  // 先量两侧各自的 y 范围：网格底 vs 盒底。两者的差就是「.dat 实测高度/原点口径 vs 目录 h」的偏差
  // （偏差非零时几何渲染位置与碰撞体错开，属独立缺陷，单独上报为 yOffset）。
  let meshMinY = Infinity, meshMaxY = -Infinity;
  const allPts = [];
  for (const arr of Object.values(built.groups)) {
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const p = [arr[i], arr[i + 1] * PLATES_PER_STUD, arr[i + 2]];
      allPts.push(p);
      if (p[1] < meshMinY) meshMinY = p[1];
      if (p[1] > meshMaxY) meshMaxY = p[1];
    }
  }
  if (!allPts.length) { rows.push({ id, note: '无实体面（纯线框）' }); continue; }
  const boxMinY = Math.min(...localBoxes.map((b) => b.y0));
  const boxMaxY = Math.max(...localBoxes.map((b) => b.y1));
  const yOffset = Math.round((meshMinY - boxMinY) * 1000) / 1000;   // 片；非 0 = 几何与碰撞体错层
  // 覆盖率：按 yOffset 平移对齐后判定（隔离几何错层，只看盒分解本身是否漏料），
  // 且只统计本体高度内（盒顶以下）的顶点——顶凸点柱不当成漏保护的材料。
  let total = 0, uncovered = 0;
  const miss = [];
  for (const p0 of allPts) {
    const p = [p0[0], p0[1] - yOffset, p0[2]];
    if (p[1] > boxMaxY + 0.02) continue;
    total++;
    if (localBoxes.some((b) => inBox(p, b))) continue;
    uncovered++;
    if (miss.length < 5) miss.push(p.map((v) => Math.round(v * 1000) / 1000));
  }
  if (!total) { rows.push({ id, note: '无实体面（纯线框）' }); continue; }
  const cover = Math.round((1 - uncovered / total) * 10000) / 10000;
  if (cover < min || Math.abs(yOffset) > 0.05) {
    rows.push({ id, kind: def.kind, size: def.size, h: def.h, boxes: boxes.length, verts: total,
      meshY: [Math.round(meshMinY * 100) / 100, Math.round(meshMaxY * 100) / 100],
      boxY: [Math.round(boxMinY * 100) / 100, Math.round(boxMaxY * 100) / 100],
      yOffset, cover, uncovered, miss });
  }
}
rows.sort((a, b) => (a.cover ?? 2) - (b.cover ?? 2));
const bad = rows.filter((r) => r.cover != null);
console.log(JSON.stringify({
  ok: bad.length === 0, scanned, belowMin: bad.length, min,
  worst: bad.slice(0, 5).map((r) => `${r.id}@${r.cover}`),
  note: 'cover = 落在碰撞盒内的官方网格顶点比例；<1 表示该件有材料不被碰撞盒保护',
}));
if (bad.length) console.log(JSON.stringify(rows, null, 1));
