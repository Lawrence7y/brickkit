import fs from 'node:fs';
import { inspectFromModel } from '../src/core/actions-v1/state.js';
const rd = (f) => JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url),'utf8'));
const ext = rd('catalog/parts-ldraw.json').parts;
const catNow = { parts: { ...ext, ...rd('catalog/parts.json').parts }, colors: rd('catalog/colors.json').colors };
const oldParts = rd('out/parts-base.json').parts;
const catOld = { parts: { ...ext, ...oldParts }, colors: rd('catalog/colors.json').colors };
const model = rd('out/prd-v2/run-20261026-c/C/integration/60239/60239.fixed.brick.json');
const byId = new Map(model.parts.map(p=>[p.id,p]));
function pairs(cat){
  const si = inspectFromModel(model, cat, {});
  const m = new Map();
  for (const c of si.state.connections) { if(!c.aConnectorId) continue; const k=[c.aNodeId,c.bNodeId].sort().join('|'); m.set(k,(m.get(k)||0)+1); }
  return m;
}
const P=pairs(catNow), O=pairs(catOld);
console.log('now',P.size,'old',O.size);
for(const k of O.keys()) if(!P.has(k)) { const [a,b]=k.split('|'); console.log('LOST',k,byId.get(a)?.part,byId.get(b)?.part, JSON.stringify(byId.get(a)?.at), JSON.stringify(byId.get(b)?.at)); }
for(const k of P.keys()) if(!O.has(k)) { const [a,b]=k.split('|'); console.log('NEW',k,byId.get(a)?.part,byId.get(b)?.part); }
