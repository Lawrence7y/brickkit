// 生成 C0 契约夹具的正/负例，并验证每个负例都被引擎以预期错误码拒绝。
// 用法：node docs/prd-v2/implementation-A/contracts/fixtures/make-fixtures.mjs
// 输出：同目录下 *.assembly.brick.json 与 fixtures-report.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '../../../../..');
const mod = await import(pathToFileURL(path.join(ROOT, 'src/core/assembly-v1/compile.js')).href);
const { validateAssembly } = mod;
const lockMod = await import(pathToFileURL(path.join(ROOT, 'src/core/assets-v1/lock.js')).href);
const { buildAssetLock } = lockMod;

const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const cat = {
  parts: { ...readJSON('catalog/parts-ldraw.json').parts, ...readJSON('catalog/parts.json').parts },
  colors: readJSON('catalog/colors.json').colors,
};

const assetIndex = readJSON('catalog/assets-v1/index.json');

/**
 * 用资产索引把任意装配源的 assetLock 换成真实内容哈希闭包。
 * 手写 lock 必然漏 contentHash（也因此锁不住内容）；夹具统一走这里生成，
 * 保证「正例能过」是因为锁正确，而不是因为校验宽松。
 */
function relock(doc) {
  const usedIds = [...new Set((doc.definitions || []).flatMap((d) => (d.parts || []).map((q) => q.partId)))];
  const knownIds = usedIds.filter((id) => (assetIndex.parts || []).some((q) => String(q.partId) === String(id)));
  const built = buildAssetLock(assetIndex, knownIds, doc.assetLock?.profileId || assetIndex.profileId);
  doc.assetLock = built.assetLock;
  return built.missing;
}

const base = readJSON('docs/prd-v2/implementation-A/contracts/fixtures/assembly-minimal.assembly.brick.json');
relock(base);
fs.writeFileSync(path.join(HERE, 'assembly-minimal.assembly.brick.json'), JSON.stringify(base, null, 2) + '\n', 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));

const cases = [];

// ---- 负例 1：定位依赖成环 ----
{
  const doc = clone(base);
  doc.meta.name = '负例：定位依赖成环';
  doc.placements = [
    { nodeId: 'main/base', kind: 'connector', parentNodeId: 'main/plate', parentConnectorId: 'ctop#0', childConnectorId: 'cantistud#0' },
    { nodeId: 'main/plate', kind: 'connector', parentNodeId: 'main/base', parentConnectorId: 'ctop#0', childConnectorId: 'cantistud#0' },
  ];
  cases.push({ file: 'negative-placement-cycle.assembly.brick.json', doc, expectCodes: ['placement-cycle'] });
}

// ---- 负例 2：双重定位 ----
{
  const doc = clone(base);
  doc.meta.name = '负例：同一节点双重定位';
  doc.placements.push({
    nodeId: 'main/plate', kind: 'connector',
    parentNodeId: 'main/base', parentConnectorId: 'ctop#1', childConnectorId: 'cantistud#1',
  });
  cases.push({ file: 'negative-double-placement.assembly.brick.json', doc, expectCodes: ['double-placement'] });
}

// ---- 负例 3：缺引用（父节点不存在）----
{
  const doc = clone(base);
  doc.meta.name = '负例：父节点不存在';
  doc.placements[1].parentNodeId = 'main/does-not-exist';
  cases.push({ file: 'negative-missing-reference.assembly.brick.json', doc, expectCodes: ['missing-reference'] });
}

// ---- 负例 4：递归组件模板 ----
{
  const doc = clone(base);
  doc.meta.name = '负例：组件递归包含';
  doc.definitions.push({ id: 'loop', label: '自包含组件', parts: [], components: [{ instancePath: 'self', componentId: 'loop' }] });
  cases.push({ file: 'negative-recursive-template.assembly.brick.json', doc, expectCodes: ['recursive-template'] });
}

// ---- 负例 5：缺件（目录没有该零件）----
{
  const doc = clone(base);
  doc.meta.name = '负例：目录外零件';
  doc.definitions[0].parts[1].partId = '999999';
  cases.push({ file: 'negative-missing-asset.assembly.brick.json', doc, expectCodes: ['missing-asset', 'asset-lock-incomplete'] });
}

// ---- 负例 6：无连接器零件参与定位（在 test 里用 runtime 探针构造，见 test/assets-assembly.test.mjs）----

// ---- 负例 7：接口 ID 不存在 ----
{
  const doc = clone(base);
  doc.meta.name = '负例：父件接口 ID 不存在';
  doc.placements[1].parentConnectorId = 'ctop#9999';
  cases.push({ file: 'negative-unknown-connector.assembly.brick.json', doc, expectCodes: ['unknown-connector'] });
}

// ---- 负例 8：库存 token 重复占用 ----
{
  const doc = clone(base);
  doc.meta.name = '负例：同一库存 token 被两个实例占用';
  doc.definitions[0].parts[1].inventoryToken = 'tok-3001-1';
  cases.push({ file: 'negative-inventory-double-consume.assembly.brick.json', doc, expectCodes: ['inventory-double-consume'] });
}

// ---- 正例 2：组件实例复用（同一组件两次实例化）----
{
  const doc = {
    format: 'brickbuild-assembly',
    version: '0.3.0',
    meta: { name: '正例：组件模板复用（两处独立实例）', front: '+z' },
    assetLock: {
      profileId: 'default-2026-10-26',
      parts: [{ partId: '3001', revision: 'r1-curated' }, { partId: '3020', revision: 'r1-curated' }],
    },
    definitions: [
      {
        id: 'main',
        label: '主体',
        parts: [
          { instanceId: 'b1', partId: '3001', revision: 'r1-curated', color: 15, pose: { grid: [0, 0, 0], orientationId: 0 }, stepRef: 's1', inventoryToken: 't-b1' },
          { instanceId: 'b2', partId: '3001', revision: 'r1-curated', color: 15, pose: { placed: true }, stepRef: 's2', inventoryToken: 't-b2' },
        ],
        steps: [
          { id: 's1', order: 1, adds: ['main/b1'], action: { op: 'place_root' } },
          { id: 's2', order: 2, adds: ['main/b2'], action: { op: 'attach_part' } },
        ],
        components: [{ instancePath: 'hat', componentId: 'cap' }],
      },
      {
        id: 'cap',
        label: '小组件',
        parts: [
          { instanceId: 'p1', partId: '3020', revision: 'r1-curated', color: 4, pose: { grid: [0, 0, 0], orientationId: 0 }, stepRef: 's1', inventoryToken: 't-c1' },
        ],
        steps: [{ id: 's1', order: 3, adds: ['p1'], action: { op: 'attach_assembly' } }],
      },
    ],
    instances: [{ instancePath: 'car', componentId: 'main' }],
    placements: [
      { nodeId: 'car/b1', kind: 'root', baseFrame: { originLdu: [0, 0, 0], orientationId: 0, groundPlane: true } },
      { nodeId: 'car/b2', kind: 'connector', parentNodeId: 'car/b1', parentConnectorId: 'ctop#4', childConnectorId: 'cantistud#0' },
      { nodeId: 'car/hat/p1', kind: 'rigid', assemblyInstancePath: 'car/hat', anchorNodeId: 'car/hat/p1', anchorConnectorId: 'cantistud#0', parentNodeId: 'car/b2', parentConnectorId: 'ctop#0' },
    ],
    constraints: [],
    steps: [
      { id: 's1', order: 1, adds: ['car/b1'], action: { op: 'place_root' } },
      { id: 's2', order: 2, adds: ['car/b2'], action: { op: 'attach_part' } },
      { id: 's3', order: 3, adds: ['car/hat/p1'], action: { op: 'attach_assembly' } },
    ],
    inventory: [
      { token: 't-b1', partId: '3001', color: 15, qty: 1, role: 'body' },
      { token: 't-b2', partId: '3001', color: 15, qty: 1, role: 'body' },
      { token: 't-c1', partId: '3020', color: 4, qty: 1, role: 'body' },
    ],
  };
  cases.push({ file: 'positive-component-instance.assembly.brick.json', doc, expectOk: true });
}

const report = { generatedAt: new Date().toISOString(), engine: 'assembly-v1@1.0.0', cases: [] };
for (const c of cases) {
  if (!c.file) { report.cases.push({ file: null, skipped: c.skipped }); continue; }
  c.lockMissing = relock(c.doc);
  fs.writeFileSync(path.join(HERE, c.file), JSON.stringify(c.doc, null, 2) + '\n', 'utf8');
  const r = validateAssembly(c.doc, cat, { index: assetIndex });
  const codes = r.errors.map((e) => e.code);
  const pass = c.expectOk
    ? r.ok
    : c.expectCodes.some((code) => codes.includes(code));
  report.cases.push({
    file: c.file,
    kind: c.expectOk ? 'positive' : 'negative',
    expected: c.expectOk ? 'ok' : c.expectCodes,
    actualOk: r.ok,
    actualCodes: codes,
    pass,
    errorMessages: r.errors.map((e) => `${e.code}: ${e.msg}`),
  });
}

fs.writeFileSync(path.join(HERE, 'fixtures-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
const failed = report.cases.filter((c) => c.pass === false);
console.log(JSON.stringify({ cases: report.cases.length, passed: report.cases.filter((c) => c.pass === true).length, failed: failed.length, failures: failed }, null, 2));
