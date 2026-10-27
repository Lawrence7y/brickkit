/**
 * C-milestone-1-indep-receipt-probe-20261026.mjs — independent reviewer probe (read-only, PRD §13.4).
 * Forges two bad receipts against REAL src/manual-v2/workflow.js exports:
 *   (a) revision 999 + fake 64-hex stateHash, no state evidence  -> must be rejected
 *   (b) plan totalBOMParts = 999 vs 91 actually allocated         -> must be rejected
 * CPU only. Run: node docs/prd-v2/reviews/C-milestone-1-indep-receipt-probe-20261026.mjs
 */
import fs from 'node:fs';
import {
  generateBuildPlan,
  auditTotalAssembly,
  createBoundTaskReceipt
} from '../../../src/manual-v2/workflow.js';

const bom = JSON.parse(fs.readFileSync('examples/60239.bom.json', 'utf8'));
const out = { probe: 'receipt-gating-independent-20261026', cases: [] };

const plan = generateBuildPlan({}, bom, { engineRevision: 'probe-engine-rev' });
const allocated = plan.taskPackages.reduce((n, t) => n + (t.inventory?.tokens?.length || 0), 0);
const goodReceipts = plan.taskPackages.map((t) => createBoundTaskReceipt(t));
const goodAudit = auditTotalAssembly(plan, goodReceipts);

out.goodPath = {
  declaredTotalBOMParts: plan.totalBOMParts,
  allocatedTokens: allocated,
  taskCount: plan.taskPackages.length,
  auditOk: goodAudit.ok,
  reasonCodes: goodAudit.reasonCodes
};

// (a) forged revision 999 + fake stateHash, no inline state / stateFile
{
  const target = plan.taskPackages[0];
  const forged = {
    receiptId: 'rcpt-indep-a',
    taskId: target.taskId,
    status: 'completed',
    revision: 999,
    stateHash: 'b'.repeat(64),
    signedBy: 'x',
    consumedTokens: target.inventory.tokens.map((t) => ({
      tokenId: t.tokenId, partId: t.partId, colorId: t.colorId
    }))
  };
  const receipts = plan.taskPackages.map((t) =>
    t.taskId === target.taskId ? forged : createBoundTaskReceipt(t)
  );
  const audit = auditTotalAssembly(plan, receipts);
  const entry = audit.receiptAudit?.find((x) => x.taskId === target.taskId);
  out.cases.push({
    id: 'a_revision999_fake_stateHash',
    targetTaskId: target.taskId,
    auditOk: audit.ok,
    rejected: audit.ok === false,
    reasonCodes: audit.reasonCodes,
    targetBinding: entry?.binding ?? null,
    requiredCodesPresent: ['RECEIPT_REVISION_MISMATCH', 'RECEIPT_STATEHASH_UNBOUND']
      .every((c) => audit.reasonCodes.includes(c))
  });
}

// (a2) worse forgery: revision valid but stateHash is a random 64-hex with NO state evidence
{
  const target = plan.taskPackages[1] || plan.taskPackages[0];
  const forged = {
    receiptId: 'rcpt-indep-a2',
    taskId: target.taskId,
    status: 'completed',
    revision: target.revision,
    stateHash: 'c'.repeat(64),
    signedBy: 'subagent-builder',
    sessionEvidence: { conversationId: 'sess-forged', agentRole: 'subagent-builder' },
    consumedTokens: target.inventory.tokens.map((t) => ({
      tokenId: t.tokenId, partId: t.partId, colorId: t.colorId
    }))
  };
  const receipts = plan.taskPackages.map((t) =>
    t.taskId === target.taskId ? forged : createBoundTaskReceipt(t)
  );
  const audit = auditTotalAssembly(plan, receipts);
  out.cases.push({
    id: 'a2_valid_revision_fake_stateHash_no_evidence',
    targetTaskId: target.taskId,
    auditOk: audit.ok,
    rejected: audit.ok === false,
    reasonCodes: audit.reasonCodes,
    requiredCodesPresent: audit.reasonCodes.includes('RECEIPT_STATEHASH_UNBOUND')
  });
}

// (b) plan declares 999 parts, actual allocation is 91
{
  const badPlan = { ...plan, totalBOMParts: 999 };
  const audit = auditTotalAssembly(badPlan, goodReceipts);
  out.cases.push({
    id: 'b_plan_totalBOM_999_vs_91',
    declared: 999,
    allocated,
    auditOk: audit.ok,
    rejected: audit.ok === false,
    reasonCodes: audit.reasonCodes,
    requiredCodesPresent: audit.reasonCodes.includes('PLAN_BOM_TOTAL_MISMATCH')
  });
}

out.summary = {
  goodPathPasses: goodAudit.ok === true,
  allocatedIs91: allocated === 91,
  allBadReceiptsRejected: out.cases.every((c) => c.rejected && c.requiredCodesPresent)
};
console.log(JSON.stringify(out, null, 2));
