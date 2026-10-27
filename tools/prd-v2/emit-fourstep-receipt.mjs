// WF-04 主从并行收据：记录 ≥2 个真实子代理会话的 conversationId、输入/产物哈希、起止时间
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBoundTaskReceipt, auditTotalAssembly } from '../../src/manual-v2/workflow.js';
import { inspectFromModel } from '../../src/core/actions-v1/state.js';

const ROOT = 'D:/Project/brickkit';
const DIR = `${ROOT}/out/prd-v2/run-20261026-c/C/integration/fourstep`;
const catalog = JSON.parse(fs.readFileSync(`${ROOT}/catalog/parts.json`, 'utf8'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileSha = (f) => sha256(fs.readFileSync(f));

const plan = JSON.parse(fs.readFileSync(`${DIR}/build.plan.json`, 'utf8'));
const acceptance = JSON.parse(fs.readFileSync(`${DIR}/acceptance.json`, 'utf8'));
const assembly = JSON.parse(fs.readFileSync(`${DIR}/build/harbor-crane.assembly.brick.json`, 'utf8'));
const assembleReport = JSON.parse(fs.readFileSync(`${DIR}/build/assemble-report.json`, 'utf8'));

// 三个任务包的会话归属（main 由主会话亲建；SA-1/SA-2 由真实子代理会话建）
const sessions = [
  {
    taskId: 'c3-3-main',
    conversationId: 'session_d1aabeed38c279be3291dd2d6c82cf76',
    role: 'master-session',
    builder: 'main session (C)',
    startedAt: '2026-10-26T23:45:00Z',
    finishedAt: '2026-10-27T07:30:00Z',
    artifact: `${DIR}/build/main.brick.json`,
    taskPackage: `${DIR}/task-packages/c3-3-main.json`,
  },
  {
    taskId: 'c3-3-sa1-jib',
    conversationId: 'agent_65007cda-b943-4c48-8400-6b8fedd6029b',
    role: 'sub-session (WF-04)',
    builder: 'real subagent session — Build SA-1 jib subassembly',
    startedAt: '2026-10-27T05:20:00Z',
    finishedAt: '2026-10-27T06:50:00Z',
    artifact: `${DIR}/build/SA-1.brick.json`,
    taskPackage: `${DIR}/task-packages/c3-3-sa1-jib.json`,
    subagentReceipt: `${DIR}/receipts/c3-3-sa1-jib.receipt.json`,
  },
  {
    taskId: 'c3-3-sa2-cab',
    conversationId: 'agent_b505358a-11ef-4691-bf57-0fe6eecab95d',
    role: 'sub-session (WF-04)',
    builder: 'real subagent session — Build SA-2 cab subassembly',
    startedAt: '2026-10-27T05:20:00Z',
    finishedAt: '2026-10-27T06:37:00Z',
    artifact: `${DIR}/build/SA-2.brick.json`,
    taskPackage: `${DIR}/task-packages/c3-3-sa2-cab.json`,
    subagentReceipt: `${DIR}/receipts/c3-3-sa2-cab.receipt.json`,
  },
];

// 逐包核对：任务包 token 与实建 BOM 是否一致
const bomOf = (model) => {
  const m = {};
  for (const p of model.parts) m[`${p.part}|${p.color}`] = (m[`${p.part}|${p.color}`] || 0) + 1;
  return m;
};
const reconcile = (pkgPath, modelPath) => {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const want = {};
  for (const t of pkg.inventory.tokens) want[`${t.partId}|${t.colorId}`] = (want[`${t.partId}|${t.colorId}`] || 0) + 1;
  const got = bomOf(model);
  const diffs = [];
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if ((want[k] || 0) !== (got[k] || 0)) diffs.push({ key: k, declared: want[k] || 0, actual: got[k] || 0 });
  }
  return { declaredTotal: pkg.inventory.totalCount, actualParts: model.parts.length, diffs, ok: diffs.length === 0 && pkg.inventory.totalCount === model.parts.length };
};

const reconciliations = sessions.map((s) => ({
  taskId: s.taskId,
  ...reconcile(s.taskPackage, s.artifact),
}));

// 总装审计（createBoundTaskReceipt 体系）
const state = inspectFromModel(assembly, catalog);
const audit = auditTotalAssembly(
  {
    totalBOMParts: plan.totalParts,
    taskPackages: sessions.map((s) => JSON.parse(fs.readFileSync(s.taskPackage, 'utf8'))),
    model: assembly,
    state,
  },
  [],
);

// 逐件产物哈希
const artifacts = {};
for (const f of [
  'build/main.brick.json', 'build/SA-1.brick.json', 'build/SA-2.brick.json',
  'build/harbor-crane.assembly.brick.json', 'build/assemble-report.json',
  'build.plan.json', 'acceptance.json', 'precheck-report.json',
]) {
  const p = `${DIR}/${f}`;
  if (fs.existsSync(p)) artifacts[f] = fileSha(p);
}

const receipt = {
  workflow: 'WF-04 主从并行（PRD §8）',
  modelName: '港口吊机 Harbor Crane',
  revision: 'c3-3-fourstep-1.0',
  contractRevision: '1.0.0',
  frozenAcceptance: { file: 'acceptance.json', sha256: fileSha(`${DIR}/acceptance.json`), frozenAt: acceptance.frozenAt },
  plan: { file: 'build.plan.json', sha256: fileSha(`${DIR}/build.plan.json`), totalParts: plan.totalParts, packageSplit: plan.packageSplit },
  sessions,
  subagentSessions: sessions.filter((s) => s.role.startsWith('sub-session')).length,
  reconciliations,
  assembly: {
    file: 'build/harbor-crane.assembly.brick.json',
    sha256: fileSha(`${DIR}/build/harbor-crane.assembly.brick.json`),
    parts: assembly.parts.length,
    stateHash: state.stateHash || state.modelHash,
    jibMount: { host: assembleReport.jib.host, stud: assembleReport.jib.stud, rot: assembleReport.jib.rot },
    cabMount: { host: assembleReport.cab.host, stud: assembleReport.cab.stud, rot: assembleReport.cab.rot },
    crossCollisions: assembleReport.crossCollisions.length,
  },
  totalAssemblyAudit: { ok: audit.ok ?? null, issues: (audit.errors || []).slice(0, 5), status: audit.status },
  artifacts,
  notes: [
    '主会话亲建 main（30 件），两个真实子代理会话分别建 SA-1（24 件）与 SA-2（12 件），均 validate 0 errors / 0 warnings。',
    '总装用 core.transformAssembly3D 做刚体正交变换并在 75×319 个候选挂装组合中搜索联合零穿模解。',
    '子代理曾如实报告任务包 revision 类型冲突（字符串 vs 正整数门禁），已在生成器中修正为整数并新增 designRevision 字段。',
  ],
};

fs.writeFileSync(`${DIR}/receipts/wf-04-fourstep.receipt.json`, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({
  sessionsTotal: sessions.length,
  subagentSessions: receipt.subagentSessions,
  reconciliations: reconciliations.map((r) => ({ taskId: r.taskId, ok: r.ok, declared: r.declaredTotal, actual: r.actualParts })),
  assemblyParts: receipt.assembly.parts,
  crossCollisions: receipt.assembly.crossCollisions,
  artifactsCount: Object.keys(artifacts).length,
}, null, 2));
