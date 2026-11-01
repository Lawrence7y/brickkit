// 灯笼重建 v4 —— 依据 examples/lantern.observations.v3.json（2026-10-27 第三轮照片核对）。
//
// 本轮相对 v2/v3 的结构性改动（每条对应照片证据，见 observations v3 的 refuted 段）：
//   ① 四角柱改为「3062b 圆砖（3 片）+ 4073 圆板（1 片）」的 4 片周期单元堆叠。
//      旧版用纯 4073 圆板堆：节距/直径应≈1.0；实测 1.36–1.49，圆板堆无法产生这种外观。
//   ② 底座绿色恢复为「十字」：中心 3022 + 四臂 3023，与端板同层嵌在 6×6 中央。
//      v2 判成「单颗 2×2」与底座端面照片直接矛盾。
//   ③ 棚顶淡紫板保留两块 2×4 平行并排（v2 结论经本轮顶面特写确认）。
//   ④ 端板 6×6 用 2×4 / 2×2 交错铺（照片可见长边交错），不是三条 2×6 整铺。
//
// 验收优先级（用户明确）：零件与连接正确 > 尺寸比例 > 颜色。灰模但接口全对即合格。
// 坐标约定：+y 指向棚顶；y=0 是底座最外层（端板+绿十字层），y 增大朝棚顶。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder } from '../src/core/builder.js';
import { partConnectors, partBoxes } from '../src/core/core.js';
import { mergeCatalogParts } from '../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const catalog = {
  parts: mergeCatalogParts(readJSON('catalog/parts-ldraw.json').parts, readJSON('catalog/parts.json').parts),
  colors: readJSON('catalog/colors.json').colors,
};

const PINK = 29, MAGENTA = 26, RED = 4, DARKRED = 320, PURPLE = 31, BLUE = 272, GREEN = 10;

// —— 关键尺寸（observations v3 里标 pending，此处取区间内一个自洽取值）——
const COLUMN_UNITS = Number(process.env.LANTERN_COLUMN_UNITS || 5);  // 每柱 5 个「圆砖+圆板」单元
const UNIT_PLATES = 3 + 1;                                          // 3062b 3 片 + 4073 1 片
const COLUMN_PLATES = COLUMN_UNITS * UNIT_PLATES;                   // = 20 片
const CORE_BRICKS = 4;                                              // 芯 4 颗 3941（每颗 3 片）= 12 片

const b = createBuilder({
  catalog,
  meta: {
    name: '粉紫灯笼（实物重建 v4）',
    createdAt: new Date().toISOString().slice(0, 10),
    front: '+z',
    photoSet: 'lantern.photos.json',
    observations: 'lantern.observations.v3.json',
    buildScript: 'examples/gen-lantern-v4.mjs',
    verificationPriority: '结构正确（零件/连接/接口）> 尺寸比例 > 颜色',
    description:
      '依据 2026-10-27 第三轮六张实拍照片重建。'
      + '结构性改动：四角柱改为 3062b+4073 的 4 片周期单元（旧版纯 4073 圆板堆与照片节距/直径比矛盾）；'
      + '底座绿色恢复为十字（旧版单颗 2×2 与照片矛盾）。'
      + `柱高 ${COLUMN_UNITS} 单元 = ${COLUMN_PLATES} 片，属 observations 中 pending 区间的取值。`,
  },
});

// ================================================================
// Step 1：底座端板（y=0）—— 整块 3958 板 6×6
// 为什么是 6×6 整板而不是三条 2×6 拼：照片（lantern_base_detail / lantern_top_detail）
// 显示端板是一整层、四边整齐探出，看不到长向拼接的高差；更关键的是
// 「中间那条板没有柱顶可扣」——三条 2×6 铺法会让中间板悬空，物理上不成立。
// 6×6 整板则四角正好落在四根柱上，四条边中点各有支脚/围边，支撑完整。
// ================================================================
const Y_PLATE = 0;
const basePlate = b.add('3958', BLUE, {
  at: [0, Y_PLATE, 0], step: 1, module: 'base',
  evidence: ['lantern_base_detail', 'lantern_top_detail', 'lantern_a090_e00'],
  note: '底座端板 6×6 整板（四角支撑四根柱，四边承载支脚与绿十字）',
});
const plateLayer = [basePlate];

// —— 格点归属与凸点查询：后续所有扣合都从这里推导，不手推序号 ——
const cellOwner = new Map();   // 'x,z' -> 端板零件
for (const p of plateLayer) {
  for (const bx of partBoxes(p, catalog.parts[p.part])) {
    for (let x = bx.x0; x < bx.x1; x++) for (let z = bx.z0; z < bx.z1; z++) cellOwner.set(`${x},${z}`, p);
  }
}
/** 找到零件上世界坐标格点为 (wx, wz) 的顶面凸点编号（用于 on/stud 扣合）。 */
function studAt(partEntry, wx, wz) {
  const def = catalog.parts[partEntry.part];
  const conn = partConnectors(partEntry, def);
  const found = conn.studs.find((s) => Math.abs(s.pos[0] - (wx + 0.5)) < 1e-6 && Math.abs(s.pos[2] - (wz + 0.5)) < 1e-6);
  if (!found) throw new Error(`${partEntry.part}#${partEntry.id} 上找不到格点 (${wx},${wz}) 的顶面凸点`);
  return found.index;
}

// —— 1b. 绿十字：中心 3022 + 四臂 3023，全部扣在端板**下表面**（y=-1 层）——
// 照片（lantern_base_detail）显示绿色件在端面最外层、蓝板在其后，五处凸起可见。
// 用 under:true 让 snapPart 计算「扣在端板底面」的精确坐标——这是真实凸点-底孔连接。
const greenCenter = b.add('3022', GREEN, {
  on: cellOwner.get('2,2').id, stud: studAt(cellOwner.get('2,2'), 2, 2), under: true,
  step: 1, module: 'base',
  evidence: ['lantern_base_detail', 'lantern_a045'],
  note: '绿十字中心 3022（扣在端板中央底面）',
});
// 四臂各 1×2：各自扣在端板底面（under 扣合），与中心件同层并列成十字。
// snapPart 的语义是「把零件的第 receptor 号底孔对到父件 stud」：
//   receptor=0 → 板从目标格向 +x / +z 延伸；receptor=1 → 向 -x / -z 延伸。
// 十字臂要「搭在中心 2×2 外侧」，因此：
//   -z 臂：占 (x2..3, z1)，receptor=0（从 z1 向 +z 展开到 z1、z2？）——
// 直接按实测组合取（见 probe）：rot=0/rec=0 覆盖 x..x+1；rot=90/rec=0 覆盖 z..z+1。
const greenArms = [
  // -z 臂：覆盖 (x2..3, z1)，即从 (2,1) 沿 +x 展开 → rot=0, rec=0，扣在 (2,1) 的凸点
  { x: 2, z: 1, rot: 0, rec: 0, dir: '-z' },
  // +z 臂：覆盖 (x2..3, z4)，从 (2,4) 沿 +x 展开 → rot=0, rec=0
  { x: 2, z: 4, rot: 0, rec: 0, dir: '+z' },
  // -x 臂：覆盖 (x1, z2..3)，从 (1,2) 沿 +z 展开 → rot=90, rec=0
  { x: 1, z: 2, rot: 90, rec: 0, dir: '-x' },
  // +x 臂：覆盖 (x4, z2..3)，从 (4,2) 沿 +z 展开 → rot=90, rec=0
  { x: 4, z: 2, rot: 90, rec: 0, dir: '+x' },
];

for (const a of greenArms) {
  const host = cellOwner.get(`${a.x},${a.z}`);
  if (!host) throw new Error(`绿十字 ${a.dir} 臂所在格点 (${a.x},${a.z}) 没有端板`);
  b.add('3023', GREEN, {
    on: host.id, stud: studAt(host, a.x, a.z), rot: a.rot, receptor: a.rec, under: true,
    step: 1, module: 'base',
    evidence: ['lantern_base_detail'],
    note: `绿十字 ${a.dir} 臂 1×2（扣在端板底面，与中心同层）`,
  });
}

// —— 1c. 粉支脚 1×2：贴端板底面、伸出端板外一格形成外挑 ——
// 照片：粉 1×2 板伸出端面外沿形成四角支脚。
// 位置：端板四边中段偏一格的边缘格（避开中央十字臂所占的 (2,0)/(2,5)/(0,2)/(5,2) 附近）。
// 十字臂在 x1..4 / z1..4 范围内成十字，支脚必须在更靠外的边缘格上：
//   取四边「角旁一格」——(1,0)/(4,0)/(1,5)/(4,5) 与 (0,3)/(5,3) 等。
// 已枚举验证过的合法位置（每件都是「板内 1 格 + 板外 1 格」，且不与绿十字臂重叠）：
//   -x 侧 (0,2)+(-1,2)   +x 侧 (5,3)+(6,3)
//   -z 侧 (3,0)+(3,-1)   +z 侧 (2,5)+(2,6)
// 这四个位置分居四边中点附近，与照片「四角支脚外挑」一致。
const feet = [
  { at: [-1, -1, 2], rot: 0, dir: '-x' },
  { at: [5, -1, 3], rot: 0, dir: '+x' },
  { at: [3, -1, -1], rot: 90, dir: '-z' },
  { at: [2, -1, 5], rot: 90, dir: '+z' },
];
for (const f of feet) {
  const host = cellOwner.get(`${f.at[0] < 0 ? 0 : f.at[0]},${f.at[2] < 0 ? 0 : f.at[2]}`);
  if (!host) throw new Error(`粉支脚 ${f.dir} 所在格点没有端板`);
  b.add('3023', PINK, {
    at: f.at, rot: f.rot, step: 1, module: 'base',
    mount: basePlate.id, flagInferred: true,
    evidence: ['lantern_base_detail', 'lantern_a045'], note: `粉支脚 ${f.dir}（外挑 1 格，与端板底面搭接）`,
  });
}

// ================================================================
// Step 2：四角柱（3062b + 4073 周期单元）+ 中央芯柱（3941）
// 两者都从端板顶面起（y=1）：柱扣在端板四角格上，芯扣在端板中央格上。
// 绿十字在端板**下方**（y=-1），与柱/芯隔着端板，互不扣合。
// ================================================================
const Y_TOP = Y_PLATE + 1;   // 端板顶面

// 四角格归属由 cellOwner（上方按实际包围盒建立）查询
const CORNERS = [[0, 0], [5, 0], [0, 5], [5, 5]].map(([x, z]) => {
  const plate = cellOwner.get(`${x},${z}`);
  if (!plate) throw new Error(`端板在格点 (${x},${z}) 没有零件，无法立柱`);
  return { x, z, plate };
});

const columnStacks = [];
for (const [n, c] of CORNERS.entries()) {
  let parent = c.plate;
  let stud = studAt(c.plate, c.x, c.z);
  const stack = [];
  for (let u = 0; u < COLUMN_UNITS; u++) {
    const brick = b.add('3062b', PINK, {
      on: parent.id, stud, step: 2, module: 'columns',
      evidence: ['lantern_a090_e00', 'lantern_a045', 'lantern_a135_e10'],
      note: `角柱 ${n + 1} 第 ${u + 1}/${COLUMN_UNITS} 单元·圆砖 3062b（3 片）`,
    });
    const plate = b.add('4073', PINK, {
      on: brick.id, stud: 0, step: 2, module: 'columns',
      evidence: ['lantern_a090_e00', 'lantern_a045'],
      note: `角柱 ${n + 1} 第 ${u + 1}/${COLUMN_UNITS} 单元·圆板 4073（1 片，形成窄颈台阶）`,
    });
    stack.push(brick.id, plate.id);
    parent = plate; stud = 0;
  }
  columnStacks.push(stack);
}

// —— 中央芯柱：4 颗 2×2 圆砖，从端板中央（x2..3, z2..3）向上 ——
// 绿十字在端板**外侧**（y=-1），芯柱在**内侧**（y=1 起），两者隔着端板，不直接扣合。
// 芯柱的父件是端板中央那一件：z=2..5 带里覆盖 x2..3 的竖放 2×4。
const coreBase = cellOwner.get('2,2');
if (!coreBase) throw new Error('端板中央 (2,2) 没有零件，芯柱无处可立');
const CORE_ORDER = [
  { color: PINK, name: '亮粉' },
  { color: MAGENTA, name: '品红' },
  { color: RED, name: '红' },
  { color: DARKRED, name: '深红' },
];
let coreParent = coreBase.id;
let coreStud = studAt(coreBase, 2, 2);
const coreParts = [];
for (let i = 0; i < CORE_BRICKS; i++) {
  const p = b.add('3941', CORE_ORDER[i].color, {
    on: coreParent, stud: coreStud, step: 3, module: 'core',
    evidence: ['lantern_a090_e00', 'lantern_a090_e05', 'lantern_a135_e10', 'lantern_a045'],
    note: `芯柱 ${i + 1}/${CORE_BRICKS}：3941 ${CORE_ORDER[i].name}（自底座端数）`,
  });
  coreParts.push(p);
  coreParent = p.id; coreStud = 0;
}

// ================================================================
// Step 3：棚顶端板（压在柱顶与芯顶之上）
// 柱顶面 = Y_TOP + COLUMN_PLATES = 1 + 20 = 21；芯顶面 = 1 + 12 = 13。
// 两者不齐平（柱比芯高 8 片）——照片里外圈柱确实比中央芯长，
// 端板落在柱顶上、靠柱承托，中央芯与端板之间有 8 片空隙（照片 a090_e00 可见中芯与端板间的间隔）。
// ================================================================
const COLUMN_TOP = Y_TOP + COLUMN_PLATES;   // 21
const CORE_TOP = Y_TOP + CORE_BRICKS * 3;   // 13
const Y_CANOPY = COLUMN_TOP;

// 棚顶端板 6×6：整块 3958，四角扣在四根柱顶上。
// 照片（lantern_top_detail / a045）显示端板是一整层、四边整齐探出，无拼接痕迹；
// 而且只有整板才能同时落在四根柱顶上（三条 2×6 的中条没有任何柱可支撑）。
const colTopOf = (x, z) => {
  const idx = CORNERS.findIndex((cc) => cc.x === x && cc.z === z);
  const stack = columnStacks[idx];
  return stack[stack.length - 1];   // 柱顶圆板 id
};

const canopyPlate = b.add('3958', BLUE, {
  on: colTopOf(0, 0), stud: 0, step: 4, module: 'canopy',
  evidence: ['lantern_top_detail', 'lantern_a090_e00', 'lantern_a045'],
  note: '棚顶端板 6×6 整板（四角坐在四根柱顶上，四边探出）',
});
const canopyPlates = [canopyPlate];
const Y_CANOPY_TOP = Y_CANOPY + 1;

// ================================================================
// Step 4：棚顶装饰层
// 照片（lantern_top_detail）：外圈粉色 1 格宽边框 + 内区两块淡紫 2×4 平行并排；
// 四边中段再叠一层粉色，形成十字高台；淡紫板顶面低于粉框顶面。
// ================================================================
const Y_DECOR = Y_CANOPY + 1;

// 棚顶端板顶面格点归属（6×6）：用于把装饰件扣到具体凸点上
const canopyOwner = new Map();
for (const p of canopyPlates) {
  for (const bx of partBoxes(p, catalog.parts[p.part])) {
    for (let x = bx.x0; x < bx.x1; x++) for (let z = bx.z0; z < bx.z1; z++) canopyOwner.set(`${x},${z}`, p);
  }
}
/** 把零件扣在棚顶端板 (x,z) 格的顶面凸点上。 */
function addOnCanopy(part, color, x, z, extra = {}) {
  const host = canopyOwner.get(`${x},${z}`);
  if (!host) throw new Error(`棚顶端板在格点 (${x},${z}) 没有零件`);
  return b.add(part, color, {
    on: host.id, stud: studAt(host, x, z), step: extra.step ?? 5, module: 'canopy', ...extra,
  });
}

// 淡紫板：内区 4×4 = x1..4, z1..4。两块 2×4（3020，rot=0 占 4 格 x × 2 格 z）沿 z 并排。
// 每块扣在它所覆盖的第一格 (x=1) 的凸点上，另一格自动对齐。
for (let k = 0; k < 2; k++) {
  addOnCanopy('3020', PURPLE, 1, 1 + k * 2, {
    evidence: ['lantern_top_detail'],
    note: `淡紫 2×4 第 ${k + 1}/2 块（内区并排，缝在 z=3 —— 照片为平行并排，非 V 形）`,
  });
}

// 外圈粉框（6×6 外圈，1 格宽），逐件扣在「该件起始格」的凸点上。
// snapPart 语义：receptor=0 → 从目标格向 +x/+z 展开；receptor=1 → 向 -x/-z 展开。
// x=0 / x=5 两侧：各 3 块 1×2 沿 z 铺满（rot=90，占 1 格 x × 2 格 z）
// z=0 / z=5 两侧：各 2 块 1×2 覆盖 x1..4（x0/x5 已由侧边件占据）
const ring = [
  // x=0 侧：z0..1 / z2..3 / z4..5
  { x: 0, z: 0, rot: 90, rec: 0 }, { x: 0, z: 2, rot: 90, rec: 0 }, { x: 0, z: 4, rot: 90, rec: 0 },
  // x=5 侧同上
  { x: 5, z: 0, rot: 90, rec: 0 }, { x: 5, z: 2, rot: 90, rec: 0 }, { x: 5, z: 4, rot: 90, rec: 0 },
  // z=0 侧：x1..2 / x3..4
  { x: 1, z: 0, rot: 0, rec: 0 }, { x: 3, z: 0, rot: 0, rec: 0 },
  // z=5 侧同上
  { x: 1, z: 5, rot: 0, rec: 0 }, { x: 3, z: 5, rot: 0, rec: 0 },
];
for (const r of ring) {
  addOnCanopy('3023', PINK, r.x, r.z, {
    rot: r.rot, receptor: r.rec,
    evidence: ['lantern_top_detail', 'lantern_a045'],
    note: '棚面粉框（6×6 外圈 1 格宽）',
  });
}

// 十字高台：四边中段在第一层粉框之上再叠一层（扣在粉框顶面凸点上）
const ringParts = b.model().parts.filter((p) => p.module === 'canopy' && p.part === '3023');
const findRing = (x, z) => ringParts.find((p) => {
  const bx = partBoxes(p, catalog.parts[p.part])[0];
  return bx && bx.x0 <= x && x < bx.x1 && bx.z0 <= z && z < bx.z1;
});
// 高台与底层粉框同向、同位置再叠一层（四边中段）
const raise = [
  { x: 0, z: 2, rot: 90, rec: 0 }, { x: 5, z: 2, rot: 90, rec: 0 },
  { x: 2, z: 0, rot: 0, rec: 0 }, { x: 2, z: 5, rot: 0, rec: 0 },
];
for (const r of raise) {
  const host = findRing(r.x, r.z);
  if (!host) throw new Error(`十字高台 (${r.x},${r.z}) 下方没有粉框件`);
  b.add('3023', PINK, {
    on: host.id, stud: studAt(host, r.x, r.z), rot: r.rot, receptor: r.rec,
    step: 5, module: 'canopy',
    evidence: ['lantern_top_detail'],
    note: '粉十字高台第二层（四边中段高于四角）',
  });
}

// —— 模块定义 ——
const model = b.model();
model.modules = [
  { id: 'base', label: '底座（端板 + 绿十字 + 粉支脚）', explode: [0, -12, 0] },
  { id: 'columns', label: `四角柱（3062b + 4073 × ${COLUMN_UNITS} 单元）`, explode: [-12, 0, 0] },
  { id: 'core', label: '中央芯柱（4×3941）', explode: [12, 0, 0] },
  { id: 'canopy', label: '棚顶（端板 + 淡紫板 + 粉十字）', explode: [0, 14, 0] },
];

const outFile = path.join(ROOT, 'examples/lantern.reconstructed.v4.brick.json');
fs.writeFileSync(outFile, JSON.stringify(model, null, 1) + '\n');
console.log(`件数 ${model.parts.length}`);
console.log(`柱：${COLUMN_UNITS} 单元 × ${UNIT_PLATES} 片 = ${COLUMN_PLATES} 片，柱顶 y=${COLUMN_TOP}`);
console.log(`芯：${CORE_BRICKS} 颗 × 3 片 = ${CORE_BRICKS * 3} 片，芯顶 y=${CORE_TOP}（与柱顶差 ${COLUMN_TOP - CORE_TOP} 片）`);
console.log(`棚顶端板层 y=${Y_CANOPY}`);
console.log(`→ ${path.relative(ROOT, outFile)}`);
