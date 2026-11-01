// 灯笼权威重构 v8 —— 2026-10-28 最终实拍真值定案（基于用户补充的 4 张高精度正交平拍实照）
//
// ── 权威定案要素（由 4 张补充照片直接证明）────────────────────────────────
//
// 1. 底座端面（照片 1：lantern_gt_base_ortho.jpg）：
//    · 中心完全由实体绿色构件覆盖，绝对无通孔，彻底排除候选 A（中空框/悬挂芯）；
//    · 绿色构件在数据中严格对应绿色 3022（心）+ 4×3023（臂）倒扣在 6×6 深蓝板底部；
//    · 4 只粉色 3023 支脚真实外挑；
//
// 2. 柱身与芯柱节数 N 严格为 7（照片 2、4：lantern_gt_side_flat_1/2.jpg）：
//    · 4 根角柱每根严格由 7 颗 3062b（粉色圆砖）叠成（7 × 3 = 21 片高）；
//    · 中央芯柱由 7 颗 3941（2×2 圆砖）叠成，高度 21 片，柱芯两端完全齐平；
//    · 芯柱 7 颗色段自底至顶严格为：绿（10）→ 红（4）→ 红（4）→ 亮粉（29）→ 红（4）→ 亮粉（29）→ 红（4）；
//
// 3. 棚顶端面（照片 3：lantern_gt_top_ortho.jpg）：
//    · 6×6 深蓝端板层高 y=22（顶满 7 颗柱/芯砖，高度 1 + 21 = 22）；
//    · 内嵌两块 2×4 淡紫板（3020，color:31）并排，中缝贯通；
//    · 外围粉框由 10 块 3023（亮粉）单层围合，并在 4 边中段叠放第二层粉十字高台（4 块 3023）；
//
// 全机共 62 件零件，全部为 confirmed 状态，零存疑、零穿模、零悬空。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder } from '../src/core/builder.js';
import { partConnectors, partBoxes, mergeCatalogParts } from '../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const catalog = {
  parts: mergeCatalogParts(readJSON('catalog/parts-ldraw.json').parts, readJSON('catalog/parts.json').parts),
  colors: readJSON('catalog/colors.json').colors,
};

const PINK = 29, RED = 4, PURPLE = 31, BLUE = 272, GREEN = 10;
const N = 7;
const COLUMN_PLATES = N * 3; // 21 plates
const CORE_PLATES = N * 3;   // 21 plates

// 芯柱颜色序列（自底座端到棚顶端，共 7 颗）
const CORE_SEQ = [
  { color: GREEN, name: '绿' },
  { color: RED, name: '红' },
  { color: RED, name: '红' },
  { color: PINK, name: '亮粉' },
  { color: RED, name: '红' },
  { color: PINK, name: '亮粉' },
  { color: RED, name: '红' },
];

const b = createBuilder({
  catalog,
  meta: {
    name: '粉紫灯笼（实物权威重构 v8 · 最终定案）',
    createdAt: new Date().toISOString().slice(0, 10),
    front: '+z',
    photoSet: 'lantern.photos.gt.json',
    observations: 'lantern.observations.v8.json',
    buildScript: 'examples/gen-lantern-v8.mjs',
    verificationPriority: '结构正确（零件/连接/接口）> 尺寸比例 > 颜色',
    description:
      '2026-10-28 最终实物定案版本。根据用户拍摄的 4 张正交与平视真值照片直接裁决：'
      + '柱身与芯柱节数 N 严格为 7；底座端面为实心 6x6 深蓝板 + 绿色十字(3022心+4×3023臂) + 4外挑粉支脚，彻底排除中空通孔候选 A；'
      + '芯柱为 1 绿 + 2 红 + 1 粉 + 1 红 + 1 粉 + 1 红 共 7 颗 2x2 圆砖；棚顶为 2 块淡紫 2x4 板并排 + 双层粉框。'
      + '全机 62 件全部 confirmed，0 存疑，0 穿模，1 独立连通分量。',
  },
});

// ================================================================
// Step 1：底座端板 6×6（y=0）
// ================================================================
const basePlate = b.add('3958', BLUE, {
  at: [0, 0, 0], step: 1, module: 'base', status: 'confirmed',
  evidence: ['lantern_gt_base_ortho', 'lantern_gt_side_flat_1'],
  note: '底座端板 6×6（实拍正交底视确认为实心板，实心蓝底承载外扣绿十字）',
});

const cellOwner = new Map();
for (const bx of partBoxes(basePlate, catalog.parts[basePlate.part])) {
  for (let x = bx.x0; x < bx.x1; x++) for (let z = bx.z0; z < bx.z1; z++) cellOwner.set(`${x},${z}`, basePlate);
}

function studAt(part, wx, wz) {
  const conn = partConnectors(part, catalog.parts[part.part]);
  const found = conn.studs.find((s) =>
    Math.abs(s.pos[0] - (wx + 0.5)) < 1e-6 && Math.abs(s.pos[2] - (wz + 0.5)) < 1e-6);
  if (!found) throw new Error(`${part.part}#${part.id} 上找不到格点 (${wx},${wz}) 的顶面凸点`);
  return found.index;
}
function antiStudAt(part, wx, wz) {
  const conn = partConnectors(part, catalog.parts[part.part]);
  const found = conn.receptors.find((r) =>
    Math.abs(r.pos[0] - (wx + 0.5)) < 1e-6 && Math.abs(r.pos[2] - (wz + 0.5)) < 1e-6);
  if (!found) throw new Error(`${part.part}#${part.id} 上找不到格点 (${wx},${wz}) 的底面底孔`);
  return found.index;
}

// —— 1b. 绿十字：中心 3022 + 四臂 3023，under 扣在端板底面（y=-1）
b.add('3022', GREEN, {
  on: basePlate.id, stud: antiStudAt(basePlate, 2, 2), receptor: 0, under: true,
  step: 1, module: 'base', status: 'confirmed', evidence: ['lantern_gt_base_ortho'],
  note: '绿十字中心 3022 2×2 板（实拍正底视确认完全覆盖中心，无通孔）',
});
for (const arm of [
  { x: 2, z: 1, rot: 0, rec: 0, dir: '-z' },
  { x: 2, z: 4, rot: 0, rec: 0, dir: '+z' },
  { x: 1, z: 2, rot: 90, rec: 0, dir: '-x' },
  { x: 4, z: 2, rot: 90, rec: 0, dir: '+x' },
]) {
  b.add('3023', GREEN, {
    on: basePlate.id, stud: antiStudAt(basePlate, arm.x, arm.z),
    rot: arm.rot, receptor: arm.rec, under: true,
    step: 1, module: 'base', status: 'confirmed', evidence: ['lantern_gt_base_ortho'],
    note: `绿十字 ${arm.dir} 臂 1×2`,
  });
}

// —— 1c. 粉支脚：真实 under 扣合、外挑 1 格
const FEET = [
  { x: 0, z: 2, rot: 0, rec: 1, dir: '-x' },
  { x: 5, z: 2, rot: 0, rec: 0, dir: '+x' },
  { x: 2, z: 0, rot: 90, rec: 0, dir: '-z' },
  { x: 2, z: 5, rot: 90, rec: 1, dir: '+z' },
];
for (const f of FEET) {
  b.add('3023', PINK, {
    on: basePlate.id, stud: antiStudAt(basePlate, f.x, f.z),
    rot: f.rot, receptor: f.rec, under: true,
    step: 1, module: 'base', status: 'confirmed',
    evidence: ['lantern_gt_base_ortho', 'lantern_gt_side_flat_1'],
    note: `粉支脚 ${f.dir}（底孔扣合，外挑 1 格）`,
  });
}

// ================================================================
// Step 2：四角柱 —— 纯 3062b × 7 颗（实拍侧平视明确证明 N=7）
// ================================================================
const Y_TOP = 1;
const CORNERS = [[0, 0], [5, 0], [0, 5], [5, 5]];
const columnStacks = [];
for (const [n, [cx, cz]] of CORNERS.entries()) {
  let parent = basePlate, stud = studAt(basePlate, cx, cz);
  const stack = [];
  for (let u = 0; u < N; u++) {
    const brick = b.add('3062b', PINK, {
      on: parent.id, stud, step: 2, module: 'columns', status: 'confirmed',
      evidence: ['lantern_gt_side_flat_1', 'lantern_gt_side_flat_2'],
      note: `角柱 ${n + 1} 第 ${u + 1}/${N} 颗·3062b（3 片）`,
    });
    stack.push(brick.id);
    parent = brick; stud = 0;
  }
  columnStacks.push(stack);
}
const COLUMN_TOP = Y_TOP + COLUMN_PLATES; // 1 + 21 = 22

// ================================================================
// Step 3：中央芯柱 —— 3941 × 7 颗，与柱等长，两端顶满端板
// ================================================================
const coreBase = cellOwner.get('2,2');
let coreParent = coreBase.id, coreStud = studAt(coreBase, 2, 2);
for (let i = 0; i < N; i++) {
  const c = CORE_SEQ[i];
  const p = b.add('3941', c.color, {
    on: coreParent, stud: coreStud, step: 3, module: 'core', status: 'confirmed',
    evidence: ['lantern_gt_side_flat_1', 'lantern_gt_side_flat_2'],
    note: `芯柱 ${i + 1}/${N}：3941 ${c.name}（实拍侧平视确认色段）`,
  });
  coreParent = p.id; coreStud = 0;
}
const CORE_TOP = Y_TOP + CORE_PLATES; // 1 + 21 = 22（两端顶满齐平）

// ================================================================
// Step 4：棚顶端板 6×6（y=22）
// ================================================================
const colTopId = (x, z) => {
  const idx = CORNERS.findIndex(([cx, cz]) => cx === x && cz === z);
  const stack = columnStacks[idx];
  return stack[stack.length - 1];
};
const Y_CANOPY = COLUMN_TOP;
const canopyPlate = b.add('3958', BLUE, {
  on: colTopId(0, 0), stud: 0, step: 4, module: 'canopy', status: 'confirmed',
  evidence: ['lantern_gt_top_ortho', 'lantern_gt_side_flat_1'],
  note: '棚顶端板 6×6（扣在角柱 1 顶，另三柱顶与芯柱顶同时承托）',
});

// ================================================================
// Step 5：棚顶装饰层 —— 淡紫 2×4 板 × 2 并排 + 外围粉框与高台
// ================================================================
const canopyOwner = new Map();
for (const bx of partBoxes(canopyPlate, catalog.parts[canopyPlate.part])) {
  for (let x = bx.x0; x < bx.x1; x++) for (let z = bx.z0; z < bx.z1; z++) canopyOwner.set(`${x},${z}`, canopyPlate);
}
function addOnCanopy(part, color, x, z, extra = {}) {
  const host = canopyOwner.get(`${x},${z}`);
  if (!host) throw new Error(`棚顶端板在格点 (${x},${z}) 没有零件`);
  return b.add(part, color, {
    on: host.id, stud: studAt(host, x, z), step: extra.step ?? 5, module: 'canopy', status: 'confirmed', ...extra,
  });
}
for (let k = 0; k < 2; k++) {
  addOnCanopy('3020', PURPLE, 1, 1 + k * 2, {
    evidence: ['lantern_gt_top_ortho'],
    note: `淡紫 2×4 第 ${k + 1}/2 块（并排充满内区 4×4 格）`,
  });
}
const ring = [
  { x: 0, z: 0, rot: 90, rec: 1 }, { x: 0, z: 2, rot: 90, rec: 1 }, { x: 0, z: 4, rot: 90, rec: 1 },
  { x: 5, z: 0, rot: 90, rec: 1 }, { x: 5, z: 2, rot: 90, rec: 1 }, { x: 5, z: 4, rot: 90, rec: 1 },
  { x: 1, z: 0, rot: 0, rec: 0 }, { x: 3, z: 0, rot: 0, rec: 0 },
  { x: 1, z: 5, rot: 0, rec: 0 }, { x: 3, z: 5, rot: 0, rec: 0 },
];
const ringParts = [];
for (const r of ring) {
  ringParts.push(addOnCanopy('3023', PINK, r.x, r.z, {
    rot: r.rot, receptor: r.rec,
    evidence: ['lantern_gt_top_ortho'],
    note: '棚面粉框第一层（外圈 1 格宽）',
  }));
}
for (const r of [
  { x: 0, z: 2, rot: 90 }, { x: 5, z: 2, rot: 90 },
  { x: 2, z: 0, rot: 0 }, { x: 2, z: 5, rot: 0 },
  { x: 2, z: 5, rot: 0 },
]) {
  // 仅在 4 边中段放置第 2 层高台
}
const tier2 = [
  { x: 0, z: 2, rot: 90 }, { x: 5, z: 2, rot: 90 },
  { x: 2, z: 0, rot: 0 }, { x: 2, z: 5, rot: 0 },
];
for (const r of tier2) {
  const host = ringParts.find((p) => {
    const bx = partBoxes(p, catalog.parts[p.part])[0];
    return bx && bx.x0 <= r.x && r.x < bx.x1 && bx.z0 <= r.z && r.z < bx.z1;
  });
  if (!host) throw new Error(`十字高台 (${r.x},${r.z}) 下方没有粉框件`);
  b.add('3023', PINK, {
    on: host.id, stud: studAt(host, r.x, r.z), rot: r.rot, receptor: 0,
    step: 5, module: 'canopy', status: 'confirmed',
    evidence: ['lantern_gt_top_ortho'],
    note: '粉十字高台第二层（四边中段叠高）',
  });
}

// —— 模块定义 ——
const model = b.model();
model.modules = [
  { id: 'base', label: '底座（端板 + 绿十字 + 粉支脚）', explode: [0, -16, 0] },
  { id: 'columns', label: `四角柱（3062b × ${N}）`, explode: [-16, 0, 0] },
  { id: 'core', label: `中央芯柱（3941 × ${N}，两端顶满）`, explode: [16, 0, 0] },
  { id: 'canopy', label: '棚顶（端板 + 淡紫板 + 双层粉十字）', explode: [0, 18, 0] },
];

const outFile = path.join(ROOT, 'examples/lantern.reconstructed.v8.brick.json');
b.assert(); // 校验是否有穿模或非法零件
b.save(outFile);

console.log(`\n========================================`);
console.log(`v8 模型生成成功！零件总数：${model.parts.length} 件`);
console.log(`角柱：4 根 × ${N} 颗 3062b = ${COLUMN_PLATES} 片，柱顶 y=${COLUMN_TOP}`);
console.log(`芯柱：${N} 颗 3941 = ${CORE_PLATES} 片，芯顶 y=${CORE_TOP}（两端完全顶满）`);
console.log(`棚顶端板层 y=${Y_CANOPY}`);
console.log(`Confirmed 零件：${model.parts.filter(p => p.status === 'confirmed').length} 件，Uncertain：${model.parts.filter(p => p.status === 'uncertain').length} 件`);
console.log(`文件写入：${outFile}`);
console.log(`========================================\n`);
