/**
 * C-milestone-1-indep-splits-probe-20261026.mjs — independent reviewer probe (read-only, CPU only).
 * Recomputes sha256 of every split file listed in split-manifest.json's freeze.splitFiles,
 * checks .frozen presence, checks no sampleId appears in two splits, and checks held-out families
 * are absent from train.
 * Run: node docs/prd-v2/reviews/C-milestone-1-indep-splits-probe-20261026.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const DIR = 'out/prd-v2/run-20261026-c/C/data/splits';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, DIR, 'split-manifest.json'), 'utf8'));
const fb = manifest.freeze || {};
const out = { probe: 'splits-independent-20261026', manifestFrozen: fb.frozen === true, frozenAt: fb.frozenAt };

// 1) hash every listed split file
const fileChecks = [];
for (const [name, rec] of Object.entries(fb.splitFiles || {})) {
  const p = path.join(ROOT, rec.path);
  const exists = fs.existsSync(p);
  const disk = exists ? sha(fs.readFileSync(p)) : null;
  fileChecks.push({ name, path: rec.path, exists, declared: rec.sha256, disk, match: disk === rec.sha256, declaredCount: rec.sampleCount });
}
const assignRec = fb.assignmentFile;
if (assignRec) {
  const p = path.join(ROOT, assignRec.path);
  const disk = fs.existsSync(p) ? sha(fs.readFileSync(p)) : null;
  fileChecks.push({ name: 'assignment', path: assignRec.path, exists: fs.existsSync(p), declared: assignRec.sha256, disk, match: disk === assignRec.sha256 });
}
out.fileHashChecks = { checked: fileChecks.length, matched: fileChecks.filter((f) => f.match).length, detail: fileChecks };

// 2) .frozen sentinel
const frozenPath = path.join(ROOT, DIR, '.frozen');
out.dotFrozen = {
  present: fs.existsSync(frozenPath),
  content: fs.existsSync(frozenPath) ? fs.readFileSync(frozenPath, 'utf8').slice(0, 800) : null
};

// 3) sampleId cross-split overlap + declared count vs actual
const splits = {};
for (const name of ['train', 'validation', 'holdout_test', 'dev']) {
  const p = path.join(ROOT, DIR, `${name}.json`);
  splits[name] = JSON.parse(fs.readFileSync(p, 'utf8'));
}
const idSets = {};
for (const [name, s] of Object.entries(splits)) {
  idSets[name] = new Set(s.samples.map((x) => x.sampleId));
}
const overlaps = [];
const names = Object.keys(idSets);
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = idSets[names[i]], b = idSets[names[j]];
    const common = [...a].filter((id) => b.has(id));
    if (common.length) overlaps.push({ a: names[i], b: names[j], count: common.length, examples: common.slice(0, 5) });
  }
}
out.countChecks = Object.entries(splits).map(([name, s]) => ({
  name, arrayLen: s.samples.length, declaredCount: s.sampleCount,
  matches: s.samples.length === s.sampleCount,
  manifestCount: fb.splitFiles?.[name]?.sampleCount ?? null,
  matchesManifest: s.samples.length === fb.splitFiles?.[name]?.sampleCount
}));
out.overlaps = { pairCount: overlaps.length, detail: overlaps };

// 4) held-out families absent from train
const holdoutFamilies = [
  ...(manifest.holdoutFamilyChoice?.trajectory || []).map((h) => h.family),
  ...(manifest.holdoutFamilyChoice?.perturbation || []).map((h) => h.family)
];
const trainFamilyIds = [...new Set(splits.train.samples.map((x) => x.familyId))];
const holdoutFamilyIds = [...new Set(splits.holdout_test.samples.map((x) => x.familyId))];
const leaked = holdoutFamilies.filter((f) => trainFamilyIds.includes(f));
out.holdoutIsolation = {
  holdoutFamilies,
  holdoutFamilyIdsInHoldout: holdoutFamilyIds,
  trainFamilyIds,
  leakedIntoTrain: leaked,
  isolated: leaked.length === 0
};

// 5) dataset/task composition of holdout vs train (60239 / manual dev must not be train)
const trainDatasets = [...new Set(splits.train.samples.map((x) => x.dataset))];
out.devExclusion = {
  trainDatasets,
  trainHasManual: trainDatasets.includes('manual'),
  devCount: splits.dev.samples.length,
  devSampleIds: splits.dev.samples.map((x) => x.sampleId).slice(0, 40)
};

out.summary = {
  allFileHashesMatch: out.fileHashChecks.matched === out.fileHashChecks.checked,
  frozenSentinelPresent: out.dotFrozen.present,
  noCrossSplitOverlap: out.overlaps.pairCount === 0,
  countsConsistent: out.countChecks.every((c) => c.matches && (c.matchesManifest || c.matchesManifest === null)),
  heldOutFamiliesIsolated: out.holdoutIsolation.isolated
};
console.log(JSON.stringify(out, null, 2));
