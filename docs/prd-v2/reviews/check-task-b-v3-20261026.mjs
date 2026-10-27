// Read-only verification of Task B v3; does not train or overwrite submission files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { auditTotalAssembly } from '../../../src/manual-v2/workflow.js';
import { extractManualObservations } from '../../../src/manual-v2/extractor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = 'out/prd-v2/run-20261026-v3/B';
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const sets = Object.fromEntries(['train', 'validation', 'holdout_test'].map((key) => [key, read(`${base}/dataset/${key}.json`)]));
const all = Object.values(sets).flat();
const refs = all.flatMap((sample) => sample.images || []);
const actualHashes = new Map();
let existing = 0, shaMatches = 0;
for (const ref of refs) {
  const full = path.resolve(root, ref.imagePath);
  if (!fs.existsSync(full)) continue;
  existing++;
  const digest = hash(fs.readFileSync(full));
  actualHashes.set(ref.imagePath, digest);
  if (digest === ref.imageSha256) shaMatches++;
}
const trainStateHashes = new Set(sets.train.map((sample) => actualHashes.get(sample.images[1].imagePath)));
const trainFamilyIds = new Set(sets.train.map((sample) => sample.provenance.sourceFamilyId));
const imageCache = new Map();
const positions = [[44, 82], [64, 74], [84, 82], [64, 92]];
let actionCorrect = 0, actionTotal = 0, structureCorrect = 0, structureTotal = 0;
for (const sample of sets.holdout_test) {
  const imagePath = sample.images[1].imagePath;
  const digest = actualHashes.get(imagePath);
  let raster = imageCache.get(digest);
  if (!raster) {
    raster = await sharp(path.resolve(root, imagePath)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    imageCache.set(digest, raster);
  }
  const scores = positions.map(([cx, cy]) => {
    let count = 0;
    for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 6; x <= cx + 6; x++) {
      const offset = (y * raster.info.width + x) * raster.info.channels;
      const [r, g, b] = raster.data.subarray(offset, offset + 3);
      if ((r === 30 && g === 140 && b === 240) || (r === 220 && g === 50 && b === 50)) count++;
    }
    return count;
  });
  const selected = scores.indexOf(Math.max(...scores));
  if (['select_action', 'repair_local'].includes(sample.taskType)) {
    actionTotal++;
    const expected = sample.candidates.items.findIndex((candidate) => candidate.candidateId === sample.target.primaryAction.selectedCandidateId);
    if (selected === expected) actionCorrect++;
  }
  if (sample.taskType === 'understand_structure') {
    structureTotal++;
    let hasRed = false;
    for (let offset = 0; offset < raster.data.length; offset += raster.info.channels) {
      if (raster.data[offset] === 220 && raster.data[offset + 1] === 50 && raster.data[offset + 2] === 50) { hasRed = true; break; }
    }
    if (hasRed === sample.target.structureDiagnosis.hasStructuralError) structureCorrect++;
  }
}
const plan = read(`${base}/60239.build.plan.json`);
const receipts = (mutate = (token) => token, status = 'completed') => plan.taskPackages.map((task) => ({
  taskId: task.taskId, status, revision: -999, stateHash: 'invalid-state-hash',
  consumedTokens: task.inventory.tokens.map(mutate),
}));
let foreignCounter = 0;
const fakeForeign = receipts(() => ({ tokenId: `foreign-${++foreignCounter}`, partId: 'wrong-part' }), 'failed');
const failedEmpty = plan.taskPackages.map((task) => ({ taskId: task.taskId, status: 'failed', consumedTokens: [] }));
const auditSummary = (value) => ({ ...value, errorCount: value.errors.length, errors: value.errors.slice(0, 5) });
const missing = path.join(root, '.task-b-v3-audit-nonexistent.pdf');
if (fs.existsSync(missing)) throw new Error('Missing-source probe target unexpectedly exists.');
const missingResult = await extractManualObservations(missing);
const unrelated = await extractManualObservations(path.join(root, 'assets/instructions-lego'));
const sourceNames = [
  'tools/brickvlm/gen_dataset.py', 'tools/brickvlm/visual_encoder.py',
  'tools/brickvlm/train_r3_pilot.py', 'tools/brickvlm/evaluate_r5.py',
  'tools/brickvlm/model_compact.py', 'src/manual-v2/extractor.js',
  'src/manual-v2/workflow.js', 'training/brickvlm/train_qwen_qlora.py',
];
console.log(JSON.stringify({
  reviewDate: '2026-10-26', scope: base,
  dataset: {
    splitSizes: Object.fromEntries(Object.entries(sets).map(([key, values]) => [key, values.length])),
    imageReferences: refs.length, existingImageReferences: existing, matchingContentHashes: shaMatches,
    familyIdOverlap: [...new Set(sets.holdout_test.map((sample) => sample.provenance.sourceFamilyId))].filter((id) => trainFamilyIds.has(id)),
    uniqueCurrentStateImages: new Set(all.map((sample) => actualHashes.get(sample.images[1].imagePath))).size,
    holdoutStateImagesAlreadySeenInTrain: sets.holdout_test.filter((sample) => trainStateHashes.has(actualHashes.get(sample.images[1].imagePath))).length,
    colorOnlyActionBaseline: { correct: actionCorrect, total: actionTotal, accuracy: actionCorrect / actionTotal },
    colorOnlyStructureBaseline: { correct: structureCorrect, total: structureTotal, accuracy: structureCorrect / structureTotal },
  },
  extraction: {
    missingSource: { ok: missingResult.ok, observations: missingResult.observations.length, sha256: missingResult.sourceDocument.fileSha256 },
    unrelatedExistingDirectory: { setId: unrelated.meta.setId, observations: unrelated.observations.length },
  },
  inventoryAudit: {
    oldFailedEmptyProbe: auditSummary(auditTotalAssembly(plan, failedEmpty)),
    oldFailedForeignProbe: auditSummary(auditTotalAssembly(plan, fakeForeign)),
    wrongPartColorRevisionAndState: auditSummary(auditTotalAssembly(plan, receipts((token) => ({ ...token, partId: 'WRONG', colorId: 999 })))),
    noModelOrSessionEvidence: auditSummary(auditTotalAssembly(plan, receipts())),
    emptyPlanDeclaring91Parts: auditSummary(auditTotalAssembly({ ...plan, taskPackages: [], totalBOMParts: 91 }, [])),
  },
  locks: {
    emptyContentSha256: hash(''),
    actualPlanFileSha256: hash(fs.readFileSync(path.join(root, base, '60239.build.plan.json'))),
    taskLocks: plan.taskPackages.map((task) => ({ taskId: task.taskId, globalPlanRef: task.globalPlanRef, assetLock: task.assetLock })),
    note: 'File SHA comparison is reported directly; no canonical self-reference-excluding plan hash scheme was implemented by this probe.',
  },
  sourceHashes: sourceNames.map((name) => ({ path: name, sha256: hash(fs.readFileSync(path.join(root, name))) })),
}, null, 2));
