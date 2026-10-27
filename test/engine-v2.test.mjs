// 引擎 v2 结构性修复回归（2026-10）：
//   ① 多高度凸点：studCells 第三位 ly（内腔/分层凸点），扣合坐标 = 零件底 + ly，旧条目无 ly 走顶面原路径；
//   ② 分解包围盒：凹形件（底盘座舱槽 / 双阶斜坡 / 轮拱）多盒定义，内饰件能放进舱内且不穿模；
//   ③ 子组件刚体挂装：builder.addAssembly + validate 的锚点支撑语义 + toLDraw 子组件变换；
//   ④ 连接器：18892 轮销不再污染 size（= [4,2]），轮销↔轮毂↔轮胎（pin↔axle / tyre↔rim），
//      人仔四件（73200 腿胯 / 76382 躯干 / 3626b 头 / 11303 帽）互插；
//   ⑤ 翻面搭建：负层倒装合法、flip 声明后以最上层为施工基准面。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  partConnectors, partBoxes, partsConnected, boxesCollide, validate, snapPart,
  toLDraw, ldrawExt, ldrawLine, studLevels,
} from '../src/core/core.js';
import { createBuilder } from '../src/core/builder.js';

// 合并目录（精选优先，LDraw 自动提取兜底）——与 cli / viewer 同口径
const curated = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8'));
const ext = JSON.parse(fs.readFileSync('catalog/parts-ldraw.json', 'utf8'));
const cat = { parts: { ...ext.parts, ...curated.parts }, colors: JSON.parse(fs.readFileSync('catalog/colors.json', 'utf8')).colors };
const P = (id, at = [0, 0, 0], extra = {}) => ({ id: `t-${id}-${at.join('_')}`, part: id, color: 4, at, step: 1, ...extra });
const model = (parts, extra = {}) => ({ format: 'brickbuild', version: '0.2', meta: { name: 't' }, ...extra, parts });
const codes = (list) => list.map((e) => e.code);

// ---------------------------------------------------------------- ① 多高度凸点
test('多高度凸点：28324 座舱槽凸点带真实 ly（顶面 3 片 / 侧壁 1.5 片 / 槽底 0.5 片）', () => {
  const d = ext.parts['28324'];
  assert.ok(Array.isArray(d.studCells), '28324 必须有 studCells');
  const lys = new Set(d.studCells.filter((c) => c.length === 3).map((c) => c[2]));
  assert.deepEqual([...lys].sort((a, b) => a - b), [0.5, 1.5], '座舱槽内必须有 0.5/1.5 片两种内腔凸点高度');
  // 引擎侧：studLevels 把第三位读成 ly；无第三位的仍是顶面 h
  const levels = studLevels(d);
  assert.equal(levels.get('0,2').length, 1, '顶面格 ly 只有一个高度');
  assert.equal(levels.get('4,2')[0], 0.5, '槽底格 ly = 0.5 片');
  const conn = partConnectors(P('28324'), d);
  const tops = conn.studs.filter((s) => s.kind === 'top');
  assert.equal(tops.length, d.studCells.length, '每个 studCells 条目都要输出一个顶凸点');
  const lySet = new Set(tops.map((s) => s.ly));
  assert.deepEqual([...lySet].sort((a, b) => a - b), [0.5, 1.5, 3], '凸点世界高度 = 零件底 + ly');
});

test('多高度凸点：凸点世界 y = at[1] + ly（不是一律 at[1] + h）', () => {
  const d = ext.parts['28324'];
  const part = P('28324', [0, 10, 0]);
  const conn = partConnectors(part, d);
  const top = conn.studs.find((s) => s.ly === 3);
  const cav = conn.studs.find((s) => s.ly === 0.5);
  assert.equal(top.pos[1], 13, '顶面凸点 y = 10 + 3');
  assert.equal(cav.pos[1], 10.5, '槽底凸点 y = 10 + 0.5');
});

test('多高度凸点：旧条目（studCells 无第三位）走顶面原路径，凸点高度仍等于 h', () => {
  const legacy = { kind: 'brick', size: [2, 2], h: 3, studs: 4, studCells: [[0, 0], [1, 1]] };
  const conn = partConnectors(P('legacy'), legacy);
  for (const s of conn.studs) assert.equal(s.ly, 3, '无 ly 的 studCells 条目按顶面 h 处理');
  // 无 studCells 的满格件同样不受影响
  const conn3001 = partConnectors(P('3001'), cat.parts['3001']);
  assert.ok(conn3001.studs.every((s) => s.ly === 3));
});

test('多高度凸点：1×2 板扣进 28324 座舱槽凸点，坐标落在槽底且 validate 通过', () => {
  const b = createBuilder({ catalog: cat, meta: { name: 'cavity' } });
  const base = b.add('28324', 0, { at: [0, 0, 0], step: 1 });
  const conn = partConnectors(base, ext.parts['28324']);
  const idx = conn.studs.findIndex((s) => s.ly === 0.5);
  assert.ok(idx >= 0, '必须有 0.5 片高的槽底凸点');
  const plate = b.add('3023', 4, { on: base.id, stud: idx, step: 2 });
  assert.equal(plate.at[1], 0.5, 'snap 后 at[1] = 凸点 y - 板底孔 y = 0.5 片');
  const r = b.assert();
  assert.deepEqual(r.errors, []);
});

test('多高度凸点：孤立的小数层（未扣在非整数凸点上）仍报 at 错误', () => {
  const bad = model([
    { id: 'a', part: '3001', color: 4, at: [0, 0, 0], step: 1 },
    { id: 'b', part: '3023', color: 4, at: [0, 0.5, 0], step: 2 },   // 自己浮在半层，没扣任何内腔凸点
  ]);
  const r = validate(bad, cat);
  assert.ok(codes(r.errors).includes('at'), '小数层必须由非整数高度凸点支撑，否则仍是 at 错误');
});

// ---------------------------------------------------------------- ② 分解包围盒
test('分解包围盒：28324 / 22889 输出多盒，且盒只覆盖真实材料（座舱槽留空）', () => {
  // 50745 轮拱例外：双向射线在弯曲壳体上整格采空，分解盒只覆盖 3% 的网格顶点，
  // 其余材料会在碰撞判定里消失（比封住内腔危险得多）。生成器因此按覆盖率下限
  // （BOX_COVERAGE_MIN=0.7）把它退回单实心盒——见下方第二条断言。
  for (const id of ['28324', '22889']) {
    const d = ext.parts[id];
    assert.ok(Array.isArray(d.boxes) && d.boxes.length >= 2, `${id}（${d.name}）应有 >=2 个分解盒，实际 ${d.boxes && d.boxes.length}`);
    assert.equal(d.boxesSource, 'ldraw-heightmap', `${id} 分解盒应有 .dat 实测来源标记`);
    for (const b of d.boxes) assert.equal(b.length, 6, `${id} 的盒必须是 [x0,x1,y0,y1,z0,z1]`);
  }
  // 28324 的开口中腔是 4×2 的中央下沉槽（世界坐标 x 4..8 / z 2..4，槽底 0.5 片）：
  // 该范围内不得有任何高于槽底的实体盒，且必须有 0..0.5 片的槽底板。
  const d = ext.parts['28324'];
  const boxes = partBoxes(P('28324'), d);
  const inCockpit = boxes.filter((b) => b.x1 > 4 + 1e-6 && b.x0 < 8 - 1e-6 && b.z1 > 2 + 1e-6 && b.z0 < 4 - 1e-6 && b.y1 > 0.6);
  assert.equal(inCockpit.length, 0, '座舱槽内部上方不得有实体盒（否则内饰放不进去）');
  assert.ok(boxes.some((b) => b.x0 <= 4 + 1e-6 && b.x1 >= 8 - 1e-6 && b.z0 <= 2 + 1e-6 && b.z1 >= 4 - 1e-6 && b.y1 <= 0.5 + 1e-6),
    '槽底必须有地板盒（0..0.5 片，覆盖整段中央下沉槽）');
});

test('分解包围盒：弯曲壳体覆盖不足时退回单实心盒（不漏保护真实材料）', () => {
  const d = ext.parts['50745'];
  assert.equal(d.boxes, undefined, '50745 轮拱的射线分解盒覆盖率过低，必须退回单实心盒');
  assert.match(String(d.needsManualBoxesReason || ''), /覆盖率/, '退回原因要写明是覆盖率不足（便于日后改进采样）');
  // 退回单盒后，碰撞体必须仍覆盖整件占地（x 4 格 × z 2 格 × h 片）
  const boxes = partBoxes(P('50745'), d);
  assert.equal(boxes.length, 1, '50745 退回单盒');
  const b = boxes[0];
  assert.ok(Math.abs((b.x1 - b.x0) - 4) < 1e-6 && Math.abs((b.z1 - b.z0) - 2) < 1e-6,
    `单盒水平占地应为 4×2 格，实际 ${b.x1 - b.x0}×${b.z1 - b.z0}`);
});

test('分解包围盒：内饰件能放进 28324 座舱且不穿模（3D 盒判定 + validate 零错误）', () => {
  const b = createBuilder({ catalog: cat, meta: { name: 'cockpit' } });
  const base = b.add('28324', 0, { at: [0, 0, 0], step: 1 });
  const conn = partConnectors(base, ext.parts['28324']);
  const idx = conn.studs.findIndex((s) => s.ly === 0.5);
  const plate = b.add('3023', 4, { on: base.id, stud: idx, step: 2 });
  // 板上再叠一层（验证舱内高度够放两片）
  const top = b.add('3023', 4, { on: plate.id, stud: 0, step: 3 });
  assert.equal(top.at[1], 1.5);
  const r = b.assert();
  assert.deepEqual(r.errors, []);
  // 旧单盒路径会把内饰判成穿模：确认分解盒确实放开了这块空间
  const whole = [{ x0: 0, x1: 12, y0: 0, y1: 3, z0: 0, z1: 6 }];
  assert.notEqual(boxesCollide(whole, partBoxes(plate, cat.parts['3023'])), null, '整块单盒确实会与内饰重叠（对照）');
  assert.equal(boxesCollide(partBoxes(base, ext.parts['28324']), partBoxes(plate, cat.parts['3023'])), null);
});

test('分解包围盒：实心砖板不分解（保持单盒，旧模型行为不变）', () => {
  for (const id of ['3001', '3020', '3039']) {
    const d = cat.parts[id];
    assert.ok(!Array.isArray(d.boxes) || !d.boxes.length, `${id}（${d.name}）不应被分解`);
    assert.equal(partBoxes(P(id), d).length <= 3, true);
  }
  // 3001 的盒子必须仍是 2×1×3 的实心块
  const boxes = partBoxes(P('3001', [0, 0, 0]), cat.parts['3001']);
  assert.equal(boxes.length, 1);
  assert.deepEqual([boxes[0].x0, boxes[0].x1, boxes[0].y0, boxes[0].y1, boxes[0].z0, boxes[0].z1], [0, 4, 0, 3, 0, 2]);
});

test('分解包围盒：boxes 条目格式错误时 partBoxes 抛中文错误（不静默归零）', () => {
  const bad = { kind: 'other', size: [2, 2], h: 3, studs: 4, boxes: [[0, 2, 0]] };
  assert.throws(() => partBoxes(P('bad'), bad), /boxes 条目格式错误/);
});

// ---------------------------------------------------------------- ③ 子组件刚体挂装
test('子组件刚体挂装：addAssembly 把一组零件当刚体扣到父件凸点上，组内相对关系不变', () => {
  const b = createBuilder({ catalog: cat, meta: { name: 'asm' } });
  const base = b.add('3001', 4, { at: [0, 0, 0], step: 1 });
  // 先在远处把两块板搭成刚体（上下叠放）
  const d1 = b.add('3020', 4, { at: [20, 20, 0], step: 2, id: 'g1' });
  const d2 = b.add('3020', 4, { at: [20, 21, 0], step: 2, id: 'g2' });
  const before = [d1.at.slice(), d2.at.slice()];
  const asm = b.addAssembly(['g1', 'g2'], { on: base.id, stud: 2, anchor: 'g1', anchorReceptor: 0, step: 3, label: '舱盖' });
  const after = b.parts().filter((p) => ['g1', 'g2'].includes(p.id));
  assert.equal(asm.anchor, 'g1');
  assert.equal(asm.step, 3);
  for (const p of after) {
    assert.equal(p.subassembly, asm.id, '组内零件都应带 subassembly 标记');
    assert.equal(p.subassemblyAnchor, 'g1', '组内零件都应指向同一锚点');
  }
  // 刚体：相对位移保持不变
  const rel = (arr) => [arr[0][0] - arr[1][0], arr[0][1] - arr[1][1], arr[0][2] - arr[1][2]];
  const now = after.map((p) => p.at);
  assert.deepEqual(rel(now), rel(before), '组内相对位置必须与挂装前一致（刚体）');
  assert.equal(after[0].at[1], 3, '锚点底孔扣到 base 顶面凸点 → at[1] = 3');
  const r = b.assert();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('子组件刚体挂装：validate 认可组内零件由锚点支撑（不再要求各自接地）', () => {
  const parts = [
    { id: 'base', part: '3001', color: 4, at: [0, 0, 0], step: 1 },
    { id: 'a1', part: '3020', color: 4, at: [0, 3, 0], step: 2, subassembly: 'asm1', subassemblyAnchor: 'a1' },
    // 组员悬在父件上方 2 层（自身没有接地，但通过锚点 a1 的凸点挂住 → 由 a1 的顶凸点扣合）
    { id: 'a2', part: '3020', color: 4, at: [0, 4, 0], step: 2, subassembly: 'asm1', subassemblyAnchor: 'a1' },
  ];
  const r = validate(model(parts), cat);
  assert.deepEqual(codes(r.errors), [], '组内零件由锚点支撑，不得报 floating');
  // 反例：锚点自己没接组外 → 整组悬空
  const orphan = validate(model([
    { id: 'base', part: '3001', color: 4, at: [0, 0, 0], step: 1 },
    { id: 'a1', part: '3020', color: 4, at: [20, 0, 0], step: 2, subassembly: 'asm1', subassemblyAnchor: 'a1' },
    { id: 'a2', part: '3020', color: 4, at: [20, 1, 0], step: 2, subassembly: 'asm1', subassemblyAnchor: 'a1' },
  ]), cat);
  assert.ok(codes(orphan.errors).includes('subassembly-anchor'), '整组没接到组外必须报 subassembly-anchor');
});

test('子组件刚体挂装：addAssembly 拒绝散件打包与非法锚点', () => {
  const b = createBuilder({ catalog: cat, meta: { name: 'asm-bad' } });
  const base = b.add('3001', 4, { at: [0, 0, 0], step: 1 });
  b.add('3020', 4, { at: [10, 10, 0], step: 2, id: 'x1' });
  b.add('3020', 4, { at: [30, 30, 0], step: 2, id: 'x2' });   // 与 x1 不相连
  assert.throws(() => b.addAssembly(['x1', 'x2'], { on: base.id, stud: 0, step: 3 }), /没有真实物理连接/);
  assert.throws(() => b.addAssembly(['x1'], { on: base.id, stud: 0, step: 3 }), /至少要有 2 个零件/);
  b.add('3020', 4, { at: [10, 11, 0], step: 2, id: 'x3' });
  assert.throws(() => b.addAssembly(['x1', 'x3'], { on: base.id, stud: 0, anchor: 'nope', step: 3 }), /anchor nope 必须是组内零件/);
});

test('子组件刚体挂装：toLDraw 导出 MPD，子组件子文件以锚点原点为局部坐标，挂装行带平移', () => {
  const b = createBuilder({ catalog: cat, meta: { name: 'asm-mpd' } });
  const base = b.add('3001', 4, { at: [0, 0, 0], step: 1 });
  b.add('3020', 4, { at: [20, 20, 0], step: 2, id: 'g1' });
  b.add('3020', 4, { at: [20, 21, 0], step: 2, id: 'g2' });
  const asm = b.addAssembly(['g1', 'g2'], { on: base.id, stud: 2, anchor: 'g1', anchorReceptor: 0, step: 3 });
  const m = b.model();
  assert.equal(ldrawExt(m), '.mpd', '有子组件时必须导出 MPD');
  const mpd = toLDraw(m, cat);
  assert.ok(mpd.includes(`0 FILE ${asm.id}.ldr`), '子组件应有独立子文件');
  // 子文件里的零件必须相对锚点：首件 = 原点，第二件保持原相对位置（上一层 = 8 LDU = 1 片）
  const anchorEntry = m.parts.find((p) => p.id === asm.anchor);
  const anchorLine = ldrawLine(anchorEntry, cat.parts[anchorEntry.part]);
  const off = anchorLine.split(/\s+/).slice(2, 5).map((v) => Math.round(Number(v) * 1000) / 1000);
  const sub = mpd.split(`0 FILE ${asm.id}.ldr`)[1];
  const subLines = sub.split('\n').filter((l) => /^1 \d/.test(l));
  assert.equal(subLines.length, 2);
  assert.match(subLines[0], /^1 4 0 0 0 /, '锚点件在子文件里必须位于原点');
  const [x2, y2, z2] = subLines[1].split(/\s+/).slice(2, 5).map(Number);
  assert.deepEqual([x2, y2, z2], [0, -8, 0], '组员相对锚点保持原相对位置');
  // 主文件挂装行：锚点 LDraw 位置平移 + 单位旋转
  assert.ok(mpd.includes(`1 16 ${off.map(String).join(' ')} 1 0 0 0 1 0 0 0 1 ${asm.id}.ldr`),
    `挂装行应为锚点平移，实际：\n${mpd.split('\n').filter((l) => l.includes('.ldr')).join('\n')}`);
});

// ---------------------------------------------------------------- ④ 18892 尺寸与轮/人仔连接器
test('18892 尺寸修复：轮销不再污染主体包围盒，size = [4, 2]（旧值 [5, 2]）', () => {
  const d = ext.parts['18892'];
  assert.deepEqual(d.size, [4, 2], '18892 是 2×4 砖 + 两侧轮销，占地 4×2 格');
  assert.equal(d.h, 3, '砖高 3 片');
  // 轮销进入连接字段而不是占地：两根，沿本地 x
  assert.ok(Array.isArray(d.wheelPins) && d.wheelPins.length === 2, '18892 应有 2 个轮销连接器');
  for (const w of d.wheelPins) assert.equal(w[3], 'x', '轮销沿本地 x 轴外伸');
  const boxes = partBoxes(P('18892'), d);
  const maxX = Math.max(...boxes.map((b) => b.x1));
  assert.ok(maxX <= 4 + 1e-6, `主体盒不得超出 4 格（实测 ${maxX}）`);
});

test('18892 同类污染全量清理：其余轮销件的 size 均不超过其描述尺寸', () => {
  // 描述里带 "N x M" 的轮销/轮hänger件，目录 size 必须与描述一致（轮销一律不计入占地）
  const cases = {
    2926: [4, 1], 4488: [2, 2], 4600: [2, 2], 6157: [3, 2], 7222: [1, 3], 11002: [3, 2],
    21445: [2, 1], 24055: [4, 6], 24326: [3, 4], 39767: [3, 2], 69964: [1, 3],
  };
  for (const [id, size] of Object.entries(cases)) {
    const d = ext.parts[id];
    assert.ok(d, `${id} 应在扩充目录里`);
    assert.deepEqual(d.size, size, `${id}（${d.name}）占地应为 ${size}`);
    assert.ok(Array.isArray(d.wheelPins) && d.wheelPins.length >= 1, `${id} 应有轮销连接器`);
  }
});

test('轮销 ↔ 轮毂 ↔ 轮胎：pin↔axleHole 与 tyre↔rim 两层连接都能扣上', () => {
  const wall = P('18892');
  const wallConn = partConnectors(wall, ext.parts['18892']);
  const pinIdx = wallConn.studs.findIndex((s) => s.kind === 'pin');
  assert.ok(pinIdx >= 0, '18892 必须输出 pin 连接器');
  const pin = wallConn.studs[pinIdx];
  assert.equal(pin.axis, 'x', '轮销轴向 x');
  // 轮毂：绕竖直轴转 90°，把本地 z 轮轴对准世界 x
  // 轮毂：up 保持 +y（轮盘面朝上建模），绕竖直轴转 90° 把本地轮轴 z 转到世界 x，与轮销同轴
  const rim = snapPart(wall, ext.parts['18892'], pinIdx, { id: 'rim', part: '11208', color: 0, up: '+y', rot: 90 }, ext.parts['11208'], 0);
  assert.ok(partsConnected(wall, ext.parts['18892'], rim, ext.parts['11208']), '轮销应插进轮毂中央轴孔（pin↔axle）');
  // 轮胎：与轮毂同心同轴，内孔 0.86 ≤ 轮毂外径 0.91 ≤ 轮胎外径 1.32
  const rimConn = partConnectors(rim, ext.parts['11208']);
  const rimIdx = rimConn.studs.findIndex((s) => s.kind === 'rim');
  assert.ok(rimIdx >= 0, '轮毂必须输出 rim 连接器');
  const tyre = snapPart(rim, ext.parts['11208'], rimIdx, { id: 'tyre', part: '11209', color: 0, up: '+y', rot: 90 }, ext.parts['11209'], 0);
  assert.ok(partsConnected(rim, ext.parts['11208'], tyre, ext.parts['11209']), '轮胎应套在轮毂上（tyre↔rim）');
  // 反例：半径不匹配的两件不算连接
  const fakeRim = { kind: 'other', size: [2, 1], h: 5, studs: 0, wheel: { role: 'rim', axis: 'z', outer: 5, bore: 0 } };
  assert.equal(partsConnected(P('11208'), fakeRim, tyre, ext.parts['11209']), false, '轮毂外径大于轮胎外径不算套合');
  // 整条链子 validate 通过
  const r = validate(model([
    { id: 'wall', part: '18892', color: 0, at: [0, 0, 0], step: 1 },
    { ...rim, id: 'rim', step: 2 },
    { ...tyre, id: 'tyre', step: 3 },
  ]), cat);
  assert.deepEqual(codes(r.errors), []);
});

test('人仔四件互插：73200 腿胯 ↔ 76382 躯干 ↔ 3626b 头 ↔ 11303 帽', () => {
  for (const id of ['73200', '76382', '3626b', '11303']) {
    assert.ok(ext.parts[id] && ext.parts[id].minifig, `${id} 应有 minifig 接口定义`);
  }
  const hips = P('73200');
  const torso = P('76382', [0, 6, 0]);
  const head = P('3626b', [1, 12, 1]);
  const cap = P('11303', [1, 15, 1]);
  assert.ok(partsConnected(hips, ext.parts['73200'], torso, ext.parts['76382']), '躯干底孔应扣住胯部插柱');
  assert.ok(partsConnected(torso, ext.parts['76382'], head, ext.parts['3626b']), '头部颈孔应插进躯干颈柱');
  assert.ok(partsConnected(head, ext.parts['3626b'], cap, ext.parts['11303']), '帽底孔应扣住头顶凸点');
  // 反例：腿直接扣帽不成立（跨级）
  assert.equal(partsConnected(hips, ext.parts['73200'], cap, ext.parts['11303']), false, '跨级插接不得成立');
  const r = validate(model([
    { id: 'hips', part: '73200', color: 0, at: [0, 0, 0], step: 1 },
    { id: 'torso', part: '76382', color: 0, at: [0, 6, 0], step: 2 },
    { id: 'head', part: '3626b', color: 0, at: [1, 12, 1], step: 3 },
    { id: 'cap', part: '11303', color: 0, at: [1, 15, 1], step: 4 },
  ]), cat);
  assert.deepEqual(codes(r.errors), [], '整条人仔链 validate 必须零错误');
});

test('人仔四件互插：snap 自动落位（不手算坐标）后位置与手工值一致', () => {
  const b = createBuilder({ catalog: cat, meta: { name: 'fig' } });
  const hips = b.add('73200', 0, { at: [0, 0, 0], step: 1 });
  const hipsConn = partConnectors(hips, ext.parts['73200']);
  const torso = b.add('76382', 0, { on: hips.id, stud: 0, receptor: 0, step: 2 });
  assert.deepEqual(torso.at, [0, 6, 0], '躯干底孔扣胯顶插柱 → y=6');
  const torsoConn = partConnectors(torso, ext.parts['76382']);
  const neck = torsoConn.studs.findIndex((s) => s.kind === 'minifig');
  const head = b.add('3626b', 0, { on: torso.id, stud: neck, receptor: 1, step: 3 });
  assert.deepEqual(head.at, [1, 12, 1], '头颈孔扣躯干颈柱');
  const headConn = partConnectors(head, ext.parts['3626b']);
  const top = headConn.studs.findIndex((s) => s.kind === 'top');
  const cap = b.add('11303', 0, { on: head.id, stud: top, receptor: 0, step: 4 });
  assert.deepEqual(cap.at, [1, 15, 1], '帽底孔扣头顶凸点');
  assert.ok(hipsConn.studs.length > 0);
  const r = b.assert();
  assert.deepEqual(r.errors, []);
});

// ---------------------------------------------------------------- ⑤ 翻面搭建
test('翻面搭建：负层倒装合法（不报 ground），flip: true 以最上层为施工基准面', () => {
  // 负层：底板从下方 -1 挂到砖底，先放
  const inverted = validate(model([
    { id: 'p', part: '3020', color: 4, at: [0, -1, 0], step: 1 },
    { id: 'b', part: '3001', color: 4, at: [0, 0, 0], step: 2 },
  ]), cat);
  assert.deepEqual(codes(inverted.errors), [], '负层倒装不得报 floating');
  assert.ok(!codes(inverted.warnings).includes('ground'), '负层不得报 ground 警告');
  // 正常叠放顺序照旧工作
  const normal = validate(model([
    { id: 'b', part: '3001', color: 4, at: [0, 0, 0], step: 1 },
    { id: 'p', part: '3020', color: 4, at: [0, 3, 0], step: 2 },
  ]), cat);
  assert.deepEqual(codes(normal.errors), []);
  // flip：第一步放「翻转后朝上」的最上层件，第二步才是它下方那件
  const flipped = validate(model([
    { id: 'p', part: '3020', color: 4, at: [0, 3, 0], step: 1 },
    { id: 'b', part: '3001', color: 4, at: [0, 0, 0], step: 2 },
  ], { meta: { name: 'flip', flip: true } }), cat);
  assert.deepEqual(codes(flipped.errors), [], 'flip 声明后从最上层起搭不得报 floating');
  assert.ok(!codes(flipped.warnings).includes('ground'));
});

// ---------------------------------------------------------------- 回归：四个示例模型
test('回归：mecha / lantern.reconstructed / cottage / demo-ext-part 仍零错误零警告', () => {
  const cases = [['mecha', 83], ['lantern.reconstructed', 78], ['cottage', 75], ['demo-ext-part', 3]];
  for (const [name, n] of cases) {
    const m = JSON.parse(fs.readFileSync(`examples/${name}.brick.json`, 'utf8'));
    const r = validate(m, cat);
    assert.equal(r.ok, true, `${name} 应 0 errors，实际：${r.errors.map((e) => `${e.code}:${e.msg}`).join(' | ')}`);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.stats.parts, n, `${name} 零件数 ${r.stats.parts}，期望 ${n}`);
  }
});

// ---------------------------------------------------------------- 装配能力全景（60239 实测集）
// 60239 首考失败的根因是「明明该扣上的连接扣不上」。这组用例把当时需要的每一对父子装配
// 都在真实 builder 流程里钉死（父件放高台、子件用 on/stud 扣上、b.assert() 零错误），
// 防止日后改目录/连接器时无回声地退回「只能把零件摊在地上」。
test('装配能力全景：60239 需要的 40 对父子装配全部可扣（含车轮链与人仔）', () => {
  const pairs = [
    // 底盘 28324 的底面 / 顶面 / 内腔（倒装板、斜坡、侧凸点砖、内饰）
    ['28324', '3021'], ['28324', '2420'], ['28324', '52107'], ['28324', '22889'],
    ['28324', '30414'], ['28324', '3020'], ['28324', '35480'], ['28324', '73081'],
    ['28324', '2432'], ['28324', '2412a'], ['28324', '32059'], ['28324', '18892'],
    ['28324', '87609'], ['28324', '3710'], ['28324', '3023b'],
    // 双阶斜坡内槽 → POLICE 砖 / 壁板 / 蓝条
    ['22889', '3010'], ['22889', '15207'], ['22889', '3666'],
    // 引擎盖 32059 → 风挡 / 板 / 弧面车顶 / 双凸点板
    ['32059', '57783'], ['32059', '3023b'], ['32059', '98281'], ['32059', '34103'],
    // 尾保险杠 87609 → 弧面砖 / 端板 / 尾灯 / 车牌
    ['87609', '93606'], ['87609', '3023b'], ['87609', '54200'], ['87609', '2431'],
    // 车轮链：轮销 → 轮毂 → 轮胎（零件 11208 的轴孔朝本地 +z，挂到朝 +x 的轮销要 rot:90）
    ['18892', '11208'], ['11208', '11209'],
    // 人仔四件互插
    ['73200', '76382'], ['76382', '3626b'], ['3626b', '11303'],
    // 平面件相互扣合
    ['3023b', '27263'], ['3023b', '29119'], ['3023b', '29120'], ['3023b', '54200'],
    ['3023b', '60477'], ['3023b', '93273'], ['3023b', '4162'], ['3023b', '2431'], ['3023b', '3069b'],
  ];
  const failures = [];
  for (const [base, child] of pairs) {
    let done = false, last = '未尝试';
    for (const prot of [0, 90, 180, 270]) {
      if (done) break;
      const b = createBuilder({ catalog: cat, meta: { name: 'pair' } });
      let B;
      try { B = b.add(base, 15, { at: [20, 20, 20], rot: prot, step: 1 }); } catch (e) { last = e.message.split('\n')[0]; continue; }
      const n = partConnectors(B, cat.parts[base]).studs.length;
      for (let si = 0; si < n && !done; si++) {
        // 子件也要枚举 rot/up：轴孔/侧凸点件换姿态才扣得上，只试默认姿态会误判成"扣不上"
        for (const crot of [0, 90, 180, 270]) {
          for (const cup of ['+y', '-y', '+z', '-z', '+x', '-x']) {
            if (done) break;
            try { b.add(child, 15, { on: B.id, stud: si, receptor: 0, rot: crot, up: cup, step: 2 }); b.assert(); done = true; }
            catch (e) { last = e.message.split('\n')[0]; }
          }
        }
      }
    }
    if (!done) failures.push(`${base}>${child}：${String(last).slice(0, 90)}`);
  }
  assert.deepEqual(failures, [], `有 ${failures.length} 对装配扣不上：\n${failures.join('\n')}`);
  assert.equal(pairs.length, 40, '用例集应覆盖 40 对（改动此表时同步更新断言）');
});
