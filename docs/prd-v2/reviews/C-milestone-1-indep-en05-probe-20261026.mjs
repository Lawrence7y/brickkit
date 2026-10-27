/**
 * C-milestone-1-indep-en05-probe-20261026.mjs — independent reviewer probe (read-only, CPU only).
 * EN-05 spot-check: independent of test/engine-c3-en05-connections.test.mjs, pick 3 required
 * connections from 60239.fixed and build my own "shifted position" negatives; each MUST be rejected
 * by the real engine (partsConnected=false). Also re-confirm the positives connect.
 * Run: node docs/prd-v2/reviews/C-milestone-1-indep-en05-probe-20261026.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { partsConnected, validate, partBoxes } from '../../../src/core/core.js';
import { inspectFromModel } from '../../../src/core/actions-v1/state.js';

const ROOT = process.cwd();
const cat = {
  parts: {
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts,
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts
  },
  colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors
};
const model = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'out/prd-v2/run-20261026-c/C/integration/60239/60239.fixed.brick.json'), 'utf8'));
const byId = new Map(model.parts.map((p) => [p.id, p]));
const clone = (p) => JSON.parse(JSON.stringify(p));

// required connections straight from the engine
const si = inspectFromModel(model, cat, {});
const keys = new Map();
for (const c of si.state.connections) {
  if (!c.aConnectorId) continue;
  const k = [c.aNodeId, c.bNodeId].sort().join('|');
  keys.set(k, (keys.get(k) || 0) + 1);
}
const pairKeys = [...keys.keys()].sort();

function pickPair(key) {
  const [aId, bId] = key.split('|');
  const a = byId.get(aId), b = byId.get(bId);
  let child, parent;
  if (a.snap && a.snap.on === bId) { child = a; parent = b; }
  else if (b.snap && b.snap.on === aId) { child = b; parent = a; }
  else { child = aId > bId ? b : a; parent = aId > bId ? a : b; }
  return { key, aId, bId, parent, child };
}

// 3 pairs spread across the sorted list (deterministic)
const idxs = [0, Math.floor(pairKeys.length / 2), pairKeys.length - 1];
const chosen = idxs.map((i) => pickPair(pairKeys[i]));

const out = {
  probe: 'en05-independent-20261026',
  requiredConnectionCount: pairKeys.length,
  spotChecked: [],
  allRejected: null
};

for (const pr of chosen) {
  const cDef = cat.parts[pr.child.part], pDef = cat.parts[pr.parent.part];
  const rec = {
    pair: pr.key,
    parentPart: pr.parent.part,
    childPart: pr.child.part,
    parentAt: pr.parent.at,
    childAt: pr.child.at
  };
  // positive control: as-modelled must connect
  rec.positiveConnected = partsConnected(pr.parent, pDef, clone(pr.child), cDef);

  // EN-05's negative definition is an OFF-GRID (half-stud) displacement: a child that no longer
  // lands on a stud row must be rejected. Whole-stud slides legitimately re-seat on the next stud
  // (documented engine behaviour in test/engine-c3-en05-connections.test.mjs), so they are recorded
  // separately as `legalReseat`, not as negative-fixture failures.
  const wheelAxis = cDef?.wheel?.axis || pDef?.wheel?.axis || null;
  const axisCandidates = wheelAxis === 'x' ? [2, 0] : [0, 2];
  const attempts = [];
  for (const axis of axisCandidates) {
    for (const delta of [0.5, -0.5, 1, -1]) {
      const moved = clone(pr.child);
      moved.at[axis] += delta;
      const connected = partsConnected(pr.parent, pDef, moved, cDef);
      const v = validate({ format: 'brickbuild', version: '0.2', meta: { name: 'en05-indep' }, parts: [clone(pr.parent), moved] }, cat);
      attempts.push({
        axis, delta, offGrid: Math.abs(delta) !== Math.floor(Math.abs(delta)),
        partsConnected: connected,
        validateErrorCodes: v.errors.map((e) => e.code),
        validateOverlapNamesPair: v.errors.some((e) => e.code === 'overlap' && e.parts?.includes(pr.parent.id) && e.parts?.includes(pr.child.id))
      });
    }
  }
  rec.attempts = attempts;
  const offGrid = attempts.filter((a) => a.offGrid);
  const onGrid = attempts.filter((a) => !a.offGrid);
  rec.offGridAttempts = offGrid.length;
  rec.offGridRejected = offGrid.filter((a) => a.partsConnected === false).length;
  rec.offGridAllRejected = offGrid.length > 0 && offGrid.every((a) => a.partsConnected === false);
  rec.legalReseatObserved = onGrid.filter((a) => a.partsConnected === true).length;
  rec.ok = rec.positiveConnected === true && rec.offGridAllRejected === true;
  out.spotChecked.push(rec);
}

out.allRejected = out.spotChecked.every((s) => s.ok === true);
out.summary = {
  checked: out.spotChecked.length,
  positivesConnect: out.spotChecked.filter((s) => s.positiveConnected).length,
  offGridShiftRejectedAll: out.allRejected,
  legalWholeStudReseat: out.spotChecked.reduce((n, s) => n + s.legalReseatObserved, 0)
};
console.log(JSON.stringify(out, null, 2));
