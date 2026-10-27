/**
 * C-milestone-1-traj-probe-20261026.mjs — 独立复核探针（只读评审，PRD §13.4）
 * 评审项 3（C1-1/2 轨迹数据集）：
 *   1. 跨家族随机抽 30 条样本（固定种子可复现）；
 *   2. 每条从存储的 state_t 出发，用真实引擎 applyActions 重放存储动作，
 *      断言执行后 stateHash == 存储的 state_t+1 stateHash；
 *   3. 抽 10 个样本核对图片文件 sha256；
 *   4. 扫描公开区（非 target / 非 verification 标签区）确认无目标泄漏。
 * 运行：node docs/prd-v2/reviews/C-milestone-1-traj-probe-20261026.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyActions } from '../../../src/core/actions-v1/apply.js';
import { inspectFromModel } from '../../../src/core/actions-v1/state.js';
import { enumerateCandidates } from '../../../src/core/actions-v1/candidates.js';

const ROOT = process.cwd();
const DATA = 'out/prd-v2/run-20261026-c/C/data/trajectory';
const familiesDir = path.join(ROOT, DATA, 'families');
const CAT = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')),
  colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors };

// —— 1. 收集全部样本，分层随机抽 30 条（每家族至少 1 条，其余按权重随机）——
const byFamily = {};
for (const fam of fs.readdirSync(familiesDir)) {
  const f = path.join(familiesDir, fam, 'samples.jsonl');
  if (!fs.existsSync(f)) continue;
  byFamily[fam] = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
const allFams = Object.keys(byFamily);
const total = Object.values(byFamily).reduce((s, a) => s + a.length, 0);
console.log(`families=${allFams.length} totalSamples=${total}`);

let seed = 20261026;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const picked = [];
for (const fam of allFams) picked.push({ fam, s: byFamily[fam][Math.floor(rnd() * byFamily[fam].length)] });
const pool = [];
for (const fam of allFams) for (const s of byFamily[fam]) pool.push({ fam, s });
while (picked.length < 30) picked.push(pool[Math.floor(rnd() * pool.length)]);
// 去重
const seen = new Set(); const sampleSet = [];
for (const p of picked) { if (!seen.has(p.s.sampleId)) { seen.add(p.s.sampleId); sampleSet.push(p); } }

// —— 2. 真实引擎重放 ——
const replay = [];
let replayFails = 0;
for (const { fam, s } of sampleSet) {
  const st = s.stateRefs[0], nx = s.stateRefs[1];
  const stateFile = JSON.parse(fs.readFileSync(path.join(ROOT, st.brickPath), 'utf8'));
  const si = inspectFromModel(stateFile.model, CAT, { inventory: stateFile.inventory });
  const ctx = {
    model: stateFile.model,
    cat: CAT,
    stateHash: st.stateHash,
    inventory: JSON.parse(JSON.stringify(stateFile.inventory)),
    taskId: s.verification?.labels?.actionRequest?.taskId,
    enumerate: (req) => enumerateCandidates(si.state, req, CAT, {}),
  };
  // 先断言存储 state_t 的哈希真实可复算（state.js 真实复算，不信文件自带字段）
  const recomputed = inspectFromModel(stateFile.model, CAT, { inventory: stateFile.inventory }).stateHash;
  const tOk = recomputed === st.stateHash;
  const request = s.verification.labels.actionRequest;
  const out = applyActions(ctx, request, {});
  const hashOk = out.passed === true && out.apply?.stateHashAfter === nx.stateHash;
  // 公开候选 ↔ 标签区交叉核对：选中候选的 candidateHash 必须与标签动作一致
  const selId = s.target?.primaryAction?.selectedCandidateId;
  const sel = s.candidates?.items?.find(c => c.candidateId === selId);
  const linkOk = sel && sel.candidateHash === request.actions[0].candidateHash;
  const ok = tOk && hashOk && linkOk;
  if (!ok) replayFails++;
  replay.push({ sampleId: s.sampleId, family: fam, state_t_recomputed: tOk,
    replayHashMatch: hashOk, publicLabelLinkOk: linkOk,
    gotHash: out.apply?.stateHashAfter, wantHash: nx.stateHash, passed: out.passed,
    diags: out.diagnostics?.map(d => d.code) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${s.sampleId} stateT=${tOk} hash=${hashOk} link=${linkOk}`);
}
const eqGroups = sampleSet.filter(x => (x.s.verification?.targetConsistency?.equivalentGroupSize || 1) > 1).length;
console.log(`replay: ${sampleSet.length - replayFails}/${sampleSet.length} pass; samples with documented equivalentGroups=${eqGroups}`);

// —— 3. 图片 sha256 抽查 10 个样本（全部角色）——
const imgChecks = [];
let imgFails = 0;
for (const { s } of sampleSet.slice(0, 10)) {
  for (const im of s.images) {
    const p = path.join(ROOT, im.imagePath);
    if (!fs.existsSync(p)) { imgChecks.push({ sampleId: s.sampleId, role: im.role, exists: false, ok: false }); imgFails++; continue; }
    const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const ok = h === im.imageSha256;
    if (!ok) imgFails++;
    imgChecks.push({ sampleId: s.sampleId, role: im.role, file: path.basename(im.imagePath), shaOk: ok });
  }
}
console.log(`image sha256: ${imgChecks.length - imgFails}/${imgChecks.length} match (10 samples x 3 roles)`);

// —— 4. 公开区泄漏扫描（全量 2225 条，非抽样）——
const LEAK_KEYS = ['isTarget', 'is_target', 'matchesTarget', 'executedStateHash', 'groundTruth', 'ground_truth',
  'selectedCandidateId', 'equivalentCandidates', 'targetConsistency', 'candidateReceipts', 'realCandidateId'];
let leakHits = [];
let scanned = 0;
function scanPublic(obj, sampleId, where) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => scanPublic(v, sampleId, `${where}[${i}]`)); return; }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (LEAK_KEYS.includes(k)) leakHits.push({ sampleId, where: `${where}.${k}` });
      scanPublic(obj[k], sampleId, `${where}.${k}`);
    }
    return;
  }
  if (typeof obj === 'string' && /isTarget|matchesTarget/.test(obj)) leakHits.push({ sampleId, where, value: obj.slice(0, 80) });
}
const publicKeys = s => Object.keys(s).filter(k => k !== 'target' && k !== 'verification');
for (const fam of allFams) for (const s of byFamily[fam]) {
  scanned++;
  for (const k of publicKeys(s)) scanPublic(s[k], s.sampleId, k);
}
console.log(`leak scan: scanned=${scanned} samples, public keys per sample=${publicKeys(byFamily[allFams[0]][0]).join(',')}, leakHits=${leakHits.length}`);
if (leakHits.length) console.log(JSON.stringify(leakHits.slice(0, 10), null, 1));

const evidence = {
  probe: 'trajectory-dataset-replay', at: new Date().toISOString(), seed,
  families: allFams.length, totalSamples: total, sampled: sampleSet.length,
  replay: { pass: sampleSet.length - replayFails, fail: replayFails, detail: replay },
  images: { checked: imgChecks.length, fail: imgFails, detail: imgChecks },
  leakScan: { scanned, leakHits: leakHits.length, samples: leakHits.slice(0, 20) },
  allPass: replayFails === 0 && imgFails === 0 && leakHits.length === 0,
};
fs.writeFileSync('docs/prd-v2/reviews/C-milestone-1-traj-probe-result-20261026.json', JSON.stringify(evidence, null, 2));
console.log(evidence.allPass ? 'ALL PASS' : 'SOME FAILED');
process.exit(evidence.allPass ? 0 : 1);
