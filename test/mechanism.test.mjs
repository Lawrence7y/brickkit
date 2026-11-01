// 可开合机构的几何核对回归（mech-axis / mech-range / mech-clearance / mech-rigid）。
//
// 背景：`validate` 过去对 mechanisms[] 只做字段存在性检查，于是下面这些明显错误的模型
// 全部零错误通过——查看器照样绕一个不存在的轴旋转，A4 图纸照样画开合页：
//   · 把 pivot 挪到 [9999, 9999, 9999]（转轴悬在模型外几百格处）
//   · axis 写成 [0,0,0]（查看器 mechMatrix 会静默退化成「不动」）
//   · range 写成 [90, 0]（倒置）或 ["a","b"]（非数字）
//   · 把两颗普通砖声明成 hinge，pivot 放在原点
//   · 行程内动件与静件实体相撞
// 本文件把「必须拒绝」钉死，并保留「正确建模必须通过」的正向对照。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validate, partConnectors, partBoxes, sweepCollision, matchMechAxis, mechCandidates, rotateAboutPivot,
  mergeCatalogParts,
} from '../src/core/core.js';

const curated = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8')).parts;
const ext = JSON.parse(fs.readFileSync('catalog/parts-ldraw.json', 'utf8')).parts;
const cat = { parts: mergeCatalogParts(ext, curated) };
const codes = (list) => list.map((e) => e.code);

/**
 * 最小可开合装置：48336（带侧把柄板，静件）+ 63868（端头夹板，动件）。
 *
 * 坐标不是手填的，而是由修复后的接口库反解：
 *   48336 的实测把柄是**杆段**：中心在世界 [1, 1, 1.5]，轴沿 x，半长 0.7（官方 4-4cylo ±14 LDU）；
 *   63868 的实测夹口在 up=+z/rot=180 时落在自身 at + [0.5, 6.25, 0.4]；
 *   令夹口落在杆段上（这里取杆段中心）即得夹板 at = [0.5, -5.25, 1.1]，partsConnected 为 true。
 *
 * 2026-11 修正：旧基线把夹板钉在 at.x = -0.35（夹口 x=0.15）——那是**旧提取**（把柄被错提成
 * 两端支撑环、x=±0.85 的两个点）留下的位置，恰好是杆段外 0.15 格；杆段语义下必须挪回杆上。
 * 这对零件正是机甲 p30/p56 的同类结构，因此它同时也是「真实铰接」的正向基线。
 */
const REAL_HINGE = {
  fixed: { part: '48336', at: [0, 0, 0], rot: 0 },
  moving: { part: '63868', at: [0.5, -5.25, 1.1], rot: 180, up: '+z', snot: 0 },
  pivot: [1, 1, 1.5],
  axis: [1, 0, 0],
};

function hingeRig({ pivot, axis, range, moving = 'p2', extra = [] } = {}) {
  const parts = [
    { id: 'p1', color: 4, step: 1, module: 'base', ...REAL_HINGE.fixed },
    { id: 'p2', color: 4, step: 2, module: 'base', ...REAL_HINGE.moving },
    ...extra,
  ];
  const base = {
    format: 'brickbuild', version: '1.0', meta: { name: 'hinge rig', front: '+z' },
    steps: [{ n: 1 }, { n: 2 }], modules: [{ id: 'base', label: '底' }], parts,
  };
  base.mechanisms = [{
    id: 'm1',
    type: 'hinge',
    parts: [moving],
    pivot: pivot ?? REAL_HINGE.pivot,
    axis: axis ?? REAL_HINGE.axis,
    range: range ?? [-30, 30],
    evidence: ['e1'],
  }];
  return base;
}

const errCodes = (model) => codes(validate(model, cat).errors);

test('负向：转轴被挪到模型外几百格，必须报 mech-axis', () => {
  const bad = hingeRig({ pivot: [9999, 9999, 9999] });
  assert.ok(errCodes(bad).includes('mech-axis'), '远离真实铰接的 pivot 必须被拒绝');
});

test('负向：轴方向与真实铰接轴不平行，必须报 mech-axis', () => {
  // 真实夹杆沿 x 轴；这里声明绕 y 轴转（即使 pivot 点落在轴线上）
  const bad = hingeRig({ axis: [0, 1, 0] });
  assert.ok(errCodes(bad).includes('mech-axis'), '与真实铰接轴不平行的 axis 必须被拒绝');
});

test('负向：axis 为零向量必须报 mech-axis，range 倒置/非数字必须报 mech-range', () => {
  assert.ok(errCodes(hingeRig({ axis: [0, 0, 0] })).includes('mech-axis'));
  assert.ok(errCodes(hingeRig({ range: [90, 0] })).includes('mech-range'));
  assert.ok(errCodes(hingeRig({ range: [0, 0] })).includes('mech-range'));
  assert.ok(errCodes(hingeRig({ range: ['a', 'b'] })).includes('mech-range'));
});

test('负向：把两颗普通砖声明成 hinge（无任何铰接连接器），必须报 mech-axis', () => {
  const m = {
    format: 'brickbuild', version: '1.0', meta: { name: 'fake', front: '+z' },
    steps: [{ n: 1 }, { n: 2 }], modules: [{ id: 'base', label: '底' }],
    parts: [
      { id: 'b1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base' },
      { id: 'b2', part: '3001', color: 4, at: [0, 3, 0], step: 2, module: 'base' },
    ],
    mechanisms: [{ id: 'lie', type: 'hinge', parts: ['b2'], pivot: [0, 3, 0], axis: [0, 1, 0], range: [0, 90], evidence: ['e1'] }],
  };
  assert.ok(errCodes(m).includes('mech-axis'), '没有真实铰接的合页必须被拒绝');
});

test('正向：真实把柄-夹板铰接 + 无碰撞行程，不报任何 mech-* 错误', () => {
  const good = hingeRig();
  const r = validate(good, cat);
  assert.deepEqual(r.errors.filter((e) => e.code.startsWith('mech-')), [], '真实铰接不该被误判');
});

test('负向：行程内动件撞进静件，必须报 mech-clearance 并指出零件对', () => {
  // 63868 夹板从 at 起向 -y 伸出约 5 格；在它的回转路径上（同一 x/z 附近、更低的 y）放挡块，
  // 摆到 ±90° 时夹板必然扫过挡块所在区域。
  const m = hingeRig({ range: [-90, 90], extra: [{ id: 'blk', part: '3001', color: 4, at: [0, -3, 1], step: 1, module: 'base' }] });
  const r = validate(m, cat);
  const hit = r.errors.find((e) => e.code === 'mech-clearance');
  assert.ok(hit, `行程内碰撞必须报 mech-clearance，实际错误：${codes(r.errors).join(',')}`);
  assert.ok(/p2/.test(hit.msg) && /blk/.test(hit.msg), `报错应指出碰撞零件对，实际：${hit.msg}`);
});

test('负向：动件与箱体之间除铰接轴外还有别的连接时，不得一并豁免', () => {
  // 旧实现把「任何 partsConnected 的零件对」都豁免，范围过宽：
  // 动件若同时扣在别处（实物中很常见的真实碰撞来源），那处重叠会被整个放过。
  // 正确行为：只豁免连接器落在声明转轴上的那一对。
  const m = hingeRig({ range: [-90, 90] });
  // 在夹板扫掠路径上放一块挡块，并额外声明它「与夹板相连」——但连接器不在转轴上，
  // 因此不该被豁免，碰撞仍须报出。
  m.parts.push({ id: 'blk', part: '3001', color: 4, at: [0, -3, 1], step: 1, module: 'base' });
  const r = validate(m, cat);
  assert.ok(codes(r.errors).includes('mech-clearance'), '非轴上的连接不得豁免运动碰撞');
});

test('负向：动件组由两个互不相连的刚体组成，必须报 mech-rigid 警告', () => {
  const m = hingeRig();
  m.parts.push({ id: 'detached', part: '3020', color: 4, at: [6, 0, 0], step: 2, module: 'base' });
  m.mechanisms[0].parts = ['p2', 'detached'];
  const r = validate(m, cat);
  assert.ok(codes(r.warnings).includes('mech-rigid'), '与主体不连通的动件必须被指出');
});

test('几何核对的底层原语：真实铰接轴候选与轴匹配', () => {
  const m = hingeRig();
  const byId = new Map(m.parts.map((p) => [p.id, p]));
  const conn = new Map(m.parts.map((p) => [p.id, partConnectors(p, cat.parts[p.part])]));
  const cands = mechCandidates([byId.get('p2')], [byId.get('p1')], (p) => cat.parts[p.part], (id) => conn.get(id));
  assert.ok(cands.length > 0, '把柄↔夹板应产生铰接候选');
  const hit = cands.find((c) => matchMechAxis(REAL_HINGE.pivot, REAL_HINGE.axis, c).parallel);
  assert.ok(hit, '声明的转轴应与真实把柄轴线平行');
  assert.ok(matchMechAxis(REAL_HINGE.pivot, REAL_HINGE.axis, hit).dist < 0.15, 'pivot 应落在把柄轴线上');
  const raised = [REAL_HINGE.pivot[0], REAL_HINGE.pivot[1] + 2, REAL_HINGE.pivot[2]];
  assert.ok(matchMechAxis(raised, REAL_HINGE.axis, hit).dist > 0.15, '抬高 pivot 应超出容差');
});

test('几何核对的底层原语：绕轴旋转与行程扫掠', () => {
  // 绕 y 轴把 (1,0,0) 转 90° → (0,0,-1)
  const r = rotateAboutPivot([0, 0, 0], [0, 1, 0], 90, [1, 0, 0]).map((n) => +n.toFixed(6));
  assert.deepEqual(r, [0, 0, -1]);

  const box = (x0, x1, z0, z1) => ({ x0, x1, y0: 0, y1: 3, z0, z1 });
  const moving = [{ id: 'mv', boxes: [box(0, 4, 0, 2)] }];
  const overlapping = [{ id: 'st', boxes: [box(0, 4, 0, 2)] }];
  const farAway = [{ id: 'fs', boxes: [box(0, 4, 20, 22)] }];
  const hinge = { type: 'hinge', pivot: [2, 1, 1], axis: [1, 0, 0], range: [-30, 30] };
  assert.ok(sweepCollision(hinge, moving, overlapping, () => false).length > 0, '重叠件在行程内必须被判碰撞');
  assert.equal(sweepCollision(hinge, moving, farAway, () => false).length, 0, '远处静件不得误报');
  // 豁免规则生效（真实铰接的两件互相扣住）
  assert.equal(sweepCollision(hinge, moving, overlapping, () => true).length, 0, '豁免对不得报碰撞');

  // 滑动：位移 6 格撞上 5 格外的墙
  const slide = { type: 'slide', axis: [1, 0, 0], range: [0, 6] };
  const s = [{ id: 's', boxes: [box(0, 2, 0, 2)] }];
  const wall = [{ id: 'w', boxes: [box(5, 6, 0, 2)] }];
  assert.ok(sweepCollision(slide, s, wall, () => false).length > 0, '滑动撞墙必须被判碰撞');
});

test('实物样本：机甲的翼关节落在实测把柄轴线上，且每个关节都有真实铰接候选', () => {
  // 这条用例从「记录扣不上」翻转为「断言扣得上」——2026-11 把柄改为连续杆段（4-4cylo ±0.7）后，
  // 6 块夹板按杆轴重新落位，两个翼关节的 pivot 改到真实杆轴 y=20。
  //
  // 判据用的是 mechCandidates + matchMechAxis（与 validate 内部同一条路径）：
  // 每个 hinge 至少要有一个「平行且在 0.15 格内」的真实铰接候选，否则查看器会绕一根不存在的轴转。
  const m = JSON.parse(fs.readFileSync('examples/mecha.brick.json', 'utf8'));
  const byId = new Map(m.parts.map((p) => [p.id, p]));
  const conn = new Map(m.parts.map((p) => [p.id, partConnectors(p, cat.parts[p.part])]));
  for (const mech of m.mechanisms.filter((x) => x.type === 'hinge')) {
    const moving = mech.parts.map((id) => byId.get(id)).filter(Boolean);
    const fixed = m.parts.filter((p) => !mech.parts.includes(p.id));
    const cands = mechCandidates(moving, fixed, (p) => cat.parts[p.part], (id) => conn.get(id));
    const matched = cands.filter((c) => {
      const e = matchMechAxis(mech.pivot, mech.axis, c);
      return e.parallel && e.dist <= 0.15;
    });
    assert.ok(matched.length > 0, `${mech.id}：声明的 pivot/axis 必须落在真实把柄轴线上`);
  }
  // 整机不得再报 mech-axis / mount-disconnected
  const r = validate(m, cat);
  assert.ok(!codes(r.errors).includes('mech-axis'), '关节均已真实铰接，不得再报 mech-axis');
  assert.ok(!codes(r.errors).includes('mount-disconnected'), '所有 mount 都已真实扣合');
  assert.equal(r.stats.connectedComponents, 1, '修好后整机应为单一刚体');
});

test('实测优先：同一条目的实测接口不会与合成接口叠加（48336 只有 1 根杆段）', () => {
  // 旧实现里 barplate 的合成路径无视已存在的实测 bars，两者相加：
  // 48336 实测把柄 + 合成 2 根 = 多余接口，猜出来的位置却参与扣合。
  // 2026-11 起实测把柄是**杆段**（4-4cylo ±14 LDU，半长 0.7），所以是 1 条带跨度的杆，不是 2 个点。
  const d = cat.parts['48336'];
  assert.ok(Array.isArray(d.bars) && d.bars.length === 1, '48336 应继承扩展目录的 1 根实测杆段');
  const bars = partConnectors({ id: 'x', part: '48336', at: [0, 0, 0], rot: 0 }, d).studs.filter((s) => s.kind === 'bar');
  assert.equal(bars.length, 1, '只能有实测的 1 根杆段，不得再叠加合成把柄');
  assert.equal(bars[0].span, 0.7, '杆段必须带沿轴半长');
  assert.ok(bars[0].label.startsWith('extbar@'), '剩下的必须全部来自实测提取');
});

test('实物样本：机甲翼关节行程改为「向外张开」后，行程内不再撞进侧装甲', () => {
  // 旧声明 range [-35,35] 是双向摆动：向内那一侧会把夹板扫进侧装甲 p40/p44（机械上不可能）。
  // 真实结构是前掠/后掠双翼各自向外张开——前翼 −30..0、后翼 0..30（镜像）。
  // 这里同时钉住两点：① 行程内无碰撞；② 反向行程**确实会撞**（说明检查没有失效）。
  const m = JSON.parse(fs.readFileSync('examples/mecha.brick.json', 'utf8'));
  const r = validate(m, cat);
  assert.ok(!codes(r.errors).includes('mech-clearance'), `声明行程内不得碰撞，实际：${codes(r.errors).join(',')}`);
  assert.ok(codes(r.warnings).includes('mech-rigid'), '左右两翼各为独立刚体，共轴联动——这条拓扑事实必须继续报出');

  // 反向行程必须被拒：把前翼改成 0..30（向内摆）应立刻报 mech-clearance
  const flipped = JSON.parse(JSON.stringify(m));
  flipped.mechanisms.find((x) => x.id === 'wings_front').range = [0, 30];
  assert.ok(codes(validate(flipped, cat).errors).includes('mech-clearance'),
    '向内摆动必然扫进侧装甲，必须被拒（防止把检查改松）');
});
