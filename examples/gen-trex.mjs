// 生成 examples/trex.reconstructed.brick.json —— 31058 T-Rex（说明书第 1 册还原 v5）
// 参照：第 1 册封面 + 第 44 页成品视图 + 第 46 页封底合集
// 坐标：+z 鼻尖方向；长轴沿 z（尾 z2-9 → 身体平台 z6-13 → 头 z14-21）
// 层表：腿 y0-7 → 身体平台 8×8 y7 → 身体两行砖 y8-10 → 背板 y11 → 尾/头链 y11 起
// 替代披露：白爪/牙/角专用件→54200 奶酪斜砖；深灰凸粒件→71/72；眼睛印刷件→黄色 1×1 圆片；颌/舌→推断简化
import fs from 'fs';

const G = 10, DG = 288, DT = 28, W = 15, DBG = 72, DR = 320, Y = 14;
const P = [];
let n = 0;
const add = (part, color, at, opts = {}) => {
  n++;
  P.push({ id: `p${String(n).padStart(3, '0')}`, part, color, at, step: opts.step ?? 1, ...opts });
};

// —— 腿（左右对称 x1-2 / x5-6，z12-15）——
for (const lx of [1, 5]) {
  add('3020', G, [lx, 0, 12], { rot: 90, step: 1, note: '脚底板' });
  add('3020', G, [lx, 1, 12], { rot: 90, step: 1, note: '脚面' });
  add('3023', DR, [lx, 2, 12], { step: 1, status: 'uncertain', note: '脚后深红板' });
  add('54200', W, [lx, 2, 14], { step: 1, note: '白爪（替代专用爪件）' });
  add('3024', DBG, [lx, 2, 15], { step: 1, status: 'uncertain', note: '深灰前趾' });
  add('3003', G, [lx, 3, 12], { step: 1, note: '踝' });
  add('3022', G, [lx, 6, 12], { step: 1, note: '大腿板' });
}

// —— 身体平台 + 两行砖 + 背板 ——
add('41539', G, [0, 7, 6], { step: 2, note: '身体平台 8×8（骑双腿）' });
add('2456', G, [1, 8, 11], { step: 2, note: '身体上行前' });
add('2456', G, [1, 8, 13], { step: 2, note: '身体上行后' });
add('3020', DG, [1, 11, 11], { step: 2, note: '背部深绿条纹板' });
add('3020', G, [1, 11, 13], { step: 2, note: '背板' });

// —— 尾巴（平台后延：尾根 → 2 宽尾段 → 背板 → 深绿斜尖）——
add('3001', G, [2, 8, 6], { rot: 90, step: 3, note: '尾根砖' });
add('3020', G, [2, 11, 8], { step: 3, note: '尾根顶板' });
add('2456', G, [2, 12, 3], { rot: 90, step: 3, note: '尾段（跨 z3-8）' });
add('3020', G, [2, 15, 4], { step: 3, note: '尾背板' });
add('3023', DG, [2, 15, 3], { step: 3, note: '尾尖连接板' });
add('3040b', DG, [2, 16, 3], { rot: 180, step: 3, note: '尾尖斜面（朝后）' });

// —— 头颈（颈柱 y11-13，头 y14-16，顶板 y17）——
add('3003', G, [1, 12, 14], { step: 4, note: '颈柱左' });
add('3003', G, [3, 12, 14], { step: 4, note: '颈柱右' });
add('3001', G, [1, 15, 14], { step: 4, note: '头后（砖）' });
add('3020', G, [1, 18, 15], { step: 4, note: '头悬臂板1' });
add('3001', G, [1, 19, 16], { step: 4, note: '头中（砖）' });
add('3020', DG, [1, 22, 17], { step: 4, note: '吻顶悬臂板2（深绿）' });
// 眼睛（黄 1×1 圆片，吻顶前缘两侧）
add('98138', Y, [1, 23, 18], { step: 4, status: 'uncertain', note: '左眼（替代印刷件）' });
add('98138', Y, [4, 23, 18], { step: 4, status: 'uncertain', note: '右眼' });
// 上牙（直立风格化：吻顶前缘中央）
add('54200', W, [2, 23, 18], { step: 4, note: '上牙（风格化直立）' });
add('54200', W, [3, 23, 18], { step: 4, note: '上牙' });

// —— 背脊深绿奶酪砖 ——
for (const z of [11, 12]) add('54200', DG, [2, 12, z], { step: 6, note: '背脊棘' });
add('54200', DG, [2, 12, 13], { step: 6, note: '背脊棘' });

// —— 前臂：照片半遮挡且网格连接受限，整只以推断记录（见 meta.description）——

// —— 下颌/舌：说明书可见但需要专用铰链件，本轮以描述披露代替占位件（避免无连接悬空）——

const model = {
  format: 'brickbuild',
  version: '0.2',
  meta: {
    name: '31058 威猛恐龙 T-Rex（说明书还原 v5）',
    createdAt: new Date().toISOString().slice(0, 10),
    front: '+z',
    description: '按官方说明书第 1 册还原。已知简化（全部披露）：①白爪/牙/角专用件以 54200 奶酪斜砖风格化替代；②眼睛印刷件以黄色 1×1 圆片替代；③下颌/舌/前臂本轮未建（需专用铰链与悬臂结构，见 gen-trex.mjs）；④深灰凸粒件以深蓝灰板替代。',
    photoSet: 'trex.instructions.json',
  },
  parts: P,
  modules: [
    { id: 'legs', label: '双腿', explode: [0, -8, 0] },
    { id: 'body', label: '身体', explode: [0, 0, 0] },
    { id: 'tail', label: '尾巴', explode: [0, 4, -8] },
    { id: 'head', label: '头颈', explode: [0, 18, 6] },
  ],
};

for (const p of P) {
  p.module = p.step === 1 ? 'legs' : p.step === 2 ? 'body' : p.step === 3 ? 'tail' : p.step === 4 ? 'head' : 'head';
  p.evidence = ['trex_p44', 'trex_cover'];
}
fs.writeFileSync('examples/trex.reconstructed.brick.json', JSON.stringify(model, null, 1));
console.log(`生成 ${P.length} 个零件 → examples/trex.reconstructed.brick.json`);
