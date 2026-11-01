// 灯笼权威重构 v9 —— 2026-10-28 最终实拍真值定案修复
// 修复 v8 偏差：
// 1. 顶盖淡紫板由 3020 (2x4) 修正为 2 块 3021 (Plate 2x3，color:31)
// 2. 底面绿十字由 3022心+4臂 修正为 6 块 3023 (Plate 1x2，color:10)，呈现中心贯通接缝与风车对称
// 3. 补齐实拍检出的品红 (Magenta，color:26) 边缘嵌件（底座与顶盖各 2 件）
// 4. 底座端板、顶盖端板与芯柱首节严格保留 status: 'uncertain'
// 5. 修复 modules 字段持久化，保证 JSON、查看器与拼装图纸绝对同源

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

const PINK = 29, RED = 4, PURPLE = 31, BLUE = 272, GREEN = 10, MAGENTA = 26;
const N = 7;
const COLUMN_PLATES = N * 3; // 21 plates
const CORE_PLATES = N * 3;   // 21 plates

// 芯柱颜色序列（自底座端到棚顶端，共 7 颗）
const CORE_SEQ = [
  { color: GREEN, name: '绿', status: 'uncertain' },
  { color: RED, name: '红', status: 'confirmed' },
  { color: RED, name: '红', status: 'confirmed' },
  { color: PINK, name: '亮粉', status: 'confirmed' },
  { color: RED, name: '红', status: 'confirmed' },
  { color: PINK, name: '亮粉', status: 'confirmed' },
  { color: RED, name: '红', status: 'confirmed' },
];

const b = createBuilder({
  catalog,
  meta: {
    name: '粉紫灯笼（实物高精度重构 v9 · 权威定案修复）',
    createdAt: new Date().toISOString().slice(0, 10),
    front: '+z',
    photoSet: 'lantern.photos.gt.json',
    observations: 'lantern.observations.v9.json',
    buildScript: 'examples/gen-lantern-v9.mjs',
    verificationPriority: '结构正确（零件/连接/接口）> 尺寸比例 > 颜色',
    description:
      '2026-10-28 最终实物定案修复版本 v9。针对 4 张原始高精度正交与平视真值照片严格核对：'
      + '顶盖淡紫板核实为 2 块 3021 (2x3)；底面绿色构件修正为 6 块 3023 (1x2) 拼接（中心贯通拼缝，彻底摒弃 3022 假设）；'
      + '补齐侧面检出的品红 (Magenta 26) 边缘嵌件；底板、顶板及芯柱首件严格保留 uncertain 存疑状态；修复模块定义持久化。',
  },
});

// ================================================================
// Step 1：底座模块（module: 'base'）
// ================================================================
// 底座端板 6×6（y=0，内部结构未直视，保留 uncertain）
const basePlate = b.add('3958', BLUE, {
  at: [0, 0, 0], step: 1, module: 'base', status: 'uncertain',
  evidence: ['lantern_gt_base_ortho', 'lantern_gt_side_flat_1'],
  note: '底座承载端板 6×6（正交底视外沿与侧视平拍可见边缘，内部结构不可直视，保留存疑）',
});

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

// —— 1b. 绿色底面构件：6 块 3023（亮绿 10），under 扣在端板底面（y=-1）
// 2 块中心并排件（中缝贯通）
b.add('3023', GREEN, {
  on: basePlate.id, stud: antiStudAt(basePlate, 2, 2), receptor: 0, under: true, rot: 0,
  step: 1, module: 'base', status: 'confirmed', evidence: ['lantern_gt_base_ortho'],
  note: '底面中心绿板 1 (3023)，与中心绿板 2 并排形成 z=3 贯通中缝',
});
b.add('3023', GREEN, {
  on: basePlate.id, stud: antiStudAt(basePlate, 2, 3), receptor: 0, under: true, rot: 0,
  step: 1, module: 'base', status: 'confirmed', evidence: ['lantern_gt_base_ortho'],
  note: '底面中心绿板 2 (3023)，覆盖 x:2..4, z:3..4',
});

// 4 块外展臂（覆盖边缘，构成风车对称）
b.add('3023', GREEN, {
  on: basePlate.id, stud: antiStudAt(basePlate, 0, 2), receptor: 0, under: true, rot: 0,
  step: 1, module: 'base', status: 'confirmed', evidence: ['lantern_gt_base_ortho'],
  note: '绿十字 -x 臂 (3023)',
});
b.add('3023', GREEN, {
  on: basePlate.id, stud: antiStudAt(basePlate, 4, 3), receptor: 0, under: true, rot: 0,
  step: 1, module: 'base', status: 'confirmed', evidence: ['lantern_gt_base_ortho'],
  note: '绿十字 +x 臂 (3023)',
});
b.add('3023', GREEN, {
  on: basePlate.id, stud: antiStudAt(basePlate, 3, 1), receptor: 0, under: true, rot: 90,
  step: 1, module: 'base', status: 'confirmed', evidence: ['lantern_gt_base_ortho'],
  note: '绿十字 -z 臂 (3023)',
});
b.add('3023', GREEN, {
  on: basePlate.id, stud: antiStudAt(basePlate, 2, 5), receptor: 0, under: true, rot: 90,
  step: 1, module: 'base', status: 'confirmed', evidence: ['lantern_gt_base_ortho'],
  note: '绿十字 +z 臂 (3023)',
});

// —— 1c. 粉支脚：4 块 3023（亮粉 29），外挑 1 格
const FEET = [
  { x: 0, z: 3, rot: 0, rec: 1, dir: '-x' },
  { x: 5, z: 2, rot: 0, rec: 0, dir: '+x' },
  { x: 2, z: 0, rot: 90, rec: 0, dir: '-z' },
  { x: 3, z: 5, rot: 90, rec: 1, dir: '+z' },
];
for (const f of FEET) {
  b.add('3023', PINK, {
    on: basePlate.id, stud: antiStudAt(basePlate, f.x, f.z),
    rot: f.rot, receptor: f.rec, under: true,
    step: 1, module: 'base', status: 'confirmed',
    evidence: ['lantern_gt_base_ortho', 'lantern_gt_side_flat_1'],
    note: `底座粉支脚 ${f.dir}（扣合于外沿并外挑 1 格）`,
  });
}

// —— 1d. 品红嵌件：2 块 3023（品红 26），置于侧边中段
b.add('3023', MAGENTA, {
  on: basePlate.id, stud: antiStudAt(basePlate, 0, 0),
  rot: 0, receptor: 0, under: true,
  step: 1, module: 'base', status: 'confirmed',
  evidence: ['lantern_gt_side_flat_2'],
  note: '底座侧边品红嵌件 1（照片 4 测得品红结构）',
});
b.add('3023', MAGENTA, {
  on: basePlate.id, stud: antiStudAt(basePlate, 4, 5),
  rot: 0, receptor: 0, under: true,
  step: 1, module: 'base', status: 'confirmed',
  evidence: ['lantern_gt_side_flat_2'],
  note: '底座侧边品红嵌件 2（照片 4 测得品红结构）',
});

// ================================================================
// Step 2：四角柱模块（module: 'columns'）—— 3062b × 7 颗 × 4 根
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
      note: `角柱 ${n + 1} 第 ${u + 1}/${N} 颗·3062b`,
    });
    stack.push(brick.id);
    parent = brick; stud = 0;
  }
  columnStacks.push(stack);
}
const COLUMN_TOP = Y_TOP + COLUMN_PLATES; // 1 + 21 = 22

// ================================================================
// Step 3：中央芯柱模块（module: 'core'）—— 3941 × 7 颗，与柱等长顶满
// ================================================================
let coreParent = basePlate.id, coreStud = studAt(basePlate, 2, 2);
for (let i = 0; i < N; i++) {
  const c = CORE_SEQ[i];
  const p = b.add('3941', c.color, {
    on: coreParent, stud: coreStud, step: 3, module: 'core', status: c.status,
    evidence: ['lantern_gt_side_flat_1', 'lantern_gt_side_flat_2'],
    note: `芯柱 ${i + 1}/${N}：3941 ${c.name}${c.status === 'uncertain' ? '（首节内部咬合不可视，保留存疑）' : ''}`,
  });
  coreParent = p.id; coreStud = 0;
}
const CORE_TOP = Y_TOP + CORE_PLATES; // 1 + 21 = 22

// ================================================================
// Step 4：棚顶承载端板 6×6（y=22，保留 uncertain）
// ================================================================
const colTopId = (x, z) => {
  const idx = CORNERS.findIndex(([cx, cz]) => cx === x && cz === z);
  const stack = columnStacks[idx];
  return stack[stack.length - 1];
};
const Y_CANOPY = COLUMN_TOP;
const canopyPlate = b.add('3958', BLUE, {
  on: colTopId(0, 0), stud: 0, step: 4, module: 'canopy', status: 'uncertain',
  evidence: ['lantern_gt_top_ortho', 'lantern_gt_side_flat_1'],
  note: '棚顶承载端板 6×6（四角柱顶与芯柱顶共同承托，内部咬合面不可直视，保留存疑）',
});

// ================================================================
// Step 5：棚顶装饰层（module: 'canopy'）—— 淡紫 3021 (2×3) × 2 + 粉框与品红嵌件
// ================================================================
// 2 块淡紫 3021 (2×3 板) 并排位于中央 (覆盖 x:1..5, z:1..4)
b.add('3021', PURPLE, {
  on: canopyPlate.id, stud: studAt(canopyPlate, 1, 3), rot: 90, receptor: 0,
  step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'],
  note: '淡紫板 1 (3021 2×3，实拍正交顶视清晰测定 2×3 凸点阵)',
});
b.add('3021', PURPLE, {
  on: canopyPlate.id, stud: studAt(canopyPlate, 3, 3), rot: 90, receptor: 0,
  step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'],
  note: '淡紫板 2 (3021 2×3，并排充满内区 4×3 格)',
});

// 外围粉框第 1 层：10 块 3023 (粉) + 2 块 3023 (品红嵌件)
// x=0 边 (3 块 3023, rot: 90)
const r1 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 0, 1), rot: 90, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶粉框角件' });
const r2 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 0, 3), rot: 90, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶粉框侧边' });
const r3 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 0, 5), rot: 90, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶粉框角件' });

// x=5 边 (3 块 3023, rot: 90)
const r4 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 5, 1), rot: 90, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶粉框角件' });
const r5 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 5, 3), rot: 90, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶粉框侧边' });
const r6 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 5, 5), rot: 90, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶粉框角件' });

// z=0 边 (2 块 3023, rot: 0: 1 块品红 + 1 块粉)
const r7 = b.add('3023', MAGENTA, { on: canopyPlate.id, stud: studAt(canopyPlate, 1, 0), rot: 0, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho', 'lantern_gt_side_flat_2'], note: '棚顶品红嵌件 1' });
const r8 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 3, 0), rot: 0, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶粉框端头' });

// z=4 边 (2 块 3023, rot: 0, 粉)
const r9 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 1, 4), rot: 0, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶收口粉板 1' });
const r10 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 3, 4), rot: 0, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶收口粉板 2' });

// z=5 边 (2 块 3023, rot: 0: 1 块粉 + 1 块品红)
const r11 = b.add('3023', PINK, { on: canopyPlate.id, stud: studAt(canopyPlate, 1, 5), rot: 0, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶粉框端头' });
const r12 = b.add('3023', MAGENTA, { on: canopyPlate.id, stud: studAt(canopyPlate, 3, 5), rot: 0, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho', 'lantern_gt_side_flat_2'], note: '棚顶品红嵌件 2' });

// 棚顶第 2 层高台（四边中段 4 块 3023）
b.add('3023', PINK, { on: r2.id, stud: studAt(r2, 0, 3), rot: 90, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶高台第 2 层 -x' });
b.add('3023', PINK, { on: r5.id, stud: studAt(r5, 5, 3), rot: 90, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶高台第 2 层 +x' });
b.add('3023', PINK, { on: r7.id, stud: studAt(r7, 2, 0), rot: 0, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶高台第 2 层 -z' });
b.add('3023', PINK, { on: r11.id, stud: studAt(r11, 2, 5), rot: 0, receptor: 0, step: 5, module: 'canopy', status: 'confirmed', evidence: ['lantern_gt_top_ortho'], note: '棚顶高台第 2 层 +z' });

// ================================================================
// Step 6：生成与持久化（修复 modules 字段，保持多端同源）
// ================================================================
b.assert(); // 运行零穿模与目录合法性断言

const model = b.model();
model.modules = [
  { id: 'base', label: '底座（端板 + 6绿板接缝十字 + 4粉支脚 + 2品红嵌件）', explode: [0, -16, 0] },
  { id: 'columns', label: `四角柱（4 根 × ${N} 颗 3062b）`, explode: [-16, 0, 0] },
  { id: 'core', label: `中央芯柱（${N} 颗 3941，两端顶满齐平）`, explode: [16, 0, 0] },
  { id: 'canopy', label: '棚顶（端板 + 2淡紫3021板 + 粉框品红嵌件 + 双层高台）', explode: [0, 18, 0] },
];

const outFile = path.join(ROOT, 'examples/lantern.reconstructed.v9.brick.json');
fs.writeFileSync(outFile, JSON.stringify(model, null, 2), 'utf8');

const confCount = model.parts.filter(p => p.status === 'confirmed').length;
const uncCount = model.parts.filter(p => p.status === 'uncertain').length;

console.log(`\n========================================`);
console.log(`v9 模型生成成功！零件总数：${model.parts.length} 件`);
console.log(`角柱：4 根 × ${N} 颗 3062b = ${COLUMN_PLATES} 片，柱顶 y=${COLUMN_TOP}`);
console.log(`芯柱：${N} 颗 3941 = ${CORE_PLATES} 片，芯顶 y=${CORE_TOP}（两端顶满齐平）`);
console.log(`棚顶端板层 y=${Y_CANOPY}`);
console.log(`模块数量：${model.modules.length} 个（base, columns, core, canopy）`);
console.log(`Confirmed 零件：${confCount} 件 (${(confCount/model.parts.length*100).toFixed(1)}%)`);
console.log(`Uncertain 零件：${uncCount} 件 (${(uncCount/model.parts.length*100).toFixed(1)}%)`);
console.log(`文件写入：${outFile}`);
console.log(`========================================\n`);
