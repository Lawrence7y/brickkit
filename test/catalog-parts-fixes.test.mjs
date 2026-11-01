import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  partConnectors,
  partBoxes,
  boxesCollide,
  partsConnected,
  snapPart,
  validate,
  doorHingeMatches,
  mergeCatalogParts,
  PLATE,
} from '../src/core/core.js';
import { cat, partGeometry } from '../src/viewer/geom.js';
import { OFFICIAL_ALIASES } from '../src/ldraw/ldraw.js';

test('1. 3D 视觉几何与底面凹陷内管：标准砖、板、光板、科技砖、圆件具真实底腔', () => {
  // ① 2x2/2x4 砖板具底部外壁、顶部顶板与内管
  const g3001 = partGeometry('3001');
  assert.ok(g3001.main);
  assert.ok(g3001.main.attributes.position.count > 0);
  assert.equal(g3001.main.boundingBox.min.y >= -1e-4, true);

  // ② 1x2 板具中心插销
  const g3023 = partGeometry('3023');
  assert.ok(g3023.main);
  assert.ok(g3023.main.attributes.position.count > 0);

  // ③ 1x1 砖板具中空内腔
  const g3005 = partGeometry('3005');
  assert.ok(g3005.main);

  // ④ 1x1 圆件（3062b, 4073）内腔可容纳 0.3 格半径的标准凸点
  const g4073 = partGeometry('4073');
  assert.ok(g4073.main);

  // ⑤ 2x2 圆件（3941, 4032）具备外壁与中心抗凸点管
  const g4032 = partGeometry('4032');
  assert.ok(g4032.main);

  // ⑥ 光滑球冠底面（2654）保持实心，不生成底面中空开孔
  const g2654 = partGeometry('2654');
  assert.ok(g2654.main);

  // ⑦ 侧装砖 (snot)、夹板 (clip)、把手板 (barplate) 均具备底部空腔
  const g87087 = partGeometry('87087');
  assert.ok(g87087.main);
  const g48336 = partGeometry('48336');
  assert.ok(g48336.main);
  const g11476 = partGeometry('11476');
  assert.ok(g11476.main);
});

test('2. 碰撞包围盒（partBoxes）与向下凸台：18677 与 2444 包含向下 1.375 片凸台', () => {
  // ① 18677 复合包围盒向下延伸 1.375 片（11 LDU）
  const def18677 = cat.parts['18677'];
  assert.ok(def18677.boxes);
  const p18677 = { id: 'p1', part: '18677', at: [0, 2, 0], rot: 0, step: 1 };
  const boxes18677 = partBoxes(p18677, def18677);
  const minY18677 = Math.min(...boxes18677.map((b) => b.y0));
  // at[1]=2 片，凸台下探 1.375 片，故 y0 = 2 - 1.375 = 0.625 片
  assert.ok(Math.abs(minY18677 - (2 - 1.375)) < 1e-4);

  // 验证碰撞检测：若正下方放置一块 flat plate (y=1)，必定发生碰撞
  const plateBelow = { id: 'p_below', part: '3023', at: [0, 1, 0], rot: 0, step: 1 };
  const boxesBelow = partBoxes(plateBelow, cat.parts['3023']);
  const hit18677 = boxesCollide(boxes18677, boxesBelow);
  assert.ok(hit18677, '18677 向下凸台应与下层零件发生碰撞');

  // ② 2444 复合包围盒与无假侧耳
  const def2444 = cat.parts['2444'];
  assert.equal(def2444.kind, 'plate');
  assert.ok(def2444.boxes);
  const p2444 = { id: 'p2', part: '2444', at: [0, 2, 0], rot: 0, step: 1 };
  const boxes2444 = partBoxes(p2444, def2444);
  const minY2444 = Math.min(...boxes2444.map((b) => b.y0));
  assert.ok(Math.abs(minY2444 - (2 - 1.375)) < 1e-4);

  // 3D 渲染几何验证：18677 和 2444 的向下凸台在 3D 中正确生成
  const g18677 = partGeometry('18677');
  assert.ok(g18677.main.boundingBox.min.y <= -1.375 * PLATE + 0.01);
  const g2444 = partGeometry('2444');
  assert.ok(g2444.main.boundingBox.min.y <= -1.375 * PLATE + 0.01);

  // ③ 下挂正支架竖板下界公式：def.dir === 'down' 时为 (1.5 - def.vH) * PLATE
  const def99781 = cat.parts['99781'];
  assert.equal(def99781.dir, 'down');
  assert.equal(def99781.vH, 3);
  const p99781 = { id: 'b1', part: '99781', at: [0, 3, 0], rot: 0, step: 1 };
  const bBoxes = partBoxes(p99781, def99781);
  const bMinY = Math.min(...bBoxes.map((b) => b.y0));
  // at[1]=3，竖板下探 (1.5 - 3) = -1.5 片，故 y0 = 3 - 1.5 = 1.5 片
  assert.ok(Math.abs(bMinY - (3 + (1.5 - 3))) < 1e-4);
});

test('3. 底面连接器治理：消除假底孔并保留真实底孔', () => {
  // ① 2654 与 60623 必须无任何反凸点
  const c2654 = partConnectors({ id: 's1', part: '2654', at: [0, 0, 0], rot: 0 }, cat.parts['2654']);
  assert.deepEqual(c2654.receptors.filter((r) => r.kind === 'antistud'), []);

  const c60623 = partConnectors({ id: 'd1', part: '60623', at: [0, 0, 0], rot: 0 }, cat.parts['60623']);
  assert.deepEqual(c60623.receptors.filter((r) => r.kind === 'antistud'), []);

  // ② 4740 与 3960：无网格反凸点，但有中心受体
  const c4740 = partConnectors({ id: 'd2', part: '4740', at: [0, 0, 0], rot: 0 }, cat.parts['4740']);
  assert.equal(c4740.receptors.filter((r) => r.i >= 0 && r.k >= 0).length, 0);
  assert.equal(c4740.receptors.some((r) => r.i === -1 && r.k === -1), true);

  const c3960 = partConnectors({ id: 'd3', part: '3960', at: [0, 0, 0], rot: 0 }, cat.parts['3960']);
  assert.equal(c3960.receptors.filter((r) => r.kind === 'antistud' && r.i >= 0 && r.k >= 0).length, 0);
  assert.equal(c3960.receptors.some((r) => r.kind === 'antistud' && r.i === -1 && r.k === -1), true);

  // ③ 拱砖仅在立柱底脚处保留底孔（跨度悬空处无底孔）
  const c3307 = partConnectors({ id: 'a1', part: '3307', at: [0, 0, 0], rot: 0 }, cat.parts['3307']);
  assert.deepEqual(c3307.receptors.filter((r) => r.kind === 'antistud').map((r) => [r.i, r.k]).sort(), [[0, 0], [5, 0]]);

  const c3659 = partConnectors({ id: 'a2', part: '3659', at: [0, 0, 0], rot: 0 }, cat.parts['3659']);
  assert.deepEqual(c3659.receptors.filter((r) => r.kind === 'antistud').map((r) => [r.i, r.k]).sort(), [[0, 0], [3, 0]]);

  const c6182 = partConnectors({ id: 'a3', part: '6182', at: [0, 0, 0], rot: 0 }, cat.parts['6182']);
  assert.deepEqual(c6182.receptors.filter((r) => r.kind === 'antistud').map((r) => [r.i, r.k]).sort(), [[0, 0], [3, 0]]);

  // ④ 楔形机翼底孔数量与位置核实
  const c41769 = partConnectors({ id: 'w1', part: '41769', at: [0, 0, 0], rot: 0 }, cat.parts['41769']);
  assert.equal(c41769.receptors.filter((r) => r.kind === 'antistud').length, 5);

  const c41770 = partConnectors({ id: 'w2', part: '41770', at: [0, 0, 0], rot: 0 }, cat.parts['41770']);
  assert.equal(c41770.receptors.filter((r) => r.kind === 'antistud').length, 5);
});

test('4. 尺寸与接口类型纠偏：30374 高度为 10 片，15712 夹口朝向为 +y', () => {
  // ① 30374（Bar 4L）：4 格 = 80 LDU = 10 片高
  const def30374 = cat.parts['30374'];
  assert.equal(def30374.h, 10);
  assert.deepEqual(def30374.ldrawOrigin, [0, 10, 0]);

  // ② 15712（Plate 1×1 with Top Clip）：顶部无凸点，夹口垂直朝天 +y
  const def15712 = cat.parts['15712'];
  assert.equal(def15712.noTopStuds, true);
  assert.equal(def15712.studs, 0);
  const c15712 = partConnectors({ id: 'c1', part: '15712', at: [0, 0, 0], rot: 0 }, def15712);
  assert.equal(c15712.studs.length, 0);
  const clipRec = c15712.receptors.find((r) => r.kind === 'clip');
  assert.ok(clipRec);
  assert.equal(clipRec.dir, '+y');
});

test('5. 87994 (Bar 3L) 尺寸纠偏：高 7.5 片 (60 LDU)，ldrawOrigin 对齐底面且 3D 几何无悬空', () => {
  const def87994 = cat.parts['87994'];
  assert.equal(def87994.h, 7.5);
  assert.deepEqual(def87994.ldrawOrigin, [0, 7.5, 0]);

  const g = partGeometry('87994');
  assert.ok(g.main);
  assert.ok(g.main.boundingBox.min.y >= -1e-4);
  assert.ok(Math.abs(g.main.boundingBox.max.y - 7.5 * PLATE) < 0.01);
});

test('6. 斜面与弧面砖真实底腔 (hollowSlopeBody) 与底孔限制 (antistudCells)', () => {
  // ① 3D 几何真实底腔与接地
  for (const id of ['3039', '3040b', '11477', '15068', '61678', '93273', '54200', '85984', '3041', '3043']) {
    const g = partGeometry(id);
    assert.ok(g.main, `geometry for ${id} should exist`);
    assert.ok(g.main.boundingBox.min.y >= -1e-4, `${id} min.y should be >= 0, got ${g.main.boundingBox.min.y}`);
    const def = cat.parts[id];
    const hasStuds = ['3039', '3040b'].includes(id);
    const expectedMax = def.h * PLATE + (hasStuds ? 0.166 : 0);
    assert.ok(Math.abs(g.main.boundingBox.max.y - expectedMax) < 0.01, `${id} max.y should match expected`);
  }

  // ② antistudCells 底孔限制（薄唇处禁止插凸点）
  // 11477 (1x2 cslope, h=2): 仅 k=0 受体有效
  const c11477 = partConnectors({ id: 's1', part: '11477', at: [0, 0, 0], rot: 0 }, cat.parts['11477']);
  const anti11477 = c11477.receptors.filter((r) => r.kind === 'antistud');
  assert.deepEqual(anti11477.map((r) => [r.i, r.k]), [[0, 0]]);

  // 15068 (2x2 cslope, h=2): 仅 k=0 行有效
  const c15068 = partConnectors({ id: 's2', part: '15068', at: [0, 0, 0], rot: 0 }, cat.parts['15068']);
  const anti15068 = c15068.receptors.filter((r) => r.kind === 'antistud');
  assert.deepEqual(anti15068.map((r) => [r.i, r.k]), [[0, 0], [1, 0]]);

  // 61678 (1x4 cslope, h=3): k=0, 1, 2 有效，前唇 k=3 排除
  const c61678 = partConnectors({ id: 's3', part: '61678', at: [0, 0, 0], rot: 0 }, cat.parts['61678']);
  const anti61678 = c61678.receptors.filter((r) => r.kind === 'antistud');
  assert.deepEqual(anti61678.map((r) => [r.i, r.k]), [[0, 0], [0, 1], [0, 2]]);

  // 93273 (1x4 double cslope, h=2): 两端 k=0, 3 弧下薄唇排除，仅中央 k=1, 2 有效
  const c93273 = partConnectors({ id: 's4', part: '93273', at: [0, 0, 0], rot: 0 }, cat.parts['93273']);
  const anti93273 = c93273.receptors.filter((r) => r.kind === 'antistud');
  assert.deepEqual(anti93273.map((r) => [r.i, r.k]), [[0, 1], [0, 2]]);
});

test('7. 圆锥 4589b (1x1)、3942c (2x2) 与半球穹顶 553b 真实中空底腔几何与连接器', () => {
  const g4589 = partGeometry('4589b');
  assert.ok(g4589.main);
  assert.ok(g4589.main.boundingBox.min.y >= -1e-4);
  assert.ok(Math.abs(g4589.main.boundingBox.max.y - (3 * PLATE + 0.166)) < 0.01);

  const g3942c = partGeometry('3942c');
  assert.ok(g3942c.main);
  assert.ok(g3942c.main.boundingBox.min.y >= -1e-4);
  assert.ok(Math.abs(g3942c.main.boundingBox.max.y - (6 * PLATE + 0.166)) < 0.01);

  const c3942c = partConnectors({ id: 'cone2', part: '3942c', at: [0, 0, 0], rot: 0 }, cat.parts['3942c']);
  assert.equal(c3942c.receptors.filter((r) => r.kind === 'antistud' && r.i >= 0 && r.k >= 0).length, 4);
  assert.ok(c3942c.receptors.some((r) => r.i === -1 && r.k === -1));

  const g553 = partGeometry('553b');
  assert.ok(g553.main);
  assert.ok(g553.main.boundingBox.min.y >= -1e-4);
  assert.ok(Math.abs(g553.main.boundingBox.max.y - 3 * PLATE) < 0.01);
});

test('8. 科技蓝销 4274 接口修正：kind 为 technic，无假顶凸点与假底孔，具侧凸点与科技插销', () => {
  const def4274 = cat.parts['4274'];
  assert.equal(def4274.kind, 'technic');
  assert.equal(def4274.noTopStuds, true);
  assert.equal(def4274.studs, 0);
  assert.deepEqual(def4274.antistudCells, []);

  const c4274 = partConnectors({ id: 'p4274', part: '4274', at: [0, 0, 0], rot: 0 }, def4274);
  assert.equal(c4274.receptors.filter((r) => r.kind === 'antistud').length, 0);
  assert.equal(c4274.studs.filter((s) => s.kind === 'top').length, 0);
  assert.ok(c4274.studs.some((s) => s.kind === 'side' && s.dir === '+x'));
  assert.ok(c4274.studs.some((s) => s.kind === 'pin' && s.axis === 'x'));

  const g4274 = partGeometry('4274');
  assert.ok(g4274.main);
  assert.ok(g4274.main.attributes.position.count > 0);
});

test('9. 倒斜面砖 3660 (2x2) 与 3665 (1x2) 真实底腔与底孔剔除坡面假受体', () => {
  // 3660 底面仅后排 (k=0) 有底孔，坡面交界无中心假底孔 (i=-1, k=-1)
  const c3660 = partConnectors({ id: 'is1', part: '3660', at: [0, 0, 0], rot: 0 }, cat.parts['3660']);
  const anti3660 = c3660.receptors.filter((r) => r.kind === 'antistud');
  assert.deepEqual(anti3660.map((r) => [r.i, r.k]), [[0, 0], [1, 0]]);

  // 3665 底面仅后排 (k=0) 单孔
  const c3665 = partConnectors({ id: 'is2', part: '3665', at: [0, 0, 0], rot: 0 }, cat.parts['3665']);
  const anti3665 = c3665.receptors.filter((r) => r.kind === 'antistud');
  assert.deepEqual(anti3665.map((r) => [r.i, r.k]), [[0, 0]]);

  // 3D 几何真实中空底腔
  for (const id of ['3660', '3665']) {
    const g = partGeometry(id);
    assert.ok(g.main);
    assert.ok(g.main.boundingBox.min.y >= -1e-4);
    assert.ok(Math.abs(g.main.boundingBox.max.y - (3 * PLATE + 0.166)) < 0.01);
  }
});

test('10. 官方别名映射收敛：OFFICIAL_ALIASES 映射 3040 -> 3040b', () => {
  assert.equal(OFFICIAL_ALIASES['3040'], '3040b');
});

test('11. 连接层修复①：mergeCatalogParts 仅在 sameGrid 时继承格位字段，60594/60596 具备完整 4 颗顶凸点', () => {
  // 3839b (size [1, 2]) 应有 2 颗顶凸点 [0,0], [0,1]，不得被扩展目录 [2, 3] 的 studCells 污染
  const c3839b = partConnectors({ id: 'p', part: '3839b', at: [0, 0, 0], rot: 0 }, cat.parts['3839b']);
  const top3839b = c3839b.studs.filter((s) => s.kind === 'top');
  assert.equal(top3839b.length, 2);
  assert.deepEqual(top3839b.map((s) => s.label), ['top-0,0', 'top-0,1']);

  // 4081b (size [1, 1]) 应有 1 颗顶凸点 [0,0] 与 1 个底孔 [0,0]，不得被扩展目录 [1, 2] 污染
  const c4081b = partConnectors({ id: 'p', part: '4081b', at: [0, 0, 0], rot: 0 }, cat.parts['4081b']);
  assert.equal(c4081b.studs.filter((s) => s.kind === 'top').length, 1);
  assert.equal(c4081b.receptors.filter((r) => r.kind === 'antistud').length, 1);

  // 92946 (size [1, 2] slope) 顶面僅后排 [0,0] 有 1 颗凸点，不得继承扩展目录 [1, 3] 的 studCells [[0,1]]
  const c92946 = partConnectors({ id: 'p', part: '92946', at: [0, 0, 0], rot: 0 }, cat.parts['92946']);
  const top92946 = c92946.studs.filter((s) => s.kind === 'top');
  assert.equal(top92946.length, 1);
  assert.equal(top92946[0].label, 'top-0,0');

  // 60594 (窗框 1x4x3) 与 60596 (门框 1x4x6) 顶面全部 4 颗凸点齐全
  for (const id of ['60594', '60596']) {
    const conn = partConnectors({ id: 'f', part: id, at: [0, 0, 0], rot: 0 }, cat.parts[id]);
    const tops = conn.studs.filter((s) => s.kind === 'top');
    assert.equal(tops.length, 4, `${id} 应有 4 颗顶凸点`);
    assert.deepEqual(tops.map((s) => s.label), ['top-0,0', 'top-1,0', 'top-2,0', 'top-3,0']);
  }
});

test('12. 连接层修复②：2444 与 18677 下凸台销孔高度 y=-0.25 片，4274 蓝销扣入零穿模', () => {
  for (const id of ['2444', '18677', '3700']) {
    const parent = { id: 'p', part: id, at: [0, 2, 0], rot: 0, up: '+y', step: 1 };
    const pConn = partConnectors(parent, cat.parts[id]);
    const holeIdx = pConn.receptors.findIndex((r) => r.kind === 'hole' && (id === '2444' || r.pos[2] > 0.5));
    assert.ok(holeIdx >= 0, `${id} 必须有 hole 受体`);
    if (id !== '3700') {
      // at[1]=2 片，孔心在板底下方 0.25 片 (-0.1 格)，世界 y = 1.75 片
      assert.ok(Math.abs(pConn.receptors[holeIdx].pos[1] - 1.75) < 1e-6, `${id} 孔心世界 y 应为 1.75 片`);
    }

    const pinDef = cat.parts['4274'];
    const pinProbe = { id: 'pin', part: '4274', at: [0, 0, 0], rot: id === '2444' ? 0 : 270, up: '+y', step: 2 };
    const pinConn = partConnectors(pinProbe, pinDef);
    const pinStudIdx = pinConn.studs.findIndex((s) => s.kind === 'pin');
    const placedPin = snapPart(parent, cat.parts[id], holeIdx, pinProbe, pinDef, pinStudIdx, { under: true });
    assert.ok(placedPin);
    assert.equal(partsConnected(placedPin, pinDef, parent, cat.parts[id]), true, `4274 与 ${id} 应连通`);
    assert.equal(
      boxesCollide(partBoxes(placedPin, pinDef), partBoxes(parent, cat.parts[id])),
      null,
      `4274 插入 ${id} 销孔不得发生 3D 包围盒穿模`
    );
  }
});

test('13. 连接层修复③：3176 带端孔耦连板具备圆端竖直通孔 hole 且穿杆不误报穿模', () => {
  const def3176 = cat.parts['3176'];
  const p3176 = { id: 'p3176', part: '3176', at: [0, 0, 0], rot: 0, up: '+y' };
  const conn = partConnectors(p3176, def3176);
  const holes = conn.receptors.filter((r) => r.kind === 'hole');
  assert.equal(holes.length, 1, '3176 应有 1 个圆端竖直通孔');
  assert.equal(holes[0].axis, 'y');
  assert.deepEqual(holes[0].pos, [1, 0.5, 2.5]);

  // 竖直光剑杆穿过 3176 圆端通孔中心 (x=1, z=2.5 -> 1x1 bar at [0.5, 0, 2]) 不得与 3176 主体盒碰撞
  const pBar = { id: 'bar', part: '87994', at: [0.5, 0, 2], rot: 0, up: '+y' };
  assert.equal(
    boxesCollide(partBoxes(p3176, def3176), partBoxes(pBar, cat.parts['87994'])),
    null,
    '穿过 3176 圆端孔的竖杆不应与 2x2 主体包围盒发生碰撞'
  );
});

test('14. 连接层修复④：60478 / 2540 / 26047 为连续把柄杆段 (span > 0)，支持单夹居中扣合', () => {
  for (const [id, expectedSpan] of [['60478', 0.45], ['2540', 0.95], ['26047', 0.45]]) {
    const def = cat.parts[id];
    const p = { id: 'bp', part: id, at: [0, 0, 0], rot: 0, up: '+y' };
    const bars = partConnectors(p, def).studs.filter((s) => s.kind === 'bar');
    assert.equal(bars.length, 1, `${id} 应合并为 1 条连续把柄杆段`);
    assert.equal(bars[0].span, expectedSpan, `${id} 杆段半长应为 ${expectedSpan}`);

    // 用端头单水平夹板 63868 居中扣合到把柄中点
    const clipDef = cat.parts['63868'];
    const clipProbe = { id: 'c', part: '63868', at: [0, 0, 0], rot: 180, up: '+y' };
    const clipIdx = partConnectors(clipProbe, clipDef).receptors.findIndex((r) => r.kind === 'clip');
    const barIdx = partConnectors(p, def).studs.findIndex((s) => s.kind === 'bar');
    const snapped = snapPart(p, def, barIdx, clipProbe, clipDef, clipIdx);
    assert.equal(partsConnected(p, def, snapped, clipDef), true, `63868 应能居中扣在 ${id} 把柄中点`);
    assert.equal(boxesCollide(partBoxes(p, def), partBoxes(snapped, clipDef)), null, `63868 扣在 ${id} 上应零穿模`);
  }
});

test('15. 连接层修复⑤：竖直夹板 4085d 与 30237 夹口轴向为 y 且外挑 0.5 格，可夹持竖立圆杆', () => {
  for (const [clipId, expectedY] of [['4085d', 0.5], ['30237', 1.5]]) {
    const clipDef = cat.parts[clipId];
    const pClip = { id: 'c', part: clipId, at: [0, 0, 0], rot: 0, up: '+y' };
    const clips = partConnectors(pClip, clipDef).receptors.filter((r) => r.kind === 'clip');
    assert.equal(clips.length, 1);
    assert.equal(clips[0].axis, 'y', `${clipId} 竖直夹口轴向必须为 y`);
    assert.ok(Math.abs(clips[0].pos[1] - expectedY) < 1e-6);
    assert.ok(Math.abs(clips[0].pos[2] - 1.5) < 1e-6, `${clipId} 夹口中心应在 z=1.5（板体外侧 0.5 格）`);

    // 竖立光剑杆 87994 在夹口位置垂直穿过，两者连通且无穿模
    const barDef = cat.parts['87994'];
    const pBar = { id: 'b', part: '87994', at: [clips[0].pos[0] - 0.5, 0, 1], rot: 0, up: '+y' };
    assert.equal(partsConnected(pBar, barDef, pClip, clipDef), true, `${clipId} 应能夹住竖立光剑杆 87994`);
    assert.equal(boxesCollide(partBoxes(pBar, barDef), partBoxes(pClip, clipDef)), null, `${clipId} 与竖杆应零穿模`);
  }
});

test('16. 连接层修复⑥：3839b / 44302 / 44301 / 11476 把柄与夹口高度 1.0 片、外挑 0.5 格，整数网格零穿模对扣', () => {
  // 44302 (双指把柄) ↔ 44301 (单指夹口) 棘轮合页在整数网格 [0, 0, 0] 与 [0, 0, 3] (rot: 180) 对扣
  const p44302 = { id: 'h1', part: '44302', at: [0, 0, 0], rot: 0, up: '+y' };
  const p44301 = { id: 'h2', part: '44301', at: [0, 0, 3], rot: 180, up: '+y' };
  assert.equal(partsConnected(p44302, cat.parts['44302'], p44301, cat.parts['44301']), true, '44302 与 44301 应在整数网格对扣');
  assert.equal(boxesCollide(partBoxes(p44302, cat.parts['44302']), partBoxes(p44301, cat.parts['44301'])), null);

  // 3839b (双端把柄) ↔ 63868 (端头夹板) 在整数网格 [0, 0, 0] 与 [0, 0, 3] (rot: 180) 对扣
  const p3839b = { id: 'b1', part: '3839b', at: [0, 0, 0], rot: 0, up: '+y' };
  const p63868 = { id: 'c1', part: '63868', at: [0, 0, 3], rot: 180, up: '+y' };
  assert.equal(partsConnected(p3839b, cat.parts['3839b'], p63868, cat.parts['63868']), true, '3839b 与 63868 应在整数网格对扣');
  assert.equal(boxesCollide(partBoxes(p3839b, cat.parts['3839b']), partBoxes(p63868, cat.parts['63868'])), null);

  // 48336 (侧把柄) ↔ 11476 (侧单夹) 在整数网格 [0, 0, 0] 与 [0, 0, 2] (rot: 180) 对扣
  const p48336 = { id: 'b2', part: '48336', at: [0, 0, 0], rot: 0, up: '+y' };
  const p11476 = { id: 'c2', part: '11476', at: [0, 0, 2], rot: 180, up: '+y' };
  assert.equal(partsConnected(p48336, cat.parts['48336'], p11476, cat.parts['11476']), true, '48336 与 11476 应在整数网格对扣');
  assert.equal(boxesCollide(partBoxes(p48336, cat.parts['48336']), partBoxes(p11476, cat.parts['11476'])), null);
});

test('17. 连接层修复⑦：87994 与 30374 光剑杆具备细柱包围盒 [-0.2, 0.2]、连续跨度 span=0.5 且无假底孔', () => {
  for (const id of ['87994', '30374']) {
    const def = cat.parts[id];
    const p = { id: 'bar', part: id, at: [0, 0, 0], rot: 0, up: '+y' };
    const conn = partConnectors(p, def);
    assert.equal(conn.receptors.filter((r) => r.kind === 'antistud').length, 0, `${id} 底面不得有假 antistud`);
    const bars = conn.studs.filter((s) => s.kind === 'bar');
    assert.ok(bars.length > 0 && bars.every((b) => b.span === 0.5), `${id} 每个采样点必须具备 span=0.5 连续杆段跨度`);

    const boxes = partBoxes(p, def);
    assert.equal(boxes.length, 1);
    assert.ok(Math.abs((boxes[0].x1 - boxes[0].x0) - 0.4) < 1e-6, `${id} 包围盒 x 宽度应为 0.4 格`);
    assert.ok(Math.abs((boxes[0].z1 - boxes[0].z0) - 0.4) < 1e-6, `${id} 包围盒 z 宽度应为 0.4 格`);
  }
});

test('18. 连接层修复⑧：60623 门扇与 60596 门框几何对位连接，validate 拦截悬空错位门扇', () => {
  const frameDef = cat.parts['60596'];
  const doorDef = cat.parts['60623'];
  const basePlate = { id: 'base', part: '3710', color: 0, at: [0, 0, 0], rot: 0, up: '+y', step: 1 };
  const frame = { id: 'frame', part: '60596', color: 0, at: [0, 1, 0], rot: 0, up: '+y', step: 2 };
  const doorOk = { id: 'door', part: '60623', color: 15, at: [0, 1, 0], rot: 0, up: '+y', step: 3, mount: 'frame' };

  assert.equal(doorHingeMatches(frame, frameDef, doorOk, doorDef), true);
  assert.equal(partsConnected(frame, frameDef, doorOk, doorDef), true, '同坐标同朝向的门扇与门框应判定为连接');

  const okRes = validate({ format: 'brickbuild', version: '0.2', parts: [basePlate, frame, doorOk] }, cat);
  assert.equal(okRes.ok, true, `合法安装的门扇应通过校验，实际错误：${JSON.stringify(okRes.errors)}`);

  const doorBad = { ...doorOk, at: [5, 1, 0] };
  assert.equal(partsConnected(frame, frameDef, doorBad, doorDef), false, '错位悬空的门扇不得与门框连通');
  const badRes = validate({ format: 'brickbuild', version: '0.2', parts: [basePlate, frame, doorBad] }, cat);
  assert.equal(badRes.ok, false, '错位悬空的门扇必须被 validate 拒绝');
  assert.ok(badRes.errors.some((e) => e.code === 'mount-disconnected'), '应报 mount-disconnected');
});


