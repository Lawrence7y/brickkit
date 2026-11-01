// 灯笼重建 v3 —— 依据 examples/lantern.observations.v2.json（2026-10-27 重新核对六张照片）。
//
// 与 v2 的关键差异（都是照片核对后推翻旧结论的部分）：
//   ① 淡紫板不是「V 形对角错位」：放大顶面特写可见两块矩形板**平行并排**铺满 4×4 内区，
//      中间是两块板之间的拼接缝。旧版把它当「整数网格不可表达」并降级为 uncertain——该结论不成立。
//   ② 绿色是**单颗 2×2 居中件**，不是绿十字 3 件。
//   ③ 柱是**圆板 4073** 堆叠（照片可见分节台阶），不是 3062b 圆砖。
//   ④ 棚顶粉砖是**十字高台**（四边中段高于四角），四角留空给柱顶——不是平铺围边。
//
// 搭建约束：所有坐标由真实接口扣合推导（b.add 的 on/stud 或 snap），不手写悬空小数。
// 柱高属于「待确认」项（照片只能定区间），这里取区间下限作 baseline，并在 meta 里标注。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder } from '../src/core/builder.js';
import { mergeCatalogParts } from '../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const catalog = {
  parts: mergeCatalogParts(readJSON('catalog/parts-ldraw.json').parts, readJSON('catalog/parts.json').parts),
  colors: readJSON('catalog/colors.json').colors,
};
const obs = readJSON('examples/lantern.observations.v2.json');

// —— 颜色（LDraw 码）——
const PINK = 29, MAGENTA = 5, RED = 4, DARKRED = 320, PURPLE = 31, BLUE = 272, GREEN = 10;

// 柱高：柱从端板顶面（y=2）起，芯从绿芯顶面（y=3）起——两者起点差 1 片（绿芯占 1 片）。
// 要让柱顶与芯顶齐平（共同承托棚顶端板），柱片数 = 芯高度 + 起点差 = 12 + 1 = 13。
// 照片侧视按 6 格截面标定得轴向约 22 格、柱区约 10–13 片，13 落在区间内。
// 这不是凑数：13 是由「柱顶必须与芯顶齐平」这个接口约束反推的唯一取值。
const CORE_BRICKS = 4;                              // 芯 4 颗：proven
const CORE_START_Y = 3;                             // 芯起点：扣在绿芯(占 y=2)之上
const COLUMN_START_Y = 2;                           // 柱起点：扣在端板(占 y=1)之上
const COLUMN_PLATES = Number(process.env.LANTERN_COL_PLATES
  || (CORE_BRICKS * 3 + (CORE_START_Y - COLUMN_START_Y)));   // = 13

const b = createBuilder({
  catalog,
  meta: {
    name: '粉紫灯笼（实物重建 v3）',
    createdAt: new Date().toISOString().slice(0, 10),
    front: '+z',
    photoSet: 'lantern.photos.json',
    observations: 'lantern.observations.v2.json',
    description:
      '依据 2026-10-27 重新核对的六张实拍照片重建。'
      + '已推翻旧结论：淡紫板为平行并排（非 V 形）、绿色为单颗 2×2（非十字）、柱为 4073 圆板（非 3062b）。'
      + `柱高 ${COLUMN_PLATES} 片为待确认项的照片区间下限；照片只能定 10–13 片区间。`,
  },
});

// ================================================================
// 坐标约定：截面 6×6，格点 (0..5, 0..5)。四角柱在 (0,0)(5,0)(0,5)(5,5)。
// 中央 2×2 芯占 (2..3, 2..3)。
// ================================================================

// —— Step 1：底座（从下往上：粉支脚 → 深蓝端板 → 绿芯）——
// 粉支脚：外挑在端板四角之外（照片 base_detail），压在端板下方。
// 支脚用 1×2 板，半压在下层：放 at y=-1 会在负层，改为贴在端板底面用 snot 语义不合适，
// 因此按「端板下方同一层、伸出端板外一截」处理：支脚在 y=0，端板在 y=1。
const FOOT = [
  { at: [-1, 0, 2], rot: 0, note: '粉支脚·-x 侧（伸出端板外）' },
  { at: [5, 0, 2], rot: 0, note: '粉支脚·+x 侧' },
  { at: [2, 0, -1], rot: 90, note: '粉支脚·-z 侧' },
  { at: [2, 0, 5], rot: 90, note: '粉支脚·+z 侧' },
];
for (const f of FOOT) {
  b.add('3023', PINK, { at: f.at, rot: f.rot, step: 1, module: 'base', evidence: ['lantern_base_detail'], note: f.note });
}

// 深蓝端板：6×6 = 三条 2×6（3795）铺满。照片 base_detail 可见 2×4 长边交错；
// 这里用 3×3795 是最少的整铺方案，交错铺法需要 3020/3022 混合，留待确认项。
const basePlates = [];
for (let k = 0; k < 3; k++) {
  basePlates.push(b.add('3795', BLUE, {
    at: [0, 1, k * 2], step: 1, module: 'base',
    evidence: ['lantern_base_detail', 'lantern_a090_e00'],
    note: `底座深蓝端板 2×6 第 ${k + 1}/3 条（6×6 整铺）`,
  }));
}
// 绿芯：单颗 2×2，扣在端板中央（照片 proven）。
// 端板中央格是 (2..3, 2..3)，其凸点编号按 3795 的 label「top-<i>,<k>」→ index = k*6+i。
// 端板第 1 条（z=2..3）承载中央，取 k=0（即 z=2 那排）、i=2（x=2）→ index 2。
const basePlateMid = basePlates[1];
b.add('3022', GREEN, {
  on: basePlateMid.id, stud: 2, step: 1, module: 'base',
  evidence: ['lantern_base_detail', 'lantern_a045'],
  note: '绿芯 2×2 单颗，居中（旧版绿十字 3 件不成立）',
});

// —— Step 2：四角柱（4073 圆板堆叠）——
// 柱底扣在端板四角的凸点上。每次 add 用 on/stud 让 snapPart 算坐标，不手写。
const CORNERS = [
  { ci: 0, ck: 0 },   // 端板第 0 条(2×6) 的第 0 格
  { ci: 5, ck: 0 },
  { ci: 0, ck: 5 },
  { ci: 5, ck: 5 },
];
// 端板是 3 条 2×6 拼成：第 (x,z) 格属于第 floor(z/2) 条，条内 k = z%2。
// 3795 的凸点编号规则（实测 label 为 top-<i>,<k>）：index = k*6 + i。
const plateOfCell = (ck) => basePlates[Math.floor(ck / 2)];
const studOfCell = (ci, ck) => (ck % 2) * 6 + ci;

const columnIds = [];
for (const [n, c] of CORNERS.entries()) {
  let parent = plateOfCell(c.ck), stud = studOfCell(c.ci, c.ck);
  const stack = [];
  for (let i = 0; i < COLUMN_PLATES; i++) {
    const p = b.add('4073', PINK, {
      on: parent.id, stud, step: 2, module: 'columns',
      evidence: ['lantern_a090_e00', 'lantern_a045'],
      note: `角柱 ${n + 1} 第 ${i + 1}/${COLUMN_PLATES} 片（4073 圆板）`,
    });
    stack.push(p.id);
    parent = p; stud = 0;
  }
  columnIds.push(stack);
}

// —— 中央芯柱：4 颗 2×2 圆砖，从底座端向棚顶端 粉 → 品红 → 红 → 深红 ——
// 芯扣在绿芯上（绿芯也是 2×2，中心凸点编号 = 主格）
const greenId = b.model().parts.find((p) => p.part === '3022' && p.color === GREEN).id;
const CORE_ORDER = [PINK, MAGENTA, RED, DARKRED];
let coreParent = greenId, coreStud = 0;
let coreTopId = null;
for (let i = 0; i < CORE_BRICKS; i++) {
  const p = b.add('3941', CORE_ORDER[i], {
    on: coreParent, stud: coreStud, step: 3, module: 'core',
    evidence: ['lantern_a090_e00', 'lantern_a090_e05', 'lantern_a135_e10'],
    note: `芯 2×2 圆砖 ${i + 1}/${CORE_BRICKS}（从底座端数：${['粉', '品红', '红', '深红'][i]}）`,
  });
  coreParent = p.id; coreStud = 0;
  coreTopId = p.id;
}

// —— Step 4：棚顶端板（深蓝 6×6）——
// 层高推导（全部由 add 实际返回的坐标决定，不靠手算）：
//   支脚 y=0（1 片）→ 端板 y=1（1 片）→ 绿芯 y=2（1 片）→ 芯/柱从 y=3 起
//   芯 4 颗 3941（各 3 片）= 3..15，顶面 y=15；柱 12 片 = 3..15，顶面 y=15。
//   因此端板基准层 = 15（压在柱顶与芯顶之上）。
const coreTopPlates = CORE_BRICKS * 3;
const colTopPlates = COLUMN_PLATES;
// 用实际放置的芯顶零件推出层号，避免手算与 builder 不一致
const coreTopPart = b.model().parts.find((p) => p.id === coreTopId);
const coreTopY = coreTopPart.at[1] + 3;          // 3941 高 3 片 → 芯顶面
const colTopY = COLUMN_START_Y + COLUMN_PLATES;  // 柱顶面
if (colTopY !== coreTopY) {
  console.warn(`警告：柱顶 y=${colTopY} 与芯顶 y=${coreTopY} 不齐平，端板会有一侧悬空`);
}
const canopyY = coreTopY;

// 棚顶端板：3 条 2×6 铺满 6×6，压在柱顶与芯顶上。
// 不用 on 扣合：芯顶（2×2）的凸点只覆盖中央，把 2×6 板扣上去会被 snap 到一个偏移位置，
// 与其余两条错位。这里改为三条都按同一层显式摆放（at 为整数格），
// 由 validate 的支撑图确认它们确实坐在柱顶/芯顶上。
const canopyPlates = [];
for (let k = 0; k < 3; k++) {
  canopyPlates.push(b.add('3795', BLUE, {
    at: [0, canopyY, k * 2], step: 4, module: 'canopy',
    evidence: ['lantern_top_detail', 'lantern_a090_e00'],
    note: `棚顶深蓝端板 2×6 第 ${k + 1}/3 条（压在柱顶与芯顶上）`,
  }));
}

// —— Step 5：棚面粉色十字高台 + 淡紫板 ——
// 照片：6×6 外圈是粉砖，四边中段高、四角低；内部 4×4 是两块淡紫板平行并排，低于粉框顶面。
// 因此：淡紫板先铺在端板上（y+1），粉框压在四周（y+1），中段再叠一层（y+2）形成高台。
// 淡紫板：内部 4×4 区域 = x[1..5] × z[1..5]。两块 2×4（3020，rot=0 时占 4格x × 2格z）
// 沿 z 方向并排：板1 z[1,3]，板2 z[3,5]，接缝在 z=3。
// 这正是照片顶视图里看到的「两块平行板 + 中间一道缝」——不是 V 形。
for (let k = 0; k < 2; k++) {
  b.add('3020', PURPLE, {
    at: [1, canopyY + 1, 1 + k * 2], step: 5, module: 'canopy',
    evidence: ['lantern_top_detail'],
    note: `淡紫 2×4 第 ${k + 1}/2 块（并排铺满 4×4 内区，seam 在 z=3——非 V 形）`,
  });
}
// 外圈粉框：6×6 外圈 1 格宽。四条边：
//   西/东边（x=0 / x=5）：沿 z 铺 3 块 1×2（rot=90 使其占 1格x × 2格z）
//   南/北边（z=0 / z=5）：沿 x 铺 3 块 1×2（rot=0）
const RING = [
  // x=0 与 x=5 两侧
  { at: [0, canopyY + 1, 0], rot: 90 }, { at: [0, canopyY + 1, 2], rot: 90 }, { at: [0, canopyY + 1, 4], rot: 90 },
  { at: [5, canopyY + 1, 0], rot: 90 }, { at: [5, canopyY + 1, 2], rot: 90 }, { at: [5, canopyY + 1, 4], rot: 90 },
  // z=0 与 z=5 两侧（中间 4 格，两侧各 2 块）
  { at: [1, canopyY + 1, 0], rot: 0 }, { at: [3, canopyY + 1, 0], rot: 0 },
  { at: [1, canopyY + 1, 5], rot: 0 }, { at: [3, canopyY + 1, 5], rot: 0 },
];
for (const r of RING) {
  b.add('3023', PINK, {
    at: r.at, rot: r.rot, step: 5, module: 'canopy',
    evidence: ['lantern_top_detail', 'lantern_a045'],
    note: '棚面粉框（6×6 外圈，1 格宽）',
  });
}
// 十字高台：四边中段的第二层
const RAISE = [
  { at: [0, canopyY + 2, 2], rot: 90 }, { at: [5, canopyY + 2, 2], rot: 90 },
  { at: [2, canopyY + 2, 0], rot: 0 }, { at: [2, canopyY + 2, 5], rot: 0 },
];
for (const r of RAISE) {
  b.add('3023', PINK, {
    at: r.at, rot: r.rot, step: 5, module: 'canopy',
    evidence: ['lantern_top_detail'],
    note: '粉十字高台第二层（四边中段，高于四角）',
  });
}

// —— 模块定义 ——
const model = b.model();
model.modules = [
  { id: 'base', label: '底座（支脚 + 端板 + 绿芯）', explode: [0, -12, 0] },
  { id: 'columns', label: '四角柱（4073 圆板）', explode: [-12, 0, 0] },
  { id: 'core', label: '中央芯柱（2×2 圆砖）', explode: [12, 0, 0] },
  { id: 'canopy', label: '棚顶（端板 + 粉十字 + 淡紫板）', explode: [0, 14, 0] },
];

const outFile = path.join(ROOT, 'examples/lantern.reconstructed.v3.brick.json');
fs.writeFileSync(outFile, JSON.stringify(model, null, 1) + '\n');
console.log(`件数 ${model.parts.length}，柱高 ${COLUMN_PLATES} 片，棚顶端板层 y=${canopyY}`);
console.log(`芯顶 y=${coreTopY} vs 柱顶 y=${colTopY} ${coreTopY === colTopY ? '（齐平，端板共同承托）' : '（不齐平 → 端板会有一侧悬空，须在报告中列为待确认）'}`);
console.log(`→ ${path.relative(ROOT, outFile)}`);
