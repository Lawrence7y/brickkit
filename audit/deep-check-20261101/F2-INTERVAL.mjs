// F2-INTERVAL —— 轮对（rim↔tyre）真实安装区间实测，用来替代包围盒
//
// 目的：F2（轮胎沿轮轴平移 100 格仍判连通）要修，需要的是「真实安装区间」这个实测量，
// 而不是零件包围盒。本脚本从官方 .dat 网格量三样东西：
//   · 包围盒轴向跨度（bbox）        —— 能测，但不是安装区间
//   · 胎孔内壁轴向带（tyre inner）  —— 轮胎接收轮辋的那段壁
//   · 轮辋外缘轴向带（rim flange）  —— 轮辋真正被夹住的那段缘
// 安装区间 = 轮辋外缘带被胎孔内壁带**包住**的条件下，允许的轴向错位量（+ 匹配容差）。
//
// 只读生产源码。输出：本目录 F2-INTERVAL.json
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const core = await import(pathToFileURL(path.join(ROOT, 'src/core/core.js')).href);
const L = await import(pathToFileURL(path.join(ROOT, 'src/ldraw/loader.mjs')).href);

const ext = rd('catalog/parts-ldraw.json').parts;
const cur = rd('catalog/parts.json').parts;
const CAT = { parts: { ...ext, ...cur }, colors: rd('catalog/colors.json').colors };
const P = CAT.parts;
const resolve = L.createResolver();
const TOL = 0.08;   // 与 connectorPairMatches 的横向容差同一口径（格）

/** 把一个零件的面网格拆成三角形，并按定义量出轴向（默认 z）三条带 */
function bands(id) {
  const b = L.buildPart({ partId: id, color: 16, def: P[id], resolve });
  assert.ok(b, id + ' 必须有官方 .dat');
  assert.equal(b.stats.missingFiles, 0, id + ' 依赖缺失应为 0');
  const tris = [];
  for (const arr of Object.values(b.groups)) for (let i = 0; i < arr.length; i += 9) {
    tris.push([[arr[i], arr[i + 1], arr[i + 2]], [arr[i + 3], arr[i + 4], arr[i + 5]], [arr[i + 6], arr[i + 7], arr[i + 8]]]);
  }
  const w = P[id].wheel;
  const cy = (w.cy ?? 0) * core.PLATE;            // 轮心高度（格）
  const r = (v) => Math.hypot(v[0], v[1] - cy);   // 到轮轴的半径（轴向 = z）
  const zs = (list) => list.flat().map((v) => v[2]);
  const span = (list) => (list.length ? { z0: +Math.min(...zs(list)).toFixed(3), z1: +Math.max(...zs(list)).toFixed(3) } : null);
  const bbox = span(tris);
  const inner = span(tris.filter((t) => t.every((v) => r(v) <= w.bore + 0.07)));
  const flange = span(tris.filter((t) => t.every((v) => r(v) >= w.outer - 0.065)));
  return { id, role: w.role, outer: w.outer, bore: w.bore, cy: +cy.toFixed(3), bbox, inner, flange, tris: tris.length };
}

const rim = bands('11208');
const tyre = bands('11209');

// —— 安装区间：轮辋外缘带必须被胎孔内壁带包住 ——
const half = (s) => (s.z1 - s.z0) / 2;
const wTy = half(tyre.inner), wRim = half(rim.flange);
const slack = Math.max(0, wTy - wRim);            // 两带宽度差 → 允许的轴向错位（未计容差）
const installInterval = +(slack + TOL).toFixed(3);

/** 候选判据：在 partsConnected 之上补一条轴向包住约束（只在 wheel 对上生效） */
const wheelProblem = (a, defA, b, defB) => {
  const pair = [];
  for (const [x, dx, y, dy] of [[a, defA, b, defB], [b, defB, a, defA]]) {
    if (dx.wheel && dy.wheel && dx.wheel.role === 'rim' && dy.wheel.role === 'tyre') pair.push([x, dx, y, dy]);
  }
  if (!pair.length) return null;
  const [rimPart, rimDef, tyrePart, tyreDef] = pair[0];
  const rimPos = core.partConnectors(rimPart, rimDef).studs.find((s) => s.kind === 'rim');
  const tyrePos = core.partConnectors(tyrePart, tyreDef).receptors.find((s) => s.kind === 'tyre');
  if (!rimPos || !tyrePos) return 'no-wheel-connector';
  const dAxial = Math.abs(rimPos.pos[2] - tyrePos.pos[2]);
  return dAxial <= installInterval ? null : 'axial-out-of-range(' + dAxial.toFixed(3) + '>' + installInterval + ')';
};
const connectedWithRule = (a, defA, b, defB) => {
  if (!core.partsConnected(a, defA, b, defB)) return false;
  return wheelProblem(a, defA, b, defB) === null;
};

// —— 1. 实测表 ——
const measurement = { rim, tyre, installInterval, slack, tol: TOL, interference: +(rim.outer - tyre.bore).toFixed(3) };

// —— 2. 位姿网格：现有核心 vs 候选判据 ——
const rimPart = { id: 'p006', part: '11208', color: 71, at: [1, 1, 0], rot: 0, up: '+y', snot: 0, step: 45 };
const tyreBase = { id: 'p007', part: '11209', color: 0, up: '+y', rot: 0, snot: 0, step: 45, mount: 'p006' };
const grid = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 100].map((dz) => {
  const tyrePart = { ...tyreBase, at: [0.5, 0, dz], snap: { on: 'p006', stud: 0, receptor: 0, up: '+y' } };
  return {
    dz,
    currentCore: core.partsConnected(rimPart, P['11208'], tyrePart, P['11209']),
    withIntervalRule: connectedWithRule(rimPart, P['11208'], tyrePart, P['11209']),
  };
});
assert.equal(grid[0].currentCore, true, 'dz=0 合法装配：现有核心应判连通');
assert.equal(grid[0].withIntervalRule, true, 'dz=0 合法装配：候选判据也必须判连通（不能误伤）');
assert.equal(grid[0].dz, 0);
const bad = grid.filter((g) => g.dz > installInterval);
assert.ok(bad.every((g) => g.withIntervalRule === false), '凡超出安装区间的位姿都必须被候选判据拒绝');
assert.ok(grid.some((g) => g.dz > installInterval && g.currentCore === true), 'F2 仍应复现：现有核心放行超区间位姿');

// —— 3. 候选判据不能动 EN-05 的 95 条必需连接 ——
const model = rd('examples/60239.fixed.brick.json');
const byId = new Map(model.parts.map((p) => [p.id, p]));
const { inspectFromModel } = await import(pathToFileURL(path.join(ROOT, 'src/core/actions-v1/state.js')).href);
const si = inspectFromModel(model, CAT, {});
const keys = new Set();
for (const c of si.state.connections) { if (!c.aConnectorId) continue; keys.add([c.aNodeId, c.bNodeId].sort().join('|')); }
const pairs = [...keys].sort().map((k) => {
  const [a, b] = k.split('|').map((id) => byId.get(id));
  let child, parent;
  if (a.snap && a.snap.on === b.id) { child = a; parent = b; }
  else if (b.snap && b.snap.on === a.id) { child = b; parent = a; }
  else { child = a.id > b.id ? a : b; parent = a.id > b.id ? b : a; }
  return { key: k, parent, child };
});
const before = pairs.filter((pr) => core.partsConnected(pr.parent, P[pr.parent.part], pr.child, P[pr.child.part])).length;
const after = pairs.filter((pr) => connectedWithRule(pr.parent, P[pr.parent.part], pr.child, P[pr.child.part])).length;
assert.equal(pairs.length, 95, '必需连接应为 95');
assert.equal(before, 95, '现有核心 95/95');

// ★ 关键发现：这 95 条里混着 4 条「错位轮对」——rim(z=0) 配 tyre(z=5)，轴向相距 5 格。
// 它们不是合法装配，是 F2 缺陷被 inspectFromModel 当成连接后又写进夹具基线的产物。
// 所以任何合格的轴向判据都必然把 95 打成 91；91 才是物理上真实的必需连接数。
const dropped = pairs.filter((pr) => !connectedWithRule(pr.parent, P[pr.parent.part], pr.child, P[pr.child.part]) && core.partsConnected(pr.parent, P[pr.parent.part], pr.child, P[pr.child.part]));
const droppedDetail = dropped.map((pr) => {
  const rimA = core.partConnectors(pr.parent, P[pr.parent.part]).studs.find((s) => s.kind === 'rim');
  const tyreA = core.partConnectors(pr.parent, P[pr.parent.part]).receptors.find((s) => s.kind === 'tyre');
  const rimB = core.partConnectors(pr.child, P[pr.child.part]).studs.find((s) => s.kind === 'rim');
  const tyreB = core.partConnectors(pr.child, P[pr.child.part]).receptors.find((s) => s.kind === 'tyre');
  const rimPos = rimA || rimB, tyrePos = tyreA || tyreB;
  return { pair: pr.key, parts: pr.parent.part + '/' + pr.child.part, dAxial: +(Math.abs(rimPos.pos[2] - tyrePos.pos[2])).toFixed(3),
    note: 'rim 的 at.z=' + pr.parent.at[2] + ' 与 tyre 的 at.z=' + pr.child.at[2] + ' 不是同一个轮位' };
});
assert.equal(after, 91, '候选判据下应为 91（4 条错位轮对必须被拒），实得 ' + after);
assert.equal(dropped.length, 4, '应恰好丢掉 4 条，实得 ' + dropped.length);
assert.ok(droppedDetail.every((d) => d.dAxial > installInterval), '被丢掉的必须是超出安装区间的位姿');
// 真正合法的 4 对轮装（同一轮位）必须还在
const legalWheels = pairs.filter((pr) => {
  const rimA = core.partConnectors(pr.parent, P[pr.parent.part]).studs.find((s) => s.kind === 'rim');
  const tyreA = core.partConnectors(pr.parent, P[pr.parent.part]).receptors.find((s) => s.kind === 'tyre');
  const rimB = core.partConnectors(pr.child, P[pr.child.part]).studs.find((s) => s.kind === 'rim');
  const tyreB = core.partConnectors(pr.child, P[pr.child.part]).receptors.find((s) => s.kind === 'tyre');
  if (!((rimA && tyreB) || (rimB && tyreA))) return false;
  const rimPos = rimA || rimB, tyrePos = tyreA || tyreB;
  return Math.abs(rimPos.pos[2] - tyrePos.pos[2]) <= installInterval;
});
assert.equal(legalWheels.length, 4, '同一轮位的合法轮对应为 4，实得 ' + legalWheels.length);
assert.ok(legalWheels.every((pr) => connectedWithRule(pr.parent, P[pr.parent.part], pr.child, P[pr.child.part])), '合法轮对不得被误伤');

// —— 4. bbox 与安装区间不是一回事：取样若干轮胎，比 bbox 宽 vs 胎孔带宽 ——
const tyreIds = ['11209', '50861', '6579', '55976', '18977', '3483'];
const bboxVsBand = tyreIds.map((id) => {
  try {
    const t = bands(id);
    return { id, role: t.role, bboxWidth: +(t.bbox.z1 - t.bbox.z0).toFixed(3), innerWidth: t.inner ? +(t.inner.z1 - t.inner.z0).toFixed(3) : null };
  } catch (e) { return { id, error: String(e.message || e).slice(0, 80) }; }
});

const report = {
  startedAt: new Date().toISOString(),
  model: 'examples/60239.fixed.brick.json',
  measurement, grid,
  pairs: { required: pairs.length, before, after, dropped: droppedDetail, legalWheels: legalWheels.length }, bboxVsBand,
  schemaProposal: {
    'wheel.axialBand': '[z0, z1] 相对轮心连接器的轴向区间（格），由官方网格实测',
    'wheel.axialRole': "'bore-band'（轮胎内壁带）| 'flange-band'（轮辋外缘带）",
    rule: 'rim↔tyre 成立 ⟺ 同心 + 径向匹配 + |Δ轴向| ≤ max(0, halfWidth(tyre.bore-band) − halfWidth(rim.flange-band)) + 0.08',
  },
};
fs.writeFileSync(path.join(HERE, 'F2-INTERVAL.json'), JSON.stringify(report, null, 1));

console.log('轮辋 11208: bbox', JSON.stringify(rim.bbox), '外缘带', JSON.stringify(rim.flange), 'outer', rim.outer);
console.log('轮胎 11209: bbox', JSON.stringify(tyre.bbox), '胎孔带', JSON.stringify(tyre.inner), 'bore', tyre.bore);
console.log('安装区间 |Δ轴向| ≤', installInterval, '(带宽差', slack, '+ 容差', TOL, ')，径向过盈', measurement.interference);
console.log('位姿网格:', grid.map((g) => 'dz=' + g.dz + ':' + (g.currentCore ? 'T' : 'F') + '/' + (g.withIntervalRule ? 'T' : 'F')).join(' '));
console.log('EN-05 必需连接:', before, '→', after, '/', pairs.length);
console.log('bbox vs 胎孔带:', bboxVsBand.map((r) => r.id + ' ' + r.bboxWidth + '/' + r.innerWidth).join('  '));
console.log('F2 安装区间实测完成 → audit/deep-check-20261101/F2-INTERVAL.json');
