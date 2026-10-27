// 扩充目录修复（审计 docs/扩充目录失效边界.md P0/P1）单元测试：
//   P0-a 高度归一（砖体 24 LDU 基准，剔除 bbox 顶部 4 LDU 凸沿）与主体/外挑分离；
//   P0-b bracket 缺 vH/dir 显式守卫（渲染与碰撞两处）；
//   P1  连接语义自动提取（销孔/轴孔受体、侧凸点、把手杆、外凸销）与 ext 虚假底孔受体禁用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { partBoxes, partConnectors, partsConnected, validate } from '../src/core/core.js';
import { createBuilder } from '../src/core/builder.js';
import { cat, partGeometry } from '../src/viewer/geom.js';

const ext = JSON.parse(fs.readFileSync('catalog/parts-ldraw.json', 'utf8')).parts;

// ---------------------------------------------------------------- P0-a 高度归一
test('P0-a 高度归一：官方 bbox 28 LDU（含凸沿）的砖记 3 片而非 4 片', () => {
  // 官方实测 ey=28（brick 2×4 / 科技砖 1×8 / 砖 4×6 / 砖 1×2 凹槽），砖体 24 LDU = 3 片
  for (const id of ['3001', '3702', '3701', '2356', '4216', '2458', '86876']) {
    assert.equal(ext[id].h, 3, `${id}（${ext[id].name}）应记 3 片`);
  }
});

test('P0-a 高度归一：板类 12 LDU（含凸沿）记 1 片而非 2 片', () => {
  // 审计复核补标（§3-F3）：3023b 与 11212 的 rawEntry 曾为 h=2（板类应为 1）
  for (const id of ['3020', '3023b', '11212', '6141']) assert.equal(ext[id].h, 1, `${id} 应记 1 片`);
  assert.equal(ext['3386'].h, 2, '3386（1×1×0.667 圆半板）砖体 16 LDU 应记 2 片');
  assert.equal(ext['4589'].h, 3, '4589 锥 1×1 官方 28 LDU 含凸沿应记 3 片');
});

test('P0-a 主体/外挑分离：2458 侧销外挑不计入占地（2×2→2×1），销另行表达为 pins', () => {
  const d = ext['2458'];
  assert.deepEqual(d.size, [2, 1], '2458 砖体 1×2，侧销 1 格外挑不得计入占地');
  assert.equal(d.h, 3, '2458 砖高 3 片');
  assert.ok(Array.isArray(d.pins) && d.pins.length === 1, '2458 侧销应有 pins 连接字段');
  const conn = partConnectors({ id: 't', part: '2458', at: [0, 0, 0], step: 1 }, d);
  const pin = conn.studs.find((s) => s.kind === 'pin');
  assert.ok(pin, '2458 应输出销（pin）连接器');
  assert.equal(pin.axis, 'z', '2458 侧销沿本地 z 轴（穿入侧面）');
});

test('P0-a 主体/外挑分离：18649 把手板占地还原 2×1、把手立柱剔除后满格凸点', () => {
  const d = ext['18649'];
  assert.deepEqual(d.size, [2, 1], '18649 真实为 1×2 板（曾误为 4×1）');
  assert.equal(d.h, 1);
  assert.ok(Array.isArray(d.bars) && d.bars.length >= 2, '18649 两端把手应输出 bars 连接字段');
});

// ---------------------------------------------------------------- P0-b bracket 守卫
test('P0-b partBoxes：bracket 缺 vH/dir 显式抛错（禁止 NaN 静默归零造成穿模假阴性）', () => {
  const bad = { kind: 'bracket', size: [2, 1], h: 3, studs: 2 }; // ext 旧条目形态：h=总高且缺 vH/dir
  assert.throws(() => partBoxes({ id: 'x', part: '2436a', at: [0, 0, 0], step: 1 }, bad), /vH\/dir/);
});

test('P0-b partGeometry：bracket 缺 vH/dir 显式抛错（禁止 NaN 污染场景导致整帧全白）', () => {
  cat.parts['~test-bad-bracket'] = { kind: 'bracket', size: [2, 1], h: 3, studs: 2, name: 'test' };
  try {
    assert.throws(() => partGeometry('~test-bad-bracket'), /vH\/dir/);
  } finally {
    delete cat.parts['~test-bad-bracket'];
  }
});

test('P0-b ext bracket 2436a：实测 vH/dir/sideRows 齐备，包围盒竖板有真实高度', () => {
  const d = ext['2436a'];
  assert.equal(d.kind, 'bracket');
  assert.equal(d.dir, 'down', '2436a 墙板在基板下方（官方 .dat 实测）');
  assert.equal(d.vH, 3, '2436a 官方总高 24 LDU → vH=3 片');
  assert.deepEqual(d.size, [2, 1], '基板 1×2（带顶凸点翼板），不再把墙板长度误作基板');
  const boxes = partBoxes({ id: 'x', part: '2436a', at: [0, 0, 0], step: 1 }, d);
  assert.equal(boxes.length, 2);
  const wall = boxes[1];
  assert.ok(Number.isFinite(wall.y0) && Number.isFinite(wall.y1) && wall.y1 - wall.y0 > 0.5, '竖板包围盒必须有真实高度（曾退化 y0=y1=0）');
  const conn = partConnectors({ id: 'x', part: '2436a', at: [0, 0, 0], step: 1 }, d);
  assert.equal(conn.studs.filter((s) => s.kind === 'side').length, 4, '墙板 4 侧凸点（1×4 墙板）');
  assert.equal(conn.receptors.length, 2, '基板 1×2 仅 2 个底孔（不再虚增）');
});

test('P0-b validate：含缺 vH/dir bracket 的模型报 part-schema 校验错误而非崩溃/假阴性', () => {
  const model = {
    format: 'brickbuild', version: '0.2',
    meta: { name: 'bad-bracket' },
    parts: [{ id: 'p1', part: '~nobracket', color: 4, at: [0, 0, 0], step: 1 }],
  };
  const badCat = { parts: { '~nobracket': { kind: 'bracket', size: [2, 1], h: 3, studs: 2 } }, colors: {} };
  const r = validate(model, badCat);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'part-schema' && /vH\/dir/.test(e.msg)), '应报 part-schema 错误');
});

// ---------------------------------------------------------------- P1 连接语义
test('P1 销孔受体：3702 科技砖 1×8 的 7 个销孔以 holes 字段进入 partConnectors', () => {
  const d = ext['3702'];
  assert.ok(Array.isArray(d.holes) && d.holes.length === 14, '7 孔 × 前后孔口 = 14 个 hole 实例');
  const conn = partConnectors({ id: 'x', part: '3702', at: [0, 0, 0], step: 1 }, d);
  const holes = conn.receptors.filter((r) => r.kind === 'hole');
  assert.equal(holes.length, 14);
  assert.ok(holes.every((r) => r.axis === 'z'), '孔轴沿本地 z（穿 1 格深砖体）');
  // 高度：官方孔心 y=10 LDU（砖体底 24）→ ly=(24-10)/20=0.7 格 → 0.7×2.5=1.75 片高（砖高中线附近）
  assert.ok(holes.every((r) => Math.abs(r.pos[1] - 1.75) < 0.01), '销孔位于砖体中线高度');
});

test('P1 销孔受体：32017 科技梁 5 孔 + 4265a 轴衬轴孔', () => {
  const beam = partConnectors({ id: 'x', part: '32017', at: [0, 0, 0], step: 1 }, ext['32017']);
  assert.equal(beam.receptors.filter((r) => r.kind === 'hole').length, 6, '32017 五孔（4 梁孔中心 + 1 贯穿孔双孔口）');
  const bush = partConnectors({ id: 'x', part: '4265a', at: [0, 0, 0], step: 1 }, ext['4265a']);
  assert.equal(bush.receptors.filter((r) => r.kind === 'axle').length, 1, '4265a 中央轴孔');
});

test('P1 销↔销孔物理连接：2458 侧销插入 3702 销孔构成 partsConnected', () => {
  // 2458 @ [0,0,0]（砖体 x∈[0,2] z∈[0,1]），销环世界位 ≈ [1, 1.75片, 1]；
  // 3702 @ [0,0,1] 贴在销侧：靠 2458 一侧孔口 z=1、x=4+n（n=-3 → 1）→ 与销环重合
  const pinDef = ext['2458'], beamDef = ext['3702'];
  const a = { id: 'a', part: '2458', at: [0, 0, 0], step: 1 };
  const b = { id: 'b', part: '3702', at: [0, 0, 1], step: 1 };
  const connB = partConnectors(b, beamDef);
  const mouth = connB.receptors.find((r) => r.kind === 'hole' && Math.abs(r.pos[2] - 1) < 0.01 && Math.abs(r.pos[0] - 1) < 0.01);
  assert.ok(mouth, '3702 靠近 2458 一侧应有与销环重合的孔口受体');
  assert.ok(
    partsConnected(a, pinDef, b, beamDef),
    '2458 的销应与 3702 的销孔构成物理连接（新 pin↔hole 匹配规则）',
  );
});

test('P1 侧凸点：86876 中央侧凸点与 3386 开放侧凸点输出 side 连接器', () => {
  for (const id of ['86876', '3386']) {
    const conn = partConnectors({ id: 'x', part: id, at: [0, 0, 0], step: 1 }, ext[id]);
    const side = conn.studs.filter((s) => s.kind === 'side');
    assert.equal(side.length, 1, `${id} 应有 1 个实测侧凸点`);
    assert.equal(side[0].dir, '+z', `${id} 侧凸点朝 +z（官方 .dat 实测）`);
  }
});

test('P1 把手杆（bars）与夹口（clips）：ext 字段经 bar↔clip 规则同轴可扣合', () => {
  // 合成最小目录条目：杆沿 x @ (0, 0.5片, 0)，夹口张向 -z（夹杆轴向 x）
  const handleDef = { kind: 'other', size: [1, 1], h: 1, studs: 0, bars: [[0, 0.2, 0, 'x']] };
  const clipDef = { kind: 'other', size: [1, 1], h: 1, studs: 0, clips: [[0, 0.2, 0, '-z']] };
  const a = { id: 'a', part: 'X1', at: [0, 0, 0], step: 1 };
  const b = { id: 'b', part: 'X2', at: [0, 0, 0], step: 1 };
  const bar = partConnectors(a, handleDef).studs.find((s) => s.kind === 'bar');
  const clip = partConnectors(b, clipDef).receptors.find((r) => r.kind === 'clip');
  assert.ok(bar && clip);
  assert.equal(bar.axis, 'x');
  assert.equal(clip.axis, 'x', '夹口 face ±z 时夹杆轴向为 x');
  assert.ok(partsConnected(a, handleDef, b, clipDef), '同轴同位的杆与夹口应扣合');
  // 轴向不匹配（杆沿 z）不得扣合
  const handleDefZ = { kind: 'other', size: [1, 1], h: 1, studs: 0, bars: [[0, 0.2, 0, 'z']] };
  assert.equal(partsConnected(a, handleDefZ, b, clipDef), false, '杆轴 z 与夹口轴 x 不同轴不得扣合');
  // 真实件：18649 实测 4 根把手杆（bar 连接器），杆沿本地 z；精选 60470 夹口轴向本地 x —— 互扣需转 90°
  const conn = partConnectors({ id: 'x', part: '18649', at: [0, 0, 0], step: 1 }, ext['18649']);
  const bars = conn.studs.filter((s) => s.kind === 'bar');
  assert.equal(bars.length, 4);
  assert.ok(bars.every((s) => s.axis === 'z'), '18649 把手杆沿本地 z');
  const clip60470 = partConnectors({ id: 'x', part: '60470', at: [0, 0, 0], step: 1 }, cat.parts['60470']).receptors.find((r) => r.kind === 'clip');
  assert.equal(clip60470.axis, 'x', '精选 60470 夹口轴向 x');
});

test('P1 clips：ext 夹类件（4085b）输出 clip 受体', () => {
  const d = ext['4085b'];
  assert.ok(Array.isArray(d.clips) && d.clips.length === 1, '4085b 薄 U 夹应有 1 个夹口');
  const conn = partConnectors({ id: 'x', part: '4085b', at: [0, 0, 0], step: 1 }, d);
  assert.equal(conn.receptors.filter((r) => r.kind === 'clip').length, 1);
});

// ---------------------------------------------------------------- 虚假受体禁用
test('虚假受体禁用：无顶凸点科技件（梁/轴/轴衬/销）底面零反孔', () => {
  // 2026-10 回修后策略：科技件维持空数组禁用（.dat 明确无底腔）；
  // 3937/65146（砖族安装本体）已改为 antistudSource:'assumed' 恢复默认满格，见下方新策略测试
  for (const id of ['32017', '3705', '4265a', '3673', '3749', '4459']) {
    const d = ext[id];
    assert.deepEqual(d.antistudCells, [], `${id} 官方底面无反孔，应写空数组禁用默认满格`);
    const conn = partConnectors({ id: 'x', part: id, at: [0, 0, 0], step: 1 }, d);
    assert.equal(conn.receptors.filter((r) => r.kind === 'antistud').length, 0, `${id} 不应再生成虚假底孔受体`);
  }
});

test('虚假受体禁用：tile 类保持默认满格底孔（反向扣合能力不回退）', () => {
  const d = ext['3069a'];
  assert.equal(d.antistudCells, undefined, 'tile 类（box 边沿建模）保持引擎默认满格路径');
  const conn = partConnectors({ id: 'x', part: '3069a', at: [0, 0, 0], step: 1 }, d);
  assert.equal(conn.receptors.filter((r) => r.kind === 'antistud').length, 2, '3069a 反向扣合 2 底孔');
});

test('needsManual：无法自动判定的外挑件如实标记（不猜）', () => {
  const flagged = Object.entries(ext).filter(([, d]) => d.needsManual);
  assert.ok(flagged.length >= 20, `应有不少于 20 条 needsManual（实测 ${flagged.length}）`);
  assert.ok(!ext['2458'].needsManual, '2458 侧销已由 pins 解释，不应误标');
  assert.ok(ext['2335'].needsManual, '2335（旗杆顶天线上探）应标 needsManual');
});

// ---------------------------------------------------------------- 底孔三类处置（2026-10 回修）
test('回修：3299/3049b 簇图元（stud4a/stud3a）按覆盖格展开，antistudCells 非空且可反向扣合', () => {
  // 3299（屋脊 4×2）：官方 3× stud4a 交界管此前映射失败被误写空数组；展开后 = 4×2 满格 8 底孔
  const ridge = ext['3299'];
  assert.equal(ridge.antistudSource, 'measured', '3299 底孔应有 .dat 实测来源标记');
  assert.equal(ridge.antistudCells.length, 8, '3299 三根交界管展开应覆盖 4×2 全部 8 格');
  assert.ok(!ridge.antistudCenter, '偶数网格不得再有半格位中心受体（曾致 snap 产出非整数坐标）');
  // 3049b（双面反斜 2×2，底面实为 2×1）：1× stud3a 半格位展开 = 真实底面 2 格
  const inv = ext['3049b'];
  assert.equal(inv.antistudSource, 'measured');
  assert.deepEqual(inv.antistudCells, [[0, 1], [1, 1]], '3049b 底面 2×1：仅 k=1 行 2 格有底孔');
  // 反向扣合：builder 把两件经底孔扣上 3001，snap 坐标必须为整数格且 validate 通过
  for (const id of ['3299', '3049b']) {
    const b = createBuilder({ catalog: cat, meta: { name: 'reverse-mount' } });
    const base = b.add('3001', 0, { at: [0, 0, 0], step: 1 });
    const placed = b.add(id, 0, { on: base.id, stud: 0, step: 2 });
    b.assert();
    assert.ok(placed.at.every(Number.isInteger), `${id} snap 坐标应为整数格，收到 ${JSON.stringify(placed.at)}`);
  }
});

test('回修：.dat 未建模底腔但物理存在的砖族（3937/6078/65146）保守恢复默认满格并标 assumed', () => {
  for (const id of ['3937', '6078', '65146']) {
    const d = ext[id];
    assert.equal(d.antistudSource, 'assumed', `${id} 应标记 antistudSource:'assumed'`);
    assert.equal(d.antistudCells, undefined, `${id} 移除空数组 → 走引擎默认满格路径（等价回修前行为）`);
    const conn = partConnectors({ id: 'x', part: id, at: [0, 0, 0], step: 1 }, d);
    assert.ok(conn.receptors.filter((r) => r.kind === 'antistud').length > 0, `${id} 垫砖底孔回复`);
  }
});

test('回修：confric 摩擦销族进 PIN_PRIMITIVES 白名单，4459 获得销连接器', async () => {
  const { PIN_PRIMITIVES } = await import('../src/ldraw/ldraw.js');
  assert.ok(PIN_PRIMITIVES.has('confric.dat'), 'confric.dat 应在 PIN_PRIMITIVES 白名单');
  assert.ok(!PIN_PRIMITIVES.has('confricrib1.dat'), 'confricrib* 是销面筋条子图元，不得当独立销');
  const d = ext['4459'];
  assert.ok(Array.isArray(d.pins) && d.pins.length === 1, '4459 双头摩擦销 = 1 个中心销连接器');
  assert.equal(d.pins[0][3], 'x', '销沿本地 x 轴（穿 2 格）');
  const conn = partConnectors({ id: 'x', part: '4459', at: [0, 0, 0], step: 1 }, d);
  const pin = conn.studs.find((s) => s.kind === 'pin');
  assert.ok(pin, '4459 应输出销（pin）连接器');
  assert.equal(pin.axis, 'x');
});

test('回修：2654a dish 官方 4 角凸点以显式 studCells 表示，引擎不再强制单中心凸点', () => {
  const d = ext['2654a'];
  assert.ok(Array.isArray(d.studCells) && d.studCells.length === 4, '2654a 应显式写入 4 格角凸点 studCells');
  const conn = partConnectors({ id: 'x', part: '2654a', at: [0, 0, 0], step: 1 }, d);
  const tops = conn.studs.filter((s) => s.kind === 'top');
  assert.equal(tops.length, 4, 'studs 输出应为 4 个角凸点（而非单中心凸点）');
  const corners = new Set(tops.map((s) => `${s.pos[0]},${s.pos[2]}`));
  assert.deepEqual([...corners].sort(), ['0.5,0.5', '0.5,1.5', '1.5,0.5', '1.5,1.5'], '凸点位于 4 角（at 为格角锚点，2×2 件在 [0,0] 时四角为 0.5/1.5）');
});

// ---------------------------------------------------------------- ldraw.js 图元层（合成 .dat，不依赖库文件）
test('图元层：connectorInstancesFromText 按白名单收集销孔/轴孔/销/夹实例与横向凸点', async () => {
  const { connectorInstancesFromText, PIN_HOLE_PRIMITIVES, AXLE_HOLE_PRIMITIVES } = await import('../src/ldraw/ldraw.js');
  assert.ok(PIN_HOLE_PRIMITIVES.has('peghole.dat') && PIN_HOLE_PRIMITIVES.has('connhole.dat'));
  assert.ok(AXLE_HOLE_PRIMITIVES.has('axlehole.dat') && !AXLE_HOLE_PRIMITIVES.has('axlehol8.dat'), 'axlehol8 是轴杆本体，不得当轴孔');
  // 合成 .dat：1 个竖直凸点（顶）+ 1 个横向 stud2（侧）+ 1 个 peghole（销孔）
  const text = [
    '0 Technic Test Part',
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat',
    '1 16 0 10 -10 1 0 0 0 0 1 0 1 0 stud2.dat',
    '1 16 20 10 10 1 0 0 0 0 1 0 -1 0 peghole.dat',
  ].join('\n');
  const resolve = () => null; // 图元即叶子
  const inst = connectorInstancesFromText(text, resolve);
  const up = inst.find((c) => c.prim === 'stud.dat');
  assert.ok(up && up.yUp > 0.7, '竖直凸点 yUp>0.7');
  const side = inst.find((c) => c.prim === 'stud2.dat');
  assert.ok(side && Math.abs(side.yUp) < 0.3, '横向凸点 |yUp|<0.3 → 侧凸点');
  const hole = inst.find((c) => c.prim === 'peghole.dat');
  assert.ok(hole && Math.abs(hole.pos[0] - 20) < 0.01, 'peghole 实例记录世界坐标');
});

test('图元层：bboxFromText skipInstance 实现 2458 型主体/外挑分离', async () => {
  const { bboxFromText } = await import('../src/ldraw/ldraw.js');
  const lib = {
    'connect.dat': '1 16 0 0 0 1 0 0 0 1 0 0 0 1 4-4cyli.dat\n4 16 -4 0 -4 4 0 -4 4 0 4 -4 0 4\n1 16 0 0 -10 4 0 0 0 4 0 0 0 4 4-4cyli.dat',
    // connect.dat 内部再引用的圆柱（子树一并跳过）
    '4-4cyli.dat': '4 16 -6 -6 -6 6 -6 -6 6 6 6 -6 6 6',
  };
  const resolve = (raw) => lib[String(raw).toLowerCase()] || null;
  // 砖体：z∈[-10,10] 的盒（4 个四边形角点）；侧销：connect.dat 平移到 z=-10（外挑至 z≈-16）
  const text = [
    '4 16 -20 0 -10 20 0 -10 20 24 10 -20 24 10',
    '4 16 -20 24 -10 -20 0 -10 -20 0 10 -20 24 10',
    '4 16 20 0 10 20 24 10 -20 24 10 -20 0 10',
    '1 16 0 10 -10 0 0 1 0 1 0 -1 0 0 connect.dat',
  ].join('\n');
  const full = bboxFromText(text, resolve);
  const body = bboxFromText(text, resolve, { skipInstance: (base) => base === 'connect.dat' });
  assert.ok(body.max[2] - body.min[2] < full.max[2] - full.min[2], '剔除 connect 销后主体 z 向变小');
  assert.ok(Math.abs((body.max[2] - body.min[2]) - 20) < 1, '主体 z 应约 20 LDU（1 格砖体）');
  assert.ok(full.max[2] - full.min[2] > 24, '全量 bbox 含销外挑');
});
test('回归：mecha / lantern / cottage / demo-ext-part 与修复前一致（0 errors 0 warnings）', () => {
  // mecha 的实际件数以 examples/mecha.brick.json 为准：HEAD 47f02a5 后模型仍是 83 件。
  // 曾经的期望值 99 来自「计划加 16 片 3023 垫板恢复柱顶承重层（tools/fix-mecha-a2.mjs）」，
  // 但那次重建没有落进仓库里的模型文件，测试期望因此领先于模型事实。这里改回 83，
  // 99 作为未完成目标记录在 docs/prd-v2/implementation-A/baseline.md §5 与里程碑里，
  // 不再用一个没发生的重建当作回归基线。
  const cases = [
    ['mecha', 83], ['lantern.reconstructed', 78], ['cottage', 75], ['demo-ext-part', 3],
  ];
  for (const [name, n] of cases) {
    const model = JSON.parse(fs.readFileSync(`examples/${name}.brick.json`, 'utf8'));
    const r = validate(model, cat);
    assert.equal(r.ok, true, `${name} 应 0 errors`);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.stats.parts, n, `${name} 零件数`);
  }
});
