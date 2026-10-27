// AS-05 序列化等价（HANDOFF-C §3 C3-4 / PRD v2 AS-05，原 A 报告记 partial）：
//   ① 100 次连续 recompute 零漂移（真实 60239.fixed：91 件、83 条 snap 依赖、SNOT + 轮件 + 人仔）；
//   ② save/load（JSON 往返）后再 recompute：与保存前逐位一致，stateHash 一致；
//   ③ 0.3 → compileToLegacy 编译确定性：同源两次编译逐位一致、编译产物 core.validate 零错误、
//      编译产物 save/load 后 stateHash 一致；数值差在冻结容差 profile（transformEpsLdu 1e-6 LDU）内。
// 证据写入 out/prd-v2/run-20261026-c/C/engine/as05-serialization.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recompute, validate } from '../src/core/core.js';
import { inspectFromModel } from '../src/core/actions-v1/state.js';
import { compileToLegacy } from '../src/core/assembly-v1/compile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_OUT = path.join(ROOT, 'out', 'prd-v2', 'run-20261026-c', 'C', 'engine');

const cat = {
  parts: {
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts,
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts,
  },
  colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors,
};
const FIXED_PATH = path.join(ROOT, 'out/prd-v2/run-20261026-c/C/integration/60239/60239.fixed.brick.json');
const clone = (m) => JSON.parse(JSON.stringify(m));
const PLATE_LDU = 8, STUD_LDU = 20;

test('AS-05 ① 60239.fixed 连续 100 次 recompute 零漂移（模型 JSON 与 stateHash 逐字节一致）', () => {
  const original = clone(JSON.parse(fs.readFileSync(FIXED_PATH, 'utf8')));
  const first = clone(original);
  recompute(first, cat);
  const baselineJson = JSON.stringify(first);
  const baselineHash = inspectFromModel(clone(first), cat, { mainRootNodeId: 'p001' }).stateHash;
  assert.equal(first.parts.length, 91);

  const hashes = [baselineHash];
  for (let i = 1; i < 100; i++) {
    const model = clone(original);
    recompute(model, cat);                       // 从同一权威源第 i 次重算
    const json = JSON.stringify(model);
    assert.equal(json, baselineJson, `第 ${i + 1} 次重算的模型 JSON 与第 1 次不一致`);
    const h = inspectFromModel(model, cat, { mainRootNodeId: 'p001' }).stateHash;
    assert.equal(h, baselineHash, `第 ${i + 1} 次重算的 stateHash 与第 1 次不一致`);
    hashes.push(h);
    // 幂等：对已求解模型原地再算一次不改变任何坐标
    recompute(model, cat);
    assert.equal(JSON.stringify(model), json, `第 ${i + 1} 轮原地重算改变了模型`);
  }
  fs.mkdirSync(ENGINE_OUT, { recursive: true });
  fs.writeFileSync(path.join(ENGINE_OUT, 'as05-recompute-100x.json'), JSON.stringify({
    gate: 'AS-05', item: '100x-recompute-drift',
    model: 'out/prd-v2/run-20261026-c/C/integration/60239/60239.fixed.brick.json',
    parts: 91, snapDeps: original.parts.filter((p) => p.snap && p.snap.on).length,
    iterations: 100, allJsonByteIdentical: true, allStateHashIdentical: true,
    stateHashFirst: baselineHash, stateHashes: hashes,
  }, null, 2) + '\n');
});

test('AS-05 ② save/load（JSON 往返）后 recompile 与保存前逐位等价', () => {
  const model = clone(JSON.parse(fs.readFileSync(FIXED_PATH, 'utf8')));
  recompute(model, cat);
  const beforeJson = JSON.stringify(model);
  const beforeHash = inspectFromModel(clone(model), cat, { mainRootNodeId: 'p001' }).stateHash;

  // 保存 → 读取（模拟落盘/网络）
  const saved = fs.mkdtempSync(path.join(ENGINE_OUT, 'as05-tmp-'));
  const file = path.join(saved, 'roundtrip.brick.json');
  fs.mkdirSync(ENGINE_OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(JSON.parse(beforeJson)));   // 紧凑写盘（无格式化）
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));

  recompute(loaded, cat);
  const afterJson = JSON.stringify(loaded);
  const afterHash = inspectFromModel(clone(loaded), cat, { mainRootNodeId: 'p001' }).stateHash;
  assert.equal(afterJson, beforeJson, 'save/load 后模型 JSON 不等价');
  assert.equal(afterHash, beforeHash, 'save/load 后 stateHash 不一致');
  // 编译口径（compileToLegacy 是 0.3 入口，0.2 模型直接做 inspect 等价已覆盖；此处再对逐件几何严格断言）
  const v = validate(loaded, cat);
  assert.equal(v.ok, true);
  assert.equal(v.errors.length, 0);
  assert.equal(v.warnings.length, 0);
  fs.rmSync(saved, { recursive: true, force: true });
});

test('AS-05 ③ 0.3 冻结夹具编译确定性 + 编译产物 save/load 等价（profile 容差内）', () => {
  const fixtures = [
    'docs/prd-v2/implementation-A/contracts/fixtures/assembly-minimal.assembly.brick.json',
    'docs/prd-v2/implementation-A/contracts/fixtures/positive-component-instance.assembly.brick.json',
  ];
  const report = [];
  for (const rel of fixtures) {
    const srcText = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const srcA = JSON.parse(srcText);
    const c1 = compileToLegacy(clone(srcA), cat);
    assert.equal(c1.ok, true, `${rel} 编译失败：${JSON.stringify(c1.problems || []).slice(0, 400)}`);
    const c2 = compileToLegacy(JSON.parse(srcText), cat);   // 全新解析的同一源
    assert.equal(c2.ok, true);
    const s1 = JSON.stringify(c1.snapshot), s2 = JSON.stringify(c2.snapshot);
    assert.equal(s1, s2, `${rel} 两次编译产物不一致`);

    // 编译产物过 core.validate（与 validateAssembly 同一几何真值）
    const v = validate(clone(c1.snapshot), cat);
    assert.equal(v.ok, true, `${rel} 编译产物 validate 未通过：${JSON.stringify(v.errors).slice(0, 300)}`);

    // 编译产物 save/load：stateHash 必须一致
    const h1 = inspectFromModel(clone(c1.snapshot), cat, { mainRootNodeId: c1.snapshot.parts[0].id }).stateHash;
    const loaded = JSON.parse(JSON.stringify(c1.snapshot));
    const h2 = inspectFromModel(loaded, cat, { mainRootNodeId: loaded.parts[0].id }).stateHash;
    assert.equal(h2, h1, `${rel} 编译产物 save/load 后 stateHash 不一致`);

    // 数值口径：全部零件中心（LDU）与再次编译结果差 ≤ transformEpsLdu（contracts-1.0 冻结 1e-6）
    const c3 = compileToLegacy(clone(srcA), cat);
    let maxD = 0;
    for (let i = 0; i < c1.snapshot.parts.length; i++) {
      const a = c1.snapshot.parts[i], b = c3.snapshot.parts[i];
      assert.equal(a.id, b.id);
      const d = Math.max(
        Math.abs(a.at[0] - b.at[0]) * STUD_LDU,
        Math.abs(a.at[1] - b.at[1]) * PLATE_LDU,
        Math.abs(a.at[2] - b.at[2]) * STUD_LDU,
      );
      if (d > maxD) maxD = d;
    }
    assert.ok(maxD <= 1e-6, `${rel} 重编译最大中心差 ${maxD} LDU 超出 transformEpsLdu 1e-6`);
    report.push({ fixture: rel, parts: c1.snapshot.parts.length, maxRecompileDeltaLdu: maxD, stateHash: h1 });
  }
  fs.mkdirSync(ENGINE_OUT, { recursive: true });
  fs.writeFileSync(path.join(ENGINE_OUT, 'as05-serialization.json'), JSON.stringify({
    gate: 'AS-05', item: 'save-load-compile-equivalence',
    toleranceProfile: 'default-2026-10-26', transformEpsLdu: 1e-6,
    fixtures: report, verdict: 'verified',
  }, null, 2) + '\n');
});
