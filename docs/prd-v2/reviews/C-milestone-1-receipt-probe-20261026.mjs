/**
 * C-milestone-1-receipt-probe-20261026.mjs — 独立复核探针（只读评审，PRD §13.4）
 * 针对里程碑 C1 评审项 2（收据门禁 C0-4）独立伪造两条坏收据并验证拒绝原因码；
 * 同时验证真实 createBoundTaskReceipt 收据全数通过。
 * 运行：node docs/prd-v2/reviews/C-milestone-1-receipt-probe-20261026.mjs
 */
import fs from 'node:fs';
import {
  generateBuildPlan,
  auditTotalAssembly,
  createBoundTaskReceipt,
  hashString
} from '../../../src/manual-v2/workflow.js';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

const bom = JSON.parse(fs.readFileSync('examples/60239.bom.json', 'utf8'));
const plan = generateBuildPlan({}, bom, {});
const allocated = plan.taskPackages.reduce((s, t) => s + t.inventory.tokens.length, 0);
console.log(`plan.totalBOMParts=${plan.totalBOMParts} allocatedTokens=${allocated} tasks=${plan.taskPackages.length}`);

// (a) 伪造收据：revision=999 / 伪造 stateHash（64 个 a + 一个"看似合法"的随机十六进制两种形态）
{
  const target = plan.taskPackages[0];
  const forged = {
    receiptId: 'rcpt-review-forged-a',
    taskId: target.taskId,
    status: 'completed',
    revision: 999,
    stateHash: 'a'.repeat(64),
    signedBy: 'x',
    consumedTokens: target.inventory.tokens.map(t => ({ tokenId: t.tokenId, partId: t.partId, colorId: t.colorId }))
  };
  const receipts = plan.taskPackages.map(t => (t.taskId === target.taskId ? forged : createBoundTaskReceipt(t)));
  const audit = auditTotalAssembly(plan, receipts);
  const need = ['RECEIPT_REVISION_MISMATCH', 'RECEIPT_STATEHASH_UNBOUND'];
  const ok = audit.ok === false && need.every(c => audit.reasonCodes.includes(c));
  record('(a1) revision=999/stateHash=64a 伪造收据被拒', ok,
    `ok=${audit.ok} reasonCodes=${audit.reasonCodes.join(',')} binding=${audit.receiptAudit.find(x => x.taskId === target.taskId)?.binding}`);
}
{
  const target = plan.taskPackages[0];
  const forged = createBoundTaskReceipt(target);
  delete forged.state;
  forged.stateHash = hashString('review-forged-random-looking-hash');
  const receipts = plan.taskPackages.map(t => (t.taskId === target.taskId ? forged : createBoundTaskReceipt(t)));
  const audit = auditTotalAssembly(plan, receipts);
  const ok = audit.ok === false && audit.reasonCodes.includes('RECEIPT_STATEHASH_UNBOUND');
  record('(a2) 无状态证据的随机十六进制 stateHash 被拒', ok, `reasonCodes=${audit.reasonCodes.join(',')}`);
}

// (b) plan 声明 totalBOMParts=999 而实际分配 91 件
{
  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.totalBOMParts = 999;
  const audit = auditTotalAssembly(tampered, plan.taskPackages.map(t => createBoundTaskReceipt(t)));
  const ok = audit.ok === false && audit.reasonCodes.includes('PLAN_BOM_TOTAL_MISMATCH')
    && audit.errors.some(m => m.includes('999'));
  record('(b) totalBOMParts=999 vs 分配 91 被拒', ok, `reasonCodes=${audit.reasonCodes.join(',')} errors=${JSON.stringify(audit.errors).slice(0, 200)}`);
}

// (c) 真实 createBoundTaskReceipt 构造的收据全数通过
{
  const audit = auditTotalAssembly(plan, plan.taskPackages.map(t => createBoundTaskReceipt(t)));
  const allVerified = audit.receiptAudit.every(e => e.binding === 'bound' || e.binding === 'verified');
  record('(c) 真实绑定收据审计通过', audit.ok === true && allVerified,
    `ok=${audit.ok} reasonCodes=${audit.reasonCodes.join(',') || '(none)'} bindings=${[...new Set(audit.receiptAudit.map(e => e.binding))].join(',')}`);
}

fs.writeFileSync('docs/prd-v2/reviews/C-milestone-1-receipt-probe-result-20261026.json',
  JSON.stringify({ probe: 'receipt-gating-forgery', at: new Date().toISOString(), allPass: results.every(r => r.ok), results }, null, 2));
console.log(results.every(r => r.ok) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(r => r.ok) ? 0 : 1);
