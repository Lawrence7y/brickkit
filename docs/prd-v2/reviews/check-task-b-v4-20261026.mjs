// Read-only v4 checks. No submission file is modified.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { auditTotalAssembly } from '../../../src/manual-v2/workflow.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = 'out/prd-v2/run-20261026-v4/B';
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sets = Object.fromEntries(['train', 'validation', 'holdout_test'].map((key) => [key, read(`${base}/dataset/${key}.json`)]));
const all = Object.values(sets).flat();
const rawHashes = new Set(), croppedHashes = new Set(), silhouetteHashes = new Set();
let imageCount = 0, imageExists = 0, shaMatches = 0;
for (const sample of all) {
  for (const image of sample.images) {
    imageCount++;
    const full = path.resolve(root, image.imagePath);
    if (fs.existsSync(full)) { imageExists++; if (hash(fs.readFileSync(full)) === image.imageSha256) shaMatches++; }
  }
  const image = path.resolve(root, sample.images[1].imagePath);
  rawHashes.add(hash(fs.readFileSync(image)));
  const { data, info } = await sharp(image).extract({ left: 0, top: 24, width: 128, height: 104 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  croppedHashes.add(hash(data));
  const mask = Buffer.alloc(info.width * info.height);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const offset = pixel * info.channels;
    mask[pixel] = (data[offset] === 236 && data[offset + 1] === 239 && data[offset + 2] === 243) ? 0 : 1;
  }
  silhouetteHashes.add(hash(mask));
}
// Learn tiny lookup tables on TRAIN only; never use test labels for prediction.
const rotationToIndex = new Map(), connectorToError = new Map();
let conflicts = 0;
for (const sample of sets.train) {
  const candidates = sample.candidates.items;
  if (['select_action', 'repair_local'].includes(sample.taskType)) {
    const key = candidates[0].orientationId;
    const label = candidates.findIndex((candidate) => candidate.candidateId === sample.target.primaryAction.selectedCandidateId);
    if (rotationToIndex.has(key) && rotationToIndex.get(key) !== label) conflicts++;
    rotationToIndex.set(key, label);
  }
  if (sample.taskType === 'understand_structure') {
    const key = candidates[0].parentConnectorId;
    const label = sample.target.structureDiagnosis.hasStructuralError;
    if (connectorToError.has(key) && connectorToError.get(key) !== label) conflicts++;
    connectorToError.set(key, label);
  }
}
let actionTotal = 0, actionCorrect = 0, structureTotal = 0, structureCorrect = 0;
for (const sample of sets.holdout_test) {
  const candidates = sample.candidates.items;
  if (['select_action', 'repair_local'].includes(sample.taskType)) {
    actionTotal++;
    const predicted = rotationToIndex.get(candidates[0].orientationId);
    const actual = candidates.findIndex((candidate) => candidate.candidateId === sample.target.primaryAction.selectedCandidateId);
    if (predicted === actual) actionCorrect++;
  }
  if (sample.taskType === 'understand_structure') {
    structureTotal++;
    if (connectorToError.get(candidates[0].parentConnectorId) === sample.target.structureDiagnosis.hasStructuralError) structureCorrect++;
  }
}
const plan = read(`${base}/60239.build.plan.json`);
const forgedReceipts = plan.taskPackages.map((task) => ({
  taskId: task.taskId, status: 'completed', revision: 999,
  stateHash: 'a'.repeat(64), signedBy: 'x', consumedTokens: task.inventory.tokens,
}));
const sourceNames = ['tools/brickvlm/gen_dataset.py', 'tools/brickvlm/model_compact.py', 'tools/brickvlm/visual_encoder.py', 'tools/brickvlm/train_r3_pilot.py', 'tools/brickvlm/evaluate_r5.py', 'src/manual-v2/workflow.js', 'src/manual-v2/extractor.js', 'training/brickvlm/train_qwen_qlora.py'];
const submittedReport = read(`${base}/r5-holdout-report.json`);
console.log(JSON.stringify({
  reviewDate: '2026-10-26', scope: base,
  dataset: {
    splitSizes: Object.fromEntries(Object.entries(sets).map(([key, values]) => [key, values.length])),
    imageReferences: imageCount, existingImages: imageExists, matchingSha256: shaMatches,
    uniqueRawStateImages: rawHashes.size, uniqueStateImagesWithoutTop24px: croppedHashes.size,
    uniqueSilhouettesWithoutTop24px: silhouetteHashes.size,
    datasetKinds: [...new Set(all.map((sample) => sample.provenance.sourceKind))],
  },
  trainingOnlyLookupBaseline: {
    inputUsesImages: false, usesOnlyTrainingLabelsToBuildTables: true,
    actionLookupKeys: rotationToIndex.size, structureLookupKeys: connectorToError.size, conflictingTrainLabels: conflicts,
    action: { correct: actionCorrect, total: actionTotal, accuracy: actionCorrect / actionTotal },
    structure: { correct: structureCorrect, total: structureTotal, accuracy: structureCorrect / structureTotal },
  },
  receiptBinding: {
    revision999FakeStateAndSigner: auditTotalAssembly(plan, forgedReceipts),
    declared999ButAllocated91: auditTotalAssembly({ ...plan, totalBOMParts: 999 }, forgedReceipts),
  },
  reportedMetrics: {
    datasetKind: submittedReport.datasetKind,
    action: submittedReport.metrics['ML-04_action_accuracy'],
    understanding: submittedReport.metrics['ML-05_understanding'],
    fullWorkflow: submittedReport.metrics['ML-07_completed_workflows'],
  },
  sourceHashes: sourceNames.map((name) => ({ path: name, sha256: hash(fs.readFileSync(path.join(root, name))) })),
  reportSha256: hash(fs.readFileSync(path.join(root, base, 'r5-holdout-report.json'))),
}, null, 2));
