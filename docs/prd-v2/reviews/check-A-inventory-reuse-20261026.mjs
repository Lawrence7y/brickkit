// Independent two-transaction inventory regression. Does not modify A/B implementation or outputs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFromModel } from '../../../src/core/actions-v1/state.js';
import { enumerateCandidates } from '../../../src/core/actions-v1/candidates.js';
import { applyActions } from '../../../src/core/actions-v1/apply.js';
import { validate } from '../../../src/core/core.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const fixture = read('docs/prd-v2/reviews/A-to-B-full-assembly-fixture-20261026.json');
const cat = { parts: { ...read('catalog/parts-ldraw.json').parts, ...read('catalog/parts.json').parts }, colors: read('catalog/colors.json').colors };
function attach(model, inventory, nodeId) {
  const inspected = inspectFromModel(model, cat, { inventory, mainRootNodeId: model.parts[0].id });
  const candidates = enumerateCandidates(inspected.state, { childModel: fixture.childModel, parentNodeId: model.parts[0].id, maxResults: 5000 }, cat);
  const candidate = candidates.items[0];
  if (!candidate) throw new Error(`No geometric candidate available for ${nodeId}; fixture needs review.`);
  const ctx = {
    model, cat, stateHash: inspected.stateHash, state: inspected.state,
    taskId: 'independent-stock-audit', mainRootNodeId: model.parts[0].id,
    inventory, enumerate: (request) => enumerateCandidates(inspected.state, request, cat),
  };
  return applyActions(ctx, {
    protocolVersion: '1.0.0', taskId: ctx.taskId, stateHash: ctx.stateHash,
    actions: [{
      id: `attach-${nodeId}`, op: 'attach_assembly', target: { partInstanceId: nodeId },
      candidateId: candidate.candidateId, candidateHash: candidate.candidateHash,
      partId: candidate.childPartId, color: fixture.childModel.parts[0].color,
      childModel: fixture.childModel,
    }],
  });
}
const first = attach(structuredClone(fixture.model), structuredClone(fixture.inventory), 'first-group');
if (!first.passed) throw new Error(`Initial valid attachment failed: ${JSON.stringify(first.diagnostics)}`);
const second = attach(first._workingModel, first._inventory, 'second-group');
const firstTokens = first.apply.results[0]?.applied?.inventoryTokens || [];
const secondTokens = second.apply?.results?.[0]?.applied?.inventoryTokens || [];
const validation = second._workingModel ? validate(second._workingModel, cat) : null;
console.log(JSON.stringify({
  firstPassed: first.passed,
  firstTokens,
  inventoryReturnedAfterFirst: first._inventory,
  secondPassed: second.passed,
  secondTokens,
  sameTokensReused: secondTokens.filter((token) => firstTokens.includes(token)),
  initialParts: fixture.model.parts.length,
  afterFirstParts: first._workingModel.parts.length,
  afterSecondParts: second._workingModel?.parts.length ?? null,
  secondDiagnosticCodes: second.diagnostics.map((entry) => entry.code),
  finalStaticValidation: validation ? { errors: validation.errors.length, warnings: validation.warnings.length } : null,
  inventoryInvariantViolated: Boolean(second.passed && secondTokens.some((token) => firstTokens.includes(token))),
}, null, 2));
