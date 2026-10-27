import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractManualObservations } from '../src/manual-v2/extractor.js';
import {
  createAcceptanceCriteria,
  generateBuildPlan,
  recordTrialMountReceipt,
  createBoundTaskReceipt,
  auditTotalAssembly
} from '../src/manual-v2/workflow.js';

test('extractManualObservations：从说明书事实独立提取 60239 关键步骤', async () => {
  const result = await extractManualObservations('assets/instructions-lego/60239_book1.pdf', {
    bomFile: 'examples/60239.bom.json'
  });

  assert.equal(result.format, 'brickkit-manual-observations');
  assert.equal(result.meta.setId, '60239-1');
  assert.equal(result.sourceDocument.totalPages, 36);
  assert.ok(result.observations.length >= 6);

  // 核对人仔步骤
  const minifigObs = result.observations.filter(o => o.submodelRef === 'minifig');
  assert.equal(minifigObs.length, 2);
  assert.equal(minifigObs[0].page, 2);

  // 核对配件（雪糕筒）
  const coneObs = result.observations.find(o => o.submodelRef === 'cones');
  assert.ok(coneObs);
  assert.equal(coneObs.page, 3);
  assert.equal(coneObs.repeatCount, 2);

  // 核对总装事件（例如第 32 页车轮总装挂装到底盘）
  const attachEvent = result.observations.find(o => o.isAssemblyEvent && o.stepNumber === 45);
  assert.ok(attachEvent);
  assert.equal(attachEvent.submodelRef, 'wheels');
});

test('createAcceptanceCriteria：冻结 60239 91 件官方 BOM 守恒标准', () => {
  const crit = createAcceptanceCriteria('60239-1');
  assert.equal(crit.criteria.totalPartsAuthoritative, 91);
  assert.equal(crit.criteria.partAllocation.carBodyParts, 83);
  assert.equal(crit.criteria.partAllocation.accessoriesParts, 8);
  assert.equal(crit.criteria.reachability.requireCarBodyReachableToRoot, true);
});

test('generateBuildPlan：零件 Token 严格守恒分发 (91 件 = 71 主体 + 4 保险杠 + 8 车轮 + 4 人仔 + 4 配件)', () => {
  const bom = JSON.parse(fs.readFileSync('examples/60239.bom.json', 'utf8'));
  const observations = { observations: [] };
  const plan = generateBuildPlan(observations, bom);

  assert.equal(plan.totalBOMParts, 91);
  assert.equal(plan.taskPackages.length, 5);

  let sumTokens = 0;
  for (const t of plan.taskPackages) {
    sumTokens += t.inventory.totalCount;
    assert.equal(t.inventory.tokens.length, t.inventory.totalCount);
  }
  // 5 个独立任务包的零件份额求和严格等于官方 BOM 91 件
  assert.equal(sumTokens, 91);
  // 任务包盖章 contractRevision，供收据门禁做版本真实绑定 (C0-4)
  assert.equal(typeof plan.contractRevision, 'string');
  assert.ok(plan.contractRevision.length > 0);
  for (const t of plan.taskPackages) {
    assert.equal(t.contractRevision, plan.contractRevision);
  }
});

test('auditTotalAssembly：真实绑定收据与全要素总装守恒审计', () => {
  const bom = JSON.parse(fs.readFileSync('examples/60239.bom.json', 'utf8'));
  const plan = generateBuildPlan({}, bom);

  // 各任务返回与任务包真实绑定的收据（revision/contractRevision/stateHash 复算/声明件数/Token 全部对得上）
  const receipts = plan.taskPackages.map(t => createBoundTaskReceipt(t));

  const auditSuccess = auditTotalAssembly(plan, receipts);
  assert.equal(auditSuccess.ok, true);
  assert.equal(auditSuccess.isConserved, true);
  assert.equal(auditSuccess.totalConsumedTokens, 91);
  assert.equal(auditSuccess.receiptBinding, 'verified');
  assert.deepEqual(auditSuccess.errors, []);
  assert.ok(auditSuccess.receiptAudit.every(x => x.binding === 'verified'));

  // 负例测试：如果一个 Token 被重复消费
  const badReceipts = JSON.parse(JSON.stringify(receipts));
  badReceipts[0].consumedTokens.push(badReceipts[1].consumedTokens[0]);

  const auditFail = auditTotalAssembly(plan, badReceipts);
  assert.equal(auditFail.ok, false);
  assert.equal(auditFail.isConserved, false);
  assert.equal(auditFail.duplicateTokens > 0, true);
  assert.ok(auditFail.reasonCodes.includes('RECEIPT_TOKEN_DUPLICATE'));
});
