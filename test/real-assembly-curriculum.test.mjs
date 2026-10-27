/**
 * test/real-assembly-curriculum.test.mjs
 *
 * 真实装配状态闭环最小样例集 (Real Assembly Curriculum) 契约测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/core/core.js';
import { checkAssetLock } from '../src/core/assets-v1/lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const CURRICULUM_DIR = path.join(ROOT, 'out/prd-v2/run-20261026-v4/B/real-assembly-curriculum');

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(CURRICULUM_DIR, rel), 'utf8'));
}

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

test('Real Assembly Curriculum: 完整性与三大真实装配范式覆盖 (15 例)', () => {
  const manifest = readJSON('curriculum-manifest.json');
  assert.equal(manifest.totalCases, 15, '应包含严格 15 个样例');
  assert.equal(manifest.cases.length, 15);

  const categories = { basic_stack: 0, snot: 0, subassembly: 0 };
  for (const c of manifest.cases) {
    assert.ok(categories[c.category] !== undefined, `未知范式: ${c.category}`);
    categories[c.category]++;
  }

  assert.equal(categories.basic_stack, 5, '应包含 5 个常规堆叠样例');
  assert.equal(categories.snot, 5, '应包含 5 个 SNOT 侧装样例');
  assert.equal(categories.subassembly, 5, '应包含 5 个刚体子组件挂装样例');
});

test('Real Assembly Curriculum: 真实模型落盘与零穿模零错误验证收据', () => {
  const manifest = readJSON('curriculum-manifest.json');
  const cat = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'))), colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'))).colors };

  for (const c of manifest.cases) {
    const stPath = path.join(CURRICULUM_DIR, c.state_t.path);
    const snPath = path.join(CURRICULUM_DIR, c.state_next.path);

    assert.ok(fs.existsSync(stPath), `S_t 模型文件不存在: ${stPath}`);
    assert.ok(fs.existsSync(snPath), `S_(t+1) 模型文件不存在: ${snPath}`);

    assert.equal(sha256File(stPath), c.state_t.sha256, 'S_t SHA256 不匹配');
    assert.equal(sha256File(snPath), c.state_next.sha256, 'S_(t+1) SHA256 不匹配');

    assert.equal(c.builderReceipt.status, 'verified_zero_error');
    assert.equal(c.builderReceipt.collisions, 0);
    assert.equal(c.builderReceipt.floating, 0);
    assert.equal(c.builderReceipt.warnings, 0);
    assert.equal(c.builderReceipt.ok, true);

    const v_t = validate(JSON.parse(fs.readFileSync(stPath, 'utf8')), cat);
    const v_next = validate(JSON.parse(fs.readFileSync(snPath, 'utf8')), cat);
    assert.equal(v_t.errors.length, 0, `S_t 存在校验错误: ${JSON.stringify(v_t.errors)}`);
    assert.equal(v_t.warnings.length, 0, `S_t 存在业务警告: ${JSON.stringify(v_t.warnings)}`);
    assert.equal(v_next.errors.length, 0, `S_next 存在校验错误: ${JSON.stringify(v_next.errors)}`);
    assert.equal(v_next.warnings.length, 0, `S_next 存在业务警告: ${JSON.stringify(v_next.warnings)}`);
  }
});

test('Real Assembly Curriculum: 30 张渲染图全部存在且 100% 独立内容哈希', () => {
  const manifest = readJSON('curriculum-manifest.json');
  const seenHashes = new Set();

  for (const c of manifest.cases) {
    const imgT = path.join(CURRICULUM_DIR, c.images.state_t.path);
    const imgNext = path.join(CURRICULUM_DIR, c.images.target.path);

    assert.ok(fs.existsSync(imgT), `S_t 渲染图不存在: ${imgT}`);
    assert.ok(fs.existsSync(imgNext), `目标渲染图不存在: ${imgNext}`);

    const shaT = sha256File(imgT);
    const shaNext = sha256File(imgNext);

    assert.equal(shaT, c.images.state_t.sha256);
    assert.equal(shaNext, c.images.target.sha256);

    seenHashes.add(shaT);
    seenHashes.add(shaNext);
  }

  assert.equal(seenHashes.size, 30, `30 张渲染图像哈希必须完全唯一，实际: ${seenHashes.size}`);
});

test('Real Assembly Curriculum: 候选匿名化、姿态契约 (0..23) 与等价动作集合', () => {
  const samples = readJSON('curriculum-samples.json');
  const datasetSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/prd-v2/implementation-B/contracts/dataset.schema.json'), 'utf8'));

  for (const s of samples) {
    // 1. 验证 C3 顶层 11 项必填字段
    for (const reqField of datasetSchema.required) {
      assert.ok(reqField in s, `样本 ${s.sampleId} 缺少必填字段: ${reqField}`);
    }

    // 2. 候选匿名化：绝无 cand_target 或 cand_dist 命名
    for (const c of s.candidates.items) {
      assert.match(c.candidateId, /^cand_[1-4]$/, `候选 ID 必须匿名化 (cand_1..4)，实际: ${c.candidateId}`);
      assert.ok(c.candidateId !== 'cand_target', '候选 ID 绝不能叫 cand_target');
      assert.ok(Number.isInteger(c.orientationId) && c.orientationId >= 0 && c.orientationId <= 23,
        `orientationId 必须为 0..23 整数，实际: ${c.orientationId}`);
      assert.ok(!('isTarget' in c), '模型输入的候选对象严禁携带 isTarget 字段');
    }

    // 3. 等价候选集合：必须为非空数组且包含 selectedCandidateId
    assert.ok(Array.isArray(s.target.equivalentCandidates), 'equivalentCandidates 必须为数组');
    assert.ok(s.target.equivalentCandidates.length >= 1);
    assert.ok(s.target.equivalentCandidates.includes(s.target.primaryAction.selectedCandidateId),
      'equivalentCandidates 必须包含 selectedCandidateId');
  }
});

test('R-02 Regression: 光面板 (2431) 绝不能被凸点板 (3710) 替代为等价候选', () => {
  const manifest = readJSON('curriculum-manifest.json');
  const c4 = manifest.cases.find(c => c.caseId === 'case_stack_04');
  assert.ok(c4, '必须存在 case_stack_04');

  const tileTargetCand = c4.candidates.find(c => c.childPartId === '2431' && c.executionReceipt.status === 'success');
  const plateDistCand = c4.candidates.find(c => c.childPartId === '3710');

  assert.ok(tileTargetCand, '2431 目标动作应执行成功');
  assert.ok(plateDistCand, '必须存在 3710 候选干扰项');

  // 3710 绝不能是 success，也绝不能被列为等价候选
  assert.equal(plateDistCand.executionReceipt.status, 'target_mismatch');
  assert.equal(plateDistCand.executionReceipt.sameMaterialBoxesAsTarget, false);
  assert.equal(c4.targetAction.equivalentCandidates.includes(plateDistCand.candidateId), false,
    `3710 候选 ${plateDistCand.candidateId} 绝不能出现在 equivalentCandidates 中`);
});

test('R-02 Regression: 格栅 (2412b) 绝不能被普通板 (3023) 替代为等价候选', () => {
  const manifest = readJSON('curriculum-manifest.json');
  const c7 = manifest.cases.find(c => c.caseId === 'case_snot_02');
  assert.ok(c7, '必须存在 case_snot_02');

  const grilleTargetCand = c7.candidates.find(c => c.childPartId === '2412b' && c.executionReceipt.status === 'success');
  const plateDistCand = c7.candidates.find(c => c.childPartId === '3023');

  assert.ok(grilleTargetCand, '2412b 目标动作应执行成功');
  assert.ok(plateDistCand, '必须存在 3023 候选干扰项');

  // 3023 绝不能是 success，也绝不能被列为等价候选
  assert.equal(plateDistCand.executionReceipt.status, 'target_mismatch');
  assert.equal(plateDistCand.executionReceipt.sameMaterialBoxesAsTarget, false);
  assert.equal(c7.targetAction.equivalentCandidates.includes(plateDistCand.candidateId), false,
    `3023 候选 ${plateDistCand.candidateId} 绝不能出现在 equivalentCandidates 中`);
});

test('R-02 Regression: 相同锚点但少一件组件成员的单件候选绝不能被判为等价候选', () => {
  const manifest = readJSON('curriculum-manifest.json');
  const subasmCases = manifest.cases.filter(c => c.category === 'subassembly');
  assert.equal(subasmCases.length, 5, '应覆盖全部 5 个子组件样例');

  for (const c of subasmCases) {
    const singlePartCand = c.candidates.find(cand => !cand.isAssembly);
    assert.ok(singlePartCand, `${c.caseId} 必须包含只放锚点零件的单件对比候选`);

    // 单件候选缺少成员，必须被标为 target_mismatch 且包含件数缺失诊断
    assert.equal(singlePartCand.executionReceipt.status, 'target_mismatch');
    assert.equal(singlePartCand.executionReceipt.sameMaterialBoxesAsTarget, false);
    assert.ok(singlePartCand.executionReceipt.outcome.includes('part_count_mismatch'),
      `单件候选执行结果应诊断为件数不匹配，实际: ${singlePartCand.executionReceipt.outcome}`);

    // 严禁进入等价候选集合
    assert.equal(c.targetAction.equivalentCandidates.includes(singlePartCand.candidateId), false,
      `${c.caseId} 的单件候选 ${singlePartCand.candidateId} 绝不能进入 equivalentCandidates`);
  }
});

test('REQ-A02: 真实资产锁与任务包全要素契约核验', () => {
  const planPath = path.join(ROOT, 'out/prd-v2/run-20261026-v4/B/60239.build.plan.json');
  assert.ok(fs.existsSync(planPath), '60239 规划文件必须存在');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  const assetIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/assets-v1/index.json'), 'utf8'));

  for (const task of plan.taskPackages) {
    const requiredPartIds = [...new Set(task.inventory.tokens.map(t => t.partId))];
    const checkRes = checkAssetLock(task, { index: assetIndex, requiredPartIds });

    assert.equal(checkRes.ok, true, `任务包 ${task.taskId} 资产锁核验失败: ${JSON.stringify(checkRes.errors)}`);
    assert.equal(checkRes.errors.length, 0);
    assert.equal(checkRes.warnings.length, 0);
    assert.equal(checkRes.verifiedCount, requiredPartIds.length, `任务包 ${task.taskId} 资产锁锁定件数与实际需求一致`);
  }
});
