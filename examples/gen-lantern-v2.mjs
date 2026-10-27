// 生成灯笼重建 v2 —— 用 builder（snap/显式整数格，写入即查碰撞）枚举 24 个候选变体。
// 与 v1（examples/gen-lantern.mjs·v4 六柱 4073×72 件）的关键差异，依据 out/lantern-v2/measurements.json 实测：
//   ① 比例收紧：e00 实测整体长宽比 1.945（6 格截面 → 总高 ≈ 29 片）、柱区间占比 0.859（端帽各 ~7%）；
//      v1 六柱 12×4073（72 件超观察区间 [12,52]、总高 21 片偏短）→ v2 四角柱（观察清单「柱在端板四角」）。
//   ② 柱件种枚举：3062b×9（总高 31 片）/ 3062b×8（28 片）/ 4073×13（52 件顶格、总高 17 片，按任务要求保留枚举）。
//   ③ 芯分段枚举：实测红簇集中在轴中段（xRatio 0.43~0.65），轴向颜色顺序无法程序化判定（被柱遮挡），
//      按 photos.json 标注（e00「深红→红→粉→红」、a135「左深红、中红、右粉」）枚举 4 组合（从底座端向上）。
//   ④ 绿件/品红两档：观察区间下限（绿 1「绿芯」+ 品红 1）/ 中值（绿十字 3 + 品红 2）。
//   ⑤ 端面 V 形淡紫板整数网格不可表达 → 并排放置并标 status:'uncertain'。
// 结构（直立搭建，轴 = y，底座在下、棚顶在上；截面 6×6，四角柱 (0,0)(5,0)(0,5)(5,5)）：
//   y0 粉支脚 4×3023（半压在底板下）→ y1 深蓝端板 3×3795（6×6）→ y2 绿芯/绿十字 + 品红点缀
//   → y2.. 柱（角）+ 芯（中央 2×2 圆砖，y3 起）→ 柱顶 深蓝端板（4×3020+3022）→ 粉围边 6×3023 + 淡紫 2×3795 并排
// 变体总数 3×4×2 = 24，逐个写入 out/lantern-v2/vNN.brick.json；--export <序号或 best json> 另出正式文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder } from '../src/core/builder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8'));
const measurements = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/lantern-v2/measurements.json'), 'utf8'));

// —— 实测派生（见文件头；全部来自 measurements.json 的 lantern_a090_e00，e05 掩膜窗口不可靠仅参考）——
const M = measurements.photos.find((p) => p.id === 'lantern_a090_e00');
const ASPECT_PCA = M.aspect.aspect;                     // 1.945：band 内 PCA（裁掉了端部上下沿，偏高）
const ASPECT = M.body.bboxAspect;                       // 1.6：主体 bbox（含支脚/棚顶外挑，整体比例，以此为准）
const SPAN = M.columnSpan.columnSpanRatio;              // 0.859：柱区间占总长比
const SECTION_STUDS = 6;                                // 截面 6×6（观察清单端板 + BOM 可整铺性：36=3×3795）
const TARGET_TOTAL_PLATES = Math.round(ASPECT * SECTION_STUDS * 2.5);   // 1.6×6 格×2.5 片/格 ≈ 24 片
const TARGET_INTERIOR = Math.round(SPAN * TARGET_TOTAL_PLATES);         // 0.859×24 ≈ 21 片

// —— 变体轴（任务指定）——
// 柱件种：M 由实测柱高（TARGET_INTERIOR ≈ 21 片）换算并夹在 BOM 区间 [12,52] 内
const COLUMN_OPTS = [
  { id: 'B7', part: '3062b', per: 7, note: `3062b×7/柱（21 片，总高 25 片=1.67 比例，4 柱共 28 件∈[12,52]；实测总高目标 ${TARGET_TOTAL_PLATES} 片、柱区间 ${SPAN}×25≈21.5 → M=7 最贴` },
  { id: 'B8', part: '3062b', per: 8, note: '3062b×8/柱（24 片，总高 28 片=1.87 比例，偏长上邻，按 band-PCA 1.945 的换算保留作对照' },
  { id: 'P13', part: '4073', per: 13, note: '4073×13/柱（13 片，总高 17 片=1.13 比例，4 柱共 52 件=BOM 上限；明显矮胖，按任务枚举保留（注意：两张 degraded 椭圆掩膜照片会系统性抬爱矮胖模型）' },
];
// 芯分段（从底座端向上的颜色顺序；320 深红 / 4 红 / 29 粉）
const CORE_OPTS = [
  { id: 'P-R-D', order: [29, 4, 320], note: '3 段：粉-红-深红（红居轴中段，实测红簇 xRatio 0.43~0.65 吻合；a135「左深红中红右粉」若照片左=底座端则相反序）' },
  { id: 'D-R-P', order: [320, 4, 29], note: '3 段：深红-红-粉（红居轴中段；a135「左深红、中红、右粉」若照片左=棚顶端）' },
  { id: 'R-P-R-D', order: [4, 29, 4, 320], note: '4 段：红-粉-红-深红（e00 标注「深红→红→粉→红」按照片左=棚顶端反转到底座端起）' },
  { id: 'D-R-P-R', order: [320, 4, 29, 4], note: '4 段：深红-红-粉-红（e00 标注原序，按照片左=底座端）' },
];
// 绿件/品红两档：观察区间 {下限, 中值}
const GREENTOP_OPTS = [
  { id: 'lo', green: 'core', magenta: 1, note: '下限档：绿 1 件（3022 绿芯，a045「底部深蓝+绿芯」）+ 品红 1 件' },
  { id: 'mid', green: 'cross', magenta: 2, note: '中值档：绿十字 3 件（3795 横臂 + 3022×2 纵臂端，base_detail「绿十字板与深蓝板交错」）+ 品红 2 件' },
];

const CORNERS = [[0, 0], [5, 0], [0, 5], [5, 5]];   // 四角柱（观察清单「柱在端板四角」）
const EVIDENCE_ALL = ['lantern_a045', 'lantern_a090_e05', 'lantern_a090_e00', 'lantern_a135_e10'];

/** 生成一个变体的模型（返回 builder.model()；有任何穿模/编号错误会在 add 时抛中文错误） */
function buildVariant(col, core, gt, variantId) {
  const b = createBuilder({
    catalog,
    meta: {
      name: `粉紫灯笼（实物重建 v2·四角柱 ${variantId}）`,
      createdAt: new Date().toISOString().slice(0, 10),
      front: '+z',
      photoSet: 'lantern.photos.json',
      description: `v2 依据：实测比例（out/lantern-v2/measurements.json：e00 长宽比 ${ASPECT}、柱区间占比 ${SPAN}）+ 24 变体枚举选优。`
        + `柱 ${col.note}；芯 ${core.note}；绿/品红 ${gt.note}。`
        + '不可表达项：棚顶淡紫 2×4 板实拍呈 V 形对角错位，整数网格 + 90° 旋转只能并排近似（status:uncertain）；'
        + '端面深蓝过渡板的具体分件与品红位置凭照片近似。',
    },
  });
  const colH = col.part === '3062b' ? col.per * 3 : col.per;   // 柱高（片）
  const colTop = 2 + colH;                                     // 柱顶面层号
  const canopyTop = colTop + 2;                                 // 棚顶最上层号

  // —— Step 1 底座（y0-y2）——
  b.add('3023', 29, { at: [-1, 0, 2], step: 1, module: 'base', evidence: ['lantern_base_detail', 'lantern_a045'], note: '粉支脚·东（半压底板下）' });
  b.add('3023', 29, { at: [5, 0, 3], step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '粉支脚·西' });
  b.add('3023', 29, { at: [2, 0, -1], rot: 90, step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '粉支脚·北' });
  b.add('3023', 29, { at: [3, 0, 5], rot: 90, step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '粉支脚·南' });
  b.add('3795', 272, { at: [0, 1, 0], step: 1, module: 'base', evidence: ['lantern_base_detail', 'lantern_a090_e00'], note: '底座深蓝端板 6×6（3 条 2×6）' });
  b.add('3795', 272, { at: [0, 1, 2], step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '底座深蓝端板' });
  b.add('3795', 272, { at: [0, 1, 4], step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '底座深蓝端板' });
  if (gt.green === 'core') {
    b.add('3022', 10, { at: [2, 2, 2], step: 1, module: 'base', evidence: ['lantern_a045', 'lantern_base_detail'], note: '绿芯 2×2（a045「底部深蓝+绿芯」），芯立其上' });
  } else {
    b.add('3795', 10, { at: [0, 2, 2], step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '绿十字横臂 2×6（与下层深蓝交错）' });
    b.add('3022', 10, { at: [2, 2, 0], step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '绿十字纵臂端 2×2' });
    b.add('3022', 10, { at: [2, 2, 4], step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '绿十字纵臂端 2×2' });
  }
  b.add('3069b', 5, { at: [0, 2, 1], step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '品红点缀 1×2 平板（base_detail「品红点缀件数量少」）' });
  if (gt.magenta >= 2) b.add('3069b', 5, { at: [4, 2, 4], step: 1, module: 'base', evidence: ['lantern_base_detail'], note: '品红点缀第 2 处' });

  // —— Step 2 四角柱 + 中央芯 ——
  for (const [cx, cz] of CORNERS) {
    for (let i = 0; i < col.per; i++) {
      const y = col.part === '3062b' ? 2 + i * 3 : 2 + i;
      b.add(col.part, 29, { at: [cx, y, cz], step: 2, module: 'columns', evidence: ['lantern_a090_e05', 'lantern_a090_e00', 'lantern_a135_e10'], note: `${col.part === '3062b' ? '圆砖' : '圆板'}柱段 ${i + 1}/${col.per}（四角柱）` });
    }
  }
  for (let i = 0; i < core.order.length; i++) {
    b.add('3941', core.order[i], { at: [2, 3 + i * 3, 2], step: 2, module: 'core', evidence: ['lantern_a090_e05', 'lantern_a090_e00', 'lantern_a135_e10'], note: `芯段 ${i + 1}/${core.order.length}（${core.id}，从底座端向上）` });
  }

  // —— Step 3 棚顶（柱顶端板 + 粉围边 + 淡紫板）——
  b.add('3020', 272, { at: [0, colTop, 0], step: 3, module: 'canopy', evidence: ['lantern_top_detail', 'lantern_a090_e00'], note: '棚顶深蓝端板 2×4（4 条 + 2×2 补角盖满 6×6）' });
  b.add('3020', 272, { at: [0, colTop, 2], step: 3, module: 'canopy', evidence: ['lantern_top_detail'], note: '棚顶深蓝端板' });
  b.add('3020', 272, { at: [0, colTop, 4], step: 3, module: 'canopy', evidence: ['lantern_top_detail'], note: '棚顶深蓝端板' });
  b.add('3020', 272, { at: [4, colTop, 0], rot: 90, step: 3, module: 'canopy', evidence: ['lantern_top_detail'], note: '棚顶深蓝端板（转 90°）' });
  b.add('3022', 272, { at: [4, colTop, 4], step: 3, module: 'canopy', evidence: ['lantern_top_detail'], note: '棚顶深蓝端板补角 2×2' });
  for (const [rx, rz] of [[0, 0], [0, 2], [0, 4], [5, 0], [5, 2], [5, 4]]) {
    b.add('3023', 29, { at: [rx, colTop + 1, rz], rot: 90, step: 3, module: 'canopy', evidence: ['lantern_top_detail', 'lantern_a045'], note: '棚面粉围边 1×2（转 90° 成 1 宽条，两侧各 3 条，与淡紫板同层）' });
  }
  b.add('3795', 31, { at: [1, colTop + 1, 0], rot: 90, step: 3, module: 'canopy', status: 'uncertain', evidence: ['lantern_top_detail'], note: '淡紫 2×4 板：实拍为 V 形对角错位，整数网格不可表达，此处并排近似（uncertain）' });
  b.add('3795', 31, { at: [3, colTop + 1, 0], rot: 90, step: 3, module: 'canopy', status: 'uncertain', evidence: ['lantern_top_detail'], note: '淡紫 2×4 板（并排近似 V 形，uncertain）' });

  const model = b.model();
  model.modules = [
    { id: 'base', label: '底座端板', explode: [0, -10, 0] },
    { id: 'columns', label: '四角柱', explode: [-10, 0, 0] },
    { id: 'core', label: '中央芯柱', explode: [10, 0, 0] },
    { id: 'canopy', label: '棚顶', explode: [0, 12, 0] },
  ];
  return { model, stats: { totalPlates: canopyTop, colH, variantId } };
}

// ---------------------------------------------------------------- 枚举 24 变体
const variants = [];
let vi = 0;
for (const col of COLUMN_OPTS) for (const core of CORE_OPTS) for (const gt of GREENTOP_OPTS) {
  vi++;
  const id = `v${String(vi).padStart(2, '0')}`;
  const tag = `${col.id}|${core.id}|${gt.id}`;
  const { model, stats } = buildVariant(col, core, gt, tag);
  const file = path.join(ROOT, 'out/lantern-v2', `${id}.brick.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(model, null, 1) + '\n');
  variants.push({ id, tag, file, colTop: stats.totalPlates, colPart: col.part, colPer: col.per, core: core.order, greenMag: gt.id, parts: model.parts.length });
  console.log(`${id} ${tag} 总高${stats.totalPlates}片 ${model.parts.length}件 → ${path.relative(ROOT, file)}`);
}
fs.writeFileSync(path.join(ROOT, 'out/lantern-v2/variants-manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  derived: { ASPECT, SPAN, SECTION_STUDS, TARGET_TOTAL_PLATES, TARGET_INTERIOR, source: 'out/lantern-v2/measurements.json (lantern_a090_e00)' },
  axes: { column: COLUMN_OPTS.map((c) => ({ id: c.id, part: c.part, per: c.per, note: c.note })), core: CORE_OPTS.map((c) => ({ id: c.id, order: c.order, note: c.note })), greenMagenta: GREENTOP_OPTS.map((g) => ({ id: g.id, green: g.green, magenta: g.magenta, note: g.note })) },
  count: variants.length,
  variants,
}, null, 2));
console.log(`共 ${variants.length} 个变体（3 柱种 × 4 芯序 × 2 绿/品红档）→ out/lantern-v2/variants-manifest.json`);

// ---------------------------------------------------------------- --export <vNN>：把最优变体落为正式重建模型
const exportIdx = process.argv.indexOf('--export');
if (exportIdx > 0) {
  const want = process.argv[exportIdx + 1];
  const v = variants.find((x) => x.id === want);
  if (!v) throw new Error(`--export：找不到变体 ${want}（可用：${variants.map((x) => x.id).join(', ')}）`);
  const col = COLUMN_OPTS.find((c) => v.tag.startsWith(c.id + '|'));
  const core = CORE_OPTS.find((c) => v.tag.split('|')[1] === c.id);
  const gt = GREENTOP_OPTS.find((g) => v.tag.endsWith('|' + g.id));
  const { model } = buildVariant(col, core, gt, v.tag);
  model.meta.name = '粉紫灯笼（实物重建 v2·四角柱）';
  model.meta.description = `v2（替代偏长偏瘦/绿件过多/芯序存疑的 v1）：依据照片实测比例（tools/measure-lantern.mjs → `
    + `out/lantern-v2/measurements.json，e00 整体长宽比 ${ASPECT}、柱区间占比 ${SPAN}）+ 24 变体枚举（3 柱种 × 4 芯序 × 2 绿/品红档，`
    + `fixed 320 快筛 + joint 640 终评，见 out/lantern-v2/variants.json），最优变体 ${v.id}（${v.tag}）。`
    + `柱 ${col.note}；芯 ${core.note}；绿/品红 ${gt.note}。`
    + '不可表达项：①棚顶淡紫 2×4 板实拍呈 V 形对角错位，整数网格 + 90° 旋转只能并排近似（status:uncertain）；'
    + '②芯柱深红/红/粉轴向顺序被角柱遮挡、无法从照片程序化判定，按 photos.json 标注枚举后由 joint diff 选优；'
    + '③端面深蓝板分件与品红位置凭照片近似。';
  const official = path.join(ROOT, 'examples/lantern.reconstructed.brick.json');
  fs.writeFileSync(official, JSON.stringify(model, null, 1) + '\n');
  console.log(`最优变体 ${v.id}（${v.tag}）→ ${path.relative(ROOT, official)}`);
}
