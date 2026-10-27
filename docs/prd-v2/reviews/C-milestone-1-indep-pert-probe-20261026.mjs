/**
 * C-milestone-1-indep-pert-probe-20261026.mjs — independent reviewer probe (read-only, CPU only).
 * 25 sampled perturbation samples:
 *  - repair_local: re-execute the stored repair sequence from the PERTURBED state with REAL
 *    src/core/actions-v1/apply.js applyActions; final stateHash must equal the reference hash.
 *  - understand_structure: independently recompute the structural diff (reference vs perturbed)
 *    and compare errorType / faulty instances / issues with the stored answer.
 *  - anonymity: real instance ids / token ids / engine candidate ids must not appear in public fields.
 * Run: node docs/prd-v2/reviews/C-milestone-1-indep-pert-probe-20261026.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyActions } from '../../../src/core/actions-v1/apply.js';
import { enumerateCandidates } from '../../../src/core/actions-v1/candidates.js';
import { inspectFromModel, stateHashOf } from '../../../src/core/actions-v1/state.js';

const ROOT = process.cwd();
const DATA = 'out/prd-v2/run-20261026-c/C/data/perturbation';
const CAT = {
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')),
  colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors
};

function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const fams = fs.readdirSync(path.join(DATA, 'families')).filter((d) =>
  fs.statSync(path.join(DATA, 'families', d)).isDirectory());
const pools = { repair_local: [], understand_structure: [] };
for (const fam of fams) {
  for (const task of Object.keys(pools)) {
    const p = path.join(DATA, 'families', fam, `samples.${task}.jsonl`);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (line.trim()) pools[task].push(JSON.parse(line));
    }
  }
}

const rand = rng(0xfeedface);
function pick(pool, n) {
  const copy = pool.slice(); const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}
// 13 repair_local + 12 understand_structure = 25
const repairPicks = pick(pools.repair_local, 13);
const structPicks = pick(pools.understand_structure, 12);

// ---------------- independent structural diff (own implementation, id-paired) ----------------
const placement = (p) => ({ at: [...p.at], rot: p.rot ?? 0, up: p.up ?? '+y', snot: p.snot ?? 0 });
function diffStructures(refParts, pertParts) {
  const ref = new Map(refParts.map((p) => [p.id, p]));
  const pert = new Map(pertParts.map((p) => [p.id, p]));
  const removed = [], added = [], changed = [];
  for (const [id, rp] of ref) {
    if (!pert.has(id)) { removed.push({ id, part: rp.part, color: rp.color, placement: placement(rp) }); continue; }
    const pp = pert.get(id);
    const deltas = {};
    if (rp.color !== pp.color) deltas.color = { expected: rp.color, actual: pp.color };
    if (JSON.stringify(placement(rp)) !== JSON.stringify(placement(pp))) {
      deltas.placement = { expected: placement(rp), actual: placement(pp) };
    }
    if (Object.keys(deltas).length) changed.push({ id, part: rp.part, deltas });
  }
  for (const [id, pp] of pert) if (!ref.has(id)) added.push({ id, part: pp.part, color: pp.color });
  return { removed, added, changed };
}
function classify(d) {
  const { removed, added, changed } = d;
  if (removed.length === 1 && !added.length && !changed.length) {
    return { errorType: 'missing_part', faulty: [removed[0].id],
      issues: [{ issueType: 'missing_part', ref: removed[0].id, expected: { part: removed[0].part, color: removed[0].color, ...removed[0].placement } }] };
  }
  if (!removed.length && !added.length && changed.length === 1) {
    const c = changed[0];
    if (c.deltas.color && !c.deltas.placement) {
      return { errorType: 'wrong_color', faulty: [c.id],
        issues: [{ issueType: 'wrong_color', ref: c.id, expected: { color: c.deltas.color.expected }, actual: { color: c.deltas.color.actual } }] };
    }
    if (c.deltas.placement && !c.deltas.color) {
      const e = c.deltas.placement.expected, a = c.deltas.placement.actual;
      const sameAt = JSON.stringify(e.at) === JSON.stringify(a.at);
      const orientOnly = sameAt && (e.rot !== a.rot || e.up !== a.up || e.snot !== a.snot);
      return { errorType: orientOnly ? 'reversed_orientation' : 'misaligned', faulty: [c.id],
        issues: [{ issueType: orientOnly ? 'reversed_orientation' : 'misaligned', ref: c.id, expected: e, actual: a }] };
    }
  }
  if (!removed.length && !added.length && changed.length === 2
    && changed.every((c) => c.deltas.color && !c.deltas.placement)
    && changed[0].part === changed[1].part
    && changed[0].deltas.color.expected === changed[1].deltas.color.actual
    && changed[1].deltas.color.expected === changed[0].deltas.color.actual) {
    return { errorType: 'left_right_swap', faulty: [changed[0].id, changed[1].id],
      issues: changed.map((c) => ({ issueType: 'left_right_swap', ref: c.id,
        expected: { color: c.deltas.color.expected }, actual: { color: c.deltas.color.actual } })) };
  }
  return { errorType: null, faulty: [], issues: [] };
}

// canonical hashes must be order-independent: parts sorted by instance id (same rule the
// generator uses). Verified below against the stored reference modelOnlyStateHash.
const canonicalModelOnlyHash = (parts) =>
  inspectFromModel({ format: 'brickbuild', version: '0.2', meta: {}, parts: [...parts].sort((a, b) => a.id.localeCompare(b.id)) }, CAT).stateHash;
const canonicalFullHash = (parts, inventory) =>
  inspectFromModel(
    { format: 'brickbuild', version: '0.2', meta: {}, parts: [...parts].sort((a, b) => a.id.localeCompare(b.id)) },
    CAT,
    { inventory: [...inventory].sort((a, b) => a.token.localeCompare(b.token)) }
  ).stateHash;

// ---------------- repair_local replay ----------------
const repairResults = [];
for (const s of repairPicks) {
  const rec = { sampleId: s.sampleId, family: s.provenance.sourceFamilyId, errorType: s.target?.structureDiagnosis?.errorType ?? null };
  try {
    const ref = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[0].brickPath), 'utf8'));
    const pert = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[1].brickPath), 'utf8'));
    rec.referenceHashFileOk = ref.stateHash === s.stateRefs[0].stateHash;
    rec.perturbedHashFileOk = pert.stateHash === s.stateRefs[1].stateHash;

    const txs = s.verification?.labels?.repairPlan?.transactions || [];
    rec.transactionCount = txs.length;
    rec.storedRepairPassed = s.verification?.repairVerification?.passed === true;

    // start from the PERTURBED state
    let model = JSON.parse(JSON.stringify(pert.model));
    let inventory = JSON.parse(JSON.stringify(pert.inventory));
    const si0 = inspectFromModel(model, CAT, { inventory });
    rec.perturbedHashRecomputedMatches = si0.stateHash === pert.stateHash;
    rec.perturbedCanonicalMatchesStored = canonicalFullHash(model.parts, inventory) === s.stateRefs[1].stateHash;
    rec.referenceCanonicalMatchesStored = canonicalModelOnlyHash(ref.model.parts) === s.stateRefs[0].modelOnlyStateHash;

    const steps = [];
    for (const tx of txs) {
      const si = inspectFromModel(model, CAT, { inventory });
      const ctx = {
        model: JSON.parse(JSON.stringify(model)), cat: CAT, stateHash: si.stateHash,
        inventory: JSON.parse(JSON.stringify(inventory)), taskId: tx.taskId,
        enumerate: (req) => enumerateCandidates(si.state, req, CAT, {})
      };
      const res = applyActions(ctx, tx, {});
      const after = res.apply?.stateHashAfter ?? null;
      steps.push({ taskId: tx.taskId, passed: res.passed, diagCode: res.diagnostics?.[0]?.code ?? null,
        stateHashIn: si.stateHash, stateHashAfter: after, expectIn: tx.stateHash, hashInMatches: si.stateHash === tx.stateHash });
      if (!res.passed || !after) break;
      model = res._workingModel;
      inventory = res._inventory;
    }
    rec.steps = steps;
    rec.allStepsPassed = steps.length === txs.length && steps.every((x) => x.passed && x.hashInMatches);

    // compare canonical (order-independent) hashes: this is the generator's own criterion
    rec.finalModelOnlyHash = canonicalModelOnlyHash(model.parts);
    rec.referenceModelOnlyHash = s.stateRefs[0].modelOnlyStateHash;
    rec.restoredModelOnly = rec.finalModelOnlyHash === rec.referenceModelOnlyHash;
    rec.finalFullHash = canonicalFullHash(model.parts, inventory);
    rec.referenceFullHash = s.stateRefs[0].stateHash;
    rec.restoredFullHash = rec.finalFullHash === rec.referenceFullHash;
    rec.ok = rec.allStepsPassed && rec.restoredModelOnly;
  } catch (e) {
    rec.ok = false;
    rec.error = String(e.message).slice(0, 300);
  }
  repairResults.push(rec);
}

// ---------------- understand_structure recompute ----------------
const structResults = [];
for (const s of structPicks) {
  const rec = { sampleId: s.sampleId, family: s.provenance.sourceFamilyId };
  try {
    const ref = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[0].brickPath), 'utf8'));
    const pert = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[1].brickPath), 'utf8'));
    const d = diffStructures(ref.model.parts, pert.model.parts);
    const cls = classify(d);
    const stored = s.target?.structureDiagnosis || {};
    const storedIssues = stored.issues || [];
    rec.myDiff = { removed: d.removed.length, added: d.added.length, changed: d.changed.length };
    rec.myErrorType = cls.errorType;
    rec.storedErrorType = stored.errorType;
    rec.errorTypeMatches = cls.errorType === stored.errorType;
    rec.myIssueCount = cls.issues.length;
    rec.storedIssueCount = storedIssues.length;
    rec.issueCountMatches = cls.issues.length === storedIssues.length;
    // compare issue payloads structurally (ref id via labels.partRefMap; expected/actual payloads)
    const refMap = s.verification?.labels?.partRefMap || {};
    const revRef = Object.fromEntries(Object.entries(refMap).map(([k, v]) => [v, k]));
    const norm = (i) => JSON.stringify({
      t: i.issueType,
      ref: i.partRef ?? i.ref ?? null,
      exp: i.expected ?? null,
      act: i.actual ?? null
    });
    const mineNorm = cls.issues.map((i) => ({ ...i, exp: i.expected ?? null, act: i.actual ?? null }));
    rec.myIssues = mineNorm.map((i) => ({ issueType: i.issueType, ref: i.ref, expected: i.expected, actual: i.actual ?? null }));
    rec.storedIssues = storedIssues;
    rec.issuesPayloadMatch = storedIssues.every((si, idx) => {
      const mi = mineNorm[idx];
      if (!mi) return false;
      if (si.issueType !== mi.issueType) return false;
      const storedRef = si.partRef ?? null;
      const expectRef = mi.ref ? (refMap[mi.ref] ?? mi.ref) : null;
      if (storedRef && expectRef && storedRef !== expectRef) return false;
      return JSON.stringify(si.expected ?? null) === JSON.stringify(mi.exp ?? null);
    });
    rec.storedHasStructuralError = stored.hasStructuralError;
    rec.ok = rec.errorTypeMatches && rec.issueCountMatches && rec.issuesPayloadMatch;
  } catch (e) {
    rec.ok = false;
    rec.error = String(e.message).slice(0, 300);
  }
  structResults.push(rec);
}

// ---------------- anonymity scan ----------------
const anon = [];
for (const s of [...repairPicks.slice(0, 5), ...structPicks.slice(0, 5)]) {
  const pub = { ...s };
  delete pub.verification;                 // labels / ground-truth zone may hold real ids by design
  const pubJson = JSON.stringify(pub);
  // real ids: pNNN instance ids, tok-fam-*, cand-<hex12> engine ids
  const realInstance = (pubJson.match(/\b(p\d{3})\b/g) || []);
  const realTokens = (pubJson.match(/tok-fam-[a-z0-9-]+/g) || []);
  const realCands = (pubJson.match(/cand-[0-9a-f]{12}/g) || []);
  anon.push({
    sampleId: s.sampleId,
    realInstanceIdHits: [...new Set(realInstance)],
    realTokenHits: [...new Set(realTokens)],
    realCandidateIdHits: [...new Set(realCands)],
    publicCandidateIdsMatchAnonPattern: (s.candidates?.items || []).every((c) => /^cand_[0-9a-f]{4}$/.test(c.candidateId)),
    clean: realInstance.length === 0 && realTokens.length === 0 && realCands.length === 0
  });
}

const out = {
  probe: 'perturbation-independent-20261026',
  pools: { repair_local: pools.repair_local.length, understand_structure: pools.understand_structure.length },
  repairLocal: {
    checked: repairResults.length, passed: repairResults.filter((r) => r.ok).length,
    failed: repairResults.filter((r) => !r.ok).length,
    failures: repairResults.filter((r) => !r.ok), samples: repairResults
  },
  understandStructure: {
    checked: structResults.length, passed: structResults.filter((r) => r.ok).length,
    failed: structResults.filter((r) => !r.ok).length,
    failures: structResults.filter((r) => !r.ok), samples: structResults
  },
  anonymity: {
    checked: anon.length, clean: anon.filter((a) => a.clean).length,
    dirty: anon.filter((a) => !a.clean), samples: anon
  }
};
out.summary = {
  repairAllPass: out.repairLocal.failed === 0,
  structureAllMatch: out.understandStructure.failed === 0,
  anonymityClean: out.anonymity.clean === out.anonymity.checked
};
console.log(JSON.stringify(out, null, 2));
