// Independent, read-only probes for the Task B submission. No training or report overwrite.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractManualObservations } from '../../../src/manual-v2/extractor.js';
import { generateBuildPlan, auditTotalAssembly } from '../../../src/manual-v2/workflow.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const base = 'out/prd-v2/run-20261026-v2/B';
const sets = Object.fromEntries(['train', 'validation', 'holdout_test'].map((key) => [key, read(`${base}/dataset/${key}.json`)]));
const families = (samples) => new Set(samples.map((s) => s.provenance.sourceFamilyId));
const trainFamilies = families(sets.train);
const samples = Object.values(sets).flat();
const imageRefs = samples.flatMap((s) => s.images || []);
const actionCases = sets.holdout_test.filter((s) => ['select_action', 'repair_local'].includes(s.taskType));
const featureKey = (s) => JSON.stringify(s.candidates.items.map((c) => ({
  part: (parseInt(c.childPartId.slice(0, 3), 10) || 1) % 128,
  connector: (parseInt(c.parentConnectorId.split('_').at(-1), 10) || 0) % 128,
  rotation: (c.orientationId || 0) % 24,
})));
const seenFeatures = new Set(sets.train.map(featureKey));
const missingPdf = path.join(root, '.task-b-audit-nonexistent-source.pdf');
if (fs.existsSync(missingPdf)) throw new Error('Probe source unexpectedly exists; choose a missing filename.');
const observations = await extractManualObservations(missingPdf);
const plan = generateBuildPlan({ observations: [] }, read('examples/60239.bom.json'));
const failedEmpty = plan.taskPackages.map((task) => ({ taskId: task.taskId, status: 'failed', consumedTokens: [] }));
let foreignId = 0;
const failedForeign = plan.taskPackages.map((task) => ({
  taskId: task.taskId,
  status: 'failed',
  consumedTokens: task.inventory.tokens.map(() => ({ tokenId: `unknown-${++foreignId}`, partId: 'wrong-part' })),
}));
const taskSchema = read('docs/prd-v2/implementation-B/contracts/task-package.schema.json');
const savedPlan = read(`${base}/60239.build.plan.json`);
const filesInRun = [];
function listFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full);
    else filesInRun.push(path.relative(root, full).replaceAll('\\', '/'));
  }
}
listFiles(path.join(root, base));
const sourceFiles = [
  'tools/brickvlm/gen_dataset.py', 'tools/brickvlm/evaluate_r5.py',
  'tools/brickvlm/model_compact.py', 'tools/brickvlm/train_r3_pilot.py',
  'src/manual-v2/extractor.js', 'src/manual-v2/workflow.js',
  'training/brickvlm/train_qwen_qlora.py',
];
const checkpoint = `${base}/weights/r3-pilot-best/model.pt`;
const result = {
  reviewDate: '2026-10-26',
  scope: base,
  method: 'Read-only data/code inspection and independent Node probes; no checkpoint deserialization or retraining.',
  dataset: {
    splitSizes: Object.fromEntries(Object.entries(sets).map(([key, value]) => [key, value.length])),
    trainHoldoutFamilyOverlap: [...families(sets.holdout_test)].filter((id) => trainFamilies.has(id)),
    imageReferences: imageRefs.length,
    existingImageReferences: imageRefs.filter((img) => fs.existsSync(path.resolve(root, img.imagePath))).length,
    holdoutActionCases: actionCases.length,
    alwaysFirstCandidateCorrect: actionCases.filter((s) => s.target.primaryAction.selectedCandidateId === s.candidates.items[0].candidateId).length,
    uniqueModelInputPatterns: new Set(samples.map(featureKey)).size,
    holdoutInputsAlreadySeenInTrain: sets.holdout_test.filter((s) => seenFeatures.has(featureKey(s))).length,
  },
  missingSourceProbe: {
    sourceExists: false,
    observationsReturned: observations.observations.length,
    fileSha256: observations.sourceDocument.fileSha256,
    allHighConfidence: observations.observations.every((o) => o.confidence === 'high'),
  },
  generatedAllocation: plan.taskPackages.map((task) => ({ taskId: task.taskId, count: task.inventory.totalCount })),
  savedTaskRequiredFieldCheck: savedPlan.taskPackages.map((task) => ({
    taskId: task.taskId,
    missingRequiredTopLevelFields: taskSchema.required.filter((key) => !(key in task)),
  })),
  assemblyAuditProbes: {
    allFailedEmptyReceipts: auditTotalAssembly(plan, failedEmpty),
    allFailedForeignTokenReceipts: auditTotalAssembly(plan, failedForeign),
  },
  checkpoint: {
    path: checkpoint,
    exists: fs.existsSync(path.join(root, checkpoint)),
    bytes: fs.existsSync(path.join(root, checkpoint)) ? fs.statSync(path.join(root, checkpoint)).size : null,
    independentlyLoaded: false,
    trainingDeviceIndependentlyVerified: false,
  },
  deliverablesFoundInSubmittedRun: filesInRun.filter((name) => /\.(brick\.json|viewer\.html|booklet\.pdf|mpd)$|\/receipts\//.test(name)),
  sourceHashes: sourceFiles.map((name) => ({ path: name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') })),
};
console.log(JSON.stringify(result, null, 2));
