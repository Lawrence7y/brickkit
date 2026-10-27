import fs from 'node:fs';
import { partConnectors, partsConnected, footprint, topLayer, partBoxes } from '../src/core/core.js';
const rd = (f) => JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url),'utf8'));
const ext = rd('catalog/parts-ldraw.json').parts;
const nowCat = { parts: { ...ext, ...rd('catalog/parts.json').parts } };
const oldCat = { parts: { ...ext, ...rd('out/parts-base.json').parts } };
const m = rd('examples/mecha.brick.json');
const byId = Object.fromEntries(m.parts.map(p=>[p.id,p]));

function analyze(cat) {
  const edges = [];
  const studs = new Map();
  for (const p of m.parts) {
    const def = cat.parts[p.part];
    if ((!p.up||p.up==='+y') && p.at.every(Number.isInteger) && !p.snot)
      for (const f of footprint(p,def)) if (f.stud) { const k=`${f.x},${f.z},${topLayer(p,def)}`; (studs.get(k)||studs.set(k,[]).get(k)).push(p.id); }
  }
  const grid = [];
  for (const p of m.parts) {
    const def = cat.parts[p.part];
    if ((p.up&&p.up!=='+y') || !p.at.every(Number.isInteger) || p.snot) continue;
    for (const f of footprint(p,def)) for (const id of studs.get(`${f.x},${f.z},${p.at[1]}`)||[]) if (id!==p.id) grid.push([p.id,id,'grid']);
  }
  for (let i=0;i<m.parts.length;i++) for (let j=i+1;j<m.parts.length;j++) {
    const a=m.parts[i], b=m.parts[j];
    let ok=false;
    try { ok = partsConnected(a, cat.parts[a.part], b, cat.parts[b.part]); } catch(e){}
    if (ok) edges.push([a.id,b.id,'conn']);
  }
  const all = new Map();
  for (const [a,b,k] of [...grid,...edges]) { const key=[a,b].sort().join('|'); if(!all.has(key)) all.set(key,{a,b,k}); }
  return all;
}
const G = analyze(oldCat), N = analyze(nowCat);
console.log('OLD edges', G.size, 'NEW edges', N.size);
console.log('--- lost edges (old only) ---');
for (const [k,v] of G) if (!N.has(k)) console.log(k, v.k, byId[v.a].part, byId[v.b].part);
console.log('--- new edges ---');
for (const [k,v] of N) if (!G.has(k)) console.log(k, v.k, byId[v.a].part, byId[v.b].part);
