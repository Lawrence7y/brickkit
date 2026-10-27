/**
 * test/receipt-gating.test.mjs — C0-4 收据门禁回归测试
 *
 * 复现 Task-B v4 复核（docs/prd-v2/reviews/Task-B-v4-review-2026-10-26.md §3）的两条反例，
 * 断言它们被 auditTotalAssembly 以明确原因码拒绝；并验证真实绑定收据的正向通路：
 *   反例 3.1  revision=999 / stateHash=64个'a' / signedBy='x' 的伪造收据曾被接受
 *             → 现以 RECEIPT_REVISION_MISMATCH + RECEIPT_STATEHASH_UNBOUND + RECEIPT_EVIDENCE_MISSING 拒绝
 *   反例 3.2  声明 totalBOMParts=999 而实际分配 91 件曾通过
 *             → 现以 PLAN_BOM_TOTAL_MISMATCH 拒绝（收据级声明件数错报以 RECEIPT_PART_COUNT_MISMATCH 拒绝）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateBuildPlan,
  auditTotalAssembly,
  createBoundTaskReceipt,
  fileSha256,
  hashString
} from '../src/manual-v2/workflow.js';
import { stateHashOf } from '../src/core/actions-v1/state.js';

function freshPlan(options = {}) {
  const bom = JSON.parse(fs.readFileSync('examples/60239.bom.json', 'utf8'));
  return generateBuildPlan({}, bom, options);
}

function boundReceiptsFor(plan) {
  return plan.taskPackages.map(t => createBoundTaskReceipt(t));
}

test('v4 反例 3.1：revision=999 / stateHash=64个a / signedBy=x 的伪造收据被拒', () => {
  const plan = freshPlan();
  const target = plan.taskPackages[0];

  // 与 v4 复核 §3.1 完全同构的收据：taskId 真实、Token 全部合法，但版本/哈希/签名全是伪造占位
  const forged = {
    receiptId: 'rcpt-forged-ce1',
    taskId: target.taskId,
    status: 'completed',
    revision: 999,
    stateHash: 'a'.repeat(64),
    signedBy: 'x',
    consumedTokens: target.inventory.tokens.map(t => ({ tokenId: t.tokenId, partId: t.partId, colorId: t.colorId }))
  };
  const receipts = plan.taskPackages.map(t => (t.taskId === target.taskId ? forged : createBoundTaskReceipt(t)));

  const audit = auditTotalAssembly(plan, receipts);
  assert.equal(audit.ok, false, '伪造收据必须被拒');
  for (const code of ['RECEIPT_REVISION_MISMATCH', 'RECEIPT_STATEHASH_UNBOUND', 'RECEIPT_EVIDENCE_MISSING']) {
    assert.ok(audit.reasonCodes.includes(code), `缺少原因码 ${code}（实际: ${audit.reasonCodes.join(',')}）`);
  }
  const entry = audit.receiptAudit.find(x => x.taskId === target.taskId);
  assert.equal(entry.binding, 'unverified');
});

test('v4 反例 3.1 变体：看似合法的随机 64 位十六进制 stateHash（无状态证据）同样被拒', () => {
  const plan = freshPlan();
  const target = plan.taskPackages[0];
  const forged = createBoundTaskReceipt(target);
  delete forged.state;                      // 抹掉可复算的状态证据
  forged.stateHash = hashString('forged');  // 换成"看起来完全合法"的 64 位十六进制

  const receipts = plan.taskPackages.map(t => (t.taskId === target.taskId ? forged : createBoundTaskReceipt(t)));
  const audit = auditTotalAssembly(plan, receipts);
  assert.equal(audit.ok, false);
  assert.ok(audit.reasonCodes.includes('RECEIPT_STATEHASH_UNBOUND'),
    `旧门禁只看格式会放行此收据；必须以 STATEHASH_UNBOUND 拒绝（实际: ${audit.reasonCodes.join(',')}）`);
});

test('v4 反例 3.2：totalBOMParts=999 与实际分配 91 件不一致被拒', () => {
  const plan = freshPlan();
  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.totalBOMParts = 999; // 分配仍为 91 件（71+4+8+4+4）

  const audit = auditTotalAssembly(tampered, boundReceiptsFor(plan));
  assert.equal(audit.ok, false, '声明件数与实际分配不一致必须被拒');
  assert.ok(audit.reasonCodes.includes('PLAN_BOM_TOTAL_MISMATCH'),
    `缺少原因码 PLAN_BOM_TOTAL_MISMATCH（实际: ${audit.reasonCodes.join(',')}）`);
  assert.ok(audit.errors.some(msg => msg.includes('999') && msg.includes('91')));
});

test('v4 反例 3.2 收据级形态：收据声明件数 999 而任务包实际分配 8 件被拒', () => {
  const plan = freshPlan();
  const receipts = boundReceiptsFor(plan);
  const wheels = receipts.find(r => r.taskId === 'task-wheels');
  wheels.declaredPartCount = 999; // 实际分配 8 件

  const audit = auditTotalAssembly(plan, receipts);
  assert.equal(audit.ok, false);
  assert.ok(audit.reasonCodes.includes('RECEIPT_PART_COUNT_MISMATCH'),
    `缺少原因码 RECEIPT_PART_COUNT_MISMATCH（实际: ${audit.reasonCodes.join(',')}）`);
});

test('任务包 totalCount 与真实 Token 数不一致被拒（PACKAGE_COUNT_MISMATCH）', () => {
  const plan = freshPlan();
  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.totalBOMParts = tampered.taskPackages.reduce((s, t) => s + t.inventory.totalCount, 0);
  const wheels = tampered.taskPackages.find(t => t.taskId === 'task-wheels');
  wheels.inventory.totalCount = 999;

  const audit = auditTotalAssembly(tampered, boundReceiptsFor(plan));
  assert.equal(audit.ok, false);
  assert.ok(audit.reasonCodes.includes('PACKAGE_COUNT_MISMATCH'));
});

test('stateHash 与 state 被同步篡改（哈希自洽但状态说谎）被拒', () => {
  const plan = freshPlan();
  const target = plan.taskPackages[0];
  const forged = createBoundTaskReceipt(target);
  // 偷偷在状态里多吃一颗未声明的 Token，并把 stateHash 重算得自洽
  forged.state.inventory.push(['tok-999', 'consumed']);
  forged.stateHash = stateHashOf(forged.state);

  const receipts = plan.taskPackages.map(t => (t.taskId === target.taskId ? forged : createBoundTaskReceipt(t)));
  const audit = auditTotalAssembly(plan, receipts);
  assert.equal(audit.ok, false);
  assert.ok(audit.reasonCodes.includes('RECEIPT_STATE_TOKEN_MISMATCH'),
    `状态与声明消费不一致必须被拒（实际: ${audit.reasonCodes.join(',')}）`);
});

test('stateHash 复算不一致（state 被改、哈希没跟上）被拒', () => {
  const plan = freshPlan();
  const target = plan.taskPackages[0];
  const forged = createBoundTaskReceipt(target);
  forged.state.inventory = forged.state.inventory.slice(0, -1); // 篡改状态但保留原 stateHash

  const receipts = plan.taskPackages.map(t => (t.taskId === target.taskId ? forged : createBoundTaskReceipt(t)));
  const audit = auditTotalAssembly(plan, receipts);
  assert.equal(audit.ok, false);
  assert.ok(audit.reasonCodes.includes('RECEIPT_STATEHASH_MISMATCH'));
});

test('stateFile 绑定：磁盘状态文件哈希一致通过、被篡改后拒绝', () => {
  const plan = freshPlan();
  const target = plan.taskPackages[0];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt-gating-'));
  try {
    const state = { nodes: [], connections: [], inventory: target.inventory.tokens.map(t => [t.tokenId, 'consumed']) };
    const stateFile = path.join(tmpDir, 'task-state.json');
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');

    const receipt = createBoundTaskReceipt(target);
    delete receipt.state;
    receipt.stateFile = stateFile;
    receipt.stateHash = stateHashOf(state); // 与磁盘文件真实一致

    const ok = auditTotalAssembly(
      plan,
      plan.taskPackages.map(t => (t.taskId === target.taskId ? receipt : createBoundTaskReceipt(t)))
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.receiptBinding, 'verified');

    // 篡改磁盘状态文件 → 复算哈希不再一致
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, inventory: state.inventory.slice(0, -1) }), 'utf8');
    const bad = auditTotalAssembly(
      plan,
      plan.taskPackages.map(t => (t.taskId === target.taskId ? receipt : createBoundTaskReceipt(t)))
    );
    assert.equal(bad.ok, false);
    assert.ok(bad.reasonCodes.includes('RECEIPT_STATEHASH_MISMATCH'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('产物哈希门禁：真实文件哈希一致通过；错报哈希被拒；缺文件降级为 warning', () => {
  const plan = freshPlan();
  const target = plan.taskPackages[0];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt-gating-'));
  try {
    const artifactPath = path.join(tmpDir, 'subassembly.brick.json');
    fs.writeFileSync(artifactPath, '{"parts":[]}');
    const goodSha = fileSha256(artifactPath);

    const withArtifact = t => {
      const r = createBoundTaskReceipt(t);
      if (t.taskId === target.taskId) r.artifacts = [{ path: artifactPath, sha256: goodSha }];
      return r;
    };
    const ok = auditTotalAssembly(plan, plan.taskPackages.map(withArtifact));
    assert.equal(ok.ok, true);
    assert.equal(ok.reasonCodes.includes('RECEIPT_ARTIFACT_HASH_MISMATCH'), false);

    // 错报哈希（v4 §3.1 "执行产物未核对"的修复）：文件真实存在但哈希对不上 → 拒绝
    const badSha = hashString('not-the-real-file');
    const lying = t => {
      const r = createBoundTaskReceipt(t);
      if (t.taskId === target.taskId) r.artifacts = [{ path: artifactPath, sha256: badSha }];
      return r;
    };
    const bad = auditTotalAssembly(plan, plan.taskPackages.map(lying));
    assert.equal(bad.ok, false);
    assert.ok(bad.reasonCodes.includes('RECEIPT_ARTIFACT_HASH_MISMATCH'),
      `产物哈希错报必须被拒（实际: ${bad.reasonCodes.join(',')}）`);

    // 声明的产物不在磁盘上 → 无法核对，warning 不拦截（但该收据 binding=unverified）
    const missing = t => {
      const r = createBoundTaskReceipt(t);
      if (t.taskId === target.taskId) r.artifacts = [{ path: path.join(tmpDir, 'missing.json'), sha256: goodSha }];
      return r;
    };
    const warn = auditTotalAssembly(plan, plan.taskPackages.map(missing));
    assert.equal(warn.ok, true);
    assert.ok(warn.reasonCodes.includes('RECEIPT_ARTIFACT_MISSING'));
    assert.ok(warn.warnings.some(w => w.includes('missing.json')));
    const entry = warn.receiptAudit.find(x => x.taskId === target.taskId);
    assert.equal(entry.binding, 'unverified');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('版本绑定：contractRevision 不一致被拒；真实绑定收据（含版本盖章）全数通过', () => {
  const plan = freshPlan();
  const target = plan.taskPackages[0];
  const forged = createBoundTaskReceipt(target);
  forged.contractRevision = 'contracts-9.9.9-fake';

  const bad = auditTotalAssembly(
    plan,
    plan.taskPackages.map(t => (t.taskId === target.taskId ? forged : createBoundTaskReceipt(t)))
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.reasonCodes.includes('RECEIPT_REVISION_MISMATCH'));

  const good = auditTotalAssembly(plan, boundReceiptsFor(plan));
  assert.equal(good.ok, true);
  assert.equal(good.receiptBinding, 'verified');
  assert.equal(good.totalConsumedTokens, 91);
  assert.ok(good.receiptAudit.every(x => x.binding === 'verified' && x.reasonCodes.length === 0));
});

test('Token 绑定：消费其他任务包的 Token 以 RECEIPT_TOKEN_NOT_ALLOCATED 拒绝', () => {
  const plan = freshPlan();
  const receipts = boundReceiptsFor(plan);
  const [main, minifig] = [receipts.find(r => r.taskId === 'task-main-chassis'), receipts.find(r => r.taskId === 'task-minifig')];
  main.consumedTokens.push({ ...minifig.consumedTokens[0] });

  const audit = auditTotalAssembly(plan, receipts);
  assert.equal(audit.ok, false);
  assert.ok(audit.reasonCodes.includes('RECEIPT_TOKEN_NOT_ALLOCATED'));
  assert.ok(audit.reasonCodes.includes('RECEIPT_TOKEN_DUPLICATE'));
});
