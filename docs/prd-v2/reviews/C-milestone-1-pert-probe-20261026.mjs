/**
 * C-milestone-1-pert-probe-20261026.mjs — 独立复核探针（只读评审，PRD §13.4）
 * 评审项 4（C1-3 扰动数据集）：
 *   1. 跨 6 家族随机抽 30 条 repair_local：从落盘扰动状态出发，逐事务真实 applyActions
 *      重放修复序列，断言修复后 canonical model-only stateHash == 参考态，且 validate 0 errors；
 *   2. 随机抽 30 条 understand_structure：独立重算参考态 vs 扰动态结构 diff，
 *      断言 diffSummary 与 target.structureDiagnosis 的 errorType/issues 一致；
 *   3. 匿名性：公开区（非 target / 非 verification）不得出现真实实例 ID（p\d{3}）、
 *      真实 Token（tok-fam-*）、真实候选 ID（cand-<hex12>）。
 * 运行：node docs/prd-v2/reviews/C-milestone-1-pert-probe-20261026.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyActions } from '../../../src/core/actions-v1/apply.js';
import { inspectFromModel } from '../../../src/core/actions-v1/state.js';
import { enumerateCandidates } from '../../../src/core/actions-v1/candidates.js';
import { validate } from '../../../src/core/core.js';

const ROOT = process.cwd();
const DATA = 'out/prd-v2/run-20261026-c/C/data/perturbation';
const CAT = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')),
  colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors };

const canonicalModelOnlyHash = (parts) => {
  const sorted = [...parts].sort((a, b) => a.id.localeCompare(b.id));
  return inspectFromModel({ format: 'brickbuild', version: '0.2', meta: {}, parts: sorted }, CAT).stateHash;
};
const flatParts = (m) => m.parts.map((p) => ({ ...p, at: [...p.at] }));

const byFamily = {};
for (const fam of fs.readdirSync(path.join(ROOT, DATA, 'families'))) {
  const fr = path.join(ROOT, DATA, 'families', fam, 'samples.repair_local.jsonl');
  const fu = path.join(ROOT, DATA, 'families', fam, 'samples.understand_structure.jsonl');
  if (!fs.existsSync(fr)) continue;
  byFamily[fam] = {
    repair: fs.readFileSync(fr, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
    understand: fs.existsSync(fu) ? fs.readFileSync(fu, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [],
  };
}
const fams = Object.keys(byFamily);
const totalR = fams.reduce((s, f) => s + byFamily[f].repair.length, 0);
const totalU = fams.reduce((s, f) => s + byFamily[f].understand.length, 0);
console.log(`families=${fams.length} repair_local=${totalR} understand_structure=${totalU}`);

let seed = 20261026;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// —— 1. repair_local 重放（30 条）——
const picked = [];
for (const fam of fams) picked.push({ fam, s: byFamily[fam].repair[Math.floor(rnd() * byFamily[fam].repair.length)] });
const poolR = [];
for (const fam of fams) for (const s of byFamily[fam].repair) poolR.push({ fam, s });
while (picked.length < 30) picked.push(poolR[Math.floor(rnd() * poolR.length)]);
const seenR = new Set(); const repSet = [];
for (const p of picked) if (!seenR.has(p.s.sampleId)) { seenR.add(p.s.sampleId); repSet.push(p); }

let repFails = 0; const repDetail = [];
for (const { fam, s } of repSet) {
  try {
    const pertState = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[1].brickPath), 'utf8'));
    const refState = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[0].brickPath), 'utf8'));
    // 扰动/参考态哈希独立复算
    const recomputedPert = canonicalModelOnlyHash(flatParts(pertState.model));
    if (recomputedPert !== s.stateRefs[1].modelOnlyStateHash) throw new Error('扰动状态 canonical 哈希复算不一致');
    if (refState.modelOnlyStateHash !== s.stateRefs[0].modelOnlyStateHash) throw new Error('参考态哈希不一致');
    let model = pertState.model, hash = pertState.stateHash, inventory = pertState.inventory;
    const requests = s.verification.labels.repairPlan.transactions;
    for (const request of requests) {
      if (request.stateHash !== hash) throw new Error(`事务 stateHash 链断裂: ${request.stateHash} vs ${hash}`);
      const si = inspectFromModel(model, CAT, { inventory });
      const ctx = { model: JSON.parse(JSON.stringify(model)), cat: CAT, stateHash: hash,
        inventory: JSON.parse(JSON.stringify(inventory)), taskId: request.taskId,
        enumerate: (req) => enumerateCandidates(si.state, req, CAT, {}) };
      const res = applyActions(ctx, request, {});
      if (!res.passed) throw new Error('重放未通过: ' + (res.diagnostics?.[0]?.code ?? '?') + ' ' + (res.diagnostics?.[0]?.msg ?? ''));
      model = res._workingModel; hash = res.apply.stateHashAfter; inventory = res._inventory;
    }
    const finalCanonical = canonicalModelOnlyHash(flatParts(model));
    if (finalCanonical !== refState.modelOnlyStateHash) throw new Error('修复后 canonical 哈希 != 参考态');
    const rv = validate(model, CAT);
    if (rv.errors.length > 0) throw new Error('修复后模型仍有 ' + rv.errors.length + ' 个校验错误');
    // 公开候选 ↔ 标签 repairPlan 交叉核对
    const selId = s.target?.primaryAction?.selectedCandidateId;
    const sel = s.candidates?.items?.find(c => c.candidateId === selId);
    const linkOk = sel && sel.candidateHash === requests[0].actions[0].candidateHash;
    if (!linkOk) throw new Error('公开选中候选与标签 repairPlan candidateHash 不一致');
    repDetail.push({ sampleId: s.sampleId, family: fam, pertType: s.verification.labels.perturbationType, pass: true, transactions: requests.length });
    console.log(`PASS ${s.sampleId} (${s.verification.labels.perturbationType})`);
  } catch (e) {
    repFails++;
    repDetail.push({ sampleId: s.sampleId, family: fam, pass: false, error: String(e.message).slice(0, 200) });
    console.log(`FAIL ${s.sampleId}: ${e.message}`);
  }
}
console.log(`repair_local replay: ${repSet.length - repFails}/${repSet.length} pass`);

// —— 2. understand_structure 结构 diff 复算（30 条）——
const pickedU = [];
for (const fam of fams) pickedU.push({ fam, s: byFamily[fam].understand[Math.floor(rnd() * byFamily[fam].understand.length)] });
const poolU = [];
for (const fam of fams) for (const s of byFamily[fam].understand) poolU.push({ fam, s });
while (pickedU.length < 30) pickedU.push(poolU[Math.floor(rnd() * poolU.length)]);
const seenU = new Set(); const undSet = [];
for (const p of pickedU) if (!seenU.has(p.s.sampleId)) { seenU.add(p.s.sampleId); undSet.push(p); }

// 独立结构 diff（实例级）：按实例 id 配对参考态与扰动态；
//   removed/added = 单侧存在的 id；changed = 两侧同 id 但 (part,color,at,rot,up,snot) 签名不同
const sig = (p) => JSON.stringify([p.part, p.color, p.at, p.rot ?? 0, p.up ?? '+y', p.snot ?? 0]);
function structDiff(refModel, pertModel) {
  const refById = new Map(refModel.parts.map(p => [p.id, p]));
  const pertById = new Map(pertModel.parts.map(p => [p.id, p]));
  const removed = [], added = [], changed = [];
  for (const [id, rp] of refById) {
    const pp = pertById.get(id);
    if (!pp) { removed.push(id); continue; }
    if (sig(rp) !== sig(pp)) changed.push(id);
  }
  for (const id of pertById.keys()) if (!refById.has(id)) added.push(id);
  return { removed: removed.length, added: added.length, changed: changed.length, removedIds: removed, changedIds: changed };
}
let undFails = 0; const undDetail = [];
for (const { fam, s } of undSet) {
  try {
    const refState = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[0].brickPath), 'utf8'));
    const pertState = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[1].brickPath), 'utf8'));
    const d = structDiff(refState.model, pertState.model);
    const ds = s.verification.diffSummary;
    if (d.removed !== ds.removed || d.added !== ds.added) throw new Error(`diff 不一致: mine=${JSON.stringify({ removed: d.removed, added: d.added })} stored=${JSON.stringify({ removed: ds.removed, added: ds.added, changed: ds.changed })}`);
    const diag = s.target.structureDiagnosis;
    const labelType = s.verification.labels.perturbationType;
    // errorType 与扰动类型一致
    if (diag.errorType !== labelType) throw new Error(`errorType ${diag.errorType} != labels.perturbationType ${labelType}`);
    if (labelType === 'missing_part') {
      if (!(d.removed === 1 && d.added === 0 && d.changed === 0)) throw new Error(`missing_part 应 removed=1，实际 ${JSON.stringify(d)}`);
      if (d.removedIds.length !== diag.faultyPartInstances.length) throw new Error('缺失件数量与 faultyPartInstances 不一致');
      for (const iss of diag.issues) {
        if (iss.issueType !== 'missing_part') throw new Error('issueType != missing_part');
        const want = JSON.stringify([iss.expected.part, iss.expected.color, iss.expected.at, iss.expected.rot ?? 0, iss.expected.up ?? '+y', iss.expected.snot ?? 0]);
        // 缺失件的 expected 必须与参考态中被移除实例的签名一致
        const refPart = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[0].brickPath), 'utf8')).model.parts
          .find(p => p.id === (s.verification.labels.partRefMap ? Object.entries(s.verification.labels.partRefMap).find(([, pub]) => pub === diag.faultyPartInstances[0])?.[0] : d.removedIds[0]));
        if (!refPart) throw new Error('参考态找不到缺失实例');
        const got = JSON.stringify([refPart.part, refPart.color, refPart.at, refPart.rot ?? 0, refPart.up ?? '+y', refPart.snot ?? 0]);
        if (want !== got) throw new Error(`expected 签名与参考态实例不符: want=${want} got=${got}`);
      }
    } else if (['wrong_color', 'reversed_orientation', 'misaligned', 'left_right_swap'].includes(labelType)) {
      if (d.removed !== 0 || d.added !== 0) throw new Error(`替换型扰动应 removed=added=0，实际 ${JSON.stringify(d)}`);
      if (d.changed === 0) throw new Error('替换型扰动 changed=0');
      if (ds.changed !== d.changed) throw new Error(`changed 数不一致 mine=${d.changed} stored=${ds.changed}`);
      if (!diag.hasStructuralError) throw new Error('替换型扰动应 hasStructuralError=true');
      if (!diag.faultyPartInstances?.length) throw new Error('faultyPartInstances 为空');
    } else { throw new Error('未知扰动类型 ' + labelType); }
    undDetail.push({ sampleId: s.sampleId, family: fam, pertType: labelType, pass: true });
    console.log(`PASS ${s.sampleId} (${labelType})`);
  } catch (e) {
    undFails++;
    undDetail.push({ sampleId: s.sampleId, family: fam, pass: false, error: String(e.message).slice(0, 200) });
    console.log(`FAIL ${s.sampleId}: ${e.message}`);
  }
}
console.log(`understand_structure diff: ${undSet.length - undFails}/${undSet.length} pass`);

// —— 3. 匿名性扫描（全量 2496 条的公开区）——
const REAL_ID_PATTERNS = [
  { name: 'real-instance-id', re: /\bp\d{3}\b/ },
  { name: 'real-token-id', re: /\btok-[a-z0-9-]+\d{3}\b/ },
  { name: 'real-candidate-id', re: /\bcand-[0-9a-f]{12}\b/ },
];
let anonHits = [], anonScanned = 0;
function scanStr(v, sampleId, where) {
  if (typeof v === 'string') {
    for (const p of REAL_ID_PATTERNS) if (p.re.test(v)) anonHits.push({ sampleId, where, pattern: p.name, value: v.slice(0, 80) });
  } else if (Array.isArray(v)) v.forEach((x, i) => scanStr(x, sampleId, `${where}[${i}]`));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) {
    for (const p of REAL_ID_PATTERNS) if (p.re.test(k)) anonHits.push({ sampleId, where: `${where}.{key:${k}}`, pattern: p.name });
    scanStr(v[k], sampleId, `${where}.${k}`);
  }
}
for (const fam of fams) {
  for (const kind of ['repair', 'understand']) {
    for (const s of byFamily[fam][kind]) {
      anonScanned++;
      for (const k of Object.keys(s)) {
        if (k === 'target' || k === 'verification') continue;
        scanStr(s[k], s.sampleId, k);
      }
    }
  }
}
console.log(`anonymity: scanned=${anonScanned} samples, hits=${anonHits.length}`);
if (anonHits.length) console.log(JSON.stringify(anonHits.slice(0, 10), null, 1));

const evidence = {
  probe: 'perturbation-dataset-replay', at: new Date().toISOString(), seed,
  families: fams.length, totalRepair: totalR, totalUnderstand: totalU,
  repairReplay: { sampled: repSet.length, pass: repSet.length - repFails, fail: repFails, detail: repDetail },
  understandDiff: { sampled: undSet.length, pass: undSet.length - undFails, fail: undFails, detail: undDetail },
  anonymity: { scanned: anonScanned, hits: anonHits.length, samples: anonHits.slice(0, 20) },
  allPass: repFails === 0 && undFails === 0 && anonHits.length === 0,
};
fs.writeFileSync('docs/prd-v2/reviews/C-milestone-1-pert-probe-result-20261026.json', JSON.stringify(evidence, null, 2));
console.log(evidence.allPass ? 'ALL PASS' : 'SOME FAILED');
process.exit(evidence.allPass ? 0 : 1);
