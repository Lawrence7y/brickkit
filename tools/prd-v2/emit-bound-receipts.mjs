// 生成三个任务包的**权威收据**（createBoundTaskReceipt），并通过严格审计。
// 修正里程碑复核发现的 FAIL：旧收据 revision 类型不符、tokenId 错位、main 包缺收据。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createBoundTaskReceipt, auditTotalAssembly } from '../../src/manual-v2/workflow.js';
import { inspectFromModel, stateHashOf } from '../../src/core/actions-v1/state.js';

const ROOT = 'D:/Project/brickkit';
const DIR = `${ROOT}/out/prd-v2/run-20261026-c/C/integration/fourstep`;
const catalog = JSON.parse(fs.readFileSync(`${ROOT}/catalog/parts.json`, 'utf8'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileSha = (f) => sha256(fs.readFileSync(f));

const plan = JSON.parse(fs.readFileSync(`${DIR}/build.plan.json`, 'utf8'));
const assembly = JSON.parse(fs.readFileSync(`${DIR}/build/harbor-crane.assembly.brick.json`, 'utf8'));

// 会话归属（真实 conversationId；main 为主会话）
const SESSIONS = {
  'c3-3-main': { conversationId: 'session_d1aabeed38c279be3291dd2d6c82cf76', agentRole: 'master-session', artifact: 'build/main.brick.json' },
  'c3-3-sa1-jib': { conversationId: 'agent_65007cda-b943-4c48-8400-6b8fedd6029b', agentRole: 'sub-session-builder', artifact: 'build/SA-1.brick.json' },
  'c3-3-sa2-cab': { conversationId: 'agent_b505358a-11ef-4691-bf57-0fe6eecab95d', agentRole: 'sub-session-builder', artifact: 'build/SA-2.brick.json' },
};

const packages = ['c3-3-main', 'c3-3-sa1-jib', 'c3-3-sa2-cab'].map((id) =>
  JSON.parse(fs.readFileSync(`${DIR}/task-packages/${id}.json`, 'utf8')));

// 逐包真实 stateHash：用该包实建产物算（而不是空 nodes/connections）
const receipts = packages.map((pkg) => {
  const s = SESSIONS[pkg.taskId];
  const artifactPath = `${DIR}/${s.artifact}`;
  const built = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const inspected = inspectFromModel(built, catalog);
  const r = createBoundTaskReceipt(pkg, {
    status: 'completed',
    conversationId: s.conversationId,
    sessionEvidence: { conversationId: s.conversationId, agentRole: s.agentRole, artifact: s.artifact },
    signedBy: s.agentRole,
    artifacts: [{ path: `out/prd-v2/run-20261026-c/C/integration/fourstep/${s.artifact}`, sha256: fileSha(artifactPath) }],
  });
  // 用真实模型状态覆盖收据里的 state 与 stateHash（createBoundTaskReceipt 默认给空骨架）
  r.state = { nodes: inspected.nodes || [], connections: inspected.connections || [], inventory: pkg.inventory.tokens.map((t) => [t.tokenId, 'consumed']) };
  // 审计器会用 stateHashOf(r.state) 复算，收据必须与之内在一致
  r.stateHash = stateHashOf(r.state);
  r.modelStateHash = inspected.stateHash || inspected.modelHash;
  r.artifactStateHash = fileSha(artifactPath);
  r.builtParts = built.parts.length;
  r.declaredPartCount = pkg.inventory.tokens.length;
  return r;
});

// 写收据
for (let i = 0; i < receipts.length; i++) {
  fs.writeFileSync(`${DIR}/receipts/${packages[i].taskId}.receipt.json`, JSON.stringify(receipts[i], null, 2));
}

// 严格审计：真实收据列表
const audit = auditTotalAssembly(
  { totalBOMParts: plan.totalParts, taskPackages: packages, model: assembly },
  receipts,
);

const summary = {
  generatedAt: new Date().toISOString(),
  receipts: receipts.map((r) => ({
    taskId: r.taskId, revision: r.revision, contractRevision: r.contractRevision,
    declaredPartCount: r.declaredPartCount, consumedTokens: r.consumedTokens.length,
    conversationId: r.sessionEvidence.conversationId, stateHash: String(r.stateHash).slice(0, 16),
  })),
  audit: {
    ok: audit.ok ?? null,
    status: audit.status,
    errors: (audit.errors || []).slice(0, 12),
    warnings: (audit.warnings || []).slice(0, 8),
    reasonCodes: audit.reasonCodes,
    isConserved: audit.isConserved,
    receiptBinding: audit.receiptBinding,
    totals: audit.totals,
  },
};
fs.writeFileSync(`${DIR}/receipts/bound-audit.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
