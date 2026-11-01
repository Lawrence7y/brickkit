// 灯笼重建 v6 —— 2026-10-28 第六轮。
//
// 本版改动由 r6 轮的三条新照片证据驱动（躺倒平视照 1792845158626 的 1:1 放大读数，
// 见 out/lantern-repair/2026-10-27-r6/main/measure/core-line.png 与 bottom-rail-zoom.png）：
//
// ── 相对 v5 的三处结构修正 ─────────────────────────────────────────
//
// ① 柱改为「纯 3062b 堆」，去掉 4073 圆板
//    照片柱轨的桶身之间只有**窄颈线**（约 20-30px），没有 1 片宽（约 73px）的薄环。
//    若柱真是「3062b(3片)+4073(1片)」单元，薄环应清晰可见——照片里没有。
//    纯 3062b 堆的接缝在渲染里（measure/probe-3062b.png）正好是这种窄颈。
//    顺带修正 r5 的 IR-1：3062b 的 LDraw 几何渲染是**光滑圆柱**，与照片一致；
//    目录里 `fluted:true` 只是元数据标志，渲染不受它影响。IR-1 撤回。
//
// ② 芯柱由 4 颗改为与柱等长、两端顶满端板
//    照片实测：芯柱可见跨度（红+粉掩膜 1372..2651 = 1279px）与两块端板内距（约1280px）
//    在 0.1% 内吻合 → 芯柱两端顶到端板，中间没有 v4/v5 的 8 片空腔。
//    直立照（1792845158470）里芯柱顶端接触棚顶端板，与此一致。
//
// ③ 芯柱两端各有一棵**绿色**砖（r3/v3/v5 都漏了）
//    1:1 放大图上芯柱左端绿砖清晰（夹在端板与深红段之间），右端在端板前有绿色边条。
//    v3 记录的「粉→品红→红→深红」既漏了绿色端节也漏了段数。
//
// ── 待 diff 数据裁决的参数 ─────────────────────────────────────────
//   N（柱砖数 = 芯砖数）：照片读数 6~7 之间。
//     · 内距/周期 = 1280/227 ≈ 5.6 → 6
//     · 目视桶段数 6.25~7 → 7
//     两个读数冲突，用 diff 的 aspectSim/IoU 在 N=6 与 N=7 之间裁决，v5(u=5) 作对照。
//
// ── 保持 v5 的部分 ────────────────────────────────────────────────
//   底座端板 6×6、绿十字（1×3022+4×3023 under 扣合）、粉支脚真实扣合+外挑、
//   棚顶端板 + 淡紫 2×4×2 + 粉框（rot/receptor 已修正）+ 十字高台。
//
// 验收优先级（用户明确）：零件与连接正确 > 尺寸比例 > 颜色。
// 坐标约定：+y 指向棚顶；y=0 是底座端板层。
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

const PINK = 29, MAGENTA = 26, RED = 4, DARKRED = 320, PURPLE = 31, BLUE = 272, GREEN = 10;

// N：柱砖数 = 芯砖数（两者等长、都顶满两端）。照片读数 6~7，默认 6，由 diff 裁决。
const N = Number(process.env.LANTERN_BRICKS || 7);
const COLUMN_PLATES = N * 3;
const CORE_PLATES = N * 3;

// 芯柱颜色（自底座端到棚顶端）。两端绿砖有照片直接证据；
// 中间段为红/粉家族交替，**具体色号全部 pending**（躺倒照光照不匀，无法可靠区分 4/26/29/320）。
const CORE_SEQ = (N === 7
  ? [
    { color: GREEN, name: '绿' },
    { color: DARKRED, name: '深红', pending: true },
    { color: MAGENTA, name: '品红', pending: true },
    { color: RED, name: '红', pending: true },
    { color: PINK, name: '亮粉', pending: true },
    { color: DARKRED, name: '深红', pending: true },
    { color: GREEN, name: '绿' },
  ]
  : [
    { color: GREEN, name: '绿' },
    { color: DARKRED, name: '深红', pending: true },
    { color: MAGENTA, name: '品红', pending: true },
    { color: RED, name: '红', pending: true },
    { color: DARKRED, name: '深红', pending: true },
    { color: GREEN, name: '绿' },
  ]).slice(0, N);

const b = createBuilder({
  catalog,
  meta: {
    name: '粉紫灯笼（实物重建 v6）',
    createdAt: new Date().toISOString().slice(0, 10),
    front: '+z',
    photoSet: 'lantern.photos.v3.json',
    observations: 'lantern.observations.v4.json',
    buildScript: 'examples/gen-lantern-v6.mjs',
    verificationPriority: '结构正确（零件/连接/接口）> 尺寸比例 > 颜色',
    description:
      '2026-10-28 第六轮。相对 v5：柱改纯 3062b 堆（照片柱轨无 4073 薄环）、'
      + '芯柱与柱等长且两端顶满端板（芯可见跨度=端板内距，误差 0.1%）、'
      + '芯柱两端补绿色砖（照片直接可见，历轮记录都漏了）。'
      + `N=${N} 由照片读数 6~7 给出，diff aspectSim 裁决。`
      + '未确认项见 out/lantern-repair/2026-10-27-r6/main/result.md。',
  },
});

// ================================================================
// Step 1：底座端板 6×6（y=0）—— 沿用 v5
// ================================================================
const basePlate = b.add('3958', BLUE, {
  at: [0, 0, 0], step: 1, module: 'base',
  evidence: ['lantern_base_detail', 'lantern_top_detail'],
  note: '底座端板 6×6 整板（分件方式 pending）',
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

// —— 1b. 绿十字：中心 3022 + 四臂 3023，under 扣在端板底面（y=-1）—— 沿用 v5
b.add('3022', GREEN, {
  on: basePlate.id, stud: antiStudAt(basePlate, 2, 2), receptor: 0, under: true,
  step: 1, module: 'base', evidence: ['lantern_base_detail'],
  note: '绿十字中心 3022（扣在端板底面；所在层 pending）',
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
    step: 1, module: 'base', evidence: ['lantern_base_detail'],
    note: `绿十字 ${arm.dir} 臂 1×2（扣在端板底面）`,
  });
}

// —— 1c. 粉支脚：真实 under 扣合、外挑 1 格 —— 沿用 v5（probe-feet.mjs 穷举结果）
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
    step: 1, module: 'base',
    evidence: ['lantern_base_detail', 'lantern_a045'],
    note: `粉支脚 ${f.dir}（真实底孔扣合，外挑 1 格）`,
  });
}

// ================================================================
// Step 2：四角柱 —— 纯 3062b × N（无 4073；照片柱轨无薄环）
// ================================================================
const Y_TOP = 1;
const CORNERS = [[0, 0], [5, 0], [0, 5], [5, 5]];
const columnStacks = [];
for (const [n, [cx, cz]] of CORNERS.entries()) {
  let parent = basePlate, stud = studAt(basePlate, cx, cz);
  const stack = [];
  for (let u = 0; u < N; u++) {
    const brick = b.add('3062b', PINK, {
      on: parent.id, stud, step: 2, module: 'columns',
      evidence: ['lantern_a090_e00', 'lantern_a045'],
      note: `角柱 ${n + 1} 第 ${u + 1}/${N} 颗·3062b（3 片）`,
    });
    stack.push(brick.id);
    parent = brick; stud = 0;
  }
  columnStacks.push(stack);
}
const COLUMN_TOP = Y_TOP + COLUMN_PLATES;

// ================================================================
// Step 3：中央芯柱 —— 3941 × N，与柱等长，两端顶满端板
// ================================================================
const coreBase = cellOwner.get('2,2');
let coreParent = coreBase.id, coreStud = studAt(coreBase, 2, 2);
for (let i = 0; i < N; i++) {
  const c = CORE_SEQ[i];
  const p = b.add('3941', c.color, {
    on: coreParent, stud: coreStud, step: 3, module: 'core',
    evidence: ['lantern_a090_e00', 'lantern_a045'],
    note: `芯柱 ${i + 1}/${N}：3941 ${c.name}${c.pending ? '（分段可见、色号 pending）' : '（照片直接可见）'}（自底座端数）`,
  });
  coreParent = p.id; coreStud = 0;
}
const CORE_TOP = Y_TOP + CORE_PLATES;   // = COLUMN_TOP，两端顶满

// ================================================================
// Step 4：棚顶端板 —— 压在四根柱顶 + 芯顶之上（全部同时接触）
// ================================================================
const colTopId = (x, z) => {
  const idx = CORNERS.findIndex(([cx, cz]) => cx === x && cz === z);
  const stack = columnStacks[idx];
  return stack[stack.length - 1];
};
const Y_CANOPY = COLUMN_TOP;
const canopyPlate = b.add('3958', BLUE, {
  on: colTopId(0, 0), stud: 0, step: 4, module: 'canopy',
  evidence: ['lantern_top_detail', 'lantern_a045'],
  note: '棚顶端板 6×6（扣在一根柱顶；另三柱顶与芯顶面同时承托）',
});

// ================================================================
// Step 5：棚顶装饰层 —— 沿用 v5（含 rot/receptor 修正）
// ================================================================
const canopyOwner = new Map();
for (const bx of partBoxes(canopyPlate, catalog.parts[canopyPlate.part])) {
  for (let x = bx.x0; x < bx.x1; x++) for (let z = bx.z0; z < bx.z1; z++) canopyOwner.set(`${x},${z}`, canopyPlate);
}
function addOnCanopy(part, color, x, z, extra = {}) {
  const host = canopyOwner.get(`${x},${z}`);
  if (!host) throw new Error(`棚顶端板在格点 (${x},${z}) 没有零件`);
  return b.add(part, color, {
    on: host.id, stud: studAt(host, x, z), step: extra.step ?? 5, module: 'canopy', ...extra,
  });
}
for (let k = 0; k < 2; k++) {
  addOnCanopy('3020', PURPLE, 1, 1 + k * 2, {
    evidence: ['lantern_top_detail'],
    note: `淡紫 2×4 第 ${k + 1}/2 块（内区并排；格数 pending）`,
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
    evidence: ['lantern_top_detail', 'lantern_a045'],
    note: '棚面粉框（外圈 1 格宽）',
  }));
}
for (const r of [
  { x: 0, z: 2, rot: 90 }, { x: 5, z: 2, rot: 90 },
  { x: 2, z: 0, rot: 0 }, { x: 2, z: 5, rot: 0 },
]) {
  const host = ringParts.find((p) => {
    const bx = partBoxes(p, catalog.parts[p.part])[0];
    return bx && bx.x0 <= r.x && r.x < bx.x1 && bx.z0 <= r.z && r.z < bx.z1;
  });
  if (!host) throw new Error(`十字高台 (${r.x},${r.z}) 下方没有粉框件`);
  b.add('3023', PINK, {
    on: host.id, stud: studAt(host, r.x, r.z), rot: r.rot, receptor: 0,
    step: 5, module: 'canopy',
    evidence: ['lantern_top_detail'],
    note: '粉十字高台第二层（四边中段高于四角）',
  });
}

// —— 模块定义 ——
const model = b.model();
model.modules = [
  { id: 'base', label: '底座（端板 + 绿十字 + 粉支脚）', explode: [0, -16, 0] },
  { id: 'columns', label: `四角柱（3062b × ${N}）`, explode: [-16, 0, 0] },
  { id: 'core', label: `中央芯柱（3941 × ${N}，两端顶满）`, explode: [16, 0, 0] },
  { id: 'canopy', label: '棚顶（端板 + 淡紫板 + 粉十字）', explode: [0, 18, 0] },
];

const outFile = path.join(ROOT, 'examples/lantern.reconstructed.v6.brick.json');
fs.writeFileSync(outFile, JSON.stringify(model, null, 1) + '\n');
console.log(`N=${N} 件数 ${model.parts.length}`);
console.log(`柱：${N} 颗 3062b = ${COLUMN_PLATES} 片，柱顶 y=${COLUMN_TOP}`);
console.log(`芯：${N} 颗 3941 = ${CORE_PLATES} 片，芯顶 y=${CORE_TOP}（与柱顶齐平，两端顶满）`);
console.log(`棚顶端板层 y=${Y_CANOPY}`);
console.log(`→ ${path.relative(ROOT, outFile)}`);
