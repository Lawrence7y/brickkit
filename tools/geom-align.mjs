// LDraw 几何对齐审计：检验 loader 产出的零件几何是否满足「占地中心原点、底面 y=0」约定。
// loader 与 geom.js partGeometry 共用这个约定（rot/up 由 baseMatrix 施加），一旦某件几何被整体抬高/
// 侧移，LDraw 渲染就与碰撞体、与参数化几何错位，而渲染图本身看起来「完整」——只有量化才暴露。
//
// 判定三项（单位：格，1 格 = 20 LDU = 8mm）：
//   yMin   几何底面应在 0（容差 0.06 格 = 1/4 片）
//   cx/cz  几何在 x/z 上的中心应在 0（占地不对称件，如 1×1 圆砖侧凸点，允许 0.5 格内偏差）
//   spanX/spanZ 应在 def.size 附近（差 > 0.6 格 = 几何尺寸与目录 size 明显不符）
//
// 用法：node tools/geom-align.mjs [件号...] [--min 0.01] [--limit 40]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPart, createResolver } from '../src/ldraw/loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const ext = readJSON(path.join(ROOT, 'catalog/parts-ldraw.json')).parts;
const curated = readJSON(path.join(ROOT, 'catalog/parts.json')).parts;
const parts = { ...ext, ...curated };

const argv = process.argv.slice(2);
let limit = 40;
const lIdx = argv.indexOf('--limit');
if (lIdx >= 0) { limit = Number(argv[lIdx + 1]); argv.splice(lIdx, 2); }
const ids = argv.length ? argv : Object.keys(parts);
const resolve = createResolver();

const rows = [];
let scanned = 0, missing = 0;
for (const id of ids) {
  const def = parts[id];
  if (!def) continue;
  const built = buildPart({ partId: id, color: 0, def, resolve });
  if (!built) { missing++; continue; }
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], n = 0;
  for (const arr of Object.values(built.groups)) {
    for (let i = 0; i + 2 < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (arr[i + k] < mn[k]) mn[k] = arr[i + k];
        if (arr[i + k] > mx[k]) mx[k] = arr[i + k];
      }
      n++;
    }
  }
  if (!n) { rows.push({ id, note: '无实体面' }); continue; }
  scanned++;
  const cx = (mn[0] + mx[0]) / 2, cz = (mn[2] + mx[2]) / 2;
  const spanX = mx[0] - mn[0], spanZ = mx[2] - mn[2];
  const [sx, sz] = def.size || [0, 0];
  const bad = [];
  if (Math.abs(mn[1]) > 0.06) bad.push('yMin');
  if (Math.abs(cx) > 0.5) bad.push('cx');
  if (Math.abs(cz) > 0.5) bad.push('cz');
  if (Math.abs(spanX - sx) > 0.6) bad.push('spanX');
  if (Math.abs(spanZ - sz) > 0.6) bad.push('spanZ');
  if (bad.length) {
    rows.push({ id, kind: def.kind, size: def.size, h: def.h, ldrawOrigin: def.ldrawOrigin ?? null, bad,
      yMin: Math.round(mn[1] * 100) / 100, cx: Math.round(cx * 100) / 100, cz: Math.round(cz * 100) / 100,
      span: [Math.round(spanX * 100) / 100, Math.round(spanZ * 100) / 100] });
  }
}
const byBad = {};
for (const r of rows) for (const b of r.bad || []) byBad[b] = (byBad[b] || 0) + 1;
console.log(JSON.stringify({ ok: rows.length === 0, scanned, noDat: missing, flagged: rows.length, byBad, limit }));
for (const r of rows.slice(0, limit)) console.log(JSON.stringify(r));
