// 生成 examples/trex.reconstructed.brick.json —— 31058 T-Rex（说明书还原 v6）
// v6 相对 v5 的推进（本次测试目标：验证官方说明书 → BOM → 4,600 目录 → builder 重建管线）：
//   ① 真实专用件首次可用：27261 白爪板（官方 6046381 三爪牙板精确匹配）用于脚爪与口部牙板；
//   ② 背棘 6 件：官方 6270091 黑棘未收录 → 4589b 黑圆锥风格化替代（v5 为深绿奶酪砖）；
//   ③ 眼睛：官方 6171764/6240227 橙眼 → 4073 橙圆板 + 98138 黑瞳（v5 为纯黄圆片）；
//   ④ 尾尖/颈后曲面：11477 弧面斜坡替代 v5 的 3040b 直斜面；
//   ⑤ 改用 createBuilder 防错搭建（v5 为手写 JSON 坐标）。
// 仍未还原（披露）：下颌/舌（需 3710/3004 暗红件悬空连接，引擎不支持倒置与悬臂无支撑）、
//   球关节髋（17114 已在目录但连接语义未接）、前臂小爪、腿部侧凸点楔形件。
import fs from 'fs';
import { createBuilder } from '../src/core/builder.js';

const G = 2, DG = 288, W = 15, K = 0, DR = 320, O = 25;

const ext = JSON.parse(fs.readFileSync('catalog/parts-ldraw.json', 'utf8')).parts;
const cur = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8')).parts;
const colors = JSON.parse(fs.readFileSync('catalog/colors.json', 'utf8')).colors;
const catalog = { parts: { ...ext, ...cur }, colors };

const b = createBuilder({
  catalog,
  meta: {
    name: '31058 威猛恐龙 T-Rex（说明书还原 v6）',
    createdAt: new Date().toISOString().slice(0, 10),
    front: '+z',
    description:
      '按官方说明书第 1 册（48 页）+ 第 45 页零件表（examples/trex.bom.json，55 条 138 件）还原。' +
      'v6 已用真实件：27261 三爪牙板（官方 6046381 精确匹配）作脚爪与口牙、4073+98138 橙眼黑瞳、' +
      '4589b 黑圆锥替代背棘（官方 6270091 未收录）、11477/15068 曲面斜坡。' +
      '已知简化（披露）：①下颌/舌/前臂未建（需倒置与悬臂支撑，引擎限制）；②球关节髋/滚轮踝以刚性简化；' +
      '③腿部侧凸点楔形件（4543262/59）以普通板近似；④目测取色，个别深浅棕褐可能与官方有色差。',
    photoSet: 'trex.instructions.json',
  },
});

const EV = ['trex_p44', 'trex_cover'];

// —— 腿（step 1，x1-2 / x5-6，z12-15）——
for (const lx of [1, 5]) {
  b.add('3020', G, { at: [lx, 0, 12], rot: 90, step: 1, module: 'legs', evidence: EV, note: '脚底板' });
  b.add('3020', G, { at: [lx, 1, 12], rot: 90, step: 1, module: 'legs', evidence: EV, note: '脚面' });
  b.add('3023', DR, { at: [lx, 2, 12], step: 1, module: 'legs', evidence: EV, note: '脚后跟板（官方同位暗红件）' });
  b.add('27261', W, { at: [lx, 2, 14], step: 1, module: 'legs', evidence: EV, note: '三爪牙板作脚爪（官方 6046381/6052824 真实爪件的目录对应；z16 悬臂 1 格合法）' });
  b.add('3003', G, { at: [lx, 3, 12], step: 1, module: 'legs', evidence: EV, note: '踝' });
  b.add('3022', G, { at: [lx, 6, 12], step: 1, module: 'legs', evidence: EV, note: '大腿板' });
}

// —— 身体平台 + 两行砖 + 背板（step 2）——
b.add('41539', G, { at: [0, 7, 6], step: 2, module: 'body', evidence: EV, note: '身体平台 8×8（骑双腿）' });
b.add('2456', G, { at: [1, 8, 11], step: 2, module: 'body', evidence: EV, note: '身体上行前' });
b.add('2456', G, { at: [1, 8, 13], step: 2, module: 'body', evidence: EV, note: '身体上行后' });
b.add('3020', DG, { at: [1, 11, 11], step: 2, module: 'body', evidence: EV, note: '背部深绿条纹板' });
b.add('3020', G, { at: [1, 11, 13], step: 2, module: 'body', evidence: EV, note: '背板' });

// —— 尾巴（step 3：尾根 → 尾段 → 尾背板 → 曲面尾尖 + 黑棘）——
b.add('3001', G, { at: [2, 8, 6], rot: 90, step: 3, module: 'tail', evidence: EV, note: '尾根砖' });
b.add('3020', G, { at: [2, 11, 8], step: 3, module: 'tail', evidence: EV, note: '尾根顶板' });
b.add('2456', G, { at: [2, 12, 3], rot: 90, step: 3, module: 'tail', evidence: EV, note: '尾段（跨 z3-8）' });
b.add('3020', G, { at: [2, 15, 4], step: 3, module: 'tail', evidence: EV, note: '尾背板' });
b.add('3023', DG, { at: [2, 15, 3], step: 3, module: 'tail', evidence: EV, note: '尾尖连接板' });
b.add('11477', DG, { at: [2, 16, 3], step: 3, module: 'tail', evidence: EV, note: '尾尖曲面（官方 1×4 长曲面以 1×2 近似）' });
b.add('4589b', K, { at: [2, 16, 5], step: 3, module: 'tail', evidence: EV, note: '尾背棘（官方 6270091 替代）' });

// —— 头颈（step 4）——
b.add('3003', G, { at: [1, 12, 14], step: 4, module: 'head', evidence: EV, note: '颈柱左' });
b.add('3003', G, { at: [3, 12, 14], step: 4, module: 'head', evidence: EV, note: '颈柱右' });
b.add('3001', G, { at: [1, 15, 14], step: 4, module: 'head', evidence: EV, note: '头后（砖）' });
b.add('3020', G, { at: [1, 18, 15], step: 4, module: 'head', evidence: EV, note: '头悬臂板1' });
b.add('3001', G, { at: [1, 19, 16], step: 4, module: 'head', evidence: EV, note: '头中（砖）' });
b.add('3020', DG, { at: [1, 22, 17], step: 4, module: 'head', evidence: EV, note: '吻顶悬臂板2（深绿）' });
b.add('11477', G, { at: [1, 22, 16], rot: 90, step: 4, module: 'head', evidence: EV, note: '头后曲面' });
b.add('4589b', K, { at: [1, 18, 14], step: 4, module: 'head', evidence: EV, note: '头后棘' });

// —— 细节（step 5：牙板 + 橙眼黑瞳 + 背棘）——
b.add('27261', W, { at: [2, 23, 18], step: 5, module: 'head', evidence: EV, note: '口部牙板（官方 6046381 精确匹配件）' });
b.add('4073', O, { at: [1, 23, 18], step: 5, module: 'head', evidence: EV, note: '左眼橙圆板（官方 6171764）' });
b.add('4073', O, { at: [4, 23, 18], step: 5, module: 'head', evidence: EV, note: '右眼橙圆板' });
b.add('98138', K, { at: [1, 24, 18], step: 5, module: 'head', evidence: EV, note: '左瞳' });
b.add('98138', K, { at: [4, 24, 18], step: 5, module: 'head', evidence: EV, note: '右瞳' });
b.add('4589b', K, { at: [2, 12, 9], step: 3, module: 'tail', evidence: EV, note: '尾根背棘（官方 6270091 替代）' });
for (const z of [11, 12, 13]) {
  b.add('4589b', K, { at: [2, 12, z], step: 5, module: 'body', evidence: EV, note: '背棘（官方 6270091 黑棘 ×6 之三）' });
}

// —— 汇总校验与落盘 ——
b.assert();
b.save('examples/trex.reconstructed.brick.json');

// builder 不写 model.modules（爆炸视图元数据），保存后补写
const outPath = 'examples/trex.reconstructed.brick.json';
const model = JSON.parse(fs.readFileSync(outPath, 'utf8'));
model.modules = [
  { id: 'legs', label: '双腿', explode: [0, -8, 0] },
  { id: 'body', label: '身体', explode: [0, 0, 0] },
  { id: 'tail', label: '尾巴', explode: [0, 4, -8] },
  { id: 'head', label: '头颈', explode: [0, 18, 6] },
];
fs.writeFileSync(outPath, JSON.stringify(model, null, 2) + '\n');

// BOM 覆盖统计（读回 examples/trex.bom.json 回填核对 exact/substitute/omit）
const bom = JSON.parse(fs.readFileSync('examples/trex.bom.json', 'utf8'));
const stat = { entries: bom.entries.length, qtyTotal: 0, exact: 0, substitute: 0, omit: 0, exactQty: 0 };
for (const e of bom.entries) {
  stat.qtyTotal += e.qty;
  stat[e.status]++;
  if (e.status === 'exact') stat.exactQty += e.qty;
}
console.log(`v6 生成 ${b.parts().length} 个零件（v5 为 38）`);
console.log(`BOM：${stat.entries} 条 / ${stat.qtyTotal} 件 | 精确 ${stat.exact} 条 ${stat.exactQty} 件 | 替代 ${stat.substitute} 条 | 省略 ${stat.omit} 条`);
