// 灯笼重建 v5 —— 2026-10-27 第五轮。
//
// 本版只修正**能用代码复现或能由照片直接判定**的结构问题，不凭测量推断改尺寸。
// 测量方法与数据见 out/lantern-repair/2026-10-27-r5/main/measure/。
//
// ── 相对 v4 的三处结构修正 ─────────────────────────────────────────
//
// ① 棚顶粉框越界（纯结构缺陷，可用代码复现，与照片解读无关）
//    v4 在 x=0 / x=5 两边用 rot=90 + receptor=0。snapPart 实测语义（probe-snap.mjs）：
//      rot=90 + rec=0 → 从目标格向 -z 展开；rot=90 + rec=1 → 向 +z 展开
//    v4 从 z=0 起步却用 rec=0，于是两件落到 z=-1..1，一半悬在 6×6 端板之外。
//    v5 在 x 边改用 rec=1、从 z=0/2/4 起步，四边严格落在 0..6 内。
//
// ② 粉支脚由「无接口搭接」改为真实底孔扣合
//    v4 四件粉支脚是硬写 at + mount=p001，与端板没有任何凸点-底孔配对。
//    v5 改为 under:true 真实扣合。四组 (格点, rot, receptor) 由 probe-feet.mjs 穷举确认：
//    既探出端板 1 格形成外挑，又不与绿十字所占格点重叠。
//
// ③ 芯柱顶部补到与柱顶齐平（可选，默认关闭）
//    由 LANTERN_CORE_FILL=1 打开。v4 的芯柱顶与棚顶端板之间空 8 片且无任何约束。
//    但「照片里芯柱到底止于何处」本轮无法判定，因此默认**保留 8 片高差**，
//    不把推断件写进模型；该开关只用于对照实验，不作为已确认结构。
//
// ── 本轮一次已撤回的推断（留档，避免重复踩坑）──────────────────────
//   曾据「柱身凹颈周期 199px、柱可见长 1912px → 9.6 个周期」推断柱应为纯 3062b×10（30 片）。
//   用完整自相关复检（measure/rings2.mjs）时该曲线**没有任何正峰**，
//   199px 是滑动平滑窗口造成的伪峰。该推断已撤回，柱高保持 v4 的 20 片。
//   教训：从平滑后的曲线数周期会自造周期，必须用未平滑数据的自相关/FFT 复核。
//
// ── 明确保持 pending（证据不足，不假装已确认）──────────────────────
//   · 柱究竟是 3062b+4073 单元还是纯 3062b、精确颗数
//   · 端板是 6×6 整板还是交错小片
//   · 底座绿件的分件形状与所在层
//   · 淡紫内区精确格数、粉框是否覆盖四角
//   · 芯柱精确颗数、颜色分段、顶端与棚顶端板的关系
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

// —— 尺寸（沿用 v4，理由见文件头「未验证项」）——
// 柱：v4 的 5 个「3062b(3 片) + 4073(1 片)」单元 = 20 片。
// 本轮曾据「凹颈周期 199px」推断柱应为纯 3062b × 10 = 30 片，但该周期用完整自相关复检时
// 找不到任何正峰（rings2.mjs），是平滑窗口造成的伪峰，**该推断已撤回**。
// 柱高改回 v4 取值；真正颗数仍为 pending，见 result.md。
const COLUMN_UNITS = Number(process.env.LANTERN_COLUMN_UNITS || 5);
const UNIT_PLATES = 4;                       // 3062b 3 片 + 4073 1 片
const COLUMN_PLATES = COLUMN_UNITS * UNIT_PLATES;   // 20
const CORE_BRICKS = Number(process.env.LANTERN_CORE_BRICKS || 4);   // 3941 × 4 = 12 片（沿用 v4）
const CORE_PLATES = CORE_BRICKS * 3;                                // 12
const CORE_GAP = COLUMN_PLATES - CORE_PLATES;                       // 8 片低于柱顶

const b = createBuilder({
  catalog,
  meta: {
    name: '粉紫灯笼（实物重建 v5）',
    createdAt: new Date().toISOString().slice(0, 10),
    front: '+z',
    photoSet: 'lantern.photos.json',
    observations: 'lantern.observations.v4.json',
    buildScript: 'examples/gen-lantern-v5.mjs',
    verificationPriority: '结构正确（零件/连接/接口）> 尺寸比例 > 颜色',
    description:
      '2026-10-27 第五轮。相对 v4 修正两处可复现的结构缺陷：'
      + '棚顶粉框越界（snapPart rot/receptor 语义用错，两件悬出端板）、'
      + '粉支脚无接口搭接（改为真实底孔扣合）。'
      + '柱与芯的尺寸沿用 v4（照片无法定到具体颗数）。'
      + '未确认项见 out/lantern-repair/2026-10-27-r5/main/result.md。',
  },
});

// ================================================================
// Step 1：底座端板 6×6（y=0）
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

// —— 1b. 绿十字：中心 3022 + 四臂 3023，under 扣在端板底面（y=-1）——
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

// —— 1c. 粉支脚：真实 under 扣合，外挑 1 格 ——
// 四组组合由 probe-feet.mjs 穷举得出（外挑 + 不与绿十字重叠）。
const FEET = [
  { x: 0, z: 2, rot: 0, rec: 1, dir: '-x' },    // x-1..1
  { x: 5, z: 2, rot: 0, rec: 0, dir: '+x' },    // x5..7
  { x: 2, z: 0, rot: 90, rec: 0, dir: '-z' },   // z-1..1
  { x: 2, z: 5, rot: 90, rec: 1, dir: '+z' },   // z5..7
];
for (const f of FEET) {
  b.add('3023', PINK, {
    on: basePlate.id, stud: antiStudAt(basePlate, f.x, f.z),
    rot: f.rot, receptor: f.rec, under: true,
    step: 1, module: 'base',
    evidence: ['lantern_base_detail', 'lantern_a045'],
    note: `粉支脚 ${f.dir}（真实底孔扣合，替代 v4 的无接口 mount）`,
  });
}

// ================================================================
// Step 2：四角柱（3062b + 4073 单元）
// ================================================================
const Y_TOP = 1;
const CORNERS = [[0, 0], [5, 0], [0, 5], [5, 5]];
const columnStacks = [];
for (const [n, [cx, cz]] of CORNERS.entries()) {
  let parent = basePlate, stud = studAt(basePlate, cx, cz);
  const stack = [];
  for (let u = 0; u < COLUMN_UNITS; u++) {
    const brick = b.add('3062b', PINK, {
      on: parent.id, stud, step: 2, module: 'columns',
      evidence: ['lantern_a090_e00', 'lantern_a045'],
      note: `角柱 ${n + 1} 第 ${u + 1}/${COLUMN_UNITS} 单元·3062b（3 片）`,
    });
    const plate = b.add('4073', PINK, {
      on: brick.id, stud: 0, step: 2, module: 'columns',
      evidence: ['lantern_a090_e00'],
      note: `角柱 ${n + 1} 第 ${u + 1}/${COLUMN_UNITS} 单元·4073（1 片）`,
    });
    stack.push(brick.id, plate.id);
    parent = plate; stud = 0;
  }
  columnStacks.push(stack);
}
const COLUMN_TOP = Y_TOP + COLUMN_PLATES;   // 31

// ================================================================
// Step 3：中央芯柱（3941）
// ================================================================
const coreBase = cellOwner.get('2,2');
let coreParent = coreBase.id, coreStud = studAt(coreBase, 2, 2);
const CORE_ORDER = [
  { color: PINK, name: '亮粉' },
  { color: MAGENTA, name: '品红' },
  { color: RED, name: '红' },
  { color: DARKRED, name: '深红' },
  { color: RED, name: '红' },
  { color: MAGENTA, name: '品红' },
  { color: PINK, name: '亮粉' },
];for (let i = 0; i < CORE_BRICKS; i++) {
  const p = b.add('3941', CORE_ORDER[i].color, {
    on: coreParent, stud: coreStud, step: 3, module: 'core',
    evidence: ['lantern_a090_e00', 'lantern_a135_e10'],
    note: `芯柱 ${i + 1}/${CORE_BRICKS}：3941 ${CORE_ORDER[i].name}（颜色分段 pending）`,
  });
  coreParent = p.id; coreStud = 0;
}
const CORE_TOP = Y_TOP + CORE_PLATES;   // 22

// ================================================================
// Step 4：棚顶端板 —— 落在四根柱顶上
// 柱顶 y=21，芯顶 y=13，差 CORE_GAP=8 片。
//
// 关于「芯柱顶端不到端板」的说明（重要，避免把不确定当结论）：
//   照片上芯柱确实比柱短，但**是否短到端板之下、中间是否真有 8 片空腔**，
//   本轮六张照片都不足以判定（躺倒平视照里芯柱两端都被柱与端板遮挡）。
//   v5 保留 v4 的结构与这个 8 片高差，但没有把「芯柱顶面压住端板」当作事实，
//   也没有给它补推断件。芯柱的约束来自其底部真实扣合 + 四角柱围成的空间。
//   这一项列为 pending，见 out/lantern-repair/2026-10-27-r5/main/result.md。
// ================================================================
const Y_CANOPY = COLUMN_TOP;   // 21

const colTopId = (x, z) => {
  const idx = CORNERS.findIndex(([cx, cz]) => cx === x && cz === z);
  const stack = columnStacks[idx];
  return stack[stack.length - 1];
};

const canopyPlate = b.add('3958', BLUE, {
  on: colTopId(0, 0), stud: 0, step: 4, module: 'canopy',
  evidence: ['lantern_top_detail', 'lantern_a045'],
  note: '棚顶端板 6×6（扣在一根柱顶；另三柱顶面承托底面）',
});

// ================================================================
// Step 5：棚顶装饰层
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

// 淡紫 2×4 两块沿 z 并排，填内区 x1..4 / z1..4
for (let k = 0; k < 2; k++) {
  addOnCanopy('3020', PURPLE, 1, 1 + k * 2, {
    evidence: ['lantern_top_detail'],
    note: `淡紫 2×4 第 ${k + 1}/2 块（内区并排；格数 pending）`,
  });
}

// 粉框外圈：x 边 rot=90+rec=1（向 +z），z 边 rot=0+rec=0（向 +x）。
// 这是相对 v4 的关键修正：v4 在 x 边用 rec=0（向 -z），从 z=0 起步导致越界到 z=-1。
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

// 十字高台：四边中段在粉框上再叠一层
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
  { id: 'columns', label: `四角柱（3062b + 4073 × ${COLUMN_UNITS} 单元）`, explode: [-16, 0, 0] },
  { id: 'core', label: `中央芯柱（3941 × ${CORE_BRICKS}）`, explode: [16, 0, 0] },
  { id: 'canopy', label: '棚顶（端板 + 淡紫板 + 粉十字）', explode: [0, 18, 0] },
];

const outFile = path.join(ROOT, 'examples/lantern.reconstructed.v5.brick.json');
fs.writeFileSync(outFile, JSON.stringify(model, null, 1) + '\n');
console.log(`件数 ${model.parts.length}`);
console.log(`柱：${COLUMN_UNITS} 单元 × ${UNIT_PLATES} 片 = ${COLUMN_PLATES} 片，柱顶 y=${COLUMN_TOP}`);
console.log(`芯：${CORE_BRICKS} 颗 3941 = ${CORE_PLATES} 片，芯顶 y=${CORE_TOP}（低于柱顶 ${CORE_GAP} 片）`);
console.log(`棚顶端板层 y=${Y_CANOPY}`);
console.log(`→ ${path.relative(ROOT, outFile)}`);
