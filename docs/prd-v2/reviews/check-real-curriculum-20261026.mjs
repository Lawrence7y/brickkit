// Read-only curriculum checks; never regenerate or overwrite submission artifacts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validate, snapPart, partBoxes, partsCollide, partsConnected } from '../../../src/core/core.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = 'out/prd-v2/run-20261026-v4/B/real-assembly-curriculum';
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = read(`${base}/curriculum-manifest.json`);
const samples = read(`${base}/curriculum-samples.json`);
const catalog = { ...read('catalog/parts.json'), colors: read('catalog/colors.json').colors };
let matchingModelHashes = 0, matchingImageHashes = 0;
const imageHashes = new Set(), stateResults = [];
for (const entry of manifest.cases) {
  for (const key of ['state_t', 'state_next']) {
    const bytes = fs.readFileSync(path.join(root, base, entry[key].path));
    if (hash(bytes) === entry[key].sha256) matchingModelHashes++;
    const result = validate(JSON.parse(bytes.toString('utf8')), catalog);
    stateResults.push({ caseId: entry.caseId, state: key, errors: result.errors, warnings: result.warnings });
  }
  for (const image of Object.values(entry.images)) {
    const digest = hash(fs.readFileSync(path.join(root, base, image.path)));
    imageHashes.add(digest);
    if (digest === image.sha256) matchingImageHashes++;
  }
}
const invalidOrientations = samples.flatMap((sample) => sample.candidates.items
  .filter((candidate) => !Number.isInteger(candidate.orientationId) || candidate.orientationId < 0 || candidate.orientationId > 23)
  .map((candidate) => ({ sampleId: sample.sampleId, candidateId: candidate.candidateId, orientationId: candidate.orientationId })));
const candidateIdPredictions = samples.map((sample) => sample.candidates.items.find((candidate) => candidate.candidateId === 'cand_target')?.candidateId);
const equivalentNegativeProbes = [];
for (const caseId of ['case_snot_01', 'case_snot_03', 'case_snot_05']) {
  const entry = manifest.cases.find((value) => value.caseId === caseId);
  const before = read(path.join(base, entry.state_t.path));
  const after = read(path.join(base, entry.state_next.path));
  const existing = new Set(before.parts.map((part) => part.id));
  const reference = after.parts.find((part) => !existing.has(part.id));
  const parent = before.parts.find((part) => part.id === reference.snap?.on);
  const negative = entry.candidates.find((candidate) => candidate.candidateId === 'cand_dist_2')
    ?? entry.candidates.find((candidate) => candidate.executionReceipt?.sameMaterialBoxesAsTarget && candidate.candidateId !== entry.targetAction?.selectedCandidateId);
  if (!negative) continue;
  // Reuse reference parent/receptor because the public candidates omit these binding fields.
  // Producer currently writes degrees in orientationId or 0..23 orthogonal ID.
  const rotVal = (negative.orientationId === 9 || negative.orientationId === 1) ? 90 : (negative.orientationId === 10 || negative.orientationId === 2 ? 180 : (negative.rot ?? 0));
  const placed = snapPart(parent, catalog.parts[parent.part], Number(negative.parentConnectorId.match(/(\d+)$/)[1]),
    { id: 'audit-child', part: negative.childPartId, color: reference.color, rot: rotVal, up: reference.up },
    catalog.parts[negative.childPartId], reference.snap?.receptor ?? 0);
  equivalentNegativeProbes.push({
    caseId, negativeCandidateId: negative.candidateId,
    sameMaterialBoxesAsReference: JSON.stringify(partBoxes(placed, catalog.parts[placed.part])) === JSON.stringify(partBoxes(reference, catalog.parts[reference.part])),
    connected: partsConnected(parent, catalog.parts[parent.part], placed, catalog.parts[placed.part]),
    collides: before.parts.some((part) => partsCollide(placed, catalog.parts[placed.part], partBoxes(placed, catalog.parts[placed.part]), part, catalog.parts[part.part], partBoxes(part, catalog.parts[part.part]))),
  });
}
const datasetSchema = read('docs/prd-v2/implementation-B/contracts/dataset.schema.json');
const sourceFiles = ['tools/brickvlm/gen_real_assembly_curriculum.mjs', 'training/brickvlm/train_qwen_qlora.py', 'test/real-assembly-curriculum.test.mjs', 'src/core/core.js', 'src/core/builder.js', 'catalog/parts.json', 'catalog/colors.json'];
console.log(JSON.stringify({
  reviewDate: '2026-10-26', scope: base, cases: manifest.cases.length,
  integrity: { matchingModelHashes, matchingImageHashes, uniqueImageHashes: imageHashes.size },
  staticValidation: {
    states: stateResults.length,
    statesWithErrors: stateResults.filter((result) => result.errors.length).length,
    statesWithWarnings: stateResults.filter((result) => result.warnings.length).length,
    totalWarnings: stateResults.reduce((sum, result) => sum + result.warnings.length, 0),
    diagnostics: stateResults.filter((result) => result.errors.length || result.warnings.length),
  },
  labelLeakBaseline: {
    rule: 'Choose the candidate whose public candidateId is cand_target. No target labels or images are read for prediction.',
    correct: candidateIdPredictions.filter((prediction, index) => prediction === samples[index].target.primaryAction.selectedCandidateId).length,
    total: samples.length,
  },
  equivalentNegativeProbes,
  contractChecks: {
    invalidOrientationCount: invalidOrientations.length,
    invalidOrientationExamples: invalidOrientations.slice(0, 5),
    missingRequiredTopLevelFields: samples.map((sample) => ({ sampleId: sample.sampleId, fields: (datasetSchema.required || []).filter((key) => !(key in sample)) })),
  },
  qwenSubmittedPreflight: read(`${base}/qwen-adapter/preflight-report.json`),
  sourceHashes: sourceFiles.map((name) => ({ path: name, sha256: hash(fs.readFileSync(path.join(root, name))) })),
}, null, 2));
