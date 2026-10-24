// 生成示例模型：林间小屋（带可开的门、可取下的屋顶）
import fs from 'fs';
const parts = []; let n = 0;
const add = (part, color, at, rot, step, module, extra = {}) => {
  const id = `p${String(++n).padStart(3, '0')}`;
  parts.push({ id, part, color, at, rot, step, module, status: 'confirmed', confidence: 0.95, ...extra });
  return id;
};
const EV = { front: ['ext_a000_e30', 'ext_a000_e00'], back: ['ext_a180_e30', 'ext_a180_e00'], left: ['ext_a270_e30', 'ext_a270_e00'], right: ['ext_a090_e30', 'ext_a090_e00'] };
// 1 底板
add('41539', 2, [0, 0, 0], 0, 1, 'base', { evidence: ['ext_top_e90', 'ext_a000_e30'] });
// 2 前院
add('3068b', 28, [3, 1, 6], 0, 2, 'yard', { evidence: ['ext_a000_e30', 'ext_top_e90'] });
add('3023', 10, [0, 1, 6], 90, 2, 'yard', { evidence: ['ext_a000_e30'] });
add('3024', 4, [0, 2, 6], 0, 2, 'yard', { evidence: ['ext_a000_e30', 'detail_flowers'] });
add('3024', 14, [0, 2, 7], 0, 2, 'yard', { evidence: ['ext_a000_e30', 'detail_flowers'] });
add('3003', 288, [6, 1, 6], 0, 2, 'yard', { evidence: ['ext_a045_e30'] });
add('3022', 10, [6, 4, 6], 0, 2, 'yard', { evidence: ['ext_a045_e30'] });
// 3 室内（只在取下屋顶后看到）
const unc = { status: 'uncertain', confidence: 0.55, evidence: ['mech_roof_interior_e90'], note: '只在取下屋顶后的俯视图里看到桌面，桌腿位置为推断' };
add('3005', 70, [5, 1, 1], 0, 3, 'interior', unc);
add('3068b', 19, [5, 4, 1], 0, 3, 'interior', { ...unc, note: '桌面可见，颜色可能是沙色或浅肤色' });
add('3005', 70, [4, 1, 1], 0, 3, 'interior', { ...unc, note: '椅子被桌面挡住一半' });
// 4–10 墙体：6 层砖，转角咬合，侧墙与后墙开窗
const BR = { 1: '3005', 2: '3004', 3: '3622', 4: '3010', 6: '3009', 8: '3008' };
const split = (len, k) => ({ 1: [1], 2: [2], 3: [3], 4: [4], 5: k % 2 ? [2, 3] : [3, 2], 6: k % 2 ? [2, 4] : [4, 2], 7: [4, 3], 8: [4, 4] })[len];
const runs = (cells) => { const r = []; for (const c of cells) { const last = r[r.length - 1]; if (last && c === last[last.length - 1] + 1) last.push(c); else r.push([c]); } return r; };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
let frame;
for (let k = 0; k < 6; k++) {
  const L = 1 + 3 * k, step = k === 0 ? 4 : 5 + k, color = k === 0 ? 72 : 19, win = k === 2 || k === 3;
  const even = k % 2 === 0;
  const walls = [
    { side: 'front', along: 'x', fixed: 5, cells: (even ? range(0, 7) : range(1, 6)).filter((x) => x < 2 || x > 5) },
    { side: 'back', along: 'x', fixed: 0, cells: even ? range(0, 7) : range(1, 6), win: [3, 4] },
    { side: 'left', along: 'z', fixed: 0, cells: even ? range(1, 4) : range(0, 5), win: [2, 3] },
    { side: 'right', along: 'z', fixed: 7, cells: even ? range(1, 4) : range(0, 5), win: [2, 3] },
  ];
  for (const w of walls) {
    const cells = win && w.win ? w.cells.filter((c) => !w.win.includes(c)) : w.cells;
    for (const run of runs(cells)) {
      let c0 = run[0];
      for (const len of split(run.length, k + (w.side === 'left' || w.side === 'back' ? 1 : 0))) {
        const at = w.along === 'x' ? [c0, L, w.fixed] : [w.fixed, L, c0];
        add(BR[len], color, at, w.along === 'x' ? 0 : 90, step, 'walls', { evidence: EV[w.side] });
        c0 += len;
      }
    }
    if (win && w.win) {
      const c0 = w.win[0], at = w.along === 'x' ? [c0, L, w.fixed] : [w.fixed, L, c0];
      add('3065', 47, at, w.along === 'x' ? 0 : 90, step, 'walls', { evidence: [...EV[w.side], 'detail_window'] });
    }
  }
  if (k === 0) frame = add('60596', 15, [2, 1, 5], 0, 4, 'walls', { evidence: EV.front });
}
const door = add('60623', 70, [2, 1, 5], 0, 5, 'door', { mount: frame, evidence: ['ext_a000_e00', 'mech_door_open_a000_e20', 'detail_door_handle'] });
// 11–14 屋顶：单独拼成子组件，第 15 步整体装上（也可以整体取下）
const roof = [];
const R = (...a) => { const id = add(...a); roof.push(id); return id; };
R('3036', 72, [0, 19, 0], 0, 11, 'roof', { evidence: ['mech_roof_module_bottom'] });
for (const x of [0, 4]) {
  R('3037', 4, [x, 20, 4], 0, 12, 'roof', { evidence: ['ext_a000_e30', 'ext_top_e90'] });
  R('3037', 4, [x, 20, 0], 180, 12, 'roof', { evidence: ['ext_a180_e30', 'ext_top_e90'] });
  R('3001', 4, [x, 20, 2], 0, 12, 'roof', { status: 'inferred', confidence: 0.7, evidence: ['ext_a090_e00', 'ext_a270_e00'], note: '两侧山墙只看到端面，长度按 2×4 推断' });
}
for (const x of [0, 4]) {
  R('3037', 4, [x, 23, 3], 0, 13, 'roof', { evidence: ['ext_a000_e30'] });
  R('3037', 4, [x, 23, 1], 180, 13, 'roof', { evidence: ['ext_a180_e30'] });
}
for (const x of [0, 4]) R('3041', 320, [x, 26, 2], 0, 14, 'roof', { evidence: ['ext_a000_e30', 'ext_top_e90'] });

const model = {
  format: 'brickbuild', version: '0.2',
  meta: { name: '林间小屋（示例）', author: 'brickkit', createdAt: '2026-10-24', front: '+z',
    description: '演示用模型：门可以打开，屋顶可以整体取下。', photoSet: 'cottage.photos.json' },
  steps: [
    { n: 1, title: '底板' }, { n: 2, title: '前院小路和花草' }, { n: 3, title: '室内桌椅' },
    { n: 4, title: '第 1 层墙和门框' }, { n: 5, title: '装上门' }, { n: 6, title: '第 2 层墙' },
    { n: 7, title: '第 3 层墙（开窗）' }, { n: 8, title: '第 4 层墙（开窗）' }, { n: 9, title: '第 5 层墙' },
    { n: 10, title: '第 6 层墙' }, { n: 11, title: '屋顶底板' }, { n: 12, title: '屋顶第 1 层斜面' },
    { n: 13, title: '屋顶第 2 层斜面' }, { n: 14, title: '屋脊' },
    { n: 15, title: '装上屋顶', attach: 'roof' },
  ],
  // 模块：爆炸图“按模块”时每个模块的位移 explode=[x 格, 层(片), z 格]，子模块的位移叠加在父模块上
  modules: [
    { id: 'base', label: '底板', explode: [0, 0, 0] },
    { id: 'yard', label: '前院', explode: [0, 3, 6] },
    { id: 'interior', label: '室内家具', explode: [0, 6, 0] },
    { id: 'walls', label: '墙体', explode: [0, 16, 0] },
    { id: 'door', label: '前门', parent: 'walls', explode: [0, 0, 6] },
    { id: 'roof', label: '屋顶', subassembly: true, explode: [0, 34, 0], note: '单独拼好后整体放到墙上' },
  ],
  parts,
  mechanisms: [
    { id: 'door', label: '前门', type: 'hinge', parts: [door], pivot: [2.4, 1, 5.25], axis: [0, 1, 0], range: [0, 95], default: 0,
      evidence: ['mech_door_open_a000_e20', 'mech_door_open_a045_e30', 'mech_door_half_a000_e20'] },
    { id: 'roof', label: '屋顶', type: 'removable', parts: roof, offset: [0, 16, 0], default: 0,
      evidence: ['mech_roof_open_a030_e35', 'mech_roof_module_top', 'mech_roof_module_bottom'] },
  ],
};
fs.writeFileSync(new URL('./cottage.brick.json', import.meta.url), JSON.stringify(model, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g, '[$1, $2, $3]'));
console.log(parts.length, 'parts');
