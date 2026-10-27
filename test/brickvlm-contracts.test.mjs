import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const datasetDir = fs.existsSync('out/prd-v2/run-20261026-v4/B/dataset')
  ? 'out/prd-v2/run-20261026-v4/B/dataset'
  : (fs.existsSync('out/prd-v2/run-20261026-v3/B/dataset') ? 'out/prd-v2/run-20261026-v3/B/dataset' : 'out/prd-v2/run-20261026-v2/B/dataset');

test('ML-01: 模型族级划分严禁跨 Split 泄漏与结构去重', () => {
  const train = JSON.parse(fs.readFileSync(path.join(datasetDir, 'train.json'), 'utf8'));
  const val = JSON.parse(fs.readFileSync(path.join(datasetDir, 'validation.json'), 'utf8'));
  const holdout = JSON.parse(fs.readFileSync(path.join(datasetDir, 'holdout_test.json'), 'utf8'));

  const trainModels = new Set(train.map(s => s.provenance.sourceModelId));
  const valModels = new Set(val.map(s => s.provenance.sourceModelId));
  const holdoutModels = new Set(holdout.map(s => s.provenance.sourceModelId));

  // 1. 验证集与训练集模型互斥
  for (const m of valModels) {
    assert.equal(trainModels.has(m), false, `验证集模型 ${m} 泄漏到了训练集！`);
  }

  // 2. 留出测试集与训练集模型严格互斥
  for (const m of holdoutModels) {
    assert.equal(trainModels.has(m), false, `留出测试集模型 ${m} 泄漏到了训练集！`);
    assert.equal(valModels.has(m), false, `留出测试集模型 ${m} 泄漏到了验证集！`);
  }

  // 3. 60239 开发样例严禁出现在训练集与留出测试集
  assert.equal(trainModels.has('60239'), false, '60239 绝不能进入训练集');
  assert.equal(holdoutModels.has('60239'), false, '60239 绝不能充当留出测试集');
});

test('ML-02: 样本契约完整性与候选覆盖校验', () => {
  const holdout = JSON.parse(fs.readFileSync(path.join(datasetDir, 'holdout_test.json'), 'utf8'));
  assert.ok(holdout.length >= 100, '留出集样本数量应充足');

  for (const s of holdout) {
    assert.ok(s.sampleId.startsWith('smp-'));
    assert.equal(s.protocolVersion, '1.0');
    assert.ok(['understand_step', 'understand_structure', 'select_action', 'repair_local'].includes(s.taskType));
    assert.ok(s.stateRef.stateHash, '每个样本必须绑定权威 stateHash');

    if (s.taskType === 'select_action' || s.taskType === 'repair_local') {
      const cands = s.candidates.items.map(c => c.candidateId);
      const targetCid = s.target.primaryAction.selectedCandidateId;
      assert.ok(cands.includes(targetCid), `目标动作 ${targetCid} 必须在枚举候选中覆盖`);
    }
  }
});
