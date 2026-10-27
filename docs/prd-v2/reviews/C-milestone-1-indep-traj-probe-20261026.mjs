/**
 * C-milestone-1-indep-traj-probe-20261026.mjs — independent reviewer probe (read-only, CPU only).
 * Replays 25 randomly-picked trajectory samples from stored state_t with the REAL
 * src/core/actions-v1/apply.js applyActions and compares the resulting stateHash to stored state_t+1.
 * Also: verify 10 image sha256 against disk; scan 10 samples' PUBLIC payloads for target leaks.
 * Run: node docs/prd-v2/reviews/C-milestone-1-indep-traj-probe-20261026.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyActions } from '../../../src/core/actions-v1/apply.js';
import { enumerateCandidates } from '../../../src/core/actions-v1/candidates.js';
import { inspectFromModel } from '../../../src/core/actions-v1/state.js';

const ROOT = process.cwd();
const DATA = 'out/prd-v2/run-20261026-c/C/data/trajectory';
const CAT = {
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')),
  colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors
};
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// deterministic xorshift picker, seeded independently of the generator's mulberry32(20261026)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const famDirs = fs.readdirSync(path.join(DATA, 'families')).filter((d) =>
  fs.statSync(path.join(DATA, 'families', d)).isDirectory()
);
const all = [];
for (const fam of famDirs) {
  const p = path.join(DATA, 'families', fam, 'samples.jsonl');
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (line.trim()) all.push(JSON.parse(line));
  }
}

const rand = rng(0x5eedc0de);
const picked = [];
const pool = all.slice();
for (let i = 0; i < 25 && pool.length; i++) {
  picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
}

const replay = [];
for (const s of picked) {
  const rec = { sampleId: s.sampleId, family: s.provenance.sourceFamilyId };
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[0].brickPath), 'utf8'));
    const nx = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[1].brickPath), 'utf8'));
    rec.stateFileHashMatchesStored = st.stateHash === s.stateRefs[0].stateHash;
    rec.nextFileHashMatchesStored = nx.stateHash === s.stateRefs[1].stateHash;

    const si = inspectFromModel(st.model, CAT, { inventory: st.inventory });
    rec.recomputedStateT = si.stateHash;
    rec.recomputedMatchesStoredT = si.stateHash === st.stateHash;

    const ctx = {
      model: JSON.parse(JSON.stringify(st.model)),
      cat: CAT,
      stateHash: st.stateHash,
      inventory: JSON.parse(JSON.stringify(st.inventory)),
      taskId: s.verification.labels.actionRequest.taskId,
      enumerate: (req) => enumerateCandidates(si.state, req, CAT, {})
    };
    const res = applyActions(ctx, s.verification.labels.actionRequest, {});
    rec.passed = res.passed;
    rec.diagCode = res.diagnostics?.[0]?.code ?? null;
    rec.replayStateAfter = res.apply?.stateHashAfter ?? null;
    rec.storedStateAfter = s.verification.labels.actionResponse?.apply?.stateHashAfter ?? null;
    rec.equalsStoredResponse = rec.replayStateAfter === rec.storedStateAfter;
    rec.equalsStateTPlus1 = rec.replayStateAfter === s.stateRefs[1].stateHash;
    rec.ok = rec.passed && rec.equalsStoredResponse && rec.equalsStateTPlus1 && rec.recomputedMatchesStoredT;
  } catch (e) {
    rec.ok = false;
    rec.error = String(e.message).slice(0, 300);
  }
  replay.push(rec);
}

// ---- image sha256 vs disk (10 images across distinct samples)
const imgChecks = [];
let imgIdx = 0;
for (const s of picked) {
  for (const im of s.images) {
    if (imgIdx >= 10) break;
    const p = path.join(ROOT, im.imagePath);
    const disk = fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null;
    imgChecks.push({
      sampleId: s.sampleId, role: im.role,
      declared: im.imageSha256, disk,
      match: disk === im.imageSha256
    });
    imgIdx++;
  }
  if (imgIdx >= 10) break;
}

// ---- public-payload target-leak scan (10 samples)
const LEAK_KEYS = ['isTarget', 'groundTruth', 'correct', 'correctAnswer', 'isCorrect', 'answer'];
function scanLeaks(obj, trail, hits) {
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => scanLeaks(v, `${trail}[${i}]`, hits)); return; }
  for (const [k, v] of Object.entries(obj)) {
    const t = trail ? `${trail}.${k}` : k;
    if (LEAK_KEYS.includes(k)) hits.push(t);
    scanLeaks(v, t, hits);
  }
}
const leakScan = [];
for (const s of picked.slice(0, 10)) {
  // 1) public candidate payload = the options handed to the model (must not leak which is correct)
  const candHits = [];
  scanLeaks(s.candidates, 'candidates', candHits);
  const candJson = JSON.stringify(s.candidates);

  // 2) wider public payload: sample minus verification (labels zone) minus target (the answer key
  //    which the C3 dataset schema makes a required top-level field by design).
  const pub = { ...s };
  delete pub.verification;
  const pubHits = [];
  scanLeaks(pub, '', pubHits);
  const pubJson = JSON.stringify(pub);

  // 3) verification: leak keys are LEGAL only inside a labels/groundTruth section
  const verHits = [];
  scanLeaks(s.verification, 'verification', verHits);
  const illegalVerHits = verHits.filter((t) => !/\.labels(\.|$)|\.groundTruth(\.|$)/.test(t));

  leakScan.push({
    sampleId: s.sampleId,
    candidateLeakKeyHits: candHits,
    candidatePayloadHasIsTarget: /"isTarget"/.test(candJson),
    candidatePayloadHasGroundTruth: /"groundTruth"/.test(candJson),
    publicPayloadLeakHits: pubHits,
    publicPayloadHasIsTarget: /"isTarget"/.test(pubJson),
    verificationIllegalLeakHits: illegalVerHits,
    publicCandidateIdsAnonymized: (s.candidates?.items || []).every((c) => /^cand_[0-9a-f_]{4,}$/.test(c.candidateId)),
    // does the public candidate list reveal the selected one by ordering/flags?
    candidateItemKeys: Object.keys(s.candidates?.items?.[0] || {})
  });
}

const out = {
  probe: 'trajectory-independent-20261026',
  totalSamples: all.length,
  pickedCount: picked.length,
  replay: {
    checked: replay.length,
    passed: replay.filter((r) => r.ok).length,
    failed: replay.filter((r) => !r.ok).length,
    failures: replay.filter((r) => !r.ok),
    samples: replay
  },
  imageSha: {
    checked: imgChecks.length,
    matched: imgChecks.filter((c) => c.match).length,
    failures: imgChecks.filter((c) => !c.match),
    detail: imgChecks
  },
  leakScan: {
    checked: leakScan.length,
    samplesWithTargetFlagsInCandidates: leakScan.filter((l) => l.candidateLeakKeyHits.length > 0 || l.candidatePayloadHasIsTarget).length,
    samplesWithLeakKeysInPublicPayloadExcludingTarget: leakScan.filter((l) => l.publicPayloadLeakHits.length > 0).length,
    verificationIllegalLeakSamples: leakScan.filter((l) => l.verificationIllegalLeakHits.length > 0).length,
    allAnonymized: leakScan.every((l) => l.publicCandidateIdsAnonymized),
    detail: leakScan
  }
};
out.summary = {
  replayAllPass: out.replay.failed === 0,
  imagesAllMatch: out.imageSha.failures.length === 0,
  noTargetLeaks: out.leakScan.samplesWithTargetFlagsInCandidates === 0
    && out.leakScan.samplesWithLeakKeysInPublicPayloadExcludingTarget === 0
    && out.leakScan.verificationIllegalLeakSamples === 0
};
console.log(JSON.stringify(out, null, 2));
