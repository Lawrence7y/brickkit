// Read-only independent replay of all 60 curriculum candidates. Does not call producer's executor/comparator.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBuilder } from '../../../src/core/builder.js';
import { partBoxes, partsConnected, validate } from '../../../src/core/core.js';
import { getOrientation } from '../../../src/core/actions-v1/pose.js';
import { checkAssetLock } from '../../../src/core/assets-v1/lock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = 'out/prd-v2/run-20261026-v4/B/real-assembly-curriculum';
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const cat = { ...read('catalog/parts.json'), colors: read('catalog/colors.json').colors };
const manifest = read(`${base}/curriculum-manifest.json`);
const samples = read(`${base}/curriculum-samples.json`);

// Independent fixture resources copied from the producer's public component recipes, not from target labels/world poses.
// Production template-registry wiring is outside this development-set replay check.
const templates = {
  sub_bumper: [{ part: '3023', color: 0 }, { part: '2412b', color: 4, stud: 0 }],
  sub_roof: [{ part: '3020', color: 15 }, { part: '2431', color: 4, stud: 0 }],
  sub_hinge: [{ part: '48336', color: 0 }, { part: '60478', color: 14, stud: 0 }],
  sub_beacon: [{ part: '4073', color: 4 }, { part: '3062b', color: 1, stud: 0 }],
  sub_wing: [{ part: '3020', color: 0 }, { part: '24299', color: 15, stud: 0 }],
};
const partKey = (part) => JSON.stringify({
  part: part.part, color: part.color,
  boxes: partBoxes(part, cat.parts[part.part]).map((box) => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value * 1e6) / 1e6]))),
});
function signature(model) {
  const nodes = model.parts.map(partKey).sort();
  const edges = [];
  for (let i = 0; i < model.parts.length; i++) for (let j = i + 1; j < model.parts.length; j++) {
    const a = model.parts[i], b = model.parts[j];
    if (partsConnected(a, cat.parts[a.part], b, cat.parts[b.part])) edges.push(JSON.stringify([partKey(a), partKey(b)].sort()));
  }
  return JSON.stringify({ nodes, edges: edges.sort() });
}
function replay(before, sample, candidate) {
  const builder = createBuilder({ catalog: cat, meta: { name: 'independent-R02-replay', front: '+z' } });
  for (const part of before.parts) builder.add(part.part, part.color, { id: part.id, at: part.at, rot: part.rot, up: part.up, snot: part.snot, step: part.step });
  const parentStud = Number(candidate.parentConnectorId.match(/(\d+)$/)?.[1] ?? 0);
  const receptor = Number(candidate.childConnectorId.match(/(\d+)$/)?.[1] ?? 0);
  const orientation = getOrientation(candidate.orientationId);
  const nextStep = Math.max(...before.parts.map((part) => part.step || 1)) + 1;
  if (candidate.op === 'attach_assembly') {
    const members = templates[candidate.subassemblyTemplateId];
    if (!members) throw new Error(`No independent template fixture for ${candidate.subassemblyTemplateId}`);
    const ids = [];
    let anchor;
    for (let i = 0; i < members.length; i++) {
      const member = members[i], id = `independent-component-${i}`;
      const placed = i === 0
        ? builder.add(member.part, member.color, { id, at: [100, 0, 0], step: nextStep })
        : builder.add(member.part, member.color, { id, on: anchor.id, stud: member.stud, receptor: 0, rot: 0, up: '+y', step: nextStep });
      if (i === 0) anchor = placed;
      ids.push(id);
    }
    builder.addAssembly(ids, { on: candidate.parentInstanceId, stud: parentStud, anchor: anchor.id, anchorReceptor: receptor, rot: orientation.rot, step: nextStep + 1, label: candidate.subassemblyTemplateId });
  } else {
    const color = sample.inventory.find((token) => token.partId === candidate.childPartId)?.colorId ?? sample.inventory[0].colorId;
    builder.add(candidate.childPartId, color, { id: 'independent-new-part', on: candidate.parentInstanceId, stud: parentStud, receptor, rot: orientation.rot, up: orientation.up, step: nextStep });
  }
  const model = builder.model(), result = validate(model, cat);
  if (result.errors.length || result.warnings.length) throw new Error(JSON.stringify({ errors: result.errors, warnings: result.warnings }));
  return model;
}
const rows = [];
let stateErrors = 0, stateWarnings = 0, modelHashMatches = 0, imageHashMatches = 0;
for (const entry of manifest.cases) {
  const before = read(path.join(base, entry.state_t.path)), target = read(path.join(base, entry.state_next.path));
  for (const key of ['state_t', 'state_next']) {
    const bytes = fs.readFileSync(path.join(root, base, entry[key].path));
    if (hash(bytes) === entry[key].sha256) modelHashMatches++;
    const result = validate(JSON.parse(bytes), cat); stateErrors += result.errors.length; stateWarnings += result.warnings.length;
  }
  for (const image of Object.values(entry.images)) if (hash(fs.readFileSync(path.join(root, base, image.path))) === image.sha256) imageHashMatches++;
  const sample = samples.find((value) => value.provenance.sourceModelId === entry.caseId), expected = new Set(sample.target.equivalentCandidates);
  for (const candidate of sample.candidates.items) {
    let model = null, error = null;
    try { model = replay(before, sample, candidate); } catch (cause) { error = String(cause.message); }
    const matches = model !== null && signature(model) === signature(target);
    rows.push({ caseId: entry.caseId, candidateId: candidate.candidateId, op: candidate.op, partId: candidate.childPartId,
      executedParts: model?.parts.length ?? null, targetParts: target.parts.length, matchesTarget: matches,
      listedEquivalent: expected.has(candidate.candidateId), labelMatchesReplay: matches === expected.has(candidate.candidateId), error });
  }
}
const plan = read('out/prd-v2/run-20261026-v4/B/60239.build.plan.json'), index = read('catalog/assets-v1/index.json');
const locks = plan.taskPackages.map((task) => {
  const result = checkAssetLock(task, { index, requiredPartIds: [...new Set(task.inventory.tokens.map((token) => token.partId))] });
  return { task: task.taskId, passed: result.ok, errors: result.errors.length, warnings: result.warnings.length, verified: result.verifiedCount };
});
const sourcePaths = ['tools/brickvlm/gen_real_assembly_curriculum.mjs', 'tools/manual-v2/generate_60239_deliverables.mjs', 'docs/prd-v2/implementation-B/contracts/dataset.schema.json', 'src/core/core.js', 'src/core/builder.js'];
console.log(JSON.stringify({
  scope: base, independentMethod: 'Replay public candidate payload using independent fixed component recipe fixtures; compare full part identity/color/boxes and physical connection graph.',
  sourceIntegrity: { modelHashMatches, imageHashMatches, stateErrors, stateWarnings },
  candidateCount: rows.length, consistentLabels: rows.filter((row) => row.labelMatchesReplay).length,
  labelMismatches: rows.filter((row) => !row.labelMatchesReplay), rows, locks,
  productionTemplateRegistryIntegration: 'not_evaluated',
  sourceHashes: sourcePaths.map((file) => ({ path: file, sha256: hash(fs.readFileSync(path.join(root, file))) })),
}, null, 2));
