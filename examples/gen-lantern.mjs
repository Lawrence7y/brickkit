// 生成 examples/lantern.reconstructed.brick.json —— 粉紫灯笼（实物照片重建 v4·六柱）
// 结构（照片 6 轨高定量核对：±R 与 ±R/2 四级轨高 → 六边形六柱）：
//   底座：6 组 1×1 板柱垫（粉×3 + 蓝×1）+ 蓝十字(y1 沿x / y2 沿z偏左) + 绿板(y3) + 粉脚 + 品红点缀
//   柱：6 × (12 片 1×1 圆板)；芯：2×2 圆砖 ×4（深红/红/粉/红）
//   棚顶：蓝 6×6 板 + 粉 1×2 空心凸点砖 6×6 阵 + 淡紫 2×4 板 ×2
import fs from 'fs';

const P = [];
let n = 0;
const add = (part, color, at, opts = {}) => {
  n++;
  P.push({ id: `p${String(n).padStart(3, '0')}`, part, color, at, step: opts.step ?? 1, ...opts });
};

// —— 第 1 步：底座（y0-y3） ——
// 六柱位（六边形，柱垫用 1×1 板堆避开中央十字板层的交叠）
const HEX = [
  [3, 0, '北'], [5, 1, '东北'], [5, 4, '东南'], [3, 5, '南'], [0, 4, '西南'], [0, 1, '西北'],
];
for (const [x, z, dir] of HEX) {
  add('3024', 29, [x, 0, z], { note: `${dir}柱垫粉 L1（兼支脚）` });
  add('3024', 29, [x, 1, z], { note: `${dir}柱垫粉 L2` });
  add('3024', 29, [x, 2, z], { note: `${dir}柱垫粉 L3` });
  add('3024', 272, [x, 3, z], { note: `${dir}柱垫蓝（柱基）` });
}
// 中央十字：蓝 y1 沿 x / y2 沿 z（偏左 x1-2），绿 y3（芯正下方）
add('3795', 272, [1, 1, 2], { note: '蓝十字沿 x' });
add('3795', 272, [1, 2, 1], { rot: 90, note: '蓝十字沿 z' });
add('3795', 10, [1, 3, 2], { note: '绿板沿 x，芯立其上' });
// 十字臂端粉色支脚板
add('3023', 29, [0, 0, 2], { note: '西支脚' });
add('3023', 29, [4, 0, 2], { note: '东支脚' });
add('3023', 29, [2, 0, 0], { rot: 90, note: '南支脚' });
add('3023', 29, [2, 0, 5], { rot: 90, note: '北支脚' });
// 品红点缀（蓝 z 向板两端上方）
add('3069b', 5, [1, 3, 0], { rot: 90, status: 'uncertain', note: '品红点缀，照片仅见 1-2 处' });
add('3069b', 5, [2, 3, 4], { rot: 90, status: 'uncertain', note: '品红点缀' });

// —— 第 2 步：6 根柱（12 片 1×1 圆板）+ 中央芯（4 块 2×2 圆砖） ——
for (const [x, z] of HEX) {
  for (let i = 0; i < 12; i++) add('4073', 29, [x, 4 + i, z], { step: 2, note: `柱段${i + 1}/12` });
}
const CORE_COLORS = [320, 4, 29, 4];
for (let i = 0; i < 4; i++) add('3941', CORE_COLORS[i], [2, 4 + i * 3, 2], { step: 2, status: 'uncertain', note: '芯段颜色顺序待对账' });

// —— 第 3 步：棚顶（y16-y20） ——
add('3958', 272, [0, 16, 0], { step: 3, note: '棚底蓝 6×6 板，骑 6 柱顶与芯顶' });
for (let x = 0; x <= 5; x += 2) for (let z = 0; z <= 5; z++) add('3065', 29, [x, 17, z], { step: 3, note: '棚面粉砖阵 6×6' });
add('3795', 31, [1, 20, 1], { step: 3, status: 'uncertain', note: '淡紫板，照片呈对角错位 V 形，网格 rot 限制下 v4 并排' });
add('3795', 31, [1, 20, 3], { step: 3, status: 'uncertain', note: '淡紫板' });

const model = {
  format: 'brickbuild',
  version: '0.2',
  meta: {
    name: '粉紫灯笼（实物重建 v4·六柱）',
    createdAt: new Date().toISOString().slice(0, 10),
    front: '+z',
    description: '两端十字端板 + 6 根环形粉圆板柱 + 中央红芯的小灯笼。照片 6 张，位于 D:/bingdown/新建文件夹 (2)',
    photoSet: 'lantern.photos.json',
  },
  parts: P,
  modules: [
    { id: 'base', label: '底座十字', explode: [0, -8, 0] },
    { id: 'columns', label: '环形柱', explode: [0, 0, 0] },
    { id: 'core', label: '中央红芯', explode: [0, 14, 0] },
    { id: 'canopy', label: '棚顶', explode: [0, 24, 0] },
  ],
};

for (const p of P) {
  p.module = p.step === 1 ? 'base' : p.step === 2 ? (p.part === '3941' ? 'core' : 'columns') : 'canopy';
  p.evidence = ['lantern_a045', 'lantern_a090_e05', 'lantern_a090_e00'];
}
fs.writeFileSync('examples/lantern.reconstructed.brick.json', JSON.stringify(model, null, 1));
console.log(`生成 ${P.length} 个零件 → examples/lantern.reconstructed.brick.json`);
