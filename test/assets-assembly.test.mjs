// A 责任域回归测试：Part Asset v1（ST）、关系装配 0.3 编译（AS）、动作事务（EN）、
// 三个 PRD §3.3 反例的冻结回归（EN-01/EN-02/AS-04）。
//
// 命名与前缀：
//   [ST-xx] 零件素材存储
//   [AS-xx] 关系装配
//   [EN-xx] 引擎与动作
//   [CP-xx] 兼容编译
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validate, recompute, findMounts, partConnectors, partsConnected, partBoxes, partsCollide, snapPart, partCenter, boxesCollide,
} from '../src/core/core.js';
import {
  ORIENTATIONS, getOrientation, applyOrientation, composeOrientation, invertOrientation,
  mateOrientation, orientationIdOf,
} from '../src/core/actions-v1/pose.js';
import {
  buildIndex, buildDefinition, deriveCapabilities, applyOverrides, connectorIdMap,
  expandConnectorGroups, connectorCountOf, contentHashOf, DEFAULT_PROFILE, sourceToCanonical,
  readRawCatalog, readDatIndex,
} from '../src/core/assets-v1/index.js';
import {
  gridToLdu, lduToGrid, makeConnectorId, connectorTypeOf, dirToOrientationId,
} from '../src/core/assets-v1/ids.js';
import * as asmMod from '../src/core/assembly-v1/compile.js';
import {
  checkContainment, topoSortPlacements, expandNodes, compileToLegacy, validateAssembly,
} from '../src/core/assembly-v1/compile.js';
import * as lockMod from '../src/core/assets-v1/lock.js';
import { inspectFromModel, stateHashOf } from '../src/core/actions-v1/state.js';
import { enumerateCandidates } from '../src/core/actions-v1/candidates.js';
import { applyActions } from '../src/core/actions-v1/apply.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const curated = readJSON('catalog/parts.json');
const ext = readJSON('catalog/parts-ldraw.json');
const cat = { parts: { ...ext.parts, ...curated.parts }, colors: readJSON('catalog/colors.json').colors };

// 资产索引构建很贵（约 4~5 s），全文件共用一次
let BUILT = null;
const built = () => {
  if (!BUILT) BUILT = buildIndex(ROOT, { recordedAt: '2026-10-26T00:00:00.000Z' });
  return BUILT;
};

// ---------------------------------------------------------------- ST：资产存储

test('[ST-05] LDU 换算：1 格 = 20 LDU、1 片 = 8 LDU，格/片/LDU 往返无漂移', () => {
  assert.deepEqual(gridToLdu([1, 2, 3]), [20, 16, 60]);
  assert.deepEqual(gridToLdu([0.5, -1.5, -2]), [10, -12, -40]);
  for (const g of [[0, 0, 0], [4, 3, -2], [-1.5, 0.25, 7]]) {
    assert.deepEqual(lduToGrid(gridToLdu(g)), g.map((v) => Math.round(v * 1e6) / 1e6 || 0));
  }
});

test('[ST-05] 规范空间基变换：LDraw→BrickKit 是纯旋转（det=+1），不是镜像', () => {
  const m = sourceToCanonical(cat.parts['3001']);
  assert.equal(m.determinant, 1);
  const [[a, b, c], [d, e, f], [g, h, i]] = m.matrix;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  assert.ok(Math.abs(det - 1) < 1e-12, `实际行列式 ${det} 应为 +1`);
  // 正交性
  const cols = [[a, d, g], [b, e, h], [c, f, i]];
  for (let i2 = 0; i2 < 3; i2++) for (let j = 0; j < 3; j++) {
    const dot = cols[0][i2] * cols[0][j] + cols[1][i2] * cols[1][j] + cols[2][i2] * cols[2][j];
    assert.ok(Math.abs(dot - (i2 === j ? 1 : 0)) < 1e-12);
  }
});

test('[ST-02] 能力三分离：render/collide/assemble 各自独立判定，一个 checked 不代表三者', () => {
  const def = cat.parts['3001'];
  const withDat = deriveCapabilities(def, { hasDat: true, connectorCount: 17, connectorTypes: ['stud', 'antistud'] });
  assert.equal(withDat.render.state, 'measured');
  assert.equal(withDat.render.geometryKind, 'ldraw-mesh');
  assert.equal(withDat.assemble.state, 'measured');   // 有连接器但没跑夹具 → measured，不是 verified

  const noConn = deriveCapabilities(def, { hasDat: true, connectorCount: 0 });
  assert.equal(noConn.assemble.state, 'unsupported', '无连接器必须显式 unsupported，不能当作可装配');

  const noDat = deriveCapabilities(def, { hasDat: false, connectorCount: 5 });
  assert.equal(noDat.render.state, 'inferred');
  assert.equal(noDat.render.geometryKind, 'parametric');

  // bracket 缺 vH/dir：碰撞必须 unsupported（partBoxes 会拒绝）
  const badBracket = { kind: 'bracket', size: [2, 1], h: 3, category: 'bracket' };
  const bc = deriveCapabilities(badBracket, { hasDat: true, connectorCount: 2 });
  assert.equal(bc.collide.state, 'unsupported');
});

test('[ST-03] 稳定接口 ID：由语义位置生成，与数组下标无关；同位置重复接口确定加后缀', () => {
  const a = makeConnectorId('stud', [10, 24, 10]);
  const b = makeConnectorId('stud', [10, 24, 10]);
  assert.equal(a, b, '同语义位置必须得到同一 ID');
  assert.notEqual(a, makeConnectorId('stud', [10, 24, 30]));
  assert.notEqual(makeConnectorId('stud', [-10, 0, 0]), makeConnectorId('stud', [10, 0, 0]), '负号必须可区分');

  const d = buildDefinition('3001', cat.parts['3001'], { sourceType: 'curated' });
  const expanded = expandConnectorGroups(d);
  const ids = expanded.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, '同零件上接口 ID 必须唯一');
  assert.equal(expanded.length, connectorCountOf(d), '展开数量必须等于索引里的 connectorCount');

  // 重排分组内的 items 不得改变任何 ID 集合
  const shuffled = JSON.parse(JSON.stringify(d));
  for (const g of shuffled.connectorGroups) g.items.reverse();
  shuffled.connectorGroups.reverse();
  const ids2 = expandConnectorGroups(shuffled).map((c) => c.id).sort();
  assert.deepEqual(ids2, ids.slice().sort(), '重排后 ID 集合必须完全一致');
});

test('[ST-03] 旧 stud/receptor 数字索引通过 legacyIndex 固定映射回同一物理接口', () => {
  const d = buildDefinition('3001', cat.parts['3001'], { sourceType: 'curated' });
  const map = connectorIdMap(d, cat.parts['3001']);
  assert.deepEqual(map.problems, [], `接口映射不应有漂移：${map.problems.join('; ')}`);
  for (const [id, li] of map.idToLegacy) {
    assert.deepEqual(map.legacyToId.get(`${li.collection}:${li.index}`), id, `legacyIndex ${li.collection}[${li.index}] 必须回指 ${id}`);
  }
  assert.ok(map.byId.size > 0);
});

test('[ST-01] 资产索引：同一输入重建得到相同 contentHash（可重现）；源哈希参与内容哈希', () => {
  const b1 = built();
  assert.equal(b1.stats.parts, 4605, '合并目录条数应为 4605');
  const dIdx = b1.definitions.get('3001');

  // 同一构造参数（含源哈希与 .dat 信息）重复构建 → contentHash 必须稳定，且不受 recordedAt 影响
  const raw = readRawCatalog(ROOT);
  const datIndex = readDatIndex(ROOT);
  const mk = (recordedAt) => buildDefinition('3001', raw.merged['3001'].def, {
    sourceType: 'curated', sourceHashes: raw.sourceHashes, datInfo: datIndex['3001'] || null, recordedAt,
  });
  const a = mk('2026-10-26T00:00:00.000Z');
  const b = mk('2030-01-01T00:00:00.000Z');
  assert.equal(a.contentHash, b.contentHash, 'contentHash 不得包含 recordedAt 等易变字段');
  assert.equal(dIdx.contentHash, a.contentHash, '索引里的 3001 必须与同参数重建结果一致');

  // 源哈希必须参与内容哈希：换了 sourceHashes 就应得到不同 contentHash（缓存失效依据）
  const tampered = buildDefinition('3001', raw.merged['3001'].def, {
    sourceType: 'curated', datInfo: datIndex['3001'] || null,
    sourceHashes: { ...raw.sourceHashes, curated: { ...raw.sourceHashes.curated, sha256: 'f'.repeat(64) } },
    recordedAt: '2026-10-26T00:00:00.000Z',
  });
  assert.notEqual(a.contentHash, tampered.contentHash, '源文件哈希变化必须改变 contentHash（缓存自动失效）');
});

test('[ST-01] 覆盖层：baseRevision 不匹配时拒绝；字段不在白名单时拒绝；应用后 revision 变化', () => {
  const d = buildDefinition('3001', cat.parts['3001'], { sourceType: 'curated' });
  const good = {
    partId: '3001', baseRevision: d.revision, fields: { capabilities: d.capabilities },
    reason: '夹具：确认覆盖可应用', author: 'test', recordedAt: '2026-10-26T00:00:00.000Z',
  };
  const ok = applyOverrides(d, [good]);
  assert.equal(ok.rejected.length, 0);
  assert.notEqual(ok.definition.revision, d.revision, '应用覆盖必须提升 revision');
  assert.equal(ok.definition.overrides.length, 1);

  const stale = applyOverrides(d, [{ ...good, baseRevision: 'r0-stale' }]);
  assert.equal(stale.applied.length, 0);
  assert.match(stale.rejected[0].reason, /baseRevision 不匹配/);

  const forbidden = applyOverrides(d, [{ ...good, fields: { partId: '9999' } }]);
  assert.match(forbidden.rejected[0].reason, /不允许被覆盖/);
});

test('[ST-04] 按需：索引体积远小于全库定义总和；单件加载只读一个文件', () => {
  const b = built();
  const indexBytes = Buffer.byteLength(JSON.stringify(b.index));
  let defBytes = 0;
  for (const d of b.definitions.values()) defBytes += Buffer.byteLength(JSON.stringify(d));
  assert.ok(indexBytes < defBytes / 2, `索引 ${indexBytes} 应显著小于定义总和 ${defBytes}`);

  // 单件定义必须自带完整连接器信息，无需加载其它零件
  const one = JSON.parse(JSON.stringify(b.definitions.get('3010')));
  assert.ok(connectorCountOf(one) > 0);
  assert.ok(one.canonicalFrame.units === 'LDU');
});

// ---------------------------------------------------------------- AS：24 姿态

test('[AS-02] 24 姿态表：互不重复、正交归一、行列式全为 +1、id 0 为恒等', async () => {
  const mod = await import('../src/core/actions-v1/orientations.js');
  const check = mod.selfCheck();
  assert.equal(check.ok, true, check.problems.join('; '));
  assert.equal(check.count, 24);
  assert.equal(check.distinct, 24);
  assert.equal(ORIENTATIONS[0].orientationId, 0);
  assert.deepEqual(ORIENTATIONS[0].matrix, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  for (const o of ORIENTATIONS) assert.equal(o.determinant, 1, `姿态 ${o.orientationId} det 必须 +1`);
});

test('[AS-02] 姿态代数：compose/invert 自洽，mate 能把手性正确的姿态算出来', () => {
  for (const id of [0, 5, 8, 13, 22]) {
    const inv = invertOrientation(id);
    assert.equal(composeOrientation(id, inv), 0, `姿态 ${id} 与其逆复合应为恒等`);
  }
  // 父件接口朝 +y、子件接口朝 +z：子件需要让它的接口轴与父件 +y 对合。
  // mateOrientation 返回的是「子件整体需要的姿态」，其 uy 是子件本体 +y 轴经该姿态后的世界方向。
  // 子件接口原本朝 +z，要让接口与父件 +y 同轴反向对合，子件本体 +y 必须转到 -z。
  const m = mateOrientation(0, 8, 0);
  assert.notEqual(m, null);
  const o = getOrientation(m);
  assert.deepEqual(o.deltas.uy, [0, 0, -1], '子件本体 +y 应转到 -z，使接口轴与父件 +y 对合');
  // 反向校验：子件接口朝 -z 时应得到 +z
  const m2 = mateOrientation(0, 12, 0);
  assert.deepEqual(getOrientation(m2).deltas.uy, [0, 0, 1]);
  // 非法 orientationId 必须抛错，不得静默回退
  assert.throws(() => getOrientation(99), /不在 24 姿态表/);
});

test('[AS-02] 姿态矩阵作用于 LDU 向量保持长度（真旋转，不是缩放/镜像）', () => {
  const v = [20, 16, -60];
  const len = Math.hypot(...v);
  for (const o of ORIENTATIONS) {
    const w = applyOrientation(o.orientationId, v);
    assert.ok(Math.abs(Math.hypot(...w) - len) < 1e-6, `姿态 ${o.orientationId} 改变了向量长度`);
  }
});

// ---------------------------------------------------------------- AS：关系装配

const FIX = (n) => readJSON(`docs/prd-v2/implementation-A/contracts/fixtures/${n}`);

const assetIndex = readJSON('catalog/assets-v1/index.json');

test('[ST-01] 资产锁：空串哈希 / 缺 revision / 缺件 / 内容不符 一律拒绝，不降级为 warning', () => {
  const { checkAssetLock, buildAssetLock } = lockMod;
  const src = FIX('assembly-minimal.assembly.brick.json');
  const good = buildAssetLock(assetIndex, ['3001', '3020'], src.assetLock.profileId);
  assert.deepEqual(good.missing, []);

  // 正例：真实内容哈希闭包应通过
  const okRes = checkAssetLock({ ...src, assetLock: good.assetLock }, { index: assetIndex, requiredPartIds: ['3001', '3020'] });
  assert.equal(okRes.ok, true, okRes.errors.map((e) => e.code).join(','));
  assert.equal(okRes.verifiedCount, 2);
  assert.match(okRes.lockHash, /^[0-9a-f]{64}$/);

  // 负例 1：contentHash 为空串（最常见的「假装锁住了」）
  const emptyHash = JSON.parse(JSON.stringify(good.assetLock));
  emptyHash.parts[0].contentHash = '';
  const r1 = checkAssetLock({ assetLock: emptyHash }, { index: assetIndex, requiredPartIds: ['3001', '3020'] });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.code === 'asset-lock-hash-missing'));

  // 负例 2：缺 revision
  const noRev = JSON.parse(JSON.stringify(good.assetLock));
  delete noRev.parts[0].revision;
  const r2 = checkAssetLock({ assetLock: noRev }, { index: assetIndex });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.code === 'asset-lock-revision-missing'));

  // 负例 3：内容哈希与索引不符（被改过的定义）
  const wrongHash = JSON.parse(JSON.stringify(good.assetLock));
  wrongHash.parts[0].contentHash = '0'.repeat(64);
  const r3 = checkAssetLock({ assetLock: wrongHash }, { index: assetIndex });
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => e.code === 'asset-lock-hash-mismatch'));

  // 负例 4：任务实际用到的件没进锁
  const r4 = checkAssetLock({ assetLock: good.assetLock }, { index: assetIndex, requiredPartIds: ['3001', '3020', '3024'] });
  assert.equal(r4.ok, false);
  assert.ok(r4.errors.some((e) => e.code === 'asset-lock-incomplete'));

  // 负例 5：空锁等于没锁
  const r5 = checkAssetLock({ assetLock: { profileId: 'p', parts: [] } }, { index: assetIndex });
  assert.equal(r5.ok, false);
  assert.ok(r5.errors.some((e) => e.code === 'asset-lock-empty'));

  // 负例 6：完全缺锁
  const r6 = checkAssetLock({}, { index: assetIndex });
  assert.equal(r6.ok, false);
  assert.equal(r6.errors[0].code, 'asset-lock-missing');

  // 负例 7：非法哈希格式（不是 64 位小写十六进制）
  const badFormat = JSON.parse(JSON.stringify(good.assetLock));
  badFormat.parts[0].contentHash = 'not-a-hash';
  const r7 = checkAssetLock({ assetLock: badFormat }, { index: assetIndex });
  assert.equal(r7.ok, false);
  assert.ok(r7.errors.some((e) => e.code === 'asset-lock-hash-invalid'));
});

test('[ST-01] 资产锁：同一 lock 解析结果确定（lockHash 可复现），改任一字段即变化', () => {
  const { checkAssetLock, buildAssetLock } = lockMod;
  const a = buildAssetLock(assetIndex, ['3001', '3020'], 'default-2026-10-26');
  const b = buildAssetLock(assetIndex, ['3020', '3001'], 'default-2026-10-26');   // 顺序不同
  const ra = checkAssetLock({ assetLock: a.assetLock }, { index: assetIndex });
  const rb = checkAssetLock({ assetLock: b.assetLock }, { index: assetIndex });
  assert.equal(ra.lockHash, rb.lockHash, '件号顺序不应影响 lockHash');

  const c = buildAssetLock(assetIndex, ['3001', '3024'], 'default-2026-10-26');
  const rc = checkAssetLock({ assetLock: c.assetLock }, { index: assetIndex });
  assert.notEqual(ra.lockHash, rc.lockHash, '换件号必须改变 lockHash');

  const d = buildAssetLock(assetIndex, ['3001', '3020'], 'other-profile');
  const rd = checkAssetLock({ assetLock: d.assetLock }, { index: assetIndex });
  assert.notEqual(ra.lockHash, rd.lockHash, '换 profile 必须改变 lockHash');
});

test('[ST-01] 资产锁：索引不可用时不得声称通过，ST-01 记 unknown 而不是 verified', () => {
  const src = FIX('assembly-minimal.assembly.brick.json');
  const r = validateAssembly(src, cat, { assetIndex: null, assetsDir: '/nonexistent-dir', requireAssetIndex: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'asset-lock-index-unavailable'));
  assert.equal(r.tests.find((t) => t.id === 'ST-01').status, 'failed');

  // 降级模式：允许跑几何校验，但 ST-01 必须标 unknown，不能标 verified
  const r2 = validateAssembly(src, cat, { assetIndex: null, assetsDir: '/nonexistent-dir', requireAssetIndex: false });
  assert.equal(r2.tests.find((t) => t.id === 'ST-01').status, 'unknown');
  assert.notEqual(r2.tests.find((t) => t.id === 'ST-01').status, 'verified');
});

test('[AS-06] SNOT 链实测：snot 链断裂必须被检出，逐层 −1 才记 verified', () => {
  const src = FIX('assembly-minimal.assembly.brick.json');
  const good = validateAssembly(src, cat, { index: assetIndex });
  const snotTest = good.tests.find((t) => t.id === 'AS-06');
  // 最小夹具是纯堆叠，没有 SNOT 链 → 不得声称 verified
  assert.notEqual(snotTest.status, 'verified', '没有 SNOT 链时不得声称 AS-06 通过');
  assert.match(snotTest.note, /无|没有|未/);

  // 构造一条真实的三层侧装链并编译，人工把中间层 snot 改错，measureSnotChains 必须报断裂
  const { measureSnotChains } = asmMod;
  const model = {
    format: 'brickbuild', version: '0.2',
    parts: [
      { id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
      { id: 'sb', part: '4733', color: 15, at: [1, 3, 1], rot: 0, up: '+y', snot: 0, step: 2 },
      { id: 'l1', part: '3024', color: 0, at: [1, 3.5, 2], rot: 0, up: '+z', snot: 0, step: 3 },
      { id: 'l2', part: '3024', color: 0, at: [1, 3.5, 2.4], rot: 0, up: '+z', snot: 0, step: 4 },
    ],
  };
  const chainOk = measureSnotChains(model, cat);
  // 全 snot=0 时没有分层链可测 → ok=false 且说明原因（「没测到」不是「测过了」）
  assert.equal(chainOk.ok, false);
  assert.match(chainOk.note, /snot 全为 0|没有分层链/);

  // 按真实分层写法：at 基准不变，snot 递增
  const layered = JSON.parse(JSON.stringify(model));
  layered.parts[3].at = [1, 3.5, 2];
  layered.parts[3].snot = 1;
  const chainLayered = measureSnotChains(layered, cat);
  assert.equal(chainLayered.ok, true, `分层链应通过：${chainLayered.note}`);
  assert.equal(chainLayered.chains.length, 1);
  assert.equal(chainLayered.chains[0].parentSnot, 0);

  // 跳号：snot=2 但找不到 snot=1 的上一件 → 断裂
  const jumped = JSON.parse(JSON.stringify(layered));
  jumped.parts[3].snot = 2;
  const chainJumped = measureSnotChains(jumped, cat);
  assert.equal(chainJumped.ok, false, 'snot 跳号必须报断裂');
  assert.ok(chainJumped.problems.length > 0);
});


test('[AS-04] 最小 0.3 夹具：图合法、编译到 0.2 后 core 校验通过、零新增件总装步保留', () => {
  const src = FIX('assembly-minimal.assembly.brick.json');
  const r = validateAssembly(src, cat);
  assert.equal(r.ok, true, r.errors.map((e) => `${e.code}: ${e.msg}`).join('; '));
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.compiledParts, 2);

  const c = compileToLegacy(src, cat);
  assert.equal(c.ok, true);
  assert.equal(c.snapshot.parts.length, 2);
  assert.equal(c.snapshot.parts[0].at[0], 0);
  assert.equal(c.snapshot.parts[1].at[1], 3, '3020 应扣在 3001 顶上（3 片）');
  // 零新增件总装步必须存在
  const final = c.snapshot.steps.find((s) => s.n === 3);
  assert.ok(final, '第 3 步（零新增件总装步）必须保留');
  assert.match(final.note, /本步无新增件/);
  // 丢失项必须显式声明，不能静默丢弃
  assert.ok(c.losses.length > 0, '编译到 0.2 必须有 losses 声明');
});

test('[AS-04] 非法定位图必须报错：环 / 双重定位 / 缺引用 / 递归模板 / 缺件', () => {
  const cases = [
    ['negative-placement-cycle.assembly.brick.json', 'placement-cycle'],
    ['negative-double-placement.assembly.brick.json', 'double-placement'],
    ['negative-missing-reference.assembly.brick.json', 'missing-reference'],
    ['negative-recursive-template.assembly.brick.json', 'recursive-template'],
    ['negative-missing-asset.assembly.brick.json', 'missing-asset', 'asset-lock-incomplete'],
    ['negative-unknown-connector.assembly.brick.json', 'unknown-connector'],
    ['negative-inventory-double-consume.assembly.brick.json', 'inventory-double-consume'],
  ];
  for (const [file, code, altCode] of cases) {
    const r = validateAssembly(FIX(file), cat);
    assert.equal(r.ok, false, `${file} 必须失败`);
    const codes = r.errors.map((e) => e.code);
    // altCode 用于「同一非法图有多个都正确的拒绝理由」：
    // 例如目录外件号 999999 既触发 missing-asset，也触发更严格的 asset-lock-incomplete。
    assert.ok(codes.includes(code) || (altCode && codes.includes(altCode)),
      `${file} 应报 ${code}${altCode ? ` 或 ${altCode}` : ''}，实际 ${codes.join(',')}`);
    // 失败时不产出半成品快照
    const c = compileToLegacy(FIX(file), cat);
    assert.equal(c.ok, false, `${file} 编译必须失败`);
    assert.equal(c.snapshot, null, `${file} 编译失败时不得有快照`);
  }
});

test('[AS-03] 嵌套组件 + 刚性挂装：组件实例复用，位姿一次性求解，不依赖迭代补丁次序', () => {
  const src = FIX('positive-component-instance.assembly.brick.json');
  const r = validateAssembly(src, cat);
  assert.equal(r.ok, true, r.errors.map((e) => `${e.code}: ${e.msg}`).join('; '));
  const c = compileToLegacy(src, cat);
  assert.equal(c.ok, true);
  const byId = new Map(c.snapshot.parts.map((p) => [p.id, p]));
  assert.ok(byId.has('car/b1'));
  assert.ok(byId.has('car/b2'));
  assert.ok(byId.has('car/hat/p1'));
  // 组件实例路径必须出现在节点路径里（稳定路径，不依赖数组位置）
  assert.match(byId.get('car/hat/p1').id, /^car\/hat\//);
});

test('[AS-04] 定位 DAG 拓扑排序：给出的顺序里父节点必先于子节点', () => {
  const src = FIX('positive-component-instance.assembly.brick.json');
  const nodes = expandNodes(src).nodes.map((n) => n.nodePath);
  const dag = topoSortPlacements(src, nodes);
  assert.equal(dag.ok, true);
  const pos = new Map(dag.order.map((id, i) => [id, i]));
  for (const p of src.placements) {
    if (p.kind === 'root') continue;
    assert.ok(pos.get(p.parentNodeId) < pos.get(p.nodeId),
      `父 ${p.parentNodeId} 必须排在子 ${p.nodeId} 之前`);
  }
});

// ---------------------------------------------------------------- EN：三个反例冻结回归

test('[EN-01] fake-group 反例：远处散件声明进子组件后，strictAssembly 必须失败', () => {
  const mk = (strict) => ({
    format: 'brickbuild', version: '0.2',
    meta: { name: 'fake-group', ...(strict ? { strictAssembly: true } : {}) },
    parts: [
      { id: 'base', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
      { id: 'a1', part: '3001', color: 0, at: [0, 3, 0], rot: 0, up: '+y', snot: 0, step: 2, module: 'g1', subassembly: 'g1', subassemblyAnchor: 'a1' },
      { id: 'a2', part: '3001', color: 0, at: [0, 6, 0], rot: 0, up: '+y', snot: 0, step: 3, module: 'g1', subassembly: 'g1', subassemblyAnchor: 'a1' },
      { id: 'far', part: '3001', color: 0, at: [20, 0, 0], rot: 0, up: '+y', snot: 0, step: 3, module: 'g1', subassembly: 'g1', subassemblyAnchor: 'a1' },
    ],
    modules: [{ id: 'g1', label: '伪组', subassembly: true }],
    steps: [{ n: 1, title: 's1' }, { n: 2, title: 's2' }, { n: 3, title: 's3' }, { n: 4, title: '装 g1', attach: 'g1' }],
  });
  for (const strict of [false, true]) {
    const r = validate(mk(strict), cat);
    assert.equal(r.ok, false, `strict=${strict} 时伪组必须被拒绝`);
    const codes = r.errors.map((e) => e.code);
    assert.ok(codes.includes('subassembly-disconnected'), `应报 subassembly-disconnected，实际 ${codes.join(',')}`);
    assert.ok(r.errors.some((e) => e.parts?.includes('far')), '错误必须点名 far');
  }
});

test('[EN-01] 真实连通子组件仍然通过（修复不能误伤合法刚体）', () => {
  const model = {
    format: 'brickbuild', version: '0.2', meta: { name: 'real-group', strictAssembly: true },
    parts: [
      { id: 'base', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
      { id: 'a1', part: '3001', color: 0, at: [0, 3, 0], rot: 0, up: '+y', snot: 0, step: 2, module: 'g1', subassembly: 'g1', subassemblyAnchor: 'a1' },
      { id: 'a2', part: '3001', color: 0, at: [0, 6, 0], rot: 0, up: '+y', snot: 0, step: 3, module: 'g1', subassembly: 'g1', subassemblyAnchor: 'a1' },
    ],
    modules: [{ id: 'g1', label: '真组', subassembly: true }],
    steps: [{ n: 1, title: 's1' }, { n: 2, title: 's2' }, { n: 3, title: 's3' }, { n: 4, title: '装 g1', attach: 'g1' }],
  };
  const r = validate(model, cat);
  assert.equal(r.ok, true, r.errors.map((e) => `${e.code}: ${e.msg}`).join('; '));
  assert.equal(r.stats.connectedComponents, 1);
});

test('[AS-04] snap 环反例：recompute 必须抛 snap-cycle，不得静默保留旧坐标', () => {
  const model = {
    format: 'brickbuild', version: '0.2',
    parts: [
      { id: 'p1', part: '3001', color: 0, at: [0, 0, 0], rootAt: [0, 0, 0], step: 1, snap: { on: 'p2', stud: 0, receptor: 0 } },
      { id: 'p2', part: '3001', color: 0, at: [0, 3, 0], rootAt: [0, 3, 0], step: 1, snap: { on: 'p1', stud: 0, receptor: 0 } },
    ],
  };
  const before = JSON.stringify(model.parts.map((p) => p.at));
  assert.throws(() => recompute(model, cat), /snap 定位依赖存在环|snap-cycle/);
  assert.equal(JSON.stringify(model.parts.map((p) => p.at)), before, '抛错后模型必须保持调用前状态（原子性）');
});

test('[AS-04] snap 缺引用必须抛错', () => {
  const model = {
    format: 'brickbuild', version: '0.2',
    parts: [{ id: 'p1', part: '3001', color: 0, at: [0, 0, 0], step: 1, snap: { on: 'ghost', stud: 0, receptor: 0 } }],
  };
  assert.throws(() => recompute(model, cat), /不存在的零件 ghost/);
});

test('[EN-02] 父件碰撞反例：以上片为锚点挂两片板时，合法候选必须为 0', () => {
  const main = { format: 'brickbuild', version: '0.2', parts: [{ id: 'base', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const sub = {
    format: 'brickbuild', version: '0.2',
    parts: [
      { id: 'low', part: '3020', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
      { id: 'up', part: '3020', color: 0, at: [0, 1, 0], rot: 0, up: '+y', snot: 0, step: 2 },
    ],
  };
  // 上片扣到 3001 顶面（y=3）时，下片落在 y=2，而 3001 占 y=0..3 → 必然穿入父砖。
  // 正确行为：没有任何合法候选（返回空），而不是返回 40 个穿模候选。
  const cands = findMounts(main, sub, cat, { anchor: 'up', maxResults: 40 });
  assert.equal(cands.length, 0, `下片必然穿父砖，不应有任何候选；实际返回 ${cands.length} 个`);

  // 显式关闭父件检查时旧行为会返回候选，用于证明差异确实来自父件检查
  const legacy = findMounts(main, sub, cat, { anchor: 'up', maxResults: 40, includeParentCollision: false });
  assert.ok(legacy.length > 0, '关闭父件检查后应能复现旧行为（候选存在）');
  const parent = main.parts[0];
  const pBoxes = partBoxes(parent, cat.parts[parent.part]);
  let colliding = 0;
  for (const c of legacy) {
    const low = c.placed.find((p) => p.id === 'low');
    if (partsCollide(low, cat.parts[low.part], partBoxes(low, cat.parts[low.part]), parent, cat.parts[parent.part], pBoxes)) colliding++;
    assert.equal(c.collisionChecked.includesParent, false, '显式豁免时必须在候选里声明 includesParent=false');
  }
  assert.equal(colliding, legacy.length, '关闭检查的候选应当全部穿父砖（证明豁免就是缺陷来源）');
});

test('[EN-02] 候选枚举同样排除父件碰撞（装配候选用引擎给出的实际落位校验）', () => {
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'base', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, {});
  const sub = { parts: [{ id: 'low', part: '3020', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }, { id: 'up', part: '3020', color: 0, at: [0, 1, 0], rot: 0, up: '+y', snot: 0, step: 2 }], anchor: 'up' };
  const r = enumerateCandidates(si.state, { childModel: sub, maxResults: 20 }, cat);
  const parent = model.parts[0];
  const pBoxes = partBoxes(parent, cat.parts[parent.part]);
  // 引擎在这些候选里把整组都放到父件顶面之上（low y=3、up y=4），所以本身不穿模。
  // 这里断言的是：每个返回的候选都确实不带父件穿模；若有候选试图把下片放进父砖，必须被排除。
  // （真实缺陷在 findMounts 的路径上，见上一个测试；枚举路径由「整组逐件 vs 父件」保证。）
  let anyColliding = 0;
  for (const it of r.items) {
    assert.ok(Array.isArray(it._placed), '装配候选必须携带实际落位供复核');
    assert.equal(it.collisionChecked.includesParent, true, '候选必须声明已检查父件');
    for (const p of it._placed) {
      const def = cat.parts[p.part];
      const hit = partsCollide(p, def, partBoxes(p, def), parent, cat.parts[parent.part], pBoxes);
      if (hit) anyColliding++;
    }
  }
  assert.equal(anyColliding, 0, `返回的候选里不得有任何零件穿入父件；实际 ${anyColliding} 处`);
});

// ---------------------------------------------------------------- EN：候选与动作

test('[EN-05] 候选枚举：每个候选都真实扣合且无穿模（引擎自证）', () => {
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'b1', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, {});
  for (const child of ['3020', '3024', '3001', '87087']) {
    const r = enumerateCandidates(si.state, { childPartId: child, maxResults: 400 }, cat);
    assert.ok(r.count > 0, `${child} 应有候选`);
    for (const it of r.items) {
      const o = getOrientation(it.orientationId);
      const at = [it.translationLdu[0] / 20, it.translationLdu[1] / 8, it.translationLdu[2] / 20];
      const ch = { id: 't', part: it.childPartId, color: 0, at, rot: o.rot, up: o.up, snot: it.snot };
      const par = { id: 'b1', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 };
      assert.equal(partsConnected(par, cat.parts['3001'], ch, cat.parts[it.childPartId]), true,
        `候选 ${it.candidateId} 与父件没有真实物理连接`);
      const hit = partsCollide(ch, cat.parts[it.childPartId], partBoxes(ch, cat.parts[it.childPartId]), par, cat.parts['3001'], partBoxes(par, cat.parts['3001']));
      assert.equal(hit, null, `候选 ${it.candidateId} 与父件穿模（碰撞格 ${JSON.stringify(hit)}）`);
    }
  }
});

test('[EN-05] 候选枚举：父件不在原点时位姿仍正确（不得把父件平移算两遍）', () => {
  // 回归：candidates 曾写成 parentWorld[i] + stud.pos[i]，而 partConnectors 的 pos 已是世界坐标。
  // 父件在原点时两种写法结果相同，所以只在父件平移后才暴露。这里用 [3,0,2] 钉住。
  for (const at of [[0, 0, 0], [3, 0, 2], [-4, 1, 5]]) {
    const parent = { id: 'p', part: '3001', color: 0, at, rot: 0, up: '+y', snot: 0, step: 1 };
    const si = inspectFromModel({ format: 'brickbuild', version: '0.2', parts: [parent] }, cat, {});
    const r = enumerateCandidates(si.state, { childPartId: '3023', parentNodeId: 'p', maxResults: 8 }, cat);
    assert.ok(r.count > 0, `父件 at=${JSON.stringify(at)} 应有候选`);
    for (const it of r.items) {
      const o = getOrientation(it.orientationId);
      const ch = {
        id: 'c', part: it.childPartId, color: 0,
        at: [it.translationLdu[0] / 20, it.translationLdu[1] / 8, it.translationLdu[2] / 20],
        rot: o.rot, up: o.up, snot: it.snot,
      };
      assert.equal(partsConnected(parent, cat.parts['3001'], ch, cat.parts[it.childPartId]), true,
        `父件 at=${JSON.stringify(at)} 的候选 ${it.candidateId} 与父件没有真实物理连接（父件平移被重复计算？）`);
    }
  }
});

test('[AS-06] SNOT 0/1/2 三层链：snapPart 逐层扣合，层号单调递增，validate 通过', () => {
  // 现实夹具：底座 3001 → SNOT 砖 4733（+z 侧凸点）→ 第一层 3024 → 第二层 3024 → 第三层 3024。
  const base = { id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const sb = { id: 'sb', part: '4733', color: 15, at: [1, 3, 1], rot: 0, up: '+y', snot: 0, step: 2 };
  const model = { format: 'brickbuild', version: '0.2', parts: [base, sb] };

  const sbSideStuds = partConnectors(sb, cat.parts['4733']).studs.filter((s) => s.kind === 'side');
  const plusZ = sbSideStuds.find((s) => s.dir === '+z');
  assert.ok(plusZ, '4733 应有 +z 侧凸点');

  const chain = [];
  let parentId = 'sb', studIndex = plusZ.index, dir = '+z';
  for (let layer = 1; layer <= 3; layer++) {
    const parent = model.parts.find((p) => p.id === parentId);
    const id = `l${layer}`;
    const snapped = snapPart(parent, cat.parts[parent.part], studIndex,
      { id, part: '3024', color: 0, rot: 0 }, cat.parts['3024'], 0);
    assert.equal(snapped.up, dir, `第 ${layer} 层应朝 ${dir}`);
    model.parts.push({ ...snapped, step: layer + 2 });
    const conn = partConnectors(snapped, cat.parts['3024']);
    const out = conn.studs.find((s) => s.dir === dir);
    assert.ok(out, `第 ${layer} 层板应有朝外的凸点（才能继续叠层）`);
    chain.push({ id, at: snapped.at, center: partCenter(snapped, cat.parts['3024']), gap: out.pos[2] - (layer === 1 ? plusZ.pos[2] : 0) });
    parentId = id; studIndex = out.index;
  }

  // 每层中心沿外法线严格递增 0.4 格（=1 片），证明层与层不重叠也不悬空
  const zs = chain.map((c) => c.center[2]);
  for (let i = 1; i < zs.length; i++) {
    assert.ok(Math.abs((zs[i] - zs[i - 1]) - 0.4) < 1e-6,
      `第 ${i + 1} 层中心应比第 ${i} 层外移 0.4 格，实际 ${(zs[i] - zs[i - 1]).toFixed(6)}`);
  }

  const v = validate(model, cat);
  assert.equal(v.ok, true, `SNOT 三层链应通过校验：${JSON.stringify(v.errors)}`);

  // 反例：把中间层再外推 1 片（只加 snot/at 而不相应回退）→ 连接器错位，必须被拒
  const broken = JSON.parse(JSON.stringify(model));
  const mid = broken.parts.find((p) => p.id === 'l2');
  mid.snot = (mid.snot ?? 0) + 1;
  const vb = validate(broken, cat);
  assert.equal(vb.ok, false, '中间层被额外外推 1 片后必须校验失败（悬空/错位），不得静默通过');
  assert.ok(vb.errors.some((e) => e.code === 'floating' || e.code === 'overlap'),
    `应报 floating 或 overlap，实际 ${JSON.stringify(vb.errors.map((e) => e.code))}`);
});

test('[AS-06] snot 与 at 是叠加编码：同一物理位置可写成 (at+0.4n, snot 0) 或 (at, snot n)', () => {
  // core.partCenter 的口径：up='+z' 时 z = at[2] + snot*0.4。
  // 真实模型（mecha p82/p15/p16）用「共同基准 at + 递增 snot」；
  // 引擎候选必须先给基准 at 再让 apply 叠加 snot，两边都写绝对值会重复偏移。
  const def = cat.parts['3024'];
  const positions = [0, 1, 2].map((n) => {
    const p = { id: 'x', part: '3024', color: 0, at: [0, 0, 2.4 - n * 0.4], rot: 0, up: '+z', snot: n };
    return partCenter(p, def);
  });
  for (let i = 1; i < positions.length; i++) {
    assert.deepEqual(positions[i], positions[0],
      `snot=${i} + 回退 ${i * 0.4} 格应与 snot=0 的绝对位置重合`);
  }
});

test('[EN-03] attach_assembly 事务：整组原子提交，成员全部落位且库存按件扣减', () => {
  const base = { id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const model = { format: 'brickbuild', version: '0.2', parts: [base] };
  // 子组件：两块 3×1 板叠起来（真实扣合，不是并排乱放）
  const childModel = { parts: [
    { id: 'm1', part: '3623', color: 4, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
    { id: 'm2', part: '3623', color: 4, at: [0, 1, 0], rot: 0, up: '+y', snot: 0, step: 1 },
  ] };
  const si = inspectFromModel(model, cat, { mainRootNodeId: 'base' });
  const res = enumerateCandidates(si.state, { childModel, parentNodeId: 'base', maxResults: 40 }, cat);
  assert.ok(res.count > 0, '应能枚举出子组件挂装候选');
  const c = res.items[0];
  assert.equal(c.features.isAssembly, true);
  assert.equal(c.features.memberCount, 2);
  assert.equal(c._placed.length, 2, '候选必须携带整组位姿，否则无法原子提交');

  // 每次事务都从**独立**的初始状态开跑：提交成功会回写 ctx.state，
  // 复用同一个 state 会让第二次事务拿着过期候选（candidate-unknown），那是正确行为，不该被当作测试失败。
  const mk = (actions, inventory) => {
    const fresh = inspectFromModel(model, cat, { mainRootNodeId: 'base' });
    const request = { protocolVersion: '1.0.0', taskId: 't', stateHash: fresh.stateHash, actions };
    const ctx = { model, cat, stateHash: fresh.stateHash, state: fresh.state, taskId: 't', mainRootNodeId: 'base', inventory,
      enumerate: (r) => enumerateCandidates(fresh.state, r, cat) };
    return applyActions(ctx, request);
  };
  const act = { id: 'a1', op: 'attach_assembly', target: { partInstanceId: 'grp' }, candidateId: c.candidateId, candidateHash: c.candidateHash, partId: c.childPartId, color: 4, childModel };

  // 正例：两块 3623 的库存齐备
  const ok = mk([act], [
    { token: 'i1', partId: '3623', color: 4, state: 'available' },
    { token: 'i2', partId: '3623', color: 4, state: 'available' },
  ]);
  assert.equal(ok.passed, true, JSON.stringify(ok.diagnostics));
  assert.equal(ok.apply.committed, true);
  const applied = ok.apply.results[0].applied;
  assert.equal(applied.memberCount, 2);
  assert.deepEqual(applied.memberNodeIds, ['grp', 'grp/m2'], '锚点用动作给的 id，其余成员加前缀');
  assert.equal(applied.inventoryTokens.length, 2, '两个成员各消费一个库存 token');
  assert.equal(applied.atomic, true);

  // 负例：库存只够一件 → 整组拒绝，不得只装一半。
  // 注意：mk 每次都从传入的 inventory 重新开事务，因此这里传的是独立的「只剩一件」库存，
  // 与上面的正例互不影响（否则会变成「已被消费」而不是「不够」）。
  const short = mk([act], [{ token: 'i1', partId: '3623', color: 4, state: 'available' }]);
  assert.equal(short.passed, false);
  assert.ok(short.diagnostics.some((x) => x.code === 'inventory-insufficient'), JSON.stringify(short.diagnostics.map((x) => x.code)));
  assert.equal(short.apply.committed, false);
  assert.equal(short.apply.rolledBack, true);
});

test('[EN-03] 事务提交成功时 ctx.state 更新为新状态（引擎回写工作状态）', () => {
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, { mainRootNodeId: 'base' });
  const before = si.state.nodes.length;
  const cand = enumerateCandidates(si.state, { childPartId: '3023', parentNodeId: 'base', maxResults: 8 }, cat);
  const c = cand.items[0];
  const ctx = { model, cat, stateHash: si.stateHash, state: si.state, taskId: 't', mainRootNodeId: 'base',
    inventory: [{ token: 'k1', partId: '3023', color: 4, state: 'available' }],
    enumerate: (r) => enumerateCandidates(si.state, r, cat) };
  const out = applyActions(ctx, { protocolVersion: '1.0.0', taskId: 't', stateHash: si.stateHash, actions: [
    { id: 'a1', op: 'attach_part', target: { partInstanceId: 'x1' }, candidateId: c.candidateId, candidateHash: c.candidateHash, partId: '3023', color: 4 },
  ] });
  assert.equal(out.passed, true, JSON.stringify(out.diagnostics));
  assert.equal(si.state.nodes.length, before + 1, '成功提交后调用方状态应包含新零件');
});

test('[EN-03] 事务回滚不得让 ctx.state 前进一步（假回滚回归）', () => {
  // 回归：rehash() 曾直接改写 prevState（即调用方 ctx.state）的 nodes/connections/occupancy。
  // 结果是「返回 rolledBack=true / stateHashAfter=before」，但调用方手里的状态已是更新后的内容。
  // B 的会话与 CLI 共用同一个 state 对象，后续枚举会跑在错状态上。
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, { mainRootNodeId: 'base' });
  const snapshot = () => JSON.stringify({ n: si.state.nodes.length, c: si.state.connections.length, o: si.state.occupancy.length });
  const before = snapshot();
  const cand = enumerateCandidates(si.state, { childPartId: '3023', parentNodeId: 'base', maxResults: 8 }, cat);
  const c = cand.items[0];
  // 第二条动作引用不存在的候选 → 整批失败回滚
  const ctx = { model, cat, stateHash: si.stateHash, state: si.state, taskId: 't', mainRootNodeId: 'base',
    inventory: [{ token: 'k1', partId: '3023', color: 4, state: 'available' }, { token: 'k2', partId: '3023', color: 4, state: 'available' }],
    enumerate: (r) => enumerateCandidates(si.state, r, cat) };
  const out = applyActions(ctx, { protocolVersion: '1.0.0', taskId: 't', stateHash: si.stateHash, actions: [
    { id: 'a1', op: 'attach_part', target: { partInstanceId: 'x1' }, candidateId: c.candidateId, candidateHash: c.candidateHash, partId: '3023', color: 4 },
    { id: 'a2', op: 'attach_part', target: { partInstanceId: 'x2' }, candidateId: 'cand-does-not-exist', partId: '3023', color: 4 },
  ] });
  assert.equal(out.passed, false);
  assert.equal(out.apply.rolledBack, true);
  assert.equal(snapshot(), before, '整批回滚后 ctx.state 必须完全不变（节点/连接/占用都不动）');
});

test('[EN-03] 跨事务库存守恒：成功事务必须把 token 持久标为 consumed（A-INV-01 回归）', () => {
  // 反例：consumedNow 只活在本批次内，提交时不写回库存记录的 state。
  // 结果第二次事务拿着第一次返回的 _inventory 又能装出第二组，模型 1→3→5 件且零错误。
  // 库存守恒是 EN-03 的核心，必须跨事务成立，不能只是批次内去重。
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const childModel = { parts: [
    { id: 'm1', part: '3623', color: 4, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
    { id: 'm2', part: '3623', color: 4, at: [0, 1, 0], rot: 0, up: '+y', snot: 0, step: 1 },
  ] };
  const attachOnce = (mdl, inventory, nodeId) => {
    const si = inspectFromModel(mdl, cat, { mainRootNodeId: 'base', inventory });
    const parentId = mdl.parts[0].id;
    const res = enumerateCandidates(si.state, { childModel, parentNodeId: parentId, maxResults: 5000 }, cat);
    const c = res.items[0];
    assert.ok(c, '应能枚举出子组件挂装候选');
    const ctx = { model: mdl, cat, stateHash: si.stateHash, state: si.state, taskId: 't', mainRootNodeId: 'base', inventory,
      enumerate: (r) => enumerateCandidates(si.state, r, cat) };
    return applyActions(ctx, { protocolVersion: '1.0.0', taskId: 't', stateHash: si.stateHash, actions: [{
      id: `a-${nodeId}`, op: 'attach_assembly', target: { partInstanceId: nodeId },
      candidateId: c.candidateId, candidateHash: c.candidateHash, partId: c.childPartId, color: 4, childModel,
    }] });
  };

  const first = attachOnce(model, [
    { token: 'only-1', partId: '3623', color: 4, state: 'available' },
    { token: 'only-2', partId: '3623', color: 4, state: 'available' },
  ], 'grp');
  assert.equal(first.passed, true, JSON.stringify(first.diagnostics));
  // 返回库存必须记录消费事实，而不是留着 available 让下一事务再消费一遍
  for (const rec of first._inventory) {
    assert.equal(rec.state, 'consumed', `token ${rec.token} 必须是 consumed，实际 ${rec.state}`);
    assert.equal(rec.consumedBy, 'grp', `token ${rec.token} 应记下消费去向`);
  }
  assert.equal(first._workingModel.parts.length, 3);

  // 第二次用第一次返回的模型 + 库存继续：库存已耗尽，必须拒绝而不是再长出两件
  const second = attachOnce(first._workingModel, first._inventory, 'grp2');
  assert.equal(second.passed, false, '同一批 token 不得跨事务重复消费');
  assert.equal(second.apply.committed, false);
  assert.equal(second.apply.rolledBack, true);
  assert.ok(second.diagnostics.some((x) => x.code === 'inventory-insufficient'),
    `第二次应报库存不足，实际 ${second.diagnostics.map((x) => x.code)}`);
  assert.equal(second._workingModel, undefined, '失败路径不得回传已推进的模型');
});

test('[EN-03] 跨事务库存：有新库存时第二次合法装配仍要通过（拒绝不能误伤正常补料）', () => {
  // 上一条的对照：证明修复的是「重复消费」，不是「第二批装不上」。
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, { mainRootNodeId: 'base' });
  const attach = (mdl, inventory, nodeId) => {
    const st = inspectFromModel(mdl, cat, { mainRootNodeId: 'base', inventory });
    const res = enumerateCandidates(st.state, { childPartId: '3023', parentNodeId: 'base', maxResults: 8 }, cat);
    const c = res.items[0];
    assert.ok(c, `应能枚举出候选（${nodeId}）`);
    const ctx = { model: mdl, cat, stateHash: st.stateHash, state: st.state, taskId: 't', mainRootNodeId: 'base', inventory,
      enumerate: (r) => enumerateCandidates(st.state, r, cat) };
    return applyActions(ctx, { protocolVersion: '1.0.0', taskId: 't', stateHash: st.stateHash, actions: [{
      id: `a-${nodeId}`, op: 'attach_part', target: { partInstanceId: nodeId },
      candidateId: c.candidateId, candidateHash: c.candidateHash, partId: '3023', color: 4,
    }] });
  };
  void si;
  const inv = [
    { token: 'k1', partId: '3023', color: 4, state: 'available' },
    { token: 'k2', partId: '3023', color: 4, state: 'available' },
  ];
  const one = attach(model, inv, 'x1');
  assert.equal(one.passed, true, JSON.stringify(one.diagnostics));
  assert.equal(one._inventory.find((i) => i.token === 'k1').state, 'consumed');
  assert.equal(one._inventory.find((i) => i.token === 'k2').state, 'available', '没用到的 token 不能被误标消费');

  const two = attach(one._workingModel, one._inventory, 'x2');
  assert.equal(two.passed, true, `还有一件可用库存，第二次应通过：${JSON.stringify(two.diagnostics)}`);
  assert.equal(two._workingModel.parts.length, 3);
  assert.deepEqual(two._inventory.map((i) => i.state), ['consumed', 'consumed'], '两件库存都应用尽');

  // 第三件没有库存了 → 拒绝（未给 token 且该件号记录已全部消费）
  const three = attach(two._workingModel, two._inventory, 'x3');
  assert.equal(three.passed, false);
  assert.ok(three.diagnostics.some((x) => x.code === 'inventory-insufficient'), JSON.stringify(three.diagnostics.map((x) => x.code)));
});

test('[EN-03] undo 必须放回库存 token，否则撤销一次就永久烧掉一组零件', () => {
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, { mainRootNodeId: 'base' });
  const cand = enumerateCandidates(si.state, { childPartId: '3023', parentNodeId: 'base', maxResults: 8 }, cat);
  const c = cand.items[0];
  const ctx = { model, cat, stateHash: si.stateHash, state: si.state, taskId: 't', mainRootNodeId: 'base',
    inventory: [{ token: 'k1', partId: '3023', color: 4, state: 'available' }],
    enumerate: (r) => enumerateCandidates(si.state, r, cat) };
  const out = applyActions(ctx, { protocolVersion: '1.0.0', taskId: 't', stateHash: si.stateHash, repairMode: true, actions: [
    { id: 'a1', op: 'attach_part', target: { partInstanceId: 'x1' }, candidateId: c.candidateId, candidateHash: c.candidateHash, partId: '3023', color: 4 },
    { id: 'a2', op: 'undo', repair: { undoActionId: 'a1' }, dependsOn: ['a1'] },
  ] });
  assert.equal(out.passed, true, JSON.stringify(out.diagnostics));
  const undo = out.apply.results.find((r) => r.actionId === 'a2');
  assert.deepEqual(undo.applied.releasedInventoryTokens, ['k1'], 'undo 必须报告放回的 token');
  assert.equal(out._workingModel.parts.length, 1, '撤销后模型回到 1 件');
  assert.equal(out._inventory.find((i) => i.token === 'k1').state, 'available', '撤销后 token 必须回到可用');
});

test('[EN-03] detach：拆下叶子件成功并释放库存；拆支撑件会留下悬空件时必须拒绝', () => {
  // 结构：base(3001) ← mid(3023) ← cap(3023)，板叠板一层 0.4 格，3001 高 3 片 → mid 在 y=3、cap 在 y=4。
  // cap 是叶子，拆它安全；拆 mid 会让 cap 失去唯一连接，修复动作不能以「问题换个形式」收场。
  const model = { format: 'brickbuild', version: '0.2', parts: [
    { id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
    { id: 'mid', part: '3023', color: 0, at: [0, 3, 0], rot: 0, up: '+y', snot: 0, step: 2 },
    { id: 'cap', part: '3023', color: 4, at: [0, 4, 0], rot: 0, up: '+y', snot: 0, step: 3 },
  ] };
  const si0 = inspectFromModel(model, cat, { mainRootNodeId: 'base' });
  // 先确认这个结构确实连通，否则下面的断言等于在测一个本来就散架的模型
  assert.ok(si0.state.connections.length >= 2,
    `夹具本身必须连通，实际只有 ${si0.state.connections.length} 条连接`);

  const run = (actions, inventory) => {
    const si = inspectFromModel(model, cat, { inventory, mainRootNodeId: 'base' });
    const ctx = { model, cat, stateHash: si.stateHash, state: si.state, taskId: 't', mainRootNodeId: 'base', inventory,
      enumerate: (r) => enumerateCandidates(si.state, r, cat) };
    return applyActions(ctx, { protocolVersion: '1.0.0', taskId: 't', stateHash: si.stateHash, repairMode: true, actions });
  };

  // 正例：拆叶子件
  const okRes = run([{ id: 'd1', op: 'detach', repair: { detachNodeId: 'cap' } }], [
    { token: 'c1', partId: '3023', color: 4, state: 'consumed', consumedBy: 'cap' },
  ]);
  assert.equal(okRes.passed, true, JSON.stringify(okRes.diagnostics));
  const okApplied = okRes.apply.results[0].applied;
  assert.equal(okApplied.detached, true);
  assert.equal(okApplied.remainingParts, 2);
  assert.deepEqual(okApplied.releasedInventoryTokens, ['c1'], 'detach 必须把该件的库存 token 放回');
  assert.equal(okRes._workingModel.parts.length, 2);
  assert.equal(okRes._inventory[0].state, 'available');

  // 负例：拆 mid 会让 cap 悬空
  const badRes = run([{ id: 'd2', op: 'detach', repair: { detachNodeId: 'mid' } }], []);
  assert.equal(badRes.passed, false);
  assert.ok(badRes.diagnostics.some((x) => x.code === 'detach-orphans-parts'),
    `应报 detach-orphans-parts，实际 ${badRes.diagnostics.map((x) => x.code)}`);
  assert.equal(badRes._workingModel, undefined, '拒绝时不得回传已推进的模型');

  // 负例：目标不存在
  const missRes = run([{ id: 'd3', op: 'detach', repair: { detachNodeId: 'nope' } }], []);
  assert.equal(missRes.passed, false);
  assert.ok(missRes.diagnostics.some((x) => x.code === 'detach-unknown-node'));
});

test('[EN-03] replace：同姿态换件保持连接才通过；换不上或断连必须拒绝', () => {
  const model = { format: 'brickbuild', version: '0.2', parts: [
    { id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
    { id: 'plate', part: '3023', color: 0, at: [0, 3, 0], rot: 0, up: '+y', snot: 0, step: 2 },
  ] };
  const run = (actions, inventory) => {
    const si = inspectFromModel(model, cat, { inventory, mainRootNodeId: 'base' });
    const ctx = { model, cat, stateHash: si.stateHash, state: si.state, taskId: 't', mainRootNodeId: 'base', inventory,
      enumerate: (r) => enumerateCandidates(si.state, r, cat) };
    return applyActions(ctx, { protocolVersion: '1.0.0', taskId: 't', stateHash: si.stateHash, repairMode: true, actions });
  };

  // 正例：3023 → 3022（同为 2×2 板，同姿态仍能扣在 3001 上）
  const okRes = run([{ id: 'r1', op: 'replace', target: { partInstanceId: 'plate' }, repair: { replacePartId: '3022' } }], [
    { token: 'n1', partId: '3022', color: 0, state: 'available' },
    { token: 'o1', partId: '3023', color: 0, state: 'consumed', consumedBy: 'plate' },
  ]);
  assert.equal(okRes.passed, true, JSON.stringify(okRes.diagnostics));
  const applied = okRes.apply.results[0].applied;
  assert.equal(applied.replaced, true);
  assert.equal(applied.from, '3023/0');
  assert.equal(applied.to, '3022/0');
  assert.deepEqual(applied.keptPose.at, [0, 3, 0], '换件不得移动位姿');
  assert.ok(applied.connectedTo.includes('base'), '换件后必须仍与 base 真实扣合');
  assert.deepEqual(applied.releasedInventoryTokens, ['o1'], '旧件库存必须释放');
  assert.equal(okRes._inventory.find((i) => i.token === 'n1').state, 'consumed');
  assert.equal(okRes._inventory.find((i) => i.token === 'o1').state, 'available');
  assert.equal(okRes._workingModel.parts.find((p) => p.id === 'plate').part, '3022');

  // 负例：换成在该姿态装不上的件号（104 = Antenna 6H，同位置与 base 无连接且不碰撞）
  // → 必须拒绝，不能静默留一个悬空件。选件依据：该件在这个姿态下 partsConnected 为 false。
  const disconnRes = run([{ id: 'r2', op: 'replace', target: { partInstanceId: 'plate' }, repair: { replacePartId: '104' } }], []);
  assert.equal(disconnRes.passed, false);
  assert.ok(disconnRes.diagnostics.some((x) => x.code === 'replace-disconnected'),
    `应报 replace-disconnected，实际 ${disconnRes.diagnostics.map((x) => x.code)}`);

  // 负例：换成同姿态会穿模的件（99781 = 1×2-1×2 倒支架，在该格与 base 实体重叠）
  // 连接和碰撞是两件事：能扣上但塞不进去，也必须拒绝。
  const collideRes = run([{ id: 'r6', op: 'replace', target: { partInstanceId: 'plate' }, repair: { replacePartId: '99781' } }], []);
  assert.equal(collideRes.passed, false);
  assert.ok(collideRes.diagnostics.some((x) => x.code === 'collision'),
    `应报 collision，实际 ${collideRes.diagnostics.map((x) => x.code)}`);

  // 负例：换成不存在的件号
  const missRes = run([{ id: 'r3', op: 'replace', target: { partInstanceId: 'plate' }, repair: { replacePartId: '99999' } }], []);
  assert.equal(missRes.passed, false);
  assert.ok(missRes.diagnostics.some((x) => x.code === 'missing-asset'));

  // 负例：换成同一件同色 → noop，不接受「什么也没做的成功」
  const noopRes = run([{ id: 'r4', op: 'replace', target: { partInstanceId: 'plate' }, repair: { replacePartId: '3023' } }], []);
  assert.equal(noopRes.passed, false);
  assert.ok(noopRes.diagnostics.some((x) => x.code === 'replace-noop'));

  // 负例：该件号库存全被消费 → 不能凭空变一件
  const noStockRes = run([{ id: 'r5', op: 'replace', target: { partInstanceId: 'plate' }, repair: { replacePartId: '3022' } }], [
    { token: 'x1', partId: '3022', color: 0, state: 'consumed', consumedBy: 'elsewhere' },
  ]);
  assert.equal(noStockRes.passed, false);
  assert.ok(noStockRes.diagnostics.some((x) => x.code === 'inventory-insufficient'),
    `应报 inventory-insufficient，实际 ${noStockRes.diagnostics.map((x) => x.code)}`);
});

test('[EN-03] attach_assembly 重枚举必须带 childModel，否则 asm 候选永远找不到', () => {
  // 回归：apply 重枚举时若只传 childPartId，引擎只枚举单件候选，
  // 表现为 attach_assembly 恒报 candidate-unknown（子组件功能形同不存在）。
  const base = { id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const model = { format: 'brickbuild', version: '0.2', parts: [base] };
  const childModel = { parts: [
    { id: 'm1', part: '3623', color: 4, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
    { id: 'm2', part: '3623', color: 4, at: [0, 1, 0], rot: 0, up: '+y', snot: 0, step: 1 },
  ] };
  const si = inspectFromModel(model, cat, { mainRootNodeId: 'base' });
  const withChild = enumerateCandidates(si.state, { childModel, parentNodeId: 'base', maxResults: 40 }, cat);
  const withoutChild = enumerateCandidates(si.state, { childPartId: withChild.items[0].childPartId, parentNodeId: 'base', maxResults: 5000 }, cat);
  assert.ok(withChild.count > 0);
  assert.equal(withoutChild.items.some((x) => x.candidateId === withChild.items[0].candidateId), false,
    '不带 childModel 的重枚举不应产出同一个 asm 候选（这正是旧 bug 的成因）');

  const request = { protocolVersion: '1.0.0', taskId: 't', stateHash: si.stateHash, actions: [{
    id: 'a1', op: 'attach_assembly', target: { partInstanceId: 'grp' },
    candidateId: withChild.items[0].candidateId, candidateHash: withChild.items[0].candidateHash,
    partId: withChild.items[0].childPartId, color: 4, childModel,
  }] };
  const ctx = { model, cat, stateHash: si.stateHash, state: si.state, taskId: 't', mainRootNodeId: 'base',
    inventory: [{ token: 'i1', partId: '3623', color: 4, state: 'available' }, { token: 'i2', partId: '3623', color: 4, state: 'available' }],
    enumerate: (r) => enumerateCandidates(si.state, r, cat) };
  const out = applyActions(ctx, request);
  assert.equal(out.passed, true, String(JSON.stringify(out.diagnostics)));
});

test('[EN-02] 侧装候选：apply 后必须真实扣合（侧凸点分支也要走物理复核）', () => {
  const base = { id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const sb = { id: 'sb', part: '4733', color: 15, at: [1, 3, 1], rot: 0, up: '+y', snot: 0, step: 2 };
  const model = { format: 'brickbuild', version: '0.2', parts: [base, sb] };
  const si = inspectFromModel(model, cat, { mainRootNodeId: 'base' });
  const r = enumerateCandidates(si.state, { childPartId: '3023', parentNodeId: 'sb', maxResults: 64 }, cat);
  const sideCands = r.items.filter((c) => c.features?.isSnot);
  assert.ok(sideCands.length > 0, '4733 侧凸点应能侧装 3023');

  const c = sideCands[0];
  const request = {
    protocolVersion: '1.0.0', taskId: 't', stateHash: si.stateHash,
    actions: [{ id: 'a1', op: 'attach_part', target: { partInstanceId: 'l1' }, candidateId: c.candidateId, candidateHash: c.candidateHash, partId: c.childPartId, color: 0 }],
  };
  const ctx = {
    model, cat, stateHash: si.stateHash, state: si.state, taskId: 't', mainRootNodeId: 'base',
    inventory: [{ token: 'k1', partId: c.childPartId, color: 0, state: 'available' }],
    enumerate: (req) => enumerateCandidates(si.state, req, cat),
  };
  const res = applyActions(ctx, request);
  assert.equal(res.passed, true, `侧装候选应能事务化应用，实际诊断 ${JSON.stringify(res.diagnostics)}`);
  assert.equal(res.apply.committed, true);
  assert.deepEqual(res.apply.results[0].applied.connectorsUsed.length, 2);
});

test('[EN-05] 候选枚举：截断与穷尽必须区分；无解原因可区分', () => {
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'b1', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, {});
  const small = enumerateCandidates(si.state, { childPartId: '3020', maxResults: 3 }, cat);
  assert.equal(small.truncated, true);
  assert.equal(small.enumerationComplete, false, '截断时不得声称穷尽搜索');

  const missing = enumerateCandidates(si.state, { childPartId: 'no-such-part' }, cat);
  assert.equal(missing.noSolutionReason, 'missing-asset');
  assert.equal(missing.ok, false);
  assert.ok(missing.capabilityGaps.some((g) => g.kind === 'missing-asset'));

  // 父件接口全被占用 → 无候选，原因必须是 occupied 或 collision，不是「成功但空」
  const st2 = JSON.parse(JSON.stringify(si.state));
  st2.occupancy = st2.nodes.flatMap((n) => {
    const p = partConnectors(n, cat.parts[n.partId]);
    return p.studs.map((s) => ({ nodeId: n.nodePath, connectorId: `c${s.kind}#${s.index}`, occupiedBy: 'x' }));
  });
  const occupiedRes = enumerateCandidates(st2, { childPartId: '3020', parentNodeId: 'b1' }, cat);
  assert.equal(occupiedRes.count, 0);
  assert.notEqual(occupiedRes.noSolutionReason, 'none');
});

test('[EN-03] 动作事务：正例提交、stateHash 变化、物理连接为真', () => {
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'b1', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, { mainRootNodeId: 'b1' });
  const enumRes = enumerateCandidates(si.state, { childPartId: '3020', parentNodeId: 'b1', maxResults: 200 }, cat);
  const cand = enumRes.items[0];
  const ctx = {
    model, cat, stateHash: si.stateHash, state: si.state,
    inventory: [{ token: 'T1', partId: '3020', color: 0, state: 'available' }],
    taskId: 'task-1', mainRootNodeId: 'b1',
    enumerate: (req) => enumerateCandidates(si.state, req, cat),
  };
  const req = {
    protocolVersion: '1.0.0', taskId: 'task-1', stateHash: si.stateHash,
    actions: [{ id: 'a1', op: 'attach_part', candidateId: cand.candidateId, candidateHash: cand.candidateHash, partId: '3020', target: { partInstanceId: 'p2' } }],
  };
  const r = applyActions(ctx, req);
  assert.equal(r.commandOk, true);
  assert.equal(r.passed, true, r.diagnostics.map((d) => `${d.code}: ${d.msg}`).join('; '));
  assert.equal(r.apply.committed, true);
  assert.notEqual(r.apply.stateHashAfter, r.apply.stateHashBefore, '提交后 stateHash 必须变化');
  const applied = r.apply.results[0].applied;
  assert.equal(applied.physicalConnection, true);
  assert.equal(applied.inventoryToken, 'T1', '应消费库存 token');
});

test('[EN-03] 动作事务负例：旧 stateHash / 空动作 / 未知候选 / 缺依赖 / 库存重复消费 / 未开修复模式', () => {
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'b1', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, {});
  const enumRes = enumerateCandidates(si.state, { childPartId: '3020', parentNodeId: 'b1', maxResults: 200 }, cat);
  const cand = enumRes.items[0];
  const mkctx = (inv) => ({
    model, cat, stateHash: si.stateHash, state: si.state, inventory: inv, taskId: 't1',
    enumerate: (req) => enumerateCandidates(si.state, req, cat),
  });
  const base = { protocolVersion: '1.0.0', taskId: 't1', stateHash: si.stateHash };

  const cases = [
    ['stale-state', { ...base, stateHash: 'deadbeef', actions: [{ id: 'a1', op: 'attach_part', candidateId: cand.candidateId, partId: '3020', target: { partInstanceId: 'p2' } }] }, [{ token: 'T1', partId: '3020', color: 0, state: 'available' }]],
    ['empty-action', { ...base, actions: [] }, []],
    ['candidate-unknown', { ...base, actions: [{ id: 'a1', op: 'attach_part', candidateId: 'cand-nope', partId: '3020', target: { partInstanceId: 'p2' } }] }, [{ token: 'T1', partId: '3020', color: 0, state: 'available' }]],
    ['missing-action-ref', { ...base, actions: [{ id: 'a1', op: 'attach_part', candidateId: cand.candidateId, partId: '3020', target: { partInstanceId: 'p2' }, dependsOn: ['nope'] }] }, [{ token: 'T1', partId: '3020', color: 0, state: 'available' }]],
    ['instance-id-dup', { ...base, actions: [{ id: 'a1', op: 'attach_part', candidateId: cand.candidateId, partId: '3020', target: { partInstanceId: 'b1' } }] }, [{ token: 'T1', partId: '3020', color: 0, state: 'available' }]],
    ['repair-not-allowed', { ...base, actions: [{ id: 'a1', op: 'undo', repair: { undoActionId: 'x' } }] }, []],
    ['inventory-consumed', { ...base, actions: [{ id: 'a1', op: 'attach_part', candidateId: cand.candidateId, candidateHash: cand.candidateHash, partId: '3020', inventoryToken: 'T1', target: { partInstanceId: 'p2' } }] }, [{ token: 'T1', partId: '3020', color: 0, state: 'consumed' }]],
    ['abstain-incomplete', { ...base, actions: [{ id: 'a1', op: 'abstain' }] }, []],
  ];
  for (const [expected, req, inv] of cases) {
    const r = applyActions(mkctx(inv), req);
    assert.equal(r.commandOk, true, `${expected}: 命令本身应正常执行`);
    assert.equal(r.passed, false, `${expected}: 不得判为通过`);
    assert.equal(r.diagnostics[0]?.code, expected, `${expected}: 期望错误码 ${expected}，实际 ${r.diagnostics[0]?.code}`);
  }
});

test('[EN-03] 动作幂等：同一 actionId 重复提交第二次为 noop，不改变结果状态', () => {
  const model = { format: 'brickbuild', version: '0.2', parts: [{ id: 'b1', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const si = inspectFromModel(model, cat, {});
  const enumRes = enumerateCandidates(si.state, { childPartId: '3020', parentNodeId: 'b1', maxResults: 200 }, cat);
  const cand = enumRes.items[0];
  const ctx = {
    model, cat, stateHash: si.stateHash, state: si.state, inventory: [], taskId: 't1', mainRootNodeId: 'b1',
    enumerate: (req) => enumerateCandidates(si.state, req, cat),
  };
  const a = { id: 'a1', op: 'attach_part', candidateId: cand.candidateId, candidateHash: cand.candidateHash, partId: '3020', target: { partInstanceId: 'p2' } };
  const r = applyActions(ctx, { protocolVersion: '1.0.0', taskId: 't1', stateHash: si.stateHash, actions: [a, { ...a }] });
  assert.equal(r.passed, true);
  assert.deepEqual(r.apply.results.map((x) => x.status), ['applied', 'noop']);
});

test('[EN-04] 主体可达性：状态里必须区分可达与不可达，不夸大通过', () => {
  const model = {
    format: 'brickbuild', version: '0.2',
    parts: [
      { id: 'root', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
      { id: 'onTop', part: '3020', color: 0, at: [0, 3, 0], rot: 0, up: '+y', snot: 0, step: 2 },
      { id: 'stray', part: '3001', color: 0, at: [20, 0, 0], rot: 0, up: '+y', snot: 0, step: 2 },
    ],
  };
  const si = inspectFromModel(model, cat, { mainRootNodeId: 'root' });
  assert.equal(si.state.reachability.bodyPartsTotal, 3);
  assert.equal(si.state.reachability.bodyPartsReachable, 2);
  assert.deepEqual(si.state.reachability.bodyPartsUnreachable, ['stray']);
  assert.ok(si.state.reachability.largestComponentRatio < 1);
});

test('[EN-01] 物理连接图不接受元数据伪造：只声明 subassembly 不产生连接边', () => {
  const model = {
    format: 'brickbuild', version: '0.2',
    parts: [
      { id: 'a', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1, module: 'g', subassembly: 'g', subassemblyAnchor: 'a' },
      { id: 'b', part: '3001', color: 0, at: [10, 0, 0], rot: 0, up: '+y', snot: 0, step: 2, module: 'g', subassembly: 'g', subassemblyAnchor: 'a' },
    ],
    modules: [{ id: 'g', label: 'g', subassembly: true }],
    steps: [{ n: 1, title: '1' }, { n: 2, title: '2' }, { n: 3, title: '装 g', attach: 'g' }],
  };
  const si = inspectFromModel(model, cat, {});
  const pair = si.state.connections.find((c) => (c.aNodeId === 'a' && c.bNodeId === 'b') || (c.aNodeId === 'b' && c.bNodeId === 'a'));
  assert.equal(pair, undefined, '相距 10 格的零件之间不得因分组产生连接边');
});

test('[EN-02] 多盒凹形件与整数格水平件重叠必须被检出（两条跳过路径不得互相让位）', () => {
  // 回归：整格占用检查会跳过带 boxes 的零件，3D 盒检查会跳过两个整数格水平件；
  // 二者叠加会让「凹形件 vs 普通件」的重叠漏检。这里用真实带 boxes 的目录件构造。
  const multiBoxPart = Object.keys(cat.parts).find((id) => {
    const d = cat.parts[id];
    return Array.isArray(d.boxes) && d.boxes.length >= 2;
  });
  assert.ok(multiBoxPart, '目录里应存在多盒分解件');
  // 把该件的多盒放在原点，再放一块 3001 与它完全重叠
  const a = { id: 'mb', part: multiBoxPart, color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const b = { id: 'brick', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 2 };
  const model = { format: 'brickbuild', version: '0.2', parts: [a, b] };
  const r = validate(model, cat);
  assert.equal(r.ok, false, `多盒件 ${multiBoxPart} 与 3001 完全重叠时必须报 overlap`);
  assert.ok(r.errors.some((e) => e.code === 'overlap'), '错误码应为 overlap');
});

test('[EN-02] 轮件穿模判据：真实扣合的嵌轮合法，未连接的重叠必须报错', () => {
  // 回归：partsCollide 曾对「任一方带 wheel 字段」整件豁免 AABB 判定。
  // 那会吞掉真实穿模——60239 上正好隐藏了两处「2 格宽轮胎压进 8 格瓷砖」
  // （p088×p056、p090×p057，各深 2×1×1 格，且两者之间没有任何连接器）。
  // 现在的判据是「连接关系」而不是「件类型」：扣在一起 → 嵌套合法；没扣一起 → 照常判穿模。
  const extCat = cat;
  const rim = { id: 'rim', part: '11208', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 };
  const tyre = { id: 'tyre', part: '11209', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 };
  const rimBoxes = partBoxes(rim, extCat.parts['11208']);
  const tyreBoxes = partBoxes(tyre, extCat.parts['11209']);

  // 前提：这两个件的 AABB 确实相交（轮胎套在轮毂外，包围盒天然互相包住）
  assert.notEqual(boxesCollide(rimBoxes, tyreBoxes), null, '轮胎与轮毂的 AABB 本来就相交，这正是需要豁免的场景');

  // 未连接的重叠 → 必须报穿模（这里是「轮胎压进瓷砖」的等价情形）
  const tile = { id: 'tile', part: '4162', color: 0, at: [2, 0, 0], rot: 0, up: '+y', snot: 0 };
  const tyreOverTile = { ...tyre, id: 'tyre2', at: [2, 0, 0] };
  assert.equal(partsConnected(tyreOverTile, extCat.parts['11209'], tile, extCat.parts['4162']), false, '轮胎与瓷砖不应相连');
  const hit = partsCollide(tyreOverTile, extCat.parts['11209'], partBoxes(tyreOverTile, extCat.parts['11209']),
    tile, extCat.parts['4162'], partBoxes(tile, extCat.parts['4162']));
  assert.notEqual(hit, null, '未连接的轮件与瓷砖重叠必须报穿模（不得被 wheel 豁免吞掉）');
});

// ---------------------------------------------------------------- CP：兼容

test('[CP-01] 既有代表模型编译后不新增结构问题（0 errors 0 warnings）', () => {
  for (const name of ['mecha', 'lantern.reconstructed', 'cottage', 'demo-ext-part']) {
    const m = readJSON(`examples/${name}.brick.json`);
    const r = validate(m, cat);
    assert.equal(r.ok, true, `${name} 应 0 errors：${r.errors.slice(0, 3).map((e) => e.code).join(',')}`);
    assert.deepEqual(r.warnings, [], `${name} 应 0 warnings`);
  }
});

test('[AS-05] 幂等重算：连续重算 100 次位姿零漂移', () => {
  // 用 0.3 夹具编译出的快照做基准；反复重算同一位姿链不产生累计误差
  const src = FIX('assembly-minimal.assembly.brick.json');
  const c = compileToLegacy(src, cat);
  assert.equal(c.ok, true);
  const model = JSON.parse(JSON.stringify(c.snapshot));
  // 给子件补 snap，模拟关系源；再重算
  model.parts[1].snap = { on: 'main/base', stud: 0, receptor: 0 };
  const baseline = JSON.stringify(model.parts.map((p) => p.at));
  for (let i = 0; i < 100; i++) recompute(model, cat);
  assert.equal(JSON.stringify(model.parts.map((p) => p.at)), baseline, '100 次重算后位姿必须与基准完全一致');
});
