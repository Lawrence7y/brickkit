// 四步工作流 · 主体搭建（主会话负责）32 件
// 平台简化：塔顶只放一块 2×6 板作回转平台，SNOT 挂点全部直接叠在该板暴露凸点上。
import fs from 'node:fs';
import { createBuilder } from '../../src/core/builder.js';
import { validate, partBoxes, partsCollide } from '../../src/core/core.js';

const ROOT = 'D:/Project/brickkit';
const OUT = `${ROOT}/out/prd-v2/run-20261026-c/C/integration/fourstep/build/main.brick.json`;
const catalog = JSON.parse(fs.readFileSync(`${ROOT}/catalog/parts.json`, 'utf8'));
const C = { base: 71, tower: 14, accent: 0, deck: 72 };
const b = createBuilder({ catalog, meta: { name: '港口吊机 · 主体', front: '+z', note: '四步工作流 C3-3 main_body' } });

// 底座 8×10
const baseA = b.add('3036', C.base, { at: [0, 0, 0], step: 1 });
const baseB = b.add('3035', C.base, { at: [0, 0, 6], step: 1 });

// 塔柱 2×2 ×6 层（3036 stud = x*6+z，x3z2 = 20）
let tower = b.add('3003', C.tower, { on: baseA.id, stud: 20, step: 2 });
const towerParts = [tower];
for (let i = 1; i < 6; i++) { tower = b.add('3003', C.tower, { on: tower.id, stud: 3, step: 2 }); towerParts.push(tower); }

// 自动寻位（y=1 层放加固件）
function findSpot(partId, y, zPref, xPref) {
  const def = catalog.parts[partId];
  const [sx, sz] = def.size;
  const probe = { id: '__probe', part: partId, at: [0, 0, 0], up: '+y', rot: 0 };
  const existing = b.model().parts;
  for (const z of zPref) for (const x of xPref) {
    if (z + sz > 10 || x + sx > 8) continue;
    probe.at = [x, y, z];
    const pb = partBoxes(probe, def);
    let hit = false;
    for (const o of existing) if (partsCollide(probe, def, pb, o, catalog.parts[o.part], partBoxes(o, catalog.parts[o.part]))) { hit = true; break; }
    if (!hit) return [x, y, z];
  }
  return null;
}
const zOrder = [], xOrder = [];
for (let i = 0; i < 10; i++) zOrder.push(i);
for (let i = 0; i < 8; i++) xOrder.push(i);

for (const pid of ['3010', '3010', '3010', '3010', '3010', '3010', '3004', '3004', '3004', '3004']) {
  const spot = findSpot(pid, 1, zOrder, xOrder);
  if (!spot) throw new Error(`${pid} 无空位`);
  b.add(pid, C.tower, { at: spot, step: 3 });
}

// 回转平台：塔顶只放一块 2×6 板（12 凸点全暴露）
const top = towerParts[5];
const deck0 = b.add('3795', C.deck, { on: top.id, stud: 0, step: 4 });
// 3022 与 3020 作为平台加宽，放在塔柱下方 y=17 层的底座空位（不占压 deck0 顶面）
// → 改用底座延伸段顶面（y=1）避免与塔顶争空间
const deck1 = b.add('3022', C.deck, { at: [0, 1, 6], step: 4 });
const deck2 = b.add('3020', C.deck, { at: [4, 1, 6], step: 4 });

// SNOT 挂点：11211 宽 2 格 → stud 索引需隔 4（x 步进 2 格）
const snotJib0 = b.add('11211', C.accent, { on: deck0.id, stud: 0, step: 5 });   // x7-9
const snotJib1 = b.add('11211', C.accent, { on: deck0.id, stud: 4, step: 5 });   // x9-11
const snotCab0 = b.add('11211', C.accent, { on: deck0.id, stud: 8, step: 5 });   // x11-13
const snotCab1 = b.add('11211', C.accent, { on: deck0.id, stud: 1, step: 5 });   // z8 行 x7-9
const snotCab2 = b.add('11211', C.accent, { on: deck0.id, stud: 5, step: 5 });   // z8 行 x9-11

// 塔顶封盖（放在 deck1/deck2 外露凸点上）
b.add('3024', C.accent, { on: deck1.id, stud: 1, step: 6 });
b.add('3024', C.accent, { on: deck1.id, stud: 3, step: 6 });
b.add('3024', C.accent, { on: deck2.id, stud: 3, step: 6 });
b.add('63864', C.accent, { on: deck2.id, stud: 4, step: 6 });

b.assert();
const model = b.model();
const info = validate(model, catalog);
console.log(JSON.stringify({
  ok: info.errors.length === 0 && info.warnings.length === 0,
  errors: info.errors.slice(0, 4).map((e) => String(e.code || '') + ':' + String(e.msg || '').slice(0, 90)),
  warnings: info.warnings.slice(0, 4).map((w) => String(w.code || w.msg).slice(0, 80)),
  parts: model.parts.length, stats: info.stats,
  interfaces: { jib: [snotJib0.id, snotJib1.id], cab: [snotCab0.id, snotCab1.id, snotCab2.id] },
}, null, 2));
if (info.errors.length === 0 && info.warnings.length === 0) { b.save(OUT); console.log('saved', OUT); }
