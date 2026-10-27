// AS-06 SNOT 编码 0/1/2 语义验证（HANDOFF-C §3 C3-4 / PRD v2 AS-06，原 A 报告记 partial）。
//
// 用 snapPart 逐层搭建真实三层侧装链（3001 → 4733 → 3024 ×3，不手写坐标）：
//   ① snapPart 原生输出：snot 恒为 0、at 为绝对坐标（第二/三层是小数格）——
//      引擎原生表示是「分数 at」，不是「整数基准 at + snot 层号」；
//   ② 候选管线（enumerateCandidates）对第一层（侧凸点 kind=side）给出 snot:0，
//      与契约 snotLayerRule 的「第一层 = 0」一致；对外层叠放（kind=top，朝向 +z）
//      同样给出 snot:0 + 精确绝对坐标 —— 与契约文本「第二层 snot:1」存在**编码口径分歧**，
//      本测试如实记录（分歧不产生位置误差，两种编码世界几何逐位一致）；
//   ③ 契约编码（基准 at + snot 0/1/2）在引擎中成立：partCenter/partBoxes/连接器/
//      LDraw 行与「分数 at」编码逐位一致（≤1e-9），measureSnotChains 实测「逐层 −1」连通；
//   ④ 链整体 validate 0 errors / 0 warnings。
// 证据写入 out/prd-v2/run-20261026-c/C/engine/as06-snot-encoding.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapPart, partConnectors, partCenter, partBoxes, partsConnected, validate, ldrawLine,
} from '../src/core/core.js';
import { inspectFromModel } from '../src/core/actions-v1/state.js';
import { enumerateCandidates } from '../src/core/actions-v1/candidates.js';
import { measureSnotChains } from '../src/core/assembly-v1/compile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_OUT = path.join(ROOT, 'out', 'prd-v2', 'run-20261026-c', 'C', 'engine');
const cat = {
  parts: {
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts,
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts,
  },
  colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors,
};
const d3001 = cat.parts['3001'], d4733 = cat.parts['4733'], d3024 = cat.parts['3024'];

/** 用 snapPart 逐层搭建真实链：3001 → 4733（顶面）→ 3024（侧 +z 第 1 层）→ 3024 → 3024 */
function buildChain() {
  const base = { id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const sb = { ...snapPart(base, d3001, 0, { part: '4733', color: 15, rot: 0 }, d4733, 0), id: 'sb', step: 2 };
  const sideIdx = partConnectors(sb, d4733).studs.findIndex((s) => s.kind === 'side' && s.dir === '+z');
  assert.ok(sideIdx >= 0, '4733 必须有 +z 侧凸点');
  const mkPlate = (parent, pDef, studIdx) => ({ ...snapPart(parent, pDef, studIdx, { part: '3024', color: 0, rot: 0 }, d3024, 0) });
  const l1 = { ...mkPlate(sb, d4733, sideIdx), id: 'l1', step: 3 };
  const l2 = { ...mkPlate(l1, d3024, 0), id: 'l2', step: 4 };
  const l3 = { ...mkPlate(l2, d3024, 0), id: 'l3', step: 5 };
  return { base, sb, l1, l2, l3, sideIdx };
}

test('AS-06 ① snapPart 三层链：原生输出 snot=0 + 绝对 at（分数格），逐层外移 0.4 格且真实扣合', () => {
  const { base, sb, l1, l2, l3 } = buildChain();
  // 原生编码就是「分数 at」
  assert.equal(sb.snot, 0);
  assert.equal(l1.snot, 0);
  assert.equal(l2.snot, 0);
  assert.equal(l3.snot, 0);
  assert.equal(l1.up, '+z');
  assert.equal(l2.up, '+z');
  // 第一层贴 4733 的 +z 面：l1 盒 z0 = 4733 盒 z1（贴合不穿入）
  const sbBoxes = partBoxes(sb, d4733);
  const zFace = Math.max(...sbBoxes.map((b) => b.z1));
  const b1 = partBoxes(l1, d3024);
  assert.equal(Math.min(...b1.map((b) => b.z0)), zFace);
  // 逐层外移恰好 1 片 = 0.4 格
  assert.equal(Math.abs((partBoxes(l2, d3024)[0].z0) - (b1[0].z1)) < 1e-9, true);
  assert.equal(Math.abs((partBoxes(l3, d3024)[0].z0) - (partBoxes(l2, d3024)[0].z1)) < 1e-9, true);
  // 每层与父件真实扣合
  assert.equal(partsConnected(sb, d4733, l1, d3024), true, 'l1 必须扣在 4733 侧凸点上');
  assert.equal(partsConnected(l1, d3024, l2, d3024), true, 'l2 必须扣在 l1 外凸点上');
  assert.equal(partsConnected(l2, d3024, l3, d3024), true, 'l3 必须扣在 l2 外凸点上');
  // 链整体零错误
  const model = { format: 'brickbuild', version: '0.2', meta: { name: 'AS-06 snapPart 三层链' }, parts: [base, sb, l1, l2, l3] };
  const v = validate(model, cat);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
});

test('AS-06 ② 候选管线编码：第一层侧装 snot=0（契约一致）；外层叠放同为 snot=0 + 精确绝对坐标（记录与契约文本的口径分歧）', async () => {
  const { base, sb, sideIdx, l1 } = buildChain();
  const si1 = inspectFromModel({ format: 'brickbuild', version: '0.2', parts: [base, sb] }, cat, { mainRootNodeId: 'base' });
  const cr1 = enumerateCandidates(si1.state, { childPartId: '3024', parentNodeId: 'sb', maxResults: 200 }, cat);
  const side = cr1.items.filter((i) => i.parentConnectorType === 'side');
  assert.ok(side.length >= 4, `4733 四向侧凸点都应产生候选（实际 ${side.length}）`);
  const plusZ = side.filter((i) => i.parentConnectorId === `cside#${sideIdx}`);
  for (const c of plusZ) {
    assert.equal(c.snot, 0, '第一层侧装候选 snot 必须为 0（契约 snotLayerRule 第一层 = 0）');
    assert.equal(c.mateProfile, 'stud-antistud-v1');
  }

  // 第二层：在 l1 的外凸点（kind=top，dir=+z）上枚举 —— 引擎给 snot:0 + 精确绝对 at
  const si2 = inspectFromModel({ format: 'brickbuild', version: '0.2', parts: [base, sb, l1] }, cat, { mainRootNodeId: 'base' });
  const cr2 = enumerateCandidates(si2.state, { childPartId: '3024', parentNodeId: 'l1', maxResults: 200 }, cat);
  assert.equal(cr2.count, 4, 'l1 外凸点应产生 4 个自旋候选');
  for (const c of cr2.items) {
    assert.equal(c.parentConnectorType, 'top');
    assert.equal(c.features.studDir, '+z');
    assert.equal(c.snot, 0, '引擎原生口径：外层叠放候选 snot=0，位置全部由 translationLdu 精确表达');
  }
  // translationLdu（基准 at，LDU）必须是精确的分数层位置（z = 1.4 格 = 28 LDU）
  const l2At = cr2.items[0].translationLdu;
  assert.equal(l2At[2], 28, `第二层候选 z 基准应为 28 LDU（1.4 格），实际 ${l2At[2]}`);
});

test('AS-06 ③ 契约编码（基准 at + snot 0/1/2）与分数 at 编码几何逐位一致，measureSnotChains 实测逐层 −1', () => {
  const { base, sb, l1, l2, l3 } = buildChain();
  // 契约编码：所有侧装层用整数基准 at（z=1），层号 snot = 0/1/2
  const enc = (p, snot) => ({ ...p, at: [p.at[0], p.at[1], 1], snot });
  const c1 = enc(l1, 0), c2 = enc(l2, 1), c3 = enc(l3, 2);
  assert.ok(Number.isInteger(c1.at[2]) && Number.isInteger(c2.at[2]) && Number.isInteger(c3.at[2]));
  for (const [frac, contract, name] of [[l1, c1, 'l1'], [l2, c2, 'l2'], [l3, c3, 'l3']]) {
    const d = d3024;
    const cf = partCenter(frac, d), cc = partCenter(contract, d);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(cf[i] - cc[i]) < 1e-9, `${name} partCenter 分量 ${i} 不一致`);
    const bf = partBoxes(frac, d), bc = partBoxes(contract, d);
    assert.equal(JSON.stringify(bf), JSON.stringify(bc), `${name} partBoxes 不一致`);
    assert.deepEqual(
      JSON.stringify(partConnectors(frac, d)), JSON.stringify(partConnectors(contract, d)),
      `${name} 连接器不一致`,
    );
    assert.equal(ldrawLine(frac, d), ldrawLine(contract, d), `${name} LDraw 导出行不一致`);
  }
  // measureSnotChains：契约编码快照上逐层 −1 全部连通
  const snapshot = { format: 'brickbuild', version: '0.2', parts: [base, sb, c1, c2, c3] };
  const chains = measureSnotChains(snapshot, cat);
  assert.equal(chains.ok, true, `measureSnotChains 未通过：${JSON.stringify(chains.problems)}`);
  assert.deepEqual(chains.chains.map((x) => [x.node, x.snot, x.parent, x.parentSnot]).sort(),
    [['l2', 1, 'l1', 0], ['l3', 2, 'l2', 1]].sort());
  // 引擎对契约编码的接受度：validate 0/0（isSnotLike 覆盖 snot 偏移件）
  const v = validate(snapshot, cat);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);

  fs.mkdirSync(ENGINE_OUT, { recursive: true });
  fs.writeFileSync(path.join(ENGINE_OUT, 'as06-snot-encoding.json'), JSON.stringify({
    gate: 'AS-06', item: 'snot-encoding-0-1-2',
    fixture: 'snapPart 实建链 3001→4733→3024×3（无手写坐标）',
    engineNativeConvention: 'snapPart / 候选管线输出 snot=0 + 绝对 at；第二/三层为分数格坐标（LInner 精确 LDU 28/32），无位置误差',
    contractText: 'contracts-1.0 snotLayerRule：第一层侧装 snot:0，第二层 snot:1，逐层加 1（目录创作口径）',
    divergence: 'computeSnotLevel 仅对 kind=side 的挂点测层号：第一层侧装候选 = snot:0（与契约一致）；外层叠放（kind=top，dir=+z）候选 = snot:0 + 精确绝对坐标，而非 snot:1 基准编码。两种编码的世界几何/LDraw 导出逐位一致（≤1e-9），差异仅在编码口径，不产生穿模或错位',
    measureSnotChains: { ok: chains.ok, chains: chains.chains },
    fractionalAtNote: '轨迹工厂注记的 fractional-at 即本引擎原生表示；契约 0/1/2 为叠加语义（partCenter: up=+z → z = at[2] + snot*PLATE），两者在引擎内并存且等价',
    verdict: 'verified (encoding semantics + equivalence + divergence documented)',
  }, null, 2) + '\n');
});
